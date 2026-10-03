/** buildEvaluationRequest: exact request contract, positive controls first.
 *
 * Runs against the real tsc output in ../../dist/src/jev (no fixture fallback).
 * Synthetic data only; no network, credential or call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEvaluationRequest, LIMITS } from '../../dist/src/jev/contracts.js';
import {
  requestInput, stateInput, noulQuestion, choiceQuestion, scoreQuestion, expectOk, PRICED_MODEL,
  trapAccessor, hiddenProperty, sparseArray,
} from './tc-support.mjs';

const refusal = (input) => {
  const result = buildEvaluationRequest(input);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.reason;
};

/* ---------------------------------------------------------------- positive */

test('positive: a full noul/choice/score request is accepted and the schema tag is injected', () => {
  const value = expectOk(buildEvaluationRequest(requestInput()));
  assert.equal(value.model, PRICED_MODEL);
  assert.equal(value.state.schema, 'aigentry.jev.route-state.v1');
  assert.equal(value.state.role, 'tester');
  assert.equal(value.state.candidates.length, 2);
  assert.deepEqual(Object.keys(value.questions).sort(), ['needs-shell', 'pick-worker', 'surface-size']);
  assert.equal(value.questions['needs-shell'].type, 'noul');
  assert.deepEqual(value.questions['needs-shell'].criteria, { true: 'Shell is required', false: 'No shell needed' });
  assert.deepEqual(value.questions['pick-worker'].criteria, { 'cand-a': 'General worker', 'cand-b': 'Read only worker' });
  assert.deepEqual(value.questions['surface-size'].criteria, ['Tiny', 'Moderate', 'Large']);
});

test('positive: the state carries no field for task text, path, cwd, env or credentials', () => {
  const value = expectOk(buildEvaluationRequest(requestInput()));
  assert.deepEqual(Object.keys(value.state).sort(), [
    'candidates', 'requires_shell', 'requires_web', 'requires_worktree',
    'role', 'schema', 'size_bucket', 'task_kind', 'touched_area_count',
  ]);
});

test('positive: noul criteria is genuinely optional when absent', () => {
  const input = requestInput({ questions: { only: { type: 'noul', instructions: 'Is it urgent?' } } });
  const value = expectOk(buildEvaluationRequest(input));
  assert.equal('criteria' in value.questions.only, false);
});

test('positive: boundary sizes at the documented limits are accepted', () => {
  const options = {};
  for (let index = 0; index < LIMITS.options; index += 1) options[`opt-${index}`] = `Option ${index}`;
  const levels = Array.from({ length: LIMITS.maxLevels }, (_value, index) => `Level ${index}`);
  const value = expectOk(buildEvaluationRequest(requestInput({
    questions: {
      wide: choiceQuestion({ criteria: options }),
      deep: scoreQuestion({ criteria: levels }),
      pair: scoreQuestion({ criteria: ['Low', 'High'] }),
    },
  })));
  assert.equal(Object.keys(value.questions.wide.criteria).length, LIMITS.options);
  assert.equal(value.questions.deep.criteria.length, LIMITS.maxLevels);
  assert.equal(value.questions.pair.criteria.length, LIMITS.minLevels);
});

/* ------------------------------------------------------- unknown / reserved */

test('unknown top-level, state and question fields are refused as unknown-field', () => {
  assert.equal(refusal({ ...requestInput(), stream: true }).code, 'unknown-field');
  assert.equal(refusal(requestInput({ state: stateInput({ cwd: '/tmp' }) })).code, 'unknown-field');
  assert.equal(refusal(requestInput({
    questions: { q: noulQuestion({ temperature: 0.2 }) },
  })).code, 'unknown-field');
});

test('a caller cannot override the injected schema tag', () => {
  const reason = refusal(requestInput({ state: stateInput({ schema: 'attacker.v1' }) }));
  assert.equal(reason.code, 'unknown-field');
  assert.equal(reason.path, '$.state');
});

test('reserved keys from parsed JSON are refused in closed shapes and open maps', () => {
  const proto = JSON.parse('{"model":"jev-1.13.0","__proto__":{"polluted":true},"state":{},"questions":{}}');
  assert.equal(refusal(proto).code, 'reserved-key');
  assert.equal(refusal(requestInput({
    questions: JSON.parse('{"q":{"type":"choice","instructions":"pick","criteria":{"a":"A","__proto__":"B"}}}'),
  })).code, 'reserved-key');
  assert.equal(refusal(requestInput({
    questions: JSON.parse('{"constructor":{"type":"noul","instructions":"x"}}'),
  })).code, 'reserved-key');
  assert.equal(Object.prototype.polluted, undefined, 'global prototype must be untouched');
});

