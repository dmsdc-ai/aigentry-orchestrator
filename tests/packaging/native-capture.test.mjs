// Actual init/compiled boot callers; Node built-ins only. No provider or controller execution.
// Optional frozen composition: NATIVE_TEST_PACKAGE, NATIVE_TEST_MANIFEST, NATIVE_TEST_ROOT.
// Direct use: node --test tests/packaging/native-capture.test.mjs (after compilation).
// NATIVE_TEST_ROOT, when set, must be an existing canonical absolute owner-controlled
// NON-Git parent with no symlink or group/world-writable ancestor (including /tmp).
// Otherwise use the canonical home directory under the same checks. Only a fresh
// mkdtemp child is written/chmodded; existing evidence and parent permissions stay intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.realpathSync(process.env.NATIVE_TEST_PACKAGE || repo);
assert.ok(['darwin', 'linux'].includes(process.platform), 'native Windows capture remains unsupported');
const root = process.env.NATIVE_TEST_ROOT ?? fs.realpathSync(os.homedir());
assert.ok(root && path.isAbsolute(root) && root !== path.parse(root).root &&
  path.normalize(root) === root && !root.endsWith(path.sep) && !/[\x00-\x1f\x7f]/.test(root),
  'NATIVE_TEST_ROOT must be a canonical absolute parent; invalid explicit roots never fall back');
assert.equal(fs.realpathSync(root), root, 'NATIVE_TEST_ROOT must not contain symlinks');
for (let current = root; ; current = path.dirname(current)) {
  const s = fs.lstatSync(current);
  assert.ok(s.isDirectory() && !s.isSymbolicLink() &&
    (s.uid === 0 || s.uid === process.getuid()) && (s.mode & 0o022) === 0,
  `unsafe native fixture ancestor: ${current}`);
  let git;
  try { git = fs.lstatSync(path.join(current, '.git')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(git, undefined, `native fixtures must be outside Git: ${current}`);
  if (current === path.dirname(current)) break;
}
assert.equal(fs.statSync(root).uid, process.getuid(), 'native fixture parent must be owned by this user');
const run = fs.mkdtempSync(path.join(root, 'native-capture-'));
fs.chmodSync(run, 0o700);
assert.equal(fs.realpathSync(run), run);
assert.equal(fs.statSync(run).mode & 0o777, 0o700);
console.error(`Evidence retained: ${run}`);
const NODE = fs.realpathSync(process.execPath);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const write = (file, bytes) => fs.writeFileSync(file, bytes, { mode: 0o600 });
const mkdir = dir => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const nativeLeaves = ['bin/hook-prompt-submit.mjs', 'bin/init/native-capture.mjs', 'bin/init/preservation.mjs'];
const commands = [];
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), s = fs.lstatSync(file);
    const value = { mode: s.mode & 0o777, uid: s.uid, gid: s.gid,
      content: s.isFile() ? sha(fs.readFileSync(file)) : s.isSymbolicLink() ? fs.readlinkSync(file) : null };
    return [[name, value], ...(s.isDirectory() ? Object.entries(snapshot(file)).map(([p, v]) => [`${name}/${p}`, v]) : [])];
  }));
}
const manifest = process.env.NATIVE_TEST_MANIFEST ? json(process.env.NATIVE_TEST_MANIFEST) : null;
// Bound repository-default reads/copies to shipped inputs; never traverse .git or dependencies.
const sourceFiles = manifest ? manifest.files.map(f => f.path) : [...new Set([
  ...(await import(pathToFileURL(path.join(source, 'bin/init/manifest.mjs')).href)).MANIFEST,
  'package.json', 'src/orchestrator-boot/cli.ts', 'src/orchestrator-boot/usage.ts',
  'dist/src/orchestrator-boot/cli.js', 'dist/src/orchestrator-boot/usage.js',
  'dist/src/request-capture/cli.js', 'dist/src/request-capture/receipt.js',
  'dist/src/session/persistence/atomic-write.js', 'dist/src/session/persistence/index-lock.js',
])];
const sourceSnapshot = () => Object.fromEntries(sourceFiles.map(rel => {
  const file = path.join(source, rel), s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink(), rel);
  return [rel, { hash: sha(fs.readFileSync(file)), mode: s.mode & 0o777, uid: s.uid, gid: s.gid }];
}));
const frozenBefore = sourceSnapshot();
function verifyManifest(dir) {
  if (!manifest) return;
  for (const f of manifest.files) {
    const bytes = fs.readFileSync(path.join(dir, f.path));
    assert.equal(bytes.length, f.bytes, f.path);
    assert.equal(sha(bytes), f.sha256, f.path);
  }
}
verifyManifest(source);
write(path.join(run, 'source-before.json'), JSON.stringify(frozenBefore, null, 2));

