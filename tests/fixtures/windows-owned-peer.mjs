// Task1167 / release1171 — inert fixture for the Windows owned-process acceptance
// suite (operation nt1167z-v1, session nt1167z-tester).
//
// One file, four roles, selected by --mode. It is deliberately dependency-free and
// self-bounding: every role arms a hard --max-lifetime-ms self-exit so that a case
// which fails to establish ownership can never leave a live process behind on the
// runner. Nothing here reads host credentials, enumerates processes it did not
// itself start, touches the network, or prints an environment value. The only env
// it inspects is the single synthetic marker key it is told to expect, and it
// reports that as a boolean, never as text.
//
//   --mode=payload-root   the owned root the product is asked to launch
//   --mode=descendant     a grandchild of the root, used for tree-cleanup cases
//   --mode=peer           a competing local control-pipe client (H1/H2)
//   --mode=caller-suicide a caller that dies mid-invocation (caller-death case)
//
// The peer role speaks the AIGJOB1 wire protocol exactly as documented in
// owned-job.cc. It implements NO ownership logic: it never creates a job, never
// assigns anything, and never launches a payload. That is the whole point — it
// measures what the caller hands to an unauthenticated connector.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = new Map();
for (const raw of process.argv.slice(2)) {
  if (!raw.startsWith("--")) continue;
  const eq = raw.indexOf("=");
  if (eq === -1) args.set(raw.slice(2), "1");
  else args.set(raw.slice(2, eq), raw.slice(eq + 1));
}
const arg = (name, fallback = null) => (args.has(name) ? args.get(name) : fallback);
const num = (name, fallback) => {
  const v = arg(name, null);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const MODE = arg("mode", "payload-root");
const MAX_LIFETIME_MS = num("max-lifetime-ms", 30_000);

// Hard self-bound. unref() is deliberately NOT used: this timer must be able to
// end the process even when the role would otherwise idle forever.
setTimeout(() => {
  writeJournal({ event: "self-lifetime-exceeded", mode: MODE, maxLifetimeMs: MAX_LIFETIME_MS });
  process.exit(70);
}, MAX_LIFETIME_MS);

function writeJournal(entry) {
  const target = arg("journal", null);
  if (!target) return;
  try {
    fs.appendFileSync(target, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
  } catch { /* the journal is evidence, never a dependency of the case */ }
}

function writeJson(target, value) {
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

// Reports marker delivery as a boolean. The value itself is a per-run synthetic
// hex string and is still never written anywhere by this fixture.
function markerMatch() {
  const key = arg("expect-marker-key", null);
  const value = arg("expect-marker-value", null);
  if (key === null || value === null) return null;
  return process.env[key] === value;
}

// ---------------------------------------------------------------------------
// role: payload-root / descendant
// ---------------------------------------------------------------------------

function roleRoot() {
  const caseId = arg("case", "unknown");
  const pidFile = arg("pid-file", null);
  const reportFile = arg("report-file", null);
  const sleepMs = num("sleep-ms", 0);
  const exitCode = num("exit-code", 0);

  if (pidFile) writeJson(pidFile, { pid: process.pid, role: MODE, case: caseId, at: Date.now() });
  if (reportFile) {
    writeJson(reportFile, {
      role: MODE,
      case: caseId,
      pid: process.pid,
      ppid: process.ppid,
      // Boolean only: proves the caller's intended env crossed the boundary
      // without ever recording the marker text.
      markerMatch: markerMatch(),
      cwd: process.cwd(),
      execPath: process.execPath,
      nodeVersion: process.version,
    });
  }

  let descendant = null;
  if (arg("descendant", null) !== null) {
    // A grandchild that outlives its parent: this is what makes the cleanup
    // oracle meaningful. It is a plain short Node sleep, nothing more.
    descendant = spawn(
      process.execPath,
      [
        process.argv[1],
        "--mode=descendant",
        `--case=${caseId}`,
        `--sleep-ms=${num("descendant-sleep-ms", 20_000)}`,
        `--max-lifetime-ms=${num("descendant-lifetime-ms", 25_000)}`,
        ...(arg("descendant-pid-file", null) ? [`--pid-file=${arg("descendant-pid-file")}`] : []),
        ...(arg("journal", null) ? [`--journal=${arg("journal")}`] : []),
        ...(arg("descendant-hold-pipes", null) !== null ? ["--hold-pipes"] : []),
      ],
      {
        // Inherit: when --descendant-hold-pipes is set the grandchild keeps the
        // root's stdout/stderr write ends open after the root exits, which is the
        // exact condition the broker's bounded drain is supposed to survive.
        stdio: arg("descendant-hold-pipes", null) !== null ? "inherit" : ["ignore", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    descendant.unref?.();
  }

  process.stdout.write(`ROOT-STDOUT ${caseId} ${process.pid}\n`);
  process.stderr.write(`ROOT-STDERR ${caseId} ${process.pid}\n`);

  const finish = () => {
    if (descendant && arg("kill-descendant-on-exit", null) !== null) {
      try { descendant.kill(); } catch { /* already gone */ }
    }
    process.exit(exitCode);
  };
  if (sleepMs > 0) setTimeout(finish, sleepMs);
  else finish();
}

function roleDescendant() {
  const pidFile = arg("pid-file", null);
  if (pidFile) writeJson(pidFile, { pid: process.pid, role: "descendant", at: Date.now() });
  if (arg("hold-pipes", null) !== null) {
    process.stdout.write(`DESCENDANT-STDOUT ${process.pid}\n`);
  }
  setTimeout(() => process.exit(0), num("sleep-ms", 20_000));
}

// ---------------------------------------------------------------------------
// role: peer — competing control-pipe client
// ---------------------------------------------------------------------------

class LineReader {
  constructor() { this.buffer = Buffer.alloc(0); this.waiters = []; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl === -1 || this.waiters.length === 0) break;
      const line = this.buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(nl + 1);
      this.waiters.shift().resolve(line);
    }
  }
  fail(error) { while (this.waiters.length) this.waiters.shift().reject(error); }
  read(timeoutMs) {
    const nl = this.buffer.indexOf(0x0a);
    if (nl !== -1) {
      const line = this.buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(nl + 1);
      return Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`line read timed out after ${timeoutMs}ms`)), timeoutMs);
      this.waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
}

function connectOnce(pipeName, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("connect timed out")); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function connectRacing(pipeName, deadline) {
  let lastError = null;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw lastError ?? new Error("connect deadline expired");
    try {
      return await connectOnce(pipeName, Math.min(remaining, 500));
    } catch (error) {
      lastError = error;
      // ENOENT: the server instance is not listening yet. EBUSY/EPIPE: someone
      // else already holds the single instance — that is a lost race, not an
      // error to retry forever; keep retrying only until the deadline.
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

function readPipeNameFromStdin(timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("pipe name not received on stdin")), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl !== -1) { clearTimeout(timer); resolve(buffer.slice(0, nl).trim()); }
    });
    process.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function rolePeer() {
  // stage: how far this peer drives the protocol.
  //   ident    - connect, HELLO, read IDENT, stop
  //   payload  - ... + claim OWNED, read PAYLOAD, stop            (H1)
  //   complete - ... + fabricate LAUNCHED and EXIT, then vanish   (H2)
  const stage = arg("stage", "payload");
  const reportFile = arg("report-file", null);
  const ioTimeoutMs = num("io-timeout-ms", 4_000);
  const connectBudgetMs = num("connect-budget-ms", 6_000);

  const report = {
    role: "peer",
    stage,
    peerPid: process.pid,
    connected: false,
    connectError: null,
    connectElapsedMs: null,
    helloSent: false,
    identReceived: false,
    identRaw: null,
    callerPid: null,
    callerCreationTime: null,
    // The caller's job handle value as handed to an unauthenticated connector.
    // It is a process-local, already-dead handle number by the time anything
    // reads this file; it is recorded because the disclosure itself is the finding.
    jobHandleValue: null,
    ownedClaimSent: false,
    payloadReceived: false,
    payloadFrameSha256: null,
    payloadKeys: null,
    payloadEnvKeys: null,
    payloadArgsCount: null,
    payloadNodeExeIsAbsolute: null,
    markerKeyPresent: null,
    markerValueMatched: null,
    launchedFabricated: false,
    exitFabricated: false,
    error: null,
  };

  const finish = (code) => {
    if (reportFile) writeJson(reportFile, report);
    writeJournal({ event: "peer-finished", stage, code, connected: report.connected });
    process.exit(code);
  };

  let pipeName = arg("pipe", null);
  try {
    if (pipeName === null || pipeName === "-") {
      // Pre-warm handshake: the harness starts this process before the product
      // invocation exists, then feeds it the pipe name the instant the product
      // discloses it through its own onStarted hook. Announcing readiness first is
      // what removes this process's Node startup cost from the connect race; see
      // the report's note on why that makes the race outcome harness-biased.
      process.stdout.write(`PEER-READY ${process.pid}\n`);
      pipeName = await readPipeNameFromStdin(num("stdin-wait-ms", 15_000));
    }
  } catch (error) {
    report.error = `pipe-name: ${error.message}`;
    finish(64);
    return;
  }

  const startedAt = Date.now();
  let socket;
  try {
    socket = await connectRacing(pipeName, startedAt + connectBudgetMs);
  } catch (error) {
    report.connectError = error.code || error.message;
    report.connectElapsedMs = Date.now() - startedAt;
    finish(65);
    return;
  }
  report.connected = true;
  report.connectElapsedMs = Date.now() - startedAt;

  const reader = new LineReader();
  socket.on("data", (chunk) => reader.push(chunk));
  socket.on("error", (error) => reader.fail(error));
  socket.on("close", () => reader.fail(new Error("control pipe closed")));

  const write = (line) => new Promise((resolve, reject) => {
    socket.write(line, (error) => (error ? reject(error) : resolve()));
  });

  try {
    // A deliberately mismatched identity: this peer announces its OWN pid, which
    // is not the pid of the broker the caller spawned.
    await write(`AIGJOB1 HELLO ${process.pid}\n`);
    report.helloSent = true;

    const ident = await reader.read(ioTimeoutMs);
    report.identRaw = ident;
    const m = /^AIGJOB1 IDENT (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(ident);
    if (m) {
      report.identReceived = true;
      report.callerPid = Number(m[1]);
      report.callerCreationTime = m[2];
      report.jobHandleValue = m[3];
    }
    if (stage === "ident") { finish(0); return; }

    // The empty-job ownership claim: no job was created, nothing was assigned,
    // nothing was duplicated. Only the wire frame is produced.
    await write("AIGJOB1 OWNED 0 1\n");
    report.ownedClaimSent = true;

    const payloadLine = await reader.read(ioTimeoutMs);
    const pm = /^AIGJOB1 PAYLOAD ([A-Za-z0-9+/=]+)$/.exec(payloadLine);
    if (pm) {
      report.payloadReceived = true;
      report.payloadFrameSha256 = crypto.createHash("sha256").update(pm[1]).digest("hex");
      try {
        const frame = JSON.parse(Buffer.from(pm[1], "base64").toString("utf8"));
        report.payloadKeys = Object.keys(frame).sort();
        report.payloadArgsCount = Array.isArray(frame.args) ? frame.args.length : null;
        report.payloadNodeExeIsAbsolute = typeof frame.nodeExe === "string" && path.isAbsolute(frame.nodeExe);
        const env = frame.env && typeof frame.env === "object" ? frame.env : {};
        // Key names only. No env value is copied into the report; the marker is
        // compared and reduced to a boolean.
        report.payloadEnvKeys = Object.keys(env).sort();
        const key = arg("expect-marker-key", null);
        const value = arg("expect-marker-value", null);
        if (key !== null) {
          report.markerKeyPresent = Object.prototype.hasOwnProperty.call(env, key);
          report.markerValueMatched = value !== null && env[key] === value;
        }
      } catch (error) {
        report.error = `payload-decode: ${error.message}`;
      }
    }
    if (stage === "payload") { finish(0); return; }

    // H2: fabricate a completed lifetime for a root that never existed. rootPid 0
    // is a synthetic value; no real process is referenced, started or signalled.
    await write("AIGJOB1 LAUNCHED 0 2\n");
    report.launchedFabricated = true;
    await write("AIGJOB1 EXIT 0 3 0 0 1\n");
    report.exitFabricated = true;

    // Exit promptly: the caller's cleanup oracle corroborates "complete" against
    // the connector's process handle, so this peer must actually be gone.
    socket.end();
    await new Promise((r) => setTimeout(r, 25));
    finish(0);
  } catch (error) {
    report.error = error.message;
    finish(66);
  }
}

// ---------------------------------------------------------------------------
// role: caller-suicide
// ---------------------------------------------------------------------------

async function roleCallerSuicide() {
  const wrapper = arg("wrapper", null);
  const reportFile = arg("report-file", null);
  const rootPidFile = arg("root-pid-file", null);
  const startedFile = arg("started-file", null);
  const killAfterMs = num("kill-after-ms", 1_500);

  const report = { role: "caller-suicide", callerPid: process.pid, brokerPid: null, killed: false, error: null };
  const persist = () => { if (reportFile) writeJson(reportFile, report); };

  if (!wrapper) { report.error = "missing --wrapper"; persist(); process.exit(67); }

  const { run } = await import(pathToFileURL(wrapper).href);

  const payloadArgs = [
    process.argv[1],
    "--mode=payload-root",
    `--case=${arg("case", "caller-death")}`,
    `--sleep-ms=${num("root-sleep-ms", 20_000)}`,
    `--max-lifetime-ms=${num("root-lifetime-ms", 25_000)}`,
    ...(rootPidFile ? [`--pid-file=${rootPidFile}`] : []),
  ];

  const env = Object.create(null);
  for (const key of ["SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "PATHEXT", "COMSPEC"]) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }

  run({
    nodeExe: process.execPath,
    binPath: payloadArgs[0],
    args: payloadArgs.slice(1),
    cwd: arg("cwd", process.cwd()),
    env,
    input: "",
    executionTimeoutMs: num("execution-timeout-ms", 30_000),
    handshakeTimeoutMs: num("handshake-timeout-ms", 5_000),
    onStarted: (started) => {
      report.brokerPid = started.brokerPid ?? null;
      persist();
      if (startedFile) writeJson(startedFile, { brokerPid: report.brokerPid, at: Date.now() });
    },
  }).catch((error) => { report.error = String(error?.message ?? error); persist(); });

  // Abrupt death while the invocation is still in flight. SIGKILL on Windows maps
  // to TerminateProcess, so no JavaScript `finally` runs and the caller's job
  // handle is closed by the OS — which is exactly the condition under test.
  setTimeout(() => {
    report.killed = true;
    persist();
    process.kill(process.pid, "SIGKILL");
  }, killAfterMs);
}

// ---------------------------------------------------------------------------

const roles = {
  "payload-root": roleRoot,
  descendant: roleDescendant,
  peer: rolePeer,
  "caller-suicide": roleCallerSuicide,
};

const role = roles[MODE];
if (!role) {
  process.stderr.write(`unknown --mode=${MODE}\n`);
  process.exit(64);
}
await role();
