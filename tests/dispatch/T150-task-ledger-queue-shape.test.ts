// T150 (#1110 follow-up) — the auto-ledger must write state/task-queue.json in the SHAPE
// the file is committed in, so a dispatch does not churn the whole file.
//
// Measured 2026-09-06 while rebasing #1110: main re-serialised the queue from indent=1 to
// indent=2 + trailing newline (a 13326/13326 whole-file diff). taskLedgerUpdate still wrote
// `JSON.stringify(data, null, 1)`, so the next successful `--task` dispatch would have
// rewritten all 26k lines back and dropped the trailing newline — two writers, two shapes,
// alternating, with the real change buried in the churn every other commit.
//
// This reaches the real ledger write: T140's fixture drives a fully stubbed but SUCCESSFUL
// dispatch (`--task 1083`), and taskLedgerUpdate runs at the end of it. The assertion is
// byte-identity, not a shape guess — the file must equal its own re-serialisation in the
// committed shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fixture } from "./model-router-fixtures.js";

/** The shape state/task-queue.json is committed in: 2-space indent, trailing newline. */
const committed = (doc: unknown) => JSON.stringify(doc, null, 2) + "\n";

const seed = {
  main_topics: ["t150"],
  tasks: [
    { id: 1083, desc: "the row the dispatch ledgers", priority: "P1", status: "pending", note: "seed" },
    { id: 1084, desc: "an untouched neighbour", priority: "P2", status: "done", note: "seed" },
  ],
  completed: [],
  schema_version: 2,
};

test("T150: a successful dispatch leaves the queue in the committed shape (indent 2 + trailing newline)", () => {
  const f = fixture();
  try {
    writeFileSync(f.queue, committed(seed));
    const r = f.dispatch(f.spawnArgs);
    assert.equal(r.status, 0, r.stderr);

    const raw = readFileSync(f.queue, "utf8");
    const doc = JSON.parse(raw) as typeof seed;

    // The ledger really ran — otherwise this test proves nothing about the write path.
    assert.equal(doc.tasks[0]!.status, "delegated", `the ledger did not promote the row: ${doc.tasks[0]!.status}`);
    assert.match(doc.tasks[0]!.note, /dispatched /, doc.tasks[0]!.note);

    // …and it wrote the file in the shape it found it in, byte for byte.
    assert.equal(raw, committed(doc), "the ledger re-serialised the queue into a different shape");
    assert.ok(raw.endsWith("}\n"), "the ledger dropped the trailing newline");
    assert.match(raw, /^\{\n {2}"main_topics"/, "the ledger did not write 2-space indent");

    // Rule 29 at runtime: the neighbour row is untouched.
    assert.deepEqual(doc.tasks[1], seed.tasks[1]);
  } finally {
    f.cleanup();
  }
});
