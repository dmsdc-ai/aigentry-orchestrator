#!/usr/bin/env node
// Multi-call fake + tracing passthrough for tests/report/mandatory-report-1170*.test.mjs
// (#1170). Role = basename(argv[1]).
//   FAKE roles (external OS/telepty actuators, never real): telepty | cmux | ps | wh-cli.sh | curl | git
//   PASSTHROUGH roles (REAL code, traced): every key of scenario.passthrough
//     (dispatch-registry.py, dispatch-tracker.sh, session-probe.py, policy.py) → exec real path.
//   DRIVER role prepare-sandbox: the REAL compiled prepareWorkerSandbox with explicit controlRoots
//     (argv[2] = JSON), in the hermetic env it was spawned with. Prints {ok, result|error}.
// Calls use worldKit-owned launcher paths/config, or $MR_LOG/$MR_SCENARIO for direct
// legacy roles. Anything the scenario does not cover → unexpected, exit 97.
// Scenario JSON is re-read on every call so a test can change it between passes.
//
// Imported as a module (not executed) it exports worldKit(): the hermetic world builder the
// #1170 lifecycle and security suites share — real registry, real tracker CLI, these fakes.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const isMain = (() => { try { return fs.realpathSync(process.argv[1] ?? "") === SELF; } catch { return false; } })();

