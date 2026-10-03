import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConsoleReader, ConsoleError, validateConsoleConfig } from '../../src/hitl/web/console-read-model.js';

async function fixture(t: TestContext, data: unknown, taskIds = ['1', '2', '3']) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'console-read-model-'));
  const queue = join(dir, 'queue.json');
  await writeFile(queue, JSON.stringify(data));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { projects: [{ id: 'p1', taskQueue: queue, taskIds }], grants: [{ principalId: 'alice', projects: ['p1'] }] };
  return { dir, queue, reader: createConsoleReader(config), config };
}

const task = (id: string | number, status: string, extra: Record<string, unknown> = {}) => ({ id, status, updated_at: '2026-09-20T12:00:00Z', ...extra });
const readTasks = (reader: ReturnType<typeof createConsoleReader>, principal = 'alice', project = 'p1', params = '') =>
  reader.read(principal, project, 'tasks', new URLSearchParams(params));
const error = async (promise: Promise<unknown>, status: number, message: string) => {
  await assert.rejects(promise, e => e instanceof ConsoleError && e.status === status && e.message === message);
};

test('config and principal/project membership fail closed', async t => {
  const f = await fixture(t, { tasks: [task('1', 'queued')] }, ['1']);
  assert.deepEqual(f.reader.projects('alice'), ['p1']);
  assert.deepEqual(f.reader.projects('missing'), []);
  await error(readTasks(f.reader, 'missing'), 403, 'forbidden');
  await error(readTasks(f.reader, 'alice', 'other'), 403, 'forbidden');
  assert.throws(() => validateConsoleConfig({ projects: [], grants: [{ principalId: 'alice', projects: ['missing'] }] }), /invalid_console_config/);
  assert.throws(() => validateConsoleConfig({ projects: [{ id: 'p1', taskQueue: '/x', taskIds: ['1', '1'] }], grants: [] }), /invalid_console_config/);
});

test('projection is bounded, redacted, status-exact, ordered, and reports missing/duplicates', async t => {
  const f = await fixture(t, {
    tasks: [
      task('3', 'completed', { title: 'secret title', note: 'secret note', prompt: 'do not leak' }),
      task('1', 'queued'), task('2', 'in_progress'), task('2', 'done'),
      task('hidden', 'queued'), task('bad-status', 'invented'), task(4, 'pending'),
    ], completed: [task('1', 'done')],
  }, ['1', '2', '3', '4']);
  const page = await readTasks(f.reader, 'alice', 'p1', 'limit=100');
  assert.deepEqual(page.items.map(x => x.taskId), ['3', '4']);
  assert.deepEqual(page.items.map(x => x.recordedStatus), ['completed', 'pending']);
  assert.equal(page.coverage, 'partial');
  assert.deepEqual([...page.warnings].sort(), ['conflicting_task_records', 'execution_and_acceptance_not_covered', 'source_observation_time_unknown']);
  for (const row of page.items) {
    assert.equal(row.title, null);
    assert.equal(row.observedAt, null);
    assert.equal(row.attempt, null);
    assert.equal(row.blocker, null);
    assert.equal(row.release, null);
    assert.match(row.reasons.join('|'), /recorded_status_only/);
    assert.doesNotMatch(JSON.stringify(row), /secret title|secret note|do not leak/);
  }
  await error(readTasks(f.reader, 'alice', 'p1', 'status=not-a-status'), 400, 'invalid_query');
  await error(readTasks(f.reader, 'alice', 'p1', 'q=../escape'), 400, 'invalid_query');
});

