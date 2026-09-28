import {
  type AdvisorEventV1, type CollectedRecordV1, type CollectorConfigV1, type Coverage, type EfficiencyResult, type EscalationFieldsV1, type SourceKind,
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
// ONE bounded line framer + line decoder, shared by collectWindow (stateful) and decodeWindowV1 (stateless).
// The framer's partial-line tail is a transient private copy; only collectWindow's state ever carries it out.
type DecodedLineV1 = { type: 'event'; timeMs: number; event: AdvisorEventV1 }
  | { type: 'escalation'; timeMs: number; fields: EscalationFieldsV1 };
/** One complete line → whitelisted typed fields, or null after counting why it was dropped. */
function decodeLine(bytes: Uint8Array, sourceKind: SourceKind, decoder: { decode(input: Uint8Array): string }, counters: CollectorCountersV1,
  observedMs: number, futureSkewMs: number): DecodedLineV1 | null {
  let end = bytes.byteLength;
  if (end > 0 && bytes[end - 1] === 13) end--;
  let text: string;
  try { text = decoder.decode(bytes.subarray(0, end)); } catch { counters.malformed++; return null; }
  if (text.trim().length === 0) { counters.emptyLines++; return null; }
  const object = decodeObject(text);
  if (object === null) { counters.malformed++; return null; }
  let line: DecodedLineV1;
  if (sourceKind === 'advisor-spool-v1') {
    const checked = validateEventV1(object);
    if (!checked.ok) {
      if (checked.reason.code === 'unknown-field') counters.unknownField++;
      else if (checked.reason.code === 'unknown-version') counters.unknownVersion++;
      else counters.invalidValue++;
      return null;
    }
    line = { type: 'event', timeMs: parseIsoMs(checked.value.at)!, event: checked.value };
  } else {
    const checked = validateEscalationV1(object);
    if (!checked.ok) {
      if (checked.reason.code === 'unknown-field') counters.unknownField++; else counters.invalidValue++;
      return null;
    }
    line = { type: 'escalation', timeMs: parseUtc(checked.value.ts)!, fields: checked.value };
  }
  if (line.timeMs > observedMs + futureSkewMs) { counters.clockSkew++; return null; }
  return line;
}
function stampTime(watermark: number | null, timeMs: number, lateToleranceMs: number, counters: CollectorCountersV1): { late: boolean; watermark: number } {
  const late = watermark !== null && timeMs < watermark - lateToleranceMs;
  if (late) counters.late++;
  return { late, watermark: watermark === null ? timeMs : Math.max(watermark, timeMs) };
}
function recordOf(line: DecodedLineV1, sourceId: string, generation: number, lineStart: number, observedAt: string,
  late: boolean, possibleDuplicate: boolean): CollectedRecordV1 {
  const base = { sourceId, generation, lineStart, observedAt, provenance: 'not-established' as const };
  if (line.type === 'event') {
    return { type: 'event', recordId: line.event.eventId, ...base, sourceKind: 'advisor-spool-v1', timeBasis: 'producer-clock', late, event: line.event };
  }
  const { sid, ts, rc } = line.fields;
  return { type: 'escalation', recordId: metadataId(['verify-escalations-v1', sourceId, generation, lineStart]),
    ...base, sourceKind: 'verify-escalations-v1', timeBasis: 'producer-clock', late, possibleDuplicate, sid, ts, rc };
}
interface FrameV1 { cursor: number; tail: Uint8Array | null; tailStart: number | null; skipping: boolean }
/** Split contiguous chunks into complete lines under the byte/record caps; `onLine` gets each complete line. */
function frame(chunks: readonly Uint8Array[], config: CollectorConfigV1, counters: CollectorCountersV1, start: FrameV1,
  onLine: (line: Uint8Array, lineStart: number) => void): FrameV1 & { windowBytes: number; stopped: boolean } {
  let { cursor, tail, tailStart, skipping } = start;
  let windowBytes = 0, stopped = false;
  for (const chunk of chunks) {
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
      onLine(line, lineStart);
    }
    cursor += pos; windowBytes += pos;
    if (pos < chunk.byteLength) stopped = true;
  }
  return { cursor, tail, tailStart, skipping, windowBytes, stopped };
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

  const base = (lineStart: number) => ({ sourceId, generation, lineStart, observedAt, provenance: 'not-established' as const });

  const processLine = (bytes: Uint8Array, lineStart: number): void => {
    const line = decodeLine(bytes, sourceKind, decoder, counters, observedMs, config.futureSkewMs);
    if (line === null) return;
    let possibleDuplicate = false;
    if (line.type === 'event') {
      const event = line.event;
      const body = metadataId(event), prior = ids.get(event.eventId);
      if (prior !== undefined) {
        if (prior === body) { counters.duplicates++; return; }
        counters.conflicts++;
        if (!conflicted.has(event.eventId)) {
          conflicted.add(event.eventId);
          if (conflicted.size > config.dedupCapacity) conflicted.delete(conflicted.values().next().value as string);
          records.push({ type: 'event-id-conflict', recordId: metadataId(['event-id-conflict', sourceId, generation, lineStart, event.eventId]),
            ...base(lineStart), sourceKind: 'advisor-spool-v1', eventId: event.eventId });
          counters.recordsEmitted++;
        }
        return;
      }
      ids.set(event.eventId, body);
      if (ids.size > config.dedupCapacity) { ids.delete(ids.keys().next().value as string); counters.dedupEvictions++; }
    } else {
      const { sid, rc } = line.fields;
      const identity = metadataId(['escalation', sid, line.timeMs, rc]);
      possibleDuplicate = recent.has(identity);
      if (possibleDuplicate) counters.possibleDuplicates++;
      else {
        recent.add(identity);
        if (recent.size > config.recentEscalationCapacity) recent.delete(recent.values().next().value as string);
      }
    }
    const stamped = stampTime(watermark, line.timeMs, config.lateToleranceMs, counters);
    watermark = stamped.watermark;
    records.push(recordOf(line, sourceId, generation, lineStart, observedAt, stamped.late, possibleDuplicate));
    counters.recordsEmitted++;
  };

  const framed = frame(input.chunks, config, counters, { cursor, tail, tailStart, skipping }, processLine);
  ({ cursor, tail, tailStart, skipping } = framed);
  const { windowBytes, stopped } = framed;
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

// ---------------------------------------------------------------------------
// C0-f (CONTRACT-r2 §3): PURE stateless checkpoint decoder. Same framer, JSON decoder, whitelist, byte/depth/key
// bounds and time checks as collectWindow; no dedup/conflict/possible-duplicate state and no raw bytes in or out.
//
// Checkpoint = (startCursor, skippingOversize, watermarkMs). It is STRUCTURALLY validated only, NOT authenticated:
// nothing here can prove that the values came from a prior result or that startCursor is a true line boundary.
// The future store must own checkpoint integrity; this function never claims it.
//
// - Normal mode (skippingOversize=false): startCursor must be a line start. A trailing partial line is NOT committed:
//   lineBoundaryCursor stays at its first byte and pendingTailBytes counts exactly the bytes the next window re-reads
//   (0 when none). The partial bytes are dropped here; no tail is ever returned.
// - Skip mode (skippingOversize=true): startCursor is a position INSIDE an oversize line, not a line boundary.
//   Bytes up to the next newline are discarded without decoding. If that newline is not in this window,
//   lineBoundaryCursor advances to the end of the bytes read and skippingOversize stays true. Skipped bytes are
//   never re-read, so pendingTailBytes is 0. Once the newline is consumed, lineBoundaryCursor is a line start again.
//   The oversize line is counted once, in the window that detects it.
// - Progress: the config must satisfy maxLineBytes < maxChunkBytes and maxLineBytes < maxWindowBytes. A window
//   stopped by any cap has then seen more than maxLineBytes bytes of its first line. So the line either completed
//   (committed) or was detected oversize (skip mode, cursor advanced). A capped window never restarts at
//   startCursor. The only zero-progress result is a short partial line at the end of the supplied data, which
//   waits for its writer. Lines after a cap are never skipped; they are re-read from lineBoundaryCursor.
//   This precondition is specific to decodeWindowV1. A config that passes the generic validateCollectorConfigV1,
//   for example maxLineBytes == maxWindowBytes or maxLineBytes >= maxChunkBytes, does NOT necessarily satisfy it.
//   Such a config is refused here with the typed invalid-value result at $.maxLineBytes, never thrown and never
//   relaxed. Without a carried tail, those configs could restart at startCursor forever. The shared CollectorConfigV1
//   schema and legacy collectWindow keep their `<=` rule and accept them, because legacy carries a transient tail.
// - Replays: re-supplying an earlier checkpoint re-emits the same records (same recordId). They are explicit
//   duplicate-eligible records for the store's dedup; there is no exactly-once or complete-producer claim.
//   possibleDuplicate is always false here, meaning NOT assessed.
// - No clock-rollback check: there is no previous observedAt input.
export interface DecodeWindowInputV1 {
  sourceId: string; sourceKind: SourceKind; generation: number;
  /** A lineBoundaryCursor returned by this API (structurally checked only; see above). */
  startCursor: number; skippingOversize: boolean; watermarkMs: number | null;
  /** Contiguous bytes starting at startCursor. */
  chunks: readonly Uint8Array[];
  endOfData: boolean; observedAt: string;
  /** CollectorConfigV1 or undefined for the defaults. */
  config?: unknown;
}
export type DecodeCountersV1 = Pick<CollectorCountersV1, 'bytesConsumed' | 'linesSeen' | 'recordsEmitted' | 'emptyLines'
  | 'emptyChunks' | 'malformed' | 'unknownField' | 'unknownVersion' | 'invalidValue' | 'oversizeLines' | 'late' | 'clockSkew' | 'capStops'>;
export type DecodeReasonV1 = Extract<CoverageReason, 'cap-stop' | 'not-end-of-data' | 'pending-tail' | 'dropped-lines'>;
export interface DecodeWindowResultV1 {
  records: CollectedRecordV1[];
  /** Next startCursor. A line start unless skippingOversize is true. */
  lineBoundaryCursor: number;
  /** Count of uncommitted partial-line bytes the next window re-reads (never the bytes themselves). */
  pendingTailBytes: number;
  skippingOversize: boolean; watermarkMs: number | null;
  /** This window only; bytesConsumed = lineBoundaryCursor − startCursor (committed bytes). */
  counters: DecodeCountersV1;
  coverage: Exclude<Coverage, 'unknown' | 'gap'>; reasons: DecodeReasonV1[];
}
const DECODE_INPUT_KEYS = ['sourceId', 'sourceKind', 'generation', 'startCursor', 'skippingOversize', 'watermarkMs',
  'chunks', 'endOfData', 'observedAt'] as const;
const DECODE_COUNTER_KEYS = ['bytesConsumed', 'linesSeen', 'recordsEmitted', 'emptyLines', 'emptyChunks', 'malformed',
  'unknownField', 'unknownVersion', 'invalidValue', 'oversizeLines', 'late', 'clockSkew', 'capStops'] as const;

export function decodeWindowV1(input: DecodeWindowInputV1): EfficiencyResult<DecodeWindowResultV1> {
  try {
    const raw: unknown = input;
    if (!isPlain(raw) || !DECODE_INPUT_KEYS.every(key => Object.hasOwn(raw, key))
      || !Object.keys(raw).every(key => key === 'config' || DECODE_INPUT_KEYS.some(known => known === key))) return refused('$input');
    const checkedConfig = validateCollectorConfigV1(raw.config);
    if (!checkedConfig.ok) return checkedConfig;
    const config = checkedConfig.value;
    // No tail is carried between windows, so every cap must leave room for one maximum line plus its newline.
    // This is stricter than validateCollectorConfigV1 (see "Progress" above); the shared schema is unchanged.
    if (config.maxLineBytes >= config.maxWindowBytes || config.maxLineBytes >= config.maxChunkBytes) return refused('$.maxLineBytes');
    const { sourceId, sourceKind, generation, startCursor, skippingOversize, watermarkMs, endOfData, observedAt } = raw;
    if (!isId(sourceId)) return refused('$input.sourceId');
    if (!SOURCE_KINDS.some(kind => kind === sourceKind)) return refused('$input.sourceKind');
    if (!isCount(generation)) return refused('$input.generation');
    if (!isCount(startCursor)) return refused('$input.startCursor');
    if (typeof skippingOversize !== 'boolean') return refused('$input.skippingOversize');
    if (watermarkMs !== null && !isEpochMs(watermarkMs)) return refused('$input.watermarkMs');
    if (typeof endOfData !== 'boolean') return refused('$input.endOfData');
    const observedMs = parseIsoMs(observedAt);
    if (observedMs === null) return refused('$input.observedAt');
    // Read `chunks` and its length exactly once: a getter or proxy cannot change what is limit-checked vs. consumed.
    const supplied: unknown = raw.chunks;
    if (!Array.isArray(supplied)) return refused('$input.chunks');
    const count: unknown = supplied.length;
    if (!isCount(count)) return refused('$input.chunks');
    if (count > config.maxChunksPerWindow) return { ok: false, reason: { code: 'input-limit', path: '$input.chunks' } };
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const chunk: unknown = supplied[index];
      if (!(chunk instanceof Uint8Array)) return refused('$input.chunks');
      chunks.push(chunk);
    }
    // Same overflow rule as collectWindow: refuse unconsumed if the cursor could leave the safe-integer range.
    const reachable = Math.min(config.maxWindowBytes, chunks.reduce((n, chunk) => n + Math.min(chunk.byteLength, config.maxChunkBytes), 0));
    if (startCursor > Number.MAX_SAFE_INTEGER - reachable) return { ok: false, reason: { code: 'input-limit', path: '$input.startCursor' } };

    const kind = sourceKind as SourceKind, at = observedAt as string;
    const counters = zero();
    const records: CollectedRecordV1[] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let watermark = watermarkMs;
    const framed = frame(chunks, config, counters, { cursor: startCursor, tail: null, tailStart: null, skipping: skippingOversize },
      (bytes, lineStart) => {
        const line = decodeLine(bytes, kind, decoder, counters, observedMs, config.futureSkewMs);
        if (line === null) return;
        const stamped = stampTime(watermark, line.timeMs, config.lateToleranceMs, counters);
        watermark = stamped.watermark;
        records.push(recordOf(line, sourceId, generation, lineStart, at, stamped.late, false));
        counters.recordsEmitted++;
      });
    // The framer's private tail copy is dropped here: only its start and length leave this function.
    const lineBoundaryCursor = framed.tailStart ?? framed.cursor;
    const pendingTailBytes = framed.tail?.byteLength ?? 0;
    counters.bytesConsumed = lineBoundaryCursor - startCursor;

    const reasons = new Set<DecodeReasonV1>();
    if (framed.stopped) reasons.add('cap-stop');
    if (!endOfData) reasons.add('not-end-of-data');
    if (pendingTailBytes > 0 || framed.skipping) reasons.add('pending-tail');
    if (counters.malformed + counters.unknownField + counters.unknownVersion + counters.invalidValue
      + counters.oversizeLines + counters.clockSkew > 0) reasons.add('dropped-lines');
    const coverage = reasons.has('cap-stop') || reasons.has('not-end-of-data') ? 'backlog'
      : reasons.has('pending-tail') || reasons.has('dropped-lines') ? 'partial' : 'complete';
    const windowCounters = {} as DecodeCountersV1;
    for (const key of DECODE_COUNTER_KEYS) windowCounters[key] = counters[key];
    return { ok: true, value: { records, lineBoundaryCursor, pendingTailBytes, skippingOversize: framed.skipping,
      watermarkMs: watermark, counters: windowCounters, coverage, reasons: [...reasons].sort() } };
  } catch {
    return refused('$input');
  }
}
