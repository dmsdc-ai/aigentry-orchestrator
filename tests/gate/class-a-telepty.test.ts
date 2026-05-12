// ADR-MF #15 — Class A telepty wrapper smoke tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type SessionContext, type SpawnRequest } from "../../src/session/types.js";
import { __resetModeTrackingForTests } from "../../src/session/validate-spawn.js";
import { gatedTeleptyInject, type TeleptyDispatchArg } from "../../src/gate/class-a/telepty.js";
import type { SpawnEvent } from "../../src/telemetry/spawn-events.js";

const TMP = tmpdir();
const parent = (): SessionContext => ({
  session_id: "S-parent", role: Role.coder, cwd: TMP, task_id: "T-parent",
  effective_prompt_digest: "0".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00",
});
const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });
const arg = (): TeleptyDispatchArg => ({
  target_session_id: "child", payload: "hi",
  argv: ["telepty", "inject", "child", "hi"], env: { X: "1" },
});

test("happy path: enforce passes, dispatch invoked with effective role overlay", async () => {
  __resetModeTrackingForTests();
  const events: SpawnEvent[] = [];
  let seen: TeleptyDispatchArg | null = null;
  const res = await gatedTeleptyInject(req(), arg(), {
    parent: parent(), mode: "warn", emit: (e) => events.push(e),
    dispatch: (a) => { seen = a; return { exit_code: 0 }; },
  });
  assert.equal(res.ok, true);
  assert.equal(seen!.env["AIGENTRY_EFFECTIVE_ROLE"], Role.coder);
  assert.ok(events.some((e) => e.event === "spawn_accepted"));
});

test("hard-fail: missing role → {ok:false, ERR_ROLE_MISSING}; dispatcher NOT called", async () => {
  __resetModeTrackingForTests();
  let dispatched = false;
  const res = await gatedTeleptyInject(
    req({ role: undefined as unknown as Role }), arg(),
    { mode: "hard-fail", emit: () => {}, dispatch: () => { dispatched = true; return null; } },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "ERR_ROLE_MISSING");
  assert.equal(dispatched, false);
});

test("ctx_persist failure aborts before dispatch (G6)", async () => {
  __resetModeTrackingForTests();
  let dispatched = false;
  await assert.rejects(
    gatedTeleptyInject(req(), arg(), {
      parent: parent(), mode: "warn", emit: () => {},
      ctx_persist: () => { throw new Error("disk-full"); },
      dispatch: () => { dispatched = true; return null; },
    }),
    /disk-full/,
  );
  assert.equal(dispatched, false);
});
