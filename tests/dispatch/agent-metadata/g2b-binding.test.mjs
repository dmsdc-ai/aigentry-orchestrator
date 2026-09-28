// #1162 G2b — sealed launch metadata, pane binder and binding reader, through the REAL
// compiled modules/CLIs of this tree (worker-sandbox.js, worker-sandbox-bind.js,
// agent-binding.js). No worker is ever launched: the launcher's exec line is never run.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  DIST, fake, hermeticEnv, makeRun, mkfifo, privDir, sealedFixture, sh, sha256, uuid, writePriv, HERE,
} from "./support/harness.mjs";

const READER = path.join(DIST, "src/session/agent-binding.js");
const BINDER = path.join(DIST, "src/session/worker-sandbox-bind.js");
const PREPARE = path.join(HERE, "prepare-sandbox.mjs");

const PANE = {
  CMUX_WORKSPACE_ID: "5a1162bb-0000-4000-8000-00000000000a",
  CMUX_SURFACE_ID: "5a1162bb-0000-4000-8000-00000000000b",
  CMUX_TERMINAL_LIFECYCLE_ID: "5a1162bb-0000-4000-8000-00000000000c",
};

function reader(run, args) {
  return sh(process.execPath, [READER, ...args], { env: hermeticEnv(run), timeout: 15000 });
}

function assertNoTrip(run) {
  assert.equal(run.tripwireHits(), "", "tripwire: an unexpected host actuator was executed");
}

/** Stage a real sealed attempt with the REAL prepareWorkerSandbox (fake creds/cli). */
function prepare(run, { sid = "w1162-p", task = "1162", launch, stagingRoot } = {}) {
  fake(run, "apply_patch", "#!/bin/sh\nexit 97\n");
  privDir(path.join(run.home, ".claude"));
  writePriv(path.join(run.home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "FAKE-IT1162-ACCESS", refreshToken: "FAKE-IT1162-REFRESH" } }));
  const write = privDir(path.join(run.dir, "work-write"));
  const roleCwd = privDir(path.join(run.dir, "role-cwd"));
  const scopeFile = path.join(run.dir, "scope.json");
  writePriv(scopeFile, JSON.stringify({ version: 1, task, sid, read: [], write: [write], domains: [] }));
  const stage = stagingRoot ?? privDir(path.join(run.dir, "sessions", sid));
  const r = sh(process.execPath, [PREPARE, JSON.stringify({ scopeFile, task, sid, cli: "claude", roleCwd,
    argv: ["claude", "--append-system-prompt-file", scopeFile], stagingRoot: stage,
    ...(launch === undefined ? {} : { launch }) })], { env: hermeticEnv(run, { AGENT_METADATA_DIST: DIST }) });
  assert.equal(r.status, 0, `prepare failed: ${r.stderr}`);
  return { ...JSON.parse(r.stdout), stage, write, sid, task };
}

