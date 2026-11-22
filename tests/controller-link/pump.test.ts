// Task 1294 — controller-link pump (U8, src/controller-link/pump.ts): TEST-PLAN §2.4 K1–K4 and §2.8
// P4–P8 at the pump, plus the §6.1 record-before-send rule, same-byte re-sends, the human `resend`,
// retention, the off switch and the `pump`/`resend` registration in cli.ts.
// Injected: wall clock, monotonic clock, process runner (fake telepty inject), pid liveness, notice
// sender (fake report-pump TeleptyPort.inject), audit reader, sleep; store root and peer config are
// a temp dir per test. No real telepty, daemon or session is touched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { USAGE, defaultAuditReader, runCli, type AuditReader, type AuditRow } from "../../src/controller-link/cli.js";
import { NOTICE_PRIORITY } from "../../src/controller-link/decide.js";
import { parseEnvelope, renderEnvelope, type Envelope, type EnvelopeFields } from "../../src/controller-link/envelope.js";
import {
  CURSOR_FILE, NOTICE_MARKER, PASS_NOTICES_MAX, PASS_RECORDS_MAX, PASS_SENDS_MAX, PASS_WALL_MS, PUMP_SWITCH_ENV, pumpOnce,
  renderControllerNotice, runPump, runResendCli, type PumpDeps,
} from "../../src/controller-link/pump.js";
import { KILL_GRACE_MS, type ProcessRunner, type RunnerResult } from "../../src/controller-link/send.js";
import { ControllerLinkStore, type LinkRecord, type RecordRef, type RecordState, type SendAttempt } from "../../src/controller-link/store.js";
import { taskQueueStatus } from "../../src/dispatch/task-queue-read.js";
import type { InjectResult } from "../../src/report/pump.js";

