#!/usr/bin/env node
// Release evidence generator for scripts/release-admission.mjs (the gate). Node stdlib only.
// It reads Git only through fixed `git` argv (no shell), reads human-authored decision files,
// and writes only inside --out (which must be absent or empty). It never invents an owner,
// disposition, scope text, rationale or decision: anything it cannot derive stays unknown,
// fails, and is printed as a `needs:` line for the human who must supply it.
//
// Ordered use (each output is committed before the next step; see `usage` below):
//   ownership  analyse which task owns every changed path (read-only; prints what is missing)
//   (scan)     scripts/release-security-scan.mjs stages the scope at a commit and writes the receipt
//   blobs      content-addressed security evidence -> release/security/<v>/blobs/<sha256>
//   manifest   planning manifest                   -> release/<v>.json
//   policy     security policy                     -> release/security/<v>/policy.json (+ candidate pin)
//
// Exit 0 only when the requested record was written complete; 1 on any refusal or gap.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class EvidenceError extends Error {}
export const fail = message => { throw new EvidenceError(message); };
export const need = (condition, message) => { if (!condition) fail(message); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const HEX40 = /^[0-9a-f]{40}$/;
// Gate ceilings (scripts/release-admission.mjs MAX_FILE, MAX_QUEUE, MAX_ENTRIES).
export const MAX_FILE = 16 * 1024 * 1024;
const MAX_QUEUE = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
export const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;

// Same predicate as safePath() in the gate.
export function isSafePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f-\x9f:]/u.test(value) && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function exactKeys(value, keys, label) {
  need(isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    `${label}: expected exactly keys ${keys.join(', ')}`);
}

// Verbatim copy of the gate's strictJSON() token walk (duplicate keys, >4096-byte strings,
// lone surrogates, depth > 32, > 100000 values per shared budget, non-finite numbers), so the
// tools refuse what the gate would refuse before anything is committed.
export function strictJSON(bytes, budget = { records: 0 }) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let offset = 0;
  const fail = () => { throw new EvidenceError('Malformed or oversized security JSON'); };
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

