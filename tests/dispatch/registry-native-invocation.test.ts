import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { registryAvailable, registryEnvironment, registryInvocation } from '../../src/dispatch/registry-command.js';

const commandModule = new URL('../../src/dispatch/registry-command.js', import.meta.url).href;
const sid = 'worker 한글 with spaces';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'registry native 한글 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  mkdirSync(state);
  mkdirSync(bin);
  const script = join(root, 'override helper 한글.py');
  const calls = join(root, 'calls.jsonl');
  writeFileSync(script, `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['NATIVE_CALLS'], 'a', encoding='utf-8') as log:
    log.write(json.dumps(dict(argv=sys.argv[1:], encoding=sys.stdout.encoding,
        inherited=os.environ.get('NATIVE_INHERITED')), ensure_ascii=True) + '\\n')
print(os.environ.get('NATIVE_STDOUT', '출력 한글'), end='')
print(os.environ.get('NATIVE_STDERR', '오류 한글'), end='', file=sys.stderr)
sys.exit(int(os.environ.get('NATIVE_STATUS', '0')))
`);
  chmodSync(script, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root,
    DISPATCH_STATE_DIR: state, HITL_STATE_DIR: join(root, 'hitl'),
    TEST_REPORTS_DIR: join(root, 'test-reports'), DISPATCH_SCRIPT_DIR: bin,
    AIGENTRY_SHIM_SCRIPT_DIR: bin, DISPATCH_REGISTRY_PY: script,
    AIGENTRY_TASK_QUEUE: join(root, 'task-queue.json'),
    PYTHONIOENCODING: 'cp1252', PYTHONDONTWRITEBYTECODE: '1',
    NATIVE_CALLS: calls, NATIVE_INHERITED: 'inherited 한글', NATIVE_STATUS: '0',
    NATIVE_STDOUT: '출력 한글', NATIVE_STDERR: '오류 한글' };
  return { root, state, bin, script, calls, env };
}
type Fixture = ReturnType<typeof fixture>;

function recorded(f: Fixture): { argv: string[]; encoding: string; inherited: string }[] {
  return existsSync(f.calls) ? readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

function invoke(f: Fixture, args: string[], script = f.script) {
  const invocation = registryInvocation(script, args, process.platform);
  return spawnSync(invocation.cmd, invocation.args, {
    shell: false, env: registryEnvironment(f.env), encoding: 'utf8', timeout: 10_000,
  });
}

test('native command preserves override, argument boundaries and UTF-8 without parent mutation', t => {
  const f = fixture(t);
  const before = { ...process.env };
  const inherited = { ...f.env };
  const args = ['snapshot', '', sid, 'tab\tvalue', 'line\nbreak', '"quoted"', '& echo nope', '$HOME', '%PATH%'];
  const invocation = registryInvocation(f.script, args, process.platform);
  assert.deepEqual(invocation, process.platform === 'win32'
    ? { cmd: 'python', args: [f.script, ...args] } : { cmd: f.script, args });
  assert.equal(registryAvailable(f.script), true);
  const result = invoke(f, args);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.trim(), '출력 한글');
  assert.equal(result.stderr.trim(), '오류 한글');
  assert.deepEqual(recorded(f), [{ argv: args, encoding: 'utf-8', inherited: 'inherited 한글' }]);
  assert.deepEqual(f.env, inherited);
  assert.deepEqual({ ...process.env }, before);
  const unrelated = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.PYTHONIOENCODING)'],
    { env: f.env, encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(unrelated.stdout, 'cp1252');
});

