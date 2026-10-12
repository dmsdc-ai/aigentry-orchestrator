REPORT: oc-1204-ctxws task #2026101204 — CONTRACT SPEC — DONE

Scope note: DONE refers only to this specification dispatch (ES-02, ES-04, ES-07 data model, ADR). Nothing is implemented, merged, released or installed; parent task #2026101204 remains open (Rule 45 §2, Rule 50 §2). Guardrail of 13:59Z applied: each spec has Part A FINDINGS (exists / not found / not measured) and Part B PROPOSALS; untagged rules = proposals requiring user review; `[REQ]`/`[DRAFT]`/`[EXISTING]` tags mark restated sources.

commits:
- 32759a2 docs(2026101204): ES-02 checkpoint, ES-04 workspace capture, ES-07 diagnostics contract specs + ADR (branch task-1204-env-continuity-ctxws; not pushed)
- (this REPORT.md in a follow-up commit on the same branch)

files:
- docs/specs/2026-10-12-env-continuity-context-checkpoint.md (ES-02; test rows CK-01..CK-15)
- docs/specs/2026-10-12-env-continuity-workspace-capture.md (ES-04; test rows WS-01..WS-13)
- docs/specs/2026-10-12-env-continuity-diagnostics.md (ES-07 data model; test rows DG-01..DG-10)
- docs/adr/2026-10-12-env-continuity-context-and-workspace.md (decisions A1–A12, rejected alternatives, consequences, D-1..D-6, estimate inputs)
- REPORT.md

grounded_in:
- orchestrator state/specs/2026-10-12-environment-sharing-release-requirements.md: AC2 line 39, AC4 line 41, reconnect/recreate line 42, AC7 line 44, matrix 48–52, estimate line 57, Mac offline line 60, brain consent line 16
- orchestrator state/draft/2026-10-12-environment-sharing-build-plan-proposal.md: no new daemon/transport/credential line 9; ES-02 41–45; ES-04 54–57; ES-07 66–67; release split 77–80; estimate 84
- orchestrator docs/rules.md: Rule 45 (837–849), Rule 47 §1 five human-approval categories (868), Rule 50 (907–918)
- brain src/cli/SetupWizard.ts:54,146–213 — sync opt-in; remote = user's private GitHub repo
- brain src/mcp/BootstrapOrchestrator.ts:123–157 — SyncEngine only with remoteUrl
- brain src/sync/SyncEngine.ts:106–124 — watcher only on profile files
- brain src/backend/GitBackend.ts:19,30,83,104–175,177–191 — main only, depth-1 clone, pull --rebase, `git add .`, TOFU new-device decrypt gap (150–153)
- brain src/backend/SyncBackend.ts:1–13 — no diff/list primitives
- brain src/sync/ConflictResolver.ts:22–61,114–168 — version vector then LWW; loser logged only
- brain src/sync/PushPullManager.ts:61–159 — recovery merge + reset to remote
- brain src/core/ProfileFormat.ts:20–29,140–182 — single file; plaintext fallback on encryption failure
- brain src/core/EntrySchema.ts:30–53; src/core/SchemaMigration.ts:28–44; src/policy/PolicyEnvelope.ts + RetentionParser.ts:6–50
- brain src/context/ContextRestoreService.ts:44–58,309–390; src/mcp/BrainMcpServer.ts:270–326 (brain_context_resume), 726–769 (session_context), src/contract/BrainContract.ts:899–923
- brain src/capture/capture-tool.ts:38–56 — only an argument allowlist, no content secret scanner
- brain commits: main 0ffa6ee; df315c7 is on origin/fix/1165-policy-restoration-20261005 only
- devkit 604f2b5 + hooks/post-compact-restore.sh:1–16 — local snapshot after compaction, no sync; lib/workspace-init.js:1–8 scaffold only; bin/lib/platform.sh:21–24; config/installer-manifest.json:1–40; no devkit caller of brain session_context tools (grep empty)
- telesession-wt-1110 docs/specs/2026-10-11-e2e-delivery-protocol.md: hop rules 47–57, record 61–88 (`checkpoint` = origin read cursor, line 82), status view 108–117, state machine 121–169, storage 171–198, telepty deps 313–319, diagnostics 402–410, guarantees 412–424

decisions_needed (Rule 47; recommended default first):
- D-1 transcript storage — 개인정보 전송: M1 hash+summary; raw (M2) opt-in per project, raw TTL 30d
- D-2 workspace capture storage — 비용/개인정보: S1 encrypted per-capture refs in the user's private brain repo; registry artifact store (S3) later with its own approval
- D-3 retention — 개인정보/운영 데이터 삭제: checkpoints 90d after superseded (heads kept); captures 14d, newest 5/device, 50 MiB cap; restore preserve copies kept until user deletes
- D-4 automatic expiry deletes in the user's repo — 운영 데이터 변경/삭제: only aigentry-created paths/refs; never automatic history rewrite
- D-5 binding brain-repo GitHub account to aigentry user_id (ES-01) — 권한 확대: record binding only, no new GitHub scopes
- D-6 uploading uncommitted code off-device — 개인정보 전송: explicit per-capture command only; no automatic/periodic capture this release

not_measured:
- registry (auth/device API/storage) — not read in this dispatch
- real two/three-host brain sync, Git-host GC/retention of deleted refs, ls-tree/bundle performance
- telesession code and tests (spec only read); telepty daemon APIs; RC5/#107 state
- macOS/Windows behaviour (Linux-only caveat kept); no tests run (SAWP)
- constitution file absent in the aigentry checkout; bin/context-compact.sh absent in the orchestrator clone

estimate_inputs:
- ES-02 context 4–8 → proposed 6–9: new SyncBackend primitives, store/index, fail-closed crypto, ES-01 recipients + rekey, MCP extension, and a content secret scanner that does not exist yet (shared with ES-04)
- ES-04 workspace 6–12 → proposed 9–13: no existing capture code in devkit; preview/journal/rollback; multi-ecosystem manifest; per-OS checks blocked on runners
- ES-07: data model + view 2–3 inside the 4–8 OS/diagnostics bucket; PTY hop blocked on telepty #103/#104
- ES-01 identity + key distribution is a hard prerequisite for ES-02/ES-04; re-estimate blocked until ES-01 design and registry read

snyk: NOT_APPLICABLE_DOCS

blockers: none for this dispatch. The telepty REPORT inject is attempted next; if it fails in the sandbox, this file is the evidence (Rule 49 §5: transport blocked, not delivered).
</content>
</invoke>
<parameter name="description">Write REPORT.md