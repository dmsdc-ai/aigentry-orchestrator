import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercise provisioning and refusal paths only; never start a listener.
const cliURL = new URL('../../src/hitl/web/cli.js', import.meta.url);
const cli = fileURLToPath(cliURL);
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
function run(cwd: string, args: string[], script?: string) {
  const result = spawnSync(process.execPath, script === undefined ? [cli, ...args] : ['--input-type=module', '-e', script],
    { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}
async function snapshot(dir: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name), info = await lstat(path);
    entries.push([name, info.mode & 0o777, info.isSymbolicLink() ? ['link', await readlink(path)]
      : info.isDirectory() ? await snapshot(path) : digest(await readFile(path))]);
  }
  return entries;
}
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cli-fixture-')));
  await chmod(dir, 0o700);
  return { dir, root: join(dir, 'auth'), invitation: join(dir, 'invitation') };
}
function provision(root: string, invitation: string): string[] {
  return ['provision-owner', '--auth-root', root, '--invitation-path', invitation];
}
async function refused(dir: string, args: string[]) {
  const before = await snapshot(dir);
  const result = run(dir, args);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.startsWith('Inbox unavailable:'));
  assert.ok(result.stderr.length < 1024);
  assert.deepEqual(await snapshot(dir), before);
}

test('CLI: explicit provision prints path only; private modes, 256-bit invitation and hash-only metadata', async () => {
  const f = await fixture();
  try {
    const before = Date.now();
    const result = run(f.dir, provision(f.root, f.invitation));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, f.invitation + '\n');
    assert.equal(result.stderr, '');
    assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(f.invitation)).mode & 0o777, 0o600);
    const secret = (await readFile(f.invitation, 'utf8')).trim();
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(secret));
    assert.equal(Buffer.from(secret, 'base64url').length, 32);
    const path = join(f.root, 'auth-metadata.json');
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const raw = await readFile(path, 'utf8');
    assert.equal(raw.includes(secret), false);
    const metadata = JSON.parse(raw);
    assert.deepEqual(Object.keys(metadata).sort(), ['credential', 'generation', 'invitation', 'version']);
    assert.equal(metadata.credential, null);
    assert.equal(metadata.generation, 0);
    assert.equal(metadata.version, 1);
    assert.deepEqual(Object.keys(metadata.invitation).sort(), ['createdAt', 'expiresAt', 'hash']);
    assert.equal(metadata.invitation.hash, digest(secret));
    assert.ok(metadata.invitation.createdAt >= before && metadata.invitation.createdAt <= Date.now());
    assert.equal(metadata.invitation.expiresAt - metadata.invitation.createdAt, 300_000);
    await refused(f.dir, provision(f.root, f.invitation));
    await refused(f.dir, provision(f.root, join(f.dir, 'second-invitation')));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

