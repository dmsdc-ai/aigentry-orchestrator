// #1166 isolated 3OS CI driver for the tester-owned P6 startup diagnostic (builder-owned).
// Diagnostic evidence only: fake processes, no addon, no lock, no native build, no npm install.
// It isolates P6 startup behaviour; it does not prove a product fix. Shell-free child_process only.
//
// One invocation = one run. It stages the two tester-owned files byte-exact from the repository
// (prototypes/oslock/tests/oslock/...) into a fresh per-run scratch ROOT under --out:
//   <out>/run-<n>/output/tests/oslock/p6-startup-diagnostic.test.mjs
//   <out>/run-<n>/output/tests/oslock/fixtures/p6-diag-child.mjs
// The test derives ROOT as ../../.. of tests/oslock, so its log lands in <out>/run-<n>/output/logs.
// It then runs `node --expose-gc --test-reporter=tap tests/oslock/p6-startup-diagnostic.test.mjs`
// (cwd <out>/run-<n>/output, windowsHide, stdio ignore/pipe/pipe, env = CI env + DIAG_ENV) under a
// fixed deadline, and writes for upload:
//   <out>/run-<n>-receipt.json  <out>/run-<n>.tap  <out>/run-<n>.stderr.log  <out>/run-<n>-diagnostic.json
// Exit is non-zero on: malformed CLI, Node mismatch, source pin mismatch (refused before execution),
// spawn error, timeout, signal, non-zero test exit, no observed exit/close or an expired close grace,
// truncated captured output, HEAD != GITHUB_SHA, a source change during the run, or a
// missing/malformed diagnostic JSON.
// Captured evidence never turns a failing diagnostic into a pass. Test assertions are not read here.
//
// Usage: node ci/p6-startup-diagnostic.mjs --run 1|2 --out <absolute dir> [--expect-node vX.Y.Z]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { release, version as osVersion } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_ROOT = resolve(HERE, ".."); // prototypes/oslock
const SELF = "ci/p6-startup-diagnostic.mjs";
// Repository-relative (PROTO_ROOT) source -> scratch-ROOT-relative destination, pinned to the exact
// tester-final bytes. The pins are CI identity only, not product or production trust.
const STAGE = [
  ["tests/oslock/p6-startup-diagnostic.test.mjs", "output/tests/oslock/p6-startup-diagnostic.test.mjs",
    { bytes: 21953, sha256: "0a28fccf9e3c545d51ac482913136d6ed61f8dc40aed2b10efa2d1d40389ade6" }],
  ["tests/oslock/fixtures/p6-diag-child.mjs", "output/tests/oslock/fixtures/p6-diag-child.mjs",
    { bytes: 7019, sha256: "f54d8f4c547e18b8b326171ce4c1abd80c5d7afcd99e6ffda96f03f68b9c0ed7" }],
];
const TEST_ENTRY = "tests/oslock/p6-startup-diagnostic.test.mjs"; // relative to scratch ROOT/output
const TEST_ARGS = ["--expose-gc", "--test-reporter=tap", TEST_ENTRY];
const DIAG_ENV = Object.freeze({}); // fixed additions only; the test sets P6DIAG_TRACE_DIR itself
const LOG_DIR = "output/logs"; // where the test writes p6diag-<platform>-<ts>.json
const DIAG_NAME = /^p6diag-.*\.json$/;
// Fixture self-limits: hold-spawn 10 s, grandchild 15 s, final passive wait self-limit + 3 s per case.
// Local Darwin run ~28 s; tester estimate for worst-case Windows <= 2.5 min. Deadline leaves margin.
const TEST_TIMEOUT_MS = 300_000;
const CLOSE_GRACE_MS = 15_000; // after exit, error or kill: wait this long for stdio close, then stop waiting
const PROBE_TIMEOUT_MS = 15_000;
const LOG_CAP_BYTES = 4 * 1024 * 1024; // per captured stream

