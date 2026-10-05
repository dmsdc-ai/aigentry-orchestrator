import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

// #1166 U1 — independent contract tests for the read-only capture inventory.
// Computed URLs let this file compile before the product exists. A missing
// inventory module is reported as FEATURE_ABSENT, never as a skip, a mock, or
// as proof that existing capture evidence is corrupt.
const inventoryUrl = new URL('../../src/request-capture/inventory.js', import.meta.url);
const inventoryCliUrl = new URL('../../src/request-capture/inventory-cli.js', import.meta.url);
const receiptUrl = new URL('../../src/request-capture/receipt.js', import.meta.url);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hookWrapper = path.join(repoRoot, 'bin', 'hook-prompt-submit.mjs');
const inventoryWrapper = path.join(repoRoot, 'bin', 'request-capture-inventory.mjs');

const SECRET = 'INV_SECRET_1166';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ITEM_KEYS = ['byte_len', 'capture_id', 'durability', 'provenance', 'received_at', 'sha256', 'task_binding'];
const RECEIPT_KEYS = ['byte_len', 'capture_id', 'channel', 'durability', 'metadata', 'original_ref', 'provenance',
  'received_at', 'schema_version', 'sha256', 'task_binding', 'upstream_delivery_id', 'upstream_namespace'];
const FIXED: Record<string, unknown> = {
  schema_version: 1, snapshot: 'non-atomic-observation', order: 'received-at-then-capture-id-not-commit',
  raw_content_read: false, content_hash_verified: false, hook_outcome: 'unrecorded',
  execution_state: 'unknown', dedupe: 'unavailable',
};
const MARKER = JSON.stringify({ schema_version: 1, kind: 'request-capture' });
const MiB = 1024 * 1024;

type Item = { capture_id: string; received_at: string; byte_len: number; sha256: string;
  durability: string; task_binding: string; provenance: string };
type Anomaly = Record<string, unknown> & { code: string };
type Inventory = Record<string, unknown> & { complete: boolean; items: Item[]; anomalies: Anomaly[] };
type ListFn = (root: string, options?: { limit: number }) => Promise<unknown> | unknown;
type Json = Record<string, unknown>;
type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type Event = { op: string; rel: string; flags: string | null };
type CliRun = Exit & { events: Event[] };
type Hook = { child: ChildProcess; done: Promise<Exit>; messages: string[]; wait: (message: string) => Promise<void> };

const digest = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function loadModule(url: URL, label: string): Promise<Record<string, unknown>> {
  try {
    return await import(url.href) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail(`FEATURE_ABSENT: ${label} is not built (no candidate staged)`);
    }
    throw error;
  }
}

async function loadInventory(): Promise<ListFn> {
  const loaded = await loadModule(inventoryUrl, 'dist/src/request-capture/inventory.js');
  assert.equal(typeof loaded.listCaptureInventory, 'function', 'listCaptureInventory export');
  return loaded.listCaptureInventory as ListFn;
}

async function requireWrapper(): Promise<void> {
  try { await fs.access(inventoryWrapper); }
  catch { assert.fail('FEATURE_ABSENT: bin/request-capture-inventory.mjs is absent (no candidate staged)'); }
}

async function list(root: string, options?: { limit: number }): Promise<Inventory> {
  const fn = await loadInventory();
  const result = await (options === undefined ? fn(root) : fn(root, options));
  // The contract is a JSON document; anything not JSON-serialisable is a defect.
  return JSON.parse(JSON.stringify(result)) as Inventory;
}

function codes(inventory: Inventory): Set<string> {
  return new Set(inventory.anomalies.map(anomaly => anomaly.code));
}

function visiblyTruncated(inventory: Inventory): boolean {
  return codes(inventory).has('scan_limit')
    || Object.keys(inventory).some(key => /truncat/.test(key) && Boolean(inventory[key]));
}

function safeAnomalyValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return UUID_V4.test(value) || HEX64.test(value) || /^[a-z][a-z_]{0,39}$/.test(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every(entry => typeof entry === 'string'
    && (UUID_V4.test(entry) || HEX64.test(entry)));
  return false;
}

function compareItems(left: Item, right: Item): number {
  if (left.received_at !== right.received_at) return left.received_at < right.received_at ? -1 : 1;
  return left.capture_id < right.capture_id ? -1 : left.capture_id > right.capture_id ? 1 : 0;
}

function leaks(text: string, forbidden: readonly string[]): string[] {
  return forbidden.filter(value => value.length > 0 && text.includes(value)).map((_, index) => `forbidden#${index}`);
}

function checkInventory(inventory: Inventory, forbidden: readonly string[] = []): void {
  for (const [key, value] of Object.entries(FIXED)) assert.deepEqual(inventory[key], value, `field ${key}`);
  assert.equal(typeof inventory.complete, 'boolean');
  assert.ok(Array.isArray(inventory.items), 'items array');
  assert.ok(Array.isArray(inventory.anomalies), 'anomalies array');
  assert.ok(inventory.anomalies.length <= 1000, 'anomalies bounded');
  for (const item of inventory.items) {
    assert.deepEqual(Object.keys(item).sort(), ITEM_KEYS, 'item keys are exactly the contract fields');
    assert.match(item.capture_id, UUID_V4);
    assert.equal(new Date(item.received_at).toISOString(), item.received_at);
    assert.ok(Number.isSafeInteger(item.byte_len) && item.byte_len >= 0, 'byte_len');
    assert.match(item.sha256, HEX64);
    assert.ok(['file-and-directory-fsync', 'file-fsync-only'].includes(item.durability), 'durability enum');
    assert.equal(item.task_binding, 'pending');
    assert.equal(item.provenance, 'unverified');
  }
  assert.equal(new Set(inventory.items.map(item => item.capture_id)).size, inventory.items.length, 'distinct capture ids');
  for (let index = 1; index < inventory.items.length; index++) {
    assert.ok(compareItems(inventory.items[index - 1]!, inventory.items[index]!) < 0, 'received_at then capture_id order');
  }
  for (const anomaly of inventory.anomalies) {
    assert.ok(anomaly !== null && typeof anomaly === 'object' && !Array.isArray(anomaly), 'anomaly object');
    assert.match(String(anomaly.code), /^[a-z][a-z_]{0,39}$/);
    for (const [key, value] of Object.entries(anomaly)) {
      if (key !== 'code') assert.ok(safeAnomalyValue(value), `anomaly ${anomaly.code}.${key} is not a count, enum or validated id`);
    }
  }
  if (inventory.anomalies.length > 0) assert.equal(inventory.complete, false, 'any anomaly makes the observation partial');
  assert.deepEqual(leaks(JSON.stringify(inventory), forbidden), [], 'no forbidden value in inventory');
}

// ---------------------------------------------------------------- fixtures

async function fixture(t: TestContext, label = 'store 한글 😀'): Promise<{ base: string; root: string }> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'capture-inventory-')));
  const root = path.join(base, label);
  await fs.mkdir(root, { mode: 0o700 });
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, root };
}

async function harnessDir(t: TestContext): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'inventory-harness-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writePrivate(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await fs.writeFile(file, data, { mode, flag: 'wx' });
  await fs.chmod(file, mode);
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch { return false; }
}

async function initStore(root: string): Promise<void> {
  await writePrivate(path.join(root, 'store.json'), MARKER);
  for (const name of ['raw', 'receipts']) {
    await fs.mkdir(path.join(root, name), { mode: 0o700 });
    await fs.chmod(path.join(root, name), 0o700);
  }
}

function receiptFor(raw: Uint8Array, over: Json = {}): Json {
  const sha = digest(raw);
  return {
    schema_version: 1, capture_id: randomUUID(), byte_len: raw.byteLength, sha256: sha,
    original_ref: `raw/${sha}.bin`, channel: 'codex-native', upstream_namespace: 'codex/session',
    upstream_delivery_id: null, received_at: new Date().toISOString(), provenance: 'unverified',
    task_binding: 'pending', metadata: { session_id: null, turn_id: null, hook_event_name: null, model: null },
    durability: 'file-and-directory-fsync', ...over,
  };
}

async function addReceipt(root: string, raw: Uint8Array, over: Json = {},
  options: { blob?: boolean; name?: string; text?: string } = {}): Promise<Json> {
  const receipt = receiptFor(raw, over);
  const blob = path.join(root, 'raw', `${digest(raw)}.bin`);
  if (options.blob !== false && !(await exists(blob))) await writePrivate(blob, raw);
  await writePrivate(path.join(root, 'receipts', options.name ?? `${String(receipt.capture_id)}.json`),
    options.text ?? JSON.stringify(receipt));
  return receipt;
}

