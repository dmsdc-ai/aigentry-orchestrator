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
 *
 * Every exported entrypoint validates its arguments at runtime; the parameter types are
 * documentation, not a boundary. Each argument is read once into a data-only snapshot
 * (contracts.record: no getter runs; inherited, reserved, symbol and unknown keys are
 * refused) and only the snapshot is checked and used.
 */

import { record, refuse, result, utcDay, utcInstant, versionedModelId } from './contracts.js';
import type { ValidationResult } from './contracts.js';
import { findPriceRecord } from './price-table.js';
import type { PriceRecord, ResolvedPrice } from './price-table.js';

/** A dated, quotable statement that fixes a maximum BILLABLE input-token count. */
export interface BillableBoundEvidence {
  readonly source: string;
  /** RFC3339 UTC instant the statement was observed. */
  readonly observedAt: string;
  /** The verbatim provider statement the bound rests on. */
  readonly statement: string;
}

export type BillableInputTokenBound =
  | { readonly status: 'unverified'; readonly reason: string }
  | {
      readonly status: 'verified';
      readonly maxBillableInputTokens: number;
      readonly evidence: BillableBoundEvidence;
    };

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
export const PROVIDER_BILLABLE_INPUT_BOUND: BillableInputTokenBound = Object.freeze({
  status: 'unverified',
  reason: 'p02 states a 64k per-request CONTEXT ceiling, not a maximum billable input-token count; p06 states no per-request spend cap. No verified billable maximum exists.',
});

/** A safe integer of at least `minimum` (0 or 1); never negative, fractional or NaN. */
function amount(value: unknown, path: string, minimum: 0 | 1, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    return refuse('invalid-value', path, message);
  }
  return value;
}

function tokenBound(value: unknown, path: string): number {
  const tokens = amount(value, path, 1, 'Expected a positive safe integer token bound');
  if (tokens > MAX_DECLARABLE_INPUT_TOKENS) refuse('invalid-value', path, 'Expected a positive safe integer token bound');
  return tokens;
}

function boundedText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_024) {
    return refuse('invalid-value', path, 'Expected nonempty bounded text');
  }
  return value;
}

function boundEvidence(value: unknown, path: string): BillableBoundEvidence {
  const fields = record(value, path, ['source', 'observedAt', 'statement']);
  const source = boundedText(fields['source'], `${path}.source`);
  const observedAt = boundedText(fields['observedAt'], `${path}.observedAt`);
  const statement = boundedText(fields['statement'], `${path}.statement`);
  utcInstant(observedAt, `${path}.observedAt`);
  return { source, observedAt, statement };
}

/** The dated table row for `versionedId`, which a supplied rate and observation day must
 * match exactly: a price or plan that no resolver produced cannot set its own rate. */
function pricedRow(versionedId: string, nanoUsdPerInputToken: number, evidencedAt: unknown, path: string): PriceRecord {
  utcDay(evidencedAt, path);
  const row = findPriceRecord(versionedId);
  if (row === undefined) return refuse('model-unpriced', path, 'No dated price observation exists for this model');
  if (row.nanoUsdPerInputToken !== nanoUsdPerInputToken || row.evidencedAt !== evidencedAt) {
    refuse('invalid-value', path, 'Price does not match the dated observation for this model');
  }
  return row;
}

/** Constructs a verified bound from an explicit, dated statement.
 *
 * TODAY THIS HAS EXACTLY ONE LEGITIMATE CALLER: a test fixture. Calling it does not make
 * a bound true and is not permission for a paid call; it records that someone supplied
 * evidence, and the evidence itself is what must be reviewed. */
export function declareVerifiedBillableInputBound(input: unknown): ValidationResult<BillableInputTokenBound> {
  return result(() => {
    const outer = record(input, '$', ['maxBillableInputTokens', 'evidence']);
    const tokens = tokenBound(outer['maxBillableInputTokens'], '$.maxBillableInputTokens');
    return { status: 'verified', maxBillableInputTokens: tokens, evidence: boundEvidence(outer['evidence'], '$.evidence') };
  });
}

function multiply(left: number, right: number, path: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    refuse('unsafe-arithmetic', path, 'Product exceeds the safe integer range');
  }
  return product;
}

function add(left: number, right: number, path: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    refuse('unsafe-arithmetic', path, 'Sum exceeds the safe integer range');
  }
  return sum;
}

export interface ReservationPlan {
  readonly versionedId: string;
  readonly maxBillableInputTokens: number;
  readonly nanoUsdPerInputToken: number;
  /** Worst-case charge for one attempt, in integer nanoUSD. */
  readonly reserveNanoUsd: number;
  readonly boundEvidence: BillableBoundEvidence;
  readonly priceEvidencedAt: string;
}

