---
dispatch_kind: fresh-session
---
# Dispatch - qp1136-tester - Deterministic cooperative writer regression
THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Task1136, tester.
Worktree /Users/duckyoungkim/.aigentry/worktrees/qp1136.
ONE tracked output tests/dispatch/task-queue-prelock-race.test.cjs.
state/ paths mean orchestrator metadata, not required inputs.

## Observed failure and hypothesis (not a cause claim)
Candidatee2ea7a7541dd28deba8448f01ee0fa6a54293631 SHA
fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a.
Exact compiled core56 ran55pass1fail: same-row12parallelappends, oneexit7
QUEUE_UNAVAILABLE: queue is not a stable regular file;11success. No lostdata proven.
Hypothesis: Queue.__enter__ calls open_queue BEFORE Lock; another cooperating writer
may replace regular queue between descriptor fstat and named stat, causing false refusal.
Read actual source and test it; reject the hypothesis if evidence disagrees.

## SPEC FIRST: test-only controlled interleaving
Reproduce with exact-byte candidate copy in disposable root/bin plus root/state queue.
Instrument only a test-wrapper monkeypatch around the appropriate syscall boundary:
pause first writer between opened-file observation and named identity check BEFORE lock,
run a second real helper subprocess to completion using the same fixture/sibling flock,
then resume first writer. No sleeps used to guess race, no direct queue editing to simulate
the cooperating commit, no production helper edits or capability-check bypass.
Prove which phase/syscall was intercepted with event log and bounded child handles.
Expected correct behavior: both writes succeed and both segments/operation IDs persist.
Record current failure as failure, not a green assertion of insecure behavior.
Add non-overlap control and verify fixture/helper pins before/after. No repeated randomruns.
If instrumentation cannot isolate without changing mechanism, HOLD exactreason.
Use node built-ins with temporary Python wrapper if needed. File remains standalone
direct-run-only pending CI integration. Do not run npmtest/build/install or live queue.
RawTAP/events under ignored dist/evidence/qp1136. No remedy in this phase.

## SAWP and bounds
Tester writes/tests singlefile only; coderfix later, buildercompiles. Use apply_patch.
No daemonprobe/restart, appsession, extraagents, globalconfig or publication.
Timeout each ownedchild and overallrun; no broad processmatching. Preserve existingcode.
Snyk authoredtestfile; unresolved findings HOLD. Commit at phaseboundary and report
immediately; after3failedattempts sendSTUCK/errors. Evidence only, no probablyfixed.
Use available tools/skills within scope. Suppliedpins and observations require recheck.

telepty inject --ref --submit --submit-force --from qp1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qp1136-REPRO | task: #1136 | file: tests/dispatch/task-queue-prelock-race.test.cjs | include commit/base/main, source/testSHA, controlledinterleavingevents, actualfail/control, rawhashes and hypothesis verdict; no remedy"
telepty inject --ref --submit --submit-force --from qp1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qp1136 | task: #1136 | phase: deterministic reproduction | needs: review before candidate correction"
Send TEST_REPORT actualtotals, expectedsemanticfailures stayfailures.
