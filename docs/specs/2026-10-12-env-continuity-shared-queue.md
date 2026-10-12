# ES-03 — Authoritative shared task queue (+ ES-08 intake linkage) — task #2026101204

**Status:** CONTRACT SPEC ONLY. No code, no queue edit, no migration run. Parent
#2026101204, child ES-03 (runtime alias #2026101208), ES-08 linkage (runtime alias
#2026101213). Identity contract: `docs/specs/2026-10-12-env-continuity-identity.md`
(ES-01). Decisions: `docs/adr/2026-10-12-env-continuity-identity-and-queue.md`.

**Measured** 2026-10-12 (Rule 39). The facts below were read from the files named. The
private queue was read from the orchestrator's main checkout
(`state/task-queue.json`, gitignored — `.gitignore:1`), counted with a read-only script:

| Fact | Value | Source |
|---|---|---|
| Queue shape | `{version: 2, active_focus, tracks, tasks[]}` | `state/task-queue.json` |
| Rows | 37; all `id` are integers | same |
| Linux id form | date-form `YYYYMMDDNN`, range 2026071201 … 2026101215 | same |
| Status values present | pending 12, done 11, in_progress 9, awaiting-user 3, delegated 1, blocked 1 | same |
| Link fields | `parent` (9 rows, integer), `children` (1), `linked_tasks` (9, integers), `dependencies` (9, **free-text strings** such as `"ES-01"`, `"durable store decision"`), `linked_mac_tasks` (1, strings `"1226","1229","1215"`) | same |
| Other identity fields | `dedupe_key` (1), `merged_requests` (1), `external_id` (1, value is a version string, not a task), `canonical_id` (1, `BLOCKED`, aliases runtime_id / request_keys / doc_refs) | same |
| Highest Mac id visible from Linux | 1229 (`linked_mac_tasks` of #2026101110); release projection max 1199 | queue; `release/tasks.json:6` |
| Mac queue | **not measured** (Mac offline; file not reachable) | — |

Code read: dispatch gate `src/dispatch/cli.ts:671-892`; projection
`release/tasks.json`, `release/PROJECTION.md`, `scripts/release-admission.mjs:17-27,
228-242`; control operations `src/control/contracts.ts:18-24`; telesession dedupe
`aigentry-telesession/src/transports/telepty.js:989-993`, states
`src/store.js:63`, contract `API-CONTRACT-TELESESSION.md:141-147, 180-182`; registry
transaction `aigentry-registry/src/aigentry/db/session.py:10-20`.

**Not measured:** the Mac queue's contents and max id, registry deployment, Postgres
version/isolation settings in any deployment, real multi-host latency, Windows/macOS.

---

## 0. Scope

One authoritative task store that every device of one user reads and writes through the
registry. It provides transactional claim, lease, heartbeat, fencing, crash/offline
reassignment, reconnect reconcile and idempotent mutations. It stores tasks under integer
ids that fit the existing release projection. *Who issues* those ids is an open user
decision (§3, D-Q-1): this spec presents alternatives and adopts none. It also gives
ES-08 a dedupe/receipt contract for GitHub intake.

Continuity is **reconnect/recreate, never live process migration**: a lease moves the
*right to work*. The running process does not move. A returning device's stale process
is fenced; it is not resumed.

Out of scope: team/shared queues (single owner), automatic GitHub org activation, auto
merge/deploy, exactly-once external effects (§8), ES-02/ES-04 payloads.

## 1. Authoritative store — recommendation: registry Postgres (user decision D-Q-2)

Recommended (and recorded in the ADR): new tables in the **registry's Postgres**, behind
ES-01 device auth, in the same trust boundary as the account.

Why it fits (measured): request-scoped transactions with commit/rollback already exist
(`db/session.py:10-20`). The registry is the only component with user identity
(`models/user.py`) and is already wired into devkit installs (`install.sh:666-725`,
modes `cloud | self_hosted | skip`). Postgres row locks give a single-statement
compare-and-set (§4.2).

### 1.1 Rejected: a Git-file queue (e.g. `task-queue.json` in a synced repo)

Concrete failure cases, each reproducible with two clones A and B:

1. **Double claim through a clean auto-merge.** A sets `"owner": "A"` and
   `"lease_until"` on task 7; B sets `"owner": "B"` on the same task. If the two edits
   land on different JSON lines (owner vs lease fields, as `JSON.stringify(data, null, 2)`
   writes — `cli.ts:878`), `git pull --rebase` merges without conflict. The result has A's
   lease and B's owner, so **both workers believe they hold task 7**. Nothing in Git rejects
   it.
2. **Claim is unconfirmed until push.** A claim exists only after `git push` succeeds. An
   offline or slow device has already started side effects on a local commit that later
   loses the push race (non-fast-forward). There is no atomic "claim then act".
3. **No compare-and-swap on a counter.** Fencing needs a per-task monotonic token checked
   atomically at write time. A Git rebase or force-push can rewrite history and move
   the token backwards. The only CAS in Git is the ref update of the whole file, which
   serialises every task in the queue behind one ref.
4. **Untrusted clocks.** Lease expiry needs one clock. Commit timestamps are set by the
   client, so a device with a skewed clock can extend or shorten anyone's lease.
5. **No per-user isolation, permanent history.** A repo is readable as a whole. Notes hold
   personal history (`release/PROJECTION.md:44-47`), and Git history keeps every revision
   forever, including anything mistakenly written.
6. **Offline divergence.** Two devices that edit offline produce divergent histories. The
   merge is manual and textual, not a semantic reconcile.

Today's local writer is atomic **only on one host** (temp + fsync + rename,
`cli.ts:869-881`). That is the right property for a cache, not for a multi-host authority.

### 1.2 Constitution 제6조 (local-first, opt-in sync)

- Account mode is **opt-in**: a user who never runs `aigentry-devkit login` stays in
  local-only mode, and their local `state/task-queue.json` remains the sole authority
  (§11).
- No cloud lock-in: the same API runs on a self-hosted registry (devkit `self_hosted` mode).
- Export and delete: `GET /export` returns the full queue as JSON. Deleting a queue is a
  Rule 47 operational-data deletion.

## 2. Task record schema

### 2.1 `task_queues`

| Column | Type | Notes |
|---|---|---|
| `id` | UUID pk | |
| `owner_user_id` | UUID FK users, index | ES-01 isolation key |
| `tenant_id` | UUID | informational |
| `slug` | varchar(32) | `default` unless the user creates more; unique per owner |
| `next_task_id` | bigint, CHECK `next_task_id < 1000000000` | **only if proposal P-A is chosen** (§3.2) |
| `id_floor` | bigint | P-A only: seed recorded at migration (audit) |
| `event_seq` | bigint | last event sequence (reconcile cursor) |
| `created_at` | timestamptz | |

### 2.2 `tasks` (primary key `(queue_id, id)`)

