// task1270 — caller-side RED for bound busy delivery (`telepty inject-bound-v1`).
//
// WHY THIS FILE IS RED ON PURPOSE. src/dispatch/cli.ts main() waits for an idle,
// empty-composer REPL before every non-dedup delivery (cli.ts:1434-1439 →
// waitForReady → isReady → bin/session-probe.py), and a qualified current-busy
// session can never satisfy that (session-probe.py:472-494: `working` →
// `current-busy-or-modal`, a populated composer → `no-empty-current-prompt`). So a
// follow-up instruction to a busy worker times out (exit 1) before anything is
// recorded, staged or transported. The daemon side is gaining the bound verb
//   telepty inject-bound-v1 --from F --expected-epoch E
//                           --expected-owner-generation G -- SID PROMPT
// (frozen interface "bound-inject-v1 v1"); the caller must learn to use it for a
// qualified busy --target. This file is the independent actual RED for that
// caller change. It contains NO production code and changes none: it measures
// the compiled product CLI as a subprocess and fails on the missing bound
// behaviour, not on a missing import, fixture or harness step.
//
// WHAT STAYS REAL: the compiled dispatch CLI (dist/src/dispatch/cli.js) makes
// every decision; the real bin/dispatch-registry.py is the only registry writer
// (reached through a logging passthrough that adds ordering, not behaviour); the
// real assertConfinedTarget()/stageWorkerRef() stage the ref; the real
// bin/dispatch-verify.sh runs in the one case that measures the shared
// verify/resubmit policy.
//
// WHAT IS FAKED, and why — process boundaries only, never a product decision:
//   telepty            the local daemon CLI. Serves ONE current local snapshot
//                      (id/host/epoch/owner_generation/busy_input), answers the
//                      bound verb per `mode`, records every invocation, and
//                      REFUSES (exit 97) any verb this contract does not allow.
//                      No PTY, session, bridge, socket or network exists.
//   session-probe.py   the readiness verdict. Every scenario here is a NOT-ready
//                      session, so the probe never reports ready=true; the real
//                      probe's own busy classification is covered by
//                      current-readiness-footer.test.ts and is not re-asserted.
//   policy.py          verify_started mapping (unstaged for this unit); the stub
//                      returns the not-moving verdict that the shared
//                      verify/resubmit path keys on.
// Nothing is injected, submitted, forced, replayed or Enter-resent anywhere; the
// absence of exactly those effects is what several cases assert.
//
// The epoch/owner_generation/busy_input values travel as opaque sentinels, so the
// assertions never depend on WHICH read verb the caller uses for the snapshot —
// only that the values it binds are the ones the daemon published.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fixture, REPO } from "./model-router-fixtures.js";

type F = ReturnType<typeof fixture>;

const CLI_JS = join(REPO, "dist/src/dispatch/cli.js");
const REAL_REGISTRY = join(REPO, "bin/dispatch-registry.py");
const SID = "router-fixture";
const TASK = "1083";
const FROM = "E-telepty1270-orchestrator";
// Opaque bounded tokens, exactly as the contract types them (the generation is a STRING).
const EPOCH = "EPOCH-9f2c1a7b";
const OWNGEN = "OWNGEN-4b71e0d3";
const INJECT_ID = "bij-7c1d9f2e4a6b8c0d";
// The dispatch under test: a same-task follow-up to a busy worker, 800ms budget.
const BUSY_TIMEOUT = "800";
const READY_TIMEOUT_LINE = /dispatch\.sh: timeout \(\d+ms\) waiting for .* REPL ready/;
const BASE_VERBS = ["inject", "send-key", "list", "read-screen", "session"];
const BUSY_SCREEN = "✻ Brewing… (esc to interrupt)\n\n❯ \n";

// ── stubs ───────────────────────────────────────────────────────────────────
interface StubConfig {
  sid: string;
  command: string;
  epoch: string;
  ownerGeneration: string;
  /** The corrected candidate bridge's declaration, bound to the current owner generation. */
  busyInput: "supported" | "unsupported_by_bridge" | "not_applicable";
  /** The sealed boot-capabilities verbs array. */
  verbs: string[];
  injectId: string;
  mode: "accepted" | "old-cli-help" | "malformed" | "lost";
}

const TELEPTY_STUB = `
const fs = require('node:fs');
const argv = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(process.env.BOUND_STUB_CONFIG, 'utf8'));
fs.appendFileSync(process.env.BOUND_ORDER_LOG, JSON.stringify({ who: 'telepty', argv }) + '\\n');
// ONE current local snapshot. Served identically from every read verb a caller
// could legitimately use, so the test binds values, not a verb spelling.
const view = {
  id: cfg.sid, host: '127.0.0.1', backend: 'cmux', command: cfg.command,
  healthStatus: 'CONNECTED', ready: true, ownerPid: process.pid, ptyPid: process.pid,
  createdAt: '2026-11-16T00:00:00Z', lastConnectedAt: '2026-11-16T00:00:01Z',
  transport: {
    health_status: 'CONNECTED', ready: true, bootstrap: { ready: true },
    session_epoch: cfg.epoch, owner_generation: cfg.ownerGeneration, busy_input: cfg.busyInput,
  },
};
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(0); };
if (argv[0] === 'list') out([view]);
if (argv[0] === 'view' || argv[0] === 'show' || argv[0] === 'info') out(view);
if (argv[0] === 'session' && argv[1] === 'info') out(view);
if (argv[0] === 'boot-capabilities' || argv[0] === 'capabilities') out({ verbs: cfg.verbs });
if (argv[0] === 'read-screen') { process.stdout.write(${JSON.stringify(BUSY_SCREEN)}); process.exit(0); }
if (argv[0] === 'inject-bound-v1') {
  // An old daemon does not know the verb: it prints help and exits 0. That is NOT support.
  if (cfg.mode === 'old-cli-help') {
    process.stdout.write('telepty — session multiplexer\\nUsage: telepty <command> [options]\\n  inject, send-key, list, read-screen, session\\n');
    process.exit(0);
  }
  if (cfg.mode === 'lost') process.exit(1);                                   // response lost: nothing printed
  if (cfg.mode === 'malformed') { process.stdout.write('{"schema":"telepty.bound-inject-result/v1",'); process.exit(0); }
  out({
    schema: 'telepty.bound-inject-result/v1', stage: 'accepted', reason: null,
    session_id: cfg.sid, session_epoch: cfg.epoch, owner_generation: cfg.ownerGeneration,
    inject_id: cfg.injectId, body_stage: 'sent_to_bridge', submit_stage: 'sent_to_bridge',
    bytes_written: null, consumption: 'unknown',
  });
}
process.stderr.write('telepty stub: refusing verb ' + JSON.stringify(argv.slice(0, 2)) + '\\n');
process.exit(97);
`;

// Not-ready verdicts only. PROBE_SURFACE selects the state; PROBE_MODE selects
// how the verdict itself fails (a probe that answers nothing / a probe_error).
const PROBE_STUB = `
if (process.env.PROBE_MODE === 'empty') process.exit(1);
const surface = process.env.PROBE_SURFACE || 'working';
const detail = {
  health: 'CONNECTED', transport_ready: true, bootstrap_ready: true,
  ready_reason: process.env.PROBE_READY_REASON || 'current-busy-or-modal',
  screen_source: 'cmux:current-viewport', surface_detail: surface,
  tracker_class: surface === 'working' ? 'active' : 'unknown', verify_started: false,
  verify_problems: ['no working spinner (idle/static) [not-moving]'],
};
if (process.env.PROBE_MODE === 'probe-error') {
  detail.probe_error = 'current-screen adapter unsupported';
  detail.screen_source = 'unavailable';
  detail.ready_reason = 'current-surface-not-ready';
}
process.stdout.write(JSON.stringify({
  alive: process.env.PROBE_MODE !== 'probe-error', ready: false, surface,
  activity: surface === 'working' ? 'moving' : 'static', cli: 'claude', detail,
}) + '\\n');
`;

const POLICY_STUB = `
process.stdout.write(JSON.stringify({ action: 'RESUBMIT', status: 'not_started',
  reason: 'no working spinner (idle/static) [not-moving]' }) + '\\n');
`;

// A passthrough in front of the REAL registry: it appends the argv to the shared
// ordering log and then runs bin/dispatch-registry.py with the same argv, env,
// stdio and exit code. It decides nothing. Python (not node) so the same file
// works through registryInvocation() on POSIX (shebang) and win32 (`python <script>`).
const REGISTRY_PASSTHROUGH = `#!/usr/bin/env python3
import json, os, subprocess, sys

argv = sys.argv[1:]
with open(os.environ["BOUND_ORDER_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps({"who": "registry", "argv": argv}) + "\\n")
sys.exit(subprocess.run([sys.executable, os.environ["BOUND_REAL_REGISTRY"], *argv]).returncode)
`;

const orderLogPath = (f: F): string => join(f.root, "order.log");

/** Install the stubs and return the env overrides for one dispatch run. */
function arm(f: F, cfg: Partial<StubConfig> = {}, probe: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const full: StubConfig = {
    sid: cfg.sid ?? SID,
    command: cfg.command ?? "claude",
    epoch: cfg.epoch ?? EPOCH,
    ownerGeneration: cfg.ownerGeneration ?? OWNGEN,
    busyInput: cfg.busyInput ?? "supported",
    verbs: cfg.verbs ?? [...BASE_VERBS, "inject-bound-v1"],
    injectId: cfg.injectId ?? INJECT_ID,
    mode: cfg.mode ?? "accepted",
  };
  const configFile = join(f.root, "telepty-stub.json");
  writeFileSync(configFile, JSON.stringify(full));
  writeFileSync(orderLogPath(f), "");
  const passthrough = join(f.bin, "registry-passthrough.py");
  writeFileSync(passthrough, REGISTRY_PASSTHROUGH, { mode: 0o755 });
  return {
    TELEPTY: f.script("telepty-bound-stub", TELEPTY_STUB),
    SESSION_PROBE_PY: f.script("probe-busy-stub", PROBE_STUB),
    POLICY_PY: f.script("policy-stub", POLICY_STUB),
    DISPATCH_REGISTRY_PY: passthrough,
    BOUND_STUB_CONFIG: configFile,
    BOUND_ORDER_LOG: orderLogPath(f),
    BOUND_REAL_REGISTRY: REAL_REGISTRY,
    ...probe,
  };
}

/**
 * One dispatch run. Mirrors the fixture's own `dispatch()` argv (the fixture
 * hard-codes `--no-verify-started` and `--timeout-ms 500`, and this unit needs
 * both sides of the first and 800ms of the second), so the shared fixture file
 * is left byte-for-byte alone.
 */
function run(f: F, args: string[], overrides: NodeJS.ProcessEnv,
  opts: { verifyStarted?: boolean } = {}): SpawnSyncReturns<string> {
  const argv = [CLI_JS, "--ref", f.ref, "--task", TASK, "--timeout-ms", BUSY_TIMEOUT];
  if (!opts.verifyStarted) argv.push("--no-verify-started");
  return spawnSync(process.execPath, [...argv, ...args],
    { cwd: f.root, env: { ...f.env, ...overrides }, encoding: "utf8",
      timeout: opts.verifyStarted ? 90000 : 25000 });
}

/** The busy same-task follow-up this unit is about. */
const follow = (f: F, overrides: NodeJS.ProcessEnv, opts: { verifyStarted?: boolean } = {}) =>
  run(f, ["--target", SID, "--from", FROM], overrides, opts);

// ── observation helpers ─────────────────────────────────────────────────────
interface Entry { who: "telepty" | "registry"; argv: string[] }
interface Row {
  dispatch_id: string;
  lifecycle: { state: string };
  transport: { result: string; inject_id: string | null };
  observations: Array<Record<string, unknown>>;
}

function entries(f: F): Entry[] {
  const file = orderLogPath(f);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Entry);
}
const telepty = (es: Entry[]) => es.filter((e) => e.who === "telepty");
const boundSends = (es: Entry[]) => telepty(es).filter((e) => e.argv[0] === "inject-bound-v1");
const legacyInjects = (es: Entry[]) => telepty(es).filter((e) => e.argv[0] === "inject");
/** Any raw key/Enter/force write — the whole family, not just the one spelling. */
const keyWrites = (es: Entry[]) => telepty(es).filter((e) =>
  ["send-key", "send-keys", "send-text", "write", "paste", "submit"].includes(e.argv[0]) ||
  e.argv.includes("--submit-force") || e.argv.includes("--force"));
const beginDeliveries = (es: Entry[]) => es.filter((e) => e.who === "registry" && e.argv[0] === "begin-delivery");
/** A local snapshot/capability read: any read verb a caller could legitimately use. */
const snapshotReads = (es: Entry[]) => telepty(es).filter((e) =>
  ["list", "view", "show", "info", "session", "boot-capabilities", "capabilities"].includes(e.argv[0]));

const rows = (f: F): Row[] =>
  (JSON.parse(readFileSync(join(f.root, "state/active.json"), "utf8")) as { dispatches: Row[] }).dispatches;

/** stageWorkerRef()'s own address: sha256 of the ref body inside the recipient's sealed HOME. */
function stagedRef(f: F): string {
  const body = readFileSync(f.ref, "utf8");
  return join(f.env.AIGENTRY_SESSIONS_ROOT!, SID, "fixture-home", ".telepty", "shared",
    `${createHash("sha256").update(body).digest("hex")}.md`);
}
/** The frozen exact argv, including the `--` barrier and the exact sid. */
const expectedBoundArgv = (f: F): string[] => ["inject-bound-v1", "--from", FROM,
  "--expected-epoch", EPOCH, "--expected-owner-generation", OWNGEN, "--", SID,
  `[context-ref] Read ${stagedRef(f)} and use it as the source of truth for this task.`];

/** No input of any kind reached the session, by any path. */
function assertNoInputEffect(f: F, note: string): void {
  const es = entries(f);
  assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], `${note}: a legacy inject was attempted`);
  assert.deepEqual(keyWrites(es).map((e) => e.argv), [], `${note}: a raw key/force write was attempted`);
  assert.deepEqual(beginDeliveries(es).map((e) => e.argv), [], `${note}: begin-delivery ran`);
  assert.deepEqual(rows(f), [], `${note}: a delivery record was committed`);
}

/**
 * Sensitivity control, in its own fixture: a qualified current-busy --target MUST
 * take the bound path exactly once. Without it, every fail-closed assertion in
 * this file would also hold for a caller that delivers nothing at all — which is
 * precisely today's behaviour.
 */
function assertBoundPathStillTaken(note: string): void {
  const f = fixture();
  try {
    f.prepareTarget();
    const overrides = arm(f);
    const r = follow(f, overrides);
    const es = entries(f);
    assert.equal(boundSends(es).length, 1,
      `${note}: control — a qualified busy --target must still take the bound path exactly once ` +
      `(status=${r.status})\n${r.stderr}`);
    assert.deepEqual(boundSends(es)[0]!.argv, expectedBoundArgv(f), `${note}: control — exact bound argv`);
  } finally { f.cleanup(); }
}

