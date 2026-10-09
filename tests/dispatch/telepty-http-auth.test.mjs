// #1214 — the telepty daemon credential travels on curl's STDIN, never in its argv, and every daemon
// HTTP call is bounded. One shared helper, `telepty_curl` in bin/lib/telepty-auth.sh, resolves the token
// ONCE through the one resolver (telepty_auth_token) and hands it to curl as `-H @-` through a builtin
// printf pipe: nothing in argv, env, a temp file, Node memory, a log line or an xtrace line. Fixed
// `--connect-timeout 2 --max-time 5`; curl's own stdout and exit status come back unchanged. All five
// HTTP callers use it (tracker poll, cleanup DELETE, orchestrator-boot DELETE, context-compact probe,
// listing verdict), the three TS helper + `telepty list` spawns are bounded at 7 s, and the tracker asks
// the existing telepty_listing_trusted before it believes an empty listing.
//
// What each section proves, and what it does NOT:
//   A  the helper itself, against a FAKE curl that records argv / stdin / env. Channel proof only.
//   B  REAL curl parses exactly one header from that stdin (--libcurl dump; no socket is opened).
//   C  REAL curl transmits it to a test-owned loopback server and honours --max-time against a server
//      that never answers. The only network proof here. Where the local sandbox forbids bind() it is
//      recorded as NOTRUN by name; under CI a refused bind FAILS — it is never silently passed.
//   D  the bash callers (listing lib, context-compact) end to end against fakes, every OS.
//   E  the TS callers (tracker, cleanup, orchestrator-boot) end to end against fakes. darwin/linux only:
//      node spawns the fake telepty/curl directly by path, and a shebang script is not spawnable by node
//      on win32. The helper and bash callers the TS doors reach ARE measured on win32 (A, B, C, D).
//   F  structure: every caller names the helper, no caller builds the old argv header.
// Fakes for curl, telepty, kill, cmux, ps, git, hitl.sh, dispatch.sh, wh-cli.sh and the registry writer;
// kill and cmux are tripwires asserted empty. Tokens are synthetic per case; HOME/USERPROFILE/TMPDIR are
// private; ORCHESTRATOR_SID is a fixture sid; TELEPTY_PORT=1. Every caller runs in its own process group
// (POSIX) with a hard cap; only that owned group is ever signalled. Stalling fakes end themselves when the
// test writes a release file, and the group is asserted empty before a case passes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const POSIX = process.platform === 'darwin' || process.platform === 'linux';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fwd = (p) => p.replace(/\\/g, '/');
const BASH = WIN ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const AUTH_LIB = fwd(join(repoRoot, 'bin', 'lib', 'telepty-auth.sh'));
const LISTING_LIB = fwd(join(repoRoot, 'bin', 'lib', 'telepty-listing.sh'));
const COMPACT = fwd(join(repoRoot, 'bin', 'context-compact.sh'));
const TRACKER_JS = join(repoRoot, 'dist', 'src', 'tracker', 'cli.js');
const CLEANUP_JS = join(repoRoot, 'dist', 'src', 'cleanup', 'cli.js');
const BOOT_JS = join(repoRoot, 'dist', 'src', 'orchestrator-boot', 'cli.js');
const SID = 'fx-sid-1214';
const ORCH = 'fx-orch-1214';
const INJECT = 'fx-inject-1214';
const MAX_TIME_MS = 5000; // curl --max-time 5
const SPAWN_BOUND_MS = 7000; // the TS spawn backstop
const SLACK_MS = 2500; // scheduler / interpreter start-up allowance on a loaded CI runner
const STALL_S = 25; // a stall that ignores every deadline: far beyond both bounds above
const ROOT = mkdtempSync(join(tmpdir(), 't1214-'));
const OBS_OK = '{"schema_version":2,"tracking_state":"available","observation":{"kind":"fixture_consumed"},"consumption":{"status":"consumed"}}';
const HELPER_ABSENT = 'HELPER_ABSENT: bin/lib/telepty-auth.sh defines no telepty_curl';

after(() => rmSync(ROOT, { recursive: true, force: true }));

// ── fakes (written per case; never a repo fixture) ──────────────────────────────────────────────
const WAIT_S = `wait_s() { # <seconds> — 0 when the full time passed, 1 when the test released us
  local i=0 n=$(( $1 * 10 ))
  while [ "$i" -lt "$n" ]; do [ -e "$D/release" ] && return 1; sleep 0.1; i=$((i + 1)); done
  return 0
}`;

// curl: argv NUL-separated; stdin read ONLY when argv names `-H @-` (as real curl does) unless the mode is
// `nonread`, which closes it unread; env as `env` prints it. Mode per request kind from $D/curl.<kind>
// (delete | sessions | observations | other), else $D/curl.default, else `code 200`:
//   code <N>            print the body ($D/curl.<kind>.body) and -w code N; exit 0 (-f + N>=400: exit 22)
//   transport           000, exit 7 (connect refused)
//   stall <S> [N]       waits S s, or --max-time if smaller, as curl does: then 000 / exit 28
//   ignore-stall <S>    waits S s whatever the flags say (a curl that never returns), then 000 / exit 28
//   nonread <N> <rc>    never reads stdin; prints code N; exits rc
const FAKE_CURL = `#!/usr/bin/env bash
# FAKE curl (#1214 test). Never opens a socket.
set -u
D="\${T1214_FAKE_DIR:?}"
base="$D/log/curl.$$"
printf '%s\\0' "$@" > "$base.argv"
printf '%s\\n' "$$" >> "$D/log/curl.order"
: > "$D/alive/curl.$$"
trap 'rm -f "$D/alive/curl.$$"' EXIT
env > "$base.env"
${WAIT_S}
out=""; wfmt=""; failf=0; maxt=""; method=GET; url=""; hdr=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output) out="$2"; shift 2 ;;
    -w|--write-out) wfmt="$2"; shift 2 ;;
    -H|--header) [ "$2" = "@-" ] && hdr=1; shift 2 ;;
    -H@-) hdr=1; shift ;;
    -X|--request) method="$2"; shift 2 ;;
    -m|--max-time) maxt="$2"; shift 2 ;;
    --connect-timeout|--libcurl) shift 2 ;;
    -f|--fail|-sf|-fs|-sSf|-fsS|-sfS|-Sf|-fS) failf=1; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$method:$url" in
  DELETE:*) kind=delete ;;
  */api/sessions) kind=sessions ;;
  */api/inject-observations/*) kind=observations ;;
  *) kind=other ;;
esac
printf '%s\\n%s\\n%s\\n' "$kind" "$method" "$url" > "$base.kind"
spec="code 200"
if [ -f "$D/curl.$kind" ]; then spec=$(cat "$D/curl.$kind"); elif [ -f "$D/curl.default" ]; then spec=$(cat "$D/curl.default"); fi
body=""; [ -f "$D/curl.$kind.body" ] && body=$(cat "$D/curl.$kind.body")
set -- $spec
mode="$1"
if [ "$mode" = nonread ]; then exec 0<&-; : > "$base.nostdin"
elif [ "$hdr" = 1 ]; then cat > "$base.stdin"
else : > "$base.nostdin"; fi
emit() { # <code> <rc>
  local code="$1" rc="$2" b="$body" pat='%{http_code}'
  if [ "$failf" = 1 ] && [ "$code" -ge 400 ] 2>/dev/null; then b=""; rc=22; fi
  [ "$code" = 000 ] && b=""
  if [ -n "$out" ]; then printf '%s' "$b" > "$out"; else printf '%s' "$b"; fi
  [ -n "$wfmt" ] && printf '%s' "\${wfmt//$pat/$code}"
  printf '%s %s\\n' "$code" "$rc" > "$base.result"
  exit "$rc"
}
case "$mode" in
  code) emit "\${2:-200}" 0 ;;
  transport) emit 000 7 ;;
  stall)
    s="\${2:-30}"; lim="\${maxt%%.*}"
    # One exact sleep: a curl honouring --max-time is bounded by it, so no release poll is needed.
    if [ -n "$lim" ] && [ "$s" -ge "$lim" ]; then sleep "$lim"; emit 000 28; fi
    wait_s "$s" || emit 000 28
    emit "\${3:-200}" 0 ;;
  ignore-stall) wait_s "\${2:-30}"; emit 000 28 ;;
  nonread) sleep 0.2; emit "\${2:-200}" "\${3:-0}" ;;
esac
emit 200 0
`;

