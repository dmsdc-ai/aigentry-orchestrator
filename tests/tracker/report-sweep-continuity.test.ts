import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sweep } from "../../src/tracker/report-sweep.js";

// Only private fixtures are touched. Every sweep runs in a fresh, bounded child.
const requestedOutput = process.env.SR1166_OUTPUT;
if (requestedOutput !== undefined && !path.isAbsolute(requestedOutput)) throw new Error("SR1166_OUTPUT must be absolute");
const isChild = process.argv[2] === "--sweep-child";
if (isChild && requestedOutput === undefined) throw new Error("Sweep child requires inherited SR1166_OUTPUT");
const output = requestedOutput ?? fs.mkdtempSync(path.join(os.tmpdir(), "report-sweep-continuity-"));
const self = fileURLToPath(import.meta.url);
const epoch = Date.parse("2026-09-13T10:00:00Z");
const later = epoch + 360_000;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const payload = (kind: string, label: string) => Buffer.from(`# ${kind} — sr1166: ${label}\n\nExact bytes: 한글\r\n\u0000${label}\n`);

interface Capture { base64: string; sha256: string; size: number; mtimeMs: number; mode: number }
interface Snapshot { state: Record<string, Capture>; shared: Record<string, Capture> }
interface Result {
  code: number; pid: number; stdout: string[]; stderr: string[];
  mechanism: string; injectedReads: number; chmodProbe: string;
}
interface Stage { result: Result; snapshot: Snapshot }
interface Fixture { root: string; state: string; shared: string }
interface Cursor { last_mtime_ms: number; seen: Record<string, number> }

function inventory(dir: string, prefix = ""): Record<string, Capture> {
  const result: Record<string, Capture> = {};
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, inventory(file, relative));
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(file);
      const stat = fs.statSync(file);
      result[relative] = { base64: bytes.toString("base64"), sha256: digest(bytes), size: bytes.length,
        mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 };
    } else throw new Error(`Unexpected fixture entry: ${file}`);
  }
  return result;
}

function save(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function child(): Promise<void> {
  const root = path.resolve(process.argv[3]!);
  const relative = path.relative(output!, root);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Non-private fixture");
  const a = path.join(root, "shared", "A.md");
  const failA = process.argv[5] === "fail-A";
  const originalRead = fs.readFileSync;
  let originalMode: number | undefined;
  const result: Result = { code: -1, pid: process.pid, stdout: [], stderr: [],
    mechanism: "none", injectedReads: 0, chmodProbe: "not requested" };
  try {
    if (failA) {
      originalMode = fs.statSync(a).mode & 0o777;
      let reliable = false;
      try {
        fs.chmodSync(a, 0);
        try { originalRead(a); result.chmodProbe = "chmod(000) still readable"; }
        catch (error) {
          result.chmodProbe = `read after chmod(000): ${(error as NodeJS.ErrnoException).code}`;
          reliable = (error as NodeJS.ErrnoException).code === "EACCES";
        }
      } catch (error) { result.chmodProbe = `chmod unavailable: ${(error as NodeJS.ErrnoException).code}`; }
      if (reliable) result.mechanism = "actual chmod(000) on private shared/A.md";
      else {
        fs.chmodSync(a, originalMode);
        result.mechanism = "child-only node:fs.readFileSync exact-path EACCES + syncBuiltinESMExports";
        fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
          if (args[0] === a) {
            result.injectedReads++;
            throw Object.assign(new Error(`EACCES: private fixture read '${a}'`), { code: "EACCES", path: a, syscall: "open" });
          }
          return Reflect.apply(originalRead, fs, args);
        }) as typeof fs.readFileSync;
        syncBuiltinESMExports();
      }
    }
    result.code = await sweep({ stateDir: path.join(root, "state"), sharedDir: path.join(root, "shared"),
      repoDir: root, nowMs: Number(process.argv[4]), stdout: line => result.stdout.push(line), stderr: line => result.stderr.push(line) });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    if (originalMode !== undefined) fs.chmodSync(a, originalMode);
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}

function fixture(run: string, name: string): Fixture {
  const root = path.join(run, name);
  const state = path.join(root, "state");
  const shared = path.join(root, "shared");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(shared);
  save(path.join(state, "active.json"), { dispatches: [{ assigned: { sid: "sr1166-tester" } }] });
  return { root, state, shared };
}

