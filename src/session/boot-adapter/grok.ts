// #1083: grok 0.2.93 exposes --rules for additive system instructions.
// boot-prepare appends the final staged role and session contract to that flag.
import { makeAdapter } from "./common.js";
import { envOrDefault, launchConfig, optInEnv } from "./launch-config.js";

export function grokAdapter() {
  return makeAdapter({
    name: "grok",
    min_version: "0.2.93",
    buildArgvEnv: () => {
      const model = envOrDefault(process.env, "AIGENTRY_GROK_MODEL", "grok-4.6");
      const effort = optInEnv(process.env, "AIGENTRY_GROK_EFFORT"); // #1084 opt-in
      return {
        argv: ["grok", "--always-approve", "-m", model.arg,
          ...(effort.arg !== null ? ["--reasoning-effort", effort.arg] : [])],
        env: {},
        launch: launchConfig("grok", model, effort),
      };
    },
  });
}
