// Authored for separately admitted execution against the freshly built candidate.
// Required: LEGACY_RECOVERY_TEST_PACKAGE, LEGACY_RECOVERY_TEST_MANIFEST (files:
// path/bytes/sha256), LEGACY_RECOVERY_TEST_ROOT (existing private non-Git parent),
// LEGACY_RECOVERY_TEST_DEADLINE_MS (canonical absolute wrapper epoch deadline).
// No compiler, setup command, product mock, successful import stub or supplied
// historical generated output. Evidence/fixtures are retained, never cleaned up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';

const INPUT_BYTES = 48 * 1024 * 1024, STREAM_BYTES = 1024 * 1024;
const CLOSE_MS = 5000, FINAL_MS = 5000;
let budget;
function boundary(label, final = budget?.finalizing ?? false) {
  assert.ok(budget, 'deadline must be initialized before fixture work');
  const now = Number(process.hrtime.bigint()) / 1e6;
  if (!Number.isFinite(now) || now < budget.last || now >= budget.end - (final ? 0 : CLOSE_MS + FINAL_MS)) {
    budget.failure ??= `deadline/clock failure at ${label}`;
    throw new Error(budget.failure);
  }
  budget.last = now;
  if (budget.failure && !final) throw new Error(budget.failure);
  return now;
}
function initializeBudget() {
  const raw = process.env.LEGACY_RECOVERY_TEST_DEADLINE_MS;
  assert.match(raw ?? '', /^[1-9][0-9]*$/, 'canonical absolute wrapper deadline required');
  const deadline = Number(raw), wall = Date.now(), mono = Number(process.hrtime.bigint()) / 1e6;
  assert.ok(Number.isSafeInteger(deadline) && Number.isSafeInteger(wall) && Number.isFinite(mono));
  const allowance = Math.min(170000, deadline - wall);
  assert.ok(allowance > CLOSE_MS + FINAL_MS, 'expired/insufficient wrapper budget');
  budget = { deadline, wall, start: mono, last: mono, end: mono + allowance, allowance, failure: null };
}
const sha = bytes => {
  boundary('hash');
  const hash = createHash('sha256').update(bytes).digest('hex');
  boundary('hash complete');
  return hash;
};
function hashFile(file, final = false, maxBytes = Infinity) {
  boundary('file hash', final);
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      boundary('file hash chunk', final);
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      bytes += n;
      assert.ok(bytes <= maxBytes, 'file grew beyond hash input bound');
      hash.update(chunk.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  boundary('file hash complete', final);
  return hash.digest('hex');
}
const safeRelative = p => typeof p === 'string' && p && !p.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(p) && !path.posix.isAbsolute(p) &&
  p.split('/').every(part => part && part !== '.' && part !== '..');
function canonicalDirectory(dir, privateRoot = false) {
  boundary('directory admission');
  assert.ok(typeof dir === 'string' && path.isAbsolute(dir) && path.normalize(dir) === dir &&
    dir !== path.parse(dir).root && !dir.endsWith(path.sep), 'explicit canonical directory required');
  assert.equal(fs.realpathSync(dir), dir);
  for (let current = dir; ; current = path.dirname(current)) {
    boundary('directory ancestor');
    const s = fs.lstatSync(current);
    assert.ok(s.isDirectory() && !s.isSymbolicLink() &&
      (s.uid === 0 || s.uid === process.getuid()) && (s.mode & 0o022) === 0, current);
    if (current === path.dirname(current)) break;
  }
  if (privateRoot) {
    const s = fs.lstatSync(dir);
    assert.equal(s.uid, process.getuid());
    assert.equal(s.mode & 0o777, 0o700);
  }
}
function regular(root, rel) {
  boundary('regular file admission');
  assert.ok(safeRelative(rel));
  const file = path.join(root, rel);
  canonicalDirectory(path.dirname(file));
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1, rel);
  assert.ok(s.size <= 8 * 1024 * 1024, 'per-file fixture input bound');
  return { file, stat: s };
}
function snapshot(root) {
  const images = {};
  let count = 0, bytes = 0, metadataBytes = 2;
  function visit(file, rel) {
    boundary('snapshot entry');
    assert.ok(++count <= 4096, 'snapshot entry bound');
    const s = fs.lstatSync(file, { bigint: true });
    const type = s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'link' : 'unknown';
    const metadata = { type, mode: Number(s.mode & 0o7777n) };
    // atime is deliberately excluded: the oracle itself reads files/directories.
    for (const key of ['dev', 'ino', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']) metadata[key] = String(s[key]);
    let content = null;
    if (s.isFile() || s.isSymbolicLink()) {
      assert.ok(s.size <= 8n * 1024n * 1024n, 'snapshot per-file bound');
      bytes += Number(s.size);
      assert.ok(bytes <= INPUT_BYTES, 'snapshot total bytes bound');
      content = s.isFile() ? hashFile(file, false, Number(s.size)) : fs.readlinkSync(file);
    }
    images[rel] = { ...metadata, content };
    metadataBytes += Buffer.byteLength(JSON.stringify({ [rel]: images[rel] }));
    assert.ok(metadataBytes <= STREAM_BYTES, 'snapshot serialized metadata bound');
    if (s.isDirectory()) {
      const dir = fs.opendirSync(file);
      try {
        for (let entry; (entry = dir.readSync()) !== null;) {
          boundary('snapshot directory');
          visit(path.join(file, entry.name), rel === '.' ? entry.name : `${rel}/${entry.name}`);
        }
      } finally { dir.closeSync(); }
    }
    boundary('snapshot entry complete');
  }
  visit(root, '.');
  return images;
}
let retainedBytes = 0;
function retain(file, bytes, terminal = false) {
  boundary('retain evidence', true);
  const size = Buffer.byteLength(bytes);
  assert.ok(retainedBytes + size <= INPUT_BYTES - (terminal ? 0 : 64 * 1024), 'retained evidence bound');
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  retainedBytes += size;
  boundary('evidence retained', true);
}
const writeJSON = (file, value, terminal = false) => retain(file, JSON.stringify(value, null, 2) + '\n', terminal);

test('actual public legacy recovery plan is read-only evidence', async t => {
  initializeBudget();
  assert.ok(['darwin', 'linux'].includes(process.platform), 'current inspector platform contract');
  const source = process.env.LEGACY_RECOVERY_TEST_PACKAGE;
  const manifestFile = process.env.LEGACY_RECOVERY_TEST_MANIFEST;
  const parent = process.env.LEGACY_RECOVERY_TEST_ROOT;
  canonicalDirectory(source);
  canonicalDirectory(parent, true);
  for (let dir = parent; ; dir = path.dirname(dir)) {
    assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'fixtures must be outside Git');
    if (dir === path.dirname(dir)) break;
  }
  assert.ok(manifestFile && path.isAbsolute(manifestFile));
  const manifestStat = fs.lstatSync(manifestFile);
  assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= 1024 * 1024);
  const manifestBytes = fs.readFileSync(manifestFile);
  boundary('manifest read complete');
  const manifest = JSON.parse(manifestBytes);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096);
  const paths = new Set(), frozen = {};
  let bytes = 0;
  for (const entry of manifest.files) {
    boundary('manifest entry');
    assert.ok(safeRelative(entry.path) && !paths.has(entry.path), 'unique bounded fixture paths');
    assert.ok(entry.path === 'package.json' || /^(?:bin|docs|tooling|git-hooks|\.agents|\.claude|dist\/src|node_modules)\//.test(entry.path) ||
      ['AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE', 'src/orchestrator-boot/cli.ts', 'src/orchestrator-boot/usage.ts'].includes(entry.path));
    paths.add(entry.path);
    const { file, stat } = regular(source, entry.path);
    assert.ok(bytes + stat.size <= INPUT_BYTES, 'single package copy input bound before read');
    const content = fs.readFileSync(file);
    assert.equal(content.length, entry.bytes, entry.path);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.equal(sha(content), entry.sha256, entry.path);
    bytes += content.length;
    frozen[entry.path] = { hash: entry.sha256, mode: stat.mode & 0o777, bytes: content.length };
  }
  assert.ok(bytes <= 48 * 1024 * 1024, 'single package copy input bound; no OS quota claim');
  assert.ok(paths.has('package.json') && paths.has('bin/init/manifest.mjs'));
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin['aigentry-orchestrator'], 'bin/init/cli.mjs');
  // This imports the actual admitted manifest owner, not an alternate init.
  const { MANIFEST, TEMPLATE_TOKENS, isSubstitutionExempt } =
    await import(pathToFileURL(path.join(source, 'bin/init/manifest.mjs')).href);
  boundary('manifest owner import complete');
  for (const rel of MANIFEST) assert.ok(paths.has(rel), `missing shipped leaf: ${rel}`);
  const compiled = [];
  let productionEntries = 0;
  function production(dir, prefix) {
    const directory = fs.opendirSync(dir);
    try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      boundary('production closure entry');
      assert.ok(++productionEntries <= 4096, 'production closure entry bound');
      const name = entry.name;
      const file = path.join(dir, name), rel = prefix + name, s = fs.lstatSync(file);
      assert.ok(!s.isSymbolicLink());
      if (s.isDirectory()) production(file, rel + '/');
      else if (name.endsWith('.js')) { assert.ok(s.isFile()); compiled.push(rel); assert.ok(compiled.length <= 4096); }
    }
    } finally { directory.closeSync(); }
  }
  production(path.join(source, 'dist/src'), 'dist/src/');
  assert.ok(compiled.length > 0);
  for (const rel of compiled) assert.ok(paths.has(rel), `missing compiled production leaf: ${rel}`);
  for (const required of ['storage', 'bootstrap']) assert.ok(paths.has(`dist/src/environment/${required}.js`));
  // Fixture dependency package context is supplied by the admitted manifest.
  // Do not resolve against or inspect arbitrary host node_modules.
  const external = new Set();
  for (const rel of compiled) {
    boundary('compiled import census');
    const code = fs.readFileSync(path.join(source, rel), 'utf8');
    const imports = [
      ...code.matchAll(/^\s*(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?(["'])([^"'\n]+)\1/gm),
      ...code.matchAll(/\b(?:import|require)\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g),
    ].map(m => m[2]);
    for (const name of imports) {
      if (name.startsWith('node:') || builtinModules.includes(name)) continue;
      if (name.startsWith('.')) {
        assert.ok(paths.has(path.posix.normalize(path.posix.join(path.posix.dirname(rel), name))), `${rel}: ${name}`);
      } else if (/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w./-]+)?$/.test(name)) {
        const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
        external.add(packageName);
        assert.ok(paths.has(`node_modules/${packageName}/package.json`), `external package context missing: ${packageName}`);
      }
    }
  }
  // Copy *all* supplied dependency leaves. The upstream admitted manifest is
  // responsible for computed imports and complete external package closures;
  // the literal check above is an additional omission check, not that authority.
  boundary('fixture root creation');
  const run = fs.mkdtempSync(path.join(parent, 'legacy-recovery-'));
  fs.chmodSync(run, 0o700);
  const data = path.join(run, 'data'), evidence = path.join(run, 'evidence');
  for (const dir of [data, evidence]) fs.mkdirSync(dir, { mode: 0o700 });
  const packageRoot = path.join(data, 'package');
  fs.mkdirSync(packageRoot, { mode: 0o700 });
  for (const entry of manifest.files) {
    boundary('copy entry');
    const file = path.join(packageRoot, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, entry.path), file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, frozen[entry.path].mode);
    assert.equal(sha(fs.readFileSync(file)), entry.sha256);
  }
  writeJSON(path.join(evidence, 'custody.json'), { source, manifest: manifestFile, manifestHash: sha(manifestBytes),
    packageName: pkg.name, packageVersion: pkg.version, compiled, external: [...external], frozen });
  const node = fs.realpathSync(process.execPath), nodeBefore = hashFile(node);
  let counter = 0;
  function fixture() {
    boundary('fixture creation');
    const base = fs.mkdtempSync(path.join(data, 'case-'));
    fs.chmodSync(base, 0o700);
    const f = { base };
    for (const name of ['workspace', 'home', 'userhome', 'tmp', 'xdg', 'ports', 'unrelated']) {
      f[name] = path.join(base, name);
      fs.mkdirSync(f[name], { mode: 0o700 });
    }
    fs.writeFileSync(path.join(f.unrelated, 'retain'), 'unrelated sentinel\n', { mode: 0o640 });
    f.env = { HOME: f.userhome, USERPROFILE: f.userhome, AIGENTRY_HOME: f.home,
      TMPDIR: f.tmp, XDG_CONFIG_HOME: f.xdg, XDG_DATA_HOME: f.xdg, XDG_CACHE_HOME: f.xdg,
      PATH: f.ports, LANG: 'C', LC_ALL: 'C' };
    return f;
  }
  async function invoke(f, extras = [], env = {}, workspace = f.workspace) {
    boundary('invoke admission');
    const id = String(++counter);
    const args = [path.join(packageRoot, 'bin/init/cli.mjs'), 'init', '--legacy-recovery-plan', '--workspace', workspace, ...extras];
    const before = snapshot(data);
    writeJSON(path.join(evidence, `${id}-before.json`), before);
    const started = Date.now();
    const launchedAt = boundary('child launch');
    const timeoutMs = Math.min(10000, Math.floor(budget.end - CLOSE_MS - FINAL_MS - launchedAt));
    if (timeoutMs < 1) budget.failure ??= 'insufficient child work allowance';
    assert.ok(timeoutMs >= 1, 'insufficient child work allowance');
    const receipt = { node, nodeHash: nodeBefore, args, env: { ...f.env, ...env }, cwd: f.base,
      started, launchedAt, limits: { timeoutMs, closeMs: CLOSE_MS, finalMs: FINAL_MS,
        maxBuffer: STREAM_BYTES, shell: false, aggregateMs: budget.allowance },
      events: [], failures: [], exit: null, close: null, streams: {
        stdout: { bytes: 0, eof: false, closed: false }, stderr: { bytes: 0, eof: false, closed: false } } };
    const r = await new Promise(resolve => {
      const chunks = { stdout: [], stderr: [] };
      let child, finished = false, killAttempted = false, runtimeTimer, closeTimer;
      const stamp = () => Number(process.hrtime.bigint()) / 1e6;
      const event = (kind, detail = {}) => { if (!finished) receipt.events.push({ kind, at: stamp(), ...detail }); };
      const fail = reason => {
        if (finished) return;
        if (!receipt.failures.includes(reason)) receipt.failures.push(reason);
        budget.failure ??= reason;
      };
      function finish() {
        if (finished) return;
        if (stamp() > launchedAt + timeoutMs) fail('child runtime/drain deadline exceeded');
        if (receipt.exit?.signal) fail('child terminated by signal');
        if (!receipt.exit || !receipt.close ||
            Object.values(receipt.streams).some(s => !s.eof || !s.closed)) fail('incomplete child/stream closure');
        finished = true;
        clearTimeout(runtimeTimer); clearTimeout(closeTimer);
        t.signal.removeEventListener('abort', abort);
        receipt.finishedAt = stamp();
        const stdoutBytes = Buffer.concat(chunks.stdout), stderrBytes = Buffer.concat(chunks.stderr);
        resolve({ status: receipt.exit?.code ?? null, signal: receipt.exit?.signal ?? null,
          error: receipt.failures.length ? new Error(receipt.failures.join('; ')) : undefined,
          stdoutBytes, stderrBytes, stdout: stdoutBytes.toString('utf8'), stderr: stderrBytes.toString('utf8') });
      }
      function stop(reason) {
        if (finished) return;
        fail(reason);
        if (!killAttempted && child && !receipt.exit && child.pid &&
            child.exitCode === null && child.signalCode === null) {
          killAttempted = true;
          try {
            const sent = child.kill('SIGKILL');
            event('kill', { signal: 'SIGKILL', sent });
            if (!sent) fail('kill returned false');
          } catch (error) { event('kill-error', { error: String(error) }); fail('kill failed'); }
        }
      }
      function abort() { stop('suite aborted'); }
      if (t.signal.aborted) { fail('suite aborted before spawn'); finish(); return; }
      t.signal.addEventListener('abort', abort, { once: true });
      try {
        child = spawn(node, args, { cwd: f.base, env: receipt.env, shell: false,
          detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { event('spawn-throw', { error: String(error) }); fail('spawn threw'); finish(); return; }
      child.on('spawn', () => event('spawn'));
      child.on('error', error => { event('child-error', { error: String(error), code: error.code }); stop('child error'); });
      child.on('exit', (code, signal) => { receipt.exit = { code, signal, at: stamp() }; event('exit', { code, signal }); });
      child.on('close', (code, signal) => { receipt.close = { code, signal, at: stamp() }; event('close', { code, signal }); finish(); });
      for (const name of ['stdout', 'stderr']) {
        const stream = child[name], state = receipt.streams[name];
        stream.on('data', chunk => {
          if (finished) return;
          const room = Math.max(0, STREAM_BYTES - state.bytes);
          if (room) chunks[name].push(chunk.subarray(0, room));
          state.bytes += chunk.length;
          if (state.bytes > STREAM_BYTES) stop(`${name} overflow`);
        });
        stream.on('end', () => { state.eof = true; event(`${name}-eof`); });
        stream.on('close', () => { state.closed = true; event(`${name}-close`); });
        stream.on('error', error => { event(`${name}-error`, { error: String(error) }); stop(`${name} error`); });
      }
      runtimeTimer = setTimeout(() => stop('child runtime/drain timeout'), Math.max(1, launchedAt + timeoutMs - stamp()));
      // No synchronous/descendant guarantee: the wrapper owns the outer ceiling.
      closeTimer = setTimeout(() => {
        stop('child close deadline');
        for (const name of ['stdout', 'stderr']) {
          try { child[name].destroy(); event(`${name}-destroy`); }
          catch (error) { event(`${name}-destroy-error`, { error: String(error) }); fail(`${name} destroy failed`); }
        }
        finish(); // Explicitly records any unobserved close/EOF, never a pass.
      }, Math.max(1, Math.min(budget.end - FINAL_MS, launchedAt + timeoutMs + CLOSE_MS) - stamp()));
    });
    let after;
    try {
      retain(path.join(evidence, `${id}.stdout`), r.stdoutBytes);
      retain(path.join(evidence, `${id}.stderr`), r.stderrBytes);
      if (!r.error) {
        after = snapshot(data);
        writeJSON(path.join(evidence, `${id}-after.json`), after);
      }
    } catch (error) {
      budget.failure ??= `partial evidence: ${error.message}`;
      receipt.failures.push(`partial evidence: ${error.message}`);
      throw error;
    } finally {
      writeJSON(path.join(evidence, `${id}-child.json`), { ...receipt,
        elapsedMs: Date.now() - started, status: r.status, signal: r.signal,
        evidenceComplete: Boolean(after), budgetFailure: budget.failure }, true);
    }
    assert.equal(r.error, undefined, r.stderr);
    assert.ok(after, 'partial evidence cannot pass');
    assert.deepEqual(after, before, 'all fixture bytes and modes unchanged');
    assert.equal(r.signal, null, r.stderr);
    assert.equal(r.stderr, '');
    const value = JSON.parse(r.stdout);
    assert.equal(value.mutating_recovery_admitted, false);
    assert.equal(value.evidence_only, true);
    assert.equal(value.reusable_as_capability, false);
    assert.equal(value.source_plan_complete, false);
    return { r, value };
  }
  const planned = result => { assert.equal(result.r.status, 0); assert.equal(result.value.status, 'planned'); return result.value; };
  const refused = (result, reason) => {
    assert.equal(result.value.reason, reason, 'source-grounded causal refusal');
    assert.equal(result.r.status, 4);
    assert.equal(result.value.status, 'refused');
    assert.equal(result.value.package_rendering_complete, false);
    assert.equal(result.value.package_leaves, undefined, 'refusal never emits partial or denied hashes');
  };

  try {
  await t.test('frozen final package rendering, raw copies and unavailable owner contracts', async () => {
    const f = fixture();
    // Present targets are opaque existing bytes, never desired source content.
    const present = [
      [f.workspace, 'bin/ask.sh'], [f.workspace, '.claude/skills/orchestrate-turn/SKILL.md'],
      [f.home, 'CONSTITUTION.md'], [f.home, 'instructions/common.md'],
    ];
    const targetBefore = new Map();
    for (const [root, rel] of present) {
      boundary('positive target fixture');
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, 'existing opaque target\n', { mode: 0o640 });
      const s = fs.lstatSync(file);
      targetBefore.set(file, { present: true, mode: s.mode & 0o777, bytes: s.size });
    }
    const value = planned(await invoke(f));
    assert.equal(value.version, 1);
    assert.equal(value.package_rendering_complete, true);
    assert.deepEqual(value.package_leaves.map(l => l.path), MANIFEST);
    const replacements = {
      '{{CONSTITUTION_PATH}}': path.join(f.home, 'CONSTITUTION.md'),
      '{{CONTROL_WORKSPACE}}': f.workspace, '{{DEVICE_ID}}': `device-${os.hostname()}`,
      '{{CREATED_AT}}': value.rendering.created_at,
    };
    assert.equal(new Date(value.rendering.created_at).toISOString(), value.rendering.created_at);
    assert.equal(value.rendering.scope, 'one-invocation-source-candidates-only');
    assert.equal(value.package_semantics, 'replacement-candidates-not-existing-target-or-recovery-authority');
    for (const leaf of value.package_leaves) {
      boundary('rendering oracle');
      assert.equal(leaf.copy_mode, leaf.path.startsWith('bin/') || leaf.path === 'git-hooks/pre-push' ? 0o755 : 0o644);
      assert.equal(leaf.substitution_exempt, leaf.path.startsWith('bin/init/') ||
        leaf.path === 'tooling/instructions/config.template.json');
      assert.deepEqual(leaf.target, targetBefore.get(path.join(f.workspace, leaf.path)) ?? { present: false });
      let expected = fs.readFileSync(path.join(packageRoot, leaf.path));
      if (!isSubstitutionExempt(leaf.path) && TEMPLATE_TOKENS.some(token => expected.includes(token))) {
        let text = expected.toString('utf8');
        for (const token of TEMPLATE_TOKENS) text = text.split(token).join(replacements[token]);
        expected = Buffer.from(text);
      }
      assert.equal(leaf.desired_sha256, sha(expected), leaf.path);
      assert.equal(leaf.desired_bytes, expected.length, leaf.path);
    }
    assert.equal(value.skill.desired_sha256, sha(fs.readFileSync(path.join(packageRoot, '.agents/skills/orchestrate-turn/SKILL.md'))));
    assert.equal(value.constitution.desired_sha256, sha(fs.readFileSync(path.join(packageRoot, 'tooling/instructions/CONSTITUTION.md'))));
    assert.equal(value.skill.desired_bytes, fs.statSync(path.join(packageRoot, '.agents/skills/orchestrate-turn/SKILL.md')).size);
    assert.equal(value.constitution.desired_bytes, fs.statSync(path.join(packageRoot, 'tooling/instructions/CONSTITUTION.md')).size);
    assert.equal(value.skill.treatment, 'raw-copy-not-substituted');
    assert.equal(value.skill.mode, 'source-mode-if-created-existing-mode-if-replaced');
    assert.equal(value.constitution.treatment, 'raw-copy-if-absent-existing-decision-unavailable');
    assert.deepEqual(value.skill.target, targetBefore.get(path.join(f.workspace, value.skill.path)));
    assert.deepEqual(value.constitution.target, targetBefore.get(path.join(f.home, value.constitution.path)));
    for (const leaf of value.scaffold.files) {
      assert.deepEqual(leaf.target, targetBefore.get(path.join(f.home, leaf.path)) ?? { present: false });
    }
    for (const field of ['scaffold', 'config', 'finalization']) assert.equal(value[field].available, false);
    assert.equal(value.scaffold.files.length, 10);
    assert.equal(value.unavailable_capabilities.length, 6);
    assert.equal(fs.existsSync(path.join(f.home, 'environment')), false, 'no managed bootstrap');
  });

  await t.test('upgrade skips the state object before stat while fresh mode refuses a state link', async () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.unrelated, 'retain'), path.join(f.workspace, 'state'));
    const value = planned(await invoke(f, ['--upgrade']));
    assert.deepEqual(value.state, { status: 'skipped-upgrade', inspected: false });
    refused(await invoke(f), 'unknown-target-object');
  });

  await t.test('historical UUID lock preserved; unknown lock members refuse without content disclosure', async () => {
    const f = fixture(), lock = path.join(f.workspace, '.aigentry-native-capture.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), '{"kind":"legacy-init","operationId":"4bc8a54c-023b-4e64-9c55-8ffca1c3bd8d"}\n', { mode: 0o600 });
    const value = planned(await invoke(f, ['--upgrade']));
    assert.equal(value.locks[0].present, true);
    assert.equal(value.locks[0].owner_content_read, false);
    assert.match(value.locks[0].status, /inspect-only/);
    assert.deepEqual(value.locks.map(l => [l.root, l.path, l.present, l.owner_content_read]), [
      ['workspace', '.aigentry-native-capture.lock', true, false],
      ['workspace', '.aigentry-preservation.lock', false, false],
      ['home', '.aigentry-preservation.lock', false, false],
    ]);
    fs.writeFileSync(path.join(lock, 'foreign'), 'unknown lock object\n', { mode: 0o600 });
    refused(await invoke(f, ['--upgrade']), 'unknown-lock-object');
  });

  await t.test('invalid config is opaque; no environment bootstrap or dependency probes', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, 'config.json'), '{ secret: DO_NOT_EMIT_1171', { mode: 0o600 });
    fs.mkdirSync(path.join(f.home, 'environment'), { mode: 0o700 });
    fs.writeFileSync(path.join(f.home, 'environment/config.json'), 'invalid-managed-config-1171', { mode: 0o600 });
    const configBefore = fs.lstatSync(path.join(f.home, 'config.json'));
    const { r, value } = await invoke(f, ['--upgrade']);
    planned({ r, value });
    assert.equal(value.config.available, false);
    assert.deepEqual(value.config.target, { present: true, mode: configBefore.mode & 0o777, bytes: configBefore.size });
    assert.ok(!r.stdout.includes('DO_NOT_EMIT_1171') && !r.stdout.includes('invalid-managed-config-1171'));
    // PATH contains no programs: reaching legacy dependencyChecks would fail.
    assert.deepEqual(fs.readdirSync(f.ports), []);
  });

  await t.test('incompatible and duplicate options refuse; force/yes never confer authority', async () => {
    const f = fixture();
    for (const args of [['--force'], ['--yes'], ['-y'], ['--dry-run'], ['--help'],
      ['--capture-root', f.unrelated], ['--preservation-root', f.unrelated],
      ['--inspect-native', 'uuid'], ['--restore-native', 'uuid'], ['--unknown'],
      ['--upgrade', '--upgrade'], ['--legacy-recovery-plan'], ['--workspace', f.workspace]]) refused(await invoke(f, args), 'incompatible-options');
  });

  await t.test('missing roots, linked roots and unknown planned target objects refuse', async () => {
    const f = fixture();
    refused(await invoke(f, [], {}, path.join(f.base, 'absent')), 'roots-unavailable');
    refused(await invoke(f, [], { AIGENTRY_HOME: '' }), 'explicit-canonical-roots-required');
    fs.symlinkSync(f.workspace, path.join(f.base, 'alias'));
    refused(await invoke(f, [], {}, path.join(f.base, 'alias')), 'unsafe-directory');
    fs.mkdirSync(path.join(f.workspace, 'bin'), { mode: 0o700 });
    fs.symlinkSync(path.join(f.unrelated, 'retain'), path.join(f.workspace, 'bin/ask.sh'));
    refused(await invoke(f), 'unknown-target-object');
  });

  await t.test('incomplete real package closure refuses without target writes', async () => {
    const f = fixture();
    // Only the private fixture is faulted; original admitted source remains frozen.
    const file = path.join(packageRoot, 'tooling/instructions/common.md');
    fs.renameSync(file, file + '.held');
    refused(await invoke(f), 'incomplete-source-closure');
  });

  } finally {
  budget.finalizing = true;
  let custodyComplete = false;
  try {
  assert.equal(hashFile(node, true), nodeBefore);
  assert.equal(sha(fs.readFileSync(manifestFile)), sha(manifestBytes));
  for (const entry of manifest.files) {
    const { file, stat } = regular(source, entry.path);
    assert.equal(sha(fs.readFileSync(file)), frozen[entry.path].hash);
    assert.equal(stat.mode & 0o777, frozen[entry.path].mode);
  }
  custodyComplete = true;
  } finally {
    writeJSON(path.join(evidence, 'final.json'), { budget, counter, custodyComplete,
      retainedBytes, partial: !custodyComplete || Boolean(budget.failure),
      validation: 'custody receipt only; test assertions determine acceptance' }, true);
  }
  }
  assert.equal(budget.failure, null, 'budget/lifecycle failure cannot pass');
  assert.equal(counter, 24, 'all original stimuli executed');
  console.error(`Recovery-plan evidence retained: ${run}`);
});
