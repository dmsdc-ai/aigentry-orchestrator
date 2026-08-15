// ADR §4.8.2 — index lock.
// Spec target: flock(LOCK_EX) on a separate <target>.lock file (POSIX).
// Phase 1 implementation: O_CREAT|O_EXCL polling with PID-based stale detection.
//   Rationale: Node.js core lacks fs.flock(2); Article 17 무의존 (no external deps) wins
//   over a precise flock(2) match. Semantics preserved: writer-exclusive, reader-free.
//   Phase 2 may upgrade to true advisory flock via N-API addon or shell-out.
import { open } from "node:fs/promises";
import * as fs from "node:fs/promises";

// #901 — Windows is no longer a throw, and it did NOT need a second implementation.
//
// LockFileEx was the spec's Windows target, but node exposes no byte-range locking, so
// the choice was the documented fallback: lockfile-with-timeout. That is exactly what
// acquire() below already is, and every primitive it stands on works on Windows —
// fs.link is CreateHardLinkW (NTFS supports hard links, and fails EEXIST when the name
// is taken, which is the whole basis of the mutual exclusion), and process.kill(pid, 0)
// reports ESRCH for a pid that does not exist. So the arm is the same code, and the
// held/dead/vanished contract #897 landed is preserved by construction rather than by a
// parallel implementation that would have to be kept in step with it.
//
// Two Windows-only hazards are real and are handled:
//   * link and unlink can fail TRANSIENTLY (EPERM/EACCES/EBUSY) while a scanner or the
//     indexer holds a handle. Untreated, a transient EPERM on link is rethrown as a hard
//     failure, and a transient EPERM on RELEASE silently leaks the lock — which is worse
//     than it sounds, because the pid inside it is ours and alive, so every later waiter
//     reads "held" and blocks for its full timeout.
//   * a volume without hard-link support (exFAT, some network shares) fails link with a
//     non-EEXIST error forever. The retry gives up and the error says so, rather than
//     surfacing a bare EPERM that reads like a permissions problem.
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 25;
const WIN32_TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_FS_ATTEMPTS = 10;

// Per-process monotonic counter for unique lock-staging temp names (#561).
let stagingSeq = 0;

export interface WithIndexLockOptions {
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run a filesystem mutation, retrying only the codes Windows uses for momentary
// contention. On POSIX this is a straight pass-through — one call, no retry, no delay —
// so the POSIX behaviour of everything below is unchanged.
async function win32Retry<T>(op: () => Promise<T>): Promise<T> {
  if (process.platform !== "win32") return op();
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!WIN32_TRANSIENT_CODES.has(code) || attempt >= WIN32_FS_ATTEMPTS) throw err;
      await sleep(Math.min(10 * attempt, 100));
    }
  }
}

// #897: "vanished" and "dead" used to be one boolean, and both led to unlink.
// They must not: only a lock positively identified as dead-pid-held may be swept.
//   held    — a live holder (or an unreadable lock we must not touch): wait.
//   dead    — the recorded pid is gone, or the content is malformed: sweep it.
//   vanished— nothing at lockPath any more: there is nothing to sweep, just retry.
type LockVerdict = "held" | "dead" | "vanished";

async function inspectLock(lockPath: string): Promise<LockVerdict> {
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const pid = Number.parseInt(text.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return "dead";
    if (pid === process.pid) return "held"; // self-held — caller must wait
    try {
      process.kill(pid, 0);
      return "held";
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "held";
    }
  } catch (err) {
    // ENOENT = the holder released between our EEXIST and this read.
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "vanished" : "held";
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
        // EEXIST is not in the transient set, so "the lock is held" still comes straight
        // back on the first attempt — the retry only absorbs Windows contention.
        await win32Retry(() => fs.link(staging, lockPath));
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          if (process.platform === "win32" && WIN32_TRANSIENT_CODES.has(code ?? "")) {
            throw new Error(
              `index-lock: could not create ${lockPath} after ${WIN32_FS_ATTEMPTS} attempts (${code}). ` +
                "On Windows that is either sustained scanner/indexer interference, or a volume with no " +
                "hard-link support (exFAT, some network shares) — this lock requires them.",
              { cause: err },
            );
          }
          throw err;
        }
        const verdict = await inspectLock(lockPath);
        // #897: retry the link, and do NOT unlink. The lock is already gone; the
        // unlink that used to run here removed whatever was at lockPath by name —
        // which, once a successor had linked its own lock into that same name in
        // the interval, was the SUCCESSOR's lock. Both then entered the critical
        // section and collided on the shared index tmp
        // (`index.json.tmp.__index__.<pid>` → rename ENOENT), i.e. the very #561
        // symptom the empty-lock-window fix above was meant to have closed.
        if (verdict === "vanished") continue;
        if (verdict === "dead") {
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
  const lockPath = `${targetIndexPath}.lock`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await acquire(lockPath, timeoutMs);
  try {
    return await fn();
  } finally {
    try {
      // Retried on Windows because a dropped release is not a cosmetic leak: the pid in
      // the file is ours and still running, so inspectLock reads "held" for every later
      // waiter and each one blocks its full timeout instead of sweeping it.
      await win32Retry(() => fs.unlink(lockPath));
    } catch {
      /* stale-swept by another process — acceptable */
    }
  }
}
