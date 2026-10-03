/** Decisive before/after evidence, one test per finding category.
 *
 * This module loads BOTH builds in the same process:
 *   OLD = ./evidence/2026-09-27-jt1179ka-v1-old-build  (dated jt1179ka-v1 bytes, dist/jev, contracts.js debecb30…)
 *   NEW = ../../dist/src/jev                           (real tsc output of src/jev; no fixture fallback)
 *
 * Each test drives the SAME synthetic input through both and asserts the old defect and the
 * new behaviour in one place, so the delta is evidence rather than a rewritten expectation.
 * The old build is read-only here; neither build is modified.
 *
 * FINDING 1 is absent by necessity: `modelEffortTarget` no longer exists, so the old oracle
 * cannot be expressed against the new bytes at all. That is demonstrated instead by the
 * module-load SyntaxError in output/logs-r2/old-oracles-vs-new-bytes.tap.
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
  requestInput, stateInput, priceEvidence, boundEvidenceInput, expectOk,
  LEAK_SENTINEL, CEILING_NANO_USD_50, PRICED_MODEL, sequenceAccessor, sparseArray,
} from './tc-support.mjs';

/* --------------------------------------------------- API surface: the removed function */

test('BEFORE/AFTER — API 1: modelEffortTarget existed, workerTarget replaces it', () => {
  assert.equal(typeof oldContracts.modelEffortTarget, 'function', 'old build exported it');
  assert.equal(newContracts.modelEffortTarget, undefined, 'new build does not');
  assert.equal(typeof newContracts.workerTarget, 'function', 'new build exports the replacement');
  assert.equal(oldContracts.workerTarget, undefined, 'old build had no replacement');

  // The concrete gap that FINDING 1 named, shown on both builds with the same input.
  const observed = 'claude-opus-5[1m]';
  assert.equal(oldContracts.modelEffortTarget(observed, 'high').ok, false,
    'OLD: the observed worker model could not be expressed');
  assert.equal(newContracts.workerTarget({ cli: 'claude', model: observed, effort: { kind: 'level', level: 'high' } }).ok,
    true, 'NEW: cli + model + effort is one representable tuple');

  // The JEV evaluator id namespace is unchanged across both builds.
  assert.equal(oldContracts.versionedModelId(PRICED_MODEL, '$'), PRICED_MODEL);
  assert.equal(newContracts.versionedModelId(PRICED_MODEL, '$'), PRICED_MODEL);
  assert.throws(() => newContracts.versionedModelId('jev-latest', '$'), /alias/i);
});

/* ------------------------------------------------------------ FINDING 2: path echo */

test('BEFORE/AFTER — FINDING 2: an unknown key was echoed into reason.path, now it is not', () => {
  const input = { ...requestInput(), [LEAK_SENTINEL]: 1 };
  const before = oldContracts.buildEvaluationRequest(input);
  const after = newContracts.buildEvaluationRequest(input);

  assert.equal(before.ok, false);
  assert.equal(before.reason.path, `$.${LEAK_SENTINEL}`, 'OLD: caller key copied verbatim');
  assert.ok(before.reason.path.includes(LEAK_SENTINEL));

  assert.equal(after.ok, false);
  assert.equal(after.reason.path, '$', 'NEW: parent path only');
  assert.equal(after.reason.path.includes(LEAK_SENTINEL), false);
  assert.equal(before.reason.message, after.reason.message, 'the message was already a constant in both');
});

test('BEFORE/AFTER — FINDING 2: a 4096-byte hostile key no longer reaches the refusal', () => {
  const key = 'a'.repeat(4096);
  const input = { ...requestInput(), [key]: 1 };
  const before = oldContracts.buildEvaluationRequest(input);
  const after = newContracts.buildEvaluationRequest(input);
  assert.equal(before.reason.path.length, key.length + 2, 'OLD: path grew with the caller key');
  assert.equal(after.reason.path, '$', 'NEW: bounded constant');
});

test('BEFORE/AFTER — FINDING 2: caller-named question and option keys are now placeholders', () => {
  const input = requestInput({
    questions: { 'q-one': { type: 'choice', instructions: 'pick', criteria: { 'BAD-OPT': 'a', b: 'B' } } },
  });
  const before = oldContracts.buildEvaluationRequest(input);
  const after = newContracts.buildEvaluationRequest(input);
  assert.equal(before.reason.path, '$.questions.q-one.criteria.<option>', 'OLD: the question id leaked');
  assert.equal(after.reason.path, '$.questions.<question>.criteria.<option>', 'NEW: fully placeholdered');
});

