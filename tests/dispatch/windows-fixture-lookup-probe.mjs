// windows-fixture-lookup-probe.mjs — #1167 diagnostic only (H1/H2 causal reproduction).
//
// Question: can an extensionless Node fake (the model-router fixture's `cmux` shape:
// first line `#!/usr/bin/env node`) be resolved and executed on win32 through the same
// spawnSync-without-shell pattern that src/session/agent-metadata.ts uses?
//
//   A  bare unique extensionless name       spawnSync(name,          ["capabilities"])
//   B  absolute extensionless path           spawnSync(fakePath,      ["capabilities"])
//   C  positive control                      spawnSync(process.execPath, [fakePath, "capabilities"])
//
// Predicted (not assumed): A → ENOENT (H1: no-shell lookup ignores PATHEXT and never
// tries the bare file); B → ENOENT or EINVAL (lookup/exec refusal); C → exit 0 with the
// per-run marker and exact argv. Anything else is reported as unexpected, never PASS.
//
// Stdlib only. No product import, no shell, no network, no cmux/telepty/provider/auth.
// The fake only prints one fixed sentinel JSON line; it creates no files or processes.
// Scratch lives in a fresh mkdtemp dir under an explicit RUNNER_TEMP and is removed file
// by file (never recursive, never a parent, never through a link).
//
// One JSON receipt on stdout. Exit: 0 predicted triple observed (diagnostic only),
// 1 unexpected A/B observation, 2 harness invalid (control/timeout/missing measure),
// 3 unsupported platform, 4 precondition refused, 5 cleanup failure.
// release_acceptance / productAcceptance / nativeHostSupport are always false.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const OPERATION = "nr1167xj-fake-lookup-v1";
const SENTINEL = "aigentry-1167-fake-lookup-sentinel-v1";
const ARGS = ["capabilities"];
const CHILD_TIMEOUT_MS = 5000;
const CHILD_MAX_BUFFER = 64 * 1024;
const PATHEXT = ";.EXE;.CMD;.BAT;.COM";
const ENV_ALLOW = ["SystemRoot", "WINDIR", "ComSpec"];
// Fixed relative inputs from the current checkout, hashed only (never imported or run).
// `expectedLf` is the sha256 of the analysed source (23a5be1, LF bytes); a CRLF checkout
// is compared after CRLF→LF normalisation and both hashes are recorded.
const SOURCES = [
  { rel: "src/session/agent-metadata.ts", expectedLf: "4b9e73514f34dc5c58a21e40dd6894ab0b208524d2e8d3b01b1fec3b2086ce99" },
  { rel: "tests/dispatch/model-router-fixtures.ts", expectedLf: "3e0e0ddba673d5ee07be41abab92e2e4bb2fd6d7179f003f55ddc9e2e0a37a33" },
];
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const receipt = {
  schema: 1,
  operation: OPERATION,
  status: "diagnostic_incomplete",
  exitCode: null,
  reasons: [],
  release_acceptance: false,
  productAcceptance: false,
  nativeHostSupport: false,
  diagnosticOnly: true,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  probeCommit: { provided: null, valid: false },
  probe: null,
  sources: [],
  env: null,
  cases: {},
  prediction: null,
  cleanup: { attempted: false, ok: null, failed: [] },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const lfOnly = (buf) => Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1");

function hashFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error("not-regular-file");
  const raw = fs.readFileSync(file);
  return { bytes: raw.length, sha256: sha256(raw), sha256Lf: sha256(lfOnly(raw)) };
}

/** Sources, own hash and PROBE_COMMIT. Missing measures and source mismatches are recorded as reasons. */
function correlate() {
  try {
    receipt.probe = hashFile(fileURLToPath(import.meta.url));
  } catch {
    receipt.probe = { error: "unreadable" };
    receipt.reasons.push("probe-hash-missing");
  }
  const root = process.cwd();
  for (const { rel, expectedLf } of SOURCES) {
    try {
      const h = hashFile(path.join(root, ...rel.split("/")));
      receipt.sources.push({ path: rel, ...h, matchesAnalysedLf: h.sha256Lf === expectedLf });
      if (h.sha256Lf !== expectedLf) receipt.reasons.push("source-hash-mismatch");
    } catch {
      receipt.sources.push({ path: rel, error: "unreadable" });
      receipt.reasons.push("source-hash-missing");
    }
  }
  const commit = process.env.PROBE_COMMIT;
  if (typeof commit === "string" && COMMIT_RE.test(commit)) {
    receipt.probeCommit = { provided: commit, valid: true };
  } else {
    receipt.probeCommit = { provided: null, valid: false };
    receipt.reasons.push("probe-commit-missing-or-invalid");
  }
}

