/** Positive control across the three modules: price -> bound -> plan -> ceiling -> request ->
 * response -> settlement, with no product code and no paid call anywhere.
 *
 * This proves the modules compose on a happy path. It proves nothing about provider transport,
 * account eligibility, store enforcement, or concurrency, and it authorizes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEvaluationRequest, validateEvaluationResponse } from '../../dist/src/jev/contracts.js';
import { resolveInputTokenPrice } from '../../dist/src/jev/price-table.js';
import { declareVerifiedBillableInputBound, planReservation, checkCeiling, computeSettlement }
  from '../../dist/src/jev/reserve.js';
import {
  priceEvidence, boundEvidenceInput, requestInput, responseFor, expectOk,
  PRICED_MODEL, CEILING_NANO_USD_50,
} from './tc-support.mjs';

test('positive: the full happy path composes and settles inside the configured maximum', () => {
  const price = expectOk(resolveInputTokenPrice(priceEvidence()));
  const bound = expectOk(declareVerifiedBillableInputBound(boundEvidenceInput()));
  const plan = expectOk(planReservation(price, bound));
  assert.equal(plan.versionedId, PRICED_MODEL);

  const ceiling = expectOk(checkCeiling({
    ceilingNanoUsd: CEILING_NANO_USD_50,
    spentNanoUsd: 0,
    liveReservedNanoUsd: 0,
    reserveNanoUsd: plan.reserveNanoUsd,
  }));
  assert.equal(ceiling.committedNanoUsd, plan.reserveNanoUsd);

  const request = expectOk(buildEvaluationRequest(requestInput({ model: plan.versionedId })));
  const response = expectOk(validateEvaluationResponse(responseFor(request), request));
  assert.equal(response.model, plan.versionedId);

  const settlement = expectOk(computeSettlement(plan, response.usage));
  assert.equal(settlement.kind, 'settled');
  assert.equal(settlement.actualInputTokens, 296);
  assert.equal(settlement.settledNanoUsd, 296 * 42);
  assert.ok(settlement.settledNanoUsd < plan.reserveNanoUsd);
  assert.ok(settlement.settledNanoUsd < CEILING_NANO_USD_50);
});

test('a refused response never reaches settlement, so the reserve is retained instead', () => {
  const price = expectOk(resolveInputTokenPrice(priceEvidence()));
  const plan = expectOk(planReservation(price, expectOk(declareVerifiedBillableInputBound(boundEvidenceInput()))));
  const request = expectOk(buildEvaluationRequest(requestInput({ model: plan.versionedId })));

  const wrongModel = validateEvaluationResponse(responseFor(request, { model: 'jev-1.13.1' }), request);
  assert.equal(wrongModel.ok, false);
  assert.equal(wrongModel.reason.code, 'model-mismatch');

  // The caller has no validated usage, so the only correct settlement is the retained reserve.
  const retained = expectOk(computeSettlement(plan, undefined));
  assert.deepEqual(retained, { kind: 'unknown-retained', settledNanoUsd: plan.reserveNanoUsd });
});

test('the price-resolution refusal that ships today blocks the whole path', () => {
  // An unverified catalog is the honest default, and it stops before any request is built.
  const unresolved = resolveInputTokenPrice(priceEvidence({ catalogStatus: 'unverified' }));
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.reason.code, 'catalog-unverified');
});
