// #1204 — bin/context-compact.sh picks the compaction command from the session's CLI and, for the
// CLIs without a native restore hook (codex, gemini, agy, grok), starts a detached waiter that injects the
// snapshot restore line once the session has been busy and is idle again. The daemon is a tiny HTTP
// server serving /api/sessions from a mutable array (AIGENTRY_TELEPTY_API); telepty is a stub that
// appends its argv to a file (AIGENTRY_TELEPTY). Node built-ins only. win32 needs Git for Windows
// bash and skips the waiter case by name: the script starts no waiter there by design.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIN = process.platform === 'win32';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fwd = (p) => p.replace(/\\/g, '/');
const script = fwd(join(repoRoot, 'bin', 'context-compact.sh'));
const bash = WIN ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
const noBash = WIN && !existsSync(bash) ? `Git for Windows bash not found at ${bash}` : false;
const SID = 'orch-t1204';
const RESTORE_RE = /^CONTEXT SNAPSHOT restored after compact — (.+) \(written [^)]+\)\. Read it, then continue the work it describes\.$/;

const sessions = [];
const server = createServer((req, res) => {
  if (req.url.split('?')[0] !== '/api/sessions') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sessions));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const api = `http://127.0.0.1:${server.address().port}`;
const waiterPids = [];

after(() => {
  for (const pid of waiterPids) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
  server.close();
});

function setSession(command, fields = {}) {
  sessions.length = 0;
  sessions.push({ id: SID, command, ready: true, idleSeconds: 30, lastActivityAt: '2026-10-09T00:00:00Z', ...fields });
}

function workspace({ staleSeconds = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-compact-'));
  mkdirSync(join(dir, 'home'));
  const snap = join(dir, '.context-snapshot.md');
  writeFileSync(snap, '# snapshot\n');
  if (staleSeconds) { const t = Date.now() / 1000 - staleSeconds; utimesSync(snap, t, t); }
  const calls = join(dir, 'telepty-calls.txt');
  const stub = join(dir, 'telepty-stub');
  writeFileSync(stub, `#!/usr/bin/env bash\n{ for a in "$@"; do printf '%s\\t' "$a"; done; printf '\\n'; } >> '${fwd(calls)}'\n`);
  chmodSync(stub, 0o755);
  return { dir, snap, calls, stub, log: join(dir, 'state', 'logs', `context-compact-${SID}.log`) };
}

// Asynchronous on purpose: the fake daemon above lives in this event loop, so a synchronous spawn
// would block it and the script's curl would time out.
function run(ws, env = {}) {
  const child = spawn(bash, [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, HOME: fwd(join(ws.dir, 'home')), CLAUDE_PROJECT_DIR: fwd(ws.dir), AIGENTRY_ORCH_SID: SID,
      AIGENTRY_TELEPTY: fwd(ws.stub), AIGENTRY_TELEPTY_API: api, AIGENTRY_COMPACT_POLL_MS: '100',
      AIGENTRY_ORCH_CLI: '', AIGENTRY_COMPACT_COMMAND: '', ...env,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 30000);
  return new Promise((ok, fail) => {
    child.on('error', (e) => { clearTimeout(timer); fail(e); });
    child.on('close', (status) => { clearTimeout(timer); ok({ status, out: `${stdout}${stderr}` }); });
  });
}

const calls = (ws) => (existsSync(ws.calls) ? readFileSync(ws.calls, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, -1)) : []);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
function rememberWaiter(ws) {
  const m = existsSync(ws.log) && /waiter pid=(\d+)/.exec(readFileSync(ws.log, 'utf8'));
  if (m) waiterPids.push(Number(m[1]));
}
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(100); }
  return pred();
}

test('claude: injects /compact into its own session and starts no waiter', { skip: noBash }, async (t) => {
  const ws = workspace(); t.after(() => rmSync(ws.dir, { recursive: true, force: true }));
  setSession('claude');
  const r = await run(ws);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(calls(ws), [['inject', '--submit', '--from', SID, SID, '/compact']]);
  await sleep(500);
  assert.equal(existsSync(ws.log), false, 'no waiter log for claude');
  assert.equal(calls(ws).length, 1);
});