const T0 = Date.parse("2026-11-22T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SELF = "mac";
const PEER = "linux";
const PEER_TARGET = "orchestrator@linux-box";
const SID = "orchestrator";
const HOST = "test-host";
const PUMP_PID = 4242;
const CLI_PID = 5151;
const iso = (ms: number): string => new Date(ms).toISOString();
const wire = (ms: number): string => `${iso(ms).slice(0, 19)}Z`;
const okReply = (): RunnerResult => ({ rc: 0, stdout: `inject_id: ${randomUUID()}\n✅ Submitted — consumed as a new turn.\n`, stderr: "", truncated: false });
const refused = (): RunnerResult => ({ rc: 1, stdout: "", stderr: "❌ [TRACKING_PERSISTENCE_FAILED] no task bytes were delivered\n", truncated: false });

interface Call { argv: string[] }

interface H {
  base: string;
  storeRoot: string;
  now: { ms: number };
  mono: { ms: number };
  calls: Call[];
  replies: RunnerResult[];
  onInject: (() => Promise<void>) | null;
  monoPerSend: number;
  notices: Array<{ dest: string; text: string }>;
  noticeRc: number;
  alive: Map<number, boolean | null>;
  rows: AuditRow[];
  out: string[];
  err: string[];
  slept: number[];
  store: ControllerLinkStore;
  deps: PumpDeps;
}

function harness(t: TestContext): H {
  const base = fs.mkdtempSync(path.join(tmpdir(), "controller-link-pump-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const peersFile = path.join(base, "controller-peers.json");
  fs.writeFileSync(peersFile, JSON.stringify({ v: 1, self: { label: SELF, controller_sid: SID },
    peers: { linux: { target: PEER_TARGET, link: "v1" }, old: { target: "orchestrator@old-box" } } }));
  const storeRoot = path.join(base, "store");
  const now = { ms: T0 };
  const h: H = {
    base, storeRoot, now, mono: { ms: 0 }, calls: [], replies: [], onInject: null, monoPerSend: 0, notices: [], noticeRc: 0,
    alive: new Map(), rows: [], out: [], err: [], slept: [],
    store: new ControllerLinkStore({ root: storeRoot, clock: { nowMs: () => now.ms } }),
    deps: undefined as unknown as PumpDeps,
  };
  const runner: ProcessRunner = {
    async run(_bin, argv) {
      h.calls.push({ argv: [...argv] });
      if (h.onInject !== null) await h.onInject();
      h.mono.ms += h.monoPerSend;
      return h.replies.shift() ?? okReply();
    },
  };
  const audit: AuditReader = { async page() { return { rows: [...h.rows], next_cursor: null }; } };
  h.deps = {
    env: { AIGENTRY_CONTROLLER_PEERS: peersFile, AIGENTRY_CONTROLLER_LINK_DIR: storeRoot },
    packageRoot: base, clock: { nowMs: () => now.ms }, runner, teleptyBin: "telepty-fake", audit,
    taskStatus: taskQueueStatus, proc: { pid: PUMP_PID, host: HOST },
    readStdin: async () => Buffer.alloc(0), readBodyFile: async (f) => fs.readFileSync(f),
    out: (l) => { h.out.push(l); }, err: (l) => { h.err.push(l); },
    monoMs: () => h.mono.ms,
    pidAlive: (pid) => (h.alive.has(pid) ? h.alive.get(pid)! : true),
    notice: {
      inject(dest: string, text: string): InjectResult {
        h.notices.push({ dest, text });
        return { rc: h.noticeRc, stdout: `inject_id: ${randomUUID()}\n✅ Submitted — consumed as a new turn.\n`, stderr: "" };
      },
    },
    sleep: async (ms) => { h.slept.push(ms); },
    localHosts: [HOST],
  };
  return h;
}

/** One `pump --once` pass; output collected fresh. */
async function pump(h: H, deps: PumpDeps = h.deps): Promise<number> {
  h.out.length = 0;
  h.err.length = 0;
  return runPump(["--once"], deps);
}

function envelope(f: EnvelopeFields, body = ""): Envelope {
  const r = renderEnvelope(f, body);
  if (!r.ok) assert.fail(`fixture envelope refused: ${r.error.code} ${r.error.detail}`);
  return r.envelope;
}

function fields(kind: EnvelopeFields["kind"], id: string, from: string, to: string, over: Partial<EnvelopeFields> = {}): EnvelopeFields {
  return { kind, id, seq: 1, ref: null, from, to, sent_at: wire(T0 - MIN), sender_task: "1291", receiver_task: null,
    state: null, outcome: null, final: null, reason: null, ...over };
}

function attempt(n: number, atMs: number, result: SendAttempt["result"], over: Record<string, unknown> = {}): SendAttempt {
  const a: SendAttempt = { n, at: iso(atMs), owner: `1@${HOST}`, result, submit: result === "handed_over" ? "consumed" : null,
    inject_id: null, detail: null };
  return Object.assign(a, over);
}

const outbox = (id: string): RecordRef => ({ role: "sender", requestId: id });
const inbox = (id: string, peer = PEER): RecordRef => ({ role: "receiver", peer, requestId: id });

async function rec(h: H, ref: RecordRef): Promise<LinkRecord> {
  const r = await h.store.read(ref);
  assert.ok(r, "record expected");
  return r;
}

/** An outbox record as the dispatch peer branch (U5) leaves it, with the given REQUEST-1 attempts. */
async function seedSender(h: H, id: string, state: RecordState, sends: SendAttempt[],
  over: Partial<LinkRecord> = {}, peer = PEER): Promise<Envelope> {
  const e = envelope(fields("REQUEST", id, SELF, peer), "mac asks linux for work");
  await h.store.mutate(outbox(id), (_cur, m) => ({
    write: {
      v: 1, role: "sender", request_id: id, peer, peer_target: peer === PEER ? PEER_TARGET : "orchestrator@old-box", self_label: SELF,
      sender_task: "1291", receiver_task: null, state, state_at: sends[0]?.at ?? m.nowIso,
      next_action: { code: "WAIT_ACK", due_at: m.nowIso, text: "wait" },
      messages: { "REQUEST-1": { sha256: e.sha256, body_sha256: e.body_sha256, raw: `raw/${e.sha256}.env`, sends } },
      acks_in: {}, probes_out: {}, acks_out: { last_seq: 0, sends: [] }, notices: { n: 0, last_at: null },
      history: [{ at: m.nowIso, event: "created", detail: "dispatch" }], history_dropped: 0, ...over,
    },
    raws: [{ sha256: e.sha256, bytes: Buffer.from(e.text, "utf8") }],
    value: null,
  }));
  return e;
}

/** An inbox record for linux's REQUEST, in `state`; corroborated unless `unverified`. */
async function seedReceiver(h: H, id: string, state: RecordState, atMs = T0): Promise<Envelope> {
  const e = envelope(fields("REQUEST", id, PEER, SELF), "linux asks mac for work");
  const corroborated = state !== "unverified";
  await h.store.mutate(inbox(id), () => ({
    write: {
      v: 1, role: "receiver", request_id: id, peer: PEER, peer_target: PEER_TARGET, self_label: SELF,
      sender_task: "1291", receiver_task: state === "received" || state === "unverified" ? null : "2026112102", state, state_at: iso(atMs),
      next_action: { code: "WORK", due_at: iso(atMs), text: "work" },
      messages: { "REQUEST-1": { sha256: e.sha256, body_sha256: e.body_sha256, raw: `raw/${e.sha256}.env`, ingested_at: iso(atMs),
        corroboration: { state: corroborated ? "corroborated" : "not_found", at: iso(atMs), inject_id: null, checks: 1 } } },
      acks_in: {}, probes_out: {}, acks_out: { last_seq: 0, sends: [] }, notices: { n: 0, last_at: null },
      history: [{ at: iso(atMs), event: "created", detail: "ingest" }], history_dropped: 0,
    },
    raws: [{ sha256: e.sha256, bytes: Buffer.from(e.text, "utf8") }],
    value: null,
  }));
  return e;
}

function sentEnvelopes(h: H): EnvelopeFields[] {
  return h.calls.map((c) => {
    const r = parseEnvelope(c.argv[c.argv.length - 1]!);
    if (!r.ok) assert.fail("the pump sent text that is not a canonical envelope");
    return r.envelope.fields;
  });
}

const lastArg = (c: Call): string => c.argv[c.argv.length - 1]!;

// ── §6.1 / P1 at the pump ─────────────────────────────────────────────────────────────────
test("§6.1 a due PROBE is committed `pending` before telepty runs; the result is written after; argv as C7", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "sent", [attempt(1, T0, "handed_over")]);
  h.now.ms = T0 + 5 * MIN;
  const during: Array<SendAttempt | undefined> = [];
  h.onInject = async () => {
    during.push((await rec(h, outbox(id))).probes_out["REQUEST-1"]?.sends.at(-1));
  };
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.equal(h.calls.length, 1);
  assert.equal(during.length, 1);
  assert.equal(during[0]?.result, "pending", "recorded before the send");
  assert.equal(during[0]?.owner, `${PUMP_PID}@${HOST}`);
  assert.deepEqual(h.calls[0]!.argv.slice(0, -1),
    ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", "controller-link", PEER_TARGET]);
  const f = sentEnvelopes(h)[0]!;
  assert.equal(f.kind, "PROBE");
  assert.equal(f.ref, "REQUEST-1");
  assert.equal(f.from, SELF);
  assert.equal(f.to, PEER);
  const after = (await rec(h, outbox(id))).probes_out["REQUEST-1"]!.sends.at(-1)!;
  assert.equal(after.result, "handed_over", "recorded after the send");
  assert.ok(h.out.some((l) => l.startsWith(`PUMP_PROBE request=${id} `)));
  assert.equal((await rec(h, outbox(id))).state, "sent", "a probe changes no state");
});

test("P1/P2 at the pump: a definite refusal is re-sent with the identical raw bytes on its back-off", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedSender(h, id, "send_refused", [attempt(1, T0, "refused_definite")]);
  h.now.ms = T0 + MIN - 1;
  await pump(h);
  assert.equal(h.calls.length, 0, "not before +1 min");
  h.now.ms = T0 + MIN;
  h.replies.push(refused());
  await pump(h);
  assert.equal(h.calls.length, 1);
  assert.equal(lastArg(h.calls[0]!), e.text, "same bytes, same id, same seq");
  assert.equal(lastArg(h.calls[0]!), fs.readFileSync(h.store.rawPath(e.sha256), "utf8"));
  let r = await rec(h, outbox(id));
  assert.equal(r.messages["REQUEST-1"]!.sends!.at(-1)!.trigger, "refused_definite");
  assert.equal(r.state, "send_refused");
  h.now.ms = T0 + 3 * MIN - 1;
  await pump(h);
  assert.equal(h.calls.length, 1, "the second delay is 2 min after the latest refusal");
  h.now.ms = T0 + 3 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 2);
  assert.equal(lastArg(h.calls[1]!), e.text);
  r = await rec(h, outbox(id));
  assert.equal(r.state, "sent", "handed over on the re-send");
  assert.ok(r.history.some((x) => x.event === "resend"));
});

test("P2 at the pump: an `unknown` send is only probed; an ACK `unknown` answer newer than it allows one re-send", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedSender(h, id, "send_unknown", [attempt(1, T0, "unknown")]);
  h.now.ms = T0 + 5 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 1);
  assert.equal(sentEnvelopes(h)[0]!.kind, "PROBE", "probe, never a blind re-send");
  h.now.ms = T0 + 6 * MIN;
  await h.store.mutate(outbox(id), (cur, m) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.acks_in["REQUEST-1"] = { last_seq: 1, state: "unknown", at: m.nowIso };
    next.history.push({ at: m.nowIso, event: "ack_in", detail: "REQUEST-1 seq=1 state=unknown" });
    return { write: next, value: null };
  });
  h.now.ms = T0 + 7 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 2);
  assert.equal(lastArg(h.calls[1]!), e.text, "the re-send is the stored raw file");
  const r = await rec(h, outbox(id));
  assert.equal(r.messages["REQUEST-1"]!.answer_resends, 1);
  assert.equal(r.messages["REQUEST-1"]!.sends!.at(-1)!.trigger, "ack_unknown");
  h.now.ms = T0 + 8 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 2, "once per answer");
});

