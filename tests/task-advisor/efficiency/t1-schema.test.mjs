// 1. Closed schemas, finite values, unknown keys, prototype hazards, fixed refusal text, sentinel non-leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, K, ev, errEv, u, at, bytes, enc, state, collect, SECRET, CODE, PROMPT, assertNoSentinel, request, rec, CFG, E } from './helpers.mjs';

const REFUSAL_CODES = new Set(['invalid-shape', 'unknown-field', 'unknown-version', 'invalid-value', 'input-limit', 'duplicate-id', 'grant-invalid']);
function refused(r, code) {
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.reason).sort(), ['code', 'path']);
  assert.ok(REFUSAL_CODES.has(r.reason.code));
  if (code) assert.equal(r.reason.code, code);
  assert.match(r.reason.path, /^\$[A-Za-z0-9_.[\]$]*$/, 'path is a fixed schema path');
  assertNoSentinel(r, 'refusal');
}

test('valid event normalizes: optional ids null, eventId lowercased, no extra keys', () => {
  const r = C.validateEventV1({ ...ev(1), eventId: u(1).toUpperCase() });
  assert.equal(r.ok, true);
  assert.equal(r.value.eventId, u(1));
  assert.equal(r.value.attempt, null); assert.equal(r.value.operation, null); assert.equal(r.value.releaseId, null);
  assert.deepEqual(Object.keys(r.value).sort(), [...C.EVENT_V1_FIELDS, ...C.EVENT_V1_OPTIONAL_FIELDS].sort());
  const withIds = C.validateEventV1(ev(2, { attempt: 'a1', operation: 'op1', releaseId: 'R1' }));
  assert.equal(withIds.value.attempt, 'a1');
});

test('version checked before unknown keys; unknown key refused at $ without echo', () => {
  refused(C.validateEventV1({ ...ev(1), v: 2, [SECRET]: 1 }), 'unknown-version');
  refused(C.validateEventV1({ ...ev(1), [SECRET]: CODE }), 'unknown-field');
  refused(C.validateEventV1({ ...ev(1), detail: PROMPT }), 'unknown-field');
  const missing = ev(1); delete missing.pid;
  refused(C.validateEventV1(missing), 'invalid-shape');
});

test('prototype hazards: __proto__ own key, class instances, arrays, null-proto', () => {
  refused(C.validateEventV1(JSON.parse(`{"__proto__":{"x":1},${JSON.stringify(ev(1)).slice(1)}`)), 'unknown-field');
  refused(C.validateEventV1(JSON.parse(`{"constructor":"${SECRET}",${JSON.stringify(ev(1)).slice(1)}`)), 'unknown-field');
  class Evil {} const inst = Object.assign(new Evil(), ev(1));
  refused(C.validateEventV1(inst), 'invalid-shape');
  refused(C.validateEventV1([ev(1)]), 'invalid-shape');
  refused(C.validateEventV1(null), 'invalid-shape');
  const nullProto = Object.assign(Object.create(null), ev(1));
  assert.equal(C.validateEventV1(nullProto).ok, true);
  const throwing = { ...ev(1) }; Object.defineProperty(throwing, 'sid', { enumerable: true, get() { throw new Error(SECRET); } });
  refused(C.validateEventV1(throwing));
  assert.equal(Object.prototype.polluted, undefined);
});

