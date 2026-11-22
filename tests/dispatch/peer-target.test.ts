// Task 1291 U5 — dispatch peer branch (SPEC §10, §11), TEST-PLAN §2.5 D1–D8.
// Runs the compiled production CLI (dist/src/dispatch/cli.js) as a subprocess, like target-sid.test.ts.
// Injected seams (API.md): the process runner is the `TELEPTY` binary (a fake node script that records
// its argv and answers per PEER_MODE), the store root is AIGENTRY_CONTROLLER_LINK_DIR (a fresh temp dir)
// and the peer list is AIGENTRY_CONTROLLER_PEERS. No real telepty, daemon, network or session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fixture, REPO } from "./model-router-fixtures.js";

const CLI = join(REPO, "dist/src/dispatch/cli.js");
const TARGET = "orchestrator@linux";
const INJECT_ID = "0b7e9d2a-1c3f-4a5b-9d8e-7f6a5b4c3d2e";
const CALLER = "peer-target-fixture";
const CONFIG = {
  v: 1,
  self: { label: "mac", controller_sid: "orchestrator" },
  peers: { linux: { target: TARGET, link: "v1" }, old: { target: "orchestrator@old-box" } },
};

// The injected process runner: records argv and the TELEPTY_SESSION_* keys it was given, then answers
// with the markers SPEC §6.1 classifies. `corrupt` damages the outbox record while "telepty" runs, so
// the §6.1 step-4 write fails after the send (Root Q3).
const FAKE_TELEPTY = `
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.PEER_LOG, JSON.stringify({ argv,
  sessionEnv: Object.keys(process.env).filter((k) => k.toUpperCase().startsWith('TELEPTY_SESSION_')) }) + '\\n');
if (argv[0] !== 'inject') process.exit(99);
let mode = process.env.PEER_MODE || 'consumed';
if (mode === 'corrupt') {
  const dir = path.join(process.env.AIGENTRY_CONTROLLER_LINK_DIR, 'outbox');
  for (const n of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, n), '{');
  mode = 'consumed';
}
if (mode === 'consumed') { console.log('inject_id: ${INJECT_ID}'); console.log('✅ Submitted — consumed as a new turn.'); process.exit(0); }
if (mode === 'queued') { console.log('inject_id: ${INJECT_ID}'); console.log('⏳ QUEUED, NOT consumed'); process.exit(0); }
if (mode === 'refused') { console.log('❌ [SESSION_NOT_FOUND] Session not found'); process.exit(1); }
console.error('socket hang up'); process.exit(1);
`;

interface Call { argv: string[]; sessionEnv: string[] }

function setup(config: unknown = CONFIG) {
  const f = fixture();
  const store = join(f.root, "cl-store"), peers = join(f.root, "controller-peers.json"), log = join(f.root, "peer-telepty.log");
  writeFileSync(peers, typeof config === "string" ? config : JSON.stringify(config));
  const telepty = f.script("peer-telepty", FAKE_TELEPTY);
  // AIGENTRY_DISPATCH_CALLER: the unchanged task gate's --no-task audit (noTaskTelemetry) names its
  // caller from this seam, else it runs `ps`, which the fixture's tripwire forbids. The shell
  // fixtures set it the same way (tests/dispatch/lib.sh:310).
  const env: NodeJS.ProcessEnv = { ...f.env, TELEPTY: telepty, PEER_LOG: log, PEER_MODE: "consumed",
    AIGENTRY_CONTROLLER_LINK_DIR: store, AIGENTRY_CONTROLLER_PEERS: peers, AIGENTRY_DISPATCH_CALLER: CALLER };
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [CLI, "--ref", f.ref, ...args],
    { cwd: f.root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 });
  const calls = (): Call[] => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call) : [];
  const registry = join(f.root, "state/active.json");
  const seeded = { queue: readFileSync(f.queue, "utf8"), registry: readFileSync(registry, "utf8") };
  const sessions = f.env.AIGENTRY_SESSIONS_ROOT!;
  /** Nothing written anywhere: store, sessions root, queue, registry, telemetry; telepty never called. */
  const assertUntouched = (why: string) => {
    assert.equal(existsSync(store), false, `${why}: store created`);
    assert.equal(existsSync(sessions), false, `${why}: sessions root touched`);
    assert.equal(readFileSync(f.queue, "utf8"), seeded.queue, `${why}: queue written`);
    assert.equal(readFileSync(registry, "utf8"), seeded.registry, `${why}: registry written`);
    assert.equal(existsSync(f.env.TELEMETRY_LOG!), false, `${why}: dispatch telemetry`);
    assert.deepEqual(calls(), [], `${why}: telepty called`);
  };
  const record = (id: string) => JSON.parse(readFileSync(join(store, "outbox", `${id}.json`), "utf8"));
  const idFrom = (text: string): string => {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/.exec(text);
    assert.ok(m, `no request id in: ${text}`);
    return m[1]!;
  };
  return { f, store, peers, log, env, run, calls, seeded, sessions, registry, assertUntouched, record, idFrom };
}