// ── K1–K4 crash points ───────────────────────────────────────────────────────────────────
async function acceptedReceiverWithReplyFault(h: H, point: "after_commit" | "after_inject"): Promise<string> {
  const id = randomUUID();
  await seedReceiver(h, id, "accepted");
  const body = path.join(h.base, "reply.md");
  fs.writeFileSync(body, "done on mac\n");
  const cliDeps = { ...h.deps, proc: { pid: CLI_PID, host: HOST },
    fault: (p: "after_commit" | "after_inject") => { if (p === point) throw new Error(`fault injected at ${p}`); } };
  await assert.rejects(runCli(["reply", "--request", id, "--outcome", "done", "--final", "--body-file", body], cliDeps), /fault injected/);
  return id;
}

for (const point of ["after_commit", "after_inject"] as const) {
  const kid = point === "after_commit" ? "K1" : "K2";
  test(`${kid} fault ${point}: attempt pending; next pass with the owner dead -> unknown -> PROBE scheduled; no re-send`, async (t) => {
    const h = harness(t);
    const id = await acceptedReceiverWithReplyFault(h, point);
    const callsAfterFault = h.calls.length;
    assert.equal(callsAfterFault, point === "after_commit" ? 0 : 1, "telepty ran only for after_inject");
    let r = await rec(h, inbox(id));
    const replyText = point === "after_inject" ? lastArg(h.calls[0]!) : null;
    assert.equal(r.messages["REPLY-1"]!.sends!.at(-1)!.result, "pending");
    assert.equal(r.state, "replying");
    h.alive.set(CLI_PID, false);
    h.now.ms = T0 + MIN;
    assert.equal(await pump(h), 0, h.err.join("\n"));
    r = await rec(h, inbox(id));
    const a = r.messages["REPLY-1"]!.sends!.at(-1)!;
    assert.equal(a.result, "unknown");
    assert.equal(a.detail, "pending_recovered:owner_gone");
    assert.equal(r.messages["REPLY-1"]!.sends!.length, 1, "no re-send");
    assert.equal(h.calls.length, callsAfterFault, "nothing sent at once");
    assert.equal(r.next_action.code, "PROBE");
    h.now.ms = T0 + 5 * MIN;
    await pump(h);
    const sent = sentEnvelopes(h).slice(callsAfterFault);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, "PROBE");
    assert.equal(sent[0]!.ref, "REPLY-1");
    if (replyText !== null) assert.ok(h.calls.slice(callsAfterFault).every((c) => lastArg(c) !== replyText), "REPLY never re-sent");
  });
}

test("K3 owner alive and < 10 min -> the pump waits; owner on another host -> waits until 10 min", async (t) => {
  const h = harness(t);
  const live = randomUUID();
  const foreign = randomUUID();
  await seedSender(h, live, "prepared", [attempt(1, T0, "pending", { owner: `7777@${HOST}` })]);
  await seedSender(h, foreign, "prepared", [attempt(1, T0, "pending", { owner: "8888@other-host" })]);
  h.alive.set(7777, true);
  h.alive.set(8888, false); // a pid on another host proves nothing here
  h.now.ms = T0 + 10 * MIN - 1;
  await pump(h);
  assert.equal(h.calls.length, 0);
  assert.equal((await rec(h, outbox(live))).messages["REQUEST-1"]!.sends![0]!.result, "pending");
  assert.equal((await rec(h, outbox(foreign))).messages["REQUEST-1"]!.sends![0]!.result, "pending");
  h.now.ms = T0 + 10 * MIN;
  await pump(h);
  for (const id of [live, foreign]) {
    const r = await rec(h, outbox(id));
    assert.equal(r.messages["REQUEST-1"]!.sends![0]!.result, "unknown");
    assert.equal(r.messages["REQUEST-1"]!.sends!.length, 1, "never re-sent at once");
    assert.equal(r.state, "send_unknown");
  }
  assert.ok(sentEnvelopes(h).every((f) => f.kind === "PROBE"), "only probes follow");
});

test("K4 ingest fault after the record commit, before the ACK send: record correct; a later PROBE is answered from it", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = envelope(fields("REQUEST", id, PEER, SELF), "linux asks mac for work");
  h.rows.push({ inject_id: randomUUID(), to: SID, claimed_from: "controller-link", payload_sha256: e.sha256,
    claimed_cross_host: true, delivery_result: "success" });
  const faulty = { ...h.deps, proc: { pid: CLI_PID, host: HOST }, readStdin: async () => Buffer.from(e.text, "utf8"),
    fault: (p: "after_commit" | "after_inject") => { if (p === "after_commit") throw new Error("fault injected at after_commit"); } };
  await assert.rejects(runCli(["ingest"], faulty), /fault injected/);
  assert.equal(h.calls.length, 0);
  let r = await rec(h, inbox(id));
  assert.equal(r.state, "received");
  assert.equal(r.acks_out.sends[0]!.result, "pending");
  const probe = envelope(fields("PROBE", id, PEER, SELF, { seq: 1, ref: "REQUEST-1" }));
  const answering = { ...h.deps, readStdin: async () => Buffer.from(probe.text, "utf8") };
  assert.equal(await runCli(["ingest"], answering), 0, h.out.join("\n"));
  assert.ok(h.out.some((l) => l.startsWith("RESULT=ANSWERED ")));
  assert.equal(h.calls.length, 1);
  assert.equal(sentEnvelopes(h)[0]!.kind, "ACK");
  assert.equal(sentEnvelopes(h)[0]!.state, "received");
  h.alive.set(CLI_PID, false);
  h.now.ms = T0 + MIN;
  await pump(h);
  r = await rec(h, inbox(id));
  assert.equal(r.acks_out.sends[0]!.result, "unknown", "the orphaned ACK attempt is closed as unknown");
  assert.equal(h.calls.length, 1, "ACKs are never re-sent by the pump");
});

// ── P4–P6 notices ────────────────────────────────────────────────────────────────────────
test("P4 limits -> stalled + exactly one notice in the same pass; daily repeat afterwards; nothing sent", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "sent", [attempt(1, T0 - 48 * HOUR, "handed_over")]);
  // the 19 probes were sent already; the latest at +46 h
  await h.store.mutate(outbox(id), (cur) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.probes_out["REQUEST-1"] = { last_seq: 1, sends: [attempt(1, T0 - 2 * HOUR, "handed_over")] };
    return { write: next, value: null };
  });
  assert.equal(await pump(h), 0, h.err.join("\n"));
  const r = await rec(h, outbox(id));
  assert.equal(r.state, "stalled");
  assert.equal(r.next_action.code, "HUMAN");
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0]!.dest, SID);
  const text = h.notices[0]!.text;
  assert.ok(text.startsWith(`${NOTICE_MARKER} STALLED request_id=${id} `), text);
  assert.match(text, /state=stalled/);
  assert.match(text, new RegExp(`\\nnext: bin/controller-link\\.sh status --request ${id}`));
  assert.ok(!text.includes("⟦aigentry-ctl"), "a notice is not an envelope");
  assert.equal(h.calls.length, 0);
  await pump(h);
  h.now.ms = T0 + DAY - MIN;
  await pump(h);
  assert.equal(h.notices.length, 1, "once per day");
  h.now.ms = T0 + DAY;
  await pump(h);
  assert.equal(h.notices.length, 2);
  assert.equal((await rec(h, outbox(id))).notices.n, 2);
});

