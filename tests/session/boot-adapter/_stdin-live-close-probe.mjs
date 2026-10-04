// #1167 — disposable win32 boundary experiment, test infrastructure only. It is not a
// product test, not one of the 14 suite cases, and not a fixture adoption. Question: can a
// LIVE child close its own stdin with official stdlib (fs.closeSync(0)) so that the parent's
// later 5-byte write + end() fails with an explicit peer-closed tuple while that child is
// still alive? The earlier probe (0a707ca0) refuted "own pid ESRCH => pipe closed" (14/1000
// write-success). This probe can falsify only the fs.closeSync(0) variant. Any result is a
// measurement on this runner, never a general OS guarantee.
//
// CLOSED variant (1000x): the child calls fs.closeSync(0), never touches process.stdin, then
//   sends MARK and stays alive until the parent sends GO.
// OPEN variant (positive control, 20x interleaved): the child reads stdin to EOF and sends
//   back the exact bytes. They must equal the 5-byte payload, and the write callback must succeed.
// Control channel: Node IPC only (stdio[3] = "ipc"), carrying MARK / READBACK / GO. It is a
//   separate pipe (fd 3); fd 0 is the stdin pipe under test. IPC is event-driven, so neither
//   side polls. While the channel is open it keeps the child's event loop, and so the child,
//   alive. That is how "stay alive until released" works. Timers here are deadlines only; no
//   sleep is used as a closure oracle. Only this probe's own child pids are ever queried
//   (kill(pid, 0)) or terminated.
//
// argv: [receiptFile]. Output: one bounded JSON receipt (stdout, and receiptFile if given).
// Exit: 0 only for OBSERVED_BOUNDARY_CANDIDATE_ON_THIS_RUNNER; 1 for any HOLD / INCOMPLETE;
//       2 for NOT_APPLICABLE on non-win32 (zero iterations, never success).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const N_CLOSED = 1000;
const CONTROL_EVERY = 50; // -> 20 open-reader controls, interleaved
const N_CONTROL = N_CLOSED / CONTROL_EVERY;
const WALL_MS = 180_000;
const STOP_MARGIN_MS = 10_000; // never start an iteration that could overrun the wall
const MARK_MS = 2_000, CB_MS = 1_000, RELEASE_MS = 1_000, KILL_MS = 1_000; // sum = 5 s per iteration
const PAYLOAD = "abcde"; // exactly 5 bytes, written once, never drained or repeated
const PAYLOAD_HEX = Buffer.from(PAYLOAD).toString("hex");
const MAX_EXAMPLES = 3;
const STDERR_CAP = 512;
// Accepted CLOSED tuples: explicit code|errno|syscall (libuv win32 errno values). Every other
// tuple, EOF included, is UNKNOWN and is preserved as a HOLD. Adopting a tuple is a separate decision.
const ACCEPT = ["EPIPE|-4047|write", "ECONNRESET|-4077|write"];

const CHILD_RELEASE = [
  'const safety = setTimeout(() => process.exit(70), 15000);',
  'process.on("message", (m) => { if (m && m.t === "GO") { clearTimeout(safety); process.disconnect(); } });',
  'process.on("disconnect", () => clearTimeout(safety));',
];
const CHILD_CLOSED = [
  ...CHILD_RELEASE,
  'let mark;',
  'try { require("node:fs").closeSync(0); mark = { t: "MARK", v: "closed", ok: true, pid: process.pid }; }',
  'catch (e) { mark = { t: "MARK", v: "closed", ok: false, pid: process.pid, code: e.code ?? null, errno: e.errno ?? null, syscall: e.syscall ?? null }; }',
  'process.send(mark);',
].join("\n");
const CHILD_OPEN = [
  ...CHILD_RELEASE,
  'const chunks = [];',
  'process.stdin.on("data", (c) => chunks.push(c));',
  'process.stdin.on("end", () => process.send({ t: "READBACK", hex: Buffer.concat(chunks).toString("hex") }));',
  'process.send({ t: "MARK", v: "open", ok: true, pid: process.pid });',
].join("\n");

const WIN = process.platform === "win32";
const outFile = process.argv[2];
const t0 = Date.now();
const startedAt = new Date(t0).toISOString();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const live = new Map(); // own pid -> child, until exit AND close are both observed
const tuple = (e) => (e ? `${e.code ?? "NO_CODE"}|${e.errno ?? "NO_ERRNO"}|${e.syscall ?? "NO_SYSCALL"}` : null);
const tupleKey = (t) => (t === undefined ? "NOT_ARRIVED" : t === null ? "SUCCESS" : t);

