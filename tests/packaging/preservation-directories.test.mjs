// Independent directory acceptance; fixture-only fault injection, Node built-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), '../..');
const admin = path.join(repo, '.aigentry-report-dv1169');
const source = path.join(repo, 'bin/init/preservation.mjs');
const sha = x => createHash('sha256').update(x).digest('hex');
const sourceBefore = sha(fs.readFileSync(source));
assert.equal(sourceBefore, 'a07066a44fe959660f5e5b7b983028d8ebb300293e5b80cf1b54776d00a5b95b');
const { plan, apply, restore, inspectOperation, inspectPending, PreservationError } = await import(pathToFileURL(source));
const mkdir = p => fs.mkdirSync(p, { mode: 0o700 });
const options = (input, decisions = [], validateReplacement = () => false) => ({ input, decisions, validateReplacement });
const request = p => ({ roots: p.roots, operationId: p.operationId, planId: p.planId });
const opdir = p => path.join(p.roots.backup, p.operationId);
const receiptPath = p => path.join(opdir(p), 'operation.json');
const receipt = p => JSON.parse(fs.readFileSync(receiptPath(p))).payload;
const backup = (p, i) => path.join(opdir(p), `${i}.${p.entries[i].before ? 'bin' : 'absent'}`);
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
function refused(fn, code) {
  let actual;
  assert.throws(fn, e => { actual = e; return e instanceof PreservationError && (!code || e.code === code); });
  return actual;
}
function inventory(base, targetsOnly = false) {
  const rows = [];
  function visit(p) {
    const s = fs.lstatSync(p, { bigint: true });
    const rel = path.relative(base, p);
    const item = { path: rel, dev: String(s.dev), ino: String(s.ino), uid: String(s.uid), gid: String(s.gid), mode: Number(s.mode) };
    if (s.isFile()) Object.assign(item, { bytes: fs.readFileSync(p).toString('base64'), mtime: String(s.mtimeNs) });
    if (s.isSymbolicLink()) item.link = fs.readlinkSync(p);
    rows.push(item);
    if (s.isDirectory()) for (const name of fs.readdirSync(p).sort()) {
      if (targetsOnly && (rel === '' && name === 'backup' || name.startsWith('.aigentry-preservation'))) continue;
      visit(path.join(p, name));
    }
  }
  visit(base); return rows;
}
function noMutation(f, fn, code) {
  const before = inventory(f.base);
  const e = refused(fn, code);
  assert.deepEqual(inventory(f.base), before);
  return e;
}
function patchFs(name, hook, fn) {
  const original = fs[name];
  fs[name] = (...args) => hook(original, ...args);
  try { return fn(); } finally { fs[name] = original; }
}
function injected() { return Object.assign(new Error('fixture-injected EIO'), { code: 'EIO' }); }

// Children only receive an exact private fixture input. Sentinel exits represent
// deliberate crashes, never implicit acceptance failures or real process scans.
if (process.argv[2] === '--crash-child') {
  const input = JSON.parse(fs.readFileSync(process.argv[3]));
  input.entries.forEach(e => { e.bytes = Buffer.from(e.bytes, 'base64'); });
  const p = plan(input), boundary = process.argv[4];
  fs.writeFileSync(path.join(input.roots.backup, 'request.json'), JSON.stringify(request(p)), { mode: 0o600 });
  const target = path.join(input.roots.workspace, 'new');
  if (boundary === 'mkdir') {
    patchFs('mkdirSync', (original, file, ...args) => {
      const result = original(file, ...args);
      if (file === target) process.exit(73);
      return result;
    }, () => apply(p, options(input)));
  } else {
    patchFs('openSync', (original, file, ...args) => {
      if (typeof file === 'string' && file.endsWith('-apply.tmp')) process.exit(73);
      return original(file, ...args);
    }, () => apply(p, options(input)));
  }
  process.exit(74);
}

