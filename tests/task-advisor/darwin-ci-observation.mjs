/**
 * Task 1161 / dm1161hi — Darwin storage-provenance observation harness for a
 * disposable macOS CI runner.
 *
 * WHAT THIS IS
 * ------------
 * The acceptance/evidence half of a coupled pair. Its caller is
 * `.github/workflows/advisor-darwin-observation.yml`; neither file is useful
 * alone. It carries forward the four inherited REAL assertions from
 * `at1161ai`'s `darwin-real.test.mjs`, adapting ONLY:
 *   - the root (an owned copy under `RUNNER_TEMP`, never a user HOME, never the
 *     checked-out fixture);
 *   - the helper architecture locator (resolved from the MEASURED
 *     `process.arch`; the prior arm64 binary is not supplied and is never
 *     assumed).
 *
 * WHY IT EXISTS
 * -------------
 * `dr1161as` ran the same candidate on a confined host. Four REAL tests passed
 * but every observation was `unsupported` / `unknown` / unbound volume, which
 * source mapping attributes to `DASessionCreate` returning NULL
 * (native/task-advisor-storage/darwin.c:106). The CAUSE IS UNKNOWN. It was not
 * shown to be a sandbox denial, a Mach-service denial, or anything else. This
 * harness re-takes the same measurement on an ordinary macOS runner so that the
 * two observations can be compared, and it records — as data, not as a verdict —
 * whether the new result discriminates the prior NULL.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 *   - It qualifies NOTHING. A green run means "the observation was taken", never
 *     "the platform is qualified". `unsupported`, `denied` and `unknown` are
 *     recorded outcomes, not failures to route around, and equally not passes.
 *   - It never enumerates or mounts a device, never reads a user file, never
 *     elevates, never installs, never touches the network, and never writes to
 *     the repository working tree or the (empty) qualification catalog.
 *   - It never prints or persists a raw device identifier. Child streams are
 *     captured in memory and redacted before anything is written. Only equality
 *     relations and salted digest prefixes survive.
 *   - It does not require a hosted VM to classify as `local-fixed`. Whatever the
 *     runner's volume actually reports is what is recorded, and no test requires
 *     any particular classification in order to pass.
 *
 * ON "OWN PATHS"
 * --------------
 * Every path this harness creates lives under `RUNNER_TEMP`. That is NOT a claim
 * of being outside the runner account's home tree: on `macos-latest`,
 * `RUNNER_TEMP` is itself under `/Users/runner`. The narrower and true statement
 * is that nothing here writes to `$HOME` itself, to the invoking user's dotfiles,
 * to the checked-out repository, or to `os.tmpdir()`. `ownRootIsNotUserHomeItself`
 * records exactly that and nothing more.
 *
 * FAILURE DIRECTION
 * -----------------
 * Real assertions and real exit codes only; there is no catch-all `exit 0` and
 * no retry-to-green. A missing compiler, a failed build, a malformed protocol
 * line, a structural-validity break, a budget overrun or any mutation of the
 * immutable fixture FAILS the job and the failure evidence is still uploaded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ layout */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(path.dirname(HERE));           // tests/task-advisor -> tests -> repo
const FIXTURE_ROOT = path.join(REPO_ROOT, 'tests', 'fixtures', 'advisor-darwin');
const FIXTURE_PACKAGE = path.join(FIXTURE_ROOT, 'package');
const FIXTURE_MANIFEST = path.join(FIXTURE_ROOT, 'manifest.json');

/**
 * Every path this harness owns lives under `RUNNER_TEMP` with a stable, bounded
 * layout.
 *
 * This is refused at MODULE SCOPE, before any test, hook, copy, delete or
 * artifact write can run. An assertion inside a test would be too late: with an
 * empty or relative value, `path.join` yields the cwd-relative
 * `advisor-darwin-observation`, and `node --test` would carry on to stage a copy
 * and write evidence into the checked-out repository — the exact substitution
 * this scope forbids. There is no `os.tmpdir()`, HOME or repo-relative fallback;
 * a module-level throw means no evidence sink is reached, and the workflow's
 * `if-no-files-found: error` upload is then the honest outcome.
 */
const RUNNER_TEMP = process.env.RUNNER_TEMP ?? '';
if (RUNNER_TEMP === '' || !path.isAbsolute(RUNNER_TEMP)) {
  throw new Error(
    'RUNNER_TEMP must be an absolute path; refusing to run rather than falling back to '
    + 'os.tmpdir(), a real HOME, or a repo-relative path',
  );
}
const OWN_ROOT = path.join(RUNNER_TEMP, 'advisor-darwin-observation');
const OWN_PACKAGE = path.join(OWN_ROOT, 'package');     // writable COPY of the bundle
const OWN_TARGET = path.join(OWN_ROOT, 'probe-target'); // the one NEW directory we probe
const OWN_HOME = path.join(OWN_ROOT, 'home');           // child HOME, never the user's
const OWN_TMP = path.join(OWN_ROOT, 'tmp');             // child TMPDIR
const OWN_EVIDENCE = path.join(OWN_ROOT, 'evidence');

/**
 * The manifest addresses the bundle as `input/package/...`; CI stages it here.
 *
 * This prefix is STRICT and deliberately not a `/package/` substring search: a
 * loose match would silently accept a differently-rooted manifest describing a
 * different bundle. The controller has confirmed it stages the original manifest
 * `f964fe60…`, which uses exactly this prefix. A manifest with any other shape
 * must fail loudly here rather than be accommodated.
 */
