// #1167 native qualification driver (test-only, win32-only). It exercises the BUILT candidate, not a
// rewrite: dist/tests/dispatch/fake-cmux-win32.js (the C# fake and its one compile) and
// dist/tests/dispatch/model-router-fixtures.js (the real fixture), produced by `npm run build` from
// the pinned sources below. Parent mode (no argv) rehashes those inputs, runs two fixed child modes,
// checks each child helper scratch after that child has exited, and prints one sanitized receipt
// JSON on stdout. A PASS qualifies the fake only: productAcceptance, release_acceptance and
// nativeHostSupport stay false. Nothing skips; a wrong platform or a missing compiler FAILS.
// Scope: generated fake data and the read-only agent-metadata caps/set-negative calls. No dispatch,
// worker spawn, provider, real cmux, daemon, broker, auth, install or network.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), "../..");
const SCHEMA = "aigentry/1167-windows-fake-cmux-acceptance/v1";
const CS_PIN = "7d14cad8a67e10064e5d81dd6c8ae8a878ac09a64780e5af80d9866e3f69d2c4";
/** Candidate R2 sources plus the release23a5be18 baseline inputs they are composed onto. */
const SOURCE_PINS = [
  ["tests/dispatch/fake-cmux-win32.ts", "646c12f0e04e1f5c1fbe50a5aacfecc6c5de746a3ee15b1983590ca7d86c1805"],
  ["tests/dispatch/model-router-fixtures.ts", "f3e88ef3fdd0b999c1274d5d59151aee0888777f908abbcbc630e394ca86c6cf"],
  ["tests/dispatch/model-router-fixtures.test.ts", "5fa262af4a06f26e0cf37832958fdc5f1426a75fe8e8f535a6549d1e9cca74f2"],
  ["src/session/agent-metadata.ts", "4b9e73514f34dc5c58a21e40dd6894ab0b208524d2e8d3b01b1fec3b2086ce99"],
  ["package.json", "a5b293836105f2a02072e1cb4214940c61ea2798c3c899e15a3e847222a40f5d"],
  ["tsconfig.json", "7f867214418ae3ed617dba351c2d4c99064b8e7afd3b9a0d34ece8cc8a94bc97"],
];
/** Build outputs: required to exist, hashed and recorded, never pinned (they are produced on the runner). */
const BUILT = ["dist/tests/dispatch/fake-cmux-win32.js", "dist/tests/dispatch/model-router-fixtures.js", "dist/src/session/agent-metadata.js"];
const CAPS_REPLY = "{\"protocol\":\"cmux-socket\",\"version\":2,\"methods\":[]}\n";
const CAPS_LINE = "[\"capabilities\"]\n";
/** The six denied argv of model-router-fixtures.test.ts, verbatim. */
const DENIED = [["rpc", "surface.agent_metadata.set", "{}"], ["rpc", "surface.agent_metadata.clear", "{}"],
  ["capabilities", "--json"], ["capabilities", ""], ["Capabilities"], []];
const TRIPPED = /model\/work tripwire must remain untouched/;
const SCRATCH_RE = /^fake cmux 1167 ü-[A-Za-z0-9]{6}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HELPER_LEAVES = ["cmux.cs", "cmux.exe"];
const EXTRA_LEAF = "acceptance-extra-leaf.txt", EXTRA_BYTES = "test-owned extra leaf #1167\n";
const CHILD_TAG = "ACCEPTANCE-CHILD-RESULT ";
const CHILD_TIMEOUT_MS = 300000, SPAWN_TIMEOUT_MS = 20000, TEXT_LIMIT = 512, MAX_ERRORS = 32;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sameList = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const readText = (file) => existsSync(file) ? readFileSync(file, "utf8") : null;
const fileUrl = (rel) => pathToFileURL(join(REPO, rel)).href;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces the known Windows path roots (repo, tmp, home, SystemRoot) case-insensitively, as Windows
 * compares paths, then bounds the text and strips control bytes. It scrubs nothing else: no arbitrary
 * secret detection is claimed, and no token or credential is in scope for this driver.
 */
function sanitize(text) {
  let out = String(text);
  const roots = [[REPO, "<repo>"], [tmpdir(), "<tmp>"], [process.env.USERPROFILE, "<home>"], [process.env.SystemRoot, "<SystemRoot>"]]
    .filter(([value]) => typeof value === "string" && value.length > 3).sort((a, b) => b[0].length - a[0].length);
  for (const [value, label] of roots) out = out.replace(new RegExp(escapeRegExp(value), "gi"), label);
  return out.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "?").slice(0, TEXT_LIMIT);
}

