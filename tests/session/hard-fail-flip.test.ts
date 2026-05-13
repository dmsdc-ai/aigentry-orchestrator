// ADR-MF #11 — Hard-fail flip tests.
// Verifies DEFAULT_VALIDATION_MODE = 'hard-fail' is the new default and that
// explicit mode='warn'|'off' overrides still work. Constant assertion lives
// here so a future re-flip (rollback) surfaces as a focused failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { Role, type SpawnRequest } from "../../src/session/types.js";
import {
  __resetModeTrackingForTests, DEFAULT_VALIDATION_MODE,
  enforceSpawn, readValidationMode, SpawnValidationError,
} from "../../src/session/validate-spawn.js";
import type { SpawnEvent } from "../../src/telemetry/spawn-events.js";

const TMP = tmpdir();
const clock = (iso: string) => (): Date => new Date(iso);
const req = (over: Partial<SpawnRequest> = {}): SpawnRequest =>
  ({ role: Role.coder, cwd: TMP, task: { task_id: "T-1" }, ...over });
const reset = (): void => __resetModeTrackingForTests();
const sink = (): { events: SpawnEvent[]; emit: (e: SpawnEvent) => void } => {
  const events: SpawnEvent[] = [];
  return { events, emit: (e) => events.push(e) };
};

test("MF11 (1) — default constant is 'hard-fail' (env-empty + env-garbage)", () => {
  assert.equal(DEFAULT_VALIDATION_MODE, "hard-fail");
  assert.equal(readValidationMode({}), "hard-fail");
  assert.equal(readValidationMode({ AIGENTRY_SPAWN_VALIDATION_MODE: "garbage" }), "hard-fail");
});

test("MF11 (2) — default-mode throws SpawnValidationError on G1 violation", () => {
  reset();
  const { events, emit } = sink();
  assert.throws(
    () => enforceSpawn(req({ role: undefined as unknown as Role }),
      { emit, now: clock("2026-05-13T10:00:00.000Z") }),
    (err: unknown) => err instanceof SpawnValidationError && err.code === "ERR_ROLE_MISSING",
  );
  const rejected = events.filter((e) => e.event === "spawn_rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.mode, "hard-fail");
  assert.equal(events.some((e) => e.event === "spawn_degraded"), false);
});

test("MF11 (3) — explicit mode='warn' override still degrades to logger", () => {
  reset();
  const { events, emit } = sink();
  const r = enforceSpawn(req({ role: undefined as unknown as Role }),
    { mode: "warn", emit, now: clock("2026-05-13T10:00:00.000Z") });
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.degraded, true); assert.equal(r.effective_role, Role.logger); }
  assert.equal(events.filter((e) => e.event === "spawn_rejected").length, 1);
  assert.equal(events.filter((e) => e.event === "spawn_degraded").length, 1);
});

test("MF11 (4) — explicit mode='off' override skips validation, zero spawn events", () => {
  reset();
  const { events, emit } = sink();
  const r = enforceSpawn(req({ role: undefined as unknown as Role }),
    { mode: "off", emit, now: clock("2026-05-13T10:00:00.000Z") });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.degraded, false);
  assert.equal(events.filter((e) =>
    e.event === "spawn_accepted" || e.event === "spawn_rejected").length, 0);
});

test("MF11 (5) — default-mode happy path returns ok without throw", () => {
  reset();
  const { events, emit } = sink();
  const r = enforceSpawn(req(), { emit, now: clock("2026-05-13T10:00:00.000Z") });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.degraded, false);
    assert.equal(r.effective_role, Role.coder);
    assert.equal(r.mode, "hard-fail");
  }
  assert.equal(events.filter((e) => e.event === "spawn_accepted").length, 1);
});
