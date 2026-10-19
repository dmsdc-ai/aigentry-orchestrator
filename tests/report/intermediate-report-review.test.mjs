// Current-contract regression: preliminary REPORT receipt is not terminal review.
// Real pump, sealed reader, parser and registry; only transport is a throwing fake.
// The test-local adapter tightens child limits. Production launch bounds, installed
// behavior, descendant containment and other suites are not certified by this test.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const started = performance.now();
const nativeSpawnSync = childProcess.spawnSync;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reader = path.join(repo, 'bin/report-outbox-read.py');
const registry = path.join(repo, 'bin/dispatch-registry.py');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const T0 = Date.parse('2026-10-01T12:00:00Z');
const DAY = 86400000;
const iso = ms => new Date(ms).toISOString();
const readerEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const limit = 1048576;
const budget = () => {
  const remaining = Math.floor(60000 - (performance.now() - started));
  assert(remaining > 0, 'IR suite exceeded its aggregate 60s budget');
  return Math.min(10000, remaining);
};
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  assert(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0);
  assert.equal(fs.realpathSync(dir), dir);
  return dir;
}
function regular(file) {
  assert.equal(fs.realpathSync(file), file);
  assert(fs.lstatSync(file).isFile());
}
assert(['linux', 'darwin'].includes(process.platform), 'IR suite requires the admitted POSIX CI leg');
const admittedRoot = process.env.AIGENTRY_STATUS_TEST_ROOT;
assert(admittedRoot && path.isAbsolute(admittedRoot));
assert.equal(fs.realpathSync(admittedRoot), admittedRoot);
const rootStat = fs.lstatSync(admittedRoot);
assert(rootStat.isDirectory() && rootStat.uid === process.getuid() && (rootStat.mode & 0o077) === 0);
const suppliedPython = process.env.AIGENTRY_STATUS_TEST_PYTHON;
const pythonHash = process.env.AIGENTRY_STATUS_TEST_PYTHON_SHA256;
assert(suppliedPython && path.isAbsolute(suppliedPython));
const python = fs.realpathSync(suppliedPython);
regular(python);
assert.match(pythonHash ?? '', /^[0-9a-f]{64}$/);
assert.equal(sha(fs.readFileSync(python)), pythonHash);
fs.accessSync(python, fs.constants.X_OK);
const node = fs.realpathSync(process.execPath);
if (process.env.NODE_EXECUTABLE) assert.equal(fs.realpathSync(process.env.NODE_EXECUTABLE), node);
regular(reader);
regular(registry);
const suite = privateDir(fs.mkdtempSync(path.join(admittedRoot, 'intermediate-report-')));
fs.writeFileSync(path.join(suite, 'admission.json'), JSON.stringify({ node,
  nodeSha256: sha(fs.readFileSync(node)), python, pythonHash, reader,
  readerSha256: sha(fs.readFileSync(reader)), registry,
  registrySha256: sha(fs.readFileSync(registry)), limits: { suiteMs: 60000, childMs: 10000, perStreamBytes: limit } }, null, 2),
{ flag: 'wx', mode: 0o600 });

// No emitted child programs: invoke only these two unchanged repository Python files.
const pump = await import(pathToFileURL(path.join(repo, 'dist/src/report/pump.js')).href);
const decisions = await import(pathToFileURL(path.join(repo, 'dist/src/report/decide.js')).href);
const envelope = await import(pathToFileURL(path.join(repo, 'dist/src/report/envelope.js')).href);

