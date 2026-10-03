import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { readRequests, validId, type View } from '../../src/hitl/web/read-model.js';

// Mirrors cmdOpen/cmdDecide's persisted schema without invoking their transport.
function record(source = 'test', kind = 'decision', question = '계속?') {
  const key = createHash('sha256').update(`${source}|${kind}|${question}`).digest('hex').slice(0, 12);
  return { id: `${kind}-${source}-${key}`, dedupe_key: key, source, kind, question,
    subject_sid: null, resume: 'none', options: ['approve', 'reject'], context_ref: null,
    prev_status: null, created_at: '2026-09-16T00:00:00Z', notified_at: null,
    last_reminded_at: null, status: 'pending', decision: null, decided_at: null };
}
async function fixture(t: TestContext) {
  // /var and /tmp may be symlinks on macOS; configured parents must be physical.
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hitl-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'pending'));
  await mkdir(join(root, 'decided'));
  return root;
}
async function put(root: string, row: ReturnType<typeof record>, patch: Record<string, unknown> = {}, view: View = 'pending') {
  const file = join(root, view === 'pending' ? 'pending' : 'decided', `${row.id}.json`);
  await writeFile(file, JSON.stringify({ ...row, ...patch }));
  return file;
}
const empty = { items: [], warnings: [], nextCursor: null };
async function corrupt(root: string, view: View = 'pending') {
  assert.deepEqual(await readRequests(root, view, 100), { ...empty, warnings: ['record_corrupt_or_unavailable'] });
}

test('producer-shaped pending and approved/rejected history, Unicode and legacy projection', async t => {
  const root = await fixture(t);
  for (const kind of ['decision', 'destructive', 'info']) {
    const row = record(`s._-${kind}`, kind);
    await put(root, row, { subject_sid: 'worker' });
    for (const decision of ['approve', 'reject']) {
      const done = record(`${kind}-${decision}`, kind);
      await put(root, done, { status: decision === 'approve' ? 'approved' : 'rejected', decision,
        decided_at: '2026-09-16T01:00:00Z', note: 'done', resume_error: '' }, 'history');
    }
  }
  const pending = await readRequests(root, 'pending', 100);
  assert.equal(pending.items.length, 3);
  assert.deepEqual(pending.warnings, []);
  for (const item of pending.items) assert.deepEqual(item, {
    id: item.id, question: '계속?', subjectSid: 'worker', createdAt: '2026-09-16T00:00:00Z',
    state: 'pending', decision: null, decidedAt: null, binding: 'legacy_unbound', task: null, purpose: null, scope: null,
  });
  const history = await readRequests(root, 'history', 100);
  assert.equal(history.items.length, 6);
  assert.deepEqual(history.warnings, []);
  assert.equal(history.items.filter(row => row.state === 'approved' && row.decision === 'approve').length, 3);
  assert.equal(history.items.filter(row => row.state === 'rejected' && row.decision === 'reject').length, 3);
});

test('empty and missing directories are distinct from unavailable sources', async t => {
  const root = await fixture(t);
  for (const view of ['pending', 'history'] as const) assert.deepEqual(await readRequests(root, view, 1), empty);
  assert.deepEqual(await readRequests(join(root, 'missing'), 'pending', 1), empty);
  await rm(join(root, 'pending'), { recursive: true });
  await writeFile(join(root, 'pending'), 'not a directory');
  assert.deepEqual(await readRequests(root, 'pending', 1), { ...empty, warnings: ['source_unavailable'] });
});

test('validId grammar, traversal and exact length boundary', () => {
  for (const kind of ['info', 'decision', 'destructive']) assert.equal(validId(record('a._-Z9', kind).id), true);
  const max = `info-${'a'.repeat(222)}-012345abcdef`;
  assert.equal(max.length, 240);
  assert.equal(validId(max), true);
  for (const id of [max + 'a', '', '../' + record().id, record().id + '\n', 'info-a-ABCDEF012345',
    'info-a-012345abcde', 'info--012345abcdef', 'other-a-012345abcdef', 'info-a/b-012345abcdef']) {
    assert.equal(validId(id), false, JSON.stringify(id));
  }
});