function fixture() {
  const base = fs.mkdtempSync(path.join(run, 'case-'));
  const f = { base };
  for (const name of ['workspace', 'home', 'userhome', 'capture', 'backup', 'tmp', 'ports']) {
    f[name] = path.join(base, name); mkdir(f[name]);
    assert.equal(fs.realpathSync(f[name]), f[name]);
    assert.equal(fs.statSync(f[name]).mode & 0o777, 0o700);
  }
  f.pkg = path.join(base, 'package'); mkdir(f.pkg);
  for (const rel of sourceFiles) {
    const target = path.join(f.pkg, rel); mkdir(path.dirname(target));
    fs.copyFileSync(path.join(source, rel), target);
    fs.chmodSync(target, frozenBefore[rel].mode);
  }
  verifyManifest(f.pkg);
  f.log = path.join(base, 'port-calls.jsonl'); write(f.log, '');
  f.env = { HOME: f.userhome, AIGENTRY_HOME: f.home, TMPDIR: f.tmp, PATH: f.ports,
    AIGENTRY_CONTROL_WORKSPACE: f.workspace, AIGENTRY_SHIM_SCRIPT_DIR: path.join(f.workspace, 'bin'),
    ORCHESTRATOR_CLI: 'codex', ORCHESTRATOR_SID: 'native-fixture', SINGLETON_SELF_PID: '3333' };
  fs.symlinkSync('/bin/bash', path.join(f.ports, 'bash'));
  for (const name of ['mkdir', 'cp']) fs.symlinkSync(`/bin/${name}`, path.join(f.ports, name));
  fs.symlinkSync('/usr/bin/dirname', path.join(f.ports, 'dirname'));
  fs.symlinkSync(NODE, path.join(f.ports, 'node'));
  for (const name of ['jq', 'python3', 'telepty', 'ps', 'kill', 'curl', 'codex', 'claude', 'cmux']) {
    const script = path.join(f.ports, name);
    const response = name === 'telepty' ? JSON.stringify([{ id: 'native-fixture', healthStatus: 'STALE', active_clients: 0 }])
      : name === 'ps' ? '3333 2222 node test\n2222 1 node parent\n7777 1 node telepty allow --id native-fixture --auto-restart codex\n' : '';
    write(script, `#!${NODE}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(f.log)},JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n');process.stdout.write(${JSON.stringify(response)});process.exit(${['jq', 'python3', 'kill', 'curl', 'codex', 'claude', 'cmux'].includes(name) ? 97 : 0});\n`);
    fs.chmodSync(script, 0o700);
  }
  Object.assign(f.env, { TELEPTY: path.join(f.ports, 'telepty'), SINGLETON_PS_CMD: path.join(f.ports, 'ps'),
    KILL_CMD: path.join(f.ports, 'kill'), CURL: path.join(f.ports, 'curl') });
  return f;
}
function record(f, label, args, result) {
  const id = `${commands.length}-${label}`;
  write(path.join(run, `${id}.stdout`), result.stdout || '');
  write(path.join(run, `${id}.stderr`), result.stderr || '');
  commands.push({ id, command: NODE, args, cwd: f.workspace, status: result.status,
    signal: result.signal, error: result.error?.message, fixture: f.base });
  write(path.join(run, 'commands.json'), JSON.stringify(commands, null, 2));
  return result;
}
function invoke(f, label, args, env = {}) {
  return record(f, label, args, spawnSync(NODE, args, { cwd: f.workspace,
    env: { ...f.env, ...env }, encoding: 'utf8', timeout: 20000 }));
}
const initArgs = (f, extras = [], native = true) => [path.join(f.pkg, 'bin/init/cli.mjs'), 'init',
  '--workspace', f.workspace, '--yes', ...(native ? ['--capture-root', f.capture, '--preservation-root', f.backup] : []), ...extras];