test('pagination cursor is signed, scoped, snapshot-bound, and bounded', async t => {
  const f = await fixture(t, { tasks: ['a', 'b', 'c', 'd'].map(id => task(id, 'queued')) }, ['a', 'b', 'c', 'd']);
  const first = await readTasks(f.reader, 'alice', 'p1', 'limit=2');
  assert.deepEqual(first.items.map(x => x.taskId), ['a', 'b']);
  assert.ok(first.nextCursor);
  const second = await readTasks(f.reader, 'alice', 'p1', `limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`);
  assert.deepEqual(second.items.map(x => x.taskId), ['c', 'd']);
  const [payload, signature] = first.nextCursor!.split('.');
  // Mutate signature BYTES, not its spelling: the final base64url character of a 32-byte HMAC
  // carries two padding bits, so editing it can leave the decoded signature identical.
  const raw = Buffer.from(signature!, 'base64url');
  assert.equal(raw.length, 32);
  raw[0]! ^= 1;
  const flip = `${payload}.${raw.toString('base64url')}`;
  await error(readTasks(f.reader, 'alice', 'p1', `limit=2&cursor=${encodeURIComponent(flip)}`), 400, 'invalid_cursor');
  await error(readTasks(f.reader, 'alice', 'p1', `limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`), 400, 'invalid_cursor');
  await error(readTasks(f.reader, 'alice', 'p1', `status=done&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`), 400, 'invalid_cursor');
  await error(readTasks(f.reader, 'alice', 'p1', 'limit=0'), 400, 'invalid_query');
  await error(readTasks(f.reader, 'alice', 'p1', 'limit=101'), 400, 'invalid_query');
  // Control: for every canonical 43-char spelling (final char index a multiple of 4), the byte
  // mutation above always changes the decoded 32 bytes and stays canonical base64url.
  const tails = [...'AEIMQUYcgkosw048'];
  assert.equal(new Set(tails).size, 16);
  for (const tail of tails) {
    const bytes = Buffer.from(`${'A'.repeat(42)}${tail}`, 'base64url');
    assert.equal(bytes.length, 32);
    const mutated = Buffer.from(bytes);
    mutated[0]! ^= 1;
    const spelling = mutated.toString('base64url');
    assert.equal(spelling.length, 43);
    assert.equal(spelling.at(-1), tail);
    assert.notEqual(Buffer.compare(Buffer.from(spelling, 'base64url'), bytes), 0);
  }
  // Witness for the old text flip: 'A' and 'B' in the final position are base64url aliases.
  assert.equal(Buffer.compare(Buffer.from('A'.repeat(43), 'base64url'), Buffer.from(`${'A'.repeat(42)}B`, 'base64url')), 0);
});

test('malformed, oversize, and unavailable sources are deterministic and non-leaking', async t => {
  const f = await fixture(t, { tasks: [task('1', 'queued')] }, ['1']);
  await writeFile(f.queue, '{"tasks":[}');
  const unavailable = await readTasks(f.reader);
  assert.equal(unavailable.coverage, 'unavailable');
  assert.equal(unavailable.total, null);
  assert.deepEqual(unavailable.items, []);
  assert.deepEqual(unavailable.warnings, ['task_queue_unavailable', 'source_observation_time_unknown', 'execution_and_acceptance_not_covered']);
  await error(f.reader.read('alice', 'p1', 'tasks', new URLSearchParams(), '1'), 503, 'source_unavailable');
  await writeFile(f.queue, 'x'.repeat(4 * 1024 * 1024 + 1));
  const oversized = await readTasks(createConsoleReader(f.config));
  assert.equal(oversized.coverage, 'unavailable');
  assert.equal(oversized.total, null);
});

test('refresh coalesces and reads do not mutate the source', async t => {
  const f = await fixture(t, { tasks: [task('1', 'queued')] }, ['1']);
  const before = await readFile(f.queue, 'utf8');
  const pages = await Promise.all(Array.from({ length: 8 }, () => readTasks(f.reader)));
  assert.ok(pages.every(page => page.fetchedAt === pages[0]!.fetchedAt));
  assert.ok(pages.every(page => page.projectionRevision === pages[0]!.projectionRevision));
  assert.equal(await readFile(f.queue, 'utf8'), before);
});

test('non-task views and unknown task details remain explicit unavailable contracts', async t => {
  const f = await fixture(t, { tasks: [task('1', 'queued')] }, ['1']);
  for (const view of ['requests', 'releases', 'approvals', 'evidence'] as const) {
    const page = await f.reader.read('alice', 'p1', view, new URLSearchParams());
    assert.equal(page.coverage, 'unavailable');
    assert.equal(page.items.length, 0);
    assert.match(page.warnings[0]!, /contract_unavailable|legacy_unbound/);
  }
  await error(f.reader.read('alice', 'p1', 'tasks', new URLSearchParams(), 'missing'), 404, 'not_found');
});
