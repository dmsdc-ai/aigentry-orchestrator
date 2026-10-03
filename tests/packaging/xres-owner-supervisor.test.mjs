// #1177 owned fake-subprocess fixtures for the CI-only XRes owner supervisor.
// Executes the EXACT supervisor bytes the browser-tls acceptance step writes to
// $WM_SUPERVISOR, extracted structurally (Ruby/Psych) from .github/workflows/ci.yml and
// pinned by sha256. Nothing is reimplemented here: every verdict below is produced by
// that extracted program.
//
// SYNTHETIC OUTCOMES ONLY. xprop, openbox, xres-owner and npm are test-owned fakes on a
// private PATH. No X server, no DISPLAY, no browser, no native build, no real package
// command. A passing case proves how the supervisor reacts to a crafted answer; it does
// NOT prove what a real X server, the real probe or a real browser would answer.
//
// Signals are sent ONLY through the supervisor's own spawn handle, and only while that
// handle is still live. Liveness of every grandchild fake is observed through an
// exclusive flock each fake holds for its lifetime - never by pid, name or process scan.
// Node 20; Ruby/Psych and python3 on PATH. Optional absolute overrides:
// XRES_FIXTURE_RUBY, XRES_FIXTURE_PYTHON, XRES_FIXTURE_EVIDENCE.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

assert.equal(process.versions.node.split('.')[0], '20', 'fixtures require Node 20');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function resolveTool(name, override) {
  const explicit = process.env[override];
  if (explicit !== undefined) assert.ok(isAbsolute(explicit), `${override}: absolute path required`);
  const candidates = explicit ? [explicit]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* next PATH entry; an explicit override never falls back */ }
  }
  throw new Error(`Missing prerequisite ${name}: put it on PATH or set ${override}`);
}
const ruby = resolveTool('ruby', 'XRES_FIXTURE_RUBY');
const python = resolveTool('python3', 'XRES_FIXTURE_PYTHON');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const SUPERVISOR_SHA256 = '665e99c9f5bb9cc3779228460610a022f780ce9eb032406761c9d678423d01ba';
const admin = mkdtempSync(join(tmpdir(), 'xres-owner-supervisor-'));
chmodSync(admin, 0o700);
const evidence = process.env.XRES_FIXTURE_EVIDENCE ?? join(admin, 'evidence');
if (process.env.XRES_FIXTURE_EVIDENCE !== undefined) assert.ok(isAbsolute(evidence), 'XRES_FIXTURE_EVIDENCE: absolute');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
console.log(`XRes supervisor fixture evidence: ${evidence}`);

// Structured extraction: Psych dedents the `run:` block scalar exactly as the runner does,
// then the `<<"PY"` heredoc body is taken verbatim (quoted delimiter: nothing stripped).
const extractor = [
  'require "yaml"',
  'doc = YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false)',
  'steps = doc.fetch("jobs").fetch("browser-tls").fetch("steps")',
  'step = steps.select { |s| s["name"] == "Actual browser, WebAuthn and TLS controls" }',
  'raise "expected exactly one acceptance step, got #{step.length}" unless step.length == 1',
  'body = step.fetch(0).fetch("run")',
  'open_marker = "cat >\\"$WM_SUPERVISOR\\" <<\\"PY\\"\\n"',
  'first = body.index(open_marker)',
  'raise "no supervisor heredoc" if first.nil?',
  'raise "more than one supervisor heredoc" unless body.index(open_marker, first + 1).nil?',
  'start = first + open_marker.length',
  'stop = body.index("\\nPY\\n", start)',
  'raise "unterminated supervisor heredoc" if stop.nil?',
  'raise "more than one heredoc terminator" unless body.index("\\nPY\\n", stop + 1).nil?',
  'STDOUT.write(body[start...stop] + "\\n")',
].join('\n');
const extracted = spawnSync(ruby, ['--disable-gems', '-e', extractor, join(root, '.github/workflows/ci.yml')],
  { env: { PATH: '' }, timeout: 10000 });
