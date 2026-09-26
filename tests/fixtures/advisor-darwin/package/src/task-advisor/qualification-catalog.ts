import type { QualificationCatalog } from './qualification.js';

/**
 * Package-owned static storage-qualification catalog.
 *
 * This file is the ONLY source of production storage qualification. It ships inside
 * the package and is imported directly by `store.ts`. There is deliberately no
 * catalog path option, no environment variable, no workspace or user receipt file,
 * no CLI force flag and no runtime override that can add, replace or bypass an entry
 * in a shipped leaf. Changing what is qualified requires changing this source file
 * and shipping a new artifact.
 *
 * ## Authoring rules (controller only)
 *
 * An entry may be added ONLY after the controller has reviewed the exact B1 evidence
 * for that stack and can name, for each gate, the artifact that proves it. Authoring
 * an entry is a statement that the controller read that evidence — not that a probe
 * reported success. In particular, none of the following is sufficient on its own:
 *
 * - a probe receipt whose `passed` field is `true` (self-reported);
 * - a synthetic API/substrate check, however many assertions it contains;
 * - a platform, distribution or filesystem NAME without measured `statfs` identity;
 * - a Node major version, release line or `>=` range instead of an exact version;
 * - the absence of an observed failure.
 *
 * Each entry binds, exactly: the runtime (exact Node version, tested artifact digest,
 * bundled SQLite version, library version and compile-options digest), the platform
 * (exact `process.platform`, `process.arch`, covered `os.release()` prefixes), the
 * storage profile (documented profile plus the exact measured `statfs` type values,
 * never network or removable), the tested build envelope (the measured capacity
 * ceilings), the reviewed evidence identifiers with digests, a `passed` result for
 * every gate in `QUALIFICATION_GATES`, and explicit `attests` / `doesNotAttest` text.
 *
 * ## Current evidence state
 *
 * The catalog is EMPTY. The supplied three-OS native receipts for Node v24.21.0 with
 * bundled SQLite 3.53.4 prove the synthetic API/PRAGMA/contention substrate only.
 * They do not cover storage faults, hard-kill or hot-journal recovery, VM/power-loss
 * durability, the installed artifact path, or a measured capacity envelope, and their
 * own `unqualified` list says so. No entry may be invented from them.
 *
 * An empty catalog is a truthful temporary evidence state, not a complete or useful
 * Advisor product: every production write refuses with `durability-unverified` and
 * every required gate reported missing, while read-only diagnostics keep working.
 */
export const QUALIFICATION_CATALOG: QualificationCatalog = Object.freeze([]);

/** Bumped whenever an entry is added, changed or withdrawn. */
export const QUALIFICATION_CATALOG_REVISION = 0;
