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
//     a sweep here copies EVERY new ref it finds and never stops early;
//   * "did I already read this?" had no answer that survived a restart. So the
//     answer is a file — a cursor with a `seen` ledger keyed by the ref's sha,
//     which is the only stable identity a ref has.
//
// The durability rule is the whole design and it is one sentence: INBOX FIRST,
// CURSOR SECOND. A crash between them re-emits (the shas are still absent from
// `seen`, the same sha-derived paths are rewritten with the same bytes) and can
// never lose. Re-emitting a report costs an operator one duplicate line; losing
// one costs 41 minutes.
//
// This module is READ-ONLY with respect to ~/.telepty/shared. Nothing under it is
// moved, modified or deleted — it is the evidence, and a sweep that consumed its
// own evidence would be the same defect wearing a cursor.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWrite } from "../session/persistence/atomic-write.js";

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

interface Cursor {
  last_mtime_ms: number;
  seen: Record<string, number>;
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

/**
 * A missing OR unparseable cursor is a cold start, never a crash. Refusing to run
 * on a corrupt cursor would lose every report until a human noticed — which is
 * precisely the failure this module exists to end.
 */
function readCursor(file: string, nowMs: number): Cursor {
  try {
    const doc: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const rec = doc as Record<string, unknown>;
    const last = Number(rec?.last_mtime_ms);
    if (!Number.isFinite(last)) throw new Error("last_mtime_ms is not a number");
    const seen: Record<string, number> = {};
    const rawSeen = rec?.seen;
    if (rawSeen && typeof rawSeen === "object" && !Array.isArray(rawSeen)) {
      for (const [k, v] of Object.entries(rawSeen as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n)) seen[k] = n;
      }
    }
    return { last_mtime_ms: last, seen };
  } catch {
    return { last_mtime_ms: nowMs - COLD_START_MS, seen: {} };
  }
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
function loadTracks(activeJson: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(activeJson, "utf8"));
  } catch {
    return []; // no registry = no track vocabulary; refs still classify by header
  }
  const list = (doc as { dispatches?: unknown })?.dispatches;
  const out = new Set<string>();
  for (const d of Array.isArray(list) ? list : []) {
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
 * would otherwise be filed on track `Sakana`. Same discriminator as loadTracks'
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
  sha: string;
  file: string;
  mtimeMs: number;
}

export interface SweepDeps {
  stateDir: string;
  sharedDir: string;
  nowMs: number;
  repoDir: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * One sweep. Returns the process exit code: 0 for "swept" (including nothing new,
 * and including a shared dir that does not exist — a box without telepty is not a
 * failure), 3 for a failed inbox or cursor write.
 */
export async function sweep(deps: SweepDeps): Promise<number> {
  const { stateDir, sharedDir, nowMs, repoDir, stdout, stderr } = deps;
  const cursorFile = path.join(stateDir, "report-cursor.json");
  const inboxDir = path.join(stateDir, "inbox");
  const unclassifiedDir = path.join(inboxDir, "unclassified");

  const cursor = readCursor(cursorFile, nowMs);

  let names: string[];
  try {
    names = fs.readdirSync(sharedDir);
  } catch {
    return 0;
  }

  const floor = cursor.last_mtime_ms - OVERLAP_MS;
  let maxMtime = cursor.last_mtime_ms;
  const fresh: Candidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(sharedDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue; // vanished between readdir and stat; the next sweep will see it
    }
    if (!st.isFile()) continue;
    const mtimeMs = Math.floor(st.mtimeMs);
    if (mtimeMs > maxMtime) maxMtime = mtimeMs;
    if (mtimeMs < floor) continue; // outside the scan window — bounds the sweep
    const sha = refId(name.slice(0, -3));
    if (cursor.seen[sha] !== undefined) continue; // the ledger — bounds the emit
    fresh.push({ sha, file, mtimeMs });
  }

  // Oldest first, so the printed order is the order the reports were written.
  fresh.sort((a, b) => a.mtimeMs - b.mtimeMs || a.sha.localeCompare(b.sha));

  const tracks = fresh.length ? loadTracks(path.join(stateDir, "active.json")) : [];
  const lines: string[] = [];

  // ── step 1: every inbox copy ───────────────────────────────────────────────
  try {
    if (fresh.length) fs.mkdirSync(unclassifiedDir, { recursive: true });
    for (const c of fresh) {
      let bytes: Buffer | null = null;
      try {
        bytes = fs.readFileSync(c.file);
      } catch (err) {
        // One unreadable ref must not stop the other nine from being delivered.
        // It is still filed — that a report arrived is itself the fact worth not
        // losing, even when the bytes are gone.
        stderr(`report-sweep: unreadable ref ${c.file}: ${(err as Error).message}`);
      }
      const head = bytes ? bytes.subarray(0, HEAD_BYTES).toString("utf8") : "";
      const { kind, track } = classify(head, tracks);
      // The ref's OWN mtime dates the file, not the sweep's clock: the name then
      // states when the report was written, and a re-emit after midnight cannot
      // mint a second path for the same sha.
      const date = new Date(c.mtimeMs).toISOString().slice(0, 10);
      const dest =
        kind === "?"
          ? path.join(unclassifiedDir, `${date}-${c.sha}.md`)
          : path.join(inboxDir, `${date}-${track}-${c.sha}.md`);
      await atomicWrite(dest, bytes ?? Buffer.alloc(0), { sessionId: SESSION_ID });
      const shown = dest.startsWith(repoDir + path.sep) ? path.relative(repoDir, dest) : dest;
      lines.push(`NEW ${track} ${kind} ${shown}`);
      cursor.seen[c.sha] = c.mtimeMs;
    }
  } catch (err) {
    stderr(`report-sweep: inbox write failed: ${(err as Error).message}`);
    return 3; // cursor deliberately NOT advanced — the next sweep re-emits
  }

  // ── step 2: announce ───────────────────────────────────────────────────────
  for (const line of lines) stdout(line);

  // ── step 3: the cursor, last ───────────────────────────────────────────────
  // Pruned to the overlap window: an entry below it can never be re-scanned, so
  // keeping it would grow this file for the lifetime of the workspace.
  const keepFrom = maxMtime - OVERLAP_MS;
  const seen: Record<string, number> = {};
  for (const [sha, m] of Object.entries(cursor.seen)) {
    if (m >= keepFrom) seen[sha] = m;
  }
  try {
    await atomicWrite(
      cursorFile,
      Buffer.from(JSON.stringify({ last_mtime_ms: maxMtime, seen }, null, 2) + "\n"),
      { sessionId: SESSION_ID },
    );
  } catch (err) {
    stderr(`report-sweep: cursor write failed: ${(err as Error).message}`);
    return 3;
  }
  return 0;
}

/** The subcommand entrypoint. `stateDir`/`nowIso` are the tracker CLI's own. */
export async function cmdReportSweep(stateDir: string, repoDir: string, nowIso: string): Promise<number> {
  const parsed = nowIso ? Date.parse(nowIso) : NaN;
  return sweep({
    stateDir,
    sharedDir: process.env.TELEPTY_SHARED_DIR || path.join(os.homedir(), ".telepty", "shared"),
    nowMs: Number.isFinite(parsed) ? parsed : Date.now(),
    repoDir,
    stdout: (l) => process.stdout.write(l + "\n"),
    stderr: (l) => process.stderr.write(l + "\n"),
  });
}
