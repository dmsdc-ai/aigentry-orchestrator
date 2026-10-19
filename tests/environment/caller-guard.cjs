// Fresh caller fixture: direct, preopened recorder; no convenience logger recursion.
const fs = require('node:fs'), cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const spec = JSON.parse(fs.readFileSync(process.env.S1_CALLER_SPEC, 'utf8'));
const fd = fs.openSync(spec.events, 'wx', 0o600), write = fs.writeSync.bind(fs), close = fs.closeSync.bind(fs);
let bytes = 0, count = 0;
const record = event => {
  const line = Buffer.from(JSON.stringify(event) + '\n');
  if (line.length > 65536 || ++count > 1000 || (bytes += line.length) > 1024 * 1024) process.exit(97);
  let at = 0;
  while (at < line.length) { const n = write(fd, line, at, line.length - at); if (n <= 0) process.exit(97); at += n; }
};
const forbidden = (kind, details = {}) => { record({ kind, ...details }); process.exit(97); };
if (spec.platform) Object.defineProperty(process, 'platform', { value: spec.platform });
record({ kind: 'fixture', simulatedPlatform: spec.platform ?? null, hostPlatform: spec.hostPlatform });
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'chmodSync', 'linkSync', 'symlinkSync']) {
  fs[name] = (...args) => forbidden('write', { operation: name, path: String(args[0]) });
}
for (const name of ['writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'link', 'symlink']) {
  fs[name] = (...args) => forbidden('write', { operation: name, path: String(args[0]) });
  fs.promises[name] = (...args) => forbidden('write', { operation: name, path: String(args[0]) });
}
const open = fs.openSync.bind(fs);
fs.openSync = (file, flags, ...rest) => {
  if (typeof flags === 'number' ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) : /[wa+]/.test(flags)) forbidden('write', { operation: 'openSync', path: String(file) });
  if (/\.credentials\.json$|\/auth\.json$|\/\.claude\.json$/.test(String(file))) forbidden('auth-read');
  return open(file, flags, ...rest);
};
const read = fs.readFileSync.bind(fs);
fs.readFileSync = (file, ...args) => {
  if (/\.credentials\.json$|\/auth\.json$|\/\.claude\.json$/.test(String(file))) forbidden('auth-read');
  return read(file, ...args);
};
cp.spawnSync = (cmd, args = [], options = {}) => {
  record({ kind: 'child', cmd, args, targetCwd: options.env?.AIGENTRY_TARGET_CWD });
  if (spec.mode === 'dispatch' && args.includes('--resolve')) process.exit(86); // measured boundary, never success
  if (spec.mode === 'dispatch' && args.includes('check-dedup')) return { status: 0, stdout: '', stderr: '' };
  if (spec.mode === 'dispatch' && args[0] === 'list') return { status: 0, stdout: '{}', stderr: '' };
  forbidden('unexpected-child');
};
for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => forbidden('unexpected-child');
process.kill = () => forbidden('signal');
for (const [module, names] of [['node:net', ['connect', 'createConnection', 'createServer']], ['node:http', ['request', 'get', 'createServer']], ['node:https', ['request', 'get', 'createServer']], ['node:tls', ['connect', 'createServer']], ['node:dns', ['lookup', 'resolve']]]) {
  for (const name of names) require(module)[name] = () => forbidden('network');
}
globalThis.fetch = () => forbidden('network');
process.on('exit', code => { record({ kind: 'exit', code }); close(fd); });
syncBuiltinESMExports();
