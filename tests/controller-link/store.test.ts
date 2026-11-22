// controller-link v1 — record store (SPEC §4; TEST-PLAN §2.2 S1–S7).
// Real filesystem in a fresh mkdtemp root per test; injected clock; no telepty, no daemon.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { withIndexLock } from "../../src/session/persistence/index-lock.js";
import {
  ControllerLinkStore,
  HISTORY_MAX,
  OPEN_RECORDS_MAX,
  RECORDLESS_ANSWERS_MAX,
  RETENTION_MS,
  SENDS_MAX,
  StoreError,
  type LinkRecord,
  type RecordRef,
  type RecordState,
  resolveStoreRoot,
} from "../../src/controller-link/store.js";

const T0 = Date.parse("2026-11-22T00:00:00.000Z");
const POSIX = process.platform !== "win32";
const R5_SKIP = POSIX ? false : "POSIX modes are not checked on win32 (THREAT-MODEL R5)";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const iso = (ms: number): string => new Date(ms).toISOString();

interface Box {
  base: string;
  root: string;
  clock: { now: number; nowMs(): number };
  store: ControllerLinkStore;
}

async function box(t: TestContext): Promise<Box> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "controller-link-store-test-"));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = path.join(base, "controller-link");
  const clock = { now: T0, nowMs(): number { return this.now; } };
  return { base, root, clock, store: new ControllerLinkStore({ root, clock, lockTimeoutMs: 5_000 }) };
}

function envelope(id: string, tag = "a"): Buffer {
  return Buffer.from(`⟦aigentry-ctl v1⟧ kind=REQUEST id=${id} seq=1 test=${tag}`, "utf8");
}

function record(role: "sender" | "receiver", id: string, opts: {
  peer?: string; state?: RecordState; stateAt?: number; raw?: Buffer; extra?: Record<string, unknown>;
} = {}): LinkRecord {
  const raw = opts.raw ?? envelope(id);
  const s = sha(raw);
  return {
    v: 1, role, request_id: id, peer: opts.peer ?? "linux", peer_target: "orchestrator@linux-box",
    self_label: "mac", sender_task: "1291", receiver_task: null,
    state: opts.state ?? (role === "sender" ? "sent" : "received"), state_at: iso(opts.stateAt ?? T0),
    next_action: { code: "WAIT_ACK", due_at: iso(T0 + 300_000), text: "wait" },
    messages: { "REQUEST-1": { sha256: s, body_sha256: sha(""), raw: `raw/${s}.env`, sends: [] } },
    acks_in: {}, probes_out: {}, acks_out: { last_seq: 0, sends: [] }, notices: { n: 0, last_at: null },
    history: [{ at: iso(T0), event: "created", detail: "test" }], history_dropped: 0,
    ...(opts.extra ?? {}),
  };
}

const sender = (requestId: string): RecordRef => ({ role: "sender", requestId });
const receiver = (peer: string, requestId: string): RecordRef => ({ role: "receiver", peer, requestId });

async function create(store: ControllerLinkStore, ref: RecordRef, rec: LinkRecord, raw = envelope(rec.request_id)): Promise<void> {
  await store.mutate(ref, () => ({ write: rec, raws: [{ sha256: sha(raw), bytes: raw }], value: undefined }));
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof StoreError && e.code === code);
}

async function exists(p: string): Promise<boolean> {
  try { await fs.lstat(p); return true; } catch { return false; }
}

/** Plant a record file directly (fixture), bypassing the store, with private modes. */
async function plant(root: string, rel: string, value: unknown): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
}

// --- S1 -----------------------------------------------------------------------------------------

