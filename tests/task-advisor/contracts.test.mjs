import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Test-only transpilation, never a package build or an independent type check.
// Every emitted fixture and manifest is retained in the authorized evidence path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = join(root, 'src/task-advisor/contracts.ts');
const source = readFileSync(sourcePath, 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceHash = sha256(source);
assert.equal(sourceHash, '08600eb7b5b82ee21c37b8e608f2ea3f41e1d2491d4e0b993e7924ce8dab6ab2', 'Frozen source changed; obtain a new reviewed fixture');
const require = createRequire(import.meta.url);
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, strict: true };
const compiled = ts.transpileModule(source, { compilerOptions, fileName: sourcePath, reportDiagnostics: true });
assert.deepEqual(compiled.diagnostics, [], 'Test fixture transpile diagnostics');
const evidenceDir = mkdtempSync(join(root, '.aigentry-report-av1161/run-'));
const emittedPath = join(evidenceDir, 'contracts.fixture.mjs');
writeFileSync(emittedPath, compiled.outputText, { flag: 'wx' });
const metadata = {
  task: 1161, sid: 'av1161-tester', operation: 'av1161-v1',
  attempt: process.env.AIGENTRY_WORKER_ATTEMPT ?? null,
  node: process.version, typescript: ts.version, compilerOptions,
  compilerOptionNames: { target: 'ES2022', module: 'ES2022', strict: true },
  sourcePath, sourceHash, testHash: sha256(readFileSync(fileURLToPath(import.meta.url))),
  emittedHash: sha256(compiled.outputText), startedAt: new Date().toISOString(),
  limitation: 'transpileModule only; no independent type-check, package build, host/runtime/authority verification',
};
writeFileSync(join(evidenceDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
console.log(`EVIDENCE ${evidenceDir}`);
const api = await import(pathToFileURL(emittedPath).href);
const { LIMITS: L } = api;
const clone = value => structuredClone(value);
const W = 'a'.repeat(64);
const D = 'b'.repeat(64);
const E = 'c'.repeat(64);
const now = '2026-09-13T00:00:00.000Z';
const time = offset => new Date(Date.parse(now) + offset).toISOString();
const id = n => `abcdefab-cdef-4abc-8abc-${n.toString(16).padStart(12, '0')}`;
const ctx = () => ({ workspaceId: W, now, taskIds: ['owner', 'task-a', 'task-b'] });
const proposal = () => ({
  id: id(1), schemaVersion: 1, revision: 1, workspaceId: W,
  ownerTaskId: 'owner', relatedTaskIds: ['task-b'], kind: 'prioritize-existing-task',
  title: 'Prioritize existing task', recommendation: 'Review task-a before task-b',
  scope: { taskIds: ['task-a'], paths: ['src/a.ts'] }, createdAt: now, expiresAt: time(L.evidenceTtlMs),
  state: 'pending', dedupKey: D, evidenceDigest: E,
  provenance: {
    producer: 'task-advisor', packageVersion: '1.0.0', sourceRevision: null,
    algorithmVersion: 'local-ranking-v1', runId: id(2), trigger: 'manual', observedAt: now,
    queueDigest: D, coverage: { totalTasks: 3, consideredTasks: 3, complete: true },
    evidence: [{ source: 'task-queue', locator: 'task-a', digest: D, observedAt: now, fact: 'Existing blocked task' }],
  },
  benefit: { summary: 'Unblock work', basis: 'Dependency evidence' },
  risk: { summary: 'Review required', basis: 'Local evidence only' },
  cost: { summary: 'One local analysis', basis: 'Bounded snapshot', analysis: { localOnly: true, chargedRun: 1 },
    execution: { estimate: null, uncertainty: 'Human review required' } },
  currentness: { status: 'current', checkedAt: now, reason: 'Observed snapshot' },
  admissionBoundary: { requires: 'explicit-human-admission', requestDigest: E,
    executionAuthorized: false, loopActivationAuthorized: false }, disposition: null,
});
const decision = () => ({ id: id(3), proposalId: id(1), proposalRevision: 1, requestId: id(4),
  kind: 'reject', reason: 'Not now', until: null, actor: { id: 'untrusted-text', verified: false }, at: now });
const receipt = () => ({ id: id(5), requestId: id(6), proposalId: id(1), proposalRevision: 1,
  requestDigest: E, taskId: 'task-a', authorityRef: 'untrusted receipt text', committedAt: now });
function store(state = 'pending') {
  const s = api.createDefaultStore(ctx()).value;
  s.revision = 1;
  s.proposals = [proposal()];
  const p = s.proposals[0];
  p.state = state;
  if (state === 'rejected' || state === 'deferred') {
    const d = decision();
    if (state === 'deferred') { d.kind = 'defer'; d.until = time(60_000); }
    s.decisions = [d];
    p.disposition = { decisionId: d.id, reason: d.reason, deferredUntil: d.until };
  }
  if (state === 'admitted') s.admissionReceipts = [receipt()];
  return s;
}
function reserved() {
  const s = store();
  s.budget.chargedRuns = 1;
  s.budget.lastStartedAt = now;
  s.run = { id: id(7), ownerPid: 1, startedAt: now, configRevision: 0, snapshotDigest: D, status: 'reserved' };
  return s;
}
const manifest = [];
function check(name, category, body) {
  const row = { name, category, status: 'registered' };
  manifest.push(row);
  test(name, () => {
    const start = performance.now();
    try { body(); row.status = 'passed'; }
    catch (error) { row.status = 'failed'; row.error = error.stack; throw error; }
    finally { row.durationMs = performance.now() - start; }
  });
}
after(() => {
  writeFileSync(join(evidenceDir, 'cases.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  assert.equal(sha256(readFileSync(sourcePath)), sourceHash, 'Production source must remain unchanged');
});
function accepted(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'value']);
  return result.value;
}
function refused(result, code, path) {
  assert.equal(result.ok, false, `Expected atomic refusal, got ${JSON.stringify(result).slice(0, 600)}`);
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
  assert.deepEqual(Object.keys(result.reason).sort(), ['code', 'message', 'path']);
  assert.equal(typeof result.reason.message, 'string');
  assert.ok(result.reason.message.length > 0);
  if (code) assert.equal(result.reason.code, code);
  if (path) assert.equal(result.reason.path, path);
}
function unchanged(input, action) {
  const before = clone(input);
  const result = action();
  assert.deepEqual(input, before, 'Input must not change');
  return result;
}
function mutate(name, factory, validator, change, code, path, category = 'single-fault') {
  check(name, category, () => {
    const input = factory();
    const binding = ctx();
    accepted(validator(input, binding)); // Positive control precedes each mutation.
    change(input);
    refused(unchanged(input, () => validator(input, binding)), code, path);
  });
}
const validators = [
  ['config', api.createDefaultConfig, api.validateConfig],
  ['proposal', proposal, api.validateProposal],
  ['decision', decision, api.validateDecision],
  ['receipt', receipt, api.validateReceipt],
  ['store', reserved, api.validateStore],
];

check('exports: runtime surface measured from frozen module', 'surface', () => {
  assert.deepEqual(Object.keys(api).sort(), ['LIMITS', 'createDefaultConfig', 'createDefaultStore',
    'validateAnalysisInput', 'validateConfig', 'validateDecision', 'validateProposal', 'validateReceipt', 'validateStore'].sort());
  assert.equal(Object.isFrozen(L), true);
  const ast = ts.createSourceFile('contracts.ts', source, ts.ScriptTarget.ES2022, true);
  const exports = ast.statements.filter(s => s.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
  const names = exports.flatMap(s => s.name ? [s.name.text] : s.declarationList.declarations.map(d => d.name.text));
  writeFileSync(join(evidenceDir, 'source-exports.json'), JSON.stringify(names, null, 2) + '\n', { flag: 'wx' });
  const imports = ast.statements.filter(s => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
  assert.equal(imports.length, 0, 'Frozen pure source has no imports');
});
check('defaults: missing config and store are ON and independently detached', 'defaults', () => {
  const a = api.createDefaultConfig();
  assert.equal(a.enabled, true);
  assert.equal(a.origin, 'default');
  assert.deepEqual(accepted(api.validateConfig(undefined)), a);
  const b = accepted(api.createDefaultStore(ctx()));
  assert.deepEqual(accepted(api.validateStore(undefined, ctx())), b);
  assert.deepEqual(b.config, a);
  a.enabled = false;
  b.config.enabled = false;
  b.proposals.push({});
  assert.equal(api.createDefaultConfig().enabled, true);
  assert.equal(accepted(api.createDefaultStore(ctx())).proposals.length, 0);
});
check('defaults: explicit user-disabled preference survives repeated validation', 'defaults', () => {
  const s = store();
  s.config.enabled = false;
  s.config.origin = 'user';
  for (let i = 0; i < 3; i++) {
    assert.equal(accepted(api.validateConfig(s.config)).enabled, false);
    assert.equal(accepted(api.validateStore(s, ctx())).config.enabled, false);
  }
});
for (const [label, factory, validate] of validators) {
  check(`${label}: valid returned tree is detached and input unchanged`, 'detachment', () => {
    const input = factory();
    const value = accepted(unchanged(input, () => validate(input, ctx())));
    assert.deepEqual(value, input);
    function detached(a, b) {
      if (a === null || typeof a !== 'object') return;
      assert.notEqual(a, b);
      for (const k of Object.keys(a)) detached(a[k], b[k]);
    }
    detached(value, input);
  });
  for (const [kind, bad] of [['null', null], ['array', []], ['boolean', false], ['number', 1], ['text', 'x']]) {
    check(`${label}: malformed root ${kind} refuses atomically`, 'shape', () => {
      accepted(validate(factory(), ctx()));
      refused(validate(bad, ctx()), 'invalid-shape');
    });
  }
  mutate(`${label}: unknown root field`, factory, validate, x => { x.extra = true; }, 'unknown-field', '$.extra');
  // Traverse the valid schema fixture: each missing required field and each
  // unexpected nested field has its own positive control and manifest entry.
  function walk(value, path = []) {
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value)) {
      if (path.length) mutate(`${label}: unknown field at ${path.join('.')}`, factory, validate, x => {
        for (const k of path) x = x[k];
        x.extra = true;
      }, 'unknown-field');
      for (const key of Object.keys(value)) {
        mutate(`${label}: missing ${[...path, key].join('.')}`, factory, validate, x => {
          for (const k of path) x = x[k];
          delete x[key];
        });
      }
    }
    for (const k of Object.keys(value)) walk(value[k], [...path, k]);
  }
  walk(factory());
}
for (const value of [0, 2, '1', null]) {
  mutate(`proposal: unsupported schemaVersion ${JSON.stringify(value)}`, proposal, api.validateProposal,
    x => { x.schemaVersion = value; }, 'unknown-version', '$.schemaVersion');
  mutate(`store: unsupported schemaVersion ${JSON.stringify(value)}`, store, api.validateStore,
    x => { x.schemaVersion = value; }, 'unknown-version', '$.schemaVersion');
}

const boundedConfig = [
  ['maxTasks', L.tasks], ['maxRunsPerUtcDay', L.runsPerUtcDay], ['maxCpuWallMs', L.cpuWallMs],
  ['maxProposalsPerRun', L.proposalsPerRun], ['maxStoreBytes', L.storeBytes],
];
for (const [field, max] of boundedConfig) {
  for (const n of [0, max]) check(`config: ${field} accepts ${n}`, 'integer-boundary', () => {
    const c = api.createDefaultConfig(); c[field] = n; accepted(api.validateConfig(c));
  });
  mutate(`config: ${field} exceeds ${max}`, api.createDefaultConfig, api.validateConfig,
    x => { x[field] = max + 1; }, 'invalid-value', `$.${field}`);
}
for (const field of ['revision', 'maxInputBytes', 'minIntervalMs']) {
  for (const n of [0, Number.MAX_SAFE_INTEGER]) check(`config: ${field} safe integer ${n}`, 'integer-boundary', () => {
    const c = api.createDefaultConfig(); c[field] = n; accepted(api.validateConfig(c));
  });
}
for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', true, null]) {
  for (const [label, factory, validate, field] of [
    ['config', api.createDefaultConfig, api.validateConfig, 'revision'],
    ['proposal', proposal, api.validateProposal, 'revision'],
    ['decision', decision, api.validateDecision, 'proposalRevision'],
    ['receipt', receipt, api.validateReceipt, 'proposalRevision'],
    ['store', store, api.validateStore, 'revision'],
  ]) mutate(`${label}: unsafe integer ${JSON.stringify(bad)}`, factory, validate, x => { x[field] = bad; }, 'invalid-value');
}
for (const n of [1, L.minIntervalMs - 1]) mutate(`config: forbidden interval ${n}`, api.createDefaultConfig,
  api.validateConfig, x => { x.minIntervalMs = n; }, 'invalid-value', '$.minIntervalMs');
mutate('config: disabled requires user origin', api.createDefaultConfig, api.validateConfig,
  x => { x.enabled = false; }, 'invalid-value', '$.origin');
for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) mutate(`run: invalid ownerPid ${n}`, reserved,
  api.validateStore, x => { x.run.ownerPid = n; }, 'invalid-value');

