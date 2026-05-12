# Gate architecture — Class A/B/C (ADR-MF #15)

- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.3 + §6 task #15
- SPEC: `docs/specs/2026-05-12-gate-integration.md`
- Code: `src/gate/`

## 1. Why three classes

The original r1 ADR framing of "a single gate" is not implementable. V1 proves Claude's native `Agent` tool has no out-of-band gate (no `tools=` bypass, no child-process boundary); MCP-launched participants run out-of-process under a server we may or may not control. The gate logic therefore splits into three classes — uniform G1–G6 + P1 invariants, surface-specific *mechanism*:

| Surface | Class | Mechanism | Code |
|---|---|---|---|
| `telepty inject` | A | CLI process spawn wrapper | `src/gate/class-a/telepty.ts` |
| `cmux session create` | A | cmux launch wrapper | `src/gate/class-a/cmux.ts` |
| direct CLI subprocess | A | `subprocess.spawn` wrapper | `src/gate/class-a/cli_direct.ts` |
| native `Agent` tool (L2) | B | parent-side prompt validator | `src/gate/class-b/agent-tool-validator.ts` |
| `mcp__deliberation__*` | C | MCP adapter (Phase 1 → Phase 2) | `src/gate/class-c/mcp-deliberation-adapter.ts` |

All three call `enforceSpawn()` (#101 / `c609e39`) — there is exactly one place the G1–G6 + P1 logic lives.

## 2. Class A — L1 process spawn wrapper

Pre-flight runs `enforceSpawn(req, opts)` before the child process is created. If a gate fails:

- `mode = 'hard-fail'` → `SpawnValidationError` is thrown; wrapper catches and returns `{ok:false, error:{code, detail}}`. Dispatcher is **not** invoked.
- `mode = 'warn'` (default during ADR §6 #11 compat window) → child role is degraded to `logger`; spawn proceeds with the degraded role visible in `AIGENTRY_EFFECTIVE_ROLE` env.

Each wrapper takes a `Dispatcher<TArg,TResult>` callback. The gate validates, the dispatcher acts — Rule 29 surgical separation. Real callers wrap `telepty inject` / `cmux session create` / `child_process.spawn`; tests drop in stubs.

**G6 ordering.** If the caller supplies a `ctx_persist: (ctx) => ...` callback, it is invoked **after** `enforceSpawn` accepts and **before** `dispatch`. A persist failure aborts the spawn (G6 invariant — ADR §4.3).

```ts
const res = await gatedTeleptyInject(spawnReq, teleptyArg, {
  parent: parentCtx,
  mode: process.env.AIGENTRY_SPAWN_VALIDATION_MODE,
  ctx_persist: (ctx) => persistContext(ctx, paths),
  dispatch: (a) => realTeleptyInject(a),
});
```

## 3. Class B — L2 native Agent prompt validator

`Agent` tool calls run **inside** the L1 session — there is no child process for an external gate to attach to. V1 (`RECURSIVE_FAIL_FINAL`) confirms no out-of-band bypass exists.

The validator is therefore **parent-side**: the orchestrator (or a wrapper around the Agent tool invocation) calls `validateAgentPrompt(parent_ctx, agent_req)` *before* invoking `Agent`. The would-be `AgentRecord` is computed, G1–G6 + P1 run against the coerced `SpawnRequest`, and on accept the record is returned to the caller.

**Trust model (ADR §4.3 Class B caveat).** Class B integrity rests on **parent honesty**. A malicious or buggy parent that calls `Agent` directly bypasses the validator at the harness level. The architectural answer is parent-side honesty + lint coverage (a separate follow-up). The escalation path is supervisor kill (SPEC-C3 r1).

**AgentRecord stores digest only (OQ-15-3, approved 2026-05-12).** Per ADR §4.2.1, L2 records are "lightweight". The record carries `sha256(canonicalBytes(prompt))` rather than the raw prompt text — privacy (user content / secrets may appear in prompts) + size + reproducibility verification at zero retention cost. The optional `persistAgentRecord()` helper writes the record to `~/.aigentry/sessions/{parent_session_id}/agents/{agent_id}.json` via the existing `atomicWrite()` (#114), under the parent's index lock.

```ts
const res = validateAgentPrompt(parentCtx, {
  agent_id: "A-7", role: Role.tester, task: { task_id: "T-99" },
  prompt: agentPrompt, requested_permissions: ["read_fs"],
});
if (!res.ok) return res; // surface to orchestrator self-correction (Rule 30)
await persistAgentRecord(parentCtx.session_id, res.record, sessionsRoot);
await callAgentTool(/* ... */);
```

## 4. Class C — MCP deliberation adapter

The deliberation MCP server (current `mcp__deliberation__*` family) launches participant CLIs out-of-process under a server we partially control. Two phases support the staged rollout:

- **Phase 1 (default).** Ungated transitional. The adapter logs `mcp_phase1_logged` (with ctx) or `mcp_phase1_ungated` (no ctx) and passes the tool call through. Never blocks.
- **Phase 2 (`MCP_REQUIRE_SESSION_CONTEXT=1`).** SessionContext-class metadata is required in the call payload. Missing `session_context` → `{ok:false, code:"ERR_MCP_SESSION_CONTEXT_MISSING"}`. Present → `enforceSpawn()` runs with `mode:"hard-fail"` overlay; rejection returns the underlying code (e.g., `ERR_CAPABILITY_EXPANSION`).

**Return, don't throw (OQ-15-2, approved 2026-05-12).** Phase 2 returns a structured `McpGateResult` rather than throwing. Rationale: MCP runs across a process boundary; a thrown exception would crash the MCP server and break clients. Returning lets the MCP tool handler emit a structured MCP error envelope and keeps the server alive for unrelated tools.

**Tool surface gated.** `deliberation_start`, `deliberation_respond`, `deliberation_browser_auto_turn`, `deliberation_cli_auto_turn`, `decision_start`, `decision_respond`. Other MCP tools pass through unmodified. The set is exported as `MCP_GATED_TOOLS` so the MCP server registry can introspect it without re-declaring.

**Schema extension.** Phase 2 callers pass `session_context: McpSessionContext` alongside the tool's own arguments. The adapter writes the field into `args_out` for the underlying MCP tool handler. This is an **adapter** integration — the upstream MCP server PR (server-side wiring) is a follow-up.

## 5. When to use which

```
spawn or call origin
├── new L1 CLI process from orchestrator host?
│   ├── via telepty inject ............ Class A — gatedTeleptyInject
│   ├── via cmux session create ....... Class A — gatedCmuxSpawn
│   └── via child_process.spawn ....... Class A — gatedCliDirectSpawn
├── native Agent tool call inside L1?
│   └── ............................... Class B — validateAgentPrompt
└── mcp__deliberation__* tool call?
    └── ............................... Class C — gateMcpToolCall
```

When in doubt: Class A if a real child process is being launched; Class B if invoking Claude's `Agent` tool from inside an L1 session; Class C if going through an MCP deliberation tool.

## 6. Telemetry + persistence pointers

- All three classes emit through the existing `src/telemetry/spawn-events.ts` (#118). No schema changes; Class C adds `reason` string values `mcp_phase{1,2}_{logged,ungated,accepted,rejected}` (suffixed with `:<tool>`) — documented in `spawn-events.ts` header comment.
- Class A persists via the caller-supplied `ctx_persist` callback (typically `persistContext()` from #5).
- Class B persists via `persistAgentRecord()` (writes `agents/{agent_id}.json` next to the L1 snapshot).
- Class C Phase 1 does not persist; Phase 2 persistence is the MCP caller's responsibility.

## 7. Boundaries (Rule 29)

This module imports from `src/session/*` and `src/telemetry/*`; it **modifies nothing** in those trees (except a 5-line documentation comment in `spawn-events.ts` recording the new Class C `reason` values per OQ-15-4). Hard-fail enforcement (ADR §6 #11) remains blocked on #9 warn-mode audit completion + #15 ship — this dispatch lands the integration, not the flip.
