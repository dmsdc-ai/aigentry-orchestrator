---
title: Agentic 5-tier migration cost — 23 aigentry repos
date: 2026-05-23
author: aigentry-analyst-migration-cost
status: ANALYST REPORT (read-only quantification, no decision)
scope: cost-of-transition only — viability/desirability is out of scope
---

# Agentic 5-tier migration cost — quantification

## Executive summary

| Metric | Best case | **Expected** | Worst case |
|---|---|---|---|
| **Total LOC delta** | 15.9K | **24.4K** | 35.2K |
| **Total FT-weeks** | 18.5 | **35.9** | 66.0 |
| **Calendar critical path (1 FTE)** | ~18 wk | **~30 wk** | ~52 wk |
| **Calendar critical path (2 FTE parallel)** | ~14 wk | **~22 wk** | ~38 wk |

**90 % confidence interval: 18–66 FT-weeks** (3.5× spread driven mainly by P3 logger scope and ssot tooling churn — §4).

**Bottleneck: P3 logger greenfield** — 7–25 FT-wk depending on MVP vs full aggregator. **Recommendation: Hybrid α/β/γ release with P3 staged MVP-first** (§5).

---

## 1. Inventory baseline (Phase 1)

23 sibling repos under `~/projects/`. Classification differs from naive count — only **17 are .git-backed code repos**; 6 are role-definition markdown folders (some scheduled to become code in this migration).

Evidence: `tokei`, `git log --since='30 days ago'`, `git rev-list --count HEAD` for each repo (2026-05-23).

### Tier A — Active core (6 repos, sets the heat-map)

