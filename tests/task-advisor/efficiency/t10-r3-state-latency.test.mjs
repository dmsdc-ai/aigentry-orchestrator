// r3 focused tests (et1185ml-tester): stricter CollectorStateV1 validator + S1 latency p90 + distribution isolation.
// Synthetic fixtures only; imports ONLY the dist/src/task-advisor JS through helpers.mjs. Shape validation, NOT authenticity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K, E, C, ev, errEv, u, at, bytes, enc, rec, request, CFG, SECRET, CODE, assertNoSentinel } from './helpers.mjs';

const BASE_OBS = Date.UTC(2026, 8, 2, 0, 0, 0);
const obsAt = k => new Date(BASE_OBS + k * 1000).toISOString();
const cfgOf = over => ({ ...C.DEFAULT_COLLECTOR_CONFIG, ...over });
const fresh = (kind = 'advisor-spool-v1', id = kind === 'advisor-spool-v1' ? 'spool' : 'esc') => K.createCollectorState(id, kind).value;
const esc = (n, over = {}) => ({ sid: `s${n % 7}`, ts: at(n % 1000), rc: n % 3, ...over });

/** Does collectWindow accept `st` as input? (checkState runs first; the probe input is valid.) */
function accepts(st, cfg) {
  const r = K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks: [], observedAt: obsAt(1e6), endOfData: true }, cfg);
  return r.ok;
}
function refusedState(r, label) {
  assert.equal(r.ok, false, `${label}: must be refused`);
  assert.deepEqual(r.reason, { code: 'invalid-value', path: '$state' }, `${label}: typed fixed refusal`);
  assertNoSentinel(r, label);
}

/** Drives a history; every output state must be accepted (as-is and as a structuredClone) by the next call. */
function chain(kind, cfg) {
  let st = fresh(kind), clock = 0;
  const log = [];
  const step = (label, chunks, over = {}) => {
    const before = structuredClone(st);
    const r = K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks, observedAt: obsAt(++clock), endOfData: true, ...over }, cfg);
    assert.equal(r.ok, true, `${label}: window must run on the previous generated state (${r.ok ? '' : JSON.stringify(r.reason)})`);
    assert.deepEqual(st, before, `${label}: input state unmutated`);
    st = r.value.state;
    assert.ok(accepts(st, cfg), `${label}: generated state must remain usable`);
    assert.ok(accepts(structuredClone(st), cfg), `${label}: structuredClone copy must remain usable`);
    log.push(`${label}:${r.value.coverage}`);
    return r.value;
  };
  return { step, get st() { return st; }, set st(v) { st = v; }, get clock() { return clock; }, log };
}

