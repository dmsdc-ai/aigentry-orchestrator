// task-queue-write.mjs — the ONLY mutator of state/task-queue.json (#1172 U3).
//
// Runs as the child of bin/lib/task-queue-lock.py, INSIDE that broker's OS advisory
// lock, and never takes a lock itself: there is no lock code in this file. It refuses
// to run at all without the broker's one-shot token, which is what keeps a future
// caller from reaching the mutator unlocked.
//
// It is JS rather than Python for one measured reason: the queue is committed in the
// JS shape `JSON.stringify(doc, null, 2) + "\n"` by src/dispatch/cli.ts:939 and
// bin/init/cli.mjs:420, and #1110 cost a 26k-line diff per commit when two writers
// disagreed about that shape. Key insertion order comes from JSON.parse and is never
// re-ordered; unknown top-level and unknown per-row fields are carried through
// untouched; Unicode is emitted unescaped. Number semantics are JSON.parse →
// JSON.stringify's, i.e. byte-identical to what the two existing JS writers already
// do — integers beyond Number.MAX_SAFE_INTEGER are re-emitted from the double, which
// is a pre-existing property of every JS writer in this tree and not something this
// file changes.
//
// Protocol: one request JSON document on stdin, one response JSON document on stdout.
// No argv, no shell, no network, no spawn, no authority of any kind — see §5.4 of the
// U3 spec: a queue write is never product completion, a semantic ACK or admission.
//
// Mode 0644 on purpose: it is only ever run as `<node> task-queue-write.mjs`, so it
// needs no exec bit, exactly like bin/lib/win-private-storage.mjs.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Exit codes. Identical table in bin/lib/task-queue-lock.py; 2 is never produced. */
const EXIT = { ok: 0, state: 3, usage: 4, capability: 6, corrupt: 9 };

const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024;

/** The Rule 40 note separator. Measured on the real queue: 312 of 312 are exactly " || ". */
const SEGMENT_SEP = " || ";

/** src/dispatch/cli.ts:745. A status in this set is never silently rolled back (§5.1 A-2). */
const TERMINAL_STATUS = new Set(["done", "completed", "superseded", "cancelled", "closed"]);

const OPS = new Set(["append", "set-status", "register", "set-focus", "ledger-dispatch", "init-create"]);

/** Ops that validate every row. `ledger-dispatch` is deliberately absent: it must keep
 *  taskLedgerUpdate's exact tolerance for a malformed NEIGHBOUR row (cli.ts:796-802
 *  skips such a row rather than refusing), so only its own target row is checked. */
const STRICT_ROWS = new Set(["append", "set-status", "register"]);

class Refusal extends Error {
  constructor(reason, detail, code) {
    super(detail);
    this.reason = reason;
    this.code = code;
  }
}

const refuse = (reason, detail, code) => { throw new Refusal(reason, detail, code); };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const committed = (doc) => JSON.stringify(doc, null, 2) + "\n";
const utcDate = (d) => d.toISOString().slice(0, 10);

/** Order-insensitive deep value equality, so a replayed record whose keys arrive in a
 *  different order is still recognised as the SAME record (§5.1 register). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// ── test seam ───────────────────────────────────────────────────────────────────────
// Mirrors AIGENTRY_REGISTRY_FAULT at bin/dispatch-registry.py:220. The two pause_*
// values are barriers, so a race is opened deterministically instead of by sleeping.
const FAULT = process.env.AIGENTRY_TQ_NOTE_FAULT || "";
const fault = (name) => FAULT === name;

/** A blocking sleep with no event loop turn: this process holds the broker's lock and
 *  the barrier must not let anything else in this process run. */
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function barrier(name) {
  if (!fault(name)) return;
  const base = process.env.AIGENTRY_TQ_NOTE_FAULT_BARRIER;
  if (!base) return;
  fs.writeFileSync(`${base}.ready`, `${name}\n`);
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(`${base}.go`)) {
    if (Date.now() > deadline) break;
    sleepSync(10);
  }
}