const init = (f, extras = [], native = true) => invoke(f, 'init', initArgs(f, extras, native));
const ok = r => assert.equal(r.status, 0, r.stderr + r.stdout);
const refused = r => { assert.equal(r.signal, null); assert.notEqual(r.status, null); assert.notEqual(r.status, 0, r.stdout); };
const stamp = f => json(path.join(f.workspace, '.aigentry-init.json'));
function boot(f, args) {
  assert.ok(args.length && ['--help', '-h', '--dry-run', '__probe'].includes(args[0]));
  write(f.log, '');
  const before = [snapshot(f.workspace), snapshot(f.home), snapshot(f.capture), snapshot(f.backup)];
  const r = invoke(f, 'boot', [path.join(f.pkg, 'dist/src/orchestrator-boot/cli.js'), ...args]);
  assert.deepEqual([snapshot(f.workspace), snapshot(f.home), snapshot(f.capture), snapshot(f.backup)], before);
  const calls = read(f.log).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(calls.every(c => ['telepty', 'ps'].includes(c.name)), JSON.stringify(calls));
  assert.ok(calls.every(c => c.name !== 'telepty' || JSON.stringify(c.args) === '["list","--json"]'));
  return { ...r, calls };
}
const inspectionModes = [['--dry-run'], ['__probe', 'singleton-guard'], ['__probe', 'registry-reconcile'],
  ['__probe', 'exec-argv'], ['__probe'], ['__probe', 'unknown']];
function blockedBoot(f) {
  for (const args of inspectionModes) {
    const r = boot(f, args); assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, ''); assert.deepEqual(r.calls, []);
    assert.match(r.stderr, /static validation failed/);
  }
  for (const flag of ['--help', '-h']) { const r = boot(f, [flag]); ok(r); assert.deepEqual(r.calls, []); }
}

test('legacy actual init baseline, help and dry run stay read-only', () => {
  const f = fixture(), before = snapshot(f.workspace);
  ok(init(f, ['--help'], false)); ok(init(f, ['--dry-run'], false));
  assert.deepEqual(snapshot(f.workspace), before);
  ok(init(f, [], false)); assert.equal(stamp(f).nativeCapture, undefined);
  for (const args of inspectionModes.slice(0, 4)) ok(boot(f, args));
});

test('fresh native init registers one synchronous official hook through preservation', () => {
  const f = fixture(); ok(init(f));
  const s = stamp(f).nativeCapture, hooks = json(path.join(f.workspace, '.codex/hooks.json'));
  assert.deepEqual(Object.keys(hooks), ['description', 'hooks']);
  assert.deepEqual(Object.keys(hooks.hooks), ['UserPromptSubmit']);
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  const group = hooks.hooks.UserPromptSubmit[0]; assert.deepEqual(Object.keys(group), ['hooks']);
  assert.equal(group.hooks.length, 1);
  const q = x => `'${x.replaceAll("'", `'"'"'`)}'`;
  assert.deepEqual(group.hooks[0], { type: 'command', command: `${q(NODE)} ${q(path.join(f.workspace, nativeLeaves[0]))} --root ${q(f.capture)} --package-root ${q(f.pkg)}`, timeout: 600 });
  assert.equal(s.status, 'installed/pending-review'); assert.equal(s.provenance, 'local-file-measurements-unverified');
  assert.equal(s.node, NODE); assert.equal(s.packageRoot, f.pkg);
  assert.equal(s.definitionHash, sha(fs.readFileSync(path.join(f.workspace, '.codex/hooks.json'))));
  assert.equal(Object.keys(s.packageFiles).length, 8);
  for (const [rel, baseline] of Object.entries(s.packageFiles)) assert.equal(baseline.hash, sha(fs.readFileSync(path.join(f.pkg, rel))));
  const journal = json(path.join(f.backup, `native-${s.operationId}`, 'operation.json')).record;
  assert.equal(journal.phase, 'committed'); assert.deepEqual(journal.packageOperation, s.packageOperation);
  assert.deepEqual(Object.keys(journal.packageAfter), nativeLeaves);
  assert.equal(fs.existsSync(path.join(f.workspace, '.aigentry-native-capture.lock')), false);
  for (const args of inspectionModes.slice(0, 4)) {
    const r = boot(f, args); ok(r); assert.match(r.stderr, /installed\/pending-review/);
    if (args[1] === 'exec-argv') assert.equal(r.stdout, 'telepty\nallow\n--id\nnative-fixture\n--auto-restart\ncodex\nresume\n--last\n--dangerously-bypass-approvals-and-sandbox\n');
    if (args[0] === '--dry-run') assert.ok(r.stdout.split('\n').filter(Boolean).every(line => line.startsWith('[orchestrator-boot] [dry-run] ') || line.startsWith('[would-exec] ')));
  }
});

