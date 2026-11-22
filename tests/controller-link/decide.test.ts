// Task 1294 — controller-link pump decision (U8, pure src/controller-link/decide.ts): TEST-PLAN §2.8
// P1 (exact schedules), P2 (property: no re-send without an allowed trigger, always the same sha),
// P3 (queued wait), P4 (stall + notice schedule), P5 (notice offsets), P6 (unconfigured peer), plus the
// §6.2 pending recovery rule and §4 retention selection. Records are plain objects; nothing touches
// the filesystem, a clock or a process: the clock and the owner facts are arguments.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANSWER_RESENDS_MAX, NO_ACK_STALL_MS, PENDING_MAX_AGE_MS, QUEUED_WAIT_MS, REFUSAL_STALL_MS,
  decide, nextPoint, type DecideFacts, type NoticeKind, type Step,
} from "../../src/controller-link/decide.js";
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

function countNotice(rec: LinkRecord, kind: NoticeKind, anchor: string, atMs: number): void {
  const s = rec.notices.series as { kind?: string; anchor?: string; n?: number } | null | undefined;
  const n = s !== undefined && s !== null && s.kind === kind && s.anchor === anchor ? (s.n ?? 0) + 1 : 1;
  rec.notices.series = { kind, anchor, n, last_at: iso(atMs) };
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

test("P2 property: a re-send appears only after a definite refusal, an `unknown` answer or the second `unverified` answer (or a human), and names the same sha", () => {
  const RESULTS: SendAttempt["result"][] = ["handed_over", "unknown", "refused_definite", "pending"];
  const ACKS = ["received", "accepted", "refused", "unverified", "unknown"];
  let resendsSeen = 0;
  let uncertainChecks = 0;
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
    for (let ev = 0; ev < 80; ev++) {
      const r = rnd();
      if (r < 0.3) {
        now += pick([MIN, 5 * MIN, 17 * MIN, HOUR, 3 * HOUR, 11 * HOUR]);
      } else if (r < 0.45) {
        addAck(rec, key, pick(ACKS), now);
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
        sends.push(attempt(sends.length + 1, now, "pending", { owner: DEAD }));
        if (rnd() < 0.5) gone.add(DEAD); else gone.delete(DEAD);
      } else if (r < 0.55 && rec.state === "stalled") {
        // the human `resend` command (not a decision of decide()); recorded as trigger "human"
        const sends = sendsOf(rec, key);
        sends.push(attempt(sends.length + 1, now, pick(RESULTS.filter((x) => x !== "pending")), { trigger: "human" }));
        rec.state = role === "sender" ? "sent" : "replying";
      } else {
        const s: Step = decide(rec, facts(now, { goneOwners: gone }));
        const last = latest(rec, key);
        const ack = rec.acks_in[key];
        const unverifiedAfter = new Set(rec.history.filter((h) => h.event === "ack_in" && Date.parse(h.at) > Date.parse(last.at) &&
          typeof h.detail === "string" && h.detail.startsWith(`${key} `) && h.detail.endsWith("state=unverified")).map((h) => h.detail)).size;
        const unknownAnswer = ack !== undefined && ack.state === "unknown" && Date.parse(String(ack.at)) > Date.parse(last.at);
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
          sends.push(attempt(sends.length + 1, now, pick(RESULTS), { trigger: s.trigger }));
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
  const rec = sender([attempt(1, T0, "handed_over")]);
  addAck(rec, "REQUEST-1", "unknown", T0 - MIN); // older than the attempt: no re-send
  assert.notEqual(decide(rec, facts(T0 + MIN)).kind, "resend");
  let t = T0;
  for (let i = 1; i <= 4; i++) {
    t += 10 * MIN;
    addAck(rec, "REQUEST-1", "unknown", t);
    const s = decide(rec, facts(t + 1));
    if (i <= ANSWER_RESENDS_MAX) {
      assert.deepEqual(s, { kind: "resend", key: "REQUEST-1", trigger: "ack_unknown", sha256: SHA });
      rec.messages["REQUEST-1"]!.answer_resends = i;
      sendsOf(rec, "REQUEST-1").push(attempt(i + 1, t + 1, "handed_over", { trigger: "ack_unknown" }));
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

// ── §6.2 pending recovery, §4 retention, §9.3 verify ──────────────────────────────────────
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

test("§4 retention: a terminal record 30 days after state_at is selected; non-terminal never", () => {
  const done = sender([attempt(1, T0, "handed_over")], "replied");
  assert.notEqual(decide(done, facts(T0 + 30 * DAY - 1)).kind, "expire");
  assert.equal(decide(done, facts(T0 + 30 * DAY)).kind, "expire");
  const open = sender([attempt(1, T0, "handed_over")], "accepted");
  assert.notEqual(decide(open, facts(T0 + 90 * DAY)).kind, "expire");
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
