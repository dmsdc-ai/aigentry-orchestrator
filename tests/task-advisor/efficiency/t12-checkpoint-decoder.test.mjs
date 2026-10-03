// 12. C0-f stateless checkpoint decoder (decodeWindowV1): checkpoint resume/re-read, caps, oversize skip progress,
// EOF tail, malformed input, invalid checkpoint/config, watermark, replay, source shapes, no raw bytes out, legacy parity.
// Synthetic data only; imports the real tsc output via helpers.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, K, SECRET, ev, at, bytes, enc, state, collect, ccfg, OBS, assertNoSentinel } from './helpers.mjs';

const ESC = (rc, detail = 'ok', sid = 's1') => ({ sid, ts: '2026-09-01T00:00:00Z', rc, detail });
const COUNTER_KEYS = ['bytesConsumed', 'capStops', 'clockSkew', 'emptyChunks', 'emptyLines', 'invalidValue', 'late', 'linesSeen',
  'malformed', 'oversizeLines', 'recordsEmitted', 'unknownField', 'unknownVersion'];

function input(over = {}) {
  return { sourceId: 'spool', sourceKind: 'advisor-spool-v1', generation: 0, startCursor: 0, skippingOversize: false,
    watermarkMs: null, chunks: [], endOfData: true, observedAt: OBS, ...over };
}
const escInput = (over = {}) => input({ sourceId: 'esc', sourceKind: 'verify-escalations-v1', ...over });
function dec(over = {}) {
  const r = K.decodeWindowV1(input(over));
  assert.equal(r.ok, true, JSON.stringify(r.ok ? '' : r.reason));
  return r.value;
}
const decEsc = (over = {}) => dec({ sourceId: 'esc', sourceKind: 'verify-escalations-v1', ...over });
function refusedAt(value, code, path) {
  let r;
  assert.doesNotThrow(() => { r = K.decodeWindowV1(value); });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reason, { code, path });
}
/** Chain windows from a checkpoint until `full` is consumed. With `chunking` = the rest of the data, every
 * window must make progress; a caller-chosen short window may legitimately end inside its first line. */
function drain(full, over = {}, chunking = cursor => [full.subarray(cursor)], requireProgress = true) {
  let cp = { startCursor: 0, skippingOversize: false, watermarkMs: null };
  const got = []; const windows = []; let guard = 0;
  while (cp.startCursor < full.length) {
    assert.ok(guard++ < 10_000, 'bounded number of windows');
    const r = dec({ ...over, ...cp, chunks: chunking(cp.startCursor) });
    if (requireProgress) assert.ok(r.lineBoundaryCursor > cp.startCursor, `progress from ${cp.startCursor}`);
    else assert.ok(r.lineBoundaryCursor >= cp.startCursor);
    assert.equal(r.counters.bytesConsumed, r.lineBoundaryCursor - cp.startCursor);
    got.push(...r.records); windows.push(r);
    cp = { startCursor: r.lineBoundaryCursor, skippingOversize: r.skippingOversize, watermarkMs: r.watermarkMs };
  }
  return { got, windows, cp };
}
function walkNoBytes(value, path = '$') {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) assert.fail(`raw bytes at ${path}`);
  if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkNoBytes(v, `${path}.${k}`);
}

test('public result shape: exact keys, window-only counters without dedup/gap/tail fields', () => {
  const r = dec({ chunks: [bytes(ev(1))] });
  assert.deepEqual(Object.keys(r).sort(), ['counters', 'coverage', 'lineBoundaryCursor', 'pendingTailBytes', 'reasons', 'records',
    'skippingOversize', 'watermarkMs']);
  assert.deepEqual(Object.keys(r.counters).sort(), COUNTER_KEYS);
  assert.equal(r.coverage, 'complete');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.lineBoundaryCursor, bytes(ev(1)).length);
});

