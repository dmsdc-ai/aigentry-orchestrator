// r2 focused retest of R1–R4 fixes (et1185ma-v2). Synthetic fixtures, fixed clocks, dist/src/task-advisor JS only (via helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K, E, ev, errEv, at, u, bytes, state, collect, ccfg, rec, request, metricsOf, src, SOURCES, CFG, OBS } from './helpers.mjs';

const WS2 = { mode: 'whole-workspace-diagnostic', taskIds: ['T1', 'T2'], sids: [], releaseIds: [] };
const onlyT1 = { mode: 'subjects', taskIds: ['T1'], sids: [], releaseIds: [] };
const e = (task, n, o = {}) => errEv(n, { taskId: task, sid: task === 'T1' ? 's1' : 's2', ...o });
const okEv = (task, n, o = {}) => ev(n, { taskId: task, sid: task === 'T1' ? 's1' : 's2', ...o });
const obs = k => at(1440, k * 1000);
const KEY = (rule, scope, id, cond) => E.semanticKeyV1('OWNER', 'R1171', rule, scope, id, cond);
const prior = (rule, scope, scopeId, conditionKey) => ({ semanticKey: KEY(rule, scope, scopeId, conditionKey), rule, scope, scopeId, conditionKey,
  decision: 'rejected', evidenceDigest: 'a'.repeat(64), deferredUntil: null });
const run = o => { const r = E.analyzeEfficiency(request(o)); assert.equal(r.ok, true); return r.value; };

// ---------------------------------------------------------------- R1
test('R1 control: no eviction → complete', () => {
  const w = collect(state(), [bytes(ev(1), ev(2))], {}, ccfg({ dedupCapacity: 2 }));
  assert.equal(w.coverage, 'complete'); assert.deepEqual(w.reasons, []);
});

test('R1 eviction degrades the current window AND every later window, including after generation change', () => {
  const cfg = ccfg({ dedupCapacity: 1 });
  const w1 = collect(state(), [bytes(e('T2', 1), e('T2', 2))], {}, cfg);
  assert.equal(w1.coverage, 'partial'); assert.ok(w1.reasons.includes('dedup-horizon'));
  let st = w1.state; const later = [];
  // later windows: empty, replay, conflict, brand new, then a generation change and one more same-generation window
  const replay = collect(st, [bytes(e('T2', 1))], { observedAt: obs(1) }, cfg); later.push(['replay', replay]); st = replay.state;
  const conflict = collect(st, [bytes({ ...e('T2', 2), pid: 999 })], { observedAt: obs(2) }, cfg); later.push(['conflict-after-eviction', conflict]); st = conflict.state;
  const empty = collect(st, [], { observedAt: obs(3) }, cfg); later.push(['empty', empty]); st = empty.state;
  const fresh = collect(st, [bytes(ev(50))], { observedAt: obs(4) }, cfg); later.push(['fresh', fresh]); st = fresh.state;
  const gen = collect(st, [bytes(ev(51))], { observedAt: obs(5), generation: 1, cursor: 0 }, cfg); later.push(['generation-change', gen]); st = gen.state;
  const after = collect(st, [bytes(ev(52))], { observedAt: obs(6) }, cfg); later.push(['after-generation', after]);
  for (const [name, w] of later) {
    assert.notEqual(w.coverage, 'complete', name);
    assert.ok(w.reasons.includes('dedup-horizon'), name);
  }
  assert.equal(gen.coverage, 'gap');
  assert.equal(after.coverage, 'partial');
  // facts: replay/conflict still undetectable by the collector, but no longer silently complete
  assert.equal(replay.records.length, 1); assert.equal(conflict.records[0].type, 'event');
});

test('R1 clock rollback after horizon loss is backlog, never complete', () => {
  const cfg = ccfg({ dedupCapacity: 1 });
  const w1 = collect(state(), [bytes(ev(1), ev(2))], { observedAt: obs(10) }, cfg);
  const rb = collect(w1.state, [bytes(ev(3))], { observedAt: obs(9) }, cfg);
  assert.equal(rb.coverage, 'backlog'); assert.deepEqual(rb.reasons, ['clock-rollback']);
});