for (const stamp of ['2024-02-29T00:00:00Z', '2000-02-29T23:59:59+00:00', '2026-09-13T00:00:00.1Z',
  '2026-09-13T00:00:00.123456789Z', '0000-01-01T00:00:00Z']) {
  check(`context: valid UTC calendar ${stamp}`, 'timestamp', () => {
    accepted(api.createDefaultStore({ ...ctx(), now: stamp }));
    const d = decision(); d.at = stamp; accepted(api.validateDecision(d, ctx()));
  });
}
for (const stamp of ['2023-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-04-31T00:00:00Z',
  '2026-13-01T00:00:00Z', '2026-09-13T24:00:00Z', '2026-09-13T00:60:00Z', '2026-09-13T00:00:60Z',
  '2026-09-13T00:00:00+09:00', '2026-09-13T00:00:00-00:00', '2026-09-13',
  '2026-09-13T00:00:00', '2026-09-13T00:00:00.1234567890Z', '2026-09-13t00:00:00z']) {
  check(`context: invalid UTC calendar ${stamp}`, 'timestamp', () => {
    refused(api.createDefaultStore({ ...ctx(), now: stamp }), 'invalid-value', '$context.now');
  });
  mutate(`decision: invalid timestamp ${stamp}`, decision, api.validateDecision,
    x => { x.at = stamp; }, 'invalid-value', '$.at');
}
for (const day of ['2023-02-29', '2026-04-31', '2026-00-01', '2026-09-13Z']) {
  mutate(`store: invalid budget day ${day}`, store, api.validateStore, x => { x.budget.utcDay = day; }, 'invalid-value');
}
for (const [label, factory, validate] of validators.filter(([label]) => label !== 'config')) {
  for (const [name, change, code] of [
    ['workspace malformed', c => { c.workspaceId = 'A'.repeat(64); }, 'invalid-value'],
    ['now missing', c => { delete c.now; }, 'invalid-value'],
    ['task set null', c => { c.taskIds = null; }, 'invalid-shape'],
    ['task set duplicate', c => { c.taskIds.push('owner'); }, 'duplicate-id'],
    ['task set over list limit', c => { c.taskIds = Array.from({ length: L.list + 1 }, (_, i) => `t${i}`); }, 'input-limit'],
  ]) check(`${label}: context ${name}`, 'context', () => {
    const binding = ctx(); accepted(validate(factory(), binding)); change(binding);
    refused(validate(factory(), binding), code);
  });
}
for (const [label, factory, validate] of [['proposal', proposal, api.validateProposal], ['store', store, api.validateStore]]) {
  check(`${label}: mismatched workspace rejected`, 'references', () => {
    accepted(validate(factory(), ctx())); refused(validate(factory(), { ...ctx(), workspaceId: D }), 'workspace-mismatch');
  });
  for (const missing of ['owner', 'task-a', 'task-b']) check(`${label}: complete task set missing ${missing}`, 'references', () => {
    accepted(validate(factory(), ctx()));
    refused(validate(factory(), { ...ctx(), taskIds: ctx().taskIds.filter(t => t !== missing) }), 'missing-reference');
  });
  check(`${label}: omitted references allow historical task IDs`, 'history', () => {
    accepted(validate(factory(), { workspaceId: W, now }));
  });
  check(`${label}: empty complete reference set rejects`, 'references', () => {
    refused(validate(factory(), { ...ctx(), taskIds: [] }), 'missing-reference');
  });
}
check('receipt: complete task reference set enforced', 'references', () => {
  accepted(api.validateReceipt(receipt(), ctx()));
  refused(api.validateReceipt(receipt(), { ...ctx(), taskIds: ['owner'] }), 'missing-reference', '$.taskId');
  accepted(api.validateReceipt(receipt(), { workspaceId: W, now }));
});

