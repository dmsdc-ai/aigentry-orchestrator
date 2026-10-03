import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Private temporary root, or retained explicit output; no host paths, network, global builtin patches,
// production edits, or transformed product sources. VM modules execute actual
// tsc output, with filesystem faults confined to one child's module imports.
const requestedOutput = process.env.SR1166_OUTPUT;
if (requestedOutput !== undefined && !path.isAbsolute(requestedOutput)) throw new Error("SR1166_OUTPUT must be absolute");
const isChild = process.argv[2] === "--child";
if (isChild && requestedOutput === undefined) throw new Error("Sweep child requires inherited SR1166_OUTPUT");
const output = requestedOutput ?? fs.mkdtempSync(path.join(os.tmpdir(), "report-sweep-retry-"));
const activeChildren: Array<{ proc: ChildProcess; done: Promise<unknown> }> = [];
const self = fileURLToPath(import.meta.url);
const epoch = Date.parse("2026-09-13T10:00:00Z");
const later = epoch + 3_600_000;
const payload = (name: string) => Buffer.from(`# REPORT — retry1166: ${name}\n\u0000한글\r\n${name}\n`);
const save = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
interface Retry { basename: string; observed_mtime_ms: number; error_code: string; first_seen_at: string }
interface Cursor { version: number; last_mtime_ms: number; seen: Record<string, number>; retries: Retry[] }
interface Fixture { root: string; state: string; shared: string }
interface Config { root: string; at: number; fault?: string; target?: string; barrier?: string }
interface Result { code: number; pid: number; stdout: string[]; stderr: string[]; attempts: string[]; faults: string[] }
interface Stage { result: Result; cursor: Cursor; inbox: Record<string, string> }
const privatePath = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

