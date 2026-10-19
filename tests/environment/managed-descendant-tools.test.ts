import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv, finish, fixture } from "./s2-acceptance/fixture.js";
import { bindManagedTerminalTools, captureManagedRuntime, pinTrustedFile,
  terminalIdentityText } from "../../src/environment/helper-env.js";

const openSession = fileURLToPath(new URL("../../src/session/open-session/cli.js", import.meta.url));
const whCli = fileURLToPath(new URL("../../../bin/wh-cli.sh", import.meta.url));
const preload = fileURLToPath(new URL("./s2-acceptance/_runner-preload.js", import.meta.url));
const driver = fileURLToPath(new URL("./s2-acceptance/_managed-driver.js", import.meta.url));

interface Info { manifest: string; hash: string; launcher: string; project: string; sid: string }
interface RecordLine { name: string; variant: string; argv: string[]; envKeys: string[] }

function prepare(root: string): Info {
  const result = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
    encoding: "utf8", timeout: 30_000, env: { ...childEnv(root), R2_FIXTURE_ROOT: root, R2_MODE: "prepare" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(root, "managed-info.json"), "utf8")) as Info;
}

function fake(root: string, name: string, variant = "original"): void {
  const code = `#!${process.execPath}\n` +
    `const fs=require('node:fs'),path=require('node:path');\n` +
    `const root=${JSON.stringify(root)},name=${JSON.stringify(name)},variant=${JSON.stringify(variant)};\n` +
    `const argv=process.argv.slice(2);\n` +
    `fs.writeFileSync(path.join(root,'descendant-'+process.pid+'.json'),JSON.stringify({name,variant,argv,` +
    `envKeys:Object.keys(process.env).sort()})+'\\n',{flag:'wx',mode:0o600});\n` +
    `if(name==='cmux'){if(argv[0]==='--help')console.log('new-workspace --focus');` +
    `else if(argv[0]==='new-workspace'||argv[0]==='list-workspaces')console.log('workspace:42');` +
    `else if(argv[0]==='surface-health')console.log('type=terminal');` +
    `else if(argv[0]==='read-screen')console.log('ready');}\n` +
    `if(name==='telepty'&&argv[0]==='list')console.log('[]');\n` +
    `if(name==='node')process.exit(20);\n` +
    `if(name==='uname')console.log('Darwin');\n`;
  fs.writeFileSync(path.join(root, "bin", name === "telepty" && variant === "replacement" ?
    "telepty-replacement" : name), code, { flag: "wx", mode: 0o700 });
}

function tools(root: string): void {
  for (const name of ["cmux", "aterm", "tmux", "wezterm", "telepty", "osascript", "uname", "node"]) fake(root, name);
  fake(root, "telepty", "replacement");
}

function records(root: string): RecordLine[] {
  return fs.readdirSync(root).filter(name => /^descendant-[0-9]+\.json$/.test(name))
    .map(name => JSON.parse(fs.readFileSync(path.join(root, name), "utf8")) as RecordLine);
}

function finishWithSnapshots(root: string, summary: unknown): void {
  const writable = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name);
      if (fs.lstatSync(child).isDirectory()) writable(child);
    }
    fs.chmodSync(dir, 0o700);
  };
  writable(root);
  finish(root, summary);
}

function invoke(root: string, info: Info, adapter: string, extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...childEnv(root), HOME: path.join(root, "host"),
    PATH: `${path.join(root, "bin")}:/usr/bin:/bin`, R2_FIXTURE_ROOT: root, R2_MODE: "terminal",
    AIGENTRY_WORKSPACE_HOST: adapter, AIGENTRY_SLEEP_GUARD: "0", NODE_OPTIONS: undefined, BASH_ENV: undefined,
    ...extra };
  return spawnSync(process.execPath, ["--import", preload, openSession,
    "--track", "r2", "--name", "worker", "--cwd", info.project, "--cli", info.launcher,
    "--launch-policy", "managed-secret", "--managed-manifest", info.manifest,
    "--manifest-sha256", info.hash, "--extra-flags", "--model fixture-model --effort high"],
  { encoding: "utf8", timeout: 20_000, env });
}

