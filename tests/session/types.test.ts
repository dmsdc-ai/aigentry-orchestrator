// ADR-MF §4.2 — types contract tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AgentRecord,
  isRole,
  type LayerMeta,
  Role,
  ROLES,
  type SessionContext,
  type SpawnClass,
  type SpawnLayer,
  type SpawnRequest,
} from "../../src/session/types.js";

test("Role catalog matches §4.6.2 (9 roles, no extras)", () => {
  const expected = [
    "orchestrator", "architect", "coder", "tester", "builder",
    "analyst", "researcher", "reviewer", "logger",
  ];
  for (const r of expected) {
    assert.ok((ROLES as readonly string[]).includes(r), `missing: ${r}`);
  }
  assert.equal(ROLES.length, expected.length);
});

test("isRole accepts every enum value, rejects garbage", () => {
  for (const r of ROLES) assert.equal(isRole(r), true);
  for (const v of ["godmode", undefined, null, 42, ""]) {
    assert.equal(isRole(v), false);
  }
});

test("SpawnLayer / SpawnClass narrow at compile-time", () => {
  const l1: SpawnLayer = "L1";
  const l2: SpawnLayer = "L2";
  const cls: SpawnClass[] = ["A", "B", "C"];
  assert.equal(l1 + l2, "L1L2");
  assert.equal(cls.join(""), "ABC");
});

test("SessionContext + LayerMeta + AgentRecord + SpawnRequest are constructible", () => {
  const layer: LayerMeta = {
    layer: "common", source_path: "/abs/CLAUDE.md",
    content_sha256: "a".repeat(64), read_at: "2026-05-12T00:00:00.000000+00:00",
  };
  const ctx: SessionContext = {
    session_id: "S1", role: Role.orchestrator, cwd: "/repo", task_id: "T1",
    effective_prompt_digest: "b".repeat(64), effective_prompt_path: "/abs/eff.md",
    layers: [layer], spawn_chain: [], depth: 0,
    created_at: "2026-05-12T00:00:00.000000+00:00",
  };
  const rec: AgentRecord = {
    agent_id: "A1", parent_session_id: "S1", role: Role.coder, task_id: "T2",
    effective_prompt_digest: "c".repeat(64),
    created_at: "2026-05-12T00:00:00.000000+00:00",
  };
  const req: SpawnRequest = {
    role: Role.architect, cwd: "/repo", task: { task_id: "T1" },
    parent_session_id: "S1", parent_role_override: true,
    role_override_reason: "branch into architecture task",
  };
  assert.equal(ctx.layers[0]?.layer, "common");
  assert.equal(rec.parent_session_id, "S1");
  assert.equal(req.role_override_reason, "branch into architecture task");
});
