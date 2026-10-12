# ADR — Environment continuity: context checkpoints, workspace capture and stage diagnostics (task #2026101204)

Status: **PROPOSED** (architect, 2026-10-12). Nothing here is accepted, implemented, released or
installed. Technical choices are for the orchestrator to decide and record (Rule 47 §1); items in §6
touch Rule 47 human-approval categories and need the user.

Specs: `docs/specs/2026-10-12-env-continuity-context-checkpoint.md` (ES-02),
`docs/specs/2026-10-12-env-continuity-workspace-capture.md` (ES-04),
`docs/specs/2026-10-12-env-continuity-diagnostics.md` (ES-07).
Inputs: `state/specs/2026-10-12-environment-sharing-release-requirements.md` (requirement),
`state/draft/2026-10-12-environment-sharing-build-plan-proposal.md` (approved build-plan draft).

Convention (orchestrator guardrail 2026-10-12 13:59Z): §1 = FINDINGS; §2–§7 = PROPOSALS requiring
review. Tags `[REQ]`/`[DRAFT]`/`[EXISTING]` mark statements that restate an existing source.

## 1. Findings (summary; details with file:line in each spec's Part A)

1. brain sync is opt-in, Git-based, single branch `main`, to a private repo of the user's GitHub
   account; all memory lives in one rewritten encrypted file; conflicts resolve by version vector then
   LWW (brain `SetupWizard.ts:54,146-213`, `GitBackend.ts:19,30,83`, `ProfileFormat.ts:140-182`,
   `ConflictResolver.ts:40-61`).
2. brain encryption falls back to plaintext on failure (`ProfileFormat.ts:160-181`); a new device
   cannot decrypt until an existing device re-encrypts (`GitBackend.ts:150-153`).
3. brain has no checkpoint record, lineage, cursor, provenance marking or content secret scanner
   (`SyncBackend.ts:1-13`, `BrainMcpServer.ts:270-326`, `capture-tool.ts:38-56`).
4. devkit has no repository/worktree/uncommitted capture and no runtime manifest; 604f2b5 is a local
   post-compaction snapshot reader (`hooks/post-compact-restore.sh:1-16`, `lib/workspace-init.js:1-8`).
   No devkit caller of brain's `session_context` tools was found.
5. telesession PR3 spec defines ledger stages, status vocabulary and "timeout ≠ not delivered"; PTY write
   is unobservable through telepty today; its ledger field `checkpoint` means the origin agent's read
   cursor (`e2e-delivery-protocol.md:82,109-160,313-319`).
6. Not found / not read: registry (auth, device API, storage), the constitution file in the aigentry
   checkout, `bin/context-compact.sh` in the orchestrator clone. Not measured: any real multi-host run,
   macOS/Windows.

## 2. Decisions (proposed)

