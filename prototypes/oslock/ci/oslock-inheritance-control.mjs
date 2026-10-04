// #1166 Windows inherited-handle mutation control for the P6 oslock test (builder-owned, CI only).
// Disposable test-control preparation/check ONLY: never edits the committed native input, the
// committed driver or the committed tester suite; never a product, install or release path.
//
//   prepare  Verify the committed clone (ROOT = this file's parent, i.e. prototypes/oslock) holds
//            the exact pinned sources, driver and candidate suite, then build a fresh OWNED copy
//            under --mut: input/ (oslock.c with the single line sa.bInheritHandle FALSE->TRUE),
//            ci/oslock-build.mjs (only the oslock.c bytes+sha pin changed), output/tests/oslock/
//            (only PINNED_SOURCES oslock.c sha changed, so C0 passes and the suite reaches P6) and
//            toolchain/ (mechanical copy of the already-installed locked node-gyp workspace).
//   run      Run the copied driver `test --run N` once (all mode, its own unchanged deadline) and
//            record its exit. The driver's own receipt/TAP/results stay raw. A zero exit (mutant
//            suite green) is a mismatch and exits non-zero; an expected non-zero is recorded only.
//   check    Judge both runs against the P6 inherited-handle oracle and write control-verdict.json.
//            PASS only if every condition holds in BOTH runs; anything else (including missing
//            evidence) is FAIL. All other failures are retained and classified, never counted.
//
// Usage (cwd anywhere; all dirs absolute or relative to cwd):
//   node ci/oslock-inheritance-control.mjs prepare --mut <fresh dir> --out <dir>
//   node ci/oslock-inheritance-control.mjs run --run 1|2 --mut <dir> --out <dir>
//   node ci/oslock-inheritance-control.mjs check --out <dir>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLONE = resolve(HERE, "..");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const ORIGINAL_C = "58af35ff2d3d02be41580ffa999d1d23e4ccbc0bc316466113b9bbf409b2f6cd";
const MUTANT_C = "5c3fc5e6f8069a9c0d171f488c7fe619d6e4769201f160f837040c705097c914";
// Committed bytes the mutant copy is derived from (exact), and the derived mutant bytes (exact).
const CLONE_PINS = {
  "input/native/oslock/binding.gyp": { bytes: 551, sha256: "98f5cbf34c9f4bbb8f831eaab4765393558b9b86e600cc820577b65bca1f75d8" },
  "input/native/oslock/oslock.c": { bytes: 23746, sha256: ORIGINAL_C },
  "input/proto/oslock-loader.mjs": { bytes: 2515, sha256: "1b8cc43eafd5efa27212ef8cbd18bc042c24d5c6ff40e55fa907c92573cacd44" },
  "input/proto/with-os-lock.mjs": { bytes: 4580, sha256: "dd72566e45691122951a8a3b8005fa191f71dcae344ac96836eff6ce7080b010" },
  "ci/oslock-build.mjs": { bytes: 23779, sha256: "f3a9b6a4fa6cfe7d83af9b877f934f489ffab81af1bb9928616b51259549e07c" },
  "output/tests/oslock/primitive.test.mjs": { bytes: 67553, sha256: "008128b675ee7e034b87f734a2aa3516da27190e329740f181b55f2652f632f0" },
  "output/tests/oslock/fixtures/child.mjs": { bytes: 9883, sha256: "22774849692936415c36f59272cee11bac518177f2b16fb80cf276392b95a229" },
  "output/tests/oslock/fixtures/worker.mjs": { bytes: 3621, sha256: "d0ca1c1e7abcb3aa22a6f0d89f16f13cf26b443f4638c59c9bb8a195a26e3605" },
  "toolchain/package.json": { bytes: 330, sha256: "7a4dc4f93a6aff74075068498eb8bd8434c7b5437adfd460fd1950757330b458" },
  "toolchain/package-lock.json": { bytes: 8479, sha256: "d82749f836a4a107b361cc1c746f2c90a23103eb38f971da0d326e1227d1baa3" },
};
const INPUT_TREE = Object.keys(CLONE_PINS).filter((p) => p.startsWith("input/")).sort();
const MUTANT_PINS = {
  "input/native/oslock/oslock.c": { bytes: 23745, sha256: MUTANT_C },
  "ci/oslock-build.mjs": { bytes: 23779, sha256: "3642cc55ca3aed4ac661a491fb77cec92897675061323044085cc79d333582c9" },
  "output/tests/oslock/primitive.test.mjs": { bytes: 67553, sha256: "f48717c1c8e85e030b2c95c6e66d5f445344dcf0667bce3f3785f8af04bcef82" },
};
// Each edit: exact unique old line -> new line (count verified == 1 before, 0 after).
const EDITS = {
  "input/native/oslock/oslock.c": {
    line: 371,
    from: "  sa.bInheritHandle = FALSE; /* never inherited by children */",
    to: "  sa.bInheritHandle = TRUE; /* never inherited by children */",
    // Hunk context of windows-inherit-control.patch (@@ -368,7 +368,7 @@), lines 368..374.
    context: [
      "  if (!wpath) return -1;",
      "  sa.nLength = sizeof sa;",
      "  sa.lpSecurityDescriptor = NULL;",
      null, // the edited line
      "  /* No FILE_SHARE_DELETE: the carrier cannot be deleted/renamed while held open.",
      "   * FILE_FLAG_OPEN_REPARSE_POINT: a final-component reparse point is opened as itself",
      "   * and rejected below instead of being followed. */",
    ],
  },
  "ci/oslock-build.mjs": {
    line: 34,
    from: `  "input/native/oslock/oslock.c": { bytes: 23746, sha256: "${ORIGINAL_C}" },`,
    to: `  "input/native/oslock/oslock.c": { bytes: 23745, sha256: "${MUTANT_C}" },`,
  },
  "output/tests/oslock/primitive.test.mjs": {
    line: 40,
    from: `  "input/native/oslock/oslock.c": "${ORIGINAL_C}",`,
    to: `  "input/native/oslock/oslock.c": "${MUTANT_C}",`,
  },
};
const COPY_AS_IS = [
  "input/native/oslock/binding.gyp", "input/proto/oslock-loader.mjs", "input/proto/with-os-lock.mjs",
  "output/tests/oslock/fixtures/child.mjs", "output/tests/oslock/fixtures/worker.mjs",
  "toolchain/package.json", "toolchain/package-lock.json",
];

