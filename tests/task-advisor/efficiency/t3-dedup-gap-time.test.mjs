// 3. Replay/conflict dedup, eviction horizon, generation/cursor gaps, late/skew/clock rollback loss reporting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K, E, ev, errEv, u, at, bytes, state, collect, ccfg, rec, request, metricsOf, CFG, OBS } from './helpers.mjs';

const G = { mode: 'whole-workspace-diagnostic', taskIds: ['T2'], sids: [], releaseIds: [] };
const e2 = (n, over = {}) => errEv(n, { taskId: 'T2', sid: 's2', ...over });
const next = (st, chunks, over = {}, cfg) => collect(st, chunks, { observedAt: over.observedAt ?? OBS, ...over }, cfg);

test('same UUID + same body replayed → emitted once (within and across windows, case-normalized)', () => {
  const w = collect(state(), [bytes(ev(1), ev(1), { ...ev(1), eventId: u(1).toUpperCase() })]);
  assert.equal(w.records.length, 1);
  assert.equal(w.counters.duplicates, 2);
  assert.equal(w.coverage, 'complete');
  const w2 = next(w.state, [bytes(ev(1))]);
  assert.equal(w2.records.length, 0);
  assert.equal(w2.counters.duplicates, 1);
});

test('same UUID + different body → one conflict marker, first body kept, analyzer excludes the id and degrades', () => {
  const w = collect(state(), [bytes(e2(1), { ...e2(1), pid: 999 }, { ...e2(1), pid: 998 }, e2(2), e2(3))]);
  assert.deepEqual(w.records.map(r => r.type), ['event', 'event-id-conflict', 'event', 'event']);
  assert.equal(w.records[0].event.pid, 100, 'first body is not overwritten');
  assert.equal(w.counters.conflicts, 2);
  assert.equal(w.coverage, 'partial');
  assert.ok(w.reasons.includes('event-id-conflict'));
  const cfg = { ...CFG, errorRepeatThreshold: 2, minSamples: 2 };
  const r = E.analyzeEfficiency(request({ grant: G, records: w.records, config: cfg })).value;
  assert.equal(r.counts.conflictsExcluded, 1);
  assert.equal(metricsOf(r, { scope: 'task', scopeId: 'T2', conditionKey: 'transport' })[0].observed, 2);
  assert.equal(r.coverage.bySource[0].coverage, 'partial');
  assert.equal(r.proposals.length, 0, 'partial source cannot produce proposals');
  // Analyzer alone also detects two different bodies with the same id (no marker supplied).
  const r2 = E.analyzeEfficiency(request({ grant: G, records: [rec(e2(1)), rec({ ...e2(1), pid: 5 })], config: cfg })).value;
  assert.equal(r2.counts.conflictsExcluded, 1, 'second copy is dropped at intake; the retained first copy is excluded');
  assert.equal(metricsOf(r2, { scope: 'task', scopeId: 'T2', conditionKey: 'transport' }).length, 0, 'neither body counted');
  assert.ok(r2.coverage.reasons.includes('event-id-conflict'));
});

test('dedup map is bounded FIFO; eviction counted and reason emitted', () => {
  const cfg = ccfg({ dedupCapacity: 3 });
  const w = collect(state(), [bytes(...[1, 2, 3, 4, 5].map(n => ev(n)))], {}, cfg);
  assert.equal(w.state.eventIds.length, 3);
  assert.deepEqual(w.state.eventIds.map(([id]) => id), [u(3), u(4), u(5)]);
  assert.equal(w.counters.dedupEvictions, 2);
  assert.ok(w.reasons.includes('dedup-horizon'));
});

