// #1167 — Windows exact npm-shim direct launch (CONTRACT-R2 §3/§7), tested through the public
// nodeSpawner()/geminiBinary surface; only T4 (resolution, no spawn) and P* (byte functions) bind
// to win-launch exports.
//
// Groups:
//   O*  oracle self-checks (any OS): the pinned cmd-shim 6.0.3 generator vs the CONTRACT-R2 §2
//       transcription, generator non-refusal of non-inert fields, mutation-set distinctness.
//   T10 [POSIX] spawn identity: exactly one spawn per call, file === argv0 as given, args/cwd/
//       env unchanged, shell false, no verbatim args. Baseline ebfc459 is the control. Registered
//       only on POSIX (#1167 P7: no skip on win32, where T1-T9 cover spawn identity).
//   T1-T9 [win32 native] real CreateProcess via the real spawner; registered only on win32 (#1167
//       P7: POSIX reports no skip for them). On the
//       baseline they are EXPECTED to fail (negative control: .cmd hits ENOENT/EINVAL).
//   T4/T5/T4x [win32] PRINCIPLES P5: a .cmd/.bat that is not an exact shim runs via
//       %SystemRoot%\System32\cmd.exe /d /s /c with strict quoting; a recognised shim never does.
// Honesty: no process.platform mocking and no path.win32 unit test is used as evidence of
// CreateProcess/cmd behaviour. The npm-shim cmd.exe-vs-direct differential (T3) was a disposable
// Windows CI probe (not adopted); its V-B `dp0` env finding is asserted in T2 here. Hostile argv
// (" % ! ^ CR LF) never reaches cmd: it refuses before any spawn.
// Lifecycle: fake children self-exit after FAKE_LIFETIME_MS and write nonce-bound start/exit
// receipts; a started pid without an exit receipt, or a spawned handle without an observed
// 'exit', FAILS. No ps/pgrep, no pid signalling.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { nodeSpawner } from "../../../src/session/boot-adapter/spawner.js";
import { resolveLaunch } from "../../../src/session/boot-adapter/win-launch.js";
import { geminiBinary } from "../../../src/session/boot-adapter/gemini.js";
import {
  FAKE_LIFETIME_MS, HOSTILE, LITERALS, MUTATIONS, SENTINEL, STDIN, contractBytes, fakeCliSource,
  locateGenerator, makeShim, newCase, readReceipts, sha256, unb64, unknownVersionCmd, type FakeReport,
} from "./_win-launch-fixture.js";

const WIN = process.platform === "win32";
const GEN = locateGenerator();
const NO_GEN = "skip" in GEN ? GEN.skip : false;
const RUN_TIMEOUT = FAKE_LIFETIME_MS * 2; // child always self-exits before the harness timer
const ROOT = mkdtempSync(join(tmpdir(), "win-launch (owned) "));

// ---- HARNESS INSTRUMENTATION: ChildProcess.prototype.spawn spy (forwards unchanged) ----
interface Spawned { file: string; args: string[]; cwd: string | undefined; verbatim: unknown; envPairs: string[]; pid: number | undefined; exited: boolean }
function spySpawns<T>(fn: () => Promise<T>): Promise<{ calls: Spawned[]; value?: T; error?: NodeJS.ErrnoException }> {
  const proto = ChildProcess.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = proto["spawn"]!;
  const calls: Spawned[] = [];
  proto["spawn"] = function (this: ChildProcess, ...a: unknown[]) {
    const o = a[0] as { file: string; args: string[]; cwd?: string; windowsVerbatimArguments?: unknown; envPairs?: string[] };
    const rec: Spawned = { file: o.file, args: [...o.args], cwd: o.cwd, verbatim: o.windowsVerbatimArguments,
      envPairs: [...(o.envPairs ?? [])], pid: undefined, exited: false };
    calls.push(rec);
    const r = orig.apply(this, a);
    rec.pid = this.pid;
    this.once("exit", () => { rec.exited = true; });
    return r;
  };
  const restore = () => { proto["spawn"] = orig; };
  return fn().then((value) => { restore(); return { calls, value }; },
    (error: NodeJS.ErrnoException) => { restore(); return { calls, error }; });
}

// Controlled env for the spawner's process.env merge (restored after each case).
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); }
  finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
}

// Every started fake must have an exit receipt; every spawned handle an observed exit.
// expectStarts null: the payload count is the script's own business (cmd.exe cases); cleanup is still proven.
async function assertCleanup(t: TestContext, dir: string, nonce: string, calls: Spawned[], expectStarts: number | null): Promise<void> {
  const until = Date.now() + 1_000;
  let r = readReceipts(dir, nonce);
  while ([...r.values()].some((e) => e.start && !e.exit) && Date.now() < until) {
    await new Promise((res) => setTimeout(res, 25));
    r = readReceipts(dir, nonce);
  }
  t.diagnostic(`receipts=${JSON.stringify([...r.entries()])}`);
  if (expectStarts !== null) assert.equal([...r.values()].filter((e) => e.start).length, expectStarts, "payload start count");
  for (const [pid, e] of r) assert.ok(e.start && e.exit, `cleanup unknown for pid ${pid}: missing ${e.start ? "exit" : "start"} receipt`);
  for (const c of calls) if (c.pid !== undefined) assert.ok(c.exited, `owned handle pid ${c.pid} exit not observed`);
}

const parseReport = (stdout: string) => JSON.parse(stdout) as FakeReport;

