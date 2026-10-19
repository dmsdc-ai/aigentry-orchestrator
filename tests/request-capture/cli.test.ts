import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const cli = new URL('../../src/request-capture/cli.js', import.meta.url);
const wrapper = fileURLToPath(new URL('../../../bin/hook-prompt-submit.mjs', import.meta.url));
const secret = 'RAW_SECRET_1166';
const digest = (raw: Buffer): string => createHash('sha256').update(raw).digest('hex');
type Receipt = { capture_id: string; original_ref: string; byte_len: number; sha256: string;
  provenance: string; task_binding: string; durability: string };
type Exit = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };
type Run = { preloadPath: string; child: ChildProcess; done: Promise<Exit>; output: () => string; messages: string[];
  wait: (message: string) => Promise<void> };

async function fixture(t: TestContext): Promise<{ base: string; root: string }> {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'capture-cli-'));
  const root = path.join(base, 'private store 한글');
  await fs.mkdir(root, { mode: 0o700 });
  for (const dir of [base, root]) await fs.writeFile(path.join(dir, 'sentinel'), 'preserve');
  t.after(async () => {
    try {
      for (const dir of [base, root]) assert.equal(await fs.readFile(path.join(dir, 'sentinel'), 'utf8'), 'preserve');
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  return { base, root };
}

// Isolated instrumentation of the actual immutable persistence APIs. No capture
// implementation is replaced. IPC proves that each requested boundary was hit.
const preload = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const mode = process.env.CAPTURE_TEST_FAULT;
const root = process.env.CAPTURE_TEST_ROOT;
const send = value => { if (process.send) process.send(value); };
const renamed = new Set();
const lock = path.join(root, 'store.json.lock');
let probed = false;
function section(value) { return path.relative(root, String(value)).split(path.sep)[0]; }
async function hit(op, value, handle) {
  const area = section(value);
  if (mode === 'receipt-barrier' && area === 'receipts' && op === 'write') {
    send('barrier'); await new Promise(resolve => process.once('message', resolve));
  }
  let fail = mode === 'blob-write' && area === 'raw' && op === 'write'
    || mode === 'receipt-write' && area === 'receipts' && op === 'write'
    || mode === 'lock-release' && op === 'unlink' && value === path.join(root, 'store.json.lock')
    || mode === 'lock-acquire' && op === 'link'
    || mode === 'receipt-rename' && op === 'rename' && area === 'receipts';
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
    const result = await original.call(this, value, ...args).catch(error => {
      if (name === 'link' && probed) send('contended'); throw error;
    });
    if (name === 'rename') renamed.add(section(args[0]));
    if (name === 'link' && String(args[0]) === lock) {
      send(probed ? 'locked-after-probe' : 'locked');
      if (mode === 'hold-after-link') await new Promise(resolve => process.once('message', resolve));
    }
    return result;
  };
}
if (mode === 'stale-probe') {
  // process.kill is synchronous in the lock's liveness probe: emulate a descheduled
  // waiter by sleeping until the test-owned release file exists (bounded).
  const kill = process.kill; const release = path.join(path.dirname(root), 'stale-probe-release');
  process.kill = function(pid, signal) {
    if (signal === 0 && !probed) {
      probed = true; send('probe'); const cell = new Int32Array(new SharedArrayBuffer(4));
      for (const deadline = Date.now() + 10000; !fs.existsSync(release) && Date.now() < deadline;) Atomics.wait(cell, 0, 0, 5);
    }
    return kill.call(this, pid, signal);
  };
}
if (mode === 'weak-durability') {
  // Only the receipt writer sees win32 (so it records file-fsync-only); the hook still
  // decides on the real POSIX platform.
  const real = process.platform;
  Object.defineProperty(process, 'platform', {
    get: () => /request-capture\/receipt\.js:/.test(new Error().stack ?? '') ? 'win32' : real });
}
if (mode === 'windows-host') Object.defineProperty(process, 'platform', { value: 'win32' });
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
// Buffered observation adds no probes/retries; exit receipt is outside the store.
if (mode === 'observe-concurrent') {
  const { createHash } = require('node:crypto');
  const events = []; let sequence = 0; let overflow = false;
  const hash = value => createHash('sha256').update(String(value)).digest('hex');
  const area = value => {
    const relative = path.relative(root, String(value));
    if (relative === '') return 'root';
    if (relative === 'store.json') return 'marker';
    if (relative === 'store.json.lock') return 'lock';
    if (relative.startsWith('store.json.lock.tmp.')) return 'lock-stage';
    if (relative.split(path.sep)[0] === 'raw') return 'raw';
    if (relative.split(path.sep)[0] === 'receipts') return 'receipt';
    return 'other';
  };
  const record = (operation, value, stage, id, result, error) => {
    if (events.length >= 2048) { overflow = true; return; }
    const code = typeof error?.code === 'string' && /^E[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code : null;
    events.push({ sequence: ++sequence, id, operation, area: area(value), stage,
      tick: process.hrtime.bigint().toString(), code, target: hash(path.relative(root, String(value))),
      identity: result && typeof result === 'object' && 'ino' in result && 'dev' in result
        ? hash(String(result.dev) + ':' + String(result.ino)) : null });
  };
  const wrap = (object, name, target, opened = false) => {
    const original = object[name];
    object[name] = async function(...args) {
      const value = opened ? target : args[0];
      const id = sequence + 1; record(name, value, 'begin', id);
      try {
        const result = await original.apply(this, args);
        record(name, value, 'ok', id, result);
        if (name === 'open') {
          for (const method of ['stat', 'readFile', 'writeFile', 'write', 'sync', 'datasync', 'close'])
            wrap(result, method, value, true);
        }
        return result;
      } catch (error) {
        record(name, value, 'error', id, null, error);
        throw error;
      }
    };
  };
  for (const name of ['open', 'lstat', 'stat', 'mkdir', 'readFile', 'unlink', 'link', 'rename'])
    wrap(p, name);
  const kill = process.kill;
  process.kill = function(pid, signal) {
    if (signal !== 0) return kill.call(this, pid, signal);
    const id = sequence + 1;
    record('liveness', 'pid-' + hash(pid), 'begin', id);
    try {
      const result = kill.call(this, pid, signal);
      record('liveness', 'pid-' + hash(pid), 'ok', id); return result;
    } catch (error) {
      record('liveness', 'pid-' + hash(pid), 'error', id, null, error); throw error;
    }
  };
  process.once('exit', () => {
    try {
      fs.writeFileSync(__filename + '.diagnostic.json',
        JSON.stringify({ version: 1, overflow, events }), { flag: 'wx', mode: 0o600 });
    } catch { /* Missing receipt means unavailable to the parent. */ }
  });
}
syncBuiltinESMExports();
send('ready');
`;

async function launch(t: TestContext, base: string, root: string, args = ['--root', root],
  mode = '', executable = wrapper): Promise<Run> {
  const preloadPath = path.join(await fs.mkdtemp(path.join(base, 'process-')), 'preload.cjs');
  await fs.writeFile(preloadPath, preload);
  const child = fork(executable, args, { execPath: process.execPath, execArgv: ['--require', preloadPath],
    silent: true, cwd: base, env: { TMPDIR: base, TEMP: base, TMP: base,
      CAPTURE_TEST_FAULT: mode, CAPTURE_TEST_ROOT: root, HOME: base } });
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
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  void done.finally(() => clearTimeout(timer)).catch(() => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  const wait = async (message: string): Promise<void> => {
    if (messages.includes(message)) return;
    await new Promise<void>((resolve, reject) => {
      const listener = (value: unknown): void => {
        if (value === message) { child.off('message', listener); resolve(); }
      };
      child.on('message', listener);
      void done.then(result => { child.off('message', listener); reject(new Error(`Missing ${message}: ${JSON.stringify(result)}`)); }, reject);
    });
  };
  return { preloadPath, child, done, output: () => stdout, messages, wait };
}

function block(result: Exit, root: string): void {
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.signal, null);
  assert.match(result.stdout, /^[^\r\n]+\n$/);
  const response = JSON.parse(result.stdout) as { decision: string; reason: string };
  assert.equal(response.decision, 'block');
  assert.equal(typeof response.reason, 'string');
  assert.ok(response.reason.length > 0);
  for (const value of [secret, root]) assert.equal((result.stdout + result.stderr).includes(value), false);
  assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+|Error:/);
}
function allow(result: Exit): void {
  assert.deepEqual(result, { code: 0, signal: null, stdout: '{}\n', stderr: '' });
}
async function receipts(root: string): Promise<Receipt[]> {
  let names: string[];
  try { names = await fs.readdir(path.join(root, 'receipts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    const receipt = JSON.parse(await fs.readFile(path.join(root, 'receipts', name), 'utf8')) as Receipt;
    assert.equal(name, `${receipt.capture_id}.json`); return receipt;
  }));
}
async function evidence(root: string, raw: Buffer, count: number): Promise<Receipt[]> {
  const rows = await receipts(root); assert.equal(rows.length, count);
  assert.equal(new Set(rows.map(row => row.capture_id)).size, count);
  for (const row of rows) {
    assert.equal(row.sha256, digest(raw)); assert.equal(row.byte_len, raw.length);
    assert.equal(row.original_ref, `raw/${digest(raw)}.bin`);
    assert.equal(row.provenance, 'unverified'); assert.equal(row.task_binding, 'pending');
    assert.deepEqual(await fs.readFile(path.join(root, row.original_ref)), raw);
  }
  return rows;
}

test('CLI exports runCaptureHook and import has no IO side effects', async t => {
  const { base, root } = await fixture(t);
  const probe = path.join(base, 'import.mjs');
  await fs.writeFile(probe, `import assert from 'node:assert/strict';
const events = process.eventNames().map(String); const stdinEvents = process.stdin.eventNames().map(String);
const m = await import(${JSON.stringify(cli.href)});
assert.equal(typeof m.runCaptureHook, 'function');
assert.deepEqual(process.eventNames().map(String), events);
assert.deepEqual(process.stdin.eventNames().map(String), stdinEvents);`);
  const run = await launch(t, base, root, [], '', probe);
  const result = await run.done;
  assert.deepEqual(result, { code: 0, signal: null, stdout: '', stderr: '' });
  assert.deepEqual(await fs.readdir(root), ['sentinel']);
});

for (const [name, raw] of [
  ['split binary Unicode CRLF NUL beyond pipe buffer', Buffer.concat([Buffer.from(`${secret}\r\n한글😀\0`.repeat(12000)), Buffer.from(Array.from({ length: 256 }, (_, i) => i))])],
  ['invalid JSON', Buffer.from(`{${secret}`)], ['empty', Buffer.alloc(0)],
] as const) {
  test(`exact stdin capture: ${name}`, async t => {
    const { base, root } = await fixture(t); const run = await launch(t, base, root);
    for (let offset = 0; offset < raw.length; offset += 997) run.child.stdin!.write(raw.subarray(offset, offset + 997));
    run.child.stdin!.end(); allow(await run.done); await evidence(root, raw, 1);
  });
}

test('same bytes twice create distinct receipts', async t => {
  const { base, root } = await fixture(t); const raw = Buffer.from(secret);
  for (let i = 0; i < 2; i++) { const run = await launch(t, base, root); run.child.stdin!.end(raw); allow(await run.done); }
  await evidence(root, raw, 2);
  assert.deepEqual(await fs.readdir(path.join(root, 'raw')), [`${digest(raw)}.bin`]);
});

// Copy outside base before fixture cleanup; incomplete/overflow evidence fails closed.
async function retainConcurrent(base: string, root: string, raw: Buffer,
  runs: Array<Run | undefined>): Promise<boolean> {
  const settled = await Promise.allSettled(runs.map(run => run?.done));
  const summary: Record<string, unknown> = {
    version: 1, expectedChildren: 8, expectedSha256: digest(raw), expectedBytes: raw.length,
    platform: process.platform, node: process.version, status: 'unavailable',
    outcomes: settled.map((result, index) => {
      if (result.status !== 'fulfilled' || !result.value) return { index, status: 'unavailable' };
      const value = result.value;
      return { index, status: 'closed', code: value.code, signal: value.signal,
        stdoutBytes: Buffer.byteLength(value.stdout), stdoutSha256: digest(Buffer.from(value.stdout)),
        stderrBytes: Buffer.byteLength(value.stderr), stderrSha256: digest(Buffer.from(value.stderr)),
        allowed: value.stdout === '{}\n' && value.code === 0 && value.signal === null && value.stderr === '' };
    }),
  };
  let retained: string | undefined;
  let complete = false;
  try {
    retained = await fs.mkdtemp(path.join(tmpdir(), 'capture-concurrent-evidence-'));
    let total = 0; let entries = 0;
    const inventory: Array<{ name: string; bytes: number; sha256: string }> = [];
    const observations: unknown[] = [];
    const copy = async (directory: string, relative = ''): Promise<void> => {
      for (const name of (await fs.readdir(directory)).sort()) {
        if (++entries > 128) throw new Error('diagnostic entry overflow');
        const source = path.join(directory, name); const rel = path.join(relative, name);
        const stat = await fs.lstat(source);
        if (stat.isSymbolicLink()) throw new Error('diagnostic symlink unavailable');
        const destination = path.join(retained!, 'fixture', rel);
        if (stat.isDirectory()) {
          await fs.mkdir(destination, { recursive: true, mode: 0o700 }); await copy(source, rel);
        } else {
          if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('diagnostic file overflow');
          const bytes = await fs.readFile(source);
          total += bytes.length;
          if (bytes.length > 1024 * 1024 || total > 2 * 1024 * 1024) throw new Error('diagnostic byte overflow');
          await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          await fs.writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
          inventory.push({ name: digest(Buffer.from(rel)), bytes: bytes.length, sha256: digest(bytes) });
          if (name === 'preload.cjs.diagnostic.json') observations.push({
            childIndex: runs.findIndex(run => run && source === run.preloadPath + '.diagnostic.json'),
            ...JSON.parse(bytes.toString('utf8')),
          });
        }
      }
    };
    summary.inventory = inventory; summary.observations = observations;
    await copy(base);
    const retainedRoot = path.join(retained, 'fixture', path.relative(base, root));
    const names = (await fs.readdir(path.join(retainedRoot, 'receipts'))).sort();
    const rawNames = (await fs.readdir(path.join(retainedRoot, 'raw'))).sort();
    summary.receiptFiles = names.length; summary.rawFiles = rawNames.length;
    const rows = await receipts(retainedRoot);
    const matches = rows.map(row => ({
      captureIdSha256: digest(Buffer.from(row.capture_id)),
      matches: row.sha256 === digest(raw) && row.byte_len === raw.length
        && row.original_ref === 'raw/' + digest(raw) + '.bin'
        && row.provenance === 'unverified' && row.task_binding === 'pending',
      durability: row.durability === 'file-fsync-only' || row.durability === 'file-and-directory-fsync'
        ? row.durability : 'unknown',
    }));
    const blobMatches = rawNames.length === 1 && rawNames[0] === digest(raw) + '.bin'
      && (await fs.readFile(path.join(retainedRoot, 'raw', rawNames[0]))).equals(raw);
    Object.assign(summary, { inventory, observations, receiptFiles: names.length,
      parsedReceipts: rows.length, distinctReceipts: new Set(rows.map(row => row.capture_id)).size,
      receipts: matches, rawFiles: rawNames.length, blobMatches,
      markerMatches: JSON.stringify(JSON.parse(await fs.readFile(path.join(retainedRoot, 'store.json'), 'utf8')))
        === JSON.stringify({ schema_version: 1, kind: 'request-capture' }) });
    complete = observations.length === 8
      && new Set(observations.map(value => (value as { childIndex: number }).childIndex)).size === 8 && observations.every(value => {
      const observation = value as { childIndex: number; version?: unknown; overflow?: unknown; events?: unknown };
      return observation.childIndex >= 0 && observation.version === 1 && observation.overflow === false && Array.isArray(observation.events);
    }) && settled.every(value => value.status === 'fulfilled' && value.value !== undefined);
    summary.status = complete ? 'complete' : 'unavailable';
  } catch {
    summary.status = 'unavailable'; // No exception text, stack or host path.
  }
  let encoded = JSON.stringify(summary);
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) {
    complete = false;
    encoded = JSON.stringify({ version: 1, status: 'overflow', outcomes: summary.outcomes });
  }
  if (retained) {
    try { await fs.writeFile(path.join(retained, 'summary.json'), encoded, { flag: 'wx', mode: 0o600 }); }
    catch { complete = false; encoded = JSON.stringify({ version: 1, status: 'unavailable', outcomes: summary.outcomes }); }
  }
  console.log('# capture-concurrent ' + encoded);
  return complete;
}

test('concurrent real child captures retain every receipt', async t => {
  const { base, root } = await fixture(t); const raw = Buffer.from(secret);
  const observed: Array<Run | undefined> = Array.from({ length: 8 });
  let diagnosticComplete = false;
  try {
    const launches = await Promise.allSettled(observed.map(async (_, index) => {
      const run = await launch(t, base, root, undefined, 'observe-concurrent');
      observed[index] = run; return run;
    }));
    const runs = launches.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    await Promise.all(runs.map(run => run.wait('ready')));
    for (const run of runs) run.child.stdin!.end(raw);
    for (const result of await Promise.all(runs.map(run => run.done))) allow(result);
    await evidence(root, raw, 8);
  } finally {
    diagnosticComplete = await retainConcurrent(base, root, raw, observed);
  }
  assert.equal(diagnosticComplete, true, 'concurrent diagnostic evidence unavailable or overflow');
});

// #1166: the holder releases and exits between a waiter's lock read and its liveness
// probe, and a successor links the lock. The stale sweep must not remove that lock.
test('stale-lock sweep never removes a successor lock', async t => {
  const { base, root } = await fixture(t); const raw = Buffer.from(secret);
  const seed = await launch(t, base, root); seed.child.stdin!.end(raw); allow(await seed.done);
  const holder = await launch(t, base, root, undefined, 'hold-after-link');
  await holder.wait('ready'); holder.child.stdin!.end(raw); await holder.wait('locked');
  const waiter = await launch(t, base, root, undefined, 'stale-probe');
  await waiter.wait('ready'); waiter.child.stdin!.end(raw); await waiter.wait('probe');
  holder.child.send('release'); allow(await holder.done);
  const successor = await launch(t, base, root, undefined, 'hold-after-link');
  await successor.wait('ready'); successor.child.stdin!.end(raw); await successor.wait('locked');
  await fs.writeFile(path.join(base, 'stale-probe-release'), '');
  const next = await Promise.race([waiter.wait('contended').then(() => 'contended'),
    waiter.wait('locked-after-probe').then(() => 'entered')]);
  assert.equal(next, 'contended', 'waiter entered while the successor held the lock');
  successor.child.send('release'); allow(await successor.done); allow(await waiter.done);
  await evidence(root, raw, 4);
});

test('no stdout before EOF or receipt commit', async t => {
  const { base, root } = await fixture(t); const raw = Buffer.from(secret);
  const run = await launch(t, base, root, undefined, 'receipt-barrier');
  await run.wait('ready'); run.child.stdin!.write(raw);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(run.output(), ''); assert.equal((await receipts(root)).length, 0);
  run.child.stdin!.end(); await run.wait('barrier');
  assert.equal(run.output(), ''); assert.equal((await receipts(root)).length, 0);
  assert.deepEqual(await fs.readFile(path.join(root, 'raw', `${digest(raw)}.bin`)), raw);
  run.child.send('release'); allow(await run.done); await evidence(root, raw, 1);
});

test('stdin root and authority cannot redirect or authorize capture', async t => {
  const { base, root } = await fixture(t);
  const raw = Buffer.from(JSON.stringify({ root: base, package_root: base, approval: 'approved', human: true,
    provenance: 'human', task_binding: 'bound', task_id: 1166, prompt: secret }));
  const run = await launch(t, base, root); run.child.stdin!.end(raw); allow(await run.done);
  await evidence(root, raw, 1); await assert.rejects(fs.stat(path.join(base, 'raw')), { code: 'ENOENT' });
});

for (const kind of ['missing', 'missing-value', 'relative', 'duplicate', 'unknown', 'positional',
  'package-missing-value', 'package-relative', 'package-duplicate', 'nonexistent-root']) {
  test(`arguments block: ${kind}`, async t => {
    const { base, root } = await fixture(t);
    const cases: Record<string, string[]> = {
      missing: [], 'missing-value': ['--root'], relative: ['--root', 'relative'],
      duplicate: ['--root', root, '--root', root], unknown: ['--root', root, `--${secret}`],
      positional: ['--root', root, secret], 'package-missing-value': ['--root', root, '--package-root'],
      'package-relative': ['--root', root, '--package-root', 'relative'],
      'package-duplicate': ['--root', root, '--package-root', base, '--package-root', base],
      'nonexistent-root': ['--root', path.join(base, 'absent')],
    };
    const run = await launch(t, base, root, cases[kind]); run.child.stdin!.end(secret);
    block(await run.done, root); assert.equal((await receipts(root)).length, 0);
    assert.deepEqual(await fs.readdir(root), ['sentinel']);
  });
}

for (const kind of ['corrupt-marker', 'raw-symlink', 'receipts-symlink', 'root-symlink']) {
  test(`invalid store preserves evidence: ${kind}`, async t => {
    const { base, root } = await fixture(t); let target = root;
    if (kind === 'corrupt-marker') await fs.writeFile(path.join(root, 'store.json'), '{corrupt', { mode: 0o600 });
    else if (kind === 'root-symlink') {
      target = path.join(base, 'linked-root'); await fs.symlink(root, target, 'dir');
    } else await fs.symlink(base, path.join(root, kind === 'raw-symlink' ? 'raw' : 'receipts'), 'dir');
    const run = await launch(t, base, root, ['--root', target]); run.child.stdin!.end(secret);
    block(await run.done, root); assert.equal((await receipts(root)).length, 0);
    if (kind === 'corrupt-marker') assert.equal(await fs.readFile(path.join(root, 'store.json'), 'utf8'), '{corrupt');
    else assert.equal((await fs.lstat(kind === 'root-symlink' ? target : path.join(root, kind === 'raw-symlink' ? 'raw' : 'receipts'))).isSymbolicLink(), true);
  });
}

// win32 has no directory fsync (P3): that fault moves to the receipt's rename/replace step.
const WIN32 = process.platform === 'win32';
for (const mode of ['blob-write', 'receipt-write', 'file-fsync', 'directory-fsync', 'lock-release', 'lock-acquire', 'stdin-error']) {
  test(`deterministic failure blocks: ${mode}`, async t => {
    const boundary = WIN32 && mode === 'directory-fsync' ? 'receipt-rename' : mode;
    const { base, root } = await fixture(t); const raw = Buffer.from(secret);
    const run = await launch(t, base, root, undefined, boundary); run.child.stdin!.end(raw);
    const result = await run.done; assert.ok(run.messages.includes('fault'), 'fault boundary must be reached');
    block(result, root);
    if (['directory-fsync', 'lock-release'].includes(boundary)) await evidence(root, raw, 1);
    else assert.equal((await receipts(root)).length, 0);
    if (mode === 'receipt-write') assert.deepEqual(await fs.readFile(path.join(root, 'raw', `${digest(raw)}.bin`)), raw);
    if (mode === 'lock-release') assert.ok((await fs.stat(path.join(root, 'store.json.lock'))).isFile());
  });
}

test('output error cannot yield successful exit', async t => {
  const { base, root } = await fixture(t); const run = await launch(t, base, root, undefined, 'stdout-error');
  run.child.stdin!.end(secret); const result = await run.done;
  assert.ok(run.messages.includes('fault')); assert.equal(result.signal, null); assert.equal(result.code, 2);
  assert.equal(result.stdout, ''); assert.equal(result.stderr.includes(secret), false);
  await evidence(root, Buffer.from(secret), 1);
});

if (!WIN32) test('simulated weaker durability visibly blocks but preserves evidence; not native Windows proof', async t => {
  const { base, root } = await fixture(t); const run = await launch(t, base, root, undefined, 'weak-durability');
  run.child.stdin!.end(secret); const result = await run.done; block(result, root);
  assert.match(result.stdout + result.stderr, /Windows|durability|directory|fsync/i);
  const rows = await evidence(root, Buffer.from(secret), 1); assert.equal(rows[0]!.durability, 'file-fsync-only');
});

// P3: file fsync + NTFS-journaled rename is the supported win32 level; capture proceeds and
// the receipt states it as file-fsync-only.
async function windowsLevelAllowed(t: TestContext, mode: string): Promise<void> {
  const { base, root } = await fixture(t); const run = await launch(t, base, root, undefined, mode);
  run.child.stdin!.end(secret); allow(await run.done);
  const rows = await evidence(root, Buffer.from(secret), 1); assert.equal(rows[0]!.durability, 'file-fsync-only');
}
if (WIN32) test('native Windows capture is allowed and the receipt states file-fsync-only', t => windowsLevelAllowed(t, ''));
else test('mocked Windows host allows file-fsync-only capture; not native Windows proof', t => windowsLevelAllowed(t, 'windows-host'));

// Copy exact runtime leaves into a realistic package layout, never rewrite them.
async function packageCopy(base: string, includeModule: boolean): Promise<string> {
  const pkg = path.join(base, 'package space 한글');
  await fs.mkdir(path.join(pkg, 'bin'), { recursive: true });
  await fs.copyFile(wrapper, path.join(pkg, 'bin/hook-prompt-submit.mjs'));
  await fs.writeFile(path.join(pkg, 'package.json'), '{"type":"module"}');
  if (includeModule) {
    for (const name of ['request-capture/cli.js', 'request-capture/receipt.js', 'session/persistence/atomic-write.js', 'session/persistence/index-lock.js']) {
      const destination = path.join(pkg, 'dist/src', name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), destination);
    }
  }
  return pkg;
}

for (const kind of ['missing-module', 'broken-module', 'default-layout', 'copied-explicit', 'copied-no-package']) {
  test(`wrapper resolution: ${kind}`, async t => {
    const { base, root } = await fixture(t);
    const pkg = await packageCopy(base, kind === 'default-layout' || kind === 'copied-explicit');
    if (kind === 'broken-module') {
      const dir = path.join(pkg, 'dist/src/request-capture'); await fs.mkdir(dir, { recursive: true });
      // A deliberately unparseable dependency tests bootstrap handling, not capture.
      await fs.writeFile(path.join(dir, 'cli.js'), 'export { syntax invalid');
    }
    let executable = path.join(pkg, 'bin/hook-prompt-submit.mjs'); const args = ['--root', root];
    if (kind.startsWith('copied')) {
      executable = path.join(base, 'copied wrapper 한글.mjs'); await fs.copyFile(wrapper, executable);
      if (kind === 'copied-explicit') args.push('--package-root', pkg);
    }
    const run = await launch(t, base, root, args, '', executable); run.child.stdin!.end(secret);
    const result = await run.done;
    if (kind === 'default-layout' || kind === 'copied-explicit') { allow(result); await evidence(root, Buffer.from(secret), 1); }
    else { block(result, root); assert.equal((await receipts(root)).length, 0); }
  });
}
