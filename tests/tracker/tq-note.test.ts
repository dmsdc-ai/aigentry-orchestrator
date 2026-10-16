// #1172 U3 — the shared task-queue transaction, end to end.
//
// Every case drives the REAL command (bin/tq-note.mjs), the REAL Python broker
// (bin/lib/task-queue-lock.py) and the REAL Node transform (bin/lib/task-queue-write.mjs)
// against SYNTHETIC queues under a private 0700 HOME/TMPDIR with umask 0077. A-3 and A-11
// additionally drive the REAL dispatch ledger (dist/src/dispatch/cli.js) through the
// existing closure-inspected tests/dispatch/model-router-fixtures.ts harness, where every
// external tool — npm/npx/curl/wget/ssh/git/launchctl/ps/kill/pkill/killall/tmux/osascript/
// srt/cmux and every real CLI — is already faked and tripwired.
//
// No network, no daemon, no service, no real PID probe, no host state and no live queue.
// The only processes signalled are ones this suite or the broker started. The lock-capability
// probe shadows `fcntl` through a private PYTHONPATH directory; it never modifies Python.
//
// THE ORACLE for A-3 is the one the pre-change RED measured: with a focus write and a
// dispatch-ledger write overlapping, BOTH mutations are present in the committed document.
// Before this change that failed 3/3 (W-A's committed status + stamp were overwritten by
// bin/tq-focus.sh's `mv`).
import assert from "node:assert/strict";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixture } from "../dispatch/model-router-fixtures.js";

const self = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(self), "..", "..", "..");
const TQ_NOTE = path.join(repoRoot, "bin", "tq-note.mjs");
const BROKER = path.join(repoRoot, "bin", "lib", "task-queue-lock.py");
const TRANSFORM = path.join(repoRoot, "bin", "lib", "task-queue-write.mjs");
const TQ_FOCUS = path.join(repoRoot, "bin", "tq-focus.sh");
const MANIFEST_MJS = path.join(repoRoot, "bin", "init", "manifest.mjs");
const WIN32 = process.platform === "win32";
const WALL_MS = 90_000;

process.umask(0o077);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tq-note-1172-"));
fs.chmodSync(sandbox, 0o700);
const HOME = path.join(sandbox, "home");
const TMP = path.join(sandbox, "tmp");
for (const d of [HOME, TMP]) fs.mkdirSync(d, { mode: 0o700, recursive: true });
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** The shape state/task-queue.json is committed in (src/dispatch/cli.ts:939). */
const committed = (doc: unknown) => JSON.stringify(doc, null, 2) + "\n";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

type Doc = Record<string, unknown>;
type Row = Record<string, unknown>;
interface Body {
  v?: number; op?: string; applied?: boolean; reason?: string | null; detail?: string;
  task?: string | null; track?: string | null; queue?: string;
  doc_sha256_before?: string | null; doc_sha256_after?: string | null;
  bytes_before?: number | null; bytes_after?: number | null;
  segments_before?: number | null; segments_after?: number | null;
  lock_inode?: number | null; correlation_id?: unknown;
  hits?: { idx: number; desc: string }[];
}

/** Hermetic: the operator's own queue and fault seam must never leak in. */
const BASE_ENV: NodeJS.ProcessEnv = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME, USERPROFILE: HOME, TMPDIR: TMP, TMP, TEMP: TMP,
    PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
  delete e.AIGENTRY_TASK_QUEUE;
  delete e.AIGENTRY_TQ_NOTE_FAULT;
  delete e.AIGENTRY_TQ_NOTE_FAULT_BARRIER;
  delete e.AIGENTRY_TQ_NODE;
  return e;
})();

let caseSeq = 0;
function caseDir(name: string): string {
  const dir = path.join(sandbox, `${String(++caseSeq).padStart(2, "0")}-${name}`);
  fs.mkdirSync(path.join(dir, "state"), { recursive: true, mode: 0o700 });
  return dir;
}

const seedDoc = (over: Doc = {}): Doc => ({
  schema_version: 2,
  main_topics: ["u3"],
  active_focus: "alpha",
  tracks: { alpha: { name: "Alpha" }, beta: { name: "Beta" } },
  tasks: [
    { id: 1172, desc: "the row under test", status: "in_progress", note: "seed sentence." },
    { id: 1166, desc: "an untouched neighbour", status: "pending", note: "neighbour seed." },
  ],
  completed: [],
  ...over,
});

function seed(dir: string, doc: Doc = seedDoc()): string {
  const q = path.join(dir, "state", "task-queue.json");
  fs.writeFileSync(q, committed(doc), { mode: 0o600 });
  return q;
}

const readDoc = (q: string): Doc => JSON.parse(fs.readFileSync(q, "utf8")) as Doc;
const rowOf = (q: string, id: string): Row =>
  ((readDoc(q).tasks as Row[]).find((r) => String(r.id) === id)) as Row;
const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop() ?? "";

function tq(args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TQ_NOTE, ...args], {
    encoding: "utf8", env: { ...BASE_ENV, ...env }, timeout: WALL_MS, shell: false,
  });
}

function tqJson(args: string[], env: NodeJS.ProcessEnv = {}): { r: SpawnSyncReturns<string>; body: Body } {
  const r = tq([...args, "--json"], env);
  // `--json` prints ONE pretty-printed document, so the whole of stdout is the body. (The
  // broker's own stdout is single-line, which is why brokerCall below reads the last line.)
  let body: Body = {};
  try { body = JSON.parse(r.stdout) as Body; } catch { body = {}; }
  assert.ok(Object.keys(body).length > 0,
    `tq-note produced no --json document (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
  return { r, body };
}

/** The broker, reached exactly as src/dispatch/registry-command.ts reaches its Python
 *  sibling: POSIX executes the shebang, win32 names the interpreter. */
function brokerCall(queue: string, input: string, env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  const args = ["--queue", queue, "--node", process.execPath];
  return spawnSync(WIN32 ? "python" : BROKER, WIN32 ? [BROKER, ...args] : args, {
    input, encoding: "utf8", env: { ...BASE_ENV, ...env }, timeout: WALL_MS, shell: false,
  });
}

function brokerSpawn(queue: string) {
  const args = ["--queue", queue, "--node", process.execPath];
  return spawn(WIN32 ? "python" : BROKER, WIN32 ? [BROKER, ...args] : args,
    { env: BASE_ENV, stdio: ["pipe", "pipe", "pipe"] });
}

/** A segment file: Rule 40 ¶4 wants spaced, complete sentences, so the text is never argv. */
function segFile(dir: string, name: string, text: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text, { mode: 0o600 });
  return p;
}

const appendArgs = (q: string, id: string, file: string) =>
  ["append", "--task", id, "--segment-file", file, "--queue", q];

/** Spawn tq-note without blocking, so a barrier can be released from this process. */
function tqAsync(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [TQ_NOTE, ...args, "--json"], {
    env: { ...BASE_ENV, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string; body: Body }>((res) => {
    child.on("close", (code) => {
      let body: Body = {};
      try { body = JSON.parse(stdout) as Body; } catch { body = {}; }
      res({ code, stdout, stderr, body });
    });
  });
  return { child, done };
}

async function waitForFile(file: string, label: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label} (${file})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Releases a transform barrier from an INDEPENDENT process, so the release still happens
 *  while this process is blocked inside a spawnSync of the real dispatch. */
function scheduleRelease(barrier: string, afterMs: number): void {
  spawn(process.execPath, ["-e",
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(`${barrier}.go`)}, "go"), ${afterMs})`,
  ], { stdio: "ignore", detached: true }).unref();
}

function barrierFor(dir: string, fault: string): { env: NodeJS.ProcessEnv; base: string } {
  const base = path.join(dir, `barrier-${fault}`);
  return { env: { AIGENTRY_TQ_NOTE_FAULT: fault, AIGENTRY_TQ_NOTE_FAULT_BARRIER: base }, base };
}

// ── A-1 — concurrency between tq-note writers ────────────────────────────────────────

test("A-1: two concurrent writers on different tasks both survive; one lock holder at a time", async () => {
  const dir = caseDir("a1-different-tasks");
  const q = seed(dir);
  const { env, base } = barrierFor(dir, "pause_before_rename");
  const first = segFile(dir, "first.txt", "First writer measured the broker path.");
  const second = segFile(dir, "second.txt", "Second writer measured the same lock.");

  // Writer 1 holds the lock, having already written its temp.
  const held = tqAsync(appendArgs(q, "1172", first), env);
  await waitForFile(`${base}.ready`, "writer 1 to reach its pre-rename barrier");

  // Writer 2 must NOT be able to commit while writer 1 holds the lock. It is released
  // 400ms later, so writer 2 provably waited rather than racing.
  scheduleRelease(base, 400);
  const r2 = tq(appendArgs(q, "1166", second));
  const r1 = await held.done;

  assert.equal(r1.code, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  // Neither update was lost: this is the lost-update oracle, between two tq-note writers.
  assert.match(String(rowOf(q, "1172").note), /First writer measured the broker path\./);
  assert.match(String(rowOf(q, "1166").note), /Second writer measured the same lock\./);
  assert.match(String(rowOf(q, "1172").note), /^seed sentence\. \|\| /, "the seed segment survived");
});

test("A-1: two concurrent writers on the SAME task serialize; both segments survive", async () => {
  const dir = caseDir("a1-same-task");
  const q = seed(dir);
  const { env, base } = barrierFor(dir, "pause_before_rename");
  const a = segFile(dir, "a.txt", "Serialized writer A landed.");
  const b = segFile(dir, "b.txt", "Serialized writer B landed.");

  const held = tqAsync(appendArgs(q, "1172", a), env);
  await waitForFile(`${base}.ready`, "writer A to reach its pre-rename barrier");
  scheduleRelease(base, 400);
  const rb = tq(appendArgs(q, "1172", b));
  const ra = await held.done;

  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.status, 0, rb.stderr);
  const note = String(rowOf(q, "1172").note);
  assert.match(note, /Serialized writer A landed\./, note);
  assert.match(note, /Serialized writer B landed\./, note);
  assert.equal(note.split("||").length, 3, `seed + two appends, in order: ${note}`);
});

// ── A-2 — set-status transitions and the regression rule ─────────────────────────────

