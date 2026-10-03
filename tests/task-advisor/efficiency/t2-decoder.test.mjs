// 2. Byte-level decoder: UTF-8 splits, CRLF, empty chunks, tails, malformed/duplicate/nested, oversize, caps, cursor, purity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { K, ev, bytes, enc, state, collect, ccfg, OBS } from './helpers.mjs';

const ESC = (rc, detail = 'ok') => ({ sid: 's1', ts: '2026-09-01T00:00:00Z', rc, detail });
const stripState = r => r.records.map(x => ({ ...x }));

function snapshot(chunks) { return chunks.map(c => Buffer.from(c)); }
function unchanged(chunks, snap) { chunks.forEach((c, i) => assert.ok(Buffer.from(c).equals(snap[i]), 'input chunk mutated')); }

test('UTF-8 multibyte split at every byte, within one window and across two windows', () => {
  const full = bytes(ESC(1, '한글🙂é'), ESC(2, '🙂🙂'));
  const reference = collect(state('verify-escalations-v1', 'esc'), [full]);
  assert.equal(reference.records.length, 2);
  assert.equal(reference.coverage, 'complete');
  for (let i = 0; i <= full.length; i++) {
    const chunks = [full.subarray(0, i), full.subarray(i)];
    const snap = snapshot(chunks);
    const one = collect(state('verify-escalations-v1', 'esc'), chunks);
    unchanged(chunks, snap);
    assert.deepEqual(stripState(one), stripState(reference), `split@${i}`);
    const w1 = collect(state('verify-escalations-v1', 'esc'), [chunks[0]]);
    assert.equal(w1.nextCursor, i);
    const w2 = collect(w1.state, [chunks[1]]);
    assert.deepEqual([...w1.records, ...w2.records], reference.records, `window-split@${i}`);
    assert.equal(w2.coverage, 'complete');
  }
});

test('three-way splits over every pair of offsets (spool events) equal single-shot', () => {
  const full = bytes(ev(1), ev(2, { taskId: 'T2' }));
  const ref = collect(state(), [full]).records;
  const step = 7;
  for (let i = 0; i <= full.length; i += step) for (let j = i; j <= full.length; j += step) {
    const r = collect(state(), [full.subarray(0, i), full.subarray(i, j), full.subarray(j)]);
    assert.deepEqual(r.records, ref);
  }
});

test('invalid UTF-8 is malformed and reported as dropped', () => {
  const bad = new Uint8Array([...enc.encode('{"sid":"s1","ts":"2026-09-01T00:00:00Z","rc":1,"detail":"'), 0xc3, 0x28, ...enc.encode('"}\n')]);
  const r = collect(state('verify-escalations-v1', 'esc'), [bad]);
  assert.equal(r.counters.malformed, 1);
  assert.equal(r.records.length, 0);
  assert.equal(r.coverage, 'partial');
  assert.deepEqual(r.reasons, ['dropped-lines']);
});

test('CRLF, empty chunks, blank lines', () => {
  const crlf = enc.encode(JSON.stringify(ev(1)) + '\r\n' + '\r\n' + '   \n' + JSON.stringify(ev(2)) + '\r\n');
  const r = collect(state(), [new Uint8Array(0), crlf.subarray(0, 10), new Uint8Array(0), crlf.subarray(10)]);
  assert.equal(r.records.length, 2);
  assert.equal(r.counters.emptyChunks, 2);
  assert.equal(r.counters.emptyLines, 2);
  assert.equal(r.coverage, 'complete');
  // split exactly between \r and \n
  const idx = crlf.indexOf(13);
  const r2 = collect(state(), [crlf.subarray(0, idx + 1), crlf.subarray(idx + 1)]);
  assert.deepEqual(r2.records, r.records);
  const empty = collect(state(), []);
  assert.equal(empty.coverage, 'complete'); assert.equal(empty.consumedBytes, 0);
});

test('terminal partial tail: endOfData=true → partial/pending-tail; completion resumes with correct lineStart', () => {
  const full = bytes(ev(1), ev(2));
  const cut = full.length - 5;
  const w1 = collect(state(), [full.subarray(0, cut)]);
  assert.equal(w1.records.length, 1);
  assert.equal(w1.coverage, 'partial');
  assert.deepEqual(w1.reasons, ['pending-tail']);
  assert.equal(w1.pendingTailBytes, cut - bytes(ev(1)).length);
  assert.equal(w1.nextCursor, cut);
  const w2 = collect(w1.state, [full.subarray(cut)]);
  assert.equal(w2.records.length, 1);
  assert.equal(w2.records[0].lineStart, bytes(ev(1)).length);
  assert.equal(w2.coverage, 'complete');
  const notEnd = collect(state(), [full], { endOfData: false });
  assert.equal(notEnd.coverage, 'backlog');
  assert.deepEqual(notEnd.reasons, ['not-end-of-data']);
});

