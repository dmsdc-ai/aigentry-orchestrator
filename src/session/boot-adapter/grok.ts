// #1083: grok 0.2.93 exposes --rules for additive system instructions.
// boot-prepare appends the final staged role and session contract to that flag.
import { makeAdapter } from "./common.js";

export function grokAdapter() {
  return makeAdapter({
    name: "grok",
    min_version: "0.2.93",
    buildArgvEnv: () => ({
      argv: ["grok", "--always-approve", "-m", process.env.AIGENTRY_GROK_MODEL || "grok-4.6",
        ...(process.env.AIGENTRY_GROK_EFFORT ? ["--reasoning-effort", process.env.AIGENTRY_GROK_EFFORT] : [])], // #1084 opt-in
      env: {},
    }),
  });
}