/** Explicit RUNNER_TEMP: absolute, an existing real directory (no link). Else null. */
function runnerTemp() {
  const t = process.env.RUNNER_TEMP;
  if (typeof t !== "string" || t === "" || t.includes("\0") || !path.isAbsolute(t)) return null;
  try {
    const st = fs.lstatSync(t);
    return st.isDirectory() && !st.isSymbolicLink() ? t : null;
  } catch {
    return null;
  }
}

/** Fresh allowlisted child env; Windows names matched case-insensitively. */
function childEnv(bin) {
  const env = {};
  for (const want of ENV_ALLOW) {
    const hit = Object.keys(process.env).find((k) => k.toUpperCase() === want.toUpperCase());
    if (hit !== undefined && typeof process.env[hit] === "string") env[want] = process.env[hit];
  }
  env.PATH = [bin, path.dirname(process.execPath)].join(";");
  env.PATHEXT = PATHEXT;
  return env;
}

function fakeBody(marker) {
  return "#!/usr/bin/env node\n" +
    `process.stdout.write(JSON.stringify({ sentinel: ${JSON.stringify(SENTINEL)}, ` +
    `marker: ${JSON.stringify(marker)}, argv: process.argv.slice(2) }) + "\\n");\n`;
}

/** Bounded, sanitised observation: codes, counts and booleans only — no paths/output. */
function run(file, args, opts, marker) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(file, args, opts);
  const elapsedMs = Number((process.hrtime.bigint() - t0) / 1000000n);
  const rawCode = r.error ? r.error.code : undefined;
  const errorCode = rawCode === undefined ? null : ERROR_CODE_RE.test(String(rawCode)) ? String(rawCode) : "UNRECOGNISED";
  const errno = r.error && Number.isInteger(r.error.errno) ? r.error.errno : null;
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  let sentinelMatch = false, markerMatch = false, argvMatch = false;
  try {
    const out = JSON.parse(stdout.trim());
    sentinelMatch = out !== null && typeof out === "object" && out.sentinel === SENTINEL;
    markerMatch = sentinelMatch && out.marker === marker;
    argvMatch = sentinelMatch && Array.isArray(out.argv) &&
      out.argv.length === ARGS.length && out.argv.every((a, i) => a === ARGS[i]);
  } catch { /* not the sentinel; recorded as false */ }
  return {
    errorCode, errno, status: r.status, signal: r.signal,
    timedOut: errorCode === "ETIMEDOUT",
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    sentinelMatch, markerMatch, argvMatch, elapsedMs,
  };
}

const executed = (o) => o.errorCode === null && o.status === 0 && o.markerMatch;

function classify() {
  const { A, B, C } = receipt.cases;
  if (!A || !B || !C) return { exit: 2, status: "harness_invalid", reason: "case-missing" };
  if (A.timedOut || B.timedOut || C.timedOut) return { exit: 2, status: "harness_invalid", reason: "child-timeout" };
  const controlOk = C.errorCode === null && C.status === 0 && C.signal === null &&
    C.sentinelMatch && C.markerMatch && C.argvMatch;
  if (!controlOk) return { exit: 2, status: "harness_invalid", reason: "positive-control-invalid" };
  const aPredicted = A.errorCode === "ENOENT";
  const bPredicted = B.errorCode === "ENOENT" || B.errorCode === "EINVAL";
  receipt.prediction = {
    A: { predicted: "ENOENT", observedMatches: aPredicted, executedFake: executed(A) },
    B: { predicted: "ENOENT|EINVAL", observedMatches: bPredicted, executedFake: executed(B) },
    C: { predicted: "status0+marker+argv", observedMatches: true },
  };
  if (executed(A) || executed(B)) return { exit: 1, status: "unexpected", reason: "extensionless-fake-executed" };
  if (!aPredicted || !bPredicted) return { exit: 1, status: "unexpected", reason: "refusal-differs-from-prediction" };
  return { exit: 0, status: "predicted_reproduced", reason: "predicted-triple-observed" };
}