// Task IDs a commit subject names: a numeric conventional-commit scope `type(N):`
// and/or a trailing `(#N)` / `(#N #M)` / `(#N, #M)` group. Nothing else counts.
export function parseSubjectTasks(subject) {
  const ids = new Set();
  const scope = /^[a-z]+\((\d+)\)!?:/.exec(subject);
  if (scope) ids.add(Number(scope[1]));
  const trailer = /\((#\d+(?:[ ,]+#\d+)*)\)\s*$/.exec(subject);
  if (trailer) for (const match of trailer[1].matchAll(/#(\d+)/g)) ids.add(Number(match[1]));
  for (const id of ids) need(positiveId(id), `subject names an invalid task id: ${subject}`);
  return [...ids].sort((a, b) => a - b);
}

// Parses `git log --no-renames --name-status --format=@@%H|%cI|%s` output.
export function parseNameStatusLog(text) {
  const commits = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('@@')) {
      const first = line.indexOf('|');
      const second = line.indexOf('|', first + 1);
      need(first > 2 && second > first, `malformed commit header: ${line.slice(0, 120)}`);
      const sha = line.slice(2, first);
      need(HEX40.test(sha), `malformed commit sha: ${sha}`);
      const subject = line.slice(second + 1);
      current = { sha, date: line.slice(first + 1, second), subject, tasks: parseSubjectTasks(subject), paths: [] };
      commits.push(current);
      continue;
    }
    need(current, 'path line before any commit header');
    const match = /^([AMDT])\t(.+)$/.exec(line);
    need(match, `unsupported name-status line (renames/copies/quoted paths are refused): ${line.slice(0, 160)}`);
    need(!match[2].startsWith('"') && isSafePath(match[2]), `unsafe or quoted path in log: ${match[2].slice(0, 160)}`);
    current.paths.push({ status: match[1], path: match[2] });
  }
  return commits;
}

// Human attribution for commits whose subject names no task: { "<sha>": { tasks: [N], reason } }.
// It may only fill an empty subject attribution, only with projected tasks, and must carry a reason.
export function applyCommitAttributions(commits, attributions, projectionIds) {
  need(isObject(attributions), 'commit-tasks file must be a JSON object keyed by commit sha');
  const bySha = new Map(commits.map(commit => [commit.sha, commit]));
  for (const [sha, entry] of Object.entries(attributions)) {
    const commit = bySha.get(sha);
    need(commit, `attribution names a commit outside the range: ${sha}`);
    need(commit.tasks.length === 0, `attribution cannot override the subject's task ids for ${sha}`);
    exactKeys(entry, ['tasks', 'reason'], `attribution for ${sha}`);
    need(Array.isArray(entry.tasks) && entry.tasks.length > 0 && entry.tasks.every(id => positiveId(id) && projectionIds.has(id)) &&
      new Set(entry.tasks).size === entry.tasks.length && nonempty(entry.reason), `attribution for ${sha} must name projected tasks and a reason`);
  }
  return commits.map(commit => Object.hasOwn(attributions, commit.sha)
    ? { ...commit, tasks: [...attributions[commit.sha].tasks].sort((a, b) => a - b), attributed_by: 'human' } : commit);
}

export function splitNul(buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (!text) return [];
  need(text.endsWith('\0'), 'malformed NUL-separated Git output');
  return text.slice(0, -1).split('\0');
}

// release/tasks.json, validated the way the gate does.
export function validateProjection(projection) {
  exactKeys(projection, ['schema_version', 'release_group', 'tasks'], 'release/tasks.json');
  need(projection.schema_version === 1 && nonempty(projection.release_group) &&
    !/[\x00-\x1f\x7f-\x9f]/u.test(projection.release_group), 'release/tasks.json: bad schema or group');
  need(Array.isArray(projection.tasks) && projection.tasks.length > 0, 'release/tasks.json: empty tasks');
  const ids = new Set();
  for (const task of projection.tasks) {
    exactKeys(task, ['id', 'release_component'], 'release/tasks.json task');
    need(positiveId(task.id) && !ids.has(task.id) && typeof task.release_component === 'string' &&
      task.release_component.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.release_component),
    `release/tasks.json: invalid or duplicate task ${JSON.stringify(task.id)}`);
    ids.add(task.id);
  }
  return ids;
}

// Release-task-reserved records: the gate requires the manifest (and a changed projection)
// to be owned by the release task, and the security records for this version are produced
// by the release task by construction.
export function reservedOwner(name, version) {
  return name === `release/${version}.json` || name === 'release/tasks.json' ||
    name.startsWith(`release/security/${version}/`);
}

// Strict ownership rule. For every path in the gate's changed set:
//   reserved release record                           -> release task
//   no commit in the range touches it                 -> unknown  (no-touching-commit)
//   any touching commit names no task                 -> unknown  (untagged-commit)
//   touching commits name more than one task in total -> unknown  (multiple-tasks)
//   the single task is not in release/tasks.json      -> unknown  (unprojected-task)
//   otherwise                                          -> that single task
// A human resolution may settle only an unknown path, only to a projected task, and must
// carry a reason. It can never override a derived owner.
export function assignOwners({ changed, commits, projectionIds, releaseTask, version, resolutions = {} }) {
  need(isObject(resolutions), 'resolutions file must be a JSON object keyed by path');
  const touching = new Map();
  for (const commit of commits) {
    for (const entry of commit.paths) {
      if (!touching.has(entry.path)) touching.set(entry.path, []);
      touching.get(entry.path).push(commit);
    }
  }
  const records = [];
  for (const name of [...changed].sort(byteOrder)) {
    const list = touching.get(name) ?? [];
    const tasks = [...new Set(list.flatMap(commit => commit.tasks))].sort((a, b) => a - b);
    const untagged = list.filter(commit => commit.tasks.length === 0).map(commit => commit.sha);
    let owner = null;
    let reason;
    if (reservedOwner(name, version)) { owner = releaseTask; reason = 'reserved-release-record'; }
    else if (list.length === 0) reason = 'no-touching-commit';
    else if (untagged.length) reason = 'untagged-commit';
    else if (tasks.length > 1) reason = 'multiple-tasks';
    else if (!projectionIds.has(tasks[0])) reason = 'unprojected-task';
    else { owner = tasks[0]; reason = 'unique-task'; }
    records.push({ path: name, owner, reason, tasks, commits: list.map(commit => commit.sha), untagged_commits: untagged });
  }
  const byPath = new Map(records.map(record => [record.path, record]));
  for (const [name, resolution] of Object.entries(resolutions)) {
    const record = byPath.get(name);
    need(record, `resolution names a path outside the changed set: ${name}`);
    need(record.owner === null, `resolution cannot override derived owner of ${name}`);
    exactKeys(resolution, ['task_id', 'reason'], `resolution for ${name}`);
    need(positiveId(resolution.task_id) && projectionIds.has(resolution.task_id) && nonempty(resolution.reason),
      `resolution for ${name} must name a projected task and a reason`);
    record.owner = resolution.task_id;
    record.resolved_by = 'human';
    record.resolution_reason = resolution.reason;
  }
  return records;
}

// dispositions: { "<task_id>": { disposition, scope, evidence: [path, ...] } } (human-authored).
// evidenceHash(path) returns the committed sha256 or throws.
export function buildManifest({ records, dispositions, projection, releaseTask, packageName, version, baseTag, baseCommit, evidenceHash }) {
  const unresolved = records.filter(record => record.owner === null);
  need(unresolved.length === 0, `${unresolved.length} changed path(s) have no owner; see ownership.json`);
  need(isObject(dispositions), 'dispositions file must be a JSON object keyed by task id');
  const manifestPath = `release/${version}.json`;
  const byTask = new Map();
  for (const record of records) {
    if (!byTask.has(record.owner)) byTask.set(record.owner, []);
    byTask.get(record.owner).push(record.path);
  }
  need(byTask.get(releaseTask)?.includes(manifestPath), 'manifest path must be owned by the release task');
  for (const key of Object.keys(dispositions)) {
    need(/^[1-9]\d*$/.test(key) && byTask.has(Number(key)), `task ${key} has a disposition but owns no changed path; the manifest cannot record it`);
  }
  const tasks = [];
  for (const id of [...byTask.keys()].sort((a, b) => a - b)) {
    const entry = dispositions[String(id)];
    need(entry, `task ${id} owns paths but has no human disposition`);
    exactKeys(entry, ['disposition', 'scope', 'evidence'], `disposition for ${id}`);
    need(['shipping', 'non-shipping'].includes(entry.disposition) && nonempty(entry.scope),
      `disposition for ${id} needs shipping|non-shipping and a scope`);
    need(Array.isArray(entry.evidence) && entry.evidence.length > 0, `disposition for ${id} needs evidence`);
    const evidence = entry.evidence.map(name => {
      need(isSafePath(name) && name !== manifestPath && !name.startsWith('release/security/'),
        `task ${id}: evidence path not admissible: ${name}`);
      return { path: name, sha256: evidenceHash(name) };
    });
    tasks.push({ task_id: id, disposition: entry.disposition, scope: entry.scope,
      paths: byTask.get(id).sort(byteOrder), evidence });
  }
  return { schema_version: 1, release_group: projection.release_group, release_task: releaseTask,
    package: packageName, version, base_tag: baseTag, base_commit: baseCommit, tasks };
}

// Same predicate as planningOrSecurity() in the gate.
export function planningOrSecurity(name, planningEvidence) {
  return name === 'release/security' || name.startsWith('release/security/') ||
    /^release\/\d+\.\d+\.\d+\.json$/.test(name) || name === 'state/task-queue.json' ||
    name === 'release/tasks.json' || planningEvidence.has(name);
}

export function validateScope(scope) {
  exactKeys(scope, ['base_commit', 'roots', 'leaves', 'assumptions', 'limits'], 'scope');
  need(HEX40.test(scope.base_commit ?? '') && nonempty(scope.assumptions) && nonempty(scope.limits), 'scope: bad base or text');
  for (const list of [scope.roots, scope.leaves]) {
    need(Array.isArray(list) && list.every(isSafePath) && new Set(list).size === list.length, 'scope: bad or duplicate paths');
  }
}

// Scope selection exactly as the gate computes it: leaves plus changed paths under roots.
export function selectScope(scope, diffPaths, planningEvidence) {
  for (const name of [...scope.roots, ...scope.leaves]) {
    need(!planningOrSecurity(name, planningEvidence), `scope names a planning or security record: ${name}`);
  }
  const selected = new Set(scope.leaves);
  for (const name of diffPaths) {
    if (scope.roots.some(root => name === root || name.startsWith(root + '/'))) selected.add(name);
  }
  for (const name of selected) need(!planningOrSecurity(name, planningEvidence), `scope selects a planning or security record: ${name}`);
  return [...selected].sort(byteOrder);
}

export const DEPENDENCY_PATHS = ['package.json', 'package-lock.json'];
// files: [{ path, bytes: Buffer }] committed at HEAD.
export function inventoryEntries(files) {
  const sorted = [...files].sort((a, b) => byteOrder(a.path, b.path));
  let index = 0;
  return sorted.map(file => {
    const dependency = DEPENDENCY_PATHS.includes(file.path);
    const id = dependency ? `dep-${file.path.replace(/[^A-Za-z0-9]+/g, '-')}` : `src-${String(++index).padStart(5, '0')}`;
    return { id, kind: dependency ? 'dependency' : 'source', path: file.path, bytes: file.bytes.length, sha256: sha256(file.bytes) };
  });
}
// [[path, bytes, sha256], ...] in path byte order: the gate's inventory tuple, also the scan manifest's file list.
export const inventoryTriples = entries => [...entries].sort((a, b) => byteOrder(a.path, b.path)).map(file => [file.path, file.bytes, file.sha256]);
// Same formula as the gate: sha256 of JSON [[path, bytes, sha256], ...] in path byte order.
export const inventorySha256 = entries => sha256(JSON.stringify(inventoryTriples(entries)));

export const RECEIPT_KEYS = ['schema_version', 'sarif_sha256', 'original_receipt_sha256', 'stdout_sha256', 'manifest_sha256',
  'exit', 'findings', 'severities', 'timed_out', 'overflow', 'signal', 'sarif_valid', 'representation'];
export function validateReceipt(receipt, sarifBytes) {
  exactKeys(receipt, RECEIPT_KEYS, 'receipt');
  exactKeys(receipt.severities, ['high', 'medium', 'low', 'unknown'], 'receipt.severities');
  const count = value => Number.isSafeInteger(value) && value >= 0;
  need(receipt.schema_version === 1 && ['sarif_sha256', 'original_receipt_sha256', 'stdout_sha256', 'manifest_sha256']
    .every(key => HEX64.test(receipt[key] ?? '')) && count(receipt.findings) && Object.values(receipt.severities).every(count) &&
    Object.values(receipt.severities).reduce((a, b) => a + b, 0) === receipt.findings &&
    ((receipt.exit === 0 && receipt.findings === 0) || (receipt.exit === 1 && receipt.findings > 0)) &&
    receipt.timed_out === false && receipt.overflow === false && receipt.signal === null && receipt.sarif_valid === true &&
    ['staged-scrubbed', 'stdout-exact'].includes(receipt.representation), 'receipt: invalid scanner receipt');
  need(receipt.sarif_sha256 === sha256(sarifBytes), 'receipt: sarif_sha256 does not match the SARIF bytes');
  need(receipt.representation !== 'stdout-exact' || receipt.stdout_sha256 === receipt.sarif_sha256,
    'receipt: stdout-exact requires stdout_sha256 == sarif_sha256');
}

// Returns [{ fingerprint, rule, path, region, level }] for the single SnykCode run, applying
// the gate's SARIF checks. projectedPaths === null checks URI safety but not membership.
export function sarifResults(sarif, projectedPaths) {
  need(sarif?.version === '2.1.0' && Array.isArray(sarif.runs) && sarif.runs.length === 1, 'SARIF: need version 2.1.0 and one run');
  const run = sarif.runs[0];
  need(isObject(run) && !Object.hasOwn(run, 'originalUriBaseIds'), 'SARIF: originalUriBaseIds is not admissible');
  need(run.tool?.driver?.name === 'SnykCode' && !run.tool.extensions &&
    (!run.invocations || (Array.isArray(run.invocations) && run.invocations.every(item => item?.executionSuccessful === true))),
  'SARIF: producer must be SnykCode with successful invocations');
  const rules = run.tool.driver.rules;
  need(Array.isArray(rules) && rules.every(rule => isObject(rule) && nonempty(rule.id)) &&
    new Set(rules.map(rule => rule.id)).size === rules.length, 'SARIF: invalid rules');
  need(Array.isArray(run.results), 'SARIF: results must be an array');
  const seen = new Set();
  return run.results.map((result, index) => {
    const at = `SARIF result ${index}`;
    need(isObject(result?.fingerprints), `${at}: fingerprints`);
    exactKeys(result.fingerprints, Object.hasOwn(result.fingerprints, '1') ? ['0', '1'] : ['0'], `${at} fingerprints`);
    need(!Object.hasOwn(result.fingerprints, '1') || (nonempty(result.fingerprints['1']) &&
      Buffer.byteLength(result.fingerprints['1'], 'utf8') <= 4096), `${at}: invalid secondary fingerprint`);
    const fingerprint = result.fingerprints['0'];
    need(HEX64.test(fingerprint ?? '') && !seen.has(fingerprint), `${at}: primary fingerprint must be unique 64-hex`);
    seen.add(fingerprint);
    need(nonempty(result.ruleId) && Number.isSafeInteger(result.ruleIndex) && result.ruleIndex >= 0 && rules[result.ruleIndex]?.id === result.ruleId,
      `${at}: ruleId/ruleIndex mismatch`);
    need(result.level === undefined || typeof result.level === 'string', `${at}: level must be a string`);
    need(Array.isArray(result.locations) && result.locations.length === 1, `${at}: exactly one location`);
    // Same rule as the gate: Snyk Code's optional non-negative integer location `id`, and no other extra key.
    const hasId = isObject(result.locations[0]) && Object.hasOwn(result.locations[0], 'id');
    exactKeys(result.locations[0], hasId ? ['id', 'physicalLocation'] : ['physicalLocation'], `${at} location`);
    need(!hasId || (Number.isSafeInteger(result.locations[0].id) && result.locations[0].id >= 0), `${at}: location id must be a non-negative integer`);
    const location = result.locations[0].physicalLocation;
    exactKeys(location, ['artifactLocation', 'region'], `${at} physicalLocation`);
    const artifact = location.artifactLocation;
    need(isObject(artifact), `${at}: artifactLocation`);
    exactKeys(artifact, Object.hasOwn(artifact, 'uriBaseId') ? ['uri', 'uriBaseId'] : ['uri'], `${at} artifactLocation`);
    need(!Object.hasOwn(artifact, 'uriBaseId') || artifact.uriBaseId === '%SRCROOT%', `${at}: uriBaseId must be %SRCROOT%`);
    need(isSafePath(artifact.uri) && (projectedPaths === null || projectedPaths.has(artifact.uri)), `${at}: uri outside the projected sources`);
    exactKeys(location.region, ['startLine', 'startColumn', 'endLine', 'endColumn'], `${at} region`);
    const region = location.region;
    need(Object.values(region).every(positiveId) && (region.endLine > region.startLine ||
      (region.endLine === region.startLine && region.endColumn >= region.startColumn)), `${at}: invalid region`);
    return { fingerprint, rule: result.ruleId, path: artifact.uri, level: result.level,
      region: { startLine: region.startLine, startColumn: region.startColumn, endLine: region.endLine, endColumn: region.endColumn } };
  });
}

export function severityCounts(results) {
  const counts = { high: 0, medium: 0, low: 0, unknown: 0 };
  for (const { level } of results) counts[level === 'error' ? 'high' : level === 'warning' ? 'medium' : level === 'note' ? 'low' : 'unknown']++;
  return counts;
}

// The receipt's counts must equal the SARIF results; the adjudications must cover them exactly.
function checkCounts(results, receipt) {
  const counts = severityCounts(results);
  need(results.length === receipt.findings && Object.keys(counts).every(key => counts[key] === receipt.severities[key]),
    'receipt counts differ from SARIF results');
}
function checkAdjudicationCoverage(results, adjudications) {
  const known = new Set(results.map(result => result.fingerprint));
  for (const fingerprint of Object.keys(adjudications)) need(known.has(fingerprint), `adjudication for a fingerprint not in SARIF: ${fingerprint}`);
  const missing = results.filter(result => !Object.hasOwn(adjudications, result.fingerprint));
  for (const result of missing) {
    console.error(`needs: adjudication for ${result.fingerprint} (${result.rule} at ${result.path}:${result.region.startLine}:${result.region.startColumn}) — decision eligible|blocked, source_paths, evidence_files, rationale_file`);
  }
  need(missing.length === 0, `${missing.length} SARIF finding(s) have no human adjudication`);
  const blocked = Object.entries(adjudications).filter(([, entry]) => entry.decision === 'blocked');
  need(blocked.length === 0, `${blocked.length} finding(s) adjudicated blocked; the gate would REJECT — fix and rescan instead`);
}

// adjudications: { "<fingerprint>": { decision, source_paths, evidence: [Buffer], rationale: Buffer } } (human-authored).
export function buildPolicy({ packageName, version, group, releaseTask, manifestBytes, inventory, projectedPaths,
  sarifBytes, receiptBytes, scopeBytes, results, adjudications }) {
  const evidence = new Map();
  const addEvidence = (bytes, preferredId) => {
    const digest = sha256(bytes);
    if (!evidence.has(digest)) evidence.set(digest, { id: preferredId ?? `ev-${digest.slice(0, 16)}`, bytes });
    return evidence.get(digest).id;
  };
  const sarifId = addEvidence(sarifBytes, 'sarif');
  const receiptId = addEvidence(receiptBytes, 'receipt');
  const scopeId = addEvidence(scopeBytes, 'scope');
  const byPath = new Map(inventory.map(file => [file.path, file]));
  const sources = inventory.filter(file => file.kind === 'source');
  const dependencies = inventory.filter(file => file.kind === 'dependency');
  need(DEPENDENCY_PATHS.every(name => dependencies.some(file => file.path === name)), 'inventory must contain package.json and package-lock.json');
  const projected = [...projectedPaths].sort(byteOrder).map(name => {
    need(byPath.get(name)?.kind === 'source', `projected path is not an inventoried source: ${name}`);
    return byPath.get(name).id;
  });
  need(projected.length > 0, 'projection must name at least one source');
  checkAdjudicationCoverage(results, adjudications);
  const findings = results.map(result => {
    const decision = adjudications[result.fingerprint];
    need(['eligible', 'blocked'].includes(decision.decision), `finding ${result.fingerprint}: decision must be eligible|blocked`);
    need(Array.isArray(decision.source_paths) && decision.source_paths.includes(result.path) &&
      decision.source_paths.every(name => byPath.get(name)?.kind === 'source') && new Set(decision.source_paths).size === decision.source_paths.length,
    `finding ${result.fingerprint}: source_paths must include the primary source and only inventoried sources`);
    need(Array.isArray(decision.evidence) && decision.evidence.length > 0, `finding ${result.fingerprint}: evidence required`);
    const rationaleText = new TextDecoder('utf-8', { fatal: true }).decode(decision.rationale);
    need(nonempty(rationaleText) && decision.rationale.length <= 4096, `finding ${result.fingerprint}: rationale must be 1..4096 UTF-8 bytes`);
    const evidenceIds = [...new Set(decision.evidence.map(bytes => addEvidence(bytes)))];
    return { fingerprint: result.fingerprint, rule: result.rule, source_id: byPath.get(result.path).id, region: result.region,
      decision: decision.decision, source_ids: decision.source_paths.map(name => byPath.get(name).id),
      evidence_ids: evidenceIds, rationale_id: addEvidence(decision.rationale) };
  });
  for (const item of evidence.values()) new TextDecoder('utf-8', { fatal: true }).decode(item.bytes);
  const files = [...inventory.map(file => ({ id: file.id, kind: file.kind, path: file.path, bytes: file.bytes, sha256: file.sha256 })),
    ...[...evidence.entries()].map(([digest, item]) => ({ id: item.id, kind: 'evidence', path: null, bytes: item.bytes.length, sha256: digest }))];
  const policy = { schema_version: 1,
    release: { package: packageName, version, group, task: releaseTask, planning_manifest_sha256: sha256(manifestBytes) },
    candidate: { inventory_sha256: inventorySha256(inventory), source_ids: sources.map(file => file.id), dependency_ids: dependencies.map(file => file.id) },
    scan: { sarif_id: sarifId, receipt_id: receiptId, projected_ids: projected, scope_id: scopeId },
    files, findings };
  return { policy, blobs: [...evidence.entries()].map(([digest, item]) => ({ sha256: digest, bytes: item.bytes })) };
}

export const serialize = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

// ---------------------------------------------------------------- CLI / Git I/O
export function parseArgs(argv, allowed) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    need(allowed.includes(flag) && !options.has(flag) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'),
      `invalid or repeated flag: ${flag}`);
    options.set(flag, argv[i + 1]);
  }
  return options;
}
// The gate's Git environment: every GIT_* dropped, system/global config and replace objects off.
export function gitRunner(repo) {
  need(typeof repo === 'string' && path.isAbsolute(repo), '--repo must be absolute');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1' });
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', repo, ...args], { env, maxBuffer: MAX_QUEUE, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { fail(`git ${args.find(arg => !arg.startsWith('-')) ?? args[0]} failed`); }
  };
  return git;
}
export const headFile = (git, name, rev = 'HEAD') => git('cat-file', 'blob', `${rev}:${name}`);
export const diffNames = (git, from, to = 'HEAD') =>
  splitNul(git('diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', `${from}..${to}`, '--'));
