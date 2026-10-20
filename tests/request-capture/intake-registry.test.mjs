// #1166 U1 — the durable intake ledger against the REAL writer (bin/dispatch-registry.py).
//
// Oracle, not "the new command exists": every case below is a lifecycle, identity, locking,
// durability or refusal assertion that a plausible wrong implementation fails. The mutant matrix
// in OUTPUT/SPEC-U1.md §6 names the eighteen mutants each case is meant to kill.
//
//   R-SCHEMA  fresh document shape/mode/generation; active.json never created
//   R-ISO     active.json byte-identical across a full intake lifecycle; its lock never created
//   R-LIFE    captured→bind→start→pause→resume→answered→work-completed, one history append each
//   R-REFUSE  every off-table transition refused with a zero-write proof
//   R-ACK     an answer plus a result link is NOT completion
//   R-ID      replay / collision / fabricated upstream id / equal bytes twice
//   R-DEDUP   the upstream dedupe key is channel+namespace+scope scoped
//   R-FIFO    receipt order, out-of-order arrival, superseded rows excluded, label exact
//   R-LOCK    intake writes take intake.json.lock ONLY (active.json.lock held by a test child)
//   R-CONC    concurrent writers serialise with no lost update
//   R-CRASH   each durable-write fault seam: exit 9, hot bytes identical, no temp residue
//   R-ARCHIVE prune archives before dropping; archive failure keeps every row hot
//   R-NORES   an archived request is never resurrected; the lookup is bounded and refuses
//   R-KEEP    queued/in_progress/waiting/failed survive prune at any age
//   R-CORRUPT corrupt ledger fails closed, bytes preserved, health written outside the file
//   R-LARGE   bounds refuse rather than truncate
//   R-SQL     the shipped SQLite transition barrier covers the new ops unchanged
//   R-PATH    no record field ever becomes a path
//   R-DIFF    differential oracle: the real Python vs the compiled pure core
//
// Environment: test-owned fixture roots under a private TMPDIR, 0700/umask-respecting, one fresh
// python3 child per registry call. No host PID probe or signal: the only signalled process is the
// suite's own direct lock-holder child. No installer, package, network or git tool is reachable
// from this unit, and R-PATH asserts that the state directory holds nothing but fixed literals.
// POSIX only: the fixtures assert 0600/0700 modes and flock contention.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const SKIP = POSIX ? false : `POSIX-only intake ledger fixtures; not run on ${process.platform}`;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REGISTRY = path.join(REPO, "bin", "dispatch-registry.py");
const CORE = path.join(REPO, "dist", "src", "request-capture", "intake.js");
const LOCK_TIMEOUT_S = 10;
const ORDER = "received-at-then-ingress-id-not-commit-not-execution";

const T0 = Date.parse("2026-10-14T09:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString().slice(0, 19) + "Z";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex64 = (n) => String(n).padStart(2, "0").repeat(32);

/** A test-owned world: its own state dir, its own HOME/TMPDIR, nothing shared. */
function world(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `intake-${label}-`));
  fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state", "dispatch");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: root,
    DISPATCH_STATE_DIR: stateDir, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
  };
  const file = (name) => path.join(stateDir, name);
  const reg = (args, extraEnv = {}) => {
    // The product's POSIX invocation shape (src/dispatch/registry-command.ts:4-8): the script
    // itself, one fresh child per call, bounded, no shell.
    const r = spawnSync(REGISTRY, args, {
      env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL",
    });
    assert.equal(r.signal, null, `registry child signalled: ${r.signal} :: ${args.join(" ")}`);
    return r;
  };
  const json = (r) => {
    try {
      return JSON.parse(r.stdout);
    } catch {
      assert.fail(`not JSON (status ${r.status}): ${r.stdout}\n${r.stderr}`);
    }
  };
  return {
    root, stateDir, env, file, reg, json,
    names: () => fs.readdirSync(stateDir).sort(),
    raw: (name = "intake.json") => fs.readFileSync(file(name), "utf8"),
    exists: (name) => fs.existsSync(file(name)),
    doc: () => JSON.parse(fs.readFileSync(file("intake.json"), "utf8")),
    list: (args = []) => json(reg(["intake-list", ...args])),
    row: (id) => {
      const found = json(reg(["intake-list"])).requests.find((r) => r.ingress_id === id);
      assert.ok(found, `no intake row ${id}`);
      return found;
    },
    /** A complete `captured` payload; override any field, drop one with `undefined`. */
    capture: (n, over = {}) => {
      const base = {
        "--kind": "captured", "--ingress-id": uuid(n), "--capture-id": uuid(900 + n),
        "--channel": "codex-native", "--upstream-namespace": "codex/session",
        "--upstream-id-status": "unavailable", "--sha256": hex64(n),
        "--byte-len": String(16 * n), "--received-at": at(n), "--now": at(n),
      };
      const merged = { ...base, ...over };
      return Object.entries(merged).flatMap(([k, v]) => (v === undefined ? [] : [k, v]));
    },
    event: (kind, n, flags = {}, extraEnv = {}) => {
      const argv = ["intake-event", "--kind", kind, "--ingress-id", uuid(n)];
      for (const [k, v] of Object.entries(flags)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) argv.push(k, one);
      }
      return reg(argv, extraEnv);
    },
  };
}

/** `captured` for row n, asserted written. */
function captured(w, n, over = {}) {
  const r = w.reg(["intake-event", ...w.capture(n, over)]);
  assert.equal(r.status, 0, `captured ${n}: ${r.stdout}${r.stderr}`);
  const out = w.json(r);
  assert.equal(out.result, "intake_written");
  assert.equal(out.state, "queued");
  assert.equal(out.work_state, "unstarted");
  return out;
}