// ── reading ─────────────────────────────────────────────────────────────────────────

/** S1 — open, prove the file is regular, bound its size, read and hash it. */
function readQueue(queue) {
  let lst;
  try {
    lst = fs.lstatSync(queue);
  } catch (e) {
    if (e.code === "ENOENT") {
      refuse("queue_missing", `the task queue does not exist: ${queue}`, EXIT.corrupt);
    }
    refuse("queue_unreadable", `cannot stat ${queue}: ${e.message}`, EXIT.corrupt);
  }
  // A symlinked LEAF is refused rather than followed: S9's rename would replace the
  // link and silently detach whatever it pointed at. A symlinked DIRECTORY is fine and
  // was already collapsed by the caller's realpath, which is what keeps every writer
  // on one lock inode.
  if (lst.isSymbolicLink()) {
    refuse("queue_not_regular", `${queue} is a symlink; refusing to replace the link`, EXIT.corrupt);
  }
  if (!lst.isFile()) {
    refuse("queue_not_regular", `${queue} is not a regular file`, EXIT.corrupt);
  }
  const fd = fs.openSync(queue, "r");
  let bytes;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) refuse("queue_not_regular", `${queue} is not a regular file`, EXIT.corrupt);
    if (st.size > MAX_QUEUE_BYTES) {
      refuse("queue_too_large",
        `${queue} is ${st.size} bytes, over the ${MAX_QUEUE_BYTES}-byte cap; refused, never truncated`,
        EXIT.corrupt);
    }
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let doc;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    refuse("queue_corrupt", `${queue} is not parseable JSON: ${e.message}`, EXIT.corrupt);
  }
  if (!isPlainObject(doc)) {
    refuse("queue_corrupt", `${queue} root is not a JSON object`, EXIT.corrupt);
  }
  return { bytes, hash: sha256(bytes), doc };
}

function tasksOf(doc, queue, strict) {
  if (!Object.prototype.hasOwnProperty.call(doc, "tasks")) {
    refuse("queue_corrupt", `${queue} has no "tasks" key`, EXIT.corrupt);
  }
  if (!Array.isArray(doc.tasks)) {
    refuse("queue_corrupt", `${queue} "tasks" is not an array`, EXIT.corrupt);
  }
  if (strict) {
    doc.tasks.forEach((row, i) => {
      if (!isPlainObject(row)) {
        refuse("queue_corrupt", `${queue} tasks[${i}] is not an object`, EXIT.corrupt);
      }
      const id = row.id;
      if (id === undefined || id === null || typeof id === "object") {
        refuse("queue_corrupt", `${queue} tasks[${i}] has no usable "id"`, EXIT.corrupt);
      }
    });
  }
  return doc.tasks;
}

/** Exactly src/dispatch/cli.ts:796-802 — the COUNT is the point. Ids are JSON numbers in
 *  the real queue (measured), so the comparison must be on String(). */
function findRows(rows, taskId) {
  const hits = [];
  rows.forEach((t, i) => { if (t && String(t.id) === taskId) hits.push(i); });
  return hits;
}

function locateRow(tasks, taskId, queue) {
  const hits = findRows(tasks, taskId);
  if (hits.length > 1) {
    const e = new Refusal("ambiguous_task_id",
      `task id '${taskId}' matches ${hits.length} rows in ${queue}`, EXIT.state);
    e.hits = hits.map((i) => ({ idx: i, desc: String(tasks[i]?.desc ?? "") }));
    throw e;
  }
  if (hits.length === 0) {
    refuse("unknown_task_id", `task id '${taskId}' is not in ${queue}`, EXIT.state);
  }
  return hits[0];
}

const normalizeId = (raw) => {
  const id = String(raw ?? "").trim();
  if (!id) refuse("invalid_argument", "a task id is required and may not be blank", EXIT.usage);
  return id;
};

