// ADR-MF #15 Class A — telepty inject wrapper.
// OQ-15-1: argv is OPAQUE (telepty strings flow verbatim) — see SPEC §3.2.
// Delegates the validate→persist→dispatch flow to runClassAGate (../common).
import {
  runClassAGate,
  type ClassARunOpts,
  type GateOutcome,
  type SessionContext,
  type SpawnRequest,
} from "../common.js";

export interface TeleptyDispatchArg {
  target_session_id: string;
  payload: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}

export type GatedTeleptyOptions<TResult> = Omit<
  ClassARunOpts<TeleptyDispatchArg, TResult>,
  "withEffectiveRole"
>;

export function gatedTeleptyInject<TResult>(
  req: SpawnRequest,
  arg: TeleptyDispatchArg,
  opts: GatedTeleptyOptions<TResult>,
): Promise<GateOutcome<TResult>> {
  return runClassAGate(req, arg, {
    ...opts,
    withEffectiveRole: (a, role): TeleptyDispatchArg => ({
      ...a, env: { ...a.env, AIGENTRY_EFFECTIVE_ROLE: role },
    }),
  });
}

export type { SessionContext };
