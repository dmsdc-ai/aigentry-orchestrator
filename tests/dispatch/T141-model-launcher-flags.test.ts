import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        if (process.platform === "win32") {
          // #1167 P6: no OS sandbox runtime, so no argv is built; the refusal names the binary/model/effort the decision carries.
          assert.deepEqual(f.refused(r), { cli: "codex", model: "gpt-6-astra", decided_by: "explicit", effort: null, executable: join(f.bin, "codex") });
          return;
        }
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
      // #1148 (contract delta §2/§6 U3): a resolver-managed codex spawn never consults the hidden `high`
      // literal; the Codex surface documents no default effort, so the flag is omitted. The legacy
      // boot path (no decision) keeps its literal unchanged.
      if (cli === "codex" && withRole) {
        assert.deepEqual(argv.slice(1, 5), ["-m", "gpt-6-astra", "-c", "check_for_update_on_startup=false"]);
        assert.equal(argv.some((a) => a.startsWith("model_reasoning_effort=")), false);
      } else if (cli === "codex") assert.deepEqual(argv.slice(1, 7), ["-m", "gpt-6-astra", "-c", "model_reasoning_effort=high", "-c", "check_for_update_on_startup=false"]);
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
    // #1167: on win32 the fixture's agy.cmd shim is itself an agy hit, so removing agy removes it too.
    if (process.platform === "win32") rmSync(join(f.bin, "agy.cmd"));
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
      if (process.platform === "win32") {
        // #1167 P6: the refusal names the effort the decision carries verbatim (one literal value, never executed).
        assert.deepEqual(f.refused(r), { cli: "codex", model: "gpt-6-astra", decided_by: "explicit", effort: Object.values(env)[0], executable: join(f.bin, "codex") });
        assert.equal(existsSync(join(f.root, "SHOULD-NOT-EXECUTE")), false);
        return;
      }
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

// C3-a: this used to pin `gpt-6-astra -> gemini (gemini)` then SANDBOX_CLI_UNSUPPORTED (exit 78): the cap fallback
// took the fixture profile's researcher row (gemini), a CLI the confined spawn refuses. `--cli auto` now asks the
// router for confinable CLIs only, so the fallback lands on the next confinable candidate and spawns it.
// #1206 D7: no classifier; the researcher row (gemini) is filtered, so the router's pick is Opus and the cap is Claude's.
test("T141: capped researcher route falls to a confinable CLI, never to Gemini", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.aig, "instructions/roles/researcher.md"), "# RESEARCHER\nFIXTURE-ROLE\n");
    const r = f.dispatch([...f.spawnArgs, "--role", "researcher"], { AIGENTRY_CLI_CAP_CLAUDE: "0" });
    assert.match(r.stderr, /opus-5 -> gpt-6-astra \(codex\)/);
    assert.doesNotMatch(r.stderr, /SANDBOX_CLI_UNSUPPORTED/);
    assert.equal(f.calls(), 0);
    if (process.platform === "win32") {
      const d = f.refused(r);
      assert.deepEqual([d.cli, d.model, d.decided_by, d.capped_cli], ["codex", "gpt-6-astra", "table-capped", "claude"]);
      return;
    }
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.manifest().cli, "codex");
    assert.deepEqual(f.manifest().command.slice(1, 3), ["-m", "gpt-6-astra"]);
  } finally { f.cleanup(); }
});

// #1206 S1-C: a role × task-class policy profile (S1-A syntax). Effort tokens are per CLI.
const POLICY_PROFILE = `---
measured_at: 2026-10-09
models:
  - {label: opus-5, cli: claude, model: "claude-opus-5[1m]"}
  - {label: gpt-6-astra, cli: codex, model: "gpt-6-astra"}
  - {label: grok-4.6, cli: grok, model: "grok-4.6"}
default_table:
  coder: gpt-6-astra
  coder.integration: opus-5
role_effort:
  coder: medium
  coder.integration: high
role_fallback:
  coder: grok-4.6 opus-5
  coder.integration: gpt-6-astra
---
Fixture only. PROFILE-BODY-T141-POLICY
`;

