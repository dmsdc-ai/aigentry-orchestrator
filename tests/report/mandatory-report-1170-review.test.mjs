// #1170 phase-2 review reproductions (phase2-review.md, SOURCE-ONLY findings F1–F4).
//
// Each case first proves the mechanism the review cites with positive controls on the REAL
// compiled pump / registry / cleanup (fakes: telepty, wh-cli, curl only), then asserts the
// DESIRED behaviour the controller approved. A desired assertion that fails is a reproduced
// defect (message prefix `REPRODUCED Fx:`), not a test bug; nothing here is weakened to green.
//
//   F1a  forged bound TURN with `after=<uuid>/REPORT-n`: parser accepts, registry rejects →
//        must not become captureFailed / refuse cleanup.
//   F1b  REPORT+HOLD counted together (32) while the prompt allows 32 each: the legal final
//        REPORT-30 after 3 HOLDs must be captured, not lost to item_limit.
//   F1c  unreadable outbox = CONTROLLER POLICY (fail-closed): a named, visible failure and a
//        refused cleanup, worker bytes preserved, no permission reset. Expected GREEN.
//   F2   retired failed_seen older than the 7-day scan window: desired bounded registry with
//        evidence preserved (never deleted) — minimal reproduction of today's unbounded keep.
//   F3   claim lease (2 min) shorter than a still-running inject + an overlapping pump →
//        duplicate notice; a pump killed mid unbound-notice repeats the "once" notice.
//   F4   failure events deduplicated per record lifetime (second invalid item silent) and a
//        failure cap (8) below the number of kinds (9).
//
// POSIX only (shared harness); selected on darwin/linux. Not run elsewhere (skip by name).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { itemBytes, mint, worldKit } from "./mandatory-report-1170.fakes.mjs";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const SKIP = POSIX ? false : `POSIX-only review reproductions; not run on ${process.platform}`;
const H = POSIX ? await import("../dispatch/agent-metadata/support/harness.mjs") : null;
const K = POSIX ? worldKit(H) : null;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const env1170 = await import(pathToFileURL(path.join(REPO, "dist/src/report/envelope.js")).href);

