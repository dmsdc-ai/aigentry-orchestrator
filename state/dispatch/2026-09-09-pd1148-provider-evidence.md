---
dispatch_kind: fresh-session
task: 1148
---
# Dispatch - pd1148-dustcraw - Corroborate captured effort capabilities with primary sources

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. Orchestrator state/docs/bin paths are metadata unless explicitly named as your owned report or read-only context. No earlier chat is needed; your role-sandbox is not the worktree.

## Role
You are pd1148-dustcraw, role researcher (external factual information collection only).
Worktree /Users/duckyoungkim/.aigentry/worktrees/pd1148, branch evidence/1148-provider-capabilities, starting HEAD f509ed8.
Exclusive repository output: docs/reports/2026-09-09-effort-provider-corroboration.md. Target <=250 lines; use a compact evidence matrix and source list, not a new architecture spec.
No code/test/profile/config edits, no installation/build/test, no additional agents/sessions.

## Background
User requested production prompt-aware multi-LLM CLI/model/effort selection at session spawn. The existing router selects model but successful role dispatch reads effort through boot-prepare/per-CLI adapters. Implementation, provider-applied behavior, cost/quality and rollout are NOT verified.
A builder retained E7-local capture at docs/reports/2026-09-09-effort-capability-capture.md (READ-ONLY evidence). Report blob7ecb880ac60405997b187caad0f41cf925aef5e8; original commit ad477d87 retained on main f509ed8. It is a starting measurement, not authority. Exact binary, version and model identity must not be silently substituted.
Reviewer independently read surviving raw Codex JSON: bytes517840 SHA25632bdd1fe3ffd82df3d03c6c9b9d9068087cd9640ded4377f604586d7a743749b, models.length11 and effort columns match report. No new CLI or provider execution from that review.
CORRECTIONS to that report: a536cd8..9eac5b3 has203 commits, NOT2030; historical origin/main is only a local tracking ref, not freshly fetched remote state. cli.ts952 spawnEnv is in spawnWorkspace, not resolveRoute. The model-only child env finding is unchanged.
This doc phase follows installed capture as an intrinsic dependency; parallel independent1136 builder compiles tests. User quality-first/balanced default policy is still unanswered. No current live default or scope change is authorized by research.

## Goal and exact evidence boundary
Corroborate actual CLI configuration surface AND model-specific supported effort using official provider/product documentation or official source/release artifacts. Separate generic API vocabulary from CLI translation and from actual model support. Documentation still does NOT prove runtime application/account availability.
Starting tuples, counted from prior report's five resolved binaries, NOT a current exhaustive provider list:
- claude 2.1.266; repo declared claude-opus-5; local help effort low/medium/high/xhigh/max, no model catalogue.
- codex 0.153.4; repo declared gpt-6-astra; local bundled row supports low/medium/high/xhigh/max/ultra, catalog default low but repo writer always defaults high via -c model_reasoning_effort=.
- grok 1.0.24; repo declared grok-4.6; help exposes --reasoning-effort alias --effort without values, shipped docs disagree across canonical/menu/ACP lists.
- agy 1.1.28, declared kind gemini; repo model gemini-3.8-flash-high; help exposes --effort low|medium|high, no executed model list.
- gemini-cli 0.53.0, binary gemini; repo model gemini-2.5-flash; local help/adapter has no effort flag. agy and gemini are distinct implementations, not interchangeable aliases.
Read those local observations before mapping them; old model-profile versions are historical. Do not rerun CLIs or call authenticated/live model lists in this phase.
For each tuple retain exact fetched official page/source URL, retrieval UTC date, doc/version applicability, local evidence kind, provider/documented vocabulary and mismatch/unknown. Unknown is not unsupported; newer-only docs do not retroactively prove this installed version. Exact-version support does not prove every later version.
If official evidence is absent for an exact model, say NOT ESTABLISHED and preserve the requested identity. Never replace it with a newer/older familiar model or invent cost/quality claims. A docs fetch failure is a fetch failure, not model absence.
Do not emit approved machine capability metadata or mark provider_applied=true. A candidate "both" observation requires matching local and primary-doc tuple/surface; still label runtime unmeasured.

## Sources and bounded method
Use official documentation search/page retrieval tools first when available; actually open/fetch pages, never treat search snippets/unopened links as evidence.
For OpenAI specifically, use official documentation on developers.openai.com/platform.openai.com/learn.chatgpt.com. Preserve gpt-6-astra exact identity. Start the external phase with a concise official search such as "Codex gpt-6-astra reasoning effort" and fetch the matching page. Do not use a migration/model resolver, old internal model tables or API keys. This is documentation, not API-backed execution.
For other providers, discover and verify official docs/product-owned source links; never rely on third-party comparison sites or unverified repository ownership. Official CLI docs/source are needed for agy translation rather than generic Gemini API thinking-level docs alone.
Use concise targeted queries, bounded at two search passes per unresolved tuple; retain partial evidence and explicit unknowns rather than an endless search. Public read-only documentation retrieval only, no login, paid inference, auth/config mutation, updates or model-router execution.
Paraphrase with exact supporting links and very short excerpts (<=20 quoted words per page across the report). Note pages that are inaccessible or contradict local help. Do not claim search coverage is universal.
The adaptive-routing spec is context-only, not approved implementation. Do not redesign it or ask for new policy rounds. Report technical evidence gaps separately from the existing pending user default-policy decision.

## Workflow
[SPEC FIRST] This bounded evidence plan is the research contract; no implementation.
One phase: inspect retained evidence -> fetch primary sources -> write/commit sole report -> ACTUAL REPORT and HOLD. Commit WIP at every phase boundary, so interruption loses at most one phase.
Use all applicable web/search/read/Grep/Glob/Git/documentation skills/MCP fully within researcher scope. No plan mode, subagents, tests, live sessions or secrets. Operational/document-fetch failure does not authorize workaround account or transport changes. Third failed attempt => STUCK with exact evidence; no silent waiting.

## HOLD inject protocol
At completion or a genuine blocker, commit report then ACTUALLY execute:
telepty inject --ref --submit --submit-force --from pd1148-dustcraw {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: pd1148 | task: #1148 | phase: primary-source corroboration | needs: evidence review or exact inaccessible official source"
If inject fails retain REPORT-pd1148.md in the worktree and retry once at next boundary. Inline markdown is not a notification.

## REPORT and dustcraw feed
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from pd1148-dustcraw {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: pd1148-EVIDENCE | task: #1148 | file: docs/reports/2026-09-09-effort-provider-corroboration.md | include commit/main currentness, fetched official URLs, matching/mismatched/unknown tuples, model-specific vs generic support and unmeasured runtime | next: one evidence-backed next validation suggestion within current1148 scope; parent incomplete"
The next-task suggestion is information to the orchestrator only, not authorization to dispatch peers or implement it. Do not self-cleanup or wait indefinitely for possible followup.

## Snyk
N/A: report-only external documentation collection, no first-party code.

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

## Inline excerpts and role boundary
Envelope/table above are verbatim. Researcher collects external factual sources and documents limits; no implementation/design verdict or build/test. All operational and citation limits are inline; source/spec paths are read-only context, not commands to execute.
