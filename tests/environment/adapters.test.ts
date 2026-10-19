import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBootAdapter, memoryBootFs, mockSpawner } from "../../src/session/boot-adapter/index.js";
import { Role, type SessionContext } from "../../src/session/types.js";
import { mutateConfig } from "../../src/environment/storage.js";

test("real adapter resolves central settings before probe/staging and keeps empty-config defaults", { skip: process.platform === "win32" }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-adapter-")));
  const original = process.env.AIGENTRY_HOME;
  const previousModel = process.env.AIGENTRY_CLAUDE_MODEL;
  const previousEffort = process.env.AIGENTRY_CLAUDE_EFFORT;
  try {
    process.env.AIGENTRY_HOME = home; delete process.env.AIGENTRY_CLAUDE_MODEL; delete process.env.AIGENTRY_CLAUDE_EFFORT;
    const ctx: SessionContext = { session_id: "fixture", role: Role.coder, cwd: home, task_id: "1233", effective_prompt_digest: "fixture-digest",
      effective_prompt_path: "fixture.md", layers: [], spawn_chain: [], depth: 0, created_at: "2026-10-13T00:00:00Z" };
    const instructions = { effective_prompt: "fixture prompt", effective_prompt_digest: "fixture-digest", layers: [], project_id: "none" };
    const build = () => getBootAdapter("claude").buildBootCommand(ctx, instructions,
      { staging_dir: path.join(home, "staging"), fs: memoryBootFs(), spawner: mockSpawner({ claude: { version: "100.0.0" } }) });
    const legacy = await build();
    assert.equal(legacy.argv[legacy.argv.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(legacy.argv[legacy.argv.indexOf("--effort") + 1], "xhigh");
    mutateConfig(home, 0, (c) => { c.settings = { "claude.model": "fixture-central-model", "claude.effort": "high" }; return c; });
    const central = await build();
    assert.equal(central.argv[central.argv.indexOf("--model") + 1], "fixture-central-model");
    assert.equal(central.launch?.model.value, "fixture-central-model");
    process.env.AIGENTRY_CLAUDE_MODEL = "invalid model";
    const spawner = mockSpawner({ claude: { version: "100.0.0" } });
    const memory = memoryBootFs(), staged: string[] = [];
    const watched = { ...memory,
      async writeFile(p: string, bytes: Uint8Array) { staged.push("write:" + p); await memory.writeFile(p, bytes); },
      async mkdirP(p: string) { staged.push("mkdir:" + p); await memory.mkdirP(p); },
    };
    await assert.rejects(getBootAdapter("claude").buildBootCommand(ctx, instructions,
      { staging_dir: path.join(home, "rejected"), fs: watched, spawner }), /ENV_INVALID_VALUE/);
    assert.equal(spawner.calls.length, 0);
    assert.deepEqual(staged, []);
    assert.equal(memory.snapshot().size, 0);
  } finally {
    if (original === undefined) delete process.env.AIGENTRY_HOME; else process.env.AIGENTRY_HOME = original;
    if (previousModel === undefined) delete process.env.AIGENTRY_CLAUDE_MODEL; else process.env.AIGENTRY_CLAUDE_MODEL = previousModel;
    if (previousEffort === undefined) delete process.env.AIGENTRY_CLAUDE_EFFORT; else process.env.AIGENTRY_CLAUDE_EFFORT = previousEffort;
    fs.rmSync(home, { recursive: true });
  }
});