for (const [field, max] of [['title', L.text], ['ownerTaskId', L.shortText]]) {
  for (const text of ['a'.repeat(max), '😀'.repeat(max / 2)]) check(`proposal: ${field} exact UTF16 limit ${text.charCodeAt(0)}`, 'text-boundary', () => {
    const p = proposal(); p[field] = text;
    accepted(api.validateProposal(p, { workspaceId: W, now }));
  });
  for (const text of ['', ' \t\n', 'a'.repeat(max + 1)]) {
    check(`proposal: ${field} invalid length ${text.length}`, 'text-boundary', () => {
      const p = proposal(); accepted(api.validateProposal(p, ctx())); p[field] = text;
      refused(api.validateProposal(p, ctx()), text.length > max ? 'input-limit' : 'invalid-value');
    });
  }
}
check('proposal: scope path exact 4096 characters', 'text-boundary', () => {
  const p = proposal(); p.scope.paths = ['x'.repeat(4096)]; accepted(api.validateProposal(p, ctx()));
});
mutate('proposal: scope path 4097 characters', proposal, api.validateProposal,
  p => { p.scope.paths = ['x'.repeat(4097)]; }, 'input-limit');
for (const value of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
  mutate(`proposal: malformed evidence SHA256 ${value.slice(0, 1)} length ${value.length}`, proposal,
    api.validateProposal, p => { p.evidenceDigest = value; }, 'invalid-value');
}
for (const value of ['not-uuid', 'abcdefab-cdef-0abc-8abc-000000000001', 'abcdefab-cdef-9abc-8abc-000000000001',
  'abcdefab-cdef-4abc-7abc-000000000001']) {
  mutate(`proposal: malformed UUID ${value}`, proposal, api.validateProposal, p => { p.id = value; }, 'invalid-value');
}
for (const version of [1, 8]) check(`proposal: UUID version ${version} upper case is structural`, 'identifiers', () => {
  const p = proposal(); p.id = p.id.replace('-4abc-', `-${version}abc-`).toUpperCase();
  accepted(api.validateProposal(p, ctx()));
});
for (const field of ['relatedTaskIds', 'scope.taskIds', 'scope.paths']) {
  mutate(`proposal: duplicate ${field}`, proposal, api.validateProposal, p => {
    const parts = field.split('.'); const object = parts.length === 2 ? p[parts[0]] : p;
    object[parts.at(-1)].push(object[parts.at(-1)][0]);
  }, 'duplicate-id');
}
for (const count of [L.list, L.list + 1]) check(`proposal: task list length ${count}`, 'list-boundary', () => {
  const p = proposal(); p.relatedTaskIds = Array.from({ length: count }, (_, i) => `t${i}`);
  const r = api.validateProposal(p, { workspaceId: W, now });
  if (count === L.list) accepted(r); else refused(r, 'input-limit');
});

