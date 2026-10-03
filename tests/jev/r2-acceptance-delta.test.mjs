/** Anti-regression sweep: the corrected build must not refuse anything the old build
 * correctly accepted, and must not accept anything the old build correctly refused.
 *
 * A corpus of legitimate inputs is pushed through BOTH builds. Every one must be accepted by
 * both, with deepEqual results — a new refusal here is a REGRESSION to return to the coder,
 * not an expectation to rewrite. A separate corpus pins the deltas that are intended
 * (old-accepted / new-refused); anything outside that enumerated set fails.
 *
 * OLD = ./evidence/2026-09-27-jt1179ka-v1-old-build (dated v1 evidence, comparison only)
 * NEW = ../../dist/src/jev (real tsc output, no fixture fallback)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as oldContracts from './evidence/2026-09-27-jt1179ka-v1-old-build/contracts.js';
import * as newContracts from '../../dist/src/jev/contracts.js';
import * as oldPrice from './evidence/2026-09-27-jt1179ka-v1-old-build/price-table.js';
import * as newPrice from '../../dist/src/jev/price-table.js';
import * as oldReserve from './evidence/2026-09-27-jt1179ka-v1-old-build/reserve.js';
import * as newReserve from '../../dist/src/jev/reserve.js';
import {
  requestInput, stateInput, noulQuestion, choiceQuestion, scoreQuestion, responseFor,
  priceEvidence, boundEvidenceInput, expectOk, PRICED_MODEL, CEILING_NANO_USD_50,
} from './tc-support.mjs';

/* ---------------------------------------------- legitimate request corpus */

const VALID_REQUESTS = [
  ['baseline', requestInput()],
  ['single noul, no criteria', requestInput({ questions: { only: { type: 'noul', instructions: 'Urgent?' } } })],
  ['noul with criteria', requestInput({ questions: { q: noulQuestion() } })],
  ['choice at the option bound', requestInput({
    questions: {
      q: choiceQuestion({
        criteria: Object.fromEntries(
          Array.from({ length: oldContracts.LIMITS.options }, (_v, i) => [`opt-${i}`, `Option ${i}`])),
      }),
    },
  })],
  ['score at two levels', requestInput({ questions: { q: scoreQuestion({ criteria: ['Low', 'High'] }) } })],
  ['score at ten levels', requestInput({
    questions: { q: scoreQuestion({ criteria: Array.from({ length: 10 }, (_v, i) => `Level ${i}`) }) },
  })],
  ['question map at the bound', requestInput({
    questions: Object.fromEntries(
      Array.from({ length: oldContracts.LIMITS.questions }, (_v, i) => [`q-${i}`, noulQuestion()])),
  })],
  ['candidates at the bound', requestInput({
    state: stateInput({
      candidates: Array.from({ length: oldContracts.LIMITS.candidates }, (_v, i) => ({
        id: `cand-${i}`, capabilities: ['read'], description: 'worker',
      })),
    }),
  })],
  ['capabilities at the bound', requestInput({
    state: stateInput({
      candidates: [{
        id: 'cand-a',
        capabilities: Array.from({ length: oldContracts.LIMITS.capabilitiesPerCandidate }, (_v, i) => `cap-${i}`),
        description: 'worker',
      }],
    }),
  })],
  ['touched_area_count at the bound', requestInput({
    state: stateInput({ touched_area_count: oldContracts.LIMITS.touchedAreaCount }),
  })],
  ['touched_area_count zero', requestInput({ state: stateInput({ touched_area_count: 0 }) })],
  ['every size bucket xs', requestInput({ state: stateInput({ size_bucket: 'xs' }) })],
  ['every size bucket xl', requestInput({ state: stateInput({ size_bucket: 'xl' }) })],
  ['all booleans true', requestInput({
    state: stateInput({ requires_web: true, requires_shell: true, requires_worktree: true }),
  })],
  ['dotted identifiers', requestInput({
    state: stateInput({ role: 'a.b.c-1', task_kind: 'x_y.z', candidates: [
      { id: 'a.b-1', capabilities: ['x.y'], description: 'ok' },
    ] }),
  })],
  ['single-character identifiers', requestInput({
    state: stateInput({ role: 'a', task_kind: 'b', candidates: [
      { id: 'c', capabilities: ['d'], description: 'ok' },
    ] }),
  })],
  ['description at the length bound', requestInput({
    state: stateInput({
      candidates: [{
        id: 'cand-a', capabilities: ['read'],
        description: 'word '.repeat(103).slice(0, oldContracts.LIMITS.description),
      }],
    }),
  })],
  ['null-prototype carrier', Object.assign(Object.create(null), requestInput())],
  ['explicit undefined criteria on noul', requestInput({
    questions: { q: { type: 'noul', instructions: 'ok', criteria: undefined } },
  })],
];

