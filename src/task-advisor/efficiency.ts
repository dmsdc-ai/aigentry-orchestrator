import {
  type AdvisorEventV1, type AttributionReason, type Coverage, type DistributionV1, type EfficiencyAnalysisRequestV1,
  type EfficiencyProposalV1, type EfficiencyReportV1, type EfficiencyResult, type MetricName, type MetricScope, type MetricV1,
  type OutcomeV1, type PriorConditionV1, type ProposalScope, type RuleId, type SourceKind, type SuppressedV1,
  type UnsupportedMetricV1, ACTIONS, ERROR_CLASSES, SOURCE_KINDS, UNCERTAINTY, metadataId, parseUtc, recordTimeMs,
  validateAnalysisRequestV1, validateEfficiencyProposalV1, worstCoverage,
} from './efficiency-contracts.js';

/** PURE bounded aggregation/detection over validated collected records (CONTRACT-final §5–§6).
 * Inputs are detached by validation and never mutated. No I/O, env, timers or wall clock:
 * `now` is the supplied fixed clock. Operation, record and group budgets are deterministic
 * counts, not wall-clock claims; any overflow yields `partial` and no proposals.
 * Output is review opportunities only: no dispatch, admission, Loop or permission action,
 * measuredSavings null, benefit magnitude unknown, adoption unknown.
 */
class BudgetExceeded extends Error {}

const UNSUPPORTED: readonly UnsupportedMetricV1[] = Object.freeze((['auth-expiry-repeats', 'tool-call-timing', 'redundant-tool-reads',
  'cpu-per-worker', 'token-cost', 'dependency-graph', 'serial-wait-waste', 'causality'] as const)
  .map(metric => Object.freeze({ metric, status: 'source-unavailable' as const, observed: null, reason: 'no-event-source' as const })));

/** Condition label from typed fields only (explicit errorClass wins; else kind+outcome). */
function conditionOf(event: AdvisorEventV1): string | null {
  if (event.errorClass !== null) return event.errorClass;
  switch (event.kind) {
    case 'dispatch.ack': return event.outcome === 'unverified' ? 'delivery-unverified' : null;
    case 'dispatch.started_check': return event.outcome === 'unverified' ? 'start-unverified' : null;
    case 'dispatch.gate_reject': return 'gate-reject';
    case 'dispatch.retry_refused': return 'retry-refused';
    case 'dispatch.ledger_failed': return 'ledger-write';
    case 'inject.payload_rejected': return 'payload-rejected';
    case 'reconciler.transport_error': return 'transport';
    case 'reconciler.loop_tick_error': return 'loop-tick';
    case 'reconciler.cleanup': return event.outcome === 'failed' ? 'cleanup' : null;
    default: return null;
  }
}
const ESCALATION_CONDITION = 'verify-escalation';
const LATENCY_METRICS = ['handoff-latency-start-ack', 'handoff-latency-ack-started-check', 'report-latency-ack-report'] as const;
type LatencyMetric = typeof LATENCY_METRICS[number];

interface Group {
  key: string; scope: MetricScope; scopeId: string | null; reason: AttributionReason;
  samples: Record<SourceKind, number>; conditions: Map<string, number>; versions: Set<string>;
  starts: number; rounds: Map<string, number>; latency: Record<LatencyMetric, number[]>; unbound: number;
  /** Ambiguous exact bindings attributed to this group (unknown timing; blocks latency resolution). */
  ambiguous: number;
  /** Sorted first-16 producer versions, computed once per group (not per metric/fire). */
  sortedVersions: string[] | null;
}
function newGroup(key: string, scope: MetricScope, scopeId: string | null, reason: AttributionReason): Group {
  return { key, scope, scopeId, reason, samples: { 'advisor-spool-v1': 0, 'verify-escalations-v1': 0 }, conditions: new Map(),
    versions: new Set(), starts: 0, rounds: new Map(), unbound: 0, ambiguous: 0, sortedVersions: null,
    latency: { 'handoff-latency-start-ack': [], 'handoff-latency-ack-started-check': [], 'report-latency-ack-report': [] } };
}
function nearestRank(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}
function band(observed: number, threshold: number): number {
  let ratio = Math.floor(observed / threshold), out = 0;
  while (ratio >= 2) { ratio = Math.floor(ratio / 2); out++; }
  return out;
}
export function semanticKeyV1(ownerTaskId: string, releaseId: string, rule: RuleId, scope: ProposalScope, scopeId: string | null, conditionKey: string): string {
  return metadataId(['efficiency-semantic-v1', ownerTaskId, releaseId, rule, 1, scope, scopeId, conditionKey]);
}

