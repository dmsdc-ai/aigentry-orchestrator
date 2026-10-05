// Pins the model-router fixture's tripwires themselves (#1162). The fixture answers exactly one
// cmux question — `cmux capabilities` — so the best-effort agent-metadata publish after a spawn
// can run to "unsupported"; everything else it stubs must still trip WORK_LOG, and cleanup()
// must still reject a tripped log. Only the fixture's own stub scripts, the fixture env and
// the fixture-driven dispatch are exercised: no real cmux, provider CLI or host surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, REPO } from "./model-router-fixtures.js";

type Fixture = ReturnType<typeof fixture>;

/** Runs one fixture stub by path through this node, so the shebang form never matters; win32 cmux is the native bin\cmux.exe. */
function stub(f: Fixture, name: string, argv: string[]) {
  if (name === "cmux" && process.platform === "win32") return spawnSync(join(f.bin, "cmux.exe"), argv, { env: f.env, encoding: "utf8", timeout: 20000 });
  return spawnSync(process.execPath, [join(f.bin, name), ...argv], { env: f.env, encoding: "utf8", timeout: 20000 });
}
const capsLog = (f: Fixture) => existsSync(f.env.CMUX_CAPS_LOG!) ? readFileSync(f.env.CMUX_CAPS_LOG!, "utf8") : "";
const capsCalls = (f: Fixture) => capsLog(f).split("\n").filter(Boolean).length;
const TRIPPED = /model\/work tripwire must remain untouched/;

/** A deliberately tripped WORK_LOG must make cleanup() throw, and still remove the root. */
function assertCleanupRejects(f: Fixture) {
  assert.throws(() => f.cleanup(), TRIPPED);
  assert.equal(existsSync(f.root), false, "cleanup still removes the fixture root after rejecting");
}

test("fixture cmux answers exactly [capabilities]: recorded, valid unsupported reply, exit 0", () => {
  const f = fixture();
  try {
    const r = stub(f, "cmux", ["capabilities"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { protocol: "cmux-socket", version: 2, methods: [] });
    assert.equal(capsLog(f), '["capabilities"]\n');
    assert.equal(existsSync(f.env.WORK_LOG!), false);
  } finally { f.cleanup(); }
});

for (const argv of [["rpc", "surface.agent_metadata.set", "{}"], ["rpc", "surface.agent_metadata.clear", "{}"],
  ["capabilities", "--json"], ["capabilities", ""], ["Capabilities"], []]) {
  test(`fixture cmux denies ${JSON.stringify(argv)}: WORK_LOG trip, exit 99, cleanup rejects`, () => {
    const f = fixture();
    const r = stub(f, "cmux", argv);
    assert.equal(r.status, 99);
    assert.equal(r.stdout, "", "a denied argv gets no capabilities reply");
    assert.equal(readFileSync(f.env.WORK_LOG!, "utf8"), "forbidden\n");
    assert.equal(capsCalls(f), 0, "a denied argv is never recorded as a capability query");
    assertCleanupRejects(f);
  });
}

test("model CLI launches and every other forbidden command still trip WORK_LOG", () => {
  for (const cli of ["claude", "codex", "gemini", "grok", "agy"]) {
    const f = fixture();
    const r = stub(f, cli, ["-p", "fixture"]);
    assert.equal(r.status, 99, cli);
    assert.equal(readFileSync(f.env.WORK_LOG!, "utf8"), "model\n", cli);
    assertCleanupRejects(f);
  }
  const forbidden = ["apply_patch", "ps", "kill", "pkill", "killall", "launchctl", "open", "osascript", "tmux", "curl", "wget", "ssh", "npm", "npx", "srt"];
  const f = fixture();
  for (const command of forbidden) assert.equal(stub(f, command, ["capabilities"]).status, 99, command);
  assert.equal(readFileSync(f.env.WORK_LOG!, "utf8"), "forbidden\n".repeat(forbidden.length));
  assert.equal(capsCalls(f), 0);
  assertCleanupRejects(f);
});

test("the adapter reads the fixture capabilities reply as unsupported (rc 20) and sends no rpc", () => {
  const f = fixture();
  try {
    const adapter = join(REPO, "dist/src/session/agent-metadata.js");
    const status = JSON.stringify({ connection: "unknown", activity: "unknown", activity_source: "unknown", dispatch: "none", read_at: 0 });
    const runs = [["caps"], ["set", "router-fixture", "--stage", join(f.aig, "sessions/router-fixture"), "--status-json", status]];
    for (const argv of runs) {
      const r = spawnSync(process.execPath, [adapter, ...argv], { env: f.env, encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 20, r.stderr);
      assert.equal(r.stderr, `agent-meta: ${argv[0]} rc=20 reason=capability-missing\n`);
    }
    assert.equal(capsLog(f), '["capabilities"]\n'.repeat(runs.length), "one capability query per adapter call, nothing else");
    assert.equal(existsSync(f.env.WORK_LOG!), false, "no rpc and no other cmux call reached the fixture");
  } finally { f.cleanup(); }
});

test("a fresh spawn asks capabilities exactly once and reports unsupported; a deduplicated repeat asks none", () => {
  const f = fixture();
  try {
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"]);
    if (process.platform === "win32") {
      // #1167 P6: the confined spawn refuses before any effect, so no agent metadata is published (no cmux
      // question); it records nothing, so the repeat is refused again, not deduplicated, and asks none either.
      f.refused(r);
      f.refused(f.dispatch([...f.spawnArgs, "--role", "coder"]));
      assert.equal(capsCalls(f), 0);
      return;
    }
    assert.equal(r.status, 0, r.stderr);
    assert.equal(capsLog(f), '["capabilities"]\n');
    assert.match(r.stderr, /WARNING agent-meta-set rc=20 for router-fixture \(spawn not gated\)/);
    f.manifest();
    const again = f.dispatch([...f.spawnArgs, "--role", "coder"]);
    assert.equal(again.status, 8, again.stderr);
    assert.equal(capsCalls(f), 1, "the deduplicated dispatch spawns nothing and asks nothing");
  } finally { f.cleanup(); }
});

test("an existing --target dispatch never asks cmux", () => {
  const f = fixture();
  try {
    f.prepareTarget();
    const r = f.dispatch(["--target", "router-fixture"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(capsCalls(f), 0);
    assert.doesNotMatch(r.stderr, /agent-meta/);
  } finally { f.cleanup(); }
});
