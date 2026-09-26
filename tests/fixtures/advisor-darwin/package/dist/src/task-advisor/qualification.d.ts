import { type InputLimits } from './contracts.js';
import { type StorageProvenanceFacts } from './storage-provenance.js';
/**
 * Pure storage-qualification validator and matcher.
 *
 * Nothing here opens a database, reads configuration, consults the environment or
 * mutates anything. It compares MEASURED runtime/storage facts against records that
 * a controller authored only after reviewing exact B1 evidence, and reports either a
 * qualified record or the precise reason a production write must refuse.
 *
 * Deliberately NOT accepted as qualification input anywhere in this module:
 * a workspace/user JSON receipt, a CLI or environment force flag, mutable runtime
 * configuration, the mere absence of a failure, a platform name on its own, or a
 * self-reported `passed: true` boolean from a probe. Only a package-owned record
 * authored from reviewed evidence can qualify a storage stack.
 *
 * Test route: `matchQualification` and `verifyQualifiedRuntime` take their catalog and
 * measured facts as explicit arguments, so unit tests can drive them with fixtures.
 * That is a pure-function fixture route, not a public mutation bypass: production
 * callers in `store.ts` pass the statically imported package catalog, and no exported
 * function here can turn a fixture into permission to write a real store.
 */
/** Exact gates that must all be reviewed and passed before production writes. */
export declare const QUALIFICATION_GATES: readonly ["bundled-sqlite-api", "pragma-effectiveness", "process-concurrency", "restart-recovery", "hard-kill-recovery", "hot-journal-recovery", "storage-error-handling", "power-loss-durability", "initial-creation-durability", "disabled-preference-durability", "installed-artifact-path", "capacity-envelope"];
export type QualificationGate = (typeof QUALIFICATION_GATES)[number];
/** One reviewed B1 artefact. The digest binds the exact bytes the controller read. */
export interface EvidenceRef {
    id: string;
    kind: 'ci-receipt' | 'fault-injection-report' | 'installed-artifact' | 'measurement-report';
    digest: string;
    observedAt: string;
}
/** Only `passed` qualifies. Absent, `failed` and `not-run` are equally unqualified. */
export interface GateResult {
    result: 'passed' | 'failed' | 'not-run';
    evidenceId: string;
    observedAt: string;
}
/** Measured capacity ceilings proved by `capacity-envelope` evidence for this stack. */
export interface QualifiedEnvelope extends InputLimits {
    maxStoreBytes: number;
}
/** Exact runtime identity. Every field is compared to a measured fact, never to a
 * user claim, a major-version range or a platform label on its own. */
export interface QualifiedRuntime {
    /** Exact `process.version`, e.g. `v24.21.0`. No range, no major-version match. */
    nodeVersion: string;
    /** SHA-256 of the exact tested Node distribution artifact, recorded for audit.
     * A running process cannot prove which artifact produced it; this documents what
     * the controller tested, and is never treated as a runtime identity check. */
    nodeArtifactDigest: string;
    /** Exact `process.versions.sqlite` of the bundled build. */
    bundledSqliteVersion: string;
    /** Exact `SELECT sqlite_version()` observed through the bundled API. */
    sqliteLibraryVersion: string;
    /** SHA-256 over the sorted `PRAGMA compile_options` list of the tested build. */
    sqliteCompileOptionsDigest: string;
}
export interface QualifiedPlatform {
    /** Exact `process.platform`. */
    platform: string;
    /** Exact `process.arch`. */
    arch: string;
    /** Exact `os.release()` prefixes covered by the tested build envelope. */
    osReleasePrefixes: readonly string[];
}
export interface QualifiedStorage {
    /** Documented storage profile, e.g. `local-fixed-internal-apfs`. Descriptive. */
    profile: string;
    /** Exact stringified `statfs` type identifiers measured on the tested stack. */
    filesystemTypes: readonly string[];
    /** Network and removable filesystems are never qualified for production writes. */
    networkOrRemovable: false;
    /**
     * The measured provenance class this record was reviewed for. Only `local-fixed`
     * is expressible, and a record that omits it was never reviewed against a
     * provenance measurement at all, so it can never match. Structurally optional so
     * that a pre-provenance record is refused by the matcher with an exact reason
     * rather than throwing a shape error.
     */
    provenance?: 'local-fixed';
    /**
     * Exact adapter identities whose behaviour the controller reviewed, e.g.
     * `darwin-diskarbitration`. A record never makes a portable claim: an adapter
     * that was not reviewed for this record cannot satisfy it.
     */
    provenanceAdapters?: readonly string[];
}
export interface QualificationRecordV1 {
    schemaVersion: 1;
    recordId: string;
    /** When the controller reviewed the evidence below and authored this record. */
    reviewedAt: string;
    runtime: QualifiedRuntime;
    platform: QualifiedPlatform;
    storage: QualifiedStorage;
    /** Tested build envelope. Config can never exceed it; see `effectiveLimits`. */
    buildEnvelope: QualifiedEnvelope;
    gates: Partial<Record<QualificationGate, GateResult>>;
    evidence: readonly EvidenceRef[];
    /** Exactly what a match does attest, in the controller's own words. */
    attests: readonly string[];
    /** Exactly what a match does NOT attest. Never empty. */
    doesNotAttest: readonly string[];
}
export type QualificationCatalog = readonly QualificationRecordV1[];
/** Facts measured from the live process and the real store directory before any
 * database file is created or opened. No value here comes from user input. */
