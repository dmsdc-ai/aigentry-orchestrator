// orchestrator-boot-wizard.test.mjs — the #1181 boot wizard, described (bt1181jm).
//
// NEW, DESCRIPTIVE GUARD. T131 and T134 own the boot contract that existed before this
// ticket (the reconcile/guard order, the SIGKILL-only rule, the argv channel, the no-exec
// modes). This file owns only what #1181 ADDED, and it owns it from the outside: nothing
// below imports cli.ts's internals or asserts a message it read out of the source. The
// interactive surface is driven through a REAL pseudo-terminal, and the pure validation
// surface is driven through plan.js's exported functions.
//
// ⚠️ THE FILE-DESCRIPTOR SHAPE IS THE CONTRACT, AND IT IS NOT SIMULATED.
//
//     bin/orchestrator-boot.sh:   ORCH_BOOT_ARGV_RAW="$(node "$AIGENTRY_SHIM_JS")"
//
// A real boot from a real terminal therefore has fd 0 = tty, fd 1 = PIPE, fd 2 = tty, and
// cli.js gates every interactive path on `process.stdin.isTTY && process.stderr.isTTY`.
// Setting `isTTY` from a test would be asserting against a property this suite wrote
// itself. `tests/packaging/pty-driver.py` opens a real pty instead and hands the slave to
// the child as stdin AND stderr while stdout stays an ordinary pipe. If the pty is
// unavailable this file FAILS, loudly, naming the gap — it does not fall back to a stub
// and it does not skip.
//
// ⚠️ WHAT MAY RUN. A fake PATH with fake executables, a closed temporary HOME, and
// recorder stubs on every seam (SINGLETON_PS_CMD, KILL_CMD, TELEPTY, CURL, and the
// `telepty` the shim finally execs). Task 1270: the boot no longer lists, signals or DELETEs
// anything, so the ps/kill/list recorders are kept ONLY as armed tripwires that must stay empty
// on every path; the fake `telepty` also answers the preflight's `boot-capabilities` probe
// (recorded as `caps`, never as `exec`) and the curl recorder answers the bounded local
// GET /api/meta and GET /api/sessions/<sid> from per-route fixture data. NO real provider, NO real telepty, NO real daemon,
// NO network: `CURL` is a recorder that never opens a socket and nothing else in the
// module reaches the wire. Every kill goes to a recorder; the only processes this file
// creates are its own children and the pty driver kills only its own process group.
//
// WHAT IS *NOT* CLAIMED HERE. No npm install, no packaging, no native/3-OS behaviour, no
// real controller boot, no cmux/terminal automation. Provider BEHAVIOUR is never
// measured — only that a provider is never EXECUTED and that the argv composed for it
// matches the registry's own measured spelling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DIST = path.join(REPO, 'dist/src/orchestrator-boot');
const SHIM = path.join(REPO, 'bin/orchestrator-boot.sh');
const DRIVER = path.join(HERE, 'pty-driver.py');
const NODE = process.execPath;

// ── preconditions, as refusals rather than skips ────────────────────────────
// A suite whose subject is "a terminal-only interactive path" must never report success
// on a host where it could not open a terminal. Each of these is an EXACT GAP.
for (const f of ['cli.js', 'usage.js', 'plan.js', 'wizard.js', 'provider-capabilities.js']) {
  assert.ok(fs.existsSync(path.join(DIST, f)),
    `GAP: ${f} is missing from ${DIST}. The compiled boot module is incomplete; cli.js imports plan.js and wizard.js, and plan.js imports provider-capabilities.js.`);
}
{
  const probe = spawnSync('python3', ['-c', 'import pty,termios,select,os;print("ok")'], { encoding: 'utf8' });
  assert.equal(probe.status, 0,
    `GAP: no usable stdlib pty on this host (python3 -c "import pty" exited ${probe.status}: ${probe.stderr}). ` +
    'The wizard is reachable ONLY when stdin and stderr are terminals, so without a pty this suite cannot ' +
    'produce integration evidence. A faked process.stdin.isTTY would be the suite asserting against its own ' +
    'stub and is deliberately not offered as a fallback.');
}

// ── the fixture ─────────────────────────────────────────────────────────────
let fixtureSeq = 0;

