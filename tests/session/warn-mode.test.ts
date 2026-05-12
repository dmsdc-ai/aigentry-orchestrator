// ADR-MF #9 — Warn-mode enforceSpawn + telemetry tests (SPEC §4).
// 12 scenarios; injects emit/now/root so nothing touches real ~/.aigentry.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Role, type SessionContext, type SpawnRequest } from "../../src/session/types.js";
import {
  __resetModeTrackingForTests, DEFAULT_VALIDATION_MODE, DEGRADED_FALLBACK_ROLE,
  enforceSpawn, readValidationMode, SpawnValidationError,
} from "../../src/session/validate-spawn.js";
import { dailyFilePath, emit, readEventsForDay, type SpawnEvent } from "../../src/telemetry/spawn-events.js";

const TMP = tmpdir();

const parent = (over: Partial<SessionContext> = {}): SessionContext => ({
  session_id: "S-parent", role: Role.orchestrator, cwd: TMP, task_id: "T-parent",
  effective_prompt_digest: "a".repeat(64), effective_prompt_path: "/abs/eff.md",
  layers: [], spawn_chain: [], depth: 0,
  created_at: "2026-05-12T00:00:00.000000+00:00", ...over,
});

const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });

const fixedClock = (iso: string) => () => new Date(iso);

const collect = (): { events: SpawnEvent[]; sink: (e: SpawnEvent) => void } => {
  const events: SpawnEvent[] = [];
  return { events, sink: (e) => events.push(e) };
};

const reset = (): void => __resetModeTrackingForTests();

test("default mode constant matches ADR §6 #9 compat window", () => {
  assert.equal(DEFAULT_VALIDATION_MODE, "warn");
  assert.equal(DEGRADED_FALLBACK_ROLE, Role.logger);
  assert.equal(readValidationMode({}), "warn");
  assert.equal(readValidationMode({ AIGENTRY_SPAWN_VALIDATION_MODE: "off" }), "off");
  assert.equal(readValidationMode({ AIGENTRY_SPAWN_VALIDATION_MODE: "garbage" }), "warn");
});