// ------------------------------------------------------------------ generated histories stay usable
test('R3-S2 spool history: replay, conflict, eviction, tail, oversize skip, rollback+recovery, gaps (drop), caps — every output re-accepted', t => {
  const cfg = cfgOf({ dedupCapacity: 4, maxGapsRetained: 3, maxLineBytes: 512, maxChunkBytes: 1024, maxWindowBytes: 2048, maxWindowRecords: 5 });
  const h = chain('advisor-spool-v1', cfg);
  let v = h.step('normal', [bytes(ev(1), ev(2), ev(3))]);
  assert.equal(v.records.length, 3);
  v = h.step('replay', [bytes(ev(1), ev(2))]); assert.equal(v.counters.duplicates, 2);
  v = h.step('conflict', [bytes(ev(1, { sid: 's9' }), ev(1, { sid: 's8' }))]); assert.equal(v.counters.conflicts, 2);
  v = h.step('eviction', [bytes(ev(4), ev(5), ev(6))]); assert.ok(h.st.totals.dedupEvictions >= 2);
  v = h.step('conflict-after-eviction', [bytes(ev(6, { sid: 's7' }))]);
  const partial = bytes(ev(7));
  v = h.step('partial-tail', [partial.subarray(0, 40)]); assert.equal(v.pendingTailBytes, 40);
  v = h.step('tail-complete', [partial.subarray(40)]); assert.equal(v.records.length, 1);
  v = h.step('empty/malformed/unknown/CRLF/future', [new Uint8Array(0), enc.encode('\n  \n{bad\n' + JSON.stringify({ ...ev(8), zz: 1 }) + '\r\n'),
    bytes(ev(9, { at: '2027-01-01T00:00:00.000Z' }), JSON.stringify(ev(10)) + '\r\n')]);
  const big = enc.encode('{"x":"' + 'y'.repeat(900) + '"}\n');
  v = h.step('oversize-part1(tail)', [big.subarray(0, 300)]); assert.equal(h.st.skipping, false); assert.ok(h.st.tail !== null);
  v = h.step('oversize-part2(skip)', [big.subarray(300, 700)]); assert.equal(h.st.skipping, true); assert.equal(h.st.tail, null);
  v = h.step('oversize-part3(resume)', [big.subarray(700), bytes(ev(11))]); assert.equal(h.st.skipping, false); assert.equal(v.records.length, 1);
  v = h.step('rollback', [bytes(ev(12))], { observedAt: obsAt(0) }); assert.deepEqual(v.reasons, ['clock-rollback']);
  v = h.step('recovery', [bytes(ev(12))]); assert.equal(v.records.length, 1);
  v = h.step('record-cap', [bytes(ev(13), ev(14), ev(15), ev(16), ev(17), ev(18), ev(19))]); assert.ok(v.reasons.includes('cap-stop'));
  v = h.step('record-cap-resume', [bytes(ev(18), ev(19))]);
  const many = bytes(ev(20), ev(21), ev(22), ev(23), ev(24));
  v = h.step('chunk-byte-cap', [many]); assert.ok(v.consumedBytes <= 1024 && v.reasons.includes('cap-stop'));
  v = h.step('chunk-byte-cap-resume', [many.subarray(v.consumedBytes)]);
  v = h.step('tail-before-gap', [bytes(ev(25)).subarray(0, 30)]);
  v = h.step('gap-generation', [bytes(ev(26))], { generation: 1, cursor: 0 }); assert.equal(v.counters.tailDiscardedBytes, 30);
  v = h.step('gap-cursor-skip', [bytes(ev(27))], { cursor: h.st.cursor + 100 });
  v = h.step('gap-cursor-reset', [bytes(ev(28))], { cursor: 0 });
  v = h.step('gap-generation-2(drop)', [], { generation: 7, cursor: 50 });
  v = h.step('gap-generation-3(drop)', [bytes(ev(29))], { generation: 2, cursor: 0 });
  assert.equal(h.st.gaps.length, 3); assert.ok(h.st.totals.gapsDropped >= 2);
  v = h.step('rollback-after-gaps', [], { observedAt: obsAt(1) });
  v = h.step('recovery-after-gaps', [bytes(ev(30))]);
  t.diagnostic(`spool history: ${h.log.join(' ')}`);
  t.diagnostic(`final: ids=${h.st.eventIds.length} conflicted=${h.st.conflictedIds.length} gaps=${h.st.gaps.length} totals.gaps=${h.st.totals.gaps} dropped=${h.st.totals.gapsDropped} evictions=${h.st.totals.dedupEvictions}`);
});

test('R3-S2 escalation history: possible duplicates, recent eviction, tail, gaps, rollback — every output re-accepted', t => {
  const cfg = cfgOf({ recentEscalationCapacity: 2, maxGapsRetained: 2 });
  const h = chain('verify-escalations-v1', cfg);
  let v = h.step('normal', [bytes(esc(1), esc(2), { ...esc(3), detail: SECRET })]);
  v = h.step('possible-duplicate', [bytes(esc(3))]); assert.equal(v.counters.possibleDuplicates, 1);
  v = h.step('evicted-then-reseen', [bytes(esc(1))]); assert.equal(v.counters.possibleDuplicates, 0);
  v = h.step('invalid', [bytes({ sid: 'x' }, { ...esc(4), extra: 1 }), enc.encode('nope\n')]);
  const p = bytes(esc(5));
  v = h.step('tail', [p.subarray(0, 10)]); v = h.step('tail-complete', [p.subarray(10)]);
  v = h.step('rollback', [bytes(esc(6))], { observedAt: obsAt(0) });
  v = h.step('gap1', [bytes(esc(6))], { generation: 3, cursor: 5 });
  v = h.step('gap2', [], { cursor: 0 });
  v = h.step('gap3(drop)', [bytes(esc(7))], { generation: 4, cursor: 0 });
  assert.equal(h.st.eventIds.length, 0); assert.equal(h.st.conflictedIds.length, 0);
  t.diagnostic(`escalation history: ${h.log.join(' ')}`);
});