| Column | Type | Maps from today's row |
|---|---|---|
| `queue_id`, `id` | UUID, bigint | `id` = the task's integer under the scheme chosen in D-Q-1 (§3); unique per queue under every proposal |
| `owner_user_id` | UUID | — |
| `title` | varchar(200) | `title` (else first line of `desc`) |
| `desc` | text | `desc` |
| `kind`, `track` | varchar(48) | `kind`, `track` |
| `status` | varchar(32) | `status`; vocabulary below |
| `priority` | varchar(8) | `priority` (`P0`..`P3`) |
| `parent_id` | bigint null, FK same queue | `parent` |
| `release_group` | varchar(64) null | e.g. `release-1199` (`release/tasks.json:3`) |
| `release_component` | varchar(80) null, CHECK `^[a-z0-9]+(?:-[a-z0-9]+)*$` | projection slug (`release-admission.mjs:17`) |
| `release_candidate` | text null | `release_candidate` (free text, private) |
| `dedupe_key` | varchar(160) null, unique per queue | `dedupe_key` |
| `spec_ref` | jsonb null | `spec`/`doc_ref` (paths + sha256) |
| `owner_note` | text null | free-text `owner` (who is responsible — **not** the lease holder) |
| `version` | bigint | optimistic concurrency for non-lease edits |
| **lease** `lease_device_id` | UUID null | ES-01 `devices.id` |
| `lease_label` | varchar(64) null | opaque worker label chosen by the holder (e.g. role), no host names |
| `lease_expires_at` | timestamptz null | server clock |
| `fencing_token` | bigint not null default 0 | §5 |
| `claimed_at`, `last_heartbeat_at` | timestamptz null | |
| `completed_at`, `completed_by_device_id`, `completed_fencing_token` | | |
| `created_at`, `created_by_device_id`, `updated_at` | | |

Lists are separate tables, not JSON arrays:

- `task_links(queue_id, from_id, to_id, kind)` where `kind ∈ parent | depends_on |
  linked | supersedes | analysis_of | review_of`. `children` is derived from `parent`
  and is never stored twice. Today's integer `linked_tasks` → `linked`. Today's
  free-text `dependencies` → `depends_on` when the text resolves to a task or alias,
  otherwise kept verbatim in `task_dependency_notes(queue_id, task_id, text)`. They are
  never dropped (Rule 50 §4).
- `task_aliases(queue_id, kind, value, task_id)`, unique `(queue_id, kind, value)` (§3.3).
- `task_events` — append-only audit and notes (§10).
- Fields not modelled above (`§1.2_question/answer`, `spawn_decisions`, `phase`,
  `progress_ids`, `local_state`, `merged_requests`, `approval`, `estimate`, `blockers`,
  `canonical_id`, `issue`, `pr`) are kept **losslessly** in `extra jsonb` on migration. Each
  can be promoted to a column later. Today's free-text `note` becomes `note` events (§10).

Status vocabulary = today's set, unchanged, so the gate's sets still apply
(`cli.ts:682-683`): dispatchable `pending | queued | in_progress | delegated |
blocked-by-observation`; terminal `done | completed | superseded | cancelled | closed`;
other `blocked | awaiting-user`. **Lease state is orthogonal to status**: an
`in_progress` task may have no live lease (holder crashed), which is exactly what makes it
reassignable.

### 2.3 Projection compatibility

`release/tasks.json` entries are exactly `{id, release_component}` with `id` a positive
safe integer, unique (`release-admission.mjs:23, 236-241`; `PROJECTION.md:20-30`). Under
each of the three proposals in §3.2, every task has a positive integer `id` (P-C keeps
10-digit date-form ids, which are also valid) and an optional `release_component` that
obeys the same regex. Any subset therefore projects without a schema change.
`provisional` tasks have no integer id yet and cannot be projected. The projection stays
hand-authored and hand-reviewed (`PROJECTION.md:44-58`). The "private task queue" it
names as the sole authority is now this server queue. That sentence needs a one-line doc
update at implementation time; no generator is added.

## 3. Canonical ID allocation

> **Status of this section (orchestrator guardrail 2026-10-12 13:59Z):** findings, then
> design alternatives, then a decision the user must take. **No issuance scheme here is
> adopted. No ID is issued and no migration happens** until the Mac's authoritative
> ledger/allocator and the concurrent-issuance and mapping analysis have been reviewed
> (§3.4). The dispatch's wording "server-issued monotonic integers seeded from the
> existing Mac queue sequence" is **one alternative (P-A)**, not an existing standard.

### 3.1 Findings

**Exists (measured):**

- Every Linux row `id` is an integer in date form `YYYYMMDDNN` (37 rows, 2026071201 …
  2026101215 — `state/task-queue.json`).
- The release projection accepts any positive safe integer, unique within the file, and
  nothing else (`release/PROJECTION.md:20-30`; `scripts/release-admission.mjs:23,
  236-241`). It does not say who issues IDs.
- The dispatch gate looks a task up by `String(id) === taskId` and refuses when an ID
  matches two rows (rc 5) (`src/dispatch/cli.ts:735-741, 764-788`). It validates
  existence and status only, not issuance.
- Observed: integers below 10⁴ appear in Linux-visible artefacts. They are projection IDs
  652 and 1195–1199 (`release/tasks.json`) and `linked_mac_tasks` `"1215","1226","1229"` on
  #2026101110 (stored as strings). **Their issuer was not measured.**
- The parent row records the same gap: `canonical_id.status = "BLOCKED"`, "No canonical
  task-ID allocator is defined anywhere measured … Integer ids have been issued informally
  from the Mac orchestrator's queue, which is offline", with aliases `runtime_id`,
  `request_keys` and `doc_refs` (`state/task-queue.json`, row 2026101204). What is measured
  is that the row *says* this. The statement itself is a record written by a previous
  session, not a measurement of the Mac.

**Searched and not found (re-measured 2026-10-12):** an ID allocator or issuance rule in
`docs/rules.md`, `AGENTS.md`, `.agents/skills/orchestrate-turn/SKILL.md`, `bin/tq-*.sh`
(read and sort only; the one write sets `active_focus` — `bin/tq-focus.sh:19`) and
`release/PROJECTION.md`. `task.create` exists only as a *pending*, refused operation
(`src/control/contracts.ts:21-24`).

**Could not be measured:**

- The Mac queue: its contents, its maximum ID, whether IDs are issued by a counter, by
  hand, or by `max+1`, and whether gaps or duplicates exist. The Mac is offline.
- Whether any ID below 10⁹ was ever issued on Linux, or any date-form ID on the Mac.
- Whether other hosts or tools issue IDs.

**Inference (not measured):**

- The integers below 10⁴ were probably issued by the Mac queue. This rests on the
  `linked_mac_tasks` field name and the parent row's note, not on reading the Mac.
- If so, two hosts mint IDs independently (Linux date-form, Mac small integers), and
  no coordination rule was found (see "Searched and not found"). Whether the Mac follows
  an unwritten coordination practice was not measured. The two *observed* forms differ in
  magnitude. That separates them by convention, not by a rule anyone enforces.

### 3.2 Proposals (alternatives — none adopted)

All three keep the projection valid (positive integer `id`) and keep every existing ID
reachable through aliases (§3.3). They differ in **who issues the ID** and **what happens
under concurrency or when the issuer is offline**.

**P-A — Server-issued, per-queue monotonic counter (registry Postgres)**

- Issuance: inside the create transaction,
  `UPDATE task_queues SET next_task_id = next_task_id + 1 WHERE id = :q AND owner_user_id = :u RETURNING next_task_id - 1`.
  The row lock serialises concurrent creates, so two devices can never receive the same
  ID. IDs are never reused. A rolled-back create also rolls back the counter.
