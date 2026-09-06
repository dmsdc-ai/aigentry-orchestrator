// T148 (#1105) — a dispatch row whose telepty session is GONE must stop repeating HOLD.
//
// Measured 2026-09-06: row `mr1091-agy-proof` went delivery_state_unknown, its session
// then died by parent-kill propagation (absent from `telepty list`, DELETE → 404), but
// bin/session-cleanup.sh — the only writer of lifecycle=cleaned — never ran for that sid.
// The tracker tick therefore kept classifying a screen that no longer existed and kept
// emitting the same HOLD for 32 minutes, until a human ran the cleanup by hand. `prune`
// cannot help: an unknown outcome is never pruned, by design (cli.ts cmdPrune).
//
// telepty#60 Stage A: the tracker RECORDS what it measured and settles nothing. So the
// fix is an observation, not a lifecycle write — the assertions below pin both halves:
// the row is observed session_absent → session_gone, and its lifecycle never moves.
//
// Two consecutive ticks, across three separate processes: the first miss lives in the
// row (last_observation.kind), never in memory. A tick that finds the session present
// writes screen_class_observed over it, which is the reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO } from "./model-router-fixtures.js";

const TRACKER = join(REPO, "dist/src/tracker/cli.js");
const REGISTRY = join(REPO, "bin/dispatch-registry.py");
const SID = "mr1105-gone-fixture";
// Frozen far past the row's expected_report_by, so every tick sees the row as due.
const NOW = "2030-01-01T00:00:00Z";
const REMEDY = `session gone (2 ticks): run bin/session-cleanup.sh ${SID}`;

type Obs = { kind: string };
type Row = { lifecycle: { state: string }; observations: Obs[] };