export function prepareOut(out) {
  need(typeof out === 'string' && path.isAbsolute(out), '--out must be an absolute directory');
  need(!existsSync(out) || readdirSync(out).length === 0, '--out must be absent or empty');
  mkdirSync(out, { recursive: true });
  return name => path.join(out, ...name.split('/'));
}
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function resolveRange(o) {
  const version = o.get('--version');
  const baseTag = o.get('--base-tag');
  const releaseTask = Number(o.get('--release-task'));
  need(SEMVER.test(version ?? '') && /^v\d+\.\d+\.\d+$/.test(baseTag ?? '') && SEMVER.test(baseTag.slice(1)) &&
    baseTag !== `v${version}` && positiveId(releaseTask), 'missing or invalid --version, --base-tag or --release-task');
  const git = gitRunner(o.get('--repo'));
  const pkg = JSON.parse(headFile(git, 'package.json'));
  need(pkg.version === version, `HEAD package.json version ${pkg.version} != ${version} (bump package.json and package-lock.json first)`);
  need(nonempty(pkg.name), 'HEAD package.json has no name');
  const projection = JSON.parse(headFile(git, 'release/tasks.json'));
  const projectionIds = validateProjection(projection);
  need(projectionIds.has(releaseTask), 'release task is not in release/tasks.json');
  const baseCommit = git('rev-parse', '--verify', `refs/tags/${baseTag}^{commit}`).toString().trim();
  const head = git('rev-parse', '--verify', 'HEAD').toString().trim();
  need(baseCommit !== head, 'base equals HEAD');
  git('merge-base', '--is-ancestor', baseCommit, 'HEAD');
  const changed = new Set(diffNames(git, baseCommit));
  for (const name of changed) need(isSafePath(name), `changed path the gate refuses: ${JSON.stringify(name)}`);
  // Records committed after this step: the manifest itself and the policy.
  changed.add(`release/${version}.json`);
  changed.add(`release/security/${version}/policy.json`);
  const attributions = o.has('--commit-tasks-file') ? readJson(o.get('--commit-tasks-file')) : {};
  const commits = applyCommitAttributions(parseNameStatusLog(git('-c', 'core.quotePath=false', 'log', '--no-renames', '--no-ext-diff',
    '--no-textconv', '--no-color', '--name-status', '--format=@@%H|%cI|%s', `${baseCommit}..HEAD`, '--').toString('utf8')), attributions, projectionIds);
  const resolutions = o.has('--resolutions-file') ? readJson(o.get('--resolutions-file')) : {};
  const records = assignOwners({ changed, commits, projectionIds, releaseTask, version, resolutions });
  return { git, version, baseTag, baseCommit, head, releaseTask, pkg, projection, commits, records };
}

