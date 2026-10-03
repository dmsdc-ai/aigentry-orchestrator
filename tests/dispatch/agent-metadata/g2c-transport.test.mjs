// #1162 G2c — the REAL wh-cli.sh → workspace-host.sh → node-shim → compiled
// agent-metadata.js → REAL compiled agent-binding.js chain, against a FAKE cmux
// recorder (support/fake-cmux.mjs) and REAL sealed-binding fixtures. The fake's
// reply shapes follow the staged CLI source (supplement/cmux.swift):
//   capabilities → stdout jsonString(result) where result = {protocol, version,
//     socket_path, access_mode, capabilities, methods:[sorted]} (TerminalController
//     .swift:3482-3489); rpc success → stdout jsonString(result), rc 0 (:6664-6679);
//   v2 error → stderr "Error: \(error)" + exit (:41524-41527). The CLIError
//   description format itself is NOT staged (no `struct CLIError` in any input):
//   cases marked [A1] depend on the coder's assumption "Error: <code>: <message>".
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { BIN, DIST, HERE, hermeticEnv, makeRun, sealedFixture, sh } from "./support/harness.mjs";

const SET = "surface.agent_metadata.set";
const CLEAR = "surface.agent_metadata.clear";
const WH = path.join(BIN, "wh-cli.sh");
const FAKE = path.join(HERE, "fake-cmux.mjs");

const BASE_METHODS = ["system.capabilities", "system.identify", "system.ping", "surface.list", "workspace.list"];
export const realCaps = (methods = [...BASE_METHODS, SET, CLEAR]) => JSON.stringify({
  protocol: "cmux-socket", version: 2, socket_path: "/fixture/cmux.sock", access_mode: "cmuxOnly",
  capabilities: { terminal: true }, methods: [...methods].sort(),
}, null, 2) + "\n";

const LAUNCH = {
  v: 2, cli: "claude",
  model: { value: "claude-opus-5", source: "default" },
  effort: { value: "xhigh", source: "env:AIGENTRY_CLAUDE_EFFORT" },
};
const STATUS = { connection: "connected", activity: "idle", activity_source: "probe:current-viewport", dispatch: "delivered", read_at: 1790000000 };

/** A run with a fake cmux + scenario; returns an invoker for wh-cli.sh verbs. */
function setup(label, scenario, { adapter = "cmux", cmux, dist } = {}) {
  const run = makeRun(label);
  const scen = path.join(run.dir, "scenario.json");
  fs.writeFileSync(scen, JSON.stringify(scenario));
  const cmuxLog = path.join(run.logs, "cmux.jsonl");
  fs.writeFileSync(cmuxLog, "");
  const env = hermeticEnv(run, {
    AIGENTRY_WORKSPACE_HOST: adapter,
    CMUX: cmux ?? FAKE,
    FAKE_CMUX_SCENARIO: scen,
    FAKE_CMUX_LOG: cmuxLog,
  });
  const wh = (...args) => sh(dist ? path.join(dist, "..", "bin", "wh-cli.sh") : WH, args, { env, timeout: 60000 });
  const calls = () => fs.readFileSync(cmuxLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { run, wh, calls, env };
}

const metaLine = (stderr) => stderr.split("\n").filter((l) => l.startsWith("agent-meta: "));

function assertClean(ctx) {
  assert.equal(ctx.run.tripwireHits(), "", "tripwire hit");
  assert.ok(!ctx.calls().some((c) => c.unexpected), `unexpected cmux argv: ${JSON.stringify(ctx.calls())}`);
}

// ── caps ────────────────────────────────────────────────────────────────────
test("G2c-01 caps: real-shape reply advertising both methods → 0, one capabilities call", () => {
  const c = setup("g2c01", { capabilities: { stdout: realCaps() } });
  const r = c.wh("agent-meta-caps");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "agent_meta caps=supported adapter=cmux\n");
  assert.deepEqual(c.calls().map((x) => x.argv), [["capabilities"]]);
  assertClean(c);
});

