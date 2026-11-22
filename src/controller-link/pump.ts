// controller-link v1 — pump and human re-send (SPEC §9, §6.1, §6.2; task 1294, unit U8). The pump deletes nothing (v1 has no retention).
//
//   bin/controller-link.sh pump   --once | --loop <seconds>        (reconciler step 0b4 runs `pump --once`)
//   bin/controller-link.sh resend --request <U> --reason "<text>"   (human, from `stalled` only)
//
// One pass: load every record through the U2 store, ask decide() (pure) for each record's single next
// step and perform it — recover a crashed `pending` attempt as `unknown`, mark `stalled`, send a PROBE,
// re-send the SAME raw bytes (only on the triggers decide() allows), re-check corroboration (U6
// `corroborate`, read only: the pump never applies a message; CL-05), or post a local notice — within the
// per-pass budget (≤ 240 s, ≤ 20 cross-machine sends, ≤ 10 notices, ≤ 256 records visited). The pass has ONE
// deadline (CL-08, CL3-04): every step and every audit query check it before they start, each with its own
// worst case (a send its 120 s timeout, a notice the report pump's inject timeout, an audit query 5 pages × 30 s),
// a notice re-checks it after its claim, and every child the pass starts (the sender, the audit reader, the
// notice inject) runs through one runner with its timeout cut to the time left, so the deadline kills it; a killed
// or unstarted child is `unknown` (a send, a notice) or `audit_unavailable`, never refused. Worst case, with
// W = the store walk and cursor read at the start, L = one store mutation (lock wait ≤ 30 s + one record's I/O)
// and A = the cursor write: pass ≤ max(W, PASS_WALL_MS + 2·L) + A — the last step starts before the deadline,
// its claim takes ≤ L, its child ends by the deadline, its result write takes ≤ L. CL-18: a pass starts at a
// rotating cursor (`pump-cursor.json` in the store root) so every record is eventually visited.
//
// Every send follows SPEC §6.1: under the lock the attempt is written `pending` with `owner=<pid>@<host>`
// and committed BEFORE telepty runs (U3 sendEnvelope); the result is written afterwards. A claim (a
// pending attempt, a notice claim) whose owner may still be working is never taken over (§9.1).
// Notices go to this machine's own controller with the report pump's inject argv (src/report/pump.ts) and
// `--from controller-link` (HOLD-1 Q1, option B), through the pass runner (runnerNoticePort). Off switch: AIGENTRY_CONTROLLER_LINK_PUMP=0 (the pass reads and sends nothing).
// The clock, monotonic clock, process runner, pid liveness, notice sender, sleep and store root are injected.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

import { parseInjectId } from "../dispatch/inject-id.js";
import { sanitizeBody } from "../report/envelope.js";
import { atomicWrite } from "../session/persistence/atomic-write.js";
import { INJECT_TIMEOUT_MS, defaultPidAlive, submitOutcome, teleptyChildEnv, type InjectResult } from "../report/pump.js";
import {
  AUDIT_MAX_PAGES, AUDIT_TIMEOUT_MS, CliError, EXIT, activePeer, corroborate, defaultAuditReader, loadPeerConfig, nextActionFor,
  sentAt, type AuditReader, type CliDeps, type PeerConfig,
} from "./cli.js";
import {
  answerResends, corroboratedMark, decide, dueOf, noticeClaimOf, noticeSeriesOf, noticeSlot, pendingOwners, SETTLING_ACK_STATES,
  type AttemptSlot, type DecideFacts, type NoticeKind, type Step,
} from "./decide.js";
import { REFUSE_REASONS, REQUEST_ID_RE, SEQ_MAX, renderEnvelope } from "./envelope.js";
import {
  KILL_GRACE_MS, SEND_FROM, SEND_TIMEOUT_MS, sendEnvelope, type ProcessRunner, type SendClassification, type SendResult,
} from "./send.js";
import {
  ControllerLinkStore, StoreError, resolveStoreRoot,
  type LinkRecord, type RecordRef, type RecordState, type SendAttempt,
} from "./store.js";

// ---------------------------------------------------------------------------------------------
// Constants (SPEC §9.1)

/** Off switch (DECISIONS Q2): `0` = the pump reads and sends nothing. */
export const PUMP_SWITCH_ENV = "AIGENTRY_CONTROLLER_LINK_PUMP";
/** One pass: wall time, cross-machine sends, local notices. */
export const PASS_WALL_MS = 240_000;
export const PASS_SENDS_MAX = 20;
export const PASS_NOTICES_MAX = 10;
/** A notice starts only if the report pump sender's own inject timeout fits in the pass. */
export const NOTICE_TIMEOUT_MS = INJECT_TIMEOUT_MS;
/** One corroboration re-check starts only if its worst case (every page at its timeout) fits in the pass (CL-08). */
export const AUDIT_CHECK_MS = AUDIT_TIMEOUT_MS * AUDIT_MAX_PAGES;
/** First token of every local notice (not an envelope; ingest ignores it). */
export const NOTICE_MARKER = "⟦controller-link notice⟧";
/** Local steps (recover, stall, verify) a record may take in one pass before its one send or notice. */
export const RECORD_STEPS_MAX = 4;
/** CL-18: records visited per pass (the store's open-record cap per scope, OPEN_RECORDS_MAX); the rest go next pass. */
export const PASS_RECORDS_MAX = 256;
/** CL-18: the rotating cursor, a fixed file name in the store root: `{"v":1,"next":"<visit key>"}`. Never a path source. */
export const CURSOR_FILE = "pump-cursor.json";
/** `resend --reason`: one line, at most this many characters. */
export const RESEND_REASON_MAX = 512;
export const PUMP_USAGE = "usage: bin/controller-link.sh pump (--once | --loop <seconds>)";
export const RESEND_USAGE = 'usage: bin/controller-link.sh resend --request <U> --reason "<text>"';
const LOOP_SECONDS_RE = /^[1-9][0-9]{0,4}$/;
const REASON_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u27e6\u27e7]/;
const OWNER_RE = /^([0-9]{1,10})@(.+)$/;
const SHIM = "bin/controller-link.sh";
const RECONCILE = "the pump reconciles this automatically; do not re-run resend";

