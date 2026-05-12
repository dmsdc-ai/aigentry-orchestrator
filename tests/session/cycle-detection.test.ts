// ADR-MF #10 §3.7 — cycle detection robustness + perf bound.
// Design target: <100ms for a 100-deep chain; CI ceiling 250ms (OQ2 approved).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type AgentRecord, type SessionContext } from "../../src/session/types.js";
import { validateSpawn } from "../../src/session/validate-spawn.js";

const TMP = tmpdir();
const BUDGET_MS = 250;
const ar = (id: string, p: string): AgentRecord => ({ agent_id: id, parent_session_id: p, role: Role.coder, task_id: `t-${id}`, effective_prompt_digest: "x", created_at: "2026-05-12T00:00:00+00:00" });

test("C1 — A→B→A cycle via lookup_parent caught at proposed=A", () => {
  const map = new Map([["B", ar("B", "A")], ["A", ar("A", "B")]]);
  const r = validateSpawn(
    { role: Role.coder, cwd: TMP, task: { task_id: "T" }, parent_session_id: "B" },
    { proposed_session_id: "A", lookup_parent: (id) => map.get(id), skip_cwd_exists: true },
  );
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.code, "ERR_CYCLE_DETECTED");
});

test("C2 — duplicate ancestor in opts.parent.spawn_chain caught", () => {
  const parent: SessionContext = { session_id: "Y", role: Role.coder, cwd: TMP, task_id: "t", effective_prompt_digest: "x", effective_prompt_path: "/p", layers: [], spawn_chain: ["X", "X"], depth: 2, created_at: "2026-05-12T00:00:00+00:00" };
  const r = validateSpawn(
    { role: Role.coder, cwd: TMP, task: { task_id: "T" }, parent_session_id: "Y" },
    { parent, skip_cwd_exists: true },
  );
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.code, "ERR_CYCLE_DETECTED");
});

const buildDeep = (depth: number): ((id: string) => AgentRecord | undefined) => {
  const m = new Map<string, AgentRecord>();
  // Top of chain points to a non-existent sentinel so the walker exits cleanly.
  for (let i = 0; i < depth; i++) m.set(`N${i}`, ar(`N${i}`, i + 1 < depth ? `N${i + 1}` : "ROOT_NONEXISTENT"));
  return (id) => m.get(id);
};

test("C3 — 100-deep cycle (proposed = top ancestor) detected within 250ms", () => {
  const lookup = buildDeep(100);
  const t0 = process.hrtime.bigint();
  const r = validateSpawn(
    { role: Role.coder, cwd: TMP, task: { task_id: "T" }, parent_session_id: "N0" },
    { proposed_session_id: "N99", lookup_parent: lookup, skip_cwd_exists: true },
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.ok, false);
  if (r.ok === false) assert.equal(r.code, "ERR_CYCLE_DETECTED");
  assert.ok(ms < BUDGET_MS, `100-deep cycle detection took ${ms.toFixed(2)}ms (>${BUDGET_MS}ms)`);
});

test("C4 — 100-deep chain without cycle returns ok within 250ms", () => {
  const lookup = buildDeep(100);
  const t0 = process.hrtime.bigint();
  const r = validateSpawn(
    { role: Role.coder, cwd: TMP, task: { task_id: "T" }, parent_session_id: "N0" },
    { proposed_session_id: "FRESH-ID", lookup_parent: lookup, skip_cwd_exists: true },
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepEqual(r, { ok: true });
  assert.ok(ms < BUDGET_MS, `100-deep walk took ${ms.toFixed(2)}ms (>${BUDGET_MS}ms)`);
});
