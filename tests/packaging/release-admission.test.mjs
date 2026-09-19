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
const securityPrefix = 'release/security/1.1.0/';
const policyPath = `${securityPrefix}policy.json`;
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
    writeFileSync(dest, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  let head;
  let pin;
  const commit = () => { git('add', '--all'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'synthetic fixture'); head = git('rev-parse', 'HEAD'); };
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
  write('package-lock.json', { name: '@fixture/release', version: '1.1.0', lockfileVersion: 3,
    packages: { '': { name: '@fixture/release', version: '1.1.0' } } });
  write('src/feature.txt', 'partial shipping scope\n');
  write('docs/research.txt', 'non-shipping planning scope\n');
  rmSync(path.join(root, 'src/deleted.txt'));
  renameSync(path.join(root, 'src/old-name.txt'), path.join(root, 'src/new-name.txt'));
  const evidence = [{ path: 'evidence/report.txt', sha256: digest(readFileSync(path.join(root, 'evidence/report.txt'))) }];
  const manifest = { schema_version: 1, release_group: 'fixture-group', release_task: 1171,
    package: '@fixture/release', version: '1.1.0', base_tag: 'v1.0.0', base_commit: base,
    tasks: [
      { task_id: 1171, disposition: 'shipping', scope: 'Partial implementation only',
        paths: ['package.json', 'package-lock.json', manifestPath, 'src/feature.txt', 'src/deleted.txt', 'src/old-name.txt', 'src/new-name.txt'], evidence },
      { task_id: 1172, disposition: 'non-shipping', scope: 'Research notes', paths: ['docs/research.txt'], evidence: structuredClone(evidence) },
    ] };
  // Independent synthetic review records. These never describe a production finding.
  const region = index => ({ startLine: index + 1, startColumn: 2, endLine: index + 1, endColumn: 7 });
  const sarif = { version: '2.1.0', runs: [{ tool: { driver: { name: 'SnykCode', rules: [{ id: 'fixture-rule' }] } },
    results: Array.from({ length: 18 }, (_, index) => ({ ruleId: 'fixture-rule', ruleIndex: 0,
      fingerprints: { '0': digest(`synthetic-finding-${index}`), '1': `synthetic-secondary-${index}`.padEnd(143, 'x') },
      level: index < 2 ? 'error' : index < 8 ? 'warning' : 'note',
      message: { text: 'Synthetic analyzer message' },
      locations: [{ physicalLocation: { artifactLocation: { uri: 'src/feature.txt', uriBaseId: '%SRCROOT%' }, region: region(index) } }] })) }] };
  const scope = { base_commit: base, roots: ['src/feature.txt'], leaves: ['package.json', 'package-lock.json'],
    assumptions: 'Synthetic fixture assumptions only', limits: 'Only the enumerated fixture projection' };
  const receipt = { schema_version: 1, sarif_sha256: '', original_receipt_sha256: digest('private synthetic original receipt'),
    stdout_sha256: digest('synthetic unscrubbed stdout'), manifest_sha256: digest('synthetic scan manifest'), exit: 1,
    findings: 18, severities: { high: 2, medium: 6, low: 10, unknown: 0 }, timed_out: false, overflow: false,
    signal: null, sarif_valid: true, representation: 'staged-scrubbed' };
  const policy = { schema_version: 1,
    release: { package: '@fixture/release', version: '1.1.0', group: 'fixture-group', task: 1171, planning_manifest_sha256: '' },
    candidate: { inventory_sha256: '', source_ids: ['source'], dependency_ids: ['package', 'lock'] },
    scan: { sarif_id: 'sarif', receipt_id: 'receipt', projected_ids: ['source'], scope_id: 'scope' }, files: [],
    findings: sarif.runs[0].results.map((result, index) => ({ fingerprint: result.fingerprints['0'], rule: result.ruleId,
      source_id: 'source', region: region(index), decision: 'eligible', source_ids: ['source'], evidence_ids: ['proof'], rationale_id: 'rationale' })) };
  const save = (mutate = () => {}) => {
    rmSync(path.join(root, securityPrefix), { recursive: true, force: true });
    policy.files = [['source', 'source', 'src/feature.txt'], ['package', 'dependency', 'package.json'], ['lock', 'dependency', 'package-lock.json']]
      .map(([id, kind, name]) => { const bytes = readFileSync(path.join(root, name)); return { id, kind, path: name, bytes: bytes.length, sha256: digest(bytes) }; });
    const blob = (id, value) => {
      const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      const sha256 = digest(bytes);
      write(`${securityPrefix}blobs/${sha256}`, bytes);
      policy.files.push({ id, kind: 'evidence', path: null, bytes: bytes.length, sha256 });
      return sha256;
    };
    receipt.sarif_sha256 = blob('sarif', sarif);
    blob('receipt', receipt); blob('scope', scope);
    if (policy.findings.length) {
      blob('proof', 'Synthetic sanitized evidence, deliberately unrelated to production.');
      blob('rationale', 'Synthetic reviewed rationale: the fixture contains no executable source.');
    }
    policy.candidate.inventory_sha256 = digest(JSON.stringify(policy.files.filter(file => file.kind !== 'evidence')
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => [file.path, file.bytes, file.sha256])));
    manifest.tasks[0].paths = manifest.tasks[0].paths.filter(name => !name.startsWith(securityPrefix));
    manifest.tasks[0].paths.push(policyPath, ...policy.files.filter(file => file.kind === 'evidence').map(file => `${securityPrefix}blobs/${file.sha256}`));
    write(manifestPath, manifest);
    policy.release.planning_manifest_sha256 = digest(readFileSync(path.join(root, manifestPath)));
    mutate(policy);
    write(policyPath, policy);
    pin = digest(readFileSync(path.join(root, policyPath)));
    commit();
  };
  save();
  const run = (args = ['--root', root, '--version', '1.1.0'], extraEnv = {}) => {
    assert.ok(existsSync(script), `candidate CLI absent: ${script}`);
    const before = readFileSync(path.join(root, 'state/task-queue.json'));
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root,
      env: { ...env, RELEASE_SECURITY_POLICY_SHA256: pin, RELEASE_SECURITY_COMMIT: head, ...extraEnv },
      encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.deepEqual(readFileSync(path.join(root, 'state/task-queue.json')), before, 'CLI must not mutate queue');
    assert.ok((result.stdout + result.stderr).length < 32768, 'bounded diagnostics');
    return result;
  };
  return { root, git, write, commit, queue, manifest, save, run, policy, sarif, receipt, scope };
}