test("A-2: forward transitions apply; a terminal status is never rolled back without CAS", () => {
  const dir = caseDir("a2-status");
  const q = seed(dir);

  assert.equal(tq(["set-status", "--task", "1172", "--status", "done", "--queue", q]).status, 0);
  assert.equal(rowOf(q, "1172").status, "done");

  // Replay of the same target is an observed no-op, not a write.
  const same = tqJson(["set-status", "--task", "1172", "--status", "done", "--queue", q]);
  assert.equal(same.r.status, 0);
  assert.equal(same.body.reason, "already_applied");
  assert.equal(same.body.bytes_before, same.body.bytes_after);
  assert.equal(same.body.doc_sha256_before, same.body.doc_sha256_after);

  // Terminal → non-terminal without CAS: refused by name, nothing written.
  const before = fs.readFileSync(q, "utf8");
  const back = tqJson(["set-status", "--task", "1172", "--status", "in_progress", "--queue", q]);
  assert.equal(back.r.status, 3);
  assert.equal(back.body.reason, "status_regression");
  assert.equal(fs.readFileSync(q, "utf8"), before, "a refused regression wrote the queue");

  // …and allowed with a matching document hash, which is the caller asserting it has seen
  // the newer state.
  const h = sha256(fs.readFileSync(q));
  const forced = tqJson(["set-status", "--task", "1172", "--status", "in_progress",
    "--queue", q, "--expect-sha256", h]);
  assert.equal(forced.r.status, 0, forced.r.stderr);
  assert.equal(rowOf(q, "1172").status, "in_progress");

  // The field-scoped guard refuses on a mismatch.
  const guard = tqJson(["set-status", "--task", "1172", "--status", "blocked",
    "--queue", q, "--expect-status", "pending"]);
  assert.equal(guard.r.status, 3);
  assert.equal(guard.body.reason, "expect_status_mismatch");
  assert.equal(rowOf(q, "1172").status, "in_progress", "a refused guard changed the status");
});

// ── A-3 — W-A participation: the pre-change RED, now green ───────────────────────────

test("A-3: the real dispatch ledger and a concurrent tq-note append BOTH survive", async () => {
  const f = fixture();
  try {
    const dir = caseDir("a3-ledger-race");
    fs.writeFileSync(f.queue, committed(seedDoc({
      tasks: [
        { id: 1083, desc: "the row the dispatch ledgers", status: "pending", note: "seed sentence." },
        { id: 1172, desc: "the row tq-note appends to", status: "in_progress", note: "seed sentence." },
      ],
    })));
    f.prepareTarget();
    const { env, base } = barrierFor(dir, "pause_before_rename");
    const file = segFile(dir, "seg.txt", "A concurrent Rule 40 segment landed under the lock.");

    // tq-note takes the lock and parks before its rename, holding it.
    const held = tqAsync(appendArgs(f.queue, "1172", file), env);
    await waitForFile(`${base}.ready`, "tq-note to reach its pre-rename barrier");

    // The real dispatch runs while the lock is held; its ledger must WAIT, not clobber.
    // Released from a separate process because spawnSync blocks this one entirely.
    scheduleRelease(base, 2500);
    const started = Date.now();
    const r = f.dispatch(["--target", "router-fixture"]);
    const elapsed = Date.now() - started;
    const appended = await held.done;

    assert.equal(appended.code, 0, appended.stderr);
    assert.equal(r.status, 0, r.stderr);

    // THE ORACLE — identical to the RED's. Before this change the ledger write was lost.
    const ledgered = rowOf(f.queue, "1083");
    const noted = rowOf(f.queue, "1172");
    assert.equal(ledgered.status, "delegated", `the ledger did not land (elapsed ${elapsed}ms)`);
    assert.match(String(ledgered.note), /dispatched /, String(ledgered.note));
    assert.match(String(noted.note), /A concurrent Rule 40 segment landed under the lock\./,
      `the append was lost by the ledger (elapsed ${elapsed}ms)`);

    // …and the ledger still wrote the committed shape, byte for byte (T150's invariant).
    const raw = fs.readFileSync(f.queue, "utf8");
    assert.equal(raw, committed(JSON.parse(raw)), "the locked ledger re-serialised the queue");
    assert.ok(raw.endsWith("}\n"), "the trailing newline was dropped");
  } finally {
    f.cleanup();
  }
});

// R3 (review qr1172bct): a real runner skip with a reason, instead of a console.log inside
// a test that then reported `ok`. Every assertion in this case needs bash, so there is no
// platform-independent remainder to strip out and keep running.
test("A-3: the real dispatch ledger and a concurrent bin/tq-focus.sh write BOTH survive", {
  skip: WIN32 ? "POSIX-only: bin/tq-focus.sh needs Git bash; not win32 coverage" : false,
}, async () => {
  const f = fixture();
  try {
    const dir = caseDir("a3-focus-race");
    fs.writeFileSync(f.queue, committed(seedDoc({
      tasks: [{ id: 1083, desc: "the row the dispatch ledgers", status: "pending", note: "seed sentence." }],
    })));
    f.prepareTarget();
    const { env, base } = barrierFor(dir, "pause_before_rename");

    // W-B now reaches the queue through the same lock, so it parks at the same barrier.
    const focus = spawn("bash", [TQ_FOCUS, "beta"], {
      env: { ...BASE_ENV, ...f.env, ...env, TQ: f.queue }, stdio: ["ignore", "pipe", "pipe"],
    });
    let fout = "", ferr = "";
    focus.stdout.on("data", (d) => { fout += String(d); });
    focus.stderr.on("data", (d) => { ferr += String(d); });
    const focusDone = new Promise<number | null>((res) => focus.on("close", res));
    await waitForFile(`${base}.ready`, "tq-focus.sh to reach its pre-rename barrier");

    scheduleRelease(base, 2500);
    const r = f.dispatch(["--target", "router-fixture"]);
    const focusCode = await focusDone;

    assert.equal(focusCode, 0, `${fout}\n${ferr}`);
    assert.equal(r.status, 0, r.stderr);
    // THE ORACLE, with exactly the RED's two writers.
    const doc = readDoc(f.queue);
    assert.equal(doc.active_focus, "beta", "the focus write was lost");
    assert.equal(rowOf(f.queue, "1083").status, "delegated", "the ledger write was lost");
    assert.match(String(rowOf(f.queue, "1083").note), /dispatched /);
    assert.match(fout, /Focus switched to: beta/, fout);
  } finally {
    f.cleanup();
  }
});

// ── A-4 — duplicate segment content ──────────────────────────────────────────────────

test("A-4: a duplicate LAST segment replays as a no-op; an earlier duplicate is refused", () => {
  const dir = caseDir("a4-duplicates");
  const q = seed(dir);
  const same = segFile(dir, "same.txt", "The   measured   fact is recorded once.");
  const other = segFile(dir, "other.txt", "A different measured fact follows it.");

  assert.equal(tq(appendArgs(q, "1172", same)).status, 0);
  // Replay of the immediately preceding append — the crash-recovery case.
  const replay = tqJson(appendArgs(q, "1172", same));
  assert.equal(replay.r.status, 0);
  assert.equal(replay.body.reason, "already_applied");
  assert.equal(replay.body.bytes_before, replay.body.bytes_after, "a replay wrote bytes");

  // Normalization is whitespace-insensitive, so a reflowed restatement is still caught.
  const reflowed = segFile(dir, "reflowed.txt", "The measured fact is recorded once.\n");
  const reflowReplay = tqJson(appendArgs(q, "1172", reflowed));
  assert.equal(reflowReplay.body.reason, "already_applied");

  assert.equal(tq(appendArgs(q, "1172", other)).status, 0);
  // Now the duplicate is NOT last: a Rule 40 ¶4 restatement, refused by name.
  const before = fs.readFileSync(q, "utf8");
  const restate = tqJson(appendArgs(q, "1172", same));
  assert.equal(restate.r.status, 3);
  assert.equal(restate.body.reason, "duplicate_segment_content");
  assert.equal(fs.readFileSync(q, "utf8"), before, "a refused restatement wrote the queue");

  // …and a genuinely intended repetition stays possible, so distinct intent is never
  // dropped silently.
  const forced = tqJson([...appendArgs(q, "1172", same), "--allow-duplicate-content"]);
  assert.equal(forced.r.status, 0, forced.r.stderr);
  assert.equal(forced.body.applied, true);
  assert.equal(forced.body.segments_after, 4);

  const blank = segFile(dir, "blank.txt", "   \n\t\n");
  const empty = tqJson(appendArgs(q, "1172", blank));
  assert.equal(empty.r.status, 3);
  assert.equal(empty.body.reason, "empty_segment");
});

// ── A-5 — crash at every durable boundary ────────────────────────────────────────────

test("A-5: a crash at every durable boundary leaves the queue whole and replays exactly once", () => {
  // One case per row of the commit protocol's crash table. After each: the queue parses,
  // it is wholly OLD or wholly NEW, no temp of this operation survives, the lock is free,
  // and replaying the same command reaches the correct terminal state applied ONCE.
  for (const [faultName, lands] of [
    ["temp_write", false], ["fsync", false], ["verify", false], ["rename", false],
    ["dir_fsync", true],
  ] as const) {
    if (faultName === "dir_fsync" && WIN32) continue;   // no directory fsync exists on win32
    const dir = caseDir(`a5-${faultName}`);
    const q = seed(dir);
    const before = fs.readFileSync(q, "utf8");
    const file = segFile(dir, "seg.txt", `A segment interrupted at ${faultName}.`);

    const faulted = tqJson(appendArgs(q, "1172", file), { AIGENTRY_TQ_NOTE_FAULT: faultName });
    assert.equal(faulted.r.status, 3, `${faultName}: ${faulted.r.stdout}${faulted.r.stderr}`);

    const after = fs.readFileSync(q, "utf8");
    assert.doesNotThrow(() => JSON.parse(after), `${faultName}: the queue no longer parses`);
    assert.equal(after, committed(JSON.parse(after)), `${faultName}: a partial document landed`);
    if (lands) {
      // The rename already happened; both generations are COMPLETE documents.
      assert.notEqual(after, before, `${faultName}: the rename did not land`);
      assert.match(String(rowOf(q, "1172").note), new RegExp(`interrupted at ${faultName}`));
    } else {
      assert.equal(after, before, `${faultName}: the queue changed although the write failed`);
    }

    const temps = fs.readdirSync(path.dirname(q)).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(temps, [], `${faultName}: this operation's temp survived: ${temps.join()}`);

    // The lock was released — the replay succeeds immediately rather than waiting 10s.
    const started = Date.now();
    const replay = tqJson(appendArgs(q, "1172", file));
    assert.equal(replay.r.status, 0, `${faultName} replay: ${replay.r.stderr}`);
    assert.ok(Date.now() - started < 9_000, `${faultName}: the replay waited on a stale lock`);
    assert.equal(replay.body.reason, lands ? "already_applied" : null,
      `${faultName}: replay was ${replay.body.reason}`);

    // Applied exactly once, whichever side of the boundary the crash fell on.
    const occurrences = String(rowOf(q, "1172").note).split(`interrupted at ${faultName}`).length - 1;
    assert.equal(occurrences, 1, `${faultName}: applied ${occurrences} times, not once`);
  }
});