fs.mkdirSync(admin, { recursive: true, mode: 0o700 });
const runRoot = fs.realpathSync(fs.mkdtempSync(path.join(admin, 'directories-')));
const results = [];
let currentFixtures = [];
function fixture() {
  const base = fs.mkdtempSync(path.join(runRoot, 'case-'));
  const roots = Object.fromEntries(['workspace', 'home', 'backup'].map(k => {
    const p = path.join(base, k); mkdir(p); assert.equal(fs.realpathSync(p), p); return [k, p];
  }));
  const entry = (p = 'new/out', root = 'workspace', extra = {}) => ({ root, path: p, kind: 'package',
    bytes: Buffer.from('replacement\n'), mode: 0o600, baseline: null, ...extra });
  const dir = (p = 'new', root = 'workspace', extra = {}) => ({ root, path: p, mode: 0o700, ...extra });
  const input = { roots, sourceHash: sha('synthetic-package'), entries: [entry()], directories: [dir()] };
  const target = e => path.join(roots[e.root], e.path);
  currentFixtures.push(base);
  return { base, roots, entry, dir, input, target };
}
function acceptance(name, fn) {
  test(name, { concurrency: false }, () => {
    currentFixtures = [];
    try { fn(); results.push({ name, status: 'pass', fixtures: currentFixtures }); }
    catch (e) {
      const failure = { name, status: 'fail', fixtures: currentFixtures, error: e.stack };
      results.push(failure);
      fs.writeFileSync(path.join(runRoot, `failure-${results.length}.json`), JSON.stringify(failure, null, 2), { mode: 0o600 });
      console.error(`REPORT FAIL task=1169 sid=dv1169-tester operation=dv1169-v1 case=${name} fixtures=${currentFixtures.join(',')}`);
      throw e;
    }
  });
}
test.after(() => {
  const sourceAfter = sha(fs.readFileSync(source));
  fs.writeFileSync(path.join(runRoot, 'results.json'), JSON.stringify({ source, sourceBefore, sourceAfter,
    harnessHash: sha(fs.readFileSync(self)), node: process.version, platform: process.platform, arch: process.arch, results }, null, 2), { mode: 0o600 });
  assert.equal(sourceAfter, sourceBefore);
  console.log(`Evidence: ${runRoot}/results.json`);
});