const stderrLine = (stderr: string, prefix: string): string | undefined => stderr.split("\n").find((l) => l.startsWith(prefix));

// ── D1 ────────────────────────────────────────────────────────────────────────
test("D1 configured orchestrator@linux + valid task → C7 argv, exit 0, ledger stamp, outbox record, no registry/staging", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083"], { TELEPTY_SESSION_ID: "leak", TELEPTY_SESSION_HOST: "leak" });
    assert.equal(r.status, 0, r.stderr);
    const m = /^OK peer request ([0-9a-f-]{36}) to orchestrator@linux consumption=consumed\n$/.exec(r.stdout);
    assert.ok(m, `stdout: ${JSON.stringify(r.stdout)}`);
    const id = m[1]!;
    const calls = s.calls();
    assert.equal(calls.length, 1, "exactly one inject");
    const text = calls[0]!.argv[8]!;
    assert.deepEqual(calls[0]!.argv,
      ["inject", "--submit", "--no-submit-force", "--submit-retry", "0", "--from", "controller-link", TARGET, text]);
    assert.ok(!calls[0]!.argv.includes("--ref") && !calls[0]!.argv.includes("--submit-force"));
    assert.deepEqual(calls[0]!.sessionEnv, [], "no TELEPTY_SESSION_* reaches telepty");
    assert.ok(text.startsWith(`⟦aigentry-ctl v1⟧ kind=REQUEST id=${id} seq=1 ref=- from=mac to=linux sent_at=`), text);
    assert.ok(text.includes(" sender_task=1083 receiver_task=- state=- outcome=- final=- reason=- body_sha256="), text);
    assert.ok(text.split("\n").includes("Implement the fixture router. TASK-FIRST-4KB"), "ref is the inline body");
    assert.ok(text.endsWith(`⟦aigentry-ctl end⟧ id=${id} kind=REQUEST seq=1`));

    const rec = s.record(id);
    assert.equal(rec.role, "sender");
    assert.equal(rec.state, "sent");
    assert.equal(rec.peer, "linux");
    assert.equal(rec.peer_target, TARGET);
    assert.equal(rec.self_label, "mac");
    assert.equal(rec.sender_task, "1083");
    assert.equal(rec.receiver_task, null);
    assert.equal(rec.next_action.code, "WAIT_ACK");
    const msg = rec.messages["REQUEST-1"];
    const sha = createHash("sha256").update(text, "utf8").digest("hex");
    assert.equal(msg.sha256, sha);
    assert.equal(msg.raw, `raw/${sha}.env`);
    assert.equal(msg.sends.length, 1);
    assert.equal(msg.sends[0].result, "handed_over");
    assert.equal(msg.sends[0].submit, "consumed");
    assert.equal(msg.sends[0].inject_id, INJECT_ID);
    assert.match(msg.sends[0].owner, /^\d+@.+$/, "owner is <pid>@<host>");
    assert.deepEqual(rec.history.map((h: { event: string }) => h.event), ["created", "send"]);
    assert.equal(readFileSync(join(s.store, "raw", `${sha}.env`), "utf8"), text, "raw file = sent bytes");
    assert.equal(Date.parse(rec.next_action.due_at) - Date.parse(msg.sends[0].at), 5 * 60_000, "probe due +5 min");

    const row = (JSON.parse(readFileSync(s.f.queue, "utf8")).tasks as { id: unknown; status: string; note: string }[])
      .find((t) => String(t.id) === "1083")!;
    assert.equal(row.status, "delegated", "taskLedgerUpdate promoted the row");
    assert.ok(row.note.includes(`sid=${TARGET} `), row.note);
    assert.equal(readFileSync(s.registry, "utf8"), s.seeded.registry, "NO dispatch-registry record");
    assert.equal(existsSync(s.sessions), false, "NO staging under the sessions root");
    assert.equal(existsSync(s.f.env.TELEMETRY_LOG!), false, "no worker dispatch telemetry");
  } finally { s.f.cleanup(); }
});