| # | Decision | Basis |
|---|---|---|
| A1 | Checkpoints are **immutable, append-only, one encrypted file per record** under `checkpoints/v1/…` in the existing brain repo — not brain entries | entries are merged by LWW and stored in one rewritten file (finding 1) → a concurrent device's context would be dropped |
| A2 | Conflict = **lineage fork + explicit user choice**; no automatic merge or LWW for checkpoints | `[DRAFT line 43]`; avoids silent loss |
| A3 | Incremental cursor is local (`remote_commit` + seen set) with `git diff --name-only` fast path and `ls-tree` fallback (shallow clones) | `SyncBackend` lacks primitives; clone is `--depth 1` |
| A4 | Encryption **fail-closed**; recipients = ES-01 active device keys (not TOFU) for checkpoints and captures | finding 2 |
| A5 | Transcript storage default = **hash + summary (M1)**; raw (M2) opt-in per project | Git history makes raw deletion impractical; `[REQ line 39]` original-vs-summary marking |
| A6 | Restore through an **optional extension** of `brain_context_resume`; default output unchanged; every restored item marked `original`/`summary`/`unavailable` | `[DRAFT line 44]`, backward compatibility |
| A7 | Workspace capture = git metadata + shelf commit + bundle of unpushed commits, built without touching the user's index/worktree; ignored files never captured; deny-list + content scan + size caps; symlinks never followed | `[REQ line 41]` |
| A8 | Workspace storage default = **encrypted bundle on per-capture refs in the user's private brain repo (S1)** | no new infra/credentials (Article 1/17); brain pulls only `main`, so refs are not synced by default |
| A9 | Restore default = **new worktree**, after preview, conflict detection and a preserve ref/copy + journal; runtime recreate commands are printed, not run | `[REQ line 41, 51]` no original loss |
| A10 | Diagnostics = read-only derived view attached optionally to `telesession_request_status`; `completed` only from the ledger; access health in a separate object with `implies_request_state:false` | `[REQ line 44]`, `[EXISTING e2e-delivery-protocol.md:142]` |
| A11 | ES-02 ids link to telesession via a separate `origin_checkpoint_id` field owned by ES-05 (never the ledger's `checkpoint` field) | finding 5 naming collision |
| A12 | Shared secret detector set for ES-02 and ES-04, fail-closed when unavailable | finding 3; `[REQ line 49]` |

## 3. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Store checkpoints as brain `Entry` / extend `session_context` | LWW drops concurrent context; one mutable entry per project (`BrainContract.ts:899-923`); whole-profile rewrite per save |
| Auto-merge forked checkpoints (LWW or text merge) | silently loses or fabricates context; violates "original vs summary" honesty |
| Raw transcript as default | Git history retention, privacy transfer of conversation text (Rule 47) |
| Reuse TOFU recipient sync | fresh device blocked until an old device is online; recipients never shrink on revoke |
| Shelf refs in the **project** remote (S2) | pushes unencrypted uncommitted work to possibly shared/public remotes |
| Registry artifact store (S3) now | needs registry storage, credentials/scopes and cost approval; registry not read; candidate later |
| Restore in place by default | risks overwriting the target's own work |
| Copy `.env` / credentials with encryption | `[REQ line 41]` forbids automatic secret copy |
| Live process/PTY migration, CRIU-style checkpointing | `[REQ line 42]` reconnect/recreate only; non-portable across OSes |
| Diagnostics writing ledger stages or inferring completion from health | `[REQ line 44]`; violates telesession R1/R3 |
| A new daemon or sync service for checkpoints | `[DRAFT line 9]` "새 daemon, 새 전송, 새 자격증명은 만들지 않는다" |

## 4. Consequences

- Positive: no new server, transport or credential for ES-02/ES-04; per-user isolation reuses the
  private repo; explicit, testable provenance; no silent context loss.
- Negative / accepted risks: Git host retains deleted data in history/unreachable objects until GC;
  revoked devices can still read past ciphertext they kept; a fresh device needs an online existing
  device (or post-registration writes) to read older records; brain repo grows with checkpoint files
  (bounded by retention and the 1 MiB record cap) and capture refs (50 MiB cap, newest 5 per device).
- Isolation depends on ES-01 binding the brain repo's GitHub account to the aigentry `user_id` — open.
- brain needs a content secret scanner (new code, false negatives possible; guarantee is "scanned").
- **Linux-only caveat** `[REQ line 52]`: only Linux can be exercised now (Mac offline, line 60); macOS and
  Windows file-system rows (WS-12) and install/reconnect rows remain unverified until real runners exist.
  A Linux fixture PASS is never reported as cross-platform or real-endpoint PASS.
- **Reconnect/recreate, never live migration** `[REQ line 42]`: no model internal state, process memory,
  PTY buffer, running process or port is transferred by ES-02/ES-04.

## 5. Ownership and sequencing (proposal)

ES-01 identity → ES-02 store/scanner/restore (brain) + triggers (orchestrator/devkit hooks) → ES-04
capture/restore CLI (devkit) reusing ES-02 encryption + scanner → ES-07 view after ES-05 ledger merge.
Matches requirement order line 56 and draft release split R-B (draft line 78).

## 6. Open user decisions (Rule 47) with recommended defaults

| ID | Decision | Category | Recommended default |
|---|---|---|---|
| D-1 | Transcript storage mode | 개인정보 전송 | M1 hash+summary; M2 raw opt-in per project, raw TTL 30 d |
| D-2 | Workspace capture storage | 비용 / 개인정보 | S1 encrypted per-capture refs in the user's private brain repo; S3 registry later with its own approval |
| D-3 | Retention | 개인정보 / 운영 데이터 삭제 | checkpoints 90 d after superseded (heads kept); captures 14 d, newest 5 per device, 50 MiB cap; preserve copies kept until user deletes |
| D-4 | Expiry deletion executing automatically in the user's repo (commits deleting files/refs) | 운영 데이터 변경/삭제 | allowed for aigentry-created paths/refs only, after the user enables sync; history rewrite never automatic |
| D-5 | Binding the brain repo GitHub account to the aigentry account (ES-01) | 권한 확대 | record binding only; no new GitHub scopes; reuse the user's existing `gh`/git credentials |
| D-6 | Uploading uncommitted code (including unpushed commits) off the device at all | 개인정보 전송 | allowed only by explicit per-capture command; no automatic/periodic capture in this release |

Technical items the orchestrator can decide without the user (Rule 47 §1): record layout, cursor design,
JCS canonicalisation, error codes, detector list, freshness defaults.

## 7. Inputs for the cost re-estimate (requirement line 57: context 4–8, workspace 6–12, OS/diagnostics 4–8 agent-days)

| Area | Finding that changes the estimate | Direction |
|---|---|---|
| ES-02 | needs new SyncBackend primitives, CheckpointStore/Index, fail-closed crypto, ES-01-based recipients + rekey pass, MCP tools, `brain_context_resume` extension, secret scanner (none exists), orchestrator/devkit triggers, 15 test rows | upper half: **6–9** (scanner shared with ES-04 counted here) |
| ES-04 | no existing capture code in devkit; bundle/shelf/worktree handling, preview/journal/rollback, runtime manifest detectors for several ecosystems, per-OS FS checks | upper half or above: **9–13**; per-OS verification blocked on runners |
| ES-07 | data model only now; PTY hop blocked on telepty #103/#104; depends on PR3 merge | data model + view **2–3** within the 4–8 OS/diagnostics bucket; no reduction of the OS part |
| Cross-cutting | ES-01 user/device + key distribution is a hard prerequisite for both; registry not read — unknown | estimate blocked until ES-01 design |

These are planning inputs, not commitments (requirement line 57; draft line 84).
</content>
</invoke>
<parameter name="description">Write ADR