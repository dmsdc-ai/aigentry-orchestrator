// #1167 PLAN-ENTRY §4.3 — checks the tree `aigentry-orchestrator init` produced. Not a *.test.mjs:
// tests/packaging/init-platform.test.mjs runs it against this checkout, the windows-installed (W0) job runs
// it against a tarball install, and smoke-init.sh may reuse it. Node built-ins only; read-only.
//
//   node tests/packaging/installed-init-check.mjs --package <package root> --workspace <ws> --home <aigentry home>
//
// --package    the package init ran from (its bin/init/manifest.mjs defines what init copies)
// --workspace  the control workspace init created
// --home       the aigentry home init scaffolded: the directory that holds CONSTITUTION.md, i.e. $AIGENTRY_HOME
//              or <user home>/.aigentry when AIGENTRY_HOME is unset
// Exit 0 when every check holds; otherwise every failure is listed on stderr and the exit is 1 (2 = usage).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const USAGE = 'usage: installed-init-check.mjs --package <package root> --workspace <workspace> --home <aigentry home>';
const opts = {};
const argv = process.argv.slice(2);
while (argv.length) {
  const flag = argv.shift(), value = argv.shift();
  const key = { '--package': 'package', '--workspace': 'workspace', '--home': 'home' }[flag];
  if (!key || !value || opts[key]) { console.error(USAGE); process.exit(2); }
  opts[key] = path.resolve(value);
}
if (!opts.package || !opts.workspace || !opts.home) { console.error(USAGE); process.exit(2); }

// The nine roles bin/install-instructions.sh installs (its ROLES array).
const ROLES = ['orchestrator', 'architect', 'coder', 'tester', 'builder', 'analyst', 'researcher', 'reviewer', 'logger'];
const LOCK = '.aigentry-native-capture.lock';
const {
  MANIFEST, TEMPLATE_TOKENS, isSubstitutionExempt, STATE_DIRS, AIGENTRY_DIRS,
} = await import(pathToFileURL(path.join(opts.package, 'bin', 'init', 'manifest.mjs')).href);

const failures = [];
let checks = 0;
const check = (ok, what) => { checks += 1; if (!ok) failures.push(what); return ok; };
const bytes = (file) => { try { return fs.readFileSync(file); } catch { return null; } };
const isDir = (dir) => { try { return fs.lstatSync(dir).isDirectory(); } catch { return false; } };
const tokensIn = (text) => TEMPLATE_TOKENS.filter((t) => text.includes(t));
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return null; } };
const sha = (b) => createHash('sha256').update(b).digest();
const pkgJson = JSON.parse(fs.readFileSync(path.join(opts.package, 'package.json'), 'utf8'));
const ws = (rel) => path.join(opts.workspace, rel);

// Workspace: every MANIFEST path, byte-equal to the package unless init substituted tokens in it.
for (const rel of MANIFEST) {
  const source = bytes(path.join(opts.package, rel));
  const copy = bytes(ws(rel));
  if (!check(source !== null, `package is missing ${rel}`) || !check(copy !== null, `workspace is missing ${rel}`)) continue;
  if (isSubstitutionExempt(rel) || tokensIn(source.toString('utf8')).length === 0) {
    check(copy.equals(source), `workspace ${rel} differs from the package copy`);
  } else {
    const left = tokensIn(copy.toString('utf8'));
    check(left.length === 0, `workspace ${rel} still holds ${left.join(', ')}`);
  }
}
for (const dir of STATE_DIRS) check(isDir(ws(path.join('state', dir))), `workspace state/${dir} is not a directory`);
let queue = null;
try { queue = JSON.parse(fs.readFileSync(ws('state/task-queue.json'), 'utf8')); } catch { /* reported below */ }
check(isDeepStrictEqual(queue, { tasks: [], active_focus: null }), 'state/task-queue.json is not {"tasks":[],"active_focus":null}');
const guide = bytes(ws('GETTING-STARTED.md'))?.toString('utf8') ?? '';
check(guide.startsWith('Control workspace ready: ') && guide.includes('orchestrator-boot.sh'),
  'GETTING-STARTED.md is missing or does not name bin/orchestrator-boot.sh');
if (process.platform === 'win32') {
  check(guide.includes('from Git Bash') && guide.includes('SANDBOX_PLATFORM_UNSUPPORTED'),
    'GETTING-STARTED.md lacks the win32 Git Bash step or the confined-spawn limitation');
}
let stamp = null;
try { stamp = JSON.parse(fs.readFileSync(ws('.aigentry-init.json'), 'utf8')); } catch { /* reported below */ }
if (check(stamp !== null, '.aigentry-init.json is missing or not JSON')) {
  check(stamp.version === pkgJson.version, `.aigentry-init.json version ${stamp.version} != package ${pkgJson.version}`);
  const digest = createHash('sha256');
  for (const rel of MANIFEST) digest.update(rel).update('\0').update(sha(bytes(path.join(opts.package, rel)) ?? Buffer.alloc(0)));
  check(stamp.manifestDigest === digest.digest('hex'), '.aigentry-init.json manifestDigest does not match the package MANIFEST');
  check(typeof stamp.workspace === 'string' && real(stamp.workspace) !== null && real(stamp.workspace) === real(opts.workspace),
    `.aigentry-init.json workspace ${stamp.workspace} is not ${opts.workspace}`);
  check(stamp.nativeCapture === undefined, '.aigentry-init.json records native capture');
}
const skill = bytes(ws('.claude/skills/orchestrate-turn/SKILL.md'));
check(skill !== null && skill.equals(bytes(path.join(opts.package, '.agents/skills/orchestrate-turn/SKILL.md')) ?? Buffer.alloc(0)),
  '.claude/skills/orchestrate-turn/SKILL.md is missing or differs from the package copy');
check(!fs.existsSync(ws(LOCK)), `${LOCK} was left in the workspace`);

// Aigentry home.
const home = (rel) => path.join(opts.home, rel);
const constitution = bytes(home('CONSTITUTION.md'));
check(constitution !== null && constitution.equals(bytes(path.join(opts.package, 'tooling/instructions/CONSTITUTION.md')) ?? Buffer.alloc(0)),
  'home CONSTITUTION.md is missing or differs from the package copy');
const configText = bytes(home('config.json'))?.toString('utf8') ?? null;
let config = null;
try { config = JSON.parse(configText); } catch { /* reported below */ }
if (check(config !== null && typeof config === 'object', 'home config.json is missing or not JSON')) {
  check(config.roles && typeof config.roles === 'object' && config.defaults && typeof config.defaults === 'object',
    'home config.json lacks roles or defaults');
  check(tokensIn(configText).length === 0, `home config.json still holds ${tokensIn(configText).join(', ')}`);
}
for (const rel of ['instructions/common.md', ...ROLES.map((role) => `instructions/roles/${role}.md`)]) {
  const text = bytes(home(rel))?.toString('utf8');
  if (check(text !== undefined, `home ${rel} is missing`)) check(tokensIn(text).length === 0, `home ${rel} still holds ${tokensIn(text).join(', ')}`);
}
for (const dir of AIGENTRY_DIRS) check(isDir(home(dir)), `home ${dir} is not a directory`);

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`installed-init-check: ${failures.length} of ${checks} check(s) failed`);
  process.exit(1);
}
console.log(`installed-init-check: OK (${checks} checks)`);
