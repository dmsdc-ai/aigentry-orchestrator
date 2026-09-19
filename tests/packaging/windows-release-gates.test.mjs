// Local gate-control acceptance only. Runner copies execute test-owned sentinels;
// application Node/npm entrypoints are never executed.
// Node 20; Ruby/Psych, Bash and cat/grep/tail/awk on PATH. No configuration required.
// Optional absolute overrides: WINDOWS_GATE_RUBY, WINDOWS_GATE_BASH,
// WINDOWS_GATE_UTILS (cat/grep/tail/awk directory), WINDOWS_GATE_EVIDENCE.
// See fixtures/windows-gates/README.md for prerequisites, evidence and provenance.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

assert.equal(process.versions.node.split('.')[0], '20', 'acceptance requires Node 20');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function configured(name, env = process.env) {
  const value = env[name];
  if (value === undefined) return undefined;
  assert.ok(value && isAbsolute(value) && !/[\r\n]/.test(value), `${name}: absolute path required when set`);
  return value;
}
function resolveTool(name, override, env = process.env) {
  const explicit = configured(override, env);
  const candidates = explicit ? [override === 'WINDOWS_GATE_UTILS' ? join(explicit, name) : explicit]
    : (env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => resolve(directory, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Try the next PATH entry; explicit overrides never fall back. */ }
  }
  throw new Error(`Missing prerequisite ${name}: install it on PATH or set ${override} to an executable absolute ${override === 'WINDOWS_GATE_UTILS' ? 'directory' : 'path'}${explicit ? ` (unusable override: ${explicit})` : ''}`);
}
const ruby = resolveTool('ruby', 'WINDOWS_GATE_RUBY');
const bash = resolveTool('bash', 'WINDOWS_GATE_BASH');
const utilityNames = ['cat', 'grep', 'tail', 'awk'];
const utilities = Object.fromEntries(utilityNames.map(name => [name, resolveTool(name, 'WINDOWS_GATE_UTILS')]));
const admin = mkdtempSync(join(tmpdir(), 'windows-release-gates-'));
chmodSync(admin, 0o700);
const evidence = configured('WINDOWS_GATE_EVIDENCE') ?? join(admin, 'evidence');
mkdirSync(evidence, { recursive: true, mode: 0o700 });
console.log(`Windows gate evidence: ${evidence}`);
const timeout = 5000;
const manifest = [];
const invocations = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureRoot = 'tests/packaging/fixtures/windows-gates';
const frozen = {
  [`${fixtureRoot}/ci.before-parity.yml`]: '10849b92e1421996998aedabacc84c191449deaa8baa632fb0da8a4b85ecddd1',
  [`${fixtureRoot}/release.before.yml`]: 'da142d4151f621b6b497c1a7d1814bb77e9eba2e6991f5f71df6b69405fa3011',
  [`${fixtureRoot}/rejected-release.yml`]: '8b4ad689397f4d0e2776794ed49f401e1f95216ddcea8bf9fd54bc9f6ff04933',
};
function snapshot() {
  const result = {};
  function visit(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result[child] = sha(readFileSync(join(root, child)));
    }
  }
  for (const path of ['src', 'bin', 'scripts', '.github', 'tests/session/persistence']) visit(path);
  for (const path of ['package.json', 'package-lock.json', 'tests/packaging/windows-release-gates.test.mjs', ...Object.keys(frozen)]) {
    result[path] = sha(readFileSync(join(root, path)));
  }
  return result;
}
const before = snapshot();
writeFileSync(join(evidence, 'source-before.json'), JSON.stringify(before, null, 2));
for (const [path, hash] of Object.entries(frozen)) assert.equal(before[path], hash, `frozen source: ${path}`);