// ── note segments (Rule 40) ─────────────────────────────────────────────────────────

const normalizeSegment = (s) => String(s).trim().replace(/\s+/gu, " ");
const splitSegments = (note) => (note.length ? note.split("||") : []);

// ── operations ──────────────────────────────────────────────────────────────────────

/** Each op returns {applied, reason, extra} and mutates `doc` in place when applied. */
const APPLY = {
  append(doc, p, ctx) {
    const tasks = tasksOf(doc, ctx.queue, true);
    const row = tasks[locateRow(tasks, normalizeId(p.task), ctx.queue)];
    if (row.note !== undefined && typeof row.note !== "string") {
      refuse("queue_corrupt", `tasks[].note for '${p.task}' is not a string`, EXIT.corrupt);
    }
    const raw = String(p.segment ?? "");
    if (Buffer.byteLength(raw, "utf8") > MAX_SEGMENT_BYTES) {
      refuse("invalid_argument",
        `the segment is over the ${MAX_SEGMENT_BYTES}-byte cap; put the detail in a report file `
        + "and cite its path in one sentence (Rule 40 ¶4)", EXIT.usage);
    }
    const body = raw.trim();
    const wanted = normalizeSegment(raw);
    if (!wanted) refuse("empty_segment", "the segment body is blank after normalization", EXIT.state);
    // R2 (review qr1172bct): `||` is the Rule 40 segment separator, so a body containing it
    // would be written as TWO segments. Its dedup identity could then never match on replay
    // (measured: the same append applied twice instead of answering already_applied), and
    // src/context-handoff/enrich.ts's latest-segment convention would read a truncated tail.
    // Refused BEFORE any write. Deliberately not encoded, escaped or split: the existing
    // ledger format is not changed, and a single `|` — which W-A's own ` | dispatched …`
    // stamps use — stays legal.
    if (wanted.includes("||")) {
      refuse("invalid_argument",
        "the segment body contains '||', which is the Rule 40 segment separator; it would be "
        + "stored as two segments and could never be recognised on replay. Put the detail in a "
        + "report file and cite its path in one sentence instead (Rule 40 ¶4)", EXIT.usage);
    }

    const note = row.note ?? "";
    const segs = splitSegments(note);
    ctx.segmentsBefore = segs.length;
    if (!p.allow_duplicate_content) {
      const hashes = segs.map((s) => sha256(normalizeSegment(s)));
      const at = hashes.lastIndexOf(sha256(wanted));
      if (at !== -1) {
        // §5.1 A-4: last ⇒ this is a crash replay of the immediately preceding append,
        // so it is an observed no-op. Earlier ⇒ a Rule 40 ¶4 restatement, refused.
        if (at === hashes.length - 1) {
          ctx.segmentsAfter = segs.length;
          return { applied: false, reason: "already_applied" };
        }
        refuse("duplicate_segment_content",
          `an identical segment is already present at segment ${at + 1} of ${segs.length}; `
          + "pass --allow-duplicate-content if the repetition is the intent", EXIT.state);
      }
    }
    row.note = note.length ? note + SEGMENT_SEP + body : body;
    // Rule 40 ¶3: appending to a `done` row never changes its status.
    row.updated_at = ctx.today;
    ctx.segmentsAfter = splitSegments(row.note).length;
    return { applied: true, reason: null };
  },

  "set-status": function setStatus(doc, p, ctx) {
    const tasks = tasksOf(doc, ctx.queue, true);
    const row = tasks[locateRow(tasks, normalizeId(p.task), ctx.queue)];
    const target = String(p.status ?? "").trim();
    if (!target) refuse("invalid_argument", "--status is required", EXIT.usage);
    const current = row.status === undefined || row.status === null ? "" : String(row.status);

    // Field-scoped revision guard first (§4.1 ordering: guards before idempotence).
    if (p.expect_status !== undefined && p.expect_status !== null
        && String(p.expect_status) !== current) {
      refuse("expect_status_mismatch",
        `task '${p.task}' status is '${current}', not the expected '${p.expect_status}'; `
        + "refusing rather than overwriting a newer status", EXIT.state);
    }
    if (current === target) return { applied: false, reason: "already_applied" };
    if (TERMINAL_STATUS.has(current) && !TERMINAL_STATUS.has(target) && !ctx.casMatched) {
      refuse("status_regression",
        `task '${p.task}' is terminal ('${current}'); moving it to '${target}' would roll back a `
        + `newer state. Re-run with --expect-sha256 ${ctx.hashBefore} if that is the intent`,
        EXIT.state);
    }
    row.status = target;
    row.updated_at = ctx.today;
    return { applied: true, reason: null };
  },

  register(doc, p, ctx) {
    const tasks = tasksOf(doc, ctx.queue, true);
    const record = p.task_record;
    if (!isPlainObject(record)) {
      refuse("invalid_argument", "the task record must be a JSON object", EXIT.usage);
    }
    if (record.id === undefined || record.id === null || typeof record.id === "object") {
      refuse("invalid_argument", "the task record needs a scalar \"id\"", EXIT.usage);
    }
    const id = normalizeId(record.id);
    const hits = findRows(tasks, id);
    if (hits.length > 1) {
      const e = new Refusal("ambiguous_task_id",
        `task id '${id}' already matches ${hits.length} rows in ${ctx.queue}`, EXIT.state);
      e.hits = hits.map((i) => ({ idx: i, desc: String(tasks[i]?.desc ?? "") }));
      throw e;
    }
    if (hits.length === 1) {
      // Exact equivalent record ⇒ replay no-op. Same id, different payload ⇒ collision,
      // never a no-op and never an overwrite (CONTROLLER.md §1172).
      if (deepEqual(tasks[hits[0]], record)) return { applied: false, reason: "already_applied" };
      refuse("duplicate_task_id",
        `task id '${id}' is already registered with a different payload; this is a collision, `
        + "not a replay. Register a distinct id (e.g. '" + id + "b')", EXIT.state);
    }
    tasks.push(record);
    return { applied: true, reason: null };
  },

  "set-focus": function setFocus(doc, p, ctx) {
    const track = String(p.track ?? "").trim();
    if (!track) refuse("invalid_argument", "--track is required", EXIT.usage);
    // R10 (review qr1172bct): this op used to rewrite a document whose `tasks` was missing
    // or not an array, while every other op refuses it — measured: a corrupt document was
    // committed. Validated BEFORE any mutation. Non-strict on purpose: a malformed
    // NEIGHBOUR row must not block a focus change, which touches no row at all.
    tasksOf(doc, ctx.queue, false);
    const current = doc.active_focus === undefined || doc.active_focus === null
      ? null : String(doc.active_focus);

    if (p.expect_focus !== undefined && p.expect_focus !== null) {
      const expected = String(p.expect_focus);
      const seen = current === null ? "null" : current;
      if (expected !== seen) {
        refuse("expect_focus_mismatch",
          `active_focus is '${seen}', not the expected '${expected}'; the focus moved under this `
          + "caller and the newer value is left in place", EXIT.state);
      }
    }
    if (!isPlainObject(doc.tracks) || !Object.prototype.hasOwnProperty.call(doc.tracks, track)) {
      refuse("unknown_track", `unknown track: ${track}`, EXIT.state);
    }
    if (current === track) return { applied: false, reason: "already_applied" };
    doc.active_focus = track;
    return { applied: true, reason: null };
  },

  /** W-A only. src/dispatch/cli.ts taskLedgerUpdate's three effects, unchanged in
   *  substance, now decided inside the lock. */
  "ledger-dispatch": function ledgerDispatch(doc, p, ctx) {
    const tasks = tasksOf(doc, ctx.queue, false);
    const row = tasks[locateRow(tasks, normalizeId(p.task), ctx.queue)];
    if (!isPlainObject(row)) {
      refuse("queue_corrupt", `the row for task '${p.task}' is not an object`, EXIT.corrupt);
    }
    if (row.note !== undefined && row.note !== null && typeof row.note !== "string") {
      // Narrow hardening over the old `(task.note as string) || ""`, which would have
      // concatenated a non-string into "[object Object] | dispatched …". In W-A this
      // surfaces as the existing best-effort WARNING; the dispatch is unaffected.
      refuse("queue_corrupt", `tasks[].note for '${p.task}' is not a string`, EXIT.corrupt);
    }
    const stamp = String(p.note_stamp ?? "");
    if (!stamp) refuse("invalid_argument", "note_stamp is required", EXIT.usage);
    const promoteFrom = Array.isArray(p.promote_from) ? p.promote_from.map(String) : [];
    const promoteTo = p.promote_to === undefined || p.promote_to === null ? null : String(p.promote_to);
    const today = String(p.updated_at ?? ctx.today);
    const decision = isPlainObject(p.spawn_decision) ? p.spawn_decision : null;

    const note = typeof row.note === "string" ? row.note : "";
    const needsStamp = !note.includes(stamp);
    const needsPromote = promoteTo !== null && promoteFrom.includes(String(row.status ?? ""));
    const needsDate = String(row.updated_at ?? "") !== today;
    let needsDecision = false;
    if (decision) {
      const prior = row.spawn_decisions;
      const bySid = isPlainObject(prior) ? prior : {};
      needsDecision = !deepEqual(bySid[String(decision.sid)], decision.value);
    }
    // Exact-record replay is a no-op only when EVERY sub-effect is already in place.
    if (!needsStamp && !needsPromote && !needsDate && !needsDecision) {
      return { applied: false, reason: "already_applied" };
    }
    if (needsPromote) row.status = promoteTo;
    row.updated_at = today;
    if (needsStamp) row.note = note ? note + stamp : stamp.replace(/^[ |]+/u, "");
    if (decision) {
      const prior = row.spawn_decisions;
      const bySid = isPlainObject(prior) && !Array.isArray(prior) ? prior : {};
      bySid[String(decision.sid)] = decision.value;
      row.spawn_decisions = bySid;
    }
    return { applied: true, reason: null };
  },
};

