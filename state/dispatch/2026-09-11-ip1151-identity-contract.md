---
dispatch_kind: fresh-session
---
# Dispatch - ip1151-architect - Minimal ingress identity contract
Task1151, rolearchitect, /Users/duckyoungkim/.aigentry/worktrees/ip1151.
ONE output docs/specs/2026-09-11-ingress-identity-contract.md (aim <=120 lines).
[SPEC FIRST] No implementation. This is the remaining concrete dependency, not a new whole-loop design.

## Facts and goal
User requires start/continue/stop in chat; no terminal-only replacement. User-return prompt
after configurable inactivity asks once, continuous conversation does not re-ask.
Completed evidence in this worktree:
docs/reports/2026-09-11-task-loop-ingress-validation.md
docs/reports/2026-09-11-tool-entry-sample-verification.md.
These are starting measurements, not authority. Source remeasurement required where load-bearing.
Single Codex sample proves outer input readable INSIDE first tool only; 32checks do not prove
human origin, transport dedup or durable pre-tool recording. Do not repeat that experiment.

Specify minimal actual source changes to bind origin + exact submitted content + stable
delivery id + target session generation/thread at ingress, and expose that binding to loop
admission without plaintext secrets. Inspect sibling telepty source READ-ONLY as needed.
Separate locally typed, remote human, automation and unknown; unknown never grants authority.
Threat model must be realistic: same-user malicious code control is not magically solved;
avoid expanding this into a new authentication platform. Explain precise trust boundary.
A newline or process name is not human proof; body hash equality is not unique identity.
Nonce visible to agents is not a credential for minting arbitrary human approvals.
If a provider-owned boundary is indispensable, identify exact API/hook/source dependency,
support evidence and unsupported channel; never silently replace requested chat UX.

## Deliverable
Concrete producer/consumer fields, event IDs vs attempt IDs, replay/duplicate fanout semantics,
message-source classification and binding to current turn, failure behavior, source ownership
ONEfile per owner, and falsifiable fixture + controlled integration acceptance.
Do not invent a provider capability or infer it from binary strings. Use installed source first.
Do not reproduce rejected task-loop r2 document or design unrelated admission/queue engines.
Existing1136 owns ledger/claim;1150 binding. Include just required interface to those.
End with one recommended implementation slice and any real user decision (not source questions).
Snyk N/A docs only.

## Shared constraints / SAWP
This file is the complete self-contained assignment. state/ paths are orchestrator metadata.
Use all available tools/skills within your role. No extra sessions, daemon restarts, production
activation, publication, protected-orchestrator changes, or unrelated edits.
Use apply_patch for manual edits. Commit at every phase boundary. Report immediately;
after three failed attempts send STUCK with full error. Evidence only, never probably fixed.
Architect designs only; tester runs tests only; builder builds/runs apps; coder implements.
Do not claim proposed behavior as measured, or a standalone test as CI inclusion.

## Actual reporting calls
telepty inject --ref --submit --submit-force --from ip1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: ip1151-CONTRACT | task: #1151 | file: docs/specs/2026-09-11-ingress-identity-contract.md | include commit/base/main, producer/consumer, evidence-backed prerequisites and exact first slice; no implementation"
telepty inject --ref --submit --submit-force --from ip1151-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: ip1151 | task: #1151 | phase: identity contract | needs: review before implementation"

