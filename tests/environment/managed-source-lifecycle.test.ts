import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bindManagedTerminalTools, captureManagedRuntime, pinTrustedFile } from "../../src/environment/helper-env.js";
import { childEnv, finish, fixture } from "./s2-acceptance/fixture.js";

const whCli = fileURLToPath(new URL("../../../bin/wh-cli.sh", import.meta.url));
const openSession = fileURLToPath(new URL("../../src/session/open-session/cli.js", import.meta.url));
const preload = fileURLToPath(new URL("./s2-acceptance/_runner-preload.js", import.meta.url));
const driver = fileURLToPath(new URL("./s2-acceptance/_managed-driver.js", import.meta.url));
const sourceNames = ["platform.sh", "platform-unix.sh", "platform-windows.sh", "workspace-host.sh", "node-shim.sh"];

function clean(root: string): void {
  finish(root, {});
}

function withOwnerWrite(dir: string, change: () => void): void {
  const before = fs.lstatSync(dir);
  assert.ok(before.isDirectory() && !before.isSymbolicLink());
  assert.equal(before.mode & 0o777, 0o500);
  fs.chmodSync(dir, 0o700);
  try { change(); }
  finally {
    const after = fs.lstatSync(dir);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    fs.chmodSync(dir, 0o500);
  }
}

function setup(missing?: string) {
  const root = fixture(), bin = path.join(root, "bin"), lib = path.join(bin, "lib");
  fs.mkdirSync(lib, { recursive: true, mode: 0o700 });
  for (const name of sourceNames) if (name !== missing) {
    fs.copyFileSync(path.join(path.dirname(whCli), "lib", name), path.join(lib, name));
  }
  const telepty = path.join(bin, "telepty"), launcher = path.join(bin, "launcher");
  fs.writeFileSync(telepty, "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
  fs.writeFileSync(launcher, `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "original-child"))},'ran',{flag:'wx',mode:0o600});\n`,
  { flag: "wx", mode: 0o700 });
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { mode: 0o700 });
  const runtime = captureManagedRuntime({ PATH: `${bin}:/usr/bin:/bin` }, scratch);
  pinTrustedFile(runtime, "terminal", launcher);
  const bind = () => bindManagedTerminalTools(runtime, launcher, bin,
    path.resolve(path.dirname(openSession), "..", "..", ".."));
  return { root, bin, runtime, bind };
}

test("source retirement keeps the exact doors and link target for a delayed command", {
  skip: process.platform === "win32",
}, () => {
  const f = setup(), bound = f.bind();
  const source = path.join(bound.directory, "source"), target = fs.readlinkSync(path.join(source, "dist"));
  bound.assert();
  bound.markHandoffPossible();
  const queued = { command: bound.launcher, tree: bound.directory,
    inode: fs.lstatSync(bound.launcher).ino };
  bound.retireSource();
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(target), true);
  bound.assertDoors();
  assert.throws(() => bound.assertSource());
  assert.throws(() => bound.retireBeforeHandoff(), /ENV_HELPER_RETIRE_REFUSED/);
  bound.retireSource();
  assert.equal(queued.tree, bound.directory);
  assert.equal(fs.lstatSync(queued.command).ino, queued.inode);
  const delayed = spawnSync(queued.command, [], { encoding: "utf8", timeout: 10_000 });
  assert.equal(delayed.status, 0, delayed.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, "original-child"), "utf8"), "ran");
  assert.equal(fs.existsSync(path.join(f.root, "replacement-child")), false);
  clean(f.root);
});

test("pre-handoff construction failure reclaims only its recorded partial tree", {
  skip: process.platform === "win32",
}, () => {
  const f = setup("node-shim.sh"), sentinel = path.join(f.runtime.temporary, "foreign");
  fs.writeFileSync(sentinel, "foreign", { flag: "wx", mode: 0o600 });
  assert.throws(f.bind, /ENV_HELPER_PATH_REFUSED/);
  assert.deepEqual(fs.readdirSync(f.runtime.temporary), ["foreign"]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "foreign");
  clean(f.root);
});

