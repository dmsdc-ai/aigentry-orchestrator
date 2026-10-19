import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { validateRun, validateEvidence, identifyRun, identifySample, identifyEvent, identifyDefect, reconcileEvidence, type Evidence, type Run, type Observation, type Result } from '../../src/release-benchmark/contracts.js';
import { compareEvidence } from '../../src/release-benchmark/compare.js';
const H = 'a'.repeat(64), J = 'b'.repeat(64);
const json = JSON.stringify;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => json(k) + ':' + canonical(v)).join(',') + '}';
  return json(value);
}
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const policy = hash({ version: 1, minSuccesses: 5, relativeIncrease: 0.2, absoluteIncreaseMs: 50, minP95: 100 });
function good<T>(result: Result<T>): T { if (!result.ok) assert.fail(json(result)); return result.value; }
function fixture(repetitions = 5, warmups = 0, baselineMs = 100, candidateMs = 100): Evidence {
  const pkg = { name: 'fixture', version: '1.0', packageSha256: H, integrity: 'sha256-' + Buffer.alloc(32).toString('base64'), sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), installedDigest: H, cliDigest: H, dependenciesDigest: H, acceptedReceipt: H };
  const selected = { scenarios: [{ id: 'init', requirement: 'preserve', oracleDigest: H }], repetitions, warmups };
  const run: Run = { version: 1, release: 'release1238', component: 'fixture', baseline: pkg, baselineUnavailableReason: null, candidate: { ...pkg, version: '2.0' },
    environment: { os: 'fixture-os', osVersion: '1', architecture: 'fixture-arch', image: 'image', executor: 'native-fixture', native: true, nodeVersion: '20.20.0', cliVersion: '1', model: null, effort: null, resourcesDigest: H, clockBasis: 'monotonic' },
    configDigest: H, workloadDigest: H, cohort: 'fixture-cohort', policy, selection: { ...selected, digest: hash(selected) } };
  const runKey = hash(['benchmark-run/1', run]), observations: Observation[] = [];
  for (const variant of ['baseline', 'candidate'] as const) for (const warmup of [false, true]) for (let repetition = 0; repetition < (warmup ? warmups : repetitions); repetition++) {
    const absent = { value: null, reason: 'not-instrumented', source: null };
    observations.push({ version: 1, runKey, variant, scenario: 'init', repetition, warmup, producer: 'fixture', attempt: 'attempt-1', kind: 'result',
      state: 'complete', outcome: 'success', failure: null, cleanup: 'verified', clock: 'normal', exitCode: 0, signal: null,
      receipt: { sha256: hash([variant, repetition, warmup]), bytes: 1, receivedAt: 1 },
      metrics: { durationMs: { value: warmup ? 9999 : variant === 'baseline' ? baselineMs : candidateMs, reason: null, source: 'fixture-child-clock' },
        completedUnits: absent, intervalMs: absent, cpuUserMs: absent, cpuSystemMs: absent, peakRssBytes: absent, ioBytes: absent, toolCalls: absent, tokens: absent, charge: absent }, currency: null });
  }
  return { version: 1, run, observations };
}
const compare = (e: Evidence) => good(compareEvidence(json(e)));
function failed(o: Observation, signature = 'preservation-failed'): void { o.outcome = 'failure'; o.failure = signature; o.exitCode = 1; }