test('empty input: no chunks and only empty chunks keep the checkpoint and are complete', () => {
  const none = dec({ startCursor: 40 });
  assert.deepEqual([none.lineBoundaryCursor, none.pendingTailBytes, none.records.length, none.coverage], [40, 0, 0, 'complete']);
  const empties = dec({ startCursor: 7, chunks: [new Uint8Array(0), new Uint8Array(0)], watermarkMs: 123 });
  assert.equal(empties.counters.emptyChunks, 2);
  assert.equal(empties.lineBoundaryCursor, 7);
  assert.equal(empties.watermarkMs, 123, 'watermark passes through unchanged when nothing is decoded');
  const skip = dec({ startCursor: 9, skippingOversize: true });
  assert.equal(skip.skippingOversize, true, 'skip mode survives an empty window');
  assert.deepEqual(skip.reasons, ['pending-tail']);
  const notEnd = dec({ endOfData: false });
  assert.equal(notEnd.coverage, 'backlog'); assert.deepEqual(notEnd.reasons, ['not-end-of-data']);
});

test('checkpoint resume re-reads a partial UTF-8 line at every split offset', () => {
  const full = bytes(ESC(1, '한글🙂é'), ESC(2, '🙂🙂'), ESC(3, 'é'));
  const ref = decEsc({ chunks: [full] });
  assert.equal(ref.records.length, 3);
  for (let i = 0; i <= full.length; i++) {
    const w1 = decEsc({ chunks: [full.subarray(0, i)] });
    assert.ok(w1.lineBoundaryCursor <= i);
    assert.equal(w1.pendingTailBytes, i - w1.lineBoundaryCursor, `split@${i}: pending counts only re-read bytes`);
    if (w1.pendingTailBytes > 0) { assert.equal(w1.coverage, 'partial'); assert.deepEqual(w1.reasons, ['pending-tail']); }
    assert.equal(w1.counters.malformed, 0, `split@${i}: a split multibyte char is never decoded early`);
    const w2 = decEsc({ startCursor: w1.lineBoundaryCursor, watermarkMs: w1.watermarkMs, chunks: [full.subarray(w1.lineBoundaryCursor)] });
    assert.deepEqual([...w1.records, ...w2.records], ref.records, `split@${i}`);
    assert.equal(w2.coverage, 'complete');
  }
});

test('EOF with a pending tail: partial coverage, cursor at the line start, tail bytes counted not returned', () => {
  const full = bytes(ev(1), ev(2));
  const first = bytes(ev(1)).length, cut = full.length - 5;
  const r = dec({ chunks: [full.subarray(0, cut)], endOfData: true });
  assert.equal(r.records.length, 1);
  assert.equal(r.lineBoundaryCursor, first);
  assert.equal(r.pendingTailBytes, cut - first);
  assert.equal(r.counters.bytesConsumed, first);
  assert.equal(r.coverage, 'partial'); assert.deepEqual(r.reasons, ['pending-tail']);
  const resumed = dec({ startCursor: r.lineBoundaryCursor, chunks: [full.subarray(r.lineBoundaryCursor)] });
  assert.equal(resumed.records[0].lineStart, first);
  assert.equal(resumed.coverage, 'complete');
});

