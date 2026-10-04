// #1167 — Windows npm-shim direct-launch DIFFERENTIAL probe. Disposable Windows CI only.
// Observation only: never changes launch policy, never productAcceptance.
//
// Oracle: npm's own bundled cmd-shim, hash-pinned to 6.0.3, executed against a mirrored layout
// to produce complete wrapper bytes; real `npm install --offline` shims must equal them byte-exact.
// Expected argv/interpreter come from the fields we authored (P, A, T), never from parsing.
//
// Engines:
//   cmd-ref     reference = the wrapper executed by cmd.exe. SAFE ARGS ONLY (assertCmdSafe throws
//               before any spawn otherwise). Hostile argv NEVER goes through cmd.
//   direct      PROBE_CANDIDATE_DIST/src/session/boot-adapter/spawner.js nodeSpawner().run(), with a
//               ChildProcess.prototype.spawn observer. Absent → direct cases are "not_run" and the
//               receipt is baseline_only. PROBE_EXPECT=baseline-ebfc459 marks the run as the NEGATIVE CONTROL:
//               findings are kept verbatim and status only says whether the control discriminated.
// Lifecycle: fakes self-exit (FAKE_LIFETIME_MS) and write nonce-bound start/exit receipts; cleanup
// is proven only by (every start has an exit receipt) AND (every owned handle 'close' observed).
// No ps/pgrep/wmic, no pid signalling; only owned ChildProcess handles may be killed.
//
// env: PROBE_RECEIPT (out), PROBE_RUNNER_TEMP, PROBE_COMMIT, PROBE_CANDIDATE_DIST (opt),
//      PROBE_ENGINE_LABEL (opt), PROBE_CMD_SHIM_DIR (opt), PROBE_ORACLE_ONLY=1 (any OS: oracle only).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp, { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// Raw bytes as shipped in official node-v20.20.2-win-x64.zip (SHASUMS256 dc3700fd…); lib/index.js has CRLF line ends.
const PIN = { version: '6.0.3',
  'lib/index.js': '4e5f3fcf05a00ece29888768a5f91b52d15ef736cfefab452ca77b66aa71b234',
  'lib/to-batch-syntax.js': 'e39a03dac6e5e31c6c4bb58fab2c23e8aeeaacd53e0b8c63e742fe7f4ef476ec' };
// Exact sources the direct engine must be built from (PROBE_EXPECT selects; mismatch → no run).
const SOURCE_PINS = {
  'candidate-r1': { 'win-launch.ts': '782fcd5442345db6c87936bbabfdea376a9830a683c6c427e40a575970f0b3cb',
    'spawner.ts': '56d6dbb811a2ad8a265bb79a144ff01900c00cbe351d20185392cfbd16660431',
    'gemini.ts': '0baa25bf1f9bffff993c071e29a75c0ee6101b3e8b5d4719a2daa7748e12f099',
    'types.ts': '940990d4a298ac400170a950824f4802d00157bf0cbe1d7fcc15328e7c5b865a' },
  'baseline-ebfc459': { 'spawner.ts': '1f1634043cdee74b3f8d791274893755dad0b70d4e5656055834112989204bc9',
    'gemini.ts': 'a8b12f699531021d5c6e441b64d31c45b5d9e0dec1f187d844b071465539f6a4',
    'types.ts': '984ce32596d76e20bbdf63a513dfddb11c80a4689af31d2169eb05e3ae955cea' },
};
const FAKE_LIFETIME_MS = 4000;
const RUN_TIMEOUT_MS = 8000;
const ORACLE_ONLY = process.env.PROBE_ORACLE_ONLY === '1';
const artifact = path.resolve(process.env.PROBE_RECEIPT || 'windows-npm-direct-receipt.json');
const parent = process.env.PROBE_RUNNER_TEMP || os.tmpdir();
const SYS = process.env.SystemRoot || process.env.SYSTEMROOT || '';
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const B = s => Buffer.from(String(s), 'utf8').toString('base64');
const U = s => Buffer.from(s, 'base64').toString('utf8');
const code = e => /^[A-Z0-9_]+$/.test(e?.code || '') ? e.code : e?.name || 'Error';
const delay = ms => new Promise(r => setTimeout(r, ms));

const receipt = { schema: 1, operation: 'p1167-npm-direct-v1', status: 'incomplete', productAcceptance: false,
  identity: { commit: process.env.PROBE_COMMIT || 'unknown', runtime: process.version, platform: process.platform, arch: process.arch,
    osRelease: os.release(), engineLabel: process.env.PROBE_ENGINE_LABEL || null, hashes: { probe: hash(fs.readFileSync(new URL(import.meta.url))) } },
  boundaries: { measured: 'npm 10.8.2 cmd-shim 6.0.3 wrappers via cmd.exe (safe args) vs candidate direct launch; fake CLI only',
    unmeasured: ['T11 real CLIs (claude/codex/gemini/agy/grok) and their argv parsers', 'descendant/tree lifecycle (direct child only)',
      'V-V acceptance (refusal only)', 'argv[1] spelling through cmd except via --require execArgv case', 'PID reuse', 'uninstrumented timing'],
    cleanup: 'owned handles only; fakes self-expire; no tree-kill claim' },
  oracle: {}, cases: [], findings: {}, cleanup: {} };
let ROOT = null;
const redact = s => (ROOT ? String(s).split(ROOT).join('<ROOT>') : String(s)).split(SYS || '\0').join('<SYS>');
function save() {
  const json = JSON.stringify(receipt, null, 2);
  if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('RECEIPT_LIMIT');
  fs.writeFileSync(artifact, json + '\n');
}

