/** Finding-3 retest (jt1179ka-v2): price evidence, freshness, calendar correctness, key safety.
 *
 * Runs against the real tsc output in ../../dist/src/jev (no fixture fallback). Every v1 refusal that was
 * already correct is asserted unchanged; the five FINDING 3x oracles are replaced by
 * acceptance tests for the intended behaviour. The original defect oracles are preserved
 * verbatim in output/r1-preserved and re-run in output/r2-old-oracle-probe.
 *
 * Every refusal here is fail-closed and the caller's only correct branch is "no paid call".
 * No test authorizes a call, supplies a credential, or fabricates provider permission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInputTokenPrice, findPriceRecord, KNOWN_PRICES, MAX_EVIDENCE_AGE_MS,
} from '../../dist/src/jev/price-table.js';
import { LIMITS, KNOWN_ALIASES } from '../../dist/src/jev/contracts.js';
import {
  priceEvidence, expectOk, PRICED_MODEL, trapAccessor, hiddenProperty, sparseArray,
} from './tc-support.mjs';

const refusal = (evidence) => {
  const result = resolveInputTokenPrice(evidence);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.reason;
};

/* ---------------------------------------------------------------- positive */

test('positive: the single evidenced row resolves with the p02 rate of 42 nanoUSD per input token', () => {
  const value = expectOk(resolveInputTokenPrice(priceEvidence()));
  assert.equal(value.versionedId, PRICED_MODEL);
  assert.equal(value.nanoUsdPerInputToken, 42);
  assert.equal(value.nanoUsdPerOutputToken, 0);
  assert.equal(value.priceEvidencedAt, '2026-09-27');
  assert.equal(value.catalogVerifiedAt, '2026-09-27T12:00:00Z');
  assert.match(value.priceSource, /docs\.typesafe\.ai\/models/);
});

test('positive: the table holds exactly one dated row and never interpolates neighbours', () => {
  assert.equal(KNOWN_PRICES.length, 1);
  assert.equal(findPriceRecord(PRICED_MODEL).nanoUsdPerInputToken, 42);
  for (const neighbour of ['jev-1.12.0', 'jev-1.13.1', 'jev-1.14.0', 'jev-2.0.0']) {
    assert.equal(findPriceRecord(neighbour), undefined, neighbour);
  }
  for (const alias of KNOWN_ALIASES) assert.equal(findPriceRecord(alias), undefined, alias);
  assert.equal(Object.isFrozen(KNOWN_PRICES), true);
});

test('positive: a +00:00 offset is accepted as an equivalent UTC instant', () => {
  const value = expectOk(resolveInputTokenPrice(priceEvidence({
    verifiedAt: '2026-09-27T12:00:00+00:00', now: '2026-09-27T12:30:00+00:00',
  })));
  assert.equal(value.catalogVerifiedAt, '2026-09-27T12:00:00+00:00');
});

test('positive: the widest permitted freshness window still resolves inside that window', () => {
  const value = expectOk(resolveInputTokenPrice(priceEvidence({
    maxAgeMs: MAX_EVIDENCE_AGE_MS, verifiedAt: '2026-09-28T00:00:00Z', now: '2026-10-02T00:00:00Z',
  })));
  assert.equal(value.versionedId, PRICED_MODEL);
});

/* ------------------------------------------------------- aliases and unknowns */

test('aliases are refused and are never priced', () => {
  for (const alias of KNOWN_ALIASES) {
    const reason = refusal(priceEvidence({ requestedModel: alias, observedVersionedIds: [PRICED_MODEL] }));
    assert.equal(reason.code, 'model-alias', alias);
    assert.equal(reason.path, '$.requestedModel');
  }
});

test('an unknown but well-formed version is model-unpriced, never a guessed default', () => {
  const reason = refusal(priceEvidence({
    requestedModel: 'jev-1.14.0', observedVersionedIds: ['jev-1.14.0'],
  }));
  assert.equal(reason.code, 'model-unpriced');
});

test('a malformed model id is refused before any pricing lookup', () => {
  for (const bad of [null, undefined, 42, {}, [], 'jev-1.13', 'JEV-1.13.0', 'claude-opus-5[1m]']) {
    const reason = refusal(priceEvidence({ requestedModel: bad }));
    assert.equal(reason.path, '$.requestedModel', JSON.stringify(bad));
    assert.ok(['invalid-value', 'input-limit'].includes(reason.code), `${JSON.stringify(bad)} -> ${reason.code}`);
  }
});

