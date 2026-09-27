/** Finding-4 retest (jt1179ka-v2): reserve helpers, ceiling arithmetic and settlement.
 *
 * Runs against the real tsc output in ../../dist/src/jev (no fixture fallback). v1 refusals that were
 * already correct are asserted unchanged; the FINDING 4x oracles are replaced by acceptance
 * tests for the intended behaviour. The original defect oracles are preserved verbatim in
 * output/r1-preserved and re-run in output/r2-old-oracle-probe.
 *
 * Scope discipline, unchanged from v1 and still true of the corrected bytes:
 *  - This is arithmetic. Nothing here enforces a budget, and no assertion below is evidence
 *    of concurrency safety, an atomic store, or live provider billing. Two callers can both
 *    pass checkCeiling on the same stale inputs.
 *  - The 64k figure in p02 is a CONTEXT ceiling. It is never a spend bound, and every use of
 *    64000 below is an explicitly SYNTHETIC test declaration, not a provider fact.
 *  - USD 50 is one user's configured aggregate maximum for this task, not a default and not
 *    permission to make a paid call. No test authorizes a real call.
 *  - A TypeScript cast is not authority: every forged argument below is plain JS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_BILLABLE_INPUT_BOUND, declareVerifiedBillableInputBound,
  planReservation, checkCeiling, computeSettlement,
} from '../../dist/src/jev/reserve.js';
import { resolveInputTokenPrice } from '../../dist/src/jev/price-table.js';
import {
  priceEvidence, boundEvidenceInput, expectOk, PRICED_MODEL,
  CEILING_NANO_USD_50, sequenceAccessor, trapAccessor, hiddenProperty,
} from './tc-support.mjs';

const price = expectOk(resolveInputTokenPrice(priceEvidence()));
const verifiedBound = expectOk(declareVerifiedBillableInputBound(boundEvidenceInput()));
const plan = expectOk(planReservation(price, verifiedBound));

/* ------------------------------------------------- the shipped provider bound */

test('the shipped provider billable bound is still unverified; 64k is not a guessed ceiling', () => {
  assert.equal(PROVIDER_BILLABLE_INPUT_BOUND.status, 'unverified');
  assert.match(PROVIDER_BILLABLE_INPUT_BOUND.reason, /CONTEXT ceiling/);
  assert.equal(Object.isFrozen(PROVIDER_BILLABLE_INPUT_BOUND), true);
  const result = planReservation(price, PROVIDER_BILLABLE_INPUT_BOUND);
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, 'budget-bound-unverified');
  assert.equal(result.reason.path, '$.bound');
  assert.equal(Object.prototype.hasOwnProperty.call(PROVIDER_BILLABLE_INPUT_BOUND, 'maxBillableInputTokens'), false,
    'the shipped bound carries no number that could be mistaken for a spend ceiling');
});

/* --------------------------------------------------- declaring a verified bound */

test('positive: an explicit dated SYNTHETIC declaration produces a verified bound', () => {
  assert.equal(verifiedBound.status, 'verified');
  assert.equal(verifiedBound.maxBillableInputTokens, 64_000);
  assert.match(verifiedBound.evidence.statement, /SYNTHETIC/);
  assert.equal(verifiedBound.evidence.observedAt, '2026-09-27T12:00:00Z');
});

test('nonpositive, unsafe and non-integer token bounds are refused', () => {
  for (const bad of [0, -1, -64_000, 1.5, Number.NaN, Infinity, 2 ** 53, 10_000_001, '64000', null, undefined]) {
    const result = declareVerifiedBillableInputBound(boundEvidenceInput({ maxBillableInputTokens: bad }));
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.reason.code, 'invalid-value');
    assert.equal(result.reason.path, '$.maxBillableInputTokens');
  }
  assert.equal(declareVerifiedBillableInputBound(boundEvidenceInput({ maxBillableInputTokens: 10_000_000 })).ok, true,
    'the declarable sanity ceiling itself is accepted');
  assert.equal(declareVerifiedBillableInputBound(boundEvidenceInput({ maxBillableInputTokens: 1 })).ok, true,
    'the minimum positive bound is accepted');
});