function rejects(f, args, env) {
  const result = f.run(args, env);
  assert.notEqual(result.status, 0, `must refuse invalid input: ${result.stdout}`);
  assert.ok((result.stdout + result.stderr).trim(), 'refusal needs diagnostic');
  assert.doesNotMatch(result.stdout, /planning\/source coverage only/, 'original regression must fail during planning');
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
  assert.match(result.stdout, new RegExp(`paths=${f.manifest.tasks.flatMap(task => task.paths).length}\\b`));
  assert.match(result.stdout, /raw scanner: exit=1; findings=18/);
  assert.match(result.stdout, /policy: ACCEPT; eligible=18; blocked=0/);
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
  assert.match(steps[admission], /RELEASE_SECURITY_POLICY_SHA256: UNREVIEWED\s/);
  assert.match(steps[admission], /RELEASE_SECURITY_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(steps[admission], /sha256sum|shasum|hashFiles|SKIP|BYPASS/);
  assert.match(source, /^  publish:\n[\s\S]*?needs:\s*\[[^\]\n]*\bguard\b/m);
  assert.match(source, /needs: \[guard, test, windows-declared-unsupported, windows-persistence, windows-refuses\]/);
});

function securityRefuses(f, env = {}, diagnostic) {
  const result = f.run(undefined, env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /planning\/source coverage only/, 'security negative must first pass planning');
  assert.doesNotMatch(result.stdout, /policy: ACCEPT/);
  if (diagnostic) assert.match(result.stderr, diagnostic);
  return result;
}
// Change a content-addressed artifact while independently maintaining its reviewed
// identity and planning ownership. This lets malformed records reach their parser.
function replaceBlob(f, policy, id, bytes) {
  const file = policy.files.find(file => file.id === id);
  const previous = `${securityPrefix}blobs/${file.sha256}`;
  rmSync(path.join(f.root, previous));
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  file.sha256 = digest(data); file.bytes = data.length;
  const next = `${securityPrefix}blobs/${file.sha256}`;
  f.write(next, data);
  f.manifest.tasks[0].paths = f.manifest.tasks[0].paths.map(name => name === previous ? next : name);
  f.write(manifestPath, f.manifest);
  policy.release.planning_manifest_sha256 = digest(readFileSync(path.join(f.root, manifestPath)));
}