const CAPS_CASES = [
  ["only set advertised", 20, { stdout: realCaps([...BASE_METHODS, SET]) }],
  ["only clear advertised", 20, { stdout: realCaps([...BASE_METHODS, CLEAR]) }],
  ["unpatched host (neither)", 20, { stdout: realCaps() && realCaps(BASE_METHODS) }],
  ["case variant", 20, { stdout: realCaps([...BASE_METHODS, "Surface.agent_metadata.set", "Surface.agent_metadata.clear"]) }],
  ["suffixed names", 20, { stdout: realCaps([...BASE_METHODS, SET + ".v2", CLEAR + ".v2"]) }],
  ["prefix-only names", 20, { stdout: realCaps([...BASE_METHODS, "surface.agent_metadata"]) }],
  ["methods not an array", 20, { stdout: JSON.stringify({ protocol: "cmux-socket", version: 2, methods: `${SET},${CLEAR}` }) }],
  ["caps rc 1", 30, { rc: 1, stderr: "Error: Failed to connect\n" }],
  ["caps empty stdout", 30, { stdout: "" }],
  ["caps non-JSON", 30, { stdout: "methods: surface.agent_metadata.set surface.agent_metadata.clear\n" }],
];
for (const [name, code, reply] of CAPS_CASES) {
  test(`G2c-02 caps → ${code}: ${name}`, () => {
    const c = setup("g2c02", { capabilities: reply });
    const r = c.wh("agent-meta-caps");
    assert.equal(r.status, code, r.stderr);
    assert.notEqual(r.stdout, "agent_meta caps=supported adapter=cmux\n");
    assertClean(c);
  });
}

test("G2c-02b caps: cmux binary missing → 20 (not 127)", () => {
  const c = setup("g2c02b", {}, { cmux: "/nonexistent/it1162/cmux" });
  const r = c.wh("agent-meta-caps");
  assert.equal(r.status, 20, r.stderr);
  assertClean(c);
});

test("G2c-02c caps: host hangs past the 10 s transport timeout → 30", () => {
  const c = setup("g2c02c", { capabilities: { sleepMs: 12000, stdout: realCaps() } });
  const r = c.wh("agent-meta-caps");
  assert.equal(r.status, 30, r.stderr);
  assert.deepEqual(metaLine(r.stderr), ["agent-meta: caps rc=30 reason=host-timeout"]);
});

// Adversarial: the host's capability authority is the top-level `methods` array
// (TerminalController.swift:3482-3489). A method name appearing anywhere else is not
// an advertisement. Expected: 20 (unsupported). A 0 here is a false capability claim.
const SPOOFS = [
  ["names only inside the `capabilities` sub-object", { protocol: "cmux-socket", version: 2, capabilities: { [SET]: true, [CLEAR]: true }, methods: BASE_METHODS }],
  ["names only inside a `capabilities` array", { protocol: "cmux-socket", version: 2, capabilities: [SET, CLEAR], methods: BASE_METHODS }],
  ["names listed as unsupported/disabled", { protocol: "cmux-socket", version: 2, methods: BASE_METHODS, disabled_methods: [SET, CLEAR] }],
  ["names as keys with a string \"no\" value", { protocol: "cmux-socket", version: 2, methods: BASE_METHODS, support: { [SET]: "no", [CLEAR]: "no" } }],
  ["names nested deep in unrelated notes", { protocol: "cmux-socket", version: 2, methods: BASE_METHODS, notes: { a: { b: [{ planned: [SET, CLEAR] }] } } }],
  ["top-level array (not the host shape)", [SET, CLEAR]],
];
for (const [name, body] of SPOOFS) {
  test(`G2c-03 SPOOF caps must stay unsupported (20): ${name}`, () => {
    const c = setup("g2c03", { capabilities: { stdout: JSON.stringify(body) } });
    const r = c.wh("agent-meta-caps");
    assert.equal(r.status, 20, `spoofed capability accepted: rc=${r.status} stdout=${JSON.stringify(r.stdout)}`);
  });
}

// ── set ─────────────────────────────────────────────────────────────────────
function setCtx(label, rpcReply, { launch = LAUNCH, capsStdout = realCaps(), fixture = {} } = {}) {
  const c = setup(label, { capabilities: { stdout: capsStdout }, [`rpc:${SET}`]: rpcReply, [`rpc:${CLEAR}`]: rpcReply });
  const f = sealedFixture(c.run, { launch, ...fixture });
  return { ...c, f };
}