class HarnessError extends Error {}
function fail(msg) {
  throw new HarnessError(msg);
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function measureFile(base, rel) {
  const abs = join(base, ...rel.split("/"));
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) fail(`${rel}: missing or not a regular file`);
  const buf = readFileSync(abs);
  return { path: rel, bytes: buf.length, sha256: sha256(buf) };
}

function listTree(dir, base, found = []) {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return found;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (ent.isDirectory()) listTree(abs, base, found);
    else found.push(ent.isFile() ? measureFile(base, rel) : { path: rel, type: "non-regular" });
  }
  return found;
}

function capture(stream) {
  const chunks = [];
  let kept = 0;
  let total = 0;
  stream?.on("data", (c) => {
    total += c.length;
    if (kept < LOG_CAP_BYTES) {
      const part = c.subarray(0, LOG_CAP_BYTES - kept);
      chunks.push(part);
      kept += part.length;
    }
  });
  return () => ({ buf: Buffer.concat(chunks), total, truncated: total > kept });
}

// Settles on close, or CLOSE_GRACE_MS after exit/error/kill if close never comes (a descendant may
// still hold a pipe). Only the exact owned child handle is ever signalled. code/signal are what Node
// reported; null stays null.
function runCommand(file, args, { cwd, env = process.env, timeoutMs }) {
  return new Promise((done) => {
    const t0 = performance.now();
    const ev = { spawned: false, exit: null, close: null, spawnError: null, timedOut: false, killSent: false, closeGraceExpired: false };
    let settled = false;
    let grace = null;
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = capture(child.stdout);
    const err = capture(child.stderr);
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const o = out();
      const e = err();
      if (!ev.close) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      const src = ev.close ?? ev.exit;
      done({
        ...ev, code: src ? src.code : null, signal: src ? src.signal : null, pid: child.pid ?? null,
        durationMs: Math.round(performance.now() - t0),
        stdout: o.buf, stderr: e.buf, stdoutBytes: o.total, stderrBytes: e.total, truncated: o.truncated || e.truncated,
      });
    };
    const armGrace = () => {
      if (!grace) grace = setTimeout(() => { ev.closeGraceExpired = true; finish(); }, CLOSE_GRACE_MS);
    };
    const timer = setTimeout(() => {
      ev.timedOut = true;
      ev.killSent = child.kill("SIGKILL");
      armGrace();
    }, timeoutMs);
    child.once("spawn", () => { ev.spawned = true; });
    child.once("error", (e) => {
      ev.spawnError = String(e.code ?? e.message);
      armGrace(); // close may or may not follow an error; never wait on it unbounded
    });
    child.once("exit", (code, signal) => {
      ev.exit = { code, signal, atMs: Math.round(performance.now() - t0) };
      armGrace();
    });
    child.once("close", (code, signal) => {
      ev.close = { code, signal, atMs: Math.round(performance.now() - t0) };
      finish();
    });
  });
}

async function identity() {
  const env = process.env;
  const args = ["rev-parse", "HEAD"];
  const git = await runCommand("git", args, { cwd: PROTO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
  const ok = git.code === 0 && !git.spawnError && !git.timedOut;
  const head = ok ? git.stdout.toString("utf8").trim() : null;
  receipt.commands.push({
    argv: ["git", ...args], cwd: PROTO_ROOT, exitCode: git.code, signal: git.signal, timedOut: git.timedOut,
    spawnError: git.spawnError, durationMs: git.durationMs,
  });
  receipt.identity = {
    commit: {
      head, githubSha: env.GITHUB_SHA ?? null, ref: env.GITHUB_REF ?? null,
      runId: env.GITHUB_RUN_ID ?? null, runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    },
    runner: { os: env.RUNNER_OS ?? null, arch: env.RUNNER_ARCH ?? null, imageOS: env.ImageOS ?? null, imageVersion: env.ImageVersion ?? null },
    host: { platform: process.platform, arch: process.arch, release: release(), version: osVersion() },
    node: { version: process.version, execPath: process.execPath, v8: process.versions.v8 },
  };
  if (env.GITHUB_SHA && head !== env.GITHUB_SHA) fail(`checked-out HEAD ${head} != GITHUB_SHA ${env.GITHUB_SHA}`);
}

function measureSources() {
  return [SELF, ...STAGE.map(([src]) => src)].map((rel) => measureFile(PROTO_ROOT, rel));
}

function tapSummary(tap) {
  const s = {};
  for (const m of tap.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\S+)$/gm)) s[m[1]] = Number(m[2]);
  return s;
}

