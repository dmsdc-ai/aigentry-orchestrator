import {
  type CollectedRecordV1, type CollectorConfigV1, type Coverage, type EfficiencyResult, type SourceKind,
  SOURCE_KINDS, isId, metadataId, parseIsoMs, parseUtc, validateCollectorConfigV1, validateEscalationV1, validateEventV1,
} from './efficiency-contracts.js';

/** PURE incremental decoder: caller-supplied byte chunks → typed minimum-metadata records.
 * It never opens paths, stats files, prunes logs, reads env/clock or spawns anything; the
 * caller supplies bytes, an opaque source identity, generation, cursor and observation time.
 * State is returned, never mutated in place. Raw line bytes are discarded after decoding;
 * only whitelisted typed fields and metadata digests are retained.
 *
 * A later I/O adapter (not this slice) must derive `generation` from a stable prefix length
 * plus the same opened-FD identity, so an ordinary append to a file smaller than 256 B is not
 * mistaken for rotation (draft headDigest bug). Legacy offsets carry no idempotency claim
 * after an inode copy; copy-truncate re-presentation is only flagged `possibleDuplicate`.
 */
export interface GapV1 {
  sourceId: string; reason: 'generation-change' | 'cursor-reset' | 'cursor-skip';
  previousGeneration: number; previousCursor: number; generation: number; cursor: number; observedAt: string;
}
export interface CollectorCountersV1 {
  bytesConsumed: number; linesSeen: number; recordsEmitted: number; emptyLines: number; emptyChunks: number;
  malformed: number; unknownField: number; unknownVersion: number; invalidValue: number; oversizeLines: number;
  duplicates: number; conflicts: number; possibleDuplicates: number; late: number; clockSkew: number;
  clockRollback: number; capStops: number; gaps: number; gapsDropped: number; tailDiscardedBytes: number; dedupEvictions: number;
}
export interface CollectorStateV1 {
  schemaVersion: 1; sourceId: string; sourceKind: SourceKind; generation: number; cursor: number;
  /** Retained partial line, ≤ maxLineBytes; tailStart is its byte offset within the generation.
   * The tail is RAW, undecoded line bytes (may hold secrets) and is transient in-memory state only:
   * future storage adapters MUST NOT serialize or persist `tail`; this state is not safe storage output. */
  tail: Uint8Array | null; tailStart: number | null;
  /** Oversize-line skip state resumes across chunks/windows until the next newline. */
  skipping: boolean;
  watermarkMs: number | null; lastObservedMs: number | null;
  /** Bounded FIFO [eventId, normalized-body digest]; eviction ends the dedup horizon (no exactly-once claim). */
  eventIds: readonly (readonly [string, string])[];
  conflictedIds: readonly string[];
  /** Bounded FIFO of whitelisted escalation identities (copy-truncate possible-duplicate check). */
  recentEscalations: readonly string[];
  gaps: readonly GapV1[];
  totals: CollectorCountersV1;
}
export interface CollectWindowInputV1 {
  generation: number; cursor: number; chunks: readonly Uint8Array[];
  /** Supplied collector clock (ISO-ms). Producer `at`/`ts` keep their own producer-clock basis. */
  observedAt: string;
  /** true only when the chunks reach the currently known end of the source. */
  endOfData: boolean;
}
export type CoverageReason = 'gap' | 'cap-stop' | 'not-end-of-data' | 'pending-tail' | 'dropped-lines'
  | 'event-id-conflict' | 'clock-rollback' | 'dedup-horizon';
export interface CollectWindowResultV1 {
  state: CollectorStateV1; records: CollectedRecordV1[]; gaps: GapV1[];
  counters: CollectorCountersV1; coverage: Exclude<Coverage, 'unknown'>; reasons: CoverageReason[];
  consumedBytes: number; nextCursor: number; pendingTailBytes: number;
  idempotency: 'bounded-horizon';
}

function zero(): CollectorCountersV1 {
  return { bytesConsumed: 0, linesSeen: 0, recordsEmitted: 0, emptyLines: 0, emptyChunks: 0, malformed: 0,
    unknownField: 0, unknownVersion: 0, invalidValue: 0, oversizeLines: 0, duplicates: 0, conflicts: 0,
    possibleDuplicates: 0, late: 0, clockSkew: 0, clockRollback: 0, capStops: 0, gaps: 0, gapsDropped: 0,
    tailDiscardedBytes: 0, dedupEvictions: 0 };
}
function sum(a: CollectorCountersV1, b: CollectorCountersV1): CollectorCountersV1 {
  const out = { ...a };
  for (const key of Object.keys(b) as (keyof CollectorCountersV1)[]) out[key] = Math.min(Number.MAX_SAFE_INTEGER, a[key] + b[key]);
  return out;
}
function refused<T>(path: string): EfficiencyResult<T> { return { ok: false, reason: { code: 'invalid-value', path } }; }
function isCount(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** Signed epoch ms: parseIsoMs/parseUtc accept any 4-digit year, so pre-1970 clocks are negative, not counters. */
function isEpochMs(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value); }