/** The launcher's binder line (line 2), executed verbatim by bash; the exec line is NOT run. */
function runBinderLine(run, launcher, paneEnv) {
  const lines = fs.readFileSync(launcher, "utf8").split("\n");
  assert.equal(lines[0], "#!/usr/bin/env bash");
  assert.match(lines[1], /worker-sandbox-bind\.js' '.+manifest\.json' '[0-9a-f]{64}' \|\| echo "agent-meta: binding unavailable rc=\$\?" >&2$/);
  assert.match(lines[2], /^exec .+worker-sandbox-runner\.js' /, "exec runner line must follow, unchanged");
  return sh("bash", ["-c", lines[1]], { env: hermeticEnv(run, paneEnv) });
}

const CLAUDE_LAUNCH = {
  v: 2, cli: "claude",
  model: { value: "claude-opus-5", source: "default" },
  effort: { value: "xhigh", source: "env:AIGENTRY_CLAUDE_EFFORT" },
};

test("G2b-01 real prepareWorkerSandbox seals launch; root/stage are not writable by the worker", () => {
  const run = makeRun("g2b01");
  const p = prepare(run, { launch: CLAUDE_LAUNCH });
  const data = fs.readFileSync(p.manifest, "utf8");
  assert.equal(sha256(data), p.hash, "manifest hash is the sealed digest");
  const m = JSON.parse(data);
  assert.deepEqual(m.launch, CLAUDE_LAUNCH);
  const cur = JSON.parse(fs.readFileSync(path.join(p.stage, "sandbox-current.json"), "utf8"));
  assert.deepEqual(cur, { manifest: p.manifest, hash: p.hash });
  const root = path.dirname(p.manifest);
  const binding = path.join(root, "terminal-binding.json");
  const within = (x, r) => x === r || x.startsWith(r + path.sep);
  for (const w of m.config.filesystem.allowWrite) {
    for (const protectedPath of [root, p.stage, binding, p.manifest, path.join(p.stage, "sandbox-current.json")]) {
      assert.ok(!within(protectedPath, w), `allowWrite entry ${w} covers protected ${protectedPath}`);
    }
  }
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assertNoTrip(run);
});

test("G2b-02 old-shape call (no launch) keeps an old manifest; reader reports explicit unknown", () => {
  const run = makeRun("g2b02");
  const p = prepare(run);
  const m = JSON.parse(fs.readFileSync(p.manifest, "utf8"));
  assert.equal(Object.prototype.hasOwnProperty.call(m, "launch"), false);
  const b = runBinderLine(run, p.launcher, PANE);
  assert.equal(b.status, 0, b.stderr);
  const receipt = path.join(path.dirname(p.manifest), "receipt.json");
  writePriv(receipt, JSON.stringify({ state: "running", hash: p.hash, attempt: m.attempt, supervisorPid: 1, childPid: 1, checkedAt: "x" }));
  const r = reader(run, ["--stage", p.stage, "--sid", p.sid]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).launch, {
    v: 2, cli: "claude", model: { value: "unknown", source: "unknown" }, effort: { value: "unknown", source: "unknown" },
  });
  assertNoTrip(run);
});

test("G2b-03 launcher binder line → reader roundtrip (valid fixture), exact output, no env/auth/path leak", () => {
  const run = makeRun("g2b03");
  const p = prepare(run, { launch: CLAUDE_LAUNCH });
  const b = runBinderLine(run, p.launcher, PANE);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout + b.stderr, "", "binder prints nothing on success");
  const root = path.dirname(p.manifest);
  const bf = path.join(root, "terminal-binding.json");
  const st = fs.lstatSync(bf);
  assert.ok(st.isFile());
  assert.equal(st.mode & 0o777, 0o600);
  const m = JSON.parse(fs.readFileSync(p.manifest, "utf8"));
  const expected = { v: 1, sid: p.sid, task: p.task, attempt: m.attempt, manifest_hash: p.hash,
    workspace_id: PANE.CMUX_WORKSPACE_ID, surface_id: PANE.CMUX_SURFACE_ID, terminal_lifecycle_id: PANE.CMUX_TERMINAL_LIFECYCLE_ID };
  assert.deepEqual(JSON.parse(fs.readFileSync(bf, "utf8")), expected);
  // the runner would write this; the fixture supplies it (no worker is launched)
  writePriv(path.join(root, "receipt.json"), JSON.stringify({ state: "running", hash: p.hash, attempt: m.attempt, supervisorPid: 1, childPid: 1, checkedAt: "x" }));
  for (const extra of [[], ["--task", p.task]]) {
    const r = reader(run, ["--stage", p.stage, "--sid", p.sid, ...extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["binding", "launch"]);
    assert.deepEqual(out.binding, expected);
    assert.deepEqual(out.launch, CLAUDE_LAUNCH);
    for (const leak of ["FAKE-IT1162", run.dir, "CLAUDE_CONFIG_DIR", "HOME", "receipt", "manifest.json"]) {
      assert.ok(!r.stdout.includes(leak), `reader stdout leaks ${leak}`);
    }
  }
  assertNoTrip(run);
});

test("G2b-04 binder: absent pane ids → 20 and nothing written; non-UUID → 30; logged by launcher", () => {
  const run = makeRun("g2b04");
  const p = prepare(run, { launch: CLAUDE_LAUNCH });
  const bf = path.join(path.dirname(p.manifest), "terminal-binding.json");
  for (const drop of Object.keys(PANE)) {
    const env = { ...PANE };
    delete env[drop];
    const r = runBinderLine(run, p.launcher, env);
    assert.equal(r.status, 0, "launcher line itself never fails (spawn not gated)");
    assert.equal(r.stderr, "agent-meta: binding unavailable rc=20\n");
    assert.equal(fs.existsSync(bf), false);
  }
  for (const bad of ["not-a-uuid", "5a1162bb-0000-4000-8000-00000000000", "../../x", "5a1162bb-0000-4000-8000-00000000000a\n"]) {
    const r = runBinderLine(run, p.launcher, { ...PANE, CMUX_SURFACE_ID: bad });
    assert.equal(r.stderr, "agent-meta: binding unavailable rc=30\n", `bad surface ${JSON.stringify(bad)}`);
    assert.equal(fs.existsSync(bf), false);
  }
  assertNoTrip(run);
});

test("G2b-05 binder: a superseded attempt exits 10 and does not bind; hash mismatch 30", () => {
  const run = makeRun("g2b05");
  const first = prepare(run, { launch: CLAUDE_LAUNCH });
  const second = prepare(run, { launch: CLAUDE_LAUNCH, stagingRoot: first.stage });
  assert.notEqual(first.manifest, second.manifest);
  const r = runBinderLine(run, first.launcher, PANE);
  assert.equal(r.stderr, "agent-meta: binding unavailable rc=10\n");
  assert.equal(fs.existsSync(path.join(path.dirname(first.manifest), "terminal-binding.json")), false);
  const direct = sh(process.execPath, [BINDER, second.manifest, "0".repeat(64)], { env: hermeticEnv(run, PANE) });
  assert.equal(direct.status, 30);
  const noArgs = sh(process.execPath, [BINDER], { env: hermeticEnv(run, PANE) });
  assert.equal(noArgs.status, 30);
  assertNoTrip(run);
});

test("G2b-06 binder replaces a planted symlink at the binding path, never follows it", () => {
  const run = makeRun("g2b06");
  const p = prepare(run, { launch: CLAUDE_LAUNCH });
  const victim = path.join(run.dir, "victim.txt");
  fs.writeFileSync(victim, "victim-unchanged\n");
  const bf = path.join(path.dirname(p.manifest), "terminal-binding.json");
  fs.symlinkSync(victim, bf);
  const r = runBinderLine(run, p.launcher, PANE);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.equal(fs.readFileSync(victim, "utf8"), "victim-unchanged\n");
  assert.ok(fs.lstatSync(bf).isFile() && !fs.lstatSync(bf).isSymbolicLink());
  assertNoTrip(run);
});

test("G2b-07 reader: fixture positive control is 0 (tripwire for every defect case below)", () => {
  const run = makeRun("g2b07");
  const f = sealedFixture(run, { launch: CLAUDE_LAUNCH });
  const r = reader(run, ["--stage", f.stage, "--sid", f.sid]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).binding.surface_id, f.ids.surface_id);
});

