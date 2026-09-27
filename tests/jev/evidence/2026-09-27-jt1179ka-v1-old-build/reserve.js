/** Pure, checked-integer budget arithmetic for a single JEV attempt.
 *
 * Pure means pure: no clock, no filesystem, no lock, no store, no network. Nothing in
 * this file reserves anything in the real world. It computes amounts and returns
 * refusals; the authority to spend will be created and enforced at runtime by the future
 * transactional store, which is not in this slice.
 *
 * No value produced here is an authorization. A TypeScript type cannot make a token
 * unforgeable — any caller can construct one of these plain objects — so nothing below
 * is presented as a capability, receipt, or proof that a reservation exists.
 *
 * Money is integer nanoUSD throughout. No floats, no rounding, no division.
 *
 * FORBIDDEN CONVERSION, STATED SO IT IS NOT REINTRODUCED: the 8 KiB payload ceiling in
 * contracts.ts is a byte bound for privacy and accuracy. Bytes do not bound a tokenizer.
 * 8 KiB MUST NOT be read as 8192 tokens — that number would be invented, not evidenced —
 * and no function here accepts a byte count.
 */
import { refuse, result } from './contracts.js';
/** Upper bound on tokens we will ever accept as a verified ceiling. A pure sanity guard
 * on caller-supplied fixtures, not a provider fact. */
const MAX_DECLARABLE_INPUT_TOKENS = 10_000_000;
/** The provider bound as the fetched evidence actually leaves it: UNVERIFIED.
 *
 * p02 documents "64k tokens per request; 32k tokens for state plus the longest question"
 * and describes that budget as CONTEXT LENGTH. p06 documents `usage.input_tokens` with no
 * stated maximum, no pre-authorization, no per-request spend cap and no cost field in the
 * response. Nothing in the fetched evidence states that a billed `input_tokens` cannot
 * exceed 64k. Therefore 64000 / 65536 are NOT usable as a spend ceiling, and no paid call
 * may be authorized on them. This resolves to `budget-bound-unverified` until evidence
 * supplies a maximum billable input-token count. */
export const PROVIDER_BILLABLE_INPUT_BOUND = Object.freeze({
    status: 'unverified',
    reason: 'p02 states a 64k per-request CONTEXT ceiling, not a maximum billable input-token count; p06 states no per-request spend cap. No verified billable maximum exists.',
});
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|\+00:00)$/;
/** Constructs a verified bound from an explicit, dated statement.
 *
 * TODAY THIS HAS EXACTLY ONE LEGITIMATE CALLER: a test fixture. Calling it does not make
 * a bound true and is not permission for a paid call; it records that someone supplied
 * evidence, and the evidence itself is what must be reviewed. */
export function declareVerifiedBillableInputBound(input) {
    return result(() => {
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
            return refuse('invalid-shape', '$', 'Expected a bound-evidence object');
        }
        const outer = input;
        const tokens = outer['maxBillableInputTokens'];
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens)
            || tokens <= 0 || tokens > MAX_DECLARABLE_INPUT_TOKENS) {
            refuse('invalid-value', '$.maxBillableInputTokens', 'Expected a positive safe integer token bound');
        }
        const evidence = outer['evidence'];
        if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
            return refuse('invalid-shape', '$.evidence', 'Expected an evidence object');
        }
        const fields = evidence;
        for (const key of ['source', 'observedAt', 'statement']) {
            const value = fields[key];
            if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_024) {
                refuse('invalid-value', `$.evidence.${key}`, 'Expected nonempty bounded text');
            }
        }
        if (!TIMESTAMP_PATTERN.test(fields['observedAt'])) {
            refuse('invalid-value', '$.evidence.observedAt', 'Expected a UTC RFC3339 timestamp');
        }
        return {
            status: 'verified',
            maxBillableInputTokens: tokens,
            evidence: {
                source: fields['source'],
                observedAt: fields['observedAt'],
                statement: fields['statement'],
            },
        };
    });
}
function multiply(left, right, path) {
    const product = left * right;
    if (!Number.isSafeInteger(product)) {
        refuse('unsafe-arithmetic', path, 'Product exceeds the safe integer range');
    }
    return product;
}
function add(left, right, path) {
    const sum = left + right;
    if (!Number.isSafeInteger(sum)) {
        refuse('unsafe-arithmetic', path, 'Sum exceeds the safe integer range');
    }
    return sum;
}
/** Computes the worst-case charge for ONE attempt: maxBillableInputTokens × price.
 *
 * Refuses `budget-bound-unverified` whenever the bound is not verified — which is the
 * state of the shipped provider bound today. Output tokens are free (p02) and are
 * therefore not part of the reserve; the price row still carries the output rate so a
 * future nonzero rate cannot be silently ignored. */
