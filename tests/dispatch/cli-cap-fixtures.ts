// #1148 cap-regression fixtures — strict-TS port of the independently authored
// cv1148af harness, adopted into the repository test tree.
//
// What stays REAL: the compiled production dispatch CLI is executed as a real
// subprocess and makes the whole cap decision itself. `cliCap`/`applyCliCap` are
// module-private in that CLI and are NOT stubbed, imported or re-implemented
// here. The route, the cap comparison, the fallback pick and every emitted line
// come out of the artifact under test. Acceptance reads the product's own
// audited `dispatch_start` telemetry payload and the task-queue note the run
// wrote; stderr is corroboration only.
//
// What is FAKED, and why — these are process/provider boundaries, never the cap
// decision:
//   telepty            live-session inventory + inject transport, so no real PTY,
//                      session or worker is created. LIVE_SESSIONS is the only
//                      input the cap counter reads: exactly the seam under test.
//   open-session.sh    worker spawn. Records launcher env and writes the
//                      supervisor receipt stand-in; never launches the launcher.
//   session-probe.py   readiness probe: nothing real to probe.
//   emit-telemetry     appends argv to a log; this IS the acceptance channel.
//   dispatch-registry  this tree DOES ship bin/dispatch-registry.py, so the stub
//                      is pointed at via DISPATCH_REGISTRY_PY to keep the real
//                      typed writer off real registry state — not because the
//                      component is missing. It honours only the dedup rc
//                      contract (0 fresh / 7 duplicate) and nothing else, and it
//                      runs before the cap decision. The release registry seam
//                      (registryAvailable/registryInvocation, src/dispatch/
//                      registry-command.ts) is REAL and unstubbed: the stub is an
//                      0o755 regular file, so registryAvailable's X_OK+isFile
//                      check passes, and registryInvocation on POSIX returns the
//                      script path with argv unmodified.
//   git / apply_patch  inert stubs, so no host Git runs and the real sandbox
//                      preparation does not die at SANDBOX_EXECUTABLE_MISSING.
//   claude/codex/gemini/grok/agy
//                      tripwire stubs that exit 99 if a real provider launch is
//                      ever attempted — no provider, auth or network.
//   provider credentials
//                      synthetic files only, so the real seedAuth() never falls
//                      through to the login keychain. They authenticate nothing.
//
// REAL and unstubbed through the spawn arm: bin/boot-prepare.mjs, the boot
// adapter, installWorkerGitGuard(), prepareWorkerSandbox(), assertConfinedTarget()
// and stageWorkerRef().

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Derived from the COMPILED location (dist/tests/dispatch/ -> repo root), so the
// suite carries no absolute user path and runs from any checkout. The two env
// overrides exist so one unchanged file can be pointed at a second tree for
// baseline/candidate comparison; neither has a hard-coded default.
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = process.env.CAP_REPO || resolve(HERE, "../../..");
export const PROFILE = join(REPO, "tests/dispatch/fixtures/model-routing-profile.md");
export const CLI_JS = process.env.CAP_CLI_JS || join(REPO, "dist/src/dispatch/cli.js");

/** The route object the product records in its own `dispatch_start` payload. */
export interface RoutePayload {
  label?: string;
  model?: string;
  decided_by: string;
  reason?: string;
  capped_cli?: string;
}

/** The audited `dispatch_start` payload. */
export interface DispatchStartPayload {
  mode?: string;
  cli: string;
  route: RoutePayload;
}

export interface ExistingTarget {
  sid: string;
  sealedHome: string;
  stagingRoot: string;
}