async function runOnce(out, run, expectNode) {
  receipt.sourcesBefore = measureSources();
  if (expectNode !== undefined && process.version !== expectNode) fail(`node ${process.version} is not the expected ${expectNode}`);
  for (const [i, [src, , pin]] of STAGE.entries()) {
    const m = receipt.sourcesBefore[i + 1];
    if (m.bytes !== pin.bytes || m.sha256 !== pin.sha256) {
      fail(`${src}: ${m.bytes} B ${m.sha256} does not match pin ${pin.bytes} B ${pin.sha256}; refused before execution`);
    }
  }
  const scratch = join(out, `run-${run}`);
  mkdirSync(out, { recursive: true });
  mkdirSync(scratch); // EEXIST: never reuse or execute files of an earlier run
  receipt.scratchRoot = scratch;
  for (const [src, dst] of STAGE) {
    const to = join(scratch, ...dst.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(PROTO_ROOT, ...src.split("/")), to, fsConstants.COPYFILE_EXCL);
  }
  receipt.staged = STAGE.map(([, dst]) => measureFile(scratch, dst));
  for (const [i, s] of receipt.staged.entries()) {
    const from = receipt.sourcesBefore[i + 1];
    if (s.sha256 !== from.sha256 || s.bytes !== from.bytes) fail(`${s.path}: staged copy differs from ${from.path}`);
  }

  const cwd = join(scratch, "output");
  const env = { ...process.env, ...DIAG_ENV };
  receipt.command = { argv: [process.execPath, ...TEST_ARGS], cwd, envAdditions: DIAG_ENV, timeoutMs: TEST_TIMEOUT_MS, closeGraceMs: CLOSE_GRACE_MS };
  const r = await runCommand(process.execPath, TEST_ARGS, { cwd, env, timeoutMs: TEST_TIMEOUT_MS });
  receipt.result = {
    pid: r.pid, spawned: r.spawned, exitCode: r.code, signal: r.signal, exitEvent: r.exit, closeEvent: r.close,
    spawnError: r.spawnError, timedOut: r.timedOut, killSent: r.killSent, closeGraceExpired: r.closeGraceExpired,
    durationMs: r.durationMs, stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, truncated: r.truncated,
  };
  // Partial output is kept whatever happened.
  writeFileSync(join(out, `run-${run}.tap`), r.stdout, { flag: "wx" });
  writeFileSync(join(out, `run-${run}.stderr.log`), r.stderr, { flag: "wx" });
  receipt.tapSummary = tapSummary(r.stdout.toString("utf8"));

  // Everything the run left in its scratch ROOT (logs, kept trace dirs), staged inputs excluded.
  const stagedPaths = new Set(STAGE.map(([, dst]) => dst));
  receipt.emitted = listTree(scratch, scratch).filter((f) => !stagedPaths.has(f.path));
  const diag = receipt.emitted.filter((f) => f.path.startsWith(`${LOG_DIR}/`) && DIAG_NAME.test(f.path.slice(LOG_DIR.length + 1)));
  receipt.diagnosticFiles = diag.map((f) => f.path);
  const problems = [];
  if (diag.length === 1) {
    const buf = readFileSync(join(scratch, ...diag[0].path.split("/")));
    writeFileSync(join(out, `run-${run}-diagnostic.json`), buf, { flag: "wx" }); // byte-exact copy
    let parsed = null;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch (e) {
      problems.push(`diagnostic JSON unparseable: ${e.message}`);
    }
    if (parsed !== null) {
      if (typeof parsed !== "object" || typeof parsed.cases !== "object" || parsed.cases === null) problems.push("diagnostic JSON has no cases object");
      if (parsed.node !== process.version) problems.push(`diagnostic JSON node ${parsed.node} != ${process.version}`);
      receipt.diagnosticSummary = {
        cases: parsed.cases ? Object.keys(parsed.cases).length : null,
        derived: parsed.derived ?? null,
        accountingPresent: parsed.accounting !== undefined,
      };
    }
  } else {
    problems.push(`expected exactly 1 ${LOG_DIR}/p6diag-*.json, found ${diag.length}`);
  }

  receipt.sourcesAfter = measureSources();
  if (JSON.stringify(receipt.sourcesAfter) !== JSON.stringify(receipt.sourcesBefore)) problems.push("repository sources changed during the run");
  // Incomplete evidence fails; the partial logs and byte counts above are kept as they are.
  if (r.truncated) problems.push(`captured output truncated at ${LOG_CAP_BYTES} B per stream (stdout ${r.stdoutBytes} B, stderr ${r.stderrBytes} B)`);
  if (!r.spawnError && (!r.exit || !r.close)) problems.push(`incomplete lifecycle: exit ${r.exit ? "observed" : "not observed"}, close ${r.close ? "observed" : "not observed"}`);
  if (r.closeGraceExpired) problems.push(`stdio close not observed within ${CLOSE_GRACE_MS} ms of exit/error/kill`);
  if (r.spawnError || r.timedOut || r.signal !== null || r.code !== 0) {
    problems.unshift(`test run ${run} failed (exit ${r.code}, signal ${r.signal}, timedOut ${r.timedOut}, spawnError ${r.spawnError}, closeGraceExpired ${r.closeGraceExpired})`);
  }
  if (problems.length) fail(problems.join("; "));
  receipt.status = "passed";
}

