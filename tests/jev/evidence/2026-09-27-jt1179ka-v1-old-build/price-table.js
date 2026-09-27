/** Known-version JEV pricing, in integer nanoUSD per input token.
 *
 * Pure: no filesystem read, no network call, no clock read. `now` is supplied by the
 * caller. This module never discovers a model, never follows an alias, and never
 * promotes a version to paid-eligible on its own.
 *
 * Evidence, stated as evidence and nothing more: p02 (https://docs.typesafe.ai/models,
 * fetched 2026-09-27T10:13–10:17Z) lists Jev 1.13 as `jev-1.13.0` at "$42 / $0.042" per
 * Btok / Mtok, "Charged per input token. Output tokens are free." $42 per 10^9 input
 * tokens = 42 nanoUSD per input token exactly, and 0 for output.
 *
 * THE TABLE BELOW IS NOT PROOF THAT jev-1.13.0 IS STILL THE LATEST MODEL, NOR THAT THE
 * PRICE STILL HOLDS. It is one dated observation. Resolution therefore requires the
 * caller to supply freshly verified catalog/price evidence; an alias, an unknown id, or
 * a stale observation is a refusal, never a guess and never a "probably still true".
 */
import { LIMITS, KNOWN_ALIASES, refuse, result, versionedModelId } from './contracts.js';
/** Every price we have ever observed, keyed by versioned id. Aliases are absent by
 * construction: `jev-latest` / `jev-preview` (p02, 2026-09-27) name a moving target and
 * can never be priced. Adding a row requires a dated official observation. */
export const KNOWN_PRICES = Object.freeze([
    Object.freeze({
        versionedId: 'jev-1.13.0',
        nanoUsdPerInputToken: 42,
        nanoUsdPerOutputToken: 0,
        evidencedAt: '2026-09-27',
        source: 'p02 https://docs.typesafe.ai/models ($42/Btok input, output free)',
    }),
]);
/** Freshness window a caller may request for the price observation and for its own
 * catalog revalidation. Bounded so that "fresh" cannot be stretched indefinitely. */
export const MAX_EVIDENCE_AGE_MS = 7 * 86_400_000;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|\+00:00)$/;
function instant(value, path) {
    if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
        return refuse('invalid-value', path, 'Expected a UTC RFC3339 timestamp');
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed))
        return refuse('invalid-value', path, 'Invalid timestamp');
    return parsed;
}
function day(value, path) {
    const parsed = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed))
        return refuse('invalid-value', path, 'Invalid calendar day');
    return parsed;
}
/** Looks up a price row by exact versioned id. Never falls back to a neighbouring
 * version, never interpolates, never returns a default. */
export function findPriceRecord(versionedId) {
    return KNOWN_PRICES.find(record => record.versionedId === versionedId);
}
/** Resolves the input-token price for exactly the model the caller intends to send.
 *
 * Refusal codes, all fail-closed (the caller's only correct branch is "no paid call"):
 *   model-alias        — an alias was supplied; aliases move without notice (p02)
 *   catalog-unverified — the caller did not revalidate, or its verdict is `stale`
 *   catalog-mismatch   — the model is absent from the revalidated catalog
 *   price-stale        — our price observation, or the caller's revalidation, is older
 *                        than the caller's own freshness window
 *   model-unpriced     — no dated observation exists for this versioned id
 */
export function resolveInputTokenPrice(evidence) {
    return result(() => {
        if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
            return refuse('invalid-shape', '$', 'Expected a price-evidence object');
        }
        const input = evidence;
        const requested = input['requestedModel'];
        if (typeof requested === 'string' && KNOWN_ALIASES.includes(requested)) {
            refuse('model-alias', '$.requestedModel', 'Aliases resolve to a moving target and cannot be priced');
        }
        const versionedId = versionedModelId(requested, '$.requestedModel');
        const status = input['catalogStatus'];
        if (status !== 'verified-fresh') {
            refuse('catalog-unverified', '$.catalogStatus', 'Paid eligibility requires freshly verified catalog evidence');
        }
        const verifiedAt = instant(input['verifiedAt'], '$.verifiedAt');
        const now = instant(input['now'], '$.now');
        const maxAgeMs = input['maxAgeMs'];
        if (typeof maxAgeMs !== 'number' || !Number.isSafeInteger(maxAgeMs)
            || maxAgeMs <= 0 || maxAgeMs > MAX_EVIDENCE_AGE_MS) {
            refuse('invalid-value', '$.maxAgeMs', 'Expected a positive freshness window within the evidence bound');
        }
        const window = maxAgeMs;
        const observed = input['observedVersionedIds'];
        if (!Array.isArray(observed) || observed.length === 0 || observed.length > LIMITS.catalogEntries) {
            refuse('invalid-shape', '$.observedVersionedIds', 'Expected a bounded list of observed versioned ids');
        }
        const observedIds = observed.map((item, index) => versionedModelId(item, `$.observedVersionedIds[${index}]`));
        if (!observedIds.includes(versionedId)) {
            refuse('catalog-mismatch', '$.requestedModel', 'Model is absent from the revalidated catalog');
        }
        if (verifiedAt > now)
            refuse('invalid-value', '$.verifiedAt', 'Revalidation follows the supplied instant');
        if (now - verifiedAt > window)
            refuse('price-stale', '$.verifiedAt', 'Catalog revalidation is stale');
        const record = findPriceRecord(versionedId);
        if (record === undefined) {
            refuse('model-unpriced', '$.requestedModel', 'No dated price observation exists for this model');
        }
        const priced = record;
        const evidencedAt = day(priced.evidencedAt, '$.evidencedAt');
        if (now - evidencedAt > window) {
            refuse('price-stale', '$.evidencedAt', 'Price observation is older than the freshness window');
        }
        return {
            versionedId,
            nanoUsdPerInputToken: priced.nanoUsdPerInputToken,
            nanoUsdPerOutputToken: priced.nanoUsdPerOutputToken,
            priceEvidencedAt: priced.evidencedAt,
            priceSource: priced.source,
            catalogVerifiedAt: input['verifiedAt'],
        };
    });
}
//# sourceMappingURL=price-table.js.map