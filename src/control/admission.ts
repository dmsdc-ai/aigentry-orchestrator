/** Isolated command admission (E1 admission tx only).
 * Issues a Capability in state `issued` and a Receipt `admitted`. It never uses a capability,
 * calls telepty, marks a task done, publishes or cleans up. An admission is exactly as durable
 * as the injected ControlStore reports; rollback and commit_uncertain stay visible.
 */
import { renderCommandCard, type CardView } from './cards.js';
import {
  canonicalDigest, isUuid4, validateCapability, validateCommand, validatePrincipal, validateReceipt,
  validateStoreRow, LIMITS, ROLE_OPERATIONS,
  type AdmissionRecord, type Capability, type Command, type ControlStore, type ControlTx, type Principal,
  type Receipt, type Refusal, type RefusalCode, type ScopeRecord, type StoreRow, type StoreRowKind,
  type TrustedServerContext, type VerifiedDecisionRecord,
} from './contracts.js';

export interface AdmissionRefusal extends Refusal {
  /** Machine-readable scope/decision reasons; empty when not applicable. */
  readonly reasons: readonly string[];
  /** Present only after authentication, workspace grant and runtime enrollment passed. */
  readonly card: CardView | null;
}
export type AdmissionResult =
  | { readonly ok: true; readonly replayed: boolean; readonly receipt: Receipt; readonly capability: Capability }
  | { readonly ok: false; readonly refusal: AdmissionRefusal };
interface Admitted { readonly replayed: boolean; readonly receipt: Receipt; readonly capability: Capability }

class Abort extends Error {
  constructor(readonly refusal: AdmissionRefusal) { super(refusal.detail); }
}
function refusal(code: RefusalCode, detail: string, path = '$', reasons: readonly string[] = [], card: CardView | null = null): AdmissionRefusal {
  return Object.freeze({ code, path, detail, reasons: Object.freeze([...reasons]), card });
}
function fail(code: RefusalCode, detail: string, path = '$', reasons: readonly string[] = [], card: CardView | null = null): never {
  throw new Abort(refusal(code, detail, path, reasons, card));
}
function refused(value: AdmissionRefusal): AdmissionResult {
  return Object.freeze({ ok: false, refusal: value });
}

async function row<K extends StoreRowKind>(kind: K, read: () => Promise<unknown>): Promise<StoreRow<K>> {
  const checked = validateStoreRow(kind, await read());
  if (!checked.ok) return fail('STORE_INVALID', `Store returned malformed ${kind}: ${checked.refusal.detail}`, checked.refusal.path);
  return checked.value;
}
async function authenticated(trusted: TrustedServerContext, principal: Principal): Promise<void> {
  let current: unknown;
  try { current = await trusted.authentication.recheck(principal); } catch { current = false; }
  if (current !== true) fail('UNAUTHENTICATED', 'Server authentication is no longer current');
}
function clock(trusted: TrustedServerContext, notBefore: number): number {
  let now: unknown;
  try { now = trusted.clock.nowMs(); } catch { now = undefined; }
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < notBefore) {
    return fail('TRUSTED_CONTEXT_INVALID', 'Trusted clock returned an invalid or regressing time');
  }
  return now;
}
function allocate(trusted: TrustedServerContext, taken: readonly string[]): string {
  let value: unknown;
  try { value = trusted.ids.uuid(); } catch { value = undefined; }
  if (!isUuid4(value) || taken.includes(value)) return fail('TRUSTED_CONTEXT_INVALID', 'Trusted ID allocator returned an invalid or repeated id');
  return value;
}
const within = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);
/** Namespace match on an exact '-' boundary only: 'cf1' covers 'cf1' and 'cf1-coder', never 'cf10'. */
const inNamespace = (sid: string, prefix: string): boolean => sid === prefix || sid.startsWith(`${prefix}-`);
function permitsModel(scope: ScopeRecord, wanted: { cli: string; model: string; effort: string }): boolean {
  return scope.models.some(item => item.cli === wanted.cli && item.model === wanted.model && item.effort === wanted.effort);
}