function parseArgs(argv) {
  const allowed = ["--run", "--out", "--expect-node"];
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!allowed.includes(key) || argv[i + 1] === undefined) fail(`unexpected argument ${key}`);
    if (Object.hasOwn(opts, key.slice(2))) fail(`duplicate argument ${key}`);
    opts[key.slice(2)] = argv[i + 1];
  }
  if (opts.run !== "1" && opts.run !== "2") fail("--run must be 1 or 2");
  if (!opts.out || !isAbsolute(opts.out)) fail("--out must be an absolute directory");
  if (opts["expect-node"] !== undefined && !/^v\d+\.\d+\.\d+$/.test(opts["expect-node"])) fail("--expect-node must be vX.Y.Z");
  const out = resolve(opts.out);
  const inRepo = relative(PROTO_ROOT, out);
  if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) fail("--out must be outside prototypes/oslock");
  return { run: opts.run, out, expectNode: opts["expect-node"] };
}

const receipt = {
  schema: "p6-startup-diagnostic-ci-receipt/1", task: 1166,
  scope: "isolated fake-process startup diagnostic; evidence only, not a product fix or production trust",
  status: "failed", startedAt: new Date().toISOString(), commands: [],
};

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`p6-startup-diagnostic: ${err.message}`);
  process.exit(2);
}
receipt.run = Number(args.run);
try {
  await identity();
  await runOnce(args.out, args.run, args.expectNode);
} catch (err) {
  receipt.status = "failed";
  receipt.failure = err instanceof HarnessError ? err.message : String(err?.stack ?? err);
}
receipt.finishedAt = new Date().toISOString();
mkdirSync(args.out, { recursive: true });
writeFileSync(join(args.out, `run-${args.run}-receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(`p6-startup-diagnostic run ${args.run}: ${receipt.status}${receipt.failure ? ` - ${receipt.failure}` : ""}`);
if (receipt.tapSummary) console.log(`tap summary ${JSON.stringify(receipt.tapSummary)}`);
process.exitCode = receipt.status === "passed" ? 0 : 1;