test("managed door identity serializes adjacent high inodes exactly", () => {
  const base = { dev: 16777229n, ino: 9007199254740993n, size: 101168n,
    mtimeNs: 1775463057123456789n, uid: 0n };
  const exact = terminalIdentityText(base);
  assert.equal(exact, "16777229:9007199254740993:101168:1775463057:0");
  assert.notEqual(exact, terminalIdentityText({ ...base, ino: 9007199254740992n }));
  assert.notEqual(exact, terminalIdentityText({ ...base, size: base.size + 1n }));
  assert.notEqual(exact, terminalIdentityText({ ...base, mtimeNs: base.mtimeNs + 1000000000n }));
});

test("managed source snapshot pins every reached shell library and detects byte or mode drift", {
  skip: process.platform === "win32",
}, () => {
  const names = ["platform.sh", "platform-unix.sh", "platform-windows.sh", "workspace-host.sh", "node-shim.sh"];
  for (const name of names) {
    const root = fixture(), bin = path.join(root, "bin"), lib = path.join(bin, "lib");
    fs.mkdirSync(lib, { recursive: true, mode: 0o700 });
    tools(root);
    const sourceLib = path.join(path.dirname(whCli), "lib");
    for (const item of names) fs.copyFileSync(path.join(sourceLib, item), path.join(lib, item));
    const original = path.join(lib, name);
    const second = Math.floor(Date.now() / 1000) - 10;
    fs.utimesSync(original, second, second);
    const originalBytes = fs.readFileSync(original), before = fs.statSync(original, { bigint: true });
    const scratch = path.join(root, "scratch");
    fs.mkdirSync(scratch, { mode: 0o700 });
    const launcher = path.join(bin, "launcher");
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
    const runtime = captureManagedRuntime({ PATH: `${bin}:/usr/bin:/bin` }, scratch);
    pinTrustedFile(runtime, "terminal", launcher);
    const bound = bindManagedTerminalTools(runtime, launcher, bin,
      path.resolve(path.dirname(openSession), "..", "..", ".."));
    bound.assert();
    const copy = path.join(bound.directory, "source", "bin", "lib", name);
    assert.deepEqual(fs.readFileSync(copy), originalBytes);
    assert.equal(fs.statSync(copy).mode & 0o777, 0o400);
    const changed = Buffer.from(originalBytes);
    changed[0] = changed[0] === 35 ? 33 : 35;
    fs.writeFileSync(original, changed);
    fs.utimesSync(original, second, second);
    const after = fs.statSync(original, { bigint: true });
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.throws(() => bound.assert(), /ENV_HELPER_PATH_REFUSED/);
    assert.deepEqual(fs.readFileSync(copy), originalBytes);
    finishWithSnapshots(root, { source: name, snapshot: "original", changedContent: "refused" });
  }

  const root = fixture(), bin = path.join(root, "bin"), lib = path.join(bin, "lib");
  fs.mkdirSync(lib, { recursive: true, mode: 0o700 });
  tools(root);
  for (const name of names) fs.copyFileSync(path.join(path.dirname(whCli), "lib", name), path.join(lib, name));
  const scratch = path.join(root, "scratch"), launcher = path.join(bin, "launcher");
  fs.mkdirSync(scratch, { mode: 0o700 });
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
  const runtime = captureManagedRuntime({ PATH: `${bin}:/usr/bin:/bin` }, scratch);
  pinTrustedFile(runtime, "terminal", launcher);
  const bound = bindManagedTerminalTools(runtime, launcher, bin,
    path.resolve(path.dirname(openSession), "..", "..", ".."));
  bound.assert();
  fs.chmodSync(path.join(lib, "platform.sh"), 0o600);
  assert.throws(() => bound.assert(), /ENV_HELPER_PATH_REFUSED/);
  finishWithSnapshots(root, { changedMode: "refused" });
});

