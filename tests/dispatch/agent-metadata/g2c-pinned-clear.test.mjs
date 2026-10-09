// #1162 pinned agent-metadata clear — REAL compiled G2b reader (dist/src/session/agent-binding.js),
// REAL wh-cli.sh → workspace-host.sh → compiled agent-metadata.js transport, and the REAL compiled
// cleanup CLI (dist/src/cleanup/cli.js), against REAL sealed-binding fixtures.
//
// Every host actuator is a recorder: support/pinned-clear-cmux.mjs (CMUX and PATH cmux) and
// support/pinned-clear-actuators.mjs behind per-run wrappers (PATH telepty/curl/ps, KILL_CMD,
// CLEANUP_PS_CMD, DISPATCH_REGISTRY_PY). HOME/TMPDIR/AIGENTRY_SESSIONS_ROOT are private and the
// harness tripwire (exit 97) is asserted empty in every case. No real kill is ever executed:
// the legacy kill is observed only as the recorder argv `kill -TERM 5000`.
//
// The legacy teardown (exit, stdout, stderr and the ordered telepty/kill/close/DELETE/registry
// calls) is pinned by EXPLICIT expectations below, not by a baseline checkout: the new clear
// may add only its own `[session-cleanup] agent-meta …` line, its own cmux capabilities/rpc
// calls and exactly one ps snapshot when the veto reaches it.
//
// Scope: display-only. Host answers are fake; these cases prove only how the adapter and the
// cleanup CLI map them. Nothing here claims uninterrupted ownership across an ABA sequence.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BIN, DIST, hermeticEnv, makeRun, privDir, sealedFixture, sh, writePriv } from "./support/harness.mjs";

const FAKE_CMUX = fileURLToPath(new URL("./support/pinned-clear-cmux.mjs", import.meta.url));
const ACTUATORS = fileURLToPath(new URL("./support/pinned-clear-actuators.mjs", import.meta.url));
const READER = path.join(DIST, "src/session/agent-binding.js");
const CLEANUP = path.join(DIST, "src/cleanup/cli.js");
const WH = path.join(BIN, "wh-cli.sh");
const NODE = process.execPath;
const SID = "w1162-cl";
const CLEAR = "surface.agent_metadata.clear";
const SET = "surface.agent_metadata.set";
const WS = "0e116200-0000-4000-8000-0000000000aa";
const PORT = "59999";

const A_IDS = { attempt: "a1162000-0000-4000-8000-00000000000a", workspace_id: "a1162000-0000-4000-8000-0000000000a1",
  surface_id: "a1162000-0000-4000-8000-0000000000a2", terminal_lifecycle_id: "a1162000-0000-4000-8000-0000000000a3" };
const B_IDS = { attempt: "b1162000-0000-4000-8000-00000000000b", workspace_id: "b1162000-0000-4000-8000-0000000000b1",
  surface_id: "b1162000-0000-4000-8000-0000000000b2", terminal_lifecycle_id: "b1162000-0000-4000-8000-0000000000b3" };
// Rebinding: same attempt/hash as A, new surface/lifecycle.
const R_IDS = { surface_id: "c1162000-0000-4000-8000-0000000000c2", terminal_lifecycle_id: "c1162000-0000-4000-8000-0000000000c3" };
const A_TUPLE = { surface_id: A_IDS.surface_id, terminal_lifecycle_id: A_IDS.terminal_lifecycle_id, sid: SID, attempt: A_IDS.attempt };

const caps = (methods = ["system.capabilities", "surface.list", SET, CLEAR]) =>
  JSON.stringify({ protocol: "cmux-socket", version: 2, socket_path: "/fixture/cmux.sock", access_mode: "cmuxOnly",
    capabilities: { terminal: true }, methods: [...methods].sort() }) + "\n";

// ── fixtures ────────────────────────────────────────────────────────────────
function fixReceipt(F, supervisorPid, childPid) {
  writePriv(path.join(F.root, "receipt.json"), JSON.stringify({ state: "running", hash: F.hash, attempt: F.attempt,
    supervisorPid, childPid, checkedAt: "2026-09-28T00:00:00Z" }));
}

/** Stage with attempt B sealed first, then A (current → A). Saved copies allow in-place swaps. */
function world(run, { S = 5001, C = 5002, receipt } = {}) {
  const sessions = privDir(path.join(run.dir, "sessions"));
  const stage = path.join(sessions, SID);
  const B = sealedFixture(run, { sid: SID, stage, ...B_IDS });
  fixReceipt(B, 6001, 6002);
  const save = (name, from) => { const p = path.join(run.dir, name); fs.writeFileSync(p, fs.readFileSync(from)); return p; };
  const currentB = save("currentB.json", B.current);
  const A = sealedFixture(run, { sid: SID, stage, ...A_IDS });
  if (receipt === undefined) fixReceipt(A, S, C);
  else writePriv(path.join(A.root, "receipt.json"), JSON.stringify(receipt(A)));
  const currentA = save("currentA.json", A.current);
  const bindingA = save("bindingA.json", A.bindingFile);
  const bindingA2 = path.join(run.dir, "bindingA2.json");
  fs.writeFileSync(bindingA2, JSON.stringify({ ...JSON.parse(fs.readFileSync(A.bindingFile, "utf8")), ...R_IDS }) + "\n");
  return { sessions, stage, A, B, currentA, currentB, bindingA, bindingA2, current: A.current };
}

const pinOf = (F, over = {}) => ({ attempt: F.attempt, hash: F.hash, surface: F.ids.surface_id,
  lifecycle: F.ids.terminal_lifecycle_id, ...over });
const pinArgs = (p) => ["--expect-attempt", p.attempt, "--expect-hash", p.hash, "--expect-surface", p.surface,
  "--expect-lifecycle", p.lifecycle];

const reader = (run, args) => sh(NODE, [READER, ...args], { env: hermeticEnv(run), timeout: 20000 });

function wrapper(run, name, who) {
  const p = path.join(run.fakes, name);
  // #1214: curl reads stdin only when told to (`-H @-`), as real curl does; what it read is recorded.
  const stdin = who === "curl"
    ? `for a in "$@"; do if [ "$a" = "@-" ]; then cat >> '${path.join(run.logs, "curl-stdin.log")}'; break; fi; done\n`
    : "";
  fs.writeFileSync(p, `#!/bin/sh\n${stdin}exec '${NODE}' '${ACTUATORS}' ${who} "$@"\n`, { mode: 0o755 });
  return p;
}

