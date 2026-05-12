// ADR-MF §4.3 — G1–G6 spawn validation tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type SessionContext, type SpawnRequest } from "../../src/session/types.js";
import { validateSpawn, type ValidateSpawnResult } from "../../src/session/validate-spawn.js";

const TMP = tmpdir();

const parent = (over: Partial<SessionContext> = {}): SessionContext => ({
  session_id: "S-parent", role: Role.orchestrator, cwd: TMP, task_id: "T-parent",
  effective_prompt_digest: "0".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00",
  ...over,
});

const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });

const expectFail = (res: ValidateSpawnResult, code: string): void => {
  assert.equal(res.ok, false);
  if (res.ok === false) assert.equal(res.code, code);
};

test("happy path: all 6 gates pass for a valid request", () => {
  const p = parent({ role: Role.architect });
  const r = req({ role: Role.architect, parent_session_id: "S-parent" });
  assert.deepEqual(
    validateSpawn(r, { parent: p, proposed_session_id: "S-child" }),
    { ok: true },
  );
});

test("G1 — role missing / unknown", () => {
  expectFail(validateSpawn(req({ role: undefined as unknown as Role })), "ERR_ROLE_MISSING");
  expectFail(validateSpawn(req({ role: "godmode" as unknown as Role })), "ERR_ROLE_UNKNOWN");
});

test("G2 — orchestrator clone rejected without override, allowed with it", () => {
  const p = parent({ role: Role.orchestrator });
  expectFail(
    validateSpawn(req({ role: Role.orchestrator }), { parent: p }),
    "ERR_ORCHESTRATOR_CLONE",
  );
  assert.deepEqual(
    validateSpawn(req({
      role: Role.orchestrator, parent_role_override: true,
      role_override_reason: "tree-search branch",
    }), { parent: p }),
    { ok: true },
  );
});

test("G3 — role change requires override + non-empty reason", () => {
  const p = parent({ role: Role.coder });
  expectFail(
    validateSpawn(req({ role: Role.architect }), { parent: p }),
    "ERR_ROLE_OVERRIDE_REQUIRED",
  );
  expectFail(
    validateSpawn(req({
      role: Role.architect, parent_role_override: true, role_override_reason: "   ",
    }), { parent: p }),
    "ERR_ROLE_OVERRIDE_REASON_MISSING",
  );
  assert.deepEqual(
    validateSpawn(req({
      role: Role.architect, parent_role_override: true,
      role_override_reason: "switching to design",
    }), { parent: p }),
    { ok: true },
  );
});

test("G4 — cwd must be absolute, must exist (unless skip_cwd_exists)", () => {
  expectFail(validateSpawn(req({ cwd: "relative/path" })), "ERR_CWD_NOT_ABSOLUTE");
  const ghost = "/nonexistent/path/aigentry/mf3-test";
  expectFail(validateSpawn(req({ cwd: ghost })), "ERR_CWD_NOT_EXISTS");
  assert.deepEqual(
    validateSpawn(req({ cwd: ghost }), { skip_cwd_exists: true }),
    { ok: true },
  );
});

test("G5 — task missing or task_id empty", () => {
  expectFail(
    validateSpawn(req({ task: null as unknown as { task_id: string } })),
    "ERR_TASK_MISSING",
  );
  expectFail(validateSpawn(req({ task: { task_id: "" } })), "ERR_TASK_MISSING");
});

test("G6 — 1-deep cycle (immediate self-reference)", () => {
  expectFail(
    validateSpawn(req({ parent_session_id: "S-self" }), {
      proposed_session_id: "S-self",
      lookup_parent: () => undefined,
    }),
    "ERR_CYCLE_DETECTED",
  );
});

const makeLookup = (chain: Record<string, string | undefined>) =>
  (id: string): SessionContext | undefined =>
    id in chain
      ? parent({ session_id: id, ...(chain[id] ? { parent_id: chain[id] as string } : {}) })
      : undefined;

test("G6 — 5-deep cycle via lookup_parent walk", () => {
  const lookup = makeLookup({ P1: "P2", P2: "P3", P3: "P4", P4: "P5", P5: "S-loop" });
  expectFail(
    validateSpawn(req({ parent_session_id: "P1" }),
      { proposed_session_id: "S-loop", lookup_parent: lookup }),
    "ERR_CYCLE_DETECTED",
  );
});

test("G6 — clean linear chain (proposed id absent) passes", () => {
  const lookup = makeLookup({ P1: "P2", P2: "P3" });
  assert.deepEqual(
    validateSpawn(req({ parent_session_id: "P1" }),
      { proposed_session_id: "S-fresh", lookup_parent: lookup }),
    { ok: true },
  );
});
