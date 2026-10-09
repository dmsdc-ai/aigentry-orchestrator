// #652 opt-in long-lived Claude worker token: AIGENTRY_CLAUDE_OAUTH_TOKEN -> CLAUDE_CODE_OAUTH_TOKEN.
//
// Drives the real caller chain (bin/boot-prepare.mjs [--confined] -> dist prepareWorkerSandbox ->
// dist worker-sandbox-runner) with FAKE tokens, FAKE CLIs and a FAKE host HOME. Nothing reads the
// developer HOME, the Keychain or a provider:
// - prepareWorkerSandbox runs in a child whose child_process.execFileSync is replaced BEFORE the
//   module loads, so /usr/bin/security is answered by a counter and never executed;
// - the runner runs from a temp copy of dist/src/session next to an inline FAKE
//   @anthropic-ai/sandbox-runtime. MOCK BOUNDARY: that fake applies NO OS isolation. These tests
//   prove env routing, sealing and refusal logic, never confinement.
//   Exception: the last two tests (darwin; Linux with SRT dependencies) run the built runner on the REAL sandbox-runtime.
// The fake CLIs record booleans only; no token value, hash or length is ever printed.
// Windows portability (fixture only, product untouched): libuv spawn(shell:false) resolves only
// .com/.exe, os.homedir() reads USERPROFILE (not HOME), PATH uses path.delimiter, import() needs a
// file URL, and the launchers are bash scripts run with Git Bash only (never PowerShell/cmd/WSL).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, copyFileSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import {
  PREFLIGHT_PROXY_PORTS, preflightConnectProbe, preflightControlPort, preflightDenyProbe, withSeccompHelperRead,
} from "../../src/session/worker-sandbox.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BOOT = join(REPO_ROOT, "bin", "boot-prepare.mjs");
const DIST_SESSION = join(REPO_ROOT, "dist", "src", "session");
const OPT = "AIGENTRY_CLAUDE_OAUTH_TOKEN";
const CC = "CLAUDE_CODE_OAUTH_TOKEN";
const TASK = "652";
const WIN = process.platform === "win32";
// #1167 F6: win32 ACL oracle + independent icacls tamper (tests/helpers/win-acl.mjs); loaded on win32 only.
const acl = WIN ? (await import(pathToFileURL(join(REPO_ROOT, "tests", "helpers", "win-acl.mjs")).href)) as
  { grant(path: string, spec: string): void; isPrivate(path: string): boolean } : null;
const sq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

// The launchers are bash scripts. win32 uses Git for Windows bash only; System32 (WSL) bash is never
// searched. Empty = not installed: runLauncher then fails loudly instead of assuming another shell.
const BASH = !WIN ? "/bin/bash" : [
  ...[process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
    .filter((d): d is string => !!d)
    .flatMap((d) => [join(d, "Git", "usr", "bin", "bash.exe"), join(d, "Git", "bin", "bash.exe")]),
  ...(process.env.PATH ?? "").split(delimiter).filter((d) => /[\\/]git[\\/](usr[\\/])?bin$/i.test(d))
    .map((d) => join(d, "bash.exe")),
].find((p) => existsSync(p)) ?? "";

type Rec = { hasOAuthEnv: boolean; oauthEqualsFake: boolean; argvContainsFake?: boolean };
type Json = Record<string, unknown>;

// Fake CLI: answers --version; otherwise records booleans against $FAKE_EXPECT_FILE.
const cliBody = `const fs = require("fs"), a = process.argv.slice(2), e = process.env;
if (a[0] === "--version") { console.log("9.9.9 (652 fake)"); process.exit(0); }
if (!e.FAKE_RECORD) process.exit(0);
let x = null; try { x = fs.readFileSync(e.FAKE_EXPECT_FILE, "utf8"); } catch {}
fs.writeFileSync(e.FAKE_RECORD, JSON.stringify({ hasOAuthEnv: "${CC}" in e,
  oauthEqualsFake: x !== null && e.${CC} === x, argvContainsFake: x !== null && a.some(v => v.includes(x)) }));
`;
const cliShim = (): string => `#!${process.execPath}\n${cliBody}`;
// win32: Git Bash execs the extensionless `#!/bin/sh` wrapper (exact name wins over .exe), which runs
// the same recorder body with this node. The boot version probe (spawn shell:false) cannot see it, so
// it is answered by a copy of this node.exe on a later PATH entry: it prints node's own version
// (>= every adapter floor) and is never the worker command.
let probeDir = "";
function probeExeDir(): string {
  if (probeDir) return probeDir;
  const d = mkdtempSync(join(tmpdir(), "claude-oauth-652-probe-"));
  roots.push(d);
  copyFileSync(process.execPath, join(d, "claude.exe"));
  for (const c of ["codex", "gemini"]) {
    try { linkSync(join(d, "claude.exe"), join(d, `${c}.exe`)); } catch { copyFileSync(process.execPath, join(d, `${c}.exe`)); }
  }
  return (probeDir = d);
}

// prepareWorkerSandbox under interception. argv[1] = JSON spec; prints one JSON line.
const PREPARE_CHILD = `
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(import.meta.url);
const cp = require("node:child_process"), fs = require("node:fs"), path = require("node:path"), url = require("node:url");
const s = JSON.parse(process.argv[1]);
const counters = { security: 0, otherExec: 0, hostClaudeRead: 0, hostCodexRead: 0 };
cp.execFileSync = (f) => { if (f === "/usr/bin/security") { counters.security++; return s.fakeSecurity; }
  counters.otherExec++; throw new Error("FAKE_EXEC_BLOCKED"); };
const rd = fs.readFileSync;
// Path-form-insensitive match (string/URL/Buffer, resolved; case-folded on win32) so a host read is never undercounted.
const key = (p) => { try {
  const v = typeof p === "string" ? p : p instanceof URL ? url.fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : null;
  if (v === null) return null;
  const r = path.resolve(v); return process.platform === "win32" ? r.toLowerCase() : r; } catch { return null; } };
const hostClaude = key(path.join(s.host, ".claude", ".credentials.json")), hostCodex = key(path.join(s.host, ".codex", "auth.json"));
fs.readFileSync = function (p, ...r) {
  const k = key(p);
  if (k === hostClaude) counters.hostClaudeRead++;
  if (k === hostCodex) counters.hostCodexRead++;
  return rd.call(this, p, ...r);
};
syncBuiltinESMExports();
let result = null, error = null;
try {
  const ws = await import(s.module);
  const scope = ws.loadWorkerScope(s.scopeFile, s.task, s.sid);
  result = ws.prepareWorkerSandbox(scope, s.cli, s.roleCwd, s.argv, s.stagingRoot, s.targetCwd, s.hooksDir);
} catch (e) { error = e instanceof Error ? e.message : String(e); }
process.stdout.write(JSON.stringify({ result, error, counters }) + "\\n");
`;

// MOCK BOUNDARY fake SRT: logs every call (config + command) for leak scans, answers the
// preflight with a recorder child, runs the worker command unconfined.
// FAKE_PREFLIGHT_CONNECT: host-side connect to the port at the END of the preflight command (a leak the
// fake preflight then hides by exiting 0). FAKE_WRAP_FAIL / FAKE_SPAWN_FAIL: preflight wrap throws / argv[0]
// does not exist. FAKE_PROXY_PORTS: expose SRT's optional proxy-port getters and log each call.
const FAKE_SRT = `import fs from "node:fs";
import net from "node:net";
const E = process.env, LOG = E.FAKE_SRT_LOG, PRE = E.FAKE_PREFLIGHT_RECORD, WREC = E.FAKE_WORKER_RECORD, EXP = E.FAKE_EXPECT_FILE;
const PF_EXIT = E.FAKE_PREFLIGHT_EXIT || "0", BASH = E.FAKE_BASH || "/bin/bash", LEAK = E.FAKE_PREFLIGHT_LEAK;
const CONNECT = E.FAKE_PREFLIGHT_CONNECT, WRAP_FAIL = E.FAKE_WRAP_FAIL, SPAWN_FAIL = E.FAKE_SPAWN_FAIL, PROXY = E.FAKE_PROXY_PORTS;
const log = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + "\\n"); };
const has = () => "${CC}" in process.env;
const REC = "const fs=require(\\"fs\\");let x=null;try{x=fs.readFileSync(process.env.FAKE_EXPECT_FILE,\\"utf8\\")}catch{}" +
  "fs.writeFileSync(process.argv[1],JSON.stringify({hasOAuthEnv:\\"${CC}\\" in process.env,oauthEqualsFake:x!==null&&process.env.${CC}===x}));" +
  "process.exit(Number(process.env.FAKE_PREFLIGHT_EXIT||0))";
export const SandboxManager = {
  isSupportedPlatform: () => true,
  checkDependenciesAsync: async () => ({ errors: [], warnings: [] }),
  initialize: async (config) => { log({ ev: "initialize", env: has(), config }); },
  wrapWithSandboxArgv: async (cmd, shell, a, b, cwd, o) => {
    const pre = String(o && o.commandId).endsWith(":preflight");
    log({ ev: "wrap", pre, env: has(), cmd });
    if (pre && LEAK) fs.appendFileSync(LEAK, "changed");
    if (pre && CONNECT) {
      const m = /'(\\d+)'$/.exec(cmd), port = m ? Number(m[1]) : 0;
      let connected = false;
      if (port) await new Promise((r) => { const c = net.connect({ host: "127.0.0.1", port }); c.on("error", () => {});
        c.once("connect", () => { connected = true; r(); }); c.once("close", r); });
      log({ ev: "fakeConnect", env: has(), port, connected });
    }
    if (pre && WRAP_FAIL) throw new Error("FAKE_WRAP_FAILED");
    return pre ? { argv: [SPAWN_FAIL || process.execPath, "-e", REC, PRE], env: { FAKE_EXPECT_FILE: EXP, FAKE_PREFLIGHT_EXIT: PF_EXIT } }
      : { argv: [BASH, "-c", cmd], env: { FAKE_RECORD: WREC, FAKE_EXPECT_FILE: EXP } };
  },
  reset: async () => { log({ ev: "reset", env: has() }); },
  ...(PROXY ? { getProxyPort: () => { log({ ev: "getProxyPort", env: has() }); return 3128; },
    getSocksProxyPort: () => { log({ ev: "getSocksProxyPort", env: has() }); return 1080; } } : {}),
};
`;

const fake = (k = "oat"): string => `FAKE-sk-ant-${k}01-${randomUUID()}-NOT-A-SECRET`;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const read = (p: string): string => readFileSync(p, "utf8");
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);
const parse = (s: string): Json | null => { try { return JSON.parse(s) as Json; } catch { return null; } };
const readJson = (p: string): Json | null => { try { return parse(read(p)); } catch { return null; } };

