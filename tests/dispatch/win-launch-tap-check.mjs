// #1167 — verdict for `node --test --test-reporter=tap win-launch.test.js` on Windows CI. Test harness only.
// usage: node win-launch-tap-check.mjs <candidate|baseline> <tap-file> <raw-node-test-exit> <out.json>
//   candidate: raw exit literal "0", exactly EXPECTED_TOTAL top-level tests, every test ok, the ONLY skips are the
//              4 "T10 [POSIX]" tests. So an all-skipped run (oracle missing, wrong OS) can never be green.
//   baseline : negative control on ebfc459 (no win-launch). Raw exit must be the literal "1" (node --test assertion
//              failure; a crash/signal such as 3 or 137 is not the predicted control) and every top-level
//              outcome must match BASELINE exactly; any drift means the control did not discriminate.
// The raw node --test exit argument is always reported unchanged in the JSON and on stdout (rawNodeTestExitArg).
// Both modes: the top-level tests must be exactly INTENDED (the 31 top-level names of the pinned win-launch.test.ts,
// template expanded, declaration order), numbered 1..31, no TODO, no "Bail out!", one "1..31" plan after the last
// top-level result, then the node 20 summary footer whose counts reconcile with ALL test points (node counts nested
// subtests too). Subset TAP reader for node 20 --test-reporter=tap output only: shapes it does not know are rejected.
import fs from 'node:fs';

if (process.argv.length !== 6) {
  console.error('usage: node win-launch-tap-check.mjs <candidate|baseline> <tap-file> <raw-node-test-exit> <out.json>');
  process.exit(2);
}
const [mode, tapFile, rawExitArg, outFile] = process.argv.slice(2);
const EXPECTED_TOTAL = 31;
// Top-level test() names of tests/session/boot-adapter/win-launch.test.ts (sha256 c859cb04…), in declaration order.
const INTENDED = [
  'O1 generator identity: pinned cmd-shim 6.0.3 located and hash-verified',
  'O2 contract §2 transcription == generator bytes for V-A (A empty / A set) and V-B',
  'O3 V-V (env -S K=V) generator bytes differ from V-A and carry @SET',
  'O4 generator emits non-inert fields unrefused (recognition must enforce inertness)',
  'O5 negative mutation set: every mutation changes the bytes and all are distinct',
  'T10 [POSIX] run(): one spawn, argv0/args/cwd/env as given, shell false, literals byte-exact',
  'T10 [POSIX] probeVersion(): one spawn [exe, --version]; missing exe → CLI_NOT_FOUND',
  'T10 [POSIX] run() missing bare exe keeps the real ENOENT',
  'T10 [POSIX] geminiBinary(): PATH X_OK agy → agy, else gemini (unchanged)',
  ...['local', 'prefix'].flatMap(where => ['bare', 'abs'].flatMap(spelling => ['PATH', 'Path'].map(key =>
    `T1+T2 [win32] V-A ${where}/${spelling}/${key}: direct node, literals byte-exact, no sentinel, stdin hash`))),
  'T2 [win32] native .exe hit launched as-is; V-B native target via dp0+\\+T',
  'T4 [win32] byte/line/BOM/newline/field mutations, V-V, unknown version, non-inert fields → refuse',
  'T5 [win32] earlier .bat / bad .cmd hit → refuse, never skip to the later valid shim',
  'T6 [win32] dp0\\node.exe present → that interpreter; node→node.cmd → refuse',
  'T7 [win32] shim dir containing & → refuse',
  'T8 [win32] >32767 command line → OS spawn error, no payload; 30000 control byte-exact',
  'T9 [win32] non-reading child with 8 MiB stdin → no crash, no delivery claim',
  'T-miss [win32] missing bare name keeps ENOENT (not CLI_LAUNCH_UNSUPPORTED)',
  'P1 parseCmdShim accepts oracle V-A/V-B bytes with the authored fields',
  'P2 parseCmdShim rejects mutations, V-V, unknown version, non-inert/unsupported fields',
  'P3 candidate generateCmdShim(fields) == pinned upstream generator bytes (product vs oracle)',
  'P4 resource characterization: parseCmdShim has no input size bound (record only)',
  'T-gem [win32] geminiBinary: any first agy hit (even unsupported agy.cmd) → agy; none → gemini',
  'evidence root preserved (owned, not deleted)',
];
// node 20 TAP reporter escapes "\" and "#" in names; INTENDED has no control characters (guarded below).
const tapName = s => s.replace(/\\/g, '\\\\').replace(/#/g, '\\#');
const BASELINE = [
  [/^O[1-5] /, 'pass'], [/^T-miss /, 'pass'], [/^evidence root /, 'pass'],
  [/^T10 \[POSIX\] /, 'skip'], [/^P[1-4] /, 'skip'],
  [/^T1\+T2 \[win32\] /, 'fail'], [/^T2 \[win32\] native /, 'fail'], [/^T[4-9] \[win32\] /, 'fail'], [/^T-gem \[win32\] /, 'fail'],
];
const rawExit = /^(0|[1-9][0-9]{0,2})$/.test(rawExitArg) ? Number(rawExitArg) : null; // canonical decimal only, else null
const tests = [], numbers = [], points = [], problems = [];
if (INTENDED.length !== EXPECTED_TOTAL || new Set(INTENDED).size !== EXPECTED_TOTAL || INTENDED.some(s => /[\x00-\x1f\x7f]/.test(s)))
  problems.push(`internal: INTENDED is not ${EXPECTED_TOTAL} unique printable names`);
const lines = fs.readFileSync(tapFile, 'utf8').split(/\r?\n/);
if (lines.at(-1) === '') lines.pop();
if (lines[0] !== 'TAP version 13') problems.push('line 1 is not "TAP version 13"');
lines.forEach((l, i) => { if (/^\s*Bail out!/.test(l)) problems.push(`line ${i + 1}: Bail out!`); });
let yamlEnd = null, plan = null, footerAt = -1;
for (let i = lines[0] === 'TAP version 13' ? 1 : 0; i < lines.length && footerAt < 0; i++) {
  const line = lines[i];
  if (yamlEnd !== null) { if (line === yamlEnd) yamlEnd = null; continue; } // YAML diagnostics block, not results
  const m = /^((?: {4})*)(not ok|ok) (\d+) - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line); // subtests: 4 spaces per depth
  if (m) {
    const p = { depth: m[1].length / 4, directive: m[5], ok: m[2] === 'ok' };
    if (p.directive === 'TODO') problems.push(`line ${i + 1}: TODO directive (only SKIP is valid)`);
    points.push(p);
    if (p.depth === 0) { tests.push({ name: m[4], outcome: m[2] === 'not ok' ? 'fail' : m[5] ? 'skip' : 'pass' }); numbers.push(m[3]); }
    if (lines[i + 1] === m[1] + '  ---') { yamlEnd = m[1] + '  ...'; i++; }
  } else if (/^\s*(not ok|ok)\b/.test(line)) problems.push(`line ${i + 1}: unrecognized result line`);
  else if (/^1\.\./.test(line)) { plan = line; footerAt = i + 1; } // top-level plan: node 20 prints it after the last result
}
if (yamlEnd !== null) problems.push('unterminated YAML block (truncated TAP)');
if (tests.length !== EXPECTED_TOTAL) problems.push(`top-level total ${tests.length} != ${EXPECTED_TOTAL}`);
numbers.forEach((n, k) => { if (n !== String(k + 1)) problems.push(`top-level result ${k + 1} is numbered ${n}`); });
tests.forEach((t, k) => {
  if (k >= INTENDED.length) problems.push(`extra top-level test ${k + 1}: ${t.name}`);
  else if (t.name !== tapName(INTENDED[k])) problems.push(`top-level test ${k + 1} is "${t.name}", intended "${tapName(INTENDED[k])}"`);
  if (tests.findIndex(u => u.name === t.name) !== k) problems.push(`duplicate top-level test: ${t.name}`);
});
for (const s of INTENDED) if (!tests.some(t => t.name === tapName(s))) problems.push(`intended test missing: ${tapName(s)}`);
if (plan !== `1..${EXPECTED_TOTAL}`) problems.push(`plan ${plan ?? 'missing'} != 1..${EXPECTED_TOTAL}`);
// node 20 footer: counts cover every test point at every depth; reconcile, and require 0 suites/cancelled/todo.
const want = { tests: points.length, suites: 0, pass: points.filter(p => !p.directive && p.ok).length,
  fail: points.filter(p => !p.directive && !p.ok).length, cancelled: 0, skipped: points.filter(p => p.directive === 'SKIP').length, todo: 0 };