acceptance('omitted directories retains v1; explicit empty selects v2', () => {
  for (const v2 of [false, true]) {
    const f = fixture(); f.input.entries = [f.entry('out')];
    if (v2) f.input.directories = []; else delete f.input.directories;
    const before = inventory(f.base), p = plan(f.input);
    assert.equal(p.schemaVersion, v2 ? 2 : 1); assert.deepEqual(inventory(f.base), before);
    assert.equal(apply(p, options(f.input)).phase, 'committed');
    assert.equal(receipt(p).schemaVersion, v2 ? 2 : 1);
    assert.equal('directoryProgress' in receipt(p), v2);
    assert.equal(restore(request(p)).phase, 'restored');
    assert.equal(restore(request(p)).phase, 'restored');
  }
});
acceptance('nested both roots, arbitrary declaration order, unchanged existing directories, restore deepest first', () => {
  const f = fixture(); mkdir(path.join(f.roots.workspace, 'existing')); fs.chmodSync(path.join(f.roots.workspace, 'existing'), 0o750);
  f.input.directories = [f.dir('new/deep'), f.dir('new'), f.dir('h/deep', 'home'), f.dir('h', 'home'), f.dir('existing')];
  f.input.entries = [f.entry('new/deep/out'), f.entry('h/deep/out', 'home'), f.entry('existing/same')];
  fs.writeFileSync(f.target(f.input.entries[2]), f.input.entries[2].bytes, { mode: 0o600 });
  const before = inventory(f.base), p = plan(f.input);
  assert.deepEqual(inventory(f.base), before);
  assert(Object.isFrozen(p) && Object.isFrozen(p.directories) && Object.isFrozen(p.directories[0]));
  assert.equal(apply(p, options(f.input)).phase, 'committed');
  for (const e of f.input.entries) assert.deepEqual(fs.readFileSync(f.target(e)), e.bytes);
  for (const d of f.input.directories.filter(d => d.path !== 'existing')) assert.equal(fs.statSync(f.target(d)).mode & 0o777, 0o700);
  assert.equal(inspectOperation(request(p)).phase, 'committed');
  const removed = [];
  patchFs('rmdirSync', (original, file, ...args) => { removed.push(file); return original(file, ...args); }, () => restore(request(p)));
  assert(removed.indexOf(path.join(f.roots.workspace, 'new/deep')) < removed.indexOf(path.join(f.roots.workspace, 'new')));
  assert.deepEqual(inventory(f.base, true), before.filter(r => r.path !== 'backup'));
  assert.equal(restore(request(p)).phase, 'restored');
  assert.deepEqual(inspectPending({ roots: f.roots }), []);
});
acceptance('directories only; existing undeclared parent is retained', () => {
  const f = fixture(); mkdir(path.join(f.roots.home, 'parent'));
  f.input.entries = []; f.input.directories = [f.dir('parent/child', 'home')];
  const before = inventory(f.base, true), p = plan(f.input);
  assert.equal(p.directoryParents.length, 1);
  apply(p, options(f.input)); restore(request(p)); restore(request(p));
  assert.deepEqual(inventory(f.base, true), before);
});
acceptance('existing original backup and synthetic custom replacement validator', () => {
  const f = fixture(); f.input.entries.unshift(f.entry('old'));
  fs.writeFileSync(f.target(f.input.entries[0]), 'custom original', { mode: 0o640 });
  fs.chmodSync(f.target(f.input.entries[0]), 0o640);
  const p = plan(f.input), e = p.entries[0]; let calls = 0;
  const d = { operationId: p.operationId, planId: p.planId, root: e.root, path: e.path, beforeHash: e.before.hash, desiredHash: e.desiredHash };
  noMutation(f, () => apply(p, options(f.input)), 'CONFLICT');
  noMutation(f, () => apply(p, options(f.input, [d])), 'REPLACEMENT_REFUSED');
  noMutation(f, () => apply(p, options(f.input, [d], async () => true)), 'REPLACEMENT_REFUSED');
  apply(p, options(f.input, [d], (actual, actualPlan) => { calls++; assert(Object.isFrozen(actual)); assert.equal(actualPlan, p); return true; }));
  assert.equal(calls, 1); assert.equal(fs.readFileSync(backup(p, 0), 'utf8'), 'custom original');
  restore(request(p)); assert.equal(fs.readFileSync(f.target(e), 'utf8'), 'custom original');
  assert.equal(fs.statSync(f.target(e)).mode & 0o777, 0o640);
});

