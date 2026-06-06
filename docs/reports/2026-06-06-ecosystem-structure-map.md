---
status: reference
date: 2026-06-06
purpose: Baseline ecosystem structure map for a future major overhaul + analysis (orchestrator-maintained)
evidence: Constitution §3 component table (../aigentry/docs/CONSTITUTION.md) + 24 repo descriptions (README/package.json/AGENTS.md) + 2026-06-06 feasibility inventory
---

# aigentry Ecosystem Structure Map (baseline)

> Captured 2026-06-06 at the user's request — they expect a **major ecosystem overhaul** and want this as the baseline + the analysis agenda for that future work. This is a reference snapshot, NOT a redesign. The overhaul ANALYSIS is deliberately deferred (see §6) and should be run as a multi-agent architect-led audit when triggered.

## 1. Design philosophy (Constitution)
aigentry is designed as an **organism for AI agents** (생물학 비유, 헌법 §3). Product line: **aigentry = "Sovereign Brain OS for AI Agents"** — a meta package that installs the whole ecosystem.
Governing principles: §3 역할(1 component = 1 role, no encroachment) · §9 독립(each works standalone) · §15 SSOT(contract changes registered) · §2 크로스(same UX across CLI/OS/machine).

## 2. Complete component inventory (24 repos, evidence-grounded)

### Core components (Constitution §3 — biology metaphor)
| repo | metaphor | role | never does |
|------|----------|------|-----------|
| aigentry-orchestrator | 지휘자 conductor | direct/delegate, session coordination | code impl/analysis/debug — only design/spec/plan/CLAUDE.md |
| aigentry-telepty | 신경계 nervous system | cross-layer: session/machine/OS connect, PTY broker, inject | UI render, memory store |
| aigentry-brain | 기억 memory | context/profile/settings sync into one context | session mgmt, event delivery |
| aigentry-deliberation | 두뇌 cognition | semantic control, multi-AI debate, consensus (MCP) | data store, session delivery |
| aigentry-dustcraw | 감각기관 senses | autonomous crawling, feedback loop, sensory data | decisions, memory mgmt |
| aigentry-registry | 면역계 immune | experiment tracking, agent trust grading, evolution | session mgmt, crawling |
| aigentry-devkit | 골격계 skeleton | install, skills, templates, dev tools | runtime features |
| aigentry-amplify | 증폭기 amplifier | content gen, multi-channel distribution, marketing | core feature impl |
| aigentry-aterm | 눈/귀/손 I/O | lightweight access point, user↔ecosystem endpoint | session mgmt, memory, AI judgment |

### Contract / shared layer (Interface Authority)
| repo | role |
|------|------|
| aigentry-ssot | Single Source of Truth — build-time contract authority (SEMVER.md); everyone depends on it |
| aigentry-logger | passive TelemetryEvent NDJSON aggregator (receiver + query CLI + emitter SDK); ssot coupling is type-only |

### Cross-CLI infrastructure (claude/codex/gemini parity — §2)
| repo | role |
|------|------|
| aigentry-bridge | Universal AI CLI remote-control SDK (headless/StructuredIO, programmatic agent control) |
| aigentry-hooks | Universal AI CLI middleware (intercept/log/approve/block tool execution) |
| aigentry-context | context compression & projection engine (HISTORY_SNIP) |

### Role-session projects (workers; devkit distributes the 9 role contracts in ~/.aigentry/instructions/roles/)
| repo | role | (contract-only roles, no dedicated repo) |
|------|------|------|
| aigentry-analyst | runtime root-cause analysis (past) | coder, logger, researcher, reviewer, (orchestrator) |
| aigentry-architect | design analysis / ADR / 위헌심사 (future) | |
| aigentry-builder | build/run/deploy | |
| aigentry-tester | test execution + TC accumulation | |

### Product faces & support
| repo | role |
|------|------|
| aigentry | meta umbrella "Sovereign Brain OS" — installs entire ecosystem + holds the Constitution |
| aigentry-forum | PUBLIC product face of deliberation — "Where AIs Debate, Consensus Emerges" (auditable AI decisions) |
| aigentry-design | design 전담 — all UI/UX, branding, visual assets (aterm UI etc.) |
| aigentry-sandbox | isolated test environment, fully independent of production/publish |
| aigentry-starter | starter workspace template (`aigentry setup` → ready-to-use project) |

