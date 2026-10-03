/** FINDING 1, retest against the intended replacement API (jt1179ka-v2).
 *
 * `modelEffortTarget(model, effort)` is REMOVED; `workerTarget({cli, model, effort})` replaces
 * it. These are acceptance tests for the new API, not rewritten defect expectations: the old
 * oracle is preserved unchanged in output/r1-preserved and re-run in
 * output/r2-old-oracle-probe, where it fails to even link against the new bytes.
 *
 * STRUCTURAL REPRESENTATION ONLY. Accepting a tuple says nothing about model availability,
 * latest status, account access, or whether a CLI can transport that effort (#1148 owns the
 * transport). No test here selects a model, reaches a provider, or authorizes a paid call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { workerTarget, versionedModelId, KNOWN_ALIASES } from '../../dist/src/jev/contracts.js';
import {
  workerTargetInput, OBSERVED_WORKER_MODELS, WORKER_MODEL_NAMESPACES, SLASH_WORKER_MODELS,
  ROUTER_CLIS, PRICED_MODEL, trapAccessor, hiddenProperty,
} from './tc-support.mjs';

const refusal = (input) => {
  const result = workerTarget(input);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.reason;
};

/* ---------------------------------------------------------------- positive */

test('positive: FIXED — every worker model observed in the router caller is now expressible', () => {
  for (const model of OBSERVED_WORKER_MODELS) {
    const result = workerTarget(workerTargetInput({ model }));
    assert.equal(result.ok, true, `${model} -> ${result.ok ? '' : result.reason.code}`);
    assert.equal(result.value.model, model);
  }
});

test('positive: FIXED — the target carries the CLI, so a routing decision is representable', () => {
  for (const cli of ROUTER_CLIS) {
    const value = workerTarget(workerTargetInput({ cli }));
    assert.equal(value.ok, true, cli);
    assert.equal(value.value.cli, cli);
  }
  const target = workerTarget(workerTargetInput());
  assert.equal(target.ok, true);
  assert.deepEqual(Object.keys(target.value).sort(), ['cli', 'effort', 'model']);
});

test('positive: multiple worker model namespaces are accepted structurally', () => {
  for (const model of WORKER_MODEL_NAMESPACES) {
    const result = workerTarget(workerTargetInput({ model }));
    assert.equal(result.ok, true, `${model} -> ${result.ok ? '' : result.reason.code}`);
    assert.equal(result.value.model, model);
  }
});

test('positive: effort omission must be written out explicitly and is preserved', () => {
  const omitted = workerTarget(workerTargetInput({ effort: { kind: 'omitted' } }));
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted.value.effort, { kind: 'omitted' });
  assert.equal('level' in omitted.value.effort, false);

  // An absent effort is NOT an implied omission.
  const absent = workerTargetInput();
  delete absent.effort;
  const reason = refusal(absent);
  assert.equal(reason.path, '$.effort');
  assert.equal(reason.code, 'invalid-shape');
});

test('positive: a level effort is carried verbatim; the level is a token, not a fixed enum', () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'minimal', 'none', 'ultra-think', 'p9']) {
    const result = workerTarget(workerTargetInput({ effort: { kind: 'level', level } }));
    assert.equal(result.ok, true, level);
    assert.deepEqual(result.value.effort, { kind: 'level', level });
  }
  // Accepting a level is NOT evidence any CLI transports it. Asserted as a non-claim only.
});

test('the validated target and its effort are frozen', () => {
  const value = workerTarget(workerTargetInput());
  assert.equal(value.ok, true);
  assert.equal(Object.isFrozen(value.value), true);
  assert.equal(Object.isFrozen(value.value.effort), true);
});

/* ---------------------------------------- structural limitation, recorded as such */

test('LIMITATION: a worker model id containing "/" is refused by the structural pattern', () => {
  // Recorded as a present limitation of workerTarget, NOT as a compatibility guarantee and
  // NOT as a request to widen the pattern (widening is out of scope for this retest).
  for (const model of SLASH_WORKER_MODELS) {
    const reason = refusal(workerTargetInput({ model }));
    assert.equal(reason.code, 'invalid-value', model);
    assert.equal(reason.path, '$.model');
  }
  // Underscores ARE inside the pattern, so the limitation is specifically the path separator
  // (and whitespace), not punctuation in general.
  assert.equal(workerTarget(workerTargetInput({ model: 'model_name-1.2.3' })).ok, true);
  assert.equal(refusal(workerTargetInput({ model: 'a\\b' })).path, '$.model', 'backslash is also refused');
});

/* --------------------------------------------------- separation from the JEV id */

test('the JEV evaluator id restrictions are unchanged and remain a separate namespace', () => {
  assert.equal(versionedModelId(PRICED_MODEL, '$.model'), PRICED_MODEL);
  for (const alias of KNOWN_ALIASES) {
    assert.throws(() => versionedModelId(alias, '$.model'), /alias/i, alias);
  }
  assert.throws(() => versionedModelId('claude-opus-5[1m]', '$.model'), /versioned model id/);

  // And the two namespaces do not bleed: a JEV id is structurally valid as a worker model
  // token, which is exactly why the evaluator id is validated by its OWN checker everywhere
  // it matters (request, pricing, response) rather than by workerTarget.
  assert.equal(workerTarget(workerTargetInput({ model: PRICED_MODEL })).ok, true);
  assert.equal(workerTarget(workerTargetInput({ model: 'jev-latest' })).ok, true,
    'workerTarget is structural and does not know about JEV aliases');
});

