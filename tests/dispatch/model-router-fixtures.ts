import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dirname, "../../..");
export const PROFILE = join(REPO, "tests/dispatch/fixtures/model-routing-profile.md");
export const ROUTER = join(REPO, "bin/model-router.mjs");
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "model-router-1083-"));
  const bin = join(root, "bin"), home = join(root, "home"), aig = join(root, "aig");
  const ref = join(root, "ref.md"), queue = join(root, "queue.json");
  for (const dir of [bin, home, join(aig, "instructions/roles"), join(root, "state"), join(root, "project")]) mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    const file = join(bin, name);
    writeFileSync(file, "#!/usr/bin/env node\n" + body + "\n", { mode: 0o755 });
    return file;
  };
  writeFileSync(join(home, ".claude.json"), "{}");
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
if (process.argv[2] === '--version') console.log('9.9.9');
else if (process.argv[2] === '--help') console.log('--model --dangerously-skip-permissions --prompt-interactive');
else { console.error('TEST TRIPWIRE: attempted real CLI launch'); process.exit(99); }
`);
  const telepty = script("telepty", `
if (process.argv[2] === 'list') console.log(JSON.stringify([{id: 'router-fixture', command: process.env.OBSERVED_CLI || 'codex'}]));
else if (process.argv[2] === 'inject') {
  require('node:fs').writeFileSync(process.env.PARENT_MODEL_LOG, process.env.AIGENTRY_CODEX_MODEL || '');
  console.log('stub inject OK');
}
else process.exit(99);
`);
  const open = script("open-session", `
require('node:fs').writeFileSync(process.env.OPEN_LOG, JSON.stringify({args: process.argv.slice(2),
  model: process.env.AIGENTRY_CODEX_MODEL, grokModel: process.env.AIGENTRY_GROK_MODEL}));
`);
  const probe = script("probe", "console.log('{\"ready\":true}')");
  const telemetry = script("telemetry", "require('node:fs').appendFileSync(process.env.TELEMETRY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, AIGENTRY_HOME: aig,
    PATH: `${bin}:${process.env.PATH}`, TELEPTY: telepty, OPEN_SESSION_SH: open, SESSION_PROBE_PY: probe,
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
  const router = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [ROUTER, "--role", "coder", "--profile", PROFILE, ...args], { cwd: REPO, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000 });
  const dispatch = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [join(REPO, "dist/src/dispatch/cli.js"), "--ref", ref, "--task", "1083", "--no-verify-started", "--timeout-ms", "500", ...args],
    { cwd: REPO, env: { ...env, ...overrides }, encoding: "utf8", timeout: 22000 });
  return { root, bin, aig, ref, queue, env, script, router, dispatch,
    spawnArgs: ["--spawn-and-dispatch", "--track", "router", "--name", "fixture", "--cwd", join(root, "project")],
    calls: () => { try { return readFileSync(env.COUNTER!, "utf8").trim().split("\n").length; } catch { return 0; } },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