test("S1 two concurrent writers on one record: both changes are present", async (t) => {
  const { store } = await box(t);
  const id = randomUUID();
  await create(store, sender(id), record("sender", id));
  const add = (event: string) => store.mutate(sender(id), (cur) => {
    assert.ok(cur);
    const next = structuredClone(cur);
    next.history.push({ at: iso(T0), event, detail: null });
    // Writers "a" and "a2" each increment notices.n (so a lost "a"/"a2" update shows as n < 2); "b" sets acks_in.
    if (event.startsWith("a")) next.notices.n += 1; else next.acks_in["REQUEST-1"] = { last_seq: 1, state: "received" };
    return { write: next, value: event };
  });
  assert.deepEqual(await Promise.all([add("a"), add("b"), add("a2")]), ["a", "b", "a2"]);
  const final = await store.read(sender(id));
  assert.ok(final);
  assert.deepEqual(final.history.map((h) => h.event).slice(1).sort(), ["a", "a2", "b"]);
  assert.equal(final.notices.n, 2);
  assert.deepEqual(final.acks_in["REQUEST-1"], { last_seq: 1, state: "received" });
});

/** One read-modify-write that adds a distinct change: history event, notices.n += 1, acks_in[REPLY-i]. */
function bump(store: ControllerLinkStore, id: string, i: number): Promise<number> {
  return store.mutate(sender(id), async (cur) => {
    assert.ok(cur);
    const next = structuredClone(cur);
    // Yield inside the critical section so an unserialised read-modify-write would interleave.
    await new Promise((r) => setTimeout(r, 2));
    next.history.push({ at: iso(T0), event: `w${i}`, detail: null });
    next.notices.n += 1;
    next.acks_in[`REPLY-${i}`] = { last_seq: i, state: "received" };
    return { write: next, value: i };
  });
}

async function assertAllEight(store: ControllerLinkStore, id: string): Promise<void> {
  const final = await store.read(sender(id));
  assert.ok(final);
  const expected = Array.from({ length: 8 }, (_, i) => i + 1);
  assert.equal(final.notices.n, 8);
  assert.deepEqual(final.history.map((h) => h.event).slice(1).sort(), expected.map((i) => `w${i}`).sort());
  for (const i of expected) assert.deepEqual(final.acks_in[`REPLY-${i}`], { last_seq: i, state: "received" });
}

test("S1 eight concurrent mutations on one record: all eight changes are present", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  await create(store, sender(id), record("sender", id));
  const ids = Array.from({ length: 8 }, (_, i) => i + 1);
  assert.deepEqual(await Promise.all(ids.map((i) => bump(store, id, i))), ids);
  await assertAllEight(store, id);
  assert.equal(await exists(path.join(root, "store.json.lock")), false);
});

test("S1 eight concurrent mutations from two store instances on the same root: all present", async (t) => {
  const { store, root, clock } = await box(t);
  const second = new ControllerLinkStore({ root, clock, lockTimeoutMs: 5_000 });
  const id = randomUUID();
  await create(store, sender(id), record("sender", id));
  const ids = Array.from({ length: 8 }, (_, i) => i + 1);
  assert.deepEqual(await Promise.all(ids.map((i) => bump(i % 2 === 0 ? store : second, id, i))), ids);
  await assertAllEight(store, id);
  await assertAllEight(second, id);
});

