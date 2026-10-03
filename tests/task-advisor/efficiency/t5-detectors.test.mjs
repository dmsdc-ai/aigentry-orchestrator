// 5. Repeated-error, repeated-round, exact handoff detectors: minSamples/thresholds, closed/complete gating, fixed proposal text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, E, ev, errEv, at, rec, request, src, SOURCES, CFG } from './helpers.mjs';

const G = { mode: 'whole-workspace-diagnostic', taskIds: ['T2', 'OWNER'], sids: [], releaseIds: [] };
const err = (n, o = {}) => rec(errEv(n, { taskId: 'T2', sid: 's2', ...o }));
const start = (n, o = {}) => rec(ev(n, { taskId: 'T2', sid: 's2', role: 'coder', ...o }));
const taskProps = (r, rule) => r.proposals.filter(p => p.rule === rule && p.subjects.scope === 'task');

test('repeated-error-class fires at threshold with fixed, non-authoritative review-opportunity text', () => {
  const r = E.analyzeEfficiency(request({ grant: G, records: [err(1), err(2), err(3)] })).value;
  const [p] = taskProps(r, 'repeated-error-class-v1');
  assert.ok(p);
  assert.equal(p.subjects.scopeId, 'T2'); assert.deepEqual(p.subjects.taskIds, ['T2']);
  assert.equal(p.conditionKey, 'transport');
  assert.equal(p.claimClass, 'review-opportunity'); assert.equal(p.confidence, 'low'); assert.equal(p.uncertainty, C.UNCERTAINTY);
  assert.deepEqual(p.action, { id: 'review-error-class-health', text: C.ACTIONS['repeated-error-class-v1'].text, reversible: true, changesPermissions: false });
  assert.equal(p.risk, C.ACTIONS['repeated-error-class-v1'].risk);
  assert.equal(p.measuredSavings, null); assert.deepEqual(p.benefit, { magnitude: 'unknown', estimate: null }); assert.equal(p.analysisCost, 'unknown');
  assert.deepEqual(p.authority, { producerAuth: 'not-established', executionAuthorized: false, dispatchAuthorized: false,
    admissionAuthorized: false, loopActivationAuthorized: false, permissionChange: false });
  assert.deepEqual(p.evidence, { observed: 3, samples: 3, threshold: 3, minSamples: 3, unit: 'count', distribution: null, coverage: 'complete',
    sources: ['advisor-spool-v1'], sourceVersions: ['1.0.0'] });
  assert.equal(p.ownerTaskId, 'OWNER'); assert.equal(p.releaseId, 'R1171'); assert.equal(p.ruleVersion, 1);
  assert.deepEqual(p.evidenceWindow, { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' });
  assert.equal(p.id, C.metadataId(['efficiency-proposal-v1', p.semanticKey, p.evidenceDigest]));
  assert.equal(p.semanticKey, E.semanticKeyV1('OWNER', 'R1171', 'repeated-error-class-v1', 'task', 'T2', 'transport'));
  const texts = JSON.stringify(r.proposals.map(x => [x.action.text, x.risk, x.uncertainty])).toLowerCase();
  for (const claim of ['saves', 'savings of', 'faster', 'best', 'automatically', 'execute', 'grant', 'loop']) assert.ok(!texts.includes(claim), claim);
  assert.equal(r.authority, 'none'); assert.equal(r.provenance, 'not-established');
});

test('threshold and minSamples boundaries', () => {
  const below = E.analyzeEfficiency(request({ grant: G, records: [err(1), err(2), start(3)] })).value;
  assert.equal(taskProps(below, 'repeated-error-class-v1').length, 0);
  const cfg = { ...CFG, minSamples: 4 };
  const few = E.analyzeEfficiency(request({ grant: G, config: cfg, records: [err(1), err(2), err(3)] })).value;
  assert.equal(taskProps(few, 'repeated-error-class-v1').length, 0, 'samples 3 < minSamples 4');
  const enough = E.analyzeEfficiency(request({ grant: G, config: cfg, records: [err(1), err(2), err(3), start(4)] })).value;
  assert.equal(taskProps(enough, 'repeated-error-class-v1').length, 1);
  const off = E.analyzeEfficiency(request({ grant: G, config: { ...CFG, errorRepeatThreshold: null }, records: [err(1), err(2), err(3)] })).value;
  assert.equal(off.proposals.filter(p => p.rule === 'repeated-error-class-v1').length, 0);
});

test('owner task and unattributed bucket are never proposal targets', () => {
  const own = [1, 2, 3].map(n => rec(errEv(n, { taskId: 'OWNER', sid: 'so' })));
  const un = [4, 5, 6].map(n => rec(errEv(n, { taskId: null, sid: null })));
  const r = E.analyzeEfficiency(request({ grant: G, records: [...own, ...un] })).value;
  assert.ok(!r.proposals.some(p => p.subjects.scopeId === 'OWNER'));
  assert.ok(!r.proposals.some(p => p.subjects.scope === 'unattributed'));
});

test('repeated-rounds fires per role with starts ≥ minSamples; independent validation text preserved', () => {
  const recs = [start(1), start(2), rec(ev(3, { taskId: 'T2', sid: 's2', role: 'tester' }))];
  const r = E.analyzeEfficiency(request({ grant: G, records: recs })).value;
  const ps = taskProps(r, 'repeated-rounds-v1');
  assert.deepEqual(ps.map(p => p.conditionKey), ['rounds/coder']);
  assert.equal(ps[0].evidence.observed, 2); assert.equal(ps[0].evidence.samples, 3);
  assert.match(ps[0].action.text, /independent validation stays in place/);
  const r2 = E.analyzeEfficiency(request({ grant: G, records: [start(1), start(2)] })).value;
  assert.equal(taskProps(r2, 'repeated-rounds-v1').length, 0, 'starts 2 < minSamples 3');
  const m = r.metrics.find(x => x.metric === 'dispatch-rounds' && x.conditionKey === 'rounds/coder');
  assert.equal(m.observed, 2); assert.equal(m.basis, 'observed-count');
});

test('handoff latency fires on exact bindings only (p90 > threshold); report latency never proposed', () => {
  const recs = [];
  for (let i = 0; i < 3; i++) {
    const base = { taskId: 'T2', sid: 's2', attempt: `a${i}`, operation: 'op', dispatchId: `d${i}` };
    recs.push(rec(ev(10 * i + 1, { ...base, at: at(10 * i) })));
    recs.push(rec(ev(10 * i + 2, { ...base, kind: 'dispatch.ack', outcome: 'verified', role: null, at: at(10 * i + 2) })));
    recs.push(rec(ev(10 * i + 3, { ...base, kind: 'inject.report', producer: 'inject-handler', role: null, at: at(10 * i + 9) })));
  }
  const r = E.analyzeEfficiency(request({ grant: G, records: recs })).value;
  const ps = taskProps(r, 'handoff-latency-v1');
  assert.deepEqual(ps.map(p => p.conditionKey), ['handoff-latency-start-ack']);
  assert.equal(ps[0].evidence.observed, 120_000); assert.equal(ps[0].evidence.unit, 'ms');
  assert.deepEqual(ps[0].evidence.distribution, { p50: 120_000, p90: 120_000, max: 120_000 });
  assert.ok(!r.proposals.some(p => p.conditionKey === 'report-latency-ack-report'));
  const def = E.analyzeEfficiency(request({ grant: G, records: recs, config: { ...CFG, handoffLatencyThresholdMs: null } })).value;
  assert.equal(def.proposals.filter(p => p.rule === 'handoff-latency-v1').length, 0, 'default null threshold: no invented baseline');
  const m = r.metrics.find(x => x.scope === 'task' && x.metric === 'report-latency-ack-report');
  assert.equal(m.basis, 'work-duration');
});

test('closed+complete only: open window, partial/backlog/gap/unknown sources yield no proposals', () => {
  const recs = [err(1), err(2), err(3)];
  const open = E.analyzeEfficiency(request({ grant: G, records: recs, now: '2026-09-01T12:00:00Z' })).value;
  assert.equal(open.currentness, 'open-window'); assert.ok(open.coverage.reasons.includes('open-window'));
  assert.equal(open.proposals.length, 0);
  assert.ok(open.metrics.every(m => m.currentness === 'open-window'));
  for (const coverage of ['partial', 'backlog', 'gap']) {
    const r = E.analyzeEfficiency(request({ grant: G, records: recs, sources: [src('spool', 'advisor-spool-v1', { coverage }), SOURCES[1]] })).value;
    assert.equal(r.proposals.length, 0, coverage);
    assert.equal(r.metrics.find(m => m.conditionKey === 'transport').coverage, coverage);
    assert.equal(r.metrics.find(m => m.conditionKey === 'transport').observed, 3, 'still reported as observed metric');
  }
  const none = E.analyzeEfficiency(request({ grant: G, records: recs, sources: [SOURCES[1]] })).value;
  assert.equal(none.proposals.length, 0);
  assert.equal(none.metrics.find(m => m.conditionKey === 'transport'), undefined, 'undeclared-source records are not counted');
  const rc = none.metrics.find(m => m.scope === 'task' && m.metric === 'record-count' && m.sources[0] === 'advisor-spool-v1');
  assert.equal(rc.status, 'source-unavailable'); assert.equal(rc.observed, null);
  assert.equal(none.counts.undeclaredSource, 3);
});

test('proposal cap per rule is deterministic and reported; output order-invariant', () => {
  const recs = [];
  for (let t = 0; t < 5; t++) for (let i = 0; i < 3; i++) recs.push(rec(errEv(100 * t + i + 1, { taskId: `X${t}`, sid: `sx${t}` })));
  const grant = { mode: 'subjects', taskIds: ['X0', 'X1', 'X2', 'X3', 'X4'], sids: [], releaseIds: [] };
  const cfg = { ...CFG, maxProposalsPerRule: 2 };
  const a = E.analyzeEfficiency(request({ grant, config: cfg, records: recs })).value;
  const b = E.analyzeEfficiency(request({ grant, config: cfg, records: [...recs].reverse() })).value;
  assert.equal(a.proposals.length, 2); assert.equal(a.counts.proposalsOverflow, 3);
  assert.deepEqual(a, b);
});
