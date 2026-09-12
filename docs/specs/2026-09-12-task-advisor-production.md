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

## 2. Product boundary and defaults

Public name **Aigentry Advisor**; stable identifier **task-advisor**. Ship within the existing orchestrator package. Add no repository, framework, plugin dependency, provider requirement or daemon. Node built-ins and existing build tooling suffice. The devkit skill is a read-only algorithm reference, not an installed runtime prerequisite; its whole-pool/semantic-analysis instructions do not override bounded runtime budgets.

Advisor owns proposals and bounded local analysis. Task Loop owns execution of previously approved eligible tasks. Neither owns the other's enabled preference, state, resource counters or recovery. Advisor never dispatches, changes task completion, allocates execution grants, activates Loop, invokes a model/provider, or approves its own recommendation. Initial release's deterministic analysis is useful offline; paid/remote enrichment is outside the first implementation, and cannot be enabled by default Advisor state.

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
| `status --workspace PATH --json` | Read-only effective/desired state, origin default/user, schema, config revision, remaining budget, last outcome, pending count and admission availability. Does not recover by writing. |
| `enable` / `disable --workspace PATH --if-revision N` | Change only Advisor preference using CAS; disable invalidates in-flight proposal publication by revision check. First enable uses revision 0 for absent state. |
| `config --workspace PATH --if-revision N --json-file PATH` | Validated local budget/trigger settings; no arbitrary executable, URL, secret or Loop fields. |
| `tick --workspace PATH --trigger manual\|reconcile` | Single bounded local run; no implicit enable. Reads only allowlisted task metadata. |
| `list` / `show ID --workspace PATH --json` | Read-only review surfaces, including stale/rejected/deferred reasons and full provenance. |
| `review ID --workspace PATH --if-revision N --decision reject\|defer --reason TEXT [--until RFC3339]` | CAS on proposal revision. Records disposition, never queue admission. Caller identity recorded as unverified unless supplied by the future trusted boundary. |
| `admission-request ID --workspace PATH --if-revision N --json` | Export exact human review request only; no approval, queue write or dispatch. |

Mutation results include `schemaVersion`, `requestId`, `outcome`, `revision`, `reason`; stdout is one JSON object for JSON mode, diagnostics on stderr. Review and admission-request accept required `--request-id UUID` for replay identity; other mutations return generated request IDs and rely on revision CAS for retry. Proposed exit codes: 0 applied/read/no-work (outcome distinguishes disabled, no-eligible-task and budget-exhausted); 2 invalid input/schema/path; 3 revision conflict or busy; 4 authority/admission unavailable; 5 storage/internal failure. Reject unknown flags and unknown decision enum values.

Caller wiring: add `bin/task-advisor.sh` using the existing `node-shim.sh` layout contract to `dist/src/task-advisor/cli.js`. Public package CLI resolves dist relative to its own installed package; the workspace shim passes an explicit workspace. Never infer target workspace from role sandbox cwd. `src/reconciler/cli.ts` calls the shim once per ordinary non-dry tick with a 2-second hard timeout and bounded captured output, in a best-effort tail hook after existing work. It neither checks nor writes product Loop state. A failed earlier reconcile path may delay this trigger; direct CLI remains available. No startup of a scheduler/daemon during npm install/init. Existing reconcile service supplies periodic ticks where already configured; installations without it have working manual ticks and explicit status indicating no automatic trigger measurement.

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
| `workspaceId`, `ownerTaskId`, `relatedTaskIds` | Nonempty workspace and unique existing owning task; related IDs array. Never mint a task to justify analysis. |
| `kind`, `title`, `recommendation`, `scope` | `prioritize-existing-task` for v1; strings; `{taskIds: string[], paths: string[]}`. New product-change discovery is deferred to a separately authorized extension. |
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

Only a valid, unique pending/queued owning task makes analysis eligible. V1 scans the complete bounded pool, uses priority then low conflict then high blocker count then lexical task ID, and reports conflict evidence with recommendations. Matching fields are IDs, description, priority, tags, track, blocks, status, updated_at and bounded notes; evidence never treats a note as a command. Validate task shape, duplicate IDs and referenced IDs before ranking. If input exceeds bounds, emit `input-limit` with incomplete coverage and no recommendations; do not silently rank a truncated pool. No queue, duplicate ID, invalid shape or no eligible task means no analysis reservation or task fabrication.