test("G2c-04 set: valid binding + applied → 0; exact rpc params and exactly the 10 fields", () => {
  const c = setCtx("g2c04", { stdout: JSON.stringify({ status: "applied" }) });
  const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "agent_meta set=applied\n");
  const calls = c.calls().map((x) => x.argv);
  assert.deepEqual(calls.map((a) => a.slice(0, 2)), [["capabilities"], ["rpc", SET]]);
  const params = JSON.parse(calls[1][2]);
  assert.equal(calls[1].length, 3, "params are ONE argv element (no shell splitting)");
  assert.deepEqual(params, {
    surface_id: c.f.ids.surface_id, terminal_lifecycle_id: c.f.ids.terminal_lifecycle_id, sid: c.f.sid, attempt: c.f.attempt,
    fields: {
      cli: "claude", model: "claude-opus-5", model_source: "configured", effort: "xhigh", effort_source: "configured",
      connection: "connected", activity: "idle", activity_source: "probe:current-viewport", dispatch: "delivered", read_at: 1790000000,
    },
  });
  assert.ok(!("workspace_id" in params), "workspace is never sent (live pane location wins)");
  assertClean(c);
});

const LAUNCH_MAP = [
  ["cli-default effort → unknown/unknown", { ...LAUNCH, effort: { value: "unknown", source: "cli-default" } }, { effort: "unknown", effort_source: "unknown" }],
  ["unknown source → unknown/unknown", { ...LAUNCH, model: { value: "unknown", source: "unknown" } }, { model: "unknown", model_source: "unknown" }],
  ["configured literal \"unknown\" stays configured (not inferred unsupported)", { ...LAUNCH, model: { value: "unknown", source: "env:AIGENTRY_CLAUDE_MODEL" } }, { model: "unknown", model_source: "configured" }],
  ["old manifest (no launch) → unknown, still applied", null, { model: "unknown", model_source: "unknown", effort: "unknown", effort_source: "unknown" }],
  ["newline/shell label in sealed launch → unknown", { ...LAUNCH, model: { value: "opus\n$(id)", source: "default" } }, { model: "unknown", model_source: "unknown" }],
];
for (const [name, launch, expect] of LAUNCH_MAP) {
  test(`G2c-05 set model/effort mapping: ${name}`, () => {
    const c = setCtx("g2c05", { stdout: JSON.stringify({ status: "applied" }) }, { launch });
    const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
    assert.equal(r.status, 0, r.stderr);
    const fields = JSON.parse(c.calls()[1].argv[2]).fields;
    for (const [k, v] of Object.entries(expect)) assert.equal(fields[k], v, k);
    assert.ok(!Object.values(fields).includes("observed"));
    assertClean(c);
  });
}

