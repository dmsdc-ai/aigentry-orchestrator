import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unavailableAuth } from './auth-port.js';
import { startServer, type ServerConfig } from './server.js';

async function tlsFile(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('invalid_tls_path');
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('invalid_tls_file');
  return readFile(path);
}
export async function main(args: readonly string[]): Promise<void> {
  if (args[0] !== 'serve') throw new Error('invalid_command');
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!flag || !['--hitl-root', '--port', '--tls-key', '--tls-cert'].includes(flag) || !value || flags.has(flag)) throw new Error('invalid_flags');
    flags.set(flag, value);
  }
  const root = flags.get('--hitl-root');
  const port = flags.get('--port') ?? '8787';
  if (!root || !isAbsolute(root) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('invalid_config');
  const key = flags.get('--tls-key'), cert = flags.get('--tls-cert');
  if (!!key !== !!cert) throw new Error('invalid_tls_config');
  const config: ServerConfig = { host: '127.0.0.1', port: Number(port), hitlRoot: root, auth: unavailableAuth() };
  if (key && cert) config.tls = { key: await tlsFile(key), cert: await tlsFile(cert) };
  const service = await startServer(config);
  process.stdout.write(`Approval inbox: ${service.origin} (authentication dependency_unverified)\n`);
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
    process.stderr.write('Inbox unavailable: invalid command/configuration or listener failure. Use serve --hitl-root <absolute-path> [--port <1-65535>] [--tls-key <absolute-path> --tls-cert <absolute-path>].\n');
    process.exitCode = 1;
  });
}
