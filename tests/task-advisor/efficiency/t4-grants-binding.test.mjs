// 4. Whole-workspace aggregate + per-task detail; narrow grants leak nothing; exact binding for timing; unknown != zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, ev, errEv, at, rec, escRec, request, metricsOf, src, SOURCES, CFG } from './helpers.mjs';

const T1 = (n, o = {}) => ev(n, { taskId: 'T1', sid: 's1', ...o });
const T2 = (n, o = {}) => ev(n, { taskId: 'T2', sid: 's2', producerVersion: '9.9.9-othertask', role: 'othrole', ...o });
const t1Data = [rec(T1(1)), rec(errEv(2, { taskId: 'T1', sid: 's1' })), rec(errEv(3, { taskId: 'T1', sid: 's1' }))];
const t2Data = [rec(T2(11)), rec(errEv(12, { taskId: 'T2', sid: 's2', producerVersion: '9.9.9-othertask' })),
  rec(T2(13, { sid: 's1' })), rec(errEv(14, { taskId: null, sid: 's2' })), rec(errEv(15, { taskId: null, sid: null }))];
const grantT1 = { mode: 'subjects', taskIds: ['T1'], sids: [], releaseIds: [] };

test('whole-workspace grant: system aggregate, listed per-task detail, separate unattributed bucket, non-null counters', () => {
  const r = E.analyzeEfficiency(request({ grant: { mode: 'whole-workspace-diagnostic', taskIds: ['T1', 'T2'], sids: [], releaseIds: [] },
    records: [...t1Data, ...t2Data] })).value;
  const scopes = new Set(r.metrics.map(m => `${m.scope}:${m.scopeId}`));
  for (const s of ['system:null', 'task:T1', 'task:T2', 'session:s1', 'session:s2', 'unattributed:null']) assert.ok(scopes.has(s), s);
  const sys = r.metrics.find(m => m.scope === 'system' && m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1');
  assert.equal(sys.observed, 8);
  assert.equal(r.counts.unattributed, 2);
  assert.equal(r.counts.recordsSupplied, 8);
  assert.equal(r.counts.nonSubjectTasks, 0);
  const unattr = r.metrics.filter(m => m.scope === 'unattributed' && m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1');
  assert.equal(unattr.reduce((a, m) => a + m.observed, 0), 2);
  assert.ok(unattr.every(m => ['no-task', 'ambiguous-attempt'].includes(m.attributionReason)));
  const ws2 = E.analyzeEfficiency(request({ records: [...t1Data, ...t2Data] })).value;
  assert.equal(ws2.counts.nonSubjectTasks, 2, 'unlisted tasks appear only as a count under whole-workspace');
  assert.ok(!JSON.stringify(ws2).includes('"T2"'));
});

test('narrow task grant: T1 view is byte-identical with or without other-task data (no IDs/counts/versions/diagnostics)', () => {
  const alone = E.analyzeEfficiency(request({ grant: grantT1, records: t1Data })).value;
  const mixed = E.analyzeEfficiency(request({ grant: grantT1, records: [...t2Data, ...t1Data] })).value;
  assert.deepEqual(mixed, alone);
  const text = JSON.stringify(mixed);
  for (const leak of ['T2', 's2', '9.9.9-othertask', 'othrole']) assert.ok(!text.includes(leak), leak);
  for (const k of ['recordsSupplied', 'recordsTruncated', 'lateExcluded', 'conflictsExcluded', 'undeclaredSource', 'unattributed', 'nonSubjectTasks', 'operations'])
    assert.equal(mixed.counts[k], null, k);
  assert.ok(mixed.metrics.every(m => m.scope === 'task' && m.scopeId === 'T1'));
});

test('sid + task grant: other task sharing the granted sid is not counted in the session group', () => {
  const grant = { mode: 'subjects', taskIds: ['T1'], sids: ['s1'], releaseIds: [] };
  const r = E.analyzeEfficiency(request({ grant, records: [...t1Data, ...t2Data] })).value;
  const sess = r.metrics.find(m => m.scope === 'session' && m.scopeId === 's1' && m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1');
  assert.equal(sess.observed, 3, 'T2 event on s1 hidden');
  assert.ok(!JSON.stringify(r).includes('T2'));
  assert.ok(!r.metrics.some(m => m.scope === 'unattributed' || m.scope === 'system'));
});

test('diagnostic input cannot grant: release/sid claims on other-task events do not expose them', () => {
  const grant = { mode: 'subjects', taskIds: [], sids: [], releaseIds: ['R9'] };
  const forged = [rec(T2(21, { releaseId: 'R9' })), rec(errEv(22, { taskId: 'T2', sid: 's2', releaseId: 'R9' }))];
  const r = E.analyzeEfficiency(request({ grant, records: forged })).value;
  const rel = r.metrics.find(m => m.scope === 'release' && m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1');
  assert.equal(rel.observed, 0);
  assert.ok(!JSON.stringify(r).includes('T2'));
  assert.equal(r.grantMode, 'subjects');
});

test('OBSERVATION: other-task source-level problems change the narrow view coverage (1-bit, conservative)', t => {
  const conflict = [rec(T2(31)), rec({ ...T2(31), pid: 7 })];
  const alone = E.analyzeEfficiency(request({ grant: grantT1, records: t1Data })).value;
  const mixed = E.analyzeEfficiency(request({ grant: grantT1, records: [...t1Data, ...conflict] })).value;
  const budget = E.analyzeEfficiency(request({ grant: grantT1, records: [...t1Data, ...t2Data], config: { ...CFG, maxRecords: 3 } })).value;
  t.diagnostic(`alone=${alone.coverage.overall}/${alone.coverage.reasons} withT2Conflict=${mixed.coverage.overall}/${mixed.coverage.reasons} withT2Budget=${budget.coverage.overall}/${budget.coverage.reasons}`);
  assert.ok(!JSON.stringify(mixed).includes('T2'), 'no identity leak even so');
});

test('exact binding: start/ack/check/report with task+sid+attempt+operation → producer-clock intervals; report latency is work-duration', () => {
  const b = (n, kind, minute, extra = {}) => rec(ev(n, { kind, producer: 'dispatch', at: at(minute), taskId: 'T1', sid: 's1', attempt: 'a1', operation: 'op', dispatchId: 'd1',
    outcome: kind === 'dispatch.ack' || kind === 'dispatch.started_check' ? 'verified' : null, ...extra }));
  const recs = [b(1, 'dispatch.start', 10), b(2, 'dispatch.ack', 11), b(3, 'dispatch.started_check', 13),
    rec(ev(4, { kind: 'inject.report', producer: 'inject-handler', at: at(40), taskId: 'T1', sid: 's1', attempt: 'a1', operation: 'op', dispatchId: 'd1', role: null }))];
  const r = E.analyzeEfficiency(request({ grant: grantT1, records: recs })).value;
  const lat = name => r.metrics.find(m => m.scope === 'task' && m.metric === name);
  assert.deepEqual(lat('handoff-latency-start-ack').distribution, { p50: 60_000, p90: 60_000, max: 60_000 });
  assert.deepEqual(lat('handoff-latency-ack-started-check').distribution, { p50: 120_000, p90: 120_000, max: 120_000 });
  assert.equal(lat('report-latency-ack-report').basis, 'work-duration');
  assert.equal(lat('report-latency-ack-report').distribution.max, 29 * 60_000);
  assert.equal(lat('handoff-latency-start-ack').basis, 'producer-clock-interval');
  assert.equal(lat('handoff-latency-start-ack').status, 'observed');
  assert.ok(!r.proposals.some(p => p.conditionKey === 'report-latency-ack-report'), 'work duration never proposed as waste');
});

test('missing attempt/operation/sid/task → timing insufficient-data with exact-binding-unavailable, never inferred', () => {
  for (const drop of [{ attempt: null }, { operation: null }, { attempt: undefined, operation: undefined }]) {
    const mk = (n, kind, minute) => { const e = ev(n, { kind, at: at(minute), taskId: 'T1', sid: 's1', attempt: 'a1', operation: 'op',
      outcome: kind === 'dispatch.ack' ? 'verified' : null, ...drop }); for (const k of Object.keys(drop)) if (drop[k] === undefined) delete e[k]; return rec(e); };
    const r = E.analyzeEfficiency(request({ grant: grantT1, records: [mk(1, 'dispatch.start', 1), mk(2, 'dispatch.ack', 2)] })).value;
    const m = r.metrics.find(x => x.scope === 'task' && x.metric === 'handoff-latency-start-ack');
    assert.equal(m.status, 'insufficient-data'); assert.equal(m.observed, null); assert.equal(m.distribution, null);
    assert.equal(m.attributionReason, 'exact-binding-unavailable'); assert.equal(m.unknown, 2);
  }
});

test('delayed old-attempt report cannot attach to new work; dispatchId mismatch → ambiguous, no interval', () => {
  const k = (n, kind, minute, attempt, dispatchId = 'd1') => rec(ev(n, { kind, producer: kind.startsWith('inject') ? 'inject-handler' : 'dispatch', at: at(minute), taskId: 'T1', sid: 's1',
    attempt, operation: 'op', dispatchId, role: kind === 'dispatch.start' ? 'coder' : null, outcome: kind === 'dispatch.ack' ? 'verified' : null }));
  const recs = [k(1, 'dispatch.start', 0, 'a1'), k(2, 'dispatch.ack', 1, 'a1'), k(3, 'dispatch.start', 5, 'a2', 'd2'), k(4, 'dispatch.ack', 6, 'a2', 'd2'),
    k(5, 'inject.report', 30, 'a1')];
  const r = E.analyzeEfficiency(request({ grant: grantT1, records: recs })).value;
  const rep = r.metrics.find(m => m.scope === 'task' && m.metric === 'report-latency-ack-report');
  assert.equal(rep.samples, 1);
  assert.equal(rep.distribution.max, 29 * 60_000, 'bound to a1 ack, not a2 ack (would be 24 min)');
  const mismatch = [k(1, 'dispatch.start', 0, 'a1', 'd1'), k(2, 'dispatch.ack', 1, 'a1', 'd9')];
  const m = E.analyzeEfficiency(request({ grant: grantT1, records: mismatch })).value;
  assert.equal(m.counts.ambiguousBindings, 1);
  assert.equal(m.metrics.find(x => x.scope === 'task' && x.metric === 'handoff-latency-start-ack').status, 'insufficient-data');
  const dupAck = [k(1, 'dispatch.start', 0, 'a1'), k(2, 'dispatch.ack', 1, 'a1'), k(3, 'dispatch.ack', 2, 'a1')];
  assert.equal(E.analyzeEfficiency(request({ grant: grantT1, records: dupAck })).value.counts.ambiguousBindings, 1);
  const neg = [k(1, 'dispatch.start', 5, 'a1'), k(2, 'dispatch.ack', 1, 'a1')];
  const n = E.analyzeEfficiency(request({ grant: grantT1, records: neg })).value;
  assert.equal(n.counts.clockAnomalies, 1); assert.ok(n.coverage.reasons.includes('clock-anomaly'));
});

test('attribution: exact (sid,dispatchId) binding only; sid-only never binds even if one task is open on that sid', () => {
  const start = rec(ev(1, { taskId: 'T1', sid: 's1', dispatchId: 'd1' }));
  const ackBound = rec(ev(2, { kind: 'dispatch.ack', outcome: 'unverified', taskId: null, sid: 's1', dispatchId: 'd1', role: null }));
  const sidOnly = rec(errEv(3, { taskId: null, sid: 's1' }));
  const ws = { mode: 'whole-workspace-diagnostic', taskIds: ['T1'], sids: [], releaseIds: [] };
  const r = E.analyzeEfficiency(request({ grant: ws, records: [start, ackBound, sidOnly] })).value;
  const t1 = r.metrics.find(m => m.scope === 'task' && m.scopeId === 'T1' && m.conditionKey === 'delivery-unverified');
  assert.equal(t1.observed, 1);
  assert.ok(!r.metrics.some(m => m.scope === 'task' && m.conditionKey === 'transport'), 'sid-only error not attached to T1');
  assert.ok(r.metrics.some(m => m.scope === 'unattributed' && m.attributionReason === 'ambiguous-attempt'));
  const twoStarts = [start, rec(ev(4, { taskId: 'T2', sid: 's1', dispatchId: 'd1' })), ackBound];
  const r2 = E.analyzeEfficiency(request({ grant: ws, records: twoStarts })).value;
  assert.ok(!r2.metrics.some(m => m.scope === 'task' && m.conditionKey === 'delivery-unverified'), 'ambiguous start mapping binds nothing');
});

test('unknown is not zero: unavailable/missing sources give observed null + source-unavailable; unsupported metrics listed', () => {
  const sources = [src('spool', 'advisor-spool-v1', { available: false, coverage: 'unknown', coveredFrom: null, coveredTo: null })];
  const r = E.analyzeEfficiency(request({ grant: grantT1, sources, records: [] })).value;
  for (const m of r.metrics.filter(x => x.metric === 'record-count')) {
    assert.equal(m.status, 'source-unavailable'); assert.equal(m.observed, null); assert.equal(m.coverage, 'unknown');
  }
  assert.equal(r.coverage.overall, 'unknown');
  assert.ok(r.coverage.reasons.includes('spool-unavailable') && r.coverage.reasons.includes('escalations-unavailable'));
  assert.deepEqual(r.unsupported.map(x => x.metric).sort(), ['auth-expiry-repeats', 'causality', 'cpu-per-worker', 'dependency-graph',
    'redundant-tool-reads', 'serial-wait-waste', 'token-cost', 'tool-call-timing']);
  assert.ok(r.unsupported.every(x => x.status === 'source-unavailable' && x.observed === null));
  const avail = E.analyzeEfficiency(request({ grant: grantT1, records: [] })).value;
  const zero = avail.metrics.find(m => m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1');
  assert.equal(zero.observed, 0, 'declared complete source with no records is an observed zero');
  const gapSrc = [src('spool', 'advisor-spool-v1', { coveredFrom: '2026-09-01T06:00:00Z' }), SOURCES[1]];
  const g = E.analyzeEfficiency(request({ grant: grantT1, sources: gapSrc })).value;
  assert.equal(g.coverage.bySource[0].coverage, 'gap'); assert.ok(g.coverage.reasons.includes('source-window-gap'));
  const esc = E.analyzeEfficiency(request({ grant: { mode: 'subjects', taskIds: [], sids: ['s1'], releaseIds: [] }, records: [escRec(1, 's1', '2026-09-01T01:00:00Z')] })).value;
  assert.equal(esc.metrics.find(m => m.conditionKey === 'verify-escalation').observed, 1);
});