// P6 oracle, tied to the mutant suite bytes f48717c1 (assertion lines unchanged from 008128b6).
const P6_CELLS = {
  "P6-close": "P6 no inheritance: grandchild spawned during hold, parent closes and exits",
  "P6-noclose": "P6 no inheritance: grandchild spawned during hold, parent exits without close and exits",
};
const P6_CONTROLS = "P6 negative controls: missing readiness, ignored stop and a grandchild-held lock are each detected";
const C0_PREFIX = "C0 manifest integrity:";
const ORACLE = {
  acquired: { line: 1230, message: "another process acquired while the grandchild still ran" },
  rename: { line: 1231, message: "no handle inherited by the grandchild" },
};
const WIN_SHARE_DENIAL = ["EPERM", "EBUSY", "EACCES"];
const WIN_DETACHED = { stdio: "inherit", detached: true };
const DRIVER_TEST_ENV = { OSLOCK_SUITE: "all", OSLOCK_P1_REPS: "20", OSLOCK_P2_REPS: "20" };
const EXPECT_NODE = "v20.20.2";
const ENV_KEYS = [
  "GITHUB_SHA", "GITHUB_REF", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_WORKFLOW", "GITHUB_JOB",
  "RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion",
];

class ControlError extends Error {}
function fail(msg) {
  throw new ControlError(msg);
}

let redactions = [];
function setRedactions(pairs) {
  const all = [];
  for (const [from, to] of pairs) {
    if (typeof from !== "string" || from.length < 4) continue;
    all.push([from, to], [from.replaceAll("\\", "/"), to], [from.replaceAll("\\", "\\\\"), to]);
  }
  redactions = all.sort((a, b) => b[0].length - a[0].length);
}
const sanitize = (s) => redactions.reduce((t, [from, to]) => t.split(from).join(to), String(s));