test('finite integer / enum / timestamp checks', () => {
  for (const pid of [NaN, Infinity, -Infinity, 1.5, 0, -1, 2 ** 31, '100', null]) refused(C.validateEventV1(ev(1, { pid })), 'invalid-value');
  for (const count of [NaN, 1.5, -1, 1_000_001]) refused(C.validateEventV1(ev(1, { count })), 'invalid-value');
  assert.equal(C.validateEventV1(ev(1, { count: 1_000_000 })).ok, true);
  for (const bad of ['2026-09-01T00:00:00Z', '2026-02-30T00:00:00.000Z', '2026-09-01T00:00:00.000+00:00', SECRET])
    refused(C.validateEventV1(ev(1, { at: bad })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { eventId: 'not-a-uuid' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { eventId: '00000000-0000-1000-8000-000000000001' })), 'invalid-value'); // v1 uuid
  refused(C.validateEventV1(ev(1, { producer: 'reconciler' })), 'invalid-value'); // kind↔producer
  refused(C.validateEventV1(ev(1, { outcome: 'verified' })), 'invalid-value'); // start must have null outcome
  refused(C.validateEventV1(ev(1, { kind: 'dispatch.ack' })), 'invalid-value'); // ack needs outcome
  assert.equal(C.validateEventV1(ev(1, { kind: 'dispatch.ack', outcome: 'unverified' })).ok, true);
  refused(C.validateEventV1(errEv(1, { kind: 'reconciler.cleanup', outcome: 'verified' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { errorClass: 'oom' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { usageSource: 'measured' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { auth: 'verified' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { role: 'Coder' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { sid: 's 1' })), 'invalid-value');
  refused(C.validateEventV1(ev(1, { attempt: '' })), 'invalid-value');
});

test('escalation whitelist: only sid,ts,rc survive; detail dropped unread; other keys refused', () => {
  const r = C.validateEscalationV1({ sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 3, detail: { secret: SECRET, code: CODE, prompt: PROMPT } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 3 });
  refused(C.validateEscalationV1({ sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 3, stderr: SECRET }), 'unknown-field');
  refused(C.validateEscalationV1({ sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 1.5 }), 'invalid-value');
});

test('legacy detail with secret/code/prompt sentinels never reaches records, counters, state or diagnostics', () => {
  const lines = [
    { sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 1, detail: `${SECRET} ${CODE} ${PROMPT}` },
    { sid: 's1', ts: '2026-09-01T00:00:01.5Z', rc: 2, detail: { nested: [SECRET, { p: PROMPT }] } },
    { sid: `${SECRET} ${CODE}`, ts: '2026-09-01T00:00:00Z', rc: 1 }, // invalid sid → refused, not echoed
    `{"sid":"s1","ts":"2026-09-01T00:00:02Z","rc":1,"${SECRET}":1}\n`,
    `not json ${CODE}\n`,
  ];
  const st = state('verify-escalations-v1', 'esc');
  const res = collect(st, [bytes(...lines)]);
  assert.equal(res.records.length, 2);
  assert.equal(res.counters.invalidValue, 1); assert.equal(res.counters.unknownField, 1); assert.equal(res.counters.malformed, 1);
  assertNoSentinel(res, 'collect result incl. state');
  for (const r of res.records) {
    assert.deepEqual(Object.keys(r).sort(), ['generation', 'late', 'lineStart', 'observedAt', 'possibleDuplicate', 'provenance', 'rc',
      'recordId', 'sid', 'sourceId', 'sourceKind', 'timeBasis', 'ts', 'type']);
    assert.equal(C.validateCollectedRecordV1(r).ok, true, 'collector output round-trips the closed record schema');
  }
  // Analyzer diagnostics built from these records carry no sentinel either.
  const report = E.analyzeEfficiency(request({ records: res.records }));
  assert.equal(report.ok, true);
  assertNoSentinel(report, 'analysis report');
});

test('DOCUMENTED: a partial raw tail is held in memory state (not safe storage output)', () => {
  const st = state('verify-escalations-v1', 'esc');
  const partial = enc.encode(`{"sid":"s1","ts":"2026-09-01T00:00:00Z","rc":1,"detail":"${SECRET}`);
  const res = collect(st, [partial]);
  assert.equal(res.coverage, 'partial');
  assert.deepEqual(res.reasons, ['pending-tail']);
  assert.ok(res.state.tail instanceof Uint8Array);
  assert.ok(Buffer.from(res.state.tail).toString().includes(SECRET),
    'state.tail holds raw bytes transiently: a future adapter MUST NOT persist CollectorStateV1.tail');
  assertNoSentinel(res.records, 'records'); assertNoSentinel(res.counters, 'counters'); assertNoSentinel(res.reasons, 'reasons');
  // Completing the line drops the raw tail from state.
  const done = collect(res.state, [enc.encode('"}\n')]);
  assert.equal(done.state.tail, null);
  assertNoSentinel(done, 'completed');
});

test('collector config: closed, positive bounded integers, ceilings, line≤window', () => {
  assert.deepEqual(C.validateCollectorConfigV1(undefined).value, { ...C.DEFAULT_COLLECTOR_CONFIG });
  refused(C.validateCollectorConfigV1({ ...C.DEFAULT_COLLECTOR_CONFIG, extra: 1 }), 'unknown-field');
  refused(C.validateCollectorConfigV1({ ...C.DEFAULT_COLLECTOR_CONFIG, schemaVersion: 2 }), 'unknown-version');
  refused(C.validateCollectorConfigV1({ ...C.DEFAULT_COLLECTOR_CONFIG, maxLineBytes: 0 }), 'invalid-value');
  refused(C.validateCollectorConfigV1({ ...C.DEFAULT_COLLECTOR_CONFIG, dedupCapacity: 100_001 }), 'invalid-value');
  refused(C.validateCollectorConfigV1({ ...C.DEFAULT_COLLECTOR_CONFIG, maxWindowBytes: 100, maxLineBytes: 200 }), 'invalid-value');
  refused(C.validateCollectorConfigV1({ ...C.DEFAULT_COLLECTOR_CONFIG, futureSkewMs: Infinity }), 'invalid-value');
  assert.throws(() => { C.DEFAULT_COLLECTOR_CONFIG.maxLineBytes = 1; }, TypeError);
  assert.throws(() => { C.DEFAULT_EFFICIENCY_CONFIG.minSamples = 1; }, TypeError);
});

test('analysis request: closed at every level, grant required, bounded window, prior invariants', () => {
  assert.equal(E.analyzeEfficiency(request()).ok, true);
  refused(E.analyzeEfficiency({ ...request(), extra: SECRET }), 'unknown-field');
  refused(E.analyzeEfficiency({ ...request(), schemaVersion: 2 }), 'unknown-version');
  refused(E.analyzeEfficiency(request({ grant: { mode: 'subjects', taskIds: [], sids: [], releaseIds: [] } })), 'grant-invalid');
  refused(E.analyzeEfficiency(request({ grant: { mode: 'admin', taskIds: [], sids: [], releaseIds: [] } })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ grant: { mode: 'subjects', taskIds: ['T1', 'T1'], sids: [], releaseIds: [] } })), 'duplicate-id');
  refused(E.analyzeEfficiency(request({ window: { from: '2026-09-01T00:00:00Z', to: '2026-09-16T00:00:01Z' } })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ window: { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' } })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ config: { ...CFG, maxProposalsPerRule: 4 } })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ config: { ...CFG, minSamples: 0 } })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ config: { ...CFG, errorRepeatThreshold: NaN } })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ records: [{ ...rec(ev(1)), extra: 1 }] })), 'unknown-field');
  refused(E.analyzeEfficiency(request({ records: [{ ...rec(ev(1)), recordId: u(2) }] })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ records: [rec({ ...ev(1), [SECRET]: 1 })] })), 'unknown-field');
  refused(E.analyzeEfficiency(request({ sources: [{ sourceId: 'x', sourceKind: 'advisor-spool-v1', available: false, coverage: 'complete', coveredFrom: null, coveredTo: null }] })), 'invalid-value');
  const p = { semanticKey: 'a'.repeat(64), rule: 'repeated-error-class-v1', scope: 'task', scopeId: 'T1', conditionKey: 'transport',
    decision: 'deferred', evidenceDigest: 'b'.repeat(64), deferredUntil: null };
  refused(E.analyzeEfficiency(request({ priorConditions: [p] })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ priorConditions: [{ ...p, decision: 'rejected', scope: 'system' }] })), 'invalid-value');
  refused(E.analyzeEfficiency(request({ priorConditions: [{ ...p, decision: 'adopted' }] })), 'invalid-value');
});

test('proposal re-check refuses savings, authority, or text tampering', () => {
  const recs = [1, 2, 3].map(n => rec(errEv(n, { taskId: 'T2', sid: 's2' })));
  const report = E.analyzeEfficiency(request({ records: recs }));
  const p = report.value.proposals[0];
  assert.ok(p);
  assert.equal(C.validateEfficiencyProposalV1(p).ok, true);
  for (const tamper of [
    q => { q.measuredSavings = 5; }, q => { q.benefit.estimate = 1; }, q => { q.authority.executionAuthorized = true; },
    q => { q.authority.loopActivationAuthorized = true; }, q => { q.action.changesPermissions = true; },
    q => { q.action.text = 'Auto-apply fix'; }, q => { q.id = 'c'.repeat(64); }, q => { q.evidence.coverage = 'partial'; },
  ]) { const q = structuredClone(p); tamper(q); refused(C.validateEfficiencyProposalV1(q)); }
});

test('collector refuses malformed state/input without echo', () => {
  const st = state();
  refused(K.collectWindow({ ...st, sourceId: SECRET + ' x' }, { generation: 0, cursor: 0, chunks: [], observedAt: at(0), endOfData: true }));
  refused(K.collectWindow(st, { generation: 0, cursor: 0, chunks: ['str'], observedAt: at(0), endOfData: true }));
  refused(K.collectWindow(st, { generation: 0, cursor: -1, chunks: [], observedAt: at(0), endOfData: true }));
  refused(K.collectWindow(st, { generation: 0, cursor: 0, chunks: [], observedAt: '2026-09-01T00:00:00Z', endOfData: true }));
  refused(K.collectWindow(st, { generation: 0, cursor: 0, chunks: [], observedAt: at(0), endOfData: 'yes' }));
  refused(K.collectWindow({ ...st, tail: new Uint8Array(9000), tailStart: 0, cursor: 9000 }, { generation: 0, cursor: 9000, chunks: [], observedAt: at(0), endOfData: true }));
  assert.equal(K.createCollectorState('bad id', 'advisor-spool-v1').ok, false);
  assert.equal(K.createCollectorState('ok', 'other').ok, false);
});
