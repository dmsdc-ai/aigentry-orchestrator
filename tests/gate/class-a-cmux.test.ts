// ADR-MF #15 — Class A cmux wrapper smoke tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type SessionContext, type SpawnRequest } from "../../src/session/types.js";
import { __resetModeTrackingForTests } from "../../src/session/validate-spawn.js";
import { gatedCmuxSpawn, type CmuxDispatchArg } from "../../src/gate/class-a/cmux.js";

const TMP = tmpdir();
const parent = (over: Partial<SessionContext> = {}): SessionContext => ({
  session_id: "S-p", role: Role.coder, cwd: TMP, task_id: "T-p",
  effective_prompt_digest: "0".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00", ...over,
});
const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });
const arg = (): CmuxDispatchArg => ({
  workspace_name: "ws", kind: "session",
  argv: ["cmux", "session", "create", "ws"], env: {},
});

test("cmux happy path dispatches with role overlay", async () => {
  __resetModeTrackingForTests();
  let seen: CmuxDispatchArg | null = null;
  const res = await gatedCmuxSpawn(req(), arg(), {
    parent: parent(), mode: "warn", emit: () => {},
    dispatch: (a) => { seen = a; return { workspace_id: "WS-1" }; },
  });
  assert.equal(res.ok, true);
  assert.equal(seen!.env["AIGENTRY_EFFECTIVE_ROLE"], Role.coder);
  if (res.ok) assert.equal(res.result.workspace_id, "WS-1");
});

test("cmux hard-fail: ERR_ORCHESTRATOR_CLONE without override → no dispatch", async () => {
  __resetModeTrackingForTests();
  let dispatched = false;
  const res = await gatedCmuxSpawn(
    req({ role: Role.orchestrator }), arg(),
    { parent: parent({ role: Role.orchestrator }), mode: "hard-fail", emit: () => {},
      dispatch: () => { dispatched = true; return null; } },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "ERR_ORCHESTRATOR_CLONE");
  assert.equal(dispatched, false);
});
