import { createHash } from 'node:crypto';
/** Adapter proposal v1. These identifiers are never proof of authority. */
export const SCHEMA = 'aigentry.workbench.adapter.v1';
export const LIMITS = { files: 32, bytes: 1024 * 1024, total: 8 * 1024 * 1024 };
export function requireValue(condition) {
    if (!condition)
        throw new Error('invalid-workbench-input');
}
export function object(value) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
    return value;
}
export function id(value) {
    requireValue(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value));
}
export function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
export function digest(value) {
    // Canonical JSON is also compared in full by the server's idempotency ledger.
    function canonical(v) {
        if (Array.isArray(v))
            return v.map(canonical);
        if (v !== null && typeof v === 'object') {
            return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(object(v)[k])]));
        }
        return v;
    }
    return hash(JSON.stringify(canonical(value)));
}
/**
 * Bounded safe Unicode: a leading letter or decimal digit, then letters, the combining
 * marks NFC/NFD spellings actually produce, decimal digits and the original ASCII
 * separators. Everything else stays refused — controls, format/bidi characters, other
 * whitespace, other punctuation and symbols — so this is not "every printable character".
 */
const SAFE_COMPONENT = /^[\p{L}\p{Nd}][\p{L}\p{Mn}\p{Mc}\p{Nd} _.-]*$/u;
/** A short UTF-16 name can still exceed a filesystem component's byte budget. */
const COMPONENT_BYTES = 255;
/** One visible component: no separator, traversal, device or encoded-escape byte survives. */
export function safeComponent(value, maxLength) {
    return typeof value === 'string' && value.length <= maxLength
        && Buffer.byteLength(value, 'utf8') <= COMPONENT_BYTES
        && SAFE_COMPONENT.test(value) && !value.includes('..');
}
/**
 * Canonical collision key only: NFC folds the NFC/NFD spellings of one name together and
 * the existing case-insensitive policy still refuses canonical-equivalent duplicates.
 * The key is never written back — the captured path bytes reach the filesystem unchanged.
 */
export function pathKey(value) {
    return value.normalize('NFC').toLowerCase();
}
/**
 * Malformed UTF-8 is a contract refusal, not a raw decoder TypeError. Only the decode
 * call is guarded, so unrelated failures still propagate, and no byte is replaced.
 */
export function requireUtf8(bytes) {
    let decodable = true;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        decodable = false;
    }
    requireValue(decodable);
}
/** Flat, portable, visible Markdown names only. Nested selections require another adapter. */
export function markdownPath(value) {
    requireValue(safeComponent(value, 160) && value.endsWith('.md')
        && !/[ .]\.md$/.test(value)
        && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])([ .]|$)/i.test(value)
        && !/^(secrets?|credentials?|recordings?)([ ._-]|$)/i.test(value));
}
export function decode(value) {
    requireValue(typeof value === 'string' && value.length <= Math.ceil(LIMITS.bytes / 3) * 4
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
    const bytes = Buffer.from(value, 'base64');
    requireValue(bytes.length <= LIMITS.bytes && bytes.toString('base64') === value);
    requireUtf8(bytes);
    return bytes;
}
export function selection(value) {
    const v = object(value);
    requireValue(v.schema === SCHEMA);
    id(v.operationId);
    const scope = object(v.scope);
    for (const key of ['tenant', 'project', 'vaultId', 'purpose'])
        id(scope[key]);
    requireValue(Array.isArray(v.notes) && v.notes.length > 0 && v.notes.length <= LIMITS.files);
    const paths = new Set();
    const ids = new Set();
    for (const item of v.notes) {
        const n = object(item);
        for (const key of ['noteId', 'baseRevision', 'sourceId', 'occurrenceId', 'revisionId'])
            id(n[key]);
        markdownPath(n.path);
        // Canonical-equivalent spellings of one name are one destination, so one selection.
        const collisionKey = pathKey(n.path);
        requireValue(!paths.has(collisionKey) && !ids.has(n.noteId));
        paths.add(collisionKey);
        ids.add(n.noteId);
        requireValue(Array.isArray(n.predecessors) && n.predecessors.length <= LIMITS.files);
        n.predecessors.forEach(id);
        requireValue(Array.isArray(n.citations) && n.citations.length <= 128);
        for (const item of n.citations) {
            const c = object(item);
            for (const key of ['authority', 'sourceId', 'occurrenceId', 'revisionId'])
                id(c[key]);
            requireValue(typeof c.blobHash === 'string' && /^[a-f0-9]{64}$/.test(c.blobHash)
                && Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end)
                && c.start >= 0 && c.end >= c.start);
        }
        const a = object(n.attribution);
        requireValue(a.kind === 'authored' || a.kind === 'generated');
        if (a.kind === 'generated') {
            id(a.generator);
            id(a.version);
            requireValue(Array.isArray(a.dependencies) && a.dependencies.length <= 128);
            a.dependencies.forEach(id);
        }
    }
    // Deep snapshot: caller mutation cannot change the approved request later.
    return JSON.parse(JSON.stringify({ schema: SCHEMA, operationId: v.operationId,
        scope: v.scope, notes: v.notes }));
}
//# sourceMappingURL=workbench-contract.js.map