test('complete zero-result record accepts only raw exit zero', t => {
  const f = fixture(t);
  f.sarif.runs[0].results = []; f.policy.findings = [];
  f.receipt.exit = 0; f.receipt.findings = 0;
  f.receipt.severities = { high: 0, medium: 0, low: 0, unknown: 0 }; f.save();
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /raw scanner: exit=0; findings=0/);
  assert.match(result.stdout, /policy: ACCEPT; eligible=0; blocked=0/);
  f.receipt.exit = 1; f.save(); securityRefuses(f, {}, /receipt/);
});
test('absent and unrecognized SARIF levels use the producer-specific unknown count', t => {
  const f = fixture(t); delete f.sarif.runs[0].results[0].level;
  f.sarif.runs[0].results[1].level = 'none';
  f.receipt.severities.high = 0; f.receipt.severities.unknown = 2; f.save();
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /high=0; medium=6; low=10; unknown=2/);
});
test('independent 18-result fixture preserves raw exit 1 and rejects 15 eligible / 3 blocked', t => {
  const f = fixture(t); f.policy.findings.slice(15).forEach(finding => { finding.decision = 'blocked'; }); f.save();
  const result = securityRefuses(f, {}, /blocked findings/);
  assert.match(result.stdout, /raw scanner: exit=1; findings=18; high=2; medium=6; low=10/);
  assert.match(result.stdout, /policy: REJECT; eligible=15; blocked=3/);
});
for (const [label, env] of Object.entries({
  'absent pin': { RELEASE_SECURITY_POLICY_SHA256: '' },
  'unreviewed pin': { RELEASE_SECURITY_POLICY_SHA256: 'UNREVIEWED' },
  'wrong pin': { RELEASE_SECURITY_POLICY_SHA256: '0'.repeat(64) },
  'absent commit': { RELEASE_SECURITY_COMMIT: '' },
  'wrong commit': { RELEASE_SECURITY_COMMIT: '0'.repeat(40) },
  'environment bypass': { RELEASE_SECURITY_POLICY_SHA256: '', RELEASE_SECURITY_SKIP: '1', RELEASE_ADMISSION_BYPASS: '1' },
})) test(`security rejects ${label}`, t => securityRefuses(fixture(t), env));

