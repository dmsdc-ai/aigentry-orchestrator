// #1136 (linked #1170) turn-end status hook for a CONFINED claude worker.
//
// prepareWorkerSandbox copies the compiled file to `<attempt>/report-hook/turn-hook.mjs`
// and seals its path + sha256 in the manifest; the worker's claude runs it through
// host-generated inline `--settings` hooks as `<node> <hook> <event> <outbox>
// <sharedDir> <sid> <attempt>`. It is therefore SELF-CONTAINED: `node:` imports only,
// no network, no env read for authority — every input comes from the sealed argv,
// the hook's stdin JSON and the worker's own HOME.
//
// What it writes is a RELIABILITY OBSERVATION, never a report and never success:
// when a turn that was started by a staged dispatch ref ends (Stop / StopFailure /
// SessionEnd), it writes `<outbox>/<request_id>/TURN-<n>.md` so the host pump can say
// "the turn ended and no REPORT/HOLD was captured". The model can forge these files
// too (HOME is writable); the pump treats them as status only.
//
// It never prints to stdout (UserPromptSubmit stdout would reach the model; a JSON
// `decision` could loop the turn) and always exits 0. A failure is recorded as a
// constant-code marker `<outbox>/.hook-degraded-<code>`; only if that marker cannot
// be written either does it print one constant line to stderr.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const TURN_MAX_SEQ = 64;
export const TURN_MAX_BYTES = 8192;
export const STDIN_MAX_BYTES = 1024 * 1024;
export const REF_MAX_BYTES = 1024 * 1024;
export const TAIL_MAX_CHARS = 2048;
export const FORMAL_LIST_MAX = 32;
export const BOUND_MAX = 8;
export const STORAGE_FAILURE_MARKER = "aigentry-turn-hook: DEGRADED_STORAGE_UNWRITABLE\n";
export const UNBOUND_DIR = "_unbound";

export type HookEvent = "UserPromptSubmit" | "Stop" | "StopFailure" | "SessionEnd";

/** Constant diagnostic codes; never payload. */
export type HookDegradedCode =
  | "args_invalid" | "stdin_unparsable" | "stdin_oversize" | "session_invalid" | "state_lock"
  | "state_parse" | "state_write" | "bound_limit" | "turn_limit" | "item_write" | "outbox_invalid" | "internal";

export interface HookArgs {
  event: HookEvent;
  outbox: string;
  sharedDir: string;
  sid: string;
  attempt: string;
}

/** The 1170 trailer, as the controller wrote it into the staged ref. */
export interface TrailerBinding {
  request_id: string;
  challenge: string;
  sid: string;
  attempt: string;
}

export interface TurnBinding {
  r: string;
  c: string;
  /** Formal item names (REPORT-n/HOLD-n) already in `<outbox>/<r>` when the prompt arrived. */
  before: string[];
}

export interface TurnState {
  v: 1;
  /** Turn counter for this claude session. */
  n: number;
  open: boolean;
  /** `unknown` once a second prompt arrived before the turn ended (queued or interrupted: not provable). */
  assoc: "exact" | "unknown";
  bound: TurnBinding[];
  /** An unbound prompt is part of the open turn. */
  unbound: boolean;
  /** `<r>/<KIND-n>` across all request dirs when the unbound part began. */
  ub_before: string[];
}

export interface TurnItemFields {
  /** request id, or "unbound" */
  requestId: string;
  /** challenge, or "-" */
  challenge: string;
  seq: number;
  end: "stop" | "api_error" | "session_end";
  turn: number;
  session: string;
  error: string | null;
  reason: string | null;
  assoc: "exact" | "unknown";
  before: string[];
  after: string[];
  at: string;
  tail: string;
}

export interface HookOutcome {
  wrote: string[];
  degraded: HookDegradedCode[];
}

