import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./model-router-fixtures.js";

function audit(f: ReturnType<typeof fixture>) {
  const events = readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  const event = events.find((e) => e[e.indexOf("--subtype") + 1] === "dispatch_start")!;
  const result = { payload: JSON.parse(event[event.indexOf("--payload-json") + 1]!),
    note: JSON.parse(readFileSync(f.queue, "utf8")).tasks[0].note as string };
  if (existsSync(f.env.OPEN_LOG!)) {
    const m = f.manifest(), flag = m.cli === "codex" ? "-m" : "--model";
    assert.equal(m.cli, result.payload.cli);
    assert.ok(result.note.includes(`cli=${m.cli}/${m.command[m.command.indexOf(flag) + 1]} `));
  }
  return result;
}

for (const flags of [[], ["--cli", "auto"]]) test(`T140: ${flags.length ? "explicit auto" : "omitted CLI"} routes once and audits applied child model`, () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder", ...flags], { AIGENTRY_CODEX_MODEL: "parent-model" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 1);
    assert.doesNotMatch(r.stderr, /boot-prepare.mjs failed|legacy path active/);
    const { payload, note } = audit(f);
    assert.equal(payload.cli, "codex");
    assert.deepEqual(payload.route, { label: "gpt-6-astra", decided_by: "llm", reason: "implementation" });
    assert.match(note, /seed \| dispatched .* sid=router-fixture ref=ref.md track=router cli=codex\/gpt-6-astra by=llm/);
    assert.equal(JSON.parse(readFileSync(f.env.OPEN_LOG!, "utf8")).model, "gpt-6-astra");
    assert.deepEqual(f.manifest().command.slice(1, 3), ["-m", "gpt-6-astra"]);
    assert.equal(f.manifest().cli, "codex");
    // inject/telemetry inherit the parent environment, never the selected model.
    assert.equal(readFileSync(f.env.PARENT_MODEL_LOG!, "utf8"), "parent-model");
  } finally { f.cleanup(); }
});

test("T140: explicit CLI bypasses classifier and profile and records by=explicit", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "claude", "--role", "coder"], { AIGENTRY_ROUTER_PROFILE: "/missing/profile.md", AIGENTRY_CLAUDE_MODEL: "chosen-by-operator" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    assert.doesNotMatch(r.stderr, /model-router/);
    const { payload, note } = audit(f);
    assert.equal(payload.route.decided_by, "explicit");
    assert.match(note, /cli=claude\/chosen-by-operator by=explicit/);
    assert.ok(f.manifest().command.includes("chosen-by-operator"));
  } finally { f.cleanup(); }
});

test("T140: classifier failure still spawns and audits role-table fallback", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { CLASSIFIER_REPLY: "broken" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 1);
    const { payload, note } = audit(f);
    assert.equal(payload.route.decided_by, "table");
    assert.match(note, /cli=codex\/gpt-6-astra by=table/);
  } finally { f.cleanup(); }
});

test("T140: --target never classifies; audit identifies observed worker and unknown model", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    const r = f.dispatch(["--target", "router-fixture"], { OBSERVED_CLI: "grok" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    const { payload, note } = audit(f);
    assert.equal(payload.cli, "grok");
    assert.equal(payload.route.decided_by, "existing");
    assert.match(note, /cli=grok\/unknown by=existing/);
  } finally { f.cleanup(); }
});

test("T140: deduplicated fresh dispatch does not classify or spawn again", () => {
  const f = fixture();
  try {
    assert.equal(f.dispatch([...f.spawnArgs, "--role", "coder"]).status, 0);
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"]);
    assert.equal(r.status, 8, r.stderr);
    assert.equal(f.calls(), 1);
    assert.equal(readFileSync(f.env.OPEN_LOG! + ".calls", "utf8"), "open\n");
  } finally { f.cleanup(); }
});