test('the evidence block must be a present object with three nonempty bounded strings', () => {
  for (const bad of [null, undefined, 42, 'source', []]) {
    const result = declareVerifiedBillableInputBound(boundEvidenceInput({ evidence: bad }));
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.reason.code, 'invalid-shape');
    assert.equal(result.reason.path, '$.evidence');
  }
  for (const key of ['source', 'observedAt', 'statement']) {
    for (const bad of ['', '   ', 42, null, undefined, 'x'.repeat(1025)]) {
      const evidence = { ...boundEvidenceInput().evidence, [key]: bad };
      const result = declareVerifiedBillableInputBound(boundEvidenceInput({ evidence }));
      assert.equal(result.ok, false, `${key}=${String(bad)}`);
      assert.equal(result.reason.path, `$.evidence.${key}`);
    }
  }
});

test('the observedAt instant must be UTC RFC3339', () => {
  for (const bad of ['2026-09-27', '2026-09-27T12:00:00-07:00', '2026-09-27T24:00:00Z',
    '2026-09-27T12:60:00Z', '2026-09-27 12:00:00Z']) {
    const evidence = { ...boundEvidenceInput().evidence, observedAt: bad };
    const result = declareVerifiedBillableInputBound(boundEvidenceInput({ evidence }));
    assert.equal(result.ok, false, bad);
    assert.equal(result.reason.path, '$.evidence.observedAt');
  }
});

test('FIXED 3d: an impossible calendar day is now refused as an observedAt instant', () => {
  // Was: reserve.ts had its own TIMESTAMP_PATTERN and never called Date.parse, so
  // '2026-02-31' was stored verbatim as the instant a provider statement was observed.
  for (const impossible of ['2026-02-31T12:00:00Z', '2026-09-31T12:00:00Z', '2026-02-30T12:00:00Z',
    '2027-02-29T12:00:00Z', '1900-02-29T12:00:00Z']) {
    const evidence = { ...boundEvidenceInput().evidence, observedAt: impossible };
    const result = declareVerifiedBillableInputBound(boundEvidenceInput({ evidence }));
    assert.equal(result.ok, false, impossible);
    assert.equal(result.reason.code, 'invalid-value');
    assert.equal(result.reason.path, '$.evidence.observedAt');
    assert.equal(result.reason.message, 'Invalid timestamp');
  }
  // Real leap days are still accepted.
  for (const real of ['2028-02-29T12:00:00Z', '2000-02-29T12:00:00Z', '2024-02-29T12:00:00Z']) {
    const evidence = { ...boundEvidenceInput().evidence, observedAt: real };
    assert.equal(declareVerifiedBillableInputBound(boundEvidenceInput({ evidence })).ok, true, real);
  }
});

test('FIXED: unknown keys on the bound and on its evidence are refused, not ignored', () => {
  const outer = declareVerifiedBillableInputBound(boundEvidenceInput({ status: 'verified' }));
  assert.equal(outer.ok, false);
  assert.equal(outer.reason.code, 'unknown-field');
  assert.equal(outer.reason.path, '$');
  const inner = declareVerifiedBillableInputBound(boundEvidenceInput({
    evidence: { ...boundEvidenceInput().evidence, url: 'https://example.invalid' },
  }));
  assert.equal(inner.ok, false);
  assert.equal(inner.reason.code, 'unknown-field');
  assert.equal(inner.reason.path, '$.evidence');
});

test('non-object, accessor-backed and inherited bound inputs are refused without running getters', () => {
  for (const bad of [null, undefined, 42, 'bound', [boundEvidenceInput()]]) {
    const result = declareVerifiedBillableInputBound(bad);
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.reason.code, 'invalid-shape');
  }
  const accessor = boundEvidenceInput();
  delete accessor.maxBillableInputTokens;
  const reads = trapAccessor(accessor, 'maxBillableInputTokens');
  assert.equal(declareVerifiedBillableInputBound(accessor).reason.code, 'invalid-shape');
  assert.equal(reads(), 0);

  const inherited = Object.create({ maxBillableInputTokens: 64_000 });
  inherited.evidence = boundEvidenceInput().evidence;
  assert.equal(declareVerifiedBillableInputBound(inherited).reason.code, 'invalid-shape');
});

/* ------------------------------------------------------- planning a reservation */

