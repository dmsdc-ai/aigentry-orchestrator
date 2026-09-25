---
dispatch_kind: fresh-session
---
# Dispatch - qa1136-tester - Preserve core regressions with candidate fixture adapter
Task1136, tester; /Users/duckyoungkim/.aigentry/worktrees/qa1136.
ONE tracked file tests/dispatch/workflow-task-writer.test.ts.
Basec75d360bde57d1f1f5859712931c5b4cb577cb8b, prior56coretests.
Candidate read-only /Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py
commite2ea7a7541dd28deba8448f01ee0fa6a54293631
SHAfdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a.

## Preparation only, no build
Adapt fixture layout to exact-helper-copy root/bin/tq-write.py + root/state/task-queue.json,
remove production TQ override, assert copied bytes equal explicitly selected helperdigest.
Keep original56 semantic assertions and identify changes to unsafe path-selection expectations
separately if present; do not delete or silently relabel cases to keep count.
Candidate changes: Queue context required for Lock/load/commit, _unlink requiresdir_fd;
read uses os.open/fdopen, temp uses exclusive descriptor-relative os.open notmkstemp;
chmod becomes fchmod; replace receives dirfds; fsync has preflightdirectory, temp,
postreplace phases. Map fault injection to intended operation/phase, not rawnthcall guesses.
Preserve exit7-before-replace vs exit8-after-replace tests and actual mutation assertions.
Do not make fault injection pass by bypassing required capability checks.
Explicit helperpath+fullSHA allowed ONLY in test fixture selection, no shippedoverride.
Default fixture path still repohelper when eventually integrated; candidate is verifiedinput,
not a manually copied different productionowner. Do not alter thisworktree's bin/tq-write.py.

Commit adapted test then HOLD for builder compilation. Do NOT run tsc/npm build/test here:
npm test includes compilation. A later builder will compile exactcommittedtest, tester thenruns.
Record originaltestSHA/newSHA, exact helperpin, table of faultseam changes, retainedassertions
and any unresolved contract; no testpass/readyclaim beyond sourceprepared.
No new reportfile: use final REPORT plus comments only where nonobvious.

## Shared role/safety contract
THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. state/ paths are orchestrator metadata.
[SPEC FIRST] This is approved tester-only candidate verification/preparation, not production code.
Use apply_patch for manual edits. No helper edits, live queue writes, app/daemon run/restart,
provider inference beyond this worker, dependency install, build, extra session, or publication.
Builder compiles; tester tests; coder implements. Preserve all existing corrections.
Commit at phase boundary. Report immediately; after three failed attempts send STUCK/errors.
No probably-fixed claims. Use all available skills/tools within scope.
Snyk authored testcode; zero findings or unresolved HOLD, no waiver.
Raw evidence under ignored dist/evidence in your worktree; no secrets/transcripts committed.
All supplied pins/counts are starting measurements; recompute before relying on them.

## Actual reports
telepty inject --ref --submit --submit-force --from qa1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qa1136-ADAPTER | task: #1136 | file: tests/dispatch/workflow-task-writer.test.ts | include commit/base/main, test/helper pins, exact fixture/faultseam changes, original assertion coverage; not compiled or run"
telepty inject --ref --submit --submit-force --from qa1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qa1136 | task: #1136 | phase: adapter prepared | needs: builder compile then tester execution"