test("foreign entry and changed inode refuse source retirement without touching either", {
  skip: process.platform === "win32",
}, () => {
  const f = setup(), bound = f.bind();
  const source = path.join(bound.directory, "source"), sentinel = path.join(source, "foreign");
  withOwnerWrite(source, () => fs.writeFileSync(sentinel, "foreign", { flag: "wx", mode: 0o600 }));
  // assertSource rejects the changed source directory identity before retirement preflight.
  assert.throws(() => bound.retireSource(), /ENV_HELPER_PATH_REFUSED/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "foreign");
  withOwnerWrite(source, () => fs.unlinkSync(sentinel));
  const copied = bound.platform, replacement = copied + ".replacement";
  const oldInode = fs.lstatSync(copied).ino;
  withOwnerWrite(path.dirname(copied), () => {
    fs.writeFileSync(replacement, fs.readFileSync(copied), { flag: "wx", mode: 0o400 });
    fs.renameSync(replacement, copied);
  });
  assert.notEqual(fs.lstatSync(copied).ino, oldInode);
  assert.throws(() => bound.retireSource(), /ENV_HELPER_PATH_REFUSED/);
  assert.equal(fs.existsSync(copied), true);
  clean(f.root);
});

test("an unlink error leaves known source entries for an exact retry", {
  skip: process.platform === "win32",
}, () => {
  const f = setup(), bound = f.bind(), source = path.join(bound.directory, "source");
  const lib = path.join(source, "bin", "lib");
  const first = path.join(lib, sourceNames[0]), second = path.join(lib, sourceNames[1]);
  const secondInode = fs.lstatSync(second).ino;
  const sealed = [source, path.join(source, "bin"), lib];
  const originalModes = sealed.map(dir => fs.lstatSync(dir).mode & 0o777);
  assert.deepEqual(originalModes, [0o500, 0o500, 0o500]);
  const original = fsDefault.unlinkSync;
  let calls = 0, successful = 0;
  fsDefault.unlinkSync = ((file: fs.PathLike) => {
    if (String(file).startsWith(source) && ++calls === 2) throw new Error("INJECTED_UNLINK");
    const result = original(file);
    if (String(file).startsWith(source)) successful++;
    return result;
  }) as typeof fsDefault.unlinkSync;
  syncBuiltinESMExports();
  try { assert.throws(() => bound.retireSource(), /INJECTED_UNLINK/); }
  finally { fsDefault.unlinkSync = original; syncBuiltinESMExports(); }
  assert.equal(calls, 2);
  assert.equal(successful, 1);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.lstatSync(second).ino, secondInode);
  assert.deepEqual(sealed.map(dir => fs.lstatSync(dir).mode & 0o777), originalModes);
  assert.equal(fs.existsSync(source), true);
  bound.retireSource();
  assert.equal(fs.existsSync(source), false);
  const afterRetry = fs.readdirSync(bound.directory).sort();
  bound.retireSource();
  assert.deepEqual(fs.readdirSync(bound.directory).sort(), afterRetry);
  clean(f.root);
});

