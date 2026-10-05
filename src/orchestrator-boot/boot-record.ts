// #1162 — the controller boot record: a terminal-neutral, DISPLAY-ONLY description of the
// cli/model/effort the controller was CONFIGURED to boot with (CONTRACT-r2 §2-3). Values are
// "configured at boot": in-session model changes and provider acceptance are not observed.
//
// NOT AUTHORITY. No field here authorises exec, kill, registry DELETE, permission, resume,
// restart, cleanup or approval. `boot_id` names one boot and is not a credential. The pane ids
// are public, inheritable CMUX_* env values — a HINT, never proof of which pane is whose.
// `targetRelation()` DESCRIBES two records' recorded values; it is not evidence of pane
// ownership and gates nothing. A renderer must do its own ownership check at mutation time.
//
// SAME-USER RACE LIMIT (§3.5, corrected). Node has no openat/dirfd, so every path check below
// is check-then-use. A concurrent process running as the same user can swap an ancestor
// directory between a check and the rename. The post-rename re-check reports drift it happens
// to OBSERVE as `skipped:raced` (never "written"); it does not detect every swap or an ABA
// sequence, does not prove uninterrupted ownership, and prevents nothing. That actor already
// holds the user's authority, and the record grants none.
//
// Stdlib only: no subprocess, no network, no host call. No chmod/chown — nothing is repaired
// or widened — and an invalid prior file is never overwritten, renamed or deleted.
//
// WIN32 (#1167, PRINCIPLES P2/P3/P4): the uid/mode rules are read-back ACL checks through the
// private-storage primitive (bin/lib/win-private-storage.mjs, which runs the Windows system tools
// icacls/whoami/PowerShell — the only subprocesses, and only on win32). Only a directory this call
// created is Set private (the `mkdir 0700` analogue); nothing pre-existing is repaired or widened.
// File data is fsync'd; the directory entry relies on NTFS journaling (no directory fsync, P3).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeLaunch } from "../session/boot-adapter/launch-config.js";
import type { VerifyItem, VerifyResult, WinPrivateStorage } from "../session/private-storage.js";
import {
  isCliKind,
  type CliKind,
  type LaunchConfig,
  type LaunchSource,
  type LaunchValue,
} from "../session/boot-adapter/types.js";
import { PLAN_ENV, type EffortChoice, type ModelChoice } from "./plan.js";

export const RECORD_MAX_BYTES = 4096;
const RECORD_FILE = "boot-record.json";
const KIND = "aigentry-controller-boot";
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LOWER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_KEYS = ["v", "kind", "sid", "boot_id", "plan_source", "launch", "pane"] as const;
const LAUNCH_KEYS = ["v", "cli", "model", "effort"] as const;
const PANE_KEYS = ["host", "workspace_id", "surface_id", "terminal_lifecycle_id"] as const;
const MODEL_ENV_SOURCE: LaunchSource = `env:${PLAN_ENV.model}`;
const EFFORT_ENV_SOURCE: LaunchSource = `env:${PLAN_ENV.effort}`;
const CLI_DEFAULT_VALUE: LaunchValue = Object.freeze({ value: "unknown", source: "cli-default" });
// win32 only: the P2 primitive through its typed bridge. A conditional dynamic import, so the POSIX
// boot module closure is unchanged (tests/packaging/native-capture.test.mjs pins it). A failed load
// leaves it null, which is `skipped:platform` — the record never stops a boot.
const WIN_STORAGE: WinPrivateStorage | null = process.platform === "win32"
  ? await import("../session/private-storage.js").then((m) => m.winPrivateStorage, () => null)
  : null;
// Primitive codes that mean "the tools or the environment failed", not "this path is unsafe".
const WIN_UNAVAILABLE: ReadonlySet<string> = new Set([
  "unsupported_platform", "system_root_invalid", "tool_missing", "tool_timeout", "tool_failed", "tool_output_invalid",
  "principal_unavailable", "read_failed",
]);

export type PlanSource = "wizard" | "env-plan";

export interface PaneHint {
  readonly host: "cmux" | "none";
  readonly workspace_id: string | null;
  readonly surface_id: string | null;
  readonly terminal_lifecycle_id: string | null;
}

export interface ControllerBootRecord {
  readonly v: 1;
  readonly kind: typeof KIND;
  readonly sid: string;
  readonly boot_id: string;
  readonly plan_source: PlanSource;
  readonly launch: LaunchConfig;
  readonly pane: PaneHint;
}