const FAKE_TELEPTY = `#!/usr/bin/env bash
# FAKE telepty (#1214 test). Never contacts a daemon. list --json per $D/telepty.list.mode:
#   json (default: $D/telepty.list.json) | malformed | fail | stall <S>. Every other verb: recorded, exit 0.
set -u
D="\${T1214_FAKE_DIR:?}"
{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> "$D/log/telepty.calls"
: > "$D/alive/telepty.$$"
trap 'rm -f "$D/alive/telepty.$$"' EXIT
${WAIT_S}
case "\${1:-}" in
  list)
    spec=json; [ -f "$D/telepty.list.mode" ] && spec=$(cat "$D/telepty.list.mode")
    case "$spec" in
      json) cat "$D/telepty.list.json" ;;
      malformed) printf 'telepty: daemon version mismatch (fixture banner)\\n' ;;
      fail) exit 1 ;;
      stall*) wait_s "\${spec#stall }"; cat "$D/telepty.list.json" ;;
    esac ;;
esac
exit 0
`;

// kill and cmux are TRIPWIRES (recorded, exit 1, asserted empty); ps prints a header only; git is not a repo.
const FAKE_RECORDER = `#!/usr/bin/env bash
set -u
D="\${T1214_FAKE_DIR:?}"; name="$(basename "$0")"
{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> "$D/log/$name.calls"
case "$name" in
  kill|cmux) exit 1 ;;
  ps) printf '  PID  PPID COMMAND\\n' ;;
  git) exit 1 ;;
esac
exit 0
`;

// Node-memory spy, preloaded into a TS caller with --import: records (never prints) whether the token
// ever reached node — a child's stdout/stderr returned to node, a spawn argv/env/input, or a file node
// read. The needle arrives hex-encoded so the spy's own env never carries the token itself.
const SPY = `import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const needle = Buffer.from(process.env.T1214_SPY_NEEDLE_HEX || '', 'hex').toString('utf8');
const log = process.env.T1214_SPY_LOG;
const append = fs.appendFileSync;
const hit = (where, what) => { try { append(log, JSON.stringify({ where, what: String(what) }) + '\\n'); } catch {} };
const has = (v) => needle !== '' && v != null && (Buffer.isBuffer(v) ? v.includes(needle) : String(v).includes(needle));
const look = (fn, file, args, opts) => {
  if (has(file) || (Array.isArray(args) && args.some(has))) hit(fn + ':argv', file);
  if (opts && opts.env && Object.values(opts.env).some(has)) hit(fn + ':env', file);
  if (opts && has(opts.input)) hit(fn + ':input', file);
};
for (const fn of ['spawnSync', 'execFileSync', 'execSync']) {
  const orig = cp[fn];
  cp[fn] = function (file, args, opts) {
    look(fn, file, Array.isArray(args) ? args : [], Array.isArray(args) ? opts : args);
    const r = orig.apply(this, arguments);
    if (fn === 'spawnSync' ? r && (has(r.stdout) || has(r.stderr)) : has(r)) hit(fn + ':output', file);
    return r;
  };
}
const read = fs.readFileSync;
fs.readFileSync = function (p) { const r = read.apply(this, arguments); if (has(r)) hit('readFileSync', p); return r; };
syncBuiltinESMExports();
hit('loaded', process.pid);
`;

// ── case plumbing ───────────────────────────────────────────────────────────────────────────────
let caseN = 0;
const newToken = (n = 24) => `T1214-${randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n)}`;

/**
 * One isolated case directory. token: string (written as authToken), null (no config at all) or
 * { raw } (the config file's exact bytes). realCurl: leave curl off the fake bin so PATH finds the real one.
 */
function makeCase(label, { token = newToken(), realCurl = false } = {}) {
  const dir = join(ROOT, `${String(++caseN).padStart(3, '0')}-${label}`);
  for (const d of ['home/.telepty', 'log', 'alive', 'tmp', 'fakebin', 'ws', 'state', 'aghome', 'role-sandbox']) mkdirSync(join(dir, d), { recursive: true });
  let tok = '';
  if (token !== null && typeof token === 'object') writeFileSync(join(dir, 'home/.telepty/config.json'), token.raw, { mode: 0o600 });
  else if (token !== null) { tok = token; writeFileSync(join(dir, 'home/.telepty/config.json'), JSON.stringify({ authToken: token }), { mode: 0o600 }); }
  const fb = join(dir, 'fakebin');
  const put = (name, body) => { writeFileSync(join(fb, name), body); chmodSync(join(fb, name), 0o755); };
  if (!realCurl) put('curl', FAKE_CURL);
  put('telepty', FAKE_TELEPTY);
  for (const n of ['kill', 'cmux', 'ps', 'git', 'hitl.sh', 'dispatch.sh']) put(n, FAKE_RECORDER);
  const c = {
    dir, token: tok, realCurl, pgids: [],
    fake: (n) => fwd(join(fb, n)),
    file: (n) => join(dir, n),
    set: (n, v) => writeFileSync(join(dir, n), v),
    read: (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : ''),
  };
  return c;
}

/** env -i, then exactly what a case needs. PATH is prepended to, never replaced (tests/dispatch/lib.sh rule 2). */
function caseEnv(c, extra = {}) {
  const env = {};
  for (const k of ['LANG', 'LC_ALL', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT', 'ProgramFiles']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  const sysPath = process.env.PATH ?? process.env.Path ?? '';
  const home = fwd(c.file('home'));
  Object.assign(env, {
    PATH: [c.file('fakebin'), sysPath].join(delimiter),
    HOME: home, USERPROFILE: WIN ? c.file('home') : home,
    TMPDIR: fwd(c.file('tmp')), TMP: c.file('tmp'), TEMP: c.file('tmp'),
    T1214_FAKE_DIR: fwd(c.dir), TELEPTY: c.fake('telepty'), TELEPTY_PORT: '1',
    ORCHESTRATOR_SID: ORCH, TRACKER_FROM_SID: 'fx-tracker-1214', PYTHONDONTWRITEBYTECODE: '1',
    AIGENTRY_HOST_POWER_STATE: 'awake', AIGENTRY_BUS_BRIDGE: '0', AIGENTRY_SLEEP_GUARD: '0',
    AIGENTRY_ROLE_SANDBOX_DIR: fwd(c.file('role-sandbox')), DISPATCH_STATE_DIR: fwd(c.file('state')),
  });
  if (!c.realCurl) env.CURL = c.fake('curl');
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/** Async on purpose (the loopback server shares this event loop). Wall time is taken at `exit`, then the
 * case's stalling fakes are released so `close` (all pipes shut) follows promptly. */
function run(c, cmd, args, { env = caseEnv(c), cwd = c.dir, capMs = 60000 } = {}) {
  rmSync(c.file('release'), { force: true });
  return new Promise((ok, fail) => {
    const t0 = process.hrtime.bigint();
    let ms = null;
    let capped = false;
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: POSIX });
    if (POSIX) c.pgids.push(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { capped = true; killOwned(child.pid, child); }, capMs);
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('exit', () => { ms = Number(process.hrtime.bigint() - t0) / 1e6; writeFileSync(c.file('release'), ''); });
    child.on('close', (status, signal) => { clearTimeout(timer); ok({ status, signal, stdout, stderr, ms, capped }); });
  });
}

function killOwned(pgid, child) {
  // Only ever the process group this test created (detached spawn ⇒ pgid = child pid).
  try { if (POSIX) process.kill(-pgid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
}

function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Release every fake of the case, then require that nothing we started outlives it. */
async function settle(c) {
  writeFileSync(c.file('release'), '');
  const end = Date.now() + 6000;
  const alive = () => (POSIX ? c.pgids.filter(groupAlive) : readdirSync(c.file('alive')));
  while (Date.now() < end && alive().length) await sleep(100);
  const left = alive();
  if (POSIX) for (const g of left) killOwned(g);
  assert.deepEqual(left, [], `${c.dir}: owned children outlived the case and were reaped`);
}

const bash = (c, script, args = [], opts = {}) => run(c, BASH, ['-c', script, 't1214', ...args], opts);

async function helperPresent() {
  const c = makeCase('helper-probe');
  const r = await bash(c, '. "$1"; declare -F telepty_curl >/dev/null', [AUTH_LIB]);
  await settle(c);
  return r.status === 0;
}
let helperOnce;
async function requireHelper() {
  helperOnce ??= helperPresent();
  assert.ok(await helperOnce, HELPER_ABSENT);
}

// ── observations ────────────────────────────────────────────────────────────────────────────────
function curlCalls(c) {
  return c.read('log/curl.order').split('\n').filter(Boolean).map((pid) => {
    const b = `log/curl.${pid}`;
    const [kind, method, url] = c.read(`${b}.kind`).split('\n');
    return {
      pid, kind, method, url,
      argv: c.read(`${b}.argv`).split('\0').slice(0, -1),
      stdin: existsSync(c.file(`${b}.stdin`)) ? c.read(`${b}.stdin`) : null,
      env: c.read(`${b}.env`),
      result: c.read(`${b}.result`).trim(),
    };
  });
}
const calls = (c, name) => c.read(`log/${name}.calls`).split('\n').filter(Boolean);
const redact = (s, tok) => (tok ? String(s).split(tok).join('<TOKEN>') : String(s));
const show = (call, tok) => redact(JSON.stringify({ argv: call.argv, stdin: call.stdin, kind: call.kind }), tok);
const stdinFlag = (argv) => argv.some((a, i) => a === '-H@-' || ((a === '-H' || a === '--header') && argv[i + 1] === '@-'));
function lastOpt(argv, names) {
  let v;
  argv.forEach((a, i) => { if (names.includes(a)) v = argv[i + 1]; });
  return v;
}

/** The credential channel of ONE curl call: header on stdin exactly once, nowhere else; fixed bounds. */
function assertStdinCredential(call, tok, label) {
  const flat = call.argv.join('\0');
  assert.ok(!flat.includes(tok), `${label}: the token is in curl's argv: ${show(call, tok)}`);
  assert.ok(!/x-telepty-token/i.test(flat), `${label}: curl's argv names the credential header: ${show(call, tok)}`);
  assert.ok(stdinFlag(call.argv), `${label}: curl was not told to read its header from stdin (-H @-): ${show(call, tok)}`);
  assert.equal(lastOpt(call.argv, ['--max-time', '-m']), '5', `${label}: effective --max-time is not 5: ${show(call, tok)}`);
  assert.equal(lastOpt(call.argv, ['--connect-timeout']), '2', `${label}: effective --connect-timeout is not 2: ${show(call, tok)}`);
  assert.notEqual(call.stdin, null, `${label}: curl's stdin was never read`);
  const lines = call.stdin.split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.length, 1, `${label}: stdin must carry exactly one header line: ${show(call, tok)}`);
  const m = /^x-telepty-token: ?(.*)$/i.exec(lines[0]);
  assert.ok(m && m[1] === tok, `${label}: stdin header is not 'x-telepty-token: <token>': ${show(call, tok)}`);
  assert.ok(!call.env.includes(tok), `${label}: the token is in curl's environment`);
}

/** No credential at all: nothing on stdin, nothing in argv (degraded = "no credential presented"). */
function assertNoCredential(call, label, forbidden = []) {
  const flat = call.argv.join('\0');
  assert.ok(!/x-telepty-token/i.test(flat), `${label}: curl's argv names the credential header: ${JSON.stringify(call.argv)}`);
  assert.ok(call.stdin === '' || (call.stdin === null && !stdinFlag(call.argv)),
    `${label}: a credential was presented on stdin: ${JSON.stringify(call.stdin)}`);
  for (const f of forbidden) {
    assert.ok(!flat.includes(f) && !(call.stdin ?? '').includes(f) && !call.env.includes(f), `${label}: '${f}' reached curl`);
  }
}

/** Every file of the case except the token's own config and the fake's stdin/env captures. */
function leaks(c, tok, extraSkip = () => false) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = fwd(relative(c.dir, p));
      if (e.isDirectory()) { walk(p); continue; }
      if (rel === 'home/.telepty/config.json' || /^log\/curl\.\d+\.(stdin|env)$/.test(rel) || extraSkip(rel)) continue;
      if (readFileSync(p).includes(tok)) hits.push(rel);
    }
  };
  walk(c.dir);
  return hits;
}

