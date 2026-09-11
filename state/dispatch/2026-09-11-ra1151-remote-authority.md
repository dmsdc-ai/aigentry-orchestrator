---
dispatch_kind: fresh-session
---
# Dispatch - ra1151-architect - Mobile and remote chat loop authority

THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC.
state/ paths are orchestrator-side metadata, not required worker inputs.
Relative docs/bin/src paths for source inspection refer to the explicit worktree below.

## Role
You are ra1151-architect, architect for task #1151.
Worktree: /Users/duckyoungkim/.aigentry/worktrees/ra1151
Branch: docs/1151-remote-authority. Base 0e04c6b.
Only authored output: docs/specs/2026-09-11-task-loop-remote-authority.md.
Read sibling repositories if required; no cross-repo writes.

## Background
Human explicitly confirmed: "휴대폰 원격에서도 지원해야돼."
Mobile/remote chat must support start, continue/resume, stop and status.
Do not substitute terminal-only control or remote stop-only behavior.
Loop remains NOT implemented/active. Existing 60-second reconciler monitor is not a task execution loop.
User wants visible current task/phase, continuous approved task execution, immediate chat stop/continue.
Ask stop/continue only on return after inactivity, not every prompt in an ongoing conversation.
Ten minutes is a configurable proposed default, NOT a user-selected value.
Worker REPORT/telemetry is not human activity or approval.
Queue task #1136 candidate is unmerged: core55/56 passed, concurrency regression unresolved.
It has no production grant/claim verbs. Do not treat those interfaces as available.

## Rejected approaches and invariants
Prior ingress contract 14358d3 is context-only, not approved or a dependency to fetch.
Local CR, ancestry, timing and absence of automation markers do not prove human authority.
An agent-visible session bearer/provenance nonce cannot authenticate a person.
Mixed injected composer text plus human edit must never manufacture approval.
Journal offsets dedupe re-reads, not redelivery; use a real upstream delivery identity.
Grant consumption must prevent reuse across tasks, sessions and loop generations.
IN_FLIGHT must bind worker sid + attempt + operation, not task id alone.
Unknown input cannot start/resume/answer an authority gate.
Adding write-ahead fsync/mailbox holding changes delivery availability; it is not an inert rollout.
One observed Codex tool-entry sample established visibility only, not human origin or universal hooks.
Treat all supplied inventories as starting observations, remeasure source before claiming caller coverage.

## Goal
Produce an implementation-ready but UNAPPROVED contract that works on actual local Codex and mobile/remote chat.
Identify existing supported surfaces from source with exact SHAs and paths; separate facts, proposals and unavailable interfaces.
Specify positive human authentication, enrollment/pairing, revocation/lost-phone recovery, and credential custody outside worker access.
Bind identity to exact submitted content, intended operation, task/loop scope, target generation, expiry and unique delivery/command IDs.
Explain where trusted authorization is enforced outside LLM assertions, and how ordinary chat intent maps to it without per-prompt fatigue.
Specify duplicates, fanout, retries, reordered/offline delivery, reconnects, replay, cross-task reuse and crash atomicity.
Define status visibility and return-check latch across devices; classify human vs automation independently from message text.
Propose least-complex integration using existing infrastructure; no new framework or provider commitment without justification.

## Constraints
[SPEC FIRST] Do not implement. A spec revision is authorized; production code and runtime changes are not.
State explicit threat boundaries, including same-user filesystem/terminal access; never assert isolation provided only by env vars or chmod.
Remote stop requires deliberate policy for unauthenticated requests; do not silently allow arbitrary network denial of service.
Preserve chat UX. If current ingress cannot provide exact authorization, name the missing trusted component and required change.
No provider-restriction investigation/retry or #1136 test execution; this is an independent design task.

## Workflow
Single authorized phase: inspect source, draft the sole spec, review it against rejected approaches, commit, REPORT and HOLD.
Commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase.
Include an acceptance matrix covering local Codex, paired phone, unpaired caller, automation, mixed content, repeat text with distinct IDs,
replayed IDs, revoked device, reconnect, stale generation, concurrent stop/dispatch, crash after consume and cross-device idle return.
Include per-file ownership/dependencies and parallel-safe implementation waves AFTER contract approval.
Include npm packaging/install/update/rollback, backward compatibility, observability and exact activation gates; do not claim measured tests.
Unresolved business choices: recommend an option with tradeoffs, HOLD instead of silently changing scope.
End this phase with both real REPORT and HOLD inject calls below. No implementation afterward.

## HOLD inject protocol
Execute, do not merely print. Durable-file-first; on delivery failure preserve the report in your worktree.
telepty inject --ref --submit --submit-force --from ra1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: ra1151 | task: #1151 | phase: remote authority spec | needs: contract review and explicit implementation approval"
Silent waiting is forbidden.

## REPORT format
telepty inject --ref --submit --submit-force --submit-retry 2 --from ra1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: ra1151-SPEC | task: #1151 | file: docs/specs/2026-09-11-task-loop-remote-authority.md | include commit/base/main currentness, inspected source SHAs, trusted boundary, exact-command binding, remote chat UX, missing capabilities and next bounded wave; no implementation or activation"

## [SAWP] envelope
Architect role: design/spec only. No code, compile, test or app execution.
If stuck after 3 attempts, report STUCK with full error. Report immediately when done; HOLD when blocked.
Evidence only, no 'should work' or 'probably fixed'. Preserve all existing fixes.

## Inline excerpts
Role boundary verbatim: "architect는 코드를 수정하지 않는다 — 설계 분석+제안만 (구조/의존성/트레이드오프 기반)"
Role separation: coder writes code, builder builds/runs, tester tests, logger captures, analyst diagnoses runtime, architect designs.
No additional external rule citation is required to perform this phase.

## Snyk
N/A: documentation only, no first-party executable code.

## Boundary
Do not edit source, task queue, global config, installed runtime, credentials or prior rejected drafts.
Do not spawn sessions, run tests/builds, restart daemons, publish, merge or activate the loop.
Use apply_patch for authored documentation. Do not invoke plan mode; HOLD ambiguities to orchestrator.

## Full capability
Use all available skills, tools and MCP capabilities fully within this design scope.
Read/search source and git metadata; use apply_patch for the sole document and git commit for preservation.
External technical claims require official primary-source verification; no web lookup needed for locally verifiable repository facts.
