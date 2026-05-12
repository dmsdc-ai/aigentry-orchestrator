// ADR-MF #10 §3.2 — orchestrator children get role+caps only; no prompt leak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type SessionContext } from "../../src/session/types.js";
import { validateSpawn } from "../../src/session/validate-spawn.js";
import { checkSpawnPermissions } from "../../src/session/permission-manager.js";
import { resolveInstructions } from "../../src/session/resolve-instructions.js";
import { buildLayeredFs } from "../fixtures/adr-mf/memory-fs-builder.js";
import { makeCtx } from "../fixtures/adr-mf/context-factory.js";

const TMP = tmpdir();
const ROOT = "/instr-N";
const MARK = "ORCH_DISPATCH_PROTOCOL_MARKER";

test("N1 — orchestrator → coder narrows caps (no spawn_l1, no network)", () => {
  const p: SessionContext = { ...makeCtx({ role: Role.orchestrator, cwd: TMP }), permissions: ["spawn_l1", "spawn_l2", "read_fs", "write_fs", "bash", "network", "mcp_deliberation", "task_dispatch"] };
  const r = checkSpawnPermissions(p, { role: Role.coder, cwd: TMP, task: { task_id: "T" }, parent_session_id: p.session_id });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.has("spawn_l1"), false);
  assert.equal(r.value.has("network"), false);
  for (const c of ["spawn_l2", "read_fs", "write_fs", "bash"] as const) assert.equal(r.value.has(c), true);
});

test("N2 — resolver yields coder layer only; orchestrator marker absent", async () => {
  const fs = buildLayeredFs({ root: ROOT, layers: { common: "COMMON\n", roles: { [Role.coder]: "CODER ROLE\n", [Role.orchestrator]: `ORCH ROLE\n${MARK}\n` } } });
  const r = await resolveInstructions({ role: Role.coder, cwd: "/nowhere", task_prompt: "T\n", task_source_path: "/d/t.md", instructions_root: ROOT }, fs);
  assert.ok(r.effective_prompt.includes("CODER ROLE"));
  assert.equal(r.effective_prompt.includes(MARK), false);
  assert.equal(r.effective_prompt.includes("ORCH ROLE"), false);
});

test("N3 — digest diverges when only role changes", async () => {
  const fs = buildLayeredFs({ root: ROOT, layers: { roles: { [Role.coder]: "CODER\n", [Role.orchestrator]: "ORCH\n" } } });
  const base = { cwd: "/nowhere", task_prompt: "T\n", task_source_path: "/d/t.md", instructions_root: ROOT };
  const a = await resolveInstructions({ ...base, role: Role.coder }, fs);
  const b = await resolveInstructions({ ...base, role: Role.orchestrator }, fs);
  assert.notEqual(a.effective_prompt_digest, b.effective_prompt_digest);
});

test("N4 — G2 implicit orchestrator clone rejected; explicit override accepted", () => {
  const p = makeCtx({ role: Role.orchestrator, cwd: TMP });
  const base = { role: Role.orchestrator, cwd: TMP, task: { task_id: "T-N4" }, parent_session_id: p.session_id };
  const rejected = validateSpawn(base, { parent: p });
  assert.equal(rejected.ok, false);
  if (rejected.ok === false) assert.equal(rejected.code, "ERR_ORCHESTRATOR_CLONE");
  assert.deepEqual(validateSpawn({ ...base, parent_role_override: true, role_override_reason: "branch" }, { parent: p }), { ok: true });
});
