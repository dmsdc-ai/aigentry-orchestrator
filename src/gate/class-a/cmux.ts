// ADR-MF #15 Class A — cmux session/workspace spawn wrapper.
// Mirror of telepty.ts; delegates to runClassAGate (../common).
import {
  runClassAGate,
  type ClassARunOpts,
  type GateOutcome,
  type SpawnRequest,
} from "../common.js";

export type CmuxSpawnKind = "session" | "workspace";

export interface CmuxDispatchArg {
  workspace_name: string;
  kind: CmuxSpawnKind;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}

export type GatedCmuxOptions<TResult> = Omit<
  ClassARunOpts<CmuxDispatchArg, TResult>,
  "withEffectiveRole"
>;

export function gatedCmuxSpawn<TResult>(
  req: SpawnRequest,
  arg: CmuxDispatchArg,
  opts: GatedCmuxOptions<TResult>,
): Promise<GateOutcome<TResult>> {
  return runClassAGate(req, arg, {
    ...opts,
    withEffectiveRole: (a, role): CmuxDispatchArg => ({
      ...a, env: { ...a.env, AIGENTRY_EFFECTIVE_ROLE: role },
    }),
  });
}
