// hitl.sh's implementation, ported to TypeScript (#899 tranche 2d), under the
// ADR 2026-07-26-hitl-gate-primitive Amendment (2026-08-16, #925), which freed the
// implementation language and left the CLI contract — verbs, flags, exit codes,
// record schema, gate-id derivation, directory index and env surface — binding.
//
// This is a PORT, not a redesign (Rule 29 + Constitution Art. 1). Every flag, exit
// code, stdout/stderr line and subprocess argv is the shell script's, preserved
// deliberately, including the ones that read like accidents (see BASH ARTEFACTS
// below). bin/hitl.sh is now an exec shim onto this file, so the two producers —
// src/reconciler/cli.ts (`hitl_open`, `remind`, and the pending/ pause predicate)
// and src/tracker/cli.ts (`hitl_open`) — and the operator's own hand-run are
// unchanged. The behavioural documentation lives in ./usage.ts (what --help prints)
// and in the shell script's git history.
//
// THE EIGHT python3 HEREDOCS, and what each became (Rule 38 — what was measured):
//
//   hitl.sh:48  now_iso            → new Date().toISOString(), seconds precision, Z
//   hitl.sh:53  gate_field         → readGate() + one field, "" for null/missing
//   hitl.sh:68  gate_patch         → readGate() + merge + atomicWrite (invariant 5a)
//   hitl.sh:85  notify_gate options→ Array.join(",")
//   hitl.sh:150 dedupe_key sha256  → crypto.createHash("sha256") (invariant 3; T115
//                                    proves the two agree byte-for-byte)
//   hitl.sh:171 open record         → the literal object below + atomicWrite
//   hitl.sh:221 cmd_list            → readdir + JSON.parse + the same print formats
//   hitl.sh:347 cmd_remind due-list → parseAware() + the same three-branch cadence
//
// WHAT DID NOT MOVE. The registry status write still shells to
// bin/dispatch-registry.py with identical argv, so python3 remains on the gate path
// after this port — by design, exactly as src/tracker/cli.ts:160 and
// src/dispatch/cli.ts:243 already do (one registry writer, no second copy). The
// notify path is still a `telepty inject --submit-force …` subprocess with identical
// argv. This port removes python3 from hitl's OWN logic, and nothing more; the ADR
// amendment says so in as many words and the PR must not overstate it.
//
// TWO ATOMICITY PRIMITIVES, NOT ONE (ADR amendment invariant 5) — they are different
// operations and collapsing them would break the gate:
//   * gate-file WRITE (open, gate_patch) — atomicWrite(), which is the shell's
//     mktemp+mv plus an fsync and a bounded win32 rename retry.
//   * decide CLAIM (approve/reject) — a BARE rename of pending/<id>.json onto a
//     unique decided/.<id>.claim.XXXXXX. It is a mutex, not a write: the first mover
//     takes the record and every loser must get ENOENT and exit non-zero "already
//     decided" (T64). ENOENT is NEVER retried — it is the loser's answer, not a
//     fault. See claimRename().
//
// BASH ARTEFACTS PRESERVED ON PURPOSE (each has a guard line in T113):
//   * `shift 2` under `set -euo pipefail` exits 1 SILENTLY when a flag is the last
//     argument (`hitl.sh open --source` → rc 1, no output). shiftTwo() reproduces it.
//   * `cmd_decide()`'s `shift 2 || true` leaves $@ untouched when it fails, so
//     `hitl.sh approve` with no id reports `approve: unknown argument 'approve'`
//     rather than "<id> is required". decideRest() reproduces it.
//   * DISPATCH_STATE_DIR was read into DISPATCH_DIR at hitl.sh:32 and never used
//     anywhere in the script. The read is dead, so it is not reproduced (Rule 29 —
//     noted, not resurrected); T113 pins that the variable is inert either way.
//
// THE ONE DELIBERATE NARROWING (Rule 38). `--source` was validated with
// `printf '%s' "$source" | grep -Eq '^[A-Za-z0-9._-]+$'`, and grep matches per LINE:
// a source containing a newline whose every line matched was accepted, and became a
// filename with a newline in it. The regex here is whole-string, so that one input
// is now rejected. Strictly narrower — it can only refuse inputs the shell accepted,
// never accept ones it refused — and the refusal is the existing, worded die().
//
// PATH IS DELIBERATELY STILL HARDENED, in the shim rather than here — see its
// header. hitl.sh:25 exported
// PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH" on every invocation,
// and that is observable: it is how `command -v telepty` and dispatch-registry.py
// resolve. Dropping it would have been a behaviour change dressed as a cleanup.
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWrite } from "../session/persistence/atomic-write.js";
import { USAGE } from "./usage.js";