// ── (a) one bound send for a busy --target ──────────────────────────────────
describe("1270(a) a busy --target delivers exactly one bound send", () => {
  test("the exact frozen inject-bound-v1 argv is sent once, and no legacy inject or key write is", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = arm(f);
      const r = follow(f, overrides);
      const es = entries(f);
      // The regression itself: the busy follow-up must no longer die on the readiness wait.
      assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE,
        "a qualified busy --target must not be refused by the idle-prompt readiness wait");
      assert.equal(boundSends(es).length, 1, `exactly one bound send\n${r.stderr}`);
      assert.deepEqual(boundSends(es)[0]!.argv, expectedBoundArgv(f),
        "strict exact argv: --from / --expected-epoch / --expected-owner-generation / -- / exact sid / prompt");
      assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], "zero legacy inject");
      assert.deepEqual(keyWrites(es).map((e) => e.argv), [], "zero send-key / force write");
      // The staged ref the prompt addresses really is the ref, inside the sealed HOME.
      const staged = stagedRef(f);
      assert.ok(isAbsolute(staged) && existsSync(staged), `the ref must be staged at ${staged}`);
      assert.equal(readFileSync(staged, "utf8"), readFileSync(f.ref, "utf8"));
      // One accepted hand-off, recorded and not re-sent.
      assert.equal(r.status, 0, `accepted bound delivery exits 0 (see SEAMS.md: exit-code decision)\n${r.stderr}`);
    } finally { f.cleanup(); }
  });
});

// ── (b) precheck → beginDelivery → one bound send ───────────────────────────
describe("1270(b) capability precheck precedes beginDelivery, which precedes the send", () => {
  test("the snapshot read comes first, begin-delivery second, the single bound send last", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = arm(f);
      const r = follow(f, overrides);
      const es = entries(f);
      const firstSnapshot = es.findIndex((e) => snapshotReads([e]).length === 1);
      const firstBegin = es.findIndex((e) => beginDeliveries([e]).length === 1);
      const send = es.findIndex((e) => e.argv[0] === "inject-bound-v1");
      assert.ok(firstSnapshot >= 0, `a current local snapshot must be read\n${r.stderr}`);
      assert.ok(firstBegin >= 0, `begin-delivery must authorize the delivery\n${r.stderr}`);
      assert.ok(send >= 0, `the bound send must happen\n${r.stderr}`);
      assert.ok(firstSnapshot < firstBegin, "the snapshot/capability read must precede begin-delivery");
      assert.ok(firstBegin < send, "begin-delivery must precede the one bound send");
      assert.equal(boundSends(es).length, 1, "one send, not a retry pair");
      // The pinned identity the send carries is the one the snapshot published.
      const argv = boundSends(es)[0]!.argv;
      assert.equal(argv[argv.indexOf("--expected-epoch") + 1], EPOCH);
      assert.equal(argv[argv.indexOf("--expected-owner-generation") + 1], OWNGEN);
    } finally { f.cleanup(); }
  });
});

// ── (c) old CLI / unsupported capability is refused before beginDelivery ────
describe("1270(c) an unsupported bound verb or capability is refused before beginDelivery", () => {
  test("an old daemon whose unknown verb prints help and exits 0 is NOT support", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The old-daemon shape on purpose: the bridge still declares busy_input, but the
      // local CLI does not know the verb and its capabilities array does not advertise
      // it. So the refusal may only come from the verbs array or from the help/exit0
      // reply — never from an assumed `busy_input: "supported"`.
      const overrides = arm(f, { mode: "old-cli-help", verbs: BASE_VERBS });
      const r = follow(f, overrides);
      const es = entries(f);
      assertNoInputEffect(f, "old-cli help/exit0");
      assert.ok(boundSends(es).length <= 1, "an unsupported verb is probed at most once, never retried");
      assert.notEqual(r.status, 0, "help/exit0 must never read as a delivered follow-up");
      assert.doesNotMatch(r.stdout, /OK dispatched/, "nothing was dispatched");
      assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE,
        "the refusal must name the unsupported bound capability, not a readiness timeout");
      assert.match(r.stderr, /inject-bound-v1|busy-input-v1/,
        "the refusal must name the verb/capability it found unsupported");
    } finally { f.cleanup(); }
  });

  test("a bridge that does not declare busy-input-v1 is refused with nothing sent at all", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = arm(f, { busyInput: "unsupported_by_bridge" });
      const r = follow(f, overrides);
      const es = entries(f);
      assertNoInputEffect(f, "busy capability unsupported");
      assert.deepEqual(boundSends(es).map((e) => e.argv), [],
        "an undeclared busy capability must be refused BEFORE any bound send");
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE,
        "the refusal must name the missing capability, not a readiness timeout");
      assert.match(r.stderr, /inject-bound-v1|busy-input-v1|busy_input/,
        "the refusal must name the missing busy capability");
    } finally { f.cleanup(); }
  });
});

// ── (d) every other not-ready state stays fail-closed ───────────────────────
describe("1270(d) fresh-spawn, modal, unsubmitted, unknown and probe-error stay fail-closed", () => {
  const states: Array<[string, NodeJS.ProcessEnv]> = [
    ["modal", { PROBE_SURFACE: "modal", PROBE_READY_REASON: "current-surface-not-ready" }],
    ["unsubmitted", { PROBE_SURFACE: "unsubmitted", PROBE_READY_REASON: "no-empty-current-prompt" }],
    ["welcome", { PROBE_SURFACE: "welcome", PROBE_READY_REASON: "no-empty-current-prompt" }],
    ["unknown", { PROBE_SURFACE: "unknown", PROBE_READY_REASON: "current-surface-not-ready" }],
    ["probe_error", { PROBE_SURFACE: "unknown", PROBE_MODE: "probe-error" }],
    ["no-probe-verdict", { PROBE_MODE: "empty" }],
  ];

  for (const [state, probe] of states) {
    test(`${state}: no bound path, no input, no record — and busy still works`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = arm(f, {}, probe);
        const r = follow(f, overrides);
        assert.deepEqual(boundSends(entries(f)).map((e) => e.argv), [],
          `${state} must never take the bound busy path`);
        assertNoInputEffect(f, state);
        assert.notEqual(r.status, 0, `${state} must not report a delivery\n${r.stderr}`);
      } finally { f.cleanup(); }
      assertBoundPathStillTaken(state);
    });
  }

  test("a fresh --spawn-and-dispatch worker is never admitted busy — only a nonspawned --target is", () => {
    const f = fixture();
    try {
      const overrides = arm(f, {}, { PROBE_SURFACE: "welcome", PROBE_READY_REASON: "no-empty-current-prompt" });
      const r = f.dispatch([...f.spawnArgs, "--role", "coder", "--timeout-ms", BUSY_TIMEOUT, "--from", FROM], overrides);
      const es = entries(f);
      assert.deepEqual(boundSends(es).map((e) => e.argv), [], "a fresh spawn must wait for its REPL, never bind-inject");
      assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], "no legacy inject either");
      assert.deepEqual(keyWrites(es).map((e) => e.argv), [], "no key write");
      assert.deepEqual(rows(f), [], "no record for a worker that never became ready");
      assert.notEqual(r.status, 0,
        `a fresh spawn that never became ready must not report a delivery\n${r.stderr}`);
    } finally { f.cleanup(); }
    assertBoundPathStillTaken("fresh-spawn");
  });
});

// ── (e) the public readiness surface is unchanged ───────────────────────────
describe("1270(e) isReady()/__probe semantics are unchanged: ready stays false for busy", () => {
  test("__probe is-ready reports NOT ready (exit 1, no stdout) while the same session is bound-delivered", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = arm(f);
      // The public boolean seam, byte-for-byte: a nonzero exit and no stdout contract.
      const probe = spawnSync(process.execPath, [CLI_JS, "__probe", "is-ready", SID, "claude"],
        { cwd: f.root, env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 25000 });
      assert.equal(probe.status, 1, `a qualified current-busy session is NOT ready\n${probe.stderr}`);
      assert.equal(probe.stdout, "", "__probe is-ready answers through its exit code only");
      // …and the delivery happens anyway, which is the whole point of the bound path.
      const r = follow(f, overrides);
      const es = entries(f);
      assert.equal(boundSends(es).length, 1,
        `ready=false must no longer mean "no delivery" for a qualified busy target\n${r.stderr}`);
      // Readiness did not quietly become true to make that possible.
      const after = spawnSync(process.execPath, [CLI_JS, "__probe", "is-ready", SID, "claude"],
        { cwd: f.root, env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 25000 });
      assert.equal(after.status, 1, "ready stays false for the qualified current-busy session");
    } finally { f.cleanup(); }
  });
});

// ── (f) accepted is recorded as unknown + a structured observation ──────────
describe("1270(f) an accepted bound result is transport `unknown` plus a structured observation", () => {
  test("never write_observed, never a fresh VERIFIED for a queued body", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = arm(f);
      const r = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, `the bound send must happen\n${r.stderr}`);
      const committed = rows(f);
      assert.equal(committed.length, 1, `exactly one record\n${r.stderr}`);
      const row = committed[0]!;
      // `accepted` means two frames were handed to the pinned owner — not PTY or model success.
      assert.equal(row.transport.result, "unknown", "an accepted hand-off is not an observed write");
      assert.equal(row.lifecycle.state, "delivery_state_unknown", "the unknown hold is what prevents replay");
      const serialized = JSON.stringify(row);
      assert.ok(!serialized.includes("write_observed"),
        `write_observed must not be manufactured for a queued body:\n${serialized}`);
      // The bounded structured observation: schema + binding + inject_id + stages.
      const bound = row.observations.filter((o) => JSON.stringify(o).includes("telepty.bound-inject-result/v1"));
      assert.equal(bound.length, 1, `exactly one bound-result observation:\n${serialized}`);
      const flat = JSON.stringify(bound[0]);
      for (const needle of [EPOCH, OWNGEN, INJECT_ID, "sent_to_bridge", "accepted"]) {
        assert.ok(flat.includes(needle), `the observation must carry ${needle}:\n${flat}`);
      }
      assert.ok(!flat.includes("write_observed"), "the observation must not relabel acceptance as a write");
      if (row.transport.inject_id !== null) assert.equal(row.transport.inject_id, INJECT_ID);
      // A queued body is not a started worker.
      assert.doesNotMatch(r.stdout, /VERIFIED/, "no fresh VERIFIED may be printed for a queued body");
    } finally { f.cleanup(); }
  });
});

// ── (g) busy verification is observe-only ───────────────────────────────────
describe("1270(g) busy verification is observe-only: no bare Enter, no marker-triggered resubmit", () => {
  test("the shared verify/resubmit path sends no key for a busy-admitted delivery", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = arm(f);
      // --verify-started is ON (the product default) and the probe reports the
      // `[not-moving]` marker the shared resubmit path keys on.
      const r = follow(f, overrides, { verifyStarted: true });
      const es = entries(f);
      assert.equal(boundSends(es).length, 1, `the bound send must happen\n${r.stderr}`);
      assert.deepEqual(keyWrites(es).map((e) => e.argv), [],
        "a busy-admitted delivery must never be followed by a bare Enter / marker-triggered resubmit");
      assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], "and never by a second legacy inject");
      assert.doesNotMatch(r.stdout, /VERIFIED/, "a queued body is never verified-started");
      assert.doesNotMatch(r.stderr, /VERIFIED/);
    } finally { f.cleanup(); }
  });
});