test("S1 a mutation waits for the store lock held by another holder", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  await create(store, sender(id), record("sender", id));
  const order: string[] = [];
  let release!: () => void;
  const held = withIndexLock(path.join(root, "store.json"), async () => {
    order.push("held");
    await new Promise<void>((r) => { release = r; });
    order.push("released");
  });
  while (order.length === 0) await new Promise((r) => setTimeout(r, 5));
  const writer = store.mutate(sender(id), (cur) => {
    order.push("mutate");
    return { write: cur, value: undefined };
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(order, ["held"]);
  release();
  await held;
  await writer;
  assert.deepEqual(order, ["held", "released", "mutate"]);
  assert.equal(await exists(path.join(root, "store.json.lock")), false);
});

test("S1 keyed idempotent write: new, duplicate, conflict, absent", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  const raw1 = envelope(id, "one");
  const entry = (raw: Buffer) => ({ sha256: sha(raw), body_sha256: sha("body"), raw: `raw/${sha(raw)}.env`, ingested_at: iso(T0) });
  const ref = receiver("linux", id);
  assert.equal((await store.putMessage(ref, { key: "REQUEST-1", entry: entry(raw1), raw: raw1 })).result, "absent");
  const first = await store.putMessage(ref, {
    key: "REQUEST-1", entry: entry(raw1), raw: raw1,
    create: () => record("receiver", id, { raw: raw1 }),
  });
  assert.equal(first.result, "new");
  const again = await store.putMessage(ref, { key: "REQUEST-1", entry: entry(raw1), raw: raw1, create: () => assert.fail("no create") });
  assert.equal(again.result, "duplicate");
  const raw2 = envelope(id, "two");
  const other = await store.putMessage(ref, { key: "REQUEST-1", entry: entry(raw2), raw: raw2 });
  assert.equal(other.result, "conflict");
  assert.equal(await exists(path.join(root, "raw", `${sha(raw2)}.env`)), false);
  const reply = Buffer.from("reply-1");
  const r1 = await store.putMessage(ref, {
    key: "REPLY-1", entry: { ...entry(reply), sends: [] }, raw: reply,
    apply: (rec) => { rec.state = "replying"; },
  });
  assert.equal(r1.result, "new");
  const stored = await store.read(ref);
  assert.equal(stored?.state, "replying");
  assert.equal(stored?.messages["REQUEST-1"]?.sha256, sha(raw1));
  assert.equal(stored?.messages["REPLY-1"]?.body_sha256, sha("body"));
});

// --- S2 -----------------------------------------------------------------------------------------

test("S2 raw is write-once: an existing raw with other bytes is STORE_CORRUPT and nothing changes", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  const raw = envelope(id);
  await create(store, sender(id), record("sender", id, { raw }), raw);
  const rawFile = path.join(root, "raw", `${sha(raw)}.env`);
  assert.deepEqual(await fs.readFile(rawFile), raw);
  await fs.writeFile(rawFile, "tampered", { mode: 0o600 });
  const before = await fs.readFile(path.join(root, "outbox", `${id}.json`));
  let sent = false;
  await rejectsWith(store.mutate(sender(id), (cur) => {
    const next = structuredClone(cur!);
    next.state = "send_unknown";
    return { write: next, raws: [{ sha256: sha(raw), bytes: raw }], value: undefined };
  }).then(() => { sent = true; }), "STORE_CORRUPT");
  assert.equal(sent, false);
  assert.deepEqual(await fs.readFile(path.join(root, "outbox", `${id}.json`)), before);
  await rejectsWith(store.readRaw(sha(raw)), "STORE_CORRUPT");
});

test("S2 a raw whose name is not the sha256 of its bytes is refused before any record write", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  const raw = envelope(id);
  const rec = record("sender", id, { raw });
  await rejectsWith(store.mutate(sender(id), () => ({
    write: rec, raws: [{ sha256: sha(raw), bytes: Buffer.from("other bytes") }], value: undefined,
  })), "STORE_CORRUPT");
  await rejectsWith(store.mutate(sender(id), () => ({ write: rec, value: undefined })), "STORE_CORRUPT"); // names a missing raw
  assert.equal(await exists(path.join(root, "outbox", `${id}.json`)), false);
});

// --- S3 -----------------------------------------------------------------------------------------