function writeOwnership(out, { head, baseCommit, commits, records }) {
  const unresolved = records.filter(record => record.owner === null);
  const untagged = commits.filter(commit => commit.tasks.length === 0).map(commit => ({ sha: commit.sha, subject: commit.subject }));
  writeFileSync(out('ownership.json'), serialize({ head, base_commit: baseCommit, untagged_commits: untagged, records }));
  const reasons = {};
  for (const record of unresolved) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
  console.log(`changed=${records.length} owned=${records.length - unresolved.length} unresolved=${unresolved.length} ${JSON.stringify(reasons)}`);
  for (const commit of untagged) {
    if (unresolved.some(record => record.untagged_commits.includes(commit.sha))) {
      console.log(`needs: commit task attribution (--commit-tasks-file) for ${commit.sha} ${JSON.stringify(commit.subject)}`);
    }
  }
  for (const record of unresolved) {
    console.log(`needs: owner for ${record.path} (${record.reason}; tasks=${record.tasks.join(',') || '-'}) via --resolutions-file or commit attribution`);
  }
  return unresolved.length;
}

const RANGE_FLAGS = ['--repo', '--version', '--base-tag', '--release-task', '--commit-tasks-file', '--resolutions-file', '--out'];

function ownershipCommand(argv) {
  const o = parseArgs(argv, RANGE_FLAGS);
  const range = resolveRange(o);
  const out = prepareOut(o.get('--out'));
  const unresolved = writeOwnership(out, range);
  need(unresolved === 0, `${unresolved} changed path(s) have no owner; ownership.json written, nothing else`);
  console.log('every changed path has an owner; next: manifest (with --dispositions-file)');
}