/** What the boot knows. `env` is the booting process's env, read only for the CMUX_* hints. */
export interface BootRecordInput {
  readonly sid: string;
  readonly planSource: PlanSource;
  readonly cli: string;
  readonly model: ModelChoice;
  readonly effort: EffortChoice;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type WriteOutcome =
  | "written"
  | "skipped:sid"
  | "skipped:platform"
  | "skipped:cli"
  | "skipped:unsafe-path"
  | "skipped:prior-invalid"
  | "skipped:raced"
  | "skipped:error";

export type TargetRelation = "first" | "same-recorded-target" | "different-recorded-target" | "target-unknown";

export interface WriteResult {
  readonly outcome: WriteOutcome;
  readonly relation: TargetRelation | "none";
}

export type ReadResult =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "ok"; readonly record: ControllerBootRecord }
  | { readonly status: "skipped"; readonly reason: "sid" | "platform" | "unsafe-path" };

/**
 * The platform prerequisites. A missing `process.getuid` or safe open flag is an explicit
 * `skipped:platform`, never a pretend success. On win32 `storage` (the P2 primitive) selects the
 * win32 arm instead; without it win32 is `skipped:platform` too. Injectable for tests only.
 */
export interface BootRecordPlatform {
  readonly getuid: (() => number) | undefined;
  readonly noFollow: number | undefined;
  readonly nonBlock: number | undefined;
  readonly storage?: WinPrivateStorage | null;
}

export function nodePlatform(): BootRecordPlatform {
  return {
    getuid: typeof process.getuid === "function" ? process.getuid.bind(process) : undefined,
    noFollow: fs.constants.O_NOFOLLOW,
    nonBlock: fs.constants.O_NONBLOCK,
    storage: WIN_STORAGE,
  };
}

interface Safe {
  readonly uid: number;
  readonly noFollow: number;
  readonly nonBlock: number;
}

function supported(p: BootRecordPlatform): Safe | null {
  if (typeof p.getuid !== "function" || typeof p.noFollow !== "number" || typeof p.nonBlock !== "number") return null;
  return { uid: p.getuid(), noFollow: p.noFollow, nonBlock: p.nonBlock };
}

/** Same rule as cli.ts validateCapture and boot-prepare: AIGENTRY_HOME if non-empty. */
export function controllerRecordRoot(env: Readonly<Record<string, string | undefined>>): string {
  return env.AIGENTRY_HOME || path.join(os.homedir(), ".aigentry");
}

export function isSafeSid(sid: unknown): sid is string {
  return typeof sid === "string" && SID_RE.test(sid);
}

/** `<root>/sessions/<sid>/controller/boot-record.json`, or null for an unsafe sid. */
export function recordPath(root: string, sid: string): string | null {
  return isSafeSid(sid) ? path.join(controllerDir(path.resolve(root), sid), RECORD_FILE) : null;
}

function controllerDir(root: string, sid: string): string {
  return path.join(root, "sessions", sid, "controller");
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExactKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}

// ── the safe chain (§3.2) ───────────────────────────────────────────────────
type DirState = "ok" | "missing" | "unsafe";

function safeDir(p: string, uid: number): DirState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return errCode(e) === "ENOENT" ? "missing" : "unsafe";
  }
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o022) === 0 ? "ok" : "unsafe";
}

/**
 * ROOT, ROOT/sessions, …/<sid>, …/<sid>/controller — each by lstat. ROOT and sessions must
 * pre-exist. With `create`, <sid> and controller may each be made by ONE non-recursive
 * mkdir 0700 and are then re-lstat'd (also after EEXIST); nothing is ever chmod'd or chown'd.
 * Ancestors above ROOT are outside the trust boundary.
 */
function chain(root: string, sid: string, uid: number, create: boolean): DirState {
  for (const d of [root, path.join(root, "sessions")]) {
    const s = safeDir(d, uid);
    if (s !== "ok") return s;
  }
  for (const d of [path.join(root, "sessions", sid), controllerDir(root, sid)]) {
    let s = safeDir(d, uid);
    if (s === "missing" && create) {
      try {
        fs.mkdirSync(d, { mode: 0o700 });
      } catch (e) {
        if (errCode(e) !== "EEXIST") return "unsafe";
      }
      s = safeDir(d, uid);
      if (s === "missing") return "unsafe";
    }
    if (s !== "ok") return s;
  }
  return "ok";
}

