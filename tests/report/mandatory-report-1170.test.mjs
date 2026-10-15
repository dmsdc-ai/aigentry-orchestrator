// #1170 mandatory worker report — obligation lifecycle through the REAL entrypoints.
//
// Every pass is the exact command reconciler step 0b3 runs (`node dist/src/tracker/cli.js
// report-pump --once`), every ACK is `report-ack`, every fact lands in the REAL
// bin/dispatch-registry.py, and cleanup is the REAL dist/src/cleanup/cli.js. Only telepty,
// wh-cli.sh, curl (and the tripwired host actuators) are fakes; the clock is TRACKER_NOW.
// The world builder and fakes live in ./mandatory-report-1170.fakes.mjs.
//
//   L-01..L-05  review semantics: HOLD→answered→REPORT-2, stale/old/invalid ACK refusals
//               (no write), rework→REPORT-2, respawned attempt / new dispatch to the same
//               sid, late reports after a failure or on a superseded record. No outcome is
//               ever inferred: only an ACK `accepted` on the current final derives done.
//   L-06..L-11  delivery: exited two-tick failure, crash between claim and result, daemon
//               unavailable + failed submit backoff, two concurrent pumps (CAS → one notice),
//               queued/gate_timeout held (never forced, never re-sent every tick), receiver
//               observation and verified-sender anomaly.
//   L-12..L-14  cleanup capture/refusal/cleaned + prune retention, degraded pump notice once,
//               legacy (unbound) digest bounded and deduplicated.
//
// POSIX only (shared harness: modes, bash shim): selected on darwin/linux by
// scripts/run-tests.mjs; on any other platform every case is skipped by name, never passed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ORCH, sha256, worldKit } from "./mandatory-report-1170.fakes.mjs";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const SKIP = POSIX ? false : `POSIX-only lifecycle suite (sealed modes, bash shim); not run on ${process.platform}`;
const H = POSIX ? await import("../dispatch/agent-metadata/support/harness.mjs") : null;
const K = POSIX ? worldKit(H) : null;

const T0 = Date.parse("2026-10-09T12:00:00Z");
/** ISO second `min` minutes after the 12:00 dispatch. */
const at = (min) => new Date(T0 + min * 60_000).toISOString().slice(0, 19) + "Z";
const lines = (c) => c.argv.at(-1).split("\n");
const json = (r) => JSON.parse(r.stdout);

function ok(p, label = "pump") {
  assert.equal(p.status, 0, `${label} rc=${p.status} signal=${p.signal}\n${p.stdout}\n${p.stderr}`);
  assert.deepEqual(p.calls?.filter((c) => c.unexpected) ?? [], [], "unexpected fake call");
  return p;
}
function noTrip(w) {
  assert.equal(w.run.tripwireHits(), "", "tripwire hit: a host actuator was resolved");
  for (const c of K.submits(w.calls())) {
    assert.deepEqual(c.argv.slice(0, 7), ["inject", "--submit", "--no-submit-force", "--submit-retry", "2", "--from", "dispatch-tracker"]);
    assert.ok(!c.argv.includes("--submit-force"));
    assert.deepEqual(c.identityEnv, []);
  }
}
const rep = (w, d) => w.row(d.did).report;