for (const [name, change, code] of [
  ['TTL zero', p => { p.expiresAt = now; }, 'invalid-value'],
  ['TTL negative', p => { p.expiresAt = time(-1); }, 'invalid-value'],
  ['TTL above seven days', p => { p.expiresAt = time(L.maxEvidenceTtlMs + 1); }, 'invalid-value'],
  ['observation after creation', p => { p.provenance.observedAt = time(1); }, 'invalid-value'],
  ['evidence observed after creation', p => { p.provenance.evidence[0].observedAt = time(1); }, 'invalid-value'],
  ['evidence snapshot mismatch', p => { p.provenance.evidence[0].digest = E; }, 'invalid-value'],
  ['incomplete coverage', p => { p.provenance.coverage.complete = false; }, 'invalid-value'],
  ['coverage counts disagree', p => { p.provenance.coverage.consideredTasks = 2; }, 'invalid-value'],
  ['coverage above task ceiling', p => { p.provenance.coverage.totalTasks = L.tasks + 1; }, 'invalid-value'],
  ['empty scope', p => { p.scope.taskIds = []; }, 'invalid-value'],
  ['empty evidence', p => { p.provenance.evidence = []; }, 'invalid-value'],
  ['pending has disposition', p => { p.disposition = { decisionId: id(3), reason: 'x', deferredUntil: null }; }, 'invalid-value'],
  ['rejected lacks disposition', p => { p.state = 'rejected'; }, 'missing-reference'],
  ['deferred lacks disposition', p => { p.state = 'deferred'; }, 'missing-reference'],
  ['execution authorization true', p => { p.admissionBoundary.executionAuthorized = true; }, 'invalid-value'],
  ['Loop activation true', p => { p.admissionBoundary.loopActivationAuthorized = true; }, 'invalid-value'],
  ['remote analysis', p => { p.cost.analysis.localOnly = false; }, 'invalid-value'],
  ['analysis uncharged', p => { p.cost.analysis.chargedRun = 0; }, 'invalid-value'],
  ['analysis charged twice', p => { p.cost.analysis.chargedRun = 2; }, 'invalid-value'],
  ['executable proposal kind', p => { p.kind = 'execute-task'; }, 'invalid-value'],
  ['unknown currentness', p => { p.currentness.status = 'fresh'; }, 'invalid-value'],
]) mutate(`proposal: ${name}`, proposal, api.validateProposal, change, code);
for (const delta of [1, L.maxEvidenceTtlMs]) check(`proposal: TTL exact valid boundary ${delta}`, 'ttl', () => {
  const p = proposal(); p.expiresAt = time(delta); accepted(api.validateProposal(p, ctx()));
});
for (const status of ['current', 'stale', 'unknown']) check(`history: ${status} expired pending stays structurally readable`, 'history', () => {
  const p = proposal(); p.currentness.status = status;
  const binding = { ...ctx(), now: time(L.maxEvidenceTtlMs * 2) };
  assert.equal(accepted(api.validateProposal(p, binding)).state, 'pending');
  const s = store(); s.proposals = [p]; accepted(api.validateStore(s, binding));
});
for (const state of ['pending', 'stale', 'rejected', 'deferred', 'admitted']) {
  check(`store: positive ${state} history has no executable authorization`, 'history', () => {
    const input = store(state);
    const value = accepted(api.validateStore(input, { ...ctx(), now: time(L.maxDeferMs * 2) }));
    assert.equal(value.proposals[0].admissionBoundary.executionAuthorized, false);
    assert.equal(value.proposals[0].admissionBoundary.loopActivationAuthorized, false);
  });
}
const deferral = () => { const d = decision(); d.kind = 'defer'; d.until = time(1); return d; };
for (const delta of [1, L.maxDeferMs]) check(`decision: valid defer duration ${delta}`, 'deferral', () => {
  const d = deferral(); d.until = time(delta); accepted(api.validateDecision(d, ctx()));
});
for (const delta of [null, -1, 0, L.maxDeferMs + 1]) mutate(`decision: invalid defer duration ${delta}`, deferral,
  api.validateDecision, d => { d.until = delta === null ? null : time(delta); }, 'invalid-value', '$.until');