const invalidPolicy = {
  'schema version': p => { p.schema_version = 2; },
  'approval boolean': p => { p.approved = true; },
  'approval quote': p => { p.approval = 'Someone said approve'; },
  'release package': p => { p.release.package = '@other/package'; },
  'release version': p => { p.release.version = '2.0.0'; },
  'release group': p => { p.release.group = 'other'; },
  'release task': p => { p.release.task = 1172; },
  'planning hash': p => { p.release.planning_manifest_sha256 = '0'.repeat(64); },
  'inventory hash': p => { p.candidate.inventory_sha256 = '0'.repeat(64); },
  'missing inventory source': p => { p.candidate.source_ids = []; },
  'duplicate source reference': p => { p.candidate.source_ids.push('source'); },
  'unknown source reference': p => { p.candidate.source_ids.push('unknown'); },
  'wrong kind reference': p => { p.candidate.source_ids.push('lock'); },
  'missing dependency': p => { p.candidate.dependency_ids.pop(); },
  'empty projection': p => { p.scan.projected_ids = []; },
  'duplicate projection': p => { p.scan.projected_ids.push('source'); },
  'invalid file id': p => { p.files[0].id = 'bad/id'; },
  'duplicate file id': p => { p.files.push(structuredClone(p.files[0])); },
  'duplicate path identity': p => { p.files.push({ ...p.files[0], id: 'alias' }); },
  'duplicate evidence identity': p => { p.files.push({ ...p.files.find(file => file.id === 'proof'), id: 'copy' }); },
  'file hash': p => { p.files[0].sha256 = '0'.repeat(64); },
  'file size': p => { p.files[0].bytes++; },
  'fractional size': p => { p.files[0].bytes = 1.5; },
  'negative size': p => { p.files[0].bytes = -1; },
  'unknown file key': p => { p.files[0].approved = true; },
  'missing finding': p => { p.findings.pop(); },
  'extra finding': p => { p.findings.push({ ...p.findings[0], fingerprint: '0'.repeat(64) }); },
  'duplicate fingerprint': p => { p.findings.push(structuredClone(p.findings[0])); },
  'fingerprint transfer': p => { [p.findings[0].fingerprint, p.findings[1].fingerprint] = [p.findings[1].fingerprint, p.findings[0].fingerprint]; },
  'unknown rule': p => { p.findings[0].rule = 'unknown'; },
  'unknown decision': p => { p.findings[0].decision = 'accepted-risk'; },
  'missing primary source': p => { p.findings[0].source_ids = []; },
  'empty finding evidence': p => { p.findings[0].evidence_ids = []; },
  'unknown rationale': p => { p.findings[0].rationale_id = 'unknown'; },
  'region missing column': p => { delete p.findings[0].region.endColumn; },
  'region reversed': p => { p.findings[0].region.endColumn = 1; },
  'region fractional': p => { p.findings[0].region.startLine = 1.5; },
  'unreferenced evidence': p => { p.findings.forEach(finding => { finding.evidence_ids = ['rationale']; }); },
  'evidence supplied path': p => { p.files.find(file => file.id === 'proof').path = 'evidence/report.txt'; },
  'security self inventory': p => { p.files[0].path = policyPath; },
  'planning self inventory': p => { p.files[0].path = manifestPath; },
};
for (const coordinate of ['startLine', 'startColumn', 'endLine', 'endColumn']) {
  test(`security rejects exact ${coordinate} join`, t => {
    const f = fixture(t);
    f.sarif.runs[0].results[5].locations[0].physicalLocation.region.endLine += 2;
    f.policy.findings[5].region.endLine += 2;
    f.save();
    const control = f.run();
    assert.equal(control.status, 0, control.stdout + control.stderr);
    f.save(p => { p.findings[5].region[coordinate]++; });
    const result = securityRefuses(f, {}, /Finding does not exactly join SARIF/);
    assert.match(result.stdout, /raw scanner: exit=1; findings=18/);
  });
}
for (const unsafe of ['/absolute', '../outside', './src/feature.txt', 'src//feature.txt', 'src\\feature.txt',
  'C:/source', '//server/share', 'https://example.invalid/source', 'src/\nprivate', '', 'SRC/feature.txt']) {
  invalidPolicy[`path ${JSON.stringify(unsafe)}`] = p => { p.files[0].path = unsafe; };
}
for (const [label, mutate] of Object.entries(invalidPolicy)) test(`security rejects ${label}`, t => {
  const f = fixture(t); f.save(mutate); securityRefuses(f);
});

