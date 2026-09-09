---
dispatch_kind: fresh-session
task: 1136
---
# Dispatch - qc1136b-coder - Implement the bounded shared queue transaction core

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. All state/docs/bin paths are orchestrator metadata unless explicitly designated owned output or read-only context. Your role-sandbox is not the worktree. No previous chat is required.

## Role and ownership
You are qc1136b-coder, role coder, worktree /Users/duckyoungkim/.aigentry/worktrees/qc1136, branch work/1136-queue-writer-core, starting HEAD b0c287180567ebfd40aa7f4fa066003edaf7b1db.
Exclusive first-party output: bin/tq-write.py. Python3 standard library only. No other tracked edits, tests, manifests, callers, instructions, generated docs or package files. No additional agents/sessions.
Retained tests/dispatch/workflow-task-writer.test.ts and docs/reports/2026-09-09-queue-writer-test-build.md are READ-ONLY sources. The former is blob3b2ee8fc5cefd7ca078b1d03456b3b37cf5b378b. This branch includes them but main does not yet include the red tests. Recheck actual source, do not infer currentness from this list.

## Operational recovery
Previous qc1136-coder explicitly replied 'Not received' to an in-assignment status query; its visible TUI showed only startup, not the original ref, and worktree remained clean at baseb0c2871. Helper's VERIFIED working-spinner was not proof of ref consumption. The old session is being reaped before this replacement; do not resurrect it. This is the same approved task/file, not a second competing implementation. Explicit Claude CLI is a temporary operational fallback while a separate analyst investigates task751; no provider-quality/cost claim.

## Background and reproduction gate
User authorized fixing six autonomous-loop weaknesses. This phase implements only P1-base shared queue transactions; claims/grants/action receipts, automatic selection and live loop activation are NOT included.
ACTUALLY EXECUTED tester diagnostics (worker-attributed): unchanged bin/tq-focus.sh SHA2567fbbed6c733950ceb98df5cea620924caa57774bf4d55c806df891d35f5703e2, synthetic HOME/TQ/TMPDIR. PATH mv wrapper waits after real jq snapshot; unrelated note write commits+rereads; focus mv then loses exact segment. Counterpart holds the SAME stable TQ.lock BEFORE each writer reads THROUGH replace; both focus=new and note='seed || unrelated-writer' survive; both child exits0. This confirms cooperative-lock strategy, not future helper or production wiring.
Tester authored desired helper tests and added >=10s monotonic held-lock assertion. Snyk isolated sole-file scan reported0. Builder npm run build exited0, emitted JS hashfa764b9e81af227d8c2bbfe18c2bb2e2b674de29bfed8228c989b5c7dd27b990, source/config matched main then. Actual compiled suite NOT RUN yet; helper absent. No additional helper-absence-only session is required before implementation; actual regression/acceptance execution follows your reviewed code.
Build used shared installed node_modules with a missing declared telepty dependency; it proves compilation, not clean install/package closure. Do not repair dependencies. No npm/build/test actions in this coder phase.

## Approved P1-base scope
[SPEC FIRST] The following bounded contract is approved for implementation after the reproduced failure/confirmed lock strategy. Broader docs/specs/2026-09-08-workflow-production.md is context-only, NOT permission to implement its other verbs.
Implement only:
- note-append --task ID --segment TEXT --op-id ID
- status --task ID --status VALUE --if-current VALUE
- focus TRACK
Queue path from TQ when provided; otherwise same repo-relative state/task-queue.json convention as existing tq-focus.sh. Resolve the queue path once; stable sibling .lock must identify the same target across path aliases. Never initialize/reset a missing or malformed queue.
Do not execute the helper against the real queue or run the application. Existing callers remain unchanged; this file alone does not fix a live race. Manifest entry and callers have separate owners before integration.

