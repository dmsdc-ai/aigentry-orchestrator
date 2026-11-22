// controller-link v1 — pump decision (SPEC §9.2, §9.3, §4 retention, §6.2 crash points; task 1294, unit U8).
//
// PURE: decide(record, facts) returns the single next step SPEC §9 allows for one record. It reads
// nothing but its arguments (no file, clock, process, randomness or network); the pump (pump.ts)
// supplies the clock and the process facts and performs the step.
//
// A re-send of an obligation message (REQUEST-1 at the sender, REPLY-n at the receiver) is returned
// ONLY for SPEC §9.2 step 3 (latest attempt a definite refusal, on its back-off), step 6 (an ACK
// `unknown` newer than the latest attempt) or step 7 (the second `unverified` answer newer than the
// latest attempt); steps 6 and 7 together at most 3 times per message. A human `resend` is not a
// decision of this function. A re-send always names the message's own stored sha256 (same raw bytes,
// same id, same seq). An uncertain send (`unknown`, a crashed `pending`) is only ever probed.
// "Newer than the latest attempt" is decided by ACK sequence, never by wall time (CL-01): every
// re-send records `ack_seq` (the acks_in sequence it was committed with), so an answer authorises
// at most one re-send even when the clock moves backward.
import { RETENTION_MS, isTerminal, type LinkRecord, type SendAttempt, type UnverifiedCopy } from "./store.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------
// SPEC §9.2 / §9.3 / §6.2 / §9.1 constants

/** §6.2 / §9.2 step 1: a `pending` attempt older than this (or whose same-host owner is gone) becomes `unknown`. */
export const PENDING_MAX_AGE_MS = 10 * MIN;
/** §9.2 step 4: `handed_over` + `submit=queued` younger than this → wait (busy receiver). */
export const QUEUED_WAIT_MS = 30 * MIN;
/** §9.2 step 3: delay before the k-th re-send after k definite refusals in a row (then RESEND_EVERY_MS). */
export const RESEND_DELAYS_MS: readonly number[] = [1, 2, 5, 10, 20, 30].map((m) => m * MIN);
export const RESEND_EVERY_MS = 60 * MIN;
/** §9.2 step 3: definite refusals for this long (from the first of the run) → stalled. */
export const REFUSAL_STALL_MS = 24 * HOUR;
/** §9.2 step 5: PROBE at these offsets after the latest attempt, then every PROBE_EVERY_MS. */
export const PROBE_OFFSETS_MS: readonly number[] = [5, 15, 30, 60].map((m) => m * MIN);
export const PROBE_EVERY_MS = 3 * HOUR;
/** §9.2 step 5: no settling ACK this long after the latest attempt → stalled. */
export const NO_ACK_STALL_MS = 48 * HOUR;
/** §9.2 step 6/7: re-sends on a peer answer, per message, in total. */
export const ANSWER_RESENDS_MAX = 3;
/** §9.2 step 7: the n-th `unverified` answer newer than the latest attempt allows a re-send. */
export const UNVERIFIED_ANSWERS_FOR_RESEND = 2;
/** §9.3: re-check corroboration of unverified inbox requests / uncorroborated REPLY copies this long. */
export const VERIFY_WINDOW_MS = 48 * HOUR;
/** §9.1: a notice claim is held this long; a live or foreign owner is never pre-empted before. */
export const NOTICE_LEASE_MS = 3 * MIN;
/** §9.2 step 2: an ACK in one of these states settles the message; nothing more is sent for it. */
export const SETTLING_ACK_STATES: readonly string[] = ["received", "accepted", "refused"];

export type ResendTrigger = "refused_definite" | "ack_unknown" | "ack_unverified";
/** `human` is written by the `resend` command only; it starts a new run of definite refusals. */
export const RESEND_TRIGGERS = ["refused_definite", "ack_unknown", "ack_unverified", "human"] as const;

export type NoticeKind =
  | "stalled" | "conflict" | "refused" | "peer_unconfigured" | "corroborated" | "reply_unverified" | "unbound" | "no_final";
