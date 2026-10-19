import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { validateEvidence, type Evidence, type Run, type Observation, type Result } from '../../src/release-benchmark/contracts.js';
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

test('intentional regression requires both strict thresholds including zero baseline', () => {
  const cases = [[100, 151, 'review-trigger'], [100, 150, 'not-triggered'], [1000, 1200, 'not-triggered'],
    [1000, 1201, 'review-trigger'], [1000, 1100, 'not-triggered'], [10, 50, 'not-triggered'], [0, 50, 'not-triggered'], [0, 51, 'review-trigger']] as const;
  for (const [a, b, expected] of cases) {
    const c = compare(fixture(5, 0, a, b)); assert.equal(c.performance, expected, json([a, b]));
    assert.deepEqual(c.reasons, []); assert.equal(c.scenarios[0].matchedSuccesses, 5); assert.equal(c.incomplete, false);
    assert.equal(c.findings.length, expected === 'review-trigger' ? 1 : 0);
    if (expected === 'review-trigger') { assert.equal(c.findings[0].kind, 'performance-regression'); assert.equal(c.findings[0].normalizedFailure, 'duration-median-regression'); }
  }
  const e = fixture(5, 0, 100, 200); failed(e.observations[5]); const c = compare(e);
  assert.equal(c.performance, 'refused'); assert.equal(c.findings.length, 1); assert.equal(c.findings[0].kind, 'correctness-regression');
});
test('equal complete evidence replays deterministically with warmup exclusion', () => {
  const e = fixture(5, 1), original = compare(e); assert.deepEqual(compare(e), original);
  assert.equal(original.performance, 'not-triggered'); assert.deepEqual(original.findings, []); assert.deepEqual(original.reasons, []);
  assert.deepEqual(original.coverage, { expected: 12, observed: 12, failures: 0, unknown: 0 });
  const expected = { expected: 5, observed: 5, successes: 5, failures: 0, unknown: 0, validDurations: 5,
    minMs: { value: 100, reason: null, source: 'caller-observations/descriptive' }, medianMs: { value: 100, reason: null, source: 'caller-observations/descriptive' },
    maxMs: { value: 100, reason: null, source: 'caller-observations/descriptive' }, p95Ms: { value: null, reason: 'fewer-than-100-or-unmatched-successes', source: null } };
  assert.deepEqual(original.scenarios[0].baseline, expected); assert.deepEqual(original.scenarios[0].candidate, expected);
  e.observations.push(structuredClone(e.observations[0]), { ...structuredClone(e.observations[0]), attempt: 'attempt-2' });
  assert.deepEqual(compare(e), { ...original, replays: 2 });
  e.observations.reverse(); assert.deepEqual(compare(e), { ...original, replays: 2 });
});
test('mismatched records refuse performance without attributing unrelated correctness', () => {
  for (const change of [{ runKey: J }, { scenario: 'foreign' }, { repetition: 5 }]) {
    const e = fixture(), unrelated = structuredClone(e.observations[5]); Object.assign(unrelated, change); failed(unrelated);
    e.observations.push(unrelated); const c = compare(e);
    assert.equal(c.performance, 'refused'); assert.equal(c.incomplete, true);
    assert.ok(c.reasons.includes('runKey' in change ? 'identity-mismatch' : 'selection-mismatch'));
    assert.equal(c.scenarios[0].candidate.observed, 5);
    // Strict independent oracle: out-of-selection failures cannot prove selected correctness.
    assert.deepEqual(c.findings, [], json(change));
  }
});
test('unknown resources and costs stay explicit and summaries use caller observations', () => {
  const e = fixture(), decoded = good(validateEvidence(json(e)));
  for (const o of decoded.observations) for (const key of ['cpuUserMs', 'cpuSystemMs', 'peakRssBytes', 'ioBytes', 'toolCalls', 'tokens', 'charge'] as const)
    assert.deepEqual(o.metrics[key], { value: null, reason: 'not-instrumented', source: null });
  assert.equal(decoded.observations[0].currency, null);
  const c = compare(e); assert.equal(c.scenarios[0].candidate.medianMs.source, 'caller-observations/descriptive');
  assert.deepEqual(Object.keys(c.scenarios[0].candidate).sort(), ['expected', 'observed', 'successes', 'failures', 'unknown', 'validDurations', 'minMs', 'medianMs', 'maxMs', 'p95Ms'].sort());
  for (const source of ['parent-process', 'parent_process', 'process.resourceUsage']) {
    const v = fixture(); v.observations[0].metrics.cpuUserMs = { value: 1, reason: null, source };
    assert.deepEqual(validateEvidence(json(v)), { ok: false, code: 'parent-process-metric' });
  }
  e.observations[5].metrics.durationMs = { value: null, reason: 'clock-unavailable', source: null };
  assert.deepEqual(good(validateEvidence(json(e))).observations[5].metrics.durationMs, e.observations[5].metrics.durationMs);
  const missing = compare(e); assert.equal(missing.performance, 'refused'); assert.ok(missing.reasons.includes('duration-unavailable')); assert.equal(missing.scenarios[0].matchedSuccesses, 4);
});
test('small matched samples refuse and p95 requires one hundred valid pairs', () => {
  for (const n of [1, 4, 5, 99, 100]) {
    const e = fixture(n); for (const o of e.observations) o.metrics.durationMs.value = o.repetition + 1;
    const c = compare(e), s = c.scenarios[0]; assert.equal(s.matchedSuccesses, n); assert.equal(c.confidence, 'none');
    assert.equal(c.performance, n < 5 ? 'refused' : 'not-triggered');
    if (n < 5) assert.ok(c.reasons.includes('insufficient-matched-successes'));
    for (const arm of [s.baseline, s.candidate]) {
      assert.equal(arm.p95Ms.value, n === 100 ? 95 : null);
      assert.equal(arm.p95Ms.reason, n === 100 ? null : 'fewer-than-100-or-unmatched-successes');
    }
    if (n === 100) { assert.equal(s.candidate.minMs.value, 1); assert.equal(s.candidate.medianMs.value, 50.5); assert.equal(s.candidate.maxMs.value, 100); }
  }
  const e = fixture(100); e.observations[100].receipt = null; const c = compare(e);
  assert.equal(c.performance, 'refused'); assert.equal(c.scenarios[0].matchedSuccesses, 99); assert.equal(c.scenarios[0].baseline.p95Ms.value, null); assert.equal(c.scenarios[0].candidate.p95Ms.value, null);
});
test('flaky failures warmups and explicit finding receipt caps remain bounded', () => {
  const e = fixture(5, 1); failed(e.observations[6]); failed(e.observations[11]); const c = compare(e);
  assert.equal(c.performance, 'refused'); assert.ok(c.reasons.includes('flaky-outcomes'));
  assert.deepEqual(c.coverage, { expected: 12, observed: 12, failures: 2, unknown: 0 });
  assert.equal(c.scenarios[0].candidate.expected, 5); assert.equal(c.scenarios[0].candidate.observed, 5); assert.equal(c.scenarios[0].candidate.failures, 1);
  assert.equal(c.findings.length, 1); assert.equal(c.findings[0].evidenceReceipts.length, 2);
  for (const distinct of [false, true]) for (const n of [64, 65]) {
    const v = fixture(n); for (const o of v.observations.filter(o => o.variant === 'candidate')) failed(o, distinct ? 'failure-' + o.repetition : 'shared-failure');
    const result = compare(v); assert.equal(result.findingsTruncated, n === 65); assert.equal(result.incomplete, true);
    assert.equal(result.findings.length, distinct ? 64 : 1); assert.equal(result.reasons.includes('findings-cap'), n === 65);
    assert.equal(result.findings[0].evidenceReceipts.length, distinct ? 1 : 64);
    assert.equal(result.coverage.failures, n); assert.equal(result.scenarios[0].candidate.observed, n);
  }
  const baselineFailure = fixture(); failed(baselineFailure.observations[0]);
  assert.deepEqual(compare(baselineFailure).findings, []);
});