/** The fs surface used, injectable for tests. */
export type HookFs = Pick<typeof fs, "lstatSync" | "realpathSync" | "openSync" | "fstatSync" | "readSync" |
  "writeSync" | "closeSync" | "opendirSync" | "mkdirSync" | "renameSync" | "unlinkSync" | "readFileSync" | "constants">;

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_RE = /^[A-Za-z0-9-]{1,128}$/;
const FORMAL_RE = /^(REPORT|HOLD)-([1-9]|[12][0-9]|3[0-2])\.md$/;
const EVENTS: readonly HookEvent[] = ["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];
const REF_PROMPT_HEAD = "[context-ref] Read ";
const REF_PROMPT_TAIL = " and use it as the source of truth for this task.";
const TRAILER_MARKER = "<!-- aigentry-report v1 -->";
const TRAILER_RE = /^REPORT_ENVELOPE request_id=([0-9a-f-]{36}) challenge=([A-Za-z0-9_-]{43}) dispatch_task=(\S+) sid=(\S+) attempt=(\S+) dir=\$AIGENTRY_REPORT_OUTBOX\/([0-9a-f-]{36})$/;

const sha256Hex = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** `[A-Za-z0-9_.-]{1,64}` or "other". */
export function sanitizeCode(s: unknown): string {
  return typeof s === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(s) ? s : "other";
}

/**
 * The staged ref path iff the WHOLE prompt is exactly dispatch's
 * `[context-ref] Read <sharedDir>/<64 hex>.md and use it as the source of truth for this task.`
 */
export function matchRefPrompt(prompt: unknown, sharedDir: string): string | null {
  if (typeof prompt !== "string") return null;
  const head = REF_PROMPT_HEAD + sharedDir + path.sep;
  if (!prompt.startsWith(head) || !prompt.endsWith(".md" + REF_PROMPT_TAIL)) return null;
  const hex = prompt.slice(head.length, prompt.length - (".md" + REF_PROMPT_TAIL).length);
  return /^[0-9a-f]{64}$/.test(hex) ? path.join(sharedDir, `${hex}.md`) : null;
}

/** The trailer iff the last two non-empty lines are the 1170 marker and envelope line. */
export function parseTrailer(body: string): TrailerBinding | null {
  const lines = body.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  if (lines.length < 2 || lines[lines.length - 2] !== TRAILER_MARKER) return null;
  const m = TRAILER_RE.exec(lines[lines.length - 1]!);
  if (!m || m[1] !== m[6] || !UUID_RE.test(m[1]!)) return null;
  return { request_id: m[1]!, challenge: m[2]!, sid: m[4]!, attempt: m[5]! };
}

function cleanTail(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.slice(-TAIL_MAX_CHARS).replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?")
    .replace(/-----(BEGIN|END) UNTRUSTED-----/g, "-----$1 UNTRUSTED (quoted)-----");
}

/** One TURN item, ≤ TURN_MAX_BYTES (the tail is cut first). */
export function renderTurnItem(f: TurnItemFields): string {
  const list = (v: string[]): string => v.slice(0, FORMAL_LIST_MAX).join(",") || "-";
  const head = [
    `AIGENTRY_REPORT v1 request_id=${f.requestId} challenge=${f.challenge} kind=TURN seq=${f.seq}`,
    `end=${f.end}`, `turn=${f.turn}`, `session=${f.session}`,
    ...(f.error !== null ? [`error=${f.error}`] : []), ...(f.reason !== null ? [`reason=${f.reason}`] : []),
    `assoc=${f.assoc}`, `before=${list(f.before)}`, `after=${list(f.after)}`, `at=${f.at}`, "observed_by=hook",
    "-----BEGIN UNTRUSTED-----",
  ].join("\n");
  const end = `\n-----END UNTRUSTED-----\nAIGENTRY_REPORT_END ${f.requestId} TURN-${f.seq}\n`;
  let tail = cleanTail(f.tail);
  while (Buffer.byteLength(head + "\n" + tail + end) > TURN_MAX_BYTES && tail.length) tail = tail.slice(Math.ceil(tail.length / 8));
  return head + "\n" + tail + end;
}

function realDir(fsApi: HookFs, dir: string, create: boolean): boolean {
  try {
    const st = fsApi.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch (e) {
    if (!create || (e as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try {
      fsApi.mkdirSync(dir, { mode: 0o700 });
      return fsApi.lstatSync(dir).isDirectory();
    } catch {
      return false;
    }
  }
}

function formalNames(fsApi: HookFs, dir: string): string[] {
  const out: string[] = [];
  try {
    const d = fsApi.opendirSync(dir);
    try {
      let seen = 0;
      for (let e = d.readSync(); e !== null && ++seen <= 512; e = d.readSync()) {
        if (FORMAL_RE.test(e.name)) out.push(e.name.slice(0, -3));
      }
    } finally {
      d.closeSync();
    }
  } catch {
    /* absent dir = none */
  }
  return out.sort().slice(0, FORMAL_LIST_MAX);
}

function allFormal(fsApi: HookFs, outbox: string): string[] {
  const out: string[] = [];
  try {
    const d = fsApi.opendirSync(outbox);
    try {
      let seen = 0;
      for (let e = d.readSync(); e !== null && ++seen <= 512; e = d.readSync()) {
        if (!UUID_RE.test(e.name)) continue;
        for (const n of formalNames(fsApi, path.join(outbox, e.name))) out.push(`${e.name}/${n}`);
      }
    } finally {
      d.closeSync();
    }
  } catch {
    /* none */
  }
  return out.sort().slice(0, FORMAL_LIST_MAX);
}

function readBounded(fsApi: HookFs, file: string, max: number): Buffer | null {
  const nofollow = fsApi.constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    const st = fsApi.lstatSync(file);
    if (!st.isFile() || st.size > max) return null;
    fd = fsApi.openSync(file, fsApi.constants.O_RDONLY | nofollow | (fsApi.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    if (!fsApi.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n <= max && (r = fsApi.readSync(fd, buf, n, max + 1 - n, null)) > 0;) n += r;
    return n > max ? null : buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    fsApi.closeSync(fd);
  }
}

/** The binding of a prompt: exact ref template, regular file, sha matches its name, trailer names this sid+attempt. */
function bindPrompt(fsApi: HookFs, a: HookArgs, prompt: unknown): TurnBinding | null {
  const staged = matchRefPrompt(prompt, a.sharedDir);
  if (!staged) return null;
  const bytes = readBounded(fsApi, staged, REF_MAX_BYTES);
  if (!bytes || sha256Hex(bytes) !== path.basename(staged, ".md")) return null;
  const t = parseTrailer(bytes.toString("utf8"));
  if (!t || t.sid !== a.sid || t.attempt !== a.attempt) return null;
  return { r: t.request_id, c: t.challenge, before: formalNames(fsApi, path.join(a.outbox, t.request_id)) };
}

/** Bounded exclusive lock (O_EXCL file); a holder that no longer exists is broken. */
function lock(fsApi: HookFs, file: string, tries: number): boolean {
  for (let i = 0; i < tries; i++) {
    try {
      const fd = fsApi.openSync(file, fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL, 0o600);
      fsApi.writeSync(fd, String(process.pid));
      fsApi.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
      const pid = Number(readBounded(fsApi, file, 32)?.toString("utf8") ?? "");
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(pid, 0); } catch (k) { dead = (k as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead) {
        try { fsApi.unlinkSync(file); } catch { /* raced */ }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return false;
}

function writeNew(fsApi: HookFs, file: string, data: string): "ok" | "exists" | "failed" {
  let fd: number;
  try {
    fd = fsApi.openSync(file, fsApi.constants.O_WRONLY | fsApi.constants.O_CREAT | fsApi.constants.O_EXCL |
      (fsApi.constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed";
  }
  try {
    const b = Buffer.from(data, "utf8");
    for (let off = 0; off < b.length;) off += fsApi.writeSync(fd, b, off, b.length - off);
    return "ok";
  } catch {
    return "failed";
  } finally {
    fsApi.closeSync(fd);
  }
}

/** Constant-code marker; false when even that cannot be written. */
export function markDegraded(fsApi: HookFs, outbox: string, code: HookDegradedCode): boolean {
  const r = writeNew(fsApi, path.join(outbox, `.hook-degraded-${code}`), `${code}\n`);
  return r !== "failed";
}

const freshState = (n: number): TurnState => ({ v: 1, n, open: false, assoc: "exact", bound: [], unbound: false, ub_before: [] });

function readState(fsApi: HookFs, file: string, out: HookOutcome): TurnState {
  let raw: Buffer | null;
  try {
    fsApi.lstatSync(file);
  } catch {
    return freshState(0);
  }
  raw = readBounded(fsApi, file, 64 * 1024);
  try {
    const s = JSON.parse(raw ? raw.toString("utf8") : "") as TurnState;
    if (s && s.v === 1 && Number.isSafeInteger(s.n) && typeof s.open === "boolean" && Array.isArray(s.bound) &&
        Array.isArray(s.ub_before) && (s.assoc === "exact" || s.assoc === "unknown")) return s;
  } catch {
    /* below */
  }
  out.degraded.push("state_parse");
  return freshState(0);
}

function writeState(fsApi: HookFs, file: string, s: TurnState, out: HookOutcome): void {
  const tmp = `${file}.${process.pid}.tmp`;
  if (writeNew(fsApi, tmp, JSON.stringify(s)) !== "ok") {
    out.degraded.push("state_write");
    try { fsApi.unlinkSync(tmp); } catch { /* none */ }
    return;
  }
  try {
    fsApi.renameSync(tmp, file);
  } catch {
    out.degraded.push("state_write");
    try { fsApi.unlinkSync(tmp); } catch { /* none */ }
  }
}

function emitTurn(fsApi: HookFs, dir: string, f: Omit<TurnItemFields, "seq">, out: HookOutcome): void {
  if (!realDir(fsApi, dir, true)) {
    out.degraded.push("item_write");
    return;
  }
  for (let seq = 1; seq <= TURN_MAX_SEQ; seq++) {
    const r = writeNew(fsApi, path.join(dir, `TURN-${seq}.md`), renderTurnItem({ ...f, seq }));
    if (r === "ok") {
      out.wrote.push(path.join(dir, `TURN-${seq}.md`));
      return;
    }
    if (r === "failed") {
      out.degraded.push("item_write");
      return;
    }
  }
  out.degraded.push("turn_limit");
}

export function parseArgs(args: readonly string[]): HookArgs | null {
  const [event, outbox, sharedDir, sid, attempt] = args;
  if (args.length !== 5 || !EVENTS.includes(event as HookEvent) || !outbox || !path.isAbsolute(outbox) ||
      !sharedDir || !path.isAbsolute(sharedDir) || !SID_RE.test(sid ?? "") || !UUID_RE.test(attempt ?? "")) return null;
  return { event: event as HookEvent, outbox, sharedDir, sid: sid!, attempt: attempt! };
}

/** One hook invocation. Never throws for expected failures; every failure is a code in `degraded`. */
export function runHook(args: readonly string[], stdin: Buffer | null, fsApi: HookFs, nowMs: number): HookOutcome {
  const out: HookOutcome = { wrote: [], degraded: [] };
  const a = parseArgs(args);
  if (!a) {
    out.degraded.push("args_invalid");
    return out;
  }
  if (!realDir(fsApi, a.outbox, false)) {
    out.degraded.push("outbox_invalid");
    return out;
  }
  if (stdin === null) {
    out.degraded.push("stdin_oversize");
    return out;
  }
  let input: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(stdin.toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("shape");
    input = v as Record<string, unknown>;
  } catch {
    out.degraded.push("stdin_unparsable");
    return out;
  }
  const session = typeof input.session_id === "string" && SESSION_RE.test(input.session_id) ? input.session_id : null;
  if (!session) {
    out.degraded.push("session_invalid");
    return out;
  }
  const stateFile = path.join(a.outbox, `.turn-${session}.json`);
  const lockFile = path.join(a.outbox, `.turn-${session}.lock`);
  if (!lock(fsApi, lockFile, a.event === "SessionEnd" ? 20 : 80)) {
    out.degraded.push("state_lock");
    return out;
  }
  try {
    const s = readState(fsApi, stateFile, out);
    if (a.event === "UserPromptSubmit") {
      const b = bindPrompt(fsApi, a, input.prompt);
      if (s.open) {
        // A second prompt before the turn ended: queued into it or after an interrupt —
        // not provable either way, so the whole turn's association becomes unknown.
        s.assoc = "unknown";
      } else {
        Object.assign(s, freshState(s.n + 1), { open: true });
      }
      if (b && !s.bound.some((x) => x.r === b.r)) {
        if (s.bound.length >= BOUND_MAX) out.degraded.push("bound_limit");
        else s.bound.push(b);
      } else if (!b && !s.unbound) {
        s.unbound = true;
        s.ub_before = allFormal(fsApi, a.outbox);
      }
      writeState(fsApi, stateFile, s, out);
      return out;
    }
    if (!s.open) return out; // duplicate Stop / Stop after SessionEnd / SessionEnd with no turn
    const end = a.event === "Stop" ? "stop" : a.event === "StopFailure" ? "api_error" : "session_end";
    const common = { end, turn: s.n, session, assoc: s.assoc, at: new Date(nowMs).toISOString().slice(0, 19) + "Z",
      error: a.event === "StopFailure" ? sanitizeCode(input.error) : null,
      reason: a.event === "SessionEnd" ? sanitizeCode(input.reason) : null,
      tail: a.event === "SessionEnd" ? "" : String(input.last_assistant_message ?? "") } as const;
    for (const b of s.bound) {
      emitTurn(fsApi, path.join(a.outbox, b.r), { ...common, requestId: b.r, challenge: b.c, before: b.before,
        after: formalNames(fsApi, path.join(a.outbox, b.r)) }, out);
    }
    if (s.unbound || !s.bound.length) {
      emitTurn(fsApi, path.join(a.outbox, UNBOUND_DIR), { ...common, requestId: "unbound", challenge: "-",
        before: s.ub_before, after: allFormal(fsApi, a.outbox) }, out);
    }
    s.open = false;
    writeState(fsApi, stateFile, s, out);
    return out;
  } finally {
    try { fsApi.unlinkSync(lockFile); } catch { /* already gone */ }
  }
}

function readStdin(): Buffer | null {
  const buf = Buffer.alloc(STDIN_MAX_BYTES + 1);
  let n = 0;
  for (let spins = 0; n <= STDIN_MAX_BYTES && spins < 200;) {
    let r: number;
    try {
      r = fs.readSync(0, buf, n, STDIN_MAX_BYTES + 1 - n, null);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EAGAIN") break;
      spins += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    if (r === 0) break;
    n += r;
  }
  return n > STDIN_MAX_BYTES ? null : buf.subarray(0, n);
}

function main(): void {
  const args = process.argv.slice(2);
  let outcome: HookOutcome;
  try {
    outcome = runHook(args, readStdin(), fs, Date.now());
  } catch {
    outcome = { wrote: [], degraded: ["internal"] };
  }
  const outbox = args[1];
  for (const code of new Set(outcome.degraded)) {
    const ok = typeof outbox === "string" && path.isAbsolute(outbox) && markDegraded(fs, outbox, code);
    if (!ok) {
      process.stderr.write(STORAGE_FAILURE_MARKER);
      break;
    }
  }
  process.exitCode = 0;
}

let isMain = false;
try {
  isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {
  isMain = false;
}
if (isMain) main();