function managedCliFixture(root: string, teleptyExit = 0, fault?: "log" | "cleanup") {
  const prepared = spawnSync(process.execPath, ["--import", preload, driver, "prepare"], {
    encoding: "utf8", timeout: 30_000, env: { ...childEnv(root), R2_FIXTURE_ROOT: root, R2_MODE: "prepare" },
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const info = JSON.parse(fs.readFileSync(path.join(root, "managed-info.json"), "utf8")) as {
    manifest: string; hash: string; launcher: string; project: string;
  };
  const launcherStat = fs.lstatSync(info.launcher);
  assert.ok(launcherStat.isFile() && !launcherStat.isSymbolicLink());
  fs.writeFileSync(info.launcher, `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "original-child"))},'ran',{flag:'wx',mode:0o600});\n`);
  fs.chmodSync(info.launcher, 0o700);
  const bin = path.join(root, "bin"), lib = path.join(bin, "lib");
  fs.mkdirSync(lib, { mode: 0o700 });
  for (const name of sourceNames) fs.copyFileSync(path.join(path.dirname(whCli), "lib", name), path.join(lib, name));
  const trace = path.join(root, "bash-trace.jsonl");
  fs.writeFileSync(path.join(bin, "bash"), `#!${process.execPath}\n` +
    `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');\n` +
    `const d=process.env.AIGENTRY_MANAGED_BIN_DIR;\n` +
    `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({argv:process.argv.slice(2),source:d?fs.existsSync(path.join(d,'source')):null})+'\\n');\n` +
    `const r=cp.spawnSync('/bin/bash',process.argv.slice(2),{stdio:'inherit',env:process.env});process.exit(r.status??1);\n`,
  { flag: "wx", mode: 0o700 });
  const externalTrace = path.join(root, "external.jsonl");
  for (const name of ["ps", "caffeinate", "systemd-inhibit"]) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n` +
      `require('node:fs').appendFileSync(${JSON.stringify(externalTrace)},JSON.stringify({tool:${JSON.stringify(name)},argv:process.argv.slice(2)})+'\\n');\n`,
    { flag: "wx", mode: 0o700 });
  }
  const enqueue = path.join(root, "enqueue.json");
  fs.writeFileSync(path.join(bin, "telepty"), `#!${process.execPath}\n` +
    `if(process.argv[2]==='list')console.log('[]');else if(process.argv[2]==='spawn'){` +
    `const fs=require('node:fs'),path=require('node:path'),argv=process.argv.slice(2),command=argv[4],tree=path.dirname(command);` +
    `const stat=file=>{const s=fs.lstatSync(file);return {dev:s.dev,ino:s.ino}};` +
    `fs.writeFileSync(${JSON.stringify(enqueue)},JSON.stringify({argv,tree,treeId:stat(tree),commandId:stat(command)}),{flag:'wx',mode:0o600});` +
    `process.exit(${teleptyExit});}\n`,
  { flag: "wx", mode: 0o700 });
  fs.writeFileSync(path.join(bin, "session-cleanup.sh"), "#!/bin/sh\nexit 0\n", { flag: "wx", mode: 0o700 });
  const faultFile = path.join(root, "fault.cjs");
  if (fault) fs.writeFileSync(faultFile,
    `const fs=require('node:fs'),cp=require('node:child_process');` +
    `const {syncBuiltinESMExports}=require('node:module');` +
    (fault === "log" ?
      `const original=fs.appendFileSync;fs.appendFileSync=function(file,...rest){` +
      `if(String(file)===${JSON.stringify(path.join(root, "host", ".aigentry", "open-session.log"))})throw new Error('INJECTED_LOG_WRITE');` +
      `return original.call(fs,file,...rest)};` :
      `const original=cp.spawnSync;cp.spawnSync=function(command,args,...rest){` +
      `if(Array.isArray(args)&&args.includes(${JSON.stringify(path.join(bin, "session-cleanup.sh"))}))throw new Error('INJECTED_CLEANUP_SETUP');` +
      `return original.call(cp,command,args,...rest)};`) +
    `syncBuiltinESMExports();\n`, { flag: "wx", mode: 0o600 });
  const result = spawnSync(process.execPath, ["--import", preload, ...(fault ? ["--require", faultFile] : []), openSession,
    "--track", "r2", "--name", "worker", "--cwd", info.project, "--cli", info.launcher,
    "--launch-policy", "managed-secret", "--managed-manifest", info.manifest,
    "--manifest-sha256", info.hash, "--auto-cleanup-on-exit"], {
    encoding: "utf8", timeout: 20_000,
    env: { ...childEnv(root), HOME: path.join(root, "host"), PATH: `${bin}:/usr/bin:/bin`,
      R2_FIXTURE_ROOT: root, R2_MODE: "terminal", AIGENTRY_WORKSPACE_HOST: "headless",
      AIGENTRY_SHIM_SCRIPT_DIR: bin, AIGENTRY_SHIM_SCRIPT_PATH: path.join(bin, "open-session.sh"),
      AIGENTRY_SLEEP_GUARD: "1", AIGENTRY_SLEEP_GUARD_PID_TIMEOUT_MS: "1",
      NODE_OPTIONS: undefined, BASH_ENV: undefined },
  });
  const environment = path.join(root, "host", ".aigentry", "environment");
  let trees: string[];
  try {
    trees = fs.readdirSync(environment).flatMap(name => {
      const parent = path.join(environment, name), stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return [];
      return fs.readdirSync(parent).filter(child => {
        if (!child.startsWith("terminal-tools-")) return false;
        const tree = fs.lstatSync(path.join(parent, child));
        return tree.isDirectory() && !tree.isSymbolicLink() && tree.uid === process.getuid?.();
      }).map(child => path.join(parent, child));
    });
  } catch (error) {
    throw new Error(`managed CLI fixture collection failed: ${JSON.stringify({ fault, status: result.status,
      signal: result.signal, stdout: result.stdout, stderr: result.stderr,
      enqueue, enqueueExists: fs.existsSync(enqueue), trace, traceExists: fs.existsSync(trace) })}`, { cause: error });
  }
  return { result, trace, trees, externalTrace, enqueue };
}

function replayEnqueued(root: string, enqueue: string, tree: string): void {
  const recorded = JSON.parse(fs.readFileSync(enqueue, "utf8")) as {
    argv: string[]; tree: string; treeId: { dev: number; ino: number }; commandId: { dev: number; ino: number };
  };
  const args = recorded.argv;
  assert.deepEqual(args.slice(0, 4), ["spawn", "--id", "r2-worker", "--"]);
  const command = args[4], commandArgs = args.slice(5);
  assert.equal(recorded.tree, tree);
  assert.equal(command, path.join(tree, "bash"));
  assert.ok(commandArgs.join(" ").includes(path.join(tree, "managed-launcher")));
  assert.deepEqual({ dev: fs.lstatSync(tree).dev, ino: fs.lstatSync(tree).ino }, recorded.treeId);
  assert.deepEqual({ dev: fs.lstatSync(command).dev, ino: fs.lstatSync(command).ino }, recorded.commandId);
  assert.equal(fs.existsSync(path.join(tree, "source")), false);
  const replay = spawnSync(command, commandArgs, { encoding: "utf8", timeout: 15_000,
    env: { ...childEnv(root), HOME: path.join(root, "host"), PATH: `${path.join(root, "bin")}:/usr/bin:/bin` } });
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(fs.readFileSync(path.join(root, "original-child"), "utf8"), "ran");
  assert.equal(fs.existsSync(path.join(root, "replacement-child")), false);
}

test("managed CLI retains source through final synchronous calls then leaves doors for delayed use", {
  skip: process.platform === "win32",
}, () => {
  const root = fixture();
  try {
  const { result, trace, trees, externalTrace, enqueue } = managedCliFixture(root);
  assert.equal(result.status, 0, result.stderr);
  const rows = fs.readFileSync(trace, "utf8").trim().split("\n").map(s => JSON.parse(s) as { argv: string[]; source: boolean | null });
  assert.ok(rows.filter(r => r.argv.some(a => a.includes("detect-terminal"))).length >= 2);
  assert.ok(rows.some(r => r.argv.some(a => a.includes("platform::session_pid"))));
  assert.ok(rows.some(r => r.argv.some(a => a.includes("platform::hold_awake"))));
  assert.ok(rows.some(r => r.argv.some(a => a.includes("session-cleanup.sh"))));
  assert.ok(rows.every(r => r.source === true), JSON.stringify(rows));
  assert.equal(trees.length, 1);
  assert.equal(fs.existsSync(path.join(trees[0], "source")), false);
  assert.equal(fs.existsSync(path.join(trees[0], "managed-launcher")), true);
  const external = fs.readFileSync(externalTrace, "utf8").trim().split("\n").map(s => JSON.parse(s) as { tool: string; argv: string[] });
  assert.deepEqual(external, ["ps", "ps"].map(tool => ({ tool, argv: ["-eo", "pid,command"] })));
  for (const name of ["ps", "caffeinate", "systemd-inhibit"]) {
    assert.ok(fs.readFileSync(path.join(trees[0], name), "utf8").includes(path.join(root, "bin", name)));
  }
  replayEnqueued(root, enqueue, trees[0]);
  } finally { clean(root); }
});

test("a failed adapter return after possible enqueue retains doors and launcher", {
  skip: process.platform === "win32",
}, () => {
  const root = fixture(), { result, trees, enqueue } = managedCliFixture(root, 7);
  assert.equal(result.status, 7, result.stderr);
  assert.equal(trees.length, 1);
  assert.equal(fs.existsSync(path.join(trees[0], "source")), false);
  assert.equal(fs.existsSync(path.join(trees[0], "managed-launcher")), true);
  assert.equal(fs.existsSync(path.join(trees[0], "telepty")), true);
  replayEnqueued(root, enqueue, trees[0]);
  clean(root);
});

for (const fault of ["log", "cleanup"] as const) {
  test(`${fault} failure after possible enqueue retires source and preserves the original error`, {
    skip: process.platform === "win32",
  }, () => {
    const root = fixture(), { result, trace, trees, enqueue } = managedCliFixture(root, 0, fault);
    try {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(fault === "log" ? "INJECTED_LOG_WRITE" : "INJECTED_CLEANUP_SETUP"));
      assert.equal(fs.existsSync(enqueue), true, "adapter recorded possible enqueue");
      const rows = fs.readFileSync(trace, "utf8").trim().split("\n").map(s => JSON.parse(s) as { source: boolean | null });
      assert.ok(rows.length > 0 && rows.every(row => row.source === true));
      assert.equal(trees.length, 1);
      assert.equal(fs.existsSync(path.join(trees[0], "source")), false);
      assert.equal(fs.existsSync(path.join(trees[0], "managed-launcher")), true);
      assert.equal(fs.existsSync(path.join(trees[0], "telepty")), true);
    } finally { clean(root); }
  });
}