/** hard: never admitted (caps, lifetime, runtime, loop, spend). soft: needs a verified decision. */
async function coverage(tx: ControlTx, command: Command, scope: ScopeRecord, revoked: boolean, now: number)
  : Promise<{ hard: string[]; soft: string[] }> {
  const hard: string[] = [];
  const soft: string[] = [];
  if (revoked) hard.push('scope_revoked');
  if (scope.runtime_id !== command.runtime_id) hard.push('scope_runtime_mismatch');
  if (now < scope.approved_at_ms) hard.push('scope_not_yet_active');
  if (now >= scope.expires_at_ms) hard.push('scope_expired');
  if (!scope.ops.includes(command.op)) soft.push('operation_outside_scope');
  if (!scope.task_ids.includes(command.task_id)) soft.push('task_outside_scope');
  if (command.op === 'config.set') {
    if (!scope.config_settings.includes(command.params.setting)) soft.push('setting_outside_scope');
    if (command.params.setting === 'role.launch') {
      if (!scope.roles.includes(command.params.role)) soft.push('role_outside_scope');
      if (!permitsModel(scope, command.params)) soft.push('model_outside_scope');
    }
    return { hard, soft };
  }
  const params = command.params;
  if (!scope.roles.includes(params.role)) soft.push('role_outside_scope');
  if (!scope.target_prefixes.some(prefix => inNamespace(params.target.sid, prefix))) soft.push('target_outside_scope');
  if (!params.paths.every(path => scope.paths.some(prefix => within(path, prefix)))) soft.push('path_outside_scope');
  if (!permitsModel(scope, params)) soft.push('model_outside_scope');
  // Loop is never activated by default and never by a per-command decision.
  if (params.loop && !scope.loop) hard.push('loop_not_enabled_by_scope');
  const caps = scope.caps;
  if (caps.max_waves !== null && params.wave > caps.max_waves) hard.push('max_waves');
  // Admission knows no cost, so spend cannot be reserved here; a read cannot bound concurrent spend.
  // Spend-limited dispatch stays unsupported until a spend reservation exists.
  if (caps.spend_ceiling !== null) hard.push('spend_reservation_unavailable');
  if (caps.max_workers !== null) {
    // Early pre-check only; reserveScopeSlot enforces the cap atomically before commit.
    const usage = await row('usage', () => tx.scopeUsage(command.workspace_id, scope.scope_id));
    if (usage.active_workers >= caps.max_workers) hard.push('max_workers');
  }
  return { hard, soft };
}

async function verifiedDecision(tx: ControlTx, command: Command, principal: Principal, view: CardView, now: number)
  : Promise<VerifiedDecisionRecord> {
  const decline = (reason: string): never => fail('DECISION_REQUIRED', 'Stored decision does not authorize this command', '$.decision_id', [reason], view);
  const decisionId = command.decision_id;
  if (decisionId === null) return decline('decision_absent');
  if (principal.kind !== 'user') return decline('decision_requires_user_principal');
  const found = await row('decision', () => tx.decision(command.workspace_id, decisionId));
  if (found === null) return decline('decision_absent');
  const record = found.record;
  if (record.decision_id !== decisionId || record.workspace_id !== command.workspace_id) {
    return fail('STORE_INVALID', 'Stored decision does not match its lookup key');
  }
  // Bind runtime and principal before any revoked/consumed state is disclosed; one generic reason.
  if (record.runtime_id !== command.runtime_id || record.user_id !== principal.user_id
      || record.credential_id !== principal.credential_id
      || record.auth_session_id !== principal.auth_session_id) decline('decision_binding_mismatch');
  if (found.revoked) return decline('decision_revoked');
  if (found.consumed) return fail('CONFLICT', 'Decision nonce was already consumed', '$.decision_id');
  const subject = view.card.subject;
  if (record.subject.id !== subject.id || record.subject.task_id !== subject.task_id
      || record.subject.task_rev !== subject.task_rev || record.subject.config_rev !== subject.config_rev) {
    decline('decision_subject_mismatch');
  }
  if (record.card_sha256 !== view.card_sha256) decline('decision_card_mismatch');
  if (record.rendering_origin === 'relay') decline('decision_relay_origin_unresolved');
  if (now < record.issued_at_ms || now >= record.expires_at_ms) decline('decision_expired');
  if (record.verdict !== 'approve') fail('DECISION_REJECTED', 'The stored decision rejected this command', '$.decision_id', [], view);
  return record;
}