mutate('decision: rejection has no expiry', decision, api.validateDecision,
  d => { d.until = time(1); }, 'invalid-value', '$.until');
mutate('decision: approval is not an available kind', decision, api.validateDecision,
  d => { d.kind = 'approve'; }, 'invalid-value');

for (const [name, factory, change, code] of [
  ['future config revision', store, s => { s.config.revision = 2; }, 'invalid-value'],
  ['future run config revision', reserved, s => { s.run.configRevision = 1; }, 'invalid-value'],
  ['reservation missing charge', reserved, s => { s.budget.chargedRuns = 0; }, 'invalid-value'],
  ['reservation mismatched start', reserved, s => { s.budget.lastStartedAt = time(1); }, 'invalid-value'],
  ['reservation missing start', reserved, s => { s.budget.lastStartedAt = null; }, 'invalid-value'],
  ['reservation mismatched day', reserved, s => { s.budget.utcDay = '2026-09-12'; }, 'invalid-value'],
  ['negative charge', reserved, s => { s.budget.chargedRuns = -1; }, 'invalid-value'],
  ['unsafe charge', reserved, s => { s.budget.chargedRuns = Number.MAX_SAFE_INTEGER + 1; }, 'invalid-value'],
  ['duplicate proposal UUID case', store, s => { const p = clone(s.proposals[0]); p.id = p.id.toUpperCase(); p.dedupKey = W; s.proposals.push(p); }, 'duplicate-id'],
  ['duplicate proposal dedup key', store, s => { const p = clone(s.proposals[0]); p.id = id(20); s.proposals.push(p); }, 'duplicate-id'],
  ['duplicate decision UUID case', () => store('rejected'), s => { const d = clone(s.decisions[0]); d.id = d.id.toUpperCase(); d.requestId = id(20); s.decisions.push(d); }, 'duplicate-id'],
  ['duplicate receipt UUID case', () => store('admitted'), s => { const r = clone(s.admissionReceipts[0]); r.id = r.id.toUpperCase(); r.requestId = id(20); s.admissionReceipts.push(r); }, 'duplicate-id'],
  ['decision request replay case', () => store('rejected'), s => { const d = clone(s.decisions[0]); d.id = id(20); d.requestId = d.requestId.toUpperCase(); s.decisions.push(d); }, 'duplicate-id'],
  ['receipt request replay case', () => store('admitted'), s => { const r = clone(s.admissionReceipts[0]); r.id = id(20); r.requestId = r.requestId.toUpperCase(); s.admissionReceipts.push(r); }, 'duplicate-id'],
  ['duplicate receipt proposal case', () => store('admitted'), s => { const r = clone(s.admissionReceipts[0]); r.id = id(20); r.requestId = id(21); r.proposalId = r.proposalId.toUpperCase(); s.admissionReceipts.push(r); }, 'duplicate-id'],
  ['decision missing proposal', () => store('rejected'), s => { s.decisions[0].proposalId = id(20); }, 'missing-reference'],
  ['decision future revision', () => store('rejected'), s => { s.decisions[0].proposalRevision = 2; }, 'invalid-value'],
  ['receipt missing proposal', () => store('admitted'), s => { s.admissionReceipts[0].proposalId = id(20); }, 'missing-reference'],
  ['receipt future revision', () => store('admitted'), s => { s.admissionReceipts[0].proposalRevision = 2; }, 'invalid-value'],
  ['receipt wrong digest', () => store('admitted'), s => { s.admissionReceipts[0].requestDigest = W; }, 'invalid-value'],
  ['receipt outside proposal scope', () => store('admitted'), s => { s.admissionReceipts[0].taskId = 'task-b'; }, 'invalid-value'],
  ['receipt absent task', () => store('admitted'), s => { s.admissionReceipts[0].taskId = 'absent'; }, 'missing-reference'],
  ['receipt target not admitted', () => store('admitted'), s => { s.proposals[0].state = 'pending'; }, 'invalid-value'],
  ['admitted missing receipt', () => store('admitted'), s => { s.admissionReceipts = []; }, 'missing-reference'],
  ['disposition missing decision', () => store('rejected'), s => { s.decisions = []; }, 'missing-reference'],
  ['disposition wrong decision ID', () => store('rejected'), s => { s.proposals[0].disposition.decisionId = id(20); }, 'missing-reference'],
  ['disposition wrong reason', () => store('rejected'), s => { s.proposals[0].disposition.reason = 'Different'; }, 'invalid-value'],
  ['disposition wrong expiry', () => store('deferred'), s => { s.proposals[0].disposition.deferredUntil = time(120_000); }, 'invalid-value'],
  ['deferred null expiry', () => store('deferred'), s => { s.proposals[0].disposition.deferredUntil = null; }, 'invalid-value'],
  ['rejected uses defer decision', () => store('deferred'), s => { s.proposals[0].state = 'rejected'; }, 'invalid-value'],
  ['deferred uses reject decision', () => store('rejected'), s => { s.proposals[0].state = 'deferred'; }, 'invalid-value'],
]) mutate(`store: ${name}`, factory, api.validateStore, change, code);
function twoReviewed() {
  const s = store('rejected');
  const other = clone(s.proposals[0]); other.id = id(30); other.dedupKey = W;
  const d = clone(s.decisions[0]); d.id = id(31); d.proposalId = other.id; d.requestId = id(32);
  other.disposition.decisionId = d.id; s.proposals.push(other); s.decisions.push(d);
  return s;
}
mutate('store: disposition references another existing proposal decision', twoReviewed, api.validateStore,
  s => { s.proposals[0].disposition.decisionId = s.decisions[1].id; }, 'missing-reference');
