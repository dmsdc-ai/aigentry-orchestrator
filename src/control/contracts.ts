/** Control-plane command/approval contracts (E0, isolated slice for task #1182).
 * Pure structure: validation never authenticates an actor, decision or store row.
 * Limits are provisional validation bounds, not measured production capacity.
 * Times are safe-integer epoch milliseconds from the injected server clock.
 */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { CommandCard } from './cards.js';

export const LIMITS = Object.freeze({
  commandBytes: 64 * 1024, recordBytes: 256 * 1024, depth: 8, nodes: 4_096,
  text: 2_048, keys: 64, list: 256, paths: 64, pathChars: 512,
  maxCommandTtlMs: 15 * 60_000, maxCapabilityTtlMs: 10 * 60_000,
  maxDecisionTtlMs: 120_000, maxScopeTtlMs: 30 * 86_400_000,
});

/** Implemented vertical operations. Nothing else is admitted. */
export const IMPLEMENTED_OPERATIONS = ['config.set', 'dispatch.start'] as const;
export type OperationName = typeof IMPLEMENTED_OPERATIONS[number];
/** Declared for future callers only; each is refused as OPERATION_UNAVAILABLE. */
export const PENDING_OPERATIONS = [
  'scope.approve', 'scope.revoke', 'loop.enable', 'loop.disable', 'task.create', 'task.admit',
  'attempt.stop', 'attempt.retry_unknown', 'attempt.resolve_unknown', 'hitl.decide',
  'session.clean', 'release.advance', 'recovery.release_held', 'runtime.reclaim',
] as const;
export type PendingOperationName = typeof PENDING_OPERATIONS[number];
export const CONFIG_SETTINGS = ['role.launch', 'advisor.enabled'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const WORKSPACE_ROLES = ['owner', 'operator', 'viewer'] as const;
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];
/** Provisional role/operation policy. A role grants no decision; scope or decision still applies. */
export const ROLE_OPERATIONS: Readonly<Record<WorkspaceRole, readonly OperationName[]>> = Object.freeze({
  owner: Object.freeze(['config.set', 'dispatch.start'] as const),
  operator: Object.freeze(['dispatch.start'] as const),
  viewer: Object.freeze([] as const),
});
/** advisor principals are never execution authority. */
export const PRINCIPAL_KINDS = ['user', 'controller', 'advisor'] as const;
/** relay-rendered decisions are not accepted until the remote-approval trust boundary is decided. */
export const RENDERING_ORIGINS = ['runtime_local', 'runtime_direct', 'relay'] as const;

export type RefusalCode = 'INVALID_SHAPE' | 'UNKNOWN_FIELD' | 'UNKNOWN_VERSION' | 'INVALID_VALUE'
  | 'INPUT_LIMIT' | 'OPERATION_UNAVAILABLE' | 'UNAUTHENTICATED' | 'TRUSTED_CONTEXT_INVALID'
  | 'FORBIDDEN' | 'RUNTIME_NOT_ENROLLED' | 'CONFLICT' | 'EXPIRED' | 'NOT_FOUND' | 'STALE_REV'
  | 'POLICY_DENIED' | 'SCOPE_EXCEEDED' | 'DECISION_REQUIRED' | 'DECISION_REJECTED'
  | 'STORE_INVALID' | 'STORE_ROLLED_BACK' | 'COMMIT_UNCERTAIN';
export interface Refusal { readonly code: RefusalCode; readonly path: string; readonly detail: string }
export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal };
export type Frozen<T> = T extends readonly (infer U)[] ? readonly Frozen<U>[]
  : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

/** Thrown only by canonicalJson/canonicalDigest/snapshotJson. */
export class RefusalError extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.detail); }
}
function refuse(code: RefusalCode, path: string, detail: string): never {
  throw new RefusalError({ code, path, detail });
}

function dataProperty(item: object, key: string, path: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(item, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    return refuse('INVALID_SHAPE', path, 'Expected enumerable data properties only');
  }
  return descriptor.value;
}
/** Detached, deep-frozen copy of plain JSON data. Proxies, accessors, symbol keys,
 * non-enumerable properties, exotic prototypes, sparse arrays, non-safe-integer numbers
 * and -0 are refused rather than normalized. Bounds are checked before any hashing. */