function assertNoLeak(c, r, tok, label) {
  assert.ok(!r.stdout.includes(tok) && !r.stderr.includes(tok), `${label}: the token is in the caller's stdout/stderr`);
  assert.deepEqual(leaks(c, tok), [], `${label}: the token was written to a file`);
}

/** A stall's own contribution: wall time past an unstalled control run of the same caller, same load. */
function assertWithin(r, base, boundMs, label) {
  assert.ok(!r.capped, `${label}: hit the test's own hard cap`);
  assert.ok(r.ms - base.ms < boundMs + SLACK_MS,
    `${label}: ${Math.round(r.ms)} ms vs unstalled control ${Math.round(base.ms)} ms (bound ${boundMs} ms + ${SLACK_MS} ms slack)`);
}

function assertTripwiresQuiet(c, label) {
  assert.deepEqual([...calls(c, 'kill'), ...calls(c, 'cmux')], [], `${label}: a kill/cmux tripwire fired`);
}

function spyHits(c) {
  return c.read('spy.log').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ═══ A — the helper, against the fake curl (every OS; win32 through Git for Windows bash) ═══════
const H = '. "$1"; shift; telepty_curl "$@"';
const STRICT = `set -euo pipefail; ${H}`;
const S_ARGS = ['-s', '-o', '/dev/null', '-w', '%{http_code}'];
const URL = 'http://127.0.0.1:1/api/sessions';

describe('A telepty_curl — the one credential door', { concurrency: true }, () => {
  test('A1 token on stdin exactly once; argv/env clean; fixed bounds; caller args, stdout and status passed through', async () => {
    await requireHelper();
    const c = makeCase('a1');
    c.set('curl.sessions', 'code 200');
    const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL]);
    await settle(c);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '200', 'curl stdout passed through untouched');
    const cs = curlCalls(c);
    assert.equal(cs.length, 1);
    assertStdinCredential(cs[0], c.token, 'A1');
    const own = cs[0].argv.filter((a, i, all) => !(['-H', '--header', '--max-time', '-m', '--connect-timeout'].includes(a) || ['-H', '--header', '--max-time', '-m', '--connect-timeout'].includes(all[i - 1])) && a !== '-H@-');
    assert.deepEqual(own, [...S_ARGS, URL], 'the caller\'s own curl args reach curl unchanged and in order');
    assertNoLeak(c, r, c.token, 'A1');
    assert.deepEqual(readdirSync(c.file('tmp')), [], 'A1: the helper left a file in TMPDIR');
  });

  test('A2 the status curl returns is the status the helper returns (7 / 22 / 28), stdout untouched', async () => {
    await requireHelper();
    for (const [spec, flags, rc, out] of [['transport', S_ARGS, 7, '000'], ['code 401', ['-sf'], 22, ''], ['stall 1', S_ARGS, 0, '200']]) {
      const c = makeCase('a2');
      c.set('curl.sessions', spec);
      c.set('curl.sessions.body', '[]');
      const r = await bash(c, STRICT, [AUTH_LIB, ...flags, URL]);
      await settle(c);
      assert.equal(r.status, rc, `${spec}: helper exit ${r.status}, curl exit ${rc}`);
      assert.equal(r.stdout, out, `${spec}: stdout`);
    }
  });

  test('A3 no / unreadable / malformed / field-less config → no credential presented, request still made, exit = curl\'s', async () => {
    await requireHelper();
    for (const [label, token] of [['none', null], ['malformed', { raw: 'not json {{{' }], ['nofield', { raw: '{"createdAt":"x"}' }], ['empty', { raw: '{"authToken":""}' }]]) {
      const c = makeCase(`a3-${label}`, { token });
      c.set('curl.sessions', 'code 401');
      const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL]);
      await settle(c);
      assert.equal(r.status, 0, `${label}: an empty token must not fail the pipeline under set -euo pipefail: ${r.stderr}`);
      assert.equal(r.stdout, '401', `${label}: the daemon's truthful 401 reaches the caller`);
      const cs = curlCalls(c);
      assert.equal(cs.length, 1, `${label}: the degraded request is still made`);
      assertNoCredential(cs[0], `A3/${label}`);
    }
  });

  test('A4 a 4096-byte token arrives intact on stdin', async () => {
    await requireHelper();
    const c = makeCase('a4', { token: newToken(4096) });
    const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL]);
    await settle(c);
    assert.equal(r.status, 0, r.stderr);
    assertStdinCredential(curlCalls(c)[0], c.token, 'A4');
    assertNoLeak(c, r, c.token, 'A4');
  });

  test('A5 shell/printf metacharacters in the token are data: sent verbatim, never executed or reformatted', async () => {
    await requireHelper();
    const toks = [
      `q"uo'te $(touch PWNED1) \`touch PWNED2\` ; | & < > * ?`,
      'p%s%d%%\\n\\t\\x41-q',
      '--config=/etc/passwd -K x',
      'a b  c\ttab',
    ];
    for (const tok of toks) {
      const c = makeCase('a5', { token: tok });
      const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL]);
      await settle(c);
      assert.equal(r.status, 0, r.stderr);
      assertStdinCredential(curlCalls(c)[0], tok, `A5 ${JSON.stringify(tok)}`);
      assert.ok(!existsSync(c.file('PWNED1')) && !existsSync(c.file('PWNED2')), 'A5: the token was executed');
    }
  });

  // Controller contract: a CR/LF anywhere in the configured token — trailing included — is a nonzero refusal
  // BEFORE curl: no request at all (not an unauthenticated one), never a stripped "valid" token, no secret output.
  test('A6 CR/LF in the token (incl. trailing) → nonzero refusal before curl: no request, no secret output', async () => {
    await requireHelper();
    for (const tok of ['tokA\r\nx-evil: 1', 'tokB\nx-evil: 1', 'tokC\r', 'tokD\n', 'tokE\r\n']) {
      const c = makeCase('a6', { token: tok });
      const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL]);
      await settle(c);
      const label = `A6 ${JSON.stringify(tok)}`;
      assert.notEqual(r.status, 0, `${label}: the helper did not refuse (exit 0)`);
      assert.deepEqual(curlCalls(c).map((x) => show(x, tok)), [], `${label}: curl was spawned for an invalid token`);
      assert.ok(!`${r.stdout}${r.stderr}`.includes(tok.slice(0, 4)) && !`${r.stdout}${r.stderr}`.includes('x-evil'), `${label}: secret echoed`);
    }
  });

  test('A7 xtrace on or off: no token on the trace, and the caller\'s xtrace state is what it was', async () => {
    await requireHelper();
    for (const pre of ['set -x', 'set +x']) {
      const c = makeCase('a7');
      const r = await bash(c, `${pre}; . "$1"; shift; telepty_curl "$@" >/dev/null || true; printf 'flags=%s' "$-"`, [AUTH_LIB, ...S_ARGS, URL]);
      await settle(c);
      assert.ok(!r.stderr.includes(c.token), `${pre}: the token is on the xtrace stream`);
      const on = /flags=\S*x/.test(r.stdout);
      assert.equal(on, pre === 'set -x', `${pre}: the helper changed the caller's xtrace state (${r.stdout})`);
      assertStdinCredential(curlCalls(c)[0], c.token, `A7 ${pre}`);
    }
  });

  test('A8 pipefail + a curl that never reads stdin (incl. a token larger than the pipe buffer): curl\'s status wins', async () => {
    await requireHelper();
    const rounds = [['nonread 200 0', newToken(), 0, '200'], ['nonread 404 22', newToken(), 22, '404'], ['nonread 200 0', newToken(70000), 0, '200']];
    for (const [spec, tok, rc, out] of rounds) {
      for (let i = 0; i < (tok.length > 1000 ? 3 : 10); i++) {
        const c = makeCase('a8', { token: tok });
        c.set('curl.sessions', spec);
        const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL]);
        await settle(c);
        assert.equal(r.status, rc, `${spec} token=${tok.length}B round ${i}: helper exit ${r.status} (SIGPIPE/pipefail leaked), want curl's ${rc}`);
        assert.equal(r.stdout, out);
        assert.ok(!curlCalls(c)[0].argv.join('\0').includes(tok), 'A8: token in argv');
      }
    }
  });

  test('A9 one resolution through the ONE resolver (telepty_auth_token), CURL seam honoured, PATH curl otherwise', async () => {
    await requireHelper();
    const c = makeCase('a9');
    const r = await bash(c, `set -euo pipefail; . "$1"; shift
telepty_auth_token() { printf 'r\\n' >> "$T1214_FAKE_DIR/resolver.calls"; printf 'OVERRIDE-1214'; }
telepty_curl "$@"`, [AUTH_LIB, ...S_ARGS, URL]);
    const r2 = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL], { env: caseEnv(c, { CURL: undefined }) });
    await settle(c);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(c.read('resolver.calls'), 'r\n', 'the helper must resolve the token exactly once, through telepty_auth_token');
    const cs = curlCalls(c);
    assert.equal(cs.length, 2, 'CURL seam used, and PATH curl when CURL is unset');
    assertStdinCredential(cs[0], 'OVERRIDE-1214', 'A9 override');
    assertStdinCredential(cs[1], c.token, 'A9 PATH curl');
  });

  test('A10 bounds are fixed: a stalled daemon ends at --max-time 5 whatever the environment says', async () => {
    await requireHelper();
    const c = makeCase('a10');
    const env = caseEnv(c, { TELEPTY_HTTP_MAX_TIME: '99', TELEPTY_CURL_MAX_TIME: '99', CURL_MAX_TIME: '99' });
    const base = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL], { env });
    c.set('curl.sessions', `stall ${STALL_S}`);
    const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, URL], { env });
    await settle(c);
    assert.equal(r.status, 28, `exit ${r.status}`);
    assert.equal(r.stdout, '000');
    assertWithin(r, base, MAX_TIME_MS, 'A10');
    for (const call of curlCalls(c)) assertStdinCredential(call, c.token, 'A10');
  });

  test('A11 the helper body has no here-doc/here-string, temp file or path-qualified printf', async () => {
    await requireHelper();
    const c = makeCase('a11');
    const r = await bash(c, '. "$1"; declare -f telepty_curl', [AUTH_LIB]);
    await settle(c);
    assert.equal(r.status, 0);
    const body = r.stdout;
    assert.ok(!/<<</.test(body), 'here-string: bash < 5.1 backs it with a temp file');
    assert.ok(!/<<-?\s*['"]?\w+/.test(body), 'here-doc: bash < 5.1 backs it with a temp file');
    assert.ok(!/mktemp|TMPDIR|\/tmp\//.test(body), 'temp file');
    assert.ok(!/[/\\]printf\b|command\s+-p\s+printf|env\s+printf/.test(body), 'an external printf puts the token in its argv');
  });
});

// ═══ B — REAL curl parses the stdin header (no socket; every OS where curl exists) ════════════════
describe('B real curl reads exactly the one header from the helper\'s stdin', () => {
  test('B1 --libcurl dump of a real curl run: one x-telepty-token header with the token; none when the token is empty', async () => {
    await requireHelper();
    for (const token of [newToken(), null]) {
      const c = makeCase('b1', { token, realCurl: true });
      const src = c.file('ws/empty.txt');
      writeFileSync(src, '');
      const url = WIN ? `file:///${fwd(src)}` : `file://${src}`;
      const dump = fwd(c.file('libcurl.c'));
      const r = await bash(c, H, [AUTH_LIB, '--libcurl', dump, '-s', '-o', fwd(c.file('ws/out.txt')), url], { env: caseEnv(c, { CURL: undefined }) });
      await settle(c);
      assert.ok(existsSync(c.file('libcurl.c')), `real curl wrote no --libcurl dump (exit ${r.status}): ${r.stderr}`);
      const hdrs = [...c.read('libcurl.c').matchAll(/curl_slist_append\(\w+, "((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
      const ours = hdrs.filter((h) => /^x-telepty-token:/i.test(h));
      if (token) assert.deepEqual(ours, [`x-telepty-token: ${token}`], 'real curl parsed a different header set from stdin');
      else assert.deepEqual(ours, [], 'real curl was handed a credential header when there is no token');
    }
  });
});

// ═══ C — REAL curl to a test-owned loopback daemon (CI network proof) ════════════════════════════
describe('C real curl → test-owned loopback server', () => {
  const seen = [];
  const held = [];
  let server;
  let port;
  let bindError = null;
  before(async () => {
    server = createServer((req, res) => {
      const toks = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-telepty-token') toks.push(req.rawHeaders[i + 1]);
      seen.push({ method: req.method, url: req.url, toks });
      if (req.url.startsWith('/stall')) { held.push(res); return; }
      if (req.method === 'DELETE') { res.writeHead(200).end('{}'); return; }
      if (req.url.startsWith('/api/inject-observations/')) { res.writeHead(200, { 'content-type': 'application/json' }).end(OBS_OK); return; }
      if (req.url === '/api/sessions') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ id: ORCH, command: 'claude', ready: true, idleSeconds: 30 }])); return; }
      res.writeHead(404).end();
    });
    try {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
      port = server.address().port;
    } catch (e) { bindError = e; }
  });
  after(() => {
    for (const res of held) res.destroy();
    if (port) server.close();
    server.closeAllConnections?.();
  });
  // A confined local sandbox may forbid bind(); that is recorded as NOTRUN by name. Under CI it fails.
  const gate = (t) => {
    if (!bindError) return true;
    if (process.env.CI) assert.fail(`loopback bind refused under CI (${bindError.code}) — the real-curl transmission proof cannot be waived there`);
    t.skip(`NOTRUN: loopback bind refused here (${bindError.code}); real-curl transmission is proven in CI only`);
    return false;
  };
  const since = () => seen.length;
  const reqsFrom = (i) => seen.slice(i);

  test('C1 the helper\'s header reaches the daemon exactly once; none when there is no token', async (t) => {
    if (!gate(t)) return;
    await requireHelper();
    for (const token of [newToken(), null]) {
      const c = makeCase('c1', { token, realCurl: true });
      const i = since();
      const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, `http://127.0.0.1:${port}/api/sessions`]);
      await settle(c);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '200');
      assert.deepEqual(reqsFrom(i).map((q) => q.toks), [token ? [token] : []]);
    }
  });

  test('C2 a daemon that accepts and never answers: real curl ends at --max-time 5 with 28 / 000', async (t) => {
    if (!gate(t)) return;
    await requireHelper();
    const c = makeCase('c2', { realCurl: true });
    const r = await bash(c, STRICT, [AUTH_LIB, ...S_ARGS, `http://127.0.0.1:${port}/stall`]);
    await settle(c);
    assert.equal(r.status, 28, `exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout, '000');
    assert.ok(r.ms >= MAX_TIME_MS - 1000 && r.ms < MAX_TIME_MS + SLACK_MS, `took ${Math.round(r.ms)} ms`);
  });

  test('C3 bash callers over real curl: listing verdict and context-compact present the token', async (t) => {
    if (!gate(t)) return;
    const c = makeCase('c3', { realCurl: true });
    let i = since();
    const v = await bash(c, '. "$1"; telepty_listing_verdict', [LISTING_LIB], { env: caseEnv(c, { TELEPTY_PORT: String(port) }) });
    assert.equal(v.stdout, 'ok', v.stderr);
    assert.deepEqual(reqsFrom(i).map((q) => q.toks), [[c.token]]);
    writeFileSync(c.file('ws/.context-snapshot.md'), '# snapshot\n');
    i = since();
    const k = await run(c, BASH, [COMPACT], { env: compactEnv(c, { AIGENTRY_TELEPTY_API: `http://127.0.0.1:${port}` }) });
    await settle(c);
    assert.equal(k.status, 0, k.stderr);
    assert.deepEqual(reqsFrom(i).map((q) => q.toks), [[c.token]]);
  });

  if (POSIX) {
    test('C4 TS callers over real curl: tracker poll, cleanup DELETE and boot DELETE present the token', async (t) => {
      if (!gate(t)) return;
      const tr = makeCase('c4-tracker', { realCurl: true });
      tr.set('telepty.list.json', JSON.stringify([{ id: SID, command: 'claude', healthStatus: 'CONNECTED' }]));
      seedTracker(tr);
      let i = since();
      const a = await run(tr, process.execPath, [TRACKER_JS, 'check'], { env: trackerEnv(tr, { TELEPTY_PORT: String(port) }) });
      await settle(tr);
      assert.equal(a.status, 0, a.stderr);
      assert.deepEqual(reqsFrom(i).filter((q) => q.url.startsWith('/api/inject-observations/')).map((q) => q.toks), [[tr.token]]);
      assert.ok(observationKinds(tr).includes('fixture_consumed'), 'the real 200 was consumed');

      const cl = makeCase('c4-cleanup', { realCurl: true });
      cl.set('telepty.list.json', JSON.stringify([{ id: 'fx-other-1214', healthStatus: 'CONNECTED' }]));
      i = since();
      const b = await run(cl, process.execPath, [CLEANUP_JS, SID], { env: cleanupEnv(cl, { TELEPTY_PORT: String(port) }) });
      await settle(cl);
      assert.equal(b.status, 0, b.stderr);
      assert.deepEqual(reqsFrom(i).filter((q) => q.method === 'DELETE').map((q) => [q.url, q.toks]), [[`/api/sessions/${SID}`, [cl.token]]]);

      const bo = makeCase('c4-boot', { realCurl: true });
      bo.set('telepty.list.json', JSON.stringify([{ id: ORCH, healthStatus: 'STALE', active_clients: 0 }]));
      i = since();
      const d = await run(bo, process.execPath, [BOOT_JS], { env: bootEnv(bo, { TELEPTY_PORT: String(port) }) });
      await settle(bo);
      assert.equal(d.status, 0, d.stderr);
      assert.deepEqual(reqsFrom(i).filter((q) => q.method === 'DELETE').map((q) => [q.url, q.toks]), [[`/api/sessions/${ORCH}`, [bo.token]]]);
    });
  }
});