/* --------------------------------------------------------- FINDING 3: price evidence */

test('BEFORE/AFTER — FINDING 3a: a future-dated price row resolved, now it is refused', () => {
  const evidence = priceEvidence({
    verifiedAt: '2026-09-20T00:00:00Z', now: '2026-09-20T00:00:00Z',
    maxAgeMs: oldPrice.MAX_EVIDENCE_AGE_MS,
  });
  const before = oldPrice.resolveInputTokenPrice(evidence);
  const after = newPrice.resolveInputTokenPrice(evidence);
  assert.equal(before.ok, true, 'OLD: a price evidenced 7 days after `now` resolved');
  assert.equal(after.ok, false, 'NEW: refused');
  assert.equal(after.reason.code, 'invalid-value');
  assert.equal(after.reason.path, '$.evidencedAt');
});

test('BEFORE/AFTER — FINDING 3b: prototype-supplied and __proto__ evidence no longer pass', () => {
  const inherited = Object.create({ catalogStatus: 'verified-fresh', maxAgeMs: 86_400_000 });
  Object.assign(inherited, {
    requestedModel: PRICED_MODEL, verifiedAt: '2026-09-27T12:00:00Z',
    observedVersionedIds: [PRICED_MODEL], now: '2026-09-27T12:30:00Z',
  });
  assert.equal(oldPrice.resolveInputTokenPrice(inherited).ok, true, 'OLD: inherited fields satisfied it');
  assert.equal(newPrice.resolveInputTokenPrice(inherited).ok, false, 'NEW: refused');
  assert.equal(newPrice.resolveInputTokenPrice(inherited).reason.code, 'invalid-shape');

  const parsed = JSON.parse(`{"requestedModel":"${PRICED_MODEL}","catalogStatus":"verified-fresh",`
    + `"verifiedAt":"2026-09-27T12:00:00Z","observedVersionedIds":["${PRICED_MODEL}"],`
    + '"now":"2026-09-27T12:30:00Z","maxAgeMs":86400000,"__proto__":{"x":1}}');
  assert.equal(oldPrice.resolveInputTokenPrice(parsed).ok, true, 'OLD: reserved key ignored');
  assert.equal(newPrice.resolveInputTokenPrice(parsed).reason.code, 'reserved-key', 'NEW: refused');
  assert.equal(Object.prototype.x, undefined);
});

test('BEFORE/AFTER — FINDING 3c: the double read of verifiedAt is gone and no getter runs', () => {
  const buildEvidence = () => {
    const evidence = priceEvidence();
    delete evidence.verifiedAt;
    const reads = sequenceAccessor(evidence, 'verifiedAt', ['2026-09-27T12:00:00Z', 'not-a-timestamp']);
    return [evidence, reads];
  };
  const [oldEvidence, oldReads] = buildEvidence();
  const before = oldPrice.resolveInputTokenPrice(oldEvidence);
  assert.equal(before.ok, true, 'OLD: validation passed on read #1');
  assert.equal(oldReads(), 2, 'OLD: read exactly twice');
  assert.equal(before.value.catalogVerifiedAt, 'not-a-timestamp', 'OLD: returned the unvalidated read #2');

  const [newEvidence, newReads] = buildEvidence();
  const after = newPrice.resolveInputTokenPrice(newEvidence);
  assert.equal(after.ok, false, 'NEW: the accessor itself is refused');
  assert.equal(after.reason.code, 'invalid-shape');
  assert.equal(newReads(), 0, 'NEW: the getter never ran, so there is no read #2 to poison');
});

test('BEFORE/AFTER — FINDING 3d: impossible calendar days were accepted, now refused', () => {
  const evidence = priceEvidence({ verifiedAt: '2026-09-31T00:00:00Z', now: '2026-10-02T00:00:00Z',
    maxAgeMs: oldPrice.MAX_EVIDENCE_AGE_MS });
  assert.equal(oldPrice.resolveInputTokenPrice(evidence).ok, true, 'OLD: September 31 resolved');
  const after = newPrice.resolveInputTokenPrice(evidence);
  assert.equal(after.ok, false, 'NEW: refused');
  assert.equal(after.reason.message, 'Invalid timestamp');

  // In reserve.ts the old build did not even parse the instant.
  const bound = { ...boundEvidenceInput().evidence, observedAt: '2026-02-31T12:00:00Z' };
  assert.equal(oldReserve.declareVerifiedBillableInputBound(boundEvidenceInput({ evidence: bound })).ok, true,
    'OLD: stored an impossible observation date verbatim');
  assert.equal(newReserve.declareVerifiedBillableInputBound(boundEvidenceInput({ evidence: bound })).ok, false,
    'NEW: refused');

  // And a real leap day is still accepted by the new build, so the fix is not a blanket ban.
  const leap = { ...boundEvidenceInput().evidence, observedAt: '2028-02-29T12:00:00Z' };
  assert.equal(newReserve.declareVerifiedBillableInputBound(boundEvidenceInput({ evidence: leap })).ok, true);
});