/** Highest first; one series per record at a time (the highest applicable kind). */
export const NOTICE_PRIORITY: readonly NoticeKind[] = [
  "stalled", "conflict", "refused", "peer_unconfigured", "corroborated", "reply_unverified", "unbound", "no_final",
];
/**
 * §9.3 schedules, as offsets from the series anchor, then every `everyMs` after the last offset
 * (null = no repeat): inbox `received` unbound +10 min, +30 min, then every 2 h; inbox bound without
 * a final REPLY once a day; `stalled` and CONFLICT once, then daily; sender `refused` once (§7.1);
 * an unconfigured peer once (§9.3 last bullet); an uncorroborated REPLY copy at the sender once its 48 h of
 * re-checks are over, then daily, without a state change (Root decision on HOLD-1 Q4); a stored message
 * the pump found corroborated at once, then every 2 h, until the record shows the controller acted (CL-05, awaitingIngest).
 */
export const NOTICE_SCHEDULES: Readonly<Record<NoticeKind, { offsets: readonly number[]; everyMs: number | null }>> = {
  stalled: { offsets: [0], everyMs: DAY },
  conflict: { offsets: [0], everyMs: DAY },
  refused: { offsets: [0], everyMs: null },
  peer_unconfigured: { offsets: [0], everyMs: null },
  corroborated: { offsets: [0], everyMs: 2 * HOUR },
  reply_unverified: { offsets: [0], everyMs: DAY },
  unbound: { offsets: [10 * MIN, 30 * MIN], everyMs: 2 * HOUR },
  no_final: { offsets: [DAY], everyMs: DAY },
};

// ---------------------------------------------------------------------------------------------
// Types

/** Where an attempt or claim lives in a record. */
export type AttemptSlot =
  | { where: "message"; key: string }
  | { where: "probe"; key: string }
  | { where: "ack" }
  | { where: "notice" };

export interface DecideFacts {
  /** Injected wall clock. */
  nowMs: number;
  /** The record's peer is configured with `link:"v1"` (U6 activePeer). */
  peerActive: boolean;
  /** Owners (`<pid>@<host>`) of pending attempts / notice claims that are provably gone (same host, pid not alive). */
  goneOwners: ReadonlySet<string>;
}

export type Step =
  /** Nothing to do now; `due_ms` is when the next step may become due (null = never by time alone). */
  | { kind: "none"; due_ms: number | null; why: string }
  /** §6.2: a crashed `pending` attempt becomes `unknown` (never re-sent); an expired notice claim counts as sent. */
  | { kind: "recover"; slot: AttemptSlot; n: number; why: "owner_gone" | "older_than_10_min" | "lease_expired" }
  /** §9.2 step 5. */
  | { kind: "probe"; key: string }
  /** §9.2 steps 3, 6, 7: the SAME raw file (`sha256` = the message's stored sha256). */
  | { kind: "resend"; key: string; trigger: ResendTrigger; sha256: string }
  /** §9.3: re-run corroboration (§8.1 step 3) for these stored raw files. */
  | { kind: "verify"; shas: string[] }
  /** §9.2 / §9.3 limits. */
  | { kind: "stall"; why: string }
  /** §9.3 local notice. `anchor` identifies the series (ISO time, or the peer label for peer_unconfigured). */
  | { kind: "remind"; notice: NoticeKind; anchor: string }
  /** §4: terminal for 30 days; deleted by the store's retention selector. */
  | { kind: "expire" };

export interface NoticeSeries {
  kind: NoticeKind;
  anchor: string;
  n: number;
  last_at: string | null;
}