async function fixture(label, body, variant = {}) {
  budget();
  const base = privateDir(fs.mkdtempSync(path.join(suite, `${label}-`)));
  const home = privateDir(path.join(base, 'controller-home'));
  const tmp = privateDir(path.join(base, 'tmp'));
  const stateDir = privateDir(path.join(base, 'state'));
  const sessionsRoot = privateDir(path.join(base, 'sessions'));
  const target = privateDir(path.join(base, 'unused-target'));
  const sid = `ir-${label}`;
  const attempt = randomUUID(), request = randomUUID();
  const challenge = 'a'.repeat(43); // synthetic, valid base64url envelope shape; never a live challenge
  const root = privateDir(path.join(sessionsRoot, sid, 'sandbox', attempt));
  const workerHome = privateDir(path.join(root, 'home'));
  const outbox = privateDir(path.join(workerHome, 'report-outbox'));
  const dir = privateDir(path.join(outbox, request));
  const manifest = { version: 1, task: 'synthetic-ir', sid, attempt: variant.wrongAttempt ? randomUUID() : attempt,
    cli: 'codex', cwd: target, command: [path.join(target, 'never-executed')],
    env: { HOME: workerHome, AIGENTRY_REPORT_OUTBOX: outbox },
    config: { filesystem: { allowWrite: [workerHome, target] } },
    probeFile: path.join(root, 'outside-canary.txt'), probeDirectory: path.join(root, 'outside-directory-canary'),
    receipt: path.join(root, 'receipt.json') };
  const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
  fs.writeFileSync(path.join(root, 'manifest.json'), manifestBytes, { mode: 0o600, flag: 'wx' });
  const manifestHash = variant.wrongManifest ? '0'.repeat(64) : sha(manifestBytes);
  // Unknown receipt is deliberate: no fabricated launcher/transport success or PID lookup.
  const env = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, TMPDIR: tmp,
    XDG_CONFIG_HOME: privateDir(path.join(base, 'config')), XDG_CACHE_HOME: privateDir(path.join(base, 'cache')),
    XDG_DATA_HOME: privateDir(path.join(base, 'data')), LANG: 'C', LC_ALL: 'C',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
    DISPATCH_STATE_DIR: stateDir };
  const calls = [], unexpected = [], processFailures = [], externalCalls = [];
  let now = T0, did, guard = false, captureCallStart = 0;
  const oldCwd = process.cwd(), oldPython = process.env.AIGENTRY_REPORT_PYTHON;
  const oldSpawn = childProcess.spawnSync;
  const bytes = (kind, seq, text = 'synthetic evidence', overrides = {}) => Buffer.from(
    `AIGENTRY_REPORT v1 request_id=${overrides.request ?? request} challenge=${overrides.challenge ?? challenge} kind=${kind} seq=${seq}\n` +
    `${text}\nAIGENTRY_REPORT_END ${overrides.footerRequest ?? overrides.request ?? request} ${kind}-${overrides.footerSeq ?? seq}\n`);
  const saveCall = (command, argv, options, requested, role) => {
    const entry = { role, command, argv: [...argv], cwd: options.cwd ?? process.cwd(),
      env: { ...options.env }, stdio: options.stdio, requested,
      enforced: { timeout: options.timeout, maxBuffer: options.maxBuffer, killSignal: options.killSignal } };
    calls.push(entry);
    const begin = performance.now();
    const result = nativeSpawnSync(command, argv, options); // exactly one real call; original result returned
    Object.assign(entry, { elapsedMs: performance.now() - begin, status: result.status, signal: result.signal,
      error: result.error ? { message: result.error.message, code: result.error.code ?? null } : null,
      stdout: result.stdout ?? '', stderr: result.stderr ?? '',
      stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') });
    entry.timedOut = result.error?.code === 'ETIMEDOUT' || entry.elapsedMs > options.timeout;
    entry.overflow = result.error?.code === 'ENOBUFS' || entry.stdoutBytes > limit || entry.stderrBytes > limit;
    if (entry.error || entry.signal || entry.timedOut || entry.overflow ||
        (role === 'reader' && result.status !== 0)) processFailures.push(entry);
    // A budget exception can be caught by product code: retain it outside that path.
    try { budget(); } catch (error) { processFailures.push({ role, error: error.message }); }
    return result;
  };
  const adapter = (command, argv, options) => {
    const invocation = { command, argv, options, guard };
    try {
      assert.equal(command, python);
      regular(python);
      assert.equal(sha(fs.readFileSync(python)), pythonHash);
      assert.deepEqual(argv, ['-I', '-S', reader, request, sid, attempt, manifestHash]);
      assert.deepEqual(Object.keys(options).sort(), ['encoding', 'env', 'maxBuffer', 'shell', 'stdio', 'timeout']);
      assert.equal(options.shell, false);
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.timeout, 30000);
      assert.equal(options.maxBuffer, 8 * 1024 * 1024);
      assert.deepEqual(options.env, readerEnv);
      assert.equal(options.stdio.length, 4);
      assert.deepEqual(options.stdio.slice(0, 3), ['ignore', 'pipe', 'pipe']);
      assert(Number.isInteger(options.stdio[3]) && options.stdio[3] >= 0);
      const fd = fs.fstatSync(options.stdio[3]), st = fs.lstatSync(root);
      assert(fd.isDirectory() && st.isDirectory());
      assert.equal(fs.realpathSync(root), root);
      assert.equal(fd.dev, st.dev); assert.equal(fd.ino, st.ino); assert.equal(fd.uid, process.getuid());
      assert.equal(fd.mode & 0o077, 0);
      const enforced = { ...options, timeout: budget(), maxBuffer: limit, killSignal: 'SIGKILL' };
      return saveCall(command, argv, enforced, { timeout: options.timeout, maxBuffer: options.maxBuffer,
        killSignal: options.killSignal ?? null }, 'reader');
    } catch (error) {
      unexpected.push({ ...invocation, error: error.message });
      throw error;
    }
  };
  const reg = args => {
    regular(python);
    assert.equal(sha(fs.readFileSync(python)), pythonHash);
    assert(['begin-delivery', 'report-list', 'report-event', 'set-lifecycle'].includes(args[0]));
    const result = saveCall(python, ['-I', '-S', registry, ...args], { cwd: base, env,
      shell: false, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: budget(),
      maxBuffer: limit, killSignal: 'SIGKILL' }, null, 'registry');
    assert.ifError(result.error); assert.equal(result.signal, null);
    assert(Buffer.byteLength(result.stdout) <= limit && Buffer.byteLength(result.stderr) <= limit);
    return result;
  };
  const expect = (result, status = 0, resultName) => {
    assert.equal(result.status, status, result.stdout + (result.stderr ?? ''));
    const value = JSON.parse(result.stdout);
    if (resultName) assert.equal(value.result, resultName);
    assert.equal(value.completion_fact, null);
    return value;
  };
  const trap = method => () => { externalCalls.push(method); throw Error(`forbidden external call: ${method}`); };
  const deps = { stateDir, sessionsRoot, orchestratorSid: 'synthetic-controller',
    registry: { list: args => reg(['report-list', ...args]), event: args => reg(['report-event', ...args]) },
    telepty: { list: trap('telepty.list'), inject: trap('telepty.inject'), injects: trap('telepty.injects') },
    pidAlive: trap('pidAlive'), clock: { nowMs: () => now }, policy: { ...decisions.DEFAULT_POLICY } };
  const raw = () => fs.readFileSync(path.join(stateDir, 'active.json'), 'utf8');
  const record = () => JSON.parse(raw()).dispatches.find(row => row.dispatch_id === did);
  const rows = (args = ['--all']) => {
    const result = deps.registry.list(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim() ? result.stdout.trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const write = (kind, seq, text, overrides) => {
    const data = bytes(kind, seq, text, overrides), file = path.join(dir, `${kind}-${seq}.md`);
    fs.writeFileSync(file + '.tmp', data, { flag: 'wx', mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
    return { file, bytes: data, sha: sha(data), key: `${kind}-${seq}` };
  };
  const capture = (options = {}) => {
    captureCallStart = calls.length;
    const result = pump.pumpOnce(deps, { captureOnly: true, ...options });
    assert.equal(result.ok, true);
    assert.equal(result.notices, 0);
    assert.deepEqual(externalCalls, []);
    assert.deepEqual(processFailures, []);
    assert.deepEqual(unexpected.filter(entry => !entry.guard), []);
    return result;
  };
  const ack = (item, verdict, status = 0, resultName, digest) => {
    const sub = item.startsWith('failure-') ? record().report.failures[Number(item.slice(8)) - 1] : record().report.items[item];
    return expect(pump.reportAck({ dispatchId: did, item, sha256: digest ?? sub.sha256 ?? sub.subject_sha256,
      verdict, byClaimed: 'synthetic-controller' }, deps), status, resultName);
  };
  const positive = (item, result, count = 1) => {
    assert.equal(result.captured, count);
    assert.equal(result.captureFailed, 0);
    const sub = record().report.items[item.key];
    assert.equal(sub.sha256, item.sha);
    assert(fs.readFileSync(sub.inbox).equals(item.bytes));
    assert(calls.slice(captureCallStart).some(c => c.role === 'reader' && c.status === 0 && c.error === null),
      'this positive capture must invoke the real reader');
  };
  try {
    process.chdir(base);
    process.env.AIGENTRY_REPORT_PYTHON = python;
    childProcess.spawnSync = adapter;
    syncBuiltinESMExports();
    const ref = path.join(base, 'synthetic-dispatch.md');
    const refBytes = Buffer.from(`Synthetic ${label} dispatch; no worker launched.\n`);
    fs.writeFileSync(ref, refBytes, { flag: 'wx', mode: 0o600 });
    did = expect(reg(['begin-delivery', '--sid', sid, '--ref-hash', sha(refBytes), '--ref-path', ref,
      '--cwd', target, '--from', 'synthetic-controller', '--track', 'synthetic-ir', '--role', 'tester', '--now', iso(now),
      '--attempt', attempt, '--manifest-sha256', manifestHash, '--report-request-id', request,
      '--report-challenge-sha256', sha(challenge)]), 0, 'proceed').dispatch_id;
    const originalOutcome = structuredClone(record().outcome);
    await body({ base, root, dir, sid, request, attempt, manifestHash, challenge, deps, calls, unexpected,
      bytes, write, raw, record, rows, reg, expect, ack, capture, positive,
      report: () => record().report, readerCalls: () => calls.filter(c => c.role === 'reader').length,
      setNow: value => { now = value; },
      failure: () => expect(deps.registry.event(['--dispatch-id', did, '--kind', 'failure', '--item', 'overdue',
        '--field', 'stage=confirm', '--field', 'detail=synthetic failure control', '--now', iso(now)])),
      guardCheck: () => {
        const before = calls.length;
        guard = true;
        try { assert.throws(() => childProcess.spawnSync('/not-an-admitted-executable', [], {})); }
        finally { guard = false; }
        assert.equal(calls.length, before, 'guard must not launch a child');
        assert.equal(unexpected.filter(entry => entry.guard).length, 1);
      } });
    assert.deepEqual(record().outcome, originalOutcome);
    assert.deepEqual(record().transport, { result: 'unknown', inject_id: null, at: null });
    assert.deepEqual(fs.readdirSync(target), [], 'no target/work execution');
    assert.deepEqual(externalCalls, []);
    assert.deepEqual(processFailures, []);
    assert.deepEqual(unexpected.filter(entry => !entry.guard), []);
    budget();
  } finally {
    childProcess.spawnSync = oldSpawn;
    syncBuiltinESMExports();
    if (oldPython === undefined) delete process.env.AIGENTRY_REPORT_PYTHON;
    else process.env.AIGENTRY_REPORT_PYTHON = oldPython;
    process.chdir(oldCwd);
    fs.writeFileSync(path.join(base, 'calls.json'), JSON.stringify({ calls, unexpected, processFailures, externalCalls,
      elapsedSuiteMs: performance.now() - started }, null, 2), { flag: 'wx', mode: 0o600 });
  }
}

test('IR1 preliminary accepted REPORT resolves only its report obligation', { concurrency: false }, async () => {
  await fixture('ir1', w => {
    const first = w.write('REPORT', 1, 'Preliminary amendment received; work remains.');
    w.positive(first, w.capture());
    assert.equal(w.report().resolution, 'open');
    const reviewed = w.ack(first.key, 'accepted');
    assert.equal(reviewed.completion_fact, null);
    assert.equal(reviewed.resolution, 'done');
    assert.equal(w.report().current_final, first.key);
    assert.deepEqual(w.report().failures, []);
  });
});

test('IR2 late valid items are excluded by both terminal selection gates', { concurrency: false }, async () => {
  await fixture('ir2', w => {
    const first = w.write('REPORT', 1, 'Preliminary amendment');
    w.positive(first, w.capture());
    w.ack(first.key, 'accepted');
    for (const [kind, seq] of [['HOLD', 2], ['REPORT', 3], ['HOLD', 4]]) {
      const item = w.write(kind, seq, 'Complete late evidence');
      assert.equal(envelope.parseItem(item.bytes, { requestId: w.request,
        challengeSha256: sha(w.challenge), kind, seq }).ok, true);
    }
    const before = w.raw(), readerCount = w.readerCalls();
    const result = w.capture();
    assert.deepEqual([result.rows, result.captured, result.captureFailed], [0, 0, 0]);
    const sid = pump.captureForSid(w.sid, w.deps);
    assert.deepEqual(sid, { ok: true, records: 0, captured: 0, failed: 0, errors: [] });
    assert.deepEqual(w.rows([]), []);
    assert.deepEqual(w.rows(['--sid', w.sid]), []);
    const [done] = w.rows();
    assert.equal(done.report.resolution, 'done');
    assert.equal(decisions.inScanSet(done, T0, w.deps.policy), false);
    const original = w.deps.registry.list;
    w.deps.registry.list = args => { assert.deepEqual(args, []); return { status: 0, stdout: JSON.stringify(done) + '\n' }; };
    try {
      const explicit = w.capture();
      assert.deepEqual([explicit.rows, explicit.captured, explicit.captureFailed], [1, 0, 0]);
    } finally { w.deps.registry.list = original; }
    assert.equal(w.readerCalls(), readerCount, 'selection prevents reader invocation, not an authentication refusal');
    assert.equal(w.raw(), before);
  });
});

test('IR3 unreviewed preliminary permits final capture and pending HOLD disposition', { concurrency: false }, async () => {
  await fixture('ir3', w => {
    const first = w.write('REPORT', 1, 'Preliminary amendment');
    w.positive(first, w.capture());
    w.write('HOLD', 2, 'Question one');
    const final = w.write('REPORT', 3, 'Final scoped evidence');
    w.write('HOLD', 4, 'Question two');
    w.positive(final, w.capture(), 3);
    assert.equal(w.report().current_final, final.key);
    assert.equal(w.report().items[first.key].superseded_by, final.key);
    assert.equal(w.report().items[first.key].review, null);
    for (const key of ['HOLD-2', 'HOLD-4']) assert.equal(w.report().items[key].review, null);
    assert.equal(w.ack(final.key, 'accepted').resolution, 'open');
    assert.equal(w.ack('HOLD-2', 'answered').resolution, 'open');
    assert.equal(w.ack('HOLD-4', 'answered').resolution, 'done');
    const before = w.raw();
    w.ack(final.key, 'accepted', 8, 'duplicate');
    assert.equal(w.raw(), before);
    w.ack(final.key, 'rework', 4, 'STALE_SUBJECT');
    assert.equal(w.raw(), before);
    w.ack(first.key, 'accepted', 4, 'STALE_SUBJECT');
    assert.equal(w.raw(), before);
    w.ack(final.key, 'accepted', 4, 'STALE_SUBJECT', 'f'.repeat(64));
    assert.equal(w.raw(), before);
  });
});

test('IR4 eligible controls and authenticated refusals retain sequence and byte identity', { concurrency: false }, async () => {
  await fixture('ir4', w => {
    w.guardCheck();
    // IR4a/b: eligible open capture and same-byte pump/registry duplicate.
    const first = w.write('REPORT', 1, 'First');
    w.positive(first, w.capture());
    let before = w.raw();
    assert.equal(w.capture().captured, 0);
    assert.equal(w.raw(), before);
    const captured = w.report().items[first.key];
    w.expect(w.deps.registry.event(['--dispatch-id', w.record().dispatch_id, '--kind', 'captured', '--item', first.key,
      '--sha256', first.sha, '--field', `bytes=${first.bytes.length}`, '--field', `inbox=${captured.inbox}`, '--now', iso(T0)]), 8, 'duplicate');
    assert.equal(w.raw(), before);
    // IR4c: changed same-key bytes produce conflict; original inbox/hash remains.
    w.write('REPORT', 1, 'Changed after capture');
    assert.equal(w.capture().captured, 0);
    assert.equal(w.report().failures.at(-1).event, 'item_conflict');
    assert.equal(w.report().failures.at(-1).key, first.key);
    assert.equal(w.report().items[first.key].sha256, first.sha);
    assert(fs.readFileSync(captured.inbox).equals(first.bytes));
    before = w.raw();
    w.expect(w.deps.registry.event(['--dispatch-id', w.record().dispatch_id, '--kind', 'captured', '--item', first.key,
      '--sha256', sha(w.bytes('REPORT', 1, 'Changed after capture')), '--field', 'bytes=100',
      '--field', `inbox=${captured.inbox}`, '--now', iso(T0)]), 4, 'item_conflict');
    assert.equal(w.raw(), before);
    w.ack('failure-1', 'seen');
    assert.equal(w.ack(first.key, 'rework').resolution, 'rework_requested');
    // IR4d: rework is eligible; a late lower sequence cannot become final.
    const higher = w.write('REPORT', 3, 'Revised final');
    w.positive(higher, w.capture());
    assert.equal(w.report().current_final, higher.key);
    assert.equal(w.report().items[first.key].review.verdict, 'rework', 'reviewed history remains immutable');
    const lower = w.write('REPORT', 2, 'Late lower sequence');
    w.positive(lower, w.capture());
    assert.equal(w.report().items[lower.key].superseded_by, higher.key);
    assert.equal(w.report().current_final, higher.key);
    // IR4e: lifecycle retirement does not remove an open bound obligation.
    const retired = w.reg(['set-lifecycle', '--sid', w.sid, '--state', 'cleaned', '--all', '--now', iso(T0)]);
    assert.equal(retired.status, 0, retired.stdout + retired.stderr);
    assert.equal(w.record().lifecycle.state, 'cleaned');
    const hold = w.write('HOLD', 5, 'Retired but still owed');
    w.positive(hold, w.capture());
    // IR4f-i: complete but unauthenticated/mismatched items are explicit refusals.
    const invalid = [
      ['wrong_request', 6, { request: randomUUID() }],
      ['bad_challenge', 7, { challenge: 'wrong-synthetic-challenge' }],
      ['name_mismatch', 8, {}],
      ['bad_end', 9, { footerSeq: 10 }],
    ];
    for (const [code, seq, overrides] of invalid) {
      const item = w.write('HOLD', seq, 'Refusal control', overrides);
      if (code === 'name_mismatch') fs.writeFileSync(item.file, w.bytes('HOLD', 10, 'Wrong filename'));
      const count = w.readerCalls();
      const result = w.capture();
      assert.equal(result.captured, 0);
      assert(result.errors[w.record().dispatch_id].includes(`item_${code}`));
      assert(w.readerCalls() > count, 'authentication refusal follows actual reader admission');
      assert.equal(w.report().items[item.key], undefined);
      const failure = w.report().failures.at(-1);
      assert.equal(failure.event, 'item_invalid');
      assert.equal(failure.key, item.key);
      fs.unlinkSync(item.file);
    }
    // IR4j: neither incomplete named file nor unfinished .tmp is captured.
    const partial = path.join(w.dir, 'HOLD-11.md');
    const complete = w.bytes('HOLD', 11, 'Eventually complete');
    fs.writeFileSync(partial, complete.subarray(0, 40), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(partial + '.tmp', complete, { flag: 'wx', mode: 0o600 });
    before = w.raw();
    assert.equal(w.capture().captured, 0);
    assert.equal(w.raw(), before);
    fs.renameSync(partial + '.tmp', partial);
    w.positive({ key: 'HOLD-11', bytes: complete, sha: sha(complete) }, w.capture());
  });
  // IR4k/l: actual sealed-path validation refuses bad digest and attempt identity.
  for (const [label, variant, error] of [
    ['ir4-manifest', { wrongManifest: true }, 'chain_sandbox_manifest_changed'],
    ['ir4-attempt', { wrongAttempt: true }, 'chain_agent_binding_manifest'],
  ]) await fixture(label, w => {
    w.write('REPORT', 1, 'Must not be captured');
    const result = w.capture();
    assert.equal(result.captured, 0);
    assert(result.captureFailed > 0);
    assert(result.errors[w.record().dispatch_id].includes(error));
    assert.deepEqual(w.report().items, {});
    assert.equal(w.readerCalls(), 0, 'sealed binding refusal precedes reader');
  }, variant);
});

test('IR5 review kinds and pending failures cannot substitute for final acceptance', { concurrency: false }, async () => {
  await fixture('ir5-review', w => {
    const hold = w.write('HOLD', 1, 'Question');
    const turnBody = `end=stop\nturn=1\nsession=synthetic-turn\nassoc=exact\nbefore=-\nafter=-\nat=${iso(T0)}\n` +
      'observed_by=hook\n-----BEGIN UNTRUSTED-----\n\n-----END UNTRUSTED-----';
    w.write('TURN', 1, turnBody);
    w.positive(hold, w.capture(), 2);
    w.ack(hold.key, 'answered');
    w.ack('TURN-1', 'seen');
    assert.equal(w.report().current_final, null);
    assert.equal(w.report().resolution, 'open');
    const final = w.write('REPORT', 2, 'Final');
    w.positive(final, w.capture());
    const before = w.raw();
    w.ack(final.key, 'seen', 4, 'invalid_verdict');
    assert.equal(w.raw(), before);
    w.failure();
    assert.equal(w.ack(final.key, 'accepted').resolution, 'open');
    assert.equal(w.ack('failure-1', 'seen').resolution, 'done');
  });
  for (const [label, delta, eligible] of [
    ['ir5-boundary', 7 * DAY, true], ['ir5-expired', 7 * DAY + 1, false],
  ]) await fixture(label, w => {
    w.failure();
    assert.equal(w.ack('failure-1', 'seen').resolution, 'failed_seen');
    w.setNow(T0 + delta);
    const late = w.write('REPORT', 1, 'Late final');
    const [row] = w.rows();
    assert.equal(decisions.inScanSet(row, T0 + delta, w.deps.policy), eligible);
    const before = w.raw();
    const result = w.capture();
    assert.equal(result.rows, 1, 'registry retains failed_seen; independent scan window decides');
    if (eligible) {
      w.positive(late, result);
      assert.equal(w.report().resolution, 'open');
    } else {
      assert.equal(result.captured, 0);
      assert.equal(result.captureFailed, 0);
      assert.equal(w.readerCalls(), 0);
      assert.equal(w.raw(), before);
    }
  });
});
