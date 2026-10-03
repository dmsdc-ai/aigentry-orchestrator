/** validateEvaluationResponse retest (jt1179ka-v2): response contract against exactly the
 * request sent, run on the real tsc output in ../../dist/src/jev (no fixture fallback).
 * Synthetic data only; no network, no credential, no paid call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvaluationRequest, validateEvaluationResponse, LIMITS,
  PROBABILITY_SUM_TOLERANCE, SCORE_WEIGHTED_TOLERANCE,
} from '../../dist/src/jev/contracts.js';
import {
  requestInput, responseFor, expectOk, trapAccessor, hiddenProperty, sparseArray,
} from './tc-support.mjs';

const request = expectOk(buildEvaluationRequest(requestInput()));

const refusal = (body, against = request) => {
  const result = validateEvaluationResponse(body, against);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.reason;
};

/** Replace one answer in a copy of the good response. */
const withAnswer = (id, answer) => {
  const body = responseFor(request);
  body.answers = { ...body.answers, [id]: answer };
  return body;
};

/* ---------------------------------------------------------------- positive */

test('positive: a well-formed noul/choice/score response validates and is returned verbatim', () => {
  const value = expectOk(validateEvaluationResponse(responseFor(request), request));
  assert.equal(value.model, request.model);
  assert.deepEqual(value.answers['needs-shell'], { type: 'noul', noul: 0.75 });
  assert.deepEqual(value.answers['pick-worker'], {
    type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 0.7, 'cand-b': 0.3 }, confidence: 0.64,
  });
  assert.deepEqual(value.answers['surface-size'].legend, { 0: 'Tiny', 1: 'Moderate', 2: 'Large' });
  assert.deepEqual(value.usage, { input_tokens: 296, output_tokens: 20 });
});

test('positive: boundary probabilities 0 and 1 and a zero-token usage are accepted', () => {
  const body = withAnswer('needs-shell', { type: 'noul', noul: 0 });
  body.answers['pick-worker'] = {
    type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 1, 'cand-b': 0 }, confidence: 1,
  };
  body.answers['surface-size'] = {
    type: 'score', score: 0, legend: { 0: 'Tiny', 1: 'Moderate', 2: 'Large' },
    probabilities: { 0: 1, 1: 0, 2: 0 }, confidence: 1,
  };
  body.usage = { input_tokens: 0, output_tokens: 0 };
  const value = expectOk(validateEvaluationResponse(body, request));
  assert.equal(value.answers['needs-shell'].noul, 0);
  assert.equal(value.answers['surface-size'].score, 0);
});

test('positive: the documented p06 example response shape validates against its own request', () => {
  const single = expectOk(buildEvaluationRequest(requestInput({
    questions: { 'is-urgent': { type: 'noul', instructions: 'Does this convey urgency?' } },
  })));
  const value = expectOk(validateEvaluationResponse({
    model: 'jev-1.13.0',
    answers: { 'is-urgent': { type: 'noul', noul: 0.95 } },
    usage: { input_tokens: 296, output_tokens: 20 },
  }, single));
  assert.equal(value.answers['is-urgent'].noul, 0.95);
});

/* -------------------------------------------------------------- model identity */

test('the response model must equal the exact versioned model requested', () => {
  assert.equal(refusal(responseFor(request, { model: 'jev-1.13.1' })).code, 'model-mismatch');
  assert.equal(refusal(responseFor(request, { model: 'jev-2.0.0' })).code, 'model-mismatch');
});

test('an alias in the response model is refused before any mismatch comparison', () => {
  assert.equal(refusal(responseFor(request, { model: 'jev-latest' })).code, 'model-alias');
  assert.equal(refusal(responseFor(request, { model: 'jev-preview' })).code, 'model-alias');
  assert.equal(refusal(responseFor(request, { model: 'not-a-jev-model' })).code, 'invalid-value');
  assert.equal(refusal(responseFor(request, { model: 'a'.repeat(LIMITS.modelId + 1) })).code, 'input-limit');
});

/* ------------------------------------------------------------ matching keys */

test('answer keys must match the requested question keys exactly', () => {
  const missing = responseFor(request);
  delete missing.answers['pick-worker'];
  assert.equal(refusal(missing).code, 'key-mismatch');

  const extra = responseFor(request);
  extra.answers = { ...extra.answers, 'not-asked': { type: 'noul', noul: 0.5 } };
  assert.equal(refusal(extra).code, 'key-mismatch');

  const renamed = responseFor(request);
  renamed.answers = { ...renamed.answers, 'pick-worker': undefined, 'pick-Worker': renamed.answers['pick-worker'] };
  delete renamed.answers['pick-worker'];
  assert.equal(refusal(renamed).code, 'key-mismatch');
});