function manifestCommand(argv) {
  const o = parseArgs(argv, [...RANGE_FLAGS, '--dispositions-file']);
  need(o.has('--dispositions-file'), 'missing --dispositions-file');
  const range = resolveRange(o);
  const { git, version, records, releaseTask } = range;
  const out = prepareOut(o.get('--out'));
  writeOwnership(out, range);
  const dispositions = readJson(o.get('--dispositions-file'));
  if (isObject(dispositions)) {
    const owners = [...new Set(records.map(record => record.owner).filter(owner => owner !== null))].sort((a, b) => a - b);
    for (const id of owners) if (!Object.hasOwn(dispositions, String(id))) console.log(`needs: disposition, scope and evidence for task ${id}`);
  }
  const manifest = buildManifest({ records, dispositions, projection: range.projection, releaseTask,
    packageName: range.pkg.name, version, baseTag: range.baseTag, baseCommit: range.baseCommit,
    evidenceHash: name => {
      let bytes;
      try { bytes = headFile(git, name); } catch { fail(`planning evidence is not committed at HEAD: ${name}`); }
      return sha256(bytes);
    } });
  const blobPrefix = `release/security/${version}/blobs/`;
  if (!records.some(record => record.path.startsWith(blobPrefix))) {
    console.log(`needs: security blobs committed under ${blobPrefix} before the manifest (run "blobs" first); without them policy will refuse`);
  }
  if (!records.some(record => record.path === '.github/workflows/release.yml')) {
    console.log('note: .github/workflows/release.yml is not a changed path; the reviewed-pin commit would add an unowned path — regenerate the manifest after it');
  }
  writeFileSync(out(`${version}.json`), serialize(manifest));
  console.log(`wrote ${version}.json for HEAD ${range.head}; commit it unchanged as release/${version}.json`);
}

