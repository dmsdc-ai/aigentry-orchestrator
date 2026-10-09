// Independent installed acceptance equivalents of T134 A-I; no provider behavior measured.
//
// ── #1181 v2 ORACLE MIGRATION (bt1181jm). READ THIS BEFORE RUNNING. ────────────────
//
// ⚠️ THIS FILE WAS AMENDED BUT NOT EXECUTED in the bt1181jm acceptance. It needs
// `INSTALLED_PACKAGE_ROOT` to point at a REAL installed @dmsdc-ai/aigentry-orchestrator
// and it runs `bin/init/cli.mjs init`, i.e. an installation lifecycle step. That gate was
// explicitly out of scope for that session (no npm/npx/install), so the amendments below
// are RED-BY-CONSTRUCTION-BUT-UNVERIFIED: they encode the corrected oracle, and the first
// run of this file against a real install is still owed. Do not read a green T131/T134 as
// evidence for this file.
//
// WHAT WAS AMENDED AND WHY.
//
//  1. H1 — the staged/`tracked` set carried only `dist/src/orchestrator-boot/cli.js` and
//     `usage.js`. Since #1181 cli.js imports ./plan.js and ./wizard.js, and plan.js
//     imports ./provider-capabilities.js. Hashing (and, in the T131/T134 fixtures,
//     copying) two of five files means the boot dies at import with ERR_MODULE_NOT_FOUND
//     and the immutability snapshot silently stops covering three files that ARE part of
//     the shipped implementation.
//
//  2. THE REMOVED BYPASS DOOR. `expected(cli)` hardcoded
//         claude --dangerously-skip-permissions --continue
//         codex resume --last --dangerously-bypass-approvals-and-sandbox
//     and the `handoff-*`, C/G/H rows asserted that a bare non-TTY invocation with only
//     `ORCHESTRATOR_CLI` set produced them. That behaviour was deliberately removed: a
//     variable naming an EXECUTABLE may no longer select a permission bypass and a
//     session resume. Those rows are re-expressed as COMPLETE EXPLICIT PLANS, and a new
//     row asserts the refusal that replaced the old default. The empty-string
//     `ORCHESTRATOR_CLI` row, which used to fall back to claude+bypass, becomes a
//     refusal row for the same reason.
//
//  3. The plans used here are BENIGN — the most restrictive value on every axis, history
//     `new`, and therefore no `AIGENTRY_BOOT_RISK_ACK` anywhere in this file. An elevated
//     plan would have preserved the old argv and hidden the migration.
//
// Nothing was relaxed: every inertness assertion, every hash check and every
// `assert.deepEqual(snapshot(), before)` is unchanged.
//
// ── #1181 io1181km-v1 CORRECTIONS (controller-reviewed; first installed run was it1181kl-v2) ──
//
//  1. A PLAIN re-init of an initialised workspace is REFUSED (exit 4, resolveWorkspace)
//     before copyManifest runs. The subtest now pins that refusal and the operator's
//     bytes, instead of expecting a success that the init contract cannot reach.
//  2. Refusals print the installed USAGE, which DOCUMENTS the removed tails. The bypass
//     check runs on stdout and on the diagnostic that precedes the usage, both pinned
//     exactly. Positive controls keep that check from passing vacuously.
//  3. D: `__probe` is plan-gated, and it shares the dry-run effect gate, so it never
//     signals. The real recorder kill set comes from a planned bare boot. Probe, dry run and
//     boot must name the same pid. A probe with no plan stays inert.
//  4. F: the --dry-run pipe row carries the same benign plan. --help stays plan-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
for (const key of ['HOME', 'AIGENTRY_HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'CLAUDE_CODE_TMPDIR', 'TELEPTY_HOME', 'npm_config_cache', 'AIGENTRY_ROLE_SANDBOX_ROOT', 'AIGENTRY_STATE_DIR']) {
  env[key] = path.join(fixture, key.toLowerCase());
  fs.mkdirSync(env[key]);
}
env.PATH = bin;
// #1201: this file pins argv; the context handoff is T135's subject. Every transcript-store root
// above (HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME) is an empty fixture dir as well.
env.AIGENTRY_HANDOFF = 'off';
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
// gemini and grok join the recorder set: #1181 registers four providers, and "no
// provider is executed to describe it" is only measurable for a provider that has a
// recorder. Without them the two new rows would have nothing to assert against.
const kinds = ['ps', 'kill', 'list', 'curl', 'exec', 'claude', 'codex', 'gemini', 'grok', 'cmux', 'auth'];
const recorder = (name, kind) => executable(name, `#!${NODE}\nconst fs=require('node:fs');\nfs.appendFileSync(${JSON.stringify(path.join(logs, kind + '.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');\n${kind === 'ps' ? `process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fixture, 'ps.txt'))}));` : kind === 'list' ? `process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fixture, 'list.json'))}));` : ''}\n`);
env.SINGLETON_PS_CMD = recorder('ps-recorder', 'ps');
env.KILL_CMD = recorder('kill-recorder', 'kill');
env.TELEPTY = recorder('telepty-list-recorder', 'list');
env.CURL = recorder('curl', 'curl');
recorder('telepty', 'exec');
for (const name of ['claude', 'codex', 'gemini', 'grok', 'cmux']) recorder(name, name);
const shimRel = 'bin/orchestrator-boot.sh';
// H1 — the WHOLE compiled boot module. cli.js imports ./plan.js and ./wizard.js; plan.js
// imports ./provider-capabilities.js. Tracking two of five left three shipped files
// outside the immutability snapshot entirely.
const bootModule = ['cli.js', 'usage.js', 'plan.js', 'wizard.js', 'provider-capabilities.js']
  .map(f => `dist/src/orchestrator-boot/${f}`);
