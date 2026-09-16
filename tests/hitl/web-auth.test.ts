import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { encodeCBOR, type CBORType } from '@levischuck/tiny-cbor';
import { createAuth, provisionOwner } from '../../src/hitl/web/auth.js';
import type { AuthPort } from '../../src/hitl/web/auth-port.js';

// Adapter tests only: no HTTP listener, real TLS, browser, hardware or owner data.
const origin = 'https://inbox.example.test';
const rpId = 'inbox.example.test';
const hash = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();
const b64 = (value: Uint8Array): string => Buffer.from(value).toString('base64url');
function request(cookie = ''): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = { host: rpId, origin, 'content-type': 'application/json',
    'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', cookie };
  return req;
}
async function call(auth: AuthPort, path: string, payload: unknown = {}, cookie = '', csrf = '',
  headers: Record<string, string> = {}) {
  const req = request(cookie);
  req.url = path;
  req.method = 'POST';
  const raw = JSON.stringify(payload);
  Object.assign(req.headers, { 'content-length': String(Buffer.byteLength(raw)), 'x-inbox-csrf': csrf }, headers);
  req.push(Buffer.from(raw));
  req.push(null);
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  // Capture writes from the real ServerResponse without opening a connection.
  const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, done) {
    chunks.push(Buffer.from(chunk)); done();
  } });
  res.assignSocket(socket as Socket);
  const handled = await auth.handle(req, res);
  const wire = Buffer.concat(chunks).toString();
  const body = handled ? JSON.parse(wire.slice(wire.indexOf('\r\n\r\n') + 4)) as Record<string, unknown> : {};
  const cookies = wire.slice(0, wire.indexOf('\r\n\r\n')).split('\r\n')
    .filter(line => /^set-cookie:/i.test(line)).map(line => line.slice(line.indexOf(':') + 1).trim());
  req.destroy();
  socket.destroy();
  return { status: res.statusCode, body, cookies, handled };
}
async function preauth(auth: AuthPort) {
  const result = await call(auth, '/auth/preauth');
  assert.equal(result.status, 200);
  assert.equal(typeof result.body['csrf'], 'string');
  return { cookie: result.cookies[0]!.split(';')[0]!, csrf: result.body['csrf'] as string, result };
}
function virtualAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const idBytes = hash(Buffer.from(jwk.x!));
  const id = b64(idBytes);
  const cose = encodeCBOR(new Map<string | number, CBORType>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  function client(type: string, challenge: string, clientOrigin = origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: clientOrigin, crossOrigin: false }));
  }
  function data(flags: number, counter: number, rp = rpId) {
    const count = Buffer.alloc(4); count.writeUInt32BE(counter);
    return Buffer.concat([hash(rp), Buffer.from([flags]), count]);
  }
  return {
    id,
    registration(challenge: string, flags = 0x45, clientOrigin = origin, rp = rpId) {
      const length = Buffer.alloc(2); length.writeUInt16BE(idBytes.length);
      const authData = Buffer.concat([data(flags, 0, rp), Buffer.alloc(16), length, idBytes, cose]);
      const clientData = client('webauthn.create', challenge, clientOrigin);
      // Packed self-attestation provides genuine signature verification at registration.
      const signature = sign('sha256', Buffer.concat([authData, hash(clientData)]), privateKey);
      const attestation = encodeCBOR(new Map<string | number, CBORType>([
        ['fmt', 'packed'], ['authData', authData],
        ['attStmt', new Map<string | number, CBORType>([['alg', -7], ['sig', signature]])],
      ]));
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(clientData), attestationObject: b64(attestation), transports: ['internal'] } };
    },
    login(challenge: string, counter = 1, flags = 5, clientOrigin = origin, rp = rpId) {
      const clientData = client('webauthn.get', challenge, clientOrigin);
      const authData = data(flags, counter, rp);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON: b64(clientData), authenticatorData: b64(authData),
        signature: b64(sign('sha256', Buffer.concat([authData, hash(clientData)]), privateKey)),
      } };
    },
  };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fixture-'));
  await chmod(dir, 0o700);
  let time = 1_800_000_000_000;
  const config = { origin, rpId, stateDir: dir, tlsReady: true };
  const clock = () => time;
  const auth = await createAuth(config, clock);
  return { dir, auth, config, clock, advance: (ms: number) => { time += ms; },
    cleanup: async () => { await auth.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function enroll(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.dir, 'invitation');
  assert.deepEqual(await provisionOwner({ authRoot: f.dir, invitationPath: path }, f.clock), { state: 'created', path });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const invitation = (await readFile(path, 'utf8')).trim();
  const p = await preauth(f.auth);
  const options = await call(f.auth, '/auth/enroll/options', { invitation }, p.cookie, p.csrf);
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const challenge = (options.body['options'] as { challenge: string }).challenge;
  const device = virtualAuthenticator();
  const result = await call(f.auth, '/auth/enroll/verify', { response: device.registration(challenge) }, p.cookie, p.csrf);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return { device, result, invitation, p };
}
test('adapter: genuine packed ES256 first-owner enrollment and signed login', async () => {
  const f = await fixture();
  try {
    assert.equal(f.auth.status().reason, 'provisioning_required');
    const { device, result, invitation } = await enroll(f);
    assert.equal(f.auth.status().state, 'ready');
    const session = result.cookies[0]!.split(';')[0]!;
    assert.ok(await f.auth.authenticate(request(session)));
    const p = await preauth(f.auth);
    const options = await call(f.auth, '/auth/login/options', {}, p.cookie, p.csrf);
    assert.equal(options.status, 200);
    const challenge = (options.body['options'] as { challenge: string }).challenge;
    const login = await call(f.auth, '/auth/login/verify', { response: device.login(challenge) }, p.cookie, p.csrf);
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.notEqual(login.cookies[0], result.cookies[0]);
    assert.ok(await f.auth.authenticate(request(login.cookies[0]!.split(';')[0]!)));
    const metadata = await readFile(join(f.dir, 'auth-metadata.json'), 'utf8');
    assert.equal(metadata.includes(invitation), false);
    assert.equal(JSON.parse(metadata).credential.counter, 1);
    assert.equal(JSON.parse(metadata).invitation, null);
  } finally { await f.cleanup(); }
});

async function loginOptions(auth: AuthPort) {
  const p = await preauth(auth);
  const result = await call(auth, '/auth/login/options', {}, p.cookie, p.csrf);
  assert.equal(result.status, 200);
  return { ...p, challenge: (result.body['options'] as { challenge: string }).challenge };
}

for (const negative of ['UP', 'UV', 'origin', 'RP', 'challenge', 'signature', 'unknown', 'counter', 'malformed', 'oversized']) {
  test(`adapter: login refuses ${negative}; failed verification consumes challenge`, async () => {
    const f = await fixture();
    try {
      const { device } = await enroll(f);
      const p = await loginOptions(f.auth);
      const response = device.login(negative === 'challenge' ? 'wrong' : p.challenge,
        negative === 'counter' ? 0 : 1, negative === 'UP' ? 4 : negative === 'UV' ? 1 : 5,
        negative === 'origin' ? 'https://wrong.example.test' : origin,
        negative === 'RP' ? 'wrong.example.test' : rpId);
      // Stored zero and received zero is allowed by WebAuthn; establish a nonzero counter first.
      if (negative === 'counter') {
        const accepted = await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge, 1) }, p.cookie, p.csrf);
        assert.equal(accepted.status, 200);
        Object.assign(p, await loginOptions(f.auth));
        Object.assign(response, device.login(p.challenge, 1));
      }
      if (negative === 'signature') response.response.signature = b64(Buffer.alloc(64, 7));
      if (negative === 'unknown') response.id = response.rawId = b64(Buffer.alloc(32, 8));
      if (negative === 'oversized') response.response.clientDataJSON = 'A'.repeat(70_000);
      const result = await call(f.auth, '/auth/login/verify', { response: negative === 'malformed' ? {} : response }, p.cookie, p.csrf);
      assert.equal(result.status, ['malformed', 'oversized'].includes(negative) ? 400 : 403);
      assert.deepEqual(Object.keys(result.body), ['error']);
      assert.equal(result.cookies.length, 0);
      const retry = await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge, 2) }, p.cookie, p.csrf);
      assert.equal(retry.status, 410);
    } finally { await f.cleanup(); }
  });
}

