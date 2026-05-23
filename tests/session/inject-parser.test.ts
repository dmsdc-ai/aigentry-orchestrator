// inject-parser — unit tests for 5 envelope kinds (R2 + R5a).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInject } from "../../src/session/inject-parser.js";

test("REPORT — markdown fallback", () => {
  const r = parseInject("REPORT: my-task-DONE | sha=abc123 | tests=12/12");
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "report");
  assert.equal(r.envelope.transport, "markdown-fallback");
  assert.equal(r.envelope.payload.outcome, "DONE");
  assert.equal(r.envelope.payload.evidence["sha"], "abc123");
});

test("REPORT — fenced JSON envelope wins over markdown", () => {
  const body = [
    "preamble noise",
    "```json aigentry-envelope/v1",
    JSON.stringify({
      schema_version: "1",
      kind: "report",
      payload: { outcome: "BLOCKED", evidence: { reason: "deps-missing" } },
    }),
    "```",
    "REPORT: shadow-DONE | should=be-ignored",
  ].join("\n");
  const r = parseInject(body);
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "report");
  assert.equal(r.envelope.transport, "json-fenced");
  assert.equal(r.envelope.payload.outcome, "BLOCKED");
});

test("HOLD — markdown fallback", () => {
  const r = parseInject(
    "HOLD: foo | phase: 2/5 awaiting | reason: deps unwired | needs: ack",
  );
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "hold");
  assert.equal(r.envelope.payload.phase, "2/5 awaiting");
  assert.equal(r.envelope.payload.needs, "ack");
});

test("CLEANUP_REQUEST — markdown with default tier=immediate", () => {
  const r = parseInject("CLEANUP_REQUEST: worker-7 | reason: done");
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "cleanup-request");
  assert.equal(r.envelope.payload.target, "worker-7");
  assert.equal(r.envelope.payload.tier, "immediate");
  assert.equal(r.envelope.payload.reason, "done");
});

test("CLEANUP_REQUEST — ttl tier requires ttl_seconds", () => {
  const r = parseInject("CLEANUP_REQUEST: w | tier: ttl | ttl_seconds: 300");
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "cleanup-request");
  assert.equal(r.envelope.payload.tier, "ttl");
  assert.equal(r.envelope.payload.ttl_seconds, 300);
});

test("CLEANUP_REQUEST — grace_seconds field captured", () => {
  const r = parseInject("CLEANUP_REQUEST: w | reason: r | grace_seconds: 90");
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "cleanup-request");
  assert.equal(r.envelope.payload.grace_seconds, 90);
});

test("CLEANUP_REQUEST — fenced JSON envelope", () => {
  const body = [
    "```json aigentry-envelope/v1",
    JSON.stringify({
      schema_version: "1",
      kind: "cleanup-request",
      payload: { target: "w", tier: "immediate", reason: "json-path" },
    }),
    "```",
  ].join("\n");
  const r = parseInject(body);
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "cleanup-request");
  assert.equal(r.envelope.transport, "json-fenced");
});

test("EXTEND_LIFETIME — markdown without defer_minutes = cancel-pending intent", () => {
  const r = parseInject("EXTEND_LIFETIME: w | reason: more-work");
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "extend-lifetime");
  assert.equal(r.envelope.payload.target, "w");
  assert.equal(r.envelope.payload.defer_minutes, undefined);
  assert.equal(r.envelope.payload.reason, "more-work");
});

test("EXTEND_LIFETIME — markdown with defer_minutes", () => {
  const r = parseInject("EXTEND_LIFETIME: w | defer_minutes: 15");
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "extend-lifetime");
  assert.equal(r.envelope.payload.defer_minutes, 15);
});

test("TEST_REPORT — markdown fallback parses minimal fields", () => {
  const r = parseInject(
    "TEST_REPORT: tester-7 | suite=suite-A | total=10 | passed=9 | failed=1 | skipped=0 | duration_ms=1234",
  );
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "test-report");
  assert.equal(r.envelope.payload.session_id, "tester-7");
  assert.equal(r.envelope.payload.suite, "suite-A");
  assert.deepEqual(r.envelope.payload.totals, {
    total: 10,
    passed: 9,
    failed: 1,
    skipped: 0,
  });
  assert.equal(r.envelope.payload.duration_ms, 1234);
});

test("TEST_REPORT — fenced JSON with coverage", () => {
  const body = [
    "```json aigentry-envelope/v1",
    JSON.stringify({
      schema_version: "1",
      kind: "test-report",
      payload: {
        schema_version: "1",
        session_id: "tester-7",
        suite: "vitest",
        totals: { total: 5, passed: 5, failed: 0, skipped: 0 },
        finished_at: "2026-05-23T13:50:00Z",
        duration_ms: 42,
        coverage_line_pct: 87.5,
      },
    }),
    "```",
  ].join("\n");
  const r = parseInject(body);
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "test-report");
  assert.equal(r.envelope.transport, "json-fenced");
  assert.equal(r.envelope.payload.coverage_line_pct, 87.5);
});

test("invalid envelope JSON falls back to ok=false when no markdown match", () => {
  const r = parseInject("hello world no envelope here");
  assert.equal(r.ok, false);
});

test("malformed fenced JSON with wrong kind falls through to markdown", () => {
  const body = [
    "```json aigentry-envelope/v1",
    JSON.stringify({ schema_version: "1", kind: "unknown-kind", payload: {} }),
    "```",
    "HOLD: x | phase: 1/1 | reason: r | needs: n",
  ].join("\n");
  const r = parseInject(body);
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "hold");
});

test("CLEANUP_REQUEST with empty target rejected", () => {
  const r = parseInject("CLEANUP_REQUEST:  | reason: nothing");
  assert.equal(r.ok, false);
});

test("REPORT with no outcome suffix rejected (markdown)", () => {
  const r = parseInject("REPORT: missing-outcome-suffix");
  assert.equal(r.ok, false);
});

test("TEST_REPORT — malformed JSON (missing totals.total) is rejected, no silent accept", () => {
  const body = [
    "```json aigentry-envelope/v1",
    JSON.stringify({
      schema_version: "1",
      kind: "test-report",
      payload: {
        schema_version: "1",
        session_id: "tester-x",
        suite: "broken",
        totals: { passed: 1, failed: 0, skipped: 0 }, // total missing
        finished_at: "2026-05-23T13:50:00Z",
        duration_ms: 42,
      },
    }),
    "```",
  ].join("\n");
  const r = parseInject(body);
  assert.equal(r.ok, false);
});

test("TEST_REPORT — markdown missing duration_ms rejected", () => {
  const r = parseInject(
    "TEST_REPORT: tester-x | suite=s | total=1 | passed=1 | failed=0 | skipped=0",
  );
  assert.equal(r.ok, false);
});

test("TEST_REPORT — markdown with mismatched totals still accepted (no invariant check at parse)", () => {
  // The parse layer accepts numeric fields; invariant total===passed+failed+skipped
  // is enforced by the consumer (test-report writer), not the parser. This test
  // pins that boundary so downstream validators know the contract.
  const r = parseInject(
    "TEST_REPORT: tester-x | suite=s | total=10 | passed=1 | failed=0 | skipped=0 | duration_ms=1",
  );
  assert.ok(r.ok);
  assert.equal(r.envelope.kind, "test-report");
  assert.equal(r.envelope.payload.totals.total, 10);
});