const env = process.env;

// SCRIPT_DIR was `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P` — the repo's (or the
// init workspace's) bin/. The shim exports it so a symlinked entrypoint still locates
// bin/ helpers; the fallback keeps a direct `node dist/src/hitl/cli.js` working.
const SCRIPT_DIR =
  env.AIGENTRY_SHIM_SCRIPT_DIR ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");
const REPO_DIR = path.resolve(SCRIPT_DIR, "..");

// Env surface, preserved verbatim (ADR amendment invariant 8). `${X:-default}` treats
// an EMPTY value as absent, which is what `||` does here.
const HITL_DIR = env.HITL_STATE_DIR || path.join(REPO_DIR, "state/hitl");
const PENDING_DIR = path.join(HITL_DIR, "pending");
const DECIDED_DIR = path.join(HITL_DIR, "decided");
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY || path.join(SCRIPT_DIR, "dispatch-registry.py");
const TELEPTY = env.TELEPTY || "telepty";
const ORCH_SID = env.ORCHESTRATOR_SID || "orchestrator";
// Same clock seam as the reconciler — the reminder cadence is testable.
const NOW_OVERRIDE = env.RECONCILER_NOW || "";
const REMIND_INTERVAL_SECONDS = env.HITL_REMIND_INTERVAL || "86400";

// ── stdio + exits ───────────────────────────────────────────────────────────
function out(s: string): void {
  process.stdout.write(s);
}
function errOut(s: string): void {
  process.stderr.write(s);
}
/** `die() { echo "hitl: $*" >&2; exit 1; }` */
function die(msg: string): never {
  errOut(`hitl: ${msg}\n`);
  process.exit(1);
}
/** `usage() { sed -n '2,23p' "$0"; exit "${1:-0}"; }` — 22 lines, stdout. */
function usage(code = 0): never {
  out(`${USAGE}\n`);
  process.exit(code);
}

// ── small process helpers (the cleanup/tracker ports', unchanged) ───────────
/** bash `$(cmd)`: command substitution strips every trailing newline. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

/** `cmd >/dev/null 2>&1` — status only. 127 for an unrunnable command, as bash. */
function runQuiet(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
  if (r.error) return 127;
  return r.status ?? 1;
}

/** `[ -x <path> ]` for a regular file. */
function executable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `command -v <cmd>`: an absolute/relative path is tested directly, a bare name on PATH. */
function commandExists(cmd: string): boolean {
  if (cmd.includes("/")) return executable(cmd);
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (dir && executable(path.join(dir, cmd))) return true;
  }
  return false;
}

/** `[ -f <path> ]` — a regular file (symlinks followed). */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `shift 2` under `set -e`: it FAILS when fewer than two arguments remain, and a
 * failing simple command ends the script with status 1 and no message. Reproduced
 * rather than "fixed" — `hitl.sh open --source` has always exited 1 silently, and a
 * caller that started getting a usage error instead would be reading a new contract.
 */
function shiftTwo(args: string[], i: number): number {
  if (args.length - i < 2) process.exit(1);
  return i + 2;
}

// ── JSON, python-shaped ─────────────────────────────────────────────────────
/**
 * `json.dump(obj, fp, indent=2, ensure_ascii=False)` + a trailing newline.
 * Byte-identical to JSON.stringify(…, null, 2): with indent set, python's separators
 * default to ("," , ": "), non-ASCII stays raw under ensure_ascii=False, and both
 * emit the same \\uXXXX escapes for control characters. T113 compares the bytes.
 */
