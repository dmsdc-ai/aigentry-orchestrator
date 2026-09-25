// T149 (#1110) — an ambiguous task id must REFUSE, never resolve to the first match.
//
// Measured 2026-09-06 on state/task-queue.json (1113 rows): ids 115/515/516/517/522/524/
// 528/529 each existed twice with unrelated bodies. `tasks.find(String(id) === taskId)`
// answers with the FIRST row, and for 7 of those 8 the first row is desc-less (4 of them
// still `pending`) while the row a human means is the second, `done` one. So `--task 522`
// passed the gate against a row nobody meant — the gate answered a different question
// than the one asked, which is worse than having no gate.
//
// Two find sites shared the defect: taskQueueStatus (the gate read) and taskLedgerUpdate
// (the post-dispatch WRITE — a first-match write is the worse half). Both now count, and
// they act differently because they sit on opposite sides of the inject: the gate refuses,
// the ledger warns and skips its write (it runs after the dispatch has landed, so it must
// never fail one). The ledger arm has NO case below and cannot get one: the gate refuses
// an ambiguous id in every mode, so no CLI path reaches the ledger with one, and cli.ts
// runs main() at import so the function cannot be called directly either. What is testable
// is the guarantee that makes it unreachable — case (a) asserts the queue is never written.
//
// The refusal is rc 5 and it holds in AIGENTRY_TASK_GATE=warn and =off as well: those
// modes choose how strict the gate is about a KNOWN row, they cannot choose WHICH of two
// rows was meant. An ambiguous id is undecidable input, not a gate-mode decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../../..");
const DISPATCH = join(REPO, "bin/dispatch.sh");
const DUP_ID = "522";
// The shape that made #1110 dangerous: first row desc-less and pending, second row the
// real one. First-match resolution reads row 0; a human typing 522 means row 1.
const FIRST_DESC = "";
const SECOND_DESC = "Pre-existing test failures (NOT this session's regression — measured on main)";