const invalidSchemas = [
  ['null directories', f => { f.input.directories = null; }],
  ['sparse directories', f => { f.input.directories = new Array(1); }],
  ['nonarray directories', f => { f.input.directories = {}; }],
  ['null declaration', f => { f.input.directories = [null]; }],
  ['unknown input key', f => { f.input.extra = true; }],
  ['unknown directory key', f => { f.input.directories[0].extra = true; }],
  ['missing directory mode', f => { delete f.input.directories[0].mode; }],
  ['invalid root', f => { f.input.directories[0].root = 'backup'; }],
  ['decorated array', f => { f.input.directories.extra = true; }],
  ['sparse entries', f => { f.input.entries = new Array(1); }],
  ['accessor declaration', f => { Object.defineProperty(f.input.directories[0], 'mode', { get() { throw new Error('accessor executed'); }, enumerable: true }); }],
];
for (const [name, mutate] of invalidSchemas) acceptance(`schema refuses ${name}`, () => {
  const f = fixture(); mutate(f); noMutation(f, () => plan(f.input), 'SCHEMA');
});
for (const mode of [0o755, 0o777, 0o600, 0o1700, -1, '0700', null]) acceptance(`directory mode refuses ${mode}`, () => {
  const f = fixture(); f.input.directories[0].mode = mode; noMutation(f, () => plan(f.input));
});
for (const p of ['../escape', '/absolute', 'a/../b', 'a//b', './a', 'a/', 'a\\b', 'a:b', 'a\nq', 'a\u0000q', '.git', 'a/.GIT/b', '.aigentry-preservation.lock', 'a/.AIGENTRY-preservation-x/b', 'a.', 'a ', 'e\u0301']) {
  acceptance(`directory path refuses ${JSON.stringify(p)}`, () => {
    const f = fixture(); f.input.directories = [f.dir(p)]; noMutation(f, () => plan(f.input), 'UNSAFE_PATH');
  });
}
for (const [a, b] of [['new', 'new'], ['new', 'NEW'], ['A/child', 'a/other'], ['é', 'e\u0301']]) acceptance(`aliases refuse ${a}/${b}`, () => {
  const f = fixture(); f.input.entries = []; f.input.directories = [f.dir(a), f.dir(b)]; noMutation(f, () => plan(f.input));
});
for (const shape of ['overlap', 'file ancestor directory', 'file ancestor file', 'missing parent']) acceptance(`layout refuses ${shape}`, () => {
  const f = fixture();
  if (shape === 'overlap') f.input.entries = [f.entry('new')];
  if (shape === 'file ancestor directory') { f.input.entries = [f.entry('new')]; f.input.directories = [f.dir('new/child')]; }
  if (shape === 'file ancestor file') { f.input.entries = [f.entry('a'), f.entry('a/out')]; f.input.directories = []; }
  if (shape === 'missing parent') f.input.directories = [f.dir('new/child')];
  noMutation(f, () => plan(f.input));
});
for (const root of ['workspace', 'home', 'backup']) acceptance(`missing ${root} refuses bootstrap`, () => {
  const f = fixture(); fs.rmdirSync(f.roots[root]); noMutation(f, () => plan(f.input), 'UNSUPPORTED_PARENT');
});
for (const kind of ['state', 'config', 'unknown']) acceptance(`declared directories confer no ${kind} file authority`, () => {
  const f = fixture(); f.input.entries[0].kind = kind; const p = plan(f.input);
  noMutation(f, () => apply(p, options(f.input)), 'UNSUPPORTED_ENTRY');
});
for (const [root, p, ds] of [['workspace', 'state/data', ['state']], ['home', 'config.json', []], ['home', 'instructions/projects/data', ['instructions', 'instructions/projects']]]) {
  acceptance(`protected destination ${root}/${p}`, () => {
    const f = fixture(); f.input.directories = ds.map(d => f.dir(d, root)); f.input.entries = [f.entry(p, root)];
    const value = plan(f.input); noMutation(f, () => apply(value, options(f.input)), 'UNSUPPORTED_ENTRY');
  });
}
acceptance('symlink parent refuses without following outside target', () => {
  const f = fixture(); fs.symlinkSync(f.roots.home, path.join(f.roots.workspace, 'new'));
  noMutation(f, () => plan(f.input));
});
for (const drift of ['mode', 'identity', 'foreign directory', 'foreign file', 'owner']) acceptance(`plan/apply drift refuses ${drift}`, () => {
  const f = fixture(); const d = path.join(f.roots.workspace, 'new');
  if (!drift.startsWith('foreign')) mkdir(d);
  const p = plan(f.input);
  if (drift === 'mode') fs.chmodSync(d, 0o750);
  if (drift === 'identity') { fs.renameSync(d, path.join(f.roots.workspace, 'retired')); mkdir(d); }
  if (drift === 'foreign directory') mkdir(d);
  if (drift === 'foreign file') fs.writeFileSync(d, 'foreign', { mode: 0o600 });
  if (drift === 'owner') {
    // Simulate a foreign uid only for this exact fixture lstat; no privileged chown.
    patchFs('lstatSync', (original, file, ...args) => {
      const s = original(file, ...args);
      if (file === d) s.uid = typeof s.uid === 'bigint' ? s.uid + 1n : s.uid + 1;
      return s;
    }, () => noMutation(f, () => apply(p, options(f.input))));
  } else noMutation(f, () => apply(p, options(f.input)));
});
acceptance('live plan and fresh input invariants before target mutation', () => {
  const f = fixture(), p = plan(f.input);
  noMutation(f, () => apply(JSON.parse(JSON.stringify(p)), options(f.input)), 'UNTRUSTED_PLAN');
  f.input.directories.push(f.dir('extra'));
  noMutation(f, () => apply(p, options(f.input)), 'STALE_INPUT');
});