// Psych safe_load provides structured parsing; YAML 1.1 turns the key "on"
// into boolean true, which JSON encodes as "true". Normalize that key only.
const parser = 'require "yaml"; require "json"; d = YAML.safe_load(File.read(ARGV.fetch(0)), permitted_classes: [], permitted_symbols: [], aliases: false); d["on"] = d.delete(true) if d.key?(true); puts JSON.generate(d)';
function parse(path) {
  // Use standard-library Psych without RubyGems startup hooks or PATH helpers.
  const argv = ['--disable-gems', '-e', parser, join(root, path)];
  const result = spawnSync(ruby, argv, { encoding: 'utf8', timeout, env: { PATH: '' } });
  invocations.push({ kind: 'yaml-parser', executable: ruby, argv, timeout, exit: result.status, stderr: result.stderr });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Ruby/Psych prerequisite or YAML parsing failure: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const original = parse(`${fixtureRoot}/release.before.yml`);
const final = parse('.github/workflows/release.yml');
const ci = parse('.github/workflows/ci.yml');
const ciBefore = parse(`${fixtureRoot}/ci.before-parity.yml`);
const rejected = parse(`${fixtureRoot}/rejected-release.yml`);
const ids = ['windows-persistence', 'windows-refuses'];
const runSteps = job => job.steps.filter(step => typeof step.run === 'string');
function named(job, name) {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, `unique parsed step: ${name}`);
  return matches[0];
}
const commands = {
  persistence: named(final.jobs[ids[0]], 'Persistence suite must be fully green on win32').run,
  declaration: named(final.jobs[ids[1]], 'package.json must declare Windows out').run,
  init: named(final.jobs[ids[1]], 'bin/init/cli.mjs platform gate must exit 2 on win32').run,
  npm: named(final.jobs[ids[1]], 'U23 — npm ci must refuse on win32 with EBADPLATFORM').run,
  ciPersistence: named(ci.jobs[ids[0]], 'Persistence suite must be fully green on win32').run,
};
// Only the parsed Bash function may differ from the rejected/archived CI block.
// Literal boundaries avoid treating surrounding execution/threshold checks as reader code.
function readerParts(command) {
  const startMarker = 'read_count() {';
  const endMarker = 'PASS="$(read_count pass)"';
  const start = command.indexOf(startMarker);
  const end = command.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'reader boundaries exist');
  assert.equal(command.indexOf(startMarker, start + 1), -1, 'one reader definition');
  assert.equal(command.indexOf(endMarker, end + 1), -1, 'one summary assignment');
  return { prefix: command.slice(0, start), reader: command.slice(start, end), suffix: command.slice(end) };
}
const fixedReader = readerParts(commands.persistence).reader;
const rejectedPersistence = named(rejected.jobs[ids[0]], 'Persistence suite must be fully green on win32').run;
writeFileSync(join(evidence, 'parsed-commands.json'), JSON.stringify(commands, null, 2));
for (const [key, command] of Object.entries(commands)) {
  const path = join(admin, `${key}.bash`);
  writeFileSync(path, command);
  const result = spawnSync(bash, ['--noprofile', '--norc', '-n', path], { encoding: 'utf8', timeout });
  invocations.push({ kind: 'bash-syntax', executable: bash, argv: ['--noprofile', '--norc', '-n', path], timeout, exit: result.status });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

function validate(workflow) {
  const top = structuredClone(workflow);
  delete top.jobs;
  const oldTop = structuredClone(original);
  delete oldTop.jobs;
  assert.deepEqual(top, oldTop, 'unchanged trigger, permissions and concurrency');
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...Object.keys(original.jobs), ...ids].sort());
  for (const id of ['guard', 'test', 'windows-declared-unsupported']) {
    assert.deepEqual(workflow.jobs[id], original.jobs[id], `unchanged ${id}`);
  }
  const guardSteps = workflow.jobs.guard.steps;
  const admission = guardSteps.indexOf(named(workflow.jobs.guard, 'Release planning and changed-file admission'));
  const token = guardSteps.indexOf(named(workflow.jobs.guard, 'NPM_TOKEN must be present'));
  assert.ok(admission >= 0 && admission < token, 'admission precedes token');
  const publish = structuredClone(workflow.jobs.publish);
  assert.deepEqual(publish.needs, [...original.jobs.publish.needs, ...ids], 'all publish dependencies');
  publish.needs = original.jobs.publish.needs;
  assert.deepEqual(publish, original.jobs.publish, 'unchanged publish steps, secrets and permissions');
  for (const [index, id] of ids.entries()) {
    const job = workflow.jobs[id];
    assert.equal(job['runs-on'], 'windows-latest');
    assert.equal(job.needs, 'guard');
    assert.equal(job['timeout-minutes'], [20, 10][index]);
    assert.equal(job.steps[0].uses, 'actions/checkout@v4');
    assert.equal(job.steps[1].uses, 'actions/setup-node@v4');
    assert.equal(job.steps[1].with['node-version'], '20');
    assert.equal(job.steps.length, 5);
    const expected = runSteps(ci.jobs[id]).slice(0, 3);
    const actualCommands = runSteps(job).map(s => s.run);
    if (id === 'windows-persistence') {
      const current = readerParts(actualCommands[2]);
      const previous = readerParts(rejectedPersistence);
      assert.equal(current.reader, fixedReader, 'only the frozen corrected reader is authorized');
      assert.equal(current.prefix, previous.prefix, 'W1 pre-reader bytes unchanged');
      assert.equal(current.suffix, previous.suffix, 'W1 post-reader bytes unchanged');
      assert.equal(rejectedPersistence, runSteps(ciBefore.jobs[id])[2].run, 'rejected W1 remains exact archived CI source');
    }
    assert.deepEqual(actualCommands, expected.map(s => s.run), `${id}: exact full CI command parity`);
    for (const item of [job, ...job.steps]) {
      for (const key of ['continue-on-error', 'if', 'strategy', 'env']) {
        assert.ok(!(key in item), `${id}: no ${key} override/bypass`);
      }
    }
    for (const step of runSteps(job)) assert.equal(step.shell, 'bash');
  }
  const forced = ids.flatMap(id => runSteps(workflow.jobs[id]).filter(s => /--force\b/.test(s.run)).map(s => [id, s.run]));
  assert.deepEqual(forced, [['windows-persistence', 'npm ci --force']]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).os, ['darwin', 'linux']);
}