async function child(config: Config): Promise<void> {
  assert.ok(privatePath(output!, config.root));
  const state = path.join(config.root, "state");
  const shared = path.join(config.root, "shared");
  const cursor = path.join(state, "report-cursor.json");
  const result: Result = { code: -1, pid: process.pid, stdout: [], stderr: [], attempts: [], faults: [] };
  const target = path.join(shared, config.target ?? "A.md");
  const fault = (code: string, file: string): never => {
    assert.ok(privatePath(config.root, file));
    result.faults.push(`${code}:${file}`);
    throw Object.assign(new Error(`${code}: isolated fixture ${file}`), { code, path: file });
  };
  const barrier = async (name: string) => {
    if (config.barrier !== name) return;
    assert.ok(process.send, "barriers require an IPC child");
    await new Promise<void>(resolve => {
      process.once("message", message => { assert.equal(message, "release"); resolve(); });
      process.send!({ event: name, pid: process.pid });
    });
  };
  const syncFs = { ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const file = String(args[0]);
      if (privatePath(shared, file)) result.attempts.push(path.basename(file));
      if (config.fault === "read" && file === target) fault("EACCES", file);
      if (config.fault === "pending" && path.dirname(file) === shared && path.basename(file).startsWith("r-")) fault("EACCES", file);
      if (config.fault === "cursor-read" && file === cursor) fault("EACCES", file);
      return Reflect.apply(fs.readFileSync, fs, args);
    }) as typeof fs.readFileSync,
    statSync: ((...args: Parameters<typeof fs.statSync>) => {
      if (config.fault === "stat" && String(args[0]) === target) fault("EACCES", target);
      return Reflect.apply(fs.statSync, fs, args);
    }) as typeof fs.statSync,
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      if (config.fault === "discovery" && String(args[0]) === shared) fault("EACCES", shared);
      return Reflect.apply(fs.readdirSync, fs, args);
    }) as typeof fs.readdirSync,
  };
  const asyncFs = { ...fsp,
    link: (async (...args: Parameters<typeof fsp.link>) => {
      try { return await fsp.link(...args); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") process.send?.({ event: "contended", pid: process.pid });
        throw error;
      }
    }) as typeof fsp.link,
    open: (async (...args: Parameters<typeof fsp.open>) => {
      const file = String(args[0]);
      const isCursorTemp = file.startsWith(cursor + ".tmp.");
      if (isCursorTemp) await barrier("copy-before-cursor");
      if (config.fault === "copy" && file.includes(`${path.sep}inbox${path.sep}`) && file.includes("-A.md.tmp.")) fault("ENOSPC", file);
      const handle = await fsp.open(...args);
      // Bind methods to the real handle; replace only the selected private path.
      return new Proxy(handle, { get(object, key) {
        if (key === "writeFile" && config.fault === "cursor-space" && isCursorTemp) return async () => fault("ENOSPC", file);
        if (key === "sync") return async () => {
          if (config.fault === "cursor-sync" && isCursorTemp) fault("EIO", file);
          if (config.fault === "cursor-dir-sync" && file === state) fault("EIO", file);
          await object.sync();
          if (file === state) await barrier("commit-before-stdout");
        };
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      } });
    }) as typeof fsp.open,
  };
  const context = vm.createContext({ Buffer, process, setTimeout, clearTimeout, console });
  const modules = new Map<string, vm.Module>();
  const sourceReceipts: Record<string, string> = {};
  async function load(id: string): Promise<vm.Module> {
    const prior = modules.get(id);
    if (prior) return prior;
    let mod: vm.Module;
    if (id.startsWith("node:")) {
      const exports: Record<string, unknown> = id === "node:fs" ? syncFs : id === "node:fs/promises" ? asyncFs : await import(id) as Record<string, unknown>;
      mod = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context, identifier: id });
    } else {
      const bytes = fs.readFileSync(fileURLToPath(id));
      sourceReceipts[id] = createHash("sha256").update(bytes).digest("hex");
      mod = new vm.SourceTextModule(bytes.toString("utf8"), { context, identifier: id });
    }
    modules.set(id, mod);
    await mod.link((specifier, parent) => load(specifier.startsWith("node:") ? specifier : new URL(specifier, parent.identifier).href));
    return mod;
  }
  const module = await load(new URL("../../src/tracker/report-sweep.js", import.meta.url).href);
  await module.evaluate();
  save(path.join(config.root, `child-${process.pid}.source.json`), sourceReceipts);
  const sweep = (module.namespace as { sweep: (deps: unknown) => Promise<number> }).sweep;
  result.code = await sweep({ stateDir: state, sharedDir: shared, repoDir: config.root, nowMs: config.at,
    stdout: (line: string) => result.stdout.push(line), stderr: (line: string) => result.stderr.push(line) });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.disconnect?.();
}

