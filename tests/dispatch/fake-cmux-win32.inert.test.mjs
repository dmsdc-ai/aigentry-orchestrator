// #1167 inert regression for tests/dispatch/fake-cmux-win32.ts (the win32 native fake-cmux helper).
//
// The helper text next to this file is type-erased with typescript `transpileModule` and evaluated in a
// node:vm context whose only authority is a strict require map of in-memory fakes: node:fs, node:os,
// node:child_process and process are fully inert; node:crypto (createHash) is real; node:path exposes only
// `join` (=== win32.join) and `win32`. Any other module, export or process property is recorded as a
// violation and throws. No compiler, native binary, child process or real candidate file IO happens and
// the helper logic is not reimplemented, so this runs on every OS. Native behaviour (real csc flags, PE
// output, NTFS semantics, exit-hook ordering) stays with the Windows CI job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
// `typescript` is already the compiler for this repo build; used here as a library only (type erasure).
import ts from "typescript";

// Runs from source (scripts/run-tests.mjs sourceTestFiles); the helper is its sibling, never searched for.
const SOURCE_FILE = join(dirname(fileURLToPath(import.meta.url)), "fake-cmux-win32.ts");
const TEXT = readFileSync(SOURCE_FILE, "utf8");
const EMIT = ts.transpileModule(TEXT, { fileName: "fake-cmux-win32.ts", reportDiagnostics: true,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, strict: true } });
const JS = EMIT.outputText;
const REQUIRES = [...JS.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).sort();

const PIN = "7d14cad8a67e10064e5d81dd6c8ae8a878ac09a64780e5af80d9866e3f69d2c4";
const COPYFILE_EXCL = fsConstants.COPYFILE_EXCL;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plain = (value) => JSON.parse(JSON.stringify(value));

const SYS = "C:\\Windows";
const COMSPEC = "C:\\Windows\\system32\\cmd.exe";
const FW = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319";
const CSC = `${FW}\\csc.exe`;
const CORLIB = `${FW}\\mscorlib.dll`;
const TMP = "C:\\Users\\tester\\AppData\\Local\\Temp";
const PREFIX = `${TMP}\\fake cmux 1167 \u00fc-`;
const SCRATCH = `${PREFIX}Q1w2E3`;
const SRC = `${SCRATCH}\\cmux.cs`;
const EXE = `${SCRATCH}\\cmux.exe`;
const BIN = "D:\\fixture\\bin";
const TARGET = `${BIN}\\cmux.exe`;
const CSC_BYTES = Buffer.from("MZ fake csc.exe bytes (inert)");
const CORLIB_BYTES = Buffer.from("MZ fake mscorlib.dll bytes (inert)");
const EXE_BYTES = Buffer.from("MZ\u0090 fake compiled cmux.exe (inert)", "latin1");
const FOREIGN = Buffer.from("MZ foreign cmux.exe that this attempt never created");
const CLEANUP_FAILED_SCRATCH = "fake-cmux: scratch cleanup failed for <scratch>\n";
const MISMATCH = "fake-cmux: installed cmux.exe does not match the compiled sha256";

function errno(code, syscall) {
  const error = new Error(`${code}: inert fake ${syscall}`);
  error.code = code;
  error.syscall = syscall;
  return error;
}

function defaultEnv() {
  return { SystemRoot: SYS, windir: SYS, ComSpec: COMSPEC, PATH: "C:\\ambient\\evil-path", LIB: "C:\\ambient\\evil-lib",
    GITHUB_TOKEN: "ghp_ambient_secret_must_not_leak", ANTHROPIC_API_KEY: "sk-ant-ambient-secret-must-not-leak" };
}

const res = (fields) => ({ pid: 0, stdout: "", stderr: "", status: 0, signal: null, ...fields });
function okSpawn({ args, put }) {
  put(args.find((arg) => arg.startsWith("/out:")).slice(5), "file", EXE_BYTES);
  return res({});
}

