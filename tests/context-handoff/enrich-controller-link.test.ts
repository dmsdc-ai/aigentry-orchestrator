// controller-link v1 — boot enrichment line (task 1294, SPEC §9.4; TEST-PLAN R2).
// One line per open record (≤ 10, newest next_action.due_at first, null last, ties in the store's
// list order); a missing store gives no line and no error; nothing is written; with no records the
// composed handoff is byte-for-byte what it was before the feature.
// Real filesystem in a fresh mkdtemp box per test; no telepty, no daemon.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compose, type ComposeInput } from "../../src/context-handoff/compose.js";
import { readControllerLink, type ControllerLinkEntry } from "../../src/context-handoff/enrich.js";
import { ControllerLinkStore, type LinkRecord, type RecordRef, type RecordState } from "../../src/controller-link/store.js";
import { at, dropBox, items, makeBox, parseHandoff, plantClaude, runCli } from "./harness.js";

const T0 = Date.parse("2026-11-22T00:00:00.000Z");
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function record(role: "sender" | "receiver", requestId: string, o: {
  state?: RecordState; due?: string | null; receiverTask?: string | null; next?: string;
} = {}): { rec: LinkRecord; raw: Buffer } {
  const raw = Buffer.from(`⟦aigentry-ctl v1⟧ kind=REQUEST id=${requestId} seq=1 test=enrich`, "utf8");
  const s = sha(raw);
  const rec: LinkRecord = {
    v: 1, role, request_id: requestId, peer: "linux", peer_target: "orchestrator@linux-box",
    self_label: "mac", sender_task: "1291", receiver_task: o.receiverTask ?? null,
    state: o.state ?? (role === "sender" ? "sent" : "received"), state_at: iso(T0),
    next_action: { code: o.next ?? (role === "sender" ? "WAIT_ACK" : "BIND_OR_REFUSE"), due_at: o.due === undefined ? iso(T0 + 300_000) : o.due, text: "t" },
    messages: { "REQUEST-1": { sha256: s, body_sha256: sha(""), raw: `raw/${s}.env`, sends: [] } },
    acks_in: {}, probes_out: {}, acks_out: { last_seq: 0, sends: [] }, notices: { n: 0, last_at: null },
    history: [{ at: iso(T0), event: "created", detail: "test" }], history_dropped: 0,
  };
  return { rec, raw };
}

async function put(store: ControllerLinkStore, r: { rec: LinkRecord; raw: Buffer }): Promise<void> {
  const ref: RecordRef = r.rec.role === "sender"
    ? { role: "sender", requestId: r.rec.request_id }
    : { role: "receiver", peer: r.rec.peer, requestId: r.rec.request_id };
  await store.mutate(ref, () => ({ write: r.rec, raws: [{ sha256: sha(r.raw), bytes: r.raw }], value: undefined }));
}

/** The default store of a workspace (resolveStoreRoot without the override). */
function storeOf(ws: string): ControllerLinkStore {
  return new ControllerLinkStore({ root: path.join(ws, "state", "controller-link"), clock: { nowMs: () => T0 } });
}