test("L-01 HOLD-1 → answered → REPORT-2 → accepted ⇒ done; a reviewed HOLD never blocks the REPORT", { skip: SKIP }, () => {
  const w = K.world("l01");
  const d = w.dispatch(w.worker("w1170-l01"));
  const h1 = w.write(d, "HOLD", 1, "Need a decision: option A or option B?");
  const p1 = ok(w.pump(at(1)));
  const n1 = K.submits(p1.calls);
  assert.equal(n1.length, 1);
  assert.match(lines(n1[0])[0], new RegExp(`^⟦aigentry-report v1⟧ HOLD .* item=HOLD-1 sha256=${h1.sha} bytes=${h1.bytes.length} n=1$`));
  assert.equal(lines(n1[0]).at(-1),
    `ACK: bin/dispatch-tracker.sh report-ack --dispatch-id ${d.did} --item HOLD-1 --sha256 ${h1.sha} --verdict answered|rejected`);
  assert.equal(rep(w, d).resolution, "open");
  assert.equal(rep(w, d).current_final, null, "a HOLD is never a final");
  const bad = w.ack(d, "HOLD-1", h1.sha, "accepted", at(2));
  assert.equal(bad.status, 4);
  assert.equal(json(bad).result, "invalid_verdict");
  const a1 = w.ack(d, "HOLD-1", h1.sha, "answered", at(2));
  assert.equal(a1.status, 0, a1.stdout + a1.stderr);
  assert.equal(json(a1).resolution, "open", "an answered HOLD is not done");
  assert.equal(K.submits(ok(w.pump(at(3))).calls).length, 0, "reviewed HOLD is not re-noticed");
  const r2 = w.write(d, "REPORT", 2, "VERDICT: DONE (after the HOLD answer)");
  const p3 = ok(w.pump(at(4)));
  assert.match(p3.stdout, /captured=1 capture_failed=0 notices=1/);
  const n3 = K.submits(p3.calls);
  assert.equal(n3.length, 1);
  assert.match(lines(n3[0])[0], new RegExp(`^⟦aigentry-report v1⟧ REPORT .* item=REPORT-2 sha256=${r2.sha} `));
  assert.ok(lines(n3[0]).at(-1).endsWith("--verdict accepted|rework|rejected"));
  assert.equal(rep(w, d).current_final, "REPORT-2");
  assert.equal(rep(w, d).resolution, "open");
  const a2 = w.ack(d, "REPORT-2", r2.sha, "accepted", at(5));
  assert.equal(a2.status, 0, a2.stdout + a2.stderr);
  assert.equal(json(a2).resolution, "done");
  assert.equal(w.row(d.did).outcome.state, "unknown");
  assert.match(ok(w.pump(at(30))).stdout, /rows=0 /, "done leaves the scan set");
  noTrip(w);
});

test("L-02 stale ACKs are refused with exit 4 and NO registry write: before capture, wrong sha, old item, bad verdict, worker session", { skip: SKIP }, () => {
  const w = K.world("l02");
  const d = w.dispatch(w.worker("w1170-l02"));
  const r1Bytes = Buffer.from("x");
  const early = w.ack(d, "REPORT-1", sha256(r1Bytes), "accepted", at(1));
  assert.equal(early.status, 4, "review before capture");
  assert.equal(json(early).result, "STALE_SUBJECT");
  const r1 = w.write(d, "REPORT", 1, "first final");
  ok(w.pump(at(1)));
  const r2 = w.write(d, "REPORT", 2, "corrected final");
  const p2 = ok(w.pump(at(2)));
  assert.deepEqual(K.submits(p2.calls).map((c) => lines(c)[0].match(/item=(\S+)/)[1]), ["REPORT-2"], "the superseded REPORT-1 is not re-noticed");
  assert.equal(rep(w, d).items["REPORT-1"].superseded_by, "REPORT-2");
  assert.equal(rep(w, d).current_final, "REPORT-2");
  const snap = w.activeRaw();
  const refusals = [
    ["old item", w.ack(d, "REPORT-1", r1.sha, "accepted", at(3)), 4, "STALE_SUBJECT"],
    ["wrong sha", w.ack(d, "REPORT-2", "0".repeat(64), "accepted", at(3)), 4, "STALE_SUBJECT"],
    ["verdict for another kind", w.ack(d, "REPORT-2", r2.sha, "answered", at(3)), 4, "invalid_verdict"],
    ["absent failure subject", w.ack(d, "failure-1", r2.sha, "seen", at(3)), 4, "STALE_SUBJECT"],
    ["unknown dispatch", w.ack({ did: "f".repeat(32) }, "REPORT-2", r2.sha, "accepted", at(3)), 9, "dispatch_not_found"],
  ];
  for (const [what, r, code, result] of refusals) {
    assert.equal(r.status, code, `${what}: ${r.stdout}${r.stderr}`);
    if (code === 9) assert.match(r.stdout + r.stderr, new RegExp(result));
    else assert.equal(json(r).result, result, what);
  }
  const worker = w.ack(d, "REPORT-2", r2.sha, "accepted", at(3), { AIGENTRY_WORKER_SESSION: "1" });
  assert.equal(worker.status, 4);
  assert.match(worker.stderr, /report-ack is orchestrator-only/);
  const malformed = H.sh(process.execPath, [K.TRACKER, "report-ack", "--dispatch-id", d.did, "--item", "REPORT-2", "--sha256", r2.sha],
    { env: w.env, timeout: 60000 });
  assert.equal(malformed.status, 4, "missing --verdict");
  const badShape = w.ack({ did: "../etc" }, "REPORT-2", r2.sha, "accepted", at(3));
  assert.equal(badShape.status, 4);
  assert.equal(json(badShape).result, "invalid_argument");
  assert.equal(w.activeRaw(), snap, "no refusal wrote anything");
  assert.equal(w.ack(d, "REPORT-2", r2.sha, "accepted", at(4)).status, 0);
  assert.equal(w.ack(d, "REPORT-2", r2.sha, "accepted", at(5)).status, 8, "same verdict again = already recorded");
  const flip = w.ack(d, "REPORT-2", r2.sha, "rework", at(5));
  assert.equal(flip.status, 4, "a different verdict after review is stale");
  assert.equal(rep(w, d).resolution, "done");
  noTrip(w);
});