// ═══ D — the bash callers, end to end (every OS) ════════════════════════════════════════════════
function compactEnv(c, extra = {}) {
  return caseEnv(c, {
    CLAUDE_PROJECT_DIR: fwd(c.file('ws')), AIGENTRY_ORCH_SID: ORCH, AIGENTRY_TELEPTY: c.fake('telepty'),
    AIGENTRY_TELEPTY_API: 'http://127.0.0.1:1', AIGENTRY_ORCH_CLI: '', AIGENTRY_COMPACT_COMMAND: '', ...extra,
  });
}
const UNRESOLVED = `context-compact: no compaction command known for CLI '<unresolved>' of session ${ORCH} — set AIGENTRY_COMPACT_COMMAND to the command that CLI uses`;

describe('D bash callers', { concurrency: true }, () => {
  const VERDICTS = [['code 200', 'ok'], ['code 401', 'unauthorized'], ['code 403', 'unauthorized'], ['code 500', 'broken'], ['transport', 'unreachable'], [`stall ${STALL_S}`, 'unreachable']];
  for (const [spec, verdict] of VERDICTS) {
    test(`D1 telepty_listing_verdict: ${spec} → ${verdict}, token on stdin, bounded`, async () => {
      const ctl = makeCase('d1-control');
      const base = await bash(ctl, '. "$1"; telepty_listing_verdict', [LISTING_LIB]);
      await settle(ctl);
      const c = makeCase('d1');
      c.set('curl.sessions', spec);
      const r = await bash(c, '. "$1"; telepty_listing_verdict', [LISTING_LIB]);
      await settle(c);
      assert.equal(r.stdout, verdict);
      assert.equal(r.status, 0);
      assertWithin(r, base, MAX_TIME_MS, `D1 ${spec}`);
      const cs = curlCalls(c);
      assert.equal(cs.length, 1);
      assertStdinCredential(cs[0], c.token, `D1 ${spec}`);
      assertNoLeak(c, r, c.token, 'D1');
    });
  }

  test('D2 listing lib under `set -x`: verdict unchanged, no token on the trace', async () => {
    const c = makeCase('d2');
    const r = await bash(c, 'set -x; . "$1"; telepty_listing_trusted "[]"; printf "|rc=%s" "$?"', [LISTING_LIB]);
    await settle(c);
    assert.equal(r.stdout, '|rc=0');
    assert.ok(!r.stderr.includes(c.token), 'the token is on the xtrace stream');
    assertStdinCredential(curlCalls(c)[0], c.token, 'D2');
  });

  test('D3 telepty_listing_trusted / telepty_sid_live: an empty listing is believed only on an authenticated 200', async () => {
    for (const [spec, out, rc, live] of [['code 200', '', 0, 1], ['code 401', 'unauthorized', 1, 2], ['code 500', 'broken', 1, 2], ['transport', 'unreachable', 1, 2]]) {
      const c = makeCase('d3');
      c.set('curl.sessions', spec);
      c.set('telepty.list.json', '[]');
      const r = await bash(c, '. "$1"; telepty_listing_trusted "[]"; printf "|%s" "$?"; telepty_sid_live fx-sid-1214; printf "|%s" "$?"', [LISTING_LIB]);
      await settle(c);
      assert.equal(r.stdout, `${out}|${rc}|${live}`, spec);
      for (const call of curlCalls(c)) assertStdinCredential(call, c.token, `D3 ${spec}`);
    }
  });

  const COMPACT_CASES = [
    ['200 + claude record → /compact injected', 'code 200', JSON.stringify([{ id: ORCH, command: 'claude' }]), 0],
    ['401', 'code 401', '', 5],
    ['transport', 'transport', '', 5],
    ['malformed body', 'code 200', 'not json', 5],
    ['empty listing', 'code 200', '[]', 5],
    ['stall', `stall ${STALL_S}`, '', 5],
  ];
  for (const [label, spec, body, exit] of COMPACT_CASES) {
    test(`D4 context-compact probe: ${label} → exit ${exit}, classification unchanged, token on stdin`, async () => {
      const ctl = makeCase('d4-control');
      ctl.set('curl.sessions', 'code 401');
      writeFileSync(ctl.file('ws/.context-snapshot.md'), '# snapshot\n');
      const base = await run(ctl, BASH, [COMPACT], { env: compactEnv(ctl) });
      await settle(ctl);
      const c = makeCase('d4');
      c.set('curl.sessions', spec);
      c.set('curl.sessions.body', body);
      writeFileSync(c.file('ws/.context-snapshot.md'), '# snapshot\n');
      const r = await run(c, BASH, [COMPACT], { env: compactEnv(c) });
      await settle(c);
      assert.equal(r.status, exit, r.stderr);
      if (exit === 5) {
        assert.equal(r.stderr.trim(), UNRESOLVED, 'exit-5 message changed');
        assert.deepEqual(calls(c, 'telepty'), [], 'nothing may be injected when the CLI is unresolved');
      } else {
        assert.deepEqual(calls(c, 'telepty').map((l) => l.split('\t').slice(0, 6)), [['inject', '--submit', '--from', ORCH, ORCH, '/compact']]);
      }
      assertWithin(r, base, MAX_TIME_MS, `D4 ${label}`);
      const cs = curlCalls(c);
      assert.equal(cs.length, 1);
      assertStdinCredential(cs[0], c.token, `D4 ${label}`);
      assert.equal(cs[0].url, 'http://127.0.0.1:1/api/sessions');
      assertNoLeak(c, r, c.token, 'D4');
    });
  }

  // claude only: a codex/gemini/agy/grok record would start the detached restore waiter, which leaves
  // this test's process group by design — not a child this file may start.
  test('D5 context-compact: an explicit AIGENTRY_TELEPTY_API host override is still the URL probed', async () => {
    const c = makeCase('d5');
    c.set('curl.sessions.body', JSON.stringify([{ id: ORCH, command: 'claude' }]));
    writeFileSync(c.file('ws/.context-snapshot.md'), '# snapshot\n');
    const api = 'http://fixture-telepty.invalid:4848';
    const r = await run(c, BASH, [COMPACT], { env: compactEnv(c, { AIGENTRY_TELEPTY_API: api }) });
    await settle(c);
    assert.equal(r.status, 0, r.stderr);
    const cs = curlCalls(c);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].url, `${api}/api/sessions`);
    assertStdinCredential(cs[0], c.token, 'D5');
  });

  test('D6 context-compact under `bash -x`: no token anywhere on the trace', async () => {
    const c = makeCase('d6');
    c.set('curl.sessions.body', JSON.stringify([{ id: ORCH, command: 'claude' }]));
    writeFileSync(c.file('ws/.context-snapshot.md'), '# snapshot\n');
    const r = await run(c, BASH, ['-x', COMPACT], { env: compactEnv(c) });
    await settle(c);
    assert.equal(r.status, 0, redact(r.stderr, c.token));
    assert.ok(!r.stderr.includes(c.token), 'the token is on the xtrace stream');
    assertStdinCredential(curlCalls(c)[0], c.token, 'D6');
  });
});