test("P5 inbox received unbound: notices at +10 and +30 min naming the request and `status --request <id>`; a refused notice is retried", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedReceiver(h, id, "received");
  h.now.ms = T0 + 10 * MIN - 1;
  await pump(h);
  assert.equal(h.notices.length, 0);
  h.noticeRc = 1;
  h.now.ms = T0 + 10 * MIN;
  await pump(h);
  assert.equal(h.notices.length, 1, "attempted");
  assert.equal((await rec(h, inbox(id))).notices.n, 0, "a refused notice is not counted");
  h.noticeRc = 0;
  h.now.ms = T0 + 11 * MIN;
  await pump(h);
  assert.equal(h.notices.length, 2);
  assert.match(h.notices[1]!.text, /UNBOUND/);
  assert.ok(h.notices[1]!.text.endsWith(`waits for bind or refuse\nnext: bin/controller-link.sh status --request ${id}`), h.notices[1]!.text);
  h.now.ms = T0 + 12 * MIN;
  await pump(h);
  assert.equal(h.notices.length, 2);
  h.now.ms = T0 + 30 * MIN;
  await pump(h);
  assert.equal(h.notices.length, 3);
});

test("P6 a record whose peer is no longer link v1: no send, state kept, exactly one notice", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "send_refused", [attempt(1, T0, "refused_definite")], {}, "old");
  h.now.ms = T0 + HOUR;
  await pump(h);
  await pump(h);
  h.now.ms = T0 + 3 * DAY;
  await pump(h);
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!.text, /PEER_UNCONFIGURED/);
  const r = await rec(h, outbox(id));
  assert.equal(r.state, "send_refused");
  assert.equal(r.messages["REQUEST-1"]!.sends!.length, 1);
});

// ── P7 per-pass budget ───────────────────────────────────────────────────────────────────
test("P7 per pass: at most 20 sends and 10 notices; the rest is deferred to the next pass", async (t) => {
  const h = harness(t);
  for (let i = 0; i < PASS_SENDS_MAX + 5; i++) await seedSender(h, randomUUID(), "sent", [attempt(1, T0, "handed_over")]);
  for (let i = 0; i < PASS_NOTICES_MAX + 2; i++) await seedSender(h, randomUUID(), "stalled", [attempt(1, T0, "unknown")]);
  h.now.ms = T0 + 5 * MIN;
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.equal(h.calls.length, PASS_SENDS_MAX);
  assert.equal(h.notices.length, PASS_NOTICES_MAX);
  assert.equal(h.out.filter((l) => l.startsWith("PUMP_DEFERRED ")).length, 5 + 2);
  h.calls.length = 0;
  h.notices.length = 0;
  h.now.ms = T0 + 6 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 5, "the deferred probes go next pass");
  assert.equal(h.notices.length, 2);
});

test("P7 a send starts only if its 120 s timeout fits in the 240 s pass", async (t) => {
  const h = harness(t);
  for (let i = 0; i < 5; i++) await seedSender(h, randomUUID(), "sent", [attempt(1, T0, "handed_over")]);
  h.monoPerSend = 100_000;
  h.now.ms = T0 + 5 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 2, "0 s and 100 s fit; at 200 s a 120 s send does not");
});

// ── P8 two pumps ─────────────────────────────────────────────────────────────────────────
test("P8 a claimed attempt with a live owner is never taken over; two concurrent pumps send one probe", async (t) => {
  const h = harness(t);
  const claimed = randomUUID();
  await seedSender(h, claimed, "sent", [attempt(1, T0, "handed_over")], {
    probes_out: { "REQUEST-1": { last_seq: 1, sends: [attempt(1, T0 + 5 * MIN, "pending", { owner: `4343@${HOST}` })] } },
  });
  h.alive.set(4343, true);
  h.now.ms = T0 + 9 * MIN;
  await pump(h);
  assert.equal(h.calls.length, 0, "the live owner's probe is not repeated");
  const due = randomUUID();
  await seedSender(h, due, "sent", [attempt(1, T0, "handed_over")]);
  const other: PumpDeps = { ...h.deps, proc: { pid: 4343, host: HOST } };
  await Promise.all([pumpOnce(h.deps), pumpOnce(other)]);
  const probes = sentEnvelopes(h).filter((f) => f.id === due);
  assert.equal(probes.length, 1, "exactly one PROBE for one due record");
});

// ── §9.3 verify, §4 retention, off switch, usage ─────────────────────────────────────────
/** The controller follows a CORROBORATED notice: its own `ingest` of the named stored copy (CL-05). */
async function ingestStoredCopy(h: H, sha256: string): Promise<number> {
  h.out.length = 0;
  h.err.length = 0;
  return runCli(["ingest"], { ...h.deps, proc: { pid: CLI_PID, host: HOST }, readStdin: async () => fs.readFileSync(h.store.rawPath(sha256)) });
}

const corroboratedNotices = (h: H, id: string): string[] =>
  h.notices.map((n) => n.text).filter((x) => x.startsWith(`${NOTICE_MARKER} CORROBORATED request_id=${id} `));

test("§9.3 / CL-05 an unverified inbox request is re-checked; once corroborated the pump applies nothing and a notice hands it to the controller's own ingest", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedReceiver(h, id, "unverified");
  h.now.ms = T0 + MIN;
  await pump(h);
  assert.equal((await rec(h, inbox(id))).state, "unverified", "still not in the audit");
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 0);
  h.rows.push({ inject_id: randomUUID(), to: SID, claimed_from: "controller-link", payload_sha256: e.sha256,
    claimed_cross_host: true, delivery_result: "success" });
  h.now.ms = T0 + 2 * MIN;
  assert.equal(await pump(h), 0, h.err.join("\n"));
  let r = await rec(h, inbox(id));
  assert.equal(r.state, "unverified", "the pump does not apply the request: no NEW is consumed out of the controller's sight");
  assert.equal(h.calls.length, 0, "the pump sends no ACK");
  assert.ok(h.out.some((l) => l.startsWith(`PUMP_VERIFY request=${id} `) && l.includes("corroborated=1")));
  const shown = corroboratedNotices(h, id);
  assert.equal(shown.length, 1, "presented to the controller in the same pass");
  assert.ok(shown[0]!.endsWith(`\nnext: bin/controller-link.sh status --request ${id}`), shown[0]);
  assert.ok(!shown[0]!.includes(h.store.rawPath(e.sha256)) && !shown[0]!.includes("ingest <"), "CL-19: no path, no command built from stored text");
  assert.ok(!shown[0]!.includes("linux asks mac for work"), "the notice carries no peer body");
  // The controller follows the notice: its own ingest prints RESULT=NEW with the quoted body, sends the ACK.
  assert.equal(await ingestStoredCopy(h, e.sha256), 0, h.out.join("\n"));
  assert.ok(h.out.some((l) => l.startsWith(`RESULT=NEW kind=REQUEST id=${id} `)), h.out.join("\n"));
  assert.ok(h.out.includes("| linux asks mac for work"), h.out.join("\n"));
  r = await rec(h, inbox(id));
  assert.equal(r.state, "received");
  assert.equal(sentEnvelopes(h).filter((f) => f.kind === "ACK" && f.state === "received").length, 1);
  h.now.ms = T0 + 5 * HOUR;
  await pump(h);
  assert.equal(corroboratedNotices(h, id).length, 1, "applied: no further presentation");
});