/** Computes the worst-case charge for ONE attempt: maxBillableInputTokens × price.
 *
 * Refuses `budget-bound-unverified` whenever the bound is not verified — which is the
 * state of the shipped provider bound today. Output tokens are free (p02) and are
 * therefore not part of the reserve; the price row still carries the output rate so a
 * future nonzero rate cannot be silently ignored.
 *
 * `price` must match the dated table row for its versioned id (rate and observation day);
 * the rate is a positive safe integer, the bound a positive safe integer token count. */
export function planReservation(
  price: ResolvedPrice, bound: BillableInputTokenBound,
): ValidationResult<ReservationPlan> {
  return result(() => {
    const boundFields = record(bound, '$.bound', ['status', 'reason', 'maxBillableInputTokens', 'evidence']);
    if (boundFields['status'] !== 'verified') {
      refuse('budget-bound-unverified', '$.bound',
        'No verified maximum billable input-token count exists; a paid call cannot be bounded');
    }
    if (boundFields['reason'] !== undefined) refuse('unknown-field', '$.bound', 'Unexpected field');

    const priceFields = record(price, '$.price', [
      'versionedId', 'nanoUsdPerInputToken', 'nanoUsdPerOutputToken',
      'priceEvidencedAt', 'priceSource', 'catalogVerifiedAt',
    ]);
    const versionedId = versionedModelId(priceFields['versionedId'], '$.price.versionedId');
    const rate = amount(priceFields['nanoUsdPerInputToken'], '$.price.nanoUsdPerInputToken', 1,
      'Expected a positive safe integer nanoUSD rate');
    const outputRate = amount(priceFields['nanoUsdPerOutputToken'], '$.price.nanoUsdPerOutputToken', 0,
      'Expected a nonnegative safe integer nanoUSD rate');
    if (outputRate !== 0) {
      refuse('budget-bound-unverified', '$.price.nanoUsdPerOutputToken',
        'Output tokens are priced at zero in the evidenced table; a nonzero rate leaves this reserve model unbounded');
    }
    const row = pricedRow(versionedId, rate, priceFields['priceEvidencedAt'], '$.price.priceEvidencedAt');
    if (priceFields['priceSource'] !== row.source) {
      refuse('invalid-value', '$.price.priceSource', 'Price does not match the dated observation for this model');
    }
    utcInstant(priceFields['catalogVerifiedAt'], '$.price.catalogVerifiedAt');

    const tokens = tokenBound(boundFields['maxBillableInputTokens'], '$.bound.maxBillableInputTokens');
    const evidence = boundEvidence(boundFields['evidence'], '$.bound.evidence');
    return {
      versionedId,
      maxBillableInputTokens: tokens,
      nanoUsdPerInputToken: rate,
      reserveNanoUsd: multiply(tokens, rate, '$.reserveNanoUsd'),
      boundEvidence: evidence,
      priceEvidencedAt: row.evidencedAt,
    };
  });
}

/** Revalidates a plan as planReservation would have produced it: known versioned id,
 * table rate and day, positive bound, and reserve exactly bound × rate. */
function reservationPlan(value: unknown): ReservationPlan {
  const plan = record(value, '$.plan', [
    'versionedId', 'maxBillableInputTokens', 'nanoUsdPerInputToken',
    'reserveNanoUsd', 'boundEvidence', 'priceEvidencedAt',
  ]);
  const versionedId = versionedModelId(plan['versionedId'], '$.plan.versionedId');
  const tokens = tokenBound(plan['maxBillableInputTokens'], '$.plan.maxBillableInputTokens');
  const rate = amount(plan['nanoUsdPerInputToken'], '$.plan.nanoUsdPerInputToken', 1,
    'Expected a positive safe integer nanoUSD rate');
  const reserve = amount(plan['reserveNanoUsd'], '$.plan.reserveNanoUsd', 1,
    'Expected a positive safe integer nanoUSD amount');
  const evidence = boundEvidence(plan['boundEvidence'], '$.plan.boundEvidence');
  const row = pricedRow(versionedId, rate, plan['priceEvidencedAt'], '$.plan.priceEvidencedAt');
  if (multiply(tokens, rate, '$.plan.reserveNanoUsd') !== reserve) {
    refuse('invalid-value', '$.plan.reserveNanoUsd', 'Reserve is not the bound times the rate');
  }
  return {
    versionedId, maxBillableInputTokens: tokens, nanoUsdPerInputToken: rate,
    reserveNanoUsd: reserve, boundEvidence: evidence, priceEvidencedAt: row.evidencedAt,
  };
}

export interface CeilingCheckInput {
  /** Operator-configured ceiling for the accounting period, in nanoUSD.
   *
   * Always supplied by the caller. There is deliberately no default constant here: the
   * $50/month figure in this task is ONE user's configured maximum, not a public default
   * and not permission to make paid calls. */
  readonly ceilingNanoUsd: number;
  readonly spentNanoUsd: number;
  readonly liveReservedNanoUsd: number;
  readonly reserveNanoUsd: number;
}