test('byte cap mid-chunk and exactly at a line boundary; record cap; no line lost or duplicated', () => {
  const all = [1, 2, 3, 4, 5].map(n => ev(n));
  const full = bytes(...all), lineLen = bytes(ev(1)).length;
  const ids = all.map(e => e.eventId);
  for (const [label, cfg] of [
    ['window cap mid-line', ccfg({ maxWindowBytes: lineLen + 10, maxLineBytes: lineLen + 1 })],
    ['chunk cap mid-line', ccfg({ maxChunkBytes: lineLen + 10, maxLineBytes: lineLen + 1 })],
    ['window cap exactly at boundary', ccfg({ maxWindowBytes: 2 * lineLen, maxLineBytes: lineLen + 1 })],
    ['record cap', ccfg({ maxWindowRecords: 2 })],
  ]) {
    const { got, windows } = drain(full, { config: cfg });
    assert.deepEqual(got.map(r => r.event.eventId), ids, label);
    assert.deepEqual(got.map(r => r.lineStart), [0, 1, 2, 3, 4].map(n => n * lineLen), label);
    for (const w of windows.slice(0, -1)) { assert.equal(w.coverage, 'backlog', label); assert.ok(w.reasons.includes('cap-stop'), label); }
  }
  const exact = dec({ chunks: [full], config: ccfg({ maxWindowBytes: 2 * lineLen, maxLineBytes: lineLen + 1 }) });
  assert.equal(exact.lineBoundaryCursor, 2 * lineLen);
  assert.equal(exact.pendingTailBytes, 0, 'cap on a boundary leaves nothing to re-read');
  const mid = dec({ chunks: [full], config: ccfg({ maxWindowBytes: lineLen + 10, maxLineBytes: lineLen + 1 }) });
  assert.equal(mid.lineBoundaryCursor, lineLen);
  assert.equal(mid.pendingTailBytes, 10);
  assert.equal(dec({ chunks: [bytes(ev(1), ev(2))], config: ccfg({ maxWindowRecords: 2 }) }).coverage, 'complete');
});

test('oversize line across windows: counted once, skip mode always progresses, next valid line kept', () => {
  const cfg = ccfg({ maxLineBytes: 64, maxWindowBytes: 100, maxChunkBytes: 100_000 });
  const huge = enc.encode('{"sid":"s1","ts":"2026-09-01T00:00:00Z","rc":1,"detail":"' + 'y'.repeat(500) + '"}\n');
  const next = bytes({ sid: 's2', ts: '2026-09-01T00:00:00Z', rc: 2 });
  const full = new Uint8Array([...huge, ...next]);
  const over = { sourceId: 'esc', sourceKind: 'verify-escalations-v1', config: cfg };
  const { got, windows } = drain(full, over);
  assert.equal(windows[0].skippingOversize, true);
  assert.equal(windows[0].pendingTailBytes, 0, 'skipped bytes are never re-read');
  assert.equal(windows[0].lineBoundaryCursor, 100, 'skip checkpoint advances to the end of the bytes read');
  assert.equal(windows.reduce((n, w) => n + w.counters.oversizeLines, 0), 1, 'counted once');
  for (const w of windows) if (w.skippingOversize) { assert.equal(w.pendingTailBytes, 0); assert.ok(w.reasons.includes('pending-tail')); }
  assert.equal(got.length, 1);
  assert.equal(got[0].sid, 's2');
  assert.equal(got[0].lineStart, huge.length);
  // The skip ends exactly at a window edge: the checkpoint is then a real line boundary.
  const edge = dec({ ...over, startCursor: huge.length - 50, skippingOversize: true, chunks: [full.subarray(huge.length - 50, huge.length)] });
  assert.equal(edge.skippingOversize, false);
  assert.equal(edge.lineBoundaryCursor, huge.length);
  assert.equal(edge.counters.oversizeLines, 0);
  // Oversize line whose newline is visible in one window: skipped in place, the following line is decoded.
  const wide = ccfg({ maxLineBytes: 64, maxWindowBytes: 100_000, maxChunkBytes: 100_000 });
  const once = decEsc({ chunks: [full], config: wide });
  assert.deepEqual([once.records.length, once.counters.oversizeLines, once.skippingOversize, once.coverage], [1, 1, false, 'partial']);
});

test('config without room for a max line plus newline is refused (no zero-progress restart)', () => {
  refusedAt(input({ config: ccfg({ maxLineBytes: 100, maxWindowBytes: 100 }) }), 'invalid-value', '$.maxLineBytes');
  refusedAt(input({ config: ccfg({ maxLineBytes: 100, maxChunkBytes: 100 }) }), 'invalid-value', '$.maxLineBytes');
  refusedAt(input({ config: ccfg({ maxLineBytes: 100, maxChunkBytes: 99 }) }), 'invalid-value', '$.maxLineBytes');
  assert.equal(K.decodeWindowV1(input({ config: ccfg({ maxLineBytes: 100, maxChunkBytes: 101, maxWindowBytes: 101 }) })).ok, true);
  // The same configs stay valid for legacy collectWindow, which carries a tail.
  assert.equal(K.collectWindow(state(), { generation: 0, cursor: 0, chunks: [], observedAt: OBS, endOfData: true },
    ccfg({ maxLineBytes: 100, maxWindowBytes: 100 })).ok, true);
});

