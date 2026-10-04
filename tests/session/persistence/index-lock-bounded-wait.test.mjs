// #1166 bounded-wait regression (tester-owned, test-only; no product code here).
// Contract under test (index-lock.ts acquire): a waiter given timeoutMs must settle
// (resolve or reject /timeout/) near timeoutMs. The dead-lock path (verdict "dead" →
// unlink → continue) has no deadline check and no sleep; if unlink of <target>.lock
// fails permanently the waiter is expected to spin forever. A parent watchdog — far
// beyond timeoutMs — SIGKILLs only the exact child this test forked.
// Run: node --test <this> (after tsc; runs against the real dist/src/session/persistence/index-lock.js).
// Optional: INDEX_LOCK_JS=<other compiled index-lock.js> (e.g. pre-fix baseline), IL_BW_LOG_DIR=<dir>.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CHILD = new URL("./fixtures/index-lock-bounded-child.mjs", import.meta.url);
const TIMEOUT_MS = 100;
const SLACK_MS = 1_000; // settle bound = TIMEOUT_MS + SLACK_MS
const WATCHDOG_MS = 5_000; // 50x timeoutMs: only fires if the configured deadline is ignored
// The real tsc output; INDEX_LOCK_JS only re-points the same oracles at another build. No fallback.
const INDEX_LOCK_JS = process.env.INDEX_LOCK_JS
  ? resolve(process.env.INDEX_LOCK_JS)
  : fileURLToPath(new URL("../../../dist/src/session/persistence/index-lock.js", import.meta.url));

const diag = (rec) => `child ${rec.mode} pid=${rec.childPid} exit=${rec.exitCode} signal=${rec.signal} ` +
  `watchdog=${rec.watchdogFired} spawnError=${rec.spawnError} INDEX_LOCK_JS=${INDEX_LOCK_JS} stderr=${rec.stderr.trim()}`;

// Every exit path settles `done` exactly once: close (after stdio drained), or a spawn error
// with no process. The watchdog bounds the lifetime, so waitFor() always settles too.
function runChild(mode, target, { inject = false, timeoutMs = TIMEOUT_MS } = {}) {
  const started = performance.now();
  const child = fork(CHILD, [mode, target, String(timeoutMs)], {
    env: { ...process.env, INDEX_LOCK_JS, INJECT_EACCES: inject ? "1" : "0" },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const rec = { mode, inject, timeoutMs, childPid: child.pid, messages: [], stdout: "", stderr: "", watchdogFired: false, spawnError: null };
  const waiters = new Map();
  child.stdout?.on("data", (d) => { rec.stdout += d; });
  child.stderr?.on("data", (d) => { rec.stderr += d; });
  child.on("message", (m) => { rec.messages.push(m); waiters.get(m.ev)?.(m); });
  const watchdog = setTimeout(() => { rec.watchdogFired = true; child.kill("SIGKILL"); }, WATCHDOG_MS);
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      Object.assign(rec, extra, { wallMs: Math.round(performance.now() - started) });
      const hbs = rec.messages.filter((m) => m.ev === "hb");
      rec.after = rec.messages.find((m) => m.ev === "after") ?? null;
      rec.lastHeartbeat = hbs.at(-1) ?? null;
      rec.heartbeatCount = hbs.length;
      rec.messages = rec.messages.filter((m) => m.ev !== "hb").concat(hbs.slice(0, 3), hbs.slice(-3));
      resolve(rec);
    };
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
    child.on("error", (err) => {
      rec.spawnError = String(err?.message ?? err);
      if (child.pid === undefined) finish({ exitCode: null, signal: null }); // never started
    });
  });
  // Resolves on the named IPC marker; rejects (with the child's diagnostics) if it ends first.
  const waitFor = (ev) => new Promise((resolve, reject) => {
    const seen = rec.messages.find((m) => m.ev === ev);
    if (seen) return resolve(seen);
    waiters.set(ev, resolve);
    done.then((r) => reject(new Error(`ended before '${ev}': ${diag(r)}`)));
  });
  return { child, done, waitFor };
}