test("CL-05 a final REPLY corroborated only by the pump's re-check is presented, not applied: the sender stays `accepted` until its own ingest", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "accepted", [attempt(1, T0 - DAY, "handed_over")]);
  const reply = envelope(fields("REPLY", id, PEER, SELF, { outcome: "done", final: "yes", receiver_task: "2026112102" }), "the final result");
  await h.store.mutate(outbox(id), (cur, m) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.acks_in["REQUEST-1"] = { last_seq: 1, state: "accepted", at: iso(T0 - DAY) };
    next.unverified_copies = [Object.assign({ sha256: reply.sha256, raw: `raw/${reply.sha256}.env`, at: m.nowIso }, { key: "REPLY-1" })];
    return { write: next, raws: [{ sha256: reply.sha256, bytes: Buffer.from(reply.text, "utf8") }], value: null };
  });
  h.now.ms = T0 + MIN;
  await pump(h);
  assert.equal(h.notices.length, 0, "not corroborated yet (the audit had no row)");
  h.rows.push({ inject_id: randomUUID(), to: SID, claimed_from: "controller-link", payload_sha256: reply.sha256,
    claimed_cross_host: true, delivery_result: "success" });
  h.now.ms = T0 + 2 * MIN;
  await pump(h);
  let r = await rec(h, outbox(id));
  assert.equal(r.state, "accepted", "the pump never marks the sender replied");
  assert.equal(r.messages["REPLY-1"], undefined);
  assert.equal(h.calls.length, 0, "the pump sends no ACK");
  const shown = corroboratedNotices(h, id);
  assert.equal(shown.length, 1);
  assert.ok(shown[0]!.endsWith(`\nnext: bin/controller-link.sh status --request ${id}`), shown[0]);
  assert.ok(!shown[0]!.includes(h.store.rawPath(reply.sha256)) && !shown[0]!.includes("ingest <"), "CL-19: no path, no command built from stored text");
  assert.equal(await ingestStoredCopy(h, reply.sha256), 0, h.out.join("\n"));
  assert.ok(h.out.some((l) => l.startsWith(`RESULT=NEW kind=REPLY id=${id} `)), h.out.join("\n"));
  assert.ok(h.out.includes("| the final result"), h.out.join("\n"));
  r = await rec(h, outbox(id));
  assert.equal(r.state, "replied");
  assert.equal(sentEnvelopes(h).filter((f) => f.kind === "ACK" && f.ref === "REPLY-1" && f.state === "received").length, 1);
  h.now.ms = T0 + 5 * HOUR;
  await pump(h);
  assert.equal(corroboratedNotices(h, id).length, 1, "applied: no further presentation");
});

test("CL-01 at the pump: one ACK `unknown` authorises one re-send even when the wall clock moves backward", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedSender(h, id, "send_unknown", [attempt(1, T0, "unknown")]);
  h.now.ms = T0 + 30 * MIN;
  await h.store.mutate(outbox(id), (cur, m) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.acks_in["REQUEST-1"] = { last_seq: 1, state: "unknown", at: m.nowIso };
    next.history.push({ at: m.nowIso, event: "ack_in", detail: "REQUEST-1 seq=1 state=unknown" });
    return { write: next, value: null };
  });
  h.now.ms = T0 + 20 * MIN; // the wall clock moves back 10 min
  h.replies.push({ rc: null, stdout: "", stderr: "", truncated: false }); // the re-send's result is unknown
  await pump(h);
  assert.equal(h.calls.length, 1);
  assert.equal(lastArg(h.calls[0]!), e.text);
  let r = await rec(h, outbox(id));
  const a2 = r.messages["REQUEST-1"]!.sends!.at(-1)!;
  assert.equal(a2.trigger, "ack_unknown");
  assert.equal(a2.result, "unknown");
  assert.equal(a2.ack_seq, 1, "the consumed ACK sequence is recorded with the attempt");
  for (const m of [21, 22, 24]) {
    h.now.ms = T0 + m * MIN;
    await pump(h);
  }
  assert.equal(h.calls.length, 1, "the same ACK never authorises a second re-send");
  r = await rec(h, outbox(id));
  assert.equal(r.messages["REQUEST-1"]!.answer_resends, 1);
  assert.equal(r.messages["REQUEST-1"]!.sends!.length, 2);
});

test("CL-01 at the pump: a refusal re-send records the refused attempt it consumed (`trigger_n`)", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "send_refused", [attempt(1, T0, "refused_definite")]);
  h.now.ms = T0 + MIN;
  await pump(h);
  const a2 = (await rec(h, outbox(id))).messages["REQUEST-1"]!.sends!.at(-1)!;
  assert.equal(a2.trigger, "refused_definite");
  assert.equal(a2.trigger_n, 1);
  assert.equal(a2.ack_seq, 0);
});

test("CL-08 a re-check's audit queries each start only if their worst case fits before the pass deadline; nothing is sent", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedReceiver(h, id, "unverified");
  const other = envelope(fields("REQUEST", id, PEER, SELF), "another copy of the request");
  await h.store.mutate(inbox(id), (cur, m) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.unverified_copies = [Object.assign({ sha256: other.sha256, raw: `raw/${other.sha256}.env`, at: m.nowIso }, { key: "REQUEST-1" })];
    return { write: next, raws: [{ sha256: other.sha256, bytes: Buffer.from(other.text, "utf8") }], value: null };
  });
  let pages = 0;
  const slow: PumpDeps = { ...h.deps, audit: { async page() { pages += 1; h.mono.ms += 100_000; return { rows: [], next_cursor: null }; } } };
  h.now.ms = T0 + MIN;
  await pump(h, slow);
  assert.equal(pages, 1, "after 100 s a second query (worst case 150 s) does not fit in the 240 s pass");
  assert.ok(h.out.some((l) => l.startsWith(`PUMP_DEFERRED request=${id} `) && l.includes("step=verify")), h.out.join("\n"));
  assert.equal(h.calls.length, 0, "a re-check sends nothing cross-machine");
});

test("CL-08 / CL-18 retention starts only before the pass deadline; what it would delete goes next pass", async (t) => {
  const h = harness(t);
  const old = randomUUID();
  await seedSender(h, old, "replied", [attempt(1, T0 - 31 * DAY, "handed_over")]);
  await seedSender(h, randomUUID(), "sent", [attempt(1, T0, "handed_over")]);
  h.monoPerSend = PASS_WALL_MS + 10_000;
  h.now.ms = T0 + 5 * MIN;
  assert.equal(await pump(h), 3, "a pass that reached its deadline reports it");
  assert.equal(h.calls.length, 1);
  assert.ok(h.out.includes("PUMP_DEADLINE retention is left for the next pass"), h.out.join("\n"));
  assert.equal(fs.existsSync(h.store.recordPath(outbox(old))), true, "retention did not start after the deadline");
  h.monoPerSend = 0;
  h.now.ms = T0 + 6 * MIN;
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.equal(fs.existsSync(h.store.recordPath(outbox(old))), false);
});

