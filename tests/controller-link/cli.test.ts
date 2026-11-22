// Task 1291 — controller-link CLI (U6): TEST-PLAN §2.6 I1–I10 and §2.7 B1–B4, plus the §9.4
// status line, the manual probe, close and the §2 configuration refusals.
// Injected: clock, process runner (fake telepty inject), audit reader (fake `telepty injects`),
// store root and peer config (temp dir per test), task queue (fixture file via AIGENTRY_TASK_QUEUE,
// read by the real U4 reader). No real telepty, daemon or session is touched.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";
import { REFUSE_REASONS, parseEnvelope, renderEnvelope, type Envelope, type EnvelopeFields } from "../../src/controller-link/envelope.js";
import type { ProcessRunner, RunnerResult } from "../../src/controller-link/send.js";
import { ControllerLinkStore, type LinkRecord, type RecordRef, type RecordState } from "../../src/controller-link/store.js";
import type { AuditQuery, AuditReader, AuditRow, CliDeps } from "../../src/controller-link/cli.js";

// U4's reader captures AIGENTRY_TASK_QUEUE when it is first imported, so the variable is set
// before cli.js (which imports it) is loaded. Each test rewrites this one fixture file.
const QUEUE_DIR = fs.mkdtempSync(path.join(tmpdir(), "controller-link-cli-queue-"));
const QUEUE = path.join(QUEUE_DIR, "task-queue.json");
process.env.AIGENTRY_TASK_QUEUE = QUEUE;
const cli = await import("../../src/controller-link/cli.js");
const { taskQueueStatus } = await import("../../src/dispatch/task-queue-read.js");
after(() => fs.rmSync(QUEUE_DIR, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-22T12:00:00.000Z");
const SELF = "linux";
const PEER = "mac";
const PEER_TARGET = "orchestrator@mac-box";
const SID = "orchestrator";
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const wire = (ms: number): string => `${iso(ms).slice(0, 19)}Z`;
const okReply = (): RunnerResult => ({ rc: 0, stdout: `inject_id: ${randomUUID()}\n✅ Submitted — consumed as a new turn.\n`, stderr: "", truncated: false });

interface Call { bin: string; argv: string[] }

interface H {
  base: string;
  storeRoot: string;
  now: { ms: number };
  calls: Call[];
  replies: RunnerResult[];
  rows: AuditRow[];
  auditDown: boolean;
  queries: AuditQuery[];
  out: string[];
  err: string[];
  stdin: string | Buffer;
  onInject: (() => Promise<void>) | null;
  store: ControllerLinkStore;
  deps: CliDeps;
}

function harness(t: TestContext, tasks: unknown[] = []): H {
  const base = fs.mkdtempSync(path.join(tmpdir(), "controller-link-cli-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const peersFile = path.join(base, "controller-peers.json");
  fs.writeFileSync(peersFile, JSON.stringify({ v: 1, self: { label: SELF, controller_sid: SID },
    peers: { mac: { target: PEER_TARGET, link: "v1" }, old: { target: "orchestrator@old-box" } } }));
  fs.writeFileSync(QUEUE, JSON.stringify({ tasks }));
  const storeRoot = path.join(base, "store");
  const now = { ms: T0 };
  const h: H = {
    base, storeRoot, now, calls: [], replies: [], rows: [], auditDown: false, queries: [], out: [], err: [], stdin: "",
    onInject: null, store: new ControllerLinkStore({ root: storeRoot, clock: { nowMs: () => now.ms } }),
    deps: undefined as unknown as CliDeps,
  };
  const runner: ProcessRunner = {
    async run(bin, argv) {
      h.calls.push({ bin, argv: [...argv] });
      if (h.onInject !== null) await h.onInject();
      return h.replies.shift() ?? okReply();
    },
  };
  const audit: AuditReader = {
    async page(q) {
      h.queries.push(q);
      return h.auditDown ? null : { rows: [...h.rows], next_cursor: null };
    },
  };
  h.deps = {
    env: { AIGENTRY_CONTROLLER_PEERS: peersFile, AIGENTRY_CONTROLLER_LINK_DIR: storeRoot },
    packageRoot: base, clock: { nowMs: () => now.ms }, runner, teleptyBin: "telepty-fake", audit,
    taskStatus: taskQueueStatus, proc: { pid: 4242, host: "test-host" },
    readStdin: async () => (typeof h.stdin === "string" ? Buffer.from(h.stdin, "utf8") : h.stdin),
    readBodyFile: async (f) => fs.readFileSync(f),
    out: (l) => { h.out.push(l); },
    err: (l) => { h.err.push(l); },
  };
  return h;
}

async function run(h: H, argv: string[], stdin?: string | Buffer): Promise<number> {
  h.out.length = 0;
  h.err.length = 0;
  if (stdin !== undefined) h.stdin = stdin;
  return cli.runCli(argv, h.deps);
}

function fields(kind: EnvelopeFields["kind"], id: string, over: Partial<EnvelopeFields> = {}): EnvelopeFields {
  return { kind, id, seq: 1, ref: null, from: PEER, to: SELF, sent_at: wire(T0 - 60_000), sender_task: "1291",
    receiver_task: null, state: null, outcome: null, final: null, reason: null, ...over };
}

function envelope(f: EnvelopeFields, body = ""): Envelope {
  const r = renderEnvelope(f, body);
  if (!r.ok) assert.fail(`fixture envelope refused: ${r.error.code} ${r.error.detail}`);
  return r.envelope;
}

const request = (id: string, body = "Please run the linux leg of task 1291.\nTwo lines.", over: Partial<EnvelopeFields> = {}): Envelope =>
  envelope(fields("REQUEST", id, over), body);

/** The receiver's own daemon logged exactly these bytes arriving cross-host (the fake audit). */
function audited(h: H, e: Envelope, over: Partial<AuditRow> = {}): void {
  h.rows.push({ inject_id: randomUUID(), to: SID, claimed_from: "controller-link", payload_sha256: e.sha256,
    claimed_cross_host: true, delivery_result: "success", ...over });
}

/** Every envelope the CLI handed to telepty, parsed. */
function sent(h: H): EnvelopeFields[] {
  return h.calls.map((c) => {
    const r = parseEnvelope(c.argv[c.argv.length - 1]!);
    if (!r.ok) assert.fail("the CLI sent text that is not a canonical envelope");
    return r.envelope.fields;
  });
}

const inbox = (id: string): RecordRef => ({ role: "receiver", peer: PEER, requestId: id });
const outbox = (id: string): RecordRef => ({ role: "sender", requestId: id });

async function rec(h: H, ref: RecordRef): Promise<LinkRecord> {
  const r = await h.store.read(ref);
  assert.ok(r, "record expected");
  return r;
}

const bytesOf = (h: H, ref: RecordRef): Buffer => fs.readFileSync(h.store.recordPath(ref));
const result = (h: H): string => h.out.find((l) => l.startsWith("RESULT="))?.split(" ")[0] ?? "";

/** Ingest a corroborated REQUEST: receiver record `received`. */
async function received(h: H, id: string, body?: string): Promise<Envelope> {
  const e = body === undefined ? request(id) : request(id, body);
  audited(h, e);
  assert.equal(await run(h, ["ingest"], e.text), 0, h.out.join("\n"));
  return e;
}

/** `received` + bind to a dispatchable local task: receiver record `accepted`. */
async function accepted(h: H, id: string, task = "2026112102"): Promise<void> {
  await received(h, id);
  assert.equal(await run(h, ["bind", "--request", id, "--task", task]), 0, h.err.join("\n"));
}

function bodyFile(h: H, text: string): string {
  const f = path.join(h.base, `body-${randomUUID()}.md`);
  fs.writeFileSync(f, text);
  return f;
}

/** An outbox record as the dispatch peer branch (U5) leaves it: our REQUEST to the peer, handed over. */
async function seedOutbox(h: H, id: string, state: RecordState = "sent"): Promise<Envelope> {
  const e = envelope(fields("REQUEST", id, { from: SELF, to: PEER }), "linux asks mac for work");
  await h.store.mutate(outbox(id), (_cur, m) => ({
    write: {
      v: 1, role: "sender", request_id: id, peer: PEER, peer_target: PEER_TARGET, self_label: SELF, sender_task: "1291",
      receiver_task: null, state, state_at: m.nowIso, next_action: { code: "WAIT_ACK", due_at: m.nowIso, text: "wait" },
      messages: { "REQUEST-1": { sha256: e.sha256, body_sha256: e.body_sha256, raw: `raw/${e.sha256}.env`,
        sends: [{ n: 1, at: m.nowIso, owner: "1@peer", result: "handed_over", submit: "consumed", inject_id: null, detail: null }] } },
      acks_in: {}, probes_out: {}, acks_out: { last_seq: 0, sends: [] }, notices: { n: 0, last_at: null },
      history: [{ at: m.nowIso, event: "created", detail: "dispatch" }], history_dropped: 0,
    },
    raws: [{ sha256: e.sha256, bytes: Buffer.from(e.text, "utf8") }],
    value: null,
  }));
  return e;
}

// ── I1 corroboration ──────────────────────────────────────────────────────────────────────
test("I1 corroboration: exact sha + claimed_cross_host:true + success|queued; each deviation is not; 5-page cap; query error", async (t) => {
  const sha = "a".repeat(64);
  const good: AuditRow = { inject_id: "row-1", to: SID, claimed_from: "controller-link", payload_sha256: sha,
    claimed_cross_host: true, delivery_result: "success" };
  assert.equal(cli.rowCorroborates(good, sha, SID), true);
  assert.equal(cli.rowCorroborates({ ...good, delivery_result: "queued" }, sha, SID), true);
  const noFlag: AuditRow = { ...good };
  delete noFlag.claimed_cross_host; // an old daemon's row (COMPATIBILITY §2)
  const deviations: Array<[string, AuditRow]> = [
    ["other sha", { ...good, payload_sha256: "b".repeat(64) }],
    ["flag false", { ...good, claimed_cross_host: false }],
    ["flag missing", noFlag],
    ["flag as a string", { ...good, claimed_cross_host: "true" }],
    ["failed:*", { ...good, delivery_result: "failed:SESSION_NOT_FOUND" }],
    ["blocked:*", { ...good, delivery_result: "blocked:peer_lane" }],
    ["other to", { ...good, to: "worker-7" }],
    ["other claimed_from", { ...good, claimed_from: "dispatch-tracker" }],
  ];
  for (const [name, row] of deviations) {
    assert.equal(cli.rowCorroborates(row, sha, SID), false, name);
    const one: AuditReader = { async page() { return { rows: [row], next_cursor: null }; } };
    assert.deepEqual(await cli.corroborate(one, sha, SID, T0), { state: "not_found", inject_id: null, pages: 1 }, name);
  }

  // The query, and the cursor followed for at most 5 pages.
  const queries: AuditQuery[] = [];
  const endless: AuditReader = {
    async page(q) {
      queries.push(q);
      return { rows: [{ ...good, payload_sha256: "c".repeat(64) }], next_cursor: `p${queries.length}` };
    },
  };
  assert.deepEqual(await cli.corroborate(endless, sha, SID, T0), { state: "not_found", inject_id: null, pages: 5 });
  assert.equal(queries.length, 5);
  assert.deepEqual(queries[0], { to: SID, from: "controller-link", since: iso(T0 - 48 * 3_600_000), limit: 200, cursor: null });
  assert.deepEqual(queries.slice(1).map((q) => q.cursor), ["p1", "p2", "p3", "p4"]);
  let n = 0;
  const third: AuditReader = { async page() { n++; return { rows: n === 3 ? [good] : [], next_cursor: `p${n}` }; } };
  assert.deepEqual(await cli.corroborate(third, sha, SID, T0), { state: "corroborated", inject_id: "row-1", pages: 3 });
  assert.equal((await cli.corroborate({ async page() { return null; } }, sha, SID, T0)).state, "audit_unavailable");
  assert.equal((await cli.corroborate({ async page() { throw new Error("daemon down"); } }, sha, SID, T0)).state, "audit_unavailable");

  // The real reader: argv, child env, `{"injects":[…]}` parsing, failures → null, no cursor guessing.
  const calls: Array<{ bin: string; argv: string[]; env: NodeJS.ProcessEnv }> = [];
  let reply: RunnerResult = { rc: 0, stdout: JSON.stringify({ injects: [good, 7, null] }), stderr: "", truncated: false };
  const runner: ProcessRunner = { async run(bin, argv, opts) { calls.push({ bin, argv: [...argv], env: opts.env }); return reply; } };
  const reader = cli.defaultAuditReader(runner, "telepty-x", { HOME: "/h", TELEPTY_SESSION_ID: "worker-sid" });
  const q: AuditQuery = { to: SID, from: "controller-link", since: iso(T0), limit: 200, cursor: null };
  assert.deepEqual(await reader.page(q), { rows: [good], next_cursor: null });
  assert.equal(calls[0]!.bin, "telepty-x");
  assert.deepEqual(calls[0]!.argv, ["injects", "--json", "--to", SID, "--from", "controller-link", "--since", iso(T0), "--limit", "200"]);
  assert.equal(calls[0]!.env.TELEPTY_SESSION_ID, undefined);
  reply = { ...reply, rc: 1 };
  assert.equal(await reader.page(q), null);
  reply = { rc: 0, stdout: "not json", stderr: "", truncated: false };
  assert.equal(await reader.page(q), null);
  reply = { rc: 0, stdout: JSON.stringify({ injects: [good] }), stderr: "", truncated: true };
  assert.equal(await reader.page(q), null);
  const before = calls.length;
  assert.equal(await reader.page({ ...q, cursor: "p1" }), null);
  assert.equal(calls.length, before, "a cursor page is never requested with a guessed flag");

  // Through ingest: a failed audit query stores the REQUEST as unverified and sends nothing.
  const h = harness(t);
  h.auditDown = true;
  const id = randomUUID();
  assert.equal(await run(h, ["ingest"], request(id).text), 5);
  assert.equal(result(h), "RESULT=UNVERIFIED");
  const r = await rec(h, inbox(id));
  assert.equal(r.state, "unverified");
  assert.equal(r.messages["REQUEST-1"]!.corroboration!.state, "audit_unavailable");
  assert.equal(h.calls.length, 0);
});

// ── I2 / I3 ───────────────────────────────────────────────────────────────────────────────
test("I2 new corroborated REQUEST → NEW, record `received` committed before the one ACK `received`", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = request(id);
  audited(h, e);
  const seen: Array<{ state: string; attempt: string | undefined; raw: boolean }> = [];
  h.onInject = async () => {
    const r = await h.store.read(inbox(id));
    seen.push({ state: r?.state ?? "absent", attempt: r?.acks_out.sends[0]?.result, raw: fs.existsSync(h.store.rawPath(e.sha256)) });
  };
  assert.equal(await run(h, ["ingest"], `[telepty] message from mac\n${e.text}`), 0);
  assert.equal(h.out[0], `RESULT=NEW kind=REQUEST id=${id} seq=1 peer=mac state=received answer=received send=handed_over/consumed`);
  assert.ok(h.out.some((l) => l.startsWith("NEXT ") && l.includes(`bind --request ${id} --task`)));
  assert.ok(h.out.includes("| Please run the linux leg of task 1291."), "the body is printed as quoted data lines");
  assert.ok(h.out.includes("| Two lines."));
  assert.ok(h.out.some((l) => l.startsWith("SUMMARY blocks=1 dropped_blocks=0 ignored_lines=1")));
  assert.deepEqual(seen, [{ state: "received", attempt: "pending", raw: true }], "record and raw were on disk before the send");
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.argv.slice(0, -1),
    ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", "controller-link", PEER_TARGET]);
  const [ack] = sent(h);
  assert.deepEqual(ack, { kind: "ACK", id, seq: 1, ref: "REQUEST-1", from: SELF, to: PEER, sent_at: wire(T0),
    sender_task: "1291", receiver_task: null, state: "received", outcome: null, final: null, reason: null });
  const r = await rec(h, inbox(id));
  assert.equal(r.state, "received");
  assert.equal(r.sender_task, "1291");
  assert.equal(r.receiver_task, null);
  assert.equal(r.messages["REQUEST-1"]!.sha256, e.sha256);
  assert.equal(r.messages["REQUEST-1"]!.corroboration!.state, "corroborated");
  assert.equal(r.acks_out.sends[0]!.result, "handed_over");
  assert.equal(r.next_action.code, "BIND_OR_REFUSE");
  assert.deepEqual(fs.readFileSync(h.store.rawPath(e.sha256)), Buffer.from(e.text, "utf8"));
});

test("I3 the same REQUEST again (also as a CRLF/trailing-blank copy) → DUPLICATE, nothing sent", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  const e = await received(h, id);
  const before = bytesOf(h, inbox(id));
  assert.equal(await run(h, ["ingest"], e.text), 0);
  assert.equal(h.out[0], `RESULT=DUPLICATE kind=REQUEST id=${id} seq=1 peer=mac state=received`);
  assert.equal(await run(h, ["ingest"], `${e.text.replace(/\n/g, "  \r\n")}\r\n`), 0);
  assert.equal(result(h), "RESULT=DUPLICATE");
  assert.ok(!h.out.some((l) => l.startsWith("NEXT ") || l.startsWith("| ")), "no next action and no body on a duplicate");
  assert.equal(h.calls.length, 1, "only the first ingest's ACK");
  assert.deepEqual(bytesOf(h, inbox(id)), before);
});

// ── I4 unverified copies ──────────────────────────────────────────────────────────────────
test("I4 an unverified copy never claims the key; corroborated copy wins; two corroborated copies conflict", async (t) => {
  const h = harness(t);
  // (a) uncorroborated first, then a corroborated copy with other bytes → the corroborated copy wins.
  const id = randomUUID();
  const forged = request(id, "forged body, never seen by the audit");
  assert.equal(await run(h, ["ingest"], forged.text), 5);
  assert.equal(h.out[0], `RESULT=UNVERIFIED kind=REQUEST id=${id} seq=1 peer=mac state=unverified`);
  assert.equal(h.calls.length, 0);
  assert.equal((await rec(h, inbox(id))).state, "unverified");
  const real = request(id, "the real body");
  audited(h, real);
  assert.equal(await run(h, ["ingest"], real.text), 0);
  assert.equal(result(h), "RESULT=NEW");
  let r = await rec(h, inbox(id));
  assert.equal(r.state, "received");
  assert.equal(r.messages["REQUEST-1"]!.sha256, real.sha256);
  assert.ok(r.history.some((x) => x.event === "replaced_unverified" && x.detail === `old sha256=${forged.sha256}`));
  assert.equal(sent(h).length, 1);
  assert.equal(sent(h)[0]!.state, "received");

  // (b) an uncorroborated copy after a corroborated record → UNVERIFIED, record unchanged, kept beside.
  const late = request(id, "a look-alike copied from a worker file");
  assert.equal(await run(h, ["ingest"], late.text), 5);
  assert.equal(result(h), "RESULT=UNVERIFIED");
  r = await rec(h, inbox(id));
  assert.equal(r.state, "received");
  assert.equal(r.messages["REQUEST-1"]!.sha256, real.sha256);
  assert.deepEqual(r.unverified_copies?.map((u) => u.sha256), [late.sha256]);
  assert.ok(fs.existsSync(h.store.rawPath(late.sha256)));
  assert.equal(h.calls.length, 1);

  // (c) two corroborated copies with different bytes → CONFLICT, nothing sent.
  const other = request(id, "a second corroborated body");
  audited(h, other);
  assert.equal(await run(h, ["ingest"], other.text), 5);
  assert.equal(result(h), "RESULT=CONFLICT");
  r = await rec(h, inbox(id));
  assert.equal(r.messages["REQUEST-1"]!.sha256, real.sha256);
  assert.ok(r.history.some((x) => x.event === "conflict"));
  assert.equal(h.calls.length, 1);
});

// ── I5 PROBE ──────────────────────────────────────────────────────────────────────────────
test("I5 PROBE is answered with the current state; a second probe within 60 s is DUPLICATE", async (t) => {
  const h = harness(t, [{ id: "2026112102", status: "pending" }]);
  const id = randomUUID();
  await received(h, id);
  const probe = (seq: number): string => envelope(fields("PROBE", id, { ref: "REQUEST-1", seq })).text;
  assert.equal(await run(h, ["ingest"], probe(1)), 0);
  assert.equal(h.out[0], `RESULT=ANSWERED kind=PROBE id=${id} seq=1 peer=mac state=received answer=received send=handed_over/consumed`);
  assert.equal(sent(h).at(-1)!.state, "received");
  assert.equal(h.queries.length, 1, "a PROBE is not corroborated (only the REQUEST was)");
  h.now.ms += 30_000;
  assert.equal(await run(h, ["ingest"], probe(2)), 0);
  assert.equal(result(h), "RESULT=DUPLICATE");
  assert.equal(h.calls.length, 2);
  h.now.ms += 31_000;
  assert.equal(await run(h, ["bind", "--request", id, "--task", "2026112102"]), 0);
  assert.equal(await run(h, ["ingest"], probe(3)), 0);
  assert.equal(result(h), "RESULT=ANSWERED");
  const ack = sent(h).at(-1)!;
  assert.equal(ack.state, "accepted");
  assert.equal(ack.receiver_task, "2026112102");
  // A probe about a request this side has no record of → ACK unknown, nothing stored.
  const stranger = randomUUID();
  assert.equal(await run(h, ["ingest"], envelope(fields("PROBE", stranger, { ref: "REQUEST-1" })).text), 0);
  assert.equal(result(h), "RESULT=ANSWERED");
  assert.equal(sent(h).at(-1)!.state, "unknown");
  assert.equal(await h.store.read(inbox(stranger)), null);
});

// ── I6 ACK ordering at the sender ─────────────────────────────────────────────────────────
test("I6 ACK seq ordering: seq 2 then seq 1 → STALE; `accepted` then a later `received` → no regression", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedOutbox(h, id);
  const ack = (seq: number, state: EnvelopeFields["state"], over: Partial<EnvelopeFields> = {}): Envelope =>
    envelope(fields("ACK", id, { ref: "REQUEST-1", seq, state, ...over }));
  const a2 = ack(2, "accepted", { receiver_task: "77" });
  audited(h, a2);
  assert.equal(await run(h, ["ingest"], a2.text), 0);
  assert.equal(h.out[0], `RESULT=NEW kind=ACK id=${id} seq=2 peer=mac state=accepted`);
  let r = await rec(h, outbox(id));
  assert.equal(r.state, "accepted");
  assert.equal(r.receiver_task, "77");
  const a1 = ack(1, "received");
  audited(h, a1);
  assert.equal(await run(h, ["ingest"], a1.text), 0);
  assert.equal(result(h), "RESULT=STALE");
  const a3 = ack(3, "received");
  audited(h, a3);
  assert.equal(await run(h, ["ingest"], a3.text), 0);
  assert.equal(result(h), "RESULT=DUPLICATE");
  r = await rec(h, outbox(id));
  assert.equal(r.state, "accepted", "a later state never moves back");
  assert.equal(r.acks_in["REQUEST-1"]!.last_seq, 3);
  // An ACK the audit does not show is not applied.
  const a4 = ack(4, "refused", { reason: "out_of_policy" });
  assert.equal(await run(h, ["ingest"], a4.text), 5);
  assert.equal(result(h), "RESULT=UNVERIFIED");
  assert.equal((await rec(h, outbox(id))).state, "accepted");
  assert.equal(h.calls.length, 0, "ACKs are never acknowledged");
});

// ── I7 REPLY at the sender ────────────────────────────────────────────────────────────────
test("I7 REPLY: NEW + ACK received; duplicate + ACK received; unknown request; same seq other bytes → CONFLICT", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedOutbox(h, id, "accepted");
  const reply = envelope(fields("REPLY", id, { seq: 1, outcome: "done", final: "yes", receiver_task: "77" }), "done: see report");
  audited(h, reply);
  assert.equal(await run(h, ["ingest"], reply.text), 0);
  assert.equal(h.out[0], `RESULT=NEW kind=REPLY id=${id} seq=1 peer=mac state=replied answer=received send=handed_over/consumed`);
  assert.ok(h.out.includes("| done: see report"));
  let r = await rec(h, outbox(id));
  assert.equal(r.state, "replied");
  assert.equal(r.receiver_task, "77");
  assert.equal(r.messages["REPLY-1"]!.final, "yes");
  assert.deepEqual(sent(h).map((f) => [f.kind, f.ref, f.state, f.seq]), [["ACK", "REPLY-1", "received", 1]]);
  assert.equal(await run(h, ["ingest"], reply.text), 0);
  assert.equal(h.out[0], `RESULT=DUPLICATE kind=REPLY id=${id} seq=1 peer=mac state=replied answer=received send=handed_over/consumed`);
  assert.deepEqual(sent(h).map((f) => [f.ref, f.state, f.seq]), [["REPLY-1", "received", 1], ["REPLY-1", "received", 2]]);
  const other = envelope(fields("REPLY", id, { seq: 1, outcome: "failed", final: "yes", receiver_task: "77" }), "other bytes");
  audited(h, other);
  assert.equal(await run(h, ["ingest"], other.text), 5);
  assert.equal(result(h), "RESULT=CONFLICT");
  r = await rec(h, outbox(id));
  assert.equal(r.messages["REPLY-1"]!.sha256, reply.sha256);
  assert.equal(h.calls.length, 2);
  // Unknown request: ACK unknown only when corroborated; nothing stored either way.
  const lost = randomUUID();
  const orphan = envelope(fields("REPLY", lost, { seq: 1, outcome: "done", final: "yes" }), "x");
  assert.equal(await run(h, ["ingest"], orphan.text), 4);
  assert.equal(result(h), "RESULT=UNKNOWN_REQUEST");
  assert.equal(h.calls.length, 2, "an uncorroborated orphan REPLY is answered nothing");
  audited(h, orphan);
  assert.equal(await run(h, ["ingest"], orphan.text), 4);
  assert.equal(result(h), "RESULT=UNKNOWN_REQUEST");
  assert.deepEqual([sent(h).at(-1)!.id, sent(h).at(-1)!.state, sent(h).at(-1)!.ref], [lost, "unknown", "REPLY-1"]);
  assert.equal(await h.store.read(outbox(lost)), null);
  // On a machine with no store yet, an orphan REPLY creates nothing on disk.
  const empty = harness(t);
  audited(empty, orphan);
  assert.equal(await run(empty, ["ingest"], orphan.text), 4);
  assert.equal(fs.existsSync(empty.storeRoot), false);
});

