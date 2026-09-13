import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.resolve(process.env.AIGENTRY_RELEASE_ADMISSION_SCRIPT || path.join(repo, 'scripts/release-admission.mjs'));
const workflow = path.resolve(process.env.AIGENTRY_RELEASE_ADMISSION_WORKFLOW || path.join(repo, '.github/workflows/release.yml'));
const manifestPath = 'release/1.1.0.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Every Git mutation is confined to a newly created synthetic repository.
function fixture(t) {
  const fixtureParent = process.env.TMPDIR || path.join(repo, '.aigentry-report-rv1171', 'tmp');
  mkdirSync(fixtureParent, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(fixtureParent, 'release-admission-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: root, HOME: root, XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  }
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `fixture git ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (name, data) => {
    const dest = path.join(root, name);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, typeof data === 'string' ? data : JSON.stringify(data));
  };
  const commit = () => { git('add', '--all'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'synthetic fixture'); };
  const queue = { tasks: [{ id: 1171, status: 'in_progress' }, { id: 1172, status: 'pending' }] };
  git('init', '--quiet');
  write('package.json', { name: '@fixture/release', version: '1.0.0' });
  write('state/task-queue.json', queue);
  write('evidence/report.txt', 'Synthetic planning evidence; no completion claim.\n');
  write('src/deleted.txt', 'deleted later\n');
  write('src/old-name.txt', 'renamed later\n');
  commit();
  const base = git('rev-parse', 'HEAD');
  git('tag', 'v1.0.0');
  write('package.json', { name: '@fixture/release', version: '1.1.0' });
  write('src/feature.txt', 'partial shipping scope\n');
  write('docs/research.txt', 'non-shipping planning scope\n');
  rmSync(path.join(root, 'src/deleted.txt'));
  renameSync(path.join(root, 'src/old-name.txt'), path.join(root, 'src/new-name.txt'));
  const evidence = [{ path: 'evidence/report.txt', sha256: digest(readFileSync(path.join(root, 'evidence/report.txt'))) }];
  const manifest = { schema_version: 1, release_group: 'fixture-group', release_task: 1171,
    package: '@fixture/release', version: '1.1.0', base_tag: 'v1.0.0', base_commit: base,
    tasks: [
      { task_id: 1171, disposition: 'shipping', scope: 'Partial implementation only',
        paths: ['package.json', manifestPath, 'src/feature.txt', 'src/deleted.txt', 'src/old-name.txt', 'src/new-name.txt'], evidence },
      { task_id: 1172, disposition: 'non-shipping', scope: 'Research notes', paths: ['docs/research.txt'], evidence: structuredClone(evidence) },
    ] };
  const save = () => { write(manifestPath, manifest); commit(); };
  save();
  const run = (args = ['--root', root, '--version', '1.1.0'], extraEnv = {}) => {
    assert.ok(existsSync(script), `candidate CLI absent: ${script}`);
    const before = readFileSync(path.join(root, 'state/task-queue.json'));
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.deepEqual(readFileSync(path.join(root, 'state/task-queue.json')), before, 'CLI must not mutate queue');
    assert.ok((result.stdout + result.stderr).length < 32768, 'bounded diagnostics');
    return result;
  };
  return { root, git, write, commit, queue, manifest, save, run };
}

function rejects(f, args, env) {
  const result = f.run(args, env);
  assert.notEqual(result.status, 0, `must refuse invalid input: ${result.stdout}`);
  assert.ok((result.stdout + result.stderr).trim(), 'refusal needs diagnostic');
}

test('valid partial shipping and non-shipping scope, deletion and rename, unchanged evidence', t => {
  const f = fixture(t);
  f.write('untracked-report.txt', 'unrelated admin report');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.1\.0/);
  assert.match(result.stdout, /fixture-group/);
  assert.match(result.stdout, /planning\/source coverage only; not completion or installed verification/);
  assert.match(result.stdout, /\b2\b/);
  assert.match(result.stdout, /\b7\b/);
});

const invalidManifest = {
  'wrong version': m => { m.version = '1.2.0'; },
  'wrong package': m => { m.package = 'wrong'; },
  'empty group': m => { m.release_group = ' '; },
  'wrong schema': m => { m.schema_version = 2; },
  'unknown key': m => { m.verified = true; },
  'unknown task key': m => { m.tasks[0].done = true; },
  'unknown evidence key': m => { m.tasks[0].evidence[0].verified = true; },
  'unknown release task': m => { m.release_task = 9999; },
  'unknown task': m => { m.tasks[1].task_id = 9999; },
  'duplicate task': m => { m.tasks[1].task_id = 1171; },
  'noninteger task': m => { m.tasks[0].task_id = 1.5; },
  'duplicate ownership': m => { m.tasks[1].paths.push('src/feature.txt'); },
  'duplicate same-task path': m => { m.tasks[0].paths.push('src/feature.txt'); },
  'uncovered source': m => { m.tasks[0].paths = m.tasks[0].paths.filter(p => p !== 'src/feature.txt'); },
  'uncovered deletion': m => { m.tasks[0].paths = m.tasks[0].paths.filter(p => p !== 'src/deleted.txt'); },
  'uncovered rename old': m => { m.tasks[0].paths = m.tasks[0].paths.filter(p => p !== 'src/old-name.txt'); },
  'uncovered rename new': m => { m.tasks[0].paths = m.tasks[0].paths.filter(p => p !== 'src/new-name.txt'); },
  'unchanged claimed path': m => { m.tasks[0].paths.push('evidence/report.txt'); },
  'manifest wrong owner': m => { m.tasks[0].paths = m.tasks[0].paths.filter(p => p !== manifestPath); m.tasks[1].paths.push(manifestPath); },
  'empty scope': m => { m.tasks[0].scope = ''; },
  'empty paths': m => { m.tasks[0].paths = []; },
  'empty evidence': m => { m.tasks[0].evidence = []; },
  'invalid disposition': m => { m.tasks[0].disposition = 'verified'; },
  'wrong hash': m => { m.tasks[0].evidence[0].sha256 = '0'.repeat(64); },
  'uppercase hash': m => { m.tasks[0].evidence[0].sha256 = 'A'.repeat(64); },
  'self evidence': m => { m.tasks[0].evidence[0].path = manifestPath; },
  'missing evidence': m => { m.tasks[0].evidence[0].path = 'missing.txt'; },
  'unknown tag': m => { m.base_tag = 'v0.9.0'; },
  'unsafe tag': m => { m.base_tag = '--help'; },
  'target tag': m => { m.base_tag = 'v1.1.0'; },
  'wrong base commit': m => { m.base_commit = '0'.repeat(40); },
};
for (const [name, mutate] of Object.entries(invalidManifest)) {
  test(`reject ${name}`, t => { const f = fixture(t); mutate(f.manifest); f.save(); rejects(f); });
}
for (const unsafe of ['/absolute', '../outside', './src/feature.txt', 'src//feature.txt', 'src\\feature.txt', 'src/\nsecret', '.', '']) {
  for (const field of ['paths', 'evidence']) {
    test(`reject unsafe ${field} ${JSON.stringify(unsafe)}`, t => {
      const f = fixture(t);
      if (field === 'paths') f.manifest.tasks[0].paths.push(unsafe);
      else f.manifest.tasks[0].evidence[0].path = unsafe;
      f.save(); rejects(f);
    });
  }
}

test('missing manifest fails even with forged bypass environment', t => {
  const f = fixture(t);
  f.write('alternate.json', f.manifest);
  f.git('rm', manifestPath); f.commit();
  rejects(f, undefined, { RELEASE_ADMISSION_MANIFEST: path.join(f.root, 'alternate.json'),
    AIGENTRY_RELEASE_ADMISSION_MANIFEST: path.join(f.root, 'alternate.json'),
    AIGENTRY_RELEASE_ADMISSION_SKIP: '1', RELEASE_ADMISSION_BYPASS: '1' });
});
test('malformed manifest JSON', t => { const f = fixture(t); f.write(manifestPath, '{'); f.commit(); rejects(f); });
test('untracked manifest', t => {
  const f = fixture(t); f.git('rm', '--cached', manifestPath);
  f.git('commit', '--no-gpg-sign', '-m', 'untrack manifest');
  assert.equal(f.git('ls-files', '--', manifestPath), '', 'manifest must be untracked at CLI assertion');
  assert.ok(existsSync(path.join(f.root, manifestPath)), 'untracked manifest still exists');
  rejects(f);
});
test('untracked evidence with matching hash', t => {
  const f = fixture(t); f.write('untracked.txt', 'evidence');
  f.manifest.tasks[0].evidence = [{ path: 'untracked.txt', sha256: digest('evidence') }];
  f.write(manifestPath, f.manifest); f.git('add', manifestPath); f.git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'manifest');
  rejects(f);
});
test('committed changed evidence with stale hash', t => {
  const f = fixture(t); f.write('evidence/report.txt', 'altered'); f.manifest.tasks[0].paths.push('evidence/report.txt'); f.save(); rejects(f);
});
for (const staged of [false, true]) test(`dirty tracked ${staged ? 'index' : 'worktree'}`, t => {
  const f = fixture(t); f.write('src/feature.txt', 'dirty'); if (staged) f.git('add', 'src/feature.txt'); rejects(f);
});
for (const name of ['package.json', 'state/task-queue.json', manifestPath, 'evidence/report.txt']) {
  test(`reject symlink input ${name}`, t => {
    const f = fixture(t); const bytes = readFileSync(path.join(f.root, name));
    f.write('link-target.txt', bytes.toString()); rmSync(path.join(f.root, name));
    symlinkSync(path.join(f.root, 'link-target.txt'), path.join(f.root, name));
    f.manifest.tasks[0].paths.push('link-target.txt');
    if (!f.manifest.tasks[0].paths.includes(name)) f.manifest.tasks[0].paths.push(name);
    if (name !== manifestPath) f.write(manifestPath, f.manifest);
    f.commit(); rejects(f);
  });
}
test('reject symlink directory component', t => {
  const f = fixture(t); renameSync(path.join(f.root, 'evidence'), path.join(f.root, 'real-evidence'));
  symlinkSync('real-evidence', path.join(f.root, 'evidence'));
  f.manifest.tasks[0].paths.push('evidence/report.txt', 'evidence', 'real-evidence/report.txt'); f.save(); rejects(f);
});
test('legacy root-array queue is supported', t => {
  const f = fixture(t); f.write('state/task-queue.json', f.queue.tasks);
  f.manifest.tasks[0].paths.push('state/task-queue.json'); f.save();
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
});
for (const [name, queue] of Object.entries({
  duplicate: [{ id: 1171 }, { id: 1171 }, { id: 1172 }],
  invalid: [{ id: 1171 }, { id: 1172 }, { id: -1 }],
  unknown: [{ id: 1171 }],
  malformed: 'not JSON',
  ambiguous: { tasks: [], queue: [{ id: 1171 }, { id: 1172 }] },
})) test(`reject ${name} queue`, t => {
  const f = fixture(t); f.write('state/task-queue.json', queue);
  f.manifest.tasks[0].paths.push('state/task-queue.json'); f.save(); rejects(f);
});
test('wrong root subdirectory', t => { const f = fixture(t); rejects(f, ['--root', path.join(f.root, 'src'), '--version', '1.1.0']); });
test('non-Git root', t => { const f = fixture(t); rmSync(path.join(f.root, '.git'), { recursive: true }); rejects(f); });
for (const args of [ ['--unknown'], ['--version', '1.1.0', '--version', '1.1.0'], ['--root'],
  ['--version', '1.1.0-beta.1'], ['--version', '../1.1.0'], ['--version', '1.2.0'] ]) {
  test(`reject CLI ${args.join(' ')}`, t => { const f = fixture(t); rejects(f, ['--root', f.root, ...args]); });
}
test('base tag moved to HEAD fails', t => { const f = fixture(t); f.git('tag', '-f', 'v1.0.0'); rejects(f); });
test('nonancestor base fails with exact matching tag and commit', t => {
  const f = fixture(t);
  f.manifest.base_commit = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated root');
  f.git('tag', '-f', 'v1.0.0', f.manifest.base_commit); f.save(); rejects(f);
});

test('workflow runs independent tests and admission in guard before credentials and publish', () => {
  const source = readFileSync(workflow, 'utf8').split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  const guard = source.match(/^  guard:\n([\s\S]*?)(?=^  [a-zA-Z][\w-]*:)/m)?.[1];
  assert.ok(guard, 'guard job exists');
  const steps = guard.split(/^      - /m).slice(1);
  const identity = steps.findIndex(s => /id: identity\b/.test(s));
  const tests = steps.findIndex(s => /run:\s*(?:\|\s*)?node --test tests\/packaging\/release-admission\.test\.mjs\b/.test(s));
  const admission = steps.findIndex(s => /run:\s*(?:\|\s*)?node scripts\/release-admission\.mjs\b/.test(s));
  const secret = steps.findIndex(s => /secrets\.NPM_TOKEN/.test(s));
  assert.ok(identity >= 0 && tests > identity && admission > tests && secret > admission, 'identity -> tests -> gate -> secret');
  for (const index of [tests, admission]) {
    assert.doesNotMatch(steps[index], /continue-on-error:\s*true|\|\|\s*true|^\s*if:|\bexit\s+0\b/m, 'gate cannot skip or swallow failure');
  }
  assert.match(source, /^  publish:\n[\s\S]*?needs:\s*\[[^\]\n]*\bguard\b/m);
});
