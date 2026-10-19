import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const dependencies = path.resolve(require.resolve("cross-spawn/package.json"), "../..");
const binFiles = ["model-evidence.mjs", "model-resolve.mjs", "model-router.mjs", "boot-prepare.mjs",
  "lib/executable-version.mjs", "lib/environment-runtime.mjs", "lib/win-private-storage.mjs", "init/cli.mjs"];
const args = ["--cli", "claude", "--sid", "loader-worker", "--task", "1233", "--role", "coder"];

// Direct preopened recorder. Guards precede product imports, without newer
// registerHooks requirements or test-only dependency paths in product.
const guardSource = `
import fs from 'node:fs'; import fsp from 'node:fs/promises'; import cp from 'node:child_process';
import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const fd=fs.openSync(process.env.LOADER_EVENTS,'wx',0o600), write=fs.writeSync.bind(fs), close=fs.closeSync.bind(fs);
let bytes=0;
const event=(kind,value)=>{const b=Buffer.from(JSON.stringify({kind,value})+'\\n');if((bytes+=b.length)>1048576)process.exit(97);
 let at=0;while(at<b.length){const n=write(fd,b,at,b.length-at);if(n<=0)process.exit(97);at+=n;}};
const deny=(kind,value)=>{event(kind,value);throw Error('LOADER_EFFECT_TRIPWIRE');};
const ambient=process.env.LOADER_FORBIDDEN_ROOT;
for(const name of ['readFileSync','statSync','lstatSync','existsSync','realpathSync','accessSync']){
 const original=fs[name].bind(fs), native=fs[name].native; const checked=(file,...rest)=>{
  if(ambient&&typeof file==='string'&&(file===ambient||file.startsWith(ambient+'/')))deny('ambient-read',file);
  if(typeof file==='string'&&/\\.credentials\\.json$|\\/auth\\.json$|\\/\\.claude\\.json$/.test(file))deny('auth-read',file);
  return original(file,...rest);
 };fs[name]=checked;
 if(native)fs[name].native=(file,...rest)=>{
  if(ambient&&typeof file==='string'&&(file===ambient||file.startsWith(ambient+'/')))deny('ambient-read',file);
  return native(file,...rest);
 };
}
const open=fs.openSync.bind(fs);
fs.openSync=(file,flags,...rest)=>{
 if(typeof flags==='string'?/[wa+]/.test(flags):!!(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC)))deny('write',file);
 return open(file,flags,...rest);
};
for(const name of ['writeFile','appendFile','mkdir','mkdtemp','rename','unlink','rm','rmdir','chmod','copyFile','symlink','link','truncate']){
 if(fs[name])fs[name]=()=>deny('write',name);if(fs[name+'Sync'])fs[name+'Sync']=()=>deny('write',name);
 if(fsp[name])fsp[name]=()=>deny('write',name);
}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>deny('child',name);
for(const [m,names] of [[net,['connect','createConnection','createServer']],[tls,['connect','createServer']],
 [http,['request','get','createServer']],[https,['request','get','createServer']]])for(const name of names)m[name]=()=>deny('network',name);
net.Socket.prototype.connect=()=>deny('network','Socket.connect');globalThis.fetch=()=>deny('network','fetch');
syncBuiltinESMExports();process.on('exit',code=>{event('exit',code);close(fd);});
`;

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s1-runtime-")));
  const home = path.join(root, "home"), marker = path.join(root, "provider-called"); fs.mkdirSync(home, { mode: 0o700 });
  const guard = path.join(root, "guard.mjs"); fs.writeFileSync(guard, guardSource);
  const provider = path.join(root, "providers/fixture/bin/claude"); fs.mkdirSync(path.dirname(provider), { recursive: true });
  fs.writeFileSync(provider, "#!" + process.execPath + "\nrequire('node:fs').writeFileSync(" + JSON.stringify(marker) + ",'called');process.exit(99);\n", { mode: 0o700 });
  const stat = fs.statSync(provider);
  const declaration = JSON.stringify({ version: "100.0.0", dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
  const env: NodeJS.ProcessEnv = { HOME: home, AIGENTRY_HOME: path.join(home, ".aigentry"), AIGENTRY_TARGET_CWD: root,
    PATH: "", AIGENTRY_MODEL_METADATA: "off", AIGENTRY_CLAUDE_MODEL: "claude-opus-5-5", AIGENTRY_CLAUDE_EFFORT: "high",
    AIGENTRY_CLAUDE_EXECUTABLE: provider, AIGENTRY_CLAUDE_EXECUTABLE_VERSION: declaration };
  const copy = (target: string, complete: boolean, dependency = true) => {
    for (const name of binFiles) {
      const dst = path.join(target, "bin", name); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(repo, "bin", name), dst);
    }
    fs.mkdirSync(path.join(target, "docs/model-profiles"), { recursive: true });
    for (const name of ["model-catalog.json", "model-routing-profile.md"]) fs.copyFileSync(path.join(repo, "docs/model-profiles", name), path.join(target, "docs/model-profiles", name));
    if (complete) {
      fs.copyFileSync(path.join(repo, "package.json"), path.join(target, "package.json"));
      fs.cpSync(path.join(repo, "dist/src/environment"), path.join(target, "dist/src/environment"), { recursive: true });
      // Dependencies only at the modeled installed package. No copied-workspace link.
      if (dependency) fs.symlinkSync(dependencies, path.join(target, "node_modules"), "dir");
    }
    return target;
  };
  const register = (pkg: string, label: string) => {
    const dir = path.join(root, label); fs.mkdirSync(dir); fs.symlinkSync(path.join(pkg, "bin/init/cli.mjs"), path.join(dir, "aigentry-orchestrator")); return dir;
  };
  let sequence = 0;
  const run = (argv: string[], ambient: NodeJS.ProcessEnv = {}) => {
    const events = path.join(root, "events-" + sequence++ + ".jsonl");
    const r = spawnSync(process.execPath, ["--import", guard, ...argv], { cwd: root, env: { ...env, ...ambient, LOADER_EVENTS: events }, encoding: "utf8", timeout: 15000 });
    const observed = fs.readFileSync(events, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string; value: unknown });
    assert.equal(r.signal, null); assert.deepEqual(observed, [{ kind: "exit", value: r.status }], JSON.stringify(observed));
    assert.equal(fs.existsSync(marker), false, "no provider/--version/--help execution");
    assert.equal(fs.existsSync(env.AIGENTRY_HOME!), false, "no config or worker staging");
    assert.equal(fs.existsSync(path.join(home, ".claude")), false, "no auth staging");
    return r;
  };
  const managed = (layout: string, supplied: NodeJS.ProcessEnv, ambient: NodeJS.ProcessEnv = {}) => {
    const script = "const m=await import(process.argv[1]);const e=JSON.parse(process.argv[2]);const c=await m.centralEnvironment(e);const r=await m.resolveCommand(JSON.parse(process.argv[3]),e,{transport:()=>{throw Error('transport tripwire')}});process.stdout.write(JSON.stringify({runtimeRoot:c.runtimeRoot,result:JSON.parse(r.out)})+'\\n');process.exit(r.code);";
    return run(["--input-type=module", "-e", script, pathToFileURL(path.join(layout, "bin/model-evidence.mjs")).href, JSON.stringify(supplied), JSON.stringify(args)], ambient);
  };
  return { root, env, provider, declaration, copy, register, run, managed, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function refusal(result: ReturnType<ReturnType<typeof fixture>["run"]>, structured: boolean) {
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|\n\s+at /);
  if (structured) { const out = JSON.parse(result.stdout); assert.equal(out.refusal.code, "ENV_CONFIGURATION_REFUSED"); assert.equal(Object.hasOwn(out, "decision"), false); }
  else { assert.match(result.stderr, /ENV_CONFIGURATION_REFUSED/); assert.equal(result.stdout, ""); }
}
function refusalCallers(f: ReturnType<typeof fixture>, layout: string, supplied: NodeJS.ProcessEnv) {
  const script = "const m=await import(process.argv[1]);const r=await m.resolveCommand(JSON.parse(process.argv[2]),process.env);process.stdout.write(r.out);process.exit(r.code);";
  refusal(f.run(["--input-type=module", "-e", script, pathToFileURL(path.join(layout, "bin/model-evidence.mjs")).href, JSON.stringify(args)], supplied), true);
  refusal(f.run([path.join(layout, "bin/model-router.mjs"), "--resolve", ...args], supplied), true);
  refusal(f.run([path.join(layout, "bin/model-router.mjs"), "--role", "coder", "--confined", "1"], supplied), false);
  refusal(f.run([path.join(layout, "bin/boot-prepare.mjs"), "--role", "coder", "--cwd", f.root, "--sid", "loader-worker", "--cli", "claude"], supplied), false);
}

