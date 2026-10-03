// #1162 priority 4 — controller review risk, reproduced BEFORE any fix.
// The G3 reconciler treats only agent-meta-set rc 0 as "applied" and sends the legacy
// `wh-cli.sh set-status <cmuxWorkspaceId> <pill>` for EVERY other sid. With a valid
// sealed binding, a 10 (stale_lifecycle / owned_by_other_sid …) says the host refused
// because the target is stale or owned elsewhere; a 30 is a metadata failure. Neither
// may be converted into an unguarded legacy write to the (possibly stale) workspace.
// A 20 (unsupported) may use the documented bounded legacy connection pill only.
// These are acceptance assertions: a failure here is a REPRODUCED defect, not waived.
import assert from "node:assert/strict";
import { test } from "node:test";

import { NOW_EPOCH, runReconciler, whCalls } from "./support/reconciler.mjs";

const SID = "w1162-stale";
const WS = "ws-STALE-previous-lifecycle";
const scenario = (rc) => ({
  sessions: [{ id: SID, healthStatus: "CONNECTED", cmuxWorkspaceId: WS, startedAt: "2026-09-28T12:00:00Z" }],
  live: [{ sid: SID, state: "delivered" }],
  probe: { [SID]: { alive: true, ready: true, surface: "idle", activity: "static", cli: "claude", detail: { screen_source: "cmux:current-viewport" } } },
  capsRc: 0,
  setRc: { [SID]: rc },
  sealed: [SID],
});

function tick(label, rc) {
  const t = runReconciler(label, scenario(rc));
  assert.equal(t.r.status, 0, `tick rc=${t.r.status} stderr=${t.r.stderr}`);
  assert.equal(t.tripwire, "", "tripwire hit");
  assert.ok(!t.calls.some((c) => c.unexpected), `unexpected seam call ${JSON.stringify(t.calls.filter((c) => c.unexpected))}`);
  const sets = whCalls(t.calls, "agent-meta-set");
  assert.equal(sets.length, 1, "exactly one agent-meta-set for the sealed sid");
  assert.deepEqual(sets[0].argv.slice(0, 4), ["agent-meta-set", SID, "--stage", `${t.sessionsRoot}/${SID}`]);
  assert.deepEqual(JSON.parse(sets[0].argv[5]), {
    connection: "connected", activity: "idle", activity_source: "probe:current-viewport", dispatch: "delivered", read_at: NOW_EPOCH,
  });
  return t;
}

test("G3-P4-0 positive control: rc 0 (applied) → no legacy set-status for that sid", () => {
  const t = tick("g3p4-0", 0);
  assert.deepEqual(whCalls(t.calls, "set-status"), []);
});

test("G3-P4-20 rc 20 (unsupported) → bounded legacy connection pill only (connected, never idle/working, no model/effort)", () => {
  const t = tick("g3p4-20", 20);
  assert.deepEqual(whCalls(t.calls, "set-status").map((c) => c.argv), [["set-status", WS, "connected"]]);
});

for (const [rc, why] of [[10, "stale_lifecycle / owned_by_other_sid refusal"], [30, "metadata failure (parse/transport/invalid)"]]) {
  test(`G3-P4-${rc} rc ${rc} (${why}) → must NOT send legacy set-status to the workspace afterwards`, () => {
    const t = tick(`g3p4-${rc}`, rc);
    const legacy = whCalls(t.calls, "set-status").map((c) => c.argv);
    assert.deepEqual(legacy, [], `REPRODUCED: after agent-meta-set rc=${rc} the reconciler sent ${JSON.stringify(legacy)}`);
  });
}