function acceptance(name, category, run) {
  const item = { name, category, status: 'pending' };
  manifest.push(item);
  test(name, { timeout: 15000 }, () => {
    try { run(); item.status = 'pass'; }
    catch (error) { item.status = 'fail'; item.error = error.message; throw error; }
  });
}
acceptance('baseline has zero actual Windows gates and omits both publish dependencies', 'baseline', () => {
  assert.equal(Object.values(original.jobs).filter(j => j['runs-on'] === 'windows-latest').length, 0);
  for (const id of ids) {
    assert.ok(!(id in original.jobs));
    assert.ok(!original.jobs.publish.needs.includes(id));
  }
  assert.throws(() => validate(original));
});
acceptance('frozen final workflow preserves old behavior and requires W0 plus W1', 'structure', () => validate(final));
acceptance('corrected reader is the only parsed workflow change from rejected source', 'reader-structure', () => {
  const copy = structuredClone(final);
  named(copy.jobs[ids[0]], 'Persistence suite must be fully green on win32').run = rejectedPersistence;
  assert.deepEqual(copy, rejected);
});
acceptance('CI W1 matches release and every other CI byte remains unchanged', 'ci-parity', () => {
  assert.equal(commands.ciPersistence, commands.persistence);
  assert.equal(sha(commands.ciPersistence), '50b8b702d34566ab8ef1b3ec310770ee5c32af62950d8d7ddb0996e234df6850');
  const copy = structuredClone(ci);
  named(copy.jobs[ids[0]], 'Persistence suite must be fully green on win32').run = rejectedPersistence;
  assert.deepEqual(copy, ciBefore);
  const indentReader = reader => reader.split('\n').map(line => line ? '          ' + line : '').join('\n');
  const fixedBytes = indentReader(fixedReader);
  const oldBytes = indentReader(readerParts(rejectedPersistence).reader);
  const currentBytes = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.equal(currentBytes.split(fixedBytes).length, 2, 'exactly one corrected reader in CI YAML');
  assert.equal(currentBytes.replace(fixedBytes, oldBytes), readFileSync(join(root, fixtureRoot, 'ci.before-parity.yml'), 'utf8'), 'inverse reader replacement preserves every other CI byte, including full-suite debt');
});

const mutants = [];
for (const id of ids) {
  mutants.push([`remove ${id}`, w => { delete w.jobs[id]; }]);
  mutants.push([`remove publish dependency ${id}`, w => { w.jobs.publish.needs = w.jobs.publish.needs.filter(n => n !== id); }]);
  for (const [label, change] of [
    ['wrong runner', j => { j['runs-on'] = 'ubuntu-latest'; }],
    ['missing guard dependency', j => { delete j.needs; }],
    ['missing timeout', j => { delete j['timeout-minutes']; }],
    ['Node 22', j => { j.steps[1].with['node-version'] = '22'; }],
    ['continue-on-error job', j => { j['continue-on-error'] = true; }],
    ['always job', j => { j.if = '${{ always() }}'; }],
    ['skip job', j => { j.if = 'false'; }],
    ['continue-on-error step', j => { j.steps[4]['continue-on-error'] = true; }],
    ['always step', j => { j.steps[4].if = '${{ always() }}'; }],
    ['missing Bash', j => { delete j.steps[4].shell; }],
    ['no-op command', j => { j.steps[4].run = 'echo green'; }],
  ]) mutants.push([`${id}: ${label}`, w => change(w.jobs[id])]);
}
mutants.push(['publish always bypass', w => { w.jobs.publish.if = '${{ always() }}'; }]);
mutants.push(['publish continue-on-error', w => { w.jobs.publish['continue-on-error'] = true; }]);
mutants.push(['W0 forced npm', w => { w.jobs[ids[1]].steps[4].run = 'npm ci --force'; }]);
mutants.push(['changed trigger', w => { w.on.workflow_dispatch = null; }]);
mutants.push(['changed permissions', w => { w.permissions.contents = 'write'; }]);
mutants.push(['admission after token', w => { w.jobs.guard.steps.reverse(); }]);
mutants.push(['W1 changed pass floor outside reader', w => { w.jobs[ids[0]].steps[4].run = commands.persistence.replace('-gt 20', '-gt 0'); }]);
mutants.push(['W1 changed selected test glob outside reader', w => { w.jobs[ids[0]].steps[4].run = commands.persistence.replace('persistence/*.test.js', '*.test.js'); }]);
mutants.push(['W1 reverted legacy reader', w => { w.jobs[ids[0]].steps[4].run = rejectedPersistence; }]);
for (const [name, mutate] of mutants) acceptance(`mutant rejected: ${name}`, 'mutant', () => {
  const copy = structuredClone(final);
  mutate(copy);
  assert.throws(() => validate(copy));
});