// ═══ E — the TS callers, end to end (darwin/linux) ═════════════════════════════════════════════
function seedTracker(c) {
  const now = '2026-05-12T11:00:00Z';
  const rec = {
    dispatch_id: `disp-${SID}`, assigned: { sid: SID, session_epoch: null }, dedup: { key: `dedup-${SID}`, ref_hash: 'x' },
    outcome: { state: 'unknown', reported_value: null, basis: null }, lifecycle: { state: 'delivery_attempt_started', at: now },
    transport: { result: 'unknown', inject_id: INJECT, at: null }, gate: { state: null, prev_lifecycle: null },
    last_observation: { kind: 'dispatch_tracking_started', terminal: false, at: now },
    observations: [{ kind: 'dispatch_tracking_started', terminal: false, at: now }],
    ref_path: '/nonexistent/fixture-ref', dispatched_at: now, expected_report_by: '2026-05-12T11:30:00Z', last_seen_at: now,
    cwd: '', from_sid: ORCH, re_dispatch_count: 0, keep_alive: false,
  };
  writeFileSync(c.file('state/active.json'), JSON.stringify({ schema_version: 2, generation: 1, dispatches: [rec] }, null, 2));
}
const observationKinds = (c) => JSON.parse(c.read('state/active.json')).dispatches[0].observations.map((o) => o.kind);

