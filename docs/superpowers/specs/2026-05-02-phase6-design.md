---
status: accepted
accepted_date: 2026-05-02
accepted_by: orchestrator (oikim signoff via aigentry-orchestrator-claude)
date: 2026-05-02
topic: phase6-design
track: "#329 E27 Phase 6 — Rule 4-A Step 4 substitute-compact final + D-promotion + fixture-rule + ceiling-replacement"
phase: spec only — execution gated on (a) user approval of this spec, (b) Q4 dustcraw fixture pilot pass, (c) grader cross-LLM review pass, (d) Phase 6 pre-reg tag commit
parent_adr: docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md (§11 Phase 6 Pre-registration Stub)
brainstorm: ../../../../aigentry-architect/docs/superpowers/proposals/2026-05-01-phase6-brainstorm.md (commit 2c95e2d)
related:
  - docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md
  - docs/adr/2026-05-01-substitute-compact-revised-cut.md
  - docs/adr/2026-04-26-q1-prereq-redesign.md
  - docs/superpowers/specs/2026-05-01-phase5-holdout-design.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-final-analysis.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-codex-review.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-gemini-review.md
constitution_rules: [Rule 1 경량, Rule 5 최선, Rule 13 비판적+건설적+객관적]
sub_projects:
  - Q1 substitute-compact mechanism (final time-boxed test per gemini D2)
  - Q2 D-promotion candidacy (binding pre-reg per codex C3)
  - Q3 output-style fixture-design rule ADR (per gemini D3)
  - Q4 ceiling-fixture replacement (enabling for Q2 power)
user_approved_decisions: 8 (verbatim per §2.6, locked at acceptance)
---

# Phase 6 Spec — α-step-15 (Rule 4-A Step 4 follow-up)

## §1 Status, Context, Track

**Status**: accepted (2026-05-02, oikim signoff via aigentry-orchestrator-claude after spec-document-reviewer 2-iteration PASS).

**Date**: 2026-05-02.

**Track**: `#329 E27 Phase 6` — binding pre-registration for the four carry-over questions left INCONCLUSIVE or non-binding by the Phase 5 final lock ADR (`docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md`).

**Parent**: ADR 2026-05-01-rule-4-a-step-4-final-lock §11 (≤300-word Phase 6 stub). This spec consumes that stub's binding requirements and operationalizes them as a single bundled Phase.

**Sub-projects bundled in this Phase**:

1. **Q1 — Substitute-compact mechanism** (final time-boxed test per gemini D2). One more chance, then deprecated per Constitution Article 1 경량 if it does not show Pareto-relevant separation.
2. **Q2 — D-promotion candidacy** (binding pre-reg per codex C3). The Phase 5 PC=S=D triple-tie was post-hoc exploratory; Phase 6 pre-registers the question.
3. **Q3 — Output-style fixture-design rule ADR** (per gemini D3). Standalone ADR commit on approval (parallel architect dispatch); no trials.
4. **Q4 — Ceiling-fixture replacement** (per analyst §10.4 #1). Enabling pre-condition for Q2 power; mandatory for D-vs-PC separation detection on a non-ceiling fixture set.

**Time-box per gemini D2** (locked, non-negotiable): substitute-compact gets ONE more chance in this Phase. If both 5-position and 10-position regimes fail to satisfy the promotion criterion (§9.1), the mechanism is deprecated. There is no Phase 7 substitute-compact arm.

**REF**: brainstorm `2c95e2d` §1 (Q1), §2 (Q2), §3 (Q3), §4 (Q4), §5 (cross-question concerns).

---

## §2 Goal & Hypotheses (binding pre-registration)

This spec is written **before** any Phase 6 trial fires. Hypotheses, decision rules, fixture set, modes, seeds, and statistical methodology are pre-declared to prevent post-data rationalization (Constitution Rule 13 객관적; codex C3).

### §2.1 Q1 — Substitute-compact mechanism efficacy

**Question**: Does substitute-compact produce a Pareto-relevant quality improvement over Pacc on either (a) 5-position chains with cut ∈ {5,10,15,20} or (b) 10-position chains with cut=30?

**Endpoint**: `quality.primary` (continuous; matches Phase 5 spec §3, codex C4 endpoint discipline).

**Pre-registration lock**: this spec's acceptance commit SHA + the Phase 6 pre-reg tag annotation (§8).

#### §2.1.1 Promotion hypothesis (one-sided superiority)

- **H0 (null)**: μ(Preuse-substitute-compact-revised at any cell) − μ(Pacc, matched chain length) ≤ 0.
- **H1 (alternative)**: μ(Preuse-substitute-compact-revised at any cell) − μ(Pacc, matched chain length) > 0, with effect ≥ 0.10 absolute on `quality.primary`.
- **Decision rule (promote)**: there exists at least one substitute-compact cell satisfying ALL of:
  - Δq vs Pacc (matched chain length) ≥ +0.10 (absolute mean difference)
  - Welch t-test p < 0.05 (two-sided), Bonferroni-corrected for §7.5 family count
  - Cohen d ≥ 0.5 (medium-effect floor)
- **Outcome on promote**: substitute-compact mechanism **promoted** to Layer 1 chain-mode candidate; cut value of the winning cell is locked into a follow-up sub-ADR. Phase 7 may sweep neighboring cuts.

#### §2.1.2 Deprecation hypothesis (TOST equivalence)

- **H0_eq (null, equivalence)**: |μ(Preuse-substitute-compact-revised at every cell) − μ(Pacc, matched chain length)| ≥ 0.05.
- **H1_eq (alternative, equivalence)**: |μ(...) − μ(Pacc, matched chain length)| < 0.05 for ALL substitute-compact cells.
- **Decision rule (deprecate)**: TOST equivalence test at margin ε = ±0.05, α = 0.05 (90% CI ⊂ [-0.05, +0.05]) holds for ALL substitute-compact cells AND no cell satisfies §2.1.1 promotion criterion.
- **Outcome on deprecate**: substitute-compact mechanism **deprecated** per gemini D2 + Constitution Article 1; removed from Rule 4-A Step 4 candidate set; sub-ADR `2026-05-01-substitute-compact-revised-cut.md` superseded by a Phase 6 deprecation ADR.

#### §2.1.3 Watchlist (no decision)

- If neither §2.1.1 nor §2.1.2 holds (e.g., one cell shows Δq ≈ +0.05, p = 0.07; other cells equivalent): mechanism in **watchlist** — no further phases, mechanism stays in-tree at sub-ADR cut=30 status, sub-ADR carries explicit "no Pareto-relevant separation observed but TOST equivalence not established" footnote. This is the codex C1 trap avoidance: tie ≠ equivalence, tie ≠ separation.

**REF**: brainstorm `2c95e2d` §1.5 (Q1e dual gate); parent ADR §11 substitute-compact bullet.

### §2.2 Q2 — D promotion candidacy

**Question**: Does D (Dispatch, non-chain) match PC (Preuse-clear) and S (Subagent) within an equivalence margin AND show no statistically significant inferiority on a non-ceiling fixture set?

**Endpoint**: `quality.primary` (continuous; matches Phase 5; codex C4).

**Pre-registration lock**: same as §2.1 (this spec acceptance + pre-reg tag).

#### §2.2.1 Promotion hypothesis (TOST equivalence + one-sided superiority dual gate)

- **H0 (null, non-equivalence vs PC)**: |μ(D) − μ(PC)| ≥ 0.05.
- **H1 (alternative, equivalence vs PC)**: |μ(D) − μ(PC)| < 0.05.
- **H0' (null, non-equivalence vs S)**: |μ(D) − μ(S)| ≥ 0.05.
- **H1' (alternative, equivalence vs S)**: |μ(D) − μ(S)| < 0.05.
- **Decision rule (D-promote to Layer 1 co-equal)**: ALL of:
  - TOST at ε = ±0.05, α = 0.05 (90% CI ⊂ [-0.05, +0.05]) holds for D-vs-PC.
  - TOST at ε = ±0.05, α = 0.05 holds for D-vs-S.
  - One-sided superiority test of D vs the lower of {PC, S} returns p < 0.05 OR equivalence is the strongest claim (in which case D promoted on the operational-advantage tie-breaker per brainstorm §2.2: D is non-chain, no chain-state burden, cross-CLI portable per Rule 4-A Step 5).
- **Outcome on promote**: D **promoted to Layer 1 co-equal chain mode** alongside PC and S. Rule 4-A Step 4 selector revised to a 3-way deterministic single-signal split (selector signal TBD by parent ADR follow-up). ADR 2026-05-01-rule-4-a-step-4-final-lock §4.2 superseded by a Phase 6 D-promotion ADR.

#### §2.2.2 Maintain-status hypothesis (default fallback)

- **Decision rule (maintain Layer 2 D)**: §2.2.1 dual TOST does not hold (CI extends past ±0.05 in either pair).
- **Outcome on maintain**: D stays at Layer 2 (current ADR §4.2 disposition); no rule change.

**REF**: brainstorm `2c95e2d` §2.2 (Q2b); parent ADR §11 D-promotion bullet; codex C3 binding-only-on-pre-reg.

### §2.3 Q3 — Output-style fixture-design rule ADR

**Question**: What is the binding fixture-design rule for graders evaluating structurally-equivalent data variants (e.g., JSON in raw text vs JSON in markdown code block)?

**Pre-registration lock**: this spec's acceptance commit SHA. No trial-based hypothesis — Q3 is a **pure documentation deliverable** (standalone ADR commit per §10.3).

#### §2.3.1 Hypothesis-equivalent (rule-form proposition)

- **Proposition**: "Graders for structurally-equivalent data variants MUST implement a formatting-exemption equivalence pre-step before scoring; edge cases require explicit exemption documentation in the grader spec."
- **Decision rule (rule adoption)**: standalone ADR drafted in parallel by a separate architect dispatch (§10.3). User approves on its own merit (Tier T1: cross-project; not a Phase 6 trial dependency). Approval **does not** depend on Q1/Q2/Q4 outcomes.
- **Outcome**: ADR `docs/adr/2026-05-XX-fixture-design-output-style-exemption.md` enters `accepted` status; rule applies to all future fixture authors and grader reviewers (cascade-grader-rubric template gains "output-style exemption verified" checkbox per brainstorm §3.3).

**REF**: brainstorm `2c95e2d` §3.1–§3.3; parent ADR D3 entry (§9 row D3, §11 Q3 bullet).

### §2.4 Q4 — Ceiling-fixture replacement (no binding hypothesis)

**Question**: Does the dustcraw-authored H11–H14 fixture set yield μq ∈ [0.5, 0.85] in baseline mode (D)?

**Endpoint**: `quality.primary` mean per fixture from the pilot run.

#### §2.4.1 Calibration hypothesis (no Phase 6 binding outcome)

- Q4 is **enabling** — the goal is to admit fixtures into the Q2 grid; pilot results are attestation-only (not analyzed in Phase 6 main).
- **Pilot acceptance criterion (per fixture)**: 5 trials in mode D, μq ∈ [0.5, 0.85] (per brainstorm §4.4c).
- **Reject path (per fixture)**: if μq > 0.85 (ceiling) OR μq < 0.5 (floor), dustcraw revises that fixture; max 1 revision iteration per fixture before falling back to a Q2 grid of 4 fixtures (H1 + 3 of {H11–H14}).
- **Outcome**: H11–H14 (revised as needed) admitted to the Q2 grid; pilot data recorded only in pre-reg tag annotation.

**REF**: brainstorm `2c95e2d` §4 (Q4); parent ADR OQ1 (§12).

### §2.5 Tracking matrix

| Q | Type | Binding | Decision rule | Reference |
|---|---|---|---|---|
| Q1 | Mechanism efficacy | YES | §2.1.1 promote OR §2.1.2 deprecate OR §2.1.3 watchlist | brainstorm §1; parent ADR §11(1) |
| Q2 | Mode promotion | YES | §2.2.1 promote OR §2.2.2 maintain | brainstorm §2; parent ADR §11(2) |
| Q3 | Rule adoption | YES (ADR-form, no trials) | §2.3.1 standalone ADR approval | brainstorm §3; parent ADR §11(3), D3 |
| Q4 | Fixture calibration | NO (enabling) | §2.4.1 pilot acceptance criterion | brainstorm §4; parent ADR §11(4), OQ1 |

### §2.6 User-approved decisions (locked at acceptance — verbatim from dispatch)

| # | Sub-question | User-approved option |
|---|---|---|
| 1 | Q1a chain length | **Factorial**: 5-pos × {5,10,15,20} cuts + 10-pos × {30} cut |
| 2 | Q1d cut metric | **`input_tokens`** (current spec, time-box-aligned) |
| 3 | Q1e deprecation criterion | **TOST ε=±0.05** vs Pacc + dual gate Δq ≥ +0.10 / d ≥ 0.5 to promote |
| 4 | Q1f n/cell | **50 trials/cell** (under-powered, accept) |
| 5 | Q2b D-promotion rule | **TOST ε=±0.05 vs PC AND vs S** + one-sided superiority dual-gate |
| 6 | Q4 inclusion | **INCLUDE** ceiling-fixture replacement (mandatory for Q2 power) |
| 7 | Q4a fixture authorship | **dustcraw new H11-H14** (out-of-grid pilot, calibrate q ∈ [0.5, 0.85]) |
| 8 | Cost ceiling | **~515 trials** (Q1 350 + Q2 150 + Q4 pilot 25 - reuse 10) — see §2.6.1 reconciliation |

These 8 decisions are bound verbatim. No re-brainstorming during spec drafting; revisions require user re-approval.

#### §2.6.1 Decision row 8 reconciliation note (explicit, non-silent)

The dispatch-approved row 8 specifies "Q4 pilot 25 trials" (assuming 5 candidate fixtures × 5 trials), but row 7 specifies "dustcraw new H11–H14" (4 fixtures explicitly). The two row contents are internally inconsistent: 4 fixtures × 5 trials = 20, not 25. This spec resolves by **honoring the row-7 fixture-set verbatim (H11–H14, 4 fixtures)**; consequence: Q4 pilot = 4 × 5 = **20 trials** (not 25), and total = 350 + 150 + 20 − 10 = **510** (not ~515). The cost ceiling row 8 is satisfied with a 5-trial margin under cap.

If the user prefers to honor row 8's "25" verbatim instead, the resolution is to add a 5th candidate fixture H15 to dustcraw's deliverable (re-approval required). Default: this spec stands at 4 fixtures / 510 trials; user re-approval may amend.

**Pre-reg tag annotation MUST cite both the dispatch-row figure (~515) and the spec-resolved figure (510)** to keep the reconciliation auditable per §8.2 item 8.

---

## §3 Experimental Design

### §3.1 Q1 — Substitute-compact factorial design (chain × cut × mode)

| Cell | Chain length | Cut | Mode | n |
|---|---|---|---|---|
| Q1-A1 | 5-pos | 5 | Preuse-substitute-compact-revised | 50 |
| Q1-A2 | 5-pos | 10 | Preuse-substitute-compact-revised | 50 |
| Q1-A3 | 5-pos | 15 | Preuse-substitute-compact-revised | 50 |
| Q1-A4 | 5-pos | 20 | Preuse-substitute-compact-revised | 50 |
| Q1-A5 | 10-pos | 30 | Preuse-substitute-compact-revised | 50 |
| Q1-Ref-5pos | 5-pos | n/a | Pacc (reference) | 50 |
| Q1-Ref-10pos | 10-pos | n/a | Pacc (reference) | 50 |

- **Cell count**: 7 (5 substitute-compact arms + 2 Pacc reference arms).
- **Trials**: 7 × 50 = **350 trials**.
- **Fixtures per cell**: H1 + H10 (reused, non-ceiling per Phase 5; see §4.1). Each cell uses both fixtures (25 trials per fixture per cell) to balance fixture-class signal.
- **Seeds**: deterministic `MASTER_SEED=42 + mode_offset + fixture_offset` shuffle (Phase 5-equivalent scheme).
- **Trigger endpoint** (per brainstorm §1.3 Q1c hybrid): primary = `segment_start_position > 1` (binary, recorded in `chain_sess.json`); secondary = `cumulative_input_tokens_at_trigger` (continuous, post-hoc curve fit; not binding).

**REF**: brainstorm `2c95e2d` §1.1 (Q1a factorial), §1.2 (Q1b cut grid), §1.3 (Q1c trigger), §1.4 (Q1d metric).

### §3.2 Q2 — D-promotion design (mode × fixture × seed)

**Original design (pre-Q4-r5-fail)** — for audit:

| Dimension | Original Value |
|---|---|
| Fixtures | H1 + H11 + H12 + H13 + H14 — 5 fixtures |
| Seeds per (mode, fixture) | 10 |
| Cells | 3 × 5 = 15 |
| Trials | **150 trials** |

**Active design (post-Q4-r5-fail amendment, 2026-05-02)** — see §3.2.1 fallback rationale:

| Dimension | Active Value |
|---|---|
| Modes | D, PC (Preuse-clear), S (Subagent) — 3 modes |
| Fixtures | **H1 + H10** — 2 fixtures (H11–H14 dropped per §3.2.1) |
| Seeds per (mode, fixture) | **25** |
| **Cells** | 3 × 2 = 6 |
| **Trials** | 3 × 2 × 25 = **150 trials** (budget preserved) |

- Excluded modes: Pacc (sunset on 2026-08-01 per parent ADR §4.4); Pfresh (out of Phase 6 scope per Phase 5 evidence; brainstorm §5.3).
- Substitute-compact NOT in Q2 grid: Q2 tests Layer 1 chain-mode promotion; substitute-compact decision is independent (§2.1).

**REF**: brainstorm `2c95e2d` §2.1 (Q2a hybrid fixtures), §2.3 (Q2c sample size); §3.2.1 below for fallback rationale.

### §3.2.1 Q2 fallback grid (post Q4 r5 fail amendment)

**Trigger**: Q4 r5 pilot (devkit `13697d1`, 2026-05-02) returned 0/8 PASS the [0.5, 0.85] ∧ σ≥0.05 acceptance criterion. Per §3.4.1 #6 HARD LIMIT (iteration 2 of 2 reached), no further fixture redesign permitted.

**Amendment**: drop H11–H14 from Q2 grid. Q2 binding test proceeds on **H1 + H10** alone (2 Phase-5-reused fixtures with empirically-known non-extreme q distributions per Phase 5 final analysis devkit `1e740ba`).

**Sample-size adjustment** (preserves §3.5 trial budget):
- Original: n=10 × 5 fixtures × 3 modes = 150 trials (50 per mode)
- Active: **n=25 × 2 fixtures × 3 modes = 150 trials (50 per mode)**
- Per-mode N preserved → §7 statistical power per mode comparison preserved.
- Per-fixture diversity reduced (5 → 2) → external validity / generalizability claim explicitly weakened in §11 lessons (forwarded as Phase 7+ open question).

**Power note**: TOST equivalence test at ε=0.05, α=0.05, β=0.20 on per-mode N=50 (unchanged); per-fixture stratification depth halved.

**External validity caveat**: Q2 verdict applies to the H1+H10 task surface (long-form code review + strict instruction following). Domain extrapolation (e.g., agentic tool-use, multilingual reasoning) is OUT OF SCOPE for this Phase 6 binding decision and must be re-pre-registered in Phase 7+ using ceiling-avoidance procedures per §3.4.1.

**Why H10 is included** (was not in pre-Q4-fail design table): H10 is a Phase 5 reused fixture with verified non-ceiling q-distribution (`1e740ba` §3, μq ≈ 0.65 across modes, σ ≈ 0.12). H10 is a stable Q2-eligible fixture that requires no further calibration. Its omission from the original Q2 design table (§3.2 pre-amendment) was an oversight; this amendment corrects.

**Decision logic invariant**: Q2 binding hypotheses §2.2.1 + §2.2.2 unchanged. Decision rule still TOST + one-sided superiority. Only the underlying fixture set (and per-fixture seed count) is amended.

**Pre-reg tag relationship**: The pre-reg tag `exec-mode-v6-preregistered-20260502` (sealed at devkit commit `4eefc0a`) was committed BEFORE the Q4 r5 pilot. This amendment is a POST-tag procedural correction, not a pre-reg violation, because:
- The tag itself is unchanged (immutable per Phase 6 spec §8 + parent ADR §11).
- The amendment is published as an explicit fallback per §3.4 (Q4 reject path) + §3.4.1 (iteration limit) procedures pre-registered IN the tagged spec.
- The amendment is record-of-change in this spec at orchestrator commit timestamp 2026-05-02 (post-pilot, pre-Q2-fire).

**REF**: Q4 r5 pilot report devkit `13697d1`; §3.4.1 #6 iteration limit; §8.3 #2 fallback path; parent ADR §11 (pre-reg sacred-but-amendable-via-record-of-change).

### §3.3 Q3 — ADR scope (no trials)

- **Deliverable**: standalone ADR `docs/adr/2026-05-XX-fixture-design-output-style-exemption.md`.
- **Tier**: T1 (cross-project: applies to all future fixture authors; per architect AGENTS.md §7 tier matrix).
- **Reviewers**: 1 (per T1 default); reviewer authority dispatched by orchestrator.
- **Trial cost**: 0.
- **Authoring path**: separate architect dispatch in parallel with this spec's spec-reviewer loop (§10.3). NOT bundled into this spec to keep ADR scope clean and supersedable independent of Phase 6 outcomes.

**REF**: brainstorm `2c95e2d` §3 (Q3); architect AGENTS.md §7.

### §3.4 Q4 — Fixture pilot design (out-of-grid; H11-H14 calibration)

| Dimension | Value |
|---|---|
| Candidate fixtures | H11, H12, H13, H14 — 4 dustcraw-authored fixtures |
| Mode | D (single mode, baseline) |
| Trials per fixture | 5 |
| **Pilot trials** | 4 × 5 = **20 trials** |

- **Note**: brainstorm §4.4 anticipated 5 candidate fixtures × 5 trials = 25 pilot trials. This spec adopts 4 candidate fixtures (H11–H14) per the user-approved decision row 7. The pilot count is correspondingly 20. The cost-ceiling row (decision 8, ~515 trials) accommodates either count; spec uses the dispatch-approved 4-fixture H11–H14 set verbatim. (See §2.6.1 for the dispatch-row reconciliation.)
- **Seeds**: isolated range `MASTER_SEED=42 + 1000 + fixture_offset` (out-of-grid per brainstorm §4.4c) so pilot data does not contaminate the main pre-reg grid.
- **Acceptance criterion** (per fixture): μq ∈ [0.5, 0.85].
- **Reject + revise path**: 1 revision iteration per fixture; if revised fixture still fails, fall back to a Q2 grid of 4 fixtures (H1 + 3 of {H11–H14 that pass}).
- **Pilot data disposition**: recorded ONLY in pre-reg tag annotation (§8); not analyzed in Phase 6 main analysis.

**REF**: brainstorm `2c95e2d` §4.3 (Q4c calibration).

### §3.4.1 Ceiling-avoidance calibration procedure (Phase 5/6 lessons-learned amendment)

Empirical record (case studies):
- **Phase 5**: H2/H3/H5 hit q=1.000 ceiling for all 6 modes — wasted ~150 trials of statistical power, downgraded fixture set to F-anomaly status.
- **Phase 6 Q4 r4 pilot** (devkit `36c9be4`): all 4 NEW H11–H14 fixtures hit ceiling for Mode D (q ∈ {1.000, 0.933, 1.000, 1.000}; 0/4 in the [0.5, 0.85] target band) despite being authored explicitly to *avoid* this Phase 5 trap.

Conclusion: ceiling is a recurring fixture-design failure mode for current-generation Claude (≥ 2.1.x). Avoidance MUST be procedurally enforced, not left to author intuition.

**Mandatory calibration practices for any future Q4-style new fixture authorship** (Phase 6+ binding):

1. **Adversarial probe diversity**: each fixture MUST embed at least one *plausibly-distracting* alternative for the agent to disprefer. Pure recall / pure transformation fixtures saturate.
2. **Multi-turn / multi-step compounding**: target tasks where ≥ 3 sequential constraints compound. Single-turn factual recall ceilings.
3. **Distractor density**: planted_facts / probe set MUST include near-duplicates and category-overlap items (not just orthogonal facts) to force discrimination.
4. **Pilot-verify under multiple modes**: pilot MUST run at least 2 modes (e.g., D + Pacc) — single-mode pilot can miss ceilings that emerge only on harder configurations and vice-versa.
5. **Difficulty stratification check**: if pilot returns σ(q) < 0.05 across seeds AND mean ≥ 0.95, automatic ceiling flag — NO further escalation, fixture redesign mandatory.
6. **Iteration limit (HARD)**: maximum **2** revision iterations per fixture (was 1 in §3.4 original). After iteration 2 fail: drop the fixture from Q4 set (Q2 grid degrades gracefully per §3.4 reject path) — do NOT extend Phase 6 beyond this gate.

These practices apply RETROACTIVELY to any Phase 6 Q4 redesign cycle (e.g., H11–H14 r5 if dispatched after the 2026-05-02 pilot ceiling). They also apply PROSPECTIVELY to any Phase 7+ fixture authorship.

**REF**: pilot report devkit `36c9be4`; Phase 5 final analysis devkit `1e740ba` §4.5/§10.4 (NB3 ceiling pattern).

### §3.5 Total trial budget breakdown

| Block | Cells | Trials | Reference |
|---|---|---|---|
| Q1 substitute-compact arms | 5 (4 × 5-pos + 1 × 10-pos) | 5 × 50 = 250 | §3.1 |
| Q1 Pacc reference arms | 2 (5-pos + 10-pos) | 2 × 50 = 100 | §3.1 |
| Q2 D-promotion grid | 15 (3 modes × 5 fixtures) | 15 × 10 = 150 | §3.2 |
| Q4 fixture pilot (out-of-grid) | 4 (4 fixtures × 1 mode) | 4 × 5 = 20 | §3.4 |
| **Subtotal** | | **520** | |
| Reuse (H1 in Q1 5-pos Pacc + Q2 D-on-H1 overlap) | | **−10** | brainstorm §5.1 |
| **TOTAL** | | **~510** | |

**Cost ceiling adherence**: dispatch-approved cap = ~515; actual = ~510 (under cap by 5). Acceptable.

**REF**: brainstorm `2c95e2d` §5.1 (C1 trial count).

---

## §4 Fixtures

### §4.1 Reused fixtures (from Phase 5)

| id | Domain | Difficulty | Phase 5 q (top-3 modes) | Why reused |
|---|---|---|---|---|
| **H1** | long-form-code-review | hard | μq < 0.95 (non-ceiling) | Cross-phase replication anchor (the only non-ceiling Phase 5 fixture for Q2 D-vs-PC test) |
| **H10** | strict-instruction-following | easy | μq < 0.95 (non-ceiling) | Phase 5 PC-disfavored signal Δq = −0.012 worth replicating; sole Phase 5 fixture surfacing PC-vs-S asymmetry |

- H1 is used in BOTH Q1 (sub-compact arms + Pacc reference) and Q2 (D-promotion grid).
- H10 is used in Q1 only (paired with H1 to balance Q1 substitute-compact and Pacc reference cells across two non-ceiling fixtures).
- **Grader reuse**: existing graders for H1 and H10 are reused. NB3 patch (codex r3, Phase 5 known-issue) MUST land before grader is frozen at the pre-reg tag (per brainstorm §6.1 + parent ADR OQ4). NB3 patch authority: cascade-grader-rubric review session (orchestrator dispatch).

**REF**: brainstorm `2c95e2d` §2.1 (H1 cross-phase anchor); Phase 5 spec §4.2 (H1, H10).

### §4.2 Replaced fixtures (from Phase 5)

| id | Phase 5 q | Reason for replacement |
|---|---|---|
| **H2** | 1.000 (ceiling, all top-3 modes) | No power for between-mode separation |
| **H3** | 1.000 (ceiling) | Same as H2 |
| **H5** | 1.000 (ceiling) | Same as H2 + NB3 known-issue (codex r3) makes any reuse contingent on grader patch |

- These three fixtures are **NOT used** in Phase 6.
- The Q2 grid replaces them with H11–H14 (§4.3) for ceiling-avoidance per brainstorm §4.2 (Q4b selection criterion).

**REF**: brainstorm `2c95e2d` §4.2 (Q4b); Phase 5 final analysis report (devkit `1e740ba`) ceiling discussion.

### §4.3 New fixtures (dustcraw-authored)

| id | Authoring source | Calibration target | Pre-condition before Q2 fire |
|---|---|---|---|
| **H11** | dustcraw spec (cross-LLM author per brainstorm §4.1) | μq ∈ [0.5, 0.85] in mode D | Q4 pilot pass (§3.4) |
| **H12** | dustcraw spec | μq ∈ [0.5, 0.85] in mode D | Q4 pilot pass |
| **H13** | dustcraw spec | μq ∈ [0.5, 0.85] in mode D | Q4 pilot pass |
| **H14** | dustcraw spec | μq ∈ [0.5, 0.85] in mode D | Q4 pilot pass |

- **Authoring contract** (§4.4 below) lists the constraints dustcraw must satisfy.
- Pilot failure → revise → re-pilot (1 iteration per fixture per §3.4); persistent failure falls back to Q2 grid of 4 fixtures (H1 + 3 H-fixtures that pass).

### §4.4 Fixture authorship contract (dustcraw spec)

The dustcraw fixture authorship dispatch (§10.2) MUST satisfy:

1. **Domain diversity**: H11–H14 cover 4 distinct task domains, NONE overlapping H1's `long-form-code-review` domain. Suggested domain palette: structured-data-extraction, agentic-multi-step-tool-use, multilingual-summarization, schema-strict-output. Final domain selection by dustcraw with orchestrator approval; document in dustcraw fixture spec.
2. **Output-style guard** (per Q3 rule, §2.3): each fixture's grader MUST implement formatting-exemption logic per the Q3 ADR (graders for structurally-equivalent data variants MUST equivalence-pre-step). If the Q3 ADR is not yet `accepted` at dustcraw dispatch time, dustcraw uses the brainstorm §3.2 verbatim wording as the contract (the rule predates the ADR; ADR formalizes it).
3. **Ceiling-avoidance pilot trials**: dustcraw runs the §3.4 pilot in mode D and reports μq per fixture. If any fixture reports μq > 0.85 or < 0.5, dustcraw revises that fixture (1 iteration max).
4. **Grader emit**: each fixture's grader emits `formatting_exempt_applied: bool` in `metrics.json` for per-trial audit (brainstorm §3.3 secondary-enforcement).
5. **Cross-LLM grader review** before pre-reg tag: per brainstorm §6.2 + Phase 5 cascade-13 pattern.

**REF**: brainstorm `2c95e2d` §4.1 (Q4a), §4.4 (calibration), §3.3 (enforcement).

---

## §5 Modes Under Test

### §5.1 Q1 modes

| # | Mode | Role in Q1 |
|---|---|---|
| 1 | **Pacc** (5-pos chain) | Reference arm for 5-pos substitute-compact cells |
| 2 | **Pacc** (10-pos chain) | Reference arm for 10-pos substitute-compact cell |
| 3 | **Preuse-substitute-compact-revised** (cut=5, 5-pos) | Cell Q1-A1 |
| 4 | **Preuse-substitute-compact-revised** (cut=10, 5-pos) | Cell Q1-A2 |
| 5 | **Preuse-substitute-compact-revised** (cut=15, 5-pos) | Cell Q1-A3 |
| 6 | **Preuse-substitute-compact-revised** (cut=20, 5-pos) | Cell Q1-A4 |
| 7 | **Preuse-substitute-compact-revised** (cut=30, 10-pos) | Cell Q1-A5 |

- Cut metric: **`input_tokens`** (uncached delta) — per user-approved decision row 2.
- Per-position `input_tokens` ~5 in 5-pos chains (Phase 5 measurement); cut=5 fires at pos-1, cut=10 at pos-2, cut=15 at pos-3, cut=20 at pos-4. Cut=25 deliberately omitted (fires at pos-5 = no post-fire recovery → equivalent to "no fire" on 5-pos chain).
- 10-pos × cut=30 restores the sub-ADR Hypothesis B context (cut=30 was the original sub-ADR-locked value before Phase 5 5-pos chain shrank effective per-position tokens).

**REF**: brainstorm `2c95e2d` §1.2 (Q1b grid rationale); sub-ADR `2026-05-01-substitute-compact-revised-cut.md` Hypothesis B.

### §5.2 Q2 modes

| # | Mode | Role in Q2 |
|---|---|---|
| 1 | **D** (Dispatch, non-chain) | Promotion candidate |
| 2 | **PC** (Preuse-clear) | Layer 1 incumbent (per parent ADR §4.2) |
| 3 | **S** (Subagent) | Layer 1 incumbent (per parent ADR §4.2) |

### §5.3 Excluded modes

| Mode | Why excluded |
|---|---|
| **Pfresh** | Out of Phase 6 scope per Phase 5 evidence; brainstorm §5.3. Phase 5 D-vs-Pfresh non-tied at small-effect; not part of any binding Phase 6 hypothesis. |
| **Preuse-substitute-compact-C1/C2/C3/C4** (Phase 4c original cuts) | Phase 4c rejected as defaults (parent ADR §4.5 INCONCLUSIVE); revised cuts in §5.1 cover the Phase 6 hyperparameter question. |
| **Pacc** in Q2 | Pacc is sunset 2026-08-01 (parent ADR §4.4); D-promotion test is exclusively against current Layer 1 (PC, S). |

---

## §6 Graders

### §6.1 Reused graders

| Fixture | Existing grader path (devkit) | Pre-reg tag pre-condition |
|---|---|---|
| H1 | `tests/exec-mode/graders/score_h1_long_form_code_review.py` (or current path; SHA frozen at pre-reg tag) | NB3 patch landed (per OQ4); grader passes 1-trial smoke |
| H10 | `tests/exec-mode/graders/score_h10_strict_instruction_following.py` | NB3 patch N/A (H10 not in NB3 scope); grader passes 1-trial smoke |

- **NB3 patch authority**: cascade-grader-rubric review session (orchestrator dispatch). Patch must land in devkit and the grader SHA must be frozen at the pre-reg tag.
- If H10 and H1 grader smokes pass at q ≥ 0.0, status="ok" (Phase 5 pre-reg precedent), the graders are admitted.

### §6.2 New graders (H11–H14)

- **Authoring**: dustcraw fixture spec (§4.4) includes grader code for H11, H12, H13, H14.
- **Cross-LLM review**: per brainstorm §6.2 + Phase 5 cascade-13 pattern, EACH new grader passes review by at least 2 of {claude, codex, gemini} reviewers before pre-reg tag commits. Pre-tag iteration permitted (matches Phase 5 §4.1 r2 amendment).
- **Acceptance bar**: cascade-grader-rubric review returns ACCEPT (or ACCEPT-WITH-CONDITIONS where conditions are addressed). BLOCK or REQUEST-REVISION reset the iteration; max 5 iterations per grader per Phase 5 cascade-13 precedent (orchestrator may override per Phase 5 T-2 known-issue process if iterations exceed and convergence risk is bounded — bias must be MODE-asymmetric to invalidate per Rule 13 객관적).

### §6.3 Output-style guard (binding for ALL new graders)

Per Q3 rule (§2.3.1 verbatim): "Graders for structurally-equivalent data variants MUST implement a formatting-exemption equivalence pre-step before scoring; edge cases require explicit exemption documentation in the grader spec."

- All H11–H14 graders MUST implement:
  - A canonicalization step that strips/normalizes formatting variants (e.g., JSON inside markdown code-fences vs raw JSON; bullet lists vs numbered lists for structurally-equivalent enumerations).
  - A `formatting_exempt_applied: bool` field emitted in `metrics.json` per trial.
  - An explicit edge-case exemption section in the grader spec docstring listing what variants are normalized and what the canonicalization rule is.
- **Reviewer checklist**: cascade-grader-rubric review template adds an "output-style exemption verified" item (per brainstorm §3.3 primary-enforcement).
- The Q3 ADR is the durable rule home; this §6.3 is the Phase 6 enforcement profile.

**REF**: brainstorm `2c95e2d` §3.2 (rule wording), §3.3 (dual enforcement), §6.2 (cascade-13 pattern).

---

## §7 Statistical Methodology (binding)

### §7.1 Welch t-test

- **Use**: primary endpoint comparison for Q1 promotion criterion (substitute-compact vs Pacc per §2.1.1) and Q2 superiority component (§2.2.1).
- **Form**: two-sample, two-sided (Q1 promotion); two-sample, one-sided (Q2 superiority component within the dual-gate test).
- **Endpoint**: `quality.primary` (continuous; codex C4).

### §7.2 Cohen d (effect size)

- **Use**: Q1 promotion criterion floor (d ≥ 0.5).
- **Caveat (codex C4 lesson)**: hierarchical structure (50 seeds within each (mode, fixture) cell, 25 seeds per fixture within each cell) violates strict IID assumption. Cohen d here is reported with a **fixture-mean re-aggregation** secondary computation (Phase 5 codex §2 M3 pattern):
  - Primary: pooled Cohen d across all trials within the cell (matches Phase 5 reporting).
  - Secondary: Cohen d on per-fixture means (n=2 fixtures per Q1 cell) — flagged as low-power but reported for transparency.
  - Decision rule §2.1.1 uses primary; secondary is informational.

### §7.3 TOST equivalence test

- **Use**: Q1 deprecation (§2.1.2, ε=±0.05 vs Pacc); Q2 D-promotion (§2.2.1, ε=±0.05 vs PC AND vs S).
- **Form**: two one-sided tests at α = 0.05 each; equivalence holds when 90% CI of mean difference lies within (−0.05, +0.05).
- **Endpoint**: `quality.primary`.
- **Wording discipline (codex C1 lesson)**: ONLY use the word "equivalence" when reporting TOST results. For non-TOST mean-difference reports use "no separation" or "not statistically distinguishable at α=0.05". Spec, analyst report, and final ADR MUST follow this convention.

### §7.4 Bootstrap 95% CI

- **Use**: confidence intervals on Δq for all primary comparisons (Q1 promote, Q1 deprecate, Q2 D-vs-PC, Q2 D-vs-S).
- **Form**: percentile bootstrap, B ≥ 20000 resamples (Phase 5 standard).
- **Endpoint**: `quality.primary`.

### §7.5 Multiple-testing correction (Bonferroni for ALL pre-registered comparisons)

Pre-registered comparison family (count and α adjustment):

| # | Comparison | Hypothesis test | Family member |
|---|---|---|---|
| 1 | Substitute-compact cell Q1-A1 vs Pacc-5pos | Welch (Q1 promote) | Yes |
| 2 | Substitute-compact cell Q1-A2 vs Pacc-5pos | Welch (Q1 promote) | Yes |
| 3 | Substitute-compact cell Q1-A3 vs Pacc-5pos | Welch (Q1 promote) | Yes |
| 4 | Substitute-compact cell Q1-A4 vs Pacc-5pos | Welch (Q1 promote) | Yes |
| 5 | Substitute-compact cell Q1-A5 vs Pacc-10pos | Welch (Q1 promote) | Yes |
| 6 | D vs PC | Welch (Q2 superiority) | Yes |
| 7 | D vs S | Welch (Q2 superiority) | Yes |

- **Family count**: 7 superiority Welch tests.
- **Bonferroni-adjusted α**: 0.05 / 7 ≈ **0.00714** per test.
- **TOST tests** (§2.1.2 Q1 deprecation; §2.2.1 Q2 D-promotion equivalence-component): TOST tests are conducted at uncorrected α=0.05 per Phase 5 statistical convention (TOST family is structurally separate from superiority family; corrections are applied within the superiority family only). The Phase 6 ADR will explicitly document this scope choice when reporting.
- Decision rule §2.1.1 promote: Welch p < 0.00714 (Bonferroni-adjusted) AND d ≥ 0.5 AND Δq ≥ +0.10.
- Decision rule §2.2.1 D-promotion superiority component: Welch p < 0.00714 (Bonferroni-adjusted within the same family).

### §7.6 Power analysis

Per brainstorm §1.6 (Q1f power calc):

- **n=50/cell at α=0.05, two-tailed, top-tier SD ~0.04**: power for d=1.0 is >0.999.
- **n=50/cell vs Pacc-variance (SD ~0.47)**: power for Δq=0.10 is ~0.40 (under-powered for medium-effect-vs-Pacc).
- **Mitigation**: pre-registered TOST equivalence margin (§7.3) absorbs the under-power risk — under-power does not false-deprecate as long as the equivalence CI is correctly applied. Phase 6 accepts under-power per user-approved decision row 4.
- **n=10 seeds × 5 fixtures (Q2)**: 50 trials per mode; TOST at ε=0.05, α=0.05, β=0.20 on top-tier SD (~0.04) — n=50 suffices per brainstorm §2.3.

**REF**: brainstorm `2c95e2d` §1.6 (Q1f power), §2.3 (Q2c power); Phase 5 codex review §2 M3 (hierarchical caveat).

---

## §8 Pre-registration Tag

### §8.1 Tag specification

- **Name**: `exec-mode-v6-preregistered-20260502` (or kickoff date if later than 2026-05-02; date suffix tracks the actual tag commit date).
- **Repo**: `~/projects/aigentry-devkit` (same repo as Phase 4 v4 tag and Phase 5 v5 tag; matches Phase 5 spec §5.1).
- **Scope locked by tag**:
  1. Spec commit SHA (this file's commit).
  2. Final fixture identifiers (kebab-slug): H1, H10, H11, H12, H13, H14.
  3. Mode identifiers and per-mode parameters (Q1: 7 mode-cells per §5.1; Q2: 3 modes per §5.2).
  4. Cut grid for substitute-compact: {5, 10, 15, 20} on 5-pos chains; {30} on 10-pos chains.
  5. Chain length grid: {5, 10}.
  6. Cut metric: `input_tokens`.
  7. Trigger endpoint primary: `segment_start_position > 1`; secondary: `cumulative_input_tokens_at_trigger`.
  8. Seed list: `MASTER_SEED=42 + mode_offset + fixture_offset` (Phase 5-equivalent scheme).
  9. Grader harness commit SHA (frozen; H1 + H10 with NB3 patch landed; H11–H14 cross-LLM-reviewed).
  10. `bin/exec-mode-experiment.sh` commit SHA.
  11. substitute-compact-v1 implementation commit SHA (V3 PASS per ADR 2026-04-26-q1-prereq-redesign §4.6).

### §8.2 Tag annotation requirements (verbatim items)

The pre-reg tag annotation MUST include:

1. Pointer to this spec file (path + commit SHA).
2. The 8 user-approved decisions verbatim (§2.6).
3. The 7-row binding hypotheses table (§2.5 rows Q1, Q2 + §2.3 Q3 + §2.4 Q4 + §2.1.1 + §2.1.2 + §2.2.1).
4. Grader commit SHA per fixture.
5. Driver commit SHA (`bin/exec-mode-experiment.sh`).
6. Cut grid + chain length grid (verbatim from §8.1 items 4 + 5).
7. Fixture set list (§8.1 item 2).
8. Total trial count: ~510 (per §3.5; reconciled from dispatch-row figure ~515 per §2.6.1 — both figures cited in annotation for audit).
9. Q4 pilot results (μq per fixture, in/out of [0.5, 0.85] band, revision iteration count).
10. NB3 patch commit SHA (H1 grader patch reference).
11. Bonferroni family count (7) + per-test α (0.00714).
12. Decision rule §9.1, §9.2, §9.3 verbatim (full decision logic combination matrix).

### §8.3 Tag authority

- **Author**: orchestrator (`aigentry-orchestrator-claude`).
- **Approver**: user.
- **Pre-conditions** (all must hold before tag commits):
  1. This spec status = `accepted` (user signoff after spec-document-reviewer pass).
  2. Q4 pilot results published (§3.4); H11–H14 admitted (or fallback to 4-fixture grid documented).
  3. NB3 patch landed in devkit and grader SHA noted.
  4. H11–H14 graders cross-LLM-reviewed and accepted.
  5. Q3 ADR drafted (§10.3); Q3 ADR approval is INDEPENDENT of pre-reg tag commit (Q3 ADR may land before or after Phase 6 pre-reg tag — they are decoupled per §11).
  6. Smoke test: 1 trial per (mode, fixture) cell passes grader at q ≥ 0.0 status="ok" — confirms harness wiring (Phase 5 pre-reg precedent).
  7. Lint exit-0 (Phase 6 binding scope): `~/projects/aigentry-devkit/.venv-exec-mode/bin/python ~/projects/aigentry-devkit/bin/lint-formatting-exemption.py --fixture H1 --fixture H10 --fixture H11 --fixture H12 --fixture H13 --fixture H14` MUST exit 0 (zero violations) before pre-reg tag commit. (Use the venv interpreter explicitly per codex r2 N2 + r4 caveat — bare `python3` may lack `rapidfuzz` dependency. Repo venv is the canonical reproducer.) Scope rationale: Phase 6 binds H1 (in-flight patch), H10 (grandfathered with expiry 2026-08-01), and H11–H14 (NEW Q4 fixtures) per Q3 ADR §2.3. Pre-Phase 6 fixtures (F2–F10, Fa, H2, H3, H5) carry the dormant-bias risk per Q3 ADR §11 + Phase 7 follow-up; their migration is OUT OF SCOPE for the Phase 6 pre-reg gate. Per Q3 ADR §2.4.3 (commit `2ec53bf`) + C1 lint script (devkit commit `f1a8ba1`) + C5 lint-smoke inputs (devkit commit `4b3fa35`).

---

## §9 Decision Logic (binding pre-reg)

### §9.1 Q1 substitute-compact disposition

| Outcome | Trigger | Action |
|---|---|---|
| **Promote** | At least one cell satisfies §2.1.1 (Δq ≥ +0.10 AND Welch p < 0.00714 Bonferroni AND d ≥ 0.5) | Phase 6 ADR promotes substitute-compact to Layer 1 chain-mode candidate; lock winning cut value; sub-ADR `2026-05-01-substitute-compact-revised-cut.md` revised (rev3) to point at winning cell |
| **Deprecate** | All cells satisfy §2.1.2 TOST equivalence (90% CI ⊂ ±0.05 vs matched-chain-length Pacc) AND no cell satisfies §2.1.1 promote criterion | Phase 6 ADR deprecates substitute-compact; sub-ADR superseded by Phase 6 deprecation ADR; mechanism removed from Rule 4-A Step 4 candidate set per Constitution Article 1 경량 |
| **Watchlist** | Neither §2.1.1 promote nor §2.1.2 deprecate triggers (intermediate result) | Mechanism stays in-tree at sub-ADR cut=30 status; Phase 6 ADR carries explicit "no Pareto-relevant separation observed but TOST equivalence not established" footnote; NO Phase 7 substitute-compact arm per gemini D2 time-box |

**Time-box invariant** (gemini D2): the Watchlist outcome does NOT re-open the substitute-compact arm in any future Phase. Promote/Deprecate are the only outcomes that change the rule; Watchlist is documented status and ends the substitute-compact investigation lineage.

### §9.2 Q2 D-promotion disposition

| Outcome | Trigger | Action |
|---|---|---|
| **Promote D to Layer 1 co-equal** | All conditions in §2.2.1 hold (TOST D-vs-PC AND TOST D-vs-S AND superiority/operational-tie-breaker satisfied) | Phase 6 ADR promotes D to Layer 1 co-equal; Rule 4-A Step 4 selector revised to 3-way deterministic single-signal split (selector signal TBD by parent ADR follow-up); ADR 2026-05-01-rule-4-a-step-4-final-lock §4.2 superseded by Phase 6 D-promotion ADR |
| **Maintain D at Layer 2** | §2.2.1 dual TOST does not hold (CI extends past ±0.05 in either pair) | No rule change; D stays at Layer 2 per parent ADR §4.2; Phase 6 ADR documents the result and explicitly closes the codex C3 binding-pre-reg condition |

### §9.3 Q3 fixture rule ADR disposition

| Outcome | Trigger | Action |
|---|---|---|
| **ADR accepted** | Standalone Q3 ADR drafting + reviewer pass + user signoff (parallel architect dispatch per §10.3) | Q3 ADR enters `accepted` status; cascade-grader-rubric review template gains "output-style exemption verified" checkbox; rule applies to all future fixture authors |
| **ADR rejected** (low-probability) | User declines the rule wording during ADR review | Brainstorm §3.2 wording proposed in this spec is NOT bound; Q3 stays open as a non-binding fixture-design recommendation; orchestrator decides next step independent of Phase 6 main outcomes |

### §9.4 Decision combination matrix (2 × 2 outcome states + Q3 follow-up plan)

Q1 has 3 outcomes (promote, deprecate, watchlist); Q2 has 2 outcomes (promote, maintain). 3 × 2 = 6 main combinations. Q3 is decoupled (independent ADR; either ACCEPTED or REJECTED orthogonal to Q1+Q2).

| State | Q1 | Q2 | Phase 6 ADR action |
|---|---|---|---|
| S1 | Promote | Promote | Single Phase 6 ADR: substitute-compact promoted (cell + cut), D promoted Layer 1 co-equal. Rule 4-A Step 4 candidate set = {PC, S, D, substitute-compact-at-winning-cut}. Selector revised. Sub-ADR rev3 + parent ADR §4.2 superseded. |
| S2 | Promote | Maintain | Phase 6 ADR: substitute-compact promoted; D stays Layer 2. Rule 4-A Step 4 set = {PC, S, substitute-compact-at-winning-cut}. Sub-ADR rev3. |
| S3 | Deprecate | Promote | Phase 6 ADR: substitute-compact deprecated (sub-ADR superseded); D promoted Layer 1 co-equal. Rule 4-A Step 4 set = {PC, S, D}. Selector revised. Parent ADR §4.2 superseded. |
| S4 | Deprecate | Maintain | Phase 6 ADR: substitute-compact deprecated; D stays Layer 2. Rule 4-A Step 4 set = {PC, S}. No selector change vs parent ADR. The Phase 6 conclusion ADR primarily documents the deprecation. |
| S5 | Watchlist | Promote | Phase 6 ADR: substitute-compact watchlist (sub-ADR carries footnote, no rev); D promoted Layer 1 co-equal. Rule 4-A Step 4 set = {PC, S, D}. Selector revised. Parent ADR §4.2 superseded. |
| S6 | Watchlist | Maintain | Phase 6 ADR: substitute-compact watchlist; D stays Layer 2. Rule 4-A Step 4 unchanged from parent ADR; Phase 6 ADR primarily documents the watchlist outcome and the closed-loop on codex C3 binding pre-reg for D. |

For all 6 states, Q3 ADR is dispatched in parallel and lands as a separate ADR (no dependency on Q1/Q2 outcomes).

**Codex C3 invariant**: NO post-hoc analyses are added to binding decisions. If exploratory observations surface during the analyst report, they are flagged as exploratory and forwarded to Phase 7 candidates — they cannot retroactively change §9.1 or §9.2 outcomes.

**REF**: brainstorm `2c95e2d` §1.5 (Q1e dual gate), §2.2 (Q2b dual gate), §3 (Q3 standalone), §4 (Q4 enabling).

---

## §10 Implementation Plan

### §10.1 Spec → user approval gate

- This spec status = `proposed` at commit. Spec-document-reviewer dispatch (§10.7) → fix iterations → reviewer PASS → user reviews + approves → status flips to `accepted`. NO downstream work fires until user signoff.

### §10.2 Q4 fixture authorship (dustcraw dispatch) — pre-condition for Q2 trials

- **Dispatch**: orchestrator dispatches `aigentry-dustcraw-{cli}` (cli per Phase 5 cascade-13 author rotation; default gemini for fixture-author diversity per Phase 4/5 invariant).
- **Deliverable**: dustcraw spec at `~/projects/aigentry-dustcraw/docs/research/2026-05-XX-phase6-fixture-candidates.md` containing:
  1. H11, H12, H13, H14 fixture descriptions + ground-truth + grader code.
  2. Domain-coverage mapping (per §4.4 contract).
  3. Output-style guard implementation per fixture grader (per §6.3 + Q3 rule).
  4. Pilot trial results (μq per fixture in mode D; 5 trials each).
- **Pre-condition**: Q4 pilot pass (§3.4) before Q2 trials fire. If a fixture fails pilot, dustcraw revises (1 iteration) or fall back to 4-fixture Q2 grid is invoked.

### §10.3 Q3 ADR drafting (parallel architect dispatch)

- **Dispatch**: orchestrator dispatches a separate architect session for Q3 ADR drafting in PARALLEL with this spec's reviewer loop.
- **Deliverable**: ADR `~/projects/aigentry-orchestrator/docs/adr/2026-05-XX-fixture-design-output-style-exemption.md`.
- **Tier**: T1 (cross-project; per architect AGENTS.md §7).
- **Reviewer count**: 1 (T1 default).
- **Why parallel, not bundled**: Q3 ADR is a permanent fixture-design rule; bundling it into this Phase 6 spec would tie its supersedability to Phase 6 outcomes, violating durable-rule design (per brainstorm §3.1 Q3a, parent ADR §11 Q3 forward).

### §10.4 Grader authoring + cross-LLM review (cascade-13 pattern)

- **Authoring**: H11–H14 graders are part of the dustcraw deliverable (§10.2); H1 NB3 patch is a separate cascade-grader-rubric review session (orchestrator dispatch).
- **Review pattern**: Phase 5 cascade-13 (a/b/c/d) — multi-round cross-LLM review, max 5 iterations per grader, orchestrator T-2 known-issue process for convergence-bounded acceptance per Phase 5 §5.4.
- **Output**: grader review reports at `~/projects/aigentry-devkit/docs/reviews/2026-05-XX-phase6-grader-rubric-review-{cli}-{round}.md`.
- **Pre-condition**: all H11–H14 grader reviews + H1 NB3 patch land BEFORE pre-reg tag commits (§8.3 #4 + #3).

### §10.5 Pre-reg tag commit

- **Author**: orchestrator (`aigentry-orchestrator-claude`).
- **Approver**: user.
- **Tag**: `exec-mode-v6-preregistered-YYYYMMDD` per §8.1.
- **Pre-conditions**: §8.3 (six items).
- **Annotation**: per §8.2 (twelve items).
- **Repo**: `~/projects/aigentry-devkit`.

### §10.6 Trial fire (~10 hr wall, 6-runner parallel split possible)

- **Total trials**: ~510 per §3.5.
- **Parallelism**: 6-runner scheme per Phase 5; ~510 trials at ~95 trials/hour aggregate → ~5.5 hours fire-only.
- **Two 5-hour cycles**: cycle 1 covers Q4 pilot (20 trials) + Q1 (350 trials); cycle 2 covers Q2 (150 trials) + retry buffer per brainstorm §5.3.
- **Runner sessions**: aigentry-devkit runner sessions claimed at fire kickoff; standard Phase 5 dispatch pattern (telepty inject from orchestrator).
- **Failure modes**: per §11 (matching Phase 5 spec §9 patterns).

### §10.7 Final analysis + 3-LLM cross-review (cascade pattern)

- **Analyst session**: aigentry-devkit analyst session (claude) drafts Phase 6 final analysis report at `~/projects/aigentry-devkit/docs/reports/2026-05-XX-phase6-final-analysis.md`.
- **Cross-LLM review**: 3-LLM cascade per Phase 5 (claude analyst → codex review → gemini review). Each reviewer evaluates Q1, Q2, Q4 pilot results against the binding decision rules (§9). NO post-hoc reweighting per codex C3.
- **Wording discipline**: per §7.3 — "equivalence" only in TOST contexts; "no separation" elsewhere. All reviewers enforce.

### §10.8 Final ADR (Phase 6 conclusion)

- **Author**: architect session (NEW, not this session — this session is the spec author per architect AGENTS.md §2 handoff).
- **Output**: Phase 6 conclusion ADR at `~/projects/aigentry-orchestrator/docs/adr/2026-05-XX-rule-4-a-step-4-phase6-{state-suffix}.md`. State suffix per §9.4 outcome row (e.g., `-substitute-deprecated-d-promoted` for state S3).
- **Cross-LLM review**: per architect AGENTS.md tier matrix. Q1/Q2 outcome ADRs are typically T2 (≥2 reviewers) per cross-project decision_type two-way default.
- **User Acceptance**: final gate.

---

## §11 Time-box (gemini D2 lock-in) and Failure Modes

### §11.1 Time-box invariants (locked, non-negotiable)

| Sub-question | Time-box | Constitution anchor |
|---|---|---|
| Q1 substitute-compact | This is the FINAL Phase. No-effect → deprecate per Constitution Article 1 경량. NO Phase 7 substitute-compact arm. | gemini D2; brainstorm §1 problem statement; parent ADR §11 D2 row |
| Q2 D-promotion | Standalone test; NO time-box. Re-test allowed in Phase 7+ if needed (NOT subject to gemini D2). | brainstorm §2.2 |
| Q3 fixture rule | ADR is permanent regardless of Phase 6 outcome. | brainstorm §3.1; parent ADR §11 D3 |
| Q4 pilot | Enabling-only; not subject to time-box. | brainstorm §4 |

### §11.2 Failure modes

| Failure | Symptom | Response |
|---|---|---|
| Q4 pilot fails ALL fixtures | All H11–H14 μq outside [0.5, 0.85] after revision | Q2 grid drops to 1 fixture (H1); Q2 grid sample size insufficient for §2.2.1 binding test → Q2 RESCHEDULED to Phase 7; Q1 + Q3 proceed independently |
| Q4 pilot fails 2 fixtures | 2 of 4 fail; 2 pass after revision | Q2 grid uses H1 + 2 of {H11–H14} = 3 fixtures (NOT the same 4-fixture fallback as the NB3-fail row below); sample size reduced (3 modes × 3 fixtures × 10 = 90 trials, n=30 per mode); orchestrator decides whether to proceed at reduced power or reschedule Q2 |
| Trial count <510 (technical run failures) | Missing (mode, fixture, seed) cells | Re-fire missing cells under SAME pre-reg tag; if re-fire impossible, scope reduction documented and re-pre-reg required (Phase 5 spec §9 pattern) |
| Schema corruption | metrics.json schema_version mismatch | Quarantine corrupt cells; analyst report covers only schema-valid subset |
| Pre-reg tag drift | Grader/harness commit changes between tag and last trial | INVALIDATE the entire Phase 6; re-tag and re-fire — non-negotiable per Constitution Rule 5 (Phase 5 §9 invariant) |
| Substitute-compact V3 regression | byte-equality breaks under any cut | HALT Phase 6 Q1 arm; analyst diagnostics; Q1 cells dropped from Phase 6 (Q2 + Q3 proceed if independent — they ARE independent per §10) |
| NB3 patch fails review | Cascade-grader-rubric review on H1 NB3 patch returns BLOCK after 5 iterations | H1 retired from Phase 6; Q1 falls back to H10 only (single fixture per Q1 cell); Q2 falls back to 4-fixture grid (drop H1, use H11–H14 only) |
| Q3 ADR rejected by user | User declines proposed wording | Q3 stays open; brainstorm §3.2 wording filed as non-binding recommendation; cascade-grader-rubric template adds the checkbox per §6.3 anyway (devkit-internal convention, not ADR-bound) |

### §11.3 Convergence escalation

- Spec-document-reviewer loop (§10.7) max 5 iterations per Phase 5 cascade-13 precedent. Convergence failure → escalate to user per architect AGENTS.md §3.
- Grader review iterations max 5 per grader per Phase 5 §5.4 process; orchestrator T-2 known-issue path applies for convergence-bounded acceptance.

---

## §12 Open Sub-Questions (forwarded; not blocking)

These are minor open questions surfaced during spec drafting, forwarded to spec-document-reviewer for flagging. NONE block Phase 6 execution; all are documented for Phase 7+ tracking.

### §12.1 OQ-P6-1 — Selector signal for 3-way Layer 1 split (only relevant if §9.4 state S1, S3, or S5)

If D promotes to Layer 1 co-equal, the Rule 4-A Step 4 selector becomes 3-way (PC, S, D) instead of the current 2-way (PC, S). The single-signal selector for the 3-way split is NOT pre-registered in this Phase 6 spec — it is a parent-ADR follow-up decision (separate architect dispatch on Phase 6 conclusion). **Forwarded to**: Phase 6 conclusion ADR or follow-up.

### §12.2 OQ-P6-2 — Q1 cell-level vs joint promotion criterion

§2.1.1 says "at least one cell" satisfies the dual gate (Δq ≥ +0.10 AND p < 0.00714 AND d ≥ 0.5). Question: if multiple cells satisfy, do we promote the cut value of the strongest cell, or interpolate? Spec defaults to "strongest single cell wins" per minimum-assumption fallback; alternative "monotone-curve fit" approach is NOT pre-registered. **Forwarded to**: spec-document-reviewer flag.

### §12.3 OQ-P6-3 — Q2 superiority vs operational-tie-breaker decision branch

§2.2.1 dual-gate has two sub-branches: (a) D superior to lower of {PC, S} at p < 0.00714 → promote on superiority; (b) equivalence-only (TOST holds, superiority p ≥ 0.00714) → promote on operational-tie-breaker (D non-chain, cross-CLI portable). The split between (a) and (b) is documented in §2.2.1 but the **outcome wording** in the Phase 6 ADR will differ between the two branches. **Forwarded to**: Phase 6 conclusion ADR drafting guidance.

### §12.4 OQ-P6-4 — TOST exemption from Bonferroni family

§7.5 places TOST tests outside the Bonferroni superiority family; §9.1 deprecation criterion uses uncorrected α=0.05 for TOST. Question: should TOST tests join the Bonferroni family? Spec says NO per Phase 5 statistical convention; revisit if Phase 6 reviewer pushes back. **Forwarded to**: spec-document-reviewer flag.

### §12.5 OQ-P6-5 — H10 pairing in Q2 grid

§3.2 Q2 grid uses H1 + H11–H14 (5 fixtures); H10 is NOT in the Q2 grid. Rationale: H10 is easy-difficulty and is reused for Q1 to balance non-ceiling fixture coverage in Q1 cells; adding H10 to Q2 would expand the Q2 grid to 6 fixtures = 180 trials and exceed the cost ceiling (§3.5). **Forwarded to**: spec-document-reviewer flag — alternative would drop one H1*-fixture from Q1 to free budget for H10 in Q2.

---

## §13 References

- Brainstorm proposal (this spec's source of approaches): `~/projects/aigentry-architect/docs/superpowers/proposals/2026-05-01-phase6-brainstorm.md` (commit `2c95e2d`)
- Parent ADR: `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` (§11 Phase 6 stub)
- Sibling sub-ADR: `docs/adr/2026-05-01-substitute-compact-revised-cut.md`
- Substitute-compact-v1 spec: `docs/adr/2026-04-26-q1-prereq-redesign.md`
- Phase 5 spec (structural reference): `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md`
- Phase 5 final analysis: `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-final-analysis.md`
- Phase 5 codex review: `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-codex-review.md`
- Phase 5 gemini review: `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-gemini-review.md`
- Phase 4 reference: `~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md`
- Phase 5 pre-reg tag: `exec-mode-v5-holdout-preregistered-20260501` (devkit)

---

*End of Phase 6 spec. Status remains `proposed` until spec-document-reviewer PASS + user signoff.*