test("pure evidence exports import and return synchronously with no runtime or ambient PATH", () => {
  const f = fixture();
  try {
    const copied = f.copy(path.join(f.root, "copied"), false);
    const script = "const m=await import(process.argv[1]);const raw=process.argv[2];const rows=m.parseAnthropicModels('## Models\\n| Claude API ID | \\x60claude-opus-5-5\\x60 |\\n| Default effort | high |\\n');const collected=m.collectExecutables('claude',{declaredPath:process.env.AIGENTRY_CLAUDE_EXECUTABLE,declaredVersion:raw});process.stdout.write(JSON.stringify({rows,isPromise:rows instanceof Promise,version:collected.executables[0].version,source:collected.executables[0].versionSource,parserPromise:m.parseDeclaredVersion(raw) instanceof Promise}));";
    const r = f.run(["--input-type=module", "-e", script, pathToFileURL(path.join(copied, "bin/model-evidence.mjs")).href, f.declaration]);
    assert.equal(r.status, 0, r.stderr); const out = JSON.parse(r.stdout);
    assert.equal(out.isPromise, false); assert.equal(out.parserPromise, false); assert.ok(Array.isArray(out.rows));
    assert.ok(out.rows.some((row: { model: string }) => row.model === "claude-opus-5-5"));
    assert.deepEqual([out.version, out.source], ["100.0.0", "operator-declared"]);
  } finally { f.cleanup(); }
});

