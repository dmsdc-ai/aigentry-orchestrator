import { awareness } from "./awareness.js";
import { environmentHome, readConfig } from "./storage.js";
import { projectEnvironment, readLegacy, resolveSettings } from "./resolve.js";
import type { Settings } from "./contract.js";
import { DESCRIPTORS } from "./descriptors.js";
import { dispatchOptionArgs, parseDispatchInvocation } from "./invocation.js";

export function invocationContext(argv: readonly string[], cwd = process.cwd()) {
  return parseDispatchInvocation(dispatchOptionArgs(argv), cwd).context;
}
export function bootstrapEnvironment(env: NodeJS.ProcessEnv, context: { targetCwd?: string; role?: string; flags?: Settings } = {}) {
  const home = environmentHome(env);
  const resolution = resolveSettings({ config: readConfig(home), env, legacy: readLegacy(home), ...context });
  return { env: projectEnvironment({ ...env, AIGENTRY_HOME: home }, resolution), resolution, awareness: awareness(resolution) };
}
// Carry only the registered nonsecret settings to the shell's real exec. Node stdout
// cannot export into its parent shell; the existing one-argument-per-line protocol stays.
export function invocationAssignments(env: NodeJS.ProcessEnv): string[] {
  return ["AIGENTRY_HOME", ...DESCRIPTORS.flatMap((d) => d.aliases)]
    .filter((key) => env[key] !== undefined).map((key) => `${key}=${env[key]!}`);
}
