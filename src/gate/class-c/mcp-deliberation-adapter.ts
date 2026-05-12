// ADR-MF #15 Class C — deliberation MCP adapter.
// Phase 1 (default): ungated transitional — log, never block.
// Phase 2 (MCP_REQUIRE_SESSION_CONTEXT=1): SessionContext-class payload required.
// OQ-15-2: Phase 2 RETURNS structured result (does NOT throw) — MCP boundary
// crash would break server/clients; caller decides policy.
// OQ-15-4: new `reason` strings (`mcp_phase{1,2}_{logged,ungated,accepted,rejected}`)
// reuse existing event_kind set — no schema-guard impact in #118.
import { enforceSpawn, SpawnValidationError } from "../../session/validate-spawn.js";
import { emit as defaultEmit, type SpawnEvent } from "../../telemetry/spawn-events.js";
import type {
  Capability,
  PermissionErrorCode,
  Role,
  SpawnEventEmitter,
  SpawnRequest,
  ValidateSpawnErrorCode,
  ValidationMode,
} from "../common.js";

export interface McpToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface McpSessionContext {
  session_id: string;
  role: Role;
  parent_id?: string;
  permissions?: readonly Capability[];
  effective_prompt_digest: string;
  cwd?: string;
}

export type McpGateErrorCode =
  | "ERR_MCP_SESSION_CONTEXT_MISSING"
  | "ERR_MCP_TOOL_UNKNOWN"
  | ValidateSpawnErrorCode
  | PermissionErrorCode;

export type McpGateResult =
  | { ok: true; phase: 1 | 2; args_out: Record<string, unknown>; logged: true }
  | { ok: false; phase: 1 | 2; code: McpGateErrorCode; detail: string };

export const MCP_GATED_TOOLS: ReadonlySet<string> = new Set<string>([
  "deliberation_start",
  "deliberation_respond",
  "deliberation_browser_auto_turn",
  "deliberation_cli_auto_turn",
  "decision_start",
  "decision_respond",
]);

export interface McpGateOptions {
  env?: NodeJS.ProcessEnv;
  mode?: ValidationMode;
  emit?: SpawnEventEmitter;
  now?: () => Date;
}

export function gateMcpToolCall(
  call: McpToolCall,
  ctx: McpSessionContext | undefined,
  opts: McpGateOptions = {},
): McpGateResult {
  const phase: 1 | 2 = (opts.env ?? process.env)["MCP_REQUIRE_SESSION_CONTEXT"] === "1" ? 2 : 1;
  const mode = opts.mode ?? "warn";
  const now = opts.now ?? ((): Date => new Date());
  const emit = opts.emit ?? ((e: SpawnEvent): void => defaultEmit(e));

  if (!MCP_GATED_TOOLS.has(call.tool)) {
    return { ok: true, phase, args_out: call.args, logged: true };
  }

  const log = (
    event: SpawnEvent["event"],
    reason: string,
    violations: SpawnEvent["violations"],
  ): void => {
    emit({
      ts: now().toISOString(), event, mode,
      session_id: ctx?.session_id ?? null, parent_id: ctx?.parent_id ?? null,
      reason: `${reason}:${call.tool}`, violations,
      ctx_digest: ctx?.effective_prompt_digest ?? null,
    });
  };
  const synth = (c: McpSessionContext): SpawnRequest => ({
    role: c.role, cwd: c.cwd ?? "/tmp", task: { task_id: call.tool },
  });

  if (phase === 1) {
    if (!ctx) {
      log("spawn_accepted", "mcp_phase1_ungated", []);
      return { ok: true, phase: 1, args_out: call.args, logged: true };
    }
    try {
      enforceSpawn(synth(ctx), { skip_cwd_exists: true, mode: "warn", emit, now });
    } catch (e) {
      if (!(e instanceof SpawnValidationError)) throw e;
    }
    log("spawn_accepted", "mcp_phase1_logged", []);
    return { ok: true, phase: 1, args_out: { ...call.args, session_context: ctx }, logged: true };
  }

  // Phase 2.
  if (!ctx) {
    const detail = `MCP tool ${call.tool} requires session_context (MCP_REQUIRE_SESSION_CONTEXT=1)`;
    log("spawn_rejected", "mcp_phase2_rejected", [
      { code: "ERR_MCP_SESSION_CONTEXT_MISSING", detail },
    ]);
    return { ok: false, phase: 2, code: "ERR_MCP_SESSION_CONTEXT_MISSING", detail };
  }
  try {
    enforceSpawn(synth(ctx), { skip_cwd_exists: true, mode: "hard-fail", emit, now });
  } catch (e) {
    if (e instanceof SpawnValidationError) {
      log("spawn_rejected", "mcp_phase2_rejected", [{ code: e.code, detail: e.detail }]);
      return { ok: false, phase: 2, code: e.code, detail: e.detail };
    }
    throw e;
  }
  log("spawn_accepted", "mcp_phase2_accepted", []);
  return { ok: true, phase: 2, args_out: { ...call.args, session_context: ctx }, logged: true };
}
