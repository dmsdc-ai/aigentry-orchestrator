// #1162 r3 delta — G2c. REAL wrapper chain of this tree (wh-cli.sh →
// workspace-host.sh → agent-metadata.js → agent-binding.js) against the fake cmux
// recorder. Accepted controller contract (r3):
//   * caps 0 only for a top-level plain object with protocol === "cmux-socket",
//     numeric version 2 and an all-string `methods` holding both verbs; any other
//     valid JSON reply is 20 (and set/clear then never reach rpc);
//   * legacy `set-status <ws> unknown` explicitly replaces a stale working/idle pill
//     under the same `aigentry` key with a neutral pill; no model/effort in it.
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
const HOST = () => ({
  protocol: "cmux-socket", version: 2, socket_path: "/fixture/cmux.sock", access_mode: "cmuxOnly",
  capabilities: { terminal: true }, methods: ["surface.list", SET, CLEAR, "system.capabilities"].sort(),
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
function clean(c) {
  assert.equal(c.run.tripwireHits(), "", "tripwire hit");
  assert.ok(!c.calls().some((x) => x.unexpected), JSON.stringify(c.calls()));
}

// ── caps schema (raw stdout text, so JSON-level shapes are exact) ────────────
const with_ = (over) => JSON.stringify({ ...HOST(), ...over });
const without = (k) => { const b = HOST(); delete b[k]; return JSON.stringify(b); };
const CAPS20 = [
  ["top-level null", "null"],
  ["top-level number", "2"],
  ["top-level string", JSON.stringify(`${SET} ${CLEAR}`)],
  ["top-level true", "true"],
  ["protocol upper-case", with_({ protocol: "CMUX-SOCKET" })],
  ["protocol null", with_({ protocol: null })],
  ["version missing", without("version")],
  ["version 3", with_({ version: 3 })],
  ["version 2.5", with_({ version: 2.5 })],
  ["version null", with_({ version: null })],
  ["methods missing", without("methods")],
  ["methods object keyed by the verbs", with_({ methods: { [SET]: true, [CLEAR]: true } })],
  ["methods with both verbs plus one number", with_({ methods: [SET, CLEAR, 1] })],
  ["methods with both verbs plus one boolean", with_({ methods: [SET, CLEAR, true] })],
  ["methods only set (strings only)", with_({ methods: [SET] })],
];
for (const [name, stdout] of CAPS20) {
  test(`G2cR3-CAPS schema violation → 20: ${name}`, () => {
    const c = ctx("g2cr3caps", { capabilities: { stdout } });
    const r = c.wh("agent-meta-caps");
    assert.equal(r.status, 20, `accepted: rc=${r.status} ${JSON.stringify(r.stdout)}`);
    assert.notEqual(r.stdout, "agent_meta caps=supported adapter=cmux\n");
    clean(c);
  });
}

const CAPS0 = [
  ["exact host shape", JSON.stringify(HOST())],
  ["extra unknown top-level fields are ignored", with_({ build: "x", flags: [1, 2], nested: { methods: [] } })],
  ["version written as 2.0 (numeric 2 in JSON)", JSON.stringify(HOST()).replace('"version":2', '"version":2.0')],
  ["duplicate method strings", with_({ methods: [SET, SET, CLEAR, CLEAR] })],
];
for (const [name, stdout] of CAPS0) {
  test(`G2cR3-CAPS0 positive control → 0: ${name}`, () => {
    const c = ctx("g2cr3caps0", { capabilities: { stdout } });
    const r = c.wh("agent-meta-caps");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "agent_meta caps=supported adapter=cmux\n");
    clean(c);
  });
}

for (const [verb, extra] of [["agent-meta-set", ["--status-json", JSON.stringify(STATUS)]], ["agent-meta-clear", []]]) {
  test(`G2cR3-CAPS-rpc ${verb} under a schema-violating caps (version 1) → 20 with NO rpc`, () => {
    const c = ctx("g2cr3capsrpc", {
      capabilities: { stdout: with_({ version: 1 }) },
      [`rpc:${SET}`]: { stdout: JSON.stringify({ status: "applied" }) },
      [`rpc:${CLEAR}`]: { stdout: JSON.stringify({ status: "cleared" }) },
    });
    const f = sealedFixture(c.run, { launch: LAUNCH });
    const r = c.wh(verb, f.sid, "--stage", f.stage, ...extra);
    assert.equal(r.status, 20, r.stderr);
    assert.deepEqual(c.calls().map((x) => x.argv[0]), ["capabilities"]);
    clean(c);
  });
}

// ── legacy unknown pill replaces a stale activity pill (R4) ──────────────────
for (const prior of ["working", "idle"]) {
  test(`G2cR3-UNK set-status unknown after ${prior} replaces it under the same key/workspace, neutral, no model/effort`, () => {
    const c = ctx("g2cr3unk", { "set-status": { rc: 0 } });
    assert.equal(c.wh("set-status", "workspace:7", prior).status, 0);
    const r = c.wh("set-status", "workspace:7", "unknown");
    assert.equal(r.status, 0, r.stderr);
    const argv = c.calls().map((x) => x.argv);
    assert.equal(argv.length, 2, JSON.stringify(argv));
    assert.deepEqual(argv[1], ["set-status", "aigentry", "unknown", "--icon", "questionmark", "--color", "#8e8e93", "--workspace", "workspace:7"]);
    assert.deepEqual([argv[0][0], argv[0][1], argv[0].at(-2), argv[0].at(-1)], ["set-status", "aigentry", "--workspace", "workspace:7"],
      "positive control: the stale pill used the same key and workspace");
    assert.ok(!argv[1].some((a) => /model|effort|claude|opus|observed|configured/i.test(a)), "no model/effort in the legacy pill");
    assert.ok(!["#ff9500", "#34c759", "#ff3b30"].includes(argv[1][6]), "neutral, not an activity/health colour");
    clean(c);
  });
}

test("G2cR3-UNK-ctl an unrecognized state is still a no-op (no speculative pill)", () => {
  const c = ctx("g2cr3unkctl", { "set-status": { rc: 0 } });
  assert.equal(c.wh("set-status", "workspace:7", "bogus").status, 0);
  assert.deepEqual(c.calls(), []);
  clean(c);
});