interface Input {
  readonly command: Command;
  readonly principal: Principal;
  readonly trusted: TrustedServerContext;
  readonly request_sha256: string;
}
/** Admission steps in order, inside one store transaction. Every refusal throws (rollback). */
async function admitInTx(tx: ControlTx, input: Input): Promise<Admitted> {
  const { command, principal, trusted, request_sha256 } = input;
  // 1. Authentication, rechecked inside the transaction.
  await authenticated(trusted, principal);
  // 2. Workspace grant and runtime enrollment, before any tenant record or card is disclosed.
  const grant = await row('grant', () => tx.grant(principal.user_id, command.workspace_id));
  if (grant === null) fail('FORBIDDEN', 'Workspace is not granted to this principal', '$.workspace_id');
  if (!(await row('enrolled', () => tx.runtimeEnrolled(command.workspace_id, command.runtime_id)))) {
    fail('RUNTIME_NOT_ENROLLED', 'Runtime is not enrolled for this workspace', '$.runtime_id');
  }
  // 3. Idempotence bound to the authenticated user plus workspace/runtime.
  const key = Object.freeze({
    user_id: principal.user_id, workspace_id: command.workspace_id, runtime_id: command.runtime_id, idem_key: command.idem_key,
  });
  const prior = await row('admission', () => tx.admission(key));
  if (prior !== null) {
    if (prior.request_sha256 !== request_sha256) fail('CONFLICT', 'Idempotence key was used with a different request', '$.idem_key');
    const { receipt, capability } = prior;
    if (receipt.idem_key !== command.idem_key || receipt.request_sha256 !== request_sha256
        || capability.command_id !== receipt.command_id || capability.cap_id !== receipt.cap_id
        || capability.msg_id !== receipt.msg_id || capability.op !== command.op
        || capability.workspace_id !== command.workspace_id || capability.runtime_id !== command.runtime_id) {
      fail('STORE_INVALID', 'Stored admission does not match its idempotence key');
    }
    await authenticated(trusted, principal);
    return { replayed: true, receipt, capability };
  }
  const started = clock(trusted, 0);
  if (command.expires_at_ms <= started) fail('EXPIRED', 'Command has expired', '$.expires_at_ms');
  if (command.expires_at_ms - started > LIMITS.maxCommandTtlMs) fail('INVALID_VALUE', 'Command expiry exceeds bound', '$.expires_at_ms');
  // 5a. Role/operation policy.
  if (!ROLE_OPERATIONS[grant.role].includes(command.op)) fail('POLICY_DENIED', 'Operation is not allowed for this workspace role', '$.op');
  // 4. Source revisions.
  const configRev = await row('revision', () => tx.configRevision(command.workspace_id, command.runtime_id));
  if (configRev !== command.expected.config_rev) fail('STALE_REV', 'Config revision changed', '$.expected.config_rev');
  // Every operation is task-bound (config.set included).
  const taskRev = await row('optionalRevision', () => tx.taskRevision(command.workspace_id, command.task_id));
  if (taskRev === null) fail('NOT_FOUND', 'Task is absent', '$.task_id');
  if (taskRev !== command.task_rev) fail('STALE_REV', 'Task revision changed', '$.task_rev');
  // 5b. Scope.
  const scopeId = command.scope_id;
  let scope: ScopeRecord | null = null;
  let revoked = false;
  if (scopeId !== null) {
    const found = await row('scope', () => tx.scope(command.workspace_id, scopeId));
    if (found === null) fail('NOT_FOUND', 'Scope is absent', '$.scope_id');
    if (found.record.scope_id !== scopeId || found.record.workspace_id !== command.workspace_id) {
      fail('STORE_INVALID', 'Stored scope does not match its lookup key');
    }
    scope = found.record;
    revoked = found.revoked;
  }
  const view = renderCommandCard({ command, principal, scope });
  const { hard, soft } = scope === null ? { hard: [], soft: [] } : await coverage(tx, command, scope, revoked, started);
  if (hard.length > 0) fail('SCOPE_EXCEEDED', 'Command exceeds a binding scope limit', '$.scope_id', hard, view);
  // 6. A decision is needed outside an approved scope; inside it, none is asked.
  let decision: VerifiedDecisionRecord | null = null;
  if (command.decision_id !== null) decision = await verifiedDecision(tx, command, principal, view, started);
  else if (scope === null) fail('DECISION_REQUIRED', 'No approved scope covers this command', '$.decision_id', ['no_scope'], view);
  else if (soft.length > 0) fail('SCOPE_EXCEEDED', 'Command is outside the approved scope', '$.scope_id', soft, view);
  // Recheck after async boundaries, with a fresh trusted time.
  await authenticated(trusted, principal);
  const now = clock(trusted, started);
  if (command.expires_at_ms <= now) fail('EXPIRED', 'Command has expired', '$.expires_at_ms');
  if (scope !== null && now >= scope.expires_at_ms) fail('SCOPE_EXCEEDED', 'Scope expired', '$.scope_id', ['scope_expired'], view);
  if (decision !== null && now >= decision.expires_at_ms) {
    fail('DECISION_REQUIRED', 'Stored decision expired', '$.decision_id', ['decision_expired'], view);
  }
  // 7. Issue the capability, mint msg_id once, and commit.
  const command_id = allocate(trusted, []);
  const cap_id = allocate(trusted, [command_id]);
  const msg_id = allocate(trusted, [command_id, cap_id]);
  let notAfter = Math.min(now + LIMITS.maxCapabilityTtlMs, command.expires_at_ms);
  if (scope !== null) notAfter = Math.min(notAfter, scope.expires_at_ms);
  if (decision !== null) notAfter = Math.min(notAfter, decision.expires_at_ms);
  const capability = validateCapability({
    v: 1, cap_id, command_id, op: command.op, workspace_id: command.workspace_id, runtime_id: command.runtime_id,
    scope_id: command.scope_id, decision_id: command.decision_id, msg_id, issued_at_ms: now, not_after_ms: notAfter, state: 'issued',
  });
  const receipt = validateReceipt({
    v: 1, command_id, idem_key: command.idem_key, state: 'admitted', request_sha256, card_sha256: view.card_sha256,
    cap_id, msg_id, admitted_at_ms: now, commit: 'store_reported_committed',
  });
  if (!capability.ok || !receipt.ok) return fail('TRUSTED_CONTEXT_INVALID', 'Could not form capability or receipt');
  // Worker cap: one atomic slot reservation, charged only by dispatch.start (never config.set).
  // A replay returned above and never reserves again. The slot lapses at notAfter unless a future
  // executor converts or releases it; accepting it is not execution and needs fresh executor checks.
  const maxWorkers = command.op === 'dispatch.start' && scope !== null ? scope.caps.max_workers : null;
  if (scope !== null && maxWorkers !== null) {
    const reservation = Object.freeze({
      workspace_id: command.workspace_id, scope_id: scope.scope_id, command_id, max_workers: maxWorkers,
      reserved_at_ms: now, not_after_ms: notAfter,
    });
    const reserved = await row('reserve', () => tx.reserveScopeSlot(reservation));
    if (reserved === 'id_collision') fail('TRUSTED_CONTEXT_INVALID', 'Allocated id collides with a stored id', '$', ['id_collision']);
    if (reserved !== 'reserved') fail('SCOPE_EXCEEDED', 'Scope worker cap is reached', '$.scope_id', ['max_workers'], view);
  }
  if (decision !== null) {
    const consumption = Object.freeze({ decision_id: decision.decision_id, nonce: decision.nonce, command_id });
    const consumed = await row('consume', () => tx.consumeDecision(consumption));
    if (consumed !== 'consumed') {
      fail('CONFLICT', 'Decision nonce was already consumed', '$.decision_id', ['decision_consumed_concurrently']);
    }
  }
  const record: AdmissionRecord = Object.freeze({
    key, request_sha256, command, principal, card: view.card, card_sha256: view.card_sha256,
    capability: capability.value, receipt: receipt.value,
  });
  const inserted = await row('insert', () => tx.insertAdmission(record));
  if (inserted === 'id_collision') fail('TRUSTED_CONTEXT_INVALID', 'Allocated id collides with a stored id', '$', ['id_collision']);
  if (inserted !== 'inserted') {
    fail('CONFLICT', 'A concurrent admission holds this idempotence key; retry with the same key', '$.idem_key', ['concurrent_admission']);
  }
  // Final recheck after the writes and before commit; failure rolls back every write.
  await authenticated(trusted, principal);
  return { replayed: false, receipt: receipt.value, capability: capability.value };
}