const persistenceFiles = readdirSync(join(root, 'tests/session/persistence')).filter(n => n.endsWith('.test.ts')).sort();
assert.ok(persistenceFiles.length > 0);
const persistenceArgv = ['--test', ...persistenceFiles.map(n => `dist/tests/session/persistence/${n.replace(/\.ts$/, '.js')}`)];
const argvByCommand = {
  persistence: persistenceArgv,
  ciPersistence: persistenceArgv,
  declaration: ['-p', "JSON.stringify(require('./package.json').os)"],
  init: ['bin/init/cli.mjs', 'init'],
  npm: ['ci'],
};
function execute(key, fixture, label) {
  const directory = mkdtempSync(join(admin, `${key}-`));
  const bin = join(directory, 'mock-bin');
  mkdirSync(bin);
  for (const utility of utilityNames) symlinkSync(utilities[utility], join(bin, utility));
  const script = `#!${bash}\nprintf '%s\\0' "$0" "$@" >> "$FIXTURE_RECORD"\nwhile IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$FIXTURE_OUTPUT"\nexit "$FIXTURE_EXIT"\n`;
  for (const executable of ['node', 'npm']) {
    const path = join(bin, executable);
    writeFileSync(path, script, { mode: 0o700 });
  }
  // The expanded files are also test-owned scripts; no compiled/product file is run.
  for (const file of persistenceArgv.slice(1)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, script, { mode: 0o700 });
  }
  const output = join(directory, 'fixture.out');
  const record = join(directory, 'argv.nul');
  writeFileSync(output, fixture.output);
  const argv = ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', commands[key]];
  const result = spawnSync(bash, argv, {
    cwd: directory, encoding: 'utf8', timeout,
    env: { PATH: bin, RUNNER_TEMP: directory, TMPDIR: directory, LC_ALL: 'C',
      FIXTURE_OUTPUT: output, FIXTURE_RECORD: record, FIXTURE_EXIT: String(fixture.exit) },
  });
  const invocation = { kind: key, label, directory, executable: bash, argv,
    timeout, fixture, exit: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  invocations.push(invocation);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const recorded = readFileSync(record, 'utf8').split('\0');
  assert.equal(recorded.pop(), '');
  invocation.mockArgv = recorded;
  assert.deepEqual(recorded, [join(bin, key === 'npm' ? 'npm' : 'node'), ...argvByCommand[key]], 'one exact test-owned command invocation');
  return result.status;
}
const tap = (pass = 21, fail = 0, skip = 0) => `TAP version 13\n1..${Number(pass) + Number(fail) + Number(skip)}\n# tests ${Number(pass) + Number(fail) + Number(skip)}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skip}\n`;
const cases = [];
const add = (key, name, output, exit, accept = false) => cases.push({ key, name, output, exit, accept });
add('persistence', 'minimum non-vacuous success 21', tap(), 0, true);
add('persistence', 'larger success 42', tap(42), 0, true);
for (const pass of [0, 1, 20, -1]) add('persistence', `reject ${pass} passes`, tap(pass), 0);
add('persistence', 'reject one failed test', tap(21, 1), 0);
add('persistence', 'reject one skipped test', tap(21, 0, 1), 0);
for (const exit of [1, 2, 127]) add('persistence', `reject good counts with runner exit ${exit}`, tap(), exit);
add('persistence', 'reject empty output', '', 0);
for (const field of ['pass', 'fail', 'skipped']) {
  add('persistence', `reject missing ${field}`, tap().split('\n').filter(l => !l.startsWith(`# ${field} `)).join('\n'), 0);
  add('persistence', `reject nonnumeric ${field}`, tap().replace(new RegExp(`# ${field} \\d+`), `# ${field} nope`), 0);
  add('persistence', `reject empty ${field}`, tap().replace(new RegExp(`# ${field} \\d+`), `# ${field} `), 0);
  add('persistence', `reject trailing garbage in ${field}`, tap().replace(new RegExp(`(# ${field} \\d+)`), '$1 garbage'), 0);
}
add('persistence', 'reject decimal passes', tap('21.5'), 0);
add('persistence', 'reject contradictory duplicate fail summary', tap(21, 1) + '# fail 0\n', 0);
add('persistence', 'reject contradictory duplicate skip summary', tap(21, 0, 1) + '# skipped 0\n', 0);
add('declaration', 'accept declared unsupported OS list', '["darwin","linux"]\n', 0, true);
for (const output of ['["darwin","linux","win32"]', '["linux","darwin"]', '[]', '', 'null']) {
  add('declaration', `reject wrong declaration ${JSON.stringify(output)}`, output, 0);
}
add('declaration', 'reject correct declaration with command failure', '["darwin","linux"]\n', 1);
const refusal = 'aigentry-orchestrator does not support Windows natively. Run init inside WSL2.\n';
add('init', 'accept documented refusal exit 2', refusal, 2, true);
for (const exit of [0, 1, 3, 127]) add('init', `reject refusal with exit ${exit}`, refusal, exit);
for (const [name, output] of [
  ['empty message', ''], ['generic error', 'fatal error'],
  ['missing WSL2', 'does not support Windows natively'], ['missing native refusal', 'use WSL2'],
]) add('init', `reject ${name}`, output, 2);
add('npm', 'accept EBADPLATFORM exit 1', 'npm error code EBADPLATFORM\n', 1, true);
add('npm', 'accept EBADPLATFORM exit 2', 'npm error code EBADPLATFORM\n', 2, true);
add('npm', 'reject success despite EBADPLATFORM text', 'npm error code EBADPLATFORM\n', 0);
add('npm', 'reject empty successful install', '', 0);
for (const [name, output] of [['network', 'npm error code ENETUNREACH'], ['auth', 'npm error code E401'], ['generic', 'npm error failure'], ['empty failure', '']]) {
  add('npm', `reject ${name} without EBADPLATFORM`, output, 1);
}
// Retest additions leave every original fixture and its expectation unchanged.
add('persistence', 'accept CRLF summary', tap().replaceAll('\n', '\r\n'), 0, true);
add('persistence', 'accept mixed LF and CRLF summary', tap().replace('# fail 0\n', '# fail 0\r\n'), 0, true);
for (const field of ['pass', 'fail', 'skipped']) {
  const value = field === 'pass' ? '21' : '0';
  const record = `# ${field} ${value}`;
  add('persistence', `reject identical duplicate ${field}`, tap() + record + '\n', 0);
  add('persistence', `reject malformed ${field} before valid`, `# ${field} nope\n` + tap(), 0);
  add('persistence', `reject malformed ${field} after valid`, tap() + `# ${field} nope\n`, 0);
  for (const [label, replacement] of [
    ['negative value', `# ${field} -1`],
    ['explicit plus sign', `# ${field} +${value}`],
    ['decimal value', `# ${field} ${value}.0`],
    ['trailing whitespace', record + ' '],
    ['tab separator', `# ${field}\t${value}`],
    ['double-space separator', `# ${field}  ${value}`],
    ['bare key', `# ${field}`],
    ['double terminal CR', record + '\r\r'],
  ]) add('persistence', `reject ${label} for ${field}`, tap().replace(record, replacement), 0);
  for (const [label, replacement] of [
    ['quoted record', `"${record}"`],
    ['prose record', `diagnostic: ${record}`],
    ['indented record', `  ${record}`],
    ['neighbor key', `# ${field}_other ${value}`],
  ]) add('persistence', `reject missing ${field} despite ${label}`, tap().replace(record, replacement), 0);
  const noise = [`"# ${field} 999"`, `diagnostic: # ${field} 999`, `  # ${field} 999`, `# ${field}_other 999`].join('\n') + '\n';
  add('persistence', `accept ${field} with unrelated quoted prose indented and neighbor-key noise`, noise + tap() + noise, 0, true);
}
for (const item of cases) acceptance(`${item.key}: ${item.name}`, 'runtime', () => {
  const exit = execute(item.key, item, item.name);
  assert.equal(exit === 0, item.accept, `${item.key}: fixture must ${item.accept ? 'accept' : 'reject'}; actual exit ${exit}`);
});
const ciReplayFixtures = [
  'minimum non-vacuous success 21',
  'reject trailing garbage in pass',
  'reject trailing garbage in fail',
  'reject trailing garbage in skipped',
  'reject contradictory duplicate fail summary',
  'reject contradictory duplicate skip summary',
].map(name => {
  const fixture = cases.find(item => item.key === 'persistence' && item.name === name);
  assert.ok(fixture, `existing exact CI replay fixture: ${name}`);
  return fixture;
});
for (const fixture of ciReplayFixtures) acceptance(`CI W1 replay: ${fixture.name}`, 'ci-runtime', () => {
  const exit = execute('ciPersistence', fixture, fixture.name);
  assert.equal(exit === 0, fixture.accept, `CI W1 must ${fixture.accept ? 'accept' : 'reject'}; actual exit ${exit}`);
});
for (const [key, fixture] of [
  ['declaration', { output: '["win32"]', exit: 0 }],
  ['init', { output: 'generic error', exit: 2 }],
  ['npm', { output: 'npm error E401', exit: 1 }],
]) acceptance(`W0 dependent group refuses after failed ${key}`, 'dependent-group', () => {
  const executed = [];
  for (const command of ['declaration', 'init', 'npm']) {
    const input = command === key ? fixture : cases.find(c => c.key === command && c.accept);
    executed.push(command);
    if (execute(command, input, `dependent-group-${key}`) !== 0) break;
  }
  assert.deepEqual(executed, ['declaration', 'init', 'npm'].slice(0, ['declaration', 'init', 'npm'].indexOf(key) + 1));
});