function pyJsonDump(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

type Gate = Record<string, unknown>;

/** `json.load(open(path))`, or null when it raises. */
function readGate(file: string): Gate | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Gate;
  } catch {
    return null;
  }
}

/**
 * `gate_field <file> <field>` — the python exited 1 on an unreadable file and bash's
 * `set -e` turned that into a silent exit 1 for the whole command. Same here.
 */
function gateField(file: string, field: string): string {
  const gate = readGate(file);
  if (gate === null) process.exit(1);
  const v = gate[field];
  return v === null || v === undefined ? "" : String(v);
}

/**
 * `gate_patch <file> <key=value>…` — merge-patch in place; an EMPTY value writes
 * null, which is how `note=` and `resume_error=` become JSON nulls. Gate-file write
 * ⇒ atomicWrite (ADR amendment invariant 5a). Gate ids carry no path separator, so
 * the filename is a legal sessionId for it.
 */
async function gatePatch(file: string, patch: Array<[string, string]>): Promise<void> {
  const gate = readGate(file);
  if (gate === null) process.exit(1);
  for (const [key, value] of patch) gate[key] = value === "" ? null : value;
  await atomicWrite(file, Buffer.from(pyJsonDump(gate), "utf8"), { sessionId: path.basename(file) });
}

// ── clock ───────────────────────────────────────────────────────────────────
/**
 * `now_iso` — RECONCILER_NOW verbatim when set, else UTC to the second with a Z.
 * python's isoformat(timespec="seconds") truncates; so does toISOString().
 */