// ── (h) a lost or malformed bound response is held unknown, never replayed ──
describe("1270(h) a lost or malformed bound response is held as unknown with no replay", () => {
  for (const mode of ["lost", "malformed"] as const) {
    test(`${mode}: one send, transport unknown, and the repeat is held instead of re-sent`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = arm(f, { mode });
        const r = follow(f, overrides);
        const es = entries(f);
        assert.equal(boundSends(es).length, 1, `exactly one send, never a replay\n${r.stderr}`);
        assert.deepEqual(keyWrites(es).map((e) => e.argv), [], "no alternate input path");
        assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE, "the run must reach the bound send");
        assert.notEqual(r.status, 0, `an unknown result must not report success\n${r.stderr}`);
        const committed = rows(f);
        assert.equal(committed.length, 1, `the attempt is durably recorded\n${r.stderr}`);
        assert.equal(committed[0]!.transport.result, "unknown", "lost/malformed is unknown, never a claim");
        assert.ok(!JSON.stringify(committed[0]).includes("write_observed"));
        // The hold, not a retry: the same ref again is refused without a second send.
        const again = follow(f, overrides);
        assert.equal(boundSends(entries(f)).length, 1, `the stranded identity must not be re-sent\n${again.stderr}`);
        assert.equal(again.status, 7, `the repeat is held for review\n${again.stderr}`);
        assert.equal(rows(f).length, 1, "and no second record is created");
      } finally { f.cleanup(); }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// r1 ADDITIONS (Root review round 1). Everything ABOVE this line is the sealed RED
// file, byte-for-byte (sha256 bb6bca83…e42e): no existing case, assertion, stub,
// helper or constant is modified, and the original stubs keep serving the original
// cases. What is added below:
//   M5 — a telepty stub that emits the daemon CLI's REAL output envelope and its
//        real exit codes, so the branch production always takes is the branch under
//        test. Case (a) above remains the one deliberate bare-closed-object case,
//        kept as the documented tolerance it is.
//   M4 — the proven-unsent branch (the one that re-authorizes a re-dispatch), for
//        two real refusal reasons and both locally-refused shapes, plus the
//        complement: a `refused` whose effect is ambiguous must NOT be read as unsent.
//   M6 — both new bin/dispatch-verify.sh guards, driven with the REAL policy action
//        spelling, in both directions.
//   M2 — a response whose identity is not the pinned one.
//   M3 — a legitimate opaque token outside the old narrow charset.
// Every shape below is pinned to the line of the daemon candidate that produces it.
// ═══════════════════════════════════════════════════════════════════════════════

const RESULT_SCHEMA = "telepty.bound-inject-result/v1";
const VERIFY_SH = join(REPO, "bin/dispatch-verify.sh");
/** Opaque tokens the OLD caller-side charset `[A-Za-z0-9._:-]` would have refused (r1 M3). */
const WIDE_EPOCH = "ep0ch+9f2c/1a7b==";
const WIDE_OWNGEN = "owner gen 4b71·e0d3";

/**
 * The daemon's closed result object. ONE builder produces it for every stage, with the
 * same 11 keys (telepty1270-bound3 `changes/src/protocol/bound-inject.js:108-131`
 * `boundResult`): `bytes_written` is 0 or null and never a positive count (:126), and
 * `consumption` is the constant `'unknown'` (:129). The identity defaults echo the pin
 * because the route answers with the DAEMON's own current identity on every stage
 * (`changes/src/routes/session-actions.js:1890-1899`), which on an acceptance is
 * necessarily the pinned one (the epoch/generation mismatches refuse first, :1939-1940).
 */
interface Closed {
  schema: string; stage: string; reason: string | null; session_id: string;
  session_epoch: string | null; owner_generation: string | null; inject_id: string | null;
  body_stage: string; submit_stage: string; bytes_written: number | null; consumption: string;
}
const closed = (over: Partial<Closed> = {}): Closed => ({
  schema: RESULT_SCHEMA, stage: "accepted", reason: null,
  session_id: SID, session_epoch: EPOCH, owner_generation: OWNGEN, inject_id: INJECT_ID,
  body_stage: "sent_to_bridge", submit_stage: "sent_to_bridge", bytes_written: null,
  consumption: "unknown", ...over,
});

/** One stdout line plus the exit code, i.e. exactly what the verb gives its caller. */
interface R1Answer { stdout: string; exit: number }
/** `line({transport, reason, http_status, result})` — inject-bound-v1.js:81,120. */
const envelope = (transport: string, reason: string | null, httpStatus: number,
  result: Closed | null, exit: number): R1Answer =>
  ({ stdout: JSON.stringify({ transport, reason, http_status: httpStatus, result }) + "\n", exit });

// The five answers the shipped verb can give, each at its measured source line. EXIT is
// {accepted:0, refused:1, usage:2, unknown:3} (inject-bound-v1.js:25).
/** closed `accepted` → 200 + EXIT.accepted (bound-inject.js:139 → inject-bound-v1.js:121). */
const acceptedEnv = (over: Partial<Closed> = {}): R1Answer => envelope("accepted", null, 200, closed(over), 0);
/** closed `refused` → 4xx + EXIT.refused (bound-inject.js:139 → inject-bound-v1.js:124). */
const refusedEnv = (reason: string, over: Partial<Closed> = {}): R1Answer =>
  envelope("refused", reason, 409, closed({ stage: "refused", reason, inject_id: null,
    body_stage: "not_sent", submit_stage: "not_sent", bytes_written: 0, ...over }), 1);
/** schema-less 404 → the ONE answer that proves nothing was sent (bound-inject.js:140-142). */
const unsupportedEnv = (): R1Answer =>
  ({ stdout: JSON.stringify({ transport: "unsupported", reason: "route_unsupported", http_status: 404, result: null }) + "\n", exit: 1 });
/** pre-socket local refusal: no http_status key at all, EXIT.usage (inject-bound-v1.js:91-92, 98-99). */
const refusedLocallyEnv = (reason: string): R1Answer =>
  ({ stdout: JSON.stringify({ transport: "refused_locally", reason, result: null }) + "\n", exit: 2 });
/** the response never arrived → EXIT.unknown (inject-bound-v1.js:116-117). */
const lostEnv = (): R1Answer =>
  ({ stdout: JSON.stringify({ transport: "outcome_unknown", reason: "response_unavailable", result: null }) + "\n", exit: 3 });
/** an answer arrived but is not the closed schema → EXIT.unknown (bound-inject.js:144, :125). */
const unparseableEnv = (): R1Answer =>
  ({ stdout: JSON.stringify({ transport: "outcome_unknown", reason: "response_unparseable", http_status: 200, result: null }) + "\n", exit: 3 });

/**
 * The same daemon stub as above for every READ verb (identical snapshot, identical
 * capability document), but `inject-bound-v1` answers with the exact bytes and exit code
 * the real verb would produce. The stub itself classifies nothing: the test supplies the
 * measured shape, so the stub can never quietly re-implement the daemon's own judgement.
 */
const R1_TELEPTY_STUB = `
const fs = require('node:fs');
const argv = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(process.env.BOUND_STUB_CONFIG, 'utf8'));
const answer = JSON.parse(fs.readFileSync(process.env.BOUND_R1_CONFIG, 'utf8'));
fs.appendFileSync(process.env.BOUND_ORDER_LOG, JSON.stringify({ who: 'telepty', argv }) + '\\n');
const view = {
  id: cfg.sid, host: '127.0.0.1', backend: 'cmux', command: cfg.command,
  healthStatus: 'CONNECTED', ready: true, ownerPid: process.pid, ptyPid: process.pid,
  createdAt: '2026-11-16T00:00:00Z', lastConnectedAt: '2026-11-16T00:00:01Z',
  transport: {
    health_status: 'CONNECTED', ready: true, bootstrap: { ready: true },
    session_epoch: cfg.epoch, owner_generation: cfg.ownerGeneration, busy_input: cfg.busyInput,
  },
};
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(0); };
if (argv[0] === 'list') out([view]);
if (argv[0] === 'view' || argv[0] === 'show' || argv[0] === 'info') out(view);
if (argv[0] === 'session' && argv[1] === 'info') out(view);
if (argv[0] === 'boot-capabilities' || argv[0] === 'capabilities') out({ verbs: cfg.verbs });
if (argv[0] === 'read-screen') { process.stdout.write(${JSON.stringify(BUSY_SCREEN)}); process.exit(0); }
if (argv[0] === 'inject-bound-v1') {
  if (answer.stdout) process.stdout.write(answer.stdout);
  process.exit(answer.exit);
}
process.stderr.write('telepty r1 stub: refusing verb ' + JSON.stringify(argv.slice(0, 2)) + '\\n');
process.exit(97);
`;

/** arm() unchanged for every seam, with the real-envelope daemon stub in front of it. */
function armR1(f: F, answer: R1Answer, cfg: Partial<StubConfig> = {}, probe: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = arm(f, cfg, probe);
  const configFile = join(f.root, "telepty-r1.json");
  writeFileSync(configFile, JSON.stringify(answer));
  return { ...base, TELEPTY: f.script("telepty-r1-stub", R1_TELEPTY_STUB), BOUND_R1_CONFIG: configFile };
}

/** The one bound-result observation the record carries, parsed. */
function boundObservation(f: F): Record<string, unknown> {
  const committed = rows(f);
  assert.equal(committed.length, 1, `exactly one record:\n${JSON.stringify(committed)}`);
  const found = committed[0]!.observations.filter((o) => JSON.stringify(o).includes(RESULT_SCHEMA)
    || String((o as { kind?: unknown }).kind) === "bound_inject_result");
  assert.equal(found.length, 1, `exactly one bound-result observation:\n${JSON.stringify(committed[0])}`);
  // r2: the fields live under ONE nested `bound` object, and that is load-bearing — the
  // registry stores only the TOP-LEVEL fields whose value is not None
  // (bin/dispatch-registry.py:513-516), so a flat `bytes_written: null` is dropped and the
  // key goes missing from the durable record. Asserting the nesting here means a regression
  // to the flat shape fails loudly instead of silently returning `undefined` everywhere.
  const payload = found[0]!.bound;
  assert.ok(payload !== null && typeof payload === "object" && !Array.isArray(payload),
    `the bound-inject observation must nest its fields under \`bound\`, or every explicit ` +
    `null is dropped by the registry:\n${JSON.stringify(found[0])}`);
  return payload as Record<string, unknown>;
}

// ── (i) the REAL envelope drives the production parsing branch (M5) ─────────
describe("1270(i) r1/M5 the daemon CLI's real envelope is what the caller parses", () => {
  test("accepted: the envelope's closed result is accepted, recorded unknown, and the bounded transport travels", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armR1(f, acceptedEnv());
      const r = follow(f, overrides);
      const es = entries(f);
      assert.equal(boundSends(es).length, 1, `one bound send\n${r.stderr}`);
      assert.deepEqual(boundSends(es)[0]!.argv, expectedBoundArgv(f), "the same exact argv as the bare-object case");
      assert.equal(r.status, 0, `an accepted envelope exits 0\n${r.stderr}`);
      assert.match(r.stdout, /ACCEPTED_PENDING/, "accepted-pending is reported as such");
      assert.doesNotMatch(r.stdout, /OK dispatched/, "and never as a delivered dispatch");
      assert.doesNotMatch(r.stdout, /VERIFIED/);
      const row = rows(f)[0]!;
      assert.equal(row.transport.result, "unknown", "a hand-off is not an observed write");
      assert.equal(row.lifecycle.state, "delivery_state_unknown");
      assert.ok(!JSON.stringify(row).includes("write_observed"));
      const obs = boundObservation(f);
      const flat = JSON.stringify(obs);
      // M1: the envelope's own `transport` classification reaches the record, bounded.
      assert.equal(obs.transport, "accepted", `the bounded transport must be recorded:\n${flat}`);
      assert.equal(obs.verdict, "accepted", flat);
      // M2: what the daemon SAID the answer was about, kept apart from what the caller pinned.
      assert.deepEqual(obs.reported, { session_id: SID, session_epoch: EPOCH, owner_generation: OWNGEN }, flat);
      assert.deepEqual(obs.binding, { session_epoch: EPOCH, owner_generation: OWNGEN, busy_input: "supported" }, flat);
      for (const needle of [EPOCH, OWNGEN, INJECT_ID, "sent_to_bridge", "accepted"]) {
        assert.ok(flat.includes(needle), `${needle} missing:\n${flat}`);
      }
      assert.ok(!flat.includes("write_observed"));
    } finally { f.cleanup(); }
  });

  for (const [name, answer] of [["lost (no response)", lostEnv()], ["unparseable answer", unparseableEnv()]] as const) {
    test(`${name}: the real outcome_unknown envelope (exit 3) is HELD, never accepted, never unsent`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = armR1(f, answer);
        const r = follow(f, overrides);
        assert.equal(boundSends(entries(f)).length, 1, `one send, never a replay\n${r.stderr}`);
        assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [], "no alternate input path");
        assert.equal(r.status, 7, `an unknown outcome is held at exit 7\n${r.stderr}`);
        const row = rows(f)[0]!;
        assert.equal(row.transport.result, "unknown", "never not_delivered: a body may exist");
        assert.equal(row.lifecycle.state, "delivery_state_unknown");
        assert.ok(!JSON.stringify(row).includes("write_observed"));
        const obs = boundObservation(f);
        assert.equal(obs.transport, "outcome_unknown", JSON.stringify(obs));
        assert.equal(obs.bytes_written, null, "zero is never inferred from a lost or unparseable answer");
        // The hold, not a retry: the identical repeat is refused without a second send.
        const again = follow(f, overrides);
        assert.equal(boundSends(entries(f)).length, 1, `the stranded identity must not be re-sent\n${again.stderr}`);
        assert.equal(again.status, 7, again.stderr);
        assert.equal(rows(f).length, 1, "and no second record");
      } finally { f.cleanup(); }
    });
  }

  test("a result carrying the WRONG schema is never accepted, even with transport=accepted and exit 0", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armR1(f, envelope("accepted", null, 200, closed({ schema: "telepty.bound-inject-result/v2" }), 0));
      const r = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.notEqual(r.status, 0, `an unknown schema cannot authorize an acceptance\n${r.stderr}`);
      assert.equal(r.status, 7, `it is held unknown\n${r.stderr}`);
      assert.equal(rows(f)[0]!.transport.result, "unknown");
      assert.doesNotMatch(r.stdout, /ACCEPTED_PENDING/);
    } finally { f.cleanup(); }
  });
});

// ── (n) r2: an unknown effect is recorded EXPLICITLY, never as an absent key ─
// The r1 revision wrote these fields at the TOP LEVEL of the observation, where the
// registry drops every null (bin/dispatch-registry.py:513-516 `if v is not None`). The two
// CI failures were `bytes_written` reading `undefined` instead of `null`; the same filter
// was also erasing `schema`, `reason`, `reported` and `inject_id` — and, on the ACCEPTED
// shape, `bytes_written` too, which is the most dangerous one: a consumer that defaults an
// absent key to 0 reads "nothing was written" for a body that WAS handed over. These cases
// pin the invariant itself (presence AND an explicit value) for every shape that has a
// legitimately null field, so the flat shape cannot come back unnoticed.
describe("1270(n) r2 every unknown-effect field is present with an explicit value", () => {
  const nullableOnLost = ["schema", "reported", "inject_id", "bytes_written"];

  for (const [name, answer, cliReason] of [
    ["lost (no response)", lostEnv(), "response_unavailable"],
    ["unparseable answer", unparseableEnv(), "response_unparseable"],
  ] as const) {
    test(`${name}: every nullable field is PRESENT and explicitly null, and the cause is named`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armR1(f, answer));
        assert.equal(r.status, 7, r.stderr);
        const obs = boundObservation(f);
        const flat = JSON.stringify(obs);
        for (const key of nullableOnLost) {
          assert.ok(Object.hasOwn(obs, key), `${key} must be PRESENT, not dropped:\n${flat}`);
          assert.equal(obs[key], null, `${key} must be an explicit null for a ${name} answer:\n${flat}`);
        }
        // Not null, and not inferred either: the stages and the consumption are explicit.
        assert.equal(obs.body_stage, "unknown", flat);
        assert.equal(obs.submit_stage, "unknown", flat);
        assert.equal(obs.consumption, "unknown", flat);
        assert.equal(obs.stage, "unknown", flat);
        // r2: the verb's own reason code is the ONLY cause such an answer carries, so the
        // record must keep it — `transport: outcome_unknown` alone is not a diagnosis.
        assert.equal(obs.cli_reason, cliReason, `the verb's own reason must be recorded:\n${flat}`);
        assert.match(r.stderr, new RegExp(cliReason), "and it must reach the operator line too");
      } finally { f.cleanup(); }
    });
  }

  test("accepted: bytes_written is PRESENT and explicitly null — a hand-off is not a proven zero", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const r = follow(f, armR1(f, acceptedEnv()));
      assert.equal(r.status, 0, r.stderr);
      const obs = boundObservation(f);
      const flat = JSON.stringify(obs);
      assert.ok(Object.hasOwn(obs, "bytes_written"), `bytes_written must be PRESENT:\n${flat}`);
      assert.equal(obs.bytes_written, null,
        `an accepted hand-off has written no PROVEN byte count; a dropped key would read as 0:\n${flat}`);
      assert.ok(Object.hasOwn(obs, "reason"), `reason must be PRESENT even when null:\n${flat}`);
      assert.equal(obs.reason, null, flat);
      assert.equal(obs.cli_reason, null, "the accepted envelope carries no reason either");
      assert.equal(obs.consumption, "unknown", flat);
    } finally { f.cleanup(); }
  });
});

