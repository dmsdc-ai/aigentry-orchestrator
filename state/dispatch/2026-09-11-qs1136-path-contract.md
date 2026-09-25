---
dispatch_kind: fresh-session
task: 1136
---
# Dispatch - qs1136-architect - Minimal queue path security contract

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. State/bin/docs paths are orchestrator metadata unless explicitly designated read-only source or owned output. Role-sandbox is not your worktree.

## Role
Architect qs1136-architect, worktree /Users/duckyoungkim/.aigentry/worktrees/qs1136, branch docs/1136-queue-path-contract, base d974fa6.
ONE tracked output docs/specs/2026-09-11-queue-path-boundary.md, target <=140 lines soft; report small deviation, no repeated reflow. No other writes, code, tests, builds, app/runtime runs, installs, daemon probes, extra workers/subagents or remote research.
[SPEC FIRST] Only implementation-ready contract for approved queue path policy. No new autonomous-loop redesign or further1150rewrite. One bounded phase.

## Approved direction and exact gap
User was asked: "프로덕션의 태스크 큐는 init으로 만든 워크스페이스 내부로 제한하고, 외부 경로 지정은 테스트 전용으로 분리해도 될까요? 기존 외부 큐 경로 사용에 영향을 주는 변경입니다."
User answered "계속 진행해." on2026-09-11. Orchestrator stated this is acceptance of that immediate policy direction. Do NOT re-ask the same direction or invent broader authorization.
Current helper ONLY on /Users/duckyoungkim/.aigentry/worktrees/qc1136/bin/tq-write.py at fd014a1209c6da074c3640eea8606902a4c763af, SHA25612bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca. Read-only. Main lacks it.
It implements note-append/status/focus under flock+atomicreplace. No claim/grant/receipt verbs anywhere in that helper. Those are later implementation, not a merge toggle.
Snyk on exact helper reports two LOW python/PT paths from TQ env to open151 and replace192. Do not assert they are runtime exploit proof, false positives or guaranteed removed by any proposal.
Parallel tester runs immutable committed-source regression; do not change/invalidate that baseline. No third role in this wave.

## Required contract, bounded to the path issue
1. Define trusted workspace identity for installed init-workspace execution and repo development without letting attacker/caller supplied TQ/AIGENTRY_ROOT/marker alone redefine the trust root. Measure actual init marker/shim/caller sources; .aigentry-init.json is metadata, not cryptographic authority.
2. Production queue/path override policy: exact allowed locations and diagnostic/refusal before file/lock/temp effects. Resolve canonical paths, relative/absolute forms, aliases, prefix siblings, symlinked queue/parents, missing/inaccessible roots, queue existence/type and mode preservation. Define TOCTOU boundary honestly; do not claim realpath+startswith is atomic containment.
3. Test-only external-path capability MUST NOT be an environment switch/public CLI flag that can reopen the same bypass in the shipped workspace. Prefer existing patterns and a narrow non-shipped test entry/injected boundary, not another framework. Existing fixtures rely on TQ: name exact per-file fixture change and build/runtime-test ownership, preserve unrelated numeric/durability behavior.
4. Minimal affected-file list with one owner per file; coordinated helper + init manifest/package closure and test seam if needed. No blind runtime flip. State source vs built vs installed boundaries. Repo-development compatibility should be explicit, not silently broken or quietly exempt allwork.
5. Specify executable negative tests for current permitted external paths and the exact candidate remedy comparison BEFORE permanent fix, plus positive within-root/fixture controls. Tester runs isolated temp roots/sentinels, no livequeue/realworker/daemon. Security rescan on exact revised source remains required; no scan guarantee.
6. Keep error contract stable unless indispensable: precommit refusal no queue/foreignfile changes; existing7 unavailable/locktimeout,8 postreplace durabilityunknown,4 malformeddata, numericidentity semantics. No claims/grants/loop/default/README/provider tasks bundled.
If a design tradeoff genuinely remains, choose the smallest safe option consistent with approved direction and disclose it; HOLD only for intent/destructive scope changes, not routine technical details.

## Read-only starting sources
Your worktree bin/init/cli.mjs (workspace resolution184+, createState301-307, stamp472+), bin/init/manifest.mjs, bin/dispatch.sh, bin/lib/node-shim.sh, tests/packaging/smoke-init.sh.
Read helper from pinned qc1136 above, test source /Users/duckyoungkim/.aigentry/worktrees/qt1136/tests/dispatch/workflow-task-writer.test.ts (TQ fixtures).
Existing broad docs/specs/2026-09-08-workflow-production.md is context-only design, not implemented authority. #1150draft5c9ff23 is UNAPPROVED; do not inherit its false fullhelper/atomicity claims.
Starting paths are measured pointers, not a complete callgraph. Re-read actual relevant writers/callers; no whole-ecosystem audit.

## Workflow and REPORT
Source/contract check -> bounded exact path contract + failing-first plan -> surgical diff review -> commit -> real REPORT/HOLD. No prototype/execution in architect phase.
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from qs1136-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qs1136-CONTRACT | task: #1136 | file: docs/specs/2026-09-11-queue-path-boundary.md | include commit/main currentness, exact trust/test boundary, minimal file ownership, reproduction plan and unresolved limits; no code/test/activation"

## Snyk and lessons
Docs-only N/A. Future coder must scan changed first-party source via snyk_code_scan or bin/snyk-scan.sh, fix-rescan findings before DONE; tests/production scans separate. No false same-file disagreement or waiver.
Avoid environment-selected 'trusted' root circularity, lexicalprefix containment, symlink check/use overclaims and off-mode 'fixes'. Narrow trust boundary within supported tooling, not impossibility claims about preventing a human from editing arbitrary files.

## HOLD inject protocol
At a blocker or the phase boundary, ACTUALLY execute:
telepty inject --ref --submit --submit-force --from qs1136-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qs1136 | task: #1136 | phase: assigned phase awaiting | needs: evidence review or exact blocker"
Commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase. Silent waiting is forbidden. A markdown-only HOLD is not notification. If transport fails preserve REPORT-qs1136.md locally and retry once next boundary, never probe/restart the daemon.
After three failed attempts report STUCK with the exact error; never keep retrying deterministic failures.

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
Full envelope and role table above verbatim. All load-bearing limits and reporting instructions are inline; mentioned historical docs are context-only, not implicit approvals. Tester executes tests, builder compiles, coder changes production code, architect designs.

## Full capability and boundaries
Use all relevant skills, tools, MCP and workflows fully within the assigned single-file role. Read/rg/Git/structured parsers/apply_patch and bounded shell allowed; plugins optional. No plan mode, subagents, other workers, remote push, live queue access, daemon/model/session operation, credentials/config changes or publication. Notify orchestrator only at stated boundaries.

