import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';

// Default dist/tests discovery and private focused emission both find the real repo.
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
// Optional immutable baseline input; ordinary discovery needs no private env.
const registry = resolve(process.env.REGISTRY_NATIVE_TEST_SCRIPT ?? join(repo, 'bin/dispatch-registry.py'));
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
  throw new Error('Python 3 executable is required for native registry acceptance');
}
const python = pythonExecutable();
const identity = spawnSync(python, ['-I', '-B', '-c',
  'import json,os,sys; print(json.dumps(dict(executable=sys.executable,version=sys.version,platform=sys.platform,os_name=os.name)))'],
{ env: essential, encoding: 'utf8', timeout: 5000 });
assert.equal(identity.status, 0, identity.stderr);

function record(state = 'cleaned', transport = 'unknown') {
  return {
    dispatch_id: 'native-lock-fixture', assigned: { sid: 'lock-fixture', session_epoch: null },
    dedup: { key: createHash('sha256').update('lock-fixture\0fixture-hash').digest('hex'), ref_hash: 'fixture-hash' },
    outcome: { state: 'unknown', reported_value: null, basis: null },
    lifecycle: { state, at: '2026-05-12T11:00:00Z' }, transport: { result: transport, inject_id: null, at: null },
    gate: { state: null, prev_lifecycle: null }, observations: [], last_observation: null,
    last_seen_at: '2026-05-12T11:00:00Z', re_dispatch_count: 0, keep_alive: false,
  };
}
function fixture(t: TestContext, records = [record()]) {
  const root = mkdtempSync(join(tmpdir(), 'registry-native-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const active = join(state, 'active.json'), lock = `${active}.lock`;
  const cleanups: (() => Promise<void>)[] = [];
  const env: NodeJS.ProcessEnv = { ...essential, HOME: root, USERPROFILE: root,
    TMPDIR: root, TMP: root, TEMP: root, DISPATCH_STATE_DIR: state };
  writeFileSync(active, JSON.stringify({ schema_version: 2, generation: 12, dispatches: records }));
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(python, ['-I', '-B', registry, ...args],
      { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 16000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  };
  return { root, state, active, lock, env, run, cleanups, bytes: () => readFileSync(active),
    doc: () => JSON.parse(readFileSync(active, 'utf8')),
    noTemps: () => assert.equal(readdirSync(state).filter(name => name.endsWith('.tmp')).length, 0) };
}
type Fixture = ReturnType<typeof fixture>;
const noop = ['observe', '--sid', 'lock-fixture', '--kind', 'lock_probe', '--all'];
const begin = ['begin-delivery', '--sid', 'lock-fixture', '--ref-hash', 'fixture-hash'];
function resultIs(result: ReturnType<Fixture['run']>, status: number, name: string) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, name);
  assert.equal(payload.completion_fact, null);
  return payload;
}

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
function start(f: Fixture, args: string[]) {
  const child = spawn(python, ['-I', '-B', ...args], { cwd: f.root, env: f.env, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const done = new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((accept, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => accept({ status, signal, stdout, stderr }));
  });
  // A failed assertion must never leave a child holding our private lock.
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 18000);
  void done.then(() => clearTimeout(timer), () => clearTimeout(timer));
  f.cleanups.push(async () => { await stop(child); await done; });
  return { child, done, output: () => stdout, errors: () => stderr };
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function holder(t: TestContext, f: Fixture) {
  const running = start(f, ['-c', holderCode, f.lock]);
  t.after(async () => { await stop(running.child); await running.done; });
  const deadline = performance.now() + 5000;
  while (!running.output().includes('\n')) {
    assert.equal(running.child.exitCode, null, running.errors());
    assert.ok(performance.now() < deadline, `holder ACK timeout: ${running.errors()}`);
    await delay(10);
  }
  const ack = JSON.parse(running.output().trim());
  assert.equal(ack.acquired, true);
  assert.equal(ack.pid, running.child.pid);
  assert.equal(ack.platform, JSON.parse(identity.stdout).platform);
  t.diagnostic(`native holder ACK ${JSON.stringify(ack)}`);
  return running;
}
function stable(f: Fixture, bytes: Buffer, ino: number, active: Buffer) {
  assert.deepEqual(readFileSync(f.lock), bytes);
  assert.equal(statSync(f.lock).ino, ino, 'stable sibling identity changed');
  assert.deepEqual(f.bytes(), active, 'no-op changed registry generation or bytes');
  f.noTemps();
}

test('native platform receipt, real snapshot/check-dedup/absent and retired no-op observe', t => {
  t.diagnostic(`native Python ${identity.stdout.trim()}; node=${process.version}; registry=${registry}; sha256=${createHash('sha256').update(readFileSync(registry)).digest('hex')}`);
  t.diagnostic(windows ? 'native Windows U1; durable writes must be refused' : 'native POSIX only; Windows branches require native Windows CI');
  const f = fixture(t), before = f.bytes();
  const snapshot = f.run(['snapshot']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout), f.doc());
  resultIs(f.run(['check-dedup', '--sid', 'absent', '--ref-hash', 'x']), 0, 'proceed');
  assert.equal(existsSync(f.lock), false, 'read-only operations created a lock');
  resultIs(f.run(['observe', '--sid', 'absent', '--kind', 'lock_probe']), 9, 'dispatch_not_found');
  const result = f.run(noop);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout + result.stderr, '');
  assert.deepEqual(f.bytes(), before);
  assert.equal(statSync(f.lock).size, 0, 'empty sibling must need no sentinel');
});