// #1084 per-CLI live cap. Two live codex sessions = the default cap: the fixture's own row
// (router-fixture, bare `codex`) plus one guard launcher, so the `exec -a` resolution is covered.
function twoCodex(f: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: "codex" }, { id: "live-1", command: f.liveLauncher("codex") }]) };
}

test("T140: codex at cap, role table is another CLI -> falls to it, by=llm-capped + capped_cli", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.aig, "instructions/roles/architect.md"), "# ARCHITECT\nFIXTURE-ROLE\n");
    const r = f.dispatch([...f.spawnArgs, "--role", "architect"], twoCodex(f));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 1);
    assert.match(r.stderr, /codex at cap \(2 live, AIGENTRY_CLI_CAP_CODEX=2\); gpt-6-astra -> opus-5 \(claude\)/);
    const { payload, note } = audit(f);
    assert.equal(payload.cli, "claude");
    assert.deepEqual([payload.route.label, payload.route.decided_by, payload.route.capped_cli], ["opus-5", "llm-capped", "codex"]);
    assert.match(payload.route.reason, /^codex at cap .*; router chose gpt-6-astra: implementation$/);
    assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=llm-capped capped_cli=codex/);
    assert.ok(f.manifest().command.includes("claude-opus-5[1m]"));
  } finally { f.cleanup(); }
});

test("T140: codex at cap, role table is codex too -> first under-cap profile model (opus)", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], twoCodex(f));
    assert.equal(r.status, 0, r.stderr);
    const { payload, note } = audit(f);
    assert.deepEqual([payload.cli, payload.route.label, payload.route.decided_by, payload.route.capped_cli], ["claude", "opus-5", "llm-capped", "codex"]);
    assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=llm-capped capped_cli=codex/);
    assert.ok(f.manifest().command.includes("claude-opus-5[1m]"));
  } finally { f.cleanup(); }
});

test("T140: table fallback at cap records by=table-capped", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { ...twoCodex(f), CLASSIFIER_REPLY: "broken" });
    assert.equal(r.status, 0, r.stderr);
    const { payload, note } = audit(f);
    assert.deepEqual([payload.cli, payload.route.decided_by, payload.route.capped_cli], ["claude", "table-capped", "codex"]);
    assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=table-capped capped_cli=codex/);
  } finally { f.cleanup(); }
});

test("T140: under cap is unchanged: raised knob, or a live row whose launcher cannot be read", () => {
  for (const overrides of [{ AIGENTRY_CLI_CAP_CODEX: "3" },
    { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: "codex" }, { id: "live-1", command: "/missing/launcher.sh" }]) }]) {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { ...twoCodex(f), ...overrides });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /at cap/);
      const { payload, note } = audit(f);
      assert.deepEqual(payload.route, { label: "gpt-6-astra", decided_by: "llm", reason: "implementation" });
      assert.match(note, /cli=codex\/gpt-6-astra by=llm$/);
    } finally { f.cleanup(); }
  }
});

test("T140: AIGENTRY_CLI_CAP_CODEX=1 caps at one live codex; 0 never auto-routes there", () => {
  for (const cap of ["1", "0"]) {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { AIGENTRY_CLI_CAP_CODEX: cap });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, new RegExp(`codex at cap \\(1 live, AIGENTRY_CLI_CAP_CODEX=${cap}\\)`));
      assert.equal(audit(f).payload.route.decided_by, "llm-capped");
    } finally { f.cleanup(); }
  }
});

test("T140: explicit --cli codex at cap still spawns codex and warns once", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--cli", "codex", "--role", "coder"], twoCodex(f));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    assert.equal(r.stderr.match(/WARNING codex at cap \(2 live, AIGENTRY_CLI_CAP_CODEX=2\); explicit --cli codex spawns anyway/g)?.length, 1);
    const { payload, note } = audit(f);
    assert.deepEqual([payload.cli, payload.route.decided_by, payload.route.capped_cli], ["codex", "explicit", undefined]);
    assert.match(note, /cli=codex\/gpt-6-astra by=explicit$/);
    assert.deepEqual(f.manifest().command.slice(1, 3), ["-m", "gpt-6-astra"]);
  } finally { f.cleanup(); }
});