test('malformed, unknown fields, unknown version, duplicate keys: dropped and counted, never thrown', () => {
  const good = JSON.stringify(ev(1));
  const lines = [good.replace('"sid":"s1"', '"sid":"s1","sid":"s2"'), good.slice(0, -1), 'garbage',
    JSON.stringify({ ...ev(2), extra: 1 }), JSON.stringify({ ...ev(3), v: 2 }), JSON.stringify({ ...ev(4), pid: 0 }),
    '{"a":' + '['.repeat(40) + ']'.repeat(40) + '}'];
  const r = dec({ chunks: [enc.encode(lines.join('\n') + '\n')] });
  assert.equal(r.records.length, 0);
  assert.deepEqual([r.counters.malformed, r.counters.unknownField, r.counters.unknownVersion, r.counters.invalidValue], [4, 1, 1, 1]);
  assert.equal(r.coverage, 'partial'); assert.deepEqual(r.reasons, ['dropped-lines']);
  const esc = decEsc({ chunks: [bytes({ ...ESC(1), extra: 'x' }, { sid: 's1', ts: 'bad', rc: 1 })] });
  assert.deepEqual([esc.counters.unknownField, esc.counters.invalidValue, esc.records.length], [1, 1, 0]);
});

test('invalid checkpoint, input and config are refused in the EfficiencyResult style, including overflow', () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  for (const value of [null, undefined, 1, 'x', [], new Map()]) refusedAt(value, 'invalid-value', '$input');
  refusedAt({ ...input(), tail: new Uint8Array([1]) }, 'invalid-value', '$input');
  refusedAt({ ...input(), tailStart: 0 }, 'invalid-value', '$input');
  const { startCursor: _drop, ...missing } = input();
  refusedAt(missing, 'invalid-value', '$input');
  refusedAt(input({ sourceId: '../x' }), 'invalid-value', '$input.sourceId');
  refusedAt(input({ sourceKind: 'other' }), 'invalid-value', '$input.sourceKind');
  for (const g of [-1, 1.5, '0', MAX + 1]) refusedAt(input({ generation: g }), 'invalid-value', '$input.generation');
  for (const c of [-1, 0.5, '0', null, MAX + 1, Infinity, NaN]) refusedAt(input({ startCursor: c }), 'invalid-value', '$input.startCursor');
  refusedAt(input({ skippingOversize: 'no' }), 'invalid-value', '$input.skippingOversize');
  for (const w of [1.5, '1', MAX + 1, Infinity]) refusedAt(input({ watermarkMs: w }), 'invalid-value', '$input.watermarkMs');
  assert.equal(K.decodeWindowV1(input({ watermarkMs: -1 })).ok, true, 'pre-1970 watermark is a signed epoch, not refused');
  refusedAt(input({ endOfData: 1 }), 'invalid-value', '$input.endOfData');
  refusedAt(input({ observedAt: '2026-09-02T00:00:00Z' }), 'invalid-value', '$input.observedAt');
  refusedAt(input({ chunks: 'abc' }), 'invalid-value', '$input.chunks');
  refusedAt(input({ chunks: [[1, 2]] }), 'invalid-value', '$input.chunks');
  refusedAt(input({ chunks: [new Uint8Array(1), , new Uint8Array(1)] }), 'invalid-value', '$input.chunks'); // eslint-disable-line no-sparse-arrays
  refusedAt(input({ chunks: Array(5).fill(new Uint8Array(0)), config: ccfg({ maxChunksPerWindow: 4 }) }), 'input-limit', '$input.chunks');
  refusedAt(input({ startCursor: MAX, chunks: [enc.encode('x')] }), 'input-limit', '$input.startCursor');
  refusedAt(input({ startCursor: MAX - 1, chunks: [enc.encode('{}\n')] }), 'input-limit', '$input.startCursor');
  assert.equal(dec({ startCursor: MAX - 3, chunks: [enc.encode('{}\n')] }).lineBoundaryCursor, MAX, 'exactly reaching MAX is allowed');
  refusedAt(input({ config: { ...ccfg(), schemaVersion: 2 } }), 'unknown-version', '$.schemaVersion');
  refusedAt(input({ config: { ...ccfg(), extra: 1 } }), 'unknown-field', '$');
  refusedAt(input({ config: ccfg({ maxLineBytes: 10 ** 9 }) }), 'invalid-value', '$.maxLineBytes');
  refusedAt(input({ config: ccfg({ maxWindowBytes: 0 }) }), 'invalid-value', '$.maxWindowBytes');
  const hostile = new Proxy(input(), { getPrototypeOf() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } });
  refusedAt(hostile, 'invalid-value', '$input');
  const getter = input(); Object.defineProperty(getter, 'chunks', { enumerable: true, get() { throw new Error('trap'); } });
  refusedAt(getter, 'invalid-value', '$input');
});