for (const negative of ['UP', 'UV', 'origin', 'RP', 'challenge', 'signature']) {
  test(`adapter: registration refuses ${negative}`, async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, 'invitation');
      assert.equal((await provisionOwner({ authRoot: f.dir, invitationPath: path }, f.clock)).state, 'created');
      const invitation = (await readFile(path, 'utf8')).trim();
      const p = await preauth(f.auth);
      const options = await call(f.auth, '/auth/enroll/options', { invitation }, p.cookie, p.csrf);
      assert.equal(options.status, 200);
      const challenge = (options.body['options'] as { challenge: string }).challenge;
      const device = virtualAuthenticator();
      const response = device.registration(negative === 'challenge' ? 'wrong' : challenge,
        negative === 'UP' ? 0x44 : negative === 'UV' ? 0x41 : 0x45,
        negative === 'origin' ? 'https://wrong.example.test' : origin, negative === 'RP' ? 'wrong.example.test' : rpId);
      if (negative === 'signature') {
        const bytes = Buffer.from(response.response.attestationObject, 'base64url');
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        response.response.attestationObject = b64(bytes);
      }
      const result = await call(f.auth, '/auth/enroll/verify', { response }, p.cookie, p.csrf);
      assert.equal(result.status, 403);
      assert.equal(JSON.parse(await readFile(join(f.dir, 'auth-metadata.json'), 'utf8')).credential, null);
      assert.equal((await call(f.auth, '/auth/enroll/verify', { response }, p.cookie, p.csrf)).status, 410);
    } finally { await f.cleanup(); }
  });
}

