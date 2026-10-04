// #1167 — nodeSpawner() liveness / error-classification / output-ceiling regressions.
// Every scenario runs the REAL nodeSpawner inside an isolated driver subprocess
// (_spawner-lifecycle-driver.js) under an outer SIGKILL watchdog (8 s), so a hang fails
// the test instead of the runner. Hermetic: fake HOME/USERPROFILE/APPDATA, PATH = fixture
// bin dir only, children are pure Node fixture scripts.
//
// Child lifecycle evidence (no ps/pgrep, no pid signalling by the test):
//   - fixture-controlled lifetime: every child self-exits LIFETIME_MS after it starts
//     (> 5 s product bound, < 8 s watchdog), so even a hung product cannot orphan it;
//   - authenticated receipts: start {nonce, pid, ppid}, 100 ms heartbeat, self-exit;
//     nonce is per-fixture random, ppid must be the driver (exact parent);
//   - parent-handle evidence: the driver observes each spawned child's 'exit' event;
//   - after the driver ends, every child pid must answer ESRCH. Missing receipts, an
//     unobserved exit, EPERM or "alive" all FAIL (never an empty pass).
//
// Contract under test (conservative, #1167 brief):
//   - probeVersion is bounded: settles within 5 s (+1 s tolerance) and its direct child
//     is gone after settlement (killed by the spawner, not by the fixture deadline).
//     Error taxonomy for timeout/overflow is NOT asserted.
//   - probeVersion combined stdout+stderr ceiling 1 MiB: over -> rejects; under -> unchanged.
//   - run() spawn errors preserve the actual OS error (code + errno), not a forced ENOENT.
//   - Preserved: semver parse, CLI_NOT_FOUND for nonzero/missing/non-executable probe,
//     run() nonzero exit resolves, run() output is NOT capped in this unit (characterization).
//   - #1167 r1 discriminators: exact 1 MiB allowed / +1 byte rejected, cap counts BYTES
//     (multi-byte), SIGTERM-ignoring child still killed, stdout/stderr alternation is
//     combined and overflow kills a still-running child well before the timeout.
//   - "No partial output on rejected probe" is NOT testable on the public surface:
//     probeVersion replaces every collect() error with a fresh Error("CLI_NOT_FOUND") and
//     collect() is not exported, so no test here claims it.
// The driver spawn spy is HARNESS INSTRUMENTATION; LV0 proves it forwards spawn unchanged.
// Direct child only: no process-tree containment is claimed. Windows (.cmd/.exe, nested
// children) evidence is a separate open gate; POSIX-only tests are labelled [POSIX].
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRIVER = join(import.meta.dirname, "_spawner-lifecycle-driver.js");
const POSIX = process.platform === "win32" ? "POSIX-only: /bin/sh exec wrapper / mode bits; Windows evidence is a separate gate" : false;
const KiB = 1024;
const PROBE_BOUND_MS = 5_000 + 1_000;
const LIFETIME_MS = 6_000;      // child self-exit, measured from the child's own start
const DRIVER_DEADLINE_MS = 7_500;
const WATCHDOG_MS = 8_000;
const GONE_GRACE_MS = 1_000;    // child exit must be observed within this after settlement

const PRELUDE = `{ const fs = require("node:fs"), p = require("node:path"), d = process.env.RECEIPTS;
  const w = (k, o) => fs.writeFileSync(p.join(d, process.pid + "." + k), JSON.stringify(o));
  w("start", { nonce: process.env.FIXTURE_NONCE, pid: process.pid, ppid: process.ppid, t: Date.now() });
  const hb = () => w("hb", { t: Date.now() }); hb(); setInterval(hb, 100).unref();
  setTimeout(() => { w("exit", { reason: "self-exit", t: Date.now() }); process.exit(98); }, ${LIFETIME_MS}).unref(); }\n`;
