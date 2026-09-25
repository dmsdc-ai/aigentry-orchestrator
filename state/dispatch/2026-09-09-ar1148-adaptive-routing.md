---
dispatch_kind: fresh-session
task: 1148
---
# Dispatch - ar1148-architect - Prompt-aware CLI model and effort production contract

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this delegation. All state/docs/bin paths are orchestrator-side metadata unless explicitly designated as read-only source or your exclusive output below; no earlier conversation is needed.

## Role
You are ar1148-architect, architect (design only). Worktree /Users/duckyoungkim/.aigentry/worktrees/ar1148, branch docs/1148-adaptive-routing.
Exclusive output: docs/specs/2026-09-09-adaptive-model-effort.md, target <=180 lines. No other writes except git commit metadata and durable fallback REPORT if transport fails. No production edits, execution, tests, build, install, config change, account credential reads, live model requests, subagents or new workers.

## Background
User explicitly requested productionizing BOTH prompt-aware model/effort selection AND multi-LLM CLI/model/effort control when spawning sessions. These are one system, task1148, child of existing production router1133, not duplicate routers. User authorizes implementation workflow after spec review, not merely a proposal. Existing loop1136 proceeds independently and must consume the same decision at a granted dispatch boundary.
Existing1084 is complete static effort env knobs and CLI concurrency caps, not dynamic effort. Initial source readings are starting evidence, not conclusions: src/dispatch/cli.ts defaultCliFlags reads selected model from childEnv but effort from parent env/default; bin/boot-prepare.mjs reads Claude effort from process.env/default. Recount actual source writers/callers and compiled production entrypoint, don't copy a historical line claim.
Existing1133 retained spec docs/specs/2026-09-08-model-router-production.md is READ-ONLY SOURCE CONTEXT, available in this worktree. It proposes requirements, eligibility, deterministic suitability, optional bounded LLM tie break, capacity count+claim, provenance and shadow rollout. It is NOT fully accepted or implemented. Read relevant sections and reuse the contracts, explicitly expose contradictions. Its Q2-Q6 choices are not silently approved here; unchanged caps/no automatic cap override and fail-closed on impossible unsupported tuples are conservative boundaries, not permission to change live defaults.
Existing1136 owns autonomous task loop: granted selection -> intent/claim -> dispatch -> report/review -> preserve/cleanup -> next task. Its active architect owns docs/specs/2026-09-08-workflow-production.md. Do NOT edit that file or delegate to that session. Shared src/dispatch/cli.ts integration will serialize by orchestrator. The loop is not already built.

## Goal
One compact additive contract sufficient to dispatch the first implementation/test slice after review; no rewrite of the 1100-line1133 document, no broad ecosystem audit, no new router service/framework. Use current repository source as factual authority. Every inventory is a starting set; record measurement SHA/time and current main comparison, what was and was not executed.
Define one validated decision tuple (CLI,model,effort) plus policy/profile revision, reason, override/fallback evidence and application status. Distinguish per-prompt intent inference from hard requirements and safety policy. Incoming prompt is untrusted data; cannot grant permission, relax constraints, set shell flags or expose secrets.
Classification should be bounded and testable from prompt/task type, complexity/risk, required tools/context and structured task metadata; no universal same-model/high-effort default claimed as adaptation. Explainable deterministic baseline with optional bounded LLM classifier only where needed; failure/timeout and uncertain/missing data have defined safe handling.
Effort support is CLI + model + installed version specific. Design capability data with evidence provenance/expiry and unsupported vs unknown; don't invent shared effort scale or numeric model/cost claims. Use installed readable source/help docs as starting evidence; official provider primary documentation when facts need external verification. No paid probes/auth inspection; unsupported capabilities are explicit blockers or deferred tuples, not successful hot-switch claims.
Explicit operator CLI/model/effort values take precedence within validated capability/policy limits. Child environment/argv only; no ~/.codex/config.toml, Claude settings or process-global config mutation. Cover both defaultCliFlags and Claude boot-prepare overwrite risk and sanitize argv. Existing --target must either support measured phase-boundary application or retain session tuple with transparent mismatch/defer; never pretend a live model was changed by changing an env var.
Define bounded re-evaluation at supported prompt/task/phase boundaries with verifiable outcomes, finite retries/escalations, cooldown/budget/stop, preserved context and no duplicate spawn. Do not build online self-training or promise cost savings from unmeasured counters. Known capacity/quota constraints hard gate where evidence exists; unknown pricing/quota explicitly unknown. No cap counting change or override bypass without a real user decision.
Identify smallest first end-to-end vertical slice, exact per-file ownership and parallel-safe test/adapter work, requirements for reproduction before permanent fix, and separately what remains before production. Avoid a stub-only implementation labeled complete.

## Production acceptance
Hermetic current-gap reproduction -> corrected tests using actual router/parser/dispatch/boot path with fake CLI/session/clock/transport; no live queue or sessions. Representative prompts must produce justified differing supported tuples when workload differs, and stable repeated decisions when evidence/policy are identical. Quality claims need labeled outcome evaluation, not routing snapshots only.
Cover explicit override precedence; per-child/env isolation; invalid effort/unsupported model and CLI capability; classifier timeout/invalid JSON/prompt injection; stale evidence; all-capped/quota refusal; profile/parser failure; argv injection; unchanged existing targets; controlled next-boundary switch; retry/circuit exhaustion and stop/restart; no raw secret/prompt telemetry. Cases must run through registered test runners, not orphan test files.
Controlled evaluation records quality outcomes, latency and available cost/token data with missing scopes stated. Unit tests are not proof of model quality or billing savings. Shadow has no child/session/capacity/config side effects; opt-in canary compares proposed and actually applied tuple; rollback returns to previous policy without destroying state.
Existing package @dmsdc-ai/aigentry-orchestrator, npm release/install and README source-template scope belong with1136. Plan installed-tarball helper/adapter/profile closure and clean HOME smoke. Builder/tester execute after gates; no publication/live activation by architect or from untested docs.