async function realCapture(root: string, raw: Uint8Array): Promise<Json> {
  const loaded = await import(receiptUrl.href) as { captureSubmittedPrompt: (raw: Uint8Array, o: { root: string }) => Promise<Json> };
  return loaded.captureSubmittedPrompt(raw, { root });
}

async function receiptFiles(root: string): Promise<Json[]> {
  let names: string[];
  try { names = await fs.readdir(path.join(root, 'receipts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter(name => /\.json$/.test(name)).map(async name =>
    JSON.parse(await fs.readFile(path.join(root, 'receipts', name), 'utf8')) as Json));
}

// Every entry with identity, mode, link count, size, times and (for small files) content.
async function snapshot(dir: string): Promise<string> {
  const rows: string[] = [];
  async function walk(current: string): Promise<void> {
    const stat = await fs.lstat(current);
    let extra = '';
    if (stat.isSymbolicLink()) extra = await fs.readlink(current);
    else if (stat.isFile() && stat.size <= MiB) extra = digest(await fs.readFile(current));
    rows.push(JSON.stringify([path.relative(dir, current) || '.', stat.mode, stat.nlink, stat.size, stat.ino,
      stat.mtimeMs, stat.ctimeMs, extra]));
    if (stat.isDirectory()) for (const name of (await fs.readdir(current)).sort()) await walk(path.join(current, name));
  }
  await walk(dir);
  return rows.join('\n');
}

async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) assert.fail(`timeout waiting for ${label}`);
    await sleep(20);
  }
}

// ------------------------------------------------- instrumented child runs

// Records every fs entry point touching the store root (sync, callback, promise,
// FileHandle and fd forms) and writes the log OUTSIDE the root at exit. Optional
// modes inject an EIO, replace receipts/ mid-scan, or fail stdout.
const INVENTORY_PRELOAD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const root = process.env.INV_ROOT ? path.resolve(process.env.INV_ROOT) : '';
const mode = process.env.INV_MODE || '';
const logPath = process.env.INV_LOG;
const writeLog = fs.writeFileSync, renameSync = fs.renameSync, mkdirSync = fs.mkdirSync, unlinkSync = fs.unlinkSync;
const events = []; const fds = new Map(); let fired = false; let injecting = false;
function rel(value) {
  if (!root) return null;
  let text;
  if (typeof value === 'string') text = value;
  else if (Buffer.isBuffer(value)) text = value.toString();
  else if (value instanceof URL) text = fileURLToPath(value);
  else return null;
  const relative = path.relative(root, path.resolve(text));
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}
function record(op, r, flags) {
  if (!injecting && r !== null && events.length < 50000) events.push({ op, rel: r, flags: flags === undefined ? null : String(flags) });
}
function fault(op, r) {
  if (mode === 'io-error' && !fired && (op === 'open' || op === 'readFile') && /^receipts\/[^/]+\.json$/.test(r || '')) {
    fired = true; record('fault', r);
    return Object.assign(new Error('INV_SECRET_1166 EIO ' + root), { code: 'EIO', errno: -5 });
  }
  return null;
}
function after(op, r) {
  // Injected same-owner writer uses captured originals, so it is never recorded as an inventory call.
  if (mode === 'raw-drift' && !fired && r === 'receipts' && (op === 'opendir' || op === 'readdir')) {
    fired = true; record('drift', r);
    const late = path.join(root, 'raw', 'drift-writer.tmp');
    injecting = true;
    try { writeLog(late, 'x', { mode: 0o600 }); unlinkSync(late); } finally { injecting = false; }
  }
  if (mode === 'swap-receipts' && !fired && r === 'receipts' && (op === 'opendir' || op === 'readdir')) {
    fired = true; record('swap', r);
    renameSync(path.join(root, 'receipts'), path.join(root, 'receipts.swapped'));
    mkdirSync(path.join(root, 'receipts'), { mode: 0o700 });
  }
}
const PATH_OPS = ['open', 'opendir', 'readdir', 'readFile', 'writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir',
  'unlink', 'rename', 'link', 'symlink', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'truncate',
  'copyFile', 'cp', 'lstat', 'stat', 'statfs', 'realpath', 'access', 'readlink', 'createReadStream', 'createWriteStream'];
const TWO_PATH = new Set(['rename', 'link', 'symlink', 'copyFile', 'cp']);
const FD_OPS = ['write', 'writev', 'fsync', 'fdatasync', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'read', 'readv', 'fstat'];
const HANDLE_OPS = ['write', 'writev', 'writeFile', 'appendFile', 'sync', 'datasync', 'truncate', 'chmod', 'chown',
  'utimes', 'read', 'readv', 'readFile', 'readLines', 'stat', 'createReadStream', 'createWriteStream'];