/** Sender states an obligation-message send result may move (§7.1); later states never move back. */
const SEND_STATES = new Set<string>(["prepared", "sent", "send_unknown", "send_refused", "unverified_at_peer"]);
const AFTER_SEND: Record<SendResult, RecordState> = { handed_over: "sent", unknown: "send_unknown", refused_definite: "send_refused" };

// ---------------------------------------------------------------------------------------------
// Injected dependencies

/** The local notice sender (production: runnerNoticePort); `rc` null = killed or no exit status (outcome unknown). */
export interface NoticePort {
  inject(dest: string, text: string): InjectResult | Promise<InjectResult>;
}

export interface PumpDeps extends CliDeps {
  /** Monotonic milliseconds for the per-pass deadline. */
  monoMs(): number;
  /** true alive, false gone (ESRCH), null unknown — src/report/pump.ts defaultPidAlive. */
  pidAlive(pid: number): boolean | null;
  notice: NoticePort;
  sleep(ms: number): Promise<void>;
  /** Host tokens that mean "this machine" in an owner `<pid>@<host>` (dispatch writes os.hostname() raw). */
  localHosts: readonly string[];
  /**
   * CL-08: builds the audit reader over the pass's deadline-bounded runner (production: cli.ts
   * defaultAuditReader), so the deadline kills an audit child too. Absent: `audit` is used as given.
   */
  auditWith?: (runner: ProcessRunner) => AuditReader;
  /** CL3-04: builds the notice port over the same deadline-bounded runner (production: runnerNoticePort). Absent: `notice`. */
  noticeWith?: (runner: ProcessRunner) => NoticePort;
  /** Tests only: stop `--loop` after this many passes. */
  maxPasses?: number;
}

export interface PassResult {
  records: number;
  sends: number;
  notices: number;
  recovered: number;
  stalled: number;
  verified: number;
  /** Steps due but left for the next pass (budget or deadline). */
  deferred: number;
  errors: string[];
  lines: string[];
}

interface SendCtx {
  deps: CliDeps;
  cfg: PeerConfig;
  store: ControllerLinkStore;
  owner: string;
  facts(rec: LinkRecord, nowMs: number): DecideFacts;
  /** The runner a send uses; the pump's is deadline-bounded (CL-08). Absent: `deps.runner`. */
  runner?: ProcessRunner;
}

interface PumpCtx extends SendCtx {
  deps: PumpDeps;
  t0: number;
  res: PassResult;
  runner: ProcessRunner;
  audit: AuditReader;
  notice: NoticePort;
}

