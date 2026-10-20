import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INTAKE_BOUNDS,
  INTAKE_FORBIDDEN_KEYS,
  INTAKE_ORDER_LABEL,
  INTAKE_SCHEMA_VERSION,
  type IntakeDocument,
  type IntakeEvent,
  type IntakeEventKind,
  type IntakeOutcome,
  type IntakeRequest,
  type IntakeState,
  applyIntakeEvent,
  derivePositions,
  emptyIntakeDocument,
  intakeExitCode,
  prunePlan,
  upstreamDedupeKey,
  validateIntakeDocument,
} from "../../src/request-capture/intake.js";

// #1166 U1 — the pure intake decision core. No fs, no child, no clock: the whole state machine,
// identity model, FIFO derivation and prune plan as total functions. tsconfig includes
// tests/**/*.ts and scripts/run-tests.mjs:99-124 enumerates dist/tests/**/*.test.js, so this
// suite needs no runner edit and runs on every OS.
//
// The real writer (bin/dispatch-registry.py) is measured in intake-registry.test.mjs; its R-DIFF
// case pins the two implementations to each other, so a case here is a statement about both.

const at = (n: number): string =>
  `${new Date(Date.parse("2026-10-14T09:00:00Z") + n * 60_000).toISOString().slice(0, 19)}Z`;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex64 = (n: number): string => String(n).padStart(2, "0").repeat(32);

function capture(n: number, over: Partial<IntakeEvent> = {}): IntakeEvent {
  return {
    kind: "captured",
    at: at(n),
    ingress_id: uuid(n),
    capture_id: uuid(900 + n),
    channel: "codex-native",
    upstream_namespace: "codex/session",
    upstream_id_status: "unavailable",
    upstream_delivery_id: null,
    upstream_scope_sha256: null,
    sha256: hex64(n),
    byte_len: 16 * n,
    received_at: at(n),
    ...over,
  };
}

/** Apply and require acceptance; returns the new document. */
function ok(doc: IntakeDocument, event: IntakeEvent): IntakeDocument {
  const outcome = applyIntakeEvent(doc, event);
  assert.equal(outcome.result, "intake_written", `${event.kind}: ${outcome.detail ?? ""}`);
  assert.ok(outcome.document, `${event.kind}: an accepted event must return a document`);
  return outcome.document;
}

/** Apply and require this exact refusal, with the document untouched. */
function no(doc: IntakeDocument, event: IntakeEvent, result: string): IntakeOutcome {
  const before = JSON.stringify(doc);
  const outcome = applyIntakeEvent(doc, event);
  assert.equal(outcome.result, result, `${event.kind}: ${outcome.detail ?? ""}`);
  assert.equal(outcome.document, null, `${event.kind}: a refusal returns no document`);
  assert.equal(JSON.stringify(doc), before, `${event.kind}: the input document was mutated`);
  return outcome;
}

const row = (doc: IntakeDocument, n: number): IntakeRequest => {
  const found = doc.requests.find((r) => r.ingress_id === uuid(n));
  assert.ok(found, `no row ${uuid(n)}`);
  return found;
};

function lifecycle(): IntakeDocument {
  let doc = ok(emptyIntakeDocument(), capture(1));
  doc = ok(doc, { kind: "bind", at: at(2), ingress_id: uuid(1), owning_task: "1166",
    dispatch_id: uuid(11) });
  doc = ok(doc, { kind: "start", at: at(3), ingress_id: uuid(1) });
  return doc;
}

const KINDS: IntakeEventKind[] = ["captured", "bind", "start", "pause", "resume", "answered",
  "work-completed", "fail", "cancel", "amend"];

// --- document, schema, bounds -------------------------------------------------

test("the empty ledger is its own versioned document", () => {
  const doc = emptyIntakeDocument();
  assert.equal(INTAKE_SCHEMA_VERSION, 1);
  assert.deepEqual(doc, { schema_version: 1, generation: 0, requests: [] });
  assert.equal(validateIntakeDocument(doc).result, "ok");
  assert.equal(INTAKE_ORDER_LABEL, "received-at-then-ingress-id-not-commit-not-execution");
});

test("the validator refuses every malformed document shape, and never repairs one", () => {
  for (const bad of [null, [], 3, "x", { schema_version: 2, generation: 0, requests: [] },
    { schema_version: 1, generation: "0", requests: [] },
    { schema_version: 1, generation: 0, requests: {} },
    { schema_version: 1, generation: 0, requests: [3] },
    { schema_version: 1, generation: 0, requests: [{ ingress_id: uuid(1) }, { ingress_id: uuid(1) }] }]) {
    assert.equal(validateIntakeDocument(bad).result, "registry_corrupt", JSON.stringify(bad));
  }
});

test("a record field that could carry prompt content is refused by name", () => {
  assert.ok(INTAKE_FORBIDDEN_KEYS.length > 0);
  for (const key of ["text", "prompt", "excerpt", "body", "content", "metadata", "filename",
    "path", "command", "argv", "original_text"]) {
    assert.ok(INTAKE_FORBIDDEN_KEYS.includes(key), `${key} must be forbidden in an intake row`);
    const doc = ok(emptyIntakeDocument(), capture(1));
    (doc.requests[0] as unknown as Record<string, unknown>)[key] = "hello";
    assert.equal(validateIntakeDocument(doc).result, "registry_corrupt", key);
  }
});