const MANIFEST_PACKAGE_PREFIX = 'input/package/';

/** The manifest the controller confirmed it will stage. Recorded, not asserted. */
const EXPECTED_MANIFEST_SHA256 = 'f964fe60f14472502f9b5b70f5bfec0f7f76078431ac8bde0c9b69397d906129';

/** Exact runtime this job pins. A different runtime is a different measurement. */
const REQUIRED_NODE = 'v24.21.0';
const REQUIRED_PLATFORM = 'darwin';

/** Bounds. Nothing here may grow with the size of the machine it runs on. */
const HELPER_TIMEOUT_MS = 2_000;
const HELPER_MAX_OUTPUT_BYTES = 512;
const BUILD_TIMEOUT_MS = 180_000;
const BUILD_MAX_OUTPUT_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_OUTPUT_BYTES = 8 * 1024;
const TEXT_CAP = 2_000;
const MAX_FIXTURE_LEAVES = 4_096;

/** The inherited ceilings, restated so this file asserts against a literal. */
const MAX_WALL_MS = 3_000;
const MAX_BYTES_READ = 2 * 1_048_576;

/**
 * What `dr1161as` actually observed, restated for the discrimination record.
 *
 * `adapterEmitSha256` is the measured emit of THAT run, and it is the same emit
 * staged here. An earlier `ab1161ah` builder artifact (`b3b77408…`) exists but was
 * NOT what `dr1161as` measured, so there is no adapter difference between the two
 * runs and none is recorded. The confounds below are the dimensions that do differ
 * or are unmeasured; each is stated as a difference to be measured, not asserted.
 */
const PRIOR_OBSERVATION = Object.freeze({
  track: 'dr1161as',
  helperStatus: 'unsupported',
  adapterClassification: 'unknown',
  deviceBinding: 'node-only',
  devReported: 'u (unbound)',
  sourceMapping: 'darwin.c:106 DASessionCreate returned NULL -> refuse("unsupported")',
  cause: 'UNKNOWN — not established as a sandbox or Mach-service denial',
  darwinSourceSha256: 'd05617491b984c7106173c9586f801874cbb77e2819780001cea0deeacfd6f2a',
  adapterEmitSha256: '65a7570a5eb857c82865a24c3b2eb6e014c73219ccfd377b58cb6c8ab4e4de6e',
  helperSha256: 'e53ea60cedee29373ce9d6dc8435b5fc4045f89d170875b422eeaab2354b0cf8',
  helperBytes: 35048,
  arch: 'arm64',
  helperProvenance: 'prebuilt by ab1161ah and reused; NOT rebuilt by dr1161as',
});

/* ----------------------------------------------------------------- redaction */

/** Salted, truncated digest. A device number must never leave this process raw. */
const redact = (value) =>
  value === null || value === undefined
    ? null
    : 'REDACTED-sha256:' + createHash('sha256').update('dm1161hi|' + String(value)).digest('hex').slice(0, 12);

/**
 * Scrub captured child output before it can be retained. `dev=<digits>` is the
 * only device identifier the protocol can carry, and the absolute own-paths are
 * collapsed so the evidence stays stable and free of runner-local noise.
 */
function scrub(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text.replace(/\bdev=(-?\d+)/g, (_all, digits) => 'dev=' + redact(digits));
  if (RUNNER_TEMP.length > 0) out = out.split(RUNNER_TEMP).join('$RUNNER_TEMP');
  out = out.split(REPO_ROOT).join('$REPO');
  return out.length > TEXT_CAP ? out.slice(0, TEXT_CAP) + `…[+${out.length - TEXT_CAP}B]` : out;
}

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Marker written into the probed directory; it must never reach an artifact. */
const CANARY = 'CANARY-dm1161hi-' + createHash('sha256').update('canary|dm1161hi').digest('hex').slice(0, 16);

/**
 * Last gate before bytes leave the process. Every artifact is checked as the
 * exact string that will be written — not as an earlier in-memory snapshot — for
 * the canary and for any unredacted `dev=<digits>`. A hit throws rather than
 * writing, because a leaked identifier cannot be withdrawn once uploaded.
 */
function writeCheckedArtifact(file, contents) {
  if (contents.includes(CANARY)) {
    throw new Error(`refusing to write ${path.basename(file)}: probed-directory canary bytes are present`);
  }
  const raw = contents.match(/\bdev=-?\d+/);
  if (raw !== null) {
    throw new Error(`refusing to write ${path.basename(file)}: an unredacted device identifier is present`);
  }
  fs.writeFileSync(file, contents);
}

/** Sorted relative leaves of a tree, bounded so a surprise subtree cannot hang us. */
function leaves(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        assert.ok(found.length < MAX_FIXTURE_LEAVES, 'fixture tree exceeded the bounded leaf count');
        found.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  return found.sort();
}

const snapshot = (root) => Object.fromEntries(leaves(root).map((rel) => [rel, sha256File(path.join(root, rel))]));

/* ------------------------------------------------------------------ evidence */

const evidence = {
  harness: 'tests/task-advisor/darwin-ci-observation.mjs',
  task: 1161,
  track: 'dm1161hi',
  note:
    'Read-only metadata observation on a disposable CI runner. Device identifiers are '
    + 'redacted. This file is EVIDENCE ONLY: no outcome recorded here qualifies any '
    + 'platform, and the qualification catalog is neither read as authority nor modified.',
  runner: null,
  compiler: null,
  manifest: null,
  stage: null,
  build: null,
  api: null,
  helper: null,
  measured: null,
  refusals: null,
  costObserved: null,
  contentReadLimit: null,
  discrimination: null,
  fixtureIntegrity: null,
  qualification: 'NOT QUALIFIED — measurement observation only, per DISPATCH.',
};

