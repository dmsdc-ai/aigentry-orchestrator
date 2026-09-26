// Independent acceptance: Node 20 built-ins only. No live HOME or caller activation.
// AIGENTRY_PRESERVATION_MODULE is a test-only source selector, never approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), '../..');
const admin = path.join(repo, '.aigentry-report-pv1169');
fs.mkdirSync(admin, { recursive: true, mode: 0o700 });
fs.chmodSync(admin, 0o700);
const modulePath = path.resolve(process.env.AIGENTRY_PRESERVATION_MODULE || path.join(repo, 'bin/init/preservation.mjs'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBefore = sha(fs.readFileSync(modulePath));
const core = await import(pathToFileURL(modulePath).href);
const { plan, apply, inspectPending, inspectOperation, restore } = core;
const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(admin, 'fixtures-')));
fs.chmodSync(runRoot, 0o700);
const mkdir = p => fs.mkdirSync(p, { mode: 0o700 });
function fixture() {
  const base = fs.mkdtempSync(path.join(runRoot, 'case-'));
  fs.chmodSync(base, 0o700);
  const roots = Object.fromEntries(['workspace', 'home', 'backup'].map(name => {
    const p = path.join(base, name); mkdir(p); return [name, p];
  }));
  for (const p of Object.values(roots)) {
    assert.equal(fs.realpathSync(p), p);
    assert.equal(fs.statSync(p).mode & 0o777, 0o700);
  }
  const entry = (relativePath = 'output.md', root = 'workspace', extra = {}) => ({
    root, path: relativePath, kind: 'package', bytes: Buffer.from('new package\n'), mode: 0o640, baseline: null, ...extra,
  });
  const input = { roots, sourceHash: sha('package-v2'), entries: [entry()] };
  const target = e => path.join(roots[e.root], e.path);
  const seed = (e = input.entries[0], bytes = 'custom original\n', mode = 0o600) => {
    const p = target(e); fs.writeFileSync(p, bytes, { mode });
    fs.chmodSync(p, mode); fs.utimesSync(p, new Date(1700000000123), new Date(1700000000456)); return p;
  };
  return { base, roots, entry, input, target, seed };
}
const opts = (input, decisions = [], validateReplacement = () => false) => ({ input, decisions, validateReplacement });
const request = p => ({ roots: p.roots, operationId: p.operationId, planId: p.planId });
const decision = (p, index = 0) => ({ operationId: p.operationId, planId: p.planId,
  root: p.entries[index].root, path: p.entries[index].path,
  beforeHash: p.entries[index].before.hash, desiredHash: p.entries[index].desiredHash });
function meta(p) {
  const s = fs.statSync(p, { bigint: true });
  return { hash: sha(fs.readFileSync(p)), mode: Number(s.mode) & 0o777, mtimeNs: String(s.mtimeNs), ino: String(s.ino) };
}
function inventory(dir) {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const p = path.join(dir, name), s = fs.lstatSync(p);
    return [[p, s.mode & 0o777, s.isFile() ? meta(p) : 'directory'], ...(s.isDirectory() ? inventory(p) : [])];
  });
}
const refuse = (fn, code) => assert.throws(fn, error => error instanceof core.PreservationError && error.code === code);
const backup = (p, index = 0) => path.join(p.roots.backup, p.operationId, `${index}.${p.entries[index].before ? 'bin' : 'absent'}`);
function upgraded() {
  const f = fixture(); f.seed();
  f.input.entries[0].baseline = { hash: sha('custom original\n'), mode: 0o600 };
  return { ...f, p: plan(f.input) };
}

