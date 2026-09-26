import { BUILD_ENVELOPE, LIMITS, digestV2, exactKeysV2, hashJson, recordV2, requireV2, textV2, uintV2, utcV2, } from './contracts.js';
import { STORAGE_PROVENANCE_ADAPTER_VERSION, checkStorageProvenance, storageProvenanceBudgetRefusal, } from './storage-provenance.js';
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
export const QUALIFICATION_GATES = [
    'bundled-sqlite-api',
    'pragma-effectiveness',
    'process-concurrency',
    'restart-recovery',
    'hard-kill-recovery',
    'hot-journal-recovery',
    'storage-error-handling',
    'power-loss-durability',
    'initial-creation-durability',
    'disabled-preference-durability',
    'installed-artifact-path',
    'capacity-envelope',
];
const ALWAYS_UNATTESTED = Object.freeze([
    'authorship or integrity of local code and state against a same-user process',
    'rollback or replacement of the store or queue between observations',
    'correctness of any specific analysis result or proposal',
    'task admission, execution authority or Task Loop activation',
]);
function gateList(record) {
    return QUALIFICATION_GATES.filter(gate => record.gates[gate]?.result !== 'passed');
}
function runtimeIdentity(record) {
    return [record.runtime.nodeVersion, 'sqlite ' + record.runtime.bundledSqliteVersion,
        record.platform.platform, record.platform.arch].join(' / ');
}
function outcome(status, reason, facts, catalog, record, missingGates = []) {
    return {
        status, reason, measured: facts, missingGates, recordId: status === 'qualified' ? record?.recordId ?? null : null,
        catalogSize: catalog.length, documentedRuntimes: catalog.map(runtimeIdentity),
        attests: status === 'qualified' && record ? record.attests : [],
        doesNotAttest: [...(record?.doesNotAttest ?? []), ...ALWAYS_UNATTESTED],
    };
}
/**
 * Structural check for one authored catalog record. A record that does not pass this
 * check cannot qualify anything; a hand edit that drops a gate or widens a field is
 * refused rather than silently trusted.
 */
