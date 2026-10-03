// r4 focused numeric-consistency tests (et1185ml-tester, operation et1185ml-v2). Synthetic fixtures only;
// imports ONLY the dist/src/task-advisor JS through helpers.mjs. Shape/numeric validation, NOT authenticity or migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K, C, ev, bytes, enc, SECRET, assertNoSentinel } from './helpers.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const BASE_OBS = Date.UTC(2026, 8, 2, 0, 0, 0);
const obsAt = k => new Date(BASE_OBS + k * 1000).toISOString();
const cfgOf = over => ({ ...C.DEFAULT_COLLECTOR_CONFIG, ...over });
const fresh = (kind = 'advisor-spool-v1') => K.createCollectorState(kind === 'advisor-spool-v1' ? 'spool' : 'esc', kind).value;
const LIMIT = { ok: false, reason: { code: 'input-limit', path: '$input.cursor' } };
const win = (st, over = {}, cfg) => K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks: [], observedAt: obsAt(1e6), endOfData: true, ...over }, cfg);
const accepts = (st, cfg) => win(st, {}, cfg).ok;
function refusedState(r, label) {
  assert.equal(r.ok, false, `${label}: must be refused`);
  assert.deepEqual(r.reason, { code: 'invalid-value', path: '$state' }, label);
  assertNoSentinel(r, label);
}
/** Unsafe-window refusal: exact typed input-limit, no throw, input state unmutated. */
function limitRefused(st, input, cfg, label) {
  const before = structuredClone(st);
  let r;
  assert.doesNotThrow(() => { r = K.collectWindow(st, input, cfg); }, label);
  assert.deepEqual(r, LIMIT, label);
  assert.deepEqual(st, before, `${label}: state unmutated`);
}
function ok(st, input, cfg, label) {
  const before = structuredClone(st);
  const r = K.collectWindow(st, input, cfg);
  assert.equal(r.ok, true, `${label}: ${r.ok ? '' : JSON.stringify(r.reason)}`);
  assert.deepEqual(st, before, `${label}: input state unmutated`);
  assert.ok(accepts(r.value.state, cfg), `${label}: same-config output re-accepted`);
  assert.ok(accepts(structuredClone(r.value.state), cfg), `${label}: clone re-accepted`);
  return r.value;
}

// ------------------------------------------------------------------ signed epoch domain
test('R4 signed epoch: watermarkMs/lastObservedMs accept zero/negative safe integers; null/NaN/fraction/unsafe/non-number refused', t => {
  const gen = ok(fresh(), { generation: 0, cursor: 0, chunks: [bytes(ev(1))], observedAt: obsAt(1), endOfData: true }, undefined, 'seed').state;
  const good = { zero: 0, minusOne: -1, year0000: Date.parse('0000-01-01T00:00:00.000Z'), minSafe: -MAX, maxSafe: MAX };
  const bad = { NaN: NaN, fraction: 0.5, negFraction: -0.5, unsafePos: MAX + 1, unsafeNeg: -MAX - 1, Infinity: -Infinity, string: '0', secret: SECRET, bigint: 1n };
  const res = {};
  for (const field of ['watermarkMs', 'lastObservedMs']) {
    for (const [label, v] of Object.entries(good)) {
      const r = win({ ...gen, [field]: v });
      assert.equal(r.ok, true, `${field}=${label} accepted`);
    }
    for (const [label, v] of Object.entries(bad)) refusedState(win({ ...gen, [field]: v }), `${field}=${label}`);
    res[field] = `accepted ${Object.keys(good).length}, refused ${Object.keys(bad).length}`;
  }
  refusedState(win({ ...gen, watermarkMs: null }), 'watermark null with retained ids');
  refusedState(win({ ...gen, lastObservedMs: null }), 'lastObservedMs null on a non-fresh state');
  assert.equal(win(fresh()).ok, true, 'fresh null/null accepted');
  t.diagnostic(`signed epoch: ${JSON.stringify(res)}`);
});