function mixedReviews() {
  const s = store('admitted'); s.decisions = [decision()]; return s;
}
mutate('store: request IDs unique across decision and receipt with UUID case', mixedReviews, api.validateStore,
  s => { s.decisions[0].requestId = s.admissionReceipts[0].requestId.toUpperCase(); }, 'duplicate-id', '$.requestId');
check('store: reference UUID case resolves for reviews and receipts', 'identifiers', () => {
  for (const state of ['rejected', 'admitted']) {
    const s = store(state);
    if (state === 'rejected') {
      s.decisions[0].proposalId = s.decisions[0].proposalId.toUpperCase();
      s.proposals[0].disposition.decisionId = s.proposals[0].disposition.decisionId.toUpperCase();
    } else s.admissionReceipts[0].proposalId = s.admissionReceipts[0].proposalId.toUpperCase();
    accepted(api.validateStore(s, ctx()));
  }
});
check('store: older review and receipt revisions remain historical-readable', 'history', () => {
  for (const state of ['rejected', 'admitted']) {
    const s = store(state); s.proposals[0].revision = 2; accepted(api.validateStore(s, ctx()));
  }
});
check('store: retained charge may exceed newly lowered configured daily limit', 'history', () => {
  const s = reserved(); s.config.maxRunsPerUtcDay = 0; accepted(api.validateStore(s, ctx()));
  s.run = null; accepted(api.validateStore(s, ctx()));
});