for (const scope of ["source", "tree"] as const) {
  test(`${scope} final parent fsync failure retries exactly once and then is idempotent`, {
    skip: process.platform === "win32",
  }, () => {
    const f = setup(), bound = f.bind();
    const target = scope === "source" ? path.join(bound.directory, "source") : bound.directory;
    const parent = path.dirname(target), sentinel = path.join(f.runtime.temporary, `outside-${scope}`);
    fs.writeFileSync(sentinel, "outside", { flag: "wx", mode: 0o600 });
    const parentStat = fs.lstatSync(parent);
    const originalRmdir = fsDefault.rmdirSync, originalSync = fsDefault.fsyncSync;
    const originalUnlink = fsDefault.unlinkSync;
    const injected = new Error(`INJECTED_${scope.toUpperCase()}_PARENT_FSYNC`);
    let removed = false, pendingSyncs = 0, mutations = 0;
    fsDefault.rmdirSync = ((dir: fs.PathLike, options?: fs.RmDirOptions) => {
      const result = originalRmdir(dir, options);
      if (String(dir) === target) removed = true;
      mutations++;
      return result;
    }) as typeof fsDefault.rmdirSync;
    fsDefault.unlinkSync = ((file: fs.PathLike) => { mutations++; return originalUnlink(file); }) as typeof fsDefault.unlinkSync;
    fsDefault.fsyncSync = ((fd: number) => {
      const st = fsDefault.fstatSync(fd);
      if (removed && st.dev === parentStat.dev && st.ino === parentStat.ino) {
        pendingSyncs++;
        if (pendingSyncs === 1) throw injected;
      }
      return originalSync(fd);
    }) as typeof fsDefault.fsyncSync;
    syncBuiltinESMExports();
    try {
      const retire = () => scope === "source" ? bound.retireSource() : bound.retireBeforeHandoff();
      assert.throws(retire, error => { assert.equal(error, injected); return true; });
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "outside");
      const afterFirst = mutations;
      retire();
      assert.equal(pendingSyncs, 2, "retry must sync the pending parent");
      assert.equal(mutations, afterFirst, "retry must not delete another entry");
      retire();
      assert.equal(pendingSyncs, 2);
      assert.equal(mutations, afterFirst);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "outside");
    } finally {
      fsDefault.rmdirSync = originalRmdir;
      fsDefault.unlinkSync = originalUnlink;
      fsDefault.fsyncSync = originalSync;
      syncBuiltinESMExports();
      clean(f.root);
    }
  });
}

