// #1166 isolated 3OS build/test harness for the oslock primitive prototype (builder-owned).
// NOT product code, NOT an install path, NOT production artifact trust: the hashes here are
// isolated build evidence only. Every command is a shell-free child_process call.
//
//   build  Check ROOT/input holds exactly the four pinned sources, compile scratch copies of
//          binding.gyp + oslock.c with the CI-only locked node-gyp of ROOT/toolchain (installed
//          beforehand by `npm ci --ignore-scripts`; npm-bundled node-gyp is never used), stage
//          ROOT/input/build/oslock.node, write ROOT/manifest.json ({source, files:[{path,bytes,
//          sha256}]}: 4 sources + binary) and build-receipt.json / build.log under --out.
//   test   Run the tester-owned entry once (cwd ROOT/output, --expose-gc, OSLOCK_SUITE=all)
//          under a bounded timeout; keep TAP, stderr, exit and the per-case results JSON.
//          A non-zero exit, timeout or missing results file exits non-zero (never green).
//
// Source bytes are compared exactly against the LF pins; nothing is normalized. The workflow
// disables CI-side EOL conversion before checkout so Windows sees the committed bytes.
//
// Usage (ROOT defaults to this file's parent directory, i.e. prototypes/oslock):
//   node ci/oslock-build.mjs build --expect-node v20.20.2 --out <dir> [--root <abs>]
//   node ci/oslock-build.mjs test --run 1|2 --out <dir> [--timeout-ms <n>] [--root <abs>]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, constants as fsConstants, copyFileSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir, release, tmpdir, version as osVersion } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES = {
  "input/native/oslock/binding.gyp": { bytes: 551, sha256: "98f5cbf34c9f4bbb8f831eaab4765393558b9b86e600cc820577b65bca1f75d8" },
  "input/native/oslock/oslock.c": { bytes: 23746, sha256: "58af35ff2d3d02be41580ffa999d1d23e4ccbc0bc316466113b9bbf409b2f6cd" },
  "input/proto/oslock-loader.mjs": { bytes: 2515, sha256: "1b8cc43eafd5efa27212ef8cbd18bc042c24d5c6ff40e55fa907c92573cacd44" },
  "input/proto/with-os-lock.mjs": { bytes: 4580, sha256: "dd72566e45691122951a8a3b8005fa191f71dcae344ac96836eff6ce7080b010" },
};
const COMPILE = ["input/native/oslock/binding.gyp", "input/native/oslock/oslock.c"];
const BINARY = "input/build/oslock.node";
const TEST_ENTRY = "tests/oslock/primitive.test.mjs"; // relative to ROOT/output (its documented cwd)
const TEST_FILES = [
  "output/tests/oslock/primitive.test.mjs",
  "output/tests/oslock/fixtures/child.mjs",
  "output/tests/oslock/fixtures/worker.mjs",
];
const TEST_ENV = { OSLOCK_SUITE: "all", OSLOCK_P1_REPS: "20", OSLOCK_P2_REPS: "20" };
const RESULTS_DIR = "output/logs"; // where the tester's suite writes results-<suite>-<ts>.json
const LOG_CAP_BYTES = 2 * 1024 * 1024; // per captured stream
const BUILD_TIMEOUT_MS = 7 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 240_000;
const PROBE_TIMEOUT_MS = 15_000;
const BINARY_MAGIC = { linux: ["7f454c46"], darwin: ["cffaedfe", "cafebabe"], win32: ["4d5a"] };
// CI-only build tool workspace (ROOT/toolchain): exact node-gyp pin, committed npm lockfile.
// node-gyp 12.3.0: first 12.x line with Visual Studio 2026 (18.x) support (12.1.0) whose own CI
// still tested Node 20.x on macOS/Ubuntu/Windows; engines admit Node ^20.17.0.
const REGISTRY = "https://registry.npmjs.org/";
const TOOLCHAIN = {
  dir: "toolchain",
  packageJsonSha256: "7a4dc4f93a6aff74075068498eb8bd8434c7b5437adfd460fd1950757330b458",
  lockfileSha256: "d82749f836a4a107b361cc1c746f2c90a23103eb38f971da0d326e1227d1baa3",
  nodeGyp: {
    version: "12.3.0",
    engines: "^20.17.0 || >=22.9.0",
    resolved: "https://registry.npmjs.org/node-gyp/-/node-gyp-12.3.0.tgz",
    integrity: "sha512-QNcUWM+HgJplcPzBvFBZ9VXacyGZ4+VTOb80PwWR+TlVzoHbRKULNEzpRsnaoxG3Wzr7Qh7BYxGDU3CbKib2Yg==",
  },
};
// TOOLCHAIN.nodeGyp.engines evaluated for a vX.Y.Z Node version.
function nodeGypSupportsNode(v) {
  const [major, minor] = v.slice(1).split(".").map(Number);
  return (major === 20 && minor >= 17) || (major === 22 && minor >= 9) || major > 22;
}

