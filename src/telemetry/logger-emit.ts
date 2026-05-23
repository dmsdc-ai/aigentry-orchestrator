// Thin wrapper around @aigentry/logger.emit() with orchestrator-flavoured
// discovery, schema mapping, and non-blocking failure semantics.
//
// Decisions consumed (δ2 Phase 1 ACK, #440):
//   - A1 — payload.subtype discriminates spec event names inside ssot's
//     closed 6-value `kind` enum. This module exposes typed helpers per
//     spec event so call sites stay readable.
//   - B  — session_id / role come from env (AIGENTRY_SESSION_ID,
//     AIGENTRY_ROLE). Fallbacks: pid-string session_id, role 'orchestrator'
//     (this repo's natural role; valid against the ssot Role enum).
//   - C3 — wrapper is ADDITIVE; ADR-MF #9 `src/telemetry/spawn-events.ts`
//     is untouched. Logger emit is wired at the NEW inject-handler /
//     dispatch sites only — not at the validate-spawn gate.
//
// Failure mode: logger unreachable → console.error fallback. The primary
// code path MUST NOT block on telemetry failure (§9 독립).

import type { TelemetryEvent } from "@aigentry/logger";
import { emit as loggerEmit } from "@aigentry/logger";

const VALID_ROLES = new Set([
  "orchestrator",
  "architect",
  "coder",
  "tester",
  "builder",
  "analyst",
  "researcher",
  "reviewer",
  "logger",
]);

export interface LoggerEmitContext {
  session_id: string;
  role: TelemetryEvent["role"];
}

export function resolveLoggerEmitContext(
  env: NodeJS.ProcessEnv = process.env,
): LoggerEmitContext {
  const session_id = env.AIGENTRY_SESSION_ID || `pid-${process.pid}`;
  const rawRole = env.AIGENTRY_ROLE;
  const role = (rawRole && VALID_ROLES.has(rawRole) ? rawRole : "orchestrator") as TelemetryEvent["role"];
  return { session_id, role };
}

export interface EmitTelemetryInput {
  kind: TelemetryEvent["kind"];
  payload: Record<string, unknown>;
  correlation_id?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  // Test injection: override the emit transport.
  __emit?: (event: TelemetryEvent) => void;
}

export function emitTelemetry(input: EmitTelemetryInput): void {
  const env = input.env ?? process.env;
  // §9 독립 + test-isolation opt-out. When set, the wrapper short-circuits
  // before any I/O so callers (CI, dry-run tests) never write telemetry.
  if (env.AIGENTRY_LOGGER_DISABLED === "1") return;
  const ctx = resolveLoggerEmitContext(env);
  const now = input.now ?? (() => new Date());
  const event: TelemetryEvent = {
    schema_version: "1",
    kind: input.kind,
    session_id: ctx.session_id,
    role: ctx.role,
    emitted_at: now().toISOString(),
    payload: input.payload,
    ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
  };
  const sink = input.__emit ?? loggerEmit;
  try {
    sink(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[logger-emit] telemetry emit failed (non-blocking): ${msg}`);
  }
}

// ─── Typed helpers (A1 mapping table) ────────────────────────────────────

export type LifecycleSubtype = "cleanup" | "extend" | "reattach";
export type DispatchSubtype = "dispatch_start" | "dispatch_ack";
export type ReportSubtype = "report" | "test_report" | "hold";

export function emitLifecycleEvent(
  subtype: LifecycleSubtype,
  payload: Record<string, unknown>,
  correlation_id?: string,
): void {
  emitTelemetry({
    kind: "state-change",
    payload: { subtype, ...payload },
    ...(correlation_id ? { correlation_id } : {}),
  });
}

export function emitDispatchEvent(
  subtype: DispatchSubtype,
  payload: Record<string, unknown>,
  correlation_id?: string,
): void {
  emitTelemetry({
    kind: "state-change",
    payload: { subtype, ...payload },
    ...(correlation_id ? { correlation_id } : {}),
  });
}

export function emitReportEvent(
  subtype: ReportSubtype,
  payload: Record<string, unknown>,
  correlation_id?: string,
): void {
  emitTelemetry({
    kind: "report",
    payload: { subtype, ...payload },
    ...(correlation_id ? { correlation_id } : {}),
  });
}
