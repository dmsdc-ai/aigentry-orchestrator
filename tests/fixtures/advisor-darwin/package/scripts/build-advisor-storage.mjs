#!/usr/bin/env node
/**
 * Explicit, opt-in builder for the package-owned storage-provenance helpers.
 *
 * Run it deliberately:
 *
 *   npm run build:advisor-storage
 *
 * It is NOT wired to `postinstall`, `prepare` or `prepack`. Installing this
 * package never invokes a compiler, never contacts the network and never
 * downloads a prebuilt binary. A package without these helpers is fully
 * functional: the adapter reports `unknown` and production writes refuse, which
 * is the correct answer when provenance has not been measured.
 *
 * The compiler is invoked through `spawnSync` with an argument array and
 * `shell: false`. No command string is ever concatenated, so a path containing a
 * space, a quote or a shell metacharacter is an ordinary argument rather than an
 * injection site.
 *
 * Output names are fixed and must match what `src/task-advisor/storage-provenance.ts`
 * resolves relative to the package root:
 *
 *   native/task-advisor-storage/bin/advisor-storage-provenance-<platform>-<arch>[.exe]
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, 'native', 'task-advisor-storage');
const binDir = path.join(sourceDir, 'bin');

/** Exit codes: 0 built, 1 build failed, 2 nothing to build on this platform. */
const EXIT_OK = 0, EXIT_FAILED = 1, EXIT_NOT_APPLICABLE = 2;

function run(command, args) {
  process.stdout.write(`+ ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) {
    process.stderr.write(`advisor-storage: cannot execute ${command}: ${result.error.message}\n`);
    return false;
  }
  if (result.signal !== null) {
    process.stderr.write(`advisor-storage: ${command} terminated by ${result.signal}\n`);
    return false;
  }
  return result.status === 0;
}

function buildDarwin(arch) {
  const output = path.join(binDir, `advisor-storage-provenance-darwin-${arch}`);
  const ok = run('cc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
    '-framework', 'CoreFoundation', '-framework', 'DiskArbitration',
    '-o', output, path.join(sourceDir, 'darwin.c'),
  ]);
  return ok ? output : null;
}

function buildWindows(arch) {
  const output = path.join(binDir, `advisor-storage-provenance-win32-${arch}.exe`);
  // MSVC from an initialised Developer Command Prompt. `/WX` keeps the helper
  // warning-clean; `wmainCRTStartup` selects the wide entry point it defines.
  const ok = run('cl', [
    '/nologo', '/W4', '/WX', '/O2', '/MT',
    path.join(sourceDir, 'windows.c'),
    `/Fe:${output}`,
    `/Fo:${path.join(binDir, 'windows.obj')}`,
    '/link', '/ENTRY:wmainCRTStartup', 'kernel32.lib',
  ]);
  return ok ? output : null;
}

const platform = process.platform;
const arch = process.arch;

if (platform === 'linux') {
  process.stdout.write(
    'advisor-storage: Linux needs no native helper; the adapter reads /proc/self/mountinfo\n'
    + 'advisor-storage: and the selected /sys attributes directly. Nothing to build.\n');
  process.exit(EXIT_NOT_APPLICABLE);
}
if (platform !== 'darwin' && platform !== 'win32') {
  process.stderr.write(`advisor-storage: no helper is defined for ${platform}; provenance stays unknown.\n`);
  process.exit(EXIT_NOT_APPLICABLE);
}

fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });

const built = platform === 'darwin' ? buildDarwin(arch) : buildWindows(arch);
if (built === null) {
  process.stderr.write(
    'advisor-storage: build FAILED. No helper was installed.\n'
    + 'advisor-storage: the adapter will report `unknown` and production writes will refuse.\n');
  process.exit(EXIT_FAILED);
}

// Refuse to report success for something that is not actually an executable file.
const stat = fs.statSync(built);
if (!stat.isFile() || stat.size === 0) {
  process.stderr.write(`advisor-storage: ${built} is not a usable executable.\n`);
  process.exit(EXIT_FAILED);
}

process.stdout.write(
  `advisor-storage: built ${path.relative(root, built)} (${stat.size} bytes)\n`
  + 'advisor-storage: this builds the MEASUREMENT path only. It qualifies nothing:\n'
  + 'advisor-storage: the qualification catalog stays empty until a controller reviews\n'
  + 'advisor-storage: exact B1 evidence, so production writes still refuse.\n');
process.exit(EXIT_OK);