### Terminal surfaces
| repo | role |
|------|------|
| cmux | terminal multiplexer (Electron+Swift+ghostty) — current active surface; orchestrator drives via workspace-host adapter |
| aigentry-aterm | aigentry's own terminal (the §3 aterm access point) |

## 3. Organism view
```
사용자 → aterm(눈/귀/손)·cmux → telepty(신경계) → orchestrator(지휘자)
  ├─ spawn → Role 세션(analyst/architect/builder/coder/tester/logger/researcher/reviewer)
  ├─ ≥3 병렬 → deliberation(두뇌: 충돌감지/합의)  ── 공개 제품화: forum
  ├─ 다음태스크 ← dustcraw(감각: 크롤링/피드백)
  └─ 컨텍스트/기억 ↔ brain(기억)
support: ssot(계약 SoT) · logger(telemetry) · bridge/hooks/context(크로스-CLI) · registry(면역) · amplify(증폭) · devkit(골격: 전체 설치) · design(UI) · sandbox(격리테스트) · starter(템플릿)
```

## 4. Runtime flow (ties to orchestrate-turn sequence, codified 2026-06-06)
user → orchestrator(컨텍스트 확정) → work-breakdown/task-queue → dispatch.sh(--role, boot-prepare role-sandbox, open-session, workspace-host cmux 어댑터) → worker runs on role contract + ssot contracts + logger telemetry → (≥3) deliberation → REPORT(telepty push + reconciler pull-AUTO_REPORT) → review → session-cleanup(telepty + cmux 양쪽) → propose-next-task/dustcraw feed. Deploy: devkit installs everything (#518 `--profile orchestrator` one-click — feasibility-verified 2026-06-06).

## 5. Known debt / integration gaps already surfaced (2026-06-06 session)
- **#518** devkit `--profile orchestrator` not yet built (orchestrator env not one-click installable). Feasibility=YES/MEDIUM.
- **#520** `@aigentry/logger`+`ssot` are `file:` sibling deps, NOT npm-published → blocks public install. Decided A1 (create @aigentry org).
- **#519** instructions source/installed divergence + 8 role contracts missing from source (fixed; landed).
- **#522** pre-existing test reds (T23/T26/T28) since cmux-adaptor merge.
- **#521** devkit template-skills not actually distributed (npm-excluded, manual symlink).
- telepty mixed-version death-zone; orphan session accumulation (largely fixed: #517/#523/#524/#525).

## 6. Analysis agenda for the FUTURE major overhaul (deferred — run as architect-led multi-agent audit)
When the user triggers the overhaul, an architect-led workflow should audit these dimensions across all 24 repos:
1. **§3 role-encroachment audit** — does any component do another's job? (e.g. forum vs deliberation boundary; amplify scope; orchestrator drifting into impl).
2. **§9 independence** — can each component truly run standalone? Map the actual hard dependencies (esp. ssot/logger `file:` coupling, brain/context overlap).
3. **Redundancy / consolidation** — forum⊂deliberation? context vs brain (both touch context/memory)? bridge vs hooks vs telepty (cross-CLI control overlap)? candidates to merge.
4. **Contract/SSOT coverage (§15)** — which inter-component contracts are NOT in ssot? versioning/publish strategy (ties #520).
5. **Cross-CLI parity (§2)** — telepty/bridge/hooks coverage for claude vs codex vs gemini; gaps.
6. **Distribution/installability (§ devkit)** — devkit coverage of every component (ties #518/#521); one-click public path.
7. **Dependency graph + circular-dep / build-order** — full repo dependency DAG; npm-publish vs vendor strategy ecosystem-wide.
8. **The 4 thin repos** — design/sandbox/starter/forum maturity + whether they're load-bearing or aspirational.

> Recommended method when triggered: multi-agent Workflow — parallel readers (1 per repo or per dimension) → dedup → architect synthesis → ADR(s). Do NOT run inline; it spans the whole ecosystem.
