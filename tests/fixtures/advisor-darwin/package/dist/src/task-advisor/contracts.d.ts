/** Pure, structural contracts. Validation never authenticates an actor or receipt.
 * Limits are provisional validation bounds, not measured production capacity.
 * Only undefined denotes absent storage/config; null is malformed input.
 */
export declare const LIMITS: Readonly<{
    inputBytes: number;
    tasks: 10000;
    cpuWallMs: 1000;
    runsPerUtcDay: 60;
    proposalsPerRun: 3;
    storeBytes: number;
    minIntervalMs: 60000;
    text: 16384;
    shortText: 256;
    list: 10000;
    depth: 16;
    nodes: 500000;
    evidenceTtlMs: 86400000;
    maxEvidenceTtlMs: number;
    maxDeferMs: number;
}>;
export type RefusalCode = 'invalid-shape' | 'unknown-field' | 'unknown-version' | 'invalid-value' | 'input-limit' | 'duplicate-id' | 'missing-reference' | 'workspace-mismatch' | 'analysis-binding-unresolved';
export interface Refusal {
    code: RefusalCode;
    path: string;
    message: string;
}
export type ValidationResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: Refusal;
};
export interface ValidationContext {
    workspaceId: string;
    now: string;
    /** Optional complete reference set. This is not an analysis authorization. */
    taskIds?: readonly string[];
}
type Check<T> = (value: unknown, path: string) => T;
type Shape = Record<string, Check<unknown>>;
type Checked<S extends Shape> = {
    [K in keyof S]: ReturnType<S[K]>;
};
declare const configCheck: Check<Checked<{
    enabled: Check<boolean>;
    origin: Check<"default" | "user">;
    revision: Check<number>;
    minIntervalMs: Check<number>;
    maxInputBytes: Check<number>;
    maxTasks: Check<number>;
    maxRunsPerUtcDay: Check<number>;
    maxCpuWallMs: Check<number>;
    maxProposalsPerRun: Check<number>;
    maxStoreBytes: Check<number>;
}>>;
export type AdvisorConfig = ReturnType<typeof configCheck>;
export declare function createDefaultConfig(): AdvisorConfig;
declare function config(value: unknown, path: string): AdvisorConfig;
declare const scopeCheck: Check<Checked<{
    taskIds: Check<string[]>;
    paths: Check<string[]>;
}>>;
export type ProposalScope = ReturnType<typeof scopeCheck>;
declare const evidenceCheck: Check<Checked<{
    source: Check<"task-queue">;
    locator: Check<string>;
    digest: Check<string>;
    observedAt: Check<string>;
    fact: Check<string>;
}>>;
export type Evidence = ReturnType<typeof evidenceCheck>;
declare const proposalCheck: Check<Checked<{
    id: Check<string>;
    schemaVersion: Check<1>;
    revision: Check<number>;
    workspaceId: Check<string>;
    ownerTaskId: Check<string>;
    relatedTaskIds: Check<string[]>;
    kind: Check<"prioritize-existing-task">;
    title: Check<string>;
    recommendation: Check<string>;
    scope: Check<Checked<{
        taskIds: Check<string[]>;
        paths: Check<string[]>;
    }>>;
    createdAt: Check<string>;
    expiresAt: Check<string>;
    state: Check<"pending" | "deferred" | "rejected" | "stale" | "admitted">;
    dedupKey: Check<string>;
    evidenceDigest: Check<string>;
    provenance: Check<Checked<{
        producer: Check<"task-advisor">;
        packageVersion: Check<string>;
        sourceRevision: Check<string | null>;
        algorithmVersion: Check<"local-ranking-v1">;
        runId: Check<string>;
        trigger: Check<"manual" | "reconcile">;
        observedAt: Check<string>;
        queueDigest: Check<string>;
        coverage: Check<Checked<{
            totalTasks: Check<number>;
            consideredTasks: Check<number>;
            complete: Check<boolean>;
        }>>;
        evidence: Check<Checked<{
            source: Check<"task-queue">;
            locator: Check<string>;
            digest: Check<string>;
            observedAt: Check<string>;
            fact: Check<string>;
        }>[]>;
    }>>;
    benefit: Check<Checked<{
        summary: Check<string>;
        basis: Check<string>;
    }>>;
    risk: Check<Checked<{
        summary: Check<string>;
        basis: Check<string>;
    }>>;
    cost: Check<Checked<{
        summary: Check<string>;
        basis: Check<string>;
        analysis: Check<Checked<{
            localOnly: Check<true>;
            chargedRun: Check<1>;
        }>>;
        execution: Check<Checked<{
            estimate: Check<string | null>;
            uncertainty: Check<string>;
        }>>;
    }>>;
    currentness: Check<Checked<{
        status: Check<"stale" | "current" | "unknown">;
        checkedAt: Check<string>;
        reason: Check<string>;
    }>>;
    admissionBoundary: Check<Checked<{
        requires: Check<"explicit-human-admission">;
        requestDigest: Check<string>;
        executionAuthorized: Check<false>;
        loopActivationAuthorized: Check<false>;
    }>>;
    disposition: Check<Checked<{
        decisionId: Check<string>;
        reason: Check<string>;
        deferredUntil: Check<string | null>;
    }> | null>;
}>>;
export type Proposal = ReturnType<typeof proposalCheck>;
declare const decisionCheck: Check<Checked<{
    id: Check<string>;
    proposalId: Check<string>;
    proposalRevision: Check<number>;
    requestId: Check<string>;
    kind: Check<"reject" | "defer">;
    reason: Check<string>;
    until: Check<string | null>;
    actor: Check<Checked<{
        id: Check<string>;
        verified: Check<boolean>;
    }>>;
    at: Check<string>;
}>>;
/** actor.verified is stored data, never proof of human authority. */
export type Decision = ReturnType<typeof decisionCheck>;
declare const receiptCheck: Check<Checked<{
    id: Check<string>;
    requestId: Check<string>;
    proposalId: Check<string>;
    proposalRevision: Check<number>;
    requestDigest: Check<string>;
    taskId: Check<string>;
    authorityRef: Check<string>;
    committedAt: Check<string>;
}>>;
/** Structural receipt only. An independent trusted adapter must verify authority. */
export type Receipt = ReturnType<typeof receiptCheck>;
declare const storeCheck: Check<Checked<{
    schemaVersion: Check<1>;
    workspaceId: Check<string>;
    revision: Check<number>;
    config: typeof config;
    budget: Check<Checked<{
        utcDay: Check<string>;
        chargedRuns: Check<number>;
        lastStartedAt: Check<string | null>;
    }>>;
    run: Check<Checked<{
        id: Check<string>;
        ownerPid: Check<number>;
        startedAt: Check<string>;
        configRevision: Check<number>;
        snapshotDigest: Check<string>;
        status: Check<"reserved">;
    }> | null>;
    observations: Check<Checked<{
        lastSnapshotDigest: Check<string | null>;
        lastSuccessfulAt: Check<string | null>;
        lastOutcome: Check<string>;
        retryAfter: Check<string | null>;
    }>>;
    proposals: Check<Checked<{
        id: Check<string>;
        schemaVersion: Check<1>;
        revision: Check<number>;
        workspaceId: Check<string>;
        ownerTaskId: Check<string>;
        relatedTaskIds: Check<string[]>;
        kind: Check<"prioritize-existing-task">;
        title: Check<string>;
        recommendation: Check<string>;
        scope: Check<Checked<{
            taskIds: Check<string[]>;
            paths: Check<string[]>;
        }>>;
        createdAt: Check<string>;
        expiresAt: Check<string>;
        state: Check<"pending" | "deferred" | "rejected" | "stale" | "admitted">;
        dedupKey: Check<string>;
        evidenceDigest: Check<string>;
        provenance: Check<Checked<{
            producer: Check<"task-advisor">;
            packageVersion: Check<string>;
            sourceRevision: Check<string | null>;
            algorithmVersion: Check<"local-ranking-v1">;
            runId: Check<string>;
            trigger: Check<"manual" | "reconcile">;
            observedAt: Check<string>;
            queueDigest: Check<string>;
            coverage: Check<Checked<{
                totalTasks: Check<number>;
                consideredTasks: Check<number>;
                complete: Check<boolean>;
            }>>;
            evidence: Check<Checked<{
                source: Check<"task-queue">;
                locator: Check<string>;
                digest: Check<string>;
                observedAt: Check<string>;
                fact: Check<string>;
            }>[]>;
        }>>;
        benefit: Check<Checked<{
            summary: Check<string>;
            basis: Check<string>;
        }>>;
        risk: Check<Checked<{
            summary: Check<string>;
            basis: Check<string>;
        }>>;
        cost: Check<Checked<{
            summary: Check<string>;
            basis: Check<string>;
            analysis: Check<Checked<{
                localOnly: Check<true>;
                chargedRun: Check<1>;
            }>>;
            execution: Check<Checked<{
                estimate: Check<string | null>;
                uncertainty: Check<string>;
            }>>;
        }>>;
        currentness: Check<Checked<{
            status: Check<"stale" | "current" | "unknown">;
            checkedAt: Check<string>;
            reason: Check<string>;
        }>>;
        admissionBoundary: Check<Checked<{
            requires: Check<"explicit-human-admission">;
            requestDigest: Check<string>;
            executionAuthorized: Check<false>;
            loopActivationAuthorized: Check<false>;
        }>>;
        disposition: Check<Checked<{
            decisionId: Check<string>;
            reason: Check<string>;
            deferredUntil: Check<string | null>;
        }> | null>;
    }>[]>;
    decisions: Check<Checked<{
        id: Check<string>;
        proposalId: Check<string>;
        proposalRevision: Check<number>;
        requestId: Check<string>;
        kind: Check<"reject" | "defer">;
        reason: Check<string>;
        until: Check<string | null>;
        actor: Check<Checked<{
            id: Check<string>;
            verified: Check<boolean>;
        }>>;
        at: Check<string>;
    }>[]>;
    admissionReceipts: Check<Checked<{
        id: Check<string>;
        requestId: Check<string>;
        proposalId: Check<string>;
        proposalRevision: Check<number>;
        requestDigest: Check<string>;
        taskId: Check<string>;
        authorityRef: Check<string>;
        committedAt: Check<string>;
    }>[]>;
}>>;
export type AdvisorStore = ReturnType<typeof storeCheck>;
export declare function validateConfig(input: unknown): ValidationResult<AdvisorConfig>;
export declare function validateProposal(input: unknown, binding: ValidationContext): ValidationResult<Proposal>;
export declare function validateDecision(input: unknown, binding: ValidationContext): ValidationResult<Decision>;
export declare function validateReceipt(input: unknown, binding: ValidationContext): ValidationResult<Receipt>;
export declare function createDefaultStore(binding: ValidationContext): ValidationResult<AdvisorStore>;
export declare function validateStore(input: unknown, binding: ValidationContext): ValidationResult<AdvisorStore>;
/** No reviewed binding/queue schema exists yet. No input can authorize analysis.
 * Do not call store/proposal validation as a substitute for this gate.
 */