// A deterministic child exits after the first target rename. It never touches
// another process, root, lock or HOME. Automatic recovery is NOT under test.
if (process.argv[2] === '--crash-child') {
  const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  for (const e of input.entries) e.bytes = Buffer.from(e.bytes, 'base64');
  const p = plan(input);
  fs.writeFileSync(path.join(input.roots.backup, 'request.json'), JSON.stringify(request(p)), { mode: 0o600 });
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    const result = rename.call(fs, from, to);
    if (to === path.join(input.roots.workspace, input.entries[0].path)) process.exit(73);
    return result;
  };
  apply(p, opts(input));
  process.exit(74);
}

let failed = false;
const results = [];
function acceptance(name, fn) {
  test(name, { concurrency: false }, t => {
    if (failed) { results.push({ name, status: 'skip' }); t.skip('Stopped after first acceptance failure; preserve evidence'); return; }
    try { fn(); results.push({ name, status: 'pass' }); }
    catch (error) {
      failed = true; results.push({ name, status: 'fail', error: error.stack });
      const hold = `HOLD: pv1169-tester | task: 1169 | phase: acceptance | reason: ${name}: ${error.message} | needs: controller review of preserved fixture ${runRoot}\n`;
      fs.writeFileSync(path.join(admin, 'HOLD.md'), hold, { mode: 0o600 });
      console.error(hold); throw error;
    }
  });
}
test.after(() => {
  const sourceAfter = sha(fs.readFileSync(modulePath));
  fs.writeFileSync(path.join(runRoot, 'results.json'), JSON.stringify({ modulePath, sourceBefore, sourceAfter,
    node: process.version, platform: process.platform, arch: process.arch, results }, null, 2), { mode: 0o600 });
  assert.equal(sourceAfter, sourceBefore, 'candidate changed during acceptance');
  console.log(`Evidence: ${runRoot}/results.json; candidate SHA256 ${sourceAfter}`);
});

