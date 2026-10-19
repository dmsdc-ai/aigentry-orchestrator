import { identifyDefect, POLICY, reconcileEvidence } from './contracts.js';
import type { Metric, Observation, Result } from './contracts.js';

export interface Summary {
  expected: number; observed: number; successes: number; failures: number; unknown: number;
  validDurations: number; minMs: Metric; medianMs: Metric; maxMs: Metric; p95Ms: Metric;
}
export interface Finding {
  defectKey: string; scenario: string; requirement: string;
  kind: 'correctness-regression' | 'correctness-failure' | 'performance-regression';
  normalizedFailure: string; runKey: string; evidenceReceipts: string[];
}
export interface Comparison {
  version: 1; status: 'review-needed'; executionAuthorized: false;
  taskAdmissionAuthorized: false; loopActivationAuthorized: false;
  runKey: string; policy: typeof POLICY; replays: number;
  coverage: { expected: number; observed: number; failures: number; unknown: number };
  performance: 'refused' | 'review-trigger' | 'not-triggered'; reasons: string[];
  incomplete: boolean; findingsTruncated: boolean; findings: Finding[];
  scenarios: { scenario: string; baseline: Summary; candidate: Summary; matchedSuccesses: number }[];
  confidence: 'none';
}
const unavailable = (reason: string): Metric => ({ value: null, reason, source: null });
const measured = (value: number): Metric => ({ value, reason: null, source: 'caller-observations/descriptive' });
function valid(o: Observation): boolean {
  return o.outcome === 'success' && o.state === 'complete' && o.clock === 'normal'
    && o.cleanup === 'verified' && o.receipt !== null && o.metrics.durationMs.value !== null;
}
function summarize(arm: Observation[], expected: number, matched: number): Summary {
  const durations = arm.filter(valid).map(o => o.metrics.durationMs.value as number).sort((a, b) => a - b);
  const n = durations.length, middle = Math.floor(n / 2);
  const median = n % 2 ? durations[middle] : durations[middle - 1] + (durations[middle] - durations[middle - 1]) / 2;
  return {
    expected, observed: arm.length, successes: arm.filter(o => o.outcome === 'success').length,
    failures: arm.filter(o => o.outcome === 'failure').length, unknown: arm.filter(o => o.outcome === 'unknown').length,
    validDurations: n, minMs: n ? measured(durations[0]) : unavailable('no-valid-successes'),
    medianMs: n ? measured(median) : unavailable('no-valid-successes'),
    maxMs: n ? measured(durations[n - 1]) : unavailable('no-valid-successes'),
    p95Ms: matched >= POLICY.minP95 && matched === n ? measured(durations[Math.ceil(0.95 * n) - 1]) : unavailable('fewer-than-100-or-unmatched-successes'),
  };
}
export function compareEvidence(json: string): Result<Comparison> {
  const decoded = reconcileEvidence(json); if (!decoded.ok) return decoded;
  const { run, observations, runKey, replays } = decoded.value;
  const reasons = new Set<string>(), findings: Finding[] = [];
  let findingsTruncated = false, triggered = false;
  const addFinding = (scenario: string, requirement: string, failure: string, kind: Finding['kind'], receipts: string[]) => {
    const key = identifyDefect(JSON.stringify({ version: 1, component: run.component, requirement, scenario,
      normalizedFailure: failure, cohort: run.cohort, policy: run.policy }));
    if (!key.ok) { reasons.add('defect-identity-refused'); return; }
    const existing = findings.find(f => f.defectKey === key.value);
    if (existing) {
      if (kind === 'correctness-regression') existing.kind = kind;
      for (const receipt of receipts) if (!existing.evidenceReceipts.includes(receipt)) {
        if (existing.evidenceReceipts.length >= 64) findingsTruncated = true;
        else existing.evidenceReceipts.push(receipt);
      }
    } else if (findings.length >= 64) findingsTruncated = true;
    else findings.push({ defectKey: key.value, scenario, requirement, kind, normalizedFailure: failure,
      runKey, evidenceReceipts: receipts.slice(0, 64) });
    if (receipts.length > 64) findingsTruncated = true;
  };
  if (run.baseline === null) reasons.add('missing-baseline');
  const selected = new Map(run.selection.scenarios.map(s => [s.id, s]));
  const comparable: Observation[] = [];
  for (const o of observations) {
    if (o.runKey !== runKey) reasons.add('identity-mismatch');
    const scenario = selected.get(o.scenario);
    if (!scenario || o.repetition >= (o.warmup ? run.selection.warmups : run.selection.repetitions)) reasons.add('selection-mismatch');
    if (o.receipt === null) reasons.add('missing-receipts');
    if (o.state !== 'complete') reasons.add('partial');
    if (o.clock !== 'normal') reasons.add('clock-anomaly');
    if (o.cleanup !== 'verified') reasons.add('cleanup-uncertain');
    if (o.outcome !== 'success') reasons.add('unsuccessful-outcomes');
    if (!o.warmup && o.metrics.durationMs.value === null) reasons.add('duration-unavailable');
    if (scenario && o.runKey === runKey && o.repetition < (o.warmup ? run.selection.warmups : run.selection.repetitions)) comparable.push(o);
    // Retain selected candidate correctness evidence even when performance cannot be compared.
    if (scenario && o.runKey === runKey && o.repetition < (o.warmup ? run.selection.warmups : run.selection.repetitions)
      && o.variant === 'candidate' && o.outcome === 'failure') {
      const baseline = observations.find(b => b.variant === 'baseline' && b.runKey === runKey && o.runKey === runKey
        && b.scenario === o.scenario && b.repetition === o.repetition && b.warmup === o.warmup);
      addFinding(o.scenario, scenario.requirement, o.failure as string,
        baseline?.outcome === 'success' && baseline.state === 'complete' && baseline.receipt !== null
          ? 'correctness-regression' : 'correctness-failure',
        o.receipt ? [o.receipt.sha256] : []);
    }
  }
  const scenarios: Comparison['scenarios'] = [];
  for (const s of run.selection.scenarios) {
    const rows = comparable.filter(o => o.scenario === s.id);
    for (const variant of ['baseline', 'candidate'] as const) {
      const arm = rows.filter(o => o.variant === variant);
      if (arm.length !== run.selection.repetitions + run.selection.warmups) reasons.add('missing-selection-observations');
      if (new Set(arm.map(o => o.outcome)).size > 1) reasons.add('flaky-outcomes');
    }
    const baseline = rows.filter(o => o.variant === 'baseline' && !o.warmup);
    const candidate = rows.filter(o => o.variant === 'candidate' && !o.warmup);
    const matched = baseline.filter(b => valid(b) && candidate.some(c => c.repetition === b.repetition && valid(c))).length;
    const a = summarize(baseline, run.selection.repetitions, matched), b = summarize(candidate, run.selection.repetitions, matched);
    scenarios.push({ scenario: s.id, baseline: a, candidate: b, matchedSuccesses: matched });
    if (matched < POLICY.minSuccesses) reasons.add('insufficient-matched-successes');
  }
  // Global completeness is checked before any performance acceptance or trigger.
  if (!reasons.size) for (const s of scenarios) {
    const a = s.baseline.medianMs.value, b = s.candidate.medianMs.value;
    if (a !== null && b !== null && b - a > POLICY.absoluteIncreaseMs && b - a > a * POLICY.relativeIncrease) {
      triggered = true;
      const selection = selected.get(s.scenario)!;
      addFinding(s.scenario, selection.requirement, 'duration-median-regression', 'performance-regression',
        comparable.filter(o => o.scenario === s.scenario && !o.warmup && o.receipt !== null).map(o => o.receipt!.sha256));
    }
  }
  if (findingsTruncated) reasons.add('findings-cap');
  return { ok: true, value: { version: 1, status: 'review-needed', executionAuthorized: false,
    taskAdmissionAuthorized: false, loopActivationAuthorized: false, runKey, policy: POLICY, replays,
    coverage: { expected: 2 * run.selection.scenarios.length * (run.selection.repetitions + run.selection.warmups),
      observed: observations.length, failures: observations.filter(o => o.outcome === 'failure').length,
      unknown: observations.filter(o => o.outcome === 'unknown').length },
    performance: reasons.size ? 'refused' : triggered ? 'review-trigger' : 'not-triggered',
    reasons: [...reasons].sort(), incomplete: reasons.size > 0, findingsTruncated, findings, scenarios, confidence: 'none' } };
}
