// #1167 PLAN-ENTRY §4.3 (lane L3) — the init entry point on every OS. Runs the real bin/init/cli.mjs of
// this checkout in fresh temp homes and workspaces; every test asserts its own platform's branch, so
// nothing is skipped (P7). Node built-ins only.
//
// Observation seam: a preload (`node --import <hook>`, written into the temp run) can fake
// process.platform, observe the legacy init lock while init holds it, and answer or record
// child_process.spawnSync calls inside the init process. Everything it does not answer runs for real.
//
// Root: INIT_PLATFORM_TEST_ROOT (an existing absolute directory) or else the first of os.tmpdir() and
// the home directory that is outside Git and, on POSIX, passes init's lock ancestry rule (no symlink,
// owned by root or this user, not group/world-writable). win32 needs Git for Windows bash, jq and
// `python` (W-D1) and an LF checkout of the shell scripts (W-D4).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(repo, 'bin', 'init', 'cli.mjs');
const CHECK = path.join(repo, 'tests', 'packaging', 'installed-init-check.mjs');
const VERSION = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const LOCK = '.aigentry-native-capture.lock';

function insideGit(dir) {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return true;
    if (cur === path.dirname(cur)) return false;
  }
}
function lockAncestryOk(dir) {
  if (WIN) return true; // the win32 lock is verified by its ACL (C7), not by ancestor modes
  for (let cur = dir; ; cur = path.dirname(cur)) {
    const s = fs.lstatSync(cur);
    if (!s.isDirectory() || s.isSymbolicLink() || !(s.uid === 0 || s.uid === process.getuid()) || (s.mode & 0o022) !== 0) return false;
    if (cur === path.dirname(cur)) return true;
  }
}
function pickRoot() {
  const explicit = process.env.INIT_PLATFORM_TEST_ROOT;
  if (explicit) {
    assert.ok(path.isAbsolute(explicit), 'INIT_PLATFORM_TEST_ROOT must be absolute');
    const root = fs.realpathSync.native(explicit);
    assert.ok(!insideGit(root) && lockAncestryOk(root), `INIT_PLATFORM_TEST_ROOT is inside Git or has an unsafe ancestor: ${root}`);
    return root;
  }
  for (const candidate of [os.tmpdir(), os.homedir()]) {
    const root = fs.realpathSync.native(candidate);
    if (!insideGit(root) && lockAncestryOk(root)) return root;
  }
  assert.fail('no fixture root outside Git with a safe ancestry; set INIT_PLATFORM_TEST_ROOT');
}

const run = fs.mkdtempSync(path.join(pickRoot(), 'init-platform-'));
after(() => fs.rmSync(run, { recursive: true, force: true }));

const HOOK = path.join(run, 'init-hook.mjs');
fs.writeFileSync(HOOK, String.raw`
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(process.env.INIT_HOOK);
delete process.env.INIT_HOOK;
const log = (entry) => fs.appendFileSync(cfg.log, JSON.stringify(entry) + '\n');
if (cfg.platform) Object.defineProperty(process, 'platform', { value: cfg.platform });
for (const [key, value] of Object.entries(cfg.env || {})) process.env[key] = value;
const acl = cfg.acl ? await import(cfg.acl) : null;
const answer = (stdout) => ({ pid: 0, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null });
function observe(lock) {
  const owner = path.join(lock, 'owner.json');
  const facts = {};
  try {
    facts.owner = JSON.parse(fs.readFileSync(owner, 'utf8'));
    if (process.platform === 'win32') {
      facts.lockPrivate = acl.isPrivate(lock);
      facts.ownerPrivate = acl.isPrivate(owner);
    } else {
      const d = fs.lstatSync(lock), f = fs.lstatSync(owner);
      Object.assign(facts, { lockMode: d.mode & 0o777, ownerMode: f.mode & 0o777, lockUid: d.uid, ownerUid: f.uid,
        uid: process.getuid() });
    }
  } catch (error) { facts.error = String(error && error.stack || error); }
  return facts;
}
const cp = createRequire(import.meta.url)('node:child_process');
const real = cp.spawnSync;
cp.spawnSync = function hooked(file, args, options) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  log({ file: String(file), args: argv, aigentryHome: options && options.env ? options.env.AIGENTRY_HOME ?? null : null,
    env: Boolean(options && options.env) });
  if (cfg.answers) {
    if (argv.length === 2 && argv[0] === '-c' && argv[1] === 'uname -s') return answer((cfg.answers[String(file)] || 'Linux') + '\n');
    const name = path.basename(String(file)).toLowerCase();
    if (name === 'jq.exe') return answer('jq-1.7.1\n');
    if (name === 'python.exe') return answer('Python 3.12.0\n');
    throw new Error('init-hook: unexpected spawn of ' + file);
  }
  if (cfg.observe && argv.some((a) => /install-instructions\.sh$/.test(a))) {
    log({ lock: observe(cfg.observe) });
    return answer('created file: ' + cfg.unreadable + '\n');
  }
  return real.call(this, file, args, options);
};
syncBuiltinESMExports();
`);