const ROW = { id: SID, command: "claude", healthStatus: "CONNECTED", ownerPid: 5000, cmuxWorkspaceId: WS };
const OTHER = { id: "other-sid", command: "codex", healthStatus: "CONNECTED", ownerPid: 7000 };
const PS_HDR = ["  PID  PPID COMMAND", "    1     0 /sbin/launchd", " 9000     1 node cleanup-self-fixture"];
const PS_O = ` 5000     1 node /fixture/cli.js telepty allow --id ${SID} claude`;
const PS_S = " 5001  5000 node /fixture/worker-sandbox-runner.js";
const PS_C = " 5002  5001 claude --fixture";
const PS_OTHER = " 7000     1 node /fixture/cli.js telepty allow --id other-sid codex";
const psTable = (rows) => [...PS_HDR, ...rows, ""].join("\n");

/** Recorder fakes + env for one run. `ps` in PATH is a fail-closed recorder too. */
function rig(run, w, { cmux = {}, fakes = {}, list, ps } = {}) {
  const seqLog = path.join(run.logs, "seq.jsonl");
  fs.writeFileSync(seqLog, "");
  const listFile = path.join(run.dir, "list.json");
  fs.writeFileSync(listFile, JSON.stringify(list ?? [ROW, OTHER]));
  const psFile = path.join(run.dir, "ps.txt");
  fs.writeFileSync(psFile, ps ?? psTable([PS_O, PS_S, PS_C, PS_OTHER]));
  const fakeScen = path.join(run.dir, "fakes.json");
  fs.writeFileSync(fakeScen, JSON.stringify({
    telepty: { match: [{ argv0: "list", stdoutFile: listFile }], ...fakes.telepty },
    ps: { stdoutFile: psFile, ...fakes.ps },
    "ps-path": { rc: 97 },
    curl: { stdout: "200" },
    kill: { rc: 0 },
    registry: { rc: 0 },
    ...(fakes.whcli ? { whcli: fakes.whcli } : {}),
  }));
  const cmuxScen = path.join(run.dir, "cmux.json");
  fs.writeFileSync(cmuxScen, JSON.stringify({
    capabilities: { stdout: caps() },
    [`rpc:${CLEAR}`]: { stdout: JSON.stringify({ status: "cleared" }) },
    "close-workspace": { rc: 0 },
    ...cmux,
  }));
  wrapper(run, "telepty", "telepty");
  wrapper(run, "curl", "curl");
  wrapper(run, "ps", "ps-path");
  const psCmd = wrapper(run, "ps-fake", "ps");
  const killCmd = wrapper(run, "kill-fake", "kill");
  const reg = wrapper(run, "registry-fake", "registry");
  const cmuxBin = path.join(run.fakes, "cmux");
  fs.writeFileSync(cmuxBin, `#!/bin/sh\nexec '${NODE}' '${FAKE_CMUX}' "$@"\n`, { mode: 0o755 });
  const env = (extra = {}) => hermeticEnv(run, {
    AIGENTRY_SESSIONS_ROOT: w.sessions, AIGENTRY_WORKSPACE_HOST: "cmux", CMUX: cmuxBin,
    CLEANUP_PS_CMD: psCmd, KILL_CMD: killCmd, CLEANUP_SELF_PID: "9000", DISPATCH_REGISTRY_PY: reg,
    TELEPTY_PORT: PORT, ORCHESTRATOR_SID: "orch-fixture",
    PINNED_CLEAR_SEQ_LOG: seqLog, PINNED_CLEAR_FAKE_SCENARIO: fakeScen, PINNED_CLEAR_CMUX_SCENARIO: cmuxScen, ...extra,
  });
  const seq = () => fs.readFileSync(seqLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { env, seq };
}

function assertConfined(run, seq) {
  assert.equal(run.tripwireHits(), "", `tripwire hit: ${run.tripwireHits()}`);
  assert.deepEqual(seq.filter((e) => e.who === "ps-path"), [], "no PATH ps");
}

/**
 * #1214: every curl goes through the shared door — the header from stdin (`-H @-`), the fixed
 * bounds, no credential in argv. The private HOME holds no token, so stdin must stay EMPTY: the
 * degraded shape is "no credential presented" (it was an empty-valued `-H 'x-telepty-token: '`).
 */
function assertCurlDoor(run, seq) {
  const last = (a, names) => { let v; a.forEach((x, i) => { if (names.includes(x)) v = a[i + 1]; }); return v; };
  for (const { argv: a } of seq.filter((e) => e.who === "curl")) {
    assert.ok(!a.some((x) => /x-telepty-token/i.test(x)), `curl argv names the credential header: ${JSON.stringify(a)}`);
    assert.ok(a.some((x, i) => x === "-H@-" || ((x === "-H" || x === "--header") && a[i + 1] === "@-")),
      `curl was not told to read its header from stdin (-H @-): ${JSON.stringify(a)}`);
    assert.equal(last(a, ["--max-time", "-m"]), "5", `curl --max-time is not 5: ${JSON.stringify(a)}`);
    assert.equal(last(a, ["--connect-timeout"]), "2", `curl --connect-timeout is not 2: ${JSON.stringify(a)}`);
  }
  const stdin = path.join(run.logs, "curl-stdin.log");
  assert.equal(fs.existsSync(stdin) ? fs.readFileSync(stdin, "utf8") : "", "", "a credential was presented with no token configured");
}

/** #1214: the caller's own curl args, in order, without the door's `-H @-` and bounds (assertCurlDoor pins those). */
function curlCaller(argv) {
  const own = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-H@-") continue;
    if ((argv[i] === "-H" || argv[i] === "--header") && argv[i + 1] === "@-") { i++; continue; }
    if (["--connect-timeout", "--max-time", "-m"].includes(argv[i])) { i++; continue; }
    own.push(argv[i]);
  }
  return own;
}

