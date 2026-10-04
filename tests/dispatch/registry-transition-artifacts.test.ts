import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

// #1167 prerequisite guard: an uncertain SQLite transition state must never fall back to
// the legacy JSON path. Black-box CLI runs against private fixtures; no Python patching.
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
// Optional immutable subject input; ordinary discovery needs no private env.
const registry = resolve(process.env.REGISTRY_TRANSITION_TEST_SCRIPT ?? join(repo, 'bin/dispatch-registry.py'));
const windows = process.platform === 'win32';
// Native text-mode stdout newline of the registry process: CRLF on win32, LF otherwise.
const expectedNewline = windows ? '\r\n' : '\n';
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

// Reserved names from the prior transition contract. Nothing else is a transition artifact.
const ARTIFACTS = ['active.db', 'active.db-journal', 'active.db-wal', 'active.db-shm',
  'active.json.source', 'active.json.pre-sqlite.bak', 'active.json.barrier.tmp'] as const;
// Every known registry operation, in --list-ops order. A new operation must join this table.
const OPERATIONS = ['archive-sidecars', 'begin-delivery', 'check-dedup', 'get', 'list', 'migrate',
  'observe', 'prune', 'set-gate', 'set-lifecycle', 'set-transport-result', 'snapshot'] as const;
// Diagnostic siblings a refusal may touch; neither is registry data or authority.
const DIAGNOSTIC = new Set(['state/registry-health.log', 'state/active.json.lock']);
// Native Windows keeps refusing durable writes (registry-native-locking.test.ts pins the same
// string). Mutation controls expect this refusal there, never a durability waiver or a skip.
const WINDOWS_WRITE_REFUSAL = 'native Windows directory durability unavailable; registry write refused';
const LEGACY = [
  { sid: 'live-worker', status: 'in_flight', ref_hash: 'hash-live', cwd: '/tmp/live' },
  { sid: 'claimed-done', status: 'auto_reported', ref_hash: 'hash-done' },
];

