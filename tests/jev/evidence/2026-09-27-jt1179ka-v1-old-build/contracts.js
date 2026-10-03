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
 * Refusal messages are constants. No refusal ever echoes offending input text.
 * Only `undefined` denotes an absent optional field; `null` is malformed input.
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
class Invalid extends Error {
    reason;
    constructor(reason) {
        super(reason.message);
        this.reason = reason;
    }
}
/** @internal shared by the sibling modules of this bundle; never echoes input. */
export function refuse(code, path, message) {
    throw new Invalid({ code, path, message });
}
/** @internal wraps a throwing checker into a ValidationResult. */
export function result(operation) {
    try {
        return { ok: true, value: operation() };
    }
    catch (error) {
        if (error instanceof Invalid)
            return { ok: false, reason: error.reason };
        return { ok: false, reason: { code: 'invalid-shape', path: '$', message: 'Unreadable input' } };
    }
}
/** Keys that must never be accepted from parsed JSON, in a closed shape or an open map. */
const RESERVED_KEYS = ['__proto__', 'prototype', 'constructor'];
function plainObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return refuse('invalid-shape', path, 'Expected an object');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return refuse('invalid-shape', path, 'Expected a plain JSON object');
    }
    for (const key of Object.getOwnPropertyNames(value)) {
        if (RESERVED_KEYS.includes(key))
            refuse('reserved-key', path, 'Reserved property key');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
        refuse('invalid-shape', path, 'Expected a plain JSON object');
    }
    return value;
}
function object(shape) {
    return (value, path) => {
        const input = plainObject(value, path);
        for (const key of Object.keys(input)) {
            if (!Object.prototype.hasOwnProperty.call(shape, key)) {
                refuse('unknown-field', `${path}.${key}`, 'Unexpected field');
            }
        }
        const output = {};
        for (const key of Object.keys(shape))
            output[key] = shape[key](input[key], `${path}.${key}`);
        return output;
    };
}
function string(max) {
    return (value, path) => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            return refuse('invalid-value', path, 'Expected nonempty text');
        }
        if (value.length > max)
            refuse('input-limit', path, 'Text exceeds validation bound');
        return value;
    };
}
const boolean = (value, path) => typeof value === 'boolean'
    ? value : refuse('invalid-value', path, 'Expected boolean');