assert.ifError(extracted.error);
assert.equal(extracted.status, 0, `supervisor extraction failed: ${extracted.stderr}`);
const supervisorBytes = extracted.stdout;
const supervisor = join(admin, 'wm-owned-supervisor.py');
writeFileSync(supervisor, supervisorBytes, { mode: 0o600 });
writeFileSync(join(evidence, 'supervisor.sha256'), `${sha(supervisorBytes)}  wm-owned-supervisor.py\n`);

// One test-owned fake, installed under four names. Its role is its basename. Every run
// appends one JSON line of what it was asked (argv, environment DISPLAY) and holds an
// exclusive flock on its own lock file until it exits, which is how the test observes
// that it is gone. Each fake also has a hard self-lifetime, so nothing it leaves behind
// can outlive the test even if the supervisor under test failed to stop it.
const FAKE = `import fcntl, json, os, sys, time
role = os.path.basename(sys.argv[0])
d = os.environ["XRES_FAKE_DIR"]
sc = json.load(open(os.path.join(d, "scenario.json")))
def log(**kw):
    kw.update(role=role, argv=sys.argv[1:], pid=os.getpid(), display=os.environ.get("DISPLAY"), t=time.time())
    fd = os.open(os.path.join(d, "calls.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    os.write(fd, (json.dumps(kw) + "\\n").encode()); os.close(fd)
def mark(name):
    open(os.path.join(d, name), "w").close()
def marked(name):
    return os.path.exists(os.path.join(d, name))
def hold(name):
    f = open(os.path.join(d, name), "a"); fcntl.flock(f, fcntl.LOCK_EX); return f
def free(name):
    try:
        f = open(os.path.join(d, name), "a")
    except FileNotFoundError:
        return True
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); return True
    except OSError:
        return False
    finally:
        f.close()
def wait_until(pred, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if pred(): return True
        time.sleep(0.02)
    return False
W = sc.get("window", "0xa0000e")
lock = hold("%s-%d.lock" % (role, os.getpid()))
if role == "xprop":
    a = sys.argv[1:]
    name = a[-1]
    log()
    if name == "_NET_WM_PID":
        # The client-asserted property the supervisor replaced. Answered seductively with
        # the owned child's pid, so a fallback to it would be visible as a pass.
        pid = open(os.path.join(d, "openbox.pid")).read() if marked("openbox.pid") else "1"
        print("_NET_WM_PID = %s" % pid); sys.exit(0)
    if a[0] == "-root":
        base = sc.get("baseline", "absent")
        if not marked("registered"):
            if base == "present":
                print("_NET_SUPPORTING_WM_CHECK: window id # 0xdead01"); sys.exit(0)
            if base == "unknown":
                sys.stderr.write("xprop: unable to open display\\n"); sys.exit(1)
            if base == "no-atom":
                print("_NET_SUPPORTING_WM_CHECK:  no such atom on any window."); sys.exit(0)
            print("_NET_SUPPORTING_WM_CHECK:  not found."); sys.exit(0)
        print("_NET_SUPPORTING_WM_CHECK: window id # %s" % W); sys.exit(0)
    if name == "_NET_SUPPORTING_WM_CHECK":
        print("_NET_SUPPORTING_WM_CHECK: window id # %s" % sc.get("self", W)); sys.exit(0)
    if name == "_NET_WM_NAME":
        if sc.get("openbox") == "exit-at-name":
            mark("name-read")
            wait_until(lambda: free("openbox.lock"), 5); time.sleep(0.2)
        print('_NET_WM_NAME = "%s"' % sc.get("name", "Openbox")); sys.exit(0)
    sys.exit(1)
if role == "openbox":
    log()
    ob = hold("openbox.lock")
    open(os.path.join(d, "openbox.pid"), "w").write(str(os.getpid()))
    mode = sc.get("openbox", "normal")
    if mode == "exit-now":
        sys.exit(0)
    if mode == "ignore-term":
        import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if mode == "no-register":
        time.sleep(90); sys.exit(0)
    mark("registered")
    if mode == "exit-at-name":
        wait_until(lambda: marked("name-read"), 60); sys.exit(0)
    if mode == "exit-at-probe":
        wait_until(lambda: marked("probe-running"), 60); sys.exit(0)
    time.sleep(90); sys.exit(0)
if role == "xres-owner":
    log()
    p = sc.get("probe", {})
    a = sys.argv[1:]
    owner = a[a.index("--owner-pid") + 1] if "--owner-pid" in a else "-"
    mark("probe-running")
    if p.get("wait_owner_exit"):
        wait_until(lambda: free("openbox.lock"), 5); time.sleep(0.2)
    if p.get("sleep"):
        sys.stdout.write("xres-owner (verdict=owned partial"); sys.stdout.flush()
        time.sleep(p["sleep"])
    sys.stdout.write(p.get("stdout", "").replace("{owner}", owner))
    sys.exit(p.get("exit", 0))
if role == "npm":
    log()
    n = sc.get("npm", {})
    if n.get("term_marker"):
        import signal
        def on_term(number, frame):
            mark("suite-term"); time.sleep(0.5); sys.exit(143)
        signal.signal(signal.SIGTERM, on_term)
    mark("suite-running")
    if n.get("sleep"): time.sleep(n["sleep"])
    sys.exit(n.get("exit", 0))
sys.exit(97)
`;
const LOCKCHECK = `import fcntl, glob, json, os, sys
held = []
for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.lock"))):
    f = open(p, "a")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        held.append(os.path.basename(p))
    f.close()
print(json.dumps(held))
`;

