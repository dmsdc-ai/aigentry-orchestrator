// ADR-MF §4.3 — G1–G6 spawn validation gates + P1 capability gate (ADR-MF #8).
// Uniform invariants across enforcement classes A/B/C. Returns discriminated union.
//
// Gate-label mapping (SPEC §2):
//   G1 role / G2 orchestrator-clone / G3 role-override / G4 cwd / G5 task / G6 cycle
//     all owned by this file (#99 / ADR-MF #3, commit d06e9cb).
//   P1 capability-subset owned by permission-manager.ts (ADR-MF #8); invoked below
//     after G6, no-op when neither parent.permissions nor req.requested_permissions
//     is set (preserves #99 backwards-compat byte-for-byte).
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  type AgentRecord,
  isRole,
  Role,
  type SessionContext,
  type SpawnRequest,
} from "./types.js";
import {
  checkSpawnPermissions,
  type PermissionErrorCode,
} from "./permission-manager.js";

export type ValidateSpawnErrorCode =
  | "ERR_ROLE_MISSING"
  | "ERR_ROLE_UNKNOWN"
  | "ERR_ORCHESTRATOR_CLONE"
  | "ERR_ROLE_OVERRIDE_REQUIRED"
  | "ERR_ROLE_OVERRIDE_REASON_MISSING"
  | "ERR_CWD_NOT_ABSOLUTE"
  | "ERR_CWD_NOT_EXISTS"
  | "ERR_TASK_MISSING"
  | "ERR_CYCLE_DETECTED"
  | "ERR_CAPABILITY_UNKNOWN"
  | "ERR_CAPABILITY_DENIED"
  | "ERR_CAPABILITY_EXPANSION"
  | "ERR_INVALID_REQUEST";

export type ValidateSpawnResult =
  | { ok: true }
  | { ok: false; code: ValidateSpawnErrorCode; detail: string };

export interface ValidateSpawnOptions {
  proposed_session_id?: string;
  parent?: SessionContext;
  lookup_parent?: (
    session_id: string,
  ) => SessionContext | AgentRecord | undefined;
  skip_cwd_exists?: boolean;
}

function fail(
  code: ValidateSpawnErrorCode,
  detail: string,
): ValidateSpawnResult {
  return { ok: false, code, detail };
}

// G1 — role mandatory + valid enum.
function g1Role(req: SpawnRequest): ValidateSpawnResult | undefined {
  const raw = req.role as unknown;
  if (raw === undefined || raw === null || raw === "") {
    return fail("ERR_ROLE_MISSING", "spawn.role is required");
  }
  if (!isRole(raw)) {
    return fail("ERR_ROLE_UNKNOWN", `unknown role: ${String(raw)}`);
  }
  return undefined;
}

// G2 — orchestrator implicit-clone reject.
// Trigger: parent.role === orchestrator AND child.role === orchestrator AND no override.
function g2OrchestratorClone(
  req: SpawnRequest,
  parent: SessionContext | undefined,
): ValidateSpawnResult | undefined {
  if (!parent) return undefined;
  if (
    parent.role === Role.orchestrator &&
    req.role === Role.orchestrator &&
    req.parent_role_override !== true
  ) {
    return fail(
      "ERR_ORCHESTRATOR_CLONE",
      "implicit orchestrator clone forbidden: set parent_role_override=true + role_override_reason",
    );
  }
  return undefined;
}

// G3 — role change requires explicit override flag + non-empty reason.
function g3RoleOverride(
  req: SpawnRequest,
  parent: SessionContext | undefined,
): ValidateSpawnResult | undefined {
  if (!parent) return undefined;
  if (parent.role === req.role) return undefined;
  if (req.parent_role_override !== true) {
    return fail(
      "ERR_ROLE_OVERRIDE_REQUIRED",
      `role change ${parent.role}→${req.role} requires parent_role_override=true`,
    );
  }
  if (
    !req.role_override_reason ||
    req.role_override_reason.trim() === ""
  ) {
    return fail(
      "ERR_ROLE_OVERRIDE_REASON_MISSING",
      "role_override_reason must be non-empty when parent_role_override=true",
    );
  }
  return undefined;
}