function nowIso(): string {
  if (NOW_OVERRIDE) return NOW_OVERRIDE;
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ── notify ──────────────────────────────────────────────────────────────────
/**
 * `notify_gate <file>` — one line on the existing REPORT channel. No new transport,
 * and the argv is the shell's exactly. Returns false when telepty is missing or the
 * inject fails, which is what leaves notified_at null for `remind` to retry.
 */
function notifyGate(file: string): boolean {
  const id = gateField(file, "id");
  const kind = gateField(file, "kind");
  const question = gateField(file, "question");
  const source = gateField(file, "source");
  const gate = readGate(file);
  const rawOptions = gate === null ? null : gate["options"];
  const options = Array.isArray(rawOptions) ? rawOptions.join(",") : "";

  let msg = `HITL_GATE ${id} | kind=${kind} | ${question}`;
  if (options) msg = `${msg} | options: ${options}`;
  msg = `${msg} | decide: bin/hitl.sh approve ${id}`;
  if (!commandExists(TELEPTY)) return false;
  return runQuiet(TELEPTY, ["inject", "--submit-force", "--from", source, ORCH_SID, msg]) === 0;
}

// ── registry ────────────────────────────────────────────────────────────────
// telepty#60 Stage A: a gate is its OWN axis. Blocking a session on a human says
// nothing about whether its task finished, so the gate never touches outcome and
// never overwrites the lifecycle — it sets gate.state and clears it again, with the
// lifecycle preserved underneath by the registry.
function registryQuiet(args: string[]): number {
  return runQuiet(DISPATCH_REGISTRY_PY, args);
}

/** `registry_lifecycle <sid>` — current lifecycle state ("" when absent). */
function registryLifecycle(sid: string): string {
  const r = spawnSync(DISPATCH_REGISTRY_PY, ["get", "--sid", sid, "--pointer", "lifecycle.state"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.error || (r.status ?? 1) !== 0) return "";
  const value = chomp(r.stdout ?? "");
  return value === "null" ? "" : value;
}

function registryOpenGate(sid: string): void {
  registryQuiet(["set-gate", "--sid", sid, "--state", "awaiting_user", "--now", nowIso()]);
}

function registryCloseGate(sid: string): void {
  registryQuiet(["set-gate", "--sid", sid, "--clear", "--now", nowIso()]);
}

function registrySetLifecycle(sid: string, state: string): void {
  registryQuiet(["set-lifecycle", "--sid", sid, "--state", state, "--now", nowIso()]);
}

function registryClearRedispatch(sid: string): void {
  registryQuiet(["set-lifecycle", "--sid", sid, "--re-dispatch-count", "0", "--now", nowIso()]);
}

// ── open ────────────────────────────────────────────────────────────────────
async function cmdOpen(args: string[]): Promise<never> {
  let source = "";
  let kind = "";
  let subject = "";
  let resume = "none";
  let question = "";
  let options = "";
  let contextRef = "";
  for (let i = 0; i < args.length; ) {
    const flag = args[i] as string;
    switch (flag) {
      case "--source":
        source = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--kind":
        kind = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--subject-sid":
        subject = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--resume":
        resume = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--question":
        question = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--options":
        options = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--context-ref":
        contextRef = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "-h":
      case "--help":
        usage(0);
      // falls through — usage() never returns
      default:
        die(`open: unknown argument '${flag}'`);
    }
  }
  if (!source) die("open: --source is required");
  if (!question) die("open: --question is required");
  if (kind !== "destructive" && kind !== "decision" && kind !== "info") {
    die(`open: --kind must be destructive|decision|info (got '${kind}')`);
  }
  if (resume !== "reinject" && resume !== "registry-clear-redispatch" && resume !== "none") {
    die(`open: --resume must be reinject|registry-clear-redispatch|none (got '${resume}')`);
  }
  // <source> is a filename component; keep it one.
  if (!/^[A-Za-z0-9._-]+$/.test(source)) die("open: --source must match [A-Za-z0-9._-]+");

  // Deterministic id (ADR amendment invariant 3). The seed and the truncation are the
  // contract: a Node hash that disagreed with the bash one by a single byte would
  // orphan every gate already in flight. T115 is the fixture that proves it does not.
  const key = crypto.createHash("sha256").update(`${source}|${kind}|${question}`, "utf8").digest("hex").slice(0, 12);
  const id = `${kind}-${source}-${key}`;
  const file = path.join(PENDING_DIR, `${id}.json`);
  // Idempotent: a level-triggered producer calling open every 60s is a no-op after
  // the first — same seed, same id, same filename. No duplicate, no re-notify.
  // ponytail: a gate already in decided/ re-opens (a second occurrence must reach the
  // human); the previous decided record is then overwritten by the next decision.
  if (isFile(file)) {
    out(`${id}\n`);
    process.exit(0);
  }

  const now = nowIso();
  let prevStatus = "";
  if (subject) prevStatus = registryLifecycle(subject);

  // Record schema exactly as the ADR §File formats — same keys, same order, same
  // types, including notified_at: null as the "notify failed, retry next tick" signal.
  const record = {
    id,
    dedupe_key: key,
    source,
    subject_sid: subject || null,
    kind,
    resume,
    question,
    options: options.split(",").filter((o) => o !== ""),
    context_ref: contextRef || null,
    prev_status: prevStatus || null,
    created_at: now,
    notified_at: null,
    last_reminded_at: null,
    status: "pending",
    decision: null,
    decided_at: null,
  };
  await atomicWrite(file, Buffer.from(pyJsonDump(record), "utf8"), { sessionId: `${id}.json` });

  // File BEFORE notify: a gate never depends on a live transport (Art.17 pull
  // fallback). notified_at=null ⇒ `remind` retries on the next tick.
  if (notifyGate(file)) {
    await gatePatch(file, [
      ["notified_at", now],
      ["last_reminded_at", now],
    ]);
  } else {
    errOut(`hitl: notify failed for ${id} — notified_at=null, will retry on next remind\n`);
  }

  // Blocking = registry gate state. The loops already filter on it.
  if (subject) registryOpenGate(subject);
  out(`${id}\n`);
  process.exit(0);
}

// ── list ────────────────────────────────────────────────────────────────────
/** `%s` of a python value: None prints "None". */
function pyStr(v: unknown): string {
  return v === null || v === undefined ? "None" : String(v);
}

/** `sorted(glob.glob(<dir>/*.json))` — glob never matches a leading dot; readdir does. */
function pendingGlob(): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(PENDING_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .map((n) => path.join(PENDING_DIR, n))
    .sort();
}

function cmdList(args: string[]): never {
  let kind = "";
  let asJson = false;
  for (let i = 0; i < args.length; ) {
    const flag = args[i] as string;
    switch (flag) {
      case "--kind":
        kind = args[i + 1] ?? "";
        i = shiftTwo(args, i);
        break;
      case "--json":
        asJson = true;
        i += 1;
        break;
      case "-h":
      case "--help":
        usage(0);
      // falls through — usage() never returns
      default:
        die(`list: unknown argument '${flag}'`);
    }
  }

  const gates: Gate[] = [];
  const corrupt: string[] = [];
  for (const p of pendingGlob()) {
    const gate = readGate(p);
    if (gate === null) corrupt.push(p);
    else gates.push(gate);
  }
  for (const p of corrupt) errOut(`HITL_GATE_CORRUPT ${p}\n`);
  // python's sort is stable, and so is Array.prototype.sort: ties keep glob order.
  gates.sort((a, b) => {
    const ka = typeof a["created_at"] === "string" ? (a["created_at"] as string) : "";
    const kb = typeof b["created_at"] === "string" ? (b["created_at"] as string) : "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const paused = gates.filter((g) => g["kind"] === "destructive");
  const shown = gates.filter((g) => !kind || g["kind"] === kind);

  if (asJson) {
    out(pyJsonDump(shown));
    process.exit(0);
  }

  for (const gate of paused) {
    out(`HITL_PAUSE gate=${pyStr(gate["id"])} — autonomous actions paused (destructive gate pending)\n`);
  }
  if (shown.length === 0) out("no pending gates\n");
  for (const gate of shown) {
    out(
      `${pyStr(gate["created_at"])}  ${pyStr(gate["id"])}  kind=${pyStr(gate["kind"])}  ` +
        `resume=${pyStr(gate["resume"])}  subject=${gate["subject_sid"] || "-"}  ${pyStr(gate["question"])}\n`,
    );
    const options = gate["options"];
    if (Array.isArray(options) && options.length > 0) out(`    options: ${options.join(",")}\n`);
    if (!gate["notified_at"]) {
      out("    (not notified — orchestrator unreachable at open; `hitl.sh remind` retries)\n");
    }
  }
  process.exit(0);
}

// ── show ────────────────────────────────────────────────────────────────────
function cmdShow(args: string[]): never {
  const id = args[0] ?? "";
  if (!id) die("show: <id> is required");
  for (const file of [path.join(PENDING_DIR, `${id}.json`), path.join(DECIDED_DIR, `${id}.json`)]) {
    if (isFile(file)) {
      // `cat` — the record's bytes, unparsed and unreformatted.
      process.stdout.write(fs.readFileSync(file));
      process.exit(0);
    }
  }
  die(`show: no such gate: ${id}`);
}

// ── decide ──────────────────────────────────────────────────────────────────
const MKTEMP_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** `mktemp <template ending in XXXXXX>` — create-exclusive, mode 0600, unique name. */
function mktempFile(template: string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = crypto.randomBytes(6);
    let suffix = "";
    for (const b of bytes) suffix += MKTEMP_CHARS[b % MKTEMP_CHARS.length];
    const p = template.replace(/XXXXXX$/, suffix);
    try {
      fs.closeSync(fs.openSync(p, "wx", 0o600));
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`mktemp: could not create a unique file from ${template}`);
}

// Codes win32 reports for "someone else is momentarily touching this path" — the same
// set atomic-write.ts retries, and for the same reason (#901, U18).
const WIN32_TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_RENAME_ATTEMPTS = 10;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The decide CLAIM (ADR amendment invariant 5b): `mv pending/<id>.json <claim>`.
 * rename() is atomic, so exactly one decider gets the file and every loser fails
 * ENOENT — that is the whole concurrency story, no lock. ENOENT is NEVER retried: it
 * is the loser's ANSWER, and retrying it would turn "already decided" into a hang.
 * The shell wrote `mv … 2>/dev/null`, so any other failure takes the same branch.
 */
function claimRename(from: string, to: string): boolean {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") return false;
      if (process.platform === "win32" && WIN32_TRANSIENT_CODES.has(code) && attempt < WIN32_RENAME_ATTEMPTS) {
        sleepMs(Math.min(10 * attempt, 100));
        continue;
      }
      return false;
    }
  }
}

/**
 * `cmd_decide()` was `local decision="$1" id="${2:-}"; shift 2 || true`. When fewer
 * than two arguments are present the shift FAILS and `|| true` swallows it, so $@ is
 * left holding the decision word itself — which is why `hitl.sh approve` with no id
 * reports `approve: unknown argument 'approve'`.
 */
function decideRest(decision: string, userArgs: string[]): string[] {
  return userArgs.length >= 1 ? userArgs.slice(1) : [decision];
}

async function cmdDecide(decision: "approve" | "reject", userArgs: string[]): Promise<never> {
  const id = userArgs[0] ?? "";
  const rest = decideRest(decision, userArgs);
  let note = "";
  for (let i = 0; i < rest.length; ) {
    const flag = rest[i] as string;
    switch (flag) {
      case "--note":
        note = rest[i + 1] ?? "";
        i = shiftTwo(rest, i);
        break;
      case "-h":
      case "--help":
        usage(0);
      // falls through — usage() never returns
      default:
        die(`${decision}: unknown argument '${flag}'`);
    }
  }
  if (!id) die(`${decision}: <id> is required`);

  // ponytail: a kill between the two renames strands the record as
  // decided/.<id>.claim.* (invisible to list/show); recover by hand, or add a
  // claim-sweep to `remind` if it ever actually happens.
  const claim = mktempFile(path.join(DECIDED_DIR, `.${id}.claim.XXXXXX`));
  if (!claimRename(path.join(PENDING_DIR, `${id}.json`), claim)) {
    try {
      fs.unlinkSync(claim);
    } catch {
      /* rm -f */
    }
    if (isFile(path.join(DECIDED_DIR, `${id}.json`))) die(`${decision}: gate ${id} already decided`);
    die(`${decision}: no pending gate: ${id}`);
  }

  const now = nowIso();
  const status = decision === "approve" ? "approved" : "rejected";
  const subject = gateField(claim, "subject_sid");
  const resume = gateField(claim, "resume");
  let resumeError = "";

  // Clearing the gate is enough: the lifecycle was never overwritten, so there is no
  // prior status to restore and no window in which a worker that reported
  // out-of-band while gated could be resurrected.
  if (subject) registryCloseGate(subject);

  if (resume === "reinject") {
    const tag = decision === "approve" ? "[APPROVED]" : "[REJECTED]";
    let msg = `${tag} gate ${id}`;
    if (note) msg = `${msg} — ${note}`;
    if (!subject) {
      resumeError = "resume=reinject but gate has no subject_sid";
    } else if (
      !commandExists(TELEPTY) ||
      runQuiet(TELEPTY, ["inject", "--submit-force", "--from", ORCH_SID, subject, msg]) !== 0
    ) {
      // Gated worker died before approval: the gate is cleared above regardless, so
      // the normal sweep reclaims it. Surface the failure via exit code.
      resumeError = `resume inject to ${subject} failed`;
    }
  } else if (resume === "registry-clear-redispatch") {
    if (!subject) {
      resumeError = "resume=registry-clear-redispatch but gate has no subject_sid";
    } else if (decision === "approve") {
      registryClearRedispatch(subject);
    } else {
      registrySetLifecycle(subject, "stuck_error");
    }
  }
  // else: none — manual/info gate

  await gatePatch(claim, [
    ["status", status],
    ["decision", decision],
    ["decided_at", now],
    ["note", note],
    ["resume_error", resumeError],
  ]);
  fs.renameSync(claim, path.join(DECIDED_DIR, `${id}.json`));

  if (resumeError) {
    errOut(`hitl: ${id} ${status} (resume=${resume} FAILED: ${resumeError})\n`);
    process.exit(1);
  }
  out(`hitl: ${id} ${status} (resume=${resume} ok)\n`);
  process.exit(0);
}

// ── remind ──────────────────────────────────────────────────────────────────
/**
 * `datetime.fromisoformat(ts.replace("Z", "+00:00"))`, reduced to what the record
 * format can hold. `aware` matters: python refuses to subtract a naive datetime from
 * an aware one, and cmd_remind's `except` turns that refusal into stale=True. A JS
 * Date would instead have read the naive string as LOCAL time and silently produced a
 * number, so the awareness flag is carried rather than dropped.
 */
interface Instant {
  ms: number;
  aware: boolean;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2}|[+-]\d{2})?$/;

function parseInstant(ts: string): Instant | null {
  const m = ISO_RE.exec(ts.replace("Z", "+00:00"));
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, frac, off] = m;
  let ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0"),
    Math.floor(Number((frac ?? "0").padEnd(6, "0")) / 1000),
  );
  if (Number.isNaN(ms)) return null;
  if (off !== undefined) {
    const sign = off.startsWith("-") ? -1 : 1;
    const body = off.slice(1).replace(":", "");
    const offMinutes = Number(body.slice(0, 2)) * 60 + Number(body.slice(2) || "0");
    ms -= sign * offMinutes * 60_000;
  }
  return { ms, aware: off !== undefined };
}