const JS: Record<string, string> = {
  "hang.cjs": `${PRELUDE}setInterval(() => {}, 1000);\n`,
  "semver.cjs": `${PRELUDE}if (process.argv.includes("--version")) process.stdout.write("fake-cli 1.2.3-beta.1 (build 7)\\n"); else process.exitCode = 9;\n`,
  "version-exit2.cjs": `${PRELUDE}process.stdout.write("9.9.9\\n"); process.exitCode = 2;\n`,
  "flood-over.cjs": `${PRELUDE}process.stdout.write("1.2.3\\n" + "a".repeat(${600 * KiB})); process.stderr.write("b".repeat(${600 * KiB}));\n`,
  "flood-under.cjs": `${PRELUDE}process.stdout.write("1.2.3\\n" + "a".repeat(${256 * KiB})); process.stderr.write("b".repeat(${256 * KiB}));\n`,
  "out-exit4.cjs": `${PRELUDE}process.stdout.write("o4"); process.stderr.write("e4"); process.exitCode = 4;\n`,
  "flood-run.cjs": `${PRELUDE}process.stdout.write("c".repeat(${768 * KiB})); process.stderr.write("d".repeat(${768 * KiB}));\n`,
  "exact.cjs": `${PRELUDE}process.stdout.write("1.2.3\\n" + "a".repeat(${512 * KiB - 6})); process.stderr.write("b".repeat(${512 * KiB}));\n`,
  "exact-plus1.cjs": `${PRELUDE}process.stdout.write("1.2.3\\n" + "a".repeat(${512 * KiB - 6})); process.stderr.write("b".repeat(${512 * KiB + 1}));\n`,
  "multibyte.cjs": `${PRELUDE}process.stdout.write("1.2.3\\n" + "\\u4e16".repeat(350000));\n`,
  "sigterm.cjs": `${PRELUDE}process.on("SIGTERM", () => require("node:fs").writeFileSync(require("node:path").join(process.env.RECEIPTS, process.pid + ".sigterm"), "")); setInterval(() => {}, 1000);\n`,
  "alternate-hang.cjs": `${PRELUDE}const a = "s".repeat(${64 * KiB}), b = "e".repeat(${64 * KiB}); for (let i = 0; i < 10; i++) { process.stdout.write(a); process.stderr.write(b); } setInterval(() => {}, 1000);\n`,
  "echo-args.cjs": `${PRELUDE}process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), marker: process.env.SPY_MARKER }));\n`,
};
const WRAPPED = ["hang", "semver", "version-exit2", "flood-over", "flood-under", "exact", "exact-plus1", "multibyte", "sigterm", "alternate-hang"];

interface Sum { len: number; sha256: string; head: string }
interface Err { isError: boolean; code?: string; errno?: number; syscall?: string; message?: string }
interface Handle { pid?: number; spawned_at: number; exit: { code: number | null; signal: string | null; at: number } | null; harness_kill: boolean }
interface Child { pid: number; start_t: number; last_hb: number; self_exit_t: number | null; sigterm: boolean; handle_exit: NonNullable<Handle["exit"]> }
interface DriverOut {
  scenario: string; driver_pid: number; t0: number; settled_at?: number;
  outcome: "resolved" | "rejected" | "pending" | "unknown-scenario"; elapsed_ms: number;
  value?: Sum | { exit_code: number; stdout: Sum; stderr: Sum };
  error?: Err; raw?: { spawned: boolean; error?: Err };
  handles: Handle[]; children: Child[]; started: number;
}

type Liveness = "gone" | "alive" | "unknown";
function liveness(pid: number): Liveness {
  try { process.kill(pid, 0); return "alive"; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown"; }
}
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJson = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) as { t: number; nonce?: string; pid?: number; ppid?: number } : null);

