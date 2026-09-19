import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classify, loadRegistryTracks, sweep } from '../../src/tracker/report-sweep.js';

function repository(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'bin', 'dispatch-registry.py'))) {
    const parent = dirname(dir);
    assert.notEqual(parent, dir, 'cannot locate the actual registry helper');
    dir = parent;
  }
  return dir;
}

function envelope(sids: string[]) {
  return { schema_version: 2, generation: 37, dispatches: sids.map((sid, index) => ({
    dispatch_id: `reader-${index}`, assigned: { sid, session_epoch: null },
    dedup: { key: `reader-key-${index}`, ref_hash: `reader-ref-${index}` },
    outcome: { state: 'unknown', reported_value: null, basis: null },
    lifecycle: { state: 'cleaned', at: '2026-08-16T00:00:00Z' },
  })) };
}

function fixture(t: TestContext, sids = ['rd1167-worker']) {
  const root = mkdtempSync(join(tmpdir(), 'registry reader 한글 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'explicit state 한글');
  const shared = join(root, 'shared');
  mkdirSync(state);
  mkdirSync(shared);
  const active = join(state, 'active.json');
  writeFileSync(active, JSON.stringify(envelope(sids), null, 2) + '\n');
  const before = readFileSync(active);
  return { root, state, shared, active, before };
}
type Fixture = ReturnType<typeof fixture>;

function unchanged(f: Fixture): void {
  assert.deepEqual(readFileSync(f.active), f.before, 'reader changed authority bytes');
  assert.equal(JSON.parse(readFileSync(f.active, 'utf8')).generation, 37);
  assert.equal(existsSync(`${f.active}.lock`), false, 'reader created an authority lock');
}

function helper(f: Fixture, body: string, file = join(f.root, 'helper space 한글.py')): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '#!/usr/bin/env python3\nimport json, os, sys\n' + body + '\n');
  chmodSync(file, 0o755);
  return file;
}