// ── I8 / I9 routing and age ───────────────────────────────────────────────────────────────
test("I8 `to` mismatch → NOT_FOR_THIS_CONTROLLER; unknown or non-v1 `from` → PEER_UNKNOWN; nothing stored or queried", async (t) => {
  const h = harness(t);
  const cases: Array<[Partial<EnvelopeFields>, string]> = [
    [{ to: "win" }, "NOT_FOR_THIS_CONTROLLER"],
    [{ from: "win" }, "PEER_UNKNOWN"],
    [{ from: "old" }, "PEER_UNKNOWN"],
  ];
  for (const [over, code] of cases) {
    const e = request(randomUUID(), "x", over);
    audited(h, e);
    assert.equal(await run(h, ["ingest"], e.text), 4, code);
    assert.equal(result(h), `RESULT=${code}`);
  }
  assert.equal(fs.existsSync(h.storeRoot), false, "nothing stored");
  assert.equal(h.queries.length, 0, "refused before the audit query");
  assert.equal(h.calls.length, 0);
});

test("I9 sent_at 25 days + 1 s ago → STALE_MESSAGE (injected clock); exactly 25 days is accepted", async (t) => {
  const h = harness(t);
  const old = request(randomUUID(), "x", { sent_at: wire(T0 - 25 * DAY - 1000) });
  audited(h, old);
  assert.equal(await run(h, ["ingest"], old.text), 4);
  assert.equal(result(h), "RESULT=STALE_MESSAGE");
  assert.equal(fs.existsSync(h.storeRoot), false);
  const edge = request(randomUUID(), "x", { sent_at: wire(T0 - 25 * DAY) });
  audited(h, edge);
  assert.equal(await run(h, ["ingest"], edge.text), 0);
  assert.equal(result(h), "RESULT=NEW");
});

