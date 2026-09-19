// Synthetic caller preconditions only: these receipts prove no OS enforcement.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = realpathSync(process.env.T_TMP);
const [action, sid, task = '', cwd] = process.argv.slice(2);
const hash = raw => createHash('sha256').update(raw).digest('hex');
const quote = s => /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'";
const confined = file => {
  let parent = resolve(file);
  const tail = [];
  while (!existsSync(parent)) {
    tail.unshift(basename(parent));
    parent = dirname(parent);
  }
  const p = join(realpathSync(parent), ...tail);
  assert.ok(p.startsWith(root + sep), `fixture path outside root: ${p}`);
  return p;
};
const write = (file, body, mode = 0o600) => {
  confined(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, body, { mode });
};
const json = (file, data) => write(file, JSON.stringify(data));
const read = file => JSON.parse(readFileSync(confined(file), 'utf8'));
const staging = () => {
  assert.match(sid, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
  return confined(join(process.env.AIGENTRY_SESSIONS_ROOT, sid));
};
const receipt = (current, manifest) => {
  const pid = Number(process.env.T_FIXTURE_CHILD_PID);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  process.kill(pid, 0);
  json(manifest.receipt, { hash: current.hash, attempt: manifest.attempt,
    state: 'running', supervisorPid: pid, childPid: pid });
};

if (action === 'init') {
  for (const dir of ['home/.config', 'home/.cache', 'gemini-home', 'sessions', 'role-sandbox'])
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  json(join(root, 'home/.claude.json'), {});
  json(join(root, 'home/.claude/.credentials.json'), { fixture: true });
  json(join(root, 'codex-home/auth.json'), { fixture: true });
  write(join(root, 'home/.aigentry/instructions/common.md'), '# Fixture common\n');
  write(join(root, 'home/.aigentry/instructions/roles/coder.md'), '# Fixture coder\n');
  json(process.env.AIGENTRY_TASK_QUEUE, { tasks: [28, 49, 51].map(id => ({ id, status: 'pending' })) });
  const script = (name, body) => write(join(process.env.STUB_BIN, name), '#!/usr/bin/env bash\n' + body + '\n', 0o700);
  const deny = 'printf "forbidden: %s\\n" "$0 $*" >> "$T_TMP/forbidden.log"; exit 99';
  for (const name of ['fixture-deny', 'apply_patch', 'ps', 'pkill', 'killall', 'launchctl', 'open',
    'osascript', 'cmux', 'tmux', 'curl', 'wget', 'ssh', 'npm', 'npx', 'srt', 'security']) script(name, deny);
  for (const cli of ['claude', 'codex', 'gemini', 'grok', 'agy'])
    script(cli, 'if [ "$#" -eq 1 ] && [ "$1" = --version ]; then echo 9.9.9; exit 0; fi\n' + deny);
  script('fixture-probe', 'echo \'{"ready":true}\'');
  script('fixture-noop', 'exit 0');
  script('fixture-report', 'echo fixture-orchestrator');
} else if (action === 'scope') {
  staging();
  assert.ok(task, 'spawn requires an exact, nonempty task');
  mkdirSync(confined(cwd), { recursive: true });
  json(process.env.AIGENTRY_WORKER_SCOPE, { version: 1, task, sid, read: [cwd], write: [cwd], domains: [] });
} else if (action === 'target') {
  const dir = staging(), home = join(dir, 'fixture-home');
  const manifest = { version: 1, sid, task, attempt: 'fixture-attempt',
    env: { HOME: home }, receipt: join(dir, 'receipt.json') };
  mkdirSync(join(home, '.telepty/shared'), { recursive: true });
  const raw = JSON.stringify(manifest), current = { manifest: join(dir, 'manifest.json'), hash: hash(raw) };
  write(current.manifest, raw);
  json(join(dir, 'sandbox-current.json'), current);
  receipt(current, manifest);
} else if (action === 'receipt' || action === 'guard') {
  const current = read(join(staging(), 'sandbox-current.json'));
  const raw = readFileSync(confined(current.manifest), 'utf8');
  assert.equal(hash(raw), current.hash);
  const manifest = JSON.parse(raw), scope = read(process.env.AIGENTRY_WORKER_SCOPE);
  assert.deepEqual([manifest.sid, manifest.task], [sid, scope.task]);
  assert.equal(scope.sid, sid);
  assert.deepEqual(manifest.config.network.allowedDomains, []);
  assert.deepEqual(manifest.config.network.allowUnixSockets, []);
  assert.equal(manifest.config.network.allowAllUnixSockets, false);
  assert.equal(manifest.config.network.allowLocalBinding, false);
  assert.equal(manifest.config.enableWeakerNestedSandbox, false);
  assert.equal(manifest.config.enableWeakerNetworkIsolation, false);
  confined(manifest.env.TMPDIR);
  const auth = manifest.cli === 'codex' ? join(manifest.env.CODEX_HOME, 'auth.json')
    : join(manifest.env.CLAUDE_CONFIG_DIR, '.credentials.json');
  assert.deepEqual(read(auth), { fixture: true });
  receipt(current, manifest);
  if (action === 'guard') {
    // Execute the actual generated guard body. Intercept only its final exec,
    // before it can enter the native sandbox runner; run the local push stub.
    const guard = confined(task), inner = join(dirname(current.manifest), 'launcher.sh');
    assert.equal(guard, join(staging(), 'guard/worker-launcher.sh'));
    const body = readFileSync(guard, 'utf8');
    assert.ok(body.endsWith(`exec -a codex ${quote(inner)} "$@"\n`));
    const result = spawnSync('bash', ['-c',
      'exec() { [ "$#" -eq 3 ] && [ "$1" = -a ] && [ "$2" = codex ] && [ "$3" = "$FIXTURE_INNER" ] || return 98; "$FAKE_BIN/codex"; }; guard=$1; shift; source "$guard"',
      'fixture-guard', guard], { stdio: 'inherit', env: { ...process.env, FIXTURE_INNER: inner } });
    if (result.error) throw result.error;
    process.exit(result.status ?? 99);
  }
} else {
  throw new Error(`unknown fixture action: ${action}`);
}