for (const holderV2 of [false, true]) acceptance(`fixed locks exclude v1/v2 competitors while v${holderV2 ? 2 : 1} owns roots`, () => {
  const f = fixture(); f.input.entries = [f.entry('out')];
  if (!holderV2) delete f.input.directories;
  const alt = path.join(f.base, 'alternative-backup'); mkdir(alt);
  const candidates = [
    { roots: f.roots, sourceHash: f.input.sourceHash, entries: [f.entry('other')] },
    { roots: { ...f.roots, backup: alt }, sourceHash: f.input.sourceHash, entries: [], directories: [f.dir('otherdir')] },
  ];
  const previews = candidates.map(i => plan(i)), p = plan(f.input); let observed = 0;
  patchFs('openSync', (original, file, ...args) => {
    if (typeof file === 'string' && file.endsWith('-apply.tmp') && (args[0] & fs.constants.O_CREAT)) {
      observed++; assert.equal(inspectPending({ roots: f.roots }).length, 2);
      candidates.forEach((input, i) => {
        noMutation(f, () => plan(input), 'PENDING_OPERATION');
        noMutation(f, () => apply(previews[i], options(input)), 'PENDING_OPERATION');
      });
    }
    return original(file, ...args);
  }, () => apply(p, options(f.input)));
  assert.equal(observed, 1); restore(request(p));
});
acceptance('root locks and complete backups precede target directory provisioning and staging', () => {
  const f = fixture(); f.input.entries.unshift(f.entry('old', 'workspace', { baseline: { hash: sha('original'), mode: 0o600 } }));
  fs.writeFileSync(f.target(f.input.entries[0]), 'original', { mode: 0o600 });
  const p = plan(f.input); let checked = 0;
  const check = () => {
    checked++; assert.equal(inspectPending({ roots: f.roots }).length, 2);
    assert.equal(fs.readFileSync(backup(p, 0), 'utf8'), 'original');
    assert.equal(fs.readFileSync(backup(p, 1), 'utf8'), 'absent\n');
  };
  patchFs('mkdirSync', (original, file, ...args) => {
    if (file === path.join(f.roots.workspace, 'new')) check();
    return original(file, ...args);
  }, () => patchFs('openSync', (original, file, ...args) => {
    if (typeof file === 'string' && file.endsWith('-apply.tmp') && (args[0] & fs.constants.O_CREAT)) check();
    return original(file, ...args);
  }, () => apply(p, options(f.input))));
  assert.equal(checked, 3); restore(request(p));
});
acceptance('partial root acquisition remains honestly visible and retained', () => {
  const f = fixture(), p = plan(f.input); let count = 0;
  const before = inventory(f.base, true);
  patchFs('mkdirSync', (original, file, ...args) => {
    if (typeof file === 'string' && file.endsWith('/.aigentry-preservation.lock') && ++count === 2) throw injected();
    return original(file, ...args);
  }, () => refused(() => apply(p, options(f.input)), 'EIO'));
  assert.deepEqual(inventory(f.base, true), before);
  assert.equal(inspectPending({ roots: f.roots }).length, 1);
  assert.equal(receipt(p).phase, 'partial');
  noMutation(f, () => restore(request(p)), 'MISSING_BACKUP');
});
for (const boundary of ['stage open', 'stage fsync', 'second rename']) acceptance(`injected ${boundary} retains originals and recovery evidence`, () => {
  const f = fixture(); f.input.entries.unshift(f.entry('old', 'workspace', { baseline: { hash: sha('original'), mode: 0o600 } }));
  fs.writeFileSync(f.target(f.input.entries[0]), 'original', { mode: 0o600 });
  const p = plan(f.input), before = inventory(f.base); let hit = 0, stageFd;
  const operation = () => refused(() => apply(p, options(f.input)), 'EIO');
  if (boundary === 'stage open') patchFs('openSync', (original, file, ...args) => {
    if (typeof file === 'string' && file.endsWith('-apply.tmp') && ++hit === 1) throw injected();
    return original(file, ...args);
  }, operation);
  if (boundary === 'stage fsync') patchFs('openSync', (original, file, ...args) => {
    const fd = original(file, ...args); if (typeof file === 'string' && file.endsWith('-apply.tmp')) stageFd = fd; return fd;
  }, () => patchFs('fsyncSync', (original, fd) => {
    if (fd === stageFd && ++hit === 1) { stageFd = undefined; throw injected(); } return original(fd);
  }, operation));
  if (boundary === 'second rename') patchFs('renameSync', (original, from, to) => {
    if (String(from).endsWith('-apply.tmp') && ++hit === 2) throw injected(); return original(from, to);
  }, operation);
  assert(hit > 0); assert(before.length > 0); assert.equal(fs.readFileSync(backup(p, 0), 'utf8'), 'original');
  assert.equal(fs.readFileSync(backup(p, 1), 'utf8'), 'absent\n');
  assert.equal(receipt(p).phase, 'partial'); assert.equal(inspectPending({ roots: f.roots }).length, 2);
  if (boundary === 'stage fsync') {
    const snapshot = inventory(f.base, true), durable = fs.readFileSync(receiptPath(p));
    refused(() => restore(request(p)), 'UNVERIFIED_STAGE');
    assert.deepEqual(inventory(f.base, true), snapshot); assert.deepEqual(fs.readFileSync(receiptPath(p)), durable);
    assert.equal(fs.readFileSync(f.target(f.input.entries[0]), 'utf8'), 'original');
  } else {
    assert.equal(restore(request(p)).phase, 'restored');
    assert.equal(fs.readFileSync(f.target(f.input.entries[0]), 'utf8'), 'original');
    assert(!fs.existsSync(path.join(f.roots.workspace, 'new')));
  }
});
for (const boundary of ['mkdir', 'recorded']) acceptance(`crash at ${boundary} durable identity boundary`, () => {
  const f = fixture(), inputPath = path.join(f.roots.backup, 'input.json');
  fs.writeFileSync(inputPath, JSON.stringify({ ...f.input, entries: f.input.entries.map(e => ({ ...e, bytes: e.bytes.toString('base64') })) }), { mode: 0o600 });
  const before = inventory(f.base);
  const child = spawnSync(process.execPath, [self, '--crash-child', inputPath, boundary], { encoding: 'utf8', timeout: 15000 });
  fs.writeFileSync(path.join(f.roots.backup, 'child.json'), JSON.stringify({ status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr }), { mode: 0o600 });
  assert.equal(child.status, 73, child.stderr); assert(before.length > 0);
  const req = JSON.parse(fs.readFileSync(path.join(f.roots.backup, 'request.json'))), durable = receipt(req);
  assert.equal(inspectPending({ roots: f.roots }).length, 2);
  assert(fs.existsSync(path.join(f.roots.workspace, 'new')));
  assert(!fs.existsSync(f.target(f.input.entries[0])));
  assert.equal(durable.directoryProgress[0].state, boundary === 'mkdir' ? 'pending' : 'created');
  assert.equal(durable.directoryProgress[0].identity === null, boundary === 'mkdir');
  noMutation(f, () => restore(req), boundary === 'mkdir' ? 'UNKNOWN_DIRECTORY' : 'EXECUTOR_BLOCKED');
  if (boundary === 'mkdir') noMutation(f, () => inspectOperation(req), 'UNKNOWN_DIRECTORY');
  else assert.equal(inspectOperation(req).executorBlocked, true);
  // Exact child has exited. Explicit fixture recovery removes only its empty executor.
  assert.deepEqual(fs.readdirSync(path.join(opdir(req), 'executor')), []);
  fs.rmdirSync(path.join(opdir(req), 'executor'));
  if (boundary === 'mkdir') noMutation(f, () => restore(req), 'UNKNOWN_DIRECTORY');
  else { assert.equal(restore(req).phase, 'restored'); assert(!fs.existsSync(path.join(f.roots.workspace, 'new'))); }
});