/** Run the compiled cleanup CLI against a fresh world. */
function cleanup(label, o = {}) {
  const run = makeRun(label);
  const w = world(run, o.world ?? {});
  const extra = o.rig ? o.rig(w) : {};
  const r = rig(run, w, { ...o, ...extra, fakes: { ...o.fakes, ...extra.fakes } });
  let extraEnv = o.env ?? {};
  if (o.whcli) {
    // Only the clear door is replaced; every other wh-cli verb stays the real script.
    const wrap = privDir(path.join(run.dir, "binwrap"));
    fs.symlinkSync(path.join(BIN, "lib"), path.join(wrap, "lib"));
    fs.writeFileSync(path.join(wrap, "wh-cli.sh"),
      `#!/bin/sh\nif [ "$1" = agent-meta-clear ]; then exec '${NODE}' '${ACTUATORS}' whcli "$@"; fi\nexec '${WH}' "$@"\n`, { mode: 0o755 });
    extraEnv = { ...extraEnv, AIGENTRY_SHIM_SCRIPT_DIR: wrap };
  }
  const res = sh(NODE, [CLEANUP, ...(o.args ?? [SID])], { env: r.env(extraEnv), timeout: 90000 });
  const seq = r.seq();
  assertConfined(run, seq);
  assertCurlDoor(run, seq);
  return { ...res, seq, w, run };
}

const isMeta = (l) => l.startsWith("[session-cleanup] agent-meta ");
const isMetaCall = (e) => e.who === "cmux" && (e.argv[0] === "capabilities" || e.argv[0] === "rpc");
const psCount = (r) => r.seq.filter((e) => e.who === "ps").length;
const rpcCalls = (r) => r.seq.filter((e) => e.who === "cmux" && e.argv[0] === "rpc");
const metaCalls = (r) => r.seq.filter(isMetaCall);
const metaLines = (r) => r.stdout.split("\n").filter(isMeta);
const line = (tail) => `[session-cleanup] agent-meta ${tail}`;

/** The observed legacy flow with only the new clear's own output removed. */
function legacyView(r) {
  return {
    status: r.status,
    stdout: r.stdout.split("\n").filter((l) => !isMeta(l)),
    stderr: r.stderr,
    seq: r.seq.filter((e) => !isMetaCall(e) && e.who !== "ps" && e.who !== "whcli")
      .map((e) => [e.who, ...(e.who === "curl" ? curlCaller(e.argv) : e.argv)]),
  };
}

// ── explicit legacy expectations (release behaviour of cleanupOne) ────────────
const L = (msg) => `[session-cleanup] ${msg}`;
// #1214: the credential header is no longer a curl argument (assertCurlDoor pins the stdin door).
const DELETE = (sid) => ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "DELETE",
  `http://127.0.0.1:${PORT}/api/sessions/${sid}`];
const REGISTRY = (sid) => [["registry", "observe", "--sid", sid, "--kind", "session_absent_observed", "--all"],
  ["registry", "set-lifecycle", "--sid", sid, "--state", "cleaned", "--all"]];
const REFUSE_KILL = (sid) => `ERR refusing to SIGTERM PID 5000 for ${sid} — it is in the orchestrator's own process tree; this session was spawned surface-less (forbidden). Close it from the user's terminal.\n`;

/**
 * Normal (listed) arm. kill: "killed" | "no-parent" | "refused"; close: "ok" | "fail".
 * Returns the legacy view plus the legacy ps-snapshot count (kill needle + self/ancestor).
 */
function legacy({ sid = SID, kill = "killed", close = "ok" } = {}) {
  const stdout = [];
  let stderr = "";
  const seq = [["telepty", "list", "--json"]];
  if (kill === "killed") { stdout.push(L(`killed parent telepty-allow PID 5000 for ${sid}`)); seq.push(["kill", "-TERM", "5000"]); }
  if (kill === "no-parent") stdout.push(L(`no parent telepty-allow process for ${sid} (already exited?)`));
  if (kill === "refused") stderr += REFUSE_KILL(sid);
  seq.push(["cmux", "close-workspace", "--workspace", WS]);
  if (close === "ok") stdout.push(L(`workspace host closed: ${sid} (${WS})`));
  else {
    stdout.push(L(`workspace host close failed for ${sid} (${WS}): release UNCONFIRMED — neither release nor retention was observed [close-refused]`));
    stderr += `ERR workspace host close non-zero for ${sid} (${WS}) [close-refused]\n`;
    seq.push(["cmux", "sidebar-state", "--workspace", WS]);
  }
  stdout.push(L(`DELETE /api/sessions/${sid} → 200 (removed from registry)`), "");
  seq.push(DELETE(sid));
  if (close === "ok") seq.push(...REGISTRY(sid));
  return { view: { status: close === "ok" ? 0 : 1, stdout, stderr, seq }, ps: kill === "no-parent" ? 1 : 2 };
}

const LEGACY_ORPHAN = {
  view: {
    status: 0,
    stdout: [L(`session not in telepty list: ${SID} (already cleaned or never registered); closing terminal surface by sid`),
      L(`DELETE /api/sessions/${SID} → 200 (removed from registry)`), ""],
    stderr: "",
    seq: [["telepty", "list", "--json"], ["telepty", "list", "--json"], ["cmux", "--json", "list-workspaces"], DELETE(SID), ...REGISTRY(SID)],
  },
  ps: 0,
};

/** Legacy flow must equal the explicit expectation; exactly one agent-meta line. */
function expectLegacy(r, want, { vetoReachedPs = false } = {}) {
  assert.deepEqual(legacyView(r), want.view, "legacy flow (exit/stdout/stderr/kill/close/DELETE/registry) changed");
  assert.equal(psCount(r), want.ps + (vetoReachedPs ? 1 : 0), "ps snapshot count");
  assert.equal(metaLines(r).length, 1, `exactly one agent-meta line: ${r.stdout}`);
}

// ═════════════════════════ R: G2b reader CLI ═════════════════════════════════
test("PC-R01 default output is exactly {binding,launch}; receipt pids are not read on the default path", () => {
  const run = makeRun("r01");
  const w = world(run);
  const want = JSON.stringify({
    binding: { v: 1, sid: SID, task: "1162", attempt: A_IDS.attempt, manifest_hash: w.A.hash, workspace_id: A_IDS.workspace_id,
      surface_id: A_IDS.surface_id, terminal_lifecycle_id: A_IDS.terminal_lifecycle_id },
    launch: { v: 2, cli: "claude", model: { value: "unknown", source: "unknown" }, effort: { value: "unknown", source: "unknown" } },
  }) + "\n";
  const r = reader(run, ["--stage", w.stage, "--sid", SID]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, want);
  assert.equal(r.stderr, "");
  fixReceipt(w.A, 1, 1);
  const again = reader(run, ["--stage", w.stage, "--sid", SID]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, want, "pid 1/1 receipt still reads byte-identically without --with-owner");
  assert.equal(run.tripwireHits(), "");
});

