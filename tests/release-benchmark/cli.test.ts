import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic, nonauthorizing data: no installed package or performance observations.
const cli = fileURLToPath(new URL('../../../bin/init/cli.mjs', import.meta.url));
const nodeSha256 = '379f0668173a3936820c4bf0f56507fb16c6bd55ec9c252ccae1e7c10eaa68bf';
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' +
      canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = (value: unknown): string => sha(canonical(value));
const policy = { version: 1, minSuccesses: 5, relativeIncrease: 0.2, absoluteIncreaseMs: 50, minP95: 100 };
const H = sha('SYNTHETIC cli boundary fixture; NOT installed evidence');
function evidence() {
  const pkg = { name: 'synthetic-nonauthorizing-package', version: '0.0.0-synthetic-baseline',
    packageSha256: H, integrity: 'sha256-' + Buffer.from(H, 'hex').toString('base64'),
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), installedDigest: H,
    cliDigest: H, dependenciesDigest: H, acceptedReceipt: H };
  const selected = { scenarios: [{ id: 'synthetic-preservation', requirement: 'synthetic-bytes-retained',
    oracleDigest: H }], repetitions: 5, warmups: 0 };
  const run = { version: 1, release: 'synthetic-not-a-release', component: 'synthetic-boundary',
    baseline: pkg as typeof pkg | null, baselineUnavailableReason: null as string | null,
    candidate: { ...pkg, version: '0.0.0-synthetic-candidate' },
    environment: { os: 'synthetic-os', osVersion: 'synthetic', architecture: 'synthetic',
      image: 'synthetic', executor: 'synthetic-not-executed', native: true,
      nodeVersion: 'synthetic', cliVersion: 'synthetic', model: null, effort: null,
      resourcesDigest: H, clockBasis: 'synthetic-not-measured' },
    configDigest: H, workloadDigest: H, cohort: 'synthetic', policy: digest(policy),
    selection: { ...selected, digest: digest(selected) } };
  const observations = (['baseline', 'candidate'] as const).flatMap(variant =>
    Array.from({ length: 5 }, (_, repetition) => {
      const absent = { value: null, reason: 'synthetic-unmeasured', source: null };
      return { version: 1, runKey: digest(['benchmark-run/1', run]), variant,
        scenario: selected.scenarios[0].id, repetition, warmup: false,
        producer: 'synthetic-producer', attempt: 'synthetic-attempt', kind: 'result',
        state: 'complete', outcome: 'success' as 'success' | 'failure', failure: null as string | null,
        cleanup: 'verified', clock: 'normal', exitCode: 0, signal: null,
        receipt: { sha256: digest(['synthetic-receipt', variant, repetition]), bytes: 1, receivedAt: 1 },
        metrics: { durationMs: { value: 100, reason: null, source: 'synthetic-not-measured' },
          completedUnits: absent, intervalMs: absent, cpuUserMs: absent, cpuSystemMs: absent,
          peakRssBytes: absent, ioBytes: absent, toolCalls: absent, tokens: absent, charge: absent },
        currency: null };
    }));
  return { version: 1, run, observations };
}
function expected(e: ReturnType<typeof evidence>) {
  const metric = { value: 100, reason: null, source: 'caller-observations/descriptive' };
  const summary = { expected: 5, observed: 5, successes: 5, failures: 0, unknown: 0,
    validDurations: 5, minMs: metric, medianMs: metric, maxMs: metric,
    p95Ms: { value: null, reason: 'fewer-than-100-or-unmatched-successes', source: null } };
  return { version: 1, status: 'review-needed', executionAuthorized: false,
    taskAdmissionAuthorized: false, loopActivationAuthorized: false,
    runKey: digest(['benchmark-run/1', e.run]), policy: { ...policy, digest: digest(policy) },
    replays: 0, coverage: { expected: 10, observed: 10, failures: 0, unknown: 0 },
    performance: 'not-triggered', reasons: [], incomplete: false, findingsTruncated: false,
    findings: [], scenarios: [{ scenario: 'synthetic-preservation', baseline: summary,
      candidate: summary, matchedSuccesses: 5 }], confidence: 'none' };
}
function snapshot(root: string): unknown[] {
  const rows: unknown[] = [];
  const walk = (p: string): void => {
    const s = lstatSync(p);
    rows.push([p.slice(root.length), s.mode, s.dev, s.ino, s.nlink, s.size, s.mtimeMs, s.ctimeMs,
      s.isSymbolicLink() ? readlinkSync(p) : s.isFile() ? sha(readFileSync(p)) : 'directory']);
    if (s.isDirectory()) for (const name of readdirSync(p).sort()) walk(join(p, name));
  };
  walk(root); return rows;
}
type Fixture = { root: string; env: NodeJS.ProcessEnv; live: Set<ChildProcess> };
async function owned(body: (f: Fixture) => Promise<void>): Promise<void> {
  assert.equal(sha(readFileSync(process.execPath)), nodeSha256, 'use the pinned real Node');
  const parent = process.env.TMPDIR;
  assert.ok(parent && isAbsolute(parent), 'explicit owned TMPDIR required');
  const root = mkdtempSync(join(realpathSync(parent), 'synthetic-benchmark-cli-'));
  const owner = lstatSync(root), token = randomUUID(), marker = join(root, '.owner');
  writeFileSync(marker, token, { flag: 'wx', mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: dirname(process.execPath), LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  for (const [key, directory] of Object.entries({ HOME: 'home', USERPROFILE: 'home',
    XDG_CONFIG_HOME: 'config', XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data', TMPDIR: 'tmp' })) {
    env[key] = join(root, directory); mkdirSync(env[key]!, { recursive: true, mode: 0o700 });
  }
  const f: Fixture = { root, env, live: new Set() };
  try { await body(f); } finally {
    assert.equal(f.live.size, 0, 'no cleanup while a direct child remains unsettled');
    const now = lstatSync(root);
    assert.ok(now.isDirectory() && now.dev === owner.dev && now.ino === owner.ino);
    assert.equal(readFileSync(marker, 'utf8'), token, 'delete only proven owned root');
    rmSync(root, { recursive: true });
    assert.equal(existsSync(root), false);
  }
}
type Result = { code: number | null; signal: NodeJS.Signals | null; out: string; err: string };
async function invoke(f: Fixture, args: string[], brokenPipe = false): Promise<Result> {
  const before = snapshot(f.root);
  const result = await new Promise<Result>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'benchmark', ...args],
      { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    f.live.add(child);
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, failure: Error | undefined, exited = false, outEnd = false, errEnd = false;
    const fail = (message: string): void => { failure ??= new Error(message); child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail('child exceeded 9.5s shutdown threshold'), 9500);
    const deadline = setTimeout(() => {
      fail('child/streams did not settle within 10s');
      child.stdout.destroy(); child.stderr.destroy(); reject(failure);
    }, 10000);
    child.once('error', e => { failure = e; });
    child.once('exit', () => { exited = true; });
    child.stdout.once('end', () => { outEnd = true; });
    child.stderr.once('end', () => { errEnd = true; });
    child.stdout.on('error', e => { fail('stdout stream: ' + e.message); });
    child.stderr.on('error', e => { fail('stderr stream: ' + e.message); });
    const collect = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) fail('combined child output exceeded 256KiB');
      else target.push(chunk);
    };
    child.stdout.on('data', (b: Buffer) => collect(out, b));
    child.stderr.on('data', (b: Buffer) => collect(err, b));
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(deadline); f.live.delete(child);
      if (!exited || !errEnd || (!brokenPipe && !outEnd)) failure ??= new Error('missing exit/EOF');
      if (brokenPipe && !child.stdout.destroyed) failure ??= new Error('pipe reader not closed');
      if (failure) reject(failure);
      else resolve({ code, signal, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') });
    });
    // Close the real pipe reader immediately, before the child can write.
    if (brokenPipe) child.stdout.destroy();
  });
  assert.deepEqual(snapshot(f.root), before, 'public comparator must preserve all fixture inputs');
  assert.equal(result.signal, null, 'a killed/timed-out child cannot satisfy an exit oracle');
  return result;
}
function input(f: Fixture, text: string | Buffer): string {
  const file = join(f.root, 'private-input-' + randomUUID() + '.json');
  writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); return file;
}
const compare = (f: Fixture, file: string): Promise<Result> => invoke(f, ['compare', '--input', file]);
function refusal(r: Result, code: 64 | 65): void {
  assert.equal(r.code, code); assert.equal(r.out, '');
  assert.equal(r.err, JSON.stringify({ code: code === 64 ? 'usage-refused' : 'input-refused' }) + '\n');
}
function output(r: Result, code: number) {
  assert.equal(r.code, code); assert.equal(r.err, ''); assert.ok(r.out.endsWith('\n'));
  const v = JSON.parse(r.out);
  assert.equal(r.out, JSON.stringify(v) + '\n');
  assert.equal(v.status, 'review-needed');
  for (const key of ['executionAuthorized', 'taskAdmissionAuthorized', 'loopActivationAuthorized']) assert.equal(v[key], false);
  return v;
}

