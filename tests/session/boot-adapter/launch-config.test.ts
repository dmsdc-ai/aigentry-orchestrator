// #1162 G2a-T — LaunchConfig v2 producers: per-door argv + launch agreement,
// normalizeLaunch hostile-input handling, custom makeAdapter / optional metadata.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  getBootAdapter,
  memoryBootFs,
  mockSpawner,
  type BootCommand,
} from "../../../src/session/boot-adapter/index.js";
import { makeAdapter } from "../../../src/session/boot-adapter/common.js";
import {
  CLI_DEFAULT,
  envOrDefault,
  launchConfig,
  normalizeLaunch,
  optInEnv,
} from "../../../src/session/boot-adapter/launch-config.js";
import type { CliKind, LaunchConfig } from "../../../src/session/boot-adapter/types.js";
import { makeCtx, makeResolved, readyScript } from "./_fixtures.js";

const KNOB = /^AIGENTRY_.*_(EFFORT|MODEL)$/;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = {};
  for (const k of Object.keys(process.env)) {
    if (KNOB.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (KNOB.test(k)) delete process.env[k];
  Object.assign(process.env, saved);
});

const STAGING = "/tmp/sess-L";
const PROMPT = path.join(STAGING, "effective_prompt.md");
const UNKNOWN = { value: "unknown", source: "unknown" };
const CLI_DEF = { value: "unknown", source: "cli-default" };

type Door = "claude" | "codex" | "agy" | "gemini-cli" | "grok";
const spawner = () => mockSpawner({
  claude: readyScript(), codex: readyScript(), gemini: readyScript("0.42.0"), grok: readyScript("0.2.93"),
  agy: { on_run: () => ({ stdout: "--model --dangerously-skip-permissions --prompt-interactive", stderr: "", exit_code: 0, duration_ms: 1 }) },
});
async function build(door: Door, env: Record<string, string> = {}): Promise<BootCommand> {
  Object.assign(process.env, env);
  const a = door === "agy" ? getBootAdapter("gemini", "agy")
    : door === "gemini-cli" ? getBootAdapter("gemini", "gemini")
    : getBootAdapter(door);
  return a.buildBootCommand(makeCtx(), makeResolved(), { staging_dir: STAGING, fs: memoryBootFs(), spawner: spawner() });
}
const lc = (cli: CliKind, model: object, effort: object) => ({ v: 2, cli, model, effort });

// Every flag the adapter owns appears at most once (no duplicate model/effort).
function assertNoDupFlags(argv: readonly string[]): void {
  for (const f of ["--model", "-m", "--effort", "--reasoning-effort", "--append-system-prompt-file", "--permission-mode"]) {
    assert.ok(argv.filter((a) => a === f).length <= 1, `duplicate ${f} in ${JSON.stringify(argv)}`);
  }
  assert.ok(argv.filter((a) => a.startsWith("model_reasoning_effort=")).length <= 1);
}
// Metadata ⇒ argv agreement: a known model/effort value is exactly the argv value.
function flagValue(argv: readonly string[], flags: readonly string[]): string | null {
  const i = argv.findIndex((a) => flags.includes(a));
  if (i >= 0) return argv[i + 1] ?? null;
  const c = argv.find((a) => a.startsWith("model_reasoning_effort="));
  return flags.includes("model_reasoning_effort=") && c ? c.slice("model_reasoning_effort=".length) : null;
}
const MODEL_FLAGS: Record<Door, string[]> = { claude: ["--model"], codex: ["-m"], agy: ["--model"], "gemini-cli": ["-m"], grok: ["-m"] };
const EFFORT_FLAGS: Record<Door, string[]> = {
  claude: ["--effort"], codex: ["model_reasoning_effort="], agy: ["--effort"], "gemini-cli": [], grok: ["--reasoning-effort"],
};
function assertAgreement(door: Door, cmd: BootCommand): void {
  assert.ok(cmd.launch, "maintained adapters always populate launch");
  const l = cmd.launch!;
  assertNoDupFlags(cmd.argv);
  if (l.model.source !== "unknown") assert.equal(flagValue(cmd.argv, MODEL_FLAGS[door]), l.model.value);
  if (l.effort.source === "cli-default") {
    assert.equal(l.effort.value, "unknown");
    assert.equal(EFFORT_FLAGS[door].length ? flagValue(cmd.argv, EFFORT_FLAGS[door]) : null, null,
      "cli-default ⇒ no effort flag on argv");
  } else if (l.effort.source !== "unknown") {
    assert.equal(flagValue(cmd.argv, EFFORT_FLAGS[door]), l.effort.value);
  }
}

