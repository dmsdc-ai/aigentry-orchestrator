// #652 confined Claude worker tool admission: one closed built-in set for --tools and
// --allowedTools, and caller tool-policy overrides refused before any staging write.
//
// Drives bin/boot-prepare.mjs --confined (default adapter argv) and the REAL compiled
// prepareWorkerSandbox through the existing tests/dispatch/agent-metadata/support/prepare-sandbox.mjs
// driver, with a FAKE host HOME, FAKE credentials and FAKE CLIs. The launcher and the runner are
// never executed: nothing starts a provider CLI, reads the developer HOME or touches the network.
// These tests prove argv construction and refusal ordering only, never CLI acceptance or
// OS confinement.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BOOT = join(REPO_ROOT, "bin", "boot-prepare.mjs");
const DIST = join(REPO_ROOT, "dist");
const DRIVER = join(REPO_ROOT, "tests", "dispatch", "agent-metadata", "support", "prepare-sandbox.mjs");
const TASK = "652";
const TOOLS = "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch";
const FLAGS = ["--tools", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools",
  "--agent", "--agents", "--settings"];

type Json = Record<string, unknown>;
const parse = (s: string): Json | null => { try { return JSON.parse(s) as Json; } catch { return null; } };
const read = (p: string): string => readFileSync(p, "utf8");
const fake = (k: string): string => `FAKE-sk-ant-${k}01-${randomUUID()}-NOT-A-SECRET`;

interface World { root: string; host: string; aig: string; bin: string; project: string; hostCreds: string }

const roots: string[] = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

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
  const hostCreds = JSON.stringify({ claudeAiOauth: { accessToken: fake("oat"), refreshToken: fake("ort") } });
  w(join(host, ".claude", ".credentials.json"), hostCreds, 0o600);
  w(join(host, ".codex", "auth.json"), JSON.stringify({ fake: fake("cdx") }), 0o600);
  return { root, host, aig, bin, project: join(root, "project"), hostCreds };
}

// Explicit env only: no ambient auth, developer HOME or AIGENTRY_CLAUDE_OAUTH_TOKEN reaches a child.
const env = (W: World): Record<string, string> => ({
  PATH: `${W.bin}:/usr/bin:/bin`, HOME: W.host, TMPDIR: join(W.root, "tmp"), LANG: "en_US.UTF-8",
  AIGENTRY_HOME: W.aig, AGENT_METADATA_DIST: DIST,
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
function prepare(W: World, sid: string, cli: string, argv: string[], roleCwd: string): Prep {
  const scopeFile = join(W.root, `scope-${sid}.json`), stagingRoot = join(W.root, "sessions", sid);
  writeFileSync(scopeFile, JSON.stringify({ version: 1, task: TASK, sid, read: [W.project], write: [W.project],
    domains: ["api.anthropic.com:443"] }));
  mkdirSync(stagingRoot, { recursive: true });
  const r = spawnSync(process.execPath, [DRIVER, JSON.stringify({ scopeFile, task: TASK, sid, cli, roleCwd, argv,
    stagingRoot })], { encoding: "utf8", env: env(W), timeout: 30000 });
  const res = parse(r.stdout.trim());
  const line = /^Error: (.*)$/m.exec(r.stderr);
  return { status: r.status, out: r.stdout + r.stderr, error: line ? line[1] ?? null : null,
    m: res ? (parse(read(String(res.manifest))) ?? {}) : {}, stagingRoot };
}

const count = (a: string[], v: string): number => a.filter((x) => x === v).length;

test("claude: exact closed 8-tool set, one --tools and one --allowedTools, same constant, rest unchanged", () => {
  const W = world(), { argv, roleCwd } = bootArgv(W, "p1", "claude");
  // The permitted default adapter argv carries none of the refused flags.
  assert.ok(!argv.some((a) => FLAGS.some((f) => a === f || a.startsWith(`${f}=`))));
  assert.ok(argv.includes("bypassPermissions"));
  const p = prepare(W, "p1", "claude", argv, roleCwd);
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
  assert.deepEqual(cmd.slice(1), [...rest, "--permission-mode", "acceptEdits", "--tools", TOOLS, "--allowedTools", TOOLS,
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-chrome",
    "--add-dir", cmd[cmd.length - 1]]);
  assert.ok(!cmd.includes("bypassPermissions"));
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

test("codex: command unchanged, no tool flags added, claude-only gate does not apply", () => {
  const W = world(), { argv, roleCwd } = bootArgv(W, "cx", "codex");
  for (const [sid, extra] of [["cx", []], ["cx2", ["--agents", "{}"]]] as const) {
    const p = prepare(W, sid, "codex", [...argv, ...extra], roleCwd);
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
    const secret = fake("pay"), json = `{"permissions":{"allow":["Agent"]},"k":"${secret}"}`;
    const attacks: string[][] = [
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
    for (const a of attacks) {
      const sid = `n${n++}`, p = prepare(W, sid, "claude", a, roleCwd);
      assert.notEqual(p.status, 0, `${flag} accepted: ${JSON.stringify(a.slice(1).map((x) => x.slice(0, 24)))}`);
      assert.equal(p.error, `SANDBOX_TOOL_ARG: ${flag}`);
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
  for (const a of ["--agent-like-unknown", "--agentsx", "--toolsy", "--settings-file", "--allowedToolsX",
    "--setting-sources=user", "-tools", "tools", "--append-system-prompt=--tools"]) {
    const p = prepare(W, `o${n++}`, "claude", [...argv, a], roleCwd);
    assert.equal(p.status, 0, `${a}: ${p.out}`);
    assert.equal(count(p.m.command as string[], "--tools"), 1);
  }
});
