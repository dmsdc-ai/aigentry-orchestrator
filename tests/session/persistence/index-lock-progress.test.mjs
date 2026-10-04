// #1166 r1 supplement (tester-owned, test-only). Complements index-lock-bounded-wait.test.mjs:
// every non-acquiring path — failing sweep, endless "vanished", endless "sweep succeeded"
// — must still reach the deadline, with a scheduling-safe cap on link attempts (no spin).
// Preserved: timeoutMs 0 uncontended + dead reclaim; no unlink on vanished.
// Synthetic fs faults in an owned child; NOT Windows evidence.
// Run: node --test <this> (after tsc; runs against the real dist/src/session/persistence/index-lock.js).
// Optional: INDEX_LOCK_JS=<other compiled index-lock.js> (e.g. pre-fix baseline), IL_BW_LOG_DIR=<dir>.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CHILD = new URL("./fixtures/index-lock-progress-child.mjs", import.meta.url);
const TIMEOUT_MS = 100;
const MAX_SETTLE_MS = 1_000;
const MAX_LINK_ATTEMPTS = 20; // ~8 expected at 25 ms polling; a spin does thousands
const WATCHDOG_MS = 3_000;
// The real tsc output; INDEX_LOCK_JS only re-points the same oracles at another build. No fallback.
const INDEX_LOCK_JS = process.env.INDEX_LOCK_JS
  ? resolve(process.env.INDEX_LOCK_JS)
  : fileURLToPath(new URL("../../../dist/src/session/persistence/index-lock.js", import.meta.url));

const diag = (rec) => `child ${rec.name} pid=${rec.childPid} exit=${rec.exitCode} signal=${rec.signal} ` +
  `watchdog=${rec.watchdogFired} spawnError=${rec.spawnError} INDEX_LOCK_JS=${INDEX_LOCK_JS} stderr=${rec.stderr.trim()}`;

async function run(name, { fault = "none", lockContent = null, timeoutMs = TIMEOUT_MS } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), `il-pg-${name}-`));
  const target = join(root, "index.json");
  try {
    if (lockContent !== null) await fs.writeFile(`${target}.lock`, lockContent);
    const child = fork(CHILD, [target, String(timeoutMs)], {
      env: { ...process.env, INDEX_LOCK_JS, FAULT: fault }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const rec = { name, fault, timeoutMs, childPid: child.pid, lockContent, watchdogFired: false, spawnError: null, stderr: "", hbs: [] };
    child.stderr?.on("data", (d) => { rec.stderr += d; });
    child.on("message", (m) => { if (m.ev === "after") rec.after = m; else if (m.ev === "hb") rec.hbs.push(m); });
    const watchdog = setTimeout(() => { rec.watchdogFired = true; child.kill("SIGKILL"); }, WATCHDOG_MS);
    // Settles once on close (after stdio drained) or on a spawn error with no process;
    // the watchdog bounds the lifetime, so the owned child is always reaped before rm.
    await new Promise((r) => {
      const finish = (code, signal) => {
        if (rec.exitCode !== undefined) return; // settle once
        clearTimeout(watchdog);
        Object.assign(rec, { exitCode: code, signal });
        r();
      };
      child.on("close", finish);
      child.on("error", (err) => {
        rec.spawnError = String(err?.message ?? err);
        if (child.pid === undefined) finish(null, null);
      });
    });
    rec.lastHeartbeat = rec.hbs.at(-1) ?? null;
    delete rec.hbs;
    rec.lockAfter = await fs.readFile(`${target}.lock`, "utf8").catch((e) => e.code);
    if (process.env.IL_BW_LOG_DIR) {
      await fs.writeFile(join(process.env.IL_BW_LOG_DIR, `${name}.json`), JSON.stringify(rec, null, 2) + "\n");
    }
    return rec;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function assertBounded(rec) {
  assert.equal(rec.watchdogFired, false, `still active at ${WATCHDOG_MS}ms: ${JSON.stringify(rec.lastHeartbeat)}`);
  assert.ok(rec.after, `child sent no after-marker: ${diag(rec)}`);
  assert.equal(rec.after?.outcome, "rejected");
  assert.match(rec.after.message, /^index-lock: timeout \(100ms\) acquiring /);
  assert.ok(rec.after.elapsedMs >= TIMEOUT_MS - 5, `settled early at ${rec.after.elapsedMs}ms`);
  assert.ok(rec.after.elapsedMs <= MAX_SETTLE_MS, `settled late at ${rec.after.elapsedMs}ms`);
  assert.ok(rec.after.counts.link <= MAX_LINK_ATTEMPTS, `link attempts ${rec.after.counts.link}`);
  assert.equal(rec.exitCode, 0);
}

test("persistent EACCES on dead-lock sweep: bounded attempts, then timeout", async () => {
  const rec = await run("unlink-eacces", { fault: "unlink-eacces", lockContent: "garbage\n" });
  assertBounded(rec);
  assert.ok(rec.after.counts.unlink <= MAX_LINK_ATTEMPTS);
  assert.equal(rec.lockAfter, "garbage\n");
});

test("endless vanished verdicts cannot skip the deadline, and never unlink", async () => {
  const rec = await run("read-enoent", { fault: "read-enoent", lockContent: "garbage\n" });
  assertBounded(rec);
  assert.equal(rec.after.counts.unlink, 0); // #897: no unlink on vanished
  assert.equal(rec.lockAfter, "garbage\n");
});

for (const fault of ["unlink-noop", "unlink-enoent"]) {
  test(`endless sweep "progress" (${fault}) cannot skip the deadline`, async () => {
    const rec = await run(fault, { fault, lockContent: "garbage\n" });
    assertBounded(rec);
    assert.equal(rec.lockAfter, "garbage\n");
  });
}

test("timeoutMs 0: first uncontended acquisition succeeds", async () => {
  const rec = await run("t0-uncontended", { timeoutMs: 0 });
  assert.equal(rec.watchdogFired, false);
  assert.ok(rec.after, `child sent no after-marker: ${diag(rec)}`);
  assert.equal(rec.after?.outcome, "resolved");
  assert.deepEqual(rec.after.counts, { link: 1, read: 0, unlink: 1 }); // link, then release
  assert.equal(rec.lockAfter, "ENOENT");
});

test("timeoutMs 0: normal dead (malformed) lock is still reclaimed", async () => {
  const rec = await run("t0-dead-reclaim", { timeoutMs: 0, lockContent: "garbage\n" });
  assert.equal(rec.watchdogFired, false);
  assert.ok(rec.after, `child sent no after-marker: ${diag(rec)}`);
  assert.equal(rec.after?.outcome, "resolved");
  assert.deepEqual(rec.after.counts, { link: 2, read: 1, unlink: 2 }); // sweep + release
  assert.equal(rec.lockAfter, "ENOENT");
});