test('NO REGRESSION: every legitimate request accepted by the old build is still accepted', () => {
  for (const [label, input] of VALID_REQUESTS) {
    const before = oldContracts.buildEvaluationRequest(input);
    assert.equal(before.ok, true, `corpus error: OLD refused "${label}"`);
    const after = newContracts.buildEvaluationRequest(input);
    assert.equal(after.ok, true,
      `REGRESSION: NEW refuses "${label}" with ${after.ok ? '' : `${after.reason.code} at ${after.reason.path}`}`);
    assert.deepEqual(after.value, before.value, `REGRESSION: "${label}" validates to a different value`);
  }
});

/* ---------------------------------------------- legitimate response corpus */

test('NO REGRESSION: every legitimate response accepted by the old build is still accepted', () => {
  const cases = [];
  for (const [label, input] of VALID_REQUESTS) {
    const oldRequest = expectOk(oldContracts.buildEvaluationRequest(input));
    const newRequest = expectOk(newContracts.buildEvaluationRequest(input));
    // Build a conforming response for whatever questions this request carries.
    const answers = {};
    for (const [id, question] of Object.entries(oldRequest.questions)) {
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.5 };
      else if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const probabilities = {};
        options.forEach((option, index) => { probabilities[option] = index === 0 ? 1 : 0; });
        answers[id] = { type: 'choice', choice: options[0], probabilities, confidence: 0.9 };
      } else {
        const levels = question.criteria;
        const legend = {};
        const probabilities = {};
        levels.forEach((level, index) => { legend[index] = level; probabilities[index] = index === 0 ? 1 : 0; });
        answers[id] = { type: 'score', score: 0, legend, probabilities, confidence: 0.9 };
      }
    }
    cases.push([label, { model: oldRequest.model, answers, usage: { input_tokens: 10, output_tokens: 2 } },
      oldRequest, newRequest]);
  }
  // Plus boundary usage values.
  const base = expectOk(oldContracts.buildEvaluationRequest(requestInput()));
  const baseNew = expectOk(newContracts.buildEvaluationRequest(requestInput()));
  cases.push(['zero usage', responseFor(base, { usage: { input_tokens: 0, output_tokens: 0 } }), base, baseNew]);
  cases.push(['max safe usage', responseFor(base, {
    usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER },
  }), base, baseNew]);

  for (const [label, body, oldRequest, newRequest] of cases) {
    const before = oldContracts.validateEvaluationResponse(body, oldRequest);
    assert.equal(before.ok, true, `corpus error: OLD refused response "${label}"`);
    const after = newContracts.validateEvaluationResponse(body, newRequest);
    assert.equal(after.ok, true,
      `REGRESSION: NEW refuses response "${label}" with ${after.ok ? '' : `${after.reason.code} at ${after.reason.path}`}`);
    assert.deepEqual(after.value, before.value, `REGRESSION: response "${label}" differs`);
  }
});

/* ---------------------------------------------- legitimate price / budget corpus */

test('NO REGRESSION: every legitimate price evidence still resolves identically', () => {
  const cases = [
    ['baseline', priceEvidence()],
    ['Z and +00:00 mixed', priceEvidence({ now: '2026-09-27T12:30:00+00:00' })],
    ['fractional seconds', priceEvidence({ verifiedAt: '2026-09-27T12:00:00.123Z' })],
    ['widest window', priceEvidence({ maxAgeMs: oldPrice.MAX_EVIDENCE_AGE_MS })],
    ['now equals verifiedAt', priceEvidence({ now: '2026-09-27T12:00:00Z' })],
    ['catalog at the entry bound', priceEvidence({
      observedVersionedIds: Array.from({ length: oldContracts.LIMITS.catalogEntries },
        (_v, i) => (i === 0 ? PRICED_MODEL : 'jev-1.12.0')),
    })],
    ['price row day boundary', priceEvidence({
      verifiedAt: '2026-09-28T00:00:00Z', now: '2026-09-28T00:00:00Z', maxAgeMs: 86_400_000,
    })],
    ['null-prototype carrier', Object.assign(Object.create(null), priceEvidence())],
  ];
  for (const [label, evidence] of cases) {
    const before = oldPrice.resolveInputTokenPrice(evidence);
    assert.equal(before.ok, true, `corpus error: OLD refused "${label}"`);
    const after = newPrice.resolveInputTokenPrice(evidence);
    assert.equal(after.ok, true,
      `REGRESSION: NEW refuses "${label}" with ${after.ok ? '' : `${after.reason.code} at ${after.reason.path}`}`);
    assert.deepEqual(after.value, before.value, `REGRESSION: "${label}" resolves differently`);
  }
});

