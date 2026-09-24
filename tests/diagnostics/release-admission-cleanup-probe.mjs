// One observation only. This file never changes the source fixture or product gates.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync,
  opendirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const pattern = '^reject CLI (--unknown|--version 1[.]1[.]0 --version 1[.]1[.]0)$';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const code = error => /^[A-Z0-9_]{1,40}$/.test(error?.code) ? error.code : 'UNCLASSIFIED';
let eventCount = 0;

// Observer errors must never replace the fixture's original assertion or cleanup error.
export function observe(kind, root, details = {}) {
  try {
    if (++eventCount > 256) return;
    appendFileSync(process.env.ADMISSION_PROBE_EVENTS, JSON.stringify({ kind,
      monotonic_ns: process.hrtime.bigint().toString(), wall_time: new Date().toISOString(), pid: process.pid,
      fixture: path.basename(root), ...details }) + '\n', { mode: 0o600 });
  } catch { /* The receipt detects missing boundaries; no cleanup error is swallowed. */ }
}

export function leftovers(root) {
  const entries = [];
  const pending = [''];
  let truncated = false;
  const until = performance.now() + 100;
  while (pending.length && entries.length < 64 && performance.now() < until) {
    const relative = pending.shift();
    let directory;
    try {
      directory = opendirSync(path.join(root, relative));
      let entry;
      while ((entry = directory.readSync())) {
        if (entries.length >= 64 || performance.now() >= until) { truncated = true; break; }
        const name = path.join(relative, entry.name);
        entries.push({ path: name.slice(0, 240), type: entry.isSymbolicLink() ? 'symlink'
          : entry.isDirectory() ? 'directory' : 'file' });
        if (entry.isDirectory() && name.split(path.sep).length < 8) pending.push(name);
        else if (entry.isDirectory()) truncated = true;
      }
    } catch (error) { entries.push({ path: relative.slice(0, 240), error: code(error) }); }
    finally { if (directory) { try { directory.closeSync(); } catch { truncated = true; } } }
  }
  return { entries, truncated: truncated || pending.length > 0 };
}

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('SOURCE_SHAPE_MISMATCH');
  return source.replace(anchor, () => replacement);
}

function instrument(source) {
  let text = replaceOnce(source, "import test from 'node:test';",
    "import test from 'node:test';\nimport { observe, leftovers } from '../diagnostics/release-admission-cleanup-probe.mjs';");
  text = replaceOnce(text, '  t.after(() => rmSync(root, { recursive: true, force: true }));',
    `  t.after(() => {
    observe('cleanup-start', root);
    try {
      rmSync(root, { recursive: true, force: true });
      observe('cleanup-return', root);
    } catch (error) {
      observe('cleanup-error', root, { code: error.code });
      try { observe('cleanup-leftovers', root, leftovers(root)); }
      catch { observe('cleanup-snapshot-unavailable', root); }
      throw error;
    }
  });`);
  text = replaceOnce(text, '  const git = (...args) => {',
    `  env.GIT_TRACE2_EVENT = process.env.ADMISSION_PROBE_TRACE;
  const git = (...args) => {
    observe('setup-child-start', root, { args });`);
  const call = "    const result = spawnSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args], { env, encoding: 'utf8', timeout: 10000 });";
  text = replaceOnce(text, call, call + `
    observe('setup-child-return', root, { child_pid: result.pid, status: result.status,
      signal: result.signal, error: result.error?.code ?? null });`);
  return text;
}

function boundedRead(file, limit) {
  const descriptor = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const bytes = readSync(descriptor, buffer, 0, limit, 0);
    return { text: buffer.subarray(0, bytes).toString('utf8'), truncated: statSync(file).size > bytes };
  } finally { closeSync(descriptor); }
}

const allowedArgs = new Set(['git', 'maintenance', 'gc', 'run', '--auto', '--no-quiet',
  '--detach', '--no-detach', '--schedule', 'hourly', 'daily', 'weekly', 'commit', 'add',
  '--all', 'init', '--quiet', 'rev-parse', 'HEAD', 'tag', 'v1.0.0', '-c',
  'core.hooksPath=/dev/null', '--no-gpg-sign', '-m', 'synthetic fixture']);