const REFUSALS = ["surface_gone", "stale_lifecycle", "owned_by_other_sid", "stale_attempt", "lifecycle_cleared"];
const ERR_CASES = [
  ...REFUSALS.map((code) => [`[A1] ${code} (": " form)`, 10, { rc: 1, stderr: `Error: ${code}: refused by host HOSTTEXT-CANARY\n` }]),
  ...REFUSALS.map((code) => [`[A1] ${code} (":\\n" multi-line form)`, 10, { rc: 1, stderr: `Error: ${code}:\nline one\nline two\n` }]),
  ["[A1] method_not_found → unsupported", 20, { rc: 1, stderr: "Error: method_not_found: Unknown method\n" }],
  ["[A1] invalid_params", 30, { rc: 1, stderr: "Error: invalid_params: bad\n" }],
  ["[A1] unknown code", 30, { rc: 1, stderr: "Error: internal_error: boom\n" }],
  ["refusal code not at line start", 30, { rc: 1, stderr: "warning: Error: stale_lifecycle: x\n" }],
  ["refusal code without colon", 30, { rc: 1, stderr: "Error: stale_lifecycle\n" }],
  ["refusal code upper-case", 30, { rc: 1, stderr: "Error: STALE_LIFECYCLE: x\n" }],
  ["refusal code with suffix", 30, { rc: 1, stderr: "Error: stale_lifecycle_x: x\n" }],
  ["error JSON on stdout, rc 1", 30, { rc: 1, stdout: JSON.stringify({ ok: false, error: { code: "stale_lifecycle" } }) }],
  ["plain-text ERROR: (pre-protocol)", 30, { rc: 1, stderr: "Error: ERROR: Access denied\n" }],
  ["rc 0 non-JSON", 30, { stdout: "applied\n" }],
  ["rc 0 JSON array", 30, { stdout: JSON.stringify(["applied"]) }],
  ["rc 0 wrong status", 30, { stdout: JSON.stringify({ status: "cleared" }) }],
  ["rc 0 status missing", 30, { stdout: JSON.stringify({ ok: true }) }],
  ["rc 0 status Applied (case)", 30, { stdout: JSON.stringify({ status: "Applied" }) }],
  ["killed by signal", 30, { rc: 137 }],
];
for (const [name, code, reply] of ERR_CASES) {
  test(`G2c-06 set host answer → ${code}: ${name}`, () => {
    const c = setCtx("g2c06", reply);
    const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.stdout, "", "no success line");
    const lines = metaLine(r.stderr);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`^agent-meta: set rc=${code} reason=[a-z_-]+$`));
    assert.ok(!r.stderr.includes("HOSTTEXT-CANARY"), "host text reproduced");
    assertClean(c);
  });
}

test("G2c-06b set host timeout → 30", () => {
  const c = setCtx("g2c06b", { sleepMs: 12000, stdout: JSON.stringify({ status: "applied" }) });
  const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 30, r.stderr);
  assert.deepEqual(metaLine(r.stderr), ["agent-meta: set rc=30 reason=host-timeout"]);
});

// ── clear ───────────────────────────────────────────────────────────────────
const CLEAR_CASES = [
  ["cleared", 0, { stdout: JSON.stringify({ status: "cleared" }) }, "agent_meta clear=cleared\n"],
  ["absent", 0, { stdout: JSON.stringify({ status: "absent" }) }, "agent_meta clear=absent\n"],
  ["applied is not a clear answer", 30, { stdout: JSON.stringify({ status: "applied" }) }, ""],
  ...REFUSALS.map((code) => [`[A1] ${code}`, 10, { rc: 1, stderr: `Error: ${code}: no\n` }, ""]),
  ["[A1] method_not_found", 20, { rc: 1, stderr: "Error: method_not_found: Unknown method\n" }, ""],
];
for (const [name, code, reply, out] of CLEAR_CASES) {
  test(`G2c-07 clear → ${code}: ${name}`, () => {
    const c = setCtx("g2c07", reply);
    const r = c.wh("agent-meta-clear", c.f.sid, "--stage", c.f.stage);
    assert.equal(r.status, code, r.stderr);
    assert.equal(r.stdout, out);
    const calls = c.calls().map((x) => x.argv);
    assert.deepEqual(calls.map((a) => a.slice(0, 2)), [["capabilities"], ["rpc", CLEAR]]);
    assert.deepEqual(JSON.parse(calls[1][2]), { surface_id: c.f.ids.surface_id, terminal_lifecycle_id: c.f.ids.terminal_lifecycle_id, sid: c.f.sid, attempt: c.f.attempt });
    assertClean(c);
  });
}

// ── unsupported (20) paths never reach rpc ──────────────────────────────────
test("G2c-08 set: no sealed record (no sandbox-current.json) → 20 without any rpc", () => {
  const c = setCtx("g2c08", { stdout: JSON.stringify({ status: "applied" }) });
  fs.rmSync(c.f.current);
  const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 20, r.stderr);
  assert.deepEqual(c.calls().map((x) => x.argv[0]), ["capabilities"]);
  assertClean(c);
});

test("G2c-08b set: binding not yet written → 20; invalid binding → 30; neither reaches rpc", () => {
  const c = setCtx("g2c08b", { stdout: JSON.stringify({ status: "applied" }) });
  fs.rmSync(c.f.bindingFile);
  let r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 20, r.stderr);
  fs.writeFileSync(c.f.bindingFile, "{}", { mode: 0o600 });
  r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 30, r.stderr);
  assert.ok(!c.calls().some((x) => x.argv[0] === "rpc"));
});

