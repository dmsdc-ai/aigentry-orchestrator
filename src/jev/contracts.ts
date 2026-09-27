/** Pure structural contracts for the JEV (TypeSafe "System One") evaluation endpoint.
 *
 * Scope of this file: build one bounded synthetic-metadata request, and validate one
 * response against exactly that request. Nothing here performs I/O, opens a socket,
 * reads a file, selects a model over the network, or authorizes a paid call.
 *
 * Source of truth for every shape below is the official provider API reference
 * (evidence p06, https://docs.typesafe.ai/api-reference, fetched 2026-09-27) with model
 * facts from p02 (https://docs.typesafe.ai/models). Where this file is narrower than the
 * official contract, that is stated inline as a DOCUMENTED SUBSET rather than presented
 * as the provider's limit.
 *
 * Vocabulary (Refusal/ValidationResult/object-rejecting-unknown-fields) mirrors
 * src/task-advisor/contracts.ts by reimplementation. It is deliberately NOT imported and
 * that module is not refactored (Rule 29); the duplicated primitive lines are a named,
 * accepted cost.
 *
 * Refusal messages are constants. No refusal ever echoes offending input text: paths are
 * built from constant field names, array indices and constant placeholders (`<question>`,
 * `<option>`); a caller-supplied key never appears in a path or message.
 * Only `undefined` denotes an absent optional field; `null` is malformed input.
 *
 * Caller objects are read once, through property descriptors: accessor properties,
 * non-plain prototypes, reserved keys, symbol keys and array holes are refused, and every
 * check runs on that data-only snapshot. RESIDUAL: a Proxy's reflective traps
 * (getPrototypeOf, ownKeys, getOwnPropertyDescriptor) still run caller code. Any exception
 * they raise becomes one constant refusal, but a trap can still answer inconsistently
 * between separate calls; this module does not claim a Proxy can be made inert.
 */

/** Validation bounds. Provisional limits of what WE emit and accept, not measured
 * provider capacity. Where the official limit is wider, both numbers are named. */
export const LIMITS = Object.freeze({
  /** state + questions, serialized, per C9. A privacy/accuracy bound — never a token count. */
  requestBytes: 8 * 1024,
  /** Largest response body we will traverse. Our bound; the provider states none. */
  responseBytes: 64 * 1024,
  questions: 32,
  /** Official Choice maximum is 255 options (p06). We emit at most this many. */
  options: 32,
  /** Official Score range is 2..10 levels (p06). We adopt it unchanged. */
  minLevels: 2,
  maxLevels: 10,
  candidates: 32,
  capabilitiesPerCandidate: 16,
  /** Versioned ids a caller may present as its revalidated catalog (price-table.ts). */
  catalogEntries: 64,
  instructions: 1_024,
  description: 512,
  identifier: 64,
  touchedAreaCount: 100_000,
  /** Response `model` is a short identifier; p06 states no length. Ours. */
  modelId: 128,
  nodes: 100_000,
  depth: 12,
});

/** Documented tolerance for a probability map summing to 1 (p06: "floats that sum to 1"). */
export const PROBABILITY_SUM_TOLERANCE = 1e-6;
/** Documented tolerance for `score` against the probability-weighted level index.
 * p06 defines `score` as "the probability-weighted answer across the levels"; the
 * provider's rounding is not documented, so the check is tolerant, not exact. */
export const SCORE_WEIGHTED_TOLERANCE = 1e-3;

export type RefusalCode =
  | 'invalid-shape'
  | 'unknown-field'
  | 'invalid-value'
  | 'input-limit'
  | 'duplicate-id'
  | 'reserved-key'
  | 'disallowed-content'
  | 'key-mismatch'
  | 'model-alias'
  | 'model-mismatch'
  // price-table.ts / reserve.ts — all fail-closed; the caller's branch is "no paid call"
  | 'model-unpriced'
  | 'price-stale'
  | 'catalog-unverified'
  | 'catalog-mismatch'
  | 'budget-bound-unverified'
  | 'budget-exhausted'
  | 'unsafe-arithmetic';

