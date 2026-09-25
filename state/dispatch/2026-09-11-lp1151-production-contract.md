---
dispatch_kind: fresh-session
---
# Dispatch - lp1151-architect - Production task loop implementation contract

THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC.
state/ paths are orchestrator-side metadata, not files you must fetch.
Source paths below are read-only investigation starting points in your worktree, not assertions of implemented capability.

## Role
You are lp1151-architect, role architect, task #1151 (child #1136).
Worktree: /Users/duckyoungkim/.aigentry/worktrees/lp1151.
Only owned output: docs/specs/2026-09-11-task-loop-production.md.
No code, tests, builds, installation, activation, daemon manipulation or additional sessions.

## Background
User authorizes productionizing a real task-loop system, not another paper-only skill.
The loop must execute approved task units continuously, show current loop/task/phase,
and ask stop/continue only on the first HUMAN prompt after an inactivity gap.
Consecutive conversation must not ask repeatedly. Default gap proposed by orchestrator:
configurable 10 minutes. Explicit stop/continue must resolve without a redundant question.
Worker reports, system notifications and tool output are not human activity.
While waiting for that answer, suspend NEW dispatch, preserve in-flight work/report handling.
Creation of the loop is not authorization to activate it against the whole backlog.

Prior evidence (starting point, remeasure source): main reconciler --loop is a periodic monitor,
not implemented task selection/claim/wake. Main lacks bin/tq-write.py.
Retained queue helper: /Users/duckyoungkim/.aigentry/worktrees/qc1136 at fd014a1209c6da074c3640eea8606902a4c763af;
supports note-append/status/focus, NOT claim/grant. A committed-source retest passed56/56.
Those results do not prove a full loop; security has two unresolved LOW findings.
Parent1136 owns transaction/claim integration;1150 owns binding enforcement, retained draft only.
Do not duplicate those engines or require their entire backlog to finish for every independent slice.

## Goal
Produce a compact implementable contract, aiming <=160 lines, not a broad ecosystem audit.
1. Identify actual human ingress, worker ingress, reconciler and dispatch callers by file/symbol.
   Inspect local available provider integration paths; never infer human identity from message wording alone.
2. Define durable state/transitions for start, task completion, return-question latch, continue,
   pause, stop, failure, duplicate/out-of-order events, restart and authorization expiry.
3. Define the smallest production slice with ONE file owner per worker and dependency order.
   Include skill discovery/install, real caller wiring, status output, package/manifest/CI changes.
4. Give executable behavioral acceptance scenarios and exact existing runner inclusion points.
   Separate measured source facts from proposed behavior and unmeasured runtime.
5. Identify only material user decisions. Existing requirements above need no repeat ballot.

## Constraints / lessons
Reuse existing dispatch.sh, ledger and reconciler primitives, no second scheduler framework.
A skill cannot wake a dead process. A timer monitor cannot claim autonomous task execution.
Status must expose current task ID, phase, loop state and stop/wait reason without secrets.
Persist event identity and return-check latch; a burst of unanswered prompts never re-asks.
Restart cannot fabricate permission; uncertain source or state must stop new effects.
Scope grants must be bounded; destructive operations and external publication retain explicit gates.
Avoid repeated speculative spec expansion. State a concrete dependency blocker if source cannot support ingress.
No live probes that auto-start telepty daemon; read files only for investigation.
Counts and supplied paths are starting sets, not exhaustive measured inventories.

## Workflow
[SPEC FIRST] Implement prohibited. Inspect source, write only the owned contract.
Commit (WIP allowed) at every phase boundary so sleep/API loss does not lose artifacts.
At this single design phase boundary send the real REPORT and HOLD below.
Implementation follows reviewed contract and user approval; do not self-progress.
Include git HEAD, main comparison, actual commands, measured vs unmeasured scopes.

## HOLD inject protocol
Write a durable report in the owned contract first.
Send via actual shell call, not markdown-only:
telepty inject --ref --submit --submit-force --from lp1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: lp1151 | task: #1151 | phase: contract | needs: review and implementation approval | file: docs/specs/2026-09-11-task-loop-production.md"
If transport fails, artifact is authoritative; report failure without retry loops.

## REPORT format
MANDATORY:
telepty inject --ref --submit --submit-force --submit-retry 2 --from lp1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: lp1151-CONTRACT | task: #1151 | file: docs/specs/2026-09-11-task-loop-production.md | commit: YOUR_ACTUAL_COMMIT | include currentness, real ingress, first implementation slice, acceptance gates, material decisions; no implementation/build/test/activation"

## Inline excerpts and [SAWP] envelope
Architect-only assignment: the table below prohibits code/build/test for this phase.
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

## Snyk
N/A for this docs-only phase. Contract must require Snyk supported first-party code scanning
and fix/rescan to zero findings before coder DONE, or explicit unresolved HOLD; zero-new is not zero.

## Boundary
No cross-repo edits, runtime changes, raw spawn, queue edits, or invented successful measurements.
Do not edit retained helper worktree. Report immutable source references instead.
No stopping/restarting/cleaning orchestrator or its bridge/ancestor processes.
If blocked after three attempts, send STUCK with full error rather than silent retries.

## Full capability
Use all available skills, tools, MCP servers and workflows to their full capability within this scope.
Read, rg, git inspection and apply_patch for the owned documentation are authorized.
Read skill-creator at /Users/duckyoungkim/.codex/skills/.system/skill-creator/SKILL.md
when specifying the repo-coupled skill. No external skill is needed to perform this design.