test("bounds refuse rather than truncate or evict", () => {
  const doc = lifecycle();
  assert.equal(INTAKE_BOUNDS.max_rows, 4096);
  no(doc, { kind: "cancel", at: at(4), ingress_id: uuid(1), reason: "x".repeat(257) },
    "intake_bounds_exceeded");
  no(doc, { kind: "bind", at: at(4), ingress_id: uuid(1), owning_task: "t".repeat(129),
    dispatch_id: uuid(11) }, "intake_bounds_exceeded");
  no(doc, { kind: "work-completed", at: at(4), ingress_id: uuid(1), verdict: "accepted",
    result_ref: "r".repeat(513), evidence_sha256: hex64(3) }, "intake_bounds_exceeded");
  no(doc, { kind: "pause", at: at(4), ingress_id: uuid(1), reason: "r", owner: "o",
    resume_condition: "c", depends_on: Array.from({ length: 33 }, (_, i) => `d${i}`) },
    "intake_bounds_exceeded");
  // a full ledger refuses the next capture; it never evicts the oldest row
  const template = row(doc, 1);
  const full: IntakeDocument = { ...doc, requests: Array.from({ length: INTAKE_BOUNDS.max_rows },
    (_, i) => ({ ...template, ingress_id: uuid(1000 + i), capture_id: uuid(5000 + i) })) };
  no(full, capture(2), "intake_bounds_exceeded");
  // but an existing row stays mutable: an urgent cancel must not be blocked by a full ledger
  assert.equal(applyIntakeEvent(full, { kind: "cancel", at: at(5), ingress_id: uuid(1000),
    reason: "urgent" }).result, "intake_written");
  // history refuses at its bound instead of dropping the audit trail
  const long: IntakeDocument = { ...doc, requests: [{ ...template,
    history: Array.from({ length: INTAKE_BOUNDS.max_history }, () => ({ at: at(1),
      event: "bind" as IntakeEventKind, from: "queued" as IntakeState, to: "queued" as IntakeState })) }] };
  no(long, { kind: "bind", at: at(6), ingress_id: uuid(1), owning_task: "1166",
    dispatch_id: uuid(12) }, "intake_bounds_exceeded");
});

test("malformed identity and measurement fields are refused, never coerced", () => {
  const doc = emptyIntakeDocument();
  for (const over of [{ ingress_id: "../../etc/passwd" }, { ingress_id: "a\u0000b" },
    { ingress_id: "" }, { ingress_id: "not-a-uuid" }, { capture_id: "x/y" },
    { sha256: "nothex" }, { sha256: "AB".repeat(32) }, { byte_len: -1 },
    { byte_len: 1.5 }, { byte_len: Number.MAX_SAFE_INTEGER + 2 },
    { received_at: "yesterday" }, { received_at: "2026-10-14T09:00:00+09:00" },
    { channel: "bad channel!" }, { upstream_id_status: "maybe" as never }]) {
    no(doc, capture(1, over as Partial<IntakeEvent>), "intake_malformed");
  }
});

// --- identity and dedupe ------------------------------------------------------

test("the upstream dedupe key is scoped by channel, namespace and session scope", () => {
  const base = { channel: "codex-native", upstream_namespace: "codex/session",
    upstream_scope_sha256: hex64(1), upstream_delivery_id: "dlv-1" };
  const key = upstreamDedupeKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(upstreamDedupeKey({ ...base }), key, "the key is a pure function of its scope");
  for (const over of [{ channel: "claude-native" }, { upstream_namespace: "codex/other" },
    { upstream_scope_sha256: hex64(2) }, { upstream_delivery_id: "dlv-2" }]) {
    assert.notEqual(upstreamDedupeKey({ ...base, ...over }), key,
      `${JSON.stringify(over)} must change the key`);
  }
  // no component may be dropped from the key: a provider id alone is not an identity
  assert.notEqual(upstreamDedupeKey({ ...base, channel: "x" }),
    upstreamDedupeKey({ ...base, upstream_namespace: "x" }));
});

test("replay of the same ingress id is a no-op refusal, not a second row or a second history entry", () => {
  const doc = ok(emptyIntakeDocument(), capture(1));
  const outcome = no(doc, capture(1), "intake_replay");
  assert.equal(intakeExitCode(outcome), 8);
  assert.equal(doc.requests.length, 1);
  assert.equal(row(doc, 1).history.length, 1);
});

test("the same identity with any mismatched immutable field refuses; the stored row is authority", () => {
  const doc = ok(emptyIntakeDocument(), capture(1));
  for (const over of [{ sha256: hex64(5) }, { byte_len: 999 }, { received_at: at(99) },
    { capture_id: uuid(777) }, { channel: "claude-native" },
    { upstream_namespace: "claude/session" }]) {
    const outcome = no(doc, capture(1, over as Partial<IntakeEvent>), "intake_identity_collision");
    assert.equal(intakeExitCode(outcome), 4);
  }
});

test("an upstream delivery id is never fabricated and never synthesised", () => {
  const doc = emptyIntakeDocument();
  no(doc, capture(1, { upstream_delivery_id: "dlv-1" }), "intake_malformed");
  no(doc, capture(1, { upstream_id_status: "available" }), "intake_malformed");
  no(doc, capture(1, { upstream_id_status: "available", upstream_delivery_id: "dlv-1",
    upstream_scope_sha256: null }), "intake_malformed");
  const good = ok(doc, capture(1, { upstream_id_status: "available",
    upstream_delivery_id: "dlv-1", upstream_scope_sha256: hex64(1) }));
  assert.equal(row(good, 1).upstream_id_status, "available");
  // redelivery of an available id dedupes; the same id in another scope does not
  assert.equal(applyIntakeEvent(good, capture(2, { upstream_id_status: "available",
    upstream_delivery_id: "dlv-1", upstream_scope_sha256: hex64(1) })).result,
    "intake_upstream_duplicate");
  assert.equal(applyIntakeEvent(good, capture(2, { upstream_id_status: "available",
    upstream_delivery_id: "dlv-1", upstream_scope_sha256: hex64(2) })).result, "intake_written");
});

