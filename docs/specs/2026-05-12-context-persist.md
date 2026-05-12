# SPEC — ADR-MF #5 Persist immutable SessionContext at spawn

- Status: DRAFT (E-coder-mf5-persist, 2026-05-12)
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.2 + §4.8.{1,2,3} + §6 task #5
- Depends on:
  - commit `d06e9cb` — `src/session/types.ts` (`SessionContext`, `Role`, `LayerMeta`) — ADR-MF #3 / #99
  - commit `c24647b` — `src/session/persistence/{canonical-bytes,atomic-write,index-lock,crash-recovery}.ts` — ADR-MF #14 / #101
- Out of scope: L2 `AgentRecord` persistence, GC / pruning (Q-OPEN-5), Windows fallback (Phase 2 per #14), MCP `Spawn` API contract (#3 future), warn-mode telemetry (#9), boot adapter integration (#13), `effective_prompt.md` / `lineage.json` writers (owned by #13/#15).
- Constitution: Article 1 경량 (impl src ≤ 300 LOC, tests ≤ 250 LOC), Article 17 무의존 (TS strict, node stdlib + #14 only), Rule 29 외과적 변경 (#14 untouched; reused as-is).

---

## 1. Why this module exists

ADR §4.8 promises every spawn produces an **immutable on-disk snapshot** under `~/.aigentry/sessions/{session_id}/` such that: (1) the snapshot is reproducible (`sha256` over canonical bytes); (2) two writes of the same `session_id` with different bytes are rejected (`MUTATION_BLOCKED`) — append-only invariant from §4.2 + §4.8.3; (3) `index.json` SSOT lists every session and is concurrency-safe across rapid spawns (cycle detection in §4.6 reads this); (4) crashes leave only sweepable `*.tmp.*` artefacts, never half-written `context.json`.

#14 ships the **primitives** (canonical bytes, atomic write, index lock, crash sweep). This SPEC binds them into the **persistence policy** the spawn pipeline calls. Output consumed by #15 (spawn gate), #13 (boot adapter), and operational tools.

---

## 2. Scope discipline — #5 vs #14

| Concern | Owner |
|---|---|
| Canonical encoding (UTF-8/LF/NFC/sorted-keys/sha256) | #14 (reused) |
| Atomic file replace (tmp + fsync + rename + dir-fsync) | #14 (reused) |
| Exclusive lock around `index.json` mutation | #14 (reused) |
| `*.tmp.*` sweep on startup | #14; **#5** wraps with `.recovery.log` append |
| Snapshot directory layout (`{id}/context.json`) | **#5** |
| `index.json` schema + entry shape + sorted writes | **#5** |
| Immutability gate (2nd persist different bytes → throw) | **#5** |
| `loadContext()` + sha256 round-trip validation | **#5** |
| L2 `AgentRecord` persistence | deferred |
| `effective_prompt.md` / `lineage.json` / `agents/` writers | future #13/#15 |

Rule 29: zero edits under `src/session/persistence/`. New code in `src/session/persist-context.ts` + `tests/session/persist-context.test.ts`. The `.recovery.log` wrapper lives in the new module, not inside #14.

---

## 3. Module API surface

### 3.1 `src/session/persist-context.ts`

```ts
import type { SessionContext } from "./types.js";
import type { RecoveryReport } from "./persistence/index.js";

// Filesystem layout (ADR §4.8.1). All paths POSIX absolute, NFC-normalized.
export interface PathConfig {
  sessionsRoot: string;     // e.g., os.homedir() + "/.aigentry/sessions"
  indexPath?: string;       // default: <sessionsRoot>/index.json
  recoveryLogPath?: string; // default: <sessionsRoot>/.recovery.log
}

export interface PersistResult {
  path: string;              // absolute path to the written context.json
  sha256: string;            // canonical-bytes digest of the SessionContext
  timestamp: string;         // canonicalTimestamp() — when the persist finished
  alreadyPersisted: boolean; // true on idempotent re-persist of byte-identical snapshot
}

export type PersistErrorCode =
  | "MUTATION_BLOCKED"        // existing context.json with different sha256
  | "ERR_INVALID_SESSION_ID"  // empty / contains "/" "\" ".." / leading "."
  | "ERR_INVALID_CONTEXT"     // missing required field per #99 SessionContext
  | "ERR_DIGEST_MISMATCH"     // loadContext: on-disk sha256 ≠ index-recorded value
  | "ERR_INDEX_CORRUPT"       // index.json not parseable as IndexFile
  | "ERR_IO";                 // wraps underlying fs error (cause preserved)

export class PersistError extends Error {
  readonly code: PersistErrorCode;
  readonly detail: string;
  constructor(code: PersistErrorCode, detail: string, cause?: unknown);
}

export async function persistContext(
  ctx: SessionContext, paths: PathConfig,
): Promise<PersistResult>;

// Returns null when session_id is unknown (no directory + no index entry).
export async function loadContext(
  sessionId: string, paths: PathConfig,
): Promise<SessionContext | null>;

// Wraps #14 sweepIncompleteWrites; appends a JSONL line to .recovery.log.
export async function recoverCrashedWrites(paths: PathConfig): Promise<RecoveryReport>;
export type { RecoveryReport };
```

### 3.2 Index schema — `<sessionsRoot>/index.json`

```ts
export interface IndexEntry {
  id: string;               // session_id
  path: string;             // absolute path to context.json (realpath-resolved)
  parent_id: string | null; // SessionContext.parent_id ?? null
  created_at: string;       // SessionContext.created_at (ISO-8601 +00:00)
  sha256: string;           // canonical-bytes digest of the persisted context.json
}
export interface IndexFile {
  schema_version: 1;
  sessions: IndexEntry[];   // sorted by id ascending (deterministic on disk)
}
```

Encoded via `canonicalBytes(IndexFile)` then `atomicWrite(indexPath, bytes, {sessionId: "__index__"})` inside `withIndexLock(indexPath, ...)`. canonical-bytes only sorts object keys; this module sorts `sessions[]` by `id` before encoding so array order is deterministic too.

Idempotent re-persist: if an entry with the same `id` exists and `entry.sha256 === new.sha256`, it is left untouched (no rewrite). Different-sha256 → `MUTATION_BLOCKED` thrown **before** any index mutation.

### 3.3 Snapshot directory contents

```
~/.aigentry/sessions/{session_id}/
├── context.json            # this SPEC writes
├── effective_prompt.md     # reserved — written by #13/#15
├── lineage.json            # reserved — written by #15
└── agents/                 # reserved — L2 AgentRecord (ADR §4.2.1)
```

This SPEC writes only `context.json`. `SessionContext.effective_prompt_path` (commit d06e9cb) records where the resolved prompt lives — not relocated here.

---

## 4. Algorithm — `persistContext`

```
1. validate(ctx):
     session_id non-empty, no "/" "\" "..", no leading "."
     role / cwd / task_id / created_at / effective_prompt_digest present
     layers array non-empty
   else: throw PersistError("ERR_INVALID_CONTEXT" | "ERR_INVALID_SESSION_ID", ...)
2. mkdir -p <sessionsRoot>/<session_id>     (recursive, mode 0o700)
3. bytes = canonicalBytes(ctx); sha256 = sha256Hex(bytes)        # #14
4. target = <sessionsRoot>/<session_id>/context.json
   if existsSync(target):
     existingSha = sha256Hex(readFileSync(target))
     if existingSha === sha256: return { ...alreadyPersisted: true }
     else: throw PersistError("MUTATION_BLOCKED",
             "session_id=<id> existing=<existingSha> new=<sha256>")
5. atomicWrite(target, bytes, { sessionId: ctx.session_id })     # #14
6. withIndexLock(indexPath, async () => updateIndex(ctx, target, sha256))
7. return { path: target, sha256, timestamp: canonicalTimestamp(now()),
            alreadyPersisted: false }
```

`updateIndex` flow inside the lock:

```
read indexPath  (ENOENT → start with { schema_version: 1, sessions: [] })
parse IndexFile (corrupt → PersistError("ERR_INDEX_CORRUPT", ...))
if entry with same id:
  if entry.sha256 !== sha256: throw MUTATION_BLOCKED   # second-line defense
  else: return  (no rewrite)
push new IndexEntry; sort sessions by id ascending
atomicWrite(indexPath, canonicalBytes(indexFile), { sessionId: "__index__" })
```

Failure modes (pre-rename): atomic-write's catch unlinks the tmp file (#14). If rename succeeds but index update fails, `context.json` exists without an index entry → orphan, recovered by future Q-OPEN-5; left as a single `// TODO(orphan-snapshot)` marker.

---

## 5. Algorithm — `loadContext`

```
1. target = <sessionsRoot>/<session_id>/context.json
2. if !existsSync(target): return null
3. parsed = JSON.parse(readFile(target).toString("utf8"))
4. recomputed = sha256Hex(canonicalBytes(parsed))
5. expected = lookup index entry by session_id (read inside withIndexLock)
   missing → PersistError("ERR_INDEX_CORRUPT", "directory exists but no index entry")
6. if recomputed !== expected.sha256: throw PersistError("ERR_DIGEST_MISMATCH", ...)
7. return parsed as SessionContext
```

Step 5 reads the index inside `withIndexLock` (writers are exclusive; #14 has no separate read lock — acceptable for spawn rates ≤ 10/s, explicit non-goal §7).

---

## 6. Crash-recovery integration

```ts
export async function recoverCrashedWrites(paths: PathConfig): Promise<RecoveryReport> {
  const report = await sweepIncompleteWrites(paths.sessionsRoot);   // #14
  if (report.deleted.length > 0 || report.errors.length > 0) {
    const line = JSON.stringify({
      ts: canonicalTimestamp(new Date()),
      scanned: report.scanned, deleted: report.deleted, errors: report.errors,
    }) + "\n";
    await fs.appendFile(paths.recoveryLogPath ?? `${paths.sessionsRoot}/.recovery.log`, line);
  }
  return report;
}
```

`appendFile` is the only non-#14 fs call here; concurrency-safe at the kernel level (POSIX `O_APPEND`); the log is **not** part of any consistency invariant.

---

## 7. Non-goals / explicit deferrals

- **Concurrency budget.** `withIndexLock` (25ms polling, 30s timeout — #14) comfortable at ≤ 10 spawns/s; > 100 spawns/s is Phase-2 (true `flock(2)` via N-API, ADR §4.8.2).
- **Windows.** #14 throws on win32; this SPEC inherits — no win32 branch.
- **L2 AgentRecord, `effective_prompt.md`, `lineage.json` writers.** Reserved names; producers (#13/#15/future L2 work) own them.
- **Orphan snapshot detection / GC + cross-host FS semantics.** Q-OPEN-5; one `// TODO(orphan-snapshot)` marker.

---

## 8. Tests — `tests/session/persist-context.test.ts` (≥ 10 scenarios)

Each test gets a fresh `sessionsRoot = fs.mkdtempSync(os.tmpdir() + "/aigentry-mf5-")` with `afterEach` recursive cleanup. Uses `node --test`, no extra deps.

| # | Scenario | Asserts |
|---|---|---|
| T1 | Round-trip: `persistContext` → `loadContext` | deep-equal; `result.sha256 === sha256Hex(canonicalBytes(loaded))` |
| T2 | Idempotent re-persist (same bytes ×2) | second call `alreadyPersisted: true`; on-disk mtime unchanged; index has 1 entry |
| T3 | Mutation blocked: persist `ctx`, then persist `{...ctx, role: 'tester'}` same id | throws `MUTATION_BLOCKED`; on-disk `context.json` byte-identical to original |
| T4 | Crash mid-write: pre-place `<target>.tmp.<id>.<pid>` stub, run `recoverCrashedWrites` | `report.deleted.length === 1`; `.recovery.log` JSONL line parses with matching `deleted[0]` |
| T5 | Concurrent spawns, different parents: `Promise.all` of 8 distinct calls | all 8 succeed; `index.json` has 8 entries sorted by id; round-trip clean |
| T6 | Concurrent spawns, same id, different bytes: `Promise.all` of `persist(A)` + `persist(A')` | exactly 1 succeeds, other throws `MUTATION_BLOCKED`; no torn `context.json` |
| T7 | Path canonicalization: `sessionsRoot` containing symlink + `..` | persisted `index.entry.path` is realpath-resolved + normalized; `loadContext` via un-normalized root still finds it |
| T8 | Missing session: `loadContext("does-not-exist", paths)` | returns `null`, no throw |
| T9 | Corrupt context.json: hand-edit one byte after persist, then `loadContext` | throws `ERR_DIGEST_MISMATCH` |
| T10 | Invalid session_id (`""`, `"a/b"`, `".."`) | throws `ERR_INVALID_SESSION_ID`; `index.json` unchanged |
| T11 | Invalid context (missing `role`) | throws `ERR_INVALID_CONTEXT`; no directory created |
| T12 | Corrupt index.json: hand-edit to `{not:valid}`, persist new id | throws `ERR_INDEX_CORRUPT`; new `context.json` exists (write before index — Phase-1 trade per §7); subsequent `recoverCrashedWrites` does not touch it |

Backwards-compat sanity: existing `npm test` baseline (60/60) across the #99/#103/#101 suites must remain green.

---

## 9. LOC + dependency budget

| File | Est LOC | Budget |
|---|---|---|
| `src/session/persist-context.ts` | ~210 | 300 |
| `tests/session/persist-context.test.ts` | ~230 | 250 |

Deps: `node:fs{/promises}`, `node:path`, `node:os`, `node:crypto` (transitive via #14), and the four `src/session/persistence/index.ts` exports. Zero new package.json entries.

---

## 10. Open questions (non-blocking — for orchestrator)

1. **`PathConfig.sessionsRoot` default.** Inject explicitly or provide `defaultPathConfig()` (= `os.homedir() + "/.aigentry/sessions"`)? **Recommendation:** require injection; ship the helper as opt-in.
2. **`MUTATION_BLOCKED` vs idempotent retry surface.** Same-bytes ⇒ `alreadyPersisted: true`, different-bytes ⇒ throw — building block; future `Spawn` API (#3) chooses surface. **Recommendation:** keep both signals so the gate can decide.
3. **`PersistResult.timestamp` vs `ctx.created_at`.** `created_at` set by gate (#15); `timestamp` = when persist finished. Keep both; document distinction.