function makeWorld(options = {}) {
  const faults = options.faults || {};
  const calls = [], violations = [], requires = [], spawns = [], listeners = [], stderr = [];
  const entries = new Map(), fds = new Map();
  let nextFd = 40, nextIno = 1000;
  const log = (op, ...args) => calls.push({ op, args });
  // Every (re)creation gets a fresh inode so dev/ino identity checks can tell an owned copy from a replacement.
  const put = (p, type, data = Buffer.alloc(0)) => entries.set(p, { type, data: Buffer.from(data), ino: nextIno++ });
  if (options.csc !== null) put(CSC, ...(options.csc || ["file", CSC_BYTES]));
  if (options.corlib !== null) put(CORLIB, ...(options.corlib || ["file", CORLIB_BYTES]));
  const hit = (name, ...args) => { const r = faults[name] && faults[name](...args); if (r instanceof Error) throw r; return r; };
  const statOf = (e) => ({ isFile: () => e.type === "file", isSymbolicLink: () => e.type === "symlink", isDirectory: () => e.type === "dir",
    size: e.data.length, dev: 7, ino: e.ino });
  const fs = {
    constants: { COPYFILE_EXCL },
    lstatSync(p, ...rest) { log("lstat", p, ...rest); hit("lstat", p); const e = entries.get(p); if (!e) throw errno("ENOENT", "lstat"); return statOf(e); },
    readFileSync(p, ...rest) {
      log("readFile", p, ...rest);
      const r = hit("read", p, put);
      if (r) return Buffer.from(r);
      const e = entries.get(p);
      if (!e) throw errno("ENOENT", "open");
      if (e.type !== "file") throw errno("EISDIR", "read");
      return Buffer.from(e.data);
    },
    mkdtempSync(prefix, ...rest) { log("mkdtemp", prefix, ...rest); const p = `${prefix}Q1w2E3`; put(p, "dir"); hit("afterMkdtemp", p, put); return p; },
    openSync(p, flags, mode) {
      log("open", p, flags, mode);
      if (entries.has(p)) throw errno("EEXIST", "open");
      put(p, "file");
      hit("open", p);
      const fd = nextFd++;
      fds.set(fd, { path: p, open: true });
      return fd;
    },
    writeFileSync(target, data, opts) {
      log("writeFile", target, typeof data === "string" ? `<string ${Buffer.byteLength(data)} bytes>` : data, plain(opts));
      let p = target;
      if (typeof target === "number") { const f = fds.get(target); if (!f || !f.open) throw errno("EBADF", "write"); p = f.path; }
      else { if (opts && opts.flag === "wx" && entries.has(p)) throw errno("EEXIST", "open"); put(p, "file"); }
      const bytes = Buffer.from(data, typeof opts === "string" ? opts : (opts && opts.encoding) || "utf8");
      const r = faults.write && faults.write(p, bytes);
      if (r) { entries.get(p).data = r.data; if (r.error) throw r.error; return; }
      entries.get(p).data = bytes;
    },
    closeSync(fd, ...rest) { log("close", fd, ...rest); const f = fds.get(fd); if (!f || !f.open) throw errno("EBADF", "close"); f.open = false; hit("close", fd); },
    unlinkSync(p, ...rest) {
      log("unlink", p, ...rest);
      hit("unlink", p);
      const e = entries.get(p);
      if (!e) throw errno("ENOENT", "unlink");
      if (e.type === "dir") throw errno("EPERM", "unlink");
      entries.delete(p);
    },
    rmdirSync(p, ...rest) {
      log("rmdir", p, ...rest);
      hit("rmdir", p);
      const e = entries.get(p);
      if (!e) throw errno("ENOENT", "rmdir");
      if (e.type !== "dir") throw errno("ENOTDIR", "rmdir");
      if ([...entries.keys()].some((k) => k.startsWith(`${p}\\`))) throw errno("ENOTEMPTY", "rmdir");
      entries.delete(p);
    },
    copyFileSync(src, dst, mode) {
      log("copyFile", src, dst, mode);
      hit("copy", src, dst);
      const s = entries.get(src);
      if (!s) throw errno("ENOENT", "copyfile");
      if ((mode & COPYFILE_EXCL) && entries.has(dst)) throw errno("EEXIST", "copyfile");
      put(dst, "file", faults.copyData ? faults.copyData(s.data) : s.data);
      hit("afterCopy", dst, put);
    },
  };
  const os = { tmpdir(...rest) { log("tmpdir", ...rest); return TMP; } };
  const childProcess = {
    spawnSync(file, args, opts) {
      log("spawn", file);
      spawns.push({ file, args: [...args], options: plain(opts) });
      return (options.spawn || okSpawn)({ file, args: [...args], options: opts, put, entries });
    },
  };
  const strict = (name, target) => new Proxy(target, {
    get(t, key) {
      if (typeof key === "string" && Object.prototype.hasOwnProperty.call(t, key)) return t[key];
      violations.push(`${name}.${String(key)}`);
      throw new Error(`inert: unexpected authority ${name}.${String(key)}`);
    },
    set(t, key) { violations.push(`set ${name}.${String(key)}`); throw new Error(`inert: unexpected write ${name}.${String(key)}`); },
  });
  const env = options.env || defaultEnv();
  const envSnapshot = JSON.stringify(env);
  const processTarget = {
    platform: options.platform || "win32", env, exitCode: undefined,
    stderr: strict("process.stderr", { write(text) { stderr.push(String(text)); return true; } }),
    once(event, listener) { log("process.once", event); listeners.push({ event, listener }); return proc; },
  };
  const proc = new Proxy(processTarget, {
    get(t, key) {
      if (typeof key === "string" && Object.prototype.hasOwnProperty.call(t, key)) return t[key];
      violations.push(`process.${String(key)}`);
      throw new Error(`inert: unexpected authority process.${String(key)}`);
    },
    set(t, key, value) {
      if (key === "exitCode") { t.exitCode = value; return true; }
      violations.push(`set process.${String(key)}`);
      throw new Error(`inert: unexpected write process.${String(key)}`);
    },
  });
  const modules = {
    "node:fs": strict("node:fs", fs),
    "node:os": strict("node:os", os),
    "node:child_process": strict("node:child_process", childProcess),
    "node:path": strict("node:path", { join: win32.join, win32 }),
    "node:crypto": strict("node:crypto", { createHash }),
  };
  const requireFn = (id) => {
    requires.push(id);
    if (Object.prototype.hasOwnProperty.call(modules, id)) return modules[id];
    violations.push(`require(${id})`);
    throw new Error(`inert: unexpected module ${id}`);
  };
  const exit = () => { for (const { event, listener } of listeners) if (event === "exit") listener(0); };
  return { calls, violations, requires, spawns, listeners, stderr, entries, fds, put, process: processTarget, proc, require: requireFn,
    env, envSnapshot, exit };
}

function load(world) {
  const module = { exports: {} };
  const context = vm.createContext({ Buffer });
  const wrapper = vm.runInContext(`(function (exports, require, module, process) {\n${JS}\n})`, context,
    { filename: "inert-fake-cmux-win32.js" });
  wrapper(module.exports, world.require, module, world.proc);
  return module.exports;
}

function boot(options = {}) {
  const world = makeWorld(options);
  return { world, mod: load(world) };
}

const attempt = (fn) => { try { return { value: fn(), error: undefined }; } catch (error) { return { value: undefined, error }; } };
const scratchLeft = (world) => [...world.entries.keys()].filter((k) => k === SCRATCH || k.startsWith(`${SCRATCH}\\`)).sort();
const openFds = (world) => [...world.fds.values()].filter((f) => f.open).length;
const detailOf = (error) => (error.message.includes("\n") ? error.message.slice(error.message.indexOf("\n") + 1) : "");
const count = (world, op) => world.calls.filter((c) => c.op === op).length;