const refused = (r, result) => {
  assert.equal(r.status, 4, `expected refusal 4, got ${r.status}: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.result, result, r.stdout);
  assert.equal(out.completion_fact, null, "a refusal never carries a completion fact");
  return out;
};

// --- R-SCHEMA -----------------------------------------------------------------

test("R-SCHEMA fresh intake.json is its own versioned document, 0600, one generation per commit",
  { skip: SKIP }, () => {
    const w = world("schema");
    assert.equal(w.exists("intake.json"), false, "no ledger before the first write");
    captured(w, 1);
    const doc = w.doc();
    assert.deepEqual(Object.keys(doc).sort(), ["generation", "requests", "schema_version"]);
    assert.equal(doc.schema_version, 1, "intake versions independently of SCHEMA_VERSION=2");
    assert.equal(doc.generation, 1);
    assert.equal(doc.requests.length, 1);
    assert.equal(fs.statSync(w.file("intake.json")).mode & 0o777, 0o600);
    captured(w, 2);
    assert.equal(w.doc().generation, 2, "exactly one generation per commit");
    // The dispatch registry is a different document and nothing here creates it.
    assert.equal(w.exists("active.json"), false);
    assert.equal(w.exists("active.json.lock"), false);
    assert.deepEqual(w.names(), ["intake.json", "intake.json.lock"]);
  });

// --- R-ISO --------------------------------------------------------------------

test("R-ISO a full intake lifecycle leaves active.json byte-identical and never locks it",
  { skip: SKIP }, () => {
    const w = world("iso");
    assert.equal(w.reg(["begin-delivery", "--sid", "w1166-iso", "--ref-hash", hex64(7),
      "--now", at(0)]).status, 0);
    const before = w.raw("active.json");
    const beforeStat = fs.statSync(w.file("active.json"));
    fs.rmSync(w.file("active.json.lock"));           // prove the intake ops never recreate it
    captured(w, 1);
    assert.equal(w.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
      "--now": at(2) }).status, 0);
    assert.equal(w.event("start", 1, { "--now": at(3) }).status, 0);
    assert.equal(w.event("work-completed", 1, { "--verdict": "accepted",
      "--result-ref": "dispatch/1166/u1", "--evidence-sha256": hex64(3), "--now": at(4) }).status, 0);
    assert.equal(w.reg(["intake-prune", "--older-than-seconds", "60", "--now", at(600)]).status, 0);
    assert.equal(w.raw("active.json"), before, "dispatch registry byte-identical");
    assert.equal(JSON.parse(before).schema_version, 2, "SCHEMA_VERSION not bumped");
    assert.equal(fs.statSync(w.file("active.json")).mtimeMs, beforeStat.mtimeMs);
    assert.equal(w.exists("active.json.lock"), false, "intake never takes the dispatch lock");
  });

// --- R-LIFE -------------------------------------------------------------------

test("R-LIFE the authorised lifecycle appends exactly one history entry per transition",
  { skip: SKIP }, () => {
    const w = world("life");
    captured(w, 1);
    const steps = [
      ["bind", { "--owning-task": "1166", "--dispatch-id": uuid(11), "--now": at(2) },
        "queued", "unstarted"],
      ["start", { "--now": at(3) }, "in_progress", "in_progress"],
      ["pause", { "--reason": "blocked on review", "--owner": "orchestrator",
        "--resume-condition": "review returned", "--depends-on": ["1172", "1177"],
        "--now": at(4) }, "waiting", "paused"],
      ["resume", { "--now": at(5) }, "in_progress", "in_progress"],
      ["answered", { "--verdict": "answered", "--scope": "u1", "--now": at(6) },
        "in_progress", "in_progress"],
      ["work-completed", { "--verdict": "accepted", "--result-ref": "dispatch/1166/u1",
        "--evidence-sha256": hex64(3), "--now": at(7) }, "completed", "completed"],
    ];
    let history = w.row(uuid(1)).history.length;
    let previous = "queued";
    assert.equal(history, 1, "captured is itself one history entry");
    for (const [kind, flags, state, work] of steps) {
      const r = w.event(kind, 1, flags);
      assert.equal(r.status, 0, `${kind}: ${r.stdout}${r.stderr}`);
      const row = w.row(uuid(1));
      assert.equal(row.state, state, kind);
      assert.equal(row.work_state, work, `${kind} work_state`);
      assert.equal(row.history.length, history + 1, `${kind} appends exactly one history entry`);
      const last = row.history.at(-1);
      assert.equal(last.event, kind);
      assert.equal(last.at, flags["--now"]);
      assert.equal(last.from, previous, `${kind} records where it came from`);
      assert.equal(last.to, state, `${kind} records where it went`);
      if (kind === "pause") {
        assert.deepEqual(row.depends_on, ["1172", "1177"], "a pause names its dependencies");
        assert.equal(row.pause.resume_to, "in_progress", "and where to resume to");
      }
      if (kind === "resume") {
        assert.deepEqual(row.depends_on, [], "a resumed row waits on nothing");
        assert.equal(row.pause, null);
      }
      history = row.history.length;
      previous = state;
    }
    const row = w.row(uuid(1));
    assert.equal(row.answered_at, at(6));
    assert.deepEqual(row.result,
      { verdict: "accepted", result_ref: "dispatch/1166/u1", evidence_sha256: hex64(3) });
    // R3: review[] is the human-answer log and nothing else. The work verdict is not duplicated
    // into it; it lives in result and in the appended history entry, so no fact is lost.
    assert.deepEqual(row.review, [{ at: at(6), verdict: "answered", scope: "u1" }],
      "exactly one review entry, the answer");
    assert.equal(row.history.at(-1).event, "work-completed", "the work verdict is in history");
    assert.equal(row.history.at(-1).to, "completed");
    assert.deepEqual(row.binding, [{ at: at(2), owning_task: "1166", dispatch_id: uuid(11) }]);
    // immutables survived every transition
    assert.equal(row.sha256, hex64(1));
    assert.equal(row.received_at, at(1));
    assert.equal(row.capture_id, uuid(901));
  });

// --- R-REFUSE -----------------------------------------------------------------

test("R-REFUSE every off-table transition is refused with a zero-write proof", { skip: SKIP }, () => {
  const w = world("refuse");
  captured(w, 1);
  const zeroWrite = (label, operation, result) => {
    const before = w.raw();
    const generation = JSON.parse(before).generation;
    refused(operation(), result);
    assert.equal(w.raw(), before, `${label}: the ledger must be byte-identical after a refusal`);
    assert.equal(w.doc().generation, generation, `${label}: a refusal must not commit a generation`);
  };
  // start without a binding: the owner is a record, and work cannot start without one
  zeroWrite("start unbound", () => w.event("start", 1, { "--now": at(2) }), "intake_transition_refused");
  assert.equal(w.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
    "--now": at(2) }).status, 0);
  // resume without a pause; pause missing its mandatory payload ("busy" is never a pause)
  zeroWrite("resume unpaused", () => w.event("resume", 1, { "--now": at(3) }),
    "intake_transition_refused");
  zeroWrite("bare pause", () => w.event("pause", 1, { "--reason": "busy", "--now": at(3) }),
    "intake_malformed");
  // work-completed needs a verdict AND a result link AND evidence
  zeroWrite("completed, no link", () => w.event("work-completed", 1, { "--verdict": "accepted",
    "--now": at(3) }), "intake_malformed");
  zeroWrite("completed, no evidence", () => w.event("work-completed", 1, { "--verdict": "accepted",
    "--result-ref": "r", "--now": at(3) }), "intake_malformed");
  zeroWrite("completed, bad verdict", () => w.event("work-completed", 1, { "--verdict": "answered",
    "--result-ref": "r", "--evidence-sha256": hex64(3), "--now": at(3) }), "intake_malformed");
  // unknown kinds, including the ones a careless caller might expect to exist
  for (const kind of ["complete", "retire", "clean", "noop", "set-state", "captured-again"]) {
    zeroWrite(`kind ${kind}`, () => w.event(kind, 1, { "--now": at(3) }), "invalid_argument");
  }
  // an event for an absent row is never a creation
  zeroWrite("unknown row", () => w.event("start", 77, { "--now": at(3) }), "intake_not_found");
  // terminal states are terminal
  assert.equal(w.event("cancel", 1, { "--reason": "superseded by hand", "--now": at(4) }).status, 0);
  assert.equal(w.row(uuid(1)).state, "cancelled");
  for (const [kind, flags] of [["cancel", { "--reason": "again" }], ["start", {}],
    ["answered", { "--verdict": "answered", "--scope": "s" }],
    ["work-completed", { "--verdict": "accepted", "--result-ref": "r",
      "--evidence-sha256": hex64(3) }], ["fail", { "--reason": "measured_failure" }],
    ["pause", { "--reason": "r", "--owner": "o", "--resume-condition": "c" }]]) {
    zeroWrite(`cancelled + ${kind}`, () => w.event(kind, 1, { ...flags, "--now": at(5) }),
      "intake_transition_refused");
  }
  captured(w, 2);
  assert.equal(w.event("work-completed", 2, { "--verdict": "accepted", "--result-ref": "r",
    "--evidence-sha256": hex64(3), "--now": at(6) }).status, 0);
  zeroWrite("completed + cancel", () => w.event("cancel", 2, { "--reason": "too late", "--now": at(7) }),
    "intake_transition_refused");
  zeroWrite("completed + work-completed", () => w.event("work-completed", 2, { "--verdict": "accepted",
    "--result-ref": "r2", "--evidence-sha256": hex64(4), "--now": at(7) }),
    "intake_transition_refused");
});

test("R-REFUSE set-once fields refuse a second write instead of being rewritten", { skip: SKIP }, () => {
  const w = world("setonce");
  captured(w, 1);
  assert.equal(w.event("answered", 1, { "--verdict": "answered", "--scope": "u1",
    "--now": at(2) }).status, 0);
  const before = w.raw();
  refused(w.event("answered", 1, { "--verdict": "rejected", "--scope": "u1", "--now": at(3) }),
    "intake_transition_refused");
  assert.equal(w.raw(), before, "answered_at is set once; the first answer is authority");
  assert.equal(w.row(uuid(1)).answered_at, at(2));
});

// --- R-ACK --------------------------------------------------------------------

test("R-ACK an answer, even with a result link, is not completion", { skip: SKIP }, () => {
  const w = world("ack");
  captured(w, 1);
  assert.equal(w.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
    "--now": at(2) }).status, 0);
  assert.equal(w.event("start", 1, { "--now": at(3) }).status, 0);
  assert.equal(w.event("answered", 1, { "--verdict": "answered", "--scope": "u1",
    "--result-ref": "dispatch/1166/answer", "--now": at(4) }).status, 0);
  const row = w.row(uuid(1));
  assert.equal(row.answered_at, at(4), "the answer is recorded");
  assert.equal(row.state, "in_progress", "and the request is still open");
  assert.equal(row.work_state, "in_progress", "answered and work_state are two separate axes");
  assert.equal(row.result, null, "an answer never fills the completion result");
  // binding is a record of an owner, not proof that work started or finished
  const w2 = world("ack-bind");
  captured(w2, 1);
  assert.equal(w2.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
    "--now": at(2) }).status, 0);
  const bound = w2.row(uuid(1));
  assert.equal(bound.state, "queued", "binding is not a start");
  assert.equal(bound.work_state, "unstarted");
  assert.equal(bound.owning_task, "1166");
});

// --- R-ID ---------------------------------------------------------------------

test("R-ID replay dedupes, collision refuses, fabrication refuses, equal bytes stay distinct",
  { skip: SKIP }, () => {
    const w = world("id");
    captured(w, 1);
    const before = w.raw();
    // replay: byte-identical immutables, exit 8, nothing written, no second history entry
    const replay = w.reg(["intake-event", ...w.capture(1)]);
    assert.equal(replay.status, 8, replay.stdout + replay.stderr);
    assert.equal(w.json(replay).result, "intake_replay");
    assert.equal(w.raw(), before, "a replay writes nothing at all");
    assert.equal(w.row(uuid(1)).history.length, 1);
    // collision: the same ingress id with any mismatched immutable field refuses, never overwrites
    for (const [field, value] of [["--sha256", hex64(5)], ["--byte-len", "999"],
      ["--received-at", at(99)], ["--capture-id", uuid(777)], ["--channel", "claude-native"],
      ["--upstream-namespace", "claude/session"]]) {
      const r = w.reg(["intake-event", ...w.capture(1, { [field]: value })]);
      refused(r, "intake_identity_collision");
      assert.equal(w.raw(), before, `collision on ${field} must not overwrite the stored row`);
    }
    // fabricated upstream identity, both directions
    refused(w.reg(["intake-event", ...w.capture(2,
      { "--upstream-delivery-id": "dlv-2" })]), "intake_malformed");
    refused(w.reg(["intake-event", ...w.capture(2,
      { "--upstream-id-status": "available", "--upstream-delivery-id": undefined })]),
      "intake_malformed");
    // equal bytes, two deliveries: two rows, one digest, both open
    captured(w, 3, { "--sha256": hex64(1), "--byte-len": "16" });
    const rows = w.list().requests;
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.sha256)).size, 1, "one shared digest");
    assert.equal(new Set(rows.map((r) => r.ingress_id)).size, 2, "two distinct identities");
    assert.deepEqual(rows.map((r) => r.state), ["queued", "queued"]);
  });

// --- R-DEDUP ------------------------------------------------------------------

test("R-DEDUP the upstream dedupe key is scoped by channel, namespace and session scope",
  { skip: SKIP }, () => {
    const w = world("dedup");
    const avail = (n, over = {}) => w.capture(n, {
      "--upstream-id-status": "available", "--upstream-delivery-id": "dlv-shared",
      "--upstream-scope-sha256": hex64(1), ...over,
    });
    assert.equal(w.reg(["intake-event", ...avail(1)]).status, 0);
    // same provider id, same scope, a redelivery: deduped
    const again = w.reg(["intake-event", ...avail(2)]);
    assert.equal(again.status, 8, again.stdout + again.stderr);
    assert.equal(w.json(again).result, "intake_upstream_duplicate");
    assert.equal(w.list().requests.length, 1);
    // same provider id, different channel / namespace / session scope: three distinct requests
    assert.equal(w.reg(["intake-event", ...avail(3, { "--channel": "claude-native" })]).status, 0);
    assert.equal(w.reg(["intake-event", ...avail(4,
      { "--upstream-namespace": "codex/other" })]).status, 0);
    assert.equal(w.reg(["intake-event", ...avail(5,
      { "--upstream-scope-sha256": hex64(2) })]).status, 0);
    assert.equal(w.list().requests.length, 4, "a provider id never collides across scopes");
    // an unavailable upstream id never dedupes anything, however equal the row looks
    assert.equal(w.reg(["intake-event", ...w.capture(6, { "--sha256": hex64(6) })]).status, 0);
    assert.equal(w.reg(["intake-event", ...w.capture(7, { "--sha256": hex64(6) })]).status, 0);
    assert.equal(w.list().requests.length, 6);
  });

// --- R-FIFO -------------------------------------------------------------------

test("R-FIFO position is receipt order, derived, labelled, and excludes closed and superseded rows",
  { skip: SKIP }, () => {
    const w = world("fifo");
    // written late-first: the stored order is not the receipt order
    captured(w, 3, { "--received-at": at(30) });
    captured(w, 1, { "--received-at": at(10) });
    captured(w, 2, { "--received-at": at(20) });
    const listed = w.list();
    assert.equal(listed.order, ORDER, "the order label names receipt order and denies the others");
    assert.deepEqual(listed.requests.map((r) => r.ingress_id), [uuid(1), uuid(2), uuid(3)]);
    assert.deepEqual(listed.requests.map((r) => r.position), [1, 2, 3]);
    const stored = w.doc().requests;
    assert.deepEqual(stored.map((r) => r.ingress_id), [uuid(3), uuid(1), uuid(2)]);
    assert.equal(stored.every((r) => !("position" in r)), true,
      "position is derived on read, never stored");
    // a cancelled row leaves the accounting; the rest renumber without reordering
    assert.equal(w.event("cancel", 1, { "--reason": "withdrawn", "--now": at(40) }).status, 0);
    const after = w.list().requests;
    assert.deepEqual(after.filter((r) => r.position !== null).map((r) => r.ingress_id),
      [uuid(2), uuid(3)]);
    assert.deepEqual(after.filter((r) => r.position !== null).map((r) => r.position), [1, 2]);
    assert.equal(after.find((r) => r.ingress_id === uuid(1)).position, null,
      "a cancelled row keeps no queue position");
    // amendment: the original is preserved verbatim and leaves the accounting; the revision takes it
    const original = w.row(uuid(2));
    const amend = w.reg(["intake-event", ...w.capture(5, { "--kind": "amend",
      "--supersedes": uuid(2), "--received-at": at(50), "--now": at(50) })]);
    assert.equal(amend.status, 0, amend.stdout + amend.stderr);
    const amended = w.row(uuid(2));
    assert.equal(amended.superseded_by, uuid(5));
    assert.equal(amended.state, original.state, "supersession is not a state change");
    assert.deepEqual(amended.history.slice(0, 1), original.history.slice(0, 1),
      "the original history is preserved verbatim");
    assert.equal(amended.sha256, original.sha256);
    assert.equal(amended.received_at, original.received_at);
    assert.equal(amended.position, null, "a superseded row is not counted twice in the queue");
    assert.equal(w.row(uuid(5)).supersedes, uuid(2));
    assert.equal(w.row(uuid(5)).state, "queued");
    assert.deepEqual(w.list().requests.filter((r) => r.position !== null)
      .map((r) => r.ingress_id), [uuid(3), uuid(5)]);
    // a second supersession of the same row refuses rather than rewriting the link
    const before = w.raw();
    refused(w.reg(["intake-event", ...w.capture(6, { "--kind": "amend", "--supersedes": uuid(2),
      "--received-at": at(60), "--now": at(60) })]), "intake_transition_refused");
    assert.equal(w.raw(), before);
  });

test("R-FIFO a new prompt never cancels, completes or reprioritises a prior row", { skip: SKIP }, () => {
  const w = world("noclobber");
  captured(w, 1, { "--received-at": at(10) });
  const before = w.doc().requests[0];
  captured(w, 2, { "--received-at": at(20) });
  captured(w, 3, { "--received-at": at(5) });
  const after = w.doc().requests.find((r) => r.ingress_id === uuid(1));
  assert.deepEqual(after, before, "an unrelated arrival leaves every prior row untouched");
  assert.equal(w.row(uuid(1)).position, 2, "an earlier receipt legitimately precedes it");
  assert.equal(w.list().requests.every((r) => r.state === "queued"), true);
});

// --- R-LOCK -------------------------------------------------------------------

/** Hold a lock on one of the two lock files from a direct, test-owned child. */
function holder(w, name) {
  // Inert fixture: flocks the named file and blocks on a read it will never get. No product code.
  const program = "import fcntl,sys\n"
    + "fh=open(sys.argv[1],'a+b',buffering=0)\n"
    + "fcntl.flock(fh,fcntl.LOCK_EX)\n"
    + "sys.stdout.write('held\\n');sys.stdout.flush()\n"
    + "sys.stdin.read()\n";
  const child = spawn("python3", ["-I", "-c", program, w.file(name)],
    { env: w.env, stdio: ["pipe", "pipe", "pipe"] });
  return {
    child,
    ready: new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lock holder for ${name} never started`)),
        30_000);
      child.stdout.once("data", (d) => {
        clearTimeout(timer);
        resolve(String(d).trim());
      });
      child.once("error", reject);
    }),
    // Bounded cleanup of a demonstrably test-owned direct child only.
    release: () => new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGKILL");
    }),
  };
}

