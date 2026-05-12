// ADR-MF #15 — Class C deliberation MCP adapter tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Role } from "../../src/session/types.js";
import { __resetModeTrackingForTests } from "../../src/session/validate-spawn.js";
import type { SpawnEvent } from "../../src/telemetry/spawn-events.js";
import {
  gateMcpToolCall, MCP_GATED_TOOLS, type McpSessionContext,
} from "../../src/gate/class-c/mcp-deliberation-adapter.js";

const ctx = (over: Partial<McpSessionContext> = {}): McpSessionContext => ({
  session_id: "S-mcp", role: Role.orchestrator,
  effective_prompt_digest: "c".repeat(64), permissions: ["mcp_deliberation"], ...over,
});

test("MCP_GATED_TOOLS includes 6 documented tools", () => {
  for (const t of [
    "deliberation_start", "deliberation_respond",
    "deliberation_browser_auto_turn", "deliberation_cli_auto_turn",
    "decision_start", "decision_respond",
  ]) assert.ok(MCP_GATED_TOOLS.has(t), `missing ${t}`);
});

test("Phase 1 with ctx → accepts + emits mcp_phase1_logged", () => {
  __resetModeTrackingForTests();
  const events: SpawnEvent[] = [];
  const res = gateMcpToolCall(
    { tool: "deliberation_start", args: {} }, ctx(),
    { env: {}, emit: (e) => events.push(e) },
  );
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.phase, 1);
    assert.ok((res.args_out as { session_context?: unknown }).session_context);
  }
  assert.ok(events.some((e) => e.reason.startsWith("mcp_phase1_logged")));
});

test("Phase 1 ungated + non-gated tool pass-through", () => {
  __resetModeTrackingForTests();
  const events: SpawnEvent[] = [];
  const ungated = gateMcpToolCall(
    { tool: "deliberation_respond", args: {} }, undefined,
    { env: {}, emit: (e) => events.push(e) },
  );
  assert.equal(ungated.ok, true);
  assert.ok(events.some((e) => e.reason.startsWith("mcp_phase1_ungated")));
  const passthru = gateMcpToolCall(
    { tool: "other_tool", args: { x: 1 } }, undefined,
    { env: {}, emit: () => assert.fail("should not log") },
  );
  assert.equal(passthru.ok, true);
  if (passthru.ok) assert.deepEqual(passthru.args_out, { x: 1 });
});

test("Phase 2: missing ctx rejects (OQ-15-2 return-not-throw), valid ctx accepts", () => {
  __resetModeTrackingForTests();
  const env = { MCP_REQUIRE_SESSION_CONTEXT: "1" };
  const e1: SpawnEvent[] = [];
  const r1 = gateMcpToolCall({ tool: "deliberation_start", args: {} }, undefined, { env, emit: (e) => e1.push(e) });
  assert.equal(r1.ok, false);
  if (!r1.ok) { assert.equal(r1.phase, 2); assert.equal(r1.code, "ERR_MCP_SESSION_CONTEXT_MISSING"); }
  assert.ok(e1.some((e) => e.reason.startsWith("mcp_phase2_rejected")));
  __resetModeTrackingForTests();
  const e2: SpawnEvent[] = [];
  const r2 = gateMcpToolCall({ tool: "deliberation_start", args: {} }, ctx(), { env, emit: (e) => e2.push(e) });
  assert.equal(r2.ok, true);
  assert.ok(e2.some((e) => e.reason.startsWith("mcp_phase2_accepted")));
});