test('invalid view/root/limit/cursor reject before filesystem access', async () => {
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity]) await assert.rejects(readRequests('/missing', 'pending', limit), /invalid_query/);
  await assert.rejects(readRequests('relative', 'pending', 1), /invalid_query/);
  await assert.rejects(readRequests('/missing', 'decided' as View, 1), /invalid_query/);
  for (const cursor of ['', '../escape', 'x'.repeat(241)]) await assert.rejects(readRequests('/missing', 'pending', 1, cursor), /invalid_query/);
});

test('schema, identity, hash and pending/history state mismatches', async t => {
  const patches: Record<string, unknown>[] = [
    { id: record('other').id }, { source: 'other' }, { source: '../bad' }, { kind: 'info' },
    { kind: 'other' }, { question: 'changed' }, { question: '' }, { question: 1 },
    { dedupe_key: '000000000000' }, { created_at: 'bad-date' }, { created_at: null },
    { subject_sid: 1 }, { context_ref: {} }, { options: 'approve' }, { options: [1] },
    { status: 'approved' }, { decision: 'approve' }, { decided_at: '2026-09-16T01:00:00Z' },
    { subject_sid: undefined }, { context_ref: undefined }, { options: undefined },
  ];
  for (const patch of patches) await t.test(JSON.stringify(patch) || 'missing field', async st => {
    const root = await fixture(st);
    await put(root, record(), patch);
    await corrupt(root);
  });
  for (const patch of [{}, { status: 'approved', decision: 'reject' }, { status: 'rejected', decision: 'approve' },
    { status: 'approved', decision: 'approve', decided_at: 'bad' },
    { status: 'approved', decision: 'approve', decided_at: null }]) await t.test(`history ${JSON.stringify(patch)}`, async st => {
    const root = await fixture(st);
    await put(root, record(), patch, 'history');
    await corrupt(root, 'history');
  });
});

test('malformed JSON and duplicate keys including escaped and nested keys', async t => {
  const row = record();
  const base = JSON.stringify(row);
  const cases = ['{', 'null', '[]', '42', base + '{}',
    base.replace('{', '{"status":"pending",'), base.replace('{', '{"sta\\u0074us":"pending",'),
    base.replace('{', '{"extra":{"a":1,"\\u0061":2},'),
    base.replace('{', '{"extra":[{"a":1,"a":1}],')];
  for (const [i, raw] of cases.entries()) await t.test(`raw case ${i}`, async st => {
    const root = await fixture(st);
    await writeFile(join(root, 'pending', `${row.id}.json`), raw);
    await corrupt(root);
  });
  const root = await fixture(t);
  await put(root, row, { extra: [{ a: 1 }, { a: 2 }], text: '\"x\":{}[]' });
  assert.equal((await readRequests(root, 'pending', 1)).items.length, 1);
});

test('64 KiB byte boundary and 64-container depth boundary', async t => {
  for (const size of [65536, 65537]) await t.test(`bytes ${size}`, async st => {
    const root = await fixture(st);
    const row = record();
    const base = JSON.stringify({ ...row, padding: '' });
    const raw = JSON.stringify({ ...row, padding: 'x'.repeat(size - Buffer.byteLength(base)) });
    assert.equal(Buffer.byteLength(raw), size);
    await writeFile(join(root, 'pending', `${row.id}.json`), raw);
    if (size === 65536) assert.equal((await readRequests(root, 'pending', 1)).items.length, 1);
    else await corrupt(root);
  });
  for (const depth of [64, 65]) await t.test(`depth ${depth}`, async st => {
    const root = await fixture(st);
    let extra: unknown = 0;
    for (let i = 1; i < depth; i++) extra = [extra];
    await put(root, record(), { extra });
    if (depth === 64) assert.equal((await readRequests(root, 'pending', 1)).items.length, 1);
    else await corrupt(root);
  });
});

test('lexical pagination is exclusive, bounded and complete on a stable directory', async t => {
  const root = await fixture(t);
  const ids: string[] = [];
  for (let i = 0; i < 105; i++) { const row = record(`s${i}`); ids.push(row.id); await put(root, row); }
  ids.sort();
  const first = await readRequests(root, 'pending', 100);
  assert.deepEqual(first.items.map(row => row.id), ids.slice(0, 100));
  assert.equal(first.nextCursor, ids[99]);
  const last = await readRequests(root, 'pending', 100, first.nextCursor);
  assert.deepEqual(last.items.map(row => row.id), ids.slice(100));
  assert.equal(last.nextCursor, null);
  const one = await readRequests(root, 'pending', 1);
  assert.equal(one.nextCursor, ids[0]);
  assert.deepEqual(await readRequests(root, 'pending', 100, ids.at(-1)!), empty);
});