for (const change of ['foreign child', 'changed target', 'directory identity', 'backup', 'checksum', 'foreign stage', 'foreign lock child']) acceptance(`restore preflight refuses ${change} before user files change`, () => {
  const f = fixture(); f.input.entries.unshift(f.entry('old', 'workspace', { baseline: { hash: sha('original'), mode: 0o600 } }));
  fs.writeFileSync(f.target(f.input.entries[0]), 'original', { mode: 0o600 });
  const p = plan(f.input); apply(p, options(f.input));
  const d = path.join(f.roots.workspace, 'new');
  if (change === 'foreign child') fs.writeFileSync(path.join(d, 'foreign'), 'foreign', { mode: 0o600 });
  if (change === 'changed target') fs.writeFileSync(f.target(f.input.entries[1]), 'foreign');
  if (change === 'directory identity') { fs.renameSync(d, path.join(f.roots.workspace, 'retired')); mkdir(d); }
  if (change === 'backup') fs.writeFileSync(backup(p, 0), 'bad');
  if (change === 'checksum') { const e = JSON.parse(fs.readFileSync(receiptPath(p))); e.checksum = '0'.repeat(64); fs.writeFileSync(receiptPath(p), JSON.stringify(e)); }
  if (change === 'foreign stage') fs.writeFileSync(path.join(d, `.aigentry-preservation-${p.operationId}-1-apply.tmp`), 'foreign', { mode: 0o600 });
  if (change === 'foreign lock child') {
    const lock = path.join(f.roots.workspace, '.aigentry-preservation.lock'); mkdir(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ schemaVersion: 1, operationId: p.operationId, planId: p.planId, backupRoot: p.roots.backup }), { mode: 0o600 });
    fs.writeFileSync(path.join(lock, 'foreign'), 'foreign', { mode: 0o600 });
  }
  const before = inventory(f.base), targets = inventory(f.base, true), durable = fs.readFileSync(receiptPath(p));
  refused(() => restore(request(p)));
  assert.deepEqual(inventory(f.base, true), targets); assert.deepEqual(fs.readFileSync(receiptPath(p)), durable);
  // All pre-existing administrative objects survive; recovery may acquire locks.
  const after = inventory(f.base); for (const row of before) assert.deepEqual(after.find(x => x.path === row.path), row);
  assert.equal(fs.readFileSync(f.target(f.input.entries[0]), 'utf8'), 'replacement\n');
});
const corruptions = [
  ['unknown receipt key', r => { r.extra = true; }],
  ['mixed v1 schema', r => { r.schemaVersion = 1; }],
  ['null directory progress', r => { r.directoryProgress = null; }],
  ['short directory progress', r => { r.directoryProgress = []; }],
  ['null progress item', r => { r.directoryProgress[0] = null; }],
  ['unknown progress key', r => { r.directoryProgress[0].extra = true; }],
  ['invalid directory state', r => { r.directoryProgress[0].state = 'adopted'; }],
  ['created missing identity', r => { r.directoryProgress[0].identity = null; }],
  ['pending with identity', r => { r.directoryProgress[0].state = 'pending'; }],
  ['unsafe identity mode', r => { r.directoryProgress[0].identity.mode = 0o777; }],
  ['foreign identity uid', r => { r.directoryProgress[0].identity.uid++; }],
  ['invalid identity inode', r => { r.directoryProgress[0].identity.ino = '-1'; }],
  ['unknown identity key', r => { r.directoryProgress[0].identity.extra = true; }],
  ['short file progress', r => { r.progress = []; }],
  ['invalid file progress', r => { r.progress[0] = 'accepted'; }],
  ['null file postimages', r => { r.postimages = null; }],
  ['written missing postimage', r => { r.postimages[0] = null; }],
  ['null durability warnings', r => { r.durabilityWarnings = null; }],
];
for (const [name, mutate] of corruptions) acceptance(`closed receipt refuses ${name}`, () => {
  const f = fixture(), p = plan(f.input); apply(p, options(f.input));
  const r = receipt(p); mutate(r);
  fs.writeFileSync(receiptPath(p), JSON.stringify({ checksum: sha(canonical(r)), payload: r }));
  noMutation(f, () => inspectOperation(request(p)));
  noMutation(f, () => restore(request(p)));
});