function seed(f: Fixture, name: string, bytes: Buffer, at = epoch): void {
  const file = path.join(f.shared, `${name}.md`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.utimesSync(file, at / 1000, at / 1000);
}

function snapshot(f: Fixture): Snapshot { return { state: inventory(f.state), shared: inventory(f.shared) }; }

function runStage(f: Fixture, label: string, at: number, failA = false): Stage {
  const before = snapshot(f);
  save(path.join(f.root, `${label}.before.json`), before);
  const args = [self, "--sweep-child", f.root, String(at), failA ? "fail-A" : "readable"];
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const processResult = spawnSync(process.execPath, args, { cwd: f.root, encoding: "utf8", timeout: 15_000,
    maxBuffer: 1024 * 1024, env: { ...process.env, SR1166_OUTPUT: output } });
  const after = snapshot(f);
  save(path.join(f.root, `${label}.process.json`), { command: [process.execPath, ...args], startedAt,
    durationMs: performance.now() - start, status: processResult.status, signal: processResult.signal,
    error: processResult.error?.message, stdout: processResult.stdout, stderr: processResult.stderr });
  save(path.join(f.root, `${label}.after.json`), after);
  assert.equal(processResult.error, undefined, `${label}: child timed out or could not launch`);
  assert.equal(processResult.status, 0, `${label}: child failed: ${processResult.stderr}`);
  const result = JSON.parse(processResult.stdout) as Result;
  save(path.join(f.root, `${label}.result.json`), result);
  return { result, snapshot: after };
}

function copies(s: Stage, name: string): Capture[] {
  return Object.entries(s.snapshot.state).filter(([file]) => file.startsWith("inbox/") && file.endsWith(`-${name}.md`)).map(([, value]) => value);
}
function exact(s: Stage, name: string, bytes: Buffer): void {
  assert.deepEqual(copies(s, name).map(c => c.base64), [bytes.toString("base64")], `${name}: one exact evidence copy required`);
}
function cursor(s: Stage): Cursor {
  return JSON.parse(Buffer.from(s.snapshot.state["report-cursor.json"]!.base64, "base64").toString("utf8")) as Cursor;
}
function announced(s: Stage, name: string): string[] { return s.result.stdout.filter(line => line.endsWith(`-${name}.md`)); }

async function suite(): Promise<void> {
  const run = fs.mkdtempSync(path.join(output!, "run-"));
  process.stdout.write(`# evidence ${run}\n`);
  const a = payload("REPORT", "A");
  const b = payload("HOLD", "B");
  const c = payload("SPEC", "C");
  const scenarios = [];
  // Collect every stage BEFORE any expected-red assertion can abort a case.
  for (const recovery of ["immediate", "after-overlap"] as const) {
    const f = fixture(run, recovery);
    seed(f, "A", a); seed(f, "B", b);
    const initial = snapshot(f);
    const failed = runStage(f, "01-failed-A", epoch, true);
    const retry = recovery === "immediate" ? runStage(f, "02-restored-restart", epoch + 1000) : undefined;
    seed(f, "C", c, later);
    const advanced = runStage(f, "03-C-advances-watermark", later, recovery === "after-overlap");
    const restored = runStage(f, "04-restored-after-overlap", later + 1000);
    scenarios.push({ recovery, initial, failed, retry, advanced, restored });
  }
  const positive = fixture(run, "positive-controls");
  const controls: Array<[string, Buffer, string]> = [
    ["zero", Buffer.alloc(0), "NEW unknown ? "],
    ["same-prefix-one", payload("REPORT", "one"), "NEW sr1166 REPORT "],
    ["same-prefix-two", payload("HOLD", "two"), "NEW sr1166 HOLD "],
    ["spec", payload("SPEC", "spec"), "NEW sr1166 SPEC "],
    ["ref", payload("DISPATCH", "ref"), "NEW sr1166 REF "],
    ["declared", Buffer.from("track: custom9\n# REPORT\nbody\n"), "NEW custom9 REPORT "],
  ];
  for (const [name, bytes] of controls) seed(positive, name, bytes);
  const positiveBefore = snapshot(positive);
  const captured = runStage(positive, "01-capture", epoch);
  const dedup = runStage(positive, "02-restart-dedup", epoch + 1000);
  // T108's modeled missing-cursor state, not an actual crash/power-loss test.
  fs.unlinkSync(path.join(positive.state, "report-cursor.json"));
  const reemit = runStage(positive, "03-modeled-missing-cursor", epoch + 2000);
  const rededup = runStage(positive, "04-recovered-dedup", epoch + 3000);
  const overlap = fixture(run, "overlap-control");
  seed(overlap, "OLD", a, epoch - 600_000); seed(overlap, "NEAR", b, epoch - 60_000);
  save(path.join(overlap.state, "report-cursor.json"), { last_mtime_ms: epoch, seen: { NEAR: epoch - 60_000 } });
  const quiet = runStage(overlap, "01-floor-and-seen", epoch);
  const cleared = cursor(quiet); delete cleared.seen.NEAR;
  save(path.join(overlap.state, "report-cursor.json"), cleared);
  const near = runStage(overlap, "02-remove-near-seen", epoch);
  save(path.join(run, "baseline.json"), { startedFixtureClock: epoch, advancedFixtureClock: later,
    overlapMs: 300_000, scenarios, controls: { positiveBefore, captured, dedup, reemit, rededup, quiet, near } });

  for (const s of scenarios) {
    await test(`${s.recovery}: only private A has an observed EACCES`, () => {
      assert.equal(s.failed.result.code, 0);
      assert.equal(s.failed.result.stderr.length, 1);
      assert.match(s.failed.result.stderr[0]!, /unreadable ref .*\/shared\/A\.md: .*EACCES/);
      assert.notEqual(s.failed.result.mechanism, "none");
    });
    await test(`${s.recovery}: unreadable A must not create fake empty evidence`, () => assert.equal(copies(s.failed, "A").length, 0));
    await test(`${s.recovery}: unreadable A must not announce NEW success`, () => assert.equal(announced(s.failed, "A").length, 0));
    await test(`${s.recovery}: unreadable A must not enter seen`, () => assert.equal(cursor(s.failed).seen.A, undefined));
    await test(`${s.recovery}: B and newer C proceed independently`, () => {
      exact(s.failed, "B", b); exact(s.advanced, "B", b); exact(s.advanced, "C", c);
      assert.equal(announced(s.failed, "B").length, 1); assert.equal(announced(s.advanced, "C").length, 1);
      assert.equal(cursor(s.advanced).last_mtime_ms, later);
      assert.ok(epoch < cursor(s.advanced).last_mtime_ms - 300_000);
    });
    if (s.retry) await test("immediate: restored A recovers exact bytes after process restart", () => exact(s.retry!, "A", a));
    await test(`${s.recovery}: exact A bytes survive recovery beyond advanced overlap`, () => exact(s.restored, "A", a));
    await test(`${s.recovery}: source bytes, mtime and modes remain unchanged`, () => {
      for (const [name, original] of Object.entries(s.initial.shared)) assert.deepEqual(s.restored.snapshot.shared[name], original);
      assert.equal(s.restored.snapshot.shared["C.md"]!.base64, c.toString("base64"));
    });
    await test(`${s.recovery}: every sweep used a separate process`, () => {
      const stages = [s.failed, ...(s.retry ? [s.retry] : []), s.advanced, s.restored];
      assert.equal(new Set(stages.map(stage => stage.result.pid)).size, stages.length);
      assert.ok(stages.every(stage => stage.result.pid !== process.pid && stage.result.code === 0));
    });
  }
  for (const [name, bytes, header] of controls) await test(`positive: ${name} exact capture and classification`, () => {
    exact(captured, name, bytes);
    assert.equal(announced(captured, name).length, 1);
    assert.ok(announced(captured, name)[0]!.startsWith(header));
    assert.equal(cursor(captured).seen[name], epoch);
  });
  await test("positive: same-second, same-prefix siblings remain distinct", () => {
    assert.equal(captured.result.stdout.length, controls.length);
    assert.equal(positiveBefore.shared["same-prefix-one.md"]!.mtimeMs, positiveBefore.shared["same-prefix-two.md"]!.mtimeMs);
    exact(captured, "same-prefix-one", controls[1]![1]); exact(captured, "same-prefix-two", controls[2]![1]);
  });
  await test("positive: ordinary dedup survives restart", () => assert.deepEqual(dedup.result.stdout, []));
  await test("positive: modeled missing cursor re-emits at identical paths and bytes", () => {
    assert.equal(reemit.result.stdout.length, controls.length);
    const inbox = (s: Stage) => Object.entries(s.snapshot.state).filter(([file]) => file.startsWith("inbox/")).map(([file, value]) => [file, value.base64]);
    assert.deepEqual(inbox(reemit), inbox(captured)); assert.deepEqual(rededup.result.stdout, []);
  });
  await test("positive: overlap floor and seen each suppress delivery", () => {
    assert.deepEqual(quiet.result.stdout, []); assert.equal(cursor(quiet).seen.NEAR, epoch - 60_000);
    assert.equal(cursor(quiet).seen.OLD, undefined);
  });
  await test("positive: removing in-window seen re-emits only NEAR", () => {
    assert.equal(near.result.stdout.length, 1); exact(near, "NEAR", b); assert.equal(copies(near, "OLD").length, 0);
  });
  await test("positive: original source fixtures remain unchanged", () => assert.deepEqual(rededup.snapshot.shared, positiveBefore.shared));
}

if (isChild) await child();
else {
  try {
    if (process.platform === "darwin" || process.platform === "linux") await suite();
    else await test("report sweep continuity: POSIX fixture metadata and directory fsync", {
      skip: `Requires macOS/Linux; ${process.platform} coverage is unmeasured`,
    }, () => {});
  } finally {
    if (requestedOutput === undefined) fs.rmSync(output, { recursive: true, force: true });
  }
}
