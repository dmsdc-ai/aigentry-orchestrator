import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Synthetic listening/port metadata only: no sockets, TLS handshake, browser,
// credentials, or real AuthPort activation. Keep exact fixture sources here.
const lifecycleSource = String.raw`
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
export const state = { listener: null, creates: 0, listens: 0, closes: 0, drains: 0 };
export function createServer(...args) {
  assert.equal(state.listener, null);
  state.listener = args.at(-1);
  assert.equal(typeof state.listener, 'function');
  state.creates++;
  const server = new EventEmitter();
  let address = null;
  server.listen = (port, host, done) => {
    assert.equal(host, '127.0.0.1');
    assert.ok([80, 443, 8787].includes(port));
    state.listens++;
    address = { address: host, family: 'IPv4', port };
    queueMicrotask(done);
    return server;
  };
  server.address = () => address;
  server.close = done => { state.closes++; queueMicrotask(() => done()); };
  server.closeAllConnections = () => { state.drains++; };
  return server;
}
`;

const loaderSource = String.raw`
export async function resolve(specifier, context, next) {
  if (specifier === 'node:http' || specifier === 'node:https') {
    return { url: new URL(specifier.slice(5) + '-seam.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
`;

const runnerSource = String.raw`
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse, createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { Duplex } from 'node:stream';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { state, createServer } from './lifecycle.mjs';
// Abort before importing or starting production if interception is unavailable.
assert.equal(httpServer, createServer, 'HTTP lifecycle seam required');
assert.equal(httpsServer, createServer, 'HTTPS lifecycle seam required');
const [serverURL, authURL, scheme, portText, dir] = process.argv.slice(2);
const { startServer } = await import(serverURL);
const { unavailableAuth } = await import(authURL);
const auth = unavailableAuth();
const port = Number(portText);
const canonical = new URL(scheme + '://localhost:' + port).origin;
const host = new URL(canonical).host;
const service = await startServer({ host: '127.0.0.1', port, hitlRoot: join(dir, 'empty-hitl'), auth,
  ...(scheme === 'https' ? { tls: { key: Buffer.from('synthetic-key'), cert: Buffer.from('synthetic-cert') } } : {}) });
assert.equal(state.creates, 1);
assert.equal(state.listens, 1);
assert.equal(service.server.address().port, port);
async function call(path, extra = {}, rawHeaders, method = 'GET') {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = path;
  req.headers = { host, origin: canonical, 'sec-fetch-site': 'same-origin', ...extra };
  if (req.headers.origin === undefined) delete req.headers.origin;
  req.rawHeaders = rawHeaders ?? Object.entries(req.headers).flat();
  req.push(null);
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  // In-memory transport implements the timeout API used by real ServerResponse.
  let timer;
  socket.setTimeout = milliseconds => {
    clearTimeout(timer);
    if (milliseconds) timer = setTimeout(() => socket.emit('timeout'), milliseconds);
    return socket;
  };
  const res = new ServerResponse(req);
  // HTTP/1.0 gives an unchunked body for inspection of real wire output.
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 0;
  res.useChunkedEncodingByDefault = false;
  res.assignSocket(socket);
  const finished = once(res, 'finish', { signal: AbortSignal.timeout(2000) });
  try {
    state.listener(req, res);
    await finished;
    const wire = Buffer.concat(chunks).toString();
    return { status: res.statusCode, body: wire.slice(wire.indexOf('\r\n\r\n') + 4), headers: res.getHeaders() };
  } finally { clearTimeout(timer); req.destroy(); socket.destroy(); }
}
try {
  const publicResults = {};
  for (const path of ['/', '/api/capabilities']) publicResults[path] = await call(path);
  publicResults.noOrigin = await call('/', { origin: undefined });
  const security = {};
  security.hostileOrigin = await call('/', { origin: 'https://evil.example' });
  security.hostileHost = await call('/', { host: 'evil.example' });
  security.duplicateHost = await call('/', {}, ['Host', host, 'hOsT', host, 'Origin', canonical]);
  security.missingHost = await call('/', {}, ['Origin', canonical]);
  security.crossSite = await call('/', { 'sec-fetch-site': 'cross-site' });
  security.nullOrigin = await call('/', { origin: 'null' });
  for (const path of ['//evil.example/', 'https://evil.example/', '/#fragment', '/%2f', '/\\evil.example/']) {
    security[path] = await call(path);
  }
  const disabled = {};
  disabled.private = await call('/api/requests');
  disabled.auth = await call('/auth/preauth', { 'content-type': 'application/json', 'content-length': '0' }, undefined, 'POST');
  disabled.decision = await call('/api/requests/decision-test-000000000000', { 'content-type': 'application/json', 'content-length': '0' }, undefined, 'POST');
  await service.close();
  assert.equal(state.closes, 1);
  assert.equal(state.drains, 1);
  assert.equal(await auth.authenticate(new IncomingMessage(new Socket())), null);
  console.log(JSON.stringify({ syntheticListening: true, port, scheme, origin: service.origin, canonical,
    authState: auth.status().state, publicResults, security, disabled }));
} finally { await service.close(); }
`;