export interface Refusal { code: RefusalCode; path: string; message: string }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: Refusal };

type Check<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Check<unknown>>;
type Checked<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> };

class Invalid extends Error {
  constructor(readonly reason: Refusal) { super(reason.message); }
}

/** @internal shared by the sibling modules of this bundle; never echoes input. */
export function refuse(code: RefusalCode, path: string, message: string): never {
  throw new Invalid({ code, path, message });
}

/** @internal wraps a throwing checker into a ValidationResult. */
export function result<T>(operation: () => T): ValidationResult<T> {
  try { return { ok: true, value: operation() }; }
  catch (error) {
    if (error instanceof Invalid) return { ok: false, reason: error.reason };
    return { ok: false, reason: { code: 'invalid-shape', path: '$', message: 'Unreadable input' } };
  }
}

/** Keys that must never be accepted from parsed JSON, in a closed shape or an open map. */
const RESERVED_KEYS: readonly string[] = ['__proto__', 'prototype', 'constructor'];

/** Runs reflective reads on a caller value. No getter is invoked by these reads, but a
 * Proxy trap is caller code: whatever it throws — including an imitation refusal — is
 * replaced by this one constant refusal. */
function inspect<T>(path: string, read: () => T): T {
  try { return read(); }
  catch { return refuse('invalid-shape', path, 'Unreadable input'); }
}

/** Own data property value, or a refusal. Never invokes a getter. */
function dataValue(target: object, key: string, path: string, message: string): unknown {
  const descriptor = inspect(path, () => Object.getOwnPropertyDescriptor(target, key));
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
    return refuse('invalid-shape', path, message);
  }
  return descriptor.value;
}

/** Data-only, null-prototype snapshot of a plain JSON object. Each own value is read
 * exactly once, from its descriptor; callers validate and use only the snapshot. */
function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return refuse('invalid-shape', path, 'Expected an object');
  }
  const target: object = value;
  const [isArray, prototype, keys] = inspect(path, () =>
    [Array.isArray(target), Object.getPrototypeOf(target), Reflect.ownKeys(target)] as const);
  if (isArray) refuse('invalid-shape', path, 'Expected an object');
  if (prototype !== Object.prototype && prototype !== null) {
    refuse('invalid-shape', path, 'Expected a plain JSON object');
  }
  if (keys.length > LIMITS.nodes) refuse('input-limit', path, 'Structure exceeds validation bound');
  for (const key of keys) {
    if (typeof key === 'string' && RESERVED_KEYS.includes(key)) refuse('reserved-key', path, 'Reserved property key');
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') refuse('invalid-shape', path, 'Expected a plain JSON object');
    output[key] = dataValue(target, key, path, 'Expected plain data properties');
  }
  return output;
}

/** Dense data-only copy of a plain JSON array. The length is bounded BEFORE any element
 * is read; holes, accessors, extra keys and non-Array prototypes are refused. */
export function dataArray(
  value: unknown, path: string, maxLength: number, limitCode: RefusalCode, limitMessage: string,
): unknown[] {
  if (value === null || typeof value !== 'object') return refuse('invalid-shape', path, 'Expected array');
  const target: object = value;
  const [isArray, prototype, length] = inspect(path, () =>
    [Array.isArray(target), Object.getPrototypeOf(target), Object.getOwnPropertyDescriptor(target, 'length')] as const);
  if (!isArray) refuse('invalid-shape', path, 'Expected array');
  const size: unknown = length !== undefined && 'value' in length ? length.value : undefined;
  if (prototype !== Array.prototype || typeof size !== 'number' || !Number.isSafeInteger(size)) {
    return refuse('invalid-shape', path, 'Expected a plain JSON array');
  }
  if (size > maxLength) refuse(limitCode, path, limitMessage);
  const keyCount = inspect(path, () => Reflect.ownKeys(target).length);
  if (keyCount !== size + 1) refuse('invalid-shape', path, 'Expected a dense JSON array');
  const items: unknown[] = [];
  for (let index = 0; index < size; index += 1) {
    items.push(dataValue(target, String(index), path, 'Expected a dense JSON array'));
  }
  return items;
}

