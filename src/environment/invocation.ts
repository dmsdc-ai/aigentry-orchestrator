import type { Settings } from "./contract.js";
import { validateSetting } from "./descriptors.js";

// One token walk owns dispatch syntax and its bootstrap context. Values belonging
// to another option, help tails and probe payloads are never scanned as options.
export class InvocationError extends Error {}
export interface DispatchInvocation {
  readonly values: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
  readonly observe: readonly string[];
  readonly help: boolean;
  readonly context: { targetCwd: string; role: string; flags: Settings };
}
const VALUE_OPTIONS = new Set([
  "--target", "--ref", "--from", "--timeout-ms", "--track", "--name", "--cwd", "--worktree",
  "--cli", "--model", "--effort", "--executable", "--executable-version", "--role", "--task-class",
  "--task", "--no-task", "--input-root", "--input-manifest", "--input-sha256", "--observe", "--retry-unknown",
  "--binding",
]);
const SWITCH_OPTIONS = new Set(["--spawn-and-dispatch", "--verify-delivered", "--no-verify-started", "--keep-alive"]);
const TUPLE_OPTIONS = [["--model", "model"], ["--effort", "effort"], ["--executable", "executable"], ["--executable-version", "version"]] as const;

export function dispatchOptionArgs(argv: readonly string[]): readonly string[] {
  if (argv[0] !== "__probe") return argv;
  return argv[1] === "verify-delivered" || argv[1] === "dispatch-ref" ? argv.slice(2, -1) : [];
}

export function parseDispatchInvocation(argv: readonly string[], cwd = process.cwd()): DispatchInvocation {
  const values: Record<string, string> = {}, switches = new Set<string>(), seen = new Set<string>(), observe: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length;) {
    const option = argv[i]!;
    if (option === "-h" || option === "--help") { help = true; break; }
    if (SWITCH_OPTIONS.has(option)) { if (seen.has(option)) throw new InvocationError(`ENV_DUPLICATE_OPTION: ${option}`); seen.add(option); switches.add(option); i++; continue; }
    if (!VALUE_OPTIONS.has(option)) throw new InvocationError("DISPATCH_UNKNOWN_ARGUMENT");
    if (option !== "--observe" && seen.has(option)) throw new InvocationError(`ENV_DUPLICATE_OPTION: ${option}`);
    if (option !== "--observe") seen.add(option);
    const value = argv[i + 1];
    if (value === undefined || !value || value.startsWith("-")) {
      throw new InvocationError(`ENV_OPTION_VALUE_REQUIRED: ${option}`);
    }
    if (option === "--cwd" && (Buffer.byteLength(value) > 4096 || /[\u0000-\u001f\u007f]/.test(value))) throw new InvocationError("ENV_INVALID_OPTION: --cwd");
    if (option === "--role" && !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new InvocationError("ENV_INVALID_OPTION: --role");
    if (option === "--task-class" && !/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new InvocationError("--task-class: invalid class (want ^[a-z][a-z0-9-]{0,31}$)");
    if (option === "--retry-unknown" && !value.trim()) throw new InvocationError("--retry-unknown needs a non-empty reason");
    if (option === "--observe") {
      if (observe.length >= 4) throw new InvocationError("--observe may be given at most 4 times");
      observe.push(value);
    } else values[option] = value;
    i += 2;
  }
  const flags: Settings = {}, cli = values["--cli"];
  if (cli !== undefined) flags["dispatch.cli"] = validateSetting("dispatch.cli", cli);
  for (const [option, suffix] of TUPLE_OPTIONS) {
    const value = values[option];
    if (value === undefined) continue;
    if (!cli || !["claude", "codex", "gemini", "grok"].includes(cli)) throw new InvocationError("ENV_FLAG_REQUIRES_EXPLICIT_CLI");
    flags[`${cli}.${suffix}`] = validateSetting(`${cli}.${suffix}`, value);
  }
  return { values, switches, observe, help, context: { targetCwd: values["--cwd"] ?? cwd, role: values["--role"] ?? "orchestrator", flags } };
}
