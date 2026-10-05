// #1148 — managed spawn decision on the ACTUAL dispatch caller path: dispatch → resolver → boot-prepare
// (U3) → sealed sandbox manifest (U4) → telemetry + task ledger, plus the U3 reader and the U4 runner
// re-check. Oracles come from contract/delta.md rc1148ky-v1 §2, §3, §4, §6 and §7.2, nothing else.
// Hermetic: fake CLIs/HOME from model-router-fixtures, AIGENTRY_MODEL_METADATA=off, PATH without any
// host claude/codex. No real CLI, model, provider, daemon or network. Resolver faults are injected
// by a test-owned NODE_OPTIONS preload that acts only inside a `--resolve` process; no product file
// is replaced or edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixture, PROFILE, REPO, ROUTER } from "./model-router-fixtures.js";

type Fx = ReturnType<typeof fixture>;
// Untyped JSON read back from manifests, telemetry and the ledger.
type Rec = Record<string, any>;
type Run = SpawnSyncReturns<string>;

const SID = "router-fixture", TASK = "1083";
const posix = process.platform === "darwin" || process.platform === "linux";
const skip = posix ? false : "the confined sandbox is darwin/linux only";

// Host PATH minus every directory holding a claude/codex: the resolver must only ever see fakes.
function cleanHostPath(): string {
  return (process.env.PATH ?? "").split(delimiter).filter((d) => d && !["claude", "codex"].some((c) => {
    try { accessSync(join(d, c), constants.X_OK); return true; } catch { return false; }
  })).join(delimiter);
}
const pathWith = (...dirs: string[]) => [...dirs, cleanHostPath()].join(delimiter);

// A fake CLI: a probe is recorded (and answered), anything else trips the model/work tripwire.
function fakeCli(file: string, tag: string): string {
  writeFileSync(file, `#!${process.execPath}\n` +
    `if (process.argv.length === 3 && ['--version', '--help'].includes(process.argv[2])) {\n` +
    `  require('node:fs').appendFileSync(process.env.CLI_PROBE_LOG, ${JSON.stringify(tag)} + ' ' + process.argv[2] + '\\n');\n` +
    `  console.log('9.9.9'); process.exit(0);\n}\n` +
    `require('node:fs').appendFileSync(process.env.WORK_LOG, 'model\\n'); process.exit(99);\n`, { mode: 0o755 });
  return file;
}

function telemetryStart(f: Fx): Rec | undefined {
  if (!existsSync(f.env.TELEMETRY_LOG!)) return undefined;
  const events = readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const e = events.find((x) => x[x.indexOf("--subtype") + 1] === "dispatch_start");
  return e ? JSON.parse(e[e.indexOf("--payload-json") + 1]!) as Rec : undefined;
}
const ledgerTask = (f: Fx): Rec => JSON.parse(readFileSync(f.queue, "utf8")).tasks[0] as Rec;

// The recorded decision: requested / selected / observed kept apart (delta §2, §3), wherever it is nested.
function findAudit(v: unknown, depth = 0): Rec | undefined {
  if (!v || typeof v !== "object" || depth > 6) return undefined;
  const o = v as Rec;
  if ("requested" in o && "observed" in o && "evidence_label" in o) return o;
  for (const x of Object.values(o)) {
    const r = findAudit(x, depth + 1);
    if (r) return r;
  }
  return undefined;
}
const selected = (a: Rec): Rec => (a.selected ?? a) as Rec;

const flag = (cmd: string[], name: string): string | undefined => {
  const i = cmd.indexOf(name);
  return i >= 0 ? cmd[i + 1] : undefined;
};
const codexEffort = (cmd: string[]): string | undefined =>
  cmd.find((a) => a.startsWith("model_reasoning_effort="))?.slice("model_reasoning_effort=".length);
