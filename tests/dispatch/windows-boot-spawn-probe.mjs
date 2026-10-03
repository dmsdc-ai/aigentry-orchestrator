// Instrumented observation only. Never changes production launch policy.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import * as childProcessExports from 'node:child_process';
import { errorMonitor } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const originalSpawn = cp.spawn;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifact = path.resolve(process.env.PROBE_RECEIPT || 'windows-boot-spawn-receipt.json');
const commit = process.env.PROBE_COMMIT || 'unknown';
const parent = process.env.PROBE_RUNNER_TEMP || os.tmpdir();
const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
const receipt = {
  schema: 1, operation: 'bc1167c-v2', status: 'incomplete', productAcceptance: false,
  identity: { commit, runtime: process.version, versions: process.versions, platform: process.platform, arch: process.arch, osRelease: os.release(), hashes: {} },
  observer: { restored: false, limit: 80, timing: 'instrumented; event listeners and file reads affect timing' },
  boundaries: {
    measured: 'unchanged compiled nodeSpawner versus public cross-spawn using inert fixtures only',
    unmeasured: ['real model execution', 'registry and sandbox acceptance', 'Windows package installation support', 'uninstrumented timing', 'full dispatch gates', 'common.ts version/help policy enforcement; receipt predicates only inspect fixture output'],
    cleanup: 'only returned owned ChildProcess handles may be killed; payloads self-expire; no tree-kill claim',
    pidCheck: 'signal 0 is a liveness sample, not a durable process identity; nonce reports bind fixture identity; PID reuse remains a limitation',
  },
  setup: [], cases: [],
  coverage: {
    planned: { run: 264, probeVersion: 32 },
    run: '2 engines x 2 PATH spellings x 6 targets x 11 modes',
    probeVersion: 'current only: 30 version variants plus one missing and one self-expiring timeout fixture attempt',
    timeoutPolicy: 'run has a per-call timer; collect/probeVersion has none; diagnostic global deadline and fixture expiry only',
    unknown: ['run deliberate closed-stdin/error', 'probeVersion deliberate closed-stdin/error',
      'classifier JSON/fallback/output-limit policy', 'common.ts enforcement', 'uninstrumented timing'],
  },
};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = name => hash(fs.readFileSync(name));
const errorCode = error => /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : error?.name || 'Error';
let root;
let active;
let sequence = 0;
const handles = new Set();
const started = performance.now();
const elapsed = () => Math.round(performance.now() - started);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function save() {
  const json = JSON.stringify(receipt, null, 2);
  if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('RECEIPT_LIMIT');
  fs.writeFileSync(artifact, json + '\n');
}
function restoreObserver() {
  cp.spawn = originalSpawn;
  syncBuiltinESMExports();
  receipt.observer.restored = cp.spawn === originalSpawn && childProcessExports.spawn === originalSpawn;
}
// Preserve a sanitized negative receipt without intercepting fatal exceptions.
process.on('uncaughtExceptionMonitor', error => {
  try {
    restoreObserver();
    receipt.cleanup = { complete: false, privateRootRemoved: false, reason: 'fatal_exception' };
    receipt.cleanup.forcedHandles = [];
    for (const child of handles) {
      try { receipt.cleanup.forcedHandles.push({ pid: child.pid ?? null, killed: child.kill('SIGKILL') }); }
      catch { receipt.cleanup.forcedHandles.push({ pid: child.pid ?? null, killed: false }); }
    }
    for (const record of receipt.cases) record.observation = { complete: false, reasons: ['fatal_exit_cleanup_unknown'] };
    receipt.status = 'fatal_exception'; receipt.error = errorCode(error); save();
  } catch { /* Best effort only; normal finally restoration cannot run on a fatal exception. */ }
});
function safeEvent(record, event, details = {}) {
  try {
    if (record.events.length < receipt.observer.limit) record.events.push({ event, at_ms: elapsed(), ...details });
    else record.truncated = true;
  } catch { /* Observers must never affect launch outcomes. */ }
}
function observedSpawn(...args) {
  // Exact receiver/arguments, exactly one call, identical return, same thrown error.
  const scope = active;
  let child;
  try { child = Reflect.apply(originalSpawn, this, args); }
  catch (error) {
    try { if (scope) safeEvent(scope, 'throw', { code: errorCode(error) }); } catch { /* Preserve the original error. */ }
    throw error;
  }
  if (scope) {
    try {
      if (process.env.PROBE_NONCE !== scope.nonce ||
        process.env.PROBE_CASE_DIR !== path.join(root, 'cases', scope.fixtureSlot)) {
        safeEvent(scope, 'observer_incomplete');
        return child;
      }
      scope.childIdentity = ++sequence;
      scope.pid = child.pid ?? null;
      handles.add(child);
      safeEvent(scope, 'returned', { pid: child.pid ?? null });
      child.on('spawn', () => safeEvent(scope, 'spawn', { pid: child.pid ?? null }));
      child.on(errorMonitor, error => safeEvent(scope, 'error', { code: errorCode(error) }));
      child.on('exit', (code, signal) => safeEvent(scope, 'exit', { code, signal }));
      child.on('close', (code, signal) => {
        handles.delete(child);
        safeEvent(scope, 'close', { code, signal });
      });
      child.stdout?.on('close', () => safeEvent(scope, 'stdout_close'));
      child.stderr?.on('close', () => safeEvent(scope, 'stderr_close'));
    } catch { safeEvent(scope, 'observer_incomplete'); }
  }
  return child;
}