function trackerEnv(c, extra = {}) {
  return caseEnv(c, {
    TRACKER_NOW: '2026-05-12T12:00:00Z', GIT: c.fake('git'), DISPATCH_SH: c.fake('dispatch.sh'), HITL_SH: c.fake('hitl.sh'), ...extra,
  });
}
/** A private SCRIPT_DIR: recorder wh-cli.sh / registry writer, and a byte copy of the real bin/lib. */
function scriptDir(c) {
  const sd = c.file('scriptdir/bin');
  if (!existsSync(sd)) {
    mkdirSync(sd, { recursive: true });
    cpSync(join(repoRoot, 'bin', 'lib'), join(sd, 'lib'), { recursive: true });
    for (const n of ['wh-cli.sh', 'dispatch-registry.py']) { writeFileSync(join(sd, n), FAKE_RECORDER); chmodSync(join(sd, n), 0o755); }
    assert.deepEqual(readFileSync(join(sd, 'lib/telepty-auth.sh')), readFileSync(AUTH_LIB), 'fixture lib copy differs');
  }
  return sd;
}
function cleanupEnv(c, extra = {}) {
  const sd = scriptDir(c);
  return caseEnv(c, {
    AIGENTRY_SHIM_SCRIPT_DIR: sd, DISPATCH_REGISTRY_PY: join(sd, 'dispatch-registry.py'),
    KILL_CMD: c.fake('kill'), CLEANUP_PS_CMD: c.fake('ps'), CLEANUP_SELF_PID: '99999', ...extra,
  });
}
function bootEnv(c, extra = {}) {
  return caseEnv(c, {
    AIGENTRY_SHIM_SCRIPT_DIR: scriptDir(c), AIGENTRY_HOME: c.file('aghome'), KILL_CMD: c.fake('kill'),
    SINGLETON_PS_CMD: c.fake('ps'), SINGLETON_SELF_PID: '99999', AIGENTRY_HANDOFF: 'off', AIGENTRY_BOOT_PLAN: '1',
    ORCHESTRATOR_CLI: 'claude', AIGENTRY_BOOT_PERMISSION: 'approval=manual', AIGENTRY_BOOT_HISTORY: 'new', ...extra,
  });
}

/** node --import <spy> <cli>: the Node-memory channel is measured, not assumed. */
function runNode(c, js, args, env) {
  writeFileSync(c.file('spy.mjs'), SPY);
  const spyEnv = { ...env, T1214_SPY_LOG: c.file('spy.log'), T1214_SPY_NEEDLE_HEX: Buffer.from(c.token).toString('hex') };
  return run(c, process.execPath, ['--import', pathToFileURL(c.file('spy.mjs')).href, js, ...args], { env: spyEnv });
}
function assertNodeNeverHeldToken(c, label) {
  const h = spyHits(c);
  assert.ok(h.some((x) => x.where === 'loaded'), `${label}: the Node-memory spy did not load — the measurement did not happen`);
  assert.deepEqual(h.filter((x) => x.where !== 'loaded'), [], `${label}: the token reached the Node process`);
}

const SESSION_ROW = [{ id: SID, command: 'claude', healthStatus: 'CONNECTED' }];
async function tracker(c, { list = SESSION_ROW, listMode, ticks = 1 } = {}) {
  if (list !== undefined) c.set('telepty.list.json', typeof list === 'string' ? list : JSON.stringify(list));
  if (listMode) c.set('telepty.list.mode', listMode);
  if (!existsSync(c.file('state/active.json'))) seedTracker(c);
  const rs = [];
  for (let i = 0; i < ticks; i++) rs.push(await runNode(c, TRACKER_JS, ['check'], trackerEnv(c)));
  return rs;
}
const obsReasons = (c) => c.read('state/observations.log');