test('positive: a plan is maxBillableInputTokens times the evidenced rate, in integer nanoUSD', () => {
  assert.equal(plan.versionedId, PRICED_MODEL);
  assert.equal(plan.nanoUsdPerInputToken, 42);
  assert.equal(plan.maxBillableInputTokens, 64_000);
  assert.equal(plan.reserveNanoUsd, 64_000 * 42);
  assert.equal(plan.reserveNanoUsd, 2_688_000, 'USD 0.002688 at the SYNTHETIC declared bound');
  assert.equal(plan.priceEvidencedAt, '2026-09-27');
  assert.equal(plan.boundEvidence.observedAt, '2026-09-27T12:00:00Z');
});

test('a nonzero output rate leaves the reserve model unbounded and is refused', () => {
  const result = planReservation({ ...price, nanoUsdPerOutputToken: 1 }, verifiedBound);
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, 'budget-bound-unverified');
  assert.equal(result.reason.path, '$.price.nanoUsdPerOutputToken');
});

test('FIXED 4a: planReservation now validates the price row at runtime', () => {
  // Was: neither the price row nor the bound number was checked, so a forged row produced a
  // negative or fractional reserve with no refusal at all.
  const cases = [
    [{ nanoUsdPerInputToken: -42 }, 'invalid-value', '$.price.nanoUsdPerInputToken'],
    [{ nanoUsdPerInputToken: 0 }, 'invalid-value', '$.price.nanoUsdPerInputToken'],
    [{ nanoUsdPerInputToken: 0.5 }, 'invalid-value', '$.price.nanoUsdPerInputToken'],
    [{ nanoUsdPerInputToken: 2 ** 53 }, 'invalid-value', '$.price.nanoUsdPerInputToken'],
    [{ nanoUsdPerInputToken: Number.NaN }, 'invalid-value', '$.price.nanoUsdPerInputToken'],
    [{ nanoUsdPerOutputToken: -1 }, 'invalid-value', '$.price.nanoUsdPerOutputToken'],
    [{ versionedId: 'jev-latest' }, 'model-alias', '$.price.versionedId'],
    [{ versionedId: 'claude-opus-5[1m]' }, 'invalid-value', '$.price.versionedId'],
    [{ catalogVerifiedAt: '2026-02-31T00:00:00Z' }, 'invalid-value', '$.price.catalogVerifiedAt'],
  ];
  for (const [override, code, path] of cases) {
    const result = planReservation({ ...price, ...override }, verifiedBound);
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.equal(result.reason.code, code, JSON.stringify(override));
    assert.equal(result.reason.path, path);
  }
});

test('FIXED 4a: a rate, day or source that no resolver produced cannot set its own price', () => {
  // The rate must equal the dated KNOWN_PRICES row exactly; a plausible-looking 43 is refused.
  const offRate = planReservation({ ...price, nanoUsdPerInputToken: 43 }, verifiedBound);
  assert.equal(offRate.ok, false);
  assert.equal(offRate.reason.code, 'invalid-value');
  assert.equal(offRate.reason.message, 'Price does not match the dated observation for this model');

  const offDay = planReservation({ ...price, priceEvidencedAt: '2026-09-26' }, verifiedBound);
  assert.equal(offDay.ok, false);
  assert.equal(offDay.reason.code, 'invalid-value');

  const offSource = planReservation({ ...price, priceSource: 'invented source' }, verifiedBound);
  assert.equal(offSource.ok, false);
  assert.equal(offSource.reason.path, '$.price.priceSource');

  const unpriced = planReservation({ ...price, versionedId: 'jev-1.14.0' }, verifiedBound);
  assert.equal(unpriced.ok, false);
  assert.equal(unpriced.reason.code, 'model-unpriced');
});

test('FIXED 4a: planReservation now validates the bound number and its evidence', () => {
  for (const tokens of [-5, 0, 1.5, Number.NaN, 10_000_001, '64000', null]) {
    const forged = { status: 'verified', maxBillableInputTokens: tokens, evidence: verifiedBound.evidence };
    const result = planReservation(price, forged);
    assert.equal(result.ok, false, String(tokens));
    assert.equal(result.reason.code, 'invalid-value');
    assert.equal(result.reason.path, '$.bound.maxBillableInputTokens');
  }
  const noEvidence = planReservation(price, { status: 'verified', maxBillableInputTokens: 64_000 });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.reason.path, '$.bound.evidence');
});