interface PendingSend {
  ref: RecordRef;
  slot: AttemptSlot;
  n: number;
  text: string;
  target: string;
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isoOf = (msv: number): string => new Date(msv).toISOString();
const wireTask = (t: string | null): string | null => (t === null || t === "-" ? null : t);
const id8 = (rec: LinkRecord): string => rec.request_id.slice(0, 8);
const oneLine = (s: string): string => sanitizeBody(s, 512).text.replace(/\s+/g, " ").trim();
const sendWord = (cls: SendClassification): string => `${cls.result}${cls.submit ? `/${cls.submit}` : ""}`;

function refOf(rec: LinkRecord): RecordRef {
  return rec.role === "sender"
    ? { role: "sender", requestId: rec.request_id }
    : { role: "receiver", peer: rec.peer, requestId: rec.request_id };
}

function setState(rec: LinkRecord, state: RecordState, nowIso: string): void {
  if (rec.state === state) return;
  rec.state = state;
  rec.state_at = nowIso;
}

function addHistory(rec: LinkRecord, at: string, event: string, detail: string | null): void {
  rec.history.push({ at, event, detail });
}

function attemptsOf(rec: LinkRecord, slot: AttemptSlot): SendAttempt[] | null {
  switch (slot.where) {
    case "ack": return rec.acks_out.sends;
    case "probe": return rec.probes_out[slot.key]?.sends ?? null;
    case "message": return rec.messages[slot.key]?.sends ?? null;
    default: return null;
  }
}

const slotName = (slot: AttemptSlot): string =>
  slot.where === "message" ? slot.key : slot.where === "probe" ? `PROBE:${slot.key}` : slot.where === "ack" ? "ACK" : "NOTICE";

/** Identity of a step, to re-check under the lock that the step decided outside it still applies. */
function stepKey(s: Step): string {
  switch (s.kind) {
    case "recover": return `recover:${slotName(s.slot)}:${s.n}`;
    case "probe": return `probe:${s.key}`;
    case "resend": return `resend:${s.key}:${s.trigger}:${s.sha256}`;
    case "remind": return `remind:${s.notice}:${s.anchor}`;
    default: return s.kind;
  }
}

/** Owners of the record's claims that are provably gone: same host and the pid is not alive (§6.2). */
function goneOwnersOf(rec: LinkRecord, deps: PumpDeps): Set<string> {
  const out = new Set<string>();
  for (const owner of pendingOwners(rec)) {
    const m = OWNER_RE.exec(owner);
    if (m !== null && deps.localHosts.includes(m[2]!) && deps.pidAlive(Number(m[1])) === false) out.add(owner);
  }
  return out;
}

/** next_action from U6's wording, with the due time of the next pump step (U8 owns due times). */
function refreshNext(c: SendCtx, rec: LinkRecord, nowMs: number, lastSend: SendAttempt["result"] | null = null): void {
  const na = nextActionFor(rec.role, rec.state, rec.request_id, isoOf(nowMs), lastSend);
  if (na.code !== "NONE") {
    const due = dueOf(decide(rec, c.facts(rec, nowMs)), nowMs);
    na.due_at = due === null || !Number.isFinite(due) ? null : isoOf(due);
  }
  rec.next_action = na;
}

/** Counts a notice in its kind's slot (`notices.series` or `notices.once`, CL3-03) and in the U2 `notices` counters. */
function countNotice(rec: LinkRecord, kind: NoticeKind, anchor: string, atIso: string, submit: string, injectId: string | null): number {
  const s = noticeSeriesOf(rec, noticeSlot(kind));
  const n = (s !== null && s.kind === kind && s.anchor === anchor ? s.n : 0) + 1;
  rec.notices[noticeSlot(kind)] = { kind, anchor, n, last_at: atIso, last_submit: submit, last_inject_id: injectId };
  rec.notices.n += 1;
  rec.notices.last_at = atIso;
  return n;
}

// ---------------------------------------------------------------------------------------------
// §6.1 steps 2–4 for an attempt already committed `pending` (step 1)

async function deliver(c: SendCtx, p: PendingSend): Promise<SendClassification> {
  c.deps.fault?.("after_commit");
  const out = await sendEnvelope(p.target, p.text, { runner: c.runner ?? c.deps.runner, bin: c.deps.teleptyBin, baseEnv: c.deps.env });
  const cls: SendClassification = out.attempted
    ? out.classification
    : { result: "refused_definite", submit: null, inject_id: null, detail: `not_attempted:${out.code}` };
  c.deps.fault?.("after_inject");
  await c.store.mutate<null>(p.ref, (cur, m) => {
    if (cur === null) return { write: null, value: null };
    const next = clone(cur);
    const a = attemptsOf(next, p.slot)?.find((x) => x.n === p.n && x.result === "pending" && x.owner === c.owner);
    if (a === undefined) return { write: null, value: null };
    a.result = cls.result;
    a.submit = cls.submit;
    a.inject_id = cls.inject_id;
    a.detail = cls.detail;
    a.done_at = m.nowIso;
    if (p.slot.where === "message") {
      if (next.role === "sender" && SEND_STATES.has(next.state)) setState(next, AFTER_SEND[cls.result], m.nowIso);
      addHistory(next, m.nowIso, "send", `${p.slot.key} n=${p.n} ${cls.result}`);
    }
    refreshNext(c, next, m.nowMs, p.slot.where === "message" ? cls.result : null);
    return { write: next, value: null };
  });
  return cls;
}

// ---------------------------------------------------------------------------------------------
// Steps

/** Runs `fn` on the current record only if decide() still returns the same step under the lock. */
async function underSameStep<T>(c: PumpCtx, rec: LinkRecord, step: Step,
  fn: (cur: LinkRecord, nowIso: string, nowMs: number) => { write: LinkRecord; value: T } | null): Promise<T | null> {
  return c.store.mutate<T | null>(refOf(rec), (cur, m) => {
    if (cur === null) return { write: null, value: null };
    if (stepKey(decide(cur, c.facts(cur, m.nowMs))) !== stepKey(step)) return { write: null, value: null };
    const r = fn(cur, m.nowIso, m.nowMs);
    return r === null ? { write: null, value: null } : { write: r.write, value: r.value };
  });
}

async function applyRecover(c: PumpCtx, rec: LinkRecord, step: Extract<Step, { kind: "recover" }>): Promise<LinkRecord | null> {
  const done = await underSameStep<LinkRecord>(c, rec, step, (cur, nowIso, nowMs) => {
    const next = clone(cur);
    if (step.slot.where === "notice") {
      // §9.1: an expired or orphaned notice claim is counted as sent (result unknown); never re-sent at once.
      const claim = noticeClaimOf(next);
      if (claim === null) return null;
      countNotice(next, claim.kind, claim.anchor, claim.at, "unknown", null);
      next.notices.claim = null;
    } else {
      // §6.2: the attempt becomes `unknown`; the probe path follows. Never re-sent at once.
      const a = attemptsOf(next, step.slot)?.find((x) => x.n === step.n && x.result === "pending");
      if (a === undefined) return null;
      a.result = "unknown";
      a.submit = null;
      a.inject_id = null;
      a.detail = `pending_recovered:${step.why}`;
      a.done_at = nowIso;
      if (step.slot.where === "message" && next.role === "sender" && SEND_STATES.has(next.state)) setState(next, "send_unknown", nowIso);
      addHistory(next, nowIso, "recover", `${slotName(step.slot)} n=${step.n} pending->unknown (${step.why})`);
      refreshNext(c, next, nowMs, step.slot.where === "message" ? "unknown" : null);
    }
    return { write: next, value: next };
  });
  if (done !== null) {
    c.res.recovered += 1;
    c.res.lines.push(`PUMP_RECOVER request=${rec.request_id} role=${rec.role} slot=${slotName(step.slot)} n=${step.n} why=${step.why} result=unknown`);
  }
  return done ?? (await c.store.read(refOf(rec)));
}

async function applyStall(c: PumpCtx, rec: LinkRecord, step: Extract<Step, { kind: "stall" }>): Promise<LinkRecord | null> {
  const done = await underSameStep<LinkRecord>(c, rec, step, (cur, nowIso, nowMs) => {
    const next = clone(cur);
    setState(next, "stalled", nowIso);
    addHistory(next, nowIso, "stalled", step.why);
    refreshNext(c, next, nowMs);
    return { write: next, value: next };
  });
  if (done !== null) {
    c.res.stalled += 1;
    c.res.lines.push(`PUMP_STALL request=${rec.request_id} role=${rec.role} state=stalled why=${oneLine(step.why).replace(/ /g, "_")}`);
  }
  return done ?? (await c.store.read(refOf(rec)));
}

async function doProbe(c: PumpCtx, rec: LinkRecord, step: Extract<Step, { kind: "probe" }>): Promise<void> {
  const peer = activePeer(c.cfg, rec.peer);
  if (peer === null) return;
  const p = await underSameStep<PendingSend>(c, rec, step, (cur, nowIso, nowMs) => {
    const next = clone(cur);
    const n = Math.max(0, ...Object.values(next.probes_out).map((x) => x.last_seq)) + 1;
    if (n > SEQ_MAX) throw new CliError("STATE_INVALID", "PROBE sequence exhausted for this request");
    const r = renderEnvelope({
      kind: "PROBE", id: next.request_id, seq: n, ref: step.key, from: c.cfg.self.label, to: next.peer, sent_at: sentAt(nowMs),
      sender_task: wireTask(next.sender_task), receiver_task: next.receiver_task, state: null, outcome: null, final: null, reason: null,
    }, "");
    if (!r.ok) throw new Error(`controller-link pump: internal envelope error ${r.error.code}`);
    const slot: LinkRecord["probes_out"][string] = next.probes_out[step.key] ?? { last_seq: 0, sends: [] };
    slot.last_seq = n;
    slot.sends.push({ n, at: nowIso, owner: c.owner, result: "pending", sha256: r.envelope.sha256, trigger: "pump" });
    next.probes_out[step.key] = slot;
    addHistory(next, nowIso, "probe", `${step.key} seq=${n} pump`);
    refreshNext(c, next, nowMs);
    return { write: next, value: { ref: refOf(next), slot: { where: "probe", key: step.key }, n, text: r.envelope.text, target: peer.target } };
  });
  if (p === null) return;
  c.res.sends += 1;
  const cls = await deliver(c, p);
  c.res.lines.push(`PUMP_PROBE request=${rec.request_id} role=${rec.role} ref=${step.key} seq=${p.n} send=${sendWord(cls)}`);
}

async function doResend(c: PumpCtx, rec: LinkRecord, step: Extract<Step, { kind: "resend" }>): Promise<void> {
  const peer = activePeer(c.cfg, rec.peer);
  if (peer === null) return;
  const raw = await c.store.readRaw(step.sha256);
  if (raw === null) throw new StoreError("STORE_CORRUPT", "a message's raw file is missing");
  const p = await underSameStep<PendingSend>(c, rec, step, (cur, nowIso, nowMs) => {
    const next = clone(cur);
    const entry = next.messages[step.key];
    if (entry === undefined || entry.sha256 !== step.sha256) return null;
    const sends = entry.sends ?? [];
    const n = Math.max(0, ...sends.map((x) => x.n)) + 1;
    if (step.trigger !== "refused_definite") entry.answer_resends = answerResends(next, step.key) + 1;
    // CL-01: the trigger this re-send consumes, by identity — `ack_seq` (the ACK sequence it answers; decide()
    // allows the next answer re-send only for a greater one) and, for a refusal, `trigger_n` (the refused attempt).
    const latest = sends[sends.length - 1];
    sends.push({ n, at: nowIso, owner: c.owner, result: "pending", trigger: step.trigger, ack_seq: next.acks_in[step.key]?.last_seq ?? 0,
      ...(step.trigger === "refused_definite" && latest !== undefined ? { trigger_n: latest.n } : {}) });
    entry.sends = sends;
    addHistory(next, nowIso, "resend", `${step.key} n=${n} trigger=${step.trigger} sha256=${step.sha256}`);
    refreshNext(c, next, nowMs);
    return { write: next, value: { ref: refOf(next), slot: { where: "message", key: step.key }, n, text: raw.toString("utf8"), target: peer.target } };
  });
  if (p === null) return;
  c.res.sends += 1;
  const cls = await deliver(c, p);
  c.res.lines.push(`PUMP_RESEND request=${rec.request_id} role=${rec.role} ref=${step.key} n=${p.n} trigger=${step.trigger} ` +
    `sha256=${step.sha256} send=${sendWord(cls)}`);
}

/**
 * §9.3: re-run §8.1 step 3 (U6 `corroborate`, read only) for each stored copy. CL-05: the pump applies
 * nothing — no state change, no ACK, no consumed presentation; a corroborated sha256 is recorded in
 * `notices.corroborated` and the `corroborated` notice repeats until the record shows the controller acted
 * (decide.ts awaitingIngest). CL-08: no cross-machine send happens here, each audit query starts only if its
 * worst case fits before the pass deadline, and its child is killed by the deadline (the pass runner).
 * Returns the record when a new corroboration was recorded (its notice may follow in this pass), else null.
 */
async function doVerify(c: PumpCtx, rec: LinkRecord, step: Extract<Step, { kind: "verify" }>): Promise<LinkRecord | null> {
  const found: string[] = [];
  let checked = 0;
  for (const sha of step.shas) {
    if (!auditFits(c)) {
      defer(c, rec, step);
      break;
    }
    if ((await c.store.readRaw(sha)) === null) continue;
    checked += 1;
    const r = await corroborate(c.audit, sha, c.cfg.self.controller_sid, c.deps.clock.nowMs());
    if (r.state === "corroborated") found.push(sha);
  }
  if (checked === 0) return null;
  c.res.verified += 1;
  const marked = found.length === 0 ? null : await underSameStep<LinkRecord>(c, rec, step, (cur, nowIso, nowMs) => {
    const known = corroboratedMark(cur)?.shas ?? new Set<string>();
    const added = found.filter((s) => !known.has(s));
    if (added.length === 0) return null;
    const next = clone(cur);
    next.notices.corroborated = { shas: [...known, ...added], at: nowIso };
    addHistory(next, nowIso, "corroborated_by_pump", `${added.join(",")} awaiting the controller's ingest`);
    refreshNext(c, next, nowMs);
    return { write: next, value: next };
  });
  c.res.lines.push(`PUMP_VERIFY request=${rec.request_id} role=${rec.role} checked=${checked} corroborated=${found.length}`);
  return marked;
}

/**
 * The local notice text (§9.3). CL-19 / CL-10: two lines — the marker, the kind and the record's validated
 * identity fields (request id, role, peer label, state, task ids), a fixed description — and the one fixed next
 * command `bin/controller-link.sh status --request <id>`. No file path, no stored free text, no command built
 * from stored text; what to do is read from the record by `status`. `_ingestFile` is ignored (kept so existing
 * callers compile): a notice never names the stored copy's path.
 */
export function renderControllerNotice(rec: LinkRecord, kind: NoticeKind, n: number, _ingestFile: string | null = null): string {
  const id = rec.request_id;
  const reason = (REFUSE_REASONS as readonly unknown[]).includes(rec.refuse_reason) ? String(rec.refuse_reason) : "-";
  const what: Record<NoticeKind, string> = {
    stalled: "reconciliation stopped; nothing more is sent automatically; a human decides (resend or close)",
    conflict: "two corroborated copies of one message have different bytes; nothing was sent; held for a human",
    refused: `the peer refused this request (reason=${reason})`,
    peer_unconfigured: 'the peer is not configured with link "v1"; nothing is sent for this record and its state is kept',
    corroborated: `a ${rec.role === "receiver" ? "REQUEST" : "REPLY"} from the peer stored unverified is now corroborated by ` +
      "this machine's telepty audit; it has not been shown or applied; this notice repeats until the record shows it was picked up",
    reply_awaiting: "a REPLY from the peer was applied by ingest but is not yet recorded as handled; " +
      "this notice repeats until the record shows it was handled",
    reply_unverified: "a REPLY from the peer is still not corroborated by this machine's telepty audit after 48 h; " +
      "it is not acted on and the record's state is kept",
    unbound: "a peer request waits for bind or refuse",
    no_final: "your bound task has no final REPLY yet",
  };
  return `${NOTICE_MARKER} ${kind.toUpperCase()} request_id=${id} role=${rec.role} peer=${rec.peer} state=${rec.state} ` +
    `sender_task=${rec.sender_task} receiver_task=${rec.receiver_task ?? "-"} n=${n} — ${what[kind]}\nnext: ${SHIM} status --request ${id}`;
}

/**
 * §9.1 / CL3-04: claim, re-check the pass deadline (the claim's lock wait may have used the notice's time: then the
 * claim is released unsent and uncounted and the notice is left for the next pass), inject through the pass runner,
 * then settle the claim. Returns the record after the settlement, or null when nothing was posted.
 */
async function doRemind(c: PumpCtx, rec: LinkRecord, step: Extract<Step, { kind: "remind" }>): Promise<LinkRecord | null> {
  const claimed = await underSameStep<{ rec: LinkRecord; at: string }>(c, rec, step, (cur, nowIso) => {
    const next = clone(cur);
    next.notices.claim = { owner: c.owner, at: nowIso, kind: step.notice, anchor: step.anchor };
    return { write: next, value: { rec: next, at: nowIso } };
  });
  if (claimed === null) return null;
  const settle = (r: InjectResult | null): Promise<LinkRecord | null> => c.store.mutate<LinkRecord | null>(refOf(rec), (cur) => {
    if (cur === null) return { write: null, value: null };
    const claim = noticeClaimOf(cur);
    if (claim === null || claim.owner !== c.owner || claim.at !== claimed.at) return { write: null, value: cur };
    const next = clone(cur);
    if (r !== null) countNotice(next, claim.kind, claim.anchor, claim.at, submitOutcome(r), parseInjectId(r.stdout) || null);
    next.notices.claim = null;
    return { write: next, value: next };
  });
  if (!noticeFits(c)) {
    defer(c, rec, step);
    await settle(null);
    return null;
  }
  c.res.notices += 1;
  const s = noticeSeriesOf(claimed.rec, noticeSlot(step.notice));
  const n = (s !== null && s.kind === step.notice && s.anchor === step.anchor ? s.n : 0) + 1;
  const r = await c.notice.inject(c.cfg.self.controller_sid, renderControllerNotice(claimed.rec, step.notice, n));
  const submit = submitOutcome(r);
  const injectId = parseInjectId(r.stdout) || null;
  // A notice telepty refused (rc ≠ 0) is not counted: it is due again next pass. CL3-04: one killed by its timeout
  // (rc null) may have been delivered: it is counted with submit=unknown, as an expired claim is, and not re-posted at once.
  const after = await settle(r.rc === 0 || r.rc === null ? r : null);
  c.res.lines.push(`PUMP_NOTICE request=${rec.request_id} role=${rec.role} kind=${step.notice} n=${n} rc=${r.rc ?? "null"} ` +
    `submit=${submit} inject_id=${injectId ?? "null"}`);
  return after;
}

// ---------------------------------------------------------------------------------------------
// One pass

function sendFits(c: PumpCtx): boolean {
  return c.res.sends < PASS_SENDS_MAX && c.deps.monoMs() - c.t0 + SEND_TIMEOUT_MS <= PASS_WALL_MS;
}

function noticeFits(c: PumpCtx): boolean {
  return c.res.notices < PASS_NOTICES_MAX && c.deps.monoMs() - c.t0 + NOTICE_TIMEOUT_MS <= PASS_WALL_MS;
}

/** CL-08: one corroboration re-check (an audit query, no cross-machine send) starts only if its worst case fits. */
function auditFits(c: PumpCtx): boolean {
  return c.deps.monoMs() - c.t0 + AUDIT_CHECK_MS <= PASS_WALL_MS;
}

/** CL-08: the pass's single deadline, checked before every step (local ones included). */
function pastDeadline(c: PumpCtx): boolean {
  return c.deps.monoMs() - c.t0 >= PASS_WALL_MS;
}

function defer(c: PumpCtx, rec: LinkRecord, step: Step): void {
  c.res.deferred += 1;
  c.res.lines.push(`PUMP_DEFERRED request=${rec.request_id} role=${rec.role} step=${step.kind} reason=pass_budget`);
}

async function processRecord(c: PumpCtx, first: LinkRecord): Promise<void> {
  let next: LinkRecord | null = first;
  let noticed: string | null = null;
  for (let i = 0; i < RECORD_STEPS_MAX; i++) {
    if (next === null) return;
    const rec: LinkRecord = next;
    const step = decide(rec, c.facts(rec, c.deps.clock.nowMs()));
    if (step.kind === "none") return;
    // CL3-03: after a notice only another due notice (the record's other slot) follows in this pass, never the same one.
    if (noticed !== null && (step.kind !== "remind" || stepKey(step) === noticed)) return;
    if (pastDeadline(c)) {
      defer(c, rec, step);
      return;
    }
    switch (step.kind) {
      case "recover":
        next = await applyRecover(c, rec, step);
        break;
      case "stall":
        next = await applyStall(c, rec, step);
        break;
      case "probe":
        if (sendFits(c)) await doProbe(c, rec, step);
        else defer(c, rec, step);
        return;
      case "resend":
        if (sendFits(c)) await doResend(c, rec, step);
        else defer(c, rec, step);
        return;
      case "verify":
        // Local (no send); each audit query checks the deadline itself (auditFits). A new corroboration
        // continues to its `corroborated` notice in this pass (CL-05).
        next = await doVerify(c, rec, step);
        break;
      default:
        if (!noticeFits(c)) {
          defer(c, rec, step);
          return;
        }
        next = await doRemind(c, rec, step);
        noticed = stepKey(step);
        break;
    }
  }
}

/**
 * CL-08: the runner every child of this pass uses (a send, an audit query, a notice). Its timeout is cut to the time
 * left before the pass deadline minus the runner's kill grace (send.ts KILL_GRACE_MS), so the deadline kills
 * the child; with no time left the child is not started. Either way the runner reports rc null: a send is
 * classified `unknown` (send.ts classifySend), an audit query `audit_unavailable` — never a definite refusal.
 */
function passRunner(deps: PumpDeps, t0: number): ProcessRunner {
  return {
    run(bin, argv, opts) {
      const left = PASS_WALL_MS - (deps.monoMs() - t0) - KILL_GRACE_MS;
      if (!(left >= 1)) {
        return Promise.resolve({ rc: null, stdout: "", stderr: "\n[controller-link] not started: pass deadline", truncated: false });
      }
      return deps.runner.run(bin, argv, { ...opts, timeoutMs: Math.min(opts.timeoutMs, left) });
    },
  };
}

/** CL-18: a record's place in the rotation — the store's list order (outbox, then inbox by peer label, by id). */
const visitKey = (rec: LinkRecord): string =>
  rec.role === "sender" ? `0\u0000\u0000${rec.request_id}` : `1\u0000${rec.peer}\u0000${rec.request_id}`;
const byVisitKey = (a: LinkRecord, b: LinkRecord): number => {
  const x = visitKey(a);
  const y = visitKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

async function readCursor(c: PumpCtx): Promise<string | null> {
  try {
    const v: unknown = JSON.parse(await fsp.readFile(path.join(path.dirname(c.store.markerPath), CURSOR_FILE), "utf8"));
    const next = v !== null && typeof v === "object" ? (v as { v?: unknown; next?: unknown }) : null;
    return next !== null && next.v === 1 && typeof next.next === "string" && next.next.length <= 128 ? next.next : null;
  } catch {
    return null; // absent or unreadable: start at the first record
  }
}

/** Best effort: a cursor that cannot be saved costs fairness for one pass, never correctness. */
async function saveCursor(c: PumpCtx, next: string): Promise<void> {
  if (!fs.existsSync(c.store.markerPath)) return;
  try {
    await atomicWrite(path.join(path.dirname(c.store.markerPath), CURSOR_FILE),
      Buffer.from(JSON.stringify({ v: 1, next })), { sessionId: randomUUID() });
  } catch {
    c.res.lines.push("PUMP_CURSOR not saved; the next pass starts at the first record");
  }
}

/** One pass over every record (SPEC §9). Throws CliError (config) / StoreError (store) for the whole pass. */
export async function pumpOnce(deps: PumpDeps): Promise<PassResult> {
  const res: PassResult = {
    records: 0, sends: 0, notices: 0, recovered: 0, stalled: 0, verified: 0, deferred: 0, errors: [], lines: [],
  };
  const cfg = loadPeerConfig(deps.env, deps.packageRoot);
  const store = new ControllerLinkStore({ root: resolveStoreRoot(deps.env, deps.packageRoot), clock: deps.clock });
  const t0 = deps.monoMs();
  const runner = passRunner(deps, t0);
  const c: PumpCtx = {
    deps, cfg, store, owner: `${deps.proc.pid}@${deps.proc.host}`, t0, res, runner,
    audit: deps.auditWith === undefined ? deps.audit : deps.auditWith(runner),
    notice: deps.noticeWith === undefined ? deps.notice : deps.noticeWith(runner),
    facts: (rec, nowMs) => ({ nowMs, peerActive: activePeer(cfg, rec.peer) !== null, goneOwners: goneOwnersOf(rec, deps) }),
  };
  const records = (await store.list()).sort(byVisitKey);
  res.records = records.length;
  // CL-18: the pass starts at the cursor (the first record whose key is not before it) and visits at most
  // PASS_RECORDS_MAX records in rotation. The next pass starts at the first record this one deferred, else at the
  // first one it did not reach; a pass that visited every record without deferring one leaves the cursor as is.
  const from = await readCursor(c);
  const start = from === null ? 0 : Math.max(0, records.findIndex((r) => visitKey(r) >= from));
  const order = [...records.slice(start), ...records.slice(0, start)];
  let resume: string | null = null;
  for (let i = 0; i < order.length; i++) {
    const rec = order[i]!;
    if (i >= PASS_RECORDS_MAX) {
      resume ??= visitKey(rec);
      res.lines.push(`PUMP_DEFERRED records=${order.length - i} reason=pass_record_limit`);
      break;
    }
    if (pastDeadline(c)) {
      resume ??= visitKey(rec);
      res.errors.push("pass_deadline");
      res.lines.push("PUMP_DEADLINE remaining records are left for the next pass");
      break;
    }
    const deferred = res.deferred;
    try {
      await processRecord(c, rec);
    } catch (e) {
      const code = e instanceof StoreError || e instanceof CliError ? e.code : "exception";
      res.errors.push(`${id8(rec)}:${code}`);
      res.lines.push(`PUMP_ERROR request=${rec.request_id} role=${rec.role} error=${oneLine(e instanceof Error ? e.message : String(e))}`);
    }
    if (res.deferred > deferred) resume ??= visitKey(rec);
  }
  if (resume !== null) await saveCursor(c, resume);
  return res;
}

function summary(r: PassResult): string {
  return `controller-link pump: records=${r.records} sends=${r.sends} notices=${r.notices} recovered=${r.recovered} ` +
    `stalled=${r.stalled} verified=${r.verified} deferred=${r.deferred} errors=${r.errors.length > 0 ? r.errors.join(",") : "none"}`;
}

async function onePass(deps: PumpDeps): Promise<number> {
  if (deps.env[PUMP_SWITCH_ENV] === "0") {
    deps.out(`controller-link pump: disabled (${PUMP_SWITCH_ENV}=0); nothing read, nothing sent`);
    return EXIT.OK;
  }
  try {
    const res = await pumpOnce(deps);
    for (const l of res.lines) deps.out(l);
    deps.out(summary(res));
    return res.errors.length > 0 ? EXIT.STATE : EXIT.OK;
  } catch (e) {
    if (e instanceof CliError) {
      deps.err(`controller-link: ${e.message}`);
      return e.exit;
    }
    if (e instanceof StoreError) {
      deps.err(`controller-link: ${e.message}`);
      return EXIT.STORE;
    }
    deps.err(`controller-link: pump pass failed: ${oneLine(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}

/** `pump --once | --loop <seconds>`. Exit (last pass): 0 ok, 3 some record failed, 4 usage, 9 store/config. */
export async function runPump(argv: readonly string[], deps: PumpDeps): Promise<number> {
  let loopSeconds = 0;
  if (argv.length === 1 && argv[0] === "--once") loopSeconds = 0;
  else if (argv.length === 2 && argv[0] === "--loop" && LOOP_SECONDS_RE.test(argv[1]!)) loopSeconds = Number(argv[1]);
  else {
    deps.err(`controller-link: USAGE: ${PUMP_USAGE}`);
    return EXIT.REFUSED;
  }
  for (let pass = 1; ; pass++) {
    const rc = await onePass(deps);
    if (loopSeconds === 0 || (deps.maxPasses !== undefined && pass >= deps.maxPasses)) return rc;
    await deps.sleep(loopSeconds * 1000);
  }
}

/**
 * CL3-04: the local notice inject — the report pump's argv (`inject --submit --no-submit-force --submit-retry 2
 * --from controller-link <sid> <text>`) and child env — run by a ProcessRunner, so the pass runner cuts its
 * timeout to the time left and kills it like a send. A spawn failure is rc 127 (not delivered), as the report
 * pump's port reports it; a kill by the timeout stays rc null (outcome unknown).
 */
export function runnerNoticePort(runner: ProcessRunner, bin: string, env: NodeJS.ProcessEnv): NoticePort {
  return {
    async inject(dest, text) {
      const r = await runner.run(bin, ["inject", "--submit", "--no-submit-force", "--submit-retry", "2", "--from", SEND_FROM, dest, text],
        { env: teleptyChildEnv(env), timeoutMs: NOTICE_TIMEOUT_MS });
      const spawnFailed = r.rc === null && /\n\[controller-link\] spawn (?:failed|error):/.test(r.stderr);
      return { rc: spawnFailed ? 127 : r.rc, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** Production pump ports added to the CLI's dependencies. */
export function defaultPumpDeps(cli: CliDeps): PumpDeps {
  return {
    ...cli,
    monoMs: () => performance.now(),
    pidAlive: defaultPidAlive,
    notice: runnerNoticePort(cli.runner, cli.teleptyBin, cli.env),
    noticeWith: (runner) => runnerNoticePort(runner, cli.teleptyBin, cli.env),
    auditWith: (runner) => defaultAuditReader(runner, cli.teleptyBin, cli.env),
    sleep: (msv) => new Promise<void>((resolve) => { setTimeout(resolve, msv); }),
    localHosts: [...new Set([cli.proc.host, os.hostname()])],
  };
}

/** Entry from cli.ts `runCli` for `pump`. */
export async function runPumpCli(argv: readonly string[], cli: CliDeps): Promise<number> {
  return runPump(argv, defaultPumpDeps(cli));
}

// ---------------------------------------------------------------------------------------------
// resend --request <U> --reason "<text>" (§9.2 last paragraph; human, from `stalled` only)

export function parseResendArgs(argv: readonly string[]): { requestId: string; reason: string } {
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const val = argv[i + 1];
    if ((flag !== "--request" && flag !== "--reason") || val === undefined || v.has(flag)) {
      throw new CliError("USAGE", `unknown, repeated or valueless argument for resend: '${flag.slice(0, 32)}'`);
    }
    v.set(flag, val);
  }
  const requestId = v.get("--request");
  const reason = v.get("--reason")?.trim();
  if (requestId === undefined || !REQUEST_ID_RE.test(requestId)) throw new CliError("USAGE", "--request <request id> is required");
  if (reason === undefined || reason === "") throw new CliError("USAGE", "--reason \"<text>\" is required");
  if (reason.length > RESEND_REASON_MAX || REASON_FORBIDDEN_RE.test(reason)) {
    throw new CliError("USAGE", `--reason must be one line of at most ${RESEND_REASON_MAX} characters without control or fence characters`);
  }
  return { requestId, reason };
}

/** The message a human re-send repeats: the sender's unsettled REQUEST-1, or the receiver's newest REPLY not ACKed `received`. */
export function resendTarget(rec: LinkRecord): string | null {
  const unsettled = (k: string): boolean => {
    const ack = rec.acks_in[k];
    return (rec.messages[k]?.sends?.length ?? 0) > 0 && (ack === undefined || !SETTLING_ACK_STATES.includes(ack.state));
  };
  if (rec.role === "sender") return unsettled("REQUEST-1") ? "REQUEST-1" : null;
  const keys = Object.keys(rec.messages).filter((k) => k.startsWith("REPLY-")).sort((x, y) => Number(y.slice(6)) - Number(x.slice(6)));
  return keys.find(unsettled) ?? null;
}

async function humanResend(c: SendCtx, id: string, reason: string): Promise<number> {
  const recs = (await c.store.list()).filter((r) => r.request_id === id);
  if (recs.length === 0) throw new CliError("STATE_INVALID", `no record for request ${id}`);
  if (recs.length > 1) throw new CliError("STATE_INVALID", `request ${id} names more than one record`);
  const found = recs[0]!;
  if (found.state !== "stalled") throw new CliError("STATE_INVALID", `request ${id} is '${found.state}', resend needs 'stalled'`);
  const peer = activePeer(c.cfg, found.peer);
  if (peer === null) throw new CliError("STATE_INVALID", `peer ${found.peer} is not configured with link v1; nothing changed`);
  const key = resendTarget(found);
  if (key === null) throw new CliError("STATE_INVALID", `request ${id} has no unsettled message of yours to re-send; use close`);
  const sha = found.messages[key]!.sha256;
  const raw = await c.store.readRaw(sha);
  if (raw === null) throw new StoreError("STORE_CORRUPT", "a message's raw file is missing");
  const p = await c.store.mutate<PendingSend>(refOf(found), (cur, m) => {
    if (cur === null || cur.state !== "stalled") throw new CliError("STATE_INVALID", `request ${id} is no longer 'stalled'`);
    if (resendTarget(cur) !== key || cur.messages[key]!.sha256 !== sha) throw new CliError("STATE_INVALID", `request ${id} changed; nothing sent`);
    const next = clone(cur);
    const entry = next.messages[key]!;
    const sends = entry.sends ?? [];
    if (sends.some((a) => a.result === "pending")) throw new CliError("STATE_INVALID", `request ${id} has an attempt in flight`);
    const n = Math.max(0, ...sends.map((x) => x.n)) + 1;
    sends.push({ n, at: m.nowIso, owner: c.owner, result: "pending", trigger: "human", ack_seq: next.acks_in[key]?.last_seq ?? 0 });
    entry.sends = sends;
    setState(next, next.role === "sender" ? "sent" : "replying", m.nowIso); // §7.1 / §7.2: stalled → sent / replying (resend)
    addHistory(next, m.nowIso, "resend", `${key} n=${n} human reason=${reason}`);
    refreshNext(c, next, m.nowMs);
    return { write: next, value: { ref: refOf(next), slot: { where: "message", key }, n, text: raw.toString("utf8"), target: peer.target } };
  });
  const cls = await deliver(c, p);
  c.deps.out(`OK resend request=${id} ref=${key} n=${p.n} send=${sendWord(cls)}`);
  if (cls.result === "handed_over") return EXIT.OK;
  if (cls.result === "unknown") {
    c.deps.err(`PEER_DELIVERY_UNKNOWN: request ${id} ${key} — ${cls.detail ?? "result unknown"}; ${RECONCILE}`);
    return EXIT.DELIVERY_UNKNOWN;
  }
  c.deps.err(`PEER_NOT_DELIVERED: request ${id} ${key} definitely refused (${cls.detail ?? "-"}); ${RECONCILE}`);
  return EXIT.NOT_DELIVERED;
}

/** Entry from cli.ts `runCli` for `resend`. Exit: 0, 3, 4, 7, 9, 11 (as `probe`). */
export async function runResendCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    const a = parseResendArgs(argv);
    const cfg = loadPeerConfig(deps.env, deps.packageRoot);
    const store = new ControllerLinkStore({ root: resolveStoreRoot(deps.env, deps.packageRoot), clock: deps.clock });
    const c: SendCtx = {
      deps, cfg, store, owner: `${deps.proc.pid}@${deps.proc.host}`,
      facts: (rec, nowMs) => ({ nowMs, peerActive: activePeer(cfg, rec.peer) !== null, goneOwners: new Set<string>() }),
    };
    return await humanResend(c, a.requestId, a.reason);
  } catch (e) {
    if (e instanceof CliError) {
      deps.err(`controller-link: ${e.message}`);
      if (e.code === "USAGE") deps.err(RESEND_USAGE);
      return e.exit;
    }
    if (e instanceof StoreError) {
      deps.err(`controller-link: ${e.message}`);
      return EXIT.STORE;
    }
    throw e;
  }
}
