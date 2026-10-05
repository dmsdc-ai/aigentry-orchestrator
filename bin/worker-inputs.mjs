#!/usr/bin/env node
// worker-inputs.mjs - stage / verify / test a worker's declared input snapshot (#1172).
//
// One plan, one validator, three commands. Node builtins only: no network, no
// dependency, no shell. The plan is hand-declared, so a verified snapshot proves
// only that the DECLARED files are byte-exact - never that they are every input
// the project needs ("coverage": "declared-inputs-only"). Verification is a
// point-in-time check, not a lock and not a permission boundary.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const USAGE = `worker-inputs.mjs - declared worker input snapshots (#1172)

Usage:
  worker-inputs.mjs stage  --source DIR --plan FILE --dest DIR
  worker-inputs.mjs verify --root DIR --manifest FILE --sha256 HASH
  worker-inputs.mjs test   --root DIR --manifest FILE --sha256 HASH
  worker-inputs.mjs --help

Plan (JSON, at most 1 MiB, no other keys):
  {"version": 1,
   "files": [{"path": "src/a.mjs", "sha256": "<64 lowercase hex>", "mode": 420|493}, ...],
   "tests": ["tests/a.test.mjs", ...]}
  path   POSIX-relative; no absolute/drive/UNC, backslash, ':', '.', '..', empty
         segment or control character. Spaces and unicode are fine. Unique,
         including case-insensitively; a file may not also be a directory.
  mode   420 (0644) or 493 (0755). Files must be non-empty; at most 5000 files
         and 64 MiB in total.
  tests  non-empty explicit list; each a listed .test.mjs/.test.js file, unique,
         no glob characters. There is no inferred or whole-suite selection.

stage   Validates the whole plan and hashes every listed source file (regular
        files only, no symlink at the source root, an ancestor or a leaf) before
        creating anything. DEST must not exist and must not overlap SOURCE. Only
        listed files are read. Writes DEST/repo/<path> read-only (0444, or 0555
        for mode 493) and DEST/manifest.json last; on failure removes only what
        it created. Prints root, manifest, manifestSha256, counts, coverage.
        Symlinks: the root itself and every ancestor/leaf INSIDE the root are
        refused; the root's host ancestors (e.g. the macOS /var -> /private/var
        alias) resolve normally and are not checked or confined.
verify  Rehashes the snapshot at --root against --manifest, whose own SHA-256
        must equal --sha256. Missing, changed and extra entries, symlinks and
        non-files fail. On POSIX a mode wider than 0444/0555 fails; on Windows
        POSIX modes are not observable and the mode check is reported skipped.
        Mutates nothing. A point-in-time declaration check: it grants no
        sandbox authority and is not a lock.
test    Runs verify, then \`node --test <manifest tests>\` at --root (no shell,
        inherited stdio) and exits with the test process's own status. No
        retry, no skip, no whole-suite fallback. This selects what runs; it does
        not restrict anything else an already-authorized worker may run. Source
        JS test files only: nothing is built (no TypeScript compile).

Results are one compact JSON line (stdout on success; stderr on failure and for
test). Exit: 0 ok, 1 refused/invalid, 2 usage, test = the test process status.
`;

const MAX_FILES = 5000;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_PLAN = 1024 * 1024;
const MAX_PATH = 1024;
const COVERAGE = "declared-inputs-only";
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const IS_WIN = process.platform === "win32";

class Refusal extends Error {
  constructor(code, where) {
    super(code);
    this.code = code;
    this.where = where;
  }
}

/** A path for an error message: bounded, escaped, never file content. */
const shown = (p) => JSON.stringify(String(p).slice(0, 200));
const refuse = (code, where) => { throw new Refusal(code, where === undefined ? undefined : shown(where)); };

// -- shared validation -------------------------------------------------------
function checkRelPath(p) {
  if (typeof p !== "string" || p === "" || p.length > MAX_PATH) refuse("PATH_INVALID", typeof p === "string" ? p : "<non-string>");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) refuse("PATH_CONTROL_CHAR", p.replace(/[\x00-\x1f\x7f]/g, "?"));
  if (p.includes("\\")) refuse("PATH_BACKSLASH", p);
  if (p.startsWith("/")) refuse("PATH_ABSOLUTE", p);
  if (p.includes(":")) refuse("PATH_DRIVE_OR_STREAM", p);
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") refuse("PATH_SEGMENT", p);
  }
}

const foldKey = (p) => p.normalize("NFC").toLowerCase();

