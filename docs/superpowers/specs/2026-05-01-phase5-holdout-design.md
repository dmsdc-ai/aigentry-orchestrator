---
status: ready (pre-fire — fixture set approved 2026-05-01, awaiting pre-reg tag commit)
date: 2026-05-01
topic: phase5-holdout-design
track: "#329 E27 Phase 4 → Phase 5 — α-step-11 holdout (Rule 4-A Step 4 verification)"
phase: spec only — execution gated on (a) ADR 2026-05-01 Acceptance, (b) pre-Phase-5 analyst U2 recompute (condition 6), (c) Phase 5 pre-reg tag commit
related:
  - Sibling ADR (this commit): docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md
  - Predecessor spec: docs/superpowers/specs/2026-04-26-phase4-final-analysis-spec.md
  - Predecessor plan: docs/plans/2026-04-22-phase4-plan.md (§2.3 holdout shape, §7 success criteria)
  - Final analysis report: ~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md
  - Codex review: ~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-codex.md
  - Gemini review: ~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-gemini.md
  - Predecessor pre-reg tag: exec-mode-v4-replication-preregistered-20260426 (devkit commit 26f8cc4)
constitution_rules: [Rule 1 경량, Rule 2 크로스, Rule 5 최선, Rule 13 비판적+건설적+객관적]
---

# Phase 5 Holdout Spec — α-step-11 (Rule 4-A Step 4 verification)

## §1 Goal

Validate Phase 4 conclusions on **5 NEW holdout fixtures** (held out from the Fa + F2–F10 set used in Phase 3/4):

1. **Confirm Preuse-clear ≈ S** as the best chain modes, beating Pacc by a wide margin (per ADR 2026-05-01 §3.2 — Δq = +0.572, d = 1.95 against Pacc on Phase 4b).
2. **Adjudicate the PC ≈ S U2 tie** on a fresh fixture set (per Codex condition 3, Gemini condition 5 — survivorship-bias avoidance).
3. **Optionally sanity-check substitute-compact** at a revised hyperparameter cut (per Gemini condition 7 — mechanism deferred, not deprecated).
4. **Trigger Full Policy Lock or Supersede** on Rule 4-0 (per Phase 4 plan §7 line 132–135 success criteria).

Phase 5 is the **last gate** between Narrow Lock (current) and Full Policy Lock for Rule 4-A.

This spec is written **before** any holdout trial fires — fixture set, modes, seeds, success criteria, and decision tree are pre-declared to prevent post-data rationalization (Constitution Rule 13 객관적).

---

## §2 Scope

### 2.1 Trial budget

| Dimension | Value | Rationale |
|---|---|---|
| Fixtures | **5 (NEW, held out from Fa + F2–F10)** | Held-out generalization per Phase 4 plan §2.3 |
| Modes | **6** (5 carry-over + 1 revised-cut substitute-compact, see §3) | Condition 5 (gemini) requires PC + S; condition 7 (gemini) flags single revised substitute-compact arm for hyperparameter sanity |
| Seeds | **10 per (mode, fixture)** | Matches Phase 4c seed budget (`MASTER_SEED=42 + mode_offset` deterministic shuffle) |
| **Total trials** | **5 × 6 × 10 = 300** | Matches Phase 4 plan §2.3 holdout shape |

### 2.2 Out of scope

- Phase 3 fixture re-grading (separate analyst follow-up, not Phase 5).
- Layer 2 (Codex/Gemini) portability of Preuse-clear (separate ADR; Q2/Q4 tracker).
- Cross-CLI substitute-compact-v1 implementations (V3 PASS already confirmed Claude implementation; cross-CLI is future scope).
- Mixed-effects modeling on Phase 4 alone (analyst follow-up; Phase 5 spec recommends combined Phase 4 + Phase 5 dataset run, see §6.4).

---

## §3 Mode set

### 3.1 Default 6-mode set

