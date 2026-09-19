// CI-only acceptance caller. Never import this from the unit-test enumerator.
import { createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, lstat, readdir } from 'node:fs/promises';
import { rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve, parse, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT = '997c94212339070d54442dae7187f8f955d016bfc2dc93877794d7895843fd57';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const VERSION = '145.0.7632.6';
const IDS = [
  'runner', 'fixtures', 'tls-browser-trusted', 'tls-browser-untrusted',
  'tls-browser-wrong-san', 'tls-browser-no-ca-home', 'tls-node-trusted',
  'tls-node-untrusted', 'tls-node-wrong-san', 'enroll', 'logout', 'login',
  'session-cookie', 'no-session', 'invalid-cookie', 'csrf-missing', 'csrf-wrong',
  'cross-origin', 'assertion-replay', 'bad-uv', 'bad-signature', 'wrong-rp',
  'wrong-origin', 'direct-ui', 'direct-query', 'direct-cookie', 'direct-headers',
  'direct-json-navigation', 'raw-cookie', 'http-ready-adapter', 'http-private',
  'http-auth', 'http-browser', 'cli-ready', 'cli-login', 'cli-tls', 'cli-ui',
  'cli-query', 'cli-cookie', 'cli-headers', 'cli-json-navigation', 'no-execution',
  'private-logs', 'cleanup',
];
const outcomes = new Map();
const observations = [];
const secrets = new Set();
const children = new Set();
const contexts = new Map();
const browsers = new Set();
const services = new Set();
const logs = [];
let assertions = 0, temporary, stopping = false, current = 'runner';
let globalTimer, abortRun, cancellation, receiptTarget, deadline;
let workSettled = false;
const started = new Date().toISOString();
const digest = value => createHash('sha256').update(value).digest('hex');
const fileHash = async path => digest(await readFile(path));
const check = condition => { assertions++; if (!condition) throw new Error('acceptance_failed'); };
const remember = value => { if (typeof value === 'string' && value.length >= 16) secrets.add(value); return value; };
const done = id => { check(IDS.includes(id) && !outcomes.has(id)); outcomes.set(id, 'pass'); };
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function invalidateReceipt() {
  if (!receiptTarget) return;
  try { rmSync(receiptTarget, { force: true }); }
  catch { try { writeFileSync(receiptTarget, '{"status":"fail"}\n', { mode: 0o600 }); } catch {} }
}
async function bounded(promise, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function privateDir(path) { await mkdir(path, { mode: 0o700 }); return path; }
async function privateFile(path, data) { await writeFile(path, data, { flag: 'wx', mode: 0o600 }); }
async function safeAncestors(path) {
  let part = parse(path).root;
  for (const component of relative(part, path).split(sep).filter(Boolean)) {
    part = join(part, component);
    const stat = await lstat(part);
    check(stat.isDirectory() && !stat.isSymbolicLink());
  }
}
function childEnv(home) {
  return { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    TMPDIR: temporary, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache') };
}
function child(command, args, home = temporary) {
  check(!stopping);
  const proc = spawn(command, args, { cwd: ROOT, env: childEnv(home), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.add(proc);
  const log = { bytes: 0, chunks: [], overflow: false };
  logs.push(log);
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', data => {
    log.bytes += data.length;
    if (log.bytes <= 1024 * 1024) log.chunks.push(data);
    else { log.overflow = true; proc.kill('SIGTERM'); abortRun?.(new Error('log_limit')); }
  });
  proc.completed = new Promise(resolveExit => {
    proc.once('error', () => resolveExit(-1));
    proc.once('exit', code => resolveExit(code));
  });
  return { proc, log };
}
async function terminate(proc) {
  if (proc.exitCode === null && proc.signalCode === null) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
    if (await Promise.race([proc.completed.then(() => true), delay(2000).then(() => false)]) === false) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      await bounded(proc.completed, 3000);
    }
  }
  children.delete(proc);
}
async function command(name, args) {
  const { proc, log } = child(`/usr/bin/${name}`, args);
  try {
    check(await bounded(proc.completed, 20000) === 0 && !log.overflow);
    return Buffer.concat(log.chunks).toString('utf8');
  } finally { await terminate(proc); }
}
function headers(actual, type) {
  check(actual['content-type'] === `${type}; charset=utf-8`);
  check(actual['content-security-policy'] === CSP);
  check(actual['x-content-type-options'] === 'nosniff' && actual['cache-control'] === 'no-store');
  check(actual['x-frame-options'] === 'DENY' && actual['referrer-policy'] === 'no-referrer');
}
function request(port, path, { ca, cookie, method = 'GET', body, origin, secure = true } = {}) {
  return bounded(new Promise((resolveRequest, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (secure ? https : http).request({
      hostname: '127.0.0.1', port, path, method, agent: false, maxHeaderSize: 16384,
      ...(secure ? { ca, servername: 'localhost', rejectUnauthorized: true } : {}),
      headers: { Host: `localhost:${port}`, ...(cookie ? { Cookie: cookie } : {}),
        ...(origin ? { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      const socket = res.socket;
      const tls = secure ? { authorized: socket.authorized, protocol: socket.getProtocol(),
        fingerprint: socket.getPeerCertificate().fingerprint256 } : null;
      const chunks = [];
      let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) req.destroy(new Error('body_limit')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), tls }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('socket_timeout')));
    req.on('error', reject);
    req.end(payload);
  }));
}
async function treeHash(folder) {
  const entries = [];
  async function walk(path) {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name), stat = await lstat(full);
      check(!stat.isSymbolicLink());
      if (stat.isDirectory()) await walk(full);
      else { check(stat.isFile()); entries.push([relative(ROOT, full), await fileHash(full)]); }
    }
  }
  await walk(join(ROOT, folder));
  check(entries.length > 0);
  return digest(JSON.stringify(entries));
}
async function identity() {
  return { source: await treeHash('src'), compiled: await treeHash('dist/src'),
    lock: await fileHash(join(ROOT, 'package-lock.json')), manifest: await fileHash(join(ROOT, 'package.json')),
    caller: await fileHash(fileURLToPath(import.meta.url)), cli: await fileHash(join(ROOT, 'dist/src/hitl/web/cli.js')),
    contract: CONTRACT };
}
async function toolHashes() {
  return { node: await fileHash(process.execPath), openssl: await fileHash('/usr/bin/openssl'),
    certutil: await fileHash('/usr/bin/certutil'), imageRelease: await fileHash('/etc/os-release') };
}
async function certificates() {
  const dir = await privateDir(join(temporary, 'certificates'));
  for (const name of ['ca', 'other']) {
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', `/CN=acceptance-${name}`, '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`)]);
  }
  const result = {};
  for (const [name, issuer, san] of [['trusted', 'ca', 'localhost'], ['untrusted', 'other', 'localhost'], ['wrong-san', 'ca', 'wrong.invalid']]) {
    const base = join(dir, name);
    await privateFile(`${base}.ext`, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${san}\n`);
    await command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${san}`, '-keyout', `${base}.key`, '-out', `${base}.csr`]);
    await command('openssl', ['x509', '-req', '-in', `${base}.csr`, '-CA', join(dir, `${issuer}.pem`), '-CAkey', join(dir, `${issuer}.key`),
      '-set_serial', String(Object.keys(result).length + 1), '-days', '1', '-extfile', `${base}.ext`, '-out', `${base}.pem`]);
    const cert = await readFile(`${base}.pem`), key = await readFile(`${base}.key`);
    check(((await lstat(`${base}.key`)).mode & 0o777) === 0o600);
    result[name] = { cert, key, keyPath: `${base}.key`, certPath: `${base}.pem`, fingerprint: new X509Certificate(cert).fingerprint256 };
  }
  result.ca = await readFile(join(dir, 'ca.pem'));
  result.caPath = join(dir, 'ca.pem');
  return result;
}
function processIdentity(text) {
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
  const identity = { pid, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), birth: fields[19] };
  check(Number.isSafeInteger(pid) && pid > 1 && /^\d+$/.test(identity.birth ?? ''));
  return identity;
}
async function liveIdentity(pid) {
  try { return processIdentity(await readFile(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
}
function sameProcess(a, b) {
  return a && b && a.pid === b.pid && a.birth === b.birth && a.group === b.group && a.session === b.session;
}
function groupAlive(owner) {
  try { process.kill(-owner.identity.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function verifyBrowserExit(owner) {
  check(!groupAlive(owner));
  for (const member of owner.members.values()) {
    const live = await liveIdentity(member.pid);
    // A known descendant changing its group/session is not proof of exit.
    check(!live || live.birth !== member.birth);
  }
}
async function ownedDescendants(owner) {
  // Read only the recorded process and its descendants, never a host process census.
  const visited = new Set();
  async function visit(identity) {
    if (visited.has(identity.pid) || !sameProcess(identity, await liveIdentity(identity.pid))) return;
    visited.add(identity.pid);
    owner.members.set(identity.pid, identity);
    try {
      for (const tid of await readdir(`/proc/${identity.pid}/task`)) {
        const children = await readFile(`/proc/${identity.pid}/task/${tid}/children`, 'utf8');
        for (const pid of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
          const member = await liveIdentity(pid);
          if (!member || member.parent !== identity.pid || !sameProcess(identity, await liveIdentity(identity.pid))) continue;
          // A descendant that escaped the owned session/group makes cleanup unprovable.
          check(member.group === owner.identity.pid && member.session === owner.identity.pid);
          await visit(member);
        }
      }
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  for (const member of [...owner.members.values()]) await visit(member);
}
async function signalBrowser(owner, signal) {
  if (!groupAlive(owner)) return;
  for (const member of owner.members.values()) {
    if (sameProcess(member, await liveIdentity(member.pid))) {
      try { process.kill(-owner.identity.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      return;
    }
  }
  throw new Error('browser_ownership');
}
async function discoverBrowser(owner) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    let text;
    try { text = await readFile(owner.record, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (text?.endsWith('\n')) {
      const identity = processIdentity(text);
      check(identity.parent === process.pid && identity.group === identity.pid && identity.session === identity.pid);
      owner.identity = identity;
      owner.members.set(identity.pid, identity);
      check(sameProcess(identity, await liveIdentity(identity.pid)));
      return;
    }
    await delay(25);
  }
  throw new Error('browser_ownership');
}
async function browser(chromium, certs, trusted) {
  const home = await mkdtemp(join(temporary, 'home-'));
  await privateDir(join(home, '.pki'));
  const db = await privateDir(join(home, '.pki/nssdb'));
  await command('certutil', ['-N', '--empty-password', '-d', `sql:${db}`]);
  if (trusted) await command('certutil', ['-A', '-d', `sql:${db}`, '-t', 'C,,', '-n', 'acceptance-ca', '-i', certs.caPath]);
  check(!stopping);
  // Playwright 1.58.2 launches executablePath as a detached Linux session/group.
  // The private exec shim records that identity before Chromium or CDP can stall.
  const record = join(home, 'owner'), permit = join(home, 'launch-permit'), executable = join(home, 'chromium-owned');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(executable, `#!/bin/sh\nset -euC\numask 077\nIFS= read -r identity < "/proc/$$/stat"\nprintf '%s\\n' "$identity" > ${quote(record)}\ni=0\nwhile [ ! -f ${quote(permit)} ]; do\n  i=$((i + 1))\n  [ "$i" -lt 100 ] || exit 1\n  /usr/bin/sleep 0.1\ndone\nexec ${quote(chromium.executablePath())} "$@"\n`, { flag: 'wx', mode: 0o700 });
  check(!stopping);
  const owner = { record, members: new Map(), context: null, settled: false };
  browsers.add(owner);
  const launch = chromium.launchPersistentContext(join(home, 'profile'), {
    channel: 'chromium', headless: true, chromiumSandbox: true, ignoreHTTPSErrors: false,
    // The caller handles both signals through verified cleanup and receipt invalidation.
    // Playwright's own SIGINT handler exits the process before that work completes.
    handleSIGINT: false, handleSIGTERM: false,
    executablePath: executable, env: childEnv(home), timeout: 20000,
  }).then(context => {
    owner.context = context; contexts.set(context, owner); return context;
  }).finally(() => { owner.settled = true; });
  // Attach rejection handling immediately, including failures before discovery finishes.
  owner.launch = launch.then(() => {}, () => {});
  owner.discovery = discoverBrowser(owner);
  await bounded(owner.discovery, 11000);
  check(!stopping);
  await privateFile(permit, 'launch\n');
  const context = await bounded(launch, 25000);
  if (stopping) { await closeBrowser(context); throw new Error('cancelled'); }
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(10000);
  check(context.browser().version() === VERSION);
  await bounded(ownedDescendants(owner), 5000);
  check(sameProcess(owner.identity, await liveIdentity(owner.identity.pid)));
  // Observe the exec'd Chromium command line without waiting for a CDP response.
  const args = (await readFile(`/proc/${owner.identity.pid}/cmdline`, 'utf8')).split('\0');
  check(args[0] === chromium.executablePath());
  check(!args.some(arg => /^--(?:no-sandbox|disable-setuid-sandbox|ignore-certificate-errors|allow-insecure-localhost)/.test(arg)));
  return context;
}
async function closeOwnedBrowser(owner) {
  if (owner.closing) return owner.closing;
  owner.closing = (async () => {
    let failed = false;
    try { await bounded(owner.discovery, 11000); } catch { failed = true; }
    if (!owner.identity) throw new Error('browser_ownership');
    await bounded(ownedDescendants(owner), 5000);
    if (owner.context) {
      try { await bounded(owner.context.close(), 5000); } catch { failed = true; }
    }
    if (groupAlive(owner)) {
      await bounded(signalBrowser(owner, 'SIGTERM'), 3000);
      const until = Date.now() + 2000;
      while (groupAlive(owner) && Date.now() < until) await delay(50);
      if (groupAlive(owner)) await bounded(signalBrowser(owner, 'SIGKILL'), 3000);
      const killedUntil = Date.now() + 3000;
      while (groupAlive(owner) && Date.now() < killedUntil) await delay(50);
    }
    await bounded(verifyBrowserExit(owner), 3000);
    await bounded(owner.launch, 25000);
    check(owner.settled);
    await bounded(verifyBrowserExit(owner), 3000);
    // Keep ownership and private storage on every failed or unverified cleanup path.
    if (failed) throw new Error('browser_cleanup');
    if (owner.context) contexts.delete(owner.context);
    browsers.delete(owner);
  })();
  return owner.closing;
}
async function closeBrowser(context) {
  const owner = contexts.get(context);
  check(owner);
  await closeOwnedBrowser(owner);
}
async function start(startServer, auth, hitlRoot, port, tls) {
  check(!stopping);
  const service = await bounded(startServer({ host: '127.0.0.1', port, auth, hitlRoot, ...(tls ? { tls } : {}) }));
  services.add(service);
  if (stopping) { await closeService(service); throw new Error('cancelled'); }
  check(service.server.address().address === '127.0.0.1' && service.server.address().port === port);
  observations.push({ phase: current, port, transport: tls ? 'https' : 'http' });
  return service;
}
async function closeService(service) { await bounded(service.close()); services.delete(service); }
async function fixtures(root) {
  const pending = [], history = [];
  const payloads = [
    '<script>globalThis.__acceptanceXss=1</script>',
    '<img src="/__acceptance_attack__" onerror="globalThis.__acceptanceXss=1">',
    '<svg onload="globalThis.__acceptanceXss=1"></svg>',
    '</button></dd><iframe src="/__acceptance_attack__"></iframe>',
  ];
  for (const [view, count, rows] of [['pending', 29, pending], ['decided', 4, history]]) {
    const folder = await privateDir(join(root, view));
    for (let i = 0; i < count; i++) {
      const source = `fixture-${String(i).padStart(3, '0')}`, question = `${view}-${i} ${payloads[i % payloads.length]}`;
      const hash = digest(`${source}|decision|${question}`).slice(0, 12), id = `decision-${source}-${hash}`;
      const subject = `worker ${payloads[(i + 1) % payloads.length]}`;
      await privateFile(join(folder, `${id}.json`), JSON.stringify({ id, source, kind: 'decision', question,
        subject_sid: subject, created_at: '2026-01-01T00:00:00.000Z', context_ref: null, options: ['approve', 'reject'],
        dedupe_key: hash, status: view === 'pending' ? 'pending' : 'approved',
        decision: view === 'pending' ? null : 'approve', decided_at: view === 'pending' ? null : '2026-01-02T00:00:00.000Z' }));
      rows.push({ id, question, subject });
    }
  }
  done('fixtures');
  return { pending, history, payload: payloads[1] };
}
async function fetchPage(page, path, body, csrf) {
  check(!stopping);
  const result = await bounded(page.evaluate(async ({ path, body, csrf }) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(csrf ? { 'x-inbox-csrf': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  }, { path, body, csrf }));
  headers(result.headers, 'application/json');
  return { ...result, json: JSON.parse(result.body) };
}
async function preauth(page) {
  const response = await fetchPage(page, '/auth/preauth', {});
  check(response.status === 200 && response.json.csrfHeader === 'x-inbox-csrf');
  return remember(response.json.csrf);
}
async function options(page, csrf, enrollment, invitation) {
  const response = await fetchPage(page, enrollment ? '/auth/enroll/options' : '/auth/login/options', enrollment ? { invitation } : {}, csrf);
  check(response.status === 200);
  const value = response.json.options;
  check(enrollment ? value.rp.id === 'localhost' && value.authenticatorSelection.userVerification === 'required'
    : value.rpId === 'localhost' && value.userVerification === 'required');
  return value;
}
async function credential(page, value, enrollment = false) {
  check(!stopping);
  const response = await bounded(page.evaluate(async ({ value, enrollment }) => {
    const publicKey = enrollment ? PublicKeyCredential.parseCreationOptionsFromJSON(value) : PublicKeyCredential.parseRequestOptionsFromJSON(value);
    const result = await navigator.credentials[enrollment ? 'create' : 'get']({ publicKey, signal: AbortSignal.timeout(8000) });
    return result.toJSON();
  }, { value, enrollment }));
  remember(JSON.stringify(response));
  for (const value of Object.values(response.response)) remember(value);
  return response;
}
async function login(page) {
  const csrf = await preauth(page), value = await options(page, csrf, false);
  const response = await credential(page, value);
  const verified = await fetchPage(page, '/auth/login/verify', { response }, csrf);
  check(verified.status === 200 && verified.json.state === 'ready');
  return { csrf: remember(verified.json.csrf), response, preauthCsrf: csrf };
}
async function sessionCookie(context, page, state) {
  const cookie = (await context.cookies()).find(c => c.name === '__Host-inbox');
  check(cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/' && cookie.domain === 'localhost');
  check(!(await page.evaluate(() => document.cookie)).includes('__Host-inbox'));
  if (state) {
    const response = state.responses.filter(res => /\/auth\/(enroll|login)\/verify$/.test(res.url()) && res.status() === 200).at(-1);
    check(response);
    const values = (await response.headersArray()).filter(header => header.name.toLowerCase() === 'set-cookie').map(header => header.value);
    const session = values.find(value => value.startsWith('__Host-inbox='));
    check(session && !/;\s*Domain=/i.test(session) && /; Path=\/(?:;|$)/.test(session)
      && /; Secure(?:;|$)/.test(session) && /; HttpOnly(?:;|$)/.test(session) && /; SameSite=Strict(?:;|$)/.test(session));
  }
  remember(cookie.value);
  return `${cookie.name}=${cookie.value}`;
}
async function noSession(context, page) {
  check(!(await context.cookies()).some(c => c.name === '__Host-inbox'));
  check((await fetchPage(page, '/api/requests')).status === 401);
}
async function authNegatives(context, page, cdp, authenticatorId, certs) {
  current = 'authentication-negatives';
  await noSession(context, page); done('no-session');
  const invalid = await request(18787, '/api/requests', { ca: certs.ca, cookie: '__Host-inbox=invalid' });
  check(invalid.status === 401); headers(invalid.headers, 'application/json'); done('invalid-cookie');
  const csrf = await preauth(page);
  check((await fetchPage(page, '/auth/login/options', {})).status === 403); done('csrf-missing');
  check((await fetchPage(page, '/auth/login/options', {}, 'invalid')).status === 403); done('csrf-wrong');
  const cross = await request(18787, '/auth/preauth', { ca: certs.ca, method: 'POST', body: {}, origin: 'https://wrong.invalid' });
  check(cross.status === 403 && !cross.headers['set-cookie']); headers(cross.headers, 'application/json'); done('cross-origin');
  for (const [id, bits] of [['bad-uv', { isBadUV: true }], ['bad-signature', { isBogusSignature: true }], ['wrong-origin', {}]]) {
    const token = await preauth(page), value = await options(page, token, false);
    await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: false, isBogusSignature: false, ...bits });
    let response;
    try { response = await credential(page, value); }
    finally { await cdp.send('WebAuthn.setResponseOverrideBits', { authenticatorId, isBadUV: false, isBogusSignature: false }); }
    if (id === 'wrong-origin') {
      const client = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
      client.origin = 'https://wrong.invalid';
      response.response.clientDataJSON = Buffer.from(JSON.stringify(client)).toString('base64url');
    }
    const denied = await fetchPage(page, '/auth/login/verify', { response }, token);
    check(denied.status === 403 && ['verification_failed', 'user_verification_required'].includes(denied.json.error));
    await noSession(context, page); done(id);
    // A claimed challenge is consumed even when the real verifier refuses it.
    if (id === 'wrong-origin') {
      const replay = await fetchPage(page, '/auth/login/verify', { response }, token);
      check(replay.status === 410 && replay.json.error === 'challenge_expired');
      await noSession(context, page);
    }
  }
  const token = await preauth(page), value = await options(page, token, false);
  const wrongRp = await page.evaluate(async value => {
    try {
      value.rpId = 'wrong.invalid';
      await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(value), signal: AbortSignal.timeout(8000) });
      return false;
    } catch (error) { return error.name === 'SecurityError'; }
  }, value);
  check(wrongRp); await noSession(context, page); done('wrong-rp');
}
function observe(page) {
  const state = { dialogs: 0, attacks: 0, errors: 0, responses: [] };
  page.on('dialog', dialog => { state.dialogs++; void dialog.dismiss().catch(() => {}); });
  page.on('pageerror', () => { state.errors++; });
  page.on('request', req => { if (new URL(req.url()).pathname === '/__acceptance_attack__') state.attacks++; });
  page.on('response', response => {
    if (state.responses.length >= 500) { abortRun?.(new Error('response_limit')); return; }
    state.responses.push(response);
  });
  return state;
}
async function cleanDOM(page, state) {
  check(state.dialogs === 0 && state.attacks === 0 && state.errors === 0);
  check(await page.evaluate(() => !globalThis.__acceptanceXss && !document.querySelector('img,svg,iframe,[onerror],[onload]')
    && [...document.scripts].every(script => script.src === `${location.origin}/assets/inbox.js` && !script.textContent)));
}
async function ui(page, origin, rows, state) {
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25 && !document.querySelector('#refresh').disabled);
  check(JSON.stringify(await page.locator('#requests button').allTextContents()) === JSON.stringify(rows.pending.slice(0, 25).map(row => `${row.id} — ${row.question}`)));
  const responsePromise = page.waitForResponse(res => new URL(res.url()).searchParams.has('cursor'));
  await page.locator('#more').click();
  const response = await responsePromise, data = await response.json();
  check(new URL(response.url()).searchParams.get('cursor') === rows.pending[24].id && data.items.length === 4 && data.nextCursor === null);
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 29 && !document.querySelector('#refresh').disabled);
  check(JSON.stringify(await page.locator('#requests button').allTextContents()) === JSON.stringify(rows.pending.map(row => `${row.id} — ${row.question}`)));
  check(await page.locator('#more').isHidden());
  for (const index of [0, 1, 2, 3, 28]) {
    await page.locator('#requests button').nth(index).click();
    await page.waitForFunction(id => document.querySelector('#fields dd')?.textContent === id && !document.querySelector('#detail').hidden, rows.pending[index].id);
    const fields = await page.locator('#fields dd').allTextContents();
    check(fields[1] === rows.pending[index].question && fields[2] === rows.pending[index].subject);
    await cleanDOM(page, state);
  }
  await page.locator('#history').click();
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 4 && !document.querySelector('#refresh').disabled);
  check(JSON.stringify(await page.locator('#requests button').allTextContents()) === JSON.stringify(rows.history.map(row => `${row.id} — ${row.question}`)));
  for (let i = 0; i < rows.history.length; i++) {
    await page.locator('#requests button').nth(i).click();
    await page.waitForFunction(id => document.querySelector('#fields dd')?.textContent === id && !document.querySelector('#detail').hidden, rows.history[i].id);
    const fields = await page.locator('#fields dd').allTextContents();
    check(fields[1] === rows.history[i].question && fields[2] === rows.history[i].subject && fields[8] === 'approve');
  }
  const refreshed = page.waitForResponse(res => res.url() === `${origin}/api/requests?view=history&limit=25`);
  await page.locator('#refresh').click(); await refreshed;
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 4 && !document.querySelector('#refresh').disabled);
  check((await fetchPage(page, '/api/requests')).json.warnings.length === 0);
  await cleanDOM(page, state);
}
async function surface(prefix, context, page, origin, rows, state) {
  current = `${prefix}-surface`;
  await context.addCookies([{ name: 'acceptance-hostile', value: rows.payload, url: origin, secure: true, sameSite: 'Strict' }]);
  check((await context.cookies()).some(cookie => cookie.name === 'acceptance-hostile' && cookie.value === rows.payload));
  await sessionCookie(context, page);
  await ui(page, origin, rows, state); done(`${prefix}-ui`);
  const detail = `/api/requests/${rows.pending[0].id}`;
  check((await fetchPage(page, detail)).json.question === rows.pending[0].question);
  done(`${prefix}-cookie`);
  const hostile = encodeURIComponent(rows.payload);
  for (const path of [`/api/requests?view=${hostile}`, `/api/requests?cursor=${hostile}`, `/api/requests?limit=${hostile}`,
    `/api/requests?unknown=${hostile}`, `/api/requests?view=pending&view=${hostile}`, `${detail}?view=${hostile}`, `${detail}?unknown=${hostile}`]) {
    const result = await fetchPage(page, path);
    check(result.status === 400 && result.body === '{"error":"invalid_query"}');
    const nav = await page.goto(`${origin}${path}`);
    check(nav.status() === 400 && await nav.text() === '{"error":"invalid_query"}');
    headers(await nav.allHeaders(), 'application/json'); await cleanDOM(page, state);
  }
  done(`${prefix}-query`);
  const nav = await page.goto(`${origin}${detail}`);
  check(nav.status() === 200 && (await nav.json()).question === rows.pending[0].question);
  headers(await nav.allHeaders(), 'application/json'); await cleanDOM(page, state); done(`${prefix}-json-navigation`);
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll('#requests li').length === 25);
  for (const [path, type] of [['/', 'text/html'], ['/assets/inbox.js', 'text/javascript'], ['/assets/inbox.css', 'text/css'], ['/api/requests', 'application/json']]) {
    const seen = state.responses.filter(res => res.url() === `${origin}${path}` && res.status() === 200);
    check(seen.length > 0);
    headers(await seen.at(-1).allHeaders(), type);
  }
  done(`${prefix}-headers`);
}
async function tlsRefusal(page, origin) {
  let refused = false, responded = false;
  const listener = () => { responded = true; };
  page.on('response', listener);
  try { await page.goto(origin); }
  catch (error) { refused = /net::ERR_CERT_(AUTHORITY_INVALID|COMMON_NAME_INVALID)/.test(String(error.message)); }
  finally { page.off('response', listener); }
  check(refused && !responded);
}
async function nodeTLS(port, certs, leaf) {
  const response = await request(port, '/api/capabilities', { ca: certs.ca });
  check(response.status === 200 && response.tls.authorized && ['TLSv1.2', 'TLSv1.3'].includes(response.tls.protocol)
    && response.tls.fingerprint === leaf.fingerprint);
  headers(response.headers, 'application/json');
  observations.push({ phase: current, port, transport: 'https', fingerprint: response.tls.fingerprint, protocol: response.tls.protocol });
}
async function nodeTLSRefusal(certs, name) {
  let code;
  try { await request(18787, '/api/requests', { ca: certs.ca }); }
  catch (error) { code = error.code; }
  check(name === 'wrong-san' ? code === 'ERR_TLS_CERT_ALTNAME_INVALID'
    : ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(code));
}
async function main() {
  current = 'runner';
  check(process.platform === 'linux' && process.getuid() !== 0 && process.version.startsWith('v20.'));
  check(process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
  check(process.env.GITHUB_JOB === 'browser-tls' && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''));
  check(/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') && process.env.RUNNER_ENVIRONMENT === 'github-hosted');
  check(!process.env.NODE_TLS_REJECT_UNAUTHORIZED && !process.env.NODE_EXTRA_CA_CERTS && !process.env.NODE_OPTIONS);
  check(/^ubuntu\d+$/.test(process.env.ImageOS ?? '') && /^[\d.]+$/.test(process.env.ImageVersion ?? ''));
  await safeAncestors(process.env.RUNNER_TEMP);
  temporary = await mkdtemp(join(process.env.RUNNER_TEMP, 'browser-tls-private-'));
  process.umask(0o077);
  const openssl = (await command('openssl', ['version'])).match(/^OpenSSL ([\d.]+[a-z]?)/)?.[1];
  const nss = (await command('dpkg-query', ['-W', '-f=${Version}', 'libnss3-tools'])).trim();
  check(openssl && /^[\w.+:~-]+$/.test(nss));
  const head = (await command('git', ['rev-parse', 'HEAD'])).trim();
  check(head === process.env.GITHUB_SHA);
  const hashes = await identity();
  check(JSON.parse(await readFile(join(ROOT, 'node_modules/playwright/package.json'))).version === '1.58.2');
  check(JSON.parse(await readFile(join(ROOT, 'node_modules/playwright-core/package.json'))).version === '1.58.2');
  const manifest = JSON.parse(await readFile(join(ROOT, 'node_modules/playwright-core/browsers.json')));
  const pinned = manifest.browsers.find(item => item.name === 'chromium');
  check(pinned.revision === '1208' && pinned.browserVersion === VERSION);
  const { chromium } = await import('playwright');
  const executableHash = await fileHash(chromium.executablePath());
  done('runner');
  const certs = await certificates();
  const hitlRoot = await privateDir(join(temporary, 'hitl')), authRoot = join(temporary, 'auth');
  const rows = await fixtures(hitlRoot);
  const { createAuth, provisionOwner } = await import(pathToFileURL(join(ROOT, 'dist/src/hitl/web/auth.js')));
  const { startServer } = await import(pathToFileURL(join(ROOT, 'dist/src/hitl/web/server.js')));
  const invitationPath = join(temporary, 'invitation');
  check((await provisionOwner({ authRoot, invitationPath })).state === 'created');
  const invitation = remember((await readFile(invitationPath, 'utf8')).trim());
  const authFor = () => createAuth({ origin: 'https://localhost:18787', rpId: 'localhost', stateDir: authRoot, tlsReady: true }, Date.now);
  for (const name of ['untrusted', 'wrong-san']) {
    current = `tls-${name}`;
    const auth = await authFor();
    const service = await start(startServer, auth, hitlRoot, 18787, certs[name]);
    const context = await browser(chromium, certs, true);
    await tlsRefusal(context.pages()[0], service.origin); done(`tls-browser-${name}`);
    await nodeTLSRefusal(certs, name); done(`tls-node-${name}`);
    await closeBrowser(context); await closeService(service);
  }
  current = 'direct-https';
  const auth = await authFor();
  const service = await start(startServer, auth, hitlRoot, 18787, certs.trusted);
  const noCA = await browser(chromium, certs, false);
  await tlsRefusal(noCA.pages()[0], service.origin); done('tls-browser-no-ca-home'); await closeBrowser(noCA);
  const context = await browser(chromium, certs, true), page = context.pages()[0], state = observe(page);
  const trusted = await page.goto(service.origin);
  check(trusted.status() === 200); headers(await trusted.allHeaders(), 'text/html'); done('tls-browser-trusted');
  await nodeTLS(18787, certs, certs.trusted); done('tls-node-trusted');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  current = 'enroll';
  const csrf = await preauth(page), enrollmentOptions = await options(page, csrf, true, invitation);
  const response = await credential(page, enrollmentOptions, true);
  const enrolled = await fetchPage(page, '/auth/enroll/verify', { response }, csrf);
  check(enrolled.status === 200 && enrolled.json.state === 'ready' && auth.status().state === 'ready');
  remember(enrolled.json.csrf); done('enroll');
  await sessionCookie(context, page, state); done('session-cookie');
  check((await fetchPage(page, '/api/capabilities')).json.auth.state === 'ready');
  check((await fetchPage(page, '/auth/logout', {}, enrolled.json.csrf)).status === 200);
  await noSession(context, page); done('logout');
  await authNegatives(context, page, cdp, authenticatorId, certs);
  const logged = await login(page); done('login');
  check((await fetchPage(page, '/auth/logout', {}, logged.csrf)).status === 200);
  const replayCsrf = await preauth(page);
  await options(page, replayCsrf, false);
  const replay = await fetchPage(page, '/auth/login/verify', { response: logged.response }, replayCsrf);
  check(replay.status === 403 && replay.json.error === 'verification_failed');
  await noSession(context, page); done('assertion-replay');
  await login(page);
  const issuedCookie = await sessionCookie(context, page);
  await surface('direct', context, page, service.origin, rows, state);
  current = 'raw-cookie';
  for (const cookie of ['__Host-inbox=<invalid>', `__Host-inbox=${'x'.repeat(4097)}`, `__Host-inbox=${'x'.repeat(9000)}`]) {
    const result = await request(18787, '/api/requests', { ca: certs.ca, cookie });
    check(result.status === (cookie.length > 8192 ? 431 : 401) && !result.headers['set-cookie']);
    check(!result.body.includes(rows.pending[0].question) && !result.body.includes('<invalid>'));
    if (result.status === 401) headers(result.headers, 'application/json');
  }
  done('raw-cookie');
  current = 'http-ready-adapter';
  check(auth.status().state === 'ready');
  const plain = await start(startServer, auth, hitlRoot, 18788);
  check(auth.status().state === 'ready'); done('http-ready-adapter');
  await preauth(page);
  const preauthCookie = (await context.cookies()).find(c => c.name === '__Host-inbox-preauth');
  check(preauthCookie); remember(preauthCookie.value);
  const supplied = `${issuedCookie}; __Host-inbox-preauth=${preauthCookie.value}`;
  for (const path of ['/api/requests', '/api/requests?view=history', `/api/requests/${rows.pending[0].id}`]) {
    const result = await request(18788, path, { secure: false, cookie: supplied });
    check(result.status === 503 && result.body === '{"error":"auth_unavailable"}' && !result.headers['set-cookie']);
    headers(result.headers, 'application/json');
  }
  done('http-private');
  for (const path of ['/auth/preauth', '/auth/enroll/options', '/auth/enroll/verify', '/auth/login/options', '/auth/login/verify', '/auth/logout']) {
    const result = await request(18788, path, { secure: false, cookie: supplied, method: 'POST', body: {}, origin: plain.origin });
    check(result.status === 503 && result.body === '{"error":"auth_unavailable"}' && !result.headers['set-cookie']);
    headers(result.headers, 'application/json');
  }
  done('http-auth');
  const cookiesBefore = JSON.stringify(await context.cookies());
  const httpResponse = await page.goto(plain.origin);
  check(httpResponse.status() === 200);
  const sent = (await httpResponse.request().allHeaders()).cookie ?? '';
  observations.push({ phase: 'http-browser', port: 18788, transport: 'http', sessionCookieSent: sent.includes('__Host-inbox=') });
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Setup unavailable:'));
  check((await fetchPage(page, '/api/capabilities')).json.auth.state === 'setup_required');
  check((await fetchPage(page, '/api/requests')).status === 503 && await page.locator('#requests li').count() === 0);
  check((await fetchPage(page, '/auth/preauth', {})).status === 503 && JSON.stringify(await context.cookies()) === cookiesBefore);
  done('http-browser');
  // HTTP shares the AuthPort: closing either service closes that adapter. Close both
  // only after every direct-server measurement has completed.
  await closeService(plain); await closeService(service);
  current = 'cli';
  const { proc } = child(process.execPath, [join(ROOT, 'dist/src/hitl/web/cli.js'), 'serve', '--hitl-root', hitlRoot,
    '--auth-root', authRoot, '--port', '18789', '--tls-key', certs.trusted.keyPath, '--tls-cert', certs.trusted.certPath]);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    check(proc.exitCode === null && proc.signalCode === null);
    try {
      const result = await request(18789, '/api/capabilities', { ca: certs.ca });
      check(result.status === 200 && JSON.parse(result.body).auth.state === 'ready'); ready = true; break;
    } catch (error) { if (error.code !== 'ECONNREFUSED') throw error; }
    await delay(100);
  }
  check(ready); observations.push({ phase: 'cli', port: 18789, transport: 'https' }); done('cli-ready');
  const cliOrigin = 'https://localhost:18789';
  await page.goto(cliOrigin);
  await login(page); await sessionCookie(context, page, state); done('cli-login');
  await nodeTLS(18789, certs, certs.trusted); done('cli-tls');
  await surface('cli', context, page, cliOrigin, rows, state);
  await cleanDOM(page, state); done('no-execution');
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  await closeBrowser(context); await terminate(proc);
  // The evidence digest includes only bounded observations, never raw browser data.
  return { schemaVersion: 1, status: 'pass', skipped: 0, started, finished: '', assertions: 0,
    candidate: head, hashes, runner: { node: process.version, openssl, nss, hashes: await toolHashes(), image: process.env.ImageOS, imageVersion: process.env.ImageVersion,
      run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: 'browser-tls' },
    browser: { playwright: '1.58.2', version: VERSION, revision: '1208', executableHash },
    certificates: Object.fromEntries(['trusted', 'untrusted', 'wrong-san'].map(name => [name, certs[name].fingerprint])),
    controls: {}, observations, evidenceDigest: '' };
}
async function cleanup() {
  stopping = true;
  const results = await Promise.allSettled([
    ...[...browsers].map(closeOwnedBrowser), ...[...children].map(terminate), ...[...services].map(closeService),
  ]);
  let clean = results.every(result => result.status === 'fulfilled') && workSettled
    && browsers.size === 0 && contexts.size === 0 && children.size === 0 && services.size === 0;
  for (const log of logs) {
    const text = Buffer.concat(log.chunks).toString('utf8');
    if (log.overflow || [...secrets].some(secret => text.includes(secret))) clean = false;
    log.chunks.length = 0;
  }
  if (temporary && clean) {
    try { await bounded(rm(temporary, { recursive: true, force: true, maxRetries: 2 }), 10000); }
    catch { clean = false; }
  }
  check(clean); done('private-logs'); done('cleanup');
}
function exactKeys(value, keys) { check(value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())); }
async function validate(receipt) {
  exactKeys(receipt, ['schemaVersion', 'status', 'skipped', 'started', 'finished', 'assertions', 'candidate', 'hashes', 'runner', 'browser', 'certificates', 'controls', 'observations', 'evidenceDigest']);
  check(receipt.schemaVersion === 1 && receipt.status === 'pass' && receipt.skipped === 0 && Number.isInteger(receipt.assertions) && receipt.assertions > 200);
  check(typeof receipt.started === 'string' && typeof receipt.finished === 'string'
    && Number.isFinite(Date.parse(receipt.started)) && Date.parse(receipt.finished) >= Date.parse(receipt.started)
    && Date.parse(receipt.finished) - Date.parse(receipt.started) < 600000);
  check(receipt.candidate === process.env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(receipt.candidate));
  exactKeys(receipt.controls, IDS); check(IDS.every(id => receipt.controls[id] === 'pass'));
  const hashes = await identity(); exactKeys(receipt.hashes, Object.keys(hashes));
  check(Object.entries(hashes).every(([key, value]) => receipt.hashes[key] === value));
  exactKeys(receipt.runner, ['node', 'openssl', 'nss', 'hashes', 'image', 'imageVersion', 'run', 'attempt', 'job']);
  check(receipt.runner.node === process.version && receipt.runner.node.startsWith('v20.') && receipt.runner.job === 'browser-tls'
    && receipt.runner.run === process.env.GITHUB_RUN_ID && receipt.runner.attempt === process.env.GITHUB_RUN_ATTEMPT
    && receipt.runner.image === process.env.ImageOS && receipt.runner.imageVersion === process.env.ImageVersion
    && typeof receipt.runner.openssl === 'string' && typeof receipt.runner.nss === 'string'
    && /^[\d.]+[a-z]?$/.test(receipt.runner.openssl) && /^[\w.+:~-]+$/.test(receipt.runner.nss));
  const tools = await toolHashes(); exactKeys(receipt.runner.hashes, Object.keys(tools));
  check(Object.entries(tools).every(([key, value]) => receipt.runner.hashes[key] === value));
  exactKeys(receipt.browser, ['playwright', 'version', 'revision', 'executableHash']);
  check(receipt.browser.playwright === '1.58.2' && receipt.browser.version === VERSION && receipt.browser.revision === '1208');
  const { chromium } = await import('playwright');
  check(receipt.browser.executableHash === await fileHash(chromium.executablePath()));
  exactKeys(receipt.certificates, ['trusted', 'untrusted', 'wrong-san']);
  check(Object.values(receipt.certificates).every(value => /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value)));
  check(new Set(Object.values(receipt.certificates)).size === 3);
  check(Array.isArray(receipt.observations) && receipt.observations.length === 8);
  const phases = ['tls-untrusted', 'tls-wrong-san', 'direct-https', 'direct-https', 'http-ready-adapter', 'http-browser', 'cli', 'cli'];
  receipt.observations.forEach((item, index) => {
    const tls = index === 3 || index === 7, browserHTTP = index === 5;
    exactKeys(item, ['phase', 'port', 'transport', ...(tls ? ['fingerprint', 'protocol'] : []), ...(browserHTTP ? ['sessionCookieSent'] : [])]);
    check(item.phase === phases[index] && item.port === (index < 4 ? 18787 : index < 6 ? 18788 : 18789)
      && item.transport === (index === 4 || index === 5 ? 'http' : 'https'));
    if (tls) check(item.fingerprint === receipt.certificates.trusted && ['TLSv1.2', 'TLSv1.3'].includes(item.protocol));
    if (browserHTTP) check(typeof item.sessionCookieSent === 'boolean');
  });
  check(receipt.evidenceDigest === digest(JSON.stringify({ controls: receipt.controls, observations: receipt.observations })));
}
async function entry() {
  const receiptPath = process.env.BROWSER_TLS_RECEIPT;
  check(receiptPath === join(process.env.RUNNER_TEMP ?? '', 'browser-tls-receipt.json'));
  receiptTarget = receiptPath;
  const aborted = new Promise((_, reject) => {
    abortRun = error => {
      cancellation ??= error;
      stopping = true;
      process.exitCode = 1;
      // Synchronous invalidation also covers a signal after the final commit.
      invalidateReceipt();
      reject(cancellation);
    };
  });
  // A signal can precede the race or follow its settlement; neither may leak a rejection.
  void aborted.catch(() => {});
  const signal = () => abortRun(new Error('signal'));
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  deadline = Date.now() + 480000;
  globalTimer = setTimeout(() => abortRun(new Error('deadline')), 480000);
  const active = () => {
    if (Date.now() >= deadline) abortRun(new Error('deadline'));
    if (cancellation) throw cancellation;
  };
  if (process.argv[2] === '--validate-receipt' && process.argv.length === 3) {
    const stat = await lstat(receiptPath); check(stat.isFile() && !stat.isSymbolicLink() && stat.size < 32768);
    await Promise.race([validate(JSON.parse(await readFile(receiptPath, 'utf8'))), aborted]);
    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
    active();
    writeSync(1, 'browser-tls receipt: pass\n'); clearTimeout(globalTimer); return;
  }
  check(process.argv.length === 2);
  await rm(receiptPath, { force: true });
  active();
  let receipt, failure;
  const work = main().finally(() => { workSettled = true; });
  try { receipt = await Promise.race([work, aborted]); }
  catch {
    failure = true; stopping = true;
    // Let an already-started bounded launch/request settle before deleting its HOME.
    try { await bounded(work.catch(() => {}), 30000); } catch {}
  }
  finally {
    try { await cleanup(); } catch { failure = true; }
  }
  active();
  if (failure) throw new Error('acceptance_failed');
  receipt.controls = Object.fromEntries(outcomes); receipt.finished = new Date().toISOString(); receipt.assertions = assertions;
  receipt.evidenceDigest = digest(JSON.stringify({ controls: receipt.controls, observations: receipt.observations }));
  await Promise.race([validate(receipt), aborted]);
  // A synchronous write cannot finish after a cancellation has removed its receipt.
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  active();
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await new Promise(resolveImmediate => setImmediate(resolveImmediate));
  active();
  writeSync(1, 'browser-tls acceptance: pass\n');
  clearTimeout(globalTimer);
}
await entry().catch(() => {
  clearTimeout(globalTimer);
  invalidateReceipt();
  process.stderr.write(`browser-tls acceptance: fail (${/^[a-z-]+$/.test(current) ? current : 'control'})\n`);
  process.exitCode = 1;
});