class HarnessError extends Error {}
function fail(msg) {
  throw new HarnessError(msg);
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Uploaded text never carries runner-local absolute paths for ROOT, scratch or home.
let redactions = [];
function setRedactions(pairs) {
  const all = [];
  for (const [from, to] of pairs) {
    if (typeof from !== "string" || from.length < 4) continue;
    all.push([from, to]);
    if (from.includes("\\")) {
      all.push([from.replaceAll("\\", "/"), to]);
      all.push([from.replaceAll("\\", "\\\\"), to]);
    }
  }
  redactions = all.sort((a, b) => b[0].length - a[0].length);
}
function sanitize(text) {
  let s = String(text);
  for (const [from, to] of redactions) s = s.split(from).join(to);
  return s;
}

function measureFile(base, rel) {
  const abs = join(base, ...rel.split("/"));
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st?.isFile()) fail(`${rel}: missing or not a regular file`);
  const buf = readFileSync(abs);
  return { path: rel, bytes: buf.length, sha256: sha256(buf) };
}

function listTree(dir, base, found = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (ent.isDirectory()) listTree(abs, base, found);
    else if (ent.isFile()) found.push(rel);
    else fail(`${rel}: unexpected non-regular entry`);
  }
  return found;
}

// ROOT/input must hold exactly the pinned sources (plus `extra`); any other byte is rejected.
function verifySources(root, extra = []) {
  const want = [...Object.keys(SOURCES), ...extra].sort();
  const have = listTree(join(root, "input"), root).sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) {
    fail(`input tree mismatch: have ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
  }
  return Object.entries(SOURCES).map(([rel, pin]) => {
    const m = measureFile(root, rel);
    if (m.bytes !== pin.bytes || m.sha256 !== pin.sha256) fail(`${rel}: unexpected bytes (${m.bytes} B, ${m.sha256})`);
    return m;
  });
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
  return () => ({ text: Buffer.concat(chunks).toString("utf8"), total, truncated: total > kept });
}

// On timeout only the direct child is killed; the ephemeral runner ends any descendants.
function runCommand(file, args, { cwd, env = process.env, timeoutMs }) {
  return new Promise((done) => {
    const t0 = performance.now();
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    const child = spawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const out = capture(child.stdout);
    const err = capture(child.stderr);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const o = out();
      const e = err();
      done({
        code, signal, timedOut, spawnError, durationMs: Math.round(performance.now() - t0),
        stdout: o.text, stderr: e.text, stdoutBytes: o.total, stderrBytes: e.total, truncated: o.truncated || e.truncated,
      });
    };
    child.once("error", (e) => {
      spawnError = e;
      if (child.pid === undefined) finish(null, null);
    });
    child.once("close", finish);
  });
}

function evidence(file, args, cwd, r) {
  return {
    argv: [file, ...args], cwd, exitCode: r.code, signal: r.signal, timedOut: r.timedOut,
    spawnError: r.spawnError ? String(r.spawnError.code ?? r.spawnError.message) : null,
    durationMs: r.durationMs, stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, truncated: r.truncated,
  };
}

function readPackage(file, name) {
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) fail(`${name} package.json not found at ${file}`);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.name !== name || typeof pkg.version !== "string") fail(`${file} is not the ${name} package`);
  return pkg;
}

// Identity only: the npm next to the running Node (setup-node layout) that ran `npm ci`.
function npmIdentity() {
  const nodeExe = realpathSync(process.execPath);
  const npmDir = process.platform === "win32"
    ? join(dirname(nodeExe), "node_modules", "npm")
    : join(dirname(dirname(nodeExe)), "lib", "node_modules", "npm");
  try {
    return { dir: npmDir, version: readPackage(join(npmDir, "package.json"), "npm").version, usedFor: "npm ci of ROOT/toolchain only" };
  } catch (err) {
    return { status: "unknown", reason: err.message };
  }
}

// The locked node-gyp of ROOT/toolchain only; no search, no bundled or global fallback.
function findLockedNodeGyp(root) {
  const ws = join(root, TOOLCHAIN.dir);
  const want = TOOLCHAIN.nodeGyp;
  const pkgM = measureFile(root, `${TOOLCHAIN.dir}/package.json`);
  const lockM = measureFile(root, `${TOOLCHAIN.dir}/package-lock.json`);
  if (pkgM.sha256 !== TOOLCHAIN.packageJsonSha256) fail(`${pkgM.path}: unexpected bytes (${pkgM.sha256})`);
  if (lockM.sha256 !== TOOLCHAIN.lockfileSha256) fail(`${lockM.path}: unexpected bytes (${lockM.sha256})`);
  const lock = JSON.parse(readFileSync(join(ws, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify({ "node-gyp": want.version })) {
    fail(`toolchain lockfile does not pin exactly node-gyp ${want.version}`);
  }
  const gypEntry = lock.packages["node_modules/node-gyp"];
  if (gypEntry?.version !== want.version || gypEntry.resolved !== want.resolved || gypEntry.integrity !== want.integrity ||
    gypEntry.engines?.node !== want.engines) fail("toolchain lockfile node-gyp entry differs from the pinned identity");
  if (!lstatSync(join(ws, "node_modules", ".package-lock.json"), { throwIfNoEntry: false })?.isFile()) {
    fail(`locked toolchain not installed: run npm ci --ignore-scripts in ROOT/${TOOLCHAIN.dir} first`);
  }
  const entries = Object.entries(lock.packages).filter(([key]) => key !== "");
  for (const [key, p] of entries) {
    if (!key.startsWith("node_modules/") || p.link || p.hasInstallScript || typeof p.resolved !== "string" ||
      !p.resolved.startsWith(REGISTRY) || !/^sha512-/.test(p.integrity ?? "")) {
      fail(`toolchain lock entry ${key} is not a ${REGISTRY} sha512 tarball without install scripts`);
    }
    const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (readPackage(join(ws, ...key.split("/"), "package.json"), name).version !== p.version) fail(`installed ${key} is not ${p.version}`);
  }
  const gypDir = join(ws, "node_modules", "node-gyp");
  const gypPkg = readPackage(join(gypDir, "package.json"), "node-gyp");
  if (gypPkg.version !== want.version || gypPkg.engines?.node !== want.engines) fail(`installed node-gyp is ${gypPkg.version}, not ${want.version}`);
  if (!nodeGypSupportsNode(process.version)) fail(`node-gyp ${want.version} engines ${want.engines} exclude ${process.version}`);
  const binRel = typeof gypPkg.bin === "string" ? gypPkg.bin : gypPkg.bin?.["node-gyp"];
  if (typeof binRel !== "string") fail("node-gyp package declares no node-gyp bin");
  const bin = resolve(gypDir, binRel);
  const inside = relative(gypDir, bin);
  if (inside.startsWith("..") || isAbsolute(inside)) fail("node-gyp bin escapes its package");
  if (!lstatSync(bin, { throwIfNoEntry: false })?.isFile()) fail(`node-gyp bin missing: ${bin}`);
  return {
    source: `CI-only locked toolchain ROOT/${TOOLCHAIN.dir} (npm ci --ignore-scripts); npm-bundled node-gyp not used`,
    registry: REGISTRY,
    packageJson: pkgM,
    lockfile: { ...lockM, lockfileVersion: lock.lockfileVersion, packages: entries.length },
    npm: npmIdentity(),
    nodeGyp: {
      dir: gypDir, version: gypPkg.version, engines: gypPkg.engines.node, resolved: gypEntry.resolved,
      integrity: gypEntry.integrity, bin,
    },
  };
}

function pythonIdentity(log) {
  const m = log.match(/find Python using Python version (\S+) found at "([^"]+)"/);
  return m ? { source: "node-gyp find Python", version: m[1], path: m[2] }
    : { status: "NOTMEASURED", reason: "no node-gyp 'find Python' line in build log" };
}

// POSIX: the compiler actually invoked on oslock.c (make V=1 line), then `<it> --version`.
// Windows: node-gyp's own Visual Studio discovery lines.
async function compilerIdentity(log, cwd) {
  const lines = log.split(/\r?\n/);
  if (process.platform === "win32") {
    const vs = lines.filter((l) => l.includes("find VS")).slice(0, 20);
    return vs.length ? { source: "node-gyp find VS", lines: vs }
      : { status: "NOTMEASURED", reason: "no node-gyp 'find VS' line in build log" };
  }
  const line = lines.find((l) => /\boslock\.c\b/.test(l) && /\s-c(\s|$)/.test(l));
  const cmd = line?.trim().split(/\s+/)[0];
  if (!cmd || !/^[\w./+-]+$/.test(cmd)) {
    return { status: "NOTMEASURED", reason: "no verbose compile line for oslock.c in build log" };
  }
  const r = await runCommand(cmd, ["--version"], { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  receipt.commands.push(evidence(cmd, ["--version"], cwd, r));
  return {
    source: "make V=1 compile line", command: cmd,
    version: r.code === 0 ? r.stdout.split(/\r?\n/).slice(0, 3).join("\n") : null,
  };
}

async function identity(root) {
  const env = process.env;
  const args = ["rev-parse", "HEAD"];
  const git = await runCommand("git", args, { cwd: root, timeoutMs: PROBE_TIMEOUT_MS });
  receipt.commands.push(evidence("git", args, root, git));
  const head = git.code === 0 ? git.stdout.trim() : null;
  if (env.GITHUB_SHA && head && head !== env.GITHUB_SHA) fail(`checked-out HEAD ${head} != GITHUB_SHA ${env.GITHUB_SHA}`);
  return {
    commit: {
      head, githubSha: env.GITHUB_SHA ?? null, ref: env.GITHUB_REF ?? null,
      runId: env.GITHUB_RUN_ID ?? null, runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    },
    runner: { os: env.RUNNER_OS ?? null, arch: env.RUNNER_ARCH ?? null, imageOS: env.ImageOS ?? null, imageVersion: env.ImageVersion ?? null },
    host: {
      platform: process.platform, arch: process.arch, release: release(), version: osVersion(),
      glibcRuntime: process.report?.getReport?.()?.header?.glibcVersionRuntime ?? null,
    },
    node: {
      version: process.version, execPath: realpathSync(process.execPath),
      modules: process.versions.modules, napi: process.versions.napi, v8: process.versions.v8,
    },
  };
}

async function build(root, out, opts, baseRedactions) {
  if (process.version !== opts["expect-node"]) fail(`node ${process.version} is not the pinned ${opts["expect-node"]}`);
  receipt.sources = verifySources(root);
  if (lstatSync(join(root, "manifest.json"), { throwIfNoEntry: false })) fail("ROOT/manifest.json already exists; refusing to overwrite");
  const tools = findLockedNodeGyp(root);
  receipt.toolchain = { ...tools };
  const scratch = mkdtempSync(join(tmpdir(), "oslock-build-"));
  setRedactions([...baseRedactions, [scratch, "<SCRATCH>"], [realpathSync(scratch), "<SCRATCH>"]]);
  try {
    const work = join(scratch, "src");
    mkdirSync(work);
    for (const rel of COMPILE) {
      const dst = join(work, basename(rel));
      copyFileSync(join(root, ...rel.split("/")), dst, fsConstants.COPYFILE_EXCL);
      if (sha256(readFileSync(dst)) !== SOURCES[rel].sha256) fail(`${rel}: scratch copy differs`);
    }
    // Headers come from node-gyp's official nodejs.org download into the owned devdir.
    const args = [tools.nodeGyp.bin, "rebuild", "--release", "--verbose", `--devdir=${join(scratch, "devdir")}`];
    const r = await runCommand(process.execPath, args, { cwd: work, timeoutMs: BUILD_TIMEOUT_MS });
    receipt.commands.push(evidence(process.execPath, args, work, r));
    const header = `$ ${[process.execPath, ...args].join(" ")}\n# cwd ${work}\n` +
      `# exit ${r.code} signal ${r.signal} timedOut ${r.timedOut} durationMs ${r.durationMs}` +
      `${r.truncated ? ` (truncated to ${LOG_CAP_BYTES} B per stream)` : ""}\n`;
    writeFileSync(join(out, "build.log"), sanitize(`${header}--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`), { flag: "wx" });
    if (r.spawnError || r.timedOut || r.code !== 0) {
      fail(`node-gyp rebuild failed (exit ${r.code}, signal ${r.signal}, timedOut ${r.timedOut}); see build.log`);
    }
    const log = `${r.stdout}\n${r.stderr}`;
    receipt.toolchain.python = pythonIdentity(log);
    receipt.toolchain.compiler = await compilerIdentity(log, work);
    if (JSON.stringify(verifySources(root)) !== JSON.stringify(receipt.sources)) fail("sources changed during build");

    const builtRel = "build/Release/oslock.node";
    const built = measureFile(work, builtRel);
    const head = readFileSync(join(work, ...builtRel.split("/"))).subarray(0, 4).toString("hex");
    if (!(BINARY_MAGIC[process.platform] ?? []).some((m) => head.startsWith(m))) fail(`unexpected binary header ${head}`);
    mkdirSync(join(root, "input", "build")); // EEXIST if anything is already staged
    const dest = join(root, ...BINARY.split("/"));
    copyFileSync(join(work, ...builtRel.split("/")), dest, fsConstants.COPYFILE_EXCL);
    chmodSync(dest, 0o444);
    const staged = measureFile(root, BINARY);
    if (staged.sha256 !== built.sha256 || staged.bytes !== built.bytes) fail("staged binary differs from build output");
    receipt.binary = { ...staged, header: head };

    const commit = receipt.identity.commit.head ?? receipt.identity.commit.githubSha ?? "unknown-commit";
    const manifest = {
      source: `#1166 isolated CI build of pinned primitive sources at ${commit} on ${process.platform}-${process.arch} ` +
        `node ${process.version}; build evidence only, not production trust`,
      files: [...receipt.sources, staged].sort(byPath),
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(root, "manifest.json"), text, { flag: "wx", mode: 0o444 });
    writeFileSync(join(out, "manifest.json"), text, { flag: "wx" });
    receipt.status = "built";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function listResults(root) {
  const dir = join(root, ...RESULTS_DIR.split("/"));
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir).filter((n) => /^results-.*\.json$/.test(n));
}

function tapSummary(tap) {
  const s = {};
  for (const m of tap.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\S+)$/gm)) s[m[1]] = Number(m[2]);
  return s;
}

