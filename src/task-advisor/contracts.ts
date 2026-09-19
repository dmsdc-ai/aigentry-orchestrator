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