interface World {
  root: string; host: string; aig: string; bin: string; project: string; hooks: string; sessions: string;
  expect: string; hostCreds: string; hostRefresh: string; token: string;
}

const roots: string[] = [];
process.on("exit", () => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "claude-oauth-652-"));
  roots.push(root);
  const w = (p: string, d: string, m?: number): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d, m === undefined ? undefined : { mode: m });
  };
  const host = join(root, "host"), aig = join(root, "aig"), bin = join(root, "bin");
  for (const c of ["claude", "codex", "gemini"]) {
    if (!WIN) { w(join(bin, c), cliShim(), 0o755); continue; }
    const js = join(bin, `${c}.cjs`), unix = (p: string): string => sq(p.replace(/\\/g, "/"));
    w(js, cliBody);
    w(join(bin, c), `#!/bin/sh\nexec ${unix(process.execPath)} ${unix(js)} "$@"\n`, 0o755);
  }
  w(join(bin, "apply_patch"), "#!/bin/sh\nexit 0\n", 0o755);
  w(join(aig, "instructions", "common.md"), "# common\n");
  w(join(aig, "instructions", "roles", "tester.md"), "# tester\n");
  w(join(root, "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", 0o755);
  mkdirSync(join(root, "project"), { recursive: true });
  const hostRefresh = fake("ort");
  const hostCreds = JSON.stringify({ claudeAiOauth: { accessToken: fake(), refreshToken: hostRefresh } });
  w(join(host, ".claude", ".credentials.json"), hostCreds, 0o600);
  w(join(host, ".claude.json"), "{}\n");
  w(join(host, ".codex", "auth.json"), JSON.stringify({ fake: fake("cdx") }), 0o600);
  w(join(host, ".gemini", "oauth_creds.json"), JSON.stringify({ fake: fake("gem") }), 0o600);
  const token = fake(), expect = join(root, "expect");
  w(expect, token, 0o600);
  return { root, host, aig, bin, project: join(root, "project"), hooks: join(root, "hooks"),
    sessions: join(aig, "sessions"), expect, hostCreds, hostRefresh, token };
}

// Explicit env only: ambient auth (ANTHROPIC_*, CLAUDE_*, the developer HOME/USERPROFILE/APPDATA) never
// reaches a child. win32 adds only SystemRoot (Windows runtime) and TEMP/TMP (os.tmpdir) beyond fakes.
const sysEnv = (W: World): Record<string, string> => ({
  PATH: WIN ? [W.bin, probeExeDir()].join(delimiter) : `${W.bin}:/usr/bin:/bin`,
  HOME: W.host, USERPROFILE: W.host, APPDATA: join(W.host, "AppData", "Roaming"),
  ...(WIN ? { LOCALAPPDATA: join(W.host, "AppData", "Local"), TEMP: join(W.root, "tmp"), TMP: join(W.root, "tmp"),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } : {}),
});
const env = (W: World, extra: Record<string, string> = {}): Record<string, string> => ({
  ...sysEnv(W), AIGENTRY_HOME: W.aig, TMPDIR: join(W.root, "tmp"),
  AIGENTRY_GEMINI_BINARY: "gemini", LANG: "en_US.UTF-8", ...extra,
});

interface Boot { status: number | null; stdout: string; stderr: string; json: Json | null; launcher: string }
function boot(W: World, sid: string, extra: Record<string, string> = {}, cli = "claude", confined = false): Boot {
  mkdirSync(join(W.root, "tmp"), { recursive: true });
  const r = spawnSync(process.execPath, [BOOT, "--role", "tester", "--cwd", W.project, "--sid", sid, "--cli", cli,
    ...(confined ? ["--confined"] : [])], { encoding: "utf8", env: env(W, extra), timeout: 30000 });
  const json = parse(r.stdout);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, launcher: String(json?.spawn_cli ?? "") };
}

interface Prep { error: string | null; counters: Record<string, number>; manifest: string; hash: string;
  launcher: string; m: Json; stdout: string; stderr: string }
function prepare(W: World, sid: string, extra: Record<string, string> = {}, cli = "claude", noHostCreds = false): Prep {
  if (noHostCreds) rmSync(join(W.host, ".claude", ".credentials.json"), { force: true });
  const b = boot(W, sid, extra, cli, true);
  assert.equal(b.status, 0, b.stderr);
  const scopeFile = join(W.root, `scope-${sid}.json`), stagingRoot = join(W.sessions, sid);
  writeFileSync(scopeFile, JSON.stringify({ version: 1, task: TASK, sid, read: [W.project], write: [W.project],
    domains: ["api.anthropic.com:443"] }));
  mkdirSync(stagingRoot, { recursive: true });
  const spec = { module: pathToFileURL(join(DIST_SESSION, "worker-sandbox.js")).href, scopeFile, task: TASK, sid, cli,
    roleCwd: String(b.json?.spawn_cwd), argv: b.json?.argv, stagingRoot, targetCwd: W.project, hooksDir: W.hooks,
    host: W.host, fakeSecurity: JSON.stringify({ claudeAiOauth: { refreshToken: "FAKE-keychain" } }) };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PREPARE_CHILD, JSON.stringify(spec)],
    { encoding: "utf8", env: env(W, extra), timeout: 30000 });
  const out = parse(r.stdout) ?? {};
  const res = (out.result ?? {}) as Json;
  const manifest = String(res.manifest ?? "");
  return { error: (out.error as string | null) ?? null, counters: (out.counters ?? {}) as Record<string, number>,
    manifest, hash: String(res.hash ?? ""), launcher: String(res.launcher ?? ""),
    m: manifest ? (readJson(manifest) ?? {}) : {}, stdout: b.stdout + r.stdout, stderr: b.stderr + r.stderr };
}