export interface CeilingCheck {
  readonly committedNanoUsd: number;
  readonly remainingAfterReserveNanoUsd: number;
}

/** Pure ceiling arithmetic: spent + live reservations + this reserve must not exceed the
 * ceiling. Refuses `budget-exhausted` otherwise.
 *
 * This is arithmetic, not enforcement. Two processes can both pass this check on stale
 * inputs; only the future transactional store makes the decision exclusive, and this
 * function must never be described as having enforced a budget. */
export function checkCeiling(input: CeilingCheckInput): ValidationResult<CeilingCheck> {
  return result(() => {
    const keys = ['ceilingNanoUsd', 'spentNanoUsd', 'liveReservedNanoUsd', 'reserveNanoUsd'] as const;
    const fields = record(input, '$', keys);
    const [ceiling, spent, live, reserve] = keys.map(key =>
      amount(fields[key], `$.${key}`, 0, 'Expected a nonnegative safe integer nanoUSD amount')) as
      [number, number, number, number];
    if (reserve <= 0) {
      refuse('invalid-value', '$.reserveNanoUsd', 'A reservation must be a positive amount');
    }
    const committed = add(add(spent, live, '$.committedNanoUsd'), reserve, '$.committedNanoUsd');
    if (committed > ceiling) {
      refuse('budget-exhausted', '$.ceilingNanoUsd', 'Reservation would exceed the configured ceiling');
    }
    return { committedNanoUsd: committed, remainingAfterReserveNanoUsd: ceiling - committed };
  });
}

export type Settlement =
  /** Actual usage was within the reserve. */
  | { readonly kind: 'settled'; readonly settledNanoUsd: number; readonly actualInputTokens: number }
  /** Actual usage exceeded the reserve: the reserve model is disproven. The full actual
   * charge settles — the excess is never discarded and never truncated to the reserve —
   * and no further paid call may rely on this bound. */
  | {
      readonly kind: 'reserve-model-falsified';
      readonly settledNanoUsd: number;
      readonly actualInputTokens: number;
      readonly reserveNanoUsd: number;
      readonly overrunNanoUsd: number;
    }
  /** Usage is absent, malformed, or the outcome is unknown (non-2xx, timeout, abort).
   * The full reserve is retained. An unknown charge is never released. */
  | { readonly kind: 'unknown-retained'; readonly settledNanoUsd: number };

/** Computes what an attempt actually costs, given the plan and the reported usage.
 *
 * `usage` is the validated `usage` object from contracts.validateEvaluationResponse, or
 * `undefined` when there is no trustworthy usage at all.
 *
 * The plan is revalidated first; an invalid plan is a refusal and never yields an amount.
 * For a valid plan, absent or malformed usage (not a plain object, accessor/inherited/
 * unknown keys, or a token count that is not a nonnegative safe integer) returns
 * `unknown-retained` for the FULL reserve.
 *
 * A `reserve-model-falsified` settlement is NOT a successful budget enforcement: the
 * money was already spent when the request was sent, and settling it honestly is
 * bookkeeping, not control. The caller must record it and stop making paid calls.
 * RESIDUAL: a well-formed token count whose charge exceeds the safe integer range is
 * refused `unsafe-arithmetic` rather than settled; the caller must treat that attempt as
 * a falsified reserve model of unrepresentable size and stop making paid calls. */
export function computeSettlement(
  plan: ReservationPlan, usage: { readonly input_tokens: number } | undefined,
): ValidationResult<Settlement> {
  return result(() => {
    const valid = reservationPlan(plan);
    const reported = result(() => {
      const fields = record(usage, '$.usage', ['input_tokens', 'output_tokens']);
      const count = 'Expected a nonnegative safe integer token count';
      if (fields['output_tokens'] !== undefined) amount(fields['output_tokens'], '$.usage.output_tokens', 0, count);
      return amount(fields['input_tokens'], '$.usage.input_tokens', 0, count);
    });
    if (!reported.ok) {
      return { kind: 'unknown-retained', settledNanoUsd: valid.reserveNanoUsd };
    }
    const tokens = reported.value;
    const actual = multiply(tokens, valid.nanoUsdPerInputToken, '$.settledNanoUsd');
    if (actual > valid.reserveNanoUsd) {
      return {
        kind: 'reserve-model-falsified',
        settledNanoUsd: actual,
        actualInputTokens: tokens,
        reserveNanoUsd: valid.reserveNanoUsd,
        overrunNanoUsd: actual - valid.reserveNanoUsd,
      };
    }
    return { kind: 'settled', settledNanoUsd: actual, actualInputTokens: tokens };
  });
}