/** @internal closed-shape snapshot for the sibling modules: a plain JSON object whose own
 * keys are all in `keys`. An unexpected key is refused at `path` itself — never echoed. */
export function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  const input = plainObject(value, path);
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) refuse('unknown-field', path, 'Unexpected field');
  }
  return input;
}

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|\+00:00)$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** @internal UTC RFC3339 instant (`Z` or `+00:00`) in epoch ms. The calendar date must
 * exist: `Date.parse` rolls `2026-02-31` forward to March, so the parsed UTC date is
 * compared back against the written year, month and day. */
export function utcInstant(value: unknown, path: string): number {
  const match = typeof value === 'string' ? TIMESTAMP_PATTERN.exec(value) : null;
  if (match === null) return refuse('invalid-value', path, 'Expected a UTC RFC3339 timestamp');
  const parsed = Date.parse(match[0]);
  const date = new Date(parsed);
  if (!Number.isFinite(parsed) || date.getUTCFullYear() !== Number(match[1])
      || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) {
    return refuse('invalid-value', path, 'Invalid timestamp');
  }
  return parsed;
}

/** @internal an existing calendar day `YYYY-MM-DD`, as its UTC midnight in epoch ms. */
export function utcDay(value: unknown, path: string): number {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    return refuse('invalid-value', path, 'Expected a calendar day');
  }
  return utcInstant(`${value}T00:00:00Z`, path);
}

function object<S extends Shape>(shape: S): Check<Checked<S>> {
  return (value, path) => {
    const input = record(value, path, Object.keys(shape));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) output[key] = shape[key](input[key], `${path}.${key}`);
    return output as Checked<S>;
  };
}

function string(max: number): Check<string> {
  return (value, path) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return refuse('invalid-value', path, 'Expected nonempty text');
    }
    if (value.length > max) refuse('input-limit', path, 'Text exceeds validation bound');
    return value;
  };
}

const boolean: Check<boolean> = (value, path) => typeof value === 'boolean'
  ? value : refuse('invalid-value', path, 'Expected boolean');

function oneOf<const T extends readonly (string | number | boolean)[]>(...values: T): Check<T[number]> {
  return (value, path) => values.some(item => item === value)
    ? value as T[number] : refuse('invalid-value', path, 'Unexpected enum value');
}

function integer(max: number, min = 0): Check<number> {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      return refuse('invalid-value', path, `Expected safe integer in [${min}, ${max}]`);
    }
    return value;
  };
}

/** Finite number in [0,1]. Rejects NaN, ±Infinity and out-of-range values. */
const probability: Check<number> = (value, path) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return refuse('invalid-value', path, 'Expected a finite probability in [0, 1]');
  }
  return value;
};

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** A typed identifier we emit or accept as a key: lowercase, no whitespace, no separators. */
const identifier: Check<string> = (value, path) => {
  const text = string(LIMITS.identifier)(value, path);
  if (!ID_PATTERN.test(text)) refuse('invalid-value', path, 'Expected a lowercase dotted identifier');
  return text;
};

/* -------------------------------------------------------------------------- */
/* Privacy boundary                                                            */
/* -------------------------------------------------------------------------- */

/** Substring/shape scans do NOT prove privacy. The primary guarantee is that the state
 * is assembled from an allowlist of typed fields (identifiers, enums, booleans, counts)
 * plus controller-supplied PUBLIC capability descriptions — nothing else can reach the
 * wire, because nothing else is read. This scan is defense in depth against an obvious
 * mistake in those PUBLIC strings (a pasted path, key or control byte); freeform caller
 * text is not accepted anywhere, and passing this scan is never permission to transmit. */
