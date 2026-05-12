// ADR-MF #8 — default role → capability registry (ADR §4.6.2).
// Compile-time SSOT for Phase 1. Runtime override under ~/.aigentry/permissions/
// is Q-OPEN-PM-2 (deferred to Phase 2 per SPEC §4.1).
//
// ADR §4.6.2 notes preserved inline:
//  - orchestrator.bash : ADR reads "(subset; per Rule 13 builder delegation)".
//    Operational discipline, not a capability bit — kept true here.
//  - architect.write_fs: ADR reads "(docs only)". Per-glob scoping is
//    Q-OPEN-2-FOLLOWUP (ADR §7.2) — out of scope for ADR-MF #8.
//  - reviewer: ADR §4.6.2 omits this row but #99 enum includes it. Mapping is
//    a conservative analyst-superset + mcp_deliberation for cross-LLM review
//    (Q-OPEN-PM-1, approved by orchestrator 2026-05-12).
import { type Capability, Role } from "./types.js";

type Registry = Readonly<Record<Role, readonly Capability[]>>;

function freeze(caps: readonly Capability[]): readonly Capability[] {
  return Object.freeze([...caps]);
}

export const ROLE_CAPABILITIES: Registry = Object.freeze({
  [Role.orchestrator]: freeze([
    "spawn_l1",
    "spawn_l2",
    "read_fs",
    "write_fs",
    "bash",
    "network",
    "mcp_deliberation",
    "task_dispatch",
  ]),
  [Role.architect]: freeze([
    "spawn_l1",
    "spawn_l2",
    "read_fs",
    "write_fs",
    "mcp_deliberation",
    "task_dispatch",
  ]),
  [Role.coder]: freeze(["spawn_l2", "read_fs", "write_fs", "bash"]),
  [Role.tester]: freeze(["spawn_l2", "read_fs", "bash"]),
  [Role.builder]: freeze(["read_fs", "bash", "network"]),
  [Role.analyst]: freeze(["spawn_l2", "read_fs"]),
  [Role.researcher]: freeze([
    "spawn_l2",
    "read_fs",
    "network",
    "mcp_deliberation",
  ]),
  [Role.reviewer]: freeze(["spawn_l2", "read_fs", "mcp_deliberation"]),
  [Role.logger]: freeze(["read_fs"]),
}) as Registry;