function loadAdjudications(file) {
  const raw = readJson(file);
  exactKeys(raw, ['findings'], 'adjudications');
  need(isObject(raw.findings), 'adjudications.findings must be an object');
  const base = path.dirname(path.resolve(file));
  const load = name => {
    need(typeof name === 'string' && name.length > 0, 'adjudication file references must be non-empty strings');
    return readFileSync(path.resolve(base, name));
  };
  const adjudications = {};
  for (const [fingerprint, entry] of Object.entries(raw.findings)) {
    exactKeys(entry, ['decision', 'source_paths', 'evidence_files', 'rationale_file'], `adjudication ${fingerprint}`);
    need(Array.isArray(entry.evidence_files), `adjudication ${fingerprint}: evidence_files must be a list`);
    adjudications[fingerprint] = { decision: entry.decision, source_paths: entry.source_paths,
      evidence: entry.evidence_files.map(load), rationale: load(entry.rationale_file) };
  }
  return adjudications;
}

// Security inputs shared by blobs and policy: the receipt, the SARIF and the scope, checked
// as the gate checks them. projectedPaths === null skips URI membership (no Git in blobs).
function loadScanEvidence(o, projectedPaths) {
  const sarifBytes = readFileSync(o.get('--sarif-file'));
  const receiptBytes = readFileSync(o.get('--receipt-file'));
  const scopeBytes = readFileSync(o.get('--scope-file'));
  const budget = { records: 0 };
  const receipt = strictJSON(receiptBytes, budget);
  validateReceipt(receipt, sarifBytes);
  const scope = strictJSON(scopeBytes, budget);
  validateScope(scope);
  const results = sarifResults(strictJSON(sarifBytes, budget), projectedPaths);
  checkCounts(results, receipt);
  return { sarifBytes, receiptBytes, scopeBytes, receipt, scope, results };
}