// grok is here too: its PostCompact hook is passive (stdout never reaches the model), so no native restore.
for (const [cli, command] of [['codex', '/opt/homebrew/bin/codex'], ['grok', '/Users/x/.grok/bin/grok']]) {
test(`${cli}: injects /compact, then the waiter restores the snapshot after busy → idle`, { skip: noBash || (WIN && 'win32: no detached waiter (no setsid); the instruction backstop applies') }, async (t) => {
  const ws = workspace(); t.after(() => rmSync(ws.dir, { recursive: true, force: true }));
  setSession(command);
  const r = await run(ws);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(calls(ws), [['inject', '--submit', '--from', SID, SID, '/compact']]);
  assert.ok(await waitFor(() => existsSync(ws.log) && /waiter pid=/.test(readFileSync(ws.log, 'utf8')), 10000), 'waiter started');
  rememberWaiter(ws);
  // Idle from the start but never seen busy: no restore yet.
  await sleep(1000);
  assert.equal(calls(ws).length, 1, 'restore must wait for the compaction to run');
  setSession(cli, { ready: false, idleSeconds: 0, lastActivityAt: '2026-10-09T00:00:05Z' });
  await sleep(600);
  assert.equal(calls(ws).length, 1, 'no restore while busy');
  setSession(cli, { ready: true, idleSeconds: 6, lastActivityAt: '2026-10-09T00:00:05Z' });
  assert.ok(await waitFor(() => calls(ws).length === 2, 30000), `restore injected; log:\n${existsSync(ws.log) ? readFileSync(ws.log, 'utf8') : ''}`);
  const [verb, submit, from, fromSid, target, line] = calls(ws)[1];
  assert.deepEqual([verb, submit, from, fromSid, target], ['inject', '--submit', '--from', SID, SID]);
  const m = RESTORE_RE.exec(line);
  assert.ok(m, line);
  assert.equal(fwd(m[1]), fwd(ws.snap));
  assert.match(readFileSync(ws.log, 'utf8'), /idle — injecting the restore line[\s\S]*restore injected/);
});
}

test('gemini: injects /compress', { skip: noBash }, async (t) => {
  const ws = workspace(); t.after(() => rmSync(ws.dir, { recursive: true, force: true }));
  setSession('gemini');
  const r = await run(ws);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(calls(ws), [['inject', '--submit', '--from', SID, SID, '/compress']]);
  if (WIN) { assert.match(r.out, /no restore waiter on native Windows/); return; }
  // gemini has no native restore hook either: a waiter starts. Its restore is case 2's subject; stop it.
  assert.ok(await waitFor(() => existsSync(ws.log) && /waiter pid=/.test(readFileSync(ws.log, 'utf8')), 10000), 'waiter started');
  rememberWaiter(ws);
  try { process.kill(waiterPids.at(-1), 'SIGTERM'); } catch { /* already exited */ }
});

test('unknown CLI: exit 5 naming the CLI and the override, nothing injected', { skip: noBash }, async (t) => {
  const ws = workspace(); t.after(() => rmSync(ws.dir, { recursive: true, force: true }));
  setSession('aider');
  const r = await run(ws);
  assert.equal(r.status, 5, r.out);
  assert.match(r.out, /'aider'/);
  assert.match(r.out, /AIGENTRY_COMPACT_COMMAND/);
  assert.deepEqual(calls(ws), []);
});

test('AIGENTRY_COMPACT_COMMAND wins over the table (and over an unknown CLI)', { skip: noBash }, async (t) => {
  const ws = workspace(); t.after(() => rmSync(ws.dir, { recursive: true, force: true }));
  setSession('claude');
  let r = await run(ws, { AIGENTRY_COMPACT_COMMAND: '/compact keep the plan' });
  assert.equal(r.status, 0, r.out);
  setSession('aider');
  r = await run(ws, { AIGENTRY_COMPACT_COMMAND: '/squash' });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(calls(ws).map((c) => c.at(-1)), ['/compact keep the plan', '/squash']);
});

test('stale snapshot: exit 3 and no inject', { skip: noBash }, async (t) => {
  const ws = workspace({ staleSeconds: 1200 }); t.after(() => rmSync(ws.dir, { recursive: true, force: true }));
  setSession('claude');
  const r = await run(ws);
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /refresh it before compacting/);
  assert.deepEqual(calls(ws), []);
});
