// inject-parser — orchestrator-side parser for inject envelopes received
// from worker sessions over the PTY channel.
//
// Five recognized kinds (ADR 2026-05-20 session-lifecycle-3-layer + task #436
// tester→orchestrator handoff):
//
//   - report           — terminal success/blocked/stuck report (Layer A trigger)
//   - cleanup-request  — worker asks orchestrator to release its workspace
//   - extend-lifetime  — worker pre-empts a scheduled cleanup (cancel or defer)
//   - hold             — phase-boundary block awaiting orchestrator decision
//   - test-report      — tester role structured handoff (R5a)
//
// Parsing strategy mirrors ssot/envelope/pty-envelope:
//   1. fenced JSON envelope (preferred — typed kind discriminator)
//   2. markdown line fallback (backward compat with pre-envelope workers)
//
// REPORT and HOLD fallback parsing is delegated to ssot's parsePtyEnvelope.
// CLEANUP_REQUEST / EXTEND_LIFETIME / TEST_REPORT fallback shapes are
// implemented here (additive — ssot only owns the originally-shipped two).

import {
  parsePtyEnvelope,
  type CleanupRequest,
  type Hold,
  type Report,
  type TestReport,
} from "@dmsdc-ai/aigentry-ssot";

export interface ExtendLifetimePayload {
  target: string;
  defer_minutes?: number;
  reason?: string;
}

export interface CleanupRequestPayload extends CleanupRequest {
  /** Optional grace seconds override (workers MAY ask for a non-default grace). */
  grace_seconds?: number;
}

export type ParsedInjectKind =
  | "report"
  | "cleanup-request"
  | "extend-lifetime"
  | "hold"
  | "test-report";

export type ParsedInject =
  | { kind: "report"; payload: Report; transport: "json-fenced" | "markdown-fallback" }
  | {
      kind: "cleanup-request";
      payload: CleanupRequestPayload;
      transport: "json-fenced" | "markdown-fallback";
    }
  | {
      kind: "extend-lifetime";
      payload: ExtendLifetimePayload;
      transport: "json-fenced" | "markdown-fallback";
    }
  | { kind: "hold"; payload: Hold; transport: "json-fenced" | "markdown-fallback" }
  | { kind: "test-report"; payload: TestReport; transport: "json-fenced" | "markdown-fallback" };

export type ParseResult =
  | { ok: true; envelope: ParsedInject }
  | { ok: false; error: string };

/**
 * Parse an inject body. Returns the first envelope recognized.
 *
 * Resolution order:
 *   1. Fenced JSON via ssot.parsePtyEnvelope — narrowed onto our 5 kinds.
 *   2. Markdown fallbacks for each kind, scanned in declaration order
 *      (REPORT/HOLD via ssot; CLEANUP_REQUEST / EXTEND_LIFETIME / TEST_REPORT here).
 */
export function parseInject(body: string): ParseResult {
  const ssot = parsePtyEnvelope(body);
  if (ssot.ok) {
    const { envelope } = ssot;
    const narrowed = narrowSsotEnvelope(envelope.kind, envelope.payload, envelope.transport);
    if (narrowed) return { ok: true, envelope: narrowed };
  }

  // Markdown REPORT/HOLD scan (independent of ssot result — handles bad fenced kind).
  const report = parseMarkdownReport(body);
  if (report) {
    return { ok: true, envelope: { kind: "report", payload: report, transport: "markdown-fallback" } };
  }
  const hold = parseMarkdownHold(body);
  if (hold) {
    return { ok: true, envelope: { kind: "hold", payload: hold, transport: "markdown-fallback" } };
  }

  const cleanup = parseMarkdownCleanupRequest(body);
  if (cleanup) {
    return {
      ok: true,
      envelope: { kind: "cleanup-request", payload: cleanup, transport: "markdown-fallback" },
    };
  }

  const extend = parseMarkdownExtendLifetime(body);
  if (extend) {
    return {
      ok: true,
      envelope: { kind: "extend-lifetime", payload: extend, transport: "markdown-fallback" },
    };
  }

  const testReport = parseMarkdownTestReport(body);
  if (testReport) {
    return {
      ok: true,
      envelope: { kind: "test-report", payload: testReport, transport: "markdown-fallback" },
    };
  }

  return { ok: false, error: ssot.ok ? "unknown envelope kind" : ssot.error };
}

// --- ssot envelope narrowing ---------------------------------------------