function fixture(run: string, name: string): Fixture {
  const root = path.join(run, name);
  const state = path.join(root, "state"), shared = path.join(root, "shared");
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(shared);
  return { root, state, shared };
}
function seed(f: Fixture, name: string, bytes = payload(name), at = epoch): void {
  const file = path.join(f.shared, `${name}.md`);
  fs.writeFileSync(file, bytes, { mode: 0o600 }); fs.utimesSync(file, at / 1000, at / 1000);
}
function cursorFile(f: Fixture): string { return path.join(f.state, "report-cursor.json"); }
function initial(f: Fixture, extra: Partial<Cursor> = {}): void { save(cursorFile(f), { version: 2, last_mtime_ms: epoch, seen: {}, retries: [], ...extra }); }
function pending(name: string): Retry { return { basename: `${name}.md`, observed_mtime_ms: epoch, error_code: "EACCES", first_seen_at: new Date(epoch).toISOString() }; }
function inbox(f: Fixture): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".md")) result[path.relative(f.state, file)] = fs.readFileSync(file).toString("base64");
    }
  };
  visit(path.join(f.state, "inbox")); return result;
}
function capture(f: Fixture, result: Result): Stage { return { result, cursor: JSON.parse(fs.readFileSync(cursorFile(f), "utf8")) as Cursor, inbox: inbox(f) }; }
function exact(s: Stage, name: string, bytes = payload(name)): void {
  assert.deepEqual(Object.entries(s.inbox).filter(([file]) => file.endsWith(`-${name}.md`)).map(([, content]) => content), [bytes.toString("base64")]);
}
function noCapture(s: Stage, name: string): void {
  assert.ok(!Object.keys(s.inbox).some(file => file.endsWith(`-${name}.md`)));
  assert.equal(s.cursor.seen[name], undefined);
  assert.ok(!s.result.stdout.some(line => line.endsWith(`-${name}.md`)));
}
function runStage(f: Fixture, label: string, options: Partial<Config> = {}): Result {
  const config = { root: f.root, at: epoch, ...options };
  const args = ["--experimental-vm-modules", self, "--child", JSON.stringify(config)];
  const startedAt = new Date().toISOString(), start = performance.now();
  const processResult = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, SR1166_OUTPUT: output } });
  save(path.join(f.root, `${label}.process.json`), { command: [process.execPath, ...args], startedAt, elapsedMs: performance.now() - start,
    exit: processResult.status, signal: processResult.signal, error: processResult.error?.message, stdout: processResult.stdout, stderr: processResult.stderr, inbox: inbox(f), cursorRaw: fs.existsSync(cursorFile(f)) ? fs.readFileSync(cursorFile(f), "utf8") : null });
  assert.equal(processResult.error, undefined); assert.equal(processResult.status, 0, processResult.stderr);
  return JSON.parse(processResult.stdout) as Result;
}
function stage(f: Fixture, label: string, options: Partial<Config> = {}): Stage { return capture(f, runStage(f, label, options)); }

function startChild(f: Fixture, label: string, options: Partial<Config>) {
  const args = ["--experimental-vm-modules", self, "--child", JSON.stringify({ root: f.root, at: epoch, ...options })];
  const startedAt = new Date().toISOString(), start = performance.now();
  const proc = spawn(process.execPath, args, { cwd: f.root, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, SR1166_OUTPUT: output } });
  let stdout = "", stderr = "";
  const events: string[] = [];
  proc.stdout!.on("data", data => { stdout += String(data); });
  proc.stderr!.on("data", data => { stderr += String(data); });
  proc.on("message", message => events.push((message as { event: string }).event));
  const deadline = setTimeout(() => proc.kill("SIGKILL"), 20_000);
  let launchError: Error | undefined;
  const done = new Promise<{ code: number | null; signal: string | null; stdout: string }>((resolve, reject) => {
    proc.on("error", error => { launchError = error; });
    proc.on("close", (code, signal) => {
      clearTimeout(deadline);
      try {
        save(path.join(f.root, `${label}.process.json`), { command: [process.execPath, ...args], startedAt, elapsedMs: performance.now() - start, exit: code, signal, error: launchError?.message, stdout, stderr, events });
        if (launchError) reject(launchError);
        else resolve({ code, signal, stdout });
      } catch (error) { reject(error); }
    });
  });
  // A barrier can fail before its caller awaits done; retain and settle every child before cleanup.
  void done.catch(() => {});
  activeChildren.push({ proc, done });
  const event = (name: string) => new Promise<void>((resolve, reject) => {
    if (events.includes(name)) { resolve(); return; }
    const timeout = setTimeout(() => { proc.off("message", listener); reject(new Error(`barrier timeout: ${name}`)); }, 10_000);
    const listener = (message: unknown) => {
      if ((message as { event: string }).event === name) { clearTimeout(timeout); proc.off("message", listener); resolve(); }
    };
    proc.on("message", listener);
  });
  return { proc, done, event };
}