const invalidReceipt = {
  'scanner failure': r => { r.exit = 2; },
  'false clean exit': r => { r.exit = 0; },
  'timeout': r => { r.timed_out = true; },
  'overflow': r => { r.overflow = true; },
  'signal': r => { r.signal = 'SIGTERM'; },
  'invalid SARIF': r => { r.sarif_valid = false; },
  'count total': r => { r.findings++; },
  'severity mapping': r => { r.severities.high++; r.severities.low--; },
  'negative severity': r => { r.severities.high = -1; },
  'fractional severity': r => { r.severities.high = 2.5; },
  'unknown severity': r => { r.severities.critical = 0; },
  'original provenance': r => { r.original_receipt_sha256 = 'invalid'; },
  'manifest provenance': r => { r.manifest_sha256 = 'invalid'; },
  'stdout provenance': r => { r.stdout_sha256 = 'invalid'; },
  'stdout staged confusion': r => { r.representation = 'stdout-exact'; },
  'unsupported representation': r => { r.representation = 'stdout'; },
  'approval receipt': r => { r.approved = true; },
};
for (const [label, mutate] of Object.entries(invalidReceipt)) test(`security receipt rejects ${label}`, t => {
  const f = fixture(t); mutate(f.receipt); f.save(); securityRefuses(f, {}, /receipt|provenance|counts|schema/);
});
test('stdout-exact requires equality while staged-scrubbed retains distinct stdout identity', t => {
  const f = fixture(t); f.receipt.representation = 'stdout-exact';
  f.receipt.stdout_sha256 = digest(JSON.stringify(f.sarif)); f.save();
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
});
const invalidSarif = {
  'version': s => { s.version = '2.0.0'; },
  'multiple runs': s => { s.runs.push(structuredClone(s.runs[0])); },
  'producer': s => { s.runs[0].tool.driver.name = 'Other'; },
  'failed invocation': s => { s.runs[0].invocations = [{ executionSuccessful: false }]; },
  'duplicate rules': s => { s.runs[0].tool.driver.rules.push({ id: 'fixture-rule' }); },
  'bad rule index': s => { s.runs[0].results[0].ruleIndex = 1; },
  'missing rule index': s => { delete s.runs[0].results[0].ruleIndex; },
  'mismatched rule': s => { s.runs[0].results[0].ruleId = 'other'; },
  'missing fingerprint': s => { delete s.runs[0].results[0].fingerprints; },
  'duplicate fingerprint': s => { s.runs[0].results[1].fingerprints = structuredClone(s.runs[0].results[0].fingerprints); },
  'missing result': s => { s.runs[0].results.pop(); },
  'extra result': s => { s.runs[0].results.push(structuredClone(s.runs[0].results[0])); },
  'multiple locations': s => { s.runs[0].results[0].locations.push(structuredClone(s.runs[0].results[0].locations[0])); },
  'missing region': s => { delete s.runs[0].results[0].locations[0].physicalLocation.region; },
  'missing column': s => { delete s.runs[0].results[0].locations[0].physicalLocation.region.startColumn; },
  'line-only location': s => { s.runs[0].results[0].locations[0].physicalLocation.region = { startLine: 1 }; },
  'URL location': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'file:///src/feature.txt'; },
  'suffix location': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'feature.txt'; },
  'encoded location': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'src/%66eature.txt'; },
  'URI base': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'ROOT'; },
  'external URI base': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = 'https://example.invalid/'; },
  'case-aliased URI base': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = '%srcroot%'; },
  'artifact extra key': s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.index = 0; },
  'empty original URI mappings': s => { s.runs[0].originalUriBaseIds = {}; },
  'external original URI mapping': s => { s.runs[0].originalUriBaseIds = { '%SRCROOT%': { uri: 'file:///external/' } }; },
  'null original URI mappings': s => { s.runs[0].originalUriBaseIds = null; },
  'extra fingerprint key': s => { s.runs[0].results[0].fingerprints['2'] = 'extra'; },
  'primary tampering with unchanged secondary': s => { s.runs[0].results[0].fingerprints['0'] = '0'.repeat(64); },
  'secondary fallback for missing primary': s => {
    const fingerprints = s.runs[0].results[0].fingerprints;
    fingerprints['1'] = fingerprints['0']; delete fingerprints['0'];
  },
  'secondary cannot transfer primary exceptions': s => {
    const [first, second] = s.runs[0].results;
    [first.fingerprints['0'], second.fingerprints['0']] = [second.fingerprints['0'], first.fingerprints['0']];
  },
};
for (const [label, value] of [['empty', ''], ['whitespace', ' '], ['null', null], ['number', 1],
  ['boolean', true], ['array', []], ['object', {}], ['oversized UTF-8', '한'.repeat(1400)]]) {
  invalidSarif[`secondary ${label}`] = s => { s.runs[0].results[0].fingerprints['1'] = value; };
}
for (const [label, value] of [['empty', ''], ['null', null], ['number', 1], ['boolean', true], ['array', []], ['object', {}]]) {
  invalidSarif[`URI base ${label}`] = s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uriBaseId = value; };
}
for (const [label, mutate] of Object.entries(invalidSarif)) test(`security SARIF rejects ${label}`, t => {
  const f = fixture(t); mutate(f.sarif); f.save(); securityRefuses(f);
});