// =============================== O: oracle self-checks ===============================
test("O1 generator identity: pinned cmd-shim 6.0.3 located and hash-verified", { skip: NO_GEN }, (t) => {
  assert.ok("gen" in GEN);
  t.diagnostic(`generator=${GEN.dir}`);
});

test("O2 contract §2 transcription == generator bytes for V-A (A empty / A set) and V-B", { skip: NO_GEN }, async () => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "o2").dir;
  const a0 = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "va", { shebang: "#!/usr/bin/env node", targetName: "va" });
  assert.equal(a0.cmd, contractBytes("V-A", a0.T, "node", ""));
  assert.match(a0.cmd, /"%_prog%"  "%dp0%\\/, "A empty leaves a double blank (spacing is part of the exact bytes)");
  const a1 = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "va1", { shebang: "#!/usr/bin/env node --no-warnings", targetName: "va1" });
  assert.equal(a1.cmd, contractBytes("V-A", a1.T, "node", "--no-warnings"));
  const b = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "vb", { shebang: null, targetName: "vb.exe", body: "MZ-not-executed" });
  assert.equal(b.cmd, contractBytes("V-B", b.T));
  assert.equal(a0.T, "..\\pkg\\va");
});

test("O3 V-V (env -S K=V) generator bytes differ from V-A and carry @SET", { skip: NO_GEN }, async () => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "o3").dir;
  const vv = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "vv", { shebang: "#!/usr/bin/env -S FOO=bar node", targetName: "vv" });
  assert.ok(vv.cmd.includes("CALL :find_dp0\r\n@SET FOO=bar\r\n\r\nIF EXIST"));
  assert.notEqual(vv.cmd, contractBytes("V-A", vv.T, "node", ""));
});

test("O4 generator emits non-inert fields unrefused (recognition must enforce inertness)", { skip: NO_GEN }, async () => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "o4").dir;
  const pct = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "pct", { shebang: "#!/usr/bin/env node", targetName: "a%b" });
  assert.ok(pct.cmd.includes('"%dp0%\\..\\pkg\\a%b" %*'));
  const amp = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "amp", { shebang: "#!/usr/bin/env node", targetName: "a&b" });
  assert.ok(amp.cmd.includes("a&b"));
  const abs = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "abs", { shebang: "#!/usr/local/bin/node", targetName: "abs" });
  assert.ok(abs.cmd.includes('IF EXIST "%dp0%\\/usr/local/bin/node.exe"'), "non-bare P is emitted verbatim");
});

test("O5 negative mutation set: every mutation changes the bytes and all are distinct", { skip: NO_GEN }, async () => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "o5").dir;
  const v = (await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "m", { shebang: "#!/usr/bin/env node", targetName: "m" })).cmd;
  const seen = new Set([v, unknownVersionCmd("..\\pkg\\m")]);
  for (const m of MUTATIONS) { const x = m.apply(v); assert.notEqual(x, v, m.id); assert.ok(!seen.has(x), `${m.id} duplicate`); seen.add(x); }
});

// ============================ T10: POSIX identity control ============================
if (!WIN) test("T10 [POSIX] run(): one spawn, argv0/args/cwd/env as given, shell false, literals byte-exact", async (t) => {
  const { dir, nonce } = newCase(ROOT, "t10");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "fake-cli"), fakeCliSource(`#!${process.execPath}`), { mode: 0o755 });
  const env = { PATH: join(dir, "bin"), FAKE_DIR: dir, FAKE_NONCE: nonce, FAKE_ENV_PROBE: "%PATH%!x!" };
  const argv = ["fake-cli", ...LITERALS];
  const { calls, value, error } = await spySpawns(() => nodeSpawner().run({ argv, env, cwd: dir, prompt_file: "", expected_digest: "" }, STDIN, RUN_TIMEOUT));
  assert.equal(error, undefined, String(error));
  assert.equal(calls.length, 1, "exactly one spawn (no lookup helper process)");
  const c = calls[0]!;
  assert.equal(c.file, "fake-cli", "bare argv0 passed through unresolved");
  assert.deepEqual(c.args, argv);
  assert.equal(c.cwd, dir);
  assert.equal(c.verbatim, false);
  for (const [k, v] of Object.entries(env)) assert.ok(c.envPairs.includes(`${k}=${v}`), `env ${k} merged`);
  const rep = parseReport(value!.stdout);
  assert.deepEqual(rep.args.map(unb64), [...LITERALS]);
  assert.equal(rep.stdin?.sha256, sha256(Buffer.from(STDIN)));
  assert.equal(existsSync(join(dir, SENTINEL)), false);
  await assertCleanup(t, dir, nonce, calls, 1);
});

if (!WIN) test("T10 [POSIX] probeVersion(): one spawn [exe, --version]; missing exe → CLI_NOT_FOUND", async (t) => {
  const { dir, nonce } = newCase(ROOT, "t10v");
  const exe = join(dir, "fake-cli");
  writeFileSync(exe, fakeCliSource(`#!${process.execPath}`), { mode: 0o755 });
  const got = await withEnv({ ...process.env as Record<string, string>, FAKE_DIR: dir, FAKE_NONCE: nonce },
    () => spySpawns(() => nodeSpawner().probeVersion(exe)));
  assert.equal(got.value, "1.2.3");
  assert.equal(got.calls.length, 1);
  assert.equal(got.calls[0]!.file, exe);
  assert.deepEqual(got.calls[0]!.args, [exe, "--version"]);
  await assertCleanup(t, dir, nonce, got.calls, 1);
  const miss = await spySpawns(() => nodeSpawner().probeVersion(join(dir, "absent-cli")));
  assert.equal(miss.error?.message, "CLI_NOT_FOUND");
});

