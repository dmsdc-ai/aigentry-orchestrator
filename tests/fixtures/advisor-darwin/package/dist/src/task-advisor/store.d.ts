import * as fs from 'node:fs';
import { AdvisorError, BUILD_ENVELOPE, type AnalysisBindingV2, type ConfigV2, type ProposalV2, type QueueV2, parseJsonV2 } from './contracts.js';
import { type MeasuredRuntimeFacts, type QualificationOutcome, type QualificationRecordV1 } from './qualification.js';
import { type StorageProvenanceFacts } from './storage-provenance.js';
export interface Workspace {
    path: string;
    id: string;
}
export interface Snapshot {
    queue: QueueV2;
    digest: string;
    bytes: number;
    metrics: ReturnType<typeof parseJsonV2>['metrics'];
}
export interface CommandResult {
    schemaVersion: 2;
    requestId: string | null;
    outcome: string;
    revision: number;
    reason: string;
    [key: string]: unknown;
}
export interface Meta {
    workspace: string;
    schema: 2;
    storeRevision: number;
    configRevision: number;
    desiredEnabled: boolean;
    origin: 'default' | 'user';
    clockHighWater: number;
    config: ConfigV2;
    lastOutcome: string;
    lastStartedAt: number;
    lastQueueDigest: string | null;
}
interface Run {
    id: string;
    generation: number;
    bindingRevision: number;
    configRevision: number;
    bindingId: string;
    queueDigest: string;
    ownerRowDigest: string;
    startedAt: number;
    deadline: number;
    status: 'reserved' | 'published' | 'interrupted' | 'discarded';
    proposalRevisions: Record<string, number>;
}
interface Lease {
    generation: number;
    token: string | null;
    heartbeat: number;
    expiresAt: number;
}
export interface StoreView {
    meta: Meta;
    binding: AnalysisBindingV2 | null;
    suspended: boolean;
    proposals: ProposalV2[];
    host: Lease;
    runs: Run[];
    allocationTotal: number;
    allocationDay: number;
    workspaceDay: number;
}
export declare function commandResult(requestId: string | null, outcome: string, revision: number, reason?: string, data?: Record<string, unknown>): CommandResult;
export declare function canonicalWorkspace(explicit: string): Workspace;
/** Reject every existing path component that is a symlink/junction or alias. */
export declare function assertPath(file: string, directory: boolean): fs.Stats;
export declare function readBoundedFile(file: string, cap: number): Buffer;
export declare function readQueue(workspace: Workspace, limits: ConfigV2 | typeof BUILD_ENVELOPE): Snapshot;
export interface RuntimeCapability {
    node: string;
    sqlite: string | null;
    platform: string;
    arch: string;
    osRelease: string;
    filesystemType: string;
    /** Measured provenance of the medium backing the store directory, for diagnostics.
     * A truthful `unknown` here is the normal state until a native helper is built. */
    storageProvenance: StorageProvenanceFacts;
    /** `qualified` only when a reviewed catalog record matches these measured facts. */
    substrate: 'qualified' | 'unavailable';
    durability: 'qualified' | 'durability-unverified';
    /** Exact match outcome: measured fields, missing gates and what a match attests. */
    qualification: QualificationOutcome;
    catalogRevision: number;
}
/** Measure the live runtime and the real storage location. Every field below comes
 * from the process or the filesystem; none of it is user-supplied or configurable. */
export declare function measuredRuntimeFacts(workspace: Workspace): Promise<MeasuredRuntimeFacts>;
export declare function runtimeCapability(workspace: Workspace): Promise<RuntimeCapability>;
/** All Advisor SQLite writes, including host leases, pass through this class. */
export declare class AdvisorStore {
    readonly workspace: Workspace;
    private db;
    private readonly writable;
    readonly file: string;
    private readonly reopenReadOnly;
    /** The reviewed record that qualified this writer. Null on every read-only open. */
    readonly qualification: QualificationRecordV1 | null;
    private constructor();
    static open(workspace: Workspace, writable?: boolean): Promise<AdvisorStore>;
    close(): void;
    private sql;
    private scalar;
    /** Connection-measured facts for the second qualification stage. Read-only. */
    private measureSqliteRuntime;
    /** Same gate as `open`, re-asserted on the instance that performs the write, so
     * every mutation path refuses identically rather than relying on open order. */
    private assertQualified;
    private checkSchema;
    private meta;
    view(now?: number): StoreView;
    readView(now?: number): StoreView;
    private capacity;
    private saveProposal;
    private saveRun;
    private fenceRuns;
    private transaction;
    lookup(requestId: string, payload?: unknown): CommandResult | null;
    preference(requestId: string, expected: number, enabled: boolean): CommandResult;
    configure(requestId: string, expected: number, input: unknown): CommandResult;
    bind(requestId: string, expected: number, ownerId: string, raw: unknown, snapshot: Snapshot): CommandResult;
    revoke(requestId: string, expected: number): CommandResult;
    maintain(requestId: string, expected: number): CommandResult;
    noWork(requestId: string, expected: number, reason: 'no-binding' | 'disabled'): CommandResult;
    observe(requestId: string, expected: number, snapshot: Snapshot): CommandResult;
    reserve(requestId: string, expected: number, snapshot: Snapshot, trigger: 'manual' | 'host', hostFence: {
        token: string;
        generation: number;
    } | null): CommandResult;
    publish(requestId: string, reserved: Run, proposals: ProposalV2[], snapshot: Snapshot): CommandResult;
    review(requestId: string, id: string, expected: number, decision: 'reject' | 'defer', reason: string, until: string | null): CommandResult;
    lease(requestId: string, expected: number, token: string, action: 'acquire' | 'renew' | 'stop'): CommandResult;
}
export declare function storageError(error: unknown): AdvisorError;
export {};