// Portable prerequisite regressions use only private test-owned paths.
const portableBin = join(admin, 'portable tools with spaces');
mkdirSync(portableBin);
const requiredTools = { ruby, bash, ...utilities };
for (const [name, executable] of Object.entries(requiredTools)) symlinkSync(executable, join(portableBin, name));
const overrideFor = name => name === 'ruby' ? 'WINDOWS_GATE_RUBY' : name === 'bash' ? 'WINDOWS_GATE_BASH' : 'WINDOWS_GATE_UTILS';
for (const name of Object.keys(requiredTools)) {
  acceptance(`portable PATH resolves ${name} through a directory containing spaces`, 'portable-path', () => {
    assert.equal(resolveTool(name, overrideFor(name), { PATH: portableBin }), requiredTools[name]);
  });
  acceptance(`portable explicit override resolves ${name} without PATH`, 'portable-path', () => {
    const override = overrideFor(name);
    assert.equal(resolveTool(name, override, { PATH: '', [override]: override === 'WINDOWS_GATE_UTILS' ? portableBin : join(portableBin, name) }), requiredTools[name]);
  });
  acceptance(`portable missing ${name} refuses without skipping`, 'portable-path', () => {
    assert.throws(() => resolveTool(name, overrideFor(name), { PATH: admin }), new RegExp(`Missing prerequisite ${name}`));
  });
}
acceptance('portable unusable explicit override refuses instead of falling back to PATH', 'portable-path', () => {
  for (const name of Object.keys(requiredTools)) {
    assert.throws(() => resolveTool(name, overrideFor(name), { PATH: portableBin, [overrideFor(name)]: join(admin, 'absent') }), /unusable override/);
  }
});
acceptance('portable malformed explicit paths refuse clearly', 'portable-path', () => {
  for (const value of ['', 'relative', `${admin}\ninvalid`]) {
    assert.throws(() => configured('WINDOWS_GATE_EVIDENCE', { WINDOWS_GATE_EVIDENCE: value }), /absolute path required/);
  }
});
acceptance('portable directories and nonexecutable files cannot satisfy prerequisites', 'portable-path', () => {
  const directory = join(admin, 'not-an-executable');
  mkdirSync(directory);
  const file = join(admin, 'not-executable.bash');
  writeFileSync(file, 'exit 0\n', { mode: 0o600 });
  for (const candidate of [directory, file]) {
    assert.throws(() => resolveTool('bash', 'WINDOWS_GATE_BASH', { WINDOWS_GATE_BASH: candidate }), /Missing prerequisite bash/);
  }
});
acceptance('portable default evidence stays inside the private OS temporary directory', 'portable-path', () => {
  assert.equal(dirname(admin), tmpdir());
  assert.equal(statSync(admin).mode & 0o777, 0o700);
  if (process.env.WINDOWS_GATE_EVIDENCE === undefined) {
    assert.equal(evidence, join(admin, 'evidence'));
    assert.equal(statSync(evidence).mode & 0o777, 0o700);
  }
});

