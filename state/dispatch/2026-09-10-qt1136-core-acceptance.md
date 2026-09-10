---
dispatch_kind: fresh-session
task: 1136
---
# Dispatch - qt1136-tester - Execute queue core acceptance and pin missing boundaries

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Orchestrator state/docs/bin paths are metadata unless explicitly designated owned output or read-only source below. Role-sandbox is not worktree. No prior chat is needed.

## Role
You are qt1136-tester, tester only, in /Users/duckyoungkim/.aigentry/worktrees/qt1136, branch test/1136-queue-writer-acceptance, pinned base d361397a6b3a75e7aa98c2612726ecbef9911cf2.
Exclusive tracked output: tests/dispatch/workflow-task-writer.test.ts. Source bin/tq-write.py is READ-ONLY; do not apply fixes, including null correction. Do not touch production queue, callers, manifests, package/config/runner, other tests, main or another worktree.
A coder in separate qc1136 worktree owns Python implementation; no peer work delegation. Your pinned baseline must stay stable even if that branch advances.

## Background
User authorized production task-loop improvements; this is only shared queue transaction P1-base, not full loop or activation.
Prior tester ACTUALLY reproduced lost note using unmodified tq-focus.sh, then demonstrated same stable sidecar locking BEFORE read THROUGH replace preserves focus+note. This is lock-strategy evidence, not future helper acceptance.
The retained 29-test count is prior authorship, not runtime discovery. Test source blob3b2ee8fc5cefd7ca078b1d03456b3b37cf5b378b; builder compiled it at source d73f112d, retained build checkout qb1136 at b0c2871.
Exact existing emitted JS: /Users/duckyoungkim/.aigentry/worktrees/qb1136/dist/tests/dispatch/workflow-task-writer.test.js, SHA256 fa764b9e81af227d8c2bbfe18c2bb2e2b674de29bfed8228c989b5c7dd27b990.
Compilation succeeded using shared dependencies, not a clean install. No actual acceptance run yet.
Pinned helper d361397 blobc6654295b5614e18cd3ab4b70e18e6314e48b03f, 419 lines. Snyk reports 2 LOW after rescan: NOT waived/clean. Testing is diagnostic only, not promotion permission.
Worker's earlier null count was wrong: direct key-existence recount on main+qc1136 gives1148rows,161missing,0present-null,986strings,1array (id828). Recount fixture/source where relevant; do not read live queue during tests.

## Approved contract
[SPEC FIRST] This ref authorizes test execution and test accumulation ONLY. No production fixes.
Commands: note-append --task ID --segment TEXT --op-id ID; status --task ID --status VALUE --if-current VALUE; focus TRACK.
Stable queue.lock, fixed monotonic10s acquisition deadline, lock BEFORE read THROUGH commit. Preserve unrelated data, ID types, mode; indent2 ensure_asciiFalse + one trailing newline; own same-dir temp only.
Exits0success/replay,2usage/ambiguous,3unknown task/track,4malformed,5staleCAS,6op-id conflict,7precommit unavailable/timeout,8post-replace durability uncertainty.
Missing note => empty prior; present null/non-string =>4. Empty prior => segment alone, nonempty prior => prior+" || "+segment. This is clarified contract, not the current d361397 behavior for present null.
Exact string IDs / canonical JS String(Number) numeric IDs, no leadingzero coerce, multiplematches=>2. Fractional642.2/690.1/697.1 are supported. Bool/nonfinite invalid, never normalized into another identity.
Note op-id visible replay preserves bytes/inode/timestamps; payload digest uses parsed operation not argv order. Exit8 must not claim unchanged/rollback: after replace, note op-id can support replay; status/focus require reread.

## Goal
1. ACTUALLY run retained compiled acceptance against the pinned helper in isolated fixtures; report discovered counts, exits, durations and exact hashes.
2. Reproduce missing boundary behavior using actual pinned helper entrypoints, not a reimplementation: present-null, canonical numeric text, pre/post-replace error separation.
3. Add durable bounded regression assertions to the ONE owned TS file, preserving original tests. Clearly distinguish actually executed baseline/diagnostics from new TS authored but NOT compiled/run.
4. Commit test evidence in concise source header and REPORT; no broad documentation phase. Failures are useful evidence, not task completion or permission to fix production.

## Isolation and baseline execution
Inspect then copy ONLY the already-built JS byte-for-byte into your ignored dist/tests/dispatch/ path. Its REPO resolves three parents to YOUR qt1136 worktree, with pinned read-only helper. Do not use a symlink for the JS; verify resulting import.meta.dirname/root and hashes before execution.
No npm/tsc/build/transpile/package install. Node20.20.0 or available runtime identity must be recorded; baseline JS uses only Node builtins. Your package.json supplies ESM context.
Run node --test against that exact single JS file, with bounded outer timeout >=60s, all children joined. Existing lock case has 10s deadline and15s child timeout; do not shrink the contract.
Verify existing tests create synthetic TQ/HOME/TMPDIR and no path falls back to production queue. All additional child environments likewise minimal/synthetic; no inherited credentials or running sessions.
No telepty/cmux/curl/model/daemon invocation from tests. Real telepty is allowed ONLY for your own HOLD/REPORT notification, outside fixture processes.

