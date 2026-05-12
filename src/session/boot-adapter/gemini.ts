// ADR-MF #13 — Gemini adapter (ADR §4.5.1 row 3 + §4.5.1.1).
// Strategy: scratch control cwd + env-var suppression + --system + --workspace-root.
import { makeAdapter } from "./common.js";

// TODO: empirical verification before #11 hard-fail (OQ1).
export const GEMINI_MIN_VERSION = "1.0.0";
// TODO: confirm with upstream CLI before #11 hard-fail (OQ5).
// UPSTREAM-GAP: speculative env-var name — see codex.ts for rationale.
export const GEMINI_NO_AUTOLOAD_ENV = "GEMINI_NO_CONTEXT_AUTOLOAD";
export const GEMINI_SYSTEM_FLAG = "--system";
export const GEMINI_CODE_CWD_FLAG = "--workspace-root";

export function geminiAdapter() {
  return makeAdapter({
    name: "gemini",
    min_version: GEMINI_MIN_VERSION,
    needScratchCwd: true,
    codeCwdFlag: GEMINI_CODE_CWD_FLAG,
    buildArgvEnv: ({ ctx, prompt_file }) => ({
      argv: [
        "gemini",
        GEMINI_SYSTEM_FLAG,
        prompt_file,
        GEMINI_CODE_CWD_FLAG,
        ctx.cwd,
      ],
      env: { [GEMINI_NO_AUTOLOAD_ENV]: "1" },
    }),
  });
}