async function suite(): Promise<void> {
  const run = fs.mkdtempSync(path.join(output!, "retry-"));
  process.stdout.write(`# focused evidence ${run}\n`);
  for (const version of [undefined, 1]) await test(`R01-${version ?? "legacy"}: migrate valid cursor without replaying seen`, () => {
    const f = fixture(run, `migration-${version ?? "legacy"}`); seed(f, "A"); seed(f, "B");
    save(cursorFile(f), { ...(version ? { version } : {}), last_mtime_ms: epoch, seen: { A: epoch } });
    const s = stage(f, "migrate");
    assert.equal(s.result.code, 0); assert.equal(s.cursor.version, 2); assert.equal(s.cursor.seen.A, epoch);
    assert.deepEqual(s.cursor.retries, []); assert.equal(s.result.stdout.length, 1); exact(s, "B");
  });
  const valid = { version: 2, last_mtime_ms: epoch, seen: {}, retries: [] };
  const invalid: Array<[string, string]> = [
    ["json", "{broken"], ["version", JSON.stringify({ ...valid, version: 9 })],
    ["missing-retries", JSON.stringify({ version: 2, last_mtime_ms: epoch, seen: {} })],
    ["retries-object", JSON.stringify({ ...valid, retries: {} })],
    ["legacy-retries", JSON.stringify({ ...valid, version: 1 })],
    ["traversal", JSON.stringify({ ...valid, retries: [pending("../A")] })],
    ["duplicate", JSON.stringify({ ...valid, retries: [pending("A"), pending("A")] })],
    ["conflict", JSON.stringify({ ...valid, seen: { A: epoch }, retries: [pending("A")] })],
    ["bad-time", JSON.stringify({ ...valid, retries: [{ ...pending("A"), first_seen_at: "invalid" }] })],
  ];
  for (const [name, raw] of invalid) await test(`R02-${name}: invalid cursor remains byte-identical and visibly unresolved`, () => {
    const f = fixture(run, `invalid-${name}`); seed(f, "A"); fs.writeFileSync(cursorFile(f), raw);
    const r = runStage(f, "invalid");
    assert.equal(r.code, 3); assert.deepEqual(r.stdout, []); assert.ok(r.stderr.length > 0);
    assert.equal(fs.readFileSync(cursorFile(f), "utf8"), raw); assert.deepEqual(inbox(f), {});
  });
  await test("R03: genuine empty succeeds while a failed read retains exact retry obligation", () => {
    const f = fixture(run, "empty-read"); seed(f, "A"); seed(f, "zero", Buffer.alloc(0));
    const s = stage(f, "failed", { fault: "read" });
    assert.equal(s.result.code, 0); assert.equal(s.result.faults.length, 1); noCapture(s, "A"); exact(s, "zero", Buffer.alloc(0));
    assert.deepEqual(s.cursor.retries, [pending("A")]);
    const recovered = stage(f, "recovered", { at: later }); exact(recovered, "A"); assert.deepEqual(recovered.cursor.retries, []);
  });
  for (const step of [0, 10_000]) await test(`R04-${step}: 257 fresh refs drain across bounded ticks without watermark loss`, () => {
    const f = fixture(run, `fresh-${step}`);
    for (let i = 0; i < 257; i++) seed(f, `n-${String(i).padStart(3, "0")}`, undefined, epoch + i * step);
    const stages = [0, 1, 2].map(i => stage(f, `tick-${i}`, { at: later }));
    assert.deepEqual(stages.map(s => s.result.attempts.length), [128, 128, 1]);
    assert.ok(stages.every(s => s.result.code === 0));
    assert.equal(stages[0]!.cursor.last_mtime_ms, epoch + 128 * step);
    assert.equal(Object.keys(stages[2]!.inbox).length, 257);
    for (let i = 0; i < 257; i++) exact(stages[2]!, `n-${String(i).padStart(3, "0")}`);
    assert.deepEqual(stage(f, "dedup", { at: later }).result.stdout, []);
  });
  await test("R05: 193 persistently failing retries rotate fairly with fresh work and recover beyond overlap", () => {
    const f = fixture(run, "fairness");
    const names = Array.from({ length: 193 }, (_, i) => `r-${String(i).padStart(3, "0")}`);
    for (const name of names) seed(f, name);
    initial(f, { retries: names.map(pending) });
    const stages: Stage[] = [];
    for (let tick = 0; tick < 4; tick++) {
      for (let i = 0; i < 20; i++) seed(f, `fresh-${tick}-${i}`, undefined, later + tick * 1000);
      stages.push(stage(f, `failed-${tick}`, { at: later + tick * 1000, fault: "pending" }));
    }
    for (const s of stages) {
      assert.equal(s.result.code, 0); assert.equal(s.result.attempts.length, 128);
      assert.equal(s.cursor.retries.length, 193); assert.ok(s.cursor.retries.every(r => r.first_seen_at === new Date(epoch).toISOString()));
      assert.equal(s.result.stdout.length, 20);
    }
    assert.equal(new Set(stages.flatMap(s => s.result.attempts.filter(n => n.startsWith("r-")))).size, 193);
    const first = stage(f, "recovery-1", { at: later + 10_000 });
    const last = stage(f, "recovery-2", { at: later + 11_000 });
    assert.equal(first.result.attempts.length, 128); assert.equal(last.result.attempts.length, 65);
    assert.deepEqual(last.cursor.retries, []); assert.equal(Object.keys(last.inbox).length, 273);
    for (const name of names) exact(last, name);
  });
  await test("R06: stat error freezes discovery watermark while independent B progresses", () => {
    const f = fixture(run, "stat"); initial(f); seed(f, "A"); seed(f, "B", undefined, later);
    const s = stage(f, "fault", { at: later, fault: "stat" });
    assert.equal(s.result.code, 3); assert.equal(s.result.faults.length, 1); noCapture(s, "A"); exact(s, "B");
    assert.equal(s.cursor.last_mtime_ms, epoch); exact(stage(f, "recovered", { at: later + 1000 }), "A");
  });
  await test("R07: inbox ENOSPC retains A while B commits independently", () => {
    const f = fixture(run, "copy"); seed(f, "A"); seed(f, "B");
    const s = stage(f, "fault", { fault: "copy" });
    assert.equal(s.result.code, 3); assert.equal(s.result.faults.length, 1); noCapture(s, "A"); exact(s, "B");
    assert.equal(s.cursor.retries[0]!.error_code, "ENOSPC");
    seed(f, "C", undefined, later); const recovered = stage(f, "recovered", { at: later }); exact(recovered, "A"); exact(recovered, "C");
  });
  for (const fault of ["cursor-space", "cursor-sync", "cursor-dir-sync"]) await test(`R08-${fault}: cursor uncertainty retains copies and emits no NEW`, () => {
    const f = fixture(run, fault); initial(f, { retries: [pending("A")] }); seed(f, "A"); seed(f, "B");
    const before = fs.readFileSync(cursorFile(f), "utf8");
    const s = stage(f, "fault", { fault });
    assert.equal(s.result.code, 3); assert.equal(s.result.faults.length, 1); assert.deepEqual(s.result.stdout, []);
    assert.match(s.result.stderr.join("\n"), /commit uncertain/); exact(s, "A"); exact(s, "B");
    if (fault !== "cursor-dir-sync") assert.equal(fs.readFileSync(cursorFile(f), "utf8"), before);
    else assert.equal(s.cursor.seen.A, epoch); // rename visible; media durability unmeasured
    const recovered = stage(f, "recovered"); exact(recovered, "A"); exact(recovered, "B"); assert.deepEqual(recovered.cursor.retries, []);
    assert.equal(recovered.result.stdout.length, fault === "cursor-dir-sync" ? 0 : 2);
  });
  await test("R09: unreadable cursor is preserved with no false success", () => {
    const f = fixture(run, "cursor-read"); initial(f); seed(f, "A"); const before = fs.readFileSync(cursorFile(f), "utf8");
    const r = runStage(f, "fault", { fault: "cursor-read" });
    assert.equal(r.code, 3); assert.equal(r.faults.length, 1); assert.deepEqual(r.stdout, []);
    assert.deepEqual(inbox(f), {}); assert.equal(fs.readFileSync(cursorFile(f), "utf8"), before);
  });
  await test("R10: vanished pending reference survives ENOENT and returns beyond the window", () => {
    const f = fixture(run, "vanished"); initial(f, { retries: [pending("A")] }); seed(f, "B", undefined, later);
    const missing = stage(f, "missing", { at: later }); noCapture(missing, "A"); exact(missing, "B");
    assert.equal(missing.cursor.retries[0]!.error_code, "ENOENT");
    assert.equal(missing.cursor.retries[0]!.first_seen_at, pending("A").first_seen_at);
    seed(f, "A"); const recovered = stage(f, "returned", { at: later + 1000 }); exact(recovered, "A"); assert.deepEqual(recovered.cursor.retries, []);
  });
  await test("R11: failed directory discovery still recovers known pending bytes without moving floor", () => {
    const f = fixture(run, "discovery"); initial(f, { retries: [pending("A")] }); seed(f, "A"); seed(f, "B", undefined, later);
    const failed = stage(f, "fault", { at: later, fault: "discovery" });
    assert.equal(failed.result.code, 3); assert.equal(failed.result.faults.length, 1); exact(failed, "A"); noCapture(failed, "B");
    assert.equal(failed.cursor.last_mtime_ms, epoch); exact(stage(f, "recovered", { at: later }), "B");
  });
  await test("R12: two concurrent same-clock sweepers serialize and retain the failed retry", async () => {
    const f = fixture(run, "concurrent"); initial(f); seed(f, "A"); seed(f, "B");
    const children: ChildProcess[] = [];
    try {
      const first = startChild(f, "first", { fault: "read", barrier: "copy-before-cursor" }); children.push(first.proc);
      await first.event("copy-before-cursor");
      seed(f, "C");
      const second = startChild(f, "second", { fault: "read" }); children.push(second.proc);
      await second.event("contended"); first.proc.send("release");
      const [a, b] = await Promise.all([first.done, second.done]);
      assert.equal(a.code, 0); assert.equal(b.code, 0);
      const ar = JSON.parse(a.stdout) as Result, br = JSON.parse(b.stdout) as Result;
      assert.equal(ar.code, 0); assert.equal(br.code, 0);
      assert.equal(ar.stdout.length + br.stdout.length, 2);
      const s = capture(f, br); exact(s, "B"); exact(s, "C"); noCapture(s, "A");
      assert.deepEqual(s.cursor.retries, [pending("A")]);
      exact(stage(f, "restored", { at: later }), "A");
    } finally { for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL"); }
  });
  for (const barrier of ["copy-before-cursor", "commit-before-stdout"]) await test(`R13-${barrier}: real child termination preserves bytes; notification limits recorded`, async () => {
    const f = fixture(run, barrier); initial(f, { retries: [pending("A")] }); seed(f, "A");
    const c = startChild(f, "crash", { barrier });
    try {
      await c.event(barrier);
      save(path.join(f.root, "at-barrier.json"), { cursor: fs.readFileSync(cursorFile(f), "utf8"), inbox: inbox(f) });
      c.proc.kill("SIGKILL"); const killed = await c.done;
      assert.equal(killed.code, null); assert.equal(killed.signal, "SIGKILL"); assert.equal(killed.stdout, "");
      const recovered = stage(f, "restart", { at: later });
      assert.equal(recovered.result.code, 0); exact(recovered, "A"); assert.deepEqual(recovered.cursor.retries, []);
      assert.equal(recovered.result.stdout.length, barrier === "copy-before-cursor" ? 1 : 0);
      assert.deepEqual(stage(f, "dedup", { at: later }).result.stdout, []);
    } finally { if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGKILL"); }
  });
}

if (isChild) await child(JSON.parse(process.argv[3]!) as Config);
else {
  try {
    if (process.platform === "darwin" || process.platform === "linux") await suite();
    else await test("report sweep retry: POSIX directory fsync and SIGKILL barriers", {
      skip: `Requires macOS/Linux; ${process.platform} coverage is unmeasured`,
    }, () => {});
  } finally {
    for (const { proc } of activeChildren) {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
    await Promise.allSettled(activeChildren.map(({ done }) => done));
    if (requestedOutput === undefined) fs.rmSync(output, { recursive: true, force: true });
  }
}
