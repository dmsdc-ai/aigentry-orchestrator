// ADR-MF #10 §3.1 — parent→child→grandchild role preservation across #99 + #103.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type AgentRecord, type SessionContext } from "../../src/session/types.js";
import { validateSpawn } from "../../src/session/validate-spawn.js";
import { checkSpawnPermissions } from "../../src/session/permission-manager.js";
import { makeChain, makeChildOf } from "../fixtures/adr-mf/context-factory.js";

const TMP = tmpdir();

test("D1 — orchestrator → coder → coder validates at each link", () => {
  const c = makeChain([Role.orchestrator, Role.coder, Role.coder], [TMP, TMP, TMP]);
  assert.deepEqual(
    validateSpawn(
      { role: Role.coder, cwd: c[1]!.cwd, task: { task_id: c[1]!.task_id }, parent_session_id: c[0]!.session_id, parent_role_override: true, role_override_reason: "delegate" },
      { parent: c[0]!, proposed_session_id: c[1]!.session_id },
    ), { ok: true });
  assert.deepEqual(
    validateSpawn(
      { role: Role.coder, cwd: c[2]!.cwd, task: { task_id: c[2]!.task_id }, parent_session_id: c[1]!.session_id },
      { parent: c[1]!, proposed_session_id: c[2]!.session_id },
    ), { ok: true });
});

test("D2 — capability subset narrows monotonically across depth", () => {
  const root: SessionContext = { ...makeChain([Role.orchestrator], [TMP])[0]!, permissions: ["spawn_l1", "read_fs", "write_fs", "bash"] };
  const r1 = checkSpawnPermissions(root, { role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, parent_session_id: root.session_id });
  assert.equal(r1.ok, true);
  if (!r1.ok) return;
  const childCaps = [...r1.value].sort();
  assert.deepEqual(childCaps, ["bash", "read_fs", "write_fs"]);
  const child: SessionContext = { ...makeChildOf(root, { role: Role.coder }), permissions: childCaps as readonly ("bash" | "read_fs" | "write_fs")[] };
  const r2 = checkSpawnPermissions(child, { role: Role.coder, cwd: TMP, task: { task_id: "T-2" }, parent_session_id: child.session_id, requested_permissions: ["write_fs", "network"] });
  assert.equal(r2.ok, false);
  if (r2.ok === false) assert.ok(r2.code === "ERR_CAPABILITY_EXPANSION" || r2.code === "ERR_CAPABILITY_DENIED");
});

test("D3 — cwd mutation mid-chain does not mutate role", () => {
  const c = makeChain([Role.orchestrator, Role.coder, Role.coder], [TMP, `${TMP}/sub`, `${TMP}/elsewhere`]);
  assert.deepEqual(c.map((x) => x.role), [Role.orchestrator, Role.coder, Role.coder]);
  assert.deepEqual(
    validateSpawn(
      { role: Role.coder, cwd: c[2]!.cwd, task: { task_id: "T-3" }, parent_session_id: c[1]!.session_id },
      { parent: c[1]!, skip_cwd_exists: true },
    ), { ok: true });
});

test("D4 — A→B→A cycle via lookup_parent throws ERR_CYCLE_DETECTED", () => {
  const ar = (id: string, p: string): AgentRecord => ({ agent_id: id, parent_session_id: p, role: Role.coder, task_id: id, effective_prompt_digest: "x", created_at: "2026-05-12T00:00:00+00:00" });
  const map = new Map([["A", ar("A", "B")], ["B", ar("B", "A")]]);
  const r = validateSpawn(
    { role: Role.coder, cwd: TMP, task: { task_id: "T" }, parent_session_id: "B" },
    { proposed_session_id: "A", lookup_parent: (id) => map.get(id), skip_cwd_exists: true },
  );
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.code, "ERR_CYCLE_DETECTED");
});

test("D5 — spawn_chain monotonic + depth strictly increasing", () => {
  const c = makeChain([Role.orchestrator, Role.coder, Role.coder]);
  assert.deepEqual(c.map((x) => x.depth), [0, 1, 2]);
  assert.deepEqual([...c[1]!.spawn_chain], [c[0]!.session_id]);
  assert.deepEqual([...c[2]!.spawn_chain], [c[1]!.session_id, c[0]!.session_id]);
});