test("equal bytes delivered twice are two requests sharing one digest", () => {
  let doc = ok(emptyIntakeDocument(), capture(1, { sha256: hex64(7), byte_len: 7 }));
  doc = ok(doc, capture(2, { sha256: hex64(7), byte_len: 7 }));
  assert.equal(doc.requests.length, 2);
  assert.equal(new Set(doc.requests.map((r) => r.sha256)).size, 1);
  assert.deepEqual(doc.requests.map((r) => r.state), ["queued", "queued"]);
  // dedupe on content is not merely absent, it is unreachable: identical everything but the id
  assert.equal(applyIntakeEvent(doc, capture(3, { sha256: hex64(7), byte_len: 7,
    received_at: at(1) })).result, "intake_written");
});

// --- the exhaustive transition matrix ----------------------------------------

test("every state is reachable only by its authorised transition", () => {
  let doc = ok(emptyIntakeDocument(), capture(1));
  assert.equal(row(doc, 1).state, "queued");
  doc = ok(doc, { kind: "bind", at: at(2), ingress_id: uuid(1), owning_task: "1166",
    dispatch_id: uuid(11) });
  assert.equal(row(doc, 1).state, "queued", "binding is a record of an owner, not a start");
  assert.equal(row(doc, 1).work_state, "unstarted");
  doc = ok(doc, { kind: "start", at: at(3), ingress_id: uuid(1) });
  assert.equal(row(doc, 1).state, "in_progress");
  doc = ok(doc, { kind: "pause", at: at(4), ingress_id: uuid(1), reason: "dep", owner: "orch",
    resume_condition: "1172 lands", depends_on: ["1172"] });
  assert.equal(row(doc, 1).state, "waiting");
  assert.equal(row(doc, 1).work_state, "paused");
  assert.deepEqual(row(doc, 1).depends_on, ["1172"]);
  doc = ok(doc, { kind: "resume", at: at(5), ingress_id: uuid(1) });
  assert.equal(row(doc, 1).state, "in_progress", "resume returns to the state recorded at pause");
  doc = ok(doc, { kind: "work-completed", at: at(6), ingress_id: uuid(1), verdict: "accepted",
    result_ref: "dispatch/1166/u1", evidence_sha256: hex64(3) });
  assert.equal(row(doc, 1).state, "completed");
  // failed and cancelled, from their own fixtures
  const failed = ok(ok(emptyIntakeDocument(), capture(2)),
    { kind: "fail", at: at(7), ingress_id: uuid(2), reason: "evidence_missing" });
  assert.equal(row(failed, 2).state, "failed");
  const cancelled = ok(ok(emptyIntakeDocument(), capture(3)),
    { kind: "cancel", at: at(8), ingress_id: uuid(3), reason: "withdrawn" });
  assert.equal(row(cancelled, 3).state, "cancelled");
});

test("completion has exactly one cause, and acknowledgement is not it", () => {
  let doc = lifecycle();
  // an answer, even carrying a result reference, leaves state and work_state alone
  doc = ok(doc, { kind: "answered", at: at(4), ingress_id: uuid(1), verdict: "answered",
    scope: "u1", result_ref: "dispatch/1166/answer" });
  assert.equal(row(doc, 1).answered_at, at(4));
  assert.equal(row(doc, 1).state, "in_progress");
  assert.equal(row(doc, 1).work_state, "in_progress");
  assert.equal(row(doc, 1).result, null);
  assert.equal(row(doc, 1).review.length, 1);
  // a verdict without a result link, and a link without evidence, are both refused
  no(doc, { kind: "work-completed", at: at(5), ingress_id: uuid(1), verdict: "accepted" },
    "intake_malformed");
  no(doc, { kind: "work-completed", at: at(5), ingress_id: uuid(1), verdict: "accepted",
    result_ref: "r" }, "intake_malformed");
  no(doc, { kind: "work-completed", at: at(5), ingress_id: uuid(1), verdict: "answered",
    result_ref: "r", evidence_sha256: hex64(3) }, "intake_malformed");
  const done = ok(doc, { kind: "work-completed", at: at(5), ingress_id: uuid(1),
    verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) });
  assert.equal(row(done, 1).state, "completed");
  assert.equal(row(done, 1).answered_at, at(4), "the answer is still its own separate fact");
});

// R3 — review[] is the human-answer log and nothing else (ir1166bcx)
test("a work completion is recorded in result and history, never as a second review entry", () => {
  let doc = lifecycle();
  doc = ok(doc, { kind: "answered", at: at(4), ingress_id: uuid(1), verdict: "rejected",
    scope: "u1" });
  doc = ok(doc, { kind: "work-completed", at: at(5), ingress_id: uuid(1), verdict: "rejected",
    result_ref: "dispatch/1166/u1", evidence_sha256: hex64(3) });
  const done = row(doc, 1);
  // exactly one review entry, and it is the answer — a reader never has to tell two kinds apart
  assert.deepEqual(done.review, [{ at: at(4), verdict: "rejected", scope: "u1" }]);
  // the work verdict and its evidence are not lost: they are in result and in history
  assert.deepEqual(done.result,
    { verdict: "rejected", result_ref: "dispatch/1166/u1", evidence_sha256: hex64(3) });
  assert.equal(done.history.at(-1)?.event, "work-completed");
  assert.equal(done.history.at(-1)?.to, "completed");
  // the two axes stay independent: an answer of "rejected" is not the work verdict "rejected"
  assert.equal(done.answered_at, at(4));
  assert.equal(done.state, "completed");
  assert.equal(done.work_state, "completed");
  // and a completion with no prior answer leaves the answer log empty
  const unanswered = ok(lifecycle(), { kind: "work-completed", at: at(4), ingress_id: uuid(1),
    verdict: "accepted", result_ref: "r", evidence_sha256: hex64(4) });
  assert.deepEqual(row(unanswered, 1).review, [], "no answer, no review entry");
  assert.equal(row(unanswered, 1).answered_at, null);
  assert.equal(row(unanswered, 1).result?.verdict, "accepted");
});

