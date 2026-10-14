// #1170 the report pump's decision for ONE dispatch record — pure and deterministic.
//
// Input: the record as the registry holds it (report-list row), what this pass
// measured about the worker (scan), the clock, and the policy. Output: the
// actions to take, in order. Nothing here reads a file, runs a process or looks
// at a clock, so every transition of SPEC §5/§6 is a table test.
//
// Four facts are kept apart and never inferred from each other: captured (an
// envelope-valid item reached the inbox), notice (what the transport said),
// observed (what the receiver's audit log said) and review (an explicit ACK). Only
// an accepted current final is `done`, and only the registry derives that. A
// worker exit, a screen, a file or a transport rc is never completion.

export type Resolution =
  | "open" | "done" | "rework_requested" | "rejected" | "failed_seen"
  | "not_delivered" | "legacy_unbound" | "legacy_seen";

export type FailureEvent =
  | "exited" | "dead" | "gone" | "cleaned" | "overdue" | "delivery_unknown"
  | "item_conflict" | "item_invalid" | "hook_degraded";

export type SubmitOutcome = "consumed" | "queued" | "unknown" | "gate_timeout" | "failed";

export interface NoticeState {
  n: number;
  last_at: string | null;
  next_at: string | null;
  rc: number | null;
  inject_id: string | null;
  submit: SubmitOutcome | "pending" | null;
  delivery_result: string | null;
  verified_sender: string | null;
  dest?: string | null;
}

export interface ReviewState {
  verdict: string;
  at: string;
  by_claimed: string | null;
}

export interface ItemRecord {
  sha256: string;
  bytes: number;
  inbox: string;
  captured_at: string;
  superseded_by: string | null;
  notice: NoticeState | null;
  review: ReviewState | null;
  /** #1136 TURN items only: hook-reported end/assoc and the formal names new in this turn. */
  end?: string;
  assoc?: string;
  new_formal?: string[];
}

export interface FailureRecord {
  n: number;
  event: FailureEvent;
  detail: string;
  at: string;
  subject_sha256: string;
  notice: NoticeState | null;
  review: ReviewState | null;
  /** item_invalid / item_conflict: the item (`KIND-n`) it is about. */
  key?: string;
}

export interface LegacyRecord {
  at: string;
  subject_sha256: string;
  notice: NoticeState | null;
  review: ReviewState | null;
}

export interface ReportState {
  v: 1;
  request_id: string | null;
  challenge_sha256: string | null;
  resolution: Resolution;
  current_final: string | null;
  items: Record<string, ItemRecord>;
  failures: FailureRecord[];
  legacy?: LegacyRecord;
  /** First pass at which a two-tick failure condition was seen. */
  suspect?: Partial<Record<FailureEvent, string>>;
  /** Pending claims only: subject → claiming pump `<pid>@<host>` (it may still be sending). */
  claim_owners?: Record<string, string>;
  history: unknown[];
  history_dropped: number;
}

/** One `dispatch-registry.py report-list` row. */
export interface ReportRow {
  dispatch_id: string;
  sid: string;
  attempt: string | null;
  manifest_sha256: string | null;
  from_sid: string;
  lifecycle: string;
  gate: string | null;
  transport: string | null;
  expected_report_by: string | null;
  dispatched_at: string | null;
  /** The dispatch that superseded this one by --retry-unknown, if any. */
  superseded_by: string | null;
  report: ReportState | null;
}

export interface ScannedItem {
  key: string;
  kind: "REPORT" | "HOLD" | "TURN";
  seq: number;
  sha256: string;
  bytes: number;
  raw: Uint8Array;
  /** #1136 TURN only: parsed status fields; `newFormal` = after \ before (hook's claim). */
  turn?: { end: string; assoc: "exact" | "unknown"; error: string | null; newFormal: string[] };
}

export interface InvalidItem {
  name: string;
  code: string;
}

export type Destination = { ok: true; dest: string } | { ok: false; reason: string };

export interface InjectObservation {
  delivery_result: string;
  verified_sender: string | null;
}