// A probe record in the exact field order xres-owner.c render() writes. SYNTHETIC: the
// values are crafted, and `{owner}` is replaced by the fake with the --owner-pid it was
// handed, so an `owned` record names exactly the pid the supervisor asked about.
function rec(overrides = {}) {
  const f = { verdict: 'owned', mode: 'wm', grab: 'held', instrumented: 'no', 'delay-ms': '0',
    window: '0xa0000e', 'probed-xid': '0xa0000e', existence: 'ok', step6: 'ok', 'xres-status': 'success',
    'num-ids': '1', length: '1', pid: '{owner}', 'owner-pid': '{owner}', 'server-version': '1.2',
    'x-error': '-', 'ret-client': '0xa00000', 'ret-mask': '0x2', refusal: '-', ...overrides };
  return `xres-owner (${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(' ')})\n`;
}
const refusal = (verdict, extra = {}) => ({ stdout: rec({ verdict, ...extra }), exit: 2 });

let serial = 0;
async function run(label, scenario, options = {}) {
  const dir = join(evidence, `${String(++serial).padStart(2, '0')}-${label}`);
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
  for (const name of ['xprop', 'openbox', 'xres-owner', 'npm']) {
    writeFileSync(join(bin, name), `#!${python} -S\n${FAKE}`, { mode: 0o700 });
  }
  const env = { PATH: bin, XRES_FAKE_DIR: dir, XRES_OWNER_BIN: join(bin, 'xres-owner'), ...options.env };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  assert.ok(!('DISPLAY' in env), 'no DISPLAY is ever handed to the supervisor');
  const argv = [supervisor];
  const child = spawn(python, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = []; const err = [];
  child.stdout.on('data', chunk => out.push(chunk));
  child.stderr.on('data', chunk => err.push(chunk));
  const closed = new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
  const signalsSent = [];
  // Signal ONLY this exact handle, and only while it is still live and unreaped.
  const send = signal => {
    assert.equal(child.exitCode, null, 'supervisor handle already exited; not signalling');
    assert.equal(child.signalCode, null, 'supervisor handle already signalled out; not signalling');
    assert.ok(child.kill(signal), `could not deliver ${signal} to the owned supervisor handle`);
    signalsSent.push(signal);
  };
  const waitMarker = async (name, seconds) => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (existsSync(join(dir, name))) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`marker ${name} never appeared`);
  };
  const started = Date.now();
  let watchdog;
  const bound = new Promise(done => { watchdog = setTimeout(() => done('watchdog'), (options.bound ?? 60) * 1000); });
  // A failed drive still falls through to the bounded join below, so the owned
  // supervisor is always reaped and its evidence kept before the failure is raised.
  let driveError;
  if (options.drive) {
    try { await options.drive({ send, waitMarker }); } catch (error) { driveError = error; }
  }
  let result = await Promise.race([closed, bound]);
  clearTimeout(watchdog);
  if (result === 'watchdog') {
    if (child.exitCode === null && child.signalCode === null) send('SIGKILL');
    await closed;
    assert.fail(`supervisor exceeded its ${options.bound ?? 60}s fixture bound`);
  }
  const elapsed = (Date.now() - started) / 1000;
  const stderr = Buffer.concat(err).toString('utf8');
  const stdout = Buffer.concat(out).toString('utf8');
  const calls = existsSync(join(dir, 'calls.jsonl'))
    ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const check = spawnSync(python, ['-S', '-c', LOCKCHECK, dir], { env: {}, encoding: 'utf8', timeout: 10000 });
  assert.equal(check.status, 0, check.stderr);
  const held = JSON.parse(check.stdout);
  const outcome = { label, code: result.code, signal: result.signal, elapsed, signalsSent, stderr, stdout, calls, held,
    locks: readdirSync(dir).filter(name => name.endsWith('.lock')).sort() };
  writeFileSync(join(dir, 'outcome.json'), JSON.stringify(outcome, null, 2));
  if (driveError) throw driveError;
  return outcome;
}
const of = (o, role) => o.calls.filter(c => c.role === role);
const probed = o => of(o, 'xprop').map(c => c.argv.at(-1));
const openboxPid = o => { const s = of(o, 'openbox'); assert.equal(s.length, 1, 'exactly one openbox started'); return s[0].pid; };
// Invariants every run must hold, whatever its verdict.
function invariants(o) {
  assert.deepEqual(o.held, [], `every test-created fake has exited (locks still held: ${o.held})`);
  assert.equal(of(o, 'xprop').filter(c => c.argv.at(-1) === '_NET_WM_PID').length, 0,
    'the _NET_WM_PID property is never consulted');
  for (const c of o.calls) assert.equal(c.display, null, `${c.role} saw no DISPLAY`);
  for (const c of of(o, 'openbox')) assert.deepEqual(c.argv, ['--sm-disable']);
  for (const c of of(o, 'xres-owner')) {
    assert.deepEqual(c.argv, ['--mode', 'wm', '--owner-pid', String(openboxPid(o))],
      'the probe is asked in its measuring mode about exactly the owned handle pid');
  }
  for (const c of of(o, 'npm')) assert.deepEqual(c.argv, ['run', 'test:browser-tls']);
  assert.equal(o.stdout, '', 'the supervisor prints nothing on stdout itself');
}
// A refused readiness: exit 1, named verdict, suite never started, only openbox owned.
function refused(o, verdict) {
  invariants(o);
  assert.equal(o.code, 1, o.stderr);
  assert.match(o.stderr, new RegExp(`wm-owned \\(started=openbox readiness=${verdict} ownership=unproven `));
  assert.match(o.stderr, new RegExp(`::error::the owned Openbox never proved it owns this display \\(readiness=${verdict}\\)`));
  assert.equal(of(o, 'npm').length, 0, 'no suite without owned proof');
  assert.match(o.stderr, /wm-cleanup \(owned-processes=1 cleanup-errors=0 /);
}

test('extracted supervisor is the exact pinned candidate bytes', () => {
  assert.equal(sha(supervisorBytes), SUPERVISOR_SHA256);
});

test('owned: exact server-bound owner proof, then the suite, then both owned children joined', async () => {
  const o = await run('owned', { probe: { stdout: rec(), exit: 0 } });
  invariants(o);
  assert.equal(o.code, 0, o.stderr);
  assert.match(o.stderr, /wm-owned \(started=openbox readiness=owned ownership=xres-exact-owned-client /);
  assert.equal(of(o, 'xres-owner').length, 1);
  assert.equal(of(o, 'npm').length, 1);
  const probeAt = of(o, 'xres-owner')[0].t;
  assert.ok(of(o, 'npm')[0].t > probeAt, 'suite starts only after the owned proof');
  assert.ok(of(o, 'openbox')[0].t < probeAt, 'openbox is owned before it is probed');
  assert.deepEqual(probed(o).slice(0, 1), ['_NET_SUPPORTING_WM_CHECK'], 'baseline read first');
  assert.equal(of(o, 'xprop')[0].argv[0], '-root');
  assert.ok(of(o, 'xprop')[0].t < of(o, 'openbox')[0].t, 'baseline observed before anything is started');
  assert.match(o.stderr, /wm-ownership-probe \(probe=xres-owner status=exit-0 timed-out=no /);
  assert.match(o.stderr, /wm-cleanup \(owned-processes=2 cleanup-errors=0 /);
});

test('owned with the other xprop absence spelling (no such atom) still proves ownership', async () => {
  const o = await run('owned-no-atom', { baseline: 'no-atom', probe: { stdout: rec(), exit: 0 } });
  invariants(o);
  assert.equal(o.code, 0, o.stderr);
});

test('suite failure status is the step status verbatim', async () => {
  const o = await run('suite-fails', { probe: { stdout: rec(), exit: 0 }, npm: { exit: 3 } });
  invariants(o);
  assert.equal(o.code, 3);
  assert.match(o.stderr, /wm-cleanup \(owned-processes=2 cleanup-errors=0 /);
});

for (const [label, env] of [['probe-unset', { XRES_OWNER_BIN: undefined }], ['probe-empty', { XRES_OWNER_BIN: '' }],
  ['probe-absent', { XRES_OWNER_BIN: '/nonexistent/xres-owner' }]]) {
  test(`missing probe (${label}) refuses before anything is read or started`, async () => {
    const o = await run(label, {}, { env });
    invariants(o);
    assert.equal(o.code, 1);
    assert.match(o.stderr, /::error::the compiled XRes ownership probe named by XRES_OWNER_BIN was missing/);
    assert.equal(o.calls.length, 0, 'no fake was invoked at all');
  });
}

test('non-executable probe refuses before anything is started', async () => {
  const o = await run('probe-not-executable', {}, { env: { XRES_OWNER_BIN: join(admin, 'wm-owned-supervisor.py') } });
  invariants(o);
  assert.equal(o.code, 1);
  assert.match(o.stderr, /XRES_OWNER_BIN was missing or not executable/);
  assert.equal(o.calls.length, 0);
});

test('a supporting window already present at baseline refuses; nothing is started', async () => {
  const o = await run('baseline-present', { baseline: 'present', probe: { stdout: rec(), exit: 0 } });
  invariants(o);
  assert.equal(o.code, 1);
  assert.match(o.stderr, /::error::a supporting window \(0xdead01\) already owned this display/);
  assert.deepEqual(o.calls.map(c => c.role), ['xprop']);
});

test('an unreadable baseline is not an absent one; nothing is started', async () => {
  const o = await run('baseline-unknown', { baseline: 'unknown', probe: { stdout: rec(), exit: 0 } });
  invariants(o);
  assert.equal(o.code, 1);
  assert.match(o.stderr, /wm-baseline-probe \(property=_NET_SUPPORTING_WM_CHECK status=exit-1 /);
  assert.match(o.stderr, /came back unknown/);
  assert.deepEqual(o.calls.map(c => c.role), ['xprop']);
});

test('stale registration (window does not point back at itself) refuses before the probe', async () => {
  const o = await run('not-self-consistent', { self: '0xa0000f', probe: { stdout: rec(), exit: 0 } });
  refused(o, 'not-self-consistent');
  assert.equal(of(o, 'xres-owner').length, 0);
});

test('foreign window manager name refuses before the probe', async () => {
  const o = await run('foreign-wm', { name: 'Mutter', probe: { stdout: rec(), exit: 0 } });
  refused(o, 'foreign-wm');
  assert.equal(of(o, 'xres-owner').length, 0);
});

// The probe's own refusal verdicts pass through verbatim, with exit 2.
const refusals = {
  'owner-foreign': { pid: '1' },
  'owner-ambiguous': { 'num-ids': '2', refusal: 'num-ids-many', pid: '-' },
  'owner-malformed': { refusal: 'length-range', pid: '-' },
  'owner-unknown': { pid: '-' },
  'owner-refused': { 'xres-status': 'failed', refusal: 'xres-status', pid: '-' },
  'xres-unavailable': { 'server-version': '-' },
  'grab-unavailable': { grab: 'unavailable' },
  'w-absent': { existence: 'badwindow' },
};
for (const [verdict, extra] of Object.entries(refusals)) {
  test(`probe refusal ${verdict} (exit 2) is carried through; no suite, no property fallback`, async () => {
    const o = await run(`refusal-${verdict}`, { probe: refusal(verdict, extra) });
    refused(o, verdict);
    assert.equal(of(o, 'xres-owner').length, 1, 'the probe is asked exactly once');
  });
}

const unreadable = {
  'garbage': { stdout: 'owned\n', exit: 0 },
  'empty': { stdout: '', exit: 0 },
  'two-records': { stdout: rec() + rec(), exit: 0 },
  'trailing-bytes': { stdout: rec().replace(')\n', ') extra\n'), exit: 0 },
  'unknown-refusal-token': { stdout: rec({ verdict: 'owner-malformed', refusal: 'made-up' }), exit: 2 },
  'exit-1': { stdout: rec({ verdict: 'owner-foreign' }), exit: 1 },
  'exit-3-owned': { stdout: rec(), exit: 3 },
  'status-owned-verdict-refused': { stdout: rec({ verdict: 'owner-foreign' }), exit: 0 },
  'status-refused-verdict-owned': { stdout: rec(), exit: 2 },
  'owned-foreign-server-pid': { stdout: rec({ pid: '1' }), exit: 0 },
  'owned-foreign-owner-pid': { stdout: rec({ 'owner-pid': '1' }), exit: 0 },
  'owned-absent-server-pid': { stdout: rec({ pid: '-' }), exit: 0 },
  'owned-num-ids-2': { stdout: rec({ 'num-ids': '2' }), exit: 0 },
  'owned-xres-failed': { stdout: rec({ 'xres-status': 'failed' }), exit: 0 },
  'owned-refusal-set': { stdout: rec({ refusal: 'client-mismatch' }), exit: 0 },
  'owned-probed-differs': { stdout: rec({ 'probed-xid': '0xa0000f' }), exit: 0 },
  'owned-no-version': { stdout: rec({ 'server-version': '-' }), exit: 0 },
};
for (const [label, probe] of Object.entries(unreadable)) {
  test(`malformed or inconsistent probe answer (${label}) is owner-unreadable`, async () => {
    const o = await run(`unreadable-${label}`, { probe });
    refused(o, 'owner-unreadable');
    assert.equal(of(o, 'xres-owner').length, 1);
  });
}

test('owned about a different supporting window is w-changed', async () => {
  const o = await run('w-changed', { probe: { stdout: rec({ window: '0xa0000f', 'probed-xid': '0xa0000f' }), exit: 0 } });
  refused(o, 'w-changed');
});

for (const [label, extra] of [['mode-xid', { mode: 'xid' }], ['no-grab', { grab: 'absent' }],
  ['instrumented', { instrumented: 'yes', 'delay-ms': '50' }]]) {
  test(`reduced or instrumented control record (${label}) is probe-artificial`, async () => {
    const o = await run(`artificial-${label}`, { probe: { stdout: rec(extra), exit: 0 } });
    refused(o, 'probe-artificial');
  });
}

test('probe bound expiry is a refusal (owner-unreadable), and the probe is reaped', async () => {
  const o = await run('probe-timeout', { probe: { sleep: 40, stdout: rec(), exit: 0 } }, { bound: 45 });
  refused(o, 'owner-unreadable');
  assert.match(o.stderr, /wm-ownership-probe \(probe=xres-owner status=timed-out timed-out=yes /);
  assert.ok(o.elapsed >= 14 && o.elapsed < 30, `bounded by OWNER_SECONDS, took ${o.elapsed}s`);
});

test('liveness t0: owner exits before the probe is spawned -> exited, probe never asked', async () => {
  const o = await run('t0-exited', { openbox: 'exit-at-name', probe: { stdout: rec(), exit: 0 } });
  refused(o, 'exited');
  assert.equal(of(o, 'xres-owner').length, 0);
});

test('liveness t2: owner exits while the probe runs -> exited, owned answer discarded', async () => {
  const o = await run('t2-exited', { openbox: 'exit-at-probe', probe: { stdout: rec(), exit: 0, wait_owner_exit: true } });
  refused(o, 'exited');
  assert.equal(of(o, 'xres-owner').length, 1);
});

test('owner exits before any registration -> exited, probe never asked', async () => {
  const o = await run('exit-before-registration', { openbox: 'exit-now', probe: { stdout: rec(), exit: 0 } });
  refused(o, 'exited');
  assert.equal(of(o, 'xres-owner').length, 0);
});

test('cancellation during readiness: 128+SIGTERM, openbox stopped, no probe, no suite', async () => {
  // The owned openbox never registers, so readiness is inside its bounded pause loop.
  const o = await run('cancel-readiness', { openbox: 'no-register', probe: { stdout: rec(), exit: 0 } }, {
    bound: 45,
    drive: async ({ send, waitMarker }) => {
      await waitMarker('openbox.pid', 20);
      await new Promise(r => setTimeout(r, 300));
      send('SIGTERM');
    },
  });
  invariants(o);
  assert.equal(o.code, 128 + 15, o.stderr);
  assert.match(o.stderr, /wm-cancelled \(signal=15\)/);
  assert.match(o.stderr, /wm-cleanup \(owned-processes=1 cleanup-errors=0 /);
  assert.match(o.stderr, /readiness=cancelled ownership=unproven/);
  assert.equal(of(o, 'npm').length, 0);
  assert.equal(of(o, 'xres-owner').length, 0);
  assert.ok(o.elapsed < 10, `cancellation acted on within the poll bound (took ${o.elapsed}s)`);
});

test('cancellation during the suite: 128+first signal; a repeat during cleanup does not move it', async () => {
  const o = await run('cancel-suite', { probe: { stdout: rec(), exit: 0 }, npm: { sleep: 60, term_marker: true } }, {
    bound: 45,
    drive: async ({ send, waitMarker }) => {
      await waitMarker('suite-running', 30);
      send('SIGTERM');
      // The suite has now been told to stop by cleanup, so the supervisor is provably
      // past the first signal and still joining: the repeat lands inside cleanup.
      await waitMarker('suite-term', 15);
      send('SIGINT');
    },
  });
  invariants(o);
  assert.deepEqual(o.signalsSent, ['SIGTERM', 'SIGINT']);
  assert.equal(o.code, 128 + 15, o.stderr);
  assert.match(o.stderr, /wm-cancelled \(signal=15\)/);
  assert.match(o.stderr, /wm-cleanup \(owned-processes=2 cleanup-errors=0 /);
  assert.equal(of(o, 'npm').length, 1);
});

test('MEASURED: INT+TERM in one tick -> one cancellation status (lowest pending number), full cleanup', async () => {
  // Not a contract the supervisor states; recorded because CPython dispatches pending
  // handlers by ascending signal number, so "first" is not arrival order here.
  const o = await run('cancel-same-tick', { openbox: 'no-register', probe: { stdout: rec(), exit: 0 } }, {
    bound: 45,
    drive: async ({ send, waitMarker }) => {
      await waitMarker('openbox.pid', 20);
      await new Promise(r => setTimeout(r, 300));
      send('SIGTERM');
      send('SIGINT');
    },
  });
  invariants(o);
  assert.ok([128 + 2, 128 + 15].includes(o.code), o.stderr);
  assert.equal(o.stderr.match(/wm-cancelled \(signal=\d+\)/g).length, 1);
  assert.ok(o.stderr.includes(`wm-cancelled (signal=${o.code - 128})`));
  assert.match(o.stderr, /wm-cleanup \(owned-processes=1 cleanup-errors=0 /);
  console.log(`same-tick TERM,INT measured exit=${o.code}`);
});

test('cleanup escalates TERM->KILL on an owned openbox that ignores TERM, and joins it', async () => {
  const o = await run('cleanup-kill', { openbox: 'ignore-term', probe: { stdout: rec(), exit: 0 } }, { bound: 45 });
  invariants(o);
  assert.equal(o.code, 0, o.stderr);
  assert.match(o.stderr, /wm-cleanup \(owned-processes=2 cleanup-errors=0 /);
  assert.ok(o.elapsed >= 9.5, `TERM bound was honoured before KILL (took ${o.elapsed}s)`);
});