test('RED-CANDIDATE dedup-horizon: collector coverage must not be "complete" once the dedup horizon is lost', () => {
  // Minimal supported config: dedupCapacity 1. Window 1 evicts E1; window 2 replays E1; window 3 sends E2 with a different body.
  const cfg = ccfg({ dedupCapacity: 1 });
  const w1 = collect(state(), [bytes(e2(1), e2(2))], {}, cfg);
  const w2 = next(w1.state, [bytes(e2(1))], { observedAt: at(1440, 1000) }, cfg);
  const w3 = next(w2.state, [bytes({ ...e2(2), pid: 999 })], { observedAt: at(1440, 2000) }, cfg);
  // facts (always asserted)
  assert.equal(w2.records.length, 1, 'replayed E1 is re-emitted as a fresh record');
  assert.equal(w2.counters.duplicates, 0);
  assert.deepEqual(w3.records.map(r => r.type), ['event'], 'conflicting body after eviction is emitted as a normal event, no conflict marker');
  assert.equal(w3.counters.conflicts, 0);
  for (const w of [w1, w2, w3]) assert.ok(w.reasons.includes('dedup-horizon'));
  // contract oracle: "loss means partial coverage, not exactly-once claim"
  for (const [name, w] of [['w1', w1], ['w2', w2], ['w3', w3]]) assert.notEqual(w.coverage, 'complete', `${name} coverage with dedup-horizon`);
});

test('analyzer composition after dedup eviction: same-batch union dedups replay and catches conflict; delta batch cannot', () => {
  const cfg = ccfg({ dedupCapacity: 1 });
  const w1 = collect(state(), [bytes(e2(1), e2(2))], {}, cfg);
  const w2 = next(w1.state, [bytes(e2(1))], { observedAt: at(1440, 1000) }, cfg);
  const w3 = next(w2.state, [bytes({ ...e2(2), pid: 999 })], { observedAt: at(1440, 2000) }, cfg);
  const cnt = r => metricsOf(r, { scope: 'task', scopeId: 'T2', conditionKey: 'transport' })[0]?.observed ?? null;
  const union = E.analyzeEfficiency(request({ grant: G, records: [...w1.records, ...w2.records] })).value;
  assert.equal(cnt(union), 2, 'union batch: replay not double counted');
  assert.equal(union.coverage.overall, 'complete');
  const withConflict = E.analyzeEfficiency(request({ grant: G, records: [...w1.records, ...w2.records, ...w3.records] })).value;
  assert.equal(withConflict.coverage.bySource[0].coverage, 'partial');
  assert.ok(withConflict.coverage.reasons.includes('event-id-conflict'));
  const delta = E.analyzeEfficiency(request({ grant: G, records: w2.records })).value;
  assert.equal(cnt(delta), 1, 'fact: a delta batch sees the replay as new data; only caller-side coverage mapping can flag it');
});

test('generation change / cursor reset / cursor skip → gap coverage, tail discard counted', () => {
  const partial = bytes(ev(1), ev(2)).subarray(0, bytes(ev(1)).length + 10);
  const w1 = collect(state(), [partial]);
  assert.equal(w1.pendingTailBytes, 10);
  const cases = [
    [{ generation: 1, cursor: 0 }, 'generation-change'],
    [{ generation: 0, cursor: 0 }, 'cursor-reset'],
    [{ generation: 0, cursor: w1.nextCursor + 50 }, 'cursor-skip'],
  ];
  for (const [pos, reason] of cases) {
    const r = next(w1.state, [bytes(ev(3))], pos);
    assert.equal(r.coverage, 'gap', reason);
    assert.equal(r.gaps.length, 1); assert.equal(r.gaps[0].reason, reason);
    assert.equal(r.counters.tailDiscardedBytes, 10);
    assert.ok(r.reasons.includes('gap') && r.reasons.includes('dropped-lines'));
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].lineStart, pos.cursor);
    assert.equal(r.state.generation, pos.generation);
  }
  const noGap = next(w1.state, [bytes(ev(2)).subarray(10)]);
  assert.equal(noGap.gaps.length, 0);
});

test('gap list bounded; dropped gaps counted', () => {
  let st = state();
  const cfg = ccfg({ maxGapsRetained: 2 });
  let dropped = 0;
  for (let g = 1; g <= 5; g++) { const r = next(st, [], { generation: g, cursor: 0 }, cfg); dropped += r.counters.gapsDropped; st = r.state; }
  assert.equal(st.gaps.length, 2);
  assert.deepEqual(st.gaps.map(g => g.generation), [4, 5]);
  assert.equal(dropped, 3);
});