// R2 — start clears the pause it resolves, in the same single transition (ir1166bcx)
test("start clears the pause it resolves, and a later pause is a new fact", () => {
  const paused = ok(lifecycle(), { kind: "pause", at: at(4), ingress_id: uuid(1), reason: "dep",
    owner: "orch", resume_condition: "1172 lands", depends_on: ["1172"] });
  assert.equal(row(paused, 1).state, "waiting");
  const before = row(paused, 1).history.length;
  const started = ok(paused, { kind: "start", at: at(5), ingress_id: uuid(1) });
  const row1 = row(started, 1);
  assert.equal(row1.state, "in_progress");
  assert.equal(row1.work_state, "in_progress");
  assert.equal(row1.pause, null, "start clears the pause it resolves");
  assert.deepEqual(row1.depends_on, [], "and the dependencies it was waiting on");
  assert.equal(row1.history.length, before + 1, "atomically, in ONE history transition");
  assert.equal(row1.history.at(-1)?.event, "start");
  assert.equal(row1.history.at(-1)?.from, "waiting");
  assert.equal(row1.history.at(-1)?.to, "in_progress");
  // the row is pausable again, which it was not before this correction
  const again = ok(started, { kind: "pause", at: at(6), ingress_id: uuid(1), reason: "dep2",
    owner: "orch", resume_condition: "1177 lands", depends_on: ["1177"] });
  assert.deepEqual(row(again, 1).pause, { reason: "dep2", owner: "orch",
    resume_condition: "1177 lands", resume_to: "in_progress" });
  assert.deepEqual(row(again, 1).depends_on, ["1177"]);
  // still set-once WHILE it holds: a second pause from `waiting` remains refused
  no(again, { kind: "pause", at: at(7), ingress_id: uuid(1), reason: "dep3", owner: "orch",
    resume_condition: "c" }, "intake_transition_refused");
  // from queued the clear is a no-op, so start has one behaviour and not two
  const fromQueued = ok(ok(ok(emptyIntakeDocument(), capture(2)),
    { kind: "bind", at: at(2), ingress_id: uuid(2), owning_task: "1166", dispatch_id: uuid(11) }),
  { kind: "start", at: at(3), ingress_id: uuid(2) });
  assert.equal(row(fromQueued, 2).pause, null);
  assert.deepEqual(row(fromQueued, 2).depends_on, []);
  // and binding alone still neither starts work nor clears a pause
  const boundWhilePaused = ok(paused, { kind: "bind", at: at(5), ingress_id: uuid(1),
    owning_task: "1166", dispatch_id: uuid(12) });
  assert.equal(row(boundWhilePaused, 1).state, "waiting", "bind does not start work");
  assert.notEqual(row(boundWhilePaused, 1).pause, null, "and does not clear a pause");
});

test("a bare pause is never a pause, and resume needs a recorded one", () => {
  const doc = lifecycle();
  for (const over of [{}, { reason: "busy" }, { reason: "busy", owner: "orch" },
    { reason: "busy", resume_condition: "later" }, { owner: "orch", resume_condition: "later" }]) {
    no(doc, { kind: "pause", at: at(4), ingress_id: uuid(1), ...over }, "intake_malformed");
  }
  no(doc, { kind: "resume", at: at(4), ingress_id: uuid(1) }, "intake_transition_refused");
});

test("start requires a recorded owner", () => {
  const doc = ok(emptyIntakeDocument(), capture(1));
  no(doc, { kind: "start", at: at(2), ingress_id: uuid(1) }, "intake_transition_refused");
  const bound = ok(doc, { kind: "bind", at: at(2), ingress_id: uuid(1), owning_task: "1166",
    dispatch_id: uuid(11) });
  assert.equal(applyIntakeEvent(bound, { kind: "start", at: at(3), ingress_id: uuid(1) }).result,
    "intake_written");
});

test("the whole kind x state matrix: nothing outside the table is accepted", () => {
  const sample: Record<IntakeEventKind, IntakeEvent> = {
    captured: capture(1),
    bind: { kind: "bind", at: at(50), ingress_id: uuid(1), owning_task: "1166",
      dispatch_id: uuid(11) },
    start: { kind: "start", at: at(50), ingress_id: uuid(1) },
    pause: { kind: "pause", at: at(50), ingress_id: uuid(1), reason: "r", owner: "o",
      resume_condition: "c" },
    resume: { kind: "resume", at: at(50), ingress_id: uuid(1) },
    answered: { kind: "answered", at: at(50), ingress_id: uuid(1), verdict: "answered",
      scope: "s" },
    "work-completed": { kind: "work-completed", at: at(50), ingress_id: uuid(1),
      verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) },
    fail: { kind: "fail", at: at(50), ingress_id: uuid(1), reason: "measured_failure" },
    cancel: { kind: "cancel", at: at(50), ingress_id: uuid(1), reason: "r" },
    amend: capture(2, { kind: "amend", supersedes: uuid(1) }),
  };
  // the authorised cells, from SPEC-U1 §3.3
  const allowed: Record<IntakeState, IntakeEventKind[]> = {
    queued: ["bind", "pause", "answered", "work-completed", "fail", "cancel", "amend"],
    in_progress: ["bind", "pause", "answered", "work-completed", "fail", "cancel", "amend"],
    waiting: ["bind", "start", "resume", "answered", "work-completed", "fail", "cancel", "amend"],
    completed: [],
    failed: ["cancel", "amend"],
    cancelled: [],
  };
  const fixtures: Record<IntakeState, () => IntakeDocument> = {
    queued: () => ok(emptyIntakeDocument(), capture(1)),
    in_progress: lifecycle,
    waiting: () => ok(lifecycle(), { kind: "pause", at: at(4), ingress_id: uuid(1), reason: "r",
      owner: "o", resume_condition: "c" }),
    completed: () => ok(lifecycle(), { kind: "work-completed", at: at(4), ingress_id: uuid(1),
      verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) }),
    failed: () => ok(lifecycle(), { kind: "fail", at: at(4), ingress_id: uuid(1),
      reason: "measured_failure" }),
    cancelled: () => ok(lifecycle(), { kind: "cancel", at: at(4), ingress_id: uuid(1),
      reason: "r" }),
  };
  for (const [state, build] of Object.entries(fixtures) as [IntakeState, () => IntakeDocument][]) {
    for (const kind of KINDS) {
      if (kind === "captured") continue;                 // creation, covered by the identity cases
      const doc = build();
      const outcome = applyIntakeEvent(doc, sample[kind]);
      if (allowed[state].includes(kind)) {
        assert.equal(outcome.result, "intake_written", `${state} + ${kind} must be allowed`);
        assert.equal(outcome.document?.requests[0].history.length,
          doc.requests[0].history.length + 1, `${state} + ${kind}: exactly one history append`);
      } else {
        assert.equal(outcome.result, "intake_transition_refused",
          `${state} + ${kind} must be refused`);
        assert.equal(outcome.document, null);
      }
    }
  }
});