export function checkQualificationRecord(input) {
    const item = recordV2(input);
    exactKeysV2(item, ['schemaVersion', 'recordId', 'reviewedAt', 'runtime', 'platform', 'storage',
        'buildEnvelope', 'gates', 'evidence', 'attests', 'doesNotAttest']);
    requireV2(item.schemaVersion === 1, 'unknown-qualification-version');
    textV2(item.recordId);
    utcV2(item.reviewedAt);
    const runtime = recordV2(item.runtime);
    exactKeysV2(runtime, ['nodeVersion', 'nodeArtifactDigest', 'bundledSqliteVersion', 'sqliteLibraryVersion', 'sqliteCompileOptionsDigest']);
    requireV2(/^v\d+\.\d+\.\d+$/.test(textV2(runtime.nodeVersion)), 'invalid-node-version');
    digestV2(runtime.nodeArtifactDigest);
    digestV2(runtime.sqliteCompileOptionsDigest);
    for (const key of ['bundledSqliteVersion', 'sqliteLibraryVersion']) {
        requireV2(/^\d+\.\d+\.\d+(\.\d+)?$/.test(textV2(runtime[key])), 'invalid-sqlite-version');
    }
    const platform = recordV2(item.platform);
    exactKeysV2(platform, ['platform', 'arch', 'osReleasePrefixes']);
    requireV2(['darwin', 'linux', 'win32'].includes(textV2(platform.platform)), 'unqualifiable-platform');
    textV2(platform.arch);
    const prefixes = platform.osReleasePrefixes;
    requireV2(Array.isArray(prefixes) && prefixes.length > 0, 'missing-os-release-prefixes');
    for (const prefix of prefixes)
        textV2(prefix);
    const storage = recordV2(item.storage);
    exactKeysV2(storage, ['profile', 'filesystemTypes', 'networkOrRemovable'], ['provenance', 'provenanceAdapters']);
    textV2(storage.profile);
    requireV2(storage.networkOrRemovable === false, 'network-or-removable-never-qualified');
    const types = storage.filesystemTypes;
    requireV2(Array.isArray(types) && types.length > 0, 'missing-filesystem-types');
    for (const type of types)
        textV2(type);
    // Provenance review is all-or-nothing: a record cannot name a class without also
    // naming the exact adapters whose behaviour was reviewed to establish it.
    const hasProvenance = Object.hasOwn(storage, 'provenance');
    requireV2(hasProvenance === Object.hasOwn(storage, 'provenanceAdapters'), 'incomplete-provenance-review');
    if (hasProvenance) {
        requireV2(storage.provenance === 'local-fixed', 'only-local-fixed-qualifiable');
        const adapters = storage.provenanceAdapters;
        requireV2(Array.isArray(adapters) && adapters.length > 0, 'missing-provenance-adapters');
        for (const adapter of adapters)
            textV2(adapter);
    }
    const envelope = recordV2(item.buildEnvelope);
    const envelopeKeys = [...Object.keys(BUILD_ENVELOPE), 'maxStoreBytes'];
    exactKeysV2(envelope, envelopeKeys);
    for (const key of envelopeKeys)
        uintV2(envelope[key], Number.MAX_SAFE_INTEGER, 1);
    requireV2(uintV2(envelope.maxStoreBytes) >= 1024 * 1024, 'invalid-envelope-store-bytes');
    const gates = recordV2(item.gates);
    exactKeysV2(gates, [], QUALIFICATION_GATES);
    for (const key of Object.keys(gates)) {
        const gate = recordV2(gates[key]);
        exactKeysV2(gate, ['result', 'evidenceId', 'observedAt']);
        requireV2(['passed', 'failed', 'not-run'].includes(textV2(gate.result)), 'invalid-gate-result');
        textV2(gate.evidenceId);
        utcV2(gate.observedAt);
    }
    const evidence = item.evidence;
    requireV2(Array.isArray(evidence) && evidence.length > 0, 'missing-evidence');
    const ids = new Set();
    for (const entry of evidence) {
        const ref = recordV2(entry);
        exactKeysV2(ref, ['id', 'kind', 'digest', 'observedAt']);
        const id = textV2(ref.id);
        requireV2(!ids.has(id), 'duplicate-evidence-id');
        ids.add(id);
        requireV2(['ci-receipt', 'fault-injection-report', 'installed-artifact', 'measurement-report'].includes(textV2(ref.kind)), 'invalid-evidence-kind');
        digestV2(ref.digest);
        utcV2(ref.observedAt);
    }
    // Every reviewed gate must name evidence that is actually present in the record.
    for (const key of Object.keys(gates))
        requireV2(ids.has(textV2(recordV2(gates[key]).evidenceId)), 'gate-evidence-missing');
    for (const key of ['attests', 'doesNotAttest']) {
        const lines = item[key];
        requireV2(Array.isArray(lines) && lines.length > 0, 'missing-' + key);
        for (const line of lines)
            textV2(line, LIMITS.text);
    }
    return item;
}
/** Structural check for the whole package catalog, including identity uniqueness. */
export function checkQualificationCatalog(input) {
    const ids = new Set(), identities = new Set();
    for (const entry of input) {
        const record = checkQualificationRecord(entry);
        requireV2(!ids.has(record.recordId), 'duplicate-qualification-record');
        ids.add(record.recordId);
        const identity = hashJson([record.runtime, record.platform, record.storage]);
        requireV2(!identities.has(identity), 'duplicate-qualification-identity');
        identities.add(identity);
    }
    return input;
}
/**
 * Exact reason the measured provenance cannot support a production write, or null
 * when the medium was actually measured as local and fixed.
 *
 * The facts must describe the very directory the store is about to use, measured on
 * this runtime: provenance for a different target, a different filesystem format or
 * a different platform is evidence about something else. A fixture that omits the
 * measurement entirely — including every pre-provenance fixture — refuses here, so
 * matching a filesystem FORMAT can never stand in for measuring the medium.
 *
 * Every dimension the facts carry is compared, not just the classification. A
 * `local-fixed` verdict resting on a `node-only` binding was never tied to a volume
 * at all — by the type's own definition it rests solely on this process's
 * `realpath`/`lstat`/`statfs` checks — so it is exactly the unestablished-binding
 * case CONTRACT §1 ¶2 calls a refusal, and it must not become a qualification.
 *
 * Freshness gap, stated exactly: neither CONTRACT nor ADAPTER-DECISION establishes a
 * maximum observation age, and inventing one here would be unapproved timing
 * semantics. What is refused is the contradictory case — an observation dated after
 * the match. Production freshness currently rests on call ordering:
 * `store.measuredRuntimeFacts` measures provenance in the same call that matches it.
 * A real maximum-age bound remains OPEN and needs an approved constant.
 */
