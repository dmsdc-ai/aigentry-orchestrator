---
dispatch_kind: fresh-session
---
# Dispatch - qcpath1136-coder - Isolated path remedy candidate

THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Task1136, rolecoder.
Worktree /Users/duckyoungkim/.aigentry/worktrees/qcpath1136.
ONE owned file bin/tq-write.py. Basefd014a1209c6da074c3640eea8606902a4c763af.
state/ paths in this ref are orchestrator metadata, not inputs to locate.

## Phase authorization / SPEC FIRST
This is a bounded EXPERIMENTAL remedy candidate for the already reproduced path defects.
User approved next exact-remedy step; implement this contract in the isolated branch only.
Do not call it a permanent production fix, merge, install, activate, or run tests.
If you cannot implement the contract without changing its semantics, HOLD with concrete gap
before deviating. No extra architecture document or unrelated refactor.

## Reproduction and acceptance boundary
Reviewed baseline corrected tests at qh1136@8a9f1786e68f60b39bef004151d8dfad86322f05:
18total9pass9fail, one FIFOtimeout, actual externalwrites/local lockcreation/symlinkredirect.
Test-only candidatepath+SHA selector now available. Tester later executes exact candidate,
not this coder. Dynamic directory-swap race is NOT reproduced yet and remains a separate
deterministic tester gate; do not claim race remediation from static tests.
Prior56core tests passed baseline; preserve their queue semantics, not unsafe path override.
Re-read actual source: these counts/pins are starting evidence, not your own test results.

## Exact candidate contract
- Root is physical helper location: dirname(dirname(realpath(__file__))). Queue is literal
  state/task-queue.json there. No cwd/marker/env-selected root.
- Nonempty TQ refuses exit7 QUEUE_UNAVAILABLE before filesystem effects, including equalQ.
  Empty TQ treated unset. No new production override, flags or test backdoor.
- Missing/non-directory/symlink state and missing/non-regular/symlink queue refuse before
  creating lock/temp. FIFO must never block. Lock sidecar symlink refuses without following.
- Anchor filesystem operations to an opened physical-root and state directory descriptor,
  opening state with O_DIRECTORY|O_NOFOLLOW. Do not use lstat-then-absolute-open as a claim
  of containment. Lock/read/temp/replace/unlink/fsync operate relative to pinned state fd.
  Recheck regular queue identity under lock; fail closed on unsupported required primitives.
  Explain limits: pinned directory may be renamed by same-user actor; this is not a sandbox.
- Preserve stable sibling flock across replacement, bounded wait, cleanup only own temp,
  compare-and-set/idempotency/numeric identities/JSON validation. No breaking someone else's
  lock. Do not unlink pre-existing lock on refusal. Close descriptors on every failure path.
- Keep permission bits, atomic replacement, temp fsync and directory fsync. Exit7 before
  replace vs exit8 COMMIT_DURABILITY_UNKNOWN afterreplace semantics must remain truthful.
- Existing imported function signatures/fault-injection seams should be preserved where
  feasible without reopening path bypass; report unavoidable test-contract changes exactly.
  Do not add global state just to fake old monkeypatches working.

## Verification and boundaries
Code + syntax/compile check only, no test execution or app. Python syntax check must not
write pycache into another checkout. Use apply_patch for manual edits.
Snyk scan exact authored helper, fix/rescan to zero or HOLD unresolved findings. Two baseline
LOW findings are not waived; removal expected is not evidence.
Commit candidate at phase boundary with exact fullSHA and SHA256 in report. No success
claim until independent tester executes corrected18 and retained core56 with explicit pins.
No other repo/file changes, session spawn, daemon probe/restart, live queue mutation, release.

## SAWP
[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error
- Never idle — report immediately when done
- Evidence only — no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)
Role separation: coder code/compile only, tester tests, builder app/build, architect design,
logger captures runtime and analyst diagnoses. Use all available tools/skills within scope.

## Actual REPORT and HOLD
telepty inject --ref --submit --submit-force --from qcpath1136-coder {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qcpath1136-CANDIDATE | task: #1136 | file: bin/tq-write.py | include fullcommit/base/main, fileSHA256, syntaxcheckcommand/exit, exactSnykresults, preservedinvariants, changedtestseams, unmeasuredrace; no tests/merge/activation"
telepty inject --ref --submit --submit-force --from qcpath1136-coder {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qcpath1136 | task: #1136 | phase: isolated candidate | needs: independent reproduction retest before permanent integration"