for (const condition of ['collision', 'corrupt', 'permissive-root', 'permissive-metadata', 'root-link', 'invitation-link', 'metadata-link']) {
  test('CLI: refuses and preserves bytes for ' + condition, async () => {
    const f = await fixture();
    try {
      await mkdir(f.root, { mode: 0o700 });
      const metadata = join(f.root, 'auth-metadata.json');
      if (condition === 'collision') await writeFile(f.invitation, 'existing-private-value', { mode: 0o600 });
      if (condition === 'corrupt') await writeFile(metadata, '{broken', { mode: 0o600 });
      if (condition === 'permissive-root') await chmod(f.root, 0o755);
      if (condition === 'permissive-metadata') {
        await writeFile(metadata, '{"version":1,"generation":0,"invitation":null,"credential":null}', { mode: 0o600 });
        await chmod(metadata, 0o644);
      }
      let root = f.root;
      if (condition === 'root-link') { root = join(f.dir, 'link'); await symlink(f.root, root); }
      if (condition === 'invitation-link' || condition === 'metadata-link') {
        const target = join(f.dir, 'target');
        await writeFile(target, 'preserve-target-bytes', { mode: 0o600 });
        await symlink(target, condition === 'invitation-link' ? f.invitation : metadata);
      }
      await refused(f.dir, provision(root, f.invitation));
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

const invalid: ReadonlyArray<readonly [string, (root: string, invitation: string) => string[]]> = [
  ['no command', () => []], ['unknown command', () => ['unknown']],
  ['provision missing roots', () => ['provision-owner']],
  ['provision relative root', (_r, i) => provision('relative', i)],
  ['provision relative invitation', r => provision(r, 'relative')],
  ['provision unknown flag', (r, i) => [...provision(r, i), '--unknown', 'value']],
  ['provision duplicate flag', (r, i) => [...provision(r, i), '--auth-root', r]],
  ['provision missing value', r => ['provision-owner', '--auth-root', r, '--invitation-path']],
  ['provision flag as value', r => ['provision-owner', '--auth-root', '--invitation-path', r]],
  ['provision cross-command flag', (r, i) => [...provision(r, i), '--port', '8787']],
  ['serve missing root', r => ['serve', '--auth-root', r]],
  ['serve relative root', r => ['serve', '--hitl-root', 'relative', '--auth-root', r]],
  ['serve relative auth root', r => ['serve', '--hitl-root', r, '--auth-root', 'relative']],
  ['serve unknown flag', r => ['serve', '--hitl-root', r, '--unknown', 'value']],
  ['serve duplicate flag', r => ['serve', '--hitl-root', r, '--hitl-root', r]],
  ['serve missing value', r => ['serve', '--hitl-root', r, '--port']],
  ['serve cross-command flag', (r, i) => ['serve', '--hitl-root', r, '--invitation-path', i]],
  ...['0', '65536', '-1', '1.5', 'NaN', '123456', ''].map(port =>
    [`serve invalid port ${JSON.stringify(port)}`, (r: string) => ['serve', '--hitl-root', r, '--auth-root', r, '--port', port]] as const),
  ['serve key without cert', r => ['serve', '--hitl-root', r, '--auth-root', r, '--tls-key', join(r, 'key')]],
  ['serve cert without key', r => ['serve', '--hitl-root', r, '--auth-root', r, '--tls-cert', join(r, 'cert')]],
  ['serve relative TLS paths', r => ['serve', '--hitl-root', r, '--auth-root', r, '--tls-key', 'key', '--tls-cert', 'cert']],
];
for (const [name, args] of invalid) {
  test('CLI: ' + name + ' refuses before filesystem side effects', async () => {
    const f = await fixture();
    try { await refused(f.dir, args(f.root, f.invitation)); }
    finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

for (const condition of ['missing', 'directory', 'symlink', 'oversized']) {
  test('CLI: invalid TLS file ' + condition + ' does not provision', async () => {
    const f = await fixture();
    try {
      const key = join(f.dir, 'key'), cert = join(f.dir, 'cert');
      await writeFile(cert, 'synthetic-invalid-certificate', { mode: 0o600 });
      if (condition === 'directory') await mkdir(key, { mode: 0o700 });
      if (condition === 'symlink') await symlink(cert, key);
      if (condition === 'oversized') await writeFile(key, Buffer.alloc(65537), { mode: 0o600 });
      await refused(f.dir, ['serve', '--hitl-root', f.dir, '--auth-root', f.root, '--tls-key', key, '--tls-cert', cert]);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
}

test('CLI: importing module with provision-shaped argv has no output or filesystem side effects and exits', async () => {
  const f = await fixture();
  try {
    const before = await snapshot(f.dir);
    const script = `process.argv = ['node', 'import-only', ...${JSON.stringify(provision(f.root, f.invitation))}]; await import(${JSON.stringify(cliURL.href)});`;
    const result = run(f.dir, [], script);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(await snapshot(f.dir), before);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