- Seed: `max` over all small-integer IDs from the **Mac ledger**, Linux references and
  release files, plus 1. The Linux-visible lower bound is 1230, but this is **not
  sufficient**: the Mac ledger must be read.
- Range guard: `id < 10⁹`, so date-form runtime IDs (10 digits) stay disjoint.
- Offline: a device without the server cannot get an ID. It creates with a `provisional`
  alias and gets the canonical ID on reconnect (§9.3).
- Migration: Mac rows keep their IDs. Linux rows get new IDs; the date-form ID becomes a
  `runtime_id` alias.
- Risk: the seed is only as good as the Mac read. Any Mac ID issued after the seed but
  before cutover collides. This needs a freeze window on the Mac (no new IDs from
  measurement until M4).
- Per-queue rather than global: IDs do not leak other users' activity. A guessed ID only
  resolves in the caller's own queue (ES-01 §7.4).

**P-B — Mac ledger stays the issuer; the server mirrors it**

- Issuance: only the Mac orchestrator's ledger mints integer IDs, exactly as now but
  written down as a rule. The server stores tasks under those IDs and enforces uniqueness
  (`(queue_id, id)` primary key) as a mirror and lease authority. Linux and other devices
  request an ID from the Mac (via telepty with an ACK, or via the server as a relay).
- Concurrency: safe only if the Mac issues sequentially and the server rejects a
  duplicate ID (`ID_TAKEN`). If two Mac processes or a restored Mac backup re-issue an
  ID, the server's uniqueness check is the only guard. The mirror must refuse rather than
  overwrite.
- Offline: whenever the Mac is asleep, which is the common case per the requirements
  ("수시로 꺼지는 Mac"), **no device can obtain a canonical ID**. Linux works on
  `provisional` aliases until the Mac returns. The release projection cannot name
  provisional tasks.
- Migration: minimal for Mac rows. Linux rows wait in `provisional` until the Mac issues.
  The Mac ledger and the server can disagree, so a reconcile procedure for the mirror is
  needed.
- Risk: availability is coupled to the least available machine. This keeps today's
  informal practice and makes it explicit.

**P-C — Partitioned issuance (no central counter)**

- Issuance: each issuer owns a disjoint integer range. For example, the Mac keeps
  `< 10⁹`, and Linux keeps date-form `YYYYMMDDNN` as canonical with its own per-day
  counter. The server enforces the ranges and uniqueness but does not mint.
- Concurrency: safe across hosts by construction. Within a host, the local counter must
  still be atomic; today Linux has no such counter, as IDs are chosen by the writer.
- Offline: every host can issue offline, so this has the best availability.
- Migration: none for existing IDs. They are already canonical under this rule, with
  aliases only for request keys, GitHub issues and doc refs.
- Risk: two ID shapes stay permanent. Release projections mix 3–4-digit and 10-digit IDs
  (valid syntax, but less readable). Adding a third device needs a new range allocation
  rule.

| | P-A server counter | P-B Mac ledger + mirror | P-C partitioned ranges |
|---|---|---|---|
| Duplicate ID across hosts | impossible (row lock) | prevented only by mirror uniqueness check | impossible if ranges are enforced |
| Issue while Mac offline | yes (if server is up) | **no** | yes |
| Issue while server offline | no (provisional) | Mac only | yes |
| Existing ID changes | Linux rows → new ID + alias | Linux rows → provisional, then Mac ID | none |
| Needs Mac ledger read before go-live | yes (seed) | yes (it *is* the issuer) | yes (range check for overlap) |
| New moving parts | counter row | Mac allocator API + mirror reconcile | range table + per-host atomic counter |

### 3.3 Aliases (needed under every proposal)

| `kind` | Value format | Example source |
|---|---|---|
| `runtime_id` | decimal date-form ID | Linux `id` 2026101204 (P-A/P-B; under P-C it is the canonical ID) |
| `mac_id` | decimal | only if a Mac ID ever has to be renumbered on collision |
| `github_issue` | `owner/repo#N`, lowercase owner/repo | `issue` URLs; ES-08 |
| `request_key` | verbatim, ≤160 chars | `kkoma-bind-release-20261012-1241` (`merged_requests`) |
| `doc_ref` | `<parent id>:<ref>` | `ES-01` under #2026101204 |
| `provisional` | client UUID | offline create (§9.3) |

`GET /tasks/resolve?ref=<alias or id>` returns the task's ID or 404. Uniqueness
`(queue_id, kind, value)` makes alias resolution unambiguous. The gate's rc 5 path
(`cli.ts:773-774`) remains for the local cache.

### 3.4 DECISION REQUIRED BY USER — D-Q-1 (Rule 47: operational data change)

**No issuance scheme is final and no migration happens before the Mac authoritative
ledger/allocator and the concurrent-issuance/mapping analysis are reviewed.** Required
inputs before the user decides:

1. A byte copy plus sha256 of the Mac queue, read when the Mac is online. This gives its
   maximum ID, how IDs were minted, and any duplicates or gaps.
2. A dry-run `mapping.json` for the chosen proposal: every Linux and Mac row, link, alias
   and free-text dependency, with field-loss = 0. It must also list every collision
   between the two ledgers.
3. A freeze agreement: neither host mints IDs between the measurement and the cutover
   (P-A/P-B).

Summary of the §3.2 table, with no ranking:

- P-C has the best issuance availability (yes in both offline rows) and renumbers no
  existing ID, but keeps two ID shapes and needs a per-host atomic counter and range rules.
- P-A has one issuer and one ID shape, but cannot issue while the server is offline, and
  its seed depends on reading the Mac.
- P-B keeps the Mac as issuer, but cannot issue while the Mac is offline, and needs a new
  cross-host request path (below).

All three still need the store import M1–M5 (§3.5) if D-Q-2 is adopted.

**Consequences that belong to the choice itself, with no default:**

- P-B adds a **new cross-host path**: non-Mac devices request IDs from the Mac (via
  telepty or via the server as a relay). That is a network change. It conflicts with
  D-ID-4 ("no new relay") unless the user approves the path as part of choosing P-B.
- P-B and P-C put issuance logic outside the registry: in the Mac orchestrator (P-B) or in
  every host's client (P-C). See the ADR §4 제4조 assessment.

Until D-Q-1 is decided, the rest of this spec treats `id` as "the task's canonical
integer under the chosen scheme". The server schema keys tasks by `(queue_id, id)` and
enforces uniqueness under all three proposals. The `next_task_id` column (§2.1) exists
only under P-A.

### 3.5 Migration steps (apply only after D-Q-1; shown for the chosen proposal)

Each step is reversible until M5. M3 and M5 are Rule 47 operational-data changes.

| Step | Action | Output |
|---|---|---|
| M1 backup | Byte-copy both queue files; record sha256 | backups + hash list |
| M2 dry-run | Read-only mapper produces `mapping.json` per §3.4(2) | report for human review |
| M3 import | One transaction: queue row; rows under the chosen scheme; aliases; links; dependency notes; one `migrated` event per task carrying the source file hash and the source row's sha256 | server queue |
| M4 cutover | Local writers stop (manual edits; the dispatch auto-ledger `cli.ts:835-892` switches to the event API). The local file is rewritten by the lease keeper only, as a cache (§11) | cache with canonical IDs + `aliases` per row |
| M5 freeze | Old files renamed `*.pre-migration`, read-only, **not deleted** | |

