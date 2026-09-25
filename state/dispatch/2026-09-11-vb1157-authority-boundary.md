---
dispatch_kind: fresh-session
---
# Dispatch - vb1157-architect - Close two concrete authority-contract gaps
THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC.
state/ and bin/ paths are orchestrator metadata, not required worker inputs. The absolute input/output document below is the real worktree file you may read/edit. Other prior reports are context-only.

## Role
You are vb1157-architect, role architect, task #1157 (Voice Code screen-free earbud agent work).
Worktree /Users/duckyoungkim/.aigentry/worktrees/vb1157, branch docs/1157-authority-boundary, base e5610f5a837274872fa5b08a0249a0c6adae0fcb.
Only authored file: /Users/duckyoungkim/.aigentry/worktrees/vb1157/docs/specs/2026-09-11-voicecode-core-contract.md.
No product code is needed to implement these document corrections. Product /Users/duckyoungkim/projects/voicecode is read-only if a source fact must be rechecked.

## Background
Voice Code is a thin bidirectional voice remote: agent questions/results summarized to earbuds, STT for prompts/replies, no second scheduler/agent.
Hardware target Galaxy Z Fold7 + Buds2 Pro is user-supplied, not measured. Existing agents execute; the phone must not invent fresh human authority from speech or key possession.
Core review target 5ba79e5a7549d6eb0bec7ebbaa6c0ef9e98c5aef is preserved on your base, doc blob b42d5f519d6e0fccf3036f1fa691b7725ea09f93. It is a proposal, NOT approved for implementation.
Prior source measurement: Voice Code5d98d60d8b48b7eb170115a2492ddf5e0433106c; deleted .omc/state/subagent-tracking.json and untracked .claude/ preserved. Do not open private config.
Earlier revisions fixed crash truth, full question identity, nonterminal invalidation/paging, command-specific revoke and local defer. Preserve them; do not reopen settled product scope.
Parallel vs1157-architect only scopes a pure spoken-summary composer in another document. It does not depend on your new state names or grant decisions.

## Concrete starting evidence (re-read it, do not inherit as proven runtime facts)
These are source-document counterexamples, NOT executed bugs:
- The document says: "All admission decisions for one client_id run in one serialized step" and "the host tombstones the question key for further answers from this client". No exclusive client ownership or global consume prevents two authorized clients from answering the same provider question.
- It also allows retry of reconciled not_forwarded by re-running the origin's checks. Its prior admission has already tombstoned that question and charged a grant use. It is unclear how it can be answerable again or avoid a second charge when max_uses=1.
- A retry wraps original exact bytes and keeps logical req=(client_id,origin_seq), while its own frame has a fresh client_seq. delivery_unknown/evidence_expired must never become a new actionable request merely through fresh readback or another client.
These quotes summarize lines90/95/103/135/184 of the preserved document as read by the orchestrator. Re-measure the actual paragraphs and dependencies. This is a starting set, not exhaustive coverage.

## Goal
Patch only the owning protocol/authority paragraphs plus a short proof/fixture map. Do not append another architecture or broaden this wave.
1. Specify an enforceable host-wide question decision boundary, or a genuinely enforced single-client owner for each question/session with safe ownership transfer. Choose the smallest consistent design; a per-client tombstone alone is insufficient.
2. Specify how a rejected/unadmitted request differs from an admitted not_forwarded one for eligibility, question ownership and grant charging. One logical action can charge at most once. Preserve original identity and the prohibition on replay after uncertainty; do not revive a consumed action by relabeling it as new.
3. State the actual durable atomic boundary covering shared question ownership, grant use and request state; simultaneous connections, crashes and revocation must agree. Do not introduce a database/framework solely for prose convenience; if one becomes truly necessary, mark a dependency decision rather than silently selecting it.
4. Manually walk a compact transition table for: clients A+B same q; max_uses=1 admission then proven-not-forwarded retry; crash before/after the combined durable decision; expiry/revoke between offer and admission; stale-readback fresh request after delivery_unknown. Name before/state/after/expected provider forwards/grant uses. These are reasoning traces, NOT executed tests.
If an admitted authority retry cannot be justified under the selected boundary, explicitly disable that narrow retry capability with honest voice recovery state rather than inventing a bypass or claiming exact-once.
No code or executable harness in this phase. The next tester may turn the specified traces into fixtures after review.

