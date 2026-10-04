// #1166 tester fixture: owned worker_threads roles for primitive.test.mjs (test-only).
// workerData = { role, ...args }. Results are posted to the parent as plain objects.
// The addon is loaded in this worker's own env through the product loader/harness.
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

const args = workerData;

function errInfo(err) {
  return { name: err?.name, code: err?.code, message: String(err?.message ?? err) };
}

async function loadAddon() {
  const { loadOsLock } = await import(pathToFileURL(process.env.OSLOCK_LOADER).href);
  return loadOsLock();
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
  // P2: n locked increments, same carrier/counter/marker scheme as the child fixture.
  async increment() {
    const { withOsLock } = await import(pathToFileURL(process.env.OSLOCK_HARNESS).href);
    let violations = 0;
    const t0 = Date.now();
    for (let i = 0; i < args.n; i++) {
      await withOsLock(
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
          await new Promise((r) => setImmediate(r));
          writeFileSync(args.counter, String(v + 1));
          if (fd !== undefined) {
            closeSync(fd);
            unlinkSync(args.marker);
          }
        },
        { timeoutMs: args.timeoutMs },
      );
    }
    parentPort.postMessage({ type: "done", n: args.n, violations, ms: Date.now() - t0 });
  },

  // P8: lock (plus extra open handles) and stay alive until terminated or told to close.
  async hold() {
    const addon = await loadAddon();
    const extra = [];
    for (let i = 0; i < (args.extraOpen ?? 0); i++) extra.push(addon.open(args.carrier));
    const h = lockNow(addon, args.carrier, 5000);
    globalThis.__oslockKeep = { h, extra };
    parentPort.on("message", (m) => {
      if (m === "close") {
        addon.close(h);
        for (const e of extra) addon.close(e);
        parentPort.postMessage({ type: "released" });
        parentPort.close();
      }
    });
    parentPort.postMessage({ type: "locked" });
  },

  // Env teardown by natural worker exit while LOCKED (handle kept reachable).
  async "hold-exit"() {
    const addon = await loadAddon();
    globalThis.__oslockKeep = lockNow(addon, args.carrier, 5000);
    parentPort.postMessage({ type: "locked" });
  },

  // P7: whatever arrives by postMessage must be rejected as a handle here.
  async "probe-clone"() {
    const addon = await loadAddon();
    parentPort.once("message", (m) => {
      const out = { type: "probe", keys: Object.keys(m?.h ?? {}), results: {} };
      for (const name of ["tryLock", "unlock", "identity", "close"]) {
        try {
          addon[name](m.h);
          out.results[name] = "accepted";
        } catch (err) {
          out.results[name] = err.code;
        }
      }
      parentPort.postMessage(out);
      parentPort.close();
    });
    parentPort.postMessage({ type: "ready" });
  },
};

try {
  await roles[args.role]();
} catch (err) {
  parentPort.postMessage({ type: "error", ...errInfo(err) });
}