function keep(wrapped, original) { Object.assign(wrapped, original); return wrapped; }
function flagsOf(name, args) {
  if (name !== 'open') return undefined;
  return typeof args[1] === 'function' || args[1] === undefined ? 'r' : args[1];
}
function wrapHandle(handle, r) {
  for (const name of HANDLE_OPS) {
    const original = handle[name]; if (typeof original !== 'function') continue;
    handle[name] = function (...args) { record('handle.' + name, r); return original.apply(this, args); };
  }
  return handle;
}
const promises = fs.promises;
for (const name of PATH_OPS) {
  const original = promises[name]; if (typeof original !== 'function') continue;
  promises[name] = keep(async function (...args) {
    const r = rel(args[0]); record(name, r, flagsOf(name, args));
    if (TWO_PATH.has(name)) record(name + ':dest', rel(args[1]));
    const error = fault(name, r); if (error) throw error;
    const result = await original.apply(this, args);
    after(name, r);
    return name === 'open' && r !== null ? wrapHandle(result, r) : result;
  }, original);
}
for (const name of PATH_OPS) {
  for (const variant of [name, name + 'Sync']) {
    const original = fs[variant]; if (typeof original !== 'function') continue;
    const sync = variant.endsWith('Sync');
    fs[variant] = keep(function (...args) {
      const r = rel(args[0]); record(name, r, flagsOf(name, args));
      if (TWO_PATH.has(name)) record(name + ':dest', rel(args[1]));
      const error = fault(name, r);
      if (error) {
        if (sync || typeof args[args.length - 1] !== 'function') throw error;
        process.nextTick(args[args.length - 1], error); return undefined;
      }
      if (name === 'open' && r !== null) {
        if (sync) { const fd = original.apply(this, args); fds.set(fd, r); return fd; }
        const callback = args[args.length - 1];
        if (typeof callback === 'function') {
          args[args.length - 1] = function (err, fd) { if (!err) fds.set(fd, r); return callback.call(this, err, fd); };
        }
      }
      const result = original.apply(this, args); after(name, r); return result;
    }, original);
  }
}
for (const name of FD_OPS) {
  for (const variant of [name, name + 'Sync']) {
    const original = fs[variant]; if (typeof original !== 'function') continue;
    fs[variant] = keep(function (...args) {
      if (fds.has(args[0])) record('fd.' + name, fds.get(args[0])); return original.apply(this, args);
    }, original);
  }
}
if (mode === 'stdout-error') {
  process.stdout.write = function (_chunk, ...args) {
    record('fault', '.');
    const error = Object.assign(new Error('INV_SECRET_1166 EPIPE ' + root), { code: 'EPIPE' });
    const callback = args.find(value => typeof value === 'function');
    queueMicrotask(() => callback ? callback(error) : this.emit('error', error)); return false;
  };
}
process.on('exit', () => { if (logPath) writeLog(logPath, JSON.stringify(events)); });
syncBuiltinESMExports();
`;

async function runNode(t: TestContext, executable: string, args: string[],
  options: { root: string; mode?: string; closeStdout?: boolean }): Promise<CliRun> {
  const harness = await harnessDir(t);
  const preloadPath = path.join(harness, 'preload.cjs');
  const logPath = path.join(harness, 'events.json');
  await fs.writeFile(preloadPath, INVENTORY_PRELOAD);
  const child = fork(executable, args, { execPath: process.execPath, execArgv: ['--require', preloadPath],
    silent: true, cwd: harness, env: { HOME: harness, TMPDIR: harness, TEMP: harness, TMP: harness,
      INV_ROOT: options.root, INV_MODE: options.mode ?? '', INV_LOG: logPath } });
  let stdout = ''; let stderr = '';
  if (options.closeStdout) child.stdout!.destroy();
  else child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.stdin!.on('error', () => {});
  child.stdin!.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const exit = await new Promise<Exit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  }).finally(() => clearTimeout(timer));
  let events: Event[];
  try { events = JSON.parse(await fs.readFile(logPath, 'utf8')) as Event[]; }
  catch { assert.fail(`instrumentation log missing: ${JSON.stringify(exit)}`); }
  return { ...exit, events };
}

async function cli(t: TestContext, root: string, extra: string[] = [],
  options: { mode?: string; closeStdout?: boolean } = {}): Promise<CliRun> {
  await requireWrapper();
  return runNode(t, inventoryWrapper, ['--root', root, ...extra], { root, ...options });
}

function documentOf(run: Exit): Inventory {
  assert.equal(run.signal, null, JSON.stringify(run));
  let document: Inventory;
  try { document = JSON.parse(run.stdout) as Inventory; }
  catch { assert.fail(`stdout is not exactly one JSON document: ${JSON.stringify(run)}`); }
  return document;
}

function sanitized(run: Exit, forbidden: readonly string[]): void {
  assert.deepEqual(leaks(run.stdout + run.stderr, [SECRET, ...forbidden]), [], 'no forbidden value in stdout/stderr');
  assert.doesNotMatch(run.stderr, /\bat .*:\d+:\d+|Error:/, 'no stack or raw error text');
}

const MUTATING = new Set(['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'link',
  'symlink', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'truncate', 'copyFile', 'cp',
  'createWriteStream', 'handle.write', 'handle.writev', 'handle.writeFile', 'handle.appendFile', 'handle.sync',
  'handle.datasync', 'handle.truncate', 'handle.chmod', 'handle.chown', 'handle.utimes', 'handle.createWriteStream',
  'fd.write', 'fd.writev', 'fd.fsync', 'fd.fdatasync', 'fd.ftruncate', 'fd.fchmod', 'fd.fchown', 'fd.futimes']);
const WRITE_BITS = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND;

function writable(flags: string | null): boolean {
  if (flags === null) return false;
  if (/^\d+$/.test(flags)) return (Number(flags) & WRITE_BITS) !== 0;
  return /[wa+]/.test(flags);
}

function assertReadOnly(events: readonly Event[]): void {
  for (const event of events) {
    assert.ok(!MUTATING.has(event.op) && !event.op.endsWith(':dest'), `store mutation ${event.op} ${event.rel}`);
    if (event.op === 'open') assert.ok(!writable(event.flags), `write-open ${event.rel} ${event.flags}`);
    if (event.rel.startsWith('raw/') && /^(open|readFile|createReadStream|handle\.|fd\.)/.test(event.op)) {
      assert.fail(`raw content access ${event.op} ${event.rel}`);
    }
  }
}

function assertObserved(events: readonly Event[], blob = true): void {
  assert.ok(events.some(event => /^(open|readFile)$/.test(event.op) && /^receipts\/[^/]+\.json$/.test(event.rel)),
    'instrumentation observed a receipt read (non-vacuous)');
  if (blob) assert.ok(events.some(event => /^(lstat|stat)$/.test(event.op) && /^raw\/[0-9a-f]{64}\.bin$/.test(event.rel)),
    'instrumentation observed blob metadata inspection (non-vacuous)');
}

// ----------------------------------------- existing hook fault instrumentation

// Verbatim copy of the existing cli.test.ts preload (staged fault instrumentation).
const HOOK_PRELOAD = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const mode = process.env.CAPTURE_TEST_FAULT;
const root = process.env.CAPTURE_TEST_ROOT;
const send = value => { if (process.send) process.send(value); };
const renamed = new Set();
function section(value) { return path.relative(root, String(value)).split(path.sep)[0]; }
async function hit(op, value, handle) {
  const area = section(value);
  if (mode === 'receipt-barrier' && area === 'receipts' && op === 'write') {
    send('barrier'); await new Promise(resolve => process.once('message', resolve));
  }
  let fail = mode === 'blob-write' && area === 'raw' && op === 'write'
    || mode === 'receipt-write' && area === 'receipts' && op === 'write'
    || mode === 'lock-release' && op === 'unlink' && value === path.join(root, 'store.json.lock')
    || mode === 'lock-acquire' && op === 'link';
  if (op === 'sync') {
    const directory = (await handle.stat()).isDirectory();
    fail ||= mode === 'file-fsync' && area === 'raw' && !directory;
    fail ||= mode === 'directory-fsync' && area === 'receipts' && directory && renamed.has('receipts');
  }
  if (fail) { send('fault'); throw Object.assign(new Error('RAW_SECRET_1166 ' + root), { code: 'EIO' }); }
}
const p = fs.promises;
const open = p.open;
p.open = async function(value, ...args) {
  const handle = await open.call(this, value, ...args);
  for (const name of ['writeFile', 'write', 'sync', 'datasync']) {
    const original = handle[name];
    handle[name] = async function(...values) {
      await hit(name === 'sync' || name === 'datasync' ? 'sync' : 'write', value, handle);
      return original.apply(this, values);
    };
  }
  return handle;
};
for (const name of ['unlink', 'link', 'rename']) {
  const original = p[name];
  p[name] = async function(value, ...args) {
    await hit(name, value);
    const result = await original.call(this, value, ...args);
    if (name === 'rename') renamed.add(section(args[0]));
    return result;
  };
}
if (mode === 'weak-durability') Object.defineProperty(process, 'platform', { value: 'win32' });
if (mode === 'stdin-error') {
  process.stdin._read = function() {
    send('fault'); this.destroy(new Error('RAW_SECRET_1166 ' + root));
  };
}
if (mode === 'stdout-error') {
  process.stdout.write = function(_chunk, ...args) {
    send('fault'); const error = Object.assign(new Error('RAW_SECRET_1166 ' + root), { code: 'EPIPE' });
    const callback = args.find(value => typeof value === 'function');
    queueMicrotask(() => callback ? callback(error) : this.emit('error', error)); return false;
  };
}
syncBuiltinESMExports();
send('ready');
`;