const DENY_PATTERNS: readonly RegExp[] = [
  /[\u0000-\u001f\u007f]/,            // control characters
  /[/\\]/,                          // path separators (posix and win32)
  /\.\./,                           // parent traversal
  /sk-/i,                           // common secret prefix
  /bearer\s/i,                      // authorization header fragment
  /-----BEGIN /,                    // PEM block
  /[A-Za-z0-9+/]{40,}={0,2}/,       // long opaque/base64-ish run
  /[A-Fa-f0-9]{32,}/,               // long hex run (digest or token)
];

/** Text the controller has classified as PUBLIC and that we are willing to emit. */
function publicText(max: number): Check<string> {
  return (value, path) => {
    const text = string(max)(value, path);
    for (const pattern of DENY_PATTERNS) {
      if (pattern.test(text)) refuse('disallowed-content', path, 'Text rejected by the public-content boundary');
    }
    return text;
  };
}

/* -------------------------------------------------------------------------- */
/* Model identity                                                              */
/* -------------------------------------------------------------------------- */

const VERSIONED_MODEL_PATTERN = /^jev-\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Aliases documented by p02 on 2026-09-27. Recorded as evidence of their existence —
 * NOT as a mapping this code may follow. An alias moves without notice, so it is never
 * sent and never priced (see price-table.ts). */
export const KNOWN_ALIASES: readonly string[] = ['jev-latest', 'jev-preview'];

/** Accepts only a versioned model id such as `jev-1.13.0`. Aliases are refused here so
 * that no caller can spend on a name whose target can change. */
export const versionedModelId: Check<string> = (value, path) => {
  const text = string(LIMITS.modelId)(value, path);
  if (KNOWN_ALIASES.includes(text)) {
    refuse('model-alias', path, 'Model aliases are not usable; pin a versioned id');
  }
  if (!VERSIONED_MODEL_PATTERN.test(text)) {
    refuse('invalid-value', path, 'Expected a versioned model id (jev-<major>.<minor>.<patch>)');
  }
  return text;
};

/* -------------------------------------------------------------------------- */
/* Worker target (a different namespace from the JEV evaluator id)            */
/* -------------------------------------------------------------------------- */

/** Reasoning effort of a worker target. Omission is stated, never implied: a target that
 * passes no effort says `{ kind: 'omitted' }`. There is deliberately no cross-provider
 * effort enum — each CLI names its levels differently — so `level` is a bounded token. */
export type WorkerEffort =
  | { readonly kind: 'omitted' }
  | { readonly kind: 'level'; readonly level: string };

/** The worker a routing decision names: provider CLI, the model id that CLI is asked for,
 * and the effort — ONE tuple; a caller applying `model` without `effort` has not applied
 * the decision.
 *
 * REPRESENTATION ONLY. This is not the JEV evaluator id (`versionedModelId`), and
 * accepting a tuple proves nothing about model availability, latest status, account
 * access, or whether that CLI carries that effort. Eligibility and transport are owned by
 * #1148. No consumer exists in this slice. */
export interface WorkerTarget {
  readonly cli: string;
  readonly model: string;
  readonly effort: WorkerEffort;
}

/** Structural bounds only — no provider allowlist, no model allowlist. No whitespace,
 * control bytes or path separators; a model id is at most 128 characters. */
const CLI_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const WORKER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,127}$/;
const EFFORT_LEVEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function token(pattern: RegExp, message: string): Check<string> {
  return (value, path) => typeof value === 'string' && pattern.test(value)
    ? value : refuse('invalid-value', path, message);
}

