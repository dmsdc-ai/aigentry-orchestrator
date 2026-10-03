// #1162 G3 — the REAL compiled reconciler tick in a hermetic fixture (support/reconciler.mjs):
// status mapping from ALREADY-read snapshots, no extra probe/registry reads, DRY_RUN /
// shadow send nothing, caps≠0 and no-staging fall back without set calls, and the
// command stream differs from the pre-#1162 reconciler only by the metadata verbs and
// the idle→connected pill change. The pre-#1162 stream (M-02) is pinned as measured
// from the release baseline compiled with the same fixture.
import assert from "node:assert/strict";
import { test } from "node:test";

import { NOW, NOW_EPOCH, runReconciler, whCalls } from "./support/reconciler.mjs";

// Measured from the pre-#1162 release reconciler on the M-02 scenario below.
const BASELINE_NON_WH = [
  "dispatch-registry.py list --live --fields assigned.sid,lifecycle.state,ref_path,re_dispatch_count",
  "session-probe.py --sid s1", "policy.py --status delivered --state -",
  "session-probe.py --sid s2", "policy.py --status delivered --state -",
  "telepty list --json",
  "dispatch-registry.py list --not-retired --fields assigned.sid",
  "dispatch-registry.py list --keep-alive --fields assigned.sid",
];
const VIEW = "cmux:current-viewport";
const probe = (surface, detail = { screen_source: VIEW }) => ({ alive: true, ready: true, surface, activity: "static", cli: "claude", detail });
const row = (id, health, ws) => ({ id, healthStatus: health, cmuxWorkspaceId: ws, startedAt: NOW });

function clean(t) {
  assert.equal(t.r.status, 0, `tick rc=${t.r.status} ${t.r.stderr}`);
  assert.equal(t.tripwire, "", "tripwire hit");
  assert.ok(!t.calls.some((c) => c.unexpected), JSON.stringify(t.calls.filter((c) => c.unexpected)));
}
const statusOf = (t, sid) => {
  const c = whCalls(t.calls, "agent-meta-set").filter((x) => x.argv[1] === sid);
  assert.equal(c.length, 1, `one set for ${sid}`);
  return JSON.parse(c[0].argv[5]);
};

const MAP = [
  ["CONNECTED + current-viewport idle", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "delivered" }], probe("idle"),
    { connection: "connected", activity: "idle", activity_source: "probe:current-viewport", dispatch: "delivered" }],
  ["CONNECTED never becomes idle without a current probe (probe_error)", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "delivered" }],
    probe("idle", { screen_source: VIEW, probe_error: "session is not locally connected and ready" }),
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "delivered" }],
  ["probe from a non-current source → unknown", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "delivered" }], probe("working", { screen_source: "telepty:read-screen" }),
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "delivered" }],
  ["session-probe produced nothing (reconciler fallback) → unknown", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "delivered" }], undefined,
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "delivered" }],
  ["surface outside r2 list → unknown", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "delivered" }], probe("busy"),
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "delivered" }],
  ["no dispatch row → dispatch none, no probe → activity unknown", row("s1", "CONNECTED", "wa"), [], undefined,
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "none" }],
  ["multiple dispatch rows → multiple", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "delivered" }, { sid: "s1", state: "acked" }], probe("working"),
    { connection: "connected", activity: "working", activity_source: "probe:current-viewport", dispatch: "multiple" }],
  ["dispatch done is a label, never activity/completion", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "done" }], undefined,
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "done" }],
  ["dispatch state with odd charset → unknown", row("s1", "CONNECTED", "wa"), [{ sid: "s1", state: "Done-1" }], undefined,
    { connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "unknown" }],
  ["DISCONNECTED", row("s1", "DISCONNECTED", "wa"), [], undefined,
    { connection: "disconnected", activity: "unknown", activity_source: "unknown", dispatch: "none" }],
  ["unknown health (STALE) → connection unknown", row("s1", "STALE", "wa"), [], undefined,
    { connection: "unknown", activity: "unknown", activity_source: "unknown", dispatch: "none" }],
  ["health absent → unknown", { id: "s1", cmuxWorkspaceId: "wa", startedAt: NOW }, [], undefined,
    { connection: "unknown", activity: "unknown", activity_source: "unknown", dispatch: "none" }],
];
for (const [name, session, live, pr, expected] of MAP) {
  test(`G3-M-01 status mapping: ${name}`, () => {
    const t = runReconciler("g3m01", { sessions: [session], live, probe: pr ? { s1: pr } : {}, capsRc: 0, setRc: { s1: 0 }, sealed: ["s1"] });
    clean(t);
    assert.deepEqual(statusOf(t, "s1"), { ...expected, read_at: NOW_EPOCH });
    // probes: exactly one per registry row, none added by the metadata push
    assert.equal(t.calls.filter((c) => c.role === "session-probe.py").length, live.length);
  });
}