test('symbol-keyed and non-plain-prototype objects are refused', () => {
  const symbolic = requestInput();
  symbolic[Symbol('marker')] = 1;
  assert.equal(refusal(symbolic).code, 'invalid-shape');

  class Forged { constructor() { Object.assign(this, requestInput()); } }
  assert.equal(refusal(new Forged()).code, 'invalid-shape');

  const nullProto = Object.assign(Object.create(null), requestInput());
  assert.equal(buildEvaluationRequest(nullProto).ok, true, 'null-prototype objects are accepted by design');

  assert.equal(refusal([requestInput()]).code, 'invalid-shape');
  assert.equal(refusal(null).code, 'invalid-shape');
});

/* ----------------------------------------------------- values and identifiers */

test('null is malformed input, never an absent optional field', () => {
  assert.equal(refusal(requestInput({ state: null })).code, 'invalid-shape');
  assert.equal(refusal(requestInput({ questions: { q: noulQuestion({ criteria: null }) } })).code, 'invalid-shape');
  assert.equal(refusal(requestInput({ state: stateInput({ requires_web: null }) })).code, 'invalid-value');
});

test('identifier discipline is enforced on ids, keys and capabilities', () => {
  for (const bad of ['Cand-A', 'cand a', 'cand/a', '-cand', 'cand-', '', 'a'.repeat(65)]) {
    const reason = refusal(requestInput({
      state: stateInput({ candidates: [{ id: bad, capabilities: ['read'], description: 'x y' }] }),
    }));
    assert.ok(['invalid-value', 'input-limit'].includes(reason.code), `${JSON.stringify(bad)} -> ${reason.code}`);
  }
  assert.equal(refusal(requestInput({ questions: { 'Bad Key': noulQuestion() } })).code, 'invalid-value');
  assert.equal(refusal(requestInput({
    state: stateInput({ candidates: [{ id: 'cand-a', capabilities: ['READ'], description: 'x y' }] }),
  })).code, 'invalid-value');
});

test('duplicate candidate ids and duplicate capabilities are refused', () => {
  assert.equal(refusal(requestInput({
    state: stateInput({
      candidates: [
        { id: 'cand-a', capabilities: ['read'], description: 'first' },
        { id: 'cand-a', capabilities: ['read'], description: 'second' },
      ],
    }),
  })).code, 'duplicate-id');
  assert.equal(refusal(requestInput({
    state: stateInput({ candidates: [{ id: 'cand-a', capabilities: ['read', 'read'], description: 'x' }] }),
  })).code, 'duplicate-id');
});

test('invalid numbers and types in the state are refused', () => {
  for (const bad of [Number.NaN, Infinity, -Infinity, -1, 1.5, '3', 2 ** 53, null, true]) {
    const reason = refusal(requestInput({ state: stateInput({ touched_area_count: bad }) }));
    assert.equal(reason.code, 'invalid-value', `touched_area_count=${String(bad)}`);
  }
  assert.equal(refusal(requestInput({ state: stateInput({ touched_area_count: LIMITS.touchedAreaCount + 1 }) })).code,
    'invalid-value');
  assert.equal(buildEvaluationRequest(requestInput({
    state: stateInput({ touched_area_count: LIMITS.touchedAreaCount }),
  })).ok, true);
  assert.equal(refusal(requestInput({ state: stateInput({ size_bucket: 'xxl' }) })).code, 'invalid-value');
  assert.equal(refusal(requestInput({ state: stateInput({ requires_shell: 'true' }) })).code, 'invalid-value');
  assert.equal(refusal(requestInput({ state: stateInput({ candidates: [] }) })).code, 'invalid-value');
  assert.equal(refusal(requestInput({ state: stateInput({ candidates: {} }) })).code, 'invalid-shape');
});

/* ------------------------------------------------------------ public boundary */

test('the public-content boundary refuses obvious secret-shaped description text', () => {
  const cases = [
    ['/Users/someone/project', 'path separator'],
    ['..\\windows', 'parent traversal'],
    ['sk-abc123', 'secret prefix'],
    ['Bearer abcdef', 'authorization fragment'],
    ['-----BEGIN PRIVATE KEY-----', 'PEM block'],
    ['a'.repeat(40), 'long opaque run'],
    ['deadbeef'.repeat(4), 'long hex run'],
    ['tab\there', 'control character'],
  ];
  for (const [text, label] of cases) {
    const reason = refusal(requestInput({
      state: stateInput({ candidates: [{ id: 'cand-a', capabilities: ['read'], description: text }] }),
    }));
    assert.equal(reason.code, 'disallowed-content', label);
  }
});