const workerEffort: Check<WorkerEffort> = (value, path) => {
  const input = record(value, path, ['kind', 'level']);
  const kind = oneOf('omitted', 'level')(input['kind'], `${path}.kind`);
  if (kind === 'omitted') {
    if (input['level'] !== undefined) refuse('invalid-value', `${path}.level`, 'An omitted effort carries no level');
    return Object.freeze({ kind: 'omitted' });
  }
  const level = token(EFFORT_LEVEL_PATTERN, 'Expected a bounded effort token')(input['level'], `${path}.level`);
  return Object.freeze({ kind: 'level', level });
};

/** Validates `{ cli, model, effort }` as one structural tuple. `effort` is required: an
 * absent effort is refused, and omission must be written as `{ kind: 'omitted' }`.
 * Performs no selection, no network lookup, and never widens eligibility. */
export function workerTarget(input: unknown): ValidationResult<WorkerTarget> {
  return result(() => {
    const shape = object({
      cli: token(CLI_PATTERN, 'Expected a bounded CLI token'),
      model: token(WORKER_MODEL_PATTERN, 'Expected a bounded worker model token'),
      effort: workerEffort,
    })(input, '$');
    return Object.freeze({ cli: shape.cli, model: shape.model, effort: shape.effort });
  });
}

/* -------------------------------------------------------------------------- */
/* Request: synthetic state                                                    */
/* -------------------------------------------------------------------------- */

export type SizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

export interface CandidateMetadata {
  readonly id: string;
  readonly capabilities: readonly string[];
  /** Controller-supplied PUBLIC one-liner. Never a task, path, or private description. */
  readonly description: string;
}

/** Everything we are willing to put in `state`. Enumerated or derived fields only.
 * There is no field for task text, code, chat, paths, sids, cwd, env or credentials —
 * the absence of the field is the guarantee. */
export interface SyntheticState {
  readonly schema: 'aigentry.jev.route-state.v1';
  readonly role: string;
  readonly task_kind: string;
  readonly requires_web: boolean;
  readonly requires_shell: boolean;
  readonly requires_worktree: boolean;
  readonly size_bucket: SizeBucket;
  readonly touched_area_count: number;
  readonly candidates: readonly CandidateMetadata[];
}

const candidateCheck = object({
  id: identifier,
  capabilities: (value, path) => {
    const list = dataArray(value, path, LIMITS.capabilitiesPerCandidate, 'input-limit', 'Capability list exceeds validation bound');
    const items = list.map((item, index) => identifier(item, `${path}[${index}]`));
    assertUnique(items, path);
    return items;
  },
  description: publicText(LIMITS.description),
});

const stateCheck = object({
  role: identifier,
  task_kind: identifier,
  requires_web: boolean,
  requires_shell: boolean,
  requires_worktree: boolean,
  size_bucket: oneOf('xs', 's', 'm', 'l', 'xl'),
  touched_area_count: integer(LIMITS.touchedAreaCount),
  candidates: (value, path) => {
    const list = dataArray(value, path, LIMITS.candidates, 'input-limit', 'Candidate list exceeds validation bound');
    if (list.length === 0) refuse('invalid-value', path, 'At least one candidate is required');
    const items = list.map((item, index) => candidateCheck(item, `${path}[${index}]`));
    assertUnique(items.map(item => item.id), path);
    return items;
  },
});

function assertUnique(items: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) refuse('duplicate-id', path, 'Duplicate identifier');
    seen.add(item);
  }
}

/* -------------------------------------------------------------------------- */
/* Request: questions (documented subset of the official Question type)        */
/* -------------------------------------------------------------------------- */

/** The official contract allows `instructions` and every criteria description to be a
 * string, an object, or an array (p06). THIS BUILDER EMITS PLAIN STRINGS ONLY. That is a
 * deliberate, documented subset — not a claim that the provider is string-only, and not a
 * claim that arbitrary structured or templated instructions are supported here. */
export type QuestionSpec =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria?: { readonly true: string; readonly false: string } }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

const noulCriteriaCheck = object({
  true: publicText(LIMITS.description),
  false: publicText(LIMITS.description),
});