/** Entry point: validate the complete request, then analyze deterministically. */
export function analyzeEfficiency(input: unknown): EfficiencyResult<EfficiencyReportV1> {
  const checked = validateAnalysisRequestV1(input);
  if (!checked.ok) return checked;
  return { ok: true, value: analyzeValidated(checked.value) };
}

function analyzeValidated(req: EfficiencyAnalysisRequestV1): EfficiencyReportV1 {
  const { analysis, grant, config, window } = req;
  const nowMs = parseUtc(req.now)!, fromMs = parseUtc(window.from)!, toMs = parseUtc(window.to)!;
  const closed = toMs <= nowMs;
  const currentness = closed ? 'closed-window' as const : 'open-window' as const;
  const workspace = grant.mode === 'whole-workspace-diagnostic';
  const grantTasks = new Set(grant.taskIds), grantSids = new Set(grant.sids), grantReleases = new Set(grant.releaseIds);
  const sidListed = (sid: string): boolean => workspace || grantSids.has(sid);
  let operations = 0;
  const tick = (): void => { if (++operations > config.maxOperations) throw new BudgetExceeded(); };
  const charge = (n: number): void => { operations += n; if (operations > config.maxOperations) throw new BudgetExceeded(); };

  // Per-source-kind coverage from supplied span/state; never synthesized.
  const reasons = new Set<string>();
  const kindState = new Map<SourceKind, { available: boolean; coverage: Coverage }>();
  for (const kind of SOURCE_KINDS) {
    const entries = req.sources.filter(source => source.sourceKind === kind);
    if (entries.length === 0 || entries.some(entry => !entry.available)) {
      kindState.set(kind, { available: false, coverage: 'unknown' });
      reasons.add(kind === 'advisor-spool-v1' ? 'spool-unavailable' : 'escalations-unavailable');
      continue;
    }
    const levels = entries.map(entry => {
      const spans = parseUtc(entry.coveredFrom)! <= fromMs && parseUtc(entry.coveredTo)! >= Math.min(toMs, nowMs);
      if (!spans) reasons.add('source-window-gap');
      return spans ? entry.coverage : 'gap' as const;
    });
    kindState.set(kind, { available: true, coverage: worstCoverage(levels) });
  }
  const degrade = (kind: SourceKind, reason: string): void => {
    const state = kindState.get(kind)!;
    reasons.add(reason);
    if (state.available) state.coverage = worstCoverage([state.coverage, 'partial']);
  };
  if (!closed) reasons.add('open-window');

  const counts = { recordsSupplied: req.records.length, recordsVisible: 0, recordsTruncated: 0, lateExcluded: 0, conflictsExcluded: 0,
    possibleDuplicatesExcluded: 0, undeclaredSource: 0, ambiguousBindings: 0, clockAnomalies: 0, unattributed: 0,
    nonSubjectTasks: 0, groupsOverflow: 0, proposalsOverflow: 0, priorIgnored: 0, operations: 0 };
  const groups = new Map<string, Group>();
  let proposals: EfficiencyProposalV1[] = [];
  const suppressed: SuppressedV1[] = [];
  const outcomes: OutcomeV1[] = [];
  let budgetHit = false;

  try {
    // 1. Declared sources, conflicts, deterministic order, record budget.
    const declared = new Map(req.sources.map(source => [source.sourceId, source.sourceKind]));
    const conflicts = new Set<string>();
    const bodies = new Map<string, string>();
    const timed: { ms: number; id: string; record: Exclude<EfficiencyAnalysisRequestV1['records'][number], { type: 'event-id-conflict' }> }[] = [];
    for (const record of req.records) {
      tick();
      if (declared.get(record.sourceId) !== record.sourceKind) { counts.undeclaredSource++; degrade(record.sourceKind, 'undeclared-source'); continue; }
      if (record.type === 'event-id-conflict') { conflicts.add(record.eventId); continue; }
      if (record.type === 'event') {
        const body = metadataId(record.event), prior = bodies.get(record.event.eventId);
        if (prior !== undefined) { if (prior !== body) conflicts.add(record.event.eventId); continue; }
        bodies.set(record.event.eventId, body);
      }
      timed.push({ ms: recordTimeMs(record)!, id: record.recordId, record });
    }
    timed.sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    operations += timed.length;
    if (operations > config.maxOperations) throw new BudgetExceeded();
    if (timed.length > config.maxRecords) {
      for (const dropped of timed.slice(config.maxRecords)) degrade(dropped.record.sourceKind, 'record-budget');
      counts.recordsTruncated = timed.length - config.maxRecords;
      timed.length = config.maxRecords;
    }
    if (conflicts.size > 0) degrade('advisor-spool-v1', 'event-id-conflict');

    // 2. Exact (sid, dispatchId) → task index from dispatch.start carrying taskId.
    const starts = new Map<string, Set<string>>();
    for (const { record } of timed) {
      tick();
      if (record.type !== 'event' || conflicts.has(record.event.eventId)) continue;
      const e = record.event;
      if (e.kind === 'dispatch.start' && e.taskId !== null && e.sid !== null && e.dispatchId !== null) {
        const key = `${e.sid}\u0000${e.dispatchId}`;
        const tasks = starts.get(key) ?? new Set<string>();
        tasks.add(e.taskId); starts.set(key, tasks);
      }
    }
    const attribute = (e: AdvisorEventV1): { task: string | null; reason: AttributionReason } => {
      if (e.taskId !== null) return { task: e.taskId, reason: 'explicit-task' };
      if (e.sid !== null && e.dispatchId !== null) {
        const tasks = starts.get(`${e.sid}\u0000${e.dispatchId}`);
        if (tasks !== undefined && tasks.size === 1) return { task: [...tasks][0], reason: 'exact-dispatch-binding' };
        return { task: null, reason: tasks === undefined ? 'no-task' : 'ambiguous-attempt' };
      }
      // A sid-only record never binds to an attempt ("only one open sid" is not evidence).
      return { task: null, reason: e.sid !== null ? 'ambiguous-attempt' : 'no-task' };
    };
    const visible = (task: string | null, sid: string | null, release: string | null): boolean => {
      if (workspace) return true;
      if (task !== null) return grantTasks.has(task);
      return (sid !== null && grantSids.has(sid)) || (release !== null && grantReleases.has(release));
    };

    // 3. Groups (granted subjects first, so zero observations are explicit, not absent).
    const group = (key: string, scope: MetricScope, scopeId: string | null, reason: AttributionReason): Group | null => {
      const existing = groups.get(key);
      if (existing !== undefined) return existing;
      if (groups.size >= config.maxGroups) { counts.groupsOverflow++; reasons.add('group-budget'); return null; }
      const created = newGroup(key, scope, scopeId, reason); groups.set(key, created); return created;
    };
    for (const task of grant.taskIds) group(`task\u0000${task}`, 'task', task, 'explicit-task');
    for (const sid of grant.sids) group(`session\u0000${sid}`, 'session', sid, 'session');
    for (const release of grant.releaseIds) group(`release\u0000${release}`, 'release', release, 'release');
    if (workspace) group('system', 'system', null, 'system-aggregate');
    const nonSubject = new Set<string>();
    type Binding = { task: string; start: AdvisorEventV1[]; ack: AdvisorEventV1[]; check: AdvisorEventV1[]; report: AdvisorEventV1[] };
    const bindings = new Map<string, Binding>();

    for (const { ms, record } of timed) {
      tick();
      if (record.type === 'event' && conflicts.has(record.event.eventId)) { counts.conflictsExcluded++; continue; }
      if (ms < fromMs || ms >= toMs) continue;
      const kind = record.sourceKind;
      let task: string | null = null, reason: AttributionReason = 'no-task', sid: string | null, release: string | null = null;
      let condition: string | null, event: AdvisorEventV1 | null = null;
      if (record.type === 'event') {
        event = record.event;
        ({ task, reason } = attribute(event));
        sid = event.sid; release = event.releaseId; condition = conditionOf(event);
      } else {
        sid = record.sid; condition = ESCALATION_CONDITION;
        reason = 'no-task';
      }
      if (!visible(task, sid, release)) continue;
      // Late in-window records are excluded from a closed window: that is loss, so the source degrades.
      // Checked after grant filtering so a narrow view only reflects its own subjects' loss.
      if (record.late && closed) { counts.lateExcluded++; degrade(kind, 'late-excluded'); continue; }
      if (record.type === 'escalation' && record.possibleDuplicate) { counts.possibleDuplicatesExcluded++; continue; }
      counts.recordsVisible++;
      const targets: Group[] = [];
      const push = (target: Group | null): void => { if (target !== null) targets.push(target); };
      if (task !== null) {
        if (grantTasks.has(task)) push(group(`task\u0000${task}`, 'task', task, reason));
        else nonSubject.add(task);
      } else if (workspace) { counts.unattributed++; push(group(`unattributed\u0000${reason}`, 'unattributed', null, reason)); }
      if (sid !== null && sidListed(sid)) push(group(`session\u0000${sid}`, 'session', sid, 'session'));
      if (release !== null && grantReleases.has(release)) push(group(`release\u0000${release}`, 'release', release, 'release'));
      if (workspace) push(group('system', 'system', null, 'system-aggregate'));
      for (const target of targets) {
        tick();
        target.samples[kind]++;
        if (condition !== null) target.conditions.set(condition, (target.conditions.get(condition) ?? 0) + 1);
        if (event !== null) target.versions.add(event.producerVersion);
        if (event !== null && event.kind === 'dispatch.start' && target.scope === 'task') {
          target.starts++;
          if (event.role !== null) target.rounds.set(event.role, (target.rounds.get(event.role) ?? 0) + 1);
        }
      }
      // Timing needs exact non-null task+sid+attempt+operation; unbound timing events stay unknown.
      if (event !== null && ['dispatch.start', 'dispatch.ack', 'dispatch.started_check', 'inject.report'].includes(event.kind)) {
        if (task === null || event.sid === null || event.attempt === null || event.operation === null) {
          for (const target of targets) target.unbound++;
          continue;
        }
        const key = `${task}\u0000${event.sid}\u0000${event.attempt}\u0000${event.operation}`;
        const binding = bindings.get(key) ?? { task, start: [], ack: [], check: [], report: [] };
        (event.kind === 'dispatch.start' ? binding.start : event.kind === 'dispatch.ack' ? binding.ack
          : event.kind === 'dispatch.started_check' ? binding.check : binding.report).push(event);
        bindings.set(key, binding);
      }
    }
    counts.nonSubjectTasks = nonSubject.size;

    // 4. Exact-binding intervals (producer clock). Duplicates or dispatchId disagreement = ambiguous.
    for (const key of [...bindings.keys()].sort()) {
      tick();
      const b = bindings.get(key)!;
      const all = [...b.start, ...b.ack, ...b.check, ...b.report];
      const dispatchIds = new Set(all.map(e => e.dispatchId).filter((value): value is string => value !== null));
      if (b.start.length > 1 || b.ack.length > 1 || b.check.length > 1 || b.report.length > 1 || dispatchIds.size > 1) {
        counts.ambiguousBindings++;
        if (grantTasks.has(b.task)) { const taskGroup = groups.get(`task\u0000${b.task}`); if (taskGroup !== undefined) taskGroup.ambiguous++; }
        if (workspace) { const systemGroup = groups.get('system'); if (systemGroup !== undefined) systemGroup.ambiguous++; }
        continue;
      }
      const interval = (from: AdvisorEventV1 | undefined, to: AdvisorEventV1 | undefined, metric: LatencyMetric): void => {
        if (from === undefined || to === undefined) return;
        const ms = Date.parse(to.at) - Date.parse(from.at);
        if (ms < 0) { counts.clockAnomalies++; return; }
        const taskGroup = grantTasks.has(b.task) ? groups.get(`task\u0000${b.task}`) : undefined;
        taskGroup?.latency[metric].push(ms);
        if (workspace) groups.get('system')?.latency[metric].push(ms);
      };
      interval(b.start[0], b.ack[0], 'handoff-latency-start-ack');
      interval(b.ack[0], b.check[0], 'handoff-latency-ack-started-check');
      interval(b.ack[0], b.report[0], 'report-latency-ack-report');
    }
    if (counts.clockAnomalies > 0) reasons.add('clock-anomaly');
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    budgetHit = true; reasons.add('operation-budget'); groups.clear();
    for (const kind of SOURCE_KINDS) degrade(kind, 'operation-budget');
  }

  // 5. Metrics (sorted, deterministic). Unavailable source → observed null, never zero.
  // Phases 5–7 share the operation budget; exhaustion discards metrics/proposals and resolves nothing.
  const metrics: MetricV1[] = [];
  const firing = new Map<string, { rule: RuleId; scope: ProposalScope; scopeId: string | null; conditionKey: string;
    observed: number; samples: number; threshold: number; unit: 'count' | 'ms'; distribution: DistributionV1 | null;
    sources: SourceKind[]; versions: string[]; band: number }>();
  let globalPartial = budgetHit || reasons.has('record-budget') || reasons.has('group-budget') || reasons.has('undeclared-source');
  const eligible = (kind: SourceKind): boolean => closed && !globalPartial && kindState.get(kind)!.coverage === 'complete';
  const versionsOf = (g: Group): string[] => {
    if (g.sortedVersions === null) { charge(g.versions.size); g.sortedVersions = [...g.versions].sort().slice(0, 16); }
    return [...g.sortedVersions];
  };
  const metric = (g: Group, name: MetricName, kind: SourceKind, conditionKey: string | null, observed: number | null, samples: number,
    unit: 'count' | 'ms', distribution: DistributionV1 | null, attributionReason: AttributionReason, unknown = 0): MetricV1 => {
    tick();
    const state = kindState.get(kind)!;
    const status = !state.available ? 'source-unavailable' as const : observed === null ? 'insufficient-data' as const : 'observed' as const;
    return { schema: 'efficiency-metric-v1', metric: name, scope: g.scope, scopeId: g.scopeId, conditionKey, window: { ...window }, currentness,
      status, coverage: state.coverage, observed: state.available ? observed : null, estimated: null, unknown,
      samples: state.available ? samples : 0, unit, distribution: state.available && distribution !== null ? { ...distribution } : null,
      basis: unit === 'count' ? 'observed-count' : name === 'report-latency-ack-report' ? 'work-duration' : 'producer-clock-interval',
      attributionReason, sources: [kind], sourceVersions: kind === 'advisor-spool-v1' ? versionsOf(g) : [] };
  };
  const proposable = (g: Group): boolean => g.scope !== 'unattributed' && !(g.scope === 'task' && g.scopeId === analysis.ownerTaskId);
  const fire = (g: Group, rule: RuleId, conditionKey: string, observed: number, samples: number, threshold: number,
    unit: 'count' | 'ms', distribution: DistributionV1 | null, kind: SourceKind): void => {
    tick();
    const scope = g.scope as ProposalScope;
    const semanticKey = semanticKeyV1(analysis.ownerTaskId, analysis.releaseId, rule, scope, g.scopeId, conditionKey);
    firing.set(semanticKey, { rule, scope, scopeId: g.scopeId, conditionKey, observed, samples, threshold, unit, distribution,
      sources: [kind], versions: kind === 'advisor-spool-v1' ? versionsOf(g) : [], band: band(observed, threshold) });
  };

  // 6a. Supplied suppression evidence: must match semantic identity and be inside the grant.
  // Unbudgeted so every accepted prior still gets an outcome; bounded by the validator's 10,000-prior cap.
  const inGrant = (scope: ProposalScope, scopeId: string | null): boolean =>
    scope === 'system' ? workspace : scope === 'task' ? grantTasks.has(scopeId!) : scope === 'session' ? sidListed(scopeId!) : grantReleases.has(scopeId!);
  const priors = new Map<string, PriorConditionV1>();
  for (const prior of req.priorConditions) {
    if (prior.semanticKey !== semanticKeyV1(analysis.ownerTaskId, analysis.releaseId, prior.rule, prior.scope, prior.scopeId, prior.conditionKey)
      || !inGrant(prior.scope, prior.scopeId)) { counts.priorIgnored++; continue; }
    priors.set(prior.semanticKey, prior);
  }
  const outcomeKind = (prior: PriorConditionV1): SourceKind =>
    prior.rule === 'repeated-error-class-v1' && prior.conditionKey === ESCALATION_CONDITION ? 'verify-escalations-v1' : 'advisor-spool-v1';
  // Absent firing is positive resolution only if the enabled rule was actually evaluable for that subject:
  // eligible coverage, sufficient relevant samples, and (latency) exact bindings with no unknown timing.
  const errorConditions: ReadonlySet<string> = new Set<string>([...ERROR_CLASSES, ESCALATION_CONDITION]);
  const evaluable = (prior: PriorConditionV1): boolean => {
    const kind = outcomeKind(prior);
    const g = groups.get(prior.scope === 'system' ? 'system' : `${prior.scope}\u0000${prior.scopeId}`);
    if (g === undefined || !proposable(g) || !eligible(kind)) return false;
    switch (prior.rule) {
      case 'repeated-error-class-v1':
        return config.errorRepeatThreshold !== null && errorConditions.has(prior.conditionKey) && g.samples[kind] >= config.minSamples;
      case 'repeated-rounds-v1':
        return config.roundsThreshold !== null && g.scope === 'task' && prior.conditionKey.startsWith('rounds/') && g.starts >= config.minSamples;
      case 'handoff-latency-v1': {
        const name = prior.conditionKey;
        return config.handoffLatencyThresholdMs !== null && (g.scope === 'task' || g.scope === 'system')
          && (name === 'handoff-latency-start-ack' || name === 'handoff-latency-ack-started-check')
          && g.latency[name].length >= config.minSamples && g.unbound === 0 && g.ambiguous === 0;
      }
    }
  };

  try {
    const groupKeys = [...groups.keys()];
    charge(groupKeys.length);
    for (const key of groupKeys.sort()) {
      const g = groups.get(key)!;
      for (const kind of SOURCE_KINDS) metrics.push(metric(g, 'record-count', kind, null, g.samples[kind], g.samples[kind], 'count', null, g.reason));
      for (const condition of [...g.conditions.keys()].sort()) {
        const kind: SourceKind = condition === ESCALATION_CONDITION ? 'verify-escalations-v1' : 'advisor-spool-v1';
        const observed = g.conditions.get(condition)!, samples = g.samples[kind];
        metrics.push(metric(g, 'error-class-repeats', kind, condition, observed, samples, 'count', null, g.reason));
        const threshold = config.errorRepeatThreshold;
        if (proposable(g) && eligible(kind) && threshold !== null && observed >= threshold && samples >= config.minSamples) {
          fire(g, 'repeated-error-class-v1', condition, observed, samples, threshold, 'count', null, kind);
        }
      }
      if (g.scope === 'task') {
        const roles = [...g.rounds.keys()];
        charge(roles.length);
        for (const role of roles.sort()) {
          const observed = g.rounds.get(role)!, conditionKey = `rounds/${role}`;
          metrics.push(metric(g, 'dispatch-rounds', 'advisor-spool-v1', conditionKey, observed, g.starts, 'count', null, g.reason));
          const threshold = config.roundsThreshold;
          if (proposable(g) && eligible('advisor-spool-v1') && threshold !== null && observed >= threshold && g.starts >= config.minSamples) {
            fire(g, 'repeated-rounds-v1', conditionKey, observed, g.starts, threshold, 'count', null, 'advisor-spool-v1');
          }
        }
      }
      if (g.scope === 'task' || g.scope === 'system') {
        for (const name of LATENCY_METRICS) {
          charge(g.latency[name].length);
          const values = [...g.latency[name]].sort((a, b) => a - b);
          if (values.length === 0) {
            metrics.push(metric(g, name, 'advisor-spool-v1', name, null, 0, 'ms', null, 'exact-binding-unavailable', g.unbound));
            continue;
          }
          const distribution = { p50: nearestRank(values, 0.5), p90: nearestRank(values, 0.9), max: values[values.length - 1] };
          // A latency metric's observed value is its p90 in ms (same statistic the threshold compares); samples is the count.
          metrics.push(metric(g, name, 'advisor-spool-v1', name, distribution.p90, values.length, 'ms', distribution, g.reason, g.unbound));
          const threshold = config.handoffLatencyThresholdMs;
          if (name !== 'report-latency-ack-report' && proposable(g) && eligible('advisor-spool-v1') && threshold !== null
            && distribution.p90 > threshold && values.length >= config.minSamples) {
            fire(g, 'handoff-latency-v1', name, distribution.p90, values.length, threshold, 'ms', distribution, 'advisor-spool-v1');
          }
        }
      }
    }

    // 6b. Proposals from firing conditions, applying the supplied suppression evidence.
    const candidates: EfficiencyProposalV1[] = [];
    const firingKeys = [...firing.keys()];
    charge(firingKeys.length);
    for (const semanticKey of firingKeys.sort()) {
      tick();
      const f = firing.get(semanticKey)!;
      const evidenceDigest = metadataId(['efficiency-evidence-v1', semanticKey, f.band]);
      const prior = priors.get(semanticKey);
      let reopenedFrom: string | null = null;
      if (prior !== undefined && prior.decision !== 'open') {
        const unchanged = prior.evidenceDigest === evidenceDigest;
        if (unchanged && prior.decision === 'rejected') { suppressed.push({ semanticKey, rule: f.rule, reason: 'rejected-unchanged' }); continue; }
        if (unchanged && nowMs < parseUtc(prior.deferredUntil)!) { suppressed.push({ semanticKey, rule: f.rule, reason: 'deferred-until' }); continue; }
        reopenedFrom = prior.evidenceDigest;
      }
      const action = ACTIONS[f.rule];
      const proposal: EfficiencyProposalV1 = {
        schemaVersion: 1, adapter: 'efficiency-proposal-v1', claimClass: 'review-opportunity',
        id: metadataId(['efficiency-proposal-v1', semanticKey, evidenceDigest]), semanticKey, evidenceDigest, reopenedFrom,
        status: reopenedFrom === null ? 'open' : 'reopened', ownerTaskId: analysis.ownerTaskId, releaseId: analysis.releaseId,
        subjects: { scope: f.scope, scopeId: f.scopeId, taskIds: f.scope === 'task' ? [f.scopeId!] : [], sids: f.scope === 'session' ? [f.scopeId!] : [] },
        rule: f.rule, ruleVersion: 1, conditionKey: f.conditionKey, evidenceWindow: { ...window },
        evidence: { observed: f.observed, samples: f.samples, threshold: f.threshold, minSamples: config.minSamples, unit: f.unit,
          distribution: f.distribution === null ? null : { ...f.distribution }, coverage: 'complete', sources: f.sources, sourceVersions: f.versions },
        confidence: 'low', uncertainty: UNCERTAINTY,
        action: { id: action.id, text: action.text, reversible: true, changesPermissions: false }, risk: action.risk,
        analysisCost: 'unknown', measuredSavings: null, benefit: { magnitude: 'unknown', estimate: null },
        authority: { producerAuth: 'not-established', executionAuthorized: false, dispatchAuthorized: false,
          admissionAuthorized: false, loopActivationAuthorized: false, permissionChange: false },
      };
      const self = validateEfficiencyProposalV1(proposal);
      if (!self.ok) throw new Error('efficiency-proposal-invariant');
      candidates.push(proposal);
    }
    const bandOf = (p: EfficiencyProposalV1): number => firing.get(p.semanticKey)!.band;
    charge(candidates.length);
    candidates.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) || bandOf(b) - bandOf(a) || (a.semanticKey < b.semanticKey ? -1 : 1));
    const perRule = new Map<RuleId, number>();
    for (const candidate of candidates) {
      const used = perRule.get(candidate.rule) ?? 0;
      if (used >= config.maxProposalsPerRule) { counts.proposalsOverflow++; continue; }
      perRule.set(candidate.rule, used + 1); proposals.push(candidate);
    }

    // 7. Outcomes: association only; adoption stays unknown; no receipts are accepted here.
    const priorKeys = [...priors.keys()];
    charge(priorKeys.length);
    for (const semanticKey of priorKeys.sort()) {
      tick();
      const prior = priors.get(semanticKey)!;
      const status = firing.has(semanticKey) ? 'condition-present' as const : evaluable(prior) ? 'condition-resolved' as const : 'insufficient-data' as const;
      outcomes.push({ semanticKey, rule: prior.rule, status, adoption: 'unknown', associationOnly: true });
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    budgetHit = true; globalPartial = true; reasons.add('operation-budget');
    for (const kind of SOURCE_KINDS) degrade(kind, 'operation-budget');
  }
  if (budgetHit) {
    // Exhausted budget: no metric, proposal or suppression is claimed and nothing is resolved.
    metrics.length = 0; proposals = []; suppressed.length = 0; outcomes.length = 0;
    for (const semanticKey of [...priors.keys()].sort()) {
      outcomes.push({ semanticKey, rule: priors.get(semanticKey)!.rule, status: 'insufficient-data', adoption: 'unknown', associationOnly: true });
    }
  }
  counts.operations = Math.min(operations, config.maxOperations);

  const bySource = SOURCE_KINDS.map(kind => ({ sourceKind: kind, ...kindState.get(kind)! }));
  const overall = worstCoverage([...bySource.map(item => item.coverage), ...(globalPartial ? ['partial' as const] : [])]);
  return {
    schemaVersion: 1, adapter: 'efficiency-report-v1', ownerTaskId: analysis.ownerTaskId, releaseId: analysis.releaseId,
    grantMode: grant.mode, generatedAt: req.now, window: { ...window }, currentness,
    coverage: { overall, bySource, reasons: [...reasons].sort() }, metrics, unsupported: UNSUPPORTED.map(item => ({ ...item })),
    proposals, suppressed, outcomes,
    counts: { ...counts,
      recordsSupplied: workspace ? counts.recordsSupplied : null, recordsTruncated: workspace ? counts.recordsTruncated : null,
      lateExcluded: workspace ? counts.lateExcluded : null, conflictsExcluded: workspace ? counts.conflictsExcluded : null,
      undeclaredSource: workspace ? counts.undeclaredSource : null, unattributed: workspace ? counts.unattributed : null,
      nonSubjectTasks: workspace ? counts.nonSubjectTasks : null, operations: workspace ? counts.operations : null },
    authority: 'none', provenance: 'not-established',
  };
}