test("R-LOCK an intake write takes intake.json.lock only, and is not blocked by the dispatch lock",
  { skip: SKIP }, async () => {
    const w = world("lock");
    captured(w, 1);
    assert.equal(w.reg(["begin-delivery", "--sid", "w1166-lock", "--ref-hash", hex64(7),
      "--now", at(0)]).status, 0);
    const held = holder(w, "active.json.lock");
    try {
      assert.equal(await held.ready, "held");
      // An urgent cancel must not queue behind a dispatch-registry writer.
      const started = Date.now();
      const cancel = w.event("cancel", 1, { "--reason": "urgent stop", "--now": at(2) });
      const elapsed = (Date.now() - started) / 1000;
      assert.equal(cancel.status, 0, `cancel blocked by the dispatch lock: ${cancel.stdout}${cancel.stderr}`);
      assert.ok(elapsed < LOCK_TIMEOUT_S, `cancel took ${elapsed}s, i.e. it waited on a lock`);
      assert.equal(w.row(uuid(1)).state, "cancelled", "and it is immediately visible");
      // the converse: a dispatch write IS still serialised by its own lock (the seam is real)
      const blocked = w.reg(["set-lifecycle", "--sid", "w1166-lock", "--state", "cleaned",
        "--all", "--now", at(3)]);
      assert.equal(blocked.status, 9, "control: the held dispatch lock does block a dispatch write");
      assert.match(JSON.parse(blocked.stdout).detail, /lock timeout/);
    } finally {
      await held.release();
    }
  });

test("R-LOCK an intake write is serialised by its own lock", { skip: SKIP }, async () => {
  const w = world("lock2");
  captured(w, 1);
  const held = holder(w, "intake.json.lock");
  try {
    assert.equal(await held.ready, "held");
    const before = w.raw();
    const blocked = w.event("cancel", 1, { "--reason": "contended", "--now": at(2) });
    assert.equal(blocked.status, 9, blocked.stdout + blocked.stderr);
    assert.match(JSON.parse(blocked.stdout).detail, /lock timeout/);
    assert.equal(w.raw(), before, "a lock timeout writes nothing");
  } finally {
    await held.release();
  }
  assert.equal(w.event("cancel", 1, { "--reason": "after release", "--now": at(3) }).status, 0);
});

// --- R-CONC -------------------------------------------------------------------

test("R-CONC concurrent intake writers serialise with no lost update", { skip: SKIP }, async () => {
  const w = world("conc");
  const n = 8;
  for (let i = 1; i <= n; i += 1) captured(w, i);
  const runs = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const child = spawn(REGISTRY, ["intake-event", "--kind", "bind", "--ingress-id", uuid(i + 1),
      "--owning-task", "1166", "--dispatch-id", uuid(100 + i), "--now", at(10 + i)],
      { env: w.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("exit", (status, signal) => resolve({ status, signal, out }));
  })));
  assert.deepEqual(runs.map((r) => r.signal).filter(Boolean), []);
  assert.deepEqual(runs.map((r) => r.status), Array.from({ length: n }, () => 0),
    runs.map((r) => r.out).join("\n"));
  const doc = w.doc();
  assert.equal(doc.requests.length, n);
  assert.equal(doc.generation, n + n, "every write committed exactly one generation");
  for (const row of doc.requests) {
    assert.equal(row.binding.length, 1, `lost update on ${row.ingress_id}`);
    assert.equal(row.history.length, 2);
  }
});

// --- R-CRASH ------------------------------------------------------------------