async function hook(t: TestContext, root: string, mode = ''): Promise<Hook> {
  const harness = await harnessDir(t);
  const preloadPath = path.join(harness, 'hook-preload.cjs');
  await fs.writeFile(preloadPath, HOOK_PRELOAD);
  const child = fork(hookWrapper, ['--root', root], { execPath: process.execPath, execArgv: ['--require', preloadPath],
    silent: true, cwd: harness, env: { TMPDIR: harness, TEMP: harness, TMP: harness, HOME: harness,
      CAPTURE_TEST_FAULT: mode, CAPTURE_TEST_ROOT: root } });
  let stdout = ''; let stderr = '';
  const messages: string[] = [];
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.stdin!.on('error', () => {});
  child.on('message', message => { messages.push(String(message)); });
  const done = new Promise<Exit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  void done.finally(() => clearTimeout(timer)).catch(() => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  const wait = async (message: string): Promise<void> => {
    if (messages.includes(message)) return;
    await new Promise<void>((resolve, reject) => {
      const listener = (value: unknown): void => { if (value === message) { child.off('message', listener); resolve(); } };
      child.on('message', listener);
      void done.then(result => { child.off('message', listener); reject(new Error(`missing ${message}: ${JSON.stringify(result)}`)); }, reject);
    });
  };
  return { child, done, messages, wait };
}

function allowed(result: Exit): void {
  assert.deepEqual(result, { code: 0, signal: null, stdout: '{}\n', stderr: '' });
}

// Declared win32 limitation (contract + README): ACLs/modes are not verified, so even a clean
// observation is partial (complete:false, exit 3) and claims no ACL assurance. POSIX: complete, exit 0.
// Native win32 behaviour is NOT measured by this suite; these branches only avoid contradicting it.
const WIN32 = process.platform === 'win32';
const CLEAN_EXIT = WIN32 ? 3 : 0;
function assertClean(inventory: Inventory, code?: number | null): void {
  assert.deepEqual(inventory.anomalies, [], 'no anomaly observed');
  assert.equal(inventory.complete, !WIN32, WIN32 ? 'win32 never claims complete (ACLs unverified)' : 'clean POSIX observation is complete');
  if (code !== undefined) assert.equal(code, CLEAN_EXIT, JSON.stringify(inventory));
}
// The real hook as a fixture writer. POSIX: allowed. win32: per receipt.ts/cli.ts the hook blocks
// after a durable file-fsync-only receipt (blocked yet captured).
function captured(result: Exit): void {
  if (!WIN32) { allowed(result); return; }
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal((JSON.parse(result.stdout) as { decision: string }).decision, 'block');
}
// POSIX mode negative controls: win32 does not verify modes/ACLs, so only "never complete" holds there.
const POSIX_MODE_CONTROLS = new Set(['mode-0644', 'blob-mode-0644', 'root-mode-0755']);

// ===================================================== baseline reproduction

const BLOCKED_WITH_RECEIPT = ['directory-fsync', 'lock-release', 'stdout-error', 'weak-durability'] as const;

for (const mode of BLOCKED_WITH_RECEIPT) {
  test(`baseline repro: hook blocks (${mode}) yet a durable v1 receipt exists with no outcome field`, async t => {
    const { root } = await fixture(t);
    const raw = Buffer.from(`prompt ${SECRET} ${mode}`);
    const run = await hook(t, root, mode); await run.wait('ready'); run.child.stdin!.end(raw);
    const result = await run.done;
    // weak-durability simulates win32 durability; it has no fault boundary in the existing preload.
    // On win32 directory fsync is skipped by receipt.ts/atomic-write.ts, so that boundary is unreachable.
    if (mode !== 'weak-durability' && !(WIN32 && mode === 'directory-fsync')) {
      assert.ok(run.messages.includes('fault'), 'fault boundary must be reached');
    }
    assert.equal(result.code, 2, JSON.stringify(result));
    assert.equal(result.signal, null);
    if (mode === 'stdout-error') assert.equal(result.stdout, '');
    else assert.equal((JSON.parse(result.stdout) as { decision: string }).decision, 'block');
    const rows = await receiptFiles(root);
    assert.equal(rows.length, 1, 'blocked prompt still left a receipt');
    const receipt = rows[0]!;
    assert.deepEqual(Object.keys(receipt).sort(), RECEIPT_KEYS, 'receipt carries no hook outcome / admission field');
    assert.equal(receipt.task_binding, 'pending');
    assert.equal(receipt.durability, WIN32 || mode === 'weak-durability' ? 'file-fsync-only' : 'file-and-directory-fsync');
    assert.deepEqual(await fs.readFile(path.join(root, String(receipt.original_ref))), raw);
    if (mode === 'lock-release') assert.ok((await fs.stat(path.join(root, 'store.json.lock'))).isFile());
    t.diagnostic(`BASELINE_REPRO mode=${mode} hook_exit=${result.code} receipts=${rows.length} outcome_field=absent`);
  });
}

// ================================================================ inventory

for (const mode of BLOCKED_WITH_RECEIPT) {
  test(`inventory: blocked-hook receipt (${mode}) is listed unrecorded/unknown, never admitted`, async t => {
    const { base, root } = await fixture(t);
    const raw = Buffer.from(`prompt ${SECRET} ${mode}`);
    const run = await hook(t, root, mode); await run.wait('ready'); run.child.stdin!.end(raw);
    assert.equal((await run.done).code, 2);
    const [receipt] = await receiptFiles(root);
    const before = await snapshot(base);
    const out = await cli(t, root);
    assert.equal(await snapshot(base), before, 'inventory left the tree unchanged');
    assertReadOnly(out.events); assertObserved(out.events);
    sanitized(out, [root, base]);
    const inventory = documentOf(out);
    checkInventory(inventory, [root, base, SECRET]);
    assert.equal(inventory.hook_outcome, 'unrecorded');
    assert.equal(inventory.execution_state, 'unknown');
    assert.deepEqual(inventory.items.map(item => item.capture_id), [receipt!.capture_id]);
    assert.equal(inventory.items[0]!.durability, receipt!.durability);
    if (mode === 'lock-release') {
      assert.equal(out.code, 3); assert.equal(inventory.complete, false);
      assert.ok(codes(inventory).has('lock_present'));
    } else {
      assertClean(inventory, out.code);
    }
  });
}

test('inventory: burst A B C while A holds the store lock; concurrent run is read-only', async t => {
  const { base, root } = await fixture(t);
  const raws = ['A', 'B', 'C'].map(name => Buffer.from(`burst ${name} ${SECRET}`));
  const a = await hook(t, root, 'receipt-barrier'); await a.wait('ready');
  a.child.stdin!.end(raws[0]); await a.wait('barrier');
  const waiters = [await hook(t, root), await hook(t, root)];
  waiters[0]!.child.stdin!.end(raws[1]); waiters[1]!.child.stdin!.end(raws[2]);
  await until(async () => (await fs.readdir(root)).filter(name => name.startsWith('store.json.lock.tmp.')).length === 2,
    'B and C waiting on the lock');
  const before = await snapshot(base);
  const during = await cli(t, root);
  assert.equal(await snapshot(base), before, 'inventory concurrent with writers left the tree unchanged');
  assertReadOnly(during.events);
  const partial = documentOf(during); checkInventory(partial, [root, base, SECRET]);
  assert.equal(during.code, 3); assert.equal(partial.complete, false);
  assert.ok(codes(partial).has('lock_present'));
  assert.equal(partial.items.length, 0, 'no receipt committed while A holds the lock');
  a.child.send('release');
  for (const result of await Promise.all([a.done, ...waiters.map(run => run.done)])) captured(result);
  const out = await cli(t, root);
  assertReadOnly(out.events); assertObserved(out.events);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assertClean(inventory, out.code);
  assert.equal(inventory.items.length, 3);
  assert.deepEqual(new Set(inventory.items.map(item => item.sha256)), new Set(raws.map(raw => digest(raw))));
});

test('inventory: equal bytes twice stay two distinct receipts (no text dedupe)', async t => {
  const { base, root } = await fixture(t);
  const raw = Buffer.from(`same ${SECRET}`);
  const first = await realCapture(root, raw); const second = await realCapture(root, raw);
  const before = await snapshot(base);
  const inventory = await list(root);
  assert.equal(await snapshot(base), before);
  checkInventory(inventory, [root, base, SECRET]);
  assertClean(inventory);
  assert.equal(inventory.dedupe, 'unavailable');
  assert.deepEqual(new Set(inventory.items.map(item => item.capture_id)), new Set([first.capture_id, second.capture_id]));
  assert.deepEqual(inventory.items.map(item => item.sha256), [digest(raw), digest(raw)]);
  assert.deepEqual(await fs.readdir(path.join(root, 'raw')), [`${digest(raw)}.bin`]);
});

test('inventory: SIGKILL before receipt leaves preserved orphan, dead lock and tmp residue across restart', async t => {
  const { base, root } = await fixture(t);
  const lost = Buffer.from(`killed ${SECRET}`);
  const a = await hook(t, root, 'receipt-barrier'); await a.wait('ready');
  a.child.stdin!.end(lost); await a.wait('barrier'); a.child.kill('SIGKILL');
  assert.equal((await a.done).signal, 'SIGKILL');
  const lockBefore = await fs.readFile(path.join(root, 'store.json.lock'));
  const before = await snapshot(base);
  const first = await cli(t, root); const restart = await cli(t, root);
  assert.equal(await snapshot(base), before, 'orphan, lock and residue preserved; nothing repaired or swept');
  assert.deepEqual(await fs.readFile(path.join(root, 'store.json.lock')), lockBefore);
  assert.deepEqual(await fs.readFile(path.join(root, 'raw', `${digest(lost)}.bin`)), lost);
  for (const run of [first, restart]) {
    assertReadOnly(run.events); sanitized(run, [root, base]);
    const inventory = documentOf(run); checkInventory(inventory, [root, base, SECRET]);
    assert.equal(run.code, 3); assert.equal(inventory.complete, false); assert.equal(inventory.items.length, 0);
    for (const code of ['orphan_blob', 'lock_present', 'tmp_residue']) assert.ok(codes(inventory).has(code), code);
  }
  const [one, two] = [documentOf(first), documentOf(restart)];
  assert.deepEqual([two.complete, two.items, two.anomalies], [one.complete, one.items, one.anomalies], 'restart observation is deterministic');
  const next = await hook(t, root); await next.wait('ready');
  next.child.stdin!.end(Buffer.from(`after restart ${SECRET}`)); captured(await next.done);
  const out = await cli(t, root);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assert.equal(out.code, 3); assert.equal(inventory.items.length, 1);
  assert.ok(codes(inventory).has('orphan_blob'), 'orphan is still an observed candidate, never deleted');
  assert.deepEqual(await fs.readFile(path.join(root, 'raw', `${digest(lost)}.bin`)), lost);
});

test('inventory: deterministic received_at then capture_id order, labelled not commit order', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  const raw = Buffer.from('ordered');
  const later = '2026-01-01T00:00:02.000Z'; const earlier = '2026-01-01T00:00:01.000Z';
  const ids = ['ffffffff-ffff-4fff-bfff-ffffffffffff', '00000000-0000-4000-8000-000000000000',
    '88888888-8888-4888-8888-888888888888', '11111111-1111-4111-9111-111111111111'];
  await addReceipt(root, raw, { capture_id: ids[0], received_at: earlier });
  await addReceipt(root, raw, { capture_id: ids[1], received_at: later });
  await addReceipt(root, raw, { capture_id: ids[2], received_at: earlier });
  await addReceipt(root, raw, { capture_id: ids[3], received_at: later });
  const before = await snapshot(base);
  const inventory = await list(root);
  assert.equal(await snapshot(base), before);
  checkInventory(inventory, [root, base]);
  assertClean(inventory);
  assert.equal(inventory.order, 'received-at-then-capture-id-not-commit');
  assert.deepEqual(inventory.items.map(item => item.capture_id), [ids[2], ids[0], ids[1], ids[3]]);
  assert.deepEqual(inventory.items.map(item => item.received_at), [earlier, earlier, later, later]);
});