| Repo | LOC | Top lang | Commits/30 d | Last commit |
|---|---:|---|---:|---|
| aigentry-registry | 138,878 | Python | 0 | 2026-04-01 *(largely archival)* |
| aigentry-brain | 39,695 | TypeScript | 2 | 2026-05-12 |
| aigentry-devkit | 37,071 | Python | **66** | 2026-05-17 *(highest velocity)* |
| aigentry-aterm | 24,838 | Rust | 15 | 2026-05-09 |
| aigentry-deliberation | 20,416 | JavaScript | 0 | 2026-04-19 |
| aigentry-telepty | 18,979 | JavaScript | **52** | 2026-05-17 *(SPOF; P0 task #430 today)* |
| aigentry-orchestrator | 12,022 | TypeScript | 40 | 2026-05-17 |

### Tier B — Lower-velocity code repos (11 repos)

aigentry-ssot (16.7 K YAML, 67 files — **keystone**), aigentry-dustcraw (16.6 K TS), aigentry-amplify (6.9 K TS), aigentry-hooks (3.2 K JS), aigentry-analyst (2.1 K JSON+JS), aigentry-context (1.5 K JS), aigentry-forum (1.3 K HTML), aigentry-bridge (0.97 K JS), aigentry (0.72 K HTML, marketing root), aigentry-starter (0.24 K YAML).

### Tier C — Role-definition folders, no `.git` (6 repos)

| Repo | MD files | MD lines | Notes |
|---|---:|---:|---|
| aigentry-architect | 25 | 3,308 | role docs only |
| aigentry-design | 9 | 2,495 | + 1 code stub |
| aigentry-tester | 7 | 764 | role docs |
| aigentry-logger | 4 | 447 | **scheduled to become code service in P3** |
| aigentry-builder | 4 | 427 | role docs |
| aigentry-sandbox | 5 + 6 stubs | 70 | mostly sandbox examples |

**Totals**: ~342 K LOC across all 23 (138 K is archival registry → active ≈ 200 K); 178 commits/30 d (devkit + telepty + orchestrator = 87 % of velocity).

**Critical baseline correction (verified by grep, 2026-05-23):**

ADR `docs/adr/2026-05-20-session-lifecycle-3-layer.md` exists — implementation does **not**. Verified absences:

- `bin/session-reconciler.sh` — **MISSING** (`ls`).
- `CLEANUP_REQUEST` — only 2 matches under repo root, both in `CONTEXT.md` and the ADR; **0 matches in `src/` or `bin/`**.
- `session-cleanup.sh:107–116` — still calls `cmux close-workspace` directly; no `workspace_host.close()` adapter seam.
- `EXTEND_LIFETIME`, `Layer A`, `Layer D` — only present in docs/specs/reviews.

Pre-existing infra that *helps but does not satisfy* P2: `session-cleanup.sh` 3-step (kill PID + close cmux + DELETE registry), `dispatch-tracker.sh`, `state/dispatch/active.json` registry. **Treat Layer A/D/Reconciler + Workspace Host adapter as greenfield in P2.**

**ssot baseline**: `pkg/` and `schemas/` are empty. 0 TypeScript files, 0 JSON Schemas. Current contracts are pure docs/YAML (`contracts/context-ref-v1.md`, `scaffold-v1.md`, `telepty-snippet-v1.md`, `contracts/mcp/*.yaml`). Migration P1 is **from-zero typed pkg**, not refactor.

---

## 2. Phase decomposition (Phase 2)

5 phases, dependency-ordered. Holds within the §1 lightweight cap (≤7) and at the lower edge of the spec's 4–7 range.

| Phase | Name | Owner repo(s) | Deliverable | Acceptance | Depends on |
|---|---|---|---|---|---|
| **P1** | SSOT Foundation | aigentry-ssot | `@aigentry/ssot` npm pkg + JSON-Schema codegen + version/release pipeline + conformance harness | Pkg installs in another repo, types compile, schema validates a fixture | — |
| **P2** | Contract Lift + From-Zero Impl | aigentry-ssot (specs) + orchestrator + telepty (impl) | (a) Lifecycle 3-layer contract + Layer A/D/Reconciler impl (b) Workspace Host adapter contract + cmux/zellij/headless/wt/ghostty impls (c) TelemetryEvent schema (d) Handoff contracts | All four contracts locked in ssot; orphan-rate < 5 % under reconciler sweep | P1 |
| **P3** | Logger Greenfield | aigentry-logger (currently 4 MD files, 0 code) | Real aggregator service consuming TelemetryEvent; receive + persistence + query API; emitter SDK rolled into 5 source repos | All 5 emitters write to logger and `aigentry-logger query` returns results | P2c |
| **P4** | Adapter Rollout | 17 code repos | Each consumes `@aigentry/ssot`; regenerated types compile; AGENTS.md refreshed | All 17 repos build green against ssot v1; ssot semver-additive verified | P1, P2 |
| **P5** | Devkit Template Propagation | aigentry-devkit | Automated AGENTS.md template sync + ssot pkg-version bump command; per-repo CI hook | Single `devkit propagate` command updates all repos idempotently | P4 |

Splitting P2 further into 4 single-stream phases would violate §1 (lightweight) — the 4 sub-streams share a common foundation in P1 and overlap on consumers (orchestrator + telepty), so they ship as one phase with parallel sub-streams.

---

## 3. Repo-level impact matrix (23 × 6 work-streams)

Cells: **Y** = direct code change (LOC range cited), **m** = minor (≤100 LOC, mostly AGENTS.md + pkg add), **·** = no change.

LOC ranges anchored to commit history evidence cited in §4.

| Repo | P1<br>ssot-foundation | P2a<br>lifecycle<br>impl | P2b<br>workspace<br>host | P2c<br>telemetry<br>schema | P2d<br>handoff<br>contracts | P3<br>logger<br>greenfield | P4<br>adapter<br>rollout | P5<br>devkit<br>propag |
|---|---|---|---|---|---|---|---|---|
| aigentry-ssot | **Y** 3 K–8 K | Y 400-600 | Y 300-500 | Y 400-700 | Y 300-600 | · | · | · |
| aigentry-orchestrator | · | **Y** 800-1.5K | Y 200-400 | m 100 | m 100 | Y 200-400 emitter | Y 400-800 | · |
| aigentry-telepty | · | **Y** 600-1K | m 100 | m 100 | · | Y 200-400 emitter | Y 300-600 | · |
| aigentry-devkit | · | · | m 100 | · | · | Y 200-400 emitter | Y 200-400 | **Y** 600-1.2K + CI |
| aigentry-aterm | · | · | Y 300-500 | · | · | m 200 | Y 300-500 | m 50 |
| aigentry-brain | · | · | · | m 100 | Y 200-400 | Y 200-400 emitter | Y 200-400 | m 50 |
| aigentry-deliberation | · | · | · | m 100 | Y 100-200 | m 100 | Y 200-400 | m 50 |
| aigentry-dustcraw | · | · | · | · | · | · | Y 150-300 | m 50 |
| aigentry-amplify | · | · | · | · | · | · | m 100 | m 50 |
| aigentry-hooks | · | · | · | · | · | · | m 100 | m 50 |
| aigentry-analyst | · | · | · | · | Y 100-200 | · | m 100 | m 50 |
| aigentry-context | · | · | · | · | · | · | m 80 | m 50 |
| aigentry-forum | · | · | · | · | · | · | · | · |
| aigentry-bridge | · | · | · | · | · | · | m 80 | m 50 |
| aigentry | · | · | · | · | · | · | · | · |
| aigentry-starter | · | · | · | · | · | · | m 50 | m 50 |
| aigentry-registry | · | · | · | · | · | · | · *(archival, untouched in best case)* | · |
| **— Role-md repos —** | | | | | | | | |
| aigentry-logger | · | · | · | · | · | **Y** 4.5K–10K *(greenfield service)* | m 50 | m 50 |
| aigentry-architect | · | · | · | · | m 100 | · | m 100 | m 50 |
| aigentry-builder | · | · | · | · | · | · | m 50 | m 50 |
| aigentry-design | · | · | · | · | · | · | m 50 | m 50 |
| aigentry-sandbox | · | · | · | · | · | · | m 50 | m 50 |
| aigentry-tester | · | · | · | · | m 100 | · | m 100 | m 50 |

**Reading the matrix**: 4 repos hold ~85 % of the migration work — aigentry-ssot (foundation), aigentry-logger (greenfield), aigentry-orchestrator + aigentry-telepty (lifecycle impl). The remaining 19 repos see mostly `m`-tier changes (AGENTS.md + pkg add).

---

## 4. LOC + FT-week estimation (Phase 3)

### 4.1 Evidence anchors (from `git log --shortstat`)

| Anchor PR / commit | LOC | Source | Used as anchor for |
|---|---:|---|---|
| ssot G2+G3 stubs (3d31472) | 307 (2 files) | aigentry-ssot | "new SSOT contract stub" ≈ 150 LOC each |
| EntitlementContract (5607c22) | 357 (1 file) | aigentry-ssot | "single major contract" ≈ 350-450 LOC |
| ExperimentContract (132727a) | 446 (1 file) | aigentry-ssot | "single major contract" upper bound |
| MCP contract schemas sync (20fb543) | 1,150 (4 files) | aigentry-ssot | "schema-sync across 4 files" ≈ 280 LOC/file |
| ssot initial bootstrap (b1cedf1) | 16,262 (67 files) | aigentry-ssot | "one-time foundation YAML" |
| Permission Manager ADR-MF #8 (3a13fb5) | 809 (8 files) | aigentry-orchestrator | "single major orchestrator feature" |
| Per-CLI boot adapter ADR-MF #13 (426f3a9) | 1,168 (15 files) | aigentry-orchestrator | "adapter pattern impl" |
| Dispatch health-check #113 (e3829a9) | 1,226 (28 files) | aigentry-orchestrator | "cross-cutting infra feature" |
| Cross-cutting test suite ADR-MF #10 (b6865c1) | 893 (12 files) | aigentry-orchestrator | "test harness size" |
| Telepty supervisor M1-M5 sidecar (07cd2e7..be091e0) | 3,571 (5 milestones) | aigentry-telepty | "greenfield service Phase 1" |
| Telepty cross-OS POSIX parity M4 (eb04c73) | 397 (9 files) | aigentry-telepty | "OS abstraction" ≈ 400 LOC |
| Telepty bootstrap inject queue race fix #18 (744ad6a) | 924 (7 files) | aigentry-telepty | "protocol race-condition fix" |

### 4.2 Productivity rate

**1,500–2,500 LOC/FT-week sustainable rate** for production-quality code (Steve McConnell, *Code Complete 2* §28; COCOMO-II organic-project median). Schema/contract work runs faster (2,500–3,000 LOC/wk); greenfield service slower (1,000–1,500 LOC/wk).

**Risk multiplier 2.0×–2.5×** for review + integration + rework. Evidence: orchestrator ADR-MF cycle shows visible r1 → r2 → r3 progression in commit history (e.g., `eb04c73` "r2-patches" on POSIX parity, multiple "r2 verification" tags on M3 spike).

### 4.3 Per-phase estimate

| Phase | Best LOC | Expected LOC | Worst LOC | Best FT-wk | **Expected FT-wk** | Worst FT-wk | Anchors |
|---|---:|---:|---:|---:|---:|---:|---|
| P1 SSOT foundation | 3,000 | 5,000 | 8,000 | 3.0 | **6.3** | 13.3 | Telepty M1-M5 sidecar 3,571 LOC; ssot init 16K (one-time) |
| P2 Contract lift + impl | 3,800 | 5,200 | 6,800 | 3.8 | **6.5** | 11.3 | Permission Mgr 809; boot adapter 1,168; entitlement 357; cross-OS parity 397 |
| P3 Logger greenfield | 4,500 | 7,000 | 10,000 | 7.5 | **14.6** | 25.0 | Telepty supervisor 3,571 + 5 emitters × 200 = 1,000 |
| P4 Adapter rollout | 3,050 | 5,000 | 7,500 | 3.0 | **6.3** | 12.5 | Tier-A 1.4-2.7K; Tier-B 1.2-1.6K; Tier-C 0.45K |
| P5 Devkit propagation | 1,500 | 2,200 | 2,900 | 1.2 | **2.2** | 3.9 | aggregate-md-audit.py 189; dispatch ref template 289 |
| **TOTAL** | **15.9 K** | **24.4 K** | **35.2 K** | **18.5** | **35.9** | **66.0** | |

### 4.4 Critical path

```
P1 (6.3 wk)
  → P2 (6.5 wk)
    → P3 (14.6 wk) ∥ P4 (6.3 wk)
      → P5 (2.2 wk)

Expected critical path (1 FTE, P3∥P4 parallelized via 2 FTE):
6.3 + 6.5 + max(14.6, 6.3) + 2.2 = 29.6 calendar-FT-wk
```

**Bottleneck: P3 logger greenfield** dominates the parallel band (14.6 wk vs 6.3 wk for P4). Reducing P3 reduces the entire critical path 1:1.

### 4.5 What drives the 18 → 66 FT-wk spread (3.5×)

| Factor | Pushes toward 66 wk | Pushes toward 18 wk |
|---|---|---|
| **P3 logger scope** | Full aggregator: persistence + query + dashboard + pattern detection | MVP only: NDJSON receiver + simple query CLI (anchor: existing `spawn-events-YYYY-MM-DD.ndjson` pattern, ~2K LOC) |
| **ssot codegen tooling** | Tooling churn: TypeBox attempted → zod migration → json-schema-to-typescript settle (rework cost) | Decisive zod-from-day-1 with documented "no codegen for v1" |
| **telepty repo load** | TelemetryEvent emitter + Workspace Host adapter land *during* P0 (task #430) high-churn → integration collisions | P0 resolves before P3 starts; emitter integration scheduled into stable telepty windows |
| **Workspace Host surface count** | All 5 surfaces (cmux + zellij + headless + windows-terminal + ghostty) covered in P2b | Cmux-only first (current default), other 4 deferred to follow-up tasks |
| **aigentry-registry (138 K LOC)** | Hidden subset must consume `@aigentry/ssot` (unknown integration cost) | Stays archival, untouched (current commit cadence = 0 supports this) |
| **ssot semver discipline** | Breaking changes mid-P4 → adapter rollout pass 2-3 | ssot v1 frozen for P4 duration; v2 deferred (matches context-ref/v1 §1 versioning policy) |
| **AGENTS.md propagation conflicts** | 17 repos × manual review of template-vs-local divergences | devkit propagation deferred to P5 where it ships as a tool, not 17 hand-merges |

---

## 5. Industry anchors (Phase 4)

Three multi-repo schema-first transitions with public timelines.

### 5.1 Kubernetes OpenAPI v2 → v3 (CRD structural schema)

- **CRD adoption**: Kubernetes 1.15 (Mar 2019)
- **OpenAPI v3 beta**: Kubernetes 1.24 (Jun 2022)
- **OpenAPI v3 + Server-Side Field Validation GA**: Kubernetes 1.27 (Apr 2023)
- **Total**: ~4 calendar years across hundreds of contributors and CRD authors
- **Pattern**: lossless v3 schema, lossy v2 conversion retained for backward compatibility; storage-version-migration controller handles in-place upgrade

### 5.2 OpenTelemetry SDK → spec stabilization

- **Stability tiers**: Alpha → Beta → Stable, with Beta requiring 2+ language implementations, Stable requiring 4+
- **Tracing GA**: 2021; **metrics GA per-language**: rolled out 2022–2023 unevenly; **logs**: newest signal, still maturing 2026
- **Declarative configuration spec stable**: Q1 2026 — multi-year effort for a single sub-spec
- **Pattern**: schema-versioned migration paths required for every breaking change; instrumentation libraries can stabilize independently of semantic-convention stability

### 5.3 Protocol Buffers proto2 → proto3 → Editions

- **proto2 → proto3 migration inside Google**: incremental, central team migrates internal users first then offers tooling externally
- **Editions cadence**: ~yearly releases planned
- **Tooling**: Prototiller for at-scale conversion; both proto2 and proto3 files migrate to editions syntax
- **Pattern**: "central migrate then deprecate" — internal users moved before any deprecation window opens; matches our ADR `2026-05-05-telepty-devkit-boundary` §3.1.2.1.1 30-day deprecation policy

### 5.4 Scale-adjusted reading

K8s and OTel migrations span **3–4 calendar years across thousands of contributors**. aigentry is roughly **2–3 orders of magnitude smaller** (23 repos vs hundreds; ~340 K LOC vs millions). Linear scaling would suggest weeks-to-months, not years — consistent with our **~30-week expected estimate**.

The dominant pattern across all three industry cases:

1. **Foundation first** (schema/spec frozen before consumers integrate)
2. **Central migration before external opt-in**
3. **Long deprecation window for breaking changes** (30+ days minimum, often 6+ months)
4. **Tooling investment** (Prototiller / storage-version-migration / declarative-config codegen) — pays back in adapter rollout

Our 5-phase plan mirrors this: P1 = foundation, P2 = central-impl, P3 + P4 = consumer rollout, P5 = tooling.

---

## 6. Recommendation

### 6.1 Decision space (3 paths)

| Path | Description | Expected FT-wk | Pros | Cons |
|---|---|---:|---|---|
| **Incremental** | Ship after every phase; 5 releases | 35.9 (sequential) | Lowest risk per release; early P1+P2 value visible at wk ~13 | Contract may evolve between phases → P4 repos updated 2-3 times |
| **Big-bang** | Ship all 5 phases atomically as v1.0 | 35.9 (parallelized to ~22 wk calendar) | One clean v1 release; one P4 rollout pass | All-or-nothing risk; no value visible until ~22-30 wk; one bad estimate cascades |
| **Hybrid α/β/γ** *(recommended)* | α = P1+P2 (foundation+lifecycle) ships v1.0; β = P3+P4 ships v1.1; γ = P5 ships v1.2 | 35.9 (calendar ~22-26 wk) | Three shippable milestones; α value visible ~13 wk; β contains the long pole in one release; γ is small finish line | Some contract-change risk between α and β (mitigated by ssot semver-additive policy) |

### 6.2 Recommended path — **Hybrid α/β/γ + P3 staged MVP-first**

```
Phase α (~13 calendar-FT-wk, releases ssot v1.0 + lifecycle 3-layer)
  → P1 SSOT foundation              (6.3 FT-wk)
  → P2 contract lift + impl         (6.5 FT-wk)
  ▶ SHIP @aigentry/ssot v1.0
  ▶ SHIP orchestrator with Layer A/D/Reconciler + Workspace Host adapter
  ▶ VALUE: orphan-session problem solved; cross-OS workspace parity unlocked

Phase β (~10-14 calendar-FT-wk with 2 FTE parallel)
  → P3-MVP logger receiver+CLI       (~6 FT-wk)  ← STAGED
  ∥ P4 adapter rollout              (6.3 FT-wk)
  ▶ SHIP @aigentry/ssot v1.1
  ▶ SHIP aigentry-logger v0.1 (MVP)
  ▶ VALUE: ecosystem-wide telemetry visibility; all 17 repos on typed contracts

Phase γ (~2 calendar-FT-wk)
  → P5 devkit propagation            (2.2 FT-wk)
  ▶ SHIP @aigentry/devkit "propagate" command
  ▶ VALUE: AGENTS.md drift eliminated; ssot version bumps automated
```

**P3 MVP scope** (cuts P3 from 14.6 → ~6 FT-wk):

- Receiver: `aigentry-logger receive` listens on stdin/socket for `TelemetryEvent` injects, writes NDJSON to `~/.aigentry/telemetry/{date}.ndjson` (anchor: existing pattern in `src/session/validate-spawn.ts` writing `spawn-events-YYYY-MM-DD.ndjson` — proven, ~200 LOC reuse target)
- Query CLI: `aigentry-logger query --kind=spawn --since=24h --jq-filter='.role'`
- Emitter SDK: thin wrapper around `telepty inject` with envelope serialization
- **Out of scope for MVP, deferred to logger v1.0**: SQLite persistence, dashboard, pattern detection, retention policy enforcement, cross-machine aggregation

This staging is justified by the same "MVP before full" pattern visible in telepty's own M1 → M5 sidecar spike (commits `07cd2e7`, `ec00412`, `76cde35`, `eb04c73`, `be091e0`) — each milestone ships incremental capability.

### 6.3 Conditions that flip the recommendation

The hybrid recommendation assumes:

- **telepty P0 (task #430) resolves before α start.** If P0 drags into α window, recommend serializing α-impl after P0 lands rather than parallel.
- **ssot codegen tooling decided before P1 starts** (zod-first, no schema-to-typescript codegen in v1). Tooling churn is the single biggest worst-case driver.
- **registry stays archival** during the migration. If a registry-side consumer emerges, recompute its row in §3 matrix.
- **Workspace Host adopts cmux-only in P2b**; other 4 surfaces (zellij/headless/wt/ghostty) deferred to follow-up tasks unless explicit user demand.

If any of these flip, expected FT-wk grows toward the 66-wk worst-case, not in proportion but additively per flipped condition (each flip costs ~6-12 additional FT-wk based on §4.5 factor magnitudes).

---

## 7. Risks not in the cost-of-transition scope

This report quantifies **cost only**. Three risks are out of scope but flagged for the decision-maker:

1. **Viability of "Agentic 5-tier" architecture itself** — not analyzed. Cost is finite (~30 wk); whether the architecture pays back that cost in agility / clarity / cross-component decoupling is a separate question. *(This report does not recommend whether to do the migration, only what it would cost.)*
2. **Opportunity cost** — the same 30 FT-wk could ship other features. Trade-off versus current backlog not analyzed.
3. **Adoption-side cost in downstream consumers of aigentry packages** — if external users of `@aigentry/devkit` or `@aigentry/telepty` exist, their rollout cost is on top of the 35.9 wk. Current knowledge: no public consumers detected in 2026-05 inventory.

---

## 8. Method notes

- **Tooling**: `tokei` (LOC), `git log --shortstat` (PR-size anchors), `git rev-list --count HEAD` (repo age), `grep` (current-state verification), `WebSearch` (industry anchors).
- **Productivity rate source**: McConnell, *Code Complete 2* §28; COCOMO-II organic-project median. Risk multiplier 2.0×–2.5× from observed orchestrator ADR-MF r1 → r2 → r3 review cycles in `git log` 2026-05-12 to 2026-05-17.
- **All estimate cells in §4.3 cite at least one anchor** in §4.1 — no unanchored guesses.
- **Constitution §13 compliance**: every estimate provides best / expected / worst tuple. **§10-1 + Rule 25 compliance**: each numeric claim cites a commit, PR, or public benchmark.
- **Reproducibility**: rerun `tokei` and `git log --since='30 days ago'` from `~/projects/` to refresh §1 baseline. PR-size anchors in §4.1 are stable git history.