// The runner from a temp copy of the built session dir + inline fake SRT (see MOCK BOUNDARY).
let runnerPkg = "";
function runnerCopy(): string {
  if (runnerPkg) return runnerPkg;
  const root = mkdtempSync(join(tmpdir(), "claude-oauth-652-runner-"));
  roots.push(root);
  cpSync(DIST_SESSION, join(root, "dist", "src", "session"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const srt = join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
  mkdirSync(srt, { recursive: true });
  writeFileSync(join(srt, "package.json"), JSON.stringify({ name: "@anthropic-ai/sandbox-runtime", type: "module", main: "index.js" }));
  writeFileSync(join(srt, "index.js"), FAKE_SRT);
  return (runnerPkg = join(root, "dist", "src", "session", "worker-sandbox-runner.js"));
}

interface Run { status: number | null; stderr: string; worker: Rec | null; preflight: Rec | null; srt: Json[] }
let seq = 0;
function runRunner(W: World, manifest: string, hash: string, extra: string[] = [], extraEnv: Record<string, string> = {}): Run {
  const k = `run${seq++}`, f = (s: string): string => join(W.root, `${k}-${s}`);
  const r = spawnSync(process.execPath, [runnerCopy(), manifest, hash, ...extra], { encoding: "utf8", timeout: 30000,
    env: { ...sysEnv(W), FAKE_BASH: BASH, FAKE_SRT_LOG: f("srt.log"), FAKE_EXPECT_FILE: W.expect,
      FAKE_PREFLIGHT_RECORD: f("pre.json"), FAKE_WORKER_RECORD: f("worker.json"), ...extraEnv } });
  const srt = existsSync(f("srt.log")) ? read(f("srt.log")).trim().split("\n").map((l) => parse(l) ?? {}) : [];
  return { status: r.status, stderr: r.stderr, worker: readJson(f("worker.json")) as Rec | null,
    preflight: readJson(f("pre.json")) as Rec | null, srt };
}

function runLauncher(W: World, launcher: string, inherit: Record<string, string> = {}, args: string[] = []):
  { status: number | null; stderr: string; rec: Rec | null } {
  const recFile = join(W.root, `rec${seq++}.json`);
  assert.ok(BASH, "Git for Windows bash.exe not found: the launcher is a bash script; no PowerShell/cmd equivalent is assumed");
  const r = spawnSync(BASH, [...args, launcher], { encoding: "utf8", timeout: 30000,
    env: { ...sysEnv(W), FAKE_RECORD: recFile, FAKE_EXPECT_FILE: W.expect, ...inherit } });
  return { status: r.status, stderr: r.stderr, rec: readJson(recFile) as Rec | null };
}

function files(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}

/** Token literal / sha256 / base64 in any world file or stream, except the private handoff itself. */
function leaks(W: World, streams: string[]): string[] {
  const needles = [W.token, sha(W.token), Buffer.from(W.token).toString("base64")];
  const hits: string[] = [];
  for (const f of files(W.root)) {
    if (f === W.expect || /claude-oauth[^\\/]*[\\/]token$/.test(f)) continue;
    const body = read(f);
    if (needles.some((n) => body.includes(n))) hits.push(relative(W.root, f));
  }
  streams.forEach((s, i) => { if (needles.some((n) => s.includes(n))) hits.push(`<stream ${i}>`); });
  return hits;
}

const legacyHandoff = (launcher: string): string => {
  const d = readdirSync(dirname(launcher)).filter((n) => n.startsWith("claude-oauth-"));
  assert.equal(d.length, 1);
  return join(dirname(launcher), d[0] ?? "", "token");
};
const credsIn = (m: Json): boolean => existsSync(join(String((m.env as Json).CLAUDE_CONFIG_DIR), ".credentials.json"));
/** Handoff artefacts under the world, matched on the path RELATIVE to the world (temp prefix excluded). */
const handoffs = (W: World): string[] => files(W.sessions).filter((f) => /(^|[\\/])claude-oauth/.test(relative(W.root, f)));
/** #1167 P6 counterpart: win32 has no OS sandbox, so the confined prepare refuses before any effect. */
function refusedOnWin(W: World, p: Prep): void {
  assert.equal(p.error, "SANDBOX_PLATFORM_UNSUPPORTED");
  assert.equal(p.manifest, "");
  assert.deepEqual(p.counters, { security: 0, otherExec: 0, hostClaudeRead: 0, hostCodexRead: 0 });
  assert.deepEqual(handoffs(W), []);
  assert.deepEqual(leaks(W, [p.stdout, p.stderr]), []);
}

test("unset: legacy descriptor/launcher/child unchanged; inherited CLAUDE_CODE_OAUTH_TOKEN passes through untouched", () => {
  const W = world(), b = boot(W, "u1");
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(Object.keys((b.json?.env ?? {}) as Json), ["AIGENTRY_TARGET_CWD"]);
  assert.ok(!read(b.launcher).includes(CC));
  assert.equal(runLauncher(W, b.launcher).rec?.hasOAuthEnv, false);
  assert.equal(runLauncher(W, b.launcher, { [CC]: W.token }).rec?.oauthEqualsFake, true);
});

test("unset/empty: confined manifest has no marker, host copy seeded as before; empty == unset byte-for-byte", () => {
  const W = world(), u = prepare(W, "u2"), e = prepare(W, "e2", { [OPT]: "" });
  if (WIN) {
    for (const p of [u, e]) refusedOnWin(W, p);
  } else {
    for (const p of [u, e]) {
      assert.equal(p.error, null);
      assert.equal(p.m.claudeOAuthHandoff, undefined);
      assert.equal(read(join(String((p.m.env as Json).CLAUDE_CONFIG_DIR), ".credentials.json")), W.hostCreds);
      assert.equal(p.counters.hostClaudeRead, 1);
    }
    assert.deepEqual(Object.keys(e.m.env as Json).sort(), Object.keys(u.m.env as Json).sort());
  }
  const V = world(), lu = boot(V, "same"), X = world(), le = boot(X, "same", { [OPT]: "" });
  assert.equal(read(le.launcher).split(X.root).join("<R>"), read(lu.launcher).split(V.root).join("<R>"));
});

test("set legacy: one export, bare-env child gets EXACT token (overrides inherited), relaunch, no leak", () => {
  const W = world(), b = boot(W, "s1", { [OPT]: W.token, [CC]: fake("inh") });
  assert.equal(b.status, 0, b.stderr);
  assert.deepEqual(Object.keys((b.json?.env ?? {}) as Json), ["AIGENTRY_TARGET_CWD"]);
  assert.equal((read(b.launcher).match(/export CLAUDE_CODE_OAUTH_TOKEN=/g) ?? []).length, 1);
  for (const inherit of [{}, { [CC]: fake("inh") }] as Record<string, string>[]) {
    const r = runLauncher(W, b.launcher, inherit);
    assert.equal(r.rec?.oauthEqualsFake, true);
    assert.equal(r.rec?.argvContainsFake, false);
  }
  const h = legacyHandoff(b.launcher);
  if (WIN) assert.deepEqual([acl!.isPrivate(h), acl!.isPrivate(dirname(h))], [true, true]);
  else assert.deepEqual([mode(h), mode(dirname(h))], ["600", "700"]);
  assert.deepEqual(leaks(W, [b.stdout, b.stderr, JSON.stringify(b.json?.argv ?? [])]), []);
});

test("set legacy under xtrace/verbose: no token in trace, child still receives it", () => {
  const W = world(), b = boot(W, "x1", { [OPT]: W.token });
  for (const [args, inherit] of [[["-xv"], {}], [[], { SHELLOPTS: "xtrace" }]] as const) {
    const r = runLauncher(W, b.launcher, inherit, [...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.rec?.oauthEqualsFake, true);
    assert.deepEqual(leaks(W, [r.stderr]), []);
  }
});

test("set confined: boot creates no handoff and stub refuses; prepare reads no host auth; marker sealed; no leak", () => {
  for (const noHostCreds of [false, true]) {
    const W = world(), b = boot(W, "c0", { [OPT]: W.token }, "claude", true);
    assert.equal(runLauncher(W, b.launcher).status, 78);
    assert.deepEqual(handoffs(W), []);
    const p = prepare(W, "c1", { [OPT]: W.token }, "claude", noHostCreds);
    if (WIN) { refusedOnWin(W, p); continue; }
    assert.equal(p.error, null);
    assert.deepEqual([p.counters.hostClaudeRead, p.counters.security], [0, 0]);
    assert.equal(credsIn(p.m), false);
    assert.equal(p.m.claudeOAuthHandoff, join(dirname(p.manifest), "claude-oauth", "token"));
    assert.ok(!(CC in (p.m.env as Json)));
    assert.deepEqual(leaks(W, [p.stdout, p.stderr]), []);
    assert.ok(!files(W.root).some((f) => !f.startsWith(W.host) && read(f).includes(W.hostRefresh)));
  }
});

test("runner (fake SRT): worker-only EXACT token; preflight, SRT-time process.env, m.env, receipt, logs carry none; relaunch", () => {
  const W = world(), p = prepare(W, "r1", { [OPT]: W.token, [CC]: fake("inh") });
  if (WIN) return refusedOnWin(W, p);
  for (const i of [0, 1]) {
    const r = runRunner(W, p.manifest, p.hash);
    assert.equal(r.status, 0, `run ${i}: ${r.stderr}`);
    assert.equal(r.worker?.oauthEqualsFake, true);
    assert.equal(r.preflight?.hasOAuthEnv, false);
    assert.ok(r.srt.length >= 4 && r.srt.every((e) => e.env === false));
    assert.deepEqual(leaks(W, [r.stderr]), []);
  }
  assert.equal(readJson(join(dirname(p.manifest), "receipt.json"))?.state, "exited");
  const pre = runRunner(W, p.manifest, p.hash, ["--preflight-only"]);
  assert.deepEqual([pre.status, pre.worker], [0, null]);
});

const TAMPER: Record<string, (f: string, tok: string) => void> = {
  missing: (f) => rmSync(f),
  // win32 (#1167 F6): the counterpart of a group/world bit is an independent Everyone ACE.
  mode0644: (f) => (WIN ? acl!.grant(f, "*S-1-1-0:(R)") : chmodSync(f, 0o644)),
  dir0755: (f) => (WIN ? acl!.grant(dirname(f), "*S-1-1-0:(R)") : chmodSync(dirname(f), 0o755)),
  fileSymlink: (f, t) => { writeFileSync(`${f}.real`, `${t}\n`, { mode: 0o600 }); rmSync(f); symlinkSync(`${f}.real`, f); },
  dirSymlink: (f, t) => { const d = dirname(f); mkdirSync(`${d}.real`, { mode: 0o700 });
    writeFileSync(join(`${d}.real`, "token"), `${t}\n`, { mode: 0o600 }); rmSync(d, { recursive: true }); symlinkSync(`${d}.real`, d); },
  hardlink: (f) => linkSync(f, `${f}.hl`),
  extraLF: (f, t) => writeFileSync(f, `${t}\n\n`),
  nul: (f, t) => writeFileSync(f, `${t}\n\0x`),
  oversize: (f) => writeFileSync(f, `${"F".repeat(4097)}\n`),
};

test("tamper: confined runner and legacy launcher refuse 78 with fixed strings, no worker, no host fallback", () => {
  for (const [name, fn] of Object.entries(TAMPER)) {
    const W = world(), p = prepare(W, `t-${name}`, { [OPT]: W.token });
    let r: Run | null = null;
    if (WIN) {
      refusedOnWin(W, p);
    } else {
      fn(String(p.m.claudeOAuthHandoff), W.token);
      r = runRunner(W, p.manifest, p.hash);
      assert.equal(r.status, 78, `runner ${name}`);
      assert.match(r.stderr, /\[sandbox\] REFUSED: CLAUDE_OAUTH_HANDOFF_INVALID\n$/);
      assert.equal(r.worker, null);
      assert.equal(credsIn(p.m), false);
    }
    const b = boot(W, `lt-${name}`, { [OPT]: W.token });
    fn(legacyHandoff(b.launcher), W.token);
    const l = runLauncher(W, b.launcher);
    assert.equal(l.status, 78, `legacy ${name}`);
    assert.equal(l.rec, null);
    assert.match(l.stderr, /OAuth handoff missing or malformed; refusing launch/);
    assert.deepEqual(leaks(W, [r?.stderr ?? "", l.stderr]).filter((h) => !/\.real|\.hl$/.test(h)), []);
  }
});

test("marker rebind in a resealed manifest is refused before the sandbox is touched", () => {
  const W = world(), p = prepare(W, "m1", { [OPT]: W.token });
  if (WIN) return refusedOnWin(W, p);
  const marker = String(p.m.claudeOAuthHandoff), sealed = read(p.manifest);
  for (const mut of [(m: Json) => { m.claudeOAuthHandoff = marker.replace(String(p.m.attempt), randomUUID()); },
    (m: Json) => { m.claudeOAuthHandoff = `${dirname(marker)}/../claude-oauth/token`; },
    (m: Json) => { m.cli = "codex"; }]) {
    const m = parse(sealed) ?? {};
    mut(m);
    // Resealed in place: the runner reads only the sealed manifest path (readSealedManifest).
    const data = JSON.stringify(m, null, 2) + "\n", file = p.manifest;
    writeFileSync(file, data, { mode: 0o600 });
    const r = runRunner(W, file, sha(data));
    assert.equal(r.status, 78);
    assert.match(r.stderr, /CLAUDE_OAUTH_HANDOFF_INVALID/);
    assert.deepEqual([r.srt.length, r.worker], [0, null]);
  }
});

// The runner reads the manifest as the binder does (readSealedManifest): a symlinked, oversized or
// unsealed-path manifest is refused with the fixed code even when its hash matches; no SRT, worker or receipt.
test("runner refuses a symlinked, oversized or unsealed-path manifest with its fixed code, before the sandbox", () => {
  const cases: Record<string, (manifest: string) => { file: string; hash: string }> = {
    symlink: (f) => { renameSync(f, `${f}.real`); symlinkSync(`${f}.real`, f); return { file: f, hash: sha(read(f)) }; },
    oversize: (f) => { const data = read(f) + " ".repeat(1024 * 1024); writeFileSync(f, data); return { file: f, hash: sha(data) }; },
    unsealedPath: (f) => { const copy = join(dirname(f), "copy.json"); copyFileSync(f, copy); return { file: copy, hash: sha(read(f)) }; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const W = world(), p = prepare(W, `sm-${name}`);
    if (WIN) { refusedOnWin(W, p); continue; }
    const { file, hash } = setup(p.manifest);
    const r = runRunner(W, file, hash);
    assert.equal(r.status, 78, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /\[sandbox\] REFUSED: SANDBOX_MANIFEST_INVALID\n$/, name);
    assert.deepEqual([r.srt.length, r.worker, existsSync(join(dirname(p.manifest), "receipt.json"))], [0, null, false], name);
  }
  const W = world(), p = prepare(W, "sm-changed");
  if (WIN) return refusedOnWin(W, p);
  const r = runRunner(W, p.manifest, sha("not the sealed manifest"));
  assert.equal(r.status, 78);
  assert.match(r.stderr, /\[sandbox\] REFUSED: SANDBOX_MANIFEST_CHANGED\n$/);
  assert.deepEqual([r.srt.length, r.worker], [0, null]);
});

// Deployed metadata guard (#652 must keep it): the canary is checked, and the preflight must pass,
// BEFORE the token is read. The handoff is removed first, so a premature read would surface as
// CLAUDE_OAUTH_HANDOFF_INVALID instead of the guard error.
test("metadata canary missing/not-a-directory/symlink refuses before any token read or SRT call", () => {
  const breakers: Record<string, (dir: string) => void> = {
    missing: (d) => rmSync(d, { recursive: true }),
    file: (d) => { rmSync(d, { recursive: true }); writeFileSync(d, "x\n", { mode: 0o600 }); },
    symlink: (d) => { renameSync(d, `${d}.real`); symlinkSync(`${d}.real`, d); },
    // #652: on Linux the deny probe reads ENOENT as the denial, so every probed file must exist on the host.
    "file-canary-missing": (d) => rmSync(join(dirname(d), "outside-canary.txt")),
    "synthetic-missing": (d) => rmSync(join(d, "synthetic.txt")),
  };
  for (const [name, brk] of Object.entries(breakers)) {
    for (const opted of [false, true]) {
      const W = world(), p = prepare(W, `cn-${name}-${String(opted)}`, opted ? { [OPT]: W.token } : {});
      if (WIN) { refusedOnWin(W, p); continue; }
      assert.equal(typeof p.m.probeDirectory, "string", "manifest lacks the deployed probeDirectory canary");
      brk(String(p.m.probeDirectory));
      if (opted) rmSync(String(p.m.claudeOAuthHandoff));
      const r = runRunner(W, p.manifest, p.hash);
      assert.equal(r.status, 78, `${name}/${String(opted)}`);
      assert.match(r.stderr, /\[sandbox\] REFUSED: SANDBOX_METADATA_CANARY_REQUIRED\n$/);
      assert.deepEqual([r.srt.length, r.worker], [0, null]);
    }
  }
});

test("failed preflight: no worker, no receipt, token never read, nothing leaked", () => {
  for (const opted of [false, true]) {
    const W = world(), p = prepare(W, `pf-${String(opted)}`, opted ? { [OPT]: W.token } : {});
    if (WIN) { refusedOnWin(W, p); continue; }
    if (opted) rmSync(String(p.m.claudeOAuthHandoff));
    const r = runRunner(W, p.manifest, p.hash, [], { FAKE_PREFLIGHT_EXIT: "71" });
    assert.equal(r.status, 78);
    assert.match(r.stderr, /\[sandbox\] REFUSED: SANDBOX_PREFLIGHT_FAILED: 71 /);
    assert.equal(r.worker, null);
    assert.equal(r.preflight?.hasOAuthEnv, false);
    assert.equal(existsSync(join(dirname(p.manifest), "receipt.json")), false);
    assert.deepEqual(leaks(W, [r.stderr]), []);
  }
});

test("invalid opt-in: fixed-string refusal before any write, value never echoed, no fallback", () => {
  for (const bad of ["FAKE bad", "FAKE\nbad", "FAKE-é", "F".repeat(4097), "FAKE\u0001x"]) {
    const W = world(), b = boot(W, "i1", { [OPT]: bad });
    assert.equal(b.status, 4);
    assert.match(b.stderr, /^boot-prepare: CLAUDE_OAUTH_TOKEN_INVALID: /);
    assert.ok(!(b.stdout + b.stderr).includes(bad));
    const p = prepare(W, "i2", { [OPT]: bad });
    if (WIN) refusedOnWin(W, p);
    else assert.equal(p.error, "CLAUDE_OAUTH_TOKEN_INVALID");
    assert.ok(!(p.stdout + p.stderr).includes(bad));
    assert.equal(files(join(W.sessions, "i2", "sandbox")).length, 0);
  }
});

test("codex/gemini: opt-in has no effect (descriptor keys, no handoff, codex auth path unchanged, no leak)", () => {
  for (const cli of ["codex", "gemini"]) {
    const W = world(), s = boot(W, `${cli}-s`, { [OPT]: W.token }, cli), u = boot(W, `${cli}-u`, {}, cli);
    assert.equal(s.status, 0, s.stderr);
    assert.deepEqual(Object.keys((s.json?.env ?? {}) as Json), Object.keys((u.json?.env ?? {}) as Json));
    assert.ok(!read(s.launcher).includes(CC));
    assert.deepEqual(handoffs(W), []);
    assert.deepEqual(leaks(W, [s.stdout, s.stderr]), []);
  }
  const W = world(), p = prepare(W, "cx", { [OPT]: W.token }, "codex");
  if (WIN) return refusedOnWin(W, p);
  assert.equal(p.error, null);
  assert.equal(p.m.claudeOAuthHandoff, undefined);
  assert.equal(p.counters.hostCodexRead, 1);
  assert.deepEqual(leaks(W, [p.stdout, p.stderr]), []);
});

test("legacy launcher with the dist helper missing refuses 78 (no inline fallback)", () => {
  const W = world(), b = boot(W, "h1", { [OPT]: W.token });
  const helper = join(DIST_SESSION, "claude-worker-oauth.js");
  const src = read(b.launcher);
  assert.ok(src.includes(helper));
  // Never touch the shared build output (test files run concurrently): point a COPY at a missing helper.
  const copy = join(W.root, "launcher-missing-helper.sh");
  writeFileSync(copy, src.split(helper).join(join(W.root, "absent", "claude-worker-oauth.js")), { mode: 0o700 });
  const r = runLauncher(W, copy);
  assert.deepEqual([r.status, r.rec], [78, null]);
});

// #652 Linux seccomp helper read: SRT's bwrap wrapper execs <runtime>/vendor/seccomp/<arch>/apply-seccomp by host
// path inside the sandbox and binds nothing for it. Config shaping only (pure, every OS), never confinement.
test("pure withSeccompHelperRead: Linux appends only <runtime>/vendor/seccomp to allowRead; other platforms untouched", () => {
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: ["api.anthropic.com:443"], deniedDomains: [], allowUnixSockets: [],
      allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: { denyRead: ["/home", "/tmp"], allowRead: ["/w", "/w/bin/claude"], allowWrite: ["/w"], denyWrite: ["/w/cwd"] },
    allowPty: true, allowAppleEvents: false, enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
  };
  const before = JSON.stringify(config), rt = join("/", "nm", "@anthropic-ai", "sandbox-runtime");
  const helper = join(rt, "vendor", "seccomp");
  const linux = withSeccompHelperRead(config, "linux", rt);
  assert.deepEqual(linux.filesystem.allowRead, ["/w", "/w/bin/claude", helper]);
  assert.deepEqual({ ...linux, filesystem: { ...linux.filesystem, allowRead: config.filesystem.allowRead } }, config);
  assert.equal(JSON.stringify(config), before, "the sealed input is never mutated");
  for (const platform of ["darwin", "win32", "freebsd"] as const) assert.equal(withSeccompHelperRead(config, platform, rt), config);
  const bare = withSeccompHelperRead({ ...config, filesystem: { ...config.filesystem, allowRead: undefined } }, "linux", rt);
  assert.deepEqual(bare.filesystem.allowRead, [helper]);
});

// The built runner hands SRT exactly the sealed config shaped for THIS platform with the runtime directory it
// resolves itself (here the fake's). MOCK BOUNDARY: wiring only; the Linux bind is proven by the live case on CI.
test("runner (fake SRT): initialize gets the sealed config, plus the runtime's vendor/seccomp on Linux only", () => {
  const W = world(), p = prepare(W, "sc1");
  if (WIN) return refusedOnWin(W, p);
  const r = runRunner(W, p.manifest, p.hash, ["--preflight-only"]);
  assert.equal(r.status, 0, r.stderr);
  const rt = realpathSync(join(dirname(runnerCopy()), "..", "..", "..", "node_modules", "@anthropic-ai", "sandbox-runtime"));
  const init = r.srt.filter((e) => e.ev === "initialize");
  assert.equal(init.length, 1);
  assert.deepEqual(init[0]?.config, withSeccompHelperRead(p.m.config as SandboxRuntimeConfig, process.platform, rt));
});

// #652 deny classifier (pure, every OS): the exact probe source the runner embeds, evaluated per platform in a vm
// whose process.exit and fs.writeSync only record. sandbox-exec refuses with EPERM/EACCES. bwrap hides instead of
// failing: a denied directory is an empty tmpfs (ENOENT, empty listing, a write lands in it), a denied file a read-only
// /dev/null (empty content, EROFS on write), so those are denials on Linux only. Classification only, never confinement.
test("pure preflightDenyProbe: errno denials, Linux-only hiding denials, readable exits 71 and any other error throws, both naming the probe", () => {
  const CANARY = "sandbox boundary canary; not a user secret\n";
  const outcome = (platform: NodeJS.Platform, t: string, act: { code?: string; ret?: unknown }, x?: string): string => {
    const exits: number[] = [], err: string[] = [];
    const deny = runInNewContext(`${preflightDenyProbe(platform)}deny`, {
      process: { exit: (c: number) => { exits.push(c); } },
      fs: { writeSync: (fd: number, s: string) => { err.push(`${fd}>${s}`); } },
    }) as (t: string, f: () => unknown, x?: string) => void;
    try {
      deny(t, () => { if (act.code) throw Object.assign(new Error(act.code), { code: act.code }); return act.ret; }, x);
    } catch (e) {
      return `throws ${String((e as { code?: string }).code)} ${err.join("")}`;
    }
    return exits.length ? `exit ${exits.join(",")} ${err.join("")}` : `denied${err.join("")}`;
  };
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const linux = platform === "linux", hidden = (t: string): string => linux ? "denied" : `exit 71 2>${t}:readable `;
    for (const t of ["readFile", "writeFile", "readdir", "stat", "lstat"]) {
      for (const code of ["EPERM", "EACCES"]) assert.equal(outcome(platform, t, { code }), "denied", `${platform} ${t}: ${code}`);
      assert.equal(outcome(platform, t, { code: "ENOENT" }), linux ? "denied" : `throws ENOENT 2>${t}:ENOENT `, `${platform} ${t}: ENOENT`);
      assert.equal(outcome(platform, t, { code: "EROFS" }), linux && t === "writeFile" ? "denied" : `throws EROFS 2>${t}:EROFS `,
        `${platform} ${t}: EROFS`);
      for (const code of ["EIO", "ENOTDIR"]) assert.equal(outcome(platform, t, { code }), `throws ${code} 2>${t}:${code} `, `${platform} ${t}: ${code}`);
    }
    // readFile: only the host's canary text is readable; empty (/dev/null) or other content is hidden on Linux.
    assert.equal(outcome(platform, "readFile", { ret: CANARY }, CANARY), "exit 71 2>readFile:readable ", `${platform}: canary read`);
    assert.equal(outcome(platform, "readFile", { ret: "" }, CANARY), hidden("readFile"), `${platform}: empty content`);
    assert.equal(outcome(platform, "readFile", { ret: "other\n" }, CANARY), hidden("readFile"), `${platform}: other content`);
    // writeFile: a successful write is 71 off Linux; on Linux it lands in bwrap's tmpfs and the runner checks the host.
    assert.equal(outcome(platform, "writeFile", { ret: undefined }), hidden("writeFile"), `${platform}: write`);
    // readdir: only a listing that contains the child is readable; an empty tmpfs listing is hidden on Linux.
    assert.equal(outcome(platform, "readdir", { ret: ["synthetic.txt"] }, "synthetic.txt"), "exit 71 2>readdir:readable ",
      `${platform}: listing with the child`);
    assert.equal(outcome(platform, "readdir", { ret: [] }, "synthetic.txt"), hidden("readdir"), `${platform}: empty listing`);
    assert.equal(outcome(platform, "readdir", { ret: ["other.txt"] }, "synthetic.txt"), hidden("readdir"), `${platform}: listing without the child`);
    for (const t of ["stat", "lstat"]) assert.equal(outcome(platform, t, { ret: {} }), `exit 71 2>${t}:readable `, `${platform}: ${t}`);
  }
});

// #652: a preflight that exits 0 but changed the host canary (a write that reached the host) refuses. MOCK BOUNDARY:
// the fake appends to the canary host-side when wrapping the preflight; without that every fake preflight passes.
test("runner (fake SRT): a preflight that changed the host canary refuses writeFile:leaked, no worker, no receipt", () => {
  const W = world(), p = prepare(W, "lk1");
  if (WIN) return refusedOnWin(W, p);
  const r = runRunner(W, p.manifest, p.hash, [], { FAKE_PREFLIGHT_LEAK: String(p.m.probeFile) });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /\[sandbox\] REFUSED: SANDBOX_PREFLIGHT_FAILED: writeFile:leaked\n$/);
  assert.equal(r.worker, null);
  assert.equal(existsSync(join(dirname(p.manifest), "receipt.json")), false);
});

// The built runner's preflight carries exactly this platform's probe. MOCK BOUNDARY: the fake records the wrapped
// command and never runs it.
test("runner (fake SRT): the preflight command embeds preflightDenyProbe(process.platform)", () => {
  const W = world(), p = prepare(W, "dp1");
  if (WIN) return refusedOnWin(W, p);
  const r = runRunner(W, p.manifest, p.hash, ["--preflight-only"]);
  assert.equal(r.status, 0, r.stderr);
  const wrap = r.srt.filter((e) => e.ev === "wrap" && e.pre === true);
  assert.equal(wrap.length, 1);
  assert.ok(String(wrap[0]?.cmd).includes(preflightDenyProbe(process.platform)));
});

// #652 network leg classifier (pure, every OS): the exact connect source the runner embeds, evaluated per platform
// in a vm whose process.exit, fs.writeSync, net.connect and setTimeout only record. Linux ECONNREFUSED is accepted
// ONLY because the runner holds a live listener on that port (see the runner tests below); every other platform
// refuses it. Classification only, never confinement.
test("pure preflightConnectProbe: per-platform accepted errno, named refusals, open 72, timeout 74, port validation 73", () => {
  type Sock = EventEmitter & { destroy(): void; end(): void; unref(): void; ref(): void };
  const run = (platform: NodeJS.Platform, port: unknown, act?: (s: Sock, timers: (() => void)[]) => void) => {
    const exits: number[] = [], err: string[] = [], opened: { host?: unknown; port?: unknown }[] = [];
    const timers: (() => void)[] = [], ms: number[] = [];
    const sock = Object.assign(new EventEmitter(), { destroy() {}, end() {}, unref() {}, ref() {} }) as Sock;
    const connect = runInNewContext(`${preflightConnectProbe(platform)}connect`, {
      process: { exit: (c: number) => { exits.push(c); } },
      fs: { writeSync: (fd: number, s: string) => { err.push(`${fd}>${s}`); } },
      net: { connect: (o: { host?: unknown; port?: unknown }) => { opened.push(o); return sock; } },
      setTimeout: (f: () => void, t: number) => { timers.push(f); ms.push(t); return 0; },
      Number,
    }) as (port: unknown) => void;
    connect(port);
    if (act) act(sock, timers);
    return { out: `${exits.join(",")} ${err.join("")}`, opened: opened.map((o) => [o.host, o.port]), ms };
  };
  const fail = (code?: string) => (s: Sock): void => {
    s.emit("error", code === undefined ? new Error("no code") : Object.assign(new Error(code), { code }));
  };
  for (const platform of ["darwin", "linux", "win32", "freebsd"] as const) {
    const src = preflightConnectProbe(platform);
    assert.ok(!src.includes("'"), `${platform}: double quotes only, so the runner's single-quote shell quoting keeps it verbatim`);
    const linux = platform === "linux";
    // A valid port: exactly one loopback connect to that number and one 3000 ms timer.
    for (const [port, n] of [[40000, 40000], ["40000", 40000], [1, 1], ["65535", 65535]] as const) {
      const r = run(platform, port);
      assert.deepEqual(r.opened, [["127.0.0.1", n]], `${platform} ${String(port)}: connect target`);
      assert.deepEqual(r.ms, [3000], `${platform} ${String(port)}: one 3000 ms timer`);
      assert.equal(r.out, " ", `${platform} ${String(port)}: no outcome before an event`);
    }
    for (const code of ["EPERM", "EACCES"]) assert.equal(run(platform, 40000, fail(code)).out, "0 ", `${platform}: ${code}`);
    assert.equal(run(platform, 40000, fail("ECONNREFUSED")).out, linux ? "0 " : "73 2>connect:ECONNREFUSED ",
      `${platform}: ECONNREFUSED is a denial on Linux only`);
    for (const code of ["ENETUNREACH", "ETIMEDOUT", "EHOSTUNREACH", "ECONNRESET", "EADDRNOTAVAIL", "ENOENT", "EINVAL", "E652UNKNOWN"]) {
      assert.equal(run(platform, 40000, fail(code)).out, `73 2>connect:${code} `, `${platform}: ${code} is refused and named`);
    }
    assert.equal(run(platform, 40000, fail()).out, "73 2>connect:undefined ", `${platform}: an error without a code is refused`);
    assert.equal(run(platform, 40000, (s) => { s.emit("connect"); }).out, "72 2>connect:open ", `${platform}: reached a listener`);
    assert.equal(run(platform, 40000, (_s, t) => { for (const f of t) f(); }).out, "74 2>connect:timeout ", `${platform}: no answer`);
    // Not an integer port in 1..65535: refused before any socket is opened.
    for (const port of [0, "0", 65536, "65536", -1, "-1", 1.5, "1.5", "abc", "", undefined, null, Number.NaN]) {
      const r = run(platform, port);
      assert.equal(r.out, "73 2>connect:port ", `${platform} ${String(port)}: invalid port`);
      assert.deepEqual(r.opened, [], `${platform} ${String(port)}: no socket for an invalid port`);
    }
  }
});

// #652 control-listener address check (pure, every OS): only a 127.0.0.1 TCP port that is neither SRT's in-sandbox
// proxy port nor a port the runtime reports as reserved.
test("pure preflightControlPort: loopback IPv4 only; pipe, wildcard, IPv6, bad, proxy and reserved ports refuse listener", () => {
  assert.deepEqual([...PREFLIGHT_PROXY_PORTS], [3128, 1080]);
  const at = (address: string, port: number): AddressInfo => ({ address, family: "IPv4", port });
  for (const port of [1, 3848, 40000, 65535]) {
    assert.equal(preflightControlPort(at("127.0.0.1", port), []), port);
    assert.equal(preflightControlPort(at("127.0.0.1", port), [undefined, undefined]), port);
    assert.equal(preflightControlPort(at("127.0.0.1", port), [port + 1, undefined]), port);
  }
  const refuse = (address: AddressInfo | string | null, reserved: readonly (number | undefined)[], label: string): void => {
    assert.throws(() => preflightControlPort(address, reserved), { message: "SANDBOX_PREFLIGHT_FAILED: listener" }, label);
  };
  refuse(null, [], "null");
  for (const pipe of ["/tmp/652.sock", "\\\\.\\pipe\\652"]) refuse(pipe, [], `pipe ${pipe}`);
  for (const host of ["::1", "0.0.0.0", "::", "127.0.0.2", "localhost", "::ffff:127.0.0.1", "10.0.0.1"]) {
    refuse({ address: host, family: host.includes(":") ? "IPv6" : "IPv4", port: 40000 }, [], `address ${host}`);
  }
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) refuse(at("127.0.0.1", port), [], `port ${port}`);
  for (const port of [3128, 1080, ...PREFLIGHT_PROXY_PORTS]) refuse(at("127.0.0.1", port), [undefined, undefined], `proxy ${port}`);
  refuse(at("127.0.0.1", 40000), [40000], "reserved");
  refuse(at("127.0.0.1", 40000), [undefined, 40000], "reserved socks");
});