test("PC-R02 --with-owner adds exactly owner{supervisor_pid,child_pid}; binding/launch unchanged", () => {
  const run = makeRun("r02");
  const w = world(run);
  const d = JSON.parse(reader(run, ["--stage", w.stage, "--sid", SID]).stdout);
  const r = reader(run, ["--stage", w.stage, "--sid", SID, "--with-owner"]);
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(o), ["binding", "launch", "owner"]);
  assert.deepEqual(o.owner, { supervisor_pid: 5001, child_pid: 5002 });
  assert.deepEqual({ binding: o.binding, launch: o.launch }, d);
});

const BAD_OWNERS = [
  ["pid 1/1", 1, 1], ["pid 0", 0, 5002], ["negative", -5, 5002], ["fraction", 5001.5, 5002], ["string", "5001", 5002],
  ["equal", 5001, 5001], ["unsafe 2^53", 2 ** 53, 5002], ["null child", 5001, null], ["bool", true, 5002], ["child 1", 5001, 1],
];
for (const [name, S, C] of BAD_OWNERS) {
  test(`PC-R03 --with-owner rejects unsafe owner (${name}) → 30, no stdout; default read unaffected`, () => {
    const run = makeRun("r03");
    const w = world(run);
    fixReceipt(w.A, S, C);
    const r = reader(run, ["--stage", w.stage, "--sid", SID, "--with-owner"]);
    assert.equal(r.status, 30, r.stderr);
    assert.equal(r.stdout, "");
    assert.equal(reader(run, ["--stage", w.stage, "--sid", SID]).status, 0);
  });
}

test("PC-R04 full matching pin → 0, output identical to unpinned (with and without --with-owner)", () => {
  const run = makeRun("r04");
  const w = world(run);
  const d = reader(run, ["--stage", w.stage, "--sid", SID]);
  const p = reader(run, ["--stage", w.stage, "--sid", SID, ...pinArgs(pinOf(w.A))]);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout, d.stdout);
  const po = reader(run, ["--stage", w.stage, "--sid", SID, "--with-owner", ...pinArgs(pinOf(w.A))]);
  assert.equal(po.status, 0, po.stderr);
  assert.deepEqual(JSON.parse(po.stdout).owner, { supervisor_pid: 5001, child_pid: 5002 });
});

// Every pin component drifts alone, then all four (the B tuple), then a case-only variant.
const MISMATCH = [
  ["attempt", { attempt: B_IDS.attempt }], ["hash", { hash: "f".repeat(64) }],
  ["surface", { surface: R_IDS.surface_id }], ["lifecycle", { lifecycle: R_IDS.terminal_lifecycle_id }],
  ["all four (B tuple)", null], ["surface upper-case of same uuid", { surface: A_IDS.surface_id.toUpperCase() }],
];
for (const [name, over] of MISMATCH) {
  test(`PC-R05 pin mismatch on ${name} → 10 AGENT_BINDING_DRIFT, no stdout`, () => {
    const run = makeRun("r05");
    const w = world(run);
    const r = reader(run, ["--stage", w.stage, "--sid", SID, ...pinArgs(over === null ? pinOf(w.B) : pinOf(w.A, over))]);
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /AGENT_BINDING_DRIFT/);
  });
}

