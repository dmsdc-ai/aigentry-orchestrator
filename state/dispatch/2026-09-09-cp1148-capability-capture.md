---
dispatch_kind: fresh-session
task: 1148
---
# Dispatch - cp1148-builder - Non-paid installed CLI capability capture

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this delegation. Orchestrator state/docs/bin paths are metadata unless explicitly named as your exclusive report or read-only sources. No earlier chat is needed; your role-sandbox cwd is not the worktree below.

## Role
You are cp1148-builder, builder (bounded command execution and factual capture only).
Worktree /Users/duckyoungkim/.aigentry/worktrees/cp1148, branch evidence/1148-effort-capabilities.
Exclusive repository output: docs/reports/2026-09-09-effort-capability-capture.md. This is a retained command/evidence report, not production code. No other repository file writes, no tests/build/install/publication/config changes. No subagents or sessions. Do not interpret provider behavior or pronounce routing suitability; raw observed help/parser/catalog facts and their limits only.

## Background
User wants prompt-aware multi-LLM CLI/model/effort routing in production. Task1148 extends1133 router, coordinated with1136 autonomous loop. Architect r2 spec3febdca is retained in this worktree as docs/specs/2026-09-09-adaptive-model-effort.md (READ-ONLY CONTEXT, not an implementation instruction).
Current architectural gap: all effort vocabularies came from historical in-repo text, never re-probed during design. Successful role dispatch uses boot-prepare and per-CLI adapters; defaultCliFlags is only fallback. CLI kind gemini may be agy OR gemini-cli, with different models/effort surfaces.
No current supported model/effort catalogue is established. A help flag or parser accepting a token is NOT proof the provider supports/applies it to that model. Local E7 capture here supplies only the local half; a separate official-primary-doc corroboration step follows exact identities. No source authorizes a paid inference, changing an account or silently reducing multi-LLM scope to codex only.
User quality-first/balanced/default policy is pending. That does not block this non-mutating measurement, and it never authorizes changing a live effort/model/default. Keep parent1133 caps/grants/claim policies unchanged.

## Goal and exact measurement boundary
Capture each resolvable binary in the starting set claude, codex, grok, agy, gemini separately: resolution path and executable/version identity, local --help effort/model surface, documented token/model vocabulary if a local non-paid source explicitly exposes it, and how current repo dispatch maps CLI kind to binary/model. This starting list counts the router's advertised kinds plus both gemini implementations; remeasure profile/adapter sources and report any absence/addition without installing anything.
Use command -v/resolved installed package metadata and bounded --version/--help calls. Before any deeper command, discover it from the installed help. Do NOT assume 'codex debug models' or 'agy models' exists or is offline because a spec named it: first inspect debug/subcommand help/local source. Only run a catalogue command if its installed help/source clearly establishes local/offline read-only behavior; otherwise record NOT EXECUTED/UNVERIFIED and stop that command path.
Use a fresh temporary HOME and explicit temp config roots, no ambient credentials, AIGENTRY_* or CODEX_HOME/Claude/Gemini config pointing to real user state. Resolve executable paths before using a minimal child environment; HOME/TMPDIR/config roots in fixture only. Preserve the live environment and file permissions. No ~/.codex/auth.json, credentials/keychain, login/auth commands, API calls, model inference, -p prompts, real daemon/session, npm/npx install, updater, git push or network mutation.
For local installed metadata, inspect only paths needed to resolve binary version or its own shipped help/catalog schema. No broad home scans or config/token dumps. Provider internet research is NOT this builder's task; mark provider evidence 'not measured in E7-local', not 'unsupported'.
Each command has a timeout (normally <=15s, total bounded attempt set), captured exit/stdout/stderr and timestamp. Do not equate no output/timeouts with unsupported. Redact any unexpected secret from retained artifacts; report only key name if relevant, never value. All temporary processes must end before REPORT.
Do not execute real dispatch/router to discover its model, because the classifier can be billable. Read docs/model-profiles/model-routing-profile.md, src/dispatch/cli.ts, bin/boot-prepare.mjs, and src/session/boot-adapter/*.ts statically for declared mapping; preserve SHA and distinguish declared default from user-override/effective live config (the latter is NOT measured).
For each tuple report evidence separately: installed flag/help present; exact advertised tokens/models or unknown; parser/catalog vs provider proof distinction; read-source/command basis. No 'verified_by:both' in this local-only phase. No assertion a lower effort costs less, higher is better, or a newer binary keeps an old model's support.

## Output and workflow
[SPEC FIRST] This bounded capture plan is the execution contract; no production implementation. One phase: source/command preflight -> allowed offline captures -> ONE evidence report -> commit -> real REPORT/HOLD. If a command cannot be proven within no-paid/no-auth scope, skip that command and name the limitation, not the entire task.
Report measured repo HEAD and current main comparison, actual command argv/env KEY names (no values beyond synthetic temp paths), source hashes, exits, output excerpts with truncation explicitly named, unmeasured provider/auth/runtime behavior, and a data-only candidate row set for later review. Retain necessary raw evidence in the same report (appendix if needed); no hand-maintained output count labeled exhaustive.
Commit at every phase boundary (WIP allowed) so interrupted work survives. No build/test is needed or authorized; Snyk N/A report-only. If the only remaining role is hypothetical waiting, send final REPORT promptly. Do not self-cleanup.

## HOLD inject protocol
At a genuine boundary or blocker, persist/commit available report and ACTUALLY execute:
telepty inject --ref --submit --submit-force --from cp1148-builder {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: cp1148 | task: #1148 | phase: E7-local capture | needs: exact unsupported command or missing non-paid evidence boundary"
Silent waiting forbidden. --ref notification is durable. If inject fails preserve REPORT-cp1148.md in the worktree and retry once at next boundary. Three failed attempts => STUCK with evidence.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from cp1148-builder {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: cp1148-CAPTURE | task: #1148 | file: docs/reports/2026-09-09-effort-capability-capture.md | include commit SHA repo/main currentness, exact commands/results, raw evidence scope, observed vs unmeasured local vocabulary, provider proof NOT measured, no paid/auth/config/live-session changes | needs: review and primary-source corroboration; not parent DONE"

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

## Inline excerpts and full capability
Envelope and role table above are verbatim; builder application here is bounded CLI help/version execution and factual output capture, not code/test/runtime analysis. Read/Grep/Glob/Git, owned report edits/commit and the explicit read-only commands are allowed. Use all relevant tools/skills/MCP fully within scope; missing convenience plugins not blockers.
No production or test code, no additional sessions/subagents, no plan mode, no destructive actions or bridge manipulation. Source docs are context-only; all load-bearing limits are inline. Report is evidence, not approved capability metadata or a production release.