test('R3-S2 seeded random walk (both kinds, tiny caps): every generated state is re-accepted (measured, not assumed)', t => {
  let seed = 0x1185;
  const rnd = n => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) % n; };
  const cfg = cfgOf({ dedupCapacity: 3, recentEscalationCapacity: 3, maxGapsRetained: 2, maxLineBytes: 400, maxChunkBytes: 700, maxWindowBytes: 1400, maxWindowRecords: 4 });
  let windows = 0;
  const ops = {};
  for (const kind of ['advisor-spool-v1', 'verify-escalations-v1']) {
    const h = chain(kind, cfg);
    let carry = null;
    for (let i = 0; i < 400; i++) {
      const line = n => kind === 'advisor-spool-v1' ? (rnd(4) === 0 ? ev(n, { sid: `x${rnd(3)}` }) : ev(n)) : esc(n);
      const op = rnd(9);
      const name = ['lines', 'lines', 'replay', 'partial', 'oversize', 'rollback', 'gen-gap', 'cursor-gap', 'junk'][op];
      ops[name] = (ops[name] ?? 0) + 1;
      const payload = () => bytes(...Array.from({ length: 1 + rnd(6) }, () => line(1 + rnd(12))));
      if (op <= 2) h.step(`${i}:${name}`, carry ? [carry, payload()] : [payload()]);
      else if (op === 3) { const b = payload(); const cut = 1 + rnd(b.byteLength - 1); h.step(`${i}:${name}`, [b.subarray(0, cut)]); carry = b.subarray(cut); continue; }
      else if (op === 4) h.step(`${i}:${name}`, [enc.encode('z'.repeat(300 + rnd(400)))]);
      else if (op === 5) h.step(`${i}:${name}`, [payload()], { observedAt: obsAt(Math.max(0, h.clock - 5)) });
      else if (op === 6) h.step(`${i}:${name}`, [payload()], { generation: rnd(5), cursor: rnd(50) });
      else if (op === 7) h.step(`${i}:${name}`, [payload()], { cursor: rnd(2) ? h.st.cursor + 1 + rnd(20) : Math.max(0, h.st.cursor - 1 - rnd(20)) });
      else h.step(`${i}:${name}`, [enc.encode('\n\n{"a":[1,{"b":2}]}\nnot json\n')]);
      carry = null;
      windows++;
    }
    t.diagnostic(`${kind}: totals=${JSON.stringify(h.st.totals)}`);
  }
  t.diagnostic(`random walk: windows=${windows} ops=${JSON.stringify(ops)}`);
  assert.ok(windows >= 700);
});

test('R3-S2 exact cap boundaries: line bytes, window records/bytes, dedup/recent/gap capacity at and past the cap stay usable', t => {
  const L = JSON.stringify(ev(1)).length;
  for (const [label, maxLineBytes, oversize] of [['line==cap', L, 0], ['line==cap+1', L - 1, 1]]) {
    const cfg = cfgOf({ maxLineBytes });
    const h = chain('advisor-spool-v1', cfg);
    const v = h.step(label, [bytes(ev(1))]);
    assert.equal(v.counters.oversizeLines, oversize, label);
    const tailOnly = bytes(ev(2)).subarray(0, L); // exactly L bytes retained as tail when allowed
    h.step(`${label}-tail`, [tailOnly]);
    h.step(`${label}-tail-done`, [enc.encode('\n')]);
  }
  const two = bytes(ev(1), ev(2));
  for (const [label, maxWindowBytes, stop] of [['bytes==window', two.byteLength, false], ['bytes==window+1', two.byteLength - 1, true]]) {
    const h = chain('advisor-spool-v1', cfgOf({ maxWindowBytes, maxChunkBytes: maxWindowBytes, maxLineBytes: Math.min(8192, maxWindowBytes) }));
    const v = h.step(label, [two]);
    assert.equal(v.reasons.includes('cap-stop'), stop, label);
  }
  for (const [label, maxWindowRecords, stop] of [['records==cap', 2, false], ['records==cap+1', 1, true]]) {
    const h = chain('advisor-spool-v1', cfgOf({ maxWindowRecords }));
    assert.equal(h.step(label, [two]).reasons.includes('cap-stop'), stop, label);
  }
  { // dedupCapacity full, then one past (eviction); conflicted set past cap
    const h = chain('advisor-spool-v1', cfgOf({ dedupCapacity: 2 }));
    h.step('dedup==cap', [bytes(ev(1), ev(2))]); assert.equal(h.st.totals.dedupEvictions, 0);
    h.step('dedup>cap', [bytes(ev(3))]); assert.equal(h.st.totals.dedupEvictions, 1);
    h.step('conflicts>cap', [bytes(ev(2, { sid: 'c1' }), ev(3, { sid: 'c1' }), ev(4), ev(4, { sid: 'c2' }))]);
    assert.equal(h.st.conflictedIds.length, 2);
  }
  { // recentEscalationCapacity full, then past
    const h = chain('verify-escalations-v1', cfgOf({ recentEscalationCapacity: 2 }));
    h.step('recent==cap', [bytes(esc(1), esc(2))]); h.step('recent>cap', [bytes(esc(3), esc(4))]);
    assert.equal(h.st.recentEscalations.length, 2);
  }
  { // maxGapsRetained = 1 exactly full, then drops
    const h = chain('advisor-spool-v1', cfgOf({ maxGapsRetained: 1 }));
    h.step('gap==cap', [], { generation: 1, cursor: 0 }); h.step('gap>cap', [bytes(ev(1))], { generation: 2, cursor: 3 });
    h.step('gap>cap-2', [], { cursor: 0 });
    assert.deepEqual([h.st.gaps.length, h.st.totals.gaps, h.st.totals.gapsDropped], [1, 3, 2]);
  }
  t.diagnostic(`event line bytes L=${L}`);
});

