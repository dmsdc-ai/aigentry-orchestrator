import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { isCliKind, type LaunchConfig } from "./boot-adapter/types.js";
import { normalizeLaunch } from "./boot-adapter/launch-config.js";
import { CLAUDE_OAUTH_DIR, selectedClaudeOAuthToken, writeClaudeOAuthHandoff } from "./claude-worker-oauth.js";
import { sameFileIdentity, type ExecutableBinding } from "./model-decision.js";

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
  probeDirectory: string;
  receipt: string;
  // #652 non-secret marker: exact path of the private token handoff the runner
  // reads for the worker child only. Absent when the opt-in is unset.
  claudeOAuthHandoff?: string;
  // #1162 configured LaunchConfig v2, sealed by the manifest hash. Absent in
  // older manifests: readers then report model/effort unknown.
  launch?: LaunchConfig;
  /** #1148: resolver-bound executable identity, sealed by the manifest hash. Absent on legacy spawns. */
  executable?: ExecutableBinding;
}

/**
 * #1148 U4: the bound file must still be the one the resolver chose — same realpath and
 * the same stat identity. A stat check, not an atomic open: it narrows, it does not
 * eliminate, a replace-between-check-and-exec window.
 */
export function assertExecutableIdentity(binding: ExecutableBinding, file: string): void {
  let real: string, st: fs.Stats;
  try { real = fs.realpathSync(file); st = fs.statSync(real); } catch { throw new Error("SANDBOX_EXECUTABLE_CHANGED"); }
  if (real !== binding.realpath || !st.isFile() || !sameFileIdentity(binding, st)) throw new Error("SANDBOX_EXECUTABLE_CHANGED");
}

/**
 * #652: a bound file with no version evidence (versionSource "unknown") that is a text script
 * whose `#!` interpreter (or the argument to `env`) is a shell is a wrapper (e.g. a terminal's
 * PATH shim), not the CLI: sealed, the sandbox would exec a launcher whose target it cannot read.
 * node/python `#!` wrappers are deliberately out of scope until the resolver can follow them.
 * Reads the first bytes only; the script is never executed or parsed.
 */
const WRAPPER_SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"];
export function assertNotCliWrapper(binding: ExecutableBinding): void {
  if (binding.versionSource !== "unknown") return;
  const head = Buffer.alloc(512);
  let n: number, fd: number | undefined;
  try {
    fd = fs.openSync(binding.realpath, "r");
    n = fs.readSync(fd, head, 0, head.length, 0);
  } catch {
    throw new Error("SANDBOX_EXECUTABLE_CHANGED");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  const text = head.subarray(0, n);
  const line = /^#!\s*(\S+)(?:[ \t]+(\S+))?/.exec(text.toString("latin1"));
  const interpreter = !line ? "" : path.basename(line[1]!) === "env" ? path.basename(line[2] ?? "") : path.basename(line[1]!);
  if (text[0] === 0x23 && text[1] === 0x21 && !text.includes(0) && WRAPPER_SHELLS.includes(interpreter)) {
    throw new Error(`SANDBOX_CLI_WRAPPER: ${JSON.stringify(binding.path)} is a #! script wrapper, not the ${binding.cli} ` +
      `executable; put the real ${binding.cli} binary first on PATH`);
  }
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

export function writePrivate(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600, flag: "wx" });
}

// #652 confined Claude worker built-in tools: one closed set, passed as both the
// available set (--tools) and the pre-approved set (--allowedTools). Unlisted
// built-ins (Agent, Task, Workflow, TodoWrite, ...) are not provisioned. CLI flags
// do not prevent child processes: Bash remains, inside the same OS sandbox.
export const CLAUDE_WORKER_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch";
// Caller tool-policy overrides, refused (never stripped/merged) as `flag` or `flag=value`.
export const CLAUDE_TOOL_POLICY_FLAGS = ["--tools", "--allowedTools", "--allowed-tools",
  "--disallowedTools", "--disallowed-tools", "--agent", "--agents", "--settings"] as const;
// Pure: first argv[1..] token that is exactly a refused flag or `flag=...`; returns the flag name only.
export function claudeToolPolicyViolation(argv: readonly string[]): string | undefined {
  for (const a of argv.slice(1)) {
    const flag = CLAUDE_TOOL_POLICY_FLAGS.find(f => a === f || a.startsWith(f + "="));
    if (flag) return flag;
  }
  return undefined;
}