test('adapter: exact Host, Origin, JSON, Fetch Metadata, CSRF and private cookies', async () => {
  const f = await fixture();
  try {
    for (const headers of [
      { host: 'other.example.test' }, { origin: origin + '/' }, { 'content-type': 'text/plain' },
      { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-mode': 'navigate' },
    ]) {
      const result = await call(f.auth, '/auth/preauth', {}, '', '', headers as Record<string, string>);
      assert.equal(result.status, 403);
      assert.deepEqual(result.body, { error: 'origin_refused' });
    }
    const p = await preauth(f.auth);
    for (const value of p.result.cookies) {
      for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(value.includes(attribute));
      assert.equal(/domain=/i.test(value), false);
    }
    assert.equal((await call(f.auth, '/auth/enroll/options', {}, p.cookie)).status, 403);
    assert.equal((await call(f.auth, '/auth/enroll/options', {}, '', p.csrf)).status, 401);
    assert.equal((await call(f.auth, '/auth/enroll/options', { invitation: 'A'.repeat(43) }, p.cookie, p.csrf)).status, 503);
    assert.equal((await call(f.auth, '/private')).handled, false);
    const { result } = await enroll(f);
    for (const value of result.cookies) {
      assert.match(value, /Secure; HttpOnly; SameSite=Strict/);
      assert.equal(/domain=/i.test(value), false);
    }
    const cookie = result.cookies[0]!.split(';')[0]!;
    const principal = await f.auth.authenticate(request(cookie));
    assert.ok(principal);
    assert.notEqual(principal.sessionId, cookie.split('=')[1]);
    const metadata = await readFile(join(f.dir, 'auth-metadata.json'), 'utf8');
    assert.equal(metadata.includes(cookie.split('=')[1]!), false);
    assert.equal((await call(f.auth, '/auth/logout', {}, cookie, p.csrf)).status, 403);
    assert.equal((await call(f.auth, '/auth/logout', {}, cookie, result.body['csrf'] as string)).status, 200);
    assert.equal(await f.auth.authenticate(request(cookie)), null);
  } finally { await f.cleanup(); }
});

test('adapter: challenge 120s boundary, preauth binding, purpose and concurrent replay', async () => {
  const f = await fixture();
  try {
    const { device } = await enroll(f);
    let p = await loginOptions(f.auth);
    f.advance(120_000);
    assert.equal((await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge) }, p.cookie, p.csrf)).status, 410);
    p = await loginOptions(f.auth);
    const other = await preauth(f.auth);
    assert.equal((await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge) }, other.cookie, other.csrf)).status, 410);
    assert.equal((await call(f.auth, '/auth/enroll/verify', { response: device.registration(p.challenge) }, p.cookie, p.csrf)).status, 410);
    assert.equal((await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge) }, p.cookie, p.csrf)).status, 410);
    p = await loginOptions(f.auth);
    const results = await Promise.all([1, 2].map(() => call(f.auth, '/auth/login/verify', { response: device.login(p.challenge) }, p.cookie, p.csrf)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 410]);
  } finally { await f.cleanup(); }
});