type Variant = { codes: string[]; setup: (root: string, base: string, raw: Buffer) => Promise<void> };
const upper = randomUUID().toUpperCase();
const RECEIPT_VARIANTS: Record<string, Variant> = {
  'invalid-json': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    await addReceipt(root, raw, {}, { text: `{${SECRET}` });
  } },
  'oversize-64KiB': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    await addReceipt(root, raw, { metadata: { session_id: null, turn_id: null, hook_event_name: null, model: 'x'.repeat(66 * 1024) } });
  } },
  'json-array': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, {}, { text: '[]' }); } },
  'extra-outcome-key': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { hook_outcome: 'allowed' }); } },
  'missing-metadata': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    const receipt = receiptFor(raw); delete receipt.metadata;
    await addReceipt(root, raw, {}, { name: `${String(receipt.capture_id)}.json`, text: JSON.stringify(receipt) });
  } },
  'schema-2': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { schema_version: 2 }); } },
  'uppercase-id': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    await addReceipt(root, raw, { capture_id: upper }, { name: `${upper}.json` });
  } },
  'uuid-v1': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    const id = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; await addReceipt(root, raw, { capture_id: id }, { name: `${id}.json` });
  } },
  'filename-mismatch': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    await addReceipt(root, raw, {}, { name: `${randomUUID()}.json` });
  } },
  'traversal-ref': { codes: ['invalid_receipt'], setup: async (root, base, raw) => {
    await writePrivate(path.join(base, 'outside.bin'), raw);
    await addReceipt(root, raw, { original_ref: `../outside.bin` });
  } },
  'ref-digest-mismatch': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    const other = Buffer.from('other'); await writePrivate(path.join(root, 'raw', `${digest(other)}.bin`), other);
    await addReceipt(root, raw, { original_ref: `raw/${digest(other)}.bin` });
  } },
  'unknown-durability': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { durability: 'none' }); } },
  'unknown-channel': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { channel: 'telepty' }); } },
  'noncanonical-time': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { received_at: '2026-01-01T00:00:00Z' }); } },
  'negative-len': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { byte_len: -1 }); } },
  'fractional-len': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { byte_len: 1.5 }); } },
  'unsafe-len': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { byte_len: 2 ** 53 }); } },
  'uppercase-sha': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { sha256: digest(raw).toUpperCase() }); } },
  'provenance-human': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { provenance: 'human' }); } },
  'task-bound': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { task_binding: 'bound' }); } },
  'delivery-id': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => { await addReceipt(root, raw, { upstream_delivery_id: SECRET }); } },
  'metadata-number': { codes: ['invalid_receipt'], setup: async (root, _b, raw) => {
    await addReceipt(root, raw, { metadata: { session_id: 5, turn_id: null, hook_event_name: null, model: null } });
  } },
  'mode-0644': { codes: ['bad_mode'], setup: async (root, _b, raw) => {
    const receipt = await addReceipt(root, raw);
    await fs.chmod(path.join(root, 'receipts', `${String(receipt.capture_id)}.json`), 0o644);
  } },
  'hardlink': { codes: ['invalid_receipt', 'bad_mode', 'symlink'], setup: async (root, base, raw) => {
    const receipt = await addReceipt(root, raw);
    await fs.link(path.join(root, 'receipts', `${String(receipt.capture_id)}.json`), path.join(base, 'second-link.json'));
  } },
  'symlink': { codes: ['symlink'], setup: async (root, base, raw) => {
    const receipt = receiptFor(raw);
    await writePrivate(path.join(base, 'target.json'), JSON.stringify(receipt));
    if (!(await exists(path.join(root, 'raw', `${digest(raw)}.bin`)))) await writePrivate(path.join(root, 'raw', `${digest(raw)}.bin`), raw);
    await fs.symlink(path.join(base, 'target.json'), path.join(root, 'receipts', `${String(receipt.capture_id)}.json`));
  } },
  'directory-entry': { codes: ['invalid_receipt', 'bad_mode', 'io_error'], setup: async (root) => {
    await fs.mkdir(path.join(root, 'receipts', `${randomUUID()}.json`), { mode: 0o700 });
  } },
};

for (const [name, variant] of Object.entries(RECEIPT_VARIANTS)) {
  test(`inventory: invalid receipt is reported, never listed, never repaired: ${name}`, async t => {
    const { base, root } = await fixture(t); await initStore(root);
    const raw = Buffer.from(`variant ${SECRET}`);
    const valid = await addReceipt(root, raw);
    await variant.setup(root, base, raw);
    const before = await snapshot(base);
    const inventory = await list(root);
    assert.equal(await snapshot(base), before, 'nothing repaired or removed');
    checkInventory(inventory, [root, base, SECRET]);
    assert.equal(inventory.complete, false);
    if (WIN32 && POSIX_MODE_CONTROLS.has(name)) return;
    assert.deepEqual(inventory.items.map(item => item.capture_id), [valid.capture_id], 'only the valid receipt is listed');
    assert.ok(variant.codes.some(code => codes(inventory).has(code)),
      `expected one of ${variant.codes.join('|')}, got ${[...codes(inventory)].join('|')}`);
  });
}

const BLOB_VARIANTS: Record<string, { code: string; setup: (root: string, base: string, raw: Buffer) => Promise<void> }> = {
  'blob-missing': { code: 'blob_missing', setup: async (root, _b, raw) => { await addReceipt(root, raw, {}, { blob: false }); } },
  'size-mismatch': { code: 'size_mismatch', setup: async (root, _b, raw) => {
    await addReceipt(root, raw, { byte_len: raw.length + 1 });
  } },
  'blob-symlink': { code: 'symlink', setup: async (root, base, raw) => {
    await writePrivate(path.join(base, 'blob-target.bin'), raw);
    await fs.symlink(path.join(base, 'blob-target.bin'), path.join(root, 'raw', `${digest(raw)}.bin`));
    await addReceipt(root, raw, {}, { blob: false });
  } },
  'blob-mode-0644': { code: 'bad_mode', setup: async (root, _b, raw) => {
    await addReceipt(root, raw); await fs.chmod(path.join(root, 'raw', `${digest(raw)}.bin`), 0o644);
  } },
};

for (const [name, variant] of Object.entries(BLOB_VARIANTS)) {
  test(`inventory: blob metadata anomaly is reported and preserved: ${name}`, async t => {
    const { base, root } = await fixture(t); await initStore(root);
    await addReceipt(root, Buffer.from('a valid neighbour'));
    await variant.setup(root, base, Buffer.from(`blob ${SECRET}`));
    const before = await snapshot(base);
    const inventory = await list(root);
    assert.equal(await snapshot(base), before);
    checkInventory(inventory, [root, base, SECRET]);
    assert.equal(inventory.complete, false);
    if (WIN32 && POSIX_MODE_CONTROLS.has(name)) return;
    assert.ok(codes(inventory).has(variant.code), `${variant.code} in ${[...codes(inventory)].join('|')}`);
  });
}

