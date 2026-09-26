import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// tsconfig.json includes tests/**/*.ts; scripts/run-tests.mjs:16-35 recursively
// enumerates .test.js. No runner changes or platform skips are required.
const moduleUrl = new URL('../../src/request-capture/receipt.js', import.meta.url);
const MAX_BYTES = 32_768;

// Serialized only after TypeScript compilation, so the child body is typechecked.
// The CJS child installs observation before importing the actual ESM product.
async function worker(): Promise<void> {
  const realFs = require('node:fs') as typeof import('node:fs');
  const io = realFs.promises;
  const p = require('node:path') as typeof import('node:path');
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const [url, root, observed, restart] = process.argv.slice(2);
  const raw = Buffer.from([0, 255, 13, 10, 237, 149, 156, 0, 128]);
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  type Event = { role: string; operation: string; flags: number | null;
    code: string | null; errno: number | null };
  let active = false;
  let events: Event[] = [];
  let firstFailure: Event | null = null;
  let firstNonProbeFailure: Event | null = null;
  let dropped = 0;
  let phase = restart === 'yes' ? 'restart' : 'first';
  const send = (value: unknown): void => { if (process.send) process.send(value); };
  function role(value: unknown): string {
    if (typeof value !== 'string') return 'other';
    const rel = p.relative(root, value);
    if (p.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${p.sep}`)) return 'other';
    const head = rel.split(p.sep)[0];
    if (head.startsWith('store.json.lock')) return 'lock';
    if (head === 'store.json' || head.startsWith('store.json.tmp.')) return 'marker';
    if (head === 'raw') return 'blob';
    if (head === 'receipts') return 'receipt';
    return 'other';
  }
  function record(area: string, operation: string, flags: number | null, error?: unknown): void {
    if (!active) return;
    const e = error as NodeJS.ErrnoException | undefined;
    const event: Event = { role: area, operation, flags,
      code: typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(e.code) ? e.code : null,
      errno: typeof e?.errno === 'number' && Number.isSafeInteger(e.errno) ? e.errno : null };
    if (events.length < 96) events.push(event); else dropped++;
    if (error !== undefined) {
      if (!firstFailure) firstFailure = event;
      // Missing-entry probes are expected by statIfPresent. Preserve them above,
      // but keep an independent first failure slot so they cannot mask sync errno.
      if (!firstNonProbeFailure && !(operation === 'lstat' && event.code === 'ENOENT')) {
        firstNonProbeFailure = event;
        send({ kind: 'boundary', phase, event });
      }
    }
  }
  if (observed === 'yes') {
    // Local casts accommodate Node's overloaded methods; original arguments,
    // receiver, resolved value, handle identity, and thrown object are retained.
    type Method = (this: unknown, ...args: any[]) => Promise<any>;
    const methods = io as unknown as Record<string, Method>;
    for (const name of ['open', 'lstat', 'mkdir', 'rename', 'unlink', 'link', 'readFile']) {
      const original = methods[name];
      methods[name] = async function (this: unknown, ...args: any[]): Promise<any> {
        const area = role(args[0]);
        const flags = name !== 'open' ? null : typeof args[1] === 'number' ? args[1]
          : args[1] === 'r' ? realFs.constants.O_RDONLY
          : args[1] === 'w' ? realFs.constants.O_WRONLY | realFs.constants.O_CREAT | realFs.constants.O_TRUNC
          : null;
        let result;
        try { result = await original.apply(this, args); }
        catch (error) { record(area, name, flags, error); throw error; }
        record(area, name, flags);
        if (name === 'open') {
          for (const method of ['stat', 'readFile', 'writeFile', 'sync', 'close']) {
            const delegated = result[method] as Method;
            result[method] = async function (this: unknown, ...handleArgs: any[]): Promise<any> {
              let value;
              try { value = await delegated.apply(this, handleArgs); }
              catch (error) { record(area, method, flags, error); throw error; }
              record(area, method, flags);
              return value;
            };
          }
        }
        return result;
      };
    }
    (require('node:module') as typeof import('node:module')).syncBuiltinESMExports();
  }
  type Receipt = { capture_id: string; original_ref: string; sha256: string; byte_len: number };
  const loaded = await import(url) as {
    captureSubmittedPrompt: (bytes: Uint8Array, options: { root: string }) => Promise<Receipt>;
  };
  // Verification uses real operations with observation disabled. Fixed messages
  // prevent assertion diffs, filenames, or product exceptions escaping via IPC.
  const previous = new Map<string, string>();
  if (restart === 'yes') {
    let names: string[] = [];
    try { names = await io.readdir(p.join(root, 'receipts')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const name of names) {
      previous.set(name, await io.readFile(p.join(root, 'receipts', name), 'utf8'));
    }
  }
  for (let index = 0; index < (restart === 'yes' ? 1 : 2); index++) {
    phase = restart === 'yes' ? 'restart' : index === 0 ? 'first' : 'repeat';
    events = []; firstFailure = null; firstNonProbeFailure = null; dropped = 0;
    let ok = false;
    let stage = 'capture';
    try {
      active = true;
      const receipt = await loaded.captureSubmittedPrompt(raw, { root });
      active = false;
      stage = 'verification';
      // Still attempt restart after an earlier failure, but never accept an
      // incomplete prior run merely because this new capture succeeds.
      if (previous.size !== (restart === 'yes' ? 2 : index)) throw new Error('prior count');
      const names = await io.readdir(p.join(root, 'receipts'));
      if (names.length !== previous.size + 1 || previous.has(`${receipt.capture_id}.json`)) {
        throw new Error('distinct receipts');
      }
      if (!/^[0-9a-f-]{36}$/.test(receipt.capture_id) || receipt.sha256 !== digest
        || receipt.byte_len !== raw.length || receipt.original_ref !== `raw/${digest}.bin`) {
        throw new Error('receipt shape');
      }
      if (!(await io.readFile(p.join(root, receipt.original_ref))).equals(raw)) throw new Error('bytes');
      for (const [name, bytes] of previous) {
        if (await io.readFile(p.join(root, 'receipts', name), 'utf8') !== bytes) throw new Error('prior receipt');
      }
      const name = `${receipt.capture_id}.json`;
      const saved = await io.readFile(p.join(root, 'receipts', name), 'utf8');
      if (JSON.stringify(JSON.parse(saved)) !== JSON.stringify(receipt)) throw new Error('saved receipt');
      previous.set(name, saved);
      ok = true;
    } catch {
      process.exitCode = 23;
    } finally {
      active = false;
      send({ kind: 'phase', phase, ok, stage, events, firstFailure, firstNonProbeFailure, dropped });
    }
    if (!ok) break;
  }
  process.disconnect();
}

type Result = { code: number | null; timedOut: boolean; overflow: boolean; spawnFailed: boolean;
  outputBytes: number; messages: unknown[] };

test('receipt reuse diagnostic: real baseline and observed repeat/restart', { timeout: 115_000 }, async t => {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'receipt-reuse-diagnostic-'));
  const roots: string[] = [];
  const children: { child: ReturnType<typeof fork>; done: Promise<Result> }[] = [];
  t.after(async () => {
    for (const { child, done } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    }
    try {
      for (const directory of [base, ...roots]) {
        assert.equal(await fs.readFile(path.join(directory, 'sentinel'), 'utf8'), 'untouched');
      }
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  await fs.writeFile(path.join(base, 'sentinel'), 'untouched');
  const workerPath = path.join(base, 'worker.cjs');
  await fs.writeFile(workerPath, `(${worker.toString()})().catch(() => { process.exitCode = 24; if (process.connected) process.disconnect(); });`);
  async function run(root: string, observed: boolean, restart: boolean): Promise<Result> {
    const child = fork(workerPath, [moduleUrl.href, root, observed ? 'yes' : 'no', restart ? 'yes' : 'no'], {
      execPath: process.execPath, execArgv: [], silent: true, cwd: base,
      env: { TMPDIR: base, TEMP: base, TMP: base },
    });
    const result: Result = { code: null, timedOut: false, overflow: false, spawnFailed: false,
      outputBytes: 0, messages: [] };
    let messageBytes = 0;
    child.on('message', message => {
      messageBytes += Buffer.byteLength(JSON.stringify(message));
      if (messageBytes > MAX_BYTES || result.messages.length >= 8) {
        result.overflow = true; child.kill('SIGKILL');
      } else result.messages.push(message);
    });
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.on('data', (chunk: Buffer) => {
        result.outputBytes = Math.min(MAX_BYTES + 1, result.outputBytes + chunk.length);
        if (result.outputBytes > MAX_BYTES) { result.overflow = true; child.kill('SIGKILL'); }
      });
    }
    const done = new Promise<Result>(resolve => {
      const timer = setTimeout(() => { result.timedOut = true; child.kill('SIGKILL'); }, 25_000);
      child.once('error', () => { result.spawnFailed = true; });
      child.once('close', code => { clearTimeout(timer); result.code = code; resolve(result); });
    });
    children.push({ child, done });
    return done;
  }
  const results: Result[] = [];
  // Finish and retain the uninstrumented control before installing any wrappers
  // in separate children. A failed control never prevents the observed diagnostic.
  for (const observed of [false, true]) {
    const root = path.join(base, observed ? 'observed' : 'baseline');
    await fs.mkdir(root, { mode: 0o700 });
    roots.push(root);
    await fs.writeFile(path.join(root, 'sentinel'), 'untouched');
    for (const restart of [false, true]) {
      const result = await run(root, observed, restart);
      results.push(result);
      t.diagnostic(JSON.stringify({ control: observed ? 'observed' : 'baseline', restart,
        perturbation: observed ? 'real-method wrappers; added promise turns and bounded IPC' : 'none',
        proof: 'diagnostic only; durability, ordinary-user access and privacy unmeasured', ...result }));
    }
  }
  // Diagnostics precede every success assertion, including baseline failures.
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    assert.equal(result.code, 0, 'capture/verification child must succeed');
    assert.equal(result.timedOut || result.overflow || result.spawnFailed, false, 'child bounds');
    assert.equal(result.outputBytes, 0, 'unexpected child output (content withheld)');
    const phases = result.messages.filter((message): message is { kind: string; phase: string; ok: boolean } =>
      typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'phase');
    assert.deepEqual(phases.map(message => message.phase), index % 2 === 0 ? ['first', 'repeat'] : ['restart']);
    assert.equal(phases.every(message => message.ok), true, 'all receipt and byte checks must pass');
  }
});