const safeArgs = value => Array.isArray(value)
  ? value.slice(0, 24).map(arg => allowedArgs.has(arg) ? arg : '[redacted]') : [];

function traceRecords(file) {
  if (!existsSync(file)) return { missing: true, records: [] };
  const raw = boundedRead(file, 512 * 1024);
  const records = [];
  let malformed = 0;
  let count = 0;
  for (const line of raw.text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!['start', 'exit', 'atexit', 'child_start', 'child_exit', 'child_ready'].includes(event.event)) continue;
      count++;
      if (records.length >= 256) continue;
      const record = { event: event.event, sid_hash: sha256(String(event.sid ?? '')) };
      // SID hashes preserve lineage joins without exposing paths or arbitrary strings.
      record.parent_sid_hash = typeof event.sid === 'string' && event.sid.includes('/')
        ? sha256(event.sid.slice(0, event.sid.lastIndexOf('/'))) : null;
      for (const key of ['child_id', 'pid', 'code', 't_abs', 't_rel']) {
        if (typeof event[key] === 'number' && Number.isFinite(event[key])) record[key] = event[key];
      }
      if (/^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(event.time)) record.time = event.time;
      if (event.argv) record.argv = safeArgs(event.argv);
      records.push(record);
    } catch { malformed++; }
  }
  return { missing: false, truncated: raw.truncated || count > 256, malformed, records };
}