interface Response { status: number; body: string; headers: Record<string, unknown> }
interface Observation {
  syntheticListening: boolean; port: number; scheme: string; origin: string; canonical: string;
  authState: string; publicResults: Record<string, Response>; security: Record<string, Response>;
  disabled: Record<string, Response>;
}
const scenarios = [['https', 443], ['http', 80], ['https', 8787], ['http', 8787]] as const;
const observations = new Map<string, Observation>();
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-origin-'));
  try {
    for (const [name, source] of Object.entries({ 'loader.mjs': loaderSource,
      'lifecycle.mjs': lifecycleSource, 'runner.mjs': runnerSource,
      'http-seam.mjs': "export * from 'http'; export { createServer } from './lifecycle.mjs';\n",
      'https-seam.mjs': "export * from 'https'; export { createServer } from './lifecycle.mjs';\n" })) {
      await writeFile(join(dir, name), source, { mode: 0o600 });
    }
    for (const [scheme, port] of scenarios) {
      const result = spawnSync(process.execPath, ['--loader', pathToFileURL(join(dir, 'loader.mjs')).href,
        join(dir, 'runner.mjs'), new URL('../../src/hitl/web/server.js', import.meta.url).href,
        new URL('../../src/hitl/web/auth-port.js', import.meta.url).href, scheme, String(port), dir],
      { cwd: dir, encoding: 'utf8', timeout: 10_000, maxBuffer: 262_144,
        env: { PATH: '', TMPDIR: tmpdir(), TMPPREFIX: tmpdir() } });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      observations.set(`${scheme}:${port}`, JSON.parse(result.stdout) as Observation);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [scheme, port] of scenarios) {
  const label = `${scheme}:${port}`;
  for (const path of ['/', '/api/capabilities']) {
    test(`synthetic ${label}: canonical Host/Origin GET ${path} succeeds`, t => {
      const observation = observations.get(label)!;
      t.diagnostic(JSON.stringify({ syntheticListening: observation.syntheticListening, port,
        origin: observation.origin, canonical: observation.canonical }));
      const response = observation.publicResults[path]!;
      assert.equal(response.status, 200, `${label} GET ${path}: ${response.body}`);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      if (path === '/api/capabilities') {
        const body = JSON.parse(response.body);
        assert.equal(body.auth.state, scheme === 'https' ? 'dependency_unverified' : 'setup_required');
        for (const key of ['binding', 'decision', 'relay', 'ACK', 'mobile']) assert.equal(body[key].state, 'unavailable');
      } else assert.match(response.body, /<!doctype html>/i);
    });
  }
  test(`synthetic ${label}: security refusals and disabled private/auth/decision paths`, t => {
    const observation = observations.get(label)!;
    assert.equal(observation.syntheticListening, true);
    assert.equal(observation.authState, 'dependency_unverified');
    const actual: unknown[] = [];
    const expected: unknown[] = [];
    for (const [name, response] of Object.entries(observation.security)) {
      t.diagnostic(`${name}: ${response.status} ${response.body}`);
      const originRefused = ['hostileOrigin', 'crossSite', 'nullOrigin'].includes(name);
      actual.push([name, response.status, JSON.parse(response.body), response.headers['access-control-allow-origin']]);
      expected.push([name, originRefused ? 403 : 400,
        { error: originRefused ? 'origin_refused' : 'invalid_request' }, undefined]);
    }
    for (const [name, response] of Object.entries(observation.disabled)) {
      t.diagnostic(`${name}: ${response.status} ${response.body}`);
      actual.push([name, response.status, JSON.parse(response.body), response.headers['access-control-allow-origin']]);
      expected.push([name, 503, { error: 'auth_unavailable' }, undefined]);
    }
    assert.deepEqual(actual, expected);
  });
}
for (const [scheme, port] of scenarios.filter(([, port]) => port !== 8787)) {
  test(`synthetic ${scheme}:${port}: canonical Host GET without Origin succeeds`, () => {
    const response = observations.get(`${scheme}:${port}`)!.publicResults['noOrigin']!;
    assert.equal(response.status, 200, response.body);
  });
}