/* ------------------------------------------------------------------ refusals */

test('cli must be a bounded lowercase token', () => {
  for (const cli of ['Claude', 'claude cli', 'claude/x', '', '-claude', 'c'.repeat(33), 42, null, undefined, {}]) {
    const reason = refusal(workerTargetInput({ cli }));
    assert.equal(reason.code, 'invalid-value', JSON.stringify(cli));
    assert.equal(reason.path, '$.cli');
  }
  assert.equal(workerTarget(workerTargetInput({ cli: 'c'.repeat(32) })).ok, true, '32 chars is the bound');
});

test('model must be a bounded token with no whitespace or control bytes', () => {
  for (const model of ['claude opus', 'claude\nopus', 'claude\topus', '-claude', '', 'm'.repeat(129),
    42, null, undefined, []]) {
    const reason = refusal(workerTargetInput({ model }));
    assert.equal(reason.code, 'invalid-value', JSON.stringify(model));
    assert.equal(reason.path, '$.model');
  }
  assert.equal(workerTarget(workerTargetInput({ model: `a${'b'.repeat(127)}` })).ok, true, '128 chars is the bound');
});

test('effort must be one of exactly two written kinds, and a level cannot ride on an omission', () => {
  assert.equal(refusal(workerTargetInput({ effort: { kind: 'omitted', level: 'high' } })).path, '$.effort.level');
  assert.equal(refusal(workerTargetInput({ effort: { kind: 'omitted', level: 'high' } })).code, 'invalid-value');
  assert.equal(refusal(workerTargetInput({ effort: { kind: 'level' } })).path, '$.effort.level');
  assert.equal(refusal(workerTargetInput({ effort: { kind: 'level', level: 'HIGH' } })).path, '$.effort.level');
  assert.equal(refusal(workerTargetInput({ effort: { kind: 'level', level: '' } })).path, '$.effort.level');
  for (const kind of ['default', '', 'LEVEL', null, 42]) {
    const reason = refusal(workerTargetInput({ effort: { kind, level: 'high' } }));
    assert.equal(reason.path, '$.effort.kind', String(kind));
    assert.equal(reason.code, 'invalid-value');
  }
  assert.equal(refusal(workerTargetInput({ effort: null })).code, 'invalid-shape');
  assert.equal(refusal(workerTargetInput({ effort: 'high' })).code, 'invalid-shape');
});

test('unknown fields on the target and on effort are refused at the parent path, never echoed', () => {
  const outer = refusal(workerTargetInput({ 'zz-unknown-key': 1 }));
  assert.equal(outer.code, 'unknown-field');
  assert.equal(outer.path, '$');
  assert.equal(outer.message, 'Unexpected field');

  const inner = refusal(workerTargetInput({ effort: { kind: 'level', level: 'high', 'zz-unknown-key': 1 } }));
  assert.equal(inner.code, 'unknown-field');
  assert.equal(inner.path, '$.effort');
  assert.equal(inner.path.includes('zz-unknown-key'), false);
});

test('hostile carrier shapes are refused without invoking any getter', () => {
  const accessor = workerTargetInput();
  delete accessor.model;
  const modelReads = trapAccessor(accessor, 'model');
  const byAccessor = refusal(accessor);
  assert.equal(byAccessor.code, 'invalid-shape');
  assert.equal(byAccessor.path, '$');
  assert.equal(modelReads(), 0, 'the getter must never run');

  const nested = workerTargetInput({ effort: { kind: 'level' } });
  const levelReads = trapAccessor(nested.effort, 'level');
  const byNested = refusal(nested);
  assert.equal(byNested.code, 'invalid-shape');
  assert.equal(byNested.path, '$.effort');
  assert.equal(levelReads(), 0);
});

test('reserved, symbol, inherited, non-enumerable and non-plain carriers are refused', () => {
  assert.equal(refusal(JSON.parse('{"cli":"claude","model":"m","effort":{"kind":"omitted"},"__proto__":{"x":1}}')).code,
    'reserved-key');
  const symbolic = workerTargetInput();
  symbolic[Symbol('marker')] = 1;
  assert.equal(refusal(symbolic).code, 'invalid-shape');

  const inherited = Object.create({ effort: { kind: 'omitted' } });
  Object.assign(inherited, { cli: 'claude', model: 'claude-opus-5[1m]' });
  assert.equal(refusal(inherited).code, 'invalid-shape', 'a non-Object.prototype carrier is refused');

  const hidden = hiddenProperty(workerTargetInput(), 'model', 'claude-opus-5[1m]');
  delete hidden.model;
  hiddenProperty(hidden, 'model', 'claude-opus-5[1m]');
  assert.equal(refusal(hidden).code, 'invalid-shape', 'a non-enumerable own property is refused');

  class Forged { constructor() { Object.assign(this, workerTargetInput()); } }
  assert.equal(refusal(new Forged()).code, 'invalid-shape');
  assert.equal(refusal([workerTargetInput()]).code, 'invalid-shape');
  assert.equal(refusal(null).code, 'invalid-shape');
  assert.equal(refusal(undefined).code, 'invalid-shape');
});

test('a TypeScript cast is not authority: a forged plain object is still refused at runtime', () => {
  // The .d.ts says WorkerTarget has readonly fields; JS can hand over anything.
  const forged = { cli: 'CLAUDE', model: 'anthropic/claude-opus-5', effort: { kind: 'implied' } };
  const reason = refusal(forged);
  assert.equal(reason.ok, undefined);
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.cli', 'refused on the first structural violation, in field order');
});
