# Task Advisor production contract — #1161

Status: proposed release prerequisite; implementation requires reviewed approval. Author/speaker: `ad1161-architect` / `codex`. Date: 2026-09-12. This is the sole output of the bounded documentation phase, not an ADR or evidence that any product shipped.

## 1. Evidence and limits

Binding input: `/Users/duckyoungkim/.telepty/shared/2b664091598c41ea9b31b0ce2ffdde011f5e729b672ed6d9ec181921a67afad2.md`. Latest human requirement: Advisor defaults ON; Task Loop defaults OFF and requires explicit user activation. All three products (#1161 Advisor, #1151 Loop, #1157 related product) need production implementation; this contract delivers only #1161's review prerequisite.

Source measured through read-only git, file reads and bounded `rg` searches:

| Input | Measured result |
|---|---|
| Worktree / branch | `/Users/duckyoungkim/.aigentry/worktrees/ad1161`, `docs/1161-advisor-contract`; initially clean |
| Exact base / inspected source HEAD | `6b34ccb322daa13595f4a829c6f373a29680d90b` |
| Local main at inspection | `70c7aa475a78b6c264564b9471f9b4f62cb1c097`, dated 2026-09-12T16:13:17+09:00 |
| Local main at final self-review | `5dfe5b68ccd8aa731abf16a8e4505f9ae35af73b`, dated 2026-09-12T16:18:19+09:00; same four metadata paths differ from base, still no source delta. |
| Base versus local main | Four changed metadata files: three release dispatch documents and `state/task-queue.json`; no source delta. Metadata contents were not used as worker inputs. No remote fetch/currentness claim. |
| `package.json`, `tsconfig.json` | Source manifest declares `@dmsdc-ai/aigentry-orchestrator` 0.2.0, Node >=20, Darwin/Linux, TypeScript build, `dist/src` and `bin` shipping roots; public CLI maps to `bin/init/cli.mjs`. This is source packaging evidence, not npm registry verification. |
| `bin/init/cli.mjs`, `bin/init/manifest.mjs` | CLI currently accepts init, version/help; literal manifest copies governance/bin files. `createState` preserves an existing queue; upgrade skips state entirely. |
| `src/dispatch/cli.ts:597–719`, `bin/dispatch.sh` | Task gate rejects ambiguous IDs and invalid status; post-delivery ledger promotes pending/queued to delegated and appends dispatch evidence. Same-directory temporary file, fsync and rename prevent truncation, but this read-modify-write section has no shared queue writer lock/CAS. It is not admission authority. |
| `bin/tq-focus.sh`, `bin/tq-track.sh` | Focus mutates the queue with jq/temp/mv; track reads it. They are not a verified universal transactional queue API. |
| `src/reconciler/cli.ts` targeted tick/caller reads | Existing process-per-tick loop and best-effort tracker/report sweep, HITL pause and cleanup calls. Reconciler's process loop is not product Task Loop authorization. |
| `bin/lib/node-shim.sh` | Supports package/repo sibling dist and copied workspace lookup through installed `aigentry-orchestrator`; workspace manifest does not copy dist. |
| `src/inject-handler/cli.ts` header; `src/hitl/cli.ts` decision section | Worker envelope is expressly unauthenticated. Existing HITL decision/claim mechanics must not be treated as authenticated Advisor admission or Loop activation. |
| `scripts/run-tests.mjs`, packaging smoke/ship-set source | Node runner recursively discovers compiled `.test.js`; shell packaging checks are separate. `smoke-init.sh` builds/packs/installs into a throwaway environment and checks upgrade queue preservation. No checks were executed. |
| `src` / `bin` Advisor/Loop name and grant/claim search | No named Task Advisor/Task Loop implementation found by this bounded search. Existing unrelated claim helpers do not establish task authority commands. |
| Read-only devkit candidate | `/Users/duckyoungkim/projects/aigentry-devkit/templates/skills/propose-next-task/SKILL.md`; repository HEAD `bb7876bcbe8f83c2d329b22f41751b2b07f1f61a`, file blob `613d0915be2ef59d0a21bdd4b4ec2bae73435469`, no file status changes. Contains priority/conflict/leverage/currentness ranking and human-facing recommendations. |

Not measured: published npm contents/version, external primary sources, installed behavior, live providers, remote main, private `.claude` contents, credentials, unrelated logs, #1136 candidate reproduction or implementation, #1151/#1157 peers' unpublished contracts, complete queue writer inventory, timing/memory behavior, builds/tests/security. No public external factual claim depends on a web lookup. Truncated broad reads were followed by targeted reads for the writer, CLI, shim and trust conclusions above; this is not a full-repository audit.

Correction evidence (same bounded phase, new binding input `/Users/duckyoungkim/.telepty/shared/69803235012a6351b0db887156b3685d65cb5563fa16da7d6369ea8a26239dd7.md`): prior document commit `ad5089032668c204c7e241270ea8e9105d82b6e7`; source base unchanged; local main remeasured at `5dfe5b68ccd8aa731abf16a8e4505f9ae35af73b`, still only four metadata-path differences. `wc -c` measured this worktree queue at 2,041,998 bytes; `git show main:state/task-queue.json | wc -c` measured local main at 2,050,930 bytes. The supplied 2,052,324-byte observation was not reproduced at these snapshots and is not an oversized-failure result. Queue content was not read for task selection. Targeted rereads of `src/reconciler/cli.ts:1183–1230`, `src/orchestrator-boot/cli.ts:661`, `bin/orchestrator-boot.sh` and `bin/install-launchd.sh` show synchronous reconcile child waiting, no Advisor boot hookup, and a macOS installer that manages two existing labels, skips missing plists and no-ops outside Darwin. A bounded bin/src filename search found no systemd service installer. No installed host behavior or workload performance was measured.

## 2. Product boundary and defaults

Public name **Aigentry Advisor**; stable identifier **task-advisor**. Ship within the existing orchestrator package. Add no repository, framework, plugin dependency, provider requirement or daemon. Node built-ins and existing build tooling suffice. The devkit skill is a read-only algorithm reference, not an installed runtime prerequisite; its whole-pool/semantic-analysis instructions do not override bounded runtime budgets.

Advisor owns proposals and bounded local analysis. Task Loop owns execution of previously approved eligible tasks. Neither owns the other's enabled preference, state, resource counters or recovery. Advisor never dispatches, changes task completion, allocates execution grants, activates Loop, invokes a model/provider, or approves its own recommendation. Initial release's deterministic analysis is useful offline; paid/remote enrichment is outside the first implementation, and cannot be enabled by default Advisor state.

**ADVISOR-DISCOVERY acceptance gate:** the first `prioritize-existing-task` slice is partial functionality, not the full proactive Advisor product. Full release must demonstrate discovery of an improvement absent from the execution queue, producing a new evidence-backed proposal candidate with benefit/risk/cost/currentness and explicit admission boundary, without creating an execution task or dispatching it. A separately registered, eligible analysis-owning task supplies the analysis scope and budget; it is not automatically the execution task being recommended. The local-only first slice keeps provider/network use forbidden. Discovery needs its own reviewed proposal kind/evidence inputs and fixtures before this gate closes; sorting pre-existing tasks cannot close it. No new implementation approval is implied.

| Situation | Advisor | Loop |
|---|---|---|
| Fresh install; no stored preference/authority | Effective ON, local-only analysis | OFF, no authority |
| Upgrade from pre-Advisor installation | Missing preference means ON; no state rewrite during installer upgrade | OFF absent valid explicit activation |
| User disabled Advisor; install/upgrade/restart/force re-copy | Preserve explicit false | Independent existing authority handling |
| User explicitly activates Loop through reviewed #1151 entry | Preserve Advisor preference | ON only after validation of exact activation scope, identity, expiry and revocation state |
| Restart with valid prior activation | Preserve preference | Recover the same authority ID/limits/usage; no new grant, expiry extension or budget reset |
| Revocation or invalid/expired/ambiguous activation | Preserve preference | OFF; reject subsequent execution claims; #1151 defines disposition of already-started work |

Absent configuration and corrupt configuration differ. Missing Advisor record has the default ON; malformed/unknown-version existing record yields effective suspended/error, never silently resets a disabled preference. Missing/invalid Loop evidence always yields OFF. Text such as “looks good,” worker REPORT, proposal acceptance, installation and update are never Loop activation. Revocation racing recovery must win at the execution authority writer, not merely in a UI cache.

## 3. Proposed CLI and actual callers

All commands below are **new proposed interfaces**, not existing executable capability. Extend the existing package CLI before init-only argument parsing:

| Proposed command, prefixed `aigentry-orchestrator advisor` | Contract |
|---|---|
| `status --workspace PATH --json` | Read-only effective/desired state, origin default/user, schema, config revision, remaining budget, last outcome, pending count and admission availability. Separately show automatic operation as running/degraded/unwired/unknown, last observed host tick and reason; desired ON alone never means automatic operation works. Does not recover by writing. |
| `enable` / `disable --workspace PATH --if-revision N` | Change only Advisor preference using CAS; disable invalidates in-flight proposal publication by revision check. First enable uses revision 0 for absent state. |
| `config --workspace PATH --if-revision N --json-file PATH` | Validated local budget/trigger settings; no arbitrary executable, URL, secret or Loop fields. |
| `tick --workspace PATH --trigger manual\|reconcile` | Single bounded local run; no implicit enable. Reads only allowlisted task metadata. |
| `list` / `show ID --workspace PATH --json` | Read-only review surfaces, including stale/rejected/deferred reasons and full provenance. |
| `review ID --workspace PATH --if-revision N --decision reject\|defer --reason TEXT [--until RFC3339]` | CAS on proposal revision. Records disposition, never queue admission. Caller identity recorded as unverified unless supplied by the future trusted boundary. |
| `admission-request ID --workspace PATH --if-revision N --json` | Export exact human review request only; no approval, queue write or dispatch. |

Mutation results include `schemaVersion`, `requestId`, `outcome`, `revision`, `reason`; stdout is one JSON object for JSON mode, diagnostics on stderr. Review and admission-request accept required `--request-id UUID` for replay identity; other mutations return generated request IDs and rely on revision CAS for retry. Proposed exit codes: 0 applied/read/no-work (outcome distinguishes disabled, no-eligible-task and budget-exhausted); 2 invalid input/schema/path; 3 revision conflict or busy; 4 authority/admission unavailable; 5 storage/internal failure. Reject unknown flags and unknown decision enum values.

Caller wiring: add `bin/task-advisor.sh` using the existing `node-shim.sh` layout contract to `dist/src/task-advisor/cli.js`. Public package CLI resolves dist relative to its own installed package; the workspace shim passes an explicit workspace. Never infer target workspace from role sandbox cwd. Replace the earlier tail-hook proposal: for `--once`, invoke Advisor after argument validation and explicit dry-run/shadow exits, before HITL reminder, registry/tracker calls or listing-related early returns. Advisor child has a 2-second hard timeout, at most 64 KiB captured output and no descendant subprocesses in local v1; timeout kills only that child, logs degradation and continues existing work. Product Loop state is neither read nor written by this hook. Explicit dry-run/shadow remains read-only; product Loop OFF is not dry-run. Advisor disabled/error must not prevent the rest of a reconcile tick.

**ADVISOR-AUTO-HOST acceptance gate:** installed normal startup is `bin/orchestrator-boot.sh` → `src/orchestrator-boot/cli.ts` normal main → bounded Advisor startup tick plus ensure/verify of the existing reconcile host → normal existing boot flow. The startup attempt must occur before registry work that could fail/delay; help/probe/dry-run never invokes it. Boot does not reset preferences and returns to existing boot after at most 2 seconds for the Advisor tick and 2 seconds for host verification/ensure, reporting failure without blocking approved Loop work. No npm lifecycle hook starts services. Normal boot must establish periodic operation without requiring users to activate product Loop or type a manual tick. This is required future wiring, not current behavior.

Periodic contract: reuse the existing `src/reconciler/cli.ts --loop` host, not a new daemon. Its parent must schedule Advisor independently every 60 seconds using Node's event loop, with one bounded Advisor child and one existing reconcile child at a time. Replace the parent's blocking `spawnSync`/sleep scheduling with nonblocking child tracking; a running legacy child suppresses only another legacy child, never the Advisor cadence. Host-issued `--once` children receive an internal validated skip marker to avoid duplicate Advisor invocation; standalone `--once` still has the prefix hook. Exit/restart clears process handles, not durable Advisor counters/preferences. There is no backlog/catch-up storm after sleep, and no killing of existing work to free an Advisor slot. An Advisor timeout/missing dist never changes the legacy child's state; a stalled legacy child cannot indefinitely defer Advisor ticks.

Host provisioning remains a named release dependency, not an invented working API: on Darwin the existing reconciler label needs a shipped workspace-correct definition and idempotent verification/ensure; blindly calling today's two-label `install-launchd.sh` from boot would also restart telepty and is prohibited by this contract. On Linux an installed normal-boot caller for the same existing reconcile host must be supplied and verified; the measured macOS-only no-op is insufficient. The host adapter/file details must be reviewed before dispatch of that integration unit. Missing host wiring yields desired ON plus `automatic: unwired` and blocks ADVISOR-AUTO-HOST on that platform. Direct/manual tick remains a partial slice, never a substitute for this gate. No new framework, standalone Advisor service or implicit Loop activation is authorized.

Automatic trigger is default enabled, with a minimum 60-second interval and unchanged-snapshot suppression. Queue changes, including metadata following REPORTs, are observations at the next tick; no new trusted REPORT listener is required. Triggers coalesce rather than queue unbounded jobs. Disabled mode permits status, review and disable operations but performs no new analysis. A CLI configuration switch cannot authorize proposed execution or data disclosure.

## 4. Exact persisted contracts

Proposed storage root: `<workspace>/state/task-advisor/`. Resolve canonical workspace first; reject state-root symlinks/path escape and task IDs used as paths. Proposal IDs are generated opaque IDs, not user-supplied filenames. One private directory (0700) and snapshot (0600) are adequate; permissions protect local data, not against a worker with equivalent OS access. Authentic human approval must come from a separately enforced authority boundary.

`store.json` is the single transactional snapshot, with these required top-level fields:

- `schemaVersion: 1`, `workspaceId: string` (canonical workspace identity digest), `revision: nonnegative integer`.
- `config: {enabled: boolean, origin: "default"|"user", revision: integer, minIntervalMs: integer, maxInputBytes: integer, maxTasks: integer, maxRunsPerUtcDay: integer, maxCpuWallMs: integer, maxProposalsPerRun: integer, maxStoreBytes: integer}`.
- `budget: {utcDay: YYYY-MM-DD, chargedRuns: integer, lastStartedAt: RFC3339|null}`; `run: null|{id, ownerPid, startedAt, configRevision, snapshotDigest, status: "reserved"}`.
- `observations: {lastSnapshotDigest: string|null, lastSuccessfulAt: RFC3339|null, lastOutcome: string, retryAfter: RFC3339|null}`.
- `proposals: Proposal[]`, `decisions: Decision[]`, `admissionReceipts: Receipt[]`. No tasks, grants or Loop preferences are stored here.

All fields are validated; timestamps UTC, digests SHA-256 lowercase hex, text length bounded, integer bounds checked, unknown schema rejected. `status` on absent storage synthesizes defaults; first successful mutation materializes them. Installer upgrade does not migrate state. A version-specific runtime migration runs under the same writer lock, preserving explicit preference, dispositions, counters and IDs; no known migration exists yet. Unknown versions stop mutations with an error; never overwrite with defaults.

Each `Proposal` has exactly:

| Field | Required type/meaning |
|---|---|
| `id`, `schemaVersion`, `revision` | Opaque UUID, 1, monotonic integer |
| `workspaceId`, `ownerTaskId`, `relatedTaskIds` | Nonempty workspace and unique existing analysis-owning task; related IDs array. Execution targets are in scope.taskIds and may differ from the analysis owner. Never mint a task to justify analysis. |
| `kind`, `title`, `recommendation`, `scope` | `prioritize-existing-task` for the partial v1 slice; strings; `{taskIds: string[], paths: string[]}`. Product-change discovery is required by ADVISOR-DISCOVERY but needs its reviewed schema extension before full release. |
| `createdAt`, `expiresAt` | RFC3339; default evidence TTL 24 hours, maximum 7 days |
| `state` | `pending` / `deferred` / `rejected` / `stale` / `admitted` |
| `dedupKey`, `evidenceDigest` | SHA-256 of canonical semantic identity, and of evidence; keys described below |
| `provenance` | `{producer: "task-advisor", packageVersion, sourceRevision: string|null, algorithmVersion: "local-ranking-v1", runId, trigger, observedAt, queueDigest, coverage: {totalTasks, consideredTasks, complete: boolean}, evidence: Evidence[]}` |
| `benefit`, `risk`, `cost` | `{summary, basis}`; cost additionally `{analysis: {localOnly: true, chargedRun: 1}, execution: {estimate: string|null, uncertainty: string}}`. Unknown cost is explicit, never fabricated as zero execution cost. |
| `currentness` | `{status: "current"|"stale"|"unknown", checkedAt, reason}`; unstamped task has unknown historical age even when its snapshot is current. |
| `admissionBoundary` | `{requires: "explicit-human-admission", requestDigest, executionAuthorized: false, loopActivationAuthorized: false}` |
| `disposition` | `null` or `{decisionId, reason, deferredUntil: RFC3339|null}` |

`Evidence` = `{source: "task-queue", locator: string, digest: string, observedAt: RFC3339, fact: string}`. Locator identifies the exact task field; digest binds the bounded source snapshot. Queue text is untrusted data, never instructions. Do not copy unrelated notes wholesale into evidence. Package version is read from installed manifest; source revision may be null in a package lacking build provenance and must say unknown rather than borrow current workspace HEAD.

`Decision` = `{id, proposalId, proposalRevision, requestId, kind: "reject"|"defer", reason, until: RFC3339|null, actor: {id, verified: boolean}, at}`. `Receipt` = `{id, requestId, proposalId, proposalRevision, requestDigest, taskId, authorityRef, committedAt}`; only the future verified admission adapter may insert one. Free text and CLI actor strings never establish authority.

Writer contract: `src/task-advisor/store.ts` alone mutates this snapshot via bounded exclusive `mkdir` lock, re-read/schema check/revision CAS, same-directory unique temporary file, file fsync, rename and directory fsync. Lock ownership includes host/PID plus nonce. Contention returns busy after 100 ms; do not hold a lock across analysis or subprocess calls. Confirm local owner death before recovering an abandoned lock; uncertain ownership is busy/operator recovery, not age-based stealing. Only nonce owner removes its lock. No advisory write shares the task queue lock or file. Readers see the prior complete snapshot or new complete snapshot; orphan temp files are ignored and recovered by the writer. Snapshot revision covers decision/budget/proposal changes in one commit.

Human-maintained AGENTS/SKILL prose is guidance only. It cannot enforce writer serialization, task binding, admission, budget accounting or identity. Existing queue writers and their atomic-rename comments are not a proof of cross-writer serializability. #1136 must resolve that separate contract before any automated admission writer is enabled.

## 5. Bounded analysis and lifecycle

Defaults: at most 2 MiB queue input, 10,000 tasks, 1 second analysis wall time, 2 seconds total child time, 64 MiB Node old-space cap, one in-flight run per workspace, 60 runs per UTC day, at most 3 recommendations per run, 8 MiB store. These are proposed limits to validate, not measured performance. Never exceed a configured hard ceiling; configuration can lower limits to zero. Node old-space is not a total RSS guarantee; builder measures RSS before making a total memory claim.

The 2 MiB value is 2,097,152 bytes: measured headroom is only 55,154 bytes in this worktree and 46,222 bytes on measured local main. It is a provisional input default, not a demonstrated production capacity target. Read at most configured limit + 1 byte to detect overflow, including growth after stat; reject the whole observation if bytes/tasks/field limits exceed configured ceilings. Never silently strip notes, truncate a field or sample the pool to fit. User configuration may raise the input ceiling explicitly, but this does not relax time/memory ceilings; installation/update never raises it implicitly. **ADVISOR-REAL-INPUT gate:** tester/builder must preserve a locally measured real-workload snapshot digest/byte and task counts, exercise it and growth fixtures at limit−1/limit/limit+1 with complete pool/notes, and measure elapsed time/RSS in the installed package. A larger production default or recommended ceiling requires that evidence and explicit documented growth headroom; no guess that the current queue fits all other limits. Input-limit is truthful refusal, not a production success verdict.

Only a valid, unique, explicitly scoped analysis-owning task with available local-analysis budget makes analysis eligible. Its eligible status is pending/queued/in_progress; delegated execution alone does not convey an analysis allocation. Bind each run to that owner independently of candidate selection. The partial slice recommends pending/queued execution candidates, which need not be the analysis owner. V1 scans the complete bounded pool, uses priority then low conflict then high blocker count then lexical task ID, and reports conflict evidence with recommendations. Matching fields are IDs, description, priority, tags, track, blocks, status, updated_at and bounded notes; evidence never treats a note as a command. Validate task shape, duplicate IDs and referenced IDs before ranking. If input exceeds bounds, emit `input-limit` with incomplete coverage and no recommendations; do not silently rank a truncated pool. No queue, duplicate ID, invalid shape, no eligible analysis owner or no candidate means no analysis reservation or task fabrication. Existing task status is not a speculative grant API; the reviewed analysis-scope/budget binding must be supplied as validated input before the engine runs.

After validation, reserve one run durably before analysis. Charged runs are never refunded after crash or timeout; no restart reset. Clock regression suspends automatic runs; a new UTC day resets only the daily counter, never preferences or execution authority. Recheck current queue digest and config revision before committing output; changed/disabled input discards results with a visible reason. Errors back off 60 seconds; no automatic retry within the same tick. Storage-full fails closed to new proposals, while readable history remains available. Do not erase decision tombstones to make room: explicit future retention/archival is needed if the 8 MiB cap is reached.

Maintenance ordering is mandatory on every non-dry tick: (1) bounded store read/schema/config check and clock-regression detection; (2) bounded CAS maintenance of interrupted reservations, reached evidence TTL and defer deadlines, with explicit disabled preference respected; (3) only then apply disabled/min-interval/unchanged-snapshot/backoff/analysis-budget suppression; (4) validate bounded inputs, reserve analysis budget, analyze and revalidate before publication. Maintenance uses the same 2-second child and 8 MiB store ceilings; it is metadata work, not uncharged ranking, source enrichment or evidence refresh. If maintenance cannot finish, report maintenance-pending/degraded; status computes due/stale state read-only and admission refuses expired evidence. Clock regression does not revive already-stale evidence or reset charged runs.

Expired evidence becomes stale even with unchanged queue and exhausted budget. A due defer remains deferred with a visible `defer-due-awaiting-analysis` outcome until enabled, funded revalidation can run; TTL expiry takes precedence and makes it stale. Due revalidation may bypass unchanged-snapshot suppression, but never the budget or configured analysis-rate limit. It consumes a normal reserved run before returning a fresh item to pending. No uncharged reread/re-ranking renews currentness. Disabled mode can record stale/due metadata but never republishes. Thus maintenance is not indefinitely skipped by analysis suppression, while renewed recommendations still require eligible analysis resources.

Dedup identity is canonical JSON of workspace ID, owner task ID, kind and normalized proposed scope; timestamp, run ID and incidental note text do not alter it. Evidence digest separately captures the facts/algorithm that justified the recommendation. Same identity+evidence observation is a no-op: no notification, new proposal, expiry extension or budget refund. Compare a fresh disk snapshot rather than trusting trigger timestamps. Old/out-of-order events cannot roll state backward. A changed evidence digest may create a new revision of the same pending proposal, invalidating prior review digests; rejected identity remains suppressed until explicit human reopening in a future reviewed interface. Do not evade rejection through new IDs or wording.

Transitions: pending → rejected/deferred/stale/admitted; deferred → pending only on due expiry with fresh revalidated evidence, otherwise stale; pending/deferred → stale when owner disappears/completes, scope changes or evidence expires. Admitted and rejected are terminal in v1. Rejection requires a reason; deferral requires a reason and future expiry no later than 30 days. Due expiry can be recorded during tick without spending analysis budget; generating/re-ranking content still requires budget. Stale items are visible but cannot be admitted. Status/list compute overdue currentness read-only even before the next tick persists it. Disabled Advisor never re-emits an expired defer automatically.

Concurrent reviews require the displayed proposal revision. First committed decision wins; the loser receives conflict and must reread. Idempotent retries with the same request ID and same payload return the original result; reused IDs with different payloads fail. Restart reconciles a confirmed-dead reserved run as interrupted with its charge retained, then accepts a later bounded run. It never reports the interrupted output as complete.

## 6. Admission interface and unresolved authority

Admission is adding a reviewed proposal to the approved task workflow, not activating Loop or granting execution. V1 can produce `AdmissionRequest = {schemaVersion:1, requestId, workspaceId, proposalId, proposalRevision, proposalDigest, ownerTaskId, scope, evidenceDigest, expiresAt, requestedAction:"admit-proposal"}`. Human review must display benefit/risk/cost, currentness, exact scope and separate execution/Loop controls. There is deliberately no automatic `approve` command backed by free text.

Future approved authority adapter contract: `admit(request, verifiedHumanDecision) -> Receipt | typed refusal`. The authority owner validates identity/origin, workspace, exact digest/revision, current evidence, expiry and revocation, and commits an idempotent admission record under the approved queue writer's concurrency protocol. A request ID has exactly one task association; concurrent retries must resolve to that record. Existing-task recommendations associate the existing ID; do not duplicate the queue row. Advisor stores only a verified receipt after the authority commit; a crash between commits recovers by querying that request ID, never by blindly readmitting. Admission unavailable returns refusal without changing pending to admitted.

This is a required semantic interface, not a claim that grant/claim/query commands already exist. #1136 transactional queue admission and #1151 trusted human ingress, activation/recovery/revocation remain unresolved release gates. Existing dispatch task status checks and generic HITL decisions do not satisfy them. Same-user OS access means a standalone CLI cannot certify that a human, rather than a worker, typed approval. Until the shared boundary is reviewed and implemented, automated admission is unavailable; proposals and explicit review export remain functional. Product release must not describe this partial slice as full three-product productionization.

## 7. Acceptance fixtures (future tester execution)

Every case observes queue/Loop bytes and forbidden-call spies as well as Advisor results. “Approved Loop work continues” must be tested with the landed #1151 implementation, not inferred from an Advisor unit stub.

| Fixture | Required observable result |
|---|---|
| Advisor ON / Loop OFF | Eligible local task produces pending proposal; no dispatch/activation/queue mutation. |
| Advisor OFF / Loop ON with valid prior approval | No new analysis; eligible approved Loop task runs independently. |
| Both ON | Proposal remains pending while separately approved work executes; independent counters and locks. |
| Both OFF | Neither proposals nor Loop execution; status/review history available. |
| Fresh installed package with empty queue | Advisor effective ON / Loop OFF, `no-eligible-task`; zero charged runs, zero provider/network calls. |
| Upgrade absent versus explicit false | Absent Advisor preference resolves ON; false stays false through upgrade/force/restart; installer preserves state bytes/mtime. No activation created. |
| Explicit Loop activation then restart | Same valid authority identity, remaining budget and expiry recovered; Advisor preference unchanged. |
| Revocation concurrent with restart/claim | New execution refused by authority owner; Advisor can still propose; expired/invalid authority never recreated. |
| Same observation twice; older observation after newer | One semantic proposal, no duplicate notification/revision rollback; event timestamps do not override current disk evidence. |
| Queue changes during analysis | Output discarded on digest mismatch; no stale recommendation admitted. |
| Concurrent reject/defer/admission on same revision | Single winner; conflict for others; authority adapter and Advisor revalidation prevent admission of rejected/stale revision. This cross-store race is an integration gate. |
| Rejection; unchanged or changed wording/evidence | Same semantic identity remains suppressed. |
| Defer expiry before/after TTL; Advisor disabled | Fresh due item returns pending only while enabled; expired evidence is stale; no automatic execution. |
| Unchanged queue, defer becomes due, min interval/backoff or exhausted budget | Maintenance records due status before suppression; stays deferred awaiting funded revalidation, then charges one run; no free hidden analysis. |
| Unchanged queue, evidence expires, exhausted budget/disabled Advisor | TTL becomes stale and cannot be admitted; zero analysis calls; clock regression/config changes are still evaluated before suppression. |
| Installed normal boot with Loop OFF; earlier registry failure or stalled reconcile child | Startup Advisor attempt and periodic ticks occur without manual tick; bounded Advisor failure does not block boot/approved Loop work, and legacy child stall does not suppress Advisor cadence. Missing host wiring fails ADVISOR-AUTO-HOST. |
| Real installed workload and complete growth fixtures at byte ceiling boundaries | Record exact snapshot size/digest and full-field coverage, truthful overflow refusal, elapsed/RSS evidence; no note/pool truncation or implicit ceiling increase. |
| Improvement not already an execution task, independent eligible analysis owner | Evidence-backed new proposal candidate, no execution task creation/admission/dispatch; analysis cost bound to its separate owner. Required full-product ADVISOR-DISCOVERY fixture, not a first-slice ranking pass. |
| Budget zero/exhausted, missing task, duplicate IDs, oversized input | Explicit reason, no dispatch or hidden model work, no partial-pool recommendation; invalid/no-task cases do not reserve budget. |
| Crash after reservation / before rename / after rename | Charge retained; prior/new complete snapshot; orphan ignored; no duplicate proposal or lost decision. |
| Concurrent writer and confirmed-dead versus uncertain lock owner | CAS conflict/busy; safe dead-owner recovery only, no timeout-based lock theft. |
| Forged REPORT, “approved” note, proposal acceptance, updater | No human authority minted and no Loop activation. |
| Admission replay/crash/changed scope | Same receipt once; changed digest refused; query recovery after authority commit. Blocked until real adapter exists. |
| Advisor corrupt state, timeout, full disk, missing dist | Visible Advisor failure, bounded caller delay, approved Loop work still completes. |
| Installed workspace outside repo without devkit/provider/terminal plugin | Real shim executes local tick/list, persists proposal and survives restart; missing optional services do not prevent local Advisor. |

## 8. File ownership and release handoff

Paths marked new are proposed; this review edits none of them. Orchestrator assigns sessions after approval; no peer delegation occurred here.

| Owner | Files | Deliverable |
|---|---|---|
| Coder: Advisor core | New `src/task-advisor/contracts.ts`, `store.ts`, `analyze.ts`, `cli.ts` | Validation, defaults, serialization/CAS, bounded deterministic engine, review/export commands; no execution imports. |
| Coder: entry/installation | `bin/init/cli.mjs`, `bin/init/manifest.mjs`; new `bin/task-advisor.sh`; `package.json` only if actual shipping requires it | Public advisor routing and copied shim manifest entry; keep existing init state preservation. Existing bin/dist shipping roots already cover proposed files; avoid unnecessary manifest churn. |
| Coder: trigger | `src/reconciler/cli.ts` | Bounded prefix tick and independent nonblocking host cadence described in section 3; no Loop condition or shared failure flag. |
| Coder: authority integration, later approved slice | New `src/task-advisor/admission.ts`; #1136/#1151 owner files to be named by their reviewed contracts | Verified adapter and cross-store race/recovery protocol; no speculative queue writer edits in first slice. |
| Tester: core and caller | New `tests/task-advisor/contracts.test.ts`, `lifecycle.test.ts`, `budget.test.ts`, `review.test.ts`, `caller.test.ts` | Deterministic clock/fs fault fixtures and CLI calls covering section 7; compiled files discovered by existing Node runner. |
| Tester: package | New `tests/packaging/smoke-advisor.sh`; `tests/packaging/T96_ship_set_agreement.sh` only if its assertions require extension | Test real packed artifact and both shim layouts. Shell smoke must be explicitly invoked by builder; do not imply Node runner discovers it. |
| Coder: product guidance | `README.md`; `tooling/instructions/roles/orchestrator.md` only for precise new command guidance | Default/independent-control explanation, review boundary, optional periodic caller and rollback instructions; prose carries no writer authority. |
| Builder | No owned runtime source edits | Compile, pack/install and package smoke evidence on supported Darwin/Linux; artifact/version/hash and file-set agreement. Publishing is separately authorized. |

Future coder must run `snyk_code_scan` or `bin/snyk-scan.sh`, fix/rescan to zero findings or zero newly introduced issues before DONE. Tester owns tests; builder owns installed app/package execution. This documentation phase performs none of these activities.

The owner groups above describe responsibility only, not sanctioned multi-file worker dispatch. First-wave implementation units must be dispatched one file per session, with these explicit dependencies:

| Order/unit file | Input contract → output contract; dependency |
|---|---|
| **First: `src/task-advisor/contracts.ts`** | Unknown parsed JSON plus supplied workspace identity/time and explicit analysis binding → validated typed config/store/proposal/analysis input or typed refusal. Pure validation/default construction, no fs/process/network/queue writes; section 4 schema and section 5 bounds are inputs. Tests consume exported validators and types. Unresolved binding is refused, not invented. |
| `src/task-advisor/store.ts` | Validated snapshot/expected revision/operation → atomic snapshot/result or busy/conflict/storage refusal; depends on contracts exports. |
| `src/task-advisor/analyze.ts` | Validated complete queue snapshot, independent analysis owner/scope, reserved budget and clock → bounded proposals or typed no-work/limit result; depends on contracts, no persistence. |
| `src/task-advisor/cli.ts` | Explicit workspace/validated argv → JSON/exit code and store-mediated operations, maintenance before suppression; depends on contracts/store/analyze. |
| `bin/task-advisor.sh` | Workspace/argv → existing node-shim resolution and CLI exec; depends on compiled CLI. |
| `bin/init/cli.mjs` | Public advisor subcommand → installed CLI routing, existing init semantics preserved; depends on CLI contract. |
| `bin/init/manifest.mjs` | Existing literal copy set → set including new shim; depends on shim path, no state seed on upgrade. |
| `src/reconciler/cli.ts` | Tick/host lifecycle → bounded prefix and independent cadence; depends on CLI/shim and reviewed host integration. |
| `src/orchestrator-boot/cli.ts` (release integration) | Normal boot mode and explicit workspace → bounded startup attempt/host health, unchanged existing boot continuation; depends on reviewed host ensure adapter. No help/probe/dry-run side effects. |

Host provisioning file units are not ready for dispatch: exact Darwin definition/ensure and Linux normal-boot adapter must be named in the reviewed ADVISOR-AUTO-HOST handoff; current install-launchd.sh cannot silently supply them. Each named tester `.test.ts` file and `smoke-advisor.sh` is likewise its own unit consuming the corresponding exported/public interface; packaging assertion changes, guidance files and any necessary package.json change are separate single-file units. Dependencies determine dispatch order; this document starts no sessions.

Installed smoke must build the actual tarball, install into an isolated prefix, invoke the installed public CLI and copied workspace shim from outside the checkout, and demonstrate an actual proposal write/read/reject/restart. Use a fixture queue with a unique eligible task; an empty install alone proves only no-work. Assert no devkit/provider lookup is needed for Advisor and no queue/Loop write/network/dispatch occurs. Repeat upgrade with enabled and disabled snapshots and valid/revoked Loop fixtures once the real Loop authority exists. Preserve tarball hash, package file list, exact CLI stdout/exit, state diffs and platform details. Existing smoke's dependency stubs do not prove unstubbed cross-product runtime behavior.

Rollout is reversible: first approved internal package candidate, then installed-package verification, then reviewed public release. Advisor defaults ON even for the candidate; rollback is explicit `advisor disable`, followed by package rollback if necessary, preserving its state directory. Unknown newer schema is reported/suspended by older versions, never reset. Loop preferences/authority are untouched by Advisor rollout/rollback. Removing the best-effort trigger must not remove manual status/review access. No tags, push, merge, publish or service restart are authorized by this document.

## 9. Decision and first code slice

Resolved within this scope: existing package, local deterministic core, default ON / Loop explicit opt-in, independent state/caller, bounded analysis, no new daemon/dependency, immutable evidence-bound review, rejection/dedup semantics, state-preserving upgrade, source/installed validation split. Constitutional fit: each component has one responsibility (§1); Advisor adds no external dependency and works without devkit/provider/editor (§17). Existing package dependencies remain and were not audited or removed.

Unresolved release gates: ADVISOR-DISCOVERY (new improvement candidates and independent analysis ownership), ADVISOR-AUTO-HOST (normal installed boot/periodic operation on each supported platform), ADVISOR-REAL-INPUT (real workload and growth capacity), reviewed #1136 queue writer/admission transaction, #1151 trusted human authority and actual activation/recovery/revocation API, cross-store review/admission race, and #1157 production evidence owned elsewhere. These gates do not authorize investigation of the restricted #1136 reproduction or unilateral implementation.

Specific first implementation file after approval: `src/task-advisor/contracts.ts`, with the pure unknown-input → validated-value/typed-refusal contract above. Then dispatch the dependent individual core, CLI, packaging and fixture units. This partial slice delivers desired ON/Loop-untouched behavior, existing-task proposals, status/config/disable, rejection/deferral, crash-safe budget accounting and admission-request export; admission remains unavailable. The boot/prefix/independent-cadence integration must close ADVISOR-AUTO-HOST before claiming automatic default operation; the ranking slice cannot close ADVISOR-DISCOVERY. Minimal dependencies: existing Node >=20 built-ins and TypeScript toolchain only. No implementation or completion of all three products is claimed.

Self-review: only this document authored; no production changes, compilation, tests, security scans, runtime actions or publication. Proposal/test tables specify future behavior, not passing results. Preserve this phase in git and send evidence-bearing REPORT followed by durable HOLD for reviewed contract and next phase approval.