const probes = (f: Fx): string => (existsSync(f.env.CLI_PROBE_LOG!) ? readFileSync(f.env.CLI_PROBE_LOG!, "utf8") : "");
// One decision → at most one model and one effort flag: a literal/env flag left in front of the decision's
// flag would be the one the CLI reads (hidden default or silent env merge, delta §2/§6 U3).
function assertSingleFlags(cmd: string[], cli: string): void {
  const count = (p: (a: string) => boolean) => cmd.filter(p).length;
  const names = cli === "codex" ? ["-m", "--model"] : ["--model", "--effort"];
  for (const n of names) assert.ok(count((a) => a === n) <= 1, `${n} appears more than once: ${JSON.stringify(cmd)}`);
  assert.ok(count((a) => a.startsWith("model_reasoning_effort=")) <= 1, `effort appears more than once: ${JSON.stringify(cmd)}`);
}

function assertNothingSpawned(f: Fx, r: Run): void {
  assert.equal(existsSync(f.env.OPEN_LOG!), false, `refused before the terminal port\n${r.stderr}`);
  assert.equal(existsSync(join(f.aig, "sessions", SID, "sandbox-current.json")), false, "no sealed manifest");
  assert.equal(existsSync(f.env.PARENT_MODEL_LOG!), false, "no delivery");
  assert.equal(existsSync(f.env.WORK_LOG!), false, "no model/work execution");
  assert.equal(probes(f), "", "no --version/--help probe");
  assert.doesNotMatch(r.stderr, /legacy path active/);
}

/** A successful fresh confined spawn: one decision, bound end to end. */
function assertManaged(f: Fx, r: Run, cli: "claude" | "codex") {
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /launch metadata missing|boot-prepare.mjs failed|legacy path active/);
  const m = f.manifest() as unknown as Rec; // hash, task/sid and confinement integrity checked by the fixture
  const cmd = m.command as string[];
  assert.equal(m.cli, cli);
  const exe = m.executable as Rec | undefined;
  assert.ok(exe && typeof exe === "object", "U4: the sealed manifest carries the executable binding inside its hash");
  assert.equal(exe.cli, cli);
  assert.ok(typeof exe.path === "string" && isAbsolute(exe.path) && basename(exe.path) === cli, JSON.stringify(exe));
  assert.equal(cmd[0], exe.realpath, "worker argv[0] is the bound realpath");
  assert.equal(realpathSync(exe.path), exe.realpath);
  const st = statSync(exe.realpath);
  assert.deepEqual([exe.dev, exe.ino, exe.size, exe.mtimeMs], [st.dev, st.ino, st.size, st.mtimeMs]);
  assert.ok(["npm-package-metadata", "operator-declared", "unknown"].includes(exe.versionSource), JSON.stringify(exe));
  assert.equal(probes(f), "", "the managed path never runs --version/--help");
  assertSingleFlags(cmd, cli);
  const model = cli === "codex" ? flag(cmd, "-m") : flag(cmd, "--model");
  const effort = cli === "codex" ? codexEffort(cmd) : flag(cmd, "--effort");
  const audit = findAudit(telemetryStart(f)), ledger = findAudit(ledgerTask(f));
  assert.ok(audit, "telemetry dispatch_start records the decision");
  assert.ok(ledger, "the task ledger records the decision");
  for (const a of [audit, ledger]) {
    assert.deepEqual(a.observed, { model: null, observed_by: "none" }, "observed stays unknown: nothing is measured");
    const s = selected(a);
    assert.equal(s.model ?? null, model ?? null, "selected model = what the sealed argv carries");
    assert.equal(s.effort?.token ?? null, effort ?? null, "selected effort = what the sealed argv carries");
    assert.equal(s.executable?.realpath, exe.realpath);
    if ("task" in a) assert.equal(a.task, TASK);
    if ("sid" in a) assert.equal(a.sid, SID);
  }
  // #1162: typed launch metadata still sealed, agreeing with argv; one agent-meta publish.
  const launch = m.launch as Rec | undefined;
  assert.ok(launch && launch.v === 2 && launch.cli === cli, `#1162 launch metadata kept: ${JSON.stringify(launch)}`);
  if (launch.model?.value !== "unknown") assert.equal(launch.model.value, model);
  if (launch.effort?.value !== "unknown") assert.equal(launch.effort.value, effort);
  assert.equal(readFileSync(f.env.CMUX_CAPS_LOG!, "utf8").trim().split("\n").length, 1, "#1162 publishes agent metadata once");
  return { m, cmd, exe, audit, ledger, model, effort };
}