test("S3 bad labels, ids and hashes are refused before any filesystem call", async (t) => {
  const { store, root, base } = await box(t);
  const good = randomUUID();
  const badIds = ["..", "../x", `${good}/..`, "a/b", "a\\b", "a\0b", good.toUpperCase(), "", `${good}.json`];
  const badLabels = ["..", "../linux", "li/nux", "li\\nux", "li\0nux", "Linux", "", "-linux", "a".repeat(33)];
  const badHex = ["..", "../" + "a".repeat(61), "A".repeat(64), "a".repeat(63), "a".repeat(63) + "\0"];
  // Each call is settled at once (no unhandled rejection while earlier ones are awaited).
  const calls: Promise<unknown>[] = [];
  const push = (...ps: Promise<unknown>[]): void => { for (const p of ps) calls.push(p.then(() => "resolved", (e: unknown) => e)); };
  for (const id of badIds) {
    push(store.read(sender(id)), store.read(receiver("linux", id)));
    push(store.mutate(sender(id), () => assert.fail("callback must not run")));
    push(store.putMessage(sender(id), { key: "REQUEST-1", entry: { sha256: sha("x"), body_sha256: sha(""), raw: `raw/${sha("x")}.env` }, raw: Buffer.from("x") }));
  }
  for (const label of badLabels) {
    push(store.read(receiver(label, good)));
    push(store.mutate(receiver(label, good), () => assert.fail("callback must not run")));
    push(store.list({ peer: label }));
  }
  for (const h of badHex) push(store.readRaw(h));
  for (const outcome of await Promise.all(calls)) {
    assert.ok(outcome instanceof StoreError && outcome.code === "STORE_UNAVAILABLE", String(outcome));
  }
  for (const h of badHex) assert.throws(() => store.rawPath(h), StoreError);
  for (const id of badIds) assert.throws(() => store.recordPath(sender(id)), StoreError);
  assert.equal(await exists(root), false, "no filesystem change");
  assert.deepEqual(await fs.readdir(base), []);
});

test("S3 a record whose identity differs from its path is refused; root override rule", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  const other = randomUUID();
  await rejectsWith(store.mutate(sender(id), () => ({ write: record("sender", other), raws: [], value: undefined })), "STORE_CORRUPT");
  await rejectsWith(store.mutate(receiver("win", id), () => ({ write: record("receiver", id, { peer: "linux" }), value: undefined })), "STORE_CORRUPT");
  assert.equal(await exists(path.join(root, "outbox", `${id}.json`)), false);
  const pkg = path.resolve("/pkg");
  assert.equal(resolveStoreRoot({}, pkg), path.join(pkg, "state", "controller-link"));
  assert.throws(() => resolveStoreRoot({ AIGENTRY_CONTROLLER_LINK_DIR: "relative/dir" }, pkg), StoreError);
  assert.throws(() => resolveStoreRoot({ AIGENTRY_CONTROLLER_LINK_DIR: path.join(pkg, "..", "x") + path.sep + ".." }, pkg), StoreError);
  assert.throws(() => resolveStoreRoot({ AIGENTRY_CONTROLLER_LINK_DIR: `${pkg}/a/../b` }, pkg), StoreError);
  assert.throws(() => resolveStoreRoot({ AIGENTRY_CONTROLLER_LINK_DIR: `${pkg}\0x` }, pkg), StoreError);
});

// --- S4 -----------------------------------------------------------------------------------------

test("S4 the 257th open outbox record is LINK_CAPACITY; terminal ones do not count", async (t) => {
  const { store, root } = await box(t);
  const firstId = randomUUID();
  await create(store, sender(firstId), record("sender", firstId));
  for (let i = 1; i < OPEN_RECORDS_MAX; i += 1) {
    const id = randomUUID();
    const raw = envelope(id);
    await fs.writeFile(path.join(root, "raw", `${sha(raw)}.env`), raw, { mode: 0o600 });
    await plant(root, `outbox/${id}.json`, record("sender", id, { raw }));
  }
  const extra = randomUUID();
  await rejectsWith(create(store, sender(extra), record("sender", extra)), "LINK_CAPACITY");
  assert.equal(await exists(path.join(root, "outbox", `${extra}.json`)), false);
  // A terminal new record is not an open one; and closing one frees a slot.
  const closedId = randomUUID();
  await create(store, sender(closedId), record("sender", closedId, { state: "closed" }));
  await store.mutate(sender(firstId), (cur) => ({ write: { ...cur!, state: "closed" as const }, value: undefined }));
  await create(store, sender(extra), record("sender", extra));
  assert.equal((await store.list({ role: "sender", open: true })).length, OPEN_RECORDS_MAX);
});