// Content-addressed security blobs need no Git and no manifest, so their names (and
// therefore the manifest's path list) are fixed before planning.
function blobsCommand(argv) {
  const o = parseArgs(argv, ['--version', '--scope-file', '--sarif-file', '--receipt-file', '--adjudications-file', '--out']);
  const version = o.get('--version');
  need(SEMVER.test(version ?? '') && ['--scope-file', '--sarif-file', '--receipt-file', '--adjudications-file'].every(flag => o.has(flag)),
    'missing or invalid required flags');
  const { sarifBytes, receiptBytes, scopeBytes, results } = loadScanEvidence(o, null);
  const adjudications = loadAdjudications(o.get('--adjudications-file'));
  checkAdjudicationCoverage(results, adjudications);
  const all = [sarifBytes, receiptBytes, scopeBytes, ...Object.values(adjudications).flatMap(entry => [...entry.evidence, entry.rationale])];
  for (const bytes of all) {
    need(bytes.length <= MAX_FILE, 'evidence file exceeds 16 MiB');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('evidence files must be valid UTF-8'); }
  }
  const out = prepareOut(o.get('--out'));
  mkdirSync(out('blobs'));
  const names = new Set();
  for (const bytes of all) {
    const digest = sha256(bytes);
    if (!existsSync(out(`blobs/${digest}`))) writeFileSync(out(`blobs/${digest}`), bytes);
    names.add(`release/security/${version}/blobs/${digest}`);
  }
  writeFileSync(out('blob-paths.txt'), [...names].sort(byteOrder).join('\n') + '\n');
  console.log(`wrote ${names.size} blob(s); commit each blobs/<sha256> unchanged at the listed repo path before generating the manifest`);
}

