import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../dispatch/model-router-fixtures.js";
import { mutateConfig } from "../../src/environment/storage.js";

test("actual dispatcher resolves canonical target project before role sandbox and seals the chosen model/effort", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const f = fixture();
  try {
    chmodSync(f.aig, 0o700);
    mutateConfig(f.aig, 0, (c) => {
      c.settings = { "dispatch.cli": "claude", "claude.model": "claude-opus-5-5", "claude.effort": "high" };
      c.projects[join(f.root, "project")] = { "claude.effort": "medium" };
      return c;
    });
    const r = f.dispatch([...f.spawnArgs, "--role", "coder", "--task", "1083"]);
    assert.equal(r.status, 0, r.stderr);
    const m = f.manifest();
    assert.equal(m.cli, "claude");
    assert.equal(m.command[m.command.indexOf("--model") + 1], "claude-opus-5-5");
    assert.equal(m.command[m.command.indexOf("--effort") + 1], "medium");
    assert.notEqual(m.cwd, join(f.root, "project"));
    assert.match(readFileSync(f.env.TELEMETRY_LOG!, "utf8"), /claude-opus-5-5/);
  } finally { f.cleanup(); }
});

test("actual dispatch flags beat central profile and conflicting invalid settings have no spawn effects", { skip: !["darwin", "linux"].includes(process.platform) }, () => {
  const f = fixture();
  try {
    chmodSync(f.aig, 0o700);
    mutateConfig(f.aig, 0, (c) => { c.profiles.work = { "claude.model": "claude-opus-5" }; c.selectedProfile = "work"; return c; });
    const args = [...f.spawnArgs, "--cli", "claude", "--model", "claude-opus-5-5", "--effort", "high", "--role", "coder", "--task", "1083"];
    const refusal = f.dispatch(args, { AIGENTRY_CLAUDE_MODEL: "invalid model" });
    assert.equal(refusal.status, 4);
    assert.match(refusal.stderr, /ENV_CONFIGURATION_REFUSED/);
    assert.equal(existsSync(f.env.OPEN_LOG!), false);
    const r = f.dispatch(args);
    assert.equal(r.status, 0, r.stderr);
    const events = readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const start = events.find((args) => args.includes("dispatch_start"))!;
    const payload = JSON.parse(start[start.indexOf("--payload-json") + 1]!);
    assert.equal(payload.decision.requested.source, "flag");
    assert.equal(payload.decision.requested.model, "claude-opus-5-5");
    assert.equal(payload.decision.selected.model, "claude-opus-5-5");
    const m = f.manifest();
    assert.equal(m.command[m.command.indexOf("--effort") + 1], "high");
  } finally { f.cleanup(); }
});