test('complete identity binds relevant inputs and preserves delivery identities', () => {
  const e = fixture(), r = e.run, key = good(identifyRun(json(r)));
  assert.equal(key, hash(['benchmark-run/1', r]));
  assert.equal(good(identifyRun(json(Object.fromEntries(Object.entries(r).reverse())))), key);
  assert.equal(good(identifyRun(canonical(r))), key);
  const changes: ((r: Run) => void)[] = [];
  for (const arm of ['baseline', 'candidate'] as const) for (const field of Object.keys(r.candidate) as (keyof Run['candidate'])[]) changes.push(v => {
    v[arm]![field] = field === 'integrity' ? 'sha512-' + Buffer.alloc(64).toString('base64') : field === 'sourceCommit' || field === 'sourceTree' ? 'c'.repeat(40) : ['name', 'version'].includes(field) ? 'changed' : J;
  });
  for (const field of Object.keys(r.environment) as (keyof Run['environment'])[]) if (field !== 'native') changes.push(v => { Object.assign(v.environment, { [field]: field === 'resourcesDigest' ? J : 'changed' }); });
  for (const field of ['release', 'component', 'cohort', 'configDigest', 'workloadDigest'] as const) changes.push(v => { v[field] = field.endsWith('Digest') ? J : 'changed'; });
  changes.push(v => { v.selection.repetitions++; const { digest: _digest, ...s } = v.selection; v.selection.digest = hash(s); });
  for (const change of changes) { const v = structuredClone(r); change(v); assert.notEqual(good(identifyRun(json(v))), key); }
  const o = e.observations[0], sample = good(identifySample(json(o))), event = good(identifyEvent(json(o)));
  for (const change of [{ producer: 'other' }, { attempt: 'attempt-2' }]) {
    assert.equal(good(identifySample(json({ ...o, ...change }))), sample); assert.notEqual(good(identifyEvent(json({ ...o, ...change }))), event);
  }
  assert.equal(good(identifyEvent(json({ ...o, receipt: null }))), event);
  for (const change of [{ runKey: J }, { variant: 'candidate' }, { scenario: 'other' }, { repetition: 1 }, { warmup: true }]) assert.notEqual(good(identifySample(json({ ...o, ...change }))), sample);
  const defect = { version: 1, component: 'fixture', requirement: 'preserve', scenario: 'init', normalizedFailure: 'lost', cohort: 'fixture-cohort', policy };
  const id = good(identifyDefect(json(defect)));
  assert.equal(id, hash(['benchmark-defect/1', defect]));
  assert.equal(good(identifyDefect(canonical(defect))), id);
  for (const field of ['component', 'requirement', 'scenario', 'normalizedFailure', 'cohort']) assert.notEqual(good(identifyDefect(json({ ...defect, [field]: 'other' }))), id);
  assert.equal(identifyDefect(json({ ...defect, candidate: J })).ok, false);
  const first = fixture(); failed(first.observations[5]); const finding = compare(first).findings[0];
  const later = fixture(); later.run.candidate.packageSha256 = J;
  later.observations.forEach(o => { o.runKey = hash(['benchmark-run/1', later.run]); o.receipt!.receivedAt = 2; });
  failed(later.observations[5]); later.observations[5].receipt!.sha256 = J;
  assert.notEqual(compare(later).runKey, compare(first).runKey); assert.equal(compare(later).findings[0].defectKey, finding.defectKey);
  assert.equal(good(identifyRun(json(first.run))), key);
});
test('closed bounded JSON validation rejects malformed and hostile records', () => {
  const e = fixture(), r = e.run, raw = json(r);
  assert.equal(validateRun(raw).ok, true); assert.equal(validateEvidence(json(e)).ok, true);
  const { component: _component, ...missing } = r;
  const bad = [json(missing), json({ ...r, extra: true }), json({ ...r, version: 2 }), raw.replace('"version":1', '"version":1,"version":1'),
    raw.replace('"version":1', '"version":1,"\\u0076ersion":1'), json({ ...r, component: 'x'.repeat(513) }), ' '.repeat(8 * 1024 * 1024 + 1),
    '['.repeat(14) + '0' + ']'.repeat(14), json(Array(4097).fill(0)), json(Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['f' + i, 0]))),
    raw.replace('"configDigest":"' + H + '"', '"configDigest":"BAD"'), '{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}', '{"toString":"throw"}'];
  for (const input of bad) assert.equal(validateRun(input).ok, false, input.slice(0, 80));
  for (const integrity of ['sha256-AA==', 'sha256-' + Buffer.alloc(32).toString('base64').replace(/=$/, ''), 'sha512-???', 'sha1-AAAA']) assert.equal(validateRun(json({ ...r, candidate: { ...r.candidate, integrity } })).ok, false);
  for (const value of ['-1', '-0', '1e999', 'NaN']) assert.equal(validateEvidence(json(e).replace('"value":100', '"value":' + value)).ok, false);
  assert.deepEqual(validateRun(json(Array.from({ length: 4096 }, () => Array(123).fill(0)))), { ok: false, code: 'structure-limit' });
  for (const selection of [{ repetitions: 0 }, { repetitions: 1001 }, { warmups: 11 }, { scenarios: [] }, { scenarios: [r.selection.scenarios[0], r.selection.scenarios[0]] }]) assert.equal(validateRun(json({ ...r, selection: { ...r.selection, ...selection } })).ok, false);
  for (const metric of [{ value: null, reason: null, source: null }, { value: null, reason: 'missing', source: 'invented' }, { value: 1, reason: 'missing', source: 'clock' }, { value: 1, reason: null, source: '' }]) {
    const v = fixture(); v.observations[0].metrics.durationMs = metric; assert.equal(validateEvidence(json(v)).ok, false);
  }
  const typed = fixture(); typed.observations[0].receipt!.sha256 = 'F'.repeat(64); assert.equal(validateEvidence(json(typed)).ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  let accessed = false; const hostile = { get toString() { accessed = true; throw new Error('accessed'); } };
  assert.deepEqual(validateRun(hostile as unknown as string), { ok: false, code: 'input-limit' }); assert.equal(accessed, false);
});
test('replay is counted once and event sample receipt conflicts never overwrite', () => {
  const e = fixture(), o = e.observations[0];
  e.observations.push(structuredClone(o), { ...structuredClone(o), attempt: 'attempt-2' });
  const value = good(reconcileEvidence(json(e))); assert.equal(value.replays, 2); assert.equal(value.observations.length, 10); assert.deepEqual(value.observations[0], o);
  for (const [patch, code] of [[{ receipt: null }, 'event-conflict'], [{ attempt: 'other', receipt: null }, 'sample-conflict']] as const) {
    for (const reverse of [false, true]) { const v = fixture(); const rows = [v.observations[0], { ...structuredClone(v.observations[0]), ...patch }]; v.observations = reverse ? rows.reverse() : rows; assert.deepEqual(reconcileEvidence(json(v)), { ok: false, code }); }
  }
  for (const field of ['sha256', 'bytes', 'receivedAt'] as const) {
    const v = fixture(), copy = structuredClone(v.observations[0]); Object.assign(copy.receipt!, { [field]: field === 'sha256' ? J : 2 }); v.observations.push(copy);
    assert.deepEqual(reconcileEvidence(json(v)), { ok: false, code: 'event-conflict' });
  }
  const v = fixture(), changed = structuredClone(v.observations[0]); changed.metrics.durationMs.value = 101; v.observations.push(changed);
  assert.deepEqual(reconcileEvidence(json(v)), { ok: false, code: 'event-conflict' });
  changed.attempt = 'other'; assert.deepEqual(reconcileEvidence(json(v)), { ok: false, code: 'sample-conflict' });
});
test('comparison always denies execution task and loop authority', () => {
  for (const duration of [100, 200]) {
    const e = fixture(5, 0, 100, duration), c = compare(e);
    assert.equal(c.performance, duration === 100 ? 'not-triggered' : 'review-trigger');
    assert.equal(c.status, 'review-needed'); assert.equal(c.executionAuthorized, false); assert.equal(c.taskAdmissionAuthorized, false); assert.equal(c.loopActivationAuthorized, false);
    for (const grant of ['executionAuthorized', 'taskAdmissionAuthorized', 'loopActivationAuthorized']) assert.equal(compareEvidence(json({ ...e, [grant]: true })).ok, false);
  }
});
test('missing partial and uncertain evidence refuses while retaining correctness', () => {
  const cases: [string, (e: Evidence) => void][] = [
    ['missing-baseline', e => { e.run.baseline = null; e.run.baselineUnavailableReason = 'unavailable'; const k = hash(['benchmark-run/1', e.run]); e.observations.forEach(o => { o.runKey = k; }); }],
    ['missing-receipts', e => { e.observations[0].receipt = null; }],
    ['cleanup-uncertain', e => { e.observations[0].cleanup = 'uncertain'; }],
    ['clock-anomaly', e => { e.observations[0].clock = 'anomaly'; }],
    ['partial', e => { e.observations[0].state = 'partial'; e.observations[0].outcome = 'unknown'; e.observations[0].exitCode = null; }],
  ];
  for (const [reason, mutate] of cases) {
    const e = fixture(); failed(e.observations[5]); mutate(e); const c = compare(e);
    assert.equal(c.performance, 'refused'); assert.ok(c.reasons.includes(reason)); assert.equal(c.incomplete, true);
    assert.equal(c.scenarios[0].candidate.expected, 5); assert.equal(c.scenarios[0].candidate.observed, 5); assert.equal(c.scenarios[0].candidate.failures, 1);
    assert.equal(c.findings.length, 1); assert.equal(c.findings[0].normalizedFailure, 'preservation-failed');
  }
});
test('selection policy and run drift cannot provide comparative acceptance', () => {
  const e = fixture(5, 1);
  assert.deepEqual(validateRun(json({ ...e.run, selection: { ...e.run.selection, digest: J } })), { ok: false, code: 'selection-mismatch' });
  assert.deepEqual(validateRun(json({ ...e.run, policy: J })), { ok: false, code: 'policy-mismatch' });
  for (const warmup of [false, true]) {
    const v = fixture(5, 1); v.observations = v.observations.filter(o => !(o.variant === 'candidate' && o.warmup === warmup && o.repetition === 0));
    const c = compare(v); assert.equal(c.performance, 'refused'); assert.ok(c.reasons.includes('missing-selection-observations'));
  }
  const v = fixture(); v.run.selection.scenarios.push({ id: 'upgrade', requirement: 'preserve', oracleDigest: H });
  const { digest: _digest, ...selection } = v.run.selection; v.run.selection.digest = hash(selection);
  v.observations.forEach(o => { o.runKey = hash(['benchmark-run/1', v.run]); });
  assert.ok(compare(v).reasons.includes('missing-selection-observations'));
  e.observations[0].runKey = J; assert.ok(compare(e).reasons.includes('identity-mismatch'));
});