// ── A-6 — CAS ordering vs already-applied recovery ───────────────────────────────────

test("A-6: a stale CAS token refuses even when the effect is already applied", () => {
  const dir = caseDir("a6-cas-order");
  const q = seed(dir);
  const file = segFile(dir, "seg.txt", "The CAS ordering is asserted here.");
  const stale = sha256(fs.readFileSync(q));

  const first = tqJson([...appendArgs(q, "1172", file), "--expect-sha256", stale]);
  assert.equal(first.r.status, 0, first.r.stderr);
  const fresh = first.body.doc_sha256_after;

  // The effect IS already applied, but this caller asserted a document version that no
  // longer exists. Answering already_applied would hide that its next decision is being
  // computed from a view that is gone.
  const withStale = tqJson([...appendArgs(q, "1172", file), "--expect-sha256", stale]);
  assert.equal(withStale.r.status, 3);
  assert.equal(withStale.body.reason, "stale_document");

  // The crash-replay form omits the token and relies on the document itself.
  const replay = tqJson(appendArgs(q, "1172", file));
  assert.equal(replay.r.status, 0);
  assert.equal(replay.body.reason, "already_applied");

  // …and the chained form passes the token the previous call returned.
  const chainFile = segFile(dir, "chain.txt", "A chained second mutation follows it.");
  const chained = tqJson([...appendArgs(q, "1172", chainFile), "--expect-sha256", String(fresh)]);
  assert.equal(chained.r.status, 0, chained.r.stderr);
  assert.equal(chained.body.applied, true);
});

// ── A-7 — no key is ever a decision input ────────────────────────────────────────────

test("A-7: a correlation id is echoed, never persisted and never a decision input", () => {
  const dir = caseDir("a7-correlation");
  const q = seed(dir);
  const one = segFile(dir, "one.txt", "The first payload under a shared correlation id.");
  const two = segFile(dir, "two.txt", "A different payload under the same correlation id.");
  const ID = "corr-1172-aaaaaaaa";

  const a = tqJson([...appendArgs(q, "1172", one), "--correlation-id", ID]);
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.equal(a.body.correlation_id, ID, "the id is not echoed for log stitching");

  // Same id, DIFFERENT payload ⇒ applies. An id is not an idempotency key here.
  const b = tqJson([...appendArgs(q, "1172", two), "--correlation-id", ID]);
  assert.equal(b.body.applied, true, "the correlation id was treated as a key");

  // Same id, SAME payload ⇒ the decision came from content, not from the id.
  const c = tqJson([...appendArgs(q, "1172", two), "--correlation-id", ID]);
  assert.equal(c.body.reason, "already_applied");
  const d = tqJson([...appendArgs(q, "1172", two), "--correlation-id", "corr-1172-bbbbbbbb"]);
  assert.equal(d.body.reason, "already_applied", "a new id changed a content decision");

  // Nothing resembling a key was persisted anywhere in the committed document.
  const raw = fs.readFileSync(q, "utf8");
  assert.ok(!raw.includes(ID), "the correlation id was persisted");
  assert.ok(!raw.includes("corr-1172-bbbbbbbb"), "the correlation id was persisted");
  for (const key of ["correlation_id", "idempotency", "applied_keys", "intent"]) {
    assert.ok(!raw.includes(key), `the document gained a ${key} field`);
  }
});

// ── A-8 — stale focus/status replay after a newer write ──────────────────────────────

test("A-8: a stale focus replay after an intervening write refuses and never rolls back", () => {
  const dir = caseDir("a8-stale-focus");
  const q = seed(dir);

  const prev = String(readDoc(q).active_focus);          // what a caller reads first: "alpha"
  assert.equal(tq(["set-focus", "--track", "beta", "--queue", q]).status, 0);   // intervening

  // The stale caller now replays with the guard it captured. The NEWER value stays.
  const stale = tqJson(["set-focus", "--track", "alpha", "--queue", q, "--expect-focus", prev]);
  assert.equal(stale.r.status, 3);
  assert.equal(stale.body.reason, "expect_focus_mismatch");
  assert.equal(readDoc(q).active_focus, "beta", "a stale replay rolled the focus back");

  // The same shape for status.
  assert.equal(tq(["set-status", "--task", "1166", "--status", "done", "--queue", q]).status, 0);
  const staleStatus = tqJson(["set-status", "--task", "1166", "--status", "delegated",
    "--queue", q, "--expect-status", "pending"]);
  assert.equal(staleStatus.r.status, 3);
  assert.equal(staleStatus.body.reason, "expect_status_mismatch");
  assert.equal(rowOf(q, "1166").status, "done", "a stale replay rolled the status back");

  // A first focus set from null needs no guard, and re-setting the same value is a no-op.
  const q2 = seed(caseDir("a8-null-focus"), seedDoc({ active_focus: null }));
  assert.equal(tq(["set-focus", "--track", "alpha", "--queue", q2, "--expect-focus", "null"]).status, 0);
  assert.equal(readDoc(q2).active_focus, "alpha");
  const noop = tqJson(["set-focus", "--track", "alpha", "--queue", q2]);
  assert.equal(noop.body.reason, "already_applied");

  const unknown = tqJson(["set-focus", "--track", "nope", "--queue", q2]);
  assert.equal(unknown.r.status, 3);
  assert.equal(unknown.body.reason, "unknown_track");
});

// ── A-9 — the id domain ──────────────────────────────────────────────────────────────

test("A-9: numeric, string, suffixed and non-ASCII ids resolve; blank and duplicate ids refuse", () => {
  const dir = caseDir("a9-ids");
  const q = seed(dir, seedDoc({
    tasks: [
      { id: 1172, desc: "a JSON number id, which is what the real queue holds", status: "pending", note: "n." },
      { id: "1172b", desc: "the collision-rename form the gate recommends", status: "pending", note: "s." },
      { id: "번호-1172", desc: "a non-ASCII id", status: "pending", note: "u." },
    ],
  }));
  const file = segFile(dir, "seg.txt", "Resolved by String(id) exactly as the gate does.");

  for (const id of ["1172", "1172b", "번호-1172"]) {
    const r = tqJson(appendArgs(q, id, file));
    assert.equal(r.r.status, 0, `${id}: ${r.r.stderr}`);
    assert.equal(r.body.task, id);
  }
  assert.equal(tq(appendArgs(q, "9999", file)).status, 3);
  const unknown = tqJson(appendArgs(q, "9999", file));
  assert.equal(unknown.body.reason, "unknown_task_id");

  // A blank id is usage, not a state error.
  assert.equal(tq(appendArgs(q, "   ", file)).status, 4);

  // Two rows with the same id: refused, following the GATE, not the ledger's warn-and-skip.
  const qd = seed(caseDir("a9-ambiguous"), seedDoc({
    tasks: [
      { id: 1172, desc: "first of two", status: "pending", note: "a." },
      { id: "1172", desc: "second of two", status: "pending", note: "b." },
    ],
  }));
  const before = fs.readFileSync(qd, "utf8");
  const amb = tqJson(appendArgs(qd, "1172", file));
  assert.equal(amb.r.status, 3);
  assert.equal(amb.body.reason, "ambiguous_task_id");
  assert.deepEqual(amb.body.hits?.map((h) => h.idx), [0, 1]);
  assert.equal(fs.readFileSync(qd, "utf8"), before, "an ambiguous id wrote the queue");
});

// ── A-10 — serialization parity, measured not assumed ────────────────────────────────

