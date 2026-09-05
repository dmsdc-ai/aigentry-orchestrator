import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { geminiBinary } from "../../src/session/boot-adapter/gemini.js";
import { fixture } from "./model-router-fixtures.js";

for (const cli of ["codex", "grok", "gemini"]) for (const withRole of [false, true]) {
  test(`T141: ${cli} ${withRole ? "role" : "plain"} launcher preserves binary/model flags`, () => {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--cli", cli, ...(withRole ? ["--role", "coder"] : [])]);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
      const launcher = readFileSync(join(f.aig, `sessions/router-fixture/${withRole ? "boot/launcher.sh" : "guard/worker-launcher.sh"}`), "utf8");
      if (cli === "codex") assert.match(launcher, /exec -a codex codex -m gpt-6-astra /);
      if (cli === "grok") assert.match(launcher, /exec -a grok grok --always-approve -m grok-4.6/);
      if (cli === "gemini") {
        assert.match(launcher, /exec -a gemini agy --model gemini-3.8-flash-high --dangerously-skip-permissions/);
        assert.doesNotMatch(launcher, /--approval-mode|--skip-trust|export GEMINI_CLI_HOME/);
      }
      if (withRole && cli !== "codex") {
        assert.match(launcher, cli === "grok" ? /--rules / : /--prompt-interactive /);
        assert.match(launcher, /FIXTURE-ROLE/);
        assert.match(launcher, /Session boot contract/);
      }
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