if (POSIX) {
  describe('E1 tracker observation poll', { concurrency: true }, () => {
    for (const [spec, want] of [['code 200', 'fixture_consumed'], ['code 401', 'observation_poll_unauthorized'], ['code 500', 'observation_endpoint_absent'], ['transport', 'observation_poll_failed']]) {
      test(`E1 ${spec} → ${want}; token on stdin only; node never holds it`, async () => {
        const c = makeCase('e1');
        c.set('curl.observations', spec);
        c.set('curl.observations.body', OBS_OK);
        const [r] = await tracker(c);
        await settle(c);
        assert.equal(r.status, 0, r.stderr);
        const cs = curlCalls(c).filter((x) => x.kind === 'observations');
        assert.equal(cs.length, 1);
        assertStdinCredential(cs[0], c.token, `E1 ${spec}`);
        assert.equal(cs[0].url, `http://127.0.0.1:1/api/inject-observations/${INJECT}`);
        if (want === 'fixture_consumed') assert.ok(observationKinds(c).includes(want), observationKinds(c).join(' '));
        else assert.ok(obsReasons(c).includes(want), `reason ${want} not recorded: ${obsReasons(c)}`);
        assertNodeNeverHeldToken(c, `E1 ${spec}`);
        assertNoLeak(c, r, c.token, 'E1');
        assertTripwiresQuiet(c, 'E1');
      });
    }
  });

  describe('E2 tracker: an empty listing is ABSENT only when the daemon authenticated it', { concurrency: true }, () => {
    test('E2a [] + authenticated 200 → session_absent, then session_gone + one HOLD', async () => {
      const c = makeCase('e2a');
      c.set('curl.sessions', 'code 200');
      const rs = await tracker(c, { list: [], ticks: 2 });
      await settle(c);
      for (const r of rs) assert.equal(r.status, 0, r.stderr);
      const k = observationKinds(c);
      assert.ok(k.includes('session_absent') && k.includes('session_gone'), k.join(' '));
      assert.equal(calls(c, 'telepty').filter((l) => l.includes('reason=session_gone')).length, 1, 'one session_gone HOLD');
      const probes = curlCalls(c).filter((x) => x.kind === 'sessions');
      assert.ok(probes.length >= 1, 'the empty listing was believed without a corroboration probe');
      for (const p of probes) assertStdinCredential(p, c.token, 'E2a probe');
      assertNodeNeverHeldToken(c, 'E2a');
    });

    for (const [label, spec] of [['401', 'code 401'], ['403', 'code 403'], ['500', 'code 500'], ['malformed status', 'code abc'], ['no answer', 'transport'], ['stall', `stall ${STALL_S}`]]) {
      test(`E2b [] + ${label} → UNKNOWN: no session_absent/session_gone, no HOLD naming a teardown`, async () => {
        const c = makeCase('e2b');
        c.set('curl.sessions', spec);
        c.set('curl.observations', 'code 200');
        c.set('curl.observations.body', OBS_OK);
        const rs = await tracker(c, { list: [], ticks: 2 });
        await settle(c);
        for (const r of rs) assert.equal(r.status, 0, r.stderr);
        const k = observationKinds(c);
        assert.ok(!k.includes('session_absent') && !k.includes('session_gone'), `UNKNOWN collapsed into absence: ${k.join(' ')}`);
        assert.deepEqual(calls(c, 'telepty').filter((l) => l.includes('session_gone') || l.includes('session-cleanup')), [], 'a teardown was recommended');
        const probes = curlCalls(c).filter((x) => x.kind === 'sessions');
        assert.ok(probes.length >= 1, 'the empty listing was never corroborated');
        for (const p of probes) assertStdinCredential(p, c.token, `E2b ${label}`);
        assert.ok(curlCalls(c).some((x) => x.kind === 'observations'), 'an UNKNOWN presence still takes the poll path');
        for (const r of rs) assert.ok(r.ms < 2 * MAX_TIME_MS + SPAWN_BOUND_MS + SLACK_MS, `tick took ${Math.round(r.ms)} ms`);
        assertNodeNeverHeldToken(c, `E2b ${label}`);
        assertTripwiresQuiet(c, 'E2b');
      });
    }

    test('E2c a non-empty listing without the sid → session_absent with ZERO HTTP calls', async () => {
      const c = makeCase('e2c');
      const [r] = await tracker(c, { list: [{ id: 'fx-other-1214', healthStatus: 'CONNECTED' }] });
      await settle(c);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(observationKinds(c).includes('session_absent'), observationKinds(c).join(' '));
      assert.deepEqual(curlCalls(c), [], 'a self-evidently authentic listing needs no probe');
    });

    test('E2d a malformed listing → UNKNOWN, no probe, poll path', async () => {
      const c = makeCase('e2d');
      c.set('curl.observations.body', OBS_OK);
      const [r] = await tracker(c, { list: '', listMode: 'malformed' });
      await settle(c);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!observationKinds(c).includes('session_absent'));
      assert.deepEqual(curlCalls(c).filter((x) => x.kind === 'sessions'), []);
    });
  });

  describe('E3 cleanup DELETE', { concurrency: true }, () => {
    const OTHER = JSON.stringify([{ id: 'fx-other-1214', healthStatus: 'CONNECTED' }]);
    const ARMS = [
      ['code 200', 'stdout', `DELETE /api/sessions/${SID} → 200 (removed from registry)`],
      ['code 404', 'stdout', `DELETE /api/sessions/${SID} → 404 (already gone — parent kill propagated)`],
      ['code 401', 'stderr', `DELETE /api/sessions/${SID} → 401 (daemon refused the credential`],
      ['code 403', 'stderr', `DELETE /api/sessions/${SID} → 403 (daemon refused the credential`],
      ['transport', 'stderr', `DELETE /api/sessions/${SID} → no answer from the daemon`],
      ['code 500', 'stdout', `DELETE /api/sessions/${SID} → 500 (unexpected; manual verify)`],
    ];
    for (const [spec, stream, line] of ARMS) {
      test(`E3a ${spec}: arm unchanged, exit 0, token on stdin only`, async () => {
        const c = makeCase('e3a');
        c.set('telepty.list.json', OTHER);
        c.set('curl.delete', spec);
        const r = await runNode(c, CLEANUP_JS, [SID], cleanupEnv(c));
        await settle(c);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r[stream].includes(line), `${spec}: '${line}' missing from ${stream}: ${r[stream]}`);
        const del = curlCalls(c).filter((x) => x.kind === 'delete');
        assert.equal(del.length, 1);
        assert.equal(del[0].url, `http://127.0.0.1:1/api/sessions/${SID}`);
        assertStdinCredential(del[0], c.token, `E3a ${spec}`);
        assertNodeNeverHeldToken(c, `E3a ${spec}`);
        assertNoLeak(c, r, c.token, 'E3a');
        assertTripwiresQuiet(c, 'E3a');
      });
    }

    test('E3b no config: the DELETE is still attempted with no credential; teardown exit 0', async () => {
      const c = makeCase('e3b', { token: null });
      c.set('telepty.list.json', OTHER);
      c.set('curl.delete', 'code 401');
      const r = await runNode(c, CLEANUP_JS, [SID], cleanupEnv(c));
      await settle(c);
      assert.equal(r.status, 0, r.stderr);
      const del = curlCalls(c).filter((x) => x.kind === 'delete');
      assert.equal(del.length, 1);
      assertNoCredential(del[0], 'E3b');
    });

    test('E3c [] + daemon 401 → refused (exit 3): no close, no DELETE, no registry write, no kill', async () => {
      const c = makeCase('e3c');
      c.set('telepty.list.json', '[]');
      c.set('curl.sessions', 'code 401');
      const r = await runNode(c, CLEANUP_JS, [SID], cleanupEnv(c));
      await settle(c);
      assert.equal(r.status, 3, r.stderr);
      assert.ok(r.stderr.includes("the daemon answered 'unauthorized'"), r.stderr);
      assert.deepEqual(curlCalls(c).filter((x) => x.kind !== 'sessions'), [], 'a DELETE was sent on a refused listing');
      for (const p of curlCalls(c)) assertStdinCredential(p, c.token, 'E3c probe');
      assert.deepEqual([...calls(c, 'wh-cli.sh'), ...calls(c, 'dispatch-registry.py')], [], 'a surface/registry actuation happened');
      assertTripwiresQuiet(c, 'E3c');
      assertNodeNeverHeldToken(c, 'E3c');
    });
  });

  describe('E4 orchestrator-boot STALE-record DELETE', { concurrency: true }, () => {
    const STALE = JSON.stringify([{ id: ORCH, healthStatus: 'STALE', active_clients: 0 }]);
    for (const [spec, line] of [
      ['code 200', `DELETE /api/sessions/${ORCH} → 200 (stale record removed; the id is claimable)`],
      ['code 401', `DELETE /api/sessions/${ORCH} → 401 (daemon refused the credential`],
      ['transport', `DELETE /api/sessions/${ORCH} → no answer from the daemon (the STALE record STAYS; nothing was removed)`],
    ]) {
      test(`E4a ${spec}: arm unchanged, exec argv still printed, token on stdin only`, async () => {
        const c = makeCase('e4a');
        c.set('telepty.list.json', STALE);
        c.set('curl.delete', spec);
        const r = await runNode(c, BOOT_JS, [], bootEnv(c));
        await settle(c);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stderr.includes(line), `'${line}' missing: ${r.stderr}`);
        assert.ok(r.stdout.split('\n').includes('allow'), `the exec argv was not printed: ${r.stdout}`);
        const del = curlCalls(c).filter((x) => x.kind === 'delete');
        assert.equal(del.length, 1);
        assert.equal(del[0].url, `http://127.0.0.1:1/api/sessions/${ORCH}`);
        assertStdinCredential(del[0], c.token, `E4a ${spec}`);
        assertNodeNeverHeldToken(c, `E4a ${spec}`);
        assertNoLeak(c, r, c.token, 'E4a');
        assertTripwiresQuiet(c, 'E4a');
      });
    }
  });

  // Every stall here is far longer than both bounds; each case first measures an unstalled control run of
  // the same caller under the same load, so the bound is asserted on the stall's own contribution.
  describe('E5 bounded: no daemon or CLI stall holds a TS caller past its deadline', { concurrency: true }, () => {
    const STALE = JSON.stringify([{ id: ORCH, healthStatus: 'STALE', active_clients: 0 }]);
    const OTHER = JSON.stringify([{ id: 'fx-other-1214', healthStatus: 'CONNECTED' }]);
    const CASES = [
      // [label, caller, setup, extra-ms bound, outcome check]
      ['tracker poll: curl stalls, honours --max-time', 'tracker', (c) => c.set('curl.observations', `stall ${STALL_S}`), MAX_TIME_MS,
        (c, r) => assert.ok(obsReasons(c).includes('observation_poll_failed'), obsReasons(c))],
      ['tracker poll: curl ignores every flag', 'tracker', (c) => c.set('curl.observations', `ignore-stall ${STALL_S}`), SPAWN_BOUND_MS,
        (c) => assert.ok(obsReasons(c).includes('observation_poll_failed'), obsReasons(c))],
      ['tracker: telepty list stalls', 'tracker', (c) => c.set('telepty.list.mode', `stall ${STALL_S}`), SPAWN_BOUND_MS,
        (c) => assert.ok(!observationKinds(c).includes('session_absent'), 'a stalled listing became an absence')],
      ['cleanup DELETE: curl stalls, honours --max-time', 'cleanup', (c) => c.set('curl.delete', `stall ${STALL_S}`), MAX_TIME_MS,
        (c, r) => { assert.equal(r.status, 0); assert.ok(r.stderr.includes('no answer from the daemon'), r.stderr); }],
      ['cleanup DELETE: curl ignores every flag', 'cleanup', (c) => c.set('curl.delete', `ignore-stall ${STALL_S}`), SPAWN_BOUND_MS,
        (c, r) => {
          assert.equal(r.status, 0, r.stderr);
          assert.ok(!r.stdout.includes('→ 200'), 'a timed-out DELETE was reported as removed');
          // An empty capture (spawn backstop) takes the established 000 / no-answer arm.
          assert.ok(r.stderr.includes(`DELETE /api/sessions/${SID} → no answer from the daemon (the entry STAYS in the daemon registry; nothing was removed`), r.stderr);
        }],
      ['cleanup: telepty list stalls', 'cleanup', (c) => c.set('telepty.list.mode', `stall ${STALL_S}`), SPAWN_BOUND_MS,
        (c, r) => { assert.equal(r.status, 3, r.stderr); assert.deepEqual(curlCalls(c), []); }],
      ['boot DELETE: curl stalls, honours --max-time', 'boot', (c) => c.set('curl.delete', `stall ${STALL_S}`), MAX_TIME_MS,
        (c, r) => { assert.ok(r.stderr.includes('no answer from the daemon'), r.stderr); assert.ok(r.stdout.split('\n').includes('allow')); }],
      ['boot DELETE: curl ignores every flag', 'boot', (c) => c.set('curl.delete', `ignore-stall ${STALL_S}`), SPAWN_BOUND_MS,
        (c, r) => { assert.ok(r.stderr.includes('no answer from the daemon'), r.stderr); assert.ok(r.stdout.split('\n').includes('allow')); }],
      ['boot: telepty list stalls', 'boot', (c) => c.set('telepty.list.mode', `stall ${STALL_S}`), SPAWN_BOUND_MS,
        (c, r) => { assert.ok(r.stderr.includes('registry reconcile SKIPPED'), r.stderr); assert.ok(r.stdout.split('\n').includes('allow')); assert.deepEqual(curlCalls(c), []); }],
    ];
    const go = (who, c) => {
      if (who === 'tracker') { c.set('curl.observations.body', OBS_OK); return tracker(c).then((rs) => rs[0]); }
      if (who === 'cleanup') { c.set('telepty.list.json', OTHER); return runNode(c, CLEANUP_JS, [SID], cleanupEnv(c)); }
      c.set('telepty.list.json', STALE);
      return runNode(c, BOOT_JS, [], bootEnv(c));
    };
    for (const [label, who, setup, bound, check] of CASES) {
      test(`E5 ${label} → ≤ ${bound / 1000} s past an unstalled run, existing failure arm`, async () => {
        const ctl = makeCase(`e5-${who}-control`);
        const base = await go(who, ctl);
        await settle(ctl);
        const c = makeCase(`e5-${who}`);
        setup(c);
        const r = await go(who, c);
        await settle(c);
        assertWithin(r, base, bound, `E5 ${label}`);
        check(c, r);
        assertNodeNeverHeldToken(c, `E5 ${label}`);
        assertTripwiresQuiet(c, `E5 ${label}`);
      });
    }
  });
}

