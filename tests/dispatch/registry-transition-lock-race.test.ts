import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

// #1167 INSTRUMENTED evidence only. Each case imports the real subject in a private child and
// WRAPS (never replaces) its native lock call or os.lstat/os.stat; the real CLI is covered by
// registry-transition-artifacts.test.ts. Proves the guard is re-checked under the real lock.
function repository(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'bin/dispatch-registry.py'))) {
    const parent = dirname(dir);
    assert.notEqual(parent, dir, 'cannot locate registry beside bin/');
    dir = parent;
  }
  return dir;
}
const repo = repository();
const registry = resolve(process.env.REGISTRY_TRANSITION_TEST_SCRIPT ?? join(repo, 'bin/dispatch-registry.py'));
const windows = process.platform === 'win32';
const essential: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1' };
for (const key of ['SystemRoot', 'WINDIR']) {
  if (process.env[key]) essential[key] = process.env[key];
}
function pythonExecutable(): string {
  const choices = windows ? ['python'] : process.platform === 'darwin'
    ? ['/opt/homebrew/bin/python3', 'python3'] : ['python3'];
  for (const command of choices) {
    const result = spawnSync(command, ['-I', '-B', '-c', 'import sys; print(sys.executable)'],
      { env: essential, encoding: 'utf8', timeout: 5000 });
    if (result.status === 0 && isAbsolute(result.stdout.trim())) return result.stdout.trim();
  }
  throw new Error('Python 3 executable is required for registry transition acceptance');
}
const python = pythonExecutable();

const ARTIFACTS = ['active.db', 'active.db-journal', 'active.db-wal', 'active.db-shm',
  'active.json.source', 'active.json.pre-sqlite.bak', 'active.json.barrier.tmp'] as const;
// Native Windows keeps refusing durable writes; that control is pinned, never waived.
const WINDOWS_WRITE_REFUSAL = 'native Windows directory durability unavailable; registry write refused';
const NOW = '2026-10-04T00:00:00Z';
const LEGACY = [{ sid: 'live-worker', status: 'in_flight', ref_hash: 'hash-live' }];

function record() {
  return {
    dispatch_id: 'race-fixture', assigned: { sid: 'lock-fixture', session_epoch: null },
    dedup: { key: createHash('sha256').update('lock-fixture\0fixture-hash').digest('hex'), ref_hash: 'fixture-hash' },
    outcome: { state: 'unknown', reported_value: null, basis: null },
    lifecycle: { state: 'cleaned', at: '2026-05-12T11:00:00Z' }, transport: { result: 'unknown', inject_id: null, at: null },
    gate: { state: null, prev_lifecycle: null }, observations: [], last_observation: null,
    last_seen_at: '2026-05-12T11:00:00Z', re_dispatch_count: 0, keep_alive: false,
  };
}

const harnessCode = String.raw`
import errno,importlib.util,json,os,sys,types
subject,mode,argv_json,names_json=sys.argv[1:5]
NAMES=set(json.loads(names_json))
receipt=dict(mode=mode,acquire_calls=0,contended=0,artifact_probes=[],lock_free_after=None)
def say(event,**fields):
    print('HARNESS '+json.dumps(dict(event=event,**fields)),file=sys.stderr,flush=True)
spec=importlib.util.spec_from_file_location('registry_under_test',subject)
r=importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
if os.name=='nt':
    import msvcrt as native
    real_lock=native.locking
    contended_errnos=(errno.EACCES,)
else:
    import fcntl as native
    real_lock=native.flock
    contended_errnos=(errno.EAGAIN,errno.EACCES)
def observed_lock(*args):
    receipt['acquire_calls']+=1
    try:
        return real_lock(*args)
    except OSError as exc:
        if exc.errno in contended_errnos:
            receipt['contended']+=1
            if receipt['contended']==1:
                say('contended',pid=os.getpid())
        raise
wrapped=types.SimpleNamespace(**{k:getattr(native,k) for k in dir(native) if not k.startswith('__')})
setattr(wrapped,'locking' if os.name=='nt' else 'flock',observed_lock)
setattr(r,'msvcrt' if os.name=='nt' else 'fcntl',wrapped)
if mode.startswith('fault-'):
    kind=mode[6:]
    def faulty(real):
        def probe(path,*args,**kwargs):
            name=os.path.basename(os.fsdecode(path)) if isinstance(path,(str,bytes,os.PathLike)) else ''
            if name in NAMES:
                receipt['artifact_probes'].append([real.__name__,name])
                if kind=='eacces': raise PermissionError(errno.EACCES,'injected permission denied',path)
                if kind=='eio': raise OSError(errno.EIO,'injected I/O error',path)
                if kind=='enoent': raise FileNotFoundError(errno.ENOENT,'injected absent',path)
            return real(path,*args,**kwargs)
        return probe
    os.lstat=faulty(os.lstat)
    os.stat=faulty(os.stat)
try:
    rc=r.main(json.loads(argv_json))
finally:
    lock=os.path.join(os.environ['DISPATCH_STATE_DIR'],'active.json.lock')
    if os.path.exists(lock):
        with open(lock,'a+b',buffering=0) as fh:
            try:
                if os.name=='nt':
                    fh.seek(0); real_lock(fh.fileno(),native.LK_NBLCK,1)
                    fh.seek(0); real_lock(fh.fileno(),native.LK_UNLCK,1)
                else:
                    real_lock(fh,native.LOCK_EX|native.LOCK_NB); real_lock(fh,native.LOCK_UN)
                receipt['lock_free_after']=True
            except OSError:
                receipt['lock_free_after']=False
    say('receipt',**receipt)
sys.exit(rc)
`;
const holderCode = String.raw`
import json,os,sys
f=open(sys.argv[1], 'a+b', buffering=0)
if os.name == 'nt':
    import msvcrt
    f.seek(0, os.SEEK_SET)
    msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
else:
    import fcntl
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
print(json.dumps(dict(acquired=True,pid=os.getpid(),platform=sys.platform)), flush=True)
sys.stdin.readline()
if os.name == 'nt':
    f.seek(0, os.SEEK_SET)
    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
else:
    fcntl.flock(f, fcntl.LOCK_UN)
f.close()
`;