// The same complete inert program backs every npm bin and shebang control.
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

function childEnv(bin, casing, caseDir, nonce, mode) {
  return {
    SystemRoot: systemRoot, WINDIR: systemRoot, ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    [casing]: [bin, path.dirname(process.execPath), path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter),
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
  // nodeSpawner merges process.env, and probeVersion cannot accept an env.
  // The dedicated diagnostic process itself therefore uses this same allowlist.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}
function liveness(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
}
function fixtureState(dir, nonce) {
  const result = {};
  for (const role of ['payload', 'descendant']) {
    const item = {};
    for (const kind of ['start', 'exit']) {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, `${role}-${kind}.json`), 'utf8'));
        if (record.nonce !== nonce || record.role !== role || !Number.isSafeInteger(record.pid) || record.pid <= 0 ||
          !Number.isSafeInteger(record.ppid) || record.ppid <= 0) {
          item[kind] = 'invalid_provenance';
        } else item[kind] = record;
      } catch { item[kind] = 'unobserved'; }
    }
    item.liveness = typeof item.start === 'object' ? liveness(item.start.pid) : 'unknown';
    item.exitPidMatches = typeof item.start === 'object' && typeof item.exit === 'object' &&
      item.exit.pid === item.start.pid && item.exit.ppid === item.start.ppid;
    result[role] = item;
  }
  return result;
}
function assessObservation(record, state) {
  const has = name => record.events.some(event => event.event === name);
  const reasons = [];
  if (record.truncated || has('observer_incomplete')) reasons.push('event_loss');
  if (record.end_ms === undefined) reasons.push('invocation_unsettled');
  const refused = !record.pid && !has('spawn') && record.events.some(event =>
    ['throw', 'error'].includes(event.event) && ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'ENOEXEC'].includes(event.code)) &&
    ((has('throw') && !has('returned')) || (has('returned') && has('close') && record.pipesClosedAfter));
  if (refused) {
    if (Object.values(state).some(item => item.start !== 'unobserved' || item.exit !== 'unobserved')) reasons.push('refusal_provenance_conflict');
  } else {
    if (!['returned', 'spawn', 'exit', 'close'].every(has)) reasons.push('missing_child_events');
    for (const name of ['returned', 'spawn']) {
      const events = record.events.filter(event => event.event === name);
      if (events.length !== 1 || events[0].pid !== record.pid) reasons.push(`${name}_pid_mismatch`);
    }
    if (!record.pipesClosedAfter) reasons.push('pipe_closure_unknown');
    const roles = record.mode === 'timeout' ? ['payload', 'descendant'] : ['payload'];
    for (const role of roles) {
      const item = state[role];
      if (typeof item.start !== 'object') reasons.push(`${role}_start_unknown`);
      if (item.liveness !== 'absent') reasons.push(`${role}_lifetime_unknown`);
      if (item.exit !== 'unobserved' && !item.exitPidMatches) reasons.push(`${role}_exit_mismatch`);
      // SIGKILL prevents a fixture exit report; a correlated direct child exit is evidence.
      if (item.exit === 'unobserved' && !(item.start?.pid === record.pid && has('exit'))) reasons.push(`${role}_exit_unknown`);
    }
    const payload = state.payload.start;
    if (typeof payload !== 'object' || (payload.pid === record.pid ? payload.ppid !== process.pid : payload.ppid !== record.pid)) reasons.push('payload_parent_mismatch');
    if (record.mode === 'timeout' && (typeof state.descendant.start !== 'object' ||
      state.descendant.start.ppid !== payload?.pid)) reasons.push('descendant_parent_mismatch');
    if (record.mode !== 'timeout' && (state.descendant.start !== 'unobserved' || state.descendant.exit !== 'unobserved')) reasons.push('unexpected_descendant');
    if (record.entrypoint === 'run' && record.error === 'ETIMEDOUT' &&
      (!record.atTimeout || roles.some(role => typeof record.atTimeout[role].start !== 'object' ||
        record.atTimeout[role].start.pid !== state[role].start?.pid || record.atTimeout[role].liveness === 'unknown'))) reasons.push('timeout_sample_unknown');
  }
  return { complete: reasons.length === 0, launch: refused ? 'proven_pre_spawn_refusal' : 'fixture_correlation_required', reasons };
}
async function sampleInvocation(record, caseDir) {
  await delay(20);
  record.after = fixtureState(caseDir, record.nonce);
  record.pipesClosedAfter = ['stdout_close', 'stderr_close', 'close'].every(event => record.events.some(entry => entry.event === event));
  record.observation = assessObservation(record, record.after);
}
function crossRun(crossSpawn, cmd, stdin, timeout, record) {
  return new Promise((resolve, reject) => {
    const begin = performance.now();
    const child = crossSpawn(cmd.argv[0], cmd.argv.slice(1), { cwd: cmd.cwd, env: cmd.env, shell: false });
    let stdout = '', stderr = '';
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('BOOT_TIMEOUT'), { code: 'ETIMEDOUT' }));
    }, timeout);
    const append = (stream, data) => {
      bytes += data.length;
      if (bytes > 65536) {
        child.kill('SIGKILL');
        reject(Object.assign(new Error('OUTPUT_LIMIT'), { code: 'OUTPUT_LIMIT' }));
        return;
      }
      if (stream === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', data => append('stdout', data));
    child.stderr.on('data', data => append('stderr', data));
    child.stdin.on('error', error => { record.stdinError = errorCode(error); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code ?? -1, duration_ms: Math.round(performance.now() - begin) });
    });
    child.stdin.end(stdin);
  });
}
function hashTree(directory, label) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(directory, entry.name);
    const key = `${label}/${entry.name}`;
    if (entry.isDirectory()) hashTree(full, key);
    else if (entry.isFile()) receipt.identity.hashes[key] = fileHash(full);
  }
}
function setupNpm(npmCli, args, env, cwd, label) {
  const result = cp.spawnSync(process.execPath, [npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd, env, shell: false, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8',
  });
  receipt.setup.push({ label, status: result.status, signal: result.signal, error: result.error ? errorCode(result.error) : null,
    stdoutHash: hash(result.stdout || ''), stderrHash: hash(result.stderr || '') });
  if (result.status !== 0) throw new Error('OFFLINE_NPM_SETUP_FAILED');
}