export interface ScanResult {
  /** Complete, envelope-valid items currently in the outbox. */
  items: ScannedItem[];
  /** Complete-but-refused items (incomplete ones are not listed). */
  invalid: InvalidItem[];
  receipt: "running" | "exited" | "unknown";
  /** Both receipt pids ESRCH = false; unknown = null. */
  pidsAlive: boolean | null;
  presence: "present" | "absent" | "unknown";
  destination: Destination;
  /** Receiver audit rows for this record's pending inject ids, by inject_id. */
  observed: Record<string, InjectObservation>;
  /** #1136: constant codes of the attempt's `.hook-degraded-*` markers. */
  hookDegraded: string[];
  /** Owners of this record's pending claims that may still be sending (not provably gone). */
  liveClaimOwners?: string[];
}

export interface PumpPolicy {
  /** Minutes after notice n (1-based) before re-notice; after the list, hourly. */
  retryMinutes: readonly number[];
  hourlyMinutes: number;
  /** queued / gate_timeout hold the next re-notice at least this long. */
  heldMinutes: number;
  /** A claimed-but-unfinished notice is retried after this (> pump INJECT_TIMEOUT_MS + CLAIM_MARGIN_MS). */
  claimLeaseMinutes: number;
  /** failed_seen records are rescanned for this long after the last failure review. */
  failedSeenScanDays: number;
  /** Capture only: no failure detection, notices or observations (cleanup). */
  captureOnly: boolean;
}

export const DEFAULT_POLICY: PumpPolicy = {
  retryMinutes: [2, 5, 10, 20, 30],
  hourlyMinutes: 60,
  heldMinutes: 30,
  claimLeaseMinutes: 2,
  failedSeenScanDays: 7,
  captureOnly: false,
};

export type Action =
  | { type: "capture"; item: ScannedItem }
  | { type: "failure"; event: FailureEvent; stage: "suspect" | "confirm" | "clear"; detail: string; key?: string }
  | { type: "notice"; subject: string; expectN: number }
  /** An expired claim whose owner may still be sending: record `unknown`, held — never re-sent now. */
  | { type: "held"; subject: string; expectN: number }
  | { type: "observe"; subject: string; injectId: string; deliveryResult: string; verifiedSender: string | null }
  | { type: "destination_invalid"; reason: string };

const MINUTE = 60_000;

/** When notice n (just sent) may be repeated. */
export function nextNoticeAtMs(n: number, submit: SubmitOutcome | "pending", nowMs: number, policy: PumpPolicy): number {
  let minutes = n >= 1 && n <= policy.retryMinutes.length ? policy.retryMinutes[n - 1]! : policy.hourlyMinutes;
  if (submit === "pending") minutes = policy.claimLeaseMinutes;
  if (submit === "queued" || submit === "gate_timeout") minutes = Math.max(minutes, policy.heldMinutes);
  return nowMs + minutes * MINUTE;
}

/** An expired claim recorded as `unknown`: held at least `heldMinutes`, like queued. */
export function heldNoticeAtMs(n: number, nowMs: number, policy: PumpPolicy): number {
  return Math.max(nextNoticeAtMs(n, "unknown", nowMs, policy), nowMs + policy.heldMinutes * MINUTE);
}

/** A due notice still `pending` whose claiming pump may be sending: must not be re-claimed. */
export function claimHeld(rep: ReportState, subject: string, notice: NoticeState | null | undefined,
  liveOwners: readonly string[] | undefined): boolean {
  const owner = rep.claim_owners?.[subject];
  return !!notice && notice.submit === "pending" && !!owner && !!liveOwners?.includes(owner);
}

/** The item an item_invalid / item_conflict failure is about (rows before `key`: from the host-written detail). */
export function failureItemKey(f: Pick<FailureRecord, "key" | "detail">): string | null {
  if (f.key) return f.key;
  return /^((?:REPORT|HOLD|TURN)-[0-9]{1,2})(?:\.md: | changed after capture)/.exec(f.detail ?? "")?.[1] ?? null;
}

function noticeDue(notice: NoticeState | null, nowMs: number): boolean {
  if (!notice || notice.n === 0) return true;
  const next = notice.next_at ? Date.parse(notice.next_at) : NaN;
  return !Number.isFinite(next) || nowMs >= next;
}