test("G3-M-02 no extra registry/probe/telepty reads; metadata verbs are the only new wh calls (vs pre-#1162 baseline)", () => {
  const scen = {
    sessions: [row("s1", "CONNECTED", "wa"), row("s2", "DISCONNECTED", "wb"), row("s3", "CONNECTED", "wc")],
    live: [{ sid: "s1", state: "delivered" }, { sid: "s2", state: "delivered" }],
    probe: { s1: probe("idle"), s2: probe("working") },
    capsRc: 0, setRc: { s1: 0, s2: 20 }, sealed: ["s1", "s2"],
  };
  const cand = runReconciler("g3m02c", scen);
  clean(cand);
  const nonWh = (t) => t.calls.filter((c) => c.role !== "wh-cli.sh").map((c) => `${c.role} ${c.argv.join(" ")}`);
  assert.deepEqual(nonWh(cand), BASELINE_NON_WH, "candidate must not add registry/probe/policy/telepty calls");
  const wh = (t) => whCalls(t.calls).map((c) => c.argv[0] === "agent-meta-set" ? `agent-meta-set ${c.argv[1]}` : c.argv.join(" "));
  // pre-#1162 wh stream was: prune-orphans, set-status wa idle, wb disconnected, wc idle
  assert.deepEqual(wh(cand), [
    "prune-orphans orchestrator,s1,s2,s3 ", "agent-meta-caps", "agent-meta-set s1", "agent-meta-set s2",
    // s1 applied → no pill; s2 unsupported → bounded pill; s3 has no staging → pill
    "set-status wb disconnected", "set-status wc connected",
  ]);
  for (const c of whCalls(cand.calls, "set-status")) assert.ok(!["idle", "working"].includes(c.argv[2]), "CONNECTED never idle/working");
});

test("G3-M-03a caps 20 (unsupported) → no set call; bounded legacy connection pill", () => {
  const t = runReconciler("g3m03a", { sessions: [row("s1", "CONNECTED", "wa")], live: [], capsRc: 20, sealed: ["s1"] });
  clean(t);
  assert.deepEqual(whCalls(t.calls, "agent-meta-set"), []);
  assert.deepEqual(whCalls(t.calls, "set-status").map((c) => c.argv), [["set-status", "wa", "connected"]]);
  assert.match(t.r.stderr, /agent-meta: caps rc=20 /);
});

// Priority-4 principle applied to caps: a caps FAILURE (30, any other code, 127) is a
// metadata failure, not "unsupported" — it must not become an unguarded legacy write.
for (const capsRc of [30, 1, 64]) {
  test(`G3-M-03b caps ${capsRc} (failure, not unsupported) → no set call and no legacy set-status`, () => {
    const t = runReconciler("g3m03b", { sessions: [row("s1", "CONNECTED", "wa")], live: [], capsRc, sealed: ["s1"] });
    clean(t);
    assert.deepEqual(whCalls(t.calls, "agent-meta-set"), []);
    assert.deepEqual(whCalls(t.calls, "set-status").map((c) => c.argv), [], `caps rc=${capsRc} fell back to a legacy write`);
    assert.match(t.r.stderr, new RegExp(`agent-meta: caps rc=${capsRc} `));
  });
}

test("G3-M-08 mixed tick: only unsupported / non-subject rows get the legacy pill; odd set codes never do", () => {
  const t = runReconciler("g3m08", {
    sessions: [row("a", "CONNECTED", "wa"), row("b", "CONNECTED", "wb"), row("c", "DISCONNECTED", "wc"),
      row("d", "CONNECTED", "wd"), row("e", "CONNECTED", "we"), row("u", "CONNECTED", "wu")],
    live: [], capsRc: 0, setRc: { a: 0, b: 10, c: 20, d: 1, e: 137 }, sealed: ["a", "b", "c", "d", "e"],
  });
  clean(t);
  assert.deepEqual(whCalls(t.calls, "set-status").map((c) => c.argv), [["set-status", "wc", "disconnected"], ["set-status", "wu", "connected"]]);
});

test("G3-M-04 sid without sandbox-current.json → no subprocess set call", () => {
  const t = runReconciler("g3m04", { sessions: [row("s1", "CONNECTED", "wa")], live: [], capsRc: 0, sealed: [] });
  clean(t);
  assert.deepEqual(whCalls(t.calls, "agent-meta-set"), []);
  assert.match(t.r.stderr, /agent-meta: applied=0 no_staging=1 /);
});

test("G3-M-05 invalid sid syntax in the telepty listing is never passed to the adapter", () => {
  const t = runReconciler("g3m05", { sessions: [row("../evil", "CONNECTED", "wa"), row("-x", "CONNECTED", "wb")], live: [], capsRc: 0, sealed: [] });
  clean(t);
  assert.deepEqual(whCalls(t.calls, "agent-meta-set"), []);
});

for (const args of [["--once", "--dry-run"], ["--shadow"]]) {
  test(`G3-M-06 ${args.join(" ")}: no agent-meta verb and no set-status (no actuation)`, () => {
    const t = runReconciler("g3m06", {
      sessions: [row("s1", "CONNECTED", "wa")], live: [{ sid: "s1", state: "delivered" }], probe: { s1: probe("idle") },
      capsRc: 0, setRc: { s1: 0 }, sealed: ["s1"],
    }, { args });
    clean(t);
    assert.deepEqual(whCalls(t.calls).filter((c) => c.argv[0] !== "prune-orphans").map((c) => c.argv), []);
  });
}

test("G3-M-07 every rc is logged in its own bucket; 10/20/30 never counted as applied", () => {
  const t = runReconciler("g3m07", {
    sessions: ["a", "b", "c", "d"].map((s) => row(s, "CONNECTED", `w${s}`)), live: [], capsRc: 0,
    setRc: { a: 0, b: 10, c: 20, d: 30 }, sealed: ["a", "b", "c", "d"],
  });
  clean(t);
  assert.match(t.r.stderr, /agent-meta: applied=1 no_staging=0 refused=\[b\] unsupported=\[c\] failed=\[d:30\]/);
});