// ── the record shape (§2) ───────────────────────────────────────────────────
function paneHint(v: string | undefined): string | null {
  return typeof v === "string" && UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** CMUX_* env → pane hint. `host:"cmux"` iff a workspace UUID is present, else all null. */
export function paneFromEnv(env: Readonly<Record<string, string | undefined>>): PaneHint {
  const workspace = paneHint(env.CMUX_WORKSPACE_ID);
  if (workspace === null) {
    return Object.freeze({ host: "none", workspace_id: null, surface_id: null, terminal_lifecycle_id: null });
  }
  return Object.freeze({
    host: "cmux",
    workspace_id: workspace,
    surface_id: paneHint(env.CMUX_SURFACE_ID),
    terminal_lifecycle_id: paneHint(env.CMUX_TERMINAL_LIFECYCLE_ID),
  });
}

/**
 * Plan choices → LaunchConfig. provider-default → {unknown, cli-default}; an explicit value is
 * `wizard` or `env:AIGENTRY_BOOT_MODEL|EFFORT` by plan source. Nothing is inferred from a title
 * or model name. A value outside the shared charsets (e.g. `opus[1m]`, `a+b`, `HIGH`) comes
 * back from normalizeLaunch as an explicit unknown — a known representational gap.
 */
export function recordedLaunch(cli: CliKind, planSource: PlanSource, model: ModelChoice, effort: EffortChoice): LaunchConfig {
  const explicit = (env: LaunchSource): LaunchSource => (planSource === "wizard" ? "wizard" : env);
  const m = model.kind === "explicit" ? { value: model.id, source: explicit(MODEL_ENV_SOURCE) } : CLI_DEFAULT_VALUE;
  const e = effort.kind === "provider-default" ? CLI_DEFAULT_VALUE : { value: effort.value, source: explicit(EFFORT_ENV_SOURCE) };
  return normalizeLaunch(cli, { v: 2, cli, model: m, effort: e });
}

/** The record for one boot, or null when the cli is not a known CliKind (`skipped:cli`). */
export function buildControllerBootRecord(input: BootRecordInput, bootId: string): ControllerBootRecord | null {
  if (!isCliKind(input.cli)) return null;
  return Object.freeze({
    v: 1,
    kind: KIND,
    sid: input.sid,
    boot_id: bootId,
    plan_source: input.planSource,
    launch: recordedLaunch(input.cli, input.planSource, input.model, input.effort),
    pane: paneFromEnv(input.env),
  });
}

function sameValue(canonical: LaunchValue, raw: unknown): boolean {
  return isPlainObject(raw) && hasExactKeys(raw, ["value", "source"]) &&
    raw.value === canonical.value && raw.source === canonical.source;
}

function sourceFits(v: LaunchValue, planSource: PlanSource, envSource: LaunchSource): boolean {
  return v.source === "cli-default" || v.source === "unknown" ||
    v.source === (planSource === "wizard" ? "wizard" : envSource);
}

function parsePane(raw: unknown): PaneHint | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, PANE_KEYS)) return null;
  const { host, workspace_id, surface_id, terminal_lifecycle_id } = raw;
  const id = (u: unknown): u is string | null => u === null || (typeof u === "string" && LOWER_UUID_RE.test(u));
  if (!id(workspace_id) || !id(surface_id) || !id(terminal_lifecycle_id)) return null;
  if (host === "cmux") {
    if (workspace_id === null) return null;
  } else if (host === "none") {
    if (workspace_id !== null || surface_id !== null || terminal_lifecycle_id !== null) return null;
  } else {
    return null;
  }
  return Object.freeze({ host, workspace_id, surface_id, terminal_lifecycle_id });
}

/**
 * Structural validation of an untrusted parsed record. Exact keys and canonical values; key
 * order alone is neither corruption nor authority. Non-canonical → null (invalid), never repaired.
 */
export function parseControllerBootRecord(raw: unknown, sid: string): ControllerBootRecord | null {
  if (!isPlainObject(raw) || !hasExactKeys(raw, RECORD_KEYS)) return null;
  const { v, kind, boot_id, plan_source, launch } = raw;
  if (v !== 1 || kind !== KIND || raw.sid !== sid || !isSafeSid(sid)) return null;
  if (typeof boot_id !== "string" || !BOOT_ID_RE.test(boot_id)) return null;
  if (plan_source !== "wizard" && plan_source !== "env-plan") return null;
  if (!isPlainObject(launch) || !hasExactKeys(launch, LAUNCH_KEYS) || !isCliKind(launch.cli)) return null;
  const canonical = normalizeLaunch(launch.cli, launch);
  if (launch.v !== canonical.v || !sameValue(canonical.model, launch.model) || !sameValue(canonical.effort, launch.effort)) {
    return null;
  }
  if (!sourceFits(canonical.model, plan_source, MODEL_ENV_SOURCE) || !sourceFits(canonical.effort, plan_source, EFFORT_ENV_SOURCE)) {
    return null;
  }
  const pane = parsePane(raw.pane);
  if (pane === null) return null;
  return Object.freeze({ v: 1, kind: KIND, sid, boot_id, plan_source, launch: canonical, pane });
}