for (const boundary of ['idle', 'absolute', 'restart', 'absence']) {
  test(`adapter: session invalidation ${boundary}`, async () => {
    const f = await fixture();
    try {
      const { result } = await enroll(f);
      const cookie = result.cookies[0]!.split(';')[0]!;
      if (boundary === 'idle') f.advance(900_000);
      if (boundary === 'absolute') {
        for (let i = 0; i < 35; i++) { f.advance(800_000); assert.ok(await f.auth.authenticate(request(cookie))); }
        f.advance(800_000);
      }
      if (boundary === 'absence') { await rm(join(f.dir, 'auth-metadata.json')); f.advance(250); }
      if (boundary === 'restart') {
        await f.auth.close();
        const restarted = await createAuth(f.config, f.clock);
        try { assert.equal(await restarted.authenticate(request(cookie)), null); } finally { await restarted.close(); }
      }
      assert.equal(await f.auth.authenticate(request(cookie)), null);
    } finally { await f.cleanup(); }
  });
}

test('provision: path-only, collision, directory mode, symlink, expiry, no owner takeover', async () => {
  const f = await fixture();
  try {
    const { invitation } = await enroll(f);
    assert.equal((await provisionOwner({ authRoot: f.dir, invitationPath: join(f.dir, 'next') }, f.clock)).state, 'unavailable');
    const p = await preauth(f.auth);
    assert.equal((await call(f.auth, '/auth/enroll/options', { invitation }, p.cookie, p.csrf)).status, 409);
    assert.deepEqual(await provisionOwner({ authRoot: f.dir, invitationPath: join(f.dir, 'invitation') }, f.clock), { state: 'unavailable', reason: 'provision_conflict' });
    const unsafe = join(f.dir, 'unsafe'); await mkdir(unsafe, { mode: 0o755 }); await chmod(unsafe, 0o755);
    assert.deepEqual(await provisionOwner({ authRoot: unsafe, invitationPath: join(unsafe, 'invitation') }, f.clock), { state: 'unavailable', reason: 'storage_unsafe' });
    const link = join(f.dir, 'link'); await symlink(unsafe, link);
    assert.deepEqual(await provisionOwner({ authRoot: link, invitationPath: join(link, 'invitation') }, f.clock), { state: 'unavailable', reason: 'storage_unsafe' });
  } finally { await f.cleanup(); }
  const expired = await fixture();
  try {
    const path = join(expired.dir, 'invitation');
    await provisionOwner({ authRoot: expired.dir, invitationPath: path }, expired.clock);
    const invitation = (await readFile(path, 'utf8')).trim();
    expired.advance(300_000);
    const p = await preauth(expired.auth);
    assert.equal((await call(expired.auth, '/auth/enroll/options', { invitation }, p.cookie, p.csrf)).status, 410);
  } finally { await expired.cleanup(); }
});

test('adapter: concurrent first-owner enrollment has one winner and atomic invitation consumption', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'invitation');
    await provisionOwner({ authRoot: f.dir, invitationPath: path }, f.clock);
    const invitation = (await readFile(path, 'utf8')).trim();
    const second = await createAuth(f.config, f.clock);
    try {
      const attempts = await Promise.all([f.auth, second].map(async auth => {
        const p = await preauth(auth);
        const opts = await call(auth, '/auth/enroll/options', { invitation }, p.cookie, p.csrf);
        assert.equal(opts.status, 200);
        return { auth, p, response: virtualAuthenticator().registration((opts.body['options'] as { challenge: string }).challenge) };
      }));
      const results = await Promise.all(attempts.map(a => call(a.auth, '/auth/enroll/verify', { response: a.response }, a.p.cookie, a.p.csrf)));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      const metadata = JSON.parse(await readFile(join(f.dir, 'auth-metadata.json'), 'utf8'));
      assert.equal(metadata.invitation, null); assert.equal(metadata.generation, 1);
      assert.ok(metadata.credential);
    } finally { await second.close(); }
  } finally { await f.cleanup(); }
});

