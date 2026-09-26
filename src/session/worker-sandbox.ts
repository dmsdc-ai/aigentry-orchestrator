import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface WorkerScope {
  version: 1;
  task: string;
  sid: string;
  read: string[];
  write: string[];
  domains: string[];
}

export interface WorkerManifest {
  version: 1;
  task: string;
  sid: string;
  attempt: string;
  cli: string;
  cwd: string;
  command: string[];
  env: Record<string, string>;
  config: SandboxRuntimeConfig;
  probeFile: string;
  receipt: string;
}

const identity = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
export const digest = (s: string): string => createHash("sha256").update(s).digest("hex");
const within = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

function canonical(p: unknown): string {
  if (typeof p !== "string" || !path.isAbsolute(p) || /[\0\r\n*?\[\]{}]/.test(p)) {
    throw new Error("SANDBOX_SCOPE_PATH: expected an absolute literal path");
  }
  let parent = p;
  const tail: string[] = [];
  while (!fs.existsSync(parent)) {
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error("SANDBOX_SCOPE_PATH: no existing parent");
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...tail);
}

function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("SANDBOX_SCOPE_PATHS");
  return [...new Set(value.map(canonical))];
}

export function loadWorkerScope(file: string | undefined, task: string, sid: string): WorkerScope {
  if (!file) throw new Error("SANDBOX_SCOPE_REQUIRED: set AIGENTRY_WORKER_SCOPE to a task-bound scope file");
  const s = JSON.parse(fs.readFileSync(file, "utf8")) as WorkerScope;
  if (s.version !== 1 || s.task !== task || s.sid !== sid || !identity.test(sid) || !task) {
    throw new Error("SANDBOX_SCOPE_BINDING: task/sid/version mismatch");
  }
  if (!Array.isArray(s.domains) || s.domains.length > 64 || s.domains.some(d =>
    typeof d !== "string" || !/^(?:\*\.)?[a-z0-9][a-z0-9.-]*:443$/.test(d) ||
    /(?:^|\.)(?:localhost|local)(?=:)/.test(d) || /^\d/.test(d))) {
    throw new Error("SANDBOX_SCOPE_DOMAINS: HTTPS public hostnames only");
  }
  const read = paths(s.read), write = paths(s.write);
  const home = fs.realpathSync(os.homedir());
  for (const p of [...read, ...write]) {
    if (p === path.parse(p).root || p === home || within(home, p)) throw new Error("SANDBOX_SCOPE_TOO_BROAD");
  }
  return { version: 1, task, sid, read, write, domains: [...new Set(s.domains)] };
}

function executable(name: string): string {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.isAbsolute(name) ? name : path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return fs.realpathSync(p); } catch { /* next path */ }
  }
  throw new Error(`SANDBOX_EXECUTABLE_MISSING: ${name}`);
}

function writePrivate(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
}

