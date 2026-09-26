import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

// This computed URL deliberately allows compilation before the product exists.
// Missing product code is a test failure, never a skip or a product mock.
const moduleUrl = new URL('../../src/request-capture/receipt.js', import.meta.url);
type Receipt = {
  schema_version: 1; capture_id: string; byte_len: number; sha256: string;
  original_ref: string; channel: 'codex-native'; upstream_namespace: 'codex/session';
  upstream_delivery_id: null; received_at: string; provenance: 'unverified';
  task_binding: 'pending'; durability: 'file-and-directory-fsync' | 'file-fsync-only';
  metadata: Record<'session_id' | 'turn_id' | 'hook_event_name' | 'model', string | null>;
};
type Capture = (raw: Uint8Array, options: { root: string }) => Promise<Receipt>;
const nullMetadata: Receipt['metadata'] = {
  session_id: null, turn_id: null, hook_event_name: null, model: null,
};
const digest = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex');
const fixtureRuns = new Map<string, Run[]>();

async function product(): Promise<Capture> {
  const loaded = await import(moduleUrl.href) as { captureSubmittedPrompt?: Capture };
  assert.equal(typeof loaded.captureSubmittedPrompt, 'function');
  return loaded.captureSubmittedPrompt!;
}

async function fixture(t: TestContext): Promise<{ base: string; root: string }> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'capture-receipt-test-'));
  fixtureRuns.set(base, []);
  const root = path.join(base, 'store');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.writeFile(path.join(base, 'unrelated-sentinel'), 'leave me alone');
  await fs.writeFile(path.join(root, 'unrelated-sentinel'), 'leave me alone');
  t.after(async () => {
    for (const run of fixtureRuns.get(base) ?? []) {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL');
      await run.done;
    }
    try { await sentinels(base, root); }
    finally {
      fixtureRuns.delete(base);
      await fs.rm(base, { recursive: true, force: true });
    }
  });
  return { base, root };
}

async function sentinels(base: string, root: string): Promise<void> {
  for (const directory of [base, root]) {
    assert.equal(await fs.readFile(path.join(directory, 'unrelated-sentinel'), 'utf8'), 'leave me alone');
  }
}

async function accepted(root: string): Promise<string[]> {
  try { return (await fs.readdir(path.join(root, 'receipts'))).filter(n => n.endsWith('.json')).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function checkReceipt(root: string, raw: Uint8Array, receipt: Receipt): Promise<void> {
  assert.equal(receipt.schema_version, 1);
  assert.match(receipt.capture_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(receipt.byte_len, raw.byteLength);
  assert.equal(receipt.sha256, digest(raw));
  assert.equal(receipt.original_ref, `raw/${digest(raw)}.bin`);
  assert.equal(receipt.channel, 'codex-native');
  assert.equal(receipt.upstream_namespace, 'codex/session');
  assert.equal(receipt.upstream_delivery_id, null);
  assert.equal(receipt.provenance, 'unverified');
  assert.equal(receipt.task_binding, 'pending');
  assert.equal(new Date(receipt.received_at).toISOString(), receipt.received_at);
  assert.deepEqual(await fs.readFile(path.join(root, receipt.original_ref)), Buffer.from(raw));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'receipts', `${receipt.capture_id}.json`), 'utf8')), receipt);
  assert.deepEqual(Object.keys(receipt.metadata).sort(), Object.keys(nullMetadata).sort());
  assert.equal(receipt.durability, process.platform === 'win32' ? 'file-fsync-only' : 'file-and-directory-fsync');
}