Existing `parent`/`children` of #2026101204 (children 2026101206…2026101214) become
`parent` links. `children` is derived. Free-text `dependencies` such as `"ES-01"`
resolve through `doc_ref` aliases. Strings that cannot be resolved (`"durable store
decision"`) remain dependency notes.

Rollback before M5: discard the server queue; local files are untouched. After M4:
`GET /export` → regenerate a local file in today's shape with `aliases`. This is lossless.

### 3.6 What the `--task` gate validates after migration

**Today, as measured (orchestrator `71cc2da`).** Two layers must not be mixed:

- *Internal* results of `taskQueueStatus` (`cli.ts:764-788`): 0 dispatchable, 2 queue
  unreadable (`:769`), 3 unknown id (`:782`), 4 terminal or archived (`:780`, `:787`),
  5 non-dispatchable status (`:787`).
- *Process exit codes*: internal 2, 3, 4 and 5 all go to `taskGateReject`
  (`cli.ts:810-826`). It exits **4** in `hard` (`:731`), and in `warn` it prints and audits
  and **proceeds** (`:726-729`). In `off` it proceeds silently (`:725`). Process exit **5**
  from the gate means *ambiguous id* (`:774`). It is mode-independent (`:748-751`).
  `--task` with `--no-task`, and an empty `--no-task` reason, exit 4 in every mode
  (`:791-798`).
- Exit codes already used elsewhere in `cli.ts`: 1 and **6** (`waitForReady`: ready
  timeout / never registered, `:1123-1141`, exited at `:1335`), 2, 3 (`:1338`, `:1395`), 4,
  5 (also `DELIVERY_FAILED` after transport, `:1418`), 7, 8, 9, 10, 78. **6 is taken**, so
  the lease refusal cannot be "rc 6".
- The gate runs at `cli.ts:1260`, before the sid is derived (`:1262-1277`), the read-only
  dedup query (`:1285-1294`), spawn (`:1310-1312`), readiness and ref staging
  (`:1328-1347`), and the durable `beginDelivery` (`:1351-1373`). Its own comment says it
  runs "BEFORE any side effect" (`:675-676`).
- The ledger promotes only `pending|queued → delegated` and never regresses `in_progress`
  (`:854-855`). It runs after the inject (`:1424`) and is best-effort (`:887-891`).

**After migration, in account mode.** The read-only gate stays where it is. The claim is a
separate *lease step* later in the pipeline:

1. **Resolve (gate, `:1260`, read-only).** `--task <ref>` accepts the canonical ID, any
   `runtime_id`, or an explicit alias (`gh:owner/repo#N`, `req:<key>`). It is resolved on
   the server (`/tasks/resolve`) through the lease keeper (§5.1). The ledger records both
   forms.
2. **Status (gate, read-only).** Same sets as today (`cli.ts:682-683`). Unknown, terminal
   and non-dispatchable still go through `taskGateReject`, so they keep today's mode
   behaviour: exit 4 in `hard`; proceed in `warn`/`off`. A dispatch that proceeds this way
   takes **no** lease and writes no `dispatched` event, which matches today, where such a
   dispatch has no row to ledger.
3. **Lease view (gate, read-only).** If the task shows a live lease of **another device**,
   the gate exits **11** `TASK_LEASE_HELD`, showing that device's *name* and remaining TTL.
   Exit 11 is **mode-independent**, like the ambiguity exit 5, and for the same reason.
   `AIGENTRY_TASK_GATE` sets how strict the gate is about a known row's status. It cannot
   authorise two devices to work on one task. `warn` and `off` do not bypass it.
4. **Lease unavailable (gate, read-only).** If the server is unreachable, the gate may use
   the local cache only when `synced_at` is less than 10 min old **and** the cached row
   shows this device as the holder with `lease_remaining` > 0 at sync time. Otherwise it
   exits **12** `TASK_LEASE_UNAVAILABLE`, mode-independent, and never claims offline. In
   account mode, the escape hatches are the existing audited `--no-task "<reason>"`
   (`:794-800`), which dispatches with no task and no lease, or leaving account mode.
   `warn`/`off` are not escape hatches here, because a dispatch without a lease is exactly
   the double-dispatch the lease prevents.
5. **Claim (lease step; new; the only queue side effect).** It sits after the sid exists
   and after the read-only dedup and retry checks (`cli.ts:1285-1308`), and before
   `resolveRoute`/spawn (`:1310-1312`). So a refused claim leaves no spawned worker, which
   keeps the intent of `:675-676`. The step asks the lease keeper to `claim` with
   idempotency key `dispatch:<task>:<sid>` and `promote_to=delegated` (§4.2), and to
   *attach* the sid to the lease. Outcomes:
   - `HELD`, from a race since the gate's view → exit 11, as in (3).
   - Server unreachable → exit 12.
   - Success → continue.
6. **Exit after the claim.** What happens to the attachment depends on how the process
   ends:
   - **Exit before any transport write** (`:1335` 1/6, `:1338` 3, the 2/78 spawn and
     staging failures, `beginDelivery` 9 or 4 `DISPATCH_RETRY_REFUSED` `:1355`): an exit hook
     **detaches** the sid. If no other sid of this device is attached, the keeper
     `release`s with `status_after=unchanged`. The status that `promote_to` set stays
     `delegated`, which is the same imprecision today's local ledger has for a failed
     dispatch. If the hook itself cannot run (`kill -9` of `dispatch.sh`), the attachment
     stays `pending_delivery`. The keeper drops `pending_delivery` attachments after 10 min,
     and the lease then expires at TTL. That is the deliberate TTL fallback.
   - **Exit 8 `DISPATCH_DEDUPLICATED`** (`:1362`): a prior delivery with the same sid
     landed. The claim was the same idempotent request, so the attachment is the prior
     one's. It is **kept**.
   - **Exit 7 `DISPATCH_RETRY_HELD` / `DELIVERY_UNKNOWN`** (`:1366-1368`, `:1402-1404`,
     `:1413-1415`), exit 3 after a failed inject that is recorded as `unknown`
     (`:1388-1395`; the same number as the pre-transport `:1338`, so the hook must tell them
     apart by the pipeline stage, not by the exit code), and exit 5 `DELIVERY_FAILED`
     after transport (`:1418-1420`): the worker may be running. The
     attachment is marked `delivery_unknown` and **kept**. It is shown in ES-07 until the
     operator resolves it with `detach` or `complete`. It is never dropped automatically.
   - **Exit 0:** the attachment becomes `delivered`.
7. **Status a dispatch produces.** With `promote_to=delegated`, the claim promotes only
   `pending|queued → delegated` and leaves every other status unchanged. That is today's
   ledger rule (`cli.ts:855`), now applied on the server in the claim statement. A dispatch
   never sets `in_progress`. `in_progress` is set by an explicit `update` from the
   orchestrator, just as the orchestrator sets it by hand today.
8. **Ledger.** The dispatch note/`spawn_decisions` write (`cli.ts:853-868`) becomes a
   `dispatched` event carrying the fencing token. It stays best-effort *after* the inject,
   as today (`cli.ts:887-891`).

In **local-only mode** none of (3)–(7) applies, and the gate is exactly today's code.
Q-15 tests this contract.

## 4. API operations