for (const condition of ['corrupt', 'duplicate', 'unsafe']) {
  test(`storage: ${condition} metadata refused and preserved`, async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, 'auth-metadata.json');
      const raw = condition === 'corrupt' ? '{broken' : '{"version":1,"generation":0,"invitation":null,"credential":null' + (condition === 'duplicate' ? ',"version":1}' : '}');
      await writeFile(path, raw, { mode: 0o600 });
      if (condition === 'unsafe') await chmod(path, 0o644);
      const auth = await createAuth(f.config, f.clock);
      try {
        assert.equal(await readFile(path, 'utf8'), raw);
        assert.equal(auth.status().reason, condition === 'unsafe' ? 'storage_unsafe' : 'storage_corrupt');
        assert.equal(await auth.authenticate(request()), null);
      } finally { await auth.close(); }
    } finally { await f.cleanup(); }
  });
}

test('status: invalid config and missing TLS refuse authentication', async () => {
  const f = await fixture();
  try {
    for (const [config, reason] of [
      [{ ...f.config, origin: 'http://inbox.example.test' }, 'config_invalid'],
      [{ ...f.config, tlsReady: false }, 'tls_required'],
    ] as const) {
      const auth = await createAuth(config, f.clock);
      try {
        assert.equal(auth.status().reason, reason);
        assert.equal(await auth.authenticate(request()), null);
      } finally { await auth.close(); }
    }
  } finally { await f.cleanup(); }
});

test('storage: failed durable login write issues no session', async () => {
  const f = await fixture();
  try {
    const { device } = await enroll(f);
    const p = await loginOptions(f.auth);
    const tmp = join(f.dir, `auth-metadata.json.tmp.hitl-web-auth.${process.pid}`);
    await mkdir(tmp, { mode: 0o700 });
    const result = await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge) }, p.cookie, p.csrf);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'storage_unavailable' });
    assert.equal(result.cookies.length, 0);
    assert.equal(await f.auth.authenticate(request(p.cookie)), null);
  } finally { await f.cleanup(); }
});

test('adapter: concurrent distinct challenges cannot commit the same nonzero counter twice', async () => {
  const f = await fixture();
  try {
    const { device } = await enroll(f);
    const first = await loginOptions(f.auth);
    assert.equal((await call(f.auth, '/auth/login/verify', { response: device.login(first.challenge, 1) }, first.cookie, first.csrf)).status, 200);
    const attempts = await Promise.all([loginOptions(f.auth), loginOptions(f.auth)]);
    const results = await Promise.all(attempts.map(p => call(f.auth, '/auth/login/verify', { response: device.login(p.challenge, 2) }, p.cookie, p.csrf)));
    assert.equal(results.filter(r => r.status === 200).length, 1, 'same nonzero counter must only commit once across distinct challenges');
  } finally { await f.cleanup(); }
});

test('adapter: preauth 10min expiry and successful challenge at 119999ms', async () => {
  const f = await fixture();
  try {
    const { device } = await enroll(f);
    const p = await loginOptions(f.auth);
    f.advance(119_999);
    assert.equal((await call(f.auth, '/auth/login/verify', { response: device.login(p.challenge) }, p.cookie, p.csrf)).status, 200);
    const expired = await preauth(f.auth);
    f.advance(600_000);
    assert.equal((await call(f.auth, '/auth/login/options', {}, expired.cookie, expired.csrf)).status, 401);
  } finally { await f.cleanup(); }
});

