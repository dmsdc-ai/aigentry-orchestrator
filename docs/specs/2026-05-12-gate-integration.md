# SPEC — ADR-MF #15 Gate integration (Class A/B/C — telepty + cmux + MCP + direct CLI)

- Status: DRAFT (E-coder-mf15-gate, 2026-05-12)
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.3 (three classes) + §6 task #15 (closes Q-OPEN-4)
- Depends on (landed):
  - commit `d06e9cb` — `src/session/types.ts` (`SessionContext`, `SpawnRequest`, `AgentRecord`, `SpawnClass`)
  - commit `3a13fb5` — `src/session/permission-manager.ts` (`checkSpawnPermissions`, `PermissionErrorCode`)
  - commit `c609e39` — `src/session/validate-spawn.ts` `enforceSpawn()` warn-mode + telemetry
  - commit `426f3a9` — `src/session/boot-adapter/` per-CLI boot adapter (consumed by Class A `cli_direct`)
  - `src/session/persist-context.ts` (#5) — `persistContext()` for G6 digest-precommit
- Scope: dispatch deliverables A/B/C/D/E/F.
- Constitution: Article 1 경량 (src ≤500 LOC total, tests ≤300 LOC, gate-architecture.md ≤150 lines, SPEC ≤300 lines), Article 17 무의존 (TS strict, node stdlib + already-landed `src/session/*` only — no new deps), Rule 29 외과적 변경 (only new files in `src/gate/`, `tests/gate/`, `docs/gate-architecture.md`; AGENTS.md gains ≤6 lines).

---

## 1. Why this module exists

ADR §4.3 splits the original r1 "single gate" into three enforcement classes because the spawn surface is heterogeneous:

- **Class A — L1 process spawn gate.** Concrete child process is created (`telepty inject`, `cmux session spawn`, direct subprocess). The wrapper sits **before** the process is launched and refuses the launch if G1–G6 + P1 fail.
- **Class B — L2 native Agent prompt validator.** Claude's `Agent` tool has no separate child process and no out-of-band gate (V1 `RECURSIVE_FAIL_FINAL`). The "gate" is **parent-side validation** before the Agent tool is invoked; the would-be `AgentRecord` is computed, validated, and persisted G6-style, then (and only then) the Agent call proceeds.
- **Class C — External launcher adapter** (deliberation MCP). The MCP server launches participant CLIs out-of-process under a server we partially control. Phase 1 = ungated transitional (log only); Phase 2 = behind `MCP_REQUIRE_SESSION_CONTEXT=1` requires SessionContext in the launch payload.

`enforceSpawn()` (commit `c609e39`) already returns the right shape (`{ok:true, degraded:bool}` or throws `SpawnValidationError` in hard-fail). #15 does **not** reimplement G1–G6 + P1 — it wires `enforceSpawn()` into the three surfaces and adds the surface-specific logging / persistence / MCP plumbing.

---

## 2. Naming + invariants

- Underlying validator: `enforceSpawn(req, opts)` from `src/session/validate-spawn.ts`. All three classes call it. No duplicate gate logic.
- Class B's "gate" is the same `enforceSpawn()` plus an `AgentRecord` constructor; G6 is the AgentRecord persist (`agents/{agent_id}.json` per ADR §4.8.1) wrapped behind a small `persistAgentRecord()` helper kept inside `src/gate/class-b/` (no edits to `src/session/persist-context.ts`).
- Error taxonomy: every Class A/B/C path surfaces `ValidateSpawnErrorCode | PermissionErrorCode` verbatim (Rule 29 — surface, don't translate). Class-C-only additions (`ERR_MCP_SESSION_CONTEXT_MISSING`, `ERR_MCP_TOOL_UNKNOWN`) are MCP-specific and **only** raised in Class C; Class A/B retain the existing taxonomy.
- Mode: every class respects `AIGENTRY_SPAWN_VALIDATION_MODE` (`hard-fail` | `warn` | `off`). Warn-mode degrades role to `logger` (commit `c609e39` `DEGRADED_FALLBACK_ROLE`); Class A still proceeds with the underlying spawn but with the degraded role visible in the dispatched env / argv.

---

## 3. Module API surface

### 3.1 `src/gate/common.ts` (shared types — ≤80 LOC)

```ts
import type { SpawnRequest, SessionContext, AgentRecord, SpawnClass } from "../session/types.js";
import type { EnforceSpawnResult } from "../session/validate-spawn.js";

// Dispatcher is the surface-specific "actually launch the child" callback,
// injected by the caller so tests can drop in a stub.
export interface Dispatcher<TArg, TResult> {
  (arg: TArg): Promise<TResult> | TResult;
}

export interface GateInvocation {
  request: SpawnRequest;
  parent?: SessionContext;
  proposed_session_id?: string;
  class: SpawnClass;       // "A" | "B" | "C"
  surface: string;         // "telepty" | "cmux" | "cli_direct" | "agent_tool" | "mcp_deliberation"
}

export type GateOutcome<TResult> =
  | { ok: true; enforcement: EnforceSpawnResult; result: TResult }
  | { ok: false; enforcement: EnforceSpawnResult; error: { code: string; detail: string } };
```

### 3.2 `src/gate/class-a/telepty.ts` (≤70 LOC)

```ts
export interface TeleptyDispatchArg {
  target_session_id: string;
  payload: string;
  argv: readonly string[];      // built by caller (e.g., `bin/dispatch.sh`)
  env: Readonly<Record<string,string>>;
}
export interface GatedTeleptyOptions {
  parent?: SessionContext;
  proposed_session_id?: string;
  mode?: ValidationMode;
  dispatch: Dispatcher<TeleptyDispatchArg, RunResult>;  // injected — real callers wrap `telepty inject`
  ctx_persist?: (ctx: SessionContext) => Promise<void>; // G6 if caller persists
}
export async function gatedTeleptyInject(
  req: SpawnRequest,
  arg: TeleptyDispatchArg,
  opts: GatedTeleptyOptions,
): Promise<GateOutcome<RunResult>>;
```

Behavior: call `enforceSpawn(req, {parent, proposed_session_id, mode})`; on throw (hard-fail) propagate; on `degraded:true` log via existing telemetry (`enforceSpawn` already emits `spawn_degraded`) and continue with `req.role = effective_role`; then call `dispatch(arg)`. No retry, no shell escape.

### 3.3 `src/gate/class-a/cmux.ts` (≤70 LOC)

Same shape as telepty wrapper. `CmuxDispatchArg = { workspace_name, kind: "session"|"workspace", argv, env }`. `dispatch` wraps real `cmux session create` / `cmux workspace open` invocations or test stubs.

### 3.4 `src/gate/class-a/cli_direct.ts` (≤70 LOC)

Direct subprocess invocations (e.g., a builder spawning a tester locally). Uses the existing boot-adapter when CLI ∈ {claude, codex, gemini}; falls back to a plain `argv/env/cwd` dispatch for non-CLI binaries.

```ts
export interface CliDirectArg {
  cli?: CliKind;                          // boot-adapter route if set
  argv: readonly string[];
  env: Readonly<Record<string,string>>;
  cwd: string;
}
export async function gatedCliDirectSpawn(
  req: SpawnRequest,
  arg: CliDirectArg,
  opts: GatedCliDirectOptions,
): Promise<GateOutcome<RunResult>>;
```

### 3.5 `src/gate/class-b/agent-tool-validator.ts` (≤110 LOC)

```ts
export interface AgentToolRequest {
  agent_id: string;
  role: Role;
  task: TaskSpec;
  prompt: string;
  requested_permissions?: readonly Capability[];
  parent_role_override?: boolean;
  role_override_reason?: string;
}
export type AgentValidationResult =
  | { ok: true; record: AgentRecord; effective_role: Role; degraded: boolean }
  | { ok: false; code: ValidateSpawnErrorCode | PermissionErrorCode; detail: string };

export function validateAgentPrompt(
  parent_ctx: SessionContext,
  agent_req: AgentToolRequest,
  opts?: { mode?: ValidationMode; now?: () => Date; emit?: SpawnEventEmitter },
): AgentValidationResult;

// Convenience for orchestrator-side wrapper hooks.
export async function validateAndPersistAgentRecord(
  parent_ctx: SessionContext,
  agent_req: AgentToolRequest,
  paths: PathConfig,
  opts?: { mode?: ValidationMode },
): Promise<AgentValidationResult>;
```

Behavior:

1. Coerce `AgentToolRequest` → `SpawnRequest` (role, cwd = parent.cwd inherited; task; `parent_session_id = parent_ctx.session_id`; `requested_permissions`).
2. Call `enforceSpawn()` with `parent: parent_ctx, mode`. Use **its** error code on rejection — no duplication.
3. On accept: build `AgentRecord` (per ADR §4.2.1: `agent_id`, `parent_session_id`, `role`, `task_id`, `effective_prompt_digest = sha256(canonicalBytes(prompt+context))`, `created_at`).
4. `validateAndPersistAgentRecord()` additionally persists `agents/{agent_id}.json` under `~/.aigentry/sessions/{parent.session_id}/agents/` using `atomicWrite` + the parent's index lock (G6).
5. Detection cases for tests (§ Required deliverable A):
   - **Role escalation**: parent.role ≠ orchestrator and `agent_req.role = orchestrator` with no override → `ERR_ROLE_OVERRIDE_REQUIRED` from G3, or `ERR_ORCHESTRATOR_CLONE` when parent = orchestrator + override missing.
   - **Capability expansion**: `requested_permissions ⊄ parent.permissions` → P1 raises `ERR_CAPABILITY_EXPANSION`.
   - **Missing required**: `role` / `task.task_id` / `prompt` empty → `ERR_ROLE_MISSING` / `ERR_TASK_MISSING` / (Class B specific) `ERR_INVALID_REQUEST` for empty prompt.

### 3.6 `src/gate/class-c/mcp-deliberation-adapter.ts` (≤110 LOC)

```ts
export interface McpToolCall {
  tool: string;          // e.g. "deliberation_start"
  args: Record<string, unknown>;
}
export interface McpSessionContext {
  session_id: string; role: Role; parent_id?: string;
  permissions?: readonly Capability[];
  effective_prompt_digest: string;
}
export type McpGateResult =
  | { ok: true; phase: 1|2; args_out: Record<string, unknown>; logged: true }
  | { ok: false; phase: 1|2; code: "ERR_MCP_SESSION_CONTEXT_MISSING" | ValidateSpawnErrorCode | PermissionErrorCode; detail: string };

export function gateMcpToolCall(
  call: McpToolCall,
  session_context: McpSessionContext | undefined,
  opts?: { env?: NodeJS.ProcessEnv; mode?: ValidationMode; emit?: SpawnEventEmitter },
): McpGateResult;
```

Behavior:

- **Phase determination.** `phase = (env.MCP_REQUIRE_SESSION_CONTEXT === "1") ? 2 : 1`.
- **Phase 1 (default).** If `session_context` is provided → run `enforceSpawn()` over a synthesized `SpawnRequest` (role from `session_context.role`, cwd = `/tmp` ok — Class C doesn't own cwd, `task = {task_id: call.tool}`) for telemetry only; never block on failure (downgrade rejection → `spawn_logged` event via existing emitter). If `session_context` missing → log `spawn_ungated` event and pass through.
- **Phase 2** (`MCP_REQUIRE_SESSION_CONTEXT=1`). Missing `session_context` → `{ok:false, code:"ERR_MCP_SESSION_CONTEXT_MISSING"}`. Present → `enforceSpawn()` with `mode = "hard-fail"` overlay so caller is forced to handle rejection.
- **Schema extension.** Optional `session_context` field added to MCP tool argument shape for the listed deliberation tools. The adapter is a callable wrapper — we do not edit the MCP server registry; integration point is documented in `docs/gate-architecture.md` §C.
- **MCP tool surface targeted** (Phase 1 logs; Phase 2 gated): `deliberation_start`, `deliberation_respond`, `deliberation_browser_auto_turn`, `deliberation_cli_auto_turn`, `decision_start`, `decision_respond` (others pass through unmodified).

### 3.7 `src/gate/index.ts` (≤20 LOC) — barrel re-exports.

---

## 4. Persistence (G6)

- **Class A.** Caller is responsible for persisting the SessionContext (existing `persistContext()` from #5); the wrapper accepts an optional `ctx_persist` callback that, if supplied, is invoked **after** `enforceSpawn` accepts and **before** `dispatch()`. If `ctx_persist` throws → spawn aborts (G6 invariant).
- **Class B.** `validateAndPersistAgentRecord` writes `~/.aigentry/sessions/{parent.session_id}/agents/{agent_id}.json` via `atomicWrite()` under the parent index lock. The file's `sha256(canonicalBytes(record))` is the AgentRecord digest.
- **Class C.** Phase 1 = no persistence (logged as ungated). Phase 2 = persistence is the caller's responsibility before the MCP call (the adapter only validates+returns; it does not write).

---

## 5. Telemetry

All three classes use the existing `src/telemetry/spawn-events.ts` emitter via `enforceSpawn()`'s default `emit` path. New event reasons (subset of existing schema, no new keys — privacy guard preserved):

- `spawn_logged` (Class C Phase 1, ungated MCP) — uses `event: "spawn_accepted"` shape with `reason: "mcp_phase1_logged"`.
- `spawn_ungated` (Class C Phase 1, no session_context) — `event: "spawn_accepted"`, `reason: "mcp_phase1_ungated"`.
- Class A/B reuse `spawn_accepted` / `spawn_rejected` / `spawn_degraded` as already defined.

No edits to `spawn-events.ts`.

---

## 6. Integration smoke tests (`tests/gate/*`, ≤300 LOC total)

| File | LOC | Coverage |
|---|---|---|
| `tests/gate/class-a-telepty.test.ts` | ~55 | violation → hard-fail throw; violation → warn-mode degraded; OK → dispatch invoked with right argv/env |
| `tests/gate/class-a-cmux.test.ts` | ~45 | mirrors telepty cases against cmux dispatcher stub |
| `tests/gate/class-a-cli-direct.test.ts` | ~55 | claude / codex / non-CLI dispatch; boot-adapter route honored; persist callback invoked before dispatch |
| `tests/gate/class-b-validator.test.ts` | ~75 | role escalation detected; capability expansion blocked; missing required fields; AgentRecord persisted on accept |
| `tests/gate/class-c-mcp.test.ts` | ~70 | Phase 1 logs and never blocks; Phase 2 missing ctx → `ERR_MCP_SESSION_CONTEXT_MISSING`; Phase 2 valid ctx → accepts; tool surface filter honored |

All tests use injected dispatchers / `tmpdir()` / `__resetModeTrackingForTests()` + the existing `mockSpawner` from the boot-adapter package for CLI direct cases. No real shell-outs; no network.

---

## 7. AGENTS.md surface (deliverable E — ≤6 lines)

Append the following block immediately below the Permission Manager footer line (around AGENTS.md L48):

```
> **Gate integration (ADR-MF #15, this dispatch)**: `src/gate/{class-a,class-b,class-c}/`.
> Class A (L1 process spawn) — `class-a/{telepty,cmux,cli_direct}.ts` wrap real spawn primitives.
> Class B (L2 Agent prompt validator) — `class-b/agent-tool-validator.ts`; parent-side, persists AgentRecord (ADR §4.2.1).
> Class C (MCP deliberation adapter) — `class-c/mcp-deliberation-adapter.ts`; Phase 1 ungated/log-only, Phase 2 behind `MCP_REQUIRE_SESSION_CONTEXT=1`.
> All three reuse `enforceSpawn()` (#101 / `c609e39`) → warn-mode + #103 PM error taxonomy + #104 boot-adapter.
> Architecture overview: `docs/gate-architecture.md`. Hard-fail flip blocked on ADR §6 #11.
```

Exactly 6 lines (5 content + 1 footer link as written).

---

## 8. `docs/gate-architecture.md` (deliverable F — ≤150 lines)

Sections:

1. **Why three classes** — restate ADR §4.3 framing in 15 lines (process-boundary / parent-side / external-launcher).
2. **Surface → class mapping table** — verbatim from ADR §4.3 with code-pointer column added (`src/gate/...`).
3. **Class A** — call site, dispatcher injection, persist hook, error propagation (≤25 lines + small code sample).
4. **Class B** — when to call from a Claude Agent tool wrapper (orchestrator-side hook), AgentRecord persistence path, trust model (parent honesty per ADR §4.3 Class B caveat) (≤25 lines).
5. **Class C** — Phase 1 vs Phase 2 transition, env flag, MCP tool surface, schema extension (≤25 lines).
6. **When to use which** — decision flowchart text (10–15 lines).
7. **Telemetry + persistence pointers** (5 lines).

---

## 9. LOC budget audit (hard cap reminder)

| File | Est. LOC |
|---|---|
| `src/gate/common.ts` | 60 |
| `src/gate/class-a/telepty.ts` | 70 |
| `src/gate/class-a/cmux.ts` | 65 |
| `src/gate/class-a/cli_direct.ts` | 70 |
| `src/gate/class-b/agent-tool-validator.ts` | 100 |
| `src/gate/class-c/mcp-deliberation-adapter.ts` | 105 |
| `src/gate/index.ts` | 20 |
| **src total** | **~490** (under 500 hard cap) |
| `tests/gate/*` total | **~300** (at cap) |
| `docs/gate-architecture.md` | **~140** (under 150) |
| `AGENTS.md` additions | **6** |

Margin for overrun: src has ~10 LOC; if any class spills, the first cut is the optional `validateAndPersistAgentRecord()` convenience in Class B (push to follow-up).

---

## 10. Out of scope (explicit)

- Edits to `src/session/validate-spawn.ts`, `src/session/permission-manager.ts`, `src/session/persist-context.ts`, `src/session/boot-adapter/*`, `src/telemetry/spawn-events.ts` (Rule 29 외과적; these are imported, not modified).
- Upstream MCP server PR (deliberation registry) — this SPEC ships the **adapter** callable; the server-side wiring is a follow-up.
- Hard-fail flip (ADR §6 #11) — still blocked on #9 warn-mode audit completion.
- Lint integration that detects bypass of Class B (ADR §4.3 "parent honesty" caveat) — separate task, not in #15 scope.
- Q-OPEN-2-FOLLOWUP fine-grained capabilities (per-MCP-server allowlists, per-domain network) — out per ADR §7.2.

---

## 11. Open questions (for orchestrator review before impl)

- **OQ-15-1.** Should `gatedTeleptyInject` accept the underlying `bin/dispatch.sh` argv as opaque (current spec) or build it from a structured `{ref, target, submit_retry}` record? Opaque keeps Rule 29 surgical; structured would let us validate per-arg. **Default proposed: opaque** — callers (orchestrator + `bin/dispatch.sh`) keep their existing arg-build logic; the gate only validates the spawn metadata, not the shell argv.
- **OQ-15-2.** Class C Phase 2 — should the MCP adapter throw or return `{ok:false}` on `ERR_MCP_SESSION_CONTEXT_MISSING`? Class A `enforceSpawn` throws under hard-fail; Class C is a callable wrapper not a process-boundary gate. **Default proposed: return `{ok:false}`** — the MCP server tool handler is the natural decision site, and returning lets the handler emit a structured MCP error rather than crashing the server.
- **OQ-15-3.** Should `agents/{agent_id}.json` schema include the full `effective_prompt` text or only the digest? ADR §4.2.1 is silent; #5 stores the prompt for L1. **Default proposed: digest only** — L2 records are "lightweight" per §4.2.1; prompt text retention is L1's job. Adjust if reviewer prefers full text.
- **OQ-15-4.** Telemetry reason strings `mcp_phase1_logged` / `mcp_phase1_ungated` — acceptable to add as `reason` values (no new keys; schema guard in `spawn-events.ts` checks keys not value contents), or should we introduce a new event kind? **Default proposed: reuse `spawn_accepted` with new `reason` string** — no schema break, no privacy-guard change.
