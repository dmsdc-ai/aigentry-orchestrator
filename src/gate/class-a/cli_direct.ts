// ADR-MF #15 Class A — direct CLI subprocess spawn wrapper.
// For invocations that bypass telepty/cmux (e.g., a builder spawning a tester
// directly). When cli ∈ {claude,codex,gemini}, the dispatcher is the natural
// place to route through #104 boot-adapter; the gate stays surgical.
import {
  runClassAGate,
  type ClassARunOpts,
  type GateOutcome,
  type SpawnRequest,
} from "../common.js";
import type { CliKind } from "../../session/boot-adapter/index.js";

export interface CliDirectArg {
  cli?: CliKind;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
}

export type GatedCliDirectOptions<TResult> = Omit<
  ClassARunOpts<CliDirectArg, TResult>,
  "withEffectiveRole"
>;

export function gatedCliDirectSpawn<TResult>(
  req: SpawnRequest,
  arg: CliDirectArg,
  opts: GatedCliDirectOptions<TResult>,
): Promise<GateOutcome<TResult>> {
  return runClassAGate(req, arg, {
    ...opts,
    withEffectiveRole: (a, role): CliDirectArg => ({
      ...a, env: { ...a.env, AIGENTRY_EFFECTIVE_ROLE: role },
    }),
  });
}