test('storage: failed first-owner write retains invitation and creates no session', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'invitation');
    await provisionOwner({ authRoot: f.dir, invitationPath: path }, f.clock);
    const invitation = (await readFile(path, 'utf8')).trim();
    const before = await readFile(join(f.dir, 'auth-metadata.json'), 'utf8');
    const p = await preauth(f.auth);
    const opts = await call(f.auth, '/auth/enroll/options', { invitation }, p.cookie, p.csrf);
    assert.equal(opts.status, 200);
    await mkdir(join(f.dir, `auth-metadata.json.tmp.hitl-web-auth.${process.pid}`), { mode: 0o700 });
    const response = virtualAuthenticator().registration((opts.body['options'] as { challenge: string }).challenge);
    const result = await call(f.auth, '/auth/enroll/verify', { response }, p.cookie, p.csrf);
    assert.equal(result.status, 503); assert.equal(result.cookies.length, 0);
    assert.equal(await readFile(join(f.dir, 'auth-metadata.json'), 'utf8'), before);
    assert.equal(await f.auth.authenticate(request(p.cookie)), null);
  } finally { await f.cleanup(); }
});

test('status: simulated non-POSIX process refuses; does not prove native Windows ACLs', async () => {
  const f = await fixture();
  try {
    const moduleURL = new URL('../../src/hitl/web/auth.js', import.meta.url).href;
    const script = `Object.defineProperty(process, 'platform', {value: 'win32'});
      const {createAuth, provisionOwner} = await import(${JSON.stringify(moduleURL)});
      const auth = await createAuth(${JSON.stringify(f.config)}, () => 1800000000000);
      const provision = await provisionOwner({authRoot:${JSON.stringify(f.dir)}, invitationPath:${JSON.stringify(join(f.dir, 'invitation'))}});
      console.log(JSON.stringify({status:auth.status(), provision})); await auth.close();`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status.reason, 'platform_unsupported');
    assert.equal(parsed.provision.reason, 'platform_unsupported');
  } finally { await f.cleanup(); }
});

for (const mode of ['missing', 'incompatible']) {
  test(`status: isolated dependency ${mode} fault refuses safely`, async () => {
    const f = await fixture();
    try {
      // Only fault injection for refusal; positive crypto tests always use the actual package.
      const loader = join(f.dir, 'refusal-loader.mjs');
      await writeFile(loader, `export async function resolve(s,c,next) {
        if (s === '@simplewebauthn/server') { ${mode === 'missing' ? "throw new Error('test missing dependency');" : "return {url:'data:text/javascript,export const incompatible = true',shortCircuit:true};"} }
        return next(s,c);
      }`, { mode: 0o600 });
      const moduleURL = new URL('../../src/hitl/web/auth.js', import.meta.url).href;
      const script = `const {createAuth} = await import(${JSON.stringify(moduleURL)});
        const auth = await createAuth(${JSON.stringify(f.config)}, () => 1800000000000);
        console.log(JSON.stringify(auth.status())); await auth.close();`;
      const result = spawnSync(process.execPath, ['--no-warnings', '--loader', loader, '--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: 'dependency_unverified', reason: mode === 'missing' ? 'dependency_unverified' : 'dependency_incompatible' });
    } finally { await f.cleanup(); }
  });
}


// Independent F1 regressions exercise persisted bytes with the real adapter.
for (const [name, extra, refused] of [
  ['escaped root duplicate', '"\\u0076ersion":1', true],
  ['escaped nested duplicate', '"extra":{"key":1,"\\u006bey":2}', true],
  ['duplicate in array object', '"extra":[{"key":1,"key":2}]', true],
  ['escaped duplicate in array object', '"extra":[{"key":1,"\\u006bey":2}]', true],
  ['repeated keys in separate objects', '"extra":[{"key":1},{"key":2}]', false],
  ['punctuation in strings', '"extra":' + JSON.stringify({ text: '{"key":1,"key":2}: [ ] \\ "' }), false],
  ['prototype-like names', '"__proto__":{"polluted":true},"constructor":{},"prototype":{}', false],
  ['escaped prototype duplicate', '"__proto__":{},"\\u005f_proto__":{}', true],
  ['depth at bound', '"extra":' + '['.repeat(63) + '0' + ']'.repeat(63), false],
  ['depth beyond bound', '"extra":' + '['.repeat(64) + '0' + ']'.repeat(64), true],
] as const) {
  test('storage regression: ' + name, async () => {
    const f = await fixture();
    try {
      const path = join(f.dir, 'auth-metadata.json');
      const raw = '{"version":1,"generation":0,"invitation":null,"credential":null,' + extra + '}';
      assert.doesNotThrow(() => JSON.parse(raw));
      await writeFile(path, raw, { mode: 0o600 });
      const auth = await createAuth(f.config, f.clock);
      try {
        assert.equal(auth.status().reason, refused ? 'storage_corrupt' : 'provisioning_required');
        assert.equal(await readFile(path, 'utf8'), raw);
        assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
      } finally { await auth.close(); }
    } finally { await f.cleanup(); }
  });
}

test('adapter regression: signed zero-counter enrollment and concurrent separate zero-counter logins remain valid', async () => {
  const f = await fixture();
  try {
    const { device, result } = await enroll(f);
    const path = join(f.dir, 'auth-metadata.json');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).credential.counter, 0);
    assert.ok(await f.auth.authenticate(request(result.cookies[0]!.split(';')[0]!)));
    const second = await createAuth(f.config, f.clock);
    try {
      const attempts = await Promise.all([f.auth, second].map(async auth => ({ auth, p: await loginOptions(auth) })));
      assert.notEqual(attempts[0]!.p.challenge, attempts[1]!.p.challenge);
      const results = await Promise.all(attempts.map(({ auth, p }) =>
        call(auth, '/auth/login/verify', { response: device.login(p.challenge, 0) }, p.cookie, p.csrf)));
      assert.deepEqual(results.map(r => r.status), [200, 200]);
      for (const [index, login] of results.entries()) {
        assert.ok(await attempts[index]!.auth.authenticate(request(login.cookies[0]!.split(';')[0]!)));
      }
      assert.equal(JSON.parse(await readFile(path, 'utf8')).credential.counter, 0);
    } finally { await second.close(); }
  } finally { await f.cleanup(); }
});

