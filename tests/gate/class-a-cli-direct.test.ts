// ADR-MF #15 — Class A cli_direct wrapper smoke tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type SessionContext, type SpawnRequest } from "../../src/session/types.js";
import { __resetModeTrackingForTests } from "../../src/session/validate-spawn.js";
import { gatedCliDirectSpawn, type CliDirectArg } from "../../src/gate/class-a/cli_direct.js";

const TMP = tmpdir();
const parent = (): SessionContext => ({
  session_id: "S-p", role: Role.coder, cwd: TMP, task_id: "T-p",
  effective_prompt_digest: "0".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00",
  permissions: ["read_fs", "write_fs"],
});
const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });
const arg = (cli?: "claude" | "codex" | "gemini"): CliDirectArg => ({
  ...(cli !== undefined ? { cli } : {}),
  argv: ["claude", "--bare"], env: { HOME: TMP }, cwd: TMP,
});

test("cli_direct: persist runs BEFORE dispatch, cli advisory honored", async () => {
  __resetModeTrackingForTests();
  const order: string[] = [];
  let seen: CliDirectArg | null = null;
  const res = await gatedCliDirectSpawn(req(), arg("claude"), {
    parent: parent(), mode: "warn", emit: () => {},
    ctx_persist: () => { order.push("persist"); },
    dispatch: (a) => { order.push("dispatch"); seen = a; return 0; },
  });
  assert.equal(res.ok, true);
  assert.equal(seen!.cli, "claude");
  assert.deepEqual(order, ["persist", "dispatch"]);
});

test("cli_direct hard-fail: capability expansion blocked, no dispatch", async () => {
  __resetModeTrackingForTests();
  let dispatched = false;
  const res = await gatedCliDirectSpawn(
    req({ requested_permissions: ["network"] }), arg(),
    { parent: parent(), mode: "hard-fail", emit: () => {},
      dispatch: () => { dispatched = true; return 0; } },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error.code, /CAPABILITY_(DENIED|EXPANSION)/);
  assert.equal(dispatched, false);
});
