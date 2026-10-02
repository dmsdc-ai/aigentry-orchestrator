#!/usr/bin/env node
// native-ps-width-probe.mjs — task #909 DIAGNOSTIC native ps width probe on OWNED synthetic
// fixtures only. Hardened successor of the attempt-1 probe (which threw on a null stdout after
// `spawnSync /bin/ps EPERM` and lost its owned child handles).
//
// What it does: spawns 3 harmless node children (no I/O, self-exit <=60s) whose argv carries a
// probe-owned SID, then reads ONLY `ps ... -p <child.pid>` for pids taken from our own spawn
// handles. Never -e/-A/--all/ax, never a guessed or foreign pid, never a numeric-pid signal
// (children are signalled only through their ChildProcess handle, and only while unexited).
//
// Usage:
//   probe:    node tests/platform/native-ps-width-probe.mjs --out <new-dir> --label <run-label>
//                  [--source-sha <sha>] [--ps <path>] [--deadline-ms <n<=55000>]
//   validate: node tests/platform/native-ps-width-probe.mjs --validate <run-dir> <run-dir> --out <new-dir>
// Exit: 0 evidence valid, 1 invalid/failed evidence (report still written), 2 usage/refused --out.
// A default-width (plain / -w) truncation is reported as a FINDING; it is never a production pass.
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'ps909-native-width-probe/1';
export const KINDS = ['short', 'long', 'unicode'];
export const FLAGS = { plain: [], w: ['-w'], ww: ['-ww'] };
export const COLS = ['unset', '80', '120', '256', '4096'];
export const LOCALES = ['C', 'en_US.UTF-8', 'C.UTF-8', 'ko_KR.UTF-8'];
export const REPS = 3;
export const EXPECTED_SAMPLES = KINDS.length * Object.keys(FLAGS).length * COLS.length * LOCALES.length * REPS; // 540

const CHILD_LIFETIME_MS = 60000;
const DEFAULT_DEADLINE_MS = 50000;
const MAX_DEADLINE_MS = 55000; // + cleanup bound stays under the child's own 60s lifetime
const PS_CALL_TIMEOUT_MS = 5000;
const READY_BOUND_MS = 10000;
const READY_POLL_MS = 25;
const TERM_GRACE_MS = 3000;
const KILL_WAIT_MS = 2000;
const SAFE_PATH = '/usr/bin:/bin';
const CONTROL_KEYWORD = 'nosuchkeyword909';
const CHILD_SRC = `// synthetic #909 fixture: no I/O, exits by itself after <=${CHILD_LIFETIME_MS / 1000}s\nsetTimeout(() => process.exit(0), ${CHILD_LIFETIME_MS});\n`;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const latin1 = (s) => Buffer.from(s).toString('latin1');
const tick = () => new Promise((r) => setImmediate(r));
const asBuf = (x) => (Buffer.isBuffer(x) ? x : x == null ? Buffer.alloc(0) : Buffer.from(String(x)));
const errInfo = (e) => ({ code: e?.code ?? null, syscall: e?.syscall ?? null, message: String(e?.message ?? e) });
// ps field delimiters are the ASCII bytes 0x09-0x0D and 0x20 only. JS \s / trim() would also
// treat latin1-decoded UTF-8 continuation bytes (0x85, 0xA0) as whitespace and split a locator.
const ASCII_WS = '\\t\\n\\v\\f\\r ';
const WS_RUN = new RegExp(`[${ASCII_WS}]+`);
const WS_LEAD = new RegExp(`^[${ASCII_WS}]+`);
const WS_TRAIL = new RegExp(`[${ASCII_WS}]+$`);
const asciiTrimStart = (s) => s.replace(WS_LEAD, '');
const asciiTrim = (s) => asciiTrimStart(s).replace(WS_TRAIL, '');
const fields = (s) => asciiTrim(s).split(WS_RUN);

class UsageError extends Error {}

// ---- nullable spawnSync normalisation: never turns an error into success -----------------
export function normalizeSync(r) {
  const res = r ?? {};
  const error = res.error ? errInfo(res.error) : null;
  const status = Number.isInteger(res.status) ? res.status : null;
  const signal = res.signal ?? null;
  let outcome;
  if (error) outcome = error.code === 'ETIMEDOUT' ? 'TIMEOUT' : error.code === 'EPERM' ? 'EPERM' : 'SPAWN_ERROR';
  else if (signal) outcome = 'SIGNALED';
  else if (status === null) outcome = 'NO_STATUS';
  else if (status !== 0) outcome = 'NONZERO';
  else outcome = 'OK';
  return {
    ok: outcome === 'OK', outcome, status, signal, error,
    stdout: asBuf(res.stdout), stderr: asBuf(res.stderr),
    stdoutNull: res.stdout == null, stderrNull: res.stderr == null,
  };
}