test("warn-mode (1) — G1 violation: telemetry + degrade to logger, spawn proceeds", (t: TestContext) => {
  reset();
  const { events, sink } = collect();
  const warnSpy = t.mock.method(console, "warn", () => undefined);
  const r = enforceSpawn(req({ role: undefined as unknown as Role }), {
    mode: "warn", emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z"),
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, "warn");
  assert.equal(r.effective_role, Role.logger);
  if (r.ok && r.degraded) assert.equal(r.validation.code, "ERR_ROLE_MISSING");
  assert.deepEqual(events.map((e) => e.event), ["spawn_rejected", "spawn_degraded"]);
  assert.equal(warnSpy.mock.callCount(), 1);
});

test("warn-mode (2) — G4 cwd-not-absolute: degrades + warns", (t: TestContext) => {
  reset();
  const { events, sink } = collect();
  t.mock.method(console, "warn", () => undefined);
  const r = enforceSpawn(req({ cwd: "relative/path" }), {
    mode: "warn", emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z"),
  });
  assert.equal(r.ok, true);
  if (r.ok && r.degraded) {
    assert.equal(r.effective_role, Role.logger);
    assert.equal(r.validation.code, "ERR_CWD_NOT_ABSOLUTE");
  } else assert.fail("expected degraded result");
  assert.equal(events[0]?.reason, "ERR_CWD_NOT_ABSOLUTE");
});

test("warn-mode (3) — P1 capability denied: degrades", (t: TestContext) => {
  reset();
  const { events, sink } = collect();
  t.mock.method(console, "warn", () => undefined);
  // Parent role=coder (no role change so G3 doesn't fire), permissions limited to read_fs.
  const p = parent({ role: Role.coder, permissions: ["read_fs"] });
  const r = enforceSpawn(
    req({ requested_permissions: ["network"], parent_session_id: "S-parent" }),
    { mode: "warn", parent: p, emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z") },
  );
  assert.equal(r.ok, true);
  if (r.ok && r.degraded) {
    assert.ok(r.validation.code === "ERR_CAPABILITY_DENIED" || r.validation.code === "ERR_CAPABILITY_EXPANSION");
  } else assert.fail("expected degraded result");
  assert.equal(events.find((e) => e.event === "spawn_rejected")?.violations.length, 1);
});

test("hard-fail mode (4) — violation throws SpawnValidationError; no console.warn", (t: TestContext) => {
  reset();
  const { events, sink } = collect();
  const warnSpy = t.mock.method(console, "warn", () => undefined);
  assert.throws(
    () => enforceSpawn(req({ role: undefined as unknown as Role }), {
      mode: "hard-fail", emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z"),
    }),
    (err: unknown) => err instanceof SpawnValidationError && err.code === "ERR_ROLE_MISSING",
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "spawn_rejected");
  assert.equal(warnSpy.mock.callCount(), 0);
});

test("hard-fail mode (5) — happy path: spawn_accepted, returns ok+not-degraded", () => {
  reset();
  const { events, sink } = collect();
  const r = enforceSpawn(req(), {
    mode: "hard-fail", emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z"),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.degraded, false);
    assert.equal(r.effective_role, Role.coder);
  }
  assert.deepEqual(events.map((e) => e.event), ["spawn_accepted"]);
});

test("warn-mode (6) — happy path: spawn_accepted only, no degraded event", () => {
  reset();
  const { events, sink } = collect();
  const r = enforceSpawn(req(), {
    mode: "warn", emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z"),
  });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.degraded, false);
  assert.deepEqual(events.map((e) => e.event), ["spawn_accepted"]);
});

test("off mode (7) — would-violate input: zero spawn_* events, requested role kept", () => {
  reset();
  const { events, sink } = collect();
  const r = enforceSpawn(req({ role: undefined as unknown as Role }), {
    mode: "off", emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z"),
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.mode, "off");
    assert.equal(r.degraded, false);
  }
  assert.equal(events.length, 0); // first observation, no mode_changed either
});

test("mode transition (8) — warn → off → warn emits two mode_changed events", () => {
  reset();
  const { events, sink } = collect();
  const opts = { emit: sink, now: fixedClock("2026-05-12T10:00:00.000Z") };
  enforceSpawn(req(), { ...opts, mode: "warn" });   // latches warn (no emit)
  enforceSpawn(req(), { ...opts, mode: "off" });    // warn→off
  enforceSpawn(req(), { ...opts, mode: "warn" });   // off→warn
  const transitions = events.filter((e) => e.event === "mode_changed");
  assert.equal(transitions.length, 2);
  assert.equal(transitions[0]?.reason, "warn→off");
  assert.equal(transitions[1]?.reason, "off→warn");
});

test("telemetry rotation (9) — cross-day boundary writes to separate files", () => {
  const root = mkdtempSync(join(TMP, "mf9-rot-"));
  try {
    emit({
      ts: "2026-05-12T23:59:59.000Z", event: "spawn_accepted", mode: "warn",
      session_id: "A", parent_id: null, reason: "ok", violations: [], ctx_digest: null,
    }, { root });
    emit({
      ts: "2026-05-13T00:00:01.000Z", event: "spawn_accepted", mode: "warn",
      session_id: "B", parent_id: null, reason: "ok", violations: [], ctx_digest: null,
    }, { root });
    const d1 = dailyFilePath(new Date("2026-05-12T12:00:00Z"), { root });
    const d2 = dailyFilePath(new Date("2026-05-13T12:00:00Z"), { root });
    assert.ok(existsSync(d1) && existsSync(d2));
    assert.equal(readEventsForDay(new Date("2026-05-12T12:00:00Z"), { root })[0]?.session_id, "A");
    assert.equal(readEventsForDay(new Date("2026-05-13T12:00:00Z"), { root })[0]?.session_id, "B");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NDJSON round-trip + schema (10) — five mixed events read back identical", () => {
  const root = mkdtempSync(join(TMP, "mf9-rt-"));
  try {
    const inputs: SpawnEvent[] = [
      { ts: "2026-05-12T10:00:00.000Z", event: "spawn_accepted", mode: "warn", session_id: "S1", parent_id: null, reason: "ok", violations: [], ctx_digest: null },
      { ts: "2026-05-12T10:01:00.000Z", event: "spawn_rejected", mode: "warn", session_id: "S2", parent_id: "P", reason: "ERR_ROLE_MISSING", violations: [{ code: "ERR_ROLE_MISSING", detail: "missing" }], ctx_digest: "deadbeef" },
      { ts: "2026-05-12T10:02:00.000Z", event: "spawn_degraded", mode: "warn", session_id: "S2", parent_id: "P", reason: "ERR_ROLE_MISSING", violations: [{ code: "ERR_ROLE_MISSING", detail: "missing" }], ctx_digest: "deadbeef" },
      { ts: "2026-05-12T10:03:00.000Z", event: "mode_changed", mode: "off", session_id: null, parent_id: null, reason: "warn→off", violations: [], ctx_digest: null },
      { ts: "2026-05-12T10:04:00.000Z", event: "spawn_accepted", mode: "hard-fail", session_id: "S3", parent_id: null, reason: "ok", violations: [], ctx_digest: null },
    ];
    for (const e of inputs) emit(e, { root });
    const got = readEventsForDay(new Date("2026-05-12T12:00:00Z"), { root });
    assert.deepEqual(got, inputs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privacy guard (11) — emit throws TypeError on forbidden key; file not written", () => {
  const root = mkdtempSync(join(TMP, "mf9-priv-"));
  try {
    const bad = {
      ts: "2026-05-12T10:00:00.000Z", event: "spawn_rejected", mode: "warn",
      session_id: null, parent_id: null, reason: "leak", violations: [], ctx_digest: null,
      task_body: "user secret",
    } as unknown as SpawnEvent;
    assert.throws(() => emit(bad, { root }), TypeError);
    const path = dailyFilePath(new Date("2026-05-12T12:00:00Z"), { root });
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.sh aggregation (12) — counts events by kind, surfaces top reasons", () => {
  const root = mkdtempSync(join(TMP, "mf9-rep-"));
  const outDir = mkdtempSync(join(TMP, "mf9-out-"));
  try {
    const seeds: SpawnEvent[] = [
      { ts: "2026-05-12T10:00:00.000Z", event: "spawn_accepted", mode: "warn", session_id: "S1", parent_id: null, reason: "ok", violations: [], ctx_digest: null },
      { ts: "2026-05-12T10:01:00.000Z", event: "spawn_rejected", mode: "warn", session_id: "S2", parent_id: null, reason: "ERR_ROLE_MISSING", violations: [{ code: "ERR_ROLE_MISSING", detail: "x" }], ctx_digest: null },
      { ts: "2026-05-12T10:02:00.000Z", event: "spawn_degraded", mode: "warn", session_id: "S2", parent_id: null, reason: "ERR_ROLE_MISSING", violations: [{ code: "ERR_ROLE_MISSING", detail: "x" }], ctx_digest: null },
      { ts: "2026-05-12T10:03:00.000Z", event: "spawn_rejected", mode: "warn", session_id: "S3", parent_id: null, reason: "ERR_CWD_NOT_ABSOLUTE", violations: [{ code: "ERR_CWD_NOT_ABSOLUTE", detail: "y" }], ctx_digest: null },
      { ts: "2026-05-12T10:04:00.000Z", event: "mode_changed", mode: "off", session_id: null, parent_id: null, reason: "warn→off", violations: [], ctx_digest: null },
    ];
    const lines = seeds.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const fp = dailyFilePath(new Date("2026-05-12T12:00:00Z"), { root });
    const dir = fp.substring(0, fp.lastIndexOf("/"));
    spawnSync("mkdir", ["-p", dir]);
    writeFileSync(fp, lines, "utf8");
    const out = join(outDir, "SUMMARY.md");
    const r = spawnSync("bash", ["bin/spawn-telemetry-report.sh", "--root", root, "--out", out, "--days", "1"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const md = readFileSync(out, "utf8");
    assert.match(md, /spawn_accepted.*1/);
    assert.match(md, /spawn_rejected.*2/);
    assert.match(md, /ERR_ROLE_MISSING/);
    assert.match(md, /warn→off/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