function provenanceRefusal(facts) {
    let measured;
    try {
        measured = checkStorageProvenance(facts.provenance);
    }
    catch {
        return 'storage-provenance-missing';
    }
    if (measured.targetPath !== facts.storagePath)
        return 'storage-provenance-unbound-target';
    // The store refuses aliased paths outright, so a canonical path naming a different
    // directory than the one measured is a contradiction, not a supported layout.
    if (measured.canonicalPath !== measured.targetPath)
        return 'storage-provenance-path-unstable';
    if (measured.filesystemType !== facts.filesystemType)
        return 'storage-provenance-format-mismatch';
    if (measured.platform !== facts.platform || measured.arch !== facts.arch
        || measured.osRelease !== facts.osRelease)
        return 'storage-provenance-runtime-mismatch';
    // Facts produced under different measurement semantics cannot be read as these.
    if (measured.adapterVersion !== STORAGE_PROVENANCE_ADAPTER_VERSION)
        return 'storage-provenance-adapter-version-mismatch';
    if (Date.parse(measured.observedAt) > Date.now())
        return 'storage-provenance-observation-not-fresh';
    const overBudget = storageProvenanceBudgetRefusal(measured);
    if (overBudget !== null)
        return overBudget;
    if (measured.classification !== 'local-fixed') {
        // Carry the measurement's own exact reason through to the operator, so an
        // over-budget or unbound sample is never flattened into a generic `unknown`.
        // A forged reason cannot impersonate a different stage: only this module's own
        // namespace is passed through.
        return measured.reason.startsWith('storage-provenance-') ? measured.reason
            : measured.classification === 'unknown' ? 'storage-provenance-unknown'
                : 'storage-provenance-' + measured.classification;
    }
    if (measured.volumeBinding === 'node-only')
        return 'storage-provenance-insufficient-binding';
    return null;
}
/**
 * The only adapter/binding pair each platform's measurement path can emit; anything
 * else describes a measurement this product cannot have taken on the claimed platform.
 * `node-only` is omitted: it is already refused above by its own exact reason.
 */
const PLATFORM_PROVENANCE_PAIRS = new Map([
    ['darwin', { adapter: 'darwin-diskarbitration', binding: 'helper-confirmed' }],
    ['win32', { adapter: 'windows-volume-hotplug', binding: 'helper-confirmed' }],
    ['linux', { adapter: 'linux-mountinfo-sysfs', binding: 'mountinfo-matched' }],
]);
/**
 * Exact reason the measured adapter/binding pair contradicts the platform it claims,
 * or null. A record names the adapters its author reviewed; that is never evidence
 * that these facts could have come from one (CONTRACT §1 ¶4: no portable claim).
 */
function adapterPlatformRefusal(measured) {
    const expected = PLATFORM_PROVENANCE_PAIRS.get(measured.platform);
    if (expected === undefined)
        return 'storage-provenance-unsupported-platform';
    if (measured.adapter !== expected.adapter)
        return 'storage-provenance-adapter-platform-mismatch';
    if (measured.volumeBinding !== expected.binding)
        return 'storage-provenance-binding-platform-mismatch';
    return null;
}
function matchesRuntime(record, facts) {
    return record.runtime.nodeVersion === facts.nodeVersion
        && record.runtime.bundledSqliteVersion === facts.bundledSqliteVersion
        && record.platform.platform === facts.platform
        && record.platform.arch === facts.arch
        && record.platform.osReleasePrefixes.some(prefix => facts.osRelease.startsWith(prefix));
}
/**
 * Match measured facts against reviewed records. Returns `qualified` only when one
 * record documents this exact runtime, this exact storage profile, and carries a
 * reviewed `passed` result for every gate in QUALIFICATION_GATES — and only when the
 * measured adapter and volume binding are a pair the measured platform can produce.
 *
 * An empty catalog is a truthful temporary evidence state, not a supported runtime
 * and not a product: it yields `durability-unverified` with every gate missing.
 */