test('adapter regression: two adapters commit one positive-counter winner and persist increases without rollback', async () => {
  const f = await fixture();
  try {
    const { device } = await enroll(f);
    const second = await createAuth(f.config, f.clock);
    const path = join(f.dir, 'auth-metadata.json');
    try {
      const attempts = await Promise.all([f.auth, second].map(async auth => ({ auth, p: await loginOptions(auth) })));
      assert.notEqual(attempts[0]!.p.challenge, attempts[1]!.p.challenge);
      const results = await Promise.all(attempts.map(({ auth, p }) =>
        call(auth, '/auth/login/verify', { response: device.login(p.challenge, 1) }, p.cookie, p.csrf)));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).credential.counter, 1);
      const loser = results.findIndex(r => r.status === 403);
      assert.equal(results[loser]!.cookies.length, 0);
      assert.deepEqual(results[loser]!.body, { error: 'verification_failed' });
      const lost = attempts[loser]!;
      assert.equal((await call(lost.auth, '/auth/login/verify', { response: device.login(lost.p.challenge, 2) }, lost.p.cookie, lost.p.csrf)).status, 410);
      const stale = await loginOptions(f.auth);
      const next = await loginOptions(second);
      assert.equal((await call(second, '/auth/login/verify', { response: device.login(next.challenge, 3) }, next.cookie, next.csrf)).status, 200);
      const committed = await readFile(path, 'utf8');
      assert.equal(JSON.parse(committed).credential.counter, 3);
      const denied = await call(f.auth, '/auth/login/verify', { response: device.login(stale.challenge, 2) }, stale.cookie, stale.csrf);
      assert.equal(denied.status, 403);
      assert.equal(denied.cookies.length, 0);
      assert.equal(await readFile(path, 'utf8'), committed);
      const higher = await loginOptions(f.auth);
      assert.equal((await call(f.auth, '/auth/login/verify', { response: device.login(higher.challenge, 4) }, higher.cookie, higher.csrf)).status, 200);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).credential.counter, 4);
    } finally { await second.close(); }
  } finally { await f.cleanup(); }
});
