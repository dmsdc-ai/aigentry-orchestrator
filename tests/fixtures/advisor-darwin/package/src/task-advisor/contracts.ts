import { createHash } from 'node:crypto';

/** Pure, structural contracts. Validation never authenticates an actor or receipt.
 * Limits are provisional validation bounds, not measured production capacity.
 * Only undefined denotes absent storage/config; null is malformed input.
 */
export const LIMITS = Object.freeze({
  inputBytes: 2 * 1024 * 1024, tasks: 10_000, cpuWallMs: 1_000,
  runsPerUtcDay: 60, proposalsPerRun: 3, storeBytes: 8 * 1024 * 1024,
  minIntervalMs: 60_000, text: 16_384, shortText: 256,
  list: 10_000, depth: 16, nodes: 500_000,
  evidenceTtlMs: 86_400_000, maxEvidenceTtlMs: 7 * 86_400_000,
  maxDeferMs: 30 * 86_400_000,
});

export type RefusalCode = 'invalid-shape' | 'unknown-field' | 'unknown-version'
  | 'invalid-value' | 'input-limit' | 'duplicate-id' | 'missing-reference'
  | 'workspace-mismatch' | 'analysis-binding-unresolved';
export interface Refusal { code: RefusalCode; path: string; message: string }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: Refusal };
export interface ValidationContext {
  workspaceId: string;
  now: string;
  /** Optional complete reference set. This is not an analysis authorization. */
  taskIds?: readonly string[];
}

type Check<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Check<unknown>>;
type Checked<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
class Invalid extends Error {
  constructor(readonly reason: Refusal) { super(reason.message); }
}
function refuse(code: RefusalCode, path: string, message: string): never {
  throw new Invalid({ code, path, message });
}
function object<S extends Shape>(shape: S): Check<Checked<S>> {
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return refuse('invalid-shape', path, 'Expected an object');
    }
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) {
        refuse('unknown-field', `${path}.${key}`, 'Unexpected field');
      }
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) output[key] = shape[key](input[key], `${path}.${key}`);
    return output as Checked<S>;
  };
}
function string(max: number = LIMITS.text): Check<string> {
  return (value, path) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return refuse('invalid-value', path, 'Expected nonempty text');
    }
    if (value.length > max) refuse('input-limit', path, 'Text exceeds validation bound');
    return value;
  };
}
function pattern(expression: RegExp, description: string): Check<string> {
  return (value, path) => {
    const result = string(LIMITS.shortText)(value, path);
    if (!expression.test(result)) refuse('invalid-value', path, description);
    return result;
  };
}
const digest = pattern(/^[a-f0-9]{64}$/, 'Expected lowercase SHA-256');
const uuid = pattern(/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-8][a-fA-F0-9]{3}-[89abAB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$/, 'Expected UUID');
const taskId = string(LIMITS.shortText);
function integer(max = Number.MAX_SAFE_INTEGER, min = 0): Check<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      return refuse('invalid-value', path, `Expected safe integer in [${min}, ${max}]`);
    }
    return value;
  };
}
const boolean: Check<boolean> = (value, path) => typeof value === 'boolean'
  ? value : refuse('invalid-value', path, 'Expected boolean');
function oneOf<const T extends readonly (string | number | boolean)[]>(...values: T): Check<T[number]> {
  return (value, path) => values.some(item => item === value)
    ? value as T[number] : refuse('invalid-value', path, 'Unexpected enum value');
}
const version: Check<1> = (value, path) => value === 1 ? 1
  : refuse('unknown-version', path, 'Only schemaVersion 1 is supported');