async function once(variant, i) {
  const s = Date.now();
  const at = () => Date.now() - s;
  const rec = { variant, i, pid: null, spawnError: null, childErrors: [], mark: null, markAt: null, markOk: false,
    extraMessages: 0, readbackMatch: null, readbackBytes: null, readbackAt: null, aliveBeforeWrite: null,
    writeAt: null, writeReturn: null, writableLengthAfterWrite: null, writeThrow: null, endThrow: null,
    writeCbAt: null, writeTuple: undefined, aliveAtWriteCb: null, endCbAt: null, endTuple: undefined, aliveAtEndCb: null,
    errorEvents: [], goAt: null, goError: null, exitAt: null, exitCode: null, exitSignal: null, closeAt: null,
    killAt: null, killAccepted: null, phaseTimeout: null, cleanup: null, stderr: "" };
  // One event-driven waiter at a time; every listener pokes it. The timer is a deadline only.
  let wake = () => {};
  const poke = () => wake();
  const until = (pred, ms) => new Promise((res) => {
    if (pred()) return res(true);
    const timer = setTimeout(() => { wake = () => {}; res(false); }, ms);
    wake = () => { if (pred()) { clearTimeout(timer); wake = () => {}; res(true); } };
  });
  let child;
  try {
    child = spawn(process.execPath, ["-e", variant === "closed" ? CHILD_CLOSED : CHILD_OPEN],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  } catch (e) { rec.spawnError = `throw:${tuple(e)}`; rec.cleanup = "no-process"; return rec; }
  // Own child only. "EXITED_EVENT" wins over kill(pid, 0) so a reused pid is never read as alive.
  const ownAlive = () => {
    if (rec.exitAt !== null) return "EXITED_EVENT";
    try { process.kill(child.pid, 0); return "ALIVE"; } catch (e) { return `KILL0_${e.code ?? "NO_CODE"}`; }
  };
  // All listeners are staged synchronously, before any event can be delivered.
  child.on("error", (e) => { if (rec.childErrors.length < 4) rec.childErrors.push(`${tuple(e)}@${at()}`); poke(); });
  child.on("message", (m) => {
    if (rec.mark === null) { rec.mark = m ?? "EMPTY"; rec.markAt = at(); }
    else if (variant === "open" && rec.readbackAt === null && m?.t === "READBACK" && typeof m.hex === "string") {
      rec.readbackAt = at(); rec.readbackMatch = m.hex === PAYLOAD_HEX; rec.readbackBytes = m.hex.length / 2;
    } else rec.extraMessages++;
    poke();
  });
  child.on("exit", (code, sig) => { rec.exitAt = at(); rec.exitCode = code; rec.exitSignal = sig; poke(); });
  child.on("close", () => { rec.closeAt = at(); poke(); });
  child.stdin?.on("error", (e) => { if (rec.errorEvents.length < 4) rec.errorEvents.push({ tuple: tuple(e), at: at(), alive: ownAlive() }); poke(); });
  child.stdout?.resume();
  child.stderr?.on("data", (d) => { if (rec.stderr.length < STDERR_CAP) rec.stderr += d.toString().slice(0, STDERR_CAP - rec.stderr.length); });
  const exitedAndClosed = () => rec.exitAt !== null && rec.closeAt !== null;
  if (child.pid === undefined) { // spawn failed: no process exists; 'error' + 'close' follow
    rec.spawnError = "NO_PID";
    await until(() => rec.closeAt !== null, KILL_MS);
    rec.cleanup = "no-process";
    return rec;
  }
  rec.pid = child.pid;
  live.set(child.pid, child);

  if (!await until(() => rec.mark !== null || rec.exitAt !== null, MARK_MS)) rec.phaseTimeout = "mark";
  const m = rec.mark;
  rec.markOk = !!m && typeof m === "object" && m.t === "MARK" && m.v === variant && m.ok === true && m.pid === child.pid;
  if (rec.markOk && rec.exitAt === null) {
    rec.aliveBeforeWrite = ownAlive();
    if (rec.aliveBeforeWrite === "ALIVE") {
      rec.writeAt = at();
      try {
        rec.writeReturn = child.stdin.write(PAYLOAD, (e) => { rec.writeCbAt = at(); rec.writeTuple = tuple(e); rec.aliveAtWriteCb = ownAlive(); poke(); });
        rec.writableLengthAfterWrite = child.stdin.writableLength;
      } catch (e) { rec.writeThrow = tuple(e); }
      try { child.stdin.end((e) => { rec.endCbAt = at(); rec.endTuple = tuple(e); rec.aliveAtEndCb = ownAlive(); poke(); }); }
      catch (e) { rec.endThrow = tuple(e); }
      // CLOSED after a write-success does not wait for end(): it may only settle after release.
      const done = variant === "closed"
        ? () => rec.writeTuple !== undefined && (rec.endTuple !== undefined || rec.writeTuple === null)
        : () => rec.writeTuple !== undefined && rec.endTuple !== undefined && rec.readbackAt !== null;
      if (!await until(done, CB_MS)) rec.phaseTimeout = "callbacks";
    }
  }
  // Always release GO, then require the actual exit + close; kill acceptance is never death.
  rec.goAt = at();
  if (child.connected) {
    try { child.send({ t: "GO" }, (e) => { if (e) rec.goError = tuple(e); }); } catch (e) { rec.goError = tuple(e); }
  } else rec.goError = "NOT_CONNECTED";
  let closed = await until(exitedAndClosed, RELEASE_MS);
  if (!closed) {
    rec.killAt = at();
    try { rec.killAccepted = child.kill(); } catch (e) { rec.killAccepted = `throw:${tuple(e)}`; }
    closed = await until(exitedAndClosed, KILL_MS);
  }
  rec.cleanup = closed ? "exited+closed" : "UNCONFIRMED";
  if (closed) live.delete(child.pid);
  else for (const st of [child.stdin, child.stdout, child.stderr]) st?.destroy();
  return rec;
}

function common(r) {
  if (r.spawnError || r.pid === null) return "spawn-error";
  if (r.cleanup !== "exited+closed") return "cleanup-unconfirmed";
  if (r.mark === null) return r.exitAt !== null ? "early-exit-before-mark" : "mark-timeout";
  if (!r.markOk) return r.mark?.t === "MARK" && r.mark?.ok === false ? "closesync-threw" : "malformed-mark";
  if (r.aliveBeforeWrite !== "ALIVE") return "not-alive-before-write";
  if (r.writeThrow || r.endThrow) return "write-or-end-throw";
  if (r.writeTuple === undefined) return "write-cb-not-arrived";
  if (r.exitAt !== null && r.exitAt < r.goAt) return "early-exit-before-release";
  if (r.aliveAtWriteCb !== "ALIVE") return "not-alive-at-write-cb";
  return null;
}
function classify(r) {
  const c = common(r);
  if (c) return c;
  if (r.variant === "open") {
    if (r.writeTuple !== null) return "control-write-error";
    if (r.endTuple !== null) return `control-end-${tupleKey(r.endTuple)}`;
    if (r.readbackAt === null) return "control-readback-missing";
    return r.readbackMatch ? "control-pass" : "control-readback-mismatch";
  }
  // Checked before the end callback: a pending win32 pipe shutdown may hold end() until the
  // reader exits, so a late end callback must never hide a write-success.
  if (r.writeTuple === null) return "write-success";
  if (r.endTuple === undefined) return "end-cb-not-arrived";
  const seen = [r.writeTuple, r.endTuple, ...r.errorEvents.map((e) => e.tuple)].filter((t) => t !== null);
  return seen.every((t) => ACCEPT.includes(t)) ? "accepted-peer-closed" : "unknown-tuple";
}

const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const bucket = () => ({ done: 0, outcomes: {}, writeTuple: {}, endTuple: {}, errorEventTuples: {}, outcomeWriteReturnWl: {},
  aliveAtWriteCb: {}, aliveAtEndCb: {}, exitCode: {}, goError: {}, killUsed: 0, extraMessages: 0, markMs: [], cbMs: [] });
const agg = { closed: bucket(), open: bucket() };
const examples = {};
let writeSuccessAny = 0;
let stop = null;

function record(r) {
  const b = agg[r.variant], c = classify(r);
  b.done++;
  inc(b.outcomes, c);
  inc(b.writeTuple, tupleKey(r.writeTuple));
  inc(b.endTuple, tupleKey(r.endTuple));
  inc(b.errorEventTuples, r.errorEvents.map((e) => e.tuple).join(",") || "none");
  inc(b.outcomeWriteReturnWl, `${c}|ret=${r.writeReturn}|wl=${r.writableLengthAfterWrite}`);
  inc(b.aliveAtWriteCb, String(r.aliveAtWriteCb));
  inc(b.aliveAtEndCb, String(r.aliveAtEndCb));
  inc(b.exitCode, `${r.exitCode}|${r.exitSignal}`);
  inc(b.goError, String(r.goError));
  if (r.killAt !== null) b.killUsed++;
  b.extraMessages += r.extraMessages;
  if (r.markAt !== null) b.markMs.push(r.markAt);
  if (r.writeCbAt !== null) b.cbMs.push(r.writeCbAt - r.writeAt);
  if (r.variant === "closed" && r.writeTuple === null) writeSuccessAny++;
  const key = `${r.variant}:${c}`;
  examples[key] ??= [];
  if (examples[key].length < MAX_EXAMPLES) examples[key].push({ ...r, outcome: c });
  if (c === "spawn-error" || c === "cleanup-unconfirmed") stop ??= `HARNESS_${c}`;
  else if (r.variant === "open" && c !== "control-pass") stop ??= "CONTROL_FAILED";
}

const q = (a) => {
  const s = [...a].sort((x, y) => x - y), p = (f) => (s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : null);
  return { n: s.length, min: p(0), p50: p(0.5), p99: p(0.99), max: s.length ? s[s.length - 1] : null };
};
const resourcesNow = () => process.getActiveResourcesInfo().filter((x) => x !== "Timeout");

function verdictOf(resources) {
  if (!WIN) return "NOT_APPLICABLE_WIN32_ONLY";
  if (stop) return `INCOMPLETE_${stop}`;
  if (live.size || resources.includes("ProcessWrap")) return "INCOMPLETE_CLEANUP_UNCONFIRMED";
  if (agg.closed.done !== N_CLOSED || agg.open.done !== N_CONTROL) return "INCOMPLETE_COUNT";
  if ((agg.open.outcomes["control-pass"] ?? 0) !== N_CONTROL) return "INCOMPLETE_CONTROL_FAILED";
  if (writeSuccessAny > 0) return "HOLD_BOUNDARY_INSUFFICIENT";
  if ((agg.closed.outcomes["unknown-tuple"] ?? 0) > 0) return "HOLD_UNKNOWN_TUPLE_PRESERVED";
  if ((agg.closed.outcomes["accepted-peer-closed"] ?? 0) !== N_CLOSED) return "HOLD_ANOMALY";
  return "OBSERVED_BOUNDARY_CANDIDATE_ON_THIS_RUNNER";
}

function emit(note) {
  const resources = resourcesNow();
  const verdict = verdictOf(resources);
  const summarize = (b) => ({ ...b, markMs: q(b.markMs), cbMs: q(b.cbMs) });
  const out = {
    probe: "1167-stdin-live-close", note, verdict,
    scope: "fs.closeSync(0) closed-while-alive variant on this runner only; not a general OS guarantee, not a product PASS, not fixture adoption",
    holdSignals: { writeSuccessClosed: writeSuccessAny, unknownTupleClosed: agg.closed.outcomes["unknown-tuple"] ?? 0 },
    stop, iterationsPlanned: { closed: N_CLOSED, open: N_CONTROL }, acceptTuples: ACCEPT, payloadBytes: Buffer.byteLength(PAYLOAD),
    meta: { node: process.version, uv: process.versions.uv, v8: process.versions.v8, platform: process.platform, arch: process.arch,
      osRelease: os.release(), osVersion: os.version?.() ?? null, githubSha: process.env.GITHUB_SHA ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null, imageVersion: process.env.ImageVersion ?? null,
      startedAt, endedAt: new Date().toISOString(), wallMs: Date.now() - t0 },
    sourceSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    childSha256: { closed: sha(CHILD_CLOSED), open: sha(CHILD_OPEN) },
    liveOwnChildrenAtEnd: [...live.keys()], activeResourcesAtEnd: resources,
    closed: summarize(agg.closed), open: summarize(agg.open), examples,
  };
  const str = JSON.stringify(out);
  console.log(str);
  if (outFile) writeFileSync(outFile, str + "\n");
  return verdict;
}

// Backstop only: the loop below stops itself STOP_MARGIN_MS before the wall.
const watchdog = setTimeout(() => {
  stop ??= "WATCHDOG";
  for (const c of live.values()) { try { c.kill(); } catch { /* own child only; death not assumed */ } }
  emit("watchdog-fired; live own children above are NOT confirmed exited");
  process.exit(1);
}, WALL_MS);
watchdog.unref();

const wallLeft = () => Date.now() - t0 <= WALL_MS - STOP_MARGIN_MS;
for (let i = 0; WIN && i < N_CLOSED && !stop; i++) {
  if (i % CONTROL_EVERY === 0) {
    if (!wallLeft()) { stop = "WALL_BUDGET"; break; }
    record(await once("open", i / CONTROL_EVERY));
    if (stop) break;
  }
  if (!wallLeft()) { stop = "WALL_BUDGET"; break; }
  record(await once("closed", i));
}

clearTimeout(watchdog);
const verdict = emit("complete");
process.exitCode = !WIN ? 2 : verdict === "OBSERVED_BOUNDARY_CANDIDATE_ON_THIS_RUNNER" ? 0 : 1;