// ── the commit protocol (S1-S10) ────────────────────────────────────────────────────

function commit(queue, doc, hashBefore, bytesBefore) {
  const dir = path.dirname(queue);
  const tmp = `${queue}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const next = Buffer.from(committed(doc), "utf8");

  let fd;
  try {
    // S6 — same directory, 0600, so the rename below is a true rename and never a
    // cross-device copy.
    fd = fs.openSync(tmp, "wx", 0o600);
    if (fault("temp_write")) refuse("write_failed", "temp write faulted (test seam)", EXIT.state);
    fs.writeFileSync(fd, next);
    if (fault("fsync")) refuse("write_failed", "fsync faulted (test seam)", EXIT.state);
    fs.fsyncSync(fd);                                                              // S7
    fs.closeSync(fd);
    fd = undefined;

    barrier("pause_before_verify");
    // S8 — a detector, NOT a guarantee and NOT a CAS. Every in-tree writer now takes
    // the broker's lock, which is what actually prevents lost updates; this catches a
    // writer that does not (a hand edit), and the window to S9 is small but not zero.
    if (fault("verify")) refuse("concurrent_write_detected", "verify faulted (test seam)", EXIT.state);
    const live = fs.readFileSync(queue);
    if (sha256(live) !== hashBefore) {
      refuse("concurrent_write_detected",
        `${queue} changed under this transaction (a writer that does not take `
        + `${queue}.lock); nothing was written`, EXIT.state);
    }

    barrier("pause_before_rename");
    if (fault("rename")) refuse("write_failed", "rename faulted (test seam)", EXIT.state);
    fs.renameSync(tmp, queue);                                                     // S9
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    // §4.5 — exactly the one temp THIS operation created, and nothing else. The
    // directory is never enumerated and no other temp's age, owner or pid is examined.
    try { fs.unlinkSync(tmp); } catch { /* never created, or already gone */ }
    throw e;
  }

  // S10 — POSIX only. On win32 the rename is the last durability boundary, exactly as
  // bin/dispatch-registry.py:425-427 already documents for the registry.
  if (process.platform !== "win32") {
    if (fault("dir_fsync")) {
      refuse("write_failed",
        "directory fsync faulted (test seam); the rename already landed, so both generations "
        + "are complete documents", EXIT.state);
    }
    let dirFd;
    try {
      dirFd = fs.openSync(dir, "r");
      fs.fsyncSync(dirFd);
    } catch { /* best effort: the rename is already durable in the file sense */ }
    finally { if (dirFd !== undefined) { try { fs.closeSync(dirFd); } catch { /* closed */ } } }
  }
  return { bytes: next.length, hash: sha256(next), bytesBefore };
}

/** init-create (W-C). Exclusive creation IS the atomicity, and it happens inside the
 *  broker's lock, so no unlocked write remains — not even init's. */
function initCreate(queue, p) {
  if (!isPlainObject(p.document)) {
    refuse("invalid_argument", "init-create needs a JSON object document", EXIT.usage);
  }
  const next = Buffer.from(committed(p.document), "utf8");
  let fd;
  try {
    fd = fs.openSync(queue, "wx", 0o644);
  } catch (e) {
    if (e.code === "EEXIST") {
      return { applied: false, reason: "exists", bytes: null, hash: null };
    }
    refuse("write_failed", `could not create ${queue}: ${e.message}`, EXIT.state);
  }
  try {
    fs.writeFileSync(fd, next);
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* closed */ }
    try { fs.unlinkSync(queue); } catch { /* this operation created it; nothing else did */ }
    refuse("write_failed", `could not write ${queue}: ${e.message}`, EXIT.state);
  }
  fs.closeSync(fd);
  if (process.platform !== "win32") {
    let dirFd;
    try { dirFd = fs.openSync(path.dirname(queue), "r"); fs.fsyncSync(dirFd); }
    catch { /* best effort */ }
    finally { if (dirFd !== undefined) { try { fs.closeSync(dirFd); } catch { /* closed */ } } }
  }
  return { applied: true, reason: null, bytes: next.length, hash: sha256(next) };
}

// ── entry point ─────────────────────────────────────────────────────────────────────

function run(request) {
  const op = String(request.op ?? "");
  if (!OPS.has(op)) refuse("invalid_argument", `unknown op: ${op || "(none)"}`, EXIT.usage);
  const queue = String(request.queue ?? "");
  if (!queue || !path.isAbsolute(queue)) {
    refuse("invalid_argument", "queue must be an absolute path", EXIT.usage);
  }
  const p = isPlainObject(request.params) ? request.params : {};
  const base = {
    v: 1,
    op,
    // register names its target inside the record; every other op names it in `task`.
    task: p.task !== undefined ? String(p.task)
      : (op === "register" && isPlainObject(p.task_record) && p.task_record.id !== undefined
        && p.task_record.id !== null && typeof p.task_record.id !== "object"
        ? String(p.task_record.id) : null),
    track: p.track === undefined ? null : String(p.track),
    queue,
    correlation_id: request.correlation_id === undefined ? null : request.correlation_id,
    lock_inode: process.env.AIGENTRY_TQ_LOCK_INODE
      ? Number(process.env.AIGENTRY_TQ_LOCK_INODE) : null,
  };

  if (op === "init-create") {
    const r = initCreate(queue, p);
    return {
      ...base, applied: r.applied, reason: r.reason,
      doc_sha256_before: null, doc_sha256_after: r.hash,
      bytes_before: null, bytes_after: r.bytes,
      segments_before: null, segments_after: null,
    };
  }

  const { bytes, hash, doc } = readQueue(queue);

  // S2 — the CAS gate, BEFORE any already-applied reasoning. A caller that asserted a
  // document version and was wrong is told so, even when its effect is already present:
  // answering already_applied would hide that its next decision is computed from a view
  // that no longer exists. A crash REPLAY therefore omits --expect-sha256 (U3 spec §4.1).
  const expect = request.expect_sha256 === undefined || request.expect_sha256 === null
    ? null : String(request.expect_sha256);
  if (expect !== null && expect !== hash) {
    refuse("stale_document",
      `${queue} is at ${hash}, not the expected ${expect}; refusing rather than overwriting `
      + "a document this caller has not seen", EXIT.state);
  }

  const ctx = {
    queue, today: utcDate(new Date()), casMatched: expect !== null, hashBefore: hash,
    segmentsBefore: null, segmentsAfter: null,
  };
  const outcome = APPLY[op](doc, p, ctx);

  if (!outcome.applied) {
    // Nothing is written. Not one byte, not a temp file.
    return {
      ...base, applied: false, reason: outcome.reason,
      doc_sha256_before: hash, doc_sha256_after: hash,
      bytes_before: bytes.length, bytes_after: bytes.length,
      segments_before: ctx.segmentsBefore, segments_after: ctx.segmentsAfter,
    };
  }
  const w = commit(queue, doc, hash, bytes.length);
  return {
    ...base, applied: true, reason: null,
    doc_sha256_before: hash, doc_sha256_after: w.hash,
    bytes_before: bytes.length, bytes_after: w.bytes,
    segments_before: ctx.segmentsBefore, segments_after: ctx.segmentsAfter,
  };
}

/** process.stdout.write to a PIPE is asynchronous, and process.exit can truncate it.
 *  Every response leaves through a synchronous fd write for that reason. */
const out = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\n");
const err = (line) => { try { fs.writeSync(2, line); } catch { /* stderr may be closed */ } };

function main() {
  if (!process.env.AIGENTRY_TQ_LOCK_TOKEN) {
    out({
      v: 1, applied: false, reason: "lock_token_missing",
      detail: "this transform mutates the task queue and may only run inside "
        + "bin/lib/task-queue-lock.py, which holds the OS advisory lock",
    });
    process.exit(EXIT.usage);
  }
  let raw;
  try {
    raw = fs.readFileSync(0);
  } catch (e) {
    out({ v: 1, applied: false, reason: "invalid_argument", detail: `no request on stdin: ${e.message}` });
    process.exit(EXIT.usage);
  }
  if (raw.length > MAX_REQUEST_BYTES) {
    out({ v: 1, applied: false, reason: "request_too_large",
      detail: `request exceeds ${MAX_REQUEST_BYTES} bytes; refused rather than truncated` });
    process.exit(EXIT.usage);
  }
  let request;
  try {
    request = JSON.parse(raw.toString("utf8"));
    if (!isPlainObject(request)) throw new Error("request root is not an object");
  } catch (e) {
    out({ v: 1, applied: false, reason: "invalid_argument", detail: `bad request: ${e.message}` });
    process.exit(EXIT.usage);
  }
  try {
    out(run(request));
    process.exit(EXIT.ok);
  } catch (e) {
    if (e instanceof Refusal) {
      const body = {
        v: 1, applied: false, reason: e.reason, detail: e.message,
        op: String(request.op ?? ""), queue: String(request.queue ?? ""),
      };
      if (e.hits) body.hits = e.hits;
      out(body);
      err(`task-queue-write.mjs: ${e.reason}: ${e.message}\n`);
      process.exit(e.code);
    }
    out({ v: 1, applied: false, reason: "write_failed", detail: String(e && e.message ? e.message : e) });
    err(`task-queue-write.mjs: write_failed: ${e && e.stack ? e.stack : e}\n`);
    process.exit(EXIT.state);
  }
}

main();