for (const fault of ['missing-capture', 'missing-backup', 'missing-dist', 'wrong-root', 'overlap', 'symlink', 'permissions', 'cleanup-overlap']) {
  test(`native preflight refuses ${fault} without unrelated writes`, () => {
    const f = fixture(); let args = initArgs(f), env = {};
    if (fault === 'missing-capture') args.splice(args.indexOf('--capture-root'), 2);
    if (fault === 'missing-backup') args.splice(args.indexOf('--preservation-root'), 2);
    if (fault === 'missing-dist') fs.unlinkSync(path.join(f.pkg, 'dist/src/request-capture/cli.js'));
    if (fault === 'wrong-root') args[args.indexOf('--capture-root') + 1] = path.join(f.base, 'absent');
    if (fault === 'overlap') args[args.indexOf('--capture-root') + 1] = f.home;
    if (fault === 'symlink') { fs.symlinkSync(f.capture, path.join(f.base, 'alias')); args[args.indexOf('--capture-root') + 1] = path.join(f.base, 'alias'); }
    if (fault === 'permissions') fs.chmodSync(f.capture, 0o755);
    if (fault === 'cleanup-overlap') env.DISPATCH_STATE_DIR = f.capture;
    const before = snapshot(f.base); refused(invoke(f, 'preflight', args, env)); assert.deepEqual(snapshot(f.base), before);
  });
}

for (const flags of [['--upgrade'], ['--force'], ['--force', '--yes']]) {
  test(`unowned/shared hooks survive generic flags ${flags.join(' ')}`, () => {
    const f = fixture(); ok(init(f, [], false)); mkdir(path.join(f.workspace, '.codex'));
    write(path.join(f.workspace, '.codex/hooks.json'), '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"custom"}]}]}}\n');
    const before = snapshot(f.base); const r = init(f, flags); refused(r);
    assert.match(r.stderr, /unowned\/shared/); assert.deepEqual(snapshot(f.base), before);
  });
}

function operation(f, action, id, extras = []) { return init(f, [`--${action}-native`, id, ...extras]); }
function seedUnrelated(f) {
  mkdir(path.join(f.workspace, '.codex'));
  write(path.join(f.workspace, '.codex/config.toml'), '# custom unrelated config\n');
  write(path.join(f.capture, 'raw.jsonl'), '{"raw":"retain"}\n');
  write(path.join(f.capture, 'receipt.json'), '{"receipt":"retain"}\n');
  return { config: read(path.join(f.workspace, '.codex/config.toml')), capture: snapshot(f.capture) };
}
test('legacy-to-native init, inspect and fresh restore preserve exact preimages and unrelated data', () => {
  const f = fixture(); ok(init(f, [], false)); const unrelated = seedUnrelated(f);
  const before = Object.fromEntries([...nativeLeaves, '.aigentry-init.json'].map(rel => [rel, snapshot(f.workspace)[rel]]));
  ok(init(f, ['--upgrade'])); const id = stamp(f).nativeCapture.operationId;
  const installed = snapshot(f.base);
  ok(operation(f, 'inspect', id)); ok(operation(f, 'restore', id, ['--dry-run']));
  assert.deepEqual(snapshot(f.base), installed);
  ok(operation(f, 'restore', id));
  for (const [rel, image] of Object.entries(before)) assert.deepEqual(snapshot(f.workspace)[rel], image, rel);
  assert.equal(fs.existsSync(path.join(f.workspace, '.codex/hooks.json')), false);
  assert.deepEqual(snapshot(f.capture), unrelated.capture);
  assert.equal(read(path.join(f.workspace, '.codex/config.toml')), unrelated.config);
  assert.ok(fs.existsSync(path.join(f.backup, `native-${id}`, 'operation.json')));
  ok(boot(f, ['__probe', 'exec-argv']));
});