/** `int(os.environ["INTERVAL"])` — python accepts surrounding whitespace and a sign. */
function pyInt(raw: string): number | null {
  const t = raw.trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : null;
}

async function cmdRemind(): Promise<never> {
  const now = nowIso();
  const nowInstant = parseInstant(now);
  const interval = pyInt(REMIND_INTERVAL_SECONDS);
  if (nowInstant === null || interval === null) {
    // The python heredoc raised here and bash's `set -e` killed the run; same status,
    // with a diagnostic instead of a traceback.
    errOut(`hitl: remind: unusable clock or interval (now='${now}', interval='${REMIND_INTERVAL_SECONDS}')\n`);
    process.exit(1);
  }

  const due: Array<{ path: string; what: "notify" | "remind" }> = [];
  for (const p of pendingGlob()) {
    const gate = readGate(p);
    if (gate === null) {
      errOut(`HITL_GATE_CORRUPT ${p}\n`);
      continue;
    }
    if (!gate["notified_at"]) {
      due.push({ path: p, what: "notify" }); // failed notify — retry now, not in 24h
      continue;
    }
    const last = gate["last_reminded_at"];
    let stale: boolean;
    if (last === null || last === undefined) {
      stale = true;
    } else {
      const lastInstant = typeof last === "string" ? parseInstant(last) : null;
      // A naive timestamp is the python TypeError arm: caught ⇒ stale.
      stale = lastInstant === null || lastInstant.aware !== nowInstant.aware
        ? true
        : (nowInstant.ms - lastInstant.ms) / 1000 >= interval;
    }
    if (stale) due.push({ path: p, what: "remind" });
  }

  for (const item of due) {
    if (notifyGate(item.path)) {
      if (item.what === "notify") {
        await gatePatch(item.path, [
          ["notified_at", now],
          ["last_reminded_at", now],
        ]);
      } else {
        await gatePatch(item.path, [["last_reminded_at", now]]);
      }
    } else {
      errOut(`hitl: remind failed for ${gateField(item.path, "id")}\n`);
    }
  }
  process.exit(0);
}

// ── entrypoint ──────────────────────────────────────────────────────────────
// `mkdir -p "$PENDING_DIR" "$DECIDED_DIR"` ran on EVERY invocation, --help included.
fs.mkdirSync(PENDING_DIR, { recursive: true });
fs.mkdirSync(DECIDED_DIR, { recursive: true });

// The shell's trailing `case "${1:-}" in … esac`. An if-chain rather than a switch
// because `await`ing a Promise<never> is not narrowed to `never`, so every async arm
// would read as a fallthrough to the compiler.
const argv = process.argv.slice(2);
const command = argv[0] ?? "";
if (command === "open") await cmdOpen(argv.slice(1));
else if (command === "list") cmdList(argv.slice(1));
else if (command === "show") cmdShow(argv.slice(1));
else if (command === "approve") await cmdDecide("approve", argv.slice(1));
else if (command === "reject") await cmdDecide("reject", argv.slice(1));
else if (command === "remind") await cmdRemind();
else if (command === "-h" || command === "--help" || command === "help" || command === "") usage(0);
else {
  errOut(`hitl: unknown command '${command}'\n`);
  usage(1);
}