// ── (j) the proven-unsent branch, and its complement (M4) ───────────────────
describe("1270(j) r1/M4 an answer that PROVES nothing was written frees the ref", () => {
  // [name, answer, the reason that must reach the operator line, the verb's own reason code]
  const unsentCases: Array<[string, R1Answer, string, string]> = [
    // Two distinct REAL refusal reasons from the route's own order (session-actions.js:1939,
    // :1946), both 4xx — on this route 4xx means nothing was written (API-MAP §1).
    ["closed refused: epoch_mismatch", refusedEnv("epoch_mismatch", { session_epoch: "EPOCH-moved-on" }), "epoch_mismatch", "epoch_mismatch"],
    ["closed refused: busy_input_unsupported", refusedEnv("busy_input_unsupported"), "busy_input_unsupported", "busy_input_unsupported"],
    // The two shapes that prove it without reaching the daemon at all.
    ["schema-less 404 (route unsupported)", unsupportedEnv(), "unsupported", "route_unsupported"],
    ["pre-socket local refusal", refusedLocallyEnv("non_canonical_daemon_host"), "refused_locally", "non_canonical_daemon_host"],
  ];

  for (const [name, answer, reason, cliReason] of unsentCases) {
    test(`${name}: recorded not_delivered at exit 3, and the SAME ref may be dispatched again`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = armR1(f, answer);
        const r = follow(f, overrides);
        assert.equal(boundSends(entries(f)).length, 1, `exactly one send\n${r.stderr}`);
        assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [], "no key write on a refusal");
        assert.deepEqual(legacyInjects(entries(f)).map((e) => e.argv), [], "and no legacy fallback");
        assert.equal(r.status, 3, `a proven-unsent refusal is exit 3\n${r.stderr}`);
        assert.match(r.stderr, /BOUND_INJECT_REFUSED/, "the refusal is named");
        assert.ok(r.stderr.includes(reason), `the reason travels: expected ${reason}\n${r.stderr}`);
        assert.match(r.stderr, /may be dispatched again/, "and says so");
        const row = rows(f)[0]!;
        assert.equal(row.transport.result, "not_delivered", "nothing was written, and the record says exactly that");
        assert.equal(row.lifecycle.state, "not_delivered");
        assert.ok(!JSON.stringify(row).includes("write_observed"));
        // r2: a PROVEN zero is recorded as an explicit 0 — the other half of the invariant
        // case (n) pins, and the only shape where the contract allows a zero at all.
        const obs = boundObservation(f);
        assert.ok(Object.hasOwn(obs, "bytes_written"), `bytes_written must be PRESENT:\n${JSON.stringify(obs)}`);
        assert.equal(obs.bytes_written, 0, `a proven-unsent refusal records an explicit 0:\n${JSON.stringify(obs)}`);
        assert.equal(obs.cli_reason, cliReason, `the verb's own reason must be recorded:\n${JSON.stringify(obs)}`);
        // The whole point of the branch: the identity is NOT held, so the retry proceeds.
        const again = follow(f, overrides);
        assert.equal(boundSends(entries(f)).length, 2,
          `a proven-unsent ref must be re-dispatchable, not held\n${again.stderr}`);
        assert.notEqual(again.status, 7, `and must not report DISPATCH_RETRY_HELD\n${again.stderr}`);
        assert.equal(rows(f).length, 2, "the second attempt is its own record");
      } finally { f.cleanup(); }
    });
  }

  test("a `refused` whose effect is ambiguous (bytes_written null) must NOT be read as unsent", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The daemon refused the CR after the body may already have been handed over, so zero
      // is NOT authoritative: bound-inject.js:126 nulls the count the moment a body may exist.
      const overrides = armR1(f, refusedEnv("submit_refused_after_body",
        { bytes_written: null, body_stage: "sent_to_bridge", submit_stage: "not_sent", inject_id: INJECT_ID }));
      const r = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.equal(r.status, 7, `an ambiguous refusal is HELD, not freed\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /may be dispatched again/, "it must not invite a re-dispatch");
      const row = rows(f)[0]!;
      assert.equal(row.transport.result, "unknown", "never not_delivered while a body may exist");
      assert.equal(row.lifecycle.state, "delivery_state_unknown");
      const again = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, `held means no second send\n${again.stderr}`);
      assert.equal(again.status, 7, again.stderr);
    } finally { f.cleanup(); }
  });
});

// ── (k) a response about another identity (M2) ──────────────────────────────
describe("1270(k) r1/M2 an answer is only an acceptance for the identity it names", () => {
  test("a different session_id is never accepted and never provably unsent — it is held", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armR1(f, acceptedEnv({ session_id: "some-other-session" }));
      const r = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.equal(r.status, 7, `an answer about another session cannot book this one\n${r.stderr}`);
      assert.doesNotMatch(r.stdout, /ACCEPTED_PENDING/, "nothing is reported as accepted");
      assert.match(r.stderr, /bound_session_identity_mismatch/, "the mismatch is named");
      const row = rows(f)[0]!;
      assert.equal(row.transport.result, "unknown", "and it is NOT recorded as nothing-written");
      assert.equal(row.lifecycle.state, "delivery_state_unknown");
      assert.equal(boundObservation(f).verdict, "held:bound_session_identity_mismatch");
      const again = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, `held: no replay\n${again.stderr}`);
      assert.equal(again.status, 7, again.stderr);
    } finally { f.cleanup(); }
  });

  test("an `accepted` carrying a different epoch/generation is held, not booked on the pin", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armR1(f, acceptedEnv({ session_epoch: "EPOCH-not-the-pinned-one" }));
      const r = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.equal(r.status, 7, `the binding the daemon reports must BE the pinned one\n${r.stderr}`);
      assert.match(r.stderr, /bound_binding_identity_mismatch/, "the mismatch is named");
      assert.equal(rows(f)[0]!.transport.result, "unknown");
      const obs = boundObservation(f);
      // The record keeps both, so a reviewer can see what disagreed with what.
      assert.deepEqual(obs.reported,
        { session_id: SID, session_epoch: "EPOCH-not-the-pinned-one", owner_generation: OWNGEN }, JSON.stringify(obs));
      assert.deepEqual(obs.binding, { session_epoch: EPOCH, owner_generation: OWNGEN, busy_input: "supported" });
    } finally { f.cleanup(); }
  });
});

// ── (l) opaque tokens are opaque (M3) ───────────────────────────────────────
describe("1270(l) r1/M3 a legitimate opaque token the old charset refused is delivered unchanged", () => {
  test("`+ / = space ·` in the epoch/owner generation: admitted, and passed through as ONE argv element each", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The daemon's own rule is bytes + no control characters (bound-inject.js:35-39); the
      // contract calls these tokens OPAQUE, so the caller may not impose an alphabet.
      const overrides = armR1(f, acceptedEnv({ session_epoch: WIDE_EPOCH, owner_generation: WIDE_OWNGEN }),
        { epoch: WIDE_EPOCH, ownerGeneration: WIDE_OWNGEN });
      const r = follow(f, overrides);
      const es = entries(f);
      assert.doesNotMatch(r.stderr, /BOUND_INJECT_UNSUPPORTED/,
        `an opaque token must not be refused for its alphabet\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE);
      assert.equal(boundSends(es).length, 1, `the bound send must happen\n${r.stderr}`);
      // Byte-for-byte, as single argv elements — no quoting, splitting or escaping anywhere.
      assert.deepEqual(boundSends(es)[0]!.argv, ["inject-bound-v1", "--from", FROM,
        "--expected-epoch", WIDE_EPOCH, "--expected-owner-generation", WIDE_OWNGEN, "--", SID,
        `[context-ref] Read ${stagedRef(f)} and use it as the source of truth for this task.`]);
      assert.equal(r.status, 0, `and it is accepted\n${r.stderr}`);
      const obs = boundObservation(f);
      assert.deepEqual(obs.binding, { session_epoch: WIDE_EPOCH, owner_generation: WIDE_OWNGEN, busy_input: "supported" });
    } finally { f.cleanup(); }
  });
});

// ── (m) both dispatch-verify.sh guards, with the real policy spelling (M6) ──
// The production policy answers RESUBMIT_ENTER only for the not-moving startup surfaces
// and ESCALATE for surface=working (bin/policy.py:134-136), so these two stubs are the two
// real answers. Each case names which guard it would catch if that guard were deleted.
function policyStub(f: F, action: "NOOP" | "RESUBMIT_ENTER" | "ESCALATE"): string {
  // The real answers bin/policy.py gives under `--status verify_started`: NOOP/verified when
  // detail.verify_started is true (:130-131), RESUBMIT_ENTER for the not-moving startup
  // surfaces (:134-135), ESCALATE otherwise (:136).
  const status = action === "NOOP" ? "verified" : "not_started";
  const reason = action === "NOOP" ? "session verified started-working"
    : "no working spinner (idle/static) [not-moving]";
  return f.script(`policy-${action.toLowerCase()}`, `
process.stdout.write(JSON.stringify({ action: ${JSON.stringify(action)}, key: 'enter',
  reason: ${JSON.stringify(reason)}, status: ${JSON.stringify(status)} }) + '\\n');
`);
}

/**
 * bin/dispatch-verify.sh itself, with a zero settle so the 6s wait is not paid.
 * r5: `readonly string[]`, because the caller's table is `as const` (a readonly tuple) and
 * this function only spreads the args into a new array — it never mutates them. `spawnSync`
 * itself declares `args?: readonly string[]`.
 */
function runVerify(f: F, args: readonly string[], overrides: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync("bash", [VERIFY_SH, SID, "--settle-ms", "0", ...args],
    { cwd: f.root, env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 40000 });
}

// r3: bin/dispatch-verify.sh refuses up front on native Windows, so on win32 the cases that
// drive it ASSERT that refusal and its zero effect instead of being skipped — the Windows
// lane's rule is zero failures AND zero skips. Convention mirrored from
// tests/dispatch/T150-task-ledger-queue-shape.test.ts:25 (`const WIN32 = …`) and :64-69
// (assert the exit, assert the named refusal, assert nothing happened, then return); the
// same shape is used by tests/dispatch/cli-cap-regression.test.ts:30-31 and
// tests/dispatch/T141-model-launcher-flags.test.ts:119,149.
const WIN32 = process.platform === "win32";
/**
 * MEASURED from the script, not assumed (`bin/dispatch-verify.sh:31`):
 *   case "$(uname -s)" in MINGW*|MSYS*) echo "dispatch-verify.sh: needs confined worker
 *     sessions, unavailable on native Windows (SANDBOX_PLATFORM_UNSUPPORTED); use WSL2" >&2;
 *     exit 78;; esac
 * The message goes to stderr (`>&2`), so stdout stays empty; the exit is 78; and the line
 * sits AFTER argument parsing but BEFORE `[ -n "$sid" ]` (:32), the `say()` definition
 * (:34), `run_check` (:36) and every call to it — so on win32 no probe or policy helper
 * runs, nothing is printed on stdout, and no key can be sent by any path. This refusal is
 * existing product behaviour and is not changed by this unit.
 */
const WIN32_VERIFY_REFUSAL =
  /^dispatch-verify\.sh: needs confined worker sessions, unavailable on native Windows \(SANDBOX_PLATFORM_UNSUPPORTED\); use WSL2$/m;

function assertWin32VerifyRefusal(f: F, r: SpawnSyncReturns<string>): void {
  assert.equal(r.status, 78, `the platform refusal exits 78\n${r.stderr}`);
  assert.match(r.stderr, WIN32_VERIFY_REFUSAL, r.stderr);
  assert.equal(r.stdout, "", `the refusal is written to stderr only\n${r.stdout}`);
  // The invariant the case exists for still holds here, for the platform's own reason: the
  // script exits before run_check, so no Enter and no send-key of any spelling is possible.
  assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [],
    "a script that refuses before run_check cannot send a key either");
  assert.doesNotMatch(r.stdout, /VERIFIED/);
}

