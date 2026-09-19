import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { WorkerManifest } from "../../src/session/worker-sandbox.js";

export const REPO = resolve(import.meta.dirname, "../../..");
export const PROFILE = join(REPO, "tests/dispatch/fixtures/model-routing-profile.md");
export const ROUTER = join(REPO, "bin/model-router.mjs");
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "model-router-1083-")));
  const bin = join(root, "bin"), home = join(root, "home"), aig = join(root, "aig");
  const ref = join(root, "ref.md"), queue = join(root, "queue.json");
  for (const dir of [bin, home, join(home, ".claude"), join(root, "codex-home"), join(root, "tmp"), join(aig, "instructions/roles"), join(root, "state"), join(root, "project")]) mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    const file = join(bin, name);
    const shebang = process.platform === "win32" ? "#!/usr/bin/env node\n" : "#!" + process.execPath + "\n";
    writeFileSync(file, shebang + body + "\n", { mode: 0o755 });
    return file;
  };
  writeFileSync(join(home, ".claude.json"), "{}");
  writeFileSync(join(home, ".claude/.credentials.json"), '{"fixture":true}');
  writeFileSync(join(root, "codex-home/auth.json"), '{"fixture":true}');
  writeFileSync(join(root, "scope.json"), JSON.stringify({ version: 1, task: "1083", sid: "router-fixture",
    read: [join(root, "project")], write: [join(root, "project")], domains: [] }));
  writeFileSync(join(aig, "instructions/common.md"), "# COMMON\nFIXTURE-COMMON\n");
  writeFileSync(join(aig, "instructions/roles/coder.md"), "# CODER\nFIXTURE-ROLE\n");
  writeFileSync(ref, "Implement the fixture router. TASK-FIRST-4KB\n");
  writeFileSync(queue, JSON.stringify({ tasks: [{ id: 1083, status: "pending", note: "seed" }] }));
  writeFileSync(join(root, "state/active.json"), '{"schema_version":2,"generation":0,"dispatches":[]}');
  const classifier = script("classifier", `
const fs = require('node:fs');
fs.appendFileSync(process.env.COUNTER, 'call\\n');
fs.writeFileSync(process.env.PROMPT_LOG, fs.readFileSync(0, 'utf8'));
fs.writeFileSync(process.env.CLASSIFIER_ARGS, JSON.stringify({ argv: process.argv.slice(2),
  env: { MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS, CLAUDE_EFFORT: process.env.CLAUDE_EFFORT } }));
if (process.env.CLASSIFIER_HANG === '1') setInterval(() => {}, 1000);
else { process.stdout.write(process.env.CLASSIFIER_REPLY || 'invalid'); process.exit(Number(process.env.CLASSIFIER_EXIT || 0)); }
`);
  for (const cli of ["claude", "codex", "gemini", "grok", "agy"]) script(cli, `
if (process.argv.length === 3 && process.argv[2] === '--version') console.log('9.9.9');
else if (${JSON.stringify(cli)} === 'agy' && process.argv.length === 3 && process.argv[2] === '--help') console.log('--model --dangerously-skip-permissions --prompt-interactive');
else { require('node:fs').appendFileSync(process.env.WORK_LOG, 'model\\n'); console.error('TEST TRIPWIRE: attempted real CLI launch'); process.exit(99); }
`);
  const telepty = script("telepty", `
if (process.argv[2] === 'list') console.log(process.env.LIVE_SESSIONS || JSON.stringify([{id: 'router-fixture', command: process.env.OBSERVED_CLI || 'codex'}]));
else if (process.argv[2] === 'inject') {
  require('node:fs').writeFileSync(process.env.PARENT_MODEL_LOG, process.env.AIGENTRY_CODEX_MODEL || '');
  console.log('stub inject OK');
}
else process.exit(99);
`);
  const open = script("open-session", `
const fs = require('node:fs'), path = require('node:path');
fs.appendFileSync(process.env.OPEN_LOG + '.calls', 'open\\n');
require('node:fs').writeFileSync(process.env.OPEN_LOG, JSON.stringify({args: process.argv.slice(2),
  model: process.env.AIGENTRY_CODEX_MODEL, grokModel: process.env.AIGENTRY_GROK_MODEL}));
// Synthetic existence receipt only: no terminal, model or sandbox runner is started.
const current = JSON.parse(fs.readFileSync(path.join(process.env.AIGENTRY_SESSIONS_ROOT, 'router-fixture/sandbox-current.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(current.manifest, 'utf8'));
fs.writeFileSync(manifest.receipt, JSON.stringify({ hash: current.hash, attempt: manifest.attempt,
  state: 'running', supervisorPid: Number(process.env.FIXTURE_CHILD_PID), childPid: Number(process.env.FIXTURE_CHILD_PID) }));
`);
  const probe = script("probe", "console.log('{\"ready\":true}')");
  const telemetry = script("telemetry", "require('node:fs').appendFileSync(process.env.TELEMETRY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')");
  // #1109: hermetic — the operator's ambient AIGENTRY_* knobs (CLI_CAP_*, *_MODEL, *_EFFORT, WORKSPACE_HOST, ...)
  // must never reach the child; everything the fixture needs is declared below, and `overrides` still win.
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"].includes(k.toUpperCase())));
  let fixturePath = `${bin}:${process.env.PATH}`;
  if (process.platform === "win32") {
    const inheritedPath = Object.entries(ambient).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    const inheritedPathExt = Object.entries(ambient).find(([key]) => key.toUpperCase() === "PATHEXT")?.[1];
    for (const key of Object.keys(ambient)) {
      if (key.toUpperCase() === "PATH" || key.toUpperCase() === "PATHEXT") delete ambient[key];
    }
    fixturePath = [bin, dirname(process.execPath), inheritedPath ?? ""].join(delimiter);
    ambient.PATHEXT = `;${inheritedPathExt || ".EXE;.CMD;.BAT;.COM"}`;
  }
  const env: NodeJS.ProcessEnv = { ...ambient, HOME: home, USERPROFILE: home, AIGENTRY_HOME: aig,
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"), PYTHONDONTWRITEBYTECODE: "1",
    AIGENTRY_WORKER_SCOPE: join(root, "scope.json"), WORK_LOG: join(root, "work.log"),
    PATH: fixturePath, TELEPTY: telepty, OPEN_SESSION_SH: open, SESSION_PROBE_PY: probe,
    EMIT_TELEMETRY_MJS: telemetry, AIGENTRY_TASK_QUEUE: queue, AIGENTRY_TASK_GATE: "hard",
    AIGENTRY_SESSIONS_ROOT: join(aig, "sessions"), DISPATCH_STATE_DIR: join(root, "state"),
    AIGENTRY_GIT_HOOKS_DIR: join(root, "hooks"), AIGENTRY_GIT_HOOK_SOURCE_DIR: join(REPO, "git-hooks"),
    CODEX_HOME: join(root, "codex-home"), GEMINI_CLI_HOME: join(root, "gemini-home"),
    AIGENTRY_ROUTER_PROFILE: PROFILE, AIGENTRY_ROUTER_CLASSIFIER: classifier,
    AIGENTRY_CLAUDE_MODEL: "", AIGENTRY_CODEX_MODEL: "", AIGENTRY_GROK_MODEL: "", AIGENTRY_GEMINI_MODEL: "",
    AIGENTRY_GEMINI_BINARY: "agy", AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS: "0",
    AIGENTRY_SHIM_SCRIPT_DIR: "", DISPATCH_SCRIPT_DIR: "", DISPATCH_REGISTRY_PY: join(REPO, "bin/dispatch-registry.py"),
    COUNTER: join(root, "counter"), PROMPT_LOG: join(root, "prompt"), CLASSIFIER_ARGS: join(root, "classifier-args"),
    PARENT_MODEL_LOG: join(root, "parent-model"),
    CLASSIFIER_REPLY: '{"label":"gpt-6-astra","reason":"implementation","confidence":0.9}',
    CLASSIFIER_EXIT: "0", CLASSIFIER_HANG: "0", OPEN_LOG: join(root, "open.json"), TELEMETRY_LOG: join(root, "telemetry.jsonl") };
  for (const command of ["apply_patch", "ps", "kill", "pkill", "killall", "launchctl", "open", "osascript", "cmux", "tmux", "curl", "wget", "ssh", "npm", "npx", "srt"])
    script(command, "require('node:fs').appendFileSync(process.env.WORK_LOG, 'forbidden\\n'); process.exit(99)");
  script("git", "process.exit(1)");
  if (process.platform !== "win32") script("node", "const r = require('node:child_process').spawnSync(process.execPath, process.argv.slice(2), {stdio:'inherit'}); process.exit(r.status ?? 99)");
  env.REPORT_TARGET_SH = script("report-target", "console.log('fixture-orchestrator')");
  let child: ChildProcess | undefined;
  const childPid = () => {
    child ??= spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { env: { HOME: home, USERPROFILE: home }, stdio: "ignore" });
    assert.ok(child.pid, "fixture owns a harmless live child");
    return child.pid;
  };
  const manifest = (): WorkerManifest => {
    const current = JSON.parse(readFileSync(join(aig, "sessions/router-fixture/sandbox-current.json"), "utf8"));
    const raw = readFileSync(current.manifest, "utf8");
    assert.equal(createHash("sha256").update(raw).digest("hex"), current.hash);
    const m = JSON.parse(raw) as WorkerManifest;
    assert.deepEqual([m.task, m.sid], ["1083", "router-fixture"]);
    assert.deepEqual(m.config.network?.allowedDomains, []);
    assert.equal(m.config.network?.allowAllUnixSockets, false);
    assert.equal(m.config.network?.allowLocalBinding, false);
    assert.equal(m.env.AIGENTRY_WORKER_ATTEMPT, m.attempt);
    assert.equal(m.config.enableWeakerNestedSandbox, false);
    assert.equal(m.config.enableWeakerNetworkIsolation, false);
    assert.deepEqual(m.config.network?.allowUnixSockets, []);
    assert.equal(m.env.AIGENTRY_TARGET_CWD, join(root, "project"));
    const auth = m.cli === "codex" ? join(m.env.CODEX_HOME!, "auth.json") : join(m.env.CLAUDE_CONFIG_DIR!, ".credentials.json");
    assert.deepEqual(JSON.parse(readFileSync(auth, "utf8")), { fixture: true });
    assert.ok(m.config.filesystem?.allowWrite?.includes(join(root, "project")));
    assert.equal(existsSync(env.WORK_LOG!), false, "no model/work operation");
    return m;
  };
  const prepareTarget = (sid = "router-fixture", task = "1083") => {
    // This hand-written receipt proves PID existence only, never ownership or OS enforcement.
    const staging = join(env.AIGENTRY_SESSIONS_ROOT!, sid), workerHome = join(staging, "fixture-home");
    mkdirSync(join(workerHome, ".telepty/shared"), { recursive: true });
    const receipt = join(staging, "receipt.json"), file = join(staging, "manifest.json");
    const raw = JSON.stringify({ version: 1, sid, task, attempt: "fixture-attempt", env: { HOME: workerHome }, receipt });
    const hash = createHash("sha256").update(raw).digest("hex"), pid = childPid();
    writeFileSync(file, raw);
    writeFileSync(join(staging, "sandbox-current.json"), JSON.stringify({ manifest: file, hash }));
    writeFileSync(receipt, JSON.stringify({ hash, attempt: "fixture-attempt", state: "running", supervisorPid: pid, childPid: pid }));
  };
  const boot = (cli: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [join(REPO, "bin/boot-prepare.mjs"), "--cli", cli, "--role", "coder", "--sid", "adapter-fixture", "--cwd", join(root, "project"), "--confined"],
    { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000 });
  const router = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [ROUTER, "--role", "coder", "--profile", PROFILE, ...args], { cwd: REPO, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000 });
  const dispatch = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [join(REPO, "dist/src/dispatch/cli.js"), "--ref", ref, "--task", "1083", "--no-verify-started", "--timeout-ms", "500", ...args],
    { cwd: root, env: { ...env, FIXTURE_CHILD_PID: String(childPid()), ...overrides }, encoding: "utf8", timeout: 22000 });
  // #1084: a live worker shows up in `telepty list` as its guard launcher; the CLI kind is its `exec -a` line.
  const liveLauncher = (cli: string) => { const file = join(root, `live-${cli}-launcher.sh`); writeFileSync(file, `#!/usr/bin/env bash\nexec -a ${cli} ${cli} "$@"\n`); return file; };
  return { root, bin, aig, ref, queue, env, script, router, dispatch, liveLauncher, manifest, prepareTarget, boot,
    spawnArgs: ["--spawn-and-dispatch", "--track", "router", "--name", "fixture", "--cwd", join(root, "project")],
    calls: () => { try { return readFileSync(env.COUNTER!, "utf8").trim().split("\n").length; } catch { return 0; } },
    cleanup: () => {
      child?.kill();
      try { assert.equal(existsSync(env.WORK_LOG!), false, "model/work tripwire must remain untouched"); }
      finally { rmSync(root, { recursive: true, force: true }); }
    } };
}