const footer = footerAt < 0 ? [] : lines.slice(footerAt);
const FOOTER = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms'];
if (footer.length !== FOOTER.length) problems.push(`${footer.length} lines after the plan, want exactly the ${FOOTER.length}-line summary`);
FOOTER.forEach((k, j) => {
  const f = new RegExp(`^# ${k} (${k === 'duration_ms' ? '\\d+(?:\\.\\d+)?' : '\\d+'})$`).exec(footer[j] ?? '');
  if (!f) problems.push(`summary line ${j + 1} is not "# ${k} <n>"`);
  else if (k in want && Number(f[1]) !== want[k]) problems.push(`summary # ${k} ${f[1]} != ${want[k]} reconciled from all test points`);
});
if (mode === 'candidate') {
  if (rawExitArg !== '0') problems.push('node --test exit is not the literal "0" (candidate success)');
  for (const t of tests) {
    const want = /^T10 \[POSIX\] /.test(t.name) ? 'skip' : 'pass';
    if (t.outcome !== want) problems.push(`${t.name}: ${t.outcome} (want ${want})`);
  }
} else if (mode === 'baseline') {
  if (rawExitArg !== '1') problems.push('node --test exit is not the literal "1" (baseline assertion failure)');
  for (const t of tests) {
    const rule = BASELINE.find(([re]) => re.test(t.name));
    if (!rule) problems.push(`${t.name}: no baseline expectation`);
    else if (t.outcome !== rule[1]) problems.push(`${t.name}: ${t.outcome} (control expects ${rule[1]})`);
  }
} else problems.push(`unknown mode ${mode}`);
const verdict = problems.length === 0 ? (mode === 'baseline' ? 'negative_control_discriminates' : 'candidate_tests_green_pending_review') : 'mismatch';
const out = { mode, rawNodeTestExitArg: rawExitArg, rawNodeTestExit: rawExit, total: tests.length,
  counts: Object.fromEntries(['pass', 'fail', 'skip'].map(k => [k, tests.filter(t => t.outcome === k).length])), verdict, problems, tests };
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ mode, rawNodeTestExitArg: rawExitArg, rawNodeTestExit: rawExit, total: out.total, counts: out.counts, verdict, problems }));
process.exitCode = problems.length === 0 ? 0 : 1;
