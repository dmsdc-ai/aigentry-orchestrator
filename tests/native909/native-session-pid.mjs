#!/usr/bin/env node
// native-session-pid.mjs — #909 native process-identity check for platform::session_pid.
//
// Runs the PINNED fixture copies under tests/native909/fixtures/ (the real platform.sh
// dispatcher plus the candidate, and the prior backend as a paired comparator) against
// processes this run creates itself, using the OS's real ps and locale. It is meant for
// one place only: a disposable GitHub-hosted macOS/Linux runner started by
// .github/workflows/native-909-nt909sw.yml on the reserved test branch. Anywhere else it
// refuses before any process query. That guard stops an accidental local run; it is
// not a security boundary.
//
// What it never does: pkill/pgrep, kill by sid, its own process enumeration, dumping a
// ps listing or the inherited environment, network, auth, or any telepty. The only
// process query is the product's own `ps`. Children are cleaned up through the handles
// this run holds. Node 20 stdlib only.
//
// Modes:
//   --mode=positive          full case table (exit 0 all pass, 1 any fail, 2 incomplete)
//   --mode=negative-control  exact-match positive + two mutated oracles (must exit 1)
//   --check-negative-control=<results.json>   file-only verdict on a negative-control run
// Exit 3 = refused (guard). Missing preconditions are INCOMPLETE (exit 2), never a skip.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'test/909-native-nt909sw-20261003';
const WORKFLOW_FILE = '.github/workflows/native-909-nt909sw.yml';
const OPT_IN = '--disposable-github-hosted-vm-owned-processes-only';
const LANES = {
  darwin: { runnerOs: 'macOS', imageOs: 'macos14', osType: 'macos' },
  linux: { runnerOs: 'Linux', imageOs: 'ubuntu22', osType: 'linux' },
};
const PINS = [
  ['fixtures/candidate/platform.sh', 1369, 'd37b262cb16b12cc02b5ccb4ed54582699c1845aba6fdcb9e6e864ffe25ff6f2'],
  ['fixtures/candidate/platform-unix.sh', 16135, 'b74f8b058af5a844f85f34f3c3caf82f7e5968121a9bad64d5c9586eb0c5d59b'],
  ['fixtures/prior/platform.sh', 1369, 'd37b262cb16b12cc02b5ccb4ed54582699c1845aba6fdcb9e6e864ffe25ff6f2'],
  ['fixtures/prior/platform-unix.sh', 15778, 'd8194b7e85c487b66ae36e565fc0485757238b24d400767d508f93e82eecbc40'],
  ['fake-telepty.cjs', 1153, '684a7544ad1a340e205896c5440201aa6feb2588a503fe07ad2de2b8bbfcf6a2'],
];
const SRC = {
  candidate: path.join(HERE, 'fixtures/candidate/platform.sh'),
  prior: path.join(HERE, 'fixtures/prior/platform.sh'),
};
const BASH = '/bin/bash';
const SYS_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
// sid and timeout arrive as positional parameters; nothing is interpolated into this text.
const PRODUCT_SCRIPT = 'source "$1" || exit 90; platform::session_pid "$2" "$3"';
const BADLOC = 'xx_XX.BOGUS909';
const READY_MS = 10000;
const PRODUCT_SLACK_MS = 20000;
const RUN_BUDGET_MS = 420000;
const CONTRAST_REPS = 10;
const EXIT = { pass: 0, fail: 1, incomplete: 2, refused: 3 };

// ---------------------------------------------------------------------------
// args + guard
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? undefined : hit.slice(name.length + 3);
};

function guardFailures(mode, out) {
  const e = process.env;
  const lane = LANES[process.platform];
  const bad = [];
  if (!argv.includes(OPT_IN)) bad.push(`missing ${OPT_IN}`);
  if (mode !== 'positive' && mode !== 'negative-control') bad.push('--mode must be positive|negative-control');
  if (!out || !path.isAbsolute(out)) bad.push('--out must be an absolute path');
  if (!lane) bad.push(`platform ${process.platform} is not darwin|linux`);
  if (e.GITHUB_ACTIONS !== 'true' || e.CI !== 'true') bad.push('not GitHub Actions');
  if (e.RUNNER_ENVIRONMENT !== 'github-hosted') bad.push('RUNNER_ENVIRONMENT != github-hosted');
  if (lane && e.RUNNER_OS !== lane.runnerOs) bad.push(`RUNNER_OS != ${lane.runnerOs}`);
  if (lane && e.ImageOS !== lane.imageOs) bad.push(`ImageOS != ${lane.imageOs}`);
  if (e.GITHUB_EVENT_NAME !== 'push') bad.push('GITHUB_EVENT_NAME != push');
  if (e.GITHUB_REF !== `refs/heads/${BRANCH}`) bad.push(`GITHUB_REF != refs/heads/${BRANCH}`);
  if (!(e.GITHUB_WORKFLOW_REF || '').endsWith(`/${WORKFLOW_FILE}@refs/heads/${BRANCH}`)) bad.push('GITHUB_WORKFLOW_REF is not this workflow on the reserved branch');
  if (!e.RUNNER_TEMP || !path.isAbsolute(e.RUNNER_TEMP) || !fs.existsSync(e.RUNNER_TEMP)) bad.push('RUNNER_TEMP missing');
  if (typeof process.getuid !== 'function' || process.getuid() === 0) bad.push('uid 0 or unknown');
  if (path.basename(process.execPath) !== 'node') bad.push('node execPath basename is not node');
  return bad;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function verifyPins() {
  return PINS.map(([rel, bytes, want]) => {
    const file = path.join(HERE, rel);
    let got = 'missing';
    let size = -1;
    try {
      size = fs.statSync(file).size;
      got = sha256(file);
    } catch {}
    return { rel, bytes: size, sha256: got, ok: size === bytes && got === want, want };
  });
}

const SAFE_RE = /[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:@+=-]/g;
const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);
const safeOf = (sid) => sid.replace(SAFE_RE, '?').slice(0, 128);
const STARTUP_RE = /^[^\n]*bash: warning: setlocale: [^\n]*\n/gm;
const timeoutAfter = (ms) => new Promise((res) => setTimeout(() => res('timeout'), ms));