Base: `/api/v1/queues/{slug}/tasks` (registry). Auth: ES-01 device bearer only. Every
mutation: `Idempotency-Key` header (§7) and the in-transaction device-active check (ES-01
§7.2). Not-owned and not-found are both 404 (ES-01 §7.4).

| Op | Request (beyond auth) | Success | Rejections |
|---|---|---|---|
| `create` | `title, desc?, kind, track, priority, parent_id?, depends_on[]?, release_group?, release_component?, aliases[]?, dedupe_key?, status? (pending default)` | `{id, version, deduplicated}` | `DEDUPE_KEY_EXISTS` returns the existing id with `deduplicated: true`; `ALIAS_TAKEN`; `PARENT_NOT_FOUND` |
| `get` | id or `?ref=` alias | task + links + aliases + lease view `{device_name, label, remaining_s, fencing_token}` | 404 |
| `list` | `status, parent_id, held_by=me\|any, release_group, updated_since_seq, cursor, limit≤200` | page + `next_cursor` + `event_seq` | — |
| `claim` | `ttl_s (60–3600, default 600), label?, promote_to? ∈ {delegated} (absent = status unchanged), allow_open_deps?: {reason}` | `{fencing_token, lease_remaining_s, status, new_lease}` | `HELD` (live lease of another device), `NOT_DISPATCHABLE`, `DEPENDENCIES_OPEN` |
| `heartbeat` | `fencing_token, ttl_s?, progress?` (≤2 KiB) | `{lease_remaining_s}` | `FENCED`, `LEASE_EXPIRED`, `NOT_HOLDER` |
| `release` | `fencing_token, status_after ∈ {unchanged, pending, blocked, awaiting-user}, note?` | `{status}` | same as heartbeat |
| `complete` | `fencing_token, status ∈ {done, cancelled, superseded}, evidence {commits[], prs[], reports[], checks[]}, note` | `{status, completed_fencing_token}` | same as heartbeat; `EVIDENCE_REQUIRED` for `done` with empty evidence |
| `update` | `expected_version` + non-lease fields (priority, desc, links, release binding, aliases) | `{version}` | `VERSION_CONFLICT` (returns current) |
| `annotate` | `type ∈ note \| late_report \| stale_execution \| dispatched, body ≤16 KiB, fencing_token?` | `{event_seq}` | — (allowed for any owner device, so evidence is never refused) |
| `events` | `since_seq, limit` | ordered events | — |
| `export` | — | full queue JSON | — |

`complete` with `done` records completion evidence. It does not prove production
completion (Rule 45/50 §2): the release state lives in the release projection and
manifests, not in this field.

### 4.1 Lease view

Other devices of the same user see who holds a task (device *name*, label, remaining
seconds). Device names are user-chosen (ES-01 §3.1). No host names or addresses are
stored.

### 4.2 Transactional claim (single statement)

A lease belongs to a **device**, not to a worker. All workers and dispatches of one device
share it (§3.6), and fencing separates devices. In the statement below, `live_mine` means
"this device already holds a live lease". It is evaluated on the old row, as Postgres
evaluates every `SET` expression against the pre-update row.

```sql
UPDATE tasks
   SET fencing_token    = CASE WHEN lease_device_id = :d AND lease_expires_at > now()      -- live_mine
                               THEN fencing_token ELSE fencing_token + 1 END,
       lease_expires_at = CASE WHEN lease_device_id = :d AND lease_expires_at > now()
                               THEN GREATEST(lease_expires_at, now() + make_interval(secs => :ttl))
                               ELSE now() + make_interval(secs => :ttl) END,
       claimed_at       = CASE WHEN lease_device_id = :d AND lease_expires_at > now()
                               THEN claimed_at ELSE now() END,
       lease_device_id = :d, lease_label = COALESCE(:label, lease_label),
       last_heartbeat_at = now(),
       status = CASE WHEN :promote_to = 'delegated' AND status IN ('pending','queued')
                     THEN 'delegated' ELSE status END,
       version = version + 1, updated_at = now()
 WHERE queue_id = :q AND id = :t AND owner_user_id = :u
   AND status IN ('pending','queued','in_progress','delegated','blocked-by-observation')
   AND (lease_device_id IS NULL OR lease_expires_at <= now() OR lease_device_id = :d)
RETURNING fencing_token, lease_expires_at, (claimed_at = now()) AS new_lease;
```

- **Other device, live lease:** the predicate fails, 0 rows → `HELD`.
- **No lease, or an expired lease** (any device, including this one after a restart that
  outlived the TTL): the token **is bumped**, and `new_lease = true`. Q-7.
- **Same device, live lease** (a second dispatch, or the keeper re-acquiring after a
  restart within TTL): the token is **not** bumped and the TTL is extended. The call
  returns the current token with `new_lease = false`. It therefore never fences the
  device's own first worker (Q-18). A worker that must be stopped on the same device is
  stopped by the orchestrator, not by the fence.

Under Postgres READ COMMITTED, a second concurrent `UPDATE` blocks on the row lock. Once
the first commits, it re-evaluates the `WHERE` against the new row. If the competing claim
is from another device, the lease predicate now fails and it updates 0 rows. **Exactly one
device wins**, and the token is bumped exactly once. Concurrent claims from the winning
device join its lease. The dependency check (`depends_on` targets terminal) runs in the
same transaction before the update. The `claimed` event (§10, with `new_lease`) is inserted
in the same transaction.

## 5. Lease, TTL and fencing semantics

- **Clock:** only the database clock (`now()`) decides expiry. Clients never compare
  absolute times. Every lease response carries `lease_remaining_s`. The client
  treats its lease as lost at `local_monotonic_at_response + lease_remaining_s −
  safety_margin`, where `safety_margin = max(30 s, 10% of TTL)`. It must stop starting new
  side effects after that point, even if it cannot reach the server.
- **TTL:** default 600 s; heartbeat every `TTL/3` (200 s). Bounds 60–3600 s per claim.
  The **lease keeper** (§5.1) heartbeats. No agent CLI holds registry credentials, and
  that includes the orchestrator session, which is itself an agent CLI (Rule 46/49:
  workers get no host-wide tokens).
- **Fencing token:** per-task `bigint`, incremented on *every* successful claim, never
  decremented. A mutation by a holder is accepted only if all of these hold, in the same
  statement: `fencing_token = :token AND lease_device_id = :caller_device AND
  lease_expires_at > now()`.
  - `token < current` → `FENCED` (someone re-claimed after you).
  - `token = current` but lease expired → `LEASE_EXPIRED`. Nobody has re-claimed yet, but an
    expired holder still may not complete. It may `claim` again, which yields a new token
    if no one else holds the task, and then complete.
  - different device → `NOT_HOLDER`.
- **Expired-worker rejection** is therefore structural: a stale `complete` or
  `heartbeat` cannot change the row. Its payload is preserved as a `stale_execution` or
  `late_report` event via `annotate`, so evidence is never lost.
- **Fencing downstream (sinks we control).** Workers put the token where later gates
  can check it:
  - branch `task/<id>-f<token>`;
  - commit/PR trailers `Aigentry-Task: <id>` and `Aigentry-Fence: <token>`;
  - ES-04 capture metadata.

  The orchestrator's merge/accept step and ES-04 restore accept an artifact only if its
  fence equals the token that `complete`d the task (`completed_fencing_token`) or the
  current live token. Sinks we do not control (GitHub comments, package registries,
  external APIs) cannot check a token; see §8.

