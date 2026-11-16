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
  return found[0]!;
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

// ── (j) the proven-unsent branch, and its complement (M4) ───────────────────
describe("1270(j) r1/M4 an answer that PROVES nothing was written frees the ref", () => {
  const unsentCases: Array<[string, R1Answer, string]> = [
    // Two distinct REAL refusal reasons from the route's own order (session-actions.js:1939,
    // :1946), both 4xx — on this route 4xx means nothing was written (API-MAP §1).
    ["closed refused: epoch_mismatch", refusedEnv("epoch_mismatch", { session_epoch: "EPOCH-moved-on" }), "epoch_mismatch"],
    ["closed refused: busy_input_unsupported", refusedEnv("busy_input_unsupported"), "busy_input_unsupported"],
    // The two shapes that prove it without reaching the daemon at all.
    ["schema-less 404 (route unsupported)", unsupportedEnv(), "unsupported"],
    ["pre-socket local refusal", refusedLocallyEnv("non_canonical_daemon_host"), "refused_locally"],
  ];

  for (const [name, answer, reason] of unsentCases) {
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
function policyStub(f: F, action: "RESUBMIT_ENTER" | "ESCALATE"): string {
  return f.script(`policy-${action.toLowerCase()}`, `
process.stdout.write(JSON.stringify({ action: ${JSON.stringify(action)}, key: 'enter',
  reason: 'no working spinner (idle/static) [not-moving]', status: 'not_started' }) + '\\n');
`);
}

/** bin/dispatch-verify.sh itself, with a zero settle so the 6s wait is not paid. */
function runVerify(f: F, args: string[], overrides: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync("bash", [VERIFY_SH, SID, "--settle-ms", "0", ...args],
    { cwd: f.root, env: { ...f.env, ...overrides }, encoding: "utf8", timeout: 40000 });
}

describe("1270(m) r1/M6 the verify resubmit is observe-only for busy and policy-controlled otherwise", () => {
  test("--resubmit --observe-only on a [not-moving] verdict sends NO key (deleting the observe_only guard fails this)", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = { ...arm(f), POLICY_PY: policyStub(f, "RESUBMIT_ENTER") };
      const r = runVerify(f, ["--resubmit", "--observe-only"], overrides);
      // Everything the resubmit branch keys on is TRUE here except observe_only: the verdict
      // is rc 6, --resubmit is set, the marker is present and the policy asks for the Enter.
      assert.match(r.stdout, /\[not-moving\]/, `the marker the branch keys on is present\n${r.stderr}`);
      assert.equal(r.status, 6, `and the verdict reached the branch (the rc capture works)\n${r.stderr}`);
      assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [],
        "a busy-admitted (observe-only) verification must never send a key");
      assert.doesNotMatch(r.stdout, /VERIFIED/, "and never reports a fresh verification");
    } finally { f.cleanup(); }
  });

  test("--resubmit with the policy answering ESCALATE (surface=working) sends NO key and says why (deleting policy_wants_enter fails this)", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = { ...arm(f), POLICY_PY: policyStub(f, "ESCALATE") };
      const r = runVerify(f, ["--resubmit"], overrides);
      assert.match(r.stdout, /\[not-moving\]/, `the marker alone must not be enough\n${r.stderr}`);
      assert.equal(r.status, 6, r.stderr);
      assert.deepEqual(keyWrites(entries(f)).map((e) => e.argv), [],
        "a marker-triggered Enter into a current_busy composer is exactly what the guard prevents");
      assert.match(r.stdout, /did not answer RESUBMIT_ENTER/, "and the skip is announced, not silent");
    } finally { f.cleanup(); }
  });

  test("--resubmit with the policy answering RESUBMIT_ENTER still performs the legitimate #412 recovery, exactly once", () => {
    const f = fixture();
    try {
      f.prepareTarget();
      const overrides = { ...arm(f, {}, { PROBE_SURFACE: "unsubmitted", PROBE_READY_REASON: "no-empty-current-prompt" }),
        POLICY_PY: policyStub(f, "RESUBMIT_ENTER") };
      const r = runVerify(f, ["--resubmit"], overrides);
      const keys = keyWrites(entries(f));
      assert.equal(keys.length, 1, `the idle recovery must still happen\n${r.stdout}\n${r.stderr}`);
      assert.deepEqual(keys[0]!.argv, ["send-key", SID, "enter"], "and it is the one documented Enter");
      assert.match(r.stdout, /submit-resend/, "announced as the #412 resend");
    } finally { f.cleanup(); }
  });
});
