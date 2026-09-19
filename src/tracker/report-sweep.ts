// report-sweep — the durable PULL side of worker reporting (#904 + #743).
// SPEC: docs/specs/2026-08-16-report-sweep.md.
//
// A worker reports with `telepty inject --ref <file>`: the bytes land in
// ~/.telepty/shared/<sha>.md and the inject may be silently dropped when the
// orchestrator is busy. Measured 2026-08-15 (fl850): report written 22:07,
// noticed 22:48 — 41 minutes. The push side losing an inject is telepty's to fix
// (#617); this file makes the loss RECOVERABLE from the receiving end, which is
// the half the orchestrator owns.
//
// What existed before was `find ~/.telepty/shared -newermt <marker>` with a
// human-chosen marker, and it failed structurally in two ways this module is
// shaped against:
//
//   * a watcher that exits on the FIRST match drops the sibling ref that arrived
//     in the same window, and the re-armed marker then post-dates it forever. So
//     a sweep here retains unselected refs in the window for the next bounded tick;
//   * "did I already read this?" had no answer that survived a restart. So the
//     answer is a file — a cursor with a `seen` ledger keyed by the ref's sha,
//     which is the only stable identity a ref has.
//
// The durability rule is the whole design and it is one sentence: INBOX FIRST,
// CURSOR SECOND. A crash between them permits retry (the shas are still absent
// from `seen`, and unchanged refs use the same paths and bytes). Failed captures
// remain in the retry queue even after the discovery window moves past them.
//
// This module is READ-ONLY with respect to ~/.telepty/shared. Nothing under it is
// moved, modified or deleted — it is the evidence, and a sweep that consumed its
// own evidence would be the same defect wearing a cursor.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWrite } from "../session/persistence/atomic-write.js";
import { withIndexLock } from "../session/persistence/index-lock.js";

/**
 * Clock-skew slack on the scan floor. Refs arriving in the same second as a sweep
 * would otherwise race the cursor; five minutes of overlap makes that race
 * impossible and costs one re-stat of a handful of files. `seen` is what keeps
 * the overlap from re-delivering.
 */
const OVERLAP_MS = 5 * 60 * 1000;
/**
 * Cold start floors at now−24h rather than 0. Measured 2026-08-16: the real
 * shared dir holds 159 refs and 0 from the last day, so a 0 floor would copy 159
 * already-handled reports into the inbox on first run and teach the operator to
 * ignore the inbox this exists to create. A constant, not a knob (Art. 1).
 */
const COLD_START_MS = 24 * 60 * 60 * 1000;
/** Classification reads a head, not a file: a ref can be tens of KB. */
const HEAD_BYTES = 400;
const SESSION_ID = "report-sweep";
/** Track/sha are untrusted path input; `unknown` is the one placeholder. */
const UNKNOWN = "unknown";
const MAX_ATTEMPTS = 128;

interface Retry {
  basename: string;
  observed_mtime_ms: number;
  error_code: string;
  first_seen_at: string;
}

interface Cursor {
  version: 2;
  last_mtime_ms: number;
  seen: Record<string, number>;
  // Queue order is durable: attempted failures move behind unattempted retries.
  retries: Retry[];
}

/**
 * The path-traversal barrier. `sha8` comes from a filename and `track` from JSON,
 * so both are attacker-influenced in the only sense that matters here: whoever can
 * write to the shared dir picks the bytes. Everything outside [A-Za-z0-9._-] is
 * DROPPED rather than escaped — an escape leaves the caller reasoning about
 * encodings, a drop leaves nothing to reason about. `.`/`..` survive that class
 * intact, so they are rejected by name: they are the traversal.
 */
function safeSegment(raw: string, cap: number): string {
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, cap);
  if (!clean || clean === "." || clean === "..") return UNKNOWN;
  return clean;
}

/** Longest ref-id kept verbatim. A telepty content sha is 64; this clears it. */
const REF_ID_CAP = 96;