test("L-03 rework → rework_requested (still scanned, not re-noticed) → REPORT-2 → accepted ⇒ done", { skip: SKIP }, () => {
  const w = K.world("l03");
  const d = w.dispatch(w.worker("w1170-l03"));
  const r1 = w.write(d, "REPORT", 1, "first attempt");
  ok(w.pump(at(1)));
  const rw = w.ack(d, "REPORT-1", r1.sha, "rework", at(2));
  assert.equal(rw.status, 0, rw.stdout);
  assert.equal(json(rw).resolution, "rework_requested");
  const p2 = ok(w.pump(at(5)));
  assert.match(p2.stdout, /rows=1 captured=0 capture_failed=0 notices=0/, "rework_requested stays in the scan set, silently");
  const r2 = w.write(d, "REPORT", 2, "reworked");
  const p3 = ok(w.pump(at(6)));
  assert.equal(K.submits(p3.calls).length, 1);
  assert.match(lines(K.submits(p3.calls)[0])[0], /item=REPORT-2 .* n=1$/);
  assert.equal(rep(w, d).current_final, "REPORT-2");
  assert.equal(rep(w, d).resolution, "open");
  assert.equal(json(w.ack(d, "REPORT-2", r2.sha, "accepted", at(7))).resolution, "done");
  assert.equal(w.row(d.did).outcome.state, "unknown");
  noTrip(w);
});

test("L-04 same sid respawned (sandbox-current moved): the PINNED attempt is read; a new dispatch ignores the old request dir", { skip: SKIP }, () => {
  const w = K.world("l04");
  const sid = "w1170-l04";
  const wkA = w.worker(sid);
  const d = w.dispatch(wkA);
  const wkB = w.worker(sid); // respawn: a new sealed attempt becomes current
  const cur = JSON.parse(fs.readFileSync(path.join(wkA.stage, "sandbox-current.json"), "utf8"));
  assert.equal(cur.manifest, wkB.manifest, "fixture control: current now names attempt B");
  // worst case: attempt B holds a VALID item for the old request (challenge leaked to it)
  const fromB = w.write({ ...d, wk: wkB }, "REPORT", 1, "written by the respawned attempt B");
  const p1 = ok(w.pump(at(1)));
  assert.match(p1.stdout, /rows=1 captured=0 /);
  assert.deepEqual(w.inboxFiles(), []);
  const fromA = w.write(d, "REPORT", 1, "written by the pinned attempt A");
  const p2 = ok(w.pump(at(2)));
  assert.match(p2.stdout, /captured=1 /);
  assert.equal(rep(w, d).items["REPORT-1"].sha256, fromA.sha);
  assert.ok(fs.readFileSync(w.inboxFiles()[0]).equals(fromA.bytes));
  assert.notEqual(fromA.sha, fromB.sha);
  assert.match(lines(K.submits(p2.calls)[0])[0], new RegExp(`attempt=${wkA.attempt} `));
  // a NEW dispatch to the same sid (bound to attempt B, new request) is not satisfied by old dirs
  const d2 = w.dispatch(wkB, { now: at(3) });
  const p3 = ok(w.pump(at(3.5))); // before d's REPORT-1 re-notice is due (12:04)
  assert.deepEqual(rep(w, d2).items, {}, "the old request's item never satisfies the new request");
  assert.equal(K.submits(p3.calls).length, 0);
  noTrip(w);
});