export function createCollectorState(sourceId: string, sourceKind: SourceKind): EfficiencyResult<CollectorStateV1> {
  if (!isId(sourceId)) return refused('$.sourceId');
  if (!SOURCE_KINDS.includes(sourceKind)) return refused('$.sourceKind');
  return { ok: true, value: { schemaVersion: 1, sourceId, sourceKind, generation: 0, cursor: 0, tail: null, tailStart: null,
    skipping: false, watermarkMs: null, lastObservedMs: null, eventIds: [], conflictedIds: [], recentEscalations: [], gaps: [], totals: zero() } };
}

// ---------------------------------------------------------------------------
// Top-level-only JSON object decoder. Duplicate keys are malformed (no last-wins aliasing).
// Nested values are syntax-checked and replaced by an opaque marker that every field check refuses.
const NESTED = Symbol('nested-value-dropped');
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_KEYS = 32, MAX_KEY_CHARS = 64, MAX_DEPTH = 16;
function decodeObject(text: string): Record<string, unknown> | null {
  let pos = 0;
  const n = text.length;
  const ws = (): void => {
    while (pos < n) { const c = text.charCodeAt(pos); if (c === 32 || c === 9 || c === 10 || c === 13) pos++; else break; }
  };
  const str = (): string | null => {
    const start = pos++;
    while (pos < n) {
      const c = text.charCodeAt(pos++);
      if (c === 34) { try { return JSON.parse(text.slice(start, pos)) as string; } catch { return null; } }
      if (c < 32) return null;
      if (c === 92) pos++;
    }
    return null;
  };
  const num = (): number | null => {
    NUMBER.lastIndex = pos;
    const match = NUMBER.exec(text);
    if (match === null) return null;
    pos += match[0].length;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  };
  const literal = (): true | false | null | undefined => {
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, pos)) { pos += word.length; return value; }
    }
    return undefined;
  };
  const skip = (depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    ws();
    const c = text[pos];
    if (c === '"') return str() !== null;
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      pos++; ws();
      if (text[pos] === close) { pos++; return true; }
      for (;;) {
        if (c === '{') {
          if (text[pos] !== '"' || str() === null) return false;
          ws(); if (text[pos++] !== ':') return false;
        }
        if (!skip(depth + 1)) return false;
        ws();
        if (text[pos] === close) { pos++; return true; }
        if (text[pos++] !== ',') return false;
        ws();
      }
    }
    if (literal() !== undefined) return true;
    return num() !== null;
  };
  ws();
  if (text[pos++] !== '{') return null;
  const out = Object.create(null) as Record<string, unknown>;
  let keys = 0;
  ws();
  if (text[pos] === '}') pos++;
  else {
    for (;;) {
      if (text[pos] !== '"') return null;
      const key = str();
      if (key === null || key.length > MAX_KEY_CHARS || Object.hasOwn(out, key) || ++keys > MAX_KEYS) return null;
      ws(); if (text[pos++] !== ':') return null; ws();
      const c = text[pos];
      let value: unknown;
      if (c === '"') { value = str(); if (value === null) return null; }
      else if (c === '{' || c === '[') { if (!skip(1)) return null; value = NESTED; }
      else {
        const word = literal();
        if (word !== undefined) value = word;
        else { value = num(); if (value === null) return null; }
      }
      out[key] = value;
      ws();
      if (text[pos] === '}') { pos++; break; }
      if (text[pos++] !== ',') return null;
      ws();
    }
  }
  ws();
  return pos === n ? out : null;
}

// ---------------------------------------------------------------------------
// Closed structural check of the caller-held state, run BEFORE any Map/Set is built from it.
// Structural only, NOT authenticity: a different structurally valid state (other digests, other
// consistent counters) is indistinguishable here; the future store must own state integrity.
const STATE_KEYS = ['schemaVersion', 'sourceId', 'sourceKind', 'generation', 'cursor', 'tail', 'tailStart', 'skipping',
  'watermarkMs', 'lastObservedMs', 'eventIds', 'conflictedIds', 'recentEscalations', 'gaps', 'totals'] as const;
