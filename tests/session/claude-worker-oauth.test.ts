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
  rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BOOT = join(REPO_ROOT, "bin", "boot-prepare.mjs");
const DIST_SESSION = join(REPO_ROOT, "dist", "src", "session");
const OPT = "AIGENTRY_CLAUDE_OAUTH_TOKEN";
const CC = "CLAUDE_CODE_OAUTH_TOKEN";
const TASK = "652";
const WIN = process.platform === "win32";
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
const FAKE_SRT = `import fs from "node:fs";
const E = process.env, LOG = E.FAKE_SRT_LOG, PRE = E.FAKE_PREFLIGHT_RECORD, WREC = E.FAKE_WORKER_RECORD, EXP = E.FAKE_EXPECT_FILE;
const PF_EXIT = E.FAKE_PREFLIGHT_EXIT || "0", BASH = E.FAKE_BASH || "/bin/bash";
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
    return pre ? { argv: [process.execPath, "-e", REC, PRE], env: { FAKE_EXPECT_FILE: EXP, FAKE_PREFLIGHT_EXIT: PF_EXIT } }
      : { argv: [BASH, "-c", cmd], env: { FAKE_RECORD: WREC, FAKE_EXPECT_FILE: EXP } };
  },
  reset: async () => { log({ ev: "reset", env: has() }); },
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
  for (const p of [u, e]) {
    assert.equal(p.error, null);
    assert.equal(p.m.claudeOAuthHandoff, undefined);
    assert.equal(read(join(String((p.m.env as Json).CLAUDE_CONFIG_DIR), ".credentials.json")), W.hostCreds);
    assert.equal(p.counters.hostClaudeRead, 1);
  }
  assert.deepEqual(Object.keys(e.m.env as Json).sort(), Object.keys(u.m.env as Json).sort());
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
  assert.deepEqual([mode(h), mode(dirname(h))], ["600", "700"]);
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
  mode0644: (f) => chmodSync(f, 0o644),
  dir0755: (f) => chmodSync(dirname(f), 0o755),
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
    fn(String(p.m.claudeOAuthHandoff), W.token);
    const r = runRunner(W, p.manifest, p.hash);
    assert.equal(r.status, 78, `runner ${name}`);
    assert.match(r.stderr, /\[sandbox\] REFUSED: CLAUDE_OAUTH_HANDOFF_INVALID\n$/);
    assert.equal(r.worker, null);
    assert.equal(credsIn(p.m), false);
    const b = boot(W, `lt-${name}`, { [OPT]: W.token });
    fn(legacyHandoff(b.launcher), W.token);
    const l = runLauncher(W, b.launcher);
    assert.equal(l.status, 78, `legacy ${name}`);
    assert.equal(l.rec, null);
    assert.match(l.stderr, /OAuth handoff missing or malformed; refusing launch/);
    assert.deepEqual(leaks(W, [r.stderr, l.stderr]).filter((h) => !/\.real|\.hl$/.test(h)), []);
  }
});

test("marker rebind in a resealed manifest is refused before the sandbox is touched", () => {
  const W = world(), p = prepare(W, "m1", { [OPT]: W.token });
  const marker = String(p.m.claudeOAuthHandoff);
  for (const mut of [(m: Json) => { m.claudeOAuthHandoff = marker.replace(String(p.m.attempt), randomUUID()); },
    (m: Json) => { m.claudeOAuthHandoff = `${dirname(marker)}/../claude-oauth/token`; },
    (m: Json) => { m.cli = "codex"; }]) {
    const m = readJson(p.manifest) ?? {};
    mut(m);
    const data = JSON.stringify(m, null, 2) + "\n", file = join(dirname(p.manifest), `rebound-${seq++}.json`);
    writeFileSync(file, data, { mode: 0o600 });
    const r = runRunner(W, file, sha(data));
    assert.equal(r.status, 78);
    assert.match(r.stderr, /CLAUDE_OAUTH_HANDOFF_INVALID/);
    assert.deepEqual([r.srt.length, r.worker], [0, null]);
  }
});

// Deployed metadata guard (#652 must keep it): the canary is checked, and the preflight must pass,
// BEFORE the token is read. The handoff is removed first, so a premature read would surface as
// CLAUDE_OAUTH_HANDOFF_INVALID instead of the guard error.
test("metadata canary missing/not-a-directory/symlink refuses before any token read or SRT call", () => {
  const breakers: Record<string, (dir: string) => void> = {
    missing: (d) => rmSync(d, { recursive: true }),
    file: (d) => { rmSync(d, { recursive: true }); writeFileSync(d, "x\n", { mode: 0o600 }); },
    symlink: (d) => { renameSync(d, `${d}.real`); symlinkSync(`${d}.real`, d); },
  };
  for (const [name, brk] of Object.entries(breakers)) {
    for (const opted of [false, true]) {
      const W = world(), p = prepare(W, `cn-${name}-${String(opted)}`, opted ? { [OPT]: W.token } : {});
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
    assert.equal(p.error, "CLAUDE_OAUTH_TOKEN_INVALID");
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