// ---- per-door exact argv + launch: default / configured / empty / opt-in ----

test("L1 claude default: exact argv order + default/default", async () => {
  const cmd = await build("claude");
  assert.deepEqual([...cmd.argv], ["claude", "--append-system-prompt-file", PROMPT, "--model", "claude-opus-5", "--effort", "xhigh"]);
  assert.deepEqual(cmd.launch, lc("claude", { value: "claude-opus-5", source: "default" }, { value: "xhigh", source: "default" }));
  assertAgreement("claude", cmd);
});
test("L2 claude configured: env values + env:<NAME> sources", async () => {
  const cmd = await build("claude", { AIGENTRY_CLAUDE_MODEL: "claude-sonnet-5", AIGENTRY_CLAUDE_EFFORT: "medium" });
  assert.deepEqual([...cmd.argv], ["claude", "--append-system-prompt-file", PROMPT, "--model", "claude-sonnet-5", "--effort", "medium"]);
  assert.deepEqual(cmd.launch, lc("claude",
    { value: "claude-sonnet-5", source: "env:AIGENTRY_CLAUDE_MODEL" }, { value: "medium", source: "env:AIGENTRY_CLAUDE_EFFORT" }));
  assertAgreement("claude", cmd);
});
test("L3 claude empty env ⇒ default (existing || precedence)", async () => {
  const cmd = await build("claude", { AIGENTRY_CLAUDE_MODEL: "", AIGENTRY_CLAUDE_EFFORT: "" });
  assert.deepEqual([...cmd.argv].slice(3), ["--model", "claude-opus-5", "--effort", "xhigh"]);
  assert.deepEqual(cmd.launch, lc("claude", { value: "claude-opus-5", source: "default" }, { value: "xhigh", source: "default" }));
});

