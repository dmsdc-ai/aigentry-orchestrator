import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { helperEnvironment, type HelperOperation, type TrustedRuntimeContext } from "../../../src/environment/helper-env.js";
import { childEnv, finish, fixture, invokeNode } from "./fixture.js";

const openSession = fileURLToPath(new URL("../../../src/session/open-session/cli.js", import.meta.url));
const whCli = fileURLToPath(new URL("../../../../bin/wh-cli.sh", import.meta.url));
const preload = fileURLToPath(new URL("./_runner-preload.js", import.meta.url));
const driver = fileURLToPath(new URL("./_managed-driver.js", import.meta.url));

interface TerminalInfo { manifest: string; hash: string; launcher: string; project: string; provider: string; sid: string }
function prepared(root: string): TerminalInfo {
  const result = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
    encoding: "utf8", timeout: 30_000, env: { ...childEnv(root), R2_FIXTURE_ROOT: root, R2_MODE: "prepare" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(root, "managed-info.json"), "utf8")) as TerminalInfo;
}
function fakeTool(root: string, name: string, variant = "original"): void {
  const source = `#!${process.execPath}\n` +
    `const fs=require('node:fs'),path=require('node:path');\n` +
    `const root=${JSON.stringify(root)},name=${JSON.stringify(name)},variant=${JSON.stringify(variant)};\n` +
    `const argv=process.argv.slice(2);\n` +
    `fs.writeFileSync(path.join(root,'tool-'+process.pid+'.json'),JSON.stringify({name,variant,argv,` +
    `source:!!process.env.AIGENTRY_CLAUDE_OAUTH_TOKEN,provider:!!process.env.CLAUDE_CODE_OAUTH_TOKEN,` +
    `vault:!!process.env.AWS_SECRET_ACCESS_KEY,preload:!!process.env.NODE_OPTIONS,` +
    `envKeys:Object.keys(process.env).sort(),fd3:(()=>{try{return !!fs.fstatSync(3)}catch{return false}})()})+'\\n',` +
    `{flag:'wx',mode:0o600});\n` +
    `if(name==='cmux'){if(argv[0]==='--help')console.log('new-workspace --focus');` +
    `else if(argv[0]==='new-workspace'||argv[0]==='list-workspaces')console.log('workspace:42');` +
    `else if(argv[0]==='surface-health')console.log('type=terminal');` +
    `else if(argv[0]==='read-screen')console.log('ready');}\n` +
    `if(name==='telepty'&&argv[0]==='list')console.log('[]');\n` +
    `if(name==='node')process.exit(20);\n` +
    `if(name==='uname')console.log('Darwin');\n` +
    `if(name==='osascript')console.log('ready');\n` +
    `if(name==='xdg-open'||name==='open'){try{fs.writeFileSync(path.join(root,'warp-surfaces','r2-worker.live'),'ready\\n',{flag:'wx',mode:0o600})}` +
    `catch(e){if(e.code!=='EEXIST')throw e}}\n`;
  fs.writeFileSync(path.join(root, "bin", name === "telepty" && variant === "replacement" ? "telepty-replacement" : name),
    source, { flag: "wx", mode: 0o700 });
}
function installTerminalTools(root: string): void {
  fs.mkdirSync(path.join(root, "warp-surfaces"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "warp-config"), { mode: 0o700 });
  for (const name of ["cmux", "aterm", "tmux", "wezterm", "telepty", "osascript", "xdg-open", "open", "pgrep", "uname", "node"]) {
    fakeTool(root, name);
  }
  fakeTool(root, "telepty", "replacement");
}
interface ToolRecord { name: string; variant: string; argv: string[]; source: boolean; provider: boolean;
  vault: boolean; preload: boolean; envKeys: string[]; fd3: boolean }
function toolRecords(root: string): ToolRecord[] {
  return fs.readdirSync(root).filter(name => /^tool-[0-9]+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as ToolRecord);
}
function terminalEnv(root: string, adapter: string): NodeJS.ProcessEnv {
  return { ...childEnv(root), HOME: path.join(root, "host"), PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
    AIGENTRY_WORKSPACE_HOST: adapter, AIGENTRY_WARP_SURFACE_DIR: path.join(root, "warp-surfaces"),
    AIGENTRY_WARP_TAB_CONFIG_DIR: path.join(root, "warp-config"), WARP_READY_TIMEOUT_MS: "100",
    WARP_READY_INTERVAL_MS: "10", CMUX_READY_TIMEOUT_MS: "100", CMUX_READY_INTERVAL_MS: "10",
    PLATFORM_OVERRIDE: "macos", AIGENTRY_SLEEP_GUARD: "0", NODE_OPTIONS: undefined, BASH_ENV: undefined };
}

