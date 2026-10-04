// #1166 prototype harness (test-only; not index-lock, no caller adoption).
// withOsLock(carrier, fn, { timeoutMs }) holds an advisory OS lock on a permanent
// carrier file while fn runs. The native addon never waits; this harness polls with one
// deadline and capped backoff. The carrier is never unlinked here.
//
// Honest limits: advisory only (uncooperative processes are not excluded); only the
// final path component is no-follow (parent symlinks are not defended); POSIX identity
// is checked after the lock, Windows identity is pinned by the denied delete-share while
// open; a second handle in the same thread self-conflicts (no reentrancy); a hung live
// holder is ended only by the caller's timeout; local fake roots only.
//
// Test seam: opts.addon replaces the env-loaded addon (e.g. to inject a failing close).
// It is explicit, never a fallback; without it the addon comes from loadOsLock().
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { loadOsLock } from "./oslock-loader.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 5;
const BACKOFF_CAP_MS = 25;

// Cached only after a successful load; a failed load throws again next call.
let envAddon;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(timeoutMs) {
  const err = new Error(`oslock: timeout (${timeoutMs}ms) acquiring carrier`);
  err.code = "EOSLOCK_TIMEOUT";
  return err;
}

// The primary error stays the one thrown; the cleanup failure is kept as evidence.
function attachCleanupError(primary, cleanupErr) {
  try {
    if (primary !== null && (typeof primary === "object" || typeof primary === "function") &&
        Object.isExtensible(primary)) {
      Object.defineProperty(primary, "oslockCleanupError", {
        value: cleanupErr,
        configurable: true,
        writable: true,
      });
      return;
    }
  } catch {
    /* fall through to the warning */
  }
  process.emitWarning(
    `oslock: cleanup failed while another error was pending (${cleanupErr?.code ?? "unknown"})`,
    { code: "EOSLOCK_CLEANUP" },
  );
}

// POSIX: the path must still name the inode we locked (a rename-over is detected).
async function sameCarrier(addon, h, carrier) {
  if (process.platform === "win32") return true;
  let st;
  try {
    st = await lstat(carrier, { bigint: true });
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  const id = addon.identity(h);
  return st.isFile() && String(st.dev) === id.dev && String(st.ino) === id.ino;
}

async function acquire(addon, carrier, deadline, timeoutMs) {
  let delay = BACKOFF_START_MS;
  let h;
  try {
    for (;;) {
      if (h === undefined) h = addon.open(carrier);
      if (addon.tryLock(h)) {
        if (await sameCarrier(addon, h, carrier)) return h;
        // Carrier replaced: drop the stale inode, reopen the path on the next pass.
        const stale = h;
        h = undefined;
        addon.close(stale);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timeoutError(timeoutMs);
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, BACKOFF_CAP_MS);
    }
  } catch (err) {
    if (h !== undefined) {
      try {
        addon.close(h);
      } catch (closeErr) {
        attachCleanupError(err, closeErr);
      }
    }
    throw err;
  }
}

async function runLocked(addon, h, fn) {
  let result;
  try {
    result = await fn();
  } catch (err) {
    try {
      addon.close(h);
    } catch (closeErr) {
      attachCleanupError(err, closeErr);
    }
    throw err;
  }
  addon.close(h); // a failed release is thrown, never reported as success
  return result;
}

export async function withOsLock(carrier, fn, opts = {}) {
  if (typeof carrier !== "string" || !isAbsolute(carrier)) {
    throw new TypeError("oslock: carrier must be an absolute path");
  }
  if (typeof fn !== "function") throw new TypeError("oslock: fn must be a function");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("oslock: timeoutMs must be a finite number >= 0");
  }
  // Load (hash/dlopen/abi) failures throw here, before fn can run.
  const addon = opts.addon ?? (envAddon ??= loadOsLock());
  const deadline = performance.now() + timeoutMs;
  const h = await acquire(addon, carrier, deadline, timeoutMs);
  return runLocked(addon, h, fn);
}