export declare function validateAnalysisInput(input: unknown, binding: ValidationContext, analysisBinding: unknown): ValidationResult<never>;
export declare class AdvisorError extends Error {
    readonly reason: string;
    readonly exit: 2 | 3 | 4 | 5;
    constructor(reason: string, exit?: 2 | 3 | 4 | 5);
}
export declare function requireV2(condition: unknown, reason: string, exit?: 2 | 3 | 4 | 5): asserts condition;
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type Kind = 'prioritize-existing-task' | 'repair-task-currentness';
export interface InputLimits {
    maxInputBytes: number;
    maxTasks: number;
    maxFieldChars: number;
    maxNodes: number;
    maxDepth: number;
    maxCpuWallMs: number;
}
/** Provisional source envelope; NOT a measured capacity/durability claim. */
export declare const BUILD_ENVELOPE: Readonly<InputLimits>;
export interface ConfigV2 extends InputLimits {
    minIntervalMs: number;
    maxRunsPerUtcDay: number;
    maxProposalsPerRun: number;
    maxStoreBytes: number;
    evidenceTtlMs: number;
}
export declare function defaultConfigV2(): ConfigV2;
export declare function recordV2(value: unknown): Record<string, unknown>;
export declare function exactKeysV2(value: Record<string, unknown>, required: readonly string[], optional?: readonly string[]): void;
export declare function uintV2(value: unknown, max?: number, min?: number): number;
export declare function textV2(value: unknown, max?: number): string;
export declare function uuidV2(value: unknown): string;
export declare function utcV2(value: unknown): string;
export declare function digestV2(value: unknown): string;
export declare function canonicalTaskId(value: unknown): string;
export declare function canonicalJson(value: unknown): string;
export declare function hashBytes(value: Uint8Array | string): string;
export declare function hashJson(value: unknown): string;
export interface JsonMetrics {
    nodes: number;
    depth: number;
    maxFieldChars: number;
    parsedBytes: number;
}
/** Recursive-descent JSON parser: duplicate decoded keys are rejected at each
 * object, including escaped aliases. JSON.parse is used only on scalar tokens. */