// #1084: two codex workers timed out at 30 s today with the prompt on screen — cliOf() handed the
// launcher PATH to session-probe.py and to the `cliKind === "codex"` 90 s branch.
test("T140: readiness probe and --target audit receive the CLI kind for a worker-launcher row", () => {
  const f = fixture();
  try {
    const probe = f.script("probe-log", "require('node:fs').writeFileSync(process.env.PROBE_ARGS, JSON.stringify(process.argv.slice(2))); console.log('{\"ready\":true}')");
    const row = { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: f.liveLauncher("codex") }]) };
    const r = f.dispatch([...f.spawnArgs, "--cli", "codex", "--role", "coder"], { ...row, SESSION_PROBE_PY: probe, PROBE_ARGS: join(f.root, "probe-args") });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "probe-args"), "utf8")), ["--sid", "router-fixture", "--cli", "codex"]);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    g.prepareTarget();
    const r = g.dispatch(["--target", "router-fixture"], { LIVE_SESSIONS: JSON.stringify([{ id: "router-fixture", command: g.liveLauncher("codex") }]) });
    assert.equal(r.status, 0, r.stderr);
    const { payload, note } = audit(g);
    assert.equal(payload.cli, "codex");
    assert.match(note, /cli=codex\/unknown by=existing/);
  } finally { g.cleanup(); }
});

// #1098: count Claude guard launchers as well as the orchestrator's bare CLI.
for (const [live, cap, capped] of [[3, "", false], [4, "", true], [4, "5", false], [1, "1", true], [1, "0", true]] as const) {
  test(`T140: Claude live=${live}, cap=${cap || "default 4"} routes ${capped ? "next candidate" : "Opus"}`, () => {
    const f = fixture();
    try {
      const r = f.dispatch([...f.spawnArgs, "--role", "coder"], {
        AIGENTRY_CLI_CAP_CLAUDE: cap, AIGENTRY_CLI_CAP_CODEX: "",
        CLASSIFIER_REPLY: '{"label":"opus-5","reason":"judgment","confidence":0.9}',
        LIVE_SESSIONS: JSON.stringify(Array.from({ length: live }, (_, i) => ({
          id: i === 0 ? "router-fixture" : `live-${i}`, command: i === 0 ? "claude" : f.liveLauncher("claude"),
        }))),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(f.calls(), 1);
      const { payload, note } = audit(f);
      assert.deepEqual([payload.cli, payload.route.label, payload.route.decided_by, payload.route.capped_cli],
        capped ? ["codex", "gpt-6-astra", "llm-capped", "claude"] : ["claude", "opus-5", "llm", undefined]);
      if (capped) {
        assert.ok(r.stderr.includes(`claude at cap (${live} live, AIGENTRY_CLI_CAP_CLAUDE=${cap || "4"})`));
        assert.match(note, /cli=codex\/gpt-6-astra by=llm-capped capped_cli=claude/);
      } else assert.doesNotMatch(r.stderr, /at cap/);
    } finally { f.cleanup(); }
  });
}

test("T140: unavailable router uses emergency Opus in audit and child launcher", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"], { DISPATCH_SCRIPT_DIR: f.bin, AIGENTRY_CLI_CAP_CLAUDE: "" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.calls(), 0);
    const { payload, note } = audit(f);
    assert.deepEqual(payload.route, { label: "opus-5", decided_by: "table", reason: "router unavailable" });
    assert.match(note, /cli=claude\/claude-opus-5\[1m\] by=table/);
    assert.ok(f.manifest().command.includes("claude-opus-5[1m]"));
  } finally { f.cleanup(); }
});
