// Authored for separately admitted execution against the freshly built candidate.
// Required: LEGACY_RECOVERY_TEST_PACKAGE, LEGACY_RECOVERY_TEST_MANIFEST (files:
// path/bytes/sha256), LEGACY_RECOVERY_TEST_ROOT (existing private non-Git parent).
// No compiler, setup command, product mock, successful import stub or supplied
// historical generated output. Evidence/fixtures are retained, never cleaned up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { builtinModules } from 'node:module';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeRelative = p => typeof p === 'string' && p && !p.includes('\\') &&
  !/[\x00-\x1f\x7f]/.test(p) && !path.posix.isAbsolute(p) &&
  p.split('/').every(part => part && part !== '.' && part !== '..');
function canonicalDirectory(dir, privateRoot = false) {
  assert.ok(typeof dir === 'string' && path.isAbsolute(dir) && path.normalize(dir) === dir &&
    dir !== path.parse(dir).root && !dir.endsWith(path.sep), 'explicit canonical directory required');
  assert.equal(fs.realpathSync(dir), dir);
  for (let current = dir; ; current = path.dirname(current)) {
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
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = prefix + name, file = path.join(dir, name), s = fs.lstatSync(file);
      images[rel] = { mode: s.mode & 0o7777, type: s.isDirectory() ? 'directory' :
        s.isFile() ? 'file' : s.isSymbolicLink() ? 'link' : 'unknown',
      content: s.isFile() ? sha(fs.readFileSync(file)) : s.isSymbolicLink() ? fs.readlinkSync(file) : null };
      if (s.isDirectory()) visit(file, rel + '/');
    }
  }
  visit(root);
  return images;
}
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

