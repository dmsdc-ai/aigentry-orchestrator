// #1172 — black-box regression for bin/worker-inputs.mjs (stage / verify / test) and the optional
// dispatch --input-root/--input-manifest/--input-sha256 preflight. Node built-ins only; every fixture is
// fake data under a test-owned temp root. POSIX mode/symlink/signal assertions run only where the OS can
// express them; Windows behaviour is not claimed by this file until real CI proves it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, statSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELPER = join(repoRoot, 'bin', 'worker-inputs.mjs');
const DIST_DISPATCH = join(repoRoot, 'dist', 'src', 'dispatch', 'cli.js');
const POSIX = process.platform !== 'win32';
// #1167 P7: nothing is skipped on win32. A case that is inherently POSIX registers only there (reason beside it)
// and the Windows form of its behaviour is its own win32 case; every other case runs on every OS.
const posixTest = POSIX ? test : () => {};
const SECRET_CONTENT = 'FIXTURE-SECRET-CONTENT-6f1d';
const SECRET_ENV = 'FIXTURE-SECRET-ENV-VALUE-91ac';
const HEX64 = /^[0-9a-f]{64}$/;

const base = mkdtempSync(join(tmpdir(), 'wi1172-'));
after(() => {
  // Snapshots are 0444/0555 by contract; widen only our own temp tree so it can be removed.
  const widen = (p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    try { chmodSync(p, st.isDirectory() ? 0o700 : 0o600); } catch { /* best-effort */ }
    if (st.isDirectory()) for (const n of readdirSync(p)) widen(join(p, n));
  };
  widen(base);
  rmSync(base, { recursive: true, force: true });
});

let seq = 0;
const fresh = (label) => join(base, `${label}-${++seq}`);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// This file itself runs under `node --test`, which exports NODE_TEST_CONTEXT to its children. Left in
// place it would reach the helper's own `node --test` and make Node skip the files, so the helper is
// invoked as an operator would (variable absent) unless a test sets it on purpose.
const { NODE_TEST_CONTEXT: _outerTestContext, ...cleanEnv } = process.env;