// ------------------------------------------------------------------ malformed states: typed refusal, no echo, no throw
function richSpool() {
  const cfg = cfgOf({ dedupCapacity: 3, maxGapsRetained: 3 });
  const h = chain('advisor-spool-v1', cfg);
  h.step('a', [bytes(ev(1), ev(2), ev(1, { sid: 'zz' }))]);
  h.step('g1', [bytes(ev(3), ev(4))], { generation: 1, cursor: 0 });
  h.step('g2', [bytes(ev(5))], { cursor: 900 });
  h.step('tail', [bytes(ev(6)).subarray(0, 20)]);
  return { s: h.st, cfg };
}
function richEsc() {
  const cfg = cfgOf({ recentEscalationCapacity: 3, maxGapsRetained: 3 });
  const h = chain('verify-escalations-v1', cfg);
  h.step('a', [bytes(esc(1), esc(2))]);
  h.step('g1', [bytes(esc(3))], { generation: 2, cursor: 0 });
  return { s: h.st, cfg };
}

test('R3-S2 malformed tuples/IDs/digests/gaps/counters/sparse/unknown keys → typed $state refusal, no echo, no throw', t => {
  const { s, cfg } = richSpool();
  const { s: es, cfg: ecfg } = richEsc();
  assert.ok(s.eventIds.length >= 2 && s.conflictedIds.length >= 1 && s.gaps.length === 2 && s.tail !== null, 'rich spool fixture');
  assert.ok(es.recentEscalations.length >= 2 && es.gaps.length === 1, 'rich escalation fixture');
  assert.ok(accepts(s, cfg) && accepts(es, ecfg), 'positive controls accepted');
  const nullProto = Object.assign(Object.create(null), s);
  assert.ok(accepts(nullProto, cfg), 'null-prototype plain copy accepted');
  // r4-final ruling (et1185ml-v3): signed epoch contract — a negative watermark is a valid accepted control, not malformed
  assert.ok(accepts({ ...s, watermarkMs: -1 }, cfg), 'watermark -1 accepted (signed epoch)');
  // case controls: the same replacement in lowercase is accepted, so the uppercase refusals below are about case only
  assert.ok(accepts({ ...s, eventIds: [[s.eventIds[0][0].slice(0, -3) + 'abc', s.eventIds[0][1]]] }, cfg), 'lowercase id control');
  assert.ok(accepts({ ...s, conflictedIds: [s.conflictedIds[0].slice(0, -3) + 'abc'] }, cfg), 'lowercase conflicted control');

  const [id0, dg0] = s.eventIds[0];
  const sparse = n => { const a = new Array(n); return a; };
  const totals = over => ({ ...s, totals: { ...s.totals, ...over } });
  const gap = (i, over) => ({ ...s, gaps: s.gaps.map((g, j) => (j === i ? { ...g, ...over } : g)) });
  class Foreign {}
  const M = {
    // top-level shape
    'null': null, 'undefined': undefined, 'string': SECRET, 'number': 42, 'array': [s], 'class instance': Object.assign(new Foreign(), s),
    'unknown key': { ...s, [SECRET]: CODE }, 'own __proto__ key': Object.defineProperty({ ...s }, '__proto__', { value: {}, enumerable: true }),
    'missing key': (() => { const c = { ...s }; delete c.totals; return c; })(), 'schemaVersion 2': { ...s, schemaVersion: 2 },
    'sourceId invalid': { ...s, sourceId: `bad ${SECRET}` }, 'sourceKind unknown': { ...s, sourceKind: SECRET },
    'generation -1': { ...s, generation: -1 }, 'generation 1.5': { ...s, generation: 1.5 }, 'generation "1"': { ...s, generation: '1' },
    'cursor NaN': { ...s, cursor: NaN }, 'cursor Infinity': { ...s, cursor: Infinity }, 'skipping "no"': { ...s, skipping: 'no' },
    'skipping with tail': { ...s, skipping: true }, 'watermark null with ids': { ...s, watermarkMs: null },
    'lastObserved string': { ...s, lastObservedMs: SECRET },
    // tail
    'tail array': { ...s, tail: [...s.tail] }, 'tail empty': { ...s, tail: new Uint8Array(0), tailStart: s.cursor },
    'tail length mismatch': { ...s, tail: s.tail.subarray(1) }, 'tail w/o tailStart': { ...s, tailStart: null },
    'tailStart w/o tail': { ...s, tail: null }, 'tail > maxLineBytes': { ...s, tail: new Uint8Array(cfg.maxLineBytes + 1), tailStart: s.cursor - cfg.maxLineBytes - 1 },
    // totals
    'totals unknown key': totals({ [SECRET]: 0 }), 'totals missing key': (() => { const c = { ...s.totals }; delete c.late; return { ...s, totals: c }; })(),
    'totals negative': totals({ late: -1 }), 'totals float': totals({ late: 0.5 }), 'totals string': totals({ late: SECRET }),
    'totals unsafe': totals({ late: Number.MAX_SAFE_INTEGER + 2 }), 'totals array': { ...s, totals: Object.values(s.totals) },
    'records > lines': totals({ recordsEmitted: s.totals.linesSeen + 1 }), 'gap count mismatch': totals({ gaps: s.totals.gaps + 1 }),
    'conflicted > conflicts': totals({ conflicts: 0 }), 'retained > emitted': totals({ recordsEmitted: s.eventIds.length }),
    // eventIds
    'eventIds object': { ...s, eventIds: { 0: s.eventIds[0], length: 1 } }, 'eventIds sparse': { ...s, eventIds: sparse(1) },
    'eventIds [5]': { ...s, eventIds: [5] }, 'eventIds [null]': { ...s, eventIds: [null] }, 'eventIds ["str"]': { ...s, eventIds: [SECRET] },
    'tuple len 1': { ...s, eventIds: [[id0]] }, 'tuple len 3': { ...s, eventIds: [[id0, dg0, SECRET]] },
    'tuple array-like': { ...s, eventIds: [{ 0: id0, 1: dg0, length: 2 }] }, 'tuple sparse': { ...s, eventIds: [Object.assign(sparse(2), { 0: id0 })] },
    'id uppercase': { ...s, eventIds: [[id0.slice(0, -3) + 'ABC', dg0]] }, 'id not v4': { ...s, eventIds: [[id0.replace('-4000-', '-1000-'), dg0]] },
    'id secret': { ...s, eventIds: [[SECRET, dg0]] }, 'digest 63': { ...s, eventIds: [[id0, dg0.slice(1)]] },
    'digest upper': { ...s, eventIds: [[id0, dg0.toUpperCase()]] }, 'digest secret': { ...s, eventIds: [[id0, SECRET]] },
    'duplicate id': { ...s, eventIds: [[id0, dg0], [id0, 'f'.repeat(64)]] },
    'eventIds over cap': { ...s, eventIds: [1, 2, 3, 4].map(n => [u(9000 + n), dg0]), totals: { ...s.totals, recordsEmitted: s.totals.recordsEmitted + 9, linesSeen: s.totals.linesSeen + 9 } },
    // conflictedIds / recentEscalations
    'conflicted [{}]': { ...s, conflictedIds: [{}] }, 'conflicted upper': { ...s, conflictedIds: [s.conflictedIds[0].slice(0, -3) + 'ABC'] },
    'conflicted dup': { ...s, conflictedIds: [s.conflictedIds[0], s.conflictedIds[0]], totals: { ...s.totals, conflicts: 9, recordsEmitted: s.totals.recordsEmitted + 9, linesSeen: s.totals.linesSeen + 9 } },
    'conflicted sparse': { ...s, conflictedIds: sparse(1) }, 'spool recentEscalations nonempty': { ...s, recentEscalations: [dg0] },
    // gaps
    'gaps [{evil}]': { ...s, gaps: [{ evil: SECRET }] }, 'gap unknown key': gap(0, { [SECRET]: 1 }),
    'gap missing key': { ...s, gaps: s.gaps.map(({ observedAt, ...rest }) => rest) }, 'gap sourceId other': gap(0, { sourceId: 'other' }),
    'gap reason wrong': gap(0, { reason: 'cursor-reset' }), 'gap reason secret': gap(1, { reason: SECRET }),
    'gap observedAt no ms': gap(0, { observedAt: '2026-09-02T00:00:01Z' }), 'gap observedAt future': gap(1, { observedAt: obsAt(9e5) }),
    'gap chain break': gap(1, { previousGeneration: 5 }), 'gap order reversed': { ...s, gaps: [...s.gaps].reverse() },
    'gap negative cursor': gap(0, { cursor: -1 }), 'first gap prevGen≠0': gap(0, { previousGeneration: 3, reason: 'generation-change' }),
    'last gap gen≠state gen': { ...s, generation: 9 }, 'gaps sparse': { ...s, gaps: sparse(1), totals: { ...s.totals, gaps: 1 } },
    'gaps over cap': { ...s, gaps: [...s.gaps, ...s.gaps, ...s.gaps].slice(0, 4) },
    // cursor / freshness
    'cursor < last gap cursor': { ...s, cursor: s.gaps[1].cursor - 1, tail: null, tailStart: null },
    'fresh but counters': { ...fresh(), totals: { ...fresh().totals, linesSeen: 1 } }, 'fresh but cursor': { ...fresh(), cursor: 5 },
    'no gaps cursor≠bytes': { ...fresh(), lastObservedMs: BASE_OBS, cursor: 3 },
  };
  const EM = {
    'esc eventIds nonempty': { ...es, eventIds: [[id0, dg0]], watermarkMs: es.watermarkMs },
    'esc conflicted nonempty': { ...es, conflictedIds: [id0] }, 'esc recent [1]': { ...es, recentEscalations: [1] },
    'esc recent bad digest': { ...es, recentEscalations: [SECRET] }, 'esc recent dup': { ...es, recentEscalations: [es.recentEscalations[0], es.recentEscalations[0]] },
    'esc recent over cap': { ...es, recentEscalations: ['a', 'b', 'c', 'd'].map(c => c.repeat(64)), totals: { ...es.totals, recordsEmitted: 99, linesSeen: 99 } },
    'esc recent sparse': { ...es, recentEscalations: sparse(1) },
  };
  let n = 0;
  for (const [set, map, st0, c] of [['spool', M, s, cfg], ['esc', EM, es, ecfg]]) {
    for (const [label, bad] of Object.entries(map)) {
      let r;
      assert.doesNotThrow(() => { r = K.collectWindow(bad, { generation: st0.generation, cursor: st0.cursor, chunks: [bytes(set === 'spool' ? ev(77) : esc(77))], observedAt: obsAt(1e6), endOfData: true }, c); }, label);
      refusedState(r, `${set}/${label}`);
      n++;
    }
  }
  t.diagnostic(`malformed cases refused: ${n}`);
});