test('NO REGRESSION: every legitimate bound, plan, ceiling and settlement is unchanged', () => {
  for (const tokens of [1, 64_000, 1_000_000, 10_000_000]) {
    const input = boundEvidenceInput({ maxBillableInputTokens: tokens });
    const beforeBound = oldReserve.declareVerifiedBillableInputBound(input);
    const afterBound = newReserve.declareVerifiedBillableInputBound(input);
    assert.equal(beforeBound.ok, true, `corpus error: OLD refused bound ${tokens}`);
    assert.equal(afterBound.ok, true, `REGRESSION: NEW refuses bound ${tokens}`);
    assert.deepEqual(afterBound.value, beforeBound.value);

    const oldP = expectOk(oldReserve.planReservation(
      expectOk(oldPrice.resolveInputTokenPrice(priceEvidence())), beforeBound.value));
    const newP = newReserve.planReservation(
      expectOk(newPrice.resolveInputTokenPrice(priceEvidence())), afterBound.value);
    assert.equal(newP.ok, true, `REGRESSION: NEW refuses a legitimate plan for ${tokens}`);
    assert.deepEqual(newP.value, oldP, `REGRESSION: plan for ${tokens} differs`);

    for (const usage of [undefined, { input_tokens: 0 }, { input_tokens: tokens },
      { input_tokens: tokens + 1 }, { input_tokens: 10, output_tokens: 2 }]) {
      const beforeSettle = oldReserve.computeSettlement(oldP, usage);
      const afterSettle = newReserve.computeSettlement(newP.value, usage);
      if (beforeSettle.ok) {
        assert.equal(afterSettle.ok, true,
          `REGRESSION: NEW refuses a settlement OLD produced for ${tokens} / ${JSON.stringify(usage)}`);
        assert.deepEqual(afterSettle.value, beforeSettle.value,
          `REGRESSION: settlement differs for ${tokens} / ${JSON.stringify(usage)}`);
      }
    }
  }

  const plan = expectOk(newReserve.planReservation(
    expectOk(newPrice.resolveInputTokenPrice(priceEvidence())),
    expectOk(newReserve.declareVerifiedBillableInputBound(boundEvidenceInput()))));
  const ceilings = [
    { ceilingNanoUsd: CEILING_NANO_USD_50, spentNanoUsd: 0, liveReservedNanoUsd: 0, reserveNanoUsd: plan.reserveNanoUsd },
    { ceilingNanoUsd: CEILING_NANO_USD_50, spentNanoUsd: 1, liveReservedNanoUsd: 2, reserveNanoUsd: 1 },
    { ceilingNanoUsd: plan.reserveNanoUsd, spentNanoUsd: 0, liveReservedNanoUsd: 0, reserveNanoUsd: plan.reserveNanoUsd },
    { ceilingNanoUsd: Number.MAX_SAFE_INTEGER, spentNanoUsd: 0, liveReservedNanoUsd: 0, reserveNanoUsd: 1 },
  ];
  for (const input of ceilings) {
    const before = oldReserve.checkCeiling(input);
    assert.equal(before.ok, true, `corpus error: OLD refused ${JSON.stringify(input)}`);
    const after = newReserve.checkCeiling(input);
    assert.equal(after.ok, true, `REGRESSION: NEW refuses ${JSON.stringify(input)}`);
    assert.deepEqual(after.value, before.value);
  }
});

/* ------------------------------------- the delta set, enumerated and bounded */

/** Inputs the OLD build accepted and the NEW build refuses. Every entry must be a deliberate
 * hardening tied to a reported finding; an unlisted delta fails the sweep above. */
const INTENDED_STRICTER = [
  ['3a future-dated price row', () => priceEvidence({
    verifiedAt: '2026-09-20T00:00:00Z', now: '2026-09-20T00:00:00Z', maxAgeMs: oldPrice.MAX_EVIDENCE_AGE_MS,
  }), 'invalid-value'],
  ['3b prototype-supplied evidence', () => {
    const inherited = Object.create({ catalogStatus: 'verified-fresh', maxAgeMs: 86_400_000 });
    return Object.assign(inherited, {
      requestedModel: PRICED_MODEL, verifiedAt: '2026-09-27T12:00:00Z',
      observedVersionedIds: [PRICED_MODEL], now: '2026-09-27T12:30:00Z',
    });
  }, 'invalid-shape'],
  ['3b reserved __proto__ key', () => JSON.parse(`{"requestedModel":"${PRICED_MODEL}",`
    + '"catalogStatus":"verified-fresh","verifiedAt":"2026-09-27T12:00:00Z",'
    + `"observedVersionedIds":["${PRICED_MODEL}"],"now":"2026-09-27T12:30:00Z",`
    + '"maxAgeMs":86400000,"__proto__":{"x":1}}'), 'reserved-key'],
  ['3d impossible calendar day', () => priceEvidence({
    verifiedAt: '2026-09-31T00:00:00Z', now: '2026-10-02T00:00:00Z', maxAgeMs: oldPrice.MAX_EVIDENCE_AGE_MS,
  }), 'invalid-value'],
  ['3e sparse catalog array', () => {
    const sparse = Array.from({ length: 64 }, () => PRICED_MODEL);
    delete sparse[1];
    return priceEvidence({ observedVersionedIds: sparse });
  }, 'invalid-shape'],
  ['unknown evidence key', () => priceEvidence({ catalogStatusOverride: 'verified-fresh' }), 'unknown-field'],
];

