import { createHash } from 'node:crypto';

/** #1185 workflow-efficiency core, closed v1 schemas (CONTRACT-final §3–§6, r2 §B–§E, §I).
 * Pure structural validation only: nothing here authenticates a producer, grants authority,
 * or touches files, env, process, network, timers or the wall clock. Refusals carry a fixed
 * code and a schema path only; untrusted text, keys and values are never echoed.
 * These are versioned adapter types for a later store/caller integration; they are not
 * ProposalV2/ProposalV3 and are never admission or publication records.
 */
export type EfficiencyRefusalCode = 'invalid-shape' | 'unknown-field' | 'unknown-version'
  | 'invalid-value' | 'input-limit' | 'duplicate-id' | 'grant-invalid';
export interface EfficiencyRefusal { code: EfficiencyRefusalCode; path: string }
export type EfficiencyResult<T> = { ok: true; value: T } | { ok: false; reason: EfficiencyRefusal };

class Refused extends Error {
  constructor(readonly reason: EfficiencyRefusal) { super(reason.code); }
}
function refuse(code: EfficiencyRefusalCode, path: string): never { throw new Refused({ code, path }); }
function attempt<T>(operation: () => T): EfficiencyResult<T> {
  try { return { ok: true, value: operation() }; }
  catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    return { ok: false, reason: { code: 'invalid-shape', path: '$' } };
  }
}

// ---------------------------------------------------------------------------
// Closed enums (fixed safe labels; never derived from log text)
export const EVENT_KINDS = ['dispatch.start', 'dispatch.ack', 'dispatch.started_check', 'dispatch.gate_reject',
  'dispatch.retry_refused', 'dispatch.ledger_failed', 'inject.report', 'inject.test_report', 'inject.hold',
  'inject.payload_rejected', 'reconciler.transport_error', 'reconciler.loop_tick_error', 'reconciler.cleanup'] as const;
export type EventKind = typeof EVENT_KINDS[number];
export const PRODUCERS = ['dispatch', 'inject-handler', 'reconciler'] as const;
export type Producer = typeof PRODUCERS[number];
export const ERROR_CLASSES = ['transport', 'delivery-unverified', 'start-unverified', 'gate-reject', 'retry-refused',
  'ledger-write', 'payload-rejected', 'loop-tick', 'cleanup'] as const;
export type ErrorClass = typeof ERROR_CLASSES[number];
/** `ok|failed` for reconciler.cleanup is this slice's closed choice; the producer enum is not staged. */
export const OUTCOMES = ['verified', 'unverified', 'ok', 'failed'] as const;
export type Outcome = typeof OUTCOMES[number];
export const SOURCE_KINDS = ['advisor-spool-v1', 'verify-escalations-v1'] as const;
export type SourceKind = typeof SOURCE_KINDS[number];
export const COVERAGES = ['complete', 'partial', 'backlog', 'gap', 'unknown'] as const;
export type Coverage = typeof COVERAGES[number];
export const COVERAGE_RANK: Readonly<Record<Coverage, number>> = Object.freeze({ complete: 0, partial: 1, backlog: 2, gap: 3, unknown: 4 });
export function worstCoverage(items: readonly Coverage[]): Coverage {
  let worst: Coverage = 'complete';
  for (const item of items) if (COVERAGE_RANK[item] > COVERAGE_RANK[worst]) worst = item;
  return worst;
}

/** Kind → producer and allowed outcome set. `null` outcomes means outcome must be null. */
export const KIND_RULES: Readonly<Record<EventKind, { producer: Producer; outcomes: readonly Outcome[] | null }>> = Object.freeze({
  'dispatch.start': { producer: 'dispatch', outcomes: null },
  'dispatch.ack': { producer: 'dispatch', outcomes: ['verified', 'unverified'] },
  'dispatch.started_check': { producer: 'dispatch', outcomes: ['verified', 'unverified'] },
  'dispatch.gate_reject': { producer: 'dispatch', outcomes: null },
  'dispatch.retry_refused': { producer: 'dispatch', outcomes: null },
  'dispatch.ledger_failed': { producer: 'dispatch', outcomes: null },
  'inject.report': { producer: 'inject-handler', outcomes: null },
  'inject.test_report': { producer: 'inject-handler', outcomes: null },
  'inject.hold': { producer: 'inject-handler', outcomes: null },
  'inject.payload_rejected': { producer: 'inject-handler', outcomes: null },
  'reconciler.transport_error': { producer: 'reconciler', outcomes: null },
  'reconciler.loop_tick_error': { producer: 'reconciler', outcomes: null },
  'reconciler.cleanup': { producer: 'reconciler', outcomes: ['ok', 'failed'] },
});

