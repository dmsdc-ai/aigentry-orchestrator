// ADR §4.8.2 — index lock.
// Spec target: flock(LOCK_EX) on a separate <target>.lock file (POSIX).
// Phase 1 implementation: O_CREAT|O_EXCL polling with PID-based stale detection.
//   Rationale: Node.js core lacks fs.flock(2); Article 17 무의존 (no external deps) wins
//   over a precise flock(2) match. Semantics preserved: writer-exclusive, reader-free.
//   Phase 2 may upgrade to true advisory flock via N-API addon or shell-out.
import { open } from "node:fs/promises";
import * as fs from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 25;

// Per-process monotonic counter for unique lock-staging temp names (#561).
let stagingSeq = 0;

export interface WithIndexLockOptions {
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const pid = Number.parseInt(text.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    if (pid === process.pid) return false; // self-held — caller must wait
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch (err) {
    // ENOENT = racy unlink between EEXIST and read; treat as stale so we retry the open.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquire(lockPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Stage the PID content in a per-acquirer temp, then hard-link it onto lockPath.
  // link(2) is atomic and fails EEXIST if held, so the lock file never exists in a
  // half-created (empty) state. The previous open(O_CREAT|O_EXCL)-then-write left an
  // empty window in which a concurrent waiter read the lock as malformed, swept it as
  // stale, and entered alongside the holder — breaking serialization and colliding on
  // the shared index tmp (`index.json.tmp.__index__.<pid>` → rename ENOENT) (#561).
  // The `.tmp.` infix lets crash-recovery sweep a staging file orphaned by a crash.
  const staging = `${lockPath}.tmp.${process.pid}.${stagingSeq++}`;
  const fh = await open(staging, "w", 0o600);
  try {
    await fh.writeFile(`${process.pid}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    while (true) {
      try {
        await fs.link(staging, lockPath);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (await isStaleLock(lockPath)) {
          try {
            await fs.unlink(lockPath);
          } catch {
            /* another waiter may have swept it — retry */
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `index-lock: timeout (${timeoutMs}ms) acquiring ${lockPath}`,
          );
        }
        await sleep(POLL_INTERVAL_MS);
      }
    }
  } finally {
    try {
      await fs.unlink(staging);
    } catch {
      /* already gone */
    }
  }
}

export async function withIndexLock<T>(
  targetIndexPath: string,
  fn: () => Promise<T>,
  opts: WithIndexLockOptions = {},
): Promise<T> {
  if (process.platform === "win32") {
    throw new Error(
      "index-lock: Windows fallback (LockFileEx) deferred — see ADR §4.8.2 / Migration §6 #14 Phase 2",
    );
  }
  const lockPath = `${targetIndexPath}.lock`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await acquire(lockPath, timeoutMs);
  try {
    return await fn();
  } finally {
    try {
      await fs.unlink(lockPath);
    } catch {
      /* stale-swept by another process — acceptable */
    }
  }
}