test("D1 submit=queued → consumption=queued, first probe due +30 min", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083"], { PEER_MODE: "queued" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, / consumption=queued\n$/);
    const rec = s.record(s.idFrom(r.stdout));
    assert.equal(rec.state, "sent");
    assert.equal(Date.parse(rec.next_action.due_at) - Date.parse(rec.messages["REQUEST-1"].sends[0].at), 30 * 60_000);
  } finally { s.f.cleanup(); }
});

// ── D2 ────────────────────────────────────────────────────────────────────────
for (const target of ["orchestrator@unlisted", "worker@linux", "orchestrator@127.0.0.1", "../evil@linux", "orchestrator@old-box"]) {
  test(`D2 ${target} → exit 78 PEER_TARGET_REFUSED, nothing written anywhere`, () => {
    const s = setup();
    try {
      const r = s.run(["--target", target, "--task", "1083"]);
      assert.equal(r.status, 78, r.stderr);
      assert.ok(stderrLine(r.stderr, "dispatch.sh: PEER_TARGET_REFUSED: "), r.stderr);
      assert.equal(r.stdout, "");
      s.assertUntouched(target);
    } finally { s.f.cleanup(); }
  });
}

const peersWith = (patch: (c: typeof CONFIG & Record<string, unknown>) => unknown): string =>
  JSON.stringify(patch(JSON.parse(JSON.stringify(CONFIG))));
const INVALID_CONFIGS: [string, string | null, NodeJS.ProcessEnv][] = [
  ["missing file", null, {}],
  ["unparseable", "{", {}],
  ["not UTF-8", "ÿ", {}],
  ["unknown top-level key", peersWith((c) => ({ ...c, extra: 1 })), {}],
  ["unknown self key", peersWith((c) => ({ ...c, self: { ...c.self, host: "x" } })), {}],
  ["unknown peer key", peersWith((c) => ({ ...c, peers: { ...c.peers, linux: { ...c.peers.linux, token: "x" } } })), {}],
  ["duplicate target", peersWith((c) => ({ ...c, peers: { ...c.peers, other: { target: TARGET, link: "v1" } } })), {}],
  ["peer label fails its pattern", peersWith((c) => ({ ...c, peers: { Linux: c.peers.linux } })), {}],
  ["self label fails its pattern", peersWith((c) => ({ ...c, self: { ...c.self, label: "Mac" } })), {}],
  ["controller_sid fails its pattern", peersWith((c) => ({ ...c, self: { ...c.self, controller_sid: "a b" } })), {}],
  ["v is not 1", peersWith((c) => ({ ...c, v: 2 })), {}],
  ["self missing", peersWith((c) => ({ v: c.v, peers: c.peers })), {}],
  ["target not <sid>@<peer>", peersWith((c) => ({ ...c, peers: { linux: { target: "orchestrator", link: "v1" } } })), {}],
  ["link not a string", peersWith((c) => ({ ...c, peers: { linux: { target: TARGET, link: 1 } } })), {}],
  ["relative AIGENTRY_CONTROLLER_PEERS", JSON.stringify(CONFIG), { AIGENTRY_CONTROLLER_PEERS: "controller-peers.json" }],
];
for (const [name, content, overrides] of INVALID_CONFIGS) {
  test(`D2 peer list ${name} → exit 78 PEER_CONFIG_INVALID, nothing written anywhere`, () => {
    const s = setup();
    try {
      if (content === null) rmSync(s.peers);
      else writeFileSync(s.peers, content === "ÿ" ? Buffer.from([0xff]) : content);
      const r = s.run(["--target", TARGET, "--task", "1083"], overrides);
      assert.equal(r.status, 78, r.stderr);
      assert.ok(stderrLine(r.stderr, "dispatch.sh: PEER_CONFIG_INVALID: "), r.stderr);
      s.assertUntouched(name);
    } finally { s.f.cleanup(); }
  });
}

test("D2 '..' segment in AIGENTRY_CONTROLLER_PEERS → exit 78 PEER_CONFIG_INVALID", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083"],
      // Built by hand: path.join would normalise the '..' segment away.
      { AIGENTRY_CONTROLLER_PEERS: [s.f.root, "x", "..", "controller-peers.json"].join(sep) });
    assert.equal(r.status, 78, r.stderr);
    assert.ok(stderrLine(r.stderr, "dispatch.sh: PEER_CONFIG_INVALID: "), r.stderr);
    s.assertUntouched("dotdot");
  } finally { s.f.cleanup(); }
});