test('the old-accepted / new-refused delta is exactly the enumerated hardening set', () => {
  for (const [label, build, expectedCode] of INTENDED_STRICTER) {
    const evidence = build();
    assert.equal(oldPrice.resolveInputTokenPrice(evidence).ok, true, `${label}: OLD should have accepted`);
    const after = newPrice.resolveInputTokenPrice(evidence);
    assert.equal(after.ok, false, `${label}: NEW should refuse`);
    assert.equal(after.reason.code, expectedCode, label);
  }
});

test('nothing the old build correctly refused is now accepted', () => {
  // Hardening must be monotone: the new build may refuse more, never less.
  const requestProbes = [
    requestInput({ model: 'jev-latest' }),
    requestInput({ model: 'jev-1.13' }),
    requestInput({ state: stateInput({ role: 'BAD' }) }),
    requestInput({ state: stateInput({ candidates: [] }) }),
    requestInput({ state: stateInput({ touched_area_count: -1 }) }),
    requestInput({ questions: {} }),
    requestInput({ questions: { q: choiceQuestion({ criteria: { only: 'one' } }) } }),
    requestInput({ questions: { q: scoreQuestion({ criteria: ['only'] }) } }),
    requestInput({ state: stateInput({ candidates: [{ id: 'a', capabilities: [], description: 'sk-leak' }] }) }),
    { ...requestInput(), stream: true },
    null,
    [requestInput()],
  ];
  let checked = 0;
  for (const input of requestProbes) {
    const before = oldContracts.buildEvaluationRequest(input);
    if (before.ok) continue;
    checked += 1;
    const after = newContracts.buildEvaluationRequest(input);
    assert.equal(after.ok, false, `WEAKENING: NEW accepts what OLD refused: ${JSON.stringify(input).slice(0, 80)}`);
    assert.equal(after.reason.code, before.reason.code,
      `refusal code changed for ${JSON.stringify(input).slice(0, 60)}`);
  }
  assert.equal(checked, requestProbes.length, 'the monotonicity check must not be vacuous');

  const priceProbes = [
    priceEvidence({ requestedModel: 'jev-latest' }),
    priceEvidence({ catalogStatus: 'unverified' }),
    priceEvidence({ catalogStatus: 'stale' }),
    priceEvidence({ observedVersionedIds: ['jev-1.12.0'] }),
    priceEvidence({ requestedModel: 'jev-1.14.0', observedVersionedIds: ['jev-1.14.0'] }),
    priceEvidence({ maxAgeMs: 0 }),
    priceEvidence({ maxAgeMs: oldPrice.MAX_EVIDENCE_AGE_MS + 1 }),
    priceEvidence({ verifiedAt: '2026-09-27T13:00:00Z', now: '2026-09-27T12:00:00Z' }),
    priceEvidence({ verifiedAt: '2026-09-27T00:00:00Z', now: '2026-09-27T02:00:00Z', maxAgeMs: 3_600_000 }),
    null,
  ];
  let priceChecked = 0;
  for (const evidence of priceProbes) {
    const before = oldPrice.resolveInputTokenPrice(evidence);
    if (before.ok) continue;
    priceChecked += 1;
    const after = newPrice.resolveInputTokenPrice(evidence);
    assert.equal(after.ok, false, 'WEAKENING: NEW accepts price evidence OLD refused');
    assert.equal(after.reason.code, before.reason.code, 'price refusal code changed');
  }
  assert.equal(priceChecked, priceProbes.length, 'the price monotonicity check must not be vacuous');

  // The shipped unverified bound must still block planning in both builds.
  const price = expectOk(newPrice.resolveInputTokenPrice(priceEvidence()));
  assert.equal(oldReserve.planReservation(price, oldReserve.PROVIDER_BILLABLE_INPUT_BOUND).reason.code,
    'budget-bound-unverified');
  assert.equal(newReserve.planReservation(price, newReserve.PROVIDER_BILLABLE_INPUT_BOUND).reason.code,
    'budget-bound-unverified');
});