// Each case: build a VALID fixture, apply one defect, expect the exact code.
const DEFECTS = [
  // ── missing → 20 ──
  ["stage directory absent", 20, (run) => ({ stage: path.join(run.dir, "sessions", "never") , sid: "never", skipFixture: true })],
  ["sandbox-current.json absent", 20, (run, f) => { fs.rmSync(f.current); }],
  ["terminal-binding.json absent", 20, (run, f) => { fs.rmSync(f.bindingFile); }],
  // ── invalid → 30 ──
  ["receipt absent", 30, (run, f) => { fs.rmSync(path.join(f.root, "receipt.json")); }],
  ["current has an extra key", 30, (run, f) => { writePriv(f.current, JSON.stringify({ manifest: f.manifest, hash: f.hash, x: 1 })); }],
  ["current missing hash", 30, (run, f) => { writePriv(f.current, JSON.stringify({ manifest: f.manifest })); }],
  ["current not JSON", 30, (run, f) => { writePriv(f.current, "{"); }],
  ["current is a symlink", 30, (run, f) => {
    const real = path.join(run.dir, "current-real.json");
    writePriv(real, JSON.stringify({ manifest: f.manifest, hash: f.hash }));
    fs.rmSync(f.current); fs.symlinkSync(real, f.current);
  }],
  ["current mode 0644", 30, (run, f) => { fs.chmodSync(f.current, 0o644); }],
  ["current oversize (>4KiB)", 30, (run, f) => { writePriv(f.current, JSON.stringify({ manifest: f.manifest, hash: f.hash }) + " ".repeat(5000)); }],
  ["current is a FIFO", 30, (run, f) => { fs.rmSync(f.current); mkfifo(f.current); }],
  ["manifest path traversal (..)", 30, (run, f) => {
    writePriv(f.current, JSON.stringify({ manifest: `${f.root}/../${path.basename(f.root)}/manifest.json`, hash: f.hash }));
  }],
  ["manifest path relative", 30, (run, f) => { writePriv(f.current, JSON.stringify({ manifest: "sandbox/x/manifest.json", hash: f.hash })); }],
  ["manifest in another sid's stage", 30, (run, f) => {
    const other = sealedFixture(run, { sid: f.sid, stage: path.join(run.dir, "sessions", "other-stage") });
    writePriv(f.current, JSON.stringify({ manifest: other.manifest, hash: other.hash }));
  }],
  ["manifest dir name not a UUID", 30, (run, f) => {
    const alt = privDir(path.join(f.stage, "sandbox", "not-a-uuid"));
    fs.copyFileSync(f.manifest, path.join(alt, "manifest.json"));
    writePriv(f.current, JSON.stringify({ manifest: path.join(alt, "manifest.json"), hash: f.hash }));
  }],
  ["sandbox dir is a symlink", 30, (run, f) => {
    const moved = path.join(run.dir, "moved-sandbox");
    fs.renameSync(path.join(f.stage, "sandbox"), moved);
    fs.symlinkSync(moved, path.join(f.stage, "sandbox"));
  }],
  ["root dir mode 0755", 30, (run, f) => { fs.chmodSync(f.root, 0o755); }],
  ["manifest tampered (hash mismatch)", 30, (run, f) => { writePriv(f.manifest, f.manifestData.replace('"1162"', '"1163"')); }],
  ["manifest mode 0640", 30, (run, f) => { fs.chmodSync(f.manifest, 0o640); }],
  ["manifest symlink", 30, (run, f) => {
    const real = path.join(run.dir, "manifest-real.json");
    writePriv(real, f.manifestData); fs.rmSync(f.manifest); fs.symlinkSync(real, f.manifest);
  }],
  ["manifest sid mismatch vs --sid", 30, () => ({ sidOverride: "w1162-other" })],
  ["manifest attempt ≠ directory", 30, (run) => ({ fixture: { manifestExtra: { attempt: uuid() } } })],
  ["manifest receipt path elsewhere", 30, (run) => ({ fixture: { manifestExtra: { receipt: path.join(run.dir, "receipt.json") } } })],
  ["manifest version 2", 30, () => ({ fixture: { manifestExtra: { version: 2 } } })],
  ["manifest cli not a CliKind", 30, () => ({ fixture: { cli: "bash" } })],
  ["manifest oversize (>1MiB)", 30, () => ({ fixture: { manifestExtra: { pad: "x".repeat(1024 * 1024) } } })],
  ["--task mismatch", 30, () => ({ extraArgs: ["--task", "9999"] })],
  ["receipt state exited", 30, (run, f) => { writePriv(path.join(f.root, "receipt.json"), JSON.stringify({ state: "exited", hash: f.hash, attempt: f.attempt, supervisorPid: 1, childPid: 1, checkedAt: "x" })); }],
  ["receipt hash mismatch", 30, (run, f) => { writePriv(path.join(f.root, "receipt.json"), JSON.stringify({ state: "running", hash: "a".repeat(64), attempt: f.attempt, supervisorPid: 1, childPid: 1, checkedAt: "x" })); }],
  ["receipt attempt mismatch", 30, (run, f) => { writePriv(path.join(f.root, "receipt.json"), JSON.stringify({ state: "running", hash: f.hash, attempt: uuid(), supervisorPid: 1, childPid: 1, checkedAt: "x" })); }],
  ["receipt extra key", 30, (run, f) => { writePriv(path.join(f.root, "receipt.json"), JSON.stringify({ state: "running", hash: f.hash, attempt: f.attempt, supervisorPid: 1, childPid: 1, checkedAt: "x", extra: 1 })); }],
  ["binding sid mismatch", 30, (run, f) => { rebind(f, { sid: "w1162-zz" }); }],
  ["binding task mismatch", 30, (run, f) => { rebind(f, { task: "1" }); }],
  ["binding attempt mismatch", 30, (run, f) => { rebind(f, { attempt: uuid() }); }],
  ["binding manifest_hash mismatch", 30, (run, f) => { rebind(f, { manifest_hash: "b".repeat(64) }); }],
  ["binding v 2", 30, (run, f) => { rebind(f, { v: 2 }); }],
  ["binding surface not UUID", 30, (run, f) => { rebind(f, { surface_id: "surface:1" }); }],
  ["binding lifecycle not UUID", 30, (run, f) => { rebind(f, { terminal_lifecycle_id: "0" }); }],
  ["binding extra key", 30, (run, f) => { rebind(f, { extra: "x" }); }],
  ["binding missing key", 30, (run, f) => { rebind(f, { workspace_id: undefined }); }],
  ["binding mode 0644", 30, (run, f) => { fs.chmodSync(f.bindingFile, 0o644); }],
  ["binding oversize (>4KiB)", 30, (run, f) => { writePriv(f.bindingFile, fs.readFileSync(f.bindingFile, "utf8") + " ".repeat(5000)); }],
  ["binding is a FIFO", 30, (run, f) => { fs.rmSync(f.bindingFile); mkfifo(f.bindingFile); }],
  ["binding is a symlink to a valid copy", 30, (run, f) => {
    const real = path.join(run.dir, "binding-real.json");
    writePriv(real, fs.readFileSync(f.bindingFile, "utf8")); fs.rmSync(f.bindingFile); fs.symlinkSync(real, f.bindingFile);
  }],
  ["binding is a directory", 30, (run, f) => { fs.rmSync(f.bindingFile); privDir(f.bindingFile); }],
  ["stage group-writable", 30, (run, f) => { fs.chmodSync(f.stage, 0o770); }],
  ["bad args: duplicate --sid", 30, () => ({ argsOverride: (f) => ["--stage", f.stage, "--sid", f.sid, "--sid", f.sid] })],
  ["bad args: unknown flag", 30, () => ({ argsOverride: (f) => ["--stage", f.stage, "--sid", f.sid, "--dump", "1"] })],
  ["bad args: no --sid", 30, () => ({ argsOverride: (f) => ["--stage", f.stage] })],
  ["bad args: sid with path traversal", 30, () => ({ argsOverride: (f) => ["--stage", f.stage, "--sid", "../w1162-a"] })],
  ["bad args: relative stage", 30, () => ({ argsOverride: (f) => ["--stage", "sessions/w1162-a", "--sid", f.sid] })],
  ["bad args: empty --task", 30, () => ({ argsOverride: (f) => ["--stage", f.stage, "--sid", f.sid, "--task", ""] })],
];