test("CL-12 a CONFLICT on a terminal record gets its notice, then daily", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "replied", [attempt(1, T0 - HOUR, "handed_over")], {
    history: [{ at: iso(T0 - HOUR), event: "created", detail: "dispatch" }, { at: iso(T0), event: "conflict", detail: `REPLY-1 sha256=${"f".repeat(64)}` }],
  });
  h.now.ms = T0 + MIN;
  await pump(h);
  assert.equal(h.notices.length, 1);
  assert.ok(h.notices[0]!.text.startsWith(`${NOTICE_MARKER} CONFLICT request_id=${id} `), h.notices[0]!.text);
  assert.match(h.notices[0]!.text, /state=replied/);
  h.now.ms = T0 + DAY - MIN;
  await pump(h);
  assert.equal(h.notices.length, 1);
  h.now.ms = T0 + DAY;
  await pump(h);
  assert.equal(h.notices.length, 2, "daily until retention");
  assert.equal(h.calls.length, 0);
});

test("§4 retention: terminal records 30 days old and raw files no record names are deleted; open records kept", async (t) => {
  const h = harness(t);
  const old = randomUUID();
  const open = randomUUID();
  const oldEnv = await seedSender(h, old, "replied", [attempt(1, T0 - 31 * DAY, "handed_over")]);
  const openEnv = await seedSender(h, open, "accepted", [attempt(1, T0 - 31 * DAY, "handed_over")]);
  const orphan = envelope(fields("REQUEST", randomUUID(), SELF, PEER), "orphan");
  fs.writeFileSync(h.store.rawPath(orphan.sha256), orphan.text, { mode: 0o600 });
  await pump(h);
  assert.equal(fs.existsSync(h.store.recordPath(outbox(old))), false);
  assert.equal(fs.existsSync(h.store.rawPath(oldEnv.sha256)), false);
  assert.equal(fs.existsSync(h.store.rawPath(orphan.sha256)), false);
  assert.equal(fs.existsSync(h.store.recordPath(outbox(open))), true);
  assert.equal(fs.existsSync(h.store.rawPath(openEnv.sha256)), true);
  assert.ok(h.out.includes("PUMP_RETENTION records=1 raws=2"));
});

test("off switch AIGENTRY_CONTROLLER_LINK_PUMP=0: nothing read, nothing sent, no store created; --loop sleeps between passes", async (t) => {
  const h = harness(t);
  const off: PumpDeps = { ...h.deps, env: { ...h.deps.env, [PUMP_SWITCH_ENV]: "0" }, maxPasses: 2 };
  assert.equal(await pump(h, off), 0);
  assert.match(h.out.join("\n"), /disabled \(AIGENTRY_CONTROLLER_LINK_PUMP=0\)/);
  assert.equal(fs.existsSync(h.storeRoot), false);
  assert.equal(await runPump(["--loop", "60"], off), 0);
  assert.deepEqual(h.slept, [60_000]);
  assert.equal(h.calls.length + h.notices.length, 0);
});

test("usage: pump needs --once or --loop <1..99999 s>; an empty store is a clean pass that creates nothing", async (t) => {
  const h = harness(t);
  for (const argv of [[], ["--loop", "0"], ["--loop"], ["--once", "--once"], ["--loop", "x"]]) {
    assert.equal(await runPump(argv, h.deps), 4, argv.join(" "));
  }
  assert.equal(await pump(h), 0);
  assert.equal(fs.existsSync(h.storeRoot), false);
  assert.ok(h.out.at(-1)!.startsWith("controller-link pump: records=0 "));
});

// ── human resend and the cli.ts registration ──────────────────────────────────────────────
test("resend --request <U> --reason: only from stalled; same raw bytes; reason kept in history; state stalled -> sent", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedSender(h, id, "stalled", [attempt(1, T0, "refused_definite")]);
  assert.equal(await runResendCli(["--request", id], h.deps), 4, "reason required");
  assert.equal(await runResendCli(["--request", id, "--reason", "two\nlines"], h.deps), 4);
  assert.equal(h.calls.length, 0);
  assert.equal(await runResendCli(["--request", id, "--reason", "manual duplicate test"], h.deps), 0, h.err.join("\n"));
  assert.equal(h.calls.length, 1);
  assert.equal(lastArg(h.calls[0]!), e.text);
  const r = await rec(h, outbox(id));
  assert.equal(r.state, "sent");
  assert.equal(r.messages["REQUEST-1"]!.sends!.at(-1)!.trigger, "human");
  assert.ok(r.history.some((x) => x.event === "resend" && (x.detail ?? "").includes("manual duplicate test")));
  assert.equal(await runResendCli(["--request", id, "--reason", "again"], h.deps), 3, "no longer stalled");
  h.replies.push(refused());
  const other = randomUUID();
  await seedSender(h, other, "stalled", [attempt(1, T0, "unknown")]);
  h.err.length = 0;
  assert.equal(await runResendCli(["--request", other, "--reason", "peer back"], h.deps), 11);
  assert.match(h.err.join("\n"), /PEER_NOT_DELIVERED: .*the pump reconciles this automatically; do not re-run resend/);
});

test("cli.ts registers `pump` and `resend` (dispatch lines + usage text)", async (t) => {
  const h = harness(t);
  assert.match(USAGE, /\n {2}resend {2}--request <U> --reason/);
  assert.match(USAGE, /\n {2}pump {4}--once \| --loop <seconds>/);
  const off: PumpDeps = { ...h.deps, env: { ...h.deps.env, [PUMP_SWITCH_ENV]: "0" } };
  assert.equal(await runCli(["pump", "--once"], off), 0);
  assert.ok(h.out.some((l) => l.includes("disabled")));
  const id = randomUUID();
  await seedSender(h, id, "sent", [attempt(1, T0, "handed_over")]);
  assert.equal(await runCli(["resend", "--request", id, "--reason", "x"], h.deps), 3);
  assert.match(h.err.join("\n"), /STATE_INVALID: .*resend needs 'stalled'/);
});

test("HOLD-1 Q4 at the pump: an uncorroborated REPLY copy older than 48 h is not re-checked and does not change `accepted`; daily notice", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "accepted", [attempt(1, T0 - DAY, "handed_over")]);
  const reply = envelope(fields("REPLY", id, PEER, SELF, { outcome: "done", final: "yes", receiver_task: "2026112102" }), "done");
  await h.store.mutate(outbox(id), (cur, m) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.acks_in["REQUEST-1"] = { last_seq: 1, state: "accepted", at: iso(T0 - DAY) };
    next.unverified_copies = [Object.assign({ sha256: reply.sha256, raw: `raw/${reply.sha256}.env`, at: m.nowIso }, { key: "REPLY-1" })];
    return { write: next, raws: [{ sha256: reply.sha256, bytes: Buffer.from(reply.text, "utf8") }], value: null };
  });
  h.now.ms = T0 + MIN;
  await pump(h);
  assert.ok(h.out.some((l) => l.startsWith(`PUMP_VERIFY request=${id} `)), "re-checked inside 48 h");
  h.now.ms = T0 + 48 * HOUR;
  await pump(h);
  assert.ok(!h.out.some((l) => l.startsWith("PUMP_VERIFY ")), "no re-check after 48 h");
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0]!.text, /REPLY_UNVERIFIED/);
  assert.equal((await rec(h, outbox(id))).state, "accepted", "state kept");
  h.now.ms = T0 + 48 * HOUR + HOUR;
  await pump(h);
  assert.equal(h.notices.length, 1);
  h.now.ms = T0 + 72 * HOUR;
  await pump(h);
  assert.equal(h.notices.length, 2, "daily");
  assert.equal((await rec(h, outbox(id))).state, "accepted");
  assert.equal(h.calls.length, 0, "nothing sent to the peer");
});

