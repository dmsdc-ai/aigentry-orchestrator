#!/usr/bin/env node
/**
 * advisor-storage-provenance — native helper protocol conformance test.
 *
 * This is a MEASUREMENT-PATH conformance test. It qualifies nothing. It proves
 * that the package-owned native helper, as actually compiled on this operating
 * system, speaks `advisor-storage-provenance-v1` correctly and refuses safely.
 * It does not and cannot show that any directory lives on internal fixed media,
 * and passing it must never be read as a device qualification.
 *
 * Two independent groups run here:
 *
 *   "oracle — ..."  Pure, platform-independent checks of the two rules this test
 *                   enforces, kept deliberately separate:
 *                     GRAMMAR     — is this a well-formed protocol line?
 *                     ELIGIBILITY — may this line ever count as a local-fixed
 *                                   qualification?
 *                   They are not the same question. Every safe refusal is a
 *                   well-formed line that qualifies nothing, so a grammar pass
 *                   must never be read as a verdict. These spawn nothing and need
 *                   no compiler, so the enforcer itself is verified before it is
 *                   trusted to judge a real binary. Runnable anywhere with:
 *                     node --test --test-name-pattern 'oracle' <this file>
 *
 *   "native — ..."  The exact generated helper, executed against a directory
 *                   this test created with mkdtemp. On darwin and win32 a
 *                   missing helper is a FAILURE, never a skip: the whole point
 *                   of the CI gate is that the binary exists and conforms.
 *                   Other platforms define no helper and are skipped.
 *
 * Deliberate non-behaviours, matching the helper's own constraints:
 *   - The helper is resolved ONLY at its exact generated path under the package
 *     root. It is never taken from PATH, an environment variable or config: a
 *     caller-controlled binary could simply claim `local-fixed`.
 *   - Every invocation names a directory this test created. No user directory,
 *     no home, no volume enumeration, no mount manipulation.
 *   - No qualification or store API is imported, so nothing here can authorize a
 *     production write. The catalog stays empty.
 *   - The classification the helper reports is RECORDED, never asserted. CI runs
 *     on virtual disks where `unknown` is the correct, honest answer.
 *
 * Diagnostics: when ADVISOR_STORAGE_DIAGNOSTICS names a file, a synthetic JSON
 * record of raw stdout/stderr/exit codes and environment evidence is written
 * there for the workflow to upload. That variable controls only WHERE evidence
 * is written. It never controls whether an assertion runs.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------------- *
 * Protocol constants. Mirrored from native/task-advisor-storage/README.md and
 * the helper sources, NOT imported from src/, so this test stays an
 * independent statement of the contract and needs no TypeScript build.
 * ------------------------------------------------------------------------- */

const PROTOCOL = 'advisor-storage-provenance-v1';

/** Production ceilings from src/task-advisor/storage-provenance.ts. */
const HELPER_TIMEOUT_MS = 2_000;
const HELPER_MAX_OUTPUT_BYTES = 512;

const STATUSES = ['ok', 'denied', 'unsupported', 'error'];
const CLASSES = ['local-fixed', 'removable', 'network', 'unknown'];
const TRISTATE = ['0', '1', 'u'];
/** Fixed key order. A reordered key is a different protocol, not a variant. */
const KEYS = ['status', 'class', 'dev', 'internal', 'removable'];

/* ------------------------------------------------------------------------- *
 * The grammar oracle.
 * ------------------------------------------------------------------------- */

/**
 * Parse one raw stdout capture under the strict grammar.
 *
 * Returns `{ ok: true, fields }` or `{ ok: false, reason }`. Every rejection
 * carries an exact machine token so a CI failure names the defect rather than
 * saying "malformed". Anything unexpected is a rejection, never a best-effort
 * interpretation: a helper that cannot speak the protocol exactly is a helper
 * whose verdict must not be believed.
 */