function harness() {
  const root = mkdtempSync(join(tmpdir(), "tracker-session-gone-1105-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  for (const dir of [bin, state, join(root, "home")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(state, "active.json"), '{"schema_version":2,"generation":0,"dispatches":[]}');
  const ref = join(root, "ref.md");
  writeFileSync(ref, "mr1105 fixture ref\n");
  const sessions = join(root, "sessions.json");
  const injects = join(root, "injects.log");
  const curls = join(root, "curls.log");
  writeFileSync(injects, "");
  writeFileSync(curls, "");

  const script = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, "#!/usr/bin/env node\n" + body + "\n", { mode: 0o755 });
    return file;
  };
  // `telepty list --json` answers whatever the test last wrote to sessions.json — that
  // one file IS the "is the session still there?" world under test.
  const telepty = script("telepty", `
const fs = require('node:fs'), a = process.argv.slice(2);
if (a[0] === 'list') process.stdout.write(fs.readFileSync(process.env.SESSIONS_JSON, 'utf8'));
else if (a[0] === 'read-screen') process.stdout.write('$ ready\\n');
else if (a[0] === 'inject') fs.appendFileSync(process.env.INJECTS_LOG, a.join(' ') + '\\n');
else process.exit(99);
`);
  const probe = script("probe", `
process.stdout.write(JSON.stringify({alive:true,ready:true,surface:"idle",activity:"static",
  cli:"claude",detail:{tracker_class:"prompt_observed"}}));
`);
  // Not a stub so much as a tripwire: an absent session has no observation endpoint to
  // poll, and reaching for one is the 32-minute repeat this task removes.
  const curl = script("curl", `
require('node:fs').appendFileSync(process.env.CURLS_LOG, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write('\\n404');
`);

  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: join(root, "home"), DISPATCH_STATE_DIR: state,
    DISPATCH_REGISTRY_PY: REGISTRY, TELEPTY: telepty, SESSION_PROBE_PY: probe, CURL: curl,
    TRACKER_NOW: NOW, AIGENTRY_HOST_POWER_STATE: "awake", TELEPTY_PORT: "1",
    SESSIONS_JSON: sessions, INJECTS_LOG: injects, CURLS_LOG: curls,
  };
  const registry = (args: string[]) => spawnSync("python3", [REGISTRY, ...args], { env, encoding: "utf8" });
  const hash = createHash("sha256").update(readFileSync(ref)).digest("hex");
  const begin = registry(["begin-delivery", "--sid", SID, "--ref-hash", hash, "--ref-path", ref]);
  assert.equal(begin.status, 0, begin.stdout + begin.stderr);

  return {
    env,
    /** The world telepty reports: `present()` lists the sid, `absent()` lists someone else. */
    present: () => writeFileSync(sessions, JSON.stringify([{ id: SID, healthStatus: "ok" }])),
    absent: () => writeFileSync(sessions, JSON.stringify([{ id: "someone-else", healthStatus: "ok" }])),
    /** A listing that cannot be parsed — a refusal, not an absence (#820/#823). */
    unreadable: () => writeFileSync(sessions, "401 Unauthorized"),
    tick: () => {
      const r = spawnSync(process.execPath, [TRACKER, "check"], { env, encoding: "utf8", timeout: 20000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return r.stdout;
    },
    row: (): Row => {
      const doc = JSON.parse(readFileSync(join(state, "active.json"), "utf8")) as { dispatches: Row[] };
      assert.equal(doc.dispatches.length, 1);
      return doc.dispatches[0]!;
    },
    holds: () => readFileSync(injects, "utf8").split("\n").filter((l) => l.includes("reason=session_gone")),
    curled: () => readFileSync(curls, "utf8").trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
const kindsOf = (row: Row) => row.observations.map((o) => o.kind);
const count = (row: Row, kind: string) => kindsOf(row).filter((k) => k === kind).length;

test("T148(a): absent for two consecutive ticks — tick 1 is silent evidence, tick 2 is ONE HOLD naming the remedy, tick 3 says nothing more", () => {
  const h = harness();
  try {
    // Pinned from the row itself: the invariant is that the tracker does not MOVE the
    // lifecycle, not that it happens to sit on any particular literal.
    const before = h.row().lifecycle.state;
    h.absent();

    // Tick 1: the first miss is RECORDED, and nothing is told to a human yet. One tick
    // of absence is also what a restarting session looks like.
    const out1 = h.tick();
    const row1 = h.row();
    assert.equal(count(row1, "session_absent"), 1, `tick 1 recorded no first miss: ${kindsOf(row1).join(",")}`);
    assert.equal(count(row1, "session_gone"), 0, "tick 1 must not conclude from a single miss");
    assert.equal(h.holds().length, 0, "tick 1 must not page a human on one miss");
    assert.doesNotMatch(out1, /session gone/);
    // The absent arm never reaches the observation poll — that poll's repeating HOLD is
    // the defect. If this ever fires again, the 32-minute repeat is back.
    assert.equal(h.curled(), "", `an absent session was polled for observations: ${h.curled()}`);
    assert.equal(count(row1, "screen_class_observed"), 0, "a session that is gone has no screen to classify");

    // Tick 2 — a SEPARATE process. The first miss survived only because it lives in the row.
    h.tick();
    const row2 = h.row();
    assert.equal(count(row2, "session_gone"), 1, `tick 2 did not conclude: ${kindsOf(row2).join(",")}`);
    const holds = h.holds();
    assert.equal(holds.length, 1, `tick 2 must emit exactly one HOLD, got ${holds.length}`);
    assert.ok(holds[0]!.includes(REMEDY), `the HOLD must name the remedy, got: ${holds[0]}`);
    assert.ok(holds[0]!.includes(`sid=${SID}`), holds[0]);

    // Tick 3 (and 4): still absent, already concluded ⇒ silence. This is the repeat removed.
    h.tick();
    h.tick();
    const row3 = h.row();
    assert.equal(h.holds().length, 1, "a concluded row must never HOLD again while it stays absent");
    assert.equal(count(row3, "session_gone"), 1, "the conclusion is recorded once, not once per tick");
    assert.equal(count(row3, "session_absent"), 1, "later ticks must not re-record the first miss");

    // The tracker observes; only session-cleanup.sh settles. The lifecycle never moved.
    assert.equal(row3.lifecycle.state, before, `the tracker settled a lifecycle: ${before} -> ${row3.lifecycle.state}`);
    assert.equal(h.curled(), "", "no tick may poll a gone session");
  } finally { h.cleanup(); }
});

test("T148(b): a session that reappears resets the count — absent, present, absent is two first misses, not two consecutive ones", () => {
  const h = harness();
  try {
    h.absent();
    h.tick();
    assert.equal(count(h.row(), "session_absent"), 1);

    // The session is back: the tick classifies its screen, which displaces the first miss.
    h.present();
    h.tick();
    const back = h.row();
    assert.equal(count(back, "screen_class_observed"), 1, `a present session was not classified: ${kindsOf(back).join(",")}`);
    assert.equal(back.observations[back.observations.length - 1]!.kind, "screen_class_observed");

    // Absent again — this is a FIRST miss, so still no conclusion and still no HOLD.
    h.absent();
    h.tick();
    const row = h.row();
    assert.equal(count(row, "session_absent"), 2, `the reappearance did not reset: ${kindsOf(row).join(",")}`);
    assert.equal(count(row, "session_gone"), 0, "two non-consecutive misses are not a gone session");
    assert.equal(h.holds().length, 0, "a flapping session must not page a human");

    // …and the tick after it is the second consecutive miss, which does conclude.
    h.tick();
    assert.equal(count(h.row(), "session_gone"), 1);
    assert.equal(h.holds().length, 1);
  } finally { h.cleanup(); }
});

test("T148(c): a listing that cannot be read is a refusal, not an absence — nothing is recorded and nothing is held", () => {
  const h = harness();
  try {
    h.unreadable();
    h.tick();
    h.tick();
    const row = h.row();
    assert.equal(count(row, "session_absent"), 0,
      `an unreadable listing was read as an absence — the #820/#823 overclaim: ${kindsOf(row).join(",")}`);
    assert.equal(count(row, "session_gone"), 0);
    assert.equal(h.holds().length, 0);
  } finally { h.cleanup(); }
});