/** Set by the staging/build tests and consumed by the observation tests. */
let helperFile = null;
let adapter = null;

/* --------------------------------------------------------------------- tests */

test('[CI] runner is the pinned macOS/Node context and owns its temp layout', () => {
  assert.equal(process.platform, REQUIRED_PLATFORM, 'this harness only measures Darwin; another platform is a mis-dispatch, not a skip');
  // RUNNER_TEMP was already enforced at module scope; these keep it in the record.
  assert.notEqual(RUNNER_TEMP, '', 'RUNNER_TEMP must be provided; falling back to a user HOME is forbidden');
  assert.ok(path.isAbsolute(RUNNER_TEMP), 'RUNNER_TEMP must be absolute');
  assert.equal(process.version, REQUIRED_NODE, 'the job pins one exact Node build');

  for (const dir of [OWN_ROOT, OWN_TARGET, OWN_HOME, OWN_TMP, OWN_EVIDENCE]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  evidence.runner = {
    platform: process.platform,
    processArch: process.arch,
    osRelease: os.release(),
    osType: os.type(),
    osMachine: typeof os.machine === 'function' ? os.machine() : null,
    nodeVersion: process.version,
    v8: process.versions.v8,
    ownRootUnderRunnerTemp: OWN_ROOT.startsWith(RUNNER_TEMP),
    ownRootIsNotRepo: !OWN_ROOT.startsWith(REPO_ROOT),
    // NOT a claim of being outside the runner account's home tree: on a hosted
    // macOS runner RUNNER_TEMP lives under /Users/runner, so the value below is
    // expected to be true while `OWN_ROOT.startsWith(os.homedir())` is ALSO true.
    // What is recorded is only that OWN_ROOT is not the home directory itself.
    ownRootIsNotUserHomeItself: os.homedir() === '' || path.resolve(OWN_ROOT) !== path.resolve(os.homedir()),
    ownRootIsInsideHomeTree: os.homedir() !== '' && OWN_ROOT.startsWith(os.homedir()),
  };
  assert.equal(evidence.runner.ownRootUnderRunnerTemp, true);
  assert.equal(evidence.runner.ownRootIsNotRepo, true);
  assert.equal(evidence.runner.ownRootIsNotUserHomeItself, true);
});

test('[CI] platform compiler is present and its identity is recorded', () => {
  // The builder script spawns `cc` itself; this only records which `cc` that is.
  // An absent compiler is recorded here and FAILS the build test below. It is
  // never a skip and never an install trigger.
  const probe = spawnSync('cc', ['--version'], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: OWN_HOME, TMPDIR: OWN_TMP },
  });
  const firstLine = typeof probe.stdout === 'string' ? probe.stdout.split('\n', 1)[0] : '';
  evidence.compiler = {
    available: !probe.error && probe.status === 0,
    status: probe.status,
    error: probe.error ? String(probe.error.message) : null,
    versionFirstLine: scrub(firstLine),
    stderr: scrub(typeof probe.stderr === 'string' ? probe.stderr.trim() : ''),
  };
  assert.equal(evidence.compiler.available, true, 'no platform compiler: recorded as BLOCKED, never skipped-as-pass');
});

test('[CI] immutable fixture bundle matches the supplied manifest', () => {
  assert.ok(fs.existsSync(FIXTURE_MANIFEST), 'controller must stage tests/fixtures/advisor-darwin/manifest.json');
  assert.ok(fs.existsSync(FIXTURE_PACKAGE), 'controller must stage tests/fixtures/advisor-darwin/package');

  const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, 'utf8'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest carries a non-empty file list');

  const checked = [];
  const mismatched = [];
  const missing = [];
  const outsideBundle = [];
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !entry.path.startsWith(MANIFEST_PACKAGE_PREFIX)) {
      // The supplied subset is the package bundle only; other manifest rows
      // (e.g. the prior report) are deliberately NOT staged. Recorded, not faked.
      outsideBundle.push(String(entry.path));
      continue;
    }
    const relative = entry.path.slice(MANIFEST_PACKAGE_PREFIX.length);
    const file = path.join(FIXTURE_PACKAGE, relative);
    if (!fs.existsSync(file)) { missing.push(relative); continue; }
    const actual = sha256File(file);
    if (actual !== entry.sha256) mismatched.push({ path: relative, expected: entry.sha256, actual });
    else checked.push(relative);
  }

  evidence.manifest = {
    stagedManifestSha256: sha256File(FIXTURE_MANIFEST),
    expectedManifestSha256: EXPECTED_MANIFEST_SHA256,
    // Recorded, never asserted: the per-leaf hash comparison below is the real
    // gate. A re-issued manifest that still verifies every leaf is acceptable;
    // this row exists so the reader knows which document was actually used.
    stagedManifestIsTheExpectedOne: sha256File(FIXTURE_MANIFEST) === EXPECTED_MANIFEST_SHA256,
    prefixRequired: MANIFEST_PACKAGE_PREFIX,
    track: manifest.track ?? null,
    createdAt: manifest.createdAt ?? null,
    totalEntries: manifest.files.length,
    bundleEntriesVerified: checked.length,
    mismatched,
    missing,
    entriesNotStagedInThisBundle: outsideBundle,
  };

  assert.deepEqual(mismatched, [], 'a staged bundle leaf disagrees with the manifest hash');
  assert.deepEqual(missing, [], 'a manifest-listed bundle leaf is absent from the fixture');
  assert.ok(
    checked.length > 0,
    `no bundle leaf was verified: no manifest entry begins with "${MANIFEST_PACKAGE_PREFIX}". `
    + 'This is a staging mismatch, not a bundle defect — check which manifest was staged.',
  );

  // The four leaves this observation cannot proceed without.
  for (const required of [
    'package.json',
    'scripts/build-advisor-storage.mjs',
    'native/task-advisor-storage/darwin.c',
    'dist/src/task-advisor/storage-provenance.js',
  ]) {
    assert.ok(checked.includes(required), `required bundle leaf not verified: ${required}`);
  }

  evidence.fixtureIntegrity = { before: snapshot(FIXTURE_ROOT), after: null, mutatedLeaves: null };
});