test('chunks and its length are read once: a changing getter or proxy cannot bypass maxChunksPerWindow', () => {
  const cfg = ccfg({ maxChunksPerWindow: 4 });
  const many = Array(10).fill(new Uint8Array(0));
  // The exact reproduced getter: [] for the first 2 reads, then 10 chunks.
  let calls = 0;
  const grow = Object.defineProperty(input({ config: cfg }), 'chunks', { enumerable: true,
    get() { calls++; return calls <= 2 ? [] : many; } });
  const g = K.decodeWindowV1(grow);
  assert.equal(calls, 1);
  assert.equal(g.ok, true);
  assert.deepEqual([g.value.counters.emptyChunks, g.value.lineBoundaryCursor], [0, 0], 'the observed [] is what is consumed');
  // The reverse order is refused against the same observed value.
  calls = 0;
  const shrink = Object.defineProperty(input({ config: cfg }), 'chunks', { enumerable: true,
    get() { calls++; return calls <= 1 ? many : []; } });
  refusedAt(shrink, 'input-limit', '$input.chunks');
  assert.equal(calls, 1);
  // A proxied array whose length changes between reads: the first observed length bounds the limit check and the loop.
  let lengthReads = 0;
  const lying = new Proxy(many, { get(target, key, receiver) {
    if (key === 'length') return ++lengthReads === 1 ? 4 : 10;
    return Reflect.get(target, key, receiver);
  } });
  const l = dec({ chunks: lying, config: cfg });
  assert.equal(lengthReads, 1);
  assert.equal(l.counters.emptyChunks, 4);
  lengthReads = 0;
  const huge = new Proxy(many, { get(target, key, receiver) {
    if (key === 'length') { lengthReads++; return 2 ** 32 - 1; }
    return Reflect.get(target, key, receiver);
  } });
  refusedAt(input({ chunks: huge, config: cfg }), 'input-limit', '$input.chunks');
  assert.equal(lengthReads, 1);
  for (const length of [NaN, -1, 1.5, '2']) {
    const bad = new Proxy([], { get: (target, key, receiver) => key === 'length' ? length : Reflect.get(target, key, receiver) });
    refusedAt(input({ chunks: bad, config: cfg }), 'invalid-value', '$input.chunks');
  }
  // Throwing element and length getters refuse instead of throwing.
  const throwsAt = new Proxy([new Uint8Array(0)], { get(target, key, receiver) {
    if (key === '0') throw new Error('trap');
    return Reflect.get(target, key, receiver);
  } });
  refusedAt(input({ chunks: throwsAt, config: cfg }), 'invalid-value', '$input');
  const throwsLength = new Proxy([], { get(target, key, receiver) {
    if (key === 'length') throw new Error('trap');
    return Reflect.get(target, key, receiver);
  } });
  refusedAt(input({ chunks: throwsLength, config: cfg }), 'invalid-value', '$input');
});

