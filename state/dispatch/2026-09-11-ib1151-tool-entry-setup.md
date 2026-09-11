---
dispatch_kind: fresh-session
---
# Dispatch - ib1151-builder - Prepare bounded Codex tool-entry measurement

THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC.
Task #1151. Role builder. You are the disposable Codex subject, not the orchestrator.
Scope /Users/duckyoungkim/.aigentry/worktrees/ib1151.
state/ paths refer to orchestrator metadata, not required inputs.
No other agent/session spawn. The orchestrator launched this visible session through dispatch.sh.

## Goal and current phase
Prepare one controlled second-turn experiment, then send READY and HOLD.
Do not run the measured second turn until a separate dispatch arrives.
No production changes, builds, tests, global config or daemon restart.
Use the installed Codex process you are running in; do not launch nested Codex.

Prior validation found that Codex rollout records lack the telepty inject_id. Synthetic13/13
confirmed ambiguity, not runtime authentication. Timing at inject-return does not prove timing
at first tool entry. Readability is visibility, not crash durability.
This experiment only measures this disposable session and the normal ref-dispatch door.
It does NOT implement a loop or authenticate real human messages.

## Preparation
Using read-only commands, identify YOUR exact Codex thread through CODEX_THREAD_ID plus
matching rollout session metadata; never use newest-file guess alone. Do not print env secrets.
Report your thread identifier, exact rollout path and relevant installed version.
Do not inspect or copy other sessions' message contents.
If thread binding unavailable, report HOLD with the missing field; do not guess.

Prepare an EXACT single shell command you will run as the FIRST tool call on the next
controlled measurement message, BEFORE reading that message's referenced file or doing any
other tool call. The command must record monotonic and wall-clock entry times, read ONLY your
already-bound rollout bytes once, then save that snapshot under
dist/evidence/ib1151/tool-entry-rollout.jsonl with restrictive permissions.
Also save snapshot hash, byte count, read-start/read-end timestamps, known thread, and command
in a metadata file. No nonce/environment dump, no durable-fsync claim.
The local snapshot contains ONLY this disposable session's synthetic/task instructions;
never commit raw rollout. A later tester will compare exact synthetic marker and event order.
The measured first call can be exec_command or functions.exec wrapping one exec_command;
state exactly which tool layer was sampled, no earlier tool calls on the measured turn.
Do not claim a snapshot at shell entry measures a pre-tool hook: it measures inside first tool.

You may execute standard-library inline commands, not write production/helper code.
Retain your exact proposed command in a short READY report; documentation output only:
docs/reports/2026-09-11-tool-entry-probe-setup.md.
Use apply_patch for that one report. Commit at phase boundary.
No tests or outcome interpretation; tester owns assertions.

## SPEC FIRST and boundary
This is the approved bounded experiment setup, not approval for runtime implementation.
Phase1 setup ends with READY/HOLD. Phase2 sample only after next helper dispatch.
No real user prompt, credentials, auth config edits, external API beyond this worker inference,
new installations, publication, model switches, worker cleanup or protected-orchestrator actuation.
Stop after three failed attempts and report exact errors.
The orchestrator will dispatch the synthetic second-turn marker after reviewing your READY.
No raw self-inject. No telepty probes except mandatory reports below.

## SAWP
Builder builds/runs only, not tests or design rewrites. Here no compilation is needed.
Preserve existing files; no code fixes. Report immediately when done; HOLD immediately if blocked.
Evidence only; no should-work/probably-fixed statements. Commit before phase boundaries.
Other roles: coder implements, tester tests, logger captures runtime, analyst diagnoses,
architect designs. This builder records its own controlled execution artifacts only.

## REPORT and HOLD - execute, not markdown-only
telepty inject --ref --submit --submit-force --from ib1151-builder {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: ib1151-READY | task: #1151 | file: docs/reports/2026-09-11-tool-entry-probe-setup.md | include exact own-thread binding, proposed first-tool command, source/base/main, no measured second turn yet"
telepty inject --ref --submit --submit-force --from ib1151-builder {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: ib1151 | task: #1151 | phase: ready | needs: controlled second-turn dispatch"

## Capability and security
Use available tools and skills within this scope. No custom executable code file is requested;
documentation only, Snyk N/A. Existing local provider facts must be verified in installed
files first; do not infer hook support from a binary string.