test('the public boundary also covers instructions and every criteria description', () => {
  assert.equal(refusal(requestInput({ questions: { q: noulQuestion({ instructions: 'see /etc/passwd' }) } })).code,
    'disallowed-content');
  assert.equal(refusal(requestInput({
    questions: { q: noulQuestion({ criteria: { true: 'ok', false: 'sk-leak' } }) },
  })).code, 'disallowed-content');
  assert.equal(refusal(requestInput({
    questions: { q: choiceQuestion({ criteria: { 'cand-a': 'ok', 'cand-b': 'Bearer x' } }) },
  })).code, 'disallowed-content');
  assert.equal(refusal(requestInput({
    questions: { q: scoreQuestion({ criteria: ['fine', '/abs/path'] }) },
  })).code, 'disallowed-content');
});

/* -------------------------------------------------------------------- limits */

test('question, option and level counts are bounded', () => {
  const tooMany = {};
  for (let index = 0; index <= LIMITS.questions; index += 1) tooMany[`q-${index}`] = noulQuestion();
  assert.equal(refusal(requestInput({ questions: tooMany })).code, 'input-limit');
  assert.equal(refusal(requestInput({ questions: {} })).code, 'invalid-value');

  const tooManyOptions = {};
  for (let index = 0; index <= LIMITS.options; index += 1) tooManyOptions[`opt-${index}`] = `Option ${index}`;
  assert.equal(refusal(requestInput({ questions: { q: choiceQuestion({ criteria: tooManyOptions }) } })).code,
    'input-limit');
  assert.equal(refusal(requestInput({ questions: { q: choiceQuestion({ criteria: { only: 'one' } }) } })).code,
    'invalid-value');

  assert.equal(refusal(requestInput({ questions: { q: scoreQuestion({ criteria: ['only'] }) } })).code, 'invalid-value');
  assert.equal(refusal(requestInput({
    questions: { q: scoreQuestion({ criteria: Array.from({ length: LIMITS.maxLevels + 1 }, (_v, i) => `L${i}`) }) },
  })).code, 'invalid-value');

  assert.equal(refusal(requestInput({
    state: stateInput({
      candidates: Array.from({ length: LIMITS.candidates + 1 }, (_v, i) => ({
        id: `cand-${i}`, capabilities: ['read'], description: 'worker',
      })),
    }),
  })).code, 'input-limit');
});

test('the serialized 8 KiB request ceiling refuses an oversized but otherwise valid request', () => {
  const filler = 'alpha bravo charlie delta echo '.repeat(16).slice(0, LIMITS.description);
  const candidates = Array.from({ length: LIMITS.candidates }, (_value, index) => ({
    id: `cand-${index}`, capabilities: ['read'], description: filler,
  }));
  const reason = refusal(requestInput({ state: stateInput({ candidates }) }));
  assert.equal(reason.code, 'input-limit');
  assert.equal(reason.path, '$');
});

test('the byte ceiling is a byte count and stays a byte count for multibyte text', () => {
  // Same character count, more bytes: the ceiling must be reached sooner in UTF-8 bytes.
  const ascii = 'ab '.repeat(170).slice(0, LIMITS.description);
  const cjk = '평가 '.repeat(170).slice(0, LIMITS.description);
  const build = (description) => buildEvaluationRequest(requestInput({
    state: stateInput({
      candidates: Array.from({ length: 12 }, (_value, index) => ({
        id: `cand-${index}`, capabilities: ['read'], description,
      })),
    }),
  }));
  assert.equal(build(ascii).ok, true, 'ascii filler fits');
  assert.equal(build(cjk).ok, false, 'multibyte filler of equal length does not fit');
});

test('structure depth and node bounds refuse a deeply nested unknown payload', () => {
  let nested = 'leaf';
  for (let depth = 0; depth < 40; depth += 1) nested = { next: nested };
  const reason = refusal(requestInput({ state: stateInput({ candidates: nested }) }));
  assert.equal(reason.code, 'invalid-shape');
});

/* --------------------------- r2: hostile carrier shapes on the request entrypoint */