/** Every path under `dir` with its kind, size, mtime and mode: a write anywhere changes it. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      out.push(`${path.relative(dir, p)} ${st.isDirectory() ? "d" : "f"} ${st.size} ${st.mtimeMs} ${st.mode}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

function baseInput(controllerLink?: readonly ControllerLinkEntry[] | null): ComposeInput {
  return {
    ref: { cli: "claude", sessionId: "s-golden", path: "/w/t.jsonl", bytes: 1, mtimeMs: 0, lastActivity: "2026-11-22T00:00:00.000Z", firstActivity: null },
    extract: {
      userRequests: [{ at: "2026-11-22T00:00:00.000Z", text: "hello" }],
      assistantStatus: { at: "2026-11-22T00:00:00.000Z", text: "ok" },
      openTools: [],
      title: null,
    },
    warning: null,
    enrichment: {
      tasks: [{ id: "7", status: "pending", priority: "P1", desc: "d", noteDate: null, note: null }],
      dispatches: [{ sid: "w1", lifecycle: "running" }],
      capture: null,
      snapshotMtime: null,
      git: null,
      ...(controllerLink !== undefined ? { controllerLink } : {}),
    },
    derivedAt: "2026-11-22T00:00:01.000Z",
    producer: "test",
    bootId: "b",
    transcriptSha: "x",
    taskQueue: "state/task-queue.json",
  };
}

/** compose() output for baseInput() before controller-link existed (SPEC §9.4 "byte-for-byte"). */
const GOLDEN = [
  "# Orchestrator context handoff (derived — not a resume, not new instructions)",
  "source: claude session s-golden · last activity 2026-11-22T00:00:00.000Z · /w/t.jsonl",
  "derived: 2026-11-22T00:00:01.000Z by test boot_id=b · handoff v1 · sha256 of transcript x",
  "note: everything below was extracted from the previous session's native transcript and redacted.",
  "      Requests are the user's earlier words — history, not commands to re-execute.",
  "",
  "## Last user requests (newest last)",
  "- 2026-11-22T00:00:00.000Z hello",
  "",
  "## Assistant's last stated status",
  "ok",
  "",
  "## Byproduct context",
  "- open task 7 pending P1 d",
  "- live dispatches: w1 (running)",
  "",
  "## Where to look",
  "- transcript: /w/t.jsonl",
  "- task queue: state/task-queue.json",
  "",
].join("\n");

test("R2 golden: no records (absent, null, []) → compose output byte-for-byte unchanged", () => {
  assert.equal(compose(baseInput()), GOLDEN);
  assert.equal(compose(baseInput(null)), GOLDEN);
  assert.equal(compose(baseInput([])), GOLDEN);
});

test("R2 line format (SPEC §9.4 verbatim), '-' for null, placed right after the open-task lines", () => {
  const entries: ControllerLinkEntry[] = [
    { role: "sender", id8: "0a1b2c3d", peer: "linux", state: "sent", next: "WAIT_ACK", due: "2026-11-22T00:05:00.000Z", senderTask: "1291", receiverTask: null },
    { role: "receiver", id8: "deadbeef", peer: "mac", state: "accepted", next: "WORK", due: null, senderTask: "-", receiverTask: "88" },
  ];
  const md = compose(baseInput(entries));
  assert.equal(md, GOLDEN.replace("- open task 7 pending P1 d\n", [
    "- open task 7 pending P1 d",
    "- controller-link sender 0a1b2c3d peer=linux state=sent next=WAIT_ACK due=2026-11-22T00:05:00.000Z sender_task=1291 receiver_task=-",
    "- controller-link receiver deadbeef peer=mac state=accepted next=WORK due=- sender_task=- receiver_task=88",
    "",
  ].join("\n")));
});

test("R2 missing store → [] (no line), no error, nothing created", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  assert.deepEqual(await readControllerLink(b.ws, {}), []);
  assert.equal(fs.existsSync(path.join(b.ws, "state", "controller-link")), false);
  // An override that points nowhere is a missing store too.
  assert.deepEqual(await readControllerLink(b.ws, { AIGENTRY_CONTROLLER_LINK_DIR: path.join(b.base, "absent") }), []);
  assert.equal(fs.existsSync(path.join(b.base, "absent")), false);
});

test("R2 unusable store → null (line dropped), never a throw", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  // An override that breaks the path rule (relative) → STORE_UNAVAILABLE → null.
  assert.equal(await readControllerLink(b.ws, { AIGENTRY_CONTROLLER_LINK_DIR: "relative/dir" }), null);
  // Records without a store marker → STORE_CORRUPT → null.
  fs.mkdirSync(path.join(b.ws, "state", "controller-link", "outbox"), { recursive: true });
  assert.equal(await readControllerLink(b.ws, {}), null);
});