const explicit = (f: Fx, cli: string) => [...f.spawnArgs, "--cli", cli, "--role", "coder"];

test("managed: fresh explicit claude binds ONE decision through boot to sealed argv, telemetry and ledger", { skip }, () => {
  const f = fixture();
  try {
    const r = f.dispatch(explicit(f, "claude"), { PATH: pathWith(f.bin), AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5" });
    const { exe, audit, model, effort } = assertManaged(f, r, "claude");
    assert.equal(f.calls(), 0, "explicit never calls the classifier");
    assert.equal(exe.path, join(f.bin, "claude"));
    assert.equal(model, "claude-opus-5-5");
    // delta §3: requested = {cli?, model?, effort?, executable?, source}.
    assert.deepEqual([audit.requested.model, audit.requested.source], ["claude-opus-5-5", "env"]);
    assert.equal(audit.decided_by, "explicit");
    assert.match(String(audit.evidence_label), /^degraded:/, "metadata off is labelled degraded, never current");
    // Effort is the documented model default (bootstrap catalog: Opus 5.5 → medium), never a hidden xhigh.
    assert.equal(effort, "medium");
    assert.equal(selected(audit).effort.state, "model-default");
    assert.match(ledgerTask(f).note, /cli=claude\/claude-opus-5-5 by=explicit/);
  } finally { f.cleanup(); }
});

test("managed: no model request → no hidden literal effort; effort is a documented default or omitted", { skip }, () => {
  const f = fixture();
  try {
    const { audit, effort } = assertManaged(f, f.dispatch(explicit(f, "claude"), { PATH: pathWith(f.bin) }), "claude");
    assert.notEqual(effort, "xhigh", "the boot-prepare/adapter xhigh literal is not consulted");
    assert.equal(audit.requested.model, undefined);
    assert.ok(["model-default", "omitted"].includes(selected(audit).effort.state), JSON.stringify(audit));
  } finally { f.cleanup(); }
});

test("managed: unknown explicit model omits effort; an inherited effort is kept verbatim and recorded as env", { skip }, () => {
  for (const effortEnv of [undefined, "high"]) {
    const f = fixture();
    try {
      const env: NodeJS.ProcessEnv = { PATH: pathWith(f.bin), AIGENTRY_CLAUDE_MODEL: "chosen-by-operator" };
      if (effortEnv) env.AIGENTRY_CLAUDE_EFFORT = effortEnv;
      const { audit, model, effort } = assertManaged(f, f.dispatch(explicit(f, "claude"), env), "claude");
      assert.equal(model, "chosen-by-operator", "explicit flags never disappear");
      if (!effortEnv) {
        assert.equal(effort, undefined, "no documented default → the effort flag is omitted");
        assert.deepEqual([selected(audit).effort.token, selected(audit).effort.state], [null, "omitted"]);
      } else {
        assert.equal(effort, "high");
        assert.deepEqual([audit.requested.effort, audit.requested.source], ["high", "env"]);
      }
    } finally { f.cleanup(); }
  }
});

test("managed: auto route keeps the routed codex model; no hidden codex effort", { skip }, () => {
  const f = fixture();
  try {
    const { audit, model, effort, cmd } = assertManaged(f, f.dispatch([...f.spawnArgs, "--role", "coder"], { PATH: pathWith(f.bin) }), "codex");
    assert.equal(model, "gpt-6-astra");
    assert.equal(effort, undefined, "the codex.ts `high` literal is not consulted");
    assert.equal(cmd.some((a) => a.startsWith("model_reasoning_effort=")), false);
    assert.match(String(audit.decided_by), /^(llm|table)$/);
  } finally { f.cleanup(); }
});

test("managed: cap fallback re-resolves the whole tuple for the FINAL cli", { skip }, () => {
  const f = fixture();
  try {
    writeFileSync(join(f.aig, "instructions/roles/architect.md"), "# ARCHITECT\nFIXTURE-ROLE\n");
    const r = f.dispatch([...f.spawnArgs, "--role", "architect"], { PATH: pathWith(f.bin), AIGENTRY_CLI_CAP_CODEX: "2",
      LIVE_SESSIONS: JSON.stringify([{ id: SID, command: "codex" }, { id: "live-1", command: f.liveLauncher("codex") }]),
      // Codex-only operator inputs must not leak into the claude tuple (an invalid one would refuse).
      AIGENTRY_CODEX_EXECUTABLE: "relative/codex", AIGENTRY_CODEX_EFFORT: "ultra", AIGENTRY_CODEX_MODEL: "gpt-5.4" });
    const { exe, audit, cmd } = assertManaged(f, r, "claude");
    assert.match(r.stderr, /codex at cap/);
    assert.equal(basename(exe.path), "claude");
    assert.equal(audit.decided_by, "llm-capped");
    assert.equal(cmd.includes("ultra"), false);
    assert.equal(audit.requested.executable, undefined);
  } finally { f.cleanup(); }
});

test("managed: --target and a deduplicated repeat never call the resolver", { skip }, () => {
  // An invalid operator executable would make ANY resolver call refuse with exit 4.
  const poison = { AIGENTRY_CLAUDE_EXECUTABLE: "relative/claude", AIGENTRY_CODEX_EXECUTABLE: "relative/codex" };
  const f = fixture();
  try {
    f.prepareTarget();
    const r = f.dispatch(["--target", SID], { ...poison, OBSERVED_CLI: "codex", PATH: pathWith(f.bin) });
    assert.equal(r.status, 0, r.stderr);
    const payload = telemetryStart(f)!;
    assert.equal(payload.route.decided_by, "existing");
    assert.equal(findAudit(payload), undefined, "an existing target gets no spawn decision");
    assert.match(ledgerTask(f).note, /cli=codex\/unknown by=existing/);
    assert.equal(probes(f), "");
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    assert.equal(g.dispatch([...g.spawnArgs, "--role", "coder"], { PATH: pathWith(g.bin) }).status, 0);
    const r = g.dispatch([...g.spawnArgs, "--role", "coder"], { ...poison, PATH: pathWith(g.bin) });
    assert.equal(r.status, 8, r.stderr);
    assert.equal(readFileSync(g.env.OPEN_LOG! + ".calls", "utf8"), "open\n");
  } finally { g.cleanup(); }
});

test("managed: resolver refusals stop BEFORE any spawn effect (exit 4 / exit 10)", { skip }, () => {
  const cases: Array<[string, (f: Fx) => [string[], NodeJS.ProcessEnv], number, RegExp]> = [
    ["explicit documented-retired model", (f) => [explicit(f, "codex"), { PATH: pathWith(f.bin), AIGENTRY_CODEX_MODEL: "gpt-5.4" }],
      4, /MODEL_TUPLE_INCOMPATIBLE/],
    ["declared executable whose basename is not the cli (no basename bypass, delta C2)", (f) => {
      mkdirSync(join(f.root, "native/versions"), { recursive: true });
      const v = fakeCli(join(f.root, "native/versions/2.1.283"), "native");
      return [explicit(f, "claude"), { PATH: pathWith(f.bin), AIGENTRY_CLAUDE_EXECUTABLE: v }];
    }, 4, /MODEL_TUPLE_INCOMPATIBLE/],
    ["auto route whose table model is documented retired, no promotion", (f) => {
      const profile = join(f.root, "retired-profile.md");
      writeFileSync(profile, readFileSync(PROFILE, "utf8").replace('model: "gpt-6-astra"', 'model: "gpt-5.4"'));
      return [[...f.spawnArgs, "--role", "coder"], { PATH: pathWith(f.bin), AIGENTRY_ROUTER_PROFILE: profile }];
    }, 10, /MODEL_NO_ELIGIBLE_TUPLE/],
  ];
  for (const [name, make, exit, code] of cases) {
    const f = fixture();
    try {
      const [args, env] = make(f);
      const r = f.dispatch(args, env);
      assert.equal(r.status, exit, `${name}: ${r.stderr}`);
      assert.match(r.stderr, code, name);
      assertNothingSpawned(f, r);
    } finally { f.cleanup(); }
  }
});

// Test-owned fault seam: active only in a process whose argv carries `--resolve`.
const PRELOAD = String.raw`
const fs = require('node:fs');
if (process.argv.includes('--resolve')) {
  const mode = process.env.FAULT_MODE;
  fs.appendFileSync(process.env.FAULT_MARK, 'fired ' + mode + '\n');
  const out = (s) => fs.writeSync(1, s);
  if (mode === 'crash') throw new Error('injected resolver crash');
  if (mode === 'malformed') { out('not json\n'); process.exit(0); }
  if (mode === 'exit4') { out('garbage\n'); process.exit(4); }
  if (mode === 'exit10') { out(JSON.stringify({ refusal: { code: 'MODEL_NO_ELIGIBLE_TUPLE', reason: 'injected' } }) + '\n'); process.exit(10); }
  if (mode === 'hang') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000); process.exit(0); }
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    try {
      const v = JSON.parse(String(chunk));
      if (v && v.decision) {
        if (mode === 'wrong-sid') v.decision.sid = 'other-sid';
        if (mode === 'wrong-task') v.decision.task = '9999';
        if (mode === 'wrong-cli') v.decision.cli = v.decision.cli === 'claude' ? 'codex' : 'claude';
        if (mode === 'observed') v.decision.observed = { model: 'claude-opus-5-5', observed_by: 'worker' };
        fs.appendFileSync(process.env.FAULT_MARK, 'mutated ' + mode + '\n');
        chunk = JSON.stringify(v) + '\n';
      }
    } catch {}
    return write(chunk, ...rest);
  };
}
`;

for (const [mode, exits] of [["crash", [10]], ["malformed", [10]], ["exit4", [4]], ["exit10", [10]], ["wrong-sid", [4, 10]],
  ["wrong-task", [4, 10]], ["wrong-cli", [4, 10]], ["observed", [4, 10]], ["hang", [4, 10]]] as const) {
  test(`managed: resolver fault '${mode}' refuses before spawn, never a legacy fallback`, { skip }, () => {
    const f = fixture();
    try {
      const preload = join(f.root, "fault-preload.cjs"), mark = join(f.root, "fault-mark");
      writeFileSync(preload, PRELOAD);
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(REPO, "dist/src/dispatch/cli.js"), "--ref", f.ref, "--task", TASK,
        "--no-verify-started", "--timeout-ms", "500", ...explicit(f, "claude")], { cwd: f.root, encoding: "utf8", timeout: 90000,
        env: { ...f.env, PATH: pathWith(f.bin), NODE_OPTIONS: `--require "${preload}"`, FAULT_MODE: mode, FAULT_MARK: mark } });
      const marks = existsSync(mark) ? readFileSync(mark, "utf8") : "";
      assert.match(marks, new RegExp(`fired ${mode}`), "the fault reached a resolver subprocess");
      if (mode.startsWith("wrong-") || mode === "observed") assert.match(marks, /mutated/, "the resolver decision was mutated");
      assert.ok((exits as readonly number[]).includes(r.status ?? -1), `exit ${r.status} ∉ ${exits}: ${r.stderr}`);
      assertNothingSpawned(f, r);
      if (mode === "hang") assert.ok(Date.now() - started < 60000, "a hung resolver is bounded by its own timeout");
    } finally { f.cleanup(); }
  });
}