// #1181 v4: the doc usage.ts cites is now shipped AND init-placed, so it belongs in the
// immutability snapshot beside the rest of the governance surface.
const BOOT_DOC = 'docs/setup/orchestrator-boot.md';
const tracked = ['package.json', 'bin/init/cli.mjs', 'bin/init/manifest.mjs', BOOT_DOC, shimRel, 'bin/lib/node-shim.sh', 'bin/lib/telepty-auth.sh', ...bootModule];
for (const rel of bootModule) {
  assert.ok(fs.existsSync(path.join(root, rel)),
    `GAP: the installed package is missing ${rel}. The boot module cannot import, so no boot assertion below can fail for the right reason.`);
}
const snapshot = () => Object.fromEntries(tracked.map(rel => [rel, hash(path.join(root, rel))]));
const before = snapshot();
save('installed-before.json', before);
save('fixture.json', { fixture, ws, root, sid, node: NODE, version: process.version, path: env.PATH, redirectedKeys: Object.keys(env).filter(k => !/proxy|cert|bundle/i.test(k)) });
const shim = path.join(ws, shimRel);
const calls = kind => fs.readFileSync(path.join(logs, kind + '.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
// Every file/dir/link under a directory, with its mode and content hash. Used to show that a refused
// re-init wrote nothing at all. That covers upgrade backups and the stamp as well as the doc.
const treeSnap = dir => {
  const out = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), rel = path.relative(dir, p);
      if (e.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) { out[rel + '/'] = (fs.statSync(p).mode & 0o7777).toString(8); walk(p); }
      else out[rel] = `${(fs.statSync(p).mode & 0o7777).toString(8)}:${hash(p)}`;
    }
  })(dir);
  return out;
};
// The installed usage, byte for byte. A refusal's stderr is EXACTLY `<diagnostic><USAGE>\n`.
// USAGE documents the removed tails literally, so the bypass check applies to the diagnostic
// and to stdout (the exec channel), never to the documentation.
const { USAGE } = await import(pathToFileURL(path.join(root, 'dist/src/orchestrator-boot/usage.js')).href);
const BYPASS = /--dangerously-(skip-permissions|bypass-approvals-and-sandbox)/;
const NO_FALLBACK = 'There is no fallback. An incomplete plan is never completed with a default permission, a\n' +
  "silent resume, or a hardcoded bypass argv. On a terminal, run a bare 'bin/orchestrator-boot.sh'\n" +
  "and choose; to produce this environment from a reviewed plan, run '--wizard-plan'.\n";
