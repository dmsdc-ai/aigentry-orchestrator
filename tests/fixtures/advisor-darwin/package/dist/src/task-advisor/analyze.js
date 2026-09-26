import { randomUUID } from 'node:crypto';
import { canonicalTaskId, hashJson, requireV2, utcV2, } from './contracts.js';
export function improvementKey(workspace, release, target) {
    return hashJson([workspace, release, 'missing-updated-at-v1', target, 'updated_at']);
}
function priority(row) {
    if (typeof row.priority === 'number' && Number.isSafeInteger(row.priority) && row.priority >= 0)
        return BigInt(row.priority);
    if (typeof row.priority === 'string' && /^P[0-9]+$/.test(row.priority))
        return BigInt(row.priority.slice(1));
    return null;
}
function knownAge(row) {
    if (typeof row.updated_at !== 'string' || !row.updated_at)
        return false;
    try {
        const stamp = /^\d{4}-\d{2}-\d{2}$/.test(row.updated_at) ? row.updated_at + 'T00:00:00Z' : row.updated_at;
        utcV2(stamp);
        return true;
    }
    catch {
        return false;
    }
}
/** Internal deterministic engine. Only cli.tick calls it after store.reserve has
 * committed; a structurally valid input alone is not authority to call it. */
export function analyzeReserved(input, config, trigger, packageVersion, deadline, suppressed = new Set()) {
    const start = performance.now();
    const check = () => requireV2(Date.now() < deadline && performance.now() - start <= Math.min(config.maxCpuWallMs, input.binding.budget.maxWallMs), 'analysis-time-limit');
    const { queue, binding } = input;
    const all = [...queue.tasks, ...(queue.completed ?? [])];
    const subjects = new Set(binding.scope.subjectTaskIds);
    const incoming = new Map(), structured = new Set();
    const trackUsers = new Map(), pathUsers = new Map();
    function add(map, key, id) {
        const entries = map.get(key) ?? new Set();
        entries.add(id);
        map.set(key, entries);
    }
    for (const row of all) {
        check();
        const id = canonicalTaskId(row.id);
        if (typeof row.advisorImprovementKey === 'string')
            structured.add(row.advisorImprovementKey);
        for (const blocked of new Set((row.blocks ?? []).map(canonicalTaskId))) {
            const target = canonicalTaskId(blocked);
            incoming.set(target, (incoming.get(target) ?? 0) + 1);
        }
        if (['in_progress', 'delegated', 'blocked', 'blocked-by-observation'].includes(row.status)) {
            if (typeof row.track === 'string' && row.track)
                add(trackUsers, row.track, id);
            for (const path of row.paths ?? [])
                add(pathUsers, path, id);
        }
    }
    const conflicts = (row) => {
        check();
        const id = canonicalTaskId(row.id), matched = new Set();
        if (typeof row.track === 'string')
            for (const other of trackUsers.get(row.track) ?? [])
                if (other !== id)
                    matched.add(other);
        for (const path of row.paths ?? [])
            for (const other of pathUsers.get(path) ?? [])
                if (other !== id)
                    matched.add(other);
        return [...matched].sort();
    };
    const candidates = queue.tasks.filter(row => subjects.has(canonicalTaskId(row.id)) && ['pending', 'queued'].includes(row.status))
        .map(row => {
        const ids = conflicts(row);
        return { row, priority: priority(row), conflictCount: ids.length,
            conflictDigest: hashJson(ids), incoming: incoming.get(canonicalTaskId(row.id)) ?? 0 };
    });
    candidates.sort((a, b) => {
        check();
        if (a.priority !== b.priority) {
            if (a.priority === null)
                return 1;
            if (b.priority === null)
                return -1;
            return a.priority < b.priority ? -1 : 1;
        }
        const aid = canonicalTaskId(a.row.id), bid = canonicalTaskId(b.row.id);
        return a.conflictCount - b.conflictCount || b.incoming - a.incoming || (aid < bid ? -1 : aid > bid ? 1 : 0);
    });
    const out = [];
    function propose(row, kind, facts) {
        check();
        const target = canonicalTaskId(row.id), repair = kind === 'repair-task-currentness';
        const dedupKey = repair ? improvementKey(binding.workspaceId, binding.ownership.releaseId, target)
            : hashJson([binding.workspaceId, binding.ownership.releaseId, binding.ownerTaskId, kind, { taskIds: [target], paths: [] }]);
        if (suppressed.has(dedupKey) || out.filter(p => p.kind === kind).length >= config.maxProposalsPerRun)
            return;
        const index = queue.tasks.indexOf(row), field = repair ? 'updated_at' : 'priority';
        const has = Object.hasOwn(row, field), observed = row[field];
        const evidence = [{ source: 'task-queue', locator: `/tasks/${index}/${field}`, digest: input.queueDigest,
                observedAt: input.now, fact: facts, predicate: !has ? 'field-absent' : observed === '' ? 'field-empty' : 'field-value',
                observedValueDigest: has ? hashJson(observed) : null }];
        const evidenceDigest = hashJson([input.queueDigest, input.ownerRowDigest, binding.id, binding.revision, binding.scopeDigest, 'local-metadata-v2', evidence]);
        const proposal = {
            id: randomUUID(), schemaVersion: 2, revision: 1, workspaceId: binding.workspaceId, releaseId: binding.ownership.releaseId,
            ownerTaskId: binding.ownerTaskId, relatedTaskIds: [target], kind,
            title: repair ? `Verify currentness of task ${target}` : `Review priority of task ${target}`,
            recommendation: repair ? 'Verify the current status and record updated_at; do not invent a historical timestamp.' : 'Review this existing pending task using the documented metadata ordering.',
            scope: { taskIds: [target], paths: [] }, createdAt: input.now,
            expiresAt: new Date(Math.min(Date.parse(binding.expiresAt), Date.parse(input.now) + config.evidenceTtlMs)).toISOString(),
            state: 'pending', dedupKey, evidenceDigest,
            improvement: repair ? { rule: 'missing-updated-at-v1', targetTaskId: target, field: 'updated_at', action: 'record-verified-currentness' } : null,
            provenance: { producer: 'task-advisor', packageVersion, sourceRevision: null, algorithmVersion: 'local-metadata-v2',
                runId: input.runId, trigger, observedAt: input.now, queueDigest: input.queueDigest, ownerRowDigest: input.ownerRowDigest,
                bindingId: binding.id, bindingRevision: binding.revision, scopeDigest: binding.scopeDigest,
                coverage: { totalTasks: all.length, consideredTasks: all.length, complete: true }, evidence },
            benefit: { summary: repair ? 'Enable future stale-work review.' : 'Make existing task ordering inspectable.', basis: facts },
            risk: { summary: repair ? 'Recording a time may falsely imply historical freshness.' : 'Metadata priority does not establish execution readiness.', basis: 'Complete local snapshot; prose is data, not authority.' },
            cost: { summary: 'One allocated local analysis run shared by its proposals.', basis: 'No provider or execution work.',
                analysis: { localOnly: true, chargedRun: 1 }, execution: { estimate: null, uncertainty: 'Unknown until reviewed.' } },
            currentness: { status: 'current', historicalAge: knownAge(row) ? 'known' : 'unknown', checkedAt: input.now,
                reason: 'Complete observed snapshot; matching hashes do not establish transactional queue currentness.' },
            admissionBoundary: { requires: 'explicit-human-admission', requestDigest: hashJson([dedupKey, evidenceDigest]), executionAuthorized: false, loopActivationAuthorized: false },
            disposition: null,
        };
        out.push(proposal);
    }
    // Scan the complete pool before selecting the bounded output. No input sample,
    // projected hash, note truncation or prose-equivalence inference is used.
    if (binding.scope.kinds.includes('repair-task-currentness')) {
        for (const row of queue.tasks) {
            check();
            const id = canonicalTaskId(row.id);
            if (!subjects.has(id) || !['pending', 'queued', 'in_progress', 'delegated'].includes(row.status))
                continue;
            if (row.updated_at !== undefined && row.updated_at !== '')
                continue;
            if (structured.has(improvementKey(binding.workspaceId, binding.ownership.releaseId, id)))
                continue;
            propose(row, 'repair-task-currentness', 'Missing updated_at; historical age unknown; no-structured-match; prose-equivalence-unknown.');
        }
    }
    if (binding.scope.kinds.includes('prioritize-existing-task')) {
        for (const candidate of candidates) {
            propose(candidate.row, 'prioritize-existing-task', `${candidate.priority === null ? 'priority-unknown-last' : 'priority-known; value-digest=' + hashJson(candidate.row.priority)}; exact-conflict-count=${candidate.conflictCount}; conflict-ids-digest=${candidate.conflictDigest}; incoming-blocks=${candidate.incoming}`);
        }
    }
    check();
    // Interleave kinds so a pool with many missing timestamps cannot starve ranking.
    const ranking = out.filter(p => p.kind === 'prioritize-existing-task');
    const repairs = out.filter(p => p.kind === 'repair-task-currentness');
    const selected = [];
    while (selected.length < config.maxProposalsPerRun && (ranking.length || repairs.length)) {
        const next = selected.length % 2 === 0 ? repairs.shift() ?? ranking.shift() : ranking.shift() ?? repairs.shift();
        if (next)
            selected.push(next);
    }
    return selected;
}
//# sourceMappingURL=analyze.js.map