const GAP_KEYS = ['sourceId', 'reason', 'previousGeneration', 'previousCursor', 'generation', 'cursor', 'observedAt'] as const;
const COUNTER_KEYS = Object.keys(zero()) as (keyof CollectorCountersV1)[];
/** Stored event ids are the lowercased UUIDv4 that validateEventV1 emits; digests are metadataId() hex. */
const STORED_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function isMatch(expression: RegExp, value: unknown): value is string { return typeof value === 'string' && expression.test(value); }
/** Dense array of ≤ max items that all pass `check`, with distinct `key(item)` values. */
function isBoundedList(value: unknown, max: number, check: (item: unknown) => boolean, key: (item: unknown) => unknown = item => item): boolean {
  if (!Array.isArray(value) || value.length > max) return false;
  const seen = new Set<unknown>();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || !check(value[index])) return false;
    seen.add(key(value[index]));
  }
  return seen.size === value.length;
}
function isEventIdEntry(item: unknown): boolean {
  return Array.isArray(item) && item.length === 2 && isMatch(STORED_EVENT_ID, item[0]) && isMatch(DIGEST, item[1]);
}
function isGap(value: unknown, sourceId: string): boolean {
  if (!isPlain(value) || !hasExactKeys(value, GAP_KEYS)) return false;
  const { previousGeneration, previousCursor, generation, cursor } = value;
  if (value.sourceId !== sourceId || !isCount(previousGeneration) || !isCount(previousCursor) || !isCount(generation)
    || !isCount(cursor) || parseIsoMs(value.observedAt) === null) return false;
  // Reason is exactly the one collectWindow derives from the recorded transition.
  return value.reason === (generation !== previousGeneration ? 'generation-change'
    : cursor < previousCursor ? 'cursor-reset' : cursor > previousCursor ? 'cursor-skip' : null);
}
function checkState(value: unknown, config: CollectorConfigV1): boolean {
  try {
    if (!isPlain(value) || !hasExactKeys(value, STATE_KEYS)) return false;
    const { sourceId, sourceKind, generation, cursor, tail, tailStart, skipping, watermarkMs, lastObservedMs, totals } = value;
    if (value.schemaVersion !== 1 || !isId(sourceId) || !SOURCE_KINDS.some(kind => kind === sourceKind)
      || !isCount(generation) || !isCount(cursor) || typeof skipping !== 'boolean'
      || (watermarkMs !== null && !isEpochMs(watermarkMs)) || (lastObservedMs !== null && !isEpochMs(lastObservedMs))) return false;
    if (tail === null ? tailStart !== null
      : !(tail instanceof Uint8Array) || tail.byteLength === 0 || tail.byteLength > config.maxLineBytes
        || !isCount(tailStart) || tailStart + tail.byteLength !== cursor || skipping) return false;
    if (!isPlain(totals) || !hasExactKeys(totals, COUNTER_KEYS) || !COUNTER_KEYS.every(key => isCount(totals[key]))) return false;
    // Each kind only ever fills its own identity lists.
    const spool = sourceKind === 'advisor-spool-v1';
    if (!isBoundedList(value.eventIds, spool ? config.dedupCapacity : 0, isEventIdEntry, item => (item as readonly unknown[])[0])
      || !isBoundedList(value.conflictedIds, spool ? config.dedupCapacity : 0, item => isMatch(STORED_EVENT_ID, item))
      || !isBoundedList(value.recentEscalations, spool ? 0 : config.recentEscalationCapacity, item => isMatch(DIGEST, item))
      || !isBoundedList(value.gaps, config.maxGapsRetained, item => isGap(item, sourceId))) return false;
    const t = totals as unknown as CollectorCountersV1;
    const ids = value.eventIds as CollectorStateV1['eventIds'], conflicted = value.conflictedIds as readonly string[];
    const recent = value.recentEscalations as readonly string[], gaps = value.gaps as readonly GapV1[];

    // Counter consistency: every retained identity came from an emitted record; retained gaps = total − dropped.
    // sum() saturates at MAX_SAFE_INTEGER: a saturated total is only a lower bound on the true total, so the
    // relation is checked exactly while unsaturated and as a lower bound once saturated (never reset).
    const MAX = Number.MAX_SAFE_INTEGER;
    if (t.recordsEmitted > t.linesSeen || conflicted.length > t.conflicts
      || (t.recordsEmitted < MAX && ids.length + t.dedupEvictions + conflicted.length + recent.length > t.recordsEmitted)
      || (t.gaps < MAX ? t.gaps !== t.gapsDropped + gaps.length : t.gapsDropped + gaps.length < MAX)
      || (watermarkMs === null ? ids.length + recent.length > 0 : t.recordsEmitted === 0)) return false;
    if (lastObservedMs === null) {
      // No window has run yet: only the freshly created state is consistent.
      return generation === 0 && cursor === 0 && tail === null && !skipping && watermarkMs === null
        && ids.length + conflicted.length + recent.length + gaps.length === 0 && COUNTER_KEYS.every(key => t[key] === 0);
    }
    // Gaps form one ordered chain ending at the current generation; cursor is consistent with consumed bytes.
    let previous: GapV1 | null = null;
    for (const gap of gaps) {
      const atMs = parseIsoMs(gap.observedAt)!;
      if (atMs > lastObservedMs) return false;
      if (previous === null ? t.gapsDropped === 0 && gap.previousGeneration !== 0
        : gap.previousGeneration !== previous.generation || gap.previousCursor < previous.cursor
          || atMs < parseIsoMs(previous.observedAt)!) return false;
      previous = gap;
    }
    return previous === null ? generation === 0 && cursor === t.bytesConsumed
      : previous.generation === generation && cursor >= previous.cursor && cursor - previous.cursor <= t.bytesConsumed;
  } catch {
    return false;
  }
}