function measure(base, rel) {
  const abs = join(base, ...rel.split("/"));
  if (!lstatSync(abs, { throwIfNoEntry: false })?.isFile()) fail(`${rel}: missing or not a regular file`);
  const buf = readFileSync(abs);
  return { path: rel, bytes: buf.length, sha256: sha256(buf) };
}
function expectPin(m, pin, what) {
  if (m.bytes !== pin.bytes || m.sha256 !== pin.sha256) fail(`${what} ${m.path}: ${m.bytes} B ${m.sha256}, want ${pin.bytes} B ${pin.sha256}`);
  return m;
}
function listFiles(dir, base, found = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (ent.isDirectory()) listFiles(abs, base, found);
    else found.push(rel);
  }
  return found;
}
function environment() {
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k] ?? null]));
  const oslock = Object.keys(process.env).filter((k) => k.startsWith("OSLOCK_")).sort();
  return { selected: env, inheritedOslockKeys: oslock };
}
function nodeIdentity() {
  return { version: process.version, platform: process.platform, arch: process.arch, modules: process.versions.modules, napi: process.versions.napi };
}
function writeJson(out, name, obj) {
  writeFileSync(join(out, name), `${JSON.stringify(obj, (_k, v) => (typeof v === "string" ? sanitize(v) : v), 2)}\n`, { flag: "wx" });
}
function readJson(out, name) {
  const p = join(out, name);
  if (!lstatSync(p, { throwIfNoEntry: false })?.isFile()) return undefined;
  return JSON.parse(readFileSync(p, "utf8"));
}

// Mechanical copy of the installed toolchain workspace (files and symlinks as-is; nothing resolved).
function copyTree(src, dst, counts) {
  mkdirSync(dst);
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d, counts);
    else if (ent.isFile()) {
      copyFileSync(s, d, fsConstants.COPYFILE_EXCL);
      counts.files++;
    } else if (ent.isSymbolicLink()) {
      const target = readlinkSync(s);
      symlinkSync(target, d, lstatSync(s).isDirectory() ? "junction" : "file");
      counts.symlinks++;
    } else fail(`toolchain entry ${relative(CLONE, s)} is not a file, directory or symlink`);
  }
}

function applyEdit(rel, text) {
  const e = EDITS[rel];
  const nl = text.includes("\r\n") ? fail(`${rel}: CRLF bytes, refusing`) : "\n";
  const lines = text.split(nl);
  const count = lines.filter((l) => l === e.from).length;
  if (count !== 1) fail(`${rel}: expected exactly 1 line ${JSON.stringify(e.from)}, found ${count}`);
  if (lines[e.line - 1] !== e.from) fail(`${rel}: edit line is not at L${e.line}`);
  if (e.context) {
    const start = e.line - 1 - e.context.indexOf(null);
    e.context.forEach((want, i) => {
      if (want !== null && lines[start + i] !== want) fail(`${rel}: patch context mismatch at L${start + i + 1}`);
    });
  }
  lines[e.line - 1] = e.to;
  const out = lines.join(nl);
  if (out.split(nl).filter((l) => l === e.from).length !== 0) fail(`${rel}: old line still present`);
  return { text: out, edit: { line: e.line, from: e.from, to: e.to, occurrencesBefore: count, occurrencesAfter: 0 } };
}