// Runner instrumentation for the network leg (MOCK BOUNDARY: fake SRT; the runner's own node:net is real). A
// --require preload records every net server and socket the runner process creates (the fake's client included)
// and whether the event loop drained by itself, i.e. no listener, socket or timer kept the runner alive and no
// forced exit cut cleanup short. Written at process exit to FAKE_TRACE_FILE.
const TRACE = `const net = require("node:net"), fs = require("node:fs"), { syncBuiltinESMExports } = require("node:module");
const out = process.env.FAKE_TRACE_FILE, servers = [], sockets = [];
const track = (s, kind) => { const r = { kind, closed: false }; sockets.push(r); s.once("close", () => { r.closed = true; }); return s; };
const cs = net.createServer, cn = net.connect, cc = net.createConnection;
net.createServer = function (...a) {
  const s = cs.apply(this, a), r = { listened: false, closed: false, address: null };
  servers.push(r);
  s.once("listening", () => { r.listened = true; r.address = s.address(); });
  s.once("close", () => { r.closed = true; });
  s.on("connection", (c) => { track(c, "accepted"); });
  return s;
};
net.connect = function (...a) { return track(cn.apply(this, a), "client"); };
net.createConnection = function (...a) { return track(cc.apply(this, a), "client"); };
syncBuiltinESMExports();
let drained = false;
process.once("beforeExit", () => { drained = true; });
process.on("exit", () => { fs.writeFileSync(out, JSON.stringify({ drained, servers, sockets })); });
`;
interface Trace { drained: boolean; servers: { listened: boolean; closed: boolean; address: AddressInfo | null }[];
  sockets: { kind: string; closed: boolean }[] }
