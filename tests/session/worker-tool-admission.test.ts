// #652 confined Claude worker tool admission: one closed built-in set for --tools and
// --allowedTools, and caller tool-policy overrides refused before any staging write.
//
// Drives bin/boot-prepare.mjs --confined (default adapter argv) and the REAL compiled
// prepareWorkerSandbox through the existing tests/dispatch/agent-metadata/support/prepare-sandbox.mjs
// driver, with a FAKE host HOME, FAKE credentials and FAKE CLIs. The launcher and the runner are
// never executed: nothing starts a provider CLI, reads the developer HOME or touches the network.
// These tests prove argv construction and refusal ordering only, never CLI acceptance or
// OS confinement.
// win32: the confined sandbox is unsupported by design. The same 6 integration tests assert the REAL
// SANDBOX_PLATFORM_UNSUPPORTED refusal before any write (fail closed), never Windows support. The boot
// fixture is portable exactly as in claude-worker-oauth.test.ts: PATH uses path.delimiter, and the
// version probe (spawn shell:false resolves only .com/.exe) is answered by a copy of this node.exe.
// The pure claudeToolPolicyViolation matrix runs on every OS: argv admission logic, not OS confinement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { CLAUDE_TOOL_POLICY_FLAGS, CLAUDE_WORKER_TOOLS, claudeToolPolicyViolation } from "../../src/session/worker-sandbox.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BOOT = join(REPO_ROOT, "bin", "boot-prepare.mjs");
const DIST = join(REPO_ROOT, "dist");
const DRIVER = join(REPO_ROOT, "tests", "dispatch", "agent-metadata", "support", "prepare-sandbox.mjs");
const TASK = "652";
const TOOLS = "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch";
const FLAGS = ["--tools", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--agent", "--agents", "--settings"];
const LOOKALIKES = ["--agent-like-unknown", "--agentsx", "--toolsy", "--settings-file", "--allowedToolsX",
  "--setting-sources=user", "-tools", "tools", "--append-system-prompt=--tools"];
const WIN = process.platform === "win32";
const UNSUPPORTED = "SANDBOX_PLATFORM_UNSUPPORTED";

/** The 9 attack forms per flag (8 x 9 = 72), shared by the integration tests and the pure matrix. */
function attackForms(argv: string[], flag: string, secret: string): string[][] {
  const json = `{"permissions":{"allow":["Agent"]},"k":"${secret}"}`;
  return [
    [...argv, flag, secret],                                    // trailing, separate value
    [...argv, `${flag}=${secret}`],                             // equals form
    [argv[0] ?? "claude", flag, json, ...argv.slice(1)],        // first position, JSON payload
    [...argv.slice(0, 3), `${flag}=${json}`, ...argv.slice(3)], // middle, equals JSON
    [...argv, flag, "Read", "Agent", secret],                   // variadic list
    [...argv, flag, "default", flag, secret],                   // repeated (no last-wins)
    [...argv, "positional prompt", flag, secret],               // after a positional
    [...argv, flag],                                            // bare flag, no value
    [...argv, `${flag}=`],                                      // empty equals
  ];
}

type Json = Record<string, unknown>;
const parse = (s: string): Json | null => { try { return JSON.parse(s) as Json; } catch { return null; } };
const read = (p: string): string => readFileSync(p, "utf8");
const fake = (k: string): string => `FAKE-sk-ant-${k}01-${randomUUID()}-NOT-A-SECRET`;

interface World {
  root: string; host: string; aig: string; bin: string; project: string; hostCreds: string; hostCodex: string;
  fakes: string[];
}

const roots: string[] = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// win32 only (as in claude-worker-oauth.test.ts): the boot version probe cannot run the extensionless
// fakes, so a copy of this node.exe on a later PATH entry answers it. It is never a worker command.
let probeDir = "";
function probeExeDir(): string {
  if (probeDir) return probeDir;
  const d = mkdtempSync(join(tmpdir(), "tool-admission-652-probe-"));
  roots.push(d);
  copyFileSync(process.execPath, join(d, "claude.exe"));
  try { linkSync(join(d, "claude.exe"), join(d, "codex.exe")); } catch { copyFileSync(process.execPath, join(d, "codex.exe")); }
  return (probeDir = d);
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "tool-admission-652-"));
  roots.push(root);
  const w = (p: string, d: string, m?: number): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d, m === undefined ? undefined : { mode: m });
  };
  const host = join(root, "host"), aig = join(root, "aig"), bin = join(root, "bin");
  // Fake CLIs answer --version only; they are never launched as workers here.
  for (const c of ["claude", "codex"]) {
    w(join(bin, c), `#!${process.execPath}\nif (process.argv[2] === "--version") console.log("9.9.9 (652 fake)");\n`, 0o755);
  }
  w(join(bin, "apply_patch"), "#!/bin/sh\nexit 0\n", 0o755);
  w(join(aig, "instructions", "common.md"), "# common\n");
  w(join(aig, "instructions", "roles", "tester.md"), "# tester\n");
  mkdirSync(join(root, "project"), { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  const fakes = [fake("oat"), fake("ort"), fake("cdx")];
  const hostCreds = JSON.stringify({ claudeAiOauth: { accessToken: fakes[0], refreshToken: fakes[1] } });
  w(join(host, ".claude", ".credentials.json"), hostCreds, 0o600);
  const hostCodex = JSON.stringify({ fake: fakes[2] });
  w(join(host, ".codex", "auth.json"), hostCodex, 0o600);
  return { root, host, aig, bin, project: join(root, "project"), hostCreds, hostCodex, fakes };
}

// Explicit env only: no ambient auth, developer HOME or AIGENTRY_CLAUDE_OAUTH_TOKEN reaches a child.
// win32 adds only fake USERPROFILE (os.homedir), TEMP/TMP (os.tmpdir) and SystemRoot (Windows runtime).
const env = (W: World): Record<string, string> => ({
  PATH: WIN ? [W.bin, probeExeDir()].join(delimiter) : `${W.bin}:/usr/bin:/bin`, HOME: W.host,
  TMPDIR: join(W.root, "tmp"), LANG: "en_US.UTF-8",
  AIGENTRY_HOME: W.aig, AGENT_METADATA_DIST: DIST,
  ...(WIN ? { USERPROFILE: W.host, TEMP: join(W.root, "tmp"), TMP: join(W.root, "tmp"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } : {}),
});

/** Default adapter argv from the real confined boot path (includes the --permission-mode bypass pair). */
function bootArgv(W: World, sid: string, cli: string): { argv: string[]; roleCwd: string } {
  const r = spawnSync(process.execPath, [BOOT, "--role", "tester", "--cwd", W.project, "--sid", sid, "--cli", cli,
    "--confined"], { encoding: "utf8", env: env(W), timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const j = parse(r.stdout) ?? {};
  assert.ok(Array.isArray(j.argv));
  return { argv: j.argv as string[], roleCwd: String(j.spawn_cwd) };
}

interface Prep { status: number | null; out: string; error: string | null; m: Json; stagingRoot: string }
function prepare(W: World, sid: string, cli: string, argv: string[], roleCwd: string, pathEnv?: string): Prep {
  const scopeFile = join(W.root, `scope-${sid}.json`), stagingRoot = join(W.root, "sessions", sid);
  writeFileSync(scopeFile, JSON.stringify({ version: 1, task: TASK, sid, read: [W.project], write: [W.project],
    domains: ["api.anthropic.com:443"] }));
  mkdirSync(stagingRoot, { recursive: true });
  const r = spawnSync(process.execPath, [DRIVER, JSON.stringify({ scopeFile, task: TASK, sid, cli, roleCwd, argv,
    stagingRoot })], { encoding: "utf8", env: { ...env(W), ...(pathEnv === undefined ? {} : { PATH: pathEnv }) },
    timeout: 30000 });
  const res = parse(r.stdout.trim());
  const line = /^Error: (.*)$/m.exec(r.stderr);
  return { status: r.status, out: r.stdout + r.stderr, error: line ? line[1] ?? null : null,
    m: res ? (parse(read(String(res.manifest))) ?? {}) : {}, stagingRoot };
}

const count = (a: string[], v: string): number => a.filter((x) => x === v).length;

/** Refused before any write: exact error, no payload/fake credential echo, empty staging, host auth intact. */
function assertRefused(W: World, p: Prep, error: string, payloads: string[] = []): void {
  assert.notEqual(p.status, 0, p.out);
  assert.equal(p.error, error);
  for (const s of [...payloads, ...W.fakes]) assert.ok(!p.out.includes(s), p.error ?? "");
  assert.deepEqual(readdirSync(p.stagingRoot), []);
  assert.equal(existsSync(join(p.stagingRoot, "sandbox")), false);
  assert.equal(existsSync(join(p.stagingRoot, "sandbox-current.json")), false);
  assert.equal(read(join(W.host, ".claude", ".credentials.json")), W.hostCreds);
  assert.equal(read(join(W.host, ".codex", "auth.json")), W.hostCodex);
  // os.tmpdir() of the prepare child is exactly <root>/tmp on linux/win32 (macOS stages agw- under /tmp
  // instead, so there this check is vacuous). Refusal happens before mkdtemp: no agw- dir.
  assert.deepEqual(readdirSync(join(W.root, "tmp")).filter((n) => n.startsWith("agw-")), []);
}

test("claude: exact closed 8-tool set, one --tools and one --allowedTools, same constant, rest unchanged", () => {
  const W = world(), { argv, roleCwd } = bootArgv(W, "p1", "claude");
  // The permitted default adapter argv carries none of the refused flags.
  assert.ok(!argv.some((a) => FLAGS.some((f) => a === f || a.startsWith(`${f}=`))));
  assert.ok(argv.includes("bypassPermissions"));
  assert.equal(claudeToolPolicyViolation(argv), undefined);
  const p = prepare(W, "p1", "claude", argv, roleCwd);
  // win32: the confined sandbox is unsupported; the real platform gate refuses first, before any write.
  if (WIN) return assertRefused(W, p, UNSUPPORTED);
  assert.equal(p.status, 0, p.out);
  const cmd = p.m.command as string[];
  assert.deepEqual([count(cmd, "--tools"), count(cmd, "--allowedTools")], [1, 1]);
  for (const f of ["--tools", "--allowedTools"]) {
    const i = cmd.indexOf(f);
    assert.equal(cmd[i + 1], TOOLS);
    assert.ok(String(cmd[i + 2]).startsWith("--"), `${f} list must be followed by a flag`);
  }
  assert.deepEqual(TOOLS.split(","), ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"]);
  assert.ok(!cmd.some((a) => /^(Agent|Task|Workflow|TodoWrite)$/.test(a) || /(^|,)(Agent|Task|Workflow)(,|$)/.test(a)));
  // Caller --permission-mode pair is replaced exactly as before; everything else is the pre-#652 shape.
  const rest = [...argv.slice(1)];
  rest.splice(rest.indexOf("--permission-mode"), 2);
  assert.deepEqual(cmd.slice(1), [...rest, "--permission-mode", "bypassPermissions", "--tools", TOOLS, "--allowedTools", TOOLS,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-chrome",
    "--add-dir", cmd[cmd.length - 1]]);
  assert.ok(!cmd.includes("acceptEdits"));
  // env/config/auth unchanged.
  const e = p.m.env as Record<string, string>, home = e.HOME ?? "";
  assert.deepEqual(Object.keys(e).sort(), ["AIGENTRY_TARGET_CWD", "AIGENTRY_TASK_ID", "AIGENTRY_WORKER_ATTEMPT",
    "AIGENTRY_WORKER_SESSION", "AIGENTRY_WORKER_SESSION_ID", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "SHELL", "TEMP", "TERM", "TMP", "TMPDIR"]);
  assert.equal(e.CLAUDE_CONFIG_DIR, join(home, ".claude"));
  assert.equal(read(join(home, ".claude", ".credentials.json")), W.hostCreds);
  const fsCfg = (p.m.config as Json).filesystem as Json;
  assert.deepEqual((fsCfg.allowWrite as string[]).slice(1), [home, e.TMPDIR]);
  assert.deepEqual(((p.m.config as Json).network as Json).allowedDomains, ["api.anthropic.com:443"]);
  assert.equal(p.m.claudeOAuthHandoff, undefined);
});

// #1200: a confined worker has nobody to answer Claude Code's own permission prompt; the OS sandbox is
// the boundary. Confined (scope loaded, sandbox prepared) => the sealed manifest command carries
// bypassPermissions, never acceptEdits. Unconfined => boot-prepare argv/launcher exactly as before.
test("#1200 claude: confined manifest command stages bypassPermissions (not acceptEdits); unconfined argv unchanged", () => {
  const W = world();
  const u = spawnSync(process.execPath, [BOOT, "--role", "tester", "--cwd", W.project, "--sid", "pm", "--cli", "claude"],
    { encoding: "utf8", env: env(W), timeout: 30000 });
  assert.equal(u.status, 0, u.stderr);
  const uj = parse(u.stdout) ?? {}, uArgv = uj.argv as string[];
  assert.deepEqual(uArgv.slice(-2), ["--permission-mode", "bypassPermissions"]);
  assert.equal(count(uArgv, "--permission-mode"), 1);
  assert.ok(!uArgv.includes("acceptEdits"));
  assert.match(read(String(uj.spawn_cli)), / --permission-mode bypassPermissions "\$@"\n$/);
  const { argv, roleCwd } = bootArgv(W, "pm", "claude");
  // boot-prepare stages the same argv either way; only prepareWorkerSandbox decides the confined mode.
  assert.deepEqual(argv, uArgv);
  const p = prepare(W, "pm", "claude", argv, roleCwd);
  if (WIN) return assertRefused(W, p, UNSUPPORTED);
  assert.equal(p.status, 0, p.out);
  const cmd = p.m.command as string[];
  assert.equal(count(cmd, "--permission-mode"), 1);
  assert.equal(cmd[cmd.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(!cmd.includes("acceptEdits"));
  for (const f of ["--tools", "--allowedTools"]) assert.equal(cmd[cmd.indexOf(f) + 1], TOOLS);
});

test("codex: command unchanged, no tool flags added, claude-only gate does not apply", () => {
  const W = world(), { argv, roleCwd } = bootArgv(W, "cx", "codex");
  for (const [sid, extra] of [["cx", []], ["cx2", ["--agents", "{}"]]] as const) {
    const p = prepare(W, sid, "codex", [...argv, ...extra], roleCwd);
    if (WIN) { assertRefused(W, p, UNSUPPORTED); continue; }
    assert.equal(p.status, 0, p.out);
    const cmd = p.m.command as string[];
    assert.deepEqual(cmd.slice(1), [...argv.slice(1), ...extra].filter((a) => a !== "--dangerously-bypass-approvals-and-sandbox")
      .concat(["--sandbox", "danger-full-access", "--ask-for-approval", "never", "--add-dir", cmd[cmd.length - 1] ?? ""]));
    assert.ok(!cmd.includes("--tools") && !cmd.includes("--allowedTools"));
  }
});

test("claude: every override flag/alias, equals form, position and variadic is refused before staging", () => {
  const W = world(), { argv, roleCwd } = bootArgv(W, "n0", "claude");
  const hostBefore = read(join(W.host, ".claude", ".credentials.json"));
  let n = 0;
  for (const flag of FLAGS) {
    const secret = fake("pay");
    const attacks = attackForms(argv, flag, secret);
    for (const a of attacks) {
      // The real integration result agrees with the pure helper; win32 refuses at the platform gate first.
      assert.equal(claudeToolPolicyViolation(a), flag);
      const sid = `n${n++}`, p = prepare(W, sid, "claude", a, roleCwd);
      assert.notEqual(p.status, 0, `${flag} accepted: ${JSON.stringify(a.slice(1).map((x) => x.slice(0, 24)))}`);
      const expected = WIN ? UNSUPPORTED : `SANDBOX_TOOL_ARG: ${flag}`;
      assert.equal(p.error, expected);
      assertRefused(W, p, expected, [secret]);
      // Redaction: the flag name only, never the payload.
      assert.ok(!p.out.includes(secret) && !p.out.includes("Agent\"") && !p.out.includes("permissions"), p.error ?? "");
      // No filesystem change: staging root still empty, no sandbox dir, no current pointer, host auth untouched.
      assert.deepEqual(readdirSync(p.stagingRoot), []);
      assert.equal(existsSync(join(p.stagingRoot, "sandbox")), false);
      assert.equal(existsSync(join(p.stagingRoot, "sandbox-current.json")), false);
    }
  }
  assert.equal(read(join(W.host, ".claude", ".credentials.json")), hostBefore);
});

test("claude: lookalike flags are not overmatched (no prefix/substring refusal)", () => {
  const W = world(), { argv, roleCwd } = bootArgv(W, "o0", "claude");
  let n = 0;
  for (const a of LOOKALIKES) {
    assert.equal(claudeToolPolicyViolation([...argv, a]), undefined);
    const p = prepare(W, `o${n++}`, "claude", [...argv, a], roleCwd);
    if (WIN) { assertRefused(W, p, UNSUPPORTED); continue; }
    assert.equal(p.status, 0, `${a}: ${p.out}`);
    assert.equal(count(p.m.command as string[], "--tools"), 1);
  }
});

// #652 optional patch helper. PATH is exactly the fake bin for prepare, so no host directory can supply
// (or hide) apply_patch: presence and absence are both deterministic.
test("apply_patch absent from PATH: prepare succeeds, no bin/apply_patch, no allowRead patch entry", () => {
  const W = world();
  rmSync(join(W.bin, "apply_patch"));
  for (const cli of ["claude", "codex"]) {
    const sid = `nopatch-${cli}`, { argv, roleCwd } = bootArgv(W, sid, cli);
    const p = prepare(W, sid, cli, argv, roleCwd, W.bin);
    if (WIN) { assertRefused(W, p, UNSUPPORTED); continue; }
    assert.equal(p.status, 0, p.out);
    const home = (p.m.env as Record<string, string>).HOME ?? "";
    assert.deepEqual(readdirSync(join(home, "bin")), []);
    const allowRead = ((p.m.config as Json).filesystem as Json).allowRead as string[];
    assert.ok(!allowRead.some((x) => basename(x) === "apply_patch"), JSON.stringify(allowRead));
    // The real CLI entry is followed directly by node: nothing (and no dangling path) in the patch slot.
    const i = allowRead.indexOf((p.m.command as string[])[0] ?? "");
    assert.ok(i >= 0);
    assert.equal(allowRead[i + 1], realpathSync(process.execPath));
    assert.ok(!JSON.stringify(p.m).includes("apply_patch"));
  }
});

test("apply_patch on PATH: symlinked into the private bin and in allowRead exactly as before", () => {
  const W = world();
  const patch = realpathSync(join(W.bin, "apply_patch"));
  for (const cli of ["claude", "codex"]) {
    const sid = `patch-${cli}`, { argv, roleCwd } = bootArgv(W, sid, cli);
    const p = prepare(W, sid, cli, argv, roleCwd, W.bin);
    if (WIN) { assertRefused(W, p, UNSUPPORTED); continue; }
    assert.equal(p.status, 0, p.out);
    const home = (p.m.env as Record<string, string>).HOME ?? "";
    assert.deepEqual(readdirSync(join(home, "bin")), ["apply_patch"]);
    assert.ok(lstatSync(join(home, "bin", "apply_patch")).isSymbolicLink());
    assert.equal(readlinkSync(join(home, "bin", "apply_patch")), patch);
    const allowRead = ((p.m.config as Json).filesystem as Json).allowRead as string[];
    const i = allowRead.indexOf((p.m.command as string[])[0] ?? "");
    assert.ok(i >= 0);
    assert.deepEqual(allowRead.slice(i + 1, i + 3), [patch, realpathSync(process.execPath)]);
  }
});

test("pure claudeToolPolicyViolation (argv admission logic, not OS confinement): 72 attacks, 9 lookalikes, ordering", () => {
  assert.deepEqual([...CLAUDE_TOOL_POLICY_FLAGS], FLAGS);
  assert.equal(CLAUDE_WORKER_TOOLS, TOOLS);
  const base = ["/fake/bin/claude", "--model", "opus", "--permission-mode", "bypassPermissions"];
  assert.equal(claudeToolPolicyViolation(base), undefined);
  let n = 0;
  for (const flag of FLAGS) {
    const secret = fake("pay");
    for (const a of attackForms(base, flag, secret)) {
      const v = claudeToolPolicyViolation(a);
      assert.equal(v, flag, JSON.stringify(a.slice(1).map((x) => x.slice(0, 24))));
      // Redaction: the result (and so the caller's error) carries the flag name only.
      assert.ok(!`SANDBOX_TOOL_ARG: ${v}`.includes(secret) && !String(v).includes("permissions"));
      n++;
    }
  }
  assert.equal(n, 72);
  for (const a of LOOKALIKES) assert.equal(claudeToolPolicyViolation([...base, a]), undefined, a);
  assert.equal(LOOKALIKES.length, 9);
  // First refused token in argv order wins, not the flag-list order.
  assert.equal(claudeToolPolicyViolation(["claude", "--settings", "s.json", "--tools", "Agent"]), "--settings");
  assert.equal(claudeToolPolicyViolation(["claude", "--agents={}", "--agent", "x"]), "--agents");
  assert.equal(claudeToolPolicyViolation(["claude", "--allowedTools=--tools"]), "--allowedTools");
  // Aliases are distinct exact names.
  assert.equal(claudeToolPolicyViolation(["claude", "--allowed-tools", "Agent"]), "--allowed-tools");
  assert.equal(claudeToolPolicyViolation(["claude", "--disallowed-tools=Bash"]), "--disallowed-tools");
  // argv[0] is the bound command and is never scanned; a value equal to a flag is refused (fail closed).
  assert.equal(claudeToolPolicyViolation(["--tools"]), undefined);
  assert.equal(claudeToolPolicyViolation([]), undefined);
  assert.equal(claudeToolPolicyViolation(["claude", "--model", "--tools"]), "--tools");
  // Pure: the input is not mutated.
  const frozen = Object.freeze(["claude", "--agent", "x"]);
  assert.equal(claudeToolPolicyViolation(frozen), "--agent");
  assert.deepEqual(frozen, ["claude", "--agent", "x"]);
});