// ── reading (§3.3) ──────────────────────────────────────────────────────────
/**
 * O_NOFOLLOW|O_NONBLOCK open, then fstat type/nlink/uid/mode/size BEFORE any read, then ONE
 * read into a fixed 4097-byte buffer. A symlink, fifo, hardlink, group/other-readable,
 * oversize or malformed file is `invalid`, and is left exactly as it was.
 */
function readRecordFile(file: string, sid: string, safe: Safe): "absent" | "invalid" | ControllerBootRecord {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | safe.noFollow | safe.nonBlock);
  } catch (e) {
    return errCode(e) === "ENOENT" ? "absent" : "invalid";
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== safe.uid || (st.mode & 0o077) !== 0 || st.size > RECORD_MAX_BYTES) {
      return "invalid";
    }
    const buf = Buffer.alloc(RECORD_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > RECORD_MAX_BYTES) return "invalid";
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8", 0, n));
    } catch {
      return "invalid";
    }
    return parseControllerBootRecord(parsed, sid) ?? "invalid";
  } finally {
    fs.closeSync(fd);
  }
}

/** READ-ONLY: validates the chain first and never creates a directory. */
export function readControllerBootRecord(
  root: string,
  sid: string,
  platform: BootRecordPlatform = nodePlatform(),
): ReadResult {
  if (!isSafeSid(sid)) return { status: "skipped", reason: "sid" };
  try {
    const storage = winStorage(platform);
    if (storage !== null) return winRead(root, sid, storage);
    const safe = supported(platform);
    if (safe === null) return { status: "skipped", reason: "platform" };
    const base = path.resolve(root);
    const c = chain(base, sid, safe.uid, false);
    if (c === "missing") return { status: "absent" };
    if (c === "unsafe") return { status: "skipped", reason: "unsafe-path" };
    const r = readRecordFile(path.join(controllerDir(base, sid), RECORD_FILE), sid, safe);
    if (r === "absent" || r === "invalid") return { status: r };
    return { status: "ok", record: r };
  } catch {
    return { status: "invalid" };
  }
}

// ── relation (§3.6) ─────────────────────────────────────────────────────────
/**
 * A DESCRIPTION of two records' recorded public values — never ownership evidence, never a
 * skip-check. same-recorded-target needs both `host:"cmux"` with all three ids non-null and
 * equal; any null is target-unknown, which equals nothing.
 */
export function targetRelation(prior: ControllerBootRecord | null, next: ControllerBootRecord): TargetRelation {
  if (prior === null) return "first";
  const a = prior.pane;
  const b = next.pane;
  const full = (p: PaneHint): boolean =>
    p.host === "cmux" && p.workspace_id !== null && p.surface_id !== null && p.terminal_lifecycle_id !== null;
  if (!full(a) || !full(b)) return "target-unknown";
  return a.workspace_id === b.workspace_id && a.surface_id === b.surface_id &&
    a.terminal_lifecycle_id === b.terminal_lifecycle_id
    ? "same-recorded-target"
    : "different-recorded-target";
}

// ── writing (§3.4) ──────────────────────────────────────────────────────────
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * chain → prior read → unique wx 0600 temp in the checked directory → write/fsync/close →
 * rename over the target (a planted link AT the target is replaced, not followed) → chain
 * re-check and dev/ino compare. An invalid prior is preserved and the write skipped. On any
 * error only OUR temp path is unlinked. Never throws.
 */