test('FIXED 4a: a forged verified bound cannot smuggle an unverified reason field', () => {
  const smuggled = planReservation(price, {
    status: 'verified', reason: 'no evidence at all',
    maxBillableInputTokens: 64_000, evidence: verifiedBound.evidence,
  });
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.reason.code, 'unknown-field');
  assert.equal(smuggled.reason.path, '$.bound');
});

test('FIXED 4a: the negative reserve is now unreachable, so no plan can carry one', () => {
  // Every route that produced a negative reserveNanoUsd in v1 is refused above. Asserted here
  // as a property of the whole entrypoint rather than of one input.
  const attempts = [
    () => planReservation({ ...price, nanoUsdPerInputToken: -42 }, verifiedBound),
    () => planReservation(price, { status: 'verified', maxBillableInputTokens: -5, evidence: verifiedBound.evidence }),
    () => planReservation({ ...price, nanoUsdPerInputToken: -1 },
      { status: 'verified', maxBillableInputTokens: -1, evidence: verifiedBound.evidence }),
  ];
  for (const attempt of attempts) {
    const result = attempt();
    assert.equal(result.ok, false);
  }
  assert.ok(plan.reserveNanoUsd > 0, 'the only plan that resolves carries a positive reserve');
});

test('the product overflow path is now unreachable by construction, and stays fail-closed', () => {
  // With the rate pinned to the table (42) and the bound capped at 10^7, the largest
  // reachable product is 4.2e8 — far inside the safe integer range. The forged inputs that
  // would have overflowed are refused earlier, as invalid-value rather than unsafe-arithmetic.
  const maxBound = expectOk(declareVerifiedBillableInputBound(boundEvidenceInput({
    maxBillableInputTokens: 10_000_000,
  })));
  const maxPlan = expectOk(planReservation(price, maxBound));
  assert.equal(maxPlan.reserveNanoUsd, 420_000_000);
  assert.ok(Number.isSafeInteger(maxPlan.reserveNanoUsd));
  const overflowAttempt = planReservation({ ...price, nanoUsdPerInputToken: 2 ** 53 }, maxBound);
  assert.equal(overflowAttempt.ok, false);
  assert.equal(overflowAttempt.reason.code, 'invalid-value',
    'refused before arithmetic, not by unsafe-arithmetic');
});

/* ----------------------------------------------------------- ceiling arithmetic */

const ceilingInput = (overrides = {}) => ({
  ceilingNanoUsd: CEILING_NANO_USD_50,
  spentNanoUsd: 0,
  liveReservedNanoUsd: 0,
  reserveNanoUsd: plan.reserveNanoUsd,
  ...overrides,
});

test('positive: plain amounts against the configured USD 50 aggregate maximum', () => {
  const value = expectOk(checkCeiling(ceilingInput()));
  assert.equal(value.committedNanoUsd, 2_688_000);
  assert.equal(value.remainingAfterReserveNanoUsd, CEILING_NANO_USD_50 - 2_688_000);
  assert.equal(value.remainingAfterReserveNanoUsd, 49_997_312_000);
});

test('positive: spent and live reservations aggregate into the committed total', () => {
  const value = expectOk(checkCeiling(ceilingInput({
    spentNanoUsd: 1_000_000_000, liveReservedNanoUsd: 500_000_000,
  })));
  assert.equal(value.committedNanoUsd, 1_000_000_000 + 500_000_000 + 2_688_000);
  assert.equal(value.remainingAfterReserveNanoUsd, CEILING_NANO_USD_50 - value.committedNanoUsd);
});

test('boundary equality with the ceiling is allowed; one nanoUSD more is budget-exhausted', () => {
  const atCeiling = expectOk(checkCeiling(ceilingInput({
    spentNanoUsd: CEILING_NANO_USD_50 - 2_688_000, liveReservedNanoUsd: 0,
  })));
  assert.equal(atCeiling.committedNanoUsd, CEILING_NANO_USD_50);
  assert.equal(atCeiling.remainingAfterReserveNanoUsd, 0);

  const overByOne = checkCeiling(ceilingInput({
    spentNanoUsd: CEILING_NANO_USD_50 - 2_688_000 + 1,
  }));
  assert.equal(overByOne.ok, false);
  assert.equal(overByOne.reason.code, 'budget-exhausted');
  assert.equal(overByOne.reason.path, '$.ceilingNanoUsd');
});

