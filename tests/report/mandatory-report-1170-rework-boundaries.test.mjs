// #1170 rework acceptance boundaries (rf1170arz-coder API-CONTRACT-REWORK): the new branches the
// review suite does not reach. Each case proves its observation seam with a positive control first.
//
//   R1  prune archive (F2): full row appended BEFORE the commit drops it; archive open failure →
//       exit 9, active row kept, inbox evidence byte-identical.
//   R2  locate() binding guard (N2): a non-uuid attempt / non-hex64 manifest sha is refused as
//       chain_bad_binding by the REAL `report-pump --once` before any fs touch of the joined path.
//   R3  F1a/F1c naming: a registry-refused TURN is `ignored` (registry result turn_fields_invalid,
//       nothing written) and not a capture failure; a genuine registry storage failure on capture
//       stays capture_event_9 and refuses cleanup.
//   R4  N1 temp ref: `__probe dispatch-ref` creates dispatch-ref.<32hex> 0600 via "wx", unlinks it
//       after the inject; a planted file/symlink at the name is refused, never clobbered.
//
// Seams: the shared hermetic world (real registry/pump/cleanup; fakes for telepty/wh-cli/curl),
// the registry's existing AIGENTRY_REGISTRY_FAULT, and test-only `node --import` preloads in the
// child (an fs spy; a pinned crypto.randomBytes(16)). No product file is changed.
// POSIX only (shared harness).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { worldKit } from "./mandatory-report-1170.fakes.mjs";

const POSIX = process.platform === "darwin" || process.platform === "linux";
const SKIP = POSIX ? false : `POSIX-only rework boundaries; not run on ${process.platform}`;
const H = POSIX ? await import("../dispatch/agent-metadata/support/harness.mjs") : null;
const K = POSIX ? worldKit(H) : null;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DISPATCH_CLI = path.join(REPO, "dist/src/dispatch/cli.js");

const T0 = Date.parse("2026-10-09T12:00:00Z");
const at = (min) => new Date(T0 + min * 60_000).toISOString().slice(0, 19) + "Z";
const field = (stdout, name) => Number(new RegExp(`${name}=(\\d+)`).exec(stdout)?.[1]);
const health = (w) => JSON.parse(fs.readFileSync(path.join(w.stateDir, "report-pump-health.json"), "utf8"));
const active = (w) => JSON.parse(w.activeRaw());

