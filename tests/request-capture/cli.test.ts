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
type Run = { child: ChildProcess; done: Promise<Exit>; output: () => string; messages: string[];
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
  return { child, done, output: () => stdout, messages, wait };
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

test('concurrent real child captures retain every receipt', async t => {
  const { base, root } = await fixture(t); const raw = Buffer.from(secret);
  const runs = await Promise.all(Array.from({ length: 8 }, () => launch(t, base, root)));
  await Promise.all(runs.map(run => run.wait('ready')));
  for (const run of runs) run.child.stdin!.end(raw);
  for (const result of await Promise.all(runs.map(run => run.done))) allow(result);
  await evidence(root, raw, 8);
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

for (const mode of ['blob-write', 'receipt-write', 'file-fsync', 'directory-fsync', 'lock-release', 'lock-acquire', 'stdin-error']) {
  test(`deterministic failure blocks: ${mode}`, async t => {
    const { base, root } = await fixture(t); const raw = Buffer.from(secret);
    const run = await launch(t, base, root, undefined, mode); run.child.stdin!.end(raw);
    const result = await run.done; assert.ok(run.messages.includes('fault'), 'fault boundary must be reached');
    block(result, root);
    if (['directory-fsync', 'lock-release'].includes(mode)) await evidence(root, raw, 1);
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

test('simulated weaker durability visibly blocks but preserves evidence; not native Windows proof', async t => {
  const { base, root } = await fixture(t); const run = await launch(t, base, root, undefined, 'weak-durability');
  run.child.stdin!.end(secret); const result = await run.done; block(result, root);
  assert.match(result.stdout + result.stderr, /Windows|durability|directory|fsync/i);
  const rows = await evidence(root, Buffer.from(secret), 1); assert.equal(rows[0]!.durability, 'file-fsync-only');
});

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
