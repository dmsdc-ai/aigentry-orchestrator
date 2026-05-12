// ADR-MF #8 — Permission Manager (ADR §4.6).
// Role → capability lookup + subset-propagation enforcement.
// Consumed by validate-spawn (P1 gate) and the per-CLI boot adapter (#104).
//
// Naming: this module owns the ADR §4.3 G5 "capability subset" invariant.
// Within validate-spawn it is invoked as the "P1" gate (see SPEC §2) to avoid
// the G-label collision with #99's G1–G6 (which cover role / cwd / task / cycle).
import {
  type Capability,
  CAPABILITIES,
  isCapability,
  type Role,
  type SessionContext,
  type SpawnRequest,
} from "./types.js";
import { ROLE_CAPABILITIES } from "./role-capabilities.js";

export type CapabilitySet = ReadonlySet<Capability>;

export type PermissionErrorCode =
  | "ERR_ROLE_UNKNOWN"
  | "ERR_CAPABILITY_UNKNOWN"
  | "ERR_CAPABILITY_DENIED"
  | "ERR_CAPABILITY_EXPANSION"
  | "ERR_INVALID_REQUEST";

export type PermissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PermissionErrorCode; detail: string };

function fail<T>(
  code: PermissionErrorCode,
  detail: string,
): PermissionResult<T> {
  return { ok: false, code, detail };
}

// (A) role → capability lookup. Returns a fresh Set so callers can introspect
// without mutating the registry. ERR_ROLE_UNKNOWN is defensive — Role is an enum
// and #99 G1 catches unknown strings earlier, but the registry might drift.
export function roleToCapabilities(role: Role): CapabilitySet {
  const caps = ROLE_CAPABILITIES[role];
  if (!caps) {
    // Defensive: a Role enum value with no registry entry is a programmer error.
    // Surface it loudly rather than returning an empty set (which would silently deny).
    throw new Error(`ERR_ROLE_UNKNOWN: ${String(role)} has no capability mapping`);
  }
  return new Set<Capability>(caps);
}

function readRequested(
  requested: Iterable<Capability> | undefined,
): PermissionResult<readonly string[] | undefined> {
  if (requested === undefined) return { ok: true, value: undefined };
  if (typeof requested === "string" || requested === null) {
    return fail("ERR_INVALID_REQUEST", "requested_permissions must be iterable");
  }
  const arr: string[] = [];
  try {
    for (const x of requested as Iterable<unknown>) {
      if (typeof x !== "string") {
        return fail(
          "ERR_INVALID_REQUEST",
          `requested_permissions entry must be string, got ${typeof x}`,
        );
      }
      arr.push(x);
    }
  } catch {
    return fail("ERR_INVALID_REQUEST", "requested_permissions is not iterable");
  }
  return { ok: true, value: arr };
}

function validateAgainstRoleDefault(
  caps: readonly string[],
  role_default: CapabilitySet,
): PermissionResult<CapabilitySet> {
  const out = new Set<Capability>();
  for (const c of caps) {
    if (!isCapability(c)) {
      return fail("ERR_CAPABILITY_UNKNOWN", `unknown capability: ${c}`);
    }
    if (!role_default.has(c)) {
      return fail(
        "ERR_CAPABILITY_DENIED",
        `capability not in role default: ${c}`,
      );
    }
    out.add(c);
  }
  return { ok: true, value: out };
}

// (B) Subset propagation. Computes the child's effective capability set,
// rejecting explicit expansion attempts (silent-drop would mask buggy dispatches).
export function propagateSubset(
  parent_caps: CapabilitySet,
  request: { role: Role; requested?: Iterable<Capability> },
): PermissionResult<CapabilitySet> {
  let role_default: CapabilitySet;
  try {
    role_default = roleToCapabilities(request.role);
  } catch (e) {
    return fail("ERR_ROLE_UNKNOWN", (e as Error).message);
  }

  const read = readRequested(request.requested);
  if (!read.ok) return read;

  if (read.value === undefined) {
    // No explicit request — inherit role-default intersected with parent ceiling.
    const out = new Set<Capability>();
    for (const c of role_default) {
      if (parent_caps.has(c)) out.add(c);
    }
    return { ok: true, value: out };
  }

  // Explicit request — every entry must pass both role-default and parent ceiling.
  const checked = validateAgainstRoleDefault(read.value, role_default);
  if (!checked.ok) return checked;
  for (const c of checked.value) {
    if (!parent_caps.has(c)) {
      return fail(
        "ERR_CAPABILITY_EXPANSION",
        `child cannot acquire capability absent from parent: ${c}`,
      );
    }
  }
  return checked;
}

// (C) Eligibility decision for validate-spawn integration.
// Returns the child's effective CapabilitySet — boot-adapter (#104) consumes it.
// When parent is undefined (root spawn / Class A bootstrap), the role-default is
// the upper bound; explicit requests are still validated against it.
export function checkSpawnPermissions(
  parent: SessionContext | undefined,
  request: SpawnRequest,
): PermissionResult<CapabilitySet> {
  let role_default: CapabilitySet;
  try {
    role_default = roleToCapabilities(request.role);
  } catch (e) {
    return fail("ERR_ROLE_UNKNOWN", (e as Error).message);
  }

  const read = readRequested(request.requested_permissions);
  if (!read.ok) return read;

  // No parent: root spawn. Use role-default as ceiling.
  if (!parent || parent.permissions === undefined) {
    if (read.value === undefined) return { ok: true, value: role_default };
    return validateAgainstRoleDefault(read.value, role_default);
  }

  // Parent present with permissions: delegate to propagateSubset.
  const parent_caps: CapabilitySet = new Set<Capability>(parent.permissions);
  return propagateSubset(parent_caps, {
    role: request.role,
    ...(request.requested_permissions !== undefined
      ? { requested: request.requested_permissions }
      : {}),
  });
}

// Helper — canonical sorted array form (deterministic; for on-disk storage per
// ADR §4.8.2 sorted-key JSON). Not used by P1 itself; exported for #5 + #104.
export function toSortedArray(caps: CapabilitySet): readonly Capability[] {
  return Object.freeze([...caps].sort()) as readonly Capability[];
}

export { CAPABILITIES };