// G4 — cwd absolute + directory exists (skippable for test mode).
function g4Cwd(
  req: SpawnRequest,
  opts: ValidateSpawnOptions,
): ValidateSpawnResult | undefined {
  if (!req.cwd || !isAbsolute(req.cwd)) {
    return fail(
      "ERR_CWD_NOT_ABSOLUTE",
      `cwd must be absolute POSIX path: ${String(req.cwd)}`,
    );
  }
  if (opts.skip_cwd_exists) return undefined;
  let isDir = false;
  try {
    isDir = existsSync(req.cwd) && statSync(req.cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return fail(
      "ERR_CWD_NOT_EXISTS",
      `cwd does not exist or is not a directory: ${req.cwd}`,
    );
  }
  return undefined;
}

// G5 — task spec presence: object with non-empty task_id.
function g5Task(req: SpawnRequest): ValidateSpawnResult | undefined {
  const task = req.task as unknown;
  if (task === undefined || task === null || typeof task !== "object") {
    return fail("ERR_TASK_MISSING", "spawn.task is required");
  }
  const id = (task as { task_id?: unknown }).task_id;
  if (typeof id !== "string" || id.trim() === "") {
    return fail("ERR_TASK_MISSING", "spawn.task.task_id is required");
  }
  return undefined;
}

// G6 — cycle detection along parent_session_id chain.
// Rejects if proposed_session_id appears in ancestors, or if the chain itself loops.
function g6Cycle(
  req: SpawnRequest,
  opts: ValidateSpawnOptions,
): ValidateSpawnResult | undefined {
  if (!req.parent_session_id) return undefined;
  const proposed = opts.proposed_session_id;

  // Short-circuit: if opts.parent matches and carries spawn_chain, use it.
  if (opts.parent && opts.parent.session_id === req.parent_session_id) {
    const ancestors = [opts.parent.session_id, ...opts.parent.spawn_chain];
    if (proposed && ancestors.includes(proposed)) {
      return fail(
        "ERR_CYCLE_DETECTED",
        `proposed session_id ${proposed} appears in ancestor chain`,
      );
    }
    const seen = new Set<string>();
    for (const a of ancestors) {
      if (seen.has(a)) {
        return fail("ERR_CYCLE_DETECTED", `ancestor ${a} appears twice`);
      }
      seen.add(a);
    }
    return undefined;
  }

  if (!opts.lookup_parent) return undefined;
  const visited = new Set<string>();
  let cursor: string | undefined = req.parent_session_id;
  while (cursor) {
    if (proposed && cursor === proposed) {
      return fail(
        "ERR_CYCLE_DETECTED",
        `proposed session_id ${proposed} reached at depth ${visited.size} via parent chain`,
      );
    }
    if (visited.has(cursor)) {
      return fail(
        "ERR_CYCLE_DETECTED",
        `parent chain loops at ${cursor}`,
      );
    }
    visited.add(cursor);
    const next = opts.lookup_parent(cursor);
    if (!next) break;
    cursor =
      "agent_id" in next ? next.parent_session_id : next.parent_id;
  }
  return undefined;
}

// P1 — capability subset (ADR §4.3 G5 invariant; ADR-MF #8).
// No-op when neither parent.permissions nor req.requested_permissions is set,
// which preserves every #99 test verbatim.
function p1Permissions(
  req: SpawnRequest,
  opts: ValidateSpawnOptions,
): ValidateSpawnResult | undefined {
  const has_parent_caps = opts.parent?.permissions !== undefined;
  const has_requested = req.requested_permissions !== undefined;
  if (!has_parent_caps && !has_requested) return undefined;

  const res = checkSpawnPermissions(opts.parent, req);
  if (res.ok) return undefined;
  // PermissionErrorCode is a strict subset of ValidateSpawnErrorCode by construction;
  // see ValidateSpawnErrorCode union above. The cast is provably safe.
  return { ok: false, code: res.code as PermissionErrorCode, detail: res.detail };
}

export function validateSpawn(
  req: SpawnRequest,
  opts: ValidateSpawnOptions = {},
): ValidateSpawnResult {
  return (
    g1Role(req) ??
    g2OrchestratorClone(req, opts.parent) ??
    g3RoleOverride(req, opts.parent) ??
    g4Cwd(req, opts) ??
    g5Task(req) ??
    g6Cycle(req, opts) ??
    p1Permissions(req, opts) ?? { ok: true }
  );
}