export function matchQualification(facts, catalog) {
    checkQualificationCatalog(catalog);
    if (!facts.sqliteModuleAvailable || facts.bundledSqliteVersion === null) {
        // Below-floor runtime: read-only diagnostics remain available to the caller.
        return outcome('unsupported-runtime', 'bundled-sqlite-unavailable', facts, catalog, null, [...QUALIFICATION_GATES]);
    }
    if (catalog.length === 0) {
        return outcome('durability-unverified', 'no-reviewed-qualification-records', facts, catalog, null, [...QUALIFICATION_GATES]);
    }
    const runtimeMatches = catalog.filter(record => matchesRuntime(record, facts));
    if (runtimeMatches.length === 0) {
        return outcome('unsupported-runtime', 'runtime-outside-reviewed-records', facts, catalog, null, [...QUALIFICATION_GATES]);
    }
    // Provenance is checked before any storage record is consulted, so that removable,
    // network and unmeasured media refuse on their own evidence rather than on whether
    // some record happens to share their filesystem FORMAT.
    const refusal = provenanceRefusal(facts);
    if (refusal !== null) {
        return outcome('durability-unverified', refusal, facts, catalog, runtimeMatches[0], [...QUALIFICATION_GATES]);
    }
    const formatMatches = runtimeMatches.filter(record => record.storage.filesystemTypes.includes(facts.filesystemType));
    if (formatMatches.length === 0) {
        // The runtime is documented, but this measured filesystem is not the tested
        // storage stack. Unvalidated filesystem formats land here.
        return outcome('durability-unverified', 'storage-profile-unqualified', facts, catalog, runtimeMatches[0], [...QUALIFICATION_GATES]);
    }
    // The measured medium is local-fixed AND its format is documented; the record must
    // still have been reviewed against this exact adapter's behaviour.
    const storageMatches = formatMatches.filter(record => record.storage.provenance === 'local-fixed'
        && (record.storage.provenanceAdapters ?? []).includes(facts.provenance.adapter));
    if (storageMatches.length === 0) {
        return outcome('durability-unverified', 'storage-provenance-unreviewed', facts, catalog, formatMatches[0], [...QUALIFICATION_GATES]);
    }
    // Reviewed is not reachable: the pair must also be one the measured platform emits.
    // Ordered after the review test so an adapter no record names keeps the narrower
    // `-unreviewed` reason; both refuse, and every path to `qualified` passes here.
    const contradiction = adapterPlatformRefusal(facts.provenance);
    if (contradiction !== null) {
        return outcome('durability-unverified', contradiction, facts, catalog, storageMatches[0], [...QUALIFICATION_GATES]);
    }
    const complete = storageMatches.find(record => gateList(record).length === 0);
    if (!complete) {
        const best = storageMatches.reduce((a, b) => gateList(a).length <= gateList(b).length ? a : b);
        return outcome('durability-unverified', 'required-gates-unproven', facts, catalog, best, gateList(best));
    }
    return outcome('qualified', 'qualified-storage-stack', facts, catalog, complete, []);
}
/** Convenience predicate; the store still switches on the exact status token. */
export function isQualified(result) { return result.status === 'qualified'; }
/** Find the reviewed record a successful outcome refers to. */
export function qualifiedRecord(result, catalog) {
    if (result.status !== 'qualified' || result.recordId === null)
        return null;
    return catalog.find(record => record.recordId === result.recordId) ?? null;
}
/** Check only facts that do not depend on a file-backed database or its PRAGMAs. */
export function verifyQualifiedBuild(record, measured) {
    const mismatches = [];
    if (record.runtime.sqliteLibraryVersion !== measured.sqliteLibraryVersion)
        mismatches.push(`sqlite_version: expected ${record.runtime.sqliteLibraryVersion}, measured ${measured.sqliteLibraryVersion}`);
    if (record.runtime.sqliteCompileOptionsDigest !== measured.compileOptionsDigest)
        mismatches.push(`compile_options_digest: expected ${record.runtime.sqliteCompileOptionsDigest}, measured ${measured.compileOptionsDigest}`);
    return { ok: mismatches.length === 0, mismatches };
}
/**
 * Second-stage check on an open connection: the bundled library version, compile
 * options and effective PRAGMAs must be exactly what the reviewed record documents.
 * The store calls this before creating a schema or running any write transaction.
 */
export function verifyQualifiedRuntime(record, measured) {
    const mismatches = [];
    const compare = (label, expected, actual) => {
        if (expected !== actual)
            mismatches.push(`${label}: expected ${String(expected)}, measured ${String(actual)}`);
    };
    compare('sqlite_version', record.runtime.sqliteLibraryVersion, measured.sqliteLibraryVersion);
    compare('compile_options_digest', record.runtime.sqliteCompileOptionsDigest, measured.compileOptionsDigest);
    compare('journal_mode', 'delete', measured.pragmas.journalMode);
    compare('synchronous', 3, measured.pragmas.synchronous);
    compare('foreign_keys', 1, measured.pragmas.foreignKeys);
    compare('busy_timeout', 100, measured.pragmas.busyTimeoutMs);
    if (record.platform.platform === 'darwin')
        compare('fullfsync', 1, measured.pragmas.fullfsync);
    return { ok: mismatches.length === 0, mismatches };
}
/**
 * Evidence-defined ceilings. Effective limits are the intersection of the source
 * build envelope, the operator's configuration and the reviewed measured envelope.
 * Nothing here can raise a limit: a record with a larger tested envelope still
 * cannot exceed the source envelope, and configuration cannot exceed either.
 */
export function effectiveLimits(config, record) {
    if (!record)
        return config;
    const out = { ...config };
    for (const key of [...Object.keys(BUILD_ENVELOPE), 'maxStoreBytes']) {
        out[key] = Math.min(config[key], record.buildEnvelope[key], sourceCeiling(key));
    }
    return out;
}
function sourceCeiling(key) {
    return key === 'maxStoreBytes' ? LIMITS.storeBytes : BUILD_ENVELOPE[key];
}
/** True when every measured ceiling in `config` is within the reviewed envelope. */
export function withinEnvelope(config, record) {
    if (!record)
        return false;
    return [...Object.keys(BUILD_ENVELOPE), 'maxStoreBytes']
        .every(key => config[key] <= Math.min(record.buildEnvelope[key], sourceCeiling(key)));
}
//# sourceMappingURL=qualification.js.map