function traced(W: World, manifest: string, hash: string, extra: string[] = [], extraEnv: Record<string, string> = {}):
  Run & { trace: Trace | null; cmd: string; port: number } {
  const pre = join(W.root, "trace.cjs"), out = join(W.root, `trace-${randomUUID()}.json`);
  if (!existsSync(pre)) writeFileSync(pre, TRACE);
  const r = runRunner(W, manifest, hash, extra, { NODE_OPTIONS: `--require ${JSON.stringify(pre)}`, FAKE_TRACE_FILE: out, ...extraEnv });
  const cmd = String(r.srt.find((e) => e.ev === "wrap" && e.pre === true)?.cmd ?? "");
  return { ...r, trace: readJson(out) as Trace | null, cmd, port: Number(/'(\d+)'$/.exec(cmd)?.[1] ?? 0) };
}
/** One loopback listener on the preflight's port, closed; `accepted` sockets; every socket closed; loop drained. */
function cleanedUp(r: ReturnType<typeof traced>, accepted: number, label: string): void {
  const t = r.trace;
  assert.ok(t, `${label}: no trace (runner did not exit normally): ${r.stderr}`);
  assert.equal(t.drained, true, `${label}: event loop did not drain by itself (open handle or forced exit)`);
  assert.equal(t.servers.length, 1, `${label}: exactly one control listener`);
  const s = t.servers[0]!;
  assert.deepEqual([s.listened, s.closed, s.address?.address, s.address?.port], [true, true, "127.0.0.1", r.port],
    `${label}: listener bound to 127.0.0.1 on the preflight's port and closed`);
  assert.equal(t.sockets.filter((k) => k.kind === "accepted").length, accepted, `${label}: accepted connections`);
  assert.deepEqual(t.sockets.filter((k) => !k.closed), [], `${label}: every socket closed`);
}