// ------------------------------------------------------------------ strict: data-reachable pre-1970 clocks (RED if the validator rejects its own output)
test('R3-S2 STRICT pre-1970 producer/collector clocks accepted by validators must not brick the returned state', t => {
  const findings = {};
  const next = (st) => { const r = K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks: [bytes(ev(2))], observedAt: obsAt(5), endOfData: true }); return r.ok ? 'accepted' : `refused:${r.reason.path}`; };
  const a = K.collectWindow(fresh(), { generation: 0, cursor: 0, chunks: [bytes(ev(1, { at: '1969-12-31T23:59:59.000Z' }))], observedAt: obsAt(1), endOfData: true });
  assert.equal(a.ok, true); assert.equal(a.value.records.length, 1, 'event with pre-1970 `at` is accepted and emitted');
  findings.spoolEvent1969 = { watermarkMs: a.value.state.watermarkMs, next: next(a.value.state) };
  const e = K.collectWindow(fresh('verify-escalations-v1'), { generation: 0, cursor: 0, chunks: [bytes(esc(1, { ts: '1969-06-01T00:00:00Z' }))], observedAt: obsAt(1), endOfData: true });
  assert.equal(e.ok, true); assert.equal(e.value.records.length, 1);
  const en = K.collectWindow(e.value.state, { generation: 0, cursor: e.value.state.cursor, chunks: [], observedAt: obsAt(5), endOfData: true });
  findings.escalationTs1969 = { watermarkMs: e.value.state.watermarkMs, next: en.ok ? 'accepted' : `refused:${en.reason.path}` };
  const o = K.collectWindow(fresh(), { generation: 0, cursor: 0, chunks: [], observedAt: '1969-12-31T00:00:00.000Z', endOfData: true });
  assert.equal(o.ok, true, 'pre-1970 observedAt is accepted as input');
  findings.observedAt1969 = { lastObservedMs: o.value.state.lastObservedMs, next: next(o.value.state) };
  t.diagnostic(`pre-1970: ${JSON.stringify(findings)}`);
  const bricked = Object.entries(findings).filter(([, f]) => f.next !== 'accepted').map(([k]) => k);
  assert.deepEqual(bricked, [], `validator refuses its own output state after: ${bricked.join(',')}`);
});