test('BEFORE/AFTER — FINDING 3e: sparse arrays skipped validation, now they are refused', () => {
  const sparse = sparseArray(Array.from({ length: 64 }, () => PRICED_MODEL), 1);
  assert.equal(oldPrice.resolveInputTokenPrice(priceEvidence({ observedVersionedIds: sparse })).ok, true,
    'OLD: 62 holes went unvalidated');
  const after = newPrice.resolveInputTokenPrice(priceEvidence({ observedVersionedIds: sparse }));
  assert.equal(after.ok, false, 'NEW: refused');
  assert.equal(after.reason.message, 'Expected a dense JSON array');

  // The same class of gap existed for request arrays and is closed there too.
  const holedCapabilities = requestInput({
    state: stateInput({
      candidates: [{ id: 'cand-a', capabilities: sparseArray(['read', 'shell'], 0), description: 'x y' }],
    }),
  });
  assert.equal(oldContracts.buildEvaluationRequest(holedCapabilities).ok, false, 'OLD: refused, but by luck');
  assert.equal(newContracts.buildEvaluationRequest(holedCapabilities).reason.message, 'Expected a dense JSON array');
});

test('BEFORE/AFTER — FINDING 3: unknown price-evidence keys were ignored, now refused', () => {
  const evidence = priceEvidence({ catalogStatusOverride: 'verified-fresh' });
  assert.equal(oldPrice.resolveInputTokenPrice(evidence).ok, true, 'OLD: silently ignored');
  const after = newPrice.resolveInputTokenPrice(evidence);
  assert.equal(after.reason.code, 'unknown-field', 'NEW: refused');
  assert.equal(after.reason.path, '$');
});

/* ------------------------------------------------------------- FINDING 4: budget */

test('BEFORE/AFTER — FINDING 4a: a forged price row produced a negative reserve, now refused', () => {
  const price = expectOk(oldPrice.resolveInputTokenPrice(priceEvidence()));
  const bound = expectOk(oldReserve.declareVerifiedBillableInputBound(boundEvidenceInput()));
  const forged = { ...price, nanoUsdPerInputToken: -42 };

  const before = oldReserve.planReservation(forged, bound);
  assert.equal(before.ok, true, 'OLD: accepted');
  assert.equal(before.value.reserveNanoUsd, -2_688_000, 'OLD: a negative reserve');

  const after = newReserve.planReservation(forged, bound);
  assert.equal(after.ok, false, 'NEW: refused');
  assert.equal(after.reason.code, 'invalid-value');
  assert.equal(after.reason.path, '$.price.nanoUsdPerInputToken');
});

test('BEFORE/AFTER — FINDING 4a: the incoherent negative settlement is now unreachable', () => {
  const price = expectOk(oldPrice.resolveInputTokenPrice(priceEvidence()));
  const bound = expectOk(oldReserve.declareVerifiedBillableInputBound(boundEvidenceInput()));
  const forgedPlan = expectOk(oldReserve.planReservation({ ...price, nanoUsdPerInputToken: -42 }, bound));

  const before = expectOk(oldReserve.computeSettlement(forgedPlan, { input_tokens: 1_000 }));
  assert.equal(before.kind, 'reserve-model-falsified');
  assert.equal(before.settledNanoUsd, -42_000, 'OLD: a negative charge');
  assert.equal(before.overrunNanoUsd, 2_646_000, 'OLD: with a positive overrun — contradictory');

  const after = newReserve.computeSettlement(forgedPlan, { input_tokens: 1_000 });
  assert.equal(after.ok, false, 'NEW: the plan is revalidated and refused');
  assert.equal(after.reason.path, '$.plan.nanoUsdPerInputToken');
  assert.equal('value' in after, false, 'NEW: no amount of any sign is produced');
});