// ---------------- oracle ----------------
function loadGenerator() {
  const dir = process.env.PROBE_CMD_SHIM_DIR || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'cmd-shim');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const got = Object.fromEntries(['lib/index.js', 'lib/to-batch-syntax.js'].map(f => [f, hash(fs.readFileSync(path.join(dir, f)))]));
  receipt.oracle.generator = { dir: redact(dir), version, hashes: got };
  if (version !== PIN.version || Object.keys(got).some(f => got[f] !== PIN[f])) throw Object.assign(new Error('ORACLE_IDENTITY'), { code: 'ORACLE_IDENTITY' });
  return require(path.join(dir, 'lib', 'index.js'));
}
const HEADER = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0'].map(l => l + '\r\n').join('');
const contractVA = (T, P, A) => `${HEADER}\r\nIF EXIST "%dp0%\\${P}.exe" (\r\n  SET "_prog=%dp0%\\${P}.exe"\r\n) ELSE (\r\n  SET "_prog=${P}"\r\n` +
  `  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${A} "%dp0%\\${T}" %*\r\n`;
const contractVB = T => `${HEADER}"%dp0%\\${T}"   %*\r\n`;
async function genShim(gen, from, shimDir, name, body) {
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  if (body !== undefined) fs.writeFileSync(from, body);
  await gen(from, path.join(shimDir, name));
  return { bytes: fs.readFileSync(path.join(shimDir, name + '.cmd')), T: path.relative(shimDir, from).split('/').join('\\') };
}

// ---------------- fake CLI ----------------
const fakeSource = shebang => `${shebang ? shebang + '\n' : ''}"use strict";
const fs = require("node:fs"), p = require("node:path"), crypto = require("node:crypto");
const dir = process.env.FAKE_DIR, nonce = process.env.FAKE_NONCE;
if (!dir || !nonce) process.exit(96);
const w = (k, o) => fs.writeFileSync(p.join(dir, nonce + "." + process.pid + "." + k), JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid, ...o }));
w("start", {});
process.on("exit", (code) => w("exit", { code }));
setTimeout(() => process.exit(97), ${FAKE_LIFETIME_MS}).unref();
const B = (s) => Buffer.from(String(s), "utf8").toString("base64");
const report = (stdin) => {
  const env = {}; for (const k of ["FAKE_ENV_PROBE", "FOO", "_prog", "dp0", "PATHEXT"]) env[k] = process.env[k] === undefined ? null : B(process.env[k]);
  process.stdout.write(JSON.stringify({ self: B(__filename), argv0: B(process.argv0), execPath: B(process.execPath), execArgv: process.execArgv.map(B),
    args: process.argv.slice(2).map(B), cwd: B(process.cwd()), env, ppid: process.ppid,
    stdin: stdin === null ? null : { len: stdin.length, sha256: crypto.createHash("sha256").update(stdin).digest("hex") } }));
  process.exitCode = Number(process.env.FAKE_EXIT || 0);
};
if (process.argv[2] === "--version" && process.env.FAKE_MODE !== "preload") { process.stdout.write("fake-cli 1.2.3\\n"); }
else if (process.env.FAKE_MODE === "preload") { report(null); process.exit(); }
else if (process.env.FAKE_MODE === "noread") report(null);
else { const c = []; process.stdin.on("data", (d) => c.push(d)); process.stdin.on("end", () => report(Buffer.concat(c))); }
`;

// ---------------- literal sets ----------------
const SAFE = ['alpha', 'two words', 'k=v,w', 'a.b/c+d@e:f', '--flag=1', '-x'];
const SENT = 'injection-sentinel';
const LITERALS = ['', 'two words', '한글 😀', 'a"b', 'tail\\', '(parentheses)', '&', '|', '<', '>', '^', '%', '!', ';', 'line1\nline2',
  '%PROBE_EXPANSION%', '!PROBE_EXPANSION!', `& echo owned>${SENT}`, `| echo owned>${SENT}`, `\n echo owned>${SENT}`,
  `x" & echo owned>${SENT} & rem "`, 'a\rb', '\r', 'a\r\nb', '%PATH%', '\\"', 'tail\\\\'];
const HOSTILE = LITERALS.filter(a => /PROBE_EXPANSION|injection-sentinel|%PATH%/.test(a));
const STDIN = 'stdin empty-line follows\n\n한글 😀\r\n" & | % !\n';
function assertCmdSafe(args) {
  for (const a of args) if (!/^[A-Za-z0-9 ._=,/+@:\\-]+$/.test(a) || a.endsWith('\\')) throw Object.assign(new Error('HOSTILE_TO_CMD'), { code: 'HOSTILE_TO_CMD' });
}

