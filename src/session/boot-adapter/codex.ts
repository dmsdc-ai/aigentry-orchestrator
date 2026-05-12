// ADR-MF #13 — Codex adapter (ADR §4.5.1 row 2 + §4.5.1.1).
// Strategy: scratch control cwd + env-var suppression + native --cd for code cwd.
import { makeAdapter } from "./common.js";

// TODO: empirical verification before #11 hard-fail (OQ1).
export const CODEX_MIN_VERSION = "1.0.0";
// TODO: confirm with upstream CLI before #11 hard-fail (OQ5).
// UPSTREAM-GAP: speculative env-var names — changing them is a one-line edit.
export const CODEX_NO_AUTOLOAD_ENV = "CODEX_NO_CONTEXT_AUTOLOAD";
export const CODEX_SYSTEM_PROMPT_ENV = "CODEX_SYSTEM_PROMPT_FILE";
export const CODEX_CODE_CWD_FLAG = "--cd";

export function codexAdapter() {
  return makeAdapter({
    name: "codex",
    min_version: CODEX_MIN_VERSION,
    needScratchCwd: true,
    codeCwdFlag: CODEX_CODE_CWD_FLAG,
    buildArgvEnv: ({ ctx, prompt_file }) => ({
      argv: ["codex", CODEX_CODE_CWD_FLAG, ctx.cwd],
      env: {
        [CODEX_NO_AUTOLOAD_ENV]: "1",
        [CODEX_SYSTEM_PROMPT_ENV]: prompt_file,
      },
    }),
  });
}
