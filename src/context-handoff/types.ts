// #1201 — context handoff across restarts and CLI switches (SPEC §3.2, §6.4, §10).
//
// The closed unions shared by the engine, plus the engine's READ-ONLY file primitives. The
// primitives live here (not in a module of their own) so the file set stays exactly SPEC §3.1;
// every adapter imports them from here, and nothing in this file can open a file for writing.
// Reads are O_RDONLY (+ O_NOFOLLOW | O_NONBLOCK on POSIX), bounded, and never throw.
import * as fs from "node:fs";
import * as path from "node:path";

export type HandoffCli = "claude" | "codex" | "gemini" | "grok";
export type AdapterStatus = "measured" | "owed";
export type Env = Readonly<Record<string, string | undefined>>;

export interface TranscriptRef {
  readonly cli: HandoffCli;
  readonly sessionId: string;
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  /** ISO: the max `timestamp` over parsed records. mtime only pre-sorts; it never decides. */
  readonly lastActivity: string;
  /** ISO of the first record when it is known; used only by the `--before` self-exclusion. */
  readonly firstActivity: string | null;
}

export interface Extract {
  readonly userRequests: readonly { readonly at: string; readonly text: string }[];
  readonly assistantStatus: { readonly at: string; readonly text: string } | null;
  readonly openTools: readonly { readonly name: string; readonly hint: string }[];
  readonly title: string | null;
}

export interface Limits {
  /** Newest K candidate files per root, by mtime (stat only). */
  readonly k: number;
  /** Extraction window: the whole file up to this size, else its tail. */
  readonly tailBytes: number;
  /** Candidate-listing window (cwd + last activity), tail and head. */
  readonly probeBytes: number;
  /** Absolute epoch ms; listing stops early once it passes. */
  readonly deadlineAt: number;
}

export interface TranscriptAdapter {
  readonly cli: HandoffCli;
  readonly status: AdapterStatus;
  roots(env: Env): readonly string[];
  list(root: string, workspace: string, limits: Limits): TranscriptRef[];
  extract(ref: TranscriptRef, limits: Limits): Extract;
}

/** A store that can be detected but not parsed (agy: protobuf). Stat only, no content. */
export interface Detection {
  readonly store: string;
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

export interface DetectOnlyStore {
  readonly store: string;
  readonly status: "owed";
  detect(env: Env, limits: Limits): Detection | null;
}

export type HandoffOutcome =
  | "written"
  | "composed"
  | "skipped:off"
  | "skipped:no-source"
  | "skipped:no-state-dir"
  | "skipped:unsafe-path"
  | "skipped:invalid-line"
  | "skipped:timeout"
  | "skipped:platform"
  | "skipped:write-error"
  | "skipped:error";

export interface HandoffDelivery {
  readonly cli: HandoffCli;
  readonly content: "system-file" | "first-turn-read" | "none";
  readonly first_turn: "measured" | "owed";
}

/** `<ws>/state/handoff/latest.json` (SPEC §6.4). Closed keys. */
export interface HandoffRecord {
  readonly v: 1;
  readonly boot_id: string;
  readonly written_at: string;
  readonly outcome: HandoffOutcome;
  readonly source: {
    readonly cli: HandoffCli;
    readonly session_id: string;
    readonly path: string;
    readonly bytes: number;
    readonly last_activity: string;
    readonly sha256: string;
  } | null;
  readonly handoff: { readonly sha256: string; readonly bytes: number; readonly lines: number } | null;
  readonly delivery: HandoffDelivery | null;
  readonly warning: string | null;
}

export interface Handoff {
  readonly ref: { readonly file: string; readonly line: string; readonly source: TranscriptRef } | null;
  readonly record: HandoffRecord;
  readonly stderrLine: string;
  readonly markdown: string | null;
}

// ── read-only primitives ────────────────────────────────────────────────────
const POSIX = process.platform !== "win32";
export const READ_FLAGS = fs.constants.O_RDONLY
  | (POSIX ? fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK : 0);

/** lstat that never throws. */
export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** A regular, non-symlink file's stat, or null. */
export function regularFile(p: string): fs.Stats | null {
  const st = lstatOrNull(p);
  return st !== null && st.isFile() && !st.isSymbolicLink() ? st : null;
}

/** A real (non-symlink) directory's entries, capped; [] on any error. */
export function listDir(dir: string, cap = 4096): string[] {
  const st = lstatOrNull(dir);
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) return [];
  let d: fs.Dir | null = null;
  const names: string[] = [];
  try {
    d = fs.opendirSync(dir);
    for (;;) {
      const e = d.readSync();
      if (e === null || names.length >= cap) break;
      names.push(e.name);
    }
  } catch {
    // An unreadable store is an absent store.
  } finally {
    try {
      d?.closeSync();
    } catch {
      // Best effort.
    }
  }
  return names;
}