function setEnv(t: TestContext, name: string, value: string | undefined): void {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

// These read adapter cases run unchanged on native Windows, macOS and Linux.
test('actual Python snapshot preserves v2 authority and full SID/digit-prefix vocabulary', t => {
  const f = fixture(t, ['rd1167-worker', 'rd1167-worker', 'rd1167', 'architect-worker', 'ab', 'a1-x', '한글1167-worker', 'tab1167\tworker']);
  const tracks = loadRegistryTracks(f.state, join(repository(), 'bin', 'dispatch-registry.py'));
  const expected = ['rd1167-worker', 'rd1167', 'architect-worker', 'a1-x', '한글1167-worker', '한글1167', 'tab1167\tworker'];
  assert.deepEqual(tracks, expected.sort((a, b) => b.length - a.length || a.localeCompare(b)));
  assert.deepEqual(classify('# REPORT\nrd1167-worker and rd1167', tracks), { kind: 'REPORT', track: 'rd1167-worker' });
  assert.deepEqual(classify('# REPORT\nrd1167', tracks), { kind: 'REPORT', track: 'rd1167' });
  assert.deepEqual(classify('# REPORT\narchitect', tracks), { kind: 'REPORT', track: 'unknown' });
  assert.deepEqual(classify('# REPORT\ntrack: own42\nrd1167-worker', tracks), { kind: 'REPORT', track: 'own42' });
  assert.deepEqual(classify('# REPORT — title42\nrd1167-worker', tracks), { kind: 'REPORT', track: 'title42' });
  unchanged(f);
  assert.deepEqual(readdirSync(f.state), ['active.json']);
});

test('helper override receives snapshot, inherited configuration and explicit Unicode/space state root', t => {
  const f = fixture(t);
  const other = join(f.root, 'default root');
  mkdirSync(other);
  const otherActive = join(other, 'active.json');
  writeFileSync(otherActive, JSON.stringify(envelope(['wrong999-worker'])));
  const otherBefore = readFileSync(otherActive);
  setEnv(t, 'DISPATCH_STATE_DIR', other);
  setEnv(t, 'REGISTRY_READER_TEST_INHERITED', 'inherited-value');
  const script = helper(f, `assert sys.argv[1:] == ['snapshot']
assert os.environ['REGISTRY_READER_TEST_INHERITED'] == 'inherited-value'
default = os.path.join(os.path.dirname(__file__), 'default root')
with open(os.path.join(os.environ.get('DISPATCH_STATE_DIR', default), 'active.json'), encoding='utf-8') as source:
    print(json.dumps(json.load(source)))`);
  assert.deepEqual(loadRegistryTracks(f.state, script), ['rd1167-worker', 'rd1167']);
  assert.equal(process.env.DISPATCH_STATE_DIR, other, 'adapter changed parent configuration');
  assert.deepEqual(readFileSync(otherActive), otherBefore);
  unchanged(f);
});

for (const [name, payload] of [
  ['invalid JSON', '{broken'], ['null', 'null'], ['legacy array', '[]'],
  ['missing version', JSON.stringify({ generation: 37, dispatches: envelope(['wrong999']).dispatches })],
  ['wrong version', JSON.stringify({ ...envelope(['wrong999']), schema_version: 1 })],
  ['missing generation', JSON.stringify({ schema_version: 2, dispatches: envelope(['wrong999']).dispatches })],
  ['fractional generation', JSON.stringify({ ...envelope(['wrong999']), generation: 1.5 })],
  ['nonarray dispatches', JSON.stringify({ ...envelope([]), dispatches: {} })],
]) {
  test(`malformed snapshot (${name}) uses empty vocabulary without direct JSON retry`, t => {
    const f = fixture(t);
    const script = helper(f, `print(${JSON.stringify(payload)})`);
    assert.deepEqual(loadRegistryTracks(f.state, script), []);
    unchanged(f);
  });
}

test('nonzero helper output and missing helper fall back without reading valid local authority', t => {
  const f = fixture(t);
  const script = helper(f, `print(${JSON.stringify(JSON.stringify(envelope(['wrong999'])))})\nsys.exit(9)`);
  for (const target of [script, join(f.root, 'missing helper.py')]) {
    const tracks = loadRegistryTracks(f.state, target);
    assert.deepEqual(tracks, []);
    assert.deepEqual(classify('# REPORT — fallback42', tracks), { kind: 'REPORT', track: 'fallback42' });
  }
  unchanged(f);
});

test('helper timeout and excessive output use empty vocabulary', { timeout: 20_000 }, t => {
  const f = fixture(t);
  const sleeping = helper(f, 'import time\ntime.sleep(60)');
  assert.deepEqual(loadRegistryTracks(f.state, sleeping), []);
  const excessive = helper(f, "print('x' * (9 * 1024 * 1024))");
  assert.deepEqual(loadRegistryTracks(f.state, excessive), []);
  unchanged(f);
});

for (const selection of ['explicit', 'environment', 'repository'] as const) {
  test(`sweep selects the ${selection} helper and preserves inbox/cursor behavior`, async t => {
    const f = fixture(t);
    const script = helper(f, `assert sys.argv[1:] == ['snapshot']
with open(os.path.join(os.environ['DISPATCH_STATE_DIR'], 'active.json'), encoding='utf-8') as source:
    print(json.dumps(json.load(source)))`, selection === 'repository'
      ? join(f.root, 'bin', 'dispatch-registry.py') : undefined);
    setEnv(t, 'DISPATCH_REGISTRY_PY', selection === 'environment' ? script :
      selection === 'explicit' ? join(f.root, 'must not run.py') : undefined);
    const bytes = '# REPORT\nrd1167-worker completed\n';
    writeFileSync(join(f.shared, 'report.md'), bytes);
    const lines: string[] = [], errors: string[] = [];
    const rc = await sweep({ stateDir: f.state, sharedDir: f.shared, nowMs: Date.now(), repoDir: f.root,
      ...(selection === 'explicit' ? { registryScript: script } : {}),
      stdout: line => lines.push(line), stderr: line => errors.push(line) });
    assert.equal(rc, 0, errors.join('\n'));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^NEW rd1167-worker REPORT /);
    const inbox = join(f.state, 'inbox');
    assert.equal(readFileSync(join(inbox, readdirSync(inbox)[0]!), 'utf8'), bytes);
    const cursor = JSON.parse(readFileSync(join(f.state, 'report-cursor.json'), 'utf8'));
    assert.equal(typeof cursor.seen.report, 'number');
    assert.deepEqual(cursor.retries, []);
    unchanged(f);
  });
}

test('no selected refs never invokes the helper', async t => {
  const f = fixture(t);
  const marker = join(f.state, 'invoked');
  const script = helper(f, `with open(os.path.join(os.environ['DISPATCH_STATE_DIR'], 'invoked'), 'w') as marker:
    marker.write('unexpected invocation')
sys.exit(9)`);
  const errors: string[] = [];
  const rc = await sweep({ stateDir: f.state, sharedDir: f.shared, nowMs: Date.now(), repoDir: f.root,
    registryScript: script, stdout: () => assert.fail('empty sweep emitted a ref'), stderr: line => errors.push(line) });
  assert.equal(rc, 0, errors.join('\n'));
  assert.equal(existsSync(marker), false);
  unchanged(f);
});

test('tracker CLI passes its workspace shim helper to report-sweep', t => {
  const f = fixture(t);
  const bin = join(f.root, 'workspace shim', 'bin');
  helper(f, `assert sys.argv[1:] == ['snapshot']
print(${JSON.stringify(JSON.stringify(envelope(['shim1167-worker'])))})`, join(bin, 'dispatch-registry.py'));
  writeFileSync(join(f.shared, 'shim.md'), '# REPORT\nshim1167-worker completed\n');
  const env: NodeJS.ProcessEnv = { ...process.env, AIGENTRY_SHIM_SCRIPT_DIR: bin, DISPATCH_STATE_DIR: f.state,
    TELEPTY_SHARED_DIR: f.shared, TRACKER_NOW: new Date().toISOString() };
  delete env.DISPATCH_REGISTRY_PY;
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL('../../src/tracker/cli.js', import.meta.url)), 'report-sweep'],
    { env, encoding: 'utf8', shell: false, timeout: 20_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^NEW shim1167-worker REPORT /);
  unchanged(f);
});