export function parseProvenanceLine(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' };
  if (raw.length === 0) return { ok: false, reason: 'empty-output' };
  if (Buffer.byteLength(raw) > HELPER_MAX_OUTPUT_BYTES) return { ok: false, reason: 'oversize-output' };
  // Exactly one line, optionally newline-terminated. Nothing before, nothing after.
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (line.includes('\n')) return { ok: false, reason: 'multiple-lines' };
  if (line.includes('\r')) return { ok: false, reason: 'carriage-return' };
  // A bare newline is an empty line, not a zero-token line.
  if (line.length === 0) return { ok: false, reason: 'empty-output' };

  const tokens = line.split(' ');
  if (tokens.length !== 6) return { ok: false, reason: 'token-count' };
  if (tokens[0] !== PROTOCOL) return { ok: false, reason: 'wrong-protocol' };

  const fields = new Map();
  for (let index = 0; index < KEYS.length; index++) {
    const token = tokens[index + 1];
    const key = KEYS[index];
    const split = token.indexOf('=');
    if (split <= 0) return { ok: false, reason: 'malformed-token' };
    if (token.slice(0, split) !== key) return { ok: false, reason: 'key-order' };
    fields.set(key, token.slice(split + 1));
  }

  const status = fields.get('status');
  if (!STATUSES.includes(status)) return { ok: false, reason: 'unknown-status' };
  const klass = fields.get('class');
  if (!CLASSES.includes(klass)) return { ok: false, reason: 'unknown-class' };
  const dev = fields.get('dev');
  // Same shape the production parser accepts: `u`, or a bounded decimal.
  if (dev !== 'u' && !/^-?\d{1,20}$/.test(dev)) return { ok: false, reason: 'malformed-dev' };
  for (const key of ['internal', 'removable']) {
    if (!TRISTATE.includes(fields.get(key))) return { ok: false, reason: `malformed-${key}` };
  }
  // A helper that could not complete its query cannot assert a classification.
  if (status !== 'ok' && klass !== 'unknown') return { ok: false, reason: 'verdict-without-completion' };
  // Contradiction guard: `local-fixed` may never arrive without its evidence.
  if (klass === 'local-fixed' && (fields.get('internal') !== '1' || fields.get('removable') !== '0')) {
    return { ok: false, reason: 'local-fixed-without-evidence' };
  }
  return { ok: true, fields: Object.fromEntries(fields) };
}

/**
 * ELIGIBILITY, not grammar.
 *
 * `parseProvenanceLine` answers "is this a well-formed protocol line". This
 * answers the separate question "may this line ever count as a local-fixed
 * qualification". A line can be flawless and still qualify nothing: that is what
 * a safe refusal is. Conflating the two is what makes a protocol pass look like a
 * device result.
 *
 * The rules mirror the production caller `observeDarwin` in
 * src/task-advisor/storage-provenance.ts, in its order, including its reason
 * tokens. This is a statement of what production already does; it is not a new
 * policy and it cannot authorize anything. Nothing here is imported by production
 * and no product behaviour was changed to satisfy it.
 *
 *   - `dev=u` is an unbound volume: the helper never confirmed which volume it
 *     described, so no verdict of its survives, `local-fixed` included.
 *   - Any reported `dev` must equal the caller's own `st_dev`, or the answer is
 *     about some other volume.
 *   - Only `local-fixed` can qualify. `unknown`, `removable` and `network` are
 *     honest answers that qualify nothing.
 */
export function provenanceEligibility(fields, nodeStDev) {
  if (fields.dev === 'u') return { qualifies: false, reason: 'storage-provenance-unbound-volume' };
  if (fields.dev !== String(nodeStDev)) return { qualifies: false, reason: 'storage-provenance-volume-mismatch' };
  if (fields.class !== 'local-fixed') {
    return {
      qualifies: false,
      reason: 'storage-provenance-' + (fields.class === 'unknown' ? 'undetermined' : fields.class),
    };
  }
  return { qualifies: true, reason: 'storage-provenance-local-fixed' };
}

/* ------------------------------------------------------------------------- *
 * Diagnostics. Synthetic CI evidence only: raw helper output, exit codes and
 * platform/compiler identity. No file content, no device serial, no volume
 * label, no user path beyond the temporary directory this test made itself.
 * ------------------------------------------------------------------------- */

const diagnostics = {
  schema: 'advisor-storage-native-protocol-v1',
  protocol: PROTOCOL,
  // Stated up front so no reader can mistake this artifact for a qualification.
  qualification: 'none — protocol conformance only; the catalog stays empty',
  hardwareMatrix: 'UNRUN — internal, USB, network and controller-attached media are not exercised here',
  platform: process.platform,
  arch: process.arch,
  osRelease: os.release(),
  nodeVersion: process.version,
  helper: { resolved: null, sha256: null, bytes: null },
  invocations: [],
  observedClassification: null,
  deviceBinding: null,
  notes: [],
};