test('malformed JSON variants, duplicate keys, nested values', () => {
  const good = JSON.stringify(ev(1));
  const variants = [
    good.slice(0, -1), good + ',', good + good, '[' + good + ']', good.replace('"v":1', '"v":1,'),
    good.replace('}', ',}'), good.replace('"pid":100', '"pid":trueX'), good.replace('"pid":100', '"pid":01'),
    good.replace('"pid":100', '"pid":1e400'), '"string"', 'null', good.replace('"sid":"s1"', '"sid":"s1","sid":"s2"'),
    good.replace('"sid":"s1"', '"sid":"s1\u0001"'), good.replace('"sid":"s1"', '"sid":{"a":{"a":1,"a":2'),
  ];
  const r = collect(state(), [enc.encode(variants.join('\n') + '\n')]);
  assert.equal(r.records.length, 0);
  assert.equal(r.counters.malformed, variants.length, 'each variant malformed, including duplicate keys (no last-wins)');
  const nested = [good.replace('"sid":"s1"', '"sid":{"x":[1,2,{"y":null}]}'), good.replace('"count":null', '"count":[1]'),
    good.replace('"v":1', '"v":{"v":1}')];
  const n = collect(state(), [enc.encode(nested.join('\n') + '\n')]);
  assert.equal(n.records.length, 0);
  assert.equal(n.counters.invalidValue, 2); assert.equal(n.counters.unknownVersion, 1);
  // nested legacy detail is dropped and the whitelisted fields survive
  const esc = collect(state('verify-escalations-v1', 'esc'), [bytes({ sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 0, detail: { a: [{ b: 'c' }] } })]);
  assert.equal(esc.records.length, 1);
  const deep = '{"sid":"s1","ts":"2026-09-01T00:00:00Z","rc":0,"detail":' + '['.repeat(40) + ']'.repeat(40) + '}\n';
  assert.equal(collect(state('verify-escalations-v1', 'esc'), [enc.encode(deep)]).counters.malformed, 1, 'depth bounded');
});

test('exact line byte cap: maxLineBytes accepted, +1 skipped; CR counts toward cap', () => {
  const cfg = ccfg({ maxLineBytes: 100, maxWindowBytes: 100_000, maxChunkBytes: 100_000 });
  const pad = n => ({ sid: 's1', ts: '2026-09-01T00:00:00Z', rc: 1, detail: 'x'.repeat(n) });
  const baseLen = JSON.stringify(pad(0)).length;
  const exact = JSON.stringify(pad(100 - baseLen));
  assert.equal(exact.length, 100);
  const over = JSON.stringify(pad(101 - baseLen));
  const ninetyNine = JSON.stringify(pad(99 - baseLen));
  const r = collect(state('verify-escalations-v1', 'esc'), [enc.encode(exact + '\n' + over + '\n' + ninetyNine + '\r\n' + exact + '\r\n')], {}, cfg);
  assert.equal(r.counters.malformed, 0);
  assert.equal(r.records.length, 2);
  assert.equal(r.counters.oversizeLines, 2);
  assert.equal(r.coverage, 'partial');
});

test('oversize line skip resumes across chunks AND windows; retained tail stays bounded', () => {
  const cfg = ccfg({ maxLineBytes: 64, maxWindowBytes: 100_000, maxChunkBytes: 100_000 });
  const huge = enc.encode('{"sid":"s1","ts":"2026-09-01T00:00:00Z","rc":1,"detail":"' + 'y'.repeat(500) + '"}\n');
  const next = bytes({ sid: 's2', ts: '2026-09-01T00:00:00Z', rc: 2 });
  const w1 = collect(state('verify-escalations-v1', 'esc'), [huge.subarray(0, 40), huge.subarray(40, 200)], {}, cfg);
  assert.equal(w1.state.skipping, true);
  assert.equal(w1.state.tail, null, 'no unbounded buffering while skipping');
  assert.equal(w1.counters.oversizeLines, 1);
  assert.ok(w1.reasons.includes('pending-tail'));
  const w2 = collect(w1.state, [huge.subarray(200, 400)], {}, cfg);
  assert.equal(w2.state.skipping, true);
  assert.equal(w2.counters.oversizeLines, 0, 'counted once');
  const w3 = collect(w2.state, [huge.subarray(400), next], {}, cfg);
  assert.equal(w3.state.skipping, false);
  assert.equal(w3.records.length, 1);
  assert.equal(w3.records[0].sid, 's2');
  assert.equal(w3.records[0].lineStart, huge.length);
  assert.equal(w3.coverage, 'complete');
  assert.equal(w3.state.totals.oversizeLines, 1);
  for (const w of [w1, w2, w3]) assert.ok((w.state.tail?.byteLength ?? 0) <= 64);
});

