import { createHash } from "node:crypto";

// Durable request intake ledger — the pure decision core (#1166 U1).
//
// This module decides what a write MEANS. It never performs one: no fs, no child process, no
// clock, no randomness, no environment. `bin/dispatch-registry.py` is the only writer, holds the
// intake lock and mirrors these decisions; `tests/request-capture/intake-registry.test.mjs`
// R-DIFF replays one event sequence through both and asserts the documents are equal, so the two
// implementations cannot drift silently.
//
// Four facts stay apart, by construction and not by convention:
//
//   transport      a delivery, an inject rc, a notice, a screen — NONE of them is an event here
//   binding        an owner was recorded. Not a grant, not a start, not a completion
//   answered       a human reviewed and answered. NOT the requested implementation being done
//   work-completed an explicit verdict AND a result link AND evidence. The only completion
//
// The ledger records; it never schedules. `position` is receipt order, derived on read, and is
// explicitly not commit order and not execution order. The document stores identifiers and
// measurements only: no prompt text, no excerpt, no receipt metadata value, no filename, no path
// and no command — enforced by `INTAKE_FORBIDDEN_KEYS` in the validator rather than by habit,
// because a record field that became a path would invalidate the accepted `state_dir()` waiver
// in the Python writer (`bin/dispatch-registry.py:142-146`).

export const INTAKE_SCHEMA_VERSION = 1;

/** Receipt order. Never commit order, never execution order (cf. `inventory.ts:36`). */
export const INTAKE_ORDER_LABEL = "received-at-then-ingress-id-not-commit-not-execution";

export type IntakeState =
  | "queued" | "in_progress" | "waiting" | "completed" | "failed" | "cancelled";

/** The work axis, rendered beside `answered` and never merged with it. */
export type IntakeWorkState =
  | "unstarted" | "in_progress" | "paused" | "completed" | "failed" | "cancelled";

export type IntakeEventKind =
  | "captured" | "bind" | "start" | "pause" | "resume" | "answered" | "work-completed"
  | "fail" | "cancel" | "amend";

export type UpstreamIdStatus = "available" | "unavailable";
export type IntakeAnswerVerdict = "answered" | "rejected" | "rework";
export type IntakeWorkVerdict = "accepted" | "rejected";
export type IntakeFailureReason = "evidence_missing" | "evidence_corrupt" | "measured_failure";

export type IntakeResultCode =
  | "intake_written"
  | "invalid_argument" | "intake_malformed" | "intake_transition_refused"
  | "intake_identity_collision" | "intake_bounds_exceeded" | "intake_not_found"
  | "intake_replay" | "intake_upstream_duplicate" | "intake_archived"
  | "intake_notice_replay" | "intake_notice_race"
  | "intake_archive_unbounded" | "registry_corrupt";

export interface IntakeHistoryEntry {
  at: string;
  event: IntakeEventKind;
  from: IntakeState | null;
  to: IntakeState;
  /** Only a cancellation carries one: it has nowhere else to be preserved. */
  reason?: string;
}

export interface IntakePause {
  reason: string;
  owner: string;
  resume_condition: string;
  resume_to: IntakeState;
}

export interface IntakeResultLink {
  verdict: IntakeWorkVerdict;
  result_ref: string;
  evidence_sha256: string;
}

export interface IntakeFailure {
  at: string;
  reason: IntakeFailureReason;
}

/**
 * A human answer, and only that. A work completion does NOT appear here: its verdict and
 * evidence live in `result` and in the appended history entry (ir1166bcx R3), so `review` can be
 * read as the answer log without having to tell two kinds of entry apart.
 */
export interface IntakeReview {
  at: string;
  verdict: IntakeAnswerVerdict;
  scope: string;
}

export interface IntakeBinding {
  at: string;
  owning_task: string;
  dispatch_id: string;
}

export interface IntakeRevision {
  at: string;
  kind: "amends" | "superseded_by";
  revision: string;
}

/** Legacy ownership has unknown outcome and is never reclaimed by this slice. */
export interface IntakeNotice {
  claim: string;
  owner: string;
  at: string;
}

interface IntakeNoticeCommon {
  action: "claim" | "result" | "resolve" | "ack";
  ingress_id: string;
  notice_id: string;
  attempt: number;
  claim: string;
  owner: string;
  at: string;
}

export type IntakeNoticeEvent = IntakeNoticeCommon & (
  | { action: "claim"; previous_attempt: number; previous_claim: string | null }
  | { action: "result"; status: "unknown" | "not_sent" | "sent";
      evidence_sha256: string; retry_at: string | null }
  | { action: "resolve"; status: "not_sent" | "sent";
      evidence_sha256: string; retry_at: string | null }
  | { action: "ack"; evidence_sha256: string }
);

export interface IntakeNoticeRecord {
  version: 1;
  notice_id: string;
  generation: 1;
  events: IntakeNoticeEvent[];
}

