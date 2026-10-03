// ADR-MF #13 — Claude adapter (ADR §4.5.1 row 1).
// #431 pivot (2026-05-23, hybrid (b-2)+(c)): the original `--bare` design was
// auth-incompatible with the deployed environment — `claude --bare` requires
// ANTHROPIC_API_KEY (`--help`: "OAuth and keychain are never read"), but the
// user runs on OAuth. Empirical probe (`claude --bare --print "hi"`) returned
// "Not logged in · Please run /login" — see ADR addendum 2026-05-23.
//
// Replacement: `--append-system-prompt-file <prompt_file>` appends the role
// contract to claude's default system prompt (OAuth-compatible, verified end-to-end
// with `--print "ROLE"` → "ROLE"). Defense-in-depth via sandbox cwd is contributed
// by bin/boot-prepare.mjs (sets ctx.cwd to $HOME/.aigentry/role-sandbox/<role>-<sid>/
// so cwd CLAUDE.md auto-discovery resolves to a clean directory).
import { makeAdapter } from "./common.js";
import { envOrDefault, launchConfig } from "./launch-config.js";

export const CLAUDE_MIN_VERSION = "1.0.0";

export function claudeAdapter() {
  return makeAdapter({
    name: "claude",
    min_version: CLAUDE_MIN_VERSION,
    // #1162: --model/--effort moved here from boot-prepare (same env names,
    // defaults and argv position) so argv and launch share one resolution.
    buildArgvEnv: ({ prompt_file }) => {
      const model = envOrDefault(process.env, "AIGENTRY_CLAUDE_MODEL", "claude-opus-5");
      const effort = envOrDefault(process.env, "AIGENTRY_CLAUDE_EFFORT", "xhigh");
      return {
        argv: ["claude", "--append-system-prompt-file", prompt_file,
          "--model", model.arg, "--effort", effort.arg],
        env: {},
        launch: launchConfig("claude", model, effort),
      };
    },
  });
}
