#!/usr/bin/env node
import { lstatSync, realpathSync, readFileSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Explicit resource ceilings; failures never echo file contents or Git stderr.
const MAX_FILE = 16 * 1024 * 1024;
const MAX_QUEUE = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Public component slug syntax: lowercase alphanumeric segments joined by single
// hyphens. This bounds the form only — it refuses paths, whitespace and control
// characters, but a syntactically valid slug can still carry private meaning, so
// what a slug discloses remains a maintainer review question, not a check here.
const COMPONENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
class AdmissionError extends Error {}
function requireThat(condition, message) {
  if (!condition) throw new AdmissionError(message);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;

// Validate JSON tokens before JSON.parse can discard duplicate keys. The walk is
// bounded even for SARIF fields outside the supported primary-location shape.
function strictJSON(bytes, budget = { records: 0 }) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let offset = 0;
  const fail = () => { throw new AdmissionError('Malformed or oversized security JSON'); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(text[offset] ?? 'X')) offset++; };
  function string() {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '\\') offset++;
      else if (char === '"') {
        const value = JSON.parse(text.slice(start, offset));
        if (Buffer.byteLength(value, 'utf8') > 4096 || /[\uD800-\uDFFF]/u.test(value)) fail();
        return value;
      }
    }
    fail();
  }
  function value(depth) {
    if (depth > 32 || ++budget.records > MAX_ENTRIES) fail();
    whitespace();
    const char = text[offset];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      offset++;
      whitespace();
      const end = char === '{' ? '}' : ']';
      const keys = new Set();
      if (text[offset] === end) { offset++; return; }
      let length = 0;
      while (offset < text.length) {
        if (++length > MAX_ENTRIES) fail();
        if (char === '{') {
          if (text[offset] !== '"') fail();
          const key = string();
          if (keys.has(key)) fail();
          keys.add(key);
          whitespace();
          if (text[offset++] !== ':') fail();
        }
        value(depth + 1);
        whitespace();
        if (text[offset] === end) { offset++; return; }
        if (text[offset++] !== ',') fail();
        whitespace();
      }
      fail();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!token) fail();
    offset += token[0].length;
    if (/^-?\d/.test(token[0]) && !Number.isFinite(Number(token[0]))) fail();
  }
  value(0);
  whitespace();
  if (offset !== text.length) fail();
  return JSON.parse(text);
}
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
  const folded = new Map();
  const spelling = new Map();
  for (const name of tracked) {
    const key = name.toLowerCase();
    folded.set(key, (folded.get(key) ?? 0) + 1);
    const components = name.split('/');
    for (let i = 1; i <= components.length; i++) {
      const component = components.slice(0, i).join('/');
      const previous = spelling.get(component.toLowerCase());
      spelling.set(component.toLowerCase(), previous === undefined || previous === component ? component : null);
    }
  }
  function read(relative, limit = MAX_FILE) {
    safePath(relative);
    requireThat(tracked.has(relative), 'Read input must be Git-tracked');
    requireThat(folded.get(relative.toLowerCase()) === 1, 'Case-aliased input');
    const resolved = path.resolve(root, ...relative.split('/'));
    requireThat(resolved.startsWith(root + path.sep), 'Read input escapes root');
    let current = root;
    let leaf;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      const component = parts.slice(0, i + 1).join('/');
      requireThat(spelling.get(component.toLowerCase()) === component, 'Case-aliased input component');
      current = path.join(current, parts[i]);
      const stat = lstatSync(current);
      requireThat(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()),
        'Read input must be a regular file without symlinks');
      if (i === parts.length - 1) {
        requireThat(stat.size <= limit, 'Input exceeds size limit');
        leaf = stat;
      }
    }
    const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const same = stat => stat.isFile() && stat.dev === leaf.dev && stat.ino === leaf.ino &&
        stat.size === leaf.size && stat.mtimeMs === leaf.mtimeMs && stat.ctimeMs === leaf.ctimeMs;
      requireThat(same(fstatSync(fd)), 'Read input was replaced');
      bytes = readFileSync(fd);
      requireThat(same(fstatSync(fd)) && same(lstatSync(current)), 'Read input changed while reading');
    } finally { closeSync(fd); }
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
  // Committed public projection of the release group's task IDs; the private queue
  // stays the sole task authority and is never read, copied or published here.
  const projectionPath = 'release/tasks.json';
  const projection = json(projectionPath);
  exact(projection, ['schema_version', 'release_group', 'tasks']);
  requireThat(projection.schema_version === 1 && projection.release_group === manifest.release_group,
    'Projection schema or release group mismatch');
  const ids = new Set();
  for (const task of list(projection.tasks)) {
    exact(task, ['id', 'release_component']);
    requireThat(positiveId(task.id) && !ids.has(task.id) &&
      typeof task.release_component === 'string' && task.release_component.length <= 80 &&
      COMPONENT.test(task.release_component), 'Invalid or duplicate projected task');
    ids.add(task.id);
  }
  requireThat(ids.has(manifest.release_task), 'Unknown release task');
  const changed = new Set(nulList(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames',
    '--name-only', '-z', `${base}..HEAD`, '--')).map(safePath));
  requireThat(changed.size > 0, 'Release must contain changed paths');
  const owners = new Map();
  const taskIds = new Set();
  const planningEvidence = new Set();
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
      planningEvidence.add(evidence.path);
      requireThat(!evidence.path.startsWith('release/security/'), 'Planning evidence cannot depend on security records');
      requireThat(evidence.path !== manifestPath && typeof evidence.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(evidence.sha256), 'Invalid evidence identity');
      requireThat(createHash('sha256').update(read(evidence.path)).digest('hex') === evidence.sha256,
        'Evidence hash mismatch');
    }
  }
  requireThat(owners.size === changed.size, 'Changed paths are uncovered');
  requireThat(owners.get(manifestPath) === manifest.release_task, 'Manifest must be changed and owned by release task');
  // A projection carried over unchanged from an earlier release needs no ownership.
  requireThat(!changed.has(projectionPath) || owners.get(projectionPath) === manifest.release_task,
    'Projection must be owned by the release task');
  console.log(`Release admission ${version}; group=${JSON.stringify(manifest.release_group)}; tasks=${taskIds.size}; paths=${changed.size}; planning/source coverage only; not completion or installed verification`);
  security({ read, git, pkg, version, manifest, manifestPath, planningEvidence });
}