function drive(t: TestContext, scenario: string, instr = true): DriverOut {
  const root = mkdtempSync(join(tmpdir(), "sl-1167-"));
  const nonce = randomBytes(16).toString("hex");
  const rec = join(root, "receipts");
  try {
    for (const d of ["bin", "receipts", "home", "appdata"]) mkdirSync(join(root, d));
    for (const [n, body] of Object.entries(JS)) writeFileSync(join(root, n), body);
    for (const n of WRAPPED) {
      writeFileSync(join(root, "bin", n), `#!/bin/sh\nexec "${process.execPath}" "${join(root, `${n}.cjs`)}" "$@"\n`, { mode: 0o755 });
    }
    writeFileSync(join(root, "bin", "nonexec"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const r = spawnSync(process.execPath, [DRIVER, scenario, root, String(DRIVER_DEADLINE_MS), ...(instr ? [] : ["noinstr"])], {
      env: { PATH: join(root, "bin"), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
        APPDATA: join(root, "appdata"), RECEIPTS: rec, FIXTURE_NONCE: nonce, TMPDIR: tmpdir() },
      encoding: "utf8", timeout: WATCHDOG_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });

    // Every child that ever started left a start receipt. Wait (never kill) until each is
    // gone; the fixture lifetime bounds this even if the driver was killed by the watchdog.
    const started = readdirSync(rec).filter((f) => f.endsWith(".start")).map((f) => readJson(join(rec, f))!);
    const live = (): Array<[number, Liveness]> => started.map((s) => [s.pid!, liveness(s.pid!)] as [number, Liveness]).filter(([, l]) => l !== "gone");
    const waitUntil = Math.max(Date.now(), ...started.map((s) => s.t + LIFETIME_MS + 1_000));
    while (live().length > 0 && Date.now() < waitUntil) sleep(20);
    assert.deepEqual(live(), [], "fixture child not proven gone (alive, or liveness unavailable)");

    assert.equal(r.error, undefined, `driver did not finish within outer watchdog: ${String(r.error)}`);
    assert.equal(r.signal, null, `driver killed by ${r.signal}`);
    assert.equal(r.status, 0, `driver crashed: exit ${r.status} stderr=${r.stderr.slice(0, 500)}`);
    const out = JSON.parse(r.stdout.trim()) as DriverOut;
    assert.equal(out.scenario, scenario);

    // Authenticated receipt <-> parent handle correspondence; missing evidence fails.
    const spawned = out.handles.filter((h) => h.pid !== undefined);
    for (const s of started) {
      assert.equal(s.nonce, nonce, `receipt ${s.pid} not from this fixture`);
      assert.equal(s.ppid, out.driver_pid, `child ${s.pid} parent is ${s.ppid}, not the driver`);
      if (instr) assert.ok(spawned.some((h) => h.pid === s.pid), `child ${s.pid} has no driver handle`);
    }
    out.started = started.length;
    out.children = !instr ? [] : spawned.map((h) => {
      const s = started.find((x) => x.pid === h.pid);
      assert.ok(s, `handle pid ${h.pid} has no authenticated start receipt`);
      assert.ok(h.exit, `exit of child ${h.pid} not observed by its parent handle`);
      assert.equal(h.harness_kill, false, `child ${h.pid} outlived the driver deadline and was harness-killed`);
      const hb = readJson(join(rec, `${h.pid}.hb`));
      assert.ok(hb, `child ${h.pid} heartbeat receipt missing`);
      return { pid: h.pid!, start_t: s.t, last_hb: hb.t, self_exit_t: readJson(join(rec, `${h.pid}.exit`))?.t ?? null,
        sigterm: existsSync(join(rec, `${h.pid}.sigterm`)), handle_exit: h.exit };
    });
    t.diagnostic(`driver: ${JSON.stringify({ ...out, handles: undefined })}`);
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Short-lived children: exited on their own work, never by the fixture lifetime cap.
function noSelfExit(o: DriverOut): void {
  for (const c of o.children) assert.equal(c.self_exit_t, null, `child ${c.pid} hit the fixture lifetime cap`);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- 1. probeVersion liveness (RED on b81f43c: collect() has no timeout) ----
test("LV1 [POSIX] probeVersion: child ignores --version and never exits -> settles within 5s bound, direct child gone", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-hang");
  assert.equal(o.children.length, 1, "exactly one probe child expected");
  const c = o.children[0]!;
  // Harness validity: the hang child really ran for (nearly) the whole bound.
  assert.ok(c.last_hb >= o.t0 + 4_500, `fixture child stopped heartbeating at +${c.last_hb - o.t0} ms`);
  t.diagnostic(`child: alive_at_5s=${c.last_hb >= o.t0 + 5_000} last_hb=+${c.last_hb - o.t0}ms self_exit=${c.self_exit_t === null ? "none" : `+${c.self_exit_t - o.t0}ms`} handle_exit=${JSON.stringify(c.handle_exit)}`);
  assert.notEqual(o.outcome, "pending", `probeVersion still pending after ${o.elapsed_ms} ms (no bounded timeout)`);
  assert.equal(o.outcome, "rejected", `false success: ${JSON.stringify(o.value)}`);
  assert.ok(o.elapsed_ms <= PROBE_BOUND_MS, `settled after ${o.elapsed_ms} ms > ${PROBE_BOUND_MS} ms`);
  // Acceptance: the spawner (not the fixture deadline) ended the child, promptly.
  assert.equal(c.self_exit_t, null, "probe child ended by its own fixture deadline, not by the spawner");
  assert.notEqual(c.handle_exit.signal, null, `probe child exited by itself (code ${c.handle_exit.code}), not killed`);
  assert.ok(c.handle_exit.at <= o.settled_at! + GONE_GRACE_MS, `child exit observed ${c.handle_exit.at - o.settled_at!} ms after settlement`);
});

// ---- 2. actual OS error preserved (RED on b81f43c: run() forces code=ENOENT) ----
test("LV2a [POSIX] run(): non-executable file rejects with the same code/errno node:child_process observed", { skip: POSIX }, (t) => {
  const o = drive(t, "run-nonexec");
  assert.equal(o.raw?.spawned, false, "precondition: raw spawn of a 0644 file must fail");
  const raw = o.raw!.error!;
  assert.notEqual(raw.code, "ENOENT", `precondition: raw OS error is ${raw.code}, not ENOENT`);
  assert.equal(o.outcome, "rejected");
  assert.equal(o.error!.isError, true);
  assert.equal(o.error!.code, raw.code, `spawner reported ${o.error!.code}, OS reported ${raw.code}`);
  assert.equal(o.error!.errno, raw.errno);
});

test("LV2b [POSIX] run(): missing executable still rejects ENOENT matching the raw OS error", { skip: POSIX }, (t) => {
  const o = drive(t, "run-missing");
  assert.equal(o.raw!.error!.code, "ENOENT");
  assert.equal(o.outcome, "rejected");
  assert.equal(o.error!.code, "ENOENT");
  assert.equal(o.error!.errno, o.raw!.error!.errno);
});

test("LV2c [POSIX] probeVersion: non-executable keeps public CLI_NOT_FOUND", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-nonexec");
  assert.equal(o.outcome, "rejected");
  assert.equal(o.error!.message, "CLI_NOT_FOUND");
});

// ---- 3. output ceiling ----
test("LV3a [POSIX] probeVersion: combined stdout+stderr > 1 MiB (600+600 KiB, exit 0) rejects", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-flood-over");
  noSelfExit(o);
  assert.equal(o.outcome, "rejected", `no output ceiling: resolved ${JSON.stringify(o.value)}`);
  assert.ok(o.children[0]!.handle_exit.at <= o.settled_at! + GONE_GRACE_MS);
});

test("LV3b [POSIX] probeVersion: combined 512 KiB (under ceiling) still returns parsed version", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-flood-under");
  noSelfExit(o);
  assert.equal(o.outcome, "resolved", JSON.stringify(o.error));
  assert.equal((o.value as Sum).head, "1.2.3");
});

test("LV3c CHARACTERIZATION run(): 768+768 KiB output returned whole (run cap must not change without caller analysis)", (t) => {
  const o = drive(t, "run-flood");
  noSelfExit(o);
  assert.equal(o.outcome, "resolved", JSON.stringify(o.error));
  const v = o.value as { exit_code: number; stdout: Sum; stderr: Sum };
  assert.equal(v.exit_code, 0);
  assert.equal(v.stdout.len, 768 * KiB); assert.equal(v.stdout.sha256, sha("c".repeat(768 * KiB)));
  assert.equal(v.stderr.len, 768 * KiB); assert.equal(v.stderr.sha256, sha("d".repeat(768 * KiB)));
});

// ---- 4. preserved behaviour ----
test("LV4a [POSIX] probeVersion: --version success returns the parsed semver unchanged", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-semver");
  noSelfExit(o);
  assert.equal(o.outcome, "resolved", JSON.stringify(o.error));
  assert.equal((o.value as Sum).head, "1.2.3-beta.1");
});

