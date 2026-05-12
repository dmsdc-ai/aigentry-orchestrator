// ADR-MF #15 — Class B agent-tool-validator tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Role, type SessionContext } from "../../src/session/types.js";
import { __resetModeTrackingForTests } from "../../src/session/validate-spawn.js";
import {
  persistAgentRecord, validateAgentPrompt, type AgentToolRequest,
} from "../../src/gate/class-b/agent-tool-validator.js";

const TMP = tmpdir();
const parent = (over: Partial<SessionContext> = {}): SessionContext => ({
  session_id: "S-parent", role: Role.coder, cwd: TMP, task_id: "T-parent",
  effective_prompt_digest: "f".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00",
  permissions: ["read_fs", "write_fs", "spawn_l2"], ...over,
});
const ar = (over: Partial<AgentToolRequest> = {}): AgentToolRequest =>
  ({ agent_id: "A-1", role: Role.coder, task: { task_id: "T-A1" }, prompt: "do", ...over });

const opts = { mode: "warn" as const, emit: () => {} };
const hard = { mode: "hard-fail" as const, emit: () => {} };

test("accept: AgentRecord built with digest only (OQ-15-3)", () => {
  __resetModeTrackingForTests();
  const res = validateAgentPrompt(parent(), ar(), opts);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.record.agent_id, "A-1");
    assert.equal(res.record.effective_prompt_digest.length, 64);
    assert.ok(!("prompt" in res.record));
  }
});

test("role escalation + capability expansion both rejected", () => {
  __resetModeTrackingForTests();
  const r1 = validateAgentPrompt(parent({ role: Role.coder }), ar({ role: Role.orchestrator }), hard);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.code, "ERR_ROLE_OVERRIDE_REQUIRED");
  __resetModeTrackingForTests();
  const r2 = validateAgentPrompt(parent({ permissions: ["read_fs"] }), ar({ requested_permissions: ["network"] }), hard);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.code, /CAPABILITY_(DENIED|EXPANSION)/);
});

test("missing required fields → ERR_INVALID_REQUEST", () => {
  __resetModeTrackingForTests();
  assert.equal(validateAgentPrompt(parent(), ar({ prompt: "" }), opts).ok, false);
  __resetModeTrackingForTests();
  const r = validateAgentPrompt(parent(), ar({ agent_id: "../x" }), opts);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "ERR_INVALID_REQUEST");
});

test("persistAgentRecord writes canonical JSON under sessions/{parent}/agents/", async () => {
  __resetModeTrackingForTests();
  const root = mkdtempSync(join(tmpdir(), "mf15-b-"));
  try {
    const res = validateAgentPrompt(parent(), ar(), opts);
    assert.equal(res.ok, true);
    if (res.ok) {
      const { path: target, sha256 } = await persistAgentRecord("S-parent", res.record, root);
      assert.ok(existsSync(target));
      assert.equal(JSON.parse(readFileSync(target, "utf8")).agent_id, "A-1");
      assert.equal(sha256.length, 64);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