test("R-CRASH every durable-write fault keeps the hot document intact and leaves no residue",
  { skip: SKIP }, () => {
    const w = world("crash");
    captured(w, 1);
    const before = w.raw();
    for (const seam of ["temp_write", "fsync", "rename", "dir_fsync"]) {
      const r = w.event("cancel", 1, { "--reason": `fault ${seam}`, "--now": at(5) },
        { AIGENTRY_REGISTRY_FAULT: seam });
      assert.equal(r.status, 9, `${seam}: ${r.stdout}${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).result, "registry_write_failed");
      if (seam === "dir_fsync") {
        // The rename already landed: a complete generation, by contract. Not a lost row.
        const doc = w.doc();
        assert.equal(doc.schema_version, 1);
        assert.equal(doc.requests[0].state, "cancelled");
      } else {
        assert.equal(w.raw(), before, `${seam}: the hot ledger must be byte-identical`);
      }
      assert.deepEqual(w.names().filter((f) => f.includes(".tmp")), [],
        `${seam}: no temp sibling left behind`);
    }
    // the lock fault never leaves a half-written document either
    const locked = w.event("cancel", 2, { "--reason": "x", "--now": at(6) },
      { AIGENTRY_REGISTRY_FAULT: "lock" });
    assert.equal(locked.status, 9);
    assert.deepEqual(w.names().filter((f) => f.includes(".tmp")), []);
    // health is recorded OUTSIDE the file being complained about
    assert.ok(fs.readFileSync(w.file("registry-health.log"), "utf8").includes("registry_write_failed"));
  });

// --- R-ARCHIVE / R-NORES / R-KEEP --------------------------------------------

/** Two closed rows aged past any cutoff, plus one of every open state. */
function pruneFixture(label) {
  const w = world(label);
  captured(w, 1, { "--received-at": at(1) });
  assert.equal(w.event("cancel", 1, { "--reason": "withdrawn", "--now": at(2) }).status, 0);
  captured(w, 2, { "--received-at": at(3) });
  assert.equal(w.event("work-completed", 2, { "--verdict": "accepted", "--result-ref": "r",
    "--evidence-sha256": hex64(3), "--now": at(4) }).status, 0);
  captured(w, 3, { "--received-at": at(5) });                                    // queued
  captured(w, 4, { "--received-at": at(6) });
  assert.equal(w.event("bind", 4, { "--owning-task": "1166", "--dispatch-id": uuid(14),
    "--now": at(7) }).status, 0);
  assert.equal(w.event("start", 4, { "--now": at(8) }).status, 0);               // in_progress
  captured(w, 5, { "--received-at": at(9) });
  assert.equal(w.event("pause", 5, { "--reason": "dependency", "--owner": "orchestrator",
    "--resume-condition": "1172 lands", "--now": at(10) }).status, 0);           // waiting
  captured(w, 6, { "--received-at": at(11) });
  assert.equal(w.event("fail", 6, { "--reason": "evidence_missing", "--now": at(12) }).status, 0);
  const later = at(60 * 24 * 30);
  return { w, prune: (env = {}) => w.reg(["intake-prune", "--older-than-seconds", "86400",
    "--now", later], env), later };
}
const archiveLines = (w) => fs.readFileSync(w.file("intake-archive.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("R-ARCHIVE prune archives a closed row before dropping it, and keeps every open row",
  { skip: SKIP }, () => {
    const { w, prune } = pruneFixture("archive");
    const open = w.list().requests.filter((r) => !["completed", "cancelled"].includes(r.state));
    // the archive append precedes the commit: with the commit faulted the line is already durable
    const faulted = prune({ AIGENTRY_REGISTRY_FAULT: "temp_write" });
    assert.equal(faulted.status, 9, faulted.stdout + faulted.stderr);
    assert.equal(w.list().requests.length, 6, "faulted commit: every row still hot");
    const first = archiveLines(w);
    assert.equal(first.length, 2, "appended before the (faulted) commit");
    assert.equal(fs.statSync(w.file("intake-archive.jsonl")).mode & 0o777, 0o600);
    assert.deepEqual(first.map((l) => l.ingress_id).sort(), [uuid(1), uuid(2)]);
    for (const line of first) {
      assert.equal(line.v, 1);
      assert.equal(line.reason, "closed_aged_past_cutoff");
      assert.equal(line.record.ingress_id, line.ingress_id, "the line carries the full row");
    }
    // the real prune: archived (at-least-once, so the line repeats), then dropped
    const ok = prune();
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const second = archiveLines(w);
    assert.equal(second.length, 4, "a crash between append and prune repeats a line");
    assert.deepEqual(second.slice(2).map((l) => l.record), first.map((l) => l.record),
      "the repeat is the same immutable identity and record, not a second request");
    const remaining = w.list().requests;
    assert.deepEqual(remaining.map((r) => r.ingress_id).sort(), open.map((r) => r.ingress_id).sort());
    assert.deepEqual(remaining.map((r) => r.state).sort(),
      ["failed", "in_progress", "queued", "waiting"]);
    assert.equal(JSON.parse(ok.stdout).archived, 2);
  });

test("R-ARCHIVE an archive append failure keeps EVERY candidate row hot, in place", { skip: SKIP }, () => {
  const { w, prune } = pruneFixture("archive-fail");
  const before = w.raw();
  // an un-openable archive path: a directory at the fixed literal name
  fs.mkdirSync(w.file("intake-archive.jsonl"));
  const r = prune();
  assert.equal(r.status, 9, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).result, "registry_write_failed");
  assert.match(JSON.parse(r.stdout).detail, /archive append failed/);
  assert.equal(w.raw(), before, "no row is dropped that is not durably archived");
  assert.equal(w.list().requests.length, 6);
});

test("R-NORES an archived request is never resurrected, and the lookup is bounded", { skip: SKIP }, () => {
  const { w, prune } = pruneFixture("nores");
  assert.equal(prune().status, 0);
  assert.equal(w.list().requests.some((r) => r.ingress_id === uuid(1)), false);
  // a replayed capture for an archived id: refused, no row, nothing written
  const before = w.raw();
  const replay = w.reg(["intake-event", ...w.capture(1, { "--received-at": at(1) })]);
  assert.equal(replay.status, 8, replay.stdout + replay.stderr);
  assert.equal(w.json(replay).result, "intake_archived");
  assert.equal(w.raw(), before, "no resurrection, and no write either");
  assert.equal(w.list().requests.some((r) => r.ingress_id === uuid(1)), false);
  // past the scan bound the op refuses rather than admitting an unprovable capture
  const line = `${JSON.stringify({ v: 1, archived_at: at(1), reason: "pad", ingress_id: uuid(800), record: { pad: "x".repeat(4000) } })}\n`;
  const fh = fs.openSync(w.file("intake-archive.jsonl"), "a");
  try {
    // just past INTAKE_ARCHIVE_SCAN_BYTES (32 MiB), so the bound is reached, not merely approached
    for (let i = 0; i < 33; i += 1) fs.writeSync(fh, line.repeat(256));
  } finally {
    fs.closeSync(fh);
  }
  const unbounded = w.reg(["intake-event", ...w.capture(9, { "--received-at": at(9) })]);
  assert.equal(unbounded.status, 9, unbounded.stdout + unbounded.stderr);
  assert.equal(JSON.parse(unbounded.stdout).result, "intake_archive_unbounded");
  assert.equal(w.raw(), before, "fail closed: an unprovable capture is refused, not admitted");
});

test("R-KEEP an open or failed request survives prune at any age", { skip: SKIP }, () => {
  const { w } = pruneFixture("keep");
  const far = new Date(T0 + 400 * 24 * 3600_000).toISOString().slice(0, 19) + "Z";
  for (const seconds of ["1", "0", "86400"]) {
    assert.equal(w.reg(["intake-prune", "--older-than-seconds", seconds, "--now", far]).status, 0);
  }
  const left = w.list().requests;
  assert.deepEqual(left.map((r) => r.state).sort(), ["failed", "in_progress", "queued", "waiting"]);
  assert.equal(left.find((r) => r.state === "failed").failure.reason, "evidence_missing");
  // a superseded but OPEN row is not prunable either — because it is open, not because it is
  // superseded (R1: supersession is not a retention rule)
  const w2 = world("keep-superseded");
  captured(w2, 1, { "--received-at": at(1) });
  assert.equal(w2.reg(["intake-event", ...w2.capture(2, { "--kind": "amend",
    "--supersedes": uuid(1), "--received-at": at(2), "--now": at(2) })]).status, 0);
  assert.equal(w2.reg(["intake-prune", "--older-than-seconds", "1", "--now", far]).status, 0);
  assert.equal(w2.list().requests.length, 2, "supersession is not a close");
});

// R1 — the ir1166bcx counterexample: a CLOSED superseded row must not be kept forever
test("R-SUPERSEDE a closed superseded row is archived; supersession is not a retention rule",
  { skip: SKIP }, () => {
    const w = world("supersede-prune");
    const far = new Date(T0 + 400 * 24 * 3600_000).toISOString().slice(0, 19) + "Z";
    // capture A, amend B superseding A, cancel A, prune with cutoff 0
    captured(w, 1, { "--received-at": at(1) });
    assert.equal(w.reg(["intake-event", ...w.capture(2, { "--kind": "amend",
      "--supersedes": uuid(1), "--received-at": at(2), "--now": at(2) })]).status, 0);
    assert.equal(w.event("cancel", 1, { "--reason": "superseded, withdrawn",
      "--now": at(3) }).status, 0);
    assert.equal(w.row(uuid(1)).superseded_by, uuid(2));
    assert.equal(w.row(uuid(1)).state, "cancelled");
    const pruned = w.reg(["intake-prune", "--older-than-seconds", "0", "--now", far]);
    assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
    assert.equal(JSON.parse(pruned.stdout).archived, 1,
      "a cancelled row is finished work whether or not it was superseded");
    assert.deepEqual(w.list().requests.map((r) => r.ingress_id), [uuid(2)]);
    const line = archiveLines(w).at(-1);
    assert.equal(line.ingress_id, uuid(1));
    assert.equal(line.record.superseded_by, uuid(2), "the full row, supersession link included");
    // a COMPLETED superseded row likewise. Reachable order is amend THEN complete: `amend` is
    // not authorised from `completed`, so a completed row can never acquire a supersession later.
    const w2 = world("supersede-completed");
    captured(w2, 1, { "--received-at": at(1) });
    assert.equal(w2.reg(["intake-event", ...w2.capture(2, { "--kind": "amend",
      "--supersedes": uuid(1), "--received-at": at(2), "--now": at(2) })]).status, 0);
    assert.equal(w2.event("work-completed", 1, { "--verdict": "accepted", "--result-ref": "r",
      "--evidence-sha256": hex64(3), "--now": at(3) }).status, 0);
    const p2 = w2.reg(["intake-prune", "--older-than-seconds", "0", "--now", far]);
    assert.equal(p2.status, 0, p2.stdout + p2.stderr);
    assert.equal(JSON.parse(p2.stdout).archived, 1);
    assert.deepEqual(w2.list().requests.map((r) => r.ingress_id), [uuid(2)]);
    // archive-failure retention is unchanged for this class too: nothing is dropped unarchived
    const w3 = world("supersede-archive-fail");
    captured(w3, 1, { "--received-at": at(1) });
    assert.equal(w3.reg(["intake-event", ...w3.capture(2, { "--kind": "amend",
      "--supersedes": uuid(1), "--received-at": at(2), "--now": at(2) })]).status, 0);
    assert.equal(w3.event("cancel", 1, { "--reason": "withdrawn", "--now": at(3) }).status, 0);
    fs.mkdirSync(w3.file("intake-archive.jsonl"));
    const before = w3.raw();
    const failed = w3.reg(["intake-prune", "--older-than-seconds", "0", "--now", far]);
    assert.equal(failed.status, 9, failed.stdout + failed.stderr);
    assert.equal(JSON.parse(failed.stdout).result, "registry_write_failed");
    assert.equal(w3.raw(), before, "no row is dropped that is not durably archived");
    assert.equal(w3.list().requests.length, 2);
  });

// R2 — start clears the pause it resolves, in the same single transition
test("R-START start clears the pause it resolves, and a later pause is a new fact",
  { skip: SKIP }, () => {
    const w = world("start-clears-pause");
    captured(w, 1);
    assert.equal(w.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
      "--now": at(2) }).status, 0);
    assert.equal(w.event("pause", 1, { "--reason": "blocked on 1172", "--owner": "orchestrator",
      "--resume-condition": "1172 lands", "--depends-on": ["1172"], "--now": at(3) }).status, 0);
    const paused = w.row(uuid(1));
    assert.equal(paused.state, "waiting");
    assert.deepEqual(paused.depends_on, ["1172"]);
    const before = paused.history.length;
    assert.equal(w.event("start", 1, { "--now": at(4) }).status, 0);
    const started = w.row(uuid(1));
    assert.equal(started.state, "in_progress");
    assert.equal(started.work_state, "in_progress");
    assert.equal(started.pause, null, "start clears the pause it resolves");
    assert.deepEqual(started.depends_on, [], "and the dependencies it was waiting on");
    assert.equal(started.history.length, before + 1, "atomically, in ONE history transition");
    assert.equal(started.history.at(-1).event, "start");
    assert.equal(started.history.at(-1).from, "waiting");
    assert.equal(started.history.at(-1).to, "in_progress");
    // the row is pausable again, which it was not before this correction
    const again = w.event("pause", 1, { "--reason": "blocked on 1177", "--owner": "orchestrator",
      "--resume-condition": "1177 lands", "--depends-on": ["1177"], "--now": at(5) });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(w.row(uuid(1)).pause, { reason: "blocked on 1177", owner: "orchestrator",
      resume_condition: "1177 lands", resume_to: "in_progress" });
    assert.deepEqual(w.row(uuid(1)).depends_on, ["1177"]);
    // still set-once WHILE it holds: a second pause from `waiting` is refused, nothing written
    const held = w.raw();
    refused(w.event("pause", 1, { "--reason": "blocked on 1211", "--owner": "orchestrator",
      "--resume-condition": "1211 lands", "--now": at(6) }), "intake_transition_refused");
    assert.equal(w.raw(), held);
    // from queued the clear is a no-op, so start has one behaviour and not two
    const w2 = world("start-from-queued");
    captured(w2, 1);
    assert.equal(w2.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
      "--now": at(2) }).status, 0);
    assert.equal(w2.event("start", 1, { "--now": at(3) }).status, 0);
    assert.equal(w2.row(uuid(1)).pause, null);
    assert.deepEqual(w2.row(uuid(1)).depends_on, []);
    // and binding alone still neither starts work nor clears a pause
    const w3 = world("bind-does-not-start");
    captured(w3, 1);
    assert.equal(w3.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
      "--now": at(2) }).status, 0);
    assert.equal(w3.event("pause", 1, { "--reason": "dep", "--owner": "orchestrator",
      "--resume-condition": "c", "--now": at(3) }).status, 0);
    assert.equal(w3.event("bind", 1, { "--owning-task": "1177", "--dispatch-id": uuid(12),
      "--now": at(4) }).status, 0);
    assert.equal(w3.row(uuid(1)).state, "waiting", "bind does not start work");
    assert.notEqual(w3.row(uuid(1)).pause, null, "and does not clear a pause");
  });

// R4 — the archive line bound is enforced BEFORE the allocation
test("R-ARCHIVE-BOUND one oversized unterminated line is refused without being materialised",
  { skip: SKIP }, () => {
    const w = world("archive-line-bound");
    captured(w, 1);
    const before = w.raw();
    const MAX_LINE = 1024 * 1024;              // INTAKE_ARCHIVE_MAX_LINE
    // Observe the real registry's requested archive reads, not refusal as a proxy for allocation.
    // The one-byte lookahead is admitted; Python buffering/RSS and descendants are not measured.
    const observeArchiveReads = (fixture, returnedBytes) => {
      const witness = path.join(fixture.root, "archive-read-witness.json");
      const program = String.raw`
import builtins, json, runpy, sys
registry, archive, witness, limit = sys.argv[1:5]
limit = int(limit)
sys.argv = [registry, *sys.argv[5:]]
real_open = builtins.open
observed = {"opens": 0, "calls": []}
class ArchiveReads:
    def __init__(self, raw):
        self.raw = raw
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return self.raw.__exit__(*exc)
    def request(self, method, size):
        call = {"method": method, "requested": size}
        observed["calls"].append(call)
        if not isinstance(size, int) or size < 0 or size > limit:
            raise AssertionError("unbounded or oversized archive read request")
        data = getattr(self.raw, method)(size)
        call["returned"] = len(data)
        return data
    def readline(self, size=-1):
        return self.request("readline", size)
    def read(self, size=-1):
        return self.request("read", size)
    def __iter__(self):
        observed["calls"].append({"method": "iteration", "requested": -1})
        raise AssertionError("unbounded archive iteration")
def observed_open(file, mode="r", *args, **kwargs):
    raw = real_open(file, mode, *args, **kwargs)
    if file == archive and mode == "rb":
        observed["opens"] += 1
        return ArchiveReads(raw)
    return raw
builtins.open = observed_open
try:
    runpy.run_path(registry, run_name="__main__")
finally:
    builtins.open = real_open
    with real_open(witness, "x", encoding="utf-8") as fh:
        json.dump(observed, fh)
`;
      const rawBefore = fixture.raw();
      const observed = spawnSync("python3", ["-I", "-c", program, REGISTRY,
        fixture.file("intake-archive.jsonl"), witness, String(MAX_LINE + 1),
        "intake-event", ...fixture.capture(2)], {
        env: fixture.env, shell: false, encoding: "utf8", timeout: 10_000,
        killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      });
      assert.ifError(observed.error);
      assert.equal(observed.signal, null);
      assert.equal(observed.status, 9, observed.stdout + observed.stderr);
      assert.equal(JSON.parse(observed.stdout).result, "intake_archive_unbounded");
      assert.equal(observed.stderr.includes("Traceback"), false);
      const reads = JSON.parse(fs.readFileSync(witness, "utf8"));
      assert.equal(reads.opens, 1, "the actual archive read must be observed");
      assert.deepEqual(reads.calls,
        [{ method: "readline", requested: MAX_LINE + 1, returned: returnedBytes }],
        "one bounded real read, including the admitted lookahead byte");
      assert.equal(fixture.raw(), rawBefore, "instrumented refusal preserves the ledger");
    };
    // exactly MAX_LINE + 1 bytes, no newline anywhere: the bound must fire on the first read
    const fd = fs.openSync(w.file("intake-archive.jsonl"), "w", 0o600);
    try {
      fs.writeSync(fd, Buffer.alloc(MAX_LINE + 1, 0x78));
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.statSync(w.file("intake-archive.jsonl")).size, MAX_LINE + 1);
    const r = w.reg(["intake-event", ...w.capture(2)]);
    assert.equal(r.status, 9, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).result, "intake_archive_unbounded");
    assert.equal(r.stderr.includes("Traceback"), false, "a bound is a refusal, not a crash");
    assert.equal(w.raw(), before, "no admission and no write");
    assert.equal(w.list().requests.length, 1, "the capture was refused, not admitted");
    observeArchiveReads(w, MAX_LINE + 1);
    // a line exactly AT the bound is not over it: it is read, and found unparseable, which is
    // also a fail-closed refusal — the off-by-one is pinned in both directions
    const atBound = world("archive-line-at-bound");
    captured(atBound, 1);
    const fd2 = fs.openSync(atBound.file("intake-archive.jsonl"), "w", 0o600);
    try {
      fs.writeSync(fd2, Buffer.concat([Buffer.alloc(MAX_LINE - 1, 0x78), Buffer.from("\n")]));
    } finally {
      fs.closeSync(fd2);
    }
    const r2 = atBound.reg(["intake-event", ...atBound.capture(2)]);
    assert.equal(r2.status, 9, r2.stdout + r2.stderr);
    assert.equal(JSON.parse(r2.stdout).result, "intake_archive_unbounded");
    assert.equal(r2.stderr.includes("Traceback"), false);
    observeArchiveReads(atBound, MAX_LINE);
  });

test("R-ARCHIVE-BOUND a torn final line is still skipped and the scan still completes",
  { skip: SKIP }, () => {
    const { w, prune } = pruneFixture("archive-torn");
    assert.equal(prune().status, 0);
    assert.equal(archiveLines(w).length, 2);
    // append a torn line: a crash mid-append leaves no trailing newline
    fs.appendFileSync(w.file("intake-archive.jsonl"), '{"v":1,"ingress_id":"00000000-0000');
    // the scan must still complete, so the archived ids are still found and still refuse
    const replay = w.reg(["intake-event", ...w.capture(1, { "--received-at": at(1) })]);
    assert.equal(replay.status, 8, replay.stdout + replay.stderr);
    assert.equal(JSON.parse(replay.stdout).result, "intake_archived",
      "a torn tail does not blind the non-resurrection check");
    // and an EARLIER unparseable line still fails closed rather than being skipped
    const w2 = world("archive-bad-middle");
    captured(w2, 1);
    fs.writeFileSync(w2.file("intake-archive.jsonl"), "not json at all\n", { mode: 0o600 });
    const r = w2.reg(["intake-event", ...w2.capture(2)]);
    assert.equal(r.status, 9, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).result, "intake_archive_unbounded");
  });

// --- R-CORRUPT ----------------------------------------------------------------

test("R-CORRUPT a corrupt ledger fails closed with its bytes preserved", { skip: SKIP }, () => {
  // Build both rows through successful real captures before changing only the second ingress id.
  const valid = world("corrupt-duplicate-prerequisites");
  for (const n of [1, 2]) {
    const accepted = spawnSync(REGISTRY, ["intake-event", ...valid.capture(n)], {
      env: valid.env, shell: false, encoding: "utf8", timeout: 10_000,
      killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
    });
    assert.ifError(accepted.error);
    assert.equal(accepted.signal, null);
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout).result, "intake_written");
  }
  const duplicate = valid.doc();
  assert.deepEqual(duplicate.requests.map((r) => r.ingress_id), [uuid(1), uuid(2)]);
  duplicate.requests[1].ingress_id = duplicate.requests[0].ingress_id;
  const cases = [
    ["truncated", '{"schema_version":1,"generation":1,"requests":[{"ing'],
    ["root array", "[]"],
    ["wrong schema", '{"schema_version":2,"generation":1,"requests":[]}'],
    ["requests not an array", '{"schema_version":1,"generation":1,"requests":{}}'],
    ["generation not an int", '{"schema_version":1,"generation":"1","requests":[]}'],
    ["duplicate ingress id", JSON.stringify(duplicate)],
    ["row not an object", '{"schema_version":1,"generation":1,"requests":[3]}'],
  ];
  for (const [label, bytes] of cases) {
    const w = world(`corrupt-${label.replace(/\W+/g, "")}`);
    fs.writeFileSync(w.file("intake.json"), bytes, { mode: 0o600 });
    const read = w.reg(["intake-list"]);
    assert.equal(read.status, 9, `${label} read: ${read.stdout}${read.stderr}`);
    assert.equal(JSON.parse(read.stdout).result, "registry_corrupt", label);
    const write = w.reg(["intake-event", ...w.capture(1)]);
    assert.equal(write.status, 9, `${label} write: ${write.stdout}${write.stderr}`);
    if (label === "duplicate ingress id") {
      assert.match(JSON.parse(read.stdout).detail, /duplicate ingress_id/);
      assert.match(JSON.parse(write.stdout).detail, /duplicate ingress_id/);
    }
    assert.equal(w.raw(), bytes, `${label}: corrupt bytes are preserved, never repaired`);
    assert.ok(fs.readFileSync(w.file("registry-health.log"), "utf8").includes("registry_corrupt"),
      `${label}: the health line goes outside the corrupt file`);
    assert.deepEqual(w.names().filter((f) => f.includes(".tmp")), []);
  }
  // non-UTF-8 is a read refusal, not a decode crash
  const w = world("corrupt-utf8");
  fs.writeFileSync(w.file("intake.json"), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), { mode: 0o600 });
  const r = w.reg(["intake-list"]);
  assert.equal(r.status, 9, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).result, "registry_corrupt");
});

// --- R-LARGE ------------------------------------------------------------------

test("R-LARGE bounds refuse instead of truncating or dropping", { skip: SKIP }, () => {
  const w = world("large");
  captured(w, 1);
  const before = w.raw();
  // oversized free-text and reference fields
  refused(w.event("cancel", 1, { "--reason": "x".repeat(257), "--now": at(2) }),
    "intake_bounds_exceeded");
  refused(w.event("work-completed", 1, { "--verdict": "accepted",
    "--result-ref": "r".repeat(513), "--evidence-sha256": hex64(3), "--now": at(2) }),
    "intake_bounds_exceeded");
  refused(w.event("bind", 1, { "--owning-task": "t".repeat(129), "--dispatch-id": uuid(11),
    "--now": at(2) }), "intake_bounds_exceeded");
  refused(w.event("pause", 1, { "--reason": "r", "--owner": "o", "--resume-condition": "c",
    "--depends-on": Array.from({ length: 33 }, (_, i) => `d${i}`), "--now": at(2) }),
    "intake_bounds_exceeded");
  // malformed shapes are refusals too, never coerced
  refused(w.reg(["intake-event", ...w.capture(2, { "--sha256": "nothex" })]), "intake_malformed");
  refused(w.reg(["intake-event", ...w.capture(2, { "--byte-len": "-1" })]), "intake_malformed");
  refused(w.reg(["intake-event", ...w.capture(2, { "--byte-len": "1e9" })]), "intake_malformed");
  refused(w.reg(["intake-event", ...w.capture(2, { "--received-at": "yesterday" })]),
    "intake_malformed");
  refused(w.reg(["intake-event", ...w.capture(2, { "--ingress-id": "../../etc/passwd" })]),
    "intake_malformed");
  // A NUL byte cannot reach argv at all: Node refuses to spawn with one (ERR_INVALID_ARG_VALUE),
  // so the embedded-NUL refusal is asserted in the pure core (intake.test.ts) instead of here.
  assert.equal(w.raw(), before, "every bound refusal wrote nothing");
  // the row bound refuses the 4097th capture rather than evicting the oldest
  const doc = w.doc();
  const template = doc.requests[0];
  doc.requests = Array.from({ length: 4096 }, (_, i) => ({
    ...template, ingress_id: uuid(1000 + i), capture_id: uuid(5000 + i),
    received_at: at(1000 + i),
  }));
  fs.writeFileSync(w.file("intake.json"), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  const full = w.reg(["intake-event", ...w.capture(2)]);
  assert.equal(full.status, 4, full.stdout + full.stderr);
  assert.equal(JSON.parse(full.stdout).result, "intake_bounds_exceeded");
  assert.equal(w.doc().requests.length, 4096, "no silent eviction");
  // an existing row is still mutable when the ledger is full: cancellation must stay possible
  assert.equal(w.event("cancel", 1000, { "--reason": "urgent", "--now": at(2) }).status, 0);
});

test("R-LARGE a collection at its bound refuses to grow rather than evicting its audit trail",
  { skip: SKIP }, () => {
    const w = world("large-history");
    captured(w, 1);
    const doc = w.doc();
    const entry = { at: at(1), event: "bind", from: "queued", to: "queued" };
    // plant the row exactly at the history bound (256): the next append must refuse, because an
    // intake obligation must not lose its own history the way the report history rotates
    doc.requests[0].history = Array.from({ length: 256 }, () => ({ ...entry }));
    fs.writeFileSync(w.file("intake.json"), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    const before = w.raw();
    const r = w.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(11),
      "--now": at(2) });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).result, "intake_bounds_exceeded");
    assert.match(JSON.parse(r.stdout).detail, /history/);
    assert.equal(w.raw(), before, "the refusal wrote nothing");
    assert.equal(w.row(uuid(1)).history.length, 256, "nothing was evicted to make room");
    // the same for the binding collection, which is what a bind actually grows
    const doc2 = w.doc();
    doc2.requests[0].history = [{ ...entry }];
    doc2.requests[0].binding = Array.from({ length: 64 },
      () => ({ at: at(1), owning_task: "1166", dispatch_id: uuid(11) }));
    fs.writeFileSync(w.file("intake.json"), `${JSON.stringify(doc2, null, 2)}\n`, { mode: 0o600 });
    const r2 = w.event("bind", 1, { "--owning-task": "1166", "--dispatch-id": uuid(12),
      "--now": at(3) });
    assert.equal(r2.status, 4, r2.stdout + r2.stderr);
    assert.equal(JSON.parse(r2.stdout).result, "intake_bounds_exceeded");
    assert.equal(w.row(uuid(1)).binding.length, 64, "nothing was evicted to make room");
  });

// --- R-SQL / R-PATH -----------------------------------------------------------

test("R-SQL the shipped SQLite transition barrier covers every intake op, unchanged", { skip: SKIP }, () => {
  const w = world("sql");
  captured(w, 1);
  const before = w.raw();
  fs.writeFileSync(w.file("active.db"), "", { mode: 0o600 });
  for (const argv of [["intake-list"], ["intake-prune", "--older-than-seconds", "1"],
    ["intake-event", ...w.capture(2)]]) {
    const r = w.reg(argv);
    assert.equal(r.status, 9, `${argv[0]}: ${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).result, "registry_unavailable");
    assert.match(JSON.parse(r.stdout).detail, /SQLite transition artifact/);
  }
  assert.equal(w.raw(), before);
});