export interface IntakeRequest {
  ingress_id: string;
  capture_id: string;
  channel: string;
  upstream_namespace: string;
  upstream_delivery_id: string | null;
  upstream_id_status: UpstreamIdStatus;
  upstream_scope_sha256: string | null;
  sha256: string;
  byte_len: number;
  received_at: string;
  state: IntakeState;
  work_state: IntakeWorkState;
  answered_at: string | null;
  owning_task: string | null;
  bound_dispatch_ids: string[];
  depends_on: string[];
  pause: IntakePause | null;
  result: IntakeResultLink | null;
  failure: IntakeFailure | null;
  supersedes: string | null;
  superseded_by: string | null;
  revisions: IntakeRevision[];
  review: IntakeReview[];
  binding: IntakeBinding[];
  notice: IntakeNotice | IntakeNoticeRecord | null;
  last_event_at: string;
  history: IntakeHistoryEntry[];
}

export interface IntakeDocument {
  schema_version: number;
  generation: number;
  requests: IntakeRequest[];
}

export interface IntakeEvent {
  kind: IntakeEventKind;
  at: string;
  ingress_id: string;
  capture_id?: string;
  channel?: string;
  upstream_namespace?: string;
  upstream_delivery_id?: string | null;
  upstream_id_status?: UpstreamIdStatus;
  upstream_scope_sha256?: string | null;
  sha256?: string;
  byte_len?: number;
  received_at?: string;
  owning_task?: string;
  dispatch_id?: string;
  verdict?: string;
  scope?: string;
  result_ref?: string;
  evidence_sha256?: string;
  reason?: string;
  owner?: string;
  resume_condition?: string;
  depends_on?: string[];
  supersedes?: string;
}

export interface IntakeOutcome {
  result: IntakeResultCode;
  document: IntakeDocument | null;
  detail?: string;
}

/**
 * What the caller knows about the archive. `archiveScanComplete: false` means non-resurrection
 * could not be proven within the scan bound, which is a refusal and never an admission.
 */
export interface IntakeContext {
  archived?: readonly string[];
  archiveScanComplete?: boolean;
}

export interface IntakePruneOptions {
  now: string;
  olderThanSeconds: number;
}

export interface IntakePrunePlan {
  archive: IntakeRequest[];
  keep: IntakeRequest[];
}

export const INTAKE_BOUNDS = {
  max_rows: 4096,
  max_history: 256,
  max_revisions: 64,
  max_review: 64,
  max_binding: 64,
  max_depends_on: 32,
  max_id_chars: 128,
  max_text_chars: 256,
  max_result_ref_chars: 512,
  max_byte_len: Number.MAX_SAFE_INTEGER,
} as const;

/**
 * Keys that would turn the ledger into a second copy of the prompt, or a record field into a
 * path or a command. Refused by the validator, so a later caller cannot smuggle one in.
 */
export const INTAKE_FORBIDDEN_KEYS: readonly string[] = [
  "argv", "attachment", "attachments", "body", "command", "content", "cwd", "env", "excerpt",
  "file", "filename", "metadata", "original", "original_text", "path", "prompt", "raw",
  "raw_ref", "script", "shell", "text", "original_ref",
];

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const NAMESPACE = /^[a-z0-9][a-z0-9._/-]*$/;
const REFERENCE = /^[A-Za-z0-9._:/-]+$/;
const TOKEN = /^[A-Za-z0-9._:-]+$/;
const TEXT = /^[^\u0000-\u001f\u007f]+$/;

const STATES: readonly IntakeState[] = [
  "queued", "in_progress", "waiting", "completed", "failed", "cancelled",
];
const KINDS: readonly IntakeEventKind[] = [
  "captured", "bind", "start", "pause", "resume", "answered", "work-completed", "fail",
  "cancel", "amend",
];
const ANSWER_VERDICTS: readonly string[] = ["answered", "rejected", "rework"];
const WORK_VERDICTS: readonly string[] = ["accepted", "rejected"];
const FAILURE_REASONS: readonly string[] = [
  "evidence_missing", "evidence_corrupt", "measured_failure",
];

/** The exhaustive transition table of SPEC-U1 §3.3. Absence is a refusal. */
const TRANSITIONS: Record<IntakeEventKind, readonly IntakeState[]> = {
  captured: [],
  bind: ["queued", "in_progress", "waiting"],
  start: ["queued", "waiting"],
  pause: ["queued", "in_progress"],
  resume: ["waiting"],
  answered: ["queued", "in_progress", "waiting"],
  "work-completed": ["queued", "in_progress", "waiting"],
  fail: ["queued", "in_progress", "waiting"],
  cancel: ["queued", "in_progress", "waiting", "failed"],
  amend: ["queued", "in_progress", "waiting", "failed"],
};

const EXIT_CODES: Record<IntakeResultCode, number> = {
  intake_written: 0,
  invalid_argument: 4,
  intake_malformed: 4,
  intake_transition_refused: 4,
  intake_identity_collision: 4,
  intake_bounds_exceeded: 4,
  intake_not_found: 4,
  intake_replay: 8,
  intake_notice_replay: 8,
  intake_notice_race: 8,
  intake_upstream_duplicate: 8,
  intake_archived: 8,
  intake_archive_unbounded: 9,
  registry_corrupt: 9,
};

/** The shipped registry exit vocabulary (`bin/dispatch-registry.py:30-31`); nothing new. */
export function intakeExitCode(outcome: Pick<IntakeOutcome, "result">): number {
  return EXIT_CODES[outcome.result] ?? 9;
}