/** The one plan/manifest validator (stage and verify both use it). */
function validatePlan(plan) {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) refuse("PLAN_NOT_OBJECT");
  const keys = Object.keys(plan).sort().join(",");
  if (keys !== "files,tests,version") refuse("PLAN_KEYS");
  if (plan.version !== 1) refuse("PLAN_VERSION");
  if (!Array.isArray(plan.files) || plan.files.length === 0) refuse("PLAN_FILES_EMPTY");
  if (plan.files.length > MAX_FILES) refuse("PLAN_TOO_MANY_FILES");
  const exact = new Map();
  const folded = new Set();
  for (const f of plan.files) {
    if (f === null || typeof f !== "object" || Array.isArray(f) || Object.keys(f).sort().join(",") !== "mode,path,sha256") {
      refuse("PLAN_FILE_KEYS");
    }
    checkRelPath(f.path);
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) refuse("PLAN_SHA256", f.path);
    if (f.mode !== 420 && f.mode !== 493) refuse("PLAN_MODE", f.path);
    const key = foldKey(f.path);
    if (exact.has(f.path) || folded.has(key)) refuse("PLAN_DUPLICATE_PATH", f.path);
    exact.set(f.path, f);
    folded.add(key);
  }
  // A listed file may not also be the directory of another listed file.
  for (const p of exact.keys()) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) {
      if (folded.has(foldKey(segs.slice(0, i).join("/")))) refuse("PLAN_FILE_DIR_COLLISION", p);
    }
  }
  if (!Array.isArray(plan.tests) || plan.tests.length === 0) refuse("PLAN_TESTS_EMPTY");
  const seen = new Set();
  for (const t of plan.tests) {
    if (typeof t !== "string") refuse("PLAN_TEST_INVALID", "<non-string>");
    if (seen.has(t)) refuse("PLAN_TEST_DUPLICATE", t);
    seen.add(t);
    if (!exact.has(t)) refuse("PLAN_TEST_NOT_LISTED", t);
    if (!t.endsWith(".test.mjs") && !t.endsWith(".test.js")) refuse("PLAN_TEST_SUFFIX", t);
    if (/[*?[\]{}!]/.test(t)) refuse("PLAN_TEST_GLOB_CHAR", t);
  }
  return exact;
}

/** Bounded read of a small regular non-symlink file (plan or manifest). */
function readSmallFile(file, code) {
  let st;
  try { st = fs.lstatSync(file); } catch { refuse(`${code}_MISSING`, file); }
  if (!st.isFile()) refuse(`${code}_NOT_REGULAR`, file);
  if (st.size > MAX_PLAN) refuse(`${code}_TOO_LARGE`, file);
  return readRegular(file, MAX_PLAN, code);
}

/** Open without following a leaf symlink, confirm a regular file, read all of it. */
function readRegular(file, limit, code) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch {
    refuse(`${code}_UNREADABLE`, file);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) refuse(`${code}_NOT_REGULAR`, file);
    if (st.size > limit) refuse(`${code}_TOO_LARGE`, file);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n === 0) refuse(`${code}_CHANGED_DURING_READ`, file);
      off += n;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) refuse(`${code}_CHANGED_DURING_READ`, file);
    return { buf, mode: st.mode };
  } finally {
    fs.closeSync(fd);
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function parseJson(buf, code, where) {
  try { return JSON.parse(buf.toString("utf8")); } catch { return refuse(code, where); }
}

/** The root must be a real directory, itself not a symlink. */
function checkRoot(dir, code) {
  let st;
  try { st = fs.lstatSync(dir); } catch { refuse(`${code}_MISSING`, dir); }
  if (st.isSymbolicLink()) refuse(`${code}_SYMLINK`, dir);
  if (!st.isDirectory()) refuse(`${code}_NOT_DIRECTORY`, dir);
}

/** Every directory between root and the leaf must be a real directory. */
function checkAncestors(root, rel, code) {
  const segs = rel.split("/");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { refuse(`${code}_MISSING`, rel); }
    if (st.isSymbolicLink()) refuse(`${code}_SYMLINK_ANCESTOR`, rel);
    if (!st.isDirectory()) refuse(`${code}_ANCESTOR_NOT_DIRECTORY`, rel);
  }
  const leaf = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(leaf); } catch { refuse(`${code}_MISSING`, rel); }
  if (st.isSymbolicLink()) refuse(`${code}_SYMLINK`, rel);
  if (!st.isFile()) refuse(`${code}_NOT_REGULAR`, rel);
  return leaf;
}