// r4 decision 3 (M-B): the three (m) subtests that drove the reverted `set -e` repair and the
// two resubmit guards are REMOVED with that code; their text is preserved verbatim in
// output/TASK-1275-HANDOFF.md so task 1275 inherits the coverage it needs. What stays below
// is the one fork the bound path itself owns — OBSERVED instead of VERIFIED — which is
// reachable with the base defect in place because a verified verdict exits 0 and therefore
// never trips `set -e` (bin/dispatch-verify.sh:94 `out=$(run_check); rc=$?`).
//
// r7 m8 adds `[ "$observe_only" -eq 0 ]` to that same resubmit branch, and it is deliberately
// UNTESTED here for the same reason: the branch needs rc==6, and under the base `set -e` line
// the script has already exited by then, so no run can reach it. The guard is there for after
// task 1275 repairs that line, and the case for it belongs to 1275's coverage.
describe("1270(m) r4/M-D observe-only prints OBSERVED, never a fresh VERIFIED", () => {
  for (const [name, args, expectWord, forbidWord] of [
    ["--observe-only", ["--observe-only"], /OBSERVED /, /VERIFIED/],
    ["without it (the legacy word is intact)", [], /VERIFIED /, /OBSERVED/],
  ] as const) {
    test(`${name}: a verified verdict prints ${expectWord.source.trim()} and not ${forbidWord.source}`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        // The ONE state that reaches the fork: no probe_error, and the policy answering
        // NOOP/verified (bin/dispatch-verify.sh:68-77). Both legs exit 0, so the base
        // `set -e` defect never hides the print.
        const overrides = { ...arm(f), POLICY_PY: policyStub(f, "NOOP") };
        const r = runVerify(f, args, overrides);
        if (WIN32) { assertWin32VerifyRefusal(f, r); return; }
        assert.equal(r.status, 0, `a verified verdict exits 0\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, expectWord, r.stdout);
        assert.doesNotMatch(r.stdout, forbidWord, r.stdout);
        // Neither leg may touch the session: this fork only chooses a WORD.
        assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [], "no key on either leg");
      } finally { f.cleanup(); }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// r4 ADDITIONS — the REAL probe drives the admission (decision 2 / blocker B1), plus the
// cases the second review asked for. Everything below either runs bin/session-probe.py
// itself on a captured screen, or pins an operator-visible line that had no test.
// ═══════════════════════════════════════════════════════════════════════════════

/** Mirrors tests/dispatch/T144-agy-trust-readiness.test.ts:22, which runs the real probe. */
const PYTHON = process.env.PYTHON || "python3";
const REAL_PROBE = join(REPO, "bin/session-probe.py");
const SCREENS = join(REPO, "tests/dispatch/fixtures");

/**
 * NOT a stub: this is the production `SESSION_PROBE_PY` seam pointed at the REAL
 * bin/session-probe.py, run offline through its own `--screen-file` / `--info-file` inputs.
 * The CLI's own argv (`--sid`, `--cli`) is passed through untouched and the probe's verdict
 * is forwarded verbatim, so the admission decides on what the shipped probe really emits.
 *
 * `--telepty telepty` is appended because `observe()` runs `safe_token(args.telepty, …)`
 * against SAFE_CLI before anything else (probe :595), and the fixture's TELEPTY is an
 * absolute path — which on win32 contains `\` and would be refused. In offline mode the
 * value is never used (both `--screen-file` and `--info-file` are supplied), so pinning it
 * to the default changes no verdict.
 *
 * r7 M1 — the LIVE field substitution, and its exact extent. The probe's mode switch is
 * `current = not args.screen_file` (:638) and `--info-file` WITHOUT `--screen-file` raises
 * `ScreenUnavailable` and sets probe_error (:625), so there is no flag combination that
 * yields a live verdict without a daemon: offline is the only mode this harness can execute.
 * The verbatim offline verdict is therefore always written to `REAL_PROBE_MEASURED` (what the
 * real probe actually printed, asserted by the cases below), and when
 * `REAL_PROBE_LIVE_REASON` is set, exactly ONE field — `detail.ready_reason`, the only field
 * whose value offline mode cannot produce — is replaced before the verdict reaches the CLI.
 * Everything else the admission reads (alive, ready, surface, tracker_class, probe_error)
 * stays the probe's own measurement of the real screen. A verdict that does not parse is
 * passed through untouched.
 */
const REAL_PROBE_WRAPPER = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.env.REAL_PROBE_CONFIG, 'utf8'));
fs.appendFileSync(process.env.BOUND_ORDER_LOG, JSON.stringify({ who: 'probe', argv: process.argv.slice(2) }) + '\\n');
const r = spawnSync(cfg.python, [cfg.probe, ...process.argv.slice(2),
  '--screen-file', cfg.screen, '--info-file', cfg.info, '--telepty', 'telepty'], { encoding: 'utf8' });
let out = r.stdout || '';
if (out) {
  fs.writeFileSync(process.env.REAL_PROBE_MEASURED, out);
  const live = process.env.REAL_PROBE_LIVE_REASON || '';
  if (live) {
    try {
      const v = JSON.parse(out);
      v.detail.ready_reason = live;
      out = JSON.stringify(v) + '\\n';
    } catch { /* unparseable: hand the caller exactly what the probe said */ }
  }
}
if (out) process.stdout.write(out);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status === null ? 1 : r.status);
`;

/** A live, CONNECTED, transport-ready session — the half of the verdict that is not the screen. */
const LIVE_INFO = {
  id: SID, command: "claude", healthStatus: "CONNECTED", ready: true,
  transport: { health_status: "CONNECTED", ready: true, bootstrap: { ready: true } },
};

/** The r1 daemon stub plus a legacy `inject` arm, for the cases where an IDLE target delivers. */
const R4_TELEPTY_STUB = R1_TELEPTY_STUB.replace(
  "if (argv[0] === 'inject-bound-v1') {",
  `if (argv[0] === 'inject') {
  process.stdout.write('inject_id: 00000000-0000-4000-8000-000000000000\\n');
  process.exit(0);
}
if (argv[0] === 'inject-bound-v1') {`);

/** Where the wrapper parks the real probe's verbatim stdout for this run. */
const measuredPath = (f: F): string => join(f.root, "r7-measured.json");

/** What the REAL probe printed, for the four fields the admission predicate reads. */
interface MeasuredVerdict { surface: string; ready: boolean; readyReason: string; trackerClass: string }
function measuredVerdict(f: F): MeasuredVerdict {
  const raw = readFileSync(measuredPath(f), "utf8");
  const v = JSON.parse(raw) as { ready?: unknown; surface?: unknown; detail?: Record<string, unknown> };
  const detail: Record<string, unknown> = v.detail ?? {};
  return {
    surface: String(v.surface), ready: v.ready === true,
    readyReason: String(detail.ready_reason), trackerClass: String(detail.tracker_class),
  };
}

/**
 * Arm one dispatch whose readiness verdict comes from the REAL probe reading `screen`.
 * `screen` is either a path under tests/dispatch/fixtures (a measured capture) or inline
 * screen text, which is written into the fixture root. `liveReason`, when non-empty, is the
 * one substituted field documented on REAL_PROBE_WRAPPER; "" leaves the probe's own offline
 * verdict completely untouched, which is what the caller then has to refuse (r7 m3).
 */
function armRealProbe(f: F, screen: { file: string } | { text: string },
  answer: R1Answer = acceptedEnv(), liveReason = ""): NodeJS.ProcessEnv {
  const base = armR1(f, answer);
  const screenPath = "file" in screen ? join(SCREENS, screen.file) : join(f.root, "r4-screen.txt");
  if ("text" in screen) writeFileSync(screenPath, screen.text);
  const infoPath = join(f.root, "r4-info.json");
  writeFileSync(infoPath, JSON.stringify(LIVE_INFO));
  const configFile = join(f.root, "r4-probe.json");
  writeFileSync(configFile, JSON.stringify({ python: PYTHON, probe: REAL_PROBE, screen: screenPath, info: infoPath }));
  return { ...base, TELEPTY: f.script("telepty-r4-stub", R4_TELEPTY_STUB),
    SESSION_PROBE_PY: f.script("probe-real-wrapper", REAL_PROBE_WRAPPER), REAL_PROBE_CONFIG: configFile,
    REAL_PROBE_MEASURED: measuredPath(f), REAL_PROBE_LIVE_REASON: liveReason };
}

/**
 * r5: the FROZEN `Entry.who` union (`:216`) is `"telepty" | "registry"` — it predates the r4
 * real-probe wrapper, which appends a third producer (`who: "probe"`) to the same log. The
 * original interface may not be edited, so the rows are widened once, soundly (both members
 * of the union are strings), instead of comparing against a literal the union cannot hold or
 * casting to `any`.
 */
interface LoggedCall { who: string; argv: string[] }
const logged = (es: Entry[]): LoggedCall[] => es;
const probeReads = (es: Entry[]) => logged(es).filter((e) => e.who === "probe");
const listReads = (es: Entry[]) => telepty(es).filter((e) => e.argv[0] === "list");

// Inline screens for the shapes no measured fixture carries. All are claude viewports.
/**
 * A working row with no parenthesised affordance and no spinner, and an empty composer.
 * r6 corrected r4 here: r4 expected a refusal because its predicate required
 * `tracker_class === "active"`, an expectation derived by reading rather than by measuring,
 * and CI then showed that same guard refusing the canonical busy capture
 * (`working_active.txt`). The probe's own verdict here is: working surface, composer empty,
 * no approval banner. That is the state the bound path exists for.
 */
const WORKING_NO_AFFORDANCE = "reading bin/dispatch.sh\n\n■ Working... (12s)\n ❯ \n";
/**
 * A busy row while the welcome banner is still on screen (a just-resumed session that began
 * working before the banner scrolled off). `TRACKER_WELCOME` + a prompt in the last three
 * lines makes `tracker_class` `"welcome"` (probe :129, :294-299), the family the tracker
 * allow-list leaves out — and the one screen here that is qualified busy on every OTHER
 * conjunct, so the guard is the only thing refusing it.
 */
const BUSY_WITH_WELCOME_BANNER = "⏺ Working... (5s · esc to interrupt)\nWelcome back!\n ❯ \n";
/** A busy row AND an approval prompt: the modal family must win over a genuine busy glyph. */
const BUSY_WITH_ENTER_PROMPT = "analyzing\n\n◉ Working... (5s · esc to interrupt)\nPress Enter to continue\n ❯ \n";
/** Busy with the composer already carrying a staged context-ref (UNSUBMITTED, probe :105). */
const BUSY_WITH_UNSUBMITTED = "analyzing\n\n◉ Working... (5s · esc to interrupt)\n ❯ [context-ref] Read /tmp/shared/abcdef123456.md\n";

/**
 * r7 M1/m2/m3: the busy reason the probe produces for a LIVE current viewport, and after
 * r7 the ONLY reason the caller admits. See REAL_PROBE_WRAPPER for why it has to be
 * substituted into an offline run, and for exactly what is and is not substituted.
 */
const LIVE_BUSY_REASON = "current-busy-or-modal";
/** r7 m4: the tracker classes the production allow-list admits (cli.ts:1350). */
const ADMITTED_TRACKERS = ["blank", "active", "prompt_observed"];

/**
 * The genuinely busy screens the real probe is run on. The third element is the tracker
 * class where it has been MEASURED (`active.txt` and `working_active.txt`, both measured by
 * CI and re-measured by the third review); `null` means this unit has not measured it, so
 * the case asserts only what is known — membership of the admitted allow-list — rather than
 * a value derived by reading, which is the mistake r6 had to correct.
 */
const BUSY_SCREENS: Array<[string, { file: string } | { text: string }, string | null]> = [
  // A braille spinner + `(esc to interrupt)` + an empty `❯`.
  ["measured busy claude (spinner + esc-to-interrupt + empty composer)", { file: "active.txt" }, "active"],
  // The `⏺ Working... (5s · esc to interrupt)` row, and NO composer row at all.
  ["measured busy claude (working row, no composer line)", { file: "working_active.txt" }, "blank"],
  ["working row with no parenthesised affordance, empty composer", { text: WORKING_NO_AFFORDANCE }, null],
];
/**
 * The subset whose composer row is present and EMPTY, i.e. the screens whose live reason
 * really is `current-busy-or-modal`. `working_active.txt` is deliberately absent: it carries
 * no composer row, so live mode returns `no-empty-current-prompt` BEFORE any busy test
 * (probe :486-488) and refuses it. Handing it the live reason would assert an admission
 * production does not make. The next case pins that premise on the capture itself.
 */
const LIVE_BUSY_SCREENS = [BUSY_SCREENS[0]!, BUSY_SCREENS[2]!];

/** An empty composer row: the prompt glyph alone on its line (claude ❯ / codex › / gemini). */
const EMPTY_COMPOSER_ROW = /^\s*[❯›>│]\s*$/;
/**
 * Whether the screen offers an empty composer row inside the window the live composer gate
 * reads — the last 5 non-empty rows (probe :484). This is the PREMISE the live reason rests
 * on, asserted against the screen bytes; it is not a re-implementation of the gate, which
 * only the probe may evaluate.
 */
function hasEmptyComposerRow(screen: { file: string } | { text: string }): boolean {
  const text = "file" in screen ? readFileSync(join(SCREENS, screen.file), "utf8") : screen.text;
  const rows = text.split("\n").filter((l) => l.trim() !== "");
  return rows.slice(-5).some((l) => EMPTY_COMPOSER_ROW.test(l));
}

/** Screens that must never be admitted, with the measured surface where it is known. */
const REFUSED_SCREENS: Array<[string, { file: string } | { text: string }, string, string | null]> = [
  ["measured trust-folder modal", { file: "trust_folder_modal.txt" }, "surface=modal (TRUST_MODAL, probe :73)", "modal"],
  ["busy glyph + Press Enter to continue", { text: BUSY_WITH_ENTER_PROMPT }, "the modal reader wins over a busy glyph", null],
  ["busy row while the welcome banner is still on screen", { text: BUSY_WITH_WELCOME_BANNER }, "tracker_class is `welcome`", null],
  ["busy with an unsubmitted context-ref in the composer", { text: BUSY_WITH_UNSUBMITTED }, "surface=unsubmitted", null],
];

// ── (o) the REAL probe decides the admission (B1 / decision 2, r7 M1) ────────
describe("1270(o) r4/B1 the admission is decided by the REAL bin/session-probe.py", () => {
  // r7 m3: the probe's OFFLINE verdict is the one this harness can execute, and it is
  // exactly the verdict the caller must now refuse — `ready_by_screen` (probe :360-372)
  // never inspects the composer, so `hard-negative` is no evidence that a body can be
  // appended safely. Before r7 these three cases asserted ADMISSION on that verdict.
  for (const [name, screen, tracker] of BUSY_SCREENS) {
    test(`${name}: measured busy by the real probe, and its OFFLINE verdict admits nothing`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armRealProbe(f, screen));
        const m = measuredVerdict(f);
        assert.equal(m.surface, "working", `the real probe must read this screen as busy: ${JSON.stringify(m)}`);
        assert.equal(m.ready, false, "and a busy screen is never ready");
        assert.equal(m.readyReason, "hard-negative", "offline speaks `ready_by_screen`'s vocabulary");
        if (tracker !== null) assert.equal(m.trackerClass, tracker, "the measured tracker class");
        assert.ok(ADMITTED_TRACKERS.includes(m.trackerClass),
          `the tracker class must not be the thing refusing this screen: ${JSON.stringify(m)}`);
        assert.deepEqual(boundSends(entries(f)).map((e) => e.argv), [],
          `an offline verdict has no composer guarantee and must never admit\n${r.stdout}\n${r.stderr}`);
        assertNoInputEffect(f, name);
        assert.notEqual(r.status, 0, `and the dispatch must not report a delivery\n${r.stderr}`);
        assert.match(r.stderr, READY_TIMEOUT_LINE, "it falls back to the unchanged readiness wait");
      } finally { f.cleanup(); }
    });
  }

  test("the one busy capture with no composer row is the one the live path cannot admit", () => {
    assert.equal(hasEmptyComposerRow({ file: "working_active.txt" }), false,
      "working_active.txt must stay a faithful capture of a busy screen with no composer row");
    for (const [name, screen] of LIVE_BUSY_SCREENS) {
      assert.equal(hasEmptyComposerRow(screen), true, `${name}: the live reason requires an empty composer row`);
    }
  });

  // r7 M1: the same MEASURED classification, with the one field offline mode cannot produce
  // set to the live value. This is the only reason production can emit, and before r7 no
  // case in this file asserted on it at all.
  for (const [name, screen, tracker] of LIVE_BUSY_SCREENS) {
    test(`${name}: admitted on the LIVE busy reason, exactly one bound send`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = armRealProbe(f, screen, acceptedEnv(), LIVE_BUSY_REASON);
        const r = follow(f, overrides);
        const es = entries(f);
        const m = measuredVerdict(f);
        assert.equal(m.surface, "working", `the admission still rests on the probe's own surface: ${JSON.stringify(m)}`);
        assert.equal(m.ready, false, "and on its own ready=false");
        if (tracker !== null) assert.equal(m.trackerClass, tracker, "and on its own tracker class");
        assert.ok(ADMITTED_TRACKERS.includes(m.trackerClass), `tracker class in the allow-list: ${m.trackerClass}`);
        assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE,
          `the live busy verdict must admit the bound path\n${r.stdout}\n${r.stderr}`);
        assert.equal(boundSends(es).length, 1, `one bound send\n${r.stdout}\n${r.stderr}`);
        assert.deepEqual(boundSends(es)[0]!.argv, expectedBoundArgv(f), "the exact frozen argv");
        assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], "never a legacy inject to a busy session");
        assert.deepEqual(keyWrites(es).map((e) => e.argv), [], "and never a key");
        assert.equal(r.status, 0, `accepted-pending exits 0\n${r.stderr}`);
        assert.match(r.stdout, /ACCEPTED_PENDING/);
      } finally { f.cleanup(); }
    });
  }

  // r7: the refusals are now measured against the LIVE reason too, so each one is carried by
  // the probe's own surface or tracker class rather than by the offline reason being absent
  // from the admitted set. Four screens that a busy-word reader alone would have admitted.
  for (const [name, screen, why, surface] of REFUSED_SCREENS) {
    test(`${name}: NOT admitted even with the live busy reason (${why}), nothing sent, nothing recorded`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = armRealProbe(f, screen, acceptedEnv(), LIVE_BUSY_REASON);
        const r = follow(f, overrides);
        const m = measuredVerdict(f);
        if (surface !== null) assert.equal(m.surface, surface, `the measured surface: ${JSON.stringify(m)}`);
        assert.ok(m.surface !== "working" || !ADMITTED_TRACKERS.includes(m.trackerClass),
          `the refusal must come from the probe's own classification, not from the reason: ${JSON.stringify(m)}`);
        assert.deepEqual(boundSends(entries(f)).map((e) => e.argv), [],
          `${why}: the bound path must stay closed\n${r.stdout}\n${r.stderr}`);
        assertNoInputEffect(f, name);
        assert.notEqual(r.status, 0, `and the dispatch must not report a delivery\n${r.stderr}`);
      } finally { f.cleanup(); }
    });
  }

  test("measured idle prompt: not admitted, delivered by the legacy inject, and the idle path's read counts are unchanged", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armRealProbe(f, { file: "done.txt" });
      const r = follow(f, overrides);
      const es = entries(f);
      assert.deepEqual(boundSends(es).map((e) => e.argv), [], "an idle target is the legacy path's business");
      assert.equal(legacyInjects(es).length, 1, `and it IS delivered\n${r.stdout}\n${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /OK dispatched/, "the legacy success line is intact");
      // r4 m-G: the unchanged idle path must pay exactly what it paid in base — one readiness
      // probe (the admission's, REUSED as the wait's first verdict) and the two `telepty list`
      // reads base already made (resolveRoute's cliOf, waitForRegistration's cliOf).
      assert.equal(probeReads(es).length, 1, `exactly one probe invocation:\n${JSON.stringify(probeReads(es))}`);
      assert.equal(listReads(es).length, 2, `exactly two listings:\n${JSON.stringify(listReads(es))}`);
    } finally { f.cleanup(); }
  });
});

// ── (p) M-C: "the daemon never said which binding" vs "the binding moved" ───
describe("1270(p) r4/M-C a null epoch or owner generation is its own named hold", () => {
  for (const [name, over] of [
    ["session_epoch null", { session_epoch: null }],
    ["owner_generation null", { owner_generation: null }],
  ] as const) {
    test(`${name}: held as bound_binding_not_asserted, never as a moved binding`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armR1(f, acceptedEnv(over)));
        assert.equal(boundSends(entries(f)).length, 1, r.stderr);
        assert.equal(r.status, 7, `an unasserted binding cannot book an acceptance\n${r.stderr}`);
        assert.match(r.stderr, /bound_binding_not_asserted/, "named distinctly");
        assert.doesNotMatch(r.stderr, /bound_binding_identity_mismatch/, "and NOT as a mismatch");
        assert.doesNotMatch(r.stdout, /ACCEPTED_PENDING/);
        const row = rows(f)[0]!;
        assert.equal(row.transport.result, "unknown", "never not_delivered: a body may exist");
        assert.equal(boundObservation(f).verdict, "held:bound_binding_not_asserted");
      } finally { f.cleanup(); }
    });
  }
});

// ── (q) m-B: a closed result outranks a contradicting envelope word ─────────
describe("1270(q) r4/m-B the closed result outranks the envelope's transport word", () => {
  test("transport=refused_locally with an ACCEPTED closed result is HELD, never freed", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // A contradiction: the word says nothing was sent, the daemon's own object says both
      // frames were handed over. Freeing the ref here would double-send the next dispatch.
      const contradiction: R1Answer = {
        stdout: JSON.stringify({ transport: "refused_locally", reason: "non_canonical_daemon_host",
          result: closed({ stage: "accepted", bytes_written: 0 }) }) + "\n",
        exit: 2,
      };
      // Armed ONCE: arm() truncates the shared order log (`writeFileSync(orderLogPath(f), "")`),
      // so re-arming before the repeat would erase the first send and the count below would
      // observe 0 — which is exactly how CI failed this case in run 43885485949.
      const overrides = armR1(f, contradiction);
      const r = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.equal(r.status, 7, `a contradicted word cannot prove unsent\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /may be dispatched again/, "the ref must NOT be freed");
      const row = rows(f)[0]!;
      assert.equal(row.transport.result, "unknown", "held unknown, not not_delivered");
      assert.equal(row.lifecycle.state, "delivery_state_unknown");
      // …and the observation records NO provable zero: a 0 beside an `accepted` stage
      // contradicts itself, so it is degraded to null rather than believed.
      assert.equal(boundObservation(f).bytes_written, null,
        "an accepted stage cannot carry an authoritative zero");
      const again = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 1, `held means no second send\n${again.stderr}`);
      assert.equal(again.status, 7, again.stderr);
    } finally { f.cleanup(); }
  });
});

