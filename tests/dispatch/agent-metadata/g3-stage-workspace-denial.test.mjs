// #1162 r3 delta — G3. REAL compiled reconciler (dist/ of this tree) on the same
// hermetic fixture as g3-legacy-allowlist (support/reconciler.mjs), REAL filesystem under the
// sessions root. Accepted controller contract (r3):
//   * only a TRUE absence (ENOENT of the stage root, or of sandbox-current.json in a
//     real directory) may take the bounded legacy pill; every other stage shape
//     (root symlink, non-dir root, non-regular record, any other lstat error) is
//     failed-closed: no set call, no pill, a fixed reason token, no path text;
//   * a legacy workspace write is DENIED when any co-located row of the same
//     snapshot did not explicitly qualify, whatever its sid.
// No ownership is inferred from aliases/surfaces; those limits are not asserted here.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { mkfifo as mkfifoAt } from "./support/harness.mjs";
import { NOW, runReconciler, whCalls } from "./support/reconciler.mjs";

const row = (id, ws, health = "CONNECTED") => ({ id, healthStatus: health, cmuxWorkspaceId: ws, startedAt: NOW });
function clean(t) {
  assert.equal(t.r.status, 0, `tick rc=${t.r.status} ${t.r.stderr}`);
  assert.equal(t.tripwire, "", "tripwire hit");
  assert.ok(!t.calls.some((c) => c.unexpected), JSON.stringify(t.calls.filter((c) => c.unexpected)));
}
const pills = (t) => whCalls(t.calls, "set-status").map((c) => c.argv.slice(1).join(" "));
const sets = (t) => whCalls(t.calls, "agent-meta-set").map((c) => c.argv[1]);
const mkfifo = (p) => assert.equal(mkfifoAt(p), 0);
const cur = (root, sid = "s1") => path.join(root, sid, "sandbox-current.json");

// ── stage inspection: every non-ENOENT shape fails closed with a fixed token ──
const INVALID = [
  ["root is a symlink to a VALID sealed stage", "invalid-stage-not-dir", (run, root) => {
    const real = path.join(run.dir, "real-stage-s1");
    fs.renameSync(path.join(root, "s1"), real);
    fs.symlinkSync(real, path.join(root, "s1"));
  }],
  ["root is a dangling symlink", "invalid-stage-not-dir", (run, root) => {
    fs.rmSync(path.join(root, "s1"), { recursive: true });
    fs.symlinkSync(path.join(run.dir, "nowhere"), path.join(root, "s1"));
  }],
  ["root is a FIFO", "invalid-stage-not-dir", (run, root) => {
    fs.rmSync(path.join(root, "s1"), { recursive: true });
    mkfifo(path.join(root, "s1"));
  }],
  ["root is a regular file", "invalid-stage-not-dir", (run, root) => {
    fs.rmSync(path.join(root, "s1"), { recursive: true });
    fs.writeFileSync(path.join(root, "s1"), "x\n", { mode: 0o600 });
  }],
  ["record is a symlink to a valid record", "invalid-current-not-file", (run, root) => {
    const real = path.join(run.dir, "current-real.json");
    fs.renameSync(cur(root), real);
    fs.symlinkSync(real, cur(root));
  }],
  ["record is a dangling symlink", "invalid-current-not-file", (run, root) => {
    fs.rmSync(cur(root));
    fs.symlinkSync(path.join(run.dir, "nowhere.json"), cur(root));
  }],
  ["record is a self-referencing symlink (loop)", "invalid-current-not-file", (run, root) => {
    fs.rmSync(cur(root));
    fs.symlinkSync("sandbox-current.json", cur(root));
  }],
  ["record is a directory", "invalid-current-not-file", (run, root) => {
    fs.rmSync(cur(root));
    fs.mkdirSync(cur(root));
  }],
  ["record is a FIFO (must not block)", "invalid-current-not-file", (run, root) => {
    fs.rmSync(cur(root));
    mkfifo(cur(root));
  }],
  ["stage mode 000 (EACCES)", "invalid-EACCES", (run, root) => { fs.chmodSync(path.join(root, "s1"), 0o000); }],
];
for (const [name, token, mutate] of INVALID) {
  test(`G3R3-FS invalid stage fails closed (${token}): ${name}`, () => {
    const t = runReconciler("g3r3fs", { sessions: [row("s1", "wa")], live: [], capsRc: 0, sealed: ["s1"] }, { prepare: mutate });
    clean(t);
    assert.deepEqual(sets(t), [], "no set call on an invalid stage");
    assert.deepEqual(pills(t), [], `invalid stage took the legacy pill: ${JSON.stringify(pills(t))}`);
    assert.match(t.r.stderr, new RegExp(`agent-meta: applied=0 no_staging=0 refused=\\[\\] unsupported=\\[\\] failed=\\[s1:${token}\\]`));
    assert.ok(!t.r.stderr.includes(t.run.dir), "path text leaked into the log");
  });
}