function nullable<T>(check: Check<T>): Check<T | null> {
  return (value, path) => value === null ? null : check(value, path);
}
function list<T>(check: Check<T>, max: number = LIMITS.list): Check<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return refuse('invalid-shape', path, 'Expected array');
    if (value.length > max) refuse('input-limit', path, 'List exceeds validation bound');
    return value.map((item, index) => check(item, `${path}[${index}]`));
  };
}
function unique<T>(items: readonly T[], key: (item: T) => string, path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) refuse('duplicate-id', path, 'Duplicate identifier');
    seen.add(id);
  }
}
const taskIds: Check<string[]> = (value, path) => {
  const ids = list(taskId)(value, path);
  unique(ids, id => id, path);
  return ids;
};
const utcDay: Check<string> = (value, path) => {
  const result = pattern(/^\d{4}-\d{2}-\d{2}$/, 'Expected UTC calendar day')(value, path);
  const time = Date.parse(`${result}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== result) {
    refuse('invalid-value', path, 'Invalid calendar day');
  }
  return result;
};
const timestamp: Check<string> = (value, path) => {
  const result = pattern(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|\+00:00)$/, 'Expected UTC RFC3339 timestamp')(value, path);
  utcDay(result.slice(0, 10), path);
  if (!Number.isFinite(Date.parse(result))) refuse('invalid-value', path, 'Invalid timestamp');
  return result;
};

const configCheck = object({
  enabled: boolean, origin: oneOf('default', 'user'), revision: integer(),
  minIntervalMs: integer(), maxInputBytes: integer(), maxTasks: integer(LIMITS.tasks),
  maxRunsPerUtcDay: integer(LIMITS.runsPerUtcDay), maxCpuWallMs: integer(LIMITS.cpuWallMs),
  maxProposalsPerRun: integer(LIMITS.proposalsPerRun), maxStoreBytes: integer(LIMITS.storeBytes),
});
export type AdvisorConfig = ReturnType<typeof configCheck>;
export function createDefaultConfig(): AdvisorConfig {
  return {
    enabled: true, origin: 'default', revision: 0, minIntervalMs: LIMITS.minIntervalMs,
    maxInputBytes: LIMITS.inputBytes, maxTasks: LIMITS.tasks,
    maxRunsPerUtcDay: LIMITS.runsPerUtcDay, maxCpuWallMs: LIMITS.cpuWallMs,
    maxProposalsPerRun: LIMITS.proposalsPerRun, maxStoreBytes: LIMITS.storeBytes,
  };
}
function config(value: unknown, path: string): AdvisorConfig {
  const result = configCheck(value, path);
  if (result.minIntervalMs !== 0 && result.minIntervalMs < LIMITS.minIntervalMs) {
    refuse('invalid-value', `${path}.minIntervalMs`, 'Interval must be zero or at least 60000 ms');
  }
  if (result.origin === 'default' && !result.enabled) {
    refuse('invalid-value', `${path}.origin`, 'Disabled preference requires user origin');
  }
  return result;
}
const scopeCheck = object({ taskIds, paths: list(string(4_096)) });
export type ProposalScope = ReturnType<typeof scopeCheck>;
const evidenceCheck = object({
  source: oneOf('task-queue'), locator: string(), digest, observedAt: timestamp, fact: string(),
});
export type Evidence = ReturnType<typeof evidenceCheck>;
const assessment = object({ summary: string(), basis: string() });
const proposalCheck = object({
  id: uuid, schemaVersion: version, revision: integer(), workspaceId: digest,
  ownerTaskId: taskId, relatedTaskIds: taskIds, kind: oneOf('prioritize-existing-task'),
  title: string(), recommendation: string(), scope: scopeCheck,
  createdAt: timestamp, expiresAt: timestamp,
  state: oneOf('pending', 'deferred', 'rejected', 'stale', 'admitted'),
  dedupKey: digest, evidenceDigest: digest,
  provenance: object({
    producer: oneOf('task-advisor'), packageVersion: string(LIMITS.shortText),
    sourceRevision: nullable(string(LIMITS.shortText)), algorithmVersion: oneOf('local-ranking-v1'),
    runId: uuid, trigger: oneOf('manual', 'reconcile'), observedAt: timestamp, queueDigest: digest,
    coverage: object({ totalTasks: integer(LIMITS.tasks), consideredTasks: integer(LIMITS.tasks), complete: boolean }),
    evidence: list(evidenceCheck),
  }),
  benefit: assessment, risk: assessment,
  cost: object({ summary: string(), basis: string(),
    analysis: object({ localOnly: oneOf(true), chargedRun: oneOf(1) }),
    execution: object({ estimate: nullable(string()), uncertainty: string() }),
  }),
  currentness: object({ status: oneOf('current', 'stale', 'unknown'), checkedAt: timestamp, reason: string() }),
  admissionBoundary: object({ requires: oneOf('explicit-human-admission'), requestDigest: digest,
    executionAuthorized: oneOf(false), loopActivationAuthorized: oneOf(false) }),
  disposition: nullable(object({ decisionId: uuid, reason: string(), deferredUntil: nullable(timestamp) })),
});
export type Proposal = ReturnType<typeof proposalCheck>;
const decisionCheck = object({
  id: uuid, proposalId: uuid, proposalRevision: integer(), requestId: uuid,
  kind: oneOf('reject', 'defer'), reason: string(), until: nullable(timestamp),
  actor: object({ id: string(LIMITS.shortText), verified: boolean }), at: timestamp,
});
/** actor.verified is stored data, never proof of human authority. */
export type Decision = ReturnType<typeof decisionCheck>;
const receiptCheck = object({
  id: uuid, requestId: uuid, proposalId: uuid, proposalRevision: integer(),
  requestDigest: digest, taskId, authorityRef: string(), committedAt: timestamp,
});
/** Structural receipt only. An independent trusted adapter must verify authority. */
export type Receipt = ReturnType<typeof receiptCheck>;
const storeCheck = object({
  schemaVersion: version, workspaceId: digest, revision: integer(), config,
  budget: object({ utcDay, chargedRuns: integer(), lastStartedAt: nullable(timestamp) }),
  run: nullable(object({ id: uuid, ownerPid: integer(Number.MAX_SAFE_INTEGER, 1), startedAt: timestamp,
    configRevision: integer(), snapshotDigest: digest, status: oneOf('reserved') })),
  observations: object({ lastSnapshotDigest: nullable(digest), lastSuccessfulAt: nullable(timestamp),
    lastOutcome: string(LIMITS.shortText), retryAfter: nullable(timestamp) }),
  proposals: list(proposalCheck), decisions: list(decisionCheck), admissionReceipts: list(receiptCheck),
});
export type AdvisorStore = ReturnType<typeof storeCheck>;

/** Check JSON bounds before schema traversal/stringification. Returned values are detached. */
function boundedJson(value: unknown, maxBytes: number): number {
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) refuse('input-limit', '$', 'JSON structure exceeds bound');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item === 'string') {
      if (item.length > LIMITS.text) refuse('input-limit', '$', 'Text exceeds validation bound');
      return;
    }
    if (typeof item !== 'object') refuse('invalid-shape', '$', 'Expected parsed JSON');
    if (Array.isArray(item)) {
      if (item.length > LIMITS.list) refuse('input-limit', '$', 'List exceeds validation bound');
      for (const child of item) visit(child, depth + 1);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        refuse('invalid-shape', '$', 'Expected plain JSON object');
      }
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length > LIMITS.list) refuse('input-limit', '$', 'Object exceeds validation bound');
      for (const [key, child] of entries) { visit(key, depth + 1); visit(child, depth + 1); }
    }
  }
  visit(value, 0);
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > maxBytes) refuse('input-limit', '$', 'Serialized JSON exceeds byte ceiling');
  }
  return bytes;
}
function result<T>(operation: () => T): ValidationResult<T> {
  try { return { ok: true, value: operation() }; }
  catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.reason };
    return { ok: false, reason: { code: 'invalid-shape', path: '$', message: 'Unreadable parsed JSON input' } };
  }
}
function context(input: ValidationContext): ValidationContext {
  digest(input.workspaceId, '$context.workspaceId');
  timestamp(input.now, '$context.now');
  if (input.taskIds !== undefined) taskIds(input.taskIds, '$context.taskIds');
  return input;
}
function workspace(value: string, binding: ValidationContext, path: string): void {
  if (value !== binding.workspaceId) refuse('workspace-mismatch', path, 'Workspace identity differs');
}
function references(ids: readonly string[], binding: ValidationContext, path: string): void {
  if (binding.taskIds === undefined) return;
  const known = new Set(binding.taskIds);
  if (ids.some(id => !known.has(id))) refuse('missing-reference', path, 'Task reference is absent');
}
function proposal(value: Proposal, binding: ValidationContext, path: string): Proposal {
  workspace(value.workspaceId, binding, `${path}.workspaceId`);
  references([value.ownerTaskId, ...value.relatedTaskIds, ...value.scope.taskIds], binding, path);
  unique(value.scope.paths, item => item, `${path}.scope.paths`);
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.createdAt);
  if (ttl <= 0 || ttl > LIMITS.maxEvidenceTtlMs) refuse('invalid-value', `${path}.expiresAt`, 'Evidence TTL must be positive and at most seven days');
  const coverage = value.provenance.coverage;
  if (!coverage.complete || coverage.totalTasks !== coverage.consideredTasks || value.scope.taskIds.length === 0
      || value.provenance.evidence.length === 0) {
    refuse('invalid-value', `${path}.provenance`, 'Proposal requires complete coverage, scope and evidence');
  }
  if (Date.parse(value.provenance.observedAt) > Date.parse(value.createdAt)) {
    refuse('invalid-value', `${path}.provenance.observedAt`, 'Observation follows creation');
  }
  for (const evidence of value.provenance.evidence) {
    if (evidence.digest !== value.provenance.queueDigest || Date.parse(evidence.observedAt) > Date.parse(value.createdAt)) {
      refuse('invalid-value', `${path}.provenance.evidence`, 'Evidence does not bind the observed snapshot');
    }
  }
  if ((value.state === 'rejected' || value.state === 'deferred') && value.disposition === null) {
    refuse('missing-reference', `${path}.disposition`, 'Disposition required for reviewed state');
  }
  if (value.state === 'pending' && value.disposition !== null) {
    refuse('invalid-value', `${path}.disposition`, 'Pending proposal cannot have a disposition');
  }
  if (value.state === 'deferred' && value.disposition?.deferredUntil === null) {
    refuse('invalid-value', `${path}.disposition`, 'Deferral requires expiry');
  }
  return value;
}
function decision(value: Decision, path: string): Decision {
  if (value.kind === 'reject' && value.until !== null) refuse('invalid-value', `${path}.until`, 'Rejection has no expiry');
  if (value.kind === 'defer') {
    const duration = value.until === null ? 0 : Date.parse(value.until) - Date.parse(value.at);
    if (duration <= 0 || duration > LIMITS.maxDeferMs) refuse('invalid-value', `${path}.until`, 'Deferral must expire within thirty days of decision');
  }
  return value;
}

export function validateConfig(input: unknown): ValidationResult<AdvisorConfig> {
  return result(() => {
    if (input === undefined) return createDefaultConfig();
    boundedJson(input, LIMITS.storeBytes);
    return config(input, '$');
  });
}
export function validateProposal(input: unknown, binding: ValidationContext): ValidationResult<Proposal> {
  return result(() => { boundedJson(input, LIMITS.storeBytes); return proposal(proposalCheck(input, '$'), context(binding), '$'); });
}
export function validateDecision(input: unknown, binding: ValidationContext): ValidationResult<Decision> {
  return result(() => { context(binding); boundedJson(input, LIMITS.storeBytes); return decision(decisionCheck(input, '$'), '$'); });
}
export function validateReceipt(input: unknown, binding: ValidationContext): ValidationResult<Receipt> {
  return result(() => {
    context(binding); boundedJson(input, LIMITS.storeBytes);
    const value = receiptCheck(input, '$');
    references([value.taskId], binding, '$.taskId');
    return value;
  });
}
export function createDefaultStore(binding: ValidationContext): ValidationResult<AdvisorStore> {
  return result(() => {
    context(binding);
    return { schemaVersion: 1, workspaceId: binding.workspaceId, revision: 0, config: createDefaultConfig(),
      budget: { utcDay: binding.now.slice(0, 10), chargedRuns: 0, lastStartedAt: null }, run: null,
      observations: { lastSnapshotDigest: null, lastSuccessfulAt: null, lastOutcome: 'not-run', retryAfter: null },
      proposals: [], decisions: [], admissionReceipts: [] };
  });
}
export function validateStore(input: unknown, binding: ValidationContext): ValidationResult<AdvisorStore> {
  if (input === undefined) return createDefaultStore(binding);
  return result(() => {
    context(binding);
    const bytes = boundedJson(input, LIMITS.storeBytes);
    const value = storeCheck(input, '$');
    workspace(value.workspaceId, binding, '$.workspaceId');
    if (bytes > value.config.maxStoreBytes) refuse('input-limit', '$', 'Store exceeds configured byte ceiling');
    if (value.config.revision > value.revision || (value.run !== null && value.run.configRevision > value.config.revision)) {
      refuse('invalid-value', '$.revision', 'Referenced revision is newer than its container');
    }
    if (value.run !== null && (value.budget.chargedRuns === 0 || value.budget.lastStartedAt !== value.run.startedAt
        || value.budget.utcDay !== value.run.startedAt.slice(0, 10))) {
      refuse('invalid-value', '$.run', 'Reservation must retain its budget charge and start');
    }
    unique(value.proposals, item => item.id.toLowerCase(), '$.proposals');
    unique(value.proposals, item => item.dedupKey, '$.proposals.dedupKey');
    unique(value.decisions, item => item.id.toLowerCase(), '$.decisions');
    unique(value.admissionReceipts, item => item.id.toLowerCase(), '$.admissionReceipts');
    unique([...value.decisions, ...value.admissionReceipts], item => item.requestId.toLowerCase(), '$.requestId');
    const proposals = new Map(value.proposals.map(item => [item.id.toLowerCase(), item]));
    const decisions = new Map(value.decisions.map(item => [item.id.toLowerCase(), item]));
    for (const item of value.decisions) {
      decision(item, '$.decisions');
      const target = proposals.get(item.proposalId.toLowerCase());
      if (!target) refuse('missing-reference', '$.decisions.proposalId', 'Proposal absent');
      if (item.proposalRevision > target.revision) refuse('invalid-value', '$.decisions.proposalRevision', 'Decision references a future revision');
    }
    for (const item of value.admissionReceipts) {
      references([item.taskId], binding, '$.admissionReceipts.taskId');
      const target = proposals.get(item.proposalId.toLowerCase());
      if (!target) refuse('missing-reference', '$.admissionReceipts.proposalId', 'Proposal absent');
      if (target.state !== 'admitted' || item.proposalRevision > target.revision
          || item.requestDigest !== target.admissionBoundary.requestDigest || !target.scope.taskIds.includes(item.taskId)) {
        refuse('invalid-value', '$.admissionReceipts', 'Receipt conflicts with proposal');
      }
    }
    unique(value.admissionReceipts, item => item.proposalId.toLowerCase(), '$.admissionReceipts.proposalId');
    for (const item of value.proposals) {
      proposal(item, binding, '$.proposals');
      if (item.disposition !== null) {
        const review = decisions.get(item.disposition.decisionId.toLowerCase());
        if (!review || review.proposalId.toLowerCase() !== item.id.toLowerCase()) {
          refuse('missing-reference', '$.proposals.disposition', 'Decision absent or belongs to another proposal');
        }
        if (review.reason !== item.disposition.reason || review.until !== item.disposition.deferredUntil
            || (item.state === 'rejected' && review.kind !== 'reject') || (item.state === 'deferred' && review.kind !== 'defer')) {
          refuse('invalid-value', '$.proposals.disposition', 'Disposition conflicts with decision');
        }
      }
      if (item.state === 'admitted' && !value.admissionReceipts.some(receipt => receipt.proposalId.toLowerCase() === item.id.toLowerCase())) {
        refuse('missing-reference', '$.proposals', 'Admitted proposal requires a receipt; structure does not authenticate it');
      }
    }
    return value;
  });
}

/** No reviewed binding/queue schema exists yet. No input can authorize analysis.
 * Do not call store/proposal validation as a substitute for this gate.
 */
export function validateAnalysisInput(
  input: unknown, binding: ValidationContext, analysisBinding: unknown,
): ValidationResult<never> {
  return result(() => {
    context(binding);
    // Intentionally do not interpret labels, booleans or a speculative binding schema.
    void input;
    void analysisBinding;
    return refuse('analysis-binding-unresolved', '$analysisBinding', 'Reviewed analysis scope and budget binding schema is unavailable');
  });
}

// V1 above remains available for read-only historical inspection. V2 values are
// detached structural data, never reservations or authenticated authority.
export class AdvisorError extends Error {
  constructor(readonly reason: string, readonly exit: 2 | 3 | 4 | 5 = 2) { super(reason); }
}
export function requireV2(condition: unknown, reason: string, exit: 2 | 3 | 4 | 5 = 2): asserts condition {
  if (!condition) throw new AdvisorError(reason, exit);
}
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Kind = 'prioritize-existing-task' | 'repair-task-currentness';
export interface InputLimits {
  maxInputBytes: number; maxTasks: number; maxFieldChars: number;
  maxNodes: number; maxDepth: number; maxCpuWallMs: number;
}
/** Provisional source envelope; NOT a measured capacity/durability claim. */
export const BUILD_ENVELOPE: Readonly<InputLimits> = Object.freeze({
  maxInputBytes: LIMITS.inputBytes, maxTasks: LIMITS.tasks, maxFieldChars: LIMITS.text,
  maxNodes: LIMITS.nodes, maxDepth: LIMITS.depth, maxCpuWallMs: LIMITS.cpuWallMs,
});
export interface ConfigV2 extends InputLimits {
  minIntervalMs: number; maxRunsPerUtcDay: number; maxProposalsPerRun: number;
  maxStoreBytes: number; evidenceTtlMs: number;
}
export function defaultConfigV2(): ConfigV2 {
  return { ...BUILD_ENVELOPE, minIntervalMs: LIMITS.minIntervalMs,
    maxRunsPerUtcDay: LIMITS.runsPerUtcDay, maxProposalsPerRun: LIMITS.proposalsPerRun,
    maxStoreBytes: LIMITS.storeBytes, evidenceTtlMs: LIMITS.evidenceTtlMs };
}
export function recordV2(value: unknown): Record<string, unknown> {
  requireV2(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid-object');
  requireV2(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'invalid-object');
  return value as Record<string, unknown>;
}
export function exactKeysV2(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  requireV2(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'unknown-or-missing-field');
}
export function uintV2(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  requireV2(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max, 'invalid-integer');
  return value;
}
export function textV2(value: unknown, max: number = LIMITS.shortText): string {
  requireV2(typeof value === 'string' && value.length > 0 && value.length <= max, 'invalid-text');
  return value;
}
export function uuidV2(value: unknown): string {
  const checked = uuid(value, '$');
  return checked.toLowerCase();
}
export function utcV2(value: unknown): string { return timestamp(value, '$'); }
export function digestV2(value: unknown): string { return digest(value, '$'); }
export function canonicalTaskId(value: unknown): string {
  if (typeof value === 'number') return String(uintV2(value));
  return textV2(value);
}
// The shared session canonicalizer normalizes NFC/newlines. Queue identities must
// preserve those bytes, so use the contract's JSON-only canonicalization here.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireV2(Number.isFinite(value), 'invalid-number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const item = recordV2(value);
  return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(item[key])).join(',') + '}';
}
export function hashBytes(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }
export function hashJson(value: unknown): string { return hashBytes(canonicalJson(value)); }

export interface JsonMetrics { nodes: number; depth: number; maxFieldChars: number; parsedBytes: number }
/** Recursive-descent JSON parser: duplicate decoded keys are rejected at each
 * object, including escaped aliases. JSON.parse is used only on scalar tokens. */
export function parseJsonV2(bytes: Uint8Array, limits: InputLimits = BUILD_ENVELOPE): { value: Json; metrics: JsonMetrics } {
  requireV2(bytes.byteLength <= limits.maxInputBytes, 'input-limit');
  const started = performance.now();
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AdvisorError('invalid-utf8'); }
  let pos = 0;
  const metrics: JsonMetrics = { nodes: 0, depth: 0, maxFieldChars: 0, parsedBytes: 0 };
  const ws = (): void => { while (pos < source.length && ' \t\n\r'.includes(source[pos])) pos++; };
  function count(depth: number): void {
    metrics.nodes++; metrics.depth = Math.max(metrics.depth, depth);
    requireV2(metrics.nodes <= limits.maxNodes && depth <= limits.maxDepth, 'structure-limit');
    if ((metrics.nodes & 127) === 0) requireV2(performance.now() - started <= limits.maxCpuWallMs, 'input-time-limit');
  }
  function stringToken(): string {
    const start = pos++;
    while (pos < source.length) {
      const code = source.charCodeAt(pos++);
      if (code === 34) {
        let value: string;
        try { value = JSON.parse(source.slice(start, pos)) as string; }
        catch { throw new AdvisorError('invalid-json-string'); }
        metrics.maxFieldChars = Math.max(metrics.maxFieldChars, value.length);
        requireV2(value.length <= limits.maxFieldChars, 'field-limit');
        return value;
      }
      if (code === 92) pos++;
      requireV2(code >= 32, 'invalid-json-string');
    }
    throw new AdvisorError('unterminated-json-string');
  }
  function value(depth: number): Json {
    count(depth); ws();
    const token = source[pos];
    if (token === '"') return stringToken();
    if (token === '{') {
      pos++; ws(); const out: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
      const keys = new Set<string>();
      if (source[pos] === '}') { pos++; return out; }
      for (;;) {
        requireV2(source[pos] === '"', 'invalid-json-object'); count(depth + 1);
        const key = stringToken(); requireV2(!keys.has(key), 'duplicate-json-key'); keys.add(key); ws();
        requireV2(source[pos++] === ':', 'invalid-json-object');
        out[key] = value(depth + 1); ws();
        if (source[pos] === '}') { pos++; return out; }
        requireV2(source[pos++] === ',', 'invalid-json-object'); ws();
      }
    }
    if (token === '[') {
      pos++; ws(); const out: Json[] = [];
      if (source[pos] === ']') { pos++; return out; }
      for (;;) {
        out.push(value(depth + 1)); ws();
        if (source[pos] === ']') { pos++; return out; }
        requireV2(source[pos++] === ',', 'invalid-json-array'); ws();
      }
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(literal, pos)) { pos += literal.length; return result; }
    }
    const start = pos;
    if (source[pos] === '-') pos++;
    if (source[pos] === '0') pos++;
    else { requireV2(source[pos] >= '1' && source[pos] <= '9', 'invalid-json-number'); while (source[pos] >= '0' && source[pos] <= '9') pos++; }
    if (source[pos] === '.') {
      pos++; const fraction = pos; while (source[pos] >= '0' && source[pos] <= '9') pos++;
      requireV2(pos > fraction, 'invalid-json-number');
    }
    if (source[pos] === 'e' || source[pos] === 'E') {
      pos++; if (source[pos] === '+' || source[pos] === '-') pos++;
      const exponent = pos; while (source[pos] >= '0' && source[pos] <= '9') pos++;
      requireV2(pos > exponent, 'invalid-json-number');
    }
    const number = Number(source.slice(start, pos)); requireV2(Number.isFinite(number), 'invalid-json-number'); return number;
  }
  const parsed = value(0); ws(); requireV2(pos === source.length, 'trailing-json');
  metrics.parsedBytes = Buffer.byteLength(JSON.stringify(parsed));
  requireV2(metrics.parsedBytes <= limits.maxInputBytes && performance.now() - started <= limits.maxCpuWallMs, 'input-limit');
  return { value: parsed, metrics };
}

export interface TaskRow { [key: string]: Json; id: string | number; status: string; desc: string }
export interface QueueV2 { [key: string]: Json | TaskRow[] | undefined; tasks: TaskRow[]; completed?: TaskRow[] }
export function queueV2(value: unknown, limits: InputLimits = BUILD_ENVELOPE): QueueV2 {
  const root = recordV2(value);
  requireV2(Array.isArray(root.tasks) && (root.completed === undefined || Array.isArray(root.completed)), 'invalid-queue');
  if (root.tracks !== undefined) recordV2(root.tracks);
  const rows = [...root.tasks, ...((root.completed as unknown[] | undefined) ?? [])];
  requireV2(rows.length <= limits.maxTasks, 'task-limit');
  const ids = new Set<string>();
  for (const item of rows) {
    const row = recordV2(item), id = canonicalTaskId(row.id);
    requireV2(!ids.has(id), 'duplicate-task-id'); ids.add(id);
    textV2(row.status, limits.maxFieldChars); textV2(row.desc, limits.maxFieldChars);
    for (const key of ['note', 'track', 'updated_at']) if (row[key] !== undefined) requireV2(typeof row[key] === 'string', 'invalid-task-field');
    for (const key of ['tags', 'paths']) if (row[key] !== undefined) {
      requireV2(Array.isArray(row[key]), 'invalid-task-field');
      for (const entry of row[key] as unknown[]) requireV2(typeof entry === 'string', 'invalid-task-field');
    }
    if (row.blocks !== undefined) { requireV2(Array.isArray(row.blocks), 'invalid-task-blocks'); for (const id of row.blocks) canonicalTaskId(id); }
  }
  for (const item of rows) {
    const row = recordV2(item);
    for (const ref of (row.blocks as unknown[] | undefined) ?? []) requireV2(ids.has(canonicalTaskId(ref)), 'missing-reference');
  }
  return structuredClone(root) as QueueV2;
}
export function validateConfigV2(input: unknown): ConfigV2 {
  const item = recordV2(input), defaults = defaultConfigV2();
  exactKeysV2(item, Object.keys(defaults));
  const out = {} as ConfigV2;
  for (const key of Object.keys(defaults) as (keyof ConfigV2)[]) {
    const max = key === 'minIntervalMs' ? 7 * 86_400_000 : key === 'evidenceTtlMs' ? LIMITS.maxEvidenceTtlMs : defaults[key];
    out[key] = uintV2(item[key], max, key === 'maxRunsPerUtcDay' ? 0 : 1);
  }
  requireV2(out.minIntervalMs >= 60_000 && out.maxStoreBytes >= 1024 * 1024, 'invalid-config');
  return out;
}
const localIdV2: Check<string> = value => textV2(value);
const localIdsV2: Check<string[]> = (value, path) => {
  const ids = list(localIdV2)(value, path); unique(ids, id => id, path); return ids;
};
const bindingV2Check = object({
  schemaVersion: oneOf(2), id: uuid, revision: integer(), workspaceId: digest,
  ownerTaskId: localIdV2,
  scope: object({ mode: oneOf('local-queue-metadata'), queuePath: oneOf('state/task-queue.json'),
    subjectTaskIds: localIdsV2, kinds: list(oneOf('prioritize-existing-task', 'repair-task-currentness'), 2) }),
  scopeDigest: digest, ownership: object({ workspaceId: digest, releaseId: localIdV2 }),
  createdAt: timestamp, notBefore: timestamp, expiresAt: timestamp, revokedAt: nullable(timestamp),
  budget: object({ allocationId: uuid, maxRunsTotal: integer(), maxRunsPerUtcDay: integer(), maxWallMs: integer(LIMITS.cpuWallMs) }),
  provenance: object({ requestId: uuid, payloadDigest: digest, source: oneOf('local-cli'), authentication: oneOf('not-established') }),
});
export type AnalysisBindingV2 = ReturnType<typeof bindingV2Check>;
export function scopeDigestV2(binding: Pick<AnalysisBindingV2, 'ownerTaskId' | 'scope' | 'ownership'>): string {
  return hashJson({ ownerTaskId: binding.ownerTaskId, scope: binding.scope, ownership: binding.ownership });
}
export function validateAnalysisBindingV2(input: unknown): ValidationResult<AnalysisBindingV2> {
  return result(() => {
    boundedJson(input, LIMITS.inputBytes);
    const b = bindingV2Check(input, '$');
    requireV2(b.workspaceId === b.ownership.workspaceId && b.scopeDigest === scopeDigestV2(b), 'binding-scope-mismatch');
    requireV2(b.scope.subjectTaskIds.includes(b.ownerTaskId) && b.scope.subjectTaskIds.length > 0 && b.scope.kinds.length > 0, 'invalid-binding-scope');
    requireV2(JSON.stringify(b.scope.subjectTaskIds) === JSON.stringify([...b.scope.subjectTaskIds].sort()), 'unsorted-subjects');
    unique(b.scope.kinds, item => item, '$.scope.kinds');
    requireV2(Date.parse(b.createdAt) <= Date.parse(b.notBefore) && Date.parse(b.notBefore) < Date.parse(b.expiresAt)
      && Date.parse(b.expiresAt) - Date.parse(b.createdAt) <= LIMITS.maxEvidenceTtlMs, 'invalid-binding-lifetime');
    requireV2(b.revokedAt === null || Date.parse(b.revokedAt) >= Date.parse(b.createdAt), 'invalid-revocation');
    return b;
  });
}
export function checkedBindingV2(input: unknown): AnalysisBindingV2 {
  const checked = validateAnalysisBindingV2(input);
  requireV2(checked.ok, checked.ok ? '' : checked.reason.message); return checked.value;
}
export function ownerEligibility(queue: QueueV2, binding: AnalysisBindingV2): 'eligible' | 'suspended' | 'continuity-break' {
  const owner = queue.tasks.find(row => canonicalTaskId(row.id) === binding.ownerTaskId);
  if (!owner || ['done', 'completed', 'cancelled', 'canceled', 'archived', 'closed'].includes(owner.status)) return 'continuity-break';
  if (!['pending', 'queued', 'in_progress', 'delegated'].includes(owner.status)) return 'suspended';
  return 'eligible';
}
export interface AnalysisInputV2 {
  schemaVersion: 2; queue: QueueV2; queueDigest: string; rawByteCount: number;
  ownerRowDigest: string; binding: AnalysisBindingV2; bindingRevision: number;
  now: string; runId: string;
}
export function validateAnalysisInputV2(input: unknown): ValidationResult<AnalysisInputV2> {
  return result(() => {
    const v = recordV2(input);
    exactKeysV2(v, ['schemaVersion', 'queue', 'queueDigest', 'rawByteCount', 'ownerRowDigest', 'binding', 'bindingRevision', 'now', 'runId']);
    requireV2(v.schemaVersion === 2, 'unknown-version');
    const binding = checkedBindingV2(v.binding);
    // Bounded traversal also applies when callers supply an object rather than bytes.
    const queue = queueV2(parseJsonV2(Buffer.from(JSON.stringify(v.queue))).value);
    requireV2(ownerEligibility(queue, binding) === 'eligible', 'owner-ineligible');
    for (const id of binding.scope.subjectTaskIds) requireV2(queue.tasks.some(row => canonicalTaskId(row.id) === id), 'missing-subject');
    requireV2(v.bindingRevision === binding.revision, 'binding-revision-mismatch');
    const owner = queue.tasks.find(row => canonicalTaskId(row.id) === binding.ownerTaskId)!;
    requireV2(v.ownerRowDigest === hashJson(owner), 'owner-row-mismatch');
    const now = utcV2(v.now);
    requireV2(binding.revokedAt === null && Date.parse(now) >= Date.parse(binding.notBefore) && Date.parse(now) < Date.parse(binding.expiresAt), 'binding-inactive');
    return { schemaVersion: 2, queue, binding, bindingRevision: binding.revision,
      queueDigest: digestV2(v.queueDigest), rawByteCount: uintV2(v.rawByteCount, BUILD_ENVELOPE.maxInputBytes),
      ownerRowDigest: digestV2(v.ownerRowDigest), now, runId: uuidV2(v.runId) };
  });
}

export interface EvidenceV2 {
  source: 'task-queue'; locator: string; digest: string; observedAt: string; fact: string;
  predicate: 'field-absent' | 'field-empty' | 'field-value'; observedValueDigest: string | null;
}
export interface ProposalV2 {
  id: string; schemaVersion: 2; revision: number; workspaceId: string; releaseId: string;
  ownerTaskId: string; relatedTaskIds: string[]; kind: Kind; title: string; recommendation: string;
  scope: { taskIds: string[]; paths: string[] }; createdAt: string; expiresAt: string;
  state: 'pending' | 'deferred' | 'rejected' | 'stale'; dedupKey: string; evidenceDigest: string;
  improvement: { rule: 'missing-updated-at-v1'; targetTaskId: string; field: 'updated_at'; action: 'record-verified-currentness' } | null;
  provenance: { producer: 'task-advisor'; packageVersion: string; sourceRevision: null;
    algorithmVersion: 'local-metadata-v2'; runId: string; trigger: 'manual' | 'host'; observedAt: string;
    queueDigest: string; ownerRowDigest: string; bindingId: string; bindingRevision: number; scopeDigest: string;
    coverage: { totalTasks: number; consideredTasks: number; complete: true }; evidence: EvidenceV2[] };
  benefit: { summary: string; basis: string }; risk: { summary: string; basis: string };
  cost: { summary: string; basis: string; analysis: { localOnly: true; chargedRun: 1 }; execution: { estimate: null; uncertainty: string } };
  currentness: { status: 'current' | 'stale' | 'unknown'; historicalAge: 'unknown' | 'known'; checkedAt: string; reason: string };
  admissionBoundary: { requires: 'explicit-human-admission'; requestDigest: string; executionAuthorized: false; loopActivationAuthorized: false };
  disposition: { decisionId: string; reason: string; deferredUntil: string | null } | null;
}

const proposalV2Check = object({
  id: uuid, schemaVersion: oneOf(2), revision: integer(), workspaceId: digest, releaseId: localIdV2,
  ownerTaskId: localIdV2, relatedTaskIds: localIdsV2, kind: oneOf('prioritize-existing-task', 'repair-task-currentness'),
  title: string(), recommendation: string(), scope: object({ taskIds: localIdsV2, paths: list(string(4096)) }),
  createdAt: timestamp, expiresAt: timestamp, state: oneOf('pending', 'deferred', 'rejected', 'stale'), dedupKey: digest, evidenceDigest: digest,
  improvement: nullable(object({ rule: oneOf('missing-updated-at-v1'), targetTaskId: localIdV2, field: oneOf('updated_at'), action: oneOf('record-verified-currentness') })),
  provenance: object({ producer: oneOf('task-advisor'), packageVersion: string(LIMITS.shortText), sourceRevision: (value: unknown): null => { requireV2(value === null, 'invalid-source-revision'); return null; },
    algorithmVersion: oneOf('local-metadata-v2'), runId: uuid, trigger: oneOf('manual', 'host'), observedAt: timestamp,
    queueDigest: digest, ownerRowDigest: digest, bindingId: uuid, bindingRevision: integer(), scopeDigest: digest,
    coverage: object({ totalTasks: integer(LIMITS.tasks), consideredTasks: integer(LIMITS.tasks), complete: oneOf(true) }),
    evidence: list(object({ source: oneOf('task-queue'), locator: string(), digest, observedAt: timestamp, fact: string(),
      predicate: oneOf('field-absent', 'field-empty', 'field-value'), observedValueDigest: nullable(digest) })) }),
  benefit: assessment, risk: assessment,
  cost: object({ summary: string(), basis: string(), analysis: object({ localOnly: oneOf(true), chargedRun: oneOf(1) }),
    execution: object({ estimate: (value: unknown): null => { requireV2(value === null, 'invalid-cost-estimate'); return null; }, uncertainty: string() }) }),
  currentness: object({ status: oneOf('current', 'stale', 'unknown'), historicalAge: oneOf('unknown', 'known'), checkedAt: timestamp, reason: string() }),
  admissionBoundary: object({ requires: oneOf('explicit-human-admission'), requestDigest: digest, executionAuthorized: oneOf(false), loopActivationAuthorized: oneOf(false) }),
  disposition: nullable(object({ decisionId: uuid, reason: string(), deferredUntil: nullable(timestamp) })),
});
export function checkedProposalV2(input: unknown): ProposalV2 {
  const p = proposalV2Check(input, '$');
  requireV2(p.provenance.coverage.totalTasks === p.provenance.coverage.consideredTasks && p.provenance.evidence.length > 0, 'incomplete-proposal');
  requireV2(Date.parse(p.expiresAt) > Date.parse(p.createdAt) && Date.parse(p.expiresAt) - Date.parse(p.createdAt) <= LIMITS.maxEvidenceTtlMs, 'invalid-evidence-ttl');
  requireV2(Date.parse(p.provenance.observedAt) <= Date.parse(p.createdAt), 'invalid-observation-time');
  for (const e of p.provenance.evidence) requireV2(e.digest === p.provenance.queueDigest && (e.predicate !== 'field-absent' || e.observedValueDigest === null), 'invalid-evidence');
  requireV2((p.kind === 'repair-task-currentness') === (p.improvement !== null), 'invalid-improvement');
  if (p.improvement) requireV2(p.scope.taskIds.includes(p.improvement.targetTaskId), 'improvement-outside-scope');
  if (p.state === 'pending') requireV2(p.disposition === null, 'invalid-disposition');
  if (p.state === 'rejected' || p.state === 'deferred') requireV2(p.disposition !== null, 'missing-disposition');
  if (p.state === 'deferred') requireV2(p.disposition?.deferredUntil !== null, 'missing-defer-time');
  return p;
}
