---
dispatch_kind: fresh-session
---
# Dispatch - qbcore1136-builder - Compile pinned core regression adapter

THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Task1136, builder.
Worktree /Users/duckyoungkim/.aigentry/worktrees/qbcore1136.
Sourcecommit8f23ceed7ca663ae3ba3455781ddf9a776ee68d6.
ONE tracked output docs/reports/2026-09-11-core-adapter-build.md.
state/ paths are orchestrator metadata, not required inputs.

## Goal
[SPEC FIRST] Approved compile-only handoff of prepared tests, no production edits.
Verify tests/dispatch/workflow-task-writer.test.ts SHA256
1547a6f298cefa363863d722993e842e3b9b97c537eb45fcd61166bfad7e8db9.
Compile this committed tree using npm run build (not npm test, which runs tests).
Use installed Node20 if available; record exact Node/npm/tsc versions and lockfile hash.
Dependencies may be installed locally with npm ci if a lockfile exists and dependencies
are missing; no global install, no lockfile rewrite. If unavailable HOLD exact error.
No clean command on another tree, no symlink to another worker's mutable dist.
Capture compiler stdout/stderr/exit and hash generated
dist/tests/dispatch/workflow-task-writer.test.js plus source before/after.
Confirm output exists and source pins unchanged. Do not execute tests or app.

## Candidate context for handoff, NOT a build input to replace
Tester later sets QUEUE_WRITER_HELPER=/Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py
and QUEUE_WRITER_HELPER_SHA256=fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a.
That helper is candidatee2ea7a7541dd28deba8448f01ee0fa6a54293631. This build tree's
bin/tq-write.py is an older retained helper; do not edit it, run it or call it verified.
Compilation proves no56casepass; boundary18passed separately, not build scope.

## SAWP / constraints
Builder compiles only; tester runs assertions, coder fixes source. Compile failure -> HOLD
exact diagnostic, never change test/production code yourself or claim ready.
Use apply_patch for one report; raw logs under ignored dist/evidence/qbcore1136.
Commit report at phase boundary, then report immediately. Three failed attempts -> STUCK.
No tests, daemon restart/probe, live queue mutation, new session, publish or activation.
Preserve all existing files/fixes; no probably-fixed statements. Use all available tools
within scope. Snyk N/A docs-only, authored test scan belongs preceding tester.
Pins are starting measurements; independently recompute. Report base/currentmain separately.

## Actual REPORT / HOLD
telepty inject --ref --submit --submit-force --from qbcore1136-builder {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qbcore1136-BUILD | task: #1136 | file: docs/reports/2026-09-11-core-adapter-build.md | include commit/base/main, compile command/exit, source and generated JS SHA256, runtime/dependency pins, no tests"
telepty inject --ref --submit --submit-force --from qbcore1136-builder {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qbcore1136 | task: #1136 | phase: compile | needs: independent tester execute exact generated artifact"