test("G2c-08c set: unpatched host caps → 20 and NO V1/legacy fallback call", () => {
  const c = setCtx("g2c08c", { stdout: JSON.stringify({ status: "applied" }) }, { capsStdout: realCaps(BASE_METHODS) });
  const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 20, r.stderr);
  assert.deepEqual(c.calls().map((x) => x.argv), [["capabilities"]]);
  assertClean(c);
});

test("G2c-08d set: cmux missing → 20", () => {
  const c = setup("g2c08d", {}, { cmux: "/nonexistent/it1162/cmux" });
  const f = sealedFixture(c.run, { launch: LAUNCH });
  const r = c.wh("agent-meta-set", f.sid, "--stage", f.stage, "--status-json", JSON.stringify(STATUS));
  assert.equal(r.status, 20, r.stderr);
});

// ── invalid input (30) never reaches the host ───────────────────────────────
const BAD_STATUS = [
  ["extra key", { ...STATUS, model: "x" }],
  ["missing key", (({ read_at, ...s }) => s)(STATUS)],
  ["connection CONNECTED (raw)", { ...STATUS, connection: "CONNECTED" }],
  ["connection idle", { ...STATUS, connection: "idle" }],
  ["activity outside r2 list", { ...STATUS, activity: "done" }],
  ["activity with newline", { ...STATUS, activity: "idle\n" }],
  ["activity_source observed", { ...STATUS, activity_source: "observed" }],
  ["unknown source but known activity", { ...STATUS, activity_source: "unknown", activity: "working" }],
  ["dispatch shell text", { ...STATUS, dispatch: "$(touch CANARY)" }],
  ["dispatch too long", { ...STATUS, dispatch: "a".repeat(41) }],
  ["dispatch upper-case", { ...STATUS, dispatch: "DELIVERED" }],
  ["read_at bool", { ...STATUS, read_at: true }],
  ["read_at fraction", { ...STATUS, read_at: 1.5 }],
  ["read_at negative", { ...STATUS, read_at: -1 }],
  ["read_at string", { ...STATUS, read_at: "1790000000" }],
  ["read_at unsafe integer", { ...STATUS, read_at: 2 ** 53 }],
];
for (const [name, status] of BAD_STATUS) {
  test(`G2c-09 invalid status JSON → 30 before any host call: ${name}`, () => {
    const c = setCtx("g2c09", { stdout: JSON.stringify({ status: "applied" }) });
    const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", JSON.stringify(status));
    assert.equal(r.status, 30, r.stderr);
    assert.deepEqual(c.calls(), [], "host was called on invalid input");
    assert.equal(fs.existsSync(path.join(c.run.dir, "CANARY")), false);
  });
}

test("G2c-09b status JSON not JSON / shell text → 30, no host call, no side effect", () => {
  const c = setCtx("g2c09b", { stdout: JSON.stringify({ status: "applied" }) });
  const canary = path.join(c.run.dir, "SHELL-CANARY");
  for (const raw of ["", "{", `'; touch ${canary}; '`, `$(touch ${canary})`, "null", "[]"]) {
    const r = c.wh("agent-meta-set", c.f.sid, "--stage", c.f.stage, "--status-json", raw);
    assert.equal(r.status, 30, `raw=${raw} ${r.stderr}`);
  }
  assert.deepEqual(c.calls(), []);
  assert.equal(fs.existsSync(canary), false);
});