test('missing, directory, nonzero and timeout remain unsuccessful on the native OS', t => {
  const f = fixture(t);
  for (const script of [join(f.root, 'missing.py'), f.root]) {
    assert.equal(registryAvailable(script), false);
    assert.notEqual(invoke(f, ['snapshot'], script).status, 0);
  }
  f.env.NATIVE_STATUS = '9';
  const failed = invoke(f, ['snapshot']);
  assert.ifError(failed.error);
  assert.equal(failed.status, 9);
  assert.equal(failed.stdout.trim(), '출력 한글');
  assert.equal(failed.stderr.trim(), '오류 한글');
  const sleeping = join(f.root, 'sleep.py');
  writeFileSync(sleeping, '#!/usr/bin/env python3\nimport time\ntime.sleep(30)\n');
  chmodSync(sleeping, 0o755);
  const invocation = registryInvocation(sleeping, [], process.platform);
  const timeout = spawnSync(invocation.cmd, invocation.args, {
    env: registryEnvironment(f.env), shell: false, timeout: 200, encoding: 'utf8',
  });
  assert.equal((timeout.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT');
  assert.notEqual(timeout.status, 0);
  if (process.platform !== 'win32') {
    chmodSync(f.script, 0o644);
    assert.equal(registryAvailable(f.script), false);
    assert.equal((invoke(f, []).error as NodeJS.ErrnoException | undefined)?.code, 'EACCES');
  }
});

function repository(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'bin', 'dispatch-registry.py'))) {
    const parent = dirname(dir);
    assert.notEqual(parent, dir, 'actual registry helper is required');
    dir = parent;
  }
  return dir;
}

test('real helper snapshot uses only synthetic authority and preserves its bytes', t => {
  const f = fixture(t);
  const authority = join(f.state, 'active.json');
  const envelope = { schema_version: 2, generation: 37, dispatches: [{
    dispatch_id: 'native-1', assigned: { sid, session_epoch: null },
    dedup: { key: 'native-key', ref_hash: 'native-ref' },
    outcome: { state: 'unknown', reported_value: null, basis: null },
    lifecycle: { state: 'cleaned', at: '2026-08-16T00:00:00Z' },
  }] };
  writeFileSync(authority, JSON.stringify(envelope) + '\n');
  const before = readFileSync(authority);
  const result = invoke(f, ['snapshot'], join(repository(), 'bin', 'dispatch-registry.py'));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), envelope);
  assert.deepEqual(readFileSync(authority), before);
  assert.equal(existsSync(`${authority}.lock`), false);
});

// Execute the exact compiled registry functions, without importing executable CLIs
// or running their cleanup/injection/lifecycle entrypoints. This harness does not
// replace spawnSync or process.platform: every registry child is actual Python.
const functions = {
  dispatch: ['captureBoth', 'registryMissing', 'registryBoth', 'registryOut', 'registryQuiet'],
  tracker: ['capture', 'runInherit', 'registryCapture', 'registryRun', 'registryOrDie', 'cmdPrune'],
  reconciler: ['run', 'registry'],
  hitl: ['runQuiet', 'chomp', 'registryQuiet', 'registryLifecycle'],
  'inject-handler': ['registryObserve'],
  cleanup: ['runQuiet', 'registryCleaned'],
  'cleanup-scheduler': ['chomp', 'isKeepAlive'],
} as const;
type Caller = keyof typeof functions;