function seqOfKey(key: string): number {
  return Number(key.slice(key.indexOf("-") + 1));
}

/** Which records the pump scans at all (SPEC §6); lifecycle is ignored. */
export function inScanSet(row: ReportRow, nowMs: number, policy: PumpPolicy): boolean {
  const rep = row.report;
  if (!rep) return false;
  if (rep.resolution === "open" || rep.resolution === "rework_requested" || rep.resolution === "legacy_unbound") return true;
  if (rep.resolution !== "failed_seen") return false;
  const last = Math.max(0, ...rep.failures.map((f) => (f.review ? Date.parse(f.review.at) || 0 : 0)));
  return nowMs - last <= policy.failedSeenScanDays * 24 * 60 * MINUTE;
}

/** Item/failure inject ids whose receiver audit row has not been recorded yet (legacy digests are not observed). */
export function pendingObservations(row: ReportRow): string[] {
  const rep = row.report;
  if (!rep) return [];
  const notices = [...Object.values(rep.items).map((i) => i.notice), ...rep.failures.map((f) => f.notice)];
  return notices.filter((n): n is NoticeState => !!n && !!n.inject_id && !n.delivery_result).map((n) => n.inject_id!);
}

/** The legacy notice for an unbound record, when due. */
export function legacyNoticeDue(row: ReportRow, nowMs: number): number | null {
  const leg = row.report?.legacy;
  if (!row.report || row.report.request_id !== null || !leg || leg.review) return null;
  return noticeDue(leg.notice, nowMs) ? (leg.notice?.n ?? 0) : null;
}