test('the largest declarable single reserve still fits under the configured maximum', () => {
  const maxBound = expectOk(declareVerifiedBillableInputBound(boundEvidenceInput({
    maxBillableInputTokens: 10_000_000,
  })));
  const maxPlan = expectOk(planReservation(price, maxBound));
  assert.equal(maxPlan.reserveNanoUsd, 420_000_000);
  const value = expectOk(checkCeiling(ceilingInput({ reserveNanoUsd: maxPlan.reserveNanoUsd })));
  assert.equal(value.committedNanoUsd, 420_000_000);
  assert.ok(value.committedNanoUsd < CEILING_NANO_USD_50);
});

test('nonpositive, negative, fractional and unsafe ceiling inputs are refused', () => {
  for (const key of ['ceilingNanoUsd', 'spentNanoUsd', 'liveReservedNanoUsd', 'reserveNanoUsd']) {
    for (const bad of [-1, 1.5, Number.NaN, Infinity, -Infinity, 2 ** 53, '1', null, undefined, true]) {
      const result = checkCeiling(ceilingInput({ [key]: bad }));
      assert.equal(result.ok, false, `${key}=${String(bad)}`);
      assert.equal(result.reason.code, 'invalid-value');
      assert.equal(result.reason.path, `$.${key}`);
    }
  }
  for (const bad of [0, -0]) {
    const result = checkCeiling(ceilingInput({ reserveNanoUsd: bad }));
    assert.equal(result.ok, false, `reserveNanoUsd=${String(bad)}`);
    assert.equal(result.reason.code, 'invalid-value');
    assert.equal(result.reason.path, '$.reserveNanoUsd');
  }
});

test('an aggregate that overflows the safe integer range fails closed as unsafe-arithmetic', () => {
  const result = checkCeiling({
    ceilingNanoUsd: Number.MAX_SAFE_INTEGER,
    spentNanoUsd: Number.MAX_SAFE_INTEGER,
    liveReservedNanoUsd: Number.MAX_SAFE_INTEGER,
    reserveNanoUsd: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, 'unsafe-arithmetic');
  assert.equal(result.reason.path, '$.committedNanoUsd');
});

test('FIXED 4b: an accessor-backed ceiling input is refused and its getter NEVER runs', () => {
  // Was: reserveNanoUsd was read three times — validation loop, `<= 0` guard, addition — so a
  // getter returning 1, 1, -1e9 passed both guards and yielded a "remaining" ABOVE the
  // ceiling. Now the snapshot refuses the accessor outright and no getter is invoked.
  const input = ceilingInput();
  delete input.reserveNanoUsd;
  const reads = sequenceAccessor(input, 'reserveNanoUsd', [1, 1, -1_000_000_000]);
  const result = checkCeiling(input);
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, 'invalid-shape');
  assert.equal(result.reason.path, '$');
  assert.equal(reads(), 0, 'the getter must never run, so the 1/1/-1e9 sequence is unreachable');
});

test('FIXED 4b: every ceiling field is read exactly once from a data snapshot', () => {
  for (const key of ['ceilingNanoUsd', 'spentNanoUsd', 'liveReservedNanoUsd', 'reserveNanoUsd']) {
    const input = ceilingInput();
    delete input[key];
    const reads = trapAccessor(input, key);
    assert.equal(checkCeiling(input).reason.code, 'invalid-shape', key);
    assert.equal(reads(), 0, key);
  }
  // Mutating the caller's object after the call cannot change the computed result.
  const stable = ceilingInput();
  const value = expectOk(checkCeiling(stable));
  stable.reserveNanoUsd = -1_000_000_000;
  assert.equal(value.committedNanoUsd, 2_688_000);
  assert.ok(value.remainingAfterReserveNanoUsd < CEILING_NANO_USD_50);
});