function narrowSsotEnvelope(
  kind: string,
  payload: unknown,
  transport: "json-fenced" | "markdown-fallback",
): ParsedInject | null {
  switch (kind) {
    case "report":
      return validateReport(payload)
        ? { kind: "report", payload, transport }
        : null;
    case "hold":
      return validateHold(payload)
        ? { kind: "hold", payload, transport }
        : null;
    case "cleanup-request":
      return validateCleanupRequest(payload)
        ? { kind: "cleanup-request", payload, transport }
        : null;
    case "extend-lifetime":
      return validateExtendLifetime(payload)
        ? { kind: "extend-lifetime", payload, transport }
        : null;
    case "test-report":
      return validateTestReport(payload)
        ? { kind: "test-report", payload, transport }
        : null;
    default:
      return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function validateReport(p: unknown): p is Report {
  if (!isRecord(p)) return false;
  const outcome = p.outcome;
  if (outcome !== "DONE" && outcome !== "BLOCKED" && outcome !== "STUCK") return false;
  if (!isRecord(p.evidence)) return false;
  return true;
}

function validateHold(p: unknown): p is Hold {
  if (!isRecord(p)) return false;
  return (
    typeof p.phase === "string" &&
    typeof p.reason === "string" &&
    typeof p.needs === "string"
  );
}

function validateCleanupRequest(p: unknown): p is CleanupRequestPayload {
  if (!isRecord(p)) return false;
  if (typeof p.target !== "string" || p.target.length === 0) return false;
  const tier = p.tier;
  if (tier !== "immediate" && tier !== "on-hold" && tier !== "ttl") return false;
  if (tier === "ttl" && typeof p.ttl_seconds !== "number") return false;
  return true;
}

function validateExtendLifetime(p: unknown): p is ExtendLifetimePayload {
  if (!isRecord(p)) return false;
  if (typeof p.target !== "string" || p.target.length === 0) return false;
  if ("defer_minutes" in p && typeof p.defer_minutes !== "number") return false;
  return true;
}

function validateTestReport(p: unknown): p is TestReport {
  if (!isRecord(p)) return false;
  if (p.schema_version !== "1") return false;
  if (typeof p.session_id !== "string") return false;
  if (typeof p.suite !== "string") return false;
  if (!isRecord(p.totals)) return false;
  const t = p.totals as Record<string, unknown>;
  if (
    typeof t.total !== "number" ||
    typeof t.passed !== "number" ||
    typeof t.failed !== "number" ||
    typeof t.skipped !== "number"
  ) {
    return false;
  }
  if (typeof p.finished_at !== "string") return false;
  if (typeof p.duration_ms !== "number") return false;
  return true;
}

// --- markdown fallbacks --------------------------------------------------

/**
 * Markdown REPORT shape (mirrors ssot regex but exposed here so we can
 * recover when ssot.parsePtyEnvelope returned a fenced JSON with an
 * unrecognized kind and we still want to see the markdown line):
 *   `REPORT: <session>-<outcome> | k1=v1 | k2=v2 ...`
 */
function parseMarkdownReport(body: string): Report | null {
  const line = findFirstLineStartingWith(body, "REPORT:");
  if (!line) return null;
  const head = line.slice("REPORT:".length).trim();
  const firstPipe = head.indexOf("|");
  const subjectStr = firstPipe === -1 ? head : head.slice(0, firstPipe).trim();
  const restStr = firstPipe === -1 ? "" : head.slice(firstPipe + 1);
  const outcomeMatch = subjectStr.match(/-(DONE|BLOCKED|STUCK)\s*$/);
  if (!outcomeMatch) return null;
  const outcome = outcomeMatch[1] as Report["outcome"];
  const evidence: Record<string, string> = {};
  for (const seg of restStr.split("|")) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq !== -1) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k) evidence[k] = v;
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (k) evidence[k] = v;
  }
  const result: Report = { outcome, evidence };
  const taskField = evidence["tasks"] ?? evidence["task"];
  if (taskField) {
    result.task_refs = taskField
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return result;
}

/**
 * Markdown HOLD shape:
 *   `HOLD: <session> | phase: <phase> | reason: <reason> | needs: <needs> [| task: <task>]`
 */
function parseMarkdownHold(body: string): Hold | null {
  const line = findFirstLineStartingWith(body, "HOLD:");
  if (!line) return null;
  const fields = parsePipeFields(line.slice("HOLD:".length));
  const phase = fields.get("phase");
  const reason = fields.get("reason");
  const needs = fields.get("needs");
  if (!phase || !reason || !needs) return null;
  const task_ref = fields.get("task") ?? fields.get("tasks");
  return task_ref !== undefined
    ? { phase, reason, needs, task_ref }
    : { phase, reason, needs };
}

/**
 * Markdown CLEANUP_REQUEST shape:
 *   `CLEANUP_REQUEST: <sid> | reason: <text> [| tier: immediate|on-hold|ttl] [| grace_seconds: N] [| ttl_seconds: N]`
 * Default tier when omitted: "immediate".
 */