/** Rolled-back concurrent-race conflicts that a fresh transaction may resolve by replay. */
const RETRYABLE_CONFLICTS: readonly string[] = Object.freeze(['concurrent_admission', 'decision_consumed_concurrently']);
interface Attempt { readonly result: AdmissionResult; readonly retryable: boolean }
/** One store.transaction call. retryable only when the store confirmed rolled_back for a run that
 * aborted on a concurrent-race conflict; never for commit_uncertain, a throw or any other refusal. */
async function transact(store: ControlStore, input: Input): Promise<Attempt> {
  const once = (result: AdmissionResult, retryable = false): Attempt => ({ result, retryable });
  let last: { result: Admitted | null; abort: AdmissionRefusal | null } = { result: null, abort: null };
  let outcome: unknown;
  try {
    outcome = await store.transaction(async tx => {
      last = { result: null, abort: null };
      try {
        const admitted = await admitInTx(tx, input);
        last = { result: admitted, abort: null };
        return admitted;
      } catch (error) {
        if (error instanceof Abort) last = { result: null, abort: error.refusal };
        throw error;
      }
    });
  } catch {
    return once(refused(refusal('COMMIT_UNCERTAIN', 'Store transaction rejected; commit state is unknown')));
  }
  let status: unknown;
  try { status = typeof outcome === 'object' && outcome !== null ? (outcome as { status?: unknown }).status : undefined; }
  catch { status = undefined; }
  if (status === 'committed') {
    if (last.result !== null) return once(Object.freeze({ ok: true, ...last.result }));
    return once(refused(refusal('COMMIT_UNCERTAIN', 'Store reported a commit for a transaction that did not complete')));
  }
  if (status === 'rolled_back') {
    const abort = last.abort;
    const retryable = abort !== null && abort.code === 'CONFLICT' && abort.reasons.some(reason => RETRYABLE_CONFLICTS.includes(reason));
    return once(refused(abort ?? refusal('STORE_ROLLED_BACK', 'Store rolled back the admission transaction')), retryable);
  }
  return once(refused(refusal('COMMIT_UNCERTAIN', status === 'commit_uncertain'
    ? 'Store could not determine whether the admission committed' : 'Store returned an unrecognized outcome')));
}