test('unknown top-level response fields and a missing usage are refused', () => {
  assert.equal(refusal({ ...responseFor(request), id: 'msg-1' }).code, 'unknown-field');
  const noUsage = responseFor(request);
  delete noUsage.usage;
  assert.equal(refusal(noUsage).code, 'invalid-shape');
  assert.equal(refusal(responseFor(request, { usage: { input_tokens: 1 } })).code, 'invalid-value');
  assert.equal(refusal(responseFor(request, { usage: { input_tokens: -1, output_tokens: 0 } })).code, 'invalid-value');
  assert.equal(refusal(responseFor(request, { usage: { input_tokens: 1.5, output_tokens: 0 } })).code, 'invalid-value');
  assert.equal(refusal(responseFor(request, { usage: { input_tokens: 1, output_tokens: 0, cost: 1 } })).code,
    'unknown-field');
});

/* ------------------------------------------------------------------- noul */

test('a noul answer carries no confidence and no probabilities', () => {
  assert.equal(refusal(withAnswer('needs-shell', { type: 'noul', noul: 0.9, confidence: 0.8 })).code, 'unknown-field');
  assert.equal(refusal(withAnswer('needs-shell', {
    type: 'noul', noul: 0.9, probabilities: { true: 0.9, false: 0.1 },
  })).code, 'unknown-field');
});

test('a noul value must be a finite probability in [0,1]', () => {
  for (const bad of [1.0001, -0.0001, Number.NaN, Infinity, '0.5', null, true]) {
    assert.equal(refusal(withAnswer('needs-shell', { type: 'noul', noul: bad })).code, 'invalid-value',
      `noul=${String(bad)}`);
  }
});

test('an answer type that differs from the requested question type is refused', () => {
  const reason = refusal(withAnswer('needs-shell', {
    type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 1, 'cand-b': 0 }, confidence: 1,
  }));
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.answers.<question>.type');
});

/* ----------------------------------------------------------------- choice */

test('choice probability keys must equal the requested option set exactly', () => {
  const cases = [
    { 'cand-a': 1 },
    { 'cand-a': 0.7, 'cand-b': 0.2, 'cand-c': 0.1 },
    { 'cand-a': 0.7, 'cand-z': 0.3 },
  ];
  for (const probabilities of cases) {
    assert.equal(refusal(withAnswer('pick-worker', {
      type: 'choice', choice: 'cand-a', probabilities, confidence: 0.5,
    })).code, 'key-mismatch', JSON.stringify(probabilities));
  }
});

test('choice probabilities must sum to one within the documented tolerance', () => {
  const inTolerance = 0.3 + PROBABILITY_SUM_TOLERANCE / 2;
  assert.equal(validateEvaluationResponse(withAnswer('pick-worker', {
    type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 0.7, 'cand-b': inTolerance }, confidence: 0.5,
  }), request).ok, true, 'a deviation inside the tolerance is accepted');

  const outOfTolerance = 0.3 + PROBABILITY_SUM_TOLERANCE * 10;
  assert.equal(refusal(withAnswer('pick-worker', {
    type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 0.7, 'cand-b': outOfTolerance }, confidence: 0.5,
  })).code, 'invalid-value');
});

test('the chosen option must be a requested option and the highest-probability one', () => {
  assert.equal(refusal(withAnswer('pick-worker', {
    type: 'choice', choice: 'cand-z', probabilities: { 'cand-a': 0.7, 'cand-b': 0.3 }, confidence: 0.5,
  })).code, 'key-mismatch');
  const reason = refusal(withAnswer('pick-worker', {
    type: 'choice', choice: 'cand-b', probabilities: { 'cand-a': 0.7, 'cand-b': 0.3 }, confidence: 0.5,
  }));
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.answers.<question>.choice');
});

test('an exact probability tie lets either option be reported as the choice', () => {
  for (const choice of ['cand-a', 'cand-b']) {
    assert.equal(validateEvaluationResponse(withAnswer('pick-worker', {
      type: 'choice', choice, probabilities: { 'cand-a': 0.5, 'cand-b': 0.5 }, confidence: 0.5,
    }), request).ok, true, choice);
  }
});

test('choice confidence must be a finite probability', () => {
  for (const bad of [1.5, -0.1, Number.NaN, '0.5', null]) {
    assert.equal(refusal(withAnswer('pick-worker', {
      type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 0.7, 'cand-b': 0.3 }, confidence: bad,
    })).code, 'invalid-value', String(bad));
  }
});

/* ------------------------------------------------------------------ score */

test('score legend must be keyed by level index and echo our level descriptions', () => {
  const base = {
    type: 'score', score: 1.1, probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 }, confidence: 0.5,
  };
  assert.equal(refusal(withAnswer('surface-size', {
    ...base, legend: { 0: 'Tiny', 1: 'Moderate' },
  })).code, 'key-mismatch');
  assert.equal(refusal(withAnswer('surface-size', {
    ...base, legend: { Tiny: 'Tiny', Moderate: 'Moderate', Large: 'Large' },
  })).code, 'key-mismatch');
  const reason = refusal(withAnswer('surface-size', {
    ...base, legend: { 0: 'Tiny', 1: 'Rewritten', 2: 'Large' },
  }));
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.answers.<question>.legend.1');
});

test('score probabilities are keyed by level index, never by the level descriptions', () => {
  assert.equal(refusal(withAnswer('surface-size', {
    type: 'score', score: 1.1, legend: { 0: 'Tiny', 1: 'Moderate', 2: 'Large' },
    probabilities: { Tiny: 0.2, Moderate: 0.5, Large: 0.3 }, confidence: 0.5,
  })).code, 'key-mismatch');
});

