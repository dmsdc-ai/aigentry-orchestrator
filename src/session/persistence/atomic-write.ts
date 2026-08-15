// ADR §4.8.2 — atomic write.
//   tmp = <target>.tmp.<sid>.<pid> → write+fsync → rename → fsync(parent dir)
//   On error: unlink tmp + rethrow.
//
// #901 — Windows is no longer a throw. The sequence above is the same on both platforms;
// only two things differ, and both are properties of the OS rather than choices:
//
//   1. rename can fail TRANSIENTLY on Windows. node's fs.rename is MoveFileExW with
//      MOVEFILE_REPLACE_EXISTING, so replacing an existing target is supported — but a
//      virus scanner or the search indexer holding a brief handle on either path surfaces
//      as EPERM/EACCES/EBUSY, and retrying a moment later succeeds. That is the known
//      hazard (U18) and the bounded retry below is the answer to it. It is bounded on
//      purpose: an unbounded retry would convert a permanent failure into a hang.
//   2. the parent-directory fsync has no Windows equivalent. Opening a directory as a
//      file handle needs FILE_FLAG_BACKUP_SEMANTICS, which node:fs does not expose, so
//      the POSIX durability barrier cannot be reproduced and is skipped rather than
//      faked. STATED LIMITATION, not an oversight: on Windows the file CONTENTS are
//      still fsynced before the rename, and NTFS journals the rename metadata itself, so
//      a crash cannot expose a torn file — it can only lose the very last rename. Full
//      parity (ReplaceFileW's write-through flag) still needs native code, ADR §4.8.2.
//
// The POSIX path is byte-identical to what it was: one fs.rename, no retry, dir fsync.
import { open } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AtomicWriteOptions {
  sessionId: string;
}

// Codes Windows reports for "someone else is momentarily touching this path". Anything
// outside this set (ENOENT, EISDIR, ENOSPC, EXDEV…) is a real answer and is rethrown at
// once — retrying those only delays a failure the caller needs to see.
const WIN32_TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
// 10 attempts with a rising, capped backoff — ~450ms of total patience. Long enough to
// outlast a scanner's handle, short enough that a permanent failure is still prompt.
const WIN32_RENAME_ATTEMPTS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpPathFor(target: string, sessionId: string): string {
  return `${target}.tmp.${sessionId}.${process.pid}`;
}

async function renameWithWindowsRetry(
  tmp: string,
  target: string,
): Promise<void> {
  if (process.platform !== "win32") {
    await fs.rename(tmp, target);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!WIN32_TRANSIENT_CODES.has(code) || attempt >= WIN32_RENAME_ATTEMPTS) {
        // Rethrow the ORIGINAL error, not a wrapper: callers and the crash-recovery
        // sweep both branch on .code, and the last failure is the honest one to report.
        throw err;
      }
      await sleep(Math.min(10 * attempt, 100));
    }
  }
}

async function fsyncDirectory(dir: string): Promise<void> {
  // Open the directory for read and fsync it so the rename is durable.
  const dh = await open(dir, "r");
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}

export async function atomicWrite(
  target: string,
  bytes: Uint8Array,
  opts: AtomicWriteOptions,
): Promise<void> {
  if (!opts.sessionId || /[/\\]/.test(opts.sessionId)) {
    throw new Error(
      `atomic-write: invalid sessionId ${JSON.stringify(opts.sessionId)} (non-empty, no path separators)`,
    );
  }
  const dir = path.dirname(target);
  const tmp = tmpPathFor(target, opts.sessionId);

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(tmp, "w", 0o600);
    await fh.writeFile(bytes);
    await fh.sync();
    await fh.close();
    fh = null;
    await renameWithWindowsRetry(tmp, target);
    if (process.platform !== "win32") {
      await fsyncDirectory(dir);
    }
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        /* ignore close-after-error */
      }
    }
    try {
      await fs.unlink(tmp);
    } catch {
      /* tmp may already be gone (e.g., rename succeeded but dir-fsync failed) */
    }
    throw err;
  }
}
