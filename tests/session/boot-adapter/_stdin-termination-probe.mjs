// #1167 — disposable CI experiment, test infrastructure only (not a product test, not
// part of the 14-case suite). Measures the boundary the win32 driver gate relies on:
// "after kill(<own child pid>, 0) reports ESRCH, a write to that child's stdin pipe fails
// with a peer-closed error". This is an empirical Node pipe check on the exact runner it
// runs on; it is NOT a universal OS proof and it does not cover the end()-only (SS1) path.
//
// Per iteration: spawn process.execPath with a fixed child that exits 0 and never reads
// stdin; in the same tick (as the driver gate does, no event-loop turn) synchronously
// poll kill(child.pid, 0) until ESRCH; then write 5 bytes + end() exactly as the spawner
// does and record the REAL write-callback code. Nothing is synthesized: no fake EPIPE.
// Only the probe's own child pid is ever queried; no other host pids.
//
// argv: [outFile]. Output: one small JSON aggregate (stdout, and outFile if given).
// Exit: win32 -> 0 only if every iteration ended in EPIPE/ECONNRESET, else 1 (HOLD).
//       other OS -> 2, NOT_APPLICABLE, zero iterations. On POSIX this synchronous poll
//       runs without event-loop reaping, so it would keep seeing the unreaped zombie.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";

const N = 1000;
const WALL_MS = 900_000;
const GATE_MS = 5_000; // same bound as the driver gate
const ITER_MS = 15_000;
const MAX_EXAMPLES = 5;
const PAYLOAD = "abcde"; // 5 bytes
const CHILD = "process.exitCode = 0;\n"; // never touches process.stdin
const PEER_CLOSED = ["EPIPE", "ECONNRESET"];
const WIN = process.platform === "win32";
const outFile = process.argv[2];
const t0 = Date.now();

// Mirrors recordedChildrenGone() + the driver's Atomics.wait poll, for one known pid.
function waitOwnChildGone(pid) {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  let lastCode = null;
  for (;;) {
    try { process.kill(pid, 0); lastCode = "ALIVE"; }
    catch (e) {
      if (e.code === "ESRCH") return { gone: true, ms: Date.now() - start, lastCode };
      lastCode = e.code ?? "NO_CODE";
    }
    if (Date.now() - start > GATE_MS) return { gone: false, ms: Date.now() - start, lastCode };
    Atomics.wait(cell, 0, 0, 2);
  }
}

function once(i) {
  return new Promise((resolve) => {
    const rec = { i, spawnError: null, gate: null, gateMs: null, gateLastCode: null, writeReturn: null,
      writableLengthAfterWrite: null, cbCalled: false, cbCode: null, errorEventCodes: [],
      exitCode: null, closed: false, timedOut: false };
    let settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(rec); };
    const maybeDone = () => { if (rec.closed && (rec.cbCalled || rec.spawnError || rec.gate === "timeout")) finish(); };
    const child = spawn(process.execPath, ["-e", CHILD], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      rec.timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* own child only */ }
      for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
      setTimeout(finish, 2_000); // bounded wait for 'close' after forced cleanup
    }, ITER_MS);
    child.on("error", (e) => { rec.spawnError = e.code ?? "NO_CODE"; });
    child.on("close", (code) => { rec.closed = true; rec.exitCode = code; maybeDone(); });
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdin?.on("error", (e) => { rec.errorEventCodes.push(e.code ?? "NO_CODE"); });
    if (child.pid === undefined) return; // spawn failed; 'error' + 'close' follow
    const g = waitOwnChildGone(child.pid);
    rec.gate = g.gone ? "gone" : "timeout";
    rec.gateMs = g.ms;
    rec.gateLastCode = g.lastCode;
    if (!g.gone) { try { child.kill("SIGKILL"); } catch { /* own child only */ } return; }
    rec.writeReturn = child.stdin.write(PAYLOAD, (e) => {
      rec.cbCalled = true;
      rec.cbCode = e ? (e.code ?? "NO_CODE") : null;
      maybeDone();
    });
    rec.writableLengthAfterWrite = child.stdin.writableLength;
    child.stdin.end();
  });
}

function classify(r) {
  if (r.spawnError) return `spawn-error:${r.spawnError}`;
  if (r.gate !== "gone") return "gate-timeout";
  if (r.timedOut || !r.cbCalled) return "timeout";
  if (r.cbCode === null) return "write-success";
  return PEER_CLOSED.includes(r.cbCode) ? "expected" : `other-error:${r.cbCode}`;
}

const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const agg = { outcomes: {}, cbCode: {}, writableLengthAfterWriteByOutcome: {}, errorEventCodes: {}, exitCode: {}, gateLastCode: {} };
const gateMs = [];
const examples = [];
let done = 0;
let wallExceeded = false;

const watchdog = setTimeout(() => { emit("watchdog-fired"); process.exit(1); }, WALL_MS + 60_000);
watchdog.unref();

function emit(note) {
  gateMs.sort((a, b) => a - b);
  const q = (p) => (gateMs.length ? gateMs[Math.min(gateMs.length - 1, Math.floor(p * gateMs.length))] : null);
  const anomalies = done - (agg.outcomes["expected"] ?? 0);
  const complete = done === N && !wallExceeded;
  const verdict = !WIN ? "NOT_APPLICABLE_WIN32_ONLY"
    : complete && anomalies === 0 ? "BOUNDARY_HELD_ON_THIS_RUNNER" : "HOLD_BOUNDARY_INSUFFICIENT";
  const out = {
    probe: "1167-stdin-termination", note, verdict, gating: WIN,
    node: process.version, uv: process.versions.uv, platform: process.platform, arch: process.arch,
    osRelease: os.release(), iterationsPlanned: N, iterationsDone: done, wallExceeded, wallMs: Date.now() - t0,
    anomalies, ...agg, gateMs: { min: q(0), p50: q(0.5), p99: q(0.99), max: gateMs.length ? gateMs[gateMs.length - 1] : null },
    activeResourcesAtEnd: process.getActiveResourcesInfo().filter((x) => x !== "Timeout"),
    anomalyExamples: examples,
  };
  const s = JSON.stringify(out);
  console.log(s);
  if (outFile) writeFileSync(outFile, s + "\n");
  return verdict;
}

for (let i = 0; WIN && i < N; i++) {
  if (Date.now() - t0 > WALL_MS) { wallExceeded = true; break; }
  const r = await once(i);
  done++;
  const c = classify(r);
  inc(agg.outcomes, c);
  inc(agg.cbCode, String(r.cbCode));
  inc(agg.writableLengthAfterWriteByOutcome, `${c}|wl=${r.writableLengthAfterWrite}`);
  inc(agg.errorEventCodes, r.errorEventCodes.join(",") || "none");
  inc(agg.exitCode, String(r.exitCode));
  inc(agg.gateLastCode, String(r.gateLastCode));
  if (r.gateMs !== null) gateMs.push(r.gateMs);
  if (c !== "expected" && examples.length < MAX_EXAMPLES) examples.push({ ...r, outcome: c });
}

const verdict = emit("complete");
process.exitCode = !WIN ? 2 : verdict !== "BOUNDARY_HELD_ON_THIS_RUNNER" ? 1 : 0;