/* --------------------------------------------------------- catalog revalidation */

test('only verified-fresh catalog evidence can resolve; unverified and stale are refused', () => {
  for (const status of ['unverified', 'stale', 'VERIFIED-FRESH', '', null, undefined, true]) {
    const reason = refusal(priceEvidence({ catalogStatus: status }));
    assert.equal(reason.code, 'catalog-unverified', String(status));
    assert.equal(reason.path, '$.catalogStatus');
  }
});

test('the model must appear in the revalidated catalog', () => {
  assert.equal(refusal(priceEvidence({ observedVersionedIds: ['jev-1.12.0'] })).code, 'catalog-mismatch');
  assert.equal(refusal(priceEvidence({ observedVersionedIds: [] })).code, 'invalid-shape');
  assert.equal(refusal(priceEvidence({ observedVersionedIds: PRICED_MODEL })).code, 'invalid-shape');
  assert.equal(refusal(priceEvidence({
    observedVersionedIds: Array.from({ length: LIMITS.catalogEntries + 1 }, () => PRICED_MODEL),
  })).code, 'invalid-shape');
  assert.equal(resolveInputTokenPrice(priceEvidence({
    observedVersionedIds: Array.from({ length: LIMITS.catalogEntries }, (_v, i) => (i === 0 ? PRICED_MODEL : 'jev-1.12.0')),
  })).ok, true, 'exactly at the catalog bound still resolves');
});

test('an alias inside the observed catalog list is refused, not skipped', () => {
  const reason = refusal(priceEvidence({ observedVersionedIds: ['jev-latest', PRICED_MODEL] }));
  assert.equal(reason.code, 'model-alias');
  assert.equal(reason.path, '$.observedVersionedIds[0]');
});

test('non-string entries in the observed catalog are refused', () => {
  assert.equal(refusal(priceEvidence({ observedVersionedIds: [PRICED_MODEL, 42] })).code, 'invalid-value');
  assert.equal(refusal(priceEvidence({ observedVersionedIds: [PRICED_MODEL, 'jev-latest'] })).code, 'model-alias');
  assert.equal(refusal(priceEvidence({ observedVersionedIds: [PRICED_MODEL, undefined] })).code, 'invalid-value');
});

test('FIXED 3e: array holes in the observed catalog are now refused, not skipped', () => {
  // Was: the list went through Array.prototype.map, which SKIPS holes, so 62 of 64 declared
  // ids were never handed to versionedModelId. Now: a dense plain JSON array is required.
  const sparse = sparseArray(Array.from({ length: 64 }, () => PRICED_MODEL), 1);
  assert.equal(sparse.length, 64);
  assert.equal(1 in sparse, false, 'index 1 is a hole, not an undefined value');
  const reason = refusal(priceEvidence({ observedVersionedIds: sparse }));
  assert.equal(reason.code, 'invalid-shape');
  assert.equal(reason.path, '$.observedVersionedIds');
  assert.equal(reason.message, 'Expected a dense JSON array');

  // Explicit undefined in the same position is still refused per entry, as in v1.
  const dense = Array.from({ length: 64 }, (_value, index) => (index === 0 ? PRICED_MODEL : undefined));
  const perEntry = refusal(priceEvidence({ observedVersionedIds: dense }));
  assert.equal(perEntry.code, 'invalid-value');
  assert.equal(perEntry.path, '$.observedVersionedIds[1]');
});

test('FIXED 3e: the catalog length is bounded BEFORE any element is read', () => {
  const oversized = Array.from({ length: 65 }, () => PRICED_MODEL);
  const reads = trapAccessor(oversized, '0');
  const reason = refusal(priceEvidence({ observedVersionedIds: oversized }));
  assert.equal(reason.code, 'invalid-shape');
  assert.equal(reason.path, '$.observedVersionedIds');
  assert.equal(reads(), 0, 'no element getter ran before the length bound refused the list');
});

test('FIXED 3e: array-likes, foreign prototypes and arrays with extra keys are refused', () => {
  assert.equal(refusal(priceEvidence({ observedVersionedIds: { 0: PRICED_MODEL, length: 1 } })).code, 'invalid-shape');
  const subclassed = Object.setPrototypeOf([PRICED_MODEL], Object.create(Array.prototype));
  assert.equal(refusal(priceEvidence({ observedVersionedIds: subclassed })).code, 'invalid-shape');
  const extra = [PRICED_MODEL];
  extra.note = 'extra own key';
  assert.equal(refusal(priceEvidence({ observedVersionedIds: extra })).code, 'invalid-shape');
});