/** Admits one raw client command. Authority comes only from `trusted` (server authentication,
 * clock, ids) and the stored scope/decision rows read inside `store.transaction`. */
export async function admitCommand(raw: unknown, trusted: TrustedServerContext, store: ControlStore): Promise<AdmissionResult> {
  const parsed = validateCommand(raw);
  if (!parsed.ok) return refused(refusal(parsed.refusal.code, parsed.refusal.detail, parsed.refusal.path));
  let principalInput: unknown;
  try {
    if (typeof trusted.authentication.recheck !== 'function' || typeof trusted.clock.nowMs !== 'function'
        || typeof trusted.ids.uuid !== 'function') {
      return refused(refusal('TRUSTED_CONTEXT_INVALID', 'Trusted server context is incomplete'));
    }
    principalInput = trusted.principal;
  } catch {
    return refused(refusal('TRUSTED_CONTEXT_INVALID', 'Trusted server context is unreadable'));
  }
  const principal = validatePrincipal(principalInput);
  if (!principal.ok) return refused(refusal('UNAUTHENTICATED', 'Server principal is malformed', principal.refusal.path));
  if (principal.value.kind === 'advisor') return refused(refusal('POLICY_DENIED', 'Advisor output is never execution authority'));
  if (typeof store?.transaction !== 'function') return refused(refusal('STORE_INVALID', 'Control store port is missing'));
  const input: Input = { command: parsed.value, principal: principal.value, trusted, request_sha256: canonicalDigest(parsed.value) };
  const first = await transact(store, input);
  if (!first.retryable) return first.result;
  // At most one retry, in a new transaction: admitInTx re-reads the prior admission first, so an
  // identical committed request replays the winner's ids and a different body is refused.
  return (await transact(store, input)).result;
}