function prepare(opts) {
  const mut = resolve(opts.mut);
  const out = resolve(opts.out);
  const inClone = relative(CLONE, mut);
  if (!inClone.startsWith("..") && !isAbsolute(inClone)) fail("--mut must be outside the committed clone");
  setRedactions([[mut, "<MUT>"], [CLONE, "<CLONE>"], [homedir(), "<HOME>"]]);
  const rec = { schema: "oslock-inheritance-control/1", step: "prepare", task: 1166, status: "failed", node: nodeIdentity(), environment: environment() };
  mkdirSync(out, { recursive: true });
  try {
    if (process.version !== EXPECT_NODE) fail(`node ${process.version} is not ${EXPECT_NODE}`);
    const haveInput = listFiles(join(CLONE, "input"), CLONE).sort();
    if (JSON.stringify(haveInput) !== JSON.stringify(INPUT_TREE)) fail(`committed input tree ${JSON.stringify(haveInput)} is not the 4 pinned sources`);
    rec.originalBefore = Object.entries(CLONE_PINS).map(([rel, pin]) => expectPin(measure(CLONE, rel), pin, "committed"));
    if (!lstatSync(join(CLONE, "toolchain", "node_modules", ".package-lock.json"), { throwIfNoEntry: false })?.isFile()) {
      fail("locked toolchain not installed in the clone (npm ci step must succeed first)");
    }
    mkdirSync(mut); // EEXIST: never reuse a previous copy
    for (const rel of [...COPY_AS_IS, ...Object.keys(EDITS)]) mkdirSync(join(mut, ...dirname(rel).split("/")), { recursive: true });
    for (const rel of COPY_AS_IS) copyFileSync(join(CLONE, ...rel.split("/")), join(mut, ...rel.split("/")), fsConstants.COPYFILE_EXCL);
    rec.edits = {};
    for (const rel of Object.keys(EDITS)) {
      const { text, edit } = applyEdit(rel, readFileSync(join(CLONE, ...rel.split("/")), "utf8"));
      writeFileSync(join(mut, ...rel.split("/")), text, { flag: "wx" });
      rec.edits[rel] = { ...edit, before: CLONE_PINS[rel], after: expectPin(measure(mut, rel), MUTANT_PINS[rel], "mutant") };
    }
    const counts = { files: 0, symlinks: 0 };
    copyTree(join(CLONE, "toolchain", "node_modules"), join(mut, "toolchain", "node_modules"), counts);
    rec.toolchainCopy = { from: "<CLONE>/toolchain/node_modules", to: "<MUT>/toolchain/node_modules", method: "copyFileSync/symlink as-is", ...counts };
    // Mutant copy: every file other than the 3 edited ones is byte-identical to the committed pin.
    rec.mutantAfter = Object.keys(CLONE_PINS).map((rel) => expectPin(measure(mut, rel), MUTANT_PINS[rel] ?? CLONE_PINS[rel], "mutant"));
    rec.originalAfter = Object.entries(CLONE_PINS).map(([rel, pin]) => expectPin(measure(CLONE, rel), pin, "committed (after)"));
    rec.status = "prepared";
  } catch (err) {
    rec.failure = err instanceof ControlError ? err.message : String(err?.stack ?? err);
  }
  writeJson(out, "control-prepare.json", rec);
  console.log(sanitize(`oslock-inheritance-control prepare: ${rec.status}${rec.failure ? ` - ${rec.failure}` : ""}`));
  return rec.status === "prepared" ? 0 : 1;
}

function runDriver(opts) {
  const mut = resolve(opts.mut);
  const out = resolve(opts.out);
  setRedactions([[mut, "<MUT>"], [out, "<OUT>"], [CLONE, "<CLONE>"], [homedir(), "<HOME>"]]);
  const driver = join(mut, "ci", "oslock-build.mjs");
  const args = [driver, "test", "--run", opts.run, "--out", out];
  const rec = {
    schema: "oslock-inheritance-control/1", step: `run-${opts.run}`, task: 1166, expectation: "non-zero (mutant suite must fail)",
    node: nodeIdentity(), environment: environment(), argv: [process.execPath, ...args], cwd: process.cwd(),
  };
  return new Promise((done) => {
    let driverSha;
    try {
      driverSha = expectPin(measure(mut, "ci/oslock-build.mjs"), MUTANT_PINS["ci/oslock-build.mjs"], "mutant driver");
    } catch (err) {
      rec.outcome = "precondition-failed";
      rec.failure = err.message;
      writeJson(out, `control-run-${opts.run}.json`, rec);
      done(1);
      return;
    }
    rec.driver = driverSha;
    const t0 = performance.now();
    // stdio passes through to the step log; the driver keeps its own TAP/receipt files.
    const child = spawn(process.execPath, args, { cwd: mut, env: process.env, shell: false, windowsHide: true, stdio: "inherit" });
    let spawnError = null;
    child.once("error", (e) => {
      spawnError = e;
    });
    child.once("close", (code, signal) => {
      Object.assign(rec, { exitCode: code, signal, spawnError: spawnError ? String(spawnError.code ?? spawnError.message) : null, durationMs: Math.round(performance.now() - t0) });
      // Recorded, never converted: a zero exit is the mismatch; non-zero is judged by `check`.
      rec.outcome = spawnError ? "spawn-error" : code === 0 ? "MISMATCH-mutant-suite-exited-0" : "nonzero-recorded-for-check";
      writeJson(out, `control-run-${opts.run}.json`, rec);
      console.log(`oslock-inheritance-control run ${opts.run}: driver exit ${code} signal ${signal} -> ${rec.outcome}`);
      done(rec.outcome === "nonzero-recorded-for-check" ? 0 : 1);
    });
  });
}