test('R1 LIMITATION (documented, not solved): horizon loss makes the state permanently partial', t => {
  const cfg = ccfg({ dedupCapacity: 1 });
  let st = collect(state(), [bytes(ev(1), ev(2))], {}, cfg).state;
  const covs = [];
  for (let k = 1; k <= 10; k++) { const w = collect(st, [], { observedAt: obs(k) }, cfg); covs.push(w.coverage); st = w.state; }
  t.diagnostic(`10 idle windows after eviction: ${[...new Set(covs)]} (no in-state recovery; production adapter/recovery decision open)`);
  assert.ok(covs.every(c => c === 'partial'));
  assert.equal(collect(state(), [], {}, cfg).coverage, 'complete', 'only a fresh state (caller decision) returns to complete');
});

test('R1 partial propagates into analysis: no proposals, priors insufficient-data (caller maps collector coverage)', () => {
  const cfg = ccfg({ dedupCapacity: 1 });
  const w = collect(state(), [bytes(...[1, 2, 3, 4, 5].map(n => e('T2', n)))], {}, cfg);
  assert.equal(w.coverage, 'partial');
  const sources = [src('spool', 'advisor-spool-v1', { coverage: w.coverage }), SOURCES[1]];
  const p = prior('repeated-error-class-v1', 'task', 'T2', 'transport');
  const r = run({ grant: WS2, sources, records: w.records, priorConditions: [p] });
  assert.equal(r.coverage.bySource[0].coverage, 'partial');
  assert.equal(r.proposals.length, 0);
  assert.equal(r.outcomes[0].status, 'insufficient-data');
  assert.equal(metricsOf(r, { scope: 'task', scopeId: 'T2', conditionKey: 'transport' })[0].observed, 5, 'metric still observed, just not claimable');
});

// ---------------------------------------------------------------- R2
test('R2 own late event → local partial with late-excluded; counter stays null in the task view', () => {
  const recs = [rec(e('T1', 1)), rec(e('T1', 2)), rec(e('T1', 3), { late: true })];
  const r = run({ grant: onlyT1, records: recs });
  assert.equal(r.coverage.bySource[0].coverage, 'partial');
  assert.ok(r.coverage.reasons.includes('late-excluded'));
  assert.equal(r.counts.lateExcluded, null);
  assert.equal(r.proposals.length, 0);
});

test('R2 another task\'s late event alone neither reveals its data nor changes the T1 view', () => {
  const t1 = [rec(e('T1', 1)), rec(e('T1', 2)), rec(e('T1', 3))];
  const alone = run({ grant: onlyT1, records: t1 });
  const withOtherLate = run({ grant: onlyT1, records: [...t1, rec(e('T2', 9, { producerVersion: '7.7.7-other' }), { late: true })] });
  assert.deepEqual(withOtherLate, alone);
  assert.equal(alone.coverage.overall, 'complete');
  assert.ok(!JSON.stringify(withOtherLate).includes('T2') && !JSON.stringify(withOtherLate).includes('7.7.7'));
});