type Start = 'absent' | 'valid' | 'legacy-array';
type Run = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
function fixture(t: TestContext, start: Start) {
  const root = mkdtempSync(join(tmpdir(), 'registry-race-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const active = join(state, 'active.json'), lock = `${active}.lock`;
  const env: NodeJS.ProcessEnv = { ...essential, HOME: root, USERPROFILE: root,
    TMPDIR: root, TMP: root, TEMP: root, DISPATCH_STATE_DIR: state };
  if (start === 'valid') writeFileSync(active, JSON.stringify({ schema_version: 2, generation: 12, dispatches: [record()] }));
  if (start === 'legacy-array') writeFileSync(active, JSON.stringify(LEGACY));
  const children: { child: ChildProcessWithoutNullStreams; done: Promise<Run> }[] = [];
  t.after(async () => {
    // Only our own children are ever signalled.
    for (const { child, done } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done.catch(() => undefined);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const start_ = (args: string[]) => {
    const child = spawn(python, ['-I', '-B', ...args], { cwd: root, env, stdio: 'pipe' });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = new Promise<Run>((accept, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => accept({ status, signal, stdout, stderr }));
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 15000);
    void done.then(() => clearTimeout(timer), () => clearTimeout(timer));
    children.push({ child, done });
    return { child, done, text: () => stdout + stderr };
  };
  const snapshot = () => present(active) ? sha(readFileSync(active)) : 'absent';
  return { root, state, active, lock, env, start: start_, snapshot };
}
type Fixture = ReturnType<typeof fixture>;
type Started = ReturnType<Fixture['start']>;

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function stateTree(f: Fixture): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(f.state).sort()) {
    if (name === 'registry-health.log' || name === 'active.json.lock') continue;
    const st = lstatSync(join(f.state, name));
    out[name] = st.isFile() ? sha(readFileSync(join(f.state, name))) : 'non-file';
  }
  return out;
}
// Event-driven wait with a bounded deadline: no sleep is used as proof of progress.
function waitFor(started: Started, marker: string, ms: number, label: string): Promise<void> {
  return new Promise((accept, reject) => {
    const finish = () => {
      clearTimeout(timer);
      started.child.stdout.off('data', check);
      started.child.stderr.off('data', check);
      started.child.off('close', closed);
    };
    const check = () => { if (started.text().includes(marker)) { finish(); accept(); } };
    const closed = () => { finish(); reject(new Error(`${label}: child closed before ${marker}: ${started.text()}`)); };
    const timer = setTimeout(() => { finish(); reject(new Error(`${label}: no ${marker} within ${ms}ms: ${started.text()}`)); }, ms);
    started.child.stdout.on('data', check);
    started.child.stderr.on('data', check);
    started.child.once('close', closed);
    check();
  });
}
function harnessArgs(mode: string, args: string[]): string[] {
  return ['-c', harnessCode, registry, mode, JSON.stringify(args), JSON.stringify(ARTIFACTS)];
}
type Receipt = { acquire_calls: number; contended: number; artifact_probes: string[][]; lock_free_after: boolean | null };
function receiptOf(stderr: string): Receipt {
  const line = stderr.split('\n').find(text => text.startsWith('HARNESS {"event": "receipt"'));
  assert.ok(line, `missing harness receipt: ${stderr}`);
  return JSON.parse(line.slice('HARNESS '.length)) as Receipt;
}
function productStderr(stderr: string): string {
  return stderr.split('\n').filter(text => text !== '' && !text.startsWith('HARNESS ')).join('\n');
}
function payloadOf(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function raw(t: TestContext, label: string, run: Run) {
  t.diagnostic(`RAW ${JSON.stringify({ label, status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr })}`);
}
// A guard refusal must name the transition state. A generic exit 9 (e.g. the native Windows
// durability refusal an unguarded subject already returns) is not evidence of the guard.
function identifiesTransition(detail: unknown): boolean {
  return typeof detail === 'string' && (/transition/i.test(detail) || ARTIFACTS.some(name => detail.includes(name)));
}
// Fail-closed oracle: exit 9, unknown completion, transition-guard refusal, no registry change,
// lock not left held. Health log and lock sibling are diagnostics, not authority.
function refusal(run: Run, receipt: Receipt, activeBefore: string, activeAfter: string,
  treeBefore: Record<string, string>, treeAfter: Record<string, string>) {
  const payload = payloadOf(run.stdout);
  return {
    status: run.status,
    product_stderr: productStderr(run.stderr),
    completion_fact: payload && 'completion_fact' in payload ? payload.completion_fact : 'missing',
    result: payload?.result ?? 'missing',
    detail_identifies_transition: identifiesTransition(payload?.detail),
    active_json_unchanged: activeBefore === activeAfter,
    state_unchanged: JSON.stringify(treeBefore) === JSON.stringify(treeAfter),
    lock_released: receipt.lock_free_after !== false,
  };
}
const REFUSED = { status: 9, product_stderr: '', completion_fact: null, result: 'registry_unavailable',
  detail_identifies_transition: true, active_json_unchanged: true, state_unchanged: true, lock_released: true };
function windowsWriteRefused(run: Run, f: Fixture, activeBefore: string) {
  const payload = payloadOf(run.stdout);
  assert.deepEqual({ status: run.status, result: payload?.result, detail: payload?.detail,
    completion_fact: payload?.completion_fact, active: f.snapshot() },
  { status: 9, result: 'registry_write_failed', detail: WINDOWS_WRITE_REFUSAL, completion_fact: null, active: activeBefore });
}

interface Mutator { name: string; start: Start; args: string[]; posix: (f: Fixture, run: Run) => void }
const MUTATORS: Mutator[] = [
  { name: 'begin-delivery (absent active.json)', start: 'absent',
    args: ['begin-delivery', '--sid', 'race-probe', '--ref-hash', 'race-hash', '--now', NOW],
    posix: (f, run) => {
      assert.equal(payloadOf(run.stdout)?.result, 'proceed');
      assert.equal(JSON.parse(readFileSync(f.active, 'utf8')).generation, 1);
    } },
  { name: 'begin-delivery (valid active.json)', start: 'valid',
    args: ['begin-delivery', '--sid', 'race-probe', '--ref-hash', 'race-hash', '--now', NOW],
    posix: (f, run) => {
      assert.equal(payloadOf(run.stdout)?.result, 'proceed');
      assert.equal(JSON.parse(readFileSync(f.active, 'utf8')).generation, 13);
    } },
  { name: 'set-lifecycle (valid active.json)', start: 'valid',
    args: ['set-lifecycle', '--sid', 'lock-fixture', '--state', 're_dispatched', '--now', NOW],
    posix: (f, run) => {
      assert.equal(run.stdout, '');
      const doc = JSON.parse(readFileSync(f.active, 'utf8'));
      assert.equal(doc.generation, 13);
      assert.equal(doc.dispatches[0].lifecycle.state, 're_dispatched');
    } },
  { name: 'migrate (legacy array active.json)', start: 'legacy-array', args: ['migrate', '--now', NOW],
    posix: (f, run) => {
      assert.equal(payloadOf(run.stdout)?.result, 'migrated');
      assert.equal(JSON.parse(readFileSync(f.active, 'utf8')).generation, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${f.active}.legacy-v1.bak`, 'utf8')), LEGACY);
    } },
];

test('receipt: instrumented import of the subject; real CLI is covered separately', t => {
  t.diagnostic(`INSTRUMENTED harness; python=${python}; node=${process.version}; platform=${process.platform}; tmpdir=${tmpdir()}`);
  t.diagnostic(`registry=${registry}; sha256=${sha(readFileSync(registry))}`);
  t.diagnostic(windows ? 'native Windows run' : 'native POSIX only; Windows branches require native Windows CI');
  assert.ok(isAbsolute(registry));
});

// Ordering is forced by events, not timing: the holder ACKs the real lock, the mutator signals
// real contention (so any entry guard already passed), only then may an artifact appear, and
// only then is the lock released.
for (const mutator of MUTATORS) {
  for (const artifact of [null, 'active.db', 'active.json.barrier.tmp'] as const) {
    const label = artifact === null ? 'control: no artifact' : `${artifact} appears under the lock`;
    test(`instrumented lock race, ${mutator.name}: ${label}`, async t => {
      const f = fixture(t, mutator.start);
      const held = f.start(['-c', holderCode, f.lock]);
      await waitFor(held, '"acquired": true', 5000, 'holder ACK');
      const mutating = f.start(harnessArgs('race', mutator.args));
      await waitFor(mutating, 'HARNESS {"event": "contended"', 5000, 'mutator contention');
      assert.equal(mutating.child.exitCode, null, 'mutator finished while the lock was held');
      if (artifact !== null) writeFileSync(join(f.state, artifact), `synthetic ${artifact} transition bytes\n`);
      const activeBefore = f.snapshot(), treeBefore = stateTree(f);
      held.child.stdin.end('release\n');
      const released = await held.done;
      assert.equal(released.status, 0, released.stderr);
      const run = await mutating.done;
      raw(t, 'mutator', run);
      assert.equal(run.signal, null, run.stderr);
      const receipt = receiptOf(run.stderr);
      assert.ok(receipt.contended >= 1, 'no real contention observed');
      if (artifact !== null) {
        assert.deepEqual(refusal(run, receipt, activeBefore, f.snapshot(), treeBefore, stateTree(f)), REFUSED,
          `${mutator.name}: ${run.stdout}`);
      } else if (windows) {
        windowsWriteRefused(run, f, activeBefore);
      } else {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal(productStderr(run.stderr), '');
        assert.equal(receipt.lock_free_after, true);
        mutator.posix(f, run);
      }
    });
  }
}

const FAULT_OPS: { name: string; start: Start; args: string[] }[] = [
  { name: 'snapshot (valid active.json)', start: 'valid', args: ['snapshot'] },
  { name: 'begin-delivery (valid active.json)', start: 'valid',
    args: ['begin-delivery', '--sid', 'fault-probe', '--ref-hash', 'fault-hash', '--now', NOW] },
  { name: 'begin-delivery (absent active.json)', start: 'absent',
    args: ['begin-delivery', '--sid', 'fault-probe', '--ref-hash', 'fault-hash', '--now', NOW] },
];
function faultRun(t: TestContext, f: Fixture, mode: string, args: string[]): Run {
  const result = spawnSync(python, ['-I', '-B', ...harnessArgs(mode, args)],
    { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  const run = { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
  raw(t, mode, run);
  assert.equal(run.signal, null, run.stderr);
  return run;
}

// Only FileNotFoundError means absent; any other probe error must refuse (fail closed).
for (const kind of ['eacces', 'eio'] as const) {
  for (const op of FAULT_OPS) {
    test(`instrumented lstat/stat ${kind} on reserved names fails closed: ${op.name}`, t => {
      const f = fixture(t, op.start);
      const activeBefore = f.snapshot(), treeBefore = stateTree(f);
      const run = faultRun(t, f, `fault-${kind}`, op.args);
      const receipt = receiptOf(run.stderr);
      t.diagnostic(`artifact_probes=${JSON.stringify(receipt.artifact_probes)}`);
      assert.deepEqual({ ...refusal(run, receipt, activeBefore, f.snapshot(), treeBefore, stateTree(f)),
        probed: receipt.artifact_probes.length > 0 }, { ...REFUSED, probed: true }, `${op.name}: ${run.stdout}`);
    });
  }
}

for (const op of FAULT_OPS.slice(0, 2)) {
  test(`instrumented control: FileNotFoundError on reserved names keeps legacy behavior: ${op.name}`, t => {
    const f = fixture(t, op.start);
    const activeBefore = f.snapshot();
    const run = faultRun(t, f, 'fault-enoent', op.args);
    const receipt = receiptOf(run.stderr);
    t.diagnostic(`artifact_probes=${JSON.stringify(receipt.artifact_probes)}`);
    assert.equal(productStderr(run.stderr), '');
    assert.notEqual(receipt.lock_free_after, false);
    if (op.args[0] === 'snapshot') {
      assert.equal(run.status, 0, run.stdout);
      assert.equal(JSON.parse(run.stdout).generation, 12);
    } else if (windows) {
      windowsWriteRefused(run, f, activeBefore);
    } else {
      assert.equal(run.status, 0, run.stdout);
      assert.equal(payloadOf(run.stdout)?.result, 'proceed');
      assert.equal(JSON.parse(readFileSync(f.active, 'utf8')).generation, 13);
    }
  });
}