// ---- TAP (node:test tap reporter) ----
function unquote(v) {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replaceAll("''", "'");
  return s;
}
function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const tests = [];
  const stack = []; // open "# Subtest:" names by indent, for parent paths
  for (let i = 0; i < lines.length; i++) {
    const sub = lines[i].match(/^(\s*)# Subtest: (.*)$/);
    if (sub) {
      const depth = sub[1].length / 4;
      stack.length = depth;
      stack[depth] = sub[2];
      continue;
    }
    const m = lines[i].match(/^(\s*)(ok|not ok) (\d+) - (.*?)(?: # (SKIP|TODO)\b(.*))?$/);
    if (!m) continue;
    const indent = m[1].length;
    const depth = indent / 4;
    const t = { name: m[4], parents: stack.slice(0, depth), ok: m[2] === "ok", directive: m[5] ?? null, yaml: {} };
    if (lines[i + 1] === `${" ".repeat(indent + 2)}---`) {
      const ind = " ".repeat(indent + 2);
      let j = i + 2;
      for (; j < lines.length && lines[j] !== `${ind}...`; j++) {
        const kv = lines[j].match(new RegExp(`^${ind}(\\w+): ?(.*)$`));
        if (!kv) continue;
        if (kv[2] === "|-" || kv[2] === "|") {
          const block = [];
          while (j + 1 < lines.length && lines[j + 1].startsWith(`${ind}  `)) block.push(lines[++j].slice(ind.length + 2));
          t.yaml[kv[1]] = block.join("\n");
        } else t.yaml[kv[1]] = unquote(kv[2]);
      }
      i = j;
    }
    tests.push(t);
  }
  return tests;
}
const firstLine = (s) => String(s ?? "").split("\n")[0].slice(0, 300);
function failingLine(t) {
  const m = String(t.yaml.stack ?? "").match(/primitive\.test\.mjs:(\d+):\d+/);
  return m ? Number(m[1]) : null;
}

function judgeRun(out, n, build) {
  const r = { run: n, conditions: {}, failures: [], skipped: [] };
  const cond = (k, ok, detail) => {
    r.conditions[k] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) };
  };
  const ctl = readJson(out, `control-run-${n}.json`);
  const receipt = readJson(out, `run-${n}-receipt.json`);
  const tapPath = join(out, `run-${n}.tap`);
  const tap = lstatSync(tapPath, { throwIfNoEntry: false })?.isFile() ? readFileSync(tapPath, "utf8") : undefined;
  const results = readJson(out, `run-${n}-results.json`);
  cond("evidenceFilesPresent", ctl && receipt && tap !== undefined && results, {
    control: Boolean(ctl), receipt: Boolean(receipt), tap: tap !== undefined, results: Boolean(results),
  });
  if (!(ctl && receipt && tap !== undefined && results)) return r;

  const cmd = receipt.commands?.[0];
  cond("driverExitNonzeroNoTimeout", receipt.commands?.length === 1 && Number.isInteger(cmd?.exitCode) && cmd.exitCode !== 0 &&
    cmd.signal === null && cmd.timedOut === false && cmd.spawnError === null && ctl.exitCode !== 0 && ctl.outcome === "nonzero-recorded-for-check",
    { exitCode: cmd?.exitCode, signal: cmd?.signal, timedOut: cmd?.timedOut, spawnError: cmd?.spawnError, controlExit: ctl.exitCode });
  cond("receiptIsSuiteFailureOnly", receipt.mode === "test" && receipt.status === "failed" &&
    receipt.failure === `test run ${n} failed (exit ${cmd?.exitCode}, signal null, timedOut false)` && receipt.resultsFiles?.length === 1,
    { status: receipt.status, failure: receipt.failure, resultsFiles: receipt.resultsFiles?.length });
  const src = receipt.sources?.find((s) => s.path === "input/native/oslock/oslock.c");
  const tests = Object.fromEntries((receipt.tests ?? []).map((t) => [t.path, t.sha256]));
  cond("mutantBytesUsed", src?.sha256 === MUTANT_C && src?.bytes === 23745 && receipt.binary?.sha256 === build?.binary?.sha256 &&
    tests["output/tests/oslock/primitive.test.mjs"] === MUTANT_PINS["output/tests/oslock/primitive.test.mjs"].sha256 &&
    tests["output/tests/oslock/fixtures/child.mjs"] === CLONE_PINS["output/tests/oslock/fixtures/child.mjs"].sha256 &&
    tests["output/tests/oslock/fixtures/worker.mjs"] === CLONE_PINS["output/tests/oslock/fixtures/worker.mjs"].sha256,
    { oslockC: src?.sha256, binary: receipt.binary?.sha256, tests });
  cond("unchangedModeAndEnv", JSON.stringify(receipt.env) === JSON.stringify(DRIVER_TEST_ENV) && results.suite === "all" &&
    results.platform === "win32-x64" && results.node === EXPECT_NODE, { env: receipt.env, suite: results.suite, platform: results.platform, node: results.node });

  const parsed = parseTap(tap);
  const byName = (name) => parsed.filter((t) => t.name === name);
  const c0 = parsed.filter((t) => t.name.startsWith(C0_PREFIX));
  cond("C0passed", c0.length === 1 && c0[0].ok && c0[0].directive === null && results.integrity?.ok === true &&
    results.cases?.C0?.binarySha === build?.binary?.sha256, { tap: c0.map((t) => t.ok), integrityOk: results.integrity?.ok });

  r.cells = {};
  for (const [key, name] of Object.entries(P6_CELLS)) {
    const t = byName(name);
    const c = results.cases?.[key];
    const cell = { tapCount: t.length };
    r.cells[key] = cell;
    if (t.length !== 1 || !c) {
      cond(`${key}`, false, { reason: "test or results case missing", tapCount: t.length, case: Boolean(c) });
      continue;
    }
    const msg = firstLine(t[0].yaml.error);
    const line = failingLine(t[0]);
    Object.assign(cell, {
      tapOk: t[0].ok, failureType: t[0].yaml.failureType ?? null, code: t[0].yaml.code ?? null, error: msg, failingLine: line,
      acquiredMs: "acquiredMs" in c ? c.acquiredMs : "absent", renameWhileAlive: "renameWhileAlive" in c ? c.renameWhileAlive : "absent", selfOpened: c.selfOpened,
      spawnOptions: c.spawnOptions, grandchildPid: c.grandchildPid, cleanup: c.cleanup,
    });
    const which = msg === ORACLE.acquired.message && line === ORACLE.acquired.line ? "acquired"
      : msg === ORACLE.rename.message && line === ORACLE.rename.line ? "rename" : null;
    cell.failedOn = which;
    const reached = JSON.stringify(c.spawnOptions) === JSON.stringify(WIN_DETACHED) && c.selfOpened === false && Number.isInteger(c.grandchildPid);
    const consistent = which === "acquired" ? c.acquiredMs === null
      : which === "rename" ? typeof c.acquiredMs === "number" && WIN_SHARE_DENIAL.includes(c.renameWhileAlive) : false;
    const cleaned = c.cleanup?.exitLine === true && c.cleanup?.gone === true && c.cleanup?.teardownExit === false && c.cleanup?.probeError === undefined;
    cond(key, !t[0].ok && t[0].directive === null && t[0].yaml.failureType === "testCodeFailure" && t[0].yaml.code === "ERR_ASSERTION" &&
      which !== null && reached && consistent && cleaned, { failedOn: which, reached, consistent, cleaned });
  }
  const ctlT = byName(P6_CONTROLS);
  cond("P6negativeControlsStillPass", ctlT.length === 1 && ctlT[0].ok && ctlT[0].directive === null &&
    results.cases?.["P6-controls"]?.lock?.acquiredMs === null, { tap: ctlT.map((t) => t.ok) });
  cond("noUnconfirmedGrandchild", results.cases?.cleanup === undefined, results.cases?.cleanup ? { cleanup: results.cases.cleanup } : undefined);

  // Every other failure is retained and classified; none is ever counted toward PASS.
  for (const t of parsed) {
    if (t.directive) r.skipped.push({ name: t.name, directive: t.directive });
    if (t.ok) continue;
    const isCell = Object.values(P6_CELLS).includes(t.name);
    const cls = isCell ? (r.cells[Object.keys(P6_CELLS).find((k) => P6_CELLS[k] === t.name)]?.failedOn ? "oracle:P6-inherited-handle" : "MISMATCH:P6-other-failure")
      : t.yaml.failureType === "subtestsFailed" ? "aggregate:subtests-failed"
        : t.name === P6_CONTROLS ? "MISMATCH:P6-negative-control"
          : `retained:non-oracle:${t.yaml.failureType ?? "unknown"}`;
    r.failures.push({ class: cls, name: t.name, parents: t.parents, failureType: t.yaml.failureType ?? null, code: t.yaml.code ?? null, error: firstLine(t.yaml.error), failingLine: failingLine(t) });
  }
  r.tapSummary = receipt.tapSummary ?? null;
  r.pass = Object.values(r.conditions).every((x) => x.ok) && Object.keys(P6_CELLS).every((k) => r.conditions[k]?.ok);
  return r;
}