test('R2 whole-workspace late counts are exact and honest', () => {
  const recs = [rec(e('T1', 1)), rec(e('T1', 2), { late: true }), rec(e('T2', 3), { late: true }), rec(e('T2', 4)),
    rec(errEv(5, { taskId: null, sid: null }), { late: true })];
  const r = run({ grant: WS2, records: recs });
  assert.equal(r.counts.lateExcluded, 3);
  assert.ok(r.coverage.reasons.includes('late-excluded'));
  assert.equal(r.coverage.bySource[0].coverage, 'partial');
  assert.equal(r.metrics.find(m => m.scope === 'system' && m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1').observed, 2);
  const open = run({ grant: WS2, records: recs, now: '2026-09-01T12:00:00Z' });
  assert.equal(open.counts.lateExcluded, 0, 'fact: open window keeps late records (no exclusion)');
});

test('R2 late-caused undercount cannot resolve a prior', () => {
  const recs = [rec(e('T2', 1)), rec(okEv('T2', 2)), rec(okEv('T2', 3)), rec(okEv('T2', 4)), rec(e('T2', 5), { late: true })];
  const r = run({ grant: WS2, records: recs, priorConditions: [prior('repeated-error-class-v1', 'task', 'T2', 'transport')] });
  assert.equal(r.outcomes[0].status, 'insufficient-data');
});

// ---------------------------------------------------------------- R3
const latBind = (task, i, gapMin, o = {}) => {
  const base = { taskId: task, sid: 's1', attempt: `a${i}`, operation: 'op', dispatchId: `d${i}` };
  return [rec(ev(1000 + 100 * i + 1, { ...base, at: at(10 * i) , ...o })), rec(ev(1000 + 100 * i + 2, { ...base, kind: 'dispatch.ack', outcome: 'verified', role: null, at: at(10 * i + gapMin) }))];
};
test('R3 insufficient-data for: no data, low samples, each disabled threshold, unbound, ambiguous, report-latency, owner task', () => {
  const errP = prior('repeated-error-class-v1', 'task', 'T1', 'transport');
  const rndP = prior('repeated-rounds-v1', 'task', 'T1', 'rounds/coder');
  const latP = prior('handoff-latency-v1', 'task', 'T1', 'handoff-latency-start-ack');
  const bound3 = [0, 1, 2].flatMap(i => latBind('T1', i, 0)); // 0-ms intervals, 3 exact samples, below threshold
  const cases = {
    'no data': run({ grant: onlyT1, records: [], priorConditions: [errP, rndP, latP] }),
    'low samples (2 < 3)': run({ grant: onlyT1, records: [rec(okEv('T1', 1)), rec(okEv('T1', 2))], priorConditions: [errP, rndP, latP] }),
    'error threshold null': run({ grant: onlyT1, records: [1, 2, 3, 4].map(n => rec(okEv('T1', n))), priorConditions: [errP], config: { ...CFG, errorRepeatThreshold: null } }),
    'rounds threshold null': run({ grant: onlyT1, records: [1, 2, 3, 4].map(n => rec(okEv('T1', n))), priorConditions: [rndP], config: { ...CFG, roundsThreshold: null } }),
    'latency threshold null': run({ grant: onlyT1, records: bound3, priorConditions: [latP], config: { ...CFG, handoffLatencyThresholdMs: null } }),
    'unbound timing present': run({ grant: onlyT1, records: [...bound3, rec(okEv('T1', 900))], priorConditions: [latP] }),
    'ambiguous timing present': run({ grant: onlyT1, records: [...bound3, ...latBind('T1', 7, 1).map((r, j) => j ? { ...r, event: { ...r.event, dispatchId: 'dX' } } : r)], priorConditions: [latP] }),
    'report-latency key': run({ grant: onlyT1, records: bound3, priorConditions: [prior('handoff-latency-v1', 'task', 'T1', 'report-latency-ack-report')] }),
    'owner task': run({ grant: { mode: 'subjects', taskIds: ['OWNER'], sids: [], releaseIds: [] }, records: [1, 2, 3, 4].map(n => rec(okEv('OWNER', n))),
      priorConditions: [prior('repeated-error-class-v1', 'task', 'OWNER', 'transport')] }),
  };
  const statuses = Object.fromEntries(Object.entries(cases).map(([k, r]) => [k, r.outcomes.map(o => o.status)]));
  for (const [k, list] of Object.entries(statuses)) {
    assert.ok(list.length > 0, k);
    assert.ok(list.every(s => s === 'insufficient-data'), `${k}: ${JSON.stringify(list)}`);
  }
  assert.equal(cases['ambiguous timing present'].counts.ambiguousBindings, 1);
});

test('R3 genuinely sufficient clearance stays condition-resolved, adoption unknown, association only (each rule)', () => {
  const errP = prior('repeated-error-class-v1', 'task', 'T1', 'transport');
  const rndP = prior('repeated-rounds-v1', 'task', 'T1', 'rounds/coder');
  const latP = prior('handoff-latency-v1', 'task', 'T1', 'handoff-latency-start-ack');
  const recs = [rec(e('T1', 1)), ...[2, 3, 4].map(n => rec(okEv('T1', n, { role: `r${n}` })))];
  const a = run({ grant: onlyT1, records: recs, priorConditions: [errP, rndP] });
  for (const o of a.outcomes) assert.deepEqual({ ...o, semanticKey: 'x' }, { semanticKey: 'x', rule: o.rule, status: 'condition-resolved', adoption: 'unknown', associationOnly: true });
  const bound3 = [0, 1, 2].flatMap(i => latBind('T1', i, 0));
  const b = run({ grant: onlyT1, records: bound3, priorConditions: [latP] });
  assert.equal(b.outcomes[0].status, 'condition-resolved');
  const present = run({ grant: onlyT1, records: [0, 1, 2].flatMap(i => latBind('T1', i, 5)), priorConditions: [latP] });
  assert.equal(present.outcomes[0].status, 'condition-present');
});

// ---------------------------------------------------------------- R4
function sortedElementsFor(N) {
  const recs = [];
  for (let i = 0; i < N; i++) recs.push(rec(ev(i + 1, { at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), taskId: 'T2', sid: 's2',
    role: `r${i.toString(36)}`, producerVersion: `v${i}` })));
  const orig = Array.prototype.sort; let sorted = 0;
  Array.prototype.sort = function (...a) { sorted += this.length; return orig.apply(this, a); };
  let r;
  try { r = E.analyzeEfficiency(request({ grant: WS2, records: recs, config: { ...CFG, maxRecords: 20_000, maxOperations: 50_000_000 } })); }
  finally { Array.prototype.sort = orig; }
  assert.equal(r.ok, true);
  return { sorted, operations: r.value.counts.operations, metrics: r.value.metrics.length };
}
test('R4 growth is non-quadratic across two doublings; operation accounting recorded (not a CPU guarantee)', t => {
  const a = sortedElementsFor(500), b = sortedElementsFor(1000), c = sortedElementsFor(2000);
  t.diagnostic(`sortedElements N=500:${a.sorted} N=1000:${b.sorted} N=2000:${c.sorted}; ops ${a.operations}/${b.operations}/${c.operations}; ratios ${(b.sorted / a.sorted).toFixed(2)} ${(c.sorted / b.sorted).toFixed(2)}`);
  assert.ok(b.sorted / a.sorted < 3); assert.ok(c.sorted / b.sorted < 3);
  assert.ok(b.operations / a.operations < 3 && c.operations / b.operations < 3);
});

function budgetFixture() {
  const recs = [...[1, 2, 3, 4].map(n => rec(e('T2', n))), ...[5, 6, 7].map(n => rec(okEv('T2', n))), ...[0, 1, 2].flatMap(i => latBind('T1', i, 5))];
  return { grant: WS2, records: recs, priorConditions: [prior('repeated-error-class-v1', 'task', 'T2', 'transport'), prior('handoff-latency-v1', 'task', 'T1', 'handoff-latency-start-ack'),
    { ...prior('repeated-error-class-v1', 'system', null, 'transport'), semanticKey: KEY('repeated-error-class-v1', 'system', null, 'transport') }] };
}
test('R4 budget exhaustion at EVERY limit below need discards metrics/proposals/suppressions and yields insufficient outcomes', () => {
  const full = run(budgetFixture());
  const need = full.counts.operations;
  assert.ok(full.proposals.length > 0 && full.metrics.length > 0 && !full.coverage.reasons.includes('operation-budget'));
  const exact = run({ ...budgetFixture(), config: { ...CFG, maxOperations: need } });
  assert.deepEqual(exact, full, 'exact budget = no exhaustion');
  let lateHits = 0;
  for (let max = 1; max < need; max++) {
    const input = budgetFixture();
    const r = run({ ...input, config: { ...CFG, maxOperations: max } });
    assert.ok(r.coverage.reasons.includes('operation-budget'), `max=${max}`);
    assert.equal(r.coverage.overall, 'partial');
    assert.deepEqual(r.metrics, []); assert.deepEqual(r.proposals, []); assert.deepEqual(r.suppressed, []);
    assert.equal(r.outcomes.length, 3);
    assert.ok(r.outcomes.every(o => o.status === 'insufficient-data' && o.adoption === 'unknown'), `max=${max}`);
    assert.ok(r.counts.operations <= max);
    assert.deepEqual(run({ ...budgetFixture(), config: { ...CFG, maxOperations: max } }), r, 'deterministic');
    if (max > need - 20) lateHits++;
  }
  assert.ok(lateHits > 0);
});

test('R4 sourceVersions arrays are not shared across metrics/proposals (mutation isolation)', t => {
  const r = run(budgetFixture());
  const arrays = [...r.metrics.map(m => m.sourceVersions), ...r.proposals.map(p => p.evidence.sourceVersions)];
  assert.equal(new Set(arrays).size, arrays.length, 'every sourceVersions array is a distinct object');
  const snapshot = structuredClone(r);
  r.metrics.find(m => m.sourceVersions.length > 0).sourceVersions.push('MUTATED');
  const others = [...r.metrics.map(m => m.sourceVersions), ...r.proposals.map(p => p.evidence.sourceVersions)].filter(a => a.includes('MUTATED'));
  assert.equal(others.length, 1);
  // Observation (outside the dispatch's sourceVersions oracle): latency distribution objects
  const lat = r.proposals.find(p => p.rule === 'handoff-latency-v1');
  const m = r.metrics.find(x => x.scope === lat.subjects.scope && x.scopeId === lat.subjects.scopeId && x.metric === lat.conditionKey);
  t.diagnostic(`observation: metric.distribution === proposal.evidence.distribution → ${m.distribution === lat.evidence.distribution}`);
  assert.ok(snapshot);
});