test("S4 inbox capacity is per peer", async (t) => {
  const { store, root } = await box(t);
  const seed = randomUUID();
  await create(store, receiver("linux", seed), record("receiver", seed));
  for (let i = 1; i < OPEN_RECORDS_MAX; i += 1) {
    const id = randomUUID();
    const raw = envelope(id);
    await fs.writeFile(path.join(root, "raw", `${sha(raw)}.env`), raw, { mode: 0o600 });
    await plant(root, `inbox/linux/${id}.json`, record("receiver", id, { raw }));
  }
  const id = randomUUID();
  await rejectsWith(create(store, receiver("linux", id), record("receiver", id)), "LINK_CAPACITY");
  await create(store, receiver("win", id), record("receiver", id, { peer: "win" }));
});

test("S4 history keeps the newest 64 plus history_dropped; sends keep 32; size and copy caps", async (t) => {
  const { store } = await box(t);
  const id = randomUUID();
  const rec = record("sender", id);
  rec.history = Array.from({ length: 70 }, (_, i) => ({ at: iso(T0 + i), event: `e${i}`, detail: null }));
  rec.history_dropped = 3;
  rec.messages["REQUEST-1"]!.sends = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, at: iso(T0), owner: "1@h", result: "unknown" as const }));
  rec.acks_out.sends = Array.from({ length: 33 }, (_, i) => ({ n: i + 1, at: iso(T0), owner: "1@h", result: "handed_over" as const }));
  await create(store, sender(id), rec);
  const got = (await store.read(sender(id)))!;
  assert.equal(got.history.length, HISTORY_MAX);
  assert.equal(got.history[0]!.event, "e6");
  assert.equal(got.history.at(-1)!.event, "e69");
  assert.equal(got.history_dropped, 3 + 6);
  assert.equal(got.messages["REQUEST-1"]!.sends!.length, SENDS_MAX);
  assert.equal(got.messages["REQUEST-1"]!.sends![0]!.n, 9);
  assert.equal(got.acks_out.sends.length, SENDS_MAX);

  const big = structuredClone(got);
  big.filler = "x".repeat(262_144);
  await rejectsWith(store.mutate(sender(id), () => ({ write: big, value: undefined })), "LINK_CAPACITY");
  const copies = structuredClone(got);
  copies.unverified_copies = Array.from({ length: 5 }, (_, i) => ({ sha256: sha(`c${i}`), raw: `raw/${sha(`c${i}`)}.env`, at: iso(T0) }));
  await rejectsWith(store.mutate(sender(id), () => ({
    write: copies, raws: Array.from({ length: 5 }, (_, i) => ({ sha256: sha(`c${i}`), bytes: Buffer.from(`c${i}`) })), value: undefined,
  })), "LINK_CAPACITY");
  assert.deepEqual(await store.read(sender(id)), got);
});

// --- S5 -----------------------------------------------------------------------------------------