test("L-05 late REPORT after a seen failure reopens it; late lower seq is captured superseded; a superseded record's notice names its successor", { skip: SKIP }, () => {
  const w = K.world("l05");
  const wk = w.worker("w1170-l05");
  const d = w.dispatch(wk);
  ok(w.pump(at(31))); // expected_report_by 12:30 passed, nothing captured
  const f = rep(w, d).failures;
  assert.deepEqual(f.map((x) => [x.n, x.event]), [[1, "overdue"]]);
  assert.equal(f[0].subject_sha256, sha256(`${d.did}\nfailure-1\noverdue\n${at(31)}`));
  const p2 = ok(w.pump(at(32)));
  assert.match(lines(K.submits(p2.calls)[0])[0], /FAILURE event=overdue .* — no REPORT captured for this dispatch; outcome unknown, not done$/);
  const seen = w.ack(d, "failure-1", f[0].subject_sha256, "seen", at(33));
  assert.equal(json(seen).resolution, "failed_seen");
  assert.match(ok(w.pump(at(40))).stdout, /rows=1 captured=0 capture_failed=0 notices=0/, "failed_seen is still scanned");
  const r2 = w.write(d, "REPORT", 2, "late, but here");
  const p4 = ok(w.pump(at(41)));
  assert.match(p4.stdout, /captured=1 /);
  assert.equal(rep(w, d).resolution, "open", "a late item reopens a failed_seen record");
  const r1 = w.write(d, "REPORT", 1, "even later, lower seq");
  const p5 = ok(w.pump(at(42)));
  assert.match(p5.stdout, /captured=1 capture_failed=0 notices=0/, "late lower seq: captured, not noticed");
  assert.equal(rep(w, d).items["REPORT-1"].superseded_by, "REPORT-2");
  assert.equal(rep(w, d).current_final, "REPORT-2");
  assert.equal(w.ack(d, "REPORT-1", r1.sha, "accepted", at(43)).status, 4, "the late lower seq can never be accepted");
  assert.equal(json(w.ack(d, "REPORT-2", r2.sha, "accepted", at(43))).resolution, "done");
  assert.equal(w.row(d.did).outcome.state, "unknown");
  // superseded record (--retry-unknown): its late item is captured on IT and names the successor
  const wk2 = w.worker("w1170-l05b");
  const d1 = w.dispatch(wk2, { now: at(50) });
  assert.equal(w.reg(["set-transport-result", "--sid", wk2.sid, "--result", "unknown", "--now", at(50)]).status, 0);
  const d2 = w.dispatch(wk2, { now: at(51), ref: d1.ref, retryUnknown: "transport unknown; retry" });
  assert.equal(w.row(d1.did).lifecycle.state, "superseded");
  const late = w.write(d1, "REPORT", 1, "late report for the superseded dispatch");
  const p6 = ok(w.pump(at(52)));
  assert.equal(rep(w, d1).items["REPORT-1"].sha256, late.sha);
  assert.deepEqual(rep(w, d2).items, {});
  const n6 = K.submits(p6.calls).filter((c) => lines(c)[0].includes(`dispatch_id=${d1.did}`));
  assert.equal(n6.length, 1);
  assert.match(lines(n6[0])[0], new RegExp(`n=1 superseded_by_dispatch=${d2.did}$`));
  noTrip(w);
});

