---
dispatch_kind: re-dispatch
task: 1148
---
# Dispatch - ar1148-architect - Compact source review corrections

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC for this revision. Carry over consumed ar1148-adaptive-routing ref and your REPORT223f31f5/spec607bc40. State paths are orchestrator metadata. Same exclusive output docs/specs/2026-09-09-adaptive-model-effort.md in ar1148 worktree/branch. No implementation, tests/build, probes or new sessions.

## Accepted evidence and correction scope
Accepted: successful role dispatch uses boot-prepare/CLI adapters, not defaultCliFlags; spawnEnv carries only selected model; fallback effort also needs childEnv. Your source-only report is not a current installed capability catalog. Preserve one additive spec; no broad re-audit, target <=50 net new lines. [SPEC FIRST] Implementation waits for a consistent contract and isolated reproduction, not another generic productionization permission question.

## Blockers to correct
1. null currently means no flag/defaulted but Claude W2 and Codex W3 ALWAYS append configured/default effort, even when spawnEnv omits it. Unknown/no override must mean KEEP LEGACY effective policy, not no flag and not fabricated CLI default. Separate inherited/default/unsupported-not-applicable/unknown and selected-vs-observed argv status; explicitly define CLI/env override precedence and distinguish explicit caller input from inherited defaults. Preserve legacy bytes/values until a supported override is applied; unsupported explicit input cannot silently disappear.
2. Vocabulary must be keyed by actual binary+version+MODEL supported combinations, not cli kind alone (agy and gemini share kind but not flags). Installed help/parser accepting a token is not provider/model support. Historical repo ADR is starting evidence; plan builder/tester non-paid source/help+official-primary-doc verification. Do not narrow user multi-LLM scope to codex-only because this design phase forbids probes. Phase incremental support may be explicit, but full task remains multi-LLM and capabilities unknown pause adaptation instead of inventing tokens.
3. floor and effort_table ceiling conflict; undefined arbitrary-token ordering cannot 'clamp down' an unknown token. Specify per-supported-tuple ordered policy band plus known-invalid fallback; do not equate lower tier with measured lower money/latency or safe quality. Prompt complexity can select within the authorized band; prompt text cannot change band/cap/permissions. No 'no extra tokens/latency' guarantee from reusing a classifier with a larger schema. Deterministic structured requirement inference must remain prompt-sensitive when1133 disables general classifier/ties; role-only routing is not completion of this task.
4. Registry does NOT prevent concurrent workers for the same task: key is sid+ref, fresh spawn precedes begin-delivery. #1136 reviewer remeasured cli.ts1033 gate,1075 spawn,1095 ready,1102 begin,1126 inject. Escalation belongs in durable structured action/claim identity and bounded attempts, not queue prose+policy_rev alone (revision must not reset budget). Reuse1136 boundary for next DISPATCH, no duplicate task selector. No hot-switch claims; --target refusal remains reasonable.
5. Shadow decision inside an otherwise normal dispatch may spawn legacy worker; standalone evaluation must not. State those modes exactly, retain effective existing policy on rollback with one mode switch (not editing profile to manufacture unknown), no counter/claim consumption in pure shadow. Configured/written-argv is not provider-applied reasoning proof; use evidence-qualified status.
6. One file per worker remains mandatory: E1/E2/E3 can integrate in one commit/PR without assigning three files to coder-A; E4/E5 too. Avoid provisional overlapping T151-T155 reservations; orchestrator will reserve descriptive test path or a block. Spec test description must assert desired differing configured tuples (red against baseline), not assert the BUG and call the passing assertion RED. Named actual failing behavior, not fixture/setup failure.

## Policy and handoff
Do NOT re-ask if productionization is wanted. P2's current two-way choice is false: measure the other CLI/model capabilities in a bounded builder/tester phase instead of making lack-of-measurement a scope decision. Keep multi-LLM as full acceptance.
Only truly user-owned question potentially remaining: quality-first vs balanced automatically lower/higher effort within an approved tested band, and whether to change current effective defaults at canary. Present this as one scoped choice with costs/quality explicitly unmeasured, after correcting technical defaults; no live change in this phase.
Report first one-file reproduction and capability-measurement handoffs, then stop; source/currentness must compare current main, not only your earlier measurement a3c97c2.

## Workflow and HOLD
Read exact relevant source, make only bounded spec revision, commit (WIP allowed) at phase boundary. ACTUALLY send:
telepty inject --ref --submit --submit-force --from ar1148-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: ar1148 | task: #1148 | phase: SPEC review | needs: exact technical blocker or reviewed policy choice"
Silent waiting forbidden; if inject fails retain REPORT-ar1148.md and retry once at next boundary. Three failures -> STUCK.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from ar1148-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: ar1148-SPEC-corrected | task: #1148 | include SHA, currentness, addressed contradictions, exact first single-file test/capability handoffs, genuine remaining policy only | no implementation/test/runtime/prod claim"

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

## Full capability and boundaries
Use all relevant tools/skills/MCP within design-only scope; no production edit, runtime/probe/build/test, account read, destructive action or new agent. Read/Grep/Git/structured parsing and exclusive spec commit authorized. Snyk N/A docs-only; future code scans before DONE. Other prior constraints remain inline in original ref.