// Actual runner discovery/chaining regressions. Every copied runner sees only
// synthetic compiled files and sentinels at the explicit security and harness paths.
const callerSource = readFileSync(join(root, 'scripts/run-tests.mjs'), 'utf8');
const staleGuardSource = readFileSync(join(root, 'scripts/stale-dist-guard.mjs'), 'utf8');
const harnessRelative = 'tests/packaging/windows-release-gates.test.mjs';
const securityRelative = 'tests/hitl/snyk-boundaries.test.mjs';
function callerFixture(mode, symlinked = false) {
  const directory = mkdtempSync(join(admin, 'caller fixture '));
  const put = (path, source) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), source);
  };
  put('package.json', '{"type":"module"}\n');
  put('scripts/run-tests.mjs', callerSource);
  put('scripts/stale-dist-guard.mjs', staleGuardSource);
  assert.equal(sha(readFileSync(join(directory, 'scripts/run-tests.mjs'))), sha(callerSource));
  const checks = `import assert from 'node:assert/strict';\nassert.equal(process.cwd(), process.env.CALLER_EXPECTED_CWD);\nassert.equal(process.execPath, process.env.CALLER_EXPECTED_NODE);\nassert.equal(process.env.CALLER_ENV, 'inherited');\n`;
  const compiled = checks + `console.log('CALLER_COMPILED_CONTROL');\nprocess.exit(${mode === 'compiled-fail' ? 7 : 0});\n`;
  if (mode !== 'missing-dist') mkdirSync(join(directory, 'dist/tests'), { recursive: true });
  if (!['missing-dist', 'empty'].includes(mode)) {
    put('dist/tests/control.test.js', compiled);
    if (mode !== 'stale-test') put('tests/control.test.ts', compiled);
  }
  if (mode === 'stale-helper') put('dist/tests/orphan.js', '// synthetic stale helper\n');
  if (mode !== 'missing-security') put(securityRelative, checks + `assert.equal(new URL(import.meta.url).pathname.endsWith('/${securityRelative}'), true);\nconsole.log('CALLER_SECURITY_SENTINEL');\nprocess.exit(${mode === 'failing-security' ? 8 : 0});\n`);
  if (mode !== 'missing-harness') put(harnessRelative, checks + `console.log('CALLER_SOURCE_SENTINEL');\nprocess.exit(${mode === 'sentinel-fail' ? 9 : 0});\n`);
  put('tests/packaging/unselected.test.mjs', "console.log('CALLER_UNSELECTED_MJS'); process.exit(99);\n");
  if (symlinked) {
    const alias = `${directory} symlink`;
    symlinkSync(realpathSync(directory), alias);
    assert.notEqual(alias, realpathSync(alias), 'regression must exercise a distinct symlink spelling');
    return alias;
  }
  return directory;
}
for (const symlinked of [false, true]) {
for (const [mode, expected, compiled, security, sentinel, diagnostic] of [
  ['pass', 0, true, true, true],
  ['sentinel-fail', 1, true, true, true, /POSIX control harness failed with exit status: 1/],
  ['compiled-fail', 1, true, true, false],
  ['missing-security', 1, false, false, false, /tests[\\/]hitl[\\/]snyk-boundaries\.test\.mjs/],
  ['failing-security', 1, true, true, false],
  ['missing-harness', 1, true, true, false, /POSIX control harness failed with exit status: 1/],
  ['empty', 1, false, false, false, /No compiled test files found/],
  ['missing-dist', 1, false, false, false, /Failed to enumerate compiled tests/],
  ['stale-test', 1, false, false, false, /stale compiled test: dist\/tests\/control.test.js/],
  ['stale-helper', 1, false, false, false, /stale compiled helper: dist\/tests\/orphan.js/],
]) acceptance(`caller actual subprocess: ${mode}${symlinked ? ' through symlink' : ''}`, 'caller-actual', () => {
  const directory = callerFixture(mode, symlinked);
  const argv = ['scripts/run-tests.mjs'];
  const env = { PATH: '', TMPDIR: directory, CALLER_ENV: 'inherited',
    // Node resolves the runner's ESM root and cwd through symlinked temporary paths.
    CALLER_EXPECTED_CWD: realpathSync(directory), CALLER_EXPECTED_NODE: process.execPath };
  const result = spawnSync(process.execPath, argv, { cwd: directory, env, encoding: 'utf8', timeout });
  invocations.push({ kind: 'caller-actual', label: mode, symlinked, executable: process.execPath, argv,
    cwd: directory, env, timeout, exit: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout, stderr: result.stderr, runnerSha256: sha(callerSource) });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected);
  assert.equal(result.stdout.includes('CALLER_COMPILED_CONTROL'), compiled);
  assert.equal(result.stdout.includes('CALLER_SECURITY_SENTINEL'), security);
  assert.equal(result.stdout.includes('CALLER_SOURCE_SENTINEL'), sentinel);
  assert.ok(!result.stdout.includes('CALLER_UNSELECTED_MJS'), 'no automatic source .mjs discovery');
  if (compiled && sentinel) assert.ok(result.stdout.indexOf('CALLER_COMPILED_CONTROL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (security && sentinel) assert.ok(result.stdout.indexOf('CALLER_SECURITY_SENTINEL') < result.stdout.indexOf('CALLER_SOURCE_SENTINEL'));
  if (diagnostic) assert.match(result.stderr, diagnostic);
});
}

// The test-only subprocess links exact, unmodified runner ESM to builtin mocks.
// No source rewriting and no claim that a mocked platform ran natively.
async function callerVMDriver() {
  const assert = (await import('node:assert/strict')).default;
  const { readFileSync } = await import('node:fs');
  const { createContext, SourceTextModule, SyntheticModule } = await import('node:vm');
  const paths = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const result of config.results) {
    assert.ok(result.status === null || Number.isInteger(result.status));
    assert.ok(result.signal === null || typeof result.signal === 'string');
    assert.ok(!(result.signal && result.status !== null), 'impossible mock: numeric exit status with terminating signal');
    assert.ok(!(result.error && result.status !== null), 'impossible mock: startup/timeout error with numeric exit status');
    assert.ok(result.status !== null || result.signal || result.error, 'mock null status needs signal or error');
  }
  const path = config.platform === 'win32' ? paths.win32 : paths.posix;
  const root = config.platform === 'win32' ? 'C:\\test-owned\\caller' : '/test-owned/caller';
  const runnerPath = path.join(root, 'scripts', 'run-tests.mjs');
  const calls = [], logs = [], errors = [];
  const exit = {};
  let status;
  const context = createContext({ process: { execPath: process.execPath, platform: config.platform,
    env: { CALLER_ENV: 'inherited' }, exit(code) { status = code; throw exit; } },
    console: { log(...args) { logs.push(args.join(' ')); }, error(...args) { errors.push(args.join(' ')); } } });
  const entry = (name, directory = false) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const modules = {
    'node:child_process': { spawnSync(executable, argv, options) {
      calls.push({ executable, argv: Array.from(argv), options: { ...options } });
      assert.ok(calls.length <= config.results.length, 'unexpected subprocess');
      const result = config.results[calls.length - 1];
      return { ...result, error: result.error ? Object.assign(new Error(result.error), { code: result.code }) : undefined };
    } },
    'node:fs': { readdirSync(directory, options) {
      assert.equal(options.withFileTypes, true);
      if (config.discovery === 'missing') throw new Error('synthetic ENOENT');
      if (config.discovery === 'empty') return [];
      if (directory === path.join(root, 'dist', 'tests')) return [entry('z.test.js'), entry('nested', true), entry('unselected.test.mjs'), entry('a.test.js')];
      assert.equal(directory, path.join(root, 'dist', 'tests', 'nested'));
      return [entry('b.test.js')];
    } },
    'node:path': Object.fromEntries(['dirname', 'join', 'relative', 'resolve', 'sep'].map(key => [key, path[key]])),
    'node:url': { fileURLToPath: () => runnerPath },
    './stale-dist-guard.mjs': { findStaleCompiled(directory) { assert.equal(directory, root); return config.stale ?? []; } },
  };
  const module = new SourceTextModule(config.source, { context, identifier: pathToFileURL(runnerPath).href,
    initializeImportMeta(meta) { meta.url = pathToFileURL(runnerPath).href; } });
  await module.link(specifier => {
    assert.ok(Object.hasOwn(modules, specifier), `unexpected import ${specifier}`);
    const exports = modules[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  try { await module.evaluate({ timeout: 1000 }); } catch (error) { if (error !== exit) throw error; }
  assert.notEqual(status, undefined, 'runner must exit');
  process.stdout.write(JSON.stringify({ status, calls, logs, errors, root, executable: process.execPath }));
}
const driver = join(admin, 'caller-vm-driver.mjs');
writeFileSync(driver, `(${callerVMDriver.toString()})().catch(error => { console.error(error); process.exit(1); });\n`);
const success = { status: 0, signal: null };
const failed = { status: 7, signal: null };
const signaled = { status: null, signal: 'SIGTERM' };
const startupError = { status: null, signal: null, error: 'synthetic ENOENT', code: 'ENOENT' };
const timedOut = { status: null, signal: 'SIGKILL', error: 'synthetic ETIMEDOUT', code: 'ETIMEDOUT' };
const vmCases = [];
for (const platform of ['linux', 'darwin']) {
  vmCases.push({ name: `${platform} compiled-success then exact harness invocation`, platform, results: [success, success], status: 0, calls: 2 });
  for (const [name, result, diagnostic] of [
    ['nonzero', failed, /exit status: 7/], ['startup error', startupError, /POSIX control harness failed: synthetic ENOENT/],
    ['signal', signaled, /terminated by signal: SIGTERM/], ['timeout', timedOut, /POSIX control harness failed: synthetic ETIMEDOUT/],
  ]) vmCases.push({ name: `${platform} harness ${name} refuses`, platform, results: [success, result], status: result.status ?? 1, calls: 2, diagnostic });
}
for (const platform of ['linux', 'darwin', 'win32']) {
  for (const [name, result, status] of [['nonzero', failed, 7], ['startup error', startupError, 1], ['signal', signaled, 1]]) {
    vmCases.push({ name: `${platform} compiled ${name} prevents harness`, platform, results: [result], status, calls: 1 });
  }
}
vmCases.push({ name: 'win32 success preserves compiled result and prints non-TAP notice', platform: 'win32', results: [success], status: 0, calls: 1 });
vmCases.push({ name: 'unknown host refuses after compiled success', platform: 'freebsd', results: [success], status: 1, calls: 1, diagnostic: /unavailable on unsupported platform: freebsd/ });
for (const [discovery, diagnostic] of [['empty', /No compiled test files found/], ['missing', /Failed to enumerate compiled tests/]]) {
  vmCases.push({ name: `${discovery} discovery refuses without spawning`, platform: 'linux', discovery, results: [], status: 1, calls: 0, diagnostic });
}
vmCases.push({ name: 'stale compiled refuses without spawning', platform: 'linux', stale: ['stale compiled test: synthetic'], results: [], status: 1, calls: 0, diagnostic: /Nothing was run/ });
vmCases.push({ name: 'impossible numeric-status-plus-signal mock is rejected before runner execution', platform: 'linux', results: [{ status: 0, signal: 'SIGTERM' }], invalid: /impossible mock: numeric exit status with terminating signal/ });
for (const item of vmCases) acceptance(`caller VM: ${item.name}`, 'caller-vm', () => {
  const config = join(admin, `caller-vm-${vmCases.indexOf(item)}.json`);
  writeFileSync(config, JSON.stringify({ ...item, source: callerSource }));
  const argv = ['--experimental-vm-modules', driver, config];
  const result = spawnSync(process.execPath, argv, { env: { PATH: '', TMPDIR: admin }, encoding: 'utf8', timeout });
  const invocation = { kind: 'caller-vm', label: item.name, executable: process.execPath, argv, timeout,
    exit: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr,
    runnerSha256: sha(callerSource), scenario: { ...item, diagnostic: item.diagnostic?.source, invalid: item.invalid?.source } };
  invocations.push(invocation);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, item.invalid ? 1 : 0);
  if (item.invalid) { assert.match(result.stderr, item.invalid); return; }
  const actual = JSON.parse(result.stdout);
  invocation.observed = actual;
  assert.equal(actual.status, item.status);
  assert.equal(actual.calls.length, item.calls);
  if (item.calls > 0) assert.deepEqual(actual.calls[0], { executable: process.execPath,
    argv: ['--test', 'dist/tests/a.test.js', 'dist/tests/nested/b.test.js', 'dist/tests/z.test.js', securityRelative],
    options: { cwd: actual.root, stdio: 'inherit' } });
  if (item.calls === 2) assert.deepEqual(actual.calls[1], { executable: process.execPath,
    argv: ['--test', harnessRelative], options: { cwd: actual.root, stdio: 'inherit', timeout: 180000, killSignal: 'SIGKILL' } });
  if (item.platform === 'win32') {
    assert.deepEqual(actual.logs, ['POSIX control harness is not run on win32; native Windows W1/W0 jobs remain separate.']);
    assert.ok(actual.logs.every(line => !/^(#|ok\b|not ok\b|TAP\b|1\.\.)/.test(line)), 'notice must not impersonate TAP results');
  } else assert.deepEqual(actual.logs, []);
  if (item.diagnostic) assert.match(actual.errors.join('\n'), item.diagnostic);
});

after(() => {
  const afterHashes = snapshot();
  const counts = { tests: manifest.length, pass: manifest.filter(c => c.status === 'pass').length,
    fail: manifest.filter(c => c.status === 'fail').length, skip: 0 };
  writeFileSync(join(evidence, 'source-after.json'), JSON.stringify(afterHashes, null, 2));
  writeFileSync(join(evidence, 'case-manifest.json'), JSON.stringify({
    node: process.version, executable: process.execPath, admin, evidence, frozen,
    tools: { ruby, bash, utilities },
    harnessSha256: sha(readFileSync(fileURLToPath(import.meta.url))), persistenceFiles,
    callerRunnerSha256: sha(callerSource), callerStaleGuardSha256: sha(staleGuardSource),
    counts, cases: manifest, fixtures: cases, ciReplayFixtures, invocations,
    limits: ['Local fake-command control flow only; no actual Windows, GHA schema/scheduling or side-effect absence proof.',
      'Regular-CI Windows full-suite debt is excluded; native OS declaration remains unsupported.',
      'YAML fixtures are not product security clearance. Exact-source Snyk remains blocked by known tls652; no retry/upload.'],
  }, null, 2));
  assert.deepEqual(afterHashes, before, 'all hashed product, baseline and CI sources unchanged');
});
