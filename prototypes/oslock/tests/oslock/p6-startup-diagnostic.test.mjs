// #1166 P6 startup diagnostic (tester-owned, diagnostic only). No addon, no lock, no native code.
// Run: node --expose-gc --test-reporter=tap tests/oslock/p6-startup-diagnostic.test.mjs   (cwd ROOT/output)
// Reproduces the primitive.test.mjs P6 launch chain with harmless fake processes
// (fixtures/p6-diag-child.mjs): test -> "hold-spawn" (stdio pipes, default cwd, env process.env)
// -> grandchild (process.execPath <script> grandchild <json>, stdio "inherit"), then classifies
// what the grandchild did from nonce-correlated files only: boot-<pid>.jsonl (written before argv
// parse), p-<nonce>.jsonl (parent) and g-<nonce>.jsonl (grandchild channel).
// Cases (predeclared):
//   primary            ORIGINAL configuration: parent exits right after "spawn". Its pass condition
//                      is asserted separately, so a reproduced failure stays a failure.
//   ctl-ready-first    DATA-ONLY control (changes timing): parent waits for grandchild ready first.
//   ctl-stdio-ignore   DATA-ONLY control (changes handles): grandchild stdio "ignore".
//   neg-*              classifier checks with known outcomes; parent waits so the owned grandchild
//                      exit code is captured.
// Cleanup never signals a grandchild pid: stop file, then a separate teardown file, then passive
// pid-absence observation up to the fixture self-limit. Exit is nonzero on harness malfunction,
// unclassified required evidence, a negative-case mismatch, the primary pass condition failing,
// or any owned grandchild left unaccounted. Results: ROOT/output/logs/p6diag-<ts>.json.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const FIXTURE = join(HERE, "fixtures/p6-diag-child.mjs");
const LOG_DIR = join(ROOT, "output/logs");
const RUN_DIR = join(HERE, ".p6diag", `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
// Fixed impossible executable inside the output root (never created): harness spawn-failure check only.
const MISSING_EXEC = join(HERE, ".p6diag-missing-executable");
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(join(RUN_DIR, "p6-diag-bad-syntax.mjs"), "export const broken = ;\n");
// Same mechanism as primitive.test.mjs OSLOCK_*: set on process.env, inherited down the chain.
process.env.P6DIAG_TRACE_DIR = RUN_DIR;

const PARENT_LIMIT_MS = 10_000; // primitive.test.mjs hold-spawn limitMs
const GRAND_LIMIT_MS = 15_000; // primitive.test.mjs grandLimitMs
const results = { node: process.version, platform: `${process.platform}-${process.arch}`, startedAt: new Date().toISOString(), cases: {} };
const ownedHolds = new Set();
const holdLog = []; // every hold-spawn attempt: observed spawn error / close / exit, never inferred
const ownedGrandchildren = []; // { case, pid, nonce, channel, spawnT, cleanup, accounted }

const CASES = {
  primary: { parentMode: "exit-immediately", stdio: "inherit", script: "self", argvForm: "json", grandMode: "normal", readyMs: 10_000 },
  "ctl-ready-first": { parentMode: "wait-ready", stdio: "inherit", script: "self", argvForm: "json", grandMode: "normal", readyMs: 10_000, waitMs: 8000 },
  "ctl-stdio-ignore": { parentMode: "exit-immediately", stdio: "ignore", script: "self", argvForm: "json", grandMode: "normal", readyMs: 10_000 },
  "neg-path": { parentMode: "wait-ready", stdio: "inherit", script: "missing", argvForm: "json", grandMode: "normal", readyMs: 3000, waitMs: 5000, expect: "no-boot", expectExit: "nonzero" },
  "neg-syntax": { parentMode: "wait-ready", stdio: "inherit", script: "bad-syntax", argvForm: "json", grandMode: "normal", readyMs: 3000, waitMs: 5000, expect: "no-boot", expectExit: "nonzero" },
  "neg-argv": { parentMode: "wait-ready", stdio: "inherit", script: "self", argvForm: "malformed", grandMode: "normal", readyMs: 3000, waitMs: 5000, expect: "argv-parse-failure", expectExit: 65 },
  "neg-early-exit": { parentMode: "wait-ready", stdio: "inherit", script: "self", argvForm: "json", grandMode: "early-exit", readyMs: 3000, waitMs: 5000, expect: "main-exit-before-ready", expectExit: 3 },
  "neg-throw": { parentMode: "wait-ready", stdio: "inherit", script: "self", argvForm: "json", grandMode: "throw", readyMs: 3000, waitMs: 5000, expect: "main-exit-before-ready", expectExit: 1 },
  "neg-no-ready": { parentMode: "wait-ready", stdio: "inherit", script: "self", argvForm: "json", grandMode: "no-ready", readyMs: 1000, waitMs: 1500, expect: "main-alive-no-ready", expectExit: null },
  // ORIGINAL parent mechanics; grandchild self-terminates after ready: no owned exit is observable.
  "neg-vanish": { parentMode: "exit-immediately", stdio: "inherit", script: "self", argvForm: "json", grandMode: "vanish", readyMs: 10_000, expect: "ready-then-vanished-no-exit-record", expectExit: null },
  // Harness-only: hold-spawn executable missing. Neither product failure nor product pass.
  "harness-missing-exec": { executable: "missing", parentMode: "exit-immediately", stdio: "inherit", script: "self", argvForm: "json", grandMode: "normal", readyMs: 10_000 },
};

function readJsonl(file, pred = () => true) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n").slice(0, -1)) {
    try {
      const m = JSON.parse(line);
      if (pred(m)) out.push(m);
    } catch {
      out.push({ type: "unparsed", line: line.slice(0, 200) });
    }
  }
  return out;
}

// Owned hold-spawn child: same spawn call shape as primitive.test.mjs spawnChild.
function spawnHold(args, file = process.execPath) {
  const child = spawn(file, [FIXTURE, "hold-spawn", JSON.stringify({ ...args, selfLimitMs: PARENT_LIMIT_MS })], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  ownedHolds.add(child);
  const h = { child, lines: [], stdout: "", stderr: "", exit: null, close: null, error: null, spawnFailed: false };
  child.stdout.on("data", (d) => {
    h.stdout += d;
    for (const l of h.stdout.split("\n").slice(0, -1)) {
      try {
        const m = JSON.parse(l);
        if (!h.lines.some((x) => JSON.stringify(x) === JSON.stringify(m))) h.lines.push(m);
      } catch {
        /* kept in raw stdout */
      }
    }
  });
  child.stderr.on("data", (d) => {
    h.stderr += d;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), PARENT_LIMIT_MS + 3000); // exact owned handle only
  watchdog.unref();
  child.once("error", (err) => {
    h.error = { code: err?.code ?? null, message: String(err?.message ?? err), t: Date.now() };
    // No pid: no process was created, so there is nothing to own, signal or reap. "exit" never
    // follows (observed: error ENOENT then close(-2) only); close codes are not exit evidence.
    if (child.pid === undefined) {
      h.spawnFailed = true;
      clearTimeout(watchdog);
      ownedHolds.delete(child);
    }
  });
  h.exited = new Promise((res) => {
    child.once("exit", (code, signal) => {
      clearTimeout(watchdog);
      ownedHolds.delete(child);
      h.exit = { code, signal, t: Date.now() };
      res(h.exit);
    });
  });
  h.closed = new Promise((res) => {
    child.once("close", (code, signal) => {
      h.close = { code, signal, t: Date.now() };
      res(h.close);
    });
  });
  return h;
}

async function until(pred, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(20);
  }
}

const isTerminal = (m) => ["process-exit", "main-error", "self-limit", "exit", "teardown-exit"].includes(m.type);

// Bounded cooperative cleanup (same contract as primitive.test.mjs stopGrandchild); never signals.
// Stop/teardown are skipped only when exit was already recorded: the grandchild's own
// process-exit line or the parent's owned-handle "gc-exit" event.
async function stopGrandchild(g, channelOf, ownedExit) {
  const out = { exitLine: false, teardownExit: false, exitedBeforeStop: false, gone: false };
  try {
    out.exitedBeforeStop = channelOf().some((m) => m.type === "process-exit") ? "process-exit-record" : ownedExit() ? "owned-handle-exit" : false;
    if (!out.exitedBeforeStop) {
      out.stopT = Date.now();
      writeFileSync(`${g.channel}.stop`, g.nonce);
      out.exitLine = !!(await until(() => channelOf().some((m) => m.type === "exit"), 5000));
      if (!out.exitLine) {
        writeFileSync(`${g.channel}.teardown`, g.nonce);
        out.teardownExit = !!(await until(() => channelOf().some((m) => m.type === "teardown-exit"), 5000));
      }
    }
    out.gone = !!(await until(() => {
      try {
        process.kill(g.pid, 0); // existence probe only
        return false;
      } catch (err) {
        if (err.code !== "ESRCH") out.probeError = err.code;
        return true;
      }
    }, 3000));
    if (out.probeError) out.gone = false;
  } catch (err) {
    out.error = String(err?.message ?? err);
  }
  return out;
}

function classify(ev) {
  if (ev.harnessError) return "harness-error";
  const boot = new Set(ev.grandBoot.map((m) => m.type));
  const ch = new Set(ev.channel.map((m) => m.type));
  // Only evidence written before the stop request can describe startup; stop-induced exit is not.
  const preStop = ev.channel.filter((m) => !ev.cleanup?.stopT || m.t < ev.cleanup.stopT);
  const pre = new Set(preStop.map((m) => m.type));
  if (!boot.has("boot")) return ev.channel.length ? "unknown:channel-without-boot" : "no-boot";
  if (boot.has("parse-error")) return "argv-parse-failure";
  if (!ch.has("main-start")) return "boot-without-main";
  if (!ch.has("ready")) {
    if (pre.has("process-exit") || pre.has("main-error")) return "main-exit-before-ready";
    if (pre.has("beat")) return "main-alive-no-ready";
    return "unknown:main-start-silent";
  }
  if (ev.aliveAfterParentExit) return "alive-after-parent-exit";
  if (pre.has("process-exit")) return "exited-after-ready";
  if (ev.cleanup.gone && !ch.has("process-exit")) return "ready-then-vanished-no-exit-record";
  return "unknown:ready-then-silent";
}

async function runCase(name) {
  const def = CASES[name];
  const nonce = randomUUID();
  const dir = mkdtempSync(join(RUN_DIR, "r-"));
  const channel = join(dir, `g-${nonce}.jsonl`);
  const parentTrace = join(dir, `p-${nonce}.jsonl`);
  const sent = {
    carrier: join(dir, "carrier"), nonce, channel, closeFirst: true, control: def.grandMode, grandLimitMs: GRAND_LIMIT_MS,
    parentTrace, parentMode: def.parentMode, stdio: def.stdio, script: def.script, argvForm: def.argvForm, grandMode: def.grandMode, waitMs: def.waitMs,
  };
  const ev = { case: name, config: def, nonce };
  results.cases[name] = ev;
  const h = spawnHold(sent, def.executable === "missing" ? MISSING_EXEC : process.execPath);
  let g;
  const channelOf = () => readJsonl(channel, (m) => m.nonce === nonce && m.pid === g?.pid);
  const parentExitRecord = () => readJsonl(parentTrace).find((m) => m.type === "gc-exit" && m.nonce === nonce);
  try {
    // "exit" can precede the last stdout chunk; only a closed pipe or spawn error ends this wait.
    const spawned = await until(() => h.lines.find((m) => m.type === "spawned" && m.nonce === nonce) || (h.close && "closed") || (h.error && "err"), 10_000);
    if (!spawned || typeof spawned === "string") {
      ev.harnessError = `no spawned line (${spawned ?? "timeout"}); exit=${JSON.stringify(h.exit)} error=${JSON.stringify(h.error)}`;
      return ev;
    }
    g = { case: name, pid: spawned.gpid, nonce, channel, spawnT: Date.now() };
    ownedGrandchildren.push(g);
    const bootOf = () => readJsonl(join(RUN_DIR, `boot-${g.pid}.jsonl`));
    // Same readiness bound as P6; stop waiting early only on terminal evidence (observer-side only).
    ev.readyWaitMs = def.readyMs;
    const t0 = Date.now();
    await until(() => channelOf().some((m) => m.type === "ready" || isTerminal(m)) || bootOf().some((m) => m.type === "parse-error") || parentExitRecord(), def.readyMs);
    ev.readyWaitElapsedMs = Date.now() - t0;
    // Bounded: the hold-spawn watchdog fires at PARENT_LIMIT_MS + 3000.
    if (!(await until(() => h.exit || h.spawnFailed, PARENT_LIMIT_MS + 5000))) throw new Error("hold-spawn exit not observed within bound");
    // P6 liveness: like primitive.test.mjs, a new beat after the parent was reaped AND another
    // one after that (its two beatAfter calls, 2000ms each).
    const maxSeq = () => channelOf().reduce((s, m) => (m.type === "beat" && m.seq > s ? m.seq : s), 0);
    const beatAfter = async () => {
      const s = maxSeq();
      return !!(await until(() => maxSeq() > s, 2000));
    };
    ev.beatAfterParentReap = [await beatAfter()];
    if (ev.beatAfterParentReap[0]) ev.beatAfterParentReap.push(await beatAfter());
    ev.aliveAfterParentExit = ev.beatAfterParentReap.length === 2 && ev.beatAfterParentReap[1];
  } catch (err) {
    ev.harnessError = `exception: ${String(err?.stack ?? err)}`;
  } finally {
    if (g) g.cleanup = ev.cleanup = await stopGrandchild(g, channelOf, parentExitRecord);
    await Promise.race([h.closed, sleep(3000)]);
    if (!h.exit && !h.spawnFailed) {
      h.child.kill("SIGKILL"); // exact owned handle, only if the watchdog has not already reaped it
      if (!(await until(() => h.exit, 5000))) ev.lifecycleTimeout = "hold-spawn exit not observed within 5000ms after SIGKILL";
    }
    ev.lifecycle = { pid: h.child.pid ?? null, spawnFailed: h.spawnFailed, spawnError: h.error, close: h.close, exit: h.exit, timeout: ev.lifecycleTimeout ?? null };
    holdLog.push({ case: name, ...ev.lifecycle, owned: ownedHolds.has(h.child) });
    if (ev.lifecycleTimeout) ev.harnessError ??= ev.lifecycleTimeout;
  }
  if (!g) {
    ev.harnessError ??= "no grandchild handle";
    return ev;
  }
  ev.grandchildPid = g.pid;
  ev.holdPid = h.child.pid;
  ev.channel = channelOf();
  ev.foreignPidLines = readJsonl(channel, (m) => m.nonce === nonce && m.pid !== g.pid).length;
  ev.grandBoot = readJsonl(join(RUN_DIR, `boot-${g.pid}.jsonl`));
  ev.parentBoot = readJsonl(join(RUN_DIR, `boot-${h.child.pid}.jsonl`));
  ev.parentTrace = readJsonl(parentTrace, (m) => m.nonce === nonce);
  ev.holdExit = h.exit;
  ev.holdClose = h.close;
  ev.holdStdout = h.stdout.slice(0, 4000);
  ev.holdStderr = h.stderr.slice(0, 4000);
  const sentGrandJson = def.argvForm === "malformed" ? "{not json" : JSON.stringify({
    nonce, channel, carrier: sent.carrier, control: def.grandMode, selfLimitMs: GRAND_LIMIT_MS,
  });
  const bootRec = ev.grandBoot.find((m) => m.type === "boot");
  ev.argvIntact = bootRec ? bootRec.rawArgs === sentGrandJson : null;
  const gcExit = ev.parentTrace.find((m) => m.type === "gc-exit");
  ev.ownedGrandchildExit = gcExit ? { code: gcExit.code, signal: gcExit.signal } : null; // only when the parent outlived it
  const ready = ev.channel.find((m) => m.type === "ready");
  const parentBeforeExit = ev.parentTrace.find((m) => m.type === "before-exit");
  ev.readyBeforeParentExit = ready && parentBeforeExit ? ready.t <= parentBeforeExit.t : ready ? null : false;
  const beats = ev.channel.filter((m) => m.type === "beat");
  ev.beats = { count: beats.length, lastT: beats.at(-1)?.t ?? null, afterParentExit: h.exit ? beats.filter((m) => m.t > h.exit.t).length : null };
  ev.pipeCloseAfterParentExitMs = h.close && h.exit ? h.close.t - h.exit.t : null;
  ev.pipeClosedWhileGrandchildBeating = h.close && beats.length ? beats.some((m) => m.t > h.close.t + 60) : null;
  ev.class = classify(ev);
  const c = ev.cleanup;
  ev.accounting = !c ? "harness-error"
    : c.exitLine && c.gone ? "normal-stop"
      : c.teardownExit && c.gone ? "alternate-teardown"
        : c.exitedBeforeStop && c.gone ? "self-exited-with-record"
          : c.gone && !bootRec ? "never-booted-pid-absent"
            : c.gone ? "pid-absent-without-exit-record"
              : "unconfirmed";
  g.accounted = ev.accounting !== "unconfirmed" && ev.accounting !== "harness-error";
  return ev;
}

function assertEvidenceComplete(ev) {
  assert.equal(ev.harnessError, undefined, `harness: ${ev.harnessError}`);
  const types = ev.parentTrace.map((m) => m.type);
  for (const t of ["before-spawn", "after-spawn-event", "before-exit"]) assert.ok(types.includes(t), `parent trace lacks ${t}: ${types}`);
  assert.equal(ev.holdExit?.code, 0, `hold-spawn exit ${JSON.stringify(ev.holdExit)}`);
  assert.ok(ev.parentBoot.some((m) => m.type === "boot"), "parent boot record");
  assert.ok(!ev.class.startsWith("unknown") && ev.class !== "harness-error", `unclassified: ${ev.class}`);
  assert.notEqual(ev.accounting, "unconfirmed", "grandchild cleanup unconfirmed");
}

test("P6diag primary (ORIGINAL configuration): evidence complete and classified", { timeout: 60_000 }, async () => {
  const ev = await runCase("primary");
  assertEvidenceComplete(ev);
});

test("P6diag primary pass condition: grandchild ready and alive after parent exit (P6 liveness)", () => {
  const ev = results.cases.primary;
  assert.ok(ev, "primary case did not run");
  assert.equal(ev.class, "alive-after-parent-exit", `primary class ${ev.class}`);
  assert.equal(ev.argvIntact, true, "grandchild received argv byte-identical to what was sent");
});

for (const name of ["ctl-ready-first", "ctl-stdio-ignore"]) {
  test(`P6diag ${name} (DATA-ONLY control): evidence complete and classified`, { timeout: 60_000 }, async () => {
    assertEvidenceComplete(await runCase(name));
  });
}

for (const name of Object.keys(CASES).filter((n) => n.startsWith("neg-"))) {
  test(`P6diag ${name}: classified as ${CASES[name].expect}`, { timeout: 60_000 }, async () => {
    const ev = await runCase(name);
    assertEvidenceComplete(ev);
    assert.equal(ev.class, CASES[name].expect);
    const want = CASES[name].expectExit;
    if (want === "nonzero") assert.ok(ev.ownedGrandchildExit && ev.ownedGrandchildExit.code !== 0, `owned exit ${JSON.stringify(ev.ownedGrandchildExit)}`);
    else if (want !== null) assert.equal(ev.ownedGrandchildExit?.code, want, `owned exit ${JSON.stringify(ev.ownedGrandchildExit)}`);
    // Malformed argv is still delivered byte-identical; the failure is the parse, not the transport.
    if (CASES[name].expect !== "no-boot") assert.equal(ev.argvIntact, true);
  });
}

test("P6diag harness: missing hold-spawn executable settles within a bound (spawn error, no fabricated exit)", { timeout: 30_000 }, async () => {
  assert.equal(existsSync(MISSING_EXEC), false, "fixed missing executable must not exist");
  const BOUND_MS = 15_000;
  const bound = new AbortController(); // cancelled once settled so the bound timer cannot hold the run open
  const ev = await Promise.race([runCase("harness-missing-exec"), sleep(BOUND_MS, null, { signal: bound.signal }).then(() => null, () => null)]);
  bound.abort();
  assert.ok(ev, `runCase did not settle within ${BOUND_MS}ms`);
  assert.equal(ev.lifecycle.spawnFailed, true, "spawn failure observed");
  assert.equal(ev.lifecycle.spawnError?.code, "ENOENT");
  assert.equal(ev.lifecycle.pid, null, "no process created");
  assert.equal(ev.lifecycle.exit, null, "no exit evidence fabricated");
  assert.equal(ev.lifecycle.timeout, null);
  assert.match(ev.harnessError, /no spawned line/);
  assert.equal(ev.class, undefined, "never classified as a product outcome");
  assert.equal(ownedGrandchildren.some((g) => g.case === "harness-missing-exec"), false);
});

test("P6diag ownership accounting: every owned grandchild accounted, every hold-spawn reaped", { timeout: GRAND_LIMIT_MS + 15_000 }, async () => {
  for (const g of ownedGrandchildren.filter((x) => !x.accounted)) {
    // Passive only: wait for pid absence up to the grandchild self-limit plus margin.
    g.lateGone = !!(await until(() => {
      try {
        process.kill(g.pid, 0);
        return false;
      } catch (err) {
        return err.code === "ESRCH";
      }
    }, Math.max(0, g.spawnT + GRAND_LIMIT_MS + 3000 - Date.now())));
  }
  results.accounting = {
    holdsAlive: ownedHolds.size,
    holds: holdLog,
    grandchildren: ownedGrandchildren.map((g) => ({ case: g.case, pid: g.pid, accounted: g.accounted, lateGone: g.lateGone })),
  };
  assert.equal(ownedHolds.size, 0, "hold-spawn processes not reaped");
  for (const x of holdLog) assert.ok(x.spawnFailed || x.exit, `hold-spawn (${x.case}) has neither observed exit nor observed spawn failure`);
  for (const g of ownedGrandchildren) assert.ok(g.accounted || g.lateGone, `grandchild ${g.pid} (${g.case}) unaccounted`);
  assert.equal(ownedGrandchildren.length, Object.keys(results.cases).filter((n) => !n.startsWith("harness-")).length, "one grandchild per product-shape case");
});

after(() => {
  const p = results.cases;
  results.derived = {
    classes: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.class ?? `harness-error: ${v.harnessError ?? "none"}`.slice(0, 120)])),
    primaryFails: p.primary ? p.primary.class !== "alive-after-parent-exit" : null,
    readyFirstAlive: p["ctl-ready-first"] ? p["ctl-ready-first"].class === "alive-after-parent-exit" : null,
    stdioIgnoreAlive: p["ctl-stdio-ignore"] ? p["ctl-stdio-ignore"].class === "alive-after-parent-exit" : null,
  };
  results.finishedAt = new Date().toISOString();
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(join(LOG_DIR, `p6diag-${process.platform}-${Date.now()}.json`), `${JSON.stringify(results, null, 2)}\n`);
  // Trace files are embedded above; keep the directory if anything is still unaccounted.
  if (ownedHolds.size === 0 && ownedGrandchildren.every((g) => g.accounted || g.lateGone)) rmSync(RUN_DIR, { recursive: true, force: true });
});
