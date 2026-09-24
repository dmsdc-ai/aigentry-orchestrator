import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unavailableAuth } from './auth-port.js';
import { createAuth, provisionOwner } from './auth.js';
import { startServer, type ServerConfig } from './server.js';
import { readConsoleConfig } from './console-read-model.js';

async function tlsFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('invalid_tls_path');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid_tls_file');
  return readFile(path);
}
export async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command !== 'serve' && command !== 'provision-owner') throw new Error('invalid_command');
  const allowed = command === 'serve'
    ? ['--hitl-root', '--port', '--tls-key', '--tls-cert', '--auth-root', '--console-config']
    : ['--auth-root', '--invitation-path'];
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!flag || !allowed.includes(flag) || !value || value.startsWith('--') || flags.has(flag)) throw new Error('invalid_flags');
    flags.set(flag, value);
  }
  const authRoot = flags.get('--auth-root');
  if (authRoot !== undefined && !isAbsolute(authRoot)) throw new Error('invalid_auth_path');
  if (command === 'provision-owner') {
    const invitationPath = flags.get('--invitation-path');
    if (!authRoot || !invitationPath || !isAbsolute(invitationPath)) throw new Error('invalid_config');
    const result = await provisionOwner({ authRoot, invitationPath });
    if (result.state !== 'created') throw new Error('provision_unavailable');
    process.stdout.write(`${result.path}\n`);
    return;
  }
  const root = flags.get('--hitl-root');
  const port = flags.get('--port') ?? '8787';
  if (!root || !isAbsolute(root) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('invalid_config');
  const key = flags.get('--tls-key'), cert = flags.get('--tls-cert');
  if (!!key !== !!cert) throw new Error('invalid_tls_config');
  if ((key && !isAbsolute(key)) || (cert && !isAbsolute(cert))) throw new Error('invalid_tls_path');
  const config: ServerConfig = { host: '127.0.0.1', port: Number(port), hitlRoot: root, auth: unavailableAuth() };
  const consolePath = flags.get('--console-config');
  if (consolePath) {
    if (!key || !cert || !authRoot) throw new Error('console_requires_tls_and_auth');
    config.console = await readConsoleConfig(consolePath);
  }
  if (key && cert) config.tls = { key: await tlsFile(key), cert: await tlsFile(cert) };
  if (authRoot) {
    config.auth = await createAuth(Object.freeze({
      origin: new URL(`https://localhost:${config.port}`).origin,
      rpId: 'localhost',
      stateDir: authRoot,
      tlsReady: !!key && !!cert,
    }), Date.now);
  }
  const service = await startServer(config).catch(async error => {
    await config.auth.close().catch(() => undefined);
    throw error;
  });
  // Only a configured Console names itself; legacy serve keeps its original startup line.
  const surface = config.console ? 'Task Console / approval inbox' : 'Approval inbox';
  process.stdout.write(`${surface}: ${service.origin} (authentication ${config.auth.status().state}; login required for private reads; decisions disabled)\n`);
  const shutdown = (): void => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    void service.close().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  service.server.on('error', () => { process.exitCode = 1; shutdown(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Inbox unavailable: invalid command/configuration, provisioning or listener failure. Use serve --hitl-root <absolute-path> [--port <1-65535>] [--auth-root <absolute-path>] [--tls-key <absolute-path> --tls-cert <absolute-path>] [--console-config <absolute-path>], or provision-owner --auth-root <absolute-path> --invitation-path <absolute-path>. Console requires TLS and auth.\n');
    process.exitCode = 1;
  });
}