function seedAuth(cli: string, home: string, cwd: string, oauthSelected = false): Record<string, string> {
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
    // #652: an opted-in worker token replaces the host credential copy entirely;
    // neither .credentials.json nor the Keychain is read, so no refresh token is shared.
    if (!oauthSelected) {
      const source = path.join(realHome, ".claude", ".credentials.json");
      const auth = fs.existsSync(source) ? fs.readFileSync(source, "utf8") :
        execFileSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).trim();
      // Refuse a selected source that carries no credential material at all, before
      // any seed write. Purely syntactic: it does not ask the provider anything and
      // does not judge freshness, so an expired access token with a refresh token
      // still passes. Either token alone suffices; neither is a refusal. The error
      // is a fixed string so no credential byte, path or parser detail can leak.
      const record = (v: unknown): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && !Array.isArray(v);
      const material = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
      let parsed: unknown;
      try { parsed = JSON.parse(auth); } catch { throw new Error("SANDBOX_AUTH_INVALID_SEED"); }
      const oauth = record(parsed) ? parsed.claudeAiOauth : undefined;
      if (!record(oauth) || !(material(oauth.accessToken) || material(oauth.refreshToken))) {
        throw new Error("SANDBOX_AUTH_INVALID_SEED");
      }
      writePrivate(path.join(config, ".credentials.json"), auth);
    }
    writePrivate(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
      projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
    return { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  }
  throw new Error(`SANDBOX_AUTH_UNSUPPORTED: ${cli}; no unrestricted fallback`);
}