test('actual public legacy recovery plan is read-only evidence', async t => {
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
  const manifest = JSON.parse(manifestBytes);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096);
  const paths = new Set(), frozen = {};
  let bytes = 0;
  for (const entry of manifest.files) {
    assert.ok(safeRelative(entry.path) && !paths.has(entry.path), 'unique bounded fixture paths');
    assert.ok(entry.path === 'package.json' || /^(?:bin|docs|tooling|git-hooks|\.agents|\.claude|dist\/src|node_modules)\//.test(entry.path) ||
      ['AGENTS.md', 'CLAUDE.md', 'README.md', 'LICENSE', 'src/orchestrator-boot/cli.ts', 'src/orchestrator-boot/usage.ts'].includes(entry.path));
    paths.add(entry.path);
    const { file, stat } = regular(source, entry.path), content = fs.readFileSync(file);
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
  for (const rel of MANIFEST) assert.ok(paths.has(rel), `missing shipped leaf: ${rel}`);
  const compiled = [];
  function production(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), rel = prefix + name, s = fs.lstatSync(file);
      assert.ok(!s.isSymbolicLink());
      if (s.isDirectory()) production(file, rel + '/');
      else if (name.endsWith('.js')) { assert.ok(s.isFile()); compiled.push(rel); }
    }
  }
  production(path.join(source, 'dist/src'), 'dist/src/');
  assert.ok(compiled.length > 0);
  for (const rel of compiled) assert.ok(paths.has(rel), `missing compiled production leaf: ${rel}`);
  for (const required of ['storage', 'bootstrap']) assert.ok(paths.has(`dist/src/environment/${required}.js`));
  // Fixture dependency package context is supplied by the admitted manifest.
  // Do not resolve against or inspect arbitrary host node_modules.
  const external = new Set();
  for (const rel of compiled) {
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
  const run = fs.mkdtempSync(path.join(parent, 'legacy-recovery-'));
  fs.chmodSync(run, 0o700);
  const data = path.join(run, 'data'), evidence = path.join(run, 'evidence');
  for (const dir of [data, evidence]) fs.mkdirSync(dir, { mode: 0o700 });
  const packageRoot = path.join(data, 'package');
  fs.mkdirSync(packageRoot, { mode: 0o700 });
  for (const entry of manifest.files) {
    const file = path.join(packageRoot, entry.path);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(source, entry.path), file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, frozen[entry.path].mode);
    assert.equal(sha(fs.readFileSync(file)), entry.sha256);
  }
  writeJSON(path.join(evidence, 'custody.json'), { source, manifest: manifestFile, manifestHash: sha(manifestBytes),
    packageName: pkg.name, packageVersion: pkg.version, compiled, external: [...external], frozen });
  const node = fs.realpathSync(process.execPath), nodeBefore = sha(fs.readFileSync(node));
  let counter = 0;
  function fixture() {
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
  function invoke(f, extras = [], env = {}, workspace = f.workspace) {
    const id = String(++counter);
    const args = [path.join(packageRoot, 'bin/init/cli.mjs'), 'init', '--legacy-recovery-plan', '--workspace', workspace, ...extras];
    const before = snapshot(data);
    writeJSON(path.join(evidence, `${id}-before.json`), before);
    const started = Date.now();
    const r = spawnSync(node, args, { cwd: f.base, env: { ...f.env, ...env }, shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    fs.writeFileSync(path.join(evidence, `${id}.stdout`), r.stdout ?? '', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(evidence, `${id}.stderr`), r.stderr ?? '', { flag: 'wx', mode: 0o600 });
    writeJSON(path.join(evidence, `${id}-child.json`), { node, nodeHash: nodeBefore, args, env: { ...f.env, ...env },
      cwd: f.base, started, elapsedMs: Date.now() - started, status: r.status, signal: r.signal,
      error: r.error ? { message: r.error.message, code: r.error.code } : null,
      limits: { timeoutMs: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, shell: false },
      observation: 'spawnSync return only; no reconstructed exit/close/EOF events' });
    const after = snapshot(data);
    writeJSON(path.join(evidence, `${id}-after.json`), after);
    assert.deepEqual(after, before, 'all fixture bytes and modes unchanged');
    assert.equal(r.error, undefined, r.stderr);
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
  const refused = result => {
    assert.equal(result.r.status, 4);
    assert.equal(result.value.status, 'refused');
    assert.equal(result.value.package_rendering_complete, false);
    assert.equal(result.value.package_leaves, undefined, 'refusal never emits partial or denied hashes');
  };

  await t.test('frozen final package rendering, raw copies and unavailable owner contracts', () => {
    const f = fixture();
    const value = planned(invoke(f));
    assert.equal(value.version, 1);
    assert.equal(value.package_rendering_complete, true);
    assert.deepEqual(value.package_leaves.map(l => l.path), MANIFEST);
    const replacements = {
      '{{CONSTITUTION_PATH}}': path.join(f.home, 'CONSTITUTION.md'),
      '{{CONTROL_WORKSPACE}}': f.workspace, '{{DEVICE_ID}}': `device-${os.hostname()}`,
      '{{CREATED_AT}}': value.rendering.created_at,
    };
    assert.equal(new Date(value.rendering.created_at).toISOString(), value.rendering.created_at);
    for (const leaf of value.package_leaves) {
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
    for (const field of ['scaffold', 'config', 'finalization']) assert.equal(value[field].available, false);
    assert.equal(value.scaffold.files.length, 10);
    assert.equal(value.unavailable_capabilities.length, 6);
    assert.equal(fs.existsSync(path.join(f.home, 'environment')), false, 'no managed bootstrap');
  });

  await t.test('upgrade skips the state object before stat while fresh mode refuses a state link', () => {
    const f = fixture();
    fs.symlinkSync(path.join(f.unrelated, 'retain'), path.join(f.workspace, 'state'));
    const value = planned(invoke(f, ['--upgrade']));
    assert.deepEqual(value.state, { status: 'skipped-upgrade', inspected: false });
    refused(invoke(f));
  });

  await t.test('historical UUID lock preserved; unknown lock members refuse without content disclosure', () => {
    const f = fixture(), lock = path.join(f.workspace, '.aigentry-native-capture.lock');
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, 'owner.json'), '{"kind":"legacy-init","operationId":"4bc8a54c-023b-4e64-9c55-8ffca1c3bd8d"}\n', { mode: 0o600 });
    const value = planned(invoke(f, ['--upgrade']));
    assert.equal(value.locks[0].present, true);
    assert.equal(value.locks[0].owner_content_read, false);
    assert.match(value.locks[0].status, /inspect-only/);
    fs.writeFileSync(path.join(lock, 'foreign'), 'unknown lock object\n', { mode: 0o600 });
    refused(invoke(f, ['--upgrade']));
  });

  await t.test('invalid config is opaque; no environment bootstrap or dependency probes', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, 'config.json'), '{ secret: DO_NOT_EMIT_1171', { mode: 0o600 });
    fs.mkdirSync(path.join(f.home, 'environment'), { mode: 0o700 });
    fs.writeFileSync(path.join(f.home, 'environment/config.json'), 'invalid-managed-config-1171', { mode: 0o600 });
    const { r, value } = invoke(f, ['--upgrade']);
    planned({ r, value });
    assert.equal(value.config.available, false);
    assert.ok(!r.stdout.includes('DO_NOT_EMIT_1171') && !r.stdout.includes('invalid-managed-config-1171'));
    // PATH contains no programs: reaching legacy dependencyChecks would fail.
    assert.deepEqual(fs.readdirSync(f.ports), []);
  });

  await t.test('incompatible and duplicate options refuse; force/yes never confer authority', () => {
    const f = fixture();
    for (const args of [['--force'], ['--yes'], ['-y'], ['--dry-run'], ['--help'],
      ['--capture-root', f.unrelated], ['--preservation-root', f.unrelated],
      ['--inspect-native', 'uuid'], ['--restore-native', 'uuid'], ['--unknown'],
      ['--upgrade', '--upgrade'], ['--legacy-recovery-plan'], ['--workspace', f.workspace]]) refused(invoke(f, args));
  });

  await t.test('missing roots, linked roots and unknown planned target objects refuse', () => {
    const f = fixture();
    refused(invoke(f, [], {}, path.join(f.base, 'absent')));
    refused(invoke(f, [], { AIGENTRY_HOME: '' }));
    fs.symlinkSync(f.workspace, path.join(f.base, 'alias'));
    refused(invoke(f, [], {}, path.join(f.base, 'alias')));
    fs.mkdirSync(path.join(f.workspace, 'bin'), { mode: 0o700 });
    fs.symlinkSync(path.join(f.unrelated, 'retain'), path.join(f.workspace, 'bin/ask.sh'));
    refused(invoke(f));
  });

  await t.test('incomplete real package closure refuses without target writes', () => {
    const f = fixture();
    // Only the private fixture is faulted; original admitted source remains frozen.
    const file = path.join(packageRoot, 'tooling/instructions/common.md');
    fs.renameSync(file, file + '.held');
    refused(invoke(f));
  });

  assert.equal(sha(fs.readFileSync(node)), nodeBefore);
  assert.equal(sha(fs.readFileSync(manifestFile)), sha(manifestBytes));
  for (const entry of manifest.files) {
    const { file, stat } = regular(source, entry.path);
    assert.equal(sha(fs.readFileSync(file)), frozen[entry.path].hash);
    assert.equal(stat.mode & 0o777, frozen[entry.path].mode);
  }
  console.error(`Recovery-plan evidence retained: ${run}`);
});