function helper(args, opts = {}) {
  const r = spawnSync(process.execPath, [HELPER, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout ?? 60000,
    cwd: opts.cwd ?? base,
    env: { ...cleanEnv, FIXTURE_SECRET_TOKEN: SECRET_ENV, ...(opts.env ?? {}) },
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, signal: r.signal, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function json(r) {
  const text = r.stdout.trim();
  assert.ok(text, `expected JSON on stdout, got stderr: ${r.stderr.slice(0, 500)}`);
  return JSON.parse(text);
}

function ok(r, what) {
  assert.equal(r.error, undefined, `${what}: spawn error ${r.error}`);
  assert.equal(r.status, 0, `${what}: exit ${r.status} signal ${r.signal}\nstdout=${r.stdout.slice(0, 800)}\nstderr=${r.stderr.slice(0, 800)}`);
}

function refused(r, what) {
  assert.equal(r.error, undefined, `${what}: spawn error ${r.error}`);
  assert.notEqual(r.status, 0, `${what}: expected nonzero exit\nstdout=${r.stdout.slice(0, 800)}`);
  assert.equal(r.signal, null, `${what}: helper died by signal instead of refusing`);
  const all = r.stdout + r.stderr;
  assert.ok(all.length < 16384, `${what}: error output is not bounded (${all.length} bytes)`);
  assert.ok(!all.includes(SECRET_CONTENT), `${what}: error output leaked file content`);
  assert.ok(!all.includes(SECRET_ENV), `${what}: error output leaked environment`);
}

// The child reports its cwd hex-encoded: reporters escape path text (TAP turns `\` into `\\`), so a
// formatted Windows path never matches by substring. Hex of the native realpath survives any reporter
// and is compared exactly, never as a substring.
const CWD_PROBE = "Buffer.from(realpathSync.native(process.cwd())).toString('hex')";
const PASS_TEST = "import test from 'node:test';\nimport { realpathSync } from 'node:fs';\n" +
  `test('fixture pass', () => { console.log('FIXTURE_RAN cwd_hex=' + ${CWD_PROBE}); });\n`;

/** Exactly one structured cwd observation from the child, equal to the native realpath of `root`. */
function assertRanAt(output, root) {
  const seen = [...output.matchAll(/FIXTURE_RAN cwd_hex=([0-9a-f]+)/g)].map((m) => m[1]);
  assert.equal(seen.length, 1, `expected exactly one cwd observation, got ${seen.length}`);
  assert.equal(Buffer.from(seen[0], 'hex').toString('utf8'), realpathSync.native(root), 'test cwd is not the snapshot root');
}
const OTHER_TEST = "import test from 'node:test';\n" +
  "test('undeclared', () => { console.log('UNDECLARED_RAN'); throw new Error('undeclared test must not run'); });\n";

/** Builds a fake source tree plus a plan over it. `extra` is listed-file overrides. */
function fixture(label = 'src', { tests = ['tests/pass.test.mjs'], files: custom } = {}) {
  const source = fresh(label);
  const files = custom ?? {
    'README.md': { body: `readme ${SECRET_CONTENT}\n`, mode: 0o644 },
    'bin/tool.sh': { body: '#!/bin/sh\necho tool\n', mode: 0o755 },
    'dir with space/ünïcode name.txt': { body: 'portable name\n', mode: 0o644 },
    'tests/pass.test.mjs': { body: PASS_TEST, mode: 0o644 },
    'tests/other.test.mjs': { body: OTHER_TEST, mode: 0o644 },
  };
  for (const [p, f] of Object.entries(files)) {
    const abs = join(source, ...p.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.body);
    if (POSIX) chmodSync(abs, f.mode);
  }
  // Unlisted bytes beside listed ones: stage must never copy or read them into the snapshot.
  writeFileSync(join(source, 'unlisted-secret.txt'), SECRET_CONTENT);
  const plan = {
    version: 1,
    files: Object.entries(files).map(([path, f]) => ({ path, sha256: sha(Buffer.from(f.body)), mode: f.mode })),
    tests,
  };
  return { source, plan, files };
}

function writePlan(plan, label = 'plan') {
  const p = fresh(label) + '.json';
  writeFileSync(p, typeof plan === 'string' ? plan : JSON.stringify(plan));
  return p;
}

function stage(source, plan, dest = fresh('dest')) {
  const planFile = writePlan(plan);
  return { r: helper(['stage', '--source', source, '--plan', planFile, '--dest', dest]), dest, planFile };
}

function staged(label = 'src', opts) {
  const fx = fixture(label, opts);
  const s = stage(fx.source, fx.plan);
  ok(s.r, 'stage');
  const out = json(s.r);
  return { ...fx, ...s, out, triple: ['--root', out.root, '--manifest', out.manifest, '--sha256', out.manifestSha256] };
}

/** Recursively lists a tree (relative path → lstat summary) to prove "no mutation". */
function snapshotTree(dir) {
  const acc = {};
  const walk = (d, rel) => {
    for (const n of readdirSync(d).sort()) {
      const abs = join(d, n);
      const st = lstatSync(abs);
      const key = rel ? `${rel}/${n}` : n;
      acc[key] = { mode: st.mode, size: st.size, mtimeMs: st.mtimeMs, kind: st.isDirectory() ? 'd' : st.isSymbolicLink() ? 'l' : 'f' };
      if (st.isDirectory()) walk(abs, key);
    }
  };
  walk(dir, '');
  return acc;
}

function makeWritable(p) {
  chmodSync(dirname(p), 0o755);
  if (existsSync(p)) chmodSync(p, 0o644);
}

describe('worker-inputs helper presence and usage', () => {
  test('bin/worker-inputs.mjs exists', () => {
    assert.ok(existsSync(HELPER), `missing helper: ${HELPER}`);
  });

  test('--help documents stage, verify and test and exits 0', () => {
    const r = helper(['--help']);
    ok(r, '--help');
    const text = r.stdout + r.stderr;
    for (const word of ['stage', 'verify', 'test', '--source', '--plan', '--dest', '--root', '--manifest', '--sha256']) {
      assert.ok(text.includes(word), `--help does not mention ${word}`);
    }
  });

  test('unknown subcommand and unknown flags are refused', () => {
    refused(helper(['frobnicate']), 'unknown subcommand');
    refused(helper([]), 'no subcommand');
    const fx = fixture();
    const dest = fresh('dest');
    refused(helper(['stage', '--source', fx.source, '--plan', writePlan(fx.plan), '--dest', dest, '--force']), 'stage unknown flag');
    assert.equal(existsSync(dest), false, 'unknown flag still created dest');
  });

  test('inherited Object.prototype names are not commands or flags', () => {
    const { triple, out } = staged('inherited');
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const r = helper([name]);
      refused(r, `subcommand ${name}`);
      for (const cmd of ['verify', 'test']) {
        const rr = helper([cmd, ...triple, `--${name}`, 'x']);
        refused(rr, `${cmd} --${name}`);
        assert.ok(!(rr.stdout + rr.stderr).includes('FIXTURE_RAN'), `${cmd} --${name} ran tests`);
      }
      const fx = fixture('inherited-stage');
      const dest = fresh('dest');
      refused(helper(['stage', '--source', fx.source, '--plan', writePlan(fx.plan), '--dest', dest, `--${name}`, 'x']), `stage --${name}`);
      assert.equal(existsSync(dest), false, `stage --${name} created dest`);
      // A flag named like an inherited member must not stand in for a mandatory one.
      refused(helper(['verify', '--root', out.root, '--manifest', out.manifest, `--${name}`, out.manifestSha256]), `verify --${name} as --sha256`);
    }
    ok(helper(['verify', ...triple]), 'positive control');
  });

  test('source uses Node built-ins only: no network modules, no shell spawning, no dependencies', () => {
    const src = readFileSync(HELPER, 'utf8');
    const specifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((m) => m[1] ?? m[2] ?? m[3]);
    assert.ok(specifiers.length > 0, 'no imports found');
    for (const s of specifiers) {
      assert.match(s, /^node:/, `non-builtin import: ${s}`);
      assert.ok(!/^node:(https?|http2|net|tls|dgram|dns)(\/|$)/.test(s), `network module imported: ${s}`);
    }
    assert.ok(!/shell\s*:\s*true/.test(src), 'helper spawns through a shell');
    assert.ok(!/\bexecSync\b|\bexec\(/.test(src), 'helper uses exec (shell) instead of spawn with argv');
  });
});

describe('stage', () => {
  test('materializes exactly the approved bytes and reports the snapshot', () => {
    const { source, plan, files, dest, out } = staged();
    assert.ok(isAbsolute(out.root), `root is not absolute: ${out.root}`);
    assert.equal(out.files, plan.files.length, 'files count');
    assert.equal(out.tests, plan.tests.length, 'tests count');
    assert.equal(out.coverage, 'declared-inputs-only');
    assert.match(out.manifestSha256, HEX64);
    assert.ok(existsSync(out.manifest), 'manifest path does not exist');
    assert.equal(sha(readFileSync(out.manifest)), out.manifestSha256, 'manifestSha256 is not the manifest file hash');

    const manifest = JSON.parse(readFileSync(out.manifest, 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), ['files', 'tests', 'version']);
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.files, plan.files, 'manifest.files differs from the plan (listed 0644/0755 modes must be preserved)');
    assert.deepEqual(manifest.tests, plan.tests);

    const repo = join(dest, 'repo');
    assert.ok(statSync(repo).isDirectory(), 'dest/repo was not created');
    assert.equal(realpathSync(out.root), realpathSync(repo), 'reported root is not dest/repo');
    for (const [p, f] of Object.entries(files)) {
      const abs = join(repo, ...p.split('/'));
      assert.equal(readFileSync(abs, 'utf8'), f.body, `bytes differ for ${p}`);
      if (POSIX) {
        const want = f.mode === 0o755 ? 0o555 : 0o444;
        assert.equal(statSync(abs).mode & 0o777, want, `${p}: snapshot mode must be reduced to ${want.toString(8)}`);
        assert.equal(statSync(join(source, ...p.split('/'))).mode & 0o777, f.mode, `${p}: source mode was changed`);
      }
    }
    assert.equal(existsSync(join(repo, 'unlisted-secret.txt')), false, 'unlisted source file was copied');
    const listed = new Set(Object.keys(files));
    const walk = (d, rel) => {
      for (const n of readdirSync(d)) {
        const key = rel ? `${rel}/${n}` : n;
        if (statSync(join(d, n)).isDirectory()) walk(join(d, n), key);
        else assert.ok(listed.has(key), `snapshot holds unlisted file ${key}`);
      }
    };
    walk(repo, '');
  });

  test('accepts spaces and unicode in portable names', () => {
    const { out } = staged();
    assert.ok(existsSync(join(out.root, 'dir with space', 'ünïcode name.txt')));
  });

  test('refuses an existing destination and leaves it untouched', () => {
    const fx = fixture();
    const dest = fresh('preexisting');
    mkdirSync(dest);
    writeFileSync(join(dest, 'keep.txt'), 'keep');
    refused(stage(fx.source, fx.plan, dest).r, 'existing dest');
    assert.equal(readFileSync(join(dest, 'keep.txt'), 'utf8'), 'keep', 'pre-existing dest content was touched');
    assert.deepEqual(readdirSync(dest), ['keep.txt']);

    const emptyDest = fresh('preexisting-empty');
    mkdirSync(emptyDest);
    refused(stage(fx.source, fx.plan, emptyDest).r, 'existing empty dest');
    assert.ok(existsSync(emptyDest), 'pre-existing empty dest was removed');
  });

  test('refuses overlapping source and destination', () => {
    const fx = fixture();
    const inside = join(fx.source, 'snapshot');
    refused(stage(fx.source, fx.plan, inside).r, 'dest inside source');
    assert.equal(existsSync(inside), false);
    refused(stage(fx.source, fx.plan, fx.source).r, 'dest equals source');
  });

  const planCases = [
    ['version 2', (p) => ({ ...p, version: 2 })],
    ['version as string', (p) => ({ ...p, version: '1' })],
    ['missing version', ({ version, ...p }) => p],
    ['unknown top-level key', (p) => ({ ...p, extra: true })],
    ['unknown file key', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, bytes: 1 } : f)) })],
    ['missing file mode', (p) => ({ ...p, files: p.files.map(({ mode, ...f }, i) => (i === 0 ? f : { ...f, mode })) })],
    ['files not an array', (p) => ({ ...p, files: {} })],
    ['empty files', (p) => ({ ...p, files: [], tests: [] })],
    ['missing tests', ({ tests, ...p }) => p],
    ['empty tests', (p) => ({ ...p, tests: [] })],
    ['wildcard test', (p) => ({ ...p, tests: ['tests/*.test.mjs'] })],
    ['test not listed in files', (p) => ({ ...p, tests: ['tests/absent.test.mjs'] })],
    ['test with wrong suffix', (p) => ({ ...p, tests: ['README.md'] })],
    ['duplicate test', (p) => ({ ...p, tests: ['tests/pass.test.mjs', 'tests/pass.test.mjs'] })],
    ['duplicate path', (p) => ({ ...p, files: [...p.files, p.files[0]] })],
    ['case-colliding paths', (p) => ({ ...p, files: [...p.files, { ...p.files[0], path: p.files[0].path.toUpperCase() }] })],
    ['mode 0777', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, mode: 0o777 } : f)) })],
    ['mode 0600', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, mode: 0o600 } : f)) })],
    ['mode as octal string', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, mode: '0644' } : f)) })],
    ['uppercase sha256', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, sha256: f.sha256.toUpperCase() } : f)) })],
    ['short sha256', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, sha256: f.sha256.slice(1) } : f)) })],
    ['hash mismatch', (p) => ({ ...p, files: p.files.map((f, i) => (i === 0 ? { ...f, sha256: '0'.repeat(64) } : f)) })],
  ];
  const badPaths = ['/etc/passwd', 'C:/x.txt', 'C:x.txt', '//server/share/x', '\\\\server\\share\\x', 'a\\b.txt', './README.md',
    'bin/./tool.sh', '../outside.txt', 'bin/../README.md', 'bin/', '', '.', '..', 'a\0b'];
  // Where an unsafe path resolves to a real file, list its true hash so only the path rule can refuse it.
  writeFileSync(join(base, 'outside.txt'), SECRET_CONTENT);
  const hashAt = (source, p) => {
    try { return sha(readFileSync(resolve(source, p))); } catch { return '0'.repeat(64); }
  };
  for (const bad of badPaths) {
    planCases.push([`unsafe path ${JSON.stringify(bad)}`,
      (p, fx) => ({ ...p, files: [...p.files, { path: bad, sha256: hashAt(fx.source, bad), mode: 0o644 }] })]);
  }
  // Inherited Object.prototype names must be treated as unknown keys, never as present/valid ones.
  for (const key of ['__proto__', 'constructor', 'toString']) {
    planCases.push([`inherited-name top-level key ${key}`, (p) => JSON.parse(JSON.stringify(p).replace(/^\{/, `{"${key}":{},`))]);
    planCases.push([`inherited-name file key ${key}`, (p) => {
      const text = JSON.stringify(p.files[0]).replace(/^\{/, `{"${key}":{},`);
      return { ...p, files: [JSON.parse(text), ...p.files.slice(1)] };
    }]);
  }
  for (const [name, mutate] of planCases) {
    test(`refuses plan: ${name} (dest never created)`, () => {
      const fx = fixture();
      const s = stage(fx.source, mutate(structuredClone(fx.plan), fx));
      refused(s.r, name);
      assert.equal(existsSync(s.dest), false, `${name}: dest created for an invalid plan`);
      // Paired positive control: the unmutated plan over the same source stages.
      ok(stage(fx.source, fx.plan).r, `${name}: positive control`);
    });
  }

  test('refuses malformed JSON and a plan over 1MiB', () => {
    const fx = fixture();
    const d1 = fresh('dest');
    refused(helper(['stage', '--source', fx.source, '--plan', writePlan('{"version":1,'), '--dest', d1]), 'malformed plan');
    assert.equal(existsSync(d1), false);
    const big = { ...fx.plan, files: [...fx.plan.files] };
    const pad = 'p'.repeat(200);
    for (let i = 0; JSON.stringify(big).length <= 1024 * 1024; i++) big.files.push({ path: `pad/${pad}${i}.txt`, sha256: '0'.repeat(64), mode: 0o644 });
    const d2 = fresh('dest');
    refused(helper(['stage', '--source', fx.source, '--plan', writePlan(big), '--dest', d2]), 'plan > 1MiB');
    assert.equal(existsSync(d2), false);
  });

  test('refuses more than 5000 files', () => {
    const fx = fixture();
    const plan = structuredClone(fx.plan);
    for (let i = plan.files.length; i <= 5000; i++) plan.files.push({ path: `many/f${i}.txt`, sha256: sha(Buffer.from('x')), mode: 0o644 });
    assert.ok(plan.files.length > 5000);
    const s = stage(fx.source, plan);
    refused(s.r, '> 5000 files');
    assert.equal(existsSync(s.dest), false);
  });

  test('refuses an empty listed file', () => {
    const fx = fixture('src', { files: {
      'empty.txt': { body: '', mode: 0o644 },
      'tests/pass.test.mjs': { body: PASS_TEST, mode: 0o644 },
    } });
    const s = stage(fx.source, fx.plan);
    refused(s.r, 'empty file');
    assert.equal(existsSync(s.dest), false);
  });

  test('refuses more than 64MiB total', () => {
    const fx = fixture();
    const bigPath = join(fx.source, 'big.bin');
    writeFileSync(bigPath, '');
    truncateSync(bigPath, 64 * 1024 * 1024 + 1);
    const plan = structuredClone(fx.plan);
    plan.files.push({ path: 'big.bin', sha256: sha(readFileSync(bigPath)), mode: 0o644 });
    const s = stage(fx.source, plan);
    refused(s.r, '> 64MiB');
    assert.equal(existsSync(s.dest), false);
  });

  test('refuses a missing listed file and a directory listed as a file', () => {
    const fx = fixture();
    const missing = structuredClone(fx.plan);
    missing.files.push({ path: 'not-there.txt', sha256: '0'.repeat(64), mode: 0o644 });
    const s1 = stage(fx.source, missing);
    refused(s1.r, 'missing source file');
    assert.equal(existsSync(s1.dest), false);
    const dir = structuredClone(fx.plan);
    dir.files.push({ path: 'bin', sha256: '0'.repeat(64), mode: 0o755 });
    const s2 = stage(fx.source, dir);
    refused(s2.r, 'directory as file');
    assert.equal(existsSync(s2.dest), false);
  });

  // POSIX only: an unprivileged file symlink (Windows needs SeCreateSymbolicLinkPrivilege); win32 form: the junction case below.
  posixTest('refuses symlinked leaf, ancestor and source root', () => {
    const outside = fresh('outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'leak.txt'), SECRET_CONTENT);

    const leaf = fixture('leaf');
    symlinkSync(join(outside, 'leak.txt'), join(leaf.source, 'link.txt'));
    const p1 = structuredClone(leaf.plan);
    p1.files.push({ path: 'link.txt', sha256: sha(Buffer.from(SECRET_CONTENT)), mode: 0o644 });
    const s1 = stage(leaf.source, p1);
    refused(s1.r, 'symlink leaf');
    assert.equal(existsSync(s1.dest), false);

    const anc = fixture('ancestor');
    symlinkSync(outside, join(anc.source, 'linkdir'));
    const p2 = structuredClone(anc.plan);
    p2.files.push({ path: 'linkdir/leak.txt', sha256: sha(Buffer.from(SECRET_CONTENT)), mode: 0o644 });
    const s2 = stage(anc.source, p2);
    refused(s2.r, 'symlink ancestor');
    assert.equal(existsSync(s2.dest), false);

    const real = fixture('rootreal');
    const linkRoot = fresh('rootlink');
    symlinkSync(real.source, linkRoot);
    const s3 = stage(linkRoot, real.plan);
    refused(s3.r, 'symlink source root');
    assert.equal(existsSync(s3.dest), false);
  });

  // win32 form: a directory junction is the reparse point Windows creates unprivileged; as an ancestor or as
  // the source root it is refused exactly like a symlink, before dest exists.
  if (!POSIX) test('refuses a junction ancestor and a junction source root (win32 reparse points)', () => {
    const outside = fresh('outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'leak.txt'), SECRET_CONTENT);

    const anc = fixture('ancestor');
    symlinkSync(outside, join(anc.source, 'linkdir'), 'junction');
    const p2 = structuredClone(anc.plan);
    p2.files.push({ path: 'linkdir/leak.txt', sha256: sha(Buffer.from(SECRET_CONTENT)), mode: 0o644 });
    const s2 = stage(anc.source, p2);
    refused(s2.r, 'junction ancestor');
    assert.match(s2.r.stderr, /"SOURCE_SYMLINK_ANCESTOR"/);
    assert.equal(existsSync(s2.dest), false);

    const real = fixture('rootreal');
    const linkRoot = fresh('rootlink');
    symlinkSync(real.source, linkRoot, 'junction');
    const s3 = stage(linkRoot, real.plan);
    refused(s3.r, 'junction source root');
    assert.match(s3.r.stderr, /"SOURCE_SYMLINK"/);
    assert.equal(existsSync(s3.dest), false);
  });

  test('missing mandatory flags are refused', () => {
    const fx = fixture();
    const planFile = writePlan(fx.plan);
    const dest = fresh('dest');
    refused(helper(['stage', '--plan', planFile, '--dest', dest]), 'no --source');
    refused(helper(['stage', '--source', fx.source, '--dest', dest]), 'no --plan');
    refused(helper(['stage', '--source', fx.source, '--plan', planFile]), 'no --dest');
    assert.equal(existsSync(dest), false);
  });
});

describe('verify', () => {
  test('accepts an untouched snapshot and mutates nothing', () => {
    const { out, triple, dest } = staged();
    const before = snapshotTree(dest);
    const r = helper(['verify', ...triple]);
    ok(r, 'verify');
    const res = json(r);
    assert.equal(res.ok, true);
    assert.equal(res.coverage, 'declared-inputs-only');
    assert.deepEqual(snapshotTree(dest), before, 'verify mutated the snapshot');
    assert.ok(JSON.stringify(res).length < 4096, 'verify result is not compact');
    assert.ok(!JSON.stringify(res).includes(SECRET_CONTENT));
    assert.ok(out);
  });

  test('all three flags are mandatory', () => {
    const { out } = staged();
    refused(helper(['verify', '--manifest', out.manifest, '--sha256', out.manifestSha256]), 'no --root');
    refused(helper(['verify', '--root', out.root, '--sha256', out.manifestSha256]), 'no --manifest');
    refused(helper(['verify', '--root', out.root, '--manifest', out.manifest]), 'no --sha256');
  });

  test('refuses a manifest hash mismatch', () => {
    const { out } = staged();
    refused(helper(['verify', '--root', out.root, '--manifest', out.manifest, '--sha256', '0'.repeat(64)]), 'wrong sha');
    refused(helper(['verify', '--root', out.root, '--manifest', out.manifest, '--sha256', out.manifestSha256.toUpperCase()]), 'uppercase sha');
  });

  test('refuses a re-hashed manifest whose content is invalid', () => {
    const { out } = staged();
    const m = JSON.parse(readFileSync(out.manifest, 'utf8'));
    m.extra = 1;
    const forged = fresh('forged') + '.json';
    writeFileSync(forged, JSON.stringify(m));
    refused(helper(['verify', '--root', out.root, '--manifest', forged, '--sha256', sha(readFileSync(forged))]), 'unknown manifest key');
  });

  test('refuses changed, missing and extra files', () => {
    const changed = staged('changed');
    const f1 = join(changed.out.root, 'README.md');
    makeWritable(f1);
    writeFileSync(f1, 'tampered\n');
    chmodSync(f1, 0o444);
    refused(helper(['verify', ...changed.triple]), 'changed file');

    const missing = staged('missing');
    const f2 = join(missing.out.root, 'README.md');
    makeWritable(f2);
    rmSync(f2);
    refused(helper(['verify', ...missing.triple]), 'missing file');

    const extra = staged('extra');
    chmodSync(extra.out.root, 0o755);
    writeFileSync(join(extra.out.root, 'extra.txt'), 'extra');
    refused(helper(['verify', ...extra.triple]), 'extra file');

    const extraDeep = staged('extra-deep');
    const binDir = join(extraDeep.out.root, 'bin');
    chmodSync(binDir, 0o755);
    writeFileSync(join(binDir, 'planted.sh'), '#!/bin/sh\n');
    refused(helper(['verify', ...extraDeep.triple]), 'extra nested file');
  });

  // POSIX only: mode bits and an unprivileged file symlink; win32 form: the case below.
  posixTest('refuses widened modes and symlink substitution', () => {
    const widened = staged('widened');
    chmodSync(join(widened.out.root, 'README.md'), 0o666);
    refused(helper(['verify', ...widened.triple]), 'widened file mode');

    const linked = staged('linked');
    const target = join(linked.out.root, 'README.md');
    const copy = fresh('copy');
    writeFileSync(copy, readFileSync(target));
    makeWritable(target);
    rmSync(target);
    symlinkSync(copy, target);
    refused(helper(['verify', ...linked.triple]), 'symlink leaf in snapshot');
  });

  // win32 form: POSIX modes are not observable, so a widened file verifies with the mode check reported
  // skipped (the helper's documented contract); a junction substituted for a snapshot directory is refused.
  if (!POSIX) test('win32: widened modes are reported unchecked; a junction substitution is refused', () => {
    const widened = staged('widened');
    chmodSync(join(widened.out.root, 'README.md'), 0o666);
    const w = helper(['verify', ...widened.triple]);
    ok(w, 'verify widened file (win32)');
    assert.equal(json(w).modeCheck, 'skipped-win32');

    const linked = staged('linked');
    const binDir = join(linked.out.root, 'bin');
    const copy = fresh('bincopy');
    mkdirSync(copy);
    writeFileSync(join(copy, 'tool.sh'), readFileSync(join(binDir, 'tool.sh')));
    makeWritable(join(binDir, 'tool.sh'));
    rmSync(binDir, { recursive: true });
    symlinkSync(copy, binDir, 'junction');
    const r = helper(['verify', ...linked.triple]);
    refused(r, 'junction directory in snapshot');
    assert.match(r.stderr, /"SNAPSHOT_SYMLINK"/);
  });
});

describe('test', () => {
  test('runs exactly the declared tests at the snapshot root', () => {
    const { triple, out, dest } = staged();
    const before = snapshotTree(dest);
    const r = helper(['test', ...triple]);
    ok(r, 'test');
    const all = r.stdout + r.stderr;
    assert.ok(all.includes('FIXTURE_RAN'), 'declared test did not run (inherited stdio expected)');
    assertRanAt(all, out.root);
    assert.ok(!all.includes('UNDECLARED_RAN'), 'a listed-but-undeclared test file ran');
    assert.deepEqual(snapshotTree(dest), before, 'test mutated the snapshot');
  });

  test('the cwd observation rejects a declared test that ran away from the snapshot root', () => {
    const wrong = "import test from 'node:test';\nimport { realpathSync } from 'node:fs';\n" +
      `test('fixture wrong cwd', () => { process.chdir('..'); console.log('FIXTURE_RAN cwd_hex=' + ${CWD_PROBE}); });\n`;
    const { triple, out } = staged('wrongcwd', { tests: ['tests/wrong.test.mjs'], files: {
      'tests/wrong.test.mjs': { body: wrong, mode: 0o644 },
    } });
    const r = helper(['test', ...triple]);
    ok(r, 'test');
    const all = r.stdout + r.stderr;
    assert.throws(() => assertRanAt(all, out.root), /test cwd is not the snapshot root/);
    // The observation itself is exact: it names the directory the child actually moved to.
    assertRanAt(all, dirname(out.root));
    // Absent or repeated observations are never accepted.
    assert.throws(() => assertRanAt(all.replaceAll('FIXTURE_RAN', 'FIXTURE_GONE'), out.root), /exactly one cwd observation/);
    assert.throws(() => assertRanAt(all + all, dirname(out.root)), /exactly one cwd observation/);
  });

  test('preserves a failing test status', () => {
    const failing = "import test from 'node:test';\ntest('fixture fail', () => { throw new Error('FIXTURE_FAILED'); });\n";
    const { triple } = staged('fail', { tests: ['tests/fail.test.mjs'], files: {
      'tests/fail.test.mjs': { body: failing, mode: 0o644 },
    } });
    const r = helper(['test', ...triple]);
    assert.equal(r.error, undefined);
    assert.notEqual(r.status, 0, 'failing test reported success');
    assert.ok((r.stdout + r.stderr).includes('FIXTURE_FAILED'), 'failing test did not actually run');
  });

  // Every OS: on win32 the SIGKILL is TerminateProcess (exit 1, no signal); a killed runner is still nonzero.
  test('a test runner killed by a signal is reported nonzero', () => {
    const killer = "import test from 'node:test';\ntest('kill runner', () => { process.kill(process.ppid, 'SIGKILL'); });\n";
    const { triple } = staged('signal', { tests: ['tests/kill.test.mjs'], files: {
      'tests/kill.test.mjs': { body: killer, mode: 0o644 },
    } });
    const r = helper(['test', ...triple], { timeout: 30000 });
    assert.equal(r.error, undefined);
    assert.ok(r.status !== 0 || r.signal !== null, 'signal-killed runner reported success');
  });

  test('accepts no command, file or extra flags', () => {
    const { triple } = staged();
    for (const extra of [['--command', 'node'], ['--files', 'tests/other.test.mjs'], ['tests/other.test.mjs'], ['--', 'echo']]) {
      const r = helper(['test', ...triple, ...extra]);
      refused(r, `test ${extra.join(' ')}`);
      assert.ok(!(r.stdout + r.stderr).includes('FIXTURE_RAN'), `tests ran despite refused args ${extra.join(' ')}`);
      assert.ok(!(r.stdout + r.stderr).includes('UNDECLARED_RAN'));
    }
  });

  test('preflight verify failure runs nothing', () => {
    const { triple, out } = staged('pre');
    chmodSync(out.root, 0o755);
    writeFileSync(join(out.root, 'extra.txt'), 'x');
    const r = helper(['test', ...triple]);
    refused(r, 'test after tamper');
    assert.ok(!(r.stdout + r.stderr).includes('FIXTURE_RAN'), 'tests ran after a failed preflight');
  });

  // Inherited NODE_TEST_CONTEXT (helper launched from inside another `node --test`) makes Node skip
  // running files and exit 0; the helper must never turn that into a green result.
  test('an inherited NODE_TEST_CONTEXT never yields success without running the declared tests', () => {
    const failing = "import test from 'node:test';\ntest('fixture fail', () => { throw new Error('FIXTURE_FAILED'); });\n";
    const { triple } = staged('nested', { tests: ['tests/fail.test.mjs'], files: {
      'tests/fail.test.mjs': { body: failing, mode: 0o644 },
    } });
    const control = helper(['test', ...triple]);
    assert.notEqual(control.status, 0, 'positive control: failing test must fail without the variable');
    const r = helper(['test', ...triple], { env: { NODE_TEST_CONTEXT: 'child-v8' } });
    assert.equal(r.error, undefined);
    assert.notEqual(r.status, 0, `failing declared test reported success under inherited NODE_TEST_CONTEXT\n${r.stdout.slice(-400)}`);
  });

  test('all three flags are mandatory for test', () => {
    const { out } = staged();
    const r = helper(['test', '--root', out.root, '--manifest', out.manifest]);
    refused(r, 'test without --sha256');
    assert.ok(!(r.stdout + r.stderr).includes('FIXTURE_RAN'));
  });
});

// Focused dispatch smoke: every side-effecting seam is a recording fake under the temp root.
// A fake router stops the run (SIGKILL to its parent) so no real router, spawn, inject or tracker runs.
describe('dispatch --input-* preflight (no side effects on refusal)', () => {
  const fakeDir = fresh('fakebin');
  const log = join(fakeDir, 'calls.log');
  const fake = (name, body) => {
    const p = join(fakeDir, name);
    const load = name.endsWith('.mjs') ? "import fs from 'node:fs';" : "const fs = require('node:fs');";
    writeFileSync(p, `#!/usr/bin/env node\n${load}\n` +
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  // win32 runs the registry as `python <file>` (registryInvocation), so its fake is Python with the same log and replies.
  const REGISTRY_FAKE = POSIX ? 'registry.cjs' : 'registry.py';

  function setup() {
    mkdirSync(fakeDir, { recursive: true });
    fake('registry.cjs', "if (process.argv[2] === 'check-dedup') { process.stdout.write('{}'); process.exit(0); } process.exit(9);");
    if (!POSIX) writeFileSync(join(fakeDir, 'registry.py'), 'import json, sys\n' +
      `with open(${JSON.stringify(log)}, 'a', encoding='utf-8') as f: f.write(json.dumps(['registry.py', *sys.argv[1:]]) + '\\n')\n` +
      "if sys.argv[1:2] == ['check-dedup']:\n    sys.stdout.write('{}')\n    sys.exit(0)\nsys.exit(9)\n");
    fake('telepty.cjs', 'process.exit(1);');
    fake('open-session.cjs', 'process.exit(1);');
    fake('telemetry.cjs', 'process.exit(0);');
    fake('model-router.mjs', "process.kill(process.ppid, 'SIGKILL'); process.exit(1);");
    // dispatch may resolve its helper next to the other bin/ helpers; give it the real one.
    if (existsSync(HELPER)) writeFileSync(join(fakeDir, 'worker-inputs.mjs'), readFileSync(HELPER));
    const ref = join(fakeDir, 'ref.md');
    writeFileSync(ref, 'fixture ref\n');
    return ref;
  }

  function dispatch(ref, triple) {
    rmSync(log, { force: true });
    const home = fresh('home');
    mkdirSync(home);
    const r = spawnSync(process.execPath, [DIST_DISPATCH, '--spawn-and-dispatch', '--track', 't1172', '--name', 'smoke',
      '--cwd', home, '--cli', 'auto', '--role', 'tester', '--ref', ref, ...triple], {
      encoding: 'utf8', timeout: 60000, cwd: base,
      env: {
        ...process.env,
        PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ''),
        HOME: home, USERPROFILE: home,
        AIGENTRY_SESSIONS_ROOT: join(home, 'sessions'),
        AIGENTRY_TASK_GATE: 'off', AIGENTRY_MODEL_METADATA: 'off',
        DISPATCH_SCRIPT_DIR: fakeDir,
        DISPATCH_REGISTRY_PY: join(fakeDir, REGISTRY_FAKE),
        TELEPTY: join(fakeDir, 'telepty.cjs'),
        OPEN_SESSION_SH: join(fakeDir, 'open-session.cjs'),
        EMIT_TELEMETRY_MJS: join(fakeDir, 'telemetry.cjs'),
      },
    });
    return { status: r.status, signal: r.signal, stderr: r.stderr ?? '', calls: calls() };
  }

  const sideEffects = (cs) => cs.filter((c) => !(c[0] === REGISTRY_FAKE && c[1] === 'check-dedup'));

  test('compiled dispatch is present (run after tsc, as scripts/run-tests.mjs does)', () => {
    assert.ok(existsSync(DIST_DISPATCH), `missing ${DIST_DISPATCH}; build with tsc first`);
  });

  test('--help documents the input triple', () => {
    const r = spawnSync(process.execPath, [DIST_DISPATCH, '--help'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0);
    for (const f of ['--input-root', '--input-manifest', '--input-sha256']) assert.ok(r.stdout.includes(f), `--help lacks ${f}`);
  });

  // Every OS: on win32 the fake router's SIGKILL is TerminateProcess, identical for both runs compared here.
  test('omitted triple keeps current behaviour; valid triple behaves identically', () => {
    const ref = setup();
    const { triple } = staged('dispatch-ok');
    const triple3 = ['--input-root', triple[1], '--input-manifest', triple[3], '--input-sha256', triple[5]];
    const plain = dispatch(ref, []);
    assert.ok(plain.calls.some((c) => c[0] === 'model-router.mjs'), `baseline did not reach the router: ${JSON.stringify(plain.calls)} ${plain.stderr}`);
    const withInputs = dispatch(ref, triple3);
    assert.deepEqual(withInputs.calls, plain.calls, `valid triple changed dispatch behaviour\n${withInputs.stderr}`);
    assert.equal(withInputs.signal, plain.signal);
    assert.equal(withInputs.status, plain.status);
  });

  // Every OS: on win32 a router kill carries no signal, so sideEffects (which logs the router call) is the proof.
  test('invalid or partial triple aborts nonzero before router, spawn, inject, telemetry or tracker', () => {
    const ref = setup();
    const { triple, out } = staged('dispatch-bad');
    const cases = {
      'wrong sha': ['--input-root', triple[1], '--input-manifest', triple[3], '--input-sha256', '0'.repeat(64)],
      'root only': ['--input-root', triple[1]],
      'root+manifest': ['--input-root', triple[1], '--input-manifest', triple[3]],
      'sha only': ['--input-sha256', triple[5]],
      'missing root': ['--input-root', join(base, 'no-such-root'), '--input-manifest', triple[3], '--input-sha256', triple[5]],
    };
    // Paired positive control: the same harness without the triple does reach the (fake) router.
    const control = dispatch(ref, []);
    assert.ok(control.calls.some((c) => c[0] === 'model-router.mjs'), `control did not reach the router: ${JSON.stringify(control.calls)}`);
    for (const [name, args] of Object.entries(cases)) {
      const r = dispatch(ref, args);
      assert.equal(r.signal, null, `${name}: dispatch reached the router (killed by fake router)`);
      assert.notEqual(r.status, 0, `${name}: dispatch did not abort`);
      assert.deepEqual(sideEffects(r.calls), [], `${name}: side effects before refusal: ${JSON.stringify(r.calls)}`);
    }
    // Tampered snapshot (extra file) must also abort before side effects.
    if (POSIX) {
      chmodSync(out.root, 0o755);
      writeFileSync(join(out.root, 'planted.txt'), 'x');
      const r = dispatch(ref, ['--input-root', triple[1], '--input-manifest', triple[3], '--input-sha256', triple[5]]);
      assert.equal(r.signal, null, 'tampered snapshot: dispatch reached the router');
      assert.notEqual(r.status, 0);
      assert.deepEqual(sideEffects(r.calls), []);
    }
  });
});

describe('shipping and docs wiring', () => {
  test('init manifest ships bin/worker-inputs.mjs', () => {
    assert.ok(readFileSync(join(repoRoot, 'bin', 'init', 'manifest.mjs'), 'utf8').includes('"bin/worker-inputs.mjs"'));
  });
  test('dispatch-capacity setup doc explains the helper', () => {
    const doc = readFileSync(join(repoRoot, 'docs', 'setup', 'dispatch-capacity.md'), 'utf8');
    assert.ok(doc.includes('worker-inputs'), 'doc does not mention worker-inputs');
    assert.ok(doc.includes('declared-inputs-only') || /coverage/i.test(doc), 'doc does not state the coverage limit');
  });
  test('scripts/run-tests.mjs selects this file on every OS', () => {
    const src = readFileSync(join(repoRoot, 'scripts', 'run-tests.mjs'), 'utf8');
    const at = src.indexOf("'tests/dispatch/worker-inputs.test.mjs'");
    assert.ok(at > 0, 'not selected');
    const posixGate = src.indexOf("if (process.platform === 'darwin' || process.platform === 'linux')");
    assert.ok(posixGate < 0 || at < posixGate, 'selected only inside the POSIX gate');
  });
});