function seedAuth(cli: string, home: string, cwd: string): Record<string, string> {
  const realHome = os.homedir();
  if (cli === "codex") {
    const config = path.join(home, ".codex");
    const source = path.join(process.env.CODEX_HOME || path.join(realHome, ".codex"), "auth.json");
    writePrivate(path.join(config, "auth.json"), fs.readFileSync(source, "utf8"));
    writePrivate(path.join(config, "config.toml"),
      `check_for_update_on_startup = false\n[sandbox_workspace_write]\nexclude_slash_tmp = true\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
    return { CODEX_HOME: config };
  }
  if (cli === "claude") {
    const config = path.join(home, ".claude");
    const source = path.join(realHome, ".claude", ".credentials.json");
    const auth = fs.existsSync(source) ? fs.readFileSync(source, "utf8") :
      execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
    JSON.parse(auth);
    writePrivate(path.join(config, ".credentials.json"), auth);
    writePrivate(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
      projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    return { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  }
  throw new Error(`SANDBOX_AUTH_UNSUPPORTED: ${cli}; no unrestricted fallback`);
}

export function prepareWorkerSandbox(scope: WorkerScope, cli: string, roleCwd: string,
  argv: string[], stagingRoot: string, targetCwd = roleCwd,
  hooksDir?: string): { launcher: string; manifest: string; hash: string } {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("SANDBOX_PLATFORM_UNSUPPORTED");
  if (!["claude", "codex"].includes(cli)) throw new Error(`SANDBOX_CLI_UNSUPPORTED: ${cli}`);
  if (!argv.length || path.basename(argv[0]!) !== cli) throw new Error("SANDBOX_COMMAND_BINDING");
  const cwd = canonical(roleCwd);
  const attempt = randomUUID();
  const root = canonical(path.join(stagingRoot, "sandbox", attempt));
  const home = path.join(root, "home");
  // Keep SRT Unix socket names below sockaddr_un's path limit on macOS.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir().startsWith("/var/folders") ? "/tmp" : os.tmpdir()), "agw-"));
  fs.chmodSync(tmp, 0o700);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const authEnv = seedAuth(cli, home, cwd);
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { mode: 0o700 });
  const patchBinary = executable("apply_patch");
  fs.symlinkSync(patchBinary, path.join(localBin, "apply_patch"));
  const shared = path.join(home, ".telepty", "shared");
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const hookCopy = path.join(root, "git-hooks");
  if (hooksDir) writePrivate(path.join(hookCopy, "pre-push"), fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8"));
  if (hooksDir) fs.chmodSync(path.join(hookCopy, "pre-push"), 0o700);
  const realCli = executable(argv[0]!);
  const runner = fileURLToPath(new URL("./worker-sandbox-runner.js", import.meta.url));
  const probeFile = path.join(root, "outside-canary.txt");
  writePrivate(probeFile, "sandbox boundary canary; not a user secret\n");
  const receipt = path.join(root, "receipt.json");
  let command = [realCli, ...argv.slice(1)];
  if (cli === "codex") {
    command = command.filter(a => a !== "--dangerously-bypass-approvals-and-sandbox");
    // The protected supervisor applies the full-process OS sandbox first.
    // macOS refuses nesting Codex's Seatbelt inside that enforced boundary.
    command.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
    for (const p of scope.write) command.push("--add-dir", fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p));
  } else {
    const i = command.indexOf("--permission-mode");
    if (i >= 0) command.splice(i, 2);
    command.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-chrome");
    for (const p of scope.write) command.push("--add-dir", fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p));
  }
  const protectedPaths = [root, stagingRoot, runner, path.dirname(runner)];
  for (const p of scope.write) {
    if (protectedPaths.some(x => within(x, p) || within(p, x))) throw new Error("SANDBOX_POLICY_WRITABLE");
  }
  // Do not inherit host credentials, sockets, hooks, NODE_OPTIONS or shell startup files.
  const childEnv: Record<string, string> = {
    HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLAUDE_CODE_TMPDIR: tmp,
    PATH: `${localBin}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`, SHELL: "/bin/bash",
    TERM: process.env.TERM || "xterm-256color", LANG: process.env.LANG || "en_US.UTF-8",
    AIGENTRY_WORKER_SESSION: "1", AIGENTRY_TASK_ID: scope.task,
    AIGENTRY_WORKER_SESSION_ID: scope.sid, AIGENTRY_WORKER_ATTEMPT: attempt,
    AIGENTRY_TARGET_CWD: canonical(targetCwd),
    ...(hooksDir ? { AIGENTRY_GIT_HOOKS_DIR: hookCopy, GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hookCopy } : {}),
    ...authEnv,
  };
  const read = [...scope.read, ...scope.write, cwd, home, tmp, realCli, patchBinary,
    fs.realpathSync(process.execPath)];
  if (hooksDir) read.push(hookCopy);
  const promptIndex = argv.indexOf("--append-system-prompt-file");
  if (promptIndex >= 0) read.push(canonical(argv[promptIndex + 1]));
  // Whole-process isolation includes native file tools and every local child/MCP.
  // Local control sockets and direct non-proxy network access remain unavailable.
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: scope.domains, deniedDomains: [], allowUnixSockets: [],
      allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: { denyRead: [os.homedir(), "/Users", "/home", "/Volumes", "/private/tmp", "/tmp"],
      allowRead: read, allowWrite: [...scope.write, home, tmp],
      denyWrite: [cwd, path.join(home, ".telepty"), "/tmp/claude", "/private/tmp/claude",
        path.join(home, ".codex", "config.toml"), path.join(home, ".claude", "settings.json")] },
    allowPty: true, allowAppleEvents: false, enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  };
  const m: WorkerManifest = { version: 1, task: scope.task, sid: scope.sid, attempt, cli, cwd,
    command, env: childEnv, config, probeFile, receipt };
  const data = JSON.stringify(m, null, 2) + "\n";
  const manifest = path.join(root, "manifest.json"), hash = digest(data);
  writePrivate(manifest, data);
  const launcher = path.join(root, "launcher.sh");
  writePrivate(launcher, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(runner)} ${quote(manifest)} ${quote(hash)}\n`);
  fs.chmodSync(launcher, 0o700);
  const current = path.join(stagingRoot, "sandbox-current.json");
  const next = `${current}.${attempt}`;
  writePrivate(next, JSON.stringify({ manifest, hash }));
  fs.renameSync(next, current);
  return { launcher, manifest, hash };
}

export function assertConfinedTarget(stagingRoot: string, sid: string, task: string): void {
  const current = JSON.parse(fs.readFileSync(path.join(stagingRoot, "sandbox-current.json"), "utf8"));
  const raw = fs.readFileSync(current.manifest, "utf8");
  if (digest(raw) !== current.hash) throw new Error("SANDBOX_MANIFEST_CHANGED");
  const m = JSON.parse(raw) as WorkerManifest;
  const r = JSON.parse(fs.readFileSync(m.receipt, "utf8"));
  if (m.sid !== sid || m.task !== task || r.hash !== current.hash || r.attempt !== m.attempt || r.state !== "running") {
    throw new Error("SANDBOX_TARGET_NOT_RUNNING");
  }
  process.kill(r.supervisorPid, 0);
  process.kill(r.childPid, 0);
}

/**
 * Match telepty's content-addressed ref without exposing other sessions' refs.
 *
 * Returns the recipient-absolute path of the staged copy. The recipient's own
 * `~` resolves against the HOST home, which the whole-process sandbox denies
 * reading, so a tilde-rooted descriptor names a file the worker can never open.
 * The caller needs this absolute path to address the bytes it just staged.
 */
export function stageWorkerRef(stagingRoot: string, sid: string, task: string, refFile: string): string {
  assertConfinedTarget(stagingRoot, sid, task);
  const current = JSON.parse(fs.readFileSync(path.join(stagingRoot, "sandbox-current.json"), "utf8"));
  const raw = fs.readFileSync(current.manifest, "utf8");
  if (digest(raw) !== current.hash) throw new Error("SANDBOX_MANIFEST_CHANGED");
  const m = JSON.parse(raw) as WorkerManifest;
  if (m.sid !== sid || m.task !== task) throw new Error("SANDBOX_REF_BINDING");
  const body = fs.readFileSync(refFile, "utf8");
  if (!body.trim()) throw new Error("SANDBOX_REF_EMPTY");
  // Address the ref inside the recipient's sealed HOME only. There is no host
  // fallback: an unusable HOME is a refusal, never a path the worker cannot read.
  const recipientHome = m.env.HOME;
  if (typeof recipientHome !== "string" || !recipientHome || !path.isAbsolute(recipientHome)) {
    throw new Error("SANDBOX_REF_HOME: manifest env.HOME is not an absolute path");
  }
  const file = path.join(recipientHome, ".telepty", "shared", `${digest(body)}.md`);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") !== body) throw new Error("SANDBOX_REF_CHANGED");
  } else {
    writePrivate(file, body);
  }
  return file;
}