test('FIXED: array holes are refused everywhere an array is accepted', () => {
  const holedCandidates = refusal(requestInput({
    state: stateInput({
      candidates: sparseArray([
        { id: 'cand-a', capabilities: ['read'], description: 'first' },
        { id: 'cand-b', capabilities: ['read'], description: 'second' },
      ], 0),
    }),
  }));
  assert.equal(holedCandidates.code, 'invalid-shape');
  assert.equal(holedCandidates.message, 'Expected a dense JSON array');
  assert.equal(holedCandidates.path, '$.state.candidates');

  const holedCapabilities = refusal(requestInput({
    state: stateInput({
      candidates: [{ id: 'cand-a', capabilities: sparseArray(['read', 'shell'], 0), description: 'x y' }],
    }),
  }));
  assert.equal(holedCapabilities.message, 'Expected a dense JSON array');
  assert.equal(holedCapabilities.path, '$.state.candidates[0].capabilities');

  const holedLevels = refusal(requestInput({
    questions: { q: scoreQuestion({ criteria: sparseArray(['Low', 'Mid', 'High'], 1) }) },
  }));
  assert.equal(holedLevels.message, 'Expected a dense JSON array');
  assert.equal(holedLevels.path, '$.questions.<question>.criteria');
});

test('FIXED: array-likes, foreign array prototypes and arrays with extra keys are refused', () => {
  assert.equal(refusal(requestInput({
    state: stateInput({ candidates: { 0: { id: 'cand-a', capabilities: [], description: 'x y' }, length: 1 } }),
  })).code, 'invalid-shape');

  const subclassed = Object.setPrototypeOf(
    [{ id: 'cand-a', capabilities: ['read'], description: 'x y' }], Object.create(Array.prototype));
  assert.equal(refusal(requestInput({ state: stateInput({ candidates: subclassed }) })).code, 'invalid-shape');

  const extra = [{ id: 'cand-a', capabilities: ['read'], description: 'x y' }];
  extra.note = 'extra own key';
  assert.equal(refusal(requestInput({ state: stateInput({ candidates: extra }) })).code, 'invalid-shape');
});

test('FIXED: the candidate list length is bounded BEFORE any element is read', () => {
  const oversized = Array.from({ length: LIMITS.candidates + 1 }, (_value, index) => ({
    id: `cand-${index}`, capabilities: ['read'], description: 'worker',
  }));
  const reads = trapAccessor(oversized, '0');
  const reason = refusal(requestInput({ state: stateInput({ candidates: oversized }) }));
  assert.equal(reason.code, 'input-limit');
  assert.equal(reason.path, '$.state.candidates');
  assert.equal(reads(), 0, 'no element getter ran before the length bound refused the list');
});

test('FIXED: accessor properties are refused and the getter is NEVER invoked', () => {
  for (const key of ['role', 'task_kind', 'size_bucket', 'touched_area_count', 'candidates']) {
    const state = stateInput();
    delete state[key];
    const reads = trapAccessor(state, key);
    const reason = refusal(requestInput({ state }));
    assert.equal(reason.code, 'invalid-shape', key);
    assert.equal(reason.path, '$.state');
    assert.equal(reason.message, 'Expected plain data properties');
    assert.equal(reads(), 0, `the getter for ${key} must never run`);
  }
  // Top level and inside a question too.
  const outer = requestInput();
  delete outer.model;
  const outerReads = trapAccessor(outer, 'model');
  assert.equal(refusal(outer).path, '$');
  assert.equal(outerReads(), 0);
});

test('FIXED: non-enumerable own properties are refused rather than silently missing', () => {
  const state = stateInput();
  delete state.role;
  hiddenProperty(state, 'role', 'tester');
  const reason = refusal(requestInput({ state }));
  assert.equal(reason.code, 'invalid-shape');
  assert.equal(reason.message, 'Expected plain data properties');
});

test('a validated request is a data snapshot: mutating the caller object cannot change it', () => {
  const input = requestInput();
  const value = expectOk(buildEvaluationRequest(input));
  input.state.role = 'mutated';
  input.state.candidates[0].id = 'mutated';
  input.questions['needs-shell'].instructions = 'mutated';
  assert.equal(value.state.role, 'tester');
  assert.equal(value.state.candidates[0].id, 'cand-a');
  assert.equal(value.questions['needs-shell'].instructions, 'Does this task need a shell?');
});

/* ----------------------------------------------------------- model discipline */

test('the request model must be a pinned versioned id; aliases are refused', () => {
  assert.equal(refusal(requestInput({ model: 'jev-latest' })).code, 'model-alias');
  assert.equal(refusal(requestInput({ model: 'jev-preview' })).code, 'model-alias');
  assert.equal(refusal(requestInput({ model: 'jev-1.13' })).code, 'invalid-value');
  assert.equal(refusal(requestInput({ model: 'JEV-1.13.0' })).code, 'invalid-value');
  assert.equal(refusal(requestInput({ model: ' jev-1.13.0 ' })).code, 'invalid-value');
  assert.equal(refusal(requestInput({ model: 'jev-1.13.0\n' })).code, 'invalid-value');
});