// ------------------------------------------------------------------ boundary facts at the 2^53 clamp (measured; fact oracle = safe typed failure)
// r4 ORACLE DELTA (controller ruling; see r4/ORACLE-CHANGES-r4.md). v1 BOUNDARY-FACT is preserved unchanged in output/tests.
test('R3-S2 BOUNDARY (r4 oracle) counter saturation: same-config outputs strictly re-accepted with loss kept; unsafe cursor refused unconsumed', t => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const seed = K.collectWindow(fresh(), { generation: 1, cursor: 0, chunks: [bytes(ev(1))], observedAt: obsAt(1), endOfData: true }).value.state;
  const sat = { ...seed, totals: { ...seed.totals, linesSeen: MAX, recordsEmitted: MAX, bytesConsumed: MAX, gaps: MAX, gapsDropped: MAX - 1, dedupEvictions: MAX - 1 } };
  assert.ok(accepts(sat), 'a state at the clamp is structurally valid');
  const facts = {};
  const probe = (label, st, input, cfg) => {
    let r, r2;
    assert.doesNotThrow(() => { r = K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks: [], observedAt: obsAt(2), endOfData: true, ...input }, cfg); });
    assert.equal(r.ok, true, `${label}: window runs`);
    assert.doesNotThrow(() => { r2 = K.collectWindow(r.value.state, { generation: r.value.state.generation, cursor: r.value.state.cursor, chunks: [], observedAt: obsAt(3), endOfData: true }, cfg); });
    assert.equal(r2.ok, true, `${label}: same-config generated state must be re-accepted (${r2.ok ? '' : JSON.stringify(r2.reason)})`);
    assert.notEqual(r2.value.coverage, 'complete', `${label}: saturated loss never regains complete`);
    for (const key of Object.keys(st.totals)) assert.ok(r2.value.state.totals[key] >= st.totals[key], `${label}: totals.${key} not reset`);
    facts[label] = `next accepted/${r2.value.coverage}/${r2.value.reasons.join('+')}`;
    return r2.value;
  };
  const e = probe('evictions saturate (records clamp)', sat, { chunks: [bytes(ev(2), ev(3))] }, cfgOf({ dedupCapacity: 1 }));
  assert.equal(e.state.totals.dedupEvictions, MAX); assert.ok(e.reasons.includes('dedup-horizon'), 'dedup-horizon loss retained');
  const g = probe('gaps saturate (gapsDropped clamp)', sat, { generation: 2, cursor: 0 }, cfgOf({ maxGapsRetained: 1 }));
  assert.deepEqual([g.state.totals.gaps, g.state.totals.gapsDropped], [MAX, MAX]);
  // third probe (v1 recorded old unsafe acceptance as FACT) → maintained oracle: typed input-limit BEFORE consumption, no mutation
  const f = fresh(), before = structuredClone(f);
  let c;
  assert.doesNotThrow(() => { c = K.collectWindow(f, { generation: 0, cursor: MAX - 5, chunks: [bytes(ev(1))], observedAt: obsAt(2), endOfData: true }); });
  assert.deepEqual(c, { ok: false, reason: { code: 'input-limit', path: '$input.cursor' } });
  assert.deepEqual(f, before, 'state unmutated');
  facts['caller cursor near 2^53'] = `refused:${c.reason.code}:${c.reason.path}`;
  t.diagnostic(`saturation facts: ${JSON.stringify(facts)}`);
  const perWindow = C.DEFAULT_COLLECTOR_CONFIG.maxWindowBytes;
  t.diagnostic(`reachability (arithmetic): bytesConsumed clamp needs ${MAX} bytes = ${(MAX / 2 ** 50).toFixed(1)} PiB = ${Math.ceil(MAX / perWindow)} full default windows; linesSeen clamp needs ${MAX} lines; the cursor case needs a caller-supplied cursor within one window of 2^53`);
});