## Additional exact diagnostics and regression accumulation
Use Python stdlib subprocess/importlib harnesses ONLY in disposable temp roots; actual helper source unmodified, PYTHONDONTWRITEBYTECODE=1, bounded process waits and finally cleanup/join.
A. Note controls: missing key and empty string succeed with segment alone; present null/list/number must4 and unchanged; preexisting nonempty string appends delimiter exactly. Current null success should be a failing desired assertion, not rewritten expected behavior.
B. Numeric identity: compare helper actual result to Node JSON.parse(raw).tasks.map(t=>String(t.id)) on the SAME raw fixture. Include 7.0, -0, current fractional IDs, exponent thresholds1e-7/1e-6/1e21, integer literal1000000000000000000000 and9007199254740993, leadingzero strings and number/string ambiguity. Preserve serialized numeric values/types; do not silently narrow contract to small integers. Distinguish expected-failure reproduction from controls.
C. Fault boundaries: scoped monkeypatch in isolated harness, distinguish regular-file fsync and directory fsync by fstat. Before-replace fsync/replace failure=>7 unchanged/no own-temp leak. Directory fsync failure AFTER successful real replace=>8, visible new note+ledger; subsequent exact replay=>0/no write, not false rollback. No real system fault, sleep, signals to live sessions or power-loss claim.
D. Small encoding control: JSON numeric overflow in an unrelated field (raw1e400) and malformed note text must not silently emit invalid JSON or leak own temp. Use a strict JSON reader/queue byte snapshots. If desired contract is not determinate, report precise observed result + HOLD rather than inventing a migration.
These are a scoped starting set derived from source review, not a complete defect inventory. Actual failure witnesses plus passing controls are required before any further fix dispatch.
Retain reproducible harness snippets in owned test file as executable test fixtures where feasible, avoiding a duplicate production implementation. New TS is AUTHORED/NOT COMPILED until a later builder; direct diagnostic execution is a separate measured fact.
scripts/run-tests.mjs source recursively collects dist/tests/**/*.test.js; re-read this predicate. This is not tests/dispatch/run-all.sh's T*.sh guard runner. Do not claim registered execution merely because the source exists.

## Workflow
One authorized tester phase: verify pinned sources/build artifact, execute baseline and isolated diagnostics, add bounded tests, diff/security check, commit then ACTUALLY HOLD+REPORT.
Commit WIP at every phase boundary. Source/fixture mismatch, missing compiled artifact, unexpected live path, or unresolved contract => actual HOLD before continuing; do not repair environment or source by guessing.
No need wait for blanket green: report each real failure as evidence. Do not mark acceptance complete while new tests remain uncompiled/unexecuted.
After three failed attempts report STUCK with exact errors and stop the loop.

## HOLD inject protocol
At the completed phase or any blocker ACTUALLY execute:
telepty inject --ref --submit --submit-force --from qt1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qt1136 | task: #1136 | phase: pinned acceptance and boundary reproduction | needs: exact failed assertion, missing evidence or builder compilation of new tests"
If notification fails, preserve REPORT-qt1136.md in worktree and retry once at next boundary. Inline markdown is not a notification.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qt1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qt1136-TESTS | task: #1136 | file: tests/dispatch/workflow-task-writer.test.ts | include commit/main currentness, pinned helper/source/JS hashes, exact baseline and diagnostic commands/counts/results, named failure witnesses and controls, Snyk actual result, new TS NOT COMPILED/RUN | no live fix; parent incomplete"
Also ACTUALLY send the structured test report, using MEASURED counts for the executed baseline only (not authored tests or unrelated diagnostics):
telepty inject --ref --submit --submit-force --from qt1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "TEST_REPORT: qt1136-tester | suite=queue-writer-core-pinned-baseline | total=MEASURED | passed=MEASURED | failed=MEASURED | skipped=MEASURED | duration_ms=MEASURED"
Replace MEASURED with integers from actual runner output; total=passed+failed+skipped. Report diagnostics separately so planned tests do not inflate totals.

## Snyk
Applicable: new/modified first-party TS. After edits, scan an isolated copy of only owned file with existing snyk_code_scan MCP or normal authenticated snyk code test. Do not read/copy credentials, login, mutate global config or scan home. Fix/rescan findings to0; otherwise HOLD with exact results, no waiver or invented zero. This scan is distinct from still-unmet Python scan.

## Boundary and full capability
Use all applicable Read/Edit/apply_patch/Grep/Glob/Git/Node/Python test tools, testing skills and Snyk MCP fully within role. No extra agents, task delegation, plan mode, production code edits or security policy changes.
No daemon/reconciler restart, cleanup, broad home search, live model request, npm install/publish, remote push or main queue mutation.
Production null correction/security review waits for tested witnesses; tester may not accept Snyk exceptions or enforce a new TQ root restriction.

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
The full envelope and role table above are verbatim. You are the TESTER from that table, so isolated test execution and TC accumulation are your job; builder-only compilation and coder-only production edits remain separate. All load-bearing contract, safety boundaries, tools and reporting instructions are inline.
