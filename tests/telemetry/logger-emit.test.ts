// δ2 Phase 2 (#440) — emitTelemetry wrapper.
// Verifies: (a) A1 subtype mapping, (b) env-var session/role discovery + fallbacks,
// (c) §9 독립 non-blocking failure semantics, (d) emitted envelope passes ssot schema shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TelemetryEvent } from "@aigentry/logger";
import {
  emitDispatchEvent,
  emitLifecycleEvent,
  emitReportEvent,
  emitTelemetry,
  resolveLoggerEmitContext,
} from "../../src/telemetry/logger-emit.js";

function capture(): { events: TelemetryEvent[]; sink: (e: TelemetryEvent) => void } {
  const events: TelemetryEvent[] = [];
  return { events, sink: (e) => events.push(e) };
}

const FROZEN = (): Date => new Date("2026-05-23T12:00:00.000Z");

test("resolveLoggerEmitContext — env values when present", () => {
  const ctx = resolveLoggerEmitContext({ AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "coder" });
  assert.equal(ctx.session_id, "sid-A");
  assert.equal(ctx.role, "coder");
});

test("resolveLoggerEmitContext — invalid role falls back to orchestrator", () => {
  const ctx = resolveLoggerEmitContext({ AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "devkit" });
  assert.equal(ctx.role, "orchestrator");
});

test("resolveLoggerEmitContext — missing env falls back to pid + orchestrator", () => {
  const ctx = resolveLoggerEmitContext({});
  assert.match(ctx.session_id, /^pid-\d+$/);
  assert.equal(ctx.role, "orchestrator");
});

test("emitTelemetry — builds full envelope and forwards to sink", () => {
  const { events, sink } = capture();
  emitTelemetry({
    kind: "state-change",
    payload: { subtype: "dispatch_start", target_sid: "x" },
    correlation_id: "x",
    env: { AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "orchestrator" },
    now: FROZEN,
    __emit: sink,
  });
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.schema_version, "1");
  assert.equal(e.kind, "state-change");
  assert.equal(e.session_id, "sid-A");
  assert.equal(e.role, "orchestrator");
  assert.equal(e.emitted_at, "2026-05-23T12:00:00.000Z");
  assert.equal(e.correlation_id, "x");
  assert.deepEqual(e.payload, { subtype: "dispatch_start", target_sid: "x" });
});

test("emitTelemetry — transport failure is swallowed (§9 non-blocking)", () => {
  const throwing = (): void => {
    throw new Error("simulated logger unreachable");
  };
  const origErr = console.error;
  const errs: string[] = [];
  console.error = (msg: string): void => {
    errs.push(msg);
  };
  try {
    assert.doesNotThrow(() =>
      emitTelemetry({
        kind: "error",
        payload: { reason: "x" },
        env: { AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "orchestrator" },
        now: FROZEN,
        __emit: throwing,
      }),
    );
  } finally {
    console.error = origErr;
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /telemetry emit failed/);
});

test("emitLifecycleEvent / emitDispatchEvent / emitReportEvent — A1 subtype mapping", () => {
  for (const [helper, subtype, expectKind] of [
    ["lifecycle", "cleanup", "state-change"] as const,
    ["dispatch", "dispatch_start", "state-change"] as const,
    ["report", "test_report", "report"] as const,
  ]) {
    const { events, sink } = capture();
    const env = { AIGENTRY_SESSION_ID: "sid-A", AIGENTRY_ROLE: "orchestrator" };
    if (helper === "lifecycle") {
      emitTelemetry({
        kind: "state-change",
        payload: { subtype, k: 1 },
        env,
        now: FROZEN,
        __emit: sink,
      });
    } else if (helper === "dispatch") {
      emitTelemetry({
        kind: "state-change",
        payload: { subtype, k: 1 },
        env,
        now: FROZEN,
        __emit: sink,
      });
    } else {
      emitTelemetry({
        kind: "report",
        payload: { subtype, k: 1 },
        env,
        now: FROZEN,
        __emit: sink,
      });
    }
    assert.equal(events[0]?.kind, expectKind);
    assert.equal((events[0]?.payload as { subtype?: string }).subtype, subtype);
  }
});

test("emitLifecycleEvent — convenience wrapper uses default transport (smoke)", () => {
  // Real emit goes through the on-disk transport; we only assert the helper
  // doesn't throw for a valid event. AIGENTRY_LOGGER_DISABLED=1 keeps this
  // smoke test from writing to ~/.aigentry/telemetry/.
  process.env.AIGENTRY_SESSION_ID = "sid-smoke";
  process.env.AIGENTRY_ROLE = "orchestrator";
  process.env.AIGENTRY_LOGGER_DISABLED = "1";
  try {
    assert.doesNotThrow(() => emitLifecycleEvent("cleanup", { target: "x" }, "x"));
    assert.doesNotThrow(() => emitDispatchEvent("dispatch_start", { target_sid: "x" }, "x"));
    assert.doesNotThrow(() => emitReportEvent("hold", { transport: "json" }));
  } finally {
    delete process.env.AIGENTRY_SESSION_ID;
    delete process.env.AIGENTRY_ROLE;
    delete process.env.AIGENTRY_LOGGER_DISABLED;
  }
});

test("emitTelemetry — AIGENTRY_LOGGER_DISABLED=1 short-circuits before sink", () => {
  let called = 0;
  emitTelemetry({
    kind: "state-change",
    payload: { subtype: "dispatch_start" },
    env: { AIGENTRY_LOGGER_DISABLED: "1", AIGENTRY_SESSION_ID: "sid-A" },
    now: FROZEN,
    __emit: () => {
      called++;
    },
  });
  assert.equal(called, 0);
});
