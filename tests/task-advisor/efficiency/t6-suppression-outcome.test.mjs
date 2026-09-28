// 6. Supplied suppression evidence: rejected/deferred/reopen; condition-resolved is not adoption; no false resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, ev, errEv, rec, request, CFG } from './helpers.mjs';

const G = { mode: 'whole-workspace-diagnostic', taskIds: ['T2'], sids: [], releaseIds: [] };
const err = n => rec(errEv(n, { taskId: 'T2', sid: 's2' }));
const ok = n => rec(ev(n, { taskId: 'T2', sid: 's2' }));
const errs = k => Array.from({ length: k }, (_, i) => err(i + 1));
const KEY = E.semanticKeyV1('OWNER', 'R1171', 'repeated-error-class-v1', 'task', 'T2', 'transport');
const prior = (decision, evidenceDigest, deferredUntil = null, over = {}) => ({ semanticKey: KEY, rule: 'repeated-error-class-v1', scope: 'task',
  scopeId: 'T2', conditionKey: 'transport', decision, evidenceDigest, deferredUntil, ...over });
const run = (records, priorConditions = [], o = {}) => E.analyzeEfficiency(request({ grant: G, records, priorConditions, ...o })).value;
const taskP = r => r.proposals.find(p => p.semanticKey === KEY);
const base = run(errs(3));
const DIGEST = taskP(base).evidenceDigest;

test('rejected + unchanged evidence stays suppressed; outcome condition-present, adoption unknown', () => {
  const r = run(errs(3), [prior('rejected', DIGEST)]);
  assert.equal(taskP(r), undefined);
  assert.deepEqual(r.suppressed.find(s => s.semanticKey === KEY), { semanticKey: KEY, rule: 'repeated-error-class-v1', reason: 'rejected-unchanged' });
  assert.deepEqual(r.outcomes, [{ semanticKey: KEY, rule: 'repeated-error-class-v1', status: 'condition-present', adoption: 'unknown', associationOnly: true }]);
  const again = run(errs(5), [prior('rejected', DIGEST)]);
  assert.equal(taskP(again), undefined, 'observed 5/threshold 3 stays in the same log2 band (coder choice, not an approved causal metric)');
});

test('rejected + materially changed evidence (log2 band) reopens with reopenedFrom', () => {
  const r = run(errs(6), [prior('rejected', DIGEST)]);
  const p = taskP(r);
  assert.equal(p.status, 'reopened'); assert.equal(p.reopenedFrom, DIGEST); assert.notEqual(p.evidenceDigest, DIGEST);
});

test('deferred: suppressed before deferredUntil, reopened at/after it (fixed clock)', () => {
  const before = run(errs(3), [prior('deferred', DIGEST, '2026-09-03T00:00:01Z')]);
  assert.equal(taskP(before), undefined);
  assert.equal(before.suppressed.find(s => s.semanticKey === KEY).reason, 'deferred-until');
  const atBoundary = run(errs(3), [prior('deferred', DIGEST, '2026-09-03T00:00:00Z')]);
  assert.equal(taskP(atBoundary).status, 'reopened');
  const after = run(errs(3), [prior('deferred', DIGEST, '2026-09-02T12:00:00Z')]);
  assert.equal(taskP(after).status, 'reopened'); assert.equal(taskP(after).reopenedFrom, DIGEST);
});

test('REPORTED CHOICE: deferred + changed evidence reopens BEFORE deferredUntil (coder §5.3; controller to confirm)', t => {
  const r = run(errs(6), [prior('deferred', DIGEST, '2026-09-10T00:00:00Z')]);
  const p = taskP(r);
  t.diagnostic(`early-defer-reopen status=${p?.status} reopenedFrom=${p?.reopenedFrom === DIGEST}`);
  assert.equal(p.status, 'reopened'); // fact recorded; acceptance is a controller decision, not asserted as correct
});

test('priors must re-derive their semantic key and be inside the grant', () => {
  const forged = run(errs(3), [prior('rejected', DIGEST, null, { semanticKey: E.semanticKeyV1('OTHER', 'R1171', 'repeated-error-class-v1', 'task', 'T2', 'transport') })]);
  assert.equal(forged.counts.priorIgnored, 1); assert.ok(taskP(forged));
  const narrow = E.analyzeEfficiency(request({ grant: { mode: 'subjects', taskIds: ['T9'], sids: [], releaseIds: [] }, records: errs(3), priorConditions: [prior('rejected', DIGEST)] })).value;
  assert.equal(narrow.counts.priorIgnored, 1); assert.deepEqual(narrow.outcomes, []);
  const openPrior = run(errs(3), [prior('open', DIGEST)]);
  assert.equal(taskP(openPrior).status, 'open'); assert.equal(taskP(openPrior).reopenedFrom, null);
  const receipt = E.analyzeEfficiency({ ...request({ grant: G, records: errs(3) }), receipts: [{ adopted: true }] });
  assert.equal(receipt.ok, false); assert.equal(receipt.reason.code, 'unknown-field');
});

test('condition cleared with sufficient samples → condition-resolved, adoption unknown, association only (not "improved")', () => {
  const r = run([err(1), ok(2), ok(3), ok(4), ok(5)], [prior('rejected', DIGEST)]);
  assert.deepEqual(r.outcomes, [{ semanticKey: KEY, rule: 'repeated-error-class-v1', status: 'condition-resolved', adoption: 'unknown', associationOnly: true }]);
  assert.ok(!JSON.stringify(r).includes('improved'));
  const open = run([err(1), ok(2), ok(3)], [prior('rejected', DIGEST)], { now: '2026-09-01T12:00:00Z' });
  assert.equal(open.outcomes[0].status, 'insufficient-data', 'open window');
});

test('RED-CANDIDATE: low samples / no records / no exact binding / disabled detector must NOT show condition-resolved', () => {
  const latKey = E.semanticKeyV1('OWNER', 'R1171', 'handoff-latency-v1', 'task', 'T2', 'handoff-latency-start-ack');
  const latPrior = { ...prior('rejected', DIGEST), semanticKey: latKey, rule: 'handoff-latency-v1', conditionKey: 'handoff-latency-start-ack' };
  const cases = {
    'low-samples (1 record < minSamples 3)': run([err(1)], [prior('rejected', DIGEST)]),
    'zero records for the subject': run([], [prior('rejected', DIGEST)]),
    'no exact binding (latency insufficient-data)': run([1, 2, 3, 4].map(n => ok(n)), [latPrior]),
    'detector disabled (errorRepeatThreshold null)': run(errs(5), [prior('rejected', DIGEST)], { config: { ...CFG, errorRepeatThreshold: null } }),
  };
  const statuses = Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, r.outcomes[0].status]));
  for (const [name, status] of Object.entries(statuses)) assert.notEqual(status, 'condition-resolved', `${name}: ${JSON.stringify(statuses)}`);
});
