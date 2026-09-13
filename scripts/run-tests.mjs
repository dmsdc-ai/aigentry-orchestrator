import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStaleCompiled } from './stale-dist-guard.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = join(repoRoot, 'dist', 'tests');

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

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
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
