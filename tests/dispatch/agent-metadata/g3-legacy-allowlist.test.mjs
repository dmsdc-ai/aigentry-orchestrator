// #1162 r2 delta — G3. REAL compiled reconciler (dist/ of this tree) on a hermetic
// fixture with a REAL filesystem under the sessions root. Rule under test (dispatch
// r2): only a TRUE ABSENCE (ENOENT) of the staging record is the documented
// unsupported case that may take the bounded legacy connection pill. An existing but
// invalid/unreadable stage (symlink, dir, FIFO, EACCES, ENOTDIR) must not legacy-write.
// Duplicate-sid rows must not unlock another row's workspace.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { mkfifo } from "./support/harness.mjs";
import { NOW, runReconciler, whCalls } from "./support/reconciler.mjs";

const row = (id, ws, health = "CONNECTED") => ({ id, healthStatus: health, cmuxWorkspaceId: ws, startedAt: NOW });
function clean(t) {
  assert.equal(t.r.status, 0, `tick rc=${t.r.status} ${t.r.stderr}`);
  assert.equal(t.tripwire, "", "tripwire hit");
  assert.ok(!t.calls.some((c) => c.unexpected), JSON.stringify(t.calls.filter((c) => c.unexpected)));
}
const pills = (t) => whCalls(t.calls, "set-status").map((c) => c.argv.slice(1).join(" "));

// ── true absence (positive controls) ────────────────────────────────────────
test("G3R2-FS-0a positive control: stage dir absent (ENOENT) → bounded legacy pill", () => {
  const t = runReconciler("g3r2fs0a", { sessions: [row("s1", "wa")], live: [], capsRc: 0 });
  clean(t);
  assert.deepEqual(pills(t), ["wa connected"]);
});

test("G3R2-FS-0b positive control: stage exists, sandbox-current.json absent (ENOENT) → bounded legacy pill", () => {
  const t = runReconciler("g3r2fs0b", { sessions: [row("s1", "wa")], live: [], capsRc: 0 },
    { prepare: (run, root) => fs.mkdirSync(path.join(root, "s1"), { mode: 0o700 }) });
  clean(t);
  assert.deepEqual(pills(t), ["wa connected"]);
});

// ── existing but invalid / unreadable (must NOT legacy) ─────────────────────
const INVALID = [
  ["sandbox-current.json is a symlink to a valid record", (run, root) => {
    const cur = path.join(root, "s1", "sandbox-current.json");
    const real = path.join(run.dir, "current-real.json");
    fs.renameSync(cur, real);
    fs.symlinkSync(real, cur);
  }],
  ["sandbox-current.json is a dangling symlink", (run, root) => {
    const cur = path.join(root, "s1", "sandbox-current.json");
    fs.rmSync(cur);
    fs.symlinkSync(path.join(run.dir, "nowhere.json"), cur);
  }],
  ["sandbox-current.json is a directory", (run, root) => {
    const cur = path.join(root, "s1", "sandbox-current.json");
    fs.rmSync(cur);
    fs.mkdirSync(cur);
  }],
  ["sandbox-current.json is a FIFO", (run, root) => {
    const cur = path.join(root, "s1", "sandbox-current.json");
    fs.rmSync(cur);
    const r = require_mkfifo(cur);
    assert.equal(r, 0);
  }],
  ["stage unreadable (mode 000 ⇒ EACCES)", (run, root) => { fs.chmodSync(path.join(root, "s1"), 0o000); }],
  ["stage is a regular file (ENOTDIR)", (run, root) => {
    fs.rmSync(path.join(root, "s1"), { recursive: true });
    fs.writeFileSync(path.join(root, "s1"), "not a dir\n", { mode: 0o600 });
  }],
];

const require_mkfifo = mkfifo;