/* ------------------------------------------------------ timestamps and freshness */

test('timestamps must be UTC RFC3339 with a parseable month', () => {
  const bad = [
    '2026-09-27', '2026-09-27T12:00', '2026-09-27 12:00:00Z', '2026-09-27T12:00:00',
    '2026-09-27T12:00:00-07:00', '2026-09-27T24:00:00Z', '2026-09-27T12:60:00Z',
    '2026-09-27T12:00:60Z', '2026-13-01T12:00:00Z', '2026-00-01T12:00:00Z', 42, null, undefined,
  ];
  for (const value of bad) {
    const reason = refusal(priceEvidence({ verifiedAt: value }));
    assert.equal(reason.code, 'invalid-value', JSON.stringify(value));
    assert.equal(reason.path, '$.verifiedAt');
  }
});

test('FIXED 3d: nonexistent calendar days are now refused, not rolled forward', () => {
  // Was: the day component was only \d{2} and Date.parse rolled 2026-02-31 to 2026-03-03,
  // so impossible dates were accepted with up to three days of fresher-looking drift.
  // Now: the parsed UTC year/month/day is compared back against the written ones.
  assert.equal(Date.parse('2026-02-31T00:00:00Z'), Date.parse('2026-03-03T00:00:00Z'),
    'V8 still rolls the impossible day forward, so the guard has to be explicit');

  for (const impossible of ['2026-02-31T00:00:00Z', '2026-09-31T00:00:00Z', '2026-04-31T00:00:00Z',
    '2026-02-30T00:00:00Z', '2026-06-31T00:00:00Z', '2026-11-31T00:00:00Z']) {
    const reason = refusal(priceEvidence({ verifiedAt: impossible, now: '2026-10-02T00:00:00Z' }));
    assert.equal(reason.code, 'invalid-value', impossible);
    assert.equal(reason.path, '$.verifiedAt');
    assert.equal(reason.message, 'Invalid timestamp');
  }
  // The same guard covers `now`.
  assert.equal(refusal(priceEvidence({ now: '2026-09-31T00:00:00Z' })).path, '$.now');
});

test('FIXED 3d: leap years are judged correctly, not merely rejected wholesale', () => {
  // A blanket 28-day rule would wrongly refuse a real 29 February, so both directions are
  // asserted. 2028 and 2000 are leap years; 2027 and 1900 are not.
  const leap2028 = refusal(priceEvidence({ verifiedAt: '2028-02-29T00:00:00Z', now: '2026-10-02T00:00:00Z' }));
  assert.equal(leap2028.message, 'Revalidation follows the supplied instant',
    '29 Feb 2028 parsed as a real date and was refused only for being after `now`');

  const leap2000 = refusal(priceEvidence({ verifiedAt: '2000-02-29T00:00:00Z' }));
  assert.equal(leap2000.message, 'Catalog revalidation is stale',
    '29 Feb 2000 is a real leap day (400-year rule) and was refused only on freshness');

  for (const notLeap of ['2027-02-29T00:00:00Z', '1900-02-29T00:00:00Z', '2026-02-29T00:00:00Z']) {
    assert.equal(refusal(priceEvidence({ verifiedAt: notLeap })).message, 'Invalid timestamp', notLeap);
  }
});

test('FIXED 3d: both Z and +00:00 stay accepted; non-UTC offsets stay refused', () => {
  assert.equal(resolveInputTokenPrice(priceEvidence({
    verifiedAt: '2026-09-27T12:00:00Z', now: '2026-09-27T12:30:00+00:00',
  })).ok, true, 'mixed Z and +00:00 compare as the same timescale');
  assert.equal(resolveInputTokenPrice(priceEvidence({
    verifiedAt: '2026-09-27T12:00:00.123456789+00:00', now: '2026-09-27T12:30:00Z',
  })).ok, true, 'fractional seconds are accepted');
  for (const offset of ['2026-09-27T12:00:00+09:00', '2026-09-27T12:00:00-00:00', '2026-09-27T12:00:00z']) {
    assert.equal(refusal(priceEvidence({ verifiedAt: offset })).message,
      'Expected a UTC RFC3339 timestamp', offset);
  }
});

test('a revalidation dated after the caller-supplied now is refused as a future timestamp', () => {
  const reason = refusal(priceEvidence({ verifiedAt: '2026-09-27T13:00:00Z', now: '2026-09-27T12:00:00Z' }));
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.verifiedAt');
});

