// #1166 bounded-wait fixture child (tester-owned, test-only). Runs the REAL, unchanged
// withIndexLock from the compiled module named by INDEX_LOCK_JS. The only instrumentation
// is the existing index-lock-strict.test.ts convention: wrap fs.unlink and publish it with
// syncBuiltinESMExports. The wrapper counts, and with INJECT_EACCES=1 fails, ONLY calls
// whose path === `${target}.lock`; staging files and every other fs call are untouched.
// argv: <mode: waiter|holder|exit> <target> <timeoutMs>
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [mode, target, timeoutArg] = process.argv.slice(2);
if (mode === "exit") process.exit(0); // only used to obtain an owned, reaped pid

const { withIndexLock } = await import(pathToFileURL(process.env.INDEX_LOCK_JS).href);
const lockPath = `${target}.lock`;
const timeoutMs = Number(timeoutArg);
const inject = process.env.INJECT_EACCES === "1";
const t0 = performance.now();
const elapsed = () => Math.round((performance.now() - t0) * 10) / 10;
let unlinkCount = 0;
const send = (msg) => process.send?.({ ...msg, pid: process.pid, elapsedMs: elapsed(), unlinkCount });

const originalUnlink = fs.unlink;
fs.unlink = async (p) => {
  if (p === lockPath) {
    unlinkCount++;
    if (inject) {
      throw Object.assign(new Error(`EACCES: injected, unlink '${p}'`), {
        code: "EACCES", errno: -13, syscall: "unlink", path: p,
      });
    }
  }
  return originalUnlink(p);
};
syncBuiltinESMExports();

const hb = setInterval(() => send({ ev: "hb" }), 50);
let releaseGate = () => {};
process.on("message", (m) => { if (m === "release") releaseGate(); });

send({ ev: "before", mode, timeoutMs, inject });
try {
  const value = await withIndexLock(target, async () => {
    if (mode === "holder") {
      send({ ev: "held" });
      await new Promise((r) => { releaseGate = r; });
    }
    return "entered";
  }, { timeoutMs });
  send({ ev: "after", outcome: "resolved", value });
} catch (err) {
  send({ ev: "after", outcome: "rejected", message: String(err?.message), code: err?.code ?? null });
}
clearInterval(hb);
process.disconnect?.();