### 5.1 Lease keeper (heartbeat and sync owner)

A 600 s TTL with a 200 s heartbeat needs a resident process. `dispatch.sh`/`cli.ts` is
one-shot, and the orchestrator is an agent CLI session. Neither can be the heartbeat owner.

- **Component:** `aigentry-devkit lease-keeper`. It is a user-level process shipped by
  devkit, the component that already owns the ES-01 client and key store (ES-01 §9), so no
  new package is needed. One instance runs per ES-01 device directory, enforced by an
  `O_EXCL` lock file holding its pid in that directory.
- **Duties:** claim, heartbeat, release, complete and annotate on behalf of local callers;
  token refresh (ES-01 §5); reconnect reconcile (§9) and the cache rewrite (§11); the
  sid-attachment table (§3.6(5)–(6)); local lease-loss timers (§5).
- **Credentials:** it is the only process that reads the ES-01 key store. Callers (the
  dispatch gate, the `aigentry-devkit` CLI) talk to it over a local endpoint: a Unix domain
  socket `0600` in the device directory (`0700`), with peer-uid check (`SO_PEERCRED` /
  `getpeereid`), or on Windows a named pipe whose ACL allows only the current user. The
  protocol carries operations and results, **never tokens, codes or key bytes**.
  Confined workers (Rule 46/49) must not have the device directory in their sandbox
  allowlist. Whether today's sandbox profiles exclude it was **not measured** (ES-09 item).
- **Lifecycle:**
  - Started on demand by the first command that needs it (gate lease step, `login`,
    `device` commands).
  - Exits after 10 min with no attachment and no held lease.
  - No boot-time service (no launchd/systemd unit, no Windows scheduled task) and no
    automatic restart in this release. Adding one is an operational change (D-Q-9).
- **Failure modes:**
  - Killed (`kill -9`), crashed, or the device sleeps: heartbeats stop and leases expire
    at TTL (Q-7 kills **this** process). The next on-demand start reconciles (§9). A
    lease it still holds within TTL is re-acquired without a bump (§4.2); after TTL, with
    a bump.
  - Key store locked or unavailable (e.g. macOS Keychain locked after sleep): it cannot
    refresh. When the access token expires, it stops heartbeating and marks the leases
    lost locally at the lease-loss point (§5). The state is shown in ES-07 as
    `keystore_locked`. It never falls back to another store (ES-01 §6).
  - Registry unreachable: as in §6.
  - Second instance: refused by the lock. A stale lock (pid not alive) is taken over.
- **What it cannot do:** it does not start, stop or kill workers. Telling a stale worker
  to stop (§6, §9) is the orchestrator's job, using the keeper's `FENCED` result.

This is a **new operational component**. ADR §3 rejects a new network service or relay.
The keeper is neither: it listens on no network port, and its only outbound traffic is to
the registry URL already covered by D-ID-4. Running it at all is decision D-Q-9.

## 6. Crash, offline and reassignment

| Event | What happens |
|---|---|
| Lease keeper killed (§5.1) / device sleeps | Heartbeats stop. After `lease_expires_at`, the task is claimable; `status` is still `in_progress` |
| Reassignment policy | Field `reassign_policy ∈ auto \| manual` (default `auto`). `auto`: the always-on Linux orchestrator claims expired-lease tasks it is configured to serve, at most one claim per task per 60 s (no flapping). `manual`: the task is surfaced to the user (ES-07) and nobody claims automatically |
| Same device returns before expiry | Heartbeat succeeds; work continues |
| Holder returns after takeover | Its next heartbeat/complete gets `FENCED`. The client must stop the stale worker (an operation inside its own sealed scope), annotate `stale_execution` with what it produced (branches, commits, files), and **not** push or merge further |
| Registry down (origin restart) | Clients keep working only until their local lease-loss point (§5). No new claims. On recovery, leases whose `lease_expires_at` passed during the outage are expired; the server never extends leases retroactively |
| Network partition | Same as registry down for the partitioned side. The other side may take over after expiry. The fence decides who may write |

Running processes are **never migrated**. The device that takes over **recreates** the
working state from ES-02 checkpoints and ES-04 captures and starts a new worker.

## 7. Idempotency keys

- Required on every mutation: `Idempotency-Key: [A-Za-z0-9._:-]{1,128}` (same alphabet as
  telesession `request_id`, `API-CONTRACT-TELESESSION.md:172`).
- Store `idempotency_records(queue_id, device_id, key, op, request_sha256, response,
  created_at)`, unique `(queue_id, device_id, key)`, retained 7 days.
- Semantics are copied from telesession's durable send (`telepty.js:989-993`):
  - same key + same request hash → stored response with `deduplicated: true`, and no
    second effect;
  - same key + different hash → `409 IDEMPOTENCY_KEY_CONFLICT {conflict: "body"|"op"}`;
  - same key while the first is still running → `409 REQUEST_IN_FLIGHT`.
- The record is written **in the same transaction** as the effect, so a crash after commit
  replays the stored result. A crash before commit leaves no record and no effect.
- Recommended keys: `create:<dedupe_key or provisional uuid>`,
  `claim:<task>:<sid or attempt>`, `complete:<task>:<token>`,
  `heartbeat:<task>:<token>:<n>`.
- Business-level dedupe for create: `dedupe_key` (unique per queue, forever) and ES-08's
  `github_issue` alias. These outlive the 7-day idempotency window.

## 8. What is explicitly NOT guaranteed

- **No exactly-once external side effects.** A fenced or partitioned worker can still have
  pushed a branch, posted a comment, or called an API before it learned it was fenced. The
  queue guarantees that such a worker cannot **record** completion. The reconcile step
  surfaces what it did; it is not undone automatically. The same holds in telesession: "Not
  exactly-once" (`API-CONTRACT-TELESESSION.md:180-182`).
- A lease is not mutual exclusion of physical processes. It is a right to *record*. Two
  processes may run concurrently for up to TTL + safety margin + detection delay.
- No guarantee that `done` means shipped or installed (Rule 50 §2).
- No ordering across queues, no cross-user sharing, no HA promise for a single registry
  Postgres.
- Timeouts are `unknown`, never "not delivered" or "not done". A client that got no
  response retries with the same idempotency key.

## 9. Reconnect reconcile

On every (re)connect, the lease keeper (§5.1):

1. `GET list?held_by=me` and `GET events?since_seq=<local cursor>`.
2. For each task the device *locally* believes it holds:
   - server shows the same token and a live lease → continue;
   - `FENCED` or expired and re-claimed → stop the local worker, annotate
     `stale_execution {produced: [...]}`, and move local outputs to a preserved location
     (ES-04 conflict copy). Never auto-merge;
   - completed by another device → same as fenced, plus a `superseded_local_work` entry
     in ES-07 status for the user.
3. Pending local mutations (queued while offline) are replayed **in order with their
   original idempotency keys**. Each result is applied to the cache. Rejections become
   visible items, not silent drops.
4. Rewrite the local cache from server state (§11). The cache is never merged back
   upward.

### 9.3 Offline create

A device may create tasks while offline. They get a client `provisional` UUID alias and an
idempotency key. On reconnect, the id is assigned according to the D-Q-1 scheme: by the
server counter under P-A, by the Mac once it is online under P-B, or by the local range
issuer at create time under P-C (which needs no provisional step). Local references
(cache rows, ref files, notes) are then rewritten from the provisional alias. Offline
devices cannot claim, heartbeat or complete.