for (const [secondary, base] of [[true, true], [true, false], [false, true], [false, false]]) {
  test(`synthetic producer accepts optional secondary=${secondary} SRCROOT=${base} without remapping`, t => {
    const f = fixture(t);
    for (const result of f.sarif.runs[0].results) {
      assert.equal(result.fingerprints['1'].length, 143);
      if (!secondary) delete result.fingerprints['1'];
      if (!base) delete result.locations[0].physicalLocation.artifactLocation.uriBaseId;
    }
    if (!secondary || !base) f.save();
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /raw scanner: exit=1; findings=18/);
    assert.match(result.stdout, /policy: ACCEPT; eligible=18; blocked=0/);
  });
}
test('secondary fingerprint equality never participates in the primary join', t => {
  const f = fixture(t);
  f.sarif.runs[0].results.forEach(result => { result.fingerprints['1'] = 'shared opaque producer metadata'; });
  f.save(); const result = f.run(); assert.equal(result.status, 0, result.stderr);
});
test('secondary metadata remains bound by the complete archived SARIF hash', t => {
  const f = fixture(t); const file = f.policy.files.find(file => file.id === 'sarif');
  f.sarif.runs[0].results[0].fingerprints['1'] = 'changed opaque metadata';
  f.write(`${securityPrefix}blobs/${file.sha256}`, f.sarif); f.commit();
  securityRefuses(f, {}, /hash or size mismatch/);
});