/** Hash every listed file under root; returns the approved bytes, in plan order. */
function hashListed(root, plan, code) {
  let total = 0;
  const out = [];
  for (const f of plan.files) {
    const leaf = checkAncestors(root, f.path, code);
    const { buf, mode } = readRegular(leaf, MAX_TOTAL - total, code);
    if (buf.length === 0) refuse(`${code}_EMPTY`, f.path);
    total += buf.length;
    if (total > MAX_TOTAL) refuse("PLAN_TOO_LARGE");
    if (sha256(buf) !== f.sha256) refuse(`${code}_HASH_MISMATCH`, f.path);
    out.push({ f, buf, mode });
  }
  return { out, total };
}

const overlaps = (a, b) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  const rel1 = path.relative(x, y);
  const rel2 = path.relative(y, x);
  const inside = (r) => r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
  return inside(rel1) || inside(rel2);
};

function snapshotMode(planMode) {
  return planMode === 493 ? 0o555 : 0o444;
}

function manifestBytes(plan) {
  const normalized = {
    version: 1,
    files: plan.files.map((f) => ({ path: f.path, sha256: f.sha256, mode: f.mode })),
    tests: [...plan.tests],
  };
  return Buffer.from(JSON.stringify(normalized, null, 2) + "\n", "utf8");
}

// -- verify ------------------------------------------------------------------
function verify(opts) {
  const hash = opts.sha256;
  if (!/^[0-9a-f]{64}$/.test(hash)) refuse("SHA256_ARG_INVALID");
  const root = path.resolve(opts.root);
  const manifestFile = path.resolve(opts.manifest);
  const { buf } = readSmallFile(manifestFile, "MANIFEST");
  if (sha256(buf) !== hash) refuse("MANIFEST_SHA256_MISMATCH", manifestFile);
  const plan = parseJson(buf, "MANIFEST_NOT_JSON", manifestFile);
  const listed = validatePlan(plan);
  checkRoot(root, "ROOT");

  // Walk the root without following anything: every entry must be a listed file
  // or a directory on the way to one.
  const dirs = new Set();
  for (const p of listed.keys()) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  let seen = 0;
  const walk = (rel) => {
    for (const name of fs.readdirSync(rel ? path.join(root, rel) : root)) {
      const r = rel ? `${rel}/${name}` : name;
      if (++seen > MAX_FILES + dirs.size) refuse("SNAPSHOT_EXTRA_ENTRY", r);
      const st = fs.lstatSync(path.join(root, r));
      if (st.isSymbolicLink()) refuse("SNAPSHOT_SYMLINK", r);
      if (st.isDirectory()) {
        if (!dirs.has(r)) refuse("SNAPSHOT_EXTRA_ENTRY", r);
        walk(r);
      } else if (st.isFile()) {
        if (!listed.has(r)) refuse("SNAPSHOT_EXTRA_ENTRY", r);
      } else {
        refuse("SNAPSHOT_NOT_REGULAR", r);
      }
    }
  };
  walk("");

  const { out, total } = hashListed(root, plan, "SNAPSHOT");
  if (!IS_WIN) {
    for (const { f, mode } of out) {
      if ((mode & 0o7777 & ~snapshotMode(f.mode)) !== 0) refuse("SNAPSHOT_MODE_WIDENED", f.path);
    }
  }
  return {
    plan,
    result: {
      ok: true, command: "verify", root, files: plan.files.length, tests: plan.tests.length, bytes: total,
      modeCheck: IS_WIN ? "skipped-win32" : "posix", coverage: COVERAGE,
    },
  };
}

// -- stage -------------------------------------------------------------------
function stage(opts) {
  const source = path.resolve(opts.source);
  const dest = path.resolve(opts.dest);
  const planFile = path.resolve(opts.plan);
  const { buf } = readSmallFile(planFile, "PLAN");
  const plan = parseJson(buf, "PLAN_NOT_JSON", planFile);
  validatePlan(plan);

  checkRoot(source, "SOURCE");
  try {
    fs.lstatSync(dest);
    refuse("DEST_EXISTS", dest);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    if (e.code !== "ENOENT") refuse("DEST_UNREADABLE", dest);
  }
  let destParent;
  try {
    destParent = fs.realpathSync(path.dirname(dest));
  } catch {
    refuse("DEST_PARENT_MISSING", path.dirname(dest));
  }
  const realDest = path.join(destParent, path.basename(dest));
  if (overlaps(fs.realpathSync(source), realDest) || overlaps(source, dest)) refuse("SOURCE_DEST_OVERLAP", dest);

  // Every byte is validated before the destination exists.
  const { out } = hashListed(source, plan, "SOURCE");

  try {
    fs.mkdirSync(dest);
  } catch {
    refuse("DEST_CREATE_FAILED", dest);
  }
  const created = [];
  const createdDirs = [dest];
  const repo = path.join(dest, "repo");
  const manifestFile = path.join(dest, "manifest.json");
  try {
    fs.mkdirSync(repo);
    createdDirs.push(repo);
    for (const { f, buf: bytes } of out) {
      const segs = f.path.split("/");
      let cur = repo;
      for (let i = 0; i < segs.length - 1; i++) {
        cur = path.join(cur, segs[i]);
        if (!fs.existsSync(cur)) {
          fs.mkdirSync(cur);
          createdDirs.push(cur);
        }
      }
      writeExclusive(path.join(repo, f.path), bytes, snapshotMode(f.mode), created);
    }
    const mbytes = manifestBytes(plan);
    writeExclusive(manifestFile, mbytes, 0o444, created);
    const manifestSha256 = sha256(mbytes);
    // The completed snapshot must pass the same verify a consumer runs.
    verify({ root: repo, manifest: manifestFile, sha256: manifestSha256 });
    return {
      ok: true, command: "stage", root: repo, manifest: manifestFile, manifestSha256,
      files: plan.files.length, tests: plan.tests.length, coverage: COVERAGE,
    };
  } catch (e) {
    const cleaned = cleanup(created, createdDirs);
    const err = e instanceof Refusal ? e : new Refusal("STAGE_WRITE_FAILED", shown(dest));
    err.incomplete = true;
    err.cleaned = cleaned;
    throw err;
  }
}