let seq = 0;
function fixture(label) {
  const dir = path.join(run, `${++seq}-${label}`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return { dir, home, ws: path.join(dir, 'ws'), log: path.join(dir, 'hook.jsonl'), aigentry: path.join(home, '.aigentry') };
}
// A fresh HOME/USERPROFILE, AIGENTRY_HOME and the workspace override unset; PATH optionally replaced.
function envFor(f, pathValue) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(AIGENTRY_HOME|AIGENTRY_CONTROL_WORKSPACE|DISPATCH_STATE_DIR|INIT_HOOK|NODE_OPTIONS)$/i.test(key)) continue;
    if (pathValue !== undefined && /^path$/i.test(key)) continue;
    env[key] = value;
  }
  env.HOME = f.home;
  env.USERPROFILE = f.home;
  if (pathValue !== undefined) env.PATH = pathValue;
  return env;
}
function cli(f, args, { hook, pathValue } = {}) {
  const env = envFor(f, pathValue);
  if (hook) env.INIT_HOOK = JSON.stringify({ log: f.log, ...hook });
  const argv = [...(hook ? ['--import', pathToFileURL(HOOK).href] : []), CLI, ...args];
  const r = spawnSync(process.execPath, argv, { cwd: f.dir, env, encoding: 'utf8', windowsHide: true, timeout: 600_000 });
  assert.ifError(r.error);
  r.text = `exit ${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
  return r;
}
const hookLog = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const empty = (dir) => fs.readdirSync(dir).length === 0;

test('--version prints the package version and exits 0', () => {
  const f = fixture('version');
  const r = cli(f, ['--version']);
  assert.equal(r.status, 0, r.text);
  assert.equal(r.stdout, `${VERSION}\n`);
});

test('an unsupported platform is refused with exit 2 and the supported-platform text; nothing is written', () => {
  const f = fixture('unknown-platform');
  const r = cli(f, ['init', '--yes', '--workspace', f.ws], { hook: { platform: 'sunos' } });
  assert.equal(r.status, 2, r.text);
  assert.match(r.stderr, /aigentry-orchestrator supports macOS, Linux and Windows; detected sunos \(/);
  assert.doesNotMatch(r.stderr, /WSL2|does not support Windows natively/);
  assert.equal(fs.existsSync(f.ws), false);
  assert.ok(empty(f.home));
});

test('init succeeds in a fresh home, releases its lock, produces the checked tree and refuses a plain re-init with 4', () => {
  for (const rel of ['bin/install-instructions.sh', 'bin/lib/node-shim.sh']) {
    assert.ok(!fs.readFileSync(path.join(repo, rel)).includes(0x0d),
      `${rel} has CR line endings; check the repository out with core.autocrlf false (W-D4) so bash can run it`);
  }
  const f = fixture('fresh');
  const r = cli(f, ['init', '--yes', '--workspace', f.ws]);
  assert.equal(r.status, 0, r.text);
  assert.equal(fs.existsSync(path.join(f.ws, LOCK)), false, 'the legacy init lock must be released');
  const checked = spawnSync(process.execPath, [CHECK, '--package', repo, '--workspace', f.ws, '--home', f.aigentry],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(checked.error);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  const guide = fs.readFileSync(path.join(f.ws, 'GETTING-STARTED.md'), 'utf8');
  if (WIN) {
    assert.ok(guide.includes('  3. bash bin/orchestrator-boot.sh  # from Git Bash; boots the orchestrator session\n'), guide);
    assert.ok(guide.includes('Confined worker spawn is unavailable on native Windows (SANDBOX_PLATFORM_UNSUPPORTED, exit 78)'), guide);
    assert.ok(guide.includes('Native request capture (--capture-root/--preservation-root) is unavailable on native Windows'), guide);
  } else {
    assert.ok(guide.includes('  3. bin/orchestrator-boot.sh       # boots the orchestrator session\n'), guide);
    assert.ok(guide.includes('SIGTERM cascades a close to the live one.\n\nNot installed by init:\n'), guide);
    assert.ok(!guide.includes('SANDBOX_PLATFORM_UNSUPPORTED') && !guide.includes('Git Bash'), guide);
  }
  const again = cli(f, ['init', '--yes', '--workspace', f.ws]);
  assert.equal(again.status, 4, again.text);
  assert.match(again.stderr, /already an initialised control workspace/);
});

test('the legacy init lock is private while init holds it; the scaffold runs through the platform bash', () => {
  const f = fixture('observe');
  const unreadable = WIN ? `/c/aigentry-unreadable-${randomUUID()}/instructions/common.md`
    : `/aigentry-unreadable-${randomUUID()}/instructions/common.md`;
  const hook = { observe: path.join(f.ws, LOCK), unreadable,
    acl: WIN ? pathToFileURL(path.join(repo, 'tests', 'helpers', 'win-acl.mjs')).href : null };
  const r = cli(f, ['init', '--yes', '--workspace', f.ws], { hook });
  const entries = hookLog(f);
  const observed = entries.filter((e) => e.lock).map((e) => e.lock);
  assert.equal(observed.length, 1, r.text);
  const [lock] = observed;
  assert.equal(lock.error, undefined, lock.error);
  assert.equal(lock.owner.kind, 'legacy-init');
  const calls = entries.filter((e) => e.file);
  const scaffold = calls.filter((c) => c.args.some((a) => /install-instructions\.sh$/.test(a)));
  assert.equal(scaffold.length, 1);
  const unames = calls.filter((c) => c.args.length === 2 && c.args[0] === '-c' && c.args[1] === 'uname -s');
  if (WIN) {
    // C7: the lock directory and owner.json verify private (product verify AND the icacls oracle) mid-operation.
    assert.equal(lock.lockPrivate, true);
    assert.equal(lock.ownerPrivate, true);
    // C5: Git bash by absolute path, probed with uname first, a `/`-separated script path and AIGENTRY_HOME.
    assert.ok(path.isAbsolute(scaffold[0].file) && /\\bash\.exe$/i.test(scaffold[0].file), scaffold[0].file);
    assert.deepEqual(unames.map((c) => c.file), [scaffold[0].file]);
    assert.equal(scaffold[0].args[0], path.join(f.ws, 'bin', 'install-instructions.sh').replaceAll('\\', '/'));
    assert.equal(scaffold[0].aigentryHome, f.aigentry.replaceAll('\\', '/'));
    assert.ok(!calls.some((c) => c.file === '/bin/sh'));
    // C6: a scaffold path Node cannot read is exit 7, not a silent skip.
    assert.equal(r.status, 7, r.text);
    assert.ok(r.stderr.includes(`${unreadable} was written by install-instructions.sh but cannot be read for substitution`), r.text);
  } else {
    // POSIX: the lock is a 0700 directory with a 0600 owner.json, both owned by this user.
    assert.deepEqual([lock.lockMode, lock.ownerMode, lock.lockUid, lock.ownerUid], [0o700, 0o600, lock.uid, lock.uid]);
    // POSIX keeps `/bin/sh -c command -v`, `bash` by name with the unchanged argv and environment, no uname probe.
    for (const tool of ['jq', 'python3']) {
      assert.ok(calls.some((c) => c.file === '/bin/sh' && c.args[0] === '-c' && c.args[1] === `command -v ${tool}`), tool);
    }
    assert.equal(scaffold[0].file, 'bash');
    assert.deepEqual(scaffold[0].args, [path.join(f.ws, 'bin', 'install-instructions.sh')]);
    assert.equal(scaffold[0].env, false);
    assert.deepEqual(unames, []);
    // POSIX keeps `continue` for an unreadable scaffold path, and the finisher releases the lock.
    assert.equal(r.status, 0, r.text);
    assert.equal(fs.existsSync(path.join(f.ws, LOCK)), false);
  }
});

test('bash resolution: win32 skips the SystemRoot and WindowsApps candidates and refuses a non-MINGW bash; POSIX runs bash by name', () => {
  if (WIN) {
    const f = fixture('git-bash');
    const put = (...parts) => {
      const file = path.join(f.dir, ...parts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      return file;
    };
    const systemRoot = path.join(f.dir, 'SystemRoot'), localAppData = path.join(f.dir, 'LocalAppData');
    const wslBash = put('SystemRoot', 'System32', 'bash.exe');
    const aliasBash = put('LocalAppData', 'Microsoft', 'WindowsApps', 'bash.exe');
    put('tools', 'jq.exe');
    put('tools', 'python.exe');
    const otherBash = put('other', 'bash.exe');
    put('Git', 'cmd', 'git.exe');
    const gitBash = put('Git', 'bin', 'bash.exe');
    const env = { SystemRoot: systemRoot, LOCALAPPDATA: localAppData };
    // Both skipped candidates would be accepted (MINGW) if they were ever probed.
    const answers = { [wslBash]: 'MINGW64_NT-10.0', [aliasBash]: 'MINGW64_NT-10.0' };
    const front = [path.dirname(wslBash), path.dirname(aliasBash), path.join(f.dir, 'tools')];
    for (const [label, rest, refused] of [
      ['PATH bash.exe', [path.join(f.dir, 'other')], otherBash],
      ['bash.exe next to git.exe', [path.join(f.dir, 'Git', 'cmd')], gitBash],
    ]) {
      fs.rmSync(f.log, { force: true });
      const r = cli(f, ['init', '--yes', '--workspace', f.ws],
        { hook: { env, answers }, pathValue: [...front, ...rest].join(path.delimiter) });
      assert.equal(r.status, 3, `${label}: ${r.text}`);
      assert.ok(r.stderr.includes(`${refused} is not Git for Windows bash (\`uname -s\` printed "Linux"`), `${label}: ${r.text}`);
      assert.match(r.stderr, /winget install Git\.Git/);
      const probed = hookLog(f).filter((e) => e.file).map((e) => e.file);
      assert.ok(!probed.includes(wslBash) && !probed.includes(aliasBash), `${label}: probed ${probed.join(', ')}`);
      assert.equal(fs.existsSync(f.ws), false);
      assert.ok(empty(f.home));
    }
  } else {
    // POSIX: no uname probe; the scaffold runs the `bash` that PATH names, with the script as its only argument.
    const f = fixture('posix-bash');
    const bin = path.join(f.dir, 'bin');
    const marker = path.join(f.dir, 'bash-calls.txt');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'bash'), `#!/bin/sh\nprintf '%s\\n' "$#" "$@" >> '${marker}'\nexec /bin/bash "$@"\n`, { mode: 0o700 });
    const r = cli(f, ['init', '--yes', '--workspace', f.ws], { pathValue: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(r.status, 0, r.text);
    assert.equal(fs.readFileSync(marker, 'utf8'), `1\n${path.join(f.ws, 'bin', 'install-instructions.sh')}\n`);
  }
});