test("L-06 exited worker: two-tick exited failure → notice → seen ⇒ failed_seen, never done", { skip: SKIP }, () => {
  const w = K.world("l06");
  const d = w.dispatch(w.worker("w1170-l06", { receipt: "exited" }));
  ok(w.pump(at(5)));
  assert.deepEqual(rep(w, d).failures, [], "tick 1: suspect only");
  assert.ok(rep(w, d).suspect.exited);
  ok(w.pump(at(6)));
  assert.deepEqual(rep(w, d).failures.map((f) => f.event), ["exited"], "tick 2: confirmed");
  const p3 = ok(w.pump(at(7)));
  assert.match(lines(K.submits(p3.calls)[0])[0], /FAILURE event=exited .* outcome unknown, not done$/);
  const f = rep(w, d).failures[0];
  assert.equal(json(w.ack(d, "failure-1", f.subject_sha256, "seen", at(8))).resolution, "failed_seen");
  assert.equal(w.row(d.did).outcome.state, "unknown");
  noTrip(w);
});

test("L-07 crash between claim and result: durable pending lease, no re-send inside it, exactly one re-send after", { skip: SKIP }, () => {
  const w = K.world("l07");
  const d = w.dispatch(w.worker("w1170-l07"));
  const r1 = w.write(d, "REPORT", 1, "crash seam");
  w.set({ injectReplies: [{ crash: true }, {}] });
  const p1 = w.pump(at(1));
  assert.equal(p1.signal, "SIGKILL", `the broker died mid-notice: ${p1.status}/${p1.signal}`);
  const it = rep(w, d).items["REPORT-1"];
  assert.equal(it.sha256, r1.sha, "the capture committed before the crash");
  assert.ok(fs.readFileSync(it.inbox).equals(r1.bytes));
  assert.deepEqual([it.notice.n, it.notice.submit, it.notice.next_at, it.notice.inject_id], [1, "pending", at(3), null]);
  assert.equal(K.submits(ok(w.pump(at(2))).calls).length, 0, "inside the claim lease: no re-send");
  const p3 = ok(w.pump(at(3)));
  const n3 = K.submits(p3.calls);
  assert.equal(n3.length, 1);
  assert.match(lines(n3[0])[0], /item=REPORT-1 .* n=2$/);
  const n = rep(w, d).items["REPORT-1"].notice;
  assert.deepEqual([n.n, n.submit, n.rc, n.inject_id, n.next_at], [2, "consumed", 0, n3[0].injectId, at(8)]);
  noTrip(w);
});

test("L-08 daemon unavailable: capture still durable, no send, exit 3 + degraded status; failed submit backs off 2 → 5 min", { skip: SKIP }, () => {
  const w = K.world("l08");
  const d = w.dispatch(w.worker("w1170-l08"));
  const r1 = w.write(d, "REPORT", 1, "while the daemon is down");
  w.set({ listRc: 1 });
  const p1 = w.pump(at(1));
  assert.equal(p1.status, 3, p1.stdout + p1.stderr);
  assert.match(p1.stdout, new RegExp(`captured=1 capture_failed=0 notices=0 legacy_marked=0 errors=${d.did}:destination_unknown`));
  assert.equal(K.submits(p1.calls).length, 0);
  assert.equal(rep(w, d).items["REPORT-1"].sha256, r1.sha);
  assert.equal(rep(w, d).items["REPORT-1"].notice, null);
  const st = w.status(at(1));
  assert.equal(st.status, 3);
  assert.ok(json(st).degraded_reasons.includes("record_errors"));
  w.set({ listRc: 0, injectReplies: [{ rc: 1, stdout: "Submit failed: daemon closed the connection\n" }, {}] });
  const p2 = ok(w.pump(at(2)));
  assert.equal(K.submits(p2.calls).length, 1);
  let n = rep(w, d).items["REPORT-1"].notice;
  assert.deepEqual([n.n, n.submit, n.rc, n.inject_id, n.next_at], [1, "failed", 1, null, at(4)]);
  assert.equal(K.submits(ok(w.pump(at(3))).calls).length, 0, "backoff: not every tick");
  assert.equal(K.submits(ok(w.pump(at(4))).calls).length, 1);
  n = rep(w, d).items["REPORT-1"].notice;
  assert.deepEqual([n.n, n.submit, n.next_at], [2, "consumed", at(9)]);
  assert.equal(K.submits(ok(w.pump(at(8))).calls).length, 0);
  assert.equal(w.status(at(8)).status, 0, "healthy again after a clean pass");
  noTrip(w);
});