test("PC-R06 every partial pin subset (14) → 30", () => {
  const run = makeRun("r06");
  const w = world(run);
  const full = pinArgs(pinOf(w.A));
  const pairs = [0, 1, 2, 3].map((i) => full.slice(i * 2, i * 2 + 2));
  for (let mask = 1; mask < 15; mask++) {
    const r = reader(run, ["--stage", w.stage, "--sid", SID, ...pairs.filter((_, i) => mask & (1 << i)).flat()]);
    assert.equal(r.status, 30, `mask ${mask}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
});

test("PC-R07 duplicate / unknown / valueless / valued-owner flags → 30", () => {
  const run = makeRun("r07");
  const w = world(run);
  const base = ["--stage", w.stage, "--sid", SID];
  const full = pinArgs(pinOf(w.A));
  const cases = [
    [...base, ...full, "--expect-attempt", A_IDS.attempt],
    [...base, ...full, "--expect-hash", w.A.hash],
    [...base, ...full, "--expect-surface", A_IDS.surface_id],
    [...base, ...full, "--expect-lifecycle", A_IDS.terminal_lifecycle_id],
    [...base, "--with-owner", "--with-owner"],
    [...base, "--with-owner=1"],
    [...base, "--with-owner", "yes"],
    [...base, ...full, "--expect-owner", "5001"],
    [...base, ...full.slice(0, 7)],
    [...base, "--sid", SID],
  ];
  for (const args of cases) {
    const r = reader(run, args);
    assert.equal(r.status, 30, `${args.slice(4).join(" ")}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
});

test("PC-R08 malformed pin values → 30 even when the chain is valid", () => {
  const run = makeRun("r08");
  const w = world(run);
  const bad = [
    { attempt: "not-a-uuid" }, { attempt: `{${A_IDS.attempt}}` }, { hash: w.A.hash.toUpperCase() },
    { hash: w.A.hash.slice(1) }, { hash: `${w.A.hash}0` }, { surface: "" }, { lifecycle: `${A_IDS.terminal_lifecycle_id} ` },
  ];
  for (const over of bad) {
    const r = reader(run, ["--stage", w.stage, "--sid", SID, ...pinArgs(pinOf(w.A, over))]);
    assert.equal(r.status, 30, `${JSON.stringify(over)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
});

test("PC-R09 a pin never masks chain failures: missing binding → 20, non-running receipt → 30 (not 10)", () => {
  const run = makeRun("r09");
  const w = world(run);
  fs.rmSync(w.A.bindingFile);
  assert.equal(reader(run, ["--stage", w.stage, "--sid", SID, ...pinArgs(pinOf(w.B))]).status, 20);
  const run2 = makeRun("r09b");
  const w2 = world(run2, { receipt: (A) => ({ state: "stopped", hash: A.hash, attempt: A.attempt, supervisorPid: 5001, childPid: 5002, checkedAt: "x" }) });
  assert.equal(reader(run2, ["--stage", w2.stage, "--sid", SID, ...pinArgs(pinOf(w2.B))]).status, 30);
});

// ═════════════════════════ T: G2c transport (wh-cli.sh agent-meta-clear) ══════
function transport(label, { cmux = {}, pin, pinRaw, mutate, env = {}, args } = {}) {
  const run = makeRun(label);
  const w = world(run);
  const r = rig(run, w, { cmux });
  if (mutate) mutate(w);
  const argv = args ? args(w) : ["agent-meta-clear", SID, "--stage", w.stage, ...(pinRaw ? pinRaw(w) : pin ? pinArgs(pin(w)) : [])];
  const res = sh(WH, argv, { env: r.env(env), timeout: 60000 });
  const seq = r.seq();
  assertConfined(run, seq);
  return { ...res, seq, w };
}
const cmuxArgv = (r) => r.seq.filter((e) => e.who === "cmux").map((e) => e.argv);
const CLEAR_RPC = ["rpc", CLEAR, JSON.stringify(A_TUPLE)];

test("PC-T01 matching pin → 0 'agent_meta clear=cleared', capabilities then one RPC with exactly the A tuple", () => {
  const r = transport("t01", { pin: (w) => pinOf(w.A) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "agent_meta clear=cleared\n");
  assert.equal(r.stderr, "");
  assert.deepEqual(cmuxArgv(r), [["capabilities"], CLEAR_RPC]);
  assert.deepEqual(JSON.parse(rpcCalls(r)[0].argv[2]), A_TUPLE);
});

for (const [name, over] of MISMATCH) {
  test(`PC-T02 pin mismatch on ${name} → 10 binding-drift, NO rpc`, () => {
    const r = transport("t02", { pin: (w) => (over === null ? pinOf(w.B) : pinOf(w.A, over)) });
    assert.equal(r.status, 10, r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /agent-meta: clear rc=10 reason=binding-drift/);
    assert.deepEqual(rpcCalls(r), []);
  });
}

const PARSE_BAD = [
  ["partial (attempt only)", () => ["--expect-attempt", A_IDS.attempt]],
  ["partial (three)", (w) => pinArgs(pinOf(w.A)).slice(0, 6)],
  ["duplicate attempt", (w) => [...pinArgs(pinOf(w.A)), "--expect-attempt", A_IDS.attempt]],
  ["duplicate stage", (w) => [...pinArgs(pinOf(w.A)), "--stage", w.stage]],
  ["unknown flag", (w) => [...pinArgs(pinOf(w.A)), "--with-owner", "x"]],
  ["valueless trailing", (w) => [...pinArgs(pinOf(w.A)).slice(0, 7)]],
  ["invalid uuid", (w) => pinArgs(pinOf(w.A, { surface: "zz" }))],
  ["upper-case hash", (w) => pinArgs(pinOf(w.A, { hash: w.A.hash.toUpperCase() }))],
  ["short hash", (w) => pinArgs(pinOf(w.A, { hash: "ab" }))],
];
for (const [name, raw] of PARSE_BAD) {
  test(`PC-T03 ${name} → 30 before ANY cmux call (capabilities included)`, () => {
    const r = transport("t03", { pinRaw: raw });
    assert.equal(r.status, 30, r.stderr);
    assert.equal(r.stdout, "");
    assert.deepEqual(r.seq.filter((e) => e.who === "cmux"), [], "no cmux call at all");
  });
}

// Unpinned clear keeps the release contract exactly (explicit expectations).
const UNPINNED = [
  ["cleared", {}, 0, "agent_meta clear=cleared\n", "", [["capabilities"], CLEAR_RPC]],
  ["absent", { [`rpc:${CLEAR}`]: { stdout: JSON.stringify({ status: "absent" }) } }, 0, "agent_meta clear=absent\n", "", [["capabilities"], CLEAR_RPC]],
  ["host refusal", { [`rpc:${CLEAR}`]: { rc: 1, stderr: "Error: stale_lifecycle: refused\n" } }, 10, "",
    "agent-meta: clear rc=10 reason=stale_lifecycle\n", [["capabilities"], CLEAR_RPC]],
  ["unpatched host", { capabilities: { stdout: caps(["system.capabilities"]) } }, 20, "",
    "agent-meta: clear rc=20 reason=capability-missing\n", [["capabilities"]]],
];
for (const [name, cmux, status, stdout, stderr, argv] of UNPINNED) {
  test(`PC-T04 unpinned clear (${name}) keeps the release contract exactly`, () => {
    const r = transport("t04", { cmux });
    assert.deepEqual([r.status, r.stdout, r.stderr], [status, stdout, stderr]);
    assert.deepEqual(cmuxArgv(r), argv);
  });
}

test("PC-T05 transport re-reads: A→B before its reader → 10, NO rpc; rebinding (same attempt/hash) → 10, NO rpc", () => {
  let r = transport("t05", { pin: (w) => pinOf(w.A), mutate: (w) => fs.writeFileSync(w.current, fs.readFileSync(w.currentB)) });
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /reason=binding-drift/);
  assert.deepEqual(rpcCalls(r), []);
  r = transport("t05r", { pin: (w) => pinOf(w.A), mutate: (w) => fs.writeFileSync(w.A.bindingFile, fs.readFileSync(w.bindingA2)) });
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stderr, /reason=binding-drift/);
  assert.deepEqual(rpcCalls(r), []);
});

test("PC-T06 fake host refusal with a matching pin → 10 with the HOST reason, distinct from binding-drift (fake host only)", () => {
  const r = transport("t06", { pin: (w) => pinOf(w.A), cmux: { [`rpc:${CLEAR}`]: { rc: 1, stderr: "Error: stale_lifecycle: refused\n" } } });
  assert.equal(r.status, 10);
  assert.equal(r.stderr, "agent-meta: clear rc=10 reason=stale_lifecycle\n");
  assert.equal(rpcCalls(r).length, 1);
});

test("PC-T07 caps and set keep the release contract; headless pinned clear → explicit 20, no cmux call", () => {
  const c = transport("t07-caps", { args: () => ["agent-meta-caps"] });
  assert.deepEqual([c.status, c.stdout, c.stderr], [0, "agent_meta caps=supported adapter=cmux\n", ""]);
  assert.deepEqual(cmuxArgv(c), [["capabilities"]]);
  const h = transport("t07-headless", { pin: (w) => pinOf(w.A), env: { AIGENTRY_WORKSPACE_HOST: "headless" } });
  assert.equal(h.status, 20, h.stderr);
  assert.equal(h.stdout, "");
  assert.match(h.stderr, /adapter=headless has no agent-metadata transport \(rc=20\)/);
  assert.deepEqual(h.seq, []);
  const status = JSON.stringify({ connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "none", read_at: 1 });
  const s = transport("t07-set", { cmux: { [`rpc:${SET}`]: { stdout: JSON.stringify({ status: "applied" }) } },
    args: (w) => ["agent-meta-set", SID, "--stage", w.stage, "--status-json", status] });
  assert.deepEqual([s.status, s.stdout, s.stderr], [0, "agent_meta set=applied\n", ""]);
  assert.deepEqual(cmuxArgv(s), [["capabilities"], ["rpc", SET, JSON.stringify({ ...A_TUPLE, fields: {
    cli: "claude", model: "unknown", model_source: "unknown", effort: "unknown", effort_source: "unknown",
    connection: "connected", activity: "unknown", activity_source: "unknown", dispatch: "none", read_at: 1 } })]]);
});

// ═════════════════════════ C: cleanup CLI end-to-end ════════════════════════
test("PC-C01 happy path: one clear RPC with the captured A tuple BEFORE the legacy kill; legacy unchanged", () => {
  const r = cleanup("c01");
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear: ${SID} (cleared)`)]);
  assert.equal(r.stdout.split("\n")[0], line(`clear: ${SID} (cleared)`), "meta line is the first stdout line");
  const rpc = rpcCalls(r);
  assert.equal(rpc.length, 1);
  assert.deepEqual(JSON.parse(rpc[0].argv[2]), A_TUPLE);
  const iRpc = r.seq.findIndex((e) => e.who === "cmux" && e.argv[0] === "rpc");
  const iKill = r.seq.findIndex((e) => e.who === "kill");
  assert.ok(iRpc >= 0 && iKill > iRpc, `rpc(${iRpc}) must precede kill(${iKill})`);
  assert.deepEqual(r.seq[iKill].argv, ["-TERM", "5000"], "kill targets the legacy needle pid only (recorder)");
});

test("PC-C02 host answers absent → '(absent)'", () => {
  const r = cleanup("c02", { cmux: { [`rpc:${CLEAR}`]: { stdout: JSON.stringify({ status: "absent" }) } } });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear: ${SID} (absent)`)]);
});

test("PC-C03 orphan (no listing row): never a metadata call; line right after the orphan line", () => {
  const r = cleanup("c03", { list: [OTHER] });
  expectLegacy(r, LEGACY_ORPHAN);
  assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (no-observed-session)`)]);
  const out = r.stdout.split("\n");
  assert.match(out[0], /session not in telepty list/);
  assert.equal(out[1], line(`clear skipped: ${SID} (no-observed-session)`));
  assert.deepEqual(metaCalls(r), []);
});