// ── (r) m-I: the two operator-visible lines that had no test ────────────────
describe("1270(r) r4/m-I the --verify-delivered no-op NOTE and the SKIPPED verifier note", () => {
  test("--verify-delivered on the bound path: exit 0, the NOTE says verification was NOT performed, and no screen is read", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armR1(f, acceptedEnv());
      const r = run(f, ["--target", SID, "--from", FROM, "--verify-delivered"], overrides);
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.equal(r.status, 0, `the Root decision keeps exit 0\n${r.stderr}`);
      assert.match(r.stderr, /NOTE delivery verification was NOT performed/, r.stderr);
      assert.match(r.stderr, /declared no-op/, r.stderr);
      assert.deepEqual(telepty(entries(f)).filter((e) => e.argv[0] === "read-screen").map((e) => e.argv), [],
        "a queued body is not on the screen, so no screen read is attempted");
    } finally { f.cleanup(); }
  });

  test("an installed dispatch-verify.sh that predates --observe-only is reported as SKIPPED, not as a bad verdict", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The old script answers its `-*)` catch-all with exit 4 (base dispatch-verify.sh:20).
      // SCRIPT_DIR is the only seam that resolves VERIFY_SH, and every other helper it would
      // resolve is already overridden by its own env var on the --target path.
      f.script("dispatch-verify.sh", "process.exit(4);");
      const overrides = { ...armR1(f, acceptedEnv()), DISPATCH_SCRIPT_DIR: f.bin };
      const r = run(f, ["--target", SID, "--from", FROM], overrides, { verifyStarted: true });
      assert.equal(boundSends(entries(f)).length, 1, r.stderr);
      assert.equal(r.status, 0, `a skipped observation does not fail the accepted hand-off\n${r.stderr}`);
      assert.match(r.stderr, /does not understand --observe-only \(exit 4\)/, r.stderr);
      assert.match(r.stderr, /SKIPPED/, r.stderr);
      assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [], "and nothing was sent to the session");
    } finally { f.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// r7 ADDITIONS — the ONE reason production can emit, and the allow-list that reads it.
// The third review measured the real probe on 60 screens and derived live mode line by
// line: `current-busy-or-modal` is the only busy reason a LIVE current viewport ever
// produces, and no case in this file asserted on it. These cases do, and they do it on a
// live-SHAPED verdict rather than on an offline one — see REAL_PROBE_WRAPPER for why live
// mode cannot be executed here at all.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A busy verdict in the shape the probe emits for a LIVE current viewport: the one
 * reachable busy reason, `screen_source` a current viewport, and the tracker class under
 * test. Every other field is the measured busy shape (`surface_detail: "working token"`,
 * `activity: "moving"`, no verify problems) the third review recorded for the real probe's
 * busy screens, so the only thing that varies between these cases is the tracker class.
 */
const LIVE_BUSY_PROBE_STUB = `
process.stdout.write(JSON.stringify({
  alive: true, ready: false, surface: 'working', activity: 'moving', cli: 'claude',
  detail: {
    health: 'CONNECTED', transport_ready: true, bootstrap_ready: true,
    ready_reason: process.env.LIVE_PROBE_REASON || 'current-busy-or-modal',
    screen_source: 'cmux:current-viewport', surface_detail: 'working token',
    tracker_class: process.env.LIVE_PROBE_TRACKER || 'prompt_observed',
    verify_started: true, verify_problems: [],
  },
}) + '\\n');
`;

/** One run whose readiness verdict is that live-shaped busy verdict. */
const armLiveBusy = (f: F, tracker: string, reason = LIVE_BUSY_REASON): NodeJS.ProcessEnv => ({
  ...arm(f),
  SESSION_PROBE_PY: f.script("probe-live-busy-stub", LIVE_BUSY_PROBE_STUB),
  LIVE_PROBE_TRACKER: tracker,
  LIVE_PROBE_REASON: reason,
});

// ── (s) r7/M1 the live busy reason, per tracker class, and nothing else ──────
describe("1270(s) r7/M1 the only reason production emits admits, and only it", () => {
  // Every class the probe can return for a busy screen that is not an approval or a broken
  // session. All three are live-reachable for a genuinely busy worker (measured by the third
  // review: `active` = active.txt, `prompt_observed` = a busy row with an empty composer,
  // `blank` = a busy composer followed by a footer row), so all three must deliver.
  for (const tracker of ADMITTED_TRACKERS) {
    test(`tracker_class ${tracker} with ready_reason current-busy-or-modal: admitted, exactly one bound send`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armLiveBusy(f, tracker));
        const es = entries(f);
        assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE,
          `the live busy reason must admit the bound path\n${r.stdout}\n${r.stderr}`);
        assert.equal(boundSends(es).length, 1, `one bound send\n${r.stdout}\n${r.stderr}`);
        assert.deepEqual(boundSends(es)[0]!.argv, expectedBoundArgv(f), "the exact frozen argv");
        assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], "never a legacy inject to a busy session");
        assert.deepEqual(keyWrites(es).map((e) => e.argv), [], "and never a key");
        assert.equal(r.status, 0, `accepted-pending exits 0\n${r.stderr}`);
        assert.match(r.stdout, /ACCEPTED_PENDING/);
      } finally { f.cleanup(); }
    });
  }

  // r7 m4: the guard is an ALLOW-list, so the two refused families stay refused AND a class
  // the probe does not emit today — the sixth-class case an exclusion would have admitted
  // into an input-writing path — is refused by default.
  for (const [tracker, why] of [
    ["welcome", "the approval/boot family (TRACKER_WELCOME, probe :129)"],
    ["error", "a broken session (TRACKER_ERR, probe :125-128)"],
    ["queued_input", "a class the probe does not emit today: unknown means refuse, not admit"],
  ] as const) {
    test(`tracker_class ${tracker} is refused even on the live busy reason (${why})`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armLiveBusy(f, tracker));
        assert.deepEqual(boundSends(entries(f)).map((e) => e.argv), [],
          `${why}: the bound path must stay closed\n${r.stdout}\n${r.stderr}`);
        assertNoInputEffect(f, `tracker_class ${tracker}`);
        assert.notEqual(r.status, 0, `and the dispatch must not report a delivery\n${r.stderr}`);
        assert.match(r.stderr, READY_TIMEOUT_LINE, "it falls back to the unchanged readiness wait");
      } finally { f.cleanup(); }
    });
  }

  // r7 m2/m3: the other three busy spellings. `current-working` is unreachable in BOTH probe
  // modes, `hard-negative` is the OFFLINE answer and carries no composer guarantee at all,
  // and `no-empty-current-prompt` IS the live composer refusal. None may admit, on a surface
  // that is otherwise fully qualified busy.
  for (const [reason, why] of [
    ["current-working", "unreachable: ready_by_current_screen answers current-busy-or-modal first (probe :491-493)"],
    ["hard-negative", "offline only: ready_by_screen never inspects the composer (probe :360-372)"],
    ["no-empty-current-prompt", "the live composer refusal itself (probe :486-488)"],
    ["prompt", "a ready composer is the legacy path's business"],
  ] as const) {
    test(`ready_reason ${reason} is NOT admitted on a busy surface (${why})`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armLiveBusy(f, "active", reason));
        assert.deepEqual(boundSends(entries(f)).map((e) => e.argv), [],
          `${reason}: only the live reason may admit\n${r.stdout}\n${r.stderr}`);
        assertNoInputEffect(f, `ready_reason ${reason}`);
        assert.notEqual(r.status, 0, `and the dispatch must not report a delivery\n${r.stderr}`);
      } finally { f.cleanup(); }
    });
  }

  test("control: the same stub with the live reason and an admitted tracker still delivers", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const r = follow(f, armLiveBusy(f, "active"));
      assert.equal(boundSends(entries(f)).length, 1,
        `without this control every refusal above would also hold for a caller that never delivers\n${r.stderr}`);
    } finally { f.cleanup(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// r8 ADDITIONS — the STRANDED COMPOSER is REPORTED to the operator, and never cleared
// (CLEAR-DESIGN.md §7, the caller half). Everything above this line is unchanged
// byte-for-byte: no existing case, assertion, stub, helper or constant is touched, and the
// shapes below are built from the SAME `closed()`/`envelope()`/`armR1()` seams, so the stub
// still only replays an envelope the test supplies.
//
// Each shape is pinned to the daemon line that produces it:
//   • the four strand reasons the delivery returns beside `stage: "outcome_unknown"` after the
//     body was handed over — telepty src/mailbox/delivery-runtime.js:1400-1403 (`strand()`),
//     called at :1404 (binding_changed_after_body), :1410 (admission_changed_after_body),
//     :1415 (submit_outcome_unknown), :1416 (submit_refused_after_body). `strand()` calls
//     strandIdentity → strandComposer (:1348-1349, :176-197), so one of these codes in an
//     answer PROVES the record exists;
//   • `composer_stranded` — boundAdmissionRefusal's code for an ALREADY stranded instance
//     (:1215), answered through `refuse()` (:1268) with `bytes_written: 0`, i.e. a pre-effect
//     refusal that transported nothing;
//   • `body_outcome_unknown` — the ONE outcome_unknown branch that deliberately does NOT
//     strand (:1389-1391), so it must print no block;
//   • the closed envelope's 11 keys and `bytes_written` 0-or-null: bound-inject.js:108-131.
// The identity values the block may use come from that same envelope (session_epoch/
// owner_generation/inject_id, re-bounded by parseBoundAnswer) and from the pin; the strand's
// own `at` and a refusal's stranded id are NOT in any envelope, which is why those print the
// read-only `telepty session <sid>` lookup instead.
// ═══════════════════════════════════════════════════════════════════════════════

/** A real inject-id shape (bound-inject.js:162 UUID_RE, the shape the record keeps at :192). */
const STRAND_ID = "3f2b8c1d-4e5a-4b6c-8d7e-9f0a1b2c3d4e";
/** The fresh id a LATER bound request mints (CLEAR-DESIGN.md §3.5) — never the stranded one. */
const FRESH_ID = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
/** The owner generation a reclaim minted: the DAEMON's current value, not the pin. */
const RECLAIMED_OWNGEN = "OWNGEN-reclaimed-a1b2";
/** The block's own headline, either knowledge level. */
const STRAND_BLOCK = /^STRANDED(?: \(ASSUMED\))?: /m;
/** The §7 placeholder-lookup line, printed only when a value is NOT in the answer. */
const LOOKUP_LINE = /is NOT in this answer — read it \(read-only, nothing is changed\) with:/;
/** The clear verb may never be SPAWNED, and may never be anything but printed text. */
const CLEAR_VERB = "clear-strand-v1";

/** An `outcome_unknown` answer carrying a strand reason: the delivery that STRANDED the pin. */
const strandedEnv = (reason: string, over: Partial<Closed> = {}): R1Answer =>
  envelope("outcome_unknown", reason, 500, closed({ stage: "outcome_unknown", reason,
    inject_id: STRAND_ID, body_stage: "sent_to_bridge", submit_stage: "not_sent",
    bytes_written: null, ...over }), 3);

/**
 * The §7 step-2 command as the operator would paste it: the three printed lines joined and the
 * backslash continuations removed. Returned as argv, so the assertions pin the FLAG NAMES,
 * their ORDER, the single `--` and the single positional — i.e. exactly what
 * parseClearStrandArgv requires (clear-strand-v1.js:51-90: one `--`, one positional,
 * `flags.length === 10`, known non-duplicate flags, no `--flag=value`).
 */
function clearArgv(stderr: string): string[] {
  const at = stderr.indexOf(`  2. telepty ${CLEAR_VERB} `);
  assert.ok(at >= 0, `the §7 step-2 clear command must be printed:\n${stderr}`);
  const joined = stderr.slice(at).split("\n").slice(0, 3).join(" ").replace(/\\ /g, " ");
  return joined.trim().replace(/^2\. telepty /, "").split(/\s+/);
}

/** The exact argv the block must print for these four values. */
const expectedClearArgv = (epoch: string, generation: string, injectId: string, sid = SID): string[] =>
  [CLEAR_VERB, "--from", "<operator-sid>", "--expected-epoch", epoch,
    "--expected-owner-generation", generation, "--stranded-inject-id", injectId,
    "--basis", "composer_emptied_by_operator", "--", sid];

/** The printed value of one field line of the block. */
function strandField(stderr: string, label: string): string {
  const m = new RegExp(`^  ${label}: *(\\S+)`, "m").exec(stderr);
  assert.ok(m !== null, `the block must carry a ${label} line:\n${stderr}`);
  return m[1]!;
}

/**
 * The invariant every case below shares: the helper PRINTS and nothing else. No clear verb is
 * spawned, no key/force write, no legacy inject, no second bound send — asserted on the stub's
 * own recorded argv list, plus the stub's catch-all refusal (it exits 97 and says
 * `refusing verb` for anything this contract does not allow, R1_TELEPTY_STUB:636-637).
 */
function assertPrintsOnly(f: F, r: SpawnSyncReturns<string>, note: string): void {
  const es = entries(f);
  assert.deepEqual(telepty(es).filter((e) => e.argv[0] === CLEAR_VERB).map((e) => e.argv), [],
    `${note}: the helper must NEVER run ${CLEAR_VERB} — the clear is an operator assertion`);
  assert.deepEqual(keyWrites(es).map((e) => e.argv), [], `${note}: no key/force write`);
  assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], `${note}: no legacy inject fallback`);
  assert.equal(boundSends(es).length, 1, `${note}: exactly one bound send, never a replay\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /refusing verb/,
    `${note}: no verb outside the allowed set was spawned\n${r.stderr}`);
  // The suggested command is TEXT on stderr only: it must not appear in any recorded argv.
  for (const e of es) {
    assert.ok(!e.argv.includes("--basis") && !e.argv.includes("--stranded-inject-id"),
      `${note}: a clear flag reached a real argv: ${JSON.stringify(e.argv)}`);
  }
}

// ── (t) §7 2a: the delivery that STRANDS reports the strand, HELD, exit 7 ────
describe("1270(t) §7/2a an outcome_unknown that stranded the pin prints the block and stays HELD", () => {
  test("binding_changed_after_body: the exact identity values, the HELD wording and the exact clear command", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The real shape of :1404: the owner RECLAIMED between the body and its CR, so the
      // daemon's own current owner_generation is a NEW one while the strand is keyed on the
      // epoch this delivery pinned (:1349 → :177).
      const overrides = armR1(f, strandedEnv("binding_changed_after_body",
        { owner_generation: RECLAIMED_OWNGEN }));
      const r = follow(f, overrides);
      // Exit code and marker unchanged: this is the existing held-unknown outcome.
      assert.equal(r.status, 7, `the held exit code is unchanged\n${r.stderr}`);
      assert.match(r.stderr, /DELIVERY_UNKNOWN/, "and so is the marker");
      assert.match(r.stderr, /binding_changed_after_body/, "the daemon's reason still travels");
      // The block itself.
      assert.match(r.stderr, STRAND_BLOCK, `the strand must be reported:\n${r.stderr}`);
      assert.match(r.stderr, /^STRANDED: router-fixture — the daemon recorded a stranded composer/m, r.stderr);
      assert.match(r.stderr, /no input is admitted for this session instance/, r.stderr);
      assert.ok(r.stderr.includes("  my dispatch is HELD and will not be replayed."),
        `§7's HELD line must be printed verbatim:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /provably UNSENT/, "a stranding delivery is not an unsent one");
      // The identity: the epoch is the PIN (the strand's own key), the generation is the
      // daemon's CURRENT one from the answer, the stranded id is the answer's inject_id.
      assert.equal(strandField(r.stderr, "session_epoch"), EPOCH);
      assert.equal(strandField(r.stderr, "owner_generation"), RECLAIMED_OWNGEN);
      assert.equal(strandField(r.stderr, "stranded_inject_id"), STRAND_ID);
      assert.match(r.stderr, /reason: binding_changed_after_body/, r.stderr);
      // Every value is known, so no placeholder and no lookup line is printed.
      assert.doesNotMatch(r.stderr, LOOKUP_LINE, `nothing is missing from this answer:\n${r.stderr}`);
      // The command, as argv: flag names, order, the single `--`, the single exact sid, and
      // `<operator-sid>` — never this helper's own --from.
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, RECLAIMED_OWNGEN, STRAND_ID));
      assert.ok(!clearArgv(r.stderr).includes(FROM),
        `the --from must stay the OPERATOR's placeholder, never the helper's sid:\n${r.stderr}`);
      // §7's two warnings and the never-clears statement.
      assert.match(r.stderr, /Do NOT `telepty attach` and press Enter/, r.stderr);
      assert.match(r.stderr, /empty it\n *yourself/, "step 1: the operator empties the composer");
      assert.match(r.stderr, /Re-read `telepty session router-fixture`/, "step 3: the read-only re-read");
      assert.match(r.stderr, /only a new child clears it — restart the worker/, "the bridge's own half");
      assert.match(r.stderr, /Alternative: re-register the session \(new epoch\)/, r.stderr);
      assert.match(r.stderr, /never clears, never sends a key and never replays/, r.stderr);
      // Nothing else changed: the record is the same held row it always was.
      const row = rows(f)[0]!;
      assert.equal(row.transport.result, "unknown", "never not_delivered while a body may exist");
      assert.equal(row.lifecycle.state, "delivery_state_unknown");
      assert.equal(boundObservation(f).verdict, "held:binding_changed_after_body");
      assertPrintsOnly(f, r, "2a binding_changed_after_body");
    } finally { f.cleanup(); }
  });

  test("submit_refused_after_body with NO inject id prints the literal `none` the clear verb accepts", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // delivery-runtime.js:178 stores `inject_id: validInjectId(injectId) ? injectId : null`,
      // and clear-strand-v1.js:45,:86,:100 spells that null `none` on the command line — which
      // clearStrandedComposer then matches strictly, `null === null` included (:242).
      const overrides = armR1(f, strandedEnv("submit_refused_after_body", { inject_id: null }));
      const r = follow(f, overrides);
      assert.equal(r.status, 7, `the held exit code is unchanged\n${r.stderr}`);
      assert.match(r.stderr, /DELIVERY_UNKNOWN/, r.stderr);
      assert.equal(strandField(r.stderr, "stranded_inject_id"), "none",
        `a strand with no inject id must print the literal none:\n${r.stderr}`);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, "none"));
      assert.match(r.stderr, /reason: submit_refused_after_body/, r.stderr);
      assert.ok(r.stderr.includes("  my dispatch is HELD and will not be replayed."), r.stderr);
      assertPrintsOnly(f, r, "2a submit_refused_after_body");
    } finally { f.cleanup(); }
  });

  for (const reason of ["admission_changed_after_body", "submit_outcome_unknown"] as const) {
    test(`${reason}: the same block, the same exit 7, the same single send`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armR1(f, strandedEnv(reason)));
        assert.equal(r.status, 7, `unchanged exit\n${r.stderr}`);
        assert.match(r.stderr, STRAND_BLOCK, `${reason} strands too (delivery-runtime.js:1410,:1415)\n${r.stderr}`);
        assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, STRAND_ID));
        assert.match(r.stderr, new RegExp(`reason: ${reason}`), r.stderr);
        assertPrintsOnly(f, r, reason);
      } finally { f.cleanup(); }
    });
  }
});