// #652 F1: the preflight targets a LIVE host listener the runner bound itself (never the empty literal 3848), passed
// as the last argv after the canary; the runner consults SRT's proxy-port getters when present. MOCK BOUNDARY.
test("runner (fake SRT): preflight connects to the runner's own live 127.0.0.1 listener port, last argv, never 3848; cleaned up", () => {
  const W = world(), p = prepare(W, "np1");
  if (WIN) return refusedOnWin(W, p);
  const canary = read(String(p.m.probeFile));
  for (const proxy of [false, true]) {
    const r = traced(W, p.manifest, p.hash, ["--preflight-only"], proxy ? { FAKE_PROXY_PORTS: "1" } : {});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, / OS confinement preflight passed\n$/);
    assert.ok(r.cmd.includes(preflightConnectProbe(process.platform)), "embeds this platform's connect classifier");
    assert.ok(r.cmd.includes(preflightDenyProbe(process.platform)), "still embeds this platform's deny probe");
    assert.ok(r.cmd.includes("connect(process.argv[5])"), "connects to the passed port");
    assert.ok(!r.cmd.includes("port:3848") && r.port !== 3848, "no fixed 3848 target");
    assert.ok(Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535, `port ${r.port}`);
    assert.ok(![3128, 1080, ...PREFLIGHT_PROXY_PORTS].includes(r.port), `port ${r.port} is a proxy port`);
    assert.ok(r.cmd.endsWith(`${sq(canary)} '${r.port}'`), "the port is the last argv, right after the canary");
    cleanedUp(r, 1, `success proxy=${String(proxy)}`);
    const getters = r.srt.filter((e) => e.ev === "getProxyPort" || e.ev === "getSocksProxyPort").map((e) => e.ev).sort();
    assert.deepEqual(getters, proxy ? ["getProxyPort", "getSocksProxyPort"] : []);
  }
});

