import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { isAbsolute } from 'node:path';
import type { AuthPort } from './auth-port.js';
import { html, css, js } from './assets.js';
import { readRequests, validId, type View } from './read-model.js';
import { createConsoleReader, ConsoleError } from './console-read-model.js';
import type { ConsoleConfig, ConsoleView } from './console-contracts.js';

export interface ServerConfig {
  host: '127.0.0.1'; port: number; hitlRoot: string; auth: AuthPort;
  tls?: Readonly<{ key: Buffer; cert: Buffer }>;
  console?: ConsoleConfig;
}
const authRoutes = new Set(['/auth/preauth', '/auth/enroll/options', '/auth/enroll/verify', '/auth/login/options', '/auth/login/verify', '/auth/logout']);
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
function headers(res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** Caller supplies B's verified AuthPort. No import-time listener or auth activation. */
export async function startServer(config: Readonly<ServerConfig>) {
  if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535 || !isAbsolute(config.hitlRoot)) throw new Error('invalid_config');
  if (config.tls && (!Buffer.isBuffer(config.tls.key) || !config.tls.key.length || !Buffer.isBuffer(config.tls.cert) || !config.tls.cert.length)) throw new Error('invalid_tls');
  const auth = config.auth;
  const root = config.hitlRoot;
  const secure = !!config.tls;
  const consoleReader = config.console ? createConsoleReader(config.console) : null;
  let origin = '';
  let authority = '';
  let windowStart = Date.now(), requests = 0, active = 0;
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    headers(res);
    const now = Date.now();
    if (now - windowStart >= 60000) { windowStart = now; requests = 0; }
    if (++requests > 300 || active >= 16) { res.setHeader('Retry-After', '15'); json(res, 429, { error: 'rate_limited' }); return; }
    active++;
    try {
      const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === 'host');
      if (hosts.length !== 1 || req.headers.host !== authority || !req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) { json(res, 400, { error: 'invalid_request' }); return; }
      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.hash || /[%\\]/.test(url.pathname)) { json(res, 400, { error: 'invalid_request' }); return; }
      const site = req.headers['sec-fetch-site'];
      if ((site !== undefined && site !== 'same-origin' && !(site === 'none' && req.method === 'GET')) || (req.headers.origin !== undefined && req.headers.origin !== origin)) { json(res, 403, { error: 'origin_refused' }); return; }
      if (req.method !== 'GET' && req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); json(res, 405, { error: 'method_refused' }); return; }
      if (req.method === 'POST') {
        if (req.headers.origin !== origin || (site !== undefined && site !== 'same-origin')) { json(res, 403, { error: 'origin_refused' }); return; }
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) { json(res, 415, { error: 'json_required' }); return; }
      }
      // Require bounded Content-Length, so B can read the original stream safely.
      const length = req.headers['content-length'];
      if (req.headers['transfer-encoding'] !== undefined || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 65536)) || (req.method === 'GET' && Number(length ?? 0) !== 0)) { json(res, 413, { error: 'body_refused' }); return; }
      if (req.method === 'POST' && length === undefined) { json(res, 411, { error: 'length_required' }); return; }
      const state = auth.status(); // Rechecked for each request, never cached at startup.
      const ready = secure && state.state === 'ready';
      if (req.method === 'GET' && url.search === '') {
        const asset = url.pathname === '/' ? [html, 'text/html'] : url.pathname === '/assets/inbox.css' ? [css, 'text/css'] : url.pathname === '/assets/inbox.js' ? [js, 'text/javascript'] : null;
        if (asset) { res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(asset[0]); return; }
        if (url.pathname === '/api/capabilities') {
          const authState = secure ? state.state : 'setup_required';
          json(res, 200, { auth: { state: authState, reason: authState === 'ready' ? null : authState }, console: { state: consoleReader ? 'configured' : 'unavailable', reason: consoleReader ? null : 'not_configured' }, binding: { state: 'unavailable', reason: 'legacy_unbound' }, decision: { state: 'unavailable', reason: 'binding_unavailable' }, relay: { state: 'unavailable', reason: 'not_integrated' }, ACK: { state: 'unavailable', reason: 'not_integrated' }, mobile: { state: 'unavailable', reason: 'loopback_only' } }); return;
        }
      }
      if (authRoutes.has(url.pathname)) {
        if (req.method !== 'POST' || url.search) { json(res, 405, { error: 'method_refused' }); return; }
        if (!secure || state.state === 'dependency_unverified') { json(res, 503, { error: 'auth_unavailable' }); return; }
        if (!await auth.handle(req, res)) json(res, 503, { error: 'auth_unavailable' });
        return;
      }
      if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: 'not_found' }); return; }
      if (!ready) { json(res, 503, { error: 'auth_unavailable' }); return; }
      const principal = await auth.authenticate(req);
      if (!principal || !principal.id || !principal.credentialId || !principal.sessionId || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= Date.now() || auth.status().state !== 'ready') { json(res, 401, { error: 'authentication_required' }); return; }
      if (url.pathname.startsWith('/api/console/')) {
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(res, 405, { error: 'method_refused' }); return; }
        if (!consoleReader) { json(res, 503, { error: 'console_unavailable' }); return; }
        if (url.pathname === '/api/console/v1/projects' && !url.search) {
          json(res, 200, { items: consoleReader.projects(principal.id), advisor: { configuredDefault: true, observation: 'unknown' }, loop: { state: 'unavailable', reason: 'activation_not_verified' } }); return;
        }
        const route = /^\/api\/console\/v1\/(tasks|requests|releases|approvals|evidence)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
        if (!route) { json(res, 404, { error: 'not_found' }); return; }
        try {
          const data = await consoleReader.read(principal.id, url.searchParams.get('project') ?? '', route[1] as ConsoleView, url.searchParams, route[2]);
          // Source I/O may outlive a session: never send a private result after expiry/revocation.
          const current = await auth.authenticate(req);
          if (!current || current.id !== principal.id || current.sessionId !== principal.sessionId || current.expiresAt <= Date.now() || auth.status().state !== 'ready') { json(res, 401, { error: 'authentication_required' }); return; }
          json(res, data.coverage === 'unavailable' ? 503 : 200, data);
        } catch (error) {
          if (!(error instanceof ConsoleError)) throw error;
          if (error.status === 429) res.setHeader('Retry-After', '15');
          json(res, error.status, { error: error.message });
        }
        return;
      }
      if (req.method === 'POST') { json(res, 503, { error: 'decisions_disabled' }); return; }
      const match = /^\/api\/requests(?:\/([^/]+))?$/.exec(url.pathname);
      if (!match) { json(res, 404, { error: 'not_found' }); return; }
      const id = match[1];
      const params = url.searchParams;
      const allowed = id ? ['view'] : ['view', 'cursor', 'limit'];
      if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1) || (id !== undefined && !validId(id))) { json(res, 400, { error: 'invalid_query' }); return; }
      const view = params.get('view') ?? 'pending';
      const limit = params.get('limit') ?? '25';
      const cursor = params.get('cursor');
      if (!['pending', 'history'].includes(view) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(limit) || (cursor !== null && !validId(cursor))) { json(res, 400, { error: 'invalid_query' }); return; }
      if (id) {
        // Bounded scan shares precisely the same validation as list.
        let next: string | null = null;
        for (let page = 0; page < 10; page++) {
          const data = await readRequests(root, view as View, 100, next);
          const row = data.items.find(item => item.id === id);
          if (row) { json(res, 200, row); return; }
          if (!data.nextCursor) { json(res, data.warnings.length ? 503 : 404, { error: data.warnings.length ? 'source_unavailable' : 'not_found' }); return; }
          next = data.nextCursor;
        }
        json(res, 503, { error: 'source_unavailable' }); return;
      }
      json(res, 200, await readRequests(root, view as View, Number(limit), cursor));
    } finally { active--; }
  }
  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    req.setTimeout(15000, () => req.destroy());
    res.setTimeout(15000, () => res.destroy());
    void route(req, res).catch(() => { if (!res.headersSent) json(res, 503, { error: 'unavailable' }); else res.destroy(); });
  };
  const server = config.tls ? httpsServer({ key: config.tls.key, cert: config.tls.cert, maxHeaderSize: 8192 }, listener) : httpServer({ maxHeaderSize: 8192 }, listener);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('listen_failed')); return; }
      origin = new URL(`${secure ? 'https' : 'http'}://localhost:${address.port}`).origin;
      authority = new URL(origin).host;
      resolve();
    });
  }).catch(async error => { await auth.close(); throw error; });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }).finally(() => auth.close());
  })();
  return { server, origin, close };
}