/** Stage/assertion bookkeeping. A thrown stage counts as one failed assertion; nothing is ever SKIPPED. */
function recorder() {
  const stages = [], errors = [];
  let total = 0, failed = 0;
  const note = (text) => { if (errors.length < MAX_ERRORS) errors.push(sanitize(text)); };
  async function stage(name, body) {
    const entry = { name, status: "PASSED", assertions: 0, failed: 0 };
    stages.push(entry);
    const check = (ok, label) => {
      total++; entry.assertions++;
      if (ok === true) return true;
      failed++; entry.failed++; entry.status = "FAILED"; note(`${name}: ${label}`);
      return false;
    };
    try { await body(check); }
    catch (error) { check(false, `threw ${error instanceof Error ? error.message : String(error)}`); }
    return entry.status === "PASSED";
  }
  /** A stage whose prerequisite failed is recorded FAILED, never skipped. */
  const blocked = (name, reason) => stage(name, (check) => { check(false, `prerequisite failed: ${reason}`); });
  /** Folds a validated child result into this receipt. */
  function absorb(prefix, child) {
    for (const s of child.stages) stages.push({ name: `${prefix}/${s.name}`, status: s.status, assertions: s.assertions, failed: s.failed });
    total += child.assertions.total; failed += child.assertions.failed;
    for (const e of child.errors) note(`${prefix}/${e}`);
  }
  return { stage, blocked, absorb, stages, errors, totals: () => ({ total, passed: total - failed, failed }) };
}

/** Shape of a helper scratch dir: exactly <tmpdir>\fake cmux 1167 ü-XXXXXX, absolute and normalized. */
function ownedScratchShape(path) {
  return typeof path === "string" && win32.isAbsolute(path) && win32.normalize(path) === path &&
    win32.dirname(path) === tmpdir() && SCRATCH_RE.test(win32.basename(path));
}
function isRealDir(path) {
  try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}
function absent(path) {
  try { lstatSync(path); return false; } catch (error) { return error?.code === "ENOENT"; }
}
/** Removes only the named leaves of a validated owned dir, then the dir itself without recursion. */
function removeOwned(dir, leaves) {
  if (!isRealDir(dir)) return false;
  for (const leaf of leaves) {
    const file = win32.join(dir, leaf);
    if (absent(file)) continue;
    try { if (!lstatSync(file).isFile()) return false; unlinkSync(file); } catch { return false; }
  }
  try { rmdirSync(dir); } catch { return false; }
  return absent(dir);
}

// ---- child side ------------------------------------------------------------------------------

async function loadCandidate(check) {
  if (!check(process.platform === "win32", `native-only: platform is ${process.platform}`)) throw new Error("native-only driver refuses a non-win32 platform");
  const helper = await import(fileUrl(BUILT[0]));
  const fixtures = await import(fileUrl(BUILT[1]));
  check(helper.FAKE_CMUX_CS_SHA256 === CS_PIN, "helper C# pin equals the dispatch C# pin");
  check(sha256(Buffer.from(helper.FAKE_CMUX_CS, "utf8")) === CS_PIN, "helper C# source rehashes to the pin");
  check(fixtures.REPO === REPO, "fixture REPO is this checkout");
  return { helper, fixtures };
}

function checkBuild(check, build) {
  const scratch = win32.dirname(build.exe);
  check(ownedScratchShape(scratch) && isRealDir(scratch), "helper scratch is a real dir named fake cmux 1167 ü-XXXXXX directly under tmpdir");
  check(build.exe === win32.join(scratch, "cmux.exe"), "helper exe is <scratch>\\cmux.exe");
  check(build.sourceSha256 === CS_PIN, "written cmux.cs rehash equals the pin");
  check(build.compilerStatus === 0, `compiler status ${build.compilerStatus}`);
  for (const key of ["compilerSha256", "mscorlibSha256", "exeSha256"]) check(HEX64.test(build[key]), `${key} is a sha256`);
  check(Number.isSafeInteger(build.compilerElapsedMs) && build.compilerElapsedMs >= 0, "compiler elapsed ms recorded");
  const exe = readFileSync(build.exe);
  check(sha256(exe) === build.exeSha256, "compiled exe rehashes to exeSha256");
  check(exe.subarray(0, 2).toString("latin1") === "MZ", "compiled exe has the necessary MZ header (not complete PE validation)");
  check(sameList(readdirSync(scratch), HELPER_LEAVES), "scratch holds exactly cmux.cs and cmux.exe");
  return { scratch, record: { sourceSha256: build.sourceSha256, compilerSha256: build.compilerSha256, mscorlibSha256: build.mscorlibSha256,
    exeSha256: build.exeSha256, compilerStatus: build.compilerStatus, compilerElapsedMs: build.compilerElapsedMs, scratchName: win32.basename(scratch) } };
}