test("copied managed evidence uses supplied package despite empty or forbidden ambient package", () => {
  const f = fixture();
  try {
    const copied = f.copy(path.join(f.root, "copied"), false), a = f.copy(path.join(f.root, "package-a"), true), b = f.copy(path.join(f.root, "package-b"), true);
    const registeredA = f.register(a, "registered-a"), registeredB = f.register(b, "registered-b");
    for (const ambient of [{ PATH: "" }, { PATH: registeredA, LOADER_FORBIDDEN_ROOT: a }]) {
      const r = f.managed(copied, { ...f.env, PATH: registeredB }, ambient);
      assert.equal(r.status, 0, r.stdout + r.stderr); const out = JSON.parse(r.stdout);
      assert.equal(out.runtimeRoot, b); assert.equal(out.result.decision.model, "claude-opus-5-5");
      assert.equal(out.result.decision.effort.token, "high");
      assert.deepEqual([out.result.decision.executable.version, out.result.decision.executable.versionSource], ["100.0.0", "operator-declared"]);
    }
    const colocated = f.managed(a, { ...f.env, PATH: registeredB }, { LOADER_FORBIDDEN_ROOT: b });
    assert.equal(colocated.status, 0, colocated.stderr); assert.equal(JSON.parse(colocated.stdout).runtimeRoot, a, "colocated package retains precedence");
    const supplied = { ...f.env, PATH: registeredB, LOADER_FORBIDDEN_ROOT: b };
    const table = f.run([path.join(a, "bin/model-router.mjs"), "--role", "coder", "--confined", "1"], supplied);
    const managed = f.run([path.join(a, "bin/model-router.mjs"), "--resolve", ...args], supplied);
    assert.equal(table.status, 0, table.stderr); assert.equal(JSON.parse(table.stdout).decided_by, "table");
    assert.equal(managed.status, 0, managed.stdout + managed.stderr); assert.equal(JSON.parse(managed.stdout).decision.model, "claude-opus-5-5");
  } finally { f.cleanup(); }
});

