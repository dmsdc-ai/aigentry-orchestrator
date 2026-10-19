import { createHash } from 'node:crypto';

export type Result<T> = { ok: true; value: T } | { ok: false; code: string };
export interface Metric { value: number | null; reason: string | null; source: string | null }
export interface PackageIdentity {
  name: string; version: string; packageSha256: string; integrity: string;
  sourceCommit: string; sourceTree: string; installedDigest: string;
  cliDigest: string; dependenciesDigest: string; acceptedReceipt: string;
}
export interface Scenario { id: string; requirement: string; oracleDigest: string }
export interface Run {
  version: 1; release: string; component: string; baseline: PackageIdentity | null;
  baselineUnavailableReason: string | null; candidate: PackageIdentity;
  environment: { os: string; osVersion: string; architecture: string; image: string;
    executor: string; native: true; nodeVersion: string; cliVersion: string;
    model: string | null; effort: string | null; resourcesDigest: string; clockBasis: string };
  configDigest: string; workloadDigest: string; cohort: string; policy: string;
  selection: { digest: string; scenarios: Scenario[]; repetitions: number; warmups: number };
}
export interface Observation {
  version: 1; runKey: string; variant: 'baseline' | 'candidate'; scenario: string;
  repetition: number; warmup: boolean; producer: string; attempt: string; kind: 'result';
  state: 'complete' | 'partial'; outcome: 'success' | 'failure' | 'unknown';
  failure: string | null; cleanup: 'verified' | 'uncertain'; clock: 'normal' | 'anomaly';
  exitCode: number | null; signal: string | null;
  receipt: { sha256: string; bytes: number; receivedAt: number } | null;
  metrics: { durationMs: Metric; completedUnits: Metric; intervalMs: Metric; cpuUserMs: Metric;
    cpuSystemMs: Metric; peakRssBytes: Metric; ioBytes: Metric; toolCalls: Metric;
    tokens: Metric; charge: Metric }; currency: string | null;
}
export interface Evidence { version: 1; run: Run; observations: Observation[] }
export interface Defect {
  version: 1; component: string; requirement: string; scenario: string;
  normalizedFailure: string; cohort: string; policy: string;
}
const policyValues = { version: 1, minSuccesses: 5, relativeIncrease: 0.2, absoluteIncreaseMs: 50, minP95: 100 };
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function digest(v: unknown): string { return createHash('sha256').update(canonical(v)).digest('hex'); }
export const POLICY = Object.freeze({ ...policyValues, digest: digest(policyValues) });
function fail(code: string): never { throw new Error(code); }
function result<T>(f: () => T): Result<T> {
  try { return { ok: true, value: f() }; }
  catch (e) { return { ok: false, code: e instanceof Error ? e.message : 'invalid-input' }; }
}
// Only JSON text crosses the boundary. Duplicate members are rejected before allocation.
function parse(input: string): unknown {
  if (typeof input !== 'string' || input.length > 8 * 1024 * 1024) fail('input-limit');
  let at = 0, nodes = 0;
  const ws = () => { while (at < input.length && /[\t\n\r ]/.test(input[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      if (input[at] === '\\') { at += 2; continue; }
      if (input[at++] === '"') {
        let s: string; try { s = JSON.parse(input.slice(start, at)) as string; } catch { return fail('invalid-json'); }
        if (s.length > 512) fail('string-limit'); return s;
      }
    }
    return fail('invalid-json');
  };
  const read = (depth: number): unknown => {
    if (++nodes > 500000 || depth > 12) fail('structure-limit'); ws();
    const ch = input[at];
    if (ch === '"') return string();
    if (ch === '{' || ch === '[') {
      at++; ws(); const object = ch === '{', end = object ? '}' : ']';
      const keys = new Set<string>(), entries: [string, unknown][] = [], array: unknown[] = [];
      if (input[at] === end) { at++; return object ? {} : []; }
      while (true) {
        ws(); let key = '';
        if (object) {
          if (input[at] !== '"') fail('invalid-json'); key = string(); ws();
          if (input[at++] !== ':') fail('invalid-json');
          if (keys.has(key)) fail('duplicate-field'); keys.add(key);
          if (keys.size > 40) fail('field-limit');
        } else if (array.length >= 4096) fail('array-limit');
        const value = read(depth + 1); if (object) entries.push([key, value]); else array.push(value);
        ws(); const separator = input[at++]; if (separator === end) break;
        if (separator !== ',') fail('invalid-json');
      }
      return object ? Object.fromEntries(entries) : array;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(input.slice(at));
    if (!match) return fail('invalid-json'); at += match[0].length;
    const v: unknown = JSON.parse(match[0]);
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0 || Object.is(v, -0))) fail('invalid-number');
    return v;
  };
  const value = read(0); ws(); if (at !== input.length) fail('invalid-json'); return value;
}
function shape(v: unknown, fields: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid-record');
  const keys = Object.keys(v), expected = fields.split(' ');
  if (keys.length !== expected.length || keys.some(k => !expected.includes(k))) fail('unknown-or-missing-field');
}
function text(v: unknown): asserts v is string { if (typeof v !== 'string' || !v.trim() || v.length > 512) fail('invalid-string'); }
function hash(v: unknown, length = 64): void {
  if (typeof v !== 'string' || v.length !== length || !/^[a-f0-9]+$/.test(v)) fail('invalid-hash');
}
function integer(v: unknown, max: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > max) fail('invalid-integer');
}
function one(v: unknown, values: readonly unknown[]): void { if (!values.includes(v)) fail('invalid-enum'); }
function metric(v: unknown): void {
  shape(v, 'value reason source');
  if (v.value === null) { text(v.reason); if (v.source !== null) fail('unavailable-source'); }
  else {
    if (typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < 0) fail('invalid-metric');
    if (v.reason !== null) fail('available-reason'); text(v.source);
    if (/parent[-_ ]?process|process\.resourceUsage/i.test(v.source)) fail('parent-process-metric');
  }
}
function pkg(v: unknown): void {
  shape(v, 'name version packageSha256 integrity sourceCommit sourceTree installedDigest cliDigest dependenciesDigest acceptedReceipt');
  text(v.name); text(v.version); text(v.integrity);
  const integrity = /^(sha256|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(v.integrity);
  if (!integrity) fail('invalid-integrity');
  const bytes = Buffer.from(integrity[2], 'base64');
  if (bytes.length !== (integrity[1] === 'sha256' ? 32 : 64) || bytes.toString('base64') !== integrity[2]) fail('invalid-integrity');
  for (const k of ['packageSha256', 'installedDigest', 'cliDigest', 'dependenciesDigest', 'acceptedReceipt']) hash(v[k]);
  hash(v.sourceCommit, 40); hash(v.sourceTree, 40);
}
function run(v: unknown): asserts v is Run {
  shape(v, 'version release component baseline baselineUnavailableReason candidate environment configDigest workloadDigest cohort policy selection');
  one(v.version, [1]); text(v.release); text(v.component); text(v.cohort); pkg(v.candidate);
  if (v.baseline === null) text(v.baselineUnavailableReason);
  else { pkg(v.baseline); if (v.baselineUnavailableReason !== null) fail('baseline-reason'); }
  hash(v.configDigest); hash(v.workloadDigest); hash(v.policy);
  if (v.policy !== POLICY.digest) fail('policy-mismatch');
  const e = v.environment;
  shape(e, 'os osVersion architecture image executor native nodeVersion cliVersion model effort resourcesDigest clockBasis');
  for (const k of ['os', 'osVersion', 'architecture', 'image', 'executor', 'nodeVersion', 'cliVersion', 'clockBasis']) text(e[k]);
  one(e.native, [true]); hash(e.resourcesDigest);
  for (const k of ['model', 'effort']) if (e[k] !== null) text(e[k]);
  const s = v.selection; shape(s, 'digest scenarios repetitions warmups'); hash(s.digest);
  integer(s.repetitions, 1000); integer(s.warmups, 10);
  if (!s.repetitions || !Array.isArray(s.scenarios) || !s.scenarios.length || s.scenarios.length > 32) fail('selection-limit');
  const ids = new Set<string>();
  for (const scenario of s.scenarios) {
    shape(scenario, 'id requirement oracleDigest'); text(scenario.id); text(scenario.requirement); hash(scenario.oracleDigest);
    if (ids.has(scenario.id)) fail('duplicate-scenario'); ids.add(scenario.id);
  }
  if (2 * s.scenarios.length * (s.repetitions + s.warmups) > 4096) fail('selection-limit');
  if (s.digest !== digest({ scenarios: s.scenarios, repetitions: s.repetitions, warmups: s.warmups })) fail('selection-mismatch');
}
function observation(v: unknown): asserts v is Observation {
  shape(v, 'version runKey variant scenario repetition warmup producer attempt kind state outcome failure cleanup clock exitCode signal receipt metrics currency');
  one(v.version, [1]); hash(v.runKey); one(v.variant, ['baseline', 'candidate']); text(v.scenario);
  integer(v.repetition, 999); one(v.warmup, [true, false]); text(v.producer); text(v.attempt); one(v.kind, ['result']);
  one(v.state, ['complete', 'partial']); one(v.outcome, ['success', 'failure', 'unknown']);
  if (v.outcome === 'failure') text(v.failure); else if (v.failure !== null) fail('failure-signature');
  one(v.cleanup, ['verified', 'uncertain']); one(v.clock, ['normal', 'anomaly']);
  if (v.exitCode !== null) integer(v.exitCode, 255); if (v.signal !== null) text(v.signal);
  if (v.outcome === 'success' && (v.exitCode !== 0 || v.signal !== null || v.state !== 'complete')) fail('inconsistent-success');
  if (v.receipt !== null) {
    shape(v.receipt, 'sha256 bytes receivedAt'); hash(v.receipt.sha256);
    integer(v.receipt.bytes, Number.MAX_SAFE_INTEGER); integer(v.receipt.receivedAt, Number.MAX_SAFE_INTEGER);
  }
  shape(v.metrics, 'durationMs completedUnits intervalMs cpuUserMs cpuSystemMs peakRssBytes ioBytes toolCalls tokens charge');
  for (const m of Object.values(v.metrics)) metric(m);
  if ((v.metrics.charge as Metric).value !== null) text(v.currency); else if (v.currency !== null) fail('unavailable-currency');
}
function evidence(v: unknown): asserts v is Evidence {
  shape(v, 'version run observations'); one(v.version, [1]); run(v.run);
  if (!Array.isArray(v.observations) || v.observations.length > 4096) fail('observation-limit');
  for (const o of v.observations) observation(o);
}
const runIdentity = (v: Run): string => digest(['benchmark-run/1', v]);
const sampleIdentity = (v: Observation): string => digest(['benchmark-sample/1', v.runKey, v.variant, v.scenario, v.repetition, v.warmup]);
const eventIdentity = (v: Observation): string => digest(['benchmark-event/1', sampleIdentity(v), v.producer, v.attempt, v.kind]);
export function validateRun(json: string): Result<Run> { return result(() => { const v = parse(json); run(v); return v; }); }
export function validateEvidence(json: string): Result<Evidence> { return result(() => { const v = parse(json); evidence(v); return v; }); }
export function identifyRun(json: string): Result<string> { return result(() => { const v = parse(json); run(v); return runIdentity(v); }); }
export function identifySample(json: string): Result<string> { return result(() => { const v = parse(json); observation(v); return sampleIdentity(v); }); }
export function identifyEvent(json: string): Result<string> { return result(() => { const v = parse(json); observation(v); return eventIdentity(v); }); }
export function identifyDefect(json: string): Result<string> {
  return result(() => {
    const v = parse(json); shape(v, 'version component requirement scenario normalizedFailure cohort policy'); one(v.version, [1]);
    for (const k of ['component', 'requirement', 'scenario', 'normalizedFailure', 'cohort']) text(v[k]);
    hash(v.policy); if (v.policy !== POLICY.digest) fail('policy-mismatch'); return digest(['benchmark-defect/1', v]);
  });
}
export function reconcileEvidence(json: string): Result<Evidence & { runKey: string; replays: number }> {
  return result(() => {
    const v = parse(json); evidence(v); const events = new Map<string, string>(), samples = new Map<string, string>();
    const observations: Observation[] = []; let replays = 0;
    for (const o of v.observations) {
      const event = eventIdentity(o), sample = sampleIdentity(o), payload = canonical(o);
      const { producer: _producer, attempt: _attempt, ...samplePayload } = o;
      const semantic = canonical(samplePayload);
      if (events.has(event) && events.get(event) !== payload) fail('event-conflict');
      if (samples.has(sample) && samples.get(sample) !== semantic) fail('sample-conflict');
      events.set(event, payload);
      if (samples.has(sample)) replays++; else { samples.set(sample, semantic); observations.push(o); }
    }
    return { ...v, observations, runKey: runIdentity(v.run), replays };
  });
}
