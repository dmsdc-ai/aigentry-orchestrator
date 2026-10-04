// #1167 — verdict for `node --test --test-reporter=tap win-launch.test.js` on Windows CI. Test harness only.
// usage: node win-launch-tap-check.mjs <candidate|baseline> <tap-file> <raw-node-test-exit> <out.json>
//   candidate: raw exit 0, exactly EXPECTED_TOTAL top-level tests, every test ok, the ONLY skips are the
//              4 "T10 [POSIX]" tests. So an all-skipped run (oracle missing, wrong OS) can never be green.
//   baseline : negative control on ebfc459 (no win-launch). Raw exit must be non-zero and every top-level
//              outcome must match BASELINE exactly; any drift means the control did not discriminate.
// The raw node --test exit is always reported unchanged in the JSON and on stdout.
import fs from 'node:fs';

const [mode, tapFile, rawExitArg, outFile] = process.argv.slice(2);
const EXPECTED_TOTAL = 31;
const BASELINE = [
  [/^O[1-5] /, 'pass'], [/^T-miss /, 'pass'], [/^evidence root /, 'pass'],
  [/^T10 \[POSIX\] /, 'skip'], [/^P[1-4] /, 'skip'],
  [/^T1\+T2 \[win32\] /, 'fail'], [/^T2 \[win32\] native /, 'fail'], [/^T[4-9] \[win32\] /, 'fail'], [/^T-gem \[win32\] /, 'fail'],
];
const rawExit = Number(rawExitArg);
const tests = [];
for (const line of fs.readFileSync(tapFile, 'utf8').split(/\r?\n/)) {
  const m = /^(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/.exec(line); // top level only (subtests are indented)
  if (m) tests.push({ name: m[2], outcome: m[1] === 'not ok' ? 'fail' : m[3] ? 'skip' : 'pass' });
}
const problems = [];
if (tests.length !== EXPECTED_TOTAL) problems.push(`top-level total ${tests.length} != ${EXPECTED_TOTAL}`);
if (mode === 'candidate') {
  if (rawExit !== 0) problems.push(`node --test exit ${rawExit}`);
  for (const t of tests) {
    const want = /^T10 \[POSIX\] /.test(t.name) ? 'skip' : 'pass';
    if (t.outcome !== want) problems.push(`${t.name}: ${t.outcome} (want ${want})`);
  }
} else if (mode === 'baseline') {
  if (rawExit === 0) problems.push('node --test exit 0 on baseline (control did not fail)');
  for (const t of tests) {
    const rule = BASELINE.find(([re]) => re.test(t.name));
    if (!rule) problems.push(`${t.name}: no baseline expectation`);
    else if (t.outcome !== rule[1]) problems.push(`${t.name}: ${t.outcome} (control expects ${rule[1]})`);
  }
} else problems.push(`unknown mode ${mode}`);
const verdict = problems.length === 0 ? (mode === 'baseline' ? 'negative_control_discriminates' : 'candidate_tests_green_pending_review') : 'mismatch';
const out = { mode, rawNodeTestExit: rawExit, total: tests.length,
  counts: Object.fromEntries(['pass', 'fail', 'skip'].map(k => [k, tests.filter(t => t.outcome === k).length])), verdict, problems, tests };
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ mode, rawNodeTestExit: rawExit, total: out.total, counts: out.counts, verdict, problems }));
process.exitCode = problems.length === 0 ? 0 : 1;