for (const content of ['', 'existing sibling bytes\n']) {
  test(`native ${content ? 'nonempty' : 'empty'} holder blocks no-op; unlocked reads; release before deadline`, async t => {
    const f = fixture(t), bytes = Buffer.from(content), before = f.bytes();
    writeFileSync(f.lock, bytes);
    const ino = statSync(f.lock).ino, held = await holder(t, f);
    assert.equal(f.run(['snapshot']).status, 0);
    resultIs(f.run(['check-dedup', '--sid', 'absent', '--ref-hash', 'x']), 0, 'proceed');
    const waiter = start(f, [registry, ...noop]);
    t.after(async () => { await stop(waiter.child); await waiter.done; });
    await delay(350);
    assert.equal(waiter.child.exitCode, null, waiter.output() + waiter.errors());
    assert.equal(waiter.output(), '', 'output before acquiring sibling lock');
    held.child.stdin.end('release\n');
    assert.equal((await held.done).status, 0);
    const result = await waiter.done;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout + result.stderr, '');
    stable(f, bytes, ino, before);
  });
}

test('native holder enforces the 10 second acquisition deadline', async t => {
  const f = fixture(t), before = f.bytes();
  writeFileSync(f.lock, '');
  const ino = statSync(f.lock).ino, held = await holder(t, f), at = performance.now();
  const result = f.run(noop), elapsed = performance.now() - at;
  resultIs(result, 9, 'registry_unavailable');
  assert.match(JSON.parse(result.stdout).detail, /lock timeout after 10(?:\.0)?s/);
  assert.ok(elapsed >= 9800 && elapsed < 14500, `deadline elapsed ${elapsed}ms`);
  assert.equal(held.child.exitCode, null);
  t.diagnostic(`native contention elapsed_ms=${elapsed.toFixed(0)}`);
  stable(f, Buffer.alloc(0), ino, before);
});

test('native killed holder releases the unchanged sibling for a new CLI process', async t => {
  const f = fixture(t), before = f.bytes(), bytes = Buffer.from('retained');
  writeFileSync(f.lock, bytes);
  const ino = statSync(f.lock).ino, held = await holder(t, f);
  held.child.kill('SIGKILL');
  const death = await held.done;
  assert.ok(death.signal !== null || death.status !== 0);
  assert.equal(f.run(noop).status, 0);
  stable(f, bytes, ino, before);
});