async function main() {
  const started = performance.now();
  const repo = path.resolve(path.dirname(filename), '../..');
  const receiptDir = path.join(repo, '.release-admission-cleanup-receipt');
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const receiptFile = path.join(receiptDir, 'receipt.json');
  const identity = key => /^[A-Za-z0-9_.-]{1,100}$/.test(process.env[key] ?? '') ? process.env[key] : null;
  const receipt = {
    schema: 1, task: 1171, operation: 'mc1171a-v2', status: 'INCOMPLETE',
    source: 'de47cd3deee8cc5c4d00f284fb67c2fe7a0ffd90',
    run: { id: identity('GITHUB_RUN_ID'), attempt: identity('GITHUB_RUN_ATTEMPT'),
      checkout: identity('GITHUB_SHA'), job: identity('GITHUB_JOB') },
    selection: { pattern, intended_cases: 2, other_cases: 'excluded', full_suite_acceptance: false },
    deadline: { overall_ms: 60000, termination_at_ms: 57000, finalization_at_ms: 58000,
      termination_grace_ms: 1000, receipt_reserve_ms: 2000 },
    baseline: { os: 'macOS 26.6.2', arch: 'arm64', node: 'v20.20.2', git: 'git version 2.55.0',
      log_source: '19aba120cbf0b71e48c2f3f934b6a1798d3727c4', ci: '35483502844' },
    observer: { os_fork_filesystem: 'UNAVAILABLE', universal_writer_attribution: false,
      detached_descendants_outside_owned_group: 'UNMEASURED' },
    hashes: {}, result: null,
  };
  const save = () => writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  save();
  let work;
  let env;
  try {
    work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'admission-probe-')));
    for (const name of ['home', 'tmp', 'tree/tests/packaging', 'tree/tests/diagnostics', 'tree/scripts']) {
      mkdirSync(path.join(work, name), { recursive: true, mode: 0o700 });
    }
    // Deliberate allowlist: checkout tokens and inherited Git/Node overrides never reach children.
    env = { PATH: process.env.PATH, HOME: path.join(work, 'home'),
      XDG_CONFIG_HOME: path.join(work, 'home'), TMPDIR: path.join(work, 'tmp'),
      TMP: path.join(work, 'tmp'), TEMP: path.join(work, 'tmp'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
      ADMISSION_PROBE_EVENTS: path.join(work, 'events.jsonl'),
      ADMISSION_PROBE_TRACE: path.join(work, 'trace.jsonl') };
    const version = (command, args) => {
      const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 1000, maxBuffer: 1024 });
      if (result.error || result.status !== 0) throw new Error('IDENTITY_UNAVAILABLE');
      return result.stdout.trim().slice(0, 100);
    };
    receipt.actual = { platform: process.platform, os: os.release(), arch: process.arch,
      node: process.version, git: version('git', ['--version']),
      macOS: process.platform === 'darwin' ? version('/usr/bin/sw_vers', ['-productVersion']) : null };
    receipt.drift = { os: receipt.actual.macOS !== '26.6.2', arch: process.arch !== 'arm64',
      node: process.version !== 'v20.20.2', git: receipt.actual.git !== 'git version 2.55.0',
      source_vs_historical_log: true, scheduling_vs_original_suite: true };
    if (process.platform !== 'darwin' || process.version !== 'v20.20.2') throw new Error('RUNTIME_MISMATCH');
    const inputs = [
      ['tests/packaging/release-admission.test.mjs', 'a1cc55974c7ff55baf7707dd7c3c0dea466c613547cb3d21003e07bf9ea46c66'],
      ['scripts/release-admission.mjs', 'e0c54fabc68eaab4087bfc5e9d47637c6485c2d9b43709be2b7d91cc7fc5834a'],
    ];
    for (const [name, expected] of inputs) {
      const original = readFileSync(path.join(repo, name));
      receipt.hashes[name] = { original: sha256(original), expected };
      if (sha256(original) !== expected) throw new Error('SOURCE_HASH_MISMATCH');
      const copy = name.startsWith('tests/') ? Buffer.from(instrument(original.toString('utf8'))) : original;
      receipt.hashes[name].instrumented = sha256(copy);
      writeFileSync(path.join(work, 'tree', name), copy, { mode: 0o600 });
    }
    const helper = readFileSync(filename);
    receipt.hashes.probe = { original: sha256(helper), instrumented: sha256(helper) };
    writeFileSync(path.join(work, 'tree/tests/diagnostics', path.basename(filename)), helper, { mode: 0o600 });
    receipt.hashes.workflow = sha256(readFileSync(path.join(repo, '.github/workflows/release-admission-cleanup-probe.yml')));
    receipt.argv = ['--test', `--test-name-pattern=${pattern}`, 'tests/packaging/release-admission.test.mjs'];
    save();
    receipt.result = await new Promise(resolve => {
      const child = spawn(process.execPath, receipt.argv, { cwd: path.join(work, 'tree'), env,
        detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false;
      let overflow = false;
      let bytes = 0;
      let output = '';
      let spawnError = null;
      let streamError = null;
      let finalized = false;
      let exit = null;
      let signal = null;
      let exitReceived = false;
      let closeReceived = false;
      let groupKillAttempted = false;
      let groupKillError = null;
      let terminationReason = null;
      let terminationTimer;
      let finalizationTimer;
      let graceTimer;
      const outputHash = createHash('sha256');
      const killOwnedGroup = () => {
        if (!child.pid || groupKillAttempted) return;
        groupKillAttempted = true;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') groupKillError = code(error); }
      };
      const finalize = reason => {
        if (finalized) return;
        finalized = true;
        clearTimeout(terminationTimer);
        clearTimeout(finalizationTimer);
        clearTimeout(graceTimer);
        killOwnedGroup();
        const destroyedStreams = [];
        if (!closeReceived) {
          // An escaped descendant may still own a pipe. Do not await close or
          // claim that destroying our pipe endpoints reaped that descendant.
          for (const name of ['stdout', 'stderr']) {
            if (!child[name].destroyed) {
              destroyedStreams.push(name);
              child[name].destroy();
            }
          }
          child.unref();
        }
        const counts = {};
        for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
          const match = output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
          counts[key === 'skipped' ? 'excluded' : key] = match ? Number(match[1]) : null;
        }
        resolve({ exit, signal, timedOut, overflow, spawnError, streamError, bytes,
          output_sha256: outputHash.digest('hex'), counts,
          finalization_reason: reason, termination_reason: terminationReason,
          child_exit_received: exitReceived, child_close_received: closeReceived,
          incomplete_close: !closeReceived, forced_stream_destruction: destroyedStreams,
          child_handle_unreferenced: !closeReceived,
          owned_group_kill_attempted: groupKillAttempted, owned_group_kill_error: groupKillError,
          detached_descendants_reaped: 'UNMEASURED' });
      };
      const terminate = reason => {
        if (finalized || terminationReason) return;
        terminationReason = reason;
        killOwnedGroup();
        graceTimer = setTimeout(() => finalize('termination-grace-expired'),
          Math.max(0, Math.min(receipt.deadline.termination_grace_ms,
            receipt.deadline.finalization_at_ms - (performance.now() - started))));
      };
      terminationTimer = setTimeout(() => {
        if (finalized) return;
        timedOut = true;
        terminate('deadline');
      }, Math.max(0, receipt.deadline.termination_at_ms - (performance.now() - started)));
      finalizationTimer = setTimeout(() => {
        if (finalized) return;
        timedOut = true;
        terminationReason ??= 'deadline';
        finalize('finalization-deadline');
      }, Math.max(0, receipt.deadline.finalization_at_ms - (performance.now() - started)));
      const collect = chunk => {
        if (finalized) return;
        bytes += chunk.length;
        outputHash.update(chunk);
        if (bytes <= 256 * 1024) output += chunk.toString('utf8');
        else { overflow = true; terminate('output-overflow'); }
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', collect);
        stream.on('error', error => {
          if (finalized) return;
          streamError ??= code(error);
          terminate('stream-error');
        });
      }
      child.on('error', error => {
        if (finalized) return;
        spawnError ??= code(error);
        terminate('child-error');
      });
      child.on('exit', (status, exitSignal) => {
        if (finalized) return;
        exitReceived = true;
        exit = status;
        signal = exitSignal;
      });
      child.on('close', (status, closeSignal) => {
        if (finalized) return;
        closeReceived = true;
        exit = status;
        signal = closeSignal;
        finalize('child-close');
      });
    });
    receipt.status = receipt.result.timedOut ? 'TIMEOUT' : receipt.result.exit === 0
      && receipt.result.counts.pass === 2 && receipt.result.counts.fail === 0
      && receipt.result.counts.cancelled === 0 && !receipt.result.signal
      && !receipt.result.spawnError && !receipt.result.streamError && !receipt.result.overflow
      && !receipt.result.incomplete_close ? 'INCONCLUSIVE' : 'OBSERVATION_FAILED';
    process.exitCode = receipt.status === 'INCONCLUSIVE' ? 0 : 1;
  } catch (error) {
    const known = ['SOURCE_SHAPE_MISMATCH', 'SOURCE_HASH_MISMATCH', 'IDENTITY_UNAVAILABLE', 'RUNTIME_MISMATCH'];
    receipt.status = 'PROBE_ERROR';
    receipt.error = known.includes(error.message) ? error.message : code(error);
    process.exitCode = 1;
  } finally {
    try {
      receipt.trace = env ? traceRecords(env.ADMISSION_PROBE_TRACE) : { missing: true, records: [] };
      receipt.events = [];
      if (env && existsSync(env.ADMISSION_PROBE_EVENTS)) {
        const raw = boundedRead(env.ADMISSION_PROBE_EVENTS, 256 * 1024);
        receipt.events_truncated = raw.truncated;
        for (const line of raw.text.split('\n').filter(Boolean).slice(0, 256)) {
          const event = JSON.parse(line);
          if (event.args) event.args = safeArgs(event.args);
          receipt.events.push(event);
        }
      }
      receipt.boundaries_complete = ['setup-child-start', 'setup-child-return', 'cleanup-start']
        .every(kind => receipt.events.filter(event => event.kind === kind).length >= 2)
        && receipt.events.filter(event => ['cleanup-return', 'cleanup-error'].includes(event.kind)).length === 2;
    } catch (error) { receipt.collection_error = code(error); }
    receipt.elapsed_ms = Math.round(performance.now() - started);
    receipt.interpretation = 'Clean run or absent/incomplete trace is INCONCLUSIVE; no fix or full-suite acceptance. Git lifetime evidence cannot universally attribute filesystem writers.';
    // Keep failed trees private on the disposable runner; upload only this bounded receipt.
    receipt.private_tree_retained_until_runner_disposal = Boolean(work);
    save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) await main();