function policy(f: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  const file = join(f.root, "policy-profile.md");
  writeFileSync(file, POLICY_PROFILE);
  return { AIGENTRY_ROUTER_PROFILE: file };
}

/** The routed tuple a fresh spawn applied: the sealed argv on POSIX, the refusal's decision on win32. */
function applied(f: ReturnType<typeof fixture>, r: ReturnType<ReturnType<typeof fixture>["dispatch"]>) {
  if (process.platform === "win32") {
    const d = f.refused(r);
    return { cli: d.cli, model: d.model, effort: d.effort ?? null, decided_by: d.decided_by, capped_cli: d.capped_cli };
  }
  assert.equal(r.status, 0, r.stderr);
  const m = f.manifest(), cmd = m.command;
  const effort = m.cli === "codex" ? cmd.find((a) => a.startsWith("model_reasoning_effort="))?.slice(23) ?? null
    : cmd.includes("--effort") ? cmd[cmd.indexOf("--effort") + 1]! : null;
  const events = readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const event = events.find((e) => e[e.indexOf("--subtype") + 1] === "dispatch_start")!;
  const payload = JSON.parse(event[event.indexOf("--payload-json") + 1]!);
  assert.equal(payload.decision.selected.effort.token, effort, "the argv carries the decision's effort");
  return { cli: m.cli, model: cmd[cmd.indexOf(m.cli === "codex" ? "-m" : "--model") + 1], effort,
    decided_by: payload.route.decided_by, capped_cli: payload.route.capped_cli, state: payload.decision.selected.effort.state };
}

test("T141: --task-class is forwarded as the router's --class; the row's effort reaches the argv as policy", () => {
  for (const [args, expected] of [
    [["--task-class", "integration"], { cli: "claude", model: "claude-opus-5[1m]", effort: "high" }],
    [[], { cli: "codex", model: "gpt-6-astra", effort: "medium" }],
    [["--task-class", "unlisted"], { cli: "codex", model: "gpt-6-astra", effort: "medium" }],
  ] as const) {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--role", "coder", ...args], policy(f));
      const got = applied(f, r);
      assert.deepEqual([got.cli, got.model, got.effort, got.decided_by, got.capped_cli],
        [expected.cli, expected.model, expected.effort, "table", undefined], JSON.stringify(args));
      if (process.platform !== "win32") assert.equal((got as { state?: string }).state, "policy");
      assert.equal(f.calls(), 0, "D7: the ref never reaches the classifier");
      assert.doesNotMatch(r.stderr, /model router unavailable/);
    } finally { f.cleanup(); }
  }
});

test("T141: an invalid --task-class refuses with exit 4 before routing or any effect", () => {
  for (const bad of ["Integration", "1x", "a b", "x".repeat(33), "", "-x"]) {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--role", "coder", "--task-class", bad], policy(f));
      assert.equal(r.status, 4, r.stderr);
      assert.match(r.stderr, /dispatch\.sh: --task-class: invalid class/);
      assert.equal(existsSync(f.env.OPEN_LOG!), false);
      assert.equal(existsSync(f.env.TELEMETRY_LOG!), false);
      assert.equal(f.calls(), 0);
    } finally { f.cleanup(); }
  }
});