/**
 * Bounded read of a regular file: the whole file if `size <= max`, else only its last `max`
 * bytes (`fromStart:false`) or its first `max` bytes (`fromStart:true`). `partialHead` says the
 * first line of a tail window is partial and must be dropped. Null on any error.
 */
export function readBounded(
  p: string,
  max: number,
  fromStart = false,
): { text: string; partialHead: boolean; size: number } | null {
  const before = regularFile(p);
  if (before === null) return null;
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, READ_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    const size = st.size;
    const len = Math.min(size, max);
    const start = fromStart ? 0 : size - len;
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, start + off);
      if (n === 0) break;
      off += n;
    }
    return { text: buf.toString("utf8", 0, off), partialHead: start > 0, size };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

/** JSONL records of a bounded window; unparseable and partial lines are skipped, never thrown. */
export function jsonlRecords(p: string, max: number, fromStart = false): Record<string, unknown>[] {
  const read = readBounded(p, max, fromStart);
  if (read === null) return [];
  const lines = read.text.split("\n");
  if (read.partialHead && !fromStart) lines.shift();
  // A head window that stops mid-file ends in a partial line.
  if (fromStart && read.size > max) lines.pop();
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObject(v)) out.push(v);
    } catch {
      // Skip.
    }
  }
  return out;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** ISO string from an ISO string or an epoch (s or ms) number; null if not a time. */
export function isoOf(v: unknown): string | null {
  let ms: number;
  if (typeof v === "string" && v !== "") ms = Date.parse(v);
  else if (typeof v === "number" && Number.isFinite(v)) ms = v > 1e12 ? v : v * 1000;
  else return null;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

export function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export function minIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/** HOME for the stores: HOME, else USERPROFILE (win32), else null (no store is guessed). */
export function homeOf(env: Env): string | null {
  const h = env.HOME || (process.platform === "win32" ? env.USERPROFILE : undefined);
  return h && path.isAbsolute(h) ? h : null;
}

function canon(p: string): string {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r);
  } catch {
    // A recorded cwd that no longer exists is compared as written.
  }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** True when a recorded cwd names the control workspace (realpath'd; case-insensitive on win32). */
export function sameDir(recorded: string, workspace: string): boolean {
  if (recorded === "" || !path.isAbsolute(recorded)) return false;
  return canon(recorded) === canon(workspace);
}

/** Newest `k` paths by mtime from a list of candidate files (stat only). */
export function newestByMtime(files: readonly string[], k: number): { path: string; st: fs.Stats }[] {
  const out: { path: string; st: fs.Stats }[] = [];
  for (const f of files) {
    const st = regularFile(f);
    if (st !== null) out.push({ path: f, st });
  }
  out.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.slice(0, k);
}

/** Whitelisted tool-input fields only; the raw input is never copied (SPEC §3.2). */
export function toolHint(input: unknown): string {
  if (!isObject(input)) return "";
  for (const key of ["description", "file_path", "notebook_path", "absolute_path", "path", "pattern"]) {
    const v = input[key];
    if (typeof v === "string" && v !== "") return v.length > 160 ? `${v.slice(0, 159)}…` : v;
  }
  return "";
}