// ── I10 exit aggregation ──────────────────────────────────────────────────────────────────
test("I10 exit code aggregation over mixed blocks: 0 < 5 < 4 < 9", async (t) => {
  assert.equal(cli.worseExit(cli.worseExit(0, 5), 4), 4);
  assert.equal(cli.worseExit(9, 4), 9);
  assert.equal(cli.ingestExitOf("STALE"), 0);
  assert.equal(cli.ingestExitOf("CONFLICT"), 5);
  assert.equal(cli.ingestExitOf("COPY_MISMATCH"), 4);
  assert.equal(cli.ingestExitOf("LINK_CAPACITY"), 9);
  const h = harness(t);
  const ok = request(randomUUID());
  audited(h, ok);
  const probe = envelope(fields("PROBE", randomUUID(), { ref: "REQUEST-1" }));
  assert.equal(await run(h, ["ingest"], `banner line\n${ok.text}\nsome chatter\n${probe.text}`), 0);
  assert.deepEqual(h.out.filter((l) => l.startsWith("RESULT=")).map((l) => l.split(" ")[0]), ["RESULT=NEW", "RESULT=ANSWERED"]);
  assert.ok(h.out.includes("SUMMARY blocks=2 dropped_blocks=0 ignored_lines=2"));
  const fresh = request(randomUUID());
  audited(h, fresh);
  const unseen = request(randomUUID());
  assert.equal(await run(h, ["ingest"], `${fresh.text}\n${unseen.text}`), 5);
  const tampered = request(randomUUID()).text.replace("Two lines.", "Two lines!");
  const stranger = request(randomUUID(), "x", { from: "win" });
  assert.equal(await run(h, ["ingest"], `${request(randomUUID()).text}\n${tampered}\n${stranger.text}`), 4);
  assert.deepEqual(h.out.filter((l) => l.startsWith("RESULT=")).map((l) => l.split(" ")[0]),
    ["RESULT=UNVERIFIED", "RESULT=COPY_MISMATCH", "RESULT=PEER_UNKNOWN"]);
  assert.equal(await run(h, ["ingest"], Buffer.alloc(262_145, 0x61)), 4);
  assert.equal(result(h), "RESULT=INPUT_TOO_LARGE");
  // A store failure stops the remaining blocks and wins over everything.
  const broken = harness(t);
  fs.writeFileSync(broken.storeRoot, "not a directory");
  const a = request(randomUUID());
  audited(broken, a);
  const b = request(randomUUID());
  audited(broken, b);
  assert.equal(await run(broken, ["ingest"], `${request(randomUUID(), "x", { from: "win" }).text}\n${a.text}\n${b.text}`), 9);
  assert.deepEqual(broken.out.filter((l) => l.startsWith("RESULT=")).map((l) => l.split(" ")[0]), ["RESULT=PEER_UNKNOWN", "RESULT=STORE_UNAVAILABLE"]);
  assert.equal(broken.calls.length, 0);
});