// Reap an owned child (exact handle only) before its private temp root is removed.
async function reap(handle) {
  if (!handle) return;
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
  await handle.done;
}

async function evidence(name, data) {
  if (!process.env.IL_BW_LOG_DIR) return;
  await fs.writeFile(join(process.env.IL_BW_LOG_DIR, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
}

async function setup(label) {
  const root = await fs.mkdtemp(join(tmpdir(), `il-bw-${label}-`));
  return { root, target: join(root, "index.json") };
}

// A pid from a child THIS test spawned and reaped; never a guessed/foreign pid.
async function reapedPid() {
  const { child, done } = runChild("exit", "unused");
  const rec = await done;
  assert.equal(rec.exitCode, 0, diag(rec));
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" }, "reaped pid was reused; rerun");
  return child.pid;
}

function assertBoundedTimeout(rec) {
  assert.equal(rec.watchdogFired, false, `watchdog fired: waiter still active after ${WATCHDOG_MS}ms ` +
    `(lastHeartbeat=${JSON.stringify(rec.lastHeartbeat)})`);
  assert.ok(rec.after, `child sent no after-marker: ${diag(rec)}`);
  assert.equal(rec.after.outcome, "rejected");
  assert.match(rec.after.message, /timeout/);
  assert.ok(rec.after.elapsedMs <= rec.timeoutMs + SLACK_MS, `settled at ${rec.after.elapsedMs}ms`);
}

for (const kind of ["malformed", "reaped-pid"]) {
  test(`bounded wait: dead (${kind}) lock whose unlink always fails EACCES times out`, async () => {
    const { root, target } = await setup(`eacces-${kind}`);
    try {
      const content = kind === "malformed" ? "garbage\n" : `${await reapedPid()}\n`;
      await fs.writeFile(`${target}.lock`, content);
      const rec = await runChild("waiter", target, { inject: true }).done;
      rec.lockContentAfter = await fs.readFile(`${target}.lock`, "utf8").catch((e) => e.code);
      rec.lockContentBefore = content;
      await evidence(`eacces-${kind}`, rec);
      assertBoundedTimeout(rec);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test(`control: dead (${kind}) lock is reclaimed when unlink works`, async () => {
    const { root, target } = await setup(`ctl-${kind}`);
    try {
      const content = kind === "malformed" ? "garbage\n" : `${await reapedPid()}\n`;
      await fs.writeFile(`${target}.lock`, content);
      const rec = await runChild("waiter", target).done;
      await evidence(`control-${kind}`, rec);
      assert.equal(rec.watchdogFired, false);
      assert.ok(rec.after, `child sent no after-marker: ${diag(rec)}`);
      assert.equal(rec.after?.outcome, "resolved");
      assert.equal(rec.after.value, "entered");
      assert.equal(rec.after.unlinkCount, 2); // one dead-lock sweep + one release
      assert.equal(rec.exitCode, 0);
      await assert.rejects(fs.stat(`${target}.lock`), { code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test("control: live owned holder makes the waiter time out within timeoutMs", async () => {
  const { root, target } = await setup("live");
  let holder;
  let waiterRun;
  try {
    holder = runChild("holder", target, { timeoutMs: 2_000 });
    await holder.waitFor("held"); // bounded by the holder watchdog; rejects if it dies first
    waiterRun = runChild("waiter", target);
    const waiter = await waiterRun.done;
    holder.child.send("release");
    const holderRec = await holder.done;
    await evidence("control-live-holder", { waiter, holder: holderRec });
    assertBoundedTimeout(waiter);
    assert.equal(waiter.after.unlinkCount, 0); // a waiter never touches a live lock
    assert.ok(holderRec.after, `holder sent no after-marker: ${diag(holderRec)}`);
    assert.equal(holderRec.after?.outcome, "resolved");
    assert.equal(holderRec.after.unlinkCount, 1);
    await assert.rejects(fs.stat(`${target}.lock`), { code: "ENOENT" });
  } finally {
    await reap(waiterRun);
    await reap(holder);
    await fs.rm(root, { recursive: true, force: true });
  }
});
