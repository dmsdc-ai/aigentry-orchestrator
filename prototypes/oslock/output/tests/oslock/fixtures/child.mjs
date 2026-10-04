// #1166 tester fixture: owned child-process roles for primitive.test.mjs (test-only).
// Usage: node child.mjs <role> <json-args>. Output is one JSON object per stdout line,
// written synchronously so nothing is lost on exit. Every role is bounded by selfLimitMs.
// The addon is loaded only through the product loader/harness (OSLOCK_NODE, OSLOCK_SHA256,
// OSLOCK_LOADER, OSLOCK_HARNESS absolute paths supplied by the test).
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const [role, rawArgs] = process.argv.slice(2);
const args = JSON.parse(rawArgs ?? "{}");
const selfLimitMs = args.selfLimitMs ?? 60_000;

function emit(obj) {
  writeSync(1, `${JSON.stringify({ ...obj, pid: process.pid })}\n`);
}

function errInfo(err) {
  return { name: err?.name, code: err?.code, message: String(err?.message ?? err), reason: err?.reason };
}

// Hard bound: a fixture never outlives its limit, whatever the test does.
const limitTimer = setTimeout(() => {
  emit({ type: "self-limit", role });
  process.exit(70);
}, selfLimitMs);

async function loadAddon() {
  const { loadOsLock } = await import(pathToFileURL(process.env.OSLOCK_LOADER).href);
  return loadOsLock();
}

async function harness() {
  return import(pathToFileURL(process.env.OSLOCK_HARNESS).href);
}

function waitStdinEnd() {
  return new Promise((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    process.stdin.resume();
  });
}

function lockNow(addon, carrier, boundMs) {
  const h = addon.open(carrier);
  const until = Date.now() + boundMs;
  while (!addon.tryLock(h)) {
    if (Date.now() > until) throw new Error("fixture: could not lock within bound");
  }
  return h;
}

const roles = {
  // P1: n locked increments; overlap detected by an exclusive-create marker.
  // args.noLock=true is the negative control (same body, no lock) proving the detector works.
  // Without the lock, Windows reports sharing conflicts as fs errors instead of silently
  // losing updates; in the control only, those are counted as detections (ioConflicts).
  async increment() {
    const { withOsLock } = await harness();
    const run = args.noLock ? (_c, fn) => fn() : withOsLock;
    const IO_CONFLICT = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);
    let violations = 0;
    let ioConflicts = 0;
    const t0 = Date.now();
    for (let i = 0; i < args.n; i++) {
      try {
        await run(
          args.carrier,
          async () => {
            let fd;
            try {
              fd = openSync(args.marker, "wx");
            } catch (err) {
              if (err.code !== "EEXIST") throw err;
              violations++;
            }
            const v = Number(readFileSync(args.counter, "utf8"));
            await new Promise((r) => setImmediate(r)); // widen the race window
            writeFileSync(args.counter, String(v + 1));
            if (fd !== undefined) {
              closeSync(fd);
              unlinkSync(args.marker);
            }
          },
          { timeoutMs: args.timeoutMs },
        );
      } catch (err) {
        if (!args.noLock || !IO_CONFLICT.has(err.code)) throw err;
        ioConflicts++;
      }
    }
    emit({ type: "done", n: args.n, violations, ioConflicts, ms: Date.now() - t0 });
  },

  // P4/P5: lock and hold until stdin ends (or SIGKILL / self-limit).
  async hold() {
    const addon = await loadAddon();
    const h = lockNow(addon, args.carrier, 5000);
    emit({ type: "locked", identity: addon.identity(h) });
    await waitStdinEnd();
    addon.close(h);
    emit({ type: "released" });
  },

  // Env termination: lock, then exit without close.
  async "exit-locked"() {
    const addon = await loadAddon();
    lockNow(addon, args.carrier, 5000);
    emit({ type: "locked" });
    process.exit(0);
  },

  // P6: lock, spawn a tracked grandchild that inherits our stdio, then close (or not) and exit.
  async "hold-spawn"() {
    const addon = await loadAddon();
    const h = lockNow(addon, args.carrier, 5000);
    const g = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "grandchild", JSON.stringify({ nonce: args.nonce, selfLimitMs: args.grandLimitMs })],
      { stdio: "inherit" },
    );
    await new Promise((resolve, reject) => {
      g.once("spawn", resolve);
      g.once("error", reject);
    });
    emit({ type: "spawned", gpid: g.pid, nonce: args.nonce });
    if (args.closeFirst) addon.close(h);
    // The grandchild keeps running; the test tracks it through the inherited pipes.
    process.exit(0);
  },

  async grandchild() {
    emit({ type: "grandchild-ready", nonce: args.nonce });
    await waitStdinEnd();
    emit({ type: "grandchild-exit", nonce: args.nonce });
  },

  // FIFO no-hang: open must reject promptly, never block.
  async fifo() {
    const addon = await loadAddon();
    const t0 = Date.now();
    try {
      const h = addon.open(args.path);
      emit({ type: "opened-unexpectedly", ms: Date.now() - t0 });
      addon.close(h);
    } catch (err) {
      emit({ type: "rejected", ms: Date.now() - t0, ...errInfo(err) });
    }
  },

  // Loader double-load / instance-data behaviour, isolated so a crash cannot take the suite.
  async doubleload() {
    const { loadOsLock } = await import(pathToFileURL(process.env.OSLOCK_LOADER).href);
    const a = loadOsLock({ path: args.pathA, sha256: args.sha256 });
    let b;
    let second;
    try {
      b = loadOsLock({ path: args.pathB, sha256: args.sha256 });
      second = { ok: true, distinctObject: a !== b, sameFunctions: a.open === b.open };
    } catch (err) {
      second = { ok: false, ...errInfo(err), cause: errInfo(err.cause) };
    }
    const out = { type: "doubleload", second };
    if (b) {
      const ha = a.open(args.carrier);
      const hb = b.open(args.carrier);
      const cross = {};
      const fns = { tryLock: b.tryLock, unlock: b.unlock, identity: b.identity, close: b.close };
      for (const name of Object.keys(fns)) {
        try {
          fns[name](ha);
          cross[name] = "accepted";
        } catch (err) {
          cross[name] = err.code;
        }
      }
      out.cross = cross;
      out.aLocks = a.tryLock(ha);
      out.bConflicts = b.tryLock(hb) === false;
      a.close(ha);
      out.bAfter = b.tryLock(hb);
      b.close(hb);
    }
    emit(out);
  },

  // P11 harness-level fail-closed: the callback must never run when load fails.
  async "harness-load"() {
    const { withOsLock } = await harness();
    let ran = false;
    try {
      await withOsLock(args.carrier, () => {
        ran = true;
      }, { timeoutMs: 100 });
      emit({ type: "harness-load", ok: true, ran });
    } catch (err) {
      emit({ type: "harness-load", ok: false, ran, ...errInfo(err) });
    }
  },
};

const fn = roles[role];
if (!fn) {
  emit({ type: "error", message: `unknown role ${role}` });
  process.exit(64);
}
try {
  await fn();
} catch (err) {
  emit({ type: "error", ...errInfo(err) });
  process.exitCode = 1;
}
clearTimeout(limitTimer);
