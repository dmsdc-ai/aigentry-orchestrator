/** FINDING 2, retest: refusal paths must be bounded constants that never carry caller bytes.
 *
 * The v1 oracle asserted the leak (`path === '$.<caller key>'`). That assertion is NOT
 * rewritten here — it is preserved verbatim in output/r1-preserved and re-run against the new
 * bytes in output/r2-old-oracle-probe, where it fails. This file asserts the intended
 * property instead: for every entrypoint and nesting level, the refusal path is one of a
 * closed set of constant strings, and no caller-supplied key or value appears in a path or a
 * message.
 *
 * The probe still uses a SYNTHETIC sentinel. Passing publicText is separately no proof that
 * arbitrary text is public, and none of these tests transmits anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvaluationRequest, validateEvaluationResponse, workerTarget,
} from '../../dist/src/jev/contracts.js';
import { resolveInputTokenPrice } from '../../dist/src/jev/price-table.js';
import {
  declareVerifiedBillableInputBound, checkCeiling, computeSettlement, planReservation,
} from '../../dist/src/jev/reserve.js';
import {
  requestInput, stateInput, noulQuestion, choiceQuestion, responseFor, priceEvidence,
  boundEvidenceInput, workerTargetInput, expectOk, LEAK_SENTINEL, CEILING_NANO_USD_50,
} from './tc-support.mjs';

/** Keys a hostile caller might inject. None may ever appear in a path or a message. */
const HOSTILE_KEYS = Object.freeze([
  LEAK_SENTINEL,
  '/Users/someone/.ssh/id_rsa',
  'sk-0123456789abcdef',
  'Bearer zzzzzzzzzzzz',
  'a'.repeat(4096),
  'line\nbreak',
  'control',
  '__dunder__',
  '$.state.candidates[0].id',
]);

/** Every path this bundle is allowed to emit is built from constant field names, numeric
 * array indices, score level indices 0..9, and the placeholders `<question>` / `<option>`. */
const PATH_GRAMMAR = /^\$(?:\.(?:<question>|<option>|[A-Za-z_][A-Za-z0-9_]*)|\[\d+\]|\.\d)*$/;

function assertBoundedPath(reason, label) {
  assert.ok(PATH_GRAMMAR.test(reason.path), `${label}: path is not a bounded constant: ${reason.path}`);
  assert.ok(reason.path.length <= 64, `${label}: path is unexpectedly long: ${reason.path}`);
}

function assertNoLeak(reason, needle, label) {
  assert.equal(reason.path.includes(needle), false, `${label}: key leaked into path: ${reason.path}`);
  assert.equal(reason.message.includes(needle), false, `${label}: key leaked into message: ${reason.message}`);
  assertBoundedPath(reason, label);
}

const requestRefusal = (input) => {
  const result = buildEvaluationRequest(input);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.reason;
};

/* ------------------------------------------------- FIXED: no key echo anywhere */

test('FIXED: an unknown top-level request key is refused at the parent path, not echoed', () => {
  for (const key of HOSTILE_KEYS) {
    const reason = requestRefusal({ ...requestInput(), [key]: 1 });
    assert.equal(reason.code, 'unknown-field');
    assert.equal(reason.path, '$');
    assert.equal(reason.message, 'Unexpected field');
    assertNoLeak(reason, key, `top-level ${JSON.stringify(key.slice(0, 20))}`);
  }
});

test('FIXED: unknown keys at every request nesting level resolve to a constant parent path', () => {
  const cases = [
    ['$.state', (key) => requestInput({ state: stateInput({ [key]: 1 }) })],
    ['$.state.candidates[0]', (key) => requestInput({
      state: stateInput({ candidates: [{ id: 'cand-a', capabilities: ['read'], description: 'x y', [key]: 1 }] }),
    })],
    ['$.questions.<question>', (key) => requestInput({
      questions: { q: { type: 'noul', instructions: 'ok', [key]: 1 } },
    })],
    ['$.questions.<question>.criteria', (key) => requestInput({
      questions: { q: noulQuestion({ criteria: { true: 'a', false: 'b', [key]: 1 } }) },
    })],
  ];
  for (const [expectedPath, build] of cases) {
    for (const key of HOSTILE_KEYS) {
      const reason = requestRefusal(build(key));
      assert.equal(reason.code, 'unknown-field', `${expectedPath} ${JSON.stringify(key.slice(0, 20))}`);
      assert.equal(reason.path, expectedPath);
      assertNoLeak(reason, key, expectedPath);
    }
  }
});

