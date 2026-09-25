---
dispatch_kind: fresh-session
task: 1150
---
# Dispatch - tb1150-architect - Production task-binding enforcement contract

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. State/docs/bin paths are orchestrator metadata unless explicitly designated read-only context or owned output. Role-sandbox is not your worktree; no prior chat needed.

## Role
You are tb1150-architect, architect. Worktree /Users/duckyoungkim/.aigentry/worktrees/tb1150, branch docs/1150-task-binding, base5a3adfc.
Only tracked output docs/specs/2026-09-10-task-binding-enforcement.md, target <=220lines. Do not repeat reflow/regex passes merely to hit a line count; report any small length deviation. Source/runtime read-only; no code/config/taskqueue changes, tests, builds, scripts/app execution, installs, daemon/worker restart, extra workers/subagents or main writes.
Prior1149 public proposal is preserved in main docs/proposals/2026-09-10-public-install-onboarding.md (design only); worker reaped. Prior751 diagnostic/spec workers also reaped, with evidence and an UNAPPROVED recovery sketch retained. Only this design lane runs now;751 implementation waits user-visible exit-code approval and race-safe contract/reproduction. UniversalD external_dispatch auto architect, visible samecmux. No shared productionfile writes.

## User requirement
USER: all work must be task-bound by enforcement, not convention, and productionized. All changes should be made with production in mind.
Design the minimal enforceable extension to current machinery. Not merely README instructions or a required --task flag at one entry point. Cover task-shaped execution from dispatch through retry/recovery/verification/release, with durable evidence and bounded authorization.
[SPEC FIRST] This phase is contract/design only. No new runtime enforcement activated before reviewed spec, failing-first reproduction, coder implementation and actual tester/builder checks. Do not implement a broad new framework or silently bypass user/product/destructive approvals.

## Existing context to remeasure
Task736 previously added dispatch --task validation, optional --no-task reason audit, hard/warn/off env mode, tracker/reconciler wiring. That historical done flag is NOT proof that today's complete callgraph is gated. Recheck writers/callers including legacy vs current TS/shim paths.
Task1136 owns autonomous workflow safety and transaction core: core bin/tq-write.py exists ONLY on work/1136-queue-writer-core commitfd014a1209c6da074c3640eea8606902a4c763af, sourceSHA12bce41d...; main lacks it. Test-only candidate56/56 +two numericcontrols2/2, original56/51/5; committed-source retest pending and PythonSnyk2LOW unresolved. Don't design on "live transactional core already wired".
Read-only design context docs/specs/2026-09-08-workflow-production.md and docs/specs/2026-09-09-adaptive-model-effort.md if present. Their authority is design only. Task1133/1148 routing provenance must carry samebinding, not spawn a separate task ledger.
Protected lifecycle: never kill/delete/cleanup the orchestrator session or its bridge/ancestors automatically. Completed workers are autonomously reaped after verified durable artifacts; do not turn cleanup into endless approval prompts.
Observed telemetry WORKTREE_ACTIVITY files/counts is evidence only, not tests/completion. Source-vs-built-vs-installed artifact identity and task phase-vs-parent completion must remain distinct.

## Scope of spec
1. Define task/action/attempt/session binding and lifecycle invariants. Which IDs become immutable, when liveness/status/approved scope checked, what survives restart, idempotency and atomicity boundaries. Reuse existing schemas/helpers; don't invent distributed consensus for single-host needs.
2. Current reachability inventory from actual writers/callers: user dispatch/spawn, existing-target/ref/inline work, tracker retry/recovery, reconciler/HITL resume, schedules/autonomous selection, subordinate/tool execution if controllable, task mutation, build/test/release entrypoints, reporting/artifact/cleanup. List measured/unmeasured domains; historical rule list is not coverage proof.
3. Fail closed for missing/unknown/ambiguous/terminal/mismatched task or unapproved action BEFORE effects. Bind retry to original task/attempt lineage; task state changes after validation must not create a race. Define pending approval/revocation/expiry handling with no invented approval.
4. Prevent task-id laundering: unrelated existing ID, mismatched worker/repo/file/action, raw no-task bypass and warn/off modes must not silently grant operational work. Distinguish syntactic existence from authority/scope; task creation itself needs bounded auditable bootstrap, not infinite prerequisite recursion.
5. Explicit limited read-only discovery/conversation exemption versus task-shaped side effects. Emergency safety/cleanup/recovery cannot be blocked into leaking resources by terminaltask status or deadqueue; define narrowly authorized auditable lifecycle actions, never blanket --no-task. User's "all work" is not permission to disable observability until a task is created.
6. Enforcement limit: repository tooling cannot cryptographically prevent a human or arbitrary external shell/LLM tool from editing files outside controlled gateways. State hard-gated vs hook-audited vs unobservable truthfully; propose practical controls and remaining gaps, not "every possible action blocked" without mechanism.
7. Production evidence: final status only after explicit phase evidence, commit/build/test/security/tarball identity; WORKTREE_ACTIVITY/delivery/spinner notcompletion. Exact npm package closure/clean-prefix entrypoint checks, schema compatibility/migrations, authentication/privacy, rollback/kill switch, support OS scope. Runtime/default/release activation separate gates, not a documentation claim.