test('time: supplied watermark drives late, output watermark is the max, future skew is dropped', () => {
  const wm = Date.parse(at(100));
  const r = dec({ watermarkMs: wm, chunks: [bytes(ev(50), ev(99), ev(200))] });
  assert.deepEqual(r.records.map(x => x.late), [true, false, false]);
  assert.equal(r.counters.late, 1);
  assert.equal(r.watermarkMs, Date.parse(at(200)));
  const lower = dec({ watermarkMs: wm, chunks: [bytes(ev(99))] });
  assert.equal(lower.watermarkMs, wm, 'watermark never moves backwards');
  const future = dec({ chunks: [bytes(ev(1, { at: '2026-09-02T00:05:00.001Z' }), ev(2, { at: '2026-09-02T00:05:00.000Z' }))] });
  assert.equal(future.counters.clockSkew, 1);
  assert.equal(future.records.length, 1);
  assert.ok(future.reasons.includes('dropped-lines'));
  const esc = decEsc({ watermarkMs: Date.parse('2026-09-01T01:00:00Z'), chunks: [bytes(ESC(1))] });
  assert.equal(esc.records[0].late, true);
});

test('replay: the same checkpoint re-emits identical duplicate-eligible records; no dedup state', () => {
  const chunks = [bytes(ev(1), ev(2), ev(1), ev(1, { taskId: 'T9' }))];
  const a = dec({ chunks }), b = dec({ chunks });
  assert.deepEqual(a, b, 'deterministic');
  assert.deepEqual(a.records.map(r => r.recordId), [ev(1).eventId, ev(2).eventId, ev(1).eventId, ev(1).eventId],
    'repeat and conflicting ids are both emitted for the store to classify');
  assert.ok(a.records.every(r => r.type === 'event'), 'no conflict records without dedup state');
  const e1 = decEsc({ chunks: [bytes(ESC(1), ESC(1))] });
  assert.deepEqual(e1.records.map(r => r.possibleDuplicate), [false, false], 'possibleDuplicate is not assessed here');
  assert.notEqual(e1.records[0].recordId, e1.records[1].recordId, 'escalation identity is location-based');
  const again = decEsc({ chunks: [bytes(ESC(1), ESC(1))] });
  assert.deepEqual(again.records.map(r => r.recordId), e1.records.map(r => r.recordId));
});

test('source-specific record shapes validate as CollectedRecordV1; legacy detail is dropped', () => {
  const s = dec({ generation: 3, startCursor: 10, chunks: [bytes(ev(1))] });
  const e = decEsc({ generation: 2, chunks: [bytes(ESC(7, { nested: ['x'] }))] });
  for (const r of [...s.records, ...e.records]) {
    const v = C.validateCollectedRecordV1(r);
    assert.equal(v.ok, true, JSON.stringify(v.ok ? '' : v.reason));
    assert.deepEqual(v.value, r);
    assert.equal(r.provenance, 'not-established');
    assert.equal(r.observedAt, OBS);
  }
  assert.deepEqual([s.records[0].generation, s.records[0].lineStart, s.records[0].sourceId], [3, 10, 'spool']);
  assert.deepEqual(Object.keys(e.records[0]).sort(), ['generation', 'late', 'lineStart', 'observedAt', 'possibleDuplicate', 'provenance',
    'rc', 'recordId', 'sid', 'sourceId', 'sourceKind', 'timeBasis', 'ts', 'type']);
});