acceptance('plan is read-only, frozen and preserves exact no-op metadata', () => {
  const f = fixture(); f.seed(undefined, f.input.entries[0].bytes, 0o640);
  const before = inventory(f.base), p = plan(f.input);
  assert.equal(p.entries[0].action, 'unchanged');
  assert(Object.isFrozen(p) && Object.isFrozen(p.entries[0]));
  assert.deepEqual(inventory(f.base), before);
  const original = meta(f.target(f.input.entries[0]));
  assert.equal(apply(p, opts(f.input)).phase, 'committed');
  assert.deepEqual(meta(f.target(f.input.entries[0])), original);
  assert.equal(restore(request(p)).phase, 'restored');
  assert.deepEqual(meta(f.target(f.input.entries[0])), original);
});
acceptance('fresh workspace and home create, absent markers, inspect and restore idempotence', () => {
  const f = fixture(); f.input.entries.push(f.entry('home.md', 'home'));
  const p = plan(f.input); assert(p.entries.every(e => e.action === 'create'));
  assert.deepEqual(inspectPending({ roots: f.roots }), []);
  assert.equal(apply(p, opts(f.input)).phase, 'committed');
  for (const [i, e] of f.input.entries.entries()) {
    assert.equal(sha(fs.readFileSync(f.target(e))), sha(e.bytes));
    assert.equal(meta(f.target(e)).mode, e.mode);
    assert.equal(fs.readFileSync(backup(p, i), 'utf8'), 'absent\n');
  }
  assert.equal(inspectOperation(request(p)).phase, 'committed');
  assert.equal(restore(request(p)).phase, 'restored');
  for (const e of f.input.entries) assert(!fs.existsSync(f.target(e)));
  assert.equal(restore(request(p)).phase, 'restored');
  assert.deepEqual(inspectPending({ roots: f.roots }), []);
});
acceptance('baseline upgrade backs up before target staging and restores preimage metadata', () => {
  const f = upgraded(); f.input.entries.push(f.entry('home.md', 'home'));
  const p = plan(f.input), original = meta(f.target(f.input.entries[0]));
  assert.equal(p.entries[0].action, 'replace-package');
  const open = fs.openSync; let stages = 0;
  fs.openSync = function (file, flags, ...args) {
    if (typeof file === 'string' && file.endsWith('-apply.tmp') && (flags & fs.constants.O_CREAT)) {
      stages++;
      assert.equal(sha(fs.readFileSync(backup(p))), original.hash);
      assert.equal(fs.readFileSync(backup(p, 1), 'utf8'), 'absent\n');
      for (const i of [0, 1]) assert.equal(fs.statSync(backup(p, i)).mode & 0o777, 0o600);
      assert.equal(meta(f.target(f.input.entries[0])).hash, original.hash);
    }
    return open.call(fs, file, flags, ...args);
  };
  try { assert.equal(apply(p, opts(f.input)).phase, 'committed'); } finally { fs.openSync = open; }
  assert.equal(stages, 2);
  assert.equal(fs.statSync(path.dirname(backup(p))).mode & 0o777, 0o700);
  assert.equal(restore(request(p)).phase, 'restored');
  const after = meta(f.target(f.input.entries[0]));
  assert.equal(after.hash, original.hash); assert.equal(after.mode, original.mode);
  assert(Math.abs(Number(BigInt(after.mtimeNs) - BigInt(original.mtimeNs))) <= 1e6);
  assert.equal(restore(request(p)).phase, 'restored');
  assert.deepEqual(meta(f.target(f.input.entries[0])), after);
  assert(fs.existsSync(backup(p)));
});
acceptance('custom conflict preserves bytes and force/yes are not authority', () => {
  const f = fixture(); f.seed(); const p = plan(f.input), before = inventory(f.base);
  assert.equal(p.entries[0].action, 'conflict');
  refuse(() => apply(p, opts(f.input)), 'CONFLICT');
  for (const key of ['force', 'yes']) refuse(() => apply(p, { ...opts(f.input), [key]: true }), 'SCHEMA');
  assert.deepEqual(inventory(f.base), before);
});
acceptance('exact test-only validator-bound replacement positive control', () => {
  const f = fixture(); f.seed(); const p = plan(f.input), d = decision(p); let calls = 0;
  assert.equal(apply(p, opts(f.input, [d], (actual, actualPlan) => {
    calls++; assert.deepEqual(actual, d); assert.equal(actualPlan, p); assert(Object.isFrozen(actual)); return true;
  })).phase, 'committed');
  assert.equal(calls, 1); assert.equal(sha(fs.readFileSync(backup(p))), d.beforeHash);
  assert.equal(meta(f.target(f.input.entries[0])).hash, d.desiredHash);
});
for (const field of ['operationId', 'planId', 'root', 'path', 'beforeHash', 'desiredHash']) {
  acceptance(`replacement refuses wrong ${field} without validator call`, () => {
    const f = fixture(); f.seed(); const p = plan(f.input), d = decision(p), before = inventory(f.base);
    d[field] = field === 'root' ? 'home' : field === 'path' ? 'foreign.md' : '0'.repeat(64);
    refuse(() => apply(p, opts(f.input, [d], () => { assert.fail('invalid decision reached validator'); })), 'INVALID_DECISION');
    assert.deepEqual(inventory(f.base), before);
  });
}
acceptance('unvalidated, duplicate and previous-plan decisions are refused', () => {
  const f = fixture(); f.seed(); const p = plan(f.input), d = decision(p), before = inventory(f.base);
  refuse(() => apply(p, opts(f.input, [d])), 'REPLACEMENT_REFUSED');
  refuse(() => apply(p, opts(f.input, [d], async () => true)), 'REPLACEMENT_REFUSED');
  refuse(() => apply(p, opts(f.input, [d, d], () => true)), 'INVALID_DECISION');
  refuse(() => apply(plan(f.input), opts(f.input, [d], () => true)), 'INVALID_DECISION');
  assert.deepEqual(inventory(f.base), before);
});
for (const kind of ['state', 'config', 'unknown']) acceptance(`protected ${kind} cannot be approved`, () => {
  const f = fixture(); f.input.entries[0].kind = kind; f.seed();
  const p = plan(f.input), before = inventory(f.base); assert.equal(p.entries[0].action, 'unsupported');
  refuse(() => apply(p, opts(f.input)), 'UNSUPPORTED_ENTRY');
  refuse(() => apply(p, opts(f.input, [decision(p)], () => true)), 'INVALID_DECISION');
  assert.deepEqual(inventory(f.base), before);
});
for (const [root, name] of [['workspace', 'state/data'], ['home', 'config.json'], ['home', 'instructions/projects/data']]) {
  acceptance(`protected path ${root}/${name} overrides package label`, () => {
    const f = fixture(); fs.mkdirSync(path.dirname(path.join(f.roots[root], name)), { recursive: true, mode: 0o700 });
    f.input.entries = [f.entry(name, root)]; f.seed(); const p = plan(f.input);
    assert.equal(p.entries[0].action, 'unsupported'); refuse(() => apply(p, opts(f.input)), 'UNSUPPORTED_ENTRY');
  });
}
for (const name of ['../escape', '/absolute', 'a/../b', 'a\\b', '.aigentry-preservation.lock', 'trailing.']) {
  acceptance(`unsafe relative path ${name}`, () => {
    const f = fixture(); assert.equal(plan(f.input).entries[0].action, 'create');
    const before = inventory(f.base); f.input.entries[0].path = name;
    refuse(() => plan(f.input), 'UNSAFE_PATH'); assert.deepEqual(inventory(f.base), before);
  });
}
for (const type of ['symlink', 'hardlink', 'directory']) acceptance(`unsafe ${type} target refused`, () => {
  const f = fixture(); const target = f.target(f.input.entries[0]);
  assert.equal(plan(f.input).entries[0].action, 'create');
  const other = path.join(f.roots.home, 'sentinel'); fs.writeFileSync(other, 'sentinel', { mode: 0o600 });
  if (type === 'symlink') fs.symlinkSync(other, target);
  if (type === 'hardlink') fs.linkSync(other, target);
  if (type === 'directory') mkdir(target);
  refuse(() => plan(f.input), 'UNSAFE_TARGET'); assert.equal(fs.readFileSync(other, 'utf8'), 'sentinel');
});
acceptance('symlink ancestor and root refused', () => {
  const f = fixture(); fs.symlinkSync(f.roots.home, path.join(f.roots.workspace, 'alias'));
  f.input.entries[0].path = 'alias/output.md'; refuse(() => plan(f.input), 'UNSUPPORTED_PARENT');
  f.input.entries[0].path = 'output.md'; f.input.roots.home = path.join(f.roots.workspace, 'alias');
  refuse(() => plan(f.input), 'UNSUPPORTED_PARENT');
});
acceptance('duplicate aliases and overlapping roots refused', () => {
  const f = fixture(); assert.equal(plan(f.input).entries.length, 1);
  f.input.entries.push(f.entry('OUTPUT.md')); refuse(() => plan(f.input), 'DUPLICATE_ALIAS');
  f.input.entries.pop(); f.input.roots.home = f.roots.workspace; refuse(() => plan(f.input), 'ROOT_OVERLAP');
  f.input.roots.home = path.join(f.roots.workspace, 'nested'); mkdir(f.input.roots.home);
  refuse(() => plan(f.input), 'ROOT_OVERLAP');
});
acceptance('serialized plan is not applicable authority', () => {
  const f = fixture(); const p = plan(f.input);
  refuse(() => apply(JSON.parse(JSON.stringify(p)), opts(f.input)), 'UNTRUSTED_PLAN');
});
for (const field of ['sourceHash', 'bytes', 'mode']) acceptance(`stale input ${field} refused`, () => {
  const f = fixture(), p = plan(f.input), before = inventory(f.base);
  if (field === 'sourceHash') f.input.sourceHash = sha('different-source');
  else f.input.entries[0][field] = field === 'bytes' ? Buffer.from('different') : 0o600;
  refuse(() => apply(p, opts(f.input)), 'STALE_INPUT'); assert.deepEqual(inventory(f.base), before);
});
acceptance('stale destination and stale exact approval refused', () => {
  const f = fixture(); f.seed(); const p = plan(f.input), d = decision(p);
  f.seed(undefined, 'foreign changed'); const before = inventory(f.base);
  refuse(() => apply(p, opts(f.input, [d], () => true)), 'STALE_DESTINATION');
  assert.deepEqual(inventory(f.base), before);
});
acceptance('replaced root identity refused before mutation', () => {
  const f = fixture(), p = plan(f.input);
  fs.renameSync(f.roots.workspace, path.join(f.base, 'old-workspace')); mkdir(f.roots.workspace);
  const before = inventory(f.base); refuse(() => apply(p, opts(f.input)), 'STALE_INPUT');
  assert.deepEqual(inventory(f.base), before);
});
acceptance('wrong inspection identity and corrupt receipt refused', () => {
  const f = upgraded(); apply(f.p, opts(f.input));
  assert.equal(inspectOperation(request(f.p)).phase, 'committed');
  refuse(() => inspectOperation({ ...request(f.p), planId: sha('foreign') }), 'WRONG_OPERATION');
  const receipt = path.join(path.dirname(backup(f.p)), 'operation.json');
  const record = JSON.parse(fs.readFileSync(receipt, 'utf8')); record.payload.phase = 'restored';
  fs.writeFileSync(receipt, JSON.stringify(record));
  refuse(() => restore(request(f.p)), 'CORRUPT_RECEIPT');
});
for (const corruption of ['bytes', 'missing', 'permissions']) acceptance(`restore refuses ${corruption} backup before target writes`, () => {
  const f = upgraded(); apply(f.p, opts(f.input));
  assert.equal(inspectOperation(request(f.p)).phase, 'committed'); const before = meta(f.target(f.input.entries[0]));
  if (corruption === 'bytes') fs.writeFileSync(backup(f.p), 'corrupt');
  if (corruption === 'missing') fs.unlinkSync(backup(f.p));
  if (corruption === 'permissions') fs.chmodSync(backup(f.p), 0o644);
  refuse(() => restore(request(f.p)), corruption === 'bytes' ? 'CORRUPT_BACKUP' : 'MISSING_BACKUP');
  assert.deepEqual(meta(f.target(f.input.entries[0])), before);
});
acceptance('foreign edit preflight prevents restoration of every entry', () => {
  const f = upgraded(); f.input.entries.push(f.entry('second.md', 'home')); const p = plan(f.input);
  apply(p, opts(f.input)); f.seed(f.input.entries[1], 'foreign edit');
  const before = f.input.entries.map(e => meta(f.target(e)));
  refuse(() => restore(request(p)), 'FOREIGN_EDIT');
  assert.deepEqual(f.input.entries.map(e => meta(f.target(e))), before);
});
acceptance('deterministic partial write retains backups and blocks owners with different backup roots', () => {
  const f = upgraded(); f.input.entries.push(f.entry('second.md', 'home')); const p = plan(f.input);
  const otherBackup = path.join(f.base, 'other-backup'); mkdir(otherBackup);
  const otherInput = { ...f.input, roots: { ...f.roots, backup: otherBackup } }, otherPlan = plan(otherInput);
  const rename = fs.renameSync; let targets = 0;
  fs.renameSync = function (from, to) {
    if (f.input.entries.some(e => to === f.target(e)) && ++targets === 2) {
      const error = new Error('deterministic second target rename failure'); error.code = 'EIO'; throw error;
    }
    return rename.call(fs, from, to);
  };
  try { refuse(() => apply(p, opts(f.input)), 'EIO'); } finally { fs.renameSync = rename; }
  assert.equal(targets, 2); assert.equal(inspectOperation(request(p)).phase, 'partial');
  assert.equal(meta(f.target(f.input.entries[0])).hash, p.entries[0].desiredHash);
  assert(!fs.existsSync(f.target(f.input.entries[1])));
  assert.equal(inspectPending({ roots: otherInput.roots }).length, 2);
  refuse(() => plan(otherInput), 'PENDING_OPERATION');
  // This pre-existing plan also fails closed; stale destination is checked first.
  refuse(() => apply(otherPlan, opts(otherInput)), 'STALE_DESTINATION');
  assert.equal(restore(request(p)).phase, 'restored');
  assert.equal(meta(f.target(f.input.entries[0])).hash, p.entries[0].before.hash);
  assert.deepEqual(inspectPending({ roots: otherInput.roots }), []);
});
acceptance('live foreign owner blocks an already planned apply under another backup root', () => {
  const f = fixture(), p = plan(f.input);
  const otherBackup = path.join(f.base, 'other-backup'); mkdir(otherBackup);
  const otherInput = { ...f.input, roots: { ...f.roots, backup: otherBackup } }, otherPlan = plan(otherInput);
  const rename = fs.renameSync; let checked = false;
  fs.renameSync = function (from, to) {
    if (!checked && to === f.target(f.input.entries[0])) {
      checked = true; assert.equal(inspectPending({ roots: otherInput.roots }).length, 2);
      refuse(() => apply(otherPlan, opts(otherInput)), 'PENDING_OPERATION');
    }
    return rename.call(fs, from, to);
  };
  try { assert.equal(apply(p, opts(f.input)).phase, 'committed'); } finally { fs.renameSync = rename; }
  assert(checked); assert.equal(restore(request(p)).phase, 'restored');
});
acceptance('ownerless lock is observable and never stolen', () => {
  const f = fixture(); const p = plan(f.input), lock = path.join(f.roots.workspace, '.aigentry-preservation.lock');
  mkdir(lock); const status = inspectPending({ roots: f.roots });
  assert.equal(status.length, 1); assert.equal(status[0].code, 'OWNERLESS_LOCK');
  refuse(() => plan(f.input), 'PENDING_OPERATION'); refuse(() => apply(p, opts(f.input)), 'PENDING_OPERATION');
  assert(fs.existsSync(lock));
});
acceptance('deterministic child crash exposes executor gate; explicit fixture-only recovery restores', () => {
  const f = upgraded(), inputFile = path.join(f.base, 'child-input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ ...f.input, entries: f.input.entries.map(e => ({ ...e, bytes: e.bytes.toString('base64') })) }), { mode: 0o600 });
  const child = spawnSync(process.execPath, [self, '--crash-child', inputFile], {
    cwd: f.base, encoding: 'utf8', timeout: 20000,
    env: { PATH: path.dirname(process.execPath), HOME: f.roots.home, TMPDIR: f.base, AIGENTRY_PRESERVATION_MODULE: modulePath },
  });
  assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 73, child.stderr);
  const req = JSON.parse(fs.readFileSync(path.join(f.roots.backup, 'request.json'), 'utf8'));
  const status = inspectOperation(req); assert.equal(status.executorBlocked, true); assert.equal(status.phase, 'applying');
  assert.equal(inspectPending({ roots: f.roots }).length, 2);
  refuse(() => restore(req), 'EXECUTOR_BLOCKED');
  // Child termination above establishes fixture quiescence. Not a product unlock API.
  fs.rmdirSync(path.join(f.roots.backup, req.operationId, 'executor'));
  assert.equal(restore(req).phase, 'restored');
  assert.equal(fs.readFileSync(f.target(f.input.entries[0]), 'utf8'), 'custom original\n');
  assert.equal(restore(req).phase, 'restored');
});