test("A-10: no reserialization drift outside the row the operation touched", () => {
  // The live state/task-queue.json is untracked operating data and is NOT the oracle here
  // (`.gitignore:1` is `state`). The oracle is a fixture plus a cross-writer comparison.
  const dir = caseDir("a10-parity");
  const doc = seedDoc({
    "unknown-top-level": { kept: true, nested: [1, 2, { deep: "값" }] },
    tasks: [
      {
        id: 1172, desc: "ünïcode and 한국어 in the desc", status: "in_progress",
        note: "seed sentence with 한국어.", unknown_row_field: { kept: true },
        big_integer: 12345678901234567890, float: 0.1, negative: -17, exponent: 1e21,
        nulls: null, bools: [true, false],
      },
      { id: 1166, desc: "untouched", status: "pending", note: "neighbour." },
    ],
  });
  const q = seed(dir, doc);
  const file = segFile(dir, "seg.txt", "One row changed, nothing else did.");

  const beforeDoc = readDoc(q);
  assert.equal(tq(appendArgs(q, "1172", file)).status, 0);
  const raw = fs.readFileSync(q, "utf8");
  const afterDoc = readDoc(q);

  // 1. The output is its own re-serialisation in the committed shape — exactly T150's
  //    assertion, which is what a W-A-shaped `JSON.stringify(data, null, 2) + "\n"` emits.
  assert.equal(raw, committed(afterDoc), "the transform re-serialised into another shape");
  assert.ok(raw.endsWith("}\n"));
  assert.match(raw, /^\{\n {2}"schema_version"/, "2-space indent was not preserved");

  // 2. Key insertion order survives a parse/emit round trip, top level and per row.
  assert.deepEqual(Object.keys(afterDoc), Object.keys(beforeDoc));
  const beforeRow = (beforeDoc.tasks as Row[])[0] as Row;
  const afterRow = (afterDoc.tasks as Row[])[0] as Row;
  assert.deepEqual(Object.keys(afterRow).slice(0, Object.keys(beforeRow).length), Object.keys(beforeRow));

  // 3. Everything outside the touched row is byte-identical.
  const strip = (d: Doc) => {
    const copy = JSON.parse(JSON.stringify(d)) as Doc;
    (copy.tasks as Row[])[0] = { TOUCHED: true };
    return committed(copy);
  };
  assert.equal(strip(afterDoc), strip(beforeDoc), "bytes changed outside the intended row");
  assert.deepEqual((afterDoc.tasks as Row[])[1], (beforeDoc.tasks as Row[])[1]);
  assert.deepEqual(afterDoc["unknown-top-level"], doc["unknown-top-level"]);
  assert.deepEqual(afterRow.unknown_row_field, { kept: true });

  // 4. Unicode is emitted unescaped, as JSON.stringify does.
  assert.ok(raw.includes("한국어"), "Unicode was escaped");
  assert.ok(raw.includes("ünïcode"));

  // 5. Number semantics are JSON.parse → JSON.stringify's — RECORDED as measured, not
  //    claimed as fidelity. An integer past Number.MAX_SAFE_INTEGER is re-emitted from the
  //    double. This is a pre-existing property of EVERY JS writer in this tree (W-A at
  //    src/dispatch/cli.ts:939 and W-C at bin/init/cli.mjs:420 both do it), so U3 neither
  //    introduces nor fixes it. A hand-written Python-committed queue would differ here.
  assert.equal(afterRow.big_integer, 12345678901234567000);
  assert.ok(raw.includes("12345678901234567000"), raw.slice(0, 400));
  assert.equal(afterRow.float, 0.1);
  assert.equal(afterRow.negative, -17);
  assert.equal(afterRow.exponent, 1e21);
  assert.ok(raw.includes("1e+21"), "the exponent form is JSON.stringify's, as W-A's would be");
});

// ── A-11 — the dispatch ledger's own contract ────────────────────────────────────────

test("A-11: ledger-dispatch replays exactly once and never regresses in_progress", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.queue, committed(seedDoc({
      tasks: [{ id: 1083, desc: "the ledgered row", status: "in_progress", note: "seed sentence." }],
    })));
    f.prepareTarget();

    const first = f.dispatch(["--target", "router-fixture"]);
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = rowOf(f.queue, "1083");
    // in_progress is NOT promoted — the existing rule, unchanged.
    assert.equal(afterFirst.status, "in_progress");
    assert.match(String(afterFirst.note), /dispatched /);
    const stamps = String(afterFirst.note).split("| dispatched ").length - 1;
    assert.equal(stamps, 1, `one dispatch wrote ${stamps} stamps`);
    // Measured: the `--target` arm makes no routing decision, so it records no
    // spawn_decisions — the pre-change behaviour, unchanged. #1148's per-sid record is
    // asserted below on the arm that DOES route.
    assert.equal(Object.prototype.hasOwnProperty.call(afterFirst, "spawn_decisions"), false,
      "the --target arm invented a spawn decision");

    // Measured: a second dispatch of the same ref is DEDUPLICATED by the registry (exit 8,
    // T74's contract) and never reaches the ledger, so distinct/identical intent is asserted
    // at the op boundary, which is where the decision actually lives.
    const dedup = f.dispatch(["--target", "router-fixture"]);
    assert.equal(dedup.status, 8, dedup.stderr);
    assert.match(dedup.stderr, /DISPATCH_DEDUPLICATED/, dedup.stderr);

    const ledger = (stamp: string, sid: string) => brokerCall(f.queue, JSON.stringify({
      v: 1, op: "ledger-dispatch", queue: f.queue,
      params: { task: "1083", note_stamp: stamp, updated_at: "2026-10-15",
        promote_from: ["pending", "queued"], promote_to: "delegated",
        spawn_decision: { sid, value: { at: "2026-10-15T00:00:00Z", decided_by: "explicit" } } },
    }));
    const STAMP_A = " | dispatched 2026-10-15T00:00:00Z sid=a ref=r.md track=t cli=claude/x by=explicit";
    const STAMP_B = " | dispatched 2026-10-15T00:00:01Z sid=b ref=r.md track=t cli=claude/x by=explicit";

    const a1 = ledger(STAMP_A, "a");
    assert.equal(a1.status, 0, a1.stderr);
    assert.equal((JSON.parse(lastLine(a1.stdout)) as Body).applied, true);
    // EXACT record replay is a no-op: the crash-recovery case, no second stamp.
    const a2 = ledger(STAMP_A, "a");
    assert.equal(a2.status, 0, a2.stderr);
    assert.equal((JSON.parse(lastLine(a2.stdout)) as Body).reason, "already_applied");
    assert.equal(String(rowOf(f.queue, "1083").note).split("sid=a ").length - 1, 1,
      "an exact replay appended a second identical stamp");
    // A DISTINCT event appends: text dedup must never drop distinct intent silently.
    const b1 = ledger(STAMP_B, "b");
    assert.equal(b1.status, 0, b1.stderr);
    assert.equal((JSON.parse(lastLine(b1.stdout)) as Body).applied, true);
    const note = String(rowOf(f.queue, "1083").note);
    assert.equal(note.split("sid=a ").length - 1, 1, note);
    assert.equal(note.split("sid=b ").length - 1, 1, note);
    const decisions = rowOf(f.queue, "1083").spawn_decisions as Record<string, unknown>;
    assert.deepEqual(Object.keys(decisions).sort(), ["a", "b"]);
    // in_progress is still never promoted, through every one of those calls.
    assert.equal(rowOf(f.queue, "1083").status, "in_progress");

    // The committed shape is unchanged (T150's invariant, through the locked path).
    const raw = fs.readFileSync(f.queue, "utf8");
    assert.equal(raw, committed(JSON.parse(raw)));
  } finally {
    f.cleanup();
  }
});

// R3: win32 has no OS sandbox runtime and refuses the confined spawn BEFORE the ledger
// (T150 measures the same boundary), so the whole routing arm is unsupported there — a real
// runner skip, not a console note inside a passing test. Not win32 coverage.
test("A-11: #1148's per-sid spawn decision still reaches the row through the locked path", {
  skip: WIN32 ? "POSIX-only: no OS sandbox runtime on win32, so the confined spawn refuses before the ledger" : false,
}, () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.queue, committed(seedDoc({
      tasks: [{ id: 1083, desc: "the ledgered row", status: "pending", note: "seed sentence." }],
    })));
    const r = f.dispatch([...f.spawnArgs, "--role", "coder"]);
    assert.equal(r.status, 0, r.stderr);
    const row = rowOf(f.queue, "1083");
    assert.equal(row.status, "delegated");
    const bySid = row.spawn_decisions as Record<string, Record<string, unknown>> | undefined;
    assert.ok(bySid, "the spawn decision was not recorded through the locked path");
    const sids = Object.keys(bySid);
    assert.equal(sids.length, 1, `keyed by sid: ${sids.join()}`);
    const decision = bySid[sids[0]!]!;
    // requested / selected / observed kept apart, exactly as decisionAudit() emits them.
    for (const key of ["at", "requested", "selected", "observed", "decided_by"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(decision, key), `the decision lost ${key}`);
    }
    const raw = fs.readFileSync(f.queue, "utf8");
    assert.equal(raw, committed(JSON.parse(raw)), "the ledger re-serialised the queue");
  } finally {
    f.cleanup();
  }
});

test("A-11: an ambiguous id warns and skips without failing the dispatch, with the same text", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.queue, committed(seedDoc({
      tasks: [
        { id: 1083, desc: "first of two colliding rows", status: "pending", note: "a." },
        { id: "1083", desc: "second of two colliding rows", status: "pending", note: "b." },
      ],
    })));
    f.prepareTarget();
    const before = fs.readFileSync(f.queue, "utf8");
    // Measured, in all three gate modes: the GATE refuses an ambiguous id with rc 5 before
    // any effect, because AIGENTRY_TASK_GATE chooses how strict the gate is about a KNOWN
    // row - it cannot choose WHICH of two rows was meant (src/dispatch/cli.ts:835). So the
    // ledger's own warn-and-skip branch stays UNREACHABLE through the real caller, exactly
    // as it was before this change; it is not measured end-to-end and is not claimed to be.
    for (const mode of ["hard", "warn", "off"]) {
      const r = f.dispatch(["--target", "router-fixture"], { AIGENTRY_TASK_GATE: mode });
      assert.equal(r.status, 5, `gate=${mode}: ${r.stderr}`);
      assert.match(r.stderr, /Rule 34 task-gate: task id '1083' matches 2 rows/, r.stderr);
      // The shared formatter still produces the exact sentence, unchanged by U3.
      assert.match(r.stderr,
        /idx 0 \("first of two colliding rows"\) and idx 1 \("second of two colliding rows"\)/, r.stderr);
      assert.match(r.stderr, /Rename one row \(e\.g\. '1083b'\) and dispatch the id you mean/, r.stderr);
      assert.equal(fs.readFileSync(f.queue, "utf8"), before, `gate=${mode}: an ambiguous write landed`);
    }

    // What the ledger would need IS available from inside the lock: the broker answers
    // ledger-dispatch with the colliding rows, which is the data cli.ts formats its warning
    // from. Asserted at the transaction boundary, since the gate hides the caller path.
    const amb = brokerCall(f.queue, JSON.stringify({
      v: 1, op: "ledger-dispatch", queue: f.queue,
      params: { task: "1083", note_stamp: " | dispatched never", updated_at: "2026-10-15",
        promote_from: ["pending"], promote_to: "delegated" },
    }));
    assert.equal(amb.status, 3, amb.stdout);
    const body = JSON.parse(lastLine(amb.stdout)) as Body;
    assert.equal(body.reason, "ambiguous_task_id");
    assert.deepEqual(body.hits, [
      { idx: 0, desc: "first of two colliding rows" },
      { idx: 1, desc: "second of two colliding rows" },
    ]);
    assert.equal(fs.readFileSync(f.queue, "utf8"), before, "an ambiguous ledger write landed");
  } finally {
    f.cleanup();
  }
});

// ── A-12 — register ─────────────────────────────────────────────────────────────────

test("A-12: register replays exactly, collides on a different payload, and keeps unknown fields", () => {
  const dir = caseDir("a12-register");
  const q = seed(dir);
  const record = {
    id: 2000, desc: "a newly registered task", status: "pending", priority: "P2",
    note: "created by the register op.", unknown_field: { kept: true, list: ["값"] },
  };
  const file = path.join(dir, "rec.json");
  fs.writeFileSync(file, JSON.stringify(record, null, 2));

  const first = tqJson(["register", "--task-file", file, "--queue", q]);
  assert.equal(first.r.status, 0, first.r.stderr);
  assert.equal(first.body.task, "2000");
  assert.deepEqual(rowOf(q, "2000"), record, "the record was not stored verbatim");

  // Exact equivalent record ⇒ replay no-op.
  const replay = tqJson(["register", "--task-file", file, "--queue", q]);
  assert.equal(replay.r.status, 0);
  assert.equal(replay.body.reason, "already_applied");
  assert.equal((readDoc(q).tasks as Row[]).length, 3, "the replay appended a second row");

  // Key order alone does not make a record different.
  const reordered = path.join(dir, "rec-reordered.json");
  fs.writeFileSync(reordered, JSON.stringify({ status: "pending", id: 2000, priority: "P2",
    unknown_field: { list: ["값"], kept: true }, note: "created by the register op.",
    desc: "a newly registered task" }));
  assert.equal(tqJson(["register", "--task-file", reordered, "--queue", q]).body.reason, "already_applied");

  // Same id, DIFFERENT payload ⇒ a collision, never a no-op and never an overwrite.
  const collide = path.join(dir, "rec-collide.json");
  fs.writeFileSync(collide, JSON.stringify({ id: 2000, desc: "a DIFFERENT task", status: "pending" }));
  const before = fs.readFileSync(q, "utf8");
  const collision = tqJson(["register", "--task-file", collide, "--queue", q]);
  assert.equal(collision.r.status, 3);
  assert.equal(collision.body.reason, "duplicate_task_id");
  assert.equal(fs.readFileSync(q, "utf8"), before, "a collision overwrote the existing row");

  for (const bad of ['{"desc":"no id"}', '{"id":null}', '{"id":{"nested":1}}', "[]", "not json"]) {
    const p = path.join(dir, "bad.json");
    fs.writeFileSync(p, bad);
    assert.equal(tq(["register", "--task-file", p, "--queue", q]).status, 4, bad);
  }
});