export function planReservation(price, bound) {
    return result(() => {
        if (bound.status !== 'verified') {
            refuse('budget-bound-unverified', '$.bound', 'No verified maximum billable input-token count exists; a paid call cannot be bounded');
        }
        if (price.nanoUsdPerOutputToken !== 0) {
            refuse('budget-bound-unverified', '$.price.nanoUsdPerOutputToken', 'Output tokens are priced at zero in the evidenced table; a nonzero rate leaves this reserve model unbounded');
        }
        return {
            versionedId: price.versionedId,
            maxBillableInputTokens: bound.maxBillableInputTokens,
            nanoUsdPerInputToken: price.nanoUsdPerInputToken,
            reserveNanoUsd: multiply(bound.maxBillableInputTokens, price.nanoUsdPerInputToken, '$.reserveNanoUsd'),
            boundEvidence: bound.evidence,
            priceEvidencedAt: price.priceEvidencedAt,
        };
    });
}
/** Pure ceiling arithmetic: spent + live reservations + this reserve must not exceed the
 * ceiling. Refuses `budget-exhausted` otherwise.
 *
 * This is arithmetic, not enforcement. Two processes can both pass this check on stale
 * inputs; only the future transactional store makes the decision exclusive, and this
 * function must never be described as having enforced a budget. */
export function checkCeiling(input) {
    return result(() => {
        const fields = ['ceilingNanoUsd', 'spentNanoUsd', 'liveReservedNanoUsd', 'reserveNanoUsd'];
        for (const key of fields) {
            const value = input[key];
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
                refuse('invalid-value', `$.${key}`, 'Expected a nonnegative safe integer nanoUSD amount');
            }
        }
        if (input.reserveNanoUsd <= 0) {
            refuse('invalid-value', '$.reserveNanoUsd', 'A reservation must be a positive amount');
        }
        const committed = add(add(input.spentNanoUsd, input.liveReservedNanoUsd, '$.committedNanoUsd'), input.reserveNanoUsd, '$.committedNanoUsd');
        if (committed > input.ceilingNanoUsd) {
            refuse('budget-exhausted', '$.ceilingNanoUsd', 'Reservation would exceed the configured ceiling');
        }
        return { committedNanoUsd: committed, remainingAfterReserveNanoUsd: input.ceilingNanoUsd - committed };
    });
}
/** Computes what an attempt actually costs, given the plan and the reported usage.
 *
 * `usage` is the validated `usage` object from contracts.validateEvaluationResponse, or
 * `undefined` when there is no trustworthy usage at all.
 *
 * A `reserve-model-falsified` settlement is NOT a successful budget enforcement: the
 * money was already spent when the request was sent, and settling it honestly is
 * bookkeeping, not control. The caller must record it and stop making paid calls. */
export function computeSettlement(plan, usage) {
    return result(() => {
        if (usage === undefined) {
            return { kind: 'unknown-retained', settledNanoUsd: plan.reserveNanoUsd };
        }
        const tokens = usage.input_tokens;
        if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
            refuse('invalid-value', '$.usage.input_tokens', 'Expected a nonnegative safe integer token count');
        }
        const actual = multiply(tokens, plan.nanoUsdPerInputToken, '$.settledNanoUsd');
        if (actual > plan.reserveNanoUsd) {
            return {
                kind: 'reserve-model-falsified',
                settledNanoUsd: actual,
                actualInputTokens: tokens,
                reserveNanoUsd: plan.reserveNanoUsd,
                overrunNanoUsd: actual - plan.reserveNanoUsd,
            };
        }
        return { kind: 'settled', settledNanoUsd: actual, actualInputTokens: tokens };
    });
}
//# sourceMappingURL=reserve.js.map