test('FIXED 3a: a price row dated after `now` is now refused, not treated as fresh', () => {
  // Was: `now - evidencedAt` was only compared against the upper bound, never against zero,
  // so a row evidenced 7 days AFTER the caller's instant resolved. Now it is refused.
  const reason = refusal(priceEvidence({
    verifiedAt: '2026-09-20T00:00:00Z', now: '2026-09-20T00:00:00Z', maxAgeMs: MAX_EVIDENCE_AGE_MS,
  }));
  assert.equal(reason.code, 'invalid-value');
  assert.equal(reason.path, '$.evidencedAt');
  assert.equal(reason.message, 'Price observation follows the supplied instant');

  // The boundary: `now` exactly at the row's midnight resolves; one ms earlier does not.
  assert.equal(resolveInputTokenPrice(priceEvidence({
    verifiedAt: '2026-09-27T00:00:00Z', now: '2026-09-27T00:00:00Z', maxAgeMs: 1,
  })).ok, true, 'now == evidencedAt midnight is not "after"');
  const justBefore = refusal(priceEvidence({
    verifiedAt: '2026-09-26T23:59:59.999Z', now: '2026-09-26T23:59:59.999Z', maxAgeMs: 1,
  }));
  assert.equal(justBefore.path, '$.evidencedAt');
  assert.equal(justBefore.message, 'Price observation follows the supplied instant');
});

test('a stale revalidation and a stale price observation are both refused as price-stale', () => {
  const staleCatalog = refusal(priceEvidence({
    verifiedAt: '2026-09-27T00:00:00Z', now: '2026-09-27T02:00:00Z', maxAgeMs: 3_600_000,
  }));
  assert.equal(staleCatalog.code, 'price-stale');
  assert.equal(staleCatalog.path, '$.verifiedAt');

  const stalePrice = refusal(priceEvidence({
    verifiedAt: '2026-10-08T00:00:00Z', now: '2026-10-08T00:30:00Z', maxAgeMs: MAX_EVIDENCE_AGE_MS,
  }));
  assert.equal(stalePrice.code, 'price-stale');
  assert.equal(stalePrice.path, '$.evidencedAt');
});

test('the price day is normalized to midnight UTC, so freshness is measured from 00:00:00Z', () => {
  const day = 86_400_000;
  const atBoundary = resolveInputTokenPrice(priceEvidence({
    verifiedAt: '2026-09-28T00:00:00Z', now: '2026-09-28T00:00:00Z', maxAgeMs: day,
  }));
  assert.equal(atBoundary.ok, true, 'exactly at the window edge still resolves');
  const pastBoundary = refusal(priceEvidence({
    verifiedAt: '2026-09-28T00:00:00.001Z', now: '2026-09-28T00:00:00.001Z', maxAgeMs: day,
  }));
  assert.equal(pastBoundary.code, 'price-stale');
  assert.equal(pastBoundary.path, '$.evidencedAt');
});

test('the freshness window itself is bounded and must be a positive safe integer', () => {
  for (const bad of [0, -1, -0, 1.5, Number.NaN, Infinity, MAX_EVIDENCE_AGE_MS + 1, '3600000', null]) {
    const reason = refusal(priceEvidence({ maxAgeMs: bad }));
    assert.equal(reason.code, 'invalid-value', String(bad));
    assert.equal(reason.path, '$.maxAgeMs');
  }
  assert.equal(resolveInputTokenPrice(priceEvidence({ maxAgeMs: 1 })).ok, false,
    'a 1 ms window cannot cover a 30 min old revalidation');
});

/* ------------------------------------------------- shape, prototype, accessors */

test('non-object price evidence is refused', () => {
  for (const bad of [null, undefined, 42, 'jev-1.13.0', [priceEvidence()], true]) {
    assert.equal(refusal(bad).code, 'invalid-shape', JSON.stringify(bad) ?? String(bad));
  }
});