export function snapshotJson(value: unknown, maxBytes: number): unknown {
  let nodes = 0;
  const copy = (item: unknown, depth: number, path: string): unknown => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) refuse('INPUT_LIMIT', path, 'JSON structure exceeds bound');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) refuse('INVALID_VALUE', path, 'Only safe integers are accepted');
      return item;
    }
    if (typeof item === 'string') {
      if (item.length > LIMITS.text) refuse('INPUT_LIMIT', path, 'Text exceeds validation bound');
      return item;
    }
    if (typeof item !== 'object' || types.isProxy(item)) return refuse('INVALID_SHAPE', path, 'Expected plain JSON data');
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) refuse('INVALID_SHAPE', path, 'Expected plain array');
      const length = item.length;
      if (length > LIMITS.list) refuse('INPUT_LIMIT', path, 'List exceeds validation bound');
      if (keys.length !== length + 1) refuse('INVALID_SHAPE', path, 'Expected dense array without extra properties');
      const output: unknown[] = [];
      for (let index = 0; index < length; index++) {
        output.push(copy(dataProperty(item, String(index), path), depth + 1, `${path}[${index}]`));
      }
      return Object.freeze(output);
    }
    const prototype: unknown = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) refuse('INVALID_SHAPE', path, 'Expected plain JSON object');
    if (keys.length > LIMITS.keys) refuse('INPUT_LIMIT', path, 'Object exceeds validation bound');
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') return refuse('INVALID_SHAPE', path, 'Symbol keys are not JSON');
      if (key.length > LIMITS.text) refuse('INPUT_LIMIT', path, 'Key exceeds validation bound');
      const child = copy(dataProperty(item, key, `${path}.${key}`), depth + 1, `${path}.${key}`);
      Object.defineProperty(output, key, { value: child, enumerable: true });
    }
    return Object.freeze(output);
  };
  const result = copy(value, 0, '$');
  if (Buffer.byteLength(encode(result), 'utf8') > maxBytes) refuse('INPUT_LIMIT', '$', 'Serialized JSON exceeds byte ceiling');
  return result;
}
/** Canonical JSON over snapshot data: sorted keys (UTF-16 order), no whitespace. */
function encode(item: unknown): string {
  if (item === null || typeof item !== 'object') return JSON.stringify(item);
  if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
  const record = item as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
}
export function canonicalJson(value: unknown): string {
  return encode(snapshotJson(value, LIMITS.recordBytes));
}
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
/** Content binding only. A digest is never authority. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

type Check<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Check<unknown>>;
type Checked<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };
function object<S extends Shape>(shape: S): Check<Checked<S>> {
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return refuse('INVALID_SHAPE', path, 'Expected an object');
    }
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) refuse('UNKNOWN_FIELD', `${path}.${key}`, 'Unexpected field');
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) output[key] = shape[key](input[key], `${path}.${key}`);
    return output as Checked<S>;
  };
}
function field(value: unknown, key: string, path: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse('INVALID_SHAPE', path, 'Expected an object');
  return (value as Record<string, unknown>)[key];
}
function pattern(expression: RegExp, description: string, max: number = LIMITS.text): Check<string> {
  return (value, path) => {
    if (typeof value !== 'string') return refuse('INVALID_VALUE', path, description);
    if (value.length > max) refuse('INPUT_LIMIT', path, 'Text exceeds validation bound');
    if (!expression.test(value)) refuse('INVALID_VALUE', path, description);
    return value;
  };
}
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid4 = (value: unknown): value is string => typeof value === 'string' && UUID4.test(value);
const uuid = pattern(UUID4, 'Expected lowercase UUIDv4');
const digest = pattern(/^[0-9a-f]{64}$/, 'Expected lowercase SHA-256');
/** Same grammar as hitl/web/console-contracts.ts consoleId. */
const id = pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, 'Expected console identifier');
const opaqueId = pattern(/^[A-Za-z0-9_-]{1,1400}$/, 'Expected base64url-safe identifier');
const token = pattern(/^[a-z0-9][a-z0-9._:-]{0,63}$/, 'Expected lowercase token');
const nonce = pattern(/^[A-Za-z0-9_-]{43}$/, 'Expected base64url 32-byte nonce');
/** Project-relative prefix: ASCII segments; no absolute, drive, backslash, dot or dot-dot segment. */
const relativePath: Check<string> = (value, path) => {
  const result = pattern(/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/, 'Expected project-relative path', LIMITS.pathChars)(value, path);
  if (result.split('/').some(segment => segment === '.' || segment === '..')) refuse('INVALID_VALUE', path, 'Dot segments are not allowed');
  return result;
};
function integer(min = 0, max = Number.MAX_SAFE_INTEGER): Check<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      return refuse('INVALID_VALUE', path, `Expected safe integer in [${min}, ${max}]`);
    }
    return value;
  };
}
const boolean: Check<boolean> = (value, path) => typeof value === 'boolean'
  ? value : refuse('INVALID_VALUE', path, 'Expected boolean');
