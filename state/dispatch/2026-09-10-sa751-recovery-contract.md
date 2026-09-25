---
dispatch_kind: fresh-session
task: 751
---
# Dispatch - sa751-architect - Minimal telepty daemon recovery contract

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Any state/docs/bin paths not designated output are orchestrator-side metadata, not files you must fetch. No prior conversation assumed. Role-sandbox is not target worktree.

## Role and Goal
You are sa751-architect. Universal D external_dispatch, auto router, architect role. User asks analyze AND fix recurrent telepty failures; this is SPEC FIRST, not permission to implement.
Worktree /Users/duckyoungkim/.aigentry/worktrees/sa751 branch docs/751-recovery-contract base b8124fb. Only tracked output docs/specs/2026-09-10-telepty-recovery-contract.md, <=200 lines.
Read source in /Users/duckyoungkim/projects/aigentry-telepty at997ea7c7d98b1dbc420e2e6de95d455a150e1b2c, recheck currentness; NEVER edit that tree. Installed telepty0.8.3 symlinks there, so merging code there can deploy immediately.
Design the smallest source-grounded recovery/error contract and exact isolated failing-first plus remedy-confirmation test plan. No tests, code, live probes/restarts, installs, publication, or additional agents.
Parallel analyst owns a different diagnosis document and correction; do not edit it or depend on unreviewed causal conclusions. Max2workers in this wave, no delegation.

## Evidence and Limits
Orchestrator observed2026-09-10 11:31-11:44UTC: telepty list automatically invoked launchctl kickstart -k, three retry failures, then exit0 "No active sessions found" while native cmux workers lived; later127.0.0.1:3848 returned. Another INFO inject failed restart/session-not-found during another listener gap.
These are observed outcomes, not an isolated reproduction. Initial daemon exit/hang cause remains UNKNOWN. A timed SIGKILL11:47 does not prove11:32 cause. Interleaved restart-log attempts lack callerPID, not exact2CLIs proof. Daemon stdout lacks timestamps.
LaunchAgent is KeepAlive true, minimum runtime10s, configured loopback-only TELEPTY_NO_TAILNET_AUTO=1. No measured sleep/tailnet/Node cause.
Source reviewer inspected cli.js624 restartDaemonGraceful,966 discoverSessions,1201 deferToSupervisor,1248 ensureDaemonRunning and src/supervisor.js174. This list is a STARTING SET from function reads, NOT an exhaustive caller/lock inventory; remeasure actual writers/callers/helpers.
restartDaemonGraceful options expose existing injected cleanup/start/supervisor/meta-health/probe/log seams. absenceVerdict true performs ONE health request at3xdeadline BEFORE retryloop, refuses kill on200. Retry cleanup then1s meta wait may accept supervisor-restored daemon, otherwise restartSupervisor uses kickstart -k then5s meta wait. Up to3 attempts.
5s budget<10s minimum is a fact, NOT always-miss proof; awaitednetworkcalls and phase timing matter. No cross-process coordination identified in inspected path, but remeasure existing lock utilities before proposing one.
ensureDaemonRunning may end undefined after unsuccessful restart. discoverSessions suppresses connection/timeout exceptions, unlike typed answered-daemon HTTP errors; empty result prints success. Distinguish healthy-empty/local-unavailable/remote-only/partial discovery.
deferToSupervisor waits10s then5min marker skips future waiting. Existing port-scoping, health-200 refusal, no detached spawn under supervisor, credential/version/capability errors must remain.
daemon.js synchronously restores tracked injections before listen. Moving listen earlier does not let health respond while JS blocked and may expose uninitialized state; early-listen reorder is NOT approved. Nor is a new flock/dependency prescribed.

## Contract Requirements
1. Explicit invariants and minimal behavior change for genuine absence versus slow/already-starting/healthy/mismatched daemon, local versus remote, successful-empty versus unavailable. Preserve deliberate restart command/upgrades where authorized; avoid blanket never-restart.
2. Identify existing coordination and supervisor APIs. Recommend one minimal cross-process recovery ownership/wait/join strategy only if gap exists, with crash/stale-owner/scope/port/OS semantics. Compare reuse versus added complexity. Do not blindly require new framework or shell flock.
3. Specify revalidation immediately before any destructive recovery, bounded deadline accounting, outcomes and failure propagation. Consider independent CLI invocations plus launchd KeepAlive; no killing healthy new owner from stale observation.
4. Exact isolated test plan executing real current functions/seams, not a fake algorithm that assumes conclusion: prove C unavailable=>false-empty failure and B overlapping-recovery hazard separately. Simulated supervisor timing is a model limitation, not production initial-cause proof.
5. Small candidate counterpart in tester-owned ignored copy allowed only AFTER design review; prove precise remedy against same red cases before coder dispatch. Controls: health200 no kill, supervisor no orphan, target-port isolation, genuine absence, version/capability intent, remote-only/partial modes, lock owner crash if applicable.
6. Bound production scope by file owners/dependencies. Code, tests, builder/package checks separate sessions; same file sequential, independent files parallel. State exact runner inclusion rather than broad all-tests claims.
7. Snyk scan/rescan for later first-party code, source-currentness checks, clean-prefix package verification by builder, explicit activation/rollback without killing protected orchestrator. Installed source symlink means no blind merge/live restart. Do not claim npm publication or restart permission from user fix request.

## Workflow
Single bounded docs-only phase: read relevant committed source/tests WITHOUT running -> write concise contract and exact test expectations -> commit (WIP allowed) at every phase boundary -> real REPORT and HOLD below.
Implementation is prohibited until spec approval AND failing-first reproduction/exact remedy confirmation. Unknown source facts are investigable, not user intent questions. Ask only material architecture/product/destructive decisions; do not invent approval.
If three attempts fail, report STUCK with exact errors. No looping or broad audit. Reuse mature existing helpers and preserve prior fixes, no speculative refactors.

## HOLD inject protocol
ACTUALLY execute after commit at boundary/blocker:
telepty inject --ref --submit --submit-force --from sa751-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: sa751 | task: #751 | phase: recovery contract | needs: spec review before isolated reproduction and any code; initial incident cause remains unproven"
Every HOLD/REPORT must exist durably as --ref. If delivery fails, preserve REPORT-sa751.md in worktree for native pull and finish; do not trigger restart loops. Silent markdown is not delivery.

## REPORT
MANDATORY ACTUALLY execute after commit:
telepty inject --ref --submit --submit-force --submit-retry 2 --from sa751-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: sa751-SPEC | task: #751 | file: docs/specs/2026-09-10-telepty-recovery-contract.md | include commit/main/source currentness, exact behavior and file boundaries, isolated red/candidate plan, remaining decisions; no code/tests/restarts"

## [SAWP] Envelope and Inline Excerpts
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

## Snyk and Boundaries
N/A docs-only, no first-party code. Role table governs: architect writes design, no compile/test/app execution. Full authorized capability: use all relevant skills, tools, MCP and workflows within Read/rg/structured parsing/Edit/apply_patch/git for this output. No extra workers/subagents or plan mode.
Do not modify source, auth, live state, queue, supervisor files, config or runtime packages. Do not run telepty list/inject as health probes (they may auto-restart); notification only at boundary. Never kill/restart/delete protected orchestrator or bridge/ancestors (77974/77940/13759/13758/13732/1); no other process signals or fault injection in production. No push/publication.