test("LV4b [POSIX] probeVersion: nonzero --version exit keeps CLI_NOT_FOUND", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-nonzero");
  noSelfExit(o);
  assert.equal(o.outcome, "rejected");
  assert.equal(o.error!.message, "CLI_NOT_FOUND");
});

test("LV4c probeVersion: missing executable keeps CLI_NOT_FOUND", (t) => {
  const o = drive(t, "probe-missing");
  assert.equal(o.outcome, "rejected");
  assert.equal(o.error!.message, "CLI_NOT_FOUND");
});

test("LV4d run(): nonzero exit resolves with exit code and stdout/stderr", (t) => {
  const o = drive(t, "run-nonzero");
  noSelfExit(o);
  assert.equal(o.outcome, "resolved", JSON.stringify(o.error));
  const v = o.value as { exit_code: number; stdout: Sum; stderr: Sum };
  assert.equal(v.exit_code, 4); assert.equal(v.stdout.head, "o4"); assert.equal(v.stderr.head, "e4");
});

// ---- 0. harness instrumentation self-check ----
test("LV0 HARNESS INSTRUMENTATION: spawn spy forwards actual spawn unchanged (same argv/cwd/env/output with and without spy)", (t) => {
  const spied = drive(t, "run-echo");
  const plain = drive(t, "run-echo", false);
  for (const o of [spied, plain]) {
    assert.equal(o.outcome, "resolved", JSON.stringify(o.error));
    assert.equal(o.started, 1);
    const v = o.value as { exit_code: number; stdout: Sum; stderr: Sum };
    assert.equal(v.exit_code, 0);
    const echo = JSON.parse(v.stdout.head) as { argv: string[]; cwd: string; marker: string };
    assert.deepEqual(echo.argv, ["a b", "--x=1"]); assert.equal(echo.marker, "m-1167");
    assert.match(echo.cwd, /sl-1167-[^/]+$/, "cwd must be the private fixture dir");
  }
  assert.equal(plain.handles.length, 0, "noinstr mode must not record handles");
  assert.equal(spied.children.length, 1);
  assert.equal(spied.children[0]!.handle_exit.code, 0);
  assert.equal(spied.children[0]!.handle_exit.signal, null);
});