function choiceCriteria(value: unknown, path: string): Record<string, string> {
  const input = plainObject(value, path);
  const keys = Object.keys(input);
  if (keys.length < 2) refuse('invalid-value', path, 'A choice needs at least two options');
  if (keys.length > LIMITS.options) refuse('input-limit', path, 'Option map exceeds validation bound');
  const output: Record<string, string> = {};
  for (const key of keys) {
    identifier(key, `${path}.<option>`);
    output[key] = publicText(LIMITS.description)(input[key], `${path}.<option>`);
  }
  return output;
}

function scoreCriteria(value: unknown, path: string): string[] {
  const levels = 'A score needs between two and ten levels';
  const list = dataArray(value, path, LIMITS.maxLevels, 'invalid-value', levels);
  if (list.length < LIMITS.minLevels) refuse('invalid-value', path, levels);
  return list.map((item, index) => publicText(LIMITS.description)(item, `${path}[${index}]`));
}

function questionSpec(value: unknown, path: string): QuestionSpec {
  const input = plainObject(value, path);
  const type = oneOf('noul', 'choice', 'score')(input['type'], `${path}.type`);
  if (type === 'noul') {
    const shape = object({ type: oneOf('noul'), instructions: publicText(LIMITS.instructions), criteria: (raw, at) => raw === undefined ? undefined : noulCriteriaCheck(raw, at) })(input, path);
    return shape.criteria === undefined
      ? { type: 'noul', instructions: shape.instructions }
      : { type: 'noul', instructions: shape.instructions, criteria: shape.criteria };
  }
  if (type === 'choice') {
    const shape = object({ type: oneOf('choice'), instructions: publicText(LIMITS.instructions), criteria: choiceCriteria })(input, path);
    return { type: 'choice', instructions: shape.instructions, criteria: shape.criteria };
  }
  const shape = object({ type: oneOf('score'), instructions: publicText(LIMITS.instructions), criteria: scoreCriteria })(input, path);
  return { type: 'score', instructions: shape.instructions, criteria: shape.criteria };
}

export interface JevEvaluationRequest {
  readonly state: SyntheticState;
  readonly model: string;
  readonly questions: Readonly<Record<string, QuestionSpec>>;
}

/** Copies bounded JSON data once into a data-only snapshot (see plainObject/dataArray), so
 * what is measured is exactly what is later validated. */
function jsonData(value: unknown, path: string): unknown {
  let nodes = 0;
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) refuse('input-limit', path, 'Structure exceeds validation bound');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) refuse('invalid-value', path, 'Expected a finite number');
      return item;
    }
    if (typeof item !== 'object') return refuse('invalid-shape', path, 'Expected JSON data');
    const target: object = item;
    if (inspect(path, () => Array.isArray(target))) {
      return dataArray(target, path, LIMITS.nodes, 'input-limit', 'Structure exceeds validation bound')
        .map(child => copy(child, depth + 1));
    }
    const entries = plainObject(target, path);
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(entries)) { copy(key, depth + 1); output[key] = copy(entries[key], depth + 1); }
    return output;
  };
  return copy(value, 0);
}

/** Counts the UTF-8 bytes of the serialized value and refuses past `maxBytes`.
 * This is a payload bound for privacy and accuracy (C9 / p03 large-state jaggedness).
 * IT IS NOT A TOKEN COUNT AND MUST NEVER BE CONVERTED INTO ONE. */
function serializedBytes(value: unknown, maxBytes: number, path: string): number {
  let bytes = 0;
  for (const character of JSON.stringify(jsonData(value, path)) ?? '') {
    const code = character.codePointAt(0) as number;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > maxBytes) refuse('input-limit', path, 'Serialized payload exceeds byte ceiling');
  }
  return bytes;
}

/** Builds the one request shape this module supports.
 *
 * Accepts `unknown` because the caller may be untyped: every field is validated here, and
 * only allowlisted typed fields plus PUBLIC descriptions survive into the result. The
 * model must already be a resolved versioned id (see price-table.ts) — this function
 * performs no selection and no eligibility widening. */