// ── D3 ────────────────────────────────────────────────────────────────────────
const REFUSED_FLAGS: string[][] = [
  ["--spawn-and-dispatch"], ["--retry-unknown", "reviewed"], ["--worktree", "/tmp/wt"], ["--verify-delivered"],
  ["--keep-alive"], ["--cli", "claude"], ["--role", "coder"], ["--task-class", "integration"],
  ["--observe", "obs.json"], ["--from", "orchestrator"],
];
for (const flag of REFUSED_FLAGS) {
  test(`D3 ${flag[0]} with a peer target → exit 4 PEER_FLAG_UNSUPPORTED before any write`, () => {
    const s = setup();
    try {
      const r = s.run(["--target", TARGET, "--task", "1083", ...flag]);
      assert.equal(r.status, 4, r.stderr);
      const line = stderrLine(r.stderr, "dispatch.sh: PEER_FLAG_UNSUPPORTED: ");
      assert.ok(line && line.includes(flag[0]!), r.stderr);
      s.assertUntouched(flag[0]!);
    } finally { s.f.cleanup(); }
  });
}

test("D3 --input-root/--input-manifest/--input-sha256 with a peer target → exit 4 before any write", () => {
  // The #1172 input check runs before the task gate and is unchanged; with an unverifiable snapshot
  // it already exits 4 (WORKER_INPUTS_UNVERIFIED). Either way nothing is written or sent.
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083", "--input-root", s.f.root,
      "--input-manifest", join(s.f.root, "none.json"), "--input-sha256", "0".repeat(64)]);
    assert.equal(r.status, 4, r.stderr);
    s.assertUntouched("input triple");
  } finally { s.f.cleanup(); }
});

test("D3 (Root Q2) a task id the envelope cannot carry → exit 4 PEER_FLAG_UNSUPPORTED before any write", () => {
  const s = setup();
  try {
    writeFileSync(s.f.queue, JSON.stringify({ tasks: [{ id: 1083, status: "pending", note: "seed" }, { id: "x y", status: "pending" }] }));
    const queue = readFileSync(s.f.queue, "utf8");
    const r = s.run(["--target", TARGET, "--task", "x y"]);
    assert.equal(r.status, 4, r.stderr);
    assert.ok(r.stderr.split("\n").includes(
      "dispatch.sh: PEER_FLAG_UNSUPPORTED: --task id not representable in the envelope; nothing sent"), r.stderr);
    assert.equal(readFileSync(s.f.queue, "utf8"), queue);
    assert.equal(existsSync(s.store), false);
    assert.deepEqual(s.calls(), []);
  } finally { s.f.cleanup(); }
});

// ── D4 ────────────────────────────────────────────────────────────────────────
const BAD_REFS: [string, string | Buffer, string][] = [
  ["placeholder", "Report to {{ORCHESTRATOR_REPORT_TARGET}} when done.\n", "PEER_REF_PLACEHOLDER"],
  ["body over 12288 bytes", "a".repeat(12289), "PEER_BODY_TOO_LARGE"],
  ["ref file over 262144 bytes", "b".repeat(262145), "PEER_BODY_TOO_LARGE"],
  ["forbidden glyph", "line one\nsee ⟦here⟧\n", "PEER_BODY_INVALID"],
  ["control character", "bell \u0007\n", "PEER_BODY_INVALID"],
  ["not UTF-8", Buffer.from([0x61, 0xff, 0x0a]), "PEER_BODY_INVALID"],
];
for (const [name, content, code] of BAD_REFS) {
  test(`D4 ${name} → exit 4 ${code}, nothing sent or stored`, () => {
    const s = setup();
    try {
      const ref = join(s.f.root, "peer-ref.md");
      writeFileSync(ref, content);
      const r = s.run(["--target", TARGET, "--task", "1083", "--ref", ref]);
      assert.equal(r.status, 4, r.stderr);
      assert.ok(stderrLine(r.stderr, `dispatch.sh: ${code}: `), r.stderr);
      s.assertUntouched(name);
    } finally { s.f.cleanup(); }
  });
}

