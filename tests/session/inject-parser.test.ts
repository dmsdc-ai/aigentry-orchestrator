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

// --- #932: session_id is a single safe path segment -----------------------
// The parser is the defence-in-depth layer for the traversal fixed at the handler in
// PR #22 (ih899 D2): a session_id becomes a FILENAME, so `"../../../pwned"` wrote a
// file of attacker-chosen content anywhere the orchestrator user could write. The
// handler still refuses it; enforcing it HERE means every consumer inherits the rule
// rather than only the one that remembered.
//
// REJECTED, never rewritten — a sanitised value would silently write to a file the
// sender did not name, which is the same defect with a quieter failure.

/** The fenced form, which is what a real transport carries. */
function fencedTestReport(sessionId: unknown): string {
  return [
    "```json aigentry-envelope/v1",
    JSON.stringify({
      schema_version: "1",
      kind: "test-report",
      payload: {
        schema_version: "1",
        session_id: sessionId,
        suite: "s",
        totals: { total: 1, passed: 1, failed: 0, skipped: 0 },
        finished_at: "2026-05-23T13:50:00Z",
        duration_ms: 1,
      },
    }),
    "```",
  ].join("\n");
}

// One case per rejected FORM, each named for what it defeats. `.` and `..` are here
// as their own rows because they are built only from characters the class allows —
// a character filter passes them through intact, so only a by-name check sees them.
const REJECTED: [string, unknown][] = [
  ["parent traversal", "../../canary/precious"],
  ["a single separator", "a/b"],
  ["an absolute path", "/etc/passwd"],
  ["dot — survives a character-class filter", "."],
  ["dotdot — survives a character-class filter", ".."],
  ["a NUL byte", "a\u0000b"],
  ["a newline (log forging)", "a\nb"],
  ["the empty string", ""],
  ["over the length cap", "a".repeat(129)],
  ["a non-string", 42],
];

for (const [why, sid] of REJECTED) {
  test(`TEST_REPORT — session_id rejected: ${why}`, () => {
    const r = parseInject(fencedTestReport(sid));
    assert.equal(r.ok, false, `session_id ${JSON.stringify(sid)} was accepted`);
    if (r.ok) return;
    // The rejection NAMES the field, which is what lets src/inject-handler/cli.ts
    // keep emitting `INJECT_PAYLOAD_REJECTED field=session_id` instead of degrading
    // to a generic parse failure (T124 block M, T136).
    assert.equal(r.field, "session_id");
    assert.equal(r.kind, "test-report");
    assert.equal(r.value, sid);
  });
}

test("TEST_REPORT — the markdown path enforces the same rule", () => {
  // parseMarkdownTestReport BUILDS a TestReport directly and never went through
  // validateTestReport, so this line reaches the identical filename as the fenced form.
  const r = parseInject(
    "TEST_REPORT: ../../canary/precious | suite=s | total=1 | passed=1 | failed=0 | skipped=0 | duration_ms=1",
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.field, "session_id");
});

test("TEST_REPORT — a hostile fenced payload is not reinterpreted as another envelope", () => {
  // Failing CLOSED: before the rule the bad test-report simply failed to narrow and
  // the body fell through to the markdown scans, so a traversal attempt could be
  // re-read as an ordinary REPORT and pass. It must be refused, not reinterpreted.
  const body = `${fencedTestReport("../../x")}\nREPORT: my-task-DONE | sha=abc123`;
  const r = parseInject(body);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.field, "session_id");
});

test("TEST_REPORT — ordinary session_ids still parse (the refusal is narrow)", () => {
  for (const good of ["ih899-coder.v2", "tester-7", "a", "A_B-c.d", "a".repeat(128)]) {
    const r = parseInject(fencedTestReport(good));
    assert.ok(r.ok, `${good} was refused`);
    assert.equal(r.envelope.kind, "test-report");
  }
});
