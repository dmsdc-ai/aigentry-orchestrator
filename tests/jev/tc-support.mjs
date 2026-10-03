/** Synthetic-only fixture builders for the independent jt1179ka JEV contract regressions.
 *
 * Nothing here opens a socket, reads a credential, or authorizes a paid call. Every string
 * is invented for this test bundle. The one sentinel used to probe refusal-path echo is a
 * synthetic marker, NOT a real secret.
 */

/** Synthetic sentinel for finding 2. Deliberately contains no real secret material. */
export const LEAK_SENTINEL = 'zz-sentinel-unknown-field-echo-0001';

/** Model strings actually observed in the staged router caller
 * (input/prior-input/current/bin/model-router.mjs) plus the profile's allowed CLI set.
 * These are the real worker targets a routing decision must be able to express. */
export const OBSERVED_WORKER_MODELS = Object.freeze([
  'claude-opus-5[1m]',            // model-router.mjs:9 EMERGENCY_ROUTE
  'claude-haiku-4-5-20251001',    // model-router.mjs:78 classifier --model
  'claude-opus-4-8',
  'gpt-5-codex',
  'gemini-2.5-pro',
  'grok-4',
]);

/** Additional worker model NAMESPACES, to show the structural token is not one vendor's
 * shape. Structural acceptance only — never a claim of availability, latest status or access. */
export const WORKER_MODEL_NAMESPACES = Object.freeze([
  'us.anthropic.claude-opus-5-v1:0',   // dotted + colon, cloud-gateway style
  'gpt-5-codex@2026-01-01',            // @-dated
  'Qwen3-235B',                        // mixed case
  'o4',                                // two characters
]);

/** Model ids containing `/`. Recorded as a PRESENT STRUCTURAL LIMITATION of workerTarget —
 * not a compatibility guarantee, not a request to widen the pattern, and not permission to
 * widen scope. Some real provider ids use this form. */
export const SLASH_WORKER_MODELS = Object.freeze([
  'anthropic/claude-opus-5',
  'meta-llama/Llama-3-70b',
  'openrouter/auto',
]);

/** Allowed CLI values in the router profile validator (model-router.mjs:51). */
export const ROUTER_CLIS = Object.freeze(['claude', 'codex', 'grok', 'gemini']);

export function workerTargetInput(overrides = {}) {
  return { cli: 'claude', model: 'claude-opus-5[1m]', effort: { kind: 'level', level: 'high' }, ...overrides };
}

export const PRICED_MODEL = 'jev-1.13.0';

/** A minimal valid state body (the builder injects `schema` itself). */
export function stateInput(overrides = {}) {
  return {
    role: 'tester',
    task_kind: 'contract-regression',
    requires_web: false,
    requires_shell: true,
    requires_worktree: false,
    size_bucket: 'm',
    touched_area_count: 3,
    candidates: [
      { id: 'cand-a', capabilities: ['shell', 'read'], description: 'General worker profile A' },
      { id: 'cand-b', capabilities: ['read'], description: 'Read only worker profile B' },
    ],
    ...overrides,
  };
}

export function noulQuestion(overrides = {}) {
  return {
    type: 'noul',
    instructions: 'Does this task need a shell?',
    criteria: { true: 'Shell is required', false: 'No shell needed' },
    ...overrides,
  };
}

export function choiceQuestion(overrides = {}) {
  return {
    type: 'choice',
    instructions: 'Which worker should take this task?',
    criteria: { 'cand-a': 'General worker', 'cand-b': 'Read only worker' },
    ...overrides,
  };
}

export function scoreQuestion(overrides = {}) {
  return {
    type: 'score',
    instructions: 'How large is the change surface?',
    criteria: ['Tiny', 'Moderate', 'Large'],
    ...overrides,
  };
}

export function requestInput(overrides = {}) {
  return {
    model: PRICED_MODEL,
    state: stateInput(),
    questions: {
      'needs-shell': noulQuestion(),
      'pick-worker': choiceQuestion(),
      'surface-size': scoreQuestion(),
    },
    ...overrides,
  };
}

export function responseFor(request, overrides = {}) {
  return {
    model: request.model,
    answers: {
      'needs-shell': { type: 'noul', noul: 0.75 },
      'pick-worker': {
        type: 'choice',
        choice: 'cand-a',
        probabilities: { 'cand-a': 0.7, 'cand-b': 0.3 },
        confidence: 0.64,
      },
      'surface-size': {
        type: 'score',
        score: 1.1,
        legend: { 0: 'Tiny', 1: 'Moderate', 2: 'Large' },
        probabilities: { 0: 0.2, 1: 0.5, 2: 0.3 },
        confidence: 0.52,
      },
    },
    usage: { input_tokens: 296, output_tokens: 20 },
    ...overrides,
  };
}

/** Fresh, in-window price evidence for the one priced row (evidencedAt 2026-09-27).
 *
 * `maxAgeMs` is 24 h, not 1 h, and that is forced by the module rather than chosen: the same
 * window governs the caller's instant-granular revalidation AND the day-granular price row,
 * whose `evidencedAt` normalizes to 00:00:00Z. Any window shorter than the time-of-day offset
 * of `now` makes the only priced row unresolvable. See the observation recorded in REPORT.md. */
export function priceEvidence(overrides = {}) {
  return {
    requestedModel: PRICED_MODEL,
    catalogStatus: 'verified-fresh',
    verifiedAt: '2026-09-27T12:00:00Z',
    observedVersionedIds: [PRICED_MODEL],
    now: '2026-09-27T12:30:00Z',
    maxAgeMs: 86_400_000,
    ...overrides,
  };
}

export function boundEvidenceInput(overrides = {}) {
  return {
    maxBillableInputTokens: 64_000,
    evidence: {
      source: 'SYNTHETIC test fixture, not a provider statement',
      observedAt: '2026-09-27T12:00:00Z',
      statement: 'SYNTHETIC: a maximum billable input-token count of 64000 was declared by a test.',
    },
    ...overrides,
  };
}

/** The user's configured aggregate maximum for this task, in integer nanoUSD.
 * USD 50 = 50 * 10^9 nanoUSD. One user's configured ceiling, not a default. */
export const CEILING_NANO_USD_50 = 50_000_000_000;

/** Unwrap an expected-ok result, failing loudly with the refusal when it is not ok. */
export function expectOk(result) {
  if (!result.ok) {
    throw new Error(`expected ok, got refusal ${result.reason.code} at ${result.reason.path}: ${result.reason.message}`);
  }
  return result.value;
}

/** A property backed by a getter that returns `values[i]` on the i-th read and the last
 * value thereafter. Originally used to prove double-read entrypoints; in r2 it is used the
 * other way round — to prove the getter is NEVER invoked (the returned counter stays 0). */
export function sequenceAccessor(target, key, values) {
  let reads = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      const value = values[Math.min(reads, values.length - 1)];
      reads += 1;
      return value;
    },
  });
  return () => reads;
}

/** A getter that throws if it is ever invoked, plus a counter. Any read is a hard failure
 * of the "accessors are refused without invoking getters" property. */
export function trapAccessor(target, key) {
  let reads = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() { reads += 1; throw new Error(`TRAP: getter for ${key} was invoked`); },
  });
  return () => reads;
}

/** A non-enumerable own data property. */
export function hiddenProperty(target, key, value) {
  Object.defineProperty(target, key, { enumerable: false, configurable: true, writable: true, value });
  return target;
}

/** An array with a hole at `holeIndex` (length preserved), for sparse-array probes. */
export function sparseArray(items, holeIndex) {
  const out = items.slice();
  delete out[holeIndex];
  return out;
}