// Recompute both public checksums so these cases exercise stored schema validation,
// rather than stopping at a checksum mismatch. This is not approval authority.
for (const [name, mutate] of [
  ['unknown plan key', p => { p.extra = true; }],
  ['mixed plan version', p => { p.schemaVersion = 1; }],
  ['null directory inventory', p => { p.directories = null; }],
  ['unknown stored directory key', p => { p.directories[0].extra = true; }],
  ['unsafe stored directory mode', p => { p.directories[0].mode = 0o755; }],
  ['missing parent inventory', p => { p.directoryParents = []; }],
  ['wrong root identity', p => { p.directoryRoots.workspace.ino = '0'; }],
  ['file-directory overlap', p => { p.entries[0].path = p.directories[0].path; }],
  ['unknown stored file key', p => { p.entries[0].extra = true; }],
  ['protected stored file', p => { p.entries[0].kind = 'state'; }],
]) acceptance(`stored v2 plan refuses ${name}`, () => {
  const f = fixture(); mkdir(path.join(f.roots.workspace, 'parent'));
  f.input.directories = [f.dir('parent/new')]; f.input.entries = [f.entry('parent/new/out')];
  const p = plan(f.input); apply(p, options(f.input));
  const r = receipt(p); mutate(r.plan);
  const { planId: ignored, ...body } = r.plan;
  r.plan.planId = sha(canonical(body));
  fs.writeFileSync(receiptPath(p), JSON.stringify({ checksum: sha(canonical(r)), payload: r }));
  const req = { ...request(p), planId: r.plan.planId };
  noMutation(f, () => inspectOperation(req)); noMutation(f, () => restore(req));
});
acceptance('ownerless partial root lock is visible and never automatically removed', () => {
  const f = fixture(), p = plan(f.input), before = inventory(f.base, true); let hit = false;
  patchFs('openSync', (original, file, ...args) => {
    if (String(file).endsWith('/.aigentry-preservation.lock/owner.json') && (args[0] & fs.constants.O_CREAT)) { hit = true; throw injected(); }
    return original(file, ...args);
  }, () => refused(() => apply(p, options(f.input)), 'EIO'));
  assert(hit); assert.deepEqual(inventory(f.base, true), before);
  const pending = inspectPending({ roots: f.roots });
  assert.equal(pending.length, 1); assert.equal(pending[0].status, 'blocked'); assert.equal(pending[0].code, 'OWNERLESS_LOCK');
  noMutation(f, () => plan(f.input), 'PENDING_OPERATION');
  noMutation(f, () => restore(request(p)), 'MISSING_BACKUP');
});
for (const target of ['declared', 'undeclared parent', 'root']) acceptance(`restore rejects existing ${target} mode drift`, () => {
  const f = fixture(); mkdir(path.join(f.roots.workspace, 'parent')); mkdir(path.join(f.roots.workspace, 'parent/new'));
  f.input.directories = [f.dir('parent/new')]; f.input.entries = [f.entry('parent/new/out')];
  const p = plan(f.input); apply(p, options(f.input));
  const d = target === 'declared' ? 'parent/new' : target === 'undeclared parent' ? 'parent' : '';
  fs.chmodSync(path.join(f.roots.workspace, d), 0o750);
  noMutation(f, () => restore(request(p)));
});
acceptance('interrupted removal remains unknown and cannot be adopted on repeated restore', () => {
  const f = fixture(), p = plan(f.input); apply(p, options(f.input)); let hit = false;
  const before = inventory(f.base);
  patchFs('rmdirSync', (original, file, ...args) => {
    if (file === path.join(f.roots.workspace, 'new')) { hit = true; throw injected(); }
    return original(file, ...args);
  }, () => refused(() => restore(request(p)), 'EIO'));
  assert(hit); assert(before.length > 0);
  assert.equal(receipt(p).directoryProgress[0].state, 'removing');
  assert.deepEqual(fs.readdirSync(path.join(f.roots.workspace, 'new')), []);
  assert.equal(inspectPending({ roots: f.roots }).length, 2);
  noMutation(f, () => restore(request(p)), 'UNKNOWN_DIRECTORY');
  noMutation(f, () => inspectOperation(request(p)), 'UNKNOWN_DIRECTORY');
});