// A fixed deadline is independent of individual run/probeVersion promises.
const watchdog = setTimeout(() => {
  receipt.overallDeadlineReached = true;
  receipt.status = 'overall_deadline';
  restoreObserver();
  receipt.forcedCleanup = [];
  for (const child of handles) {
    try { receipt.forcedCleanup.push({ pid: child.pid ?? null, killed: child.kill('SIGKILL') }); }
    catch { receipt.forcedCleanup.push({ pid: child.pid ?? null, killed: false }); }
  }
  receipt.cleanup = { complete: false, privateRootRemoved: false, reason: 'overall_deadline' };
  for (const record of receipt.cases) record.observation = { complete: false, reasons: ['deadline_cleanup_unknown'] };
  save();
  // Inert fixtures expire by 2.4 seconds. Do not claim this is tree cleanup.
  setTimeout(() => process.exit(2), 3500);
}, 240000);

try {
  save();
  if (process.platform !== 'win32' || process.version !== 'v20.20.2') throw new Error('NATIVE_RUNTIME_REQUIRED');
  if (!systemRoot || !/^[0-9a-f]{40}$/i.test(commit)) throw new Error('IDENTITY_REQUIRED');
  root = fs.mkdtempSync(path.join(parent, 'boot probe (owned)-'));
  for (const name of ['home', 'config', 'cache', 'temp', 'package', 'local', 'prefix', 'cases']) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, 'npmrc'), '');
  fs.writeFileSync(path.join(root, 'global-npmrc'), '');
  const nonce = crypto.randomBytes(16).toString('hex');
  const binName = `inert-probe-${nonce}`;
  const fixturePath = path.join(root, 'package', 'probe');
  fs.writeFileSync(fixturePath, fixture);
  fs.writeFileSync(path.join(root, 'package', 'package.json'), JSON.stringify({ name: binName, version: '1.0.0', bin: { [binName]: 'probe' } }));
  fs.writeFileSync(path.join(root, 'local', 'package.json'), '{"private":true}');
  const env = childEnv(path.dirname(process.execPath), 'PATH', path.join(root, 'cases'), nonce, 'normal');
  replaceEnv(env);
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  receipt.identity.hashes.runtime = fileHash(process.execPath);
  const gitDir = path.join(repo, '.git');
  const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  let checkoutCommit = head;
  if (head.startsWith('ref: ')) {
    const ref = head.slice(5);
    if (!/^refs\/[A-Za-z0-9_./-]+$/.test(ref) || ref.includes('..')) throw new Error('IDENTITY_REQUIRED');
    try { checkoutCommit = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim(); }
    catch {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n');
      checkoutCommit = packed.find(line => line.endsWith(` ${ref}`))?.split(' ')[0];
    }
  }
  receipt.identity.checkoutCommit = checkoutCommit;
  if (checkoutCommit !== commit) throw new Error('IDENTITY_REQUIRED');
  receipt.identity.hashes.npmCli = fileHash(npmCli);
  receipt.identity.npmVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(npmCli), '..', 'package.json'))).version;
  for (const name of ['src/session/boot-adapter/spawner.ts', 'src/session/boot-adapter/types.ts', 'src/session/boot-adapter/common.ts',
    'dist/src/session/boot-adapter/spawner.js', 'package.json', 'package-lock.json',
    'tests/dispatch/windows-boot-spawn-probe.mjs', '.github/workflows/windows-boot-spawn-probe.yml']) {
    receipt.identity.hashes[name] = fileHash(path.join(repo, name));
  }
  receipt.observer.sourceHash = receipt.identity.hashes['tests/dispatch/windows-boot-spawn-probe.mjs'];
  receipt.identity.hashes.fixture = fileHash(fixturePath);
  receipt.identity.hashes.fixtureManifest = fileHash(path.join(root, 'package', 'package.json'));
  const crossEntry = require.resolve('cross-spawn');
  const crossRequire = createRequire(crossEntry);
  const crossPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(crossEntry), 'package.json')));
  if (crossPackage.version !== '7.0.6') throw new Error('CROSS_SPAWN_VERSION');
  receipt.identity.crossSpawnVersion = crossPackage.version;
  hashTree(path.dirname(crossEntry), 'cross-spawn');
  for (const dependency of ['path-key', 'shebang-command', 'which']) {
    const resolved = crossRequire.resolve(`${dependency}/package.json`);
    hashTree(path.dirname(resolved), dependency);
    const depRequire = createRequire(resolved);
    if (dependency === 'shebang-command') hashTree(path.dirname(depRequire.resolve('shebang-regex/package.json')), 'shebang-regex');
    if (dependency === 'which') hashTree(path.dirname(depRequire.resolve('isexe/package.json')), 'isexe');
  }
  setupNpm(npmCli, ['install', '--install-links', '--package-lock=false', path.join(root, 'package')], env, path.join(root, 'local'), 'local');
  setupNpm(npmCli, ['install', '--global', '--prefix', path.join(root, 'prefix'), path.join(root, 'package')], env, root, 'isolated-prefix');
  const localBin = path.join(root, 'local', 'node_modules', '.bin');
  const prefixBin = path.join(root, 'prefix');
  for (const [label, bin] of [['local', localBin], ['prefix', prefixBin]]) {
    for (const suffix of ['', '.cmd', '.ps1']) receipt.identity.hashes[`${label}/shim${suffix}`] = fileHash(path.join(bin, binName + suffix));
    const installed = label === 'local' ? path.join(root, 'local', 'node_modules', binName, 'probe') : path.join(prefixBin, 'node_modules', binName, 'probe');
    receipt.identity.hashes[`${label}/fixture`] = fileHash(installed);
    if (fileHash(installed) !== receipt.identity.hashes.fixture) throw new Error('FIXTURE_IDENTITY');
  }
  cp.spawn = observedSpawn;
  syncBuiltinESMExports();
  const { nodeSpawner } = await import(pathToFileURL(path.join(repo, 'dist/src/session/boot-adapter/spawner.js')).href);
  const current = nodeSpawner();
  const crossSpawn = require('cross-spawn');
  const targets = [
    { name: 'local-bare', exe: binName, bin: localBin },
    { name: 'local-absolute', exe: path.join(localBin, binName + '.cmd'), bin: localBin },
    { name: 'prefix-bare', exe: binName, bin: prefixBin },
    { name: 'prefix-absolute', exe: path.join(prefixBin, binName + '.cmd'), bin: prefixBin },
    { name: 'node-exe-control', exe: process.execPath, prefix: [fixturePath], bin: localBin },
    { name: 'extensionless-shebang', exe: fixturePath, bin: localBin },
  ];
  const modes = ['version', 'help', 'echo', 'nonzero', 'forbidden', 'bad-version', 'bad-help', 'refuse-version', 'refuse-help', 'timeout', 'missing'];
  const input = 'stdin empty-line follows\n\n한글 😀\r\n" & | % !\n';
  async function probeInvocation(target, casing, mode, id) {
    if (receipt.overallDeadlineReached) throw new Error('OVERALL_DEADLINE');
    const fixtureSlot = String(receipt.cases.length);
    const caseDir = path.join(root, 'cases', fixtureSlot);
    fs.mkdirSync(caseDir);
    const caseNonce = crypto.randomBytes(16).toString('hex');
    replaceEnv(childEnv(target.bin, casing, caseDir, caseNonce, mode));
    const probe = { id, entrypoint: 'probeVersion', mode, fixtureSlot, nonce: caseNonce,
      begin_ms: elapsed(), timeoutLimit_ms: null, fixtureExpiry_ms: mode === 'timeout' ? 2400 : 2200, events: [] };
    receipt.cases.push(probe);
    active = probe;
    try {
      probe.version = (await current.probeVersion(mode === 'missing' ? `missing-${caseNonce}` : target.exe)).split(root).join('<ROOT>').slice(0, 8192);
      probe.versionMatchesExpected = probe.version === '7.8.9';
    } catch (error) { probe.error = error.message === 'CLI_NOT_FOUND' ? 'CLI_NOT_FOUND' : errorCode(error); }
    finally { active = undefined; probe.end_ms = elapsed(); }
    if (mode === 'timeout') await delay(2800);
    await sampleInvocation(probe, caseDir);
    probe.lifetime = { observationComplete: probe.observation.complete,
      assessment: probe.observation.complete ? 'finite_fixture_or_proven_refusal_observed' : 'unknown',
      wrapperTimeoutAction: 'none: production collect has no timer' };
    save();
  }
  for (const engine of ['current', 'cross-spawn']) for (const casing of ['PATH', 'Path']) for (const target of targets) for (const mode of modes) {
    if (receipt.overallDeadlineReached) throw new Error('OVERALL_DEADLINE');
    const id = `${engine}/${casing}/${target.name}/${mode}`;
    const fixtureSlot = String(receipt.cases.length);
    const caseDir = path.join(root, 'cases', fixtureSlot);
    fs.mkdirSync(caseDir);
    const caseNonce = crypto.randomBytes(16).toString('hex');
    const sentinel = path.join(caseDir, 'injection-sentinel');
    const literal = ['', 'two words', '한글 😀', 'a"b', 'tail\\', '(parentheses)', '&', '|', '<', '>', '^', '%', '!', ';', 'line1\nline2',
      '%PROBE_EXPANSION%', '!PROBE_EXPANSION!', '& echo owned>injection-sentinel', '| echo owned>injection-sentinel',
      '\n echo owned>injection-sentinel', 'x" & echo owned>injection-sentinel & rem "'];
    const args = mode === 'echo' ? literal : mode === 'nonzero' ? ['--nonzero', ...literal] :
      mode.includes('version') ? ['--version'] : mode.includes('help') ? ['--help'] :
        mode === 'forbidden' ? ['--forbidden'] : [];
    const caseEnv = childEnv(target.bin, casing, caseDir, caseNonce, mode);
    replaceEnv(caseEnv);
    const command = { argv: [mode === 'missing' ? `missing-${caseNonce}` : target.exe, ...(target.prefix || []), ...args], env: caseEnv, cwd: caseDir };
    const timeout = mode === 'timeout' ? 600 : 1500;
    const record = { id, entrypoint: 'run', mode, fixtureSlot, nonce: caseNonce, begin_ms: elapsed(), timeoutLimit_ms: timeout,
      parentPathKeys: Object.keys(process.env).filter(key => key.toLowerCase() === 'path'),
      events: [], expected: { argvHash: hash(JSON.stringify(args)), stdinHash: hash(input) } };
    receipt.cases.push(record);
    active = record;
    try {
      const result = await (engine === 'current' ? current.run(command, input, timeout) : crossRun(crossSpawn, command, input, timeout, record));
      record.result = { exit_code: result.exit_code, duration_ms: result.duration_ms, stdoutHash: hash(result.stdout), stderrHash: hash(result.stderr),
        stdout: result.stdout.split(root).join('<ROOT>').slice(0, 8192), stderr: result.stderr.split(root).join('<ROOT>').slice(0, 1024) };
      if (mode === 'echo' || mode === 'nonzero') {
        try {
          const echo = JSON.parse(result.stdout);
          record.argvBytesEqual = Buffer.from(JSON.stringify(echo.argv)).equals(Buffer.from(JSON.stringify(args)));
          record.stdinBytesEqual = typeof echo.stdin === 'string' && Buffer.from(echo.stdin, 'base64').equals(Buffer.from(input));
        } catch { record.argvBytesEqual = false; record.stdinBytesEqual = false; }
      }
      if (mode.includes('version')) record.versionMatchesExpected = /\b7\.8\.9\b/.test(result.stdout);
      if (mode.includes('help')) record.helpFlagsPresent = ['--model', '--prompt', '--cwd', '--non-interactive'].every(flag => result.stdout.includes(flag));
    } catch (error) {
      record.error = errorCode(error);
      if (error.code === 'ETIMEDOUT') {
        record.timeout_ms = elapsed();
        record.atTimeout = fixtureState(caseDir, caseNonce);
        record.pipesClosedAtTimeout = ['stdout_close', 'stderr_close', 'close'].every(event => record.events.some(entry => entry.event === event));
      }
    } finally { active = undefined; record.end_ms = elapsed(); }
    if (mode === 'timeout' || record.error === 'ETIMEDOUT') await delay(2800);
    // Let child close events finish after a launch error or a normal result.
    await sampleInvocation(record, caseDir);
    record.injectionSentinel = fs.existsSync(sentinel);
    record.forbiddenMarker = fs.existsSync(path.join(caseDir, 'forbidden'));
    record.forbiddenExpected = mode === 'forbidden';
    record.forbiddenMatched = record.forbiddenMarker && fs.readFileSync(path.join(caseDir, 'forbidden'), 'utf8') === caseNonce;
    if (record.forbiddenMatched && record.forbiddenExpected) fs.unlinkSync(path.join(caseDir, 'forbidden'));
    if (mode === 'timeout') {
      record.lifetime = {
        payloadSurvivedTimeout: record.atTimeout ? record.atTimeout.payload.liveness : 'unobserved',
        descendantSurvivedTimeout: record.atTimeout ? record.atTimeout.descendant.liveness : 'unobserved',
        descendantParentMatches: typeof record.after.descendant.start === 'object' && typeof record.after.payload.start === 'object' &&
          record.after.descendant.start.ppid === record.after.payload.start.pid,
        eventualNaturalExit: Object.values(record.after).every(item => item.exitPidMatches && item.liveness === 'absent'),
        observationComplete: record.observation.complete,
        wrapperTimeoutAction: 'SIGKILL on returned ChildProcess only',
        postObservationForcedCleanup: 'recorded separately in cleanup.forcedHandles',
      };
      record.lifetime.assessment = !record.lifetime.observationComplete ? 'unknown' :
        record.observation.launch === 'proven_pre_spawn_refusal' ? 'proven_pre_spawn_refusal' :
        record.lifetime.payloadSurvivedTimeout === 'alive' || record.lifetime.descendantSurvivedTimeout === 'alive' || !record.pipesClosedAtTimeout ?
          'timeout_tree_or_pipe_failure' : 'no_survival_observed_at_sample';
    }
    // Also measure the real public probeVersion entry point, without replacing it.
    if (engine === 'current' && mode.includes('version') && !target.prefix) {
      await probeInvocation(target, casing, mode, `${id}/probeVersion`);
    }
    save();
  }
  for (const mode of ['missing', 'timeout']) {
    await probeInvocation(targets[0], 'PATH', mode, `current/PATH/local-bare/${mode}/probeVersion`);
  }
  receipt.coverage.observed = Object.fromEntries(['run', 'probeVersion'].map(entrypoint => [entrypoint, {
    attempted: receipt.cases.filter(item => item.entrypoint === entrypoint).length,
    complete: receipt.cases.filter(item => item.entrypoint === entrypoint && item.observation?.complete).length,
    fixtureStarted: receipt.cases.filter(item => item.entrypoint === entrypoint && typeof item.after?.payload.start === 'object').length,
  }]));
  receipt.coverage.probeVersionTimeout = receipt.cases.some(item => item.entrypoint === 'probeVersion' &&
    item.mode === 'timeout' && item.observation?.complete && typeof item.after?.payload.start === 'object') ?
    'finite_fixture_lifecycle_observed; no production timeout policy' : 'UNKNOWN: timeout fixture lifecycle not established';
  receipt.status = receipt.cases.every(item => item.observation?.complete) ? 'diagnostic_completed' : 'diagnostic_incomplete';
  if (receipt.status === 'diagnostic_incomplete') process.exitCode = 2;
  receipt.findings = {
    errors: receipt.cases.filter(item => item.error).length,
    argvCorruptions: receipt.cases.filter(item => item.argvBytesEqual === false).length,
    stdinCorruptions: receipt.cases.filter(item => item.stdinBytesEqual === false).length,
    unwantedSentinels: receipt.cases.filter(item => item.injectionSentinel || (item.forbiddenMarker && !item.forbiddenExpected)).length,
    incompleteLifetime: receipt.cases.filter(item => item.lifetime && !item.lifetime.observationComplete).length,
    incompleteObservations: receipt.cases.filter(item => !item.observation?.complete).length,
  };
} catch (error) {
  receipt.status = 'harness_failure';
  receipt.error = errorCode(error);
  // Only fixed local error literals are exportable; never export raw OS messages.
  const known = ['NATIVE_RUNTIME_REQUIRED', 'IDENTITY_REQUIRED', 'CROSS_SPAWN_VERSION', 'FIXTURE_IDENTITY', 'OFFLINE_NPM_SETUP_FAILED', 'RECEIPT_LIMIT'];
  if (known.includes(error.message)) receipt.reason = error.message;
  process.exitCode = 2;
} finally {
  active = undefined;
  restoreObserver();
  if (!receipt.observer.restored) { receipt.status = 'observer_restore_failure'; process.exitCode = 2; }
  receipt.cleanup = { forcedHandles: [], remainingOwnedHandles: handles.size, privateRootRemoved: false };
  for (const child of handles) {
    try { receipt.cleanup.forcedHandles.push({ pid: child.pid ?? null, killed: child.kill('SIGKILL') }); }
    catch { receipt.cleanup.forcedHandles.push({ pid: child.pid ?? null, killed: false }); }
  }
  await delay(3500);
  receipt.cleanup.remainingOwnedHandles = handles.size;
  receipt.cleanup.fixtureProcesses = receipt.cases.map(item => {
    const state = fixtureState(path.join(root, 'cases', item.fixtureSlot), item.nonce);
    const observation = assessObservation(item, state);
    item.cleanup = { complete: observation.complete, reasons: observation.reasons };
    return { id: item.id, state, complete: observation.complete };
  });
  const knownFixturesAbsent = receipt.cleanup.fixtureProcesses.every(item => item.complete);
  receipt.cleanup.allReportedFixturePidsAbsent = knownFixturesAbsent;
  // Retain private files on uncertain cleanup; artifact upload never includes them.
  receipt.cleanup.complete = handles.size === 0 && knownFixturesAbsent;
  if (!receipt.cleanup.complete && receipt.status === 'diagnostic_completed') {
    receipt.status = 'diagnostic_incomplete'; process.exitCode = 2;
  }
  if (root && receipt.status === 'diagnostic_completed' && receipt.cleanup.complete && receipt.cases.every(item => item.observation?.complete)) {
    fs.rmSync(root, { recursive: true, force: true });
    receipt.cleanup.privateRootRemoved = true;
  }
  receipt.elapsed_ms = elapsed();
  if (receipt.overallDeadlineReached) { receipt.status = 'overall_deadline'; process.exitCode = 2; }
  clearTimeout(watchdog);
  save();
}