function oneOf<const T extends readonly (string | number | boolean)[]>(...values: T): Check<T[number]> {
  return (value, path) => values.some(item => item === value)
    ? value as T[number] : refuse('INVALID_VALUE', path, 'Unexpected enum value');
}
const version: Check<1> = (value, path) => value === 1 ? 1
  : refuse('UNKNOWN_VERSION', path, 'Only v 1 is supported');
function nullable<T>(check: Check<T>): Check<T | null> {
  return (value, path) => value === null ? null : check(value, path);
}
/** Absent optional field defaults to null (Scope caps only). */
function defaultNull<T>(check: Check<T>): Check<T | null> {
  return (value, path) => value === undefined || value === null ? null : check(value, path);
}
function list<T>(check: Check<T>, max: number, min = 0): Check<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return refuse('INVALID_SHAPE', path, 'Expected array');
    if (value.length > max) refuse('INPUT_LIMIT', path, 'List exceeds validation bound');
    if (value.length < min) refuse('INVALID_VALUE', path, 'List is empty');
    const items = value.map((item, index) => check(item, `${path}[${index}]`));
    const seen = new Set<string>();
    for (const item of items) {
      const key = encode(item);
      if (seen.has(key)) refuse('INVALID_VALUE', path, 'Duplicate list entry');
      seen.add(key);
    }
    return items;
  };
}

const modelShape = { cli: token, model: token, effort: oneOf(...EFFORTS) };
const roleLaunchParams = object({ setting: oneOf('role.launch'), role: id, ...modelShape });
const advisorParams = object({ setting: oneOf('advisor.enabled'), enabled: boolean });
type ConfigParamsShape = ReturnType<typeof roleLaunchParams> | ReturnType<typeof advisorParams>;
/** Only named, structured settings. No free-form keys, credentials or secret values. */
function configParams(value: unknown, path: string): ConfigParamsShape {
  const setting = field(value, 'setting', path);
  if (setting === 'role.launch') return roleLaunchParams(value, path);
  if (setting === 'advisor.enabled') return advisorParams(value, path);
  return refuse('OPERATION_UNAVAILABLE', `${path}.setting`, 'Config setting is not implemented');
}
const dispatchParams = object({
  target: object({ sid: id }), role: id, ...modelShape,
  paths: list(relativePath, LIMITS.paths, 1), wave: integer(1), loop: boolean,
});
/** Client authority fields (user, credential, auth session, clock) are deliberately absent:
 * authority comes only from the trusted server context. Every command is task-bound: v stays 1
 * because this isolated slice has no shipped consumer (config.set now requires task_id/task_rev). */
const commandCommon = {
  v: version, idem_key: uuid, workspace_id: id, runtime_id: id,
  expires_at_ms: integer(1), decision_id: nullable(uuid), task_id: id, task_rev: integer(),
};
const configSetCommand = object({
  ...commandCommon, op: oneOf('config.set'), scope_id: nullable(uuid),
  expected: object({ config_rev: integer() }), params: configParams,
});
const dispatchStartCommand = object({
  ...commandCommon, op: oneOf('dispatch.start'), attempt: uuid,
  scope_id: uuid, expected: object({ config_rev: integer() }), params: dispatchParams,
});
function command(value: unknown, path: string): ReturnType<typeof configSetCommand> | ReturnType<typeof dispatchStartCommand> {
  version(field(value, 'v', path), `${path}.v`);
  const op = field(value, 'op', path);
  if (op === 'config.set') return configSetCommand(value, path);
  if (op === 'dispatch.start') return dispatchStartCommand(value, path);
  if ((PENDING_OPERATIONS as readonly unknown[]).includes(op)) {
    return refuse('OPERATION_UNAVAILABLE', `${path}.op`, 'Operation is declared but pending future caller work');
  }
  return refuse('OPERATION_UNAVAILABLE', `${path}.op`, 'Unknown operation');
}
export type ConfigParams = Frozen<ConfigParamsShape>;
export type ConfigSetCommand = Frozen<ReturnType<typeof configSetCommand>>;
export type DispatchStartCommand = Frozen<ReturnType<typeof dispatchStartCommand>>;
export type Command = ConfigSetCommand | DispatchStartCommand;

