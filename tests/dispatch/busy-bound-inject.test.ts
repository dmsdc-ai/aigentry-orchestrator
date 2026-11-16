// task1270 — caller-side RED for bound busy delivery (`telepty inject-bound-v1`).
//
// WHY THIS FILE IS RED ON PURPOSE. src/dispatch/cli.ts main() waits for an idle,
// empty-composer REPL before every non-dedup delivery (cli.ts:1434-1439 →
// waitForReady → isReady → bin/session-probe.py), and a qualified current-busy
// session can never satisfy that (session-probe.py:472-494: `working` →
// `current-working`, a populated composer → `no-empty-current-prompt`). So a
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
  ready_reason: process.env.PROBE_READY_REASON || 'current-working',
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

/** bin/dispatch-verify.sh itself, with a zero settle so the 6s wait is not paid. */
function runVerify(f: F, args: string[], overrides: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
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
        // NOOP/verified (bin/dispatch-verify.sh:80-96). Both legs exit 0, so the base
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
 */
const REAL_PROBE_WRAPPER = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(process.env.REAL_PROBE_CONFIG, 'utf8'));
fs.appendFileSync(process.env.BOUND_ORDER_LOG, JSON.stringify({ who: 'probe', argv: process.argv.slice(2) }) + '\\n');
const r = spawnSync(cfg.python, [cfg.probe, ...process.argv.slice(2),
  '--screen-file', cfg.screen, '--info-file', cfg.info, '--telepty', 'telepty'], { encoding: 'utf8' });
if (r.stdout) process.stdout.write(r.stdout);
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

/**
 * Arm one dispatch whose readiness verdict comes from the REAL probe reading `screen`.
 * `screen` is either a path under tests/dispatch/fixtures (a measured capture) or inline
 * screen text, which is written into the fixture root.
 */
function armRealProbe(f: F, screen: { file: string } | { text: string }, answer: R1Answer = acceptedEnv()): NodeJS.ProcessEnv {
  const base = armR1(f, answer);
  const screenPath = "file" in screen ? join(SCREENS, screen.file) : join(f.root, "r4-screen.txt");
  if ("text" in screen) writeFileSync(screenPath, screen.text);
  const infoPath = join(f.root, "r4-info.json");
  writeFileSync(infoPath, JSON.stringify(LIVE_INFO));
  const configFile = join(f.root, "r4-probe.json");
  writeFileSync(configFile, JSON.stringify({ python: PYTHON, probe: REAL_PROBE, screen: screenPath, info: infoPath }));
  return { ...base, TELEPTY: f.script("telepty-r4-stub", R4_TELEPTY_STUB),
    SESSION_PROBE_PY: f.script("probe-real-wrapper", REAL_PROBE_WRAPPER), REAL_PROBE_CONFIG: configFile };
}

const probeReads = (es: Entry[]) => es.filter((e) => e.who === "probe");
const listReads = (es: Entry[]) => telepty(es).filter((e) => e.argv[0] === "list");

// Inline screens for the two shapes no measured fixture carries. Both are claude viewports.
/** A working-looking row with NO live-work affordance: no `(esc to interrupt)`, no spinner. */
const WORKING_NO_AFFORDANCE = "reading bin/dispatch.sh\n\n■ Working... (12s)\n ❯ \n";
/** A busy row AND an approval prompt: the modal family must win over a genuine busy glyph. */
const BUSY_WITH_ENTER_PROMPT = "analyzing\n\n◉ Working... (5s · esc to interrupt)\nPress Enter to continue\n ❯ \n";
/** Busy with the composer already carrying a staged context-ref (UNSUBMITTED, probe :105). */
const BUSY_WITH_UNSUBMITTED = "analyzing\n\n◉ Working... (5s · esc to interrupt)\n ❯ [context-ref] Read /tmp/shared/abcdef123456.md\n";

// ── (o) the REAL probe decides the admission (B1 / decision 2) ───────────────
describe("1270(o) r4/B1 the admission is decided by the REAL bin/session-probe.py", () => {
  for (const [name, screen] of [
    // Measured captures, both genuinely busy: a braille spinner + `(esc to interrupt)` with
    // an empty composer, and the `◉ Working... (5s · esc to interrupt)` row.
    ["measured busy claude (spinner + esc-to-interrupt + empty composer)", { file: "active.txt" }],
    ["measured busy claude (working row, no composer line)", { file: "working_active.txt" }],
  ] as const) {
    test(`${name}: admitted, exactly one bound send`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = armRealProbe(f, screen);
        const r = follow(f, overrides);
        const es = entries(f);
        // This is the regression the blocker named: on the r2/r3 predicate the real probe's
        // verdict (ready_reason `hard-negative` offline, `current-busy-or-modal` live) never
        // matched `current-working`, so NOTHING was ever delivered and this assertion failed.
        assert.doesNotMatch(r.stderr, READY_TIMEOUT_LINE,
          `the real probe's busy verdict must admit the bound path\n${r.stdout}\n${r.stderr}`);
        assert.equal(boundSends(es).length, 1, `one bound send\n${r.stdout}\n${r.stderr}`);
        assert.deepEqual(boundSends(es)[0]!.argv, expectedBoundArgv(f), "the exact frozen argv");
        assert.deepEqual(legacyInjects(es).map((e) => e.argv), [], "never a legacy inject to a busy session");
        assert.deepEqual(keyWrites(es).map((e) => e.argv), [], "and never a key");
        assert.equal(r.status, 0, `accepted-pending exits 0\n${r.stderr}`);
        assert.match(r.stdout, /ACCEPTED_PENDING/);
      } finally { f.cleanup(); }
    });
  }

  for (const [name, screen, why] of [
    ["measured trust-folder modal", { file: "trust_folder_modal.txt" }, "surface=modal (TRUST_MODAL, probe :73)"],
    ["busy glyph + Press Enter to continue", { text: BUSY_WITH_ENTER_PROMPT }, "the modal reader wins over a busy glyph"],
    ["working word with no live-work affordance", { text: WORKING_NO_AFFORDANCE }, "tracker_class is not `active`"],
    ["busy with an unsubmitted context-ref in the composer", { text: BUSY_WITH_UNSUBMITTED }, "surface=unsubmitted"],
  ] as const) {
    test(`${name}: NOT admitted (${why}), nothing sent, nothing recorded`, () => {
      const f = fixture();
      try {
        f.prepareTarget();
        const overrides = armRealProbe(f, screen);
        const r = follow(f, overrides);
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
      const r = follow(f, armR1(f, contradiction));
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
      const again = follow(f, armR1(f, contradiction));
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