test("no event exists for idleness, cleanup, liveness, a receipt or a transport result", () => {
  const doc = lifecycle();
  for (const kind of ["idle", "cleanup", "cleaned", "session_end", "worker_exit", "reap",
    "notice", "transport_rc", "turn_end", "receipt", "liveness", "complete", "retire",
    "cutover_retired", "superseded"]) {
    const outcome = applyIntakeEvent(doc, { kind, at: at(9), ingress_id: uuid(1) } as
      unknown as IntakeEvent);
    assert.equal(outcome.result, "invalid_argument", `${kind} must not be an intake event`);
    assert.equal(outcome.document, null);
  }
  assert.deepEqual(KINDS.filter((k) => !["captured", "bind", "start", "pause", "resume",
    "answered", "work-completed", "fail", "cancel", "amend"].includes(k)), [],
  "the kind set is exactly the ten authorised events");
});

test("an event for an unknown request is never a creation", () => {
  const doc = ok(emptyIntakeDocument(), capture(1));
  for (const kind of KINDS) {
    if (kind === "captured" || kind === "amend") continue;
    no(doc, { kind, at: at(9), ingress_id: uuid(99), owning_task: "1166", dispatch_id: uuid(11),
      reason: "measured_failure", owner: "o", resume_condition: "c", verdict: "accepted",
      scope: "s", result_ref: "r", evidence_sha256: hex64(3) } as IntakeEvent,
    "intake_not_found");
  }
});

test("no field is ever rewritten in place; set-once fields refuse a second write", () => {
  let doc = lifecycle();
  const first = JSON.parse(JSON.stringify(row(doc, 1))) as IntakeRequest;
  doc = ok(doc, { kind: "answered", at: at(4), ingress_id: uuid(1), verdict: "answered",
    scope: "u1" });
  no(doc, { kind: "answered", at: at(5), ingress_id: uuid(1), verdict: "rejected", scope: "u1" },
    "intake_transition_refused");
  // the immutable prefix of history and every immutable field survived the transition
  const now = row(doc, 1);
  assert.deepEqual(now.history.slice(0, first.history.length), first.history);
  for (const key of ["ingress_id", "capture_id", "channel", "upstream_namespace", "sha256",
    "byte_len", "received_at", "upstream_id_status"] as (keyof IntakeRequest)[]) {
    assert.deepEqual(now[key], first[key], `${String(key)} is immutable`);
  }
  // pause, result and failure are each set once
  const paused = ok(lifecycle(), { kind: "pause", at: at(4), ingress_id: uuid(1), reason: "r",
    owner: "o", resume_condition: "c" });
  no(paused, { kind: "pause", at: at(5), ingress_id: uuid(1), reason: "r2", owner: "o",
    resume_condition: "c" }, "intake_transition_refused");
  const done = ok(lifecycle(), { kind: "work-completed", at: at(4), ingress_id: uuid(1),
    verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) });
  no(done, { kind: "work-completed", at: at(5), ingress_id: uuid(1), verdict: "accepted",
    result_ref: "r2", evidence_sha256: hex64(4) }, "intake_transition_refused");
});

test("cancellation is scope-exact and is never a completion", () => {
  let doc = ok(ok(emptyIntakeDocument(), capture(1)), capture(2));
  const sibling = JSON.parse(JSON.stringify(row(doc, 2))) as IntakeRequest;
  doc = ok(doc, { kind: "cancel", at: at(3), ingress_id: uuid(1), reason: "urgent stop" });
  assert.equal(row(doc, 1).state, "cancelled");
  assert.equal(row(doc, 1).work_state, "cancelled");
  assert.notEqual(row(doc, 1).state, "completed");
  assert.equal(row(doc, 1).result, null, "a cancellation never fills a completion result");
  assert.deepEqual(row(doc, 2), sibling, "only the named row changes");
  // a completion is not a cancellation either
  const done = ok(lifecycle(), { kind: "work-completed", at: at(4), ingress_id: uuid(1),
    verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) });
  assert.equal(row(done, 1).state, "completed");
  assert.notEqual(row(done, 1).state, "cancelled");
});

test("amendment preserves the original verbatim and links both ways", () => {
  const doc = ok(emptyIntakeDocument(), capture(1));
  const original = JSON.parse(JSON.stringify(row(doc, 1))) as IntakeRequest;
  const amended = ok(doc, capture(2, { kind: "amend", supersedes: uuid(1) }));
  const was = row(amended, 1);
  assert.equal(was.superseded_by, uuid(2));
  assert.equal(was.state, original.state, "supersession is not a state change");
  assert.deepEqual(was.history.slice(0, 1), original.history.slice(0, 1));
  assert.equal(was.history.length, 2, "the supersession itself is one appended history entry");
  for (const key of ["sha256", "byte_len", "received_at", "capture_id"] as (keyof IntakeRequest)[]) {
    assert.deepEqual(was[key], original[key], `${String(key)} preserved verbatim`);
  }
  assert.equal(row(amended, 2).supersedes, uuid(1));
  assert.equal(row(amended, 2).state, "queued");
  assert.equal(row(amended, 2).superseded_by, null);
  // a second amendment of the same row refuses rather than relinking
  no(amended, capture(3, { kind: "amend", supersedes: uuid(1) }), "intake_transition_refused");
  // amending an unknown row, or amending with a colliding identity, both refuse
  no(amended, capture(4, { kind: "amend", supersedes: uuid(99) }), "intake_not_found");
  no(amended, capture(2, { kind: "amend", supersedes: uuid(2) }), "intake_replay");
});