const principalCheck = object({
  kind: oneOf(...PRINCIPAL_KINDS), user_id: opaqueId, credential_id: opaqueId, auth_session_id: opaqueId,
});
/** Produced by server authentication. Never parsed from a request body. */
export type Principal = Frozen<ReturnType<typeof principalCheck>>;

const spend = object({ unit: token, amount: integer() });
const capsCheck = object({
  max_workers: defaultNull(integer(1)), max_waves: defaultNull(integer(1)), spend_ceiling: defaultNull(spend),
});
const scopeCheck = object({
  v: version, scope_id: uuid, rev: integer(), workspace_id: id, runtime_id: id,
  task_ids: list(id, LIMITS.list), ops: list(oneOf(...IMPLEMENTED_OPERATIONS, ...PENDING_OPERATIONS), LIMITS.list, 1),
  config_settings: list(oneOf(...CONFIG_SETTINGS), CONFIG_SETTINGS.length),
  paths: list(relativePath, LIMITS.paths), models: list(object(modelShape), LIMITS.list),
  /** Exact role names; an empty list permits no role. */
  roles: list(id, LIMITS.list),
  /** Worker namespaces: a target sid is covered when sid === prefix or sid starts with `${prefix}-`.
   * The controller picks the concrete worker inside the namespace; an empty list permits no target. */
  target_prefixes: list(id, LIMITS.list),
  /** Every cap is optional and defaults to null (resource-chosen). */
  caps: (value: unknown, path: string) => value === undefined
    ? { max_workers: null, max_waves: null, spend_ceiling: null } : capsCheck(value, path),
  loop: boolean, approved_at_ms: integer(), expires_at_ms: integer(1), approval_decision_id: nullable(uuid),
});
function scope(value: unknown, path: string): ReturnType<typeof scopeCheck> {
  const result = scopeCheck(value, path);
  const ttl = result.expires_at_ms - result.approved_at_ms;
  if (ttl <= 0 || ttl > LIMITS.maxScopeTtlMs) refuse('INVALID_VALUE', `${path}.expires_at_ms`, 'Scope expiry must be finite and bounded');
  return result;
}
/** Server-stored scope. Approval of the scope itself is outside this slice (scope.approve pending). */
export type ScopeRecord = Frozen<ReturnType<typeof scopeCheck>>;

const decisionCheck = object({
  v: version, decision_id: uuid,
  /** Label only: an independent upstream verifier (WebAuthn step-up, owed) produced this record. */
  verification: oneOf('upstream_verified'), verifier: id,
  subject: object({ kind: oneOf('command'), id: uuid, task_id: id, task_rev: integer(), config_rev: integer() }),
  card_sha256: digest, verdict: oneOf('approve', 'reject'),
  user_id: opaqueId, credential_id: opaqueId, auth_session_id: opaqueId, workspace_id: id, runtime_id: id,
  nonce, rendering_origin: oneOf(...RENDERING_ORIGINS), issued_at_ms: integer(), expires_at_ms: integer(1),
});
function decisionRecord(value: unknown, path: string): ReturnType<typeof decisionCheck> {
  const result = decisionCheck(value, path);
  const ttl = result.expires_at_ms - result.issued_at_ms;
  if (ttl <= 0 || ttl > LIMITS.maxDecisionTtlMs) refuse('INVALID_VALUE', `${path}.expires_at_ms`, 'Decision expiry must be within 120 s');
  return result;
}
/** Verified decision record as stored by the upstream verifier. A request boolean or raw
 * assertion is never accepted in its place; this module does not verify signatures. */
export type VerifiedDecisionRecord = Frozen<ReturnType<typeof decisionCheck>>;