function record(state = 'cleaned', transport = 'unknown') {
  return {
    dispatch_id: 'transition-fixture', assigned: { sid: 'lock-fixture', session_epoch: null },
    dedup: { key: createHash('sha256').update('lock-fixture\0fixture-hash').digest('hex'), ref_hash: 'fixture-hash' },
    outcome: { state: 'unknown', reported_value: null, basis: null },
    lifecycle: { state, at: '2026-05-12T11:00:00Z' }, transport: { result: transport, inject_id: null, at: null },
    gate: { state: null, prev_lifecycle: null }, observations: [], last_observation: null,
    last_seen_at: '2026-05-12T11:00:00Z', re_dispatch_count: 0, keep_alive: false,
  };
}
type Start = 'absent' | 'valid' | 'legacy-array';
function fixture(t: TestContext, start: Start, records = [record()]) {
  const root = mkdtempSync(join(tmpdir(), 'registry-transition-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const active = join(state, 'active.json'), sidecars = join(root, 'dispatch-helper');
  const env: NodeJS.ProcessEnv = { ...essential, HOME: root, USERPROFILE: root,
    TMPDIR: root, TMP: root, TEMP: root, DISPATCH_STATE_DIR: state };
  if (start === 'valid') writeFileSync(active, JSON.stringify({ schema_version: 2, generation: 12, dispatches: records }));
  if (start === 'legacy-array') writeFileSync(active, JSON.stringify(LEGACY));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (args: string[]) => {
    const result = spawnSync(python, ['-I', '-B', registry, ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 16000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    // Raw evidence: every exit/stdout/stderr is preserved in the TAP stream.
    t.diagnostic(`RAW ${JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr })}`);
    return result;
  };
  const doc = () => JSON.parse(readFileSync(active, 'utf8'));
  return { root, state, active, sidecars, run, doc };
}
type Fixture = ReturnType<typeof fixture>;

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
// lstat-only walk: symlinks are recorded by target text and never followed.
function tree(root: string, skip: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const relName = rel ? `${rel}/${name}` : name;
      if (skip.has(relName)) continue;
      const full = join(root, relName), st = lstatSync(full);
      if (st.isSymbolicLink()) out[relName] = `link:${readlinkSync(full)}`;
      else if (st.isDirectory()) { out[relName] = 'dir'; walk(relName); }
      else if (st.isFile()) out[relName] = `file:${sha(readFileSync(full))}`;
      else out[relName] = 'other';
    }
  };
  walk('');
  return out;
}
function changes(before: Record<string, string>, after: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return names.filter(name => before[name] !== after[name])
    .map(name => `${name}: ${before[name] ?? 'absent'} -> ${after[name] ?? 'absent'}`);
}
function payloadOf(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function plant(f: Fixture, artifact: string) {
  writeFileSync(join(f.state, artifact), `synthetic ${artifact} transition bytes\n`);
}
function sidecarDir(f: Fixture) {
  mkdirSync(f.sidecars);
  writeFileSync(join(f.sidecars, 'live-worker'), 'hash-live\n');
  writeFileSync(join(f.sidecars, 'claimed-done'), 'hash-done\n');
}

// A guard refusal must name the transition state. A generic exit 9 (e.g. the native Windows
// durability refusal an unguarded writer already returns) is not evidence of the guard.
function identifiesTransition(detail: unknown): boolean {
  return typeof detail === 'string' && (/transition/i.test(detail) || ARTIFACTS.some(name => detail.includes(name)));
}
// Desired black-box refusal: exit 9, completion_fact null, registry_unavailable naming the
// transition state, and the whole fixture (artifacts, active.json presence/bytes, sidecars)
// unchanged. Only the health log may change; the lock sibling may appear empty or keep its bytes.
function refuses(f: Fixture, args: string[]) {
  const lock = join(f.state, 'active.json.lock');
  const priorLock = present(lock) ? sha(readFileSync(lock)) : null;
  const before = tree(f.root, DIAGNOSTIC);
  const result = f.run(args);
  const after = tree(f.root, DIAGNOSTIC);
  const payload = payloadOf(result.stdout);
  const lockAfter = present(lock) ? readFileSync(lock) : null;
  const observed = {
    status: result.status,
    stderr: result.stderr,
    completion_fact: payload && 'completion_fact' in payload ? payload.completion_fact : 'missing',
    result: payload?.result ?? 'missing',
    detail_identifies_transition: identifiesTransition(payload?.detail),
    fixture_changes: changes(before, after),
    lock_ok: lockAfter === null || (priorLock === null ? lockAfter.length === 0 : sha(lockAfter) === priorLock),
  };
  assert.deepEqual(observed, { status: 9, stderr: '', completion_fact: null, result: 'registry_unavailable',
    detail_identifies_transition: true, fixture_changes: [], lock_ok: true }, `${args.join(' ')}: ${result.stdout}`);
}
function ok(result: ReturnType<Fixture['run']>, status: number, name: string) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result, name);
  return payload;
}
function windowsWriteRefused(result: ReturnType<Fixture['run']>) {
  const payload = ok(result, 9, 'registry_write_failed');
  assert.equal(payload.detail, WINDOWS_WRITE_REFUSAL);
  assert.equal(payload.completion_fact, null);
}

const NOW = '2026-10-04T00:00:00Z';
function operationArgs(f: Fixture, op: typeof OPERATIONS[number]): string[] {
  switch (op) {
    case 'archive-sidecars': return [op, '--dir', f.sidecars];
    case 'begin-delivery': return [op, '--sid', 'transition-probe', '--ref-hash', 'probe-hash', '--now', NOW];
    case 'check-dedup': return [op, '--sid', 'lock-fixture', '--ref-hash', 'fixture-hash'];
    case 'get': return [op, '--sid', 'lock-fixture'];
    case 'list': return [op, '--fields', 'assigned.sid,lifecycle.state'];
    case 'migrate': return [op, '--now', NOW];
    case 'observe': return [op, '--sid', 'lock-fixture', '--kind', 'transition_probe', '--now', NOW];
    case 'prune': return [op, '--older-than-seconds', '0', '--now', NOW];
    case 'set-gate': return [op, '--sid', 'lock-fixture', '--state', 'awaiting_user', '--now', NOW];
    case 'set-lifecycle': return [op, '--sid', 'lock-fixture', '--state', 're_dispatched', '--now', NOW];
    case 'set-transport-result': return [op, '--sid', 'lock-fixture', '--result', 'write_observed', '--now', NOW];
    case 'snapshot': return [op];
  }
}

test('receipt: subject identity, private fixture root and exact operation table', t => {
  const identity = spawnSync(python, ['-I', '-B', '-c', 'import json,os,sys; print(json.dumps(dict(executable=sys.executable,version=sys.version,platform=sys.platform,os_name=os.name)))'],
    { env: essential, encoding: 'utf8', timeout: 5000 });
  assert.equal(identity.status, 0, identity.stderr);
  t.diagnostic(`python ${identity.stdout.trim()}; node=${process.version}; tmpdir=${tmpdir()}; repo=${repo}`);
  t.diagnostic(`registry=${registry}; sha256=${sha(readFileSync(registry))}`);
  t.diagnostic(windows ? 'native Windows run' : 'native POSIX only; Windows branches require native Windows CI');
  const f = fixture(t, 'absent');
  const result = f.run(['--list-ops']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, OPERATIONS.join(expectedNewline) + expectedNewline);
});

test('baseline valid JSON read protocol: snapshot/get/list/check-dedup unchanged', t => {
  const f = fixture(t, 'valid'), before = tree(f.root);
  const snapshot = f.run(['snapshot']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout), f.doc());
  const get = f.run(['get', '--sid', 'lock-fixture']);
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(JSON.parse(get.stdout), record());
  assert.equal(f.run(['get', '--sid', 'lock-fixture', '--pointer', 'lifecycle.state']).stdout, `cleaned${expectedNewline}`);
  ok(f.run(['get', '--sid', 'absent']), 0, 'dispatch_not_found');
  assert.equal(f.run(['list', '--fields', 'assigned.sid,lifecycle.state,gate.state']).stdout, `lock-fixture\tcleaned\tnull${expectedNewline}`);
  assert.equal(f.run(['list', '--live']).stdout, '');
  ok(f.run(['check-dedup', '--sid', 'lock-fixture', '--ref-hash', 'fixture-hash']), 7, 'retry_held');
  ok(f.run(['check-dedup', '--sid', 'absent', '--ref-hash', 'x']), 0, 'proceed');
  assert.deepEqual(changes(before, tree(f.root)), [], 'reads mutated the fixture');
});