// ── Second review (round 2): CL-05, CL-08, CL-12, CL-18, CL-19 ────────────────────────────
const auditRow = (sha256: string): AuditRow => ({ inject_id: randomUUID(), to: SID, claimed_from: "controller-link",
  payload_sha256: sha256, claimed_cross_host: true, delivery_result: "success" });

test("CL-05 round 2: a request the pump found corroborated is not lost by the 48 h stall: CORROBORATED repeats every 2 h on the stalled record until the controller's own ingest applies it", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedReceiver(h, id, "unverified");
  h.rows.push(auditRow(e.sha256));
  h.now.ms = T0 + MIN;
  await pump(h);
  assert.equal(corroboratedNotices(h, id).length, 1);
  // The controller has not picked it up (busy, or its own audit lookup missed the row); the 48 h limit stalls the record.
  h.now.ms = T0 + 48 * HOUR + MIN;
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.equal((await rec(h, inbox(id))).state, "stalled");
  assert.equal(corroboratedNotices(h, id).length, 2, "still presented after the stall");
  assert.equal(h.notices.filter((n) => n.text.startsWith(`${NOTICE_MARKER} STALLED `)).length, 0, "not replaced by a STALLED series");
  h.now.ms = T0 + 49 * HOUR;
  await pump(h);
  assert.equal(corroboratedNotices(h, id).length, 2);
  h.now.ms = T0 + 50 * HOUR + MIN;
  await pump(h);
  assert.equal(corroboratedNotices(h, id).length, 3, "every 2 h");
  for (const n of corroboratedNotices(h, id)) assert.ok(n.endsWith(`\nnext: bin/controller-link.sh status --request ${id}`), n);
  // The controller acts: its own ingest of the stored copy applies it (stalled is a placeholder state).
  h.now.ms = T0 + 50 * HOUR + 2 * MIN;
  assert.equal(await ingestStoredCopy(h, e.sha256), 0, h.out.join("\n"));
  assert.ok(h.out.some((l) => l.startsWith(`RESULT=NEW kind=REQUEST id=${id} `)), h.out.join("\n"));
  assert.equal((await rec(h, inbox(id))).state, "received");
  for (const m of [52, 54, 60]) {
    h.now.ms = T0 + m * HOUR + MIN;
    await pump(h);
  }
  assert.equal(corroboratedNotices(h, id).length, 3, "acted: the presentation ends");
});

test("CL-05 round 2: a REPLY first stored unverified on a terminal record is re-checked and presented; the controller's own ingest ends it", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "replied", [attempt(1, T0 - DAY, "handed_over")]);
  const late = envelope(fields("REPLY", id, PEER, SELF, { seq: 2, outcome: "done", final: "no", receiver_task: "2026112102" }), "a late note");
  await h.store.mutate(outbox(id), (cur, m) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.unverified_copies = [Object.assign({ sha256: late.sha256, raw: `raw/${late.sha256}.env`, at: m.nowIso }, { key: "REPLY-2" })];
    return { write: next, raws: [{ sha256: late.sha256, bytes: Buffer.from(late.text, "utf8") }], value: null };
  });
  h.rows.push(auditRow(late.sha256));
  h.now.ms = T0 + MIN;
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.ok(h.out.some((l) => l.startsWith(`PUMP_VERIFY request=${id} `) && l.includes("corroborated=1")), h.out.join("\n"));
  assert.equal(corroboratedNotices(h, id).length, 1);
  assert.equal((await rec(h, outbox(id))).state, "replied", "the pump applies nothing");
  assert.equal(h.calls.length, 0);
  assert.equal(await ingestStoredCopy(h, late.sha256), 0, h.out.join("\n"));
  assert.ok(h.out.some((l) => l.startsWith(`RESULT=NEW kind=REPLY id=${id} seq=2 `)), h.out.join("\n"));
  h.now.ms = T0 + 3 * HOUR;
  await pump(h);
  assert.equal(corroboratedNotices(h, id).length, 1, "acted: the presentation ends");
});

test("CL-08 round 2: a send's child is killed by the pass deadline — its timeout is cut to the time left after a slow claim; the attempt is `unknown`, never refused", async (t) => {
  const h = harness(t);
  const first = randomUUID();
  await seedSender(h, first, "send_refused", [attempt(1, T0, "refused_definite")]);
  const seen: number[] = [];
  let lag = 200_000;
  const deps: PumpDeps = {
    ...h.deps,
    runner: {
      async run(_bin, argv, opts) {
        seen.push(opts.timeoutMs);
        h.calls.push({ argv: [...argv] });
        // This telepty needs 60 s; a shorter timeout kills it (rc null), as send.ts defaultProcessRunner does.
        return opts.timeoutMs < 60_000 ? { rc: null, stdout: "", stderr: "killed", truncated: false } : okReply();
      },
    },
    fault: (p) => { if (p === "after_commit") h.mono.ms += lag; }, // the claim's lock wait, between the check and the child
  };
  h.now.ms = T0 + MIN;
  await pump(h, deps);
  assert.deepEqual(seen, [PASS_WALL_MS - 200_000 - KILL_GRACE_MS], "the child's timeout is what is left of the pass");
  let r = await rec(h, outbox(first));
  assert.equal(r.messages["REQUEST-1"]!.sends!.at(-1)!.trigger, "refused_definite");
  assert.equal(r.messages["REQUEST-1"]!.sends!.at(-1)!.result, "unknown", "killed by the deadline: unknown, never a definite refusal");
  assert.equal(r.state, "send_unknown");
  // No time left at all: the child is not started, and the committed attempt is still `unknown`.
  const second = randomUUID();
  await seedSender(h, second, "send_refused", [attempt(1, T0 + MIN, "refused_definite")]);
  lag = PASS_WALL_MS;
  h.now.ms = T0 + 2 * MIN;
  await pump(h, deps);
  assert.equal(seen.length, 1, "not started");
  r = await rec(h, outbox(second));
  assert.equal(r.messages["REQUEST-1"]!.sends!.at(-1)!.result, "unknown");
  assert.equal(r.state, "send_unknown");
});

test("CL-08 round 2: an audit query's child is killed by the pass deadline too (the production reader over the pass runner); a killed query corroborates nothing", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedReceiver(h, id, "unverified");
  h.rows.push(auditRow(e.sha256)); // the harness's own audit port would corroborate it
  const seen: number[] = [];
  const runner: ProcessRunner = {
    async run(_bin, argv, opts) {
      seen.push(opts.timeoutMs);
      assert.equal(argv[0], "injects");
      return opts.timeoutMs < 20_000 ? { rc: null, stdout: "", stderr: "killed", truncated: false }
        : { rc: 0, stdout: JSON.stringify({ injects: [auditRow(e.sha256)] }), stderr: "", truncated: false };
    },
  };
  const deps = {
    ...h.deps,
    runner,
    // 220 s pass before the child starts (a slow raw read, say): 15 s are left, less the 5 s kill grace.
    auditWith: (bounded: ProcessRunner) => defaultAuditReader({ run(bin, argv, opts) { h.mono.ms = 220_000; return bounded.run(bin, argv, opts); } },
      "telepty-fake", {}),
  } as PumpDeps;
  h.now.ms = T0 + MIN;
  await pump(h, deps);
  assert.deepEqual(seen, [PASS_WALL_MS - 220_000 - KILL_GRACE_MS]);
  assert.equal((await rec(h, inbox(id))).notices.corroborated, undefined, "a killed audit query corroborates nothing");
  assert.equal(corroboratedNotices(h, id).length, 0);
  assert.ok(h.out.some((l) => l.startsWith(`PUMP_VERIFY request=${id} `) && l.includes("corroborated=0")), h.out.join("\n"));
});

