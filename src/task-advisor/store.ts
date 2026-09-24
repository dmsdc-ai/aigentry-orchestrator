import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  AdvisorError, BUILD_ENVELOPE, LIMITS, type AnalysisBindingV2, type AnalysisInputV2,
  type ConfigV2, type ProposalV2, type QueueV2,
  canonicalTaskId, checkedBindingV2, checkedProposalV2, defaultConfigV2, digestV2, exactKeysV2, hashBytes, hashJson,
  ownerEligibility, parseJsonV2, queueV2, recordV2, requireV2, scopeDigestV2,
  textV2, uintV2, utcV2, uuidV2, validateConfigV2, validateDecision,
} from './contracts.js';
import {
  type MeasuredRuntimeFacts, type MeasuredSqliteBuild, type MeasuredSqliteRuntime, type QualificationOutcome,
  type QualificationRecordV1, effectiveLimits, matchQualification, qualifiedRecord,
  verifyQualifiedBuild, verifyQualifiedRuntime, withinEnvelope,
} from './qualification.js';
import { QUALIFICATION_CATALOG, QUALIFICATION_CATALOG_REVISION } from './qualification-catalog.js';
import { type StorageProvenanceFacts, measureStorageProvenance } from './storage-provenance.js';

// Accurate local boundary for the supplied Node20 declarations. Runtime import is
// capability-checked; no ambient claim that all Node24 builds support this API.
type SqlValue = string | number | bigint | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;
interface Statement { get(...values: SqlValue[]): SqlRow | undefined; all(...values: SqlValue[]): SqlRow[]; run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface Database { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
interface SQLiteModule { DatabaseSync: new (file: string, options: { readOnly: boolean; timeout: number }) => Database }
export interface Workspace { path: string; id: string }
export interface Snapshot { queue: QueueV2; digest: string; bytes: number; metrics: ReturnType<typeof parseJsonV2>['metrics'] }
export interface CommandResult {
  schemaVersion: 2; requestId: string | null; outcome: string; revision: number; reason: string;
  [key: string]: unknown;
}
export interface Meta {
  workspace: string; schema: 2; storeRevision: number; configRevision: number;
  desiredEnabled: boolean; origin: 'default' | 'user'; clockHighWater: number;
  config: ConfigV2; lastOutcome: string; lastStartedAt: number; lastQueueDigest: string | null;
}
interface Run {
  id: string; generation: number; bindingRevision: number; configRevision: number;
  bindingId: string; queueDigest: string; ownerRowDigest: string; startedAt: number;
  deadline: number; status: 'reserved' | 'published' | 'interrupted' | 'discarded';
  proposalRevisions: Record<string, number>;
}
interface Lease { generation: number; token: string | null; heartbeat: number; expiresAt: number }
export interface StoreView {
  meta: Meta; binding: AnalysisBindingV2 | null; suspended: boolean; proposals: ProposalV2[];
  host: Lease; runs: Run[]; allocationTotal: number; allocationDay: number; workspaceDay: number;
}
export function commandResult(requestId: string | null, outcome: string, revision: number, reason = outcome, data: Record<string, unknown> = {}): CommandResult {
  return { schemaVersion: 2, requestId, outcome, revision, reason, ...data };
}
export function canonicalWorkspace(explicit: string): Workspace {
  requireV2(path.isAbsolute(explicit), 'absolute-workspace-required');
  const resolved = path.resolve(explicit), actual = fs.realpathSync.native(resolved);
  requireV2(resolved === actual, 'workspace-alias-refused');
  assertPath(actual, true);
  return { path: actual, id: hashBytes(JSON.stringify(['advisor-workspace-v1', actual])) };
}
/** Reject every existing path component that is a symlink/junction or alias. */
export function assertPath(file: string, directory: boolean): fs.Stats {
  const parsed = path.parse(file); let current = parsed.root;
  for (const component of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    requireV2(!stat.isSymbolicLink() && fs.realpathSync.native(current) === current, 'path-alias-refused');
  }
  const stat = fs.lstatSync(file);
  requireV2(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, 'unsafe-path');
  return stat;
}
function absent(file: string): boolean {
  try { fs.lstatSync(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
export function readBoundedFile(file: string, cap: number): Buffer {
  const before = assertPath(file, false);
  requireV2(before.size <= cap, 'input-limit');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    requireV2(opened.dev === before.dev && opened.ino === before.ino && opened.isFile() && opened.nlink === 1, 'input-changed');
    const buffer = Buffer.alloc(cap + 1); let count = 0;
    while (count < buffer.length) { const n = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n; }
    const after = fs.fstatSync(fd), named = assertPath(file, false);
    requireV2(count <= cap, 'input-limit');
    requireV2(count === before.size && [after, named].every(s => s.dev === before.dev && s.ino === before.ino
      && s.size === before.size && s.mtimeMs === before.mtimeMs && s.ctimeMs === before.ctimeMs), 'input-changed');
    return buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
export function readQueue(workspace: Workspace, limits: ConfigV2 | typeof BUILD_ENVELOPE): Snapshot {
  const started = performance.now();
  const bytes = readBoundedFile(path.join(workspace.path, 'state', 'task-queue.json'), limits.maxInputBytes);
  const parsed = parseJsonV2(bytes, limits), queue = queueV2(parsed.value, limits);
  requireV2(performance.now() - started <= limits.maxCpuWallMs, 'input-time-limit');
  return { queue, digest: hashBytes(bytes), bytes: bytes.length, metrics: parsed.metrics };
}

export interface RuntimeCapability {
  node: string; sqlite: string | null; platform: string; arch: string; osRelease: string;
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
/** Directory whose filesystem actually holds the database. When the store root does
 * not exist yet, the nearest existing ancestor is measured, because that is the
 * filesystem a fresh creation would land on. */
function storageDirectory(workspace: Workspace): string {
  let current = path.join(workspace.path, 'state', 'task-advisor');
  while (absent(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
/** Measure the live runtime and the real storage location. Every field below comes
 * from the process or the filesystem; none of it is user-supplied or configurable. */
export async function measuredRuntimeFacts(workspace: Workspace): Promise<MeasuredRuntimeFacts> {
  const storagePath = storageDirectory(workspace);
  let sqliteModuleAvailable = false;
  try { const name = 'node:sqlite'; const module = await import(name) as Partial<SQLiteModule>; sqliteModuleAvailable = typeof module.DatabaseSync === 'function'; } catch { /* Node20 remains a read-only diagnostic path. */ }
  return {
    nodeVersion: process.version,
    bundledSqliteVersion: (process.versions as Record<string, string | undefined>).sqlite ?? null,
    sqliteModuleAvailable, platform: process.platform, arch: process.arch, osRelease: os.release(),
    filesystemType: String(fs.statfsSync(storagePath).type), storagePath,
    // Measured on the real directory a fresh store would land on, before any
    // database file exists. Never inferred from the filesystem format above.
    provenance: measureStorageProvenance(storagePath),
  };
}
export async function runtimeCapability(workspace: Workspace): Promise<RuntimeCapability> {
  const facts = await measuredRuntimeFacts(workspace);
  const qualification = matchQualification(facts, QUALIFICATION_CATALOG);
  return { node: facts.nodeVersion, sqlite: facts.bundledSqliteVersion, platform: facts.platform,
    arch: facts.arch, osRelease: facts.osRelease, filesystemType: facts.filesystemType,
    storageProvenance: facts.provenance,
    substrate: qualification.status === 'qualified' ? 'qualified' : 'unavailable',
    durability: qualification.status === 'qualified' ? 'qualified' : 'durability-unverified',
    qualification, catalogRevision: QUALIFICATION_CATALOG_REVISION };
}
/**
 * The single production qualification gate. It consults only the package-owned
 * catalog: no workspace/user receipt, CLI or environment flag, mutable runtime
 * config, platform name, self-reported `passed` boolean or absence of failure can
 * reach it. Every mutation path runs this same check, and it runs before any
 * durable side effect — including creating the database file itself.
 *
 * Refusals are exact: `unsupported-runtime` when the measured runtime is outside
 * every reviewed record (or the bundled API is absent), `durability-unverified`
 * when the runtime is documented but the storage stack or required gates are not.
 * There is no downgrade to JSON or memory on either path.
 */
async function requireQualifiedStorage(workspace: Workspace): Promise<QualificationRecordV1> {
  const facts = await measuredRuntimeFacts(workspace);
  const result = matchQualification(facts, QUALIFICATION_CATALOG);
  requireV2(result.status !== 'unsupported-runtime', 'unsupported-runtime', 4);
  requireV2(result.status === 'qualified', 'durability-unverified', 4);
  const record = qualifiedRecord(result, QUALIFICATION_CATALOG);
  requireV2(record, 'durability-unverified', 4);
  const name = 'node:sqlite';
  const sqlite = await import(name) as SQLiteModule;
  const probe = new sqlite.DatabaseSync(':memory:', { readOnly: false, timeout: 100 });
  try {
    const options = probe.prepare('PRAGMA compile_options').all()
      .map(row => textV2(Object.values(row)[0], LIMITS.shortText)).sort();
    const measured: MeasuredSqliteBuild = {
      sqliteLibraryVersion: textV2(probe.prepare('SELECT sqlite_version() AS v').get()?.v, LIMITS.shortText),
      compileOptionsDigest: hashJson(options),
    };
    requireV2(verifyQualifiedBuild(record, measured).ok, 'qualified-runtime-mismatch', 4);
  } finally { probe.close(); }
  return record;
}

const SCHEMA = [
  'CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), workspace TEXT NOT NULL, schema INTEGER NOT NULL CHECK(schema=2), storeRevision INTEGER NOT NULL, configRevision INTEGER NOT NULL, desiredEnabled INTEGER NOT NULL CHECK(desiredEnabled IN(0,1)), origin TEXT NOT NULL, clockHighWater INTEGER NOT NULL, config TEXT NOT NULL, lastOutcome TEXT NOT NULL, lastStartedAt INTEGER NOT NULL, lastQueueDigest TEXT)',
  'CREATE TABLE binding (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, suspended INTEGER NOT NULL CHECK(suspended IN(0,1)))',
  'CREATE TABLE allocations (id TEXT PRIMARY KEY, total INTEGER NOT NULL CHECK(total>=0))',
  'CREATE TABLE allocation_days (allocationId TEXT NOT NULL REFERENCES allocations(id), day TEXT NOT NULL, used INTEGER NOT NULL CHECK(used>=0), PRIMARY KEY(allocationId,day))',
  'CREATE TABLE workspace_days (day TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used>=0))',
  'CREATE TABLE host (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, token TEXT, heartbeat INTEGER NOT NULL, expiresAt INTEGER NOT NULL)',
  'CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL)',
  "CREATE UNIQUE INDEX active_run ON runs(status) WHERE status='reserved'",
  'CREATE TABLE proposals (id TEXT PRIMARY KEY, dedupKey TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL)',
  'CREATE TABLE decisions (id TEXT PRIMARY KEY, proposalId TEXT NOT NULL REFERENCES proposals(id), requestId TEXT NOT NULL UNIQUE, body TEXT NOT NULL)',
  'CREATE TABLE requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL)',
] as const;
function defaultMeta(workspace: Workspace): Meta {
  return { workspace: workspace.id, schema: 2, storeRevision: 0, configRevision: 0, desiredEnabled: true,
    origin: 'default', clockHighWater: 0, config: defaultConfigV2(), lastOutcome: 'not-run', lastStartedAt: 0, lastQueueDigest: null };
}
function decode(text: SqlValue | undefined): unknown {
  requireV2(typeof text === 'string', 'corrupt-store', 5);
  try { return parseJsonV2(Buffer.from(text), { ...BUILD_ENVELOPE, maxInputBytes: LIMITS.storeBytes }).value; }
  catch { throw new AdvisorError('corrupt-store', 5); }
}
function number(row: SqlRow, key: string): number { return uintV2(row[key]); }
/** All Advisor SQLite writes, including host leases, pass through this class. */
export class AdvisorStore {
  private constructor(readonly workspace: Workspace, private db: Database | null, private readonly writable: boolean, readonly file: string,
    private readonly reopenReadOnly: (() => Database) | null = null,
    /** The reviewed record that qualified this writer. Null on every read-only open. */
    readonly qualification: QualificationRecordV1 | null = null) {}
  static async open(workspace: Workspace, writable = false): Promise<AdvisorStore> {
    const root = path.join(workspace.path, 'state', 'task-advisor'), file = path.join(root, 'advisor.sqlite');
    const rootAbsent = absent(root);
    if (!rootAbsent) {
      assertPath(root, true);
      const entries = fs.readdirSync(root);
      requireV2(!entries.includes('store.json'), 'legacy-store-migration-required', 4);
      requireV2(entries.every(name => ['advisor.sqlite', 'advisor.sqlite-journal'].includes(name)), 'unknown-store-state', 5);
      requireV2(!absent(file), 'partial-store-initialization', 5);
      for (const name of entries) assertPath(path.join(root, name), false);
    }
    if (!writable && rootAbsent) return new AdvisorStore(workspace, null, false, file);
    // Fresh creation and every reopen of the writer pass the same qualification gate,
    // before the database file or its directory can come into existence.
    const record = writable ? await requireQualifiedStorage(workspace) : null;
    // Judging the target's CONTENT comes after qualification, never before it: a
    // runtime or storage mismatch must stay `qualified-runtime-mismatch` on every
    // retry and must not be reported as corruption merely because an earlier attempt
    // left a zero-byte file (CONTRACT §2 ¶10). Every path, symlink, link-count and
    // directory-content check above still runs first, and nothing here mutates a byte.
    // Read-only opens reach this with `record === null`, so their order is unchanged.
    if (!rootAbsent) {
      const bytes = fs.statSync(file).size;
      requireV2(bytes > 0 && bytes <= LIMITS.storeBytes, 'corrupt-or-oversize-store', 5);
    }
    if (!writable) {
      // Read-only diagnostics need the bundled API to read an existing store, but
      // never a qualified storage stack; older runtimes report unsupported-runtime.
      const facts = await measuredRuntimeFacts(workspace);
      requireV2(facts.sqliteModuleAvailable, 'unsupported-runtime', 4);
    }
    if (writable && rootAbsent) {
      assertPath(path.join(workspace.path, 'state'), true);
      try { fs.mkdirSync(root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; assertPath(root, true); }
    }
    const name = 'node:sqlite', sqlite = await import(name) as SQLiteModule;
    const oldMask = writable && rootAbsent ? process.umask(0o077) : null;
    let db: Database;
    try { db = new sqlite.DatabaseSync(file, { readOnly: !writable, timeout: 100 }); }
    finally { if (oldMask !== null) process.umask(oldMask); }
    const store = new AdvisorStore(workspace, db, writable, file, () => new sqlite.DatabaseSync(file, { readOnly: true, timeout: 100 }), record);
    try {
      db.exec('PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON');
      if (writable) {
        // Existing unknown schemas are rejected before connection settings change.
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (tables.length) store.checkSchema();
        else requireV2(rootAbsent, 'partial-store-initialization', 5);
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA');
        if (process.platform === 'darwin') db.exec('PRAGMA fullfsync=ON');
        for (const [pragma, expected] of [['journal_mode', 'delete'], ['synchronous', 3], ['foreign_keys', 1], ['busy_timeout', 100]] as const)
          requireV2(store.scalar('PRAGMA ' + pragma) === expected, 'sqlite-capability-unavailable', 4);
        if (process.platform === 'darwin') requireV2(store.scalar('PRAGMA fullfsync') === 1, 'sqlite-capability-unavailable', 4);
        // Facts that only an open connection can measure must equal the reviewed
        // record before any schema creation or write transaction. A build that
        // reports a different library version or compile options is not the build
        // the evidence covers, whatever its Node version claims.
        requireV2(record, 'durability-unverified', 4);
        const verified = verifyQualifiedRuntime(record, store.measureSqliteRuntime());
        requireV2(verified.ok, 'qualified-runtime-mismatch', 4);
        db.exec('BEGIN IMMEDIATE');
        try {
          if (!db.prepare("SELECT name FROM sqlite_master WHERE name='meta'").get()) {
            for (const sql of SCHEMA) db.exec(sql);
            const meta = defaultMeta(workspace);
            db.prepare('INSERT INTO meta VALUES(1,?,2,0,0,1,?,0,?,?,0,NULL)').run(workspace.id, meta.origin, JSON.stringify(meta.config), meta.lastOutcome);
            db.prepare('INSERT INTO host VALUES(1,0,NULL,0,0)').run();
          }
          store.checkSchema(); store.view(Date.now()); db.exec('COMMIT');
        } catch (error) { try { db.exec('ROLLBACK'); } catch { /* original error wins */ } throw error; }
      } else {
        db.exec('BEGIN');
        try { store.checkSchema(); store.view(Date.now()); db.exec('COMMIT'); }
        catch (error) { try { db.exec('ROLLBACK'); } catch { /* read-only recovery stays with writer */ } throw error; }
      }
      return store;
    } catch (error) { db.close(); throw storageError(error); }
  }
  close(): void { this.db?.close(); this.db = null; }
  private sql(): Database { requireV2(this.db, 'absent-store', 5); return this.db; }
  private scalar(sql: string): SqlValue | undefined { const row = this.sql().prepare(sql).get(); return row ? Object.values(row)[0] : undefined; }
  /** Connection-measured facts for the second qualification stage. Read-only. */
  private measureSqliteRuntime(): MeasuredSqliteRuntime {
    const options = this.sql().prepare('PRAGMA compile_options').all()
      .map(row => textV2(Object.values(row)[0], LIMITS.shortText)).sort();
    return {
      sqliteLibraryVersion: textV2(this.scalar('SELECT sqlite_version() AS v'), LIMITS.shortText),
      compileOptionsDigest: hashJson(options),
      pragmas: {
        journalMode: textV2(this.scalar('PRAGMA journal_mode'), LIMITS.shortText),
        synchronous: uintV2(this.scalar('PRAGMA synchronous')),
        foreignKeys: uintV2(this.scalar('PRAGMA foreign_keys')),
        busyTimeoutMs: uintV2(this.scalar('PRAGMA busy_timeout')),
        fullfsync: process.platform === 'darwin' ? uintV2(this.scalar('PRAGMA fullfsync')) : null,
      },
    };
  }
  /** Same gate as `open`, re-asserted on the instance that performs the write, so
   * every mutation path refuses identically rather than relying on open order. */
  private assertQualified(): QualificationRecordV1 {
    requireV2(this.writable, 'read-only-store', 5);
    const record = this.qualification;
    requireV2(record, 'durability-unverified', 4);
    return record;
  }
  private checkSchema(): void {
    const rows = this.sql().prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    requireV2(hashJson(rows.map(row => row.sql).sort()) === hashJson([...SCHEMA].sort()), 'unknown-store-schema', 5);
    requireV2(this.scalar('PRAGMA quick_check(1)') === 'ok', 'corrupt-store', 5);
  }
  private meta(): Meta {
    if (!this.db) return defaultMeta(this.workspace);
    const row = this.db.prepare('SELECT * FROM meta WHERE id=1').get();
    requireV2(row && row.workspace === this.workspace.id && row.schema === 2 && [0, 1].includes(Number(row.desiredEnabled)) && ['default', 'user'].includes(String(row.origin)), 'corrupt-store', 5);
    // Effective limits are the intersection of stored config, the source envelope
    // and the reviewed measured envelope. Every reader of meta.config — status,
    // capacity accounting, the bounded queue reader and the analysis wall limit —
    // therefore sees evidence-defined ceilings, and no path can raise them.
    const config = effectiveLimits(validateConfigV2(decode(row.config)), this.qualification);
    const meta: Meta = { workspace: this.workspace.id, schema: 2, storeRevision: number(row, 'storeRevision'), configRevision: number(row, 'configRevision'),
      desiredEnabled: row.desiredEnabled === 1, origin: row.origin as Meta['origin'], clockHighWater: number(row, 'clockHighWater'), config,
      lastOutcome: textV2(row.lastOutcome), lastStartedAt: number(row, 'lastStartedAt'), lastQueueDigest: row.lastQueueDigest === null ? null : textV2(row.lastQueueDigest) };
    requireV2(meta.configRevision <= meta.storeRevision && (meta.origin === 'user' || meta.desiredEnabled), 'corrupt-store', 5);
    return meta;
  }
  view(now = Date.now()): StoreView {
    const meta = this.meta();
    if (!this.db) return { meta, binding: null, suspended: false, proposals: [], host: { generation: 0, token: null, heartbeat: 0, expiresAt: 0 }, runs: [], allocationTotal: 0, allocationDay: 0, workspaceDay: 0 };
    this.capacity(meta.config, false);
    const bindingRow = this.db.prepare('SELECT * FROM binding WHERE id=1').get();
    const binding = bindingRow ? checkedBindingV2(decode(bindingRow.body)) : null;
    requireV2(!binding || binding.workspaceId === this.workspace.id, 'workspace-mismatch', 5);
    if (bindingRow) requireV2(bindingRow.suspended === 0 || bindingRow.suspended === 1, 'corrupt-store', 5);
    const host = this.db.prepare('SELECT * FROM host WHERE id=1').get(); requireV2(host, 'corrupt-store', 5);
    const proposals = this.db.prepare('SELECT * FROM proposals').all().map(row => {
      const proposal = checkedProposalV2(decode(row.body));
      requireV2(row.id === proposal.id && row.dedupKey === proposal.dedupKey && row.revision === proposal.revision && proposal.workspaceId === this.workspace.id, 'corrupt-store', 5);
      return proposal;
    });
    requireV2(this.db.prepare('PRAGMA foreign_key_check').all().length === 0, 'corrupt-store-references', 5);
    const allocations = new Set<string>();
    for (const row of this.db.prepare('SELECT * FROM allocations').all()) { allocations.add(uuidV2(row.id)); uintV2(row.total); }
    requireV2(!binding || allocations.has(binding.budget.allocationId), 'missing-allocation', 5);
    for (const table of ['allocation_days', 'workspace_days']) for (const row of this.db.prepare('SELECT * FROM ' + table).all()) {
      utcV2(textV2(row.day) + 'T00:00:00Z'); uintV2(row.used);
    }
    const decisions = new Map<string, ReturnType<typeof validateDecision>>();
    for (const row of this.db.prepare('SELECT * FROM decisions').all()) {
      const checked = validateDecision(decode(row.body), { workspaceId: this.workspace.id, now: new Date(now).toISOString() });
      requireV2(checked.ok && checked.value.id === row.id && checked.value.proposalId === row.proposalId
        && checked.value.requestId === row.requestId && checked.value.actor.id === 'local-cli' && !checked.value.actor.verified, 'corrupt-decision', 5);
      const target = proposals.find(p => p.id === checked.value.proposalId);
      requireV2(target && checked.value.proposalRevision < target.revision, 'corrupt-decision-revision', 5);
      decisions.set(checked.value.id, checked);
    }
    for (const p of proposals) if (p.disposition) {
      const checked = decisions.get(p.disposition.decisionId);
      requireV2(checked?.ok && checked.value.proposalId === p.id && checked.value.reason === p.disposition.reason
        && checked.value.until === p.disposition.deferredUntil, 'corrupt-disposition', 5);
    }
    for (const row of this.db.prepare('SELECT * FROM requests').all()) {
      uuidV2(row.id); digestV2(row.digest); const result = recordV2(decode(row.result));
      requireV2(result.schemaVersion === 2 && result.requestId === row.id, 'corrupt-request-result', 5);
      uintV2(result.revision); textV2(result.outcome); textV2(result.reason);
    }
    const runs = this.db.prepare('SELECT * FROM runs').all().map(row => {
      const run = recordV2(decode(row.body));
      exactKeysV2(run, ['id', 'generation', 'bindingRevision', 'configRevision', 'bindingId', 'queueDigest', 'ownerRowDigest', 'startedAt', 'deadline', 'status', 'proposalRevisions']);
      uuidV2(run.id); uuidV2(run.bindingId);
      for (const key of ['generation', 'bindingRevision', 'configRevision', 'startedAt', 'deadline']) uintV2(run[key]);
      for (const revision of Object.values(recordV2(run.proposalRevisions))) uintV2(revision);
      requireV2(row.id === run.id && row.status === run.status && ['reserved', 'published', 'interrupted', 'discarded'].includes(String(run.status)), 'corrupt-run', 5);
      return run as unknown as Run;
    });
    const day = new Date(now).toISOString().slice(0, 10);
    const count = (sql: string, ...args: SqlValue[]): number => { const row = this.db!.prepare(sql).get(...args); return row ? uintV2(Object.values(row)[0]) : 0; };
    return { meta, binding, suspended: bindingRow?.suspended === 1, proposals, runs,
      host: { generation: number(host, 'generation'), token: host.token === null ? null : uuidV2(host.token), heartbeat: number(host, 'heartbeat'), expiresAt: number(host, 'expiresAt') },
      allocationTotal: binding ? count('SELECT total FROM allocations WHERE id=?', binding.budget.allocationId) : 0,
      allocationDay: binding ? count('SELECT used FROM allocation_days WHERE allocationId=? AND day=?', binding.budget.allocationId, day) : 0,
      workspaceDay: count('SELECT used FROM workspace_days WHERE day=?', day) };
  }
  readView(now = Date.now()): StoreView {
    if (!this.db) return this.view(now);
    this.db.exec('BEGIN');
    try { const result = this.view(now); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* preserve error */ } throw storageError(error); }
  }
  private capacity(config: ConfigV2, reserve: boolean, extra = 0): void {
    const dbBytes = absent(this.file) ? 0 : fs.statSync(this.file).size;
    const journal = this.file + '-journal', journalBytes = absent(journal) ? 0 : fs.statSync(journal).size;
    // Worst-case full rollback copy plus growth, not just serialized proposals.
    const peak = Math.max(dbBytes + journalBytes, 2 * (dbBytes + extra) + 65_536);
    requireV2(peak <= config.maxStoreBytes - (reserve ? 262_144 : 0), 'store-capacity', 5);
    if (reserve) {
      const stat = fs.statfsSync(path.dirname(this.file));
      requireV2(stat.bavail * stat.bsize >= peak + 262_144, 'storage-reserve-unavailable', 5);
    }
  }
  private saveProposal(proposal: ProposalV2): void {
    checkedProposalV2(proposal);
    this.sql().prepare('INSERT INTO proposals VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body')
      .run(proposal.id, proposal.dedupKey, proposal.revision, JSON.stringify(proposal));
  }
  private saveRun(run: Run): void { this.sql().prepare('UPDATE runs SET status=?,body=? WHERE id=?').run(run.status, JSON.stringify(run), run.id); }
  private fenceRuns(view: StoreView): void {
    for (const run of view.runs) if (run.status === 'reserved') { run.generation++; run.status = 'discarded'; this.saveRun(run); }
  }
  private transaction(requestId: string, payload: unknown, work: (view: StoreView) => CommandResult, newWork = false): CommandResult {
    this.assertQualified(); uuidV2(requestId);
    const db = this.sql(), digest = hashJson(payload); let committing = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      const previous = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
      if (previous) {
        requireV2(previous.digest === digest, 'request-payload-conflict', 3);
        const replay = decode(previous.result) as CommandResult; db.exec('COMMIT'); return replay;
      }
      const view = this.view(); this.capacity(view.meta.config, newWork, Buffer.byteLength(JSON.stringify(payload)) + 8192);
      const response = work(view);
      db.prepare('UPDATE meta SET storeRevision=storeRevision+1,lastOutcome=? WHERE id=1').run(response.reason);
      db.prepare('INSERT INTO requests VALUES(?,?,?)').run(requestId, digest, JSON.stringify(response));
      this.capacity(this.meta().config, false);
      committing = true; db.exec('COMMIT'); return response;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* Commit outcome may be uncertain. */ }
      if (committing) {
        // Reopen with the same request identity. Never replay the work under a new ID.
        try { db.close(); } catch { /* no further writes on the uncertain handle */ }
        this.db = null;
        let reader: Database | null = null;
        try {
          reader = this.reopenReadOnly?.() ?? null;
          const committed = reader?.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
          if (committed && committed.digest === digest) return decode(committed.result) as CommandResult;
        } catch { /* Hot-journal recovery or missing result remains uncertain. */ }
        finally { reader?.close(); }
        throw new AdvisorError('commit-uncertain-query-request:' + requestId, 5);
      }
      throw storageError(error);
    }
  }
  lookup(requestId: string, payload?: unknown): CommandResult | null {
    uuidV2(requestId); if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(requestId); if (!row) return null;
    if (payload !== undefined) requireV2(row.digest === hashJson(payload), 'request-payload-conflict', 3);
    return decode(row.result) as CommandResult;
  }
  preference(requestId: string, expected: number, enabled: boolean): CommandResult {
    return this.transaction(requestId, ['preference', expected, enabled], view => {
      requireV2(view.meta.configRevision === expected, 'revision-conflict', 3);
      this.sql().prepare("UPDATE meta SET desiredEnabled=?,origin='user',configRevision=configRevision+1 WHERE id=1 AND configRevision=?").run(enabled ? 1 : 0, expected);
      this.fenceRuns(view);
      return commandResult(requestId, 'applied', expected + 1, enabled ? 'enabled' : 'disabled');
    });
  }
  configure(requestId: string, expected: number, input: unknown): CommandResult {
    const config = validateConfigV2(input);
    // Configuration cannot relax the reviewed measured envelope; an operator may
    // only select capacity at or below what the evidence actually tested.
    requireV2(withinEnvelope(config, this.assertQualified()), 'envelope-exceeded');
    return this.transaction(requestId, ['config', expected, config], view => {
      requireV2(view.meta.configRevision === expected, 'revision-conflict', 3); this.capacity(config, false);
      this.sql().prepare('UPDATE meta SET config=?,configRevision=configRevision+1 WHERE id=1').run(JSON.stringify(config)); this.fenceRuns(view);
      return commandResult(requestId, 'applied', expected + 1, 'configured', { config });
    });
  }
  bind(requestId: string, expected: number, ownerId: string, raw: unknown, snapshot: Snapshot): CommandResult {
    const item = recordV2(raw);
    exactKeysV2(item, ['scope', 'ownership', 'budget', 'expiresAt'], ['notBefore']);
    const ownership = recordV2(item.ownership);
    exactKeysV2(ownership, ['releaseId'], ['workspaceId']);
    requireV2(ownership.workspaceId === undefined || ownership.workspaceId === this.workspace.id, 'workspace-mismatch');
    const payload = ['bind', expected, ownerId, item];
    return this.transaction(requestId, payload, view => {
      requireV2((view.binding?.revision ?? 0) === expected, 'revision-conflict', 3);
      const now = Date.now(), createdAt = new Date(now).toISOString();
      requireV2(now >= view.meta.clockHighWater, 'clock-rollback', 4);
      const owned = { workspaceId: this.workspace.id, releaseId: ownership.releaseId };
      const binding = checkedBindingV2({ schemaVersion: 2, id: view.binding?.id ?? randomUUID(), revision: expected + 1,
        workspaceId: this.workspace.id, ownerTaskId: ownerId, scope: item.scope, ownership: owned,
        scopeDigest: scopeDigestV2({ ownerTaskId: ownerId, scope: item.scope, ownership: owned } as AnalysisBindingV2),
        createdAt, notBefore: item.notBefore ?? createdAt, expiresAt: item.expiresAt, revokedAt: null, budget: item.budget,
        provenance: { requestId, payloadDigest: hashJson(payload), source: 'local-cli', authentication: 'not-established' } });
      requireV2(binding.workspaceId === this.workspace.id && binding.ownership.workspaceId === this.workspace.id, 'workspace-mismatch');
      requireV2(Date.parse(binding.expiresAt) > now && ownerEligibility(snapshot.queue, binding) === 'eligible', 'owner-or-binding-ineligible');
      for (const id of binding.scope.subjectTaskIds) requireV2(snapshot.queue.tasks.some(row => canonicalTaskId(row.id) === id), 'missing-subject');
      const latest = readQueue(this.workspace, view.meta.config); requireV2(latest.digest === snapshot.digest, 'input-changed', 3);
      this.sql().prepare('INSERT INTO allocations VALUES(?,0) ON CONFLICT(id) DO NOTHING').run(binding.budget.allocationId.toLowerCase());
      binding.budget.allocationId = binding.budget.allocationId.toLowerCase();
      this.sql().prepare('INSERT INTO binding VALUES(1,?,0) ON CONFLICT(id) DO UPDATE SET body=excluded.body,suspended=0').run(JSON.stringify(binding));
      this.sql().prepare('UPDATE meta SET clockHighWater=? WHERE id=1').run(now); this.fenceRuns(view);
      const owner = snapshot.queue.tasks.find(row => canonicalTaskId(row.id) === ownerId)!;
      return commandResult(requestId, 'applied', binding.revision, 'bound', { binding, audit: { queueDigest: snapshot.digest, ownerRowDigest: hashJson(owner) } });
    }, true);
  }
  revoke(requestId: string, expected: number): CommandResult {
    return this.transaction(requestId, ['revoke', expected], view => {
      requireV2(view.binding && view.binding.revision === expected, 'revision-conflict', 3);
      view.binding.revision++; view.binding.revokedAt = new Date(Math.max(Date.now(), view.meta.clockHighWater, Date.parse(view.binding.createdAt))).toISOString();
      this.sql().prepare('UPDATE binding SET body=? WHERE id=1').run(JSON.stringify(view.binding)); this.fenceRuns(view);
      return commandResult(requestId, 'applied', view.binding.revision, 'revoked');
    });
  }
  maintain(requestId: string, expected: number): CommandResult {
    return this.transaction(requestId, ['maintain', expected], view => {
      requireV2(view.meta.storeRevision === expected, 'revision-conflict', 3);
      const now = Date.now(), rollback = now < view.meta.clockHighWater;
      for (const run of view.runs) if (!rollback && run.status === 'reserved' && now >= run.deadline) {
        run.status = 'interrupted'; run.generation++; this.saveRun(run);
      }
      let due = false;
      for (const p of view.proposals) {
        if (p.state === 'rejected' || p.state === 'stale') continue;
        if (Math.max(now, view.meta.clockHighWater) >= Date.parse(p.expiresAt) || !view.binding || view.binding.revokedAt !== null
          || view.suspended || p.provenance.bindingRevision !== view.binding.revision) {
          p.state = 'stale'; p.revision++; p.currentness = { ...p.currentness, status: 'stale', reason: 'evidence-expired-or-binding-fenced' }; this.saveProposal(p);
        } else if (p.state === 'deferred' && p.disposition?.deferredUntil && now >= Date.parse(p.disposition.deferredUntil)) due = true;
      }
      if (!rollback) this.sql().prepare('UPDATE meta SET clockHighWater=? WHERE id=1').run(now);
      return commandResult(requestId, 'no-work', view.meta.storeRevision + 1, rollback ? 'clock-rollback' : due ? 'defer-due-awaiting-analysis' : 'maintenance-complete');
    });
  }
  noWork(requestId: string, expected: number, reason: 'no-binding' | 'disabled'): CommandResult {
    return this.transaction(requestId, ['no-work', expected, reason], view => {
      requireV2(view.meta.storeRevision === expected, 'revision-conflict', 3);
      return commandResult(requestId, 'no-work', view.meta.storeRevision + 1, reason);
    });
  }
  observe(requestId: string, expected: number, snapshot: Snapshot): CommandResult {
    return this.transaction(requestId, ['observe', expected, snapshot.digest], view => {
      requireV2(view.meta.storeRevision === expected, 'revision-conflict', 3);
      const broken = view.binding && ownerEligibility(snapshot.queue, view.binding) === 'continuity-break';
      if (broken) { this.sql().prepare('UPDATE binding SET suspended=1 WHERE id=1').run(); this.fenceRuns(view); }
      for (const proposal of view.proposals) if (!['rejected', 'stale'].includes(proposal.state) && (broken || proposal.provenance.queueDigest !== snapshot.digest)) {
        proposal.state = 'stale'; proposal.revision++; proposal.currentness = { ...proposal.currentness, status: 'stale', reason: broken ? 'owner-continuity-break' : 'queue-changed' }; this.saveProposal(proposal);
      }
      return commandResult(requestId, 'no-work', view.meta.storeRevision + 1, broken ? 'owner-continuity-break' : 'observed');
    });
  }
  reserve(requestId: string, expected: number, snapshot: Snapshot, trigger: 'manual' | 'host', hostFence: { token: string; generation: number } | null): CommandResult {
    return this.transaction(requestId, ['reserve', expected, snapshot.digest, trigger, hostFence], view => {
      requireV2(view.meta.storeRevision === expected, 'revision-conflict', 3);
      const now = Date.now(), b = view.binding;
      const no = (reason: string): CommandResult => commandResult(requestId, 'no-work', view.meta.storeRevision + 1, reason);
      if (now < view.meta.clockHighWater) return no('clock-rollback');
      if (hostFence) requireV2(view.host.token === hostFence.token && view.host.generation === hostFence.generation && view.host.expiresAt > now, 'host-fenced', 3);
      if (!view.meta.desiredEnabled) return no('disabled');
      if (!b) return no('no-binding');
      if (view.suspended) return no('owner-continuity-break');
      if (b.revokedAt !== null || now < Date.parse(b.notBefore) || now >= Date.parse(b.expiresAt)) return no('binding-inactive');
      requireV2(b.scopeDigest === scopeDigestV2(b) && b.workspaceId === this.workspace.id && b.ownership.workspaceId === this.workspace.id, 'binding-scope-mismatch');
      if (ownerEligibility(snapshot.queue, b) !== 'eligible') return no('owner-ineligible');
      for (const id of b.scope.subjectTaskIds) requireV2(snapshot.queue.tasks.some(row => canonicalTaskId(row.id) === id), 'missing-subject');
      const subjects = new Set(b.scope.subjectTaskIds);
      const eligibleSubject = snapshot.queue.tasks.some(row => subjects.has(canonicalTaskId(row.id))
        && (b.scope.kinds.includes('prioritize-existing-task') && ['pending', 'queued'].includes(row.status)
          || b.scope.kinds.includes('repair-task-currentness') && ['pending', 'queued', 'in_progress', 'delegated'].includes(row.status)));
      if (!eligibleSubject) return no('no-eligible-subject');
      if (view.runs.some(run => run.status === 'reserved')) throw new AdvisorError('busy', 3);
      if (now - view.meta.lastStartedAt < view.meta.config.minIntervalMs) return no('min-interval');
      const due = view.proposals.some(p => p.releaseId === b.ownership.releaseId && p.ownerTaskId === b.ownerTaskId
        && (p.state === 'stale' || p.state === 'deferred' && p.disposition?.deferredUntil && Date.parse(p.disposition.deferredUntil) <= now));
      if (view.meta.lastQueueDigest === snapshot.digest && !due) return no('unchanged-snapshot');
      if (b.budget.maxWallMs === 0 || view.allocationTotal >= b.budget.maxRunsTotal || view.allocationDay >= b.budget.maxRunsPerUtcDay || view.workspaceDay >= view.meta.config.maxRunsPerUtcDay) return no('budget-exhausted');
      const latest = readQueue(this.workspace, view.meta.config); requireV2(latest.digest === snapshot.digest, 'input-changed', 3);
      const day = new Date(now).toISOString().slice(0, 10), runId = randomUUID();
      const owner = snapshot.queue.tasks.find(row => canonicalTaskId(row.id) === b.ownerTaskId)!;
      const run: Run = { id: runId, generation: view.meta.storeRevision + 1, bindingId: b.id, bindingRevision: b.revision, configRevision: view.meta.configRevision,
        queueDigest: snapshot.digest, ownerRowDigest: hashJson(owner), startedAt: now, deadline: now + 2000, status: 'reserved',
        proposalRevisions: Object.fromEntries(view.proposals.map(p => [p.dedupKey, p.revision])) };
      this.sql().prepare('UPDATE allocations SET total=total+1 WHERE id=?').run(b.budget.allocationId);
      this.sql().prepare('INSERT INTO allocation_days VALUES(?,?,1) ON CONFLICT(allocationId,day) DO UPDATE SET used=used+1').run(b.budget.allocationId, day);
      this.sql().prepare('INSERT INTO workspace_days VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=used+1').run(day);
      this.sql().prepare('INSERT INTO runs VALUES(?,?,?)').run(run.id, run.status, JSON.stringify(run));
      this.sql().prepare('UPDATE meta SET clockHighWater=?,lastStartedAt=? WHERE id=1').run(now, now);
      const input: AnalysisInputV2 = { schemaVersion: 2, queue: snapshot.queue, queueDigest: snapshot.digest, rawByteCount: snapshot.bytes,
        ownerRowDigest: run.ownerRowDigest, binding: b, bindingRevision: b.revision, now: new Date(now).toISOString(), runId };
      // Keep the complete queue in process memory only; replay stores the reservation
      // identity, never another copy of raw private queue metadata.
      void input;
      return commandResult(requestId, 'applied', view.meta.storeRevision + 1, 'reserved', { run, binding: b, config: view.meta.config });
    }, true);
  }
  publish(requestId: string, reserved: Run, proposals: ProposalV2[], snapshot: Snapshot): CommandResult {
    return this.transaction(requestId, ['publish', reserved, proposals.map(p => [p.dedupKey, p.evidenceDigest]), snapshot.digest], view => {
      const now = Date.now(), run = view.runs.find(row => row.id === reserved.id), b = view.binding;
      requireV2(run?.status === 'reserved' && run.generation === reserved.generation, 'run-fenced', 3);
      const current = readQueue(this.workspace, view.meta.config);
      const owner = b ? current.queue.tasks.find(row => canonicalTaskId(row.id) === b.ownerTaskId) : undefined;
      const valid = b && !view.suspended && b.revokedAt === null && now >= Date.parse(b.notBefore) && now < Date.parse(b.expiresAt)
        && now >= view.meta.clockHighWater && now < run.deadline && view.meta.desiredEnabled && b.revision === run.bindingRevision
        && b.id === run.bindingId && view.meta.configRevision === run.configRevision && current.digest === run.queueDigest
        && snapshot.digest === run.queueDigest && owner && hashJson(owner) === run.ownerRowDigest && ownerEligibility(current.queue, b) === 'eligible';
      if (!valid) {
        run.status = 'discarded'; run.generation++; this.saveRun(run);
        return commandResult(requestId, 'no-work', view.meta.storeRevision + 1, 'publication-fenced');
      }
      this.capacity(view.meta.config, true, Buffer.byteLength(JSON.stringify(proposals)) + 8192);
      let emitted = 0;
      for (const candidate of proposals) {
        requireV2(candidate.provenance.runId === run.id && candidate.provenance.queueDigest === run.queueDigest && candidate.provenance.bindingRevision === b.revision, 'invalid-proposal');
        const prior = view.proposals.find(p => p.dedupKey === candidate.dedupKey);
        // A review or maintenance revision after reservation wins this race.
        if ((prior?.revision ?? 0) !== (run.proposalRevisions[candidate.dedupKey] ?? 0)) continue;
        if (prior?.state === 'rejected') continue;
        if (prior?.disposition?.deferredUntil && Date.parse(prior.disposition.deferredUntil) > now) continue;
        if (prior?.evidenceDigest === candidate.evidenceDigest) continue;
        if (prior) { candidate.id = prior.id; candidate.revision = prior.revision + 1; }
        this.saveProposal(candidate); emitted++;
      }
      run.status = 'published'; this.saveRun(run);
      this.sql().prepare('UPDATE meta SET lastQueueDigest=?,clockHighWater=? WHERE id=1').run(run.queueDigest, now);
      return commandResult(requestId, 'applied', view.meta.storeRevision + 1, emitted ? 'published' : 'no-proposals', { emitted, runId: run.id });
    }, true);
  }
  review(requestId: string, id: string, expected: number, decision: 'reject' | 'defer', reason: string, until: string | null): CommandResult {
    textV2(reason, LIMITS.text); if (until !== null) utcV2(until);
    return this.transaction(requestId, ['review', id, expected, decision, reason, until], view => {
      const p = view.proposals.find(p => p.id === id); requireV2(p && p.revision === expected, 'revision-conflict', 3);
      requireV2(p.state !== 'rejected', 'terminal-proposal', 3);
      const now = Math.max(Date.now(), view.meta.clockHighWater);
      requireV2(decision === 'reject' ? until === null : until !== null && Date.parse(until) > now && Date.parse(until) - now <= LIMITS.maxDeferMs, 'invalid-defer');
      const decisionId = randomUUID();
      this.sql().prepare('INSERT INTO decisions VALUES(?,?,?,?)').run(decisionId, id, requestId, JSON.stringify({
        id: decisionId, proposalId: id, proposalRevision: expected, requestId, kind: decision, reason, until,
        actor: { id: 'local-cli', verified: false }, at: new Date(now).toISOString() }));
      p.revision++; p.state = decision === 'reject' ? 'rejected' : 'deferred'; p.disposition = { decisionId, reason, deferredUntil: until };
      if (decision === 'defer' && Date.parse(p.expiresAt) <= now) { p.state = 'stale'; p.currentness.status = 'stale'; }
      this.saveProposal(p);
      return commandResult(requestId, 'applied', p.revision, decision === 'reject' ? 'rejected' : 'deferred');
    });
  }
  lease(requestId: string, expected: number, token: string, action: 'acquire' | 'renew' | 'stop'): CommandResult {
    return this.transaction(requestId, ['lease', expected, token, action], view => {
      const now = Date.now(), lease = view.host;
      requireV2(lease.generation === expected, 'host-fenced', 3);
      if (action !== 'stop') {
        requireV2(now >= view.meta.clockHighWater, 'clock-rollback', 4);
        requireV2(action === 'acquire' ? lease.token === null || lease.expiresAt <= now : lease.token === token && lease.expiresAt > now, 'host-busy-or-fenced', 3);
      }
      const generation = action === 'renew' ? expected : expected + 1;
      this.sql().prepare('UPDATE host SET generation=?,token=?,heartbeat=?,expiresAt=? WHERE id=1').run(generation, action === 'stop' ? null : token, now, action === 'stop' ? 0 : now + 15_000);
      if (action === 'stop') this.fenceRuns(view);
      return commandResult(requestId, 'applied', generation, action === 'stop' ? 'host-stopped' : 'host-leased');
    });
  }
}
export function storageError(error: unknown): AdvisorError {
  if (error instanceof AdvisorError) return error;
  const sqlite = error as { errcode?: number; code?: string };
  if (sqlite.errcode !== undefined && (sqlite.errcode & 255) === 5) return new AdvisorError('busy', 3);
  if (sqlite.errcode !== undefined && (sqlite.errcode & 255) === 8) return new AdvisorError('readonly-recovery-required', 5);
  return new AdvisorError('storage-error', 5);
}
