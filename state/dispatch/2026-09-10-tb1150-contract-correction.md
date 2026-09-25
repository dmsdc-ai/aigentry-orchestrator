---
dispatch_kind: existing-session
task: 1150
---
# Dispatch - tb1150-architect - bounded SPEC correction

## Scope and authority
Continue the existing #1150 design assignment, in /Users/duckyoungkim/.aigentry/worktrees/tb1150 on docs/1150-task-binding. Starting artifact 273ddc703dc4aa8c43adde80c86884e38a702737, base5a3adfc; orchestrator main measured5c9a7a7. Remeasure currentness and separate source facts from proposed #1136 contracts. Own ONLY docs/specs/2026-09-10-task-binding-enforcement.md. Existing approved design scope, NOT implementation approval.
[SPEC FIRST] No production code/config, tests, builds, runtime execution, installs, daemon probes/restarts, extra workers/subagents, publication, livequeue or main writes.
State/bin paths outside your named worktree are orchestrator metadata, not writable worker outputs.

The user's requirement is already explicit: all task-shaped work must be task-bound and productionized. Do not ask the user whether to keep executable work permanently merely audited or ship broken/off enforcement. These contradict the requirement, rather than representing unresolved intent. One bounded correction pass; no new broad audit, no line-count reflow. A concise <=280-line target is soft; report necessary deviation and stop.

## Review corrections to resolve or explicitly mark unresolved
These are review findings and source pointers, not a replacement design or complete measurement. Re-read the cited actual callers/writers.

1. PRE-SPAWN: src/dispatch/cli.ts main1033 gate ->1075 spawnWorkspace ->1095 readiness ->1102 beginDelivery ->1126 inject. Your registry-only begin commits AFTER a real workspace/CLI exists. Reuse the #1136 r3.1 design docs/specs/2026-09-08-workflow-production.md section12.2: durable pre-spawn claim, separate spawn/inject intents, B1/B2/B3 grant-generation/status/spec_rev/resource checks, replay unknowns. Do not invent a second authority/ledger. Neither that design nor tq-write.py is wired on main. The existing B3-to-inject handoff race is explicitly bounded there, not magically eliminated.

2. TRANSACTION: Registry flock does not lock queue/status/revoke writers. Retract the "only race-free option" and permission-valid-until-next-begin claim. Coordinate authoritative task/claim/grant operations with the same queue writer/CAS contract; specify lock ownership/order and honest remaining handoff boundaries. Current unlocked whole-queue dispatch-stamp can overwrite status/grant changes, not merely lose prose. Reuse #1136 dispatch-stamp rewrite rather than retaining unsafe RMW as "evidence only".

3. ENFORCEMENT: Production must refuse unbound/unapproved task-shaped effects before they occur. Shipping inert/shadow code is NOT production activation; no normal off/warn bypass, no rollback disabling enforcement. Rollback should pause new work or retain compatible enforcement, preserve evidence and allow narrowly safe lifecycle actions. Legacy/unrecorded rows confer no grant: observe/preserve/cleanup, but executable continuation requires explicit binding/authority. Queue bootstrap must be action-limited. Closed enum alone does NOT stop a caller labeling arbitrary work as recovery-reconcile/gate-resume. Define bounded verb/subject/identity/resource constraints and deny arbitrary ref/commands under exemptions, including queue-unavailable mode. Attacker-chosen env/path cannot become authority by merely logging it. Define a trusted configuration boundary for supported tooling; arbitrary external shell/file edits remain explicitly outside the achievable enforcement perimeter.

4. BINDING / COMPATIBILITY: Ref frontmatter plus repo is not scope authorization. Required grant task/phase/action/spec_rev/resource and exact effective-ref identity must be compared; distinguish IDs/digests/provenance from authority. Existing registry dedup is (sid,ref_hash), NOT (task,attempt,ref_hash). Preserve rc7 delivery-unknown, rc8 observed-write dedup and explicit retry-unknown supersession; address task switch, redelivery vs new attempt, restart/SID reuse. session_epoch currently null is not verified fencing. Validator accepting extra keys alone does not prove old writers/migrate/prune/rollback preserve them. Specify roundtrip/fail-closed version/migration checks; do not mandate schema2 without writer evidence. Record remaining compatibility blockers honestly.