// ---- --out handling: must not exist; created here; never removed --------------------------
export function createOut(outArg) {
  if (!outArg) throw new UsageError('--out <new-dir> is required');
  const out = path.resolve(outArg);
  let exists = true;
  try { fs.lstatSync(out); } catch (e) { if (e.code === 'ENOENT') exists = false; else throw e; }
  if (exists) throw new UsageError(`refuse: --out ${out} already exists (runs are preserved, never overwritten)`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try { fs.mkdirSync(out); } catch (e) { if (e.code === 'EEXIST') throw new UsageError(`refuse: --out ${out} appeared concurrently`); throw e; }
  return out;
}

function makeCtx(opts, deps) {
  const now = deps.now ?? (() => performance.now());
  const deadlineMs = Math.min(Number(opts.deadlineMs ?? DEFAULT_DEADLINE_MS), MAX_DEADLINE_MS);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new UsageError('--deadline-ms must be a positive number');
  const t0 = now();
  return {
    opts, now, t0, deadlineMs, deadline: t0 + deadlineMs,
    spawn: deps.spawn ?? nodeSpawn,
    spawnSync: deps.spawnSync ?? nodeSpawnSync,
    harnessPid: deps.harnessPid ?? process.pid,
    execPath: deps.execPath ?? process.execPath,
    ps: opts.ps ?? '/bin/ps',
    owned: [], failures: [], samples: [], psCalls: 0,
  };
}
const elapsed = (ctx) => Math.round(ctx.now() - ctx.t0);
const remaining = (ctx) => ctx.deadline - ctx.now();
function fail(ctx, code, detail = null) { ctx.failures.push({ code, detail, atMs: elapsed(ctx) }); }

// One bounded ps call. Refuses to start past the overall monotonic deadline.
function runPs(ctx, args, env) {
  const argv = [ctx.ps, ...args];
  const left = remaining(ctx);
  if (left <= 0) return { argv, env, ...normalizeSync({ error: { code: 'DEADLINE', message: 'overall deadline reached before call' } }), outcome: 'DEADLINE', ms: 0 };
  const t = ctx.now();
  let r;
  ctx.psCalls++;
  try {
    r = ctx.spawnSync(ctx.ps, args, { env, stdio: ['pipe', 'pipe', 'pipe'], timeout: Math.max(1, Math.min(PS_CALL_TIMEOUT_MS, Math.floor(left))), maxBuffer: 1 << 20 });
  } catch (e) {
    r = { error: e };
  }
  return { argv, env, ...normalizeSync(r), ms: Math.round(ctx.now() - t) };
}

// ---- owned children ------------------------------------------------------------------------
function isAlive(rec) {
  return !!rec.h && !rec.neverStarted && !rec.exited && rec.pid !== null && rec.h.exitCode === null && rec.h.signalCode === null;
}

function spawnOwned(ctx, fx) {
  const args = [fx.cli, 'allow', '--id', fx.sid];
  const rec = {
    kind: fx.kind, sid: fx.sid, cli: fx.cli, argv: [ctx.execPath, ...args],
    h: null, pid: null, neverStarted: false, spawnError: null, errors: [],
    exited: false, exit: null, signalsSent: [], bind: { pre: null, post: null },
  };
  rec.settled = new Promise((resolve) => { rec.settle = resolve; });
  ctx.owned.push(rec); // tracked before anything below can throw
  let h;
  try {
    h = ctx.spawn(ctx.execPath, args, { stdio: 'ignore' });
  } catch (e) {
    rec.neverStarted = true; rec.spawnError = errInfo(e); rec.settle();
    return rec;
  }
  rec.h = h;
  h.on('error', (e) => {
    rec.errors.push({ ...errInfo(e), atMs: elapsed(ctx) });
    if (!Number.isInteger(h.pid)) { rec.neverStarted = true; rec.settle(); }
  });
  h.on('exit', (code, signal) => {
    rec.exited = true; rec.exit = { code, signal, atMs: elapsed(ctx) }; rec.settle();
  });
  if (Number.isInteger(h.pid)) rec.pid = h.pid;
  else rec.neverStarted = true; // 'error' follows; settle is also called there
  return rec;
}

// One binding read: exact owned pid, ppid == harness, argv already shows our SID (exec done).
function bindOnce(ctx, rec) {
  const r = runPs(ctx, ['-ww', '-p', String(rec.pid), '-o', 'pid=,ppid=,args='], { PATH: SAFE_PATH, LC_ALL: 'C' });
  const alive = isAlive(rec); // no comparison once the handle has exited
  const raw = r.stdout.toString('latin1');
  const f = fields(raw);
  const res = {
    outcome: r.outcome, status: r.status, signal: r.signal, error: r.error, stdoutNull: r.stdoutNull,
    raw, stderr: r.stderr.toString('latin1'), aliveAfter: alive, atMs: elapsed(ctx),
  };
  if (!r.ok) return { ...res, state: `PS_${r.outcome}` };
  if (!alive) return { ...res, state: 'CHILD_EXITED' };
  const pidOk = f[0] === String(rec.pid);
  const ppidOk = f[1] === String(ctx.harnessPid);
  const sidOk = f.slice(2).includes(latin1(rec.sid));
  Object.assign(res, { pidOk, ppidOk, sidOk });
  if (!pidOk) return { ...res, state: 'BAD_PID_ROW' };
  if (!ppidOk) return { ...res, state: 'BAD_PPID' };
  return { ...res, state: sidOk ? 'BOUND' : 'NOT_EXPOSED' };
}

// Bounded readiness poll (no fixed sleep): waits until the owned child exposes its SID argv.
async function bindPoll(ctx, rec) {
  const until = Math.min(ctx.deadline, ctx.now() + READY_BOUND_MS);
  const attempts = [];
  for (;;) {
    if (!isAlive(rec)) return { ok: false, state: 'CHILD_EXITED', attempts };
    if (ctx.now() >= until) return { ok: false, state: ctx.now() >= ctx.deadline ? 'DEADLINE' : 'READINESS_TIMEOUT', attempts };
    const b = bindOnce(ctx, rec);
    attempts.push(b);
    if (b.state === 'BOUND') return { ok: true, state: 'BOUND', attempts };
    if (b.state !== 'NOT_EXPOSED') return { ok: false, state: b.state, attempts };
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(READY_POLL_MS, until - ctx.now()))));
  }
}