function writeExclusive(file, bytes, mode, created) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  created.push(file);
  try {
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/** Best-effort removal of exactly what this run created, newest first. */
function cleanup(files, dirs) {
  let ok = true;
  for (const f of files.reverse()) {
    try {
      if (IS_WIN) fs.chmodSync(f, 0o600);
      fs.unlinkSync(f);
    } catch {
      ok = false;
    }
  }
  for (const d of dirs.reverse()) {
    try { fs.rmdirSync(d); } catch { ok = false; }
  }
  return ok;
}

// -- test --------------------------------------------------------------------
function runTests(opts) {
  const { plan, result } = verify(opts);
  // An enclosing node:test run exports NODE_TEST_CONTEXT; inherited, it makes the
  // child report to that parent instead of running as a fresh test process, and
  // exit 0 without executing the declared tests. Drop it; keep all other env.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test", ...plan.tests.map((t) => `./${t}`)], {
    cwd: result.root, shell: false, stdio: "inherit", env: childEnv,
  });
  if (r.error) {
    emit(process.stderr, { ok: false, command: "test", error: "TEST_SPAWN_FAILED", detail: shown(r.error.code || "error") });
    return 1;
  }
  emit(process.stderr, { ok: r.status === 0, command: "test", status: r.status, signal: r.signal, tests: plan.tests.length, coverage: COVERAGE });
  if (r.signal) {
    process.kill(process.pid, r.signal);
    return 1;
  }
  return r.status ?? 1;
}

// -- CLI ---------------------------------------------------------------------
const FLAGS = {
  stage: ["--source", "--plan", "--dest"],
  verify: ["--root", "--manifest", "--sha256"],
  test: ["--root", "--manifest", "--sha256"],
};

function emit(stream, obj) {
  stream.write(JSON.stringify(obj) + "\n");
}

function usageError(command, msg) {
  emit(process.stderr, { ok: false, command, error: "USAGE", detail: msg });
  process.stderr.write("see: worker-inputs.mjs --help\n");
  return 2;
}

function parse(command, argv) {
  const want = FLAGS[command];
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!want.includes(flag)) return { error: `unknown argument ${shown(flag)}` };
    if (argv[i + 1] === undefined || argv[i + 1] === "") return { error: `${flag} needs a value` };
    const key = flag.slice(2);
    if (Object.hasOwn(opts, key)) return { error: `${flag} given twice` };
    opts[key] = argv[i + 1];
  }
  for (const flag of want) if (!Object.hasOwn(opts, flag.slice(2))) return { error: `${flag} is required` };
  return { opts };
}

function main(argv) {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (!Object.hasOwn(FLAGS, command)) return usageError(null, `unknown command ${shown(command)}`);
  if (argv.slice(1).some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { opts, error } = parse(command, argv.slice(1));
  if (error) return usageError(command, error);
  try {
    if (command === "stage") emit(process.stdout, stage(opts));
    else if (command === "verify") emit(process.stdout, verify(opts).result);
    else return runTests(opts);
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) {
      emit(process.stderr, { ok: false, command, error: "INTERNAL", detail: shown(e && e.code ? e.code : "error") });
      return 1;
    }
    const out = { ok: false, command, error: e.code };
    if (e.where !== undefined) out.path = e.where;
    if (e.incomplete) { out.incomplete = true; out.cleaned = e.cleaned; }
    emit(process.stderr, out);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
