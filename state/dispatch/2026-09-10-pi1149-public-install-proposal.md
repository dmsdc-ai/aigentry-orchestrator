---
dispatch_kind: fresh-session
task: 1149
---
# Dispatch - pi1149-architect - Propose a practical public installation and onboarding path

> THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC. State/docs/bin paths are orchestrator metadata unless explicitly named as owned output/read-only context. Your sandbox cwd is not the target worktree. No previous chat is required.

## Role
You are pi1149-architect, role architect. Worktree /Users/duckyoungkim/.aigentry/worktrees/pi1149, branch docs/1149-public-onboarding, base d8be6f371f5c3df0ef16170802290678333163e2.
Only tracked output: docs/proposals/2026-09-10-public-install-onboarding.md, <=200lines. Design/proposal only; no production code, commands/installers, README/config changes, builds, tests, installs, package lifecycle scripts, daemon/app execution or auth mutation.
Read-only sibling sources /Users/duckyoungkim/projects/aigentry and /Users/duckyoungkim/projects/aigentry-devkit plus named other ecosystem package manifests/readmes as discovered. They may contain user WIP: DO NOT stage, revert, branch-switch, modify, run or delete anything there.
No other workers/subagents. UniversalD external_dispatch, auto-router architect, foreground samecmux. Existing independent researcher1148 owns another report; no third worker wave.

## User question and objective
USER (Korean): propose how public users should install the aigentry ecosystem and use it efficiently.
Provide a practical product/distribution proposal grounded in actual current entry points, not an owner's private workstation bootstrap. User asked for a proposal, NOT to install, publish, migrate scopes, or enable autonomous operation now.
Aim for a single understandable entry point and first useful task with minimal prerequisites, while optional components remain optional. Judge conservatively against existing code; do not invent an extra umbrella framework if existing meta/devkit/orchestrator can carry the journey.

## Context to verify, not assume
Existing task526 ecosystem epic owns improvements. Related tasks:1144 meta package compatibility/public install;1145 installer resolution/log consistency;1147 interrupted install/recovery;1142 credential-state protection;1143 actual test/CI coverage;1146 tested artifact/release identity;528 old devkit orchestrator install profile spec;1136 autonomous loop/core safety;1148 adaptive CLI/model/effort.
These are task links, NOT completion facts. Current1136 correction has56/56 TEST-ONLY counterpart evidence but source retest/security2LOW/caller wiring/activation incomplete.1148 has capability/docs observations, NOT approved balanced defaults or runtime application. Do not sell them as shipped autonomous behavior.
Observed orchestrator manifest on main: name @dmsdc-ai/aigentry-orchestrator, sourceversion0.2.0, Node>=20, os darwin/linux, bin aigentry-orchestrator -> bin/init/cli.mjs. This is source evidence only, not registry availability or clean-install proof. Recheck exact source and published metadata.
Historical1144 report: meta ranges telepty^0.6.6/brain^0.2.8/devkit^0.0.22 excluded then-local0.8.3/0.3.1/0.1.14; NOT proof of current registry failure. Devkit sibling has protected WIP (prior16modified+68untracked count is historical, not exhaustive today).
Ownership/default component lists must come from current manifests/callers, not inherited hand-maintained audit counts. Recount only relevant public entry points and label unmeasured scope.

## Required output
1. Short recommended public experience: install -> doctor/prereqs -> connect ONE supported provider using existing authentication -> workspace/project init -> first task -> review -> optional controlled automation. Clearly separate current commands from proposed future command examples.
2. Existing vs proposed package/CLI ownership: user-facing entry point, devkit setup, orchestrator, telepty transport, optional memory/deliberation/logging/tools. Name actually included versus opt-in modules from measured source. Avoid requiring every repo, every provider, all global agents or developer toolchain for basic use.
3. Prerequisites/OS support honesty: source os/engines != actual packaged CI/run proof; don't promise Windows/native Linux terminal parity if unverified. Explicitly handle existing user CLI/config/credentials, no overwrites or sudo/curl|sh as implicit default.
4. Efficient everyday workflow: presets/project scoping, first success, resumable task state, meaningful status/errors, approvals/cost guardrails, opt-in automation and stop switch. Be explicit what is proposal versus implemented.
5. Packaging/release/update/remove: validated compatible set not independent latest; exact tested tarball + clean HOME/prefix acceptance; postinstall side effects transparency; preserve config/data, opt-in services, resumable interrupted install, rollback limits. Tie gaps to existing owners instead of creating duplicate fix lists.
6. Prioritized delivery slices and measurable acceptance criteria (install steps/time is a TARGET, not measured benchmark). Finish with few genuine user decisions; prefer one proposed default, not a giant option grid.