function security({ read, git, pkg, version, manifest, manifestPath, planningEvidence }) {
  const pin = process.env.RELEASE_SECURITY_POLICY_SHA256;
  const commit = process.env.RELEASE_SECURITY_COMMIT;
  requireThat(hash(pin) && typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit),
    'Security trust inputs missing or unreviewed');
  requireThat(git('rev-parse', '--verify', 'HEAD').toString().trim() === commit, 'Security commit mismatch');
  let total = 0;
  const budget = { records: 0 };
  const parse = bytes => strictJSON(bytes, budget);
  const cache = new Map();
  function input(relative) {
    if (!cache.has(relative)) {
      const bytes = read(relative);
      total += bytes.length;
      requireThat(total <= MAX_QUEUE, 'Security input total exceeds limit');
      cache.set(relative, bytes);
    }
    return cache.get(relative);
  }
  const prefix = `release/security/${version}/`;
  const planningOrSecurity = name => name === 'release/security' || name.startsWith('release/security/') ||
    /^release\/\d+\.\d+\.\d+\.json$/.test(name) || name === 'state/task-queue.json' ||
    name === 'release/tasks.json' || planningEvidence.has(name);
  const policyBytes = input(`${prefix}policy.json`);
  requireThat(sha(policyBytes) === pin, 'Security policy trust pin mismatch');
  const policy = parse(policyBytes);
  exact(policy, ['schema_version', 'release', 'candidate', 'scan', 'files', 'findings']);
  requireThat(policy.schema_version === 1, 'Unsupported security policy schema');
  exact(policy.release, ['package', 'version', 'group', 'task', 'planning_manifest_sha256']);
  requireThat(policy.release.package === pkg.name && policy.release.version === version &&
    policy.release.group === manifest.release_group && policy.release.task === manifest.release_task &&
    hash(policy.release.planning_manifest_sha256) && policy.release.planning_manifest_sha256 === sha(input(manifestPath)),
  'Security release or planning identity mismatch');
  exact(policy.candidate, ['inventory_sha256', 'source_ids', 'dependency_ids']);
  exact(policy.scan, ['sarif_id', 'receipt_id', 'projected_ids', 'scope_id']);
  const array = value => {
    requireThat(Array.isArray(value) && value.length <= MAX_ENTRIES, 'Invalid security list');
    return value;
  };
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const files = new Map();
  const identities = new Set();
  const paths = new Set();
  const used = new Set();
  for (const file of array(policy.files)) {
    exact(file, ['id', 'kind', 'path', 'bytes', 'sha256']);
    requireThat(id(file.id) && !files.has(file.id) && ['source', 'dependency', 'evidence'].includes(file.kind) &&
      count(file.bytes) && file.bytes <= MAX_FILE && hash(file.sha256), 'Invalid security file identity');
    let physical;
    if (file.kind === 'evidence') {
      requireThat(file.path === null, 'Evidence path must be derived from hash');
      physical = `${prefix}blobs/${file.sha256}`;
    } else {
      safePath(file.path);
      requireThat(!planningOrSecurity(file.path) && !paths.has(file.path.toLowerCase()), 'Invalid or duplicate inventory path');
      paths.add(file.path.toLowerCase());
      physical = file.path;
    }
    const identity = file.kind === 'evidence' ? file.sha256 : `${file.kind}:${file.path}`;
    requireThat(!identities.has(identity), 'Duplicate security file identity');
    identities.add(identity);
    const bytes = input(physical);
    requireThat(bytes.length === file.bytes && sha(bytes) === file.sha256, 'Security file hash or size mismatch');
    if (file.kind === 'evidence') new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    files.set(file.id, { ...file, data: bytes });
  }
  function reference(value, kind) {
    const file = files.get(value);
    requireThat(id(value) && file?.kind === kind, 'Unknown or wrong-kind security reference');
    used.add(value);
    return file;
  }
  function references(values, kind, nonempty = false) {
    array(values);
    requireThat(new Set(values).size === values.length && (!nonempty || values.length > 0),
      'Duplicate or empty security references');
    return values.map(value => reference(value, kind));
  }
  const sources = references(policy.candidate.source_ids, 'source');
  const dependencies = references(policy.candidate.dependency_ids, 'dependency');
  const projected = references(policy.scan.projected_ids, 'source', true);
  requireThat(projected.every(file => policy.candidate.source_ids.includes(file.id)), 'Projection outside candidate');
  const inventory = [...sources, ...dependencies].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  requireThat(hash(policy.candidate.inventory_sha256) && policy.candidate.inventory_sha256 ===
    sha(JSON.stringify(inventory.map(file => [file.path, file.bytes, file.sha256]))), 'Candidate inventory mismatch');
  requireThat(['package.json', 'package-lock.json'].every(name => dependencies.some(file => file.path === name)),
    'Required package dependencies missing');
  const packageBytes = parse(input('package.json'));
  const lock = parse(input('package-lock.json'));
  requireThat(lock.name === pkg.name && lock.version === version && object(lock.packages) &&
    lock.packages['']?.name === pkg.name && lock.packages['']?.version === version, 'Package lock identity mismatch');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const canonical = value => {
      requireThat(value === undefined || object(value), 'Invalid package dependency map');
      return JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    };
    requireThat(canonical(packageBytes[key]) === canonical(lock.packages[''][key]), 'Package lock dependencies mismatch');
  }
  const scope = parse(reference(policy.scan.scope_id, 'evidence').data);
  exact(scope, ['base_commit', 'roots', 'leaves', 'assumptions', 'limits']);
  requireThat(typeof scope.base_commit === 'string' && /^[0-9a-f]{40}$/.test(scope.base_commit) &&
    nonempty(scope.assumptions) && nonempty(scope.limits), 'Invalid security scope');
  for (const values of [scope.roots, scope.leaves]) {
    array(values).forEach(safePath);
    requireThat(new Set(values).size === values.length, 'Duplicate scope paths');
    requireThat(values.every(name => !planningOrSecurity(name)), 'Scope includes planning or security records');
  }
  git('merge-base', '--is-ancestor', scope.base_commit, 'HEAD');
  const selected = new Set(scope.leaves);
  for (const name of nulList(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z',
    `${scope.base_commit}..HEAD`, '--')).map(safePath)) {
    if (scope.roots.some(root => name === root || name.startsWith(root + '/'))) selected.add(name);
  }
  requireThat(selected.size === inventory.length && inventory.every(file => selected.has(file.path)),
    'Selected source paths differ from inventory');
  // Reading every inventory member above refuses deletions; additions are allowed
  // only when represented by the same committed bytes in the reviewed inventory.
  const receipt = parse(reference(policy.scan.receipt_id, 'evidence').data);
  exact(receipt, ['schema_version', 'sarif_sha256', 'original_receipt_sha256', 'stdout_sha256', 'manifest_sha256',
    'exit', 'findings', 'severities', 'timed_out', 'overflow', 'signal', 'sarif_valid', 'representation']);
  exact(receipt.severities, ['high', 'medium', 'low', 'unknown']);
  requireThat(receipt.schema_version === 1 && ['sarif_sha256', 'original_receipt_sha256', 'stdout_sha256', 'manifest_sha256']
    .every(key => hash(receipt[key])) && count(receipt.findings) && Object.values(receipt.severities).every(count) &&
    Object.values(receipt.severities).reduce((a, b) => a + b, 0) === receipt.findings &&
    ((receipt.exit === 0 && receipt.findings === 0) || (receipt.exit === 1 && receipt.findings > 0)) &&
    receipt.timed_out === false && receipt.overflow === false && receipt.signal === null && receipt.sarif_valid === true &&
    ['staged-scrubbed', 'stdout-exact'].includes(receipt.representation), 'Invalid scanner receipt');
  const sarifFile = reference(policy.scan.sarif_id, 'evidence');
  requireThat(sarifFile.sha256 === receipt.sarif_sha256 && (receipt.representation !== 'stdout-exact' ||
    receipt.stdout_sha256 === receipt.sarif_sha256), 'Scanner provenance mismatch');
  const sarif = parse(sarifFile.data);
  requireThat(sarif.version === '2.1.0' && Array.isArray(sarif.runs) && sarif.runs.length === 1,
    'Unsupported SARIF shape');
  const run = sarif.runs[0];
  requireThat(object(run) && !Object.hasOwn(run, 'originalUriBaseIds'), 'Unsupported SARIF URI base mapping');
  requireThat(run.tool?.driver?.name === 'SnykCode' && !run.tool.extensions &&
    (!run.invocations || array(run.invocations).every(invocation => invocation.executionSuccessful === true)),
  'Unsupported SARIF producer or failed invocation');
  const rules = array(run.tool.driver.rules);
  requireThat(rules.every(rule => object(rule) && nonempty(rule.id)) && new Set(rules.map(rule => rule.id)).size === rules.length,
    'Invalid SARIF rules');
  function region(value) {
    exact(value, ['startLine', 'startColumn', 'endLine', 'endColumn']);
    requireThat(Object.values(value).every(positiveId) && (value.endLine > value.startLine ||
      (value.endLine === value.startLine && value.endColumn >= value.startColumn)), 'Invalid finding region');
    return [value.startLine, value.startColumn, value.endLine, value.endColumn];
  }
  const tuple = (fingerprint, rule, source, location) => JSON.stringify([fingerprint, rule, source, ...region(location)]);
  const results = array(run.results);
  const observed = new Map();
  const severities = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const result of results) {
    requireThat(object(result.fingerprints), 'Invalid SARIF fingerprints');
    const secondary = Object.hasOwn(result.fingerprints, '1');
    exact(result.fingerprints, secondary ? ['0', '1'] : ['0']);
    // The producer's secondary identity is opaque metadata, never an exception key.
    requireThat(!secondary || (nonempty(result.fingerprints['1']) &&
      Buffer.byteLength(result.fingerprints['1'], 'utf8') <= 4096), 'Invalid secondary SARIF fingerprint');
    requireThat(hash(result.fingerprints['0']) && !observed.has(result.fingerprints['0']) && nonempty(result.ruleId) &&
      count(result.ruleIndex) && rules[result.ruleIndex]?.id === result.ruleId &&
      (result.level === undefined || typeof result.level === 'string') &&
      Array.isArray(result.locations) && result.locations.length === 1, 'Invalid or duplicate SARIF result');
    exact(result.locations[0], ['physicalLocation']);
    const location = result.locations[0].physicalLocation;
    exact(location, ['artifactLocation', 'region']);
    requireThat(object(location.artifactLocation), 'Invalid SARIF artifact location');
    const hasBase = Object.hasOwn(location.artifactLocation, 'uriBaseId');
    exact(location.artifactLocation, hasBase ? ['uri', 'uriBaseId'] : ['uri']);
    // SRCROOT labels the already selected repository projection; no base resolution.
    requireThat(!hasBase || location.artifactLocation.uriBaseId === '%SRCROOT%', 'Unsupported SARIF URI base');
    const uri = safePath(location.artifactLocation.uri);
    requireThat(projected.some(file => file.path === uri), 'SARIF source outside projection');
    observed.set(result.fingerprints['0'], tuple(result.fingerprints['0'], result.ruleId, uri, location.region));
    const severity = result.level === 'error' ? 'high' : result.level === 'warning' ? 'medium' : result.level === 'note' ? 'low' : 'unknown';
    severities[severity]++;
  }
  requireThat(results.length === receipt.findings && Object.keys(severities).every(key => severities[key] === receipt.severities[key]),
    'Scanner result counts mismatch');
  console.log(`Release security raw scanner: exit=${receipt.exit}; findings=${receipt.findings}; high=${severities.high}; medium=${severities.medium}; low=${severities.low}; unknown=${severities.unknown}`);
  const matched = new Set();
  let blocked = 0;
  for (const finding of array(policy.findings)) {
    exact(finding, ['fingerprint', 'rule', 'source_id', 'region', 'decision', 'source_ids', 'evidence_ids', 'rationale_id']);
    requireThat(hash(finding.fingerprint) && nonempty(finding.rule) && ['eligible', 'blocked'].includes(finding.decision) &&
      !matched.has(finding.fingerprint), 'Invalid or duplicate adjudication');
    const primary = reference(finding.source_id, 'source');
    const relied = references(finding.source_ids, 'source', true);
    requireThat(relied.some(file => file.id === primary.id) && relied.every(file => policy.candidate.source_ids.includes(file.id)),
      'Finding source references outside candidate');
    references(finding.evidence_ids, 'evidence', true);
    const rationale = new TextDecoder('utf-8', { fatal: true }).decode(reference(finding.rationale_id, 'evidence').data);
    requireThat(nonempty(rationale) && Buffer.byteLength(rationale) <= 4096, 'Missing or oversized finding rationale');
    requireThat(observed.get(finding.fingerprint) === tuple(finding.fingerprint, finding.rule, primary.path, finding.region),
      'Finding does not exactly join SARIF');
    matched.add(finding.fingerprint);
    if (finding.decision === 'blocked') blocked++;
  }
  requireThat(matched.size === observed.size && used.size === files.size, 'Missing findings or unreferenced security files');
  console.log(`Release security policy: ${blocked ? 'REJECT' : 'ACCEPT'}; eligible=${matched.size - blocked}; blocked=${blocked}; reviewed source projection only`);
  requireThat(blocked === 0, 'Security policy contains blocked findings');
}

try { main(); }
catch (error) {
  // Only our fixed diagnostics are public; filesystem/JSON errors may contain sensitive input.
  const message = error instanceof AdmissionError ? error.message : 'Input or metadata could not be validated';
  console.error(`Release admission refused: ${message.slice(0, 240)}`);
  process.exitCode = 1;
}
