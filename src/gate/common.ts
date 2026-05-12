// ADR-MF #15 — Class A/B/C gate shared types + Class A core.
// All three classes reuse enforceSpawn() (#101 / c609e39); this module owns
// the dependency-injection shape and the shared "gate → persist → dispatch"
// flow that the three Class A wrappers (telepty / cmux / cli_direct) thin
// over with surface-specific argument types.
// Constitution: Article 17 무의존 — node stdlib + src/session/* only.
import {
  enforceSpawn,
  SpawnValidationError,
  type EnforceSpawnOptions,
  type EnforceSpawnResult,
  type ValidateSpawnErrorCode,
  type ValidationMode,
} from "../session/validate-spawn.js";
import type { PermissionErrorCode } from "../session/permission-manager.js";
import type { SpawnEvent } from "../telemetry/spawn-events.js";
import type {
  Capability,
  Role,
  SessionContext,
  SpawnClass,
  SpawnRequest,
  TaskSpec,
} from "../session/types.js";

export type SpawnEventEmitter = (e: SpawnEvent) => void;

// Dispatcher = surface-specific "launch the child / call the underlying tool"
// callback, injected so tests use stubs and real callers wire real spawn
// primitives. The gate validates; the dispatcher acts (Rule 29 scope).
export interface Dispatcher<TArg, TResult> {
  (arg: TArg): Promise<TResult> | TResult;
}

export interface GateInvocation {
  request: SpawnRequest;
  parent?: SessionContext;
  proposed_session_id?: string;
  class: SpawnClass;
  surface: string;
}

export type GateError =
  | { code: ValidateSpawnErrorCode | PermissionErrorCode; detail: string }
  | { code: "ERR_MCP_SESSION_CONTEXT_MISSING" | "ERR_MCP_TOOL_UNKNOWN"; detail: string };

export type GateOutcome<TResult> =
  | { ok: true; enforcement: EnforceSpawnResult; result: TResult }
  | { ok: false; enforcement?: EnforceSpawnResult; error: GateError };

export interface GateOptions {
  parent?: SessionContext;
  proposed_session_id?: string;
  mode?: ValidationMode;
  now?: () => Date;
  emit?: SpawnEventEmitter;
}

export function toEnforceOpts(o: GateOptions): EnforceSpawnOptions {
  const out: EnforceSpawnOptions = {};
  if (o.parent !== undefined) out.parent = o.parent;
  if (o.proposed_session_id !== undefined) out.proposed_session_id = o.proposed_session_id;
  if (o.mode !== undefined) out.mode = o.mode;
  if (o.now !== undefined) out.now = o.now;
  if (o.emit !== undefined) out.emit = o.emit;
  return out;
}

// Class A core flow: validate → persist parent (G6 hook) → dispatch.
// `argWithEnvOverlay` lets each wrapper attach AIGENTRY_EFFECTIVE_ROLE without
// this helper knowing the concrete arg shape.
export interface ClassARunOpts<TArg, TResult> extends GateOptions {
  dispatch: Dispatcher<TArg, TResult>;
  ctx_persist?: (ctx: SessionContext) => Promise<void> | void;
  withEffectiveRole: (arg: TArg, role: Role) => TArg;
}

export async function runClassAGate<TArg, TResult>(
  req: SpawnRequest,
  arg: TArg,
  opts: ClassARunOpts<TArg, TResult>,
): Promise<GateOutcome<TResult>> {
  try {
    const enforcement = enforceSpawn(req, toEnforceOpts(opts));
    if (opts.ctx_persist && opts.parent) await opts.ctx_persist(opts.parent);
    const result = await opts.dispatch(opts.withEffectiveRole(arg, enforcement.effective_role));
    return { ok: true, enforcement, result };
  } catch (e) {
    if (e instanceof SpawnValidationError) {
      return { ok: false, error: { code: e.code, detail: e.detail } };
    }
    throw e;
  }
}

export type {
  Capability, Role, SessionContext, SpawnClass, SpawnRequest, TaskSpec,
  EnforceSpawnResult, ValidateSpawnErrorCode, ValidationMode,
  PermissionErrorCode, SpawnEvent,
};