test("G3R3-FS-ctl an invalid stage denies only its own workspace; a truly absent stage elsewhere keeps its pill", () => {
  const t = runReconciler("g3r3fsctl", { sessions: [row("s1", "wa"), row("s2", "wb")], live: [], capsRc: 0, sealed: ["s1"] },
    { prepare: (run, root) => { fs.rmSync(cur(root)); fs.mkdirSync(cur(root)); } });
  clean(t);
  assert.deepEqual(pills(t), ["wb connected"]);
  assert.match(t.r.stderr, /no_staging=1 .*failed=\[s1:invalid-current-not-file\]/);
});

// ── shared workspace: any non-qualifying co-located row denies the host id ────
const WS = [
  ["applied (rc 0) sealed row + non-subject row on the same workspace", [row("s1", "wa"), row("-x", "wa")], { s1: 0 }, ["s1"], []],
  ["refused (rc 10) sealed row + truly-absent-stage v1 row on the same workspace", [row("s1", "wa"), row("s2", "wa")], { s1: 10 }, ["s1"], []],
  ["failed (rc 30) row listed AFTER the eligible row (order-independent)", [row("-x", "wa"), row("s1", "wa")], { s1: 30 }, ["s1"], []],
  ["DISCONNECTED non-subject row + applied row", [row("s1", "wa"), row("-x", "wa", "DISCONNECTED")], { s1: 0 }, ["s1"], []],
  ["applied row on wa does not deny a non-subject row on wb (control)", [row("s1", "wa"), row("-x", "wb")], { s1: 0 }, ["s1"], ["wb connected"]],
  ["two eligible rows (set 20 + non-subject) on the same workspace both write as before", [row("s1", "wa"), row("-x", "wa")], { s1: 20 }, ["s1"], ["wa connected", "wa connected"]],
  ["refused row with a tab-suffixed id denies the host id it would write", [row("s1", "wa\tjunk"), row("-x", "wa")], { s1: 10 }, ["s1"], []],
  ["refused row with a multi-line id denies every host id it would write", [row("s1", "wa\nwb"), row("-x", "wb"), row("-y", "wc")], { s1: 10 }, ["s1"], ["wc connected"]],
  ["a refused row without cmuxWorkspaceId neither writes nor denies", [{ id: "s1", healthStatus: "CONNECTED", startedAt: NOW }, row("-x", "wa")], { s1: 10 }, ["s1"], ["wa connected"]],
];
for (const [name, sessions, setRc, sealed, want] of WS) {
  test(`G3R3-WS ${name}`, () => {
    const t = runReconciler("g3r3ws", { sessions, live: [], capsRc: 0, setRc, sealed });
    clean(t);
    assert.deepEqual(pills(t), want);
  });
}

test("G3R3-WS-inv invalid-stage row + non-subject row on the same workspace → nothing written", () => {
  const t = runReconciler("g3r3wsinv", { sessions: [row("s1", "wa"), row("-x", "wa")], live: [], capsRc: 0, sealed: ["s1"] }, {
    prepare: (run, root) => { fs.chmodSync(path.join(root, "s1"), 0o000); },
  });
  clean(t);
  assert.deepEqual(sets(t), []);
  assert.deepEqual(pills(t), []);
});

// ── dry-run / shadow stay inert on the r3 path ───────────────────────────────
for (const args of [["--once", "--dry-run"], ["--shadow"]]) {
  test(`G3R3-DRY ${args.join(" ")} with an invalid stage and a shared workspace: no agent-meta, no pill`, () => {
    const t = runReconciler("g3r3dry", { sessions: [row("s1", "wa"), row("-x", "wa"), row("s2", "wb")], live: [], capsRc: 0, sealed: ["s1"] }, {
      args, prepare: (run, root) => { fs.rmSync(cur(root)); fs.mkdirSync(cur(root)); },
    });
    clean(t);
    assert.deepEqual(whCalls(t.calls).filter((c) => c.argv[0] !== "prune-orphans").map((c) => c.argv), []);
  });
}