// --- FIFO ---------------------------------------------------------------------

test("position is receipt order over open rows, derived and labelled", () => {
  let doc = ok(emptyIntakeDocument(), capture(3, { received_at: at(30) }));
  doc = ok(doc, capture(1, { received_at: at(10) }));
  doc = ok(doc, capture(2, { received_at: at(20) }));
  const positions = derivePositions(doc);
  assert.deepEqual(positions.map((r) => [r.ingress_id, r.position]),
    [[uuid(1), 1], [uuid(2), 2], [uuid(3), 3]]);
  assert.equal(doc.requests.some((r) => "position" in r), false, "position is never stored");
  // ties on received_at break on ingress_id, deterministically and in both insertion orders
  const tie = ok(ok(emptyIntakeDocument(), capture(5, { received_at: at(10) })),
    capture(4, { received_at: at(10) }));
  assert.deepEqual(derivePositions(tie).map((r) => r.ingress_id), [uuid(4), uuid(5)]);
  // closed and superseded rows hold no position; the open ones renumber without reordering
  let closing = ok(doc, { kind: "cancel", at: at(40), ingress_id: uuid(1), reason: "withdrawn" });
  closing = ok(closing, { kind: "work-completed", at: at(41), ingress_id: uuid(2),
    verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) });
  closing = ok(closing, capture(6, { kind: "amend", supersedes: uuid(3), received_at: at(50) }));
  const after = derivePositions(closing);
  assert.deepEqual(after.filter((r) => r.position !== null).map((r) => [r.ingress_id, r.position]),
    [[uuid(6), 1]]);
  for (const id of [uuid(1), uuid(2), uuid(3)]) {
    assert.equal(after.find((r) => r.ingress_id === id)?.position, null, id);
  }
  // a failed or waiting row keeps its position: it is still owed work
  const failed = ok(ok(emptyIntakeDocument(), capture(1)),
    { kind: "fail", at: at(2), ingress_id: uuid(1), reason: "evidence_missing" });
  assert.equal(derivePositions(failed)[0].position, 1);
});

// --- prune --------------------------------------------------------------------

test("prune archives only an aged closed row, and never anything else", () => {
  let doc = ok(emptyIntakeDocument(), capture(1));
  doc = ok(doc, { kind: "cancel", at: at(2), ingress_id: uuid(1), reason: "withdrawn" });
  doc = ok(doc, capture(2));
  doc = ok(doc, { kind: "work-completed", at: at(4), ingress_id: uuid(2), verdict: "accepted",
    result_ref: "r", evidence_sha256: hex64(3) });
  doc = ok(doc, capture(3));
  doc = ok(doc, { kind: "fail", at: at(6), ingress_id: uuid(3), reason: "evidence_missing" });
  doc = ok(doc, capture(4));
  const far = at(60 * 24 * 365);
  const plan = prunePlan(doc, { now: far, olderThanSeconds: 86400 });
  assert.deepEqual(plan.archive.map((r) => r.ingress_id).sort(), [uuid(1), uuid(2)]);
  assert.deepEqual(plan.keep.map((r) => r.ingress_id).sort(), [uuid(3), uuid(4)]);
  assert.equal(plan.archive.length + plan.keep.length, doc.requests.length,
    "every row is either archived or kept; none is dropped");
  // not yet aged: nothing is archived
  assert.deepEqual(prunePlan(doc, { now: at(7), olderThanSeconds: 86400 }).archive, []);
  // no age ever prunes an open or failed row
  for (const seconds of [0, 1, 86400]) {
    const p = prunePlan(doc, { now: far, olderThanSeconds: seconds });
    assert.deepEqual(p.archive.map((r) => r.state).sort(), ["cancelled", "completed"],
      `olderThanSeconds=${seconds}`);
    assert.deepEqual(p.keep.map((r) => r.state).sort(), ["failed", "queued"]);
  }
});

