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

import {
  LIMITS, KNOWN_ALIASES, dataArray, record as closedRecord, refuse, result, utcDay, utcInstant, versionedModelId,
} from './contracts.js';
import type { ValidationResult } from './contracts.js';

export interface PriceRecord {
  readonly versionedId: string;
  readonly nanoUsdPerInputToken: number;
  readonly nanoUsdPerOutputToken: number;
  /** UTC day the price was observed on the cited page. */
  readonly evidencedAt: string;
  readonly source: string;
}

/** Every price we have ever observed, keyed by versioned id. Aliases are absent by
 * construction: `jev-latest` / `jev-preview` (p02, 2026-09-27) name a moving target and
 * can never be priced. Adding a row requires a dated official observation. */
export const KNOWN_PRICES: readonly PriceRecord[] = Object.freeze([
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

/** What the caller must prove before a price can be resolved.
 *
 * `catalogStatus` is the caller's out-of-band revalidation verdict (#1148 freshness
 * path). Only `verified-fresh` can resolve. `unverified` is the honest default for a
 * caller that has not revalidated — it is NOT weaker evidence, it is no evidence. */
export interface PriceEvidence {
  /** The versioned model the caller intends to send. Aliases are refused. */
  readonly requestedModel: string;
  readonly catalogStatus: 'verified-fresh' | 'unverified' | 'stale';
  /** RFC3339 UTC instant the catalog was revalidated by the caller. */
  readonly verifiedAt: string;
  /** Versioned ids observed in that revalidation. Must contain `requestedModel`. */
  readonly observedVersionedIds: readonly string[];
  /** RFC3339 UTC instant the caller considers "now". */
  readonly now: string;
  /** How old the caller's own revalidation, and our price row, may be. */
  readonly maxAgeMs: number;
}

export interface ResolvedPrice {
  readonly versionedId: string;
  readonly nanoUsdPerInputToken: number;
  readonly nanoUsdPerOutputToken: number;
  readonly priceEvidencedAt: string;
  readonly priceSource: string;
  readonly catalogVerifiedAt: string;
}

const EVIDENCE_KEYS: readonly string[] =
  ['requestedModel', 'catalogStatus', 'verifiedAt', 'observedVersionedIds', 'now', 'maxAgeMs'];

/** Looks up a price row by exact versioned id. Never falls back to a neighbouring
 * version, never interpolates, never returns a default. */
export function findPriceRecord(versionedId: string): PriceRecord | undefined {
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
 *
 * `evidence` must be a plain JSON object with exactly the PriceEvidence keys as own data
 * properties. It is read once into a snapshot (no getter runs, no inherited field counts)
 * and only that snapshot is validated and returned. Neither the caller's revalidation nor
 * our price observation may postdate `now`.
 */
export function resolveInputTokenPrice(evidence: unknown): ValidationResult<ResolvedPrice> {
  return result(() => {
    const input = closedRecord(evidence, '$', EVIDENCE_KEYS);

    const requested = input['requestedModel'];
    if (typeof requested === 'string' && KNOWN_ALIASES.includes(requested)) {
      refuse('model-alias', '$.requestedModel', 'Aliases resolve to a moving target and cannot be priced');
    }
    const versionedId = versionedModelId(requested, '$.requestedModel');

    const status = input['catalogStatus'];
    if (status !== 'verified-fresh') {
      refuse('catalog-unverified', '$.catalogStatus', 'Paid eligibility requires freshly verified catalog evidence');
    }

    const verifiedAt = utcInstant(input['verifiedAt'], '$.verifiedAt');
    const now = utcInstant(input['now'], '$.now');

    const maxAgeMs = input['maxAgeMs'];
    if (typeof maxAgeMs !== 'number' || !Number.isSafeInteger(maxAgeMs)
        || maxAgeMs <= 0 || maxAgeMs > MAX_EVIDENCE_AGE_MS) {
      refuse('invalid-value', '$.maxAgeMs', 'Expected a positive freshness window within the evidence bound');
    }
    const window = maxAgeMs as number;

    const listMessage = 'Expected a bounded list of observed versioned ids';
    const observed = dataArray(input['observedVersionedIds'], '$.observedVersionedIds',
      LIMITS.catalogEntries, 'invalid-shape', listMessage);
    if (observed.length === 0) refuse('invalid-shape', '$.observedVersionedIds', listMessage);
    const observedIds = observed.map((item, index) =>
      versionedModelId(item, `$.observedVersionedIds[${index}]`));
    if (!observedIds.includes(versionedId)) {
      refuse('catalog-mismatch', '$.requestedModel', 'Model is absent from the revalidated catalog');
    }

    if (verifiedAt > now) refuse('invalid-value', '$.verifiedAt', 'Revalidation follows the supplied instant');
    if (now - verifiedAt > window) refuse('price-stale', '$.verifiedAt', 'Catalog revalidation is stale');

    const record = findPriceRecord(versionedId);
    if (record === undefined) {
      refuse('model-unpriced', '$.requestedModel', 'No dated price observation exists for this model');
    }
    const priced: PriceRecord = record;
    const evidencedAt = utcDay(priced.evidencedAt, '$.evidencedAt');
    if (evidencedAt > now) refuse('invalid-value', '$.evidencedAt', 'Price observation follows the supplied instant');
    if (now - evidencedAt > window) {
      refuse('price-stale', '$.evidencedAt', 'Price observation is older than the freshness window');
    }

    return {
      versionedId,
      nanoUsdPerInputToken: priced.nanoUsdPerInputToken,
      nanoUsdPerOutputToken: priced.nanoUsdPerOutputToken,
      priceEvidencedAt: priced.evidencedAt,
      priceSource: priced.source,
      // The snapshot value utcInstant validated above; the caller's object is not re-read.
      catalogVerifiedAt: input['verifiedAt'] as string,
    };
  });
}
