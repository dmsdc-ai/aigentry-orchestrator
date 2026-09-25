---
dispatch_kind: re-dispatch
task: 1136
---
# Dispatch - lp1136-architect - r3 scoped source review corrections

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this revision. Carry-over from lp1136-loop-spec + lp1136-review, consumed in your workspace, and your REPORT8357481a/spec54ea30a. Same one-file output and boundaries. state paths are orchestrator metadata, not a required worker queue.

## Role and goal
Continue architect-only in /Users/duckyoungkim/.aigentry/worktrees/lp1136, branch docs/1136-autonomous-loop. Only docs/specs/2026-09-08-workflow-production.md. Keep the chosen six policy directions and bounded defaults; user already approved improving them. NO new audit, implementation, test, build, probes or user-policy round. Make one compact source-backed correction (target <=70 net new lines), then commit/report.

## Review findings to resolve
1. BLOCKER, measured on main a3c97c2: src/dispatch/cli.ts:1077 calls spawnWorkspace, :1095 waits ready, :1102 THEN beginDelivery, :1126 inject. Therefore no registry record means no recorded inject, NOT no worker. The comment 'nothing fallible between begin and inject' says nothing about pre-begin workspace creation. Your K26 exactly-one-worker expectation lacks a safe spawn recovery contract. Registry op_prune :659-680 may remove retired history too. Separate spawn intent/outcome from inject intent/outcome; reconcile exact sid+session identity and missing/pruned history before retry, and persist uncertain state instead of respawning. Specify minimum added state/handshake and exact crash fixture before/after spawn and before begin-delivery. Do not claim a registry absence proves an external negative.
2. Fencing/revoke: taskGateCheck is :1039, before routing/spawn/readiness, not just before inject. A check at entry plus fenced later WRITES does not fence delayed external effects. Specify serialized actuation admission/linearization with claim generation at spawn/inject boundaries, transition valid states (expired dispatching is not automatically stealable), exact revoke semantics when an action is already admitted, and stale-owner behavior. Never promise cancellation of an already handed-off effect. Add deterministic delayed-ready/revoke and stale-owner fixtures.
3. Artifact contract remains contradictory: V2 still says inbox/report digest only despite revised prose. Make actual artifact repo/commit/path/digest + retained reachable location verification the V2 predicate. A git object existing without retained branch/reference is not durable preservation. Settlements must bind assignment/attempt and actual reviewed evidence; list missing/stale ambiguity refusals. Don't turn all report types into a single fake artifact path.
4. Resource-local blocking is NOT task-local blocking: another task may own the same file/worktree/terminal sid. Define minimum resource identity and compare it during selection/reap/next action so conflicting tasks block while independent work advances; test X and Y sharing a resource vs unrelated Z. No global stall.
5. Implementation contract: claim and receipt lack exact input/result field definitions for phase/ref/repo/action/next-action and ack vs reviewed-progress, while sample wake says 'settled' BEFORE review and can misrepresent evidence. Specify concise validated structs plus canonical payload digest/result for idempotency, immutable action/ref digest, and how initial action is authored and later next-action becomes eligible. A wake is unreviewed evidence, NOT settlement approval; a received ack alone must not advance the phase. First P1 must not invent this at coding time.
6. Keep file ownership honest: 'P1 alone' currently means two files; split helper coder from manifest integration owner. Shared src/dispatch/cli.ts requires serialization, not an inherent dependency on all1133 F3 landing first; mark integration order as orchestrator reservation, otherwise loop is unnecessarily blocked. The active1148 architect only owns a different spec and will consume the router interface, not implement another loop selector.

## Workflow and boundaries
[SPEC FIRST] Read those exact sources (starting references, remeasure currentness), revise only the one spec, commit at boundary (WIP allowed), then ACTUALLY send REPORT/HOLD. All six reviewed directions remain approved; technical corrections are not a new policy ballot.
Source design review is NOT a reproduced runtime failure. No tests/build/runtime or code edits in this phase. Do not use BUILT/ALL RESOLVED as production claims; state spec vs implementation separately. Source-count lists require exact measurement scope, not inherited assertions.

## HOLD inject protocol
At blocker or phase boundary persist available output and ACTUALLY call:
telepty inject --ref --submit --submit-force --from lp1136-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: lp1136 | task: #1136 | phase: SPEC-review | needs: exact technical blocker or review of corrected contract"
Silent waiting forbidden. Commit first; --ref makes report durable; if command fails preserve REPORT-lp1136.md and retry once next boundary. After three failed attempts send STUCK.

## REPORT
MANDATORY after commit ACTUALLY call:
telepty inject --ref --submit --submit-force --submit-retry 2 --from lp1136-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: lp1136-SPEC-corrected | task: #1136 | file: docs/specs/2026-09-08-workflow-production.md | include SHA, source/currentness, six correction decisions, precise first ONE-file handoff and no-execution limitation | needs: contract review, no parent-DONE"

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

## Inline excerpts and full capability
Role envelope above is verbatim. Read/Grep/Glob/read-only Git and one spec edit/commit; use all applicable skills/tools/MCP within design-only scope. No additional agents/sessions, destructive actions, runtime probes, bridge operations, live config or source writes. Snyk N/A docs only; future first-party code must scan/fix/rescan before coder DONE. Prior refs contain all inherited constraints.