test('score must equal the probability-weighted level index within tolerance', () => {
  const weighted = { 0: 0.2, 1: 0.5, 2: 0.3 }; // 0*0.2 + 1*0.5 + 2*0.3 = 1.1
  const build = (score) => withAnswer('surface-size', {
    type: 'score', score, legend: { 0: 'Tiny', 1: 'Moderate', 2: 'Large' },
    probabilities: weighted, confidence: 0.5,
  });
  assert.equal(validateEvaluationResponse(build(1.1 + SCORE_WEIGHTED_TOLERANCE / 2), request).ok, true,
    'a deviation inside the tolerance is accepted');
  const reason = refusal(build(1.1 + SCORE_WEIGHTED_TOLERANCE * 10));
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.answers.<question>.score');
});

test('score outside the level range is refused before the weighting check', () => {
  const base = {
    type: 'score', legend: { 0: 'Tiny', 1: 'Moderate', 2: 'Large' },
    probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 }, confidence: 0.5,
  };
  for (const bad of [-0.001, 2.001, Number.NaN, Infinity, '1.1', null]) {
    assert.equal(refusal(withAnswer('surface-size', { ...base, score: bad })).code, 'invalid-value', String(bad));
  }
});

/* --------------------------------------------------- malformed / hostile shape */

test('malformed, reserved-key and non-plain response bodies are refused', () => {
  assert.equal(refusal(null).code, 'invalid-shape');
  assert.equal(refusal('{}').code, 'invalid-shape');
  assert.equal(refusal([responseFor(request)]).code, 'invalid-shape');
  assert.equal(refusal(JSON.parse(
    `{"model":"jev-1.13.0","answers":{},"usage":{"input_tokens":1,"output_tokens":1},"__proto__":{"x":1}}`,
  )).code, 'reserved-key');
  const symbolic = responseFor(request);
  symbolic[Symbol('marker')] = 1;
  assert.equal(refusal(symbolic).code, 'invalid-shape');
  const answerWithProto = withAnswer('needs-shell', JSON.parse('{"type":"noul","noul":0.5,"__proto__":{"x":1}}'));
  assert.equal(refusal(answerWithProto).code, 'reserved-key');
});

test('the 64 KiB response ceiling refuses an oversized body', () => {
  const body = responseFor(request);
  body.answers = { ...body.answers, filler: 'x'.repeat(LIMITS.responseBytes + 1) };
  const reason = refusal(body);
  assert.equal(reason.code, 'input-limit');
  assert.equal(reason.path, '$');
});


/* ------------------------- r2: single data copy, accessors refused, depth bound */

test('FIXED: the response is read ONCE into a data copy; accessor input is refused', () => {
  // Was: the byte-ceiling walk and the validating walk were two separate reads of the same
  // caller object, so for accessor-backed input the measured bytes were not provably the
  // validated bytes. Now one data-only copy is made and everything runs on that copy.
  const body = responseFor(request);
  delete body.model;
  const reads = trapAccessor(body, 'model');
  const reason = refusal(body);
  assert.equal(reason.code, 'invalid-shape');
  assert.equal(reason.path, '$');
  assert.equal(reads(), 0, 'the getter must never run');
});

test('FIXED: accessors anywhere inside the response are refused without running', () => {
  const nested = responseFor(request);
  nested.answers = { ...nested.answers, 'needs-shell': {} };
  const noulReads = trapAccessor(nested.answers['needs-shell'], 'noul');
  hiddenProperty(nested.answers['needs-shell'], 'type', 'noul');
  assert.equal(refusal(nested).code, 'invalid-shape');
  assert.equal(noulReads(), 0);

  const usage = responseFor(request);
  delete usage.usage.input_tokens;
  const usageReads = trapAccessor(usage.usage, 'input_tokens');
  assert.equal(refusal(usage).code, 'invalid-shape');
  assert.equal(usageReads(), 0);
});

test('FIXED: a validated response is a snapshot; mutating the body afterwards changes nothing', () => {
  const body = responseFor(request);
  const value = expectOk(validateEvaluationResponse(body, request));
  body.answers['needs-shell'].noul = 0.01;
  body.usage.input_tokens = 999_999;
  assert.equal(value.answers['needs-shell'].noul, 0.75);
  assert.equal(value.usage.input_tokens, 296);
});

test('the depth bound refuses a deeply nested response payload', () => {
  const body = responseFor(request);
  let nested = 'leaf';
  for (let depth = 0; depth < 40; depth += 1) nested = { next: nested };
  body.answers = { ...body.answers, filler: nested };
  const reason = refusal(body);
  assert.equal(reason.code, 'input-limit');
  assert.equal(reason.path, '$');
  assert.equal(reason.message, 'Structure exceeds validation bound');
});

test('sparse and foreign-prototype arrays inside a response are refused', () => {
  const body = responseFor(request);
  body.answers = { ...body.answers, filler: sparseArray(['a', 'b', 'c'], 1) };
  assert.equal(refusal(body).code, 'invalid-shape');
});