test('FIXED: a caller-named question key never appears in a path; the placeholder does', () => {
  const reason = requestRefusal(requestInput({
    questions: { [LEAK_SENTINEL.replace(/[^a-z0-9-]/g, '-')]: { type: 'noul', instructions: 'ok', extra: 1 } },
  }));
  assert.equal(reason.path, '$.questions.<question>');
  assertNoLeak(reason, 'sentinel', 'question key');

  // A bad question key itself is reported at the placeholder too.
  const badKey = requestRefusal(requestInput({ questions: { 'Bad Key': noulQuestion() } }));
  assert.equal(badKey.path, '$.questions.<question>');
  assert.equal(badKey.code, 'invalid-value');
});

test('FIXED: a caller-named choice option never appears in a path; <option> does', () => {
  const keyReason = requestRefusal(requestInput({
    questions: { q: choiceQuestion({ criteria: { 'BAD-OPTION': 'a', b: 'B' } }) },
  }));
  assert.equal(keyReason.path, '$.questions.<question>.criteria.<option>');
  assertNoLeak(keyReason, 'BAD-OPTION', 'option key');

  // The option VALUE is reported at the same placeholder, so a bad description cannot
  // identify which caller-named option it came from.
  const valueReason = requestRefusal(requestInput({
    questions: { q: choiceQuestion({ criteria: { 'opt-a': 'fine', 'opt-b': 'sk-leak' } }) },
  }));
  assert.equal(valueReason.code, 'disallowed-content');
  assert.equal(valueReason.path, '$.questions.<question>.criteria.<option>');
  assertNoLeak(valueReason, 'opt-b', 'option value');
});

test('FIXED: response answer and probability paths use placeholders, not caller ids', () => {
  const request = expectOk(buildEvaluationRequest(requestInput()));
  for (const key of HOSTILE_KEYS) {
    const body = { ...responseFor(request), [key]: 1 };
    const result = validateEvaluationResponse(body, request);
    assert.equal(result.ok, false);
    assert.equal(result.reason.path, '$');
    assertNoLeak(result.reason, key, 'response top-level');
  }

  const withExtra = responseFor(request);
  withExtra.answers = { ...withExtra.answers, 'needs-shell': { type: 'noul', noul: 0.5, [LEAK_SENTINEL]: 1 } };
  const nested = validateEvaluationResponse(withExtra, request);
  assert.equal(nested.ok, false);
  assert.equal(nested.reason.path, '$.answers.<question>');
  assertNoLeak(nested.reason, LEAK_SENTINEL, 'response answer');

  const badProbability = responseFor(request);
  badProbability.answers = {
    ...badProbability.answers,
    'pick-worker': { type: 'choice', choice: 'cand-a', probabilities: { 'cand-a': 1.5, 'cand-b': -0.5 }, confidence: 1 },
  };
  const probability = validateEvaluationResponse(badProbability, request);
  assert.equal(probability.ok, false);
  assert.equal(probability.reason.path, '$.answers.<question>.probabilities.<option>');
  assertNoLeak(probability.reason, 'cand-a', 'choice probability');
});

test('score legend and probability paths keep only OUR generated level indices', () => {
  const request = expectOk(buildEvaluationRequest(requestInput()));
  const body = responseFor(request);
  body.answers = {
    ...body.answers,
    'surface-size': {
      type: 'score', score: 1.1, legend: { 0: 'Tiny', 1: 'Rewritten', 2: 'Large' },
      probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 }, confidence: 0.5,
    },
  };
  const result = validateEvaluationResponse(body, request);
  assert.equal(result.ok, false);
  assert.equal(result.reason.path, '$.answers.<question>.legend.1');
  assertBoundedPath(result.reason, 'score legend');
  // "1" is an index this module generated from our own level list, not a caller key.
  assert.equal(result.reason.message, 'Legend description differs from the requested level');
});

/* ------------------------------------------- FIXED: the sibling modules too */

test('FIXED: unknown price-evidence keys are refused at $ with no echo', () => {
  for (const key of HOSTILE_KEYS) {
    const result = resolveInputTokenPrice(priceEvidence({ [key]: 1 }));
    assert.equal(result.ok, false, JSON.stringify(key.slice(0, 20)));
    assert.equal(result.reason.code, 'unknown-field');
    assert.equal(result.reason.path, '$');
    assertNoLeak(result.reason, key, 'price evidence');
  }
});

