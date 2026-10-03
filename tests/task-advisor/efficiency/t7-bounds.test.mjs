// 7. Count/byte/group/op/map limits bounded + deterministic; no O(N^2) work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, ev, errEv, u, rec, request, state, collect, ccfg, bytes, CFG } from './helpers.mjs';

const G = { mode: 'whole-workspace-diagnostic', taskIds: ['T2'], sids: [], releaseIds: [] };
const err = n => rec(errEv(n, { taskId: 'T2', sid: 's2' }));

test('record budget: truncation keeps earliest deterministically, partial, no proposals', () => {
  const recs = [1, 2, 3, 4, 5].map(err);
  const r = E.analyzeEfficiency(request({ grant: G, records: [...recs].reverse(), config: { ...CFG, maxRecords: 3 } })).value;
  assert.equal(r.counts.recordsTruncated, 2);
  assert.ok(r.coverage.reasons.includes('record-budget'));
  assert.equal(r.coverage.overall, 'partial');
  assert.equal(r.proposals.length, 0);
  assert.equal(r.metrics.find(m => m.scope === 'task' && m.conditionKey === 'transport').observed, 3);
  const r2 = E.analyzeEfficiency(request({ grant: G, records: recs, config: { ...CFG, maxRecords: 3 } })).value;
  assert.deepEqual(r, r2);
});

test('operation budget: partial, no metrics, no proposals, outcomes not resolved', () => {
  const r = E.analyzeEfficiency(request({ grant: G, records: [1, 2, 3, 4, 5].map(err), config: { ...CFG, maxOperations: 4 },
    priorConditions: [{ semanticKey: E.semanticKeyV1('OWNER', 'R1171', 'repeated-error-class-v1', 'task', 'T2', 'transport'), rule: 'repeated-error-class-v1',
      scope: 'task', scopeId: 'T2', conditionKey: 'transport', decision: 'rejected', evidenceDigest: 'a'.repeat(64), deferredUntil: null }] })).value;
  assert.ok(r.coverage.reasons.includes('operation-budget'));
  assert.equal(r.coverage.overall, 'partial');
  assert.deepEqual(r.metrics, []); assert.deepEqual(r.proposals, []);
  assert.equal(r.outcomes[0].status, 'insufficient-data');
  assert.equal(r.counts.operations, 4);
});

test('group budget: overflow counted, partial, no proposals', () => {
  const recs = []; for (let i = 0; i < 10; i++) recs.push(rec(errEv(i + 1, { taskId: null, sid: `s${i}` })));
  const r = E.analyzeEfficiency(request({ records: recs, config: { ...CFG, maxGroups: 4 } })).value;
  assert.ok(r.counts.groupsOverflow > 0);
  assert.ok(r.coverage.reasons.includes('group-budget'));
  assert.equal(r.coverage.overall, 'partial'); assert.equal(r.proposals.length, 0);
  assert.ok(new Set(r.metrics.map(m => `${m.scope}:${m.scopeId}`)).size <= 4);
});

test('collector maps stay bounded under sustained input (dedup, conflicts, recent escalations, gaps, tail)', () => {
  const cfg = ccfg({ dedupCapacity: 50, recentEscalationCapacity: 20, maxGapsRetained: 3, maxLineBytes: 512 });
  let st = state();
  for (let w = 0; w < 20; w++) {
    const objs = []; for (let i = 0; i < 30; i++) objs.push(ev(w * 30 + i + 1)); objs.push({ ...ev(w * 30 + 1), pid: 5 });
    const r = collect(st, [bytes(...objs)], { generation: w % 4 === 3 ? w : st.generation, cursor: w % 4 === 3 ? 0 : st.cursor }, cfg);
    st = r.state;
    assert.ok(st.eventIds.length <= 50 && st.conflictedIds.length <= 50 && st.gaps.length <= 3);
  }
  let es = state('verify-escalations-v1', 'esc');
  for (let w = 0; w < 5; w++) {
    const objs = []; for (let i = 0; i < 30; i++) objs.push({ sid: 's1', ts: new Date(Date.UTC(2026, 8, 1) + (w * 30 + i) * 1000).toISOString(), rc: 1 });
    es = collect(es, [bytes(...objs)], {}, cfg).state;
    assert.ok(es.recentEscalations.length <= 20);
  }
  assert.equal(st.eventIds.at(-1)[0], u(600));
});

test('determinism: identical and shuffled inputs give deep-equal reports', () => {
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(rec(i % 3 ? errEv(i + 1, { taskId: `T${i % 4}`, sid: `s${i % 5}` }) : ev(i + 1, { taskId: `T${i % 4}`, sid: `s${i % 5}`, role: `r${i % 2}` })));
  const grant = { mode: 'whole-workspace-diagnostic', taskIds: ['T0', 'T1', 'T2', 'T3'], sids: [], releaseIds: [] };
  const a = E.analyzeEfficiency(request({ grant, records: recs })).value;
  let seed = 7; const shuffled = [...recs].sort(() => ((seed = (seed * 16807) % 2147483647) % 3) - 1);
  const b = E.analyzeEfficiency(request({ grant, records: shuffled })).value;
  assert.deepEqual(a, b);
  assert.ok(a.proposals.length > 0);
});

function sortedElementsFor(N) {
  const recs = [];
  for (let i = 0; i < N; i++) recs.push(rec(ev(i + 1, { at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), taskId: 'T2', sid: 's2',
    role: `r${i.toString(36)}`, producerVersion: `v${i}` })));
  const orig = Array.prototype.sort; let sorted = 0;
  Array.prototype.sort = function (...a) { sorted += this.length; return orig.apply(this, a); };
  let r;
  try { r = E.analyzeEfficiency(request({ grant: G, records: recs, config: { ...CFG, maxRecords: 20_000, maxOperations: 50_000_000 } })); }
  finally { Array.prototype.sort = orig; }
  assert.equal(r.ok, true);
  return { sorted, operations: r.value.counts.operations };
}

test('RED-CANDIDATE no O(N^2): sort work must not grow quadratically with distinct roles × producer versions', t => {
  const a = sortedElementsFor(500), b = sortedElementsFor(1000);
  t.diagnostic(`N=500 sortedElements=${a.sorted} ops=${a.operations}; N=1000 sortedElements=${b.sorted} ops=${b.operations}; ratio=${(b.sorted / a.sorted).toFixed(2)}`);
  t.diagnostic(`baseline-only (not asserted in r2): ops=${b.operations} vs sortedElements=${b.sorted}`);
  assert.ok(b.sorted / a.sorted < 3, `doubling N should not ~4x the sort work (ratio ${(b.sorted / a.sorted).toFixed(2)})`);
});