for (const scope of ["source", "tree"] as const) {
  test(`${scope} final parent dual-error preserves fsync and retries exactly`, {
    skip: process.platform === "win32",
  }, () => {
    const f = setup(), bound = f.bind();
    const target = scope === "source" ? path.join(bound.directory, "source") : bound.directory;
    const parent = path.dirname(target), sentinel = path.join(f.runtime.temporary, `outside-dual-${scope}`);
    fs.writeFileSync(sentinel, "outside", { flag: "wx", mode: 0o600 });
    const parentStat = fs.lstatSync(parent);
    const originalRmdir = fsDefault.rmdirSync, originalUnlink = fsDefault.unlinkSync;
    const originalSync = fsDefault.fsyncSync, originalClose = fsDefault.closeSync;
    const syncError = new Error(`INJECTED_${scope.toUpperCase()}_FSYNC`);
    const closeError = new Error(`INJECTED_${scope.toUpperCase()}_CLOSE`);
    let removed = false, pendingSyncs = 0, closeFaults = 0, mutations = 0, faultFd: number | undefined;
    fsDefault.rmdirSync = ((dir: fs.PathLike, options?: fs.RmDirOptions) => {
      const result = originalRmdir(dir, options);
      if (String(dir) === target) removed = true;
      mutations++;
      return result;
    }) as typeof fsDefault.rmdirSync;
    fsDefault.unlinkSync = ((file: fs.PathLike) => { mutations++; return originalUnlink(file); }) as typeof fsDefault.unlinkSync;
    fsDefault.fsyncSync = ((fd: number) => {
      const st = fsDefault.fstatSync(fd);
      if (removed && st.dev === parentStat.dev && st.ino === parentStat.ino) {
        pendingSyncs++;
        if (pendingSyncs === 1) { faultFd = fd; throw syncError; }
      }
      return originalSync(fd);
    }) as typeof fsDefault.fsyncSync;
    fsDefault.closeSync = ((fd: number) => {
      const ownedFault = fd === faultFd;
      const result = originalClose(fd);
      if (ownedFault) { faultFd = undefined; closeFaults++; throw closeError; }
      return result;
    }) as typeof fsDefault.closeSync;
    syncBuiltinESMExports();
    try {
      const retire = () => scope === "source" ? bound.retireSource() : bound.retireBeforeHandoff();
      assert.throws(retire, error => { assert.equal(error, syncError); return true; });
      assert.equal(closeFaults, 1, "the owned final-parent descriptor was closed");
      assert.equal(fs.existsSync(target), false);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "outside");
      const afterFirst = mutations;
      retire();
      assert.equal(pendingSyncs, 2, "retry must sync the pending parent");
      assert.equal(mutations, afterFirst, "retry must not delete another entry");
      retire();
      assert.equal(pendingSyncs, 2);
      assert.equal(closeFaults, 1);
      assert.equal(mutations, afterFirst);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "outside");
    } finally {
      fsDefault.rmdirSync = originalRmdir;
      fsDefault.unlinkSync = originalUnlink;
      fsDefault.fsyncSync = originalSync;
      fsDefault.closeSync = originalClose;
      syncBuiltinESMExports();
      clean(f.root);
    }
  });
}