const BAD_ARGS = [
  ["sid traversal", (f) => ["agent-meta-set", "../x", "--stage", f.stage, "--status-json", JSON.stringify(STATUS)]],
  ["relative stage", (f) => ["agent-meta-set", f.sid, "--stage", "rel/stage", "--status-json", JSON.stringify(STATUS)]],
  ["stage with ..", (f) => ["agent-meta-set", f.sid, "--stage", `${f.stage}/../${f.sid}`, "--status-json", JSON.stringify(STATUS)]],
  ["stage trailing slash", (f) => ["agent-meta-set", f.sid, "--stage", `${f.stage}/`, "--status-json", JSON.stringify(STATUS)]],
  ["duplicate flag", (f) => ["agent-meta-set", f.sid, "--stage", f.stage, "--stage", f.stage, "--status-json", JSON.stringify(STATUS)]],
  ["missing status-json", (f) => ["agent-meta-set", f.sid, "--stage", f.stage]],
  ["clear with extra flag", (f) => ["agent-meta-clear", f.sid, "--stage", f.stage, "--status-json", "{}"]],
  ["caps with an argument", () => ["agent-meta-caps", "x"]],
];
for (const [name, argsOf] of BAD_ARGS) {
  test(`G2c-10 bad argv → 30 with no host call: ${name}`, () => {
    const c = setCtx("g2c10", { stdout: JSON.stringify({ status: "applied" }) });
    const r = c.wh(...argsOf(c.f));
    assert.equal(r.status, 30, r.stderr);
    assert.deepEqual(c.calls(), []);
  });
}

// ── non-cmux hosts ──────────────────────────────────────────────────────────
for (const adapter of ["warp", "aterm", "tmux", "wezterm", "iterm", "headless"]) {
  test(`G2c-11 ${adapter}: agent-meta-* is an explicit 20 (never 0/127), no cmux call`, () => {
    const c = setup("g2c11", {}, { adapter });
    const f = sealedFixture(c.run, {});
    const caps = c.wh("agent-meta-caps");
    assert.equal(caps.status, 20, caps.stderr);
    assert.equal(caps.stdout, `agent_meta caps=unsupported adapter=${adapter} reason=not-implemented\n`);
    assert.equal(c.wh("agent-meta-set", f.sid, "--stage", f.stage, "--status-json", JSON.stringify(STATUS)).status, 20);
    assert.equal(c.wh("agent-meta-clear", f.sid, "--stage", f.stage).status, 20);
    assert.deepEqual(c.calls(), []);
    assert.equal(c.run.tripwireHits(), "");
  });
}

test("G2c-12 cmux adapter with no compiled implementation → 20 (shim miss is unsupported, not 127)", () => {
  const run = makeRun("g2c12");
  // A bin/ copy whose ../dist has no agent-metadata.js; aigentry-orchestrator is a
  // tripwire on PATH, so the shim's package fallback cannot resolve either.
  const tree = path.join(run.dir, "tree");
  fs.cpSync(BIN, path.join(tree, "bin"), { recursive: true });
  const r = sh(path.join(tree, "bin", "wh-cli.sh"), ["agent-meta-caps"], { env: hermeticEnv(run, { AIGENTRY_WORKSPACE_HOST: "cmux", CMUX: "/nonexistent" }) });
  assert.equal(r.status, 20, r.stderr);
  assert.equal(r.stdout, "agent_meta caps=unsupported adapter=cmux reason=implementation-missing\n");
});

test("G2c-13 binding reader absent next to agent-metadata.js → 20", () => {
  const run = makeRun("g2c13");
  const tree = path.join(run.dir, "tree");
  fs.cpSync(BIN, path.join(tree, "bin"), { recursive: true });
  fs.cpSync(DIST, path.join(tree, "dist"), { recursive: true });
  fs.rmSync(path.join(tree, "dist/src/session/agent-binding.js"));
  fs.symlinkSync(path.resolve(DIST, "..", "node_modules"), path.join(tree, "node_modules"));
  const scen = path.join(run.dir, "s.json");
  fs.writeFileSync(scen, JSON.stringify({ capabilities: { stdout: realCaps() } }));
  const log = path.join(run.logs, "cmux.jsonl");
  const f = sealedFixture(run, { launch: LAUNCH });
  const r = sh(path.join(tree, "bin", "wh-cli.sh"), ["agent-meta-set", f.sid, "--stage", f.stage, "--status-json", JSON.stringify(STATUS)],
    { env: hermeticEnv(run, { AIGENTRY_WORKSPACE_HOST: "cmux", CMUX: FAKE, FAKE_CMUX_SCENARIO: scen, FAKE_CMUX_LOG: log }) });
  assert.equal(r.status, 20, r.stderr);
});