export interface MeasuredRuntimeFacts {
    nodeVersion: string;
    bundledSqliteVersion: string | null;
    sqliteModuleAvailable: boolean;
    platform: string;
    arch: string;
    osRelease: string;
    /** Stringified `statfs` type of the directory that will hold the database. */
    filesystemType: string;
    /** Directory whose filesystem was measured. */
    storagePath: string;
    /**
     * Measured provenance of the medium backing `storagePath`, taken by the
     * production caller before any database file is created or opened. A filesystem
     * format is not provenance; this is the only field that carries that evidence.
     */
    provenance: StorageProvenanceFacts;
}
/** Facts that only become measurable on an open connection, checked before the
 * store creates a schema or runs any write transaction. */
export interface MeasuredSqliteRuntime {
    sqliteLibraryVersion: string;
    compileOptionsDigest: string;
    pragmas: {
        journalMode: string;
        synchronous: number;
        foreignKeys: number;
        busyTimeoutMs: number;
        fullfsync: number | null;
    };
}
/** Library/build facts measured on an ephemeral connection before touching a real file. */
export interface MeasuredSqliteBuild {
    sqliteLibraryVersion: string;
    compileOptionsDigest: string;
}
export type QualificationStatus = 'qualified' | 'unsupported-runtime' | 'durability-unverified';
export interface QualificationOutcome {
    status: QualificationStatus;
    /** Stable machine token naming the exact refusal or match. */
    reason: string;
    measured: MeasuredRuntimeFacts;
    /** Gates the matched record does not carry a reviewed `passed` result for. */
    missingGates: readonly QualificationGate[];
    /** Record identifier when a record matched; null otherwise. */
    recordId: string | null;
    /** Number of records in the consulted catalog. Zero is a temporary evidence state. */
    catalogSize: number;
    /** Runtime identities the catalog documents, for a truthful diagnostic. */
    documentedRuntimes: readonly string[];
    attests: readonly string[];
    doesNotAttest: readonly string[];
}
/**
 * Structural check for one authored catalog record. A record that does not pass this
 * check cannot qualify anything; a hand edit that drops a gate or widens a field is
 * refused rather than silently trusted.
 */
export declare function checkQualificationRecord(input: unknown): QualificationRecordV1;
/** Structural check for the whole package catalog, including identity uniqueness. */
export declare function checkQualificationCatalog(input: QualificationCatalog): QualificationCatalog;
/**
 * Match measured facts against reviewed records. Returns `qualified` only when one
 * record documents this exact runtime, this exact storage profile, and carries a
 * reviewed `passed` result for every gate in QUALIFICATION_GATES — and only when the
 * measured adapter and volume binding are a pair the measured platform can produce.
 *
 * An empty catalog is a truthful temporary evidence state, not a supported runtime
 * and not a product: it yields `durability-unverified` with every gate missing.
 */
export declare function matchQualification(facts: MeasuredRuntimeFacts, catalog: QualificationCatalog): QualificationOutcome;
/** Convenience predicate; the store still switches on the exact status token. */
export declare function isQualified(result: QualificationOutcome): boolean;
/** Find the reviewed record a successful outcome refers to. */
export declare function qualifiedRecord(result: QualificationOutcome, catalog: QualificationCatalog): QualificationRecordV1 | null;
export interface RuntimeVerification {
    ok: boolean;
    mismatches: readonly string[];
}
/** Check only facts that do not depend on a file-backed database or its PRAGMAs. */
export declare function verifyQualifiedBuild(record: QualificationRecordV1, measured: MeasuredSqliteBuild): RuntimeVerification;
/**
 * Second-stage check on an open connection: the bundled library version, compile
 * options and effective PRAGMAs must be exactly what the reviewed record documents.
 * The store calls this before creating a schema or running any write transaction.
 */
export declare function verifyQualifiedRuntime(record: QualificationRecordV1, measured: MeasuredSqliteRuntime): RuntimeVerification;
/**
 * Evidence-defined ceilings. Effective limits are the intersection of the source
 * build envelope, the operator's configuration and the reviewed measured envelope.
 * Nothing here can raise a limit: a record with a larger tested envelope still
 * cannot exceed the source envelope, and configuration cannot exceed either.
 */
export declare function effectiveLimits<T extends QualifiedEnvelope>(config: T, record: QualificationRecordV1 | null): T;
/** True when every measured ceiling in `config` is within the reviewed envelope. */
export declare function withinEnvelope(config: QualifiedEnvelope, record: QualificationRecordV1 | null): boolean;