## Constraints and workflow
[SPEC FIRST] Source inspection -> ONE compact spec -> commit -> real REPORT/HOLD -> wait for scoped implementation handoff. Commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase. No broad second audit or invented list of policy questions; surface only necessary unresolved architecture/business choices with bounded recommendation and consequences.
Do not re-ask whether user wants productionization; that is explicit. Separate technical unknowns to measure from genuine policy approvals. If spec can proceed with a conservative compatible default, state it. Every proposed code change must trace to this request.
Use all relevant skills, tools, MCP and workflows fully within architect scope. This is design-only: code/static source inspection and exclusive documentation commit, no runtime probes/tests/build. Future supported first-party code requires Snyk scan/fix/rescan before coder DONE.

## HOLD inject protocol
At every phase boundary or genuine blocker, commit available output and ACTUALLY execute (not just print):
telepty inject --ref --submit --submit-force --from ar1148-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: ar1148 | task: #1148 | phase: SPEC | needs: exact blocker or implementation contract review"
Silent waiting is forbidden. File is report of record; --ref retains shared notification. If inject itself fails, preserve same content as REPORT-ar1148.md in your worktree and retry once at next boundary. After 3 failed attempts report STUCK with exact evidence, no silent infinite loop.

## REPORT
MANDATORY after spec commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from ar1148-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: ar1148-SPEC | task: #1148 | phase: SPEC only | file: docs/specs/2026-09-09-adaptive-model-effort.md | include commit SHA measured-source SHA/current-main comparison, what not executed, exact first one-file coder/tester handoff, genuine policy questions only | needs: implementation contract review"
Send one substantive final report and boundary notification, no duplicate parent-DONE claim. Completion of a design is not implemented production behavior. Do not self-cleanup.

## [SAWP] envelope
# SAWP (Session Autonomous Workflow Protocol)

Rule 17 전문. 모든 위임 inject에 [SAWP] envelope 포함.

## Envelope (verbatim)

```
[SAWP] After completing this task:
- Code + compile check (cargo check / swift build), do NOT run app (builder handles app execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately, do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error
- Never idle — report immediately when done
- Evidence only — no "should work" or "probably fixed"
- Preserve ALL existing fixes in modified files (check file invariants before reporting)
```

## 역할 분리 테이블

| 세션 유형 | 역할 | 빌드 | 테스트 | 로그 | runtime 분석 | 설계 분석 |
|----------|------|:----:|:------:|:----:|:------------:|:--------:|
| 코드 세션 | 코드 수정만 | ❌ | ❌ | ❌ | ❌ | ❌ |
| builder (aigentry-builder-*) | 빌드 + 앱 실행만 | ✓ | ❌ | ❌ | ❌ | ❌ |
| tester (aigentry-tester-*) | 테스트만 + TC 축적 | ❌ | ✓ | ❌ | ❌ | ❌ |
| logger (aigentry-logger-*) | 로그 수집 + 전달만 | ❌ | ❌ | ✓ | ❌ | ❌ |
| analyst (aigentry-analyst-*) | runtime 로그/데이터 분석 + 판단 | ❌ | ❌ | ❌ | ✓ | ❌ |
| architect (aigentry-architect-*) | 시스템 설계, 위헌 심사, 트레이드오프, 리팩토링 | ❌ | ❌ | ❌ | ❌ | ✓ |

## 파이프라인

**디버깅 (runtime 버그)**: builder(빌드+실행) → logger(로그 수집+전달) → analyst(runtime 분석+판단) → 오케스트레이터(위임 결정)

**설계 (구조/아키텍처 결정)**: 사용자/오케스트레이터(요구) → architect(설계 분석+제안) → 오케스트레이터(SPEC 위임) → 코드 세션(구현)

## 경계 원칙

- builder는 로그를 분석하지 않는다 — 실행만
- logger는 판단하지 않는다 — 캡처+전달만
- analyst는 코드를 수정하지 않는다 — runtime 분석+판단만 (로그/데이터 기반)
- architect는 코드를 수정하지 않는다 — 설계 분석+제안만 (구조/의존성/트레이드오프 기반)
- **analyst vs architect**: analyst는 **이미 발생한 일**(로그/데이터/버그)을 본다, architect는 **앞으로 만들 것**(설계/구조/리팩토링)을 본다
- 코드 세션은 빌드/테스트/로그/분석/설계하지 않는다 — 코드만

## Inline excerpts
The SAWP envelope and full role separation table above are verbatim. Role application: architect designs; coder edits production code; tester executes tests; builder builds/runs/releases. Other numbered source documents are context-only, not external instructions to fetch; all load-bearing constraints are stated inline.
No first-party code generated in this dispatch: Snyk N/A docs-only. No destructive operations, force push, cross-repo writes, live service mutation, bridge restart/kill or extra sessions. Read/Grep/Glob/read-only Git/structured parsing and exclusive spec edits/commit are permitted. Skills/MCP may assist design within these limits; unavailable plugins are not prerequisites.