async function waitSettled(recs, ms) {
  if (!recs.length) return;
  let timer;
  await Promise.race([Promise.all(recs.map((r) => r.settled)), new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

function signalOwned(ctx, rec, sig) {
  if (!isAlive(rec)) return; // never signal an exited handle
  try { rec.signalsSent.push({ signal: sig, delivered: rec.h.kill(sig), atMs: elapsed(ctx) }); }
  catch (e) { rec.errors.push({ ...errInfo(e), during: `kill ${sig}`, atMs: elapsed(ctx) }); }
}

// Graceful terminate, then bounded kill/wait — only our own handles.
async function cleanupOwned(ctx) {
  const live = ctx.owned.filter(isAlive);
  for (const rec of live) signalOwned(ctx, rec, 'SIGTERM');
  await waitSettled(live.filter(isAlive), TERM_GRACE_MS);
  const stubborn = live.filter(isAlive);
  for (const rec of stubborn) signalOwned(ctx, rec, 'SIGKILL');
  await waitSettled(stubborn.filter(isAlive), KILL_WAIT_MS);
  return ctx.owned.map((rec) => {
    const state = rec.neverStarted ? 'NEVER_STARTED' : rec.exited ? 'EXITED' : 'NOT_CONFIRMED';
    if (state === 'NOT_CONFIRMED' && rec.h?.unref) rec.h.unref(); // self-exits <=60s; do not hold the harness
    return state;
  });
}

// ---- sample analysis (byte-faithful, latin1) ------------------------------------------------
export function analyse(rec, stdout) {
  const text = stdout.toString('latin1');
  const lines = text.split('\n');
  const pidStr = String(rec.pid);
  const rows = lines.filter((l) => fields(l)[0] === pidStr);
  const row = rows[0] ?? '';
  const flds = fields(row);
  const sidB = latin1(rec.sid);
  const cliB = latin1(rec.cli);
  const nodeB = latin1(rec.argv[0]);
  // production owner predicate s2 (node E allow --id sid), field-exact, E = locator
  const s2 = flds[3] === 'allow' && flds[4] === '--id' && flds[5] === sidB && path.basename(flds[1] || '') === 'node' && flds[2] === cliB;
  const fullCmd = latin1(rec.argv.join(' '));
  const cmdField = asciiTrimStart(asciiTrim(row).slice(pidStr.length));
  return {
    rowCount: rows.length,
    rowBytes: Buffer.byteLength(row, 'latin1'),
    fullCmdBytes: Buffer.byteLength(rec.argv.join(' ')),
    lineBytes: lines.map((l) => Buffer.byteLength(l, 'latin1')).filter((n, i, a) => i < a.length - 1 || n > 0),
    sidSubstr: row.includes(sidB),
    sidField: flds.includes(sidB),
    sidCount: row.split(sidB).length - 1,
    locatorSubstr: row.includes(cliB),
    locatorField: flds[2] === cliB,
    nodeField: flds[1] === nodeB,
    ownerPredicate: s2,
    // strict-prefix of the full argv = width truncation; anything else non-equal = mangled/other
    commandShape: cmdField === fullCmd ? 'FULL' : cmdField.length > 0 && fullCmd.startsWith(cmdField) ? 'TRUNCATED_PREFIX' : rows.length ? 'DIFFERENT' : 'NO_ROW',
    tail: row.slice(-24),
  };
}

function fixtures(out, label) {
  const FX = path.join(out, 'fx');
  const longDir = path.join(FX, 'long', ...Array.from({ length: 3 }, (_, i) => `L${i}` + 'x'.repeat(200)));
  const list = [
    { kind: 'short', dir: path.join(FX, 's') },
    { kind: 'long', dir: longDir },
    { kind: 'unicode', dir: path.join(FX, '유니코드-é-ünï-路径') },
  ];
  for (const f of list) {
    fs.mkdirSync(f.dir, { recursive: true });
    f.cli = path.join(f.dir, 'cli.js');
    fs.writeFileSync(f.cli, CHILD_SRC);
    fs.chmodSync(f.cli, 0o755); // the replayed parser requires TELEPTY to be -f -x
    if (WS_RUN.test(latin1(f.cli))) throw new Error(`locator must be no-space: ${f.kind}`);
    f.sid = `ps909-${label}-${f.kind}-${crypto.randomBytes(4).toString('hex')}`;
  }
  return list;
}

// Locale availability is recorded; an unavailable locale is not native proof for that locale.
function probeLocales(ctx) {
  let r;
  try { r = normalizeSync(ctx.spawnSync('locale', ['-a'], { env: { PATH: SAFE_PATH }, stdio: ['pipe', 'pipe', 'pipe'], timeout: PS_CALL_TIMEOUT_MS, maxBuffer: 1 << 20 })); }
  catch (e) { r = normalizeSync({ error: e }); }
  const norm = (s) => s.toLowerCase().replace(/utf-?8/, 'utf8');
  const listed = r.ok ? r.stdout.toString('latin1').split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const set = new Set(listed.map(norm));
  return {
    probe: { argv: ['locale', '-a'], outcome: r.outcome, status: r.status, error: r.error, stderr: r.stderr.toString('latin1') },
    availability: Object.fromEntries(LOCALES.map((l) => [l, !r.ok ? 'unknown' : set.has(norm(l)) || (l === 'C') ? 'available' : 'unavailable'])),
    note: "'C' is POSIX-builtin; 'unknown' when locale -a failed. Samples under an unavailable/unknown locale are recorded but are not native proof for that locale.",
  };
}

function fileSha(p) {
  try { return { realpath: fs.realpathSync(p), sha256: sha(fs.readFileSync(p)) }; }
  catch (e) { return { realpath: null, sha256: null, error: errInfo(e) }; }
}

// ---- the probe -----------------------------------------------------------------------------
export async function runProbe(opts, deps = {}) {
  const label = opts.label;
  if (!label || !/^[A-Za-z0-9._-]+$/.test(label)) throw new UsageError('--label <[A-Za-z0-9._-]+> is required');
  const ctx = makeCtx(opts, deps);
  const out = createOut(opts.out);
  const rawDir = path.join(out, 'raw');
  fs.mkdirSync(rawDir);
  let psFailure = { classification: 'NOT_RUN', reason: 'not reached' };
  let locales = null;
  let cleanupStates = [];
  let crash = null;

  try {
    locales = probeLocales(ctx);
    const fxs = fixtures(out, label);
    for (const fx of fxs) spawnOwned(ctx, fx); // try/finally covers the very first spawn
    for (const rec of ctx.owned) if (rec.neverStarted) fail(ctx, 'SPAWN_FAILED', { kind: rec.kind, spawnError: rec.spawnError });

    let id = 0;
    matrix: for (const rec of ctx.owned) {
      if (ctx.failures.length) break;
      rec.bind.pre = await bindPoll(ctx, rec);
      if (!rec.bind.pre.ok) { fail(ctx, `BIND_PRE_${rec.bind.pre.state}`, { kind: rec.kind }); break; }
      for (const [fk, fl] of Object.entries(FLAGS)) for (const col of COLS) for (const loc of LOCALES) for (let rep = 1; rep <= REPS; rep++) {
        if (remaining(ctx) <= 0) { fail(ctx, 'DEADLINE', { kind: rec.kind, at: `${fk}|${col}|${loc}|${rep}` }); break matrix; }
        await tick();
        if (!isAlive(rec)) { fail(ctx, 'CHILD_EXITED_BEFORE_SAMPLE', { kind: rec.kind, exit: rec.exit }); break matrix; }
        const env = { PATH: SAFE_PATH, LC_ALL: loc };
        if (col !== 'unset') env.COLUMNS = col;
        const r = runPs(ctx, [...fl, '-p', String(rec.pid), '-o', 'pid,command'], env);
        await tick();
        const post = isAlive(rec);
        const sid = `s${String(++id).padStart(4, '0')}`;
        fs.writeFileSync(path.join(rawDir, `${sid}.out`), r.stdout);
        fs.writeFileSync(path.join(rawDir, `${sid}.err`), r.stderr);
        const s = {
          id: sid, kind: rec.kind, pid: rec.pid, flags: fk, columns: col, locale: loc, rep,
          localeAvailability: locales.availability[loc],
          argv: r.argv, env, outcome: r.outcome, exit: r.status, signal: r.signal, error: r.error, ms: r.ms,
          stdoutNull: r.stdoutNull, stderrNull: r.stderrNull,
          stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length, stdoutSha: sha(r.stdout),
          stdoutB64: r.stdout.toString('base64'), stderrB64: r.stderr.toString('base64'),
          aliveBefore: true, aliveAfter: post, valid: false,
        };
        ctx.samples.push(s);
        if (!post) { fail(ctx, 'CHILD_EXITED_DURING_SAMPLE', { id: sid, kind: rec.kind, exit: rec.exit }); break matrix; }
        if (!r.ok) { fail(ctx, `PS_${r.outcome}`, { id: sid, error: r.error, status: r.status, stderr: r.stderr.toString('latin1').slice(0, 400) }); break matrix; }
        s.valid = true;
        // out and SID first: pid digits can occur inside them
        s.normSha = sha(r.stdout.toString('latin1').split(latin1(out)).join('<OUT>').split(rec.sid).join('<SID>').split(String(rec.pid)).join('<PID>'));
        Object.assign(s, analyse(rec, r.stdout));
      }
      rec.bind.post = bindOnce(ctx, rec);
      if (rec.bind.post.state !== 'BOUND') { fail(ctx, `BIND_POST_${rec.bind.post.state}`, { kind: rec.kind }); break; }
    }

    // standard-error control: invalid keyword on an owned live pid -> nonzero = UNKNOWN, never absence
    const ctl = ctx.owned[0];
    if (ctx.failures.length) psFailure = { classification: 'NOT_RUN', reason: 'run already invalidated' };
    else if (!isAlive(ctl)) { psFailure = { classification: 'NOT_RUN', reason: 'control child not alive' }; fail(ctx, 'CONTROL_NOT_RUN'); }
    else {
      const r = runPs(ctx, ['-p', String(ctl.pid), '-o', `pid,${CONTROL_KEYWORD}`], { PATH: SAFE_PATH, LC_ALL: 'C' });
      const aliveAfter = isAlive(ctl);
      psFailure = {
        argv: r.argv, outcome: r.outcome, exit: r.status, signal: r.signal, error: r.error, aliveAfter,
        stdout: r.stdout.toString('latin1'), stderr: r.stderr.toString('latin1'),
        classification: !aliveAfter ? 'INVALID(child exited)' : r.outcome === 'OK' ? 'UNEXPECTED_OK' : r.outcome === 'NONZERO' ? 'UNKNOWN(ps failed)' : `INVALID(${r.outcome})`,
      };
      if (psFailure.classification !== 'UNKNOWN(ps failed)') fail(ctx, 'CONTROL_UNEXPECTED', { classification: psFailure.classification });
    }
  } catch (e) {
    crash = { ...errInfo(e), stack: String(e?.stack ?? '') };
    fail(ctx, 'HARNESS_EXCEPTION', crash.message);
  } finally {
    try { cleanupStates = await cleanupOwned(ctx); }
    catch (e) { fail(ctx, 'CLEANUP_EXCEPTION', errInfo(e)); }
  }
  if (cleanupStates.some((s) => s === 'NOT_CONFIRMED')) fail(ctx, 'CLEANUP_INCOMPLETE', cleanupStates);
  return writeRunReport(ctx, { out, label, locales, psFailure, crash });
}

function summarise(samples) {
  const groups = new Map();
  for (const s of samples.filter((x) => x.valid)) {
    const k = `${s.kind}|${s.flags}|${s.columns}|${s.locale}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const rows = [];
  let nondet = 0;
  for (const [k, g] of groups) {
    const same = g.every((s) => s.stdoutSha === g[0].stdoutSha && s.exit === g[0].exit);
    if (!same) nondet++;
    rows.push({ key: k, same, s: g[0], n: g.length });
  }
  return { rows, nondet };
}

function writeRunReport(ctx, { out, label, locales, psFailure, crash }) {
  const { rows, nondet } = summarise(ctx.samples);
  const valid = ctx.samples.filter((s) => s.valid);
  if (nondet) fail(ctx, 'NONDETERMINISTIC_REPS', { groups: nondet });
  if (!ctx.failures.length && valid.length !== EXPECTED_SAMPLES) fail(ctx, 'MATRIX_INCOMPLETE', { valid: valid.length, expected: EXPECTED_SAMPLES });
  const wwBad = valid.filter((s) => s.flags === 'ww' && !(s.rowCount === 1 && s.sidField && s.locatorField && s.ownerPredicate));
  if (wwBad.length) fail(ctx, 'WW_POSITIVE_MISSING', wwBad.map((s) => ({ id: s.id, kind: s.kind, columns: s.columns, locale: s.locale, commandShape: s.commandShape })));
  const defaultBad = valid.filter((s) => s.flags !== 'ww' && !s.ownerPredicate);

  const tsv = ['kind\tflags\tcolumns\tlocale\tlocale_avail\treps\treps_identical\texit\tstdout_bytes\trow_bytes\tfull_cmd_bytes\tsid_field\tlocator_field\towner_predicate\tcommand_shape\tnorm_sha12'];
  for (const { key, same, s, n } of rows) tsv.push([...key.split('|'), s.localeAvailability, n, same ? 'yes' : 'NO', s.exit, s.stdoutBytes, s.rowBytes, s.fullCmdBytes, s.sidField, s.locatorField, s.ownerPredicate, s.commandShape, s.normSha.slice(0, 12)].join('\t'));

  const selfPath = fileURLToPath(import.meta.url);
  const sourceShaArg = ctx.opts.sourceSha ?? null;
  const githubSha = process.env.GITHUB_SHA ?? null;
  const shaAgreement = sourceShaArg && githubSha ? sourceShaArg === githubSha : null;
  if (shaAgreement === false) fail(ctx, 'SOURCE_SHA_MISMATCH', { sourceShaArg, githubSha });

  const meta = {
    schema: SCHEMA, label, status: ctx.failures.length ? 'INVALID' : 'VALID', failures: ctx.failures, crash,
    source: {
      harnessSha256: fileSha(selfPath).sha256, harnessFile: path.basename(selfPath),
      sourceShaArg, githubSha, shaAgreement, githubRef: process.env.GITHUB_REF ?? null,
      githubRunId: process.env.GITHUB_RUN_ID ?? null, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null, attempt: process.env.AIGENTRY_WORKER_ATTEMPT ?? null,
    },
    runtime: { node: process.version, execPath: ctx.execPath, harnessPid: ctx.harnessPid, argv: process.argv },
    os: { platform: os.platform(), type: os.type(), release: os.release(), version: typeof os.version === 'function' ? os.version() : null, arch: os.arch(), runnerOs: process.env.RUNNER_OS ?? null, imageOs: process.env.ImageOS ?? null },
    ps: { path: ctx.ps, ...fileSha(ctx.ps) },
    stdio: 'ps stdin/stdout/stderr all pipes (no tty)',
    selection: {
      probe: 'ps [plain|-w|-ww] -p <owned child pid> -o pid,command',
      production: 'ps -eo pid,command (all-process selection, platform-unix.sh)',
      note: 'selection differs (-p owned pid vs -e all); width/encoding behaviour is measured here, whole-production behaviour is NOT proven',
    },
    matrix: { kinds: KINDS, flags: Object.keys(FLAGS), columns: COLS, locales: LOCALES, reps: REPS, expectedSamples: EXPECTED_SAMPLES, reductions: 'none' },
    locales,
    bounds: { deadlineMs: ctx.deadlineMs, elapsedMs: elapsed(ctx), psCalls: ctx.psCalls, childLifetimeMs: CHILD_LIFETIME_MS, psCallTimeoutMs: PS_CALL_TIMEOUT_MS, readyBoundMs: READY_BOUND_MS },
    children: ctx.owned.map((rec) => ({
      kind: rec.kind, pid: rec.pid, argv: rec.argv, sid: rec.sid, cli: rec.cli, cliBytes: Buffer.byteLength(rec.cli),
      neverStarted: rec.neverStarted, spawnError: rec.spawnError, errors: rec.errors,
      cleanup: rec.neverStarted ? 'NEVER_STARTED' : rec.exited ? 'EXITED' : 'NOT_CONFIRMED', exit: rec.exit, signalsSent: rec.signalsSent, bind: rec.bind,
    })),
    psFailure,
    sampleCount: ctx.samples.length, validSamples: valid.length, nondeterministicGroups: nondet,
    findings: {
      wwPositiveFailures: wwBad.length,
      defaultWidth: {
        outcome: defaultBad.length ? 'FINDING_OWNER_PREDICATE_FAILS_WITHOUT_WW' : valid.length ? 'OWNER_PREDICATE_HELD_IN_ALL_DEFAULT_SAMPLES' : 'UNMEASURED',
        failingSamples: defaultBad.length,
        byShape: defaultBad.reduce((a, s) => ((a[s.commandShape] = (a[s.commandShape] ?? 0) + 1), a), {}),
        groups: [...new Set(defaultBad.map((s) => `${s.kind}|${s.flags}|${s.columns}|${s.locale}`))],
        note: 'measurement, not assumption; a default-width failure is a production finding and is NOT waived as a pass',
      },
    },
  };
  meta.status = ctx.failures.length ? 'INVALID' : 'VALID';
  meta.failures = ctx.failures;

  const raw = { status: meta.status, label, out, failures: ctx.failures.map((f) => f.code), samples: ctx.samples.length, psCalls: ctx.psCalls, cleanup: meta.children.map((c) => `${c.kind}:${c.cleanup}`), defaultWidth: meta.findings.defaultWidth.outcome };
  try {
    fs.writeFileSync(path.join(out, 'samples.jsonl'), ctx.samples.map((s) => JSON.stringify(s)).join('\n') + (ctx.samples.length ? '\n' : ''));
    fs.writeFileSync(path.join(out, 'summary.tsv'), tsv.join('\n') + '\n');
    fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (e) {
    raw.reportWriteError = errInfo(e);
    raw.status = 'INVALID';
    process.stderr.write(JSON.stringify(meta) + '\n'); // the evidence is not lost even if the disk write fails
  }
  return { code: raw.status === 'VALID' ? 0 : 1, raw, meta };
}

// ---- validator over two owned runs -----------------------------------------------------------
export function validateRuns(dirs) {
  const problems = [];
  const runs = [];
  if (dirs.length !== 2) problems.push(`expected exactly 2 run dirs, got ${dirs.length}`);
  for (const d of dirs) {
    const tag = path.basename(d);
    let meta, samples;
    try { meta = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf8')); }
    catch (e) { problems.push(`${tag}: meta.json missing/unreadable (${e.code ?? e.message})`); continue; }
    try { samples = fs.readFileSync(path.join(d, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch (e) { problems.push(`${tag}: samples.jsonl missing/unreadable (${e.code ?? e.message})`); continue; }
    if (meta.schema !== SCHEMA) problems.push(`${tag}: schema ${meta.schema} != ${SCHEMA}`);
    if (meta.status !== 'VALID') problems.push(`${tag}: run status ${meta.status} (${(meta.failures ?? []).map((f) => f.code).join(',')})`);
    if (samples.length !== EXPECTED_SAMPLES || samples.some((s) => !s.valid)) problems.push(`${tag}: invalid/missing samples (${samples.filter((s) => s.valid).length}/${EXPECTED_SAMPLES} valid)`);
    const ww = samples.filter((s) => s.flags === 'ww');
    const wwBad = ww.filter((s) => !(s.valid && s.rowCount === 1 && s.sidField && s.locatorField && s.ownerPredicate));
    if (ww.length !== EXPECTED_SAMPLES / 3 || wwBad.length) problems.push(`${tag}: -ww positives missing/wrong (${wwBad.length} bad of ${ww.length})`);
    for (const s of samples) {
      let b;
      try { b = fs.readFileSync(path.join(d, 'raw', `${s.id}.out`)); } catch { problems.push(`${tag}: raw/${s.id}.out missing`); continue; }
      if (sha(b) !== s.stdoutSha) problems.push(`${tag}: raw/${s.id}.out sha mismatch`);
    }
    const kids = meta.children ?? [];
    if (kids.length !== KINDS.length || kids.some((c) => c.cleanup !== 'EXITED')) problems.push(`${tag}: cleanup evidence incomplete (${kids.map((c) => `${c.kind}:${c.cleanup}`).join(',')})`);
    if (kids.some((c) => !c.bind?.pre?.ok || c.bind?.post?.state !== 'BOUND')) problems.push(`${tag}: ppid binding pre/post evidence missing or failed`);
    if (meta.psFailure?.classification !== 'UNKNOWN(ps failed)') problems.push(`${tag}: standard-error control ${meta.psFailure?.classification}`);
    if (meta.nondeterministicGroups !== 0) problems.push(`${tag}: nondeterministic reps`);
    if (meta.source?.shaAgreement !== true) problems.push(`${tag}: checkout SHA not captured/agreeing (${meta.source?.sourceShaArg} vs ${meta.source?.githubSha})`);
    runs.push({ tag, meta, samples });
  }
  if (runs.length === 2) {
    const [a, b] = runs;
    if (a.meta.label === b.meta.label) problems.push('runs share a label (not two owned runs)');
    if (a.meta.source.harnessSha256 !== b.meta.source.harnessSha256) problems.push('harness sha differs across runs');
    if (a.meta.source.sourceShaArg !== b.meta.source.sourceShaArg) problems.push('source sha differs across runs');
    const shape = (s) => [s.exit, s.rowCount, s.sidField, s.locatorField, s.ownerPredicate, s.commandShape].join('/');
    const key = (s) => `${s.kind}|${s.flags}|${s.columns}|${s.locale}|${s.rep}`;
    const bm = new Map(b.samples.map((s) => [key(s), shape(s)]));
    const div = a.samples.filter((s) => bm.has(key(s)) && bm.get(key(s)) !== shape(s)).map(key);
    if (div.length) problems.push(`cross-run structural divergence in ${div.length} samples (first: ${div[0]})`);
  }
  const defaults = runs.map((r) => r.meta.findings?.defaultWidth?.outcome ?? 'UNMEASURED');
  const finding = defaults.some((o) => o !== 'OWNER_PREDICATE_HELD_IN_ALL_DEFAULT_SAMPLES');
  return {
    harnessEvidence: problems.length ? 'FAIL' : 'PASS',
    problems,
    productionDefaultWidth: finding ? 'FINDING_NOT_WAIVED' : 'HELD_IN_PROBE_SELECTION',
    defaultWidthOutcomes: Object.fromEntries(runs.map((r) => [r.tag, r.meta.findings?.defaultWidth])),
    productionClaim: 'NONE — probe uses `-p <owned pid>` selection; production `ps -eo` behaviour is not proven by this lane',
    os: runs[0]?.meta.os ?? null,
  };
}

// ---- CLI -------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { validate: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') o.out = val();
    else if (a === '--label') o.label = val();
    else if (a === '--source-sha') o.sourceSha = val();
    else if (a === '--ps') o.ps = val();
    else if (a === '--deadline-ms') o.deadlineMs = Number(val());
    else if (a === '--validate') { o.validate = [val(), val()]; }
    else throw new UsageError(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    if (o.validate) {
      const out = createOut(o.out);
      const v = validateRuns(o.validate.map((d) => path.resolve(d)));
      fs.writeFileSync(path.join(out, 'validation.json'), JSON.stringify(v, null, 2));
      console.log(JSON.stringify(v, null, 2));
      if (v.productionDefaultWidth === 'FINDING_NOT_WAIVED') console.log('::warning title=ps width finding::default-width (plain/-w) owner predicate failed in at least one sample; NOT waived as a production pass');
      if (v.harnessEvidence !== 'PASS') console.log(`::error title=ps width probe evidence invalid::${v.problems.join(' ; ')}`);
      process.exitCode = v.harnessEvidence === 'PASS' ? 0 : 1;
      return;
    }
    const { code, raw } = await runProbe(o);
    console.log(JSON.stringify(raw));
    process.exitCode = code;
  } catch (e) {
    if (e instanceof UsageError) { console.error(e.message); process.exitCode = 2; return; }
    console.error(JSON.stringify({ status: 'INVALID', fatal: errInfo(e), stack: String(e?.stack ?? '') }));
    process.exitCode = 1;
  }
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) await main();
