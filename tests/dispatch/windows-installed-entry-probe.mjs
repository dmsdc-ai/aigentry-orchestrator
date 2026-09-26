// Diagnostic only; unchanged product run, nine inert calls, no Windows acceptance.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { errorMonitor } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifact = path.resolve(process.env.PROBE_RECEIPT || 'windows-installed-entry-receipt.json');
const parent = process.env.PROBE_RUNNER_TEMP || os.tmpdir();
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
const commit = process.env.PROBE_COMMIT || 'unknown';
const originalSpawn = cp.spawn;
const handles = new Set();
const children = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = name => hash(fs.readFileSync(name));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const codeOf = error => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'UNKNOWN_ERROR';
let root;
let active;
const receipt = {
  schema: 1, operation: 'bp1167e-v1', status: 'diagnostic_incomplete', productAcceptance: false,
  identity: { commit, runtime: process.version, platform: process.platform, arch: process.arch, hashes: {} },
  baseline: {
    receiptSHA256: '82cd9c7100723bbf4ef5eed461a6fdd4ba8042e9aefdf5b9f8ee3a408cea74d4',
    attempts: 296, crossSpawnArgvCorruptions: 16,
    localAbsoluteEcho: 'exit0; argv truncated at line1; suffix lost',
    prefixAbsoluteEcho: 'exit255; argv truncated after parentheses',
    originalObservation: 'diagnostic_incomplete; preserved, not reclassified',
  },
  boundaries: {
    realInstalledCLIEquivalence: 'UNKNOWN', security: 'UNMEASURED',
    lifetimeOwnership: 'UNKNOWN; no supervisor; expiry, kill and signal0 do not prove tree termination',
    sourceDistEquivalence: 'hashes recorded; CI build provenance, not independent binary equivalence proof',
    timing: 'passive instrumentation changes timing',
    scope: 'six echo transports and three direct-installed-bin negatives; inert npm only',
    observer: 'frozen spawn wrapper needed only because product run does not expose its handle; no stdin error suppression',
  },
  setup: [], installations: [], cases: [],
};
function save() {
  const bytes = JSON.stringify(receipt, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('RECEIPT_LIMIT');
  fs.writeFileSync(artifact, bytes);
}
function restore() {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
  receipt.observerRestored = cp.spawn === originalSpawn;
}
function event(record, name, detail = {}) {
  try {
    if (record.events.length < 64) record.events.push({ name, at_ms: elapsed(), ...detail });
    else record.eventsTruncated = true;
  } catch { record.observerIncomplete = true; }
}
function observe(child, record) {
  try {
    handles.add(child);
    children.set(record.slot, child);
    record.returnedWrapper = { pid: child.pid ?? null };
    event(record, 'returned', { pid: child.pid ?? null });
    child.on('spawn', () => event(record, 'spawn', { pid: child.pid ?? null }));
    // errorMonitor sees the original error before product mutates its code.
    child.on(errorMonitor, error => event(record, 'error', {
      code: codeOf(error), errno: typeof error.errno === 'number' ? error.errno : null,
      syscall: typeof error.syscall === 'string' ? error.syscall.split(' ')[0].slice(0, 32) : null,
    }));
    child.on('exit', (code, signal) => event(record, 'exit', { code, signal }));
    child.on('close', (code, signal) => {
      event(record, 'close', { code, signal });
      handles.delete(child);
    });
    for (const name of ['stdin', 'stdout', 'stderr']) {
      child[name]?.on('close', () => event(record, name + '_close'));
      child[name]?.on(errorMonitor, error => event(record, name + '_error', { code: codeOf(error) }));
    }
    record.rawStreams = {};
    for (const name of ['stdout', 'stderr']) {
      const chunks = [];
      let retained = 0;
      let total = 0;
      const digest = crypto.createHash('sha256');
      child[name]?.on('data', data => {
        digest.update(data);
        total += data.length;
        const part = data.subarray(0, Math.max(0, 8192 - retained));
        if (part.length) { chunks.push(part); retained += part.length; }
        if (retained < total) record.streamsTruncated = true;
      });
      child[name]?.on('close', () => {
        record.rawStreams[name] = {
          base64: Buffer.concat(chunks).toString('base64'), bytes: total,
          sha256: digest.digest('hex'), truncated: total > retained,
        };
      });
    }
  } catch { record.observerIncomplete = true; }
  return child;
}
function observedSpawn(...args) {
  const record = active;
  if (record) {
    try {
      record.rawInvocation = { argv: [args[0], ...args[1]], targetHash: fileHash(args[0]), at_ms: elapsed() };
      save();
    } catch { record.observerIncomplete = true; }
  }
  let child;
  try { child = Reflect.apply(originalSpawn, this, args); }
  catch (error) {
    if (record) event(record, 'throw', { code: codeOf(error), errno: typeof error.errno === 'number' ? error.errno : null });
    throw error;
  }
  if (record) observe(child, record);
  return child;
}
function forceOwned(reason) {
  receipt.cleanup = { reason, privateRootRemoved: false, treeTermination: 'UNKNOWN', forcedHandles: [] };
  for (const child of handles) {
    let requested = false;
    try { requested = child.kill('SIGKILL'); } catch { /* Unknown is retained. */ }
    receipt.cleanup.forcedHandles.push({ pid: child.pid ?? null, requested });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
  }
  receipt.cleanup.remainingReturnedHandles = handles.size;
}
// Setup uses async owned handles so the overall deadline is never blocked by spawnSync.
const watchdog = setTimeout(() => {
  receipt.status = 'diagnostic_incomplete';
  receipt.reason = 'OVERALL_DEADLINE';
  restore();
  forceOwned('deadline; closure incomplete');
  receipt.elapsed_ms = elapsed();
  try { save(); } finally { process.exit(2); }
}, 55000);
process.on('uncaughtExceptionMonitor', error => {
  try {
    receipt.status = 'diagnostic_incomplete';
    receipt.reason = 'FATAL_EXCEPTION';
    receipt.fatalCode = codeOf(error);
    restore();
    forceOwned('fatal; closure incomplete');
    save();
  } catch { /* No interception of fatal error semantics. */ }
});

const fixture = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const nonce = process.env.PROBE_NONCE;
const dir = process.env.PROBE_CASE_DIR;
if (!nonce || !dir) process.exit(98);
const descendant = process.argv[2] === '__descendant';
const role = descendant ? 'descendant' : 'payload';
function note(kind, extra = {}) {
  fs.writeFileSync(path.join(dir, role + '-' + kind + '.json'), JSON.stringify({ nonce, pid: process.pid, ppid: process.ppid, role, ...extra }));
}
note('start');
process.on('exit', code => note('exit', { code }));
// Hard self-expiry bounds payloads even after wrappers or the observer fail.
setTimeout(() => process.exit(0), descendant ? 2400 : 2200);
if (descendant) {
  process.stdout.write('descendant-start\n');
} else if (process.env.PROBE_MODE === 'timeout') {
  const child = cp.spawn(process.execPath, [__filename, '__descendant'], {
    shell: false, env: process.env, stdio: ['ignore', 'inherit', 'inherit']
  });
  child.on('error', error => note('descendant-error', { code: error.code }));
  child.on('close', (code, signal) => note('descendant-close', { childPid: child.pid, code, signal }));
} else {
  const args = process.argv.slice(2);
  if (args[0] === '--version') {
    if (process.env.PROBE_MODE === 'refuse-version') process.exit(17);
    process.stdout.write(process.env.PROBE_MODE === 'bad-version' ? 'fixture unsupported\n' : 'inert-boot-probe 7.8.9\n');
    process.exit(0);
  }
  if (args[0] === '--help') {
    if (process.env.PROBE_MODE === 'refuse-help') process.exit(18);
    process.stdout.write(process.env.PROBE_MODE === 'bad-help' ? 'usage: inert\n' : 'usage: inert --model --prompt --cwd --non-interactive\n');
    process.exit(0);
  }
  if (args[0] === '--forbidden') {
    fs.writeFileSync(path.join(dir, 'forbidden'), nonce);
    process.exit(99);
  }
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    process.stdout.write(JSON.stringify({ argv: args, stdin: input.toString('base64') }) + '\n');
    process.stderr.write('inert-stderr\n');
    process.exit(args[0] === '--nonzero' ? 23 : 0);
  });
}
`;

function environment(caseDir, nonce, mode) {
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'config'), LOCALAPPDATA: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_globalconfig: path.join(root, 'global-npmrc'),
    PROBE_CASE_DIR: caseDir, PROBE_NONCE: nonce, PROBE_MODE: mode,
    PROBE_EXPANSION: 'expanded-value-must-not-replace-literal',
  };
}
function replaceEnv(env) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}
function hashTree(directory, label) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) hashTree(full, label + '/' + entry.name);
    else if (entry.isFile()) receipt.identity.hashes[label + '/' + entry.name] = fileHash(full);
  }
}
function boundedRead(name, limit = 4096) {
  if (fs.statSync(name).size > limit) throw new Error('FILE_LIMIT');
  return fs.readFileSync(name, 'utf8');
}
async function install(npmCli, args, cwd, env, label) {
  if (elapsed() > 30000) throw new Error('SETUP_BUDGET');
  const argv = [process.execPath, npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'];
  const record = { label, argv, begin_ms: elapsed(), events: [] };
  receipt.setup.push(record);
  save();
  await new Promise((resolve, reject) => {
    const child = Reflect.apply(originalSpawn, cp, [argv[0], argv.slice(1), { cwd, env, shell: false }]);
    handles.add(child);
    let bytes = 0;
    const digests = { stdout: crypto.createHash('sha256'), stderr: crypto.createHash('sha256') };
    const timer = setTimeout(() => {
      record.timeout = true;
      child.kill('SIGKILL');
      reject(new Error('SETUP_TIMEOUT'));
    }, Math.min(12000, 35000 - elapsed()));
    child.stdin.end();
    child.stdin.on('error', error => { record.stdinError = codeOf(error); });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
      bytes += data.length;
      if (bytes <= 65536) digests[stream].update(data);
      else record.streamsTruncated = true;
    });
    child.on('error', error => { record.error = codeOf(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      handles.delete(child);
      record.end_ms = elapsed();
      record.code = code;
      record.signal = signal;
      record.pipesClosed = child.stdout.closed && child.stderr.closed && child.stdin.closed;
      for (const stream of ['stdout', 'stderr']) record[stream + 'Hash'] = digests[stream].digest('hex');
      if (code === 0 && !record.streamsTruncated && record.pipesClosed) resolve();
      else reject(new Error('OFFLINE_NPM_SETUP_FAILED'));
    });
  });
}
// Strict known npm cmd-shim shape only, never translate arbitrary batch code.
// Newlines are canonicalized for comparison; original bytes are separately hashed.
function expectedShim(relative) {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (',
    '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\' + relative + '" %*', '',
  ].join('\n');
}
function verifyInstalled(label, packageRoot, binDir, binName, fixtureHash) {
  const manifestPath = path.join(packageRoot, 'package.json');
  const manifest = JSON.parse(boundedRead(manifestPath));
  if (manifest.name !== binName || manifest.version !== '1.0.0' ||
      !manifest.bin || typeof manifest.bin !== 'object' ||
      Object.keys(manifest.bin).length !== 1 || manifest.bin[binName] !== 'probe') {
    throw new Error('INSTALLED_MANIFEST_REFUSAL');
  }
  // These disposable installs must be actual independent installed files, not links to the source.
  const canonicalRoot = fs.realpathSync(packageRoot);
  if (canonicalRoot.toLowerCase() !== path.resolve(packageRoot).toLowerCase()) throw new Error('INSTALLED_LINK_REFUSAL');
  const entry = fs.realpathSync(path.join(canonicalRoot, manifest.bin[binName]));
  if (path.dirname(entry).toLowerCase() !== canonicalRoot.toLowerCase() ||
      fileHash(entry) !== fixtureHash) throw new Error('INSTALLED_ENTRY_REFUSAL');
  const shim = path.join(binDir, binName + '.cmd');
  if (fs.realpathSync(shim).toLowerCase() !== shim.toLowerCase()) throw new Error('SHIM_LINK_REFUSAL');
  const relative = path.relative(binDir, entry);
  const shimBytes = boundedRead(shim, 8192);
  if (shimBytes.replace(/\r\n/g, '\n') !== expectedShim(relative)) throw new Error('SHIM_SHAPE_REFUSAL');
  // Strict template contains only the plain node shebang, no flags/env/interpreter rewrite.
  if (!boundedRead(entry).startsWith('#!/usr/bin/env node\n')) throw new Error('SHEBANG_REFUSAL');
  if (fs.existsSync(path.join(binDir, 'node.exe'))) throw new Error('ADJACENT_INTERPRETER_REFUSAL');
  // PATH is fixed with this runtime first. Refuse all earlier CWD candidates too.
  const runtime = fs.realpathSync(process.execPath);
  const result = {
    label, packageRoot: canonicalRoot, manifestPath, shim, entry, interpreter: runtime,
    relativeEntry: relative, declaredBin: manifest.bin, packageName: manifest.name, version: manifest.version,
    hashes: { manifest: fileHash(manifestPath), entry: fileHash(entry), shim: fileHash(shim), interpreter: fileHash(runtime) },
    equivalence: 'exact inert bytes and strict npm shim; no real CLI equivalence',
  };
  for (const suffix of ['', '.ps1']) result.hashes['shim' + suffix] = fileHash(path.join(binDir, binName + suffix));
  receipt.installations.push(result);
  return result;
}
function state(dir, nonce) {
  const result = { sampled_ms: elapsed() };
  for (const role of ['payload', 'descendant']) {
    const item = {};
    for (const kind of ['start', 'exit']) {
      try {
        const value = JSON.parse(boundedRead(path.join(dir, role + '-' + kind + '.json')));
        item[kind] = value.nonce === nonce && value.role === role && Number.isSafeInteger(value.pid) &&
          value.pid > 0 && Number.isSafeInteger(value.ppid) && value.ppid > 0 ?
          { nonce, role, pid: value.pid, ppid: value.ppid, ...(kind === 'exit' ? { code: value.code } : {}) } : 'invalid';
      } catch { item[kind] = 'unobserved'; }
    }
    item.signal0 = 'unknown';
    if (typeof item.start === 'object') {
      try { process.kill(item.start.pid, 0); item.signal0 = 'alive_sample'; }
      catch (error) { item.signal0 = error.code === 'ESRCH' ? 'absent_sample' : 'unknown'; }
    }
    result[role] = item;
  }
  return result;
}
function runOwned(spawn, command, input, timeout, record) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command.argv[0], command.argv.slice(1), {
        cwd: command.cwd, env: command.env, shell: false,
      });
    } catch (error) {
      event(record, 'throw', { code: codeOf(error) });
      reject(error);
      return;
    }
    const buffers = { stdout: [], stderr: [] };
    const totals = { stdout: 0, stderr: 0 };
    const timer = setTimeout(() => {
      record.atTimeout = state(command.cwd, record.nonce);
      record.pipesClosedAtTimeout = child.stdout.closed && child.stderr.closed;
      record.killRequested = child.kill('SIGKILL');
      reject(Object.assign(new Error('TIMEOUT'), { code: 'ETIMEDOUT' }));
    }, timeout);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', data => {
      const remaining = Math.max(0, 65536 - totals[stream]);
      if (data.length > remaining) record.streamsTruncated = true;
      if (remaining) buffers[stream].push(data.subarray(0, remaining));
      totals[stream] += data.length;
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      record.rawClose = { code, signal };
      const result = {
        stdout: Buffer.concat(buffers.stdout).toString('utf8'),
        stderr: Buffer.concat(buffers.stderr).toString('utf8'), exit_code: code ?? -1,
      };
      record.capturedStreams = result;
      resolve(result);
    });
    // Same supplied input/write/end as product, without swallowing EPIPE.
    child.stdin.write(input);
    child.stdin.end();
  });
}
function assess(record) {
  const reasons = [];
  const has = name => record.events.some(e => e.name === name);
  const child = children.get(record.slot);
  record.pipesClosed = child ? ['stdin', 'stdout', 'stderr'].every(name => !child[name] || child[name].closed) : null;
  const threw = has('throw') && !has('returned') && !child && !record.returnedWrapper;
  const preSpawnError = !has('spawn') && has('error') && has('close') && !record.returnedWrapper?.pid;
  const refusal = threw || preSpawnError;
  record.launch = refusal ? 'observed_launch_refusal' : 'returned_process';
  if (record.eventsTruncated || record.streamsTruncated || record.observerIncomplete) reasons.push('observation_loss');
  if (record.end_ms === undefined) reasons.push('unsettled');
  if (!threw && (!has('close') || !record.pipesClosed)) reasons.push('returned_handle_or_pipes_incomplete');
  // observe() publishes raw records only on stream close; closed handles alone are insufficient.
  if (!threw) for (const name of ['stdout', 'stderr']) {
    const raw = record.rawStreams?.[name];
    if (!record.rawStreams || typeof record.rawStreams !== 'object' || Array.isArray(record.rawStreams) ||
        !raw || typeof raw !== 'object' || Array.isArray(raw) ||
        !Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || raw.bytes > 8192 ||
        raw.truncated !== false || typeof raw.base64 !== 'string' || raw.base64.length > 10924 ||
        typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
      reasons.push('raw_' + name + '_incomplete');
      continue;
    }
    const bytes = Buffer.from(raw.base64, 'base64');
    if (bytes.length !== raw.bytes || bytes.toString('base64') !== raw.base64 || hash(bytes) !== raw.sha256) {
      reasons.push('raw_' + name + '_invalid');
    }
  }
  // A missing Node script starts the interpreter, but no fixture payload is expected.
  if (!refusal && !has('exit') && !has('error')) reasons.push('raw_outcome_unknown');
  const expectedRoles = record.mode === 'missing' || refusal ? [] :
    record.mode === 'timeout' ? ['payload', 'descendant'] : ['payload'];
  for (const role of expectedRoles) {
    const item = record.after[role];
    if (typeof item.start !== 'object') { reasons.push(role + '_start_unknown'); continue; }
    if (role === 'payload' && item.start.ppid !==
        (item.start.pid === record.returnedWrapper?.pid ? process.pid : record.returnedWrapper?.pid)) reasons.push('payload_parent_mismatch');
    if (role === 'descendant' && item.start.ppid !== record.after.payload.start?.pid) reasons.push('descendant_parent_mismatch');
    const directExit = role === 'payload' && item.start.pid === record.returnedWrapper?.pid && has('exit');
    const matchingExit = typeof item.exit === 'object' && item.exit.pid === item.start.pid &&
      item.exit.ppid === item.start.ppid;
    if (!matchingExit && !directExit) reasons.push(role + '_exit_unknown');
    if (item.signal0 !== 'absent_sample') reasons.push(role + '_liveness_uncertain');
  }
  for (const role of ['payload', 'descendant'].filter(role => !expectedRoles.includes(role))) {
    if (record.after[role].start !== 'unobserved' || record.after[role].exit !== 'unobserved') reasons.push(role + '_unexpected_evidence');
  }
  record.observation = { complete: reasons.length === 0, reasons, ownership: 'UNKNOWN' };
}
try {
  save();
  if (process.platform !== 'win32') throw new Error('NON_WINDOWS_REFUSAL');
  if (process.version !== 'v20.20.2' || process.arch !== 'x64') throw new Error('NATIVE_RUNTIME_REFUSAL');
  if (!systemRoot || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error('IDENTITY_REFUSAL');
  root = fs.mkdtempSync(path.join(parent, 'installed probe (owned)-'));
  for (const dir of ['home', 'config', 'cache', 'temp', 'package', 'local', 'prefix', 'cases']) fs.mkdirSync(path.join(root, dir));
  for (const file of ['npmrc', 'global-npmrc']) fs.writeFileSync(path.join(root, file), '');
  const binName = 'inert-probe-' + crypto.randomBytes(16).toString('hex');
  const fixturePath = path.join(root, 'package', 'probe');
  fs.writeFileSync(fixturePath, fixture);
  fs.writeFileSync(path.join(root, 'package', 'package.json'), JSON.stringify({
    name: binName, version: '1.0.0', bin: { [binName]: 'probe' },
  }));
  fs.writeFileSync(path.join(root, 'local', 'package.json'), '{"private":true}');
  // ECMAScript template literals normalize source CRLF to LF on native checkouts.
  const original = fs.readFileSync(path.join(repo, 'tests/dispatch/windows-boot-spawn-probe.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const marker = 'const fixture = String.raw' + String.fromCharCode(96);
  const frozenFixture = original.split(marker)[1]?.split(String.fromCharCode(96) + ';')[0];
  if (frozenFixture !== fixture) throw new Error('FIXTURE_BYTES_REFUSAL');
  receipt.identity.hashes.fixture = hash(fixture);
  receipt.identity.hashes.fixtureManifest = fileHash(path.join(root, 'package', 'package.json'));
  for (const name of [
    'src/session/boot-adapter/spawner.ts', 'src/session/boot-adapter/types.ts', 'src/session/boot-adapter/common.ts',
    'dist/src/session/boot-adapter/spawner.js', 'package.json', 'package-lock.json',
    'tests/dispatch/windows-boot-spawn-probe.mjs', 'tests/dispatch/windows-installed-entry-probe.mjs',
    '.github/workflows/windows-boot-spawn-probe.yml', '.github/workflows/windows-installed-entry-probe.yml',
  ]) receipt.identity.hashes[name] = fileHash(path.join(repo, name));
  receipt.identity.hashes.runtime = fileHash(process.execPath);
  receipt.identity.hashes.commandInterpreter = fileHash(path.join(systemRoot, 'System32', 'cmd.exe'));
  const npmRoot = path.join(path.dirname(process.execPath), 'node_modules', 'npm');
  const npmCli = path.join(npmRoot, 'bin', 'npm-cli.js');
  receipt.identity.hashes.npmCli = fileHash(npmCli);
  receipt.identity.hashes.npmPackage = fileHash(path.join(npmRoot, 'package.json'));
  receipt.identity.npmVersion = JSON.parse(boundedRead(path.join(npmRoot, 'package.json'), 16384)).version;
  hashTree(path.join(npmRoot, 'node_modules', 'cmd-shim'), 'npm/cmd-shim');
  const crossEntry = require.resolve('cross-spawn');
  const crossRequire = createRequire(crossEntry);
  const crossPackage = JSON.parse(boundedRead(path.join(path.dirname(crossEntry), 'package.json')));
  if (crossPackage.version !== '7.0.6') throw new Error('CROSS_SPAWN_REFUSAL');
  receipt.identity.crossSpawnVersion = crossPackage.version;
  hashTree(path.dirname(crossEntry), 'cross-spawn');
  for (const dependency of ['path-key', 'shebang-command', 'which']) {
    const manifest = crossRequire.resolve(dependency + '/package.json');
    hashTree(path.dirname(manifest), dependency);
    const depRequire = createRequire(manifest);
    if (dependency === 'shebang-command') hashTree(path.dirname(depRequire.resolve('shebang-regex/package.json')), 'shebang-regex');
    if (dependency === 'which') hashTree(path.dirname(depRequire.resolve('isexe/package.json')), 'isexe');
  }
  const env = environment(path.join(root, 'cases'), crypto.randomBytes(16).toString('hex'), 'normal');
  replaceEnv(env);
  await install(npmCli, ['install', '--install-links', '--package-lock=false', path.join(root, 'package')], path.join(root, 'local'), env, 'local');
  // Request copied contents for prefix too; a link back to the source is explicitly refused.
  await install(npmCli, ['install', '--global', '--install-links', '--prefix', path.join(root, 'prefix'), path.join(root, 'package')], root, env, 'isolated-prefix');
  const local = verifyInstalled('local', path.join(root, 'local', 'node_modules', binName),
    path.join(root, 'local', 'node_modules', '.bin'), binName, hash(fixture));
  const prefix = verifyInstalled('prefix', path.join(root, 'prefix', 'node_modules', binName),
    path.join(root, 'prefix'), binName, hash(fixture));
  // Load public cross-spawn before the temporary product-only observer.
  const crossSpawn = require('cross-spawn');
  cp.spawn = observedSpawn;
  syncBuiltinESMExports();
  const { nodeSpawner } = await import(pathToFileURL(path.join(repo, 'dist/src/session/boot-adapter/spawner.js')).href);
  const current = nodeSpawner();
  const plans = [local, prefix].flatMap(target =>
    ['current', 'cross-spawn', 'direct'].map(engine => ({ target, engine, mode: 'echo' })));
  plans.push(...['nonzero', 'missing', 'timeout'].map(mode => ({ target: local, engine: 'direct', mode })));
  const input = 'stdin empty-line follows\n\n한글 😀\r\n" & | % !\n';
  for (const plan of plans) {
    if (elapsed() > 45000) throw new Error('CALL_BUDGET');
    const { target, engine, mode } = plan;
    const slot = String(receipt.cases.length);
    const nonce = crypto.randomBytes(16).toString('hex');
    const dir = path.join(root, 'cases', slot);
    fs.mkdirSync(dir);
    const literals = ['', 'two words', '한글 😀', 'a"b', 'tail\\', '(parentheses)', '&', '|', '<', '>', '^', '%', '!', ';', 'line1\nline2',
      '%PROBE_EXPANSION%', '!PROBE_EXPANSION!', '& echo owned>injection-sentinel', '| echo owned>injection-sentinel',
      '\n echo owned>injection-sentinel', 'x" & echo owned>injection-sentinel & rem "'];
    // Independent literal oracle: never derive expected argv from the executed command.
    const expected = ['', 'two words', '한글 😀', 'a"b', 'tail\\', '(parentheses)', '&', '|', '<', '>', '^', '%', '!', ';', 'line1\nline2',
      '%PROBE_EXPANSION%', '!PROBE_EXPANSION!', '& echo owned>injection-sentinel', '| echo owned>injection-sentinel',
      '\n echo owned>injection-sentinel', 'x" & echo owned>injection-sentinel & rem "'];
    const args = mode === 'nonzero' ? ['--nonzero', ...literals] : mode === 'echo' ? literals : [];
    const expectedArgs = mode === 'nonzero' ? ['--nonzero', ...expected] : mode === 'echo' ? expected : [];
    const entry = mode === 'missing' ? path.join(path.dirname(target.entry), 'missing-' + nonce) : target.entry;
    if (mode === 'missing' && fs.existsSync(entry)) throw new Error('MISSING_TARGET_CONFLICT');
    const argv = engine === 'direct' ? [target.interpreter, entry, ...args] : [target.shim, ...args];
    const callEnv = environment(dir, nonce, mode);
    replaceEnv(callEnv);
    for (const name of ['node', 'node.com', 'node.exe', 'node.bat', 'node.cmd']) {
      if (fs.existsSync(path.join(dir, name))) throw new Error('CWD_INTERPRETER_REFUSAL');
    }
    const record = {
      id: target.label + '/' + engine + '/' + mode, slot, nonce, mode, engine, begin_ms: elapsed(),
      argv, cwd: dir, pathSpelling: 'PATH', pathValue: callEnv.PATH, events: [],
      eventsTruncated: false, streamsTruncated: false,
      expectedPayload: mode !== 'missing', expectedDescendant: mode === 'timeout',
      expected: { argv: expectedArgs, stdinBase64: Buffer.from('stdin empty-line follows\n\n한글 😀\r\n" & | % !\n').toString('base64'),
        exit: mode === 'nonzero' ? 23 : mode === 'missing' ? 1 : mode === 'timeout' ? null : 0 },
      identity: { ...target.hashes, executedTarget: fileHash(argv[0]), installedEntry: fileHash(target.entry),
        missingTargetAbsent: mode === 'missing' ? !fs.existsSync(entry) : null },
      lifetime: { selfExpiry_ms: { payload: 2200, descendant: 2400 }, ownership: 'UNKNOWN' },
    };
    receipt.cases.push(record);
    save(); // Exact argv and target hashes are on disk before each of the nine calls.
    const command = { argv, cwd: dir, env: callEnv };
    const timeout = mode === 'timeout' ? 600 : 1500;
    record.timeout_ms = timeout;
    try {
      active = record;
      const result = await (engine === 'current' ? current.run(command, input, timeout) :
        runOwned(engine === 'cross-spawn' ? crossSpawn : observedSpawn, command, input, timeout, record));
      record.result = result;
    } catch (error) {
      record.error = codeOf(error);
    } finally {
      active = undefined;
      record.end_ms = elapsed();
    }
    // Wait for finite expiry only where needed; it is never ownership evidence.
    await delay(mode === 'timeout' || record.error === 'ETIMEDOUT' ? 2800 : 80);
    record.after = state(dir, nonce);
    record.sentinels = { injection: fs.existsSync(path.join(dir, 'injection-sentinel')), forbidden: fs.existsSync(path.join(dir, 'forbidden')) };
    if (record.result) {
      const { stdout, stderr } = record.result;
      record.stdoutHash = hash(stdout);
      record.stderrHash = hash(stderr);
      if (Buffer.byteLength(stdout) > 8192 || Buffer.byteLength(stderr) > 8192) record.streamsTruncated = true;
      record.result.stdout = Buffer.from(stdout).subarray(0, 8192).toString('utf8');
      record.result.stderr = Buffer.from(stderr).subarray(0, 8192).toString('utf8');
      if (mode === 'echo' || mode === 'nonzero') {
        try {
          const echoed = JSON.parse(stdout);
          record.argvEqual = JSON.stringify(echoed.argv) === JSON.stringify(expectedArgs);
          record.stdinEqual = echoed.stdin === record.expected.stdinBase64;
        } catch { record.argvEqual = false; record.stdinEqual = false; }
      }
    }
    assess(record);
    record.expectedResult = mode === 'timeout' ? record.error === 'ETIMEDOUT' :
      record.result?.exit_code === record.expected.exit &&
      (mode === 'missing' || (record.argvEqual && record.stdinEqual));
    record.assessment = !record.observation.complete ? 'INCOMPLETE' :
      record.expectedResult && !record.sentinels.injection && !record.sentinels.forbidden ? 'EXPECTED_INERT_RESULT' : 'NEGATIVE';
    delete record.capturedStreams;
    save();
  }
  receipt.status = receipt.cases.length === 9 && receipt.cases.every(record => record.observation.complete) ?
    'diagnostic_completed' : 'diagnostic_incomplete';
} catch (error) {
  receipt.status = 'diagnostic_incomplete';
  receipt.reason = /^[A-Z_]{1,64}$/.test(error.message || '') ? error.message : codeOf(error);
} finally {
  restore();
  if (handles.size) {
    forceOwned('returned handles remained; observation incomplete');
    receipt.status = 'diagnostic_incomplete';
    await delay(Math.min(500, Math.max(0, 53000 - elapsed())));
  }
  receipt.cleanup ??= { privateRootRemoved: false, forcedHandles: [], treeTermination: 'UNKNOWN' };
  receipt.cleanup.remainingReturnedHandles = handles.size;
  receipt.cleanup.privateEvidence = 'retained; no inference from absent start files';
  receipt.elapsed_ms = elapsed();
  receipt.findings = {
    attempted: receipt.cases.length,
    negative: receipt.cases.filter(record => record.assessment === 'NEGATIVE').length,
    incomplete: receipt.cases.filter(record => !record.observation?.complete).length,
  };
  // Absolute private fixture paths are necessary for exact argv/provenance; no ambient env is exported.
  clearTimeout(watchdog);
  process.exitCode = receipt.status === 'diagnostic_completed' ? 0 : 2;
  save();
  if (handles.size) process.exit(2);
}
