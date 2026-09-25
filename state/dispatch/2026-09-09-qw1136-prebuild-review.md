---
dispatch_kind: re-dispatch
task: 1136
---
# Dispatch - qw1136-tester - Close two pre-build evidence gaps

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this revision. Carry over qw1136-writer-repro and task ID/10s clarification, both consumed. Same worktree/branch, same exclusive tests/dispatch/workflow-task-writer.test.ts. State paths remain orchestrator metadata. No production code/build/new session.

## Review accepted
Read full0475cfa: isolated actual focus-writer lost-update reproduction is accepted as your bounded evidence; authored29 cases are NOT executed-suite totals. No missing-helper failure will be called a race reproduction. Frozen P1-base command/exit/typed-ID/10s contract unchanged.

## Narrow corrections and measurement
1. Lock test currently accepts immediate exit7 LOCK_TIMEOUT, so it cannot verify the required fixed10s acquisition deadline. Measure monotonic elapsed around run() after LOCKED, assert not before10s; existing15s child timeout bounds the upper side. No wallclock/sleep-only racing. Keep all subprocess joins/finally cleanup, same one file.
2. Before permanent implementation, verify the proposed remedy in the SAME isolated source-derived scenario: a shared stable flock acquired BEFORE queue read and held through atomic replace, with both synthetic writers cooperating. Contrast unlocked existing-source loss vs lock-before-read preserves BOTH focus and note. Use bounded fixture-only wrappers/proof, not edits to actual bin code or a live queue. A wrapper only around rename is insufficient and should not be called the solution. Record exact source/barrier/lock placement and actually observed counterpart result in header/report. This confirms the transaction strategy, not deployed caller wiring or the unbuilt helper. If no valid bounded counterpart can be measured, explain exact gap; don't overclaim.
3. Snyk unavailable under synthetic HOME does not establish the normal authenticated scanner is unavailable. Runtime test/diagnostic fixtures MUST keep isolated HOME; scanner is a DIFFERENT subprocess context and may use its already-configured normal authenticated CLI/MCP environment ONLY to scan an isolated directory containing the owned test-file copy (with synthetic test data). No manual credential-file reads, no token print/copy, no auth/login/config mutation or new account. Do not expose other repository/user files or run --all from the full repo. Prefer available authenticated snyk_code_scan MCP; otherwise existing bin/snyk-scan.sh --all from owned-copy directory with normal tool HOME. If still unauthenticated/unavailable, retain precise error as unmet scan gate, no zero-finding claim or repeated login attempts.
Do not broaden to Node path/style cleanup: existing tests use import.meta.dirname too; builder measures compile support. No drive-by refactor.

## Workflow and HOLD
[SPEC FIRST] Prior scoped test contract stands; only these test/evidence refinements. Execute allowed isolated counterpart, update sole test file, scan as above, commit (WIP at boundaries), REPORT/HOLD. No tsc/npm build/npm test; builder compilation still next. No parent DONE.
At blocker/boundary ACTUALLY execute:
telepty inject --ref --submit --submit-force --from qw1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qw1136 | task: #1136 | phase: pre-build test review | needs: exact blocker or builder compilation"
Silent waiting forbidden; --ref is durable, fallback REPORT-qw1136.md if delivery errors, retry once at boundary, three failures -> STUCK.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qw1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qw1136-TEST-REVISED | task: #1136 | include SHA, lock-duration test delta, exact unlocked/locked diagnostic results, Snyk actual result or unmet gate, compiled-suite NOT RUN, no production changes | needs: builder compile; no parent DONE"

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

## Full capability and boundaries
Use relevant tools/skills/MCP fully within tester scope. Read/Git/owned test edit/commit, synthetic diagnostic and owned-copy SAST allowed. No production/source/caller/manifest/runner change, build, new dependency, account/config write, bridge or live session operation, new agents. All original fixture safety and evidence-scope constraints remain binding.