test("S5 retention selects terminal records 30 days old and unnamed raws only; deletes nothing", async (t) => {
  const { store, root, clock } = await box(t);
  const mk = async (state: RecordState, stateAt: number, peer?: string) => {
    const id = randomUUID();
    const raw = envelope(id);
    const ref = peer === undefined ? sender(id) : receiver(peer, id);
    await create(store, ref, record(peer === undefined ? "sender" : "receiver", id, { state, stateAt, raw, ...(peer ? { peer } : {}) }), raw);
    return { ref, sha: sha(raw) };
  };
  const old = await mk("closed", T0);
  const oldInbox = await mk("replied", T0, "linux");
  const young = await mk("refused", T0 + 1000);
  const openOld = await mk("stalled", T0 - 100 * 86_400_000);
  const openInbox = await mk("unverified", T0 - 100 * 86_400_000, "linux");
  const orphan = Buffer.from("orphan raw");
  await fs.writeFile(path.join(root, "raw", `${sha(orphan)}.env`), orphan, { mode: 0o600 });
  await fs.writeFile(path.join(root, "raw", "not-a-raw.tmp"), "x", { mode: 0o600 });

  clock.now = T0 + RETENTION_MS;
  const sel = await store.selectRetention();
  assert.deepEqual(new Set(sel.records.map((r) => r.requestId)), new Set([old.ref.requestId, oldInbox.ref.requestId]));
  assert.deepEqual(new Set(sel.raws), new Set([old.sha, oldInbox.sha, sha(orphan)]));
  for (const keep of [young, openOld, openInbox]) {
    assert.ok(!sel.records.some((r) => r.requestId === keep.ref.requestId));
    assert.ok(!sel.raws.includes(keep.sha));
  }
  assert.equal((await store.list()).length, 5, "selection deletes nothing");

  clock.now = T0 + RETENTION_MS - 1;
  assert.equal((await store.selectRetention()).records.length, 0);
});

test("S5 a missing store selects and lists nothing and creates nothing", async (t) => {
  const { store, root } = await box(t);
  assert.deepEqual(await store.selectRetention(), { records: [], raws: [] });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.read(sender(randomUUID())), null);
  assert.equal(await exists(root), false);
});

// --- S6 -----------------------------------------------------------------------------------------

test("S6 an unknown v in a record or the marker is STORE_CORRUPT; unknown extra keys are kept", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  await create(store, sender(id), record("sender", id, { extra: { future_note: { a: 1 } } }));
  assert.deepEqual((await store.read(sender(id)))?.future_note, { a: 1 });

  const bad = randomUUID();
  await plant(root, `outbox/${bad}.json`, { ...record("sender", bad), v: 2 });
  await rejectsWith(store.read(sender(bad)), "STORE_CORRUPT");
  await rejectsWith(store.list(), "STORE_CORRUPT");
  const before = await fs.readFile(path.join(root, "outbox", `${bad}.json`));
  await rejectsWith(store.mutate(sender(bad), (cur) => ({ write: cur, value: undefined })), "STORE_CORRUPT");
  assert.deepEqual(await fs.readFile(path.join(root, "outbox", `${bad}.json`)), before);
  await plant(root, `outbox/${bad}.json`, "{not json");
  await rejectsWith(store.read(sender(bad)), "STORE_CORRUPT");
  await fs.unlink(path.join(root, "outbox", `${bad}.json`));

  await plant(root, "store.json", { v: 2, kind: "controller-link" });
  await rejectsWith(store.read(sender(id)), "STORE_CORRUPT");
  await rejectsWith(store.mutate(sender(id), (cur) => ({ write: cur, value: undefined })), "STORE_CORRUPT");
  await fs.unlink(path.join(root, "store.json"));
  await rejectsWith(store.list(), "STORE_CORRUPT"); // records without a marker
});

test("S6 an unknown state name is STORE_CORRUPT on read and refused on write", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  await create(store, sender(id), record("sender", id));
  const rec = (await store.read(sender(id)))!;
  await rejectsWith(store.mutate(sender(id), () => ({ write: { ...rec, state: "unverified" }, value: undefined })), "STORE_CORRUPT");
  await plant(root, `outbox/${id}.json`, { ...rec, state: "wandering" });
  await rejectsWith(store.read(sender(id)), "STORE_CORRUPT");
});

// --- S7 -----------------------------------------------------------------------------------------