test("L-09 two concurrent pumps: the registry claim CAS lets exactly one notice out", { skip: SKIP }, async () => {
  const w = K.world("l09");
  const d = w.dispatch(w.worker("w1170-l09"));
  w.write(d, "REPORT", 1, "race me");
  const barrier = H.privDir(path.join(w.run.dir, "barrier"));
  w.set({ listBarrier: { dir: barrier, n: 2 }, injectReplies: [{ sleepMs: 300 }] });
  const m = w.mark();
  const runOne = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [K.TRACKER, "report-pump", "--once"], { env: { ...w.env, TRACKER_NOW: at(1) },
      stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (b) => { out += b; });
    c.stderr.on("data", (b) => { out += b; });
    const t = setTimeout(() => c.kill("SIGKILL"), 60000);
    c.on("close", (code, signal) => { clearTimeout(t); resolve({ code, signal, out }); });
  });
  const [a, b] = await Promise.all([runOne(), runOne()]);
  assert.equal(a.code, 0, a.out);
  assert.equal(b.code, 0, b.out);
  const calls = w.since(m);
  assert.deepEqual(calls.filter((c) => c.role === "telepty" && c.argv[0] === "list").map((c) => c.barrier >= 2), [true, true],
    "both pumps had read their rows before either claimed");
  assert.equal(K.submits(calls).length, 1, "exactly one notice");
  const claims = K.events(calls, "notice").filter((c) => c.argv.includes("phase=claim")).map((c) => c.rc).sort();
  assert.deepEqual(claims, [0, 8], "one claim won, one raced");
  assert.deepEqual(K.events(calls, "captured").map((c) => c.rc).sort(), [0, 8], "one capture, one idempotent duplicate");
  const sum = (re) => [a.out, b.out].reduce((s, o) => s + Number(re.exec(o)[1]), 0);
  assert.equal(sum(/captured=(\d+)/), 1);
  assert.equal(sum(/notices=(\d+)/), 1);
  assert.equal(rep(w, d).items["REPORT-1"].notice.n, 1);
  assert.equal(w.inboxFiles().length, 1);
  noTrip(w);
});

test("L-10 queued / gate_timeout are held ≥30 min (no forced submit, no re-send every tick); unmatched stdout is `unknown`", { skip: SKIP }, () => {
  const cases = [["queued", "QUEUED, NOT consumed (target busy)", 31], ["gate_timeout", "Submit gated-timeout after 20s", 31],
    ["unknown", "(no marker)", 3]];
  for (const [outcome, marker, resendAt] of cases) {
    const w = K.world(`l10-${outcome}`);
    const d = w.dispatch(w.worker(`w1170-l10-${outcome.replace("_", "")}`));
    w.write(d, "REPORT", 1, `held ${outcome}`);
    w.set({ injectReplies: [{ marker: marker === "(no marker)" ? "" : marker }, {}] });
    ok(w.pump(at(1)));
    const n = rep(w, d).items["REPORT-1"].notice;
    assert.deepEqual([n.submit, n.next_at], [outcome, at(resendAt)], outcome);
    for (const t of [2, 10, 30].filter((x) => x < resendAt)) {
      assert.equal(K.submits(ok(w.pump(at(t))).calls).length, 0, `${outcome}: no re-send at +${t} min`);
    }
    const again = K.submits(ok(w.pump(at(resendAt))).calls);
    assert.equal(again.length, 1, `${outcome}: one re-send when due`);
    assert.match(lines(again[0])[0], /n=2$/);
    noTrip(w);
  }
});

