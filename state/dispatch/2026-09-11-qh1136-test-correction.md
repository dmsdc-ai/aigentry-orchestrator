---
dispatch_kind: fresh-session
---
# Dispatch - qh1136-tester - Complete boundary regression harness

THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Task1136, tester.
Worktree /Users/duckyoungkim/.aigentry/worktrees/qh1136.
ONE tracked file tests/dispatch/task-queue-path-boundary.test.cjs.
state/ paths are orchestrator metadata, not required inputs.

## Background and scope
Existing test commit6a1938c ran10cases:4passed6failed, FIFOtimeout1. Helper pinned
fd014a1209c6da074c3640eea8606902a4c763af remains unmodified. Main lacks helper.
This is reproduction refinement before a remedy, not a permanent code fix.
Review showed missing-target passed despite a created local lock because after.lock was
captured but never asserted. The baseline source hard-pin also blocks candidate testing.
Read actual code and verify pins; supplied measurements are starting evidence, not results.

## Approved test changes
[SPEC FIRST] This ref specifies the test-only change. No helper changes authorized.
1. Unsafe/unavailable static target cases must preserve the local state directory entries
   and lock identity/bytes as well as queue and foreign tree. Refusal must not create a lock.
   Legitimate success controls may retain their lock; do not break the positive assertion.
2. Production policy excludes environment-selected external queues. Existing equal-TQ
   ignore-or-refuse behavior stays as scoped test contract; do not silently tighten it.
3. Permit an explicitly selected candidate helper ONLY in this test harness, coupled with
   a required full SHA256. Default remains the immutable baseline. Reject missing/mismatched
   candidate digest before execution. Every fixture copy must match the selected digest.
   Report baseline/candidate separately. Do NOT introduce an override in shipped helper.
4. Add focused static cases for missing state directory, queue directory, and helper file
   symlink invocation if consistent with intended own-physical-workspace resolution. Keep
   dynamic directory-swap race explicitly unmeasured; never call static tests race coverage.
5. Preserve existing foreign snapshots, bounded child timeout/owned cleanup, op behavior.

Run baseline through corrected harness, record actual red/green counts (don't predict them).
Check harness rejects bad candidate selection without executing it. No actual remedy provided
yet: do not invent one or copy-edit the production helper in a fixture.
Node built-in test only; no app/build/install. This cjs stays direct-run-only, NOT npm/CI
included; explicitly identify future runner integration as required before main acceptance.

## SAWP and reporting
Tester edits/tests this single test file only. No production implementation or extra sessions.
Use apply_patch for all manual edits. Preserve existing evidence; keep new raw TAP/metadata
under ignored dist/evidence/qh1136. Never commit real prompts or secrets.
Snyk scan authored file; fix findings or HOLD with unresolved evidence, zero-new is not zero.
Commit at phase boundary; report immediately; after3failedattempts send STUCK/errors.
Evidence only, no probably-fixed claims. Builder handles build/app execution, coder helperfix.
Use available skills/tools within scope; no daemon changes/live queue mutations.

telepty inject --ref --submit --submit-force --from qh1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qh1136-HARNESS | task: #1136 | file: tests/dispatch/task-queue-path-boundary.test.cjs | include commit/base/main, selected helper SHA/test SHA, actual baseline totals and selector rejection evidence, raw paths, Snyk; no remedy or CI inclusion"
telepty inject --ref --submit --submit-force --from qh1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qh1136 | task: #1136 | phase: corrected reproduction | needs: review before exact remedy experiment"
Send TEST_REPORT actual totals/passed/failed/skipped/duration. Expected policy failures remain
failures; do not assert insecure outcomes merely to make suite green.