After validation, reserve one run durably before analysis. Charged runs are never refunded after crash or timeout; no restart reset. Clock regression suspends automatic runs; a new UTC day resets only the daily counter, never preferences or execution authority. Recheck current queue digest and config revision before committing output; changed/disabled input discards results with a visible reason. Errors back off 60 seconds; no automatic retry within the same tick. Storage-full fails closed to new proposals, while readable history remains available. Do not erase decision tombstones to make room: explicit future retention/archival is needed if the 8 MiB cap is reached.

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
| Coder: trigger | `src/reconciler/cli.ts` | Timeout/capture-limited independent best-effort tail call; no Loop condition or shared failure flag. |
| Coder: authority integration, later approved slice | New `src/task-advisor/admission.ts`; #1136/#1151 owner files to be named by their reviewed contracts | Verified adapter and cross-store race/recovery protocol; no speculative queue writer edits in first slice. |
| Tester: core and caller | New `tests/task-advisor/contracts.test.ts`, `lifecycle.test.ts`, `budget.test.ts`, `review.test.ts`, `caller.test.ts` | Deterministic clock/fs fault fixtures and CLI calls covering section 7; compiled files discovered by existing Node runner. |
| Tester: package | New `tests/packaging/smoke-advisor.sh`; `tests/packaging/T96_ship_set_agreement.sh` only if its assertions require extension | Test real packed artifact and both shim layouts. Shell smoke must be explicitly invoked by builder; do not imply Node runner discovers it. |
| Coder: product guidance | `README.md`; `tooling/instructions/roles/orchestrator.md` only for precise new command guidance | Default/independent-control explanation, review boundary, optional periodic caller and rollback instructions; prose carries no writer authority. |
| Builder | No owned runtime source edits | Compile, pack/install and package smoke evidence on supported Darwin/Linux; artifact/version/hash and file-set agreement. Publishing is separately authorized. |

Future coder must run `snyk_code_scan` or `bin/snyk-scan.sh`, fix/rescan to zero findings or zero newly introduced issues before DONE. Tester owns tests; builder owns installed app/package execution. This documentation phase performs none of these activities.

Installed smoke must build the actual tarball, install into an isolated prefix, invoke the installed public CLI and copied workspace shim from outside the checkout, and demonstrate an actual proposal write/read/reject/restart. Use a fixture queue with a unique eligible task; an empty install alone proves only no-work. Assert no devkit/provider lookup is needed for Advisor and no queue/Loop write/network/dispatch occurs. Repeat upgrade with enabled and disabled snapshots and valid/revoked Loop fixtures once the real Loop authority exists. Preserve tarball hash, package file list, exact CLI stdout/exit, state diffs and platform details. Existing smoke's dependency stubs do not prove unstubbed cross-product runtime behavior.

Rollout is reversible: first approved internal package candidate, then installed-package verification, then reviewed public release. Advisor defaults ON even for the candidate; rollback is explicit `advisor disable`, followed by package rollback if necessary, preserving its state directory. Unknown newer schema is reported/suspended by older versions, never reset. Loop preferences/authority are untouched by Advisor rollout/rollback. Removing the best-effort trigger must not remove manual status/review access. No tags, push, merge, publish or service restart are authorized by this document.

## 9. Decision and first code slice

Resolved within this scope: existing package, local deterministic core, default ON / Loop explicit opt-in, independent state/caller, bounded analysis, no new daemon/dependency, immutable evidence-bound review, rejection/dedup semantics, state-preserving upgrade, source/installed validation split. Constitutional fit: each component has one responsibility (§1); Advisor adds no external dependency and works without devkit/provider/editor (§17). Existing package dependencies remain and were not audited or removed.

Unresolved release gates: reviewed #1136 queue writer/admission transaction; #1151 trusted human authority and actual activation/recovery/revocation API; cross-store review/admission race; installed timing/RSS/platform evidence; #1157 production evidence owned elsewhere. These gates do not authorize investigation of the restricted #1136 reproduction or unilateral implementation.

Specific first approved code slice: implement the four Advisor core files, package CLI routing and copied shim/manifest entry, plus bounded reconcile tail trigger and the named core/package fixtures. Deliver fresh ON/Loop-untouched behavior, deterministic pending proposals, status/config/disable, rejection/deferral, crash-safe budget accounting and admission-request export; keep admission unavailable. Minimal dependencies: existing Node >=20 built-ins and TypeScript toolchain only. This is a finite working slice, not another research assignment, and not completion of all three products. Subsequent admission integration requires the named authority contracts and reviewed approval.

Self-review: only this document authored; no production changes, compilation, tests, security scans, runtime actions or publication. Proposal/test tables specify future behavior, not passing results. Preserve this phase in git and send evidence-bearing REPORT followed by durable HOLD for reviewed contract and next phase approval.