function recordNote(note) {
  if (!diagnostics.notes.includes(note)) diagnostics.notes.push(note);
}

process.on('exit', () => {
  const target = process.env.ADVISOR_STORAGE_DIAGNOSTICS;
  if (!target) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(diagnostics, null, 2) + '\n', 'utf8');
  } catch (error) {
    // Diagnostics are evidence, not a gate. Never convert a write failure into
    // a test result in either direction.
    process.stderr.write(`advisor-storage-test: could not write diagnostics: ${error.message}\n`);
  }
});

/* ------------------------------------------------------------------------- *
 * Helper resolution — the exact generated path, never PATH.
 * ------------------------------------------------------------------------- */

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
/** tests/task-advisor/<this file> → package root. */
const packageRoot = path.dirname(path.dirname(testDirectory));

/** The one filename the adapter resolves; anything else it would not find. */
function helperName(platform, arch) {
  return `advisor-storage-provenance-${platform}-${arch}` + (platform === 'win32' ? '.exe' : '');
}

const HELPER_PLATFORMS = ['darwin', 'win32'];
const helperIsExpected = HELPER_PLATFORMS.includes(process.platform);
const expectedHelper = path.join(
  packageRoot, 'native', 'task-advisor-storage', 'bin',
  helperName(process.platform, process.arch),
);

/* ------------------------------------------------------------------------- *
 * Bounded invocation, exactly as production spawns the helper.
 * ------------------------------------------------------------------------- */

/**
 * Spawn the helper with the same bounds and the same minimal environment the
 * production adapter uses. Using production's own env matters: a helper that
 * only works with an inherited environment would fail in the real caller.
 */