## 10. Audit fields

`task_events` is append-only. There is no update or delete except a whole-queue deletion
(Rule 47).

| Field | Notes |
|---|---|
| `queue_id`, `seq` (per-queue, monotonic), `task_id` | `seq` is the reconcile cursor |
| `at` | server `now()` |
| `client_at` | client-reported, informational only |
| `actor_user_id`, `actor_device_id`, `lease_label` | from ES-01 token, never from the body |
| `type` | `created, updated, claimed, heartbeat (sampled: first, then every 10th), released, completed, rejected, note, dispatched, late_report, stale_execution, migrated, intake_received, intake_linked` |
| `fencing_token` | presented and/or resulting |
| `idempotency_key`, `request_sha256` | |
| `from_status`, `to_status` | |
| `result` | `ok` or the rejection code (`FENCED`, `LEASE_EXPIRED`, …). Rejections are logged too |
| `body` | bounded (16 KiB) jsonb: notes, evidence, progress. **Secret-scan on write**: values that match known credential patterns are refused with `SECRET_SUSPECTED` (ES-01 §11) |

### 10.6 Export and retention

`GET /export` returns tasks, links, aliases, notes and events as one JSON document. This is
the pre-condition for any downgrade or deletion (ES-01 §14). Events are retained as long as
the queue exists. A retention limit, if wanted, is a Rule 47 decision (D-Q-4).

## 11. Local cache and local-only mode

- **Account mode:** `state/task-queue.json` keeps today's shape (`tasks[]` with `id` and
  `status`), so existing readers (the gate, `tq-*` scripts, the release maintainer) keep
  working. Rows carry canonical `id`, `aliases`, and lease view. The file gets a top-level
  `authority: {mode: "server", queue, synced_at, event_seq}`. **Only the lease keeper
  writes it** (single writer, same temp+fsync+rename as `cli.ts:869-881`). Human or tool
  edits go through the API; a hand edit is overwritten at the next sync, after the diff
  is logged as a warning.
- **Local-only mode** (not logged in, `DEVICE_AUTH_ENABLED=false`, or a user who opts
  out): exactly today's behaviour. The file is the authority, there is no lease, and IDs
  are chosen as they are today, whatever D-Q-1 decides for account mode. Rule 34's gate
  works unchanged.

## 12. ES-08 intake linkage (contract only this release)