// ── (u) §7 2b: a later dispatch to an ALREADY stranded instance ─────────────
describe("1270(u) §7/2b a composer_stranded refusal is provably UNSENT, re-dispatchable after a clear", () => {
  test("the block says unsent — not HELD — and never prints THIS request's fresh inject id as the stranded one", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The pre-effect refusal of :1215 through :1268 — bytes_written 0, nothing transported.
      // Its `inject_id` is the id THIS request minted, not the strand's (CLEAR-DESIGN.md §3.5).
      const overrides = armR1(f, refusedEnv("composer_stranded", { inject_id: FRESH_ID }));
      const r = follow(f, overrides);
      // The existing proven-unsent outcome, unchanged.
      assert.equal(r.status, 3, `a proven-unsent refusal keeps exit 3\n${r.stderr}`);
      assert.match(r.stderr, /BOUND_INJECT_REFUSED/, "and its marker");
      assert.match(r.stderr, /composer_stranded/, "and names the reason");
      assert.match(r.stderr, /may be dispatched again/, "and the existing re-dispatch line stands");
      assert.equal(rows(f)[0]!.transport.result, "not_delivered", "nothing was written");
      // The block, with 2b's own wording.
      assert.match(r.stderr, /^STRANDED: router-fixture — this session instance was ALREADY stranded/m, r.stderr);
      assert.ok(r.stderr.includes(
        "  nothing was transported: my dispatch is provably UNSENT and may be re-dispatched AFTER a clear."),
      `2b must say unsent, not HELD:\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /my dispatch is HELD/, "nothing was transported, so nothing is held");
      // The identity: epoch and generation are known (a moved epoch/generation refuses before
      // the admission gate), the stranded id is NOT in a refusal envelope.
      assert.equal(strandField(r.stderr, "session_epoch"), EPOCH);
      assert.equal(strandField(r.stderr, "owner_generation"), OWNGEN);
      assert.equal(strandField(r.stderr, "stranded_inject_id"), "<uuid>",
        `a refusal carries THIS request's id, so the stranded id must be a placeholder:\n${r.stderr}`);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, "<uuid>"));
      assert.ok(!clearArgv(r.stderr).includes(FRESH_ID),
        `the fresh request id must never be suggested as the stranded id:\n${r.stderr}`);
      // …and the read-only lookup that DOES show it is printed instead.
      assert.match(r.stderr, LOOKUP_LINE, r.stderr);
      assert.match(r.stderr, /telepty session router-fixture {3}→ transport\.session_epoch/, r.stderr);
      assert.match(r.stderr, /transport\.stranded_composer\.inject_id/, r.stderr);
      assertPrintsOnly(f, r, "2b composer_stranded");
    } finally { f.cleanup(); }
  });

  test("the ref is still freed: the same dispatch may be sent again, and reports the strand again", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // Armed ONCE (arm() truncates the shared order log, see case (q)).
      const overrides = armR1(f, refusedEnv("composer_stranded", { inject_id: FRESH_ID }));
      const first = follow(f, overrides);
      assert.equal(first.status, 3, first.stderr);
      const again = follow(f, overrides);
      assert.equal(boundSends(entries(f)).length, 2,
        `a provably unsent ref stays re-dispatchable\n${again.stderr}`);
      assert.notEqual(again.status, 7,
        `and must not report DISPATCH_RETRY_HELD (case (j)'s own rule)\n${again.stderr}`);
      assert.match(again.stderr, STRAND_BLOCK, "and the strand is reported every time it is seen");
      assert.equal(rows(f).length, 2, "each attempt is its own record");
      assert.deepEqual(telepty(entries(f)).filter((e) => e.argv[0] === CLEAR_VERB).map((e) => e.argv), [],
        "two reports, zero clears");
    } finally { f.cleanup(); }
  });
});

// ── (v) §7: an outcome nobody can answer for must ASSUME the strand ─────────
describe("1270(v) §7 an unknown outcome assumes the strand, with only the values the helper has", () => {
  for (const [name, answer, reason] of [
    ["lost (no response)", lostEnv(), "outcome_unknown:response_unavailable"],
    ["unparseable answer", unparseableEnv(), "outcome_unknown:response_unparseable"],
  ] as const) {
    test(`${name}: the ASSUMED block, the pinned identity, exit 7 unchanged`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armR1(f, answer));
        assert.equal(r.status, 7, `the held exit code is unchanged\n${r.stderr}`);
        assert.match(r.stderr, /DELIVERY_UNKNOWN/, r.stderr);
        assert.match(r.stderr, /^STRANDED \(ASSUMED\): router-fixture — this delivery's outcome is unknown/m,
          `a lost answer cannot prove the strand path did NOT run:\n${r.stderr}`);
        assert.match(r.stderr, /must be assumed stranded until the view says otherwise/, r.stderr);
        // No daemon value exists, so the pin is all there is — and the pin IS the strand's key.
        assert.equal(strandField(r.stderr, "session_epoch"), EPOCH);
        assert.equal(strandField(r.stderr, "owner_generation"), OWNGEN);
        assert.equal(strandField(r.stderr, "stranded_inject_id"), "<uuid>");
        assert.match(r.stderr, new RegExp(`reason: ${reason}`), r.stderr);
        assert.match(r.stderr, LOOKUP_LINE, "the unknown id is looked up, never invented");
        assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, "<uuid>"));
        assert.ok(r.stderr.includes("  my dispatch is HELD and will not be replayed."), r.stderr);
        assertPrintsOnly(f, r, name);
      } finally { f.cleanup(); }
    });
  }

  test("an answer about ANOTHER session prints no foreign identity: the pin, and the lookup", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = armR1(f, acceptedEnv({ session_id: "some-other-session",
        session_epoch: "EPOCH-of-another-session", owner_generation: "OWNGEN-of-another-session",
        inject_id: FRESH_ID }));
      const r = follow(f, overrides);
      assert.equal(r.status, 7, `unchanged: an answer about another session is held\n${r.stderr}`);
      assert.match(r.stderr, /bound_session_identity_mismatch/, "the existing mismatch line stands");
      assert.match(r.stderr, /^STRANDED \(ASSUMED\): /m, r.stderr);
      // Not one field of the foreign answer may reach the block or its command.
      const argv = clearArgv(r.stderr);
      assert.deepEqual(argv, expectedClearArgv(EPOCH, OWNGEN, "<uuid>"));
      for (const foreign of ["some-other-session", "EPOCH-of-another-session", "OWNGEN-of-another-session", FRESH_ID]) {
        assert.ok(!argv.includes(foreign), `a foreign value reached the command: ${foreign}\n${r.stderr}`);
      }
      assertPrintsOnly(f, r, "foreign identity");
    } finally { f.cleanup(); }
  });
});

// ── (w) a hostile daemon value never reaches a line an operator may paste ───
describe("1270(w) a hostile daemon-supplied value is replaced by a placeholder, never printed", () => {
  // `boundedToken` (cli.ts:1182, mirroring bound-inject.js:35-39) bans control characters and
  // >256 bytes but ADMITS `$ ` ` ; ' "` and spaces, so the paste gate is a SECOND rule. Each row
  // says which value the block must show instead: `<generation>` when the hostile value reached
  // the gate, the safe PIN when parseBoundAnswer already dropped it to null.
  const hostile: Array<[string, string, string]> = [
    ["command substitution", 'OG$(touch /tmp/pwn)', "<generation>"],
    ["backticks", "OG`id`", "<generation>"],
    ["a command separator", "OG;rm -rf /", "<generation>"],
    ["quotes", `OG'"`, "<generation>"],
    ["a space", "OG and more", "<generation>"],
    // Dropped at parse: a control character and an over-long token are not bounded tokens, so
    // the answer asserts no generation at all and the pin stands.
    ["a forged newline", "OG\nSTRANDED: forged by the daemon", OWNGEN],
    ["over-long (300 bytes)", "O".repeat(300), OWNGEN],
  ];

  for (const [name, value, expected] of hostile) {
    test(`${name}: absent from the output, and the command shows ${expected}`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armR1(f, strandedEnv("submit_outcome_unknown", { owner_generation: value })));
        // stderr is where this helper composes its own lines. The daemon CLI's own stdout
        // envelope is tee'd through verbatim by injectBound (cli.ts:1420-1423) — pre-existing
        // behaviour this unit does not touch, and not a line anyone pastes.
        assert.ok(!r.stderr.includes(value), `the hostile value must never be printed:\n${r.stderr}`);
        assert.match(r.stderr, STRAND_BLOCK, `the report still happens\n${r.stderr}`);
        assert.equal(strandField(r.stderr, "owner_generation"), expected, r.stderr);
        assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, expected, STRAND_ID));
        // A dropped value takes the lookup path; a known pin needs none for the generation.
        if (expected === "<generation>") assert.match(r.stderr, LOOKUP_LINE, r.stderr);
        // The forged-line row is the sharp one: a daemon value may not fabricate a block.
        assert.equal(r.stderr.match(/^STRANDED/gm)!.length, 1,
          `exactly one STRANDED headline, never one a daemon value forged:\n${r.stderr}`);
        assert.equal(r.status, 7, `and the exit code is still the situation's own\n${r.stderr}`);
        assertPrintsOnly(f, r, name);
      } finally { f.cleanup(); }
    });
  }

  test("a bounded but non-UUID inject id is NOT suggested as the stranded id", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // `$(id)-not-a-uuid` passes boundedToken, so only the UUID shape the record and the clear
      // verb bound (bound-inject.js:162,:192; clear-strand-v1.js:86) keeps it out of the command.
      const r = follow(f, armR1(f, strandedEnv("submit_refused_after_body", { inject_id: "$(id)-not-a-uuid" })));
      assert.ok(!r.stderr.includes("$(id)"), r.stderr);
      assert.equal(strandField(r.stderr, "stranded_inject_id"), "<uuid>", r.stderr);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, "<uuid>"));
      assert.match(r.stderr, LOOKUP_LINE, r.stderr);
      assertPrintsOnly(f, r, "non-uuid inject id");
    } finally { f.cleanup(); }
  });

  test("an opaque-but-unpasteable PINNED token degrades to the lookup, and the send is unchanged", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The contract types these tokens as OPAQUE and case (l) proves `+ / = space ·` must be
      // DELIVERED unchanged; the paste gate is about one line, not about the delivery. The two
      // halves of case (l)'s pair fall differently and BOTH are right: `ep0ch+9f2c/1a7b==` is a
      // shell-safe bare word (shellQuote's own class, cli.ts:135) and is printed as itself,
      // while `owner gen 4b71·e0d3` is not and becomes the placeholder plus the lookup.
      const overrides = armR1(f, strandedEnv("binding_changed_after_body",
        { session_epoch: WIDE_EPOCH, owner_generation: WIDE_OWNGEN }),
      { epoch: WIDE_EPOCH, ownerGeneration: WIDE_OWNGEN });
      const r = follow(f, overrides);
      const es = entries(f);
      // Unchanged: the opaque token still travels as ONE argv element, byte for byte.
      assert.equal(boundSends(es).length, 1, r.stderr);
      assert.equal(boundSends(es)[0]!.argv[boundSends(es)[0]!.argv.indexOf("--expected-epoch") + 1], WIDE_EPOCH);
      assert.match(r.stderr, STRAND_BLOCK, r.stderr);
      assert.equal(strandField(r.stderr, "session_epoch"), WIDE_EPOCH, r.stderr);
      assert.equal(strandField(r.stderr, "owner_generation"), "<generation>", r.stderr);
      assert.ok(!r.stderr.includes(WIDE_OWNGEN), `an unpasteable token must not be printed:\n${r.stderr}`);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(WIDE_EPOCH, "<generation>", STRAND_ID));
      assert.match(r.stderr, LOOKUP_LINE, r.stderr);
      assertPrintsOnly(f, r, "unpasteable opaque pin");
    } finally { f.cleanup(); }
  });
});