/** npm global layout (claude 2.1.198, known by its package.json) first; native installer symlink second. */
function layouts(f: Fx) {
  rmSync(join(f.bin, "claude"));
  const pkg = join(f.root, "npm/lib/node_modules/@anthropic-ai/claude-code");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(f.root, "npm/bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.198", bin: { claude: "cli.js" } }));
  fakeCli(join(pkg, "cli.js"), "npm");
  symlinkSync(join(pkg, "cli.js"), join(f.root, "npm/bin/claude"));
  mkdirSync(join(f.root, "native/versions"), { recursive: true });
  mkdirSync(join(f.root, "native/bin"), { recursive: true });
  const nativeFile = fakeCli(join(f.root, "native/versions/2.1.283"), "native");
  symlinkSync(nativeFile, join(f.root, "native/bin/claude"));
  return { npm: join(f.root, "npm/bin/claude"), npmReal: realpathSync(join(pkg, "cli.js")),
    native: join(f.root, "native/bin/claude"), nativeReal: realpathSync(nativeFile),
    path: pathWith(join(f.root, "npm/bin"), join(f.root, "native/bin"), f.bin) };
}

test("managed: stale first PATH hit is skipped; native realpath bound; version never read from a file name", { skip }, () => {
  const f = fixture();
  try {
    const l = layouts(f);
    const { exe, audit, cmd } = assertManaged(f, f.dispatch(explicit(f, "claude"), { PATH: l.path, AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5" }), "claude");
    assert.deepEqual([exe.path, exe.realpath, cmd[0]], [l.native, l.nativeReal, l.nativeReal]);
    assert.deepEqual([exe.version, exe.versionSource], [null, "unknown"], "`versions/2.1.283` is not a version source");
    assert.ok(JSON.stringify(audit).includes("2.1.198"), "the skipped stale hit is recorded");
  } finally { f.cleanup(); }
});

test("managed: only incompatible executables → refused (exit 4), no fallback; a declared exe has no PATH fallback", { skip }, () => {
  for (const which of ["only-npm-on-path", "declared-npm"] as const) {
    const f = fixture();
    try {
      const l = layouts(f);
      const env: NodeJS.ProcessEnv = which === "only-npm-on-path"
        ? { PATH: pathWith(join(f.root, "npm/bin"), f.bin), AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5" }
        : { PATH: l.path, AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5", AIGENTRY_CLAUDE_EXECUTABLE: l.npm };
      const r = f.dispatch(explicit(f, "claude"), env);
      assert.equal(r.status, 4, `${which}: ${r.stderr}`);
      assert.match(r.stderr, /MODEL_TUPLE_INCOMPATIBLE/);
      assertNothingSpawned(f, r);
    } finally { f.cleanup(); }
  }
});

test("managed: declared native exe wins over the first hit; its declared version needs a matching identity", { skip }, () => {
  for (const changed of [false, true]) {
    const f = fixture();
    try {
      const l = layouts(f);
      const st = statSync(l.nativeReal);
      const declaration = JSON.stringify({ version: "2.1.283", dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
      if (changed) appendFileSync(l.nativeReal, "// replaced after the declaration\n");
      const { exe, audit } = assertManaged(f, f.dispatch(explicit(f, "claude"), { PATH: l.path, AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5",
        AIGENTRY_CLAUDE_EXECUTABLE: l.native, AIGENTRY_CLAUDE_EXECUTABLE_VERSION: declaration }), "claude");
      assert.deepEqual([exe.path, exe.realpath], [l.native, l.nativeReal]);
      assert.deepEqual([audit.requested.executable, audit.requested.source], [l.native, "env"]);
      assert.deepEqual([exe.version, exe.versionSource], changed ? [null, "unknown"] : ["2.1.283", "operator-declared"],
        changed ? "a changed file resets the declared version to unknown" : "identity-matched declaration");
    } finally { f.cleanup(); }
  }
});

test("managed: --observe launch-failure binds {model, min_version} only and skips the known-lower exe", { skip }, () => {
  for (const observe of [false, true]) {
    const f = fixture();
    try {
      const l = layouts(f);
      const file = join(f.root, "launch-failure.json");
      writeFileSync(file, JSON.stringify({ at: "2026-09-27T11:19:29.786Z", status: "provider-version-incompatible-before-task-execution",
        observed: "API 400: Claude Code 2.1.198 requires 2.1.290 or newer for claude-sonnet-5" }));
      const { exe } = assertManaged(f, f.dispatch([...explicit(f, "claude"), ...(observe ? ["--observe", file] : [])],
        { PATH: l.path, AIGENTRY_CLAUDE_MODEL: "claude-sonnet-5" }), "claude");
      assert.equal(exe.realpath, observe ? l.nativeReal : l.npmReal);
      if (!observe) assert.deepEqual([exe.version, exe.versionSource], ["2.1.198", "npm-package-metadata"]);
    } finally { f.cleanup(); }
  }
});

test("managed: an executable replaced after sealing refuses at the runner (SANDBOX_EXECUTABLE_CHANGED), never rebinds", { skip }, () => {
  const f = fixture();
  try {
    const { exe } = assertManaged(f, f.dispatch(explicit(f, "claude"), { PATH: pathWith(f.bin) }), "claude");
    const current = JSON.parse(readFileSync(join(f.aig, "sessions", SID, "sandbox-current.json"), "utf8"));
    appendFileSync(exe.realpath, "// swapped between prepare and run\n");
    const r = spawnSync(process.execPath, [join(REPO, "dist/src/session/worker-sandbox-runner.js"), current.manifest, current.hash],
      { cwd: f.root, env: f.env, encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /SANDBOX_EXECUTABLE_CHANGED/);
    assert.equal(existsSync(f.env.WORK_LOG!), false, "the replaced file never ran");
  } finally { f.cleanup(); }
});

test("legacy guard kept: a versioned native file as argv[0] still fails SANDBOX_COMMAND_BINDING", { skip }, async () => {
  const f = fixture();
  try {
    const sandbox = await import(pathToFileURL(join(REPO, "dist/src/session/worker-sandbox.js")).href);
    mkdirSync(join(f.root, "native/versions"), { recursive: true });
    const v = fakeCli(join(f.root, "native/versions/2.1.283"), "native");
    const staging = join(f.root, "staging");
    mkdirSync(staging);
    const scope = { version: 1, task: TASK, sid: SID, read: [join(f.root, "project")], write: [join(f.root, "project")], domains: [] };
    assert.throws(() => sandbox.prepareWorkerSandbox(scope, "claude", join(f.root, "project"), [v, "--model", "m"], staging),
      /SANDBOX_COMMAND_BINDING/);
    assert.equal(existsSync(join(staging, "sandbox")), false, "refused before any staging write");
  } finally { f.cleanup(); }
});

// ── U3 boot-prepare reader (direct) ────────────────────────────────────────
function resolved(f: Fx, cli: "claude" | "codex", sid: string, env: NodeJS.ProcessEnv = {}): Rec {
  const r = spawnSync(process.execPath, [ROUTER, "--resolve", "--cli", cli, "--sid", sid, "--task", TASK],
    { cwd: f.root, env: { ...f.env, PATH: pathWith(f.bin), ...env }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, `resolver: ${r.stderr}${r.stdout}`);
  const out = JSON.parse(r.stdout) as Rec;
  assert.ok(out.decision, `resolver emitted a decision: ${r.stdout}`);
  return out.decision as Rec;
}
const boot = (f: Fx, cli: string, decision: unknown, env: NodeJS.ProcessEnv = {}) => f.boot(cli, { PATH: pathWith(f.bin),
  AIGENTRY_TASK_ID: TASK, AIGENTRY_SPAWN_DECISION: typeof decision === "string" ? decision : JSON.stringify(decision), ...env });

test("U3: a malformed or mis-bound AIGENTRY_SPAWN_DECISION exits 2 before any boot effect", { skip }, () => {
  const f = fixture();
  try {
    const good = resolved(f, "claude", "adapter-fixture");
    const other = resolved(f, "claude", "other-sid");
    for (const [name, cli, decision, env] of [
      ["malformed JSON", "claude", "{", {}],
      ["sid mismatch", "claude", other, {}],
      ["task mismatch", "claude", good, { AIGENTRY_TASK_ID: "9999" }],
      ["task missing", "claude", good, { AIGENTRY_TASK_ID: "" }],
      ["cli mismatch", "codex", good, {}],
    ] as const) {
      const r = boot(f, cli, decision, env);
      assert.equal(r.status, 2, `${name}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "", `${name}: no prepared output`);
      assert.equal(probes(f), "", `${name}: no probe`);
    }
    assert.equal(existsSync(f.env.WORK_LOG!), false);
  } finally { f.cleanup(); }
});

test("U3: null model / null effort omit their flags even with inherited env; argv[0] is the bound path", { skip }, () => {
  for (const cli of ["claude", "codex"] as const) {
    const f = fixture();
    try {
      const d = resolved(f, cli, "adapter-fixture");
      d.model = null;
      d.effort = { ...d.effort, token: null, state: "omitted" };
      const upper = cli.toUpperCase();
      const r = boot(f, cli, d, { [`AIGENTRY_${upper}_MODEL`]: "leaked-model", [`AIGENTRY_${upper}_EFFORT`]: "xhigh" });
      assert.equal(r.status, 0, r.stderr);
      const prepared = JSON.parse(r.stdout) as Rec, argv = prepared.argv as string[];
      assert.equal(argv[0], d.executable.path);
      assertSingleFlags(argv, cli);
      for (const banned of ["--model", "-m", "--effort", "leaked-model", "xhigh"]) assert.equal(argv.includes(banned), false, `${banned} in ${argv}`);
      assert.equal(argv.some((a) => a.startsWith("model_reasoning_effort=")), false);
      assert.equal(prepared.decision?.sid, "adapter-fixture", "boot output adds the decision");
      assert.ok(prepared.launch && prepared.launch.v === 2 && prepared.launch.cli === cli, "#1162 launch kept");
      assert.equal(probes(f), "", "no version/capability probe under a decision");
    } finally { f.cleanup(); }
  }
});

test("legacy kept: no decision → boot-prepare argv carries today's literals", { skip }, () => {
  const f = fixture();
  try {
    const r = f.boot("claude", { PATH: pathWith(f.bin) });
    assert.equal(r.status, 0, r.stderr);
    const prepared = JSON.parse(r.stdout) as Rec, argv = prepared.argv as string[];
    assert.deepEqual([argv[0], flag(argv, "--model"), flag(argv, "--effort")], ["claude", "claude-opus-5", "xhigh"]);
    assert.equal(prepared.decision, undefined);
  } finally { f.cleanup(); }
});

test("packaging: the resolver siblings ship and #1166 inventory stays listed", () => {
  const manifest = readFileSync(join(REPO, "bin/init/manifest.mjs"), "utf8");
  for (const file of ["bin/request-capture-inventory.mjs", "bin/boot-prepare.mjs", "bin/model-router.mjs",
    "bin/model-resolve.mjs", "bin/model-evidence.mjs", "docs/model-profiles/model-catalog.json"]) {
    assert.ok(manifest.includes(`"${file}"`), `init manifest lists ${file}`);
    assert.ok(existsSync(join(REPO, file)), `${file} exists`);
  }
  const files = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).files as string[];
  assert.ok(files.includes("docs/model-profiles/model-catalog.json"), "package files ship the catalog");
});
