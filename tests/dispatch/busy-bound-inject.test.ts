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