export function buildEvaluationRequest(input: unknown): ValidationResult<JevEvaluationRequest> {
  return result(() => {
    const outer = object({
      model: versionedModelId,
      state: stateCheck,
      questions: (value, path) => {
        const map = plainObject(value, path);
        const keys = Object.keys(map);
        if (keys.length === 0) refuse('invalid-value', path, 'At least one question is required');
        if (keys.length > LIMITS.questions) refuse('input-limit', path, 'Question map exceeds validation bound');
        const output: Record<string, QuestionSpec> = {};
        for (const key of keys) {
          identifier(key, `${path}.<question>`);
          output[key] = questionSpec(map[key], `${path}.<question>`);
        }
        return output;
      },
    })(input, '$');

    const state: SyntheticState = { schema: 'aigentry.jev.route-state.v1', ...outer.state };
    // C9: the ceiling covers state + questions together, exactly what we will send.
    serializedBytes({ state, questions: outer.questions }, LIMITS.requestBytes, '$');
    return { state, model: outer.model, questions: outer.questions };
  });
}

/* -------------------------------------------------------------------------- */
/* Response                                                                    */
/* -------------------------------------------------------------------------- */

export type NoulAnswer = { readonly type: 'noul'; readonly noul: number };
export type ChoiceAnswer = {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};
export type ScoreAnswer = {
  readonly type: 'score';
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface Usage { readonly input_tokens: number; readonly output_tokens: number }

export interface JevEvaluationResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: Usage;
}

const usageCheck = object({
  input_tokens: integer(Number.MAX_SAFE_INTEGER),
  output_tokens: integer(Number.MAX_SAFE_INTEGER),
});

/** Reads a probability map whose key set must equal `expectedKeys` exactly. `keySegment`,
 * when given, replaces caller-named keys in refusal paths. */
function probabilities(
  value: unknown, path: string, expectedKeys: readonly string[], keySegment?: string,
): Record<string, number> {
  const input = plainObject(value, path);
  const keys = Object.keys(input);
  if (keys.length !== expectedKeys.length) {
    refuse('key-mismatch', path, 'Probability keys do not match the requested keys');
  }
  const output: Record<string, number> = {};
  let sum = 0;
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      refuse('key-mismatch', path, 'Probability keys do not match the requested keys');
    }
    const value_ = probability(input[key], `${path}.${keySegment ?? key}`);
    output[key] = value_;
    sum += value_;
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    refuse('invalid-value', path, 'Probabilities do not sum to one within tolerance');
  }
  return output;
}

function noulAnswer(value: unknown, path: string): NoulAnswer {
  // p06: a Noul answer carries no `confidence` and no `probabilities`. A stray field is
  // rejected as unknown, so no gate can read a confidence that does not exist.
  const shape = object({ type: oneOf('noul'), noul: probability })(value, path);
  return { type: 'noul', noul: shape.noul };
}

function choiceAnswer(value: unknown, path: string, options: readonly string[]): ChoiceAnswer {
  const shape = object({
    type: oneOf('choice'),
    choice: string(LIMITS.identifier),
    probabilities: (raw, at) => probabilities(raw, at, options, '<option>'),
    confidence: probability,
  })(value, path);
  if (!options.includes(shape.choice)) {
    refuse('key-mismatch', `${path}.choice`, 'Selected option is not one of the requested options');
  }
  const highest = Math.max(...options.map(option => shape.probabilities[option]));
  if (shape.probabilities[shape.choice] < highest - PROBABILITY_SUM_TOLERANCE) {
    refuse('invalid-value', `${path}.choice`, 'Selected option is not the highest-probability option');
  }
  return { type: 'choice', choice: shape.choice, probabilities: shape.probabilities, confidence: shape.confidence };
}

