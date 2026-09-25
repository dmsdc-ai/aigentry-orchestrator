---
dispatch_kind: fresh-session
---
# Dispatch - qr1136-tester - Reproduce queue path boundary defects
Task1136, roletester, /Users/duckyoungkim/.aigentry/worktrees/qr1136.
ONE owned tracked output tests/dispatch/task-queue-path-boundary.test.cjs.
Helper bin/tq-write.py pinned fd014a1209c6da074c3640eea8606902a4c763af, read-only.
Its expected SHA25612bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca.
Recompute source/hash before using; this is a starting pin, not proof of current main.
Main helper absent in last measurement; existing56tests passed, but not these boundary cases.

## SPEC FIRST / test contract
User-approved intended production policy: helper writes only its own workspace state/task-queue.json,
no environment-selected external queue; side effects outside workspace must not occur.
Do not implement that policy or alter helper. This phase is failing-first reproduction ONLY.
Use Node built-in node:test/assert/fs/child_process, direct node --test, no compilation/install.
File .test.cjs is DIRECT-RUN evidence pending later runner integration; explicitly report that
it is NOT yet part of npm test/CI. No main merge or production readiness claim.

Create isolated temp root and foreign root, fixture-copy exact helper bytes into root/bin,
seed root/state/task-queue.json from minimally valid actual schema. Preserve helper SHA.
Test positive normal default note-append/status behavior plus:
external absolute TQ, relative TQ, TQ equal queue, state directory symlink to foreign,
queue symlink, lock sidecar symlink, missing target and FIFO.
Assertions must be desired policy, so current failures are expected but measured, not assumed.
Record actual foreign bytes/inode/mtime and sidecar creation; negative test must prove real
effect or absence rather than merely checking error text. All fixture paths temporary.
Do not label code as fixed. No candidate remedy, no modifying fixture helper to hide failure.
Directory swap race is separate deterministic-test prerequisite; do not claim static
symlink tests demonstrate race mitigation. Mark unmeasured if no exact controlled race.

Run subprocess with bounded timeout (<=10s), identify timeout/signal distinctly. Use only
owned child handles for cleanup; never kill by command substring. No live queue/daemon/inject
except final reports. Raw TAP/stdout/metadata may be retained under ignored dist/evidence/qr1136;
include exact source and test hashes, commands/runtime versions in the REPORT.
Snyk scan authored testfile; if unavailable/findings remain HOLD with evidence, no waiver.
Commit testfile even when intentional desired-policy failures remain, title it reproduction.

## Shared constraints / SAWP
This file is the complete self-contained assignment. state/ paths are orchestrator metadata.
Use all available tools/skills within your role. No extra sessions, daemon restarts, production
activation, publication, protected-orchestrator changes, or unrelated edits.
Use apply_patch for manual edits. Commit at every phase boundary. Report immediately;
after three failed attempts send STUCK with full error. Evidence only, never probably fixed.
Architect designs only; tester runs tests only; builder builds/runs apps; coder implements.
Do not claim proposed behavior as measured, or a standalone test as CI inclusion.

## Actual reporting calls
telepty inject --ref --submit --submit-force --from qr1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: qr1136-REPRO | task: #1136 | file: tests/dispatch/task-queue-path-boundary.test.cjs | include commit/source/test hashes, actual red/green/timeout counts, raw artifact paths, no fix/build/CI inclusion"
telepty inject --ref --submit --submit-force --from qr1136-tester {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: qr1136 | task: #1136 | phase: reproduction | needs: review before exact remedy experiment"
Send TEST_REPORT with actual totals/passed/failed/skipped/duration; do not turn expected
policy failures into a green suite by asserting insecure behavior.