function rebind(f, patch) {
  const b = JSON.parse(fs.readFileSync(f.bindingFile, "utf8"));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete b[k]; else b[k] = v;
  }
  writePriv(f.bindingFile, JSON.stringify(b));
}

for (const [name, code, mutate] of DEFECTS) {
  test(`G2b-08 reader defect → ${code}: ${name}`, () => {
    const run = makeRun("g2b08");
    const pre = typeof mutate === "function" && mutate.length <= 1 ? mutate(run) : undefined;
    if (pre?.skipFixture) {
      const r = reader(run, ["--stage", pre.stage, "--sid", pre.sid]);
      assert.equal(r.status, code, r.stderr);
      assert.equal(r.stdout, "");
      return;
    }
    const f = sealedFixture(run, { launch: CLAUDE_LAUNCH, ...(pre?.fixture ?? {}) });
    if (!pre) mutate(run, f);
    const args = pre?.argsOverride ? pre.argsOverride(f)
      : ["--stage", f.stage, "--sid", pre?.sidOverride ?? f.sid, ...(pre?.extraArgs ?? [])];
    const r = reader(run, args);
    assert.equal(r.status, code, `stderr=${r.stderr}`);
    assert.equal(r.stdout, "", "no partial output on failure");
    assert.match(r.stderr, /^agent-binding: [A-Z_]+(: [a-z.-]+)?\n$/, "fixed-code diagnostic only");
    assert.ok(!r.stderr.includes(run.dir), "diagnostic leaks a path");
    assertNoTrip(run);
  });
}