test('FIXED: unknown bound, ceiling, plan and usage keys are refused at their parent path', () => {
  const bound = declareVerifiedBillableInputBound(boundEvidenceInput({ [LEAK_SENTINEL]: 1 }));
  assert.equal(bound.ok, false);
  assert.equal(bound.reason.path, '$');
  assertNoLeak(bound.reason, LEAK_SENTINEL, 'bound');

  const evidence = declareVerifiedBillableInputBound(boundEvidenceInput({
    evidence: { ...boundEvidenceInput().evidence, [LEAK_SENTINEL]: 1 },
  }));
  assert.equal(evidence.ok, false);
  assert.equal(evidence.reason.path, '$.evidence');
  assertNoLeak(evidence.reason, LEAK_SENTINEL, 'bound evidence');

  const ceiling = checkCeiling({
    ceilingNanoUsd: CEILING_NANO_USD_50, spentNanoUsd: 0, liveReservedNanoUsd: 0,
    reserveNanoUsd: 1, [LEAK_SENTINEL]: 1,
  });
  assert.equal(ceiling.ok, false);
  assert.equal(ceiling.reason.path, '$');
  assertNoLeak(ceiling.reason, LEAK_SENTINEL, 'ceiling');

  const price = expectOk(resolveInputTokenPrice(priceEvidence()));
  const plan = expectOk(planReservation(price, expectOk(declareVerifiedBillableInputBound(boundEvidenceInput()))));
  const settlement = computeSettlement({ ...plan, [LEAK_SENTINEL]: 1 }, { input_tokens: 1 });
  assert.equal(settlement.ok, false);
  assert.equal(settlement.reason.path, '$.plan');
  assertNoLeak(settlement.reason, LEAK_SENTINEL, 'plan');
});

test('FIXED: unknown worker-target keys are refused at their parent path', () => {
  for (const key of HOSTILE_KEYS) {
    const result = workerTarget(workerTargetInput({ [key]: 1 }));
    assert.equal(result.ok, false, JSON.stringify(key.slice(0, 20)));
    assert.equal(result.reason.path, '$');
    assertNoLeak(result.reason, key, 'worker target');
  }
});

/* --------------------------------------------- exhaustive path-grammar sweep */

test('every refusal this bundle produces has a bounded constant path', () => {
  const request = expectOk(buildEvaluationRequest(requestInput()));
  const price = expectOk(resolveInputTokenPrice(priceEvidence()));
  const bound = expectOk(declareVerifiedBillableInputBound(boundEvidenceInput()));
  const plan = expectOk(planReservation(price, bound));

  const probes = [
    () => buildEvaluationRequest(null),
    () => buildEvaluationRequest(requestInput({ model: 'jev-latest' })),
    () => buildEvaluationRequest(requestInput({ state: stateInput({ role: 'BAD' }) })),
    () => buildEvaluationRequest(requestInput({
      state: stateInput({ candidates: [{ id: 'cand-a', capabilities: ['BAD'], description: 'x y' }] }),
    })),
    () => buildEvaluationRequest(requestInput({ questions: {} })),
    () => validateEvaluationResponse(null, request),
    () => validateEvaluationResponse(responseFor(request, { model: 'jev-1.13.1' }), request),
    () => validateEvaluationResponse(responseFor(request, { usage: { input_tokens: -1, output_tokens: 0 } }), request),
    () => resolveInputTokenPrice(priceEvidence({ catalogStatus: 'unverified' })),
    () => resolveInputTokenPrice(priceEvidence({ maxAgeMs: 0 })),
    () => resolveInputTokenPrice(priceEvidence({ observedVersionedIds: ['jev-1.12.0'] })),
    () => declareVerifiedBillableInputBound(boundEvidenceInput({ maxBillableInputTokens: 0 })),
    () => planReservation({ ...price, nanoUsdPerInputToken: -1 }, bound),
    () => checkCeiling({ ceilingNanoUsd: 1, spentNanoUsd: 0, liveReservedNanoUsd: 0, reserveNanoUsd: 0 }),
    () => computeSettlement({ ...plan, reserveNanoUsd: 1 }, { input_tokens: 1 }),
    () => workerTarget(workerTargetInput({ cli: 'BAD' })),
    () => workerTarget(workerTargetInput({ effort: { kind: 'bad', level: 'high' } })),
  ];
  const seen = new Set();
  for (const probe of probes) {
    const result = probe();
    assert.equal(result.ok, false, 'probe was supposed to refuse');
    assertBoundedPath(result.reason, 'sweep');
    seen.add(result.reason.path);
  }
  assert.ok(seen.size >= 10, `expected a variety of paths, saw ${seen.size}`);
});