test("missing/partial runtime reaches fixed managed, actual router and boot refusals without loader stacks", () => {
  for (const missing of ["none", "dist/src/environment/executable-version.js", "dist/src/environment/bootstrap.js", "dist/src/environment/invocation.js"]) {
    const f = fixture();
    try {
      const layout = f.copy(path.join(f.root, "layout"), missing !== "none");
      let supplied = f.env;
      if (missing !== "none") { fs.unlinkSync(path.join(layout, missing)); supplied = { ...f.env, PATH: f.register(layout, "registered") }; }
      refusalCallers(f, layout, supplied);
    } finally { f.cleanup(); }
  }
});

test("partial selected package A refuses at every caller without reading or loading complete registered B", () => {
  for (const selection of ["colocated", "registered"]) {
    for (const missing of ["dist/src/environment/bootstrap.js", "dist/src/environment/executable-version.js", "dist/src/environment/invocation.js"]) {
      const f = fixture();
      try {
        const a = f.copy(path.join(f.root, "package-a"), true), b = f.copy(path.join(f.root, "package-b"), true);
        fs.unlinkSync(path.join(a, missing));
        const bootstrapB = path.join(b, "dist/src/environment/bootstrap.js");
        // Import sentinel also detects ESM loads that do not use patched fs.
        fs.writeFileSync(bootstrapB, "process.stdout.write('REGISTERED_B_RUNTIME_LOADED\\n');\n" + fs.readFileSync(bootstrapB, "utf8"));
        const registeredB = f.register(b, "registered-b");
        const layout = selection === "colocated" ? a : f.copy(path.join(f.root, "copied"), false);
        const supplied = { ...f.env, PATH: selection === "colocated" ? registeredB : f.register(a, "registered-a") + path.delimiter + registeredB,
          LOADER_FORBIDDEN_ROOT: b };
        refusalCallers(f, layout, supplied);
      } finally { f.cleanup(); }
    }
  }
});

test("absent, foreign or malformed colocated metadata with a bootstrap does not own registered runtime lookup", () => {
  for (const metadata of [undefined, JSON.stringify({ name: "unrelated-package", bin: { "aigentry-orchestrator": "bin/init/cli.mjs" } }),
    JSON.stringify({ name: "@dmsdc-ai/aigentry-orchestrator", bin: { "aigentry-orchestrator": "foreign.mjs" } }), "{malformed", "null"]) {
    const f = fixture();
    try {
      const local = f.copy(path.join(f.root, "unrelated"), false), b = f.copy(path.join(f.root, "package-b"), true);
      if (metadata !== undefined) fs.writeFileSync(path.join(local, "package.json"), metadata);
      const bootstrap = path.join(local, "dist/src/environment/bootstrap.js"); fs.mkdirSync(path.dirname(bootstrap), { recursive: true });
      fs.writeFileSync(bootstrap, "throw Error('UNRELATED_BOOTSTRAP_LOADED');\n");
      const r = f.managed(local, { ...f.env, PATH: f.register(b, "registered-b") });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const out = JSON.parse(r.stdout); assert.equal(out.runtimeRoot, b); assert.equal(out.result.decision.model, "claude-opus-5-5");
      assert.equal(fs.existsSync(path.join(local, "node_modules")), false);
    } finally { f.cleanup(); }
  }
});

test("actual copied router owns installed dependency; missing dependency refuses in both router modes", () => {
  for (const dependency of [true, false]) {
    const f = fixture();
    try {
      const copied = f.copy(path.join(f.root, "copied"), false), pkg = f.copy(path.join(f.root, "package"), true, dependency);
      const env = { ...f.env, PATH: f.register(pkg, "registered") };
      assert.equal(fs.existsSync(path.join(copied, "node_modules")), false);
      const table = f.run([path.join(copied, "bin/model-router.mjs"), "--role", "coder", "--confined", "1"], env);
      const managed = f.run([path.join(copied, "bin/model-router.mjs"), "--resolve", ...args], env);
      if (dependency) {
        assert.equal(table.status, 0, table.stderr); assert.equal(JSON.parse(table.stdout).decided_by, "table");
        assert.equal(managed.status, 0, managed.stdout + managed.stderr); assert.equal(JSON.parse(managed.stdout).decision.model, "claude-opus-5-5");
      } else { refusal(table, false); refusal(managed, true); }
    } finally { f.cleanup(); }
  }
});