function caller(f: Fixture, name: Caller, expression: string) {
  const source = readFileSync(new URL(`../../src/${name}/cli.js`, import.meta.url), 'utf8');
  const declarations = functions[name].map(fn => {
    const match = source.match(new RegExp(`^function ${fn}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, `compiled ${name}.${fn} must exist`);
    return match[0];
  }).join('\n');
  const driver = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registryAvailable, registryEnvironment, registryInvocation } from ${JSON.stringify(commandModule)};
const env = process.env;
const DISPATCH_REGISTRY_PY = env.DISPATCH_REGISTRY_PY;
const before = { ...env };
${declarations}
const result = ${expression};
assert.deepEqual({ ...process.env }, before, 'caller mutated parent environment');
console.log('\\nNATIVE_RESULT=' + JSON.stringify(result ?? null));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    env: f.env, encoding: 'utf8', shell: false, timeout: 10_000,
  });
}

function returned(result: ReturnType<typeof caller>): unknown {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split('\n').find(value => value.startsWith('NATIVE_RESULT='));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice('NATIVE_RESULT='.length));
}

for (const status of [0, 9]) {
  test(`dispatch capture/quiet preserve status ${status} and stream policies`, t => {
    const f = fixture(t);
    f.env.NATIVE_STATUS = String(status);
    assert.deepEqual(returned(caller(f, 'dispatch', 'registryBoth(["check-dedup"])')),
      { status, output: '출력 한글오류 한글' });
    const out = caller(f, 'dispatch', 'registryOut(["begin-delivery"])');
    assert.deepEqual(returned(out), { status, stdout: '출력 한글' });
    assert.equal(out.stderr.trim(), '오류 한글');
    const quiet = caller(f, 'dispatch', 'registryQuiet(["set-transport"])');
    assert.equal(returned(quiet), status);
    assert.equal(quiet.stderr.trim(), '오류 한글');
    assert.equal(quiet.stdout.includes('출력 한글'), false);
  });

  test(`tracker capture, fatal writes, conditional writes and prune preserve status ${status}`, t => {
    const f = fixture(t);
    f.env.NATIVE_STATUS = String(status);
    assert.deepEqual(returned(caller(f, 'tracker', 'registryCapture(["list"])')),
      { status, stdout: '출력 한글' });
    assert.equal(returned(caller(f, 'tracker', 'registryRun(["observe"])')), status);
    assert.equal(caller(f, 'tracker', 'registryOrDie(["set-lifecycle"])').status, status);
    const prune = caller(f, 'tracker', 'cmdPrune()');
    assert.ifError(prune.error);
    assert.equal(prune.status, status);
    assert.deepEqual(recorded(f).at(-1)?.argv, ['prune', '--older-than-seconds', '86400']);
  });

  test(`reconciler and HITL retain their different status ${status} read/write policies`, t => {
    const f = fixture(t);
    f.env.NATIVE_STATUS = String(status);
    const reconciler = caller(f, 'reconciler', 'registry(["list"], { err: "ignore" })');
    assert.deepEqual(returned(reconciler), { status, stdout: '출력 한글' });
    assert.equal(reconciler.stderr, '');
    assert.equal(returned(caller(f, 'hitl', `registryLifecycle(${JSON.stringify(sid)})`)),
      status === 0 ? '출력 한글' : '');
    assert.equal(returned(caller(f, 'hitl', 'registryQuiet(["set-gate"])')), status);
  });

  test(`observe/cleanup/scheduler retain swallowed and protective status ${status} policies`, t => {
    const f = fixture(t);
    f.env.NATIVE_STATUS = String(status);
    f.env.NATIVE_STDOUT = 'false';
    assert.equal(returned(caller(f, 'inject-handler', 'registryObserve(["observe", "--sid", "한글"])')), null);
    const cleanup = caller(f, 'cleanup', `registryCleaned(${JSON.stringify(sid)})`);
    assert.equal(returned(cleanup), null);
    assert.equal(cleanup.stderr, '');
    const cleanupCalls = recorded(f).slice(1).map(row => row.argv);
    assert.deepEqual(cleanupCalls, [
      ['observe', '--sid', sid, '--kind', 'session_absent_observed', '--all'],
      ...(status === 0 ? [['set-lifecycle', '--sid', sid, '--state', 'cleaned', '--all']] : []),
    ]);
    assert.equal(returned(caller(f, 'cleanup-scheduler', `isKeepAlive(${JSON.stringify(sid)})`)), status !== 0);
    for (const row of recorded(f)) {
      assert.equal(row.encoding, 'utf-8');
      assert.equal(row.inherited, 'inherited 한글');
    }
  });
}

test('availability failures retain caller-specific missing helper outcomes', t => {
  const f = fixture(t);
  f.env.DISPATCH_REGISTRY_PY = join(f.root, 'missing helper.py');
  assert.deepEqual(returned(caller(f, 'dispatch', 'registryBoth([])')), { status: 9, output: '' });
  assert.equal(returned(caller(f, 'dispatch', 'registryQuiet([])')), 9);
  const missingStatus = process.platform === 'win32' ? 2 : 127;
  assert.equal(returned(caller(f, 'tracker', 'registryRun([])')), missingStatus);
  assert.deepEqual(returned(caller(f, 'reconciler', 'registry([])')), { status: missingStatus, stdout: '' });
  assert.equal(returned(caller(f, 'hitl', 'registryLifecycle("missing")')), '');
  assert.equal(returned(caller(f, 'inject-handler', 'registryObserve([])')), null);
  assert.equal(returned(caller(f, 'cleanup', 'registryCleaned("missing")')), null);
  assert.equal(returned(caller(f, 'cleanup-scheduler', 'isKeepAlive("missing")')), true);
  assert.deepEqual(recorded(f), []);
});

test('reconciler preserves explicit child environment, stdin and ignored stdout', t => {
  const f = fixture(t);
  writeFileSync(f.script, `#!/usr/bin/env python3
import os, sys
assert sys.stdin.read() == '입력 한글'
assert os.environ['NATIVE_INHERITED'] == 'explicit override'
assert os.environ['PYTHONIOENCODING'] == 'utf-8'
print('출력 한글', end='')
sys.exit(7)
`);
  const result = caller(f, 'reconciler', `registry(['observe'], {
    stdin: '입력 한글', out: 'ignore', err: 'ignore',
    env: { ...process.env, NATIVE_INHERITED: 'explicit override', PYTHONIOENCODING: 'ascii' }
  })`);
  assert.deepEqual(returned(result), { status: 7, stdout: '' });
});

test('native Python termination retains signal/null-status failure handling', t => {
  const f = fixture(t);
  writeFileSync(f.script, '#!/usr/bin/env python3\nimport os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n');
  const direct = invoke(f, []);
  assert.ifError(direct.error);
  assert.notEqual(direct.status, 0);
  // Windows reports its native termination status; POSIX reports a signal.
  const status = direct.status ?? 1;
  if (process.platform !== 'win32') assert.equal(direct.signal, 'SIGTERM');
  assert.equal(returned(caller(f, 'dispatch', 'registryQuiet([])')), status);
  assert.equal(returned(caller(f, 'tracker', 'registryRun([])')), status);
  assert.deepEqual(returned(caller(f, 'reconciler', 'registry([])')), { status, stdout: '' });
  assert.equal(returned(caller(f, 'hitl', 'registryLifecycle("terminated")')), '');
  assert.equal(returned(caller(f, 'cleanup-scheduler', 'isKeepAlive("terminated")')), true);
});

test('actual CLI wiring reaches native Python and retains failure/protection policies', t => {
  const f = fixture(t);
  const ref = join(f.root, 'ref.md');
  writeFileSync(ref, 'Synthetic registry caller fixture.\n');
  writeFileSync(f.env.AIGENTRY_TASK_QUEUE!, JSON.stringify({
    tasks: [{ id: 'native-fixture', status: 'pending' }],
  }));
  const cases: { name: Caller; args: string[]; operation: string; status: number }[] = [
    { name: 'dispatch', args: ['--ref', ref, '--target', sid, '--task', 'native-fixture'], operation: 'check-dedup', status: 9 },
    { name: 'tracker', args: ['prune'], operation: 'prune', status: 9 },
    { name: 'reconciler', args: ['--shadow'], operation: 'list', status: 9 },
    { name: 'cleanup-scheduler', args: ['schedule', sid], operation: 'get', status: 0 },
  ];
  f.env.NATIVE_STATUS = '9';
  for (const item of cases) {
    const before = recorded(f).length;
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL(`../../src/${item.name}/cli.js`, import.meta.url)), ...item.args],
      { env: f.env, encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, item.status, `${item.name}: ${result.stderr}`);
    const calls = recorded(f).slice(before);
    assert.equal(calls.length, 1, item.name);
    assert.equal(calls[0]?.argv[0], item.operation);
    assert.equal(calls[0]?.encoding, 'utf-8');
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.state, 'cleanup-pending.json'), 'utf8')), []);
});

test('all CLI entrypoints still start; shared helper import has no CLI effects', t => {
  const f = fixture(t);
  for (const name of Object.keys(functions) as Caller[]) {
    // Cleanup checks system dependencies before --help; its existing unknown probe
    // verifies startup without listing/killing sessions or requiring those tools.
    const args = name === 'cleanup' ? ['__probe', 'native-test-unknown'] : ['--help'];
    const result = spawnSync(process.execPath,
      [fileURLToPath(new URL(`../../src/${name}/cli.js`, import.meta.url)), ...args],
      { env: f.env, encoding: 'utf8', shell: false, timeout: 10_000 });
    assert.ifError(result.error);
    assert.equal(result.status, name === 'cleanup' ? 4 : 0, `${name}: ${result.stderr}`);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(commandModule)})`],
    { env: f.env, encoding: 'utf8', shell: false, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(recorded(f), []);
  const dispatch = readFileSync(new URL('../../src/dispatch/cli.js', import.meta.url), 'utf8');
  assert.match(dispatch, /export\s*\{\s*registryInvocation\s*\}\s*from\s*["']\.\/registry-command\.js["']/);
});