for (const [name, mutate] of INVALID) {
  test(`G3R2-FS-1 existing-but-invalid stage must NOT take the legacy pill: ${name}`, () => {
    const t = runReconciler("g3r2fs1", { sessions: [row("s1", "wa")], live: [], capsRc: 0, sealed: ["s1"] }, { prepare: mutate });
    clean(t);
    assert.deepEqual(pills(t), [], `REPRODUCED: invalid/unreadable existing stage fell back to a legacy write: ${JSON.stringify(pills(t))}`);
  });
}

// ── exit-code allowlist (r2 contract) ───────────────────────────────────────
for (const rc of [10, 30, 1, 127, 137]) {
  test(`G3R2-RC set rc ${rc} → no legacy pill`, () => {
    const t = runReconciler("g3r2rc", { sessions: [row("s1", "wa")], live: [], capsRc: 0, setRc: { s1: rc }, sealed: ["s1"] });
    clean(t);
    assert.deepEqual(pills(t), []);
  });
}
for (const capsRc of [30, 1, 127, 97]) {
  test(`G3R2-CAPS caps rc ${capsRc} → no set and no legacy pill (sealed and unsealed rows)`, () => {
    const t = runReconciler("g3r2caps", { sessions: [row("s1", "wa"), row("s2", "wb")], live: [], capsRc, sealed: ["s1"] });
    clean(t);
    assert.deepEqual(whCalls(t.calls, "agent-meta-set"), []);
    assert.deepEqual(pills(t), []);
  });
}
test("G3R2-CAPS20 caps 20 → bounded connection pill for every row, no set, never idle/working", () => {
  const t = runReconciler("g3r2caps20", { sessions: [row("s1", "wa"), row("s2", "wb", "DISCONNECTED")], live: [], capsRc: 20, sealed: ["s1"] });
  clean(t);
  assert.deepEqual(whCalls(t.calls, "agent-meta-set"), []);
  assert.deepEqual(pills(t), ["wa connected", "wb disconnected"]);
});

// ── duplicate rows ──────────────────────────────────────────────────────────
const DUP = [
  ["same sid, set 20 then 10 → only the unsupported row's workspace", [row("s1", "wa"), row("s1", "wb")], [20, 10], ["wa connected"]],
  ["same sid, set 10 then 20 → only the unsupported row's workspace", [row("s1", "wa"), row("s1", "wb")], [10, 20], ["wb connected"]],
  ["same sid, set 10 twice → none", [row("s1", "wa"), row("s1", "wb")], [10, 10], []],
  ["same sid, set 0 then 30 → none", [row("s1", "wa"), row("s1", "wb")], [0, 30], []],
];
for (const [name, sessions, seq, want] of DUP) {
  test(`G3R2-DUP ${name}`, () => {
    const t = runReconciler("g3r2dup", { sessions, live: [], capsRc: 0, setRc: { s1: seq }, sealed: ["s1"] });
    clean(t);
    assert.equal(whCalls(t.calls, "agent-meta-set").length, 2);
    assert.deepEqual(pills(t), want);
  });
}

test("G3R2-DUP-WS a non-subject row naming the SAME workspace as a refused sealed row must not write it", () => {
  const t = runReconciler("g3r2dupws", {
    sessions: [row("s1", "wa"), row("-not-v1", "wa")], live: [], capsRc: 0, setRc: { s1: 10 }, sealed: ["s1"],
  });
  clean(t);
  assert.deepEqual(pills(t), [], `REPRODUCED: refused row's workspace written via another row: ${JSON.stringify(pills(t))}`);
});

// ── legacy `unknown` pill emission (feeds the wrapper gap R2-C04) ───────────
test("G3R2-UNK unknown health on a non-subject row → reconciler emits `set-status <ws> unknown` (characterized)", () => {
  const t = runReconciler("g3r2unk", { sessions: [row("s9", "wz", "STALE")], live: [], capsRc: 0 });
  clean(t);
  assert.deepEqual(pills(t), ["wz unknown"]);
});