test("PC-C04 duplicate listing rows → skipped listing-duplicate; legacy still closes the first row's workspace", () => {
  for (const second of [ROW, { ...ROW, ownerPid: 7000, cmuxWorkspaceId: "0e116200-0000-4000-8000-0000000000bb" }]) {
    const r = cleanup("c04", { list: [ROW, second] });
    expectLegacy(r, legacy());
    assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (listing-duplicate)`)]);
    assert.deepEqual(metaCalls(r), []);
  }
});

const OWNERS = [["absent", undefined, "owner-missing"], ["null", null, "owner-missing"], ["string", "5000", "owner-malformed"],
  ["1", 1, "owner-malformed"], ["0", 0, "owner-malformed"], ["fraction", 5000.5, "owner-malformed"], ["negative", -5000, "owner-malformed"],
  ["unsafe", 2 ** 53, "owner-malformed"], ["bool", true, "owner-malformed"], ["object", { pid: 5000 }, "owner-malformed"]];
for (const [name, owner, reason] of OWNERS) {
  test(`PC-C05 listing ownerPid ${name} → skipped ${reason}, no metadata call`, () => {
    const row = { ...ROW };
    if (owner === undefined) delete row.ownerPid; else row.ownerPid = owner;
    const r = cleanup("c05", { list: [row] });
    expectLegacy(r, legacy());
    assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (${reason})`)]);
    assert.deepEqual(metaCalls(r), []);
  });
}

const PS_CASES = [
  ["O missing", [PS_S, PS_C], "ps-missing", "no-parent"],
  ["S missing", [PS_O, PS_C], "ps-missing"],
  ["C missing", [PS_O, PS_S], "ps-missing"],
  ["S duplicated", [PS_O, PS_S, " 5001  4000 other", PS_C], "ps-duplicate"],
  ["O duplicated", [PS_O, " 5000  1 other", PS_S, PS_C], "ps-duplicate"],
  ["ppid(S)≠O", [PS_O, " 5001  4000 node runner", PS_C], "owner-mismatch"],
  ["ppid(C)≠S", [PS_O, PS_S, " 5002  5000 claude"], "owner-mismatch"],
  ["C is O's child, S unrelated", [PS_O, " 5001     1 x", " 5002  5000 claude"], "owner-mismatch"],
];
for (const [name, rows, reason, kill = "killed"] of PS_CASES) {
  test(`PC-C06 ps snapshot ${name} → skipped ${reason}, no metadata call`, () => {
    const r = cleanup("c06", { ps: psTable(rows) });
    expectLegacy(r, legacy({ kill }), { vetoReachedPs: true });
    assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (${reason})`)]);
    assert.deepEqual(metaCalls(r), []);
  });
}

test("PC-C07 owner swap (receipt supervisor/child swapped) → owner-mismatch", () => {
  const r = cleanup("c07", { world: { S: 5002, C: 5001 } });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (owner-mismatch)`)]);
  assert.deepEqual(metaCalls(r), []);
});