/**
 * A hermetic boot fixture: a fake PATH, a closed HOME, and a recorder on every seam.
 *
 * Nothing on the host PATH is reachable from a child created here except the handful of
 * real binaries symlinked in explicitly (bash, sh, dirname, node), so an accidental
 * fallback to a real `claude`, a real `telepty` or a real `curl` is not possible — it
 * would be a "command not found", not a live call.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `boot-wizard-${fixtureSeq++}-`));
  const bin = path.join(dir, 'path');
  const logs = path.join(dir, 'logs');
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'cwd');
  for (const d of [bin, logs, home, cwd]) fs.mkdirSync(d);

  for (const real of ['/bin/bash', '/bin/sh', '/usr/bin/dirname']) {
    fs.symlinkSync(real, path.join(bin, path.basename(real)));
  }
  fs.symlinkSync(NODE, path.join(bin, 'node'));

  // Every recorder appends one JSON argv array per invocation. `ps` and `telepty list`
  // additionally answer from a file the test writes, so a fixture change is a data
  // change rather than a code change.
  const recorder = (name, kind, emit = '') => {
    const file = path.join(bin, name);
    fs.writeFileSync(file,
      `#!${NODE}\n` +
      `const fs=require('node:fs');\n` +
      `fs.appendFileSync(${JSON.stringify(path.join(logs, kind + '.jsonl'))},JSON.stringify(process.argv.slice(2))+'\\n');\n` +
      emit,
      { mode: 0o700 });
    return file;
  };
  const kinds = ['ps', 'kill', 'list', 'curl', 'exec', 'auth', 'caps', 'claude', 'codex', 'gemini', 'grok'];
  for (const k of kinds) fs.writeFileSync(path.join(logs, `${k}.jsonl`), '');

  const seams = {
    SINGLETON_PS_CMD: recorder('ps-recorder', 'ps',
      `try{process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, 'ps.txt'))}))}catch{}\n`),
    KILL_CMD: recorder('kill-recorder', 'kill'),
    TELEPTY: recorder('telepty-list-recorder', 'list',
      `try{process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, 'list.json'))}))}catch{}\n`),
    // Task 1270: the bounded local GETs of the boot preflight. Answered per route from http.json as
    // `<body>\n<code>` — the shape `curl -w '\n%{http_code}'` prints — with curl's own exit status.
    CURL: recorder('curl-recorder', 'curl',
      `const u=process.argv[process.argv.length-1]||'';const k=u.endsWith('/api/meta')?'meta':u.includes('/api/sessions/')?'session':'other';\n` +
      `let r={code:'000',body:'',exit:7};try{r=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'http.json'))},'utf8'))[k]||r}catch{}\n` +
      `process.stdout.write(r.body+'\\n'+r.code);process.exit(r.exit||0);\n`),
  };
  // The bridge the shim finally execs, resolved from PATH exactly as a real boot resolves
  // it. Its presence in the log is the ONLY evidence that a boot completed.
  // Task 1270: the same PATH `telepty` also answers the preflight's `boot-capabilities` probe —
  // recorded under `caps`, answered from caps.txt with exit code caps.rc — and that probe is
  // NEVER logged as an exec.
  fs.writeFileSync(path.join(bin, 'telepty'),
    `#!${NODE}\n` +
    `const fs=require('node:fs');const a=process.argv.slice(2);\n` +
    `if(a[0]==='boot-capabilities'){fs.appendFileSync(${JSON.stringify(path.join(logs, 'caps.jsonl'))},JSON.stringify(a)+'\\n');` +
    `try{process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, 'caps.txt'))}))}catch{}` +
    `let rc=0;try{rc=Number(fs.readFileSync(${JSON.stringify(path.join(dir, 'caps.rc'))},'utf8'))}catch{}process.exit(rc)}\n` +
    `fs.appendFileSync(${JSON.stringify(path.join(logs, 'exec.jsonl'))},JSON.stringify(a)+'\\n');\n`,
    { mode: 0o700 });
  // THE FOUR PROVIDERS. They are on PATH so the wizard's X_OK availability check finds
  // them, and they record EVERY invocation — including a `--help` or a `--version` — so
  // "no provider is executed to describe it" is measured, not asserted.
  for (const p of ['claude', 'codex', 'gemini', 'grok']) recorder(p, p);

  fs.writeFileSync(path.join(dir, 'ps.txt'), '');
  fs.writeFileSync(path.join(dir, 'list.json'), '[]');
  // Task 1270 defaults: a current telepty and a daemon that supports create-only and holds no such session (FRESH).
  fs.writeFileSync(path.join(dir, 'caps.txt'), SEALED_CAPS);
  fs.writeFileSync(path.join(dir, 'caps.rc'), '0');
  fs.writeFileSync(path.join(dir, 'http.json'), JSON.stringify(DAEMON_FRESH));

  // The one sanctioned credential door, replaced by a recorder. The real resolver is not
  // staged here and must never be reached; if the boot resolves a credential this fires.
  fs.mkdirSync(path.join(dir, 'authdir'));
  const authSh = path.join(dir, 'authdir', 'telepty-auth.sh');
  fs.writeFileSync(authSh,
    `telepty_auth_token() { printf '[]\\n' >> '${path.join(logs, 'auth.jsonl')}'; printf 'fixture-token-bt1181jm'; }\n`);

  const env = {
    PATH: bin,
    HOME: home,
    TMPDIR: dir,
    AIGENTRY_HOME: path.join(home, '.aigentry'),
    // The shim exports this itself; set for the direct-cli invocations too so the
    // credential door resolves to the recorder above and never to a real bin/lib.
    AIGENTRY_SHIM_SCRIPT_DIR: path.join(dir, 'authdir', '..', 'authdir'),
    TELEPTY_PORT: '3848',
    SINGLETON_SELF_PID: '9999',
    // #1201: this file pins the wizard and its argv; the context handoff is T135's subject.
    // HOME above is already closed, so no real transcript store is reachable either way.
    AIGENTRY_HANDOFF: 'off',
    ...seams,
  };
  // AIGENTRY_SHIM_SCRIPT_DIR must be the directory whose `lib/telepty-auth.sh` resolves.
  fs.mkdirSync(path.join(dir, 'shimbin', 'lib'), { recursive: true });
  fs.copyFileSync(authSh, path.join(dir, 'shimbin', 'lib', 'telepty-auth.sh'));
  env.AIGENTRY_SHIM_SCRIPT_DIR = path.join(dir, 'shimbin');

  const calls = kind => fs.readFileSync(path.join(logs, `${kind}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);

  return {
    dir, bin, logs, home, cwd, env, calls, kinds,
    psTable: rows => fs.writeFileSync(path.join(dir, 'ps.txt'), rows.join('\n') + (rows.length ? '\n' : '')),
    listing: value => fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(value)),
    /** Task 1270: what the fake telepty prints (and exits with) for `boot-capabilities`. */
    bootCaps: (text, rc = 0) => {
      fs.writeFileSync(path.join(dir, 'caps.txt'), text);
      fs.writeFileSync(path.join(dir, 'caps.rc'), String(rc));
    },
    /** Task 1270: what the fake daemon answers through the curl seam, merged per route ('meta', 'session'). */
    daemon: routes => {
      const cur = JSON.parse(fs.readFileSync(path.join(dir, 'http.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'http.json'), JSON.stringify({ ...cur, ...routes }));
    },
    /** Task 1270: every request put through the curl seam, as [method, url]. */
    requests() {
      return this.calls('curl').map(a => [a.includes('-X') ? a[a.indexOf('-X') + 1] : 'GET', a[a.length - 1]]);
    },
    /** Task 1270: nothing was listed, signalled or deleted — on EVERY path, a completed boot included. */
    assertNoDestructiveEffect(label) {
      for (const k of ['ps', 'list', 'kill']) assert.deepEqual(this.calls(k), [], `${label}: the '${k}' tripwire fired`);
      for (const a of this.calls('curl')) {
        assert.ok(!a.includes('-X') && !a.includes('--request') && !a.some(x => /^DELETE$/i.test(x)),
          `${label}: a non-GET registry request was issued: ${JSON.stringify(a.slice(0, -1).filter(x => !x.startsWith('x-telepty-token')))}`);
      }
    },
    /** Remove a provider from PATH, to drive the "missing binary" screen. */
    uninstall: p => fs.rmSync(path.join(bin, p)),
    /** Nothing was listed, deleted, signalled, exec'd, or authenticated. */
    assertInert(label, { reads = false } = {}) {
      for (const k of ['kill', 'curl', 'exec', 'auth', 'caps', ...(reads ? ['ps', 'list'] : [])]) {
        assert.deepEqual(this.calls(k), [], `${label}: the '${k}' recorder fired`);
      }
      this.assertNoProviderRan(label);
    },
    /** RULE 1 of the capability registry: no provider executes to be described. */
    assertNoProviderRan(label) {
      for (const p of ['claude', 'codex', 'gemini', 'grok']) {
        assert.deepEqual(this.calls(p), [],
          `${label}: '${p}' WAS EXECUTED. Planning and confirmation must never run a provider — ` +
          `measured 2026-09, gemini/grok/codex --help all write to the real HOME, so a planning step ` +
          `that shells out to --help is itself an effect.`);
      }
    },
    /** The temporary HOME must still be empty: no provider scribbled in it. */
    assertHomeUntouched(label) {
      assert.deepEqual(fs.readdirSync(home), [],
        `${label}: something wrote into the closed temporary HOME`);
    },
  };
}

/** Drive a command through a real pty (fd 0 + fd 2) with a pipe on fd 1. */
function pty(fx, { cmd, steps, env = {}, cwd = fx.cwd, timeout = 25 }) {
  const spec = path.join(fx.dir, `spec-${Math.abs(steps.length + cmd.length)}-${fs.readdirSync(fx.dir).length}.json`);
  fs.writeFileSync(spec, JSON.stringify({ cmd, cwd, env: { ...fx.env, ...env }, steps, timeout }));
  const r = spawnSync('python3', [DRIVER, spec], { encoding: 'utf8', timeout: (timeout + 15) * 1000 });
  assert.equal(r.status, 0, `pty driver failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.timed_out, false,
    `the wizard did not reach the end of its script (${out.steps_done}/${out.steps_total} steps): ${out.note}\n--- terminal ---\n${out.terminal}`);
  return out;
}

/** The boot path, exactly as an operator reaches it: the SHIM, with an empty argv. */
const bootCmd = () => ['/bin/bash', SHIM];

const argvLines = stdout => stdout.split('\n').filter(Boolean);

// ── task 1270: the boot preflight's fixture data ────────────────────────────
// The exact sealed `telepty boot-capabilities` line (telepty cli.js c16e1f81… bootCapabilitiesLine).
const SEALED_CAPS = '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1"}\n';
const META_OK = { code: '200', body: JSON.stringify({ version: '0.11.0', capabilities: ['sessions', 'wrapped-sessions', 'register-create-only'] }) };
const SESSION_ABSENT = { code: '404', body: JSON.stringify({ error: 'Session not found' }) };
const DAEMON_FRESH = { meta: META_OK, session: SESSION_ABSENT };
const META_URL = 'http://127.0.0.1:3848/api/meta';
const sessionUrl = (sid, port = '3848') => `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sid)}`;
const CLAUDE_PLAN = {
  AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'claude',
  AIGENTRY_BOOT_PERMISSION: 'approval=manual', AIGENTRY_BOOT_HISTORY: 'new',
};
const CLAUDE_ARGV = sid => ['allow-create-v1', '--id', sid, '--auto-restart', 'claude', '--permission-mode', 'manual'];

/**
 * "It did not boot" — asserted in a way that cannot pass vacuously.
 *
 * ⚠️ TWO DIFFERENT THINGS LOOK LIKE "EOF", and v1/v2 of this file conflated them.
 * Closing the pty master is THE TERMINAL VANISHING: the kernel SIGHUPs the foreground
 * group, so node dies on a signal and there is no exit code at all (`rc: null`). Ctrl-D
 * is an EOT byte through the line discipline: readline sees a clean end-of-input and the
 * wizard cancels normally with exit 1 and its cancellation notice.
 *
 * Both are legitimate, both must leave stdout empty — but `assert.notEqual(rc, 0)` is
 * satisfied by `null`, so a suite that only writes that cannot tell "cancelled cleanly"
 * from "was killed" from "the driver lost track of the child". This helper refuses the
 * third case: an outcome must be either a non-zero exit code or a named signal.
 */
function assertDidNotBoot(r, label, { expectExit = null, expectSignal = null } = {}) {
  if (expectExit !== null) {
    assert.equal(r.rc, expectExit, `${label}: expected a clean exit ${expectExit}, got rc=${r.rc} signal=${r.signal}`);
  } else if (expectSignal !== null) {
    assert.equal(r.rc, null, `${label}: expected death by signal, got exit ${r.rc}`);
    assert.equal(r.signal, expectSignal, `${label}: expected signal ${expectSignal}, got ${r.signal}`);
  } else {
    assert.ok((r.rc !== null && r.rc !== 0) || r.signal !== null,
      `${label}: neither a non-zero exit nor a signal — the outcome is unknown, not a refusal (rc=${r.rc} signal=${r.signal})`);
  }
  assert.equal(r.stdout, '', `${label}: stdout was not empty: ${JSON.stringify(r.stdout)}`);
}

// The answers that walk a claude boot to the review screen with the restrictive default
// on every axis. Reused so a test that cares about ONE step does not restate the rest.
const CLAUDE_TO_REVIEW = [
  { expect: 'provider [1-', send: '1\n' },
  { expect: 'model id', send: '\n' },
  { expect: 'effort (', send: '\n' },
  { expect: 'approval [1-', send: '\n' },
  { expect: 'history [1-', send: '\n' },
  { expect: 'session id [', send: '\n' },
];

// ════════════════════════════════════════════════════════════════════════════
test('the wizard is the terminal door, and a typed YES is the only thing that boots', async t => {

  await t.test('a bare boot from a real terminal asks, then execs exactly what was agreed', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(),
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assert.equal(r.rc, 0, `the boot exited ${r.rc}\n${r.terminal}`);

    // fd 1 — the contract channel — carried the argv and NOTHING else. The wizard drew
    // seven screens on fd 2 and not one byte of them may appear here, because the shell
    // execs whatever arrives.
    assert.deepEqual(argvLines(r.stdout), []);
    // …because the SHIM consumed it and exec'd. That is where the argv shows up.
    assert.deepEqual(fx.calls('exec'),
      [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--permission-mode', 'manual']]);

    // The review screen described that argv before it happened, element for element.
    for (const el of ['telepty', 'allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--permission-mode', 'manual']) {
      assert.ok(r.terminal.includes(`| ${el}`), `the review screen did not list '${el}': ${r.terminal}`);
    }
    // It also stated the effects, in advance, in plain language. Task 1270: the old DELETE and
    // SIGKILL effects are GONE from the screen because they are gone from the boot.
    assert.match(r.terminal, /This boot WILL:/);
    assert.match(r.terminal, /CHECK that the telepty on PATH supports create-only boot/);
    assert.match(r.terminal, /LOOK UP 'orchestrator' on the local daemon/);
    assert.match(r.terminal, /REPLACE this shell/);
    assert.ok(!/DELETE a registry record|SIGKILL stale/.test(r.terminal), 'the review still promises a DELETE or a SIGKILL');
    // …and the preflight it promised is what ran, on the wire, before the exec.
    assert.match(r.terminal, /boot preflight FRESH/);
    assert.deepEqual(fx.requests(), [['GET', META_URL], ['GET', sessionUrl('orchestrator')]]);
    assert.deepEqual(fx.calls('caps'), [['boot-capabilities']]);
    fx.assertNoDestructiveEffect('happy path');

    // DEFAULT-DENY IS VISIBLE, not just implemented — and since v3 the screen also states
    // the ACCEPTED SET rather than leaving an operator to discover it by experiment.
    assert.match(r.terminal, /Type YES to boot — the whole word, in any case: YES, yes, Yes and yEs all confirm\./);
    assert.match(r.terminal, /Anything else cancels and acts on nothing/);
    assert.match(r.terminal, /Enter \(the default answer is/);
    // Enter pre-selects the most restrictive value and says so.
    assert.match(r.terminal, /the most restrictive value with evidence/);
    // Pressing Enter on the permission screen produced `manual`, never a bypass.
    assert.ok(!r.stdout.includes('--dangerously-skip-permissions'));
    assert.ok(!fx.calls('exec')[0].includes('--dangerously-skip-permissions'));

    fx.assertNoProviderRan('happy path');
    fx.assertHomeUntouched('happy path');
    // Provenance is printed as unverified rather than implied to be trusted.
    assert.match(r.terminal, /provenance unverified/);
  });

  await t.test('every cancel arm leaves an EMPTY stdout, a non-zero exit and zero effects', () => {
    // q, Ctrl-C (a real 0x03 through the line discipline), EOF (the terminal going away),
    // and a declined review. All four are the same contract: nothing happened.
    // `expectExit: 1` wherever the wizard cancels of its own accord. The one arm that is
    // NOT a clean cancel is the terminal vanishing, and it is written as what it is.
    const arms = [
      { name: 'q at the provider step', exit: 1, steps: [{ expect: 'provider [1-', send: 'q\n' }] },
      { name: 'q at the review step', exit: 1, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'q\n' }] },
      { name: 'Ctrl-C at the provider step', exit: 1, steps: [{ expect: 'provider [1-', sig: 'INT' }] },
      { name: 'Ctrl-C at the review step', exit: 1, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', sig: 'INT' }] },
      { name: 'Ctrl-D (EOF on stdin) at the provider step', exit: 1, steps: [{ expect: 'provider [1-', sig: 'EOT' }] },
      { name: 'Ctrl-D mid-way (incomplete)', exit: 1, steps: [{ expect: 'provider [1-', send: '1\n' }, { expect: 'model id', sig: 'EOT' }] },
      { name: 'Enter at the review (the default answer is no)', exit: 1, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: '\n' }] },
      { name: 'a typo at the review', exit: 1, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'y\n' }] },
      { name: 'YES with trailing junk', exit: 1, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES please\n' }] },
      // THE TERMINAL VANISHES. Closing the pty master SIGHUPs the foreground group, so
      // node is killed rather than cancelling: no exit code, no cancellation notice. The
      // property that matters is unchanged and is the reason this arm exists — stdout is
      // still empty and nothing was listed, deleted, signalled or exec'd.
      { name: 'the terminal vanishes mid-way (SIGHUP)', signal: 1, steps: [{ expect: 'provider [1-', send: '1\n' }, { expect: 'model id', eof: true }] },
    ];
    for (const arm of arms) {
      const fx = fixture();
      // A LOADED fixture: a real stale bridge to kill and a STALE/0-client record to
      // delete. "Nothing happened" is then a measurement, not an empty fixture answering
      // for itself.
      fx.psTable([`7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude`]);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      const r = pty(fx, { cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' }, steps: arm.steps });

      // OUTPUT-FREE CANCELLATION. The shim reads fd 1 through `$(...)`; one stray token
      // would be exec'd. This is the whole cancel contract — and the exit is pinned
      // exactly, so `rc: null` can never satisfy it by accident.
      assertDidNotBoot(r, arm.name, { expectExit: arm.exit ?? null, expectSignal: arm.signal ?? null });
      if (arm.exit === 1) {
        assert.match(r.terminal, /nothing was listed, deleted, signalled or exec'd/,
          `${arm.name}: a clean cancel printed no cancellation notice`);
      }
      // NOTHING WAS LISTED, DELETED, SIGNALLED OR EXEC'D — including the reads, because
      // the wizard runs strictly BEFORE the reconcile and the guard.
      fx.assertInert(arm.name, { reads: true });
      fx.assertHomeUntouched(arm.name);
    }
  });

  await t.test('a declined boot cannot kill or delete anything, even with both fixtures armed', () => {
    // The paranoid restatement of the arm above, aimed at the two irreversible effects.
    // A host process is never at risk here: `kill` is a recorder and every pid is
    // synthetic, so this measures the decision, not the outcome.
    const fx = fixture();
    fx.psTable([
      '1111 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude',
      '7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude',
      `${process.pid} 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude`,
    ]);
    fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
    const r = pty(fx, {
      cmd: bootCmd(),
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'no\n' }],
    });
    assert.notEqual(r.rc, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(fx.calls('kill'), [], 'a declined boot SIGKILLed a pid');
    assert.deepEqual(fx.calls('curl'), [], 'a declined boot issued a registry request');
    assert.deepEqual(fx.calls('auth'), [], 'a declined boot resolved a credential');
    assert.deepEqual(fx.calls('exec'), []);
  });

  await t.test('the confirm gate accepts the whole word in any case — as now documented', () => {
    // WAS A NAMED DIVERGENCE (v1 §4.5(a)), NOW A DOCUMENTED CONTRACT.
    //
    // The comparison is unchanged — still `a.toLowerCase() !== "yes"` — so the acceptance
    // matrix below is byte-for-byte the v1 one. What changed in v3 is that the wizard
    // screen and `usage.ts` now STATE the rule instead of saying only "typed YES", so the
    // looseness is a decision an operator can read rather than one they discover.
    //
    // This is not a bypass: the affirmative WORD is required, nothing shorter or longer
    // passes, and Enter still cancels. The test pins the BOUNDARY in both directions — a
    // widening to `y`, or a narrowing that broke the documented `YES`, each fails here and
    // names which. The doc half is asserted separately below, so code and text cannot
    // drift apart again silently.
    const accepted = ['YES', 'yes', 'Yes', 'yEs'];
    const refused = ['y', 'Y', 'no', '', 'yes please', 'ye', 'YES!'];
    for (const answer of accepted) {
      const fx = fixture();
      const r = pty(fx, {
        cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
        steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: `${answer}\n` }],
      });
      assert.equal(r.rc, 0, `'${answer}' did not boot`);
      assert.equal(fx.calls('exec').length, 1, `'${answer}' did not reach the exec`);
    }
    for (const answer of refused) {
      const fx = fixture();
      const r = pty(fx, {
        cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
        steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: `${answer}\n` }],
      });
      assert.notEqual(r.rc, 0, `'${answer}' BOOTED — the affirmative set widened`);
      assert.equal(r.stdout, '');
      assert.deepEqual(fx.calls('exec'), [], `'${answer}' reached the exec`);
    }
  });

  await t.test('the accepted set is STATED, in both the screen and the usage text', () => {
    // The other half of the contract above. A case-insensitive gate is fine; a
    // case-insensitive gate documented as "type YES" is what made it a divergence.
    const fx = fixture();
    const screen = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'q\n' }],
    });
    for (const needle of ['YES, yes, Yes and yEs all confirm', "'y' or 'Y' alone", "'yes please'"]) {
      assert.ok(screen.terminal.includes(needle),
        `the review screen does not state the accepted set (${needle}): ${screen.terminal.slice(-800)}`);
    }
    const help = spawnSync('/bin/bash', [SHIM, '--help'], {
      cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: fx.env,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /in ANY\s*\n?\s*CASE: 'YES', 'yes', 'Yes' and 'yEs' all confirm/,
      'usage does not state the confirm-token casing rule');
    assert.match(help.stdout, /'y' alone/, 'usage does not name what is NOT accepted');
  });

  await t.test("'b' walks back, and the agreed argv is identical to the no-detour run", () => {
    // The plan must be a function of the ANSWERS, not of the path taken to them. A back
    // step that left a stale value behind would exec something the operator did not see
    // on the review screen.
    const straight = fixture();
    const a = pty(straight, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assert.equal(a.rc, 0);

    const detour = fixture();
    const b = pty(detour, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        // Pick a model, then go back and unpick it.
        { expect: 'model id', send: 'claude-fable-5\n' },
        { expect: 'effort (', send: 'b\n' },
        { expect: 'model id', send: '\n' },
        // Walk forward, then back up two screens and forward again.
        { expect: 'effort (', send: '\n' },
        { expect: 'approval [1-', send: 'b\n' },
        { expect: 'effort (', send: '\n' },
        { expect: 'approval [1-', send: '\n' },
        { expect: 'history [1-', send: 'b\n' },
        { expect: 'approval [1-', send: '\n' },
        { expect: 'history [1-', send: '\n' },
        { expect: 'session id [', send: '\n' },
        { expect: 'confirm [yes/NO]', send: 'b\n' },
        { expect: 'session id [', send: '\n' },
        { expect: 'confirm [yes/NO]', send: 'YES\n' },
      ],
    });
    assert.equal(b.rc, 0, b.terminal);
    assert.deepEqual(detour.calls('exec'), straight.calls('exec'),
      'the argv depended on the navigation path, not only on the answers');
    // And specifically: the model that was typed and then backed out of is GONE.
    assert.ok(!JSON.stringify(detour.calls('exec')).includes('claude-fable-5'),
      'a value the operator backed out of survived into the argv');
  });

  await t.test('cancelling after a back-step is still output-free', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        { expect: 'model id', send: 'x\n' },
        { expect: 'effort (', send: 'b\n' },
        { expect: 'model id', send: 'q\n' },
      ],
    });
    assert.notEqual(r.rc, 0);
    assert.equal(r.stdout, '');
    fx.assertInert('cancel after back', { reads: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('elevation is never reached by pressing Enter', async t => {

  await t.test('an elevated value needs its own name typed back, and a refusal does not select it', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        { expect: 'model id', send: '\n' },
        { expect: 'effort (', send: '\n' },
        // claude's approval axis, value 7: dangerously-skip-permissions (risk: bypass) —
        // the exact flag the pre-#1181 boot hardcoded.
        { expect: 'approval [1-', send: '7\n' },
        // WRONG acknowledgement first. It must NOT select the value.
        { expect: 'acknowledgement:', send: 'yes\n' },
        // The screen is redrawn; take the restrictive value instead.
        { expect: 'approval [1-', send: '1\n' },
        { expect: 'history [1-', send: '\n' },
        { expect: 'session id [', send: '\n' },
        { expect: 'confirm [yes/NO]', send: 'YES\n' },
      ],
    });
    assert.equal(r.rc, 0, r.terminal);
    assert.match(r.terminal, /DISABLES a protection mechanism/);
    assert.match(r.terminal, /Type exactly: {2}ACCEPT dangerously-skip-permissions/);
    assert.match(r.terminal, /not acknowledged; the value was NOT selected/);
    // The boot that resulted carries the RESTRICTIVE value and no bypass flag at all.
    assert.deepEqual(fx.calls('exec'),
      [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--permission-mode', 'manual']]);
  });

  await t.test('the correct acknowledgement does select it — the door is open to someone who names it', () => {
    // The point of the acknowledgement is NOT that the bypass is unreachable. An operator
    // who genuinely needs the old behaviour must still be able to have it; what changed is
    // that nothing can select it FOR them. Both halves have to be true or the feature is
    // either a lie or a wall.
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        { expect: 'model id', send: '\n' },
        { expect: 'effort (', send: '\n' },
        { expect: 'approval [1-', send: '7\n' },
        { expect: 'acknowledgement:', send: 'ACCEPT dangerously-skip-permissions\n' },
        { expect: 'history [1-', send: '\n' },
        { expect: 'session id [', send: '\n' },
        { expect: 'confirm [yes/NO]', send: 'YES\n' },
      ],
    });
    assert.equal(r.rc, 0, r.terminal);
    assert.deepEqual(fx.calls('exec'),
      [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--dangerously-skip-permissions']]);
    // The review screen SHOUTED about it and printed the phrase a non-interactive caller
    // would need — restating the selection, so it cannot authorise a later, different one.
    assert.match(r.terminal, /⚠ ELEVATED: approval=dangerously-skip-permissions/);
    assert.match(r.terminal, /AIGENTRY_BOOT_RISK_ACK='I ACCEPT ELEVATED claude approval=dangerously-skip-permissions'/);
    // NOTE what is still absent: `--continue`. The removed default bundled a permission
    // bypass WITH a session resume; history stayed `new` here because nobody chose
    // otherwise, and the two axes are now independent.
    assert.ok(!fx.calls('exec')[0].includes('--continue'),
      'a bypass selection silently re-added the resume the old default bundled with it');
  });

  await t.test('every axis of every provider pre-selects a non-elevated value', async () => {
    // A unit-level sweep over the registry, because the wizard reaching it by pressing
    // Enter is only safe if the registry cannot offer an elevated default in the first
    // place. This is the structural half of the screen assertion above.
    const caps = await import(pathToFileURL(path.join(DIST, 'provider-capabilities.js')).href);
    const plan = await import(pathToFileURL(path.join(DIST, 'plan.js')).href);
    assert.deepEqual(caps.capabilityKeys(), ['claude', 'codex', 'gemini', 'grok']);
    for (const cap of caps.CAPABILITIES) {
      assert.ok(cap.axes.length > 0, `${cap.key} has no permission axis at all`);
      for (const choice of plan.restrictiveDefaults(cap)) {
        assert.ok(choice.risk === 'restrictive',
          `${cap.key}'s ${choice.axis} axis pre-selects '${choice.value}' at risk '${choice.risk}' — ` +
          `pressing Enter would reach it`);
      }
      // And the pre-selected default never needs an acknowledgement.
      const defaults = plan.restrictiveDefaults(cap);
      const elevated = defaults.filter(d => d.risk === 'elevated' || d.risk === 'bypass');
      assert.deepEqual(elevated, [], `${cap.key}'s defaults include an elevated value`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('the wizard chooses; the environment only suggests', async t => {

  await t.test('THE r1 DEFECT, task 1270 form: the preflight reads the SELECTED sid only, and nothing is killed or deleted', () => {
    // History: r1's guard and reconcile read the MODULE-LEVEL env sid while the wizard could be
    // given a different one, so a boot that changed the id SIGKILLed and DELETEd for a session it
    // was NOT about to become. Task 1270 removed both effects outright. What remains per sid is a
    // READ — the exact-session lookup — and it must name the CHOSEN id, never the inherited one.
    //
    // BOTH IDS ARE STILL ON THE (tripwire) TABLE AND IN THE (tripwire) LISTING: neither may be read.
    const inherited = 'inherited-orch';
    const chosen = 'chosen-orch';
    const fx = fixture();
    fx.psTable([
      `4001 1 node /usr/local/bin/telepty allow --id ${inherited} --auto-restart claude`,
      `4002 1 node /usr/local/bin/telepty allow --id ${chosen} --auto-restart claude`,
    ]);
    fx.listing([
      { id: inherited, healthStatus: 'STALE', active_clients: 0 },
      { id: chosen, healthStatus: 'STALE', active_clients: 0 },
    ]);

    const r = pty(fx, {
      cmd: bootCmd(),
      env: { ORCHESTRATOR_SID: inherited },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        { expect: 'model id', send: '\n' },
        { expect: 'effort (', send: '\n' },
        { expect: 'approval [1-', send: '\n' },
        { expect: 'history [1-', send: '\n' },
        // The env value is a SUGGESTION: it pre-fills this prompt and is overtyped here.
        { expect: 'session id [', send: `${chosen}\n` },
        { expect: 'confirm [yes/NO]', send: 'YES\n' },
      ],
    });
    assert.equal(r.rc, 0, r.terminal);

    // The env value was shown as the suggestion it is…
    assert.ok(r.terminal.includes(`session id [Enter = ${inherited}]`),
      'the environment sid was not offered as a pre-filled suggestion');

    // …the exec and the one per-sid read landed on the CHOSEN id…
    assert.deepEqual(fx.calls('exec'), [CLAUDE_ARGV(chosen)]);
    assert.deepEqual(fx.requests(), [['GET', META_URL], ['GET', sessionUrl(chosen)]]);
    // …NOTHING touched the inherited one, and nothing was listed, signalled or deleted at all.
    assert.ok(!fx.requests().some(([, u]) => u.endsWith(`/${inherited}`)),
      'the preflight looked up the INHERITED sid — the r1 defect in its task-1270 form');
    fx.assertNoDestructiveEffect('r1');
    // The verdict line names the chosen id, so the report and the action cannot disagree.
    assert.ok(r.terminal.includes(`boot preflight FRESH — no session '${chosen}'`),
      `the preflight verdict does not name the chosen sid: ${r.terminal}`);
  });

  await t.test('the r2 fix does not move the id when the plan states it (the explicit-plan path)', () => {
    // In an explicit plan the two values are the same by construction — ORCHESTRATOR_SID IS the
    // plan's sid field. Both ids are again present (as tripwires) so "it used the right one" is
    // distinguishable from "it used neither".
    const fx = fixture();
    fx.psTable([
      `4001 1 node /usr/local/bin/telepty allow --id other-orch --auto-restart claude`,
      `4002 1 node /usr/local/bin/telepty allow --id planned-orch --auto-restart claude`,
    ]);
    fx.listing([
      { id: 'other-orch', healthStatus: 'STALE', active_clients: 0 },
      { id: 'planned-orch', healthStatus: 'STALE', active_clients: 0 },
    ]);
    const r = spawnSync('/bin/bash', [SHIM], {
      cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...fx.env, ORCHESTRATOR_SID: 'planned-orch', ...CLAUDE_PLAN },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fx.calls('exec'), [CLAUDE_ARGV('planned-orch')]);
    assert.deepEqual(fx.requests(), [['GET', META_URL], ['GET', sessionUrl('planned-orch')]]);
    fx.assertNoDestructiveEffect('r2');
  });

  await t.test('ORCHESTRATOR_CLI on a terminal is a printed hint, not a selection', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(),
      // The environment says codex. The operator picks claude (row 1). The environment
      // must not win, and must not be silently ignored either.
      env: { ORCHESTRATOR_SID: 'orchestrator', ORCHESTRATOR_CLI: 'codex' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assert.equal(r.rc, 0, r.terminal);
    assert.match(r.terminal, /ORCHESTRATOR_CLI in this environment says 'codex'/);
    assert.match(r.terminal, /that is a hint,\s*\n?\s*not a selection/);
    assert.equal(fx.calls('exec')[0][4], 'claude', 'the environment selected the provider on a terminal');
  });

  await t.test('a control-character sid is refused before the wizard draws anything', () => {
    // D1 screens the env value on every path but --help, and it fires BEFORE the wizard,
    // so a sid that cannot survive the argv round trip never becomes a pre-filled prompt
    // an operator might just press Enter on.
    for (const [label, sid] of [['newline', 'orch\nboot'], ['tab', 'orch\tboot'], ['CR', 'orch\rboot'], ['DEL', 'orch\x7fboot']]) {
      const fx = fixture();
      const r = pty(fx, { cmd: bootCmd(), env: { ORCHESTRATOR_SID: sid }, steps: [], timeout: 15 });
      assert.equal(r.rc, 2, `${label}: expected exit 2, got ${r.rc}`);
      assert.equal(r.stdout, '', `${label}: a refusal wrote to the exec-argv channel`);
      assert.match(r.terminal, /ORCHESTRATOR_SID contains a control character/);
      assert.ok(!r.terminal.includes('Orchestrator boot wizard'),
        `${label}: the wizard drew its first screen despite an unusable sid`);
      fx.assertInert(`ctrl-sid/${label}`, { reads: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('providers are described from frozen data, never by running them', async t => {

  await t.test('a provider missing from PATH is UNAVAILABLE and not selectable', () => {
    const fx = fixture();
    fx.uninstall('codex');
    fx.uninstall('grok');
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        // Only claude and gemini remain, so the list is 1..2. Asking for 3 must be
        // refused rather than resolving to a provider that is not installed.
        { expect: 'provider [1-', send: '3\n' },
        { expect: 'not one of the listed numbers', send: 'q\n' },
      ],
    });
    assert.notEqual(r.rc, 0);
    assert.equal(r.stdout, '');
    assert.match(r.terminal, /codex\s+Codex CLI — UNAVAILABLE: no executable named 'codex' on PATH/);
    assert.match(r.terminal, /grok\s+Grok Build — UNAVAILABLE/);
    assert.match(r.terminal, /never installs anything and never substitutes another provider/);
    assert.match(r.terminal, /provider \[1-2\]/, 'an unavailable provider was still numbered');
    // Availability was decided WITHOUT executing anything.
    fx.assertNoProviderRan('missing binary');
  });

  await t.test('with NO provider on PATH the wizard cancels rather than guessing', () => {
    const fx = fixture();
    for (const p of ['claude', 'codex', 'gemini', 'grok']) fx.uninstall(p);
    const r = pty(fx, { cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' }, steps: [], timeout: 15 });
    assert.notEqual(r.rc, 0);
    assert.equal(r.stdout, '');
    assert.match(r.terminal, /no registered provider executable is on PATH/);
    fx.assertInert('no providers', { reads: true });
  });

  await t.test('no provider is executed at ANY point in planning or confirmation', () => {
    // Walk the LONGEST path through the wizard — every screen of every provider that has
    // the most of them — and then confirm. If a `--help` or `--version` were shelled out
    // anywhere on that path, the provider recorders would hold it.
    for (const [row, key, answers] of [
      [1, 'claude', ['\n', '\n', '\n', '\n']],
      [2, 'codex', ['\n', '\n', '\n', '\n', '\n']],
      [3, 'gemini', ['\n', '\n', '\n', '\n', '\n']],
      [4, 'grok', ['\n', '\n', '\n', '\n', '\n']],
    ]) {
      const fx = fixture();
      const steps = [{ expect: 'provider [1-', send: `${row}\n` }, { expect: 'model id', send: '\n' }];
      // The effort screen differs per provider: claude/grok prompt for a value, codex and
      // gemini print the gap/absence and wait on Enter.
      steps.push({ expect: key === 'codex' || key === 'gemini' ? 'Enter to continue' : 'effort (', send: '\n' });
      steps.push({ expect: key === 'codex' ? 'approval [1-' : key === 'claude' ? 'approval [1-' : 'approval [1-', send: '\n' });
      if (key !== 'claude') steps.push({ expect: 'sandbox [1-', send: '\n' });
      steps.push({ expect: 'history [1-', send: '\n' });
      steps.push({ expect: 'session id [', send: '\n' });
      steps.push({ expect: 'confirm [yes/NO]', send: 'YES\n' });
      void answers;

      const r = pty(fx, { cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' }, steps });
      assert.equal(r.rc, 0, `${key}: ${r.terminal}`);
      fx.assertNoProviderRan(`full walk / ${key}`);
      fx.assertHomeUntouched(`full walk / ${key}`);
      // The screens name the version the strings were MEASURED at, rather than a version
      // read from the installed binary — which is what "frozen data" means in practice.
      assert.match(r.terminal, /capabilities measured at \d+\.\d+\.\d+/);
      // Each provider's own flag spelling reached the argv.
      const argv = fx.calls('exec')[0];
      assert.equal(argv[4], key);
      assert.deepEqual(argv.slice(0, 4), ['allow-create-v1', '--id', 'orchestrator', '--auto-restart']);
    }
  });

  await t.test('the four providers map to four different measured argv tails', () => {
    // The registry's whole reason for existing: claude and grok both spell
    // `--permission-mode`, and they are NOT the same policy. `-s` is `--sandbox` on codex
    // and `--session-id` on grok. This pins the four tails as four distinct things.
    const want = {
      claude: ['claude', '--permission-mode', 'manual'],
      codex: ['codex', '--ask-for-approval', 'on-request', '--sandbox', 'read-only'],
      gemini: ['gemini', '--approval-mode', 'default', '--sandbox'],
      grok: ['grok', '--permission-mode', 'default', '--sandbox', 'strict'],
    };
    const perms = {
      claude: 'approval=manual',
      codex: 'approval=on-request;sandbox=read-only',
      gemini: 'approval=default;sandbox=on',
      grok: 'approval=default;sandbox=strict',
    };
    for (const key of Object.keys(want)) {
      const fx = fixture();
      const r = spawnSync('/bin/bash', [SHIM], {
        cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...fx.env, ORCHESTRATOR_SID: 'orchestrator', AIGENTRY_BOOT_PLAN: '1',
          ORCHESTRATOR_CLI: key, AIGENTRY_BOOT_PERMISSION: perms[key], AIGENTRY_BOOT_HISTORY: 'new',
        },
      });
      assert.equal(r.status, 0, `${key}: ${r.stderr}`);
      assert.deepEqual(fx.calls('exec'), [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', ...want[key]]]);
      fx.assertNoProviderRan(`mapping/${key}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('history is the provider\'s own, and it is never implicit', async t => {

  await t.test('a selected native session reaches the argv in that provider\'s own placement', () => {
    // codex takes its selector POSITIONALLY after `resume`; claude takes a UUID as the
    // value of `--resume`. A single shared "resume" concept would get one of them wrong.
    const uuid = '0f9c1a2b-3d4e-4f60-8a71-b2c3d4e5f607';
    const codex = fixture();
    let r = pty(codex, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '2\n' },
        { expect: 'model id', send: '\n' },
        { expect: 'Enter to continue', send: '\n' },
        { expect: 'approval [1-', send: '\n' },
        { expect: 'sandbox [1-', send: '\n' },
        { expect: 'history [1-', send: '3\n' },
        { expect: 'selector:', send: `${uuid}\n` },
        { expect: 'session id [', send: '\n' },
        { expect: 'confirm [yes/NO]', send: 'YES\n' },
      ],
    });
    assert.equal(r.rc, 0, r.terminal);
    assert.deepEqual(codex.calls('exec'),
      [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'codex', 'resume', uuid,
        '--ask-for-approval', 'on-request', '--sandbox', 'read-only']]);
    // The review screen says what resume is and — more importantly — what it is NOT.
    assert.match(r.terminal, /native resume is NOT a context handoff/);

    const claude = fixture();
    r = pty(claude, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        { expect: 'model id', send: '\n' },
        { expect: 'effort (', send: '\n' },
        { expect: 'approval [1-', send: '\n' },
        { expect: 'history [1-', send: '3\n' },
        { expect: 'selector:', send: `${uuid}\n` },
        { expect: 'session id [', send: '\n' },
        { expect: 'confirm [yes/NO]', send: 'YES\n' },
      ],
    });
    assert.equal(r.rc, 0, r.terminal);
    assert.deepEqual(claude.calls('exec'),
      [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--permission-mode', 'manual', '--resume', uuid]]);
    // No history LISTING was ever read to offer that selector — the operator types the id
    // they already know, because listing sessions would be a read this planning step must
    // not perform.
    claude.assertNoProviderRan('selected history');
  });

  await t.test('a selector that looks like a path, or like another provider\'s form, is refused', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [
        { expect: 'provider [1-', send: '1\n' },
        { expect: 'model id', send: '\n' },
        { expect: 'effort (', send: '\n' },
        { expect: 'approval [1-', send: '\n' },
        { expect: 'history [1-', send: '3\n' },
        // An external transcript path — the one history mechanism this module will never
        // offer.
        { expect: 'selector:', send: '../../etc/passwd\n' },
        { expect: 'refused:', send: '3\n' },
        // gemini's form ('latest') offered to claude, which is UUID-only.
        { expect: 'selector:', send: 'latest\n' },
        { expect: 'refused:', send: 'q\n' },
      ],
    });
    assert.notEqual(r.rc, 0);
    assert.equal(r.stdout, '');
    assert.match(r.terminal, /never a path/);
    assert.match(r.terminal, /a session UUID \(8-4-4-4-12 hex\)/);
    fx.assertInert('bad selector', { reads: true });
  });

  await t.test('history defaults to a NEW conversation, and nothing adds a resume flag', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assert.equal(r.rc, 0);
    const argv = fx.calls('exec')[0];
    assert.ok(!argv.includes('--continue'), 'a default boot resumed a conversation');
    assert.ok(!argv.includes('--resume'), 'a default boot resumed a conversation');
    assert.ok(!argv.includes('resume'), 'a default boot resumed a conversation');
    assert.match(r.terminal, /A NEW conversation is the default/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('--wizard-plan collects and prints, and acts on nothing', async t => {

  await t.test('it prints a reusable environment and touches nothing', () => {
    const fx = fixture();
    fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
    fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
    const r = pty(fx, {
      cmd: ['/bin/bash', SHIM, '--wizard-plan'],
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assert.equal(r.rc, 0, r.terminal);
    // ── v3: STDOUT IS ASSIGNMENT-ONLY ────────────────────────────────────────────
    // v1 measured the tagged `plan printed; …` note sharing fd 1 with the plan and
    // recorded it as a caller hazard (v1 §4.5(b)). The fix landed as a PER-MODE rule
    // (`LOG_FD = NO_EXEC && MODE !== "wizard-plan" ? 1 : 2`), so this asserts the
    // contract, not the absence of one line: on success, stdout is the assignments and
    // NOTHING else.
    const all = argvLines(r.stdout);
    assert.deepEqual(all, [
      'AIGENTRY_BOOT_PLAN=1',
      'ORCHESTRATOR_CLI=claude',
      'ORCHESTRATOR_SID=orchestrator',
      'AIGENTRY_BOOT_PERMISSION=approval=manual',
      'AIGENTRY_BOOT_HISTORY=new',
    ]);
    // Stated as a shape too, so a NEW line added later fails here rather than being
    // silently absorbed by the literal list above.
    for (const l of all) {
      assert.match(l, /^[A-Z][A-Z0-9_]*=[^\n]*$/,
        `--wizard-plan put a non-assignment line on stdout: ${JSON.stringify(l)}`);
      assert.ok(!l.startsWith('[orchestrator-boot] '),
        `a tagged log line is back on stdout: ${JSON.stringify(l)}`);
    }
    // The note did not vanish — it MOVED. Asserting only "stdout is clean" would pass
    // just as well if the confirmation had been deleted, which is a different product.
    assert.ok(r.terminal.includes("[orchestrator-boot] plan printed; nothing was reconciled, signalled, deleted or exec'd."),
      `the closing note is not on stderr: ${r.terminal.slice(-600)}`);
    // No line is a bare argv element either, so this mode's output stays distinguishable
    // from the boot path's contract channel even if something ever piped it there.
    for (const l of all) {
      assert.ok(!['telepty', 'allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude'].includes(l),
        `--wizard-plan put a bare exec-argv element alone on a line: ${l}`);
    }
    // A NON-EMPTY ARGV CAN NEVER BOOT: the shim exec'd node, so there is no command
    // substitution left to read those lines and the exec recorder must be empty.
    fx.assertInert('--wizard-plan', { reads: true });

    // And the printed plan is ACTUALLY reusable: feeding it back non-interactively must
    // produce the same argv the review screen showed. This is the claim the mode exists
    // for, so it is executed rather than asserted.
    const replay = fixture();
    const env2 = { ...replay.env, ORCHESTRATOR_SID: 'orchestrator' };
    for (const line of all) {
      const at = line.indexOf('=');
      env2[line.slice(0, at)] = line.slice(at + 1);
    }
    const back = spawnSync('/bin/bash', [SHIM], { cwd: replay.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env2 });
    assert.equal(back.status, 0, back.stderr);
    assert.deepEqual(replay.calls('exec'),
      [['allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--permission-mode', 'manual']]);
  });

  await t.test('without a terminal it refuses rather than inventing a plan', () => {
    const fx = fixture();
    const r = spawnSync('/bin/bash', [SHIM, '--wizard-plan'], {
      cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...fx.env, ORCHESTRATOR_SID: 'orchestrator' },
    });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /needs a terminal on stdin and stderr/);
    fx.assertInert('--wizard-plan non-tty', { reads: true });
  });

  await t.test('cancelling --wizard-plan prints no plan at all', () => {
    const fx = fixture();
    const r = pty(fx, {
      cmd: ['/bin/bash', SHIM, '--wizard-plan'],
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [{ expect: 'provider [1-', send: 'q\n' }],
    });
    assertDidNotBoot(r, '--wizard-plan cancel', { expectExit: 1 });
    assert.match(r.terminal, /no plan was printed and nothing was acted on/);
    fx.assertInert('--wizard-plan cancel', { reads: true });
  });

  await t.test('D1: a control-character sid refuses on STDERR with an EMPTY stdout, before any effect', () => {
    // NEW IN v3, and the one D1 oracle that MOVED. Everywhere else the refusal's stream is
    // unchanged (boot path fd 2, --help exempt entirely, --dry-run and the unknown-flag arm
    // where they were) — those are asserted elsewhere in this file and in T131 block S /
    // T134 block J, and none of them were touched.
    //
    // Here it used to reach fd 1 through LOG_FD, which meant a `--wizard-plan` capture
    // could contain prose. Three things are pinned: the stream, the empty capture, and
    // that the refusal happens BEFORE any effect — the last of which is unchanged code
    // (the check runs at module scope, ahead of every read) and is measured rather than
    // taken from the diff.
    for (const [label, sid] of [['newline', 'orch\nboot'], ['tab', 'orch\tboot'], ['CR', 'orch\rboot'], ['DEL', 'orch\x7fboot']]) {
      const fx = fixture();
      // Both fixtures ARMED: a real stale bridge to SIGKILL and a STALE/0-client record to
      // DELETE. "Nothing happened" is then a measurement, not an empty fixture agreeing
      // with itself.
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      const r = pty(fx, {
        cmd: ['/bin/bash', SHIM, '--wizard-plan'],
        env: { ORCHESTRATOR_SID: sid },
        steps: [],
        timeout: 15,
      });
      assert.equal(r.rc, 2, `${label}: expected exit 2, got ${r.rc}`);
      // THE CAPTURE IS EMPTY — not "empty apart from a note", empty.
      assert.equal(r.stdout, '',
        `${label}: the D1 refusal reached the plan capture channel: ${JSON.stringify(r.stdout)}`);
      // …and the diagnostic is on stderr, naming the field, with its text unchanged.
      assert.match(r.terminal, /ORCHESTRATOR_SID contains a control character/,
        `${label}: the refusal does not name the field on stderr`);
      // BEFORE ANY EFFECT. Not one seam was touched, including the read-only ones: no
      // process scan, no registry read, no SIGKILL, no DELETE, no credential resolution,
      // and no provider invocation.
      fx.assertInert(`wizard-plan/D1/${label}`, { reads: true });
      // The wizard never drew, so there was nothing for an operator to answer.
      assert.ok(!r.terminal.includes('Orchestrator boot wizard'),
        `${label}: the wizard drew a screen despite an unusable sid`);
    }
  });

  await t.test('every --wizard-plan refusal and cancellation leaves an EMPTY capture', () => {
    // The whole non-zero column of the mode's contract, driven rather than read off the
    // source. SCOPE, stated precisely: these are the refusal and cancellation paths. This
    // says nothing about a genuine fd-1 I/O error DURING the success loop, which the
    // author records as a pre-existing residual (partial capture with a non-zero exit) and
    // which is NOT exercised here — see the report. "Non-zero implies empty" is asserted
    // for these paths only, not as a universal property of the mode.
    const arms = [
      { name: 'bad opt-in value', env: { AIGENTRY_BOOT_PLAN: 'true' }, steps: [], rc: 2 },
      { name: 'plan field without the opt-in', env: { AIGENTRY_BOOT_PERMISSION: 'approval=manual' }, steps: [], rc: 2 },
      { name: 'q at the provider step', env: {}, steps: [{ expect: 'provider [1-', send: 'q\n' }], rc: 1 },
      { name: 'Ctrl-C at the review', env: {}, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', sig: 'INT' }], rc: 1 },
      { name: 'Ctrl-D (EOF on stdin) mid-way', env: {}, steps: [{ expect: 'provider [1-', send: '1\n' }, { expect: 'model id', sig: 'EOT' }], rc: 1 },
      { name: 'declined review', env: {}, steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: '\n' }], rc: 1 },
    ];
    for (const arm of arms) {
      const fx = fixture();
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      const r = pty(fx, {
        cmd: ['/bin/bash', SHIM, '--wizard-plan'],
        env: { ORCHESTRATOR_SID: 'orchestrator', ...arm.env },
        steps: arm.steps,
        timeout: 20,
      });
      assertDidNotBoot(r, arm.name, { expectExit: arm.rc });
      assert.ok(r.terminal.length > 0, `${arm.name}: the refusal said nothing on stderr either`);
      fx.assertInert(`wizard-plan/${arm.name}`, { reads: true });
    }

    // And the non-cancel outcome, written as what it is rather than folded into the list
    // above: the terminal vanishing kills node with SIGHUP. No exit code, no notice — but
    // the capture is still empty, which is the property a caller depends on.
    const gone = fixture();
    gone.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
    gone.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
    const hup = pty(gone, {
      cmd: ['/bin/bash', SHIM, '--wizard-plan'],
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [{ expect: 'provider [1-', send: '1\n' }, { expect: 'model id', eof: true }],
      timeout: 20,
    });
    assertDidNotBoot(hup, 'wizard-plan/terminal vanished', { expectSignal: 1 });
    gone.assertInert('wizard-plan/terminal vanished', { reads: true });
  });

  await t.test('the capture is safe to consume ONLY behind an exit-code check', () => {
    // The docs no longer offer `eval "$(… --wizard-plan)"` and say why. This drives both
    // halves of that reasoning through a real shell, so the instruction is backed by a
    // measurement rather than by prose.
    const fx = fixture();
    const ok = pty(fx, {
      cmd: ['/bin/bash', SHIM, '--wizard-plan'],
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assert.equal(ok.rc, 0);

    // (1) A SUCCESSFUL capture is a valid, complete env file: `set -a; . file` sources it
    // with no syntax error, and every variable arrives with the value that was printed.
    const planFile = path.join(fx.dir, 'plan.env');
    fs.writeFileSync(planFile, ok.stdout);
    const sourced = spawnSync('/bin/bash', ['-c',
      'set -euo pipefail; set -a; . "$1"; set +a; ' +
      'printf "%s|%s|%s|%s|%s" "$AIGENTRY_BOOT_PLAN" "$ORCHESTRATOR_CLI" "$ORCHESTRATOR_SID" "$AIGENTRY_BOOT_PERMISSION" "$AIGENTRY_BOOT_HISTORY"',
      '_', planFile], { encoding: 'utf8' });
    assert.equal(sourced.status, 0,
      `a successful capture is not a sourceable env file: ${sourced.stderr}`);
    assert.equal(sourced.stdout, '1|claude|orchestrator|approval=manual|new');

    // (2) A REFUSED capture is EMPTY — which is precisely why an unchecked `eval` is
    // wrong rather than merely inelegant: it succeeds silently, evaluates nothing, and
    // leaves the caller booting on whatever the environment already held. Measured, so
    // the docs' instruction is grounded.
    const bad = fixture();
    const refused = pty(bad, {
      cmd: ['/bin/bash', SHIM, '--wizard-plan'],
      env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [{ expect: 'provider [1-', send: 'q\n' }],
    });
    assert.notEqual(refused.rc, 0);
    assert.equal(refused.stdout, '');
    const blind = spawnSync('/bin/bash', ['-c',
      'set -u; PRIOR=stale-value; eval "$1"; printf "%s" "$PRIOR"', '_', refused.stdout],
      { encoding: 'utf8' });
    assert.equal(blind.status, 0);
    assert.equal(blind.stdout, 'stale-value',
      'an unchecked eval of a refused capture must be a silent no-op — this is the hazard the exit-code check exists for');

    // (3) The checked form the docs now prescribe does the right thing on both paths.
    const checked = (capture, rc) => spawnSync('/bin/bash', ['-c',
      'if [ "$2" -eq 0 ] && [ -n "$1" ]; then printf plan; else printf refused; fi',
      '_', capture, String(rc)], { encoding: 'utf8' }).stdout;
    assert.equal(checked(ok.stdout, ok.rc), 'plan');
    assert.equal(checked(refused.stdout, refused.rc), 'refused');
  });

  await t.test('usage documents the two-outcome capture contract and offers no eval', () => {
    const fx = fixture();
    const r = spawnSync('/bin/bash', [SHIM, '--help'], {
      cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: fx.env,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /NAME=value assignments and NOTHING else on success/);
    assert.match(r.stdout, /EMPTY on every refusal and cancellation/);
    assert.match(r.stdout, /a bad sid included\) are on stderr/);
    assert.match(r.stdout, /CHECK THE EXIT CODE/);
    // The removed encouragement must stay removed: an `eval "$(…)"` example in the text
    // is the thing that made the empty-capture path dangerous to follow.
    assert.ok(!/eval\s*"\$\(/.test(r.stdout),
      `usage still offers an unchecked eval of the capture: ${r.stdout}`);
    fx.assertInert('usage capture contract', { reads: true });
  });

  await t.test('--dry-run never prompts, even with a terminal on both channels', () => {
    // A dry run has to produce the same bytes from a script, a pipe and a prompt. If it
    // prompted on a terminal it would be the mode that asks — and its report would then
    // describe a plan the environment never stated.
    const fx = fixture();
    const r = pty(fx, {
      cmd: ['/bin/bash', SHIM, '--dry-run'],
      env: {
        ORCHESTRATOR_SID: 'orchestrator', AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'claude',
        AIGENTRY_BOOT_PERMISSION: 'approval=manual', AIGENTRY_BOOT_HISTORY: 'new',
      },
      steps: [],
      timeout: 20,
    });
    assert.equal(r.rc, 0, r.terminal);
    assert.ok(!r.terminal.includes('Orchestrator boot wizard'), 'a dry run drew the wizard');
    assert.match(r.stdout, /\[would-exec\] telepty/);
    assert.match(r.stdout, /--dry-run deliberately does not prompt/);
    fx.assertInert('--dry-run on a tty');
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('injection: every field is one argv element, or it is refused', async t => {
  const plan = await import(pathToFileURL(path.join(DIST, 'plan.js')).href);
  const caps = await import(pathToFileURL(path.join(DIST, 'provider-capabilities.js')).href);
  const CLAUDE = caps.findCapability('claude');
  const CODEX = caps.findCapability('codex');

  await t.test('model ids: option injection, control characters and shell metacharacters', () => {
    const bad = [
      ['--sandbox', 'a leading dash would reach the provider as a FLAG, configured by a field that claimed to name a model'],
      ['-m', 'ditto, short form'],
      ['claude; rm -rf /tmp/x', 'a shell metacharacter'],
      ['claude$(id)', 'a command substitution'],
      ['claude`id`', 'a backtick substitution'],
      ['claude && id', 'an AND-list'],
      ['claude|id', 'a pipe'],
      ['a\nb', 'a NEWLINE — the argv crosses back to the shim as newline-delimited text'],
      ['a\tb', 'a tab'],
      ['a\rb', 'a CR'],
      ['a\0b', 'a NUL'],
      ['a b', 'a space: one field is one argv token'],
      ['a'.repeat(200), 'over the length bound'],
      ['', 'empty is not "use the default" when stated explicitly'],
    ];
    for (const [value, why] of bad) {
      if (value === '') continue; // an UNSET model is the documented "provider default"
      const r = plan.validateModel(CLAUDE, value);
      assert.equal(r.ok, false, `model ${JSON.stringify(value)} was accepted (${why})`);
      assert.equal(r.error.field, 'AIGENTRY_BOOT_MODEL');
    }
    // The forms that ARE accepted, including the bracketed suffix real ids use.
    for (const good of ['claude-fable-5', 'gpt-5.2', 'a_b.c:d+e', 'claude-sonnet-4-5[1m]']) {
      assert.equal(plan.validateModel(CLAUDE, good).ok, true, `model ${good} was refused`);
    }
    // And an ACCEPTED model lands in exactly TWO elements: the flag and the value.
    const p = plan.parseEnvPlan({
      ORCHESTRATOR_CLI: 'claude', ORCHESTRATOR_SID: 'orchestrator',
      AIGENTRY_BOOT_MODEL: 'claude-fable-5', AIGENTRY_BOOT_PERMISSION: 'approval=manual',
      AIGENTRY_BOOT_HISTORY: 'new',
    }, '/tmp');
    assert.equal(p.ok, true, JSON.stringify(p.errors));
    assert.deepEqual(plan.buildExecArgv(p.plan),
      ['telepty', 'allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'claude', '--model', 'claude-fable-5', '--permission-mode', 'manual']);
  });

  await t.test('effort: only in the semantics each provider evidenced', () => {
    // claude — a measured ENUM. Nothing outside it, including a neighbour's token.
    for (const v of ['low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(plan.validateEffort(CLAUDE, v).ok, true, `claude effort ${v} refused`);
    }
    for (const v of ['ultracode', 'HIGH', 'veryhigh', '--high', 'high; id', 'high\n']) {
      assert.equal(plan.validateEffort(CLAUDE, v).ok, false, `claude effort ${JSON.stringify(v)} accepted`);
    }
    // codex — a RECORDED GAP. Setting it is an error that NAMES the gap, because silently
    // ignoring it would let a caller believe it took effect.
    const gap = plan.validateEffort(CODEX, 'high');
    assert.equal(gap.ok, false);
    assert.match(gap.error.message, /no measured effort flag/);
    // gemini — measured ABSENT. Same refusal, different reason, and the reasons must stay
    // distinguishable or "unknown" and "unsupported" collapse into one claim.
    const unsupported = plan.validateEffort(caps.findCapability('gemini'), 'high');
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error.message, /no effort flag/);
    // grok — the flag exists, the value set does not. A bounded literal, carried with a
    // warning; still no injection.
    const grok = caps.findCapability('grok');
    assert.equal(plan.validateEffort(grok, 'high').ok, true);
    assert.equal(plan.validateEffort(grok, 'high').choice.kind, 'unverified');
    for (const v of ['high value', 'high;id', '--high', 'x'.repeat(40)]) {
      assert.equal(plan.validateEffort(grok, v).ok, false, `grok effort ${JSON.stringify(v)} accepted`);
    }
  });

  await t.test('the sid: one argv token and one registry id, or nothing', () => {
    for (const v of ['orch boot', 'orch\tboot', 'orch\nboot', '-orch', '', 'a'.repeat(200), 'orch\x7f']) {
      assert.equal(plan.validateSid(v).ok, false, `sid ${JSON.stringify(v)} accepted`);
    }
    assert.equal(plan.validateSid(undefined).ok, false, 'an ABSENT sid was accepted in a plan');
    // A regex metacharacter is fine — the guard compares LITERALLY (D3), so this is a
    // legal id and refusing it would be the old dynamic-regex defect in reverse.
    for (const v of ['orchestrator', 'orch.tor', 'orch[', 'orch-2']) {
      assert.equal(plan.validateSid(v).ok, true, `sid ${JSON.stringify(v)} refused`);
    }
  });

  await t.test('permission axes: no cross-provider tokens, no missing axis, no contradiction', () => {
    const p = (env) => plan.parseEnvPlan({ ORCHESTRATOR_SID: 'orchestrator', AIGENTRY_BOOT_HISTORY: 'new', ...env }, '/tmp');
    // A token valid on ANOTHER provider's axis is not evidence for this one.
    assert.equal(p({ ORCHESTRATOR_CLI: 'claude', AIGENTRY_BOOT_PERMISSION: 'approval=yolo' }).ok, false);
    assert.equal(p({ ORCHESTRATOR_CLI: 'gemini', AIGENTRY_BOOT_PERMISSION: 'approval=default;sandbox=read-only' }).ok, false);
    // An omitted axis is INCOMPLETE, never permissive.
    const missing = p({ ORCHESTRATOR_CLI: 'codex', AIGENTRY_BOOT_PERMISSION: 'approval=on-request' });
    assert.equal(missing.ok, false);
    assert.match(missing.errors.map(e => e.message).join('\n'), /an omitted axis is an incomplete plan, never a permissive default/);
    // codex's combined bypass COVERS the sandbox axis, so naming a sandbox value too is a
    // contradiction rather than a refinement…
    const contradiction = p({
      ORCHESTRATOR_CLI: 'codex',
      AIGENTRY_BOOT_PERMISSION: 'approval=dangerously-bypass-approvals-and-sandbox;sandbox=read-only',
      AIGENTRY_BOOT_RISK_ACK: 'x',
    });
    assert.equal(contradiction.ok, false);
    assert.match(contradiction.errors.map(e => e.message).join('\n'), /two contradictory policies on one command line/);
    // …and on its own it is accepted only WITH the derived acknowledgement.
    const noAck = p({ ORCHESTRATOR_CLI: 'codex', AIGENTRY_BOOT_PERMISSION: 'approval=dangerously-bypass-approvals-and-sandbox' });
    assert.equal(noAck.ok, false);
    assert.equal(noAck.errors[0].field, 'AIGENTRY_BOOT_RISK_ACK');
    const withAck = p({
      ORCHESTRATOR_CLI: 'codex',
      AIGENTRY_BOOT_PERMISSION: 'approval=dangerously-bypass-approvals-and-sandbox',
      AIGENTRY_BOOT_RISK_ACK: 'I ACCEPT ELEVATED codex approval=dangerously-bypass-approvals-and-sandbox',
    });
    assert.equal(withAck.ok, true, JSON.stringify(withAck.errors));
    assert.deepEqual(plan.buildExecArgv(withAck.plan),
      ['telepty', 'allow-create-v1', '--id', 'orchestrator', '--auto-restart', 'codex', '--dangerously-bypass-approvals-and-sandbox']);
    // Schema abuse in the field itself.
    for (const raw of ['approval', 'approval=', '=manual', 'approval=manual;approval=plan', 'approval=manual;;', 'approval manual']) {
      assert.equal(p({ ORCHESTRATOR_CLI: 'claude', AIGENTRY_BOOT_PERMISSION: raw }).ok, false,
        `permission field ${JSON.stringify(raw)} was accepted`);
    }
  });

  await t.test('the acknowledgement phrase is derived from the SELECTION, not a constant', () => {
    const mk = perm => plan.parseEnvPlan({
      ORCHESTRATOR_CLI: 'claude', ORCHESTRATOR_SID: 'orchestrator',
      AIGENTRY_BOOT_HISTORY: 'new', AIGENTRY_BOOT_PERMISSION: perm,
      AIGENTRY_BOOT_RISK_ACK: 'I ACCEPT ELEVATED claude approval=auto',
    }, '/tmp');
    // The phrase that authorises `auto` must NOT authorise `bypassPermissions`.
    assert.equal(mk('approval=auto').ok, true);
    assert.equal(mk('approval=bypassPermissions').ok, false);
    assert.equal(mk('approval=dangerously-skip-permissions').ok, false);
  });

  await t.test('cwd is display-only and never becomes a flag, for the two providers that HAVE one', () => {
    // codex has `-C, --cd <DIR>` and grok has `--cwd <CWD>`. Both are real in these
    // builds and both are deliberately unused: the bridge inherits the cwd of the shell
    // that execs it, and a flag disagreeing with that would make the review screen wrong.
    for (const [key, perm] of [['codex', 'approval=on-request;sandbox=read-only'], ['grok', 'approval=default;sandbox=strict']]) {
      const r = plan.parseEnvPlan({
        ORCHESTRATOR_CLI: key, ORCHESTRATOR_SID: 'orchestrator',
        AIGENTRY_BOOT_PERMISSION: perm, AIGENTRY_BOOT_HISTORY: 'new',
      }, '/some/where');
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const argv = plan.buildExecArgv(r.plan);
      for (const flag of ['-C', '--cd', '--cwd']) {
        assert.ok(!argv.includes(flag), `${key}: a cwd flag reached the argv`);
      }
      assert.ok(!argv.includes('/some/where'), `${key}: the cwd itself reached the argv`);
      // It IS displayed, marked as inherited.
      assert.ok(plan.describePlan(r.plan).some(l => l.includes('/some/where') && l.includes('INHERITED')));
    }
  });

  await t.test('the argv head is fixed data on every path, and every element stays one token', () => {
    // Whatever the plan chose, the first five elements are the ones telepty's lifecycle
    // and the singleton guard's match token depend on.
    const combos = [
      ['claude', 'approval=manual', 'new'],
      ['claude', 'approval=plan', 'last'],
      ['codex', 'approval=on-request;sandbox=workspace-write', 'new'],
      ['gemini', 'approval=plan;sandbox=off', 'last'],
      ['grok', 'approval=plan;sandbox=read-only', 'new'],
    ];
    for (const [cli, perm, hist] of combos) {
      const r = plan.parseEnvPlan({
        ORCHESTRATOR_CLI: cli, ORCHESTRATOR_SID: 'orch.tor',
        AIGENTRY_BOOT_PERMISSION: perm, AIGENTRY_BOOT_HISTORY: hist,
      }, '/tmp');
      assert.equal(r.ok, true, `${cli}/${perm}/${hist}: ${JSON.stringify(r.errors)}`);
      const argv = plan.buildExecArgv(r.plan);
      assert.deepEqual(argv.slice(0, 5), ['telepty', 'allow-create-v1', '--id', 'orch.tor', '--auto-restart']);
      for (const el of argv) {
        assert.equal(typeof el, 'string');
        assert.ok(!/[\n\r\t\0]/.test(el), `an argv element carries a control character: ${JSON.stringify(el)}`);
        assert.ok(el.length > 0, 'an empty argv element would vanish in the shim round trip');
      }
    }
  });

  await t.test('no model catalogue is pinned, and "provider default" is not "the latest"', () => {
    // #1148 is what will supply shared fresh-model discovery. This registry must record
    // the FLAG and nothing about which ids exist — a list frozen here would go stale and
    // then keep claiming an old model was current.
    for (const cap of caps.CAPABILITIES) {
      assert.equal(cap.model.flag, '--model');
      // "Provider default" must be defined as WHAT THAT INSTALL IS CONFIGURED TO USE.
      // The notes are allowed to EXPLAIN why a pinned catalogue would wrongly claim
      // recency — several do — so the check is on the affirmative claim, not on the word.
      assert.match(cap.model.defaultNote, /configured to use|install's configured model/,
        `${cap.key} does not define "provider default" as the install's own configuration: ${cap.model.defaultNote}`);
      assert.ok(!/\b(is|are) the latest\b/i.test(cap.model.defaultNote),
        `${cap.key} claims its provider default IS the latest model: ${cap.model.defaultNote}`);
      assert.ok(!/\blatest model\b/i.test(cap.model.defaultNote.replace(/claim an old model was the latest/gi, '')),
        `${cap.key} makes a recency claim about the provider default: ${cap.model.defaultNote}`);
      assert.ok(!Object.prototype.hasOwnProperty.call(cap.model, 'values'),
        `${cap.key} pins a model catalogue`);
      assert.equal(cap.provenance, 'unverified');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
test('the no-exec and refusal paths never reach an exec, whatever the environment says', async t => {

  await t.test('unknown argv, probes and incomplete non-TTY plans all leave the exec recorder empty', () => {
    const rows = [
      { label: 'unknown flag', args: ['--bogus'], env: {}, rc: 2 },
      { label: 'two tokens', args: ['--dry-run', '--bogus'], env: {}, rc: 2 },
      { label: 'help and dry-run together', args: ['--dry-run', '--help'], env: {}, rc: 2 },
      { label: 'one empty argument', args: [''], env: {}, rc: 2 },
      { label: 'bare, no terminal, no plan', args: [], env: {}, rc: 2 },
      { label: 'bare, no terminal, provider only', args: [], env: { ORCHESTRATOR_CLI: 'claude' }, rc: 2 },
      { label: 'bare, no terminal, partial plan', args: [], env: { AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'claude' }, rc: 2 },
      { label: 'probe: singleton-guard, no plan', args: ['__probe', 'singleton-guard'], env: {}, rc: 2 },
      { label: 'probe: registry-reconcile, no plan', args: ['__probe', 'registry-reconcile'], env: {}, rc: 2 },
      { label: 'probe: exec-argv, no plan', args: ['__probe', 'exec-argv'], env: {}, rc: 2 },
    ];
    for (const row of rows) {
      const fx = fixture();
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      const r = spawnSync('/bin/bash', [SHIM, ...row.args], {
        cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...fx.env, ORCHESTRATOR_SID: 'orchestrator', ...row.env },
      });
      assert.equal(r.status, row.rc, `${row.label}: expected exit ${row.rc}, got ${r.status}; stderr: ${r.stderr}`);
      assert.equal(r.stdout, '', `${row.label}: wrote to the exec-argv channel: ${r.stdout}`);
      fx.assertInert(row.label, { reads: true });
      // No refusal may echo a removed bypass argv back at the caller.
      assert.ok(!/--dangerously-(skip-permissions|bypass)/.test(r.stdout),
        `${row.label}: a refusal printed a removed bypass argv`);
    }
  });

  await t.test('the removed destructive probes are gone, and exec-argv still acts on nothing', () => {
    // Task 1270 — `__probe singleton-guard` and `__probe registry-reconcile` were the inspection
    // doors of the SIGKILL guard and the DELETE reconcile, and they are REMOVED with that code.
    // (Their earlier assertions — "would SIGKILL pid=7777", "would DELETE" — pinned effects the
    // boot no longer has, so they are replaced, not relaxed.) With a complete plan and both old
    // fixtures armed they now land on the unknown-subcommand arm: exit 4, every recorder empty.
    for (const sub of ['singleton-guard', 'registry-reconcile']) {
      const fx = fixture();
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      const r = spawnSync('/bin/bash', [SHIM, '__probe', sub], {
        cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...fx.env, ORCHESTRATOR_SID: 'orchestrator', ...CLAUDE_PLAN },
      });
      assert.equal(r.status, 4, `${sub}: expected the unknown-subcommand exit 4, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /unknown __probe subcommand/);
      assert.equal(r.stdout, '');
      assert.ok(!/would (SIGKILL|DELETE)/.test(r.stdout + r.stderr), `${sub}: a removed effect was still described`);
      fx.assertInert(`probe/${sub}`, { reads: true });
    }
    // exec-argv survives: it prints the would-be argv and acts on nothing — no capability probe,
    // no daemon request, no credential read, no exec.
    const fx = fixture();
    const r = spawnSync('/bin/bash', [SHIM, '__probe', 'exec-argv'], {
      cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...fx.env, ORCHESTRATOR_SID: 'orchestrator', ...CLAUDE_PLAN },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(argvLines(r.stdout), ['telepty', ...CLAUDE_ARGV('orchestrator')]);
    fx.assertInert('probe/exec-argv', { reads: true });
  });

  await t.test('D1 moved for --wizard-plan ONLY; every other mode keeps the stream it had', () => {
    // The v3 correction is a PER-MODE exemption. That claim is only checkable if the
    // other modes are measured too — otherwise "we changed one mode" is indistinguishable
    // from "we changed the constant and got lucky". One row per mode that can reach D1.
    // MEASURED on both revisions, side by side. Exactly one row differs; the rest are
    // byte-identical. `on` is where the refusal actually lands, NOT where one might
    // prefer it — this table records the product, and the two rows that put a diagnostic
    // on fd 1 are pre-existing behaviour inherited unchanged (see the note below).
    const badSid = 'orch\nboot';
    const rows = [
      { name: 'boot path (non-TTY)', args: [], on: 'stderr' },
      // fd 1, because LOG_FD is 1 for every NO_EXEC mode except --wizard-plan. Unchanged
      // from the previous revision, and correct for --dry-run, whose whole report is a
      // deliberate fd-1 stream.
      { name: '--dry-run', args: ['--dry-run'], on: 'stdout' },
      // FIXED in bc1181kg-v1, and this row is the regression for it. It previously sat
      // on fd 1, against the arm's own stated contract (cli.ts unknownFlag(): "`… --bogus
      // > out` must leave `out` empty rather than looking like it produced something") —
      // D1 fires at module scope, before that arm, and resolved through LOG_FD, which was
      // 1 for MODE "unknown". The constant now exempts this mode too, so the refusal is
      // on stderr and the redirect target is empty. Driven end-to-end below as well.
      { name: 'unknown flag', args: ['--bogus'], on: 'stderr' },
      // The two-token shape is the SAME mode, and a fix that covered only the one-token
      // spelling would pass the row above and still leak here.
      { name: 'unknown flag (two tokens)', args: ['--dry-run', '--bogus'], on: 'stderr' },
      { name: '__probe', args: ['__probe', 'exec-argv'], on: 'stderr' },
      // THE ONE THAT MOVED (v3): stdout on the previous revision, stderr now.
      { name: '--wizard-plan', args: ['--wizard-plan'], on: 'stderr' },
    ];
    for (const row of rows) {
      const fx = fixture();
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      const r = spawnSync('/bin/bash', [SHIM, ...row.args], {
        cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...fx.env, ORCHESTRATOR_SID: badSid },
      });
      assert.equal(r.status, 2, `${row.name}: expected exit 2, got ${r.status}`);
      const hit = /ORCHESTRATOR_SID contains a control character/;
      const [carries, empty] = row.on === 'stdout' ? [r.stdout, r.stderr] : [r.stderr, r.stdout];
      assert.match(carries, hit, `${row.name}: the D1 refusal is not on ${row.on}`);
      assert.ok(!hit.test(empty), `${row.name}: the D1 refusal is on BOTH streams`);
      // For --wizard-plan and the unknown-flag arm the empty stream is stdout, and it
      // must be EMPTY OUTRIGHT — not merely free of this one message. Both modes promise
      // a caller that a redirect target stays untouched, and "no D1 line" would still
      // pass if some other prose landed there.
      if (row.on === 'stderr' && row.args.length > 0 && row.args[0] !== '__probe') {
        assert.equal(r.stdout, '', `${row.name}: the redirect target was not empty: ${JSON.stringify(r.stdout)}`);
      }
      fx.assertInert(`D1/${row.name}`, { reads: true });
    }
    // --help stays exempt from the check entirely — it must PRINT, not refuse.
    const fx = fixture();
    const help = spawnSync('/bin/bash', [SHIM, '--help'], {
      cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...fx.env, ORCHESTRATOR_SID: badSid },
    });
    assert.equal(help.status, 0, '--help must stay exempt from the D1 refusal');
    assert.match(help.stdout, /Usage:/);
    assert.ok(!/contains a control character/.test(help.stdout + help.stderr),
      '--help refused over an unrelated env var');
    fx.assertInert('D1/--help', { reads: true });
  });

  await t.test("`orchestrator-boot.sh --bogus > out` leaves `out` empty, bad sid or not", () => {
    // THE REGRESSION FOR THE FORMERLY-STDOUT ROW, driven as the literal shell command
    // the arm's contract is written about — a real `>` redirect to a real file, not a
    // captured pipe — so it fails if the refusal reaches fd 1 by ANY route.
    //
    // Non-vacuous by construction: the sane-sid half proves the redirect and the file
    // would show content if anything were written, and the bad-sid half is the case that
    // used to write 212 bytes there. If the fix were reverted, the second row fails on
    // `out` being non-empty AND on stderr being empty — two independent ways.
    for (const [label, sid] of [
      ['a sane sid', 'orchestrator'],
      ['a newline sid (the D1 case that used to leak)', 'orch\nboot'],
      ['a tab sid', 'orch\tboot'],
    ]) {
      for (const args of [['--bogus'], ['--dry-run', '--bogus']]) {
        const fx = fixture();
        fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
        fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
        const out = path.join(fx.dir, 'out');
        const err = path.join(fx.dir, 'err');
        const r = spawnSync('/bin/bash', ['-c',
          '"$1" "${@:4}" > "$2" 2> "$3"; echo -n $?',
          '_', SHIM, out, err, ...args],
          { cwd: fx.cwd, encoding: 'utf8', env: { ...fx.env, ORCHESTRATOR_SID: sid } });
        const rc = r.stdout;
        const outBytes = fs.readFileSync(out, 'utf8');
        const errBytes = fs.readFileSync(err, 'utf8');
        const what = `${args.join(' ')} / ${label}`;

        assert.equal(rc, '2', `${what}: expected exit 2, got ${rc}; stderr: ${errBytes}`);
        // THE CONTRACT: the redirect target is EMPTY — zero bytes, not "no D1 line".
        assert.equal(outBytes, '',
          `${what}: '> out' is not empty — a failed invocation looks like it produced something: ${JSON.stringify(outBytes)}`);
        // …and the diagnostic did go somewhere, so "empty" is not "silent".
        assert.ok(errBytes.length > 0, `${what}: nothing was written to stderr either`);
        if (sid === 'orchestrator') {
          // The ordinary arm: it names the offending flag and prints usage.
          assert.match(errBytes, /unknown argument: /, `${what}: the refusal does not name the arm`);
          assert.match(errBytes, /--bogus/, `${what}: the refusal does not name the offending flag`);
          assert.match(errBytes, /Usage:/, `${what}: the refusal did not print usage`);
        } else {
          // The D1 arm: it refuses earlier, naming the field, and never reaches usage.
          assert.match(errBytes, /ORCHESTRATOR_SID contains a control character/,
            `${what}: the D1 refusal is not on stderr`);
        }
        // Exit 2 BEFORE any effect, on both arms.
        fx.assertInert(`bogus-redirect/${what}`, { reads: true });
      }
    }
  });

  await t.test('help is inert and readable under every hostile environment', () => {
    const hostile = [
      { AIGENTRY_BOOT_PLAN: 'true' },
      { AIGENTRY_BOOT_PERMISSION: 'approval=bypassPermissions' },
      { ORCHESTRATOR_SID: 'orch\nboot' },
      { ORCHESTRATOR_SID: 'orch\tboot', AIGENTRY_BOOT_PLAN: 'nope', ORCHESTRATOR_CLI: 'not-real' },
      { AIGENTRY_BOOT_PLAN: '1', ORCHESTRATOR_CLI: 'x', AIGENTRY_BOOT_MODEL: '--evil', AIGENTRY_BOOT_HISTORY: 'selected=/etc/passwd' },
    ];
    for (const extra of hostile) {
      for (const flag of ['--help', '-h']) {
        const fx = fixture();
        fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
        fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
        const r = spawnSync('/bin/bash', [SHIM, flag], {
          cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...fx.env, ...extra },
        });
        const label = `${flag} ${JSON.stringify(extra)}`;
        assert.equal(r.status, 0, `${label}: help must exit 0, got ${r.status}: ${r.stderr}`);
        assert.match(r.stdout, /Usage:/, `${label}: help printed no usage`);
        fx.assertInert(label, { reads: true });
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TASK 1270 — THE CREATE-ONLY BOOT PREFLIGHT (written before the product change; not executed by its author).
//
// The boot no longer SIGKILLs a bridge or DELETEs a registry record. Before it hands back an argv
// it asks three bounded, exact-local questions and boots ONLY when the answer is FRESH:
//   1. is the target the canonical 127.0.0.1 and a numeric port (decided before any process or request);
//   2. does the telepty on PATH print the sealed boot-capabilities document (old help + exit 0 is not support);
//   3. does the local daemon advertise wrapped-sessions + register-create-only, and is there NO session
//      with this exact id (404)?
// Every other verdict is exit 3, an EMPTY stdout (so the shim cannot exec) and zero mutation. FRESH
// execs `telepty allow-create-v1 …`, and a creation race after FRESH is refused by the daemon's own
// create_only (409) — that server half is telepty's, not measurable through this fixture's recorder.
function planBoot(fx, extra = {}, sid = 'orchestrator') {
  return spawnSync('/bin/bash', [SHIM], {
    cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...fx.env, ORCHESTRATOR_SID: sid, ...CLAUDE_PLAN, ...extra },
  });
}
function assertPreflightRefused(fx, r, verdict, label) {
  assert.equal(r.status, 3, `${label}: expected exit 3, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout, '', `${label}: a refused preflight wrote to the exec-argv channel: ${JSON.stringify(r.stdout)}`);
  assert.match(r.stderr, new RegExp(`boot preflight ${verdict}\\b`), `${label}: the verdict is not named: ${r.stderr}`);
  assert.match(r.stderr, /Nothing was created, attached, signalled, deleted or exec'd\./, `${label}: no zero-effect statement`);
  assert.deepEqual(fx.calls('exec'), [], `${label}: the exec was reached`);
  fx.assertNoDestructiveEffect(label);
  fx.assertNoProviderRan(label);
  assert.ok(!(r.stdout + r.stderr).includes('fixture-token-bt1181jm'), `${label}: the credential was printed`);
}

test('task 1270: the boot preflight is exact-local, create-only and non-destructive', async t => {

  await t.test('FRESH — and only FRESH — execs telepty allow-create-v1, after exactly two GETs', () => {
    const fx = fixture();
    // Old fixtures armed as tripwires: a live-looking bridge and a STALE/0-client record for the sid.
    fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
    fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
    const r = planBoot(fx);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fx.calls('exec'), [CLAUDE_ARGV('orchestrator')]);
    assert.ok(!fx.calls('exec')[0].includes('allow'), 'the legacy `allow` verb reached the exec');
    assert.deepEqual(fx.calls('caps'), [['boot-capabilities']]);
    assert.deepEqual(fx.requests(), [['GET', META_URL], ['GET', sessionUrl('orchestrator')]]);
    fx.assertNoDestructiveEffect('FRESH');
    // The preflight runs BEFORE the boot record and the argv.
    const at = s => r.stderr.indexOf(s);
    assert.ok(at('boot preflight FRESH') >= 0 && at('boot preflight FRESH') < at('[orchestrator-boot] boot record: '), r.stderr);
    assert.ok(at('[orchestrator-boot] boot record: ') < at('[orchestrator-boot] exec '), r.stderr);
    // Bounded, exact-local, proxy-free requests; the credential is a header value only.
    for (const a of fx.calls('curl')) {
      assert.ok(a.includes('--noproxy') && a.includes('--max-time'), `unbounded or proxyable request: ${JSON.stringify(a.slice(-1))}`);
      assert.ok(a[a.length - 1].startsWith('http://127.0.0.1:3848/'), a[a.length - 1]);
    }
    assert.ok(!(r.stdout + r.stderr).includes('fixture-token-bt1181jm'), 'the credential was printed');
  });

  await t.test('an old telepty (help + exit 0) and every malformed capability document is UNSUPPORTED, before any request', () => {
    const rows = [
      ['old CLI: help and exit 0', '\nUsage: telepty <command>\n  telepty allow [--id <id>] <command>\n', 0],
      ['empty output, exit 0', '', 0],
      ['sealed line, exit 1', SEALED_CAPS, 1],
      ['not JSON', '{\n', 0],
      ['no trailing newline', SEALED_CAPS.trimEnd(), 0],
      ['two lines', SEALED_CAPS + SEALED_CAPS, 0],
      ['extra key', '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1","x":1}\n', 0],
      ['other schema', '{"schema":"telepty-boot-capabilities-v2","verbs":["allow-create-v1"],"viewer_detach":"nondeleting-v1"}\n', 0],
      ['verb missing', '{"schema":"telepty-boot-capabilities-v1","verbs":["allow"],"viewer_detach":"nondeleting-v1"}\n', 0],
      ['duplicate verb', '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1","allow-create-v1"],"viewer_detach":"nondeleting-v1"}\n', 0],
      ['non-string verb', '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1",1],"viewer_detach":"nondeleting-v1"}\n', 0],
      ['deleting viewer detach', '{"schema":"telepty-boot-capabilities-v1","verbs":["allow-create-v1"],"viewer_detach":"deleting"}\n', 0],
      ['array document', '["telepty-boot-capabilities-v1"]\n', 0],
    ];
    for (const [label, text, rc] of rows) {
      const fx = fixture();
      fx.bootCaps(text, rc);
      const r = planBoot(fx);
      assertPreflightRefused(fx, r, 'UNSUPPORTED', label);
      assert.deepEqual(fx.calls('caps'), [['boot-capabilities']], `${label}: the probe ran a different number of times`);
      assert.deepEqual(fx.calls('curl'), [], `${label}: a daemon request followed an unsupported CLI`);
      assert.deepEqual(fx.calls('auth'), [], `${label}: a credential was read for an unsupported CLI`);
    }
  });

  await t.test('only the canonical 127.0.0.1 and a numeric port are a target; anything else is refused before any process or request', () => {
    const refused = [
      { TELEPTY_HOST: 'localhost' }, { TELEPTY_HOST: '::1' }, { TELEPTY_HOST: '127.0.0.1:3848' },
      { TELEPTY_HOST: 'http://127.0.0.1' }, { TELEPTY_HOST: '127.0.0.2' }, { TELEPTY_HOST: '10.0.0.5' },
      { TELEPTY_HOST: 'peer-a' }, { TELEPTY_PORT: 'abc' }, { TELEPTY_PORT: '0' }, { TELEPTY_PORT: '70000' },
      { TELEPTY_PORT: '03848' }, { TELEPTY_PORT: '3848x' },
    ];
    for (const extra of refused) {
      const fx = fixture();
      const r = planBoot(fx, extra);
      const label = JSON.stringify(extra);
      assertPreflightRefused(fx, r, 'TARGET_REFUSED', label);
      for (const k of ['caps', 'curl', 'auth']) assert.deepEqual(fx.calls(k), [], `${label}: '${k}' ran for a refused target`);
    }
    // The accepted shapes: explicit canonical host, and a chosen numeric port that both GETs then use.
    const fx = fixture();
    const r = planBoot(fx, { TELEPTY_HOST: '127.0.0.1', TELEPTY_PORT: '4000' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fx.requests(), [['GET', 'http://127.0.0.1:4000/api/meta'], ['GET', sessionUrl('orchestrator', '4000')]]);
    assert.deepEqual(fx.calls('exec'), [CLAUDE_ARGV('orchestrator')]);
  });

  await t.test('the daemon capability check: every non-supporting answer stops the boot before the session lookup', () => {
    const rows = [
      ['401', { code: '401', body: '{"error":"Unauthorized"}' }, 'CREDENTIAL_REFUSED'],
      ['403', { code: '403', body: '{"error":"Forbidden"}' }, 'CREDENTIAL_REFUSED'],
      ['register-create-only missing', { code: '200', body: '{"capabilities":["sessions","wrapped-sessions"]}' }, 'UNSUPPORTED'],
      ['wrapped-sessions missing', { code: '200', body: '{"capabilities":["register-create-only"]}' }, 'UNSUPPORTED'],
      ['no capability list (old daemon)', { code: '200', body: '{"version":"0.9.2"}' }, 'UNSUPPORTED'],
      ['capabilities not an array', { code: '200', body: '{"capabilities":{"wrapped-sessions":true,"register-create-only":true}}' }, 'UNSUPPORTED'],
      ['not JSON', { code: '200', body: '<html>' }, 'UNKNOWN'],
      ['JSON null', { code: '200', body: 'null' }, 'UNKNOWN'],
      ['5xx', { code: '500', body: '{"capabilities":["wrapped-sessions","register-create-only"]}' }, 'UNKNOWN'],
      ['timeout', { code: '000', body: '', exit: 28 }, 'UNKNOWN'],
      ['connection refused', { code: '000', body: '', exit: 7 }, 'UNKNOWN'],
    ];
    for (const [label, meta, verdict] of rows) {
      const fx = fixture();
      fx.daemon({ meta });
      const r = planBoot(fx);
      assertPreflightRefused(fx, r, verdict, `meta ${label}`);
      assert.deepEqual(fx.requests(), [['GET', META_URL]], `meta ${label}: the session was looked up anyway`);
    }
  });

  await t.test('the exact-session lookup: only a 404 is FRESH; an existing session is never killed, attached or replaced', () => {
    const rows = [
      ['exists (200, exact id)', { code: '200', body: JSON.stringify({ id: 'orchestrator', type: 'wrapped', alias: null, active_clients: 0 }) }, 'EXISTS_IDENTITY_UNPROVEN'],
      ['resolved through an alias', { code: '200', body: JSON.stringify({ id: 'orchestrator-2', alias: 'orchestrator' }) }, 'UNKNOWN'],
      ['alias set on the exact id', { code: '200', body: JSON.stringify({ id: 'orchestrator', alias: 'orchestrator' }) }, 'UNKNOWN'],
      ['a different id', { code: '200', body: JSON.stringify({ id: 'someone-else' }) }, 'UNKNOWN'],
      ['200 without JSON', { code: '200', body: 'ok' }, 'UNKNOWN'],
      ['404 without JSON', { code: '404', body: '<html>not found</html>' }, 'UNKNOWN'],
      ['401', { code: '401', body: '{"error":"Unauthorized"}' }, 'CREDENTIAL_REFUSED'],
      ['403', { code: '403', body: '{"error":"Forbidden"}' }, 'CREDENTIAL_REFUSED'],
      ['5xx', { code: '503', body: '{"error":"busy"}' }, 'UNKNOWN'],
      ['timeout', { code: '000', body: '', exit: 28 }, 'UNKNOWN'],
    ];
    for (const [label, session, verdict] of rows) {
      const fx = fixture();
      // An existing native task with a live-looking bridge: the old boot would have SIGKILLed it.
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      fx.listing([{ id: 'orchestrator', healthStatus: 'STALE', active_clients: 0 }]);
      fx.daemon({ session });
      const r = planBoot(fx);
      assertPreflightRefused(fx, r, verdict, `session ${label}`);
      assert.deepEqual(fx.requests(), [['GET', META_URL], ['GET', sessionUrl('orchestrator')]], `session ${label}`);
    }
  });

  await t.test('a sid is looked up as ONE encoded path segment', () => {
    const fx = fixture();
    const r = planBoot(fx, {}, 'orch.tor');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fx.requests(), [['GET', META_URL], ['GET', 'http://127.0.0.1:3848/api/sessions/orch.tor']]);
  });

  await t.test('a wizard boot whose session already exists stops after YES with an empty stdout', () => {
    const fx = fixture();
    fx.daemon({ session: { code: '200', body: JSON.stringify({ id: 'orchestrator', type: 'wrapped' }) } });
    const r = pty(fx, {
      cmd: bootCmd(), env: { ORCHESTRATOR_SID: 'orchestrator' },
      steps: [...CLAUDE_TO_REVIEW, { expect: 'confirm [yes/NO]', send: 'YES\n' }],
    });
    assertDidNotBoot(r, 'wizard EXISTS', { expectExit: 3 });
    assert.match(r.terminal, /boot preflight EXISTS_IDENTITY_UNPROVEN/);
    assert.deepEqual(fx.calls('exec'), []);
    fx.assertNoDestructiveEffect('wizard EXISTS');
  });

  await t.test('--dry-run probes nothing and never claims FRESH', () => {
    for (const session of [SESSION_ABSENT, { code: '200', body: JSON.stringify({ id: 'orchestrator' }) }]) {
      const fx = fixture();
      fx.daemon({ session });
      fx.psTable(['7777 1 node /usr/local/bin/telepty allow --id orchestrator --auto-restart claude']);
      const r = spawnSync('/bin/bash', [SHIM, '--dry-run'], {
        cwd: fx.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...fx.env, ORCHESTRATOR_SID: 'orchestrator', ...CLAUDE_PLAN },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes('[would-exec] allow-create-v1'), r.stdout);
      assert.match(r.stdout, /not probed/);
      assert.match(r.stdout, /only on a FRESH verdict/);
      assert.ok(!/boot preflight (FRESH|EXISTS)/.test(r.stdout + r.stderr), 'a dry run reported a verdict it never probed');
      assert.ok(!/would (SIGKILL|DELETE)/.test(r.stdout + r.stderr), 'a dry run still describes a removed effect');
      fx.assertInert('dry-run', { reads: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TASK 1293 — the boot door's half of the exit-code contract for an ordinary missing telepty
// (review F5/F6). init only warns and exits 0 (tests/packaging/telepty-runtime-requirement.test.ts),
// dispatch refuses a command it cannot START at registration with 78 TELEPTY_CLI_UNAVAILABLE
// (tests/dispatch/telepty-cli-unavailable.test.ts), and boot refuses with exit 3, printing the
// install line only for a confirmed CLI refusal. A daemon-only refusal names the daemon instead and
// does not tell the operator to reinstall the CLI that just passed (r1 did: this case FAILS on r1).
test('task 1293: a missing telepty is boot exit 3 with the install line; a daemon-only refusal names the daemon instead', async t => {
  const INSTALL = 'npm i -g @dmsdc-ai/aigentry-telepty@latest';

  await t.test('no telepty on PATH: exit 3, UNSUPPORTED, the install command named once, no daemon request', () => {
    const fx = fixture();
    fs.rmSync(path.join(fx.bin, 'telepty'));
    const r = planBoot(fx);
    assertPreflightRefused(fx, r, 'UNSUPPORTED', 'missing telepty');
    assert.match(r.stderr, /no 'telepty' on PATH \(bash exit 127/, r.stderr);
    assert.equal(r.stderr.split(INSTALL).length - 1, 1, `the install command must be named once:\n${r.stderr}`);
    assert.deepEqual(fx.calls('curl'), [], 'a daemon request followed a missing CLI');
  });

  await t.test('a daemon without register-create-only: exit 3, the daemon line, and no CLI reinstall', () => {
    const fx = fixture();
    fx.daemon({ meta: { code: '200', body: '{"capabilities":["sessions","wrapped-sessions"]}' } });
    const r = planBoot(fx);
    assertPreflightRefused(fx, r, 'UNSUPPORTED', 'daemon-only');
    assert.deepEqual(fx.calls('caps'), [['boot-capabilities']]);
    assert.match(r.stderr, /it is the DAEMON on this port that is older than this orchestrator needs/, r.stderr);
    assert.ok(!r.stderr.includes(INSTALL), `a CLI that passed its check was told to reinstall:\n${r.stderr}`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SHIPPING METADATA (bt1181jm-v4). SOURCE-LEVEL ONLY — read this boundary first.
//
// These cases read the package's OWN declarations out of the repo: `package.json`
// `files[]`, `bin/init/manifest.mjs` and `scripts/run-tests.mjs`. That is all they do.
//
// ⚠️ WHAT THEY DO NOT ESTABLISH, and must never be read as establishing:
//   * that `npm pack` actually puts the file in a tarball (no pack was run);
//   * that `bin/init/cli.mjs init` actually materialises it into a workspace, or
//     actually preserves an edited copy (no init was run — that is an installation
//     lifecycle step and is out of bounds here);
//   * that `npm test` / `scripts/run-tests.mjs` actually executes this suite (the full
//     package runner was NOT run from this partial fixture — it needs a compiled
//     `dist/tests` tree that is not staged).
//
// A declaration is a necessary condition, not the gate. The gates that remain owed are
// listed in the report. What these cases DO catch is the failure mode that costs a
// release: shipping a doc the usage text cites, or a suite the wizard depends on, that
// nothing declares — which is silent until someone installs.
test('shipping metadata declares the boot doc and the wizard suite', async t => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const manifestPath = path.join(REPO, 'bin/init/manifest.mjs');
  const runnerPath = path.join(REPO, 'scripts/run-tests.mjs');
  for (const p of [manifestPath, runnerPath]) {
    assert.ok(fs.existsSync(p), `GAP: ${path.relative(REPO, p)} is not staged; this group cannot measure what it claims to.`);
  }
  const manifest = await import(pathToFileURL(manifestPath).href);
  const DOC = 'docs/setup/orchestrator-boot.md';

  await t.test(`the tarball declares ${DOC}`, () => {
    // usage.ts and the init guidance both cite this path. If npm does not ship it, the
    // citation resolves to nothing on an installed host.
    assert.ok(pkg.files.includes(DOC), `package.json files[] does not declare ${DOC}: ${JSON.stringify(pkg.files)}`);
    // Not covered by a broader entry either — `docs/setup/` as a whole is NOT declared,
    // so the leaf is load-bearing rather than incidental.
    assert.ok(!pkg.files.includes('docs/setup/') && !pkg.files.includes('docs/'),
      'docs/setup/ is declared wholesale; the exact-leaf reasoning below no longer holds');
  });

  // Task 1270 (CI 43736341103): init now places TWO docs/setup leaves — this boot doc and docs/setup/worker-reports.md
  // (#1170, the confined report pump). Both are required documents; the subtest pins that EXACT set rather than the
  // obsolete "exactly one leaf" or a loose inclusion. Nothing in the manifest is changed to fit a test.
  const INIT_SETUP_DOCS = [DOC, 'docs/setup/worker-reports.md'];
  await t.test(`init's MANIFEST declares EXACTLY the two init-placed docs/setup leaves (${INIT_SETUP_DOCS.join(', ')})`, () => {
    const under = manifest.MANIFEST.filter(p => p.startsWith('docs/setup/'));
    assert.deepEqual([...under].sort(), [...INIT_SETUP_DOCS].sort(),
      `init must place exactly these docs/setup leaves, got: ${JSON.stringify(under)}`);
    assert.equal(under.length, 2, `exactly two docs/setup leaves, got: ${JSON.stringify(under)}`);
    // …and each governance root is the LEAF, not the directory. This is the composition
    // that matters: `bin/init/manifest.mjs` asserts "every tarball path under a
    // GOVERNANCE_ROOT must appear in MANIFEST". Declaring `docs/setup/` as a root would
    // drag in the other docs/setup files package.json ships and turn a passing
    // packaging guard red for an unrelated reason.
    for (const leaf of INIT_SETUP_DOCS) {
      assert.ok(manifest.GOVERNANCE_ROOTS.includes(leaf),
        `${leaf} is init-placed but is not a governance root — it could ship without init placing it`);
    }
    assert.ok(!manifest.GOVERNANCE_ROOTS.includes('docs/setup/'),
      'docs/setup/ is a governance root; the other docs/setup files package.json ships would then require MANIFEST entries');
    // The composition, stated as the arithmetic it is: the tarball ships other
    // docs/setup files, and none of them is under a governance root.
    const otherSetupShipped = pkg.files.filter(f => f.startsWith('docs/setup/') && !INIT_SETUP_DOCS.includes(f));
    assert.ok(otherSetupShipped.length > 0, 'fixture assumption changed: no other docs/setup file is shipped');
    for (const f of otherSetupShipped) {
      assert.ok(!manifest.GOVERNANCE_ROOTS.some(r => f === r || (r.endsWith('/') && f.startsWith(r))),
        `${f} is shipped and falls under a governance root but is not in MANIFEST`);
      assert.ok(!manifest.MANIFEST.includes(f), `${f} unexpectedly became an init-placed file`);
    }
  });

  await t.test('the boot doc goes through the no-overwrite copy path, unchanged', () => {
    // NOT a run of init. Two structural facts, which together are what "an operator's
    // edited copy survives" rests on:
    //   1. the doc is an ordinary MANIFEST entry, so `copyManifest` handles it;
    //   2. it is NOT in the native-capture set, which has its own sole writer and
    //      bypasses that loop.
    assert.ok(manifest.MANIFEST.includes(DOC));
    const cli = fs.readFileSync(path.join(REPO, 'bin/init/cli.mjs'), 'utf8');
    assert.ok(!/NATIVE_FILES\s*=\s*\[[^\]]*orchestrator-boot\.md/s.test(cli),
      'the boot doc was moved into the native-capture set, which bypasses copyManifest');
    // The preserve-when-exists branch itself, verbatim. If a future edit removes it, an
    // operator's edited doc starts being overwritten on a plain `init`.
    assert.match(cli, /if \(existed && !opts\.upgrade && !opts\.force\) \{\s*\n\s*summary\.preserved\.push\(rel\);\s*\n\s*continue;/,
      "copyManifest's no-overwrite branch is gone or reshaped — an existing file may now be overwritten by a plain init");
    // …and that `--force`/`--upgrade` remain the only two ways past it.
    assert.match(cli, /--force\s+overwrite an already-initialised workspace/,
      'the --force contract text changed');
  });

  await t.test('run-tests.mjs includes this wizard suite in its POSIX branch', () => {
    // The runner compiles TypeScript tests into dist/tests and enumerates them; a
    // hand-written .mjs suite is invisible to that walk and must be listed explicitly.
    // Until #1181 this file was not listed anywhere, so `npm test` never ran it.
    const runner = fs.readFileSync(runnerPath, 'utf8');
    const rel = 'tests/packaging/orchestrator-boot-wizard.test.mjs';
    assert.ok(runner.includes(rel), `${rel} is not named in scripts/run-tests.mjs`);
    // It must be inside the POSIX guard, not the unconditional list: the suite drives a
    // POSIX pty and would fail on Windows for a reason that is not a product defect.
    const guard = /if \(process\.platform === 'darwin' \|\| process\.platform === 'linux'\) \{([\s\S]*?)\n\}/.exec(runner);
    assert.ok(guard, 'the POSIX platform guard is gone from scripts/run-tests.mjs');
    assert.ok(guard[1].includes(rel),
      `${rel} is named in the runner but NOT inside the POSIX branch — it would run on Windows, where the pty harness cannot work`);
    // And it must NOT also be in the unconditional list, which would defeat the guard.
    const before = runner.slice(0, guard.index);
    assert.ok(!before.includes(rel),
      `${rel} is ALSO in the unconditional list; the POSIX guard would not protect it`);
    // The suite it names is the one that exists, at the path the runner will resolve.
    assert.ok(fs.existsSync(path.join(REPO, rel)),
      `the runner names ${rel} but no such file exists — the inclusion is a dangling reference`);
    assert.equal(path.resolve(REPO, rel), fileURLToPath(import.meta.url),
      'the runner names a different file than the one making this assertion');
  });
});