// R1 — supersession is not a retention rule, and it is not a prune rule either (ir1166bcx)
test("supersession does not decide prune: open superseded is kept, closed superseded is archived", () => {
  const far = at(60 * 24 * 365);
  // open + superseded -> kept at any age, by the closed test alone
  let open = ok(emptyIntakeDocument(), capture(1));
  open = ok(open, capture(2, { kind: "amend", supersedes: uuid(1) }));
  assert.equal(row(open, 1).superseded_by, uuid(2));
  for (const seconds of [0, 1, 86400]) {
    const plan = prunePlan(open, { now: far, olderThanSeconds: seconds });
    assert.deepEqual(plan.archive, [], `open superseded must be kept (olderThanSeconds=${seconds})`);
    assert.equal(plan.keep.length, 2);
  }
  // the exact counterexample: capture A, amend B superseding A, cancel A, cutoff 0
  let closed = ok(emptyIntakeDocument(), capture(1));
  closed = ok(closed, capture(2, { kind: "amend", supersedes: uuid(1) }));
  closed = ok(closed, { kind: "cancel", at: at(3), ingress_id: uuid(1), reason: "withdrawn" });
  const plan = prunePlan(closed, { now: far, olderThanSeconds: 0 });
  assert.deepEqual(plan.archive.map((r) => r.ingress_id), [uuid(1)],
    "a cancelled row is finished work whether or not it was superseded");
  assert.deepEqual(plan.keep.map((r) => r.ingress_id), [uuid(2)]);
  // the same for a completed superseded row. The reachable order is amend THEN complete: `amend`
  // is not authorised from `completed`, so a completed row can never acquire a supersession later.
  let completed = ok(emptyIntakeDocument(), capture(1));
  completed = ok(completed, capture(2, { kind: "amend", supersedes: uuid(1) }));
  completed = ok(completed, { kind: "work-completed", at: at(3), ingress_id: uuid(1),
    verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) });
  assert.equal(row(completed, 1).state, "completed");
  assert.equal(row(completed, 1).superseded_by, uuid(2));
  assert.deepEqual(prunePlan(completed, { now: far, olderThanSeconds: 0 })
    .archive.map((r) => r.ingress_id), [uuid(1)]);
  no(completed, capture(3, { kind: "amend", supersedes: uuid(1) }),
    "intake_transition_refused");
  // and FIFO still excludes a superseded row, which is where that rule belongs
  assert.equal(derivePositions(closed).find((r) => r.ingress_id === uuid(1))?.position, null);
  assert.equal(derivePositions(open).find((r) => r.ingress_id === uuid(1))?.position, null);
  assert.equal(derivePositions(open).find((r) => r.ingress_id === uuid(2))?.position, 1);
});

test("an archived request is refused, never resurrected", () => {
  const doc = ok(emptyIntakeDocument(), capture(1));
  const outcome = applyIntakeEvent({ ...doc, requests: [] }, capture(1),
    { archived: [uuid(1)] });
  assert.equal(outcome.result, "intake_archived");
  assert.equal(intakeExitCode(outcome), 8);
  assert.equal(outcome.document, null);
  // an unprovable archive scan fails closed rather than admitting the capture
  const unbounded = applyIntakeEvent({ ...doc, requests: [] }, capture(2),
    { archived: [], archiveScanComplete: false });
  assert.equal(unbounded.result, "intake_archive_unbounded");
  assert.equal(intakeExitCode(unbounded), 9);
  assert.equal(unbounded.document, null);
  // a scan that completed and found nothing admits it
  assert.equal(applyIntakeEvent({ ...doc, requests: [] }, capture(2),
    { archived: [uuid(1)], archiveScanComplete: true }).result, "intake_written");
});

// --- exit mapping -------------------------------------------------------------

test("results map onto the shipped exit codes, and nothing invents a new one", () => {
  const expected: Record<string, number> = {
    intake_written: 0,
    invalid_argument: 4,
    intake_malformed: 4,
    intake_transition_refused: 4,
    intake_identity_collision: 4,
    intake_bounds_exceeded: 4,
    intake_not_found: 4,
    intake_replay: 8,
    intake_upstream_duplicate: 8,
    intake_archived: 8,
    intake_archive_unbounded: 9,
    registry_corrupt: 9,
  };
  for (const [result, code] of Object.entries(expected)) {
    assert.equal(intakeExitCode({ result, document: null } as IntakeOutcome), code, result);
  }
  assert.deepEqual([...new Set(Object.values(expected))].sort(), [0, 4, 8, 9]);
});

// Notice controls are appended; every original lifecycle/oracle byte above is retained.
import { applyIntakeNotice, intakeNoticeId, type IntakeNoticeEvent,
  type IntakeNoticeRecord } from "../../src/request-capture/intake.js";

function noticeClaimEvent(attempt = 1): IntakeNoticeEvent {
  return { action: "claim", ingress_id: uuid(1), notice_id: intakeNoticeId(uuid(1)),
    attempt, claim: `claim_${attempt}`, owner: "owner_1", at: at(attempt * 10),
    previous_attempt: attempt - 1, previous_claim: attempt === 1 ? null : `claim_${attempt - 1}` };
}
function noticeFact(action: "result" | "resolve" | "ack", attempt = 1,
  status: "unknown" | "not_sent" | "sent" = "sent"): IntakeNoticeEvent {
  const common = { ingress_id: uuid(1), notice_id: intakeNoticeId(uuid(1)), attempt,
    claim: `claim_${attempt}`, owner: "owner_1", at: at(attempt * 10 + (action === "result" ? 1 : 2)),
    evidence_sha256: hex64(attempt) };
  if (action === "ack") return { ...common, action };
  if (action === "resolve" && status === "unknown") throw Error("invalid fixture");
  return { ...common, action, status, retry_at: status === "not_sent" ? at(attempt * 10 + 3) : null } as IntakeNoticeEvent;
}
function noticeStep(doc: IntakeDocument, event: IntakeNoticeEvent,
  result = "intake_written"): IntakeDocument {
  const before = JSON.stringify(doc), outcome = applyIntakeNotice(doc, event);
  assert.equal(outcome.result, result, outcome.detail);
  assert.equal(JSON.stringify(doc), before, "pure input never mutated");
  if (result !== "intake_written") { assert.equal(outcome.document, null); return doc; }
  assert.ok(outcome.document);
  assert.equal(outcome.document.generation, doc.generation);
  const { notice: _beforeNotice, ...beforeRow } = row(doc, 1);
  const { notice: _afterNotice, ...afterRow } = row(outcome.document, 1);
  assert.deepEqual(afterRow, beforeRow, "transport facts change no lifecycle field");
  assert.deepEqual((row(outcome.document, 1).notice as IntakeNoticeRecord).events.slice(0, -1),
    (row(doc, 1).notice as IntakeNoticeRecord | null)?.events ?? [], "evidence prefix retained");
  return outcome.document;
}