test('R3-S2 FACT cross-config: a state generated under larger caps is refused under smaller caps (typed, no throw)', t => {
  const st = K.collectWindow(fresh(), { generation: 0, cursor: 0, chunks: [bytes(ev(1), ev(2), ev(3)), bytes(ev(4)).subarray(0, 100)], observedAt: obsAt(1), endOfData: true }).value.state;
  const res = {};
  for (const [label, over] of [['dedupCapacity 2', { dedupCapacity: 2 }], ['maxLineBytes 50', { maxLineBytes: 50 }], ['same defaults', {}]]) {
    const r = K.collectWindow(st, { generation: 0, cursor: st.cursor, chunks: [], observedAt: obsAt(2), endOfData: true }, cfgOf(over));
    if (!r.ok) refusedState(r, label);
    res[label] = r.ok ? 'accepted' : 'refused';
  }
  assert.equal(res['same defaults'], 'accepted');
  t.diagnostic(`cross-config: ${JSON.stringify(res)}`);
});

// ------------------------------------------------------------------ S1 latency p90 for all three kinds + distribution isolation
const G1 = { mode: 'subjects', taskIds: ['T1'], sids: [], releaseIds: [] };
function bindings(n) { // binding i: start→ack (i+1) min, ack→check 2(i+1) min, ack→report 3(i+1) min
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = { taskId: 'T1', sid: 's1', attempt: `a${i}`, operation: 'op', dispatchId: `d${i}` }, t0 = 60 * i, d = i + 1;
    out.push(rec(ev(5000 + 10 * i + 1, { ...b, kind: 'dispatch.start', at: at(t0) })),
      rec(ev(5000 + 10 * i + 2, { ...b, kind: 'dispatch.ack', outcome: 'verified', role: null, at: at(t0 + d) })),
      rec(ev(5000 + 10 * i + 3, { ...b, kind: 'dispatch.started_check', outcome: 'verified', role: null, at: at(t0 + 3 * d) })),
      rec(ev(5000 + 10 * i + 4, { ...b, kind: 'inject.report', producer: 'inject-handler', role: null, at: at(t0 + 4 * d) })));
  }
  return out;
}
test('R3-S1 all three latency kinds: observed = distribution.p90 (ms), samples separate, p90 ≠ sample count ≠ max', t => {
  const r = E.analyzeEfficiency(request({ grant: G1, records: bindings(11) }));
  assert.equal(r.ok, true);
  const expect = { 'handoff-latency-start-ack': 1, 'handoff-latency-ack-started-check': 2, 'report-latency-ack-report': 3 };
  for (const [name, k] of Object.entries(expect)) {
    const m = r.value.metrics.find(x => x.metric === name && x.scope === 'task' && x.scopeId === 'T1');
    assert.ok(m, name);
    assert.equal(m.unit, 'ms'); assert.equal(m.samples, 11); assert.equal(m.status, 'observed');
    assert.deepEqual(m.distribution, { p50: 6 * k * 60_000, p90: 10 * k * 60_000, max: 11 * k * 60_000 }, name);
    assert.equal(m.observed, m.distribution.p90, `${name}: observed is p90`);
    assert.notEqual(m.observed, m.samples); assert.notEqual(m.observed, m.distribution.max);
    t.diagnostic(`${name}: observed=${m.observed} samples=${m.samples} dist=${JSON.stringify(m.distribution)}`);
  }
  // null when unknown: no bindings → observed null, insufficient-data, distribution null
  const none = E.analyzeEfficiency(request({ grant: G1, records: [rec(errEv(1, { taskId: 'T1' }))] })).value;
  for (const name of Object.keys(expect)) {
    const m = none.metrics.find(x => x.metric === name && x.scopeId === 'T1');
    assert.deepEqual([m.observed, m.status, m.samples, m.distribution], [null, 'insufficient-data', 0, null], name);
  }
  // proposal evidence uses the same statistic
  for (const p of r.value.proposals.filter(x => x.rule === 'handoff-latency-v1')) {
    assert.equal(p.evidence.observed, p.evidence.distribution.p90); assert.equal(p.evidence.samples, 11);
  }
});