test("managed open-session consumes copied shell bytes after original source replacement", {
  skip: process.platform === "win32",
}, () => {
  const names = ["platform.sh", "platform-unix.sh", "platform-windows.sh", "workspace-host.sh", "node-shim.sh"];
  for (const name of names) {
    const root = fixture(), info = prepare(root), bin = path.join(root, "bin"), lib = path.join(bin, "lib");
    tools(root);
    fs.mkdirSync(lib, { mode: 0o700 });
    fs.copyFileSync(whCli, path.join(bin, "wh-cli.sh"));
    for (const item of names) fs.copyFileSync(path.join(path.dirname(whCli), "lib", item), path.join(lib, item));
    const target = path.join(lib, name), flag = path.join(root, "source-swapped"), marker = path.join(root, "source-marker");
    const injected = `\nprintf 'changed-source' > '${marker.replace(/'/g, "'\\''")}'\n`;
    const wrapper = `#!${process.execPath}\n` +
      `const fs=require('node:fs'),cp=require('node:child_process');\n` +
      `const target=${JSON.stringify(target)},flag=${JSON.stringify(flag)},injected=${JSON.stringify(injected)};\n` +
      `if(!fs.existsSync(flag)){fs.writeFileSync(flag,'1');fs.appendFileSync(target,injected)}\n` +
      `const r=cp.spawnSync('/bin/bash',process.argv.slice(2),{stdio:'inherit',env:process.env});\n` +
      `process.exit(r.status??1);\n`;
    fs.writeFileSync(path.join(bin, "bash"), wrapper, { flag: "wx", mode: 0o700 });
    const result = invoke(root, info, "headless", { AIGENTRY_SHIM_SCRIPT_DIR: bin });
    assert.equal(result.status, 78, `${name}: ${result.stderr}`);
    assert.equal(fs.existsSync(flag), true, name);
    assert.equal(fs.existsSync(marker), false, name);
    assert.equal(records(root).filter(r => r.name === "telepty").length, 0, name);
    finishWithSnapshots(root, { source: name, replacedAfterSnapshot: result.status, marker: false });
  }
});

test("managed open-session binds headless descendant before detection and refuses a swapped inode", {
  skip: process.platform === "win32",
}, () => {
  const root = fixture(), info = prepare(root);
  tools(root);
  const healthy = invoke(root, info, "headless");
  assert.equal(healthy.status, 0, healthy.stderr);
  const first = records(root);
  assert.ok(first.some(r => r.name === "telepty" && r.variant === "original" && r.argv[0] === "spawn"));
  assert.ok(first.every(r => !r.argv.includes("--auto-restart")));
  assert.ok(first.every(r => !r.envKeys.includes("NODE_OPTIONS") && !r.envKeys.includes("BASH_ENV")));

  const switched = invoke(root, info, "headless", { R2_SWAP: "1" });
  assert.equal(switched.status, 78, switched.stderr);
  assert.equal(records(root).filter(r => r.name === "telepty" && r.variant === "replacement").length, 0);
  finishWithSnapshots(root, { healthy: healthy.status, replaced: switched.status, replacementCalls: 0 });
});

test("managed generated commands bind telepty across terminal adapters and preserve literal flags", {
  skip: process.platform === "win32",
}, () => {
  const root = fixture(), info = prepare(root);
  tools(root);
  const selectors: Record<string, NodeJS.ProcessEnv> = {
    cmux: { CMUX_WORKSPACE_ID: "fixture-pane" }, aterm: { ATERM_IPC_SOCKET: path.join(root, "aterm") },
    tmux: { TMUX: "fixture-tmux" }, wezterm: { TERM_PROGRAM: "WezTerm" },
    iterm: { TERM_PROGRAM: "iTerm.app" },
  };
  for (const [adapter, selector] of Object.entries(selectors)) {
    const before = new Set(fs.readdirSync(root).filter(x => x.startsWith("descendant-")));
    const result = invoke(root, info, adapter, selector);
    assert.equal(result.status, 0, `${adapter}: ${result.stderr}`);
    const fresh = fs.readdirSync(root).filter(x => x.startsWith("descendant-") && !before.has(x))
      .map(x => JSON.parse(fs.readFileSync(path.join(root, x), "utf8")) as RecordLine);
    assert.ok(fresh.some(r => r.argv.some(a => a.includes("/terminal-tools-") && a.includes("telepty"))), adapter);
    assert.ok(fresh.some(r => r.argv.some(a => a.includes("--model fixture-model --effort high"))), adapter);
    assert.ok(fresh.every(r => !r.argv.includes("--auto-restart")), adapter);
  }
  const legacy = invoke(root, info, "cmux", { CMUX_WORKSPACE_ID: "fixture-pane", AIGENTRY_WH_LEGACY_SPAWN: "1" });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.ok(records(root).some(r => r.name === "cmux" && r.argv[0] === "new-workspace" &&
    r.argv.some(a => a.includes("/terminal-tools-") && a.includes("telepty"))));
  const cmux = records(root).find(r => r.name === "cmux" && r.argv[0] === "new-workspace" &&
    r.argv.includes("--command"));
  assert.ok(cmux);
  const command = cmux.argv[cmux.argv.indexOf("--command") + 1];
  assert.ok(command);
  const delayed = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8", timeout: 10_000,
    env: { ...childEnv(root), PATH: `${path.join(root, "bin")}:/usr/bin:/bin` } });
  assert.equal(delayed.status, 0, delayed.stderr);
  assert.ok(records(root).some(r => r.name === "telepty" && r.variant === "original" && r.argv[0] === "allow" &&
    r.argv.includes("--model") && !r.argv.includes("--auto-restart")));
  fs.renameSync(path.join(root, "bin", "telepty-replacement"), path.join(root, "bin", "telepty"));
  const denied = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8", timeout: 10_000,
    env: { ...childEnv(root), PATH: `${path.join(root, "bin")}:/usr/bin:/bin` } });
  assert.equal(denied.status, 78, denied.stderr);
  assert.equal(records(root).filter(r => r.name === "telepty" && r.variant === "replacement").length, 0);
  finishWithSnapshots(root, { adapters: Object.keys(selectors), legacy: legacy.status,
    delayed: delayed.status, denied: denied.status });
});