function scoreAnswer(value: unknown, path: string, levels: readonly string[]): ScoreAnswer {
  // p06: `legend` maps each level number, as a decimal string key, back to OUR level
  // description; `probabilities` is keyed by that same index-string set — never by the
  // descriptions themselves.
  const indexKeys = levels.map((_level, index) => String(index));
  const shape = object({
    type: oneOf('score'),
    score: (raw, at) => {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > levels.length - 1) {
        return refuse('invalid-value', at, 'Expected a finite score within the level range');
      }
      return raw;
    },
    legend: (raw, at) => {
      const input = plainObject(raw, at);
      const keys = Object.keys(input);
      if (keys.length !== indexKeys.length) refuse('key-mismatch', at, 'Legend keys do not match the requested levels');
      const output: Record<string, string> = {};
      indexKeys.forEach((key, index) => {
        if (!Object.prototype.hasOwnProperty.call(input, key)) {
          refuse('key-mismatch', at, 'Legend keys do not match the requested levels');
        }
        if (input[key] !== levels[index]) {
          refuse('invalid-value', `${at}.${key}`, 'Legend description differs from the requested level');
        }
        output[key] = levels[index];
      });
      return output;
    },
    probabilities: (raw, at) => probabilities(raw, at, indexKeys),
    confidence: probability,
  })(value, path);
  const weighted = indexKeys.reduce((total, key, index) => total + index * shape.probabilities[key], 0);
  if (Math.abs(weighted - shape.score) > SCORE_WEIGHTED_TOLERANCE) {
    refuse('invalid-value', `${path}.score`, 'Score is not the probability-weighted level value');
  }
  return {
    type: 'score', score: shape.score, legend: shape.legend,
    probabilities: shape.probabilities, confidence: shape.confidence,
  };
}

function answerFor(question: QuestionSpec, value: unknown, path: string): Answer {
  const input = plainObject(value, path);
  if (input['type'] !== question.type) {
    refuse('invalid-value', `${path}.type`, 'Answer type differs from the requested question type');
  }
  if (question.type === 'noul') return noulAnswer(input, path);
  if (question.type === 'choice') return choiceAnswer(input, path, Object.keys(question.criteria));
  return scoreAnswer(input, path, question.criteria);
}

/** Validates a parsed response against exactly the request that produced it.
 *
 * Refuse, never repair: there is no coercion, no defaulting and no partial acceptance.
 * A single failure refuses the whole response, and the caller must have a deterministic
 * branch. `request` is the value returned by buildEvaluationRequest, so the expected
 * answer keys, option names and level descriptions are the ones actually sent. */
export function validateEvaluationResponse(
  input: unknown, request: JevEvaluationRequest,
): ValidationResult<JevEvaluationResponse> {
  return result(() => {
    // One read of the caller's value; the byte ceiling and every check below see this copy.
    const data = jsonData(input, '$');
    serializedBytes(data, LIMITS.responseBytes, '$');
    const outer = object({
      model: versionedModelId,
      answers: (value, path) => plainObject(value, path),
      usage: usageCheck,
    })(data, '$');

    // The response must come from the exact versioned model we requested. A different id
    // (including one an alias silently moved to) refuses use of the answer.
    if (outer.model !== request.model) {
      refuse('model-mismatch', '$.model', 'Response model is not the requested versioned model');
    }

    const requestedIds = Object.keys(request.questions);
    const answeredIds = Object.keys(outer.answers);
    if (answeredIds.length !== requestedIds.length) {
      refuse('key-mismatch', '$.answers', 'Answer keys do not match the requested question keys');
    }
    const answers: Record<string, Answer> = {};
    for (const id of requestedIds) {
      if (!Object.prototype.hasOwnProperty.call(outer.answers, id)) {
        refuse('key-mismatch', '$.answers', 'Answer keys do not match the requested question keys');
      }
      answers[id] = answerFor(request.questions[id], outer.answers[id], '$.answers.<question>');
    }
    return { model: outer.model, answers, usage: outer.usage };
  });
}