test('public help needs no input and leaves owned state unchanged', () => owned(async f => {
  input(f, 'SYNTHETIC SECRET malformed input must not be required for help');
  for (const flag of ['--help', '-h']) {
    const r = await invoke(f, [flag]);
    assert.equal(r.code, 0); assert.equal(r.err, '');
    assert.equal(r.out, 'Usage: aigentry-orchestrator benchmark compare --input ABSOLUTE_JSON_FILE\n' +
      '       aigentry-orchestrator benchmark --help | -h\n');
  }
}));
test('public formatted complete evidence returns exact independent comparison and false authorities', () => owned(async f => {
  const e = evidence(), formatted = ' \n' + JSON.stringify(e, null, 2) + '\n\t';
  const r = await compare(f, input(f, formatted));
  assert.deepEqual(output(r, 0), expected(e));
}));
test('public correctness finding exits 1 even when baseline is incomplete', () => owned(async f => {
  for (const missing of [false, true]) {
    const e = evidence(), failed = e.observations[5];
    failed.outcome = 'failure'; failed.failure = 'synthetic-preservation-failed'; failed.exitCode = 1;
    if (missing) { e.run.baseline = null; e.run.baselineUnavailableReason = 'synthetic-absent';
      for (const o of e.observations) o.runKey = digest(['benchmark-run/1', e.run]); }
    const v = output(await compare(f, input(f, JSON.stringify(e))), 1);
    const defect = { version: 1, component: e.run.component, requirement: 'synthetic-bytes-retained',
      scenario: 'synthetic-preservation', normalizedFailure: failed.failure, cohort: e.run.cohort, policy: e.run.policy };
    assert.deepEqual(v.findings, [{ defectKey: digest(['benchmark-defect/1', defect]),
      scenario: defect.scenario, requirement: defect.requirement, kind: 'correctness-regression',
      normalizedFailure: failed.failure, runKey: digest(['benchmark-run/1', e.run]),
      evidenceReceipts: [failed.receipt.sha256] }]);
    assert.equal(v.incomplete, true); assert.equal(v.performance, 'refused');
    assert.deepEqual(v.reasons, ['flaky-outcomes', 'insufficient-matched-successes',
      ...(missing ? ['missing-baseline'] : []), 'unsuccessful-outcomes']);
    assert.equal(v.findingsTruncated, false);
  }
}));
test('public missing baseline without findings exits 2', () => owned(async f => {
  const e = evidence(); e.run.baseline = null; e.run.baselineUnavailableReason = 'synthetic-absent';
  for (const o of e.observations) o.runKey = digest(['benchmark-run/1', e.run]);
  const v = output(await compare(f, input(f, JSON.stringify(e))), 2);
  assert.deepEqual(v, { ...expected(e), performance: 'refused', reasons: ['missing-baseline'], incomplete: true });
}));
test('public malformed duplicate UTF8 and BOM refusals sanitize every diagnostic', () => owned(async f => {
  const raw = JSON.stringify(evidence(), null, 2);
  const invalid = ['{"secret":"SYNTHETIC-PRIVATE",', raw.replace('"version": 1', '"version": 1, "version": 1'),
    raw.replace('"version": 1', '"version": 1, "\\u0076ersion": 1'),
    Buffer.concat([Buffer.from(raw), Buffer.from([0xc0, 0xaf])]), '\uFEFF' + raw];
  for (const text of invalid) refusal(await compare(f, input(f, text)), 65);
}));
test('public invalid missing duplicate extra and relative arguments exit 64', () => owned(async f => {
  const file = input(f, JSON.stringify(evidence()));
  const invalid = [[], ['compare'], ['compare', '--input'], ['compare', '--input', 'relative.json'],
    ['compare', '--input', file, '--input', file], ['compare', '--input', file, 'extra'],
    ['unknown'], ['--help', 'extra'], ['compare', '--output', file], ['compare', '--input', '']];
  for (const args of invalid) refusal(await invoke(f, args), 64);
}));
test('public real file refusal matrix preserves bytes identities and link text', () => owned(async f => {
  const valid = input(f, JSON.stringify(evidence())), dir = join(f.root, 'directory');
  mkdirSync(dir);
  const symlink = join(f.root, 'symbolic.json'); symlinkSync(valid, symlink);
  const hard = input(f, JSON.stringify(evidence())), alias = join(f.root, 'hard.json'); linkSync(hard, alias);
  const oversized = input(f, Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  for (const file of [join(f.root, 'missing.json'), dir, symlink, hard, alias, oversized,
    f.root + sep + '.' + sep + valid.slice(f.root.length + 1)]) refusal(await compare(f, file), 65);
}));
test('public actual closed stdout pipe exits nonzero and settles within the child bound', () => owned(async f => {
  const file = input(f, JSON.stringify(evidence()));
  const r = await invoke(f, ['compare', '--input', file], true);
  assert.ok(r.code !== null && r.code > 0, 'broken output cannot report success');
  assert.equal(r.out, ''); assert.equal(r.err, '{"code":"output-refused"}\n');
}));
