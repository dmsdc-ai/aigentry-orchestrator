// Task 1294 — controller-link pump decision (U8, pure src/controller-link/decide.ts): TEST-PLAN §2.8
// P1 (exact schedules), P2 (property: no re-send without an allowed trigger, always the same sha),
// P3 (queued wait), P4 (stall + notice schedule), P5 (notice offsets), P6 (unconfigured peer), plus the
// §6.2 pending recovery rule; v1 expires nothing (no retention). Records are plain objects; nothing touches
// the filesystem, a clock or a process: the clock and the owner facts are arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANSWER_RESENDS_MAX, NO_ACK_STALL_MS, PENDING_MAX_AGE_MS, QUEUED_WAIT_MS, REFUSAL_STALL_MS,
  decide, nextPoint, noticeSlot, type DecideFacts, type NoticeKind, type Step,
} from "../../src/controller-link/decide.js";
import { RECEIVER_STATES, SENDER_STATES } from "../../src/controller-link/store.js";
import type { LinkRecord, RecordState, SendAttempt } from "../../src/controller-link/store.js";

const T0 = Date.parse("2026-11-22T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();
const ID = "3f2b8c1e-9a4d-4c2b-8e1f-0a1b2c3d4e5f";
const SHA = "a".repeat(64);
const OTHER_SHA = "c".repeat(64);
const ME = "4242@test-host";
const DEAD = "999@test-host";

function attempt(n: number, atMs: number, result: SendAttempt["result"], over: Record<string, unknown> = {}): SendAttempt {
  const a: SendAttempt = { n, at: iso(atMs), owner: ME, result, submit: result === "handed_over" ? "consumed" : null, inject_id: null, detail: null };
  return Object.assign(a, over);
}

function base(role: "sender" | "receiver", state: RecordState, key: string, sends: SendAttempt[]): LinkRecord {
  const messages: LinkRecord["messages"] = role === "sender"
    ? { "REQUEST-1": { sha256: SHA, body_sha256: "b".repeat(64), raw: `raw/${SHA}.env`, sends } }
    : {
      "REQUEST-1": { sha256: OTHER_SHA, body_sha256: "d".repeat(64), raw: `raw/${OTHER_SHA}.env`, ingested_at: iso(T0 - HOUR),
        corroboration: { state: "corroborated", at: iso(T0 - HOUR), inject_id: null, checks: 1 } },
      [key]: { sha256: SHA, body_sha256: "b".repeat(64), raw: `raw/${SHA}.env`, outcome: "done", final: "yes", sends },
    };
  return {
    v: 1, role, request_id: ID, peer: "linux", peer_target: "orchestrator@linux-box", self_label: "mac",
    sender_task: "1291", receiver_task: role === "receiver" ? "2026112102" : null, state, state_at: iso(T0),
    next_action: { code: "WAIT_ACK", due_at: iso(T0), text: "" }, messages, acks_in: {}, probes_out: {},
    acks_out: { last_seq: 0, sends: [] }, notices: { n: 0, last_at: null }, history: [], history_dropped: 0,
  };
}

const sender = (sends: SendAttempt[], state: RecordState = "sent"): LinkRecord => base("sender", state, "REQUEST-1", sends);
const receiver = (sends: SendAttempt[], state: RecordState = "replying"): LinkRecord => base("receiver", state, "REPLY-1", sends);

function facts(nowMs: number, over: Partial<DecideFacts> = {}): DecideFacts {
  return { nowMs, peerActive: true, goneOwners: new Set<string>(), ...over };
}

function addProbe(rec: LinkRecord, key: string, atMs: number): void {
  const slot = rec.probes_out[key] ?? { last_seq: 0, sends: [] };
  slot.last_seq += 1;
  slot.sends.push(attempt(slot.last_seq, atMs, "handed_over"));
  rec.probes_out[key] = slot;
}

function addAck(rec: LinkRecord, key: string, state: string, atMs: number): void {
  const seq = (rec.acks_in[key]?.last_seq ?? 0) + 1;
  rec.acks_in[key] = { last_seq: seq, state, at: iso(atMs) };
  rec.history.push({ at: iso(atMs), event: "ack_in", detail: `${key} seq=${seq} state=${state}` });
}

/** As pump.ts countNotice: the kind's own slot (`notices.series` repeating, `notices.once` one-shot; CL3-03). */
function countNotice(rec: LinkRecord, kind: NoticeKind, anchor: string, atMs: number): void {
  const s = rec.notices[noticeSlot(kind)] as { kind?: string; anchor?: string; n?: number } | null | undefined;
  const n = s !== undefined && s !== null && s.kind === kind && s.anchor === anchor ? (s.n ?? 0) + 1 : 1;
  rec.notices[noticeSlot(kind)] = { kind, anchor, n, last_at: iso(atMs) };
  rec.notices.n += 1;
  rec.notices.last_at = iso(atMs);
}

const sendsOf = (rec: LinkRecord, key: string): SendAttempt[] => rec.messages[key]!.sends!;
const latest = (rec: LinkRecord, key: string): SendAttempt => sendsOf(rec, key)[sendsOf(rec, key).length - 1]!;

// ── P1 schedules ─────────────────────────────────────────────────────────────────────────
test("P1 probe schedule: +5, 15, 30, 60 min after the latest attempt, then every 3 h; 48 h without ACK -> stalled (19 probes)", () => {
  const rec = sender([attempt(1, T0, "handed_over")]);
  assert.equal(decide(rec, facts(T0 + 5 * MIN - 1)).kind, "none", "not before +5 min");
  assert.deepEqual(decide(rec, facts(T0 + 5 * MIN)), { kind: "probe", key: "REQUEST-1" });
  const probes: number[] = [];
  let stalledAt: number | null = null;
  for (let t = T0; t <= T0 + NO_ACK_STALL_MS + HOUR && stalledAt === null; t += MIN) {
    const s = decide(rec, facts(t));
    if (s.kind === "probe") {
      probes.push((t - T0) / MIN);
      addProbe(rec, "REQUEST-1", t);
    } else if (s.kind === "stall") {
      stalledAt = t;
    } else {
      assert.equal(s.kind, "none", `only probes, then the stall (got ${s.kind} at +${(t - T0) / MIN} min)`);
    }
  }
  const expected = [5, 15, 30, 60];
  for (let h = 4; h < 48; h += 3) expected.push(h * 60);
  assert.deepEqual(probes, expected);
  assert.equal(probes.length, 19);
  assert.equal(stalledAt, T0 + NO_ACK_STALL_MS);
});

test("P1 re-send back-off after definite refusals: +1, 2, 5, 10, 20, 30 min, then every 60 min; 24 h of refusals -> stalled", () => {
  const rec = sender([attempt(1, T0, "refused_definite")], "send_refused");
  assert.equal(decide(rec, facts(T0 + MIN - 1)).kind, "none");
  const resends: number[] = [];
  let stalledAt: number | null = null;
  for (let t = T0; t <= T0 + REFUSAL_STALL_MS + HOUR && stalledAt === null; t += MIN) {
    const s = decide(rec, facts(t));
    if (s.kind === "resend") {
      assert.equal(s.trigger, "refused_definite");
      assert.equal(s.sha256, SHA, "the same raw bytes");
      resends.push((t - T0) / MIN);
      const sends = sendsOf(rec, "REQUEST-1");
      sends.push(attempt(sends.length + 1, t, "refused_definite", { trigger: "refused_definite" }));
    } else if (s.kind === "stall") {
      stalledAt = t;
    } else {
      assert.equal(s.kind, "none");
    }
  }
  assert.deepEqual(resends.slice(0, 8), [1, 3, 8, 18, 38, 68, 128, 188]);
  const gaps = resends.map((m, i) => m - (i === 0 ? 0 : resends[i - 1]!));
  assert.deepEqual(gaps.slice(0, 7), [1, 2, 5, 10, 20, 30, 60]);
  assert.ok(gaps.slice(6).every((g) => g === 60), "every 60 min after the sixth");
  assert.equal(stalledAt, T0 + REFUSAL_STALL_MS);
});

test("P1 nextPoint: smallest point after the last one, never a burst after a gap", () => {
  const offs = [5 * MIN, 15 * MIN];
  assert.equal(nextPoint(T0, offs, HOUR, null), T0 + 5 * MIN);
  assert.equal(nextPoint(T0, offs, HOUR, T0 + 5 * MIN), T0 + 15 * MIN);
  assert.equal(nextPoint(T0, offs, HOUR, T0 + 15 * MIN), T0 + 75 * MIN);
  assert.equal(nextPoint(T0, offs, HOUR, T0 + 10 * HOUR), T0 + 10 * HOUR + 15 * MIN);
  assert.equal(nextPoint(T0, [0], null, T0), null);
});

// ── P2 property ──────────────────────────────────────────────────────────────────────────
/** mulberry32: a small seeded PRNG so every run of the property test is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("P2 property: a re-send appears only after a definite refusal, an `unknown` answer or the second `unverified` answer (or a human), names the same sha, and consumes its trigger once even when the clock moves backward", () => {
  const RESULTS: SendAttempt["result"][] = ["handed_over", "unknown", "refused_definite", "pending"];
  const ACKS = ["received", "accepted", "refused", "unverified", "unknown"];
  let resendsSeen = 0;
  let uncertainChecks = 0;
  let rollbacks = 0;
  let answerResendsAfterRollback = 0;
  for (let run = 0; run < 400; run++) {
    const rnd = prng(0x1294 + run);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const role = run % 2 === 0 ? "sender" : "receiver";
    const key = role === "sender" ? "REQUEST-1" : "REPLY-1";
    const first = pick(RESULTS.filter((r) => r !== "pending"));
    const rec = role === "sender"
      ? sender([attempt(1, T0, first)], first === "handed_over" ? "sent" : first === "unknown" ? "send_unknown" : "send_refused")
      : receiver([attempt(1, T0, first)]);
    let now = T0;
    let answerResends = 0;
    const gone = new Set<string>();
    // The once-only trigger state (CL-01), kept by this oracle in EVENT ORDER, never by wall time:
    // `ackEv` = the event at which each ACK sequence arrived and its state; `attemptEv` = the event of
    // the latest attempt; `consumed` = ACK sequences an `ack_unknown` re-send has already spent.
    const ackEv = new Map<number, { ev: number; state: string }>();
    let attemptEv = -1;
    const consumed = new Set<number>();
    let rolledBack = false;
    // What pump.ts commits with every attempt: the ACK sequence seen at that moment.
    const ackSeqNow = (): number => rec.acks_in[key]?.last_seq ?? 0;
    for (let ev = 0; ev < 80; ev++) {
      const r = rnd();
      if (r < 0.25) {
        now += pick([MIN, 5 * MIN, 17 * MIN, HOUR, 3 * HOUR, 11 * HOUR]);
      } else if (r < 0.3) {
        // the wall clock moves backward (NTP step, VM restore): ACK and attempt times stop being ordered
        now -= pick([MIN, 10 * MIN, 2 * HOUR]);
        rollbacks += 1;
        rolledBack = true;
      } else if (r < 0.45) {
        addAck(rec, key, pick(ACKS), now);
        ackEv.set(rec.acks_in[key]!.last_seq, { ev, state: rec.acks_in[key]!.state });
        const a = rec.acks_in[key]!.state;
        if (role === "sender" && !["refused", "replied", "closed", "stalled"].includes(rec.state)) {
          if (a === "received" && rec.state !== "accepted") rec.state = "received";
          if (a === "accepted") rec.state = "accepted";
          if (a === "refused") rec.state = "refused";
          if (a === "unverified" && !["received", "accepted"].includes(rec.state)) rec.state = "unverified_at_peer";
        }
      } else if (r < 0.52) {
        // a crash after §6.1 step 1 (dispatch, ingest answer or another pump): an orphaned pending attempt
        const sends = sendsOf(rec, key);
        sends.push(attempt(sends.length + 1, now, "pending", { owner: DEAD, ack_seq: ackSeqNow() }));
        attemptEv = ev;
        if (rnd() < 0.5) gone.add(DEAD); else gone.delete(DEAD);
      } else if (r < 0.55 && rec.state === "stalled") {
        // the human `resend` command (not a decision of decide()); recorded as trigger "human"
        const sends = sendsOf(rec, key);
        sends.push(attempt(sends.length + 1, now, pick(RESULTS.filter((x) => x !== "pending")), { trigger: "human", ack_seq: ackSeqNow() }));
        attemptEv = ev;
        rec.state = role === "sender" ? "sent" : "replying";
      } else {
        const s: Step = decide(rec, facts(now, { goneOwners: gone }));
        const last = latest(rec, key);
        const ack = rec.acks_in[key];
        const newer = [...ackEv.values()].filter((x) => x.ev > attemptEv);
        const unverifiedAfter = newer.filter((x) => x.state === "unverified").length;
        const unknownAnswer = ack !== undefined && ack.state === "unknown" && (ackEv.get(ack.last_seq)?.ev ?? -1) > attemptEv;
        if (last.result === "unknown" || last.result === "pending") {
          uncertainChecks += 1;
          if (s.kind === "resend") assert.notEqual(s.trigger, "refused_definite", "an uncertain send is never re-sent as a refusal");
        }
        if (s.kind === "resend") {
          resendsSeen += 1;
          assert.equal(s.key, key, "only the record's own obligation message");
          assert.equal(s.sha256, SHA, "always the same raw file");
          assert.equal(s.sha256, rec.messages[key]!.sha256);
          assert.notEqual(last.result, "pending", "never while an attempt may be in flight");
          assert.ok(!["stalled", "refused", "replied", "closed"].includes(rec.state), `no automatic re-send in ${rec.state}`);
          if (s.trigger === "refused_definite") {
            assert.equal(last.result, "refused_definite", "step 3 only after a definite refusal");
          } else if (s.trigger === "ack_unknown") {
            assert.ok(unknownAnswer, "step 6 only after an `unknown` answer newer than the latest attempt");
            assert.ok(answerResends < ANSWER_RESENDS_MAX, "at most 3 answer re-sends");
            assert.ok(!consumed.has(ack!.last_seq), "one `unknown` answer authorises one re-send, whatever the clock did (CL-01)");
            consumed.add(ack!.last_seq);
            if (rolledBack) answerResendsAfterRollback += 1;
          } else {
            assert.equal(s.trigger, "ack_unverified");
            assert.equal(ack?.state, "unverified");
            assert.ok(unverifiedAfter >= 2, "step 7 only after the second `unverified` answer newer than the latest attempt");
            assert.ok(answerResends < ANSWER_RESENDS_MAX, "at most 3 answer re-sends");
          }
          if (s.trigger !== "refused_definite") {
            answerResends += 1;
            rec.messages[key]!.answer_resends = answerResends;
          }
          const sends = sendsOf(rec, key);
          sends.push(attempt(sends.length + 1, now, pick(RESULTS), { trigger: s.trigger, ack_seq: ackSeqNow() }));
          attemptEv = ev;
        } else if (s.kind === "recover" && s.slot.where === "message") {
          const a = sendsOf(rec, s.slot.key).find((x) => x.n === s.n && x.result === "pending");
          assert.ok(a, "recover names a pending attempt");
          assert.ok(gone.has(a.owner) || now - Date.parse(a.at) >= PENDING_MAX_AGE_MS, "only a gone owner or an old attempt");
          a.result = "unknown";
        } else if (s.kind === "probe") {
          addProbe(rec, s.key, now);
        } else if (s.kind === "stall") {
          rec.state = "stalled";
          rec.state_at = iso(now);
        } else if (s.kind === "remind") {
          countNotice(rec, s.notice, s.anchor, now);
        }
      }
    }
  }
  assert.ok(resendsSeen > 20, `the property run exercised re-sends (${resendsSeen})`);
  assert.ok(uncertainChecks > 50, `the property run exercised uncertain sends (${uncertainChecks})`);
  assert.ok(rollbacks > 100, `the property run moved the clock backward (${rollbacks})`);
  assert.ok(answerResendsAfterRollback > 0, `the property run exercised answer re-sends after a rollback (${answerResendsAfterRollback})`);
});

test("P2 an `unknown` send with no answer is probed and never re-sent, for 48 h, then stalled", () => {
  const rec = sender([attempt(1, T0, "unknown")], "send_unknown");
  for (let t = T0; t < T0 + NO_ACK_STALL_MS; t += 7 * MIN) {
    const s = decide(rec, facts(t));
    assert.notEqual(s.kind, "resend");
    if (s.kind === "probe") addProbe(rec, "REQUEST-1", t);
  }
  assert.equal(decide(rec, facts(T0 + NO_ACK_STALL_MS)).kind, "stall");
});

test("P2 step 6: one re-send per `unknown` answer newer than the latest attempt, at most 3 in total", () => {
  // older than the attempt: the attempt was committed after ACK seq 1 arrived (its ack_seq) — no re-send
  const rec = sender([attempt(1, T0, "handed_over", { ack_seq: 1 })]);
  addAck(rec, "REQUEST-1", "unknown", T0 - MIN);
  assert.notEqual(decide(rec, facts(T0 + MIN)).kind, "resend");
  let t = T0;
  for (let i = 1; i <= 4; i++) {
    t += 10 * MIN;
    addAck(rec, "REQUEST-1", "unknown", t);
    const s = decide(rec, facts(t + 1));
    if (i <= ANSWER_RESENDS_MAX) {
      assert.deepEqual(s, { kind: "resend", key: "REQUEST-1", trigger: "ack_unknown", sha256: SHA });
      rec.messages["REQUEST-1"]!.answer_resends = i;
      sendsOf(rec, "REQUEST-1").push(attempt(i + 1, t + 1, "handed_over", { trigger: "ack_unknown", ack_seq: rec.acks_in["REQUEST-1"]!.last_seq }));
      assert.notEqual(decide(rec, facts(t + 2)).kind, "resend", "once per answer");
    } else {
      assert.notEqual(s.kind, "resend", "the fourth answer re-send is refused");
    }
  }
});

test("P2 step 7: the first `unverified` answer keeps probing; the second newer one re-sends", () => {
  const rec = sender([attempt(1, T0, "handed_over")], "unverified_at_peer");
  addAck(rec, "REQUEST-1", "unverified", T0 + 6 * MIN);
  assert.notEqual(decide(rec, facts(T0 + 7 * MIN)).kind, "resend");
  addAck(rec, "REQUEST-1", "unverified", T0 + 16 * MIN);
  assert.deepEqual(decide(rec, facts(T0 + 17 * MIN)), { kind: "resend", key: "REQUEST-1", trigger: "ack_unverified", sha256: SHA });
});

test("CL-01 step 6 after a backward clock step: one `unknown` answer authorises exactly one re-send; the next answer (by sequence) the next", () => {
  const rec = sender([attempt(1, T0, "unknown")], "send_unknown");
  addAck(rec, "REQUEST-1", "unknown", T0 + 30 * MIN); // seq 1
  // the sender's wall clock moves back 10 min; the re-send consuming seq 1 is committed at T0 + 20 min
  assert.deepEqual(decide(rec, facts(T0 + 20 * MIN)), { kind: "resend", key: "REQUEST-1", trigger: "ack_unknown", sha256: SHA });
  rec.messages["REQUEST-1"]!.answer_resends = 1;
  sendsOf(rec, "REQUEST-1").push(attempt(2, T0 + 20 * MIN, "unknown", { trigger: "ack_unknown", ack_seq: 1 }));
  for (let t = T0 + 20 * MIN; t < T0 + 3 * HOUR; t += MIN) {
    assert.notEqual(decide(rec, facts(t)).kind, "resend", `ACK seq 1 is spent (its wall time is later than the re-send) at +${(t - T0) / MIN} min`);
  }
  addAck(rec, "REQUEST-1", "unknown", T0 + 10 * MIN); // seq 2: newer by sequence although its wall time is older
  assert.deepEqual(decide(rec, facts(T0 + 3 * HOUR)), { kind: "resend", key: "REQUEST-1", trigger: "ack_unknown", sha256: SHA });
});

test("CL-01 step 7 counts `unverified` answers by sequence after the latest attempt, not by wall time", () => {
  const rec = sender([attempt(1, T0, "handed_over"), attempt(2, T0 + HOUR, "handed_over", { trigger: "ack_unknown", ack_seq: 1 })],
    "unverified_at_peer");
  addAck(rec, "REQUEST-1", "unknown", T0 + 30 * MIN); // seq 1, consumed by attempt 2
  rec.messages["REQUEST-1"]!.answer_resends = 1;
  addAck(rec, "REQUEST-1", "unverified", T0 + 10 * MIN); // seq 2: after attempt 2, wall clock moved back
  assert.notEqual(decide(rec, facts(T0 + HOUR + MIN)).kind, "resend", "the first `unverified` answer keeps probing");
  addAck(rec, "REQUEST-1", "unverified", T0 + 20 * MIN); // seq 3
  assert.deepEqual(decide(rec, facts(T0 + HOUR + MIN)), { kind: "resend", key: "REQUEST-1", trigger: "ack_unverified", sha256: SHA });
});

test("CL-01 fail closed: a later attempt without a recorded ack_seq never authorises an answer re-send", () => {
  const rec = sender([attempt(1, T0, "unknown"), attempt(2, T0 + MIN, "unknown")], "send_unknown");
  addAck(rec, "REQUEST-1", "unknown", T0 + 10 * MIN);
  for (let t = T0 + 10 * MIN; t < T0 + 47 * HOUR; t += 10 * MIN) assert.notEqual(decide(rec, facts(t)).kind, "resend");
});

test("P2 settled messages and stalled records send nothing", () => {
  for (const st of ["received", "accepted", "refused"]) {
    const rec = sender([attempt(1, T0, "refused_definite")], "send_refused");
    addAck(rec, "REQUEST-1", st, T0 + MIN);
    const s = decide(rec, facts(T0 + 2 * HOUR));
    assert.ok(s.kind !== "resend" && s.kind !== "probe", st);
  }
  const stalled = sender([attempt(1, T0, "refused_definite")], "stalled");
  stalled.notices.series = { kind: "stalled", anchor: iso(T0), n: 1, last_at: iso(T0) };
  for (let t = T0; t < T0 + 3 * DAY; t += HOUR) {
    const s = decide(stalled, facts(t));
    assert.ok(s.kind === "none" || s.kind === "remind", `stalled: ${s.kind}`);
  }
});

// ── P3 queued ────────────────────────────────────────────────────────────────────────────
test("P3 handed_over/queued younger than 30 min: no probe; then the probe path", () => {
  const rec = sender([attempt(1, T0, "handed_over", { submit: "queued" })]);
  for (let t = T0; t < T0 + QUEUED_WAIT_MS; t += MIN) {
    const s = decide(rec, facts(t));
    assert.equal(s.kind, "none", `+${(t - T0) / MIN} min`);
  }
  assert.deepEqual(decide(rec, facts(T0 + QUEUED_WAIT_MS)), { kind: "probe", key: "REQUEST-1" });
  addProbe(rec, "REQUEST-1", T0 + QUEUED_WAIT_MS);
  assert.equal(decide(rec, facts(T0 + QUEUED_WAIT_MS + MIN)).kind, "none", "no burst of the missed points");
  assert.deepEqual(decide(rec, facts(T0 + HOUR)), { kind: "probe", key: "REQUEST-1" });
});

// ── P4 stall + notice ────────────────────────────────────────────────────────────────────
test("P4 limits -> stalled, then exactly one notice, repeated daily", () => {
  const rec = receiver([attempt(1, T0, "unknown")]);
  const at = T0 + NO_ACK_STALL_MS;
  assert.equal(decide(rec, facts(at)).kind, "stall");
  rec.state = "stalled";
  rec.state_at = iso(at);
  const first = decide(rec, facts(at));
  assert.deepEqual(first, { kind: "remind", notice: "stalled", anchor: iso(at) });
  countNotice(rec, "stalled", iso(at), at);
  for (let t = at; t < at + DAY; t += 30 * MIN) assert.equal(decide(rec, facts(t)).kind, "none", "exactly one notice per day");
  assert.equal(decide(rec, facts(at + DAY)).kind, "remind");
});

// ── P5 notices ───────────────────────────────────────────────────────────────────────────
function noticeTimes(rec: LinkRecord, from: number, to: number, stepMs: number, peerActive = true): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += stepMs) {
    const s = decide(rec, facts(t, { peerActive }));
    if (s.kind === "remind") {
      out.push((t - from) / MIN);
      countNotice(rec, s.notice, s.anchor, t);
    }
  }
  return out;
}

test("P5 inbox received unbound: +10 min, +30 min, then every 2 h", () => {
  const rec = base("receiver", "received", "REPLY-1", []);
  delete rec.messages["REPLY-1"];
  rec.receiver_task = null;
  assert.deepEqual(noticeTimes(rec, T0, T0 + 7 * HOUR, MIN), [10, 30, 150, 270, 390]);
});

test("P5 inbox accepted without a final REPLY: once a day", () => {
  const rec = base("receiver", "accepted", "REPLY-1", []);
  delete rec.messages["REPLY-1"];
  assert.deepEqual(noticeTimes(rec, T0, T0 + 3 * DAY, 10 * MIN), [1440, 2880, 4320]);
  const interim = receiver([attempt(1, T0, "handed_over")]);
  interim.messages["REPLY-1"]!.final = "no";
  interim.acks_in["REPLY-1"] = { last_seq: 1, state: "received", at: iso(T0 + MIN) };
  assert.deepEqual(noticeTimes(interim, T0, T0 + 2 * DAY, 10 * MIN), [1440, 2880], "replying with only interim REPLYs");
});

test("P5 stalled and CONFLICT: once, then daily; sender refused: once", () => {
  const stalled = sender([attempt(1, T0, "unknown")], "stalled");
  assert.deepEqual(noticeTimes(stalled, T0, T0 + 2 * DAY, 10 * MIN), [0, 1440, 2880]);
  const conflict = base("receiver", "accepted", "REPLY-1", []);
  delete conflict.messages["REPLY-1"];
  conflict.history.push({ at: iso(T0), event: "conflict", detail: "REQUEST-1 sha256=x" });
  assert.deepEqual(noticeTimes(conflict, T0, T0 + 2 * DAY, 10 * MIN), [0, 1440, 2880]);
  const refused = sender([attempt(1, T0, "handed_over")], "refused");
  assert.deepEqual(noticeTimes(refused, T0, T0 + 3 * DAY, 10 * MIN), [0]);
});

test("P5 a live notice claim is never taken over; an expired or orphaned one is recovered, not re-sent", () => {
  const rec = sender([attempt(1, T0, "unknown")], "stalled");
  rec.notices.claim = { owner: "77@other-host", at: iso(T0), kind: "stalled", anchor: iso(T0) };
  assert.equal(decide(rec, facts(T0 + 2 * MIN)).kind, "none");
  assert.deepEqual(decide(rec, facts(T0 + 3 * MIN)), { kind: "recover", slot: { where: "notice" }, n: 0, why: "lease_expired" });
  assert.deepEqual(decide(rec, facts(T0 + MIN, { goneOwners: new Set(["77@other-host"]) })),
    { kind: "recover", slot: { where: "notice" }, n: 0, why: "owner_gone" });
});

// ── P6 unconfigured peer ─────────────────────────────────────────────────────────────────
test("P6 peer no longer configured: no send, no state change, one notice", () => {
  const rec = sender([attempt(1, T0, "refused_definite")], "send_refused");
  sendsOf(rec, "REQUEST-1").push(attempt(2, T0, "pending", { owner: DEAD }));
  const steps: string[] = [];
  for (let t = T0; t < T0 + 2 * DAY; t += 10 * MIN) {
    const s = decide(rec, facts(t, { peerActive: false, goneOwners: new Set([DEAD]) }));
    steps.push(s.kind);
    if (s.kind === "remind") {
      assert.equal(s.notice, "peer_unconfigured");
      countNotice(rec, s.notice, s.anchor, t);
    }
  }
  assert.equal(steps.filter((k) => k === "remind").length, 1);
  assert.ok(steps.every((k) => k === "remind" || k === "none"), "no probe, re-send, recovery or stall");
});

// ── §6.2 pending recovery, §9.3 verify ──────────────────────────────────────
test("K-rule: a pending attempt is recovered when its same-host owner is gone or it is 10 min old; never re-sent at once", () => {
  const rec = sender([attempt(1, T0, "pending", { owner: DEAD })], "prepared");
  assert.equal(decide(rec, facts(T0 + MIN)).kind, "none", "owner may be alive: wait");
  assert.deepEqual(decide(rec, facts(T0 + MIN, { goneOwners: new Set([DEAD]) })),
    { kind: "recover", slot: { where: "message", key: "REQUEST-1" }, n: 1, why: "owner_gone" });
  assert.deepEqual(decide(rec, facts(T0 + PENDING_MAX_AGE_MS)),
    { kind: "recover", slot: { where: "message", key: "REQUEST-1" }, n: 1, why: "older_than_10_min" });
  latest(rec, "REQUEST-1").result = "unknown";
  rec.state = "send_unknown";
  assert.equal(decide(rec, facts(T0 + PENDING_MAX_AGE_MS)).kind, "probe", "the probe path (+5 min already passed)");
});

test("§9.3 verify: an unverified inbox request is re-checked each pass for 48 h, then stalled", () => {
  const rec = base("receiver", "unverified", "REPLY-1", []);
  delete rec.messages["REPLY-1"];
  rec.receiver_task = null;
  rec.messages["REQUEST-1"]!.ingested_at = iso(T0);
  assert.deepEqual(decide(rec, facts(T0 + MIN)), { kind: "verify", shas: [OTHER_SHA] });
  assert.deepEqual(decide(rec, facts(T0 + 47 * HOUR)), { kind: "verify", shas: [OTHER_SHA] });
  assert.equal(decide(rec, facts(T0 + 48 * HOUR)).kind, "stall");
});

test("§9.3 / HOLD-1 Q4: an uncorroborated REPLY copy is re-checked for 48 h, then only a daily notice; the state is never changed", () => {
  const rec = sender([attempt(1, T0 - DAY, "handed_over")], "accepted");
  rec.acks_in["REQUEST-1"] = { last_seq: 2, state: "accepted", at: iso(T0 - DAY) };
  rec.unverified_copies = [Object.assign({ sha256: OTHER_SHA, raw: `raw/${OTHER_SHA}.env`, at: iso(T0) }, { key: "REPLY-1" })];
  assert.deepEqual(decide(rec, facts(T0 + MIN)), { kind: "verify", shas: [OTHER_SHA] });
  assert.deepEqual(decide(rec, facts(T0 + 48 * HOUR - 1)), { kind: "verify", shas: [OTHER_SHA] });
  const kinds: string[] = [];
  const reminded: number[] = [];
  for (let t = T0 + 48 * HOUR; t <= T0 + 48 * HOUR + 2 * DAY; t += 10 * MIN) {
    const s = decide(rec, facts(t));
    kinds.push(s.kind);
    if (s.kind === "remind") {
      assert.equal(s.notice, "reply_unverified");
      assert.equal(s.anchor, iso(T0 + 48 * HOUR));
      reminded.push((t - T0) / HOUR);
      countNotice(rec, s.notice, s.anchor, t);
    }
  }
  assert.deepEqual(reminded, [48, 72, 96], "once when the re-checks end, then daily");
  assert.ok(kinds.every((k) => k === "remind" || k === "none"), "no verify, stall or send after 48 h");
  rec.messages["REPLY-1"] = { sha256: OTHER_SHA, body_sha256: "e".repeat(64), raw: `raw/${OTHER_SHA}.env`, outcome: "done",
    final: "yes", ingested_at: iso(T0 + 4 * DAY) };
  assert.equal(decide(rec, facts(T0 + 5 * DAY)).kind, "none", "a later corroborated copy ends the notices");
});

test("CL-12 a CONFLICT on a terminal record is reminded once, then daily", () => {
  const done = sender([attempt(1, T0 - HOUR, "handed_over")], "replied");
  done.history.push({ at: iso(T0), event: "conflict", detail: `REPLY-1 sha256=${OTHER_SHA}` });
  assert.deepEqual(noticeTimes(done, T0, T0 + 2 * DAY, 10 * MIN), [0, 1440, 2880]);
  const refused = sender([attempt(1, T0, "handed_over")], "refused");
  refused.history.push({ at: iso(T0 + HOUR), event: "conflict", detail: `REQUEST-1 sha256=${OTHER_SHA}` });
  const kinds: string[] = [];
  for (let t = T0 + HOUR; t <= T0 + HOUR + DAY; t += 10 * MIN) {
    const s = decide(refused, facts(t));
    if (s.kind === "remind") {
      kinds.push(s.notice);
      countNotice(refused, s.notice, s.anchor, t);
    }
  }
  assert.deepEqual(kinds, ["conflict", "refused", "conflict"], "terminal: CONFLICT first; the one-shot `refused` is posted too and does not reset it (CL3-03)");
});

test("CL-05 a stored copy the pump found corroborated is presented by a notice (then every 2 h), never re-checked or applied by decide()", () => {
  const rec = base("receiver", "unverified", "REPLY-1", []);
  delete rec.messages["REPLY-1"];
  rec.receiver_task = null;
  rec.messages["REQUEST-1"]!.ingested_at = iso(T0);
  rec.notices.corroborated = { shas: [OTHER_SHA], at: iso(T0 + MIN) };
  assert.deepEqual(decide(rec, facts(T0 + MIN)), { kind: "remind", notice: "corroborated", anchor: iso(T0 + MIN) });
  countNotice(rec, "corroborated", iso(T0 + MIN), T0 + MIN);
  for (let t = T0 + MIN; t < T0 + MIN + 2 * HOUR; t += 10 * MIN) assert.equal(decide(rec, facts(t)).kind, "none", "no re-check, no stall, no send");
  assert.equal(decide(rec, facts(T0 + MIN + 2 * HOUR)).kind, "remind", "repeated every 2 h until the controller's ingest applies it");
  assert.equal(decide(rec, facts(T0 + 48 * HOUR)).kind, "stall", "the 48 h limit still holds");
  rec.state = "received";
  rec.state_at = iso(T0 + 3 * HOUR);
  const after = decide(rec, facts(T0 + 3 * HOUR));
  assert.ok(!(after.kind === "remind" && after.notice === "corroborated"), "applied by ingest: no more presentation");

  const out = sender([attempt(1, T0 - DAY, "handed_over")], "accepted");
  out.acks_in["REQUEST-1"] = { last_seq: 1, state: "accepted", at: iso(T0 - DAY) };
  out.unverified_copies = [Object.assign({ sha256: OTHER_SHA, raw: `raw/${OTHER_SHA}.env`, at: iso(T0) }, { key: "REPLY-1" })];
  assert.deepEqual(decide(out, facts(T0 + MIN)), { kind: "verify", shas: [OTHER_SHA] });
  out.notices.corroborated = { shas: [OTHER_SHA], at: iso(T0 + MIN) };
  assert.deepEqual(decide(out, facts(T0 + MIN)), { kind: "remind", notice: "corroborated", anchor: iso(T0 + MIN) },
    "a corroborated final REPLY is presented, not applied: the sender stays `accepted`");
});

// ── Second review (round 2): CL-05, CL-12 ────────────────────────────────────────────────
/** A REPLY-n copy (U6 `unverified_copies` entry with its `key`) stored at `atMs`. */
function replyCopy(rec: LinkRecord, key: string, sha: string, atMs: number): void {
  rec.unverified_copies = [...(rec.unverified_copies ?? []),
    Object.assign({ sha256: sha, raw: `raw/${sha}.env`, at: iso(atMs) }, { key })];
}

/** The receiver record ingest leaves for an uncorroborated REQUEST (`unverified`, REQUEST-1 not corroborated). */
function unverifiedInbox(): LinkRecord {
  const rec = base("receiver", "unverified", "REPLY-1", []);
  delete rec.messages["REPLY-1"];
  rec.receiver_task = null;
  rec.messages["REQUEST-1"]!.ingested_at = iso(T0);
  rec.messages["REQUEST-1"]!.corroboration = { state: "not_found", at: iso(T0), inject_id: null, checks: 1 };
  return rec;
}

test("CL-05 round 2: a request the pump found corroborated stays presented after the 48 h stall, every 2 h, until the record shows the controller acted", () => {
  const rec = unverifiedInbox();
  rec.notices.corroborated = { shas: [OTHER_SHA], at: iso(T0 + MIN) };
  countNotice(rec, "corroborated", iso(T0 + MIN), T0 + 46 * HOUR + MIN); // presented on its 2 h cadence, not picked up
  assert.equal(decide(rec, facts(T0 + 48 * HOUR)).kind, "stall", "the 48 h limit still holds");
  rec.state = "stalled";
  rec.state_at = iso(T0 + 48 * HOUR);
  assert.equal(decide(rec, facts(T0 + 48 * HOUR)).kind, "none", "the stall does not replace the presentation with a STALLED series");
  assert.deepEqual(noticeTimes(rec, T0 + 48 * HOUR, T0 + 54 * HOUR, MIN), [1, 121, 241], "CORROBORATED keeps its 2 h cadence on the stalled record");
  assert.equal((rec.notices.series as { kind?: string }).kind, "corroborated");
  const inactive = JSON.parse(JSON.stringify(rec)) as LinkRecord;
  assert.deepEqual(noticeTimes(inactive, T0 + 55 * HOUR, T0 + 80 * HOUR, 10 * MIN, false),
    [0, 70, 190, 310, 430, 550, 670, 790, 910, 1030, 1150, 1270, 1390],
    "pickup is local (CL3-01 / CL3-03): with the peer unconfigured CORROBORATED keeps its 2 h cadence; no STALLED series replaces it");
  assert.equal((inactive.notices.series as { kind?: string }).kind, "corroborated");
  // The controller acted: its own ingest promoted the request (stalled is a placeholder state, cli.ts:651).
  const picked = JSON.parse(JSON.stringify(rec)) as LinkRecord;
  picked.state = "received";
  picked.messages["REQUEST-1"]!.corroboration = { state: "corroborated", at: iso(T0 + 55 * HOUR), inject_id: null, checks: 2 };
  for (let t = T0 + 55 * HOUR; t < T0 + 80 * HOUR; t += 10 * MIN) {
    const s = decide(picked, facts(t));
    assert.ok(!(s.kind === "remind" && s.notice === "corroborated"), "acted: no more presentation");
  }
  // Or it closed the record.
  const closed = JSON.parse(JSON.stringify(rec)) as LinkRecord;
  closed.state = "closed";
  assert.equal(decide(closed, facts(T0 + 56 * HOUR)).kind, "none", "closed: nothing awaits the controller");
});

test("CL-05 round 2: a REPLY copy the pump found corroborated is presented past the 48 h re-check window, never downgraded to REPLY_UNVERIFIED", () => {
  const out = sender([attempt(1, T0 - DAY, "handed_over")], "accepted");
  out.acks_in["REQUEST-1"] = { last_seq: 1, state: "accepted", at: iso(T0 - DAY) };
  replyCopy(out, "REPLY-1", OTHER_SHA, T0);
  out.notices.corroborated = { shas: [OTHER_SHA], at: iso(T0 + MIN) };
  countNotice(out, "corroborated", iso(T0 + MIN), T0 + MIN);
  const kinds: string[] = [];
  for (let t = T0 + 47 * HOUR; t <= T0 + 4 * DAY; t += 10 * MIN) {
    const s = decide(out, facts(t));
    assert.ok(s.kind === "remind" || s.kind === "none", `nothing but notices (${s.kind})`);
    if (s.kind === "remind") {
      kinds.push(s.notice);
      countNotice(out, s.notice, s.anchor, t);
    }
  }
  assert.ok(kinds.length >= 12, `repeats (${kinds.length})`);
  assert.deepEqual([...new Set(kinds)], ["corroborated"], "the awaiting fact has no time limit");
  out.unverified_copies = [];
  out.messages["REPLY-1"] = { sha256: OTHER_SHA, body_sha256: "e".repeat(64), raw: `raw/${OTHER_SHA}.env`, outcome: "done",
    final: "yes", ingested_at: iso(T0 + 4 * DAY) };
  out.state = "replied";
  assert.equal(decide(out, facts(T0 + 4 * DAY + HOUR)).kind, "none", "its own ingest stored it: the presentation ends");
});

test("CL-05 round 2: a REPLY copy first stored on a terminal or stalled sender record is re-checked and presented; not on `closed`", () => {
  const done = sender([attempt(1, T0 - DAY, "handed_over")], "replied");
  replyCopy(done, "REPLY-2", OTHER_SHA, T0);
  assert.deepEqual(decide(done, facts(T0 + MIN)), { kind: "verify", shas: [OTHER_SHA] });
  assert.deepEqual(decide(done, facts(T0 + 48 * HOUR - 1)), { kind: "verify", shas: [OTHER_SHA] });
  assert.equal(decide(done, facts(T0 + 48 * HOUR)).kind, "none", "48 h of re-checks, as for any copy (§9.3)");
  done.notices.corroborated = { shas: [OTHER_SHA], at: iso(T0 + 2 * MIN) };
  assert.deepEqual(decide(done, facts(T0 + 2 * MIN)), { kind: "remind", notice: "corroborated", anchor: iso(T0 + 2 * MIN) });
  const closed = sender([attempt(1, T0 - DAY, "handed_over")], "closed");
  replyCopy(closed, "REPLY-2", OTHER_SHA, T0);
  assert.equal(decide(closed, facts(T0 + MIN)).kind, "none");
  closed.notices.corroborated = { shas: [OTHER_SHA], at: iso(T0 + 2 * MIN) };
  assert.equal(decide(closed, facts(T0 + 2 * MIN)).kind, "none", "closed by the controller: nothing awaits it");
  const stalled = sender([attempt(1, T0 - 3 * DAY, "unknown")], "stalled");
  countNotice(stalled, "stalled", iso(T0), T0);
  replyCopy(stalled, "REPLY-1", OTHER_SHA, T0);
  assert.deepEqual(decide(stalled, facts(T0 + MIN)), { kind: "verify", shas: [OTHER_SHA] });
});

test("CL-12 round 2 / CL3-02: a terminal record is never expired, so a CONFLICT long after state_at is noticed", () => {
  const done = sender([attempt(1, T0 - 40 * DAY, "handed_over")], "replied");
  done.state_at = iso(T0 - 29 * DAY);
  done.messages["REPLY-2"] = { sha256: OTHER_SHA, body_sha256: "e".repeat(64), raw: `raw/${OTHER_SHA}.env`, outcome: "done",
    final: "no", ingested_at: iso(T0 - HOUR) };
  done.history.push({ at: iso(T0 + DAY + HOUR), event: "conflict", detail: `REPLY-2 sha256=${"f".repeat(64)}` });
  assert.deepEqual(decide(done, facts(T0 + DAY + HOUR)), { kind: "remind", notice: "conflict", anchor: iso(T0 + DAY + HOUR) },
    "30 days after state_at, but the record is still retained: its conflict is noticed");
});

test("CL-12 round 2: on a stalled record a CONFLICT newer than the stall gets its own notice series; an older one does not displace the stall", () => {
  const st = sender([attempt(1, T0 - 3 * DAY, "unknown")], "stalled");
  countNotice(st, "stalled", iso(T0), T0);
  st.history.push({ at: iso(T0 + HOUR), event: "conflict", detail: `REQUEST-1 sha256=${"f".repeat(64)}` });
  assert.deepEqual(decide(st, facts(T0 + HOUR)), { kind: "remind", notice: "conflict", anchor: iso(T0 + HOUR) });
  countNotice(st, "conflict", iso(T0 + HOUR), T0 + HOUR);
  assert.equal(noticeTimes(st, T0 + HOUR + MIN, T0 + 3 * DAY, 10 * MIN).length, 2, "then daily");
  const old = sender([attempt(1, T0 - 3 * DAY, "unknown")], "stalled");
  old.history.push({ at: iso(T0 - HOUR), event: "conflict", detail: `REQUEST-1 sha256=${"f".repeat(64)}` });
  assert.deepEqual(decide(old, facts(T0)), { kind: "remind", notice: "stalled", anchor: iso(T0) });
});

test("P2 on the round-2 paths: re-checks and notices on stalled, terminal and awaiting records never send and never re-check unknown bytes", () => {
  const COPY_SHA = "9".repeat(64);
  let verifies = 0;
  let awaitingReminds = 0;
  let pickupReminds = 0;
  for (const role of ["sender", "receiver"] as const) {
    for (const state of role === "sender" ? SENDER_STATES : RECEIVER_STATES) {
      for (const copy of ["none", "fresh", "old"] as const) {
        for (const marked of [false, true]) {
          for (const conflict of ["none", "before", "after"] as const) {
           for (const pickup of role === "sender" ? [false, true] : [false]) {
            for (const t of [T0 + MIN, T0 + HOUR, T0 + 47 * HOUR, T0 + 49 * HOUR, T0 + 20 * DAY, T0 + 40 * DAY]) {
              const rec = role === "sender" ? sender([attempt(1, T0 - HOUR, "handed_over")], state)
                : receiver([attempt(1, T0 - HOUR, "handed_over")], state);
              if (pickup) awaitingReply(rec, "REPLY-1", T0 - HOUR);
              if (role === "receiver" && state === "unverified") {
                rec.messages["REQUEST-1"]!.corroboration = { state: "not_found", at: iso(T0), inject_id: null, checks: 1 };
                rec.messages["REQUEST-1"]!.ingested_at = iso(T0);
              }
              if (copy !== "none") replyCopy(rec, role === "sender" ? "REPLY-2" : "REQUEST-1", COPY_SHA, copy === "fresh" ? T0 : T0 - 3 * DAY);
              if (marked) rec.notices.corroborated = { shas: [COPY_SHA], at: iso(T0) };
              if (conflict !== "none") {
                rec.history.push({ at: iso(conflict === "before" ? T0 - HOUR : T0 + HOUR), event: "conflict", detail: "REQUEST-1 sha256=x" });
              }
              const s = decide(rec, facts(t));
              const where = `${role} ${state} copy=${copy} marked=${marked} conflict=${conflict} pickup=${pickup} t=${(t - T0) / MIN}`;
              if (s.kind === "remind" && s.notice === "reply_awaiting") {
                pickupReminds += 1;
                assert.ok(pickup, where);
              }
              assert.notEqual(s.kind, "resend", `no trigger, no re-send: ${where}`);
              if (state === "stalled" || ["refused", "replied", "closed"].includes(state)) {
                assert.ok(s.kind !== "probe" && s.kind !== "stall", `nothing scheduled to send: ${where}`);
              }
              if (s.kind === "verify") {
                verifies += 1;
                const known = new Set([...Object.values(rec.messages).map((m) => m.sha256), ...(rec.unverified_copies ?? []).map((c) => c.sha256)]);
                assert.ok(s.shas.every((x) => known.has(x)), `only stored bytes are re-checked: ${where}`);
                assert.ok(!(marked && s.shas.includes(COPY_SHA)), `a corroborated copy is not re-checked again: ${where}`);
                assert.notEqual(state, "closed", where);
              }
              if (s.kind === "remind" && s.notice === "corroborated") {
                awaitingReminds += 1;
                assert.ok(marked && state !== "closed", where);
              }
            }
           }
          }
        }
      }
    }
  }
  assert.ok(verifies > 20, `exercised re-checks (${verifies})`);
  assert.ok(awaitingReminds > 20, `exercised the awaiting presentation (${awaitingReminds})`);
  assert.ok(pickupReminds > 20, `exercised the REPLY pickup presentation (${pickupReminds})`);
});

// ── Round 2 fix (P1 / CL-09): a REPLY awaiting `handled` ───────────────────────────────────
/** A REPLY the sender's ingest applied, as coder A's ingest stores it: `pickup: "awaiting"` (store.ts awaitingPickup). */
function awaitingReply(rec: LinkRecord, key: string, ingestedMs: number): void {
  rec.messages[key] = { sha256: "8".repeat(64), body_sha256: "e".repeat(64), raw: `raw/${"8".repeat(64)}.env`, outcome: "done",
    final: "yes", ingested_at: iso(ingestedMs), pickup: "awaiting" };
}

test("CL-09 pickup (P1): a REPLY awaiting pickup on a terminal `replied` record is reminded +10, +30 min, then every 2 h; never expired; it stops once handled", () => {
  const rec = sender([attempt(1, T0 - DAY, "handed_over")], "replied");
  awaitingReply(rec, "REPLY-1", T0);
  assert.deepEqual(noticeTimes(rec, T0, T0 + 7 * HOUR, MIN), [10, 30, 150, 270, 390]);
  assert.equal((rec.notices.series as { kind?: string }).kind, "reply_awaiting");
  const late = decide(rec, facts(T0 + 40 * DAY));
  assert.deepEqual(late, { kind: "remind", notice: "reply_awaiting", anchor: iso(T0) }, "40 days later: still reminded, not expired");
  countNotice(rec, "reply_awaiting", iso(T0), T0 + 40 * DAY);
  const waiting = decide(rec, facts(T0 + 40 * DAY + MIN));
  assert.equal(waiting.kind, "none");
  assert.ok(waiting.kind === "none" && waiting.due_ms !== null && waiting.due_ms <= T0 + 40 * DAY + 2 * HOUR, "the next reminder is due");
  // The controller recorded the pickup (`handled`, coder A): no more reminders; nothing is expired (CL3-02).
  rec.messages["REPLY-1"]!.pickup = "handled";
  assert.deepEqual(decide(rec, facts(T0 + 40 * DAY + 2 * HOUR)), { kind: "none", due_ms: null, why: "terminal" });
  assert.equal(decide(rec, facts(T0 + 29 * DAY)).kind, "none", "handled: nothing more to say");
  // A second REPLY awaiting starts its own series at its own ingest time.
  awaitingReply(rec, "REPLY-2", T0 + 29 * DAY);
  assert.equal(decide(rec, facts(T0 + 29 * DAY + 9 * MIN)).kind, "none");
  assert.deepEqual(decide(rec, facts(T0 + 29 * DAY + 10 * MIN)), { kind: "remind", notice: "reply_awaiting", anchor: iso(T0 + 29 * DAY) });
});

test("CL-09 pickup (P1): a REPLY awaiting pickup is reminded on open and stalled sender records too, also when the peer is no longer configured", () => {
  const open = sender([attempt(1, T0 - DAY, "handed_over")], "accepted");
  open.acks_in["REQUEST-1"] = { last_seq: 1, state: "accepted", at: iso(T0 - DAY) };
  awaitingReply(open, "REPLY-1", T0);
  open.messages["REPLY-1"]!.final = "no";
  assert.deepEqual(decide(open, facts(T0 + 10 * MIN)), { kind: "remind", notice: "reply_awaiting", anchor: iso(T0) });
  assert.deepEqual(decide(open, facts(T0 + 10 * MIN, { peerActive: false })), { kind: "remind", notice: "reply_awaiting", anchor: iso(T0) },
    "status and handled are local: the peer is not needed");
  const stalled = sender([attempt(1, T0 - 3 * DAY, "unknown")], "stalled");
  countNotice(stalled, "stalled", iso(T0 - DAY), T0 - DAY);
  awaitingReply(stalled, "REPLY-1", T0);
  assert.deepEqual(decide(stalled, facts(T0 + 10 * MIN)), { kind: "remind", notice: "reply_awaiting", anchor: iso(T0) });
});

// ── Third review (round 3): CL3-02 / CL3-07 no retention, CL3-03 notice slots ─────────────────
/** Every step decide() returns at `t` until it returns no further notice (the pump posts both slots in one pass). */
function remindsAt(rec: LinkRecord, t: number, peerActive = true): string[] {
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    const s = decide(rec, facts(t, { peerActive }));
    if (s.kind !== "remind") break;
    out.push(s.notice);
    countNotice(rec, s.notice, s.anchor, t);
  }
  return out;
}