test("S7 created directories are 0700 and files 0600", { skip: R5_SKIP }, async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  const raw = envelope(id);
  await create(store, receiver("linux", id), record("receiver", id, { raw }), raw);
  for (const d of ["", "inbox", "inbox/linux", "raw"]) {
    assert.equal((await fs.stat(path.join(root, d))).mode & 0o777, 0o700, d || "root");
  }
  for (const f of ["store.json", `inbox/linux/${id}.json`, `raw/${sha(raw)}.env`]) {
    assert.equal((await fs.stat(path.join(root, f))).mode & 0o777, 0o600, f);
  }
});

test("S7 a 0755 store directory or a 0644 record is refused", { skip: R5_SKIP }, async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  await create(store, sender(id), record("sender", id));
  await fs.chmod(path.join(root, "outbox", `${id}.json`), 0o644);
  await rejectsWith(store.read(sender(id)), "STORE_UNAVAILABLE");
  await rejectsWith(store.mutate(sender(id), () => assert.fail("callback must not run")), "STORE_UNAVAILABLE");
  await fs.chmod(path.join(root, "outbox", `${id}.json`), 0o600);
  assert.ok(await store.read(sender(id)));
  await fs.chmod(root, 0o755);
  await rejectsWith(store.read(sender(id)), "STORE_UNAVAILABLE");
  await rejectsWith(store.list(), "STORE_UNAVAILABLE");
  await rejectsWith(store.mutate(sender(id), () => assert.fail("callback must not run")), "STORE_UNAVAILABLE");
  await fs.chmod(root, 0o700);
  await fs.chmod(path.join(root, "outbox"), 0o755);
  await rejectsWith(store.list({ role: "sender" }), "STORE_UNAVAILABLE");
  await fs.chmod(path.join(root, "outbox"), 0o700);
  assert.ok(await store.read(sender(id)));
});

// --- review round 1 (CL-03, CL-07, CL-11, CL-15) ------------------------------------------------

test("CL-15 Windows device names are refused as a peer label on every platform; similar names are accepted", async (t) => {
  const { store, root } = await box(t);
  const id = randomUUID();
  for (const label of ["con", "prn", "aux", "nul", "com0", "com1", "com9", "lpt0", "lpt1", "lpt9"]) {
    assert.throws(() => store.recordPath(receiver(label, id)), (e: unknown) => e instanceof StoreError && e.code === "STORE_UNAVAILABLE", label);
    await rejectsWith(store.read(receiver(label, id)), "STORE_UNAVAILABLE");
    await rejectsWith(store.mutate(receiver(label, id), () => assert.fail("callback must not run")), "STORE_UNAVAILABLE");
    await rejectsWith(store.list({ peer: label }), "STORE_UNAVAILABLE");
    await rejectsWith(store.claimRecordlessAnswer(label, id, "REQUEST-1", 60_000), "STORE_UNAVAILABLE");
  }
  assert.equal(await exists(root), false, "no filesystem change");
  for (const label of ["console", "com10", "lpt-1", "nul-box", "auxiliary", "con1", "prnt"]) {
    assert.equal(store.recordPath(receiver(label, id)), path.join(root, "inbox", label, `${id}.json`), label);
  }
  // POSIX only (a directory named `con` cannot be made on native Windows): one planted by an older
  // version is not a record directory, so listing skips it instead of failing.
  if (POSIX) {
    const seed = randomUUID();
    await create(store, receiver("linux", seed), record("receiver", seed));
    await plant(root, `inbox/con/${id}.json`, record("receiver", id, { peer: "con" }));
    assert.deepEqual((await store.list()).map((r) => r.request_id), [seed]);
  }
});