// ---------------- execution ----------------
const owned = new Set();
const spawnLog = [];
let observing = false;
const protoSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
  const r = protoSpawn.call(this, options);
  if (observing) {
    const rec = { file: options.file, args: [...options.args], verbatim: options.windowsVerbatimArguments, pid: this.pid ?? null, closed: false };
    spawnLog.push(rec);
    owned.add(this);
    this.once('close', () => { rec.closed = true; owned.delete(this); });
  }
  return r;
};
function caseEnv(pathKey, dirs, dir, nonce, extra = {}) {
  return { SystemRoot: SYS, WINDIR: SYS, ComSpec: path.join(SYS, 'System32', 'cmd.exe'), TEMP: dir, TMP: dir,
    [pathKey]: [...dirs, path.dirname(process.execPath), path.join(SYS, 'System32'), SYS].join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS',
    FAKE_DIR: dir, FAKE_NONCE: nonce, FAKE_ENV_PROBE: 'env-probe-value', PROBE_EXPANSION: 'expanded-must-not-replace-literal', ...extra };
}
function cmdRef(exeToken, args, env, cwd, stdin) {
  assertCmdSafe(args);
  if (!/^[^"%^&|<>!]+$/.test(exeToken)) throw Object.assign(new Error('HOSTILE_TO_CMD'), { code: 'HOSTILE_TO_CMD' });
  const line = `"${[`"${exeToken}"`, ...args.map(a => `"${a}"`)].join(' ')}"`;
  return new Promise(resolve => {
    const c = cp.spawn(env.ComSpec, ['/d', '/s', '/c', line], { cwd, env, windowsVerbatimArguments: true, shell: false });
    owned.add(c);
    let out = '', err = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    c.stdin.on('error', () => {});
    c.on('error', e => { clearTimeout(t); owned.delete(c); resolve({ error: code(e), handlePid: c.pid ?? null, closed: true }); });
    c.on('close', exit => { clearTimeout(t); owned.delete(c); resolve({ stdout: out, stderrHash: hash(err), exit, timedOut, handlePid: c.pid ?? null, closed: true }); });
    c.stdin.end(stdin);
  });
}
let candidate = null;
let winLaunch = null;
// Records the candidate's own resolution (timing + redacted result); evidence only, never the oracle.
function resolution(argv, env, cwd) {
  if (!winLaunch) return null;
  const rss0 = process.memoryUsage().rss, t0 = performance.now();
  try {
    const r = winLaunch.resolveLaunch(argv[0], argv.slice(1), env, cwd);
    return { ms: Math.round(performance.now() - t0), rssDeltaMiB: Math.round((process.memoryUsage().rss - rss0) / 2 ** 20),
      file: redact(r.file), argv0: r.argv0 === undefined ? null : redact(r.argv0), prefix: r.args.slice(0, Math.max(0, r.args.length - argv.length + 1)).map(redact) };
  } catch (e) { return { ms: Math.round(performance.now() - t0), error: code(e), detail: redact(e?.message ?? '') }; }
}
async function direct(argv, env, cwd, stdin) {
  if (!candidate) return { notRun: 'candidate_not_supplied' };
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  const from = spawnLog.length;
  observing = true;
  try {
    const v = await candidate.run({ argv, env: {}, cwd, prompt_file: '', expected_digest: '' }, stdin, RUN_TIMEOUT_MS);
    return { stdout: v.stdout, exit: v.exit_code, stderrHash: hash(v.stderr), spawns: spawnLog.slice(from) };
  } catch (e) {
    return { error: code(e), spawns: spawnLog.slice(from) };
  } finally {
    observing = false;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
async function directProbe(exe, env, cwd) {
  if (!candidate) return { notRun: 'candidate_not_supplied' };
  const saved = { ...process.env }, savedCwd = process.cwd();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  process.chdir(cwd);
  const from = spawnLog.length;
  observing = true;
  try { return { version: await candidate.probeVersion(exe), spawns: spawnLog.slice(from) }; }
  catch (e) { return { error: e?.message === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : code(e), spawns: spawnLog.slice(from) }; }
  finally {
    observing = false; process.chdir(savedCwd);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
function receipts(dir, nonce) {
  const by = {};
  for (const f of fs.readdirSync(dir)) {
    const m = /^([0-9a-f]+)\.(\d+)\.(start|exit)$/.exec(f);
    if (!m || m[1] !== nonce) continue;
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (r.nonce !== nonce || r.pid !== Number(m[2])) return { invalid: f };
    (by[r.pid] ??= {})[m[3]] = r;
  }
  return by;
}
async function cleanupProof(dir, nonce, res) {
  const until = Date.now() + 1500;
  let r = receipts(dir, nonce);
  while (!r.invalid && Object.values(r).some(e => e.start && !e.exit) && Date.now() < until) { await delay(25); r = receipts(dir, nonce); }
  const reasons = [];
  if (r.invalid) reasons.push('receipt_provenance');
  for (const [pid, e] of Object.entries(r.invalid ? {} : r)) if (!e.start || !e.exit) reasons.push(`pid_${pid}_${e.start ? 'exit' : 'start'}_missing`);
  for (const s of res?.spawns || []) if (s.pid !== null && !s.closed) reasons.push(`handle_${s.pid}_not_closed`);
  if (res && res.closed === false) reasons.push('cmd_handle_not_closed');
  return { complete: reasons.length === 0, starts: r.invalid ? null : Object.values(r).filter(e => e.start).length, reasons };
}
const report = res => { try { return res.stdout ? JSON.parse(res.stdout) : null; } catch { return null; } };
const view = rep => rep && { self: redact(U(rep.self)), argv0: redact(U(rep.argv0)), execPath: redact(U(rep.execPath)),
  execArgv: rep.execArgv.map(x => redact(U(x))), argsB64: rep.args, argsHash: hash(JSON.stringify(rep.args)), cwd: redact(U(rep.cwd)), env: rep.env, stdin: rep.stdin };
const newCase = label => { const nonce = crypto.randomBytes(16).toString('hex'); const dir = path.join(ROOT, 'cases', `${label}-${nonce.slice(0, 8)}`); fs.mkdirSync(dir, { recursive: true }); return { dir, nonce }; };

async function differential(id, { exeToken, argvExe = exeToken, dirs, key = 'PATH', args = SAFE, expect, extra = {}, cwdSetup }) {
  const rec = { id, kind: 'differential', key };
  const ref = newCase(id + '-ref');
  if (cwdSetup) await cwdSetup(ref.dir);
  const r1 = await cmdRef(exeToken, args, caseEnv(key, dirs, ref.dir, ref.nonce, extra), ref.dir, STDIN);
  rec.cmdRef = { error: r1.error ?? null, exit: r1.exit ?? null, timedOut: r1.timedOut ?? false, report: view(report(r1)),
    payloadParentIsCmd: report(r1)?.ppid === r1.handlePid, cleanup: await cleanupProof(ref.dir, ref.nonce, r1), sentinel: fs.existsSync(path.join(ref.dir, SENT)) };
  const dc = newCase(id + '-direct');
  if (cwdSetup && candidate) await cwdSetup(dc.dir);
  rec.resolution = resolution([argvExe, ...args], caseEnv(key, dirs, dc.dir, dc.nonce, extra), dc.dir);
  const r2 = await direct([argvExe, ...args], caseEnv(key, dirs, dc.dir, dc.nonce, extra), dc.dir, STDIN);
  if (r2.notRun) rec.direct = { notRun: r2.notRun };
  else {
    rec.direct = { error: r2.error ?? null, exit: r2.exit ?? null, report: view(report(r2)),
      spawns: r2.spawns.map(s => ({ file: redact(s.file), args: s.args.slice(0, 3).map(redact), argc: s.args.length, verbatim: s.verbatim })),
      cleanup: await cleanupProof(dc.dir, dc.nonce, r2), sentinel: fs.existsSync(path.join(dc.dir, SENT)) };
    const a = rec.cmdRef.report, b = rec.direct.report;
    // cwd differs by construction (separate owned case dirs); compared relative to each case dir.
    const norm = v => v && { ...v, cwd: path.basename(v.cwd).replace(/-(ref|direct)-[0-9a-f]{8}$/, '') };
    rec.diff = !a || !b ? 'unavailable' : Object.keys(norm(a)).filter(k => JSON.stringify(norm(a)[k]) !== JSON.stringify(norm(b)[k]));
    if (rec.diff !== 'unavailable' && rec.cmdRef.exit !== rec.direct.exit) rec.diff.push('exit');
  }
  rec.oracle = expect;
  rec.oracleMatch = { cmdRef: matchOracle(rec.cmdRef.report, args, expect), direct: rec.direct.report ? matchOracle(rec.direct.report, args, expect) : null };
  return rec;
}
function matchOracle(v, args, expect) {
  if (!v) return false;
  if (expect.self && v.self.toLowerCase() !== expect.self.toLowerCase()) return false;
  return JSON.stringify(v.argsB64) === JSON.stringify((expect.args ?? args).map(B)) && v.execPath.toLowerCase() === expect.execPath.toLowerCase() &&
    (!expect.execArgv || JSON.stringify(v.execArgv) === JSON.stringify(expect.execArgv)) && v.stdin?.sha256 === (expect.stdinNull ? undefined : hash(STDIN));
}
async function directOnly(id, { argv, dirs, key = 'PATH', expectRefuse = false, stdin = STDIN, extra = {}, userArgsFrom = 1, cwdSetup }) {
  const c = newCase(id);
  if (cwdSetup) await cwdSetup(c.dir);
  const res = resolution(argv, caseEnv(key, dirs, c.dir, c.nonce, extra), c.dir);
  const r = await direct(argv, caseEnv(key, dirs, c.dir, c.nonce, extra), c.dir, stdin);
  if (r.notRun) return { id, kind: 'direct', notRun: r.notRun };
  const rep = report(r);
  const got = rep ? rep.args.map(U) : null;
  const want = argv.slice(userArgsFrom);
  return { id, kind: 'direct', expectRefuse, resolution: res, error: r.error ?? null, exit: r.exit ?? null, spawnCount: r.spawns.length,
    spawns: r.spawns.map(s => ({ file: redact(s.file), argc: s.args.length, verbatim: s.verbatim })),
    argsBytesEqual: got ? JSON.stringify(got) === JSON.stringify(want) : null, argsHash: got ? hash(JSON.stringify(got)) : null,
    hostileReached: got ? HOSTILE.every(h => got.includes(h)) : null, stdin: rep?.stdin ?? null,
    sentinel: fs.existsSync(path.join(c.dir, SENT)), cleanup: await cleanupProof(c.dir, c.nonce, r) };
}

// ---------------- main ----------------
const watchdog = setTimeout(() => {
  receipt.status = 'overall_deadline';
  receipt.cleanup = { complete: false, forced: [...owned].map(c => ({ pid: c.pid ?? null, killed: c.kill('SIGKILL') })) };
  save();
  setTimeout(() => process.exit(2), FAKE_LIFETIME_MS + 1000);
}, 300000);
try {
  save();
  if (!ORACLE_ONLY && (process.platform !== 'win32' || process.version !== 'v20.20.2')) throw Object.assign(new Error('NATIVE_RUNTIME_REQUIRED'), { code: 'NATIVE_RUNTIME_REQUIRED' });
  ROOT = fs.mkdtempSync(path.join(parent, 'npm direct probe owned-'));
  const gen = loadGenerator();
  // Oracle self-check: generator == CONTRACT-R2 §2 transcription.
  const o = path.join(ROOT, 'oracle-self');
  const va = await genShim(gen, path.join(o, 'pkg', 'va'), path.join(o, 'bin'), 'va', fakeSource('#!/usr/bin/env node'));
  const vb = await genShim(gen, path.join(o, 'pkg', 'vb.exe'), path.join(o, 'bin'), 'vb', 'MZ');
  receipt.oracle.contractTranscription = { VA: va.bytes.equals(Buffer.from(contractVA(va.T, 'node', ''), 'latin1')),
    VB: vb.bytes.equals(Buffer.from(contractVB(vb.T), 'latin1')) };
  if (ORACLE_ONLY) {
    receipt.status = Object.values(receipt.oracle.contractTranscription).every(Boolean) ? 'oracle_only_ok' : 'oracle_only_mismatch';
    throw null;
  }
  if (!SYS) throw Object.assign(new Error('IDENTITY_REQUIRED'), { code: 'IDENTITY_REQUIRED' });
  if (process.env.PROBE_CANDIDATE_DIST) {
    // PROBE_CANDIDATE_DIST = repo root holding src/session/boot-adapter/*.ts and dist/src/session/boot-adapter/*.js
    const expect = process.env.PROBE_EXPECT || 'candidate-r1';
    const pins = SOURCE_PINS[expect];
    const srcDir = path.join(process.env.PROBE_CANDIDATE_DIST, 'src', 'session', 'boot-adapter');
    const distDir = path.join(process.env.PROBE_CANDIDATE_DIST, 'dist', 'src', 'session', 'boot-adapter');
    receipt.identity.expect = expect;
    receipt.identity.sources = Object.fromEntries(Object.keys(pins || {}).map(f => [f, fs.existsSync(path.join(srcDir, f)) ? hash(fs.readFileSync(path.join(srcDir, f))) : null]));
    receipt.identity.role = expect === 'baseline-ebfc459' ? 'negative-control' : 'candidate';
    // Record-only: every boot-adapter source actually compiled (the branch base may differ from ebfc459).
    receipt.identity.allBootAdapterSources = Object.fromEntries(fs.readdirSync(srcDir).filter(f => f.endsWith('.ts')).sort()
      .map(f => [f, hash(fs.readFileSync(path.join(srcDir, f)))]));
    if (!pins || Object.keys(pins).some(f => receipt.identity.sources[f] !== pins[f])) throw Object.assign(new Error('CANDIDATE_IDENTITY'), { code: 'CANDIDATE_IDENTITY' });
    for (const f of ['spawner.js', 'win-launch.js', 'gemini.js']) receipt.identity.hashes[`dist/${f}`] = fs.existsSync(path.join(distDir, f)) ? hash(fs.readFileSync(path.join(distDir, f))) : null;
    candidate = (await import(pathToFileURL(path.join(distDir, 'spawner.js')).href)).nodeSpawner();
    if (fs.existsSync(path.join(distDir, 'win-launch.js'))) winLaunch = await import(pathToFileURL(path.join(distDir, 'win-launch.js')).href);
  }
  // Fake package installed by the REAL npm (offline, local + isolated global prefix).
  for (const d of ['home', 'cache', 'pkg', 'local', 'prefix', 'cases', 'mirror']) fs.mkdirSync(path.join(ROOT, d));
  const name = `fake-cli-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(path.join(ROOT, 'pkg', 'cli'), fakeSource('#!/usr/bin/env node'));
  fs.writeFileSync(path.join(ROOT, 'pkg', 'package.json'), JSON.stringify({ name, version: '1.0.0', bin: { [name]: 'cli' } }));
  fs.writeFileSync(path.join(ROOT, 'local', 'package.json'), '{"private":true}');
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  receipt.identity.npmVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(npmCli), '..', 'package.json'))).version;
  const npmEnv = { ...caseEnv('Path', [], path.join(ROOT, 'home'), '0'), USERPROFILE: path.join(ROOT, 'home'),
    APPDATA: path.join(ROOT, 'home'), LOCALAPPDATA: path.join(ROOT, 'cache'), npm_config_cache: path.join(ROOT, 'cache'),
    npm_config_userconfig: path.join(ROOT, 'npmrc'), npm_config_globalconfig: path.join(ROOT, 'global-npmrc') };
  fs.writeFileSync(path.join(ROOT, 'npmrc'), ''); fs.writeFileSync(path.join(ROOT, 'global-npmrc'), '');
  receipt.setup = [];
  for (const [label, args, cwd] of [['local', ['install', '--install-links', '--package-lock=false', path.join(ROOT, 'pkg')], path.join(ROOT, 'local')],
    ['prefix', ['install', '--global', '--prefix', path.join(ROOT, 'prefix'), path.join(ROOT, 'pkg')], ROOT]]) {
    const r = cp.spawnSync(process.execPath, [npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'],
      { cwd, env: npmEnv, shell: false, timeout: 60000, encoding: 'utf8', maxBuffer: 1 << 20 });
    receipt.setup.push({ label, status: r.status, error: r.error ? code(r.error) : null, stdoutHash: hash(r.stdout || ''), stderrHash: hash(r.stderr || '') });
    if (r.status !== 0) throw Object.assign(new Error('OFFLINE_NPM_SETUP_FAILED'), { code: 'OFFLINE_NPM_SETUP_FAILED' });
  }
  const localBin = path.join(ROOT, 'local', 'node_modules', '.bin');
  const prefixBin = path.join(ROOT, 'prefix');
  const layouts = { local: { bin: localBin, target: path.join(ROOT, 'local', 'node_modules', name, 'cli') },
    prefix: { bin: prefixBin, target: path.join(prefixBin, 'node_modules', name, 'cli') } };
  // npm-produced bytes must equal generator bytes on a mirrored layout (same relative T).
  for (const [label, l] of Object.entries(layouts)) {
    const mb = path.join(ROOT, 'mirror', label, path.relative(ROOT, l.bin));
    const mt = path.join(mb, path.relative(l.bin, l.target));
    const g = await genShim(gen, mt, mb, name, fs.readFileSync(l.target, 'utf8'));
    const npmBytes = fs.readFileSync(path.join(l.bin, name + '.cmd'));
    l.T = g.T;
    receipt.oracle[`npm_${label}`] = { T: g.T, npmHash: hash(npmBytes), oracleHash: hash(g.bytes), equal: npmBytes.equals(g.bytes),
      contractVA: npmBytes.equals(Buffer.from(contractVA(g.T, 'node', ''), 'latin1')) };
  }
  const nodeExe = path.join(path.dirname(process.execPath), 'node.exe');
  save();

  // ---- T3 differential (safe args): local/prefix × bare/abs × PATH/Path ----
  for (const [label, l] of Object.entries(layouts)) for (const spelling of ['bare', 'abs']) for (const key of ['PATH', 'Path']) {
    const exe = spelling === 'bare' ? name : path.join(l.bin, name + '.cmd');
    receipt.cases.push(await differential(`T3/${label}/${spelling}/${key}`, { exeToken: exe, dirs: [l.bin], key,
      expect: { execPath: redact(nodeExe) } }));
    save();
  }
  receipt.cases.push(await differential('T3/local/exit23', { exeToken: name, dirs: [localBin], extra: { FAKE_EXIT: '23' }, expect: { execPath: redact(nodeExe) } }));
  // V-B native target, dp0\node.exe present, --require spelling, V-V (cmd-ref only + direct must refuse).
  const g = path.join(ROOT, 'gen');
  const vbx = await genShim(gen, path.join(g, 'vbpkg', 'fakevb.exe'), path.join(g, 'vbbin'), 'fakevb', '');
  fs.copyFileSync(process.execPath, path.join(g, 'vbpkg', 'fakevb.exe'));
  const script = path.join(g, 'fake-script.cjs');
  fs.writeFileSync(script, fakeSource(null));
  receipt.cases.push(await differential('T3/V-B', { exeToken: 'fakevb', dirs: [path.join(g, 'vbbin')], args: [script, ...SAFE].map(String),
    expect: { execPath: redact(path.join(g, 'vbpkg', 'fakevb.exe')), args: SAFE } }));
  const dpn = await genShim(gen, path.join(g, 'dpnpkg', 'cli'), path.join(g, 'dpnbin'), 'fakedpn', fakeSource('#!/usr/bin/env node'));
  fs.copyFileSync(process.execPath, path.join(g, 'dpnbin', 'node.exe'));
  receipt.cases.push(await differential('T3+T6/dp0-node.exe', { exeToken: 'fakedpn', dirs: [path.join(g, 'dpnbin')],
    expect: { execPath: redact(path.join(g, 'dpnbin', 'node.exe')) } }));
  const sp = await genShim(gen, path.join(g, 'sppkg', 'cli'), path.join(g, 'spbin'), 'fakesp', fakeSource('#!/usr/bin/env node --require'));
  receipt.cases.push(await differential('T3/spelling--require', { exeToken: 'fakesp', dirs: [path.join(g, 'spbin')], args: ['main-never-run.js', 'x'],
    extra: { FAKE_MODE: 'preload' }, expect: { execPath: redact(nodeExe), execArgv: ['--require', redact(`${path.join(g, 'spbin')}\\\\${sp.T}`)], stdinNull: true, args: ['x'] } }));
  await genShim(gen, path.join(g, 'vvpkg', 'cli'), path.join(g, 'vvbin'), 'fakevv', fakeSource('#!/usr/bin/env -S FOO=bar node'));
  const vvRef = await differential('T3/V-V-reference-only', { exeToken: 'fakevv', dirs: [path.join(g, 'vvbin')], expect: { execPath: redact(nodeExe) } });
  vvRef.note = 'records whether FOO reaches the child via cmd; direct is expected to refuse (V-V unsupported)';
  receipt.cases.push(vvRef);
  save();

  // ---- lookup policy (recorded for both engines; no verdict) ----
  const cwTarget = path.join(g, 'cwpkg', 'cli');
  receipt.cases.push({ ...(await differential('lookup/cwd-before-PATH', { exeToken: name, dirs: [localBin],
    cwdSetup: d => genShim(gen, cwTarget, d, name, fakeSource('#!/usr/bin/env node')), expect: { execPath: redact(nodeExe), self: redact(cwTarget) } })),
    note: 'a valid shim of the same name in cwd (target cwpkg) and on PATH (target local pkg); self shows which ran; contract §3.1 = cwd first' });
  const ext = path.join(g, 'extbin');
  await genShim(gen, path.join(g, 'extpkg', 'cli'), ext, 'fakeext', fakeSource('#!/usr/bin/env node'));
  fs.copyFileSync(process.execPath, path.join(ext, 'fakeext.exe'));
  receipt.cases.push(await directOnly('lookup/PATHEXT-exe-before-cmd', { argv: ['fakeext', script, ...SAFE], dirs: [ext], userArgsFrom: 2 }));
  save();

  // ---- T1/T2 hostile, direct only ----
  for (const [label, l] of Object.entries(layouts)) for (const key of ['PATH', 'Path']) {
    receipt.cases.push(await directOnly(`T2/${label}/bare/${key}`, { argv: [name, ...LITERALS], dirs: [l.bin], key }));
    receipt.cases.push(await directOnly(`T2/${label}/abs/${key}`, { argv: [path.join(l.bin, name + '.cmd'), ...LITERALS], dirs: [l.bin], key }));
  }
  receipt.cases.push(await directOnly('T2/native-exe', { argv: ['fakeext', script, ...LITERALS], dirs: [ext], userArgsFrom: 2 }));
  receipt.cases.push(await directOnly('T2/V-B', { argv: ['fakevb', script, ...LITERALS], dirs: [path.join(g, 'vbbin')], userArgsFrom: 2 }));
  save();

  // ---- T4/T5/T6/T7 refusal (direct only) ----
  const valid = fs.readFileSync(path.join(localBin, name + '.cmd'), 'latin1');
  const mut = { 'plus-line': v => v.replace('CALL :find_dp0\r\n', 'CALL :find_dp0\r\nREM x\r\n'), 'minus-line': v => v.replace('SETLOCAL\r\n', ''),
    'lf-only': v => v.split('\r\n').join('\n'), 'cr-only': v => v.split('\r\n').join('\r'), bom: v => 'ï»¿' + v,
    'no-final-crlf': v => v.slice(0, -2), 'extra-final-crlf': v => v + '\r\n', 'case-flip': v => v.replace('@ECHO off', '@ECHO OFF'),
    'trailing-space': v => v.slice(0, -2) + ' \r\n', 'field-inconsistent': v => v.replace(/SET "_prog=([^"%]+)"/, 'SET "_prog=$1x"'),
    'vv-injected': v => v.replace('CALL :find_dp0\r\n', 'CALL :find_dp0\r\n@SET FOO=bar\r\n') };
  const negDirs = {};
  for (const [id, f] of Object.entries(mut)) {
    const d = path.join(ROOT, 'neg', id); const T = layouts.local.T;
    fs.mkdirSync(d, { recursive: true });
    // Keep T resolvable from the mutated wrapper's dir so a wrongly-accepted wrapper would really start the payload.
    fs.writeFileSync(path.join(d, 'neg.cmd'), f(valid).split(`%dp0%\\${T}`).join(`%dp0%\\${path.relative(d, layouts.local.target).split('/').join('\\')}`), 'latin1');
    negDirs[id] = d;
  }
  for (const [id, sb, tn] of [['generated-V-V', '#!/usr/bin/env -S FOO=bar node', 'vv'], ['non-bare-P', '#!/usr/local/bin/node', 'nb'],
    ['A-dollar', '#!/usr/bin/env node --title=$HOME', 'ad'], ['T-percent', '#!/usr/bin/env node', 'a%b'], ['T-amp', '#!/usr/bin/env node', 'a&b'],
    ['VB-non-exe', null, 'vbjs.js']]) {
    const d = path.join(ROOT, 'neg', id);
    await genShim(gen, path.join(ROOT, 'negpkg', tn), d, 'neg', fakeSource(sb));
    negDirs[id] = d;
  }
  negDirs['bin&dir'] = path.join(ROOT, 'neg', 'bin&dir');
  await genShim(gen, path.join(ROOT, 'negpkg', 'ampdir'), negDirs['bin&dir'], 'neg', fakeSource('#!/usr/bin/env node'));
  for (const [id, d] of Object.entries(negDirs)) receipt.cases.push(await directOnly(`T4/${id}`, { argv: ['neg', 'safe'], dirs: [d], expectRefuse: true }));
  const bat = path.join(ROOT, 'neg', 'bat-first'); fs.mkdirSync(bat);
  fs.writeFileSync(path.join(bat, name + '.bat'), valid, 'latin1');
  receipt.cases.push(await directOnly('T5/bat-before-valid', { argv: [name, 'safe'], dirs: [bat, localBin], expectRefuse: true }));
  const bad = path.join(ROOT, 'neg', 'bad-first'); fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, name + '.cmd'), mut['lf-only'](valid), 'latin1');
  receipt.cases.push(await directOnly('T5/bad-cmd-before-valid', { argv: [name, 'safe'], dirs: [bad, localBin], expectRefuse: true }));
  const shadow = path.join(ROOT, 'neg', 'node-cmd'); fs.mkdirSync(shadow);
  fs.writeFileSync(path.join(shadow, 'node.cmd'), '@ECHO off\r\nexit /b 3\r\n', 'latin1');
  receipt.cases.push(await directOnly('T6/node-resolves-to-node.cmd', { argv: [name, 'safe'], dirs: [localBin, shadow], expectRefuse: true }));
  save();

  // ---- T8 length, T9 non-reading child ----
  for (const n of [30000, 32700, 40000]) {
    const r = await directOnly(`T8/${n}`, { argv: [name, 'a'.repeat(n)], dirs: [localBin], stdin: '' });
    r.note = n > 32767 ? 'expect OS spawn error, zero payload starts' : 'expect success, no truncation (32700 may exceed the cap after quoting+exe path; recorded, not asserted)';
    receipt.cases.push(r);
  }
  receipt.cases.push(await directOnly('T9/noread-8MiB', { argv: [name], dirs: [localBin], stdin: 'z'.repeat(8 << 20), extra: { FAKE_MODE: 'noread' } }));

  // ---- probeVersion (collect path): valid shim → version; unsupported → CLI_NOT_FOUND, zero spawns ----
  for (const [id, dirs, exe, want] of [['PV/valid-local', [localBin], name, '1.2.3'], ['PV/unsupported-lf-only', [negDirs['lf-only']], 'neg', 'CLI_NOT_FOUND']]) {
    const c = newCase(id);
    const r = await directProbe(exe, caseEnv('PATH', dirs, c.dir, c.nonce), c.dir);
    receipt.cases.push(r.notRun ? { id, kind: 'probeVersion', notRun: r.notRun } : { id, kind: 'probeVersion', want, version: r.version ?? null, error: r.error ?? null,
      spawnCount: r.spawns.length, ok: (r.version ?? r.error) === want && (want !== 'CLI_NOT_FOUND' || r.spawns.length === 0), cleanup: await cleanupProof(c.dir, c.nonce, r) });
  }
  // ---- coder assumption (a): %~dp0 spelling vs candidate's resolved PATH entry (spelling fixture, safe args) ----
  const spBin = path.join(g, 'spbin');
  const caseDepthRel = path.relative(path.join(ROOT, 'cases', 'x'), spBin);
  for (const [vid, entry] of [['trailing-backslash', spBin + '\\'], ['lowercase', spBin.toLowerCase()], ['forward-slash', spBin.split('\\').join('/')],
    ['quoted', `"${spBin}"`], ['relative', caseDepthRel], ['dot-segment', path.join(spBin, '..', 'spbin').replace('spbin', 'spbin\\.\\.')]]) {
    receipt.cases.push(await differential(`spelling/${vid}`, { exeToken: 'fakesp', dirs: [entry], args: ['main-never-run.js', 'x'], extra: { FAKE_MODE: 'preload' },
      expect: { execPath: redact(nodeExe), args: ['x'], stdinNull: true } }));
  }
  // ---- cwd decoy for P: cmd would run the decoy node.bat; candidate must refuse (documented divergence) ----
  receipt.cases.push({ ...(await differential('T6/cwd-node.bat-decoy', { exeToken: name, dirs: [localBin],
    cwdSetup: d => fs.writeFileSync(path.join(d, 'node.bat'), '@ECHO off\r\nexit /b 7\r\n', 'latin1'), expect: { execPath: redact(nodeExe) } })),
    oracleMatch: null, note: 'expected: cmdRef exit 7 with no payload (decoy ran), direct CLI_LAUNCH_UNSUPPORTED with zero spawns' });
  save();
  // ---- bounded resource characterisation (record only; never a pass criterion) ----
  const big = path.join(ROOT, 'res', 'big'); fs.mkdirSync(big, { recursive: true });
  fs.writeFileSync(path.join(big, 'neg.cmd'), Buffer.concat([Buffer.from(valid.slice(0, valid.indexOf('\r\nIF EXIST')), 'latin1'), Buffer.alloc(64 << 20, 0x78)]));
  receipt.cases.push({ ...(await directOnly('RES/64MiB-cmd-read-unbounded', { argv: ['neg', 'safe'], dirs: [big], expectRefuse: true })),
    note: 'readFileSync has no size bound and runs before any timer; resolution.ms/rssDeltaMiB quantify it' });
  const many = Array.from({ length: 300 }, (_, i) => path.join(ROOT, 'res', `a${i}`)); // stays under the 32767-char variable limit
  receipt.cases.push({ ...(await directOnly('RES/300-absent-PATH-entries', { argv: [name, 'safe'], dirs: [...many, localBin] })),
    note: 'synchronous stat search before the run/probe timers; UNC/slow-share latency unexplored' });

  receipt.unexplored = ['T11 real CLI packages (claude/codex/gemini/agy/grok) shim forms and argv parsers',
    'UNC / \\\\?\\ / 8.3 short-name / mapped-drive shim dirs and slow or unreachable PATH shares (stat blocking before timers)',
    'PATHEXT .JS association path (would run WSH) for coder assumption (c); not executed by design',
    'non-ASCII shim dirs/targets (target refused: prototype limitation, not an approved final support removal)',
    'TOCTOU between resolution and spawn; dp0\\P.exe as a directory (coder f)', 'NoDefaultCurrentDirectoryInExePath set',
    'descendant/tree cleanup (Job Object); PID reuse', 'V-V acceptance (refusal only)', 'exact CreateProcess length boundary (32700 recorded only)'];
  receipt.matrix = receipt.cases.map(c => ({ id: c.id, kind: c.kind, engines: c.kind === 'differential' ? ['cmd-ref', 'direct'] : [c.kind === 'probeVersion' ? 'probeVersion' : 'direct'],
    ran: !c.notRun && !(c.direct && c.direct.notRun) }));

  // ---- findings (no product verdict) ----
  const cs = receipt.cases;
  receipt.findings = {
    candidateSupplied: Boolean(candidate),
    oracleNpmEqual: ['npm_local', 'npm_prefix'].every(k => receipt.oracle[k]?.equal === true),
    cleanupIncomplete: cs.filter(c => [c.cleanup, c.cmdRef?.cleanup, c.direct?.cleanup].some(x => x && !x.complete)).map(c => c.id),
    sentinels: cs.filter(c => c.sentinel || c.cmdRef?.sentinel || c.direct?.sentinel).map(c => c.id),
    differentialMismatch: cs.filter(c => Array.isArray(c.diff) && c.diff.length).map(c => ({ id: c.id, fields: c.diff })),
    oracleMismatch: cs.filter(c => c.oracleMatch && (c.oracleMatch.cmdRef === false || c.oracleMatch.direct === false)).map(c => c.id),
    hostileNotReached: cs.filter(c => c.id.startsWith('T2/') && c.hostileReached !== true && !c.notRun).map(c => c.id),
    argvMismatch: cs.filter(c => c.id.startsWith('T2/') && c.argsBytesEqual !== true && !c.notRun).map(c => c.id),
    decoyViolation: cs.filter(c => c.id === 'T6/cwd-node.bat-decoy' && c.direct && !c.direct.notRun && (c.direct.error !== 'CLI_LAUNCH_UNSUPPORTED' || c.direct.spawns.length !== 0)).map(c => c.id),
    resourceRefusalOrError: cs.filter(c => c.id.startsWith('RES/') && !c.notRun && (c.expectRefuse ? c.error !== 'CLI_LAUNCH_UNSUPPORTED' : c.error !== null)).map(c => c.id),
    probeVersionViolations: cs.filter(c => c.kind === 'probeVersion' && !c.notRun && !c.ok).map(c => c.id),
    refusalViolations: cs.filter(c => c.expectRefuse && !c.notRun && (c.error !== 'CLI_LAUNCH_UNSUPPORTED' || c.spawnCount !== 0 || c.cleanup.starts !== 0)).map(c => c.id),
    shellSpawns: cs.flatMap(c => (c.spawns || c.direct?.spawns || []).filter(s => /(^|[\\/])(cmd|powershell|pwsh)(\.exe)?$/i.test(s.file) || s.verbatim).map(() => c.id)),
  };
  const f = receipt.findings;
  const clean = f.oracleNpmEqual && !f.cleanupIncomplete.length && !f.sentinels.length && !f.differentialMismatch.length && !f.oracleMismatch.length &&
    !f.hostileNotReached.length && !f.argvMismatch.length && !f.refusalViolations.length && !f.shellSpawns.length && !f.probeVersionViolations.length && !f.decoyViolation.length && !f.resourceRefusalOrError.length;
  // Harness sanity, identical in both roles: the cmd reference itself matched the oracle on every T3 V-A layout.
  receipt.referenceSane = cs.filter(c => /^T3\/(local|prefix)\//.test(c.id)).every(c => c.oracleMatch?.cmdRef === true);
  if (receipt.identity.role === 'negative-control') {
    // Expected baseline ebfc459 behaviour (no win-launch): npm .cmd shims are not launchable directly (ENOENT bare /
    // EINVAL .cmd path), while a native .exe already works. Proves the harness can tell the two apart; approves nothing.
    const t2 = cs.filter(c => /^T2\/(local|prefix)\/(bare|abs)\/(PATH|Path)$/.test(c.id));
    const exe = cs.find(c => c.id === 'T2/native-exe');
    receipt.controlDiscrimination = {
      shimCasesFailed: t2.length === 8 && t2.every(c => c.argsBytesEqual !== true && ['ENOENT', 'EINVAL'].includes(c.error)),
      shimCaseErrors: t2.map(c => ({ id: c.id, error: c.error })),
      nativeExeControlOk: exe?.argsBytesEqual === true && exe?.hostileReached === true && exe?.sentinel === false,
      referenceSane: receipt.referenceSane, oracleNpmEqual: f.oracleNpmEqual,
      cleanupComplete: !f.cleanupIncomplete.length, noSentinels: !f.sentinels.length, noShellSpawns: !f.shellSpawns.length,
    };
    const d = receipt.controlDiscrimination;
    receipt.status = d.shimCasesFailed && d.nativeExeControlOk && d.referenceSane && d.oracleNpmEqual && d.cleanupComplete && d.noSentinels && d.noShellSpawns
      ? 'negative_control_discriminates' : 'negative_control_not_discriminating';
  } else {
    receipt.status = !candidate ? 'baseline_only' : clean && receipt.referenceSane ? 'diagnostic_clean_pending_review' : 'diagnostic_findings';
  }
} catch (e) {
  if (e !== null) { receipt.status = receipt.status === 'incomplete' ? 'error' : receipt.status; receipt.error = code(e); }
} finally {
  clearTimeout(watchdog);
  ChildProcess.prototype.spawn = protoSpawn;
  const forced = [...owned].map(c => ({ pid: c.pid ?? null, killed: c.kill('SIGKILL') }));
  receipt.cleanup = { remainingOwnedHandles: forced.length, forced, complete: forced.length === 0,
    root: ROOT ? redact(ROOT) : null, rootPreserved: ROOT ? fs.existsSync(ROOT) : null };
  save();
  // 0 only for a clean candidate diagnostic (still NOT acceptance), a discriminating negative control, or a clean
  // oracle-only self-check; baseline_only = 3; everything else 1.
  process.exitCode = ['diagnostic_clean_pending_review', 'negative_control_discriminates', 'oracle_only_ok'].includes(receipt.status) ? 0
    : receipt.status === 'baseline_only' ? 3 : 1;
  console.log(JSON.stringify({ status: receipt.status, error: receipt.error ?? null, findings: receipt.findings, receiptSha256: hash(fs.readFileSync(artifact)) }));
}