test('baseline valid JSON mutation protocol: 0/7/8, observe/lifecycle/gate/prune and generation', t => {
  const f = fixture(t, 'valid', []);
  const begin = ['begin-delivery', '--sid', 'lock-fixture', '--ref-hash', 'fixture-hash'];
  if (windows) {
    const before = readFileSync(f.active);
    windowsWriteRefused(f.run(begin));
    windowsWriteRefused(f.run(['prune', '--older-than-seconds', '0']));
    assert.deepEqual(readFileSync(f.active), before);
    assert.equal(readdirSync(f.state).filter(name => name.endsWith('.tmp')).length, 0);
    return;
  }
  assert.equal(ok(f.run(begin), 0, 'proceed').completion_fact, null);
  ok(f.run(begin), 7, 'DISPATCH_RETRY_HELD');
  assert.equal(f.run(['set-transport-result', '--sid', 'lock-fixture', '--result', 'write_observed']).status, 0);
  ok(f.run(begin), 8, 'DISPATCH_DEDUPLICATED');
  ok(f.run(['check-dedup', '--sid', 'lock-fixture', '--ref-hash', 'fixture-hash']), 8, 'deduplicated');
  assert.equal(f.doc().generation, 16);
  for (const args of [['observe', '--sid', 'lock-fixture', '--kind', 'probe'],
    ['set-lifecycle', '--sid', 'lock-fixture', '--state', 're_dispatched'],
    ['set-gate', '--sid', 'lock-fixture', '--state', 'awaiting_user'],
    ['set-gate', '--sid', 'lock-fixture', '--clear'],
    ['prune', '--older-than-seconds', '0', '--now', '2030-01-01T00:00:00Z'],
    ['set-lifecycle', '--sid', 'lock-fixture', '--state', 'cleaned', '--now', '2026-01-01T00:00:00Z'],
    ['prune', '--older-than-seconds', '60', '--now', '2030-01-01T00:00:00Z']]) {
    const result = f.run(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout + result.stderr, '');
  }
  assert.equal(f.doc().generation, 23);
  assert.deepEqual(f.doc().dispatches, []);
  assert.equal(readdirSync(f.state).filter(name => name.endsWith('.tmp')).length, 0);
});