test("public open-session denies managed impersonation and duplicate selector before terminal effects", { skip: process.platform === "win32" }, () => {
  const root = fixture(), attempt = randomUUID();
  const launcher = path.join(root, "central", "sessions", "fixture-sid", "sandbox", attempt, "launcher.sh");
  fs.mkdirSync(path.dirname(launcher), { recursive: true, mode: 0o700 });
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 77\n", { flag: "wx", mode: 0o700 });
  const base = ["--track", "fixture", "--name", "worker", "--cwd", root, "--cli", launcher];
  for (const tail of [["--launch-policy", "managed-secret"],
    ["--launch-policy", "native-only", "--launch-policy", "managed-secret"],
    ["--managed-manifest", path.join(root, "forged.json")]]) {
    const result = invokeNode(openSession, [...base, ...tail], root,
      { AIGENTRY_CLAUDE_OAUTH_TOKEN: "poison-canary", BASH_ENV: path.join(root, "poison") });
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /ENV_MANAGED_ROUTE_REFUSED/);
    assert.equal(fs.existsSync(path.join(root, "poison")), false);
    assert.equal((result.stdout + result.stderr).includes("poison-canary"), false);
  }
  finish(root, { routes: 3, terminalRecorderInvoked: false });
});

test("operation-specific helper environments exclude unrelated credential and preload canaries", () => {
  const root = fixture();
  const ctx: TrustedRuntimeContext = { base: { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root,
    LANG: "C", LC_ALL: "C", TERM: "dumb" }, temporary: root };
  const source: NodeJS.ProcessEnv = { AIGENTRY_HOME: root, TELEPTY_PORT: "4343", DISPATCH_STATE_DIR: root,
    AIGENTRY_CLAUDE_OAUTH_TOKEN: "source-canary", CLAUDE_CODE_OAUTH_TOKEN: "provider-canary",
    NODE_OPTIONS: "--require=/poison", BASH_ENV: "/poison", AWS_SECRET_ACCESS_KEY: "vault-canary",
    AIGENTRY_BOOT_MODEL: "fixture-model", AIGENTRY_BOOT_EFFORT: "high" };
  const recorded: Record<string, string[]> = {};
  for (const op of ["verify", "model", "boot", "registry", "telemetry", "control", "terminal", "binder"] as HelperOperation[]) {
    const env = helperEnvironment(ctx, op, source);
    for (const forbidden of ["AIGENTRY_CLAUDE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS",
      "BASH_ENV", "AWS_SECRET_ACCESS_KEY"]) assert.equal(env[forbidden], undefined, `${op}: ${forbidden}`);
    recorded[op] = Object.keys(env).sort();
  }
  assert.equal(helperEnvironment(ctx, "boot", source).AIGENTRY_BOOT_MODEL, "fixture-model");
  assert.equal(helperEnvironment(ctx, "verify", source).AIGENTRY_BOOT_MODEL, undefined);
  finish(root, { keysByOperation: recorded });
});

test("real wh-cli visits all seven adapter branches with managed no-restart and native restart", { skip: process.platform === "win32" }, () => {
  const root = fixture(), info = prepared(root);
  installTerminalTools(root);
  const adapters = ["cmux", "warp", "aterm", "tmux", "wezterm", "iterm", "headless"];
  for (const adapter of adapters) {
    for (const policy of ["managed-secret", "native-only"] as const) {
      const before = new Set(fs.readdirSync(root).filter(name => name.startsWith("tool-")));
      const command = `${info.launcher} --model fixture-model --effort high`;
      const result = spawnSync("/bin/bash", [whCli, "open", info.sid, info.project, command, policy], {
        encoding: "utf8", timeout: 10_000, env: terminalEnv(root, adapter),
      });
      assert.equal(result.status, 0, `${adapter}/${policy}: ${result.stderr}`);
      const fresh = fs.readdirSync(root).filter(name => /^tool-[0-9]+\.json$/.test(name) && !before.has(name))
        .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as ToolRecord);
      assert.ok(fresh.length > 0, `${adapter}/${policy}: no recorder process ran`);
      const toml = path.join(root, "warp-config", `telepty-${info.sid}.toml`);
      const observed = adapter === "warp" ? fs.readFileSync(toml, "utf8") :
        JSON.stringify(fresh.map(record => record.argv));
      assert.equal(observed.includes("--auto-restart"), policy === "native-only", `${adapter}/${policy}`);
      assert.match(observed, /--model fixture-model/);
      assert.match(observed, /--effort high/);
      assert.equal(fresh.some(r => r.source || r.provider || r.vault || r.preload), false);
      assert.equal(fresh.some(r => r.fd3), false);
    }
  }
  finish(root, { adapters, policies: ["managed-secret", "native-only"], recordedTools: toolRecords(root).length,
    caller: "wh-cli actual source adapter functions; no terminal launched" });
});