export function decide(row: ReportRow, scan: ScanResult, nowMs: number, policy: PumpPolicy): Action[] {
  const rep = row.report;
  if (!rep || !rep.request_id) return [];
  const out: Action[] = [];

  // ── 1. capture: new keys in ascending seq; a changed key is a visible conflict ──
  const fresh = scan.items.filter((i) => !rep.items[i.key])
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.seq - b.seq);
  // item_conflict / item_invalid are recorded once per item identity (bounded by the item names).
  const recordedItem = new Set(rep.failures.filter((f) => f.event === "item_conflict" || f.event === "item_invalid")
    .map((f) => `${f.event}:${failureItemKey(f)}`));
  const conflict = scan.items.find((i) => rep.items[i.key] && rep.items[i.key]!.sha256 !== i.sha256 &&
    !recordedItem.has(`item_conflict:${i.key}`));
  for (const item of fresh) out.push({ type: "capture", item });
  const recorded = new Set(rep.failures.map((f) => f.event));
  if (conflict) {
    out.push({ type: "failure", event: "item_conflict", stage: "confirm", key: conflict.key,
      detail: `${conflict.key} changed after capture` });
  }
  const invalid = scan.invalid.find((i) => !recordedItem.has(`item_invalid:${i.name.replace(/\.md$/, "")}`));
  if (invalid) {
    out.push({ type: "failure", event: "item_invalid", stage: "confirm", key: invalid.name.replace(/\.md$/, ""),
      detail: `${invalid.name}: ${invalid.code}` });
  }
  if (policy.captureOnly) return out;

  // ── 2. failures: only while a REPORT is still owed — none captured, or the current one sent back for rework ──
  const newFinal = fresh.filter((i) => i.kind === "REPORT").map((i) => i.key).pop() ?? null;
  const finalKey = newFinal && (!rep.current_final || seqOfKey(newFinal) > seqOfKey(rep.current_final))
    ? newFinal : rep.current_final;
  const reportOwed = !finalKey || (finalKey === rep.current_final && rep.items[finalKey]?.review?.verdict === "rework");
  const obligationOpen = rep.resolution === "open" || rep.resolution === "rework_requested";
  if (scan.hookDegraded.length && obligationOpen && !recorded.has("hook_degraded")) {
    out.push({ type: "failure", event: "hook_degraded", stage: "confirm",
      detail: `turn-end hook degraded: ${scan.hookDegraded.join(",")}` });
  }
  if (reportOwed) {
    const suspect = rep.suspect ?? {};
    const check = (event: FailureEvent, holds: boolean | null, twoTick: boolean, detail: string): void => {
      if (recorded.has(event) || holds === null) return;
      if (!holds) {
        if (suspect[event]) out.push({ type: "failure", event, stage: "clear", detail: "" });
        return;
      }
      out.push({ type: "failure", event, stage: twoTick && !suspect[event] ? "suspect" : "confirm", detail });
    };
    check("exited", scan.receipt === "unknown" ? null : scan.receipt === "exited", true, "sandbox receipt exited");
    check("dead", scan.receipt === "running" && scan.pidsAlive !== null ? !scan.pidsAlive : null, false,
      "receipt pids not alive");
    check("gone", scan.presence === "unknown" ? null : scan.presence === "absent", true, "absent from telepty list");
    const due = row.expected_report_by ? Date.parse(row.expected_report_by) : NaN;
    check("overdue", Number.isFinite(due) ? nowMs > due : null, false, `expected_report_by ${row.expected_report_by}`);
    check("delivery_unknown", row.lifecycle === "delivery_state_unknown", false, "dispatch delivery state unknown");
  }

  // ── 3. notices: every unreviewed, non-superseded subject whose schedule is due ──
  // #1136: only the newest TURN counts, and only while the obligation is open and no formal
  // item named as new in that turn was actually captured (pump truth, not the hook's list).
  const capturedKeys = new Set([...Object.keys(rep.items), ...fresh.map((i) => i.key)]);
  const turns = [...Object.entries(rep.items).filter(([k]) => k.startsWith("TURN-"))
    .map(([key, it]) => ({ key, newFormal: it.new_formal ?? [], open: !it.review && !it.superseded_by })),
  ...fresh.filter((i) => i.kind === "TURN").map((i) => ({ key: i.key, newFormal: i.turn?.newFormal ?? [], open: true }))];
  const newestTurn = turns.sort((a, b) => seqOfKey(b.key) - seqOfKey(a.key))[0];
  const turnKey = newestTurn && newestTurn.open && obligationOpen &&
    !newestTurn.newFormal.some((k) => capturedKeys.has(k)) ? newestTurn.key : null;
  const subjects: Array<{ key: string; notice: NoticeState | null }> = [];
  for (const [key, it] of Object.entries(rep.items)) {
    if (it.review || it.superseded_by) continue;
    if (key.startsWith("REPORT-") && key !== finalKey) continue; // superseded by this pass's capture
    if (key.startsWith("TURN-") && key !== turnKey) continue;
    subjects.push({ key, notice: it.notice });
  }
  for (const item of fresh) {
    if (item.kind === "REPORT" && item.key !== finalKey) continue;
    if (item.kind === "TURN" && item.key !== turnKey) continue;
    subjects.push({ key: item.key, notice: null });
  }
  for (const f of rep.failures) if (!f.review) subjects.push({ key: `failure-${f.n}`, notice: f.notice });
  // An expired claim whose owner may still be sending is recorded unknown + held, never re-claimed now.
  const held = subjects.filter((s) => noticeDue(s.notice, nowMs) && claimHeld(rep, s.key, s.notice, scan.liveClaimOwners));
  for (const s of held) out.push({ type: "held", subject: s.key, expectN: s.notice!.n });
  const due = subjects.filter((s) => noticeDue(s.notice, nowMs) && !held.includes(s));
  if (due.length && !scan.destination.ok) {
    out.push({ type: "destination_invalid", reason: scan.destination.reason });
  } else {
    for (const s of due) out.push({ type: "notice", subject: s.key, expectN: s.notice?.n ?? 0 });
  }

  // ── 4. receiver observations for inject ids already sent ──
  const observable: Array<[string, NoticeState | null]> = [
    ...Object.entries(rep.items).map(([k, i]): [string, NoticeState | null] => [k, i.notice]),
    ...rep.failures.map((f): [string, NoticeState | null] => [`failure-${f.n}`, f.notice]),
  ];
  for (const [key, notice] of observable) {
    if (!notice || !notice.inject_id || notice.delivery_result) continue;
    const seen = scan.observed[notice.inject_id];
    if (seen) out.push({ type: "observe", subject: key, injectId: notice.inject_id,
      deliveryResult: seen.delivery_result, verifiedSender: seen.verified_sender });
  }
  return out;
}