export function emptyIntakeDocument(): IntakeDocument {
  return { schema_version: INTAKE_SCHEMA_VERSION, generation: 0, requests: [] };
}

/**
 * Channel + namespace + provider/session scope + the provider id. Every component is mandatory,
 * so the same provider id from two channels, providers or sessions can never collide
 * (`CONTROLLER.md`: the dedupe key MUST include channel/provider/session scope).
 */
export function upstreamDedupeKey(scope: {
  channel: string;
  upstream_namespace: string;
  upstream_scope_sha256: string | null;
  upstream_delivery_id: string | null;
}): string {
  return createHash("sha256").update([
    scope.channel, scope.upstream_namespace, scope.upstream_scope_sha256 ?? "",
    scope.upstream_delivery_id ?? "",
  ].join("\u0000"), "utf8").digest("hex");
}

function corrupt(detail: string): { result: "registry_corrupt"; detail: string } {
  return { result: "registry_corrupt", detail };
}

/** Fail closed: a malformed ledger is reported, never repaired and never partially read. */
export function validateIntakeDocument(
  doc: unknown,
): { result: "ok" } | { result: "registry_corrupt"; detail: string } {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return corrupt("intake root is not an object");
  }
  const record = doc as Record<string, unknown>;
  if (record.schema_version !== INTAKE_SCHEMA_VERSION) {
    return corrupt(`schema_version=${JSON.stringify(record.schema_version)}, `
      + `want ${INTAKE_SCHEMA_VERSION}`);
  }
  if (typeof record.generation !== "number" || !Number.isInteger(record.generation)) {
    return corrupt("generation is not an integer");
  }
  if (!Array.isArray(record.requests)) return corrupt("requests is not an array");
  const seen = new Set<string>();
  for (const row of record.requests) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return corrupt("intake record is not an object");
    }
    const fields = row as Record<string, unknown>;
    const id = fields.ingress_id;
    if (typeof id !== "string" || !UUID4.test(id)) {
      return corrupt(`invalid ingress_id ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) return corrupt(`duplicate ingress_id ${JSON.stringify(id)}`);
    seen.add(id);
    if (!validIntakeNotice(fields.notice, id)) return corrupt(`${id}: invalid notice`);
    for (const key of INTAKE_FORBIDDEN_KEYS) {
      if (key in fields) {
        return corrupt(`${id}: forbidden field ${JSON.stringify(key)}; the intake ledger stores `
          + "identifiers and measurements only");
      }
    }
    if (typeof fields.state !== "string" || !STATES.includes(fields.state as IntakeState)) {
      return corrupt(`${id}: invalid state ${JSON.stringify(fields.state)}`);
    }
    for (const key of ["history", "review", "binding", "revisions", "depends_on",
      "bound_dispatch_ids"]) {
      if (!Array.isArray(fields[key])) return corrupt(`${id}: ${key} is not an array`);
    }
  }
  return { result: "ok" };
}

function refuse(result: IntakeResultCode, detail: string): IntakeOutcome {
  return { result, document: null, detail };
}

function textField(
  value: unknown, name: string, max: number, pattern: RegExp,
): IntakeOutcome | string {
  if (typeof value !== "string" || value.length === 0) {
    return refuse("intake_malformed", `${name} is required`);
  }
  // Length is checked first: an over-long but otherwise well-shaped value is a bound, not a shape.
  if (value.length > max) {
    return refuse("intake_bounds_exceeded", `${name} exceeds ${max} characters`);
  }
  if (!pattern.test(value)) return refuse("intake_malformed", `${name} is malformed`);
  return value;
}

const isRefusal = (value: unknown): value is IntakeOutcome =>
  typeof value === "object" && value !== null && "result" in (value as object);

interface Immutable {
  ingress_id: string;
  capture_id: string;
  channel: string;
  upstream_namespace: string;
  upstream_delivery_id: string | null;
  upstream_id_status: UpstreamIdStatus;
  upstream_scope_sha256: string | null;
  sha256: string;
  byte_len: number;
  received_at: string;
}

/** The identity and measurement set of a delivery. Fabrication is refused in both directions. */
function immutableFields(event: IntakeEvent): IntakeOutcome | Immutable {
  const captureId = textField(event.capture_id, "capture-id", INTAKE_BOUNDS.max_id_chars, UUID4);
  if (isRefusal(captureId)) return captureId;
  const channel = textField(event.channel, "channel", INTAKE_BOUNDS.max_id_chars, NAME);
  if (isRefusal(channel)) return channel;
  const namespace = textField(event.upstream_namespace, "upstream-namespace",
    INTAKE_BOUNDS.max_id_chars, NAMESPACE);
  if (isRefusal(namespace)) return namespace;
  const digest = textField(event.sha256, "sha256", 64, HEX64);
  if (isRefusal(digest)) return digest;
  const receivedAt = textField(event.received_at, "received-at", 32, RFC3339_Z);
  if (isRefusal(receivedAt)) return receivedAt;
  const byteLen = event.byte_len;
  if (typeof byteLen !== "number" || !Number.isInteger(byteLen) || byteLen < 0
    || byteLen > INTAKE_BOUNDS.max_byte_len) {
    return refuse("intake_malformed", "byte-len must be a non-negative safe integer");
  }
  const status = event.upstream_id_status;
  if (status !== "available" && status !== "unavailable") {
    return refuse("intake_malformed", "upstream-id-status must be available or unavailable");
  }
  const deliveryId = event.upstream_delivery_id ?? null;
  const scope = event.upstream_scope_sha256 ?? null;
  // No identity is ever invented, and no claim of one is ever left unbacked.
  if (status === "unavailable" && deliveryId !== null) {
    return refuse("intake_malformed",
      "upstream-delivery-id is present but upstream-id-status is unavailable; "
      + "an upstream identity is never fabricated");
  }
  if (status === "available") {
    const checked = textField(deliveryId, "upstream-delivery-id", INTAKE_BOUNDS.max_id_chars,
      TOKEN);
    if (isRefusal(checked)) return checked;
    const checkedScope = textField(scope, "upstream-scope-sha256", 64, HEX64);
    if (isRefusal(checkedScope)) return checkedScope;
  } else if (scope !== null) {
    const checkedScope = textField(scope, "upstream-scope-sha256", 64, HEX64);
    if (isRefusal(checkedScope)) return checkedScope;
  }
  return {
    ingress_id: event.ingress_id, capture_id: captureId, channel, upstream_namespace: namespace,
    upstream_delivery_id: deliveryId, upstream_id_status: status, upstream_scope_sha256: scope,
    sha256: digest, byte_len: byteLen, received_at: receivedAt,
  };
}

const IMMUTABLE_KEYS: readonly (keyof Immutable)[] = [
  "capture_id", "channel", "upstream_namespace", "upstream_delivery_id", "upstream_id_status",
  "upstream_scope_sha256", "sha256", "byte_len", "received_at",
];

function newRequest(fields: Immutable, at: string, supersedes: string | null): IntakeRequest {
  return {
    ...fields,
    state: "queued",
    work_state: "unstarted",
    answered_at: null,
    owning_task: null,
    bound_dispatch_ids: [],
    depends_on: [],
    pause: null,
    result: null,
    failure: null,
    supersedes,
    superseded_by: null,
    revisions: [],
    review: [],
    binding: [],
    notice: null,
    last_event_at: at,
    history: [{ at, event: supersedes === null ? "captured" : "amend", from: null, to: "queued" }],
  };
}

/** Growth is refused at the bound: an intake obligation must not lose its own audit trail. */
function withinBounds(row: IntakeRequest): IntakeOutcome | null {
  const checks: [string, number, number][] = [
    ["history", row.history.length, INTAKE_BOUNDS.max_history],
    ["review", row.review.length, INTAKE_BOUNDS.max_review],
    ["binding", row.binding.length, INTAKE_BOUNDS.max_binding],
    ["revisions", row.revisions.length, INTAKE_BOUNDS.max_revisions],
    ["depends_on", row.depends_on.length, INTAKE_BOUNDS.max_depends_on],
  ];
  for (const [name, size, max] of checks) {
    if (size > max) {
      return refuse("intake_bounds_exceeded", `${name} would exceed ${max} entries`);
    }
  }
  return null;
}

function advance(
  doc: IntakeDocument, index: number, row: IntakeRequest, extra?: IntakeRequest,
): IntakeOutcome {
  const bounded = withinBounds(row);
  if (bounded) return bounded;
  const requests = doc.requests.slice();
  requests[index] = row;
  if (extra) requests.push(extra);
  if (requests.length > INTAKE_BOUNDS.max_rows) {
    return refuse("intake_bounds_exceeded", `the ledger holds ${INTAKE_BOUNDS.max_rows} requests`);
  }
  return { result: "intake_written", document: { ...doc, generation: doc.generation, requests } };
}

/** One transition, one appended history entry. No field is ever rewritten in place. */
function transition(
  row: IntakeRequest, event: IntakeEvent, to: IntakeState, work: IntakeWorkState,
  patch: Partial<IntakeRequest>, extra: Partial<IntakeHistoryEntry> = {},
): IntakeRequest {
  return {
    ...row,
    ...patch,
    state: to,
    work_state: work,
    last_event_at: event.at,
    history: [...row.history,
      { at: event.at, event: event.kind, from: row.state, to, ...extra }],
  };
}

function creation(doc: IntakeDocument, event: IntakeEvent, context: IntakeContext): IntakeOutcome {
  const fields = immutableFields(event);
  if (isRefusal(fields)) return fields;
  const existing = doc.requests.findIndex((r) => r.ingress_id === event.ingress_id);
  if (existing >= 0) {
    const row = doc.requests[existing];
    for (const key of IMMUTABLE_KEYS) {
      if (row[key] !== fields[key]) {
        // The stored row is authority: a mismatch refuses, it never overwrites and never no-ops.
        return refuse("intake_identity_collision",
          `${event.ingress_id}: ${key} does not match the recorded delivery`);
      }
    }
    return refuse("intake_replay", `${event.ingress_id} was already captured`);
  }
  // A replayed capture must not resurrect an archived request, and an unprovable scan refuses.
  if (context.archiveScanComplete === false) {
    return refuse("intake_archive_unbounded",
      "the intake archive could not be scanned within its bound; capture refused rather than "
      + "admitted, because non-resurrection cannot be proven");
  }
  if ((context.archived ?? []).includes(event.ingress_id)) {
    return refuse("intake_archived", `${event.ingress_id} is archived and is not resurrected`);
  }
  if (fields.upstream_id_status === "available") {
    const key = upstreamDedupeKey(fields);
    const duplicate = doc.requests.find((r) => r.upstream_id_status === "available"
      && upstreamDedupeKey(r) === key);
    if (duplicate) {
      return refuse("intake_upstream_duplicate",
        `upstream delivery already recorded as ${duplicate.ingress_id}`);
    }
  }

  if (event.kind === "captured") {
    const requests = [...doc.requests, newRequest(fields, event.at, null)];
    if (requests.length > INTAKE_BOUNDS.max_rows) {
      return refuse("intake_bounds_exceeded",
        `the ledger holds ${INTAKE_BOUNDS.max_rows} requests`);
    }
    return { result: "intake_written", document: { ...doc, requests } };
  }

  // amend: a new delivery that supersedes an earlier one. The original is preserved verbatim.
  const supersedes = textField(event.supersedes, "supersedes", INTAKE_BOUNDS.max_id_chars, UUID4);
  if (isRefusal(supersedes)) return supersedes;
  const index = doc.requests.findIndex((r) => r.ingress_id === supersedes);
  if (index < 0) return refuse("intake_not_found", `no intake request ${supersedes}`);
  const original = doc.requests[index];
  if (!TRANSITIONS.amend.includes(original.state)) {
    return refuse("intake_transition_refused",
      `amend is not authorised from ${original.state}`);
  }
  if (original.superseded_by !== null) {
    return refuse("intake_transition_refused",
      `${supersedes} is already superseded by ${original.superseded_by}; the link is set once`);
  }
  const superseded: IntakeRequest = {
    ...original,
    superseded_by: event.ingress_id,
    last_event_at: event.at,
    revisions: [...original.revisions,
      { at: event.at, kind: "superseded_by", revision: event.ingress_id }],
    history: [...original.history,
      { at: event.at, event: "amend", from: original.state, to: original.state }],
  };
  const revision = newRequest(fields, event.at, supersedes);
  revision.revisions = [{ at: event.at, kind: "amends", revision: supersedes }];
  return advance(doc, index, superseded, revision);
}

function mutate(doc: IntakeDocument, event: IntakeEvent): IntakeOutcome {
  const index = doc.requests.findIndex((r) => r.ingress_id === event.ingress_id);
  // An event for an unknown request is never a creation.
  if (index < 0) return refuse("intake_not_found", `no intake request ${event.ingress_id}`);
  const row = doc.requests[index];
  const allowed = TRANSITIONS[event.kind];

  switch (event.kind) {
    case "bind": {
      const task = textField(event.owning_task, "owning-task", INTAKE_BOUNDS.max_id_chars, TOKEN);
      if (isRefusal(task)) return task;
      const dispatch = textField(event.dispatch_id, "dispatch-id", INTAKE_BOUNDS.max_id_chars,
        TOKEN);
      if (isRefusal(dispatch)) return dispatch;
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused", `bind is not authorised from ${row.state}`);
      }
      // Recording an owner is not a grant: no state moves, nothing is dispatched, nothing starts.
      return advance(doc, index, {
        ...row,
        owning_task: task,
        bound_dispatch_ids: row.bound_dispatch_ids.includes(dispatch)
          ? row.bound_dispatch_ids : [...row.bound_dispatch_ids, dispatch],
        binding: [...row.binding, { at: event.at, owning_task: task, dispatch_id: dispatch }],
        last_event_at: event.at,
        history: [...row.history,
          { at: event.at, event: "bind", from: row.state, to: row.state }],
      });
    }
    case "start": {
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused", `start is not authorised from ${row.state}`);
      }
      if (row.binding.length === 0) {
        return refuse("intake_transition_refused",
          `${row.ingress_id} has no recorded owner; bind before start`);
      }
      // start is the other exit from `waiting`, so it clears the pause it resolves, in this same
      // single transition. Leaving it set made `pause` permanently unavailable, because a pause
      // is set-once while it holds (ir1166bcx R2). From `queued` this is a no-op, so start has
      // one behaviour and not two. A second pause after this is a NEW fact.
      return advance(doc, index, transition(row, event, "in_progress", "in_progress",
        { pause: null, depends_on: [] }));
    }
    case "pause": {
      const reason = textField(event.reason, "reason", INTAKE_BOUNDS.max_text_chars, TEXT);
      if (isRefusal(reason)) return reason;
      const owner = textField(event.owner, "owner", INTAKE_BOUNDS.max_id_chars, TOKEN);
      if (isRefusal(owner)) return owner;
      const condition = textField(event.resume_condition, "resume-condition",
        INTAKE_BOUNDS.max_text_chars, TEXT);
      if (isRefusal(condition)) return condition;
      const dependsOn = event.depends_on ?? [];
      if (dependsOn.length > INTAKE_BOUNDS.max_depends_on) {
        return refuse("intake_bounds_exceeded",
          `depends_on would exceed ${INTAKE_BOUNDS.max_depends_on} entries`);
      }
      for (const dependency of dependsOn) {
        const checked = textField(dependency, "depends-on", INTAKE_BOUNDS.max_id_chars, TOKEN);
        if (isRefusal(checked)) return checked;
      }
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused", `pause is not authorised from ${row.state}`);
      }
      if (row.pause !== null) {
        return refuse("intake_transition_refused",
          `${row.ingress_id} already carries a pause; it is set once`);
      }
      return advance(doc, index, transition(row, event, "waiting", "paused", {
        pause: { reason, owner, resume_condition: condition, resume_to: row.state },
        depends_on: [...dependsOn],
      }));
    }
    case "resume": {
      if (!allowed.includes(row.state) || row.pause === null) {
        return refuse("intake_transition_refused",
          `resume requires a recorded pause; ${row.ingress_id} is ${row.state}`);
      }
      const back = row.pause.resume_to;
      return advance(doc, index, transition(row, event, back,
        back === "in_progress" ? "in_progress" : "unstarted", { pause: null, depends_on: [] }));
    }
    case "answered": {
      const verdict = textField(event.verdict, "verdict", INTAKE_BOUNDS.max_id_chars, TOKEN);
      if (isRefusal(verdict)) return verdict;
      if (!ANSWER_VERDICTS.includes(verdict)) {
        return refuse("intake_malformed",
          `verdict must be one of ${ANSWER_VERDICTS.join("|")} for an answer`);
      }
      const scope = textField(event.scope, "scope", INTAKE_BOUNDS.max_text_chars, TEXT);
      if (isRefusal(scope)) return scope;
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused", `answered is not authorised from ${row.state}`);
      }
      if (row.answered_at !== null) {
        return refuse("intake_transition_refused",
          `${row.ingress_id} was answered at ${row.answered_at}; the answer is set once`);
      }
      // An answer is not a completion: `state` and `work_state` are deliberately unchanged, and
      // any result reference the caller passes is NOT admitted as a completion result.
      return advance(doc, index, {
        ...row,
        answered_at: event.at,
        review: [...row.review, { at: event.at, verdict: verdict as IntakeAnswerVerdict, scope }],
        last_event_at: event.at,
        history: [...row.history,
          { at: event.at, event: "answered", from: row.state, to: row.state }],
      });
    }
    case "work-completed": {
      const verdict = textField(event.verdict, "verdict", INTAKE_BOUNDS.max_id_chars, TOKEN);
      if (isRefusal(verdict)) return verdict;
      if (!WORK_VERDICTS.includes(verdict)) {
        return refuse("intake_malformed",
          `verdict must be one of ${WORK_VERDICTS.join("|")} for a work completion`);
      }
      const ref = textField(event.result_ref, "result-ref", INTAKE_BOUNDS.max_result_ref_chars,
        REFERENCE);
      if (isRefusal(ref)) return ref;
      const evidence = textField(event.evidence_sha256, "evidence-sha256", 64, HEX64);
      if (isRefusal(evidence)) return evidence;
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused",
          `work-completed is not authorised from ${row.state}`);
      }
      if (row.result !== null) {
        return refuse("intake_transition_refused",
          `${row.ingress_id} already carries a completion result; it is set once`);
      }
      // `review` is the human-answer log and nothing else: a work verdict appended there was
      // indistinguishable from an answer, and showed a review on a row nobody had answered
      // (ir1166bcx R3). No fact is lost — the verdict and its evidence are in `result` and the
      // appended history entry, and the work axis is result + history + work_state.
      return advance(doc, index, transition(row, event, "completed", "completed", {
        result: { verdict: verdict as IntakeWorkVerdict, result_ref: ref,
          evidence_sha256: evidence },
      }));
    }
    case "fail": {
      const reason = textField(event.reason, "reason", INTAKE_BOUNDS.max_text_chars, TOKEN);
      if (isRefusal(reason)) return reason;
      if (!FAILURE_REASONS.includes(reason)) {
        return refuse("intake_malformed", `reason must be one of ${FAILURE_REASONS.join("|")}`);
      }
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused", `fail is not authorised from ${row.state}`);
      }
      // Recorded, never swept: a failed row is preserved and is never pruned at any age.
      return advance(doc, index, transition(row, event, "failed", "failed", {
        failure: { at: event.at, reason: reason as IntakeFailureReason },
      }));
    }
    case "cancel": {
      const reason = textField(event.reason, "reason", INTAKE_BOUNDS.max_text_chars, TEXT);
      if (isRefusal(reason)) return reason;
      if (!allowed.includes(row.state)) {
        return refuse("intake_transition_refused", `cancel is not authorised from ${row.state}`);
      }
      // Scope-exact: one named row, and never a completion. Nothing touches
      // `result`, and a cancellation is not a review verdict, so `review` stays as
      // it was. The reason is preserved in the appended history entry.
      return advance(doc, index, transition(row, event, "cancelled", "cancelled",
        { failure: row.failure }, { reason }));
    }
    default:
      return refuse("invalid_argument", `unknown intake event kind ${JSON.stringify(event.kind)}`);
  }
}

/**
 * The whole state machine. Total: every input yields either a new document or a typed refusal,
 * and the input document is never mutated.
 */
export function applyIntakeEvent(
  doc: IntakeDocument, event: IntakeEvent, context: IntakeContext = {},
): IntakeOutcome {
  if (!KINDS.includes(event.kind)) {
    // There is deliberately no event for idleness, cleanup, a session end, a worker exit, a
    // reap, a notice, a transport result, a turn boundary or liveness. None of them can reach
    // a request state, because none of them is expressible here.
    return refuse("invalid_argument", `unknown intake event kind ${JSON.stringify(event.kind)}`);
  }
  const at = textField(event.at, "now", 32, RFC3339_Z);
  if (isRefusal(at)) return at;
  const ingress = textField(event.ingress_id, "ingress-id", INTAKE_BOUNDS.max_id_chars, UUID4);
  if (isRefusal(ingress)) return ingress;
  const checked = validateIntakeDocument(doc);
  if (checked.result !== "ok") return refuse("registry_corrupt", checked.detail);
  return event.kind === "captured" || event.kind === "amend"
    ? creation(doc, event, context)
    : mutate(doc, event);
}

/** Stable logical identity; attempts never choose a replacement identity. */
export function intakeNoticeId(ingressId: string): string {
  return createHash("sha256").update(["intake-notice-v1", ingressId, "1"].join("\u0000"),
    "utf8").digest("hex");
}

const NOTICE_MAX_EVENTS = 64;
const NOTICE_MAX_ATTEMPTS = 16;
const NOTICE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const noticeObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const noticeKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const noticeMatches = (v: unknown, pattern: RegExp): v is string =>
  typeof v === "string" && pattern.exec(v)?.[0] === v;
const noticeToken = (v: unknown): v is string => noticeMatches(v, NOTICE_TOKEN);
const noticeClaim = (v: unknown): v is string => noticeToken(v) && v !== "none";
const noticeInteger = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const noticeTime = (v: unknown): v is string => {
  if (typeof v !== "string" || !RFC3339_Z.test(v) || v.startsWith("0000")) return false;
  const time = Date.parse(v);
  return Number.isFinite(time) && new Date(time).toISOString() === v.slice(0, -1) + ".000Z";
};

function validNoticeEvent(v: unknown): v is IntakeNoticeEvent {
  if (!noticeObject(v)) return false;
  const common = ["action", "ingress_id", "notice_id", "attempt", "claim", "owner", "at"];
  const extra = v.action === "claim" ? ["previous_attempt", "previous_claim"]
    : v.action === "result" || v.action === "resolve" ? ["status", "evidence_sha256", "retry_at"]
      : v.action === "ack" ? ["evidence_sha256"] : null;
  if (!extra || !noticeKeys(v, [...common, ...extra])
    || !noticeMatches(v.ingress_id, UUID4) || !noticeMatches(v.notice_id, HEX64)
    || !noticeInteger(v.attempt, 1, NOTICE_MAX_ATTEMPTS + 1)
    || !noticeClaim(v.claim) || !noticeToken(v.owner) || !noticeTime(v.at)) return false;
  if (v.action === "claim") return noticeInteger(v.previous_attempt, 0, NOTICE_MAX_ATTEMPTS)
    && (v.previous_attempt === 0 ? v.previous_claim === null : noticeClaim(v.previous_claim));
  if (!noticeMatches(v.evidence_sha256, HEX64)) return false;
  if (v.action === "ack") return true;
  if (v.status !== "sent" && v.status !== "not_sent"
    && !(v.action === "result" && v.status === "unknown")) return false;
  return v.status === "not_sent" ? noticeTime(v.retry_at) && v.retry_at >= v.at
    : v.retry_at === null;
}

/** Check one append without mutating or interpreting evidence as authenticity. */
function noticeAppend(events: readonly IntakeNoticeEvent[], e: IntakeNoticeEvent): IntakeResultCode | null {
  if (e.attempt > NOTICE_MAX_ATTEMPTS) return "intake_bounds_exceeded";
  const last = events.at(-1);
  if (e.action === "claim") {
    if (e.previous_attempt !== (last?.attempt ?? 0) || e.previous_claim !== (last?.claim ?? null)) {
      return "intake_notice_race";
    }
    if (e.attempt !== (last?.attempt ?? 0) + 1
      || events.some(old => old.action === "claim" && old.claim === e.claim)
      || (last && (!(last.action === "result" || last.action === "resolve")
        || last.status !== "not_sent" || last.retry_at === null || e.at < last.retry_at))) {
      return "intake_transition_refused";
    }
  } else {
    if (!last || e.attempt !== last.attempt || e.claim !== last.claim || e.owner !== last.owner) {
      return "intake_transition_refused";
    }
    const allowed = e.action === "result" ? last.action === "claim"
      : e.action === "resolve" ? last.action === "result" && last.status === "unknown"
        : (last.action === "result" || last.action === "resolve") && last.status === "sent";
    if (!allowed) return "intake_transition_refused";
  }
  if (last && e.at < last.at) return "intake_transition_refused";
  return events.length >= NOTICE_MAX_EVENTS ? "intake_bounds_exceeded" : null;
}

function validIntakeNotice(value: unknown, ingress: string): boolean {
  if (value === null) return true;
  if (!noticeObject(value)) return false;
  if (!Object.hasOwn(value, "version")) return noticeKeys(value, ["claim", "owner", "at"])
    && typeof value.claim === "string" && typeof value.owner === "string" && typeof value.at === "string";
  if (!noticeKeys(value, ["version", "notice_id", "generation", "events"])
    || value.version !== 1 || value.generation !== 1 || value.notice_id !== intakeNoticeId(ingress)
    || !Array.isArray(value.events) || value.events.length < 1 || value.events.length > NOTICE_MAX_EVENTS) return false;
  const prior: IntakeNoticeEvent[] = [];
  for (const e of value.events) {
    if (!validNoticeEvent(e) || e.ingress_id !== ingress || e.notice_id !== value.notice_id
      || noticeAppend(prior, e) !== null) return false;
    prior.push(e);
  }
  return true;
}

/** Notice facts never answer, bind, start, complete or resurrect requested work. */
export function applyIntakeNotice(doc: IntakeDocument, event: IntakeNoticeEvent): IntakeOutcome {
  const checked = validateIntakeDocument(doc);
  if (checked.result !== "ok") return refuse("registry_corrupt", checked.detail);
  if (!validNoticeEvent(event)) return refuse("intake_malformed", "invalid notice event");
  if (event.notice_id !== intakeNoticeId(event.ingress_id)) {
    return refuse("intake_identity_collision", "notice identity does not match ingress");
  }
  const index = doc.requests.findIndex(r => r.ingress_id === event.ingress_id);
  if (index < 0) return refuse("intake_not_found", "notice target is not in hot ledger");
  const row = doc.requests[index]!;
  if (row.notice !== null && !("version" in row.notice)) {
    return refuse("intake_transition_refused", "legacy claim outcome is unknown");
  }
  const events = row.notice?.events ?? [];
  if (events.some(old => Object.keys(old).every(key =>
    old[key as keyof IntakeNoticeEvent] === event[key as keyof IntakeNoticeEvent])
    && Object.keys(old).length === Object.keys(event).length)) {
    return refuse("intake_notice_replay", "exact retained notice event");
  }
  const refused = noticeAppend(events, event);
  if (refused) return refuse(refused, "notice append refused");
  if (event.action === "claim" && (row.state !== "queued" || row.work_state !== "unstarted"
    || row.pause !== null || row.superseded_by !== null || row.result !== null || row.failure !== null)) {
    return refuse("intake_transition_refused", "notice target is not queued and unstarted");
  }
  const requests = [...doc.requests];
  requests[index] = { ...row, notice: { version: 1, notice_id: event.notice_id, generation: 1,
    events: [...events, { ...event }] } };
  return { result: "intake_written", document: { ...doc, requests } };
}

/**
 * FIFO receipt accounting. Derived on read, never stored. Closed rows (`completed`/`cancelled`)
 * and superseded rows hold no position, so an amended request is not counted twice; a `failed`
 * or `waiting` row keeps its position, because the work is still owed.
 */
export function derivePositions(
  doc: IntakeDocument,
): (IntakeRequest & { position: number | null })[] {
  const ordered = doc.requests.slice().sort((a, b) => (
    a.received_at < b.received_at ? -1
      : a.received_at > b.received_at ? 1
        : a.ingress_id < b.ingress_id ? -1 : a.ingress_id > b.ingress_id ? 1 : 0));
  let position = 0;
  return ordered.map((row) => {
    const open = row.state !== "completed" && row.state !== "cancelled"
      && row.superseded_by === null;
    if (open) position += 1;
    return { ...row, position: open ? position : null };
  });
}

/**
 * Which rows a prune may archive, and which it must keep. Copied from the shipped #1170
 * precedent (`bin/dispatch-registry.py:960-1003`): a row is a candidate only when it is closed
 * AND aged, and the writer drops it only after the archive append has succeeded. Nothing else is
 * ever a candidate, at any age.
 *
 * Supersession is deliberately NOT a factor here. A closed row that happens to have been
 * superseded is finished work; gating on it kept such a row hot forever (ir1166bcx R1). An OPEN
 * superseded row is still retained, by the closed test alone. The supersession exclusion belongs
 * to FIFO accounting in `derivePositions`, where it stays.
 */
export function prunePlan(doc: IntakeDocument, options: IntakePruneOptions): IntakePrunePlan {
  const now = Date.parse(options.now);
  const archive: IntakeRequest[] = [];
  const keep: IntakeRequest[] = [];
  for (const row of doc.requests) {
    const closed = row.state === "completed" || row.state === "cancelled";
    const stamp = Date.parse(row.last_event_at);
    const aged = Number.isFinite(now) && Number.isFinite(stamp)
      && (now - stamp) / 1000 > options.olderThanSeconds;
    if (closed && aged) archive.push(row);
    else keep.push(row);
  }
  return { archive, keep };
}