for (const name of ['src/feature.txt', 'package-lock.json']) test(`security detects committed byte drift: ${name}`, t => {
  const f = fixture(t); f.write(name, 'changed after scan\n'); f.commit();
  securityRefuses(f, {}, /hash or size mismatch/);
});
for (const id of ['proof', 'sarif']) test(`security detects committed artifact drift: ${id}`, t => {
  const f = fixture(t); const file = f.policy.files.find(file => file.id === id);
  f.write(`${securityPrefix}blobs/${file.sha256}`, 'changed artifact'); f.commit();
  securityRefuses(f, {}, /hash or size mismatch/);
});
test('receipt cannot name different SARIF bytes even with a reviewed policy', t => {
  const f = fixture(t); f.save(policy => {
    replaceBlob(f, policy, 'receipt', JSON.stringify({ ...f.receipt, sarif_sha256: '0'.repeat(64) }));
  }); securityRefuses(f, {}, /provenance/);
});
for (const [label, mutate] of Object.entries({
  'new selected source': f => { f.write('src/additional.txt', 'new source'); f.manifest.tasks[0].paths.push('src/additional.txt'); f.scope.roots.push('src/additional.txt'); },
  'deleted selected source': f => { f.scope.leaves.push('src/deleted.txt'); },
  'unrepresented selected source': f => { f.scope.leaves.push('src/new-name.txt'); },
  'missing selected leaf': f => { f.scope.leaves.push('src/missing.txt'); },
  'missing base': f => { f.scope.base_commit = '0'.repeat(40); },
  'nonancestor base': f => { f.scope.base_commit = f.git('commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated security base'); },
  'duplicate leaf': f => { f.scope.leaves.push('package.json'); },
  'scope escape': f => { f.scope.roots.push('../outside'); },
  'scope security records': f => { f.scope.roots.push('release/security'); },
  'empty assumptions': f => { f.scope.assumptions = ''; },
  'unknown scope field': f => { f.scope.approved = true; },
})) test(`security scope rejects ${label}`, t => {
  const f = fixture(t); mutate(f); f.save(); securityRefuses(f);
});
for (const [label, mutate] of Object.entries({
  'root identity': lock => { lock.packages[''].version = '0.0.0'; },
  'top identity': lock => { lock.name = '@wrong/package'; },
  'dependency mismatch': lock => { lock.packages[''].dependencies = { invented: '1.0.0' }; },
})) test(`security lock rejects ${label} with matching inventory hashes`, t => {
  const f = fixture(t); const lock = JSON.parse(readFileSync(path.join(f.root, 'package-lock.json'), 'utf8'));
  mutate(lock); f.write('package-lock.json', lock); f.save(); securityRefuses(f, {}, /Package lock/);
});

const trusted = f => ({ RELEASE_SECURITY_POLICY_SHA256: digest(readFileSync(path.join(f.root, policyPath))),
  RELEASE_SECURITY_COMMIT: f.git('rev-parse', 'HEAD') });
function bindPlanning(f) {
  f.write(manifestPath, f.manifest);
  f.policy.release.planning_manifest_sha256 = digest(readFileSync(path.join(f.root, manifestPath)));
  f.write(policyPath, f.policy);
}
test('missing security policy cannot fall back to planning-only success', t => {
  const f = fixture(t); rmSync(path.join(f.root, policyPath));
  f.manifest.tasks[0].paths = f.manifest.tasks[0].paths.filter(name => name !== policyPath);
  f.write(manifestPath, f.manifest); f.commit(); securityRefuses(f);
});
test('untracked security policy cannot borrow a valid trust pin', t => {
  const f = fixture(t); f.git('rm', '--cached', policyPath);
  f.manifest.tasks[0].paths = f.manifest.tasks[0].paths.filter(name => name !== policyPath);
  f.write(manifestPath, f.manifest); f.git('add', manifestPath);
  f.git('commit', '--no-gpg-sign', '-m', 'untrack policy');
  securityRefuses(f, trusted(f));
});
for (const state of ['missing', 'untracked', 'symlink', 'directory']) test(`security rejects ${state} artifact`, t => {
  const f = fixture(t); const file = f.policy.files.find(file => file.id === 'proof');
  const relative = `${securityPrefix}blobs/${file.sha256}`;
  const absolute = path.join(f.root, relative);
  if (state === 'untracked') f.git('rm', '--cached', relative);
  else rmSync(absolute);
  if (state === 'symlink') symlinkSync(path.join(f.root, 'evidence/report.txt'), absolute);
  if (state === 'directory') mkdirSync(absolute);
  if (state !== 'symlink') f.manifest.tasks[0].paths = f.manifest.tasks[0].paths.filter(name => name !== relative);
  bindPlanning(f);
  if (state === 'untracked') {
    f.git('add', manifestPath, policyPath); f.git('commit', '--no-gpg-sign', '-m', 'untracked artifact');
  } else f.commit();
  securityRefuses(f, trusted(f));
});
for (const relative of [policyPath, 'src/feature.txt']) test(`uncommitted security input refuses: ${relative}`, t => {
  const f = fixture(t); f.write(relative, 'uncommitted');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stderr, /must be clean/);
});
test('symlinked evidence directory refuses even with committed link', t => {
  const f = fixture(t); const blobs = `${securityPrefix}blobs`;
  renameSync(path.join(f.root, blobs), path.join(f.root, 'saved-blobs'));
  symlinkSync(path.join(f.root, 'saved-blobs'), path.join(f.root, blobs));
  f.manifest.tasks[0].paths = f.manifest.tasks[0].paths.filter(name => !name.startsWith(blobs + '/'));
  f.manifest.tasks[0].paths.push(blobs, ...f.policy.files.filter(file => file.kind === 'evidence').map(file => `saved-blobs/${file.sha256}`));
  bindPlanning(f); f.commit(); securityRefuses(f, trusted(f));
});