export function writeControllerBootRecord(
  root: string,
  input: BootRecordInput,
  platform: BootRecordPlatform = nodePlatform(),
): WriteResult {
  const skip = (outcome: WriteOutcome): WriteResult => ({ outcome, relation: "none" });
  let tmp: string | null = null;
  try {
    if (!isSafeSid(input.sid)) return skip("skipped:sid");
    const storage = winStorage(platform);
    if (storage !== null) return winWrite(root, input, storage);
    const safe = supported(platform);
    if (safe === null) return skip("skipped:platform");
    const record = buildControllerBootRecord(input, randomUUID());
    if (record === null) return skip("skipped:cli");
    const base = path.resolve(root);
    if (chain(base, input.sid, safe.uid, true) !== "ok") return skip("skipped:unsafe-path");
    const dir = controllerDir(base, input.sid);
    const target = path.join(dir, RECORD_FILE);
    const prior = readRecordFile(target, input.sid, safe);
    if (prior === "invalid") return skip("skipped:prior-invalid");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.length > RECORD_MAX_BYTES) return skip("skipped:error");

    const tmpPath = path.join(dir, `.${RECORD_FILE}.${randomUUID()}`);
    const fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | safe.noFollow,
      0o600,
    );
    tmp = tmpPath;
    let written: fs.Stats;
    try {
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      fs.fsyncSync(fd);
      written = fs.fstatSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, target);
    tmp = null;

    // Detects only drift it observes (see the header's race limit).
    const after = chain(base, input.sid, safe.uid, false) === "ok" ? lstatOrNull(target) : null;
    if (after === null || after.dev !== written.dev || after.ino !== written.ino) return skip("skipped:raced");
    return { outcome: "written", relation: targetRelation(prior === "absent" ? null : prior, record) };
  } catch {
    if (tmp !== null) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best effort, and only ever our own temp path.
      }
    }
    return skip("skipped:error");
  }
}

// ── the win32 arm (#1167; PRINCIPLES P2/P3/P4, DECISIONS-2 Q-FILE R2) ───────
// Same outcomes and order as the POSIX arm; only the safety predicates differ:
// - ROOT, sessions and <sid> must be P-OWNED (the `uid===euid && !(mode&022)` analogue) and the
//   controller directory P2-private; the record is a private FILE, verified together with its
//   private parent in ONE read batch (no file Set). Chain and record are one batch.
// - no-follow (P4): lstat every component under ROOT and refuse reparse points (symlink,
//   junction), plus realpath containment; the opened record handle is bound to the verified
//   (dev, ino), because there is no O_NOFOLLOW.
// - a tool or environment failure is `skipped:platform` (read: reason "platform").
type WinState = DirState | "unavailable";

interface WinChain {
  readonly state: WinState;
  readonly file?: VerifyResult;
  readonly missingAt?: number;
}

function winStorage(p: BootRecordPlatform): WinPrivateStorage | null {
  return process.platform === "win32" ? p.storage ?? null : null;
}

function winFailure(code: string | undefined): "unavailable" | "unsafe" {
  return code !== undefined && WIN_UNAVAILABLE.has(code) ? "unavailable" : "unsafe";
}

/** lstat walk ROOT → controller; ONE verify batch over the existing prefix, plus the record once all four exist. */
function winVerify(storage: WinPrivateStorage, dirs: readonly string[], file: string): WinChain {
  const items: VerifyItem[] = [];
  let missingAt = -1;
  for (const [i, d] of dirs.entries()) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(d);
    } catch (e) {
      if (errCode(e) !== "ENOENT") return { state: "unsafe" };
      missingAt = i;
      break;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) return { state: "unsafe" };
    items.push({ path: d, kind: "directory", want: i === dirs.length - 1 ? "private" : "owned" });
  }
  if (missingAt === -1) items.push({ path: file, kind: "file", want: "private" });
  const results = items.length === 0 ? [] : storage.verify(items);
  const dirResults = missingAt === -1 ? results.slice(0, -1) : results;
  const failed = dirResults.find((r) => !r.ok);
  if (failed !== undefined) return { state: winFailure(failed.code) };
  if (missingAt !== -1) return { state: "missing", missingAt };
  // Containment catches a mount point or alias under ROOT that lstat does not report as a link.
  const top = dirs[0];
  const leaf = dirs[dirs.length - 1];
  const want = path.join(fs.realpathSync.native(top), path.relative(top, leaf));
  if (fs.realpathSync.native(leaf).toLowerCase() !== want.toLowerCase()) return { state: "unsafe" };
  return { state: "ok", file: results[results.length - 1] };
}

/**
 * The win32 `chain()`: ROOT and sessions must pre-exist. With `create`, <sid> and controller may
 * each be made by ONE mkdir; a directory this call made is Set private, and is removed again if
 * the Set fails (no non-private directory is left to refuse every later boot). Then re-verified.
 */