test('directory-entry bound includes invalid entries; warnings are deduplicated', async t => {
  const root = await fixture(t);
  for (let i = 0; i < 1000; i++) await writeFile(join(root, 'pending', `invalid-${i}`), '');
  assert.deepEqual(await readRequests(root, 'pending', 100), { ...empty, warnings: ['source_unavailable'] });
  await writeFile(join(root, 'pending', 'invalid-1000'), '');
  const page = await readRequests(root, 'pending', 100);
  assert.deepEqual(page.items, []);
  assert.deepEqual(new Set(page.warnings), new Set(['source_unavailable', 'file_limit']));
});

test('symlink files, dangling links, directories and symlink parents are refused', { skip: process.platform === 'win32' ? 'native Windows link privileges not measured' : false }, async t => {
  const root = await fixture(t);
  const target = await put(root, record(), {}, 'history');
  await symlink(target, join(root, 'pending', `${record().id}.json`));
  await symlink(join(root, 'missing'), join(root, 'pending', `${record('dangling').id}.json`));
  await mkdir(join(root, 'pending', `${record('directory').id}.json`));
  assert.deepEqual(await readRequests(root, 'pending', 100), { ...empty, warnings: ['source_unavailable'] });
  await symlink(root, join(root, 'alias'));
  assert.deepEqual(await readRequests(join(root, 'alias'), 'pending', 100), { ...empty, warnings: ['source_unavailable'] });
  await rm(join(root, 'pending'), { recursive: true });
  await symlink(join(root, 'decided'), join(root, 'pending'));
  assert.deepEqual(await readRequests(root, 'pending', 100), { ...empty, warnings: ['source_unavailable'] });
});

test('FIFO source refusal and context_ref FIFO is never opened', { skip: process.platform === 'win32' ? 'native Windows has no POSIX mkfifo' : false, timeout: 5000 }, async t => {
  const root = await fixture(t);
  const fifo = join(root, 'evidence-fifo');
  const result = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.error ?? ''} ${result.stderr}`);
  const row = record();
  await put(root, row, { context_ref: fifo });
  assert.equal((await readRequests(root, 'pending', 100)).items.length, 1);
  const sourceFifo = join(root, 'pending', `${record('fifo').id}.json`);
  assert.equal(spawnSync('mkfifo', [sourceFifo]).status, 0);
  const page = await readRequests(root, 'pending', 100);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.warnings, ['source_unavailable']);
  assert.equal((await lstat(fifo)).isFIFO(), true);
});

test('unreadable record produces a warning when native permissions are enforced', { skip: process.platform === 'win32' ? 'POSIX permissions unavailable on native Windows' : false }, async t => {
  const root = await fixture(t);
  const file = await put(root, record());
  await chmod(file, 0);
  t.after(() => chmod(file, 0o600).catch(() => {}));
  try { await readFile(file); t.skip('current identity bypasses mode-000 permissions'); return; } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'EACCES');
  }
  await corrupt(root);
});

test('source/evidence bytes, metadata and directory entries remain unchanged', async t => {
  const root = await fixture(t);
  const evidence = join(root, 'evidence.txt');
  await writeFile(evidence, 'private context');
  const pending = await put(root, record(), { context_ref: evidence });
  const history = await put(root, record('done'), { status: 'approved', decision: 'approve', decided_at: '2026-09-16T01:00:00Z' }, 'history');
  const snapshot = async () => Promise.all([pending, history, evidence].map(async file => {
    const stat = await lstat(file);
    return { file, bytes: await readFile(file, 'hex'), ino: stat.ino, size: stat.size, mode: stat.mode, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
  }));
  const entries = async () => Promise.all([root, join(root, 'pending'), join(root, 'decided')].map(async dir => (await readdir(dir)).sort()));
  const before = await snapshot();
  const names = await entries();
  await readRequests(root, 'pending', 100);
  await readRequests(root, 'history', 100);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await entries(), names);
});
