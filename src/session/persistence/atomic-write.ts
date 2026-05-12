// ADR §4.8.2 — atomic write (POSIX).
//   tmp = <target>.tmp.<sid>.<pid> → write+fsync → rename → fsync(parent dir)
//   On error: unlink tmp + rethrow.
// Windows full parity (ReplaceFileW/MoveFileExW) deferred to Phase 2 — throws.
import { open } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AtomicWriteOptions {
  sessionId: string;
}

function tmpPathFor(target: string, sessionId: string): string {
  return `${target}.tmp.${sessionId}.${process.pid}`;
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
  if (process.platform === "win32") {
    throw new Error(
      "atomic-write: Windows fallback (ReplaceFileW / MoveFileExW) deferred — see ADR §4.8.2 / Migration §6 #14 Phase 2",
    );
  }
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
    await fs.rename(tmp, target);
    await fsyncDirectory(dir);
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