function winChain(storage: WinPrivateStorage, root: string, sid: string, create: boolean): WinChain {
  const dirs = [root, path.join(root, "sessions"), path.join(root, "sessions", sid), controllerDir(root, sid)];
  const file = path.join(controllerDir(root, sid), RECORD_FILE);
  const first = winVerify(storage, dirs, file);
  if (first.state !== "missing" || !create || (first.missingAt ?? 0) < 2) return first;
  for (const d of dirs.slice(first.missingAt)) {
    let created = true;
    try {
      fs.mkdirSync(d);
    } catch (e) {
      if (errCode(e) !== "EEXIST") return { state: "unsafe" };
      created = false;
    }
    const st = lstatOrNull(d);
    if (st === null || !st.isDirectory() || st.isSymbolicLink()) return { state: "unsafe" };
    if (!created) continue;
    const set = storage.setPrivate(d, "directory");
    if (set.status !== "ok") {
      try {
        fs.rmdirSync(d);
      } catch {
        // Best effort, and only ever the empty directory this call just made.
      }
      return { state: winFailure(set.code) };
    }
  }
  const again = winVerify(storage, dirs, file);
  return again.state === "missing" ? { state: "unsafe" } : again;
}

/** The win32 `readRecordFile()`: `verified` is the record's result from the chain batch. */
function winReadRecordFile(file: string, sid: string, verified: VerifyResult | undefined): "absent" | "invalid" | ControllerBootRecord {
  if (verified === undefined || !verified.ok) return verified?.code === "missing" ? "absent" : "invalid";
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
  } catch (e) {
    return errCode(e) === "ENOENT" ? "absent" : "invalid";
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || String(st.dev) !== verified.dev || String(st.ino) !== verified.ino ||
      st.size > BigInt(RECORD_MAX_BYTES)) {
      return "invalid";
    }
    const buf = Buffer.alloc(RECORD_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > RECORD_MAX_BYTES) return "invalid";
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8", 0, n));
    } catch {
      return "invalid";
    }
    return parseControllerBootRecord(parsed, sid) ?? "invalid";
  } finally {
    fs.closeSync(fd);
  }
}

function winRead(root: string, sid: string, storage: WinPrivateStorage): ReadResult {
  const base = path.resolve(root);
  const c = winChain(storage, base, sid, false);
  if (c.state === "missing") return { status: "absent" };
  if (c.state === "unavailable") return { status: "skipped", reason: "platform" };
  if (c.state === "unsafe") return { status: "skipped", reason: "unsafe-path" };
  const r = winReadRecordFile(path.join(controllerDir(base, sid), RECORD_FILE), sid, c.file);
  if (r === "absent" || r === "invalid") return { status: r };
  return { status: "ok", record: r };
}

function winWrite(root: string, input: BootRecordInput, storage: WinPrivateStorage): WriteResult {
  const skip = (outcome: WriteOutcome): WriteResult => ({ outcome, relation: "none" });
  let tmp: string | null = null;
  try {
    const record = buildControllerBootRecord(input, randomUUID());
    if (record === null) return skip("skipped:cli");
    const base = path.resolve(root);
    const c = winChain(storage, base, input.sid, true);
    if (c.state === "unavailable") return skip("skipped:platform");
    if (c.state !== "ok") return skip("skipped:unsafe-path");
    const dir = controllerDir(base, input.sid);
    const target = path.join(dir, RECORD_FILE);
    const prior = winReadRecordFile(target, input.sid, c.file);
    if (prior === "invalid") return skip("skipped:prior-invalid");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.length > RECORD_MAX_BYTES) return skip("skipped:error");

    // Born private: the temp inherits the verified-private controller directory's single ACE.
    const tmpPath = path.join(dir, `.${RECORD_FILE}.${randomUUID()}`);
    const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    tmp = tmpPath;
    let written: fs.BigIntStats;
    try {
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      fs.fsyncSync(fd);
      written = fs.fstatSync(fd, { bigint: true });
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, target);
    tmp = null;

    // Chain and record read back in one batch (the record's P2 verify). Detects only drift it
    // observes (see the header's race limit).
    const after = winChain(storage, base, input.sid, false);
    if (after.state !== "ok" || after.file?.ok !== true || after.file.dev !== String(written.dev) ||
      after.file.ino !== String(written.ino)) {
      return skip("skipped:raced");
    }
    return { outcome: "written", relation: targetRelation(prior === "absent" ? null : prior, record) };
  } catch {
    if (tmp !== null) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Best effort, and only ever our own temp path.
      }
    }
    return skip("skipped:error");
  }
}
