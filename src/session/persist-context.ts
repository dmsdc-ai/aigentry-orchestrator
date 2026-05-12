// ADR-MF #5 — persist immutable SessionContext snapshot at spawn time.
// Binds the #14 persistence primitives (canonical-bytes, atomic-write, index-lock,
// crash-recovery) into the policy layer described in SPEC §3-§6.
// SPEC: docs/specs/2026-05-12-context-persist.md
// Constitution: Article 17 무의존 (node stdlib + #14 only); Rule 29 외과적 변경
//   (no edits to src/session/persistence/*.ts; #99/#103 untouched).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionContext } from "./types.js";
import {
  atomicWrite,
  canonicalBytes,
  canonicalTimestamp,
  sha256Hex,
  sweepIncompleteWrites,
  withIndexLock,
  type RecoveryReport,
} from "./persistence/index.js";

export type { RecoveryReport };

/** Filesystem layout per ADR §4.8.1. `sessionsRoot` MUST be POSIX-absolute. */
export interface PathConfig {
  sessionsRoot: string;
  /** Defaults to `<sessionsRoot>/index.json`. */
  indexPath?: string;
  /** Defaults to `<sessionsRoot>/.recovery.log`. */
  recoveryLogPath?: string;
}

export interface PersistResult {
  /** Absolute path to the written `context.json`. */
  path: string;
  /** Canonical-bytes (sorted-key UTF-8 NFC LF) sha256. */
  sha256: string;
  /**
   * Wall-clock when the persist op finished. Distinct from
   * `SessionContext.created_at` — `created_at` is the logical session creation
   * (set by the spawn gate; may pre-date the persist if the gate buffers);
   * `timestamp` is the I/O event.
   */
  timestamp: string;
  /** True iff a byte-identical snapshot already existed (idempotent retry). */
  alreadyPersisted: boolean;
}

export type PersistErrorCode =
  | "MUTATION_BLOCKED"
  | "ERR_INVALID_SESSION_ID"
  | "ERR_INVALID_CONTEXT"
  | "ERR_DIGEST_MISMATCH"
  | "ERR_INDEX_CORRUPT"
  | "ERR_IO";

export class PersistError extends Error {
  readonly code: PersistErrorCode;
  readonly detail: string;
  constructor(code: PersistErrorCode, detail: string, cause?: unknown) {
    super(`${code}: ${detail}`);
    this.name = "PersistError";
    this.code = code;
    this.detail = detail;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

interface IndexEntry {
  id: string;
  path: string;
  parent_id: string | null;
  created_at: string;
  sha256: string;
}
interface IndexFile {
  schema_version: 1;
  sessions: IndexEntry[];
}

const INDEX_LOCK_SID = "__index__";
const SESSION_ID_FORBIDDEN = /[\\/]|^\.|\.\.|\u0000/;

/**
 * `sessionsRoot` from `AIGENTRY_SESSIONS_ROOT` env, else
 * `<homedir>/.aigentry/sessions`. Realpath-resolved when it already exists.
 */
export function defaultPathConfig(): PathConfig {
  const env = process.env["AIGENTRY_SESSIONS_ROOT"];
  const raw = env && env.length > 0 ? env : path.join(os.homedir(), ".aigentry", "sessions");
  const abs = path.resolve(raw);
  let resolved = abs;
  try {
    resolved = realpathSync(abs);
  } catch {
    /* not yet created — pass through */
  }
  return { sessionsRoot: resolved };
}

const indexPathOf = (p: PathConfig): string =>
  p.indexPath ?? path.join(p.sessionsRoot, "index.json");
const recoveryLogPathOf = (p: PathConfig): string =>
  p.recoveryLogPath ?? path.join(p.sessionsRoot, ".recovery.log");
const snapshotDir = (p: PathConfig, sid: string): string =>
  path.join(p.sessionsRoot, sid);
const snapshotTarget = (p: PathConfig, sid: string): string =>
  path.join(snapshotDir(p, sid), "context.json");

function validateSessionId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || SESSION_ID_FORBIDDEN.test(id)) {
    throw new PersistError(
      "ERR_INVALID_SESSION_ID",
      `session_id ${JSON.stringify(id)} must be non-empty and free of "/", "\\", "..", leading "." or NUL`,
    );
  }
}

function validateContext(ctx: SessionContext): void {
  validateSessionId(ctx.session_id);
  const required: ReadonlyArray<keyof SessionContext> = [
    "role",
    "cwd",
    "task_id",
    "created_at",
    "effective_prompt_digest",
    "effective_prompt_path",
  ];
  for (const k of required) {
    const v = ctx[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new PersistError(
        "ERR_INVALID_CONTEXT",
        `SessionContext.${String(k)} must be a non-empty string`,
      );
    }
  }
  if (!Array.isArray(ctx.layers) || ctx.layers.length === 0) {
    throw new PersistError(
      "ERR_INVALID_CONTEXT",
      "SessionContext.layers must be a non-empty array",
    );
  }
}