const owned = new Set();
let commands = [];
// The run document, once main has built it, so abort() can write what was collected.
const run = { doc: null };

function track(proc, meta) {
  const h = { proc, meta, pid: proc.pid, exited: false, code: null, signal: null, group: !!meta.group };
  owned.add(h);
  h.exitP = new Promise((res) => {
    proc.once('exit', (code, signal) => {
      // exitUnrequested is fixed when the exit event arrives: no stop had been asked for.
      h.exited = true; h.code = code; h.signal = signal; h.exitUnrequested = !h.stopRequested; owned.delete(h); res();
    });
    proc.once('error', (err) => {
      h.spawnError = err.code || 'spawn-error';
      if (proc.pid === undefined) { h.exited = true; owned.delete(h); res(); }
    });
  });
  return h;
}

function hardKill(h) {
  try {
    if (h.group && h.pid) process.kill(-h.pid, 'SIGKILL'); else h.proc.kill('SIGKILL');
  } catch {}
}

// Stop one owned child: stdin EOF first (the fake exits 0 on it), then TERM, then KILL,
// each bounded. Never anything but this handle (or the process group it leads).
async function stopOwned(h) {
  if (h.exited) return { how: 'already-exited', code: h.code, signal: h.signal, reaped: true, unrequested: !!h.exitUnrequested };
  h.stopRequested = true;
  let how = 'stdin-eof';
  try { h.proc.stdin && h.proc.stdin.end(); } catch {}
  if ((await Promise.race([h.exitP, timeoutAfter(5000)])) === 'timeout') {
    how = 'sigterm';
    try { if (h.group) process.kill(-h.pid, 'SIGTERM'); else h.proc.kill('SIGTERM'); } catch {}
    if ((await Promise.race([h.exitP, timeoutAfter(3000)])) === 'timeout') {
      how = 'sigkill';
      hardKill(h);
      if ((await Promise.race([h.exitP, timeoutAfter(3000)])) === 'timeout') {
        return { how: 'unreaped', reaped: false };
      }
    }
  }
  return { how, code: h.code, signal: h.signal, reaped: true };
}

// A fixture child must live until this run asks it to stop. Judged from exit-event state only:
// an exit nobody requested, or an EOF stop that did not end in the fake's own clean exit 0
// (the child was already gone when the stop began, its exit event still in flight).
function fixtureLost(h, stop) {
  if (h.exited && h.exitUnrequested) return `exited unrequested (code ${h.code}, signal ${h.signal})`;
  if (stop && stop.how === 'stdin-eof' && (stop.code !== 0 || stop.signal)) return `ended code ${stop.code} signal ${stop.signal} on its EOF stop`;
  return null;
}

async function stopAll() {
  const res = [];
  for (const h of [...owned]) res.push({ pid: h.pid, role: h.meta.role, ...(await stopOwned(h)) });
  return res;
}

// ---------------------------------------------------------------------------
// fixture world (all under a fresh dir in RUNNER_TEMP)
// ---------------------------------------------------------------------------

function buildWorld() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'nt909-')));
  const fake = fs.readFileSync(path.join(HERE, 'fake-telepty.cjs'));
  const put = (rel) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, fake, { mode: 0o755 });
    fs.chmodSync(f, 0o755);
    return f;
  };
  const canon = put('pkg/cli.js');
  const other = put('otherpkg/cli.js');
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.symlinkSync('../pkg/cli.js', path.join(tmp, 'bin/telepty'));
  const chain = (n) => {
    const d = path.join(tmp, `chain${n}`);
    fs.mkdirSync(d);
    for (let i = 0; i < n; i++) fs.symlinkSync(i === n - 1 ? '../pkg/cli.js' : `l${i + 1}`, path.join(d, `l${i}`));
    let cur = path.join(d, 'l0');
    let hops = 0;
    while (fs.lstatSync(cur).isSymbolicLink()) { cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur)); hops++; }
    if (hops !== n || cur !== canon) throw new Error(`chain${n} built wrong (${hops})`);
    return path.join(d, 'l0');
  };
  const loc = {
    abs: { env: { TELEPTY: canon }, given: canon },
    path: { env: {}, given: path.join(tmp, 'bin/telepty'), bareCwd: path.join(tmp, 'bin') },
    chain32: { env: { TELEPTY: chain(32) } },
    chain40: { env: { TELEPTY: chain(40) } },
  };
  for (const l of Object.values(loc)) { l.canon = canon; l.given = l.given || l.env.TELEPTY; }
  return { tmp, canon, other, loc, pathEnv: `${path.join(tmp, 'bin')}:${SYS_PATH}` };
}