// Instrument the real fs boundary in an isolated child before importing the
// actual exported function. These are injected failures, not OS durability proof.
const preload = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const mode = process.argv[5];
const root = path.resolve(process.argv[3]);
const descriptors = new Map();
const renamed = new Set();
const originalStat = fs.fstatSync;
const originalRead = fs.readFileSync;
const originalReaddir = fs.readdirSync;
let fired = false;
const send = message => { if (process.send) process.send(message); };
function area(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) return '';
  const relative = path.relative(root, String(value));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.split(path.sep)[0];
}
function hit(operation, value, fd) {
  const section = area(value);
  if (mode === 'crash-before-receipt' && section === 'receipts' && ['open', 'write', 'rename'].includes(operation)) {
    if (!fired) {
      fired = true;
      const blobs = originalReaddir(path.join(root, 'raw')).filter(n => n.endsWith('.bin'));
      send({ type: 'barrier', blobs: blobs.map(name => ({ name, bytes: originalRead(path.join(root, 'raw', name)).toString('base64') })) });
    }
    // Synchronous and asynchronous fs entry points both stop before mutating a receipt.
    return 'barrier';
  }
  let matches = (mode.startsWith('blob-write') && section === 'raw' && ['open', 'write'].includes(operation))
    || (mode.startsWith('receipt-write') && section === 'receipts' && ['open', 'write'].includes(operation))
    || (mode === 'blob-rename' && section === 'raw' && operation === 'rename')
    || (mode === 'receipt-rename' && section === 'receipts' && operation === 'rename')
    || (mode === 'lock-release' && operation === 'unlink' && section !== '' && String(value).endsWith('.lock'));
  if (operation === 'sync') {
    const isDirectory = originalStat(fd).isDirectory();
    matches ||= mode === 'file-fsync' && !isDirectory;
    matches ||= mode === 'directory-fsync' && isDirectory;
    matches ||= mode === 'blob-file-fsync' && section === 'raw' && !isDirectory;
    matches ||= mode === 'receipt-file-fsync' && section === 'receipts' && !isDirectory;
    matches ||= mode === 'blob-directory-fsync' && section === 'raw' && isDirectory && renamed.has('raw');
    matches ||= mode === 'receipt-directory-fsync' && section === 'receipts' && isDirectory && renamed.has('receipts');
  }
  if (matches) {
    fired = true;
    send({ type: 'fault', mode, operation, section, renamed: [...renamed] });
    const error = new Error('injected capture persistence failure');
    error.code = mode.endsWith('-enospc') ? 'ENOSPC' : mode.endsWith('-eacces') ? 'EACCES' : 'EIO';
    throw error;
  }
}
function stopSync() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
function check(operation, value, fd) { if (hit(operation, value, fd) === 'barrier') stopSync(); }
const openSync = fs.openSync;
fs.openSync = function(value, flags, ...rest) {
  if (typeof flags === 'string' && /[wa+]/.test(flags)) check('open', value);
  const fd = openSync.call(this, value, flags, ...rest);
  descriptors.set(fd, value); return fd;
};
for (const [name, operation] of [['writeFileSync', 'write'], ['appendFileSync', 'write'], ['writeSync', 'write'], ['renameSync', 'rename'], ['unlinkSync', 'unlink']]) {
  const original = fs[name];
  fs[name] = function(value, ...rest) {
    check(operation, operation === 'rename' ? rest[0] : (typeof value === 'number' ? descriptors.get(value) : value));
    const result = original.call(this, value, ...rest);
    if (operation === 'rename') renamed.add(area(rest[0]));
    return result;
  };
}
for (const name of ['fsyncSync', 'fdatasyncSync']) {
  const original = fs[name];
  fs[name] = function(fd) { check('sync', descriptors.get(fd), fd); return original.call(this, fd); };
}
const open = fs.open;
fs.open = function(value, flags, ...rest) {
  const callback = rest.pop();
  try { if (typeof flags === 'string' && /[wa+]/.test(flags)) check('open', value); }
  catch (error) { return queueMicrotask(() => callback(error)); }
  return open.call(this, value, flags, ...rest, (error, fd) => {
    if (!error) descriptors.set(fd, value); callback(error, fd);
  });
};
for (const [name, operation] of [['writeFile', 'write'], ['appendFile', 'write'], ['write', 'write'], ['rename', 'rename'], ['unlink', 'unlink'], ['fsync', 'sync'], ['fdatasync', 'sync']]) {
  const original = fs[name];
  fs[name] = function(value, ...rest) {
    const callback = rest.pop();
    try { check(operation, operation === 'rename' ? rest[0] : (typeof value === 'number' ? descriptors.get(value) : value), typeof value === 'number' ? value : undefined); }
    catch (error) { return queueMicrotask(() => callback(error)); }
    return original.call(this, value, ...rest, (error, ...values) => {
      if (!error && operation === 'rename') renamed.add(area(rest[0]));
      callback(error, ...values);
    });
  };
}
const promises = fs.promises;
const promiseOpen = promises.open;
let handleSequence = 0;
const reuseProbe = mode.startsWith('reuse:');
const [, faultKind, faultOperation, faultCode] = mode.split(':');
function reuseKind(value) {
  const relative = path.relative(root, String(value));
  if (relative === 'store.json') return 'marker';
  if (relative === path.join('raw', require('node:crypto').createHash('sha256')
    .update(Buffer.from(process.argv[4], 'base64')).digest('hex') + '.bin')) return 'blob';
  return 'other';
}
function reuseFault(kind, operation) {
  if (reuseProbe && kind === faultKind && operation === faultOperation) {
    send({ type: 'reuse-fault', kind, operation, code: faultCode });
    const error = new Error('REUSE_FAULT_SECRET');
    error.code = faultCode;
    throw error;
  }
}
promises.open = async function(value, flags, ...rest) {
  const kind = reuseProbe ? reuseKind(value) : 'other';
  const id = ++handleSequence;
  if (reuseProbe) send({ type: 'reuse-operation', kind, id, operation: 'open', flags, phase: 'start' });
  reuseFault(kind, 'open');
  if (typeof flags === 'string' && /[wa+]/.test(flags)) check('open', value);
  let handle;
  try { handle = await promiseOpen.call(this, value, flags, ...rest); }
  catch (error) {
    if (reuseProbe) send({ type: 'reuse-operation', kind, id, operation: 'open', flags, phase: 'error', code: error.code });
    throw error;
  }
  if (reuseProbe) send({ type: 'reuse-operation', kind, id, operation: 'open', flags, phase: 'done' });
  descriptors.set(handle.fd, value);
  for (const name of ['sync', 'datasync', 'write', 'writeFile']) {
    const original = handle[name];
    handle[name] = function(...args) {
      check(name === 'sync' || name === 'datasync' ? 'sync' : 'write', value, handle.fd);
      return original.apply(this, args);
    };
  }
  if (reuseProbe) {
    for (const operation of ['stat', 'readFile', 'sync', 'datasync', 'write', 'writeFile', 'writev', 'appendFile', 'truncate', 'chmod', 'chown', 'close']) {
      const original = handle[operation];
      handle[operation] = async function(...args) {
        send({ type: 'reuse-operation', kind, id, operation, phase: 'start' });
        reuseFault(kind, operation);
        try {
          const result = await original.apply(this, args);
          send({ type: 'reuse-operation', kind, id, operation, phase: 'done' });
          return result;
        } catch (error) {
          send({ type: 'reuse-operation', kind, id, operation, phase: 'error', code: error.code });
          throw error;
        }
      };
    }
  }
  return handle;
};
for (const [name, operation] of [['writeFile', 'write'], ['appendFile', 'write'], ['rename', 'rename'], ['unlink', 'unlink']]) {
  const original = promises[name];
  promises[name] = async function(value, ...rest) {
    check(operation, operation === 'rename' ? rest[0] : value);
    const result = await original.call(this, value, ...rest);
    if (operation === 'rename') renamed.add(area(rest[0]));
    return result;
  };
}
if (mode === 'windows-metadata') Object.defineProperty(process, 'platform', { value: 'win32' });
if (mode.startsWith('collision:')) require('node:crypto').randomUUID = () => mode.slice('collision:'.length);
syncBuiltinESMExports();
`;

const worker = String.raw`
const [moduleUrl, root, raw, mode] = process.argv.slice(2);
if (mode === 'concurrent') {
  process.send({ type: 'ready' });
  await new Promise(resolve => process.once('message', resolve));
}
try {
  const { captureSubmittedPrompt } = await import(moduleUrl);
  const receipt = await captureSubmittedPrompt(Buffer.from(raw, 'base64'), { root });
  process.send({ type: 'result', ok: true, receipt });
} catch (error) {
  process.send({ type: 'result', ok: false, error: String(error), code: error.code });
  process.exitCode = 23;
}
process.disconnect();
`;

type Message = { type: string; ok?: boolean; receipt?: Receipt; error?: string; operation?: string;
  kind?: string; id?: number; flags?: number | string; phase?: string; code?: string;
  section?: string; renamed?: string[]; blobs?: { name: string; bytes: string }[] };
type Run = {
  child: ChildProcess; messages: Message[];
  waitFor: (type: string) => Promise<Message>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
};

async function childRun(t: TestContext, base: string, root: string, raw: Uint8Array, mode = 'normal'): Promise<Run> {
  const directory = await fs.mkdtemp(path.join(base, 'worker-'));
  const workerPath = path.join(directory, 'worker.mjs');
  const preloadPath = path.join(directory, 'preload.cjs');
  await fs.writeFile(workerPath, worker);
  await fs.writeFile(preloadPath, preload);
  const child = fork(workerPath, [moduleUrl.href, root, Buffer.from(raw).toString('base64'), mode], {
    execPath: process.execPath, execArgv: ['--require', preloadPath], silent: true,
    env: { TMPDIR: base, TEMP: base, TMP: base },
  });
  const messages: Message[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.on('message', message => { messages.push(message as Message); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 20_000);
  done.finally(() => clearTimeout(timer)).catch(() => {});
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
  });
  const waitFor = async (type: string): Promise<Message> => {
    const seen = messages.find(message => message.type === type);
    if (seen) return seen;
    return new Promise((resolve, reject) => {
      const listener = (message: unknown): void => {
        if ((message as Message).type === type) { child.off('message', listener); resolve(message as Message); }
      };
      child.on('message', listener);
      void done.then(result => {
        child.off('message', listener);
        reject(new Error(`child exited before ${type}: ${JSON.stringify(result)}; ${JSON.stringify(messages)}`));
      }, reject);
    });
  };
  const run = { child, messages, waitFor, done };
  fixtureRuns.get(base)!.push(run);
  return run;
}

test('actual capture module exports the reviewed function', async () => { await product(); });

const byteCases: [string, Buffer][] = [
  ['Unicode and CRLF', Buffer.from('한글 😀 e\u0301\r\nsecond line\r\n')],
  ['NUL', Buffer.from('a\0b\0')],
  ['all binary octets', Buffer.from(Array.from({ length: 256 }, (_, i) => i))],
  ['invalid JSON', Buffer.from('{"prompt": malformed SECRET_RAW_ONLY')],
  ['more than 64 KiB', Buffer.from('장문\r\n'.repeat(20_000))],
  ['empty input', Buffer.alloc(0)],
];
for (const [name, raw] of byteCases) {
  test(`raw fidelity: ${name}`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    const receipt = await capture(raw, { root });
    await checkReceipt(root, raw, receipt);
    assert.deepEqual(receipt.metadata, nullMetadata);
    await sentinels(base, root);
  });
}

test('typed metadata cannot import embedded authority, tasks, or referenced files', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const secretPath = path.join(base, 'never-read');
  await fs.writeFile(secretPath, 'FILE_SECRET_MUST_NOT_BE_IMPORTED');
  const raw = Buffer.from(JSON.stringify({ session_id: 's', turn_id: 't', hook_event_name: 'UserPromptSubmit', model: 'm',
    prompt: 'PROMPT_MUST_NOT_BE_DUPLICATED', human: true, verified: true, approval: 'approved', task_binding: 'bound',
    task_id: 1166, transcript_path: secretPath, root: base, provenance: 'human' }));
  const receipt = await capture(raw, { root });
  await checkReceipt(root, raw, receipt);
  assert.deepEqual(receipt.metadata, { session_id: 's', turn_id: 't', hook_event_name: 'UserPromptSubmit', model: 'm' });
  assert.deepEqual(Object.keys(receipt).sort(), ['schema_version', 'capture_id', 'byte_len', 'sha256', 'original_ref', 'channel',
    'upstream_namespace', 'upstream_delivery_id', 'received_at', 'provenance', 'task_binding', 'metadata', 'durability'].sort());
  assert.doesNotMatch(JSON.stringify(receipt), /PROMPT_MUST_NOT_BE_DUPLICATED|FILE_SECRET_MUST_NOT_BE_IMPORTED|approved/);
  assert.equal(await fs.readFile(secretPath, 'utf8'), 'FILE_SECRET_MUST_NOT_BE_IMPORTED');
  assert.equal((await fs.readdir(base)).includes('raw'), false);
  await sentinels(base, root);
});

for (const value of [null, [], 42, 'text', { session_id: 7, turn_id: false, hook_event_name: [], model: {} },
  { session_id: 'valid', turn_id: 9, hook_event_name: null, model: 'model' }]) {
  test(`metadata typing: ${JSON.stringify(value)}`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    const raw = Buffer.from(JSON.stringify(value));
    const receipt = await capture(raw, { root });
    await checkReceipt(root, raw, receipt);
    assert.deepEqual(receipt.metadata, value && !Array.isArray(value) && typeof value === 'object' && value.session_id === 'valid'
      ? { ...nullMetadata, session_id: 'valid', model: 'model' } : nullMetadata);
    await sentinels(base, root);
  });
}

test('same bytes and Codex turn retain distinct request identities', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const raw = Buffer.from('{"session_id":"same","turn_id":"same","prompt":"same"}');
  const first = await capture(raw, { root });
  const second = await capture(raw, { root });
  assert.notEqual(first.capture_id, second.capture_id);
  assert.equal(first.original_ref, second.original_ref);
  await checkReceipt(root, raw, first);
  await checkReceipt(root, raw, second);
  assert.equal((await accepted(root)).length, 2);
  await sentinels(base, root);
});

async function reuseSnapshot(root: string, prior: Receipt): Promise<Map<string, Buffer>> {
  const names = ['store.json', prior.original_ref,
    ...(await accepted(root)).map(name => `receipts/${name}`)];
  return new Map(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(root, name))] as const)));
}

async function checkReusePreserved(root: string, snapshot: Map<string, Buffer>, run: Run): Promise<void> {
  for (const [name, bytes] of snapshot) assert.deepEqual(await fs.readFile(path.join(root, name)), bytes, name);
  await assert.rejects(fs.lstat(path.join(root, 'store.json.lock')), { code: 'ENOENT' });
  const operations = run.messages.filter(message => message.type === 'reuse-operation');
  const opened = operations.filter(message => message.operation === 'open' && message.phase === 'done');
  const closed = operations.filter(message => message.operation === 'close' && message.phase === 'done');
  assert.deepEqual(closed.map(message => message.id).sort(), opened.map(message => message.id).sort(), 'all opened handles closed');
  for (const kind of ['marker', 'blob']) {
    const events = operations.filter(message => message.kind === kind);
    assert.equal(events.some(message => ['write', 'writeFile', 'writev', 'appendFile', 'truncate', 'chmod', 'chown'].includes(message.operation!)), false);
    for (const event of events.filter(message => message.operation === 'open')) {
      assert.equal(event.flags, process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY | constants.O_NOFOLLOW);
    }
  }
}

test('existing marker and reused blob flush through the same checked handle without mutation', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const raw = Buffer.from('reused binary evidence\0\xff\r\n');
  const prior = await capture(raw, { root });
  const snapshot = await reuseSnapshot(root, prior);
  const ids = new Set([prior.capture_id]);
  for (let repeat = 0; repeat < 2; repeat++) {
    const run = await childRun(t, base, root, raw, 'reuse:observe');
    const result = await run.waitFor('result');
    const exit = await run.done;
    assert.equal(exit.code, 0, JSON.stringify({ exit, messages: run.messages }));
    assert.equal(result.ok, true);
    for (const kind of ['marker', 'blob']) {
      const events = run.messages.filter(message => message.type === 'reuse-operation' && message.kind === kind);
      assert.deepEqual(events.filter(message => message.phase === 'done').map(message => message.operation),
        ['open', 'stat', 'readFile', 'sync', 'close']);
      assert.equal(new Set(events.map(message => message.id)).size, 1, 'must not reopen');
    }
    await checkReusePreserved(root, snapshot, run);
    assert.equal(ids.has(result.receipt!.capture_id), false);
    ids.add(result.receipt!.capture_id);
    await checkReceipt(root, raw, result.receipt!);
    snapshot.set(`receipts/${result.receipt!.capture_id}.json`,
      await fs.readFile(path.join(root, 'receipts', `${result.receipt!.capture_id}.json`)));
  }
  assert.deepEqual(await accepted(root), [...ids].map(id => `${id}.json`).sort());
});

for (const kind of ['marker', 'blob']) {
  for (const operation of ['open', 'sync']) {
    for (const code of ['EPERM', 'EIO']) {
      test(`existing ${kind} ${operation} ${code} fails closed and preserves evidence`, async t => {
        const capture = await product();
        const { base, root } = await fixture(t);
        const raw = Buffer.from('REUSE_RAW_SECRET\0\r\n');
        const prior = await capture(raw, { root });
        const snapshot = await reuseSnapshot(root, prior);
        const run = await childRun(t, base, root, raw, `reuse:${kind}:${operation}:${code}`);
        const result = await run.waitFor('result');
        const exit = await run.done;
        assert.deepEqual(run.messages.filter(message => message.type === 'reuse-fault'),
          [{ type: 'reuse-fault', kind, operation, code }], 'required boundary reached exactly once');
        assert.equal(exit.code, 23, JSON.stringify(exit));
        assert.equal(result.ok, false);
        assert.equal(result.error, 'Error: capture: failed to persist submitted prompt');
        assert.equal(exit.stdout + exit.stderr, '');
        await checkReusePreserved(root, snapshot, run);
        assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
      });
    }
  }

  test(`native read-only ${kind} fails closed without permission repair`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    const raw = Buffer.from('read-only original evidence\0\r\n');
    const prior = await capture(raw, { root });
    const snapshot = await reuseSnapshot(root, prior);
    const target = path.join(root, kind === 'marker' ? 'store.json' : prior.original_ref);
    // On Windows chmod clears the writable attribute; on POSIX 0400 exercises
    // the earlier private-mode guard. Only native Windows tests the open denial.
    await fs.chmod(target, 0o400);
    try {
      const before = await fs.stat(target);
      assert.equal(before.mode & 0o200, 0, 'read-only fixture must be effective');
      const run = await childRun(t, base, root, raw, 'reuse:readonly');
      const result = await run.waitFor('result');
      const exit = await run.done;
      assert.equal(exit.code, 23, JSON.stringify({ exit, messages: run.messages }));
      assert.equal(result.ok, false);
      assert.equal(result.error, 'Error: capture: failed to persist submitted prompt');
      assert.equal(exit.stdout + exit.stderr, '');
      assert.equal((await fs.stat(target)).mode, before.mode);
      if (process.platform === 'win32') {
        assert.equal(run.messages.some(message => message.type === 'reuse-operation' && message.kind === kind
          && ['open', 'sync'].includes(message.operation!) && message.phase === 'error'), true,
        'native read-only boundary must reject');
      } else {
        t.diagnostic('POSIX private-mode rejection only; Windows read-only open/flush denial requires native Windows execution');
      }
      await checkReusePreserved(root, snapshot, run);
      assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
    } finally {
      // Restore only this owned fixture after assertions so teardown can remove it.
      await fs.chmod(target, 0o600);
    }
  });
}

test('independent concurrent child writers retain every receipt and exact blob', async t => {
  await product();
  const { base, root } = await fixture(t);
  const payloads = Array.from({ length: 8 }, (_, i) => Buffer.from(`child payload ${i % 4}\0\r\n`));
  const runs = await Promise.all(payloads.map(raw => childRun(t, base, root, raw, 'concurrent')));
  await Promise.all(runs.map(run => run.waitFor('ready')));
  for (const run of runs) run.child.send({ type: 'go' });
  const results = await Promise.all(runs.map(run => run.waitFor('result')));
  const exits = await Promise.all(runs.map(run => run.done));
  const ids = new Set<string>();
  for (let i = 0; i < runs.length; i++) {
    assert.equal(exits[i].code, 0, JSON.stringify(exits[i]));
    assert.equal(results[i].ok, true, JSON.stringify(results[i]));
    const receipt = results[i].receipt!;
    ids.add(receipt.capture_id);
    await checkReceipt(root, payloads[i], receipt);
  }
  assert.equal(ids.size, runs.length);
  assert.equal((await accepted(root)).length, runs.length);
  await sentinels(base, root);
});

// Pure path control for the fixture above: no product call. Same-volume relative
// stays relative, cross-volume "relative" is absolute, which is exactly how the
// Windows checkout (D:) and temp root (C:) defeated the earlier relative fixture.
test('path fixture control: only same-volume path.relative yields a relative root', () => {
  const sameVolume = path.win32.relative('D:\\a\\project\\project', 'D:\\a\\project\\project\\tmp\\store');
  assert.equal(sameVolume, 'tmp\\store');
  assert.equal(path.win32.isAbsolute(sameVolume), false);
  const crossVolume = path.win32.relative('D:\\a\\project\\project', 'C:\\Users\\runner\\AppData\\Local\\Temp\\capture\\store');
  assert.equal(crossVolume, 'C:\\Users\\runner\\AppData\\Local\\Temp\\capture\\store');
  assert.equal(path.win32.isAbsolute(crossVolume), true);
  assert.equal(path.win32.isAbsolute(path.win32.join('capture-receipt-test-abc', 'store')), false);
  assert.equal(path.posix.isAbsolute(path.posix.join('capture-receipt-test-abc', 'store')), false);
});

for (const kind of ['relative', 'missing', 'file', 'symlink'] as const) {
  test(`refuse invalid root: ${kind}`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    let bad = path.join(base, 'bad');
    if (kind === 'relative') {
      // path.relative(process.cwd(), root) is not relative when the checkout and
      // the temp root live on different Windows volumes: it returns the absolute
      // target, so this case never handed the product a relative root. Build the
      // relative form from the fixture's own trailing names, which depends on no
      // volume and on no current working directory.
      bad = path.join(path.basename(base), path.basename(root));
      // Fixture precondition: the product must receive a nonempty relative root.
      assert.notEqual(bad, '', 'relative root fixture must be nonempty');
      assert.equal(path.isAbsolute(bad), false, `relative root fixture must stay relative: ${bad}`);
      assert.equal(path.win32.isAbsolute(bad), false, `relative root fixture must stay relative on win32: ${bad}`);
      assert.equal(path.posix.isAbsolute(bad), false, `relative root fixture must stay relative on posix: ${bad}`);
    }
    if (kind === 'file') await fs.writeFile(bad, 'existing root file');
    if (kind === 'symlink') await fs.symlink(root, bad, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(capture(Buffer.from('ROOT_SECRET'), { root: bad }), error => {
      assert.doesNotMatch(String(error), /ROOT_SECRET/); return true;
    });
    assert.deepEqual(await accepted(root), []);
    if (kind === 'missing') await assert.rejects(fs.stat(bad), { code: 'ENOENT' });
    if (kind === 'file') assert.equal(await fs.readFile(bad, 'utf8'), 'existing root file');
    await sentinels(base, root);
  });
}

for (const child of ['raw', 'receipts']) {
  for (const kind of ['file', 'symlink']) {
    test(`refuse ${kind} child ${child} without altering target`, async t => {
      const capture = await product();
      const { base, root } = await fixture(t);
      const target = path.join(base, 'external');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'sentinel'), 'untouched');
      const destination = path.join(root, child);
      if (kind === 'file') await fs.writeFile(destination, 'existing evidence');
      else await fs.symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(capture(Buffer.from('denied'), { root }));
      assert.deepEqual(await fs.readdir(target), ['sentinel']);
      assert.equal(await fs.readFile(path.join(target, 'sentinel'), 'utf8'), 'untouched');
      if (kind === 'file') assert.equal(await fs.readFile(destination, 'utf8'), 'existing evidence');
      else assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
      await sentinels(base, root);
    });
  }
}

for (const marker of ['{broken', '{"schema_version":999,"version":999}', 'null']) {
  test(`refuse corrupt or unknown marker: ${marker}`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    const raw = Buffer.from('prior evidence');
    const prior = await capture(raw, { root });
    await fs.writeFile(path.join(root, 'store.json'), marker);
    await assert.rejects(capture(Buffer.from('new request'), { root }));
    assert.equal(await fs.readFile(path.join(root, 'store.json'), 'utf8'), marker);
    await checkReceipt(root, raw, prior);
    assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
    await sentinels(base, root);
  });
}

test('corrupt existing digest blob refuses reuse and preserves all prior evidence', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const raw = Buffer.from('immutable bytes');
  const prior = await capture(raw, { root });
  const priorReceipt = await fs.readFile(path.join(root, 'receipts', `${prior.capture_id}.json`));
  await fs.writeFile(path.join(root, prior.original_ref), 'CORRUPT_EVIDENCE');
  await assert.rejects(capture(raw, { root }));
  assert.equal(await fs.readFile(path.join(root, prior.original_ref), 'utf8'), 'CORRUPT_EVIDENCE');
  assert.deepEqual(await fs.readFile(path.join(root, 'receipts', `${prior.capture_id}.json`)), priorReceipt);
  assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
  await sentinels(base, root);
});

for (const kind of ['marker', 'blob']) {
  test(`refuse symlink ${kind} without changing referenced evidence`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    const raw = Buffer.from('symlink evidence');
    const prior = await capture(raw, { root });
    const destination = path.join(root, kind === 'marker' ? 'store.json' : prior.original_ref);
    const original = await fs.readFile(destination);
    const external = path.join(base, 'external-evidence');
    await fs.writeFile(external, original);
    await fs.unlink(destination);
    await fs.symlink(external, destination, 'file');
    await assert.rejects(capture(raw, { root }));
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), true);
    assert.deepEqual(await fs.readFile(external), original);
    assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
    await sentinels(base, root);
  });
}

test('forced receipt UUID collision refuses overwrite of an existing receipt', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const raw = Buffer.from('original collision evidence');
  const prior = await capture(raw, { root });
  const run = await childRun(t, base, root, Buffer.from('different colliding request'), `collision:${prior.capture_id}`);
  const result = await run.waitFor('result');
  assert.equal((await run.done).code, 23);
  assert.equal(result.ok, false, JSON.stringify(result));
  await checkReceipt(root, raw, prior);
  assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
  await sentinels(base, root);
});

for (const mode of ['blob-write', 'receipt-write', 'blob-rename', 'receipt-rename', 'file-fsync', 'directory-fsync',
  'blob-file-fsync', 'receipt-file-fsync', 'blob-directory-fsync', 'receipt-directory-fsync',
  'blob-write-enospc', 'receipt-write-enospc', 'blob-write-eacces', 'receipt-write-eacces', 'lock-release']) {
  test(`persistence fault cannot return success: ${mode}`, async t => {
    const capture = await product();
    const { base, root } = await fixture(t);
    const oldRaw = Buffer.from('prior durable evidence');
    const prior = await capture(oldRaw, { root });
    const raw = Buffer.from('FAULT_SECRET_RAW_ONLY');
    const run = await childRun(t, base, root, raw, mode);
    const result = await run.waitFor('result');
    const exit = await run.done;
    const faults = run.messages.filter(message => message.type === 'fault');
    t.diagnostic(JSON.stringify({ mode, faults, returned_success: result.ok, child_exit: exit.code }));
    assert.notEqual(faults.length, 0, 'required fault boundary was not reached');
    if (mode === 'blob-directory-fsync' || mode === 'receipt-directory-fsync') {
      const section = mode.startsWith('blob') ? 'raw' : 'receipts';
      assert.equal(faults[0].section, section);
      assert.equal(faults[0].renamed!.includes(section), true, 'must fail after final rename, not during initialization');
    }
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(exit.code, 23, JSON.stringify(exit));
    assert.doesNotMatch(`${result.error}\n${exit.stdout}\n${exit.stderr}`, /FAULT_SECRET_RAW_ONLY/);
    await checkReceipt(root, oldRaw, prior);
    // A failed final directory fsync can leave a receipt file as crash evidence;
    // lack of an API success is the required assertion at that boundary.
    if (!['directory-fsync', 'receipt-directory-fsync', 'lock-release'].includes(mode)) {
      assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
    }
    await sentinels(base, root);
  });
}

test('crash at receipt barrier leaves exact unindexed blob; restart preserves it and prior receipts', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const oldRaw = Buffer.from('before crash');
  const prior = await capture(oldRaw, { root });
  const raw = Buffer.from('recoverable crash evidence\0\r\n');
  const run = await childRun(t, base, root, raw, 'crash-before-receipt');
  const barrier = await run.waitFor('barrier');
  assert.equal(barrier.blobs!.some(blob => blob.name === `${digest(raw)}.bin` && blob.bytes === raw.toString('base64')), true);
  assert.equal(run.messages.some(message => message.type === 'result'), false);
  run.child.kill('SIGKILL');
  const exit = await run.done;
  assert.equal(exit.signal, 'SIGKILL');
  assert.deepEqual(await accepted(root), [`${prior.capture_id}.json`]);
  assert.deepEqual(await fs.readFile(path.join(root, 'raw', `${digest(raw)}.bin`)), raw);
  const restart = await childRun(t, base, root, raw);
  const result = await restart.waitFor('result');
  assert.equal((await restart.done).code, 0);
  assert.equal(result.ok, true, JSON.stringify(result));
  await checkReceipt(root, raw, result.receipt!);
  await checkReceipt(root, oldRaw, prior);
  assert.equal((await accepted(root)).length, 2);
  await sentinels(base, root);
});

test('private POSIX modes and native platform durability metadata', async t => {
  const capture = await product();
  const { base, root } = await fixture(t);
  const raw = Buffer.from('mode check');
  const receipt = await capture(raw, { root });
  await checkReceipt(root, raw, receipt);
  if (process.platform !== 'win32') {
    for (const name of ['raw', 'receipts']) assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o700);
    for (const name of ['store.json', receipt.original_ref, `receipts/${receipt.capture_id}.json`]) {
      assert.equal((await fs.stat(path.join(root, name))).mode & 0o777, 0o600);
    }
  }
  await sentinels(base, root);
});

test('fresh processes preserve earlier outputs and generate new identities for repeated delivery', async t => {
  await product();
  const { base, root } = await fixture(t);
  const raw = Buffer.from('process restart payload');
  const receipts: Receipt[] = [];
  for (let i = 0; i < 2; i++) {
    const run = await childRun(t, base, root, raw);
    const result = await run.waitFor('result');
    assert.equal((await run.done).code, 0);
    assert.equal(result.ok, true, JSON.stringify(result));
    receipts.push(result.receipt!);
  }
  assert.notEqual(receipts[0].capture_id, receipts[1].capture_id);
  for (const receipt of receipts) await checkReceipt(root, raw, receipt);
  assert.equal((await accepted(root)).length, 2);
  await sentinels(base, root);
});

test('mocked Windows branch reports file-fsync-only (not real Windows durability evidence)', async t => {
  await product();
  const { base, root } = await fixture(t);
  const run = await childRun(t, base, root, Buffer.from('Windows metadata'), 'windows-metadata');
  const result = await run.waitFor('result');
  assert.equal((await run.done).code, 0);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt!.durability, 'file-fsync-only');
  await sentinels(base, root);
});