test('inventory: claimed digest is never treated as verified content', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  const raw = Buffer.from(`claimed ${SECRET}`);
  const receipt = await addReceipt(root, raw);
  const blob = path.join(root, 'raw', `${digest(raw)}.bin`);
  await fs.chmod(blob, 0o600); await fs.writeFile(blob, Buffer.alloc(raw.length, 0x41));
  const inventory = await list(root);
  checkInventory(inventory, [root, base, SECRET]);
  assert.equal(inventory.content_hash_verified, false);
  assert.equal(inventory.raw_content_read, false);
  assert.deepEqual(inventory.items.map(item => [item.capture_id, item.sha256]), [[receipt.capture_id, digest(raw)]]);
});

const STORE_RESIDUE: Record<string, { code: string; setup: (root: string) => Promise<void> }> = {
  'stale-dead-lock': { code: 'lock_present', setup: async root => { await writePrivate(path.join(root, 'store.json.lock'), '999999999\n'); } },
  'lock-staging-tmp': { code: 'tmp_residue', setup: async root => { await writePrivate(path.join(root, 'store.json.lock.tmp.4242.0'), '4242\n'); } },
  'receipt-tmp': { code: 'tmp_residue', setup: async root => {
    await writePrivate(path.join(root, 'receipts', `${randomUUID()}.json.tmp.${randomUUID()}.4242`), '{"partial":');
  } },
  'blob-tmp': { code: 'tmp_residue', setup: async root => {
    await writePrivate(path.join(root, 'raw', `${digest(Buffer.from('t'))}.bin.tmp.${randomUUID()}.4242`), 't');
  } },
  'orphan-blob': { code: 'orphan_blob', setup: async root => {
    const raw = Buffer.from(`orphan ${SECRET}`); await writePrivate(path.join(root, 'raw', `${digest(raw)}.bin`), raw);
  } },
};

for (const [name, residue] of Object.entries(STORE_RESIDUE)) {
  test(`inventory: store residue is observed and preserved, never swept: ${name}`, async t => {
    const { base, root } = await fixture(t); await initStore(root);
    const valid = await addReceipt(root, Buffer.from('valid'));
    await residue.setup(root);
    const before = await snapshot(base);
    const out = await cli(t, root);
    assert.equal(await snapshot(base), before, 'residue preserved byte-identical');
    assertReadOnly(out.events); sanitized(out, [root, base]);
    const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
    assert.equal(out.code, 3); assert.equal(inventory.complete, false);
    assert.ok(codes(inventory).has(residue.code), `${residue.code} in ${[...codes(inventory)].join('|')}`);
    assert.deepEqual(inventory.items.map(item => item.capture_id), [valid.capture_id]);
  });
}

const INVALID_ROOTS: Record<string, (root: string, base: string) => Promise<string>> = {
  nonexistent: async (_root, base) => path.join(base, `absent ${SECRET}`),
  'regular-file': async (root) => { await fs.rmdir(root); await writePrivate(root, SECRET); return root; },
  'root-symlink': async (root, base) => {
    await initStore(root); await addReceipt(root, Buffer.from('x'));
    const link = path.join(base, `link ${SECRET}`); await fs.symlink(root, link, 'dir'); return link;
  },
  'root-mode-0755': async root => { await initStore(root); await addReceipt(root, Buffer.from('x')); await fs.chmod(root, 0o755); return root; },
  'corrupt-marker': async root => {
    await initStore(root); await fs.chmod(path.join(root, 'store.json'), 0o600);
    await fs.writeFile(path.join(root, 'store.json'), `{${SECRET}`); await addReceipt(root, Buffer.from('x')); return root;
  },
  'marker-extra-key': async root => {
    await initStore(root); await fs.writeFile(path.join(root, 'store.json'), JSON.stringify({ schema_version: 1, kind: 'request-capture', x: SECRET }));
    await addReceipt(root, Buffer.from('x')); return root;
  },
  'marker-symlink': async (root, base) => {
    await initStore(root); await fs.rm(path.join(root, 'store.json'));
    await writePrivate(path.join(base, 'marker.json'), MARKER);
    await fs.symlink(path.join(base, 'marker.json'), path.join(root, 'store.json')); await addReceipt(root, Buffer.from('x')); return root;
  },
  'receipts-symlink': async (root, base) => {
    await initStore(root); await fs.rmdir(path.join(root, 'receipts'));
    const target = path.join(base, `receipts-target ${SECRET}`); await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, path.join(root, 'receipts'), 'dir'); return root;
  },
  'raw-symlink': async (root, base) => {
    await initStore(root); await fs.rmdir(path.join(root, 'raw'));
    const target = path.join(base, `raw-target ${SECRET}`); await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, path.join(root, 'raw'), 'dir'); return root;
  },
};

for (const [kind, prepare] of Object.entries(INVALID_ROOTS)) {
  test(`inventory: invalid root/store yields a fixed diagnostic only: ${kind}`, async t => {
    const outcomes: unknown[] = [];
    let cliRoot = ''; let cliBase = '';
    for (const label of [`first ${SECRET} 한글`, `second-${SECRET}-other`]) {
      const { base, root } = await fixture(t, label);
      const target = await prepare(root, base);
      const before = await snapshot(base);
      const fn = await loadInventory();
      let outcome: unknown;
      try {
        const inventory = JSON.parse(JSON.stringify(await fn(target))) as Inventory;
        assert.equal(inventory.complete, false, 'never complete');
        if (!(WIN32 && POSIX_MODE_CONTROLS.has(kind))) assert.deepEqual(inventory.items ?? [], [], 'no items from an invalid root/store');
        outcome = inventory;
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        outcome = { rejected: String((error as Error).message) };
      }
      assert.deepEqual(leaks(JSON.stringify(outcome), [SECRET, root, base, target]), [], 'diagnostic carries no path/secret');
      assert.equal(await snapshot(base), before, 'nothing created or repaired');
      outcomes.push(outcome); cliRoot = target; cliBase = base;
    }
    // win32 mode control: the root is accepted (partial) and lists fixture-specific IDs, so outcomes differ.
    if (!(WIN32 && POSIX_MODE_CONTROLS.has(kind))) assert.deepEqual(outcomes[1], outcomes[0], 'diagnostic is fixed, independent of the path');
    const out = await cli(t, cliRoot);
    assertReadOnly(out.events);
    assert.equal(out.code, 3, JSON.stringify(out));
    documentOf(out); sanitized(out, [cliRoot, cliBase]);
  });
}

test('inventory: relative root is refused without touching the filesystem', async t => {
  const fn = await loadInventory();
  let outcome: unknown;
  try { outcome = JSON.parse(JSON.stringify(await fn(`relative/${SECRET}`))) as Inventory; }
  catch (error) { outcome = { rejected: String((error as Error).message) }; }
  if (!('rejected' in (outcome as object))) {
    assert.equal((outcome as Inventory).complete, false); assert.deepEqual((outcome as Inventory).items ?? [], []);
  }
  assert.deepEqual(leaks(JSON.stringify(outcome), [SECRET]), []);
  void t;
});

test('inventory: read-only CLI run with a sparse 64 MiB blob never opens raw content', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  const small = await addReceipt(root, Buffer.from(`small ${SECRET}`));
  const claimed = digest(Buffer.from(`huge ${SECRET}`));
  const huge = path.join(root, 'raw', `${claimed}.bin`);
  const handle = await fs.open(huge, 'wx', 0o600);
  try { await handle.truncate(64 * MiB); } finally { await handle.close(); }
  await fs.chmod(huge, 0o600);
  const id = randomUUID();
  await writePrivate(path.join(root, 'receipts', `${id}.json`), JSON.stringify(receiptFor(Buffer.alloc(0),
    { capture_id: id, byte_len: 64 * MiB, sha256: claimed, original_ref: `raw/${claimed}.bin` })));
  const before = await snapshot(base);
  const out = await cli(t, root);
  assert.equal(await snapshot(base), before);
  assertReadOnly(out.events); assertObserved(out.events);
  sanitized(out, [root, base]);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assertClean(inventory, out.code);
  assert.deepEqual(new Set(inventory.items.map(item => item.capture_id)), new Set([small.capture_id, id]));
  assert.equal(inventory.items.find(item => item.capture_id === id)!.byte_len, 64 * MiB);
  assert.ok(out.stdout.length < 64 * 1024, 'output is metadata only');
});

