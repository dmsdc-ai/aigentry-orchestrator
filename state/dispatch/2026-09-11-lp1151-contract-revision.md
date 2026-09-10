---
dispatch_kind: re-dispatch
---
# Dispatch - lp1151-architect - Correct production blockers

Carry-over from your consumed def177b0ae2c9482c9fb135c26d9b47fb5f7d953ec662921108ea24db4fc64ce and contract9bb70fc.
Task #1151. Same role, same worktree, same SINGLE owned contract file.
All original SAWP, reporting, source-only, no-code/build/test/activation restrictions remain.
state/ paths are orchestrator-side metadata, not required inputs.

## Goal
[SPEC FIRST] Revise the existing contract only. Do not implement.
The requested product must work for the current Codex orchestrator and genuinely continuous
task execution, not a Claude-only permission wrapper presented as the delivered loop.
Identify a supported real ingress integration or an exact upstream prerequisite with a
concrete owner/file change. Unsupported current-host start is a blocker, not acceptance.
Integrate the minimal required1136 claim/wake slice into the dependency plan, not all its backlog.

## Required corrections
- Unknown source must never mint human authorization. Separate unknown from authenticated
  human input; unknown may suspend new effects, never authorize start/continue/resume.
- Hash equality can be ordinary repeated text, not only a collision. Audit fallback is
  correlation, not authenticated human identity. Delayed/missing/queued logs are uncertain.
- Task-only IN_FLIGHT is insufficient: bind run, task, sid, attempt and operation. A fresh
  spawn for an admitted task while paused/stopped must be refused. --no-task retry paths
  need measured effect semantics; do not claim every machine redispatch is preservation.
- Arrival-second-derived ids do not deduplicate later redelivery. Define stable event ids,
  out-of-order semantics and restart behavior without inventing unavailable upstream fields.
- Deleting run.json bypasses admission; rollback must preserve stop/revocation evidence.
  Do not recommend deleting state as safe rollback or create two independent authority stores.
- Hook failure with best-effort pause is not fail-closed if admission can still read running.
- Main now d2bd3b3, not f729080; report measured base versus current main distinctly.
- One file per owner including test files/symlink; stable test names instead of placeholders.

## Workflow and evidence
Re-read actual relevant callers, not only another report. Provided observations are a starting
set from your contract plus main dispatch admission source, not a whole-system measurement.
Keep revision focused; if unsupported ingress requires cross-repo changes, present the exact
dependency and minimal decision rather than speculative implementation or broad research.
No live daemon probe, restart, external publication or new session.
Commit the revised contract, then send actual REPORT and HOLD commands. Do not wait silently.

## Reporting
telepty inject --ref --submit --submit-force --from lp1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: lp1151-CONTRACT-R2 | task: #1151 | file: docs/specs/2026-09-11-task-loop-production.md | include actual commit, base/main currentness, resolved/unresolved blockers, first implementable slice; no implementation/tests/activation"
telepty inject --ref --submit --submit-force --from lp1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: lp1151 | task: #1151 | phase: revised contract | needs: review before implementation"

## SAWP and capability
Architect: documentation/source design only; no code, build, tests or runtime actuation.
Commit at phase boundary; preserve all existing valid requirements and fixes.
After three failed attempts send STUCK with errors. Evidence only, never probably fixed.
Use all available tools/skills within the original authorized scope.
Snyk N/A for this docs-only phase; implementation must retain zero-finding or unresolved-HOLD gate.