## Constraints
[SPEC FIRST] One documentation-only phase. No product implementation, build, tests, app/device/daemon execution, installs, model downloads, paid/provider calls, credential/private configuration reads, merge, push, extra authored memory files or nested workers.
The user said continue; host placement (phone only vs optional own PC), external-cloud audio consent and hands-free grant scope/duration/limit remain unanswered. No approval may be inferred for those choices.
Stopping playback is not task cancellation. Voice is not identity. API/subscription billing cannot silently switch. Provider terms/capabilities remain unverified where the input says so.
No workflow is replaced by a mandatory desk approval path. Incomplete functionality is explicitly incomplete, not a production claim.

## Workflow
One authorized phase: inspect the exact inputs -> bounded document edit -> self-review against the concrete counterexamples -> commit -> REPORT -> actual HOLD inject.
Commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase.
Only use /Users/duckyoungkim/.codex/tmp/arg0/codex-arg0gVYpHq/apply_patch to author the permitted document. Orchestrator verified it executable before this wave; preflight it yourself, and HOLD if unavailable rather than substitute a writer.
Read-only git metadata and source inspection are allowed. Record branch/base, measured source SHA/dirty status, measured main SHA/time, and what was NOT measured.
No line-count gate, wholesale rewrite or format-only churn. Do not delay a correct report for historical words in a correction map.
On an actual blocker, preserve completed independent material, then send a factual HOLD. Never create unapproved memory/report files.

## HOLD inject protocol
Execute the actual command after the REPORT; printing HOLD in chat is not delivery.
telepty inject --ref --submit --submit-force --from vb1157-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: vb1157 | task: #1157 | phase: 1/1 review | needs: reviewed bounded spec before any implementation"
For a blocker replace needs with exact missing evidence or permission and send immediately. Silent waiting is forbidden.
If inject errors, preserve the same report text inside the sole document and retry once; report delivery uncertainty.

## REPORT format
MANDATORY: immediately after commit, execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from vb1157-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: vb1157-SPEC | task: #1157 | file: docs/specs/2026-09-11-voicecode-core-contract.md | include exact commit/base/main/source currentness, concrete outcomes, unresolved issues and unrun fixtures; no implementation/build/test"

## [SAWP] envelope
SAWP = Session Autonomous Workflow Protocol. Architect documentation only; the coder instruction does not authorize implementation, build or tests.
[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error
- Never idle — report immediately when done
- Evidence only — no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)

## Inline excerpts
Role boundary verbatim: "architect는 코드를 수정하지 않는다 — 설계 분석+제안만 (구조/의존성/트레이드오프 기반)"
Role separation: coder edits source, builder builds/runs apps, tester tests, logger captures, analyst diagnoses measured runtime, architect designs.
No other Rule/ADR lookup is required; operative constraints are fully stated here.

## Snyk
N/A: documentation only, not a code scan or clearance. Future first-party code must complete Snyk fix-rescan before DONE.

## Boundary
No changes to state/, bin/, product code, other worker documents or old worktrees. No private .claude/ reads, no deletion of prior user changes.
No new research round or engine selection. No autonomous implementation after the document.
No plan mode in a dispatched worker. Send an actual HOLD for blocking ambiguity or any out-of-scope/destructive action.
Do not start peer conversations or delegate to anyone.

## Full capability
Use all available necessary skills/tools/MCPs within scope: read/search source, inspect git, apply_patch the sole document.
No external technical claims need new research in this task. Local code is the source of truth for wiring.