test("D4 a body of exactly 12288 bytes is accepted", () => {
  const s = setup();
  try {
    const ref = join(s.f.root, "peer-ref.md");
    writeFileSync(ref, "c".repeat(12288));
    const r = s.run(["--target", TARGET, "--task", "1083", "--ref", ref]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(s.calls()[0]!.argv[8]!.includes(` body_bytes=12288\n`));
  } finally { s.f.cleanup(); }
});

// ── D5 ────────────────────────────────────────────────────────────────────────
test("D5 same task + same body with an open record → exit 8 naming the existing id; nothing sent", () => {
  const s = setup();
  try {
    const first = s.run(["--target", TARGET, "--task", "1083"]);
    assert.equal(first.status, 0, first.stderr);
    const id = s.idFrom(first.stdout);
    const before = readdirSync(join(s.store, "outbox")).sort();
    const again = s.run(["--target", TARGET, "--task", "1083"]);
    assert.equal(again.status, 8, again.stderr);
    const line = stderrLine(again.stderr, "dispatch.sh: PEER_REQUEST_DEDUPLICATED: ");
    assert.ok(line && line.includes(id), again.stderr);
    assert.equal(s.calls().length, 1, "nothing sent");
    assert.deepEqual(readdirSync(join(s.store, "outbox")).sort(), before, "no new record");
    // Not duplicates: another body, or the same body under another sender task (--no-task → "-").
    const other = join(s.f.root, "other-ref.md");
    writeFileSync(other, "A different request.\n");
    assert.equal(s.run(["--target", TARGET, "--task", "1083", "--ref", other]).status, 0);
    assert.equal(s.run(["--target", TARGET, "--no-task", "exempt probe"]).status, 0);
    assert.equal(s.calls().length, 3);
  } finally { s.f.cleanup(); }
});

test("D5 a terminal record does not de-duplicate", () => {
  const s = setup();
  try {
    const first = s.run(["--target", TARGET, "--task", "1083"]);
    assert.equal(first.status, 0, first.stderr);
    const id = s.idFrom(first.stdout);
    const file = join(s.store, "outbox", `${id}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.state = "closed";
    writeFileSync(file, JSON.stringify(rec));
    const again = s.run(["--target", TARGET, "--task", "1083"]);
    assert.equal(again.status, 0, again.stderr);
    assert.notEqual(s.idFrom(again.stdout), id);
  } finally { s.f.cleanup(); }
});

// ── D6 ────────────────────────────────────────────────────────────────────────
test("D6 task gate unchanged and first: unknown task → exit 4, nothing written", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "9999"]);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /Rule 34 task-gate: unknown task id '9999'/);
    s.assertUntouched("unknown task");
    // The gate also runs before the peer-list check: an unlisted target still gets the gate's answer.
    const g = s.run(["--target", "orchestrator@unlisted", "--task", "9999"]);
    assert.equal(g.status, 4, g.stderr);
    assert.match(g.stderr, /Rule 34 task-gate/);
  } finally { s.f.cleanup(); }
});

test("D6 --no-task \"<r>\" works and records sender_task=-", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--no-task", "cross-machine smoke"]);
    assert.equal(r.status, 0, r.stderr);
    const id = s.idFrom(r.stdout);
    assert.equal(s.record(id).sender_task, "-");
    assert.ok(s.calls()[0]!.argv[8]!.includes(" sender_task=- receiver_task=- "));
    assert.equal(readFileSync(s.f.queue, "utf8"), s.seeded.queue, "no ledger write without --task");
    // The unchanged gate still audits the exemption, naming the caller from the seam (no `ps`).
    const dir = join(s.f.env.HOME!, ".aigentry", "telemetry");
    const audit = readdirSync(dir).filter((n) => n.startsWith("dispatch-notask-"))
      .flatMap((n) => readFileSync(join(dir, n), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>));
    assert.deepEqual(audit.map((a) => [a.reason, a.caller_env, a.sid_or_target]), [["cross-machine smoke", CALLER, TARGET]]);
  } finally { s.f.cleanup(); }
});

// ── D7 ────────────────────────────────────────────────────────────────────────
test("D7 classifier unknown → exit 7 PEER_DELIVERY_UNKNOWN, record send_unknown, no ledger", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083"], { PEER_MODE: "unknown" });
    assert.equal(r.status, 7, r.stderr);
    const line = stderrLine(r.stderr, "dispatch.sh: PEER_DELIVERY_UNKNOWN: ");
    assert.ok(line && line.endsWith("the pump reconciles this automatically; do not re-run dispatch"), r.stderr);
    assert.equal(r.stdout, "");
    const rec = s.record(s.idFrom(line));
    assert.equal(rec.state, "send_unknown");
    assert.equal(rec.next_action.code, "PROBE");
    assert.equal(rec.messages["REQUEST-1"].sends[0].result, "unknown");
    assert.equal(readFileSync(s.f.queue, "utf8"), s.seeded.queue);
    assert.equal(s.calls().length, 1);
  } finally { s.f.cleanup(); }
});

test("D7 classifier refused_definite → exit 11 PEER_NOT_DELIVERED, record send_refused, no ledger", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083"], { PEER_MODE: "refused" });
    assert.equal(r.status, 11, r.stderr);
    const line = stderrLine(r.stderr, "dispatch.sh: PEER_NOT_DELIVERED: ");
    assert.ok(line && line.includes("SESSION_NOT_FOUND")
      && line.endsWith("the pump reconciles this automatically; do not re-run dispatch"), r.stderr);
    const rec = s.record(s.idFrom(line));
    assert.equal(rec.state, "send_refused");
    assert.equal(rec.next_action.code, "RESEND");
    assert.equal(rec.messages["REQUEST-1"].sends[0].detail, "SESSION_NOT_FOUND");
    assert.equal(readFileSync(s.f.queue, "utf8"), s.seeded.queue);
  } finally { s.f.cleanup(); }
});

for (const [name, storeDir] of [["store root under a file", "file"], ["relative store root", "relative"]] as const) {
  test(`D7 store failure before the send (${name}) → exit 9 PEER_NOT_RECORDED, telepty never called`, () => {
    const s = setup();
    try {
      const dir = storeDir === "file" ? join(s.f.ref, "store") : join("rel", "store");
      const r = s.run(["--target", TARGET, "--task", "1083"], { AIGENTRY_CONTROLLER_LINK_DIR: dir });
      assert.equal(r.status, 9, r.stderr);
      assert.ok(stderrLine(r.stderr, "dispatch.sh: PEER_NOT_RECORDED: "), r.stderr);
      assert.deepEqual(s.calls(), []);
      assert.equal(readFileSync(s.f.queue, "utf8"), s.seeded.queue);
      assert.equal(existsSync(join(s.f.root, "rel")), false);
    } finally { s.f.cleanup(); }
  });
}

test("D7 (Root Q3) result cannot be recorded after the send → exit 7 'result not recorded', no ledger", () => {
  const s = setup();
  try {
    const r = s.run(["--target", TARGET, "--task", "1083"], { PEER_MODE: "corrupt" });
    assert.equal(r.status, 7, r.stderr);
    const line = stderrLine(r.stderr, "dispatch.sh: PEER_DELIVERY_UNKNOWN: ");
    assert.ok(line && line.includes("result not recorded"), r.stderr);
    assert.equal(s.calls().length, 1);
    assert.equal(r.stdout, "");
    assert.equal(readFileSync(s.f.queue, "utf8"), s.seeded.queue, "no task-ledger update");
  } finally { s.f.cleanup(); }
});

// ── D8 ────────────────────────────────────────────────────────────────────────
test("D8 a target without '@' never consults the peer list or the store", () => {
  const s = setup();
  try {
    // A peer list that would refuse everything, and a store root, are both in the environment: the
    // old path must answer exactly as without them, and create nothing.
    const bogus = join(s.f.root, "peers-is-a-dir");
    mkdirSync(bogus);
    const peerEnv = { AIGENTRY_CONTROLLER_PEERS: bogus, AIGENTRY_CONTROLLER_LINK_DIR: s.store };
    const without = { AIGENTRY_CONTROLLER_PEERS: "", AIGENTRY_CONTROLLER_LINK_DIR: "" };
    const a = s.run(["--target", "../evil", "--task", "1083"], peerEnv);
    const b = s.run(["--target", "../evil", "--task", "1083"], without);
    assert.equal(a.status, 78);
    assert.deepEqual([a.status, a.stdout, a.stderr], [b.status, b.stdout, b.stderr]);
    assert.ok(a.stderr.split("\n").includes(
      "dispatch.sh: SANDBOX_TARGET_UNVERIFIED: Error: SANDBOX_TARGET_SID; preserve artifacts and respawn"), a.stderr);
    assert.equal(existsSync(s.store), false);
    // The confined-worker success path is unchanged with the same environment.
    s.f.prepareTarget();
    const ok = s.f.dispatch(["--target", "router-fixture"], peerEnv);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.split("\n").includes("OK dispatched to router-fixture"), ok.stdout);
    assert.equal(existsSync(s.store), false);
    assert.deepEqual(s.calls(), [], "the peer runner is never used for a worker");
  } finally { s.f.cleanup(); }
});