// ── B1–B4 bind / refuse / reply ───────────────────────────────────────────────────────────
test("B1 bind on `received` with a dispatchable local task → `accepted`; the ACK carries receiver_task; the queue is only read", async (t) => {
  const h = harness(t, [{ id: "2026112102", status: "in_progress" }]);
  const queueBefore = fs.readFileSync(QUEUE);
  const id = randomUUID();
  await received(h, id);
  assert.equal(await run(h, ["bind", "--request", id, "--task", "2026112102"]), 0);
  assert.equal(h.out[0], `OK bind request=${id} peer=mac receiver_task=2026112102 state=accepted answer=accepted send=handed_over/consumed`);
  const r = await rec(h, inbox(id));
  assert.equal(r.state, "accepted");
  assert.equal(r.receiver_task, "2026112102");
  assert.equal(r.next_action.code, "WORK");
  const ack = sent(h).at(-1)!;
  assert.deepEqual([ack.kind, ack.ref, ack.state, ack.seq, ack.sender_task, ack.receiver_task], ["ACK", "REQUEST-1", "accepted", 2, "1291", "2026112102"]);
  assert.deepEqual(fs.readFileSync(QUEUE), queueBefore, "bind never writes the task queue");
  assert.ok(h.calls.every((c) => c.argv[0] === "inject" && c.argv[c.argv.length - 2] === PEER_TARGET), "telepty inject to the peer controller only");
  assert.equal(await run(h, ["bind", "--request", id, "--task", "2026112102"]), 3, "bind needs `received`");
});

