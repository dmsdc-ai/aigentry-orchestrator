/** Deterministic plain-JSON decision cards (E3, first slice; no UI).
 * card_sha256 binds content only: it is not authority and not proof that a user read the card.
 * Allowed params are enums and identifiers, so no secret value is rendered. This is a
 * consequence of the parameter grammar, not a complete privacy classifier.
 */
import {
  canonicalDigest, snapshotJson, LIMITS,
  type Command, type ConfigParams, type OperationName, type Principal, type ScopeRecord,
} from './contracts.js';

export interface CommandCard {
  readonly v: 1;
  readonly kind: 'command';
  readonly action: OperationName;
  /** The decision subject this card binds (idem_key plus task identity and source revisions). */
  readonly subject: {
    readonly kind: 'command'; readonly id: string; readonly task_id: string; readonly task_rev: number; readonly config_rev: number;
  };
  readonly workspace_id: string;
  readonly runtime_id: string;
  readonly task: { readonly id: string; readonly rev: number };
  readonly attempt: string | null;
  readonly target: { readonly sid: string } | null;
  readonly launch: {
    readonly role: string; readonly cli: string; readonly model: string; readonly effort: string;
    readonly paths: readonly string[]; readonly wave: number; readonly loop: boolean;
  } | null;
  readonly config_change: { readonly config_rev: number; readonly to: ConfigParams } | null;
  readonly scope: {
    readonly scope_id: string; readonly rev: number; readonly expires_at_ms: number; readonly loop: boolean;
    readonly roles: readonly string[]; readonly target_prefixes: readonly string[];
    readonly parallelism: 'resource_chosen' | 'capped';
    readonly caps: {
      readonly max_workers: number | null; readonly max_waves: number | null;
      readonly spend_ceiling: { readonly unit: string; readonly amount: number } | null;
    };
  } | null;
  readonly expires_at_ms: number;
  /** Requesting actor from the trusted server context; the auth session id is not rendered. */
  readonly requested_by: { readonly kind: Principal['kind']; readonly user_id: string; readonly credential_id: string };
  readonly consequences: readonly string[];
}
export interface CardView { readonly card: CommandCard; readonly card_sha256: string }
/** One validated snapshot. Revisions in command.expected/task_rev are compared to the store
 * before a card is used for a decision, so the card and the admission see the same values. */
export interface CardSnapshot {
  readonly command: Command;
  readonly principal: Principal;
  readonly scope: ScopeRecord | null;
}

function consequences(command: Command): string[] {
  if (command.op === 'dispatch.start') {
    const params = command.params;
    return [
      `Starts worker ${params.target.sid} (role ${params.role}) for task ${command.task_id} at revision ${command.task_rev}, attempt ${command.attempt}.`,
      `Uses ${params.cli}/${params.model} with effort ${params.effort}, wave ${params.wave}.`,
      `Declares ${params.paths.length} project-relative path prefix(es) for the worker.`,
      params.loop ? 'Loop continuation is requested explicitly for this worker.' : 'Loop continuation is not requested.',
      'Once delivered, a start cannot be recalled; only attempt.stop can be requested.',
    ];
  }
  const params = command.params;
  if (params.setting === 'role.launch') {
    return [`Sets the launch model for role ${params.role} to ${params.cli}/${params.model} with effort ${params.effort} on runtime ${command.runtime_id} at config revision ${command.expected.config_rev}, for task ${command.task_id} at revision ${command.task_rev}.`];
  }
  return [
    `Turns the Task Advisor ${params.enabled ? 'on' : 'off'} on runtime ${command.runtime_id} at config revision ${command.expected.config_rev}, for task ${command.task_id} at revision ${command.task_rev}.`,
    'Advisor output is never execution authority.',
  ];
}

/** Renders a deterministic card and its canonical digest from the same validated snapshot. */
export function renderCommandCard(snapshot: CardSnapshot): CardView {
  const { command, principal, scope } = snapshot;
  const dispatch = command.op === 'dispatch.start' ? command : null;
  const draft: CommandCard = {
    v: 1,
    kind: 'command',
    action: command.op,
    subject: {
      kind: 'command', id: command.idem_key, task_id: command.task_id, task_rev: command.task_rev, config_rev: command.expected.config_rev,
    },
    workspace_id: command.workspace_id,
    runtime_id: command.runtime_id,
    task: { id: command.task_id, rev: command.task_rev },
    attempt: dispatch ? dispatch.attempt : null,
    target: dispatch ? { sid: dispatch.params.target.sid } : null,
    launch: dispatch ? {
      role: dispatch.params.role, cli: dispatch.params.cli, model: dispatch.params.model, effort: dispatch.params.effort,
      paths: [...dispatch.params.paths], wave: dispatch.params.wave, loop: dispatch.params.loop,
    } : null,
    config_change: command.op === 'config.set' ? { config_rev: command.expected.config_rev, to: command.params } : null,
    scope: scope === null ? null : {
      scope_id: scope.scope_id, rev: scope.rev, expires_at_ms: scope.expires_at_ms, loop: scope.loop,
      roles: [...scope.roles], target_prefixes: [...scope.target_prefixes],
      parallelism: scope.caps.max_workers === null && scope.caps.max_waves === null ? 'resource_chosen' : 'capped',
      caps: {
        max_workers: scope.caps.max_workers, max_waves: scope.caps.max_waves,
        spend_ceiling: scope.caps.spend_ceiling === null ? null : { unit: scope.caps.spend_ceiling.unit, amount: scope.caps.spend_ceiling.amount },
      },
    },
    expires_at_ms: command.expires_at_ms,
    requested_by: { kind: principal.kind, user_id: principal.user_id, credential_id: principal.credential_id },
    consequences: consequences(command),
  };
  const card = snapshotJson(draft, LIMITS.recordBytes) as CommandCard;
  return Object.freeze({ card, card_sha256: canonicalDigest(card) });
}
