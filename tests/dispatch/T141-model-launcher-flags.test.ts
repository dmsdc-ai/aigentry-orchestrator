import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { geminiBinary, geminiAdapter } from "../../src/session/boot-adapter/gemini.js";
import { fixture } from "./model-router-fixtures.js";

function refusal(f: ReturnType<typeof fixture>, cli: string, withRole: boolean, env: NodeJS.ProcessEnv = {}) {
  const r = f.dispatch([...f.spawnArgs, "--cli", cli, ...(withRole ? ["--role", "coder"] : [])], env);
  if (!withRole) {
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, new RegExp(`SANDBOX_CLI_UNSUPPORTED: ${cli}`));
  } else {
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, new RegExp(`SANDBOX_CLI_UNSUPPORTED: ${cli}`));
  }
  assert.equal(existsSync(f.env.OPEN_LOG!), false, "refused before terminal port");
  assert.equal(existsSync(f.env.PARENT_MODEL_LOG!), false, "refused before delivery port");
  assert.equal(existsSync(f.env.WORK_LOG!), false, "no model/work execution");
}

function bootCommand(f: ReturnType<typeof fixture>, cli: string, env: NodeJS.ProcessEnv = {}): string[] {
  const r = f.boot(cli, env);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
  const prepared = JSON.parse(r.stdout);
  assert.match(readFileSync(prepared.spawn_cli, "utf8"), /exit 78/);
  assert.equal(existsSync(f.env.WORK_LOG!), false);
  return prepared.argv;
}