test('native capture options: win32 refuses with exit 2 and writes nothing; POSIX keeps the native-capture path', () => {
  const f = fixture('native');
  const capture = path.join(f.dir, 'capture'), backup = path.join(f.dir, 'backup');
  fs.mkdirSync(capture);
  fs.mkdirSync(backup);
  const roots = ['--capture-root', capture, '--preservation-root', backup];
  const id = randomUUID();
  for (const args of [
    ['init', '--yes', '--workspace', f.ws, ...roots],
    ['init', '--workspace', f.ws, '--inspect-native', id, ...roots],
    ['init', '--workspace', f.ws, '--restore-native', id, ...roots],
  ]) {
    const r = cli(f, args);
    if (WIN) {
      assert.equal(r.status, 2, r.text);
      assert.match(r.stderr, /native request capture \(--capture-root, --preservation-root, --inspect-native, --restore-native\) is not available on native Windows in 0\.2\.2/);
    } else {
      // The roots are not provisioned (no workspace), so the unchanged POSIX adapter refuses them itself.
      assert.equal(r.status, 1, r.text);
      assert.match(r.stderr, /Native capture refused: /);
      assert.doesNotMatch(r.stderr, /native Windows/);
    }
    assert.equal(fs.existsSync(f.ws), false);
    assert.ok(empty(f.home) && empty(capture) && empty(backup));
  }
});