/** Removes only what this run created, leaf first; every failure is recorded. */
function cleanup(owned) {
  receipt.cleanup.attempted = true;
  const step = (name, fn) => {
    try { fn(); } catch { receipt.cleanup.failed.push(name); }
  };
  if (owned.fake) {
    step("fake", () => {
      const st = fs.lstatSync(owned.fake);
      if (!st.isFile()) throw new Error("not-regular-file");
      fs.unlinkSync(owned.fake);
    });
  }
  if (owned.bin) step("bin", () => fs.rmdirSync(owned.bin));
  if (owned.cwd) step("cwd", () => fs.rmdirSync(owned.cwd));
  if (owned.scratch) step("scratch", () => fs.rmdirSync(owned.scratch));
  receipt.cleanup.ok = receipt.cleanup.failed.length === 0;
}

function main() {
  correlate();
  if (process.platform !== "win32") return { exit: 3, status: "unsupported_platform", reason: "not-win32" };
  if (receipt.reasons.length !== 0) return { exit: 4, status: "precondition_refused", reason: "missing-measure" };
  const temp = runnerTemp();
  if (temp === null) return { exit: 4, status: "precondition_refused", reason: "runner-temp-invalid" };
  if (!path.isAbsolute(process.execPath)) return { exit: 4, status: "precondition_refused", reason: "exec-path-not-absolute" };

  const owned = {};
  try {
    owned.scratch = fs.mkdtempSync(path.join(temp, "aigentry-1167-lookup-"));
    owned.bin = path.join(owned.scratch, "bin");
    fs.mkdirSync(owned.bin);
    owned.cwd = path.join(owned.scratch, "cwd");
    fs.mkdirSync(owned.cwd);

    const name = "aigentry_fixture_" + randomBytes(12).toString("hex");
    const marker = randomBytes(16).toString("hex");
    // The name must be unresolvable anywhere else on the child PATH (node's own dir).
    const nodeDir = path.dirname(process.execPath);
    if (["", ".com", ".exe", ".cmd", ".bat"].some((ext) => fs.existsSync(path.join(nodeDir, name + ext)))) {
      return { exit: 2, status: "harness_invalid", reason: "name-collision" };
    }
    const fake = path.join(owned.bin, name);
    fs.writeFileSync(fake, fakeBody(marker), { flag: "wx" });
    owned.fake = fake;

    const env = childEnv(owned.bin);
    receipt.env = { keys: Object.keys(env).sort(), pathEntries: 2, pathext: PATHEXT };
    const opts = {
      cwd: owned.cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER, shell: false, windowsHide: true,
    };
    receipt.cases.A = run(name, ARGS, opts, marker);
    receipt.cases.B = run(fake, ARGS, opts, marker);
    receipt.cases.C = run(process.execPath, [fake, ...ARGS], opts, marker);
    return classify();
  } catch {
    return { exit: 2, status: "harness_invalid", reason: "probe-internal" };
  } finally {
    cleanup(owned);
  }
}

let outcome;
try {
  outcome = main();
} catch {
  outcome = { exit: 2, status: "harness_invalid", reason: "probe-internal" };
}
if (receipt.cleanup.attempted && receipt.cleanup.ok === false) {
  receipt.reasons.push("cleanup-failed");
  if (outcome.exit === 0) outcome = { exit: 5, status: "cleanup_failed", reason: "cleanup-failed" };
}
receipt.status = outcome.status;
receipt.exitCode = outcome.exit;
receipt.reasons.push(outcome.reason);
process.stdout.write(JSON.stringify(receipt) + "\n");
process.exitCode = outcome.exit;
