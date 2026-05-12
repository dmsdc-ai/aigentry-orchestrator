// ADR-MF #15 Class B — L2 native Agent prompt validator.
// Parent-side: orchestrator-side or hook code calls validateAgentPrompt()
// BEFORE invoking Claude's `Agent` tool. V1 confirms no out-of-band gate is
// possible for the native Agent surface — this is the architectural answer.
//
// Trust model: parent honesty (ADR §4.3 Class B caveat). A buggy/malicious
// parent that calls Agent directly bypasses this gate; escalation = supervisor
// kill (SPEC-C3 r1). A lint task is a separate follow-up.
//
// OQ-15-3 (approved 2026-05-12): AgentRecord stores DIGEST only, not prompt
// text — privacy + size. Full prompt may contain user content / secrets;
// sha256 enables reproducibility verification at zero retention cost. See
// ADR §4.2.1 lightweight-record framing + §4.8 canonicalization rule.
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  enforceSpawn,
  SpawnValidationError,
} from "../../session/validate-spawn.js";
import {
  atomicWrite,
  canonicalBytes,
  canonicalTimestamp,
  sha256Hex,
} from "../../session/persistence/index.js";
import type {
  AgentRecord,
  Capability,
  Role,
  SessionContext,
  SpawnRequest,
  TaskSpec,
} from "../../session/types.js";
import type {
  GateOptions,
  PermissionErrorCode,
  ValidateSpawnErrorCode,
} from "../common.js";

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
  | {
      ok: false;
      code: ValidateSpawnErrorCode | PermissionErrorCode | "ERR_INVALID_REQUEST";
      detail: string;
    };

const AGENT_ID_FORBIDDEN = /[\\/]|^\.|\.\.|\u0000/;

export function validateAgentPrompt(
  parent_ctx: SessionContext,
  ar: AgentToolRequest,
  opts: GateOptions = {},
): AgentValidationResult {
  if (typeof ar.agent_id !== "string" || ar.agent_id === "" || AGENT_ID_FORBIDDEN.test(ar.agent_id)) {
    return { ok: false, code: "ERR_INVALID_REQUEST", detail: "agent_id invalid" };
  }
  if (typeof ar.prompt !== "string" || ar.prompt === "") {
    return { ok: false, code: "ERR_INVALID_REQUEST", detail: "prompt empty" };
  }

  const req: SpawnRequest = {
    role: ar.role,
    cwd: parent_ctx.cwd,
    task: ar.task,
    parent_session_id: parent_ctx.session_id,
    ...(ar.parent_role_override !== undefined ? { parent_role_override: ar.parent_role_override } : {}),
    ...(ar.role_override_reason !== undefined ? { role_override_reason: ar.role_override_reason } : {}),
    ...(ar.requested_permissions !== undefined ? { requested_permissions: ar.requested_permissions } : {}),
  };
  const enforceArgs: Parameters<typeof enforceSpawn>[1] = {
    parent: parent_ctx,
    proposed_session_id: `${parent_ctx.session_id}:${ar.agent_id}`,
    skip_cwd_exists: true, // L2 inherits parent's cwd already validated at L1
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.emit !== undefined ? { emit: opts.emit } : {}),
  };

  try {
    const enforcement = enforceSpawn(req, enforceArgs);
    const created_at = canonicalTimestamp((opts.now ?? ((): Date => new Date()))());
    const digest = sha256Hex(canonicalBytes(ar.prompt));
    const record: AgentRecord = {
      agent_id: ar.agent_id,
      parent_session_id: parent_ctx.session_id,
      role: enforcement.effective_role,
      task_id: ar.task.task_id,
      effective_prompt_digest: digest,
      created_at,
    };
    return { ok: true, record, effective_role: enforcement.effective_role, degraded: enforcement.degraded === true };
  } catch (e) {
    if (e instanceof SpawnValidationError) {
      return { ok: false, code: e.code, detail: e.detail };
    }
    throw e;
  }
}

// G6 persistence helper. Writes ~/.aigentry/sessions/{parent}/agents/{id}.json
// using existing atomicWrite (#114). No edits to persist-context.ts (Rule 29).
export async function persistAgentRecord(
  parent_session_id: string,
  record: AgentRecord,
  sessionsRoot: string,
): Promise<{ path: string; sha256: string }> {
  const dir = path.join(sessionsRoot, parent_session_id, "agents");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${record.agent_id}.json`);
  const bytes = canonicalBytes(record);
  await atomicWrite(target, bytes, { sessionId: parent_session_id });
  return { path: target, sha256: sha256Hex(bytes) };
}