test('FIXED 3b: inherited fields no longer satisfy the pricing entrypoint', () => {
  // Was: only `typeof === object` was checked and fields were read with bracket access, so a
  // prototype could supply catalogStatus/maxAgeMs and a class instance resolved.
  // Now: the evidence is snapshotted through contracts.record, which requires an
  // Object.prototype or null prototype and reads own data properties only.
  const inherited = Object.create({ catalogStatus: 'verified-fresh', maxAgeMs: 86_400_000 });
  Object.assign(inherited, {
    requestedModel: PRICED_MODEL,
    verifiedAt: '2026-09-27T12:00:00Z',
    observedVersionedIds: [PRICED_MODEL],
    now: '2026-09-27T12:30:00Z',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(inherited, 'catalogStatus'), false);
  const reason = refusal(inherited);
  assert.equal(reason.code, 'invalid-shape');
  assert.equal(reason.path, '$');
  assert.equal(reason.message, 'Expected a plain JSON object');

  class Forged { constructor() { Object.assign(this, priceEvidence()); } }
  assert.equal(refusal(new Forged()).code, 'invalid-shape', 'a class instance is refused');

  // A null-prototype carrier of the right own keys is still accepted (it is plain data).
  assert.equal(resolveInputTokenPrice(Object.assign(Object.create(null), priceEvidence())).ok, true);
});

test('FIXED 3b: a reserved __proto__ key in parsed price evidence is refused', () => {
  const parsed = JSON.parse(`{
    "requestedModel": "${PRICED_MODEL}",
    "catalogStatus": "verified-fresh",
    "verifiedAt": "2026-09-27T12:00:00Z",
    "observedVersionedIds": ["${PRICED_MODEL}"],
    "now": "2026-09-27T12:30:00Z",
    "maxAgeMs": 86400000,
    "__proto__": { "catalogStatus": "verified-fresh" }
  }`);
  const reason = refusal(parsed);
  assert.equal(reason.code, 'reserved-key');
  assert.equal(reason.path, '$');
  assert.equal(Object.prototype.catalogStatus, undefined, 'the global prototype is untouched');

  for (const key of ['prototype', 'constructor']) {
    const evidence = priceEvidence();
    Object.defineProperty(evidence, key, { enumerable: true, configurable: true, writable: true, value: 1 });
    assert.equal(refusal(evidence).code, 'reserved-key', key);
  }
});

test('FIXED 3b: symbol keys and non-enumerable own properties are refused', () => {
  const symbolic = priceEvidence();
  symbolic[Symbol('marker')] = 1;
  assert.equal(refusal(symbolic).code, 'invalid-shape');

  const hidden = priceEvidence();
  delete hidden.maxAgeMs;
  hiddenProperty(hidden, 'maxAgeMs', 86_400_000);
  const reason = refusal(hidden);
  assert.equal(reason.code, 'invalid-shape');
  assert.equal(reason.message, 'Expected plain data properties');
});

test('FIXED 3c: accessor-backed evidence is refused and the getter is NEVER invoked', () => {
  // Was: verifiedAt was read twice — validated on read #1 and returned raw on read #2 — so a
  // getter could report an unvalidated `catalogVerifiedAt` while ok === true.
  // Now: accessors are refused from the descriptor, so no getter runs at all.
  for (const key of ['requestedModel', 'catalogStatus', 'verifiedAt', 'observedVersionedIds', 'now', 'maxAgeMs']) {
    const evidence = priceEvidence();
    delete evidence[key];
    const reads = trapAccessor(evidence, key);
    const reason = refusal(evidence);
    assert.equal(reason.code, 'invalid-shape', key);
    assert.equal(reason.path, '$');
    assert.equal(reads(), 0, `the getter for ${key} must never run`);
  }
});

test('FIXED 3c: catalogVerifiedAt is the validated snapshot value, not a re-read', () => {
  const value = expectOk(resolveInputTokenPrice(priceEvidence()));
  assert.equal(value.catalogVerifiedAt, '2026-09-27T12:00:00Z');
  // Mutating the caller's object after the call cannot change what was returned.
  const evidence = priceEvidence();
  const resolved = expectOk(resolveInputTokenPrice(evidence));
  evidence.verifiedAt = 'not-a-timestamp';
  assert.equal(resolved.catalogVerifiedAt, '2026-09-27T12:00:00Z');
});

test('FIXED 3c: unknown extra properties on price evidence are now refused, not ignored', () => {
  // Was: silently ignored. Now: unknown-field at the parent path, matching the closed shapes
  // that contracts.ts already used for the request and the response.
  for (const extra of ['nanoUsdPerInputToken', 'catalogStatusOverride', 'evidencedAt', 'ignored']) {
    const reason = refusal(priceEvidence({ [extra]: 1 }));
    assert.equal(reason.code, 'unknown-field', extra);
    assert.equal(reason.path, '$');
    assert.equal(reason.message, 'Unexpected field');
  }
  // The caller still cannot override the evidenced rate by any accepted route.
  const value = expectOk(resolveInputTokenPrice(priceEvidence()));
  assert.equal(value.nanoUsdPerInputToken, 42);
});