function harness() {
  const root = mkdtempSync(join(tmpdir(), "task-gate-dup-1110-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  const queue = join(root, "queue.json");
  const ref = join(root, "ref.md");
  const calls = join(root, "telepty-calls.log");
  writeFileSync(ref, "T149 fixture ref\n");
  writeFileSync(calls, "");
  writeFileSync(
    queue,
    JSON.stringify(
      {
        main_topics: ["t149"],
        tasks: [
          { id: 522, desc: FIRST_DESC, priority: "P1", status: "pending", note: "seed-first" },
          { id: 522, desc: SECOND_DESC, priority: "P1", status: "done", note: "seed-second" },
          { id: "522b", desc: "the renamed second row", priority: "P1", status: "pending", note: "seed-renamed" },
          { id: 900, desc: "unique pending", priority: "P1", status: "pending", note: "seed-unique" },
          { id: 901, desc: "unique finished", priority: "P2", status: "done", note: "seed-stale" },
        ],
        completed: [],
        schema_version: 2,
      },
      null,
      1,
    ),
  );
  // Lists no sessions, so a dispatch that PASSES the gate dies later with a distinct
  // message. That later death is the proof the gate let the id through.
  const telepty = join(bin, "telepty");
  writeFileSync(
    telepty,
    "#!/usr/bin/env node\n" +
      "const fs=require('node:fs');fs.appendFileSync(process.env.CALLS_LOG,process.argv.slice(2).join(' ')+'\\n');\n" +
      "if(process.argv[2]==='list')process.stdout.write('[]');else process.exit(9);\n",
    { mode: 0o755 },
  );

  return {
    /** Runs the real shim; `mode` is AIGENTRY_TASK_GATE (unset = hard). */
    run: (taskId: string, mode?: string) => {
      writeFileSync(calls, "");
      const r = spawnSync(
        DISPATCH,
        ["--target", "sid-t149", "--ref", ref, "--from", "t149", "--timeout-ms", "500", "--no-verify-started",
         "--task", taskId],
        {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env, HOME: join(root, "home"), AIGENTRY_TASK_QUEUE: queue, TELEPTY: telepty,
            CALLS_LOG: calls, ...(mode ? { AIGENTRY_TASK_GATE: mode } : {}),
          },
        },
      );
      return { rc: r.status, err: r.stderr ?? "", calls: readFileSync(calls, "utf8") };
    },
    queue: () => readFileSync(queue, "utf8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The gate let the id through iff the run died later, on the empty session list. */
const PASSED_GATE = /never registered in telepty list/;

test("T149(a): a duplicated id is refused with rc 5, naming both indices and both desc heads", () => {
  const h = harness();
  try {
    const before = h.queue();
    const { rc, err, calls } = h.run(DUP_ID);
    assert.equal(rc, 5, `expected rc 5 for an ambiguous id, got ${rc}: ${err}`);
    assert.match(err, /matches 2 rows/, err);
    assert.ok(err.includes("idx 0"), `the refusal must name the first row: ${err}`);
    assert.ok(err.includes("idx 1"), `the refusal must name the second row: ${err}`);
    assert.ok(err.includes(`("${FIRST_DESC}")`), `the refusal must quote the first desc head: ${err}`);
    assert.ok(err.includes(`("${SECOND_DESC.slice(0, 40)}")`), `the refusal must quote the second desc head: ${err}`);
    assert.ok(err.includes(`'${DUP_ID}b'`), `the refusal must name the rename remedy: ${err}`);
    // Refused BEFORE any side effect: no dispatch attempt, and the ledger never wrote.
    assert.doesNotMatch(err, PASSED_GATE, `an ambiguous id reached the dispatch path: ${err}`);
    assert.equal(calls, "", `an ambiguous id called telepty: ${calls}`);
    assert.equal(h.queue(), before, "an ambiguous id must not write the queue");
  } finally {
    h.cleanup();
  }
});

test("T149(b): warn and off cannot resolve an ambiguous id either — undecidable input, not gate policy", () => {
  const h = harness();
  try {
    for (const mode of ["warn", "off"]) {
      const { rc, err } = h.run(DUP_ID, mode);
      assert.equal(rc, 5, `AIGENTRY_TASK_GATE=${mode} resolved an ambiguous id (rc ${rc}): ${err}`);
      assert.match(err, /Ambiguous task id — not a gate mode decision/, err);
      assert.doesNotMatch(err, PASSED_GATE, `AIGENTRY_TASK_GATE=${mode} routed on the first match: ${err}`);
    }
  } finally {
    h.cleanup();
  }
});

test("T149(c): the renamed id resolves to its own row", () => {
  const h = harness();
  try {
    const { rc, err } = h.run(`${DUP_ID}b`);
    assert.notEqual(rc, 5, `522b is unique and must not be refused as ambiguous: ${err}`);
    assert.match(err, PASSED_GATE, `522b did not resolve: ${err}`);
    assert.doesNotMatch(err, /task-gate/, `522b was rejected by the gate: ${err}`);
  } finally {
    h.cleanup();
  }
});

test("T149(d): unique ids keep their existing rc — pending passes, done is 4, unknown is 4", () => {
  const h = harness();
  try {
    const pending = h.run("900");
    assert.notEqual(pending.rc, 5, `a unique pending id must not be refused: ${pending.err}`);
    assert.match(pending.err, PASSED_GATE, `a unique pending id no longer passes the gate: ${pending.err}`);

    const stale = h.run("901");
    assert.equal(stale.rc, 4, stale.err);
    assert.match(stale.err, /is already 'done' — stale-id reuse/, stale.err);

    const unknown = h.run("999");
    assert.equal(unknown.rc, 4, unknown.err);
    assert.match(unknown.err, /unknown task id '999'/, unknown.err);
  } finally {
    h.cleanup();
  }
});