test("L-11 receiver observation recorded by inject_id; a non-null verified sender is an anomaly (exit 3)", { skip: SKIP }, () => {
  const w = K.world("l11");
  const d = w.dispatch(w.worker("w1170-l11"));
  w.write(d, "REPORT", 1, "observe me");
  const id = K.submits(ok(w.pump(at(1))).calls)[0].injectId;
  w.set({ audit: [{ inject_id: id, to: ORCH, claimed_from: "dispatch-tracker", verified_sender_sid: null,
    delivery_result: "delivered", kind: "inject", ts: at(1) }] });
  const p2 = ok(w.pump(at(1.5)));
  const q = p2.calls.find((c) => c.role === "telepty" && c.argv[0] === "injects");
  assert.deepEqual(q.argv, ["injects", "--json", "--to", ORCH, "--since", at(1), "--limit", "200"]);
  const n = rep(w, d).items["REPORT-1"].notice;
  assert.deepEqual([n.delivery_result, n.verified_sender], ["delivered", null]);
  assert.equal(rep(w, d).resolution, "open", "delivered is not reviewed");
  const d2 = w.dispatch(w.worker("w1170-l11b"), { now: at(2) });
  w.write(d2, "REPORT", 1, "forged sender case");
  const id2 = K.submits(ok(w.pump(at(3))).calls).find((c) => c.argv.at(-1).includes(`dispatch_id=${d2.did}`)).injectId;
  w.set({ audit: [{ inject_id: id2, to: ORCH, claimed_from: "dispatch-tracker", verified_sender_sid: "w1170-l11b",
    delivery_result: "delivered", kind: "inject", ts: at(3) }] });
  const p4 = w.pump(at(3.5));
  assert.equal(p4.status, 3);
  assert.match(p4.stdout, new RegExp(`${d2.did}:verified_sender_anomaly`));
  assert.equal(rep(w, d2).items["REPORT-1"].notice.verified_sender, "w1170-l11b");
  noTrip(w);
});

test("L-12 cleanup: capture before teardown; capture failure refuses with nothing torn down; no report ⇒ `cleaned` failure; prune keeps unresolved", { skip: SKIP }, () => {
  const w = K.world("l12");
  w.set({ curlDelete: "404" });
  const wkA = w.worker("w1170-l12a", { listed: false });
  const dA = w.dispatch(wkA);
  const rA = w.write(dA, "REPORT", 1, "captured by cleanup");
  const cA = w.cleanup(wkA.sid);
  assert.equal(cA.status, 0, cA.stdout + cA.stderr);
  const iCap = cA.calls.findIndex((c) => c.role === "dispatch-registry.py" && c.argv.includes("captured"));
  const iClose = cA.calls.findIndex((c) => c.role === "wh-cli.sh" && c.argv[0] === "close-for-sid");
  const iDel = cA.calls.findIndex((c) => c.role === "curl");
  assert.ok(iCap >= 0 && iCap < iClose && iClose < iDel, `capture before teardown: ${JSON.stringify({ iCap, iClose, iDel })}`);
  assert.equal(K.submits(cA.calls).length, 0, "cleanup never notifies");
  assert.equal(rep(w, dA).items["REPORT-1"].sha256, rA.sha);
  assert.equal(w.row(dA.did).lifecycle.state, "cleaned");
  assert.equal(rep(w, dA).resolution, "open", "captured by cleanup is still not done");
  assert.deepEqual(rep(w, dA).failures, [], "a captured REPORT is not a `cleaned` failure");

  const wkB = w.worker("w1170-l12b", { listed: false });
  const dB = w.dispatch(wkB);
  const rB = w.write(dB, "REPORT", 1, "cannot be captured: sealed chain broken");
  fs.appendFileSync(wkB.manifest, " "); // sealed manifest no longer matches the pinned hash
  const before = w.activeRaw();
  const cB = w.cleanup(wkB.sid);
  assert.equal(cB.status, 1, cB.stdout + cB.stderr);
  assert.match(cB.stderr, new RegExp(`REPORT_CAPTURE_FAILED for ${wkB.sid}: ${dB.did}:chain_`));
  assert.deepEqual(cB.calls.filter((c) => c.role !== "dispatch-registry.py"), [], "nothing torn down");
  assert.deepEqual(cB.calls.map((c) => c.argv[0]), ["report-list"]);
  assert.equal(w.activeRaw(), before, "registry untouched");
  assert.ok(fs.readFileSync(rB.file).equals(rB.bytes), "worker item preserved");

  const wkC = w.worker("w1170-l12c", { listed: false });
  const dC = w.dispatch(wkC);
  const cC = w.cleanup(wkC.sid);
  assert.equal(cC.status, 0, cC.stdout + cC.stderr);
  assert.deepEqual(rep(w, dC).failures.map((f) => [f.event, f.detail]), [["cleaned", "session cleanup with no REPORT captured"]]);
  assert.equal(rep(w, dC).resolution, "open");
  assert.equal(w.row(dC.did).outcome.state, "unknown");

  // prune: a done+cleaned record goes, unresolved cleaned records stay (whatever their age)
  assert.equal(w.ack(dA, "REPORT-1", rA.sha, "accepted", at(5)).status, 0);
  const pr = w.reg(["prune", "--older-than-seconds", "86400", "--now", "2099-01-01T00:00:00Z"]);
  assert.equal(pr.status, 0, pr.stdout + pr.stderr);
  const left = JSON.parse(w.activeRaw()).dispatches.map((x) => x.dispatch_id);
  assert.ok(!left.includes(dA.did), "done + cleaned + old → pruned");
  assert.ok(left.includes(dC.did), "open `cleaned` failure obligation retained");
  assert.ok(left.includes(dB.did), "refused-cleanup record retained");
  assert.equal(w.run.tripwireHits(), "");
});

