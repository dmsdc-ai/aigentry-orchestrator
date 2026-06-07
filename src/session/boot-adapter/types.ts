// ADR-MF #13 — boot-adapter shared types (ADR §4.5.1 + §4.5.1.1).
import type { ResolvedInstructions } from "../resolve-instructions.js";
import type { SessionContext } from "../types.js";
import type { BootFS } from "./boot-fs.js";
import type { Spawner } from "./spawner.js";

export type CliKind = "claude" | "codex" | "gemini";
export const CLI_KINDS: readonly CliKind[] = Object.freeze([
  "claude", "codex", "gemini",
]) as readonly CliKind[];

export function isCliKind(v: unknown): v is CliKind {
  return typeof v === "string" && (CLI_KINDS as readonly string[]).includes(v);
}

// `code_scope_cwd` is SessionContext.cwd surfaced via the CLI's native flag;
// `cwd` is the process cwd (scratch control dir for codex/gemini per §4.5.1.1).
export interface BootCommand {
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  code_scope_cwd: string;
  prompt_file: string;
  expected_digest: string;
}

export type BootErrorCode =
  | "CLI_VERSION_DRIFT"
  | "CLI_NOT_FOUND"
  | "BOOT_DIGEST_MISMATCH"
  | "BOOT_TIMEOUT"
  | "BOOT_LEAK_DETECTED"
  | "UNSUPPORTED_CLI"
  | "ERR_BOOT_ADAPTER_UNSUPPORTED";

export interface BootError { code: BootErrorCode; detail: string }

export class BootAdapterError extends Error {
  readonly code: BootErrorCode;
  constructor(code: BootErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = "BootAdapterError";
  }
}

export interface SelfTestInput {
  ctx: SessionContext;
  resolved: ResolvedInstructions;
  cmd: BootCommand;
  spawner: Spawner;
  timeout_ms?: number;
  // UPSTREAM-GAP (OQ2): leak_markers exercises parsing logic only via mockSpawner
  // until real CLIs implement the #READY? ack.
  leak_markers?: readonly string[];
}

export interface SelfTestResult {
  adapter: CliKind;
  version: string;
  suppression_verified: boolean;
  latency_ms: number;
  errors: readonly BootError[];
}

export interface BuildOptions {
  staging_dir: string;
  fs: BootFS;
  spawner: Spawner;
}

export interface BootAdapter {
  readonly name: CliKind;
  readonly min_version: string;
  // #532 additive role-injection descriptor. `contextFile` is the cwd file the
  // CLI auto-discovers and reads additively (codex `AGENTS.md`, gemini
  // `GEMINI.md`); boot-prepare stages the role prompt there. `null` = flag-based
  // delivery (claude `--append-system-prompt-file`). `homeEnv` is the config-home
  // env boot-prepare redirects to a per-session shadow home so the per-user
  // global doc cannot leak; `homeExclude` lists the global-doc filename(s) the
  // shadow mirror must omit (everything else — auth, settings, skills — is
  // symlink-preserved). Empty/null for claude.
  readonly contextFile: string | null;
  readonly homeEnv: string | null;
  readonly homeExclude: readonly string[];
  buildBootCommand(
    ctx: SessionContext,
    resolved: ResolvedInstructions,
    opts: BuildOptions,
  ): Promise<BootCommand>;
  verifyBootSelfTest(input: SelfTestInput): Promise<SelfTestResult>;
}

export const READY_PREFIX = "READY ";
export const READY_PROMPT = "#READY?\n";