test("B2 bind with an unknown, duplicate or done task → exit 3; nothing changed, nothing sent", async (t) => {
  const h = harness(t, [{ id: "dup", status: "pending" }, { id: "dup", status: "pending" }, { id: "fin", status: "done" }]);
  const id = randomUUID();
  await received(h, id);
  const before = bytesOf(h, inbox(id));
  const calls = h.calls.length;
  for (const [task, code] of [["nope", "TASK_UNKNOWN"], ["dup", "TASK_AMBIGUOUS"], ["fin", "TASK_NOT_DISPATCHABLE"], ["bad id", "TASK_UNKNOWN"]] as const) {
    assert.equal(await run(h, ["bind", "--request", id, "--task", task]), 3, task);
    assert.ok(h.err.some((l) => l.includes(code)), `${task} → ${code}`);
    assert.deepEqual(bytesOf(h, inbox(id)), before, `${task}: record unchanged`);
    assert.equal(h.calls.length, calls, `${task}: nothing sent`);
  }
  // bind on an `unverified` record is refused too.
  const unverified = randomUUID();
  await run(h, ["ingest"], request(unverified).text);
  assert.equal(await run(h, ["bind", "--request", unverified, "--task", "fin"]), 3);
  assert.ok(h.err.some((l) => l.includes("STATE_INVALID")));
});

