#!/usr/bin/env node
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Explicit resource ceilings; failures never echo file contents or Git stderr.
const MAX_FILE = 16 * 1024 * 1024;
const MAX_QUEUE = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
class AdmissionError extends Error {}
function requireThat(condition, message) {
  if (!condition) throw new AdmissionError(message);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
function exact(value, keys) {
  requireThat(object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)), 'Invalid schema keys');
}
function list(value) {
  requireThat(Array.isArray(value) && value.length > 0 && value.length <= MAX_ENTRIES,
    'Invalid or oversized entry list');
  return value;
}
function safePath(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f-\x9f:]/u.test(value) && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..'),
  'Unsafe relative path');
  return value;
}
function nulList(buffer) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (!value) return [];
  requireThat(value.endsWith('\0'), 'Malformed Git path output');
  const entries = value.slice(0, -1).split('\0');
  requireThat(entries.length <= MAX_ENTRIES, 'Too many Git entries');
  return entries;
}

function main() {
  const options = new Map();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    requireThat((flag === '--root' || flag === '--version') && !options.has(flag) &&
      typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'Invalid CLI flags');
    options.set(flag, args[i + 1]);
  }
  const requestedRoot = options.get('--root') ?? fileURLToPath(new URL('../', import.meta.url));
  requireThat(path.isAbsolute(requestedRoot), 'Root must be absolute');
  // Reject symlink components even when they point back into the repository.
  let rootComponent = path.parse(requestedRoot).root;
  for (const part of requestedRoot.slice(rootComponent.length).split(path.sep).filter(Boolean)) {
    requireThat(part !== '.' && part !== '..', 'Root must be canonical');
    rootComponent = path.join(rootComponent, part);
    requireThat(lstatSync(rootComponent).isDirectory() && !lstatSync(rootComponent).isSymbolicLink(),
      'Root must be a real directory without symlinks');
  }
  const root = realpathSync(requestedRoot);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_LITERAL_PATHSPECS = '1';
  function git(...gitArgs) {
    try {
      return execFileSync('git', ['-C', root, ...gitArgs], {
        env, maxBuffer: MAX_QUEUE, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new AdmissionError('Git metadata query failed');
    }
  }
  requireThat(realpathSync(git('rev-parse', '--show-toplevel').toString().trim()) === root,
    'Root does not match Git toplevel');
  requireThat(git('diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--name-only', '-z', 'HEAD', '--').length === 0 &&
    git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--name-only', '-z', 'HEAD', '--').length === 0,
  'Tracked worktree and index must be clean');
  requireThat(nulList(git('ls-files', '-v', '-z')).every(entry => entry.startsWith('H ')),
    'Index flags prevent complete tracked-source validation');
  const tracked = new Set(nulList(git('ls-files', '-z')));
  function read(relative, limit = MAX_FILE) {
    safePath(relative);
    requireThat(tracked.has(relative), 'Read input must be Git-tracked');
    let current = root;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const stat = lstatSync(current);
      requireThat(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()),
        'Read input must be a regular file without symlinks');
      if (i === parts.length - 1) requireThat(stat.size <= limit, 'Input exceeds size limit');
    }
    const bytes = readFileSync(current);
    requireThat(bytes.length <= limit, 'Input exceeds size limit');
    // Also detect changed inputs hidden by assume-unchanged/skip-worktree flags.
    requireThat(bytes.equals(git('show', `HEAD:${relative}`)), 'Read input differs from committed bytes');
    return bytes;
  }
  function json(relative, limit) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(relative, limit))); }
    catch { throw new AdmissionError('Required JSON input missing, unsafe, uncommitted or malformed'); }
  }
  const pkg = json('package.json');
  const version = options.get('--version') ?? pkg.version;
  requireThat(typeof version === 'string' && version.length <= 128 && SEMVER.test(version),
    'Version must be plain stable X.Y.Z; prereleases are unsupported');
  requireThat(nonempty(pkg.name) && pkg.version === version, 'Package version mismatch');
  const manifestPath = `release/${version}.json`;
  const manifest = json(manifestPath);
  exact(manifest, ['schema_version', 'release_group', 'release_task', 'package', 'version', 'base_tag', 'base_commit', 'tasks']);
  requireThat(manifest.schema_version === 1 && nonempty(manifest.release_group) &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(manifest.release_group) &&
    positiveId(manifest.release_task) && manifest.package === pkg.name && manifest.version === version,
  'Manifest identity mismatch');
  requireThat(typeof manifest.base_tag === 'string' && manifest.base_tag.length <= 129 &&
    manifest.base_tag.startsWith('v') && SEMVER.test(manifest.base_tag.slice(1)) &&
    manifest.base_tag !== `v${version}` && /^[0-9a-f]{40}$/.test(manifest.base_commit), 'Invalid base identity');
  const base = git('rev-parse', '--verify', `refs/tags/${manifest.base_tag}^{commit}`).toString().trim();
  requireThat(base === manifest.base_commit && base !== git('rev-parse', '--verify', 'HEAD').toString().trim(),
    'Base commit mismatch or base equals HEAD');
  git('merge-base', '--is-ancestor', base, 'HEAD');
  const queue = json('state/task-queue.json', MAX_QUEUE);
  requireThat(Array.isArray(queue) || (object(queue) && Array.isArray(queue.tasks) && !Object.hasOwn(queue, 'id')),
    'Invalid or ambiguous task queue shape');
  const ids = new Set();
  for (const task of list(Array.isArray(queue) ? queue : queue.tasks)) {
    requireThat(object(task) && positiveId(task.id) && !ids.has(task.id), 'Invalid or duplicate queue task ID');
    ids.add(task.id);
  }
  requireThat(ids.has(manifest.release_task), 'Unknown release task');
  const changed = new Set(nulList(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--name-only', '-z', `${base}..HEAD`, '--')).map(safePath));
  requireThat(changed.size > 0, 'Release must contain changed paths');
  const owners = new Map();
  const taskIds = new Set();
  let evidenceCount = 0;
  for (const task of list(manifest.tasks)) {
    exact(task, ['task_id', 'disposition', 'scope', 'paths', 'evidence']);
    requireThat(positiveId(task.task_id) && ids.has(task.task_id) && !taskIds.has(task.task_id),
      'Unknown or duplicate manifest task ID');
    taskIds.add(task.task_id);
    requireThat(['shipping', 'non-shipping'].includes(task.disposition) && nonempty(task.scope),
      'Invalid task disposition or scope');
    for (const relative of list(task.paths)) {
      safePath(relative);
      requireThat(changed.has(relative) && !owners.has(relative), 'Unchanged or multiply owned path');
      owners.set(relative, task.task_id);
    }
    for (const evidence of list(task.evidence)) {
      requireThat(++evidenceCount <= MAX_ENTRIES, 'Too many evidence entries');
      exact(evidence, ['path', 'sha256']);
      safePath(evidence.path);
      requireThat(evidence.path !== manifestPath && typeof evidence.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(evidence.sha256), 'Invalid evidence identity');
      requireThat(createHash('sha256').update(read(evidence.path)).digest('hex') === evidence.sha256,
        'Evidence hash mismatch');
    }
  }
  requireThat(owners.size === changed.size, 'Changed paths are uncovered');
  requireThat(owners.get(manifestPath) === manifest.release_task, 'Manifest must be changed and owned by release task');
  console.log(`Release admission ${version}; group=${JSON.stringify(manifest.release_group)}; tasks=${taskIds.size}; paths=${changed.size}; planning/source coverage only; not completion or installed verification`);
}

try { main(); }
catch (error) {
  // Only our fixed diagnostics are public; filesystem/JSON errors may contain sensitive input.
  const message = error instanceof AdmissionError ? error.message : 'Input or metadata could not be validated';
  console.error(`Release admission refused: ${message.slice(0, 240)}`);
  process.exitCode = 1;
}