test("managed shell door refuses missing and wrong caller binding before any fake tool", {
  skip: process.platform === "win32",
}, () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, "bin"), { mode: 0o700 });
  tools(root);
  const base = { ...childEnv(root), PATH: `${path.join(root, "bin")}:/usr/bin:/bin` };
  const args = [whCli, "open", "fixture-sid", root, "fixture-cli", "managed-secret"];
  const missing = spawnSync("/bin/bash", args, { encoding: "utf8", env: base });
  const wrong = spawnSync("/bin/bash", args, { encoding: "utf8",
    env: { ...base, AIGENTRY_MANAGED_BIN_DIR: path.join(root, "bin") } });
  fs.writeFileSync(path.join(root, "bin", "bash"), `#!/bin/sh\nexit 99\n`, { flag: "wx", mode: 0o700 });
  fs.writeFileSync(path.join(root, "bin", "managed-launcher"), `#!/bin/sh\nexit 99\n`, { flag: "wx", mode: 0o700 });
  const forged = spawnSync("/bin/bash", args, { encoding: "utf8",
    env: { ...base, PATH: path.join(root, "bin"), AIGENTRY_MANAGED_BIN_DIR: path.join(root, "bin") } });
  const mappedDetect = spawnSync("/bin/bash", [whCli, "detect-terminal"], { encoding: "utf8",
    env: { ...base, PATH: path.join(root, "bin"), AIGENTRY_MANAGED_BIN_DIR: path.join(root, "bin") } });
  assert.equal(missing.status, 78);
  assert.equal(wrong.status, 78);
  assert.equal(forged.status, 78);
  assert.equal(mappedDetect.status, 78);
  assert.deepEqual(records(root), []);
  const nativeDetect = spawnSync("/bin/bash", [whCli, "detect-terminal"], { encoding: "utf8",
    env: { ...base, AIGENTRY_WORKSPACE_HOST: "headless" } });
  assert.equal(nativeDetect.status, 0, nativeDetect.stderr);
  assert.equal(nativeDetect.stdout.trim(), "headless");
  const nativeOpen = spawnSync("/bin/bash", [whCli, "open", "fixture-sid", root, "fixture-cli", "native-only"],
    { encoding: "utf8", env: { ...base, AIGENTRY_WORKSPACE_HOST: "headless" } });
  assert.equal(nativeOpen.status, 0, nativeOpen.stderr);
  assert.ok(records(root).some(r => r.name === "telepty" && r.variant === "original" &&
    r.argv[0] === "spawn" && r.argv[1] === "--id" && r.argv[2] === "fixture-sid" &&
    r.argv[3] === "--" && r.argv[4] === "bash" && r.argv[5] === "-c" &&
    r.argv[6] === 'cd "$1" && exec fixture-cli' && r.argv[7] === "_" && r.argv[8] === root &&
    r.argv.length === 9));
  finish(root, { missing: missing.status, wrong: wrong.status, forged: forged.status,
    mappedDetect: mappedDetect.status, native: nativeOpen.status });
});