test('BEFORE/AFTER — FINDING 4b: the triple-read accessor exploit is closed', () => {
  const build = () => {
    const input = {
      ceilingNanoUsd: CEILING_NANO_USD_50, spentNanoUsd: 0, liveReservedNanoUsd: 0,
    };
    const reads = sequenceAccessor(input, 'reserveNanoUsd', [1, 1, -1_000_000_000]);
    return [input, reads];
  };
  const [oldInput, oldReads] = build();
  const before = oldReserve.checkCeiling(oldInput);
  assert.equal(before.ok, true, 'OLD: passed both guards');
  assert.equal(oldReads(), 3, 'OLD: three reads of the same property');
  assert.equal(before.value.committedNanoUsd, -1_000_000_000);
  assert.ok(before.value.remainingAfterReserveNanoUsd > CEILING_NANO_USD_50,
    'OLD: reported more budget remaining than the ceiling');

  const [newInput, newReads] = build();
  const after = newReserve.checkCeiling(newInput);
  assert.equal(after.ok, false, 'NEW: refused');
  assert.equal(after.reason.code, 'invalid-shape');
  assert.equal(newReads(), 0, 'NEW: zero reads — the accessor never runs');
});

test('BEFORE/AFTER — FINDING 4c: malformed usage refused, now retains the full reserve', () => {
  const price = expectOk(oldPrice.resolveInputTokenPrice(priceEvidence()));
  const bound = expectOk(oldReserve.declareVerifiedBillableInputBound(boundEvidenceInput()));
  const validPlan = expectOk(oldReserve.planReservation(price, bound));

  for (const usage of [{ input_tokens: -1 }, { input_tokens: '1000' }, {}, null]) {
    const before = oldReserve.computeSettlement(validPlan, usage);
    assert.equal(before.ok, false, `OLD refused ${JSON.stringify(usage)}`);
    assert.equal('value' in before, false, 'OLD: no retained amount existed');

    const after = expectOk(newReserve.computeSettlement(validPlan, usage));
    assert.deepEqual(after, { kind: 'unknown-retained', settledNanoUsd: validPlan.reserveNanoUsd },
      `NEW retained ${JSON.stringify(usage)}`);
  }
});

/* ------------------------------------------- preserved behaviour across both builds */

test('BEFORE/AFTER — behaviours that were already correct are identical in both builds', () => {
  const oldRequest = expectOk(oldContracts.buildEvaluationRequest(requestInput()));
  const newRequest = expectOk(newContracts.buildEvaluationRequest(requestInput()));
  assert.deepEqual(newRequest, oldRequest, 'the accepted request is byte-for-byte the same shape');

  const oldPriceValue = expectOk(oldPrice.resolveInputTokenPrice(priceEvidence()));
  const newPriceValue = expectOk(newPrice.resolveInputTokenPrice(priceEvidence()));
  assert.deepEqual(newPriceValue, oldPriceValue, 'the resolved price is unchanged: 42 / 0 nanoUSD');

  const oldPlan = expectOk(oldReserve.planReservation(
    oldPriceValue, expectOk(oldReserve.declareVerifiedBillableInputBound(boundEvidenceInput()))));
  const newPlan = expectOk(newReserve.planReservation(
    newPriceValue, expectOk(newReserve.declareVerifiedBillableInputBound(boundEvidenceInput()))));
  assert.deepEqual(newPlan, oldPlan, 'the plan arithmetic is unchanged: 64000 x 42');

  const ceiling = {
    ceilingNanoUsd: CEILING_NANO_USD_50, spentNanoUsd: 0, liveReservedNanoUsd: 0,
    reserveNanoUsd: newPlan.reserveNanoUsd,
  };
  assert.deepEqual(expectOk(newReserve.checkCeiling(ceiling)), expectOk(oldReserve.checkCeiling(ceiling)));
  assert.deepEqual(expectOk(newReserve.computeSettlement(newPlan, { input_tokens: 100_000 })),
    expectOk(oldReserve.computeSettlement(oldPlan, { input_tokens: 100_000 })),
    'the untruncated overrun settlement is unchanged');
  assert.deepEqual(newContracts.LIMITS, oldContracts.LIMITS, 'no validation bound was widened');
  assert.equal(newPrice.MAX_EVIDENCE_AGE_MS, oldPrice.MAX_EVIDENCE_AGE_MS, 'no freshness window was widened');
  assert.deepEqual(newContracts.KNOWN_ALIASES, oldContracts.KNOWN_ALIASES);
  assert.deepEqual(newPrice.KNOWN_PRICES, oldPrice.KNOWN_PRICES);
});