if (!WIN) test("T10 [POSIX] run() missing bare exe keeps the real ENOENT", async () => {
  const { dir } = newCase(ROOT, "t10e");
  const r = await spySpawns(() => nodeSpawner().run({ argv: ["absent-cli-1167"], env: { PATH: dir }, cwd: dir, prompt_file: "", expected_digest: "" }, undefined, RUN_TIMEOUT));
  assert.equal(r.error?.code, "ENOENT");
});

if (!WIN) test("T10 [POSIX] geminiBinary(): PATH X_OK agy → agy, else gemini (unchanged)", () => {
  const { dir } = newCase(ROOT, "t10g");
  assert.equal(geminiBinary({ PATH: dir }), "gemini");
  writeFileSync(join(dir, "agy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(geminiBinary({ PATH: dir }), "agy");
  assert.equal(geminiBinary({ PATH: dir, AIGENTRY_GEMINI_BINARY: "gemini" }), "gemini");
});

// ============================== T1-T9: win32 native ==============================
const SYS = process.env["SystemRoot"] ?? "C:\\Windows";
const NODE_DIR = dirname(process.execPath);
function winEnv(pathKey: "PATH" | "Path", dirs: string[], dir: string, nonce: string, extra: Record<string, string> = {}): Record<string, string> {
  return { SystemRoot: SYS, WINDIR: SYS, ComSpec: join(SYS, "System32", "cmd.exe"), TEMP: dir, TMP: dir,
    [pathKey]: [...dirs, NODE_DIR, join(SYS, "System32"), SYS].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
    FAKE_DIR: dir, FAKE_NONCE: nonce, PROBE_EXPANSION: "expanded-must-not-replace-literal", ...extra };
}
const run = (argv: string[], cwd: string, stdin: string | undefined = STDIN) =>
  spySpawns(() => nodeSpawner().run({ argv, env: {}, cwd, prompt_file: "", expected_digest: "" }, stdin, RUN_TIMEOUT));
const assertNoShell = (c: Spawned) => {
  assert.doesNotMatch(c.file, /(^|[\\/])(cmd|powershell|pwsh)(\.exe)?$/i, "T1: never cmd/powershell");
  assert.notEqual(c.file.toLowerCase(), join(SYS, "System32", "cmd.exe").toLowerCase());
  assert.equal(c.verbatim, false, "T1: no windowsVerbatimArguments");
};

async function layout(label: string): Promise<{ local: { bin: string; T: string }; prefix: { bin: string; T: string } }> {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, label).dir;
  const loc = join(base, "local", "node_modules");
  const l = await makeShim(GEN.gen, join(loc, "fake"), join(loc, ".bin"), "fake", { shebang: "#!/usr/bin/env node", targetName: "cli" });
  const pre = join(base, "prefix");
  const p = await makeShim(GEN.gen, join(pre, "node_modules", "fake"), pre, "fake", { shebang: "#!/usr/bin/env node", targetName: "cli" });
  return { local: { bin: join(loc, ".bin"), T: l.T }, prefix: { bin: pre, T: p.T } };
}

for (const where of ["local", "prefix"] as const) for (const spelling of ["bare", "abs"] as const) for (const key of ["PATH", "Path"] as const) {
  if (WIN) test(`T1+T2 [win32] V-A ${where}/${spelling}/${key}: direct node, literals byte-exact, no sentinel, stdin hash`, { skip: NO_GEN }, async (t) => {
    const lay = (await layout(`t2-${where}-${spelling}-${key}`))[where];
    const { dir, nonce } = newCase(ROOT, "case");
    const exe = spelling === "bare" ? "fake" : join(lay.bin, "fake.cmd");
    const r = await withEnv(winEnv(key, [lay.bin], dir, nonce), () => run([exe, ...LITERALS], dir));
    t.diagnostic(`spawn=${JSON.stringify(r.calls.map((c) => ({ file: c.file, a: c.args.slice(0, 2) })))} error=${String(r.error?.code)}`);
    assert.equal(r.error, undefined, `run rejected: ${String(r.error?.code)} ${String(r.error?.message)}`);
    assert.equal(r.calls.length, 1);
    const c = r.calls[0]!;
    assertNoShell(c);
    assert.equal(c.file.toLowerCase(), join(NODE_DIR, "node.exe").toLowerCase(), "P=node via PATH lookup (no dp0\\node.exe)");
    assert.equal(c.args[1], `${lay.bin}\\\\${lay.T}`, "T spelled dp0+\"\\\"+T (dp0 has trailing \\)");
    assert.deepEqual(c.args.slice(2), [...LITERALS]);
    const rep = parseReport(r.value!.stdout);
    assert.deepEqual(rep.args.map(unb64), [...LITERALS], "argv byte-exact at the payload");
    for (const h of HOSTILE) assert.ok(rep.args.map(unb64).includes(h), `hostile arg reached payload: ${JSON.stringify(h)}`);
    assert.equal(existsSync(join(dir, SENTINEL)), false, "no injection sentinel");
    assert.equal(rep.stdin?.sha256, sha256(Buffer.from(STDIN)), "T9 stdin hash");
    assert.equal(rep.env["dp0"], null, "V-A: endLocal runs before the launch, so the child never sees dp0");
    assert.equal(r.value!.exit_code, 0);
    await assertCleanup(t, dir, nonce, r.calls, 1);
  });
}

if (WIN) test("T2 [win32] native .exe hit launched as-is; V-B native target via dp0+\\+T", { skip: NO_GEN }, async (t) => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "t2x").dir;
  const script = join(base, "fake-cli.cjs");
  writeFileSync(script, fakeCliSource(null));
  mkdirSync(join(base, "native"));
  // Entry spelled ".ExE" while PATHEXT spells ".EXE": the source-built name and the on-disk name differ only in case.
  copyFileSync(process.execPath, join(base, "native", "FaKeExe.ExE"));
  const vb = await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin"), "fakevb", { shebang: null, targetName: "fakevb.exe", body: "" });
  copyFileSync(process.execPath, join(base, "pkg", "fakevb.exe"));
  // dp0: V-B has no endLocal before its launch, so via cmd the child inherits the shim's `SET dp0=%~dp0` (D2).
  for (const [exe, bin, file, entryDir, dp0] of [["fakeexe", join(base, "native"), join(base, "native", "FaKeExe.ExE"), join(base, "native"), null],
    ["fakevb", join(base, "bin"), `${join(base, "bin")}\\\\${vb.T}`, join(base, "pkg"), `${join(base, "bin")}\\`]] as const) {
    const { dir, nonce } = newCase(ROOT, exe);
    const r = await withEnv(winEnv("Path", [bin], dir, nonce), () => run([exe, script, ...LITERALS], dir));
    assert.equal(r.error, undefined, String(r.error?.code));
    assert.equal(r.calls.length, 1);
    assertNoShell(r.calls[0]!);
    assert.equal(r.calls[0]!.file.toLowerCase(), file.toLowerCase());
    // Final component as the directory actually spells it (read back, not assumed), at spawn and in the payload's execPath.
    const entry = readdirSync(entryDir).find((e) => e.toLowerCase() === basename(file).toLowerCase());
    t.diagnostic(`${exe}: on-disk entry=${String(entry)} spawn=${r.calls[0]!.file} execPath=${unb64(parseReport(r.value!.stdout).execPath)}`);
    assert.equal(basename(r.calls[0]!.file), entry, "spawn file final component == on-disk entry");
    assert.equal(basename(unb64(parseReport(r.value!.stdout).execPath)), entry, "payload execPath final component == on-disk entry");
    assert.deepEqual(parseReport(r.value!.stdout).args.map(unb64), [...LITERALS]);
    const gotDp0 = parseReport(r.value!.stdout).env["dp0"];
    assert.equal(gotDp0 === null || gotDp0 === undefined ? null : unb64(gotDp0).toLowerCase(), dp0 === null ? null : dp0.toLowerCase(), `${exe}: child dp0`);
    assert.equal(existsSync(join(dir, SENTINEL)), false);
    await assertCleanup(t, dir, nonce, r.calls, 1);
  }
});