function policyCommand(argv) {
  const o = parseArgs(argv, ['--repo', '--version', '--scope-file', '--sarif-file', '--receipt-file', '--scan-manifest-file',
    '--adjudications-file', '--projected-file', '--out']);
  const version = o.get('--version');
  need(SEMVER.test(version ?? '') && ['--scope-file', '--sarif-file', '--receipt-file', '--scan-manifest-file', '--adjudications-file']
    .every(flag => o.has(flag)), 'missing or invalid required flags');
  const git = gitRunner(o.get('--repo'));
  const head = git('rev-parse', '--verify', 'HEAD').toString().trim();
  const pkg = JSON.parse(headFile(git, 'package.json'));
  const manifestPath = `release/${version}.json`;
  let manifestBytes;
  try { manifestBytes = headFile(git, manifestPath); } catch { fail(`${manifestPath} is not committed at HEAD (run "manifest" and commit it first)`); }
  const manifest = JSON.parse(manifestBytes);
  need(manifest.version === version && pkg.version === version && manifest.package === pkg.name, 'manifest/package identity mismatch at HEAD');
  const lock = JSON.parse(headFile(git, 'package-lock.json'));
  need(lock.name === pkg.name && lock.version === version && lock.packages?.['']?.name === pkg.name &&
    lock.packages['']?.version === version, 'package-lock.json identity is not bumped to the release version');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const canonical = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => byteOrder(a, b)));
    need(canonical(pkg[key]) === canonical(lock.packages[''][key]), `package-lock.json ${key} differ from package.json`);
  }
  const planningEvidence = new Set(manifest.tasks.flatMap(task => task.evidence.map(item => item.path)));
  const owned = new Set(manifest.tasks.filter(task => task.task_id === manifest.release_task).flatMap(task => task.paths));
  need(owned.has(`release/security/${version}/policy.json`), `manifest does not list release/security/${version}/policy.json under the release task`);

  const scopeBytes = readFileSync(o.get('--scope-file'));
  const scope = JSON.parse(scopeBytes);
  validateScope(scope);
  git('merge-base', '--is-ancestor', scope.base_commit, 'HEAD');
  const selected = selectScope(scope, diffNames(git, scope.base_commit), planningEvidence);
  const inventory = inventoryEntries(selected.map(name => {
    let bytes;
    try { bytes = headFile(git, name); } catch { fail(`selected path is absent at HEAD (deleted under a scope root?): ${name}`); }
    return { path: name, bytes };
  }));
  // Bind the scan to the inventoried bytes: the gate cannot check that the SARIF came from them.
  const scanManifestBytes = readFileSync(o.get('--scan-manifest-file'));
  const scanManifest = JSON.parse(scanManifestBytes);
  exactKeys(scanManifest, ['schema_version', 'commit', 'scope_sha256', 'files'], 'scan manifest');
  need(scanManifest.schema_version === 1 && HEX40.test(scanManifest.commit ?? ''), 'scan manifest: bad schema or commit');
  need(scanManifest.scope_sha256 === sha256(scopeBytes), 'scan manifest was produced for a different scope file');
  need(JSON.stringify(scanManifest.files) === JSON.stringify(inventoryTriples(inventory)),
    `scoped bytes at HEAD differ from the bytes scanned at ${scanManifest.commit}; rescan (scripts/release-security-scan.mjs) at the current commit`);
  git('merge-base', '--is-ancestor', scanManifest.commit, 'HEAD');

  const projectedPaths = new Set(o.has('--projected-file')
    ? readFileSync(o.get('--projected-file'), 'utf8').split('\n').filter(Boolean)
    : inventory.filter(file => file.kind === 'source').map(file => file.path));
  const { sarifBytes, receiptBytes, receipt, results } = loadScanEvidence(o, projectedPaths);
  need(receipt.manifest_sha256 === sha256(scanManifestBytes), 'receipt.manifest_sha256 does not match the scan manifest file');
  const adjudications = loadAdjudications(o.get('--adjudications-file'));
  const { policy, blobs } = buildPolicy({ packageName: pkg.name, version, group: manifest.release_group, releaseTask: manifest.release_task,
    manifestBytes, inventory, projectedPaths, sarifBytes, receiptBytes, scopeBytes, results, adjudications });
  for (const blob of blobs) {
    const name = `release/security/${version}/blobs/${blob.sha256}`;
    need(owned.has(name), `blob not listed in the manifest under the release task (run "blobs", commit, then "manifest"): ${name}`);
    let committed;
    try { committed = headFile(git, name); } catch { fail(`blob not committed at HEAD: ${name}`); }
    need(committed.equals(blob.bytes), `committed blob differs from input: ${name}`);
  }
  const listed = [...owned].filter(name => name.startsWith(`release/security/${version}/blobs/`));
  for (const name of listed) if (!blobs.some(blob => name.endsWith(blob.sha256))) console.log(`note: committed blob not referenced by this policy: ${name}`);
  const policyBytes = serialize(policy);
  // The gate parses policy, package.json, lock, scope, receipt and SARIF under one value budget,
  // and caps the security input total at 64 MiB.
  const budget = { records: 0 };
  for (const bytes of [policyBytes, headFile(git, 'package.json'), headFile(git, 'package-lock.json'), scopeBytes, receiptBytes, sarifBytes]) {
    strictJSON(bytes, budget);
  }
  const total = policyBytes.length + manifestBytes.length + inventory.reduce((sum, file) => sum + file.bytes, 0) +
    blobs.reduce((sum, blob) => sum + blob.bytes.length, 0);
  need(total <= MAX_QUEUE, 'security input total exceeds the gate limit of 64 MiB');
  const out = prepareOut(o.get('--out'));
  writeFileSync(out('policy.json'), policyBytes);
  console.log(`HEAD ${head}; scanned ${scanManifest.commit}; inventory=${inventory.length} findings=${results.length} evidence=${blobs.length}`);
  console.log(`policy sha256 (candidate RELEASE_SECURITY_POLICY_SHA256, for maintainer review): ${sha256(policyBytes)}`);
  console.log(`commit policy.json unchanged as release/security/${version}/policy.json`);
  console.log('needs: maintainer review of the exact policy bytes, then the reviewed literal pin in .github/workflows/release.yml');
}

export const USAGE = `usage: scripts/release-evidence.mjs <command> ...
  ownership --repo <abs> --version X.Y.Z --base-tag vA.B.C --release-task N
            [--commit-tasks-file <json>] [--resolutions-file <json>] --out <abs dir>
  blobs     --version X.Y.Z --scope-file <json> --sarif-file <sarif> --receipt-file <json>
            --adjudications-file <json> --out <abs dir>
  manifest  (ownership flags) --dispositions-file <json>
  policy    --repo <abs> --version X.Y.Z --scope-file <json> --sarif-file <sarif> --receipt-file <json>
            --scan-manifest-file <json> --adjudications-file <json> [--projected-file <txt>] --out <abs dir>`;

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'ownership') return ownershipCommand(rest);
  if (command === 'blobs') return blobsCommand(rest);
  if (command === 'manifest') return manifestCommand(rest);
  if (command === 'policy') return policyCommand(rest);
  fail(USAGE);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`release-evidence refused: ${error instanceof EvidenceError ? error.message : 'unexpected input or I/O failure'}`);
    process.exitCode = 1;
  }
}