test('FIXED 4b: unknown, reserved, symbol, inherited and hidden ceiling keys are refused', () => {
  assert.equal(checkCeiling(ceilingInput({ overdraftAllowed: true })).reason.code, 'unknown-field');
  assert.equal(checkCeiling(JSON.parse(
    '{"ceilingNanoUsd":1,"spentNanoUsd":0,"liveReservedNanoUsd":0,"reserveNanoUsd":1,"__proto__":{"x":1}}',
  )).reason.code, 'reserved-key');
  const symbolic = ceilingInput();
  symbolic[Symbol('marker')] = 1;
  assert.equal(checkCeiling(symbolic).reason.code, 'invalid-shape');
  const inherited = Object.create({ reserveNanoUsd: 1 });
  Object.assign(inherited, { ceilingNanoUsd: 10, spentNanoUsd: 0, liveReservedNanoUsd: 0 });
  assert.equal(checkCeiling(inherited).reason.code, 'invalid-shape');
  const hidden = ceilingInput();
  delete hidden.reserveNanoUsd;
  hiddenProperty(hidden, 'reserveNanoUsd', 1);
  assert.equal(checkCeiling(hidden).reason.code, 'invalid-shape');
});

test('checkCeiling is still arithmetic only: two callers both pass on the same inputs', () => {
  // Recorded as a NON-claim, exactly as in v1. There is no atomic store and no live provider
  // billing guarantee; exclusivity is not in this slice.
  const first = expectOk(checkCeiling(ceilingInput({ spentNanoUsd: CEILING_NANO_USD_50 - 2_688_000 })));
  const second = expectOk(checkCeiling(ceilingInput({ spentNanoUsd: CEILING_NANO_USD_50 - 2_688_000 })));
  assert.equal(first.committedNanoUsd, second.committedNanoUsd);
  assert.equal(first.remainingAfterReserveNanoUsd, 0);
});

/* ---------------------------------------------------------------- settlement */

test('positive: usage within the reserve settles at the actual charge', () => {
  const value = expectOk(computeSettlement(plan, { input_tokens: 1_000 }));
  assert.deepEqual(value, { kind: 'settled', settledNanoUsd: 42_000, actualInputTokens: 1_000 });
  const zero = expectOk(computeSettlement(plan, { input_tokens: 0 }));
  assert.deepEqual(zero, { kind: 'settled', settledNanoUsd: 0, actualInputTokens: 0 });
  const withOutput = expectOk(computeSettlement(plan, { input_tokens: 296, output_tokens: 20 }));
  assert.equal(withOutput.settledNanoUsd, 296 * 42, 'a response usage object with both counts settles');
});

test('positive: usage exactly at the reserve settles, it does not falsify the model', () => {
  const value = expectOk(computeSettlement(plan, { input_tokens: 64_000 }));
  assert.equal(value.kind, 'settled');
  assert.equal(value.settledNanoUsd, plan.reserveNanoUsd);
});

test('a valid overrun settles the FULL actual charge and is never truncated to the reserve', () => {
  for (const tokens of [64_001, 100_000, 1_000_000]) {
    const value = expectOk(computeSettlement(plan, { input_tokens: tokens }));
    assert.equal(value.kind, 'reserve-model-falsified', String(tokens));
    assert.equal(value.settledNanoUsd, tokens * 42);
    assert.equal(value.actualInputTokens, tokens);
    assert.equal(value.reserveNanoUsd, plan.reserveNanoUsd);
    assert.equal(value.overrunNanoUsd, tokens * 42 - plan.reserveNanoUsd);
    assert.equal(value.settledNanoUsd, value.reserveNanoUsd + value.overrunNanoUsd);
    assert.ok(value.settledNanoUsd > plan.reserveNanoUsd, 'the excess is not discarded');
    assert.ok(value.overrunNanoUsd > 0);
  }
});

test('absent usage retains the full reserve and never releases an unknown charge', () => {
  const value = expectOk(computeSettlement(plan, undefined));
  assert.deepEqual(value, { kind: 'unknown-retained', settledNanoUsd: plan.reserveNanoUsd });
});