test("CL3-02 / CL3-07: v1 expires nothing — a terminal record a year old gets no step and no due time", () => {
  for (const state of ["replied", "refused", "closed"] as const) {
    const done = sender([attempt(1, T0, "handed_over")], state);
    if (state === "refused") countNotice(done, "refused", iso(T0), T0);
    assert.deepEqual(decide(done, facts(T0 + 365 * DAY)), { kind: "none", due_ms: null, why: "terminal" }, state);
  }
  const inbox = receiver([attempt(1, T0, "handed_over")], "replied");
  assert.deepEqual(decide(inbox, facts(T0 + 365 * DAY)), { kind: "none", due_ms: null, why: "terminal" });
});

test("CL3-03: an unbound request whose peer is unconfigured keeps its repeating UNBOUND series; PEER_UNCONFIGURED is posted once beside it, after it", () => {
  const rec = base("receiver", "received", "REPLY-1", []);
  delete rec.messages["REPLY-1"];
  rec.receiver_task = null;
  assert.deepEqual(remindsAt(rec, T0, false), ["peer_unconfigured"], "nothing awaits yet at +0: only the one-shot");
  const seen: Array<[number, string[]]> = [];
  for (let t = T0 + MIN; t <= T0 + 7 * HOUR; t += MIN) {
    const r = remindsAt(rec, t, false);
    if (r.length > 0) seen.push([(t - T0) / MIN, r]);
  }
  assert.deepEqual(seen, [[10, ["unbound"]], [30, ["unbound"]], [150, ["unbound"]], [270, ["unbound"]], [390, ["unbound"]]],
    "the one-shot notice neither suppressed nor reset the unbound cadence");
  // Both due in one pass: the awaiting kind first, then the one-shot kind.
  const both = base("receiver", "received", "REPLY-1", []);
  delete both.messages["REPLY-1"];
  both.receiver_task = null;
  assert.deepEqual(remindsAt(both, T0 + 10 * MIN, false), ["unbound", "peer_unconfigured"]);
  assert.deepEqual(remindsAt(both, T0 + 30 * MIN, false), ["unbound"], "the one-shot is not repeated");
});