export async function fakeMain(owned) {
  const scenarioFile = owned ? owned.scenario : process.env.MR_SCENARIO;
  const log = owned ? owned.log : process.env.MR_LOG;
  const dist = owned ? owned.dist : process.env.MR_DIST;
  const role = path.basename(process.argv[1]);
  const argv = process.argv.slice(2);

  if (role === path.basename(SELF) && argv[0] === "--owned-pump-driver") {
    const [tracker, now, proofFile, nonce, encodedArgs] = argv.slice(1);
    const child = spawn(process.execPath, [tracker, "report-pump", "--once", ...JSON.parse(encodedArgs)], {
      env: { ...process.env, TRACKER_NOW: now, MR_OWNED_PUMP_PID_FILE: proofFile, MR_OWNED_PUMP_NONCE: nonce },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!Number.isSafeInteger(child.pid)) throw new Error("owned pump PID unavailable");
    fs.writeFileSync(proofFile, JSON.stringify({ pid: child.pid, nonce }), { mode: 0o600 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      fs.rmSync(proofFile, { force: true });
      process.stdout.write(JSON.stringify({ status, signal, stdout, stderr }) + "\n");
    });
    return;
  }

  if (role === "prepare-sandbox") {
    const a = JSON.parse(argv[0]);
    const { prepareSandboxFixture } = await import("../dispatch/agent-metadata/support/prepare-sandbox.mjs");
    try {
      const r = await prepareSandboxFixture({ ...a, launch: undefined }, dist, a.controlRoots);
      process.stdout.write(JSON.stringify({ ok: true, result: r }) + "\n");
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + "\n");
    }
    process.exit(0);
  }

  const s = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
  const rec = { role, argv };
  const done = (code, out = "") => {
    rec.rc = code;
    fs.appendFileSync(log, JSON.stringify(rec) + "\n");
    if (out) process.stdout.write(out);
    process.exit(code);
  };
  const unexpected = () => { rec.unexpected = true; done(97); };
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const real = s.passthrough?.[role];
  if (real) {
    if (owned && (role !== "dispatch-registry.py" || real !== owned.registry ||
        process.env.DISPATCH_STATE_DIR !== owned.stateDir)) unexpected();
    let input;
    if (role === "policy.py") {
      try { input = fs.readFileSync(0, "utf8"); } catch { input = ""; }
      rec.stdin = input;
    }
    // Log BEFORE exec so a hung child still leaves its argv in the trace.
    fs.appendFileSync(log, JSON.stringify({ ...rec, phase: "start" }) + "\n");
    const r = spawnSync(real, argv, {
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      ...(input === undefined ? {} : { input }),
      timeout: 60000,
    });
    done(r.error ? 127 : r.status ?? 1);
  }

  /** Next value of a per-log counter (one file per counter name). */
  function nextCount(name) {
    const f = `${log}.${name}`;
    let n = 0;
    try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch { /* first */ }
    fs.writeFileSync(f, String(n + 1));
    return n;
  }

  switch (role) {
    case "telepty": {
      const a = argv.join(" ");
      if (a === "list --json") {
        if (s.listBarrier) {
          // Rendezvous: hold every lister until `n` have arrived (two concurrent pumps both
          // read their registry rows before either claims). Bounded; the timeout is recorded.
          const dir = s.listBarrier.dir;
          fs.writeFileSync(path.join(dir, `${process.pid}`), "");
          const until = Date.now() + 10000;
          while (fs.readdirSync(dir).length < s.listBarrier.n && Date.now() < until) sleep(20);
          rec.barrier = fs.readdirSync(dir).length;
        }
        if (s.listRc) done(s.listRc, "telepty: daemon unavailable\n");
        done(0, JSON.stringify(s.sessions ?? []) + "\n");
      }
      if (argv[0] === "session" && argv[1] === "info" && argv[3] === "--json" && argv.length === 4) {
        const info = s.info?.[argv[2]];
        if (info) done(0, JSON.stringify(info) + "\n");
        done(1);
      }
      if (argv[0] === "read-screen" && argv[2] === "--lines" && argv.length === 4) {
        if (s.info?.[argv[1]]) done(0, s.screen);
        done(1);
      }
      if (argv[0] === "injects" && argv[1] === "--json") {
        rec.audit = true;
        if (s.auditRc) done(s.auditRc);
        done(0, JSON.stringify({ injects: s.audit ?? [] }) + "\n");
      }
      if (argv[0] === "inject") {
        // Which identity variables the child actually received (values never logged).
        rec.identityEnv = ["TELEPTY_SESSION_ID", "TELEPTY_SESSION_TOKEN", "TELEPTY_SESSION_NONCE",
          "TELEPTY_SUBMIT_FORCE_DEFAULT"].filter((k) => process.env[k] !== undefined);
        if (!argv.includes("--submit")) done(0); // tracker `check` HOLD notes: recorded, never sent
        const replies = s.injectReplies ?? [];
        const n = nextCount("inject");
        const reply = replies.length ? replies[Math.min(n, replies.length - 1)] : {};
        const id = randomUUID();
        rec.injectId = id;
        if (reply.crash) {
          // Simulated broker crash between the registry claim and the result.
          // Only the direct pump child spawned by this fixture may be signaled.
          let control;
          try {
            control = owned ? JSON.parse(fs.readFileSync(owned.pumpControl, "utf8")) : {
              proofFile: process.env.MR_OWNED_PUMP_PID_FILE, nonce: process.env.MR_OWNED_PUMP_NONCE,
            };
          } catch { unexpected(); }
          const { proofFile, nonce } = control;
          if (!proofFile || !nonce) unexpected();
          let proof;
          try { proof = JSON.parse(fs.readFileSync(proofFile, "utf8")); } catch { unexpected(); }
          if (!Number.isSafeInteger(proof.pid) || proof.pid !== process.ppid || proof.nonce !== nonce) unexpected();
          fs.appendFileSync(log, JSON.stringify({ ...rec, crash: true }) + "\n");
          process.kill(proof.pid, "SIGKILL");
          sleep(200);
          process.exit(137);
        }
        if (reply.sleepMs) sleep(reply.sleepMs);
        if (reply.waitFile) {
          // A long-running inject the test releases: marks itself started, blocks (bounded) until released.
          fs.writeFileSync(`${reply.waitFile}.started`, "");
          const until = Date.now() + 30000;
          while (!fs.existsSync(reply.waitFile) && Date.now() < until) sleep(20);
          rec.released = fs.existsSync(reply.waitFile);
        }
        const marker = reply.marker ?? "— consumed as a new turn.";
        const out = reply.stdout ?? `Injected into ${argv.at(-2)} ${marker}\ninject_id: ${id}\n`;
        done(reply.rc ?? 0, out);
      }
      unexpected();
      break;
    }
    case "cmux": {
      const c = s.cmux;
      const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
      if (!c || argv[0] !== "--json" || argv[1] !== "--id-format" || argv[2] !== "uuids") unexpected();
      if (argv[3] === "tree" && flag("--workspace") === c.workspace) {
        done(0, JSON.stringify({ windows: [{ id: c.window, workspaces: [{ id: c.workspace,
          panes: [{ id: c.pane, surfaces: [{ id: c.surface, type: "terminal", tty: c.tty }] }] }] }] }) + "\n");
      }
      if (argv[3] === "read-screen" && flag("--workspace") === c.workspace && flag("--surface") === c.surface) {
        done(0, JSON.stringify({ workspace_id: c.workspace, surface_id: c.surface, window_id: c.window, text: s.screen }) + "\n");
      }
      unexpected();
      break;
    }
    case "ps": {
      // Fixture pid only; the host process table is never read.
      if (s.ps && argv.join(" ") === `-p ${s.ps.pid} -o pid=,tty=,lstart=`) {
        done(0, `${s.ps.pid} ${s.ps.tty} ${s.ps.lstart}\n`);
      }
      if (s.psTable && argv.join(" ") === "-eo pid,ppid,command") done(0, s.psTable);
      unexpected();
      break;
    }
    case "wh-cli.sh": {
      const [verb] = argv;
      if (verb === "agent-meta-caps") done(s.capsRc ?? 0);
      if (verb === "agent-meta-set") done(s.setRc ?? 0);
      if (verb === "agent-meta-clear") done(0, "agent_meta clear=absent\n");
      if (verb === "set-status") done(0);
      if (verb === "prune-orphans") done(0, "0\n");
      if (verb === "lookup") done(0, "");
      if (verb === "alive") done(0);
      if (verb === "close-for-sid" || verb === "close") done(0);
      unexpected();
      break;
    }
    case "curl": {
      // session-cleanup's daemon DELETE only; any other curl is unexpected.
      if (s.curlDelete && argv.includes("DELETE")) done(0, s.curlDelete);
      unexpected();
      break;
    }
    default:
      unexpected(); // git and anything else: no scenario reaches them
  }
}