function check(opts) {
  const out = resolve(opts.out);
  setRedactions([[out, "<OUT>"], [CLONE, "<CLONE>"], [homedir(), "<HOME>"]]);
  const v = { schema: "oslock-inheritance-control/1", step: "check", task: 1166, verdict: "FAIL", node: nodeIdentity(), environment: environment() };
  try {
    const prep = readJson(out, "control-prepare.json");
    const build = readJson(out, "build-receipt.json");
    const csrc = build?.sources?.find((s) => s.path === "input/native/oslock/oslock.c");
    v.prepare = { ok: prep?.status === "prepared", status: prep?.status ?? "missing" };
    v.build = {
      ok: build?.mode === "build" && build?.status === "built" && csrc?.sha256 === MUTANT_C && csrc?.bytes === 23745 &&
        build?.binary?.header?.startsWith("4d5a") === true && build?.identity?.node?.version === EXPECT_NODE &&
        build?.toolchain?.nodeGyp?.version === "12.3.0",
      status: build?.status ?? "missing", oslockC: csrc?.sha256 ?? null, binary: build?.binary ?? null, failure: build?.failure ?? null,
    };
    v.runs = [1, 2].map((n) => judgeRun(out, n, build));
    v.verdict = v.prepare.ok && v.build.ok && v.runs.every((r) => r.pass) ? "PASS" : "FAIL";
  } catch (err) {
    v.failure = String(err?.stack ?? err);
  }
  v.evidenceLimitations = [
    "results JSON has no fields for parent exit code or post-parent heartbeats; they are derived from assertion order in the mutant suite f48717c1 (L1210-1231): a P6 failure at L1230/L1231 with acquiredMs/renameWhileAlive defined means ready was awaited, hold-spawn exited 0 and both beatAfter calls returned (any of those failing throws earlier with a different message/line)",
    "grandchild liveness during the checks = a beat with seq newer than the post-check call, from the nonce/pid-bound channel file; not an OS process query",
    "descendants gone = the suite's own process.kill(pid,0) ESRCH observation for each tracked grandchild plus no results 'cleanup' case; no broad process enumeration; hold-spawn parents are reaped by the suite; untracked descendants are not enumerated",
    "the oracle shows a carrier handle reaching a grandchild that never opened it (selfOpened=false) only when the handle is made inheritable; exact Windows job membership, kill trigger and lock-release-on-last-handle semantics are NOT measured",
    "detached:true also changes console (DETACHED_PROCESS) and process group (CREATE_NEW_PROCESS_GROUP), not only job assignment (libuv source); this control does not separate those",
    "own-open negative control (P6 'lock') alone does not prove inherited-handle detection; only the FALSE->TRUE mutant failing P6 does",
    "isolated prototype validation only; no release, adoption or production claim",
  ];
  writeJson(out, "control-verdict.json", v);
  console.log(`oslock-inheritance-control check: ${v.verdict}`);
  for (const r of v.runs ?? []) {
    for (const [k, c] of Object.entries(r.conditions)) if (!c.ok) console.log(`  run ${r.run} FAILED condition ${k}: ${sanitize(JSON.stringify(c.detail ?? {}))}`);
  }
  return v.verdict === "PASS" ? 0 : 1;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const allowed = { prepare: ["--mut", "--out"], run: ["--run", "--mut", "--out"], check: ["--out"] }[mode];
  if (!allowed) fail("mode must be prepare, run or check");
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || rest[i + 1] === undefined) fail(`unexpected argument ${rest[i]}`);
    opts[rest[i].slice(2)] = rest[i + 1];
  }
  for (const k of allowed) if (opts[k.slice(2)] === undefined) fail(`${k} is required`);
  if (mode === "run" && opts.run !== "1" && opts.run !== "2") fail("--run must be 1 or 2");
  return { mode, opts };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`oslock-inheritance-control: ${err.message}`);
  process.exit(2);
}
const { mode, opts } = parsed;
process.exitCode = mode === "prepare" ? prepare(opts) : mode === "run" ? await runDriver(opts) : check(opts);