const capabilityCheck = object({
  v: version, cap_id: uuid, command_id: uuid, op: oneOf(...IMPLEMENTED_OPERATIONS),
  workspace_id: id, runtime_id: id, scope_id: nullable(uuid), decision_id: nullable(uuid), msg_id: uuid,
  issued_at_ms: integer(), not_after_ms: integer(1), state: oneOf('issued'),
});
/** This slice only issues. use/revoke/expire transitions belong to future callers. */
export type Capability = Frozen<ReturnType<typeof capabilityCheck>>;
const receiptCheck = object({
  v: version, command_id: uuid, idem_key: uuid, state: oneOf('admitted'),
  request_sha256: digest, card_sha256: digest, cap_id: uuid, msg_id: uuid, admitted_at_ms: integer(),
  /** Admission is exactly as durable as the injected store's commit contract. */
  commit: oneOf('store_reported_committed'),
});
export type Receipt = Frozen<ReturnType<typeof receiptCheck>>;

const ROWS = {
  grant: nullable(object({ role: oneOf(...WORKSPACE_ROLES) })),
  enrolled: boolean,
  admission: nullable(object({ request_sha256: digest, receipt: receiptCheck, capability: capabilityCheck })),
  revision: integer(),
  optionalRevision: nullable(integer()),
  scope: nullable(object({ record: scope, revoked: boolean })),
  usage: object({ active_workers: integer(), spent: nullable(spend) }),
  decision: nullable(object({ record: decisionRecord, revoked: boolean, consumed: boolean })),
  consume: oneOf('consumed', 'conflict'),
  reserve: oneOf('reserved', 'cap_reached', 'id_collision'),
  insert: oneOf('inserted', 'conflict', 'id_collision'),
};
export type StoreRowKind = keyof typeof ROWS;
export type StoreRow<K extends StoreRowKind> = Frozen<ReturnType<(typeof ROWS)[K]>>;

function result<T>(input: unknown, maxBytes: number, check: Check<T>): ValidationResult<Frozen<T>> {
  try {
    return { ok: true, value: deepFreeze(check(snapshotJson(input, maxBytes), '$')) as Frozen<T> };
  } catch (error) {
    if (error instanceof RefusalError) return { ok: false, refusal: error.refusal };
    return { ok: false, refusal: { code: 'INVALID_SHAPE', path: '$', detail: 'Unreadable input' } };
  }
}
export function validateCommand(input: unknown): ValidationResult<Command> {
  return result(input, LIMITS.commandBytes, command);
}
export function validatePrincipal(input: unknown): ValidationResult<Principal> {
  return result(input, LIMITS.recordBytes, principalCheck);
}
export function validateScopeRecord(input: unknown): ValidationResult<ScopeRecord> {
  return result(input, LIMITS.recordBytes, scope);
}
export function validateDecisionRecord(input: unknown): ValidationResult<VerifiedDecisionRecord> {
  return result(input, LIMITS.recordBytes, decisionRecord);
}
export function validateCapability(input: unknown): ValidationResult<Capability> {
  return result(input, LIMITS.recordBytes, capabilityCheck);
}
export function validateReceipt(input: unknown): ValidationResult<Receipt> {
  return result(input, LIMITS.recordBytes, receiptCheck);
}
/** Store rows are structurally untrusted even though the store is the authority of record. */
export function validateStoreRow<K extends StoreRowKind>(kind: K, input: unknown): ValidationResult<StoreRow<K>> {
  return result(input, LIMITS.recordBytes, ROWS[kind] as Check<ReturnType<(typeof ROWS)[K]>>);
}

/** Server-side authentication port. recheck() is true only while the session and credential
 * behind principal are still current; it is called again after every async boundary. */
export interface AuthenticationPort { recheck(principal: Principal): Promise<boolean> }
/** Trusted server clock (epoch ms). Client clocks are never consulted. */
export interface TrustedClock { nowMs(): number }
/** Trusted server ID allocator (lowercase UUIDv4, e.g. node:crypto randomUUID). Fallible: global
 * uniqueness is enforced by the store (insertAdmission/reserveScopeSlot 'id_collision'), not assumed. */