test("N-CLAIM deterministic identity, exact replay, competing owner and reserved token", () => {
  let doc = ok(emptyIntakeDocument(), capture(1));
  assert.equal(intakeNoticeId(uuid(1)), intakeNoticeId(uuid(1)));
  assert.notEqual(intakeNoticeId(uuid(1)), intakeNoticeId(uuid(2)));
  const claim = noticeClaimEvent();
  noticeStep(doc, { ...claim, claim: "none" }, "intake_malformed");
  noticeStep(doc, { ...claim, claim: "claim\n" }, "intake_malformed");
  noticeStep(doc, { ...claim, notice_id: hex64(4) }, "intake_identity_collision");
  doc = noticeStep(doc, claim);
  noticeStep(doc, { ...claim }, "intake_notice_replay");
  noticeStep(doc, { ...claim, claim: "other", owner: "other" }, "intake_notice_race");
  noticeStep(doc, { ...noticeClaimEvent(2), at: at(10000) }, "intake_transition_refused");
  noticeStep(doc, { ...noticeFact("result"), owner: "other" }, "intake_transition_refused");
  assert.equal(intakeExitCode({ result: "intake_notice_replay" }), 8);
  assert.equal(intakeExitCode({ result: "intake_notice_race" }), 8);
});

test("N-UNKNOWN measured resolution alone enables retry with same identity and new attempt", () => {
  let doc = noticeStep(ok(emptyIntakeDocument(), capture(1)), noticeClaimEvent());
  doc = noticeStep(doc, noticeFact("result", 1, "unknown"));
  noticeStep(doc, { ...noticeClaimEvent(2), at: at(10000) }, "intake_transition_refused");
  noticeStep(doc, noticeFact("result", 1, "not_sent"), "intake_transition_refused");
  doc = noticeStep(doc, noticeFact("resolve", 1, "not_sent"));
  noticeStep(doc, { ...noticeClaimEvent(2), at: at(12) }, "intake_transition_refused");
  doc = noticeStep(doc, noticeClaimEvent(2));
  noticeStep(doc, noticeFact("result", 1, "sent"), "intake_transition_refused");
  doc = noticeStep(doc, noticeFact("result", 2, "sent"));
  noticeStep(doc, noticeClaimEvent(3), "intake_transition_refused");
  doc = noticeStep(doc, noticeFact("ack", 2));
  noticeStep(doc, noticeFact("ack", 2), "intake_notice_replay");
  noticeStep(doc, { ...noticeFact("ack", 2), evidence_sha256: hex64(9) }, "intake_transition_refused");
  assert.equal(row(doc, 1).answered_at, null);
  assert.equal(row(doc, 1).state, "queued");
});

test("N-RACE paused/cancelled claims refuse, issued results persist without re-enabling work", () => {
  const fresh = ok(emptyIntakeDocument(), capture(1));
  const pause: IntakeEvent = { kind: "pause", ingress_id: uuid(1), at: at(11),
    reason: "blocked", owner: "owner", resume_condition: "review" };
  noticeStep(ok(fresh, pause), noticeClaimEvent(), "intake_transition_refused");
  for (const event of [pause, { kind: "cancel", ingress_id: uuid(1), at: at(11), reason: "cancelled" } as IntakeEvent]) {
    let doc = ok(noticeStep(fresh, noticeClaimEvent()), event);
    noticeStep(doc, noticeFact("ack"), "intake_transition_refused");
    doc = noticeStep(doc, noticeFact("result"));
    noticeStep(doc, noticeFact("ack"));
  }
  const closed = ok(fresh, { kind: "cancel", ingress_id: uuid(1), at: at(12), reason: "cancelled" });
  noticeStep(closed, noticeClaimEvent(), "intake_transition_refused");
  noticeStep(emptyIntakeDocument(), noticeClaimEvent(), "intake_not_found");
});

test("N-VALIDATION malformed new logs fail closed and legacy unknown claims cannot be stolen", () => {
  const fresh = ok(emptyIntakeDocument(), capture(1));
  row(fresh, 1).notice = { claim: "none", owner: "legacy", at: "legacy" };
  assert.equal(validateIntakeDocument(fresh).result, "ok");
  noticeStep(fresh, noticeClaimEvent(), "intake_transition_refused");
  const doc = noticeStep(ok(emptyIntakeDocument(), capture(1)), noticeClaimEvent());
  const valid = row(doc, 1).notice as IntakeNoticeRecord;
  for (const bad of [{ ...valid, generation: 2 }, { ...valid, version: true },
    { ...valid, notice_id: hex64(9) }, { ...valid, path: "/tmp" },
    { ...valid, events: Array(65).fill(noticeClaimEvent()) },
    { ...valid, events: [{ ...noticeClaimEvent(), attempt: true }] },
    { ...valid, events: [{ ...noticeClaimEvent(), at: "2026-02-30T00:00:00Z" }] },
    { ...valid, events: [{ ...noticeClaimEvent(), claim: "none" }] }]) {
    const broken = structuredClone(doc); row(broken, 1).notice = bad as unknown as IntakeNoticeRecord;
    noticeStep(broken, noticeFact("result"), "registry_corrupt");
  }
  for (const over of [{ at: "2026-02-30T00:00:00Z" }, { attempt: 1.5 }, { attempt: true },
    { owner: "../path" }, { evidence_sha256: "oops" }, { retry_at: at(1) }, { command: "run" }]) {
    noticeStep(doc, { ...noticeFact("result"), ...over } as unknown as IntakeNoticeEvent, "intake_malformed");
  }
});

test("N-BOUND attempt evidence is retained at exhaustion instead of pruned", () => {
  let doc = ok(emptyIntakeDocument(), capture(1));
  for (let attempt = 1; attempt <= 16; attempt++) {
    doc = noticeStep(doc, noticeClaimEvent(attempt));
    doc = noticeStep(doc, noticeFact("result", attempt, "not_sent"));
  }
  noticeStep(doc, noticeClaimEvent(17), "intake_bounds_exceeded");
  assert.equal((row(doc, 1).notice as IntakeNoticeRecord).events.length, 32);
});