test("R-PATH no record field ever becomes a path", { skip: SKIP }, () => {
  const w = world("path");
  // ids that would be visible in the filesystem if any of them reached a path
  const id = "00000000-0000-4000-8000-0000deadbeef";
  captured(w, 1, { "--ingress-id": id });
  assert.equal(w.event("bind", 0, { "--ingress-id": id,
    "--owning-task": "1166", "--dispatch-id": uuid(11), "--now": at(2) }).status, 0);
  // close it and prune, so the archive is really created and really named
  assert.equal(w.event("cancel", 0, { "--ingress-id": id, "--reason": "withdrawn",
    "--now": at(3) }).status, 0);
  assert.equal(w.reg(["intake-prune", "--older-than-seconds", "1", "--now", at(999)]).status, 0);
  assert.deepEqual(w.names(), ["intake-archive.jsonl", "intake.json", "intake.json.lock"],
    "the archive exists under its fixed literal name");
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      found.push(entry.name);
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  };
  walk(w.root);
  assert.deepEqual(found.filter((n) => /deadbeef|[0-9a-f]{64}/.test(n)), [],
    "no ingress id, capture id or digest appears in any created name");
  assert.deepEqual(w.names(), ["intake-archive.jsonl", "intake.json", "intake.json.lock"],
    "the state directory holds nothing but the three fixed literals");
});