function byteSizedStore(target, character) {
  const s = store();
  const evidence = s.proposals[0].provenance.evidence;
  // Fill evidence facts, respecting text/list/depth/node bounds throughout.
  const byteSize = () => Buffer.byteLength(JSON.stringify(s), 'utf8');
  while (target - byteSize() > L.text * 4 + 1000) {
    evidence.push({ ...evidence[0], fact: character.repeat(Math.floor(L.text / character.length)) });
  }
  evidence.push({ ...evidence[0], fact: 'x' });
  const left = target - byteSize();
  const perEntry = L.text - 1;
  if (left > perEntry) {
    evidence.at(-1).fact += 'x'.repeat(perEntry);
    return finish();
  }
  evidence.at(-1).fact += 'x'.repeat(left);
  return s;
  function finish() {
    while (target - byteSize() > L.text + 300) evidence.push({ ...evidence[0], fact: 'x'.repeat(L.text) });
    evidence.push({ ...evidence[0], fact: 'x' });
    const remaining = target - byteSize();
    assert.ok(remaining >= 0 && remaining < L.text);
    evidence.at(-1).fact += 'x'.repeat(remaining);
    return s;
  }
}
for (const character of ['x', 'é', '😀']) {
  check(`store: serialized UTF8 configured ceiling exact and plus one ${character}`, 'byte-boundary', () => {
    const s = store(); s.proposals[0].title = character.repeat(100);
    // Four decimal digits make the configured ceiling a stable part of its own serialization.
    s.config.maxStoreBytes = 9999;
    s.config.maxStoreBytes = Buffer.byteLength(JSON.stringify(s));
    const size = Buffer.byteLength(JSON.stringify(s));
    assert.equal(s.config.maxStoreBytes, size);
    accepted(api.validateStore(s, ctx()));
    s.config.maxStoreBytes--;
    refused(api.validateStore(s, ctx()), 'input-limit');
  });
}
check('store: global 8MiB canonical UTF8 ceiling exact then one byte over', 'byte-boundary', () => {
  const s = byteSizedStore(L.storeBytes, '😀');
  assert.equal(Buffer.byteLength(JSON.stringify(s)), L.storeBytes);
  accepted(api.validateStore(s, ctx()));
  s.proposals[0].title += 'x';
  refused(api.validateStore(s, ctx()), 'input-limit', '$');
});
function nested(depth) { let x = 0; for (let i = 0; i < depth; i++) x = [x]; return x; }
for (const depth of [L.depth, L.depth + 1]) check(`JSON: exact depth ${depth}`, 'json-boundary', () => {
  // These roots intentionally fail schema after passing the generic JSON guard.
  // invalid-shape at the boundary versus input-limit above proves guard order.
  refused(api.validateConfig(nested(depth)), depth === L.depth ? 'invalid-shape' : 'input-limit');
});
function nodeSized(count) {
  const out = [];
  let remaining = count - 1;
  while (remaining > 1) {
    const leaves = Math.min(L.list, remaining - 1);
    out.push(Array(leaves).fill(0)); remaining -= leaves + 1;
  }
  if (remaining) out.push(0);
  return out;
}
for (const count of [L.nodes, L.nodes + 1]) check(`JSON: exact node count ${count}`, 'json-boundary', () => {
  const input = nodeSized(count);
  const countNodes = x => 1 + (Array.isArray(x) ? x.reduce((n, y) => n + countNodes(y), 0) : 0);
  assert.equal(countNodes(input), count);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < L.storeBytes);
  refused(api.validateConfig(input), count === L.nodes ? 'invalid-shape' : 'input-limit');
});
for (const count of [L.list, L.list + 1]) check(`JSON: object entry count ${count}`, 'json-boundary', () => {
  const input = Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}`, 0]));
  refused(api.validateConfig(input), count === L.list ? 'unknown-field' : 'input-limit');
});
for (const [name, factory] of [
  ['undefined child', () => ({ bad: undefined })], ['function child', () => ({ bad() {} })],
  ['BigInt', () => 1n], ['symbol', () => Symbol('x')], ['NaN', () => NaN], ['Infinity', () => Infinity],
  ['negative Infinity', () => -Infinity], ['Date', () => new Date(now)], ['Map', () => new Map()],
  ['typed array', () => new Uint8Array(1)], ['class instance', () => new (class X {})()],
]) check(`JSON: non-JSON ${name} is typed refusal`, 'json-shape', () => {
  refused(api.validateConfig(factory()), 'invalid-shape');
});
check('JSON: cycle terminates at depth bound', 'json-boundary', () => {
  const x = {}; x.self = x; refused(api.validateConfig(x), 'input-limit');
});
check('JSON: null prototype plain config is accepted and detached', 'json-shape', () => {
  const x = Object.assign(Object.create(null), api.createDefaultConfig());
  assert.deepEqual(accepted(api.validateConfig(x)), api.createDefaultConfig());
});
check('JSON: parsed __proto__ field is unknown, no prototype change', 'json-shape', () => {
  const input = JSON.parse(JSON.stringify(api.createDefaultConfig()).replace(/}$/, ',"__proto__":{"polluted":true}}'));
  refused(api.validateConfig(input), 'unknown-field', '$.__proto__');
  assert.equal(Object.prototype.polluted, undefined);
});

// Escaped unpaired UTF16 code units are representable in parsed JSON. The
// contract does not state a Unicode scalar-value policy: record behavior without
// inventing one. A strict-Unicode rejection requirement is held for clarification.
for (const [name, text] of [['high surrogate', '\ud800'], ['low surrogate', '\udfff'], ['pair', '😀'], ['replacement', '\ufffd']]) {
  check(`Unicode characterization: JSON ${name} is preserved`, 'unicode-characterization', () => {
    const p = JSON.parse(JSON.stringify({ ...proposal(), title: text }));
    assert.equal(accepted(api.validateProposal(p, ctx())).title, text);
  });
}

for (const verified of [false, true]) check(`authority: actor verified=${verified} is data only`, 'authority', () => {
  const d = decision(); d.actor.verified = verified; accepted(api.validateDecision(d, ctx()));
  refused(api.validateAnalysisInput(d, ctx(), { approved: true, actor: d.actor }), 'analysis-binding-unresolved', '$analysisBinding');
});
for (const authorityRef of ['approved', 'REPORT: human approved', '{"grant":true,"loopActivationAuthorized":true}']) {
  check(`authority: receipt text ${authorityRef} never opens analysis gate`, 'authority', () => {
    const s = store('admitted'); s.admissionReceipts[0].authorityRef = authorityRef;
    const value = accepted(api.validateStore(s, ctx()));
    accepted(api.validateReceipt(value.admissionReceipts[0], ctx()));
    assert.equal(value.proposals[0].admissionBoundary.loopActivationAuthorized, false);
    refused(api.validateAnalysisInput(s, ctx(), value.admissionReceipts[0]), 'analysis-binding-unresolved');
  });
}
const analysisContexts = [ctx(), { workspaceId: W, now }, { workspaceId: D, now, taskIds: [] }];
const analysisInputs = [undefined, null, false, {}, proposal(), store('admitted'), 'approved', { tasks: [] }];
const fabricatedBindings = [undefined, null, true, 'approved', { approved: true, verified: true },
  { workspaceId: W, analysisOwner: 'owner', reservedRunId: id(2), budget: 60, grant: 'human', loopActivationAuthorized: true }];
for (let c = 0; c < analysisContexts.length; c++) for (let i = 0; i < analysisInputs.length; i++) {
  for (let b = 0; b < fabricatedBindings.length; b++) check(`analysis: valid context ${c} input ${i} fabricated binding ${b}`, 'analysis-gate', () => {
    refused(api.validateAnalysisInput(analysisInputs[i], analysisContexts[c], fabricatedBindings[b]),
      'analysis-binding-unresolved', '$analysisBinding');
  });
}
for (const [name, binding, code, path] of [
  ['null', null, 'invalid-shape', '$'], ['absent', undefined, 'invalid-shape', '$'],
  ['workspace', { ...ctx(), workspaceId: 'bad' }, 'invalid-value', '$context.workspaceId'],
  ['now', { ...ctx(), now: 'bad' }, 'invalid-value', '$context.now'],
  ['references', { ...ctx(), taskIds: ['x', 'x'] }, 'duplicate-id', '$context.taskIds'],
]) check(`analysis: invalid context ${name} preserves context refusal`, 'analysis-gate', () => {
  refused(api.validateAnalysisInput({ approved: true }, binding, { approved: true }), code, path);
});
check('analysis: untrusted input and fabricated binding are not interpreted', 'analysis-gate', () => {
  const explosive = new Proxy({}, { get() { throw new Error('Unexpected property access'); }, ownKeys() { throw new Error('Unexpected enumeration'); } });
  refused(api.validateAnalysisInput(explosive, ctx(), explosive), 'analysis-binding-unresolved');
});

// Concrete malformed-array regression: unlike parsed JSON, holes do not denote
// a valid string. The pre-schema array traversal must not silently preserve them.
check('REGRESSION: sparse relatedTaskIds must not produce a successful typed string array', 'contract-regression', () => {
  const p = proposal(); const binding = { workspaceId: W, now };
  accepted(api.validateProposal(p, binding));
  p.relatedTaskIds = new Array(1);
  refused(api.validateProposal(p, binding), 'invalid-shape');
});