const SELF = [
  ["self is C", { CLEANUP_SELF_PID: "5002" }, null, "refused"],
  ["self is C's child", { CLEANUP_SELF_PID: "9100" }, " 9100  5002 node cleanup", "refused"],
  ["bridge = S", { ORCHESTRATOR_BRIDGE_PIDS: "4000, 5001" }, null, "killed"],
  ["bridge = O", { ORCHESTRATOR_BRIDGE_PIDS: "5000" }, null, "refused"],
  ["bridge = C", { ORCHESTRATOR_BRIDGE_PIDS: "5002" }, null, "killed"],
];
for (const [name, env, extraRow, kill] of SELF) {
  test(`PC-C08 self/ancestor/bridge veto (${name}) → skipped self-or-ancestor; legacy unchanged`, () => {
    const r = cleanup("c08", { env, ps: psTable([PS_O, PS_S, PS_C, ...(extraRow ? [extraRow] : [])]) });
    expectLegacy(r, legacy({ kill }), { vetoReachedPs: true });
    assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (self-or-ancestor)`)]);
    assert.deepEqual(metaCalls(r), []);
  });
}

test("PC-C09 header / garbage / non-decimal ps rows are not identities; clear proceeds", () => {
  const r = cleanup("c09", { ps: psTable(["garbage line", "  x5001 5000 fake", " 5001x 5000 fake", " 5002 5001x fake", PS_O, PS_S, PS_C]) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear: ${SID} (cleared)`)]);
});

const CAPTURE_FAIL = [
  ["binding missing", { rig: (w) => (fs.rmSync(w.A.bindingFile), {}) }, "binding-missing"],
  ["receipt pids 1/1", { world: { S: 1, C: 1 } }, "binding-invalid"],
  ["receipt pids equal", { world: { S: 5001, C: 5001 } }, "binding-invalid"],
  ["receipt malformed", { world: { receipt: () => ({ state: "running" }) } }, "binding-invalid"],
  ["sessions root elsewhere", { env: { AIGENTRY_SESSIONS_ROOT: "/nonexistent-pm1162on" } }, "binding-missing"],
];
for (const [name, o, reason] of CAPTURE_FAIL) {
  test(`PC-C10 capture failure (${name}) → skipped ${reason}, no metadata call, legacy unchanged`, () => {
    const r = cleanup("c10", o);
    expectLegacy(r, legacy());
    assert.deepEqual(metaLines(r), [line(`clear skipped: ${SID} (${reason})`)]);
    assert.deepEqual(metaCalls(r), []);
  });
}

test("PC-C10b invalid sid syntax → skipped invalid-sid (reader never consulted)", () => {
  const bad = "bad sid";
  const r = cleanup("c10b", { list: [{ ...ROW, id: bad }], args: [bad] });
  expectLegacy(r, legacy({ sid: bad, kill: "no-parent" }));
  assert.deepEqual(metaLines(r), [line(`clear skipped: ${bad} (invalid-sid)`)]);
  assert.deepEqual(metaCalls(r), []);
});