/**
 * The ref's identity as ONE filename segment. It must be INJECTIVE over source
 * basenames or the inbox loses exactly what it exists to preserve.
 *
 * The spec said `<sha8>`. Measured 2026-08-16 against the real shared dir, that
 * is wrong: 5 of 161 refs are not named for a 64-hex content sha, and four of
 * them are `rel-874-answer-v101-tag.md`, `rel-874-npm-auth-three-paths.md`,
 * `rel-874-publish-auth-report.md`, `rel-874-release-workflow-report.md` — all
 * four truncate to the sha8 `rel-874-`, one inbox path, three reports silently
 * overwritten. 161 refs produced 160 files. So the WHOLE sanitised basename is
 * the segment, and a digest of the original is appended only when sanitisation or
 * the cap actually dropped information (never, for a real sha, so the common
 * filename stays exactly the sha it names).
 */
function refId(rawName: string): string {
  const clean = rawName.replace(/[^A-Za-z0-9._-]/g, "");
  if (clean === rawName && clean.length && clean.length <= REF_ID_CAP && clean !== "." && clean !== "..") {
    return clean;
  }
  const digest = createHash("sha256").update(rawName, "utf8").digest("hex").slice(0, 8);
  return `${safeSegment(clean.slice(0, REF_ID_CAP - 9), REF_ID_CAP - 9)}-${digest}`;
}

/** Only absence is a cold start; invalid state must never erase obligations. */
function readCursor(file: string, nowMs: number): Cursor {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return { version: 2, last_mtime_ms: nowMs - COLD_START_MS, seen: Object.create(null), retries: [] };
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
  const rec: unknown = JSON.parse(text);
  if (!isRecord(rec) || !isTime(rec.last_mtime_ms) || !isRecord(rec.seen)) {
    throw new Error("invalid cursor last_mtime_ms/seen; cursor preserved");
  }
  if (rec.version !== undefined && rec.version !== 1 && rec.version !== 2) {
    throw new Error(`unsupported cursor version ${JSON.stringify(rec.version)}; cursor preserved`);
  }
  const seen: Record<string, number> = Object.create(null);
  for (const [key, value] of Object.entries(rec.seen)) {
    if (!isTime(value)) throw new Error("invalid cursor seen entry; cursor preserved");
    seen[key] = value;
  }
  const retries: Retry[] = [];
  if (rec.version === 2) {
    if (!Array.isArray(rec.retries)) throw new Error("invalid cursor retries; cursor preserved");
    const basenames = new Set<string>();
    for (const entry of rec.retries) {
      if (!isRecord(entry) || typeof entry.basename !== "string" ||
          !entry.basename.endsWith(".md") || entry.basename.includes("\0") ||
          path.basename(entry.basename) !== entry.basename ||
          !isTime(entry.observed_mtime_ms) || typeof entry.error_code !== "string" ||
          !entry.error_code || typeof entry.first_seen_at !== "string" ||
          !Number.isFinite(Date.parse(entry.first_seen_at)) || basenames.has(entry.basename) ||
          seen[refId(entry.basename.slice(0, -3))] !== undefined) {
        throw new Error("invalid or conflicting cursor retry entry; cursor preserved");
      }
      basenames.add(entry.basename);
      retries.push({ basename: entry.basename, observed_mtime_ms: entry.observed_mtime_ms,
        error_code: entry.error_code, first_seen_at: entry.first_seen_at });
    }
  } else if (rec.retries !== undefined) {
    throw new Error("legacy cursor has unexpected retries; cursor preserved");
  }
  return { version: 2, last_mtime_ms: rec.last_mtime_ms, seen, retries };
}

/**
 * Tracks come from the registry, never from a hard-coded list: `sw904` is known
 * only because a dispatch named `sw904-sw904-report-sweep` is on file.
 *
 * A full sid is always admitted — it is specific enough that finding it in a ref
 * means something. A sid's PREFIX is admitted only if it also carries a digit,
 * and that rule is measured rather than aesthetic. Without it, 2026-08-16 against
 * the real shared dir: 48 of 161 refs came back on track `aigentry` and 13 on
 * `architect`, because sids like `aigentry-…` and `architect-…` are on file and
 * those words appear in every ref's repo paths and prose. Longest-first then made
 * the junk token win, so this task's own dispatch — `# DISPATCH — sw904` — was
 * filed under `aigentry`. Every real track id in this ecosystem carries a digit
 * (sw904, cl899, wh899, lg923, rp920, sp885, ci1, t880, at1, bd1); every junk
 * prefix observed carries none (aigentry, architect, fix, coder, acc, disp, rel,
 * pub, diag, eco, arch, submit, telepty). The digit is the discriminator.
 *
 * Longest-first so a full sid beats its own prefix.
 */