test("L4 codex default / configured / empty", async () => {
  const d = await build("codex");
  assert.deepEqual([...d.argv], ["codex", "-m", "gpt-6-astra", "-c", "model_reasoning_effort=high",
    "-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(d.launch, lc("codex", { value: "gpt-6-astra", source: "default" }, { value: "high", source: "default" }));
  assertAgreement("codex", d);
  const c = await build("codex", { AIGENTRY_CODEX_MODEL: "gpt-5.5", AIGENTRY_CODEX_EFFORT: "xhigh" });
  assert.deepEqual([...c.argv], ["codex", "-m", "gpt-5.5", "-c", "model_reasoning_effort=xhigh",
    "-c", "check_for_update_on_startup=false", "--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(c.launch, lc("codex",
    { value: "gpt-5.5", source: "env:AIGENTRY_CODEX_MODEL" }, { value: "xhigh", source: "env:AIGENTRY_CODEX_EFFORT" }));
  assertAgreement("codex", c);
  const e = await build("codex", { AIGENTRY_CODEX_MODEL: "", AIGENTRY_CODEX_EFFORT: "" });
  assert.deepEqual([...e.argv], [...d.argv]);
  assert.deepEqual(e.launch, d.launch);
});

test("L5 agy default (no effort ⇒ cli-default, no --effort flag)", async () => {
  const cmd = await build("agy");
  assert.deepEqual([...cmd.argv], ["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
  assert.deepEqual(cmd.launch, lc("gemini", { value: "gemini-3.8-flash-high", source: "default" }, CLI_DEF));
  assertAgreement("agy", cmd);
});
test("L6 agy configured + opt-in effort ⇒ trailing --effort", async () => {
  const cmd = await build("agy", { AIGENTRY_GEMINI_MODEL: "gemini-3.8-pro", AIGENTRY_GEMINI_EFFORT: "high" });
  assert.deepEqual([...cmd.argv], ["agy", "--model", "gemini-3.8-pro", "--dangerously-skip-permissions", "--effort", "high"]);
  assert.deepEqual(cmd.launch, lc("gemini",
    { value: "gemini-3.8-pro", source: "env:AIGENTRY_GEMINI_MODEL" }, { value: "high", source: "env:AIGENTRY_GEMINI_EFFORT" }));
  assertAgreement("agy", cmd);
});
test("L7 agy empty opt-in effort ⇒ no flag, cli-default", async () => {
  const cmd = await build("agy", { AIGENTRY_GEMINI_MODEL: "", AIGENTRY_GEMINI_EFFORT: "" });
  assert.deepEqual([...cmd.argv], ["agy", "--model", "gemini-3.8-flash-high", "--dangerously-skip-permissions"]);
  assert.deepEqual(cmd.launch, lc("gemini", { value: "gemini-3.8-flash-high", source: "default" }, CLI_DEF));
});

test("L8 gemini-cli default / configured; effort env never claimed (no flag exists)", async () => {
  const d = await build("gemini-cli");
  assert.deepEqual([...d.argv], ["gemini", "-m", "gemini-2.5-flash", "--approval-mode", "yolo", "--skip-trust"]);
  assert.deepEqual(d.launch, lc("gemini", { value: "gemini-2.5-flash", source: "default" }, CLI_DEF));
  const c = await build("gemini-cli", { AIGENTRY_GEMINI_MODEL: "gemini-2.5-pro", AIGENTRY_GEMINI_EFFORT: "high" });
  assert.deepEqual([...c.argv], ["gemini", "-m", "gemini-2.5-pro", "--approval-mode", "yolo", "--skip-trust"]);
  assert.deepEqual(c.launch, lc("gemini", { value: "gemini-2.5-pro", source: "env:AIGENTRY_GEMINI_MODEL" }, CLI_DEF));
  assertAgreement("gemini-cli", c);
  const e = await build("gemini-cli", { AIGENTRY_GEMINI_MODEL: "" });
  assert.deepEqual(e.launch, d.launch);
});

test("L9 grok default / configured + opt-in / empty", async () => {
  const d = await build("grok");
  assert.deepEqual([...d.argv], ["grok", "--always-approve", "-m", "grok-4.6"]);
  assert.deepEqual(d.launch, lc("grok", { value: "grok-4.6", source: "default" }, CLI_DEF));
  assertAgreement("grok", d);
  const c = await build("grok", { AIGENTRY_GROK_MODEL: "grok-5", AIGENTRY_GROK_EFFORT: "low" });
  assert.deepEqual([...c.argv], ["grok", "--always-approve", "-m", "grok-5", "--reasoning-effort", "low"]);
  assert.deepEqual(c.launch, lc("grok",
    { value: "grok-5", source: "env:AIGENTRY_GROK_MODEL" }, { value: "low", source: "env:AIGENTRY_GROK_EFFORT" }));
  assertAgreement("grok", c);
  const e = await build("grok", { AIGENTRY_GROK_MODEL: "", AIGENTRY_GROK_EFFORT: "" });
  assert.deepEqual([...e.argv], [...d.argv]);
  assert.deepEqual(e.launch, d.launch);
});

// ---- invalid labels: argv keeps the raw value, launch field becomes unknown ----

const BAD_MODELS = ["claude-opus-5[1m]", "a b", "x\ny", "m".repeat(97), "$(id)", "é"];
const BAD_EFFORTS = ["XHIGH", "hi gh", "e".repeat(25), "x;y"];
const DOOR_ENV: Record<Door, { model: string; effort: string | null }> = {
  claude: { model: "AIGENTRY_CLAUDE_MODEL", effort: "AIGENTRY_CLAUDE_EFFORT" },
  codex: { model: "AIGENTRY_CODEX_MODEL", effort: "AIGENTRY_CODEX_EFFORT" },
  agy: { model: "AIGENTRY_GEMINI_MODEL", effort: "AIGENTRY_GEMINI_EFFORT" },
  "gemini-cli": { model: "AIGENTRY_GEMINI_MODEL", effort: null },
  grok: { model: "AIGENTRY_GROK_MODEL", effort: "AIGENTRY_GROK_EFFORT" },
};
const GOOD_EFFORT: Record<Door, string> = { claude: "high", codex: "high", agy: "high", "gemini-cli": "high", grok: "high" };

for (const door of Object.keys(DOOR_ENV) as Door[]) {
  test(`L10 ${door}: invalid model label ⇒ model unknown, argv raw, effort intact`, async () => {
    for (const bad of BAD_MODELS) {
      for (const k of Object.keys(process.env)) if (KNOB.test(k)) delete process.env[k];
      const env: Record<string, string> = { [DOOR_ENV[door].model]: bad };
      if (DOOR_ENV[door].effort) env[DOOR_ENV[door].effort!] = GOOD_EFFORT[door];
      const cmd = await build(door, env);
      assert.equal(flagValue(cmd.argv, MODEL_FLAGS[door]), bad, "argv must carry the raw configured value");
      assert.deepEqual(cmd.launch!.model, UNKNOWN, `model ${JSON.stringify(bad)} must be unknown`);
      if (DOOR_ENV[door].effort) {
        assert.deepEqual(cmd.launch!.effort, { value: "high", source: `env:${DOOR_ENV[door].effort}` });
      } else {
        assert.deepEqual(cmd.launch!.effort, CLI_DEF);
      }
      assertNoDupFlags(cmd.argv);
    }
  });
  if (DOOR_ENV[door].effort) {
    test(`L11 ${door}: invalid effort label ⇒ effort unknown, argv raw, model intact`, async () => {
      for (const bad of BAD_EFFORTS) {
        for (const k of Object.keys(process.env)) if (KNOB.test(k)) delete process.env[k];
        const cmd = await build(door, { [DOOR_ENV[door].model]: "m-1", [DOOR_ENV[door].effort!]: bad });
        assert.equal(flagValue(cmd.argv, EFFORT_FLAGS[door]), bad, "argv must carry the raw configured effort");
        assert.deepEqual(cmd.launch!.effort, UNKNOWN);
        assert.deepEqual(cmd.launch!.model, { value: "m-1", source: `env:${DOOR_ENV[door].model}` });
      }
    });
  }
}

test("L12 label bounds: model 96 ok / 97 unknown; effort 24 ok / 25 unknown", () => {
  const ok = normalizeLaunch("claude", lc("claude", { value: "m".repeat(96), source: "default" }, { value: "e".repeat(24), source: "default" }));
  assert.equal(ok.model.value, "m".repeat(96));
  assert.equal(ok.effort.value, "e".repeat(24));
  const over = normalizeLaunch("claude", lc("claude", { value: "m".repeat(97), source: "default" }, { value: "e".repeat(25), source: "default" }));
  assert.deepEqual(over.model, UNKNOWN);
  assert.deepEqual(over.effort, UNKNOWN);
});

// ---- normalizeLaunch: malformed / extra keys / prototype / wrong CLI / unknown source ----

const VALID = () => lc("codex", { value: "gpt-6-astra", source: "default" }, { value: "high", source: "env:AIGENTRY_CODEX_EFFORT" });
const ALL_UNKNOWN = (cli: CliKind) => ({ v: 2, cli, model: UNKNOWN, effort: UNKNOWN });

test("N1 valid record passes through, result frozen and detached from input", () => {
  const raw = VALID();
  const out = normalizeLaunch("codex", raw);
  assert.deepEqual(out, VALID());
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.model) && Object.isFrozen(out.effort));
  (raw.model as { value: string }).value = "tampered";
  assert.equal(out.model.value, "gpt-6-astra");
  assert.deepEqual(Object.keys(out), ["v", "cli", "model", "effort"]);
});

test("N2 malformed top level ⇒ all unknown for the caller's cli", () => {
  const cases: unknown[] = [
    undefined, null, 0, "x", [], [VALID()], {},
    { ...VALID(), extra: 1 },
    (({ effort: _e, ...r }) => r)(VALID()),
    { ...VALID(), v: 1 }, { ...VALID(), v: "2" }, { ...VALID(), v: 3 },
    { ...VALID(), cli: "claude" }, { ...VALID(), cli: "opencode" }, { ...VALID(), cli: "CODEX" },
    JSON.parse('{"v":2,"cli":"codex","model":{"value":"a","source":"default"},"effort":{"value":"b","source":"default"},"__proto__":{"x":1}}'),
  ];
  for (const c of cases) assert.deepEqual(normalizeLaunch("codex", c), ALL_UNKNOWN("codex"), JSON.stringify(c) ?? String(c));
});

test("N3 prototype-inherited keys never count (exact OWN keys)", () => {
  const inherited = Object.create(VALID());
  assert.deepEqual(normalizeLaunch("codex", inherited), ALL_UNKNOWN("codex"));
  const val = Object.create({ value: "gpt-6-astra", source: "default" });
  assert.deepEqual(normalizeLaunch("codex", { ...VALID(), model: val }).model, UNKNOWN);
  // null-prototype record with exact own keys is still data, accepted.
  const np = Object.assign(Object.create(null), VALID());
  assert.deepEqual(normalizeLaunch("codex", np), VALID());
  // Polluting Object.prototype must not make a partial record look complete.
  const proto = Object.prototype as Record<string, unknown>;
  proto["effort"] = { value: "high", source: "default" };
  try {
    const { effort: _e, ...partial } = VALID();
    assert.deepEqual(normalizeLaunch("codex", partial), ALL_UNKNOWN("codex"));
  } finally {
    delete proto["effort"];
  }
});

test("N4 value-level malformed ⇒ that field unknown only", () => {
  const bad: unknown[] = [
    null, "gpt", [], {}, { value: "a" }, { source: "default" },
    { value: "a", source: "default", extra: 1 },
    { value: 1, source: "default" }, { value: "a", source: 1 }, { value: "", source: "default" },
  ];
  for (const b of bad) {
    const out = normalizeLaunch("codex", { ...VALID(), model: b });
    assert.deepEqual(out.model, UNKNOWN, JSON.stringify(b));
    assert.deepEqual(out.effort, VALID().effort, "sibling field untouched");
  }
});

test("N5 unknown / unrecognised source can never yield a known value", () => {
  const srcs = ["unknown", "observed", "configured", "Default", "env:", "env:FOO", "env:AIGENTRY_", "env:AIGENTRY_lower",
    "env:AIGENTRY_X Y", `env:AIGENTRY_${"A".repeat(65)}`, "cli-default "];
  for (const source of srcs) {
    const out = normalizeLaunch("codex", { ...VALID(), model: { value: "gpt-6-astra", source } });
    assert.deepEqual(out.model, UNKNOWN, source);
  }
  // cli-default must carry the literal "unknown", never a concrete value.
  assert.deepEqual(normalizeLaunch("codex", { ...VALID(), effort: { value: "high", source: "cli-default" } }).effort, UNKNOWN);
  assert.deepEqual(normalizeLaunch("codex", { ...VALID(), effort: { value: "unknown", source: "cli-default" } }).effort, CLI_DEF);
  // Longest accepted env name (64) still passes.
  const long = `env:AIGENTRY_${"A".repeat(64)}`;
  assert.deepEqual(normalizeLaunch("codex", { ...VALID(), model: { value: "m", source: long } }).model, { value: "m", source: long });
});

test("N6 wrong CLI: adapter record for another cli is rejected", () => {
  for (const cli of ["claude", "codex", "gemini", "grok"] as const) {
    const other = cli === "claude" ? "codex" : "claude";
    assert.deepEqual(normalizeLaunch(cli, { ...VALID(), cli: other }), ALL_UNKNOWN(cli));
  }
});

test("N7 helpers keep the existing env precedence", () => {
  assert.deepEqual(envOrDefault({}, "AIGENTRY_X_MODEL", "d"), { arg: "d", source: "default" });
  assert.deepEqual(envOrDefault({ AIGENTRY_X_MODEL: "" }, "AIGENTRY_X_MODEL", "d"), { arg: "d", source: "default" });
  assert.deepEqual(envOrDefault({ AIGENTRY_X_MODEL: "v" }, "AIGENTRY_X_MODEL", "d"), { arg: "v", source: "env:AIGENTRY_X_MODEL" });
  assert.equal(optInEnv({}, "AIGENTRY_X_EFFORT"), CLI_DEFAULT);
  assert.equal(optInEnv({ AIGENTRY_X_EFFORT: "" }, "AIGENTRY_X_EFFORT"), CLI_DEFAULT);
  assert.deepEqual(optInEnv({ AIGENTRY_X_EFFORT: "e" }, "AIGENTRY_X_EFFORT"), { arg: "e", source: "env:AIGENTRY_X_EFFORT" });
  assert.deepEqual(launchConfig("grok", { arg: "g", source: "default" }, CLI_DEFAULT),
    lc("grok", { value: "g", source: "default" }, CLI_DEF));
});

// ---- public optional metadata + custom makeAdapter ----

test("P1 custom makeAdapter without launch ⇒ explicit unknown, argv untouched", async () => {
  const a = makeAdapter({ name: "grok", min_version: "0.0.1",
    buildArgvEnv: () => ({ argv: ["grok", "--custom"], env: {} }) });
  const cmd = await a.buildBootCommand(makeCtx(), makeResolved(), { staging_dir: STAGING, fs: memoryBootFs(), spawner: spawner() });
  assert.deepEqual([...cmd.argv], ["grok", "--custom"]);
  assert.deepEqual(cmd.launch, ALL_UNKNOWN("grok"));
});

test("P2 custom makeAdapter with malformed / wrong-cli launch ⇒ unknown", async () => {
  const bogus: unknown[] = [
    lc("claude", { value: "x", source: "default" }, { value: "y", source: "default" }),
    { v: 2, cli: "grok", model: { value: "x", source: "observed" }, effort: { value: "y", source: "default" }, extra: true },
  ];
  for (const launch of bogus) {
    const a = makeAdapter({ name: "grok", min_version: "0.0.1",
      buildArgvEnv: () => ({ argv: ["grok"], env: {}, launch: launch as LaunchConfig }) });
    const cmd = await a.buildBootCommand(makeCtx(), makeResolved(), { staging_dir: STAGING, fs: memoryBootFs(), spawner: spawner() });
    assert.deepEqual(cmd.launch, ALL_UNKNOWN("grok"));
  }
});

test("P3 BootCommand.launch is optional for external implementations (type + runtime)", () => {
  const external: BootCommand = { argv: ["claude"], env: {}, cwd: "/w", prompt_file: "/p", expected_digest: "d" };
  assert.equal(external.launch, undefined);
  assert.deepEqual(normalizeLaunch("claude", external.launch), ALL_UNKNOWN("claude"));
});

test("P4 every maintained adapter always populates a v2 launch for its own cli", async () => {
  for (const door of ["claude", "codex", "agy", "gemini-cli", "grok"] as Door[]) {
    const cmd = await build(door);
    assert.ok(cmd.launch, door);
    assert.equal(cmd.launch!.v, 2);
    assert.equal(cmd.launch!.cli, door === "agy" || door === "gemini-cli" ? "gemini" : door);
    assert.ok(Object.isFrozen(cmd.launch));
  }
});