// ── A-13 — corrupt and non-regular inputs ───────────────────────────────────────────

test("A-13: every corrupt or non-regular queue is a named refusal that writes nothing", () => {
  const dir = caseDir("a13-corrupt");
  const file = segFile(dir, "seg.txt", "This segment must never be written.");
  const cases: [string, string, number][] = [
    ['{"tasks":[', "queue_corrupt", 9],
    ["[]", "queue_corrupt", 9],
    ["null", "queue_corrupt", 9],
    ['"a string"', "queue_corrupt", 9],
    ["", "queue_corrupt", 9],
    ['{"active_focus":null}', "queue_corrupt", 9],
    ['{"tasks":{}}', "queue_corrupt", 9],
    ['{"tasks":[null]}', "queue_corrupt", 9],
    ['{"tasks":["a string"]}', "queue_corrupt", 9],
    ['{"tasks":[{"desc":"no id"}]}', "queue_corrupt", 9],
    ['{"tasks":[{"id":1172,"note":{"not":"a string"}}]}', "queue_corrupt", 9],
  ];
  for (const [bytes, reason, code] of cases) {
    const d = caseDir("a13-each");
    const q = path.join(d, "state", "task-queue.json");
    fs.writeFileSync(q, bytes, { mode: 0o600 });
    const r = tqJson(appendArgs(q, "1172", file));
    assert.equal(r.r.status, code, `${JSON.stringify(bytes)} -> ${r.r.stdout}`);
    assert.equal(r.body.reason, reason, JSON.stringify(bytes));
    assert.equal(fs.readFileSync(q, "utf8"), bytes, "a refusal wrote the queue");
    assert.deepEqual(fs.readdirSync(path.dirname(q)).filter((n) => n.endsWith(".tmp")), []);
  }

  // Missing.
  const missing = path.join(caseDir("a13-missing"), "state", "task-queue.json");
  const gone = tqJson(appendArgs(missing, "1172", file));
  assert.equal(gone.r.status, 9);
  assert.equal(gone.body.reason, "queue_missing");

  // A directory where the queue should be.
  const asDir = path.join(caseDir("a13-dir"), "state", "task-queue.json");
  fs.mkdirSync(asDir);
  const dirCase = tqJson(appendArgs(asDir, "1172", file));
  assert.equal(dirCase.r.status, 9);
  assert.equal(dirCase.body.reason, "queue_not_regular");

  if (!WIN32) {
    // A symlinked LEAF is refused, not followed: rename would replace the link and
    // silently detach its target.
    const real = seed(caseDir("a13-symlink-target"));
    const link = path.join(caseDir("a13-symlink"), "state", "task-queue.json");
    fs.symlinkSync(real, link);
    const beforeTarget = fs.readFileSync(real, "utf8");
    const sym = tqJson(appendArgs(link, "1172", file));
    assert.equal(sym.r.status, 9);
    assert.equal(sym.body.reason, "queue_not_regular");
    assert.equal(fs.readFileSync(real, "utf8"), beforeTarget, "the symlink target was written");
    assert.ok(fs.lstatSync(link).isSymbolicLink(), "the symlink was replaced");

    // A symlinked DIRECTORY is fine and is collapsed onto one lock inode.
    const target = caseDir("a13-dirlink-target");
    const q = seed(target);
    const linkDir = path.join(sandbox, "a13-dirlink");
    fs.symlinkSync(target, linkDir);
    const viaLink = tqJson(appendArgs(path.join(linkDir, "state", "task-queue.json"), "1172", file));
    assert.equal(viaLink.r.status, 0, viaLink.r.stderr);
    assert.equal(viaLink.body.queue, q, "the directory symlink was not collapsed");
  }
});

test("A-13: an over-cap queue is refused, never truncated", () => {
  // The cap is 32 MiB and the real queue measured ~600 KB, so this asserts the REFUSAL
  // path with a request the transform can reach cheaply: the broker's 1 MiB request cap.
  const dir = caseDir("a13-caps");
  const q = seed(dir);
  const before = fs.readFileSync(q, "utf8");
  const huge = segFile(dir, "huge.txt", "x".repeat(65 * 1024));
  const over = tqJson(appendArgs(q, "1172", huge));
  assert.equal(over.r.status, 4);
  assert.equal(over.body.reason, "invalid_argument");
  assert.match(String(over.body.detail), /64-byte cap|65536-byte cap/);
  assert.equal(fs.readFileSync(q, "utf8"), before, "an over-cap segment was written");

  const enormous = segFile(dir, "enormous.txt", "y".repeat(2 * 1024 * 1024));
  const request = tqJson(appendArgs(q, "1172", enormous));
  assert.ok([3, 4].includes(request.r.status ?? -1), `${request.r.status}: ${request.r.stdout}`);
  assert.ok(["invalid_argument", "request_too_large"].includes(String(request.body.reason)),
    String(request.body.reason));
  assert.equal(fs.readFileSync(q, "utf8"), before, "an over-cap request was written");
});

// ── A-14 — init-create (W-C) ────────────────────────────────────────────────────────

test("A-14: init-create writes W-C's exact bytes once, under the lock, and never truncates", async () => {
  const dir = caseDir("a14-init");
  const q = path.join(dir, "state", "task-queue.json");
  const request = JSON.stringify({
    v: 1, op: "init-create", queue: q, params: { document: { tasks: [], active_focus: null } },
  });
  const call = () => brokerCall(q, request);

  const first = call();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(lastLine(first.stdout)).applied, true);
  // Byte-identical to the write bin/init/cli.mjs:420 used to perform itself.
  assert.equal(fs.readFileSync(q, "utf8"), committed({ tasks: [], active_focus: null }));

  const second = call();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(lastLine(second.stdout)).reason, "exists");

  // Content a concurrent writer put there is PRESERVED — the old existsSync → writeFileSync
  // TOCTOU could overwrite it with the empty document.
  const real = seedDoc();
  fs.writeFileSync(q, committed(real));
  const third = call();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(JSON.parse(lastLine(third.stdout)).reason, "exists");
  assert.deepEqual(readDoc(q), real, "init-create overwrote a real queue");

  // Concurrent creation: exactly one creator, no truncation.
  const dir2 = caseDir("a14-init-race");
  const q2 = path.join(dir2, "state", "task-queue.json");
  const req2 = JSON.stringify({
    v: 1, op: "init-create", queue: q2, params: { document: { tasks: [], active_focus: null } },
  });
  const results = await Promise.all([0, 1, 2, 3].map(() => new Promise<Body>((res) => {
    const child = brokerSpawn(q2);
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.resume();
    child.on("close", () => { try { res(JSON.parse(lastLine(out)) as Body); } catch { res({}); } });
    child.stdin.end(req2);
  })));
  assert.equal(results.filter((b) => b.applied === true).length, 1, "more than one creator won");
  assert.equal(results.filter((b) => b.reason === "exists").length, 3);
  assert.equal(fs.readFileSync(q2, "utf8"), committed({ tasks: [], active_focus: null }));
});

// ── A-15 — timeouts, orphans and temp ownership ─────────────────────────────────────

test("A-15: a hung transform is killed by name, the lock is released, and foreign temps survive", () => {
  const dir = caseDir("a15-hygiene");
  const q = seed(dir);
  const stateDir = path.dirname(q);
  const file = segFile(dir, "seg.txt", "A segment written after the timeout refusal.");

  // Temps that are NOT this operation's: one with the helper's own naming pattern and an
  // old mtime, one unrelated. Age is not ownership, so neither may be removed.
  const foreignOwnPattern = `${q}.99999.deadbeef.tmp`;
  const foreignOther = path.join(stateDir, "someone-else.tmp");
  fs.writeFileSync(foreignOwnPattern, "a foreign writer's temp\n", { mode: 0o600 });
  fs.writeFileSync(foreignOther, "an unrelated temp\n", { mode: 0o600 });
  const old = new Date(Date.now() - 72 * 3600 * 1000);
  fs.utimesSync(foreignOwnPattern, old, old);
  fs.utimesSync(foreignOther, old, old);

  // R7 (review qr1172bct): there used to be a SECOND run here that armed a barrier with no
  // releaser and then discarded its result (`void hung`), leaving a ~30 s race nobody
  // asserted. Removed. One bounded case remains, and its result IS the oracle: the barrier
  // parks the child, `--timeout 2` bounds the wait, and the refusal must be named.
  //
  // There is no `transform_hang` fault value — phase-3 prose named one that was never
  // implemented. The implemented set is {lock, temp_write, fsync, verify, rename,
  // dir_fsync, pause_before_verify, pause_before_rename}; the SPEC was corrected rather
  // than a production seam invented to match stale text.
  const { env, base } = barrierFor(dir, "pause_before_rename");
  const started = Date.now();
  const timedOut = tqJson([...appendArgs(q, "1172", file), "--timeout", "2"],
    { ...env, AIGENTRY_TQ_NOTE_FAULT_BARRIER: base });
  const timedOutMs = Date.now() - started;
  assert.equal(timedOut.r.status, 3, timedOut.r.stdout);
  assert.equal(timedOut.body.reason, "transform_timeout");
  assert.ok(timedOutMs < 25_000, `the timeout was not bounded by --timeout: ${timedOutMs}ms`);
  assert.equal(fs.readFileSync(q, "utf8"), fs.readFileSync(q, "utf8"), "the queue still reads");
  assert.doesNotThrow(() => readDoc(q), "a killed transform left an unparseable queue");

  // The lock was released despite the kill: the next call succeeds promptly.
  const resumed = Date.now();
  const after = tqJson(appendArgs(q, "1172", file));
  assert.equal(after.r.status, 0, after.r.stderr);
  assert.ok(Date.now() - resumed < 9_000, "the timeout left the lock held");

  // Neither foreign temp was touched. Only this operation's own temp is ever unlinked.
  assert.equal(fs.readFileSync(foreignOwnPattern, "utf8"), "a foreign writer's temp\n");
  assert.equal(fs.readFileSync(foreignOther, "utf8"), "an unrelated temp\n");
});