/** A fixture whose WORK_LOG stayed untouched must clean up without throwing and leave no root. */
function cleanupClean(check, f, tag) {
  let error;
  try { f.cleanup(); } catch (e) { error = e; }
  check(error === undefined, `${tag} fixture cleanup threw ${error instanceof Error ? error.message : ""}`);
  check(!existsSync(f.root), `${tag} fixture root removed`);
}
/** A deliberately tripped WORK_LOG must make cleanup throw, and still remove the root. */
function cleanupRejects(check, f, tag) {
  let error;
  try { f.cleanup(); } catch (e) { error = e; }
  check(error instanceof Error && TRIPPED.test(error.message), `${tag} cleanup rejects the tripped WORK_LOG`);
  check(!existsSync(f.root), `${tag} fixture root still removed`);
}

function finishChild(rec, result, failCode) {
  const assertions = rec.totals();
  process.stdout.write(`${CHILD_TAG}${JSON.stringify({ ...result, stages: rec.stages, assertions, errors: rec.errors })}\n`);
  // Natural exit only: the helper exit hook runs after this and may still raise the code to 1.
  process.exitCode = assertions.failed === 0 ? 0 : failCode;
}

async function childNormal() {
  const rec = recorder(), result = { mode: "normal" };
  let candidate, build, scratch, installs = 0;
  /** One real fixture; its bin\cmux.exe must be a hash-bound copy of the one build of this process. */
  const fixture = (check) => {
    const f = candidate.fixtures.fixture();
    installs++;
    check(sha256(readFileSync(join(f.bin, "cmux.exe"))) === build.exeSha256, "installed bin\\cmux.exe matches the build hash");
    check(!existsSync(join(f.bin, "cmux")), "no extensionless cmux in the win32 fixture bin");
    return f;
  };
  const need = () => { if (!build) throw new Error("prerequisite failed: compile-once produced no build"); };

  await rec.stage("load-candidate", async (check) => { candidate = await loadCandidate(check); });
  await rec.stage("compile-once", (check) => {
    if (!candidate) throw new Error("prerequisite failed: candidate modules not loaded");
    build = candidate.helper.fakeCmuxBuild();
    result.scratch = win32.dirname(build.exe);
    const checked = checkBuild(check, build);
    scratch = checked.scratch; result.build = checked.record;
  });
  await rec.stage("bare-cmux-capabilities", (check) => {
    need();
    const f = fixture(check);
    try {
      // The product shape: bare name, fixture env, no shell (agent-metadata.ts spawnSync of "cmux").
      const r = spawnSync("cmux", ["capabilities"], { env: f.env, shell: false, timeout: SPAWN_TIMEOUT_MS });
      check(r.error === undefined, `bare cmux spawn error ${r.error?.code ?? ""}`);
      check(r.status === 0 && r.signal === null, `bare cmux rc ${r.status} signal ${r.signal}`);
      check(Buffer.isBuffer(r.stdout) && r.stdout.equals(Buffer.from(CAPS_REPLY, "utf8")), "raw stdout is the exact capabilities JSON + LF");
      check(Buffer.isBuffer(r.stderr) && r.stderr.length === 0, "stderr is empty");
      check(readText(f.env.CMUX_CAPS_LOG) === CAPS_LINE, "caps log is exactly one [\"capabilities\"] line");
      check(!existsSync(f.env.WORK_LOG), "no WORK_LOG");
    } finally { cleanupClean(check, f, "bare"); }
  });
  await rec.stage("denied-argv", (check) => {
    need();
    for (const argv of DENIED) {
      const tag = JSON.stringify(argv), f = fixture(check);
      try {
        const r = spawnSync(join(f.bin, "cmux.exe"), argv, { env: f.env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
        check(r.error === undefined && r.status === 99, `${tag} rc ${r.status}`);
        check(r.stdout === "", `${tag} stdout is empty`);
        check(readText(f.env.WORK_LOG) === "forbidden\n", `${tag} WORK_LOG is exactly forbidden + LF`);
        check((readText(f.env.CMUX_CAPS_LOG) ?? "") === "", `${tag} is never recorded as a capability query`);
      } finally { cleanupRejects(check, f, tag); }
    }
  });
  await rec.stage("missing-log-env", (check) => {
    need();
    for (const name of ["CMUX_CAPS_LOG", "WORK_LOG"]) {
      const f = fixture(check), env = { ...f.env };
      delete env[name];
      try {
        const r = spawnSync(join(f.bin, "cmux.exe"), ["capabilities"], { env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
        check(r.error === undefined && r.status === 98, `without ${name} rc ${r.status}`);
        check(r.stdout === "", `without ${name} stdout is empty`);
        check(!existsSync(f.env.CMUX_CAPS_LOG) && !existsSync(f.env.WORK_LOG), `without ${name} neither log is written`);
      } finally { cleanupClean(check, f, `without ${name}`); }
    }
  });
  await rec.stage("adapter-caps-set-unsupported", (check) => {
    need();
    const f = fixture(check);
    try {
      // The same calls as model-router-fixtures.test.ts "the adapter reads the fixture capabilities reply as unsupported".
      const adapter = join(REPO, BUILT[2]);
      const status = JSON.stringify({ connection: "unknown", activity: "unknown", activity_source: "unknown", dispatch: "none", read_at: 0 });
      const runs = [["caps"], ["set", "router-fixture", "--stage", join(f.aig, "sessions/router-fixture"), "--status-json", status]];
      for (const argv of runs) {
        const r = spawnSync(process.execPath, [adapter, ...argv], { env: f.env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
        check(r.status === 20, `adapter ${argv[0]} rc ${r.status}`);
        check(r.stderr === `agent-meta: ${argv[0]} rc=20 reason=capability-missing\n`, `adapter ${argv[0]} stderr is not exactly capability-missing: ${r.stderr}`);
        check(r.stdout === "", `adapter ${argv[0]} stdout is empty`);
      }
      check(readText(f.env.CMUX_CAPS_LOG) === CAPS_LINE.repeat(runs.length), "exactly two capability queries, nothing else");
      check(!existsSync(f.env.WORK_LOG), "no rpc and no other cmux call reached the fake");
    } finally { cleanupClean(check, f, "adapter"); }
  });
  await rec.stage("helper-build-reuse", (check) => {
    need();
    check(candidate.helper.fakeCmuxBuild() === build, "a later call returns the same cached build (no second compile)");
    check(sameList(readdirSync(scratch), HELPER_LEAVES), "scratch still holds exactly cmux.cs and cmux.exe");
    check(sha256(readFileSync(build.exe)) === build.exeSha256, "build exe unchanged after every install");
    check(installs === 10, `install count ${installs}, expected 10 (1 bare + 6 denied + 2 missing-env + 1 adapter)`);
  });
  result.installs = installs;
  finishChild(rec, result, 1);
}

async function childExtraLeaf() {
  const rec = recorder(), result = { mode: "extra-leaf" };
  await rec.stage("extra-leaf-setup", async (check) => {
    const { helper } = await loadCandidate(check);
    const build = helper.fakeCmuxBuild();
    result.scratch = win32.dirname(build.exe);
    const { scratch, record } = checkBuild(check, build);
    result.build = record;
    if (!ownedScratchShape(scratch) || !isRealDir(scratch)) throw new Error("refusing to write outside a validated helper scratch");
    // Fake data owned by this test inside the helper scratch of this child; the helper does not know this leaf.
    writeFileSync(win32.join(scratch, EXTRA_LEAF), EXTRA_BYTES, { flag: "wx" });
    check(sameList(readdirSync(scratch), [...HELPER_LEAVES, EXTRA_LEAF]), "scratch holds the helper leaves plus the one extra leaf");
  });
  finishChild(rec, result, 3);
}

// ---- parent side -----------------------------------------------------------------------------

function hashFile(rel) {
  try {
    const file = join(REPO, rel), s = lstatSync(file);
    return s.isFile() && !s.isSymbolicLink() ? sha256(readFileSync(file)) : null;
  } catch { return null; }
}

/** Allowlisted env only: what node, tmpdir and the helper compiler path need. */
function childEnv() {
  const keep = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => keep.has(key.toUpperCase()) && value !== undefined));
}

/** Runs one fixed child mode; returns its exit facts and its validated result (or why it is missing). */
function runChild(mode) {
  const r = spawnSync(process.execPath, [SELF, "--child", mode], { cwd: REPO, env: childEnv(), shell: false, windowsHide: true,
    encoding: "utf8", timeout: CHILD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  const lines = (r.stdout ?? "").split("\n").filter((line) => line !== "");
  let result = null, parseError = null;
  if (lines.length !== 1 || !lines[0].startsWith(CHILD_TAG)) parseError = `expected one result line, got ${lines.length}`;
  else {
    try {
      result = JSON.parse(lines[0].slice(CHILD_TAG.length));
      const valid = result?.mode === mode && Array.isArray(result.stages) && Array.isArray(result.errors) &&
        Number.isSafeInteger(result.assertions?.total) && Number.isSafeInteger(result.assertions?.failed);
      if (!valid) { result = null; parseError = "malformed child result"; }
    } catch { result = null; parseError = "unparseable child result"; }
  }
  return { status: r.status, signal: r.signal, error: r.error ? (r.error.code ?? r.error.name) : null, stderr: r.stderr ?? "", result, parseError };
}

function childRecord(run) {
  return { status: run.status, signal: run.signal, error: run.error, parseError: run.parseError, stderr: sanitize(run.stderr),
    build: run.result?.build ?? null, installs: run.result?.installs ?? null };
}

/**
 * Compiler correlation only: the sha256 of the same fixed csc.exe path the helper uses, compared with the
 * build compilerSha256. The version is deliberately not measured (no structured PE resource parser here).
 */
function compilerMetadata(buildSha) {
  const out = { path: "<SystemRoot>\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", sha256: null, matchesBuild: false, fileVersion: null,
    note: "fileVersion not measured: no structured PE resource parsing in this driver" };
  try {
    const root = process.env.SystemRoot;
    if (typeof root !== "string" || !/^[A-Za-z]:\\/.test(root)) return { ...out, note: `${out.note}; SystemRoot unavailable, hash not measured` };
    const bytes = readFileSync(win32.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"));
    out.sha256 = sha256(bytes);
    out.matchesBuild = typeof buildSha === "string" && out.sha256 === buildSha;
  } catch { out.note = `${out.note}; compiler unreadable, hash not measured`; }
  return out;
}

async function parent(rec) {
  const receipt = { schema: SCHEMA, task: "1167", purpose: "native qualification of the test-only fake cmux.exe",
    productAcceptance: false, release_acceptance: false, nativeHostSupport: false, qualifiedFake: false,
    runner: { platform: process.platform, arch: process.arch, node: process.version, osRelease: release(),
      githubSha: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ? process.env.GITHUB_SHA : null,
      githubRef: /^refs\/heads\/[A-Za-z0-9._\/-]{1,200}$/.test(process.env.GITHUB_REF ?? "") ? process.env.GITHUB_REF : null },
    driverSha256: sha256(readFileSync(SELF)), csPin: CS_PIN, sources: [], built: [], compiler: null, children: {}, cleanup: {} };

  const preflight = await rec.stage("preflight", (check) => {
    check(process.platform === "win32", `native-only: platform is ${process.platform}`);
    check(/^v20\./.test(process.version), `Node 20 expected, got ${process.version}`);
    for (const [rel, pin] of SOURCE_PINS) {
      const actual = hashFile(rel);
      receipt.sources.push({ path: rel, pin, actual, match: actual === pin });
      check(actual === pin, `${rel} sha256 ${actual} does not match pin ${pin}`);
    }
    for (const rel of BUILT) {
      const actual = hashFile(rel);
      receipt.built.push({ path: rel, sha256: actual });
      check(actual !== null, `${rel} is missing (npm run build must run first)`);
    }
  });

  if (!preflight) {
    for (const name of ["child-normal", "normal-scratch-cleanup", "child-extra-leaf", "extra-leaf-cleanup"]) await rec.blocked(name, "preflight");
  } else {
    const normal = runChild("normal");
    receipt.children.normal = childRecord(normal);
    await rec.stage("child-normal", (check) => {
      check(normal.error === null && normal.signal === null, `child spawn error ${normal.error} signal ${normal.signal}`);
      check(normal.status === 0, `child exit ${normal.status}`);
      check(normal.parseError === null, `child result: ${normal.parseError}`);
      check(!/fake-cmux:/.test(normal.stderr), "no helper failure on child stderr");
    });
    if (normal.result) rec.absorb("normal", normal.result);
    await rec.stage("normal-scratch-cleanup", (check) => {
      const scratch = normal.result?.scratch;
      if (!check(ownedScratchShape(scratch), "reported scratch is an owned fake cmux dir directly under tmpdir")) return;
      const removed = absent(scratch);
      receipt.cleanup.normalScratchRemovedByExitHook = removed;
      if (check(removed, "exit hook removed the whole helper scratch after a normal exit")) return;
      receipt.cleanup.normalScratchParentRemoval = removeOwned(scratch, HELPER_LEAVES);
    });

    const extra = runChild("extra-leaf");
    receipt.children.extraLeaf = childRecord(extra);
    await rec.stage("child-extra-leaf", (check) => {
      check(extra.error === null && extra.signal === null, `child spawn error ${extra.error} signal ${extra.signal}`);
      check(extra.parseError === null, `child result: ${extra.parseError}`);
      check(extra.status === 1, `the exit hook must turn a clean run into exit 1, got ${extra.status}`);
      check(extra.stderr.split(/\r?\n/).includes("fake-cmux: scratch cleanup failed for <scratch>"), "helper reports exactly the non-recursive root failure");
    });
    if (extra.result) rec.absorb("extra-leaf", extra.result);
    await rec.stage("extra-leaf-cleanup", (check) => {
      const scratch = extra.result?.scratch;
      receipt.cleanup.extraLeafRemainedAfterExit = false;
      if (!check(ownedScratchShape(scratch) && isRealDir(scratch), "reported scratch is an owned real dir directly under tmpdir that still exists")) return;
      for (const leaf of HELPER_LEAVES) check(absent(win32.join(scratch, leaf)), `exit hook removed its owned ${leaf}`);
      check(sameList(readdirSync(scratch), [EXTRA_LEAF]), "only the known extra leaf remains");
      receipt.cleanup.extraLeafRemainedAfterExit = readText(win32.join(scratch, EXTRA_LEAF)) === EXTRA_BYTES;
      check(receipt.cleanup.extraLeafRemainedAfterExit, "the extra leaf is untouched");
      const removed = removeOwned(scratch, [EXTRA_LEAF]);
      receipt.cleanup.extraLeafParentRemoval = removed;
      check(removed, "parent removed only its known leaf and then the root");
    });
    receipt.compiler = compilerMetadata(normal.result?.build?.compilerSha256);
  }

  receipt.stages = rec.stages;
  receipt.assertions = rec.totals();
  receipt.errors = rec.errors;
  receipt.qualifiedFake = preflight && receipt.assertions.total > 0 && receipt.assertions.failed === 0 && rec.stages.every((s) => s.status === "PASSED");
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  process.stderr.write(`windows-fake-cmux-acceptance: qualifiedFake=${receipt.qualifiedFake} assertions=${receipt.assertions.passed}/${receipt.assertions.total} failed=${receipt.assertions.failed}\n`);
  process.exitCode = receipt.qualifiedFake ? 0 : 1;
}

/**
 * An unexpected parent exception still yields a bounded FAILED receipt on stdout (the workflow redirect
 * has already truncated the placeholder). Stages and failed assertions recorded so far are kept, the
 * exception is one more failed assertion, and only its sanitized message is kept: no stack, no env.
 */
async function parentOrFailedReceipt() {
  const rec = recorder();
  try { await parent(rec); return; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rec.stage("parent-unexpected-exception", (check) => { check(false, `threw ${message}`); });
  }
  process.stdout.write(`${JSON.stringify({ schema: SCHEMA, task: "1167", status: "FAILED", reason: "parent-unexpected-exception",
    productAcceptance: false, release_acceptance: false, nativeHostSupport: false, qualifiedFake: false,
    stages: rec.stages, assertions: rec.totals(), errors: rec.errors }, null, 2)}\n`);
  process.exitCode = 1;
}

const argv = process.argv.slice(2);
if (argv.length === 0) await parentOrFailedReceipt();
else if (argv.length === 2 && argv[0] === "--child" && argv[1] === "normal") await childNormal();
else if (argv.length === 2 && argv[0] === "--child" && argv[1] === "extra-leaf") await childExtraLeaf();
else { process.stderr.write("usage: node tests/dispatch/windows-fake-cmux-acceptance.mjs (no arguments)\n"); process.exitCode = 2; }