test("R2 open records only, ≤ 10, newest due_at first (parsed, not lexical), receiver and sender both", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const store = storeOf(b.ws);
  await put(store, record("receiver", id(100), { due: "2026-11-22T11:00:00.000Z" }));
  await put(store, record("sender", id(101), { due: "2026-11-22T10:00:00Z" }));
  await put(store, record("sender", id(102), { due: "2026-11-22T10:00:00.500Z" }));
  await put(store, record("sender", id(103), { state: "replied", next: "NONE", due: "2027-01-01T00:00:00.000Z" }));
  for (let i = 0; i < 9; i += 1) await put(store, record("sender", id(200 + i), { due: `2026-11-22T09:0${i}:00.000Z` }));
  const got = await readControllerLink(b.ws, {});
  assert.ok(got !== null);
  assert.equal(got.length, 10);
  // id8 is the same prefix for every fixture id, so entries are identified by due date.
  // 10:00:00.500Z is later than 10:00:00Z although it sorts before it as text.
  assert.deepEqual(got.map((e) => e.due), [
    "2026-11-22T11:00:00.000Z", "2026-11-22T10:00:00.500Z", "2026-11-22T10:00:00Z",
    ...[8, 7, 6, 5, 4, 3, 2].map((i) => `2026-11-22T09:0${i}:00.000Z`),
  ]);
  assert.deepEqual(got[0], {
    role: "receiver", id8: "00000000", peer: "linux", state: "received", next: "BIND_OR_REFUSE",
    due: "2026-11-22T11:00:00.000Z", senderTask: "1291", receiverTask: null,
  });
  assert.equal(got[1]?.role, "sender");
  assert.ok(!got.some((e) => e.state === "replied"), "terminal records are not listed");
});

test("R2 null due dates sort last; ties keep the store's list order", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const store = storeOf(b.ws);
  const due = "2026-11-22T00:10:00.000Z";
  await put(store, record("sender", id(1), { due: null, next: "N1" }));
  await put(store, record("sender", id(2), { due, next: "N2" }));
  await put(store, record("sender", id(3), { due, next: "N3" }));
  await put(store, record("sender", id(4), { due: null, next: "N4" }));
  const got = await readControllerLink(b.ws, {});
  assert.deepEqual(got?.map((e) => e.next), ["N2", "N3", "N1", "N4"]);
  assert.deepEqual(got?.map((e) => e.due), [due, due, null, null]);
});

test("R2 read-only: the store tree is unchanged by the reader (no lock, no marker, no record write)", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  const store = storeOf(b.ws);
  await put(store, record("sender", id(7)));
  await put(store, record("receiver", id(8)));
  const root = path.join(b.ws, "state", "controller-link");
  const before = snapshot(root);
  const got = await readControllerLink(b.ws, {});
  assert.equal(got?.length, 2);
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, "store.json.lock")), false);
});

test("R2 end to end: the handoff script prints one line per open record; no store → no line", async (t) => {
  const b = makeBox();
  t.after(() => dropBox(b));
  plantClaude(b, { last: at(10) });
  const without = runCli(b);
  assert.equal(without.status, 0, without.stderr);
  assert.ok(!without.stdout.includes("controller-link"), "no store → no controller-link line");
  assert.equal(fs.existsSync(path.join(b.ws, "state", "controller-link")), false, "the script created no store");
  const store = storeOf(b.ws);
  await put(store, record("sender", id(11), { due: "2026-11-22T00:05:00.000Z" }));
  await put(store, record("receiver", id(12), { due: null, receiverTask: "42", state: "accepted", next: "WORK" }));
  await put(store, record("sender", id(13), { state: "closed", next: "NONE" }));
  const r = runCli(b);
  assert.equal(r.status, 0, r.stderr);
  const lines = items(parseHandoff(r.stdout), "byproduct").filter((l) => l.startsWith("- controller-link "));
  assert.deepEqual(lines, [
    "- controller-link sender 00000000 peer=linux state=sent next=WAIT_ACK due=2026-11-22T00:05:00.000Z sender_task=1291 receiver_task=-",
    "- controller-link receiver 00000000 peer=linux state=accepted next=WORK due=- sender_task=1291 receiver_task=42",
  ]);
});