function oneOf(...values) {
    return (value, path) => values.some(item => item === value)
        ? value : refuse('invalid-value', path, 'Unexpected enum value');
}
function integer(max, min = 0) {
    return (value, path) => {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
            return refuse('invalid-value', path, `Expected safe integer in [${min}, ${max}]`);
        }
        return value;
    };
}
/** Finite number in [0,1]. Rejects NaN, ±Infinity and out-of-range values. */
const probability = (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        return refuse('invalid-value', path, 'Expected a finite probability in [0, 1]');
    }
    return value;
};
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
/** A typed identifier we emit or accept as a key: lowercase, no whitespace, no separators. */
const identifier = (value, path) => {
    const text = string(LIMITS.identifier)(value, path);
    if (!ID_PATTERN.test(text))
        refuse('invalid-value', path, 'Expected a lowercase dotted identifier');
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
const DENY_PATTERNS = [
    /[\u0000-\u001f\u007f]/, // control characters
    /[/\\]/, // path separators (posix and win32)
    /\.\./, // parent traversal
    /sk-/i, // common secret prefix
    /bearer\s/i, // authorization header fragment
    /-----BEGIN /, // PEM block
    /[A-Za-z0-9+/]{40,}={0,2}/, // long opaque/base64-ish run
    /[A-Fa-f0-9]{32,}/, // long hex run (digest or token)
];
/** Text the controller has classified as PUBLIC and that we are willing to emit. */
function publicText(max) {
    return (value, path) => {
        const text = string(max)(value, path);
        for (const pattern of DENY_PATTERNS) {
            if (pattern.test(text))
                refuse('disallowed-content', path, 'Text rejected by the public-content boundary');
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
export const KNOWN_ALIASES = ['jev-latest', 'jev-preview'];
/** Accepts only a versioned model id such as `jev-1.13.0`. Aliases are refused here so
 * that no caller can spend on a name whose target can change. */
export const versionedModelId = (value, path) => {
    const text = string(LIMITS.modelId)(value, path);
    if (KNOWN_ALIASES.includes(text)) {
        refuse('model-alias', path, 'Model aliases are not usable; pin a versioned id');
    }
    if (!VERSIONED_MODEL_PATTERN.test(text)) {
        refuse('invalid-value', path, 'Expected a versioned model id (jev-<major>.<minor>.<patch>)');
    }
    return text;
};
/** Pairs an already-resolved versioned model id with an effort level. Performs no
 * selection, no network lookup, and never widens eligibility. */
export function modelEffortTarget(model, effort) {
    return result(() => ({
        model: versionedModelId(model, '$.model'),
        effort: oneOf('low', 'medium', 'high', 'xhigh')(effort, '$.effort'),
    }));
}
const candidateCheck = object({
    id: identifier,
    capabilities: (value, path) => {
        if (!Array.isArray(value))
            return refuse('invalid-shape', path, 'Expected array');
        if (value.length > LIMITS.capabilitiesPerCandidate) {
            refuse('input-limit', path, 'Capability list exceeds validation bound');
        }
        const items = value.map((item, index) => identifier(item, `${path}[${index}]`));
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
        if (!Array.isArray(value))
            return refuse('invalid-shape', path, 'Expected array');
        if (value.length === 0)
            refuse('invalid-value', path, 'At least one candidate is required');
        if (value.length > LIMITS.candidates)
            refuse('input-limit', path, 'Candidate list exceeds validation bound');
        const items = value.map((item, index) => candidateCheck(item, `${path}[${index}]`));
        assertUnique(items.map(item => item.id), path);
        return items;
    },
});
function assertUnique(items, path) {
    const seen = new Set();
    for (const item of items) {
        if (seen.has(item))
            refuse('duplicate-id', path, 'Duplicate identifier');
        seen.add(item);
    }
}
const noulCriteriaCheck = object({
    true: publicText(LIMITS.description),
    false: publicText(LIMITS.description),
});
function choiceCriteria(value, path) {
    const input = plainObject(value, path);
    const keys = Object.keys(input);
    if (keys.length < 2)
        refuse('invalid-value', path, 'A choice needs at least two options');
    if (keys.length > LIMITS.options)
        refuse('input-limit', path, 'Option map exceeds validation bound');
    const output = {};
    for (const key of keys) {
        identifier(key, `${path}.<option>`);
        output[key] = publicText(LIMITS.description)(input[key], `${path}.${key}`);
    }
    return output;
}
function scoreCriteria(value, path) {
    if (!Array.isArray(value))
        return refuse('invalid-shape', path, 'Expected array');
    if (value.length < LIMITS.minLevels || value.length > LIMITS.maxLevels) {
        refuse('invalid-value', path, 'A score needs between two and ten levels');
    }
    return value.map((item, index) => publicText(LIMITS.description)(item, `${path}[${index}]`));
}
function questionSpec(value, path) {
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
/** Counts the UTF-8 bytes of the serialized value and refuses past `maxBytes`.
 * This is a payload bound for privacy and accuracy (C9 / p03 large-state jaggedness).
 * IT IS NOT A TOKEN COUNT AND MUST NEVER BE CONVERTED INTO ONE. */
function serializedBytes(value, maxBytes, path) {
    let nodes = 0;
    const visit = (item, depth) => {
        if (++nodes > LIMITS.nodes || depth > LIMITS.depth)
            refuse('input-limit', path, 'Structure exceeds validation bound');
        if (item === null || typeof item === 'boolean' || typeof item === 'string')
            return;
        if (typeof item === 'number') {
            if (!Number.isFinite(item))
                refuse('invalid-value', path, 'Expected a finite number');
            return;
        }
        if (typeof item !== 'object')
            refuse('invalid-shape', path, 'Expected JSON data');
        if (Array.isArray(item)) {
            for (const child of item)
                visit(child, depth + 1);
            return;
        }
        for (const [key, child] of Object.entries(plainObject(item, path))) {
            visit(key, depth + 1);
            visit(child, depth + 1);
        }
    };
    visit(value, 0);
    let bytes = 0;
    for (const character of JSON.stringify(value) ?? '') {
        const code = character.codePointAt(0);
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        if (bytes > maxBytes)
            refuse('input-limit', path, 'Serialized payload exceeds byte ceiling');
    }
    return bytes;
}
/** Builds the one request shape this module supports.
 *
 * Accepts `unknown` because the caller may be untyped: every field is validated here, and
 * only allowlisted typed fields plus PUBLIC descriptions survive into the result. The
 * model must already be a resolved versioned id (see price-table.ts) — this function
 * performs no selection and no eligibility widening. */
export function buildEvaluationRequest(input) {
    return result(() => {
        const outer = object({
            model: versionedModelId,
            state: stateCheck,
            questions: (value, path) => {
                const map = plainObject(value, path);
                const keys = Object.keys(map);
                if (keys.length === 0)
                    refuse('invalid-value', path, 'At least one question is required');
                if (keys.length > LIMITS.questions)
                    refuse('input-limit', path, 'Question map exceeds validation bound');
                const output = {};
                for (const key of keys) {
                    identifier(key, `${path}.<question>`);
                    output[key] = questionSpec(map[key], `${path}.${key}`);
                }
                return output;
            },
        })(input, '$');
        const state = { schema: 'aigentry.jev.route-state.v1', ...outer.state };
        // C9: the ceiling covers state + questions together, exactly what we will send.
        serializedBytes({ state, questions: outer.questions }, LIMITS.requestBytes, '$');
        return { state, model: outer.model, questions: outer.questions };
    });
}
const usageCheck = object({
    input_tokens: integer(Number.MAX_SAFE_INTEGER),
    output_tokens: integer(Number.MAX_SAFE_INTEGER),
});
/** Reads a probability map whose key set must equal `expectedKeys` exactly. */
function probabilities(value, path, expectedKeys) {
    const input = plainObject(value, path);
    const keys = Object.keys(input);
    if (keys.length !== expectedKeys.length) {
        refuse('key-mismatch', path, 'Probability keys do not match the requested keys');
    }
    const output = {};
    let sum = 0;
    for (const key of expectedKeys) {
        if (!Object.prototype.hasOwnProperty.call(input, key)) {
            refuse('key-mismatch', path, 'Probability keys do not match the requested keys');
        }
        const value_ = probability(input[key], `${path}.${key}`);
        output[key] = value_;
        sum += value_;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
        refuse('invalid-value', path, 'Probabilities do not sum to one within tolerance');
    }
    return output;
}
function noulAnswer(value, path) {
    // p06: a Noul answer carries no `confidence` and no `probabilities`. A stray field is
    // rejected as unknown, so no gate can read a confidence that does not exist.
    const shape = object({ type: oneOf('noul'), noul: probability })(value, path);
    return { type: 'noul', noul: shape.noul };
}
function choiceAnswer(value, path, options) {
    const shape = object({
        type: oneOf('choice'),
        choice: string(LIMITS.identifier),
        probabilities: (raw, at) => probabilities(raw, at, options),
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
function scoreAnswer(value, path, levels) {
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
            if (keys.length !== indexKeys.length)
                refuse('key-mismatch', at, 'Legend keys do not match the requested levels');
            const output = {};
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
function answerFor(question, value, path) {
    const input = plainObject(value, path);
    if (input['type'] !== question.type) {
        refuse('invalid-value', `${path}.type`, 'Answer type differs from the requested question type');
    }
    if (question.type === 'noul')
        return noulAnswer(input, path);
    if (question.type === 'choice')
        return choiceAnswer(input, path, Object.keys(question.criteria));
    return scoreAnswer(input, path, question.criteria);
}
/** Validates a parsed response against exactly the request that produced it.
 *
 * Refuse, never repair: there is no coercion, no defaulting and no partial acceptance.
 * A single failure refuses the whole response, and the caller must have a deterministic
 * branch. `request` is the value returned by buildEvaluationRequest, so the expected
 * answer keys, option names and level descriptions are the ones actually sent. */
export function validateEvaluationResponse(input, request) {
    return result(() => {
        serializedBytes(input, LIMITS.responseBytes, '$');
        const outer = object({
            model: versionedModelId,
            answers: (value, path) => plainObject(value, path),
            usage: usageCheck,
        })(input, '$');
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
        const answers = {};
        for (const id of requestedIds) {
            if (!Object.prototype.hasOwnProperty.call(outer.answers, id)) {
                refuse('key-mismatch', '$.answers', 'Answer keys do not match the requested question keys');
            }
            answers[id] = answerFor(request.questions[id], outer.answers[id], `$.answers.${id}`);
        }
        return { model: outer.model, answers, usage: outer.usage };
    });
}
//# sourceMappingURL=contracts.js.map