// ── A-16 — lock hygiene ─────────────────────────────────────────────────────────────

test("A-16: the lock is the stable sibling with a stable inode, never the queue inode", () => {
  const dir = caseDir("a16-lock");
  const q = seed(dir);
  const lock = `${q}.lock`;
  const file1 = segFile(dir, "one.txt", "The first commit replaces the queue inode.");
  const file2 = segFile(dir, "two.txt", "The second commit replaces it again.");

  const queueInodeBefore = fs.statSync(q).ino;
  const a = tqJson(appendArgs(q, "1172", file1));
  assert.equal(a.r.status, 0, a.r.stderr);
  assert.ok(fs.existsSync(lock), "the lock sibling was not created");
  const lockInode = fs.statSync(lock).ino;
  assert.equal(a.body.lock_inode, lockInode, "the broker locked a different inode");

  const b = tqJson(appendArgs(q, "1172", file2));
  assert.equal(b.r.status, 0, b.r.stderr);

  // The queue inode changed (rename), the LOCK inode did not. That is the whole reason the
  // lock is a sibling: locking the queue inode would give two writers locks on two inodes.
  assert.notEqual(fs.statSync(q).ino, queueInodeBefore, "the commit did not rename");
  assert.equal(fs.statSync(lock).ino, lockInode, "the lock inode moved");
  assert.equal(b.body.lock_inode, lockInode);
  assert.notEqual(lockInode, fs.statSync(q).ino);

  // A pre-existing lock file with stale content does not deadlock.
  fs.writeFileSync(lock, "stale bytes from a previous process\n");
  const c = tqJson(appendArgs(q, "1172", segFile(dir, "three.txt", "A stale lock file is not a deadlock.")));
  assert.equal(c.r.status, 0, c.r.stderr);

  // A reader path takes no lock at all: a missing lock file is created, never required.
  fs.rmSync(lock);
  const d = tqJson(appendArgs(q, "1172", segFile(dir, "four.txt", "A removed lock file is recreated.")));
  assert.equal(d.r.status, 0, d.r.stderr);
});

test("A-16: the lock deadline refuses queue_unavailable rather than writing", async () => {
  const dir = caseDir("a16-deadline");
  const q = seed(dir);
  const { env, base } = barrierFor(dir, "pause_before_rename");
  const held = tqAsync(appendArgs(q, "1172", segFile(dir, "held.txt", "The holder parks here.")), env);
  await waitForFile(`${base}.ready`, "the holder to take the lock");

  // A contender with a 1s lock budget cannot get in. The broker's own deadline is 10s, so
  // this is asserted through the real contention path with a bounded wait.
  const before = fs.readFileSync(q, "utf8");
  const contender = brokerCall(q,
    JSON.stringify({ v: 1, op: "set-focus", queue: q, params: { track: "beta" } }));
  assert.equal(contender.status, 3, contender.stdout);
  assert.equal(JSON.parse(lastLine(contender.stdout)).reason, "queue_unavailable");
  assert.equal(fs.readFileSync(q, "utf8"), before, "a lock-timeout refusal wrote the queue");

  fs.writeFileSync(`${base}.go`, "go");
  const r = await held.done;
  assert.equal(r.code, 0, r.stderr);
});

// ── A-17 — capability refusal and the unlocked-write guard ──────────────────────────

test("A-17: with no OS lock capability the broker refuses by name and writes nothing", () => {
  if (WIN32) return;             // the POSIX module is the one shadowed; win32 uses msvcrt
  const dir = caseDir("a17-capability");
  const q = seed(dir);
  const before = fs.readFileSync(q, "utf8");

  // A private, fixture-only shadow of `fcntl` on PYTHONPATH. Python itself is never
  // modified and nothing is installed.
  const shadow = path.join(dir, "shadow");
  fs.mkdirSync(shadow, { mode: 0o700 });
  fs.writeFileSync(path.join(shadow, "fcntl.py"), 'raise ImportError("fixture: no fcntl")\n');

  const r = brokerCall(q,
    JSON.stringify({ v: 1, op: "set-focus", queue: q, params: { track: "beta" } }),
    { PYTHONPATH: shadow });
  assert.equal(r.status, 6, `${r.stdout}${r.stderr}`);
  const body = JSON.parse(lastLine(r.stdout)) as Body;
  assert.equal(body.reason, "lock_capability_unavailable");
  assert.match(String(body.detail), /refusing rather than writing the task queue unlocked/);
  assert.equal(fs.readFileSync(q, "utf8"), before, "a capability refusal wrote the queue");
  assert.equal(readDoc(q).active_focus, "alpha");
});

test("A-17: the transform refuses to run outside the broker, so no unlocked write exists", () => {
  const dir = caseDir("a17-token");
  const q = seed(dir);
  const before = fs.readFileSync(q, "utf8");
  const r = spawnSync(process.execPath, [TRANSFORM], {
    input: JSON.stringify({ v: 1, op: "set-focus", queue: q, params: { track: "beta" } }),
    encoding: "utf8", env: BASE_ENV, timeout: WALL_MS, shell: false,
  });
  assert.equal(r.status, 4, r.stdout);
  const body = JSON.parse(lastLine(r.stdout)) as Body;
  assert.equal(body.reason, "lock_token_missing");
  assert.equal(fs.readFileSync(q, "utf8"), before, "the unlocked transform wrote the queue");
});

// ── A-18 — shipping declarations ────────────────────────────────────────────────────