export interface TrustedIdAllocator { uuid(): string }
export interface TrustedServerContext {
  readonly principal: Principal;
  readonly authentication: AuthenticationPort;
  readonly clock: TrustedClock;
  readonly ids: TrustedIdAllocator;
}
/** Idempotence is bound to the authenticated user plus workspace/runtime, never to a client claim. */
export interface IdempotenceKey {
  readonly user_id: string; readonly workspace_id: string; readonly runtime_id: string; readonly idem_key: string;
}
/** Deep-frozen, JSON-serializable copy; mutation after admission cannot change hashed data. */
export interface AdmissionRecord {
  readonly key: IdempotenceKey;
  readonly request_sha256: string;
  readonly command: Command;
  readonly principal: Principal;
  readonly card: CommandCard;
  readonly card_sha256: string;
  readonly capability: Capability;
  readonly receipt: Receipt;
}
export interface DecisionConsumption { readonly decision_id: string; readonly nonce: string; readonly command_id: string }
/** One dispatch worker slot held against scope caps.max_workers. Expiry-bound: the slot lapses at
 * not_after_ms (the capability's not_after_ms) unless a future executor converts or releases it.
 * Holding a slot is not execution: an executor must re-check task/config revisions, scope, caps
 * and capability state freshly before any effect. */
export interface ScopeSlotReservation {
  readonly workspace_id: string; readonly scope_id: string; readonly command_id: string;
  readonly max_workers: number; readonly reserved_at_ms: number; readonly not_after_ms: number;
}
/** Reads/writes inside one transaction. Every returned value is re-validated by the caller. */
export interface ControlTx {
  grant(user_id: string, workspace_id: string): Promise<StoreRow<'grant'>>;
  runtimeEnrolled(workspace_id: string, runtime_id: string): Promise<StoreRow<'enrolled'>>;
  admission(key: IdempotenceKey): Promise<StoreRow<'admission'>>;
  /** Source config revision (not a read-projection hash). */
  configRevision(workspace_id: string, runtime_id: string): Promise<StoreRow<'revision'>>;
  /** Source task revision (not a read-projection hash); null when the task is absent. */
  taskRevision(workspace_id: string, task_id: string): Promise<StoreRow<'optionalRevision'>>;
  scope(workspace_id: string, scope_id: string): Promise<StoreRow<'scope'>>;
  /** Store-defined live usage of the scope; spent is null when unmetered. Admission reads it only as
   * an early max_workers pre-check; it enforces nothing (reserveScopeSlot does). spent is not consulted. */
  scopeUsage(workspace_id: string, scope_id: string): Promise<StoreRow<'usage'>>;
  decision(workspace_id: string, decision_id: string): Promise<StoreRow<'decision'>>;
  /** Unique on decision_id and on nonce: a second use returns 'conflict' and writes nothing. */
  consumeDecision(input: DecisionConsumption): Promise<StoreRow<'consume'>>;
  /** One atomic conditional write in this transaction: counts active workers plus live reservations
   * (not released, not_after_ms > reserved_at_ms of this call) for the workspace/scope; below
   * max_workers it writes the reservation and returns 'reserved', otherwise 'cap_reached' with no write.
   * Unique on (workspace_id, scope_id, command_id): a duplicate returns 'id_collision' and writes
   * nothing. Rolls back with the transaction. Release/convert belongs to the future executor. */
  reserveScopeSlot(input: ScopeSlotReservation): Promise<StoreRow<'reserve'>>;
  /** Unique on IdempotenceKey: a duplicate returns 'conflict' and writes nothing. command_id, cap_id
   * and msg_id are each globally unique across all admissions: a clash returns 'id_collision' and
   * writes nothing. Under SERIALIZABLE a clash with a concurrently committing transaction SHOULD
   * surface as a serialization failure (store re-runs work); 'conflict' MAY still be returned, and
   * the core then retries at most once in a new transaction. */
  insertAdmission(record: AdmissionRecord): Promise<StoreRow<'insert'>>;
}
export type StoreOutcome<T> =
  | { readonly status: 'committed'; readonly value: T }
  | { readonly status: 'rolled_back'; readonly cause: unknown }
  | { readonly status: 'commit_uncertain'; readonly cause: unknown };
/** Control store port. The backing implementation is owed (GAP-D) and must satisfy:
 * - work runs under SERIALIZABLE isolation; all of its writes commit atomically or none do;
 * - if work throws or rejects, the store rolls back and resolves {status:'rolled_back'};
 * - 'committed' is reported only when the commit is known; otherwise 'commit_uncertain',
 *   which is never retried silently and never converted to success;
 * - the store may re-run work after a serialization failure; only the final run may commit;
 * - durability is whatever the implementation documents. No fake adapter is a default. */
export interface ControlStore {
  transaction<T>(work: (tx: ControlTx) => Promise<T>): Promise<StoreOutcome<T>>;
}