export interface NoticeClaim {
  owner: string;
  at: string;
  kind: NoticeKind;
  anchor: string;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

const ms = (iso: unknown): number => (typeof iso === "string" ? Date.parse(iso) : NaN);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function lastOf<T>(list: readonly T[] | undefined): T | undefined {
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
}

/**
 * The smallest schedule point strictly after `afterMs` (or the first point when `afterMs` is null).
 * Points are `anchor + offsets[i]`, then `anchor + last offset + k·everyMs` (k ≥ 1). null = none left.
 */
export function nextPoint(anchorMs: number, offsets: readonly number[], everyMs: number | null, afterMs: number | null): number | null {
  for (const o of offsets) {
    const p = anchorMs + o;
    if (afterMs === null || p > afterMs) return p;
  }
  if (everyMs === null || offsets.length === 0 || afterMs === null) return null;
  const last = anchorMs + offsets[offsets.length - 1]!;
  const k = Math.floor((afterMs - last) / everyMs) + 1;
  return last + Math.max(1, k) * everyMs;
}

/** §9.2 step 3 back-off: the delay after the `run`-th definite refusal in a row (run ≥ 1). */
export function resendDelayMs(run: number): number {
  return run >= 1 && run <= RESEND_DELAYS_MS.length ? RESEND_DELAYS_MS[run - 1]! : RESEND_EVERY_MS;
}

/** Obligation messages of this record: ones this side sent (REQUEST-1 for a sender, REPLY-n for a receiver). */
export function obligationKeys(rec: LinkRecord): string[] {
  const order = (k: string): number => (k === "REQUEST-1" ? 0 : Number(k.slice(6)));
  return Object.keys(rec.messages)
    .filter((k) => (rec.role === "sender" ? k === "REQUEST-1" : k.startsWith("REPLY-")))
    .filter((k) => (rec.messages[k]?.sends?.length ?? 0) > 0)
    .sort((a, b) => order(a) - order(b));
}

export interface PendingRef {
  slot: AttemptSlot;
  attempt: SendAttempt;
}

/** Every `pending` attempt of the record (messages, probes, ACKs). */
export function pendingAttempts(rec: LinkRecord): PendingRef[] {
  const out: PendingRef[] = [];
  for (const [key, m] of Object.entries(rec.messages)) {
    for (const a of m.sends ?? []) if (a.result === "pending") out.push({ slot: { where: "message", key }, attempt: a });
  }
  for (const [key, p] of Object.entries(rec.probes_out)) {
    for (const a of p.sends) if (a.result === "pending") out.push({ slot: { where: "probe", key }, attempt: a });
  }
  for (const a of rec.acks_out.sends) if (a.result === "pending") out.push({ slot: { where: "ack" }, attempt: a });
  return out;
}

/** The record's notice claim (pump.ts writes `notices.claim`), or null. */
export function noticeClaimOf(rec: LinkRecord): NoticeClaim | null {
  const c = rec.notices.claim;
  if (!isObj(c) || typeof c.owner !== "string" || typeof c.at !== "string" || typeof c.anchor !== "string" ||
      !(NOTICE_PRIORITY as readonly unknown[]).includes(c.kind)) return null;
  return { owner: c.owner, at: c.at, kind: c.kind as NoticeKind, anchor: c.anchor };
}

/** The record's current notice series (pump.ts writes `notices.series`), or null. */
export function noticeSeriesOf(rec: LinkRecord): NoticeSeries | null {
  const s = rec.notices.series;
  if (!isObj(s) || typeof s.anchor !== "string" || typeof s.n !== "number" ||
      !(NOTICE_PRIORITY as readonly unknown[]).includes(s.kind)) return null;
  return { kind: s.kind as NoticeKind, anchor: s.anchor, n: s.n, last_at: typeof s.last_at === "string" ? s.last_at : null };
}

/** Owners whose liveness the pump must establish for decide(): pending attempts and the notice claim. */
export function pendingOwners(rec: LinkRecord): string[] {
  const owners = new Set(pendingAttempts(rec).map((p) => p.attempt.owner));
  const claim = noticeClaimOf(rec);
  if (claim !== null) owners.add(claim.owner);
  return [...owners];
}

/** Re-sends of this message made on a peer answer (§9.2 steps 6/7); pump.ts keeps `answer_resends` on the entry. */
export function answerResends(rec: LinkRecord, key: string): number {
  const v = rec.messages[key]?.answer_resends;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/**
 * CL-01: the ACK sequence an attempt was committed with (`ack_seq`, written by pump.ts for every
 * re-send): an answer is newer than the attempt iff its sequence is greater. An attempt without one
 * is a message's first send (dispatch, reply), before which no ACK for that message can exist: 0.
 * Any other attempt without one never authorises an answer re-send (fail closed: probe, then stall).
 */
export function ackWatermark(a: SendAttempt): number {
  const v = a.ack_seq;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  return a.n === 1 ? 0 : Number.POSITIVE_INFINITY;
}

/**
 * Distinct `unverified` answers for `key` with an ACK sequence greater than `afterSeq`, from the
 * `ack_in` history events U6 writes (`<ref> seq=<n> state=<s>`). Wall time is not compared (CL-01).
 * History is bounded (64): a dropped entry can only lower the count, which delays a re-send, never adds one.
 */
export function unverifiedAnswersAfter(rec: LinkRecord, key: string, afterSeq: number): number {
  const seqs = new Set<number>();
  for (const h of rec.history) {
    if (h.event !== "ack_in" || typeof h.detail !== "string") continue;
    const m = /^(\S+) seq=([0-9]+) state=unverified$/.exec(h.detail);
    if (m !== null && m[1] === key && Number(m[2]) > afterSeq) seqs.add(Number(m[2]));
  }
  return seqs.size;
}

/** The trailing run of definite refusals; a `human` re-send starts a new run. */
function refusedRun(sends: readonly SendAttempt[]): SendAttempt[] {
  const run: SendAttempt[] = [];
  for (let i = sends.length - 1; i >= 0; i--) {
    const a = sends[i]!;
    if (a.result !== "refused_definite") break;
    run.unshift(a);
    if (a.trigger === "human") break;
  }
  return run;
}

const SENDER_SETTLED = new Set(["received", "accepted", "refused", "replied", "closed"]);

export type MsgEval =
  | { kind: "done" }
  | { kind: "wait"; due_ms: number | null; why: string }
  | { kind: "act"; step: Step };

/** SPEC §9.2 for one obligation message M; steps 1–7 (pending recovery itself is record-level, below). */
export function evaluateMessage(rec: LinkRecord, key: string, nowMs: number): MsgEval {
  const entry = rec.messages[key];
  const sends = entry?.sends ?? [];
  const a = lastOf(sends);
  if (entry === undefined || a === undefined) return { kind: "done" };
  const aAt = ms(a.at);
  // Step 1: a live, young pending attempt — wait (an old or orphaned one was recovered before this).
  if (a.result === "pending") return { kind: "wait", due_ms: aAt + PENDING_MAX_AGE_MS, why: `${key} attempt in flight` };
  // Step 2: settled by an ACK (or, at the sender, by a state only an ACK or a REPLY reaches).
  const ack = rec.acks_in[key];
  if (ack !== undefined && SETTLING_ACK_STATES.includes(ack.state)) return { kind: "done" };
  if (rec.role === "sender" && SENDER_SETTLED.has(rec.state)) return { kind: "done" };
  if (rec.role === "receiver" && rec.state === "replied") return { kind: "done" };
  // Step 3: definite refusal → same-byte re-send on the back-off; 24 h of them → stalled.
  if (a.result === "refused_definite") {
    const run = refusedRun(sends);
    const stallAt = ms(run[0]!.at) + REFUSAL_STALL_MS;
    if (nowMs >= stallAt) return { kind: "act", step: { kind: "stall", why: `${key} definitely refused for 24 h` } };
    const due = aAt + resendDelayMs(run.length);
    if (nowMs >= due) return { kind: "act", step: { kind: "resend", key, trigger: "refused_definite", sha256: entry.sha256 } };
    return { kind: "wait", due_ms: Math.min(due, stallAt), why: `${key} re-send back-off` };
  }
  // Step 4: handed over but queued at a busy receiver → no probe for 30 min.
  if (a.result === "handed_over" && a.submit === "queued" && nowMs - aAt < QUEUED_WAIT_MS) {
    return { kind: "wait", due_ms: aAt + QUEUED_WAIT_MS, why: `${key} queued at the receiver` };
  }
  // Steps 6 and 7: a peer answer newer than the latest attempt by ACK sequence (at most 3 such re-sends in
  // total). The re-send records the sequence it consumed as its own `ack_seq` (CL-01): one answer, one re-send.
  if (ack !== undefined && answerResends(rec, key) < ANSWER_RESENDS_MAX) {
    const consumed = ackWatermark(a);
    if (ack.state === "unknown" && ack.last_seq > consumed) {
      return { kind: "act", step: { kind: "resend", key, trigger: "ack_unknown", sha256: entry.sha256 } };
    }
    if (ack.state === "unverified" && unverifiedAnswersAfter(rec, key, consumed) >= UNVERIFIED_ANSWERS_FOR_RESEND) {
      return { kind: "act", step: { kind: "resend", key, trigger: "ack_unverified", sha256: entry.sha256 } };
    }
  }
  // Step 5: probe at +5, 15, 30, 60 min after the latest attempt, then every 3 h; 48 h → stalled.
  const stallAt = aAt + NO_ACK_STALL_MS;
  if (nowMs >= stallAt) return { kind: "act", step: { kind: "stall", why: `no settling ACK for ${key} 48 h after its latest attempt` } };
  const probes = (rec.probes_out[key]?.sends ?? []).filter((p) => ms(p.at) >= aAt);
  const lastProbe = lastOf(probes);
  if (lastProbe !== undefined && lastProbe.result === "pending") {
    return { kind: "wait", due_ms: ms(lastProbe.at) + PENDING_MAX_AGE_MS, why: `${key} probe in flight` };
  }
  const due = nextPoint(aAt, PROBE_OFFSETS_MS, PROBE_EVERY_MS, lastProbe === undefined ? null : ms(lastProbe.at));
  if (due !== null && due < stallAt && nowMs >= due) return { kind: "act", step: { kind: "probe", key } };
  return { kind: "wait", due_ms: due === null ? stallAt : Math.min(due, stallAt), why: `${key} next probe` };
}

/** Uncorroborated REPLY copies (U6 `unverified_copies` with a `REPLY-n` key) whose message is not stored yet. */
export function unverifiedReplyCopies(rec: LinkRecord): UnverifiedCopy[] {
  return (rec.unverified_copies ?? []).filter((c) => {
    const key = (c as unknown as { key?: unknown }).key;
    return typeof key === "string" && key.startsWith("REPLY-") && rec.messages[key] === undefined;
  });
}

/**
 * CL-05: the pump's corroboration re-check (§9.3) never applies a message itself; it records here
 * (`notices.corroborated`, written by pump.ts) the stored sha256s it found corroborated, and the
 * `corroborated` notice tells the controller to feed that stored copy to its own `ingest`, whose
 * RESULT=NEW (with the quoted body) is the only actionable presentation.
 */
export function corroboratedMark(rec: LinkRecord): { shas: Set<string>; at: string } | null {
  const v = rec.notices.corroborated;
  if (!isObj(v) || !Array.isArray(v.shas) || typeof v.at !== "string") return null;
  return { shas: new Set(v.shas.filter((s): s is string => typeof s === "string")), at: v.at };
}

/**
 * Stored messages the pump found corroborated that await the controller's action (CL-05), in presentation
 * order: an inbox request still uncorroborated in `unverified` or `stalled` (and its copies), then REPLY
 * copies not stored as a message. The fact is read from the record only and has no time limit: it ends when
 * the record shows the controller acted — its own ingest applied the copy (the request left `unverified` /
 * `stalled` with REQUEST-1 corroborated, or the REPLY-n message is stored), or it closed the record.
 * Non-empty: the `corroborated` notice repeats.
 */
export function awaitingIngest(rec: LinkRecord): string[] {
  const mark = corroboratedMark(rec);
  if (mark === null || rec.state === "closed") return [];
  const out: string[] = [];
  const req = rec.messages["REQUEST-1"];
  if (rec.role === "receiver" && (rec.state === "unverified" ||
      (rec.state === "stalled" && req?.corroboration?.state !== "corroborated"))) {
    if (req !== undefined && mark.shas.has(req.sha256)) out.push(req.sha256);
    for (const c of rec.unverified_copies ?? []) if (mark.shas.has(c.sha256)) out.push(c.sha256);
  }
  for (const c of unverifiedReplyCopies(rec)) if (mark.shas.has(c.sha256)) out.push(c.sha256);
  return [...new Set(out)];
}

/**
 * CL-12: the start of a terminal record's 30 days, by the retention selector's own rule (store.ts
 * `lastChangeMs`): the later of `state_at` and every message's `ingested_at`.
 */
export function retentionStartMs(rec: LinkRecord): number {
  let t = ms(rec.state_at);
  for (const m of Object.values(rec.messages)) {
    if (typeof m.ingested_at === "string") t = Math.max(t, Date.parse(m.ingested_at));
  }
  return t;
}

/** The kind of local notice this record is subject to now (highest priority), with its series anchor. */
export function noticeKindOf(rec: LinkRecord, peerActive: boolean): { kind: NoticeKind; anchor: string; anchorMs: number } | null {
  const at = (kind: NoticeKind, iso: string) => ({ kind, anchor: iso, anchorMs: ms(iso) });
  const conflicts = rec.history.filter((h) => h.event === "conflict");
  const conflict = lastOf(conflicts);
  // CL-05: a stored copy awaiting the controller keeps its notice series in every state it can be in.
  const mark = corroboratedMark(rec);
  const awaiting = mark !== null && awaitingIngest(rec).length > 0 ? at("corroborated", mark.at) : null;
  if (isTerminal(rec.state)) {
    // CL-12: a CONFLICT is reminded on a terminal record too (once, then daily until retention).
    if (conflict !== undefined) return at("conflict", conflict.at);
    if (awaiting !== null) return awaiting;
    return rec.role === "sender" && rec.state === "refused" ? at("refused", rec.state_at) : null;
  }
  if (rec.state === "stalled") {
    if (awaiting !== null && peerActive) return awaiting;
    // CL-12: a CONFLICT that arrived after the stall is new information: its own series, not the stall's.
    if (conflict !== undefined && ms(conflict.at) > ms(rec.state_at)) return at("conflict", conflict.at);
    return at("stalled", rec.state_at);
  }
  if (conflict !== undefined) return at("conflict", conflict.at);
  if (!peerActive) return { kind: "peer_unconfigured", anchor: rec.peer, anchorMs: NaN };
  if (awaiting !== null) return awaiting;
  const copies = unverifiedReplyCopies(rec);
  if (copies.length > 0) {
    // Due when the oldest copy's 48 h of re-checks end (anchor), then daily; the record's state is never changed.
    const oldest = Math.min(...copies.map((c) => ms(c.at)));
    return at("reply_unverified", new Date(oldest + VERIFY_WINDOW_MS).toISOString());
  }
  if (rec.role !== "receiver") return null;
  if (rec.state === "received") return at("unbound", rec.state_at);
  const final = Object.keys(rec.messages).some((k) => k.startsWith("REPLY-") && rec.messages[k]!.final === "yes");
  if (rec.state === "accepted" || (rec.state === "replying" && !final)) return at("no_final", rec.state_at);
  return null;
}

/** §9.3 local notice for this record: a step, a wait, or nothing. */
function noticeEval(rec: LinkRecord, facts: DecideFacts): MsgEval {
  const claim = noticeClaimOf(rec);
  if (claim !== null) {
    // A claim is never taken over while its owner may be sending; an expired or orphaned one is recovered.
    if (facts.goneOwners.has(claim.owner)) return { kind: "act", step: { kind: "recover", slot: { where: "notice" }, n: 0, why: "owner_gone" } };
    if (!(facts.nowMs - ms(claim.at) < NOTICE_LEASE_MS)) {
      return { kind: "act", step: { kind: "recover", slot: { where: "notice" }, n: 0, why: "lease_expired" } };
    }
    return { kind: "wait", due_ms: ms(claim.at) + NOTICE_LEASE_MS, why: "notice claimed" };
  }
  const k = noticeKindOf(rec, facts.peerActive);
  if (k === null) return { kind: "done" };
  const s = noticeSeriesOf(rec);
  const same: NoticeSeries | null = s !== null && s.kind === k.kind && s.anchor === k.anchor ? s : null;
  if (k.kind === "peer_unconfigured") {
    return same !== null && same.n >= 1 ? { kind: "done" } : { kind: "act", step: { kind: "remind", notice: k.kind, anchor: k.anchor } };
  }
  const sched = NOTICE_SCHEDULES[k.kind];
  const lastAt = same !== null && same.last_at !== null ? ms(same.last_at) : null;
  const due = Number.isNaN(k.anchorMs) ? null : nextPoint(k.anchorMs, sched.offsets, sched.everyMs, lastAt);
  if (due === null) return { kind: "done" };
  if (facts.nowMs >= due) return { kind: "act", step: { kind: "remind", notice: k.kind, anchor: k.anchor } };
  return { kind: "wait", due_ms: due, why: `${k.kind} notice` };
}

const minDue = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** SPEC §9: the single next step for one record. Pure. */
export function decide(rec: LinkRecord, facts: DecideFacts): Step {
  const now = facts.nowMs;
  const marked = corroboratedMark(rec)?.shas ?? new Set<string>();
  const freshReplyCopies = (): string[] => [...new Set(unverifiedReplyCopies(rec)
    .filter((c) => now - ms(c.at) < VERIFY_WINDOW_MS && !marked.has(c.sha256)).map((c) => c.sha256))];
  // Terminal: retention after 30 days (§4) from the retention selector's own start (CL-12); the sender's
  // `refused` notice (once). CL-05: a REPLY copy first stored on a terminal record is re-checked like any
  // other (§9.3), except on `closed` (the controller closed it: nothing awaits it there).
  if (isTerminal(rec.state)) {
    const start = retentionStartMs(rec);
    if (now - start >= RETENTION_MS) return { kind: "expire" };
    const n = noticeEval(rec, facts);
    if (n.kind === "act") return n.step;
    const shas = rec.state === "closed" ? [] : freshReplyCopies();
    if (shas.length > 0) return { kind: "verify", shas };
    return { kind: "none", due_ms: minDue(n.kind === "wait" ? n.due_ms : null, start + RETENTION_MS), why: "terminal" };
  }
  // §9.3 last bullet: an unconfigured peer — no send, no state change; one notice.
  if (!facts.peerActive) {
    const n = noticeEval(rec, facts);
    if (n.kind === "act") return n.step;
    return { kind: "none", due_ms: n.kind === "wait" ? n.due_ms : null, why: "peer not configured with link v1" };
  }
  // §6.2 / §9.2 step 1: a crashed or orphaned pending attempt becomes `unknown` (then the probe path).
  for (const p of pendingAttempts(rec)) {
    const gone = facts.goneOwners.has(p.attempt.owner);
    const old = !(now - ms(p.attempt.at) < PENDING_MAX_AGE_MS);
    if (gone || old) return { kind: "recover", slot: p.slot, n: p.attempt.n, why: gone ? "owner_gone" : "older_than_10_min" };
  }
  if (rec.state === "stalled") {
    const n = noticeEval(rec, facts);
    if (n.kind === "act") return n.step;
    // CL-05: a REPLY copy stored on a stalled sender record is re-checked too (§9.3; no send).
    const shas = freshReplyCopies();
    if (shas.length > 0) return { kind: "verify", shas };
    return { kind: "none", due_ms: n.kind === "wait" ? n.due_ms : null, why: "stalled: a human decides" };
  }
  // §9.3: an unverified inbox request is re-checked each pass for 48 h, then stalled. An uncorroborated REPLY
  // copy is re-checked for 48 h; after that only the daily `reply_unverified` notice (no state change, HOLD-1 Q4).
  // CL-05: the re-check only records corroboration; a corroborated copy is presented by the `corroborated`
  // notice (before any further re-check) and applied by the controller's own ingest, never by the pump. The
  // 48 h stall comes first; the `corroborated` notice then continues on the stalled record (noticeKindOf).
  const req = rec.messages["REQUEST-1"];
  const since = ms(req?.ingested_at ?? rec.state_at);
  if (rec.role === "receiver" && rec.state === "unverified" && !(now - since < VERIFY_WINDOW_MS)) {
    return { kind: "stall", why: "request not corroborated within 48 h" };
  }
  let presentWait: number | null = null;
  if (awaitingIngest(rec).length > 0) {
    const n = noticeEval(rec, facts);
    if (n.kind === "act") return n.step;
    if (n.kind === "wait") presentWait = n.due_ms;
  }
  if (rec.role === "receiver" && rec.state === "unverified") {
    const shas = [req?.sha256, ...(rec.unverified_copies ?? []).map((c) => c.sha256)]
      .filter((x): x is string => typeof x === "string" && !marked.has(x));
    if (shas.length > 0) return { kind: "verify", shas: [...new Set(shas)] };
    return { kind: "none", due_ms: minDue(presentWait, since + VERIFY_WINDOW_MS), why: "corroborated; waiting for the controller's ingest" };
  }
  const freshCopies = freshReplyCopies();
  if (freshCopies.length > 0) return { kind: "verify", shas: freshCopies };
  // §9.2 for every obligation message, in order.
  let due: number | null = null;
  const whys: string[] = [];
  for (const key of obligationKeys(rec)) {
    const e = evaluateMessage(rec, key, now);
    if (e.kind === "act") return e.step;
    if (e.kind === "wait") {
      due = minDue(due, e.due_ms);
      whys.push(e.why);
    }
  }
  // §9.3 local notices.
  const n = noticeEval(rec, facts);
  if (n.kind === "act") return n.step;
  if (n.kind === "wait") {
    due = minDue(due, n.due_ms);
    whys.push(n.why);
  }
  return { kind: "none", due_ms: due, why: whys.length > 0 ? whys.join("; ") : "nothing due" };
}

/** The time the next step is due: now for an action, the wait's due time, or null. */
export function dueOf(step: Step, nowMs: number): number | null {
  return step.kind === "none" ? step.due_ms : step.kind === "expire" ? null : nowMs;
}
