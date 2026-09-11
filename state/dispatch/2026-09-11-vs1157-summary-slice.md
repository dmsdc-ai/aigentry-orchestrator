---
dispatch_kind: fresh-session
---
# Dispatch - vs1157-architect - Isolate the first faithful spoken-summary code slice
THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC.
state/ and bin/ are orchestrator metadata. Absolute source paths below are actual read-only inputs; your sole output is the named worktree document. Prior reports are context-only.

## Role
You are vs1157-architect, role architect, task #1157 (Voice Code's highest-priority faithful spoken summaries).
Worktree /Users/duckyoungkim/.aigentry/worktrees/vs1157, branch docs/1157-summary-slice, base e5610f5a837274872fa5b08a0249a0c6adae0fcb.
Only authored file: /Users/duckyoungkim/.aigentry/worktrees/vs1157/docs/specs/2026-09-11-voicecode-summary-slice.md.
Product source /Users/duckyoungkim/projects/voicecode is read-only. Read its applicable project instructions and inspect the existing speech/summary path, not private configuration.

## Background
The user works screen-free through wireless earbuds; the most important feature is faithful concise TTS of agent questions, progress and results.
Voice Code is a thin remote, not another agent/scheduler. STT/TTS quality, API and subscription access, multiple LLMs and a premium native companion UI remain overall requirements.
Current source measurement: Voice Code5d98d60d8b48b7eb170115a2492ddf5e0433106c, prior deleted .omc/state/subagent-tracking.json and untracked .claude/. Recheck HEAD/dirty; preserve both paths.
User said continue, but host placement/cloud audio/grant choices are unresolved. A pure deterministic spoken-summary composer can be specified independently of those choices. It is a component, NOT a claim of working end-to-end TTS.
Parallel vb1157-architect patches authority/retry paragraphs of the existing core document. Do not depend on its new field names or edit that document. Do not re-specify protocol, grants, UI, routes, providers or engines.

## Binding slice requirements (inline; existing core proposal context-only)
The eventual function takes typed source-linked summary facts and returns ordered utterance segments plus provenance/status metadata. It performs no I/O, provider call, action dispatch, audio playback or authority decision.
Inputs distinguish CLI turn completed/failed/cancelled/limit/unknown from task success; agent-reported outcome from observed checks; checks passed/failed/not_run/unknown with agent_reported/observed_tool_exit/host_verified source; changed files/out-of-project/scope changes; uncertainty; pending questions; original/truncation; optional attributed agent prose.
Ordering: pending questions, turn status, observed failures, scope/out-of-project changes, attributed agent outcome, uncertainty, truncated-detail notice. Exit0 means turn ended, never task success.
Agent-reported checks must not become verified checks; unsupported/unknown fields stay unknown. Files/tool output do not become trusted final-summary instructions.
Optional prose is explicitly attributed and omitted when the turn is not completed, failures observed, scope changed, question pending or claim not success. No deterministic semantic-truth guarantee for arbitrary prose.
Preserve Korean/English paths and action/target details verbatim where decision-relevant. Do not equate playback completion with hearing or approval.
Questions in this component are read-only information: it cannot mark a live question answerable, issue a challenge, close it or authorize anything. Exact approval readback remains a separate core dependency.
A short-summary preference cannot silently truncate mandatory facts. Explain bounded output/overflow with a deterministic first summary plus explicit detail requirement; no time/latency claim without device measurement.

## Starting source evidence (re-measure)
Earlier source review found VoiceEngineManager.speak always delegates to built-in TTS, ContextCompressor's optional billed summary path, and MainViewModel reading raw messages/screens. These are past source observations, not runtime tests.
The core proposal docs/specs/2026-09-11-voicecode-core-contract.md and UI proposal docs/specs/2026-09-11-voicecode-design-contract.md are context-only. All slice requirements needed here are inlined above.
Search owning Kotlin files/callers and existing JVM test dependencies. Do not assume new test frameworks. Measure exact source paths and explain how a pure component could later be wired without claiming the missing structured adapter already exists.

## Goal
Produce a concise approval-ready implementation spec for ONE pure Kotlin production file (e.g. voice/SpeechComposer.kt if compatible with source) and ONE separate tester-owned fixture file.
Specify concrete input/output types, exhaustive rendering/unknown/attribution rules, Korean spoken examples and deterministic boundedness. Keep it small; no new library or parallel summary framework.
Define fixtures with expected text/fields: exit0+agent tests-failed, agent pass without observed event, observed exit1+agent success, untrusted tool/file summary text, scope change, pending question, truncated original, provider limit/auth error, cancellation, unverified deploy, malformed optional summary, mixed Korean-English paths. This enumeration comes from core proposal FX1-FX12; re-evaluate sufficiency for this slice, not the whole app.
Identify missing structured-input adapter as an integration prerequisite, not an excuse to implement heuristic truth extraction. A pure composer with synthetic input can be tested but is not yet audible product functionality.
Give file-by-file coder/builder/tester handoff and precise existing compile/test runner commands from source (do not run). No product fixes, dependencies, CI edits, benchmarks or new user questionnaire in this phase.

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
telepty inject --ref --submit --submit-force --from vs1157-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: vs1157 | task: #1157 | phase: 1/1 review | needs: reviewed bounded spec before any implementation"
For a blocker replace needs with exact missing evidence or permission and send immediately. Silent waiting is forbidden.
If inject errors, preserve the same report text inside the sole document and retry once; report delivery uncertainty.

## REPORT format
MANDATORY: immediately after commit, execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from vs1157-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: vs1157-SPEC | task: #1157 | file: docs/specs/2026-09-11-voicecode-summary-slice.md | include exact commit/base/main/source currentness, concrete outcomes, unresolved issues and unrun fixtures; no implementation/build/test"

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