test("B3 refuse: closed code list; each code travels in ACK refused; refuse after a final REPLY → 3", async (t) => {
  const h = harness(t, [{ id: "2026112102", status: "pending" }]);
  const id = randomUUID();
  await received(h, id);
  const before = bytesOf(h, inbox(id));
  assert.equal(await run(h, ["refuse", "--request", id, "--reason", "because"]), 4);
  assert.deepEqual(bytesOf(h, inbox(id)), before);
  for (const reason of REFUSE_REASONS) {
    const rid = randomUUID();
    await received(h, rid);
    assert.equal(await run(h, ["refuse", "--request", rid, "--reason", reason]), 0, reason);
    const ack = sent(h).at(-1)!;
    assert.deepEqual([ack.id, ack.state, ack.reason], [rid, "refused", reason]);
    assert.equal((await rec(h, inbox(rid))).state, "refused");
    assert.equal(await run(h, ["refuse", "--request", rid, "--reason", reason]), 3, "terminal");
  }
  await run(h, ["bind", "--request", id, "--task", "2026112102"]);
  assert.equal(await run(h, ["reply", "--request", id, "--outcome", "done", "--final", "--body-file", bodyFile(h, "done")]), 0);
  assert.equal(await run(h, ["refuse", "--request", id, "--reason", "cannot_do"]), 3);
  assert.ok(h.err.some((l) => l.includes("STATE_INVALID")));
  // The peer's ACK received for the final REPLY makes it `replied`; refuse is still 3.
  const fin = envelope(fields("ACK", id, { ref: "REPLY-1", seq: 1, state: "received", receiver_task: "2026112102" }));
  audited(h, fin);
  assert.equal(await run(h, ["ingest"], fin.text), 0);
  assert.equal((await rec(h, inbox(id))).state, "replied");
  assert.equal(await run(h, ["refuse", "--request", id, "--reason", "cannot_do"]), 3);
});