test("CL-07 retention runs 30 days from the later of state_at and every message's ingested_at", async (t) => {
  const { store, clock } = await box(t);
  const DAY = 86_400_000;
  const id = randomUUID();
  const raw = envelope(id);
  // Terminal at T0 by this clock, its REQUEST-1 stored at T0 + 10 days (the clock went back in between).
  const rec = record("receiver", id, { state: "refused", stateAt: T0, raw });
  rec.messages["REQUEST-1"]!.ingested_at = iso(T0 + 10 * DAY);
  await create(store, receiver("linux", id), rec, raw);
  clock.now = T0 + RETENTION_MS;
  assert.deepEqual((await store.selectRetention()).records, [], "30 days after state_at but not after ingested_at");
  clock.now = T0 + 10 * DAY + RETENTION_MS - 1;
  assert.deepEqual((await store.selectRetention()).records, []);
  clock.now = T0 + 10 * DAY + RETENTION_MS;
  assert.deepEqual((await store.selectRetention()).records.map((r) => r.requestId), [id]);
});

test("CL-11 record-less probe answers: one per (peer, id, ref) per interval; bounded; no record is created", async (t) => {
  const { store, root, clock } = await box(t);
  const id = randomUUID();
  assert.equal(await store.claimRecordlessAnswer("linux", id, "REQUEST-1", 60_000), true);
  assert.equal(await store.claimRecordlessAnswer("linux", id, "REQUEST-1", 60_000), false, "same (peer, id, ref) within 60 s");
  assert.equal(await store.claimRecordlessAnswer("linux", id, "REPLY-1", 60_000), true, "another ref");
  assert.equal(await store.claimRecordlessAnswer("mac", id, "REQUEST-1", 60_000), true, "another peer");
  clock.now += 59_999;
  assert.equal(await store.claimRecordlessAnswer("linux", id, "REQUEST-1", 60_000), false);
  clock.now += 1;
  assert.equal(await store.claimRecordlessAnswer("linux", id, "REQUEST-1", 60_000), true, "60 s later");
  // Bounded: at most RECORDLESS_ANSWERS_MAX answers of the last interval are remembered; beyond that none is given.
  clock.now += 60_000;
  for (let i = 0; i < RECORDLESS_ANSWERS_MAX; i += 1) assert.equal(await store.claimRecordlessAnswer("linux", randomUUID(), "REQUEST-1", 60_000), true);
  assert.equal(await store.claimRecordlessAnswer("linux", randomUUID(), "REQUEST-1", 60_000), false, "full: no answer");
  clock.now += 60_000;
  assert.equal(await store.claimRecordlessAnswer("linux", id, "REQUEST-1", 60_000), true, "expired entries are dropped");
  const kept = JSON.parse(await fs.readFile(path.join(root, "probe-answers.json"), "utf8")) as { answers: Record<string, string> };
  assert.deepEqual(Object.keys(kept.answers), [`linux/${id}/REQUEST-1`]);
  assert.deepEqual(await store.list(), [], "no record");
  await fs.writeFile(path.join(root, "probe-answers.json"), "{\"v\":2}", { mode: 0o600 });
  await rejectsWith(store.claimRecordlessAnswer("linux", id, "REPLY-2", 60_000), "STORE_CORRUPT");
});

test("CL-03 a terminal record made open again counts against the open-record capacity", async (t) => {
  const { store, root } = await box(t);
  const closed = randomUUID();
  await create(store, receiver("linux", closed), record("receiver", closed, { state: "closed" }));
  for (let i = 0; i < OPEN_RECORDS_MAX; i += 1) {
    const id = randomUUID();
    const raw = envelope(id);
    await fs.writeFile(path.join(root, "raw", `${sha(raw)}.env`), raw, { mode: 0o600 });
    await plant(root, `inbox/linux/${id}.json`, record("receiver", id, { raw }));
  }
  await rejectsWith(store.mutate(receiver("linux", closed), (cur) => ({ write: { ...cur!, state: "received" as const }, value: undefined })), "LINK_CAPACITY");
  assert.equal((await store.read(receiver("linux", closed)))!.state, "closed");
});