test('baseline absent active.json without artifacts keeps the fresh-empty legacy behavior', t => {
  const f = fixture(t, 'absent'), before = tree(f.root);
  const snapshot = f.run(['snapshot']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout), { schema_version: 2, generation: 0, dispatches: [] });
  ok(f.run(['check-dedup', '--sid', 'a', '--ref-hash', 'h']), 0, 'proceed');
  ok(f.run(['get', '--sid', 'a']), 0, 'dispatch_not_found');
  assert.equal(f.run(['list']).stdout, '');
  assert.deepEqual(changes(before, tree(f.root)), [], 'reads created registry files');
  if (windows) {
    windowsWriteRefused(f.run(['begin-delivery', '--sid', 'a', '--ref-hash', 'h']));
    assert.equal(present(f.active), false, 'refused write created active.json');
    return;
  }
  ok(f.run(['begin-delivery', '--sid', 'a', '--ref-hash', 'h']), 0, 'proceed');
  assert.equal(f.doc().generation, 1);
  assert.equal(f.doc().dispatches.length, 1);
});

for (const start of ['absent', 'valid'] as const) {
  test(`baseline legacy-v1 backup, lock and health log are not transition artifacts (${start} active.json)`, t => {
    const f = fixture(t, start);
    const legacy = { 'active.json.legacy-v1.bak': 'legacy-v1 preserved bytes\n', 'active.json.lock': 'existing lock bytes\n',
      'registry-health.log': '2026-01-01T00:00:00Z registry_corrupt prior diagnostic\n' };
    for (const [name, bytes] of Object.entries(legacy)) writeFileSync(join(f.state, name), bytes);
    const snapshot = f.run(['snapshot']);
    assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);
    assert.equal(JSON.parse(snapshot.stdout).generation, start === 'valid' ? 12 : 0);
    const begin = f.run(['begin-delivery', '--sid', 'transition-probe', '--ref-hash', 'probe-hash']);
    if (windows) {
      windowsWriteRefused(begin);
      assert.equal(present(f.active), start === 'valid');
      if (start === 'valid') assert.equal(f.doc().generation, 12);
    } else {
      ok(begin, 0, 'proceed');
      assert.equal(f.doc().generation, start === 'valid' ? 13 : 1);
    }
    assert.equal(readFileSync(join(f.state, 'active.json.legacy-v1.bak'), 'utf8'), legacy['active.json.legacy-v1.bak']);
    assert.equal(readFileSync(join(f.state, 'active.json.lock'), 'utf8'), legacy['active.json.lock']);
  });
}

// Reviewed: migrate refuses durable writes (require_durable_writes) after parsing and BEFORE
// writing the legacy-v1 backup, so a native Windows refusal leaves no backup behind.
test('baseline direct legacy migrate unchanged without artifacts', t => {
  const f = fixture(t, 'legacy-array');
  const original = readFileSync(f.active);
  if (windows) {
    windowsWriteRefused(f.run(['migrate', '--now', NOW]));
    assert.deepEqual(readFileSync(f.active), original);
    assert.equal(present(`${f.active}.legacy-v1.bak`), false, 'refused migrate wrote a backup');
  } else {
    const migrated = ok(f.run(['migrate', '--now', NOW]), 0, 'migrated');
    assert.equal(migrated.dispatches, 2);
    assert.deepEqual(readFileSync(`${f.active}.legacy-v1.bak`), original);
    assert.equal(f.doc().generation, 1);
    const again = ok(f.run(['migrate', '--now', NOW]), 9, 'already_schema_v2');
    assert.equal(again.completion_fact, null);
  }
});

