#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AdvisorError, BUILD_ENVELOPE, LIMITS, canonicalTaskId, defaultConfigV2, exactKeysV2, hashJson, ownerEligibility, parseJsonV2, recordV2, requireV2, textV2, uintV2, uuidV2, validateAnalysisBindingV2, validateConfigV2, validateStore, } from './contracts.js';
import { AdvisorStore, assertPath, canonicalWorkspace, commandResult, readBoundedFile, readQueue, runtimeCapability, storageError, } from './store.js';
import { analyzeReserved } from './analyze.js';
import { boundedMeasure, boundedTick, ensureHost, stopHost } from './host.js';
const USAGE = `Aigentry Advisor — bounded local metadata proposals; admission unavailable.
All commands require --workspace ABS. Read commands accept --json.
  status | list | show ID | start | stop --if-revision N --request-id UUID
  enable | disable --if-revision N --request-id UUID
  config --if-revision N --request-id UUID --json-file FILE
  bind --task ID --if-revision N --request-id UUID --json-file FILE
  binding show | binding check --json-file FILE
  binding revoke --if-revision N --request-id UUID
  tick --trigger manual|host
  review ID --if-revision N --request-id UUID --decision reject|defer --reason TEXT [--until UTC]
  admission-request ID --if-revision N --request-id UUID
  measure [--limits-file FILE]
No command creates a task, changes the queue or activates Task Loop.
`;
function parseArgs(argv) {
    const rest = [...argv], first = rest.shift();
    requireV2(first, 'command-required');
    const command = first === 'binding' ? first + ' ' + String(rest.shift()) : first;
    const forms = {
        status: [], list: [], show: [], start: [], stop: ['if-revision', 'request-id'],
        enable: ['if-revision', 'request-id'], disable: ['if-revision', 'request-id'],
        config: ['if-revision', 'request-id', 'json-file'], bind: ['task', 'if-revision', 'request-id', 'json-file'],
        'binding show': [], 'binding check': ['json-file'], 'binding revoke': ['if-revision', 'request-id'],
        tick: ['trigger', 'host-token', 'host-generation'], review: ['if-revision', 'request-id', 'decision', 'reason', 'until'],
        'admission-request': ['if-revision', 'request-id'], measure: ['limits-file'], admit: [],
    };
    requireV2(Object.hasOwn(forms, command), 'unknown-command');
    const id = ['show', 'review', 'admission-request', 'admit'].includes(command) ? rest.shift() ?? null : null;
    if (['show', 'review', 'admission-request', 'admit'].includes(command))
        uuidV2(id);
    const values = Object.create(null), flags = new Set();
    while (rest.length) {
        const token = rest.shift();
        requireV2(token.startsWith('--'), 'unknown-argument');
        const key = token.slice(2);
        requireV2(!Object.hasOwn(values, key) && !flags.has(key), 'duplicate-argument');
        if (key === 'json' || key === 'internal-tick' && command === 'tick' || key === 'internal-measure' && command === 'measure') {
            flags.add(key);
            continue;
        }
        requireV2(['workspace', 'release-id', ...forms[command]].includes(key), 'unknown-argument');
        const value = rest.shift();
        requireV2(value !== undefined && !value.startsWith('--'), 'missing-argument');
        values[key] = value;
    }
    requireV2(values.workspace, 'explicit-workspace-required');
    const required = forms[command].filter(key => !['until', 'limits-file', 'host-token', 'host-generation'].includes(key));
    for (const key of required)
        requireV2(values[key] !== undefined, 'missing-argument:' + key);
    if (values['if-revision'] !== undefined)
        revision(values['if-revision']);
    if (values['request-id'])
        values['request-id'] = uuidV2(values['request-id']);
    if (command === 'tick') {
        requireV2(['manual', 'host'].includes(values.trigger), 'invalid-trigger');
        requireV2(Boolean(values['host-token']) === Boolean(values['host-generation']), 'invalid-host-fence');
        if (values['host-token']) {
            uuidV2(values['host-token']);
            revision(values['host-generation']);
        }
        requireV2(!flags.has('internal-tick') || typeof process.send === 'function', 'internal-tick-requires-supervisor');
    }
    if (command === 'review')
        requireV2(['reject', 'defer'].includes(values.decision), 'invalid-decision');
    requireV2(!flags.has('internal-measure') || typeof process.send === 'function', 'internal-measure-requires-supervisor');
    return { command, id, values, flags };
}
function revision(value) { requireV2(/^(0|[1-9][0-9]*)$/.test(value), 'invalid-revision'); return uintV2(Number(value)); }
function jsonFile(file) { return parseJsonV2(readBoundedFile(path.resolve(file), LIMITS.inputBytes)).value; }
function tuple(args, view) {
    if (args.values['release-id'] !== undefined)
        requireV2(view.binding && view.binding.ownership.releaseId === args.values['release-id'], 'release-mismatch');
}
function projectCurrentness(p, view, digest, now) {
    const out = structuredClone(p), b = view.binding;
    if (out.state === 'rejected')
        return out;
    const reason = now >= Date.parse(p.expiresAt) ? 'evidence-expired'
        : !b || b.revokedAt !== null || view.suspended || b.revision !== p.provenance.bindingRevision ? 'binding-fenced'
            : digest === null ? 'queue-unavailable' : digest !== p.provenance.queueDigest ? 'queue-changed' : null;
    if (reason) {
        out.currentness = { ...out.currentness, status: digest === null ? 'unknown' : 'stale', reason, checkedAt: new Date(now).toISOString() };
        if (digest !== null)
            out.state = 'stale';
    }
    else if (out.state === 'deferred' && out.disposition?.deferredUntil && Date.parse(out.disposition.deferredUntil) <= now)
        out.currentness.reason = 'defer-due-awaiting-analysis';
    return out;
}
function legacyRead(workspace, args) {
    const file = path.join(workspace.path, 'state/task-advisor/store.json');
    try {
        fs.lstatSync(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    const raw = parseJsonV2(readBoundedFile(file, LIMITS.storeBytes), { ...BUILD_ENVELOPE, maxInputBytes: LIMITS.storeBytes }).value;
    const checked = validateStore(raw, { workspaceId: workspace.id, now: new Date().toISOString() });
    requireV2(checked.ok, 'legacy-store-invalid', 5);
    requireV2(['status', 'list', 'show'].includes(args.command), 'legacy-store-migration-required', 4);
    const proposals = checked.value.proposals;
    return commandResult(null, 'read', checked.value.revision, 'legacy-store-migration-required', {
        effective: 'blocked', desired: checked.value.config.enabled, legacy: true,
        ...(args.command === 'list' ? { proposals } : args.command === 'show' ? { proposal: proposals.find(p => p.id === args.id) ?? null } : { storeHealth: 'legacy', admission: 'authority-unavailable' }),
    });
}
async function tick(workspace, args) {
    const store = await AdvisorStore.open(workspace, true);
    try {
        let view = store.readView();
        tuple(args, view);
        store.maintain(randomUUID(), view.meta.storeRevision);
        view = store.readView();
        // Observe continuity/currentness even when disabled or out of budget. This is
        // bounded metadata maintenance, never unreserved ranking/discovery.
        if (!view.binding)
            return store.noWork(randomUUID(), view.meta.storeRevision, view.meta.desiredEnabled ? 'no-binding' : 'disabled');
        const snapshot = readQueue(workspace, view.meta.config);
        store.observe(randomUUID(), view.meta.storeRevision, snapshot);
        view = store.readView();
        const trigger = args.values.trigger;
        const hostFence = args.values['host-token'] ? { token: args.values['host-token'], generation: revision(args.values['host-generation']) } : null;
        const reservationId = randomUUID();
        const reserved = store.reserve(reservationId, view.meta.storeRevision, snapshot, trigger, hostFence);
        if (reserved.reason !== 'reserved')
            return reserved;
        // Reconstruct only from the committed store record, never CLI JSON.
        const committed = store.readView(), run = committed.runs.find(run => run.id === reserved.run.id);
        requireV2(run?.status === 'reserved' && committed.binding, 'reservation-unavailable', 3);
        const input = { schemaVersion: 2, queue: snapshot.queue, queueDigest: snapshot.digest, rawByteCount: snapshot.bytes,
            ownerRowDigest: run.ownerRowDigest, binding: committed.binding, bindingRevision: run.bindingRevision,
            now: new Date(run.startedAt).toISOString(), runId: run.id };
        const pkg = recordV2(jsonFile(fileURLToPath(new URL('../../../package.json', import.meta.url))));
        const suppressed = new Set(committed.proposals.filter(p => p.state === 'rejected'
            || p.disposition?.deferredUntil && Date.parse(p.disposition.deferredUntil) > Date.now()).map(p => p.dedupKey));
        const proposals = analyzeReserved(input, committed.meta.config, trigger, textV2(pkg.version), run.deadline, suppressed);
        const fresh = readQueue(workspace, committed.meta.config);
        return store.publish(randomUUID(), run, proposals, fresh);
    }
    finally {
        store.close();
    }
}
function measure(workspace, args) {
    const file = path.join(workspace.path, 'state/task-queue.json'), stat = assertPath(file, false);
    if (!args.values['limits-file'])
        return commandResult(null, 'read', 0, stat.size > LIMITS.inputBytes ? 'default-overflow' : 'stat-only', { rawBytes: stat.size, defaultMaxInputBytes: LIMITS.inputBytes, coverage: 'incomplete', complete: false });
    const input = recordV2(jsonFile(args.values['limits-file']));
    exactKeysV2(input, [...Object.keys(BUILD_ENVELOPE), 'maxRssBytes', 'growthTarget']);
    const config = validateConfigV2({ ...defaultConfigV2(), ...Object.fromEntries(Object.keys(BUILD_ENVELOPE).map(key => [key, input[key]])) });
    const maxRss = uintV2(input.maxRssBytes, 64 * 1024 * 1024, 1), growth = recordV2(input.growthTarget);
    exactKeysV2(growth, ['bytes', 'tasks']);
    uintV2(growth.bytes, BUILD_ENVELOPE.maxInputBytes, 1);
    uintV2(growth.tasks, BUILD_ENVELOPE.maxTasks, 1);
    const start = performance.now();
    try {
        const snapshot = readQueue(workspace, config), elapsedMs = performance.now() - start;
        const peakRss = process.resourceUsage().maxRSS * 1024;
        requireV2(peakRss <= maxRss && elapsedMs <= config.maxCpuWallMs, 'measurement-resource-limit');
        return commandResult(null, 'read', 0, 'complete-measurement', { rawBytes: snapshot.bytes, ...snapshot.metrics,
            rows: snapshot.queue.tasks.length + (snapshot.queue.completed?.length ?? 0), elapsedMs, peakRssBytes: peakRss,
            queueDigest: snapshot.digest, coverage: 'complete', complete: true, growthTarget: growth, buildEnvelope: BUILD_ENVELOPE,
            qualification: 'provisional-unmeasured-envelope', schemaErrors: [] });
    }
    catch (error) {
        const reason = error instanceof AdvisorError ? error.reason : 'measurement-error';
        process.exitCode = error instanceof AdvisorError ? error.exit : 5;
        return commandResult(null, 'invalid', 0, reason, { rawBytes: stat.size, coverage: 'incomplete', complete: false,
            elapsedMs: performance.now() - start, peakRssBytes: process.resourceUsage().maxRSS * 1024, schemaErrors: [reason] });
    }
}
export async function executeAdvisor(argv) {
    const args = parseArgs(argv), workspace = canonicalWorkspace(args.values.workspace);
    const requestId = args.values['request-id'] ?? null;
    if (args.values['release-id'] !== undefined && ['measure', 'start', 'stop', 'binding check'].includes(args.command)) {
        const reader = await AdvisorStore.open(workspace);
        try {
            tuple(args, reader.readView());
        }
        finally {
            reader.close();
        }
    }
    if (args.command === 'measure') {
        if (args.values['limits-file'] && !args.flags.has('internal-measure')) {
            const measured = await boundedMeasure(workspace, path.resolve(args.values['limits-file']), args.values['release-id']);
            process.exitCode = measured.exit;
            return measured.result;
        }
        return measure(workspace, args);
    }
    if (args.command === 'binding check') {
        const checked = validateAnalysisBindingV2(jsonFile(args.values['json-file']));
        requireV2(checked.ok, checked.ok ? '' : checked.reason.message);
        requireV2(checked.value.workspaceId === workspace.id, 'workspace-mismatch');
        return commandResult(null, 'read', checked.value.revision, 'structurally-valid-not-authority', { binding: checked.value });
    }
    if (args.command === 'admit')
        throw new AdvisorError('authority-unavailable', 4);
    const legacy = legacyRead(workspace, args);
    if (legacy)
        return legacy;
    if (args.command === 'tick') {
        if (args.flags.has('internal-tick'))
            return tick(workspace, args);
        const result = await boundedTick(workspace, args.values.trigger, null, args.values['release-id']);
        process.exitCode = result.exit;
        return result.result;
    }
    if (args.command === 'start') {
        const result = await ensureHost(workspace);
        if (result.outcome === 'unavailable')
            process.exitCode = 4;
        return result;
    }
    if (args.command === 'stop')
        return stopHost(workspace, requestId, revision(args.values['if-revision']));
    const mutation = ['enable', 'disable', 'config', 'bind', 'binding revoke', 'review'].includes(args.command);
    const store = await AdvisorStore.open(workspace, mutation);
    try {
        const view = store.readView(), now = Date.now();
        tuple(args, view);
        const expected = args.values['if-revision'] === undefined ? 0 : revision(args.values['if-revision']);
        if (args.command === 'enable' || args.command === 'disable')
            return store.preference(requestId, expected, args.command === 'enable');
        if (args.command === 'config')
            return store.configure(requestId, expected, jsonFile(args.values['json-file']));
        if (args.command === 'bind') {
            const id = canonicalTaskId(args.values.task), payload = jsonFile(args.values['json-file']);
            const replay = store.lookup(requestId, ['bind', expected, id, payload]);
            return replay ?? store.bind(requestId, expected, id, payload, readQueue(workspace, view.meta.config));
        }
        if (args.command === 'binding revoke')
            return store.revoke(requestId, expected);
        if (args.command === 'review')
            return store.review(requestId, args.id, expected, args.values.decision, args.values.reason, args.values.until ?? null);
        if (args.command === 'binding show')
            return commandResult(null, 'read', view.binding?.revision ?? 0, 'binding', { binding: view.binding, suspended: view.suspended });
        let digest = null, eligibility = 'unknown', queueIssue = null;
        try {
            const snapshot = readQueue(workspace, view.meta.config);
            digest = snapshot.digest;
            if (view.binding)
                eligibility = ownerEligibility(snapshot.queue, view.binding);
        }
        catch (error) {
            queueIssue = error instanceof AdvisorError ? error.reason : 'queue-unavailable';
        }
        const proposals = view.proposals.map(p => projectCurrentness(p, view, digest, Math.max(now, view.meta.clockHighWater)));
        if (args.command === 'list')
            return commandResult(null, 'read', view.meta.storeRevision, 'proposals', { proposals });
        if (args.command === 'show' || args.command === 'admission-request') {
            const proposal = proposals.find(p => p.id === args.id);
            requireV2(proposal, 'proposal-not-found');
            if (args.command === 'show')
                return commandResult(null, 'read', proposal.revision, 'proposal', { proposal });
            requireV2(proposal.revision === expected, 'revision-conflict', 3);
            return commandResult(requestId, 'read', proposal.revision, 'export-only-authority-unavailable', { admissionRequest: {
                    schemaVersion: 2, requestId, workspaceId: workspace.id, releaseId: proposal.releaseId, proposalId: proposal.id,
                    proposalRevision: proposal.revision, proposalDigest: hashJson(proposal), ownerTaskId: proposal.ownerTaskId,
                    scope: proposal.scope, evidenceDigest: proposal.evidenceDigest, expiresAt: proposal.expiresAt,
                    requestedAction: 'admit-proposal', currentness: proposal.currentness, executionAuthorized: false, loopActivationAuthorized: false
                }, proposal });
        }
        const capability = await runtimeCapability(workspace), binding = view.binding;
        const bindingActive = binding && !view.suspended && binding.revokedAt === null && now >= Date.parse(binding.notBefore) && now < Date.parse(binding.expiresAt);
        const reason = !view.meta.desiredEnabled ? 'disabled' : capability.qualification.status === 'unsupported-runtime' ? 'unsupported-runtime'
            : capability.qualification.status === 'durability-unverified' ? 'durability-unverified' : !binding ? 'no-binding'
                : now < view.meta.clockHighWater ? 'clock-rollback' : !bindingActive ? 'binding-inactive' : queueIssue ?? (eligibility !== 'eligible' ? 'owner-ineligible' : 'ready');
        return commandResult(null, 'read', view.meta.configRevision, reason, {
            workspaceId: workspace.id, desired: view.meta.desiredEnabled ? 'on' : 'off', origin: view.meta.origin,
            effective: !view.meta.desiredEnabled ? 'disabled' : reason === 'ready' ? 'ready' : 'blocked',
            storeRevision: view.meta.storeRevision, config: view.meta.config, binding, suspended: view.suspended, capability,
            remaining: binding ? { total: Math.max(0, binding.budget.maxRunsTotal - view.allocationTotal),
                allocationDay: Math.max(0, binding.budget.maxRunsPerUtcDay - view.allocationDay), workspaceDay: Math.max(0, view.meta.config.maxRunsPerUtcDay - view.workspaceDay) } : null,
            storeHealth: view.meta.storeRevision === 0 ? 'absent' : 'readable', lastOutcome: view.meta.lastOutcome,
            automatic: view.host.token && view.host.expiresAt > now ? 'running' : 'degraded', host: view.host,
            pendingCount: proposals.filter(p => p.state === 'pending').length, queueIssue, admission: 'authority-unavailable',
        });
    }
    finally {
        store.close();
    }
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
        process.stdout.write(USAGE);
        return;
    }
    let result;
    try {
        result = await executeAdvisor(argv);
    }
    catch (error) {
        const failure = error instanceof AdvisorError ? error : storageError(error);
        const requestIndex = argv.indexOf('--request-id');
        result = commandResult(requestIndex < 0 ? null : argv[requestIndex + 1] ?? null, failure.exit === 4 ? 'unavailable' : 'error', 0, failure.reason);
        process.exitCode = failure.exit;
    }
    process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
    void main();
//# sourceMappingURL=cli.js.map