const T0 = Date.parse("2026-10-09T12:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString().slice(0, 19) + "Z";
const field = (stdout, name) => Number(new RegExp(`${name}=(\\d+)`).exec(stdout)?.[1]);
const rep = (w, d) => w.row(d.did).report;
const health = (w) => JSON.parse(fs.readFileSync(path.join(w.stateDir, "report-pump-health.json"), "utf8"));

/** A worker-forged TURN for request R (the worker knows R and the challenge). */
function forgedTurn(req, seq, { before = "-", after }) {
  return Buffer.from(`AIGENTRY_REPORT v1 request_id=${req.request_id} challenge=${req.challenge} kind=TURN seq=${seq}\n` +
    `end=stop\nturn=1\nsession=forged-1\nassoc=exact\nbefore=${before}\nafter=${after}\nat=2026-10-09T12:00:00Z\n` +
    `observed_by=hook\n-----BEGIN UNTRUSTED-----\n\n-----END UNTRUSTED-----\nAIGENTRY_REPORT_END ${req.request_id} TURN-${seq}\n`);
}

test("F1a forged bound TURN `after=<uuid>/REPORT-1`: no captureFailed, no refused cleanup (desired)", { skip: SKIP }, () => {
  const w = K.world("f1a");
  w.set({ curlDelete: "404" });
  const wk = w.worker("w1170-f1a", { listed: false });
  const d = w.dispatch(wk);
  const bytes = forgedTurn(d.req, 1, { after: `${d.req.request_id}/REPORT-1` });
  w.write(d, "TURN", 1, null, { bytes });
  // positive controls: the envelope accepts it, the parser accepts the prefixed entry …
  const p = env1170.parseItem(bytes, { requestId: d.req.request_id, challengeSha256: d.req.challenge_sha256, kind: "TURN", seq: 1 });
  assert.equal(p.ok, true);
  assert.deepEqual(env1170.parseTurnFields(p.item.body).after, [`${d.req.request_id}/REPORT-1`]);
  const p1 = w.pump(at(1));
  const p2 = w.pump(at(2));
  // … and the registry rejects the forwarded new_formal with exit 4
  const cap = K.events([...p1.calls, ...p2.calls], "captured");
  assert.ok(cap.length >= 1 && cap.every((c) => c.rc === 4), `registry captured rc: ${cap.map((c) => c.rc)}`);
  assert.ok(cap[0].argv.includes(`new_formal=${d.req.request_id}/REPORT-1`));
  const c = w.cleanup(wk.sid);
  const observed = { pass1: [p1.status, field(p1.stdout, "capture_failed")], pass2: [p2.status, field(p2.stdout, "capture_failed")],
    cleanup: c.status, cleanupErr: c.stderr.trim().split("\n").filter((l) => l.includes("REPORT_CAPTURE_FAILED")) };
  assert.deepEqual([observed.pass1[1], observed.pass2[1], observed.cleanup], [0, 0, 0],
    `REPRODUCED F1a: worker-forged TURN bytes count as captureFailed and refuse cleanup: ${JSON.stringify(observed)}`);
});

test("F1b 3 HOLD + 30 REPORT (each kind within its prompted 1..32): final REPORT-30 captured (desired)", { skip: SKIP }, () => {
  const w = K.world("f1b");
  w.set({ curlDelete: "404" });
  const wk = w.worker("w1170-f1b", { listed: false });
  const d = w.dispatch(wk);
  for (let i = 1; i <= 3; i++) w.write(d, "HOLD", i, `hold ${i}`);
  for (let i = 1; i <= 30; i++) w.write(d, "REPORT", i, `report ${i}`);
  const p1 = w.pump(at(1));
  const r = rep(w, d);
  // positive controls: 33 capture calls in HOLD<REPORT order; per-kind limit (REPORT 32, HOLD 32) keeps all
  // 33 distinct legal items written above (HOLD-1..3 + REPORT-1..30)
  const capRc = K.events(p1.calls, "captured").map((c) => [c.argv[c.argv.indexOf("--item") + 1], c.rc]);
  assert.equal(capRc.length, 33);
  assert.equal(Object.keys(r.items).length, 33);
  const lost = { last: capRc.at(-1), current_final: r.current_final, capture_failed: field(p1.stdout, "capture_failed"),
    errors: /errors=(\S+)/.exec(p1.stdout)?.[1] };
  const c = w.cleanup(wk.sid);
  assert.deepEqual([r.current_final, lost.capture_failed, c.status], ["REPORT-30", 0, 0],
    `REPRODUCED F1b: the legal final is lost to the combined item_limit and cleanup is refused: ${JSON.stringify({ ...lost, cleanup: c.status })}`);
});

test("F1c unreadable outbox (worker chmod 000) = controller fail-closed policy: named visible failure + refused cleanup, evidence kept", { skip: SKIP }, () => {
  const w = K.world("f1c");
  w.set({ curlDelete: "404" });
  const wk = w.worker("w1170-f1c", { listed: false });
  const d = w.dispatch(wk);
  const item = w.write(d, "REPORT", 1, "written, then the worker locks its outbox");
  fs.chmodSync(wk.outbox, 0o000);
  try {
    const p = w.pump(at(1));
    assert.equal(p.status, 3, p.stdout);
    assert.match(p.stdout, new RegExp(`capture_failed=2 .*errors=.*${d.did}:outbox_root_invalid`));
    const st = w.status(at(1));
    assert.equal(st.status, 3, "report-status degraded (visible)");
    assert.ok(JSON.parse(st.stdout).health.errors[d.did].includes("outbox_root_invalid"));
    const before = w.activeRaw();
    const c = w.cleanup(wk.sid);
    assert.equal(c.status, 1, "fail-closed: cleanup refused");
    assert.match(c.stderr, new RegExp(`REPORT_CAPTURE_FAILED for ${wk.sid}: ${d.did}:outbox_root_invalid`), "named in the refusal");
    assert.deepEqual(c.calls.filter((x) => x.role !== "dispatch-registry.py"), [], "no teardown actuator reached");
    assert.equal(w.activeRaw(), before, "registry untouched");
    assert.equal(fs.statSync(wk.outbox).mode & 0o777, 0, "no permission reset by the product");
  } finally {
    fs.chmodSync(wk.outbox, 0o700);
  }
  assert.ok(fs.readFileSync(item.file).equals(item.bytes), "worker evidence preserved");
  assert.deepEqual(rep(w, d).items, {});
});

test("F1d malformed helper output fails capture and refuses cleanup while preserving worker evidence", { skip: SKIP }, () => {
  const w = K.world("f1d");
  const wk = w.worker("w1170-f1d", { listed: false });
  const d = w.dispatch(wk);
  const item = w.write(d, "REPORT", 1, "keep on helper protocol failure");
  const shim = path.join(w.run.dir, "malformed-python");
  fs.writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' '{\"v\":1,\"status\":\"ok\",\"entries\":['\n", { mode: 0o700 });
  w.env.AIGENTRY_REPORT_PYTHON = shim;
  const p = w.pump(at(1));
  assert.equal(p.status, 3, p.stdout + p.stderr);
  assert.match(p.stdout, /capture_failed=2 .*helper_protocol_invalid/);
  assert.deepEqual(rep(w, d).items, {});
  const state = w.activeRaw();
  const c = w.cleanup(wk.sid);
  assert.equal(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stderr, /REPORT_CAPTURE_FAILED.*helper_protocol_invalid/);
  assert.deepEqual(c.calls.filter(x => x.role !== "dispatch-registry.py"), [], "no teardown actuator reached");
  assert.equal(w.activeRaw(), state);
  assert.ok(fs.readFileSync(item.file).equals(item.bytes));
});

test("F2 retired failed_seen past the 7-day scan window: bounded registry, evidence never deleted (desired)", { skip: SKIP }, () => {
  const w = K.world("f2");
  const wk = w.worker("w1170-f2");
  const d = w.dispatch(wk);
  const h = w.write(d, "HOLD", 1, "question, answered");
  assert.equal(w.pump(at(1)).status, 0);
  assert.equal(w.ack(d, "HOLD-1", h.sha, "answered", at(2)).status, 0);
  w.pump(at(31)); // overdue confirmed (no REPORT ever)
  const f = rep(w, d).failures[0];
  assert.equal(JSON.parse(w.ack(d, "failure-1", f.subject_sha256, "seen", at(33)).stdout).resolution, "failed_seen");
  assert.equal(w.reg(["set-lifecycle", "--sid", wk.sid, "--state", "cleaned", "--all", "--now", at(34)]).status, 0);
  const inbox = w.inboxFiles();
  assert.equal(inbox.length, 1);
  const evidence = fs.readFileSync(inbox[0]);
  const later = new Date(T0 + (8 * 24 * 60 + 40) * 60_000).toISOString().slice(0, 19) + "Z"; // review + 8 d
  // positive control: the pump no longer scans it (7-day window), so nobody will ever look at it again
  assert.match(w.pump(later).stdout, /rows=1 captured=0 capture_failed=0 notices=0 /);
  const pr = w.reg(["prune", "--older-than-seconds", "86400", "--now", later]);
  assert.equal(pr.status, 0, pr.stdout + pr.stderr);
  // never delete report evidence to get green
  assert.ok(fs.existsSync(inbox[0]) && fs.readFileSync(inbox[0]).equals(evidence), "report evidence must survive prune");
  const kept = JSON.parse(w.activeRaw()).dispatches.some((x) => x.dispatch_id === d.did);
  assert.equal(kept, false, `REPRODUCED F2: a retired failed_seen record past the scan window is kept in active.json forever ` +
    `(prune at +8 d kept dispatch ${d.did}; REPORT_KEEP includes failed_seen unconditionally)`);
});

test("F3a lease (2 min) shorter than a still-running inject + overlapping pump ⇒ duplicate notice (desired: one)", { skip: SKIP }, async () => {
  const w = K.world("f3a");
  const d = w.dispatch(w.worker("w1170-f3a"));
  w.write(d, "REPORT", 1, "slow delivery");
  const gate = path.join(w.run.dir, "release-inject");
  w.set({ injectReplies: [{ waitFile: gate }, {}] });
  const m = w.mark();
  const a = spawn(process.execPath, [K.TRACKER, "report-pump", "--once"], { env: { ...w.env, TRACKER_NOW: at(1) },
    stdio: ["ignore", "pipe", "pipe"] });
  let aOut = "";
  a.stdout.on("data", (b) => { aOut += b; });
  const aDone = new Promise((resolve) => {
    const t = setTimeout(() => a.kill("SIGKILL"), 60000);
    a.on("close", (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
  try {
    const until = Date.now() + 30000;
    while (!fs.existsSync(`${gate}.started`) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(`${gate}.started`), "pump A's inject is running");
    const claimed = rep(w, d).items["REPORT-1"].notice;
    assert.deepEqual([claimed.n, claimed.submit, claimed.next_at], [1, "pending", at(3)], "A holds a 2-min lease");
    // an overlapping pass (reconciler tick or a user `report-pump --loop`) after the lease, A still sending
    const b = w.pump(at(3.1));
    assert.equal(b.status, 0, b.stdout + b.stderr);
  } finally {
    fs.writeFileSync(gate, "");
  }
  const ra = await aDone;
  assert.equal(ra.code, 3, `pump A exit ${ra.code}/${ra.signal}: ${aOut}`);
  assert.match(aOut, new RegExp(`${d.did}:notice_result_8`), "A's late result raced B's claim");
  const sends = K.submits(w.since(m)).filter((c) => c.argv.at(-1).includes("item=REPORT-1"));
  assert.equal(sends.length, 1, `REPRODUCED F3a: ${sends.length} notices for REPORT-1 while the first inject was still running ` +
    `(claim lease 2 min < inject timeout 180 s; overlapping pump re-claimed n=2)`);
});

test("F3b pump killed mid unbound-turn notice (reconciler 300 s kill seam) ⇒ the 'once' notice repeats (desired: once)", { skip: SKIP }, async () => {
  const w = K.world("f3b");
  const wk = w.worker("w1170-f3b");
  w.dispatch(wk); // an open bound request makes the attempt's _unbound dir scanned
  // the REAL hook writes an unbound TURN: an unbound prompt, then Stop
  assert.equal(w.hook(wk, "UserPromptSubmit", { session_id: "s-f3b", prompt: "hello, not a dispatch ref" }).status, 0);
  assert.equal(w.hook(wk, "Stop", { session_id: "s-f3b", last_assistant_message: "done talking" }).status, 0);
  assert.ok(fs.existsSync(path.join(wk.outbox, "_unbound", "TURN-1.md")));
  w.set({ injectReplies: [{ crash: true }, {}] });
  const m = w.mark();
  const p1 = w.pump(at(1));
  assert.equal(p1.signal, "SIGKILL", "the pass was killed during the unbound notice (before finishHealth)");
  const p2 = w.pump(at(2));
  assert.equal(p2.status, 0, p2.stdout);
  const unbound = K.submits(w.since(m)).filter((c) => c.argv.at(-1).startsWith("⟦aigentry-report v1⟧ TURN_ENDED_UNBOUND"));
  assert.equal(unbound.length, 1, `REPRODUCED F3b: TURN_ENDED_UNBOUND for _unbound/TURN-1 sent ${unbound.length}× ` +
    "(unbound_seen is saved in finishHealth, after the send)");
});

test("F4a second invalid item after the first was seen gets its own visible failure (desired)", { skip: SKIP }, () => {
  const w = K.world("f4a");
  const d = w.dispatch(w.worker("w1170-f4a"));
  w.write(d, "REPORT", 1, null, { bytes: itemBytes(d.req, "REPORT", 1, "bad challenge", { challenge: mint().challenge }) });
  w.pump(at(1));
  const f1 = rep(w, d).failures;
  assert.deepEqual(f1.map((f) => [f.event, f.detail]), [["item_invalid", "REPORT-1.md: bad_challenge"]]);
  w.pump(at(2));
  assert.equal(w.ack(d, "failure-1", f1[0].subject_sha256, "seen", at(3)).status, 0);
  const old = mint(); // an envelope from an older dispatch
  w.write(d, "REPORT", 2, null, { bytes: itemBytes(old, "REPORT", 2, "stale envelope") });
  const p = w.pump(at(4));
  assert.match(p.stdout, /item_wrong_request/, "positive control: the pump saw REPORT-2 as wrong_request");
  const later = w.pump(at(5));
  const inv = rep(w, d).failures.filter((f) => f.event === "item_invalid");
  const notes = K.submits([...p.calls, ...later.calls]).filter((c) => c.argv.at(-1).includes("REPORT-2"));
  assert.ok(inv.length === 2 && notes.length >= 1, `REPRODUCED F4a: REPORT-2 (wrong_request) produced ${inv.length - 1} new ` +
    `failure record(s) and ${notes.length} notice(s); item_invalid is deduplicated per record lifetime`);
});

test("F4b all 9 failure kinds are recordable (cap ≥ kinds) and a 9th condition is not a per-pass error (desired)", { skip: SKIP }, () => {
  const w = K.world("f4b");
  const d = w.dispatch(w.worker("w1170-f4b"));
  const kinds = ["exited", "dead", "gone", "cleaned", "delivery_unknown", "item_conflict", "item_invalid", "hook_degraded"];
  for (const [i, k] of kinds.entries()) {
    const r = w.reg(["report-event", "--dispatch-id", d.did, "--kind", "failure", "--item", k, "--field", "stage=confirm",
      "--field", `detail=seeded ${k}`, "--now", at(i + 1)]);
    assert.equal(r.status, 0, `${k}: ${r.stdout}${r.stderr}`);
  }
  assert.equal(rep(w, d).failures.length, 8);
  // the 9th kind arises naturally: expected_report_by passes with no REPORT
  const p1 = w.pump(at(31));
  const p2 = w.pump(at(32));
  const ninth = K.events([...p1.calls, ...p2.calls], "failure").filter((c) => c.argv.includes("overdue"));
  assert.ok(ninth.length >= 1, "positive control: decide() raised overdue as the 9th kind");
  const errs = [p1.stdout, p2.stdout].map((o) => (new RegExp(`${d.did}:[^;\\s]*failure_event_4`).test(o) ? "failure_event_4" : "none"));
  assert.deepEqual([rep(w, d).failures.length, ...errs], [9, "none", "none"],
    `REPRODUCED F4b: 9 failure kinds vs cap 8 — overdue rc ${ninth.map((c) => c.rc)}; per-pass errors ${JSON.stringify(errs)}`);
});

