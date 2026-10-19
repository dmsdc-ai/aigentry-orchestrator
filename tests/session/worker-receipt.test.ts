// The compiled runner is real. Only SRT's wrapper and the native preflight outcome are fake;
// the worker command runs through the runner's actual quote function and owned Bash process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const built = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
process.on("exit", () => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const write = (file: string, data: string, mode = 0o600): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode });
};
const read = (file: string): string => fs.readFileSync(file, "utf8");
const hash = (data: string): string => createHash("sha256").update(data).digest("hex");

interface World { root: string; runner: string; manifest: string; receipt: string; sentinel: string; record: string; hash: string }
function world(long = false): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worker-receipt-")));
  roots.push(root);
  fs.cpSync(path.join(built, "src"), path.join(root, "dist", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin", "lib"), { recursive: true, mode: 0o700 });
  for (const name of ["executable-version.mjs", "win-private-storage.mjs"]) {
    const dependency = path.join("bin", "lib", name);
    fs.copyFileSync(path.resolve(built, "..", dependency), path.join(root, dependency));
    assert.ok(fs.statSync(path.resolve(root, "dist", "src", "environment", "../../../", dependency)).isFile());
  }
  write(path.join(root, "package.json"), '{"type":"module"}\n');
  const srt = path.join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
  write(path.join(srt, "package.json"), '{"name":"@anthropic-ai/sandbox-runtime","type":"module","main":"index.js"}\n');
  write(path.join(srt, "index.js"), `export const SandboxManager = {
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [] }),
    initialize: async () => {}, reset: async () => {},
    wrapWithSandboxArgv: async command => ({ argv: ["/bin/bash", "-c", command], env: {} }),
  };\n`);
  const attempt = randomUUID(), parent = path.join(root, "stage", "sandbox", attempt);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const probeFile = path.join(parent, "outside-canary.txt"), probeDirectory = path.join(parent, "outside-directory-canary");
  write(probeFile, "canary\n");
  write(path.join(probeDirectory, "synthetic.txt"), "canary\n");
  const receipt = path.join(parent, "receipt.json"), manifest = path.join(parent, "manifest.json");
  const record = path.join(root, "worker.json"), sentinel = path.join(root, "sentinel");
  write(sentinel, "untouched\n");
  const worker = path.join(root, "worker.cjs");
  write(worker, `const fs=require('node:fs');fs.writeFileSync(process.env.FAKE_RECORD,
    JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
    ${long ? "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);" : "process.exit(7);"}\n`);
  const m = { version: 1, task: "1233", sid: "receipt-fixture", attempt, cli: "codex", cwd: root,
    command: [process.execPath, worker, "a'b", "$(touch forbidden)", "line\nfeed"],
    env: { HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin", FAKE_RECORD: record },
    config: { filesystem: { allowRead: [] } }, probeFile, probeDirectory, receipt };
  const data = JSON.stringify(m) + "\n";
  write(manifest, data);
  return { root, runner: path.join(root, "dist", "src", "session", "worker-sandbox-runner.js"),
    manifest, receipt, sentinel, record, hash: hash(data) };
}

function run(w: World, mode = "normal"): { status: number | null; stderr: string; signal: NodeJS.Signals | null } {
  const preload = path.join(w.root, "preload.mjs");
  write(preload, `import cp from 'node:child_process';
    import fs from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(w.root)}, receipt=${JSON.stringify(w.receipt)}, sentinel=${JSON.stringify(w.sentinel)};
    const mode=${JSON.stringify(mode)}, realSpawn=cp.spawn;let calls=0;
    cp.spawn=(command,args,options)=>{
      if (++calls===1) return realSpawn(process.execPath,['-e','process.exit(0)'],options);
      const child=mode==='spawn-error' ? realSpawn(root+'/missing-executable',[],options) : realSpawn(command,args,options);
      if (child.pid) fs.writeFileSync(root+'/child-pid',String(child.pid));
      const kill=child.kill.bind(child);
      child.kill=(signal)=>{fs.appendFileSync(root+'/signals',String(signal)+'\\n');return kill(signal);};
      if (mode==='replace') child.once('exit',()=>{
        fs.renameSync(receipt,receipt+'.old');fs.symlinkSync(sentinel,receipt);
      });
      return child;
    };
    if (mode==='write-failure') {
      const truncate=fs.ftruncateSync;
      fs.ftruncateSync=(fd,length)=>{
        if (fs.existsSync(receipt) && fs.fstatSync(fd).ino===fs.lstatSync(receipt).ino)
          throw new Error('INJECTED_RECEIPT_WRITE_FAILURE');
        return truncate(fd,length);
      };
    }
    syncBuiltinESMExports();\n`);
  const r = spawnSync(process.execPath, ["--import", preload, w.runner, w.manifest, w.hash], {
    encoding: "utf8", timeout: 12000, env: { HOME: w.root, PATH: "/usr/bin:/bin" },
  });
  return { status: r.status, stderr: r.stderr, signal: r.signal };
}

test("private 0600 receipt preserves running/exited schema, child code and quoted arguments", () => {
  if (process.platform === "win32") return;
  const w = world();
  write(w.receipt, "{}", 0o600);
  const r = run(w);
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(JSON.parse(read(w.receipt)), { state: "exited", attempt: path.basename(path.dirname(w.receipt)), code: 7 });
  assert.equal(fs.statSync(w.receipt).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(read(w.record)).args, ["a'b", "$(touch forbidden)", "line\nfeed"]);
  assert.equal(fs.existsSync(path.join(w.root, "forbidden")), false);
});

test("missing receipt is exclusively created private; unsafe existing objects refuse before worker spawn", () => {
  if (process.platform === "win32") return;
  const fresh = world();
  assert.equal(run(fresh).status, 7);
  assert.equal(fs.statSync(fresh.receipt).mode & 0o777, 0o600);
  for (const kind of ["symlink", "permissive", "directory"] as const) {
    const w = world();
    if (kind === "symlink") fs.symlinkSync(w.sentinel, w.receipt);
    else if (kind === "directory") fs.mkdirSync(w.receipt);
    else {
      write(w.receipt, "{}", 0o644);
      fs.chmodSync(w.receipt, 0o644);
      assert.equal(fs.statSync(w.receipt).mode & 0o777, 0o644);
    }
    const r = run(w);
    assert.equal(r.status, 78, `${kind}: ${r.stderr}`);
    assert.equal(fs.existsSync(w.record), false, kind);
    assert.equal(read(w.sentinel), "untouched\n", kind);
    if (kind === "permissive") assert.equal(fs.statSync(w.receipt).mode & 0o777, 0o644);
  }
});

test("a replacement between running and exited writes is refused without following its symlink", () => {
  if (process.platform === "win32") return;
  const w = world();
  const r = run(w, "replace");
  assert.equal(r.status, 78, r.stderr);
  assert.equal(read(w.sentinel), "untouched\n");
  assert.equal(JSON.parse(read(w.receipt + ".old")).state, "running");
  assert.equal(JSON.parse(read(w.record)).args[0], "a'b");
});

test("post-spawn receipt write failure terminates and reaps only the owned long-lived child", () => {
  if (process.platform === "win32") return;
  const w = world(true);
  write(w.receipt, "{}", 0o600);
  const r = run(w, "write-failure");
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /INJECTED_RECEIPT_WRITE_FAILURE/);
  assert.equal(r.signal, null);
  assert.match(read(path.join(w.root, "signals")), /SIGTERM/);
  const pid = Number(read(path.join(w.root, "child-pid")));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("spawn error is handled without signalling an unrelated pid", () => {
  if (process.platform === "win32") return;
  const w = world();
  const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    write(w.receipt, JSON.stringify({ childPid: foreign.pid }), 0o600);
    const r = run(w, "spawn-error");
    assert.equal(r.status, 78, r.stderr);
    assert.match(r.stderr, /ENOENT/);
    assert.equal(fs.existsSync(path.join(w.root, "signals")), false);
    assert.equal(fs.existsSync(w.record), false);
    assert.doesNotThrow(() => process.kill(foreign.pid!, 0));
  } finally { foreign.kill("SIGTERM"); }
});