function parseMarkdownCleanupRequest(body: string): CleanupRequestPayload | null {
  const line = findFirstLineStartingWith(body, "CLEANUP_REQUEST:");
  if (!line) return null;
  const rest = line.slice("CLEANUP_REQUEST:".length).trim();
  const firstPipe = rest.indexOf("|");
  const target = (firstPipe === -1 ? rest : rest.slice(0, firstPipe)).trim();
  if (!target) return null;
  const fields = parsePipeFields(firstPipe === -1 ? "" : rest.slice(firstPipe + 1));
  const tier = (fields.get("tier") ?? "immediate") as CleanupRequestPayload["tier"];
  if (tier !== "immediate" && tier !== "on-hold" && tier !== "ttl") return null;
  const result: CleanupRequestPayload = { target, tier };
  const ttl = fields.get("ttl_seconds");
  if (ttl) {
    const n = Number.parseInt(ttl, 10);
    if (Number.isFinite(n)) result.ttl_seconds = n;
  }
  const grace = fields.get("grace_seconds");
  if (grace) {
    const n = Number.parseInt(grace, 10);
    if (Number.isFinite(n)) result.grace_seconds = n;
  }
  const reason = fields.get("reason");
  if (reason) result.reason = reason;
  return result;
}

/**
 * Markdown EXTEND_LIFETIME shape:
 *   `EXTEND_LIFETIME: <sid> [| defer_minutes: N] [| reason: <text>]`
 * Omitting defer_minutes means "cancel pending cleanup" (resolved by handler).
 */
function parseMarkdownExtendLifetime(body: string): ExtendLifetimePayload | null {
  const line = findFirstLineStartingWith(body, "EXTEND_LIFETIME:");
  if (!line) return null;
  const rest = line.slice("EXTEND_LIFETIME:".length).trim();
  const firstPipe = rest.indexOf("|");
  const target = (firstPipe === -1 ? rest : rest.slice(0, firstPipe)).trim();
  if (!target) return null;
  const fields = parsePipeFields(firstPipe === -1 ? "" : rest.slice(firstPipe + 1));
  const result: ExtendLifetimePayload = { target };
  const defer = fields.get("defer_minutes");
  if (defer) {
    const n = Number.parseInt(defer, 10);
    if (Number.isFinite(n)) result.defer_minutes = n;
  }
  const reason = fields.get("reason");
  if (reason) result.reason = reason;
  return result;
}

/**
 * Markdown TEST_REPORT shape (fallback only — fenced JSON preferred):
 *   `TEST_REPORT: <sid> | suite=<suite> | total=N | passed=N | failed=N | skipped=N | duration_ms=N [| finished_at=ISO] [| coverage_line_pct=N]`
 * Subject is the session id alone (session ids can contain dashes).
 */
function parseMarkdownTestReport(body: string): TestReport | null {
  const line = findFirstLineStartingWith(body, "TEST_REPORT:");
  if (!line) return null;
  const head = line.slice("TEST_REPORT:".length).trim();
  const firstPipe = head.indexOf("|");
  const sessionId = (firstPipe === -1 ? head : head.slice(0, firstPipe)).trim();
  if (!sessionId) return null;
  const kv = parseEqualFields(firstPipe === -1 ? "" : head.slice(firstPipe + 1));
  const suite = kv.get("suite");
  if (!suite) return null;
  const total = numField(kv, "total");
  const passed = numField(kv, "passed");
  const failed = numField(kv, "failed");
  const skipped = numField(kv, "skipped");
  const duration_ms = numField(kv, "duration_ms");
  if (
    total === undefined ||
    passed === undefined ||
    failed === undefined ||
    skipped === undefined ||
    duration_ms === undefined
  ) {
    return null;
  }
  const finished_at = kv.get("finished_at") ?? new Date().toISOString();
  const result: TestReport = {
    schema_version: "1",
    session_id: sessionId,
    suite,
    totals: { total, passed, failed, skipped },
    finished_at,
    duration_ms,
  };
  const coverage = numField(kv, "coverage_line_pct");
  if (coverage !== undefined) result.coverage_line_pct = coverage;
  return result;
}

function findFirstLineStartingWith(body: string, prefix: string): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const trimmed = raw.trimStart();
    if (trimmed.startsWith(prefix)) return trimmed;
  }
  return null;
}

function parsePipeFields(segment: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of segment.split("|")) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

function parseEqualFields(segment: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const seg of segment.split("|")) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq !== -1) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k) out.set(k, v);
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const k = trimmed.slice(0, colon).trim();
    const v = trimmed.slice(colon + 1).trim();
    if (k) out.set(k, v);
  }
  return out;
}

function numField(kv: Map<string, string>, k: string): number | undefined {
  const raw = kv.get(k);
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}