/** F2 fixture: a HOLD answered, overdue confirmed + ACKed seen ⇒ failed_seen; lifecycle cleaned. */
function failedSeenRetired(label) {
  const w = K.world(label);
  const wk = w.worker(`w1170-${label}`);
  const d = w.dispatch(wk);
  const h = w.write(d, "HOLD", 1, "question, answered");
  assert.equal(w.pump(at(1)).status, 0);
  assert.equal(w.ack(d, "HOLD-1", h.sha, "answered", at(2)).status, 0);
  w.pump(at(31));
  const f = w.row(d.did).report.failures[0];
  assert.equal(JSON.parse(w.ack(d, "failure-1", f.subject_sha256, "seen", at(33)).stdout).resolution, "failed_seen");
  assert.equal(w.reg(["set-lifecycle", "--sid", wk.sid, "--state", "cleaned", "--all", "--now", at(34)]).status, 0);
  const inbox = w.inboxFiles();
  assert.equal(inbox.length, 1);
  const later = new Date(T0 + (8 * 24 * 60 + 40) * 60_000).toISOString().slice(0, 19) + "Z"; // review + 8 d
  return { w, d, inbox: inbox[0], evidence: fs.readFileSync(inbox[0]), later,
    prune: (env = {}) => H.sh(path.join(w.trace, "dispatch-registry.py"),
      ["prune", "--older-than-seconds", "86400", "--now", later], { env: { ...w.env, ...env }, timeout: 60000 }) };
}
const archivePath = (w) => path.join(w.stateDir, "report-archive.jsonl");
const archiveLines = (w) => fs.readFileSync(archivePath(w), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("R1a prune archives the full failed_seen row before the commit drops it; evidence untouched", { skip: SKIP }, () => {
  const { w, d, inbox, evidence, prune } = failedSeenRetired("r1a");
  const row = w.row(d.did);
  // ordering: with the commit faulted (existing registry seam) the archive line is already durable
  // and the row is still in active.json — the append precedes the removal.
  const before = w.activeRaw();
  const faulted = prune({ AIGENTRY_REGISTRY_FAULT: "temp_write" });
  assert.equal(faulted.status, 9, faulted.stdout + faulted.stderr);
  assert.equal(w.activeRaw(), before, "faulted commit: registry unchanged, row kept");
  const l1 = archiveLines(w);
  assert.equal(l1.length, 1, "archive appended before the (faulted) commit");
  assert.deepEqual(l1[0].record, row, "full row, byte-for-byte as in active.json");
  assert.equal(l1[0].reason, "failed_seen_retired_past_scan_window");
  assert.equal(fs.statSync(archivePath(w)).mode & 0o777, 0o600);
  // the normal prune: archived (at-least-once ⇒ a second line), removed, evidence never touched
  const ok = prune();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(active(w).dispatches.some((x) => x.dispatch_id === d.did), false, "row removed from active.json");
  const l2 = archiveLines(w);
  assert.equal(l2.length, 2);
  assert.deepEqual(l2[1].record, row);
  assert.ok(fs.readFileSync(inbox).equals(evidence), "inbox evidence byte-identical");
});

test("R1b archive open failure (archive name is a directory / a symlink): exit 9, row kept, nothing followed", { skip: SKIP }, () => {
  for (const kind of ["directory", "symlink"]) {
    const { w, d, inbox, evidence, prune } = failedSeenRetired(`r1b-${kind}`);
    const sentinel = path.join(w.run.dir, "sentinel-archive");
    fs.writeFileSync(sentinel, "SENTINEL\n");
    if (kind === "directory") fs.mkdirSync(archivePath(w));
    else fs.symlinkSync(sentinel, archivePath(w));
    const row = w.row(d.did);
    const r = prune();
    assert.equal(r.status, 9, `${kind}: ${r.stdout}${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.result, "registry_write_failed");
    assert.match(out.detail, /report archive append failed, 1 record\(s\) kept/);
    assert.deepEqual(w.row(d.did), row, `${kind}: original active row retained`);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "SENTINEL\n", `${kind}: symlink target never written`);
    if (kind === "symlink") assert.ok(fs.lstatSync(archivePath(w)).isSymbolicLink());
    assert.ok(fs.readFileSync(inbox).equals(evidence), `${kind}: inbox evidence byte-identical`);
    assert.match(fs.readFileSync(path.join(w.stateDir, "registry-health.log"), "utf8"), /registry_write_failed report archive/);
  }
});

/** A test-only preload for the REAL tracker CLI: logs every fs call whose path contains a needle. */
function fsSpy(w) {
  const file = path.join(w.run.dir, "fs-spy.mjs");
  fs.writeFileSync(file, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const LOG = process.env.SPY_LOG; const NEEDLES = JSON.parse(process.env.SPY_NEEDLES);",
    "const append = fs.appendFileSync;",
    'for (const name of ["realpathSync", "existsSync", "openSync", "readFileSync", "statSync", "lstatSync", "opendirSync", "readdirSync", "accessSync"]) {',
    "  const orig = fs[name];",
    "  const wrapped = function (p, ...rest) {",
    "    const s = String(p).toLowerCase();",
    "    if (NEEDLES.some((n) => s.includes(n))) append(LOG, JSON.stringify({ fn: name, p: String(p) }) + \"\\n\");",
    "    return orig.call(this, p, ...rest);",
    "  };",
    "  if (orig.native) wrapped.native = orig.native;",
    "  fs[name] = wrapped;",
    "}",
    "syncBuiltinESMExports();",
  ].join("\n"));
  return pathToFileURL(file).href;
}

test("R2 report-pump refuses a tampered attempt/manifest binding before any fs touch; a valid binding still captures", { skip: SKIP }, () => {
  const w = K.world("r2");
  const spy = fsSpy(w);
  const spyLog = path.join(w.run.logs, "fs-spy.jsonl");
  const pump = (now, needles) => {
    fs.writeFileSync(spyLog, "");
    const r = H.sh(process.execPath, ["--import", spy, K.TRACKER, "report-pump", "--once"],
      { env: { ...w.env, TRACKER_NOW: now, SPY_LOG: spyLog, SPY_NEEDLES: JSON.stringify(needles) }, timeout: 120000 });
    return { ...r, touches: fs.readFileSync(spyLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };
  const wk = w.worker("w1170-r2", { listed: false });
  const d = w.dispatch(wk);
  w.write(d, "REPORT", 1, "final");
  // an outside synthetic sentinel the traversal would reach: <sessionsRoot>/<sid>/sandbox/../../../trap-r2 = <run>/trap-r2
  const trap = path.join(w.run.dir, "trap-r2");
  fs.cpSync(wk.root, trap, { recursive: true });
  const attempt0 = w.row(d.did).assigned.attempt;
  assert.equal(attempt0, wk.attempt);
  const tamper = (assigned) => {
    const doc = active(w);
    Object.assign(doc.dispatches.find((x) => x.dispatch_id === d.did).assigned, assigned);
    fs.writeFileSync(path.join(w.stateDir, "active.json"), JSON.stringify(doc, null, 2) + "\n");
  };
  const needles = ["trap-r2", wk.attempt.toLowerCase()];
  const cases = [
    ["traversal attempt", { attempt: "../../../trap-r2", manifest_sha256: wk.hash }],
    ["uppercase uuid attempt (case-folding FS would resolve it)", { attempt: wk.attempt.toUpperCase(), manifest_sha256: wk.hash }],
    ["non-hex64 manifest sha", { attempt: wk.attempt, manifest_sha256: `../${wk.hash.slice(3)}` }],
  ];
  for (const [name, assigned] of cases) {
    tamper(assigned);
    const p = pump(at(1), needles);
    assert.equal(p.status, 3, `${name}: ${p.stdout}${p.stderr}`);
    assert.match(p.stdout, new RegExp(`errors=\\S*${d.did}:chain_bad_binding`), `${name}: ${p.stdout}`);
    assert.equal(field(p.stdout, "captured"), 0, name);
    assert.deepEqual(p.touches, [], `${name}: guard ran before any fs access of the joined path`);
    assert.deepEqual(w.row(d.did).report.items, {}, name);
  }
  // positive control: restored binding ⇒ the same spy sees the sealed manifest read, and REPORT-1 is captured
  tamper({ attempt: attempt0, manifest_sha256: wk.hash });
  const ok = pump(at(2), needles);
  assert.ok(ok.touches.some((t) => t.p === path.join(wk.root, "manifest.json")), `spy sees production reads: ${JSON.stringify(ok.touches.slice(0, 5))}`);
  assert.ok(!ok.touches.some((t) => t.p.includes("trap-r2")));
  assert.equal(field(ok.stdout, "captured"), 1, ok.stdout);
  assert.equal(field(ok.stdout, "capture_failed"), 0, ok.stdout);
  assert.ok(w.row(d.did).report.items["REPORT-1"]);
});

/** A worker-forged TURN for request R (as the review suite's F1a). */
function forgedTurn(req, seq, after) {
  return Buffer.from(`AIGENTRY_REPORT v1 request_id=${req.request_id} challenge=${req.challenge} kind=TURN seq=${seq}\n` +
    `end=stop\nturn=1\nsession=forged-1\nassoc=exact\nbefore=-\nafter=${after}\nat=2026-10-09T12:00:00Z\n` +
    `observed_by=hook\n-----BEGIN UNTRUSTED-----\n\n-----END UNTRUSTED-----\nAIGENTRY_REPORT_END ${req.request_id} TURN-${seq}\n`);
}

test("R3a registry-refused bound TURN: result turn_fields_invalid (exit 4, no write) → pump `ignored`, not an error", { skip: SKIP }, () => {
  const w = K.world("r3a");
  const wk = w.worker("w1170-r3a", { listed: false });
  const d = w.dispatch(wk);
  w.write(d, "TURN", 1, null, { bytes: forgedTurn(d.req, 1, `${d.req.request_id}/REPORT-1`) });
  const p = w.pump(at(1));
  const cap = K.events(p.calls, "captured");
  assert.equal(cap.length, 1);
  assert.equal(cap[0].rc, 4);
  // the registry's explicit name for exactly that call, and no write
  const before = w.activeRaw();
  const again = w.reg(cap[0].argv);
  assert.equal(again.status, 4);
  assert.equal(JSON.parse(again.stdout).result, "turn_fields_invalid");
  assert.equal(w.activeRaw(), before, "refused TURN writes nothing");
  // the caller's mapping: visible as ignored, not an error, not a capture failure
  assert.equal(p.status, 0, p.stdout);
  assert.equal(field(p.stdout, "capture_failed"), 0);
  const h = health(w);
  assert.deepEqual(h.ignored[d.did], ["TURN-1.md:registry_bad_fields"]);
  assert.equal(h.errors[d.did], undefined);
  assert.deepEqual(w.row(d.did).report.items, {});
});

test("R3b genuine registry storage failure on capture stays capture_event_9 and refuses cleanup; recovered storage captures", { skip: SKIP }, () => {
  const w = K.world("r3b");
  w.set({ curlDelete: "404" });
  const wk = w.worker("w1170-r3b", { listed: false });
  const d = w.dispatch(wk);
  const item = w.write(d, "REPORT", 1, "final");
  const FAULT = { AIGENTRY_REGISTRY_FAULT: "temp_write" };
  const before = w.activeRaw();
  const p = w.pump(at(1), { env: FAULT });
  assert.equal(p.status, 3, p.stdout);
  assert.equal(field(p.stdout, "capture_failed"), 1, p.stdout);
  assert.match(p.stdout, new RegExp(`errors=\\S*${d.did}:capture_event_9`));
  assert.equal(health(w).ignored[d.did], undefined, "a storage failure is never `ignored`");
  const m = w.mark();
  const c = H.sh(process.execPath, [path.join(REPO, "dist/src/cleanup/cli.js"), wk.sid], { env: { ...w.env, ...FAULT }, timeout: 60000 });
  assert.equal(c.status, 1, c.stdout + c.stderr);
  assert.match(c.stderr, new RegExp(`REPORT_CAPTURE_FAILED for ${wk.sid}: ${d.did}:capture_event_9`));
  assert.deepEqual(w.since(m).filter((x) => x.role !== "dispatch-registry.py"), [], "no teardown actuator reached");
  assert.equal(w.activeRaw(), before, "registry untouched");
  assert.ok(fs.readFileSync(item.file).equals(item.bytes), "worker evidence preserved");
  // positive control: same world, storage healthy ⇒ captured, cleanup proceeds
  const c2 = w.cleanup(wk.sid);
  assert.equal(c2.status, 0, c2.stdout + c2.stderr);
  assert.equal(w.row(d.did).report.current_final, "REPORT-1");
});

/** dispatch's `__probe dispatch-ref` (prepareEffectiveRef → mkTemp → inject) with a recording telepty. */
function refProbe(label) {
  const run = H.makeRun(label);
  const rec = path.join(run.logs, "telepty.jsonl");
  fs.writeFileSync(rec, "");
  H.fake(run, "telepty", `#!${process.execPath}\n` +
    'const fs = require("node:fs"); const a = process.argv.slice(2); const i = a.indexOf("--ref");\n' +
    "const f = i >= 0 ? a[i + 1] : null; let st = null, body = null;\n" +
    "try { const s = fs.lstatSync(f); st = { mode: s.mode & 0o777, file: s.isFile(), uid: s.uid }; body = fs.readFileSync(f, \"utf8\"); } catch {}\n" +
    `fs.appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: a, ref: f, st, body }) + "\\n");\n` +
    "process.exit(Number(process.env.FAKE_INJECT_RC || 0));\n");
  H.fake(run, "report-target", "#!/bin/sh\necho orchestrator@100.64.0.1\n");
  const ref = path.join(run.dir, "ref.md");
  fs.writeFileSync(ref, "task body\nREPORT to {{ORCHESTRATOR_REPORT_TARGET}}\n");
  const pin = path.join(run.dir, "pin-random.mjs");
  fs.writeFileSync(pin, 'import crypto from "node:crypto"; import { syncBuiltinESMExports } from "node:module";\n' +
    "const orig = crypto.randomBytes;\n" +
    "crypto.randomBytes = (n, cb) => (n === 16 && !cb ? Buffer.alloc(16, 0xab) : orig(n, cb));\nsyncBuiltinESMExports();\n");
  const PINNED = path.join(run.tmp, `dispatch-ref.${"ab".repeat(16)}`);
  const go = ({ pinned = false, rc = 0 } = {}) => {
    const m = fs.readFileSync(rec, "utf8").split("\n").filter(Boolean).length;
    const r = H.sh(process.execPath, [...(pinned ? ["--import", pathToFileURL(pin).href] : []), DISPATCH_CLI,
      "__probe", "dispatch-ref", "--ref", ref, "--from", "orchestrator", "sid-A"],
    { env: H.hermeticEnv(run, { TELEPTY: path.join(run.fakes, "telepty"), REPORT_TARGET_SH: path.join(run.fakes, "report-target"),
      FAKE_INJECT_RC: String(rc) }), timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    const calls = fs.readFileSync(rec, "utf8").split("\n").filter(Boolean).slice(m).map((l) => JSON.parse(l));
    return { ...r, calls };
  };
  const temps = () => fs.readdirSync(run.tmp).filter((n) => n.startsWith("dispatch-ref."));
  return { run, go, temps, PINNED };
}

test("R4a temp ref: dispatch-ref.<32hex> in TMPDIR, private 0600 regular file, substituted, unlinked after the inject (rc 0 and rc≠0)", { skip: SKIP }, () => {
  const P = refProbe("r4a");
  for (const rc of [0, 5]) {
    const r = P.go({ rc });
    assert.equal(r.status, rc, r.stdout + r.stderr);
    assert.equal(r.calls.length, 1);
    const c = r.calls[0];
    assert.match(path.basename(c.ref), /^dispatch-ref\.[0-9a-f]{32}$/);
    assert.equal(path.dirname(c.ref), P.run.tmp);
    assert.deepEqual(c.st, { mode: 0o600, file: true, uid: process.getuid() });
    assert.equal(c.body, "task body\nREPORT to orchestrator@100.64.0.1\n");
    assert.deepEqual(P.temps(), [], `rc ${rc}: temp unlinked after the inject`);
  }
  assert.deepEqual(P.run.tripwireHits(), "");
});

test("R4b planted file / symlink at the (pinned) temp name: refused via O_EXCL, never clobbered or followed, no inject", { skip: SKIP }, () => {
  const P = refProbe("r4b");
  // positive control: the pin really controls the name (no plant ⇒ the inject sees exactly PINNED)
  const ctl = P.go({ pinned: true });
  assert.equal(ctl.status, 0, ctl.stdout + ctl.stderr);
  assert.equal(ctl.calls[0].ref, P.PINNED);
  assert.deepEqual(P.temps(), []);
  const sentinel = path.join(P.run.dir, "sentinel-ref");
  for (const kind of ["file", "symlink"]) {
    fs.writeFileSync(sentinel, "SENTINEL\n", { mode: 0o644 });
    fs.chmodSync(sentinel, 0o644);
    assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644, "sentinel starts at the asserted mode");
    if (kind === "file") {
      fs.writeFileSync(P.PINNED, "PLANTED\n", { mode: 0o644 });
      fs.chmodSync(P.PINNED, 0o644);
      assert.equal(fs.statSync(P.PINNED).mode & 0o777, 0o644, "planted file starts at the asserted mode");
    } else fs.symlinkSync(sentinel, P.PINNED);
    const r = P.go({ pinned: true });
    assert.notEqual(r.status, 0, `${kind}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /EEXIST/);
    assert.equal(r.calls.length, 0, `${kind}: nothing injected`);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "SENTINEL\n", `${kind}: symlink target untouched`);
    assert.equal(fs.statSync(sentinel).mode & 0o777, 0o644);
    if (kind === "file") {
      assert.equal(fs.readFileSync(P.PINNED, "utf8"), "PLANTED\n", "planted file not clobbered");
      assert.equal(fs.statSync(P.PINNED).mode & 0o777, 0o644);
    } else {
      assert.ok(fs.lstatSync(P.PINNED).isSymbolicLink(), "planted symlink left as is");
      assert.equal(fs.readlinkSync(P.PINNED), sentinel);
    }
    fs.rmSync(P.PINNED);
  }
  assert.deepEqual(P.run.tripwireHits(), "");
});
