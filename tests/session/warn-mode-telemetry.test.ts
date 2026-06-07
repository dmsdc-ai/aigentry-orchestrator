// ADR-MF #10 §3.6 — warn-mode telemetry composed with resolver + aggregator.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Role, type SessionContext, type SpawnRequest } from "../../src/session/types.js";
import { __resetModeTrackingForTests, enforceSpawn } from "../../src/session/validate-spawn.js";
import { resolveInstructions } from "../../src/session/resolve-instructions.js";
import { emit, type SpawnEvent } from "../../src/telemetry/spawn-events.js";
import { buildLayeredFs } from "../fixtures/adr-mf/memory-fs-builder.js";

const TMP = tmpdir();
const parent = (o: Partial<SessionContext> = {}): SessionContext => ({ session_id: "S-W", role: Role.coder, cwd: TMP, task_id: "T-W", effective_prompt_digest: "a".repeat(64), effective_prompt_path: "/abs/eff.md", layers: [], spawn_chain: [], depth: 0, created_at: "2026-05-12T00:00:00+00:00", ...o });
const req = (o: Partial<SpawnRequest> = {}): SpawnRequest => ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...o });
const clock = (iso: string) => () => new Date(iso);

test("W1 — degraded role flows through resolver to logger layer", async (t: TestContext) => {
  __resetModeTrackingForTests();
  t.mock.method(console, "warn", () => undefined);
  const events: SpawnEvent[] = [];
  const r = enforceSpawn(req({ cwd: "relative/path" }), { mode: "warn", emit: (e) => events.push(e), now: clock("2026-05-12T10:00:00.000Z") });
  if (!r.ok || !r.degraded) return assert.fail("expected degraded");
  assert.equal(r.effective_role, Role.logger);
  const ROOT = "/instr-W";
  const vfs = buildLayeredFs({ root: ROOT, layers: { roles: { [Role.logger]: "LOGGER ONLY\n", [Role.coder]: "CODER ONLY\n" } } });
  // #554 false positive: resolveInstructions reads role-instruction files from the
  // in-memory `vfs` (buildLayeredFs), not real disk; the path is a validated Role
  // enum (Role.logger) joined to the fixed ROOT. Snyk taints it via a Role-enum
  // value formatted into an ERR_ROLE_UNKNOWN message (permission-manager.ts:104) —
  // a closed enum, never external input. No attacker-controlled traversal reachable.
  // deepcode ignore javascript/PT/test: see #554 note above — test-fixture false positive
  const resolved = await resolveInstructions({ role: r.effective_role, cwd: "/nowhere", task_prompt: "T\n", task_source_path: "/d/t.md", instructions_root: ROOT }, vfs);
  assert.ok(resolved.effective_prompt.includes("LOGGER ONLY"));
  assert.equal(resolved.effective_prompt.includes("CODER ONLY"), false);
});

test("W2 — ctx_digest propagates from parent into rejected+degraded events", (t: TestContext) => {
  __resetModeTrackingForTests();
  t.mock.method(console, "warn", () => undefined);
  const p = parent({ effective_prompt_digest: "f".repeat(64) });
  const events: SpawnEvent[] = [];
  enforceSpawn(req({ cwd: "rel" }), { mode: "warn", parent: p, emit: (e) => events.push(e), now: clock("2026-05-12T10:00:00.000Z") });
  assert.deepEqual(events.map((e) => e.event), ["spawn_rejected", "spawn_degraded"]);
  for (const e of events) assert.equal(e.ctx_digest, "f".repeat(64));
});

test("W3 — warn → hard-fail emits mode_changed once with reason 'warn→hard-fail'", (t: TestContext) => {
  __resetModeTrackingForTests();
  t.mock.method(console, "warn", () => undefined);
  const events: SpawnEvent[] = [];
  const opts = { emit: (e: SpawnEvent) => events.push(e), now: clock("2026-05-12T10:00:00.000Z") };
  enforceSpawn(req(), { ...opts, mode: "warn" });
  enforceSpawn(req(), { ...opts, mode: "hard-fail" });
  const transitions = events.filter((e) => e.event === "mode_changed");
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.reason, "warn→hard-fail");
});

test("W4 — composed-stack events aggregate via spawn-telemetry-report.sh", (t: TestContext) => {
  __resetModeTrackingForTests();
  t.mock.method(console, "warn", () => undefined);
  const root = mkdtempSync(join(TMP, "mf10-W4-root-"));
  const outDir = mkdtempSync(join(TMP, "mf10-W4-out-"));
  try {
    const sink = (e: SpawnEvent) => emit(e, { root });
    const now = clock("2026-05-12T10:00:00.000Z");
    enforceSpawn(req(), { mode: "warn", emit: sink, now });
    enforceSpawn(req({ role: undefined as unknown as Role }), { mode: "warn", emit: sink, now });
    const out = join(outDir, "SUMMARY.md");
    const r = spawnSync("bash", ["bin/spawn-telemetry-report.sh", "--root", root, "--out", out, "--days", "1", "--asof", "2026-05-12"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(out, "utf8");
    assert.match(md, /spawn_accepted.*1/);
    assert.match(md, /spawn_rejected.*1/);
    assert.match(md, /spawn_degraded.*1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
