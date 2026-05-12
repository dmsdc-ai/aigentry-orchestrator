// ADR-MF #8 — Permission Manager API tests (SPEC §7.2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  type Capability,
  Role,
  ROLES,
  type SessionContext,
  type SpawnRequest,
} from "../../src/session/types.js";
import {
  type CapabilitySet,
  checkSpawnPermissions,
  type PermissionResult,
  propagateSubset,
  roleToCapabilities,
  toSortedArray,
} from "../../src/session/permission-manager.js";
import { ROLE_CAPABILITIES } from "../../src/session/role-capabilities.js";

const TMP = tmpdir();
const caps = (...xs: Capability[]): CapabilitySet => new Set<Capability>(xs);

const parent = (over: Partial<SessionContext> = {}): SessionContext => ({
  session_id: "S-parent", role: Role.orchestrator, cwd: TMP, task_id: "T-parent",
  effective_prompt_digest: "0".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00", ...over,
});

const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });

const expectFail = <T>(res: PermissionResult<T>, code: string): void => {
  assert.equal(res.ok, false);
  if (res.ok === false) assert.equal(res.code, code);
};

test("roleToCapabilities returns expected set per role (all 9)", () => {
  for (const r of ROLES) {
    assert.deepEqual(
      [...roleToCapabilities(r)].sort(),
      [...ROLE_CAPABILITIES[r]].sort(), `mismatch for ${r}`);
  }
});

test("roleToCapabilities returns a Set independent of the registry", () => {
  (roleToCapabilities(Role.orchestrator) as Set<Capability>).delete("spawn_l1");
  assert.ok(roleToCapabilities(Role.orchestrator).has("spawn_l1"));
  assert.ok(ROLE_CAPABILITIES[Role.orchestrator].includes("spawn_l1"));
});

test("propagateSubset: requested omitted ⇒ parent ∩ role-default", () => {
  const r = propagateSubset(
    caps("read_fs", "write_fs", "bash", "network"), { role: Role.coder });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.value].sort(), ["bash", "read_fs", "write_fs"]);
});

test("propagateSubset: requested ⊆ parent ∩ role-default ⇒ equals requested", () => {
  const r = propagateSubset(
    caps("read_fs", "write_fs", "bash"),
    { role: Role.coder, requested: ["read_fs", "bash"] });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.value].sort(), ["bash", "read_fs"]);
});

test("propagateSubset: cap missing from parent ⇒ ERR_CAPABILITY_EXPANSION (cap in detail)", () => {
  const r = propagateSubset(caps("read_fs"),
    { role: Role.coder, requested: ["read_fs", "write_fs"] });
  expectFail(r, "ERR_CAPABILITY_EXPANSION");
  if (r.ok === false) assert.match(r.detail, /write_fs/);
});

test("propagateSubset: cap missing from role-default ⇒ ERR_CAPABILITY_DENIED", () => {
  // coder default has no spawn_l1.
  const r = propagateSubset(caps("spawn_l1", "spawn_l2", "read_fs"),
    { role: Role.coder, requested: ["spawn_l1"] });
  expectFail(r, "ERR_CAPABILITY_DENIED");
});

test("propagateSubset: unknown identifier ⇒ ERR_CAPABILITY_UNKNOWN", () => {
  const r = propagateSubset(caps("read_fs"),
    { role: Role.coder, requested: ["god_mode" as Capability] });
  expectFail(r, "ERR_CAPABILITY_UNKNOWN");
});

test("checkSpawnPermissions: both fields undefined ⇒ pass with role-default", () => {
  const r = checkSpawnPermissions(undefined, req());
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.value].sort(),
    ["bash", "read_fs", "spawn_l2", "write_fs"]);
});

test("checkSpawnPermissions: parent defined / request undefined ⇒ intersected caps", () => {
  const r = checkSpawnPermissions(
    parent({ permissions: ["read_fs", "write_fs"] }), req());
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.value].sort(), ["read_fs", "write_fs"]);
});

test("checkSpawnPermissions: both defined, in-bounds ⇒ requested", () => {
  const r = checkSpawnPermissions(
    parent({ permissions: ["read_fs", "write_fs", "bash"] }),
    req({ requested_permissions: ["read_fs", "bash"] }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([...r.value].sort(), ["bash", "read_fs"]);
});

test("checkSpawnPermissions: request asks expansion ⇒ ERR_CAPABILITY_EXPANSION", () => {
  expectFail(checkSpawnPermissions(
    parent({ permissions: ["read_fs"] }),
    req({ requested_permissions: ["read_fs", "write_fs"] })),
    "ERR_CAPABILITY_EXPANSION");
});

test("checkSpawnPermissions: parent undefined + unknown cap ⇒ ERR_CAPABILITY_UNKNOWN", () => {
  expectFail(checkSpawnPermissions(undefined,
    req({ requested_permissions: ["god_mode" as Capability] })),
    "ERR_CAPABILITY_UNKNOWN");
});

test("toSortedArray produces deterministic frozen output", () => {
  const arr = toSortedArray(caps("write_fs", "bash", "read_fs"));
  assert.deepEqual([...arr], ["bash", "read_fs", "write_fs"]);
  assert.equal(Object.isFrozen(arr), true);
});