// --- R-DIFF -------------------------------------------------------------------

test("R-DIFF the real Python writer and the compiled pure core agree event for event",
  { skip: SKIP || (fs.existsSync(CORE) ? false : `compiled core absent: ${CORE}`) }, async () => {
    const core = await import(CORE);
    const w = world("diff");
    // one sequence through both implementations: accepted events, refusals and a replay
    const sequence = [
      { kind: "captured", n: 1, flags: {} },
      { kind: "captured", n: 2, flags: {} },
      { kind: "bind", n: 1, flags: { owning_task: "1166", dispatch_id: uuid(11) } },
      { kind: "start", n: 1, flags: {} },
      { kind: "start", n: 2, flags: {} },                                    // refused: unbound
      { kind: "pause", n: 1, flags: { reason: "dep", owner: "orch", resume_condition: "1172" } },
      { kind: "resume", n: 1, flags: {} },
      { kind: "answered", n: 1, flags: { verdict: "answered", scope: "u1" } },
      { kind: "work-completed", n: 1, flags: { verdict: "accepted" } },      // refused: no link
      { kind: "work-completed", n: 1,
        flags: { verdict: "accepted", result_ref: "r", evidence_sha256: hex64(3) } },
      { kind: "cancel", n: 1, flags: { reason: "too late" } },               // refused: terminal
      { kind: "captured", n: 3, flags: {} },
      { kind: "amend", n: 4, flags: { supersedes: uuid(3) } },               // 3 superseded, open
      { kind: "captured", n: 5, flags: {} },
      { kind: "amend", n: 6, flags: { supersedes: uuid(5) } },               // 5 superseded, open
      { kind: "cancel", n: 5, flags: { reason: "superseded, withdrawn" } },  // -> closed + superseded
      { kind: "amend", n: 7, flags: { supersedes: uuid(5) } },               // refused: terminal
      { kind: "cancel", n: 2, flags: { reason: "withdrawn" } },
      { kind: "captured", n: 2, flags: {} },                                 // replay
    ];
    const FLAG = (k) => `--${k.replace(/_/g, "-")}`;
    let doc = core.emptyIntakeDocument();
    const observed = [];
    const predicted = [];
    for (const [i, step] of sequence.entries()) {
      const now = at(100 + i);
      const immutable = {
        ingress_id: uuid(step.n), capture_id: uuid(900 + step.n), channel: "codex-native",
        upstream_namespace: "codex/session", upstream_id_status: "unavailable",
        upstream_delivery_id: null, upstream_scope_sha256: null,
        sha256: hex64(step.n), byte_len: 16 * step.n, received_at: at(step.n),
      };
      const argv = step.kind === "captured" || step.kind === "amend"
        ? ["intake-event", ...w.capture(step.n, { "--now": now, "--kind": step.kind,
          ...Object.fromEntries(Object.entries(step.flags).map(([k, v]) => [FLAG(k), String(v)])) })]
        : ["intake-event", "--kind", step.kind, "--ingress-id", uuid(step.n), "--now", now,
          ...Object.entries(step.flags).flatMap(([k, v]) => [FLAG(k), String(v)])];
      const r = w.reg(argv);
      observed.push({ kind: step.kind, n: step.n, status: r.status,
        result: JSON.parse(r.stdout).result });
      const outcome = core.applyIntakeEvent(doc, {
        kind: step.kind, at: now,
        ...(step.kind === "captured" || step.kind === "amend" ? immutable
          : { ingress_id: immutable.ingress_id }),
        ...step.flags,
      });
      predicted.push({ kind: step.kind, n: step.n, status: core.intakeExitCode(outcome),
        result: outcome.result });
      if (outcome.document) doc = outcome.document;
    }
    assert.deepEqual(observed, predicted, "the two implementations must not drift");
    // and the documents themselves, not merely the result codes
    assert.deepEqual(w.doc().requests, doc.requests);
    assert.deepEqual(core.derivePositions(doc).map((r) => [r.ingress_id, r.position]),
      w.list().requests.map((r) => [r.ingress_id, r.position]));
    assert.equal(core.INTAKE_ORDER_LABEL, w.list().order);
    assert.equal(core.INTAKE_SCHEMA_VERSION, w.doc().schema_version);

    // R1 (ir1166bcx): the differential must reach PRUNE, not stop at the event stream. The phase-1
    // version compared only events, which is exactly why the prune divergence survived authoring.
    // The fixture above deliberately holds all four classes: closed+superseded, closed+current,
    // open+superseded and open+current.
    const classes = w.list().requests.map((r) => ({
      id: r.ingress_id, state: r.state, superseded: r.superseded_by !== null }));
    assert.ok(classes.some((c) => ["completed", "cancelled"].includes(c.state) && c.superseded),
      "fixture must contain a closed superseded row, or R1 is not being tested");
    assert.ok(classes.some((c) => !["completed", "cancelled"].includes(c.state) && c.superseded),
      "fixture must contain an open superseded row");
    const far = new Date(T0 + 400 * 24 * 3600_000).toISOString().slice(0, 19) + "Z";
    const plan = core.prunePlan(doc, { now: far, olderThanSeconds: 0 });
    const pruned = w.reg(["intake-prune", "--older-than-seconds", "0", "--now", far]);
    assert.equal(pruned.status, 0, pruned.stdout + pruned.stderr);
    assert.equal(JSON.parse(pruned.stdout).archived, plan.archive.length,
      "the writer must archive exactly the rows the pure core plans to archive");
    assert.deepEqual(w.list().requests.map((r) => r.ingress_id).sort(),
      plan.keep.map((r) => r.ingress_id).sort(),
      "and keep exactly the rows the pure core plans to keep");
    assert.deepEqual(archiveLines(w).map((l) => l.ingress_id).sort(),
      plan.archive.map((r) => r.ingress_id).sort(),
      "the archive holds exactly the planned identities");
    // the archived rows are byte-equal to what the core held for them
    for (const line of archiveLines(w)) {
      assert.deepEqual(line.record, plan.archive.find((r) => r.ingress_id === line.ingress_id),
        `archived record for ${line.ingress_id} must match the pure core row`);
    }
    // a second prune is a no-op in both: nothing is left that is closed and aged
    const planAfter = core.prunePlan({ ...doc, requests: plan.keep },
      { now: far, olderThanSeconds: 0 });
    assert.deepEqual(planAfter.archive, []);
    const again = w.reg(["intake-prune", "--older-than-seconds", "0", "--now", far]);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(JSON.parse(again.stdout).archived, 0);
  });

