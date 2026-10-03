// #1162 r2 delta — G2c. Runs the REAL wrapper chain (wh-cli.sh → workspace-host.sh →
// agent-metadata.js → agent-binding.js) of this tree against the fake
// cmux recorder. Reply/error bytes here are taken from STAGED SOURCE, not runtime:
//   * reply  : agentMetadataApply → .ok(["status", "surface_id": uuidString,
//              "workspace_id": uuidString]) (g2c-r2 TerminalController+AgentMetadata.swift
//              :410-416; Swift uuidString is upper-case);
//   * errors : agentMetadataError → .err(code, "request refused" | parse message) →
//              CLI formatV2Error "<code>: <message>" → main "Error: \(error)" with
//              CLIError.description == message (CLIError.swift).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { BIN, HERE, hermeticEnv, makeRun, sealedFixture, sh } from "./support/harness.mjs";

const SET = "surface.agent_metadata.set";
const CLEAR = "surface.agent_metadata.clear";
const FAKE = path.join(HERE, "fake-cmux.mjs");
const STATUS = { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "none", read_at: 1790596800 };
const LAUNCH = { v: 2, cli: "claude", model: { value: "claude-opus-5", source: "default" }, effort: { value: "xhigh", source: "default" } };
const HOST_CAPS = (over = {}) => JSON.stringify({
  protocol: "cmux-socket", version: 2, socket_path: "/fixture/cmux.sock", access_mode: "cmuxOnly",
  capabilities: { terminal: true }, methods: ["surface.list", SET, CLEAR, "system.capabilities"].sort(), ...over,
});

function ctx(label, scenario) {
  const run = makeRun(label);
  const scen = path.join(run.dir, "scenario.json");
  fs.writeFileSync(scen, JSON.stringify(scenario));
  const log = path.join(run.logs, "cmux.jsonl");
  fs.writeFileSync(log, "");
  const env = hermeticEnv(run, { AIGENTRY_WORKSPACE_HOST: "cmux", CMUX: FAKE, FAKE_CMUX_SCENARIO: scen, FAKE_CMUX_LOG: log });
  return {
    run,
    wh: (...a) => sh(path.join(BIN, "wh-cli.sh"), a, { env, timeout: 60000 }),
    calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

// ── host reply / error bytes from the staged G1 + CLIError source ───────────
const UP = (u) => u.toUpperCase();
test("R2-C01 host-shape success replies (status + upper-case surface_id/workspace_id) → set 0, clear 0", () => {
  const c = ctx("r2c01", {
    capabilities: { stdout: HOST_CAPS() },
    [`rpc:${SET}`]: { stdout: JSON.stringify({ status: "applied", surface_id: UP("0f1162aa-0000-4000-8000-000000000002"), workspace_id: UP("0f1162aa-0000-4000-8000-000000000001") }) },
    [`rpc:${CLEAR}`]: { stdout: JSON.stringify({ status: "absent", surface_id: UP("0f1162aa-0000-4000-8000-000000000002"), workspace_id: UP("0f1162aa-0000-4000-8000-000000000001") }) },
  });
  const f = sealedFixture(c.run, { launch: LAUNCH });
  assert.equal(c.wh("agent-meta-set", f.sid, "--stage", f.stage, "--status-json", JSON.stringify(STATUS)).status, 0);
  const r = c.wh("agent-meta-clear", f.sid, "--stage", f.stage);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "agent_meta clear=absent\n");
  assert.equal(c.run.tripwireHits(), "");
});

const HOST_ERRORS = [
  ["surface_gone", "surface is not live", 10],
  ["surface_gone", "surface has no live owner", 10],
  ["stale_lifecycle", "terminal_lifecycle_id is not current", 10],
  ["owned_by_other_sid", "request refused", 10],
  ["stale_attempt", "request refused", 10],
  ["lifecycle_cleared", "request refused", 10],
  ["invalid_params", "params must have exactly: attempt, fields, sid, surface_id, terminal_lifecycle_id", 30],
  ["invalid_params", "fields.activity must be unknown when activity_source is unknown", 30],
  ["method_not_found", "Unknown method", 20],
];
for (const [code, message, exit] of HOST_ERRORS) {
  test(`R2-C02 source-exact host error "Error: ${code}: ${message}" → ${exit}`, () => {
    const c = ctx("r2c02", { capabilities: { stdout: HOST_CAPS() }, [`rpc:${SET}`]: { rc: 1, stderr: `Error: ${code}: ${message}\n` } });
    const f = sealedFixture(c.run, { launch: LAUNCH });
    const r = c.wh("agent-meta-set", f.sid, "--stage", f.stage, "--status-json", JSON.stringify(STATUS));
    assert.equal(r.status, exit, r.stderr);
    assert.ok(!r.stderr.includes(message), "host text echoed");
  });
}

// ── caps schema strictness beyond `methods` (accepted caps contract, r3) ─────
// The host schema is {protocol:"cmux-socket", version:2, …, methods:[String]}. These
// replies carry both names in `methods` but violate the rest of the known schema.
// Oracle: strict known-schema reading ⇒ 20.
const SCHEMA = [
  ["protocol not cmux-socket", { protocol: "other-socket" }],
  ["protocol missing", { protocol: undefined }],
  ["version 1", { version: 1 }],
  ["version \"2\" (string)", { version: "2" }],
  ["methods mixed types", { methods: [SET, CLEAR, 5, null, { x: 1 }, ["surface.list"]] }],
];
for (const [name, over] of SCHEMA) {
  test(`R2-C03 SCHEMA caps must be 20: ${name}`, () => {
    const body = JSON.parse(HOST_CAPS());
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete body[k]; else body[k] = v;
    const c = ctx("r2c03", { capabilities: { stdout: JSON.stringify(body) } });
    const r = c.wh("agent-meta-caps");
    assert.equal(r.status, 20, `schema-violating caps accepted: rc=${r.status} ${JSON.stringify(r.stdout)}`);
  });
}

test("R2-C03b positive control: exact host schema with duplicate-free sorted methods → 0", () => {
  const c = ctx("r2c03b", { capabilities: { stdout: HOST_CAPS() } });
  assert.equal(c.wh("agent-meta-caps").status, 0);
});

// ── legacy `unknown` pill, measured through the REAL wrapper ────────────────
// G3 sends `set-status <ws> unknown` for health outside CONNECTED/DISCONNECTED.
// Before r3 the real _wh_cmux_set_status had no `unknown` row (`*) return 0`), so an
// earlier idle/working pill on that workspace was left in place. Expected: the
// unknown answer must not leave a stale activity pill (clear or replace it).
test("R2-C04 legacy set-status unknown after an old working pill must reach the host (no stale row, real wrapper)", () => {
  const c = ctx("r2c04", { "set-status": { rc: 0 }, "clear-status": { rc: 0 } });
  assert.equal(c.wh("set-status", "workspace:7", "working").status, 0);
  assert.equal(c.wh("set-status", "workspace:7", "unknown").status, 0);
  const argv = c.calls().map((x) => x.argv.slice(0, 3).join(" "));
  assert.deepEqual(argv.slice(0, 1), ["set-status aigentry working"], "positive control: the old pill was written");
  const afterUnknown = c.calls().slice(1);
  assert.ok(afterUnknown.length > 0,
    `'set-status unknown' issued no host call; the stale 'working' pill stays (calls=${JSON.stringify(argv)})`);
});