export function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cap-1148-"));
  const bin = join(root, "bin"), home = join(root, "home"), aig = join(root, "aig");
  const ref = join(root, "ref.md"), queue = join(root, "queue.json");
  for (const dir of [bin, home, join(aig, "instructions/roles"), join(root, "state"), join(root, "project")])
    mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string): string => {
    const file = join(bin, name);
    writeFileSync(file, "#!/usr/bin/env node\n" + body + "\n", { mode: 0o755 });
    return file;
  };
  writeFileSync(join(home, ".claude.json"), "{}");

  // Synthetic provider auth. prepareWorkerSandbox() -> seedAuth() is real product
  // code and reads a credential source; os.homedir() honours HOME, which is this
  // fixture home. The claude branch only falls through to the login keychain when
  // the credentials file is absent, so seeding it keeps that branch unreached.
  // These bytes are synthetic and are a credential for nothing.
  mkdirSync(join(home, ".claude"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, ".claude/.credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "FIXTURE-NOT-A-CREDENTIAL", expiresAt: 4102444800000 } }), { mode: 0o600 });
  mkdirSync(join(root, "codex-home"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "codex-home/auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "FIXTURE-NOT-A-CREDENTIAL" }), { mode: 0o600 });
  writeFileSync(join(aig, "instructions/common.md"), "# COMMON\nFIXTURE-COMMON\n");
  writeFileSync(join(aig, "instructions/roles/coder.md"), "# CODER\nFIXTURE-ROLE\n");
  writeFileSync(ref, "Implement the fixture router. TASK-FIRST-4KB\n");
  writeFileSync(queue, JSON.stringify({ tasks: [{ id: 1083, status: "pending", note: "seed" }] }));
  writeFileSync(join(root, "state/active.json"), '{"schema_version":2,"generation":0,"dispatches":[]}');

  // One bounded keepalive child backs every recorded PID. The real
  // assertConfinedTarget() does process.kill(pid, 0) on the supervisor and child
  // PIDs, so they must be live; no real worker or supervisor is ever started.
  // cleanup() kills and awaits exactly this owned child — never a pattern kill.
  const children: ChildProcess[] = [];
  const keepalive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
  children.push(keepalive);
  const spawnStagingRoot = join(aig, "sessions", "router-fixture");

  const classifier = script("classifier", `
const fs = require('node:fs');
fs.appendFileSync(process.env.COUNTER, 'call\\n');
fs.writeFileSync(process.env.PROMPT_LOG, fs.readFileSync(0, 'utf8'));
if (process.env.CLASSIFIER_HANG === '1') setInterval(() => {}, 1000);
else { process.stdout.write(process.env.CLASSIFIER_REPLY || 'invalid'); process.exit(Number(process.env.CLASSIFIER_EXIT || 0)); }
`);

  // Tripwires: a real provider CLI launch fails the test loudly.
  for (const cli of ["claude", "codex", "gemini", "grok", "agy"]) script(cli, `
if (process.argv[2] === '--version') console.log('9.9.9');
else if (process.argv[2] === '--help') console.log('--model --dangerously-skip-permissions --prompt-interactive');
else { console.error('TEST TRIPWIRE: attempted real CLI launch'); process.exit(99); }
`);

  const telepty = script("telepty", `
if (process.argv[2] === 'list') console.log(process.env.LIVE_SESSIONS || JSON.stringify([{id: 'router-fixture', command: process.env.OBSERVED_CLI || 'codex'}]));
else if (process.argv[2] === 'inject') {
  const fs = require('node:fs');
  fs.writeFileSync(process.env.PARENT_MODEL_LOG, process.env.AIGENTRY_CODEX_MODEL || '');
  fs.writeFileSync(process.env.INJECT_ARGS, JSON.stringify(process.argv.slice(2)));
  console.log('stub inject OK');
}
else process.exit(99);
`);

  // Fake open-session: records the launcher env (the model export assertion
  // channel) and stands in for the supervisor's receipt ONLY. It never launches
  // the launcher, so no provider CLI, PTY or worker is created. The receipt it
  // writes mirrors what the real supervisor records, so the REAL, unstubbed
  // assertConfinedTarget()/stageWorkerRef() then run against genuine
  // product-written manifest + sandbox-current.json. It makes no cap or route
  // decision: by the time it runs, the CLI has already decided and emitted both.
  const open = script("open-session", `
const fs = require('node:fs'), path = require('node:path');
fs.writeFileSync(process.env.OPEN_LOG, JSON.stringify({args: process.argv.slice(2),
  model: process.env.AIGENTRY_CODEX_MODEL, claudeModel: process.env.AIGENTRY_CLAUDE_MODEL,
  geminiModel: process.env.AIGENTRY_GEMINI_MODEL, grokModel: process.env.AIGENTRY_GROK_MODEL}));
try {
  const cur = JSON.parse(fs.readFileSync(path.join(process.env.SPAWN_STAGING_ROOT, 'sandbox-current.json'), 'utf8'));
  const m = JSON.parse(fs.readFileSync(cur.manifest, 'utf8'));
  const pid = Number(process.env.KEEPALIVE_PID);
  fs.writeFileSync(m.receipt, JSON.stringify({
    hash: cur.hash, attempt: m.attempt, state: 'running', supervisorPid: pid, childPid: pid,
  }), { mode: 0o600 });
} catch { /* target arm: no fresh sandbox staged by this run */ }
`);

  const probe = script("probe", "console.log('{\"ready\":true}')");
  const telemetry = script("telemetry", "require('node:fs').appendFileSync(process.env.TELEMETRY_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')");

  // Inert registry. This tree DOES ship bin/dispatch-registry.py; DISPATCH_REGISTRY_PY
  // below redirects the seam here so the real typed writer never touches real
  // registry state. Honours the dedup contract the CLI branches on (rc 0 fresh /
  // rc 7 duplicate) and nothing else. Makes no routing or cap decision.
  // script() writes mode 0o755, which is what registryAvailable() requires on POSIX.
  const registry = script("registry", `
const fs = require('node:fs'), a = process.argv.slice(2), cmd = a[0];
const get = (f) => { const i = a.indexOf(f); return i < 0 ? '' : a[i + 1]; };
fs.appendFileSync(process.env.REGISTRY_LOG, JSON.stringify(a) + '\\n');
const db = process.env.REGISTRY_DB;
const load = () => { try { return JSON.parse(fs.readFileSync(db, 'utf8')); } catch { return {}; } };
if (cmd === 'check-dedup') {
  const s = load(), k = get('--sid') + '|' + get('--ref-hash');
  if (s[k]) process.exit(7);
  process.exit(0);
}
if (cmd === 'begin-delivery') {
  const s = load(); s[get('--sid') + '|' + get('--ref-hash')] = 1;
  fs.writeFileSync(db, JSON.stringify(s));
  process.stdout.write(JSON.stringify({ result: 'DISPATCH_BEGUN', sid: get('--sid') }) + '\\n');
  process.exit(0);
}
process.exit(0);
`);

  // Inert git: keeps beginDelivery's branch probe off any real repository.
  script("git", "console.log('fixture-branch')");

  // Inert apply_patch: worker-sandbox resolves and symlinks it into the sealed
  // HOME. Never executed by this suite; present only so the REAL sandbox
  // preparation does not die at SANDBOX_EXECUTABLE_MISSING.
  script("apply_patch", "process.exit(0)");

  // Real (not faked) worker scope: the product validates this file itself
  // (version/task/sid binding, absolute literal paths, HTTPS-only domains).
  // sid is `${track}-${name}` = "router-fixture"; task is --task 1083.
  const scopeFile = join(root, "scope.json");
  writeFileSync(scopeFile, JSON.stringify({
    version: 1, task: "1083", sid: "router-fixture",
    // Must not be an ancestor of HOME (the product rejects SANDBOX_SCOPE_TOO_BROAD),
    // so scope the project/aigentry/state subtrees rather than the fixture root.
    read: [join(root, "project"), aig, join(root, "state")],
    // The writable set must not overlap the staging root, which lives at
    // <aig>/sessions/<sid>; the REAL prepareWorkerSandbox() rejects that with
    // SANDBOX_POLICY_WRITABLE. aig stays readable, and the spawn arm only needs
    // project/state writable. Product check honoured, not relaxed.
    write: [join(root, "project"), join(root, "state")],
    domains: ["api.anthropic.com:443"],
  }));

  // Hermetic: the operator's ambient AIGENTRY_* knobs (CLI_CAP_*, *_MODEL, ...)
  // must never reach the child, or a host that caps codex would silently rewrite
  // these results. Everything needed is declared below; `overrides` still win.
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AIGENTRY_")));
  const env: NodeJS.ProcessEnv = {
    ...ambient, HOME: home, TMPDIR: join(root, "tmp"), AIGENTRY_HOME: aig,
    PATH: `${bin}:${process.env.PATH ?? ""}`, TELEPTY: telepty, OPEN_SESSION_SH: open, SESSION_PROBE_PY: probe,
    EMIT_TELEMETRY_MJS: telemetry, AIGENTRY_TASK_QUEUE: queue, AIGENTRY_TASK_GATE: "hard",
    AIGENTRY_SESSIONS_ROOT: join(aig, "sessions"), DISPATCH_STATE_DIR: join(root, "state"),
    AIGENTRY_GIT_HOOKS_DIR: join(root, "hooks"), AIGENTRY_GIT_HOOK_SOURCE_DIR: join(REPO, "git-hooks"),
    CODEX_HOME: join(root, "codex-home"), GEMINI_CLI_HOME: join(root, "gemini-home"),
    AIGENTRY_ROUTER_PROFILE: PROFILE, AIGENTRY_ROUTER_CLASSIFIER: classifier,
    AIGENTRY_CLAUDE_MODEL: "", AIGENTRY_CODEX_MODEL: "", AIGENTRY_GROK_MODEL: "", AIGENTRY_GEMINI_MODEL: "",
    AIGENTRY_GEMINI_BINARY: "agy", AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS: "0",
    AIGENTRY_WORKER_SCOPE: scopeFile,
    AIGENTRY_SHIM_SCRIPT_DIR: "", DISPATCH_SCRIPT_DIR: "", DISPATCH_REGISTRY_PY: registry,
    REGISTRY_LOG: join(root, "registry.log"), REGISTRY_DB: join(root, "registry.json"),
    COUNTER: join(root, "counter"), PROMPT_LOG: join(root, "prompt"),
    PARENT_MODEL_LOG: join(root, "parent-model"), INJECT_ARGS: join(root, "inject-args.json"),
    CLASSIFIER_REPLY: '{"label":"gpt-6-astra","reason":"implementation","confidence":0.9}',
    CLASSIFIER_EXIT: "0", CLASSIFIER_HANG: "0", OPEN_LOG: join(root, "open.json"),
    TELEMETRY_LOG: join(root, "telemetry.jsonl"),
    SPAWN_STAGING_ROOT: spawnStagingRoot, KEEPALIVE_PID: String(keepalive.pid),
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  writeFileSync(env.REGISTRY_LOG!, "");

  const dispatch = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> =>
    spawnSync(process.execPath,
      [CLI_JS, "--ref", ref, "--task", "1083", "--no-verify-started", "--timeout-ms", "500", ...args],
      { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 22000 });

  // A live worker shows up in `telepty list` as its guard launcher; the CLI kind
  // is its `exec -a` line.
  const liveLauncher = (cli: string): string => {
    const file = join(root, `live-${cli}-launcher.sh`);
    writeFileSync(file, `#!/usr/bin/env bash\nexec -a ${cli} ${cli} "$@"\n`);
    return file;
  };

  // assertConfinedTarget() is REAL product code and is not stubbed: it verifies
  // sandbox-current.json -> manifest (hash-matched) -> receipt (state=running,
  // attempt/hash agreement) and then process.kill(pid, 0) on both recorded PIDs.
  // So this builds a genuinely well-formed staging root and backs the PIDs with
  // the one bounded child that cleanup() kills and joins.
  const makeExistingTarget = (cli = "claude"): ExistingTarget => {
    const sid = "router-fixture";
    const stagingRoot = join(aig, "sessions", sid);
    const sealedHome = join(stagingRoot, "sandbox", "home");
    mkdirSync(sealedHome, { recursive: true });
    const attempt = "attempt-ci1148aj";
    const receipt = join(stagingRoot, "receipt.json");
    const manifestFile = join(stagingRoot, "manifest.json");
    const manifest = JSON.stringify({
      version: 1, task: "1083", sid, attempt, cli, cwd: join(root, "project"),
      command: [cli], env: { HOME: sealedHome }, config: {},
      probeFile: join(stagingRoot, "probe.json"), receipt,
    });
    const hash = createHash("sha256").update(manifest).digest("hex");
    writeFileSync(manifestFile, manifest);
    writeFileSync(receipt, JSON.stringify({
      hash, attempt, state: "running", supervisorPid: keepalive.pid, childPid: keepalive.pid,
    }));
    writeFileSync(join(stagingRoot, "sandbox-current.json"), JSON.stringify({ manifest: manifestFile, hash }));
    return { sid, sealedHome, stagingRoot };
  };

  return {
    root, bin, aig, ref, queue, env, script, dispatch, liveLauncher, makeExistingTarget,
    spawnArgs: ["--spawn-and-dispatch", "--track", "router", "--name", "fixture", "--cwd", join(root, "project")],
    calls: (): number => {
      try { return readFileSync(env.COUNTER!, "utf8").trim().split("\n").length; } catch { return 0; }
    },
    // Bounded + joined: every child this fixture started is killed and awaited,
    // and the fixture root is removed even when the test failed. No pattern or
    // process-tree kill is ever used.
    cleanup: async (): Promise<void> => {
      for (const c of children) {
        if (c.exitCode === null && c.signalCode === null) {
          c.kill("SIGKILL");
          await new Promise<void>((res) => { c.on("exit", () => res()); });
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type CapFixture = ReturnType<typeof fixture>;

/**
 * N live sessions of one CLI: row 0 is a bare CLI (orchestrator), the rest are
 * guard launchers.
 *
 * The fake `telepty list` answers TWO distinct product queries — the cap
 * inventory (liveCliCounts) and the post-spawn registration lookup, which
 * requires the dispatched sid to be present or the run exits 6. So n === 0 still
 * registers the sid, with a command that is not a provider CLI: cliKindOf()
 * classifies only claude/codex/grok/gemini/agy or an `exec -a <cli>` launcher,
 * so "bash" contributes 0 to every count. The cap inventory is still exactly n.
 */
export function liveRows(f: CapFixture, cli: string, n: number): string {
  if (n === 0) return JSON.stringify([{ id: "router-fixture", command: "bash" }]);
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({
    id: i === 0 ? "router-fixture" : `live-${i}`,
    command: i === 0 ? cli : f.liveLauncher(cli),
  })));
}

/** The dispatch_start telemetry payload + the queue note the run actually wrote. */
export function audit(f: CapFixture): { payload: DispatchStartPayload; note: string } {
  const events = readFileSync(f.env.TELEMETRY_LOG!, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const event = events.find((e) => e[e.indexOf("--subtype") + 1] === "dispatch_start");
  if (!event) throw new Error(`no dispatch_start telemetry event was emitted:\n${events.map((e) => JSON.stringify(e)).join("\n")}`);
  return {
    payload: JSON.parse(event[event.indexOf("--payload-json") + 1]!) as DispatchStartPayload,
    note: (JSON.parse(readFileSync(f.queue, "utf8")) as { tasks: { note: string }[] }).tasks[0]!.note,
  };
}