test('R3-S1 metric and proposal distributions are independent objects (mutation isolation, both directions)', t => {
  for (const grant of [G1, { mode: 'whole-workspace-diagnostic', taskIds: ['T1'], sids: [], releaseIds: [] }]) {
    const r = E.analyzeEfficiency(request({ grant, records: bindings(11) })).value;
    const props = r.proposals.filter(p => p.rule === 'handoff-latency-v1');
    assert.ok(props.length >= 2, `latency proposals fire (${grant.mode})`);
    const dists = [...r.metrics.map(m => m.distribution).filter(d => d !== null), ...props.map(p => p.evidence.distribution)];
    assert.equal(new Set(dists).size, dists.length, 'every distribution object is distinct');
    const snap = structuredClone(r);
    for (const p of props) {
      const m = r.metrics.find(x => x.scope === p.subjects.scope && x.scopeId === p.subjects.scopeId && x.metric === p.conditionKey);
      assert.notEqual(m.distribution, p.evidence.distribution);
      m.distribution.p90 = -1; m.distribution.injected = SECRET;
      assert.deepEqual(p.evidence.distribution, snap.proposals.find(x => x.id === p.id).evidence.distribution, 'metric mutation does not leak into proposal');
      p.evidence.distribution.max = -2;
      const mSnap = snap.metrics.find(x => x.scope === m.scope && x.scopeId === m.scopeId && x.metric === m.metric);
      assert.equal(m.distribution.max, mSnap.distribution.max, 'proposal mutation does not leak into metric');
    }
    const again = E.analyzeEfficiency(request({ grant, records: bindings(11) })).value;
    assert.deepEqual(again, snap, 'a later run is unaffected by mutating a previous result');
    t.diagnostic(`${grant.mode}: distributions=${dists.length} latencyProposals=${props.length}`);
  }
});
