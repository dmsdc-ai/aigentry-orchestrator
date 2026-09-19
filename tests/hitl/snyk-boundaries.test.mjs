import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Run directly with node --test. Override AIGENTRY_TEST_PACKAGE_ROOT with a
// built package root when testing a frozen package; default uses ../../dist.
// All transport evidence is synthetic: no listener, TLS handshake or browser.
const root = process.env.AIGENTRY_TEST_PACKAGE_ROOT
  ? resolve(process.env.AIGENTRY_TEST_PACKAGE_ROOT)
  : fileURLToPath(new URL('../../', import.meta.url));
const lifecycle = String.raw`
import { EventEmitter } from 'node:events';
export const state = { listener: null, creates: 0, fsCalls: 0, hold: false, waiting: [], fault: false, target: '' };
export function createServer(...args) {
  state.creates++;
  state.listener = args.at(-1);
  const server = new EventEmitter();
  server.listen = (port, host, done) => { server.address = () => ({ port, address: host }); queueMicrotask(done); return server; };
  server.close = done => queueMicrotask(done);
  server.closeAllConnections = () => {};
  return server;
}
`;
const loader = String.raw`
export async function resolve(specifier, context, next) {
  const names = { 'node:http': 'http', 'node:https': 'https', 'node:fs/promises': 'fs' };
  if (names[specifier]) return { url: new URL(names[specifier] + '-seam.mjs', import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
`;
const fsSeam = String.raw`
export * from 'fs/promises';
import { lstat as actual } from 'fs/promises';
import { state } from './lifecycle.mjs';
export async function lstat(path, ...args) {
  state.fsCalls++;
  if (String(path) === state.target) {
    if (state.hold) await new Promise(resolve => state.waiting.push(resolve));
    if (state.fault) throw new Error('SECRET_EXCEPTION /private/fixture/storage STACK_MARKER');
  }
  return actual(path, ...args);
}
`;
const runner = String.raw`
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse, createServer as http } from 'node:http';
import { createServer as https } from 'node:https';
import { lstat } from 'node:fs/promises';
import { lstat as intercepted } from './fs-seam.mjs';
import { mkdir, realpath } from 'fs/promises';
import { Duplex } from 'node:stream';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { state, createServer } from './lifecycle.mjs';
assert.equal(http, createServer);
assert.equal(https, createServer);
assert.equal(lstat, intercepted);
const [root, dir, mode] = process.argv.slice(2);
const moduleURL = name => pathToFileURL(join(root, 'dist/src/hitl/web', name + '.js')).href;
const { startServer } = await import(moduleURL('server'));
const { createAuth } = await import(moduleURL('auth'));
let now = 1800000000000;
Date.now = () => now;
const stateDir = join(await realpath(dir), 'auth');
await mkdir(stateDir, { mode: 0o700 });
const secure = mode !== 'http';
const origin = (secure ? 'https' : 'http') + '://localhost:8787';
const auth = await createAuth({ origin: 'https://localhost:8787', rpId: 'localhost', stateDir, tlsReady: secure }, () => now);
assert.equal(auth.status().state, 'setup_required', 'real auth dependency and fixture required');
assert.equal(auth.status().reason, secure ? 'provisioning_required' : 'tls_required');
state.target = stateDir;
const service = await startServer({ host: '127.0.0.1', port: 8787, hitlRoot: join(dir, 'tasks'), auth,
  ...(secure ? { tls: { key: Buffer.from('synthetic'), cert: Buffer.from('synthetic') } } : {}) });
assert.equal(state.creates, 1);
async function call(path, { method = 'POST', headers = {}, raw = '{}'} = {}) {
  const req = new IncomingMessage(new Socket());
  req.method = method; req.url = path;
  req.headers = { host: 'localhost:8787', origin, 'sec-fetch-site': 'same-origin',
    ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) } : {}), ...headers };
  req.rawHeaders = Object.entries(req.headers).flat();
  if (method === 'POST') req.push(Buffer.from(raw));
  req.push(null);
  req.httpVersionMajor = 1; req.httpVersionMinor = 0;
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  socket.setTimeout = () => socket;
  const res = new ServerResponse(req);
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  try {
    const finished = once(res, 'finish', { signal: AbortSignal.timeout(5000) });
    state.listener(req, res);
    await finished;
    const wire = Buffer.concat(chunks).toString();
    return { status: res.statusCode, body: wire.slice(wire.indexOf('\r\n\r\n') + 4), headers: res.getHeaders() };
  } finally { req.destroy(); socket.destroy(); }
}
function refusal(r, status, error) {
  assert.equal(r.status, status, r.body);
  assert.equal(r.body, JSON.stringify({ error }));
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.doesNotMatch(r.body, /SECRET_EXCEPTION|STACK_MARKER|private\/fixture/);
}
async function preauth() {
  const r = await call('/auth/preauth');
  assert.equal(r.status, 200);
  return { cookie: r.headers['set-cookie'][0].split(';')[0], 'x-inbox-csrf': JSON.parse(r.body).csrf };
}
try {
  if (mode === 'hostile') {
    const payload = '<script>alert(1)</script>';
    refusal(await call('/' + payload, { method: 'GET' }), 400, 'invalid_request');
    refusal(await call('/', { method: 'GET', headers: { host: payload } }), 400, 'invalid_request');
    refusal(await call('/', { method: 'GET', headers: { origin: payload } }), 403, 'origin_refused');
    refusal(await call('/?q=' + encodeURIComponent(payload), { method: 'GET' }), 404, 'not_found');
    const page = await call('/', { method: 'GET', headers: { 'x-hostile': payload } });
    const { html } = await import(moduleURL('assets'));
    assert.equal(page.status, 200); assert.equal(page.body, html);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.ok(!page.body.includes(payload));
  } else if (mode === 'rate') {
    for (let i = 0; i < 300; i++) refusal(await call('/auth/enroll/verify'), 401, 'preauth_required');
    now += 250;
    const before = state.fsCalls;
    for (const path of ['/auth/enroll/options', '/auth/enroll/verify', '/auth/login/verify', '/auth/preauth'])
      refusal(await call(path), 429, 'rate_limited');
    assert.equal(state.fsCalls, before, 'saturation must precede auth filesystem refresh');
    now += 59750;
    refusal(await call('/auth/enroll/verify'), 401, 'preauth_required');
    assert.ok(state.fsCalls > before, 'window recovery reaches real auth');
  } else if (mode === 'active') {
    now += 250; state.hold = true;
    const pending = Array.from({ length: 16 }, () => call('/auth/enroll/verify'));
    for (let i = 0; state.waiting.length < 16 && i < 1000; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.waiting.length, 16, '16 real auth calls blocked at filesystem port');
    const before = state.fsCalls;
    refusal(await call('/auth/enroll/verify'), 429, 'rate_limited');
    assert.equal(state.fsCalls, before);
    state.hold = false; for (const release of state.waiting.splice(0)) release();
    for (const response of await Promise.all(pending)) refusal(response, 401, 'preauth_required');
    refusal(await call('/auth/enroll/verify'), 401, 'preauth_required');
  } else if (mode === 'errors') {
    const headers = await preauth();
    for (const path of ['/auth/enroll/options', '/auth/enroll/verify', '/auth/login/verify'])
      refusal(await call(path, { headers, raw: '{SECRET_EXCEPTION' }), 400, 'invalid_json');
    state.fault = true; now += 250;
    const before = state.fsCalls;
    refusal(await call('/auth/enroll/options', { headers, raw: JSON.stringify({ invitation: 'A'.repeat(43) }) }), 503, 'enrollment_unavailable');
    assert.ok(state.fsCalls > before, 'faulting filesystem port reached');
  } else if (mode === 'limits') {
    const headers = await preauth();
    for (let i = 1; i < 60; i++) assert.equal((await call('/auth/preauth')).status, 200);
    refusal(await call('/auth/preauth'), 429, 'rate_limited');
    now += 300000;
    const fresh = await preauth();
    for (let i = 0; i < 10; i++) refusal(await call('/auth/enroll/options', { headers: fresh }), 400, 'invitation_invalid');
    refusal(await call('/auth/enroll/options', { headers: fresh }), 429, 'rate_limited');
    for (let i = 0; i < 30; i++) refusal(await call('/auth/login/options', { headers: fresh }), 503, 'login_unavailable');
    refusal(await call('/auth/login/options', { headers: fresh }), 429, 'rate_limited');
    now += 300000;
    refusal(await call('/auth/enroll/options', { headers: fresh }), 400, 'invitation_invalid');
    refusal(await call('/auth/login/options', { headers: fresh }), 503, 'login_unavailable');
  } else if (mode === 'http') {
    const before = state.fsCalls;
    refusal(await call('/api/requests', { method: 'GET' }), 503, 'auth_unavailable');
    refusal(await call('/auth/preauth'), 503, 'auth_unavailable');
    assert.equal(state.fsCalls, before);
    const r = await call('/api/capabilities', { method: 'GET' });
    assert.equal(JSON.parse(r.body).auth.state, 'setup_required');
    assert.equal(auth.status().reason, 'tls_required');
  } else if (mode === 'cli') {
    const { main } = await import(moduleURL('cli'));
    let stdout = '';
    const write = process.stdout.write;
    process.stdout.write = chunk => { stdout += String(chunk); return true; };
    try { await main(['serve', '--hitl-root', join(dir, '<script>hostile</script>'), '--port', '8787']); }
    finally { process.stdout.write = write; }
    assert.equal(stdout, 'Approval inbox: http://localhost:8787 (authentication dependency_unverified; login required for private reads; decisions disabled)\n');
    process.emit('SIGTERM');
  }
  console.log(JSON.stringify({ mode, syntheticTransport: true, fsCalls: state.fsCalls }));
} finally { state.hold = false; for (const release of state.waiting.splice(0)) release(); await service.close(); }
`;

for (const mode of ['hostile', 'rate', 'active', 'errors', 'limits', 'http', 'cli']) {
  test(`Snyk boundary: ${mode} (synthetic transport, real auth)`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snyk-boundary-'));
    try {
      const sources = { 'loader.mjs': loader, 'lifecycle.mjs': lifecycle,
        'fs-seam.mjs': fsSeam, 'runner.mjs': runner,
        'http-seam.mjs': "export * from 'http'; export { createServer } from './lifecycle.mjs';\n",
        'https-seam.mjs': "export * from 'https'; export { createServer } from './lifecycle.mjs';\n" };
      for (const [name, source] of Object.entries(sources))
        await writeFile(join(dir, name), source, { mode: 0o600 });
      const result = spawnSync(process.execPath, ['--loader', pathToFileURL(join(dir, 'loader.mjs')).href,
        join(dir, 'runner.mjs'), root, dir, mode], { cwd: dir, encoding: 'utf8', timeout: 15000,
        maxBuffer: 262144, env: { PATH: '', TMPDIR: tmpdir(), TMPPREFIX: tmpdir() } });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(JSON.parse(result.stdout).mode, mode);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