// Drift injected by the recorder at an exact point of the sequence (first call only).
test("PC-C11 drift A→B after capture / before listing → not applied rc=10, NO rpc (capture precedes listing)", () => {
  const r = cleanup("c11", { rig: (w) => ({ fakes: { telepty: { copyOnce: [[w.currentB, w.current]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear not applied: ${SID} rc=10`)]);
  assert.deepEqual(rpcCalls(r), []);
});

test("PC-C11r rebinding (same attempt/hash, new surface/lifecycle) after capture / before listing → rc=10, NO rpc", () => {
  const r = cleanup("c11r", { rig: (w) => ({ fakes: { telepty: { copyOnce: [[w.bindingA2, w.A.bindingFile]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear not applied: ${SID} rc=10`)]);
  assert.deepEqual(rpcCalls(r), []);
});

test("PC-C12 drift A→B after listing / before transport (at the veto ps snapshot) → rc=10, NO rpc", () => {
  const r = cleanup("c12", { rig: (w) => ({ fakes: { ps: { copyOnce: [[w.currentB, w.current]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear not applied: ${SID} rc=10`)]);
  assert.deepEqual(rpcCalls(r), []);
});

test("PC-C13 drift A→B inside the transport (before its reader) → rc=10, NO rpc", () => {
  const r = cleanup("c13", { rig: (w) => ({ cmux: { capabilities: { stdout: caps(), copy: [[w.currentB, w.current]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear not applied: ${SID} rc=10`)]);
  assert.deepEqual(rpcCalls(r), []);
});

test("PC-C13r rebinding inside the transport (before its reader) → rc=10, NO rpc", () => {
  const r = cleanup("c13r", { rig: (w) => ({ cmux: { capabilities: { stdout: caps(), copy: [[w.bindingA2, w.A.bindingFile]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear not applied: ${SID} rc=10`)]);
  assert.deepEqual(rpcCalls(r), []);
});

// ABA: the RPC can only ever address the pinned A tuple. This is NOT a claim that A owned the
// pane without interruption; the host's lifecycle check at mutation time is out of scope here.
test("PC-C14 ABA (A→B at ps, B→A in transport) → the RPC addresses ONLY the pinned A tuple, never B", () => {
  const r = cleanup("c14", { rig: (w) => ({ fakes: { ps: { copyOnce: [[w.currentB, w.current]] } },
    cmux: { capabilities: { stdout: caps(), copy: [[w.currentA, w.current]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  const rpc = rpcCalls(r);
  assert.equal(rpc.length, 1);
  assert.deepEqual(JSON.parse(rpc[0].argv[2]), A_TUPLE);
  for (const v of Object.values(B_IDS)) assert.ok(!rpc[0].argv[2].includes(v), "B id must never be targeted");
});

test("PC-C15 ABA via rebinding (A→A'→A) → the RPC addresses only A's surface/lifecycle", () => {
  const r = cleanup("c15", { rig: (w) => ({ fakes: { ps: { copyOnce: [[w.bindingA2, w.A.bindingFile]] } },
    cmux: { capabilities: { stdout: caps(), copy: [[w.bindingA, w.A.bindingFile]] } } }) });
  expectLegacy(r, legacy(), { vetoReachedPs: true });
  const rpc = rpcCalls(r);
  assert.equal(rpc.length, 1);
  assert.deepEqual(JSON.parse(rpc[0].argv[2]), A_TUPLE);
});

const FAILS = [
  ["host refusal", { [`rpc:${CLEAR}`]: { rc: 1, stderr: "Error: stale_lifecycle: HOSTTEXT-CANARY\n" } }, 10],
  ["unpatched host", { capabilities: { stdout: caps(["system.capabilities"]) } }, 20],
  ["garbage reply", { [`rpc:${CLEAR}`]: { stdout: "not json" } }, 30],
  ["unexpected status", { [`rpc:${CLEAR}`]: { stdout: JSON.stringify({ status: "applied" }) } }, 30],
  ["caps rc 1", { capabilities: { rc: 1, stderr: "Error: Failed to connect HOSTTEXT-CANARY\n" } }, 30],
  ["rpc timeout (>10s)", { [`rpc:${CLEAR}`]: { sleepMs: 10500, stdout: JSON.stringify({ status: "cleared" }) } }, 30],
];
for (const [name, cmux, rc] of FAILS) {
  test(`PC-C16 clear failure (${name}) → not applied rc=${rc}; legacy kill/close/DELETE/registry/exit unchanged; host text not relayed`, () => {
    const r = cleanup("c16", { cmux });
    expectLegacy(r, legacy(), { vetoReachedPs: true });
    assert.deepEqual(metaLines(r), [line(`clear not applied: ${SID} rc=${rc}`)]);
    assert.ok(!(r.stdout + r.stderr).includes("HOSTTEXT-CANARY"));
  });
}

const EXACT = [
  ["exact cleared", 0, "agent_meta clear=cleared\n", `clear: ${SID} (cleared)`],
  ["exact absent", 0, "agent_meta clear=absent\n", `clear: ${SID} (absent)`],
  ["no trailing newline", 0, "agent_meta clear=cleared", `clear not applied: ${SID} rc=0`],
  ["extra line", 0, "agent_meta clear=cleared\nmore\n", `clear not applied: ${SID} rc=0`],
  ["suffix", 0, "agent_meta clear=clearedX\n", `clear not applied: ${SID} rc=0`],
  ["leading space", 0, " agent_meta clear=cleared\n", `clear not applied: ${SID} rc=0`],
  ["CRLF", 0, "agent_meta clear=cleared\r\n", `clear not applied: ${SID} rc=0`],
  ["empty rc0", 0, "", `clear not applied: ${SID} rc=0`],
  ["good line rc10", 10, "agent_meta clear=cleared\n", `clear not applied: ${SID} rc=10`],
  ["good line rc30", 30, "agent_meta clear=absent\n", `clear not applied: ${SID} rc=30`],
];
for (const [name, rc, stdout, want] of EXACT) {
  test(`PC-C17 only the exact success line AND rc 0 count as cleared (${name})`, () => {
    const r = cleanup("c17", { whcli: true, fakes: { whcli: { rc, stdout, stderr: "WHCLI-STDERR-CANARY\n" } } });
    expectLegacy(r, legacy(), { vetoReachedPs: true });
    assert.deepEqual(metaLines(r), [line(want)]);
    assert.ok(!(r.stdout + r.stderr).includes("WHCLI-STDERR-CANARY"), "adapter stderr never relayed");
    const calls = r.seq.filter((e) => e.who === "whcli");
    assert.deepEqual(calls.map((e) => e.argv), [["agent-meta-clear", SID, "--stage", r.w.stage, ...pinArgs(pinOf(r.w.A))]],
      "exactly one call with the exact captured pin");
  });
}

test("PC-C18 protected sid refused before any capture/listing; --force proceeds with the clear", () => {
  const r = cleanup("c18", { env: { ORCHESTRATOR_SID: SID } });
  assert.deepEqual([r.status, r.stdout, r.stderr], [1, "", `ERR refusing to clean protected session '${SID}' (pass --force to override)\n`]);
  assert.deepEqual(r.seq, [], "nothing observed");
  const f = cleanup("c18f", { env: { ORCHESTRATOR_SID: SID }, args: [SID, "--force"] });
  expectLegacy(f, legacy(), { vetoReachedPs: true });
  assert.deepEqual(metaLines(f), [line(`clear: ${SID} (cleared)`)]);
});

test("PC-C19 close failure + successful clear → exit 1 and registry withheld exactly as release", () => {
  const r = cleanup("c19", { cmux: { "close-workspace": { rc: 1, stderr: "Error: refused\n" }, "sidebar-state": { stdout: "{}" } } });
  expectLegacy(r, legacy({ close: "fail" }), { vetoReachedPs: true });
  assert.deepEqual(metaLines(r), [line(`clear: ${SID} (cleared)`)]);
});

test("PC-C20 --all-disconnected: per-sid clear/veto never changes 'cleaned: N' or exit", () => {
  const two = "w1162-two";
  const r = cleanup("c20", { list: [{ ...ROW, healthStatus: "DISCONNECTED" }, { id: two, command: "codex", healthStatus: "DISCONNECTED", ownerPid: 7000 }],
    args: ["--all-disconnected"] });
  assert.deepEqual(legacyView(r), {
    status: 0,
    stdout: [L(`killed parent telepty-allow PID 5000 for ${SID}`), L(`workspace host closed: ${SID} (${WS})`),
      L(`DELETE /api/sessions/${SID} → 200 (removed from registry)`), L(`no parent telepty-allow process for ${two} (already exited?)`),
      L(`no workspace host id mapped for ${two}; skipping`), L(`DELETE /api/sessions/${two} → 200 (removed from registry)`),
      "cleaned: 2 disconnected sessions", ""],
    stderr: "",
    seq: [["telepty", "list", "--json"], ["telepty", "list", "--json"], ["kill", "-TERM", "5000"], ["cmux", "close-workspace", "--workspace", WS],
      DELETE(SID), ...REGISTRY(SID), ["telepty", "list", "--json"], DELETE(two), ...REGISTRY(two)],
  });
  assert.equal(psCount(r), 2 + 1 + 1, "legacy ps (2 for the killed sid, 1 for the other) + 1 veto snapshot");
  assert.deepEqual(metaLines(r), [line(`clear: ${SID} (cleared)`), line(`clear skipped: ${two} (binding-missing)`)]);
});