test("L-13 registry unreadable: exit 9 per pass, exactly one REPORT_PUMP_DEGRADED notice after 3, health recovers", { skip: SKIP }, () => {
  const w = K.world("l13");
  const gone = { DISPATCH_REGISTRY_PY: path.join(w.run.dir, "no-registry.py") };
  const sent = [];
  for (const t of [1, 2, 3, 4]) {
    const p = w.pump(at(t), { env: gone });
    assert.equal(p.status, 9, p.stdout + p.stderr);
    sent.push(...K.submits(p.calls));
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.stateDir, "report-pump-health.json"), "utf8")).consecutive_failures, t);
  }
  assert.equal(sent.length, 1, "degraded notice once, not every pass");
  assert.match(sent[0].argv.at(-1), /^⟦aigentry-report v1⟧ REPORT_PUMP_DEGRADED consecutive_failed_passes=3 last_error=registry_list_\d+ /);
  assert.equal(sent[0].argv.at(-2), ORCH);
  ok(w.pump(at(5)));
  const h = JSON.parse(fs.readFileSync(path.join(w.stateDir, "report-pump-health.json"), "utf8"));
  assert.deepEqual([h.consecutive_failures, h.degraded_noticed, h.last_ok_at], [0, false, at(5)]);
  noTrip(w);
});

test("L-14 legacy (unbound) dispatch: marked, ONE digest when due, durable backoff, `seen` ⇒ legacy_seen", { skip: SKIP }, () => {
  const w = K.world("l14");
  const d = w.dispatch(w.worker("w1170-l14"), { bind: false });
  const p1 = ok(w.pump(at(1)));
  assert.match(p1.stdout, /legacy_marked=1 /);
  assert.equal(rep(w, d).resolution, "legacy_unbound");
  assert.equal(rep(w, d).request_id, null);
  const p2 = ok(w.pump(at(2)));
  const n2 = K.submits(p2.calls);
  assert.equal(n2.length, 1);
  assert.match(n2[0].argv.at(-1), /^⟦aigentry-report v1⟧ LEGACY_UNBOUND records=1 /);
  assert.equal(K.submits(ok(w.pump(at(3))).calls).length, 0, "not every pass");
  const subj = rep(w, d).legacy.subject_sha256;
  assert.equal(subj, sha256(`${d.did}\nlegacy\n${at(1)}`));
  assert.equal(json(w.ack(d, "legacy", subj, "seen", at(3))).resolution, "legacy_seen");
  assert.match(ok(w.pump(at(10))).stdout, /rows=0 /);
  noTrip(w);
});