## Verification contract and delivery slices
Give bounded failing-first fixtures for each highest-risk bypass. Architect does NOT run them: name owners and exact expected effects/refusal; tester later proves old behavior and exact candidate remedy before coderfix.
Cover missing/duplicate/string/fractional task IDs, stale/terminal state, concurrent dispatch or changed status, retries across restart, duplicate report/cleanup, unavailable queue/partial commit, policy override tamper, explicitread-only bootstrap, all automated productioncallers and package-installed path.
Show actual runner registration surface vs testfile existence; identify file-owning coder/tester/builder slices, safe parallelization and genuine samefile/data dependencies. Coordinate sharedsrc/dispatch/cli.ts andqueue contracts with1136/1148, no competing edits.
Distinguish measuredsource facts, proposed contract, required runtime tests and unmeasured support. Perconclusion cite SHA:path:line and whether HEAD/dirty/runtime. Don't rewrite unrelated rules/status vocab or add a generic workflow engine.
List genuine userpolicy decisions only if technical reading leaves competing intent; default is task-bound authorized work with production gates, no repeated confirmation within approved scope.

## Workflow
Single bounded spec phase: source/callsite review -> minimal contract/gaps/test plan -> diff/linecap review -> commit -> real REPORT/HOLD. No implementation, broader audit, remote/model/provider research or runtime execution.
MANDATORY: commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase. Third failed attempt=>STUCK exacterror; never silentidle. HOLD immediately if scope must widen. Use precise Edit/apply_patch, not repeated whole-file regex/reflow passes; a bounded unresolved design draft is preferable to unsupported safety claims or formatting-only loops. No new daemon probes: notification only at completion, durable report fallback if transport fails.
Counts above are starting categories, not a measured completecallgraph. Recount actualsources. No rootcause claim from filenames/grepabsence alone: enumerate searchedscope, dynamic/unmeasured boundaries and relevant callers.

## HOLD inject protocol
ACTUALLY execute after commit or blocker:
telepty inject --ref --submit --submit-force --from tb1150-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: tb1150 | task: #1150 | phase: task-binding production spec | needs: bounded contract review before reproduction/implementation"
Every HOLD/REPORT durable via --ref; markdownonly is not notification. If deliveryfails preserve REPORT-tb1150.md and retryonce nextboundary.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from tb1150-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: tb1150-SPEC | task: #1150 | file: docs/specs/2026-09-10-task-binding-enforcement.md | include commit/main currentness, actual enforcement/caller evidence and gaps, minimal contract/failing-first plan, perfile ownership and production gates, genuine decisions; no code/test/activation/release performed"

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
SAWP envelope and role separation above verbatim. Architect onlydesigns; builder/tester run compiled/installed/runtime checks. All load-bearing requirements defined inline, external docs context-only.

## Snyk
N/A docs-only. No authored executable first-party code; no claim that a spec clears production security.

## Full capability and boundary
Use all relevant skills, tools, MCP servers and workflows fully within scope. Read/rg/Bash/git/structured JSON/Edit/apply_patch authorized; no plugin is mandatory. No plan mode, spawning additionalagents, executing repositoryentrypoints/tests, livequeuewrites, credentials, daemonconfig changes, publication or destructiveactions.