test('fresh native restore removes registration before owned outputs (source ordering plus actual final state)', () => {
  const f = fixture(); ok(init(f)); const id = stamp(f).nativeCapture.operationId;
  write(path.join(f.capture, 'raw.jsonl'), 'retain\n');
  ok(operation(f, 'restore', id));
  for (const rel of [...nativeLeaves, '.codex/hooks.json', '.aigentry-init.json']) assert.equal(fs.existsSync(path.join(f.workspace, rel)), false, rel);
  assert.equal(read(path.join(f.capture, 'raw.jsonl')), 'retain\n');
  const code = read(path.join(f.pkg, 'bin/init/native-capture.mjs')).split('export function restoreNativeOperation')[1];
  assert.ok(code.indexOf('replaceConfig(tx, 0,') < code.indexOf('preservation.restore('));
  ok(operation(f, 'restore', id));
});

test('subsequent owned upgrade restores prior bytes/modes/ownership and remains bootable', () => {
  const f = fixture(); ok(init(f)); const unrelated = seedUnrelated(f);
  const selected = () => Object.fromEntries([...nativeLeaves, '.codex/hooks.json', '.aigentry-init.json'].map(rel => [rel, snapshot(f.workspace)[rel]]));
  const before = selected(), first = stamp(f).nativeCapture.operationId;
  ok(init(f, ['--upgrade'])); const second = stamp(f).nativeCapture.operationId;
  assert.notEqual(second, first); ok(operation(f, 'restore', second));
  assert.deepEqual(selected(), before); assert.deepEqual(snapshot(f.capture), unrelated.capture);
  assert.equal(read(path.join(f.workspace, '.codex/config.toml')), unrelated.config);
  ok(boot(f, ['__probe', 'exec-argv']));
});

for (const fault of ['damaged-backup', 'foreign-config', 'foreign-wrapper', 'pending-executor', 'wrong-operation', 'package-stage']) {
  test(`explicit restore refuses ${fault} and retains evidence`, () => {
    const f = fixture(); ok(init(f)); ok(init(f, ['--upgrade']));
    const s = stamp(f).nativeCapture, dir = path.join(f.backup, `native-${s.operationId}`);
    let id = s.operationId;
    if (fault === 'damaged-backup') fs.appendFileSync(path.join(dir, 'before-0'), 'damage');
    if (fault === 'foreign-config') fs.appendFileSync(path.join(f.workspace, '.codex/hooks.json'), '\n');
    if (fault === 'foreign-wrapper') fs.appendFileSync(path.join(f.workspace, nativeLeaves[0]), '\n// foreign edit\n');
    if (fault === 'pending-executor') mkdir(path.join(dir, 'executor'));
    if (fault === 'wrong-operation') id = randomUUID();
    if (fault === 'package-stage') write(path.join(f.workspace, 'bin', `.aigentry-preservation-${s.packageOperation.operationId}-0-restore.tmp`), 'foreign stage');
    const before = snapshot(f.base); refused(operation(f, 'restore', id)); assert.deepEqual(snapshot(f.base), before);
  });
}

for (const fault of ['adapter', 'helper', 'wrapper', 'compiled-cli', 'compiled-receipt', 'compiled-atomic', 'compiled-lock', 'package-source', 'node-path', 'pending-lock', 'stamp']) {
  test(`compiled boot refuses ${fault} before any external port or argv`, () => {
    const f = fixture(); ok(init(f));
    const target = { adapter: [f.workspace, 'bin/init/native-capture.mjs'], helper: [f.workspace, 'bin/init/preservation.mjs'],
      wrapper: [f.workspace, nativeLeaves[0]], 'compiled-cli': [f.pkg, 'dist/src/request-capture/cli.js'],
      'compiled-receipt': [f.pkg, 'dist/src/request-capture/receipt.js'], 'compiled-atomic': [f.pkg, 'dist/src/session/persistence/atomic-write.js'],
      'compiled-lock': [f.pkg, 'dist/src/session/persistence/index-lock.js'], 'package-source': [f.pkg, nativeLeaves[0]] }[fault];
    if (target) {
      // Deliberate isolated fault only: record both hashes; never change frozen input.
      const file = path.join(...target), before = sha(fs.readFileSync(file));
      fs.appendFileSync(file, '\nthrow new Error("DRIFT MUST NOT EXECUTE");\n');
      write(path.join(f.base, 'fault.json'), JSON.stringify({ file, before, after: sha(fs.readFileSync(file)) }));
    }
    if (fault === 'node-path') { const s = stamp(f); s.nativeCapture.node = path.join(f.ports, 'node'); write(path.join(f.workspace, '.aigentry-init.json'), JSON.stringify(s)); }
    if (fault === 'pending-lock') mkdir(path.join(f.workspace, '.aigentry-native-capture.lock'));
    if (fault === 'stamp') write(path.join(f.workspace, '.aigentry-init.json'), '{broken');
    blockedBoot(f);
  });
}