test('R4 pre-1970 histories work in the unchanged ISO domain (year 0000..1969, rollback, gaps, crossing 1970); out-of-domain still refused', t => {
  const iso = (y, s = 0) => { const d = new Date(0); d.setUTCFullYear(y, 0, 1); d.setUTCHours(0, 0, s, 0); return d.toISOString(); };
  assert.equal(iso(0), '0000-01-01T00:00:00.000Z');
  const log = [];
  for (const kind of ['advisor-spool-v1', 'verify-escalations-v1']) {
    let st = fresh(kind), k = 0;
    const line = (n, when) => kind === 'advisor-spool-v1' ? ev(n, { at: when }) : { sid: `s${n}`, ts: when, rc: 1 };
    const step = (label, chunks, over = {}) => {
      const v = ok(st, { generation: st.generation, cursor: st.cursor, chunks, endOfData: true, ...over }, undefined, `${kind}/${label}`);
      st = v.state; log.push(`${kind.slice(0, 5)}/${label}:${v.coverage}:${v.records.length}`); return v;
    };
    let v = step('y0000', [bytes(line(1, iso(0)))], { observedAt: iso(0, 10) }); assert.equal(v.records.length, 1);
    assert.ok(st.watermarkMs < 0 && st.lastObservedMs < 0);
    v = step('y0000-late-ok', [bytes(line(2, iso(0, 5)))], { observedAt: iso(0, 20) });
    v = step('rollback-negative', [bytes(line(3, iso(0, 6)))], { observedAt: iso(0, 1) }); assert.deepEqual(v.reasons, ['clock-rollback']);
    v = step('recover', [bytes(line(3, iso(0, 6)))], { observedAt: iso(0, 30) }); assert.equal(v.records.length, 1);
    v = step('gap-in-1969', [bytes(line(4, iso(1969)))], { observedAt: iso(1969), generation: 1, cursor: 0 }); assert.equal(v.coverage, 'gap');
    v = step('1969-last-ms', [bytes(line(5, '1969-12-31T23:59:59.999Z'))], { observedAt: '1969-12-31T23:59:59.999Z' });
    v = step('epoch-zero', [bytes(line(6, '1970-01-01T00:00:00.000Z'))], { observedAt: '1970-01-01T00:00:00.000Z' });
    assert.equal(st.lastObservedMs, 0);
    v = step('cross-to-2026', [bytes(line(7, iso(2026)))], { observedAt: obsAt(1) });
    v = step('rollback-to-1969-refused-as-rollback', [], { observedAt: iso(1969) }); assert.deepEqual(v.reasons, ['clock-rollback']);
  }
  // Out-of-domain spellings keep being refused exactly as before (contracts unchanged).
  const st = fresh();
  for (const at of ['-000001-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '1969-12-31T23:59:59Z', '1969-13-01T00:00:00.000Z']) {
    const v = ok(st, { generation: 0, cursor: 0, chunks: [bytes(ev(9, { at }))], observedAt: obsAt(1), endOfData: true }, undefined, `event at ${at}`);
    assert.equal(v.records.length, 0, at); assert.equal(v.counters.invalidValue, 1, at);
  }
  for (const observedAt of ['-000001-01-01T00:00:00.000Z', '1969-12-31T23:59:59Z', '1969-02-30T00:00:00.000Z']) {
    assert.deepEqual(win(fresh(), { observedAt }), { ok: false, reason: { code: 'invalid-value', path: '$input.observedAt' } }, observedAt);
  }
  t.diagnostic(`pre-1970: ${log.join(' ')}`);
});

// ------------------------------------------------------------------ cursor safe-integer bound
test('R4 cursor: exactly-MAX-reachable passes, +1 refused (input-limit, unmutated); chunk/window caps bound the reach', t => {
  const line = bytes(ev(1)), L = line.byteLength;
  const at = cursor => ({ generation: 0, cursor, chunks: [line], observedAt: obsAt(1), endOfData: true });
  const v = ok(fresh(), at(MAX - L), undefined, 'cursor = MAX - L');
  assert.equal(v.nextCursor, MAX); assert.equal(v.records.length, 1); assert.equal(v.state.cursor, MAX);
  limitRefused(fresh(), at(MAX - L + 1), undefined, 'cursor = MAX - L + 1');
  limitRefused(fresh(), at(MAX), undefined, 'cursor = MAX with data');
  // chunk larger than maxChunkBytes: reach = maxChunkBytes
  const cfg = cfgOf({ maxChunkBytes: 1000, maxWindowBytes: 1000, maxLineBytes: 1000 });
  const big = enc.encode('x'.repeat(5000));
  const input = cursor => ({ generation: 0, cursor, chunks: [big], observedAt: obsAt(1), endOfData: true });
  const c = ok(fresh(), input(MAX - 1000), cfg, 'big chunk at MAX - maxChunkBytes');
  assert.ok(c.nextCursor <= MAX && c.consumedBytes === 1000);
  limitRefused(fresh(), input(MAX - 999), cfg, 'big chunk at MAX - maxChunkBytes + 1');
  // several chunks: reach = min(maxWindowBytes, Σ min(chunk, maxChunkBytes))
  const cfg2 = cfgOf({ maxChunkBytes: 1000, maxWindowBytes: 1500, maxLineBytes: 1000 });
  const parts = cursor => ({ generation: 0, cursor, chunks: [big.subarray(0, 600), big.subarray(0, 600), big.subarray(0, 600)], observedAt: obsAt(1), endOfData: true });
  ok(fresh(), parts(MAX - 1500), cfg2, 'three chunks at MAX - maxWindowBytes');
  limitRefused(fresh(), parts(MAX - 1499), cfg2, 'three chunks at MAX - maxWindowBytes + 1');
  const small = cursor => ({ ...parts(cursor), chunks: [big.subarray(0, 100), big.subarray(0, 200)] });
  ok(fresh(), small(MAX - 300), cfg2, 'Σchunks below window cap: reach = 300');
  limitRefused(fresh(), small(MAX - 299), cfg2, 'Σchunks + 1');
  t.diagnostic(`event line L=${L}`);
});

test('R4 cursor: record-budget early stop is conservative (bound uses reachable bytes, not consumed bytes) — FACT', t => {
  const cfg = cfgOf({ maxWindowRecords: 1 });
  const data = bytes(ev(1), ev(2), ev(3)), R = data.byteLength;
  const input = cursor => ({ generation: 0, cursor, chunks: [data], observedAt: obsAt(1), endOfData: true });
  const v = ok(fresh(), input(MAX - R), cfg, 'early stop at MAX - reachable');
  assert.ok(v.reasons.includes('cap-stop')); assert.ok(v.consumedBytes < R);
  limitRefused(fresh(), input(MAX - R + 1), cfg, 'reachable + 1 refused even though the record cap would stop earlier');
  t.diagnostic(`reachable=${R} consumedAtBound=${v.consumedBytes} nextCursor=MAX-${MAX - v.nextCursor}`);
});

test('R4 cursor: empty chunks / zero bytes at MAX stay usable; any byte past MAX is refused', t => {
  let v = ok(fresh(), { generation: 0, cursor: MAX, chunks: [], observedAt: obsAt(1), endOfData: true }, undefined, 'MAX, no chunks');
  assert.equal(v.state.cursor, MAX); assert.equal(v.coverage, 'gap');
  v = ok(v.state, { generation: 0, cursor: MAX, chunks: [new Uint8Array(0), new Uint8Array(0)], observedAt: obsAt(2), endOfData: true }, undefined, 'MAX, zero-byte chunks');
  assert.equal(v.counters.emptyChunks, 2); assert.equal(v.consumedBytes, 0); assert.equal(v.coverage, 'complete');
  limitRefused(v.state, { generation: 0, cursor: MAX, chunks: [enc.encode('\n')], observedAt: obsAt(3), endOfData: true }, undefined, 'one byte at MAX');
  limitRefused(fresh(), { generation: 3, cursor: MAX, chunks: [enc.encode('x')], observedAt: obsAt(3), endOfData: true }, undefined, 'unsafe gap window records no gap');
});

test('R4 cursor: rollback window with unsafe input is refused by the input contract (not counted as rollback) — FACT', t => {
  const line = bytes(ev(1)), L = line.byteLength;
  const st = ok(fresh(), { generation: 0, cursor: MAX - 2 * L, chunks: [line], observedAt: obsAt(10), endOfData: true }, undefined, 'near MAX').state;
  const rb = { generation: 0, cursor: st.cursor, observedAt: obsAt(5), endOfData: true };
  const safe = ok(st, { ...rb, chunks: [line] }, undefined, 'rollback with reachable ≤ MAX');
  assert.deepEqual(safe.reasons, ['clock-rollback']);
  limitRefused(st, { ...rb, chunks: [line, line] }, undefined, 'rollback with reachable > MAX');
  const empty = ok(st, { ...rb, chunks: [] }, undefined, 'rollback with empty chunks');
  assert.deepEqual(empty.reasons, ['clock-rollback']); assert.equal(empty.state.totals.clockRollback, 1);
});

// ------------------------------------------------------------------ saturated counter relations across windows
test('R4 saturation: successive same-config windows on clamped counters stay accepted, monotone, never regain complete', t => {
  const seed = ok(fresh(), { generation: 1, cursor: 0, chunks: [bytes(ev(1))], observedAt: obsAt(1), endOfData: true }, undefined, 'seed').state;
  const cfg = cfgOf({ dedupCapacity: 1, maxGapsRetained: 1 });
  let st = { ...seed, totals: { ...seed.totals, linesSeen: MAX - 3, recordsEmitted: MAX - 3, bytesConsumed: MAX - 1, gaps: MAX - 2, gapsDropped: MAX - 3, dedupEvictions: MAX - 4, conflicts: MAX - 1 } };
  assert.ok(accepts(st, cfg), 'near-clamp state accepted');
  const coverages = [];
  let n = 10;
  for (let i = 0; i < 40; i++) {
    const prev = st;
    const kind = i % 4;
    const input = { generation: st.generation, cursor: st.cursor, chunks: [], observedAt: obsAt(10 + i), endOfData: true };
    if (kind === 0) input.chunks = [bytes(ev(++n), ev(++n))];
    else if (kind === 1) { input.generation = st.generation + 1; input.cursor = 0; input.chunks = [bytes(ev(++n))]; }
    else if (kind === 2) input.chunks = [bytes(ev(n, { sid: `c${i}` }))];
    else input.observedAt = obsAt(0);
    const v = ok(st, input, cfg, `window ${i}`);
    st = v.state;
    coverages.push(v.coverage);
    assert.notEqual(v.coverage, 'complete', `window ${i}: saturated loss never regains complete`);
    assert.ok(v.reasons.includes('dedup-horizon') || v.reasons.includes('clock-rollback'), `window ${i}: loss reason kept`);
    for (const key of Object.keys(prev.totals)) assert.ok(st.totals[key] >= prev.totals[key], `window ${i}: totals.${key} monotone`);
  }
  for (const key of ['linesSeen', 'recordsEmitted', 'gaps', 'gapsDropped', 'dedupEvictions', 'conflicts']) assert.equal(st.totals[key], MAX, `${key} saturated`);
  t.diagnostic(`coverages: ${[...new Set(coverages)].join(',')} final gaps=${st.gaps.length}`);
  // relations still bind: unsaturated exact, saturated lower bound
  const base = { ...seed };
  refusedState(win({ ...base, totals: { ...base.totals, recordsEmitted: 1, dedupEvictions: 1 } }), 'unsaturated records < ids + evictions');
  refusedState(win({ ...base, totals: { ...base.totals, gaps: MAX, gapsDropped: MAX - 2 } }), 'saturated gaps > dropped + retained');
  assert.equal(win({ ...base, totals: { ...base.totals, gaps: MAX, gapsDropped: MAX - 1 } }).ok, true, 'saturated gaps = dropped + retained');
  refusedState(win({ ...base, totals: { ...base.totals, gaps: MAX - 1, gapsDropped: MAX - 1 } }), 'unsaturated gaps exact');
  assert.equal(win({ ...base, totals: { ...base.totals, linesSeen: MAX, recordsEmitted: MAX, dedupEvictions: MAX } }).ok, true, 'saturated records: lower bound only');
  refusedState(win({ ...base, totals: { ...base.totals, recordsEmitted: MAX, linesSeen: MAX - 1 } }), 'records > lines still refused');
});

// ------------------------------------------------------------------ cross-config: documented refusal, no automatic reset/migration
test('R4 FACT cross-config: smaller caps refuse the old state; supplying a new generation alone does not repair it', t => {
  const st = ok(fresh(), { generation: 0, cursor: 0, chunks: [bytes(ev(1), ev(2), ev(3))], observedAt: obsAt(1), endOfData: true }, undefined, 'default-config state').state;
  const small = cfgOf({ dedupCapacity: 2 });
  refusedState(win(st, {}, small), 'same generation, smaller cap');
  refusedState(win(st, { generation: 1, cursor: 0 }, small), 'new generation, smaller cap');
  assert.equal(win(st).ok, true, 'same config re-accepts');
  // The only way through under the smaller cap is a caller-created fresh state (history reset by the caller, not migration).
  const reset = win(fresh(), { generation: 1, cursor: 0, chunks: [bytes(ev(1))] }, small);
  assert.equal(reset.ok, true);
  assert.equal(reset.value.state.totals.dedupEvictions, 0, 'fresh state carries none of the old loss history');
  t.diagnostic('doc phrase "choose a new generation/checkpoint migration": new generation input alone → still $state refused; no migration exists in this module');
});