function invariants(world, unlinkable = [SRC, EXE]) {
  assert.deepEqual(world.violations, [], "no unexpected authority");
  for (const c of world.calls) {
    if (c.op === "rmdir") { assert.equal(c.args.length, 1, "rmdir without options (no recursion)"); assert.equal(c.args[0], SCRATCH); }
    if (c.op === "unlink") assert.ok(unlinkable.includes(c.args[0]), `unlink only known leaves: ${c.args[0]}`);
  }
  assert.equal(JSON.stringify(world.env), world.envSnapshot, "process.env not mutated");
  for (const line of world.stderr) assert.ok(!line.includes(":\\") && !line.includes("Temp") && !line.includes("Users"), `stderr path-free: ${line}`);
}

test("static: clean emit, exact import set, no dynamic-code escape hatches", () => {
  assert.equal((EMIT.diagnostics || []).length, 0, "transpile diagnostics");
  assert.deepEqual(REQUIRES, ["node:child_process", "node:crypto", "node:fs", "node:os", "node:path"], "import set");
  assert.doesNotMatch(TEXT, /\beval\b|\bnew Function\b|\bconstructor\b|globalThis|\bimport\(|process\.binding|\bglobal\b/);
});

for (const platform of ["linux", "darwin"]) {
  test(`non-win32 (${platform}): import performs no fs/os/child/listener call; build and install refuse with one cached error`, () => {
    const { world, mod } = boot({ platform });
    assert.deepEqual(world.calls, []);
    assert.deepEqual([...world.requires].sort(), ["node:child_process", "node:crypto", "node:fs", "node:os", "node:path"]);
    assert.equal(mod.FAKE_CMUX_CS_SHA256, PIN);
    assert.equal(sha256(Buffer.from(mod.FAKE_CMUX_CS, "utf8")), PIN);
    const first = attempt(() => mod.fakeCmuxBuild());
    assert.equal(first.error.message, "fake-cmux: the native fake is win32-only");
    assert.equal(attempt(() => mod.fakeCmuxBuild()).error, first.error);
    assert.equal(attempt(() => mod.installFakeCmux(BIN)).error, first.error);
    assert.deepEqual(world.calls, []);
    assert.equal(world.listeners.length, 0);
    assert.equal(world.process.exitCode, undefined);
    invariants(world);
  });
}

for (const [drop, name] of [["SystemRoot", "SystemRoot"], ["windir", "WINDIR"], ["ComSpec", "ComSpec"]]) {
  test(`env: missing ${name} refused before any fs/os/child call`, () => {
    const env = defaultEnv();
    delete env[drop];
    const { world, mod } = boot({ env });
    assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, `fake-cmux prerequisite: ${name} must be set exactly once rc=-1`);
    assert.deepEqual(world.calls, []);
    invariants(world);
  });
}

test("env: conflicting case-variant duplicates and undefined values refused; identical duplicates accepted", () => {
  for (const env of [{ ...defaultEnv(), SYSTEMROOT: "D:\\Windows" }, { ...defaultEnv(), SystemRoot: undefined }]) {
    const { world, mod } = boot({ env });
    assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: SystemRoot must be set exactly once rc=-1");
    assert.deepEqual(world.calls, []);
    invariants(world);
  }
  const { world, mod } = boot({ env: { ...defaultEnv(), SYSTEMROOT: SYS, WINDIR: SYS } });
  mod.fakeCmuxBuild();
  assert.deepEqual(world.spawns[0].options.env, { SystemRoot: SYS, WINDIR: SYS, ComSpec: COMSPEC });
  invariants(world);
});

const MALFORMED = ["Windows", "C:Windows", "C:/Windows", "C:\\Windows/System32", "C:\\Win:dows", "C:\\Win\"dows", "C:\\Win*", "C:\\Win?",
  "C:\\Win<", "C:\\Win>", "C:\\Win|x", "C:\\Win\tdows", "C:\\Win\u0000", "C:\\Windows\\..\\Windows", "C:\\Windows\\.\\x", "C:\\Windows\\\\x",
  "\\\\server\\share\\Windows", "\\\\?\\C:\\Windows", ""];
test("env: malformed/relative/UNC/non-normalized values refused before any fs/os/child call", () => {
  for (const [key, name] of [["SystemRoot", "SystemRoot"], ["windir", "WINDIR"], ["ComSpec", "ComSpec"]]) {
    for (const bad of MALFORMED) {
      const { world, mod } = boot({ env: { ...defaultEnv(), [key]: bad } });
      const r = attempt(() => mod.fakeCmuxBuild());
      assert.equal(r.error && r.error.message, `fake-cmux prerequisite: ${name} is not an explicit absolute path rc=-1`, JSON.stringify([key, bad]));
      assert.deepEqual(world.calls, []);
      invariants(world);
    }
  }
});