/** Decode one collection window of contiguous chunks starting at `input.cursor`.
 * Caps stop the cursor (coverage `backlog`); the caller re-supplies from `nextCursor`.
 * A state is valid only under a config whose caps it fits: the SAME config always re-accepts its own output, but
 * a smaller dedupCapacity/recentEscalationCapacity/maxGapsRetained/maxLineBytes can refuse it (`$state`). That
 * refusal is intended: nothing here resets state or discards dedup/tail/history; lowering caps requires the caller
 * to explicitly choose a new generation/checkpoint migration (not provided by this module).
 * A window whose nextCursor could exceed MAX_SAFE_INTEGER is refused (`input-limit`, `$input.cursor`) unconsumed. */
export function collectWindow(state: CollectorStateV1, input: CollectWindowInputV1, configInput?: unknown): EfficiencyResult<CollectWindowResultV1> {
  const checkedConfig = validateCollectorConfigV1(configInput);
  if (!checkedConfig.ok) return checkedConfig;
  const config = checkedConfig.value;
  if (!checkState(state, config)) return refused('$state');
  if (input === null || typeof input !== 'object' || !isCount(input.generation) || !isCount(input.cursor)
    || typeof input.endOfData !== 'boolean' || !Array.isArray(input.chunks)) return refused('$input');
  if (input.chunks.length > config.maxChunksPerWindow) return { ok: false, reason: { code: 'input-limit', path: '$input.chunks' } };
  if (!input.chunks.every(chunk => chunk instanceof Uint8Array)) return refused('$input.chunks');
  // The window starts at input.cursor (equal to state.cursor unless it records a gap) and consumes at most this
  // many bytes; refuse before consuming anything if nextCursor could leave the safe-integer range (never wrap/clamp).
  const reachable = Math.min(config.maxWindowBytes, input.chunks.reduce((n, chunk) => n + Math.min(chunk.byteLength, config.maxChunkBytes), 0));
  if (input.cursor > Number.MAX_SAFE_INTEGER - reachable) return { ok: false, reason: { code: 'input-limit', path: '$input.cursor' } };
  const observedMs = parseIsoMs(input.observedAt);
  if (observedMs === null) return refused('$input.observedAt');

  const counters = zero();
  const records: CollectedRecordV1[] = [];
  const newGaps: GapV1[] = [];
  const reasons = new Set<CoverageReason>();
  const { sourceId, sourceKind } = state;
  const observedAt = input.observedAt;

  if (state.lastObservedMs !== null && observedMs < state.lastObservedMs) {
    // Supplied clock rolled back: collect nothing, advance nothing.
    counters.clockRollback = 1;
    const next = { ...state, totals: sum(state.totals, counters) };
    return { ok: true, value: { state: next, records, gaps: newGaps, counters, coverage: 'backlog', reasons: ['clock-rollback'],
      consumedBytes: 0, nextCursor: state.cursor, pendingTailBytes: state.tail?.byteLength ?? 0, idempotency: 'bounded-horizon' } };
  }

  let generation = state.generation, cursor = state.cursor;
  let tail: Uint8Array | null = state.tail, tailStart: number | null = state.tailStart, skipping = state.skipping;
  if (input.generation !== state.generation || input.cursor !== state.cursor) {
    const reason = input.generation !== state.generation ? 'generation-change' : input.cursor < state.cursor ? 'cursor-reset' : 'cursor-skip';
    newGaps.push({ sourceId, reason, previousGeneration: state.generation, previousCursor: state.cursor,
      generation: input.generation, cursor: input.cursor, observedAt });
    counters.gaps++;
    counters.tailDiscardedBytes += tail?.byteLength ?? 0;
    generation = input.generation; cursor = input.cursor; tail = null; tailStart = null; skipping = false;
  }

  const ids = new Map<string, string>(state.eventIds.map(([key, body]) => [key, body] as [string, string]));
  const conflicted = new Set(state.conflictedIds);
  const recent = new Set(state.recentEscalations);
  let watermark = state.watermarkMs;
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

  const accept = (timeMs: number): boolean => {
    if (timeMs > observedMs + config.futureSkewMs) { counters.clockSkew++; return false; }
    return true;
  };
  const isLate = (timeMs: number): boolean => watermark !== null && timeMs < watermark - config.lateToleranceMs;
  const base = (lineStart: number) => ({ sourceId, generation, lineStart, observedAt, provenance: 'not-established' as const });

  const processLine = (bytes: Uint8Array, lineStart: number): void => {
    let end = bytes.byteLength;
    if (end > 0 && bytes[end - 1] === 13) end--;
    let text: string;
    try { text = decoder.decode(bytes.subarray(0, end)); } catch { counters.malformed++; return; }
    if (text.trim().length === 0) { counters.emptyLines++; return; }
    const object = decodeObject(text);
    if (object === null) { counters.malformed++; return; }
    if (sourceKind === 'advisor-spool-v1') {
      const checked = validateEventV1(object);
      if (!checked.ok) {
        if (checked.reason.code === 'unknown-field') counters.unknownField++;
        else if (checked.reason.code === 'unknown-version') counters.unknownVersion++;
        else counters.invalidValue++;
        return;
      }
      const event = checked.value, atMs = parseIsoMs(event.at)!;
      if (!accept(atMs)) return;
      const body = metadataId(event), prior = ids.get(event.eventId);
      if (prior !== undefined) {
        if (prior === body) { counters.duplicates++; return; }
        counters.conflicts++;
        if (!conflicted.has(event.eventId)) {
          conflicted.add(event.eventId);
          if (conflicted.size > config.dedupCapacity) conflicted.delete(conflicted.values().next().value as string);
          records.push({ type: 'event-id-conflict', recordId: metadataId(['event-id-conflict', sourceId, generation, lineStart, event.eventId]),
            ...base(lineStart), sourceKind, eventId: event.eventId });
          counters.recordsEmitted++;
        }
        return;
      }
      ids.set(event.eventId, body);
      if (ids.size > config.dedupCapacity) { ids.delete(ids.keys().next().value as string); counters.dedupEvictions++; }
      const late = isLate(atMs);
      if (late) counters.late++;
      watermark = watermark === null ? atMs : Math.max(watermark, atMs);
      records.push({ type: 'event', recordId: event.eventId, ...base(lineStart), sourceKind, timeBasis: 'producer-clock', late, event });
      counters.recordsEmitted++;
      return;
    }
    const checked = validateEscalationV1(object);
    if (!checked.ok) {
      if (checked.reason.code === 'unknown-field') counters.unknownField++; else counters.invalidValue++;
      return;
    }
    const { sid, ts, rc } = checked.value, tsMs = parseUtc(ts)!;
    if (!accept(tsMs)) return;
    const identity = metadataId(['escalation', sid, tsMs, rc]);
    const possibleDuplicate = recent.has(identity);
    if (possibleDuplicate) counters.possibleDuplicates++;
    else {
      recent.add(identity);
      if (recent.size > config.recentEscalationCapacity) recent.delete(recent.values().next().value as string);
    }
    const late = isLate(tsMs);
    if (late) counters.late++;
    watermark = watermark === null ? tsMs : Math.max(watermark, tsMs);
    records.push({ type: 'escalation', recordId: metadataId(['verify-escalations-v1', sourceId, generation, lineStart]),
      ...base(lineStart), sourceKind: 'verify-escalations-v1', timeBasis: 'producer-clock', late, possibleDuplicate, sid, ts, rc });
    counters.recordsEmitted++;
  };

  let windowBytes = 0, stopped = false;
  for (const chunk of input.chunks) {
    if (stopped) break;
    if (chunk.byteLength === 0) { counters.emptyChunks++; continue; }
    const limit = Math.min(chunk.byteLength, config.maxChunkBytes, config.maxWindowBytes - windowBytes);
    if (limit < chunk.byteLength) { stopped = true; counters.capStops++; }
    // Newline search never looks past the capped limit.
    const newline = (from: number): number => { const at = chunk.subarray(from, limit).indexOf(10); return at < 0 ? -1 : from + at; };
    let pos = 0;
    while (pos < limit) {
      if (skipping) {
        const nl = newline(pos);
        if (nl < 0) { pos = limit; break; }
        pos = nl + 1; skipping = false; counters.linesSeen++;
        continue;
      }
      if (counters.linesSeen >= config.maxWindowRecords) {
        if (!stopped) counters.capStops++;
        stopped = true; break;
      }
      const nl = newline(pos);
      const segmentEnd = nl < 0 ? limit : nl;
      const heldBytes = tail?.byteLength ?? 0;
      const lineStart = tailStart ?? cursor + pos;
      if (heldBytes + (segmentEnd - pos) > config.maxLineBytes) {
        counters.oversizeLines++;
        tail = null; tailStart = null;
        if (segmentEnd === nl) { counters.linesSeen++; pos = nl + 1; }
        else { skipping = true; pos = limit; }
        continue;
      }
      const segment = chunk.subarray(pos, segmentEnd);
      let line: Uint8Array;
      if (tail === null) line = segment;
      else { line = new Uint8Array(heldBytes + segment.byteLength); line.set(tail, 0); line.set(segment, heldBytes); }
      if (segmentEnd !== nl) {
        // Partial tail: retain a private copy (bounded by maxLineBytes) and wait for its newline.
        tail = line === segment ? segment.slice() : line; tailStart = lineStart; pos = limit;
        break;
      }
      tail = null; tailStart = null; counters.linesSeen++; pos = nl + 1;
      processLine(line, lineStart);
    }
    cursor += pos; windowBytes += pos;
    if (pos < chunk.byteLength) stopped = true;
  }
  counters.bytesConsumed = windowBytes;

  const eventIds = [...ids.entries()].map(([key, body]) => [key, body] as const);
  let gaps = [...state.gaps, ...newGaps];
  if (gaps.length > config.maxGapsRetained) { counters.gapsDropped += gaps.length - config.maxGapsRetained; gaps = gaps.slice(gaps.length - config.maxGapsRetained); }
  const next: CollectorStateV1 = { schemaVersion: 1, sourceId, sourceKind, generation, cursor, tail, tailStart, skipping,
    watermarkMs: watermark, lastObservedMs: observedMs, eventIds, conflictedIds: [...conflicted],
    recentEscalations: [...recent], gaps, totals: sum(state.totals, counters) };

  if (newGaps.length > 0) reasons.add('gap');
  if (stopped) reasons.add('cap-stop');
  if (!input.endOfData) reasons.add('not-end-of-data');
  if (tail !== null || skipping) reasons.add('pending-tail');
  if (counters.malformed + counters.unknownField + counters.unknownVersion + counters.invalidValue
    + counters.oversizeLines + counters.clockSkew + counters.tailDiscardedBytes > 0) reasons.add('dropped-lines');
  if (counters.conflicts > 0) reasons.add('event-id-conflict');
  // Once any eviction ended the dedup horizon, replays/conflicts of evicted ids are undetectable for the
  // life of this state (cumulative bounded counter, no unbounded map), so no later window recovers `complete`.
  if (next.totals.dedupEvictions > 0) reasons.add('dedup-horizon');
  const coverage = reasons.has('gap') ? 'gap' : reasons.has('cap-stop') || reasons.has('not-end-of-data') ? 'backlog'
    : reasons.has('pending-tail') || reasons.has('dropped-lines') || reasons.has('event-id-conflict')
      || reasons.has('dedup-horizon') ? 'partial' : 'complete';
  return { ok: true, value: { state: next, records, gaps: newGaps, counters, coverage, reasons: [...reasons].sort(),
    consumedBytes: windowBytes, nextCursor: cursor, pendingTailBytes: tail?.byteLength ?? 0, idempotency: 'bounded-horizon' } };
}