test('record cap: exact cap, cap-stop backlog, resumable cursor with no loss or duplication', () => {
  const all = [1, 2, 3, 4, 5].map(n => ev(n));
  const full = bytes(...all);
  const cfg = ccfg({ maxWindowRecords: 2 });
  let st = state(); const got = []; let windows = 0; let cursor = 0;
  while (cursor < full.length) {
    const r = collect(st, [full.subarray(cursor)], {}, cfg);
    windows++;
    got.push(...r.records);
    if (r.nextCursor < full.length) { assert.equal(r.coverage, 'backlog'); assert.ok(r.reasons.includes('cap-stop')); }
    assert.ok(r.records.length <= 2);
    st = r.state; cursor = r.nextCursor;
  }
  assert.equal(windows, 3);
  assert.deepEqual(got.map(r => r.event.eventId), all.map(e => e.eventId));
  assert.equal(st.totals.duplicates, 0);
  const exact = collect(state(), [bytes(ev(1), ev(2))], {}, cfg);
  assert.equal(exact.coverage, 'complete', 'exactly maxWindowRecords is not a cap-stop');
});

test('window byte cap and chunk byte cap stop mid-line with tail; resume from nextCursor', () => {
  const full = bytes(ev(1), ev(2), ev(3));
  const lineLen = bytes(ev(1)).length;
  for (const key of ['maxWindowBytes', 'maxChunkBytes']) {
    const cfg = ccfg({ [key]: lineLen + 10, maxLineBytes: lineLen + 1 });
    let st = state(); const got = []; let cursor = 0; let guard = 0;
    while (cursor < full.length && guard++ < 10) {
      const r = collect(st, [full.subarray(cursor)], {}, cfg);
      got.push(...r.records);
      assert.ok(r.consumedBytes <= lineLen + 10);
      if (r.nextCursor < full.length) assert.equal(r.coverage, 'backlog');
      st = r.state; cursor = r.nextCursor;
    }
    assert.deepEqual(got.map(r => r.event.eventId), [1, 2, 3].map(u => ev(u).eventId), key);
    assert.deepEqual(got.map(r => r.lineStart), [0, lineLen, 2 * lineLen]);
  }
  const tooMany = K.collectWindow(state(), { generation: 0, cursor: 0, chunks: Array(5).fill(new Uint8Array(0)), observedAt: OBS, endOfData: true }, ccfg({ maxChunksPerWindow: 4 }));
  assert.equal(tooMany.ok, false); assert.equal(tooMany.reason.code, 'input-limit');
});

test('random chunk partitions across windows reproduce single-shot records (deterministic PRNG)', () => {
  const objs = []; for (let i = 1; i <= 40; i++) objs.push(i % 7 === 0 ? 'garbage\n' : i % 5 === 0 ? '\r\n' : ev(i, { taskId: `T${i % 3}` }));
  const full = bytes(...objs);
  const ref = collect(state(), [full]);
  let seed = 1185;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let trial = 0; trial < 30; trial++) {
    let st = state(); let pos = 0; const got = [];
    while (pos < full.length) {
      const chunks = []; let p = pos;
      for (let k = 0; k < 3 && p < full.length; k++) { const n = Math.floor(rnd() * 120); chunks.push(full.subarray(p, p + n)); p += n; }
      const r = collect(st, chunks); got.push(...r.records); st = r.state; pos = r.nextCursor;
    }
    assert.deepEqual(got, ref.records, `trial ${trial}`);
    assert.equal(st.totals.malformed, ref.counters.malformed);
  }
});

test('collector never mutates the supplied state object', () => {
  const s0 = state();
  const w1 = collect(s0, [bytes(ev(1)).subarray(0, 20)]);
  const before = structuredClone(w1.state);
  const tailCopy = Buffer.from(w1.state.tail);
  collect(w1.state, [bytes(ev(1)).subarray(20), bytes(ev(2))]);
  assert.deepEqual(w1.state, before);
  assert.ok(Buffer.from(w1.state.tail).equals(tailCopy));
  const chunk = bytes(ev(3)); const snap = Buffer.from(chunk);
  const w = collect(state(), [chunk.subarray(0, 30)]);
  chunk.fill(0x41); // caller reuses its buffer afterwards
  assert.ok(Buffer.from(w.state.tail).equals(snap.subarray(0, 30)), 'tail is a private copy, not an alias of caller memory');
});

test('candidate performs no fs/env/network/timer/child/clock I/O (instrumented own child)', () => {
  const child = fileURLToPath(new URL('./purity-child.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [child], { encoding: 'utf8', env: { PATH: '' } });
  const res = JSON.parse(out.trim().split('\n').pop());
  assert.ok(res.calls > 10, 'battery exercised the candidate');
  assert.deepEqual(res.hits, []);
});