// #652 F3: a fake SRT whose preflight REACHES the runner's live control port (host-side) yet exits 0 must be refused
// connect:leaked before any worker, receipt or token read, regardless of the child's exit code or a canary leak.
test("runner (fake SRT): a preflight that reached the live control port but exits 0 refuses connect:leaked, no worker/receipt", () => {
  const cases: [string, boolean, string[], Record<string, string>][] = [
    ["worker", false, [], {}], ["worker+opt-in", true, [], {}], ["preflight-only", false, ["--preflight-only"], {}],
    ["exit71", false, [], { FAKE_PREFLIGHT_EXIT: "71" }], ["canary", false, [], { FAKE_PREFLIGHT_LEAK: "" }],
  ];
  for (const [name, opted, args, extraEnv] of cases) {
    const W = world(), p = prepare(W, `nl-${name.replace(/\W/g, "")}`, opted ? { [OPT]: W.token } : {});
    if (WIN) { refusedOnWin(W, p); continue; }
    if (opted) rmSync(String(p.m.claudeOAuthHandoff));
    const env2 = { FAKE_PREFLIGHT_CONNECT: "1", ...extraEnv };
    if ("FAKE_PREFLIGHT_LEAK" in env2) env2.FAKE_PREFLIGHT_LEAK = String(p.m.probeFile);
    const r = traced(W, p.manifest, p.hash, args, env2);
    assert.equal(r.status, 78, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /\[sandbox\] REFUSED: SANDBOX_PREFLIGHT_FAILED: connect:leaked\n$/, name);
    assert.doesNotMatch(r.stderr, /preflight passed/, name);
    const fc = r.srt.filter((e) => e.ev === "fakeConnect");
    assert.deepEqual(fc.map((e) => [e.port, e.connected]), [[r.port, true]], `${name}: the fake reached the live listener`);
    assert.equal(r.worker, null, name);
    assert.equal(existsSync(join(dirname(p.manifest), "receipt.json")), false, name);
    assert.deepEqual(leaks(W, [r.stderr]), [], name);
    cleanedUp(r, 2, name);
  }
});