## Lock and commit
Use a stable queue.lock file (create0600) and fcntl.flock exclusive nonblocking acquisition with a fixed monotonic10s deadline. Acquire BEFORE loading queue; hold through validation, read-modify-write and commit. No timeout flag/env. Release/close reliably on every path; no stale PID lock ownership scheme or lock-on-replaced queue inode.
Serialize indent2, ensure_ascii=False, exactly one trailing newline. Preserve unrelated fields, stored ID types and target file mode. Use a unique SAME-DIRECTORY temporary file, flush/fsync(temp), os.replace; clean only your own temp on precommit failure. Never truncate or unlink the queue. No shared mutable global state or new dependencies.
Error boundary clarification: ordinary precommit refusals leave queue bytes/inode/mtime and op-id unchanged; lock-sidecar creation is allowed. Directory fsync after replace cannot honestly be called a no-write refusal. Reuse the existing registry durability pattern, but distinguish post-replace uncertainty: exit8 COMMIT_DURABILITY_UNKNOWN, no rollback and no success claim. This is not exit7 LOCK_TIMEOUT/QUEUE_UNAVAILABLE. A note op-id already visible remains available for safe replay; status/focus callers must inspect state, not blindly repeat. No claim that power-loss durability was tested. Document this distinction concisely in the helper/report.
Do not silently swallow a failed durability step or copy the registry's ambiguous post-rename error as "unchanged queue". New status8 is scoped to this NEW helper; no existing caller is changed.

## Validation, identity and refusal contract
Success0. Usage2; unknown task3 UNKNOWN_TASK; malformed JSON/schema/ledger4; stale compare-and-set5; conflicting op-id payload6; lock/I/O unavailable before commit7 QUEUE_UNAVAILABLE; lock timeout7 LOCK_TIMEOUT; post-replace durability uncertain8 as above.
Match --task against exact string IDs or canonical String(number) text. No coercion/leading-zero normalization, no string preference over numeric when both match. Multiple matches=>2 AMBIGUOUS_TASK with no write; preserve original ID type. Current real queue also has fractional IDs642.2,690.1,697.1 (direct source observation), so do not narrow IDs to integers. Reject invalid/nonfinite numeric schema rather than normalize a different identity. Numeric canonicalization must match this promised JS-style text, not Python's default 7.0 vs JS7 or bool-as-int. If exact edge semantics cannot be supported without changing contract, HOLD, do not silently guess.
Validate root object, tasks array and used row/ledger fields; reject malformed ledger rather than repair or discard it. Preserve arbitrary unrelated fields. No blanket migration of all legacy rows.
Append prior note + ' || ' + segment, using prior note from locked disk only. Missing note may use empty prior text; non-string existing note is malformed. Missing note_op_ids means empty map; present malformed/null/array is error4.
note_op_ids object entries are {payload: lowercaseSHA256, at: UTC_ISO_ending_Z}. Same op-id/same canonical parsed operation payload=>exit0 NO WRITE (same bytes/inode/timestamps); argv ordering does not change digest. Same op-id/different payload=>6 no write. Arbitrary prose containing an op-id is not a ledger entry. Digest a documented canonical parsed operation/task/segment object, never raw argv order; op-id ownership is per row.
status requires both value and --if-current, compares stored status under lock; only matching precondition writes that field. Do not add unrelated updated_at/owner transitions. focus requires existing track in tracks object and changes active_focus only; unknown track=>3 UNKNOWN_TRACK no write. Empty required identifiers/values=>usage2, no guessed defaults.
No grant, revoke, owners, receipts, dispatch-stamp, automatic retries, classifier/model selection, bash, daemon or cross-repo implementation.