## Evidence collection boundaries
Inspect relevant README/package.json/bin entrypoint writers and actual consumer paths. Record SHA/time/dirty-vs-committed distinctions. Source existence is not executable/public usability proof.
For current publication claims make bounded anonymous read-only GETs to official npm registry metadata for the actual front-door/meta/devkit/orchestrator/telepty names found in source (at most6packages, not wholeecosystem). Record URL/status/time/dist-tag/version/engines/os/bin/dependencies where returned; no install/pack/npm execution or credential use. Don't infer404 from absent local files or use localversions as registryversions.
Public official GitHub README/package files may corroborate source, but sourceauthor is not runtime proof. Exact registryURLs required in report; quote no more25words per publicpage. No thirdparty research.
If network inaccessible, report exact URL/error and keep availability UNKNOWN. Do not block the whole design on inability to verify a registry; explicitly delimit current runnable instructions.
Counts/lists above are starting sets measured from tasknotes/manifest, not exhaustive truth. Recheck relevant sources before conclusions. No new broad audit or paid/model calls.

## Workflow
[SPEC FIRST] Single proposal phase only. Read -> measure bounded sources/registry -> synthesize conservative proposal -> inspect diff -> commit -> actual REPORT/HOLD. No implementation authorized.
MANDATORY: commit (WIP allowed) at every phase boundary; a sleep/API cut then loses at most one phase. Third failed attempt=>STUCK exacterror, no silent loop. Stop with actual HOLD if intent/conflict needs user decision.
Use all relevant skills/tools/MCP/workflows at full capability for source-backed architecture proposal. Read/Bash/git/rg, structured JSON parsing, anonymous official HTTP retrieval, Edit/apply_patch authorized. No extra workers, plan mode, changes outside sole document or live installation.

## HOLD inject protocol
ACTUALLY execute after commit at phase boundary or blocker:
telepty inject --ref --submit --submit-force --from pi1149-architect {{ORCHESTRATOR_REPORT_TARGET}} "HOLD: pi1149 | task: #1149 | phase: public installation proposal | needs: proposal review and any explicit product decision; no implementation authorized"
Every HOLD/REPORT uses durable --ref. Silent markdown is not delivery. If inject fails preserve REPORT-pi1149.md and retry once at next boundary.

## REPORT
MANDATORY after commit ACTUALLY execute:
telepty inject --ref --submit --submit-force --submit-retry 2 --from pi1149-architect {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: pi1149-PROPOSAL | task: #1149 | file: docs/proposals/2026-09-10-public-install-onboarding.md | include SHA/main currentness, actual registry/source evidence and URLs, recommended public journey, existing-vs-proposed commands, prioritized gaps with existing task owners, decisions; no install/runtime/release performed"

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
SAWP envelope/table above verbatim. Architect owns design only; no code/build/test/runtime. All load-bearing requirements and definitions inline; no external rule lookup needed.

## Snyk
N/A docs-only. No executable first-party changes; do not claim a scan on documentation clears ecosystem security.

## Boundary
No package/source/config/auth modifications, private-state copying, self/other-session cleanup, auto-services, profile/default changes, paid requests, publication, remote pushes, all-repo install or destructive operations. Source/registry read-only does not establish clean-install success. Any speculative command MUST be labeled PROPOSED and separated from verified current entrypoint syntax.