// #652 F1 cleanup: on every refusal path after bind (child exit 72/73/74, wrap error, spawn error) the listener and
// all sockets are closed and the runner exits by itself; the existing exit-code refusal text is unchanged.
test("runner (fake SRT): listener cleanup on failed preflight, wrap error and spawn error; no worker, no receipt", () => {
  const W = world(), p = prepare(W, "nc1");
  if (WIN) return refusedOnWin(W, p);
  const cases: [string, Record<string, string>, RegExp][] = [
    ...["72", "73", "74"].map((c): [string, Record<string, string>, RegExp] =>
      [`exit${c}`, { FAKE_PREFLIGHT_EXIT: c }, new RegExp(`\\[sandbox\\] REFUSED: SANDBOX_PREFLIGHT_FAILED: ${c} \\n$`)]),
    ["wrap", { FAKE_WRAP_FAIL: "1" }, /\[sandbox\] REFUSED: FAKE_WRAP_FAILED\n$/],
    ["spawn", { FAKE_SPAWN_FAIL: join(W.root, "absent-node") }, /\[sandbox\] REFUSED: spawn .*absent-node ENOENT\n$/],
  ];
  for (const [name, extraEnv, msg] of cases) {
    const r = traced(W, p.manifest, p.hash, [], extraEnv);
    assert.equal(r.status, 78, `${name}: ${r.stderr}`);
    assert.match(r.stderr, msg, name);
    assert.equal(r.worker, null, name);
    assert.equal(existsSync(join(dirname(p.manifest), "receipt.json")), false, name);
    cleanedUp(r, 1, name);
  }
});

// #652 LIVE, darwin only (registered only there; Linux and win32 collect no test, so no skip): the
// built runner on the REAL @anthropic-ai/sandbox-runtime (sandbox-exec), no fake. The manifest is
// staged under the denied HOME as dispatch stages under ~/.aigentry/sessions, so the canary lies
// inside a denied region. SRT emits (allow file-read-metadata (vnode-type DIRECTORY)) whenever a
// read deny exists, so stat/lstat of the directory canary is allowed and only readdir of it and
// stat/lstat of the file inside it can be required. Mutation: the 2026-10-04 (ef40fdf) deny set,
// which required stat/lstat of the directory itself, must still fail with 71 on the same manifest.
const NEW_DENIES = /deny\('readdir',\(\)=>fs\.readdirSync\(process\.argv\[3\]\),'synthetic\.txt'\);\s*deny\('stat',\(\)=>fs\.statSync\(process\.argv\[3\]\+'\/synthetic\.txt'\)\);\s*deny\('lstat',\(\)=>fs\.lstatSync\(process\.argv\[3\]\+'\/synthetic\.txt'\)\);/;
const OLD_DENIES = "deny('stat',()=>fs.statSync(process.argv[3]));deny('lstat',()=>fs.lstatSync(process.argv[3]));deny('readdir',()=>fs.readdirSync(process.argv[3]),'synthetic.txt');";
if (process.platform === "darwin") test("live macOS confinement preflight passes on the real SRT; the old directory-stat deny set fails 71", () => {
  const W = world();
  W.sessions = join(W.host, ".aigentry", "sessions");
  const p = prepare(W, "live1");
  assert.equal(p.error, null);
  roots.push(String((p.m.env as Json).TMPDIR));
  const live = (runner: string) => spawnSync(process.execPath, [runner, p.manifest, p.hash, "--preflight-only"],
    { encoding: "utf8", timeout: 60000, env: sysEnv(W) });
  const ok = live(join(DIST_SESSION, "worker-sandbox-runner.js"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, / OS confinement preflight passed\n/);
  // Same sealed manifest, same real SRT, a copy of the built runner with only the deny lines reverted.
  const root = mkdtempSync(join(tmpdir(), "claude-oauth-652-live-"));
  roots.push(root);
  cpSync(DIST_SESSION, join(root, "dist", "src", "session"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  const mutant = join(root, "dist", "src", "session", "worker-sandbox-runner.js"), src = read(mutant);
  assert.equal((src.match(new RegExp(NEW_DENIES.source, "g")) ?? []).length, 1, "the built runner no longer carries the repaired deny set");
  writeFileSync(mutant, src.replace(NEW_DENIES, OLD_DENIES));
  const old = live(mutant);
  assert.equal(old.status, 78, old.stderr);
  assert.match(old.stderr, /\[sandbox\] REFUSED: SANDBOX_PREFLIGHT_FAILED: 71 stat:readable /);
  // 71 is also sandbox-exec's own exit when it cannot apply a profile (nested sandbox); that is not this.
  assert.doesNotMatch(old.stderr, /sandbox_apply/);
});

// #652 LIVE, Linux arm: the same built runner on the REAL @anthropic-ai/sandbox-runtime (bubblewrap),
// no fake. Registered only on Linux AND only when the real SRT's own dependency check reports no error
// on this host (bwrap, socat, ripgrep): without them the runner refuses SANDBOX_DEPENDENCIES before any
// preflight, so there is no live confinement to measure, and a test that is not registered is not a
// skip. CI's ubuntu test job installs them. Only the repaired deny set is asserted: the darwin mutant
// rests on sandbox-exec's directory-metadata rule, which bwrap does not share and nobody has measured
// here, so the old deny set is never reused as a Linux mutant.
const linuxLive = process.platform === "linux" &&
  (await (await import("@anthropic-ai/sandbox-runtime")).SandboxManager.checkDependenciesAsync()).errors.length === 0;
if (linuxLive) test("live Linux confinement preflight passes on the real SRT (bubblewrap) with the repaired deny set", () => {
  const W = world();
  W.sessions = join(W.host, ".aigentry", "sessions");
  const p = prepare(W, "live2");
  assert.equal(p.error, null);
  roots.push(String((p.m.env as Json).TMPDIR));
  const runner = join(DIST_SESSION, "worker-sandbox-runner.js");
  assert.equal((read(runner).match(new RegExp(NEW_DENIES.source, "g")) ?? []).length, 1, "the built runner carries the repaired deny set");
  const ok = spawnSync(process.execPath, [runner, p.manifest, p.hash, "--preflight-only"],
    { encoding: "utf8", timeout: 60000, env: sysEnv(W) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, / OS confinement preflight passed\n/);
});
