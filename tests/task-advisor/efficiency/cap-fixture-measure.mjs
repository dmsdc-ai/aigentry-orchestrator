// One bounded cap fixture (measurement only, no pass/fail, no global performance claim).
// Default collector caps: one full 256 KiB window. Default analyzer maxRecords 20,000: benign vs adversarial role×version shape.
import { K, E, C, ev, errEv, rec, request, state, bytes, CFG } from './helpers.mjs';

const mem = () => Math.round(process.memoryUsage().rss / 1048576);
const time = fn => { const t0 = process.hrtime.bigint(); const v = fn(); return [v, Number(process.hrtime.bigint() - t0) / 1e6]; };
const out = { node: process.version, rssStartMiB: mem() };

const lines = []; let size = 0, n = 0;
while (size < C.DEFAULT_COLLECTOR_CONFIG.maxWindowBytes + 4096) { const l = JSON.stringify(ev(++n)) + '\n'; lines.push(l); size += l.length; }
const buf = bytes(lines.join(''));
const [cw, cms] = time(() => K.collectWindow(state(), { generation: 0, cursor: 0, chunks: [buf], observedAt: '2026-09-02T00:00:00.000Z', endOfData: true }).value);
out.collector = { inputBytes: buf.length, consumedBytes: cw.consumedBytes, records: cw.records.length, coverage: cw.coverage, reasons: cw.reasons, ms: +cms.toFixed(1), rssMiB: mem() };

const cfg = { ...C.DEFAULT_EFFICIENCY_CONFIG, maxOperations: 50_000_000 };
const N = C.DEFAULT_EFFICIENCY_CONFIG.maxRecords;
const benign = []; for (let i = 0; i < N; i++) benign.push(rec((i % 2 ? errEv : ev)(i + 1, { at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), taskId: `T${i % 50}`, sid: `s${i % 50}` })));
const [rb, bms] = time(() => E.analyzeEfficiency(request({ records: benign, config: cfg })).value);
out.analyzerBenign = { records: N, ms: +bms.toFixed(1), metrics: rb.metrics.length, operations: rb.counts.operations, coverage: rb.coverage.overall, rssMiB: mem() };

const adv = []; for (let i = 0; i < N; i++) adv.push(rec(ev(i + 1, { at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString(), taskId: 'T2', sid: 's2', role: `r${i.toString(36)}`, producerVersion: `v${i}` })));
const [ra, ams] = time(() => E.analyzeEfficiency(request({ grant: { mode: 'whole-workspace-diagnostic', taskIds: ['T2'], sids: [], releaseIds: [] }, records: adv, config: cfg })).value);
out.analyzerAdversarialRoleVersion = { records: N, ms: +ams.toFixed(1), metrics: ra.metrics.length, operations: ra.counts.operations, coverage: ra.coverage.overall, rssMiB: mem() };
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