test("actual open-session selects six detectable adapters and legacy cmux with no managed restart", { skip: process.platform === "win32" }, () => {
  const root = fixture(), info = prepared(root);
  installTerminalTools(root);
  const args = ["--track", "r2", "--name", "worker", "--cwd", info.project, "--cli", info.launcher,
    "--launch-policy", "managed-secret", "--managed-manifest", info.manifest,
    "--manifest-sha256", info.hash, "--extra-flags", "--model fixture-model --effort high"];
  const selectors: Record<string, NodeJS.ProcessEnv> = { cmux: { CMUX_WORKSPACE_ID: "fixture-pane" },
    aterm: { ATERM_IPC_SOCKET: path.join(root, "fake-aterm-socket") }, tmux: { TMUX: "fixture-tmux" },
    wezterm: { TERM_PROGRAM: "WezTerm" }, iterm: { TERM_PROGRAM: "iTerm.app" }, headless: {} };
  for (const adapter of ["cmux", "aterm", "tmux", "wezterm", "iterm", "headless"]) {
    const before = new Set(fs.readdirSync(root).filter(name => name.startsWith("tool-")));
    const env = { ...terminalEnv(root, adapter), ...selectors[adapter], R2_FIXTURE_ROOT: root, R2_MODE: "terminal",
      AIGENTRY_CLAUDE_OAUTH_TOKEN: "source-canary", CLAUDE_CODE_OAUTH_TOKEN: "provider-canary",
      AWS_SECRET_ACCESS_KEY: "vault-canary" };
    const result = spawnSync(process.execPath, ["--import", preload, openSession, ...args], {
      encoding: "utf8", timeout: 20_000, env,
    });
    assert.equal(result.status, 0, `${adapter}: ${result.stderr}`);
    const fresh = fs.readdirSync(root).filter(name => /^tool-[0-9]+\.json$/.test(name) && !before.has(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as ToolRecord);
    const command = JSON.stringify(fresh.map(record => record.argv));
    assert.ok(fresh.length > 0, `${adapter}: no child recorder`);
    assert.equal(command.includes("--auto-restart"), false, adapter);
    assert.match(command, /--model fixture-model/);
    assert.match(command, /--effort high/);
    assert.equal(fresh.some(r => r.source || r.provider || r.vault || r.preload), false, adapter);
    assert.equal(fresh.some(r => r.fd3), false, adapter);
  }
  const before = new Set(fs.readdirSync(root).filter(name => name.startsWith("tool-")));
  const legacyEnv = { ...terminalEnv(root, "cmux"), CMUX_WORKSPACE_ID: "fixture-pane",
    AIGENTRY_WH_LEGACY_SPAWN: "1", R2_FIXTURE_ROOT: root, R2_MODE: "terminal" };
  const legacy = spawnSync(process.execPath, ["--import", preload, openSession, ...args], {
    encoding: "utf8", timeout: 20_000, env: legacyEnv,
  });
  assert.equal(legacy.status, 0, legacy.stderr);
  const legacyTools = fs.readdirSync(root).filter(name => /^tool-[0-9]+\.json$/.test(name) && !before.has(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as ToolRecord);
  assert.ok(legacyTools.some(record => record.name === "cmux" && record.argv[0] === "new-workspace"));
  assert.equal(JSON.stringify(legacyTools.map(record => record.argv)).includes("--auto-restart"), false);
  const nativeBefore = new Set(fs.readdirSync(root).filter(name => name.startsWith("tool-")));
  const native = spawnSync(process.execPath, ["--import", preload, openSession, "--track", "r2", "--name", "worker",
    "--cwd", info.project, "--cli", info.provider, "--launch-policy", "native-only",
    "--extra-flags", "--model fixture-model --effort high"], {
    encoding: "utf8", timeout: 20_000, env: { ...terminalEnv(root, "headless"), R2_FIXTURE_ROOT: root, R2_MODE: "terminal" },
  });
  assert.equal(native.status, 0, native.stderr);
  const nativeTools = fs.readdirSync(root).filter(name => /^tool-[0-9]+\.json$/.test(name) && !nativeBefore.has(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as ToolRecord);
  assert.ok(nativeTools.some(record => record.name === "telepty" && record.argv[0] === "spawn" &&
    JSON.stringify(record.argv).includes("--auto-restart")));
  finish(root, { managedAdapters: Object.keys(selectors), legacyCmux: true, nativeBaseline: true,
    recordedTools: toolRecords(root).length });
});

test("managed open-session must reject a descendant PATH tool replaced after terminal detection", { skip: process.platform === "win32" }, () => {
  const root = fixture(), info = prepared(root);
  installTerminalTools(root);
  const env = { ...terminalEnv(root, "headless"), R2_FIXTURE_ROOT: root, R2_MODE: "terminal", R2_SWAP: "1" };
  const result = spawnSync(process.execPath, ["--import", preload, openSession,
    "--track", "r2", "--name", "worker", "--cwd", info.project, "--cli", info.launcher,
    "--launch-policy", "managed-secret", "--managed-manifest", info.manifest,
    "--manifest-sha256", info.hash], { encoding: "utf8", timeout: 20_000, env });
  const replacements = toolRecords(root).filter(r => r.name === "telepty" && r.variant === "replacement");
  assert.equal(replacements.length, 0, `R4 H01 descendant replacement reached ${replacements.length} fake child; rc=${result.status}`);
  finish(root, { status: result.status, replacementCount: replacements.length });
});