5. SOURCE QUALIFICATION: HITL src/hitl/cli.ts608-620 sends an approve/reject gate notification (with optional note), not an arbitrary work-ref. Separate read-only notification/context from authorization to resume executable work, which must retain the binding; do not equate every ack with a new dispatch attempt. ask.sh may have a bounded information-only channel, not permanently ungoverned executable delegation. tq-status.sh and tq-track.sh are READ ONLY; tq-focus.sh writes when given an arg. o.taskId identifier search is evidence about structured propagation at inspected sites, not proof no ref contains task metadata. #1136 says "Nothing here is implemented": its grant/claim semantics are specified, NOT "gated today".

6. PACKAGING CORRECTION: Your universal installed-dispatch failure claim is contradicted by the supported source path: package bin is bin/init/cli.mjs; manifest copies bin/dispatch.sh; init createState301-307 seeds workspace/state/task-queue.json; dispatch.sh exports its OWN bin as DISPATCH_SCRIPT_DIR; bin/lib/node-shim.sh resolves the compiled implementation from the package but retains that workspace path. Re-read these sources. Distinguish supported init workspace execution from direct package-internal invocation, source prediction from actual clean-prefix measurements. No install/runtime test in this phase. Keep clean-prefix safety/closure as a required verification gate, not a falsely observed defect or broken/off user choice.

7. VERIFICATION / OWNERS: F1-F13 are proposed/predicted, not all known RED. Existing duplicate-id protection is a positive regression control. Report/cleanup duplicate re-actuation and installed-path failure are unmeasured; do not label them observed or apply dispatch rc8 semantics blindly. Replace stamp-only concurrency case with authoritative status/revocation/pre-spawn/crash witnesses, include unknowns and no-side-effect assertions. Later tester must use isolated HOME/state/stub process/network/lifecycle boundaries, no real worker/daemon/release. Verify runner registration via actual caller lists; "referenced by nothing" must distinguish citations from execution. Split tracker/reconciler and package/test file owners, one file/session. State dependencies consistently: shared interfaces before consumers; shared dispatch source serial with1133/1136. No test IDs allocated or tests run now.

## Deliver
One precise revision of the owned spec; retain measured useful inventory. Explicitly mark unresolved contract issues as activation blockers, never assert safety from an unproven lock/check. Commit, report actual SHA/base-vs-main, corrected claims and remaining blockers. No speculative broad new framework. Full requirement compliance may depend on unmerged1136: say so rather than circumvent it.

MANDATORY after commit, actually execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from tb1150-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: tb1150-REVISION | task: #1150 | file: docs/specs/2026-09-10-task-binding-enforcement.md | include commit/main currentness, corrections, remaining contract blockers, no code/test/activation/release"
Then actually execute:
telepty inject --ref --submit --submit-force --from tb1150-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: tb1150 | task: #1150 | phase: revised binding contract | needs: review before reproduction/implementation"
If transport fails preserve REPORT-tb1150.md and bounded retry once. No silent idle; third failed attempt STUCK with exact error.

## Lessons and limits
Preserve existing fixes. No source/runtime/installed equivalence. REPORT/HOLD/WORKTREE_ACTIVITY do not grant implementation or prove completion. No inferred user approval from native composer suggestions. Record what was read and not executed. Serial continuation justified by sole owned spec; same visible session and CLI retained, not new spawning or effort policy.

## [SAWP] envelope and role separation
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


## Snyk and capability
Docs-only Snyk N/A; no production security clearance implied. Future first-party coder must scan and fix-rescan before DONE; tester/builder verify separately.
Use all relevant skills/tools/MCP/workflows fully within this single-file design scope. No plan mode, subagents, implementations, builds/tests, daemon changes or external research.