test('inventory: privacy sentinels in metadata, filenames, paths and errors never reach output', async t => {
  const { base, root } = await fixture(t, `store-${SECRET}-PATH 한글`);
  const prompt = JSON.stringify({ session_id: `SESSION_${SECRET}`, turn_id: `TURN_${SECRET}`, model: `MODEL_${SECRET}`,
    hook_event_name: `EVENT_${SECRET}`, prompt: `PROMPT_${SECRET}` });
  const run = await hook(t, root); await run.wait('ready'); run.child.stdin!.end(prompt); captured(await run.done);
  const [receipt] = await receiptFiles(root);
  assert.equal((receipt!.metadata as Json).session_id, `SESSION_${SECRET}`, 'fixture really carries metadata sentinels');
  await writePrivate(path.join(root, 'receipts', `NAME_${SECRET}.json`), JSON.stringify({ secret: SECRET }));
  await writePrivate(path.join(root, 'raw', `NAME_${SECRET}.bin`), SECRET);
  await writePrivate(path.join(root, 'receipts', `${randomUUID()}.json.tmp.${SECRET}.1`), SECRET);
  await writePrivate(path.join(root, `STRAY_${SECRET}`), SECRET);
  const out = await cli(t, root);
  assertReadOnly(out.events); sanitized(out, [root, base]);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assert.equal(out.code, 3); assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.items.map(item => item.capture_id), [receipt!.capture_id]);
  checkInventory(await list(root), [root, base, SECRET]);
});

test('inventory: injected EIO is reported as io_error without leaking the error message', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  await addReceipt(root, Buffer.from('one')); await addReceipt(root, Buffer.from('two'));
  const before = await snapshot(base);
  const out = await cli(t, root, [], { mode: 'io-error' });
  assert.equal(await snapshot(base), before);
  assert.ok(out.events.some(event => event.op === 'fault'), 'fault boundary reached');
  assertReadOnly(out.events); sanitized(out, [root, base]);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assert.equal(out.code, 3); assert.equal(inventory.complete, false);
  assert.ok(codes(inventory).has('io_error'));
});

test('inventory: receipts directory replaced during scan is reported partial; data preserved', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  const ids = [await addReceipt(root, Buffer.from('one')), await addReceipt(root, Buffer.from('two'))].map(r => String(r.capture_id));
  const out = await cli(t, root, [], { mode: 'swap-receipts' });
  assert.ok(out.events.some(event => event.op === 'swap'), 'swap boundary reached');
  assertReadOnly(out.events); sanitized(out, [root, base]);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assert.equal(out.code, 3); assert.equal(inventory.complete, false);
  assert.ok(codes(inventory).has('changed_during_scan'), [...codes(inventory)].join('|'));
  assert.deepEqual((await fs.readdir(path.join(root, 'receipts.swapped'))).sort(), ids.map(id => `${id}.json`).sort());
});

test('inventory: item limit truncation is visible and bounded', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  const raw = Buffer.from('limit');
  for (let index = 0; index < 101; index++) await addReceipt(root, raw);
  const fallback = await list(root);
  checkInventory(fallback, [root, base]);
  assert.equal(fallback.items.length, 100, 'default limit is 100');
  assert.equal(fallback.complete, false); assert.ok(visiblyTruncated(fallback), 'truncation is visible');
  const three = await list(root, { limit: 3 });
  checkInventory(three, [root, base]);
  assert.equal(three.items.length, 3); assert.equal(three.complete, false); assert.ok(visiblyTruncated(three));
  const all = await list(root, { limit: 1000 });
  checkInventory(all, [root, base]);
  assert.equal(all.items.length, 101); assertClean(all);
  const five = await list(root, { limit: 101 });
  assert.equal(five.items.length, 101); assertClean(five); // exactly limit valid items is not truncation
  const fn = await loadInventory();
  for (const bad of [0, 1001, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
    await assert.rejects(async () => fn(root, { limit: bad }), `limit ${String(bad)} rejected`);
  }
  const out = await cli(t, root, ['--limit', '3']);
  const document = documentOf(out); checkInventory(document, [root, base]);
  assert.equal(out.code, 3); assert.equal(document.items.length, 3);
});

test('inventory: per-directory scan limit and anomaly bounds', async t => {
  const { base, root } = await fixture(t); await initStore(root);
  await addReceipt(root, Buffer.from('valid'));
  const names = Array.from({ length: 4097 }, () => `${randomUUID()}.json`);
  for (let index = 0; index < names.length; index += 256) {
    await Promise.all(names.slice(index, index + 256).map(name => writePrivate(path.join(root, 'receipts', name), '{')));
  }
  const out = await cli(t, root);
  assertReadOnly(out.events); sanitized(out, [root, base]);
  const inventory = documentOf(out); checkInventory(inventory, [root, base]);
  assert.equal(out.code, 3); assert.equal(inventory.complete, false);
  assert.ok(codes(inventory).has('scan_limit'));
  assert.ok(inventory.anomalies.length <= 1000);
  const opened = new Set(out.events.filter(event => /^(open|readFile)$/.test(event.op) && event.rel.startsWith('receipts/')).map(event => event.rel));
  assert.ok(opened.size <= 4096, `examined ${opened.size} receipt files`);
  assert.ok(out.stdout.length < 1024 * 1024, 'bounded output');
});

const BAD_ARGS: Record<string, (root: string) => string[]> = {
  missing: () => [], 'root-missing-value': () => ['--root'], 'root-relative': () => ['--root', 'relative'],
  'root-duplicate': root => ['--root', root, '--root', root], 'root-equals-form': root => [`--root=${root}`],
  unknown: root => ['--root', root, `--${SECRET}`], positional: root => ['--root', root, SECRET],
  'limit-zero': root => ['--root', root, '--limit', '0'], 'limit-1001': root => ['--root', root, '--limit', '1001'],
  'limit-fraction': root => ['--root', root, '--limit', '1.5'], 'limit-alpha': root => ['--root', root, '--limit', SECRET],
  'limit-negative': root => ['--root', root, '--limit', '-1'], 'limit-missing-value': root => ['--root', root, '--limit'],
  'limit-duplicate': root => ['--root', root, '--limit', '3', '--limit', '3'],
  'package-relative': root => ['--root', root, '--package-root', 'relative'],
  'package-missing-value': root => ['--root', root, '--package-root'],
  'package-duplicate': root => ['--root', root, '--package-root', repoRoot, '--package-root', repoRoot],
};

for (const [kind, args] of Object.entries(BAD_ARGS)) {
  test(`inventory CLI: malformed arguments exit 2 before any store access: ${kind}`, async t => {
    await requireWrapper();
    const { base, root } = await fixture(t); await initStore(root); await addReceipt(root, Buffer.from('x'));
    const before = await snapshot(base);
    const out = await runNode(t, inventoryWrapper, args(root), { root });
    assert.equal(out.code, 2, JSON.stringify(out)); assert.equal(out.signal, null);
    assert.deepEqual(out.events, [], 'no store access before argument validation');
    if (out.stdout !== '') documentOf(out);
    sanitized(out, [root, base]);
    assert.equal(await snapshot(base), before);
  });
}

test('inventory CLI: stdout failure exits 2 (injected EPIPE and closed pipe) without store mutation', async t => {
  const { base, root } = await fixture(t); await initStore(root); await addReceipt(root, Buffer.from('x'));
  const before = await snapshot(base);
  const injected = await cli(t, root, [], { mode: 'stdout-error' });
  assert.ok(injected.events.some(event => event.op === 'fault'), 'stdout fault reached');
  assert.equal(injected.code, 2, JSON.stringify(injected)); assert.equal(injected.signal, null);
  assertReadOnly(injected.events); sanitized(injected, [root, base]);
  const closed = await cli(t, root, [], { closeStdout: true });
  assert.equal(closed.code, 2, JSON.stringify(closed)); assert.equal(closed.signal, null);
  assertReadOnly(closed.events); sanitized(closed, [root, base]);
  assert.equal(await snapshot(base), before);
});