async function readIndex(indexPath: string): Promise<IndexFile> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 1, sessions: [] };
    }
    throw new PersistError("ERR_IO", `failed to read ${indexPath}`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PersistError("ERR_INDEX_CORRUPT", `${indexPath} is not valid JSON`, err);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schema_version?: unknown }).schema_version !== 1 ||
    !Array.isArray((parsed as { sessions?: unknown }).sessions)
  ) {
    throw new PersistError(
      "ERR_INDEX_CORRUPT",
      `${indexPath} does not match IndexFile schema (schema_version=1, sessions[])`,
    );
  }
  return parsed as IndexFile;
}

async function writeIndex(indexPath: string, idx: IndexFile): Promise<void> {
  idx.sessions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await atomicWrite(indexPath, canonicalBytes(idx), { sessionId: INDEX_LOCK_SID });
}

async function updateIndex(paths: PathConfig, entry: IndexEntry): Promise<void> {
  const idxPath = indexPathOf(paths);
  const idx = await readIndex(idxPath);
  const existing = idx.sessions.find((e) => e.id === entry.id);
  if (existing) {
    if (existing.sha256 !== entry.sha256) {
      throw new PersistError(
        "MUTATION_BLOCKED",
        `index entry session_id=${entry.id} sha256=${existing.sha256} ≠ proposed sha256=${entry.sha256}`,
      );
    }
    return;
  }
  idx.sessions.push(entry);
  await writeIndex(idxPath, idx);
}

export async function persistContext(
  ctx: SessionContext,
  paths: PathConfig,
): Promise<PersistResult> {
  validateContext(ctx);
  await fs.mkdir(snapshotDir(paths, ctx.session_id), { recursive: true, mode: 0o700 });

  const bytes = canonicalBytes(ctx);
  const sha256 = sha256Hex(bytes);
  const target = snapshotTarget(paths, ctx.session_id);

  // The index lock serializes concurrent persist ops on this host. SPEC §7
  // accepts ≤10 spawns/s; this also closes the existsSync→atomicWrite TOCTOU
  // window so two persists with the same session_id cannot collide on the
  // shared tmp path (`<target>.tmp.<sid>.<pid>`).
  return withIndexLock(indexPathOf(paths), async () => {
    if (existsSync(target)) {
      const existingSha = sha256Hex(canonicalBytes(JSON.parse(readFileSync(target, "utf8"))));
      if (existingSha === sha256) {
        return { path: target, sha256, timestamp: canonicalTimestamp(new Date()), alreadyPersisted: true };
      }
      throw new PersistError(
        "MUTATION_BLOCKED",
        `session_id=${ctx.session_id} existing sha256=${existingSha} new sha256=${sha256}`,
      );
    }

    await atomicWrite(target, bytes, { sessionId: ctx.session_id });

    const entry: IndexEntry = {
      id: ctx.session_id,
      path: realpathSync(target),
      parent_id: ctx.parent_id ?? null,
      created_at: ctx.created_at,
      sha256,
    };
    // TODO(orphan-snapshot): if updateIndex throws after atomicWrite succeeds,
    // context.json is on disk without an index entry — Q-OPEN-5 GC will reconcile.
    await updateIndex(paths, entry);

    return { path: target, sha256, timestamp: canonicalTimestamp(new Date()), alreadyPersisted: false };
  });
}

export async function loadContext(
  sessionId: string,
  paths: PathConfig,
): Promise<SessionContext | null> {
  validateSessionId(sessionId);
  const target = snapshotTarget(paths, sessionId);
  if (!existsSync(target)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (err) {
    throw new PersistError("ERR_DIGEST_MISMATCH", `${target} is not valid JSON`, err);
  }
  const recomputed = sha256Hex(canonicalBytes(parsed));

  const expected = await withIndexLock(indexPathOf(paths), async () => {
    const idx = await readIndex(indexPathOf(paths));
    return idx.sessions.find((e) => e.id === sessionId);
  });
  if (!expected) {
    throw new PersistError(
      "ERR_INDEX_CORRUPT",
      `session_id=${sessionId} directory exists but no index entry`,
    );
  }
  if (recomputed !== expected.sha256) {
    throw new PersistError(
      "ERR_DIGEST_MISMATCH",
      `session_id=${sessionId} on-disk sha256=${recomputed} ≠ index sha256=${expected.sha256}`,
    );
  }
  return parsed as SessionContext;
}

export async function recoverCrashedWrites(paths: PathConfig): Promise<RecoveryReport> {
  const report = await sweepIncompleteWrites(paths.sessionsRoot);
  if (report.deleted.length > 0 || report.errors.length > 0) {
    const line =
      JSON.stringify({
        ts: canonicalTimestamp(new Date()),
        scanned: report.scanned,
        deleted: report.deleted,
        errors: report.errors,
      }) + "\n";
    await fs.mkdir(paths.sessionsRoot, { recursive: true, mode: 0o700 });
    await fs.appendFile(recoveryLogPathOf(paths), line);
  }
  return report;
}
