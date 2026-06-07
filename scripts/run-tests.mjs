import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
