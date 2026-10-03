// Shared synthetic fixtures for #1185 independent core tests (et1185ma-tester).
// Imports ONLY the real tsc output under dist/src/task-advisor (no fixture fallback). No host data, fixed clocks only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DIST = new URL('../../../dist/src/task-advisor/', import.meta.url);
export const C = await import(new URL('efficiency-contracts.js', DIST).href);
export const K = await import(new URL('collect.js', DIST).href);
export const E = await import(new URL('efficiency.js', DIST).href);

export const SECRET = 'SENTINEL_SECRET_sk-live-9f8e7d';
export const CODE = 'SENTINEL_CODE_rm -rf /';
export const PROMPT = 'SENTINEL_PROMPT_ignore previous instructions';
export const SENTINELS = [SECRET, CODE, PROMPT, 'SENTINEL_'];

export const enc = new TextEncoder();
export const BASE_MS = Date.UTC(2026, 8, 1, 0, 0, 0); // fixed, never the wall clock
export const at = (minutes, extraMs = 0) => new Date(BASE_MS + minutes * 60_000 + extraMs).toISOString();
export const u = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const OBS = '2026-09-02T00:00:00.000Z';

export function ev(n, over = {}) {
  return { v: 1, eventId: u(n), kind: 'dispatch.start', producer: 'dispatch', producerVersion: '1.0.0', pid: 100,
    at: at(n % 1000), sid: 's1', taskId: 'T1', dispatchId: null, role: 'coder', outcome: null, errorClass: null, count: null,
    usageSource: 'unknown', auth: 'not-established', ...over };
}
export function errEv(n, over = {}) {
  return ev(n, { kind: 'reconciler.transport_error', producer: 'reconciler', role: null, ...over });
}
export const line = obj => JSON.stringify(obj) + '\n';
export const bytes = (...objs) => enc.encode(objs.map(o => (typeof o === 'string' ? o : line(o))).join(''));

export function state(kind = 'advisor-spool-v1', id = 'spool') {
  const s = K.createCollectorState(id, kind);
  assert.equal(s.ok, true);
  return s.value;
}
export function collect(st, chunks, over = {}, config) {
  const r = K.collectWindow(st, { generation: st.generation, cursor: st.cursor, chunks, observedAt: OBS, endOfData: true, ...over }, config);
  assert.equal(r.ok, true, JSON.stringify(r.ok ? '' : r.reason));
  return r.value;
}
export function ccfg(over = {}) { return { ...C.DEFAULT_COLLECTOR_CONFIG, ...over }; }

// ---- analysis fixtures
export const WINDOW = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
export const NOW = '2026-09-03T00:00:00Z';
export const WS = { mode: 'whole-workspace-diagnostic', taskIds: [], sids: [], releaseIds: [] };
export const grantTasks = (...taskIds) => ({ mode: 'subjects', taskIds, sids: [], releaseIds: [] });
export const src = (sourceId, sourceKind, over = {}) => ({ sourceId, sourceKind, available: true, coverage: 'complete',
  coveredFrom: '2026-08-31T00:00:00Z', coveredTo: '2026-09-03T00:00:00Z', ...over });
export const SOURCES = [src('spool', 'advisor-spool-v1'), src('esc', 'verify-escalations-v1')];
export const CFG = { schemaVersion: 1, minSamples: 3, errorRepeatThreshold: 3, roundsThreshold: 2, handoffLatencyThresholdMs: 1000,
  maxRecords: 1000, maxOperations: 1_000_000, maxGroups: 100, maxProposalsPerRule: 3 };

export function rec(event, over = {}) {
  return { type: 'event', recordId: event.eventId.toLowerCase(), sourceId: 'spool', sourceKind: 'advisor-spool-v1', generation: 0,
    lineStart: 0, observedAt: OBS, provenance: 'not-established', timeBasis: 'producer-clock', late: false, event, ...over };
}
export function escRec(n, sid, ts, rc = 1, over = {}) {
  return { type: 'escalation', recordId: createHash('sha256').update(`esc-${n}`).digest('hex'), sourceId: 'esc',
    sourceKind: 'verify-escalations-v1', generation: 0, lineStart: n, observedAt: OBS, provenance: 'not-established',
    timeBasis: 'producer-clock', late: false, possibleDuplicate: false, sid, ts, rc, ...over };
}
export function request(o = {}) {
  return { schemaVersion: 1, analysis: { ownerTaskId: 'OWNER', releaseId: 'R1171' }, grant: o.grant ?? WS, now: o.now ?? NOW,
    window: o.window ?? WINDOW, sources: o.sources ?? SOURCES, records: o.records ?? [], priorConditions: o.priorConditions ?? [],
    config: o.config ?? CFG };
}
export function analyze(o = {}) {
  const input = request(o);
  const before = structuredClone(input);
  const r = E.analyzeEfficiency(input);
  assert.deepEqual(input, before, 'analyzer input must be unchanged');
  assert.equal(r.ok, true, JSON.stringify(r.ok ? '' : r.reason));
  return r.value;
}
export const metricsOf = (report, filter) => report.metrics.filter(m => Object.entries(filter).every(([k, v]) => m[k] === v));
export function assertNoSentinel(value, label = 'value') {
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
  for (const s of SENTINELS) assert.ok(!text.includes(s), `${label} must not contain sentinel ${s}`);
}