const PLAN_REFUSED = 'orchestrator-boot.sh: refusing to boot — the boot plan is not complete/valid.\n';
const MISSING_PLAN = PLAN_REFUSED +
  '  AIGENTRY_BOOT_PLAN =1 is required, with a complete plan, for any boot that is not an interactive wizard on a terminal. ' +
  'ORCHESTRATOR_CLI alone is not authority for a permission mode or for resuming a conversation, and there is no longer a default for either\n' +
  NO_FALLBACK;
function refusal(r, diagnostic, label) {
  assert.equal(r.status, 2, `${label}: expected exit 2, got ${r.status}; ${r.stderr}`);
  assert.equal(r.stdout, '', `${label}: a refusal wrote to the exec-argv channel`);
  assert.ok(r.stderr.endsWith(`${USAGE}\n`), `${label}: the refusal did not end with the installed usage`);
  const diag = r.stderr.slice(0, r.stderr.length - USAGE.length - 1);
  assert.equal(diag, diagnostic, `${label}: unexpected refusal diagnostic`);
  assert.ok(!BYPASS.test(diag) && !BYPASS.test(r.stdout), `${label}: a refusal echoed a removed bypass argv`);
}
function reset() {
  for (const kind of kinds) fs.writeFileSync(path.join(logs, kind + '.jsonl'), '');
  const bridge = `node /fixture/telepty allow --id ${sid} --auto-restart claude --continue`;
  fs.writeFileSync(path.join(fixture, 'ps.txt'), `3333 2222 bash ${shim}\n2222 1111 node claude\n1111 1 ${bridge}\n7777 1 ${bridge}\n8888 1 /bin/zsh -c pgrep -fl telepty allow --id ${sid} --auto-restart claude\n`);
  fs.writeFileSync(path.join(fixture, 'list.json'), JSON.stringify([{ id: sid, healthStatus: 'STALE', active_clients: 0 }]));
}
const inert = (reads = false) => {
  for (const k of ['kill', 'curl', 'exec', 'claude', 'codex', 'gemini', 'grok', 'cmux', 'auth', ...(reads ? ['ps', 'list'] : [])]) assert.deepEqual(calls(k), [], k);
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
// ── the four providers, as COMPLETE BENIGN PLANS ────────────────────────────────────
// One entry per registered provider: the permission field naming EVERY axis that
// provider has at its most restrictive measured value, and the provider tail that must
// result. The tails are written literally, so this file states the mapping independently
// rather than restating whatever the implementation computed.
//
// Note how little they have in common. claude has ONE axis and no --sandbox at all;
// codex spells approval `--ask-for-approval`; gemini's sandbox is a BOOLEAN whose 'on'
// contributes a bare `--sandbox`; grok spells `--permission-mode` exactly like claude
// and means something else by it. A shared enum would make two of these four wrong.
const PLANS = {
  claude: { permission: 'approval=manual', tail: ['claude', '--permission-mode', 'manual'] },
  codex: { permission: 'approval=on-request;sandbox=read-only', tail: ['codex', '--ask-for-approval', 'on-request', '--sandbox', 'read-only'] },
  gemini: { permission: 'approval=default;sandbox=on', tail: ['gemini', '--approval-mode', 'default', '--sandbox'] },
  grok: { permission: 'approval=default;sandbox=strict', tail: ['grok', '--permission-mode', 'default', '--sandbox', 'strict'] },
};
/** The env a non-TTY caller must now state. No AIGENTRY_BOOT_RISK_ACK: nothing here is elevated. */
const planEnv = cli => ({ AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: cli, AIGENTRY_BOOT_PERMISSION: PLANS[cli].permission, AIGENTRY_BOOT_HISTORY: 'new' });
const expected = cli => ['telepty', 'allow', '--id', sid, '--auto-restart', ...PLANS[cli].tail];

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
    await t.test('#1181 v4: the boot doc is shipped, init-placed, and NOT overwritten', async () => {
      // THIS is where the declaration becomes a fact. The wizard suite can only read
      // package.json and MANIFEST from source; here there is a real installed root and
      // init has actually run, so the doc either materialised in the workspace or it
      // did not. Nothing below is a source check.
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      assert.ok(pkg.files.includes(BOOT_DOC), `the installed package.json does not ship ${BOOT_DOC}`);
      const manifest = await import(pathToFileURL(path.join(root, 'bin/init/manifest.mjs')).href);
      assert.deepEqual(manifest.MANIFEST.filter(p => p.startsWith('docs/setup/')), [BOOT_DOC],
        'init must place exactly one docs/setup leaf');
      assert.ok(manifest.GOVERNANCE_ROOTS.includes(BOOT_DOC));
      assert.ok(!manifest.GOVERNANCE_ROOTS.includes('docs/setup/'),
        'docs/setup/ as a root would require MANIFEST entries for the other shipped setup docs');

      // MATERIALISED, byte-identical to the package's copy.
      const placed = path.join(ws, BOOT_DOC);
      assert.ok(fs.existsSync(placed), `init did not place ${BOOT_DOC} into the workspace`);
      assert.equal(hash(placed), before[BOOT_DOC], 'the placed doc differs from the shipped one');
      assert.equal(fs.statSync(placed).mode & 0o777, 0o644, 'the placed doc is not 0644');
      // The usage text cites this path; on an installed host it must resolve to content.
      assert.ok(fs.readFileSync(placed, 'utf8').length > 0, 'the placed doc is empty');
      save('boot-doc-placed.json', { path: placed, sha256: hash(placed), packaged: before[BOOT_DOC] });

      // NO-OVERWRITE, driven rather than read: edit the placed copy, re-run a PLAIN init,
      // and the operator's bytes must survive. --force/--upgrade are the only ways past
      // that branch and neither is passed here.
      // (io1181km) On an INITIALISED workspace resolveWorkspace refuses a plain init with exit 4
      // before copyManifest runs. That refusal is the contract pinned here. The test does not
      // treat it as a successful init and does not expect upgrade backups.
      const pristine = fs.readFileSync(placed);
      try {
        fs.writeFileSync(placed, '# EDITED BY THE OPERATOR\n' + pristine.toString('utf8'));
        const editedHash = hash(placed);
        const wsBefore = treeSnap(ws);
        reset();
        const again = run('init-rerun', NODE, [path.join(root, 'bin/init/cli.mjs'), 'init', '--workspace', ws, '--yes']);
        assert.equal(again.status, 4, `a plain re-init of an initialised workspace exited ${again.status}, not the exit-4 refusal: ${again.stderr}`);
        assert.ok(again.stderr.includes(`\nERR  ${ws} is already an initialised control workspace. Pick one:\n` +
          '  --upgrade  re-copy the manifest, list what changed, leave state/ untouched\n' +
          '  --force    overwrite the whole governance layer, including files you edited\n' +
          'state/ is never deleted by either.\n'), `the exit-4 refusal is not the initialised-workspace one: ${again.stderr}`);
        // Refused at Step 2, BEFORE the governance copy. Nothing was preserved, skipped or written.
        assert.match(again.stdout, /==> Step 2 — control workspace/);
        assert.ok(!again.stdout.includes('Step 3'), 'the refused re-init reached copyManifest');
        assert.ok(!/preserved|written|Step 8/.test(again.stdout + again.stderr), 'the refused re-init reported a copy summary');
        assert.equal(hash(placed), editedHash, 'a refused plain re-init changed the operator-edited governance doc');
        assert.deepEqual(treeSnap(ws), wsBefore, 'a refused plain re-init changed the workspace');
        inert(true);
      } finally {
        // Restore the fixture's own bytes (not via init), so the checks below compare like for like.
        fs.writeFileSync(placed, pristine);
      }
      assert.equal(hash(placed), before[BOOT_DOC]);
      // And the PACKAGE was never written to by any of this.
      assert.deepEqual(snapshot(), before);
    });
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
    await t.test('C/G/H: all four providers from an explicit plan; stale deletion intent', () => {
      // WAS: [undefined, 'claude', 'codex', ''] — the `undefined` and `''` rows asserted
      // that a MISSING provider still booted, into a hardcoded bypass. Both are refusals
      // now (next subtest). The remaining rows become complete explicit plans, and the
      // set grows from two real providers to four.
      for (const cli of ['claude', 'codex', 'gemini', 'grok']) {
        reset(); const r = boot(`dry-${cli}`, ['--dry-run'], planEnv(cli));
        assert.equal(r.status, 0, r.stderr); inert();
        assert.deepEqual(calls('ps'), [['-eo', 'pid,ppid,command']]); assert.deepEqual(calls('list'), [['list', '--json']]);
        assert.deepEqual(r.stdout.split('\n').filter(s => s.startsWith('[would-exec] ')).map(s => s.slice(13)), expected(cli));
        assert.match(r.stdout, /would DELETE/); assert.ok(r.stdout.includes(`/api/sessions/${sid}`));
        assert.ok(!r.stdout.includes('x-telepty-token')); assert.ok(!r.stdout.includes('fixture-token'));
        // The removed tails may not reappear from a plan that named neither.
        assert.ok(!/--dangerously-(skip-permissions|bypass-approvals-and-sandbox)/.test(r.stdout),
          `${cli}: a bypass flag was reported for a plan that named none`);
        assert.ok(!r.stdout.includes('[would-exec] --continue'), `${cli}: an implicit resume was reported`);
      }
    });
    await t.test('the ORCHESTRATOR_CLI-alone bypass door is closed on the installed package too', () => {
      // The rows that replaced `undefined` and `''`, plus the two providers the old
      // oracle never covered. Each must refuse BEFORE any read, with an empty stdout —
      // the shim reads fd 1 through a command substitution, so a refusal that printed a
      // token would be a refusal the shell exec'd.
      // (io1181km) Each row's diagnostic, exactly. The usage that follows it is checked separately.
      const REFUSALS = {
        'unset': MISSING_PLAN, 'empty': MISSING_PLAN,
        'claude-only': MISSING_PLAN, 'codex-only': MISSING_PLAN, 'gemini-only': MISSING_PLAN, 'grok-only': MISSING_PLAN,
        'opt-in-without-fields': PLAN_REFUSED +
          '  AIGENTRY_BOOT_PERMISSION is required. Schema: approval=<value>. Absent is not permissive\n' +
          '  AIGENTRY_BOOT_HISTORY is required. Values: new | last | selected=<selector>. A new conversation is the default only when you say so\n' +
          NO_FALLBACK,
        'fields-without-opt-in': 'orchestrator-boot.sh: AIGENTRY_BOOT_PERMISSION, AIGENTRY_BOOT_HISTORY set without AIGENTRY_BOOT_PLAN=1 — refusing to ignore an explicit boot plan\n',
        'opt-in-not-one': "orchestrator-boot.sh: AIGENTRY_BOOT_PLAN must be exactly '1' (got 'true')\n",
      };
      for (const [label, extra] of [
        ['unset', {}],
        ['empty', { ORCHESTRATOR_CLI: '' }],
        ['claude-only', { ORCHESTRATOR_CLI: 'claude' }],
        ['codex-only', { ORCHESTRATOR_CLI: 'codex' }],
        ['gemini-only', { ORCHESTRATOR_CLI: 'gemini' }],
        ['grok-only', { ORCHESTRATOR_CLI: 'grok' }],
        ['opt-in-without-fields', { AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'claude' }],
        ['fields-without-opt-in', { ORCHESTRATOR_CLI: 'claude', AIGENTRY_BOOT_PERMISSION: 'approval=manual', AIGENTRY_BOOT_HISTORY: 'new' }],
        ['opt-in-not-one', { AIGENTRY_BOOT_PLAN: 'true', ORCHESTRATOR_CLI: 'claude' }],
      ]) {
        for (const args of [[], ['--dry-run']]) {
          reset();
          const r = boot(`refuse-${label}${args.length ? '-dry' : '-bare'}`, args, extra);
          refusal(r, REFUSALS[label], `${label} ${args}`);
          assert.match(r.stderr, /AIGENTRY_BOOT_PLAN|ORCHESTRATOR_CLI/);
          // Nothing read, nothing signalled, nothing deleted, nothing exec'd.
          inert(true);
        }
      }
      // (io1181km) The usage names the removed tails ONCE, as documentation of their removal, and
      // that is the only place they appear in a refusal. Positive control: stripping the usage
      // removed text that BYPASS does match, so the check above is not vacuous.
      assert.ok(BYPASS.test(USAGE), 'the installed usage no longer documents the removed tails');
      for (const flag of ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox']) {
        assert.equal(USAGE.split(flag).length - 1, 1, `usage mentions ${flag} other than once`);
      }
      assert.ok(USAGE.includes('the pre-#1181 hardcoded tails (claude --dangerously-skip-permissions\n  --continue, codex resume --last ' +
        '--dangerously-bypass-approvals-and-sandbox) have been\n  REMOVED'), 'the usage mention is not the removal note');
      // An ELEVATED plan is still reachable — but only by naming it AND acknowledging it.
      reset();
      const noAck = boot('elevated-without-ack', ['--dry-run'], {
        AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'claude',
        AIGENTRY_BOOT_PERMISSION: 'approval=dangerously-skip-permissions', AIGENTRY_BOOT_HISTORY: 'last',
      });
      assert.equal(noAck.status, 2); assert.equal(noAck.stdout, '');
      assert.match(noAck.stderr, /AIGENTRY_BOOT_RISK_ACK/); inert(true);
      reset();
      const withAck = boot('elevated-with-ack', ['--dry-run'], {
        AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'claude',
        AIGENTRY_BOOT_PERMISSION: 'approval=dangerously-skip-permissions', AIGENTRY_BOOT_HISTORY: 'last',
        AIGENTRY_BOOT_RISK_ACK: 'I ACCEPT ELEVATED claude approval=dangerously-skip-permissions',
      });
      assert.equal(withAck.status, 0, withAck.stderr); inert();
      assert.deepEqual(withAck.stdout.split('\n').filter(s => s.startsWith('[would-exec] ')).map(s => s.slice(13)),
        ['telepty', 'allow', '--id', sid, '--auto-restart', 'claude', '--dangerously-skip-permissions', '--continue']);
      // Positive control on the exec channel: when an elevated argv really is emitted, BYPASS sees it.
      assert.ok(BYPASS.test(withAck.stdout), 'BYPASS no longer detects an emitted elevated argv');
    });
    await t.test('D: recorder kill set equals dry-run set, ancestor and mention skipped', () => {
      // (io1181km) The probe is not exempt from the plan gate. Without a plan it refuses before any read.
      reset(); const noPlan = boot('guard-probe-no-plan', ['__probe', 'singleton-guard']);
      refusal(noPlan, MISSING_PLAN, 'guard-probe-no-plan'); inert(true);
      // With a complete benign plan the probe inspects. It shares the dry-run effect gate (cli.js
      // DRY_RUN), so it reports the kill set on stderr and signals nothing.
      reset(); const probe = boot('guard-probe', ['__probe', 'singleton-guard'], planEnv('claude'));
      assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout, ''); inert();
      assert.deepEqual(calls('ps'), [['-eo', 'pid,ppid,command']]); assert.deepEqual(calls('list'), []);
      // One per-pid line each. `[^=]*` used to span lines: a planned dry run also prints the plan-level
      // "would SIGKILL stale '…' bridges" effect line, which has no '=' and ran on into the ancestor's pid.
      const killSet = out => [...out.matchAll(/^\[orchestrator-boot\] \[dry-run\] would SIGKILL stale orchestrator bridge pid=(\d+) /gm)].map(m => m[1]);
      const probeSet = killSet(probe.stderr);
      assert.deepEqual(probeSet, ['7777']);
      assert.match(probe.stderr, /skip self\/ancestor bridge pid=1111/); assert.match(probe.stderr, /skip pid=8888 — not a bridge/);
      // The RECORDER kill set: a planned bare boot through the fixture shim, same ps fixture. An empty
      // registry listing keeps curl/auth out of it, so only kill and the exec recorder may fire.
      reset(); fs.writeFileSync(path.join(fixture, 'list.json'), '[]');
      const real = boot('guard-boot', [], planEnv('claude'));
      assert.equal(real.status, 0, real.stderr); assert.equal(real.stdout, '');
      assert.deepEqual(calls('kill'), [['-9', '7777']]);
      assert.deepEqual(calls('exec'), [expected('claude').slice(1)]);
      for (const k of ['curl', 'auth', 'claude', 'codex', 'gemini', 'grok', 'cmux']) assert.deepEqual(calls(k), [], k);
      assert.match(real.stderr, /skip self\/ancestor bridge pid=1111/);
      reset(); const dry = boot('guard-dry', ['--dry-run'], planEnv('claude')); assert.equal(dry.status, 0, dry.stderr); inert();
      const drySet = killSet(dry.stdout);
      assert.deepEqual(drySet, ['7777']); assert.deepEqual(drySet, probeSet);
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
        // (io1181km) --dry-run carries the same benign plan as C/G/H. --help stays plan-free.
        const r = run(`pipe-${flag}`, '/bin/bash', ['-c', 'set -o pipefail; "$1" "$2" | /usr/bin/head -2; statuses=("${PIPESTATUS[@]}"); printf \'{"boot":%s,"head":%s}\\n\' "${statuses[0]}" "${statuses[1]}" > "$3"; (( statuses[0] == 0 && statuses[1] == 0 ))', '_', shim, flag, statusFile],
          flag === '--dry-run' ? planEnv('claude') : {});
        save(`pipe-${flag}.recorders.json`, Object.fromEntries(kinds.map(k => [k, calls(k)])));
        // The installed no-exec writer swallows EPIPE; the producer must exit 0 too.
        assert.deepEqual(JSON.parse(fs.readFileSync(statusFile, 'utf8')), { boot: 0, head: 0 });
        assert.equal(r.status, 0); assert.ok(r.stdout); inert();
      }
      // (io1181km) Negative: the same pipe with NO plan is the plan refusal, not an EPIPE, and nothing is read.
      reset();
      const noPlanStatus = path.join(evidence, 'pipe---dry-run-no-plan.statuses.json');
      const np = run('pipe---dry-run-no-plan', '/bin/bash', ['-c', 'set -o pipefail; "$1" "$2" | /usr/bin/head -2; statuses=("${PIPESTATUS[@]}"); printf \'{"boot":%s,"head":%s}\\n\' "${statuses[0]}" "${statuses[1]}" > "$3"', '_', shim, '--dry-run', noPlanStatus]);
      save('pipe---dry-run-no-plan.recorders.json', Object.fromEntries(kinds.map(k => [k, calls(k)])));
      assert.deepEqual(JSON.parse(fs.readFileSync(noPlanStatus, 'utf8')), { boot: 2, head: 0 });
      assert.equal(np.stdout, ''); assert.equal(np.stderr, `${MISSING_PLAN}${USAGE}\n`); inert(true);
    });
    await t.test('original shim bare argv handoff reaches only exec recorder', () => {
      // WAS: `{ ORCHESTRATOR_CLI: cli }` for claude and codex, expecting the hardcoded
      // bypass tails. The handoff PROPERTY under test — the shim's command substitution
      // reads the argv off fd 1 and execs it in its own process, touching no other
      // recorder — is unchanged and still the point; only the way a plan is supplied
      // moved, and the provider set grew to four.
      for (const cli of ['claude', 'codex', 'gemini', 'grok']) {
        reset(); fs.writeFileSync(path.join(fixture, 'ps.txt'), ''); fs.writeFileSync(path.join(fixture, 'list.json'), '[]');
        const r = boot(`handoff-${cli}`, [], planEnv(cli));
        assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, ''); assert.deepEqual(calls('exec'), [expected(cli).slice(1)]);
        // THE PROVIDERS THEMSELVES ARE NEVER RUN. The exec recorder stands in for
        // `telepty`, which is what would have gone on to run the provider; nothing on the
        // boot path may invoke one — not even to read its --help or --version.
        for (const k of ['kill', 'curl', 'auth', 'claude', 'codex', 'gemini', 'grok', 'cmux']) {
          assert.deepEqual(calls(k), [], `${cli}: the '${k}' recorder fired during a handoff boot`);
        }
      }
    });
  } finally {
    save('installed-after.json', snapshot()); assert.deepEqual(snapshot(), before); assert.equal(hash(shim), before[shimRel]);
    save('copied-shim-after.sha256', hash(shim) + '\n');
  }
});