export declare function parseJsonV2(bytes: Uint8Array, limits?: InputLimits): {
    value: Json;
    metrics: JsonMetrics;
};
export interface TaskRow {
    [key: string]: Json;
    id: string | number;
    status: string;
    desc: string;
}
export interface QueueV2 {
    [key: string]: Json | TaskRow[] | undefined;
    tasks: TaskRow[];
    completed?: TaskRow[];
}
export declare function queueV2(value: unknown, limits?: InputLimits): QueueV2;
export declare function validateConfigV2(input: unknown): ConfigV2;
declare const bindingV2Check: Check<Checked<{
    schemaVersion: Check<2>;
    id: Check<string>;
    revision: Check<number>;
    workspaceId: Check<string>;
    ownerTaskId: Check<string>;
    scope: Check<Checked<{
        mode: Check<"local-queue-metadata">;
        queuePath: Check<"state/task-queue.json">;
        subjectTaskIds: Check<string[]>;
        kinds: Check<("prioritize-existing-task" | "repair-task-currentness")[]>;
    }>>;
    scopeDigest: Check<string>;
    ownership: Check<Checked<{
        workspaceId: Check<string>;
        releaseId: Check<string>;
    }>>;
    createdAt: Check<string>;
    notBefore: Check<string>;
    expiresAt: Check<string>;
    revokedAt: Check<string | null>;
    budget: Check<Checked<{
        allocationId: Check<string>;
        maxRunsTotal: Check<number>;
        maxRunsPerUtcDay: Check<number>;
        maxWallMs: Check<number>;
    }>>;
    provenance: Check<Checked<{
        requestId: Check<string>;
        payloadDigest: Check<string>;
        source: Check<"local-cli">;
        authentication: Check<"not-established">;
    }>>;
}>>;
export type AnalysisBindingV2 = ReturnType<typeof bindingV2Check>;
export declare function scopeDigestV2(binding: Pick<AnalysisBindingV2, 'ownerTaskId' | 'scope' | 'ownership'>): string;
export declare function validateAnalysisBindingV2(input: unknown): ValidationResult<AnalysisBindingV2>;
export declare function checkedBindingV2(input: unknown): AnalysisBindingV2;
export declare function ownerEligibility(queue: QueueV2, binding: AnalysisBindingV2): 'eligible' | 'suspended' | 'continuity-break';
export interface AnalysisInputV2 {
    schemaVersion: 2;
    queue: QueueV2;
    queueDigest: string;
    rawByteCount: number;
    ownerRowDigest: string;
    binding: AnalysisBindingV2;
    bindingRevision: number;
    now: string;
    runId: string;
}
export declare function validateAnalysisInputV2(input: unknown): ValidationResult<AnalysisInputV2>;
export interface EvidenceV2 {
    source: 'task-queue';
    locator: string;
    digest: string;
    observedAt: string;
    fact: string;
    predicate: 'field-absent' | 'field-empty' | 'field-value';
    observedValueDigest: string | null;
}
export interface ProposalV2 {
    id: string;
    schemaVersion: 2;
    revision: number;
    workspaceId: string;
    releaseId: string;
    ownerTaskId: string;
    relatedTaskIds: string[];
    kind: Kind;
    title: string;
    recommendation: string;
    scope: {
        taskIds: string[];
        paths: string[];
    };
    createdAt: string;
    expiresAt: string;
    state: 'pending' | 'deferred' | 'rejected' | 'stale';
    dedupKey: string;
    evidenceDigest: string;
    improvement: {
        rule: 'missing-updated-at-v1';
        targetTaskId: string;
        field: 'updated_at';
        action: 'record-verified-currentness';
    } | null;
    provenance: {
        producer: 'task-advisor';
        packageVersion: string;
        sourceRevision: null;
        algorithmVersion: 'local-metadata-v2';
        runId: string;
        trigger: 'manual' | 'host';
        observedAt: string;
        queueDigest: string;
        ownerRowDigest: string;
        bindingId: string;
        bindingRevision: number;
        scopeDigest: string;
        coverage: {
            totalTasks: number;
            consideredTasks: number;
            complete: true;
        };
        evidence: EvidenceV2[];
    };
    benefit: {
        summary: string;
        basis: string;
    };
    risk: {
        summary: string;
        basis: string;
    };
    cost: {
        summary: string;
        basis: string;
        analysis: {
            localOnly: true;
            chargedRun: 1;
        };
        execution: {
            estimate: null;
            uncertainty: string;
        };
    };
    currentness: {
        status: 'current' | 'stale' | 'unknown';
        historicalAge: 'unknown' | 'known';
        checkedAt: string;
        reason: string;
    };
    admissionBoundary: {
        requires: 'explicit-human-admission';
        requestDigest: string;
        executionAuthorized: false;
        loopActivationAuthorized: false;
    };
    disposition: {
        decisionId: string;
        reason: string;
        deferredUntil: string | null;
    } | null;
}
export declare function checkedProposalV2(input: unknown): ProposalV2;
export {};