for (const [label, bytes] of [
  ['duplicate key', Buffer.from('{"schema_version":1,"schema_version":1}')],
  ['escaped duplicate key', Buffer.from('{"schema_version":1,"schema_\\u0076ersion":1}')],
  ['malformed JSON', Buffer.from('{')],
  ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
  ['oversized policy', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)],
  ['JSON depth', Buffer.from('['.repeat(34) + '0' + ']'.repeat(34))],
  ['array ceiling', Buffer.from(JSON.stringify(Array(100001).fill(0)))],
  ['string byte ceiling', Buffer.from(JSON.stringify({ data: '한'.repeat(1400) }))],
  ['invalid numeric range', Buffer.from('{"schema_version":1e999}')],
]) test(`security parser rejects ${label}`, t => {
  const f = fixture(t); f.write(policyPath, bytes); f.commit();
  securityRefuses(f, trusted(f));
});
for (const [label, bytes] of [
  ['duplicate receipt key', '{"schema_version":1,"schema_version":1}'],
  ['invalid receipt UTF-8', Buffer.from([0xff])],
  ['empty rationale', ''],
  ['oversized rationale', 'x'.repeat(4097)],
  ['oversized blob', Buffer.alloc(16 * 1024 * 1024 + 1, 0x78)],
]) test(`security artifact parser rejects ${label}`, t => {
  const f = fixture(t);
  f.save(policy => replaceBlob(f, policy, label.includes('rationale') ? 'rationale' : 'receipt', bytes));
  securityRefuses(f);
});
test('security rejects aggregate inputs larger than 64 MiB', t => {
  const f = fixture(t); f.save(policy => {
    for (let index = 0; index < 5; index++) {
      const bytes = Buffer.alloc(14 * 1024 * 1024, 65 + index);
      const sha256 = digest(bytes); const name = `${securityPrefix}blobs/${sha256}`;
      f.write(name, bytes); f.manifest.tasks[0].paths.push(name);
      policy.files.push({ id: `large${index}`, kind: 'evidence', path: null, bytes: bytes.length, sha256 });
      policy.findings[0].evidence_ids.push(`large${index}`);
    }
    f.write(manifestPath, f.manifest);
    policy.release.planning_manifest_sha256 = digest(readFileSync(path.join(f.root, manifestPath)));
  }); securityRefuses(f, {}, /total exceeds limit/);
});
test('normal npm test includes admission through the existing runner', () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /node scripts\/run-tests\.mjs/);
  const source = readFileSync(path.join(repo, 'scripts/run-tests.mjs'), 'utf8');
  assert.match(source, /const sourceTestFiles = \['tests\/hitl\/snyk-boundaries\.test\.mjs', 'tests\/packaging\/release-admission\.test\.mjs'\]/);
  assert.ok(source.indexOf("['--test', ...testFiles, ...sourceTestFiles]") < source.indexOf("['--test', 'tests/packaging/windows-release-gates.test.mjs']"));
});