// T4/T5/T7: refusal must happen before any payload spawn: CLI_LAUNCH_UNSUPPORTED, zero spawns, zero receipts.
async function assertRefused(t: TestContext, dirs: string[], exe: string): Promise<void> {
  const { dir, nonce } = newCase(ROOT, "refuse");
  const r = await withEnv(winEnv("Path", dirs, dir, nonce), () => run([exe, "--version"], dir));
  t.diagnostic(`${exe}: error=${String(r.error?.code)} spawns=${r.calls.length}`);
  assert.equal(r.error?.code, "CLI_LAUNCH_UNSUPPORTED");
  assert.equal(r.calls.length, 0, "no spawn before refusal");
  await assertCleanup(t, dir, nonce, r.calls, 0);
}

// P5: a non-shim .cmd/.bat hit is launched by cmd.exe, as one strict-quoted /d /s /c line.
const CMD_EXE = join(SYS, "System32", "cmd.exe");
const cmdLine = (file: string, args: string[]) => `"${[file, ...args].map((a) => `"${a}"`).join(" ")}"`;

// T4 resolution only (no CreateProcess: some generator variants would hand a .js target to WSH under cmd):
// recognition fails, so the launch is cmd.exe on that hit, never the direct node path.
if (WIN) test("T4 [win32] mutations, V-V, unknown version, non-inert fields → not a shim: cmd.exe /d /s /c on the hit", { skip: NO_GEN }, async (t) => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "t4").dir;
  const pkg = join(base, "pkg");
  const valid = await makeShim(GEN.gen, pkg, join(base, "valid"), "neg", { shebang: "#!/usr/bin/env node", targetName: "cli" });
  const variants: Array<[string, string]> = MUTATIONS.map((m) => [m.id, m.apply(valid.cmd)]);
  variants.push(["unknown-version", unknownVersionCmd(valid.T)]);
  for (const [id, sb, tn] of [["vv", "#!/usr/bin/env -S FOO=bar node", "vv"], ["non-bare-P", "#!/usr/local/bin/node", "nb"],
    ["A-dollar", "#!/usr/bin/env node --title=$HOME", "ad"], ["T-percent", "#!/usr/bin/env node", "a%b"],
    ["T-amp", "#!/usr/bin/env node", "a&b"], ["VB-non-exe", null, "vbjs.js"]] as const) {
    const gdir = join(base, `gen-${id}`);
    variants.push([id, (await makeShim(GEN.gen, pkg, gdir, "neg", { shebang: sb, targetName: tn })).cmd]);
  }
  for (const [id, bytes] of variants) {
    const d = join(base, `v-${id}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "neg.cmd"), bytes, "latin1");
    await t.test(id, () => {
      const { dir, nonce } = newCase(ROOT, "t4r");
      const l = resolveLaunch("neg", ["--version"], winEnv("Path", [d], dir, nonce), dir);
      assert.equal(l.file.toLowerCase(), CMD_EXE.toLowerCase());
      assert.deepEqual(l.args, ["/d", "/s", "/c", cmdLine(join(d, "neg.cmd"), ["--version"])]);
      assert.equal(l.cmd, true);
    });
  }
});

// Real CreateProcess: the first hit runs through cmd.exe; the later valid shim is never used.
async function assertViaCmd(t: TestContext, dirs: string[], exe: string, hit: string): Promise<void> {
  const { dir, nonce } = newCase(ROOT, "viacmd");
  const r = await withEnv(winEnv("Path", dirs, dir, nonce), () => run([exe, "--version"], dir));
  t.diagnostic(`${exe}: error=${String(r.error?.code)} spawns=${JSON.stringify(r.calls.map((c) => c.file))}`);
  assert.equal(r.error, undefined, String(r.error?.code));
  assert.equal(r.calls.length, 1, "one spawn: cmd.exe only");
  assert.equal(r.calls[0]!.file.toLowerCase(), CMD_EXE.toLowerCase());
  assert.deepEqual(r.calls[0]!.args.slice(1), ["/d", "/s", "/c", cmdLine(hit, ["--version"])]);
  assert.equal(r.calls[0]!.verbatim, true);
  await assertCleanup(t, dir, nonce, r.calls, null);
}

if (WIN) test("T5 [win32] earlier .bat / bad .cmd hit → cmd.exe on that hit, never skip to the later valid shim", { skip: NO_GEN }, async (t) => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "t5").dir;
  const good = await makeShim(GEN.gen, join(base, "pkg"), join(base, "good"), "first", { shebang: "#!/usr/bin/env node", targetName: "cli" });
  mkdirSync(join(base, "bat"));
  writeFileSync(join(base, "bat", "first.bat"), good.cmd, "latin1");
  mkdirSync(join(base, "bad"));
  writeFileSync(join(base, "bad", "first.cmd"), MUTATIONS.find((m) => m.id === "lf-only")!.apply(good.cmd), "latin1");
  await t.test("bat-first", (tt) => assertViaCmd(tt, [join(base, "bat"), join(base, "good")], "first", join(base, "bat", "first.bat")));
  await t.test("bad-cmd-first", (tt) => assertViaCmd(tt, [join(base, "bad"), join(base, "good")], "first", join(base, "bad", "first.cmd")));
});

if (WIN) test("T4x [win32] plain .cmd via cmd.exe: quoted literals byte-exact at the payload; \" % ! ^ CR LF NUL refuse before spawn", async (t) => {
  const base = newCase(ROOT, "t4x").dir;
  const script = join(base, "fake-cli.cjs");
  writeFileSync(script, fakeCliSource(null));
  mkdirSync(join(base, "bin"));
  const hit = join(base, "bin", "plain.cmd");
  writeFileSync(hit, `@ECHO off\r\n"${process.execPath}" "${script}" %*\r\n`, "latin1");
  const safe = LITERALS.filter((a) => !/["%!^\r\n]/.test(a));
  const { dir, nonce } = newCase(ROOT, "t4x-run");
  const r = await withEnv(winEnv("Path", [join(base, "bin")], dir, nonce), () => run(["plain", ...safe], dir));
  t.diagnostic(`spawn=${JSON.stringify(r.calls.map((c) => ({ file: c.file, a: c.args.slice(1, 4) })))} error=${String(r.error?.code)}`);
  assert.equal(r.error, undefined, `run rejected: ${String(r.error?.code)} ${String(r.error?.message)}`);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]!.file.toLowerCase(), CMD_EXE.toLowerCase());
  assert.deepEqual(r.calls[0]!.args.slice(1, 4), ["/d", "/s", "/c"]);
  assert.equal(r.calls[0]!.verbatim, true);
  const rep = parseReport(r.value!.stdout);
  assert.deepEqual(rep.args.map(unb64), safe, "argv byte-exact at the payload (trailing backslashes included)");
  assert.equal(rep.stdin?.sha256, sha256(Buffer.from(STDIN)), "stdin reaches the payload through cmd");
  assert.equal(existsSync(join(dir, SENTINEL)), false, "no injection sentinel");
  assert.equal(r.value!.exit_code, 0);
  await assertCleanup(t, dir, nonce, r.calls, 1);
  for (const bad of ['a"b', "%PATH%", "!PROBE_EXPANSION!", "^", "a\rb", "line1\nline2", "nul\0"]) {
    await t.test(JSON.stringify(bad), async (tt) => {
      const c = newCase(ROOT, "t4x-refuse");
      const x = await withEnv(winEnv("Path", [join(base, "bin")], c.dir, c.nonce), () => run(["plain", "ok", bad], c.dir));
      assert.equal(x.error?.code, "CLI_LAUNCH_UNSUPPORTED");
      assert.equal(x.calls.length, 0, "no spawn before refusal");
      await assertCleanup(tt, c.dir, c.nonce, x.calls, 0);
    });
  }
});

if (WIN) test("T6 [win32] dp0\\node.exe present → that interpreter; node→node.cmd → refuse", { skip: NO_GEN }, async (t) => {
  const lay = (await layout("t6")).local;
  copyFileSync(process.execPath, join(lay.bin, "node.exe"));
  const { dir, nonce } = newCase(ROOT, "t6a");
  const r = await withEnv(winEnv("PATH", [lay.bin], dir, nonce), () => run(["fake", "x y"], dir));
  assert.equal(r.error, undefined, String(r.error?.code));
  assert.equal(r.calls.length, 1);
  assertNoShell(r.calls[0]!);
  assert.equal(unb64(parseReport(r.value!.stdout).execPath).toLowerCase(), join(lay.bin, "node.exe").toLowerCase());
  await assertCleanup(t, dir, nonce, r.calls, 1);
  const lay2 = (await layout("t6b")).local;
  const shadow = newCase(ROOT, "nodecmd").dir;
  writeFileSync(join(shadow, "node.cmd"), "@ECHO off\r\nexit /b 3\r\n", "latin1");
  await t.test("node-resolves-to-cmd", (tt) => assertRefused(tt, [lay2.bin, shadow], "fake"));
});

if (WIN) test("T7 [win32] shim dir containing & → refuse", { skip: NO_GEN }, async (t) => {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, "t7").dir;
  await makeShim(GEN.gen, join(base, "pkg"), join(base, "bin&x"), "amp", { shebang: "#!/usr/bin/env node", targetName: "cli" });
  await assertRefused(t, [join(base, "bin&x")], "amp");
});

if (WIN) test("T8 [win32] >32767 command line → OS spawn error, no payload; 30000 control byte-exact", { skip: NO_GEN }, async (t) => {
  const lay = (await layout("t8")).local;
  for (const [n, ok] of [[30_000, true], [40_000, false]] as const) {
    const { dir, nonce } = newCase(ROOT, `t8-${n}`);
    const big = "a".repeat(n);
    const r = await withEnv(winEnv("PATH", [lay.bin], dir, nonce), () => run(["fake", big], dir));
    t.diagnostic(`${n}: error=${String(r.error?.code)} spawns=${r.calls.length}`);
    if (ok) {
      assert.equal(r.error, undefined, String(r.error?.code));
      assert.equal(sha256(unb64(parseReport(r.value!.stdout).args[0]!)), sha256(big), "no truncation");
      await assertCleanup(t, dir, nonce, r.calls, 1);
    } else {
      assert.ok(r.error, "must reject");
      assert.notEqual(r.error.code, "CLI_LAUNCH_UNSUPPORTED", "OS error surfaced, not a policy refusal");
      assert.equal(typeof r.error.code, "string");
      await assertCleanup(t, dir, nonce, r.calls, 0);
    }
  }
});

if (WIN) test("T9 [win32] non-reading child with 8 MiB stdin → no crash, no delivery claim", { skip: NO_GEN }, async (t) => {
  const lay = (await layout("t9")).local;
  const { dir, nonce } = newCase(ROOT, "t9");
  const r = await withEnv(winEnv("PATH", [lay.bin], dir, nonce, { FAKE_MODE: "noread" }), () => run(["fake"], dir, "z".repeat(8 << 20)));
  t.diagnostic(`outcome=${r.error ? `rejected ${String(r.error.code)}` : `resolved exit=${r.value!.exit_code}`}`);
  // EOF: the closed-reader code this win32-only case actually produced on Windows CI 37214231848 (`rejected EOF`).
  if (r.error) assert.ok(["EPIPE", "ECONNRESET", "EOF"].includes(String(r.error.code)), String(r.error.code));
  else assert.equal(parseReport(r.value!.stdout).stdin, null);
  await assertCleanup(t, dir, nonce, r.calls, 1);
});

if (WIN) test("T-miss [win32] missing bare name keeps ENOENT (not CLI_LAUNCH_UNSUPPORTED)", { skip: NO_GEN }, async () => {
  const { dir, nonce } = newCase(ROOT, "miss");
  const r = await withEnv(winEnv("PATH", [dir], dir, nonce), () => run(["absent-cli-1167"], dir));
  assert.equal(r.error?.code, "ENOENT");
});

// ======== P: candidate-r1 pure recognition (any OS; byte functions only, no CreateProcess claim) ========
// Binds to the candidate-r1 exports parseCmdShim(Buffer) / generateCmdShim(CmdShim). The expected
// bytes always come from the pinned upstream generator (the oracle), never from generateCmdShim.
interface Shim { form: "V-A" | "V-B"; prog: string; args: string; target: string }
interface WinLaunchMod { parseCmdShim(b: Buffer): Shim | null; generateCmdShim(s: Shim): string;
  onDiskSpelling?(dir: string, name: string, list: (d: string) => readonly string[]): string;
  parentSpelling?(dir: string, list: (d: string) => readonly string[]): string }
const WL_URL = new URL("../../../src/session/boot-adapter/win-launch.js", import.meta.url);
const WL: WinLaunchMod | null = existsSync(WL_URL) ? (await import(WL_URL.href)) as WinLaunchMod : null;
const NO_WL = WL ? NO_GEN : "candidate win-launch.js absent in this tree (baseline)";

const ACCEPT: ReadonlyArray<{ id: string; shebang: string | null; targetName: string; pkg?: string; shim?: string; expect: Omit<Shim, "target"> }> = [
  { id: "VA", shebang: "#!/usr/bin/env node", targetName: "cli", expect: { form: "V-A", prog: "node", args: "" } },
  { id: "VA-args", shebang: "#!/usr/bin/env node --no-warnings --max-old-space-size=64", targetName: "cli",
    expect: { form: "V-A", prog: "node", args: "--no-warnings --max-old-space-size=64" } },
  { id: "VA-env-S-novars", shebang: "#!/usr/bin/env -S node --x", targetName: "cli", expect: { form: "V-A", prog: "node", args: "--x" } },
  { id: "VA-space-dir", shebang: "#!/usr/bin/env node", targetName: "cli", pkg: "my pkg", expect: { form: "V-A", prog: "node", args: "" } },
  { id: "VA-global-prefix", shebang: "#!/usr/bin/env node", targetName: "cli", pkg: "node_modules/fake", shim: ".", expect: { form: "V-A", prog: "node", args: "" } },
  { id: "VB-exe", shebang: null, targetName: "fake.exe", expect: { form: "V-B", prog: "", args: "" } },
  { id: "VB-com", shebang: null, targetName: "fake.com", expect: { form: "V-B", prog: "", args: "" } },
];
async function oracleCase(id: string, shebang: string | null, targetName: string, pkg = "pkg", shim = "bin"): Promise<{ bytes: Buffer; T: string }> {
  assert.ok("gen" in GEN);
  const base = newCase(ROOT, `p-${id}`).dir;
  const body = shebang === null ? "MZ-not-executed" : fakeCliSource(shebang);
  const r = await makeShim(GEN.gen, join(base, pkg), join(base, shim), "fake", { shebang, targetName, body });
  return { bytes: Buffer.from(r.cmd, "latin1"), T: r.T };
}

test("P1 parseCmdShim accepts oracle V-A/V-B bytes with the authored fields", { skip: NO_WL }, async (t) => {
  for (const c of ACCEPT) {
    const o = await oracleCase(c.id, c.shebang, c.targetName, c.pkg, c.shim);
    const got = WL!.parseCmdShim(o.bytes);
    t.diagnostic(`${c.id}: T=${o.T} got=${JSON.stringify(got)}`);
    assert.deepEqual(got, { ...c.expect, target: o.T }, c.id);
  }
});

test("P2 parseCmdShim rejects mutations, V-V, unknown version, non-inert/unsupported fields", { skip: NO_WL }, async (t) => {
  const valid = await oracleCase("valid", "#!/usr/bin/env node", "cli");
  const rejects: Array<[string, Buffer]> = MUTATIONS.map((m) => [m.id, Buffer.from(m.apply(valid.bytes.toString("latin1")), "latin1")]);
  rejects.push(["unknown-version", Buffer.from(unknownVersionCmd(valid.T), "latin1")], ["empty", Buffer.alloc(0)],
    ["header-only", valid.bytes.subarray(0, valid.bytes.indexOf("CALL :find_dp0\r\n") + 16)]);
  for (const [id, sb, tn] of [["V-V", "#!/usr/bin/env -S FOO=bar node", "vv"], ["non-bare-P", "#!/usr/local/bin/node", "nb"],
    ["P-bang", "#!/usr/bin/env no!de", "pb"], ["A-dollar", "#!/usr/bin/env node --title=$HOME", "ad"], ["A-quote", '#!/usr/bin/env node "x"', "aq"],
    ["T-percent", "#!/usr/bin/env node", "a%b"], ["T-amp", "#!/usr/bin/env node", "a&b"], ["T-bang", "#!/usr/bin/env node", "a!b"],
    ["T-caret", "#!/usr/bin/env node", "a^b"], ["VB-js", null, "vb.js"], ["VB-noext", null, "vbbin"],
    ["T-non-ascii(prototype-limitation)", "#!/usr/bin/env node", "한글"]] as const) {
    rejects.push([id, (await oracleCase(id.replace(/\W/g, ""), sb, tn)).bytes]);
  }
  for (const [id, b] of rejects) { t.diagnostic(`${id}: ${JSON.stringify(WL!.parseCmdShim(b))}`); assert.equal(WL!.parseCmdShim(b), null, id); }
});

test("P3 candidate generateCmdShim(fields) == pinned upstream generator bytes (product vs oracle)", { skip: NO_WL }, async () => {
  for (const c of ACCEPT) {
    const o = await oracleCase(`g-${c.id}`, c.shebang, c.targetName, c.pkg, c.shim);
    assert.equal(WL!.generateCmdShim({ ...c.expect, target: o.T }), o.bytes.toString("latin1"), c.id);
  }
});

test("P4 resource characterization: parseCmdShim has no input size bound (record only)", { skip: NO_WL }, (t) => {
  const head = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
  for (const [id, b] of [["64MiB-flat", Buffer.concat([Buffer.from(head + '\r\nIF EXIST "%dp0%\\node.exe" (\r\n', "latin1"), Buffer.alloc(64 << 20, 0x78)])],
    ["4MiB-crlf-dense", Buffer.concat([Buffer.from(head + '\r\nIF EXIST "%dp0%\\node.exe" (\r\n', "latin1"), Buffer.from("\r\n".repeat(2 << 20), "latin1")])]] as const) {
    const h0 = process.memoryUsage().heapUsed, t0 = performance.now();
    const r = WL!.parseCmdShim(b);
    t.diagnostic(`${id}: bytes=${b.length} ms=${(performance.now() - t0).toFixed(1)} heapDeltaMiB=${((process.memoryUsage().heapUsed - h0) / 2 ** 20).toFixed(1)}`);
    assert.equal(r, null);
  }
});

// Final-component spelling after a confirmed hit, with an injected directory listing (pure; no CreateProcess or
// filesystem claim). Expected spellings are the literal entries authored here. A missing export fails (the r1
// source has none), so this case discriminates the source before/after the fix.
test("P5 onDiskSpelling: exact entry, else unique case-insensitive entry, else the confirmed hit unchanged (ambiguous/none/readdir refused)", { skip: NO_WL }, async (t) => {
  const spell = WL!.onDiskSpelling;
  assert.equal(typeof spell, "function", "onDiskSpelling export");
  const dir = "D:\\a\\Owned Dir\\PROGRA~1\\bin"; // parent spelling incl. an 8.3-looking segment must survive verbatim
  const seen: string[] = [];
  const ls = (entries: string[]) => (d: string) => { seen.push(d); return entries; };
  const cases: Array<[string, string, (d: string) => readonly string[], string]> = [
    ["exact-first", "node.EXE", ls(["node.exe", "node.EXE"]), `${dir}\\node.EXE`],
    ["unique-casefold", "node.EXE", ls(["README", "node.exe", "npm.cmd"]), `${dir}\\node.exe`],
    ["mixed-case", "mixed.EXE", ls(["MiXeD.ExE"]), `${dir}\\MiXeD.ExE`],
    ["ambiguous-keeps-hit", "node.EXE", ls(["node.exe", "NODE.exe"]), `${dir}\\node.EXE`],
    ["no-entry-keeps-hit", "node.EXE", ls(["NODE~1.EXE"]), `${dir}\\node.EXE`],
    ["readdir-refused-keeps-hit", "node.EXE", (d) => { seen.push(d); throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, `${dir}\\node.EXE`],
  ];
  for (const [id, name, list, want] of cases) assert.equal(spell!(dir, name, list), want, id);
  assert.deepEqual(seen, cases.map(() => dir), "only the hit's own directory is listed (never a later PATH entry)");

  // .cmd dp0 parents (Windows CI 37228963220: %dp0% re-spells every non-root parent, keeps the typed drive). Listings
  // are keyed by the exact corrected prefix, so listing under any other spelling fails (pure; no filesystem claim).
  const parents = WL!.parentSpelling;
  await t.test("parentSpelling export", () => assert.equal(typeof parents, "function"));
  const tree = (m: Record<string, string[]>, at: string[]) => (d: string): readonly string[] => {
    at.push(d);
    const e = m[d];
    if (e === undefined) throw Object.assign(new Error(`EPERM ${d}`), { code: "EPERM" });
    return e;
  };
  const pcases: Array<[string, string, Record<string, string[]>, string, string[]]> = [
    ["fixed-mixed-parents-typed-drive", "d:\\x\\long mixed abc dir\\spbn\\spbin",
      { "d:\\": ["X"], "d:\\X": ["Long Mixed AbC dir"], "d:\\X\\Long Mixed AbC dir": ["SpBn"], "d:\\X\\Long Mixed AbC dir\\SpBn": ["spbin"] },
      "d:\\X\\Long Mixed AbC dir\\SpBn\\spbin", ["d:\\", "d:\\X", "d:\\X\\Long Mixed AbC dir", "d:\\X\\Long Mixed AbC dir\\SpBn"]],
    ["exact-entry-wins", "D:\\spbn\\bin", { "D:\\": ["SpBn", "spbn"], "D:\\spbn": ["bin"] }, "D:\\spbn\\bin", ["D:\\", "D:\\spbn"]],
    ["unique-casefold", "D:\\SPBN\\BIN", { "D:\\": ["README", "SpBn"], "D:\\SpBn": ["bin"] }, "D:\\SpBn\\bin", ["D:\\", "D:\\SpBn"]],
    ["ambiguous-middle-keeps-continues", "D:\\a\\spbn\\BIN", { "D:\\": ["A"], "D:\\A": ["SpBn", "SPBN"], "D:\\A\\spbn": ["bin"] },
      "D:\\A\\spbn\\bin", ["D:\\", "D:\\A", "D:\\A\\spbn"]],
    ["missing-middle-keeps-continues", "D:\\a\\spbn\\BIN", { "D:\\": ["A"], "D:\\A": ["other"], "D:\\A\\spbn": ["bin"] },
      "D:\\A\\spbn\\bin", ["D:\\", "D:\\A", "D:\\A\\spbn"]],
    ["readthrow-middle-keeps-rest-stops", "D:\\a\\spbn\\BIN", { "D:\\": ["A"] }, "D:\\A\\spbn\\BIN", ["D:\\", "D:\\A"]],
    ["no-8.3-expansion", "D:\\PROGRA~1\\bin", { "D:\\": ["Program Files"], "D:\\PROGRA~1": ["Bin"] }, "D:\\PROGRA~1\\Bin", ["D:\\", "D:\\PROGRA~1"]],
    ["junction-name-kept-no-realpath", "D:\\link\\bin", { "D:\\": ["Link", "Target"], "D:\\Link": ["bin"] }, "D:\\Link\\bin", ["D:\\", "D:\\Link"]],
    ["root-only-unlisted", "d:\\", {}, "d:\\", []],
  ];
  for (const [id, pdir, m, want, wantSeen] of pcases) {
    await t.test(id, () => {
      const at: string[] = [];
      assert.equal(parents!(pdir, tree(m, at)), want, id);
      assert.deepEqual(at, wantSeen, `${id}: listed prefixes`);
    });
  }
});

if (WIN) test("T-gem [win32] geminiBinary: any first agy hit (even unsupported agy.cmd) → agy; none → gemini", () => {
  const { dir } = newCase(ROOT, "gem");
  assert.equal(geminiBinary({ PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }), "gemini");
  writeFileSync(join(dir, "agy.cmd"), "@echo unsupported\r\n", "latin1");
  assert.equal(geminiBinary({ PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }), "agy");
});

test("evidence root preserved (owned, not deleted)", (t) => {
  t.diagnostic(`root=${ROOT}`);
  assert.ok(existsSync(ROOT));
});