| # | Mode | Carry-over from | Notes |
|---|---|---|---|
| 1 | **D** | Phase 4b | Non-chain dispatch; baseline anchor |
| 2 | **Pacc** | Phase 4b | Chain accumulation; Phase 4 reference for "what we are replacing" |
| 3 | **Pfresh** | Phase 4b | Chain warmup-replay; documented mode |
| 4 | **S** | Phase 4b | Subagent / Task-tool chain; tie-pair with PC (condition 5) |
| 5 | **Preuse-clear** | Phase 4c | Activation candidate (ADR 2026-05-01 §2.1) |
| 6 | **Preuse-substitute-compact-revised** | NEW (Phase 5) | Single arm at architect-determined revised cut (condition 7); see §3.2 |

**Total**: 6 modes. Any divergence from this 6-mode set requires a spec amendment before pre-reg tag commits.

### 3.2 Substitute-compact revised arm (per condition 7 — gemini)

Phase 4c tested 4 truncation cuts: C1=10k, C2=50k, C3=100k, C4=150k. All clustered around Pacc (Δq within ±0.020, p ≥ 0.56). Per gemini §3 P6 (`docs/reviews/2026-05-01-phase4-final-analysis-review-gemini.md:41`), this is plausibly a hyperparameter design failure (cut levels), not a mechanism failure (V3 byte-equality PASS — devkit commit `26f8cc4`).

**Phase 5 includes 1 revised-cut substitute-compact arm** as a hyperparameter sanity check. Cut selection rules (architect-determined before pre-reg tag):

- **Option A (preferred)** — percentile-anchored from Phase 3 transcript-size distribution per Phase 4 plan §5 P4-pre-2: e.g., the median (p50) cut between consecutive Pacc-chain turns. Anchors the cut on observed cumulative-input distribution rather than round-number guesses.
- **Option B** — geometric midpoint between C2 (50k) and C3 (100k): e.g., 70k or 75k. Simpler; explores between-arm gap.
- **Option C** — substantially smaller than C1: e.g., 5k or 2.5k. Tests whether more aggressive truncation reduces context-rot interference.

**Selection authority**: architect (this session) defers to a separate sub-decision — committed to Phase 5 spec as an addendum before pre-reg tag commits. Decision rationale must cite either (a) Phase 3 transcript-size analysis (Option A), (b) gap-coverage logic (Option B), or (c) hypothesis on context-rot threshold (Option C). Default if undecided: **Option A with median (p50) cut** — minimum-assumption, data-anchored.

### 3.3 Modes explicitly NOT in Phase 5

| Mode | Why excluded |
|---|---|
| Preuse-substitute-compact-C1 / C2 / C3 / C4 | Phase 4c rejected as defaults (ADR 2026-05-01 §2.3); revised cut covers hyperparameter question without re-running 400 dead-arm trials. |
| Other Preuse variants (e.g., partial-clear, summary-clear) | Mechanism not in substitute-compact-v1 spec; future Phase 6+ scope. |

---

## §4 Fixture selection criteria

### 4.1 Hard rules (non-negotiable)

1. **NEW fixtures** — none of {Fa, F2, F3, F4, F5, F6, F7, F8, F9, F10}. Any reuse is a pre-reg violation.
2. **Grader extensions permitted PRE-tag, frozen POST-tag** — fixtures may require new `score_h*_*` functions (preserving the existing `score_fX(agent_output, ground_truth) -> dict` contract). All grader code edits MUST commit BEFORE the pre-reg tag; the tag SHA freezes grader. NO post-tag grader edits (Rule 13 객관적 — prevents adjusting grader to outputs after seeing trials). [r2 amend 2026-05-01: original constraint "no new grader code commits to qualify" was internally inconsistent with §4.2 (5 NEW domains) — runner-phase5 STUCK report identified this; orchestrator amends to permit pre-tag extensions.]
3. **Difficulty mix** — at least 1 easy (Phase 3 D-mode q ≥ 0.85 expected), 1 medium (q ∈ [0.4, 0.85]), 1 hard (q < 0.4 expected). Avoid all-easy or all-hard sets.
4. **Domain coverage** — minimum 3 distinct task domains. Avoid "5 retrieval-citation fixtures" — Phase 3/4 set already saturates that domain.

### 4.2 Approved 5-fixture set (user signoff 2026-05-01)

**User-approved final fixture set** (option β from dustcraw brainstorm `~/projects/aigentry-dustcraw/docs/research/2026-05-01-phase5-fixture-candidates.md`):