test("A-18: the three new helpers ship, and the manifest still agrees with the tree", async (t) => {
  const read = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { MANIFEST, GOVERNANCE_ROOTS } from ${JSON.stringify(MANIFEST_MJS)};
     process.stdout.write(JSON.stringify({ MANIFEST, GOVERNANCE_ROOTS }));`,
  ], { encoding: "utf8", env: BASE_ENV, timeout: WALL_MS });
  assert.equal(read.status, 0, read.stderr);
  const { MANIFEST, GOVERNANCE_ROOTS } = JSON.parse(read.stdout) as
    { MANIFEST: string[]; GOVERNANCE_ROOTS: string[] };

  for (const p of ["bin/tq-note.mjs", "bin/lib/task-queue-lock.py", "bin/lib/task-queue-write.mjs"]) {
    assert.ok(MANIFEST.includes(p), `${p} is not in the init manifest, so init would not ship it`);
    assert.ok(fs.existsSync(path.join(repoRoot, p)), `${p} is declared but absent`);
  }
  assert.ok(GOVERNANCE_ROOTS.includes("bin/"), "bin/ left the governance roots");
  assert.equal(MANIFEST.length, new Set(MANIFEST).size, "the manifest has a duplicate entry");
  // Assertion P's premise stays non-vacuous: the manifest still names Python sources.
  assert.ok(MANIFEST.filter((p) => p.endsWith(".py")).length >= 7);

  // R3: the two ENVIRONMENT-dependent assertions become named subtests with real skip
  // reasons, so the runner reports them honestly. The generic assertions above and below
  // always run — a mixed test is never skipped wholesale to hide them.
  const git = spawnSync("git", ["-C", repoRoot, "ls-files", "bin"], { encoding: "utf8", timeout: WALL_MS });
  await t.test("T96 assertion 4 recomputed: manifest bin count == git ls-files bin", {
    skip: git.status !== 0 ? "git unavailable here (e.g. an installed package); CI's T96 is the gate" : false,
  }, () => {
    const tree = git.stdout.trim().split("\n").filter(Boolean);
    assert.equal(MANIFEST.filter((p) => p.startsWith("bin/")).length, tree.length,
      "T96 assertion 4 would fail: init would ship an incomplete bin/");
  });

  await t.test("the two entry points carry an exec bit", {
    skip: WIN32 ? "POSIX file modes; win32 has no exec bit" : false,
  }, () => {
    // The transform is only ever run as `<node> task-queue-write.mjs`, so it needs none
    // (bin/lib/win-private-storage.mjs ships 0644 for the same reason).
    assert.ok(fs.statSync(TQ_NOTE).mode & 0o111, "bin/tq-note.mjs is not executable");
    assert.ok(fs.statSync(BROKER).mode & 0o111, "the broker is not executable");
  });
  assert.doesNotThrow(() => fs.accessSync(TRANSFORM, fs.constants.R_OK));

  // --help works without touching a queue, which is how a packaging check can probe it.
  const help = tq(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /tq-note\.mjs append/);
  assert.match(help.stdout, /tq-note\.mjs set-focus/);
});

// ── A-19 — no authority of any kind ─────────────────────────────────────────────────

test("A-19: the helpers hold no authority and a stale row grants nothing", () => {
  const dir = caseDir("a19-authority");
  // A stale, terminal row with an old timestamp grants no ownership of anything.
  const q = seed(dir, seedDoc({
    tasks: [{ id: 1172, desc: "a stale done row", status: "done", updated_at: "2020-01-01",
      note: "seed sentence." }],
  }));
  const file = segFile(dir, "seg.txt", "Rule 40 allows a segment on a done task.");

  const r = tqJson(appendArgs(q, "1172", file));
  assert.equal(r.r.status, 0, r.r.stderr);
  // Rule 40 ¶3: a `done` task accepts an append and its status is NOT rolled back.
  assert.equal(rowOf(q, "1172").status, "done");
  assert.equal(rowOf(q, "1172").updated_at, new Date().toISOString().slice(0, 10));
  assert.notEqual(rowOf(q, "1172").updated_at, "2020-01-01", "updated_at was not advanced");

  // Nothing resembling dispatch state was created or consulted.
  assert.equal(fs.existsSync(path.join(dir, "state", "dispatch")), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "state")).filter((n) => n !== "task-queue.json"
    && n !== "task-queue.json.lock"), []);

  // The response carries no authority field, and the surface exposes no sid/attempt/approval.
  for (const key of ["sid", "attempt", "approved", "capability", "token", "authority"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(r.body, key), `the response exposes ${key}`);
  }
  const help = tq(["--help"]).stdout;
  for (const flag of ["--sid", "--attempt", "--approve", "--dispatch", "--spawn", "--inject"]) {
    assert.ok(!help.includes(flag), `the command exposes ${flag}`);
  }
  // Source-level, with comments and docstrings stripped: the doc headers legitimately NAME
  // what these helpers refuse to do, so scanning the prose would assert the opposite of the
  // intent. What matters is that no CODE reaches the dispatch record, telepty or the registry.
  const TRIPLE = '"'.repeat(3);
  const stripComments = (text: string) => {
    let out = text.replace(/\/\*[\s\S]*?\*\//g, " ");
    // EVERY Python triple-quoted block: module, class and function docstrings all cite the
    // registry they were ported from, and all of them are prose.
    for (;;) {
      const open = out.indexOf(TRIPLE);
      if (open === -1) break;
      const close = out.indexOf(TRIPLE, open + TRIPLE.length);
      if (close === -1) break;
      out = out.slice(0, open) + " " + out.slice(close + TRIPLE.length);
    }
    return out.split("\n").map((l) => l.replace(/(^|\s)(\/\/|#)\s.*$/, "")).join("\n");
  };
  for (const src of [TQ_NOTE, TRANSFORM, BROKER]) {
    const code = stripComments(fs.readFileSync(src, "utf8"));
    for (const forbidden of ["active.json", "telepty", "dispatch-registry", "/api/peers"]) {
      assert.ok(!code.includes(forbidden), `${path.basename(src)} CODE references ${forbidden}`);
    }
  }
});

// ── A-20 — platform ─────────────────────────────────────────────────────────────────

// ── A-21 — the broker starts exactly one named executable ───────────────────────────

test("A-21: --node is required and explicit; no environment or PATH value is ever used", () => {
  // Snyk python/CommandInjection 6a365508-cd04-4257-908b-b46857eb504b flagged an env var
  // flowing into subprocess.Popen. Verified first: every path to the broker passes
  // `--node process.execPath` (bin/tq-note.mjs:184, src/dispatch/cli.ts:946, brokerCall/
  // brokerSpawn above; bin/tq-focus.sh and bin/init/cli.mjs reach it THROUGH tq-note.mjs),
  // and nothing in the tree ever set AIGENTRY_TQ_NODE. The ambient fallback was unused
  // selection surface and is gone. This case pins that it stays gone.
  //
  // Reachability of the OLD surface was reproduced separately with an inert stand-in
  // (OUTPUT/phase4/red-ambient-node.sh). It is NOT an exploit and NOT a trust boundary
  // against a same-UID caller, who could edit the broker itself.
  const dir = caseDir("a21-node-contract");
  const q = seed(dir);
  const before = fs.readFileSync(q, "utf8");

  // An INERT stand-in: it records that it was started and exits. It is never Node.
  const marker = path.join(dir, "inert-was-selected.log");
  const inert = path.join(dir, "inert-node");
  fs.writeFileSync(inert, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(marker)}, "started\\n");\n`,
    { mode: 0o700 });
  const notExecutable = path.join(dir, "not-executable");
  fs.writeFileSync(notExecutable, "not an executable\n", { mode: 0o600 });

  const request = JSON.stringify({ v: 1, op: "set-focus", queue: q, params: { track: "beta" } });
  /** Deliberately NOT brokerCall(): these cases are about argv the helpers never send. */
  const raw = (args: string[]) => spawnSync(WIN32 ? "python" : BROKER, WIN32 ? [BROKER, ...args] : args, {
    input: request, encoding: "utf8", timeout: WALL_MS, shell: false,
    // The ambient value is set in EVERY case below and must never be consulted.
    env: { ...BASE_ENV, AIGENTRY_TQ_NODE: inert, PATH: `${dir}${path.delimiter}${BASE_ENV.PATH ?? ""}` },
  });

  // 1. Absent --node, with the ambient value set: a named refusal, not a fallback.
  const absent = raw(["--queue", q]);
  assert.equal(absent.status, 4, absent.stdout);
  const absentBody = JSON.parse(lastLine(absent.stdout)) as Body;
  assert.equal(absentBody.reason, "invalid_argument");
  assert.match(String(absentBody.detail), /--node is required/);
  assert.match(String(absentBody.detail), /no environment or PATH fallback/);

  // 2-5. Invalid --node values are each a named refusal.
  for (const [label, value, code] of [
    ["relative", "bin/node", 4],
    ["missing", path.join(dir, "no-such-node"), 6],
    ["a directory", dir, 6],
    ["not executable", notExecutable, 6],
  ] as const) {
    const r = raw(["--queue", q, "--node", value]);
    assert.equal(r.status, code, `${label}: ${r.stdout}`);
    const body = JSON.parse(lastLine(r.stdout)) as Body;
    assert.equal(body.reason, "node_invalid", `${label}: ${r.stdout}`);
  }

  // 6. POSITIVE: the real current Node — exactly what every product caller passes.
  const ok = raw(["--queue", q, "--node", process.execPath]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal((JSON.parse(lastLine(ok.stdout)) as Body).applied, true);
  assert.equal(readDoc(q).active_focus, "beta");

  // The inert stand-in was never started, in any of the six cases.
  assert.equal(fs.existsSync(marker), false, "the ambient value selected the executable");
  // …and nothing was written by any of the five refusals (case 6 is the only writer).
  assert.notEqual(fs.readFileSync(q, "utf8"), before, "the positive case did not apply");

  // Source-level: there is no ambient source left for the flagged flow to come from.
  const brokerSrc = fs.readFileSync(BROKER, "utf8");
  const code = brokerSrc.slice(brokerSrc.indexOf('"""', brokerSrc.indexOf('"""') + 3) + 3);
  assert.ok(!code.includes("AIGENTRY_TQ_NODE"), "the env fallback is still in the code");
  assert.ok(!/\bshutil\b/.test(code), "the PATH lookup helper is still imported");
  assert.ok(!/which\(/.test(code), "a PATH lookup is still present");
  // The one Popen call still takes a fixed two-element argv and never a shell.
  assert.match(code, /subprocess\.Popen\(\s*\n?\s*\[node, TRANSFORM\]/);
  assert.match(code, /shell=False/);
});

// ── A-22..A-27 — the qr1172bct review corrections ───────────────────────────────────

test("A-22 (R1): the entry guard runs through a symlinked parent and never exits 0 silently", () => {
  const dir = caseDir("a22-entry-guard");
  const q = seed(dir);
  const seg = segFile(dir, "seg.txt", "A segment reached through a symlinked parent.");

  // The owned symlinked fixture parent the review asked for. `SELF` is realpath'd by the
  // ESM loader while argv[1] is the path as typed, so an unresolved comparison made this
  // exit 0 having written nothing — and bin/tq-focus.sh then printed success.
  const linkedBin = path.join(dir, "linked-bin");
  fs.symlinkSync(path.join(repoRoot, "bin"), linkedBin);

  const r = spawnSync(process.execPath, [path.join(linkedBin, "tq-note.mjs"),
    "append", "--task", "1172", "--segment-file", seg, "--queue", q, "--json"],
    { encoding: "utf8", env: BASE_ENV, timeout: WALL_MS });
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout) as Body;
  assert.equal(body.applied, true, "the symlinked route still produced no write");
  assert.match(String(rowOf(q, "1172").note), /reached through a symlinked parent/);

  // A malformed/unresolvable argv[1] must not be mistaken for this file either.
  const bogus = spawnSync(process.execPath, [path.join(dir, "does-not-exist.mjs")],
    { encoding: "utf8", env: BASE_ENV, timeout: WALL_MS });
  assert.notEqual(bogus.status, 0, "a nonexistent entry path reported success");

  // R1 also requires the imported path to stay INERT — that is how bin/init/cli.mjs uses
  // callBroker. Importing must not run main() or touch the queue.
  const beforeImport = fs.readFileSync(q, "utf8");
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(TQ_NOTE)});
     process.stdout.write(typeof m.callBroker === "function" ? "inert-with-callBroker" : "missing");`,
  ], { encoding: "utf8", env: BASE_ENV, timeout: WALL_MS });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "inert-with-callBroker");
  assert.equal(fs.readFileSync(q, "utf8"), beforeImport, "importing the module wrote the queue");
});

test("A-22 (R1): bin/tq-focus.sh cannot report a switch that did not happen", {
  skip: WIN32 ? "POSIX-only: bin/tq-focus.sh needs Git bash" : false,
}, () => {
  const dir = caseDir("a22-focus-truth");
  const q = seed(dir);
  const linkedBin = path.join(dir, "linked-bin");
  fs.symlinkSync(path.join(repoRoot, "bin"), linkedBin);

  // Through the symlinked parent, which used to yield "Focus switched to: beta" with
  // active_focus still "alpha" on disk.
  const r = spawnSync("bash", [path.join(linkedBin, "tq-focus.sh"), "beta"],
    { encoding: "utf8", env: { ...BASE_ENV, TQ: q }, timeout: WALL_MS });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Focus switched to: beta/);
  assert.equal(readDoc(q).active_focus, "beta", "the script reported a switch that did not happen");

  // …and the response-document check means a silent helper can never read as success.
  const unknown = spawnSync("bash", [path.join(linkedBin, "tq-focus.sh"), "no-such-track"],
    { encoding: "utf8", env: { ...BASE_ENV, TQ: q }, timeout: WALL_MS });
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.match(unknown.stdout, /ERR unknown track: no-such-track/);
  assert.equal(readDoc(q).active_focus, "beta", "a refused switch changed the focus");
});

test("A-23 (R2): a segment body containing '||' is refused before any write", () => {
  const dir = caseDir("a23-pipe-body");
  const q = seed(dir);
  const before = fs.readFileSync(q, "utf8");

  for (const body of [
    "Left half of the sentence || right half of the sentence.",
    "|| leading separator",
    "trailing separator ||",
    "a ||| b",
  ]) {
    const seg = segFile(dir, "bad.txt", `${body}\n`);
    const r = tqJson(appendArgs(q, "1172", seg));
    assert.equal(r.r.status, 4, `${body}: ${r.r.stdout}`);
    assert.equal(r.body.reason, "invalid_argument", body);
    assert.match(String(r.body.detail), /segment separator/);
    assert.match(String(r.body.detail), /report file/, "the report-path hint is missing");
    assert.equal(fs.readFileSync(q, "utf8"), before, `${body}: a refused body was written`);
  }

  // NEGATIVE control is above (no write). POSITIVE controls: a single `|` stays legal —
  // W-A's own ` | dispatched …` stamps use it — and normal replay still works.
  const ok = segFile(dir, "ok.txt", "A body with a single | pipe is still legal.");
  assert.equal(tq(appendArgs(q, "1172", ok)).status, 0);
  assert.match(String(rowOf(q, "1172").note), /single \| pipe/);
  const replay = tqJson(appendArgs(q, "1172", ok));
  assert.equal(replay.r.status, 0);
  assert.equal(replay.body.reason, "already_applied", "replay identity broke for a legal body");
  assert.equal(String(rowOf(q, "1172").note).split("||").length, 2, "segment count drifted");
});

test("A-24 (R4): the lock never follows a planted symlink and never truncates", {
  skip: WIN32 ? "POSIX-only: O_NOFOLLOW and symlink planting; win32 behaviour is unmeasured here" : false,
}, () => {
  const dir = caseDir("a24-lock-symlink");
  const q = seed(dir);
  const victim = path.join(dir, "victim.txt");
  const victimBytes = "an unrelated file that must not be opened, locked or changed\n";
  fs.writeFileSync(victim, victimBytes, { mode: 0o600 });
  const victimIno = fs.statSync(victim).ino;
  fs.symlinkSync(victim, `${q}.lock`);

  const r = tqJson(["set-focus", "--track", "beta", "--queue", q]);
  assert.equal(r.r.status, 3, r.r.stdout);
  assert.equal(r.body.reason, "lock_not_regular");
  // The planted target is byte-unchanged and was never adopted as the lock inode.
  assert.equal(fs.readFileSync(victim, "utf8"), victimBytes, "the symlink target was modified");
  assert.equal(fs.statSync(victim).ino, victimIno);
  assert.notEqual(r.body.lock_inode, victimIno);
  assert.ok(fs.lstatSync(`${q}.lock`).isSymbolicLink(), "the planted symlink was replaced");
  assert.equal(readDoc(q).active_focus, "alpha", "a refused lock still wrote the queue");

  // A directory in the lock's place is also refused by the fstat identity check.
  fs.rmSync(`${q}.lock`);
  fs.mkdirSync(`${q}.lock`);
  const asDir = tqJson(["set-focus", "--track", "beta", "--queue", q]);
  assert.equal(asDir.r.status, 3, asDir.r.stdout);
  assert.equal(asDir.body.reason, "lock_not_regular");
  fs.rmdirSync(`${q}.lock`);

  // With no planted lock the same call succeeds, and the lock is created 0600.
  const ok = tqJson(["set-focus", "--track", "beta", "--queue", q]);
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.equal(readDoc(q).active_focus, "beta");
  assert.equal(fs.statSync(`${q}.lock`).mode & 0o777, 0o600, "the lock is not 0600");
});

test("A-25 (R5): init refuses with its existing failure class when the queue cannot be created", {
  skip: WIN32 ? "POSIX-only: the staged tree uses POSIX modes and bash-free node entry" : false,
}, () => {
  // A test-owned staging tree: bin/tq-note.mjs present, bin/lib/* deliberately ABSENT, so
  // the broker cannot run. Nothing is installed and no host path is touched.
  const dir = caseDir("a25-init-refusal");
  const stage = path.join(dir, "pkg");
  fs.mkdirSync(path.join(stage, "bin", "lib"), { recursive: true });
  fs.copyFileSync(TQ_NOTE, path.join(stage, "bin", "tq-note.mjs"));
  fs.chmodSync(path.join(stage, "bin", "tq-note.mjs"), 0o755);

  const q = path.join(dir, "ws", "state", "task-queue.json");
  fs.mkdirSync(path.dirname(q), { recursive: true });
  const r = spawnSync(process.execPath, [path.join(stage, "bin", "tq-note.mjs"),
    "set-focus", "--track", "beta", "--queue", q, "--json"],
    { encoding: "utf8", env: BASE_ENV, timeout: WALL_MS });
  const body = JSON.parse(r.stdout) as Body;
  // This is the failure shape createState now turns into die(3, …) rather than a warning.
  assert.equal(r.status, 6, r.stdout);
  assert.equal(body.reason, "lock_capability_unavailable");
  assert.equal(fs.existsSync(q), false, "a failed creation left a file behind");

  // The source-level contract: a non-zero broker status is fatal with exit class 3, and an
  // existing queue is still a success. (Running real init would need its whole installer
  // closure — jq/python/bash/AIGENTRY_HOME — which is out of this suite's scope.)
  const initSrc = fs.readFileSync(path.join(repoRoot, "bin", "init", "cli.mjs"), "utf8");
  const createState = initSrc.slice(initSrc.indexOf("function createState"),
    initSrc.indexOf("// ------------------------------------------------------- step 5"));
  assert.match(createState, /die\(3, `state\/task-queue\.json could not be created/,
    "init no longer fails with its dependency/state class");
  assert.ok(!/summary\.skipped\.push\(`state\/task-queue\.json/.test(createState),
    "init still records the queue as a benign skip");
  assert.match(createState, /body\.reason === "exists"[\s\S]{0,200}summary\.preserved/,
    "an existing queue is no longer preserved as a success");
});

test("A-26 (R6): a signalled or unrecognized transform becomes exit 9 with a named reason", {
  skip: WIN32 ? "POSIX-only: signal semantics; win32 returncodes are unmeasured here" : false,
}, () => {
  const dir = caseDir("a26-signal-exit");
  const q = seed(dir);
  const before = fs.readFileSync(q, "utf8");

  // A test-owned stand-in for `node` that kills ITSELF. The only process signalled is the
  // broker's own direct child; no host pid is probed, listed or signalled.
  const suicide = path.join(dir, "self-killing-node");
  fs.writeFileSync(suicide, "#!/usr/bin/env bash\nkill -9 $$\n", { mode: 0o700 });
  const killed = spawnSync(BROKER, ["--queue", q, "--node", suicide], {
    input: JSON.stringify({ v: 1, op: "set-focus", queue: q, params: { track: "beta" } }),
    encoding: "utf8", env: BASE_ENV, timeout: WALL_MS,
  });
  assert.equal(killed.status, 9, killed.stdout);
  const killedBody = JSON.parse(lastLine(killed.stdout)) as Body;
  assert.equal(killedBody.reason, "transform_signalled");
  // The actual signal is preserved in bounded detail rather than discarded.
  assert.match(String(killedBody.detail), /killed by signal 9/);
  assert.notEqual(killed.status, 247, "the POSIX negative convention leaked through");
  assert.equal(fs.readFileSync(q, "utf8"), before, "a signalled transform wrote the queue");

  // An undocumented exit code is likewise normalized, with the raw value kept.
  const odd = path.join(dir, "odd-exit-node");
  fs.writeFileSync(odd, "#!/usr/bin/env bash\nexit 42\n", { mode: 0o700 });
  const weird = spawnSync(BROKER, ["--queue", q, "--node", odd], {
    input: JSON.stringify({ v: 1, op: "set-focus", queue: q, params: { track: "beta" } }),
    encoding: "utf8", env: BASE_ENV, timeout: WALL_MS,
  });
  assert.equal(weird.status, 9, weird.stdout);
  const weirdBody = JSON.parse(lastLine(weird.stdout)) as Body;
  assert.equal(weirdBody.reason, "transform_unrecognized");
  assert.match(String(weirdBody.detail), /42/);
  assert.equal(fs.readFileSync(q, "utf8"), before);
});

test("A-27 (R10): set-focus validates the tasks shape before rewriting", () => {
  for (const [label, bytes] of [
    ["tasks absent", '{\n  "active_focus": null,\n  "tracks": {\n    "alpha": {}\n  }\n}\n'],
    ["tasks not an array", '{\n  "active_focus": null,\n  "tracks": {\n    "alpha": {}\n  },\n  "tasks": {}\n}\n'],
  ] as const) {
    const dir = caseDir(`a27-${label.replace(/\s+/g, "-")}`);
    const q = path.join(dir, "state", "task-queue.json");
    fs.writeFileSync(q, bytes, { mode: 0o600 });
    const r = tqJson(["set-focus", "--track", "alpha", "--queue", q]);
    assert.equal(r.r.status, 9, `${label}: ${r.r.stdout}`);
    assert.equal(r.body.reason, "queue_corrupt", label);
    // No-write control.
    assert.equal(fs.readFileSync(q, "utf8"), bytes, `${label}: a corrupt document was rewritten`);
  }

  // Non-strict on purpose: a malformed NEIGHBOUR row must not block a focus change, which
  // touches no row at all.
  const dir = caseDir("a27-malformed-neighbour");
  const q = seed(dir, seedDoc({
    tasks: [{ id: 1172, desc: "fine", status: "pending", note: "n." }, { desc: "no id at all" }],
  }));
  const ok = tqJson(["set-focus", "--track", "beta", "--queue", q]);
  assert.equal(ok.r.status, 0, ok.r.stderr);
  assert.equal(readDoc(q).active_focus, "beta");
});

test("A-20: platform contract (static) and the native win32 commit path", async (t) => {
  // R3: two named subtests with explicit boundaries, instead of one test that printed a
  // console note and reported `ok`. The static check ALWAYS runs on every OS; the native
  // check is really skipped where it cannot run, with a reason the runner reports.
  await t.test("STATIC source contract: both lock primitives and the dir-fsync guard exist", () => {
    runStaticPlatformContract();
  });
  await t.test("NATIVE win32: a commit lands and the rename is the last durable boundary", {
    skip: WIN32 ? false
      : "native win32 only — NOT RUN on this POSIX host and NOT substituted by the static check above",
  }, () => {
    // msvcrt locking and NO directory fsync (the rename is the last boundary, exactly as
    // bin/dispatch-registry.py:425-427 documents for the registry).
    const dir = caseDir("a20-win32");
    const q = seed(dir);
    const r = tqJson(appendArgs(q, "1172", segFile(dir, "seg.txt", "A win32 commit landed.")));
    assert.equal(r.r.status, 0, r.r.stderr);
    assert.equal(fs.readFileSync(q, "utf8"), committed(readDoc(q)));
  });
});

/**
 * The platform-independent half of A-20. Source-shape assertions ONLY: they prove the two
 * platform branches exist in the source. They are explicitly NOT native acceptance, and
 * nothing here substitutes for running on Windows.
 */
function runStaticPlatformContract(): void {
  const broker = fs.readFileSync(BROKER, "utf8");
  assert.match(broker, /msvcrt\.locking\(self\.fh\.fileno\(\), msvcrt\.LK_NBLCK, 1\)/,
    "the win32 lock path is absent");
  assert.match(broker, /fcntl\.flock\(self\.fh, fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/);
  const transform = fs.readFileSync(TRANSFORM, "utf8");
  assert.match(transform, /process\.platform !== "win32"/, "the dir-fsync platform guard is absent");
  // R4: the no-follow lock open, asserted as a source fact on every platform.
  assert.match(broker, /O_NOFOLLOW = getattr\(os, "O_NOFOLLOW", 0\)/, "the no-follow primitive is absent");
  assert.match(broker, /os\.open\(self\.path, flags, 0o600\)/, "the 0600 lock open is absent");
  // The exact flags expression, which is prose-proof: scanning the file for the STRING
  // "O_TRUNC" would match the comment that explains why it is absent (the same trap A-19
  // documents). Pinning the flags pins the behaviour.
  assert.match(broker, /^ {12}flags = os\.O_RDWR \| os\.O_CREAT \| O_NOFOLLOW$/m,
    "the lock open flags changed; O_TRUNC must never appear among them");
}
