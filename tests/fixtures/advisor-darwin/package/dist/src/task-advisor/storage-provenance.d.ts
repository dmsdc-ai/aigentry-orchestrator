/**
 * Package-owned, read-only storage-provenance measurement.
 *
 * This module answers exactly one question about exactly one already-resolved
 * directory: is the medium that directory currently lives on internal and fixed,
 * removable, reached over a network, or not established. It is the measurement
 * stage required by CONTRACT §1 and it implements the API selection recorded in
 * `input/ADAPTER-DECISION.md`.
 *
 * What this module deliberately is NOT:
 *
 * - It is not a device or mount enumerator. Every OS query names the one target
 *   volume that was bound from the caller's path; nothing scans `/sys`, walks the
 *   mount table for unrelated entries, or inspects other devices.
 * - It is not a privilege escalation path. Every call runs with the ordinary
 *   permissions of the current process. There is no prompt, no setuid helper and
 *   no root fallback: an access denial is reported as `unknown`, never retried
 *   with more authority.
 * - It is not a content reader. No byte of the target directory or of any file
 *   inside it is read, and no device serial, volume label or user-visible name is
 *   ever placed in the returned facts.
 * - It is not proof of physical media. A result describes one volume at one
 *   instant; a path may be bound to different media immediately afterwards, which
 *   is why the store's existing pre-open and second-stage checks still run.
 *
 * `statfs` format identity is never evidence of provenance here. A filesystem
 * format is a format; `apfs`, `ext4` and `ntfs` all appear on USB sticks.
 *
 * Failure direction is always toward refusal. Every error, timeout, denial,
 * oversize response, ambiguous topology, contradictory answer or missing helper
 * resolves to `unknown`, and `unknown` cannot qualify a production write.
 */
/** Wire protocol between this module and the package-owned native helpers. */
export declare const STORAGE_PROVENANCE_PROTOCOL = "advisor-storage-provenance-v1";
/** Bumped whenever the measurement semantics or the wire protocol change. */
export declare const STORAGE_PROVENANCE_ADAPTER_VERSION = 1;
/** The only four answers this module can produce. Only `local-fixed` can qualify. */
export type StorageClassification = 'local-fixed' | 'removable' | 'network' | 'unknown';
/**
 * How the returned volume identity was tied to the caller's path.
 *
 * `helper-confirmed` means the native helper independently reported the same
 * device identity Node measured. `mountinfo-matched` means one unambiguous
 * mount-table entry covered the canonical path. `node-only` means the binding
 * rests solely on this process's before/after `realpath`/`lstat`/`statfs` checks;
 * it is recorded so a reviewer can see exactly how strong the binding was.
 */
export type VolumeBinding = 'helper-confirmed' | 'mountinfo-matched' | 'node-only';
/** Bounded cost of one measurement. Overflow is refused, not reported as success. */
export interface StorageProvenanceCost {
    wallMs: number;
    bytesRead: number;
    rssBytes: number;
}
/**
 * One measured provenance observation. Every field is measured by the production
 * caller from the process or the filesystem; none of it is user-supplied,
 * configurable, or derived from a receipt.
 */
export interface StorageProvenanceFacts {
    protocol: typeof STORAGE_PROVENANCE_PROTOCOL;
    classification: StorageClassification;
    /** Exact machine token naming the measurement result or the refusal cause. */
    reason: string;
    /** Exact adapter identity, e.g. `darwin-diskarbitration`. Named by the record. */
    adapter: string;
    adapterVersion: number;
    /** ISO-8601 UTC instant the observation completed. */
    observedAt: string;
    platform: string;
    arch: string;
    osRelease: string;
    /** Stringified `statfs` type. A format fact only; never provenance evidence. */
    filesystemType: string;
    /** Directory the caller asked about, before symlink resolution. */
    targetPath: string;
    /** `fs.realpath.native` of `targetPath` at observation time. */
    canonicalPath: string;
    /** Opaque digest of the bound device/volume identity. Carries no serial. */
    volumeIdentity: string;
    volumeBinding: VolumeBinding;
    cost: StorageProvenanceCost;
}
/**
 * Measure the provenance of the medium backing `targetPath`.
 *
 * Never throws: every failure is an `unknown` classification carrying the exact
 * reason, because a measurement stage that throws would be indistinguishable from
 * a crash and might tempt a caller into treating absence of failure as success.
 *
 * The canonical path, device and inode are bound before the OS query and rechecked
 * after it. A symlink swap, remount or device change between the two observations
 * invalidates the sample: the answer would describe a volume that is no longer the
 * one the caller is about to use.
 */
export declare function measureStorageProvenance(targetPath: string): StorageProvenanceFacts;
/**
 * Structural check for measured provenance facts.
 *
 * The pure matcher and its fixtures must use exactly the shape the production
 * caller produces, so a fixture cannot invent a looser fact. This validates shape
 * only; it can never upgrade a classification or authorize a write.
 */
export declare function checkStorageProvenance(input: unknown): StorageProvenanceFacts;
/**
 * Eligibility check, separate from the structural validity above: a measurement that
 * exceeded its approved budget can never support a production write, however
 * well-formed its facts are. Returns the exact reason `measureStorageProvenance`
 * itself uses for that overrun, or null when the sample stayed within budget. No
 * measured value is capped or altered to make anything pass.
 */
export declare function storageProvenanceBudgetRefusal(facts: StorageProvenanceFacts): string | null;