// ---------------------------------------------------------------------------
// Scalar checks
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const UUID4 = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const INT32_MAX = 2_147_483_647;

function plain(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse('invalid-shape', path);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) refuse('invalid-shape', path);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], path: string, optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) && !optional.includes(key)) refuse('unknown-field', path);
  for (const key of keys) if (!Object.hasOwn(value, key)) refuse('invalid-shape', path);
}
function matches(expression: RegExp, value: unknown, path: string): string {
  if (typeof value !== 'string' || !expression.test(value)) return refuse('invalid-value', path);
  return value;
}
export function isId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function id(value: unknown, path: string): string { return matches(ID, value, path); }
function nullableId(value: unknown, path: string): string | null { return value === null ? null : id(value, path); }
function digest(value: unknown, path: string): string { return matches(DIGEST, value, path); }
function int(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return refuse('invalid-value', path);
  return value;
}
function bool(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : refuse('invalid-value', path);
}
function oneOf<T extends string>(values: readonly T[], value: unknown, path: string): T {
  return values.some(item => item === value) ? value as T : refuse('invalid-value', path);
}
function list<T>(value: unknown, path: string, max: number, check: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) return refuse('invalid-shape', path);
  if (value.length > max) refuse('input-limit', path);
  const out: T[] = [];
  for (let index = 0; index < value.length; index++) out.push(check(value[index], `${path}[${index}]`));
  return out;
}
function uniqueIds(value: unknown, path: string, max: number): string[] {
  const ids = list(value, path, max, id);
  if (new Set(ids).size !== ids.length) refuse('duplicate-id', path);
  return [...ids].sort();
}
/** Exact ISO-8601 UTC with milliseconds (producer `at`). Returns epoch ms. */
export function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_MS.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
/** UTC timestamp with optional ≤3 fractional digits (legacy `ts`, request clocks). */
export function parseUtc(value: unknown): number | null {
  if (typeof value !== 'string' || !UTC.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return ms;
}
function isoMs(value: unknown, path: string): string {
  return parseIsoMs(value) === null ? refuse('invalid-value', path) : value as string;
}
function utc(value: unknown, path: string): string {
  return parseUtc(value) === null ? refuse('invalid-value', path) : value as string;
}

// ---------------------------------------------------------------------------
// Stable metadata identities (normalized metadata only; never raw line bytes)
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Refused({ code: 'invalid-value', path: '$canonical' });
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const item = plain(value, '$canonical');
  return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}';
}
export function metadataId(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Event v1 (closed; CONTRACT-final §3 plus optional exact identity fields for future producers)
export interface AdvisorEventV1 {
  v: 1; eventId: string; kind: EventKind; producer: Producer; producerVersion: string; pid: number; at: string;
  sid: string | null; taskId: string | null; dispatchId: string | null; role: string | null;
  outcome: Outcome | null; errorClass: ErrorClass | null; count: number | null;
  usageSource: 'unknown'; auth: 'not-established';
  /** Optional on the wire (absent or null in v1). Normalized to null; never inferred. */
  attempt: string | null; operation: string | null; releaseId: string | null;
}
export const EVENT_V1_FIELDS = ['v', 'eventId', 'kind', 'producer', 'producerVersion', 'pid', 'at', 'sid', 'taskId',
  'dispatchId', 'role', 'outcome', 'errorClass', 'count', 'usageSource', 'auth'] as const;
export const EVENT_V1_OPTIONAL_FIELDS = ['attempt', 'operation', 'releaseId'] as const;

function checkEvent(value: unknown, path: string): AdvisorEventV1 {
  const o = plain(value, path);
  if (o.v !== 1) refuse('unknown-version', `${path}.v`);
  exact(o, EVENT_V1_FIELDS, path, EVENT_V1_OPTIONAL_FIELDS);
  const kind = oneOf(EVENT_KINDS, o.kind, `${path}.kind`);
  const producer = oneOf(PRODUCERS, o.producer, `${path}.producer`);
  const rule = KIND_RULES[kind];
  if (producer !== rule.producer) refuse('invalid-value', `${path}.producer`);
  const outcome = o.outcome === null ? null : oneOf(OUTCOMES, o.outcome, `${path}.outcome`);
  if (rule.outcomes === null ? outcome !== null : outcome === null || !rule.outcomes.includes(outcome)) refuse('invalid-value', `${path}.outcome`);
  const optional = (key: 'attempt' | 'operation' | 'releaseId'): string | null =>
    o[key] === undefined ? null : nullableId(o[key], `${path}.${key}`);
  return {
    v: 1, eventId: matches(UUID4, o.eventId, `${path}.eventId`).toLowerCase(), kind, producer,
    producerVersion: matches(VERSION, o.producerVersion, `${path}.producerVersion`),
    pid: int(o.pid, `${path}.pid`, 1, INT32_MAX), at: isoMs(o.at, `${path}.at`),
    sid: nullableId(o.sid, `${path}.sid`), taskId: nullableId(o.taskId, `${path}.taskId`),
    dispatchId: nullableId(o.dispatchId, `${path}.dispatchId`),
    role: o.role === null ? null : matches(ROLE, o.role, `${path}.role`), outcome,
    errorClass: o.errorClass === null ? null : oneOf(ERROR_CLASSES, o.errorClass, `${path}.errorClass`),
    count: o.count === null ? null : int(o.count, `${path}.count`, 0, 1_000_000),
    usageSource: oneOf(['unknown'] as const, o.usageSource, `${path}.usageSource`),
    auth: oneOf(['not-established'] as const, o.auth, `${path}.auth`),
    attempt: optional('attempt'), operation: optional('operation'), releaseId: optional('releaseId'),
  };
}
/** Validate one decoded spool object. Unknown keys are refused before any typed value is built. */
export function validateEventV1(input: unknown): EfficiencyResult<AdvisorEventV1> {
  return attempt(() => checkEvent(input, '$'));
}

/** Legacy verify-escalations.jsonl: ONLY sid, ts, rc survive; `detail` is accepted and dropped unread. */
export interface EscalationFieldsV1 { sid: string; ts: string; rc: number }
export function validateEscalationV1(input: unknown): EfficiencyResult<EscalationFieldsV1> {
  return attempt(() => {
    const o = plain(input, '$');
    exact(o, ['sid', 'ts', 'rc'], '$', ['detail']);
    return { sid: id(o.sid, '$.sid'), ts: utc(o.ts, '$.ts'), rc: int(o.rc, '$.rc', -INT32_MAX - 1, INT32_MAX) };
  });
}

// ---------------------------------------------------------------------------
// Collected records (collector output = analysis input). Provenance is never established here.
export interface RecordBaseV1 {
  recordId: string; sourceId: string; sourceKind: SourceKind; generation: number;
  /** Byte offset of the line start within its generation (location identity only). */
  lineStart: number; observedAt: string; provenance: 'not-established';
}
export interface EventRecordV1 extends RecordBaseV1 {
  type: 'event'; sourceKind: 'advisor-spool-v1'; timeBasis: 'producer-clock'; late: boolean; event: AdvisorEventV1;
}
export interface EscalationRecordV1 extends RecordBaseV1 {
  type: 'escalation'; sourceKind: 'verify-escalations-v1'; timeBasis: 'producer-clock'; late: boolean;
  /** Same whitelisted fields as a recent record; excluded from repeat counts (copy-truncate safety). */
  possibleDuplicate: boolean; sid: string; ts: string; rc: number;
}
/** Same eventId, different normalized body. The first body is kept; analysis excludes the id. */
export interface ConflictRecordV1 extends RecordBaseV1 { type: 'event-id-conflict'; sourceKind: 'advisor-spool-v1'; eventId: string }
export type CollectedRecordV1 = EventRecordV1 | EscalationRecordV1 | ConflictRecordV1;

const BASE_FIELDS = ['type', 'recordId', 'sourceId', 'sourceKind', 'generation', 'lineStart', 'observedAt', 'provenance'];
function checkRecord(value: unknown, path: string): CollectedRecordV1 {
  const o = plain(value, path);
  const type = oneOf(['event', 'escalation', 'event-id-conflict'] as const, o.type, `${path}.type`);
  const base = {
    recordId: type === 'event' ? matches(UUID4, o.recordId, `${path}.recordId`).toLowerCase() : digest(o.recordId, `${path}.recordId`),
    sourceId: id(o.sourceId, `${path}.sourceId`), generation: int(o.generation, `${path}.generation`),
    lineStart: int(o.lineStart, `${path}.lineStart`), observedAt: isoMs(o.observedAt, `${path}.observedAt`),
    provenance: oneOf(['not-established'] as const, o.provenance, `${path}.provenance`),
  };
  if (type === 'event') {
    exact(o, [...BASE_FIELDS, 'timeBasis', 'late', 'event'], path);
    const event = checkEvent(o.event, `${path}.event`);
    if (event.eventId !== base.recordId) refuse('invalid-value', `${path}.recordId`);
    return { type, ...base, sourceKind: oneOf(['advisor-spool-v1'] as const, o.sourceKind, `${path}.sourceKind`),
      timeBasis: oneOf(['producer-clock'] as const, o.timeBasis, `${path}.timeBasis`), late: bool(o.late, `${path}.late`), event };
  }
  if (type === 'escalation') {
    exact(o, [...BASE_FIELDS, 'timeBasis', 'late', 'possibleDuplicate', 'sid', 'ts', 'rc'], path);
    return { type, ...base, sourceKind: oneOf(['verify-escalations-v1'] as const, o.sourceKind, `${path}.sourceKind`),
      timeBasis: oneOf(['producer-clock'] as const, o.timeBasis, `${path}.timeBasis`), late: bool(o.late, `${path}.late`),
      possibleDuplicate: bool(o.possibleDuplicate, `${path}.possibleDuplicate`), sid: id(o.sid, `${path}.sid`),
      ts: utc(o.ts, `${path}.ts`), rc: int(o.rc, `${path}.rc`, -INT32_MAX - 1, INT32_MAX) };
  }
  exact(o, [...BASE_FIELDS, 'eventId'], path);
  return { type, ...base, sourceKind: oneOf(['advisor-spool-v1'] as const, o.sourceKind, `${path}.sourceKind`),
    eventId: matches(UUID4, o.eventId, `${path}.eventId`).toLowerCase() };
}
export function validateCollectedRecordV1(input: unknown): EfficiencyResult<CollectedRecordV1> {
  return attempt(() => checkRecord(input, '$'));
}
/** Producer-clock epoch ms of a record, or null for conflict markers. */
export function recordTimeMs(record: CollectedRecordV1): number | null {
  if (record.type === 'event') return parseIsoMs(record.event.at);
  if (record.type === 'escalation') return parseUtc(record.ts);
  return null;
}

// ---------------------------------------------------------------------------
// Collector config (deterministic byte/record limits; not wall-clock claims)
export interface CollectorConfigV1 {
  schemaVersion: 1;
  maxLineBytes: number; maxChunkBytes: number; maxWindowBytes: number; maxWindowRecords: number;
  dedupCapacity: number; recentEscalationCapacity: number; maxGapsRetained: number;
  futureSkewMs: number; lateToleranceMs: number; maxChunksPerWindow: number;
}
/** Conservative defaults = CONTRACT-final §4 hypotheses (unmeasured). */
export const DEFAULT_COLLECTOR_CONFIG: Readonly<CollectorConfigV1> = Object.freeze({
  schemaVersion: 1, maxLineBytes: 8 * 1024, maxChunkBytes: 256 * 1024, maxWindowBytes: 256 * 1024,
  maxWindowRecords: 2_000, dedupCapacity: 20_000, recentEscalationCapacity: 1_000, maxGapsRetained: 512,
  futureSkewMs: 5 * 60_000, lateToleranceMs: 15 * 60_000, maxChunksPerWindow: 4_096,
});
const COLLECTOR_CEILINGS: Readonly<Record<Exclude<keyof CollectorConfigV1, 'schemaVersion'>, number>> = Object.freeze({
  maxLineBytes: 64 * 1024, maxChunkBytes: 1024 * 1024, maxWindowBytes: 1024 * 1024, maxWindowRecords: 20_000,
  dedupCapacity: 100_000, recentEscalationCapacity: 10_000, maxGapsRetained: 4_096,
  futureSkewMs: 3_600_000, lateToleranceMs: 86_400_000, maxChunksPerWindow: 65_536,
});
export function validateCollectorConfigV1(input: unknown): EfficiencyResult<CollectorConfigV1> {
  return attempt(() => {
    if (input === undefined) return { ...DEFAULT_COLLECTOR_CONFIG };
    const o = plain(input, '$');
    if (o.schemaVersion !== 1) refuse('unknown-version', '$.schemaVersion');
    const keys = Object.keys(COLLECTOR_CEILINGS) as (keyof typeof COLLECTOR_CEILINGS)[];
    exact(o, ['schemaVersion', ...keys], '$');
    const out = { schemaVersion: 1 } as CollectorConfigV1;
    for (const key of keys) out[key] = int(o[key], `$.${key}`, 1, COLLECTOR_CEILINGS[key]);
    if (out.maxLineBytes > out.maxWindowBytes) refuse('invalid-value', '$.maxLineBytes');
    return out;
  });
}

// ---------------------------------------------------------------------------
// Analysis request (explicit owner, grants, fixed clock, budgets)
export interface EfficiencyConfigV1 {
  schemaVersion: 1;
  minSamples: number;
  /** Operator-configured thresholds; null disables the detector (no invented baseline). */
  errorRepeatThreshold: number | null; roundsThreshold: number | null; handoffLatencyThresholdMs: number | null;
  maxRecords: number; maxOperations: number; maxGroups: number; maxProposalsPerRule: number;
}
/** Hypothesis defaults (CONTRACT-final §6/§4, r2 §I "at most 3 pending per rule"); unmeasured. */
export const DEFAULT_EFFICIENCY_CONFIG: Readonly<EfficiencyConfigV1> = Object.freeze({
  schemaVersion: 1, minSamples: 5, errorRepeatThreshold: 5, roundsThreshold: 3, handoffLatencyThresholdMs: null,
  maxRecords: 20_000, maxOperations: 2_000_000, maxGroups: 4_096, maxProposalsPerRule: 3,
});
export const HARD_MAX_RECORDS = 100_000;
export function validateEfficiencyConfigV1(input: unknown): EfficiencyResult<EfficiencyConfigV1> {
  return attempt(() => checkConfig(input, '$'));
}
function checkConfig(input: unknown, path: string): EfficiencyConfigV1 {
  if (input === undefined) return { ...DEFAULT_EFFICIENCY_CONFIG };
  const o = plain(input, path);
  if (o.schemaVersion !== 1) refuse('unknown-version', `${path}.schemaVersion`);
  exact(o, Object.keys(DEFAULT_EFFICIENCY_CONFIG), path);
  const threshold = (key: string, max: number): number | null => o[key] === null ? null : int(o[key], `${path}.${key}`, 1, max);
  return {
    schemaVersion: 1, minSamples: int(o.minSamples, `${path}.minSamples`, 1, 100_000),
    errorRepeatThreshold: threshold('errorRepeatThreshold', 100_000), roundsThreshold: threshold('roundsThreshold', 10_000),
    handoffLatencyThresholdMs: threshold('handoffLatencyThresholdMs', 7 * 86_400_000),
    maxRecords: int(o.maxRecords, `${path}.maxRecords`, 1, HARD_MAX_RECORDS),
    maxOperations: int(o.maxOperations, `${path}.maxOperations`, 1, 50_000_000),
    maxGroups: int(o.maxGroups, `${path}.maxGroups`, 1, 65_536),
    maxProposalsPerRule: int(o.maxProposalsPerRule, `${path}.maxProposalsPerRule`, 1, 3),
  };
}

export type GrantMode = 'subjects' | 'whole-workspace-diagnostic';
/** Explicit subject grant. `subjects` filters counts AND listed identities; only
 * `whole-workspace-diagnostic` sees system aggregates and the unattributed bucket. */
export interface EfficiencyGrantV1 { mode: GrantMode; taskIds: string[]; sids: string[]; releaseIds: string[] }
export interface SourceCoverageV1 {
  sourceId: string; sourceKind: SourceKind; available: boolean; coverage: Coverage;
  /** Supplied collection span; a window outside it is a gap (never synthesized). */
  coveredFrom: string | null; coveredTo: string | null;
}
export type ProposalScope = 'task' | 'session' | 'release' | 'system';
export type RuleId = 'repeated-error-class-v1' | 'repeated-rounds-v1' | 'handoff-latency-v1';
export const RULE_IDS: readonly RuleId[] = ['repeated-error-class-v1', 'repeated-rounds-v1', 'handoff-latency-v1'];
/** Supplied suppression/prior evidence (persistence is not this slice). */
export interface PriorConditionV1 {
  semanticKey: string; rule: RuleId; scope: ProposalScope; scopeId: string | null; conditionKey: string;
  decision: 'open' | 'rejected' | 'deferred'; evidenceDigest: string; deferredUntil: string | null;
}
export interface EfficiencyAnalysisRequestV1 {
  schemaVersion: 1;
  analysis: { ownerTaskId: string; releaseId: string };
  grant: EfficiencyGrantV1;
  now: string; window: { from: string; to: string };
  sources: SourceCoverageV1[]; records: CollectedRecordV1[]; priorConditions: PriorConditionV1[];
  config: EfficiencyConfigV1;
}
const CONDITION = /^[a-z][a-z0-9-]{0,47}(?:\/[a-z][a-z0-9-]{0,31})?$/;
const MAX_WINDOW_MS = 14 * 86_400_000;

export function validateAnalysisRequestV1(input: unknown): EfficiencyResult<EfficiencyAnalysisRequestV1> {
  return attempt(() => {
    const o = plain(input, '$');
    if (o.schemaVersion !== 1) refuse('unknown-version', '$.schemaVersion');
    exact(o, ['schemaVersion', 'analysis', 'grant', 'now', 'window', 'sources', 'records', 'priorConditions', 'config'], '$');
    const a = plain(o.analysis, '$.analysis'); exact(a, ['ownerTaskId', 'releaseId'], '$.analysis');
    const g = plain(o.grant, '$.grant'); exact(g, ['mode', 'taskIds', 'sids', 'releaseIds'], '$.grant');
    const grant: EfficiencyGrantV1 = { mode: oneOf(['subjects', 'whole-workspace-diagnostic'] as const, g.mode, '$.grant.mode'),
      taskIds: uniqueIds(g.taskIds, '$.grant.taskIds', 2_000), sids: uniqueIds(g.sids, '$.grant.sids', 2_000),
      releaseIds: uniqueIds(g.releaseIds, '$.grant.releaseIds', 256) };
    if (grant.mode === 'subjects' && grant.taskIds.length + grant.sids.length + grant.releaseIds.length === 0) refuse('grant-invalid', '$.grant');
    const now = utc(o.now, '$.now');
    const w = plain(o.window, '$.window'); exact(w, ['from', 'to'], '$.window');
    const from = utc(w.from, '$.window.from'), to = utc(w.to, '$.window.to');
    const span = parseUtc(to)! - parseUtc(from)!;
    if (span <= 0 || span > MAX_WINDOW_MS) refuse('invalid-value', '$.window');
    const sources = list(o.sources, '$.sources', 256, (item, path) => {
      const s = plain(item, path); exact(s, ['sourceId', 'sourceKind', 'available', 'coverage', 'coveredFrom', 'coveredTo'], path);
      const out: SourceCoverageV1 = { sourceId: id(s.sourceId, `${path}.sourceId`), sourceKind: oneOf(SOURCE_KINDS, s.sourceKind, `${path}.sourceKind`),
        available: bool(s.available, `${path}.available`), coverage: oneOf(COVERAGES, s.coverage, `${path}.coverage`),
        coveredFrom: s.coveredFrom === null ? null : utc(s.coveredFrom, `${path}.coveredFrom`),
        coveredTo: s.coveredTo === null ? null : utc(s.coveredTo, `${path}.coveredTo`) };
      if ((out.coveredFrom === null) !== (out.coveredTo === null)) refuse('invalid-value', `${path}.coveredTo`);
      if (out.coveredFrom !== null && parseUtc(out.coveredFrom)! > parseUtc(out.coveredTo)!) refuse('invalid-value', `${path}.coveredTo`);
      if (!out.available && (out.coverage !== 'unknown' || out.coveredFrom !== null)) refuse('invalid-value', `${path}.coverage`);
      return out;
    });
    if (new Set(sources.map(s => s.sourceId)).size !== sources.length) refuse('duplicate-id', '$.sources');
    const records = list(o.records, '$.records', HARD_MAX_RECORDS, checkRecord);
    const priorConditions = list(o.priorConditions, '$.priorConditions', 10_000, (item, path) => {
      const p = plain(item, path);
      exact(p, ['semanticKey', 'rule', 'scope', 'scopeId', 'conditionKey', 'decision', 'evidenceDigest', 'deferredUntil'], path);
      const out: PriorConditionV1 = { semanticKey: digest(p.semanticKey, `${path}.semanticKey`), rule: oneOf(RULE_IDS, p.rule, `${path}.rule`),
        scope: oneOf(['task', 'session', 'release', 'system'] as const, p.scope, `${path}.scope`), scopeId: nullableId(p.scopeId, `${path}.scopeId`),
        conditionKey: matches(CONDITION, p.conditionKey, `${path}.conditionKey`),
        decision: oneOf(['open', 'rejected', 'deferred'] as const, p.decision, `${path}.decision`),
        evidenceDigest: digest(p.evidenceDigest, `${path}.evidenceDigest`),
        deferredUntil: p.deferredUntil === null ? null : utc(p.deferredUntil, `${path}.deferredUntil`) };
      if ((out.decision === 'deferred') !== (out.deferredUntil !== null)) refuse('invalid-value', `${path}.deferredUntil`);
      if ((out.scope === 'system') !== (out.scopeId === null)) refuse('invalid-value', `${path}.scopeId`);
      return out;
    });
    if (new Set(priorConditions.map(p => p.semanticKey)).size !== priorConditions.length) refuse('duplicate-id', '$.priorConditions');
    return { schemaVersion: 1, analysis: { ownerTaskId: id(a.ownerTaskId, '$.analysis.ownerTaskId'), releaseId: id(a.releaseId, '$.analysis.releaseId') },
      grant, now, window: { from, to }, sources, records, priorConditions, config: checkConfig(o.config, '$.config') };
  });
}

// ---------------------------------------------------------------------------
// Output (closed by construction; validateEfficiencyProposalV1 re-checks invariants)
export type MetricName = 'record-count' | 'error-class-repeats' | 'dispatch-rounds'
  | 'handoff-latency-start-ack' | 'handoff-latency-ack-started-check' | 'report-latency-ack-report';
export type MetricScope = ProposalScope | 'unattributed';
export type AttributionReason = 'explicit-task' | 'exact-dispatch-binding' | 'session' | 'release' | 'system-aggregate'
  | 'no-task' | 'ambiguous-attempt' | 'exact-binding-unavailable';
export interface DistributionV1 { p50: number; p90: number; max: number }
export interface MetricV1 {
  schema: 'efficiency-metric-v1'; metric: MetricName; scope: MetricScope; scopeId: string | null;
  conditionKey: string | null; window: { from: string; to: string }; currentness: 'closed-window' | 'open-window';
  status: 'observed' | 'insufficient-data' | 'source-unavailable'; coverage: Coverage;
  /** observed = exact count (unit count) or the distribution p90 in ms (unit ms; `samples` holds the count);
   * null when unknown (never zero-filled). */
  observed: number | null; estimated: null; unknown: number; samples: number; unit: 'count' | 'ms';
  distribution: DistributionV1 | null; basis: 'observed-count' | 'producer-clock-interval' | 'work-duration';
  attributionReason: AttributionReason; sources: SourceKind[]; sourceVersions: string[];
}
export type UnsupportedMetric = 'auth-expiry-repeats' | 'tool-call-timing' | 'redundant-tool-reads' | 'cpu-per-worker'
  | 'token-cost' | 'dependency-graph' | 'serial-wait-waste' | 'causality';
export interface UnsupportedMetricV1 { metric: UnsupportedMetric; status: 'source-unavailable'; observed: null; reason: 'no-event-source' }
export type ActionId = 'review-error-class-health' | 'review-repeated-rounds' | 'review-handoff-latency';
export interface EfficiencyProposalV1 {
  schemaVersion: 1; adapter: 'efficiency-proposal-v1'; claimClass: 'review-opportunity';
  id: string; semanticKey: string; evidenceDigest: string; reopenedFrom: string | null; status: 'open' | 'reopened';
  ownerTaskId: string; releaseId: string;
  subjects: { scope: ProposalScope; scopeId: string | null; taskIds: string[]; sids: string[] };
  rule: RuleId; ruleVersion: 1; conditionKey: string;
  evidenceWindow: { from: string; to: string };
  evidence: { observed: number; samples: number; threshold: number; minSamples: number; unit: 'count' | 'ms';
    distribution: DistributionV1 | null; coverage: 'complete'; sources: SourceKind[]; sourceVersions: string[] };
  confidence: 'low'; uncertainty: string;
  action: { id: ActionId; text: string; reversible: true; changesPermissions: false };
  risk: string; analysisCost: 'unknown'; measuredSavings: null; benefit: { magnitude: 'unknown'; estimate: null };
  authority: { producerAuth: 'not-established'; executionAuthorized: false; dispatchAuthorized: false;
    admissionAuthorized: false; loopActivationAuthorized: false; permissionChange: false };
}
export interface SuppressedV1 { semanticKey: string; rule: RuleId; reason: 'rejected-unchanged' | 'deferred-until' }
export interface OutcomeV1 {
  semanticKey: string; rule: RuleId; status: 'condition-present' | 'condition-resolved' | 'insufficient-data';
  adoption: 'unknown'; associationOnly: true;
}
export interface EfficiencyReportV1 {
  schemaVersion: 1; adapter: 'efficiency-report-v1'; ownerTaskId: string; releaseId: string; grantMode: GrantMode;
  generatedAt: string; window: { from: string; to: string }; currentness: 'closed-window' | 'open-window';
  coverage: { overall: Coverage; bySource: { sourceKind: SourceKind; available: boolean; coverage: Coverage }[]; reasons: string[] };
  metrics: MetricV1[]; unsupported: UnsupportedMetricV1[]; proposals: EfficiencyProposalV1[];
  suppressed: SuppressedV1[]; outcomes: OutcomeV1[];
  /** Workspace-wide counters are null under a `subjects` grant so a task view learns nothing else. */
  counts: { recordsSupplied: number | null; recordsVisible: number; recordsTruncated: number | null; lateExcluded: number | null;
    conflictsExcluded: number | null; possibleDuplicatesExcluded: number; undeclaredSource: number | null; ambiguousBindings: number;
    clockAnomalies: number; unattributed: number | null; nonSubjectTasks: number | null; groupsOverflow: number;
    proposalsOverflow: number; priorIgnored: number; operations: number | null };
  authority: 'none'; provenance: 'not-established';
}

/** Fixed action texts (constants, never generated from input). */
export const ACTIONS: Readonly<Record<RuleId, { id: ActionId; text: string; risk: string }>> = Object.freeze({
  'repeated-error-class-v1': { id: 'review-error-class-health',
    text: 'Controller may review the health behind this repeated error class for the listed scope.',
    risk: 'Repeats are observed counts from unauthenticated local producers; cause and benefit are unknown.' },
  'repeated-rounds-v1': { id: 'review-repeated-rounds',
    text: 'Controller may review why this task needed repeated dispatch rounds for the same role; independent validation stays in place.',
    risk: 'Repeated rounds can be correct work; this is not a waste claim and never suggests removing review.' },
  'handoff-latency-v1': { id: 'review-handoff-latency',
    text: 'Controller may review handoff latency above the operator-configured threshold.',
    risk: 'Latency uses producer clocks on exact bindings only; the threshold is operator-set, not a measured baseline.' },
});
export const UNCERTAINTY = 'Benefit magnitude unknown; producer provenance not established; no causality claimed.';

export function validateEfficiencyProposalV1(input: EfficiencyProposalV1): EfficiencyResult<EfficiencyProposalV1> {
  return attempt(() => {
    const p = input;
    const action = ACTIONS[oneOf(RULE_IDS, p.rule, '$.rule')];
    if (p.schemaVersion !== 1 || p.adapter !== 'efficiency-proposal-v1' || p.claimClass !== 'review-opportunity') refuse('invalid-value', '$');
    digest(p.id, '$.id'); digest(p.semanticKey, '$.semanticKey'); digest(p.evidenceDigest, '$.evidenceDigest');
    if (p.reopenedFrom !== null) digest(p.reopenedFrom, '$.reopenedFrom');
    if (p.measuredSavings !== null || p.benefit.estimate !== null || p.benefit.magnitude !== 'unknown' || p.analysisCost !== 'unknown') refuse('invalid-value', '$.benefit');
    const auth = p.authority;
    if (auth.producerAuth !== 'not-established' || auth.executionAuthorized || auth.dispatchAuthorized || auth.admissionAuthorized
      || auth.loopActivationAuthorized || auth.permissionChange) refuse('invalid-value', '$.authority');
    if (p.action.id !== action.id || p.action.text !== action.text || p.risk !== action.risk || p.action.changesPermissions
      || !p.action.reversible || p.uncertainty !== UNCERTAINTY) refuse('invalid-value', '$.action');
    if (p.evidence.coverage !== 'complete' || p.evidence.samples < p.evidence.minSamples || p.evidence.observed < p.evidence.threshold) refuse('invalid-value', '$.evidence');
    if (p.id !== metadataId(['efficiency-proposal-v1', p.semanticKey, p.evidenceDigest])) refuse('invalid-value', '$.id');
    return p;
  });
}