test('[CI] an owned COPY is staged under RUNNER_TEMP; the fixture is never built in place', () => {
  fs.rmSync(OWN_PACKAGE, { recursive: true, force: true });
  fs.cpSync(FIXTURE_PACKAGE, OWN_PACKAGE, { recursive: true, preserveTimestamps: true });

  assert.ok(!OWN_PACKAGE.startsWith(FIXTURE_ROOT), 'the build target must not be inside the immutable fixture');
  assert.ok(fs.statSync(path.join(OWN_PACKAGE, 'package.json')).isFile(), 'the copy root carries package.json');
  assert.ok(
    fs.statSync(path.join(OWN_PACKAGE, 'native', 'task-advisor-storage')).isDirectory(),
    'the copy root carries native/task-advisor-storage, which is how the adapter finds its own root',
  );

  const copied = leaves(OWN_PACKAGE);
  const original = leaves(FIXTURE_PACKAGE);
  evidence.stage = {
    copyRoot: '$RUNNER_TEMP/advisor-darwin-observation/package',
    leafCount: copied.length,
    leafCountMatchesFixture: copied.length === original.length,
    darwinSourceSha256: sha256File(path.join(OWN_PACKAGE, 'native', 'task-advisor-storage', 'darwin.c')),
    emittedAdapterSha256: sha256File(path.join(OWN_PACKAGE, 'dist', 'src', 'task-advisor', 'storage-provenance.js')),
    builderScriptSha256: sha256File(path.join(OWN_PACKAGE, 'scripts', 'build-advisor-storage.mjs')),
    sameDarwinSourceAsPrior: null,
    sameAdapterEmitAsPrior: null,
  };
  // Held-constant check against the prior run. These are the two dimensions that
  // are NOT confounds; everything else about the two runs differs or is unmeasured.
  evidence.stage.sameDarwinSourceAsPrior = evidence.stage.darwinSourceSha256 === PRIOR_OBSERVATION.darwinSourceSha256;
  evidence.stage.sameAdapterEmitAsPrior = evidence.stage.emittedAdapterSha256 === PRIOR_OBSERVATION.adapterEmitSha256;
  assert.equal(evidence.stage.leafCountMatchesFixture, true, 'the copy must be leaf-for-leaf the staged bundle');
});

test('[CI] the supplied builder compiles the exact darwin.c for the MEASURED arch', () => {
  const builder = path.join(OWN_PACKAGE, 'scripts', 'build-advisor-storage.mjs');
  const started = performance.now();
  const built = spawnSync(process.execPath, [builder], {
    cwd: OWN_PACKAGE,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: BUILD_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Minimal environment. PATH is needed to find `cc`; HOME and TMPDIR are ours.
    env: { PATH: process.env.PATH ?? '', HOME: OWN_HOME, TMPDIR: OWN_TMP },
  });
  const wallMs = Math.round(performance.now() - started);

  // The architecture is MEASURED, never assumed: the prior arm64 binary is not
  // supplied, and the builder names its output from its own `process.arch`.
  const expected = path.join(
    OWN_PACKAGE, 'native', 'task-advisor-storage', 'bin',
    `advisor-storage-provenance-darwin-${process.arch}`,
  );

  evidence.build = {
    command: 'node scripts/build-advisor-storage.mjs (as supplied, unmodified)',
    resolvedArch: process.arch,
    expectedHelperName: path.basename(expected),
    status: built.status,
    signal: built.signal,
    error: built.error ? String(built.error.message) : null,
    wallMs,
    stdout: scrub(typeof built.stdout === 'string' ? built.stdout : ''),
    stderr: scrub(typeof built.stderr === 'string' ? built.stderr : ''),
    helperSha256: null,
    helperBytes: null,
    helperMode: null,
  };

  // Exit codes are the builder's own: 0 built, 1 failed, 2 not applicable.
  // On Darwin, 2 is impossible, so anything but 0 is a recorded BLOCKED failure.
  assert.equal(built.error ?? null, null, 'the builder itself could not be executed');
  assert.equal(built.signal, null, 'the builder was killed by a signal');
  assert.equal(built.status, 0, 'native build FAILED or was BLOCKED; this is evidence of a blocked run, not a skip');

  const stat = fs.statSync(expected);
  assert.ok(stat.isFile() && stat.size > 0, 'builder reported success without a usable executable');
  evidence.build.helperSha256 = sha256File(expected);
  evidence.build.helperBytes = stat.size;
  evidence.build.helperMode = '0' + (stat.mode & 0o777).toString(8);
  helperFile = expected;
});