test("CL-08 round 2: retention checks the deadline before every file; selected raws wait until every selected record is gone", async (t) => {
  const h = harness(t);
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const envs: Envelope[] = [];
  for (const id of ids) envs.push(await seedSender(h, id, "replied", [attempt(1, T0 - 31 * DAY, "handed_over")]));
  // Every monotonic read advances 40 s: #1 the pass start, #2–#4 one deadline check per record, #5 before
  // retention (160 s elapsed), #6 before the first file (200 s: deleted), #7 before the second (240 s: stop).
  let mono = 0;
  const deps: PumpDeps = { ...h.deps, monoMs: () => (mono += 40_000) };
  h.now.ms = T0;
  assert.equal(await pump(h, deps), 3, "a pass that reached its deadline reports it");
  assert.equal(ids.filter((id) => fs.existsSync(h.store.recordPath(outbox(id)))).length, 2, "one record deleted, the rest left");
  assert.ok(envs.every((e) => fs.existsSync(h.store.rawPath(e.sha256))), "no raw deleted while a selected record remains");
  assert.ok(h.out.includes("PUMP_RETENTION records=1 raws=0"), h.out.join("\n"));
  assert.ok(h.out.includes("PUMP_DEADLINE retention stopped; the rest is deleted by the next pass"), h.out.join("\n"));
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.ok(ids.every((id) => !fs.existsSync(h.store.recordPath(outbox(id)))));
  assert.ok(envs.every((e) => !fs.existsSync(h.store.rawPath(e.sha256))));
});

test("CL-12 round 2: a terminal record the store still retains (a message stored after it became terminal) gets its CONFLICT notice past 30 days from state_at", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedSender(h, id, "replied", [attempt(1, T0 - 31 * DAY, "handed_over")]); // state_at = T0 − 31 days
  const late = envelope(fields("REPLY", id, PEER, SELF, { seq: 2, outcome: "done", final: "no", receiver_task: "2026112102" }), "late");
  await h.store.mutate(outbox(id), (cur) => {
    const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
    next.messages["REPLY-2"] = { sha256: late.sha256, body_sha256: late.body_sha256, raw: `raw/${late.sha256}.env`, outcome: "done",
      final: "no", ingested_at: iso(T0 - DAY) };
    next.history.push({ at: iso(T0), event: "conflict", detail: `REPLY-2 sha256=${"f".repeat(64)}` });
    return { write: next, raws: [{ sha256: late.sha256, bytes: Buffer.from(late.text, "utf8") }], value: null };
  });
  h.now.ms = T0 + MIN;
  assert.equal(await pump(h), 0, h.err.join("\n"));
  assert.equal(fs.existsSync(h.store.recordPath(outbox(id))), true, "retained: its last message was stored a day ago");
  assert.equal(h.notices.length, 1);
  assert.ok(h.notices[0]!.text.startsWith(`${NOTICE_MARKER} CONFLICT request_id=${id} `), h.notices[0]!.text);
});

test("CL-18 round 2: a pass starts at a rotating cursor, so a record behind a slow prefix is reached; at most PASS_RECORDS_MAX records per pass", async (t) => {
  const h = harness(t);
  const a1 = "00000000-0000-4000-8000-000000000001";
  const a2 = "00000000-0000-4000-8000-000000000002";
  const z = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  for (const id of [a1, a2]) {
    await seedSender(h, id, "accepted", [attempt(1, T0 - DAY, "handed_over")]);
    const copy = envelope(fields("REPLY", id, PEER, SELF, { outcome: "done", final: "yes", receiver_task: "2026112102" }), `reply ${id}`);
    await h.store.mutate(outbox(id), (cur, m) => {
      const next = JSON.parse(JSON.stringify(cur)) as LinkRecord;
      next.acks_in["REQUEST-1"] = { last_seq: 1, state: "accepted", at: iso(T0 - DAY) };
      next.unverified_copies = [Object.assign({ sha256: copy.sha256, raw: `raw/${copy.sha256}.env`, at: m.nowIso }, { key: "REPLY-1" })];
      return { write: next, raws: [{ sha256: copy.sha256, bytes: Buffer.from(copy.text, "utf8") }], value: null };
    });
  }
  await seedSender(h, z, "sent", [attempt(1, T0, "handed_over")]);
  // Each re-check of a1's / a2's copy (not in the audit yet) takes 130 s of the 240 s pass, so without a cursor
  // every pass spends itself on a1 and defers a2 and z (a send needs 120 s), forever while the copies are fresh.
  const slow: PumpDeps = { ...h.deps, audit: { async page() { h.mono.ms += 130_000; return { rows: [] }; } } };
  for (const m of [5, 6, 7]) {
    h.now.ms = T0 + m * MIN;
    assert.equal(await pump(h, slow), 0, h.err.join("\n"));
  }
  assert.equal(sentEnvelopes(h).filter((f) => f.kind === "PROBE" && f.id === z).length, 1, "z is reached and probed");
  const cursor = JSON.parse(fs.readFileSync(path.join(h.storeRoot, CURSOR_FILE), "utf8")) as { v: number; next: string };
  assert.equal(cursor.v, 1);
  assert.ok(cursor.next.endsWith(a2), "the next pass starts at the first record this one deferred");
  assert.equal(PASS_RECORDS_MAX, 256, "the per-pass visit bound");
});

test("CL-19 round 2: every notice is two lines naming only the request and `bin/controller-link.sh status --request <id>`; no path, no stored text", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await seedReceiver(h, id, "unverified");
  const r = await rec(h, inbox(id));
  r.refuse_reason = "$(touch /tmp/x)";
  r.history.push({ at: iso(T0), event: "stalled", detail: "`id` $(whoami)  two  spaces" });
  const hostile = path.join(tmpdir(), "a  b $(touch x) `id`", "raw", `${e.sha256}.env`);
  for (const kind of NOTICE_PRIORITY) {
    const text = renderControllerNotice(r, kind, 1, hostile);
    const lines = text.split("\n");
    assert.equal(lines.length, 2, kind);
    assert.ok(lines[0]!.startsWith(`${NOTICE_MARKER} ${kind.toUpperCase()} request_id=${id} role=receiver peer=${PEER} state=unverified `), lines[0]);
    assert.equal(lines[1], `next: bin/controller-link.sh status --request ${id}`, kind);
    for (const bad of ["$(", "`", "  ", "raw/", tmpdir(), "ingest <", "controller-peers.json", e.sha256]) {
      assert.ok(!text.includes(bad), `${kind}: ${bad}`);
    }
  }
});