## Workflow and security
Read retained tests + relevant established lock/commit idioms in bin/dispatch-registry.py (READ-ONLY); no runtime execution. Implement narrowly, use apply_patch for manual edits, inspect diff, security scan, commit then REPORT/HOLD.
Use all relevant tools/skills/MCP fully within coder scope; no plan mode or additional sessions. No npm, tsc, py_compile, app/test commands; builder and tester perform execution. No reformat/refactor outside owned file.
Snyk is MANDATORY before code DONE: snyk_code_scan MCP or existing bin/snyk-scan.sh tooling on an isolated directory containing only a copy of your owned Python file, with normal already-authenticated scanner context. No real auth-file reading/printing/copying, login/auth/config mutation or broad-home scan. Fix/rescan findings to0; if authentication unavailable report unmet gate, never fabricate zero.
Commit WIP at every phase boundary. Third failed attempt => STUCK with exact error. If a contract ambiguity remains, commit available work then actual HOLD; do not bypass it. No self-cleanup.

## HOLD inject protocol
ACTUALLY execute at a blocker or completed code phase:
telepty inject --ref --submit --submit-force --from qc1136b-coder {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qc1136 | task: #1136 | phase: P1-base core | needs: exact contract blocker or review/builder/tester"
If inject fails preserve REPORT-qc1136.md in worktree and retry once at next boundary. Silent markdown is not a notification.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qc1136b-coder {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qc1136-CODE | task: #1136 | file: bin/tq-write.py | include commit/main source currentness, implemented verbs/exit semantics including post-commit uncertainty, Snyk actual result, no other tracked edits | compile/tests NOT RUN; callers/manifest unwired; parent incomplete"

## [SAWP] envelope
# SAWP (Session Autonomous Workflow Protocol)

Rule 17 전문. 모든 위임 inject에 [SAWP] envelope 포함.

## Envelope (verbatim)

```
[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error
- Never idle — report immediately when done
- Evidence only — no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)
```

## 역할 분리 테이블

| 세션 유형 | 역할 | 빌드 | 테스트 | 로그 | runtime 분석 | 설계 분석 |
|----------|------|:----:|:------:|:----:|:------------:|:--------:|
| 코드 세션 | 코드 수정만 | ❌ | ❌ | ❌ | ❌ | ❌ |
| builder (aigentry-builder-*) | 빌드 + 앱 실행만 | ✓ | ❌ | ❌ | ❌ | ❌ |
| tester (aigentry-tester-*) | 테스트만 + TC 축적 | ❌ | ✓ | ❌ | ❌ | ❌ |
| logger (aigentry-logger-*) | 로그 수집 + 전달만 | ❌ | ❌ | ✓ | ❌ | ❌ |
| analyst (aigentry-analyst-*) | runtime 로그/데이터 분석 + 판단 | ❌ | ❌ | ❌ | ✓ | ❌ |
| architect (aigentry-architect-*) | 시스템 설계, 위헌 심사, 트레이드오프, 리팩토링 | ❌ | ❌ | ❌ | ❌ | ✓ |

## 파이프라인

**디버깅 (runtime 버그)**: builder(빌드+실행) → logger(로그 수집+전달) → analyst(runtime 분석+판단) → 오케스트레이터(위임 결정)

**설계 (구조/아키텍처 결정)**: 사용자/오케스트레이터(요구) → architect(설계 분석+제안) → 오케스트레이터(SPEC 위임) → 코드 세션(구현)

## 경계 원칙

- builder는 로그를 분석하지 않는다 — 실행만
- logger는 판단하지 않는다 — 캡처+전달만
- analyst는 코드를 수정하지 않는다 — runtime 분석+판단만 (로그/데이터 기반)
- architect는 코드를 수정하지 않는다 — 설계 분석+제안만 (구조/의존성/트레이드오프 기반)
- **analyst vs architect**: analyst는 **이미 발생한 일**(로그/데이터/버그)을 본다, architect는 **앞으로 만들 것**(설계/구조/리팩토링)을 본다
- 코드 세션은 빌드/테스트/로그/분석/설계하지 않는다 — 코드만

## Inline excerpts
Envelope and role table above are verbatim. This coder owns code only; builder/tester execute compilation/runtime. All load-bearing contract, security, tools and phase limits are inline. No external cited rule needs lookup.