test("B4 reply seq increments; a second --final → 3; the 33rd reply → 3; exit 7/11 name `probe`, not the pump", async (t) => {
  const h = harness(t, [{ id: "2026112102", status: "pending" }]);
  const id = randomUUID();
  await accepted(h, id);
  const reply = (flag: "--final" | "--interim", body = "progress"): Promise<number> =>
    run(h, ["reply", "--request", id, "--outcome", "done", flag, "--body-file", bodyFile(h, body)]);
  assert.equal(await reply("--interim", "step 1\r\n"), 0);
  assert.equal(h.out[0], `OK reply request=${id} seq=1 outcome=done final=no state=replying send=handed_over/consumed`);
  assert.equal(await reply("--interim"), 0);
  assert.equal(await reply("--final", "all done"), 0);
  const replies = sent(h).filter((f) => f.kind === "REPLY");
  assert.deepEqual(replies.map((f) => [f.seq, f.final, f.receiver_task, f.sender_task]),
    [[1, "no", "2026112102", "1291"], [2, "no", "2026112102", "1291"], [3, "yes", "2026112102", "1291"]]);
  const r = await rec(h, inbox(id));
  assert.equal(r.state, "replying");
  assert.ok(fs.existsSync(h.store.rawPath(r.messages["REPLY-3"]!.sha256)));
  assert.equal(r.messages["REPLY-3"]!.sends![0]!.result, "handed_over");
  const calls = h.calls.length;
  assert.equal(await reply("--final"), 3, "a second final");
  assert.equal(await reply("--interim"), 3, "nothing after a final");
  assert.equal(h.calls.length, calls);

  // 32 replies at most.
  const g = harness(t, [{ id: "2026112102", status: "pending" }]);
  const gid = randomUUID();
  await accepted(g, gid);
  for (let i = 1; i <= 32; i++) {
    assert.equal(await run(g, ["reply", "--request", gid, "--outcome", "blocked", "--interim", "--body-file", bodyFile(g, `n=${i}`)]), 0, `reply ${i}`);
  }
  assert.equal(await run(g, ["reply", "--request", gid, "--outcome", "done", "--final", "--body-file", bodyFile(g, "33")]), 3);
  assert.equal(Object.keys((await rec(g, inbox(gid))).messages).length, 33, "REQUEST-1 + 32 REPLYs");

  // Send results: unknown → 7, definite refusal → 11; the record is kept and names `probe`.
  const u = harness(t, [{ id: "2026112102", status: "pending" }]);
  const uid = randomUUID();
  await accepted(u, uid);
  u.replies.push({ rc: null, stdout: "", stderr: "", truncated: false });
  assert.equal(await run(u, ["reply", "--request", uid, "--outcome", "done", "--interim", "--body-file", bodyFile(u, "a")]), 7);
  assert.ok(u.err.some((l) => l.startsWith("PEER_DELIVERY_UNKNOWN") && l.includes(`controller-link.sh probe --request ${uid}`) && !l.includes("pump")));
  assert.equal((await rec(u, inbox(uid))).next_action.code, "PROBE");
  u.replies.push({ rc: 1, stdout: "", stderr: "❌ [TRACKING_PERSISTENCE_FAILED] no task bytes were delivered\n", truncated: false });
  assert.equal(await run(u, ["reply", "--request", uid, "--outcome", "done", "--final", "--body-file", bodyFile(u, "b")]), 11);
  assert.ok(u.err.some((l) => l.startsWith("PEER_NOT_DELIVERED") && l.includes("probe --request") && !l.includes("pump")));
  const ur = await rec(u, inbox(uid));
  assert.equal(ur.messages["REPLY-2"]!.sends![0]!.result, "refused_definite");
  // Body rules (§3.3) refuse before anything is written.
  const before = bytesOf(u, inbox(uid));
  assert.equal(await run(u, ["reply", "--request", uid, "--outcome", "done", "--interim", "--body-file", bodyFile(u, "bad \u202e text")]), 4);
  assert.deepEqual(bytesOf(u, inbox(uid)), before);
});

