// #1171 — release evidence tools against the REAL gate. A synthetic Git repository is built in a
// temp dir, a fake scanner stands in for Snyk, and scripts/release-evidence.mjs plus
// scripts/release-security-scan.mjs produce every record; scripts/release-admission.mjs judges them.
// Node built-ins and git only; every Git mutation is confined to the synthetic repository.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { sarifResults, strictJSON } from '../../scripts/release-evidence.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gate = path.join(repo, 'scripts/release-admission.mjs');
const evidenceTool = path.join(repo, 'scripts/release-evidence.mjs');
const scanTool = path.join(repo, 'scripts/release-security-scan.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const VERSION = '1.1.0';
const prefix = `release/security/${VERSION}/`;
const manifestPath = `release/${VERSION}.json`;

// Fake scanner: `emit <sarif> <exit> <listing>` records what it was shown and prints the SARIF bytes;
// the other modes model a hang, a stdout flood and a signal death.
const FAKE_SCANNER = `import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [mode, a, b, c] = process.argv.slice(2);
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
  ? walk(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
if (mode === 'emit') {
  const files = Object.fromEntries(walk('.').sort().map(name => [name, createHash('sha256').update(readFileSync(name)).digest('hex')]));
  writeFileSync(c, JSON.stringify({ cwd: process.cwd(), files, argv: process.argv.slice(2) }));
  process.stdout.write(readFileSync(a));
  process.exitCode = Number(b);
} else if (mode === 'sleep') setTimeout(() => {}, 60000);
else if (mode === 'flood') process.stdout.write(Buffer.alloc(64 * 1024, 0x41));
else if (mode === 'kill') process.kill(process.pid, 'SIGKILL');
`;

// A Snyk Code-shaped SARIF: the fields real output carries (schema, rule help/properties,
// message markdown, codeFlows, priority properties, coverage) around the gate-relevant core.
function snykSarif(results = []) {
  return { $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'SnykCode', semanticVersion: '1.0.0', version: '1.0.0',
      rules: results.length ? [{ id: 'javascript/HardcodedSecret', name: 'HardcodedSecret',
        shortDescription: { text: 'Hardcoded Secret' }, defaultConfiguration: { level: 'warning' },
        help: { markdown: '## Details\nSynthetic help text.', text: '' },
        properties: { tags: ['javascript'], categories: ['Security'], exampleCommitFixes: [], exampleCommitDescriptions: [],
          precision: 'very-high', repoDatasetSize: 12, cwe: ['CWE-547'] } }] : [] } },
    results, properties: { coverage: [{ files: 1, isSupported: true, lang: 'JavaScript', type: 'SUPPORTED' }] } }] };
}
const finding = (uri = 'src/feature.js') => ({ ruleId: 'javascript/HardcodedSecret', ruleIndex: 0, level: 'warning',
  message: { text: 'Synthetic hardcoded value.', markdown: 'Synthetic {0}.', arguments: ['[value](0)'] },
  locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
    region: { startLine: 1, endLine: 1, startColumn: 14, endColumn: 21 } } }],
  fingerprints: { 0: digest('synthetic finding'), 1: 'a1b2c3d4.e5f6a7b8.00000000' },
  codeFlows: [{ threadFlows: [{ locations: [{ location: { id: 0, physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
    region: { startLine: 1, endLine: 1, startColumn: 14, endColumn: 21 } } } }] }] }],
  properties: { priorityScore: 550, priorityScoreFactors: [{ label: true, type: 'hotFileSource' }], isAutofixable: false } });

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'release-evidence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  const inputs = path.join(root, 'inputs');
  mkdirSync(dir);
  mkdirSync(inputs);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args],
      { env, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `fixture git ${args[0]}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (name, data) => {
    const dest = path.join(dir, ...name.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n');
  };
  const input = (name, data) => {
    const dest = path.join(inputs, name);
    writeFileSync(dest, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n');
    return dest;
  };
  const commit = message => { git('add', '--all'); git('commit', '--no-gpg-sign', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  let outs = 0;
  const out = name => path.join(root, `out-${++outs}-${name}`);
  const node = (args, extraEnv = {}) => {
    const result = spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    return result;
  };
  const fake = path.join(root, 'fake-scanner.mjs');
  writeFileSync(fake, FAKE_SCANNER);

  git('init', '-q');
  write('package.json', { name: '@fixture/release', version: '1.0.0' });
  write('release/tasks.json', { schema_version: 1, release_group: 'fixture-group',
    tasks: [{ id: 1171, release_component: 'fixture-release' }, { id: 1172, release_component: 'fixture-feature' }] });
  write('src/keep.js', 'export const keep = 1;\n');
  write('src/feature.js', 'export const feature = 0;\n');
  const base = commit('chore: base');
  git('tag', 'v1.0.0');
  write('src/feature.js', 'export const feature = "synthetic";\n');
  write('docs/feature.md', 'Feature notes.\n');
  commit('feat(1172): feature work (#1172)');
  write('package.json', { name: '@fixture/release', version: VERSION });
  write('package-lock.json', { name: '@fixture/release', version: VERSION, lockfileVersion: 3,
    packages: { '': { name: '@fixture/release', version: VERSION } } });
  write(`release/${VERSION}-dispositions.md`, 'Synthetic dispositions: 1171 release records; 1172 feature.\n');
  commit(`chore(1171): release ${VERSION}`);

  const scopeFile = input('scope.json', { base_commit: base, roots: ['src'], leaves: ['package.json', 'package-lock.json'],
    assumptions: 'Synthetic scope: the changed source under src only.', limits: 'Fixture only; no production claim.' });
  const dispositionsFile = input('dispositions.json', {
    1171: { disposition: 'shipping', scope: 'Release records', evidence: [`release/${VERSION}-dispositions.md`] },
    1172: { disposition: 'shipping', scope: 'Feature work', evidence: [`release/${VERSION}-dispositions.md`] } });
  const rangeArgs = ['--repo', dir, '--version', VERSION, '--base-tag', 'v1.0.0', '--release-task', '1171'];

  function scan(sarif, exit, options = []) {
    const sarifFile = input(`emit-${outs}.sarif`, Buffer.isBuffer(sarif) ? sarif : JSON.stringify(sarif));
    const listing = path.join(inputs, `listing-${outs}.json`);
    const target = out('scan');
    const result = node([scanTool, '--repo', dir, '--scope-file', scopeFile, '--out', target,
      '--scanner-argv', JSON.stringify([process.execPath, fake, 'emit', sarifFile, String(exit), listing]), ...options]);
    return { result, out: target, listing, file: name => path.join(target, name) };
  }
  function scanMode(mode, options = []) {
    const target = out('scan');
    const result = node([scanTool, '--repo', dir, '--scope-file', scopeFile, '--out', target,
      '--scanner-argv', JSON.stringify([process.execPath, fake, mode]), ...options]);
    return { result, out: target, file: name => path.join(target, name) };
  }
  function blobs(scanned, adjudicationsFile) {
    const target = out('blobs');
    const result = node([evidenceTool, 'blobs', '--version', VERSION, '--scope-file', scopeFile,
      '--sarif-file', scanned.file('sarif.json'), '--receipt-file', scanned.file('receipt.json'),
      '--adjudications-file', adjudicationsFile, '--out', target]);
    return { result, out: target };
  }
  function commitBlobs(made) {
    for (const name of readdirSync(path.join(made.out, 'blobs'))) write(`${prefix}blobs/${name}`, readFileSync(path.join(made.out, 'blobs', name)));
    return commit('chore(1171): security evidence blobs');
  }
  function manifest(extra = []) {
    const target = out('manifest');
    const result = node([evidenceTool, 'manifest', ...rangeArgs, '--dispositions-file', dispositionsFile, ...extra, '--out', target]);
    return { result, out: target };
  }
  function policy(scanned, adjudicationsFile) {
    const target = out('policy');
    const result = node([evidenceTool, 'policy', '--repo', dir, '--version', VERSION, '--scope-file', scopeFile,
      '--sarif-file', scanned.file('sarif.json'), '--receipt-file', scanned.file('receipt.json'),
      '--scan-manifest-file', scanned.file('scan-manifest.json'), '--adjudications-file', adjudicationsFile, '--out', target]);
    return { result, out: target };
  }
  const admit = (env = {}) => node([gate, '--root', dir, '--version', VERSION], env);
  const trusted = () => ({ RELEASE_SECURITY_POLICY_SHA256: digest(readFileSync(path.join(dir, ...`${prefix}policy.json`.split('/')))),
    RELEASE_SECURITY_COMMIT: git('rev-parse', 'HEAD') });
  const ok = (result, label) => assert.equal(result.status, 0, `${label}: ${result.stdout}\n${result.stderr}`);

  // The ordered steps: scan -> blobs (commit) -> manifest (commit) -> policy (commit) -> gate.
  function release({ sarif = snykSarif(), exit = 0, adjudications = { findings: {} } } = {}) {
    const adjudicationsFile = input(`adjudications-${outs}.json`, adjudications);
    const scanned = scan(sarif, exit);
    ok(scanned.result, 'scan');
    const made = blobs(scanned, adjudicationsFile);
    ok(made.result, 'blobs');
    commitBlobs(made);
    const planned = manifest();
    ok(planned.result, 'manifest');
    write(manifestPath, readFileSync(path.join(planned.out, `${VERSION}.json`)));
    commit('chore(1171): planning manifest');
    const secured = policy(scanned, adjudicationsFile);
    ok(secured.result, 'policy');
    const policyBytes = readFileSync(path.join(secured.out, 'policy.json'));
    write(`${prefix}policy.json`, policyBytes);
    const head = commit('chore(1171): security policy');
    const pin = /RELEASE_SECURITY_POLICY_SHA256, for maintainer review\): ([0-9a-f]{64})$/m.exec(secured.result.stdout)?.[1];
    assert.equal(pin, digest(policyBytes), 'printed candidate pin is the hash of the exact policy bytes');
    return { scanned, pin, head, adjudicationsFile };
  }
  return { root, dir, base, git, write, input, commit, node, scan, scanMode, blobs, commitBlobs, manifest, policy, release,
    admit, trusted, ok, rangeArgs, out };
}

function admitted(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /planning\/source coverage only/);
  assert.match(result.stdout, /policy: ACCEPT; eligible=\d+; blocked=0/);
}
function refused(result, diagnostic, { planning = true } = {}) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /policy: ACCEPT/);
  if (planning) assert.match(result.stdout, /planning\/source coverage only/, 'refusal must come from the security half');
  assert.match(result.stderr, diagnostic);
}

function oneFindingAdjudication(f) {
  f.input('trace.txt', 'Synthetic trace: the literal is a fixture marker, not a credential.\n');
  f.input('rationale.txt', 'Eligible: the flagged literal is a public fixture constant with no secret value.\n');
  return { findings: { [digest('synthetic finding')]: { decision: 'eligible', source_paths: ['src/feature.js'],
    evidence_files: ['trace.txt'], rationale_file: 'rationale.txt' } } };
}

test('(a) zero findings: produced evidence passes the real gate', t => {
  const f = fixture(t);
  const { scanned, pin, head } = f.release();
  const result = f.admit({ RELEASE_SECURITY_POLICY_SHA256: pin, RELEASE_SECURITY_COMMIT: head });
  admitted(result);
  assert.match(result.stdout, /raw scanner: exit=0; findings=0; high=0; medium=0; low=0; unknown=0/);
  assert.match(result.stdout, /policy: ACCEPT; eligible=0; blocked=0/);
  const receipt = JSON.parse(readFileSync(scanned.file('receipt.json'), 'utf8'));
  assert.equal(receipt.representation, 'stdout-exact');
  assert.equal(receipt.sarif_sha256, digest(readFileSync(scanned.file('sarif.json'))));
  assert.equal(receipt.manifest_sha256, digest(readFileSync(scanned.file('scan-manifest.json'))));
  assert.equal(receipt.original_receipt_sha256, digest(readFileSync(scanned.file('original-receipt.json'))));
});

test('(b) one finding adjudicated eligible: produced evidence passes the real gate', t => {
  const f = fixture(t);
  const adjudications = oneFindingAdjudication(f);
  const { pin, head } = f.release({ sarif: snykSarif([finding()]), exit: 1, adjudications });
  const result = f.admit({ RELEASE_SECURITY_POLICY_SHA256: pin, RELEASE_SECURITY_COMMIT: head });
  admitted(result);
  assert.match(result.stdout, /raw scanner: exit=1; findings=1; high=0; medium=1; low=0; unknown=0/);
  assert.match(result.stdout, /policy: ACCEPT; eligible=1; blocked=0/);
});

test('scanner sees exactly the scoped committed bytes, once, in a removed temporary directory', t => {
  const f = fixture(t);
  f.write('src/feature.js', 'uncommitted worktree bytes must not be staged\n');
  const scanned = f.scan(snykSarif(), 0);
  f.ok(scanned.result, 'scan');
  const seen = JSON.parse(readFileSync(scanned.listing, 'utf8'));
  const show = name => Buffer.from(f.git('show', `HEAD:${name}`) + '\n');
  assert.deepEqual(Object.keys(seen.files), ['package-lock.json', 'package.json', 'src/feature.js']);
  for (const name of Object.keys(seen.files)) assert.equal(seen.files[name], digest(show(name)), name);
  assert.ok(!existsSync(seen.cwd), 'staging directory removed after the run');
  assert.ok(!seen.cwd.startsWith(f.dir), 'never scans the working tree');
  const manifest = JSON.parse(readFileSync(scanned.file('scan-manifest.json'), 'utf8'));
  assert.equal(manifest.commit, f.git('rev-parse', 'HEAD'));
  assert.deepEqual(manifest.files.map(entry => entry[0]), Object.keys(seen.files));
  assert.deepEqual(readdirSync(scanned.out).sort(), ['original-receipt.json', 'receipt.json', 'sarif.json', 'scan-manifest.json']);
});

test('owner missing: tools refuse and name the input, the gate refuses an uncovered path', t => {
  const f = fixture(t);
  f.write('src/feature.js', 'export const feature = "untagged change";\n');
  const untagged = f.commit('fix: untagged tweak');
  const analysed = f.node([path.join(repo, 'scripts/release-evidence.mjs'), 'ownership', ...f.rangeArgs, '--out', f.out('ownership')]);
  assert.equal(analysed.status, 1, analysed.stderr);
  assert.match(analysed.stdout, /needs: owner for src\/feature\.js \(untagged-commit; tasks=1172\)/);
  assert.match(analysed.stdout, new RegExp(`needs: commit task attribution \\(--commit-tasks-file\\) for ${untagged}`));
  const planned = f.manifest();
  assert.equal(planned.result.status, 1);
  assert.match(planned.result.stderr, /1 changed path\(s\) have no owner/);
  assert.deepEqual(readdirSync(planned.out), ['ownership.json'], 'no manifest is written with an unknown owner');
  const attribution = f.input('commit-tasks.json', { [untagged]: { tasks: [1172], reason: 'Reviewed diff: feature follow-up.' } });
  const settled = f.node([path.join(repo, 'scripts/release-evidence.mjs'), 'ownership', ...f.rangeArgs,
    '--commit-tasks-file', attribution, '--out', f.out('ownership')]);
  assert.equal(settled.status, 0, settled.stdout + settled.stderr);

  const g = fixture(t);
  g.release();
  const committed = JSON.parse(readFileSync(path.join(g.dir, ...manifestPath.split('/')), 'utf8'));
  committed.tasks.find(task => task.task_id === 1172).paths = ['src/feature.js'];
  g.write(manifestPath, committed);
  g.commit('chore(1171): drop docs/feature.md owner');
  refused(g.admit(g.trusted()), /Changed paths are uncovered/, { planning: false });
});

test('altered blob: the gate and the policy step refuse', t => {
  const f = fixture(t);
  f.release();
  const blobDir = path.join(f.dir, ...`${prefix}blobs`.split('/'));
  const sarifName = readdirSync(blobDir).find(name => readFileSync(path.join(blobDir, name), 'utf8').includes('SnykCode'));
  f.write(`${prefix}blobs/${sarifName}`, '{"version":"2.1.0","runs":[]}');
  f.commit('chore(1171): alter a blob');
  refused(f.admit(f.trusted()), /Security file hash or size mismatch/);

  const g = fixture(t);
  const adjudicationsFile = g.input('adjudications.json', { findings: {} });
  const scanned = g.scan(snykSarif(), 0);
  g.ok(scanned.result, 'scan');
  const made = g.blobs(scanned, adjudicationsFile);
  g.ok(made.result, 'blobs');
  g.commitBlobs(made);
  const name = readdirSync(path.join(made.out, 'blobs'))[0];
  g.write(`${prefix}blobs/${name}`, 'altered after the blobs step\n');
  g.commit('chore(1171): alter a blob');
  const planned = g.manifest();
  g.ok(planned.result, 'manifest');
  g.write(manifestPath, readFileSync(path.join(planned.out, `${VERSION}.json`)));
  g.commit('chore(1171): planning manifest');
  const secured = g.policy(scanned, adjudicationsFile);
  assert.equal(secured.result.status, 1);
  assert.match(secured.result.stderr, /committed blob differs from input/);
});

test('scan commit differs: the gate refuses a foreign commit and drifted sources; policy refuses a stale scan', t => {
  const f = fixture(t);
  const { pin, head } = f.release();
  refused(f.admit({ RELEASE_SECURITY_POLICY_SHA256: pin, RELEASE_SECURITY_COMMIT: f.git('rev-parse', 'HEAD~1') }), /Security commit mismatch/);
  f.write('src/feature.js', 'export const feature = "changed after the scan";\n');
  f.commit('feat(1172): change after the scan (#1172)');
  assert.notEqual(f.git('rev-parse', 'HEAD'), head);
  refused(f.admit(f.trusted()), /Security file hash or size mismatch/);

  // The gate alone cannot tell that the SARIF came from older bytes when the policy is rebuilt
  // at the new HEAD; the policy step refuses because the scan manifest no longer matches.
  const g = fixture(t);
  const adjudicationsFile = g.input('adjudications.json', { findings: {} });
  const scanned = g.scan(snykSarif(), 0);
  g.ok(scanned.result, 'scan');
  g.write('src/feature.js', 'export const feature = "changed after the scan";\n');
  g.commit('feat(1172): change after the scan (#1172)');
  const made = g.blobs(scanned, adjudicationsFile);
  g.ok(made.result, 'blobs');
  g.commitBlobs(made);
  const planned = g.manifest();
  g.ok(planned.result, 'manifest');
  g.write(manifestPath, readFileSync(path.join(planned.out, `${VERSION}.json`)));
  g.commit('chore(1171): planning manifest');
  const secured = g.policy(scanned, adjudicationsFile);
  assert.equal(secured.result.status, 1);
  assert.match(secured.result.stderr, /scoped bytes at HEAD differ from the bytes scanned at [0-9a-f]{40}; rescan/);
});

test('scanner failures are recorded once, not retried or hidden, and blobs refuses them', t => {
  const f = fixture(t);
  const adjudicationsFile = f.input('adjudications.json', { findings: {} });
  const cases = [
    ['exit 2', () => f.scan(Buffer.from('Snyk CLI error\n'), 2), { exit: 2, sarif_valid: false, signal: null, timed_out: false, overflow: false }],
    ['exit 3', () => f.scan(snykSarif(), 3), { exit: 3, sarif_valid: true, findings: 0 }],
    ['exit 1 without findings', () => f.scan(snykSarif(), 1), { exit: 1, findings: 0 }],
    ['exit 0 with findings', () => f.scan(snykSarif([finding()]), 0), { exit: 0, findings: 1 }],
    ['timeout', () => f.scanMode('sleep', ['--timeout-ms', '1500']), { timed_out: true, exit: null, sarif_valid: false }],
    ['stdout overflow', () => f.scanMode('flood', ['--max-stdout-bytes', '1024']), { overflow: true, sarif_valid: false }],
  ];
  if (process.platform !== 'win32') cases.push(['signal', () => f.scanMode('kill'), { signal: 'SIGKILL', exit: null, sarif_valid: false }]);
  for (const [label, run, expected] of cases) {
    const scanned = run();
    assert.equal(scanned.result.status, 1, `${label}: ${scanned.result.stdout}${scanned.result.stderr}`);
    assert.match(scanned.result.stderr, /recorded but NOT admissible/, label);
    const receipt = JSON.parse(readFileSync(scanned.file('receipt.json'), 'utf8'));
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(receipt[key], value, `${label}: ${key}`);
    assert.equal(receipt.stdout_sha256, digest(readFileSync(scanned.file('sarif.json'))), `${label}: stdout kept exactly`);
    const made = f.blobs(scanned, adjudicationsFile);
    assert.equal(made.result.status, 1, label);
    assert.match(made.result.stderr, /invalid scanner receipt|Malformed|SARIF/, label);
  }
});

test('scope refusals: deleted path under a root, planning records, missing package leaves', t => {
  const f = fixture(t);
  f.git('rm', '-q', 'src/keep.js');
  f.commit('chore(1171): delete keep.js');
  const deleted = f.scan(snykSarif(), 0);
  assert.equal(deleted.result.status, 1);
  assert.match(deleted.result.stderr, /selected path is absent at [0-9a-f]{40} \(deleted under a scope root\?\): src\/keep\.js/);
  const scope = JSON.parse(readFileSync(path.join(f.root, 'inputs', 'scope.json'), 'utf8'));
  for (const [label, mutate, diagnostic] of [
    ['projection leaf', s => { s.leaves.push('release/tasks.json'); }, /scope names a planning or security record: release\/tasks\.json/],
    ['missing lock leaf', s => { s.leaves = ['package.json']; }, /scope must select package-lock\.json/],
  ]) {
    const variant = structuredClone(scope);
    mutate(variant);
    const file = f.input(`scope-${label.replace(/\W+/g, '-')}.json`, variant);
    const result = f.node([scanTool, '--repo', f.dir, '--scope-file', file, '--out', f.out('scan'),
      '--scanner-argv', JSON.stringify([process.execPath, '-e', '0'])]);
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, diagnostic, label);
  }
});

test('policy refuses missing adjudication and blocked decisions instead of recording them', t => {
  const f = fixture(t);
  const adjudications = oneFindingAdjudication(f);
  const scanned = f.scan(snykSarif([finding()]), 1);
  f.ok(scanned.result, 'scan');
  assert.match(scanned.result.stdout, new RegExp(`needs: adjudication for ${digest('synthetic finding')}`));
  const missing = f.blobs(scanned, f.input('none.json', { findings: {} }));
  assert.equal(missing.result.status, 1);
  assert.match(missing.result.stderr, /needs: adjudication for [0-9a-f]{64}/);
  assert.match(missing.result.stderr, /1 SARIF finding\(s\) have no human adjudication/);
  const blocked = structuredClone(adjudications);
  blocked.findings[digest('synthetic finding')].decision = 'blocked';
  const rejected = f.blobs(scanned, f.input('blocked.json', blocked));
  assert.equal(rejected.result.status, 1);
  assert.match(rejected.result.stderr, /adjudicated blocked; the gate would REJECT/);
});

// REQUIREMENTS C4: Snyk output shapes the gate refuses. Each shape is forced through the real gate
// with otherwise consistent evidence (receipt, blobs, manifest, policy and pin all rebound), and
// the tools' own SARIF check must refuse the same shape before anything is committed.
test('C4 SARIF compatibility: shapes the real gate refuses, and the tools agree', t => {
  const f = fixture(t);
  const adjudications = oneFindingAdjudication(f);
  f.release({ sarif: snykSarif([finding()]), exit: 1, adjudications });
  const read = name => readFileSync(path.join(f.dir, ...name.split('/')));
  function force(sarifBytes) {
    const policy = JSON.parse(read(`${prefix}policy.json`));
    const manifest = JSON.parse(read(manifestPath));
    const sarifFile = policy.files.find(file => file.id === 'sarif');
    const receiptFile = policy.files.find(file => file.id === 'receipt');
    const receipt = JSON.parse(read(`${prefix}blobs/${receiptFile.sha256}`));
    receipt.sarif_sha256 = receipt.stdout_sha256 = digest(sarifBytes);
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    const owned = manifest.tasks.find(task => task.task_id === manifest.release_task);
    for (const [file, bytes] of [[sarifFile, sarifBytes], [receiptFile, receiptBytes]]) {
      rmSync(path.join(f.dir, ...`${prefix}blobs/${file.sha256}`.split('/')));
      owned.paths = owned.paths.filter(name => name !== `${prefix}blobs/${file.sha256}`);
      file.sha256 = digest(bytes);
      file.bytes = bytes.length;
      f.write(`${prefix}blobs/${file.sha256}`, bytes);
      owned.paths.push(`${prefix}blobs/${file.sha256}`);
    }
    owned.paths.sort();
    f.write(manifestPath, manifest);
    policy.release.planning_manifest_sha256 = digest(read(manifestPath));
    f.write(`${prefix}policy.json`, policy);
    f.commit('chore(1171): rebind evidence to a SARIF variant');
    return f.admit(f.trusted());
  }
  const projected = new Set(['src/feature.js']);
  const shape = mutate => { const sarif = snykSarif([finding()]); mutate(sarif); return Buffer.from(JSON.stringify(sarif)); };
  const toolRefuses = bytes => assert.throws(() => sarifResults(strictJSON(bytes), projected));

  // Control: help markdown at exactly 4096 bytes and extra run metadata are accepted.
  admitted(force(shape(s => { s.runs[0].tool.driver.rules[0].help.markdown = 'x'.repeat(4096); s.runs[0].automationDetails = { id: 'x' }; })));
  for (const [label, mutate, diagnostic] of [
    ['rule help markdown over 4096 bytes', s => { s.runs[0].tool.driver.rules[0].help.markdown = 'x'.repeat(4097); }, /Malformed or oversized security JSON/],
    ['message text over 4096 bytes', s => { s.runs[0].results[0].message.text = '한'.repeat(1366); }, /Malformed or oversized security JSON/],
    ['extra fingerprint key', s => { s.runs[0].results[0].fingerprints.identity = 'a-uuid'; }, /Invalid schema keys/],
    ['non-hex primary fingerprint', s => { s.runs[0].results[0].fingerprints['0'] = 'abc123'; }, /Invalid or duplicate SARIF result/],
    ['originalUriBaseIds', s => { s.runs[0].originalUriBaseIds = { '%SRCROOT%': { uri: 'file:///tmp/scan/' } }; }, /Unsupported SARIF URI base mapping/],
    ['absolute file URI', s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation = { uri: 'file:///tmp/scan/src/feature.js' }; }, /Unsafe relative path/],
    ['line-only region', s => { s.runs[0].results[0].locations[0].physicalLocation.region = { startLine: 1 }; }, /Invalid schema keys/],
    ['logical locations beside physical', s => { s.runs[0].results[0].locations[0].logicalLocations = [{ name: 'feature' }]; }, /Invalid schema keys/],
    ['tool extensions', s => { s.runs[0].tool.extensions = [{ name: 'plugin' }]; }, /Unsupported SARIF producer or failed invocation/],
    ['failed invocation', s => { s.runs[0].invocations = [{ executionSuccessful: false }]; }, /Unsupported SARIF producer or failed invocation/],
    ['result outside the staged projection', s => { s.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri = 'src/keep.js'; }, /SARIF source outside projection/],
    ['two runs', s => { s.runs.push(structuredClone(s.runs[0])); }, /Unsupported SARIF shape/],
  ]) {
    const bytes = shape(mutate);
    toolRefuses(bytes);
    const result = force(bytes);
    assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /planning\/source coverage only/, label);
    assert.match(result.stderr, diagnostic, label);
  }
});

test('CLI refusals: usage, relative repo, non-empty --out, Windows shell shims', t => {
  const f = fixture(t);
  const usage = f.node([evidenceTool]);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: scripts\/release-evidence\.mjs/);
  const relative = f.node([evidenceTool, 'ownership', '--repo', 'relative', '--version', VERSION, '--base-tag', 'v1.0.0',
    '--release-task', '1171', '--out', f.out('x')]);
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /--repo must be absolute/);
  const busy = f.out('busy');
  mkdirSync(busy);
  writeFileSync(path.join(busy, 'keep'), 'x');
  const occupied = f.node([evidenceTool, 'ownership', ...f.rangeArgs, '--out', busy]);
  assert.equal(occupied.status, 1);
  assert.match(occupied.stderr, /--out must be absent or empty/);
  const badArgv = f.node([scanTool, '--repo', f.dir, '--scope-file', path.join(f.root, 'inputs', 'scope.json'), '--out', f.out('scan'),
    '--scanner-argv', '"snyk code test"']);
  assert.equal(badArgv.status, 1);
  assert.match(badArgv.stderr, /--scanner-argv must be a non-empty JSON array/);
  if (process.platform === 'win32') {
    const shim = f.node([scanTool, '--repo', f.dir, '--scope-file', path.join(f.root, 'inputs', 'scope.json'), '--out', f.out('scan'),
      '--scanner-argv', JSON.stringify(['snyk.cmd', 'code', 'test', '--sarif'])]);
    assert.equal(shim.status, 1);
    assert.match(shim.stderr, /not a \.cmd\/\.bat shim/);
  }
});