if (isMain) await fakeMain();

// ── worldKit: shared hermetic world for the #1170 suites (POSIX harness injected) ──────────
export const ORCH = "orchestrator";
export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** A request minted independently of the code under test: uuid v4 + 32 B base64url challenge. */
export function mint() {
  const challenge = randomBytes(32).toString("base64url");
  return { request_id: randomUUID(), challenge, challenge_sha256: sha256(challenge) };
}

/** The worker's item exactly as the envelope defines it (header, body, END). */
export function itemBytes(req, kind, seq, body, { challenge = req.challenge, end } = {}) {
  return Buffer.from(`AIGENTRY_REPORT v1 request_id=${req.request_id} challenge=${challenge} kind=${kind} seq=${seq}\n` +
    `${body}\n${end ?? `AIGENTRY_REPORT_END ${req.request_id} ${kind}-${seq}`}\n`);
}

/** `H` = tests/dispatch/agent-metadata/support/harness.mjs (POSIX only; imported by the caller). */
export function worldKit(H) {
  const { BIN, DIST, hermeticEnv, makeRun, privDir, sealedFixture, sh, writePriv } = H;
  const TRACKER = path.join(DIST, "src/tracker/cli.js");
  const onPath = (name) => {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      const p = path.join(dir, name);
      try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return fs.realpathSync(p); } catch { /* next */ }
    }
    throw new Error(`required tool ${name} not on PATH`);
  };

  function world(label) {
    const run = makeRun(label);
    const trace = privDir(path.join(run.dir, "trace"));
    const bin = privDir(path.join(run.dir, "bin"));
    privDir(path.join(bin, "lib"));
    writePriv(path.join(bin, "lib", "telepty-listing.sh"),
      "telepty_listing_trusted() { return 0; }\ntelepty_sid_live() { return 0; }\n", 0o644);
    writePriv(path.join(bin, "lib", "telepty-auth.sh"), "telepty_auth_token() { echo ''; }\n", 0o644);
    fs.symlinkSync(onPath("python3"), path.join(run.fakes, "python3"));
    const sessionsRoot = privDir(path.join(run.dir, "sessions"));
    const stateDir = path.join(run.dir, "state");
    const log = path.join(run.logs, "trace.jsonl");
    fs.writeFileSync(log, "");
    const scenFile = path.join(run.dir, "scenario.json");
    const pumpControl = path.join(run.dir, "pump-control.json");
    const owned = { scenario: scenFile, log, dist: DIST, stateDir, pumpControl,
      registry: path.join(BIN, "dispatch-registry.py") };
    // Serialized owned paths survive child-env sanitization without forwarding any authority.
    const launcher = path.join(run.dir, "fake-launcher.mjs");
    writePriv(launcher, `#!${process.execPath}\n` +
      `import(${JSON.stringify(pathToFileURL(SELF).href)}).then(({ fakeMain }) => fakeMain(${JSON.stringify(owned)}));\n`, 0o700);
    fs.symlinkSync(launcher, path.join(bin, "wh-cli.sh"));
    for (const name of ["telepty", "cmux", "ps", "curl", "git", "jq"]) {
      fs.symlinkSync(launcher, path.join(run.fakes, name));
    }
    fs.symlinkSync(launcher, path.join(trace, "dispatch-registry.py"));
    let scenario = { passthrough: { "dispatch-registry.py": path.join(BIN, "dispatch-registry.py") },
      sessions: [{ id: ORCH, host: "127.0.0.1" }], injectReplies: [], audit: [] };
    const save = () => fs.writeFileSync(scenFile, JSON.stringify(scenario));
    save();
    const env = hermeticEnv(run, {
      AIGENTRY_SHIM_SCRIPT_DIR: bin,
      DISPATCH_STATE_DIR: stateDir,
      AIGENTRY_SESSIONS_ROOT: sessionsRoot,
      DISPATCH_REGISTRY_PY: path.join(trace, "dispatch-registry.py"),
      TELEPTY: path.join(run.fakes, "telepty"),
      // Identity the broker's telepty child must NOT inherit (asserted at the fake).
      TELEPTY_SESSION_ID: ORCH, TELEPTY_SESSION_TOKEN: "FAKE-MR1170-TOKEN", TELEPTY_SESSION_NONCE: "FAKE-MR1170-NONCE",
      TELEPTY_SUBMIT_FORCE_DEFAULT: "1",
      MR_SCENARIO: scenFile, MR_LOG: log, MR_DIST: DIST,
    });
    const readCalls = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((c) => c.phase !== "start");
    const w = {
      run, env, log, stateDir, sessionsRoot, bin, trace,
      get scenario() { return scenario; },
      /** Patch the fakes' scenario; a new injectReplies list restarts its counter. */
      set(patch) {
        if ("injectReplies" in patch) fs.rmSync(`${log}.inject`, { force: true });
        scenario = { ...scenario, ...patch };
        save();
      },
      calls: readCalls,
      mark: () => readCalls().length,
      since: (m) => readCalls().slice(m),
      /** A sealed confined attempt (prepareWorkerSandbox layout) whose manifest binds HOME + outbox. */
      worker(sid, { task = "1170", listed = true, receipt } = {}) {
        const attempt = randomUUID();
        const stage = path.join(sessionsRoot, sid);
        const root = path.join(stage, "sandbox", attempt);
        const home = path.join(root, "home");
        const outbox = path.join(home, "report-outbox");
        const fx = sealedFixture(run, { sid, task, attempt, stage, ...(receipt === undefined ? {} : { receipt: receipt === "exited" ? { state: "exited", attempt, code: 0 } : receipt }),
          manifestExtra: { env: { HOME: home, AIGENTRY_WORKER_SESSION: "1", AIGENTRY_TASK_ID: task,
            AIGENTRY_WORKER_SESSION_ID: sid, AIGENTRY_WORKER_ATTEMPT: attempt, AIGENTRY_REPORT_OUTBOX: outbox } } });
        privDir(outbox);
        if (listed && !scenario.sessions.some((x) => x.id === sid)) w.set({ sessions: [...scenario.sessions, { id: sid }] });
        return { sid, task, attempt, stage, root, home, outbox, hash: fx.hash, manifest: fx.manifest };
      },
      reg(args) {
        return sh(path.join(trace, "dispatch-registry.py"), args, { env, timeout: 60000 });
      },
      /** dispatch's bound begin-delivery call shape; bind=false is a pre-0.2.5 (legacy) dispatch. */
      dispatch(wk, { now = "2026-10-09T12:00:00Z", bind = true, ref = randomUUID(), retryUnknown } = {}) {
        const req = mint();
        const refPath = path.join(run.dir, `ref-${ref}.md`);
        fs.writeFileSync(refPath, `ref ${ref}\n`);
        const r = w.reg(["begin-delivery", "--sid", wk.sid, "--ref-hash", sha256(`ref ${ref}\n`), "--ref-path", refPath,
          "--cwd", run.dir, "--from", ORCH, "--track", "t1170", "--role", "tester", "--now", now,
          ...(retryUnknown ? ["--retry-unknown", retryUnknown] : []),
          ...(bind ? ["--attempt", wk.attempt, "--manifest-sha256", wk.hash, "--report-request-id", req.request_id,
            "--report-challenge-sha256", req.challenge_sha256] : [])]);
        if (r.status !== 0) throw new Error(`begin-delivery rc=${r.status}: ${r.stdout}${r.stderr}`);
        return { did: JSON.parse(r.stdout).dispatch_id, req, wk, ref };
      },
      /** Worker side: write-once item via .tmp + rename into $AIGENTRY_REPORT_OUTBOX/<request_id>/. */
      write(d, kind, seq, body, opts = {}) {
        const dir = privDir(path.join(d.wk.outbox, d.req.request_id));
        const bytes = opts.bytes ?? itemBytes(d.req, kind, seq, body, opts);
        const file = path.join(dir, `${kind}-${seq}.md`);
        writePriv(`${file}.tmp`, bytes);
        fs.renameSync(`${file}.tmp`, file);
        return { file, bytes, sha: sha256(bytes), body };
      },
      /** The exact command reconciler step 0b3 runs. */
      pump(now, { args = [], env: extra = {} } = {}) {
        const m = w.mark();
        if (scenario.injectReplies?.some(reply => reply.crash)) {
          const proofFile = path.join(run.dir, `owned-pump-${randomUUID()}.json`);
          const nonce = randomBytes(16).toString("hex");
          writePriv(pumpControl, JSON.stringify({ proofFile, nonce }));
          let driver;
          try {
            driver = spawnSync(process.execPath,
              [SELF, "--owned-pump-driver", TRACKER, now, proofFile, nonce, JSON.stringify(args)],
              { env: { ...env, ...extra }, encoding: "utf8", timeout: 70000 });
          } finally {
            fs.rmSync(pumpControl, { force: true });
          }
          if (driver.error || driver.status !== 0) throw new Error(`owned pump driver failed: ${driver.stderr}`);
          return { ...JSON.parse(driver.stdout), calls: w.since(m) };
        }
        const r = sh(process.execPath, [TRACKER, "report-pump", "--once", ...args],
          { env: { ...env, TRACKER_NOW: now, ...extra }, timeout: 120000 });
        return { ...r, calls: w.since(m) };
      },
      ack(d, item, sha, verdict, now, extra = {}) {
        return sh(process.execPath, [TRACKER, "report-ack", "--dispatch-id", d.did, "--item", item, "--sha256", sha,
          "--verdict", verdict], { env: { ...env, TRACKER_NOW: now, ...extra }, timeout: 60000 });
      },
      status(now) {
        return sh(process.execPath, [TRACKER, "report-status", "--json"], { env: { ...env, TRACKER_NOW: now }, timeout: 60000 });
      },
      /** session-cleanup's compiled entrypoint, with this world's bin/ as SCRIPT_DIR. */
      cleanup(sid) {
        const m = w.mark();
        const r = sh(process.execPath, [path.join(DIST, "src/cleanup/cli.js"), sid], { env, timeout: 60000 });
        return { ...r, calls: w.since(m) };
      },
      /** dispatch's staged ref: original body + the REAL renderRefTrailer, named sha256(bytes).md in the worker's shared dir. */
      async stageRef(d) {
        const env1170 = await import(pathToFileURL(path.join(DIST, "src/report/envelope.js")).href);
        const shared = privDir(path.join(d.wk.home, ".telepty", "shared"));
        const bytes = Buffer.from(`# Dispatch ${d.ref}\n` + env1170.renderRefTrailer(d.req,
          { task: d.wk.task, sid: d.wk.sid, attempt: d.wk.attempt }));
        const file = path.join(shared, `${sha256(bytes)}.md`);
        writePriv(file, bytes);
        return { file, shared, prompt: `[context-ref] Read ${file} and use it as the source of truth for this task.` };
      },
      /** The compiled hook executable, exactly as the sealed --settings runs it (fixture stdin only). */
      hook(wk, event, input, { raw, args } = {}) {
        const shared = path.join(wk.home, ".telepty", "shared");
        const r = spawnSync(process.execPath, [path.join(DIST, "src/report/turn-hook.js"),
          ...(args ?? [event, wk.outbox, shared, wk.sid, wk.attempt])],
        { input: raw ?? JSON.stringify(input), encoding: "utf8", env: { PATH: env.PATH, HOME: wk.home }, timeout: 30000 });
        return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      activeRaw: () => fs.readFileSync(path.join(stateDir, "active.json"), "utf8"),
      row: (did) => JSON.parse(w.activeRaw()).dispatches.find((x) => x.dispatch_id === did),
      inboxFiles() {
        const out = [];
        const go = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) go(p); else out.push(p); } };
        go(path.join(stateDir, "inbox", "reports"));
        return out.sort();
      },
    };
    return w;
  }

  const submits = (calls) => calls.filter((c) => c.role === "telepty" && c.argv[0] === "inject" && c.argv.includes("--submit"));
  const events = (calls, kind) => calls.filter((c) => c.role === "dispatch-registry.py" && c.argv[0] === "report-event" &&
    (!kind || c.argv[c.argv.indexOf("--kind") + 1] === kind));
  return { world, submits, events, TRACKER };
}
