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

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