test("T141: a router effort that is not a profile token is an invalid router result (emergency route)", () => {
  const good = { cli: "codex", model: "gpt-6-astra", label: "gpt-6-astra" };
  for (const route of [
    { ...good, decided_by: "table", reason: "r", effort: "high; touch SHOULD-NOT-EXECUTE", candidates: [good] },
    { ...good, decided_by: "table", reason: "r", effort: 7, candidates: [good] },
    { ...good, decided_by: "table", reason: "r", effort: "medium", candidates: [{ ...good, effort: "MEDIUM" }] },
    { ...good, decided_by: "table", reason: "r", candidates: [null] },
  ]) {
    const f = fixture();
    try {
      const dir = join(f.root, "fake-router");
      mkdirSync(dir);
      writeFileSync(join(dir, "model-router.mjs"), `process.stdout.write(${JSON.stringify(JSON.stringify(route))} + "\\n");\n`);
      const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { DISPATCH_SCRIPT_DIR: dir });
      assert.match(r.stderr, /model router unavailable; using emergency table default/, JSON.stringify(route));
      const got = applied(f, r);
      assert.deepEqual([got.cli, got.model, got.decided_by], ["claude", "claude-opus-5[1m]", "table"]);
      assert.equal(existsSync(join(f.root, "SHOULD-NOT-EXECUTE")), false);
    } finally { f.cleanup(); }
  }
});

test("T141: an unroutable primary walks the router's candidates in order, carrying the candidate's effort", () => {
  // Codex capped: the coder row's fallback list is grok (never confinable, filtered by the router) then Opus.
  let f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { ...policy(f), AIGENTRY_CLI_CAP_CODEX: "0" });
    assert.match(r.stderr, /codex at cap \(1 live, AIGENTRY_CLI_CAP_CODEX=0\); gpt-6-astra -> opus-5 \(claude\)/);
    const got = applied(f, r);
    assert.deepEqual([got.cli, got.model, got.effort, got.decided_by, got.capped_cli],
      ["claude", "claude-opus-5[1m]", "medium", "table-capped", "codex"]);
    if (process.platform !== "win32") assert.equal((got as { state?: string }).state, "policy");
  } finally { f.cleanup(); }
  // No codex credential file (stat only): skipped like a cap, never a raw seedAuth ENOENT.
  f = fixture();
  try {
    rmSync(join(f.env.CODEX_HOME!, "auth.json"));
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"]);
    assert.match(r.stderr, /codex has no credential file; gpt-6-astra -> opus-5 \(claude\)/);
    assert.doesNotMatch(r.stderr, /ENOENT/);
    const got = applied(f, r);
    assert.deepEqual([got.cli, got.decided_by, got.capped_cli], ["claude", "table-capped", "codex"]);
  } finally { f.cleanup(); }
});

test("T141: no routable confined candidate refuses with exit 78 before any effect", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { ...policy(f), AIGENTRY_CLI_CAP_CODEX: "0", AIGENTRY_CLI_CAP_CLAUDE: "0" });
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /dispatch\.sh: ROUTE_CANDIDATES_EXHAUSTED: codex at cap .*no unconfined fallback\); nothing was spawned/);
    assert.doesNotMatch(r.stderr, /SANDBOX_PLATFORM_UNSUPPORTED/);
    for (const effect of [f.env.OPEN_LOG!, f.env.TELEMETRY_LOG!, f.env.PARENT_MODEL_LOG!]) assert.equal(existsSync(effect), false, effect);
    assert.equal(f.calls(), 0);
  } finally { f.cleanup(); }
});

test("T141: an explicit grok/gemini keeps SANDBOX_CLI_UNSUPPORTED with a task class; explicit at cap still spawns", () => {
  for (const cli of ["grok", "gemini"]) {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--cli", cli, "--role", "coder", "--task-class", "integration"], policy(f));
      assert.equal(r.status, 78, r.stderr);
      assert.match(r.stderr, new RegExp(`SANDBOX_CLI_UNSUPPORTED: ${cli}`));
      assert.equal(existsSync(f.env.OPEN_LOG!), false);
    } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "codex", "--role", "coder", "--task-class", "integration"],
      { ...policy(f), AIGENTRY_CLI_CAP_CODEX: "0" });
    assert.equal(r.stderr.match(/WARNING codex at cap \(1 live, AIGENTRY_CLI_CAP_CODEX=0\); explicit --cli codex spawns anyway/g)?.length, 1);
    const got = applied(f, r);
    assert.deepEqual([got.cli, got.model, got.effort, got.decided_by], ["codex", "gpt-6-astra", null, "explicit"]);
  } finally { f.cleanup(); }
});