for (const cli of ["codex", "grok", "gemini"]) for (const withRole of [false, true]) {
  test(`T141: ${cli} ${withRole ? "role" : "plain"} preserves binary/model flags with confinement admission`, () => {
    const f = fixture();
    try {
      let argv: string[];
      if (cli === "codex" && withRole) {
        const r = f.dispatch([...f.spawnArgs, "--cli", cli, "--role", "coder"]);
        assert.equal(r.status, 0, r.stderr);
        assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
        argv = f.manifest().command;
        assert.equal(argv[0], join(f.bin, "codex"));
        assert.equal(argv.includes("--dangerously-bypass-approvals-and-sandbox"), false);
        assert.equal(argv[argv.indexOf("--sandbox") + 1], "danger-full-access");
        assert.match(readFileSync(join(f.manifest().env.CODEX_HOME!, "config.toml"), "utf8"), /exclude_slash_tmp = true/);
      } else {
        refusal(f, cli, withRole);
        // Real boot/config behavior remains positive; inert output does not grant dispatch eligibility.
        argv = bootCommand(f, cli);
        assert.equal(argv[0], cli === "gemini" ? "agy" : cli);
      }
      if (cli === "codex") assert.deepEqual(argv.slice(1, 7), ["-m", "gpt-6-astra", "-c", "model_reasoning_effort=high", "-c", "check_for_update_on_startup=false"]);
      if (cli === "grok") assert.deepEqual(argv.slice(1, 4), ["--always-approve", "-m", "grok-4.6"]);
      if (cli === "gemini") {
        assert.deepEqual(argv.slice(1, 4), ["--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
        assert.equal(argv.includes("--approval-mode"), false);
        assert.equal(argv.includes("--skip-trust"), false);
        assert.equal(geminiAdapter("agy").homeEnv, null);
      }
      assert.equal(argv.includes("--reasoning-effort"), false);
      assert.equal(argv.includes("--effort"), false);
      if (withRole && cli !== "codex") {
        assert.ok(argv.includes(cli === "grok" ? "--rules" : "--prompt-interactive"));
        const prompt = argv[argv.indexOf(cli === "grok" ? "--rules" : "--prompt-interactive") + 1]!;
        assert.match(prompt, /FIXTURE-ROLE/);
        assert.match(prompt, /Session boot contract/);
      }
    } finally { f.cleanup(); }
  });
}

test("T141: Gemini CLI remains available as explicit binary fallback with linked refusal", () => {
  const f = fixture();
  try {
    const env = { AIGENTRY_GEMINI_BINARY: "gemini" };
    refusal(f, "gemini", true, env);
    assert.deepEqual(bootCommand(f, "gemini", env).slice(0, 6), ["gemini", "-m", "gemini-2.5-flash", "--approval-mode", "yolo", "--skip-trust"]);
    assert.equal(geminiAdapter("gemini").homeEnv, "GEMINI_CLI_HOME");
    assert.equal(geminiBinary({ PATH: f.bin }), "agy");
    rmSync(join(f.bin, "agy"));
    assert.equal(geminiBinary({ PATH: f.bin }), "gemini");
  } finally { f.cleanup(); }
});

test("T141: routed Grok model remains one literal argv value with linked refusal", () => {
  const f = fixture();
  try {
    const value = "grok-4.6; touch SHOULD-NOT-EXECUTE", env = { AIGENTRY_GROK_MODEL: value };
    refusal(f, "grok", true, env);
    assert.deepEqual(bootCommand(f, "grok", env).slice(1, 4), ["--always-approve", "-m", value]);
    assert.equal(existsSync(join(f.root, "SHOULD-NOT-EXECUTE")), false);
  } finally { f.cleanup(); }
});

for (const withRole of [false, true]) for (const [cli, env, expected] of [
  ["codex", { AIGENTRY_CODEX_EFFORT: "xhigh" }, ["-m", "gpt-6-astra", "-c", "model_reasoning_effort=xhigh", "-c", "check_for_update_on_startup=false"]],
  ["codex", { AIGENTRY_CODEX_EFFORT: "high; touch SHOULD-NOT-EXECUTE" }, ["-m", "gpt-6-astra", "-c", "model_reasoning_effort=high; touch SHOULD-NOT-EXECUTE", "-c", "check_for_update_on_startup=false"]],
  ["grok", { AIGENTRY_GROK_EFFORT: "xhigh" }, ["--always-approve", "-m", "grok-4.6", "--reasoning-effort", "xhigh"]],
  ["gemini", { AIGENTRY_GEMINI_EFFORT: "high" }, ["--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions", "--effort", "high"]],
] as const) test(`T141: ${cli} ${withRole ? "role" : "plain"} preserves ${Object.keys(env)[0]} with confinement admission`, () => {
  const f = fixture();
  try {
    let argv: readonly string[];
    if (cli === "codex" && withRole) {
      const r = f.dispatch([...f.spawnArgs, "--cli", cli, "--role", "coder"], env);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
      argv = f.manifest().command;
    } else {
      refusal(f, cli, withRole, env);
      argv = bootCommand(f, cli, env);
    }
    assert.deepEqual(argv.slice(1, expected.length + 1), expected);
    assert.equal(existsSync(join(f.root, "SHOULD-NOT-EXECUTE")), false);
  } finally { f.cleanup(); }
});

test("T141: capped researcher route retains Gemini selection but refuses before terminal/model/delivery", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.aig, "instructions/roles/researcher.md"), "# RESEARCHER\nFIXTURE-ROLE\n");
    const r = f.dispatch([...f.spawnArgs, "--role", "researcher"], { AIGENTRY_CLI_CAP_CODEX: "0" });
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /gpt-6-astra -> gemini \(gemini\)/);
    assert.match(r.stderr, /SANDBOX_CLI_UNSUPPORTED: gemini/);
    assert.equal(f.calls(), 1);
    assert.equal(existsSync(f.env.OPEN_LOG!), false);
    assert.equal(existsSync(f.env.PARENT_MODEL_LOG!), false);
    assert.equal(existsSync(f.env.WORK_LOG!), false);
    assert.deepEqual(bootCommand(f, "gemini", { AIGENTRY_GEMINI_MODEL: "gemini-3.8-flash-high" }).slice(0, 4),
      ["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
  } finally { f.cleanup(); }
});