| # | id | Domain | Difficulty | Why |
|---|---|---|---|---|
| **H1** | long-form-code-review | Code Review | hard | Stresses long-input chain reuse — PC's claimed strength |
| **H2** | multi-hop-reasoning | Logic/Reasoning | medium | Stresses transcript-rewriting cost — PC's claimed weakness |
| **H3** | multilingual-recall-ko-en | Translation | medium | Domain-shift; Phase 3/4 was English-only |
| **H10** | strict-instruction-following | Instruction Following | easy | Format precision + multi-turn logical constraints; replaces analyst-recommended H4 to maximize PC vs S separation signal (H4 was easy-format-only, expected tie ceiling) |
| **H5** | agentic-tool-use | Tool Use | hard | Tests S vs PC under Task-tool chain interaction (condition 5 adjudication) |

**Difficulty mix**: 1 easy (H10) + 2 medium (H2, H3) + 2 hard (H1, H5). Satisfies §4.1 criterion 3.
**Domain coverage**: 5 distinct domains (Code, Logic, Translation, Instruction Following, Tool Use). Satisfies §4.1 criterion 4.

**Selection rationale (vs analyst recommendation H1-H5)**: H10 replaces H4 because:
- Cascade-(a) U2 Pareto recompute confirmed PC ≈ S statistical tie (`docs/reports/2026-05-01-phase4-u2-pareto-recompute.md`)
- Phase 5 primary purpose = adjudicate the tie (condition 5)
- H4 (json-schema-strict, easy) likely produces tie-ceiling — both PC and S pass → low separation signal
- H10 combines format precision + multi-turn logical constraints → stresses chain mode differences

**Remaining gates** before pre-reg tag commits:
- Devkit grader harness validation (each fixture must pass the existing grader on at least one mode at q ≥ 0.5 in a 1-trial smoke before pre-reg tag).
- Pre-reg tag commit (orchestrator authority, user approval received).

### 4.3 Rejected fixture types

- Fixtures requiring grader code changes (would invalidate pre-reg).
- Fixtures using features not yet in `bin/exec-mode-experiment.sh` (e.g., multi-CLI dispatch — out of Rule 4-0 scope).
- Fixtures with grader brittleness flagged in Phase 3 (e.g., F7-class quality-floor; Phase 5 should not re-litigate Phase 3 grader issues).

---

## §5 Pre-registration tag

### 5.1 Tag spec

- **Name**: `exec-mode-v5-holdout-preregistered-YYYYMMDD` (per Phase 4 plan §4 line 95) — `YYYYMMDD` = commit date of the tag, expected ≥ 2026-05-02 (after analyst U2 recompute completes).
- **Repo**: `~/projects/aigentry-devkit` (same repo as v4 tag).
- **Scope locked by tag**:
  1. Final 5 fixture identifiers (kebab-slug).
  2. 6 mode identifiers (incl. revised substitute-compact arm name and cut value).
  3. Seed list (`MASTER_SEED=42 + mode_offset`, first 10 per arm).
  4. Grader harness commit SHA (frozen; no post-tag grader edits).
  5. `bin/exec-mode-experiment.sh` commit SHA.
  6. substitute-compact-v1 implementation commit SHA (per ADR 2026-04-26-q1-prereq-redesign §4.6).

### 5.2 Tag annotation requirements

The tag annotation must include:

- Pointer to this spec file.
- Pointer to ADR 2026-05-01 §8.3 success criteria (verbatim).
- Pointer to analyst U2 recompute report (per condition 6, see §6.2).
- 4-quadrant decision tree (§7 below) verbatim.
- Pointer to substitute-compact revised-cut sub-decision (§3.2).

### 5.3 Tag authority

- **Author**: orchestrator (`aigentry-orchestrator-claude`).
- **Approver**: user.
- **Pre-conditions** (all must hold before tag commits):
  1. ADR 2026-05-01 status = Accepted.
  2. Analyst U2 recompute (condition 6) report committed and cited.
  3. Architect substitute-compact revised-cut sub-decision (§3.2) committed.
  4. Final 5-fixture set approved by user.
  5. Smoke test: 1 trial per (mode, fixture) cell passes grader at q ≥ 0.0 status="ok" — confirms harness wiring, not quality.

### 5.4 Known-issue acceptance (orchestrator decision T-2, 2026-05-01)

