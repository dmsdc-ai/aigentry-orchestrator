// ADR-MF #8 — registry invariants tests (SPEC §7.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, Role, ROLES } from "../../src/session/types.js";
import { ROLE_CAPABILITIES } from "../../src/session/role-capabilities.js";

test("registry covers every Role enum value (exhaustiveness)", () => {
  for (const r of ROLES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, r),
      `missing registry entry for role: ${r}`,
    );
  }
  // No extra keys outside the Role enum.
  for (const k of Object.keys(ROLE_CAPABILITIES)) {
    assert.ok((ROLES as readonly string[]).includes(k), `stray key: ${k}`);
  }
});

test("every entry's caps are a subset of CAPABILITIES (no typos)", () => {
  const allowed = new Set<string>(CAPABILITIES);
  for (const [role, caps] of Object.entries(ROLE_CAPABILITIES)) {
    for (const c of caps) {
      assert.ok(allowed.has(c), `${role} has unknown capability: ${c}`);
    }
  }
});

test("registry + each entry value are frozen (immutability)", () => {
  assert.equal(Object.isFrozen(ROLE_CAPABILITIES), true);
  for (const [role, caps] of Object.entries(ROLE_CAPABILITIES)) {
    assert.equal(Object.isFrozen(caps), true, `${role} caps not frozen`);
  }
});

test("spot-check known mappings (orchestrator superset, coder no spawn_l1, logger minimal)", () => {
  assert.ok(ROLE_CAPABILITIES[Role.orchestrator].includes("spawn_l1"));
  assert.ok(!ROLE_CAPABILITIES[Role.coder].includes("spawn_l1"));
  assert.deepEqual([...ROLE_CAPABILITIES[Role.logger]], ["read_fs"]);
  // reviewer was added per Q-OPEN-PM-1 approval — confirm shape.
  assert.deepEqual(
    [...ROLE_CAPABILITIES[Role.reviewer]].sort(),
    ["mcp_deliberation", "read_fs", "spawn_l2"],
  );
});