async function runTests(root, out, opts) {
  const run = opts.run;
  const timeoutMs = Number(opts["timeout-ms"] ?? DEFAULT_TEST_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be a positive integer");
  receipt.sources = verifySources(root, [BINARY]);
  const binary = measureFile(root, BINARY);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (JSON.stringify(manifest.files) !== JSON.stringify([...receipt.sources, binary].sort(byPath))) {
    fail("ROOT/manifest.json does not describe the staged sources and binary");
  }
  receipt.binary = binary;
  receipt.tests = TEST_FILES.map((rel) => measureFile(root, rel)); // recorded, not pinned: tester-owned bytes
  receipt.env = TEST_ENV;

  const before = new Set(listResults(root));
  const cwd = join(root, "output");
  const args = ["--expose-gc", "--test-reporter=tap", TEST_ENTRY];
  const r = await runCommand(process.execPath, args, { cwd, env: { ...process.env, ...TEST_ENV }, timeoutMs });
  receipt.commands.push(evidence(process.execPath, args, cwd, r));
  writeFileSync(join(out, `run-${run}.tap`), sanitize(r.stdout), { flag: "wx" });
  writeFileSync(join(out, `run-${run}.stderr.log`), sanitize(r.stderr), { flag: "wx" });
  receipt.tapSummary = tapSummary(r.stdout);
  const fresh = listResults(root).filter((n) => !before.has(n));
  receipt.resultsFiles = fresh;
  if (fresh.length === 1) {
    const text = readFileSync(join(root, ...RESULTS_DIR.split("/"), fresh[0]), "utf8");
    writeFileSync(join(out, `run-${run}-results.json`), sanitize(text), { flag: "wx" });
  }
  if (r.spawnError || r.timedOut || r.code !== 0) {
    fail(`test run ${run} failed (exit ${r.code}, signal ${r.signal}, timedOut ${r.timedOut})`);
  }
  if (fresh.length !== 1) fail(`test run ${run} wrote ${fresh.length} results files, expected 1`);
  receipt.status = "passed";
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode !== "build" && mode !== "test") fail("mode must be build or test");
  const allowed = mode === "build" ? ["--out", "--root", "--expect-node"] : ["--out", "--root", "--run", "--timeout-ms"];
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || rest[i + 1] === undefined) fail(`unexpected argument ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  if (!opts.out) fail("--out is required");
  if (opts.root !== undefined && !isAbsolute(opts.root)) fail("--root must be absolute");
  if (mode === "build" && !/^v\d+\.\d+\.\d+$/.test(opts["expect-node"] ?? "")) fail("--expect-node vX.Y.Z is required");
  if (mode === "test" && opts.run !== "1" && opts.run !== "2") fail("--run must be 1 or 2");
  return { mode, opts };
}

const receipt = {
  schema: "oslock-ci-receipt/1", task: 1166,
  scope: "isolated primitive prototype; build/test evidence only, not production trust",
  status: "failed", startedAt: new Date().toISOString(), commands: [],
};

let mode, opts, root, out;
try {
  ({ mode, opts } = parseArgs(process.argv.slice(2)));
  root = resolve(opts.root ?? join(HERE, ".."));
  out = resolve(opts.out);
  const inInput = relative(join(root, "input"), out);
  if (!inInput.startsWith("..") && !isAbsolute(inInput)) fail("--out must not be inside ROOT/input");
} catch (err) {
  console.error(`oslock-build: ${err.message}`);
  process.exit(2);
}

const baseRedactions = [[root, "<ROOT>"], [homedir(), "<HOME>"]];
setRedactions(baseRedactions);
mkdirSync(out, { recursive: true });
receipt.mode = mode;
try {
  receipt.identity = await identity(root);
  if (mode === "build") await build(root, out, opts, baseRedactions);
  else await runTests(root, out, opts);
} catch (err) {
  receipt.status = "failed";
  receipt.failure = err instanceof HarnessError ? err.message : String(err?.stack ?? err);
}
receipt.finishedAt = new Date().toISOString();
const receiptName = mode === "build" ? "build-receipt.json" : `run-${opts.run}-receipt.json`;
writeFileSync(
  join(out, receiptName),
  `${JSON.stringify(receipt, (_k, v) => (typeof v === "string" ? sanitize(v) : v), 2)}\n`,
  { flag: "wx" },
);
console.log(sanitize(`oslock-build ${mode}: ${receipt.status}${receipt.failure ? ` - ${receipt.failure}` : ""}`));
if (receipt.tapSummary) console.log(`tap summary ${JSON.stringify(receipt.tapSummary)}`);
process.exitCode = receipt.status === "failed" ? 1 : 0;