// ---- 5. candidate r1 discriminators ----
test("LV5a [POSIX] probeVersion: combined output exactly 1 MiB (1048576 bytes) is allowed", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-exact-1mib");
  noSelfExit(o);
  assert.equal(o.outcome, "resolved", JSON.stringify(o.error));
  assert.equal((o.value as Sum).head, "1.2.3");
});

test("LV5b [POSIX] probeVersion: combined output 1 MiB + 1 byte rejects", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-1mib-plus1");
  noSelfExit(o);
  assert.equal(o.outcome, "rejected", `ceiling off by one: resolved ${JSON.stringify(o.value)}`);
  assert.ok(o.children[0]!.handle_exit.at <= o.settled_at! + GONE_GRACE_MS);
});

test("LV5c [POSIX] probeVersion: ceiling counts bytes, not chars (350006 chars = 1050006 UTF-8 bytes) rejects", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-multibyte");
  noSelfExit(o);
  assert.equal(o.outcome, "rejected", `cap counted characters: resolved ${JSON.stringify(o.value)}`);
});

test("LV5d [POSIX] probeVersion: child ignoring SIGTERM is still killed within the bound", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-sigterm-ignored");
  assert.equal(o.children.length, 1);
  const c = o.children[0]!;
  assert.ok(c.last_hb >= o.t0 + 4_500, `fixture child stopped heartbeating at +${c.last_hb - o.t0} ms`);
  t.diagnostic(`child: sigterm_seen=${c.sigterm} handle_exit=${JSON.stringify(c.handle_exit)}`);
  assert.equal(o.outcome, "rejected");
  assert.ok(o.elapsed_ms <= PROBE_BOUND_MS, `settled after ${o.elapsed_ms} ms`);
  assert.equal(c.self_exit_t, null, "child survived the spawner and hit its fixture deadline");
  assert.notEqual(c.handle_exit.signal, null);
  assert.ok(c.handle_exit.at <= o.settled_at! + GONE_GRACE_MS, `child exit observed ${c.handle_exit.at - o.settled_at!} ms after settlement`);
});

test("LV5e [POSIX] probeVersion: alternating stdout/stderr (640+640 KiB) then hang -> overflow kills child well before timeout", { skip: POSIX }, (t) => {
  const o = drive(t, "probe-alternate-hang");
  assert.equal(o.children.length, 1);
  const c = o.children[0]!;
  assert.equal(o.outcome, "rejected", `false success: ${JSON.stringify(o.value)}`);
  assert.ok(o.elapsed_ms <= 3_000, `settled after ${o.elapsed_ms} ms: overflow not enforced as combined (timeout fired instead)`);
  assert.equal(c.self_exit_t, null);
  assert.notEqual(c.handle_exit.signal, null, "overflow child not killed");
  assert.ok(c.handle_exit.at <= o.settled_at! + GONE_GRACE_MS);
});