test("env: SystemRoot/WINDIR disagreement refused before fs; case-only difference accepted with SystemRoot-derived paths", () => {
  const bad = boot({ env: { ...defaultEnv(), windir: "D:\\Windows" } });
  assert.equal(attempt(() => bad.mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: SystemRoot and WINDIR disagree rc=-1");
  assert.deepEqual(bad.world.calls, []);
  const ok = boot({ env: { ...defaultEnv(), windir: "c:\\windows" } });
  ok.mod.fakeCmuxBuild();
  assert.deepEqual(ok.world.calls[0], { op: "lstat", args: [CSC] });
  assert.deepEqual(ok.world.spawns[0].options.env, { SystemRoot: SYS, WINDIR: "c:\\windows", ComSpec: COMSPEC });
  invariants(bad.world);
  invariants(ok.world);
});

const CSC_MISSING = "fake-cmux prerequisite: Framework64 v4.0.30319 csc.exe is missing rc=-1";
// Wording may gain "non-empty" once the zero-byte gate (F1) lands; the refusal itself is what is pinned.
const CSC_NOT_FILE = /^fake-cmux prerequisite: csc\.exe is not a (non-empty )?regular file rc=-1$/;
const CORLIB_MISSING = "fake-cmux prerequisite: Framework64 v4.0.30319 mscorlib.dll is missing rc=-1";
const CORLIB_BAD = "fake-cmux prerequisite: mscorlib.dll is not a non-empty regular file rc=-1";
const PREREQ = [
  ["csc.exe absent", { csc: null }, CSC_MISSING, [CSC], []],
  ["csc.exe symlink", { csc: ["symlink", Buffer.from("C:\\elsewhere\\csc.exe")] }, CSC_NOT_FILE, [CSC], []],
  ["csc.exe directory", { csc: ["dir"] }, CSC_NOT_FILE, [CSC], []],
  ["csc.exe lstat EACCES", { faults: { lstat: (p) => (p === CSC ? errno("EACCES", "lstat") : undefined) } }, CSC_MISSING, [CSC], []],
  ["mscorlib.dll absent", { corlib: null }, CORLIB_MISSING, [CSC, CORLIB], [CSC]],
  ["mscorlib.dll symlink", { corlib: ["symlink", Buffer.from("C:\\elsewhere\\mscorlib.dll")] }, CORLIB_BAD, [CSC, CORLIB], [CSC]],
  ["mscorlib.dll directory", { corlib: ["dir"] }, CORLIB_BAD, [CSC, CORLIB], [CSC]],
  ["mscorlib.dll empty", { corlib: ["file", Buffer.alloc(0)] }, CORLIB_BAD, [CSC, CORLIB], [CSC]],
];
for (const [label, options, message, lstats, reads] of PREREQ) {
  test(`prerequisite: ${label} refused at the known absolute path before scratch/listener/spawn`, () => {
    const { world, mod } = boot(options);
    const error = attempt(() => mod.fakeCmuxBuild()).error;
    if (message instanceof RegExp) assert.match(error.message, message);
    else assert.equal(error.message, message);
    assert.deepEqual(world.calls.filter((c) => c.op === "lstat").map((c) => c.args), lstats.map((p) => [p]));
    assert.deepEqual(world.calls.filter((c) => c.op === "readFile").map((c) => c.args), reads.map((p) => [p]));
    for (const op of ["tmpdir", "mkdtemp", "process.once", "open", "writeFile", "spawn", "unlink", "rmdir"]) assert.equal(count(world, op), 0, op);
    assert.equal(world.listeners.length, 0);
    invariants(world);
  });
}

test("desired F1: zero-byte csc.exe refused before hash, scratch, listener and spawn; refusal cached", () => {
  const { world, mod } = boot({ csc: ["file", Buffer.alloc(0)] });
  const r = attempt(() => mod.fakeCmuxBuild());
  assert.ok(r.error, "zero-byte csc.exe must be refused");
  assert.match(r.error.message, /^fake-cmux prerequisite: .*csc\.exe.* rc=-1$/);
  assert.deepEqual(world.calls.filter((c) => c.op === "lstat").map((c) => c.args), [[CSC]]);
  for (const op of ["readFile", "tmpdir", "mkdtemp", "process.once", "open", "writeFile", "spawn", "unlink", "rmdir"]) assert.equal(count(world, op), 0, op);
  assert.equal(world.listeners.length, 0);
  assert.equal(attempt(() => mod.fakeCmuxBuild()).error, r.error);
  invariants(world);
});

test("success: exact op order, csc argv, 3-key env, shell:false, timeout/maxBuffer, no ambient leak, hash correlation, exit cleanup", () => {
  const { world, mod } = boot();
  const build = plain(mod.fakeCmuxBuild());
  assert.deepEqual(world.calls.map((c) => [c.op, ...c.args]), [
    ["lstat", CSC], ["readFile", CSC], ["lstat", CORLIB], ["readFile", CORLIB], ["tmpdir"], ["mkdtemp", PREFIX], ["process.once", "exit"],
    ["open", SRC, "wx", 0o600], ["writeFile", 40, `<string ${Buffer.byteLength(mod.FAKE_CMUX_CS)} bytes>`, "utf8"], ["close", 40],
    ["readFile", SRC], ["spawn", CSC], ["lstat", EXE], ["readFile", EXE],
  ]);
  assert.equal(world.spawns.length, 1);
  const [spawn] = world.spawns;
  assert.equal(spawn.file, CSC);
  assert.deepEqual(spawn.args, ["/nologo", "/noconfig", "/nostdlib+", `/reference:${CORLIB}`, "/target:exe", "/optimize+", "/codepage:65001",
    "/utf8output", `/out:${EXE}`, SRC]);
  assert.deepEqual(Object.keys(spawn.options).sort(), ["cwd", "encoding", "env", "maxBuffer", "shell", "stdio", "timeout", "windowsHide"]);
  assert.equal(spawn.options.cwd, SCRATCH);
  assert.deepEqual(Object.keys(spawn.options.env), ["SystemRoot", "WINDIR", "ComSpec"]);
  assert.deepEqual(spawn.options.env, { SystemRoot: SYS, WINDIR: SYS, ComSpec: COMSPEC });
  assert.equal(spawn.options.shell, false);
  assert.equal(spawn.options.windowsHide, true);
  assert.deepEqual(spawn.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(spawn.options.encoding, "utf8");
  assert.equal(spawn.options.timeout, 60000);
  assert.equal(spawn.options.maxBuffer, 1024 * 1024);
  const flat = JSON.stringify(spawn);
  for (const ambient of ["evil", "ghp_", "sk-ant", "PATH", "LIB"]) assert.ok(!flat.includes(ambient), ambient);
  assert.deepEqual(Object.keys(build).sort(), ["compilerElapsedMs", "compilerSha256", "compilerStatus", "exe", "exeSha256", "mscorlibSha256", "sourceSha256"]);
  assert.equal(build.exe, EXE);
  assert.ok(world.entries.get(SRC).data.equals(Buffer.from(mod.FAKE_CMUX_CS, "utf8")));
  assert.equal(build.sourceSha256, PIN);
  assert.equal(build.sourceSha256, sha256(world.entries.get(SRC).data));
  assert.equal(build.compilerSha256, sha256(CSC_BYTES));
  assert.equal(build.mscorlibSha256, sha256(CORLIB_BYTES));
  assert.notEqual(build.compilerSha256, build.mscorlibSha256);
  assert.equal(build.exeSha256, sha256(EXE_BYTES));
  assert.equal(build.compilerStatus, 0);
  assert.ok(Number.isFinite(build.compilerElapsedMs) && build.compilerElapsedMs >= 0);
  assert.equal(openFds(world), 0);
  assert.equal(count(world, "unlink"), 0);
  assert.deepEqual(scratchLeft(world), [SCRATCH, EXE, SRC].sort());
  const mark = world.calls.length;
  world.exit();
  assert.deepEqual(world.calls.slice(mark).map((c) => [c.op, ...c.args]), [["lstat", SRC], ["unlink", SRC], ["lstat", EXE], ["unlink", EXE], ["rmdir", SCRATCH]]);
  assert.deepEqual(scratchLeft(world), []);
  assert.equal(world.process.exitCode, undefined);
  assert.deepEqual(world.stderr, []);
  const again = world.calls.length;
  world.exit();
  assert.equal(world.calls.length, again, "release is idempotent");
  invariants(world);
});

test("build exactly once: success memoized; compile and prerequisite failures cached and rethrown without retry", () => {
  {
    const { world, mod } = boot();
    assert.equal(mod.fakeCmuxBuild(), mod.fakeCmuxBuild());
    assert.equal(world.spawns.length, 1);
    assert.equal(count(world, "mkdtemp"), 1);
    assert.equal(world.listeners.length, 1);
    invariants(world);
  }
  {
    const { world, mod } = boot({ spawn: () => res({ status: 1, stdout: "boom" }) });
    const first = attempt(() => mod.fakeCmuxBuild()).error;
    assert.equal(first.message, "fake-cmux prerequisite: csc.exe failed rc=1\nboom");
    const mark = world.calls.length;
    assert.equal(attempt(() => mod.fakeCmuxBuild()).error, first);
    assert.equal(world.calls.length, mark);
    assert.equal(world.spawns.length, 1);
    invariants(world);
  }
  {
    const { world, mod } = boot({ csc: null });
    const first = attempt(() => mod.fakeCmuxBuild()).error;
    world.put(CSC, "file", CSC_BYTES);
    assert.equal(attempt(() => mod.fakeCmuxBuild()).error, first);
    assert.equal(count(world, "lstat"), 1);
    invariants(world);
  }
});

const FAILURES = [
  ["timeout (ETIMEDOUT + SIGTERM)", () => res({ error: errno("ETIMEDOUT", "spawnSync"), status: null, signal: "SIGTERM", stdout: "partial" }),
    "fake-cmux prerequisite: csc.exe did not complete (ETIMEDOUT) rc=-1\npartial"],
  ["spawn ENOENT", () => res({ error: errno("ENOENT", "spawnSync"), status: null }), "fake-cmux prerequisite: csc.exe did not complete (ENOENT) rc=-1"],
  ["maxBuffer ENOBUFS", () => res({ error: errno("ENOBUFS", "spawnSync"), status: null, signal: "SIGTERM", stderr: "x" }),
    "fake-cmux prerequisite: csc.exe did not complete (ENOBUFS) rc=-1\nx"],
  ["error without code", () => res({ error: new TypeError("weird"), status: null }), "fake-cmux prerequisite: csc.exe did not complete (TypeError) rc=-1"],
  ["error with status", () => res({ error: errno("EPERM", "spawnSync"), status: 5 }), "fake-cmux prerequisite: csc.exe did not complete (EPERM) rc=5"],
  ["signal only", () => res({ status: null, signal: "SIGKILL", stderr: "killed" }), "fake-cmux prerequisite: csc.exe ended by SIGKILL rc=-1\nkilled"],
  ["nonzero exit after writing exe", ({ put }) => { put(EXE, "file", EXE_BYTES); return res({ status: 3, stdout: "error CS1001" }); },
    "fake-cmux prerequisite: csc.exe failed rc=3\nerror CS1001"],
  ["status 0 but no exe", () => res({}), "fake-cmux prerequisite: csc.exe produced no cmux.exe rc=0"],
  ["empty exe", ({ put }) => { put(EXE, "file", Buffer.alloc(0)); return res({}); }, "fake-cmux prerequisite: cmux.exe is not a non-empty regular file rc=0"],
  ["symlink exe", ({ put }) => { put(EXE, "symlink", Buffer.from("C:\\elsewhere")); return res({}); },
    "fake-cmux prerequisite: cmux.exe is not a non-empty regular file rc=0"],
  ["invalid PE magic", ({ put }) => { put(EXE, "file", Buffer.from("PK\u0003\u0004 not a PE")); return res({}); },
    "fake-cmux prerequisite: cmux.exe is not a PE image rc=0"],
];
for (const [label, spawn, message] of FAILURES) {
  test(`compile failure: ${label} -> exact error, immediate owned cleanup, no exitCode, release idempotent`, () => {
    const { world, mod } = boot({ spawn });
    const r = attempt(() => mod.fakeCmuxBuild());
    assert.equal(r.error.message, message);
    assert.deepEqual(scratchLeft(world), []);
    assert.equal(openFds(world), 0);
    assert.equal(world.process.exitCode, undefined);
    assert.deepEqual(world.stderr, []);
    assert.equal(world.spawns.length, 1);
    const mark = world.calls.length;
    world.exit();
    assert.equal(world.calls.length, mark);
    invariants(world);
  });
}

test("compile failure: exe is a directory -> leaf unlink fails, dir and root preserved, exitCode 1, path-free stderr", () => {
  const { world, mod } = boot({ spawn: ({ put }) => { put(EXE, "dir"); return res({}); } });
  assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: cmux.exe is not a non-empty regular file rc=0");
  assert.deepEqual(scratchLeft(world), [SCRATCH, EXE].sort());
  assert.equal(world.process.exitCode, 1);
  assert.deepEqual(world.stderr, ["fake-cmux: scratch cleanup failed for cmux.exe, <scratch>\n"]);
  invariants(world);
});

test("source pin: tampered written cmux.cs refused before spawn and removed", () => {
  const { world, mod } = boot({ faults: { write: (p, bytes) => ({ data: Buffer.concat([bytes, Buffer.from("// tampered\n")]) }) } });
  assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: written cmux.cs does not match its pin rc=-1");
  assert.equal(world.spawns.length, 0);
  assert.deepEqual(scratchLeft(world), []);
  assert.equal(world.process.exitCode, undefined);
  invariants(world);
});

test("redaction: scratch root and SystemRoot replaced; compiler detail bounded to 2048 chars", () => {
  const noisy = `${SRC}(3,1): error CS0001 at ${FW}\\csc.exe\n${"y".repeat(5000)}`;
  const { world, mod } = boot({ spawn: () => res({ status: 1, stdout: noisy, stderr: "tail-never-shown" }) });
  const e = attempt(() => mod.fakeCmuxBuild()).error;
  assert.ok(e.message.startsWith("fake-cmux prerequisite: csc.exe failed rc=1\n"));
  const detail = detailOf(e);
  assert.equal(detail.length, 2048);
  assert.ok(detail.startsWith("<scratch>\\cmux.cs(3,1): error CS0001 at <SystemRoot>\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe\n"));
  for (const secret of [SCRATCH, SYS, "Users\\tester", "tail-never-shown"]) assert.ok(!e.message.includes(secret), secret);
  invariants(world);
});

// Only the paths the helper itself knows (scratch root, SystemRoot, the tmpdir parent) are in scope; no
// claim is made that unknown secrets in compiler output are scrubbed.
const swapCase = (s) => s.replace(/[A-Za-z]/g, (ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()));
test("desired F2: mixed-case scratch, SystemRoot and tmpdir parent in compiler output are redacted; detail bounded to 2048", () => {
  const output = `${swapCase(SCRATCH)}\\cmux.cs(3,1): error CS0001 at ${swapCase(SYS)}\\Microsoft.NET\\x and ${swapCase(TMP)}\\elsewhere.cs\n${"y".repeat(5000)}`;
  const { world, mod } = boot({ spawn: () => res({ status: 1, stdout: output }) });
  const e = attempt(() => mod.fakeCmuxBuild()).error;
  assert.ok(e.message.startsWith("fake-cmux prerequisite: csc.exe failed rc=1\n"));
  const detail = detailOf(e);
  assert.ok(detail.length > 0 && detail.length <= 2048, `bounded: ${detail.length}`);
  const lower = e.message.toLowerCase();
  for (const known of [SCRATCH, SYS, TMP]) assert.ok(!lower.includes(known.toLowerCase()), `known path redacted: ${known}`);
  assert.ok(detail.startsWith("<scratch>\\cmux.cs(3,1): error CS0001 at <SystemRoot>\\Microsoft.NET\\x and "), detail.slice(0, 160));
  assert.match(detail, /\\elsewhere\.cs\n/);
  invariants(world);
});

test("desired F2: redaction is literal (regex metacharacters in SystemRoot neither break nor widen it)", () => {
  const sys = "C:\\Win.dows (x86)+$";
  const fw = win32.join(sys, "Microsoft.NET", "Framework64", "v4.0.30319");
  const lookalike = "C:\\WinXdows (x86)+$\\keep";
  const output = `${swapCase(sys)}\\Microsoft.NET\\x and ${sys}\\y but ${lookalike}`;
  const { world, mod } = boot({ csc: null, corlib: null, env: { ...defaultEnv(), SystemRoot: sys, windir: sys },
    spawn: () => res({ status: 1, stdout: output }) });
  world.put(win32.join(fw, "csc.exe"), "file", CSC_BYTES);
  world.put(win32.join(fw, "mscorlib.dll"), "file", CORLIB_BYTES);
  const e = attempt(() => mod.fakeCmuxBuild()).error;
  assert.equal(detailOf(e), `<SystemRoot>\\Microsoft.NET\\x and <SystemRoot>\\y but ${lookalike}`);
  invariants(world);
});

const partialWrite = { write: (p, bytes) => ({ data: bytes.subarray(0, 17), error: errno("ENOSPC", "write") }) };
test("R2: injected partial-write fault removes cmux.cs and scratch root and closes the descriptor", () => {
  const { world, mod } = boot({ faults: partialWrite });
  assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: cannot write cmux.cs (write ENOSPC) rc=-1");
  assert.deepEqual(scratchLeft(world), []);
  assert.equal(openFds(world), 0);
  assert.equal(count(world, "close"), 1);
  assert.deepEqual(world.calls.filter((c) => c.op === "unlink").map((c) => c.args[0]), [SRC]);
  assert.equal(world.process.exitCode, undefined);
  assert.deepEqual(world.stderr, []);
  assert.equal(world.spawns.length, 0);
  invariants(world);
});

test("R2: close failure after the underlying close is surfaced once (no double close) and cleanup still removes source/root", () => {
  const closeFault = { close: () => errno("EIO", "close") };
  for (const [faults, message] of [[closeFault, "fake-cmux prerequisite: cannot write cmux.cs (close EIO) rc=-1"],
    [{ ...partialWrite, ...closeFault }, "fake-cmux prerequisite: cannot write cmux.cs (write ENOSPC, close EIO) rc=-1"]]) {
    const { world, mod } = boot({ faults });
    assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, message);
    assert.equal(count(world, "close"), 1);
    assert.equal(openFds(world), 0);
    assert.deepEqual(scratchLeft(world), []);
    assert.equal(world.process.exitCode, undefined);
    assert.equal(world.spawns.length, 0);
    invariants(world);
  }
});

test("R2: uncertain open (file created, open reports failure) is not adopted: no fd, no unlink, scratch kept and surfaced path-free", () => {
  const { world, mod } = boot({ faults: { open: () => errno("EMFILE", "open") } });
  assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: cannot exclusively create cmux.cs rc=-1");
  assert.equal(world.fds.size, 0, "no descriptor was returned to the module, so none can be closed by it");
  assert.equal(count(world, "writeFile") + count(world, "close") + count(world, "unlink"), 0);
  assert.deepEqual(scratchLeft(world), [SCRATCH, SRC].sort());
  assert.equal(world.process.exitCode, 1);
  assert.deepEqual(world.stderr, [CLEANUP_FAILED_SCRATCH]);
  invariants(world);
});

test("R2: EEXIST pre-existing cmux.cs in the scratch root is NOT removed (not owned); failure surfaced", () => {
  const { world, mod } = boot({ faults: { afterMkdtemp: (p, put) => { put(`${p}\\cmux.cs`, "file", Buffer.from("foreign")); } } });
  assert.equal(attempt(() => mod.fakeCmuxBuild()).error.message, "fake-cmux prerequisite: cannot exclusively create cmux.cs rc=-1");
  assert.equal(world.entries.get(SRC).data.toString(), "foreign");
  assert.equal(count(world, "unlink"), 0);
  assert.deepEqual(scratchLeft(world), [SCRATCH, SRC].sort());
  assert.equal(world.process.exitCode, 1);
  assert.deepEqual(world.stderr, [CLEANUP_FAILED_SCRATCH]);
  invariants(world);
});

test("exit cleanup: only known leaves and root; extra leaf preserved and failure surfaced path-free", () => {
  const { world, mod } = boot();
  mod.fakeCmuxBuild();
  world.put(`${SCRATCH}\\cmux.pdb`, "file", Buffer.from("pdb"));
  world.exit();
  assert.deepEqual(scratchLeft(world), [SCRATCH, `${SCRATCH}\\cmux.pdb`].sort());
  assert.equal(world.process.exitCode, 1);
  assert.deepEqual(world.stderr, [CLEANUP_FAILED_SCRATCH]);
  invariants(world);
});

test("exit cleanup: unlink failure, non-ENOENT lstat failure and rmdir failure each reported; exitCode 1", () => {
  const cases = [
    [{ unlink: (p) => (p === EXE ? errno("EPERM", "unlink") : undefined) }, "fake-cmux: scratch cleanup failed for cmux.exe, <scratch>\n", [SCRATCH, EXE]],
    [{ lstat: (p) => (p === SRC ? errno("EACCES", "lstat") : undefined) }, "fake-cmux: scratch cleanup failed for cmux.cs, <scratch>\n", [SCRATCH, SRC]],
    [{ rmdir: () => errno("EBUSY", "rmdir") }, CLEANUP_FAILED_SCRATCH, [SCRATCH]],
  ];
  for (const [faults, line, left] of cases) {
    const { world, mod } = boot({ faults });
    mod.fakeCmuxBuild();
    world.exit();
    assert.equal(world.process.exitCode, 1);
    assert.deepEqual(world.stderr, [line]);
    assert.deepEqual(scratchLeft(world), left.sort());
    invariants(world);
  }
});

test("install: COPYFILE_EXCL copy, sha256 rebind of the copied target, memoized build reused", () => {
  const { world, mod } = boot();
  assert.equal(mod.installFakeCmux(BIN), TARGET);
  assert.ok(COPYFILE_EXCL > 0);
  assert.deepEqual(world.calls.filter((c) => c.op === "copyFile").map((c) => c.args), [[EXE, TARGET, COPYFILE_EXCL]]);
  assert.ok(world.entries.get(TARGET).data.equals(EXE_BYTES));
  const copied = world.calls.findIndex((c) => c.op === "copyFile");
  assert.ok(world.calls.slice(copied).some((c) => c.op === "readFile" && c.args[0] === TARGET), "target re-hashed after copy");
  assert.equal(mod.installFakeCmux("D:\\fixture\\bin2"), "D:\\fixture\\bin2\\cmux.exe");
  assert.equal(world.spawns.length, 1);
  invariants(world);
});

test("install: existing target is not overwritten or removed (EEXIST propagates)", () => {
  const { world, mod } = boot();
  world.put(TARGET, "file", Buffer.from("old"));
  const e = attempt(() => mod.installFakeCmux(BIN)).error;
  assert.equal(e.code, "EEXIST");
  assert.equal(world.entries.get(TARGET).data.toString(), "old");
  invariants(world);
});

test("install: copy fault propagates (not ignored); a target of unknown ownership left by the failed copy is not removed", () => {
  {
    const { world, mod } = boot({ faults: { copy: () => errno("EIO", "copyfile") } });
    assert.equal(attempt(() => mod.installFakeCmux(BIN)).error.code, "EIO");
    assert.equal(world.entries.has(TARGET), false);
    invariants(world);
  }
  {
    const { world, mod } = boot({ faults: { afterCopy: (dst) => (dst === TARGET ? errno("EIO", "copyfile") : undefined) } });
    assert.equal(attempt(() => mod.installFakeCmux(BIN)).error.code, "EIO");
    assert.equal(world.entries.has(TARGET), true, "partial target of unknown ownership preserved");
    invariants(world);
  }
});

test("install: cached build failure rethrown; no copy attempted", () => {
  const { world, mod } = boot({ csc: null });
  const first = attempt(() => mod.installFakeCmux(BIN)).error;
  assert.equal(first.message, CSC_MISSING);
  assert.equal(attempt(() => mod.installFakeCmux(BIN)).error, first);
  assert.equal(count(world, "copyFile"), 0);
  invariants(world);
});

// F3: after a successful exclusive copy the target is owned only while it is still that copy. A cleanup
// that is skipped (unknown ownership, replaced by a file/symlink/directory) or fails must be reported in
// the thrown error or on stderr, never by deleting, overwriting or recursing.
const tamperCopy = { copyData: (data) => Buffer.concat([data, Buffer.from("!")]) };
// Explicit residue-with-reason wording ("cmux.exe left in place (unlink EPERM)") counts as a report too.
const CLEANUP_REPORT = /clean ?up|not removed|owner|unknown|replaced|left in place \([^)]+\)/i;
const reportOf = (world, error) => `${error.message}\n${world.stderr.join("")}`;

test("desired F3: hash mismatch after a successful exclusive copy removes the owned regular copy and propagates the mismatch", () => {
  const { world, mod } = boot({ faults: tamperCopy });
  const e = attempt(() => mod.installFakeCmux(BIN)).error;
  assert.ok(e && e.message.includes(MISMATCH), e && e.message);
  assert.equal(world.entries.has(TARGET), false, "owned mismatched copy removed");
  assert.deepEqual(world.calls.filter((c) => c.op === "unlink").map((c) => c.args[0]), [TARGET]);
  assert.equal(count(world, "rmdir"), 0);
  invariants(world, [SRC, EXE, TARGET]);
});

test("desired F3: owned copy whose cleanup unlink fails -> original mismatch propagates and the cleanup failure is reported", () => {
  const { world, mod } = boot({ faults: { ...tamperCopy, unlink: (p) => (p === TARGET ? errno("EPERM", "unlink") : undefined) } });
  const e = attempt(() => mod.installFakeCmux(BIN)).error;
  assert.ok(e && e.message.includes(MISMATCH), e && e.message);
  assert.match(reportOf(world, e), CLEANUP_REPORT);
  assert.equal(world.entries.has(TARGET), true);
  invariants(world, [SRC, EXE, TARGET]);
});

const REPLACED = [
  ["a different regular file", (put) => { put(TARGET, "file", FOREIGN); return FOREIGN; }, "file"],
  ["a symlink", (put) => { put(TARGET, "symlink", Buffer.from("C:\\elsewhere\\victim.exe")); return FOREIGN; }, "symlink"],
  ["a directory", (put) => { put(TARGET, "dir"); return errno("EISDIR", "read"); }, "dir"],
];
for (const [label, replace, type] of REPLACED) {
  test(`desired F3: target replaced by ${label} before verification -> not deleted/overwritten/recursed, original failure propagates, reported`, () => {
    const { world, mod } = boot({ faults: { read: (p, put) => (p === TARGET ? replace(put) : undefined) } });
    const e = attempt(() => mod.installFakeCmux(BIN)).error;
    assert.ok(e, "install must fail");
    if (type === "dir") assert.ok(e.code === "EISDIR" || /EISDIR/.test(e.message) || (e.cause && e.cause.code === "EISDIR"), e.message);
    else assert.ok(e.message.includes(MISMATCH), e.message);
    assert.match(reportOf(world, e), CLEANUP_REPORT);
    assert.equal(world.entries.get(TARGET).type, type, "replacement preserved");
    if (type === "file") assert.ok(world.entries.get(TARGET).data.equals(FOREIGN));
    assert.equal(count(world, "copyFile"), 1, "no overwrite");
    invariants(world);
  });
}

test("desired F3: lstat failure on the freshly copied target -> ownership unknown, target kept, no unlink, failure explicit", () => {
  const { world, mod } = boot({ faults: { lstat: (p) => (p === TARGET ? errno("EACCES", "lstat") : undefined) } });
  const e = attempt(() => mod.installFakeCmux(BIN)).error;
  assert.ok(e, "install must fail when the copy cannot be inspected");
  assert.match(e.message, /EACCES/);
  assert.ok(world.entries.get(TARGET).data.equals(EXE_BYTES), "copy of unknown ownership preserved");
  assert.equal(count(world, "copyFile"), 1, "no overwrite");
  invariants(world);
});

const INITIAL = [
  ["a symlink", (put) => put(TARGET, "symlink", Buffer.from("C:\\elsewhere\\victim.exe")), "symlink"],
  ["a directory", (put) => put(TARGET, "dir"), "dir"],
];
for (const [label, replace, type] of INITIAL) {
  test(`desired F3: target already ${label} before initial verification -> rejected, preserved, no unlink, residue explicit`, () => {
    const { world, mod } = boot({ faults: { afterCopy: (dst, put) => { if (dst === TARGET) replace(put); } } });
    const e = attempt(() => mod.installFakeCmux(BIN)).error;
    assert.ok(e, "install must fail");
    assert.match(reportOf(world, e), CLEANUP_REPORT);
    assert.equal(world.entries.get(TARGET).type, type, "non-regular target preserved");
    assert.equal(count(world, "copyFile"), 1, "no overwrite");
    invariants(world);
  });
}

test("desired F3: read failure of the owned regular copy -> original failure retained, only that copy removed", () => {
  const { world, mod } = boot({ faults: { read: (p) => (p === TARGET ? errno("EIO", "read") : undefined) } });
  const e = attempt(() => mod.installFakeCmux(BIN)).error;
  assert.ok(e, "install must fail");
  // In this vm a host-realm mock Error may fail the helper instanceof check and be rewrapped (code lost,
  // "Error: " prefix); the code, the message or the cause must still carry the original EIO.
  assert.ok(e.code === "EIO" || /EIO/.test(e.message) || (e.cause && e.cause.code === "EIO"), e.message);
  assert.equal(world.entries.has(TARGET), false, "owned copy removed");
  assert.deepEqual(world.calls.filter((c) => c.op === "unlink").map((c) => c.args[0]), [TARGET]);
  assert.equal(count(world, "rmdir"), 0);
  invariants(world, [SRC, EXE, TARGET]);
});