// ── (x) the complement: a non-strand outcome prints no block at all ─────────
describe("1270(x) an accepted hand-off and an ordinary refusal print NO strand block", () => {
  const quiet: Array<[string, R1Answer, number]> = [
    ["accepted", acceptedEnv(), 0],
    ["refused: epoch_mismatch", refusedEnv("epoch_mismatch", { session_epoch: "EPOCH-moved-on" }), 3],
    ["refused: busy_input_unsupported", refusedEnv("busy_input_unsupported"), 3],
    ["refused: interaction_held", refusedEnv("interaction_held"), 3],
    ["schema-less 404 (nothing was sent)", unsupportedEnv(), 3],
    ["pre-socket local refusal", refusedLocallyEnv("non_canonical_daemon_host"), 3],
    // r1 CSR3-M1 — ONE row was removed from this table: `outcome_unknown: body_outcome_unknown`,
    // which asserted that NO block is printed, because the daemon of this unit's inputs installs
    // no record on an uncertain body write (delivery-runtime.js:1389-1391). Root is changing the
    // daemon so that answer DOES strand, so that expectation reverses: the row moved to 1270(y)
    // below, where it asserts the block, the HELD wording and the "may be empty" line. Every
    // other row here, and every assertion in the loop, is unchanged.
  ];

  for (const [name, answer, status] of quiet) {
    test(`${name}: no STRANDED block, no clear command, exit ${status} unchanged`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const r = follow(f, armR1(f, answer));
        assert.equal(r.status, status, `the existing exit code is unchanged\n${r.stderr}`);
        assert.doesNotMatch(r.stderr, STRAND_BLOCK, `${name} is not a strand:\n${r.stderr}`);
        assert.ok(!(r.stdout + r.stderr).includes(CLEAR_VERB),
          `${name} must not suggest a clear:\n${r.stdout}\n${r.stderr}`);
        assert.ok(!(r.stdout + r.stderr).includes("composer_emptied_by_operator"), r.stderr);
        assertPrintsOnly(f, r, name);
      } finally { f.cleanup(); }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// r1 ADDITIONS (Root review round 1). Everything above is unchanged except ONE removed row in
// 1270(x) (the expectation Root's CSR3-M1 decision reverses — see the comment in its place), and
// lines 1-1552 are still byte-identical to the phase-0 RED file.
//   CSR3-M1 — an uncertain BODY write strands too, after the daemon change Root decided. The
//             answer is an `outcome_unknown` whose reason is `body_outcome_unknown`, and the
//             record it installs does NOT mean the text arrived: the block must say the composer
//             may be empty. Driven by the production TABLE (cli.ts:1587-1599), so these cases
//             also pin the table's `false` rows against its `true` rows.
//   CSR3-m2 — only a FOREIGN-identity answer forces the pin; a same-session assumed answer uses
//             the daemon's reported owner_generation.
//   CSR3-m1 — the lookup hint's `null` wording.
//   CSR3-n3 — the clear's own refusals, named in the block.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The uncertain-BODY answer, with the daemon CLI's real envelope for it: the delivery returns
 * `{stage:'outcome_unknown', reason:'body_outcome_unknown', bodyStage:'unknown',
 * submitStage:'not_sent', bytesWritten:null}` (delivery-runtime.js:1389-1391), the route adds its
 * own identity and schema through the ONE builder (bound-inject.js:108-131), and the strict CLI
 * prints it as `{transport:'outcome_unknown', reason, http_status, result}` with EXIT.unknown = 3
 * (inject-bound-v1.js:119-125). After CSR3-M1 the same branch also calls `strandIdentity`, so the
 * reason names a record; the envelope on the wire is unchanged by that.
 */
const bodyUncertainEnv = (over: Partial<Closed> = {}): R1Answer =>
  envelope("outcome_unknown", "body_outcome_unknown", 500, closed({ stage: "outcome_unknown",
    reason: "body_outcome_unknown", inject_id: STRAND_ID, body_stage: "unknown",
    submit_stage: "not_sent", bytes_written: null, ...over }), 3);

/**
 * An `outcome_unknown` about OUR session whose reason the table does not list: the route's own
 * code for a delivery that threw (`delivery_threw`, in the daemon's allow-list at
 * bound-inject.js:53). The route file is not in this unit's inputs, which is exactly why this
 * answer is ASSUMED stranded rather than `recorded` — and why its reported owner_generation is
 * still OUR session's current one.
 */
const threwEnv = (over: Partial<Closed> = {}): R1Answer =>
  envelope("outcome_unknown", "delivery_threw", 500, closed({ stage: "outcome_unknown",
    reason: "delivery_threw", inject_id: STRAND_ID, body_stage: "unknown",
    submit_stage: "not_sent", bytes_written: null, ...over }), 3);

/** The CSR3-M1 line: the record exists, the text may not. */
const MAY_BE_EMPTY = "  the body MAY be in the composer — the write was uncertain, so an empty composer is possible.";

// ── (y) CSR3-M1: an uncertain body write is a reported strand whose composer may be empty ──
describe("1270(y) r1/CSR3-M1 an uncertain BODY write is reported, HELD, and says the composer may be empty", () => {
  test("body_outcome_unknown: the block, the HELD wording, the may-be-empty line, exit 7 unchanged", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const r = follow(f, armR1(f, bodyUncertainEnv()));
      // The exit code and the marker are the ones this answer already had in phase 1.
      assert.equal(r.status, 7, `an unknown outcome is still held at exit 7\n${r.stderr}`);
      assert.match(r.stderr, /DELIVERY_UNKNOWN/, "and the marker is unchanged");
      assert.match(r.stderr, /body_outcome_unknown/, "the daemon's reason still travels");
      // What CSR3-M1 reverses: this used to print nothing at all.
      assert.match(r.stderr, /^STRANDED: router-fixture — the daemon recorded a stranded composer/m,
        `after the daemon change this answer names an existing record:\n${r.stderr}`);
      assert.ok(r.stderr.includes("  my dispatch is HELD and will not be replayed."), r.stderr);
      assert.doesNotMatch(r.stderr, /provably UNSENT/, "a possibly-written body is not an unsent one");
      // The honest extra fact: the record is certain, the text is not.
      assert.ok(r.stderr.includes(MAY_BE_EMPTY),
        `the block must say the composer may be empty:\n${r.stderr}`);
      // …and the identity and the command are the ordinary `recorded` ones.
      assert.equal(strandField(r.stderr, "session_epoch"), EPOCH);
      assert.equal(strandField(r.stderr, "owner_generation"), OWNGEN);
      assert.equal(strandField(r.stderr, "stranded_inject_id"), STRAND_ID);
      assert.match(r.stderr, /reason: body_outcome_unknown/, r.stderr);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, STRAND_ID));
      const row = rows(f)[0]!;
      assert.equal(row.transport.result, "unknown", "never not_delivered while a body may exist");
      assert.equal(row.lifecycle.state, "delivery_state_unknown");
      assert.equal(boundObservation(f).verdict, "held:body_outcome_unknown");
      assertPrintsOnly(f, r, "body_outcome_unknown");
    } finally { f.cleanup(); }
  });

  test("delivery_threw_during_body: the other table row whose body is uncertain says it too", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // delivery-runtime.js:1429 strands on `bodyAttempted` alone — the write was entered and
      // never returned (:1322-1332), which is the same uncertainty by a different route.
      const r = follow(f, armR1(f, strandedEnv("delivery_threw_during_body")));
      assert.equal(r.status, 7, r.stderr);
      assert.match(r.stderr, /^STRANDED: /m, r.stderr);
      assert.ok(r.stderr.includes(MAY_BE_EMPTY), `the table drives this line, not a literal:\n${r.stderr}`);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, STRAND_ID));
      assertPrintsOnly(f, r, "delivery_threw_during_body");
    } finally { f.cleanup(); }
  });

  for (const reason of ["submit_refused_after_body", "delivery_threw_after_body"] as const) {
    test(`${reason}: the body IS there, so the may-be-empty line must NOT be printed`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        // The table's `true` rows: the write returned success before the failure
        // (delivery-runtime.js:1393), so telling the operator the composer may be empty would be
        // a weaker claim than the daemon's own record supports.
        const r = follow(f, armR1(f, strandedEnv(reason)));
        assert.match(r.stderr, /^STRANDED: /m, r.stderr);
        assert.ok(!r.stderr.includes(MAY_BE_EMPTY),
          `a handed-over body is not uncertain:\n${r.stderr}`);
        assert.ok(r.stderr.includes("  my dispatch is HELD and will not be replayed."), r.stderr);
        assertPrintsOnly(f, r, reason);
      } finally { f.cleanup(); }
    });
  }
});

// ── (z) CSR3-m2 / m1 / n3: the three accepted minors ────────────────────────
describe("1270(z) r1 minors: the pin is forced only for a foreign answer, the lookup names `null`, the clear's own refusals", () => {
  test("CSR3-m2: a SAME-SESSION assumed answer suggests the daemon's reported owner_generation", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // `delivery_threw` is about OUR session and carries the daemon's CURRENT generation, which a
      // reclaim has just changed — exactly when the pin is stale and the clear would be refused
      // 409 owner_generation_mismatch (CLEAR-INTERFACE-V1 §5 step 4.8).
      const r = follow(f, armR1(f, threwEnv({ owner_generation: RECLAIMED_OWNGEN })));
      assert.equal(r.status, 7, `unchanged: an unlisted unknown reason is held\n${r.stderr}`);
      assert.match(r.stderr, /^STRANDED \(ASSUMED\): /m, `and assumed stranded\n${r.stderr}`);
      assert.equal(strandField(r.stderr, "owner_generation"), RECLAIMED_OWNGEN,
        `the FRESHER reported value must be suggested, not the pin:\n${r.stderr}`);
      assert.equal(strandField(r.stderr, "session_epoch"), EPOCH, "the epoch is still the strand's key");
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, RECLAIMED_OWNGEN, "<uuid>"));
      assertPrintsOnly(f, r, "same-session assumed");
    } finally { f.cleanup(); }
  });

  test("CSR3-m2: a FOREIGN-identity answer still forces the pin, in the same shape", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The only difference from the case above is WHOSE session the answer names, and that alone
      // must decide whether the reported generation may be used at all.
      const r = follow(f, armR1(f, threwEnv({ session_id: "some-other-session",
        owner_generation: RECLAIMED_OWNGEN })));
      assert.equal(r.status, 7, r.stderr);
      assert.match(r.stderr, /^STRANDED \(ASSUMED\): /m, r.stderr);
      assert.match(r.stderr, /bound_session_identity_mismatch/, "the existing mismatch line stands");
      assert.equal(strandField(r.stderr, "owner_generation"), OWNGEN,
        `another session's generation may never be suggested for ours:\n${r.stderr}`);
      assert.ok(!r.stderr.includes(RECLAIMED_OWNGEN), r.stderr);
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, "<uuid>"));
      assertPrintsOnly(f, r, "foreign assumed");
    } finally { f.cleanup(); }
  });

  test("CSR3-m1: the lookup hint says a `null` inject_id in the view means the literal `none`", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // The view always EMITS the key (delivery-runtime.js:1939 `inject_id: strand.inject_id`), so
      // the operator reads `"inject_id": null` — and passing the string `null` is refused
      // `stranded_inject_id_invalid` (clear-strand-v1.js:86).
      const r = follow(f, armR1(f, refusedEnv("composer_stranded", { inject_id: FRESH_ID })));
      assert.match(r.stderr, LOOKUP_LINE, r.stderr);
      assert.ok(r.stderr.includes(
        "        transport.stranded_composer.inject_id (`null` there ⇒ the literal `none`), .reason, .at"),
      `the hint must name the value the view really shows:\n${r.stderr}`);
      assert.ok(!r.stderr.includes("absent there"), `the old wording must be gone:\n${r.stderr}`);
      assertPrintsOnly(f, r, "lookup wording");
    } finally { f.cleanup(); }
  });

  test("CSR3-n3: the block names the clear's own refusals and what to do about each", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      // CLEAR-INTERFACE-V1 §5 steps 4.2, 4.3, 4.7 and 4.9 can refuse the very strand this block
      // describes, and the operator meets them only after pasting the command.
      const r = follow(f, armR1(f, bodyUncertainEnv()));
      assert.match(r.stderr, /Refused `session_closing`\/`handoff_active`\?/, r.stderr);
      assert.match(r.stderr, /wait, re-read the view, and if its epoch has moved the strand is already inert/, r.stderr);
      assert.match(r.stderr, /Refused\n? *`owner_disconnected`\/`owner_generation_unavailable`\?/, r.stderr);
      assert.match(r.stderr, /the owner bridge is gone — reconnect it/, r.stderr);
      // The guidance is prose BETWEEN step 2 and step 3: it may not disturb the pasteable command.
      assert.deepEqual(clearArgv(r.stderr), expectedClearArgv(EPOCH, OWNGEN, STRAND_ID));
      assert.match(r.stderr, /  3\. Re-read `telepty session router-fixture`/, r.stderr);
      assertPrintsOnly(f, r, "clear refusals named");
    } finally { f.cleanup(); }
  });
});