// ═══ F — structure ═══════════════════════════════════════════════════════════════════════════════
describe('F every caller goes through the one helper', () => {
  const CALLERS = ['bin/lib/telepty-listing.sh', 'bin/context-compact.sh', 'src/tracker/cli.ts', 'src/cleanup/cli.ts', 'src/orchestrator-boot/cli.ts'];
  const COMPILED = ['dist/src/tracker/cli.js', 'dist/src/cleanup/cli.js', 'dist/src/orchestrator-boot/cli.js'];
  // The two shapes the argv credential took: bash `-H "x-telepty-token: $(…)"` and TS `` `x-telepty-token: ${…}` ``.
  const OLD_ARGV = [/-H\s+["']x-telepty-token:\s*\$\(/, /x-telepty-token:\s*\$\{/];

  test('F1 all five callers (and the compiled TS) name telepty_curl and build no argv credential', () => {
    for (const f of [...CALLERS, ...COMPILED]) {
      const src = readFileSync(join(repoRoot, f), 'utf8');
      assert.ok(src.includes('telepty_curl'), `${f} does not use the shared helper`);
      for (const re of OLD_ARGV) assert.ok(!re.test(src), `${f} still builds the credential into curl's argv (${re})`);
    }
  });

  test('F2 telepty_curl is defined exactly once under bin/, in bin/lib/telepty-auth.sh', () => {
    const defs = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__pycache__') walk(p); continue; }
        if (statSync(p).size > 2_000_000) continue;
        if (/^\s*(function\s+)?telepty_curl\s*\(\)/m.test(readFileSync(p, 'utf8'))) defs.push(fwd(relative(repoRoot, p)));
      }
    };
    walk(join(repoRoot, 'bin'));
    assert.deepEqual(defs, ['bin/lib/telepty-auth.sh']);
  });

  test('F3 bash is reachable for the helper on this OS (win32: Git for Windows bash)', () => {
    const r = spawnSync(BASH, ['-c', 'printf ok'], { encoding: 'utf8' });
    assert.equal(r.stdout, 'ok', `${BASH}: ${r.error?.message ?? r.stderr}`);
  });

  // The one resolver (telepty_auth_token) is python3 behind bash. Where bash cannot find python3 the resolver
  // degrades to "no credential" — named here, so a token-bearing failure above is not misread as a helper defect.
  test('F4 the one resolver runs on this OS: a synthetic token comes back through bash + python3', async () => {
    const c = makeCase('f4');
    const r = await bash(c, '. "$1"; telepty_auth_token', [AUTH_LIB]);
    await settle(c);
    assert.equal(r.stdout.replace(/\r?\n$/, ''), c.token, `RESOLVER_PRECONDITION: telepty_auth_token returned no token here (python3 on bash's PATH?): ${r.stderr}`);
  });
});

// ═══ G — the measurements measure: each probe above is shown to fire on a planted positive ══════
describe('G harness controls (no product code)', () => {
  test('G1 the fake curl tells a stdin header from an argv header', async () => {
    const c = makeCase('g1');
    writeFileSync(c.file('tok.txt'), c.token);
    const go = (shape) => bash(c, `tok=$(cat "$1"); ${shape}`, [fwd(c.file('tok.txt'))]);
    await go(`printf 'x-telepty-token: %s\\n' "$tok" | "$CURL" --connect-timeout 2 --max-time 5 -H @- -s -o /dev/null -w '%{http_code}' ${URL}`);
    await go(`"$CURL" --connect-timeout 2 --max-time 5 -H "x-telepty-token: $tok" -s -o /dev/null -w '%{http_code}' ${URL}`);
    await settle(c);
    const [good, bad] = curlCalls(c);
    assertStdinCredential(good, c.token, 'G1 stdin shape');
    assert.throws(() => assertStdinCredential(bad, c.token, 'G1 argv shape'), /token is in curl's argv/);
  });

  if (POSIX) {
    test('G2 the Node-memory spy fires on a token returned through spawnSync and on a config read', async () => {
      const c = makeCase('g2');
      writeFileSync(c.file('spy.mjs'), SPY);
      const env = { ...caseEnv(c), T1214_SPY_LOG: c.file('spy.log'), T1214_SPY_NEEDLE_HEX: Buffer.from(c.token).toString('hex') };
      const cfg = c.file('home/.telepty/config.json');
      const js = `require('node:child_process').spawnSync('cat', [${JSON.stringify(cfg)}]); require('node:fs').readFileSync(${JSON.stringify(cfg)});`;
      const r = await run(c, process.execPath, ['--import', pathToFileURL(c.file('spy.mjs')).href, '-e', js], { env });
      await settle(c);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(spyHits(c).map((h) => h.where).sort(), ['loaded', 'readFileSync', 'spawnSync:output']);
      assert.throws(() => assertNodeNeverHeldToken(c, 'G2'), /reached the Node process/);
    });
  }

  test('G3 the leak scanner finds a token written to any case file', () => {
    const c = makeCase('g3');
    mkdirSync(c.file('state/deep'), { recursive: true });
    writeFileSync(c.file('state/deep/alerts.log'), `x ${c.token} y`);
    assert.deepEqual(leaks(c, c.token), ['state/deep/alerts.log']);
  });
});