// ── status / probe / close / configuration (SPEC §9.4, WORK-BREAKDOWN §4, §7, §2) ────────────
test("status prints the §9.4 line (text and --json); probe sends a PROBE with an incrementing seq; close needs `stalled`", async (t) => {
  const h = harness(t);
  const id = randomUUID();
  await seedOutbox(h, id, "send_unknown");
  assert.equal(await run(h, ["status"]), 0);
  assert.deepEqual(h.out, [`controller-link sender ${id.slice(0, 8)} peer=mac state=send_unknown next=WAIT_ACK due=${iso(T0)} sender_task=1291 receiver_task=-`]);
  assert.equal(await run(h, ["status", "--json", "--request", id]), 0);
  const rows = JSON.parse(h.out[0]!) as Array<{ request_id: string; state: string }>;
  assert.deepEqual(rows.map((x) => [x.request_id, x.state]), [[id, "send_unknown"]]);
  assert.equal(await run(h, ["status", "--request", randomUUID()]), 3);

  assert.equal(await run(h, ["probe", "--request", id]), 0);
  assert.equal(h.out[0], `OK probe request=${id} ref=REQUEST-1 seq=1 send=handed_over/consumed`);
  h.replies.push({ rc: null, stdout: "", stderr: "", truncated: false });
  assert.equal(await run(h, ["probe", "--request", id]), 7);
  assert.deepEqual(sent(h).map((f) => [f.kind, f.ref, f.seq, f.from, f.to]), [["PROBE", "REQUEST-1", 1, SELF, PEER], ["PROBE", "REQUEST-1", 2, SELF, PEER]]);
  const r = await rec(h, outbox(id));
  assert.deepEqual(r.probes_out["REQUEST-1"]!.sends.map((s) => s.result), ["handed_over", "unknown"]);
  assert.equal(r.state, "send_unknown", "a probe changes no state");

  assert.equal(await run(h, ["close", "--request", id]), 3);
  const stalled = randomUUID();
  await seedOutbox(h, stalled, "stalled");
  assert.equal(await run(h, ["close", "--request", stalled]), 0);
  assert.equal((await rec(h, outbox(stalled))).state, "closed");
  assert.equal(await run(h, ["probe", "--request", stalled]), 3, "terminal");
  assert.equal(await run(h, ["frobnicate"]), 4);
  assert.equal(await run(h, ["bind", "--request", "not-a-uuid", "--task", "x"]), 4);
});

test("§2 configuration: missing, unknown key, duplicate target, bad label or bad override → PEER_CONFIG_INVALID exit 9, nothing stored", async (t) => {
  const h = harness(t);
  const file = String(h.deps.env.AIGENTRY_CONTROLLER_PEERS);
  const e = request(randomUUID());
  audited(h, e);
  const bad: unknown[] = [
    { v: 1, self: { label: SELF, controller_sid: SID }, peers: {}, extra: true },
    { v: 2, self: { label: SELF, controller_sid: SID }, peers: {} },
    { v: 1, self: { label: "Linux", controller_sid: SID }, peers: {} },
    { v: 1, self: { label: SELF, controller_sid: SID }, peers: { a: { target: PEER_TARGET, link: "v1" }, b: { target: PEER_TARGET } } },
    { v: 1, self: { label: SELF, controller_sid: SID }, peers: { mac: { target: "mac-box", link: "v1" } } },
    { v: 1, self: { label: SELF, controller_sid: SID }, peers: { "../x": { target: PEER_TARGET, link: "v1" } } },
  ];
  for (const cfg of bad) {
    fs.writeFileSync(file, JSON.stringify(cfg));
    assert.equal(await run(h, ["ingest"], e.text), 9, JSON.stringify(cfg));
    assert.ok(h.err.some((l) => l.includes("PEER_CONFIG_INVALID")));
  }
  fs.rmSync(file);
  assert.equal(await run(h, ["status"]), 9);
  // Built by hand: path.join would normalise the `..` segment away.
  h.deps.env.AIGENTRY_CONTROLLER_PEERS = [h.base, "..", path.basename(h.base), "peers.json"].join(path.sep);
  assert.equal(await run(h, ["status"]), 9);
  assert.equal(fs.existsSync(h.storeRoot), false);
  assert.equal(h.calls.length + h.queries.length, 0);
});