function localeEnv(kind) {
  if (kind === 'badloc') return { LANG: BADLOC, LC_ALL: BADLOC, LC_CTYPE: BADLOC };
  const out = {};
  for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE']) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

// ---------------------------------------------------------------------------
// owned children + product invocation
// ---------------------------------------------------------------------------

async function spawnFake(world, locName, c) {
  const loc = world.loc[locName];
  const a1 = { given: loc.given, canon: loc.canon, bare: 'telepty', other: world.other }[c.argv1 || 'given'];
  const tail = {
    std: ['allow', '--id', c.sid, '--auto-restart', 'nt909fx-agent'],
    last: ['allow', '--id', c.sid],
    wrap: ['wrap', 'allow', '--id', c.sid],
    eq: ['allow', `--id=${c.sid}`],
  }[c.shape || 'std'];
  const args = [a1, ...tail];
  const cwd = c.argv1 === 'bare' ? loc.bareCwd : world.tmp;
  commands.push({ kind: 'owned-child', key: c.key, file: process.execPath, argv: args, cwd, env: { NT909_FAKE_CHILD: '1' } });
  const proc = spawn(process.execPath, args, { cwd, env: { NT909_FAKE_CHILD: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const h = track(proc, { role: 'fake', key: c.key });
  let buf = '';
  const ready = new Promise((res) => {
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const m = /^READY (\d+)\n/.exec(buf);
      if (m) res(Number(m[1]));
    });
    h.exitP.then(() => res('exited'));
  });
  const got = await Promise.race([ready, timeoutAfter(READY_MS)]);
  if (typeof got !== 'number' || got !== proc.pid) {
    const r = await stopOwned(h);
    throw new Incomplete(`child ${c.key} no READY handshake (${got}; stop ${r.how})`);
  }
  return h;
}

class Incomplete extends Error {}

function startProduct(world, locName, q, outDir, tag) {
  const env = { PATH: world.pathEnv, ...world.loc[locName].env, ...localeEnv(q.locale || 'inherit') };
  const args = ['-c', PRODUCT_SCRIPT, 'nt909-product', SRC[q.src || 'candidate'], q.sid, String(q.timeoutMs || 0)];
  commands.push({ kind: 'product', tag, file: BASH, argv: args, env });
  const t0 = process.hrtime.bigint();
  const proc = spawn(BASH, args, { env, cwd: world.tmp, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const h = track(proc, { role: 'product', group: true });
  const out = [];
  const err = [];
  proc.stdout.on('data', (d) => out.push(d));
  proc.stderr.on('data', (d) => err.push(d));
  const closed = new Promise((res) => proc.once('close', res));
  return (async () => {
    const r = await Promise.race([Promise.all([h.exitP, closed]), timeoutAfter((q.timeoutMs || 0) + PRODUCT_SLACK_MS)]);
    let timedOut = false;
    if (r === 'timeout') { timedOut = true; hardKill(h); await Promise.race([h.exitP, timeoutAfter(3000)]); }
    const stdout = Buffer.concat(out);
    const stderr = Buffer.concat(err);
    fs.writeFileSync(path.join(outDir, `${tag}.stdout`), stdout);
    fs.writeFileSync(path.join(outDir, `${tag}.stderr`), stderr);
    if (h.spawnError) throw new Incomplete(`product spawn failed ${h.spawnError}`);
    return {
      rc: h.code, signal: h.signal, timedOut,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
      elapsedMs: Number((process.hrtime.bigint() - t0) / 1000000n),
    };
  })();
}

// ---------------------------------------------------------------------------
// oracle
// ---------------------------------------------------------------------------

function errOk(exp, sid, stderr, pidOf) {
  if (exp.err === '-') return stderr === '';
  if (exp.err.unknown) {
    if (isAscii(sid)) return stderr === `session_pid: UNKNOWN sid=${safeOf(sid)} cause=${exp.err.unknown}\n`;
    return new RegExp(`^session_pid: UNKNOWN sid=[A-Za-z0-9._:@+=?-]{0,128} cause=${exp.err.unknown}\\n$`).test(stderr);
  }
  const m = /^session_pid: AMBIGUOUS sid=(\S*) pids=([0-9,]+)\n$/.exec(stderr);
  if (!m || m[1] !== safeOf(sid)) return false;
  const got = m[2].split(',').sort().join(',');
  const want = exp.err.ambiguous.map((k) => String(pidOf(k))).sort().join(',');
  return got === want;
}

function judge(exp, sid, res, pidOf) {
  const reasons = [];
  if (res.timedOut) reasons.push('timeout');
  if (res.rc !== exp.rc) reasons.push(`rc=${res.rc}${res.signal ? `/${res.signal}` : ''} want ${exp.rc}`);
  let wantOut = '';
  if (exp.out) wantOut = `${pidOf(exp.out) + (exp.outMutate === 'plus1' ? 1 : 0)}\n`;
  if (res.stdout !== wantOut) reasons.push('stdout');
  const strictErr = errOk(exp, sid, res.stderr, pidOf);
  const exclErr = errOk(exp, sid, res.stderr.replace(STARTUP_RE, ''), pidOf);
  const core = reasons.length === 0;
  return {
    verdict: core && strictErr ? 'PASS' : 'FAIL',
    verdictExclStartup: core && exclErr ? 'PASS' : 'FAIL',
    reasons: strictErr ? reasons : [...reasons, 'stderr'],
    wantOut,
  };
}

// ---------------------------------------------------------------------------
// case table (pre-registered here; oracles follow input/synthetic sp/nl/posthoc)
// ---------------------------------------------------------------------------

const S = (x) => `nt909fx-${x}`;
const EMPTY = { rc: 0, out: null, err: '-' };
const OWNER = (k) => ({ rc: 0, out: k, err: '-' });
const one = (id, kind, ref, sid, extra = {}) => ({
  id, kind, ref, loc: extra.loc || 'abs', gap: extra.gap,
  steps: [
    { spawn: { key: 'o', sid: extra.childSid || sid, argv1: extra.argv1, shape: extra.shape } },
    ...(extra.more || []),
    { query: { sid, timeoutMs: extra.timeoutMs || 0 }, expect: extra.expect || OWNER('o') },
  ],
});

const LONG = S('L') + 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.repeat(9).slice(0, 504);

const POSITIVE_CASES = [
  one('C01', 'contract', 'sp A2/A3 exact single owner', S('exact')),
  one('C02', 'contract', 'sp A21 sid last argv', S('last'), { shape: 'last' }),
  one('C03', 'contract', 'sp A4 PATH locator, canonical argv1', S('pcanon'), { loc: 'path', argv1: 'canon' }),
  one('C04', 'contract', 'sp A3 PATH locator, symlink argv1', S('psym'), { loc: 'path' }),
  one('C05', 'contract', 'sp A6 bare token argv1', S('pbare'), { loc: 'path', argv1: 'bare' }),
  one('C06', 'contract', 'sp N2 never-seen sid', S('never'), { childSid: S('someone-else'), expect: EMPTY }),
  {
    id: 'C07', kind: 'contract', ref: 'absent after known child exit', loc: 'abs',
    steps: [
      { spawn: { key: 'o', sid: S('gone') } },
      { query: { sid: S('gone') }, expect: OWNER('o'), label: 'live' },
      { exit: 'o' },
      { query: { sid: S('gone') }, expect: EMPTY, label: 'after-exit' },
    ],
  },
  {
    id: 'C08', kind: 'contract', ref: 'sp D1 two exact owners', loc: 'abs',
    steps: [
      { spawn: { key: 'a', sid: S('dup') } },
      { spawn: { key: 'b', sid: S('dup') } },
      { query: { sid: S('dup') }, expect: { rc: 3, out: null, err: { ambiguous: ['a', 'b'] } } },
    ],
  },
  one('C09', 'contract', 'sp N7/D8 owner among prefix/suffix/substring distractors', S('dst-core'), {
    more: [S('dst-core-x'), `x-${S('dst-core')}`, S('dst-cor'), 'dst-core'].map((sid, i) => ({ spawn: { key: `d${i}`, sid } })),
  }),
  {
    id: 'C10', kind: 'contract', ref: 'sp N13 distractors only, no owner', loc: 'abs',
    steps: [
      ...[S('dst2x'), `x${S('dst2')}`, S('dst'), 'fx-dst2'].map((sid, i) => ({ spawn: { key: `d${i}`, sid } })),
      { query: { sid: S('dst2') }, expect: EMPTY },
    ],
  },
  one('C11', 'contract', 'sp N10 / nl NL50 unrelated cli.js holds the triple', S('other'), { argv1: 'other', expect: { rc: 2, out: null, err: { unknown: 'candidate' } } }),
  one('C12', 'contract', 'sp N5 triple after a wrapper word', S('wrap'), { shape: 'wrap', expect: EMPTY }),
  one('C13', 'contract', 'sp N4 --id=<sid> is not the owner shape', S('eqform'), { shape: 'eq', expect: EMPTY }),
  one('C14', 'contract', 'flag-like sid --id', '--id'),
  one('C15', 'contract', 'flag-like sid -n', '-n'),
  one('C16', 'contract', 'sp X9 double quote', S('q"dq')),
  one('C17', 'contract', 'sp X9 single quote', S("q'sq")),
  one('C18', 'contract', 'sp X6 one backslash', S('bs\\b')),
  one('C19', 'contract', 'sp X8 two backslashes', S('bs\\\\2')),
  one('C20', 'contract', 'shell syntax stays literal', S('$(false)`x`')),
  one('C21', 'contract', 'sp X4 regex sid never a regex', S('.*'), { childSid: S('regex'), expect: EMPTY }),
  one('C22', 'contract', 'sp X16 space in sid -> cause=sid', S('sp a'), { expect: { rc: 2, out: null, err: { unknown: 'sid' } } }),
  one('C23', 'characterization', 'argv boundary: ps joins argv with spaces, so a child whose sid argv is "<S> a" reads as owner of <S>', S('sp'), { childSid: S('sp a') }),
  one('C24', 'contract', 'sp X20 long sid, ps -ww no truncation', LONG),
  one('U01', 'contract', 'nl NL40 non-ASCII exact', S('caf\u00e9')),
  one('U02', 'contract', 'nl NL41 non-ASCII absent -> cause=sid', S('caf\u00e9'), { childSid: S('cafe'), expect: { rc: 2, out: null, err: { unknown: 'sid' } } }),
  one('U03', 'retained', 'nl NL55 NBSP exact', S('a\u00a0b'), { gap: 'NBSP' }),
  one('U04', 'retained', 'nl NL47 C1 CSI exact', S('a\u009bb'), { gap: 'C1' }),
  one('U05', 'contract', 'nl NL48 RLO absent -> cause=sid', S('a\u202eb'), { childSid: S('ab'), expect: { rc: 2, out: null, err: { unknown: 'sid' } } }),
  {
    id: 'T01', kind: 'contract', ref: 'sp T1 owner spawned after the query started; found by the first or a later poll (polling not observed: no poll count, elapsed_ms is wall clock)', loc: 'abs',
    steps: [
      { queryStart: { sid: S('late'), timeoutMs: 5000 }, as: 'q' },
      { spawn: { key: 'o', sid: S('late') } },
      { queryAwait: 'q', expect: OWNER('o') },
    ],
  },
  one('T02', 'characterization', 'sp T5 absence persists to timeout_ms=750 (elapsed recorded; poll count, not wall clock)', S('wait'), {
    childSid: S('nobody'), timeoutMs: 750, expect: EMPTY,
  }),
  one('L01', 'contract', 'posthoc H1 32-hop locator chain', S('chain32'), { loc: 'chain32', argv1: 'canon' }),
  one('L02', 'retained', 'sp A14 40-hop locator chain', S('chain40'), { loc: 'chain40', argv1: 'canon', gap: 'ELOOP' }),
];

const NC_CASES = [
  { ...one('NC0', 'nc-positive', 'C01 unchanged', S('exact')), role: 'nc-positive' },
  { ...one('NC1', 'nc-mutant', 'C01 with mutated query sid', S('exact-ncmut'), { childSid: S('exact') }), role: 'nc-mutant' },
  {
    id: 'NC2', kind: 'nc-mutant', role: 'nc-mutant', ref: 'C01 with mutated expected pid', loc: 'abs',
    steps: [{ spawn: { key: 'o', sid: S('exact') } }, { query: { sid: S('exact') }, expect: { rc: 0, out: 'o', outMutate: 'plus1', err: '-' } }],
  },
];

// ---------------------------------------------------------------------------
// runners
// ---------------------------------------------------------------------------

async function runCase(world, c, outDir) {
  const kids = {};
  const pending = {};
  const rows = [];
  const pidOf = (k) => kids[k].pid;
  const cleanup = [];
  let incomplete = null;
  let n = 0;
  const record = (step, sid, res) => {
    const j = judge(step.expect, sid, res, pidOf);
    rows.push({
      case: c.id, step: step.label || String(n), kind: c.kind, role: c.role || 'candidate', gap: c.gap || '', ref: c.ref,
      sid, exp_rc: step.expect.rc, exp_out: j.wantOut, exp_err: JSON.stringify(step.expect.err),
      rc: res.rc, out: res.stdout, err: res.stderr, elapsed_ms: res.elapsedMs,
      verdict: j.verdict, verdict_excl_startup: j.verdictExclStartup, reasons: j.reasons.join(';'),
    });
  };
  // Any fixture child that left without being asked is a lost fixture, not a product result.
  const checkFixtures = () => {
    for (const [key, h] of Object.entries(kids)) {
      const lost = fixtureLost(h);
      if (lost) throw new Incomplete(`fixture child ${key} ${lost} by step ${n}`);
    }
  };
  try {
    for (const step of c.steps) {
      n++;
      if (step.spawn) kids[step.spawn.key] = await spawnFake(world, c.loc, step.spawn);
      else if (step.exit) {
        const r = await stopOwned(kids[step.exit]);
        cleanup.push({ key: step.exit, ...r });
        if (!r.reaped || r.how !== 'stdin-eof' || r.code !== 0) throw new Incomplete(`child ${step.exit} did not exit cleanly on EOF (${r.how})`);
      } else if (step.queryStart) {
        const p = startProduct(world, c.loc, step.queryStart, outDir, `${c.id}.${n}`);
        p.catch(() => {}); // rejection is surfaced at queryAwait; never unhandled meanwhile
        pending[step.as] = { sid: step.queryStart.sid, p };
      }
      else if (step.queryAwait) record(step, pending[step.queryAwait].sid, await pending[step.queryAwait].p);
      else if (step.query) record(step, step.query.sid, await startProduct(world, c.loc, step.query, outDir, `${c.id}.${n}`));
      checkFixtures();
    }
  } catch (e) {
    incomplete = e instanceof Incomplete ? e.message : `error: ${e && e.message}`;
  } finally {
    for (const [key, h] of Object.entries(kids)) if (!cleanup.some((r) => r.key === key)) cleanup.push({ key, ...(await stopOwned(h)) });
    for (const q of Object.values(pending)) await q.p.catch(() => {});
  }
  if (!incomplete) {
    const bad = cleanup.find((r) => !r.reaped);
    if (bad) incomplete = `child ${bad.key} unreaped`;
  }
  if (!incomplete) {
    for (const r of cleanup) {
      const lost = fixtureLost(kids[r.key], r);
      if (lost) { incomplete = `fixture child ${r.key} ${lost}`; break; }
    }
  }
  return { id: c.id, kind: c.kind, role: c.role || 'candidate', gap: c.gap || '', ref: c.ref, rows, cleanup, incomplete,
    verdict: incomplete ? 'INCOMPLETE' : rows.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL' };
}

// Paired contrast only where candidate and prior differ: the three `command env` sites,
// i.e. a clean and an invalid inherited locale. One owned owner, fresh bash per call,
// arms interleaved, capped at CONTRAST_REPS per arm. Every arm is reported, and an arm
// short of CONTRAST_REPS rows is INCOMPLETE, whatever stopped it.
async function runContrast(world, outDir) {
  const c = { id: 'P', loc: 'abs' };
  const sid = S('contrast');
  const arms = [['candidate', 'inherit'], ['prior', 'inherit'], ['candidate', 'badloc'], ['prior', 'badloc']];
  const armMeta = (src, locale) => ({
    kind: src === 'candidate' ? (locale === 'badloc' ? 'retained' : 'contract') : 'comparator',
    role: src === 'candidate' ? 'candidate' : 'comparator', gap: src === 'candidate' && locale === 'badloc' ? 'startup-warning' : '',
    ref: 'nl NL15/NL16 + stress F-A/F-B pairing',
  });
  const rows = [];
  const cleanup = [];
  let owner = null;
  let incomplete = null;
  try {
    owner = await spawnFake(world, 'abs', { key: 'o', sid });
    for (let rep = 1; rep <= CONTRAST_REPS; rep++) {
      for (let i = 0; i < arms.length; i++) {
        const [src, locale] = arms[(i + rep) % arms.length];
        const tag = `P.${src}.${locale}.${rep}`;
        const res = await startProduct(world, c.loc, { sid, src, locale }, outDir, tag);
        const j = judge(OWNER('o'), sid, res, () => owner.pid);
        rows.push({
          case: `P-${src}-${locale}`, step: String(rep), ...armMeta(src, locale), sid, exp_rc: 0, exp_out: j.wantOut, exp_err: '"-"',
          rc: res.rc, out: res.stdout, err: res.stderr, elapsed_ms: res.elapsedMs,
          verdict: j.verdict, verdict_excl_startup: j.verdictExclStartup, reasons: j.reasons.join(';'),
        });
        const lost = fixtureLost(owner);
        if (lost) throw new Incomplete(`contrast owner ${lost} by call ${tag}`);
      }
    }
  } catch (e) {
    incomplete = e instanceof Incomplete ? e.message : `error: ${e && e.message}`;
  }
  if (owner) {
    const r = await stopOwned(owner);
    cleanup.push({ key: 'o', ...r });
    if (!incomplete && !r.reaped) incomplete = 'contrast owner unreaped';
    const lost = fixtureLost(owner, r);
    if (!incomplete && lost) incomplete = `contrast owner ${lost}`;
  }
  const groups = {};
  for (const [src, locale] of arms) groups[`P-${src}-${locale}`] = { meta: armMeta(src, locale), rows: [] };
  for (const row of rows) groups[row.case].rows.push(row);
  return Object.entries(groups).map(([id, { meta, rows: rs }]) => {
    const short = rs.length === CONTRAST_REPS ? null : `arm ${id} has ${rs.length}/${CONTRAST_REPS} reps`;
    const inc = incomplete && short ? `${incomplete}; ${short}` : incomplete || short;
    return {
      id, ...meta, rows: rs, cleanup, incomplete: inc,
      verdict: inc ? 'INCOMPLETE' : rs.every((x) => x.verdict === 'PASS') ? 'PASS' : 'FAIL',
    };
  });
}

function preflight(lane, world) {
  const env = { PATH: SYS_PATH };
  const fixed = (file, args, extraEnv = {}) => {
    const r = spawnSync(file, args, { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 });
    commands.push({ kind: 'preflight', file, argv: args, env: { ...env, ...extraEnv } });
    return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const info = {
    platform: process.platform, arch: process.arch, node: process.version,
    runner_os: process.env.RUNNER_OS, runner_arch: process.env.RUNNER_ARCH,
    image_os: process.env.ImageOS, image_version: process.env.ImageVersion,
    uname: fixed('uname', ['-srm']).out,
    bash: fixed(BASH, ['--version']).out.split('\n')[0],
    inherited_locale: localeEnv('inherit'),
    inherited_charmap: fixed('locale', ['charmap'], localeEnv('inherit')),
    world_tmp: world.tmp,
  };
  const problems = [];
  if (!info.bash) problems.push(`${BASH} missing`);
  for (const [name, file] of Object.entries(SRC)) {
    const r = fixed(BASH, ['-c', 'source "$1" || exit 90; platform::os_type; type -t platform::session_pid', 'nt909-preflight', file]);
    info[`os_type_${name}`] = r;
    if (r.status !== 0 || r.out !== `${lane.osType}\nfunction` || r.err !== '') problems.push(`${name} dispatcher did not load natively as ${lane.osType}`);
  }
  return { info, problems };
}

function writeResults(out, doc) {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(doc, null, 2) + '\n');
  const cols = ['case', 'step', 'kind', 'role', 'gap', 'verdict', 'verdict_excl_startup', 'reasons', 'exp_rc', 'rc', 'exp_out', 'out', 'exp_err', 'err', 'elapsed_ms', 'sid', 'ref'];
  const lines = [cols.join('\t')];
  for (const c of doc.cases) for (const r of c.rows) lines.push(cols.map((k) => JSON.stringify(r[k] ?? '')).join('\t'));
  for (const c of doc.cases) if (c.incomplete) lines.push([c.id, '-', c.kind, c.role, c.gap, 'INCOMPLETE', 'INCOMPLETE', JSON.stringify(c.incomplete)].join('\t'));
  fs.writeFileSync(path.join(out, 'results.tsv'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'commands.jsonl'), commands.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

function summarize(cases) {
  const s = { pass: 0, fail: 0, incomplete: 0, fail_retained: [], fail_new: [], comparator: {} };
  for (const c of cases) {
    if (c.role === 'comparator') {
      s.comparator[c.id] = `${c.rows.filter((r) => r.verdict === 'PASS').length}/${c.rows.length} (excl-startup ${c.rows.filter((r) => r.verdict_excl_startup === 'PASS').length})`;
      if (c.incomplete) s.incomplete++;
      continue;
    }
    if (c.verdict === 'PASS') s.pass++;
    else if (c.verdict === 'INCOMPLETE') s.incomplete++;
    else { s.fail++; (c.gap ? s.fail_retained : s.fail_new).push(c.id); }
  }
  return s;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// Each mutant must fail on stdout alone (no rc, stderr or timeout reason), in the one way
// its mutation predicts: NC1 finds no owner for the mutated sid; NC2 sees the true pid,
// one below the mutated expectation.
const NC_MUTANT_STDOUT = {
  NC1: (r) => r.out === '',
  NC2: (r) => /^[1-9][0-9]*\n$/.test(r.exp_out) && r.out === `${Number(r.exp_out) - 1}\n`,
};

function checkNegativeControl(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`NC-CHECK: unreadable ${file}`); return EXIT.fail; }
  const pos = doc.cases.filter((c) => c.role === 'nc-positive');
  const mut = doc.cases.filter((c) => c.role === 'nc-mutant');
  const ok = doc.mode === 'negative-control' && doc.exit === EXIT.fail && doc.summary.incomplete === 0
    && pos.length >= 1 && pos.every((c) => c.verdict === 'PASS' && c.rows.length >= 1)
    && mut.map((c) => c.id).sort().join(',') === Object.keys(NC_MUTANT_STDOUT).sort().join(',')
    && mut.every((c) => c.verdict === 'FAIL' && !c.incomplete && c.rows.length >= 1
      && c.rows.every((r) => r.verdict === 'FAIL' && r.reasons === 'stdout' && NC_MUTANT_STDOUT[c.id](r)));
  console.log(`NC-CHECK: ${ok ? 'OK' : 'BROKEN'} positive=${pos.map((c) => `${c.id}:${c.verdict}`).join(',')} mutants=${mut.map((c) => `${c.id}:${c.verdict}`).join(',')}`);
  return ok ? EXIT.pass : EXIT.fail;
}

async function main() {
  const nc = opt('check-negative-control');
  if (nc !== undefined) return checkNegativeControl(nc);

  const mode = opt('mode');
  const out = opt('out');
  const refused = guardFailures(mode, out);
  if (refused.length) {
    console.log(`REFUSED (no process was created or queried):\n  - ${refused.join('\n  - ')}`);
    return EXIT.refused;
  }
  const lane = LANES[process.platform];
  fs.mkdirSync(path.join(out, 'cases'), { recursive: true });
  const doc = { task: 909, track: 'nt909sw', mode, branch: BRANCH, started: new Date().toISOString(), cases: [] };
  run.doc = doc;

  doc.pins_before = verifyPins();
  if (!doc.pins_before.every((p) => p.ok)) {
    doc.incomplete = 'fixture hash pin mismatch before any test';
    doc.exit = EXIT.incomplete;
    writeResults(out, doc);
    console.log(`INCOMPLETE: ${doc.incomplete}`);
    return EXIT.incomplete;
  }

  let world;
  try {
    world = buildWorld();
    const pf = preflight(lane, world);
    doc.environment = pf.info;
    if (pf.problems.length) throw new Incomplete(`preflight: ${pf.problems.join('; ')}`);
    const table = mode === 'positive' ? POSITIVE_CASES : NC_CASES;
    for (const c of table) {
      const r = await runCase(world, c, path.join(out, 'cases'));
      doc.cases.push(r);
      console.log(`${r.verdict.padEnd(10)} ${r.id} [${r.kind}${r.gap ? `/${r.gap}` : ''}] ${r.ref}${r.incomplete ? ` -- ${r.incomplete}` : ''}${r.rows.filter((x) => x.verdict !== 'PASS').map((x) => ` {${x.step}: ${x.reasons} rc=${x.rc} out=${JSON.stringify(x.out)} err=${JSON.stringify(x.err)}}`).join('')}`);
    }
    if (mode === 'positive') {
      for (const r of await runContrast(world, path.join(out, 'cases'))) {
        doc.cases.push(r);
        console.log(`${r.verdict.padEnd(10)} ${r.id} [${r.kind}${r.gap ? `/${r.gap}` : ''}] ${r.rows.filter((x) => x.verdict === 'PASS').length}/${r.rows.length} pass, excl-startup ${r.rows.filter((x) => x.verdict_excl_startup === 'PASS').length}${r.incomplete ? ` -- ${r.incomplete}` : ''}`);
      }
    }
  } catch (e) {
    doc.incomplete = e instanceof Incomplete ? e.message : `error: ${e && e.message}`;
  } finally {
    doc.final_cleanup = await stopAll();
    if (world) fs.rmSync(world.tmp, { recursive: true, force: true });
  }
  // From here main owns the results file and the exit. An abort that already started owns
  // them instead: never settle, so main().then cannot exit before abort has written.
  if (finishing) return new Promise(() => {});
  finishing = 'main';

  doc.pins_after = verifyPins();
  if (!doc.pins_after.every((p) => p.ok)) doc.incomplete = (doc.incomplete ? `${doc.incomplete}; ` : '') + 'fixture hash changed during run';
  if (doc.final_cleanup.some((r) => !r.reaped)) doc.incomplete = (doc.incomplete ? `${doc.incomplete}; ` : '') + 'owned child unreaped at exit';
  doc.summary = summarize(doc.cases);
  if (doc.incomplete) doc.summary.incomplete++;
  doc.exit = doc.summary.incomplete ? EXIT.incomplete : doc.summary.fail ? EXIT.fail : EXIT.pass;
  doc.finished = new Date().toISOString();
  writeResults(out, doc);
  console.log(`SUMMARY mode=${mode} os=${lane.osType} bash=${JSON.stringify(doc.environment && doc.environment.bash)} locale=${JSON.stringify(doc.environment && doc.environment.inherited_locale)} pass=${doc.summary.pass} fail=${doc.summary.fail} (new: ${doc.summary.fail_new.join(',') || '-'}; retained: ${doc.summary.fail_retained.join(',') || '-'}) incomplete=${doc.summary.incomplete}${doc.incomplete ? ` (${doc.incomplete})` : ''} comparator=${JSON.stringify(doc.summary.comparator)} exit=${doc.exit}`);
  return doc.exit;
}

// Who owns results.json and the exit once a finish has begun: 'main' (its own tail),
// 'abort' (budget/signal) or 'fatal' (main rejected). The first claim is the only writer.
let finishing = null;

// Write the cases collected so far as an INCOMPLETE run (exit 2). Shared by abort and fatal.
function writeIncomplete(out, doc, why, cleanup) {
  doc.incomplete = (doc.incomplete ? `${doc.incomplete}; ` : '') + why;
  doc.final_cleanup = cleanup;
  doc.summary = summarize(doc.cases);
  doc.summary.incomplete++;
  doc.exit = EXIT.incomplete;
  doc.finished = new Date().toISOString();
  fs.mkdirSync(out, { recursive: true });
  writeResults(out, doc);
  console.log(`INCOMPLETE: partial results written (${doc.cases.length} cases) exit=${doc.exit}`);
}

// Budget/signal stop: the cases collected so far, the abort reason and the cleanup outcome
// go to results.json once, then exit 2. A write failure, or no usable --out, is reported
// as such in a bounded line; nothing on this path can read as a pass.
async function abort(why) {
  if (finishing) return;
  finishing = 'abort';
  console.log(`INCOMPLETE: ${why}; stopping owned children`);
  try {
    const cleanup = await stopAll();
    const out = opt('out');
    if (!out || !path.isAbsolute(out)) {
      console.log(`INCOMPLETE: no results written (output not initialized: --out=${JSON.stringify(String(out)).slice(0, 200)})`);
      return;
    }
    const doc = run.doc || { task: 909, track: 'nt909sw', mode: opt('mode'), branch: BRANCH, cases: [] };
    writeIncomplete(out, doc, `aborted: ${why}`, cleanup);
  } catch (e) {
    console.log(`INCOMPLETE: abort evidence NOT written (${String(e && e.message).slice(0, 200)})`);
  } finally {
    process.exit(EXIT.incomplete);
  }
}

// main rejected. An abort that already owns the finish writes and exits itself, so this
// returns without exiting. Otherwise this owns it (a later abort is a no-op): stop what is
// still owned, keep the cleanup facts main recorded, and write the collected cases as
// INCOMPLETE where main had initialized --out (run.doc); then exit 2.
async function fatal(e) {
  if (finishing === 'abort') return;
  finishing = 'fatal';
  console.log(`INCOMPLETE: main failed: ${String(e && e.stack).slice(0, 1000)}`);
  try {
    const cleanup = await stopAll();
    const doc = run.doc;
    if (!doc) {
      console.log('INCOMPLETE: no results written (output not initialized)');
      return;
    }
    let why = `main failed: ${String(e && e.message).slice(0, 200)}`;
    if (cleanup.some((r) => !r.reaped) && !String(doc.incomplete).includes('owned child unreaped')) why += '; owned child unreaped at exit';
    writeIncomplete(opt('out'), doc, why, [...(doc.final_cleanup || []), ...cleanup]);
  } catch (e2) {
    console.log(`INCOMPLETE: fatal evidence NOT written (${String(e2 && e2.message).slice(0, 200)})`);
  } finally {
    process.exit(EXIT.incomplete);
  }
}
process.on('SIGINT', () => abort('SIGINT'));
process.on('SIGTERM', () => abort('SIGTERM'));
process.on('exit', () => { for (const h of owned) hardKill(h); });
setTimeout(() => abort(`run budget ${RUN_BUDGET_MS}ms exceeded`), RUN_BUDGET_MS).unref();

main().then((code) => { finishing = 'main'; process.exit(code); }, fatal);