// Separate on purpose: archive-sidecars writes no registry, so it must keep working on every OS.
test('baseline archive-sidecars unchanged without artifacts', t => {
  const f = fixture(t, 'valid');
  sidecarDir(f);
  ok(f.run(['archive-sidecars', '--dir', f.sidecars]), 0, 'archived');
  assert.equal(present(f.sidecars), false);
  assert.equal(readFileSync(join(`${f.sidecars}.archived`, 'live-worker'), 'utf8'), 'hash-live\n');
});

test('CLI usage and invalid arguments keep exit 4 with and without transition artifacts', async t => {
  const invalid: [string[], string][] = [[[], 'usage'], [['bogus-op'], 'unknown_operation'],
    [['snapshot', '--bogus', 'x'], 'invalid_argument'], [['snapshot', 'positional'], 'invalid_argument'],
    [['begin-delivery', '--sid', 'x'], 'invalid_argument'], [['get', '--sid'], 'invalid_argument'],
    [['migrate', '--dir', 'x'], 'invalid_argument'], [['archive-sidecars', '--now', NOW], 'invalid_argument']];
  for (const artifacts of [false, true]) {
    await t.test(artifacts ? 'all seven artifacts present' : 'no artifacts', st => {
      const f = fixture(st, 'valid');
      if (artifacts) for (const artifact of ARTIFACTS) plant(f, artifact);
      const before = tree(f.root);
      for (const [args, name] of invalid) {
        const payload = ok(f.run(args), 4, name);
        assert.equal(payload.completion_fact, null);
      }
      const listed = f.run(['--list-ops']);
      assert.equal(listed.status, 0);
      assert.equal(listed.stdout, OPERATIONS.join(expectedNewline) + expectedNewline);
      assert.deepEqual(changes(before, tree(f.root)), [], 'usage error mutated the fixture');
    });
  }
});

for (const start of ['absent', 'valid'] as const) {
  for (const artifact of ARTIFACTS) {
    test(`transition ${artifact} with ${start} active.json refuses snapshot and begin-delivery`, async t => {
      const f = fixture(t, start);
      plant(f, artifact);
      await t.test('snapshot', () => refuses(f, ['snapshot']));
      await t.test('begin-delivery', () => refuses(f, operationArgs(f, 'begin-delivery')));
      assert.equal(present(f.active), start === 'valid', 'active.json presence changed');
    });
  }
}

for (const start of ['absent', 'valid'] as const) {
  test(`broken symlink transition artifacts with ${start} active.json refuse without following`, async t => {
    for (const artifact of ARTIFACTS) {
      for (const op of ['snapshot', 'begin-delivery'] as const) {
        await t.test(`${artifact} ${op}`, st => {
          const f = fixture(st, start);
          // Dangling target stays inside this fixture; it must never be created through the link.
          const target = join(f.root, 'dangling', artifact);
          try {
            symlinkSync(target, join(f.state, artifact), 'file');
          } catch (error) {
            assert.fail(`symlink capability unsupported on ${process.platform}; qualification failed: ${String(error)}`);
          }
          assert.equal(existsSync(join(f.state, artifact)), false, 'symlink is not dangling');
          try {
            refuses(f, operationArgs(f, op));
          } finally {
            assert.equal(present(join(f.root, 'dangling')), false, 'symlink target was created');
          }
        });
      }
    }
  });
}

for (const op of OPERATIONS) {
  test(`every known operation refuses transition state: ${op}`, async t => {
    for (const artifact of ARTIFACTS) {
      await t.test(artifact, st => {
        const f = fixture(st, op === 'migrate' ? 'legacy-array' : 'valid');
        if (op === 'archive-sidecars') sidecarDir(f);
        plant(f, artifact);
        refuses(f, operationArgs(f, op));
      });
    }
  });
}