export function loadRegistryTracks(stateDir: string, registryScript: string): string[] {
  let doc: unknown;
  try {
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? "python" : registryScript,
      windows ? [registryScript, "snapshot"] : ["snapshot"], {
        shell: false,
        env: { ...process.env, DISPATCH_STATE_DIR: stateDir, PYTHONIOENCODING: "utf-8" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      });
    if (result.error || result.status !== 0) return [];
    doc = JSON.parse(result.stdout);
  } catch {
    return []; // no registry = no track vocabulary; refs still classify by header
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return [];
  const envelope = doc as { schema_version?: unknown; generation?: unknown; dispatches?: unknown };
  if (envelope.schema_version !== 2 || !Number.isInteger(envelope.generation) ||
      !Array.isArray(envelope.dispatches)) return [];
  const list = envelope.dispatches;
  const out = new Set<string>();
  for (const d of list) {
    const sid = (d as { assigned?: { sid?: unknown } })?.assigned?.sid;
    if (typeof sid !== "string") continue;
    if (sid.length >= 3) out.add(sid);
    const head = sid.split("-")[0] ?? "";
    if (head.length >= 3 && /\d/.test(head)) out.add(head);
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

const HEADER_RE = /^# (REPORT|HOLD|SPEC)\b/m;
/**
 * The dispatch-ref template's own field (`track: sw904`). The author SAYING which
 * track this is outranks any amount of inference from prose.
 */
const TRACK_FIELD_RE = /^track:[ \t]*([A-Za-z0-9._-]+)/m;
/**
 * The title's first token after the em-dash: `# REPORT — tk899 (#899 …)`,
 * `# DISPATCH — sl909 (#909): …`, `# FOLLOW-UP DISPATCH — sp902: #916`.
 *
 * This exists because the registry is an INCOMPLETE vocabulary and pretending
 * otherwise mislabels live work. Measured 2026-08-16: `tk899` and `sl909` have
 * open worktrees and current reports, and neither sid is in `active.json`, so
 * registry lookup alone filed `# REPORT — tk899` under `unknown` and
 * `# DISPATCH — sl909` under unclassified.
 */
const TITLE_TRACK_RE = /^#[ \t]+[^\n]*?—[ \t]*([A-Za-z0-9._-]+)/m;

/**
 * A track id in this ecosystem always carries a digit (sw904, tk899, sl909,
 * sp902-916, ci1, t880). A title token that does not is prose, not a track —
 * `# Memory harness gap analysis — Sakana "long-horizon agent memory" talk`
 * would otherwise be filed on track `Sakana`. Same discriminator as loadRegistryTracks'
 * prefix rule, for the same reason.
 */
function looksLikeTrack(token: string): boolean {
  return /\d/.test(token);
}

/**
 * Header and track are INDEPENDENT reads. `# REPORT — wh899` yields both; a
 * `# DISPATCH — sw904 (…)` has no report header but is a real ref on a real
 * track, so it classifies as REF rather than being dumped in unclassified.
 *
 * Track resolution is three sources in falling order of authority: what the
 * author declared, what the title states, what the registry knows. The last one
 * still earns its place — a `# SPEC — rank-based decision ledger` names its track
 * only in the body (`- **Task**: lg923 (#923)`), which is a substring match and
 * nothing else.
 */
export function classify(head: string, tracks: string[]): { kind: string; track: string } {
  const m = HEADER_RE.exec(head);
  const declared = TRACK_FIELD_RE.exec(head)?.[1];
  const titled = TITLE_TRACK_RE.exec(head)?.[1];
  const hit =
    declared ??
    (titled && looksLikeTrack(titled) ? titled : undefined) ??
    tracks.find((t) => head.includes(t));
  const track = hit ? safeSegment(hit, 48) : UNKNOWN;
  if (m) return { kind: m[1]!, track };
  if (hit) return { kind: "REF", track };
  return { kind: "?", track: UNKNOWN };
}

interface Candidate {
  basename: string;
  sha: string;
  file: string;
  mtimeMs: number;
  retry?: Retry;
}

export interface SweepDeps {
  stateDir: string;
  sharedDir: string;
  nowMs: number;
  repoDir: string;
  registryScript?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * One sweep. Returns the process exit code: 0 for "swept" (including nothing new,
 * and including a shared dir that does not exist — a box without telepty is not a
 * failure), 3 for failed discovery, inbox/cursor writes, validation or locking.
 * Read failures with committed retry metadata are reported as PENDING.
 */
export async function sweep(deps: SweepDeps): Promise<number> {
  const cursorFile = path.join(deps.stateDir, "report-cursor.json");
  try {
    // The helper stages its lock beside the cursor, so the parent must exist.
    fs.mkdirSync(deps.stateDir, { recursive: true });
    return await withIndexLock(cursorFile, () => sweepLocked(deps, cursorFile));
  } catch (err) {
    deps.stderr(`report-sweep: lock/cursor error; capture unresolved: ${(err as Error).message}`);
    return 3;
  }
}

async function sweepLocked(deps: SweepDeps, cursorFile: string): Promise<number> {
  const { stateDir, sharedDir, nowMs, repoDir, stdout, stderr } = deps;
  const inboxDir = path.join(stateDir, "inbox");
  const unclassifiedDir = path.join(inboxDir, "unclassified");

  const cursor = readCursor(cursorFile, nowMs);

  let result = 0;
  let discoveryIncomplete = false;
  let names: string[] = [];
  try {
    names = fs.readdirSync(sharedDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      stderr(`report-sweep: PENDING discovery ${sharedDir}: ${(err as Error).message}`);
      result = 3;
      discoveryIncomplete = true;
    }
  }

  const floor = cursor.last_mtime_ms - OVERLAP_MS;
  let maxMtime = cursor.last_mtime_ms;
  const fresh: Candidate[] = [];
  const pendingNames = new Set(cursor.retries.map((retry) => retry.basename));
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    if (pendingNames.has(name)) continue; // retried directly, even outside the window
    const file = path.join(sharedDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch (err) {
      // No observed mtime exists yet: keep the discovery floor until re-stat.
      discoveryIncomplete = true;
      stderr(`report-sweep: PENDING stat ${file}: ${(err as Error).message}`);
      result = 3;
      continue;
    }
    if (!st.isFile()) continue;
    const mtimeMs = Math.floor(st.mtimeMs);
    if (mtimeMs > maxMtime) maxMtime = mtimeMs;
    if (mtimeMs < floor) continue; // outside the scan window — bounds the sweep
    const sha = refId(name.slice(0, -3));
    if (cursor.seen[sha] !== undefined) continue; // the ledger — bounds the emit
    fresh.push({ basename: name, sha, file, mtimeMs });
  }

  // Fresh refs are oldest first; retained retries rotate independently below.
  fresh.sort((a, b) => a.mtimeMs - b.mtimeMs || a.sha.localeCompare(b.sha));

  const selected: Candidate[] = [];
  let pendingIndex = 0;
  let freshIndex = 0;
  // Alternate queues; if either empties, the other can use the remaining budget.
  while (selected.length < MAX_ATTEMPTS &&
         (pendingIndex < cursor.retries.length || freshIndex < fresh.length)) {
    if (pendingIndex < cursor.retries.length) {
      const retry = cursor.retries[pendingIndex++]!;
      selected.push({ basename: retry.basename, sha: refId(retry.basename.slice(0, -3)),
        file: path.join(sharedDir, retry.basename), mtimeMs: retry.observed_mtime_ms, retry });
    }
    if (selected.length < MAX_ATTEMPTS && freshIndex < fresh.length) {
      selected.push(fresh[freshIndex++]!);
    }
  }
  // Never pass unselected discovery evidence, including equal-mtime siblings.
  if (freshIndex < fresh.length) {
    maxMtime = Math.max(cursor.last_mtime_ms, Math.min(maxMtime, fresh[freshIndex]!.mtimeMs));
  }
  if (discoveryIncomplete) maxMtime = cursor.last_mtime_ms;
  const retries = cursor.retries.slice(pendingIndex);
  const tracks = selected.length ? loadRegistryTracks(stateDir,
    deps.registryScript || process.env.DISPATCH_REGISTRY_PY || path.join(repoDir, "bin", "dispatch-registry.py")) : [];
  const lines: string[] = [];

  // ── step 1: exact inbox copies; failed attempts become durable obligations ──
  for (const c of selected) {
    let phase = "read";
    try {
      const bytes = fs.readFileSync(c.file);
      phase = "copy";
      const head = bytes.subarray(0, HEAD_BYTES).toString("utf8");
      const { kind, track } = classify(head, tracks);
      // The ref's OWN mtime dates the file, not the sweep's clock: the name then
      // states when the report was written, and a re-emit after midnight cannot
      // mint a second path for the same sha.
      const date = new Date(c.mtimeMs).toISOString().slice(0, 10);
      const dest =
        kind === "?"
          ? path.join(unclassifiedDir, `${date}-${c.sha}.md`)
          : path.join(inboxDir, `${date}-${track}-${c.sha}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await atomicWrite(dest, bytes, { sessionId: SESSION_ID });
      const shown = dest.startsWith(repoDir + path.sep) ? path.relative(repoDir, dest) : dest;
      lines.push(`NEW ${track} ${kind} ${shown}`);
      cursor.seen[c.sha] = c.mtimeMs;
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code || "UNKNOWN";
      retries.push({ basename: c.basename, observed_mtime_ms: c.mtimeMs,
        error_code: errorCode, first_seen_at: c.retry?.first_seen_at ?? new Date(nowMs).toISOString() });
      const description = phase === "read" ? "unreadable ref" : "inbox write failed for";
      stderr(`report-sweep: PENDING ${description} ${c.file}: ${errorCode}: ${(err as Error).message}`);
      if (phase === "copy") result = 3;
    }
  }

  // ── step 2: commit seen, retries and discovery together, after the copies ───
  // Pruned to the overlap window: an entry below it can never be re-scanned, so
  // keeping it would grow this file for the lifetime of the workspace.
  const keepFrom = maxMtime - OVERLAP_MS;
  const seen: Record<string, number> = Object.create(null);
  for (const [sha, m] of Object.entries(cursor.seen)) {
    if (m >= keepFrom) seen[sha] = m;
  }
  try {
    await atomicWrite(
      cursorFile,
      Buffer.from(JSON.stringify({ version: 2, last_mtime_ms: maxMtime, seen, retries }, null, 2) + "\n"),
      { sessionId: SESSION_ID },
    );
  } catch (err) {
    // atomicWrite can fail after rename (directory fsync): do not roll back or
    // assert which cursor reached durable storage. Keep all source/inbox bytes.
    stderr(`report-sweep: cursor write failed; capture/retry commit uncertain, copies retained: ${(err as Error).message}`);
    return 3;
  }
  // NEW is an inbox notification, never a report-acceptance ACK. No success
  // notification is issued for a cursor commit whose durability is unresolved.
  for (const line of lines) stdout(line);
  return result;
}

/** The subcommand entrypoint. `stateDir`/`nowIso` are the tracker CLI's own. */
export async function cmdReportSweep(stateDir: string, repoDir: string, nowIso: string,
  registryScript?: string): Promise<number> {
  const parsed = nowIso ? Date.parse(nowIso) : NaN;
  return sweep({
    stateDir,
    sharedDir: process.env.TELEPTY_SHARED_DIR || path.join(os.homedir(), ".telepty", "shared"),
    nowMs: Number.isFinite(parsed) ? parsed : Date.now(),
    repoDir,
    registryScript: registryScript || process.env.DISPATCH_REGISTRY_PY || path.join(repoDir, "bin", "dispatch-registry.py"),
    stdout: (l) => process.stdout.write(l + "\n"),
    stderr: (l) => process.stderr.write(l + "\n"),
  });
}