for (const corrupt of ['malformed', 'schema', 'duplicate'] as const) {
  test(`native ${corrupt} corruption preserves bytes and writes external health`, t => {
    const f = fixture(t);
    writeFileSync(f.active, corrupt === 'malformed' ? '{broken' : JSON.stringify({
      schema_version: corrupt === 'schema' ? 1 : 2, generation: 12, dispatches: [record(), record()],
    }));
    const before = f.bytes();
    for (const args of [['snapshot'], begin, noop]) resultIs(f.run(args), 9, 'registry_corrupt');
    assert.deepEqual(f.bytes(), before);
    assert.match(readFileSync(join(f.state, 'registry-health.log'), 'utf8'), /registry_corrupt/);
    f.noTemps();
  });
}

if (windows) {
  for (const operation of ['begin', 'lifecycle', 'migrate-new-backup', 'migrate-existing-backup']) {
    test(`native Windows ${operation} refuses before temp/generation/backup mutation`, t => {
      const f = fixture(t), backup = `${f.active}.legacy-v1.bak`;
      const migration = operation.startsWith('migrate');
      if (migration) writeFileSync(f.active, JSON.stringify([{ sid: 'legacy-fixture' }]));
      if (operation.endsWith('existing-backup')) writeFileSync(backup, 'preserve-backup');
      const before = f.bytes(), priorBackup = existsSync(backup) ? readFileSync(backup) : null;
      const args = migration ? ['migrate'] : operation === 'begin' ? begin
        : ['set-lifecycle', '--sid', 'lock-fixture', '--state', 're_dispatched'];
      const payload = resultIs(f.run(args), 9, 'registry_write_failed');
      assert.equal(payload.detail, 'native Windows directory durability unavailable; registry write refused');
      assert.deepEqual(f.bytes(), before);
      assert.deepEqual(existsSync(backup) ? readFileSync(backup) : null, priorBackup);
      f.noTemps();
    });
  }
} else {
  test('native POSIX mutation and dedup preserve status 0/7/8, generation and unknown outcome', t => {
    const f = fixture(t, []);
    resultIs(f.run(begin), 0, 'proceed');
    const lockIno = statSync(f.lock).ino;
    resultIs(f.run(begin), 7, 'DISPATCH_RETRY_HELD');
    assert.equal(f.run(['set-transport-result', '--sid', 'lock-fixture', '--result', 'write_observed']).status, 0);
    resultIs(f.run(begin), 8, 'DISPATCH_DEDUPLICATED');
    resultIs(f.run(['check-dedup', '--sid', 'lock-fixture', '--ref-hash', 'fixture-hash']), 8, 'deduplicated');
    assert.equal(f.doc().generation, 16);
    assert.equal(f.doc().dispatches.length, 1);
    assert.equal(statSync(f.lock).ino, lockIno);
    assert.equal(statSync(f.lock).size, 0);
    assert.deepEqual(f.doc().dispatches[0].outcome, { state: 'unknown', reported_value: null, basis: null });
    f.noTemps();
  });
  for (const fault of ['temp_write', 'fsync', 'rename', 'dir_fsync', 'lock']) {
    test(`native POSIX ${fault} failure retains a complete generation and no false success`, t => {
      const f = fixture(t), before = f.bytes();
      resultIs(f.run(['set-lifecycle', '--sid', 'lock-fixture', '--state', 're_dispatched'],
        { AIGENTRY_REGISTRY_FAULT: fault }), 9, fault === 'lock' ? 'registry_unavailable' : 'registry_write_failed');
      if (fault === 'dir_fsync') {
        assert.equal(f.doc().generation, 13);
        assert.equal(f.doc().dispatches[0].lifecycle.state, 're_dispatched');
      } else assert.deepEqual(f.bytes(), before);
      f.noTemps();
    });
  }
}