export function prepareWorkerSandbox(scope: WorkerScope, cli: string, roleCwd: string,
  argv: string[], stagingRoot: string, targetCwd = roleCwd,
  hooksDir?: string, launch?: LaunchConfig, binding?: ExecutableBinding): { launcher: string; manifest: string; hash: string } {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("SANDBOX_PLATFORM_UNSUPPORTED");
  if (!["claude", "codex"].includes(cli)) throw new Error(`SANDBOX_CLI_UNSUPPORTED: ${cli}`);
  if (!argv.length || path.basename(argv[0]!) !== cli) throw new Error("SANDBOX_COMMAND_BINDING");
  // #652: before any staging write or auth seeding. Names the flag only, never its value.
  if (cli === "claude") {
    const flag = claudeToolPolicyViolation(argv);
    if (flag) throw new Error(`SANDBOX_TOOL_ARG: ${flag}`);
  }
  // #1148 U4: a managed spawn names its executable exactly; checked before any sandbox effect.
  if (binding) {
    if (binding.cli !== cli || argv[0] !== binding.path || !path.isAbsolute(argv[0]!)) throw new Error("SANDBOX_COMMAND_BINDING");
    assertExecutableIdentity(binding, binding.path);
    assertNotCliWrapper(binding);
  }
  // #652: validated before any staging write. Claude only; codex never reads it.
  const oauthToken = cli === "claude" ? selectedClaudeOAuthToken(process.env) : undefined;
  const cwd = canonical(roleCwd);
  const attempt = randomUUID();
  const root = canonical(path.join(stagingRoot, "sandbox", attempt));
  const home = path.join(root, "home");
  // Keep SRT Unix socket names below sockaddr_un's path limit on macOS.
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir().startsWith("/var/folders") ? "/tmp" : os.tmpdir()), "agw-"));
  fs.chmodSync(tmp, 0o700);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const authEnv = seedAuth(cli, home, cwd, oauthToken !== undefined);
  // Outside HOME and outside allowRead; the token itself never enters the manifest.
  const oauthHandoff = oauthToken === undefined ? undefined :
    writeClaudeOAuthHandoff(path.join(root, CLAUDE_OAUTH_DIR), oauthToken);
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { mode: 0o700 });
  // #652: apply_patch is on PATH only under a Codex host. Optional helper: when absent,
  // no symlink and no allowRead entry; the real CLI below still fails closed.
  let patchBinary: string | undefined;
  try { patchBinary = executable("apply_patch"); } catch { patchBinary = undefined; }
  if (patchBinary) fs.symlinkSync(patchBinary, path.join(localBin, "apply_patch"));
  const shared = path.join(home, ".telepty", "shared");
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  const hookCopy = path.join(root, "git-hooks");
  if (hooksDir) writePrivate(path.join(hookCopy, "pre-push"), fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8"));
  if (hooksDir) fs.chmodSync(path.join(hookCopy, "pre-push"), 0o700);
  const realCli = executable(argv[0]!);
  const runner = fileURLToPath(new URL("./worker-sandbox-runner.js", import.meta.url));
  const binder = fileURLToPath(new URL("./worker-sandbox-bind.js", import.meta.url));
  const probeFile = path.join(root, "outside-canary.txt");
  writePrivate(probeFile, "sandbox boundary canary; not a user secret\n");
  const probeDirectory = path.join(root, "outside-directory-canary");
  fs.mkdirSync(probeDirectory, { mode: 0o700 });
  writePrivate(path.join(probeDirectory, "synthetic.txt"), "synthetic metadata boundary canary\n");
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
    command.push("--permission-mode", "acceptEdits", "--tools", CLAUDE_WORKER_TOOLS, "--allowedTools", CLAUDE_WORKER_TOOLS,
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
  const read = [...scope.read, ...scope.write, cwd, home, tmp, realCli, ...(patchBinary ? [patchBinary] : []),
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
  // #1148 U4: fresh pre-seal re-check; the identity is sealed inside the hashed manifest.
  if (binding) {
    if (realCli !== binding.realpath) throw new Error("SANDBOX_EXECUTABLE_CHANGED");
    assertExecutableIdentity(binding, realCli);
  }
  const m: WorkerManifest = { version: 1, task: scope.task, sid: scope.sid, attempt, cli, cwd,
    command, env: childEnv, config, probeFile, probeDirectory, receipt,
    ...(oauthHandoff ? { claudeOAuthHandoff: oauthHandoff } : {}),
    ...(launch && isCliKind(cli) ? { launch: normalizeLaunch(cli, launch) } : {}),
    ...(binding ? { executable: binding } : {}) };
  const data = JSON.stringify(m, null, 2) + "\n";
  const manifest = path.join(root, "manifest.json"), hash = digest(data);
  writePrivate(manifest, data);
  const launcher = path.join(root, "launcher.sh");
  // #1162 pane binding runs before the OS sandbox, as the same host process chain
  // as the runner. Its failure only leaves metadata unsupported; the worker starts.
  writePrivate(launcher, `#!/usr/bin/env bash\n${quote(process.execPath)} ${quote(binder)} ${quote(manifest)} ${quote(hash)} ||` +
    ` echo "agent-meta: binding unavailable rc=$?" >&2\n` +
    `exec ${quote(process.execPath)} ${quote(runner)} ${quote(manifest)} ${quote(hash)}\n`);
  fs.chmodSync(launcher, 0o700);
  const current = path.join(stagingRoot, "sandbox-current.json");
  const next = `${current}.${attempt}`;
  writePrivate(next, JSON.stringify({ manifest, hash }));
  fs.renameSync(next, current);
  return { launcher, manifest, hash };
}

export function assertConfinedTarget(stagingRoot: string, sid: string, task: string): void {
  if (!identity.test(sid)) throw new Error("SANDBOX_TARGET_SID");
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

// ── #1162 sealed pane binding ───────────────────────────────────────────────
export interface TerminalBinding {
  v: 1;
  sid: string;
  task: string;
  attempt: string;
  manifest_hash: string;
  workspace_id: string;
  surface_id: string;
  terminal_lifecycle_id: string;
}

/**
 * The exact tuple a caller captured once and expects to still address: a stale-write
 * guard for display metadata, never an identity or kill authority. All four fields,
 * because a rebinding keeps attempt/hash but replaces surface/lifecycle.
 */
export interface BindingPin {
  attempt: string;
  manifest_hash: string;
  surface_id: string;
  terminal_lifecycle_id: string;
}

/** Process ids from the validated running receipt: snapshot corroboration only. */
export interface BindingOwner {
  supervisor_pid: number;
  child_pid: number;
}

/**
 * missing = no sealed record or binding (unsupported); drift = a valid chain that
 * no longer matches the caller's pin; invalid = anything else.
 */
export class AgentBindingError extends Error {
  constructor(readonly code: "missing" | "invalid" | "drift", message: string) {
    super(message);
  }
}

export const BINDING_FILE = "terminal-binding.json";
export const BINDING_KEYS = ["v", "sid", "task", "attempt", "manifest_hash",
  "workspace_id", "surface_id", "terminal_lifecycle_id"] as const;
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(v);
const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(o, k));
const euid = (): number => (process.geteuid ? process.geteuid() : -1);

/** A real (non-symlink) directory owned by this user and not group/world accessible. */
export function assertPrivateDir(dir: string): void {
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { throw new AgentBindingError("invalid", "AGENT_BINDING_ROOT"); }
  if (!st.isDirectory() || st.uid !== euid() || (st.mode & 0o077) !== 0 || fs.realpathSync(dir) !== dir) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_ROOT");
  }
}

/**
 * Read a private file without following a final symlink: regular, owned by this
 * user, no group/world bits, at most `max` bytes. ENOENT is `missing` only when
 * the caller says absence means unsupported.
 */
export function readPrivate(file: string, max: number, absentIsMissing = false): string {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const missing = absentIsMissing && (e as NodeJS.ErrnoException).code === "ENOENT";
    throw new AgentBindingError(missing ? "missing" : "invalid", `AGENT_BINDING_FILE: ${path.basename(file)}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== euid() || (st.mode & 0o077) !== 0 || st.size > max) {
      throw new AgentBindingError("invalid", `AGENT_BINDING_FILE: ${path.basename(file)}`);
    }
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n <= max && (r = fs.readSync(fd, buf, n, max + 1 - n, null)) > 0;) n += r;
    if (n > max) throw new AgentBindingError("invalid", `AGENT_BINDING_FILE: ${path.basename(file)}`);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function parseJson(raw: string, what: string): unknown {
  try { return JSON.parse(raw); } catch { throw new AgentBindingError("invalid", `AGENT_BINDING_PARSE: ${what}`); }
}

/**
 * The sealed manifest for `manifestFile`, verified against `hash` and its own
 * canonical private root `<stage>/sandbox/<attempt>/`. The hash is integrity,
 * not authority. Returns the manifest and the stage it belongs to.
 */
export function readSealedManifest(manifestFile: string, hash: unknown): { m: WorkerManifest; root: string; stage: string } {
  if (!isHash(hash) || typeof manifestFile !== "string" || !path.isAbsolute(manifestFile) ||
      path.basename(manifestFile) !== "manifest.json") {
    throw new AgentBindingError("invalid", "AGENT_BINDING_MANIFEST_PATH");
  }
  const root = path.dirname(manifestFile);
  if (path.normalize(manifestFile) !== manifestFile || !isUuid(path.basename(root)) ||
      path.basename(path.dirname(root)) !== "sandbox") {
    throw new AgentBindingError("invalid", "AGENT_BINDING_MANIFEST_PATH");
  }
  assertPrivateDir(root);
  const raw = readPrivate(manifestFile, 1024 * 1024);
  if (digest(raw) !== hash) throw new AgentBindingError("invalid", "SANDBOX_MANIFEST_CHANGED");
  const m = parseJson(raw, "manifest");
  if (!isRecord(m) || m.version !== 1 || typeof m.sid !== "string" || !identity.test(m.sid) ||
      typeof m.task !== "string" || !m.task || m.attempt !== path.basename(root) ||
      typeof m.cli !== "string" || m.receipt !== path.join(root, "receipt.json")) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_MANIFEST");
  }
  return { m: m as unknown as WorkerManifest, root, stage: path.dirname(path.dirname(root)) };
}

/** `<stage>/sandbox-current.json`, exact keys; absent = no sealed session (missing). */
export function readSandboxCurrent(stage: string): { manifest: string; hash: string } {
  const c = parseJson(readPrivate(path.join(stage, "sandbox-current.json"), 4096, true), "current");
  if (!isRecord(c) || !exactKeys(c, ["manifest", "hash"]) || typeof c.manifest !== "string" || !isHash(c.hash)) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_CURRENT");
  }
  return { manifest: c.manifest, hash: c.hash };
}

/**
 * #1162 G2b: the pane binding of the CURRENT sealed attempt for `sid`, plus its
 * configured launch metadata. Every link is pinned: current → manifest (inside
 * this stage, hash-verified) → running receipt → binding (same sid/task/attempt/
 * hash). `expectedTask`, when given, must equal the sealed task; otherwise the
 * task comes from the sealed manifest, never from caller state. Only typed
 * fields are returned — no manifest env, auth or path.
 *
 * `opts.expect`: after the whole chain validates, all four pinned fields must
 * equal it, else `drift`. `opts.withOwner`: also return the running receipt's
 * supervisor/child pids (distinct safe integers > 1). Neither changes the default.
 */
export function readSealedAgentBinding(stagingRoot: string, sid: string, expectedTask?: string,
  opts: { expect?: BindingPin; withOwner?: boolean } = {}):
  { binding: TerminalBinding; launch: LaunchConfig; owner?: BindingOwner } {
  const pin = opts.expect;
  if (typeof stagingRoot !== "string" || !path.isAbsolute(stagingRoot) || !identity.test(sid) ||
      (expectedTask !== undefined && !expectedTask) ||
      (pin !== undefined && (!isUuid(pin.attempt) || !isHash(pin.manifest_hash) ||
        !isUuid(pin.surface_id) || !isUuid(pin.terminal_lifecycle_id)))) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_ARGS");
  }
  let stage: string;
  try { stage = fs.realpathSync(stagingRoot); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new AgentBindingError("missing", "AGENT_BINDING_STAGE");
    throw new AgentBindingError("invalid", "AGENT_BINDING_STAGE");
  }
  const stageStat = fs.statSync(stage);
  if (!stageStat.isDirectory() || stageStat.uid !== euid() || (stageStat.mode & 0o022) !== 0) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_STAGE");
  }
  const current = readSandboxCurrent(stage);
  const { m, root, stage: owner } = readSealedManifest(current.manifest, current.hash);
  if (owner !== stage) throw new AgentBindingError("invalid", "AGENT_BINDING_MANIFEST_PATH");
  if (m.sid !== sid || (expectedTask !== undefined && m.task !== expectedTask)) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_IDENTITY");
  }
  const r = parseJson(readPrivate(m.receipt, 4096), "receipt");
  if (!isRecord(r) || !exactKeys(r, ["state", "hash", "attempt", "supervisorPid", "childPid", "checkedAt"]) ||
      r.state !== "running" || r.hash !== current.hash || r.attempt !== m.attempt) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_RECEIPT");
  }
  const b = parseJson(readPrivate(path.join(root, BINDING_FILE), 4096, true), "binding");
  if (!isRecord(b) || !exactKeys(b, BINDING_KEYS) || b.v !== 1 || b.sid !== m.sid || b.task !== m.task ||
      b.attempt !== m.attempt || b.manifest_hash !== current.hash ||
      !isUuid(b.workspace_id) || !isUuid(b.surface_id) || !isUuid(b.terminal_lifecycle_id)) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_RECORD");
  }
  const binding: TerminalBinding = { v: 1, sid: m.sid, task: m.task, attempt: m.attempt,
    manifest_hash: current.hash, workspace_id: b.workspace_id, surface_id: b.surface_id,
    terminal_lifecycle_id: b.terminal_lifecycle_id };
  const cli = isCliKind(m.cli) ? m.cli : null;
  if (!cli) throw new AgentBindingError("invalid", "AGENT_BINDING_MANIFEST");
  if (pin !== undefined && (pin.attempt !== binding.attempt || pin.manifest_hash !== binding.manifest_hash ||
      pin.surface_id !== binding.surface_id || pin.terminal_lifecycle_id !== binding.terminal_lifecycle_id)) {
    throw new AgentBindingError("drift", "AGENT_BINDING_DRIFT");
  }
  // Old manifests carry no launch: model/effort stay explicit unknown.
  const launch = normalizeLaunch(cli, m.launch);
  if (!opts.withOwner) return { binding, launch };
  const pid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 1;
  if (!pid(r.supervisorPid) || !pid(r.childPid) || r.supervisorPid === r.childPid) {
    throw new AgentBindingError("invalid", "AGENT_BINDING_RECEIPT");
  }
  return { binding, launch, owner: { supervisor_pid: r.supervisorPid, child_pid: r.childPid } };
}