Scope (requirements §8, task row #2026101213): the queue-side contract and dependencies
only. Real dmsdc-ai org activation, webhooks, GitHub credentials/scopes and any automatic
comment, merge or deploy are **not** in this release. Each needs its own Rule 47 approval.

### 12.1 Dedupe

- Key: `github_issue` alias `owner/repo#N`, with owner/repo lowercased and N the issue
  number. Example form: `dmsdc-ai/aigentry-telesession#2` (the `issue` URL of #2026101110).
- Intake `create` sets `dedupe_key = "gh:" + key` and alias `github_issue = key` with
  idempotency key `intake:<key>`. Repeated deliveries, polls or retries return the same
  task (`deduplicated: true`). A transferred or renamed repo is a different key, and it is
  linked by hand with `supersedes`.

### 12.2 Durable receipt

`intake_receipts(queue_id, source='github', dedupe_key, delivery_ref, received_at,
content_sha256, content_bytes, state, task_id, attempts, last_error)`, unique
`(queue_id, source, delivery_ref)`. `delivery_ref` is the delivery id or the poll cursor.
`state` is one of `received, task_linked, analysis_requested, analysis_recorded,
review_recorded, rejected, retry_exhausted`. The receipt row is written **in the same
transaction** as the task create/link and the `intake_received`/`intake_linked` events.

The receipt is **internal**: it is what the intake adapter returns to its caller. No
GitHub-side acknowledgement is posted in this release.

**Retry contract (AC8 "retry").**

- **Who retries:** only the intake adapter. It runs as an owner device through the lease
  keeper (§5.1) and holds a local durable outbox: one file per delivery, written tmp +
  fsync + rename, holding `delivery_ref`, `content_sha256`, `attempts` and `next_at`. The
  server never retries toward GitHub, and nothing retries toward GitHub in this release.
- **Same identity on every attempt:** every attempt of one delivery reuses idempotency key
  `intake:<key>` and the same `delivery_ref` and content hash. A retry after an unknown
  outcome therefore returns the stored result (`deduplicated: true`, §7). It never yields
  a second task (business-level dedupe `gh:<key>`, §12.1). If the 7-day idempotency window
  has passed, the `dedupe_key` still returns the same task.
- **Retryable (transient):** no response or timeout (`unknown`, §8); HTTP 5xx; 503
  (`device_auth_disabled`, `rate_limit_unavailable`); `REQUEST_IN_FLIGHT`; 429 (honouring
  `Retry-After`).
- **Never retried:** any 4xx other than 429, which includes 401 `device_inactive`
  (revoked: retrying cannot help), 404, `IDEMPOTENCY_KEY_CONFLICT` (the same key with a
  different body means the adapter's own state is wrong), `ALIAS_TAKEN` for a different
  task, `SECRET_SUSPECTED`, and content over 256 KiB. Also never retried: anything that
  would act on GitHub (none exists in this release) or that issue content asks for
  (§12.3).
- **Bound and backoff:** at most 8 attempts per delivery. Exponential backoff with full
  jitter: base 30 s, factor 2, cap 1 h, so the worst case is about 2 h before the
  delivery stops.
- **Terminal states** (visible in ES-07 and in `GET` of the receipt):
  - `rejected`: a never-retried error. The server writes the receipt with `last_error` in
    its own transaction, with no task.
  - `retry_exhausted`: the dead letter after 8 attempts. If the server was never reached,
    the adapter records this in its outbox and reports it to ES-07 locally. On the next
    successful contact it writes the receipt row with `attempts` and `last_error`.
- **Manual retry:** a user action re-queues a `retry_exhausted` delivery with the same
  key and `delivery_ref`, and resets the attempt count. No automatic retry happens after
  a terminal state.
- **Counters:** `attempts` on the server counts attempts that reached the server. The
  outbox counts all attempts. Both are shown.

### 12.3 Untrusted-content isolation

- Issue title, body, comments, labels, author and attachments are **data, never
  instructions**. They are stored as an `untrusted_content` blob (sha256, size ≤ 256 KiB,
  fetched_at). They are **not** copied into `desc`.
- The task `title`/`desc` for intake tasks are composed by the server from fixed templates
  (e.g. "GitHub issue `owner/repo#N` — untrusted content attached, sha256 …").
- When an intake task is dispatched, the ref file includes the content only inside an
  explicit untrusted-data fence, with the instruction that it may not change scope, grant
  credentials, select repositories, or request execution.
- Nothing in issue text, labels, assignees or author identity grants any permission or
  scope. The set of repositories the adapter may read is user configuration (allowlist),
  not issue content.
- Attachments are recorded as links only and are not fetched automatically.

### 12.4 Analysis and review linkage

The analysis result is a separate task (or an evidence entry on the intake task) linked
with `analysis_of`. Review is linked with `review_of`. Both go through the same
claim/fence/complete rules. ES-08 never completes a task by itself; completion needs the
normal evidence (§4).

## 13. Acceptance criteria → test matrix

Rows are the user's matrix (requirements §검증 매트릭스), plus per-OS. ES-09 owns
execution with an independent tester. **A Linux-only fixture PASS is not reported as
cross-platform or real-endpoint PASS.**

| AC | Criterion (testable) | Matrix row |
|---|---|---|
| Q-1 | Device A creates task; device B (same user) `get`s it with identical `version` and links within one sync | two machines same account |
| Q-2 | A claims, then B's `get` shows A's device name and remaining TTL; B's `claim` → `HELD` | two machines same account |
| Q-3 | Fresh install + `login` on device C; `list` returns the same tasks/versions; C can claim an unheld task | third fresh device |
| Q-4 | User Y: `get`/`claim`/`complete`/`annotate`/`resolve` on X's ids and aliases → 404 with identical body; `list` never contains X's rows | other account isolation |
| Q-5 | Revoked device: next `claim/heartbeat/complete` **and** `list/get/events/resolve/export` (sync) refused (401 `device_inactive`) in-transaction (ES-01 §7.2, ID-16) | revoked device: sync·claim refused |
| Q-6 | Partition A for > TTL: Linux claims (token n+1); A reconnects → `FENCED`; A's outputs preserved, nothing merged | partition/reconnect |
| Q-7 | `kill -9` of the holder device's **lease keeper** (§5.1) mid-lease: lease expires at TTL, task claimable, no row corruption; a keeper restarted after TTL re-claims with a new token (bump); one restarted within TTL gets the same token (`new_lease=false`) | process kill |
| Q-8 | Lease expiry with nobody re-claiming: holder's `complete` with current token → `LEASE_EXPIRED`; after re-claim, `complete` succeeds with the new token | lease expiry |
| Q-9 | N ≥ 16 concurrent `claim`s on one task from ≥ 2 devices: every success belongs to one device, every claim from the other devices gets `HELD`; token incremented exactly once | concurrent claim |
| Q-10 | Holder with token n after someone claimed n+1: `complete` → `FENCED`; row unchanged; `stale_execution` annotation accepted | stale completion fencing |
| Q-11 | Same request with the same idempotency key ×3 → one effect, two `deduplicated: true`; same key + different body → `IDEMPOTENCY_KEY_CONFLICT`; duplicate ES-08 delivery → same task | duplicate message |
| Q-12 | `complete` committed but response dropped; retry with same key after lease expiry → stored success (not `LEASE_EXPIRED`); a worker REPORT arriving after takeover → `late_report` event, not completion | late ACK |
| Q-13 | Registry restart mid-lease: no lease is extended; clients stop new side effects at their local lease-loss point; after restart, state equals pre-restart committed state | origin restart |
| Q-14 | (after D-Q-1) Migration dry-run on copies of **both** queues, the Mac one included: every row, link, alias and free-text dependency accounted for (field-loss = 0); every cross-ledger id collision listed; projection ids remain valid under `release-admission.mjs`; concurrent creates from two devices never yield the same id under the chosen scheme | concurrent claim (issuance analogue) / migration — ES-09 |
| Q-15 | Gate (after D-Q-1 and migration, account mode): `--task <runtime id or alias>` resolves to the task's id; another device's live lease → exit 11 in **each** of `hard`, `warn`, `off`; server unreachable + stale cache → exit 12 in each mode; unknown/terminal/non-dispatchable keep today's mode behaviour (exit 4 / proceed, no lease); claim refused after the gate → exit 11 with no spawned workspace; pre-transport failure after claim → sid detached and lease released; exit 7/8 → attachment kept; a dispatch of a `pending` task leaves it `delegated` | concurrent claim / partition |
| Q-18 | Second dispatch from the same device while its lease is live: claim returns the same token, `new_lease=false`; the first worker's heartbeat/complete with that token still succeed (not `FENCED`) | concurrent claim (same device) |
| Q-16 | Secret patterns in `annotate`/`complete` bodies refused; no tokens in events or cache | other account isolation (secrets) |
| Q-19 | ES-08 retry: the first intake attempt's response is dropped (commit happened), then a 5xx, then success: exactly one task and one receipt, `deduplicated: true` on the replays; a non-retryable error (`IDEMPOTENCY_KEY_CONFLICT`, 401 `device_inactive`) is not retried and ends `rejected`; 8 transient failures end `retry_exhausted` with attempts=8, no 9th attempt, visible in ES-07; a manual retry reuses `intake:<key>` | duplicate message / late ACK (AC8 retry) |
| Q-17 | The device-side client (claim/heartbeat/lease-loss timer/reconcile) verified on real macOS, Linux and Windows hosts | per-OS verification |

## 14. Decisions needed (Rule 47) — recorded in the ADR

| Id | Decision | Category | Recommended default |
|---|---|---|---|
| D-Q-1 | Canonical id issuance scheme (P-A / P-B / P-C) and whether to migrate at all | operational data change; **plus, only if P-B is chosen, a network change** (new cross-host ID-request path to the Mac via telepty or a server relay, which conflicts with D-ID-4 "no new relay" unless approved together with P-B) | **No default adopted** (guardrail), including for the P-B network path. Inputs required first: Mac ledger read, mapping dry-run, freeze agreement (§3.4) |
| D-Q-2 | Authoritative store = registry Postgres for opted-in users | operational data / personal-data transfer | registry Postgres, opt-in, self-hostable; local-only mode unchanged |
| D-Q-3 | Executing the queue migration (M3 import, M5 freeze), once D-Q-1 is decided | operational data change | only after the user reviews `mapping.json`; backups kept, nothing deleted |
| D-Q-4 | Event/note retention on the server | personal data | keep for the queue's life; export available; no automatic expiry |
| D-Q-5 | Default `reassign_policy` (`auto` lets the always-on Linux claim expired leases) | permission (autonomous takeover) | `auto` for tasks the Linux orchestrator is configured to serve, `manual` otherwise |
| D-Q-6 | Real macOS and Windows hosts/runners for the rows that need them (ID-1/2/11, Q-1/2/3/6/17 and every row marked BLOCKED in §13 / ES-01 §15); the build plan names "OS runner 확보" as a re-estimate condition | cost | no paid runner or host is procured without approval; get a quote first. Until approved, those rows stay `BLOCKED` and the release states its verified support as Linux-only |
| D-Q-7 | Hosted (cloud registry) Postgres storage for opted-in users' queues, events, receipts and untrusted blobs | cost / personal-data transfer | do not enable account mode on the cloud instance until its storage cost per user is measured; per-user storage quota (proposal: 100 MiB, `413 QUOTA_EXCEEDED` beyond); self-hosted instances unaffected |
| D-Q-8 | Retention and deletion of ES-08 `untrusted_content` blobs and `intake_receipts`. These hold **third-party** GitHub authors' text and logins, which D-Q-4 does not cover | personal data | blob deleted 90 days after the intake task reaches a terminal status (sha256, size and `owner/repo#N` kept); receipts keep no content, only metadata, for the queue's life; author identity only inside the blob, never as a column; export includes blobs only while they exist |
| D-Q-9 | Run the devkit **lease keeper** (§5.1): a new user-level resident process that holds the device credentials and heartbeats leases | operational change | on-demand start by the first command that needs it, exit after 10 min idle; no boot-time service, no automatic restart; a launchd/systemd/scheduled-task unit is a separate later approval |