// Appended notice controls. All new child calls use these tighter source bounds.
function noticeRun(w, argv) {
  const r = spawnSync(REGISTRY, argv, { env: w.env, encoding: "utf8", timeout: 10_000,
    killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.signal, null);
  return r;
}
function noticeArgv(e) {
  return ["intake-notice", ...Object.entries(e).flatMap(([k, v]) =>
    [`--${k === "at" ? "now" : k.replaceAll("_", "-")}`, v === null ? "none" : String(v)])];
}
async function noticeWorld(label) {
  const core = await import(CORE), w = world(label);
  const capturedResult = noticeRun(w, ["intake-event", ...w.capture(1)]);
  assert.equal(capturedResult.status, 0, capturedResult.stdout + capturedResult.stderr);
  let doc = w.doc();
  const claim = (attempt = 1) => ({ action: "claim", ingress_id: uuid(1),
    notice_id: core.intakeNoticeId(uuid(1)), attempt, claim: `claim_${attempt}`, owner: "owner_1",
    at: at(attempt * 10), previous_attempt: attempt - 1,
    previous_claim: attempt === 1 ? null : `claim_${attempt - 1}` });
  const fact = (action, attempt = 1, status = "sent") => ({ action, ingress_id: uuid(1),
    notice_id: core.intakeNoticeId(uuid(1)), attempt, claim: `claim_${attempt}`, owner: "owner_1",
    at: at(attempt * 10 + (action === "result" ? 1 : 2)), evidence_sha256: hex64(attempt),
    ...(action === "ack" ? {} : { status, retry_at: status === "not_sent" ? at(attempt * 10 + 3) : null }) });
  const step = (e, expected = "intake_written") => {
    // Capture BEFORE either path; refusal must preserve exact bytes AND generation.
    const rawBefore = w.raw(), generationBefore = w.doc().generation, pureBefore = JSON.stringify(doc);
    const pure = core.applyIntakeNotice(doc, e);
    assert.equal(JSON.stringify(doc), pureBefore);
    const r = noticeRun(w, noticeArgv(e)), actual = JSON.parse(r.stdout);
    assert.equal(pure.result, expected, pure.detail);
    assert.equal(actual.result, expected, r.stdout + r.stderr);
    assert.equal(r.status, core.intakeExitCode(pure));
    assert.equal(actual.completion_fact, null);
    if (expected === "intake_written") {
      const { notice: beforeNotice, ...beforeRow } = doc.requests[0];
      const { notice: afterNotice, ...afterRow } = pure.document.requests[0];
      assert.deepEqual(afterRow, beforeRow);
      assert.deepEqual(afterNotice.events.slice(0, -1), beforeNotice?.events ?? []);
      doc = { ...pure.document, generation: generationBefore + 1 };
      assert.deepEqual(w.doc(), doc);
    } else {
      assert.equal(pure.document, null);
      assert.equal(w.raw(), rawBefore);
      assert.equal(w.doc().generation, generationBefore);
    }
    assert.equal(w.exists("active.json"), false);
    assert.equal(w.exists("active.json.lock"), false);
  };
  const lifecycle = e => {
    const pure = core.applyIntakeEvent(doc, e);
    assert.equal(pure.result, "intake_written", pure.detail);
    const argv = ["intake-event", ...Object.entries(e).flatMap(([k, v]) =>
      [`--${k === "at" ? "now" : k.replaceAll("_", "-")}`, String(v)])];
    const r = noticeRun(w, argv); assert.equal(r.status, 0, r.stdout + r.stderr);
    doc = { ...pure.document, generation: doc.generation + 1 }; assert.deepEqual(w.doc(), doc);
  };
  return { w, core, claim, fact, step, lifecycle,
    setDoc: value => { doc = value; fs.writeFileSync(w.file("intake.json"), JSON.stringify(value)); },
    getDoc: () => doc };
}

test("R-NOTICE-DIFF durable claims, uncertainty, measured retry, exact results and ACK separation",
  { skip: SKIP }, async () => {
    const n = await noticeWorld("notice-diff"), { claim, fact, step } = n;
    step({ ...claim(), claim: "none" }, "intake_malformed");
    step({ ...claim(), claim: "claim\n" }, "intake_malformed");
    step({ ...claim(), notice_id: hex64(9) }, "intake_identity_collision");
    step(claim()); step(claim(), "intake_notice_replay");
    step({ ...claim(), claim: "contender", owner: "other" }, "intake_notice_race");
    step({ ...claim(2), at: at(10000) }, "intake_transition_refused");
    step({ ...fact("result"), owner: "other" }, "intake_transition_refused");
    step(fact("ack"), "intake_transition_refused");
    step(fact("result", 1, "unknown"));
    step({ ...claim(2), at: at(10000) }, "intake_transition_refused");
    step(fact("result", 1, "not_sent"), "intake_transition_refused");
    step(fact("resolve", 1, "not_sent"));
    step({ ...claim(2), at: at(12) }, "intake_transition_refused");
    // Valid non-sentinel token survives serialization and predecessor round-trip.
    step(claim(2));
    assert.equal(n.getDoc().requests[0].notice.events.at(-1).previous_claim, "claim_1");
    step(fact("result", 1), "intake_transition_refused");
    step(fact("result", 2)); step(claim(3), "intake_transition_refused");
    step(fact("ack", 2)); step(fact("ack", 2), "intake_notice_replay");
    step({ ...fact("ack", 2), evidence_sha256: hex64(9) }, "intake_transition_refused");
    assert.equal(n.getDoc().requests[0].answered_at, null);
    assert.equal(n.getDoc().requests[0].state, "queued");
    for (const extra of [["--claim", "duplicate"], ["--path", "/tmp"], ["--previous-attempt", "01"]]) {
      const rawBefore = n.w.raw(), generationBefore = n.w.doc().generation;
      const argv = noticeArgv(claim());
      if (extra[0] === "--previous-attempt") {
        assert.equal(argv.filter(value => value === "--previous-attempt").length, 1);
        argv[argv.indexOf("--previous-attempt") + 1] = extra[1];
      } else argv.push(...extra);
      const r = noticeRun(n.w, argv);
      if (extra[0] === "--previous-attempt") {
        assert.equal(argv.filter(value => value === "--previous-attempt").length, 1);
        assert.equal(JSON.parse(r.stdout).result, "intake_malformed");
      }
      assert.equal(r.status, 4); assert.equal(n.w.raw(), rawBefore);
      assert.equal(n.w.doc().generation, generationBefore);
    }
  });

test("R-NOTICE-RACE actual lifecycle eligibility, late outcomes, archived and missing refusal",
  { skip: SKIP }, async () => {
    for (const kind of ["pause", "cancel"]) {
      const n = await noticeWorld(`notice-${kind}`);
      n.step(n.claim());
      n.lifecycle({ kind, ingress_id: uuid(1), at: at(11), reason: "blocked",
        ...(kind === "pause" ? { owner: "owner", resume_condition: "review" } : {}) });
      n.step(n.fact("result")); n.step(n.fact("ack"));
      const fresh = await noticeWorld(`notice-ineligible-${kind}`);
      fresh.lifecycle({ kind, ingress_id: uuid(1), at: at(2), reason: "blocked",
        ...(kind === "pause" ? { owner: "owner", resume_condition: "review" } : {}) });
      fresh.step(fresh.claim(), "intake_transition_refused");
      if (kind === "cancel") {
        const before = n.getDoc().requests[0];
        const r = noticeRun(n.w, ["intake-prune", "--older-than-seconds", "0", "--now", at(10000)]);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual(JSON.parse(fs.readFileSync(n.w.file("intake-archive.jsonl"), "utf8").trim()).record, before);
        n.setDoc(n.w.doc());
        n.step(n.claim(), "intake_not_found"); n.step(n.fact("ack"), "intake_not_found");
      }
      n.step({ ...n.claim(), ingress_id: uuid(99), notice_id: n.core.intakeNoticeId(uuid(99)) }, "intake_not_found");
    }
  });

test("R-NOTICE-VALIDATION strict fields, legacy unknown, malformed persisted logs, bounded history",
  { skip: SKIP }, async () => {
    const n = await noticeWorld("notice-validation");
    for (const over of [{ at: "2026-02-30T00:00:00Z" }, { claim: "none" },
      { attempt: 1.5 }, { owner: "../path" }]) {
      n.step({ ...n.claim(), ...over }, "intake_malformed");
    }
    const legacy = structuredClone(n.getDoc());
    legacy.requests[0].notice = { claim: "none", owner: "legacy", at: "legacy" };
    n.setDoc(legacy); n.step(n.claim(), "intake_transition_refused");
    legacy.requests[0].notice = null; n.setDoc(legacy);
    n.step(n.claim());
    const valid = structuredClone(n.getDoc()), notice = valid.requests[0].notice;
    for (const bad of [{ ...notice, version: true }, { ...notice, generation: 2 },
      { ...notice, notice_id: hex64(9) }, { ...notice, path: "/tmp" },
      { ...notice, events: Array(65).fill(n.claim()) },
      { ...notice, events: [{ ...n.claim(), attempt: true }] },
      { ...notice, events: [{ ...n.claim(), claim: "none" }] },
      { ...notice, events: [{ ...n.claim(), at: "2026-02-30T00:00:00Z" }] }]) {
      const broken = structuredClone(valid); broken.requests[0].notice = bad;
      n.setDoc(broken); n.step(n.fact("result"), "registry_corrupt");
    }
    n.setDoc(valid);
    for (const over of [{ evidence_sha256: "oops" }, { retry_at: at(1) }, { command: "run" }]) {
      if ("command" in over) {
        const before = n.w.raw(), generationBefore = n.w.doc().generation;
        const r = noticeRun(n.w, noticeArgv({ ...n.fact("result"), ...over }));
        assert.equal(r.status, 4); assert.equal(n.w.raw(), before);
        assert.equal(n.w.doc().generation, generationBefore);
      } else n.step({ ...n.fact("result"), ...over }, "intake_malformed");
    }
    for (let attempt = 1; attempt <= 16; attempt++) {
      if (attempt > 1) n.step(n.claim(attempt));
      n.step(n.fact("result", attempt, "not_sent"));
    }
    n.step(n.claim(17), "intake_bounds_exceeded");
    assert.equal(n.getDoc().requests[0].notice.events.length, 32);
  });

// All children below share a single absolute deadline per invocation, including
// readiness, release and cleanup. No timer extends the child's ten-second budget.
function noticeChild(w, argv, observe = false) {
  const deadline = Date.now() + 10_000;
  const env = { PATH: w.env.PATH, HOME: w.env.HOME, TMPDIR: w.root,
    DISPATCH_STATE_DIR: w.stateDir, PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1" };
  const lock = observe ? fs.lstatSync(w.file("intake.json.lock")) : null;
  if (lock) assert.ok(lock.isFile());
  // Observer parameters: script, lock path, device, inode, then original CLI argv.
  const args = observe ? ["-I", "-B", "-c", NOTICE_FLOCK_OBSERVER, REGISTRY,
    w.file("intake.json.lock"), String(lock.dev), String(lock.ino), ...argv] : argv;
  const child = spawn(observe ? "python3" : REGISTRY, args,
    { cwd: w.root, env, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const chunks = [[], [], []], sizes = [0, 0, 0], eof = [false, false, false];
  let exited = false, closed = false, status = null, signal = null, failure = null;
  let ready = false, released = false, stdinFinished = false;
  let resolveDone, rejectDone, resolveReady, rejectReady;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const readiness = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Register rejection handlers immediately; callers still receive original failures.
  done.catch(() => {}); readiness.catch(() => {});
  const stop = error => {
    failure ??= error;
    rejectReady(failure);
    if (!exited && !closed && !child.kill("SIGKILL")) {
      failure = new AggregateError([failure, Error("owned child kill failed")]);
    }
  };
  const timer = setTimeout(() => {
    stop(Error("notice child absolute deadline expired"));
    rejectDone(failure);
  }, Math.max(0, deadline - Date.now()));
  child.on("error", stop);
  child.stdin.on("error", stop);
  child.stdin.on("finish", () => { stdinFinished = true; });
  for (const [i, stream] of [child.stdout, child.stderr, child.stdio[3]].entries()) {
    stream.on("error", stop);
    stream.on("end", () => { eof[i] = true; });
    stream.on("data", chunk => {
      sizes[i] += chunk.length;
      if (sizes[i] > 1024 * 1024) { stop(Error(`notice stream ${i} overflow`)); return; }
      chunks[i].push(chunk);
      if (i === 2) {
        const message = Buffer.concat(chunks[2]).toString("utf8");
        if (message === "ready\n" && !ready) { ready = true; resolveReady(); }
        else if (!"ready\n".startsWith(message)) stop(Error("invalid observer handshake"));
      }
    });
  }
  child.on("exit", (code, sig) => { exited = true; status = code; signal = sig; });
  child.on("close", (code, sig) => {
    closed = true; clearTimeout(timer);
    if (!exited || code !== status || sig !== signal || signal !== null ||
        !eof.every(Boolean) || !stdinFinished || (observe && (!ready || !released))) {
      failure ??= Error(`incomplete child closure: ${JSON.stringify({ exited, code, sig, eof,
        stdinFinished, ready, released })}`);
    }
    if (!ready) rejectReady(failure ?? Error("closed before readiness"));
    if (failure) rejectDone(failure);
    else resolveDone({ status, signal, stdout: Buffer.concat(chunks[0]).toString("utf8"),
      stderr: Buffer.concat(chunks[1]).toString("utf8") });
  });
  if (!observe) child.stdin.end();
  return { done, readiness,
    release() {
      assert.ok(observe && ready && !released && !exited && !closed);
      assert.ok(Date.now() < deadline, "release within absolute deadline");
      released = true; child.stdin.end("release\n");
    },
    async cleanup() {
      if (!closed) stop(Error("unfinished owned child during cleanup"));
      await done; // Errors, including cleanup and deadline errors, remain failures.
    } };
}

// Standard library only. No result/reducer/writer substitution. The actual flock
// is called with the exact original arguments after one owned-pipe rendezvous.
const NOTICE_FLOCK_OBSERVER = String.raw`
import fcntl, os, runpy, select, stat, sys, time
script, lock_path, device, inode = sys.argv[1:5]
original_argv = sys.argv[5:]
expected = (int(device), int(inode))
lock_stat = os.lstat(lock_path)
if not stat.S_ISREG(lock_stat.st_mode) or (lock_stat.st_dev, lock_stat.st_ino) != expected:
    raise RuntimeError("owned lock identity mismatch")
original_flock = fcntl.flock
observed = False
deadline = time.monotonic() + 10.0
def observer(handle, flags):
    global observed
    fd = handle if isinstance(handle, int) else handle.fileno()
    current = os.fstat(fd)
    if (current.st_dev, current.st_ino) == expected and flags == (fcntl.LOCK_EX | fcntl.LOCK_NB) and not observed:
        observed = True
        if os.write(3, b"ready\n") != 6:
            raise RuntimeError("short readiness write")
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([0], [], [], remaining)[0]:
            raise RuntimeError("release deadline")
        if os.read(0, 8) != b"release\n":
            raise RuntimeError("invalid release or EOF")
    return original_flock(handle, flags)
fcntl.flock = observer
sys.argv = [script] + original_argv
try:
    runpy.run_path(script, run_name="__main__")
finally:
    fcntl.flock = original_flock
    os.close(3)
    if not observed:
        raise RuntimeError("claim never reached owned exclusive lock")
`;

async function boundedNoticeRun(w, argv) {
  const child = noticeChild(w, argv);
  try { return await child.done; } finally { await child.cleanup(); }
}

async function capturedNoticeFixture(label) {
  const w = world(label);
  const result = await boundedNoticeRun(w, ["intake-event", ...w.capture(1)]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).result, "intake_written");
  const doc = w.doc(), row = doc.requests[0];
  assert.equal(doc.requests.length, 1);
  assert.equal(row.ingress_id, uuid(1));
  assert.equal(row.state, "queued"); assert.equal(row.work_state, "unstarted");
  assert.equal(row.notice, null);
  for (const key of ["pause", "superseded_by", "result", "failure"]) assert.equal(row[key], null);
  const core = await import(CORE);
  const claim = { action: "claim", ingress_id: uuid(1), notice_id: core.intakeNoticeId(uuid(1)),
    attempt: 1, previous_attempt: 0, previous_claim: null, claim: "claim_A", owner: "owner_A", at: at(10) };
  return { w, doc, claim };
}

for (const missing of ["pause", "superseded_by", "result", "failure"]) {
  test(`R-NOTICE-MISSING-${missing} actual writer refuses absent eligibility fact`,
    { skip: SKIP }, async () => {
      const { w, doc, claim } = await capturedNoticeFixture(`notice-missing-${missing}`);
      const original = structuredClone(doc);
      const capturedRaw = w.raw(), removedLine = `      "${missing}": null,\n`;
      assert.equal(capturedRaw.split(removedLine).length, 2, "exactly one owned null field");
      delete doc.requests[0][missing];
      assert.equal(Object.hasOwn(doc.requests[0], missing), false);
      assert.deepEqual({ ...doc.requests[0], [missing]: null }, original.requests[0]);
      const corruptedRaw = capturedRaw.replace(removedLine, "");
      assert.deepEqual(JSON.parse(corruptedRaw), doc);
      fs.writeFileSync(w.file("intake.json"), corruptedRaw);
      const before = w.raw(), generation = w.doc().generation, rowBefore = structuredClone(doc.requests[0]);
      const r = await boundedNoticeRun(w, noticeArgv(claim));
      assert.equal(r.status, 4, `${missing}: ${r.stdout}${r.stderr}`);
      assert.equal(JSON.parse(r.stdout).result, "intake_transition_refused");
      assert.equal(w.raw(), before); assert.equal(w.doc().generation, generation);
      assert.deepEqual(w.doc().requests[0], rowBefore); assert.equal(w.doc().requests[0].notice, null);
    });
}

test("R-NOTICE-CONTEND two real first claimants commit exactly one immutable winner",
  { skip: SKIP }, async () => {
    const { w, doc, claim } = await capturedNoticeFixture("notice-contend");
    const other = { ...claim, claim: "claim_B", owner: "owner_B" };
    const before = w.raw(), generation = doc.generation;
    const children = [noticeChild(w, noticeArgv(claim), true), noticeChild(w, noticeArgv(other), true)];
    try {
      await Promise.all(children.map(c => c.readiness));
      assert.equal(w.raw(), before, "both real processes parked before original flock");
      for (const child of children) child.release();
      const results = await Promise.all(children.map(c => c.done));
      assert.deepEqual(results.map(r => r.status).sort(), [0, 8]);
      assert.deepEqual(results.map(r => JSON.parse(r.stdout).result).sort(),
        ["intake_notice_race", "intake_written"]);
      const winner = results[0].status === 0 ? claim : other;
      const loser = results[0].status === 0 ? other : claim;
      const after = w.doc(), { notice, ...ordinary } = after.requests[0];
      const { notice: priorNotice, ...priorOrdinary } = doc.requests[0];
      assert.equal(priorNotice, null); assert.deepEqual(ordinary, priorOrdinary);
      assert.equal(after.generation, generation + 1);
      assert.deepEqual(notice.events, [winner]);
      const committed = w.raw();
      const refused = await boundedNoticeRun(w, noticeArgv(loser));
      assert.equal(refused.status, 8); assert.equal(JSON.parse(refused.stdout).result, "intake_notice_race");
      assert.equal(w.raw(), committed); assert.deepEqual(w.doc(), after);
    } finally {
      const cleanup = await Promise.allSettled(children.map(c => c.cleanup()));
      const errors = cleanup.filter(r => r.status === "rejected").map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, "claimant cleanup failed");
    }
  });

for (const kind of ["pause", "cancel"]) {
  test(`R-NOTICE-LATE-${kind} ordinary commit precedes actual claim lock acquisition`,
    { skip: SKIP }, async () => {
      const { w, doc, claim } = await capturedNoticeFixture(`notice-late-${kind}`);
      const before = w.raw();
      const child = noticeChild(w, noticeArgv(claim), true);
      try {
        await child.readiness;
        assert.equal(w.raw(), before);
        const argv = ["intake-event", "--kind", kind, "--ingress-id", uuid(1),
          "--now", at(2), "--reason", "blocked",
          ...(kind === "pause" ? ["--owner", "owner", "--resume-condition", "review"] : [])];
        const lifecycle = await boundedNoticeRun(w, argv);
        assert.equal(lifecycle.status, 0, lifecycle.stdout + lifecycle.stderr);
        assert.equal(JSON.parse(lifecycle.stdout).result, "intake_written");
        const post = w.doc(), rawPost = w.raw();
        assert.equal(post.generation, doc.generation + 1);
        assert.equal(post.requests[0].state, kind === "pause" ? "waiting" : "cancelled");
        assert.equal(post.requests[0].notice, null);
        if (kind === "pause") assert.equal(post.requests[0].pause.reason, "blocked");
        child.release();
        const result = await child.done;
        assert.equal(result.status, 4, result.stdout + result.stderr);
        assert.equal(JSON.parse(result.stdout).result, "intake_transition_refused");
        assert.equal(w.raw(), rawPost); assert.deepEqual(w.doc(), post);
        assert.equal(w.doc().generation, post.generation);
      } finally { await child.cleanup(); }
    });
}