function invokeHelper(file, args, label) {
  const env = process.platform === 'win32'
    ? { SystemRoot: process.env.SystemRoot ?? '', windir: process.env.windir ?? '' }
    : {};
  const started = performance.now();
  const result = spawnSync(file, args, {
    timeout: HELPER_TIMEOUT_MS,
    maxBuffer: HELPER_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const elapsedMs = Math.round(performance.now() - started);
  const record = {
    label,
    // argv is recorded verbatim so a reviewer sees exactly what was asked.
    argv: args,
    status: result.status,
    signal: result.signal,
    error: result.error ? `${result.error.code ?? ''}:${result.error.message}` : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : null,
    stderr: typeof result.stderr === 'string' ? result.stderr : null,
    elapsedMs,
  };
  diagnostics.invocations.push(record);
  return record;
}

/**
 * Every invocation, whatever it was asked, must satisfy the same safety floor:
 * it terminates inside the production bound, exits 0, writes nothing to stderr,
 * and prints exactly one well-formed line. A refusal is still a well-formed
 * line — that is what makes a refusal parseable instead of a crash.
 */
function assertSafeInvocation(record) {
  assert.equal(record.error, null, `helper could not be executed (${record.label}): ${record.error}`);
  assert.equal(record.signal, null,
    `helper was killed by ${record.signal} (${record.label}); it must stay inside its own bound`);
  assert.equal(record.status, 0,
    `helper exited ${record.status} (${record.label}); it must exit 0 after printing a well-formed line`);
  assert.equal(record.stderr, '',
    `helper wrote to stderr (${record.label}); the protocol is one line on stdout and nothing else`);
  // The authoritative bound is the spawn timeout above, which turns an overrun
  // into ETIMEDOUT/SIGTERM and is caught by the two assertions before this one.
  // This is a redundant guard, so it carries a small margin for the measurement
  // overhead around spawnSync rather than flaking on a millisecond.
  assert.ok(record.elapsedMs <= HELPER_TIMEOUT_MS + 250,
    `helper took ${record.elapsedMs}ms (${record.label}), over the ${HELPER_TIMEOUT_MS}ms production bound`);
  const parsed = parseProvenanceLine(record.stdout);
  assert.ok(parsed.ok, `helper output rejected as '${parsed.reason}' (${record.label}): ${JSON.stringify(record.stdout)}`);
  return parsed.fields;
}

/** Recursive, bounded snapshot used to prove the helper changed nothing. */
function snapshot(root) {
  const entries = [];
  const walk = (directory, depth) => {
    assert.ok(depth <= 8, 'snapshot depth exceeded; the helper should create no tree at all');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      // atime is deliberately excluded: reading a directory legitimately moves it.
      entries.push([path.relative(root, full), stat.mode, stat.size, stat.mtimeMs, stat.ino].join('|'));
      if (entry.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  const self = fs.lstatSync(root);
  entries.push(['.', self.mode, self.mtimeMs, self.ino].join('|'));
  return entries.join('\n');
}

/* ========================================================================= *
 * Group 1 — oracle. Pure, no spawn, every platform.
 * ========================================================================= */

const GOOD = `${PROTOCOL} status=ok class=unknown dev=16777232 internal=u removable=u`;

test('oracle — a well-formed line is accepted and its fields are exposed', () => {
  const parsed = parseProvenanceLine(GOOD + '\n');
  assert.ok(parsed.ok, `expected acceptance, got ${parsed.reason}`);
  assert.deepEqual(parsed.fields, {
    status: 'ok', class: 'unknown', dev: '16777232', internal: 'u', removable: 'u',
  });
});

test('oracle — every documented status and class combination parses', () => {
  for (const status of STATUSES) {
    // Only `ok` may carry a verdict; the rest must say `unknown`.
    const line = `${PROTOCOL} status=${status} class=unknown dev=u internal=u removable=u`;
    assert.ok(parseProvenanceLine(line).ok, `status=${status} should parse`);
  }
  for (const klass of ['removable', 'network', 'unknown']) {
    const line = `${PROTOCOL} status=ok class=${klass} dev=u internal=u removable=u`;
    assert.ok(parseProvenanceLine(line).ok, `class=${klass} should parse`);
  }
  // local-fixed is the one verdict that must arrive with its evidence attached.
  assert.ok(parseProvenanceLine(
    `${PROTOCOL} status=ok class=local-fixed dev=u internal=1 removable=0`).ok);
});

test('oracle — a newline-free capture is accepted', () => {
  assert.ok(parseProvenanceLine(GOOD).ok);
});

test('oracle — malformed output is rejected with the exact defect token', () => {
  const cases = [
    ['', 'empty-output'],
    ['\n', 'empty-output'],
    [`${PROTOCOL} status=ok class=unknown dev=u internal=u`, 'token-count'],
    [`${PROTOCOL} status=ok class=unknown dev=u internal=u removable=u extra=1`, 'token-count'],
    [`advisor-storage-provenance-v2 status=ok class=unknown dev=u internal=u removable=u`, 'wrong-protocol'],
    // Reordered keys are a different protocol, not a variant to accommodate.
    [`${PROTOCOL} class=unknown status=ok dev=u internal=u removable=u`, 'key-order'],
    [`${PROTOCOL} state=ok class=unknown dev=u internal=u removable=u`, 'key-order'],
    [`${PROTOCOL} =ok class=unknown dev=u internal=u removable=u`, 'malformed-token'],
    [`${PROTOCOL} status=maybe class=unknown dev=u internal=u removable=u`, 'unknown-status'],
    [`${PROTOCOL} status=ok class=internal dev=u internal=u removable=u`, 'unknown-class'],
    [`${PROTOCOL} status=ok class=unknown dev=0x10 internal=u removable=u`, 'malformed-dev'],
    [`${PROTOCOL} status=ok class=unknown dev= internal=u removable=u`, 'malformed-dev'],
    [`${PROTOCOL} status=ok class=unknown dev=123456789012345678901 internal=u removable=u`, 'malformed-dev'],
    [`${PROTOCOL} status=ok class=unknown dev=u internal=2 removable=u`, 'malformed-internal'],
    [`${PROTOCOL} status=ok class=unknown dev=u internal=u removable=yes`, 'malformed-removable'],
    // A refusal may not smuggle a verdict.
    [`${PROTOCOL} status=denied class=local-fixed dev=u internal=1 removable=0`, 'verdict-without-completion'],
    [`${PROTOCOL} status=error class=removable dev=u internal=u removable=1`, 'verdict-without-completion'],
    // A verdict may not arrive without the evidence that supports it.
    [`${PROTOCOL} status=ok class=local-fixed dev=u internal=u removable=0`, 'local-fixed-without-evidence'],
    [`${PROTOCOL} status=ok class=local-fixed dev=u internal=1 removable=1`, 'local-fixed-without-evidence'],
    [`${PROTOCOL} status=ok class=local-fixed dev=u internal=0 removable=0`, 'local-fixed-without-evidence'],
    // Chattiness is a protocol violation, even when the first line is perfect.
    [`${GOOD}\n${GOOD}\n`, 'multiple-lines'],
    [`${GOOD}\ntrailing\n`, 'multiple-lines'],
    [`${GOOD}\r\n`, 'carriage-return'],
    [`${PROTOCOL}\tstatus=ok class=unknown dev=u internal=u removable=u`, 'token-count'],
    [`${GOOD} `, 'token-count'],
    // Leading whitespace splits into an empty first token, so the count fails
    // before the protocol name is ever compared.
    [` ${GOOD}`, 'token-count'],
    [`${PROTOCOL} status=ok class=unknown dev=u internal=u removable=u` + 'x'.repeat(HELPER_MAX_OUTPUT_BYTES), 'oversize-output'],
  ];
  for (const [raw, expected] of cases) {
    const parsed = parseProvenanceLine(raw);
    assert.equal(parsed.ok, false, `expected rejection of ${JSON.stringify(raw)}`);
    assert.equal(parsed.reason, expected, `wrong defect token for ${JSON.stringify(raw)}`);
  }
});

test('oracle — a negative dev is accepted, matching the production parser', () => {
  // Darwin widens a signed st_dev; the production parser accepts `-?\d{1,20}`.
  // The oracle must not be stricter than the caller it stands in for.
  assert.ok(parseProvenanceLine(`${PROTOCOL} status=ok class=unknown dev=-1 internal=u removable=u`).ok);
});

/* ------------------------------------------------------------------------- *
 * Eligibility oracle. Separate from grammar on purpose: these lines are all
 * well-formed, and almost none of them qualifies anything.
 * ------------------------------------------------------------------------- */

/** Stand-in for the caller's own `fs.statSync(target).dev`. */
const ORACLE_ST_DEV = 16777232;

test('oracle — a well-formed line is judged for eligibility separately from grammar', () => {
  const cases = [
    // --- unknown / unbound: accepted ONLY as a refusal, never as qualification.
    // These are exactly the lines darwin.c's refuse() emits, at exit 0. The
    // grammar must accept them (a refusal has to be parseable to be honoured)
    // and eligibility must still yield nothing.
    ['status=unsupported class=unknown dev=u internal=u removable=u', false, 'storage-provenance-unbound-volume'],
    ['status=denied class=unknown dev=u internal=u removable=u', false, 'storage-provenance-unbound-volume'],
    ['status=error class=unknown dev=u internal=u removable=u', false, 'storage-provenance-unbound-volume'],
    ['status=ok class=unknown dev=u internal=u removable=u', false, 'storage-provenance-unbound-volume'],

    // --- a fixed claim without an exact native binding is REJECTED.
    // This is also the Windows helper's own output shape. Windows reports dev=u
    // by design, its serial/st_dev equality is UNVERIFIED, and so a Windows
    // `local-fixed` line is not an internal-media qualification here either.
    ['status=ok class=local-fixed dev=u internal=1 removable=0', false, 'storage-provenance-unbound-volume'],

    // --- a fixed claim describing a DIFFERENT volume is REJECTED.
    [`status=ok class=local-fixed dev=${ORACLE_ST_DEV + 1} internal=1 removable=0`, false, 'storage-provenance-volume-mismatch'],
    [`status=ok class=local-fixed dev=-1 internal=1 removable=0`, false, 'storage-provenance-volume-mismatch'],
    // A mismatch outranks the classification: the line is about another volume,
    // so nothing it says applies to the target.
    [`status=ok class=unknown dev=${ORACLE_ST_DEV + 1} internal=u removable=u`, false, 'storage-provenance-volume-mismatch'],

    // --- bound, honest, non-fixed answers qualify nothing.
    [`status=ok class=unknown dev=${ORACLE_ST_DEV} internal=u removable=u`, false, 'storage-provenance-undetermined'],
    [`status=ok class=unknown dev=${ORACLE_ST_DEV} internal=1 removable=0`, false, 'storage-provenance-undetermined'],
    [`status=ok class=removable dev=${ORACLE_ST_DEV} internal=0 removable=1`, false, 'storage-provenance-removable'],
    [`status=ok class=removable dev=${ORACLE_ST_DEV} internal=1 removable=0`, false, 'storage-provenance-removable'],
    [`status=ok class=network dev=${ORACLE_ST_DEV} internal=u removable=u`, false, 'storage-provenance-network'],

    // --- the ONLY shape that may qualify: local-fixed, bound to this exact
    // volume, carrying its own evidence.
    [`status=ok class=local-fixed dev=${ORACLE_ST_DEV} internal=1 removable=0`, true, 'storage-provenance-local-fixed'],
  ];

  let qualifying = 0;
  for (const [body, expectedQualifies, expectedReason] of cases) {
    const parsed = parseProvenanceLine(`${PROTOCOL} ${body}`);
    // Every case must clear the grammar first, or it is testing the wrong thing.
    assert.ok(parsed.ok, `${body} should be well-formed, got ${parsed.reason}`);
    const verdict = provenanceEligibility(parsed.fields, ORACLE_ST_DEV);
    assert.equal(verdict.qualifies, expectedQualifies, `wrong eligibility for ${body}`);
    assert.equal(verdict.reason, expectedReason, `wrong eligibility reason for ${body}`);
    if (verdict.qualifies) qualifying++;
  }
  // Guards the table itself: exactly one shape above may qualify.
  assert.equal(qualifying, 1, 'exactly one case in this table may qualify');
});

test('oracle — `unknown` can never qualify, with any dev or flag combination', () => {
  for (const dev of ['u', String(ORACLE_ST_DEV), String(ORACLE_ST_DEV + 1), '-1']) {
    for (const internal of TRISTATE) {
      for (const removable of TRISTATE) {
        const line = `${PROTOCOL} status=ok class=unknown dev=${dev} internal=${internal} removable=${removable}`;
        const parsed = parseProvenanceLine(line);
        assert.ok(parsed.ok, `${line} should be well-formed`);
        assert.equal(provenanceEligibility(parsed.fields, ORACLE_ST_DEV).qualifies, false,
          `unknown must never qualify: ${line}`);
      }
    }
  }
});

test('oracle — every refusal status is well-formed AND ineligible', () => {
  // A refusal must parse, because production must be able to read it and refuse
  // deliberately rather than treat it as a crash; and it must qualify nothing.
  for (const status of ['denied', 'unsupported', 'error']) {
    const line = `${PROTOCOL} status=${status} class=unknown dev=u internal=u removable=u`;
    const parsed = parseProvenanceLine(line);
    assert.ok(parsed.ok, `refusal '${status}' must be parseable`);
    assert.equal(provenanceEligibility(parsed.fields, ORACLE_ST_DEV).qualifies, false);
  }
});

/* ========================================================================= *
 * Group 2 — native. The exact compiled helper on this actual OS.
 * ========================================================================= */

test('native — the exact generated helper exists at its resolved path', (t) => {
  if (!helperIsExpected) {
    recordNote(`no helper is defined for ${process.platform}; the Linux adapter is pure Node`);
    t.skip(`no native helper on ${process.platform}`);
    return;
  }
  // On darwin and win32 an absent helper is the failure this gate exists to catch.
  assert.ok(fs.existsSync(expectedHelper),
    `helper missing at ${expectedHelper}; build it with the package's own build script or CMakeLists`);

  const stat = fs.lstatSync(expectedHelper);
  assert.ok(stat.isFile(), 'helper must be a regular file');
  assert.ok(!stat.isSymbolicLink(), 'helper must not be a symlink; the adapter refuses one');
  assert.equal(fs.realpathSync.native(expectedHelper), expectedHelper,
    'helper path must resolve to itself; the adapter refuses an indirected path');
  assert.ok(stat.size > 0, 'helper must not be empty');

  // Recorded, not asserted: identity evidence for the reviewer.
  diagnostics.helper.resolved = path.relative(packageRoot, expectedHelper);
  diagnostics.helper.bytes = stat.size;
  diagnostics.helper.sha256 = createHash('sha256').update(fs.readFileSync(expectedHelper)).digest('hex');
});

test('native — the helper is the generated artifact, not a PATH substitute', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }
  // The adapter never consults PATH, an environment variable or configuration,
  // because all of those are caller-controlled and a caller-controlled binary
  // could simply claim `local-fixed`. This test must not consult them either.
  assert.equal(path.basename(expectedHelper), helperName(process.platform, process.arch));
  assert.ok(path.isAbsolute(expectedHelper), 'the helper must be invoked by absolute path');
  const binDirectory = path.join(packageRoot, 'native', 'task-advisor-storage', 'bin');
  assert.equal(path.dirname(expectedHelper), binDirectory,
    'the helper must live in the package-owned bin directory the adapter resolves');
});

test('native — a directory this test created yields one well-formed line', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }

  // Our own scratch directory. No user directory is ever named to the helper.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-storage-protocol-'));
  try {
    // Production passes the canonical path; mirror it exactly.
    const canonical = fs.realpathSync.native(scratch);
    const before = snapshot(canonical);

    const record = invokeHelper(expectedHelper, [canonical], 'own-mkdtemp-directory');
    const fields = assertSafeInvocation(record);

    // The classification is RECORDED, never asserted. A CI runner's virtual disk
    // legitimately answers `unknown`, and translating that into a passed device
    // qualification is precisely the error this gate must not make.
    diagnostics.observedClassification = { status: fields.status, class: fields.class, internal: fields.internal, removable: fields.removable };
    if (fields.class === 'unknown') {
      recordNote('classification is `unknown` on this runner; that is a valid, safe answer and qualifies nothing');
    }
    assert.ok(CLASSES.includes(fields.class));

    // Device binding. This is the one identity assertion, and it is per-platform
    // because the two helpers make genuinely different promises.
    const measured = String(fs.statSync(canonical).dev);
    diagnostics.deviceBinding = { reported: fields.dev, nodeStDev: measured };
    if (process.platform === 'darwin') {
      // darwin.c prints the resolved target's st_dev (widened as libuv widens it)
      // on every `emit("ok", ...)` path, and `dev=u` only from refuse() -- which
      // also forces a non-ok status. So `dev=u` is a safe REFUSAL, not a defect:
      // observeDarwin turns it into storage-provenance-unbound-volume and refuses.
      // Failing the build for it would demand a qualification the helper is right
      // not to give. What must never happen is a refusal that still looks bound,
      // or a bound dev describing another volume.
      if (fields.dev === 'u') {
        assert.notEqual(fields.status, 'ok',
          'darwin reported dev=u with status=ok; every unbound answer must come from a refusal path');
        diagnostics.deviceBinding.strength = 'unbound-refusal';
        recordNote(`darwin answered status=${fields.status} with an unbound dev; production refuses this as `
          + 'storage-provenance-unbound-volume, which is the correct safe outcome and qualifies nothing');
      } else {
        assert.equal(fields.dev, measured,
          'darwin helper described a different volume than this process bound');
        diagnostics.deviceBinding.strength = 'helper-confirmed';
      }
    } else {
      // Windows deliberately reports `u`: the GetVolumeInformationW serial is not
      // established as equal to this runtime's st_dev, and printing it would invite
      // a false identity match. If a value ever appears here, that unverified
      // serial has started leaking into identity and the open gate has moved.
      assert.equal(fields.dev, 'u',
        'windows helper reported a dev; its serial/st_dev equality is UNVERIFIED (see native README open gates)');
      diagnostics.deviceBinding.strength = 'node-only';
      recordNote('windows volume-identity binding remains UNVERIFIED; dev is `u` by design');
    }

    // Eligibility of the ACTUAL answer, recorded. Whether this runner reports
    // unknown, removable or local-fixed is never asserted -- that would be
    // asserting hardware.
    const eligibility = provenanceEligibility(fields, measured);
    diagnostics.deviceBinding.eligibility = eligibility;
    if (!eligibility.qualifies) {
      recordNote(`this observation qualifies nothing (${eligibility.reason}); the catalog stays empty`);
    }
    // On darwin a `local-fixed` claim must stand on an exact binding, because
    // observeDarwin requires one and the helper always prints dev on an ok path.
    // On win32 `class=local-fixed dev=u` is the helper's DESIGNED output and is
    // not a defect, so it is recorded, not failed. It still qualifies nothing:
    // the eligibility oracle above rejects it as unbound, and the serial/st_dev
    // equality that would change that is an open README gate, not a test subject.
    if (fields.class === 'local-fixed' && process.platform === 'darwin') {
      assert.notEqual(fields.dev, 'u',
        'darwin claimed local-fixed without an exact native volume binding; it may never qualify unbound');
      assert.equal(fields.dev, measured,
        'darwin claimed local-fixed for a volume this process did not bind');
    }
    if (fields.class === 'local-fixed' && process.platform === 'win32') {
      recordNote('windows reported local-fixed with dev=u by design; recorded, and it is NOT an '
        + 'internal-media qualification while serial/st_dev equality is UNVERIFIED');
    }

    // The helper is read-only. Nothing may be created, written or touched.
    assert.equal(snapshot(canonical), before,
      'the helper modified the directory it was asked about; it must be strictly read-only');
    assert.deepEqual(fs.readdirSync(canonical), [], 'the helper left entries in the scratch directory');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('native — a missing path is refused as `denied`, not crashed', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-storage-protocol-'));
  try {
    const absent = path.join(fs.realpathSync.native(scratch), 'no-such-directory');
    const fields = assertSafeInvocation(invokeHelper(expectedHelper, [absent], 'missing-path'));
    assert.equal(fields.status, 'denied', 'a path that cannot be resolved is `denied`');
    // A refusal must carry no verdict and no identity at all.
    assert.deepEqual(
      { class: fields.class, dev: fields.dev, internal: fields.internal, removable: fields.removable },
      { class: 'unknown', dev: 'u', internal: 'u', removable: 'u' },
      'a refusal must be fully unknown, carrying neither a verdict nor an identity');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('native — a non-directory target is refused as `error`', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-storage-protocol-'));
  try {
    const file = path.join(fs.realpathSync.native(scratch), 'a-regular-file');
    // Content is irrelevant and is never read by the helper; this is a shape test.
    fs.writeFileSync(file, 'not-a-directory\n', 'utf8');
    const fields = assertSafeInvocation(invokeHelper(expectedHelper, [file], 'non-directory-target'));
    assert.equal(fields.status, 'error', 'a target that is not a directory is `error`');
    assert.equal(fields.class, 'unknown');
    // The file must still be exactly as we wrote it: the helper reads no content.
    assert.equal(fs.readFileSync(file, 'utf8'), 'not-a-directory\n');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('native — argument count is validated', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'advisor-storage-protocol-'));
  try {
    const canonical = fs.realpathSync.native(scratch);
    for (const [label, args] of [
      ['no-arguments', []],
      ['two-arguments', [canonical, canonical]],
      ['empty-argument', ['']],
    ]) {
      const fields = assertSafeInvocation(invokeHelper(expectedHelper, args, label));
      assert.equal(fields.status, 'error', `${label} must be rejected as \`error\``);
      assert.equal(fields.class, 'unknown', `${label} must carry no verdict`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('native — an over-long path argument is refused, not truncated', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }
  // Nothing is created: this is argument validation against a bound, and the
  // helper must refuse rather than silently operate on a truncated path.
  const overlong = 'a'.repeat(5_000);
  const fields = assertSafeInvocation(invokeHelper(expectedHelper, [overlong], 'over-long-argument'));
  assert.equal(fields.status, 'error');
  assert.equal(fields.class, 'unknown');
});

test('native — every invocation stayed inside the production output bound', (t) => {
  if (!helperIsExpected) { t.skip(`no native helper on ${process.platform}`); return; }
  assert.ok(diagnostics.invocations.length > 0, 'no invocation was recorded');
  for (const record of diagnostics.invocations) {
    assert.ok(Buffer.byteLength(record.stdout ?? '') <= HELPER_MAX_OUTPUT_BYTES,
      `${record.label} exceeded the ${HELPER_MAX_OUTPUT_BYTES}-byte production maxBuffer`);
  }
  // Stated explicitly so a green run cannot be read as a hardware result.
  recordNote('protocol conformance passed; the internal/USB/network/controller hardware matrix is UNRUN');
});