test('clock rollback → backlog, nothing consumed, cursor/tail unchanged', () => {
  const w1 = next(state(), [bytes(ev(1)).subarray(0, 12)], { observedAt: at(1500) });
  const r = next(w1.state, [bytes(ev(1)).subarray(12)], { observedAt: at(1499) });
  assert.equal(r.coverage, 'backlog');
  assert.deepEqual(r.reasons, ['clock-rollback']);
  assert.equal(r.consumedBytes, 0); assert.equal(r.records.length, 0);
  assert.equal(r.nextCursor, w1.nextCursor); assert.equal(r.pendingTailBytes, 12);
  assert.equal(r.state.totals.clockRollback, 1);
  const ok = next(r.state, [bytes(ev(1)).subarray(12)], { observedAt: at(1500) });
  assert.equal(ok.records.length, 1);
});

test('future clock skew beyond tolerance is dropped and reported; within tolerance kept', () => {
  const cfg = ccfg({ futureSkewMs: 60_000 });
  const r = next(state(), [bytes(ev(1, { at: at(0) }), ev(2, { at: at(1, 1) }), ev(3, { at: at(1) }))], { observedAt: at(0) }, cfg);
  assert.equal(r.records.length, 2);
  assert.equal(r.counters.clockSkew, 1);
  assert.equal(r.coverage, 'partial');
  assert.ok(r.reasons.includes('dropped-lines'));
});

test('late records are flagged against the watermark (collector keeps them with late:true)', () => {
  const cfg = ccfg({ lateToleranceMs: 60_000 });
  const r = collect(state(), [bytes(ev(1, { at: at(100) }), ev(2, { at: at(99) }), ev(3, { at: at(98, -1) }))], {}, cfg);
  assert.deepEqual(r.records.map(x => x.late), [false, false, true]);
  assert.equal(r.counters.late, 1);
});

test('RED-CANDIDATE late exclusion: dropping late in-window records from a closed window must be reported as loss', () => {
  const recs = [rec(e2(1)), rec(e2(2)), rec(e2(3), { late: true })];
  const ws = E.analyzeEfficiency(request({ grant: G, records: recs })).value;
  assert.equal(ws.counts.lateExcluded, 1); // fact
  assert.equal(metricsOf(ws, { scope: 'task', scopeId: 'T2', conditionKey: 'transport' })[0].observed, 2); // fact: undercount
  const view = E.analyzeEfficiency(request({ grant: { mode: 'subjects', taskIds: ['T2'], sids: [], releaseIds: [] }, records: recs })).value;
  const signalled = v => v.coverage.overall !== 'complete' || v.coverage.reasons.length > 0;
  assert.ok(signalled(ws), 'workspace view: coverage complete with no reason despite excluded in-window data');
  assert.ok(signalled(view), 'task view: no loss signal at all (lateExcluded is null there)');
});

test('legacy copy-truncate re-presentation → possibleDuplicate, excluded from analyzer counts', () => {
  const line1 = { sid: 's1', ts: '2026-09-01T00:10:00Z', rc: 1 };
  const w1 = collect(state('verify-escalations-v1', 'esc'), [bytes(line1, { ...line1, ts: '2026-09-01T00:10:00.000Z' })]);
  assert.deepEqual(w1.records.map(r => r.possibleDuplicate), [false, true]);
  const w2 = next(w1.state, [bytes(line1)], { generation: 1, cursor: 0 });
  assert.equal(w2.records[0].possibleDuplicate, true);
  assert.equal(w2.coverage, 'gap');
  const r = E.analyzeEfficiency(request({ grant: { mode: 'whole-workspace-diagnostic', taskIds: [], sids: ['s1'], releaseIds: [] }, records: [...w1.records, ...w2.records] })).value;
  assert.equal(r.counts.possibleDuplicatesExcluded, 2);
  assert.equal(metricsOf(r, { scope: 'session', scopeId: 's1', conditionKey: 'verify-escalation' })[0].observed, 1);
});
