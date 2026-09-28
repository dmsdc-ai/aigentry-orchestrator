// r2: resolve r1 source suspicions (outside the approved R1–R4 fix scope; strict oracles, reported separately).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K, E, ev, at, rec, request, state, bytes, OBS } from './helpers.mjs';

test('S1 latency metric "observed" with unit ms must be a duration (ms), not the sample count', () => {
  const G = { mode: 'subjects', taskIds: ['T1'], sids: [], releaseIds: [] };
  const b = (n, kind, m) => rec(ev(n, { kind, at: at(m), taskId: 'T1', sid: 's1', attempt: 'a', operation: 'o', dispatchId: 'd', outcome: kind === 'dispatch.ack' ? 'verified' : null }));
  const r = E.analyzeEfficiency(request({ grant: G, records: [b(1, 'dispatch.start', 0), b(2, 'dispatch.ack', 7)] })).value;
  const m = r.metrics.find(x => x.metric === 'handoff-latency-start-ack');
  assert.equal(m.unit, 'ms'); assert.equal(m.samples, 1); assert.equal(m.distribution.max, 420_000);
  assert.notEqual(m.observed, m.samples, `observed=${m.observed} unit=${m.unit} equals the sample count, not a ms value`);
});

test('S2a collectWindow returns a refusal (never throws) for malformed caller-supplied state map entries', () => {
  for (const eventIds of [[5], [null], ['str']]) {
    let r;
    assert.doesNotThrow(() => { r = K.collectWindow({ ...state(), eventIds }, { generation: 0, cursor: 0, chunks: [bytes(ev(1))], observedAt: OBS, endOfData: true }); },
      `eventIds=${JSON.stringify(eventIds)}`);
    assert.equal(r.ok, false);
  }
});

test('S2b malformed/untyped state entries are refused, not carried into the next state', () => {
  const bad = { eventIds: [['not-a-uuid', 'not-a-digest']], conflictedIds: [{}], recentEscalations: [1], gaps: [{ evil: 'x' }] };
  const accepted = [];
  for (const [k, v] of Object.entries(bad)) {
    const r = K.collectWindow({ ...state(), [k]: v }, { generation: 0, cursor: 0, chunks: [], observedAt: OBS, endOfData: true });
    if (r.ok) accepted.push(k);
  }
  assert.deepEqual(accepted, [], `accepted malformed: ${accepted.join(',')}`);
});