test('FIXED 4c: MALFORMED usage on a VALID plan now retains the full reserve', () => {
  // Was: malformed usage returned a refusal with no settledNanoUsd, so a caller following the
  // documented union had no retained amount to record. Now it is `unknown-retained`.
  const malformed = [
    { input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: Number.NaN },
    { input_tokens: Infinity }, { input_tokens: '1000' }, { input_tokens: null }, {},
    { input_tokens: 10, output_tokens: -1 }, { input_tokens: 10, cost: 1 },
    null, 42, 'usage', [{ input_tokens: 10 }],
  ];
  for (const usage of malformed) {
    const value = expectOk(computeSettlement(plan, usage));
    assert.deepEqual(value, { kind: 'unknown-retained', settledNanoUsd: plan.reserveNanoUsd },
      JSON.stringify(usage) ?? String(usage));
  }
});

test('FIXED 4c: accessor, inherited and hidden usage carriers retain the reserve, no getter run', () => {
  const accessor = {};
  const reads = trapAccessor(accessor, 'input_tokens');
  const value = expectOk(computeSettlement(plan, accessor));
  assert.equal(value.kind, 'unknown-retained');
  assert.equal(value.settledNanoUsd, plan.reserveNanoUsd);
  assert.equal(reads(), 0);

  const inherited = Object.create({ input_tokens: 1_000 });
  assert.equal(expectOk(computeSettlement(plan, inherited)).kind, 'unknown-retained');

  const hidden = hiddenProperty({}, 'input_tokens', 1_000);
  assert.equal(expectOk(computeSettlement(plan, hidden)).kind, 'unknown-retained');
});

test('FIXED 4a: an INVALID plan is a refusal and never yields any amount', () => {
  // The plan itself is revalidated first, so a forged plan cannot produce a settlement — not
  // even `unknown-retained`, which would otherwise look like a safe fallback.
  const cases = [
    [{ nanoUsdPerInputToken: -42 }, '$.plan.nanoUsdPerInputToken'],
    [{ nanoUsdPerInputToken: 0.5 }, '$.plan.nanoUsdPerInputToken'],
    [{ reserveNanoUsd: -1 }, '$.plan.reserveNanoUsd'],
    [{ reserveNanoUsd: 0 }, '$.plan.reserveNanoUsd'],
    [{ reserveNanoUsd: plan.reserveNanoUsd + 1 }, '$.plan.reserveNanoUsd'],
    [{ maxBillableInputTokens: -5 }, '$.plan.maxBillableInputTokens'],
    [{ versionedId: 'jev-latest' }, '$.plan.versionedId'],
    [{ priceEvidencedAt: '2026-02-31' }, '$.plan.priceEvidencedAt'],
  ];
  for (const [override, path] of cases) {
    for (const usage of [{ input_tokens: 1_000 }, undefined, { input_tokens: -1 }]) {
      const result = computeSettlement({ ...plan, ...override }, usage);
      assert.equal(result.ok, false, `${JSON.stringify(override)} with ${JSON.stringify(usage)}`);
      assert.equal(result.reason.path, path);
      assert.equal('value' in result, false, 'no amount is produced for an invalid plan');
    }
  }
  assert.equal(computeSettlement({ ...plan, extra: 1 }, { input_tokens: 1 }).reason.code, 'unknown-field');
  assert.equal(computeSettlement(null, { input_tokens: 1 }).reason.code, 'invalid-shape');
});

test('FIXED 4a: the reserve must equal bound x rate, so a tampered plan cannot under-reserve', () => {
  const tampered = computeSettlement({ ...plan, reserveNanoUsd: 1 }, { input_tokens: 64_000 });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason.code, 'invalid-value');
  assert.equal(tampered.reason.message, 'Reserve is not the bound times the rate');
});

test('an unsafe settlement product still fails closed as unsafe-arithmetic', () => {
  // RESIDUAL the coder documented: a well-formed but enormous token count is refused rather
  // than settled. Recorded as an unmeasured caller obligation, not as a settled amount.
  const result = computeSettlement(plan, { input_tokens: Number.MAX_SAFE_INTEGER });
  assert.equal(result.ok, false);
  assert.equal(result.reason.code, 'unsafe-arithmetic');
  assert.equal(result.reason.path, '$.settledNanoUsd');
  assert.equal('value' in result, false);
});