// Whitelisted fields are syntax-checked only: a valid ID is emitted as-is, whatever it looks like. This test covers
// raw and unapproved fields (legacy detail, extra keys, malformed/oversize/partial-tail bytes), not ID contents.
test('public result carries only whitelisted fields: raw/unapproved fields and dropped/oversize/partial-tail bytes never appear', () => {
  const cfg = ccfg({ maxLineBytes: 200, maxWindowBytes: 100_000, maxChunkBytes: 100_000 });
  const chunk = enc.encode([JSON.stringify(ESC(1, SECRET)), SECRET, JSON.stringify(ESC(2, SECRET.repeat(20))),
    JSON.stringify({ ...ESC(3), token: SECRET }), JSON.stringify(ESC(5, SECRET, 's5'))].join('\n') + '\n'
    + JSON.stringify(ESC(4, SECRET)).slice(0, -3));
  const r = decEsc({ chunks: [chunk], config: cfg });
  assert.deepEqual(r.records.map(x => [x.sid, x.rc]), [['s1', 1], ['s5', 5]], 'valid sids retained; unapproved detail dropped');
  assert.deepEqual([r.counters.malformed, r.counters.oversizeLines, r.counters.unknownField], [1, 1, 1]);
  assert.ok(r.pendingTailBytes > 0);
  assertNoSentinel(r, 'decode result');
  walkNoBytes(r);
  const skipping = decEsc({ chunks: [enc.encode(JSON.stringify(ESC(1, SECRET.repeat(20))))], config: cfg });
  assert.equal(skipping.skippingOversize, true);
  assertNoSentinel(skipping, 'skip result'); walkNoBytes(skipping);
  const refusal = K.decodeWindowV1({ ...escInput({ chunks: [chunk] }), [SECRET]: SECRET });
  assert.equal(refusal.ok, false); assertNoSentinel(refusal, 'refusal');
});

test('pure: input object and chunks are not mutated; the result does not alias caller memory', () => {
  const chunk = bytes(ev(1), ev(2)).subarray(0, 300);
  const value = input({ chunks: [chunk], config: ccfg() });
  const before = structuredClone(value);
  const r = K.decodeWindowV1(value);
  assert.equal(r.ok, true);
  assert.deepEqual(value, before);
  const snapshot = structuredClone(r.value);
  chunk.fill(0x41);
  assert.deepEqual(r.value, snapshot, 'records hold decoded values only');
});

test('shared framing parity with legacy collectWindow; legacy keeps its transient raw tail semantics', () => {
  const objs = []; for (let i = 1; i <= 40; i++) objs.push(i % 7 === 0 ? 'garbage\n' : i % 5 === 0 ? '\r\n' : ev(i, { taskId: `T${i % 3}` }));
  const full = bytes(...objs);
  const legacy = collect(state(), [full]);
  const single = dec({ chunks: [full] });
  assert.deepEqual(single.records, legacy.records);
  for (const key of COUNTER_KEYS) assert.equal(single.counters[key], legacy.counters[key], key);
  assert.equal(single.coverage, legacy.coverage);
  assert.deepEqual(single.reasons, legacy.reasons);
  let seed = 1185;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 20; trial++) {
    const { got } = drain(full, {}, cursor => {
      const chunks = []; let p = cursor;
      for (let k = 0; k < 3 && p < full.length; k++) { const n = 1 + Math.floor(rnd() * 200); chunks.push(full.subarray(p, p + n)); p += n; }
      return chunks;
    }, false);
    assert.deepEqual(got, legacy.records, `trial ${trial}`);
  }
  const escFull = bytes(ESC(1, '한'), ESC(2), ESC(3, { a: 1 }));
  assert.deepEqual(decEsc({ chunks: [escFull] }).records, collect(state('verify-escalations-v1', 'esc'), [escFull]).records);
  // Legacy: the partial line is consumed into a transient raw tail; the stateless API instead re-reads it.
  const cut = bytes(ev(1)).length + 20;
  const w = collect(state(), [bytes(ev(1), ev(2)).subarray(0, cut)]);
  assert.ok(w.state.tail instanceof Uint8Array);
  assert.deepEqual([w.nextCursor, w.pendingTailBytes, w.state.tailStart], [cut, 20, bytes(ev(1)).length]);
  const d = dec({ chunks: [bytes(ev(1), ev(2)).subarray(0, cut)] });
  assert.deepEqual([d.lineBoundaryCursor, d.pendingTailBytes], [bytes(ev(1)).length, 20]);
});