test("CL3-03: a REPLY awaiting pickup keeps its own cadence on a terminal record with a CONFLICT; the CONFLICT series follows once it is handled", () => {
  const rec = sender([attempt(1, T0 - DAY, "handed_over")], "replied");
  awaitingReply(rec, "REPLY-1", T0);
  rec.history.push({ at: iso(T0 + 20 * MIN), event: "conflict", detail: `REPLY-1 sha256=${"f".repeat(64)}` });
  const kinds: string[] = [];
  const times: number[] = [];
  for (let t = T0; t <= T0 + 7 * HOUR; t += MIN) {
    const r = remindsAt(rec, t);
    if (r.length > 0) times.push((t - T0) / MIN);
    kinds.push(...r);
  }
  assert.deepEqual(times, [10, 30, 150, 270, 390], "REPLY_AWAITING keeps +10, +30 min, then every 2 h");
  assert.deepEqual([...new Set(kinds)], ["reply_awaiting"], "the CONFLICT does not take over the awaiting series");
  rec.messages["REPLY-1"]!.pickup = "handled";
  assert.deepEqual(remindsAt(rec, T0 + 8 * HOUR), ["conflict"]);
  const refused = sender([attempt(1, T0, "handed_over")], "refused");
  awaitingReply(refused, "REPLY-1", T0);
  assert.deepEqual(remindsAt(refused, T0 + 10 * MIN), ["reply_awaiting", "refused"], "awaiting first, then the one-shot");
});
