// ADR-MF #13 — Claude adapter (ADR §4.5.1 row 1).
// Strategy: `claude --bare` suppresses cwd + global CLAUDE.md autoload.
// Resolver (#114) already prepended global content into effective_prompt.
import { makeAdapter } from "./common.js";

// TODO: empirical verification before #11 hard-fail (OQ1).
export const CLAUDE_MIN_VERSION = "1.0.0";

export function claudeAdapter() {
  return makeAdapter({
    name: "claude",
    min_version: CLAUDE_MIN_VERSION,
    needScratchCwd: false,
    codeCwdFlag: null,
    buildArgvEnv: ({ prompt_file }) => ({
      argv: ["claude", "--bare", "--system-prompt-file", prompt_file],
      env: {},
    }),
  });
}
