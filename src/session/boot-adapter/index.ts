// ADR-MF #13 — boot-adapter registry + public surface.
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { geminiAdapter } from "./gemini.js";
import {
  BootAdapterError,
  CLI_KINDS,
  isCliKind,
  type BootAdapter,
  type CliKind,
} from "./types.js";

const FACTORIES: Readonly<Record<CliKind, () => BootAdapter>> = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
});

export function getBootAdapter(cli: string): BootAdapter {
  if (!isCliKind(cli)) {
    throw new BootAdapterError(
      "UNSUPPORTED_CLI",
      `unknown CLI ${JSON.stringify(cli)}; supported: ${CLI_KINDS.join(", ")}`,
    );
  }
  return FACTORIES[cli]();
}

export { CLI_KINDS, isCliKind, BootAdapterError };
export type {
  BootAdapter, BootCommand, BootError, BootErrorCode,
  BuildOptions, CliKind, SelfTestInput, SelfTestResult,
} from "./types.js";
export { memoryBootFs, nodeBootFs, type BootFS } from "./boot-fs.js";
export {
  mockSpawner, nodeSpawner,
  type MockScript, type RunResult, type Spawner,
} from "./spawner.js";
export { runSelfTest, semverGte } from "./self-test.js";
export { claudeAdapter, CLAUDE_MIN_VERSION } from "./claude.js";
export {
  codexAdapter, CODEX_MIN_VERSION, CODEX_NO_AUTOLOAD_ENV,
  CODEX_SYSTEM_PROMPT_ENV, CODEX_CODE_CWD_FLAG,
} from "./codex.js";
export {
  geminiAdapter, GEMINI_MIN_VERSION, GEMINI_NO_AUTOLOAD_ENV,
  GEMINI_SYSTEM_FLAG, GEMINI_CODE_CWD_FLAG,
} from "./gemini.js";