After 3 rounds of grader cross-LLM review (cascade-13b r1 codex+gemini, r2 codex+gemini, r3 codex), 1 over-correction blocker remains as known-issue at pre-reg tag commit time:

- **NB3 (codex r3)**: H5 phantom-tool detection's backtick exemption masks code-formatted numbered-step phantom invocations (e.g., `` 1. `apply_refund(123)` `` flagged as citation, not phantom). Documented at `docs/reviews/2026-05-01-phase5-grader-rubric-review-codex-r3.md` §6.

**Why accepted**:
- Systematic bias: NB3 produces false negatives for **agent output formatting style** (backtick-wrapped numbered-step), NOT for **mode-level differences**. PC and S agents using identical output style would receive identical false negatives → mode comparison preserved (Rule 13 객관적 — bias must be MODE-asymmetric to invalidate ranking).
- Convergence risk: r1 → r2 → r3 each surfaced new over-correction; further iterations risk infinite loop without proportional ROI.
- Phase 5 primary purpose (PC vs S adjudication) is unaffected — both modes treated equally by NB3.

**Risks documented**:
- If PC and S systematically produce DIFFERENT output formatting on H5 (e.g., PC backticks numbered tool calls, S doesn't), NB3 introduces mode-asymmetric bias → Phase 5 H5 results are noisy. Sanity check: post-Phase-5 analyst spot-checks H5 output style across PC vs S; if asymmetric, H5 results downweighted in final analysis.

**Re-open trigger**: any future Phase 5 follow-up (or Phase 6) MUST address NB3 before re-using H5 grader.

Reviews retained at:
- `docs/reviews/2026-05-01-phase5-grader-rubric-review-codex.md` (r1, 4 blockers)
- `docs/reviews/2026-05-01-phase5-grader-rubric-review-gemini.md` (r1, 2 blockers)
- `docs/reviews/2026-05-01-phase5-grader-rubric-review-codex-r2.md` (NB1+NB2 over-correction)
- `docs/reviews/2026-05-01-phase5-grader-rubric-review-gemini-r2.md` (ACCEPT, missed NB1+NB2)
- `docs/reviews/2026-05-01-phase5-grader-rubric-review-codex-r3.md` (NB3, recommend hold; orchestrator overrides per T-2)

---

## §6 Success criteria

### 6.1 Hard gate — grader accuracy

Per Phase 4 plan §7 line 134 (carried into ADR §8.3 line 4):

> "Phase 5 holdout grader accuracy ≥70%."

**Pass**: aggregate grader accuracy across all 300 trials ≥ 0.70. **Fail**: < 0.70 → grader audit (Rule 4-A Step 4.5 escalation path) before any decision-tree branch fires.

### 6.2 Pre-Phase-5 deliverable — analyst U2 recompute (per condition 6 — gemini)

Before pre-reg tag commits, analyst publishes:

- U2 utility scores recomputed with normalization domain restricted to the **Pareto-efficient frontier** (per gemini condition 6, `…review-gemini.md:59`).
- Pareto-efficient set on Phase 4b/4c data: minimally {Preuse-clear, S, Pacc} (analyst §6); architect may include D as borderline.
- Output: U2 ranking with C1–C4 outliers excluded from min-max anchors. Confirms whether PC vs S separates or remains tied.

**Owner**: aigentry-devkit analyst session.
**Output path**: `~/projects/aigentry-devkit/docs/reports/2026-05-XX-phase4-u2-pareto-recompute.md` (new short addendum) OR appended to `2026-04-28-phase4-final-analysis.md` as §12.

### 6.3 Phase 5 separation criteria for PC vs S (per condition 5 — gemini)

PC vs S adjudication on holdout:

- **Statistical separation**: Welch p < 0.05 OR Cohen d ≥ 0.3 across the 5 holdout fixtures aggregated (n = 50 per mode).
- **Per-fixture sanity**: at least 3/5 fixtures show same direction (PC > S OR S > PC).
- **Both criteria** must hold to declare a "Phase 5 winner". Otherwise → tie persists, decision-tree quadrant "PC ≈ S" applies.

### 6.4 Phase 5 mixed-effects analysis (per gemini §4 BS2 follow-up)

Beyond the standard Welch tests, analyst runs a **mixed-effects model** on the combined Phase 4b + Phase 4c + Phase 5 dataset:

- Random intercept: `fixture` (acknowledges paired structure across modes).
- Fixed effects: `mode`, `chain_position` (Pacc/PC/substitute-compact only), `seed`.
- Output: variance components + fixed-effect coefficients with CI.

This addresses the IID-violation blind-spot caught by gemini §4 line 50 (`…review-gemini.md:50`). **Output is informational** for Full Policy Lock decision; it supplements but does not override §6.3.

### 6.5 Per-fixture Pareto frontier (per gemini §4 BS3 follow-up)

Analyst publishes a per-fixture-class Pareto breakdown (separate from mode-aggregate Pareto). Tests gemini §3 P7 hypothesis ("S might strictly dominate on reasoning fixtures while Preuse-clear dominates on retrieval"). **Output is informational**; supplements §6.3.

### 6.6 Anomaly criteria (carry-over from Phase 4 spec §3.2 / OQ-C)

Any holdout fixture with D-mode quality < 0.4 OR > 0.95 is flagged as a difficulty outlier. Either-side outliers do NOT auto-disqualify the fixture; they are noted in the analyst report as candidates for pre-reg-set rebalancing in Phase 6.

---

## §7 Decision tree on Phase 5 outcome

This 4-quadrant tree is **pre-declared**. Phase 5 results map to a single quadrant; quadrant determines next ADR action. (Quadrant definitions reflect SAWP authority: 4-quadrant `PC>S vs PC≈S × hold up vs degrade`.)

```
                      Phase 5 PC and S vs Phase 4b
                      ──────────────────────────────
                      hold up                  degrade (either or both
                      (both q ≥ Phase 4b       drop ≥0.10 absolute or
                       q μ − 0.05)             grader accuracy < 0.70)
                      ─────────────────        ─────────────────────────
                                  │                          │
PC > S                            │                          │
(separation per                   │                          │
§6.3 — Welch p < 0.05      Quadrant Q1                Quadrant Q3
or d ≥ 0.3, ≥3/5            ACTIVATE PC               REJECT Phase 4
fixtures same dir.)         S secondary                ranking;
                            (full lock)                re-run with
                                                       revisions
                                  ──────────────────────────────
PC ≈ S                            │                          │
(no separation —            Quadrant Q2                Quadrant Q4
tie persists)               ORCHESTRATOR-USER           REJECT Phase 4
                            DECISION (default to        ranking;
                            one or other; or          investigate
                            policy: D Layer 2,        grader/fixture
                            S Layer 1 chain,          drift before
                            PC Layer 1 chain          any re-decision
                            hot-failover)
                                  ──────────────────────────────
PC < S                            │                          │
(separation in            Quadrant Q5                Quadrant Q6
opposite direction)        ACTIVATE S                  REJECT Phase 4
                           PC removed from             ranking;
                           default; ADR                same as Q4
                           2026-05-01                  but with
                           SUPERSEDED                  reverse-direction
                           by new ADR                  diagnostic
```

### 7.1 Quadrant Q1 — PC > S, both hold up

- Outcome: **ADR 2026-05-01 advances to Full Policy Lock** revision (rev3 — Revised).
- Rule 4-A Step 4 chain default = Preuse-clear (already ADR §2.1).
- S relegated to Layer 1 secondary chain (auto-failover when PC concurrent budget exhausted).
- Substitute-compact revised arm result feeds future Phase 6 hyperparameter ADR (separate).

### 7.2 Quadrant Q2 — PC ≈ S, both hold up (most likely outcome per Phase 4b prior)

- Outcome: **orchestrator + user decide a single Layer 1 chain default**, or document a **hot-failover policy** (PC primary, S secondary, switch on subagent budget exhaustion).
- ADR 2026-05-01 advances to Full Policy Lock with explicit "PC ≈ S persisted on holdout" caveat.
- This is the predicted outcome from Phase 4b U2 tie + condition 3/5; spec author estimates ~60% prior.

### 7.3 Quadrant Q3 — PC > S but at least one degrades

- Outcome: **REJECT Phase 4 ranking generalization**. Even if PC wins, the absolute-quality drop suggests the chain mode itself is fragile across domains.
- ADR 2026-05-01 → Status: **Superseded** by a new ADR.
- Next action: orchestrator dispatches analyst for grader/fixture diagnostic. Possible re-run with adjustments before any Layer 1 chain default ships.

### 7.4 Quadrant Q4 — PC ≈ S, both degrade

- Outcome: **same as Q3** — degradation is the signal, not the tie.
- ADR 2026-05-01 → Status: **Superseded**.
- Diagnostic priority: grader drift between Phase 4 and Phase 5 fire dates, or fixture-difficulty miscalibration in §4.2 selection.

### 7.5 Quadrant Q5 — PC < S, both hold up

- Outcome: **S becomes Layer 1 chain default**. PC removed from default set; mechanism retained in-tree for selective use cases (long-form input chains where Task-tool unavailable).
- ADR 2026-05-01 → Status: **Superseded** by a new ADR (e.g., `2026-XX-rule-4-a-step-4-S-as-chain-default.md`).
- Substitute-compact revised arm result still feeds future Phase 6 (independent of PC vs S outcome).

### 7.6 Quadrant Q6 — PC < S, at least one degrades

- Outcome: **same diagnostic priority as Q3/Q4** — degradation overrides ranking. ADR 2026-05-01 Superseded; new ADR after diagnostic completes.

### 7.7 Substitute-compact revised arm — orthogonal sub-decision

Independent of PC vs S quadrant:

- **If revised arm Δq vs Pacc ≥ +0.10 (large effect, p < 0.05, d ≥ 0.5)**: open Phase 6 hyperparameter sweep (separate ADR; cuts other than 10k/50k/100k/150k worth investigating).
- **If revised arm Δq within ±0.05 of Pacc** (consistent with Phase 4c result): substitute-compact mechanism stays in-tree with hyperparameter sweep priority lowered to "watch-list".
- **If revised arm Δq vs Pacc ≥ +0.20 (very large effect)**: ADR 2026-05-01 §2.3 disposition is revised — substitute-compact promoted to candidate chain mode pending full hyperparameter sweep.

---

## §8 Open questions (architect-flagged for orchestrator/user)

### 8.1 Substitute-compact revised cut selection (§3.2)

Three options (A/B/C) listed in §3.2. Architect default = Option A (p50 percentile-anchor). User may override during ADR Acceptance gate.

**Decision deadline**: before pre-reg tag commits (per §5.3).

### 8.2 Revised arm vs full sweep priority

Phase 5 tests **1** revised cut. If signals are positive, Phase 6 opens a full sweep (≥3 cuts). If signals are inconclusive, revised arm is a sunk cost. **Question**: should Phase 5 budget instead absorb 2 revised cuts at the cost of dropping 1 fixture (5 → 4)?

**Architect recommendation**: NO — fixture coverage is the more constraining variable. 1 revised-cut arm is sufficient as a hyperparameter signal; full sweep is Phase 6 scope.

### 8.3 Holdout fixture authority

§4.2 lists 5 recommended fixtures. **Final selection requires user approval** — architect cannot bind the user on fixture choice without breaking Constitution Rule 13 (객관적, no architect bias on selection of evidence base).

**Resolution path**: orchestrator dispatches user fixture-selection turn after ADR 2026-05-01 Acceptance, before pre-reg tag.

### 8.4 Grader version stability (per condition 2 follow-up — codex)

If the F5/Fa weak signals (Phase 4b) trace to grader-version drift between Phase 3 and Phase 4 fire dates, then Phase 5 inherits the same risk. **Question**: should Phase 5 freeze grader at the Phase 4b-fire commit SHA explicitly (pre-reg requirement §5.1 #4) and **separately** re-grade Phase 3 F5/Fa cells under the same SHA?

**Architect recommendation**: YES on freezing (already in §5.1). Phase 3 re-grade is a SEPARATE deliverable (analyst follow-up, not Phase 5 scope) — flagged here only to anchor the rationale.

### 8.5 Mixed-effects scope (per gemini BS2)

§6.4 includes a mixed-effects model. **Question**: should this be a **gate** for Phase 5 → Full Policy Lock, or **informational**?

**Architect recommendation**: INFORMATIONAL for now (Phase 5 success criteria §6.1/§6.3 already binding). Promotion to gate on a future ADR if results show fixture random-effect explains >30% of mode variance.

---

## §9 Failure modes

| Failure | Symptom | Response |
|---|---|---|
| Trial count <300 (technical run failures) | Missing (mode, fixture, seed) cells | Re-fire missing cells under SAME pre-reg tag; if re-fire impossible, scope reduction to documented complete cells (re-pre-reg required) |
| Schema corruption | metrics.json schema_version mismatch | Quarantine corrupt cells; analyst report covers only schema-valid subset |
| Grader accuracy < 70% (§6.1 hard gate fails) | Aggregate < 0.70 | Rule 4-A Step 4.5 escalation: grader audit before any decision-tree branch fires |
| Pre-reg tag drift | Grader/harness commit changes between tag and last trial | INVALIDATE the entire Phase 5; re-tag and re-fire — non-negotiable per Constitution Rule 5 |
| Substitute-compact V3 regression | byte-equality breaks under revised cut | HALT Phase 5; analyst diagnostics; substitute-compact arm dropped from Phase 5 (5-mode set instead of 6) |
| Revised cut selection deadlock | Architect/user can't agree on Option A/B/C | Default to Option A (p50) per §3.2 — minimum-assumption fallback |

---

## §10 Estimate

- Pre-Phase-5 analyst U2 recompute (§6.2): 30–60 min wall.
- Architect substitute-compact revised-cut sub-decision (§3.2): 15–30 min.
- User fixture-selection turn (§8.3): 30 min orchestrator dispatch + user round-trip.
- Pre-reg tag commit (§5): 15 min.
- 300 trials × ~3 min/trial × parallelism: ~5–10 hours wall (matches Phase 4c profile).
- Analyst report (§6.3 + §6.4 + §6.5): 2–4 hours wall.
- Quadrant decision + follow-up ADR draft: 1–2 hours (per quadrant).

**Total wall**: ~12–18 hours from ADR Acceptance to Full Policy Lock decision (or Supersede).

---

## §11 Owners

| Step | Owner | Output |
|---|---|---|
| ADR Acceptance gate | orchestrator + user | ADR 2026-05-01 status = Accepted |
| Pre-Phase-5 U2 recompute (§6.2) | aigentry-devkit analyst session | U2 Pareto-restricted report |
| Substitute-compact revised cut (§3.2) | architect (potentially this session, on follow-up dispatch) | Phase 5 spec addendum naming the cut |
| Holdout fixture set (§4) | orchestrator (proposes) + user (approves) | Final 5 fixtures committed to spec §4.2 |
| Pre-reg tag commit (§5) | orchestrator | `exec-mode-v5-holdout-preregistered-YYYYMMDD` tag |
| Trial execution | aigentry-devkit runner session (TBD claim at kickoff) | 300 metrics.json + chain_state.json files |
| Analyst report (§6.3–§6.5) | aigentry-devkit analyst session | Phase 5 final report |
| Decision tree → ADR action (§7) | architect (new session) | Either ADR 2026-05-01 rev3 (Revised) OR new ADR (Supersede) |
| User Acceptance | user | Final Full Policy Lock signoff |

---

## §12 References

- ADR 2026-05-01 (sibling deliverable): `docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md`
- Predecessor ADR (Rule 4-A Narrow Lock): `docs/adr/2026-04-22-rule-4-mode-selection.md`
- Predecessor ADR (substitute-compact-v1 spec, V3 PASS): `docs/adr/2026-04-26-q1-prereq-redesign.md`
- Phase 4 plan: `docs/plans/2026-04-22-phase4-plan.md`
- Phase 4 final analysis spec (predecessor): `docs/superpowers/specs/2026-04-26-phase4-final-analysis-spec.md`
- Phase 4 final analysis report: `~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md`
- Codex review: `~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-codex.md`
- Gemini review: `~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-gemini.md`
- Phase 3 reference: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md` (commit `472cc9f`)
- Phase 4 pre-reg tag: `exec-mode-v4-replication-preregistered-20260426` (devkit commit `26f8cc4`)

---

*End of Phase 5 holdout spec. Status remains DRAFT until ADR 2026-05-01 Accepted + pre-reg tag committed.*
