// Independent installed acceptance equivalents of T134 A-I; no provider behavior measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const root = fs.realpathSync(process.env.INSTALLED_PACKAGE_ROOT);
const evidence = path.resolve(process.env.BOOT_TEST_EVIDENCE);
const tmp = fs.realpathSync(process.env.TMPDIR);
const sid = 'fixture-it1171b';
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (name, data) => fs.writeFileSync(path.join(evidence, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
const noGit = dir => { for (;;) { assert.ok(!fs.existsSync(path.join(dir, '.git')), `git ancestor: ${dir}`); const up = path.dirname(dir); if (up === dir) break; dir = up; } };
assert.equal(process.version, 'v20.20.0');
noGit(tmp);
fs.mkdirSync(evidence, { recursive: true });
const fixture = fs.mkdtempSync(path.join(tmp, 'installed-boot-'));
const ws = path.join(fixture, 'workspace');
const bin = path.join(fixture, 'path');
const logs = path.join(fixture, 'logs');
for (const dir of [bin, logs]) fs.mkdirSync(dir);
// Allow only proxy/CA transport settings to survive, without logging their values.
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key) || /^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/.test(key)) env[key] = value;
}
for (const key of ['HOME', 'AIGENTRY_HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'TELEPTY_HOME', 'npm_config_cache', 'AIGENTRY_ROLE_SANDBOX_ROOT', 'AIGENTRY_STATE_DIR']) {
  env[key] = path.join(fixture, key.toLowerCase());
  fs.mkdirSync(env[key]);
}
env.PATH = bin;
env.AIGENTRY_CONTROL_WORKSPACE = ws;
env.AIGENTRY_TARGET_CWD = ws;
env.ORCHESTRATOR_SID = sid;
env.SINGLETON_SELF_PID = '3333';
const commands = [];
function run(label, cmd, args, extra = {}) {
  const r = spawnSync(cmd, args, { cwd: fixture, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
  save(`${label}.stdout`, r.stdout || ''); save(`${label}.stderr`, r.stderr || '');
  commands.push({ label, cmd, args, status: r.status, signal: r.signal, error: r.error?.message });
  save('commands.json', commands);
  return r;
}
function executable(name, body) { const file = path.join(bin, name); fs.writeFileSync(file, body, { mode: 0o700 }); return file; }
// An allowlisted PATH prevents an accidental fallback to host providers/control tools.
for (const name of ['bash', 'sh', 'mkdir', 'cp']) fs.symlinkSync(`/bin/${name}`, path.join(bin, name));
fs.symlinkSync('/usr/bin/dirname', path.join(bin, 'dirname'));
fs.symlinkSync(NODE, path.join(bin, 'node'));
fs.symlinkSync(path.join(root, 'bin/init/cli.mjs'), path.join(bin, 'aigentry-orchestrator'));
for (const name of ['jq', 'python3']) {
  // init only checks presence; fail closed if it unexpectedly tries to execute either.
  executable(name, '#!/bin/bash\nexit 97\n');
}
const kinds = ['ps', 'kill', 'list', 'curl', 'exec', 'claude', 'codex', 'cmux', 'auth'];
const recorder = (name, kind) => executable(name, `#!${NODE}\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(path.join(logs, kind + '.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');\n${kind === 'ps' ? `process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fixture, 'ps.txt'))}));` : kind === 'list' ? `process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fixture, 'list.json'))}));` : ''}\n`);
env.SINGLETON_PS_CMD = recorder('ps-recorder', 'ps');
env.KILL_CMD = recorder('kill-recorder', 'kill');
env.TELEPTY = recorder('telepty-list-recorder', 'list');
env.CURL = recorder('curl', 'curl');
recorder('telepty', 'exec');
for (const name of ['claude', 'codex', 'cmux']) recorder(name, name);
const shimRel = 'bin/orchestrator-boot.sh';
const tracked = ['package.json', 'bin/init/cli.mjs', 'bin/init/manifest.mjs', shimRel, 'bin/lib/node-shim.sh', 'bin/lib/telepty-auth.sh', 'dist/src/orchestrator-boot/cli.js', 'dist/src/orchestrator-boot/usage.js'];
const snapshot = () => Object.fromEntries(tracked.map(rel => [rel, hash(path.join(root, rel))]));
const before = snapshot();
save('installed-before.json', before);
save('fixture.json', { fixture, ws, root, sid, node: NODE, version: process.version, path: env.PATH, redirectedKeys: Object.keys(env).filter(k => !/proxy|cert|bundle/i.test(k)) });
const shim = path.join(ws, shimRel);
const calls = kind => fs.readFileSync(path.join(logs, kind + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
function reset() {
  for (const kind of kinds) fs.writeFileSync(path.join(logs, kind + '.jsonl'), '');
  const bridge = `node /fixture/telepty allow --id ${sid} --auto-restart claude --continue`;
  fs.writeFileSync(path.join(fixture, 'ps.txt'), `3333 2222 bash ${shim}\n2222 1111 node claude\n1111 1 ${bridge}\n7777 1 ${bridge}\n8888 1 /bin/zsh -c pgrep -fl telepty allow --id ${sid} --auto-restart claude\n`);
  fs.writeFileSync(path.join(fixture, 'list.json'), JSON.stringify([{ id: sid, healthStatus: 'STALE', active_clients: 0 }]));
}
const inert = (reads = false) => {
  for (const k of ['kill', 'curl', 'exec', 'claude', 'codex', 'cmux', 'auth', ...(reads ? ['ps', 'list'] : [])]) assert.deepEqual(calls(k), [], k);
};
function boot(label, args, extra = {}) {
  assert.equal(hash(shim), before[shimRel]);
  assert.equal(fs.realpathSync(path.join(bin, 'aigentry-orchestrator')), path.join(root, 'bin/init/cli.mjs'));
  assert.ok(!fs.existsSync(path.join(ws, 'dist')));
  for (const key of ['SINGLETON_PS_CMD', 'KILL_CMD', 'TELEPTY', 'CURL']) assert.ok(env[key].startsWith(bin + '/'));
  const r = run(label, '/bin/bash', [shim, ...args], extra);
  save(`${label}.recorders.json`, Object.fromEntries(kinds.map(k => [k, calls(k)])));
  return r;
}
const expected = cli => ['telepty', 'allow', '--id', sid, '--auto-restart', ...(cli === 'codex' ? ['codex', 'resume', '--last', '--dangerously-bypass-approvals-and-sandbox'] : ['claude', '--dangerously-skip-permissions', '--continue'])];

test('exact installed boot selector acceptance (independent T134 A-I)', async t => {
  reset();
  const init = run('init', NODE, [path.join(root, 'bin/init/cli.mjs'), 'init', '--workspace', ws, '--yes']);
  save('installed-after-init.json', snapshot());
  assert.deepEqual(snapshot(), before);
  if (init.status !== 0) {
    save('SETUP-BLOCKER.txt', `Installed init exit=${init.status}; no boot invocation authorized after setup failure. See init.stderr.\n`);
    assert.fail(`SETUP BLOCKER: installed init exited ${init.status}; ${init.stderr}`);
  }
  assert.equal(hash(shim), before[shimRel]);
  assert.equal(hash(path.join(ws, 'bin/lib/node-shim.sh')), before['bin/lib/node-shim.sh']);
  const auth = path.join(ws, 'bin/lib/telepty-auth.sh');
  assert.equal(hash(auth), before['bin/lib/telepty-auth.sh']);
  fs.writeFileSync(auth, `telepty_auth_token() { printf '[]\\n' >> '${path.join(logs, 'auth.jsonl')}'; printf fixture-token; }\n`);
  save('copied-provenance.json', { shim: hash(shim), nodeShim: hash(path.join(ws, 'bin/lib/node-shim.sh')), authOriginal: before['bin/lib/telepty-auth.sh'], authRecorder: hash(auth), modification: 'Only copied fixture auth helper replaced; original copied boot shim preserved.' });
  try {
    await t.test('A/B: help spellings, control SID exemption, complete installed usage', () => {
      for (const flag of ['--help', '-h']) {
        reset(); const r = boot(`help-${flag}`, [flag], { ORCHESTRATOR_SID: 'fixture\nbad', ORCHESTRATOR_CLI: 'invalid' });
        assert.equal(r.status, 0); assert.ok(r.stdout); inert(true);
        for (const flag of ['--help', '-h', '--dry-run']) assert.ok(r.stdout.includes(flag));
        const js = fs.readFileSync(path.join(root, 'dist/src/orchestrator-boot/cli.js'), 'utf8');
        const seams = [...js.matchAll(/env\.([A-Z][A-Z0-9_]*)|env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)].map(m => m[1] || m[2]);
        assert.ok(seams.length); for (const seam of seams) assert.ok(r.stdout.includes(seam), seam);
        assert.match(r.stdout, /bare invocation|with no (flag|argument)/i); assert.match(r.stdout, /exec/i); assert.match(r.stdout, /inherits cwd/);
      }
    });
    await t.test('C/G/H: exact default, explicit Claude/Codex, empty fallback argv; stale deletion intent', () => {
      for (const cli of [undefined, 'claude', 'codex', '']) {
        reset(); const r = boot(`dry-${cli === undefined ? 'default' : cli || 'empty'}`, ['--dry-run'], cli === undefined ? {} : { ORCHESTRATOR_CLI: cli });
        assert.equal(r.status, 0); inert();
        assert.deepEqual(calls('ps'), [['-eo', 'pid,ppid,command']]); assert.deepEqual(calls('list'), [['list', '--json']]);
        assert.deepEqual(r.stdout.split('\n').filter(s => s.startsWith('[would-exec] ')).map(s => s.slice(13)), expected(cli));
        assert.match(r.stdout, /would DELETE/); assert.ok(r.stdout.includes(`/api/sessions/${sid}`));
        assert.ok(!r.stdout.includes('x-telepty-token')); assert.ok(!r.stdout.includes('fixture-token'));
      }
    });
    await t.test('D: recorder kill set equals dry-run set, ancestor and mention skipped', () => {
      reset(); const real = boot('guard-probe', ['__probe', 'singleton-guard']);
      assert.equal(real.status, 0); assert.deepEqual(calls('kill'), [['-9', '7777']]);
      for (const k of ['curl', 'exec', 'auth', 'list']) assert.deepEqual(calls(k), []);
      reset(); const dry = boot('guard-dry', ['--dry-run']); assert.equal(dry.status, 0); inert();
      assert.deepEqual([...dry.stdout.matchAll(/would SIGKILL[^=]*pid=(\d+)/g)].map(m => m[1]), ['7777']);
      assert.match(dry.stdout, /skip self\/ancestor bridge pid=1111/); assert.match(dry.stdout, /8888/);
    });
    await t.test('E/I: unknown flags and invalid/control selectors refuse before reads', () => {
      for (const [i, args] of [['one', ['--bogus-flag']], ['two', ['--dry-run', '--bogus']]]) {
        reset(); const r = boot(`unknown-${i}`, args); assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /--bogus/); assert.match(r.stderr, /Usage:/); inert(true);
      }
      for (const [i, cli] of ['unknown', 'codex\nextra', 'codex\t', 'claude\r', 'codex\x7f'].entries()) {
        reset(); const r = boot(`invalid-${i}`, ['--dry-run'], { ORCHESTRATOR_CLI: cli });
        assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /ORCHESTRATOR_CLI/); assert.match(r.stderr, /Usage:/); inert(true);
      }
    });
    await t.test('F: early closed stdout remains inert', () => {
      for (const flag of ['--help', '--dry-run']) {
        reset();
        const statusFile = path.join(evidence, `pipe-${flag}.statuses.json`);
        const r = run(`pipe-${flag}`, '/bin/bash', ['-c', 'set -o pipefail; "$1" "$2" | /usr/bin/head -2; statuses=("${PIPESTATUS[@]}"); printf \'{"boot":%s,"head":%s}\\n\' "${statuses[0]}" "${statuses[1]}" > "$3"; (( statuses[0] == 0 && statuses[1] == 0 ))', '_', shim, flag, statusFile]);
        save(`pipe-${flag}.recorders.json`, Object.fromEntries(kinds.map(k => [k, calls(k)])));
        // The installed no-exec writer swallows EPIPE; the producer must exit 0 too.
        assert.deepEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')), { boot: 0, head: 0 });
        assert.equal(r.status, 0); assert.ok(r.stdout); inert();
      }
    });
    await t.test('original shim bare argv handoff reaches only exec recorder', () => {
      for (const cli of ['claude', 'codex']) {
        reset(); fs.writeFileSync(path.join(fixture, 'ps.txt'), ''); fs.writeFileSync(path.join(fixture, 'list.json'), '[]');
        const r = boot(`handoff-${cli}`, [], { ORCHESTRATOR_CLI: cli });
        assert.equal(r.status, 0); assert.equal(r.stdout, ''); assert.deepEqual(calls('exec'), [expected(cli).slice(1)]);
        for (const k of ['kill', 'curl', 'auth', 'claude', 'codex', 'cmux']) assert.deepEqual(calls(k), []);
      }
    });
  } finally {
    save('installed-after.json', snapshot()); assert.deepEqual(snapshot(), before); assert.equal(hash(shim), before[shimRel]);
    save('copied-shim-after.sha256', hash(shim) + '\n');
  }
});
