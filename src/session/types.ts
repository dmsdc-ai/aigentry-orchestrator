// ADR-MF §4.2 — SessionContext + AgentRecord + SpawnRequest contract types.
// Strict TS, ESM, node stdlib only. No runtime deps (Article 17).

export enum Role {
  orchestrator = "orchestrator",
  architect = "architect",
  coder = "coder",
  tester = "tester",
  builder = "builder",
  analyst = "analyst",
  researcher = "researcher",
  reviewer = "reviewer",
  logger = "logger",
}

export const ROLES: readonly Role[] = Object.freeze(Object.values(Role)) as readonly Role[];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export type SpawnLayer = "L1" | "L2";

// Class A = L1 process gate, B = L2 Agent prompt validator, C = MCP launcher (ADR §4.3).
export type SpawnClass = "A" | "B" | "C";

export type LayerKind = "common" | "project" | "role" | "task";

export interface LayerMeta {
  layer: LayerKind;
  source_path: string;
  content_sha256: string;
  read_at: string;
}

// Capability identifiers — closed minimum set per ADR §4.6 / §4.6.1.
// Finer-grained capabilities (per-MCP allowlist, per-domain network, per-glob fs)
// = Q-OPEN-2-FOLLOWUP (ADR §7.2 + §8); out of scope for ADR-MF #8.
export const CAPABILITIES = [
  "spawn_l1",
  "spawn_l2",
  "read_fs",
  "write_fs",
  "bash",
  "network",
  "mcp_deliberation",
  "task_dispatch",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

// L1 SessionContext — immutable snapshot persisted at L1 spawn time (ADR §4.2).
export interface SessionContext {
  session_id: string;
  role: Role;
  cwd: string;
  task_id: string;
  parent_id?: string;
  parent_role?: Role;
  role_override_reason?: string;
  effective_prompt_digest: string;
  effective_prompt_path: string;
  layers: readonly LayerMeta[];
  spawn_chain: readonly string[];
  depth: number;
  created_at: string;
  // Optional — set by the Permission Manager (ADR §4.6 / ADR-MF #8). Sorted on disk.
  permissions?: readonly Capability[];
}

// L2 AgentRecord — lightweight child of a persisted L1 snapshot (ADR §4.2.1).
export interface AgentRecord {
  agent_id: string;
  parent_session_id: string;
  role: Role;
  task_id: string;
  effective_prompt_digest: string;
  created_at: string;
}

// Task spec — minimum payload for G5 task-presence gate.
export interface TaskSpec {
  task_id: string;
  [key: string]: unknown;
}

// SpawnRequest — pre-snapshot proposal evaluated by validate-spawn (ADR §4.3).
export interface SpawnRequest {
  role: Role;
  cwd: string;
  task: TaskSpec;
  parent_session_id?: string;
  parent_role_override?: boolean;
  role_override_reason?: string;
  // Optional — omit to inherit the role-default (ADR-MF #8 / SPEC §5.3).
  requested_permissions?: readonly Capability[];
}
