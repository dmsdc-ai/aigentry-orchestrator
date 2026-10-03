import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStaleCompiled } from './stale-dist-guard.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = join(repoRoot, 'dist', 'tests');
const sourceTestFiles = ['tests/hitl/snyk-boundaries.test.mjs', 'tests/packaging/release-admission.test.mjs'];
// #1179 — JEV suites import the real tsc output under dist/src/jev (no fixture fallback) and
// are platform-neutral, so they run on every OS, win32 included. tc-support.mjs is a helper.
sourceTestFiles.push(
  'tests/jev/pipeline-integration.test.mjs',
  'tests/jev/price-table.test.mjs',
  'tests/jev/r2-acceptance-delta.test.mjs',
  'tests/jev/r2-before-after.test.mjs',
  'tests/jev/refusal-path-constant.test.mjs',
  'tests/jev/request-contract.test.mjs',
  'tests/jev/reserve.test.mjs',
  'tests/jev/response-contract.test.mjs',
  'tests/jev/worker-target.test.mjs',
);
// #1185 — task-advisor efficiency core suites import the real tsc output under dist/src/task-advisor
// (no fixture fallback) and are platform-neutral, so they run on every OS, win32 included.
// helpers.mjs, purity-child.mjs and cap-fixture-measure.mjs are helpers.
sourceTestFiles.push(
  'tests/task-advisor/efficiency/t1-schema.test.mjs',
  'tests/task-advisor/efficiency/t10-r3-state-latency.test.mjs',
  'tests/task-advisor/efficiency/t11-r4-numeric.test.mjs',
  'tests/task-advisor/efficiency/t12-checkpoint-decoder.test.mjs',
  'tests/task-advisor/efficiency/t2-decoder.test.mjs',
  'tests/task-advisor/efficiency/t3-dedup-gap-time.test.mjs',
  'tests/task-advisor/efficiency/t4-grants-binding.test.mjs',
  'tests/task-advisor/efficiency/t5-detectors.test.mjs',
  'tests/task-advisor/efficiency/t6-suppression-outcome.test.mjs',
  'tests/task-advisor/efficiency/t7-bounds.test.mjs',
  'tests/task-advisor/efficiency/t8-r2-focused.test.mjs',
  'tests/task-advisor/efficiency/t9-suspicions.test.mjs',
);
// #1182 — control pure-core suite imports the real tsc output under dist/src/control (no fixture fallback); platform-neutral.
sourceTestFiles.push('tests/control/core.test.mjs');
// #1167 — fake-cmux win32 helper inert regression: transpiles the helper source into a vm with fully faked
// fs/os/child_process/process (no compiler, native or real file IO), so it runs on every OS, win32 included.
sourceTestFiles.push('tests/dispatch/fake-cmux-win32.inert.test.mjs');
// Native capture fixtures require POSIX ownership/modes and the boot wizard suite drives an
// owned POSIX PTY; Windows support is still absent for both.
if (process.platform === 'darwin' || process.platform === 'linux') {
  sourceTestFiles.push('tests/packaging/native-capture.test.mjs', 'tests/packaging/orchestrator-boot-wizard.test.mjs');
  // #1177 the XRes owner supervisor fixtures signal owned POSIX children and observe them via flock.
  sourceTestFiles.push('tests/packaging/xres-owner-supervisor.test.mjs');
  // #1162 agent-metadata chain (G2b binder/reader, G2c wh-cli transport, G3 reconciler push)
  // runs the real bin/ + dist/ against fake cmux/seam recorders; needs POSIX modes, FIFOs and
  // bash. support/ holds helpers and fakes.
  sourceTestFiles.push(
    'tests/dispatch/agent-metadata/g2b-binding.test.mjs',
    'tests/dispatch/agent-metadata/g2c-caps-schema-unknown-pill.test.mjs',
    'tests/dispatch/agent-metadata/g2c-host-contract.test.mjs',
    'tests/dispatch/agent-metadata/g2c-pinned-clear.test.mjs',
    'tests/dispatch/agent-metadata/g2c-transport.test.mjs',
    'tests/dispatch/agent-metadata/g3-legacy-allowlist.test.mjs',
    'tests/dispatch/agent-metadata/g3-reconciler-matrix.test.mjs',
    'tests/dispatch/agent-metadata/g3-stage-workspace-denial.test.mjs',
    'tests/dispatch/agent-metadata/g3-stale-fallback.test.mjs',
  );
}

function collectTestFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(path);
    }
  }

  return files;
}

let testFiles;

try {
  testFiles = collectTestFiles(testsRoot)
    .sort()
    .map((path) => relative(repoRoot, path).split(sep).join('/'));
} catch (error) {
  console.error(`Failed to enumerate compiled tests under ${testsRoot}: ${error.message}`);
  process.exit(1);
}

// #1070 — tsc never removes stale output. A compiled test whose source was deleted keeps
// running and counting; refuse by name and leave the deleting to a human.
const stale = findStaleCompiled(repoRoot);

if (stale.length > 0) {
  for (const line of stale) console.error(line);
  console.error(
    `${stale.length} stale compiled file(s) under dist/tests — tsc never removes output whose source was deleted. ` +
      'Remove them with `rm -rf dist` (or `npm run clean`), then re-run `npm test`. Nothing was run.',
  );
  process.exit(1);
}

if (testFiles.length === 0) {
  console.error('No compiled test files found under dist/tests. Run `tsc -p .` first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles, ...sourceTestFiles], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (process.platform === 'win32') {
  console.log('POSIX control harness is not run on win32; native Windows W1/W0 jobs remain separate.');
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (process.platform === 'win32' || result.status !== 0 || result.signal) {
  process.exit(result.status ?? 1);
}

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error(`POSIX control harness coverage is unavailable on unsupported platform: ${process.platform}`);
  process.exit(1);
}

const harnessResult = spawnSync(process.execPath, ['--test', 'tests/packaging/windows-release-gates.test.mjs'], {
  cwd: repoRoot,
  stdio: 'inherit',
  timeout: 180000,
  killSignal: 'SIGKILL',
});

if (harnessResult.error) {
  console.error(`POSIX control harness failed: ${harnessResult.error.message}`);
  process.exit(1);
}

if (harnessResult.signal) {
  console.error(`POSIX control harness terminated by signal: ${harnessResult.signal}`);
  process.exit(1);
}

if (harnessResult.status !== 0) {
  console.error(`POSIX control harness failed with exit status: ${harnessResult.status ?? 'unknown'}`);
}

process.exit(harnessResult.status ?? 1);