test("G2b-09 launch labels: shell/newline text, extra keys, observed source → unknown (never passed through)", () => {
  const cases = [
    { v: 2, cli: "claude", model: { value: "x\n$(touch /tmp/pwn)", source: "default" }, effort: { value: "high", source: "default" } },
    { v: 2, cli: "claude", model: { value: "opus", source: "observed" }, effort: { value: "high", source: "default" } },
    { v: 2, cli: "claude", model: { value: "opus", source: "default", extra: 1 }, effort: { value: "high", source: "default" } },
    { v: 2, cli: "claude", model: { value: "opus", source: "env:HOME" }, effort: { value: "high", source: "default" } },
    { v: 2, cli: "codex", model: { value: "opus", source: "default" }, effort: { value: "high", source: "default" } },
    { v: 1, cli: "claude", model: { value: "opus", source: "default" }, effort: { value: "high", source: "default" } },
  ];
  for (const launch of cases) {
    const run = makeRun("g2b09");
    const f = sealedFixture(run, { launch });
    const r = reader(run, ["--stage", f.stage, "--sid", f.sid]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).launch;
    const cliMismatch = launch.cli !== "claude" || launch.v !== 2;
    assert.deepEqual(out.model, { value: "unknown", source: "unknown" }, JSON.stringify(launch));
    if (cliMismatch) assert.deepEqual(out.effort, { value: "unknown", source: "unknown" });
  }
});

test("G2b-10 configured literal \"unknown\" and cli-default survive as typed values (not inferred)", () => {
  const run = makeRun("g2b10");
  const launch = { v: 2, cli: "claude", model: { value: "unknown", source: "env:AIGENTRY_CLAUDE_MODEL" }, effort: { value: "unknown", source: "cli-default" } };
  const f = sealedFixture(run, { launch });
  const r = reader(run, ["--stage", f.stage, "--sid", f.sid]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).launch, launch);
});

test("G2b-11 CHARACTERIZATION: uppercase UUIDs in the binding are accepted by the reader", () => {
  const run = makeRun("g2b11");
  const f = sealedFixture(run, { surface_id: "0F1162AA-0000-4000-8000-000000000002" });
  const r = reader(run, ["--stage", f.stage, "--sid", f.sid]);
  // Recorded, not asserted as a defect: the lock says "canonical UUIDs"; Swift
  // UUID().uuidString (the likely CMUX_* source) is uppercase. Host-side canonical
  // form is a G1 fact not staged here.
  assert.equal(r.status, 0);
});