// Supplementary controlled child imports. These mocks do NOT certify native Windows.
const injectedCode = String.raw`
import errno,importlib.util,json,os,sys,types
spec=importlib.util.spec_from_file_location('registry_under_test',sys.argv[1])
r=importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
mode=sys.argv[2]
events=[]
real_open=open
class Handle:
    def __init__(self,f): self.f=f
    def fileno(self): return self.f.fileno()
    def seek(self,*args):
        events.append(['seek',*args])
        if mode == 'seek': raise OSError(errno.EINVAL,'injected seek')
        return self.f.seek(*args)
    def close(self):
        self.f.close()
        events.append(['closed',self.f.closed])
        if mode in ('close','primary-close'): raise OSError(errno.EIO,'injected close')
def controlled_open(path,*args,**kwargs):
    f=real_open(path,*args,**kwargs)
    return Handle(f) if str(path).endswith('.lock') else f
r.open=controlled_open
def locking(fd,kind,n):
    events.append(['locking',kind,n])
    assert n == 1
    if kind == 1 and mode == 'acquire': raise OSError(errno.EBADF,'injected acquire')
    if kind == 2 and mode in ('unlock','primary-unlock','dedup-unlock','retry-unlock','proceed-unlock'):
        raise OSError(errno.EIO,'injected unlock')
if sys.argv[4] == 'Windows':
    r.os=types.SimpleNamespace(**dict(vars(os),name='nt'))
    r.msvcrt=types.SimpleNamespace(locking=locking,LK_NBLCK=1,LK_UNLCK=2)
else:
    r.os=types.SimpleNamespace(**dict(vars(os),name='posix'))
    r.fcntl=types.SimpleNamespace(LOCK_EX=4,LOCK_NB=8,LOCK_UN=2,
        flock=lambda f,kind: locking(f.fileno(),2 if kind == 2 else 1,1))
if mode in ('dedup-unlock','retry-unlock','proceed-unlock'):
    # Isolate output ordering from U1's unconditional Windows write refusal.
    # No durable-write acceptance is inferred from this mocked commit.
    r.commit=lambda doc: events.append(['mock_commit'])
args=json.loads(sys.argv[3])
try:
    rc=r.main(args)
finally:
    print('INJECTED_RECEIPT '+json.dumps(events),file=sys.stderr)
sys.exit(rc)
`;
for (const backend of ['Windows', 'POSIX']) {
for (const mode of ['acquire', ...(backend === 'Windows' ? ['seek'] : []), 'unlock', 'close', 'primary-unlock', 'primary-close', 'dedup-unlock', 'retry-unlock', 'proceed-unlock']) {
  test(`supplementary mocked ${backend} ${mode}: cleanup, primary error and emission ordering`, t => {
    const f = fixture(t, mode === 'proceed-unlock' ? [] : [record('cleaned', mode === 'dedup-unlock' ? 'write_observed' : 'unknown')]);
    const args = mode.startsWith('primary') ? ['observe', '--sid', 'absent', '--kind', 'probe']
      : ['dedup-unlock', 'retry-unlock', 'proceed-unlock'].includes(mode) ? begin : noop;
    const result = spawnSync(python, ['-I', '-B', '-c', injectedCode, registry, mode, JSON.stringify(args), backend],
      { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    const receipt = result.stderr.split('\n').find(line => line.startsWith('INJECTED_RECEIPT '));
    assert.ok(receipt, result.stderr);
    const events: unknown[][] = JSON.parse(receipt.slice('INJECTED_RECEIPT '.length));
    assert.deepEqual(events.filter(event => event[0] === 'closed'), [['closed', true]], result.stderr);
    assert.equal(result.status, 9, result.stdout + result.stderr);
    // Parsing the entire stream also rejects an early success/dedup JSON payload.
    assert.equal(JSON.parse(result.stdout).result, mode.startsWith('primary') ? 'dispatch_not_found' : 'registry_unavailable');
    if (backend === 'Windows') assert.deepEqual(events[0], ['seek', 0, 0]);
    if (mode === 'acquire' || mode === 'seek') {
      assert.equal(events.filter(event => event[0] === 'locking' && event[1] === 2).length, 0);
    } else {
      assert.deepEqual(events.filter(event => event[0] === 'locking'), [['locking', 1, 1], ['locking', 2, 1]]);
      assert.equal(events.filter(event => event[0] === 'seek').length, backend === 'Windows' ? 2 : 0);
    }
    if (mode.startsWith('primary')) assert.match(readFileSync(join(f.state, 'registry-health.log'), 'utf8'), /lock cleanup failed/);
    assert.equal(f.doc().generation, 12);
    f.noTemps();
  });
}
}