// Title says PRESENCE, because presence is all the five checks below establish.
// `exportNames` is recorded for the reader but is deliberately not compared to an
// expected set: pinning the full surface would fail this observation for an
// unrelated additive change to the module, which is not what this job measures.
test('[CI] the emitted adapter exposes the public API this harness uses (presence only)', async () => {
  const module = await import(pathToFileURL(path.join(OWN_PACKAGE, 'dist', 'src', 'task-advisor', 'storage-provenance.js')).href);
  adapter = module;

  evidence.api = {
    exportNames: Object.keys(module).sort(),
    protocol: module.STORAGE_PROVENANCE_PROTOCOL,
    adapterVersion: module.STORAGE_PROVENANCE_ADAPTER_VERSION,
  };

  assert.equal(typeof module.measureStorageProvenance, 'function');
  assert.equal(typeof module.checkStorageProvenance, 'function');
  assert.equal(typeof module.storageProvenanceBudgetRefusal, 'function');
  assert.equal(module.STORAGE_PROVENANCE_PROTOCOL, 'advisor-storage-provenance-v1');
  assert.equal(module.STORAGE_PROVENANCE_ADAPTER_VERSION, 1);
});

/* ------------------------------------------- the four inherited REAL assertions */

test('[REAL] helper runs against one newly created own directory and emits protocol v1', () => {
  assert.notEqual(helperFile, null, 'no helper was built; the observation cannot be taken');
  const started = performance.now();
  const result = spawnSync(helperFile, [OWN_TARGET], {
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: HELPER_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    shell: false,
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wallMs = Math.round(performance.now() - started);

  evidence.helper = {
    argvShape: '<helper> <one-own-directory>',
    targetIsOwnNewDirectory: OWN_TARGET.startsWith(RUNNER_TEMP),
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message) : null,
    wallMs,
    stdoutBytes: result.stdout ? Buffer.byteLength(result.stdout) : 0,
    stderr: scrub(result.stderr ? result.stderr.trim() : ''),
    protocolValid: false,
    fields: null,
    devMatchesNodeStatDev: null,
  };

  if (result.error || result.status !== 0) {
    // A refusal stays a refusal. The helper is specified to exit 0 after printing
    // a well-formed line, so a non-zero exit means it could not even print.
    evidence.helper.outcome = 'DENIED-OR-FAILED before emitting a line (recorded verbatim)';
    return;
  }

  const line = (result.stdout ?? '').replace(/\n$/, '');
  const tokens = line.split(' ');
  const fields = {};
  for (const token of tokens.slice(1)) {
    const split = token.indexOf('=');
    if (split > 0) fields[token.slice(0, split)] = token.slice(split + 1);
  }

  assert.equal(tokens[0], adapter.STORAGE_PROVENANCE_PROTOCOL);
  assert.equal(tokens.length, 6, 'grammar is exactly 6 space-separated tokens');
  assert.ok(['ok', 'denied', 'unsupported', 'error'].includes(fields.status));
  assert.ok(['local-fixed', 'removable', 'network', 'unknown'].includes(fields.class));
  assert.ok(fields.dev === 'u' || /^-?\d{1,20}$/.test(fields.dev), 'dev is `u` or a decimal device number');
  for (const key of ['internal', 'removable']) assert.ok(['0', '1', 'u'].includes(fields[key]));

  evidence.helper.protocolValid = true;
  evidence.helper.tokenCount = tokens.length;
  evidence.helper.outcome = 'EMITTED a well-formed protocol line';
  evidence.helper.fields = {
    status: fields.status,
    class: fields.class,
    dev: redact(fields.dev === 'u' ? null : fields.dev),
    devIsUnbound: fields.dev === 'u',
    internal: fields.internal,
    removable: fields.removable,
  };

  // Relation only: does the helper's device identity agree with this process's?
  const stat = fs.statSync(OWN_TARGET);
  evidence.helper.devMatchesNodeStatDev = fields.dev === 'u' ? null : fields.dev === String(stat.dev);
});

test('[REAL] measureStorageProvenance on an own directory returns structurally valid facts', () => {
  const facts = adapter.measureStorageProvenance(OWN_TARGET);

  evidence.measured = {
    protocol: facts.protocol,
    classification: facts.classification,
    reason: facts.reason,
    adapter: facts.adapter,
    adapterVersion: facts.adapterVersion,
    platform: facts.platform,
    arch: facts.arch,
    osRelease: facts.osRelease,
    filesystemType: facts.filesystemType,
    volumeBinding: facts.volumeBinding,
    volumeIdentityDigestPrefix: String(facts.volumeIdentity).slice(0, 12),
    cost: facts.cost,
    targetPathIsOwnTemp: facts.targetPath === OWN_TARGET,
    canonicalEqualsTarget: facts.canonicalPath === facts.targetPath,
    budgetRefusal: adapter.storageProvenanceBudgetRefusal(facts),
  };

  assert.equal(facts.protocol, adapter.STORAGE_PROVENANCE_PROTOCOL);
  assert.ok(['local-fixed', 'removable', 'network', 'unknown'].includes(facts.classification));
  assert.equal(facts.platform, 'darwin');
  assert.equal(facts.arch, process.arch);
  // The production shape must survive its own structural validator.
  const checked = adapter.checkStorageProvenance(facts);
  assert.equal(checked.classification, facts.classification);
  // Eligibility is separate from validity, and this sample must be in budget.
  assert.equal(evidence.measured.budgetRefusal, null, 'the sample exceeded its own approved budget');
});

test('[REAL] measurement refuses a missing path and a non-directory without throwing', () => {
  // NOTE ON SCOPE — the inherited title for this case also claimed "never reads
  // directory contents". Nothing here instruments a read, so that claim is NOT
  // made by this test. What IS instrumented is below: a canary's bytes must not
  // appear in anything this harness retains. That proves non-leakage into the
  // evidence, it does NOT prove the absence of a read.
  const facts = adapter.measureStorageProvenance(path.join(OWN_TARGET, 'does-not-exist-SYNTHETIC'));
  assert.equal(facts.classification, 'unknown');

  const file = path.join(OWN_TARGET, 'a-file.txt');
  fs.writeFileSync(file, 'tester-owned fixture byte\n');
  const fileFacts = adapter.measureStorageProvenance(file);
  assert.equal(fileFacts.classification, 'unknown');
  assert.equal(fileFacts.reason, 'storage-provenance-target-not-directory');

  evidence.refusals = {
    missingTargetReason: facts.reason,
    missingTargetBinding: facts.volumeBinding,
    nonDirectoryReason: fileFacts.reason,
    nonDirectoryBinding: fileFacts.volumeBinding,
  };

  // Bounded instrumentation: a canary inside the probed directory, re-measured.
  // This is a first look; the check that MATTERS runs in `test.after` over the
  // exact bytes of each artifact immediately before it is written, because those
  // bytes — not this snapshot — are what leaves the runner.
  fs.writeFileSync(path.join(OWN_TARGET, 'canary.txt'), CANARY + '\n');
  const after = adapter.measureStorageProvenance(OWN_TARGET);
  const serialized = JSON.stringify({ after, evidence });
  evidence.contentReadLimit = {
    instrumented: 'canary-non-leakage',
    canaryBytesPresentAtThisPoint: serialized.includes(CANARY),
    canaryBytesPresentInWrittenArtifacts: null, // filled in by the evidence sink
    proves: 'no byte of a file inside the probed directory reached the retained evidence',
    doesNotProve: 'that no read occurred; this harness does not trace syscalls',
    classificationUnchangedWithCanaryPresent: after.classification === (evidence.measured ?? {}).classification,
  };
  assert.equal(evidence.contentReadLimit.canaryBytesPresentAtThisPoint, false);
});

test('[REAL] cost stays inside the module\'s own declared ceilings', () => {
  const facts = adapter.measureStorageProvenance(OWN_TARGET);
  assert.ok(facts.cost.wallMs >= 0 && facts.cost.wallMs <= MAX_WALL_MS, 'wallMs within MAX_WALL_MS');
  assert.ok(facts.cost.bytesRead >= 0 && facts.cost.bytesRead <= MAX_BYTES_READ, 'bytesRead within MAX_BYTES_READ');
  evidence.costObserved = facts.cost;
});

/* ------------------------------------------------------ observation, classified */

test('[CI] observation is classified against the prior NULL result (no qualification)', () => {
  const helper = evidence.helper ?? {};
  const measured = evidence.measured ?? {};
  const helperStatus = helper.fields ? helper.fields.status : null;
  const deviceBound = helper.fields ? helper.fields.devIsUnbound === false : false;

  // The direct `spawnSync` above and the adapter's own internal `runHelper` are
  // TWO SEPARATE INVOCATIONS of the helper. They can legitimately disagree — a
  // cold first call crossing the helper's own `alarm(2)`, a transient refusal, a
  // symlinked RUNNER_TEMP component that makes the adapter's helper lookup refuse
  // while the direct call succeeds. Each observation is therefore recorded on its
  // own, and their disagreement is recorded as data rather than asserted away.
  const helperLinePositive =
    helper.protocolValid === true
    && helperStatus === 'ok'
    && deviceBound
    && helper.devMatchesNodeStatDev === true;
  const adapterPositive =
    measured.volumeBinding === 'helper-confirmed'
    && measured.classification !== undefined
    && measured.classification !== 'unknown';
  const positiveMeasurement = helperLinePositive && adapterPositive;
  const mixedObservation = helperLinePositive !== adapterPositive;

  let discriminatesPriorNull;
  if (helperStatus === 'ok') {
    // `refuse("unsupported")` has exactly one site, darwin.c:106-107, so status=ok
    // proves DASessionCreate AND DADiskCopyDescription both returned non-NULL on
    // this runner from the same darwin.c. That disproves an UNCONDITIONAL source
    // failure. It does not isolate a cause: helper binary, arch, compiler, SDK, OS
    // version and confinement all differ or are unmeasured between the two runs.
    discriminatesPriorNull =
      'PARTIAL — a DA session was creatable on this runner from the same darwin.c source, so the '
      + 'prior NULL is NOT an unconditional property of this source on Darwin. The CAUSE of the '
      + 'prior NULL remains UNKNOWN: see confounds.';
  } else if (helperStatus === 'unsupported') {
    discriminatesPriorNull = 'NO — the prior unsupported/NULL outcome reproduced on an ordinary runner; cause remains UNKNOWN';
  } else if (helper.protocolValid === true) {
    discriminatesPriorNull = `INCONCLUSIVE — helper refused with status=${helperStatus}, a different refusal than the prior NULL`;
  } else {
    discriminatesPriorNull = 'INCONCLUSIVE — no well-formed helper line was obtained';
  }

  const stage = evidence.stage ?? {};
  const build = evidence.build ?? {};
  const runner = evidence.runner ?? {};
  const compiler = evidence.compiler ?? {};

  evidence.discrimination = {
    helperProtocolValid: helper.protocolValid === true,
    helperStatus,
    deviceBinding: measured.volumeBinding ?? null,
    deviceBoundToThisProcess: helper.devMatchesNodeStatDev,
    adapterClassification: measured.classification ?? null,
    adapterReason: measured.reason ?? null,
    helperLinePositive,
    adapterPositive,
    positiveMeasurement,
    refusalOnly: !positiveMeasurement,
    mixedObservation,
    mixedObservationNote: mixedObservation
      ? 'the direct helper call and the adapter\'s own invocation disagree; recorded as data, '
        + 'NOT as a product failure — they are two separate invocations. Read '
        + 'evidence.measured.reason and evidence.helper.outcome before drawing any conclusion.'
      : null,
    prior: PRIOR_OBSERVATION,
    // Held constant between the two runs, measured not assumed.
    heldConstant: {
      darwinSource: stage.sameDarwinSourceAsPrior ?? null,
      adapterEmit: stage.sameAdapterEmitAsPrior ?? null,
    },
    // Dimensions that differ or are unmeasured. Stated as confounds, not as
    // claimed differences: no difference is asserted that was not measured here.
    confounds: [
      {
        dimension: 'helper binary',
        prior: `${PRIOR_OBSERVATION.helperSha256} (${PRIOR_OBSERVATION.helperBytes} B, prebuilt and reused)`,
        thisRun: build.helperSha256 === null || build.helperSha256 === undefined
          ? 'NOT BUILT'
          : `${build.helperSha256} (${build.helperBytes} B, compiled on this runner)`,
        differs: build.helperSha256 === undefined ? null : build.helperSha256 !== PRIOR_OBSERVATION.helperSha256,
      },
      {
        dimension: 'arch',
        prior: PRIOR_OBSERVATION.arch,
        thisRun: runner.processArch ?? null,
        differs: runner.processArch === undefined ? null : runner.processArch !== PRIOR_OBSERVATION.arch,
      },
      {
        dimension: 'compiler / SDK',
        prior: 'UNMEASURED — host Apple cc and host SDK, exact versions not recorded by the prior run',
        thisRun: compiler.versionFirstLine || 'NOT RECORDED',
        differs: null,
      },
      {
        dimension: 'OS version',
        prior: 'UNMEASURED — confined host, release not recorded in a comparable form',
        thisRun: runner.osRelease ? `${runner.osType} ${runner.osRelease}` : 'NOT RECORDED',
        differs: null,
      },
      {
        dimension: 'confinement',
        prior: 'sandboxed host; xcrun cache write was denied (Operation not permitted) while cc still exited 0',
        thisRun: 'ordinary disposable CI runner, no sandbox profile applied by this job',
        differs: null,
      },
    ],
    discriminatesPriorNull,
    qualification:
      'NONE. A positive measurement is a measurement, not a qualification; an '
      + 'unsupported or unknown outcome is recorded evidence, not a failure to work '
      + 'around. The qualification catalog stays empty either way.',
  };

  // Real assertions, and only ones the adapter's OWN contract guarantees. The
  // outcome is never asserted: no classification, status or binding is required.
  assert.ok(['ok', 'denied', 'unsupported', 'error', null].includes(helperStatus));
  assert.ok(['helper-confirmed', 'mountinfo-matched', 'node-only', null].includes(evidence.discrimination.deviceBinding));
  if (positiveMeasurement) {
    assert.equal(measured.volumeBinding, 'helper-confirmed', 'a positive measurement must carry a confirmed binding');
  }
  // storage-provenance.js observeDarwin: every non-`unknown` Darwin result is
  // reached only after the helper confirmed the device, so it carries exactly
  // `helper-confirmed`. `mountinfo-matched` is produced by observeLinux only and
  // can never appear on Darwin. Excluding `node-only` alone would therefore still
  // admit `mountinfo-matched` or a missing binding, both of which the generic
  // enum assertion above also lets through — so require the exact value. This is
  // the existing adapter contract, not a new product gate: it asserts nothing
  // about WHICH classification is reached, only that a non-`unknown` one is
  // backed by the binding the adapter itself guarantees.
  if (measured.classification !== undefined && measured.classification !== 'unknown') {
    assert.equal(
      measured.volumeBinding, 'helper-confirmed',
      'on Darwin a non-unknown classification must carry the helper-confirmed binding',
    );
  }
});

test('[CI] the immutable fixture is byte-identical after the run', () => {
  assert.notEqual(evidence.fixtureIntegrity, null, 'no before-snapshot was taken');
  const after = snapshot(FIXTURE_ROOT);
  const before = evidence.fixtureIntegrity.before;
  const mutated = [];
  for (const [rel, hash] of Object.entries(before)) {
    if (after[rel] === undefined) mutated.push({ path: rel, change: 'removed' });
    else if (after[rel] !== hash) mutated.push({ path: rel, change: 'modified' });
  }
  for (const rel of Object.keys(after)) {
    if (before[rel] === undefined) mutated.push({ path: rel, change: 'added' });
  }
  evidence.fixtureIntegrity.after = after;
  evidence.fixtureIntegrity.mutatedLeaves = mutated;
  assert.deepEqual(mutated, [], 'the immutable fixture was mutated by this run');
});

/* -------------------------------------------------------------- evidence sink */

test.after(() => {
  fs.mkdirSync(OWN_EVIDENCE, { recursive: true, mode: 0o700 });

  // Run completeness. A stage that never recorded anything is a stage that did
  // not run, and a populated table with an unrecorded stage above it has
  // previously been misread as a complete observation. Name the gaps.
  const STAGES = [
    ['runner', 'runner'], ['compiler', 'compiler'], ['manifest', 'manifest'],
    ['stage', 'copy'], ['build', 'build'], ['api', 'api'], ['helper', 'helper'],
    ['measured', 'measure'], ['refusals', 'refusals'], ['costObserved', 'cost'],
    ['contentReadLimit', 'canary'], ['discrimination', 'discrimination'],
  ];
  const unrecorded = STAGES.filter(([key]) => evidence[key] === null || evidence[key] === undefined).map(([, label]) => label);
  const integrity = evidence.fixtureIntegrity;
  const mutatedCount = integrity === null || integrity.mutatedLeaves === null ? null : integrity.mutatedLeaves.length;

  evidence.runCompleteness = {
    unrecordedStages: unrecorded,
    complete: unrecorded.length === 0,
    fixtureMutatedLeafCount: mutatedCount,
    caveat:
      'This artifact is OBSERVATION DATA. It is not a substitute for the actual test and '
      + 'job result: a stage can record a value and a later assertion in the same run can '
      + 'still fail. Read the `Take the observation` step status alongside this file.',
  };

  // The full before/after hash maps are the integrity proof but are noisy; keep
  // the counts and a digest-of-digests in the compact record, both maps in full
  // only in the integrity file.
  const compact = { ...evidence };
  if (integrity !== null) {
    compact.fixtureIntegrity = {
      leafCountBefore: Object.keys(integrity.before).length,
      leafCountAfter: integrity.after === null ? null : Object.keys(integrity.after).length,
      treeDigestBefore: createHash('sha256').update(JSON.stringify(integrity.before)).digest('hex'),
      treeDigestAfter: integrity.after === null ? null : createHash('sha256').update(JSON.stringify(integrity.after)).digest('hex'),
      mutatedLeaves: integrity.mutatedLeaves,
    };
    writeCheckedArtifact(path.join(OWN_EVIDENCE, 'fixture-integrity.json'), JSON.stringify(integrity, null, 2) + '\n');
  }

  // Containment is checked against the EXACT bytes of each artifact, immediately
  // before the write, by `writeCheckedArtifact`. Record the outcome for the first
  // artifact that carries the full record.
  const observation = JSON.stringify(compact, null, 2) + '\n';
  if (compact.contentReadLimit !== null && compact.contentReadLimit !== undefined) {
    compact.contentReadLimit = {
      ...compact.contentReadLimit,
      canaryBytesPresentInWrittenArtifacts: observation.includes(CANARY),
    };
  }
  writeCheckedArtifact(path.join(OWN_EVIDENCE, 'observation.json'), JSON.stringify(compact, null, 2) + '\n');

  const d = evidence.discrimination;
  const c = evidence.runCompleteness;
  writeCheckedArtifact(
    path.join(OWN_EVIDENCE, 'summary.md'),
    [
      '### Advisor Darwin storage-provenance observation (task 1161 / dm1161hi)',
      '',
      '| field | value |',
      '| --- | --- |',
      `| run completeness | ${c.complete ? 'all stages recorded' : 'INCOMPLETE — unrecorded stages: ' + c.unrecordedStages.join(', ')} |`,
      `| fixture mutated | ${c.fixtureMutatedLeafCount === null ? 'NOT CHECKED' : c.fixtureMutatedLeafCount + ' leaves'} |`,
      `| runner | ${evidence.runner ? `${evidence.runner.osType} ${evidence.runner.osRelease} / ${evidence.runner.processArch}` : 'NOT RECORDED'} |`,
      `| node | ${evidence.runner ? evidence.runner.nodeVersion : 'NOT RECORDED'} |`,
      `| compiler | ${evidence.compiler ? evidence.compiler.versionFirstLine || 'ABSENT' : 'NOT RECORDED'} |`,
      `| helper sha256 | ${evidence.build ? evidence.build.helperSha256 ?? 'NOT BUILT' : 'NOT BUILT'} |`,
      `| darwin.c sha256 | ${evidence.stage ? evidence.stage.darwinSourceSha256 : 'NOT STAGED'} |`,
      `| same darwin.c as prior run | ${evidence.stage ? String(evidence.stage.sameDarwinSourceAsPrior) : 'NOT STAGED'} |`,
      `| same adapter emit as prior run | ${evidence.stage ? String(evidence.stage.sameAdapterEmitAsPrior) : 'NOT STAGED'} |`,
      `| helper status | ${d ? d.helperStatus ?? 'none' : 'NOT REACHED'} |`,
      `| device binding | ${d ? d.deviceBinding ?? 'none' : 'NOT REACHED'} |`,
      `| classification | ${d ? d.adapterClassification ?? 'none' : 'NOT REACHED'} |`,
      `| helper-line positive | ${d ? String(d.helperLinePositive) : 'NOT REACHED'} |`,
      `| adapter positive | ${d ? String(d.adapterPositive) : 'NOT REACHED'} |`,
      `| positive measurement | ${d ? String(d.positiveMeasurement) : 'NOT REACHED'} |`,
      `| mixed observation | ${d ? String(d.mixedObservation) : 'NOT REACHED'} |`,
      `| discriminates prior NULL | ${d ? d.discriminatesPriorNull : 'NOT REACHED'} |`,
      '',
      `**Observation data, not a job result.** ${c.caveat}`,
      '',
      '**This run qualifies nothing.** It records one read-only metadata observation on a',
      'disposable runner. Device identifiers are redacted; the qualification catalog is',
      'untouched and production writes still refuse. A `PARTIAL` discrimination disproves',
      'an unconditional source failure only — it establishes no cause for the prior NULL.',
      '',
    ].join('\n'),
  );
});