for (const native of [false, true]) {
  test(`${native ? 'native' : 'legacy'} caller failure retains lock and blocks retries/boot without stale-lock theft`, () => {
    const f = fixture(); write(path.join(f.home, 'instructions'), 'intentional filesystem failure\n');
    const failed = init(f, [], native); assert.equal(failed.status, 6, failed.stderr);
    const lock = path.join(f.workspace, '.aigentry-native-capture.lock'); assert.ok(fs.existsSync(lock));
    const before = snapshot(f.base); refused(init(f, ['--force'], native)); refused(init(f, ['--force'], !native));
    assert.deepEqual(snapshot(f.base), before); blockedBoot(f);
    if (native) {
      const id = json(path.join(lock, 'owner.json')).operationId;
      ok(operation(f, 'inspect', id)); const r = operation(f, 'restore', id); refused(r);
      assert.match(r.stderr, /external quiescence|external recovery/);
      assert.ok(fs.existsSync(path.join(f.backup, `native-${id}`, 'executor')));
    }
  });
}

function concurrentInit(f, native) {
  const args = initArgs(f, [], native);
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, args, { cwd: f.workspace, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', (status, signal) => resolve(record(f, 'competing-init', args, { status, signal, stdout, stderr })));
  });
}
test('three cross-process native-versus-legacy init competitions admit at most one writer', async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = fixture(); const results = await Promise.all([concurrentInit(f, true), concurrentInit(f, false)]);
    assert.equal(results.filter(r => r.status === 0).length, 1, results.map(r => r.stderr).join('\n'));
    for (const r of results.filter(r => r.status !== 0)) refused(r);
    const s = stamp(f); assert.equal(fs.existsSync(path.join(f.workspace, '.aigentry-native-capture.lock')), false);
    if (s.nativeCapture) { ok(boot(f, ['__probe', 'exec-argv'])); refused(init(f, ['--force'], false)); }
    else assert.equal(fs.existsSync(path.join(f.workspace, '.codex/hooks.json')), false);
  }
});

test('probe contracts suppress actuation while real boot retains literal SIGKILL', () => {
  const code = read(path.join(source, 'src/orchestrator-boot/cli.ts'));
  assert.match(code, /const DRY_RUN = MODE === "dry-run" \|\| MODE === "probe"/);
  assert.match(code, /spawnSync\(KILL_CMD, \["-9", r.pid\]/);
  assert.match(code, /SIGKILL stale orchestrator bridge/);
  const f = fixture();
  for (const args of inspectionModes) {
    const r = boot(f, args); assert.equal(r.status, args.length === 1 && args[0] === '__probe' || args[1] === 'unknown' ? 4 : 0);
    if (args[0] === '__probe' && args[1] !== 'exec-argv') assert.equal(r.stdout, '');
  }
});

test.after(() => {
  verifyManifest(source); assert.deepEqual(sourceSnapshot(), frozenBefore);
  write(path.join(run, 'source-after.json'), JSON.stringify(sourceSnapshot(), null, 2));
  write(path.join(run, 'currentness.json'), JSON.stringify({ source, manifestFiles: manifest?.files.length,
    manifestHash: process.env.NATIVE_TEST_MANIFEST ? sha(fs.readFileSync(process.env.NATIVE_TEST_MANIFEST)) : null,
    testHash: sha(fs.readFileSync(fileURLToPath(import.meta.url))), node: NODE, version: process.version,
    sourceUnchanged: true, commands: commands.length, kind: manifest?.kind || 'local source' }, null, 2));
});
