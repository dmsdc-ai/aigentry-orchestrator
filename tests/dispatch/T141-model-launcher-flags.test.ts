import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { geminiBinary } from "../../src/session/boot-adapter/gemini.js";
import { fixture as routingFixture } from "./model-router-fixtures.js";

// Default assertions must not inherit the operator's model/effort preferences.
function fixture() {
  const f = routingFixture();
  for (const key of Object.keys(f.env)) {
    if (/^AIGENTRY_.*_(EFFORT|MODEL)$/.test(key)) delete f.env[key];
  }
  return f;
}

for (const cli of ["codex", "grok", "gemini"]) for (const withRole of [false, true]) {
  test(`T141: ${cli} ${withRole ? "role" : "plain"} launcher preserves binary/model flags`, () => {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--cli", cli, ...(withRole ? ["--role", "coder"] : [])]);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
      const launcher = readFileSync(join(f.aig, `sessions/router-fixture/${withRole ? "boot/launcher.sh" : "guard/worker-launcher.sh"}`), "utf8");
      if (cli === "codex") assert.match(launcher, /exec -a codex codex -m gpt-6-astra -c model_reasoning_effort=high -c check_for_update_on_startup=false /);
      if (cli === "grok") assert.match(launcher, /exec -a grok grok --always-approve -m grok-4.6/);
      if (cli === "gemini") {
        assert.match(launcher, /exec -a gemini agy --model gemini-3.8-flash-high --dangerously-skip-permissions/);
        assert.doesNotMatch(launcher, /--approval-mode|--skip-trust|export GEMINI_CLI_HOME/);
      }
      // #1084: grok/agy effort is opt-in — nothing emitted while the knob is unset.
      assert.doesNotMatch(launcher, /--reasoning-effort| --effort /);
      // grok has no context-file contract: its contract rides --rules on the launcher.
      // codex/gemini(agy) take the additive staged cwd file instead (T146 pins agy's).
      if (withRole && cli === "grok") {
        assert.match(launcher, /--rules /);
        assert.match(launcher, /FIXTURE-ROLE/);
        assert.match(launcher, /Session boot contract/);
      }
      if (withRole && cli !== "grok") assert.doesNotMatch(launcher, /--prompt-interactive|FIXTURE-ROLE|Session boot contract/);
    } finally { f.cleanup(); }
  });
}

test("T141: Gemini CLI remains available as explicit binary fallback", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "gemini", "--role", "coder"], { AIGENTRY_GEMINI_BINARY: "gemini" });
    assert.equal(r.status, 0, r.stderr);
    const launcher = readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8");
    assert.match(launcher, /exec -a gemini gemini -m gemini-2.5-flash --approval-mode yolo --skip-trust/);
    assert.match(launcher, /export GEMINI_CLI_HOME=/);
    assert.equal(geminiBinary({ PATH: f.bin }), "agy");
    rmSync(join(f.bin, "agy"));
    assert.equal(geminiBinary({ PATH: f.bin }), "gemini");
  } finally { f.cleanup(); }
});

test("T141: routed Grok model is shell-quoted and preserved in role launcher", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "grok", "--role", "coder"], { AIGENTRY_GROK_MODEL: "grok-4.6; touch SHOULD-NOT-EXECUTE" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(f.aig, "sessions/router-fixture/boot/launcher.sh"), "utf8"),
      /--always-approve -m 'grok-4.6; touch SHOULD-NOT-EXECUTE'/);
  } finally { f.cleanup(); }
});

// #1084 effort knobs reach both the plain launcher (defaultCliFlags) and the role launcher (boot adapter argv).
for (const withRole of [false, true]) for (const [cli, env, expect] of [
  ["codex", { AIGENTRY_CODEX_EFFORT: "xhigh" }, /-m gpt-6-astra -c model_reasoning_effort=xhigh -c check_for_update_on_startup=false/],
  ["codex", { AIGENTRY_CODEX_EFFORT: "high; touch SHOULD-NOT-EXECUTE" }, /'(model_reasoning_effort=)?high; touch SHOULD-NOT-EXECUTE'/],
  ["grok", { AIGENTRY_GROK_EFFORT: "xhigh" }, /--always-approve -m grok-4.6 --reasoning-effort xhigh/],
  ["gemini", { AIGENTRY_GEMINI_EFFORT: "high" }, /--model gemini-3.8-flash-high --dangerously-skip-permissions --effort high/],
] as const) test(`T141: ${cli} ${withRole ? "role" : "plain"} launcher carries ${Object.keys(env)[0]}`, () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", cli, ...(withRole ? ["--role", "coder"] : [])], env);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
    assert.match(readFileSync(join(f.aig, `sessions/router-fixture/${withRole ? "boot/launcher.sh" : "guard/worker-launcher.sh"}`), "utf8"), expect);
  } finally { f.cleanup(); }
});