test('inventory modules: imports are inert; capture hook import graph does not reach inventory', async t => {
  await loadInventory();
  await loadModule(inventoryCliUrl, 'dist/src/request-capture/inventory-cli.js');
  const { base, root } = await fixture(t); await initStore(root);
  const harness = await harnessDir(t);
  const probe = path.join(harness, 'import-probe.mjs');
  await fs.writeFile(probe, `import assert from 'node:assert/strict';
const events = process.eventNames().map(String);
const stdinEvents = process.stdin.eventNames().map(String);
const stdoutEvents = process.stdout.eventNames().map(String);
const a = await import(${JSON.stringify(inventoryUrl.href)});
const b = await import(${JSON.stringify(inventoryCliUrl.href)});
assert.equal(typeof a.listCaptureInventory, 'function');
assert.equal(typeof b.runInventory, 'function');
assert.deepEqual(process.eventNames().map(String), events);
assert.deepEqual(process.stdin.eventNames().map(String), stdinEvents);
assert.deepEqual(process.stdout.eventNames().map(String), stdoutEvents);`);
  const before = await snapshot(base);
  const out = await runNode(t, probe, [], { root });
  assert.deepEqual({ code: out.code, signal: out.signal, stdout: out.stdout, stderr: out.stderr },
    { code: 0, signal: null, stdout: '', stderr: '' });
  assert.deepEqual(out.events, []);
  assert.equal(await snapshot(base), before);
  for (const file of ['dist/src/request-capture/cli.js', 'dist/src/request-capture/receipt.js', 'bin/hook-prompt-submit.mjs']) {
    assert.doesNotMatch(await fs.readFile(path.join(repoRoot, file), 'utf8'), /inventory/, `${file} must not import inventory`);
  }
});

test('inventory CLI: runInventory(args) emits one JSON document and returns the exit code', async t => {
  await loadModule(inventoryCliUrl, 'dist/src/request-capture/inventory-cli.js');
  const { base, root } = await fixture(t); await initStore(root);
  const receipt = await addReceipt(root, Buffer.from(`direct ${SECRET}`));
  const harness = await harnessDir(t);
  const before = await snapshot(base);
  // The clean direct case is offset CLEAN_EXIT (win32: partial exit 3); invalid invocations stay 42 everywhere.
  for (const [args, expected, clean] of [[['--root', root], 40 + CLEAN_EXIT, true], [['--root', root, '--limit', '0'], 42, false], [['--root', 'relative'], 42, false]] as const) {
    const casePath = path.join(harness, `case-${expected}-${args.length}.mjs`);
    await fs.writeFile(casePath, `const m = await import(${JSON.stringify(inventoryCliUrl.href)});
const code = await m.runInventory(${JSON.stringify(args)});
process.exitCode = typeof code === 'number' ? 40 + code : 99;`);
    const out = await runNode(t, casePath, [], { root });
    assert.equal(out.code, expected, JSON.stringify(out));
    sanitized(out, [root, base]);
    if (clean) {
      assertReadOnly(out.events);
      const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
      assertClean(inventory, typeof out.code === 'number' ? out.code - 40 : out.code);
      assert.deepEqual(inventory.items.map(item => item.capture_id), [receipt.capture_id]);
    } else {
      assert.deepEqual(out.events, [], 'invalid invocation reads nothing');
    }
  }
  assert.equal(await snapshot(base), before);
});

async function packageCopy(base: string, withModule: boolean): Promise<string> {
  const pkg = path.join(base, 'package space 한글');
  await fs.mkdir(path.join(pkg, 'bin'), { recursive: true });
  await fs.copyFile(inventoryWrapper, path.join(pkg, 'bin', 'request-capture-inventory.mjs'));
  await fs.writeFile(path.join(pkg, 'package.json'), '{"type":"module"}');
  if (withModule) {
    for (const dir of ['request-capture', 'session/persistence']) {
      const source = path.join(repoRoot, 'dist', 'src', dir);
      const destination = path.join(pkg, 'dist', 'src', dir);
      await fs.mkdir(destination, { recursive: true });
      for (const name of await fs.readdir(source)) if (name.endsWith('.js')) await fs.copyFile(path.join(source, name), path.join(destination, name));
    }
  }
  return pkg;
}

for (const kind of ['default-layout', 'copied-explicit', 'copied-no-package', 'missing-module', 'broken-module']) {
  test(`inventory wrapper resolution: ${kind}`, async t => {
    await requireWrapper();
    const { base, root } = await fixture(t); await initStore(root);
    const workspace = await harnessDir(t);
    await addReceipt(root, Buffer.from(`wrapper ${SECRET}`));
    const pkg = await packageCopy(workspace, kind === 'default-layout' || kind === 'copied-explicit' || kind === 'broken-module');
    if (kind === 'broken-module') await fs.writeFile(path.join(pkg, 'dist/src/request-capture/inventory-cli.js'), 'export { syntax invalid');
    let executable = path.join(pkg, 'bin', 'request-capture-inventory.mjs');
    const args = ['--root', root];
    if (kind.startsWith('copied')) {
      executable = path.join(workspace, 'copied wrapper 한글.mjs'); await fs.copyFile(inventoryWrapper, executable);
      if (kind === 'copied-explicit') args.push('--package-root', pkg);
    }
    const out = await runNode(t, executable, args, { root });
    sanitized(out, [root, base]);
    if (kind === 'default-layout' || kind === 'copied-explicit') {
      const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
      assertClean(inventory, out.code);
    } else {
      assert.equal(out.code, 2, JSON.stringify(out));
      assert.deepEqual(out.events, [], 'module failure reads nothing from the store');
      if (out.stdout !== '') documentOf(out);
    }
  });
}

test('inventory package declaration: manifest entry, shipped bin/** and dist, README command', async () => {
  await requireWrapper();
  const manifest = await fs.readFile(path.join(repoRoot, 'bin', 'init', 'manifest.mjs'), 'utf8');
  assert.match(manifest, /"bin\/request-capture-inventory\.mjs"/);
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('bin') && pkg.files.includes('dist/src'));
  assert.match(await fs.readFile(path.join(repoRoot, 'README.md'), 'utf8'), /request-capture-inventory/);
  const wrapperText = await fs.readFile(inventoryWrapper, 'utf8');
  assert.match(wrapperText, /inventory-cli\.js/);
  assert.doesNotMatch(wrapperText, /child_process|execSync|spawn\(/, 'no arbitrary shell in the wrapper');
});

// #1166 regression gap (surviving no-drift-check mutant): directory-identity drift alone.
// Mid-scan, a writer creates and removes an entry in raw/: no file read is affected and no
// entry remains, so only the before/after directory identity comparison can observe it.
test('inventory: isolated raw/ directory drift is partial; a drift-check-removed mutant is discriminated', async t => {
  await requireWrapper();
  const { base, root } = await fixture(t); await initStore(root);
  const receipt = await addReceipt(root, Buffer.from(`drift ${SECRET}`));
  const out = await cli(t, root, [], { mode: 'raw-drift' });
  assert.ok(out.events.some(event => event.op === 'drift'), 'drift boundary reached');
  assert.ok(!out.events.some(event => event.rel === 'raw/drift-writer.tmp'), 'injected writer is not counted as inventory IO');
  assertReadOnly(out.events); assertObserved(out.events); sanitized(out, [root, base]);
  const inventory = documentOf(out); checkInventory(inventory, [root, base, SECRET]);
  assert.equal(out.code, 3); assert.equal(inventory.complete, false);
  assert.deepEqual([...codes(inventory)], ['changed_during_scan'], 'drift is the only observation');
  assert.deepEqual(inventory.items.map(item => item.capture_id), [receipt.capture_id]);
  assert.equal(await exists(path.join(root, 'raw', 'drift-writer.tmp')), false);

  // Discrimination: the same scenario against a package copy whose compiled directory drift check is removed.
  const workspace = await harnessDir(t);
  const pkg = await packageCopy(workspace, true);
  const compiled = path.join(pkg, 'dist', 'src', 'request-capture', 'inventory.js');
  const text = await fs.readFile(compiled, 'utf8');
  const check = 'anomalies.add("changed_during_scan");\n        }';
  assert.ok(text.includes(check), 'compiled directory drift check located');
  await fs.writeFile(compiled, text.replace(check, '}'));
  const mutant = await runNode(t, path.join(pkg, 'bin', 'request-capture-inventory.mjs'), ['--root', root], { root, mode: 'raw-drift' });
  assert.ok(mutant.events.some(event => event.op === 'drift'), 'mutant drift boundary reached');
  const missed = documentOf(mutant);
  assert.equal(codes(missed).has('changed_during_scan'), false, 'mutant cannot observe the drift');
  // POSIX: the mutant would wrongly claim complete (exit 0). win32: never complete, so only the code discriminates.
  assertClean(missed, mutant.code);
});
