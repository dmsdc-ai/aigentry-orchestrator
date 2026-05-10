---
type: adr
status: accepted
accepted_date: 2026-05-04
accepted_by: orchestrator (oikim signoff via aigentry-orchestrator)
date: 2026-05-03
author: aigentry-architect-phase6-q2-sub-adr
scope: ecosystem
decision_type: one-way
tier: T2
amends: ["docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"]
related:
  - "docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"
  - "docs/adr/2026-05-03-substitute-compact-phase6-promote.md"
  - "docs/adr/2026-05-02-output-style-fixture-design-rule.md"
  - "docs/adr/2026-04-22-rule-4-mode-selection.md"
  - "docs/superpowers/specs/2026-05-02-phase6-design.md"
related_tasks: [329]
track: "#329 E27 — Phase 6 Q2"
tags: [phase6, q2, d-promotion, layer-1, rule-4-a, step-4, tost-equivalence, branch-b, operational-tie-breaker]
---

# ADR 2026-05-03 (sub): D-Promotion Phase 6 Q2 PROMOTE Lock (Layer 1 Co-Equal via TOST Equivalence + Branch (b) Operational Tie-Breaker)

## §1 Status, Context, Amends

- **Status**: **accepted** (2026-05-04, oikim signoff via aigentry-orchestrator after spec-reviewer 1-iter PASS + codex 8d7c970 + gemini ACCEPT_WITH_CONDITIONS consensus; 9/9 conditions integrated, 0 waivers).
- **Date**: 2026-05-03.
- **Track**: #329 E27 — Phase 6 Q2 sub-decision.
- **Author**: `aigentry-architect-phase6-q2-sub-adr` (claude opus 4.7 1M, dispatched via SAWP under aigentry-orchestrator authority).
- **Amends**: `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4.2 (D maintained at Layer 2 → D PROMOTED to Layer 1 co-equal). Record-of-change pattern per parent ADR §11 sacred-but-amendable contract; mirror of Q1 sub-ADR's §4.5 amendment (parent ADR commit `abda5dd`). The historical §4.2 disposition (D maintained at Layer 2) is preserved verbatim for audit; the 2026-05-03 PROMOTE update is additive.
- **Related (active)**:
  - Parent: `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4.2 (D Layer 2 maintained, to be amended), §11 (Phase 6 Pre-registration Stub D-promotion bullet), §12 OQ (forwarded).
  - Sister sub-ADR: `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` (Q1 PROMOTE accepted commit `c758a49`, parent §4.5 amendment commit `abda5dd`). Together this Q2 sub-ADR + the Q1 sub-ADR realize Phase 6 spec §9.4 outcome state **S1** (Q1 promote + Q2 promote).
  - Decoupled sibling: `docs/adr/2026-05-02-output-style-fixture-design-rule.md` (Q3 fixture-design rule, accepted independently).
  - Phase 6 spec: `docs/superpowers/specs/2026-05-02-phase6-design.md` §2.2 + §2.2.1 + §2.2.2, §3.2 + §3.2.1 (active design + fallback), §7.1 + §7.3 + §7.5 (statistical conventions + Bonferroni family + wording discipline), §9.2 + §9.4 (decision matrix + outcome states), §10.7 (sensitivity scope), §12.1 (OQ-P6-1) + §12.3 (OQ-P6-3).
- **Pre-registration tag (frozen, sealed)**: `exec-mode-v6-preregistered-20260502` (devkit `4eefc0a`; spec base `8b4e156` + amendments `ee6e2c7`, `555daf6`, `90d0a3a`, `9a76c12`, `6ec2237`). Q2 binding endpoints §2.2.1 + §2.2.2 unchanged. The §3.2.1 fallback grid (H1+H10 only, n=25 × 2 fixtures × 3 modes = 150 trials per-mode N=50 preserved) was committed at orchestrator `6ec2237` post-tag, pre-fire as a pre-registered fallback path per §3.4 reject + §3.4.1 #6 HARD LIMIT (Q4 r5 0/8 PASS [0.5, 0.85] ∧ σ ≥ 0.05 acceptance criterion; iteration limit reached). Tag itself remains immutable per spec §8 + parent ADR §11.
- **Decision type**: **one-way** — D's promotion to Layer 1 co-equal alters the Rule 4-A Step 4 candidate set composition; the Phase 6 conclusion ADR's deterministic 4-way selector and the parent ADR §4.4 Pacc-sunset migration table (Layer 2 row) will rely on this lock. Reversal would require a Phase 7+ deprecation ADR (Constitution Article 1 경량). This mirrors the Q1 sister sub-ADR's `decision_type: one-way` rationale: promotion-of-mode is a forward commitment.
- **Scope**: **ecosystem** — binds orchestrator routing across all Claude-only chain-mode decisions (Rule 4-0 narrow lock scope unchanged; cross-CLI extension is forwarded per §6 + §10.6).
- **Tier**: **T2** (adr × ecosystem × one-way per `references/frontmatter-schema.md`). Reviewer threshold = 2, satisfied verbatim by integrated cross-LLM review evidence: codex `aigentry-reviewer-phase6-q2-codex` (devkit commit `8d7c970`, ACCEPT_WITH_CONDITIONS, 0 BLOCKERS / 5 MAJORS / 3 MINORS, 6 conditions M1–M5 + N3 distilled to dispatch's 6 sub-ADR conditions §12.1–§12.6) + gemini `aigentry-reviewer-phase6-q2-gemini` (uncommitted file `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-gemini-review.md`, ACCEPT_WITH_CONDITIONS, 0 BLOCKERS / 2 MAJORS / 1 MINOR, 3 conditions G-1 / G-2 / G-3). Both reviewers operated on the binding analyst report devkit commit `737a247`.

### §1.1 Why this sub-ADR now

Parent ADR §4.2 maintained D at Layer 2 on the basis of (i) the Phase 5 PC=S=D triple-tie being post-hoc exploratory (not pre-registered, codex C3 binding-only-on-pre-reg), and (ii) gemini's Phase 5 review explicitly recommending D-promotion=no until pre-registered evidence existed. Parent ADR §4.2 closing sentence flagged the open question for Phase 6: *"should D be promoted given the Phase 5 holdout-robustness signal? Phase 6 must pre-register the test (binding hypothesis, mode-pair adjudication rule, fixture set, n) before re-evaluating."*

Phase 6 Q2 satisfied all four pre-registration requirements verbatim and fired 150 trials (0 failures) on the immutable tag `exec-mode-v6-preregistered-20260502`:

- **Binding hypothesis**: §2.2.1 dual-gate (TOST equivalence vs PC + TOST equivalence vs S + superiority OR operational tie-breaker per branch (b)) + §2.2.2 maintain-status fallback.
- **Mode-pair adjudication rule**: TOST at ε=±0.05, α=0.05; superiority Welch one-sided at Bonferroni α=0.05/7=0.00714 (spec §7.5 family of 7); branch (a)/(b) split per §12.3 OQ-P6-3.
- **Fixture set**: H1 + H10 (post-§3.2.1 fallback; per-mode N=50 preserved; external validity scoped to H1+H10 task surface per §3.2.1 caveat).
- **n**: 25 trials per cell × 2 fixtures × 3 modes = 150 trials.

The analyst's binding §2.2.1 dual-gate test resolved verbatim per spec §9.2 row 1 outcome ("PROMOTE D to Layer 1 co-equal alongside PC and S"): TOST D-vs-PC PASS (90% CI [-0.0044, +0.0182] ⊂ ±0.05; p_max=8.09e-09), TOST D-vs-S PASS (90% CI [-0.0034, +0.0263] ⊂ ±0.05; p_max=2.70e-05), superiority NS (Welch one-sided p=0.10065 ≥ Bonferroni 0.00714; Mann-Whitney p=0.31330) → **branch (b) operational tie-breaker activates** per spec §2.2.1 last bullet + §12.3 OQ-P6-3. §2.2.2 maintain hypothesis NOT triggered (TOST holds for both pairs). The pre-registered Phase 6 §9.2 row 1 outcome ("Promote D to Layer 1 co-equal") is in scope.

Holding the parent ADR §4.2 disposition unrevised after this binding pre-registered evidence would block: (a) the Phase 6 conclusion ADR composition into a unified Step 4 candidate set per spec §9.4 row S1; (b) AGENTS.md / docs/rules.md propagation; (c) Constitution Article 5 (최선) commitment to evidence-based mode-class assignment. This sub-ADR locks the PROMOTE decision with explicit branch (b) transparency, integrates the 9 cross-LLM conditions verbatim, proposes the 4-way Layer 1 selector design (OQ-P6-1) for Phase 6 conclusion ADR resolution, and amends parent ADR §4.2 via record-of-change.

### §1.2 Inputs synthesized (binding evidence)

| Input | Path | Frozen ref |
|---|---|---|
| Phase 6 Q2 final analysis (analyst) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-final-analysis.md` | devkit `737a247` |
| Phase 6 Q2 codex review (6 conditions) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-codex-review.md` | devkit `8d7c970` |
| Phase 6 Q2 gemini review (3 conditions) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-gemini-review.md` | uncommitted (referenced via shared context) |
| Phase 6 Q2 fire report (runner) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-fire.md` | devkit `f969bf5` |
| Phase 6 spec (binding hypotheses) | `docs/superpowers/specs/2026-05-02-phase6-design.md` | this repo (spec base `8b4e156` + amendments incl. `6ec2237`) |
| Pre-reg tag annotation | `git -C ~/projects/aigentry-devkit show exec-mode-v6-preregistered-20260502` | devkit tag → `4eefc0a` |
| Q1 sister sub-ADR (PROMOTE template) | `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` | this repo (commit `c758a49`; parent §4.5 amendment `abda5dd`) |
| Parent ADR (final lock) | `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` | this repo (post `abda5dd` amendment) |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 5, 9, 13, 17 | this repo |

---

## §2 Decision Summary

D mode is **PROMOTED** to Rule 4-A Step 4 Layer 1 co-equal chain-mode candidate (alongside PC and S, with the Q1-promoted substitute-compact-conditional joining as the fourth Layer 1 candidate per spec §9.4 row S1) based on Phase 6 Q2 binding pre-registered evidence: TOST equivalence vs PC PASS, TOST equivalence vs S PASS, one-sided superiority NS at Bonferroni α=0.00714, **branch (b) operational tie-breaker activated** per spec §2.2.1 last bullet + §12.3 OQ-P6-3. The PROMOTE basis is **statistical equivalence within ε=±0.05 plus a pre-registered operational policy tie-breaker** — NOT statistical superiority and NOT Q2-validated cross-CLI evidence (Q2 was Claude-only; cross-CLI portability is an architectural assumption inherited from Rule 4-A Step 5, forwarded to Phase 7+ verification per §6.2 + §10.6 #1). H10 ceiling-saturation, generalizability narrowing to H1+H10 task surface (§3.2.1 fallback consequence), and SD=0 methodology handling are documented caveats forwarded as Phase 7+ binding follow-ups. The 4-way Layer 1 deterministic single-signal selector (OQ-P6-1) is **proposed in §4.3** and **locked in the Phase 6 conclusion ADR** (separate architect dispatch per spec §10.8).

---

## §3 Evidence Base

Total binding evidence: **150 Q2 trials** under tag `exec-mode-v6-preregistered-20260502` (post-§3.2.1 amendment). 0 failures, 150/150 `status=ok`, 6/6 cells at n=25, pre-registration adherence audit PASS (analyst §1, codex §1, gemini §1).

### §3.1 Phase trajectory (record of D mode-class re-evaluation)

| Phase | n | D verdict | Reason |
|---|---:|---|---|
| Phase 4c (parent ADR predecessor) | 800 | D Layer 2 (default for non-chain dispatch) | Replication-grade Phase 4 lock; D not in Layer 1 candidate set |
| Phase 5 holdout (parent ADR §3.7 + §4.2) | 300 (50 D / 50 PC / 50 S among 6 modes) | D **maintained Layer 2** | PC=S=D triple-tie (Δq=−0.003 D-PC; Δq=−0.003 D-S; Welch p ∈ [0.6572, 0.7012]) was **post-hoc exploratory** (codex C3, parent ADR §3.7); not a pre-registered family. D-promotion=no per gemini Phase 5 review |
| **Phase 6 Q2** (this sub-ADR's binding base) | **150** | **PROMOTE Layer 1 co-equal** | §2.2.1 dual-gate satisfied: TOST D-vs-PC PASS + TOST D-vs-S PASS + branch (b) operational tie-breaker activated (analyst §4.1–§4.4, codex §3, gemini §2) |

The Phase 5 D-maintain disposition was correct under Phase 5's missing-pre-registration constraint (gemini's Phase 5 review explicitly tied D-maintain to that absence). The Q2 binding pre-registration satisfies the missing condition (TOST equivalence on a pre-registered grid) and **the reversal is justified** (gemini §1 verbatim: "the prior D-maintain was strictly dependent on the absence of pre-registration, and the Q2 binding satisfies this missing condition (TOST equivalence established on a pre-registered grid), the REVERSAL IS JUSTIFIED").

### §3.2 Phase 6 Q2 binding aggregates (analyst §2 + §4; codex §3 reproduced)

Per-mode aggregates over H1+H10 (binding endpoint per spec §3.2 + §3.2.1):

| Mode | N | mean q | SD q | 95% CI (boot, B=20000) | total cost ($) |
|---|---:|---:|---:|---|---:|
| **D**  | 50 | 0.97825 | 0.0220 | [0.9722, 0.9843] | 19.1553 |
| **PC** | 50 | 0.97136 | 0.0427 | [0.9582, 0.9817] | 18.3377 |
| **S**  | 50 | 0.96677 | 0.0589 | [0.9486, 0.9806] | 18.4853 |

Δ(D − PC) = +0.00689; Δ(D − S) = +0.01148. Both deltas are an order of magnitude smaller than the equivalence margin ε = ±0.05.

Per-cell aggregates (n=25 each; analyst §2 + fire report devkit `f969bf5`):

| Cell | n | mean q | SD q | mean cost ($) | mean wall (s) |
|---|---:|---:|---:|---:|---:|
| Q2-D-H1   | 25 | 0.9565 | **0.0000** | 0.2926 | 73.7 |
| Q2-D-H10  | 25 | 1.0000 | **0.0000** | 0.4736 | 128.2 |
| Q2-PC-H1  | 25 | 0.9477 | 0.0439 | 0.2867 | 73.9 |
| Q2-PC-H10 | 25 | 0.9950 | 0.0250 | 0.4468 | 121.0 |
| Q2-S-H1   | 25 | 0.9485 | 0.0275 | 0.2810 | 73.6 |
| Q2-S-H10  | 25 | 0.9850 | 0.0750 | 0.4584 | 125.5 |

The two D cells exhibit SD = 0.0000 (deterministic across all 25 seeds within each cell). This is **NOT a bug, NOT a cache artifact, NOT a grader discreteness artifact** — it is the structural manifestation of D mode's non-chain property under fixed fixtures and near-deterministic Claude inference at low temperature (analyst §3.1; codex §2.1 verified by independent recompute on the 50 raw `metrics.json` files). Statistical handling of the SD=0 cells is documented in §6.

### §3.3 §2.2.1 Promotion dual-gate (BINDING) — verbatim recompute

Per spec §2.2.1 verbatim: "Decision rule (D-promote to Layer 1 co-equal): ALL of: TOST at ε = ±0.05, α = 0.05 (90% CI ⊂ [-0.05, +0.05]) holds for D-vs-PC. TOST at ε = ±0.05, α = 0.05 holds for D-vs-S. One-sided superiority test of D vs the lower of {PC, S} returns p < 0.05 OR equivalence is the strongest claim (in which case D promoted on the operational-advantage tie-breaker per brainstorm §2.2: D is non-chain, no chain-state burden, cross-CLI portable per Rule 4-A Step 5)."

#### §3.3.1 TOST D vs PC (binding)

| Quantity | Value | Source |
|---|---|---|
| Δ = mean(D) − mean(PC) | **+0.006894** | analyst §4.1; codex §3.1 reproduced |
| SE (Welch) | 0.0067896 | analyst §4.1; codex §3.1 |
| Welch–Satterthwaite df | 73.2583 | codex §3.1 |
| 90% CI on Δ | **[−0.004417, +0.018205]** | analyst §4.1; codex §3.1 |
| Required CI containment | ⊂ (−0.05, +0.05) | spec §2.2.1 H1 |
| TOST p_lower | 1.33e-12 | codex §3.1 |
| TOST p_upper | 8.09e-09 | codex §3.1 |
| TOST p_max | **8.09e-09** | analyst §4.1; codex §3.1 |
| **Equivalent at α = 0.05?** | **YES ✓** | analyst §4.1; codex §3.1 verdict CONFIRMED |
| Bootstrap 95% CI on Δ (B=20000) | [−0.0052, +0.0214] | analyst §4.1 |

#### §3.3.2 TOST D vs S (binding)

| Quantity | Value | Source |
|---|---|---|
| Δ = mean(D) − mean(S) | **+0.011476** | analyst §4.2; codex §3.2 reproduced |
| SE (Welch) | 0.0088857 | analyst §4.2; codex §3.2 |
| Welch–Satterthwaite df | 62.3924 | codex §3.2 |
| 90% CI on Δ | **[−0.003360, +0.026312]** | analyst §4.2; codex §3.2 |
| TOST p_max | **2.70e-05** | analyst §4.2; codex §3.2 |
| **Equivalent at α = 0.05?** | **YES ✓** | analyst §4.2; codex §3.2 verdict CONFIRMED |
| Bootstrap 95% CI on Δ (B=20000) | [−0.0032, +0.0307] | analyst §4.2 |

#### §3.3.3 Superiority component (binding superiority gate)

mean(PC) = 0.97136 and mean(S) = 0.96677 → **lower of {PC, S} = S**. Per spec §2.2.1, the binding superiority test is **D vs S**.

| Test | Statistic | p (one-sided, alt=greater) | At α | Source |
|---|---|---|---|---|
| Welch one-sided D > S | t = 1.2915, df = 62.3924 | **0.100645** | NS at α = 0.05 (uncorrected); NS at Bonferroni α = 0.00714 | analyst §4.3; codex §3.3 |
| Mann-Whitney U one-sided | U = 1312.5 | 0.313303 (asymptotic); 0.336452 (exact-with-ties) | NS | analyst §3.2 Method 2; codex §2.3 |
| Cohen d (pooled) | — | — | +0.258 (small effect) | analyst §8.1; codex §3.3 |
| Welch one-sided D > PC (informational; spec §7.5 family member) | t recomputed | **0.156635** (codex §4) | NS at α = 0.05 and at Bonferroni α = 0.00714 | codex §4 N3 (auditability completeness; not a binding gate per §2.2.1 lower-of-incumbents wording) |

**Superiority arm verdict**: D-vs-S Welch p = 0.10065 ≥ 0.05 (uncorrected) and ≥ 0.00714 (Bonferroni-adjusted per spec §7.5 family of 7: 5 Q1 sc-vs-Pacc + 2 Q2 D-vs-{PC,S}). Branch (a) of §2.2.1 last bullet (Welch p < 0.05) **NOT satisfied**. Branch (b) (equivalence is the strongest statistical claim) **activates** — see §3.3.4.

#### §3.3.4 §2.2.1 last-bullet branch (b) — operational tie-breaker (BINDING)

Per spec §12.3 OQ-P6-3 wording resolution (forwarded for outcome-wording, not blocking): **branch (b)** = TOST holds for both pairs AND superiority p ≥ 0.00714 → promote on operational-advantage tie-breaker per spec §2.2.1 + parent ADR §4.2 + Rule 4-A Step 5. All sub-conditions hold:

- TOST D-vs-PC ✓ (§3.3.1 — p_max = 8.09e-09; 90% CI ⊂ ±0.05)
- TOST D-vs-S ✓ (§3.3.2 — p_max = 2.70e-05; 90% CI ⊂ ±0.05)
- Superiority p (Welch one-sided D > S) = 0.10065 ≥ 0.00714 ✓ (branch (b) trigger condition)
- Operational tie-breaker basis (§4.2 below documents transparency limits) ✓

**Verdict**: §2.2.1 dual-gate **PROMOTE under branch (b)** per spec §9.2 row 1 outcome.

### §3.4 §2.2.2 Maintain hypothesis — NOT TRIGGERED

Per spec §2.2.2 verbatim: "Decision rule (maintain Layer 2 D): §2.2.1 dual TOST does not hold (CI extends past ±0.05 in either pair)." Both TOSTs hold by clear margins (§3.3.1 + §3.3.2): D-vs-PC 90% CI = [−0.004, +0.018] ⊂ (−0.05, +0.05) with 0.032 margin on the upper bound and 0.046 on the lower; D-vs-S 90% CI = [−0.003, +0.026] ⊂ (−0.05, +0.05) with 0.024 upper and 0.047 lower. **§2.2.2 is NOT the outcome.**

### §3.5 H1-only sensitivity (not binding; agrees with aggregate per spec §10.7 sensitivity scope)

Per spec §3.2 + §3.2.1 the binding endpoint is the per-mode aggregate over H1+H10; per-fixture decomposition is sensitivity per spec §10.7. H1-only stratification (n=25/cell, free of H10 ceiling-saturation per §5):

| H1 test | Δ | 90% CI on Δ | TOST equivalent? | Welch sup. p | MW asymptotic p | Cohen d |
|---|---:|---|---|---:|---:|---:|
| D vs PC (H1) | +0.0088 | [−0.0062, +0.0238] | **YES ✓** (codex §5 PASS) | 0.16364 (NS) | 0.168528 | +0.283 |
| D vs S  (H1) | +0.0080 | [−0.0015, +0.0174] | **YES ✓** (codex §5 PASS) | 0.08075 (NS) | 0.080713 | +0.409 |

H1-only verdict **agrees** with the aggregate binding verdict: TOST holds for both pairs; superiority remains non-significant. The branch (b) operational tie-breaker pathway is independently satisfied on H1 alone — the H10 ceiling does not drive the verdict (§5).

### §3.6 H10 stratification (sensitivity; ceiling-saturated per §5)

| H10 test | Δ | 90% CI on Δ | TOST equivalent? | Source |
|---|---:|---|---|---|
| D vs PC (H10) | +0.0050 | [−0.0036, +0.0136] | **YES ✓** (codex §6 PASS, p_max=1.85e-09) | analyst §6.2; codex §6 |
| D vs S  (H10) | +0.0150 | [−0.0107, +0.0407] | **YES ✓** (loosest cell; p_max=0.014169 < 0.05) | analyst §6.2; codex §6 |

All four per-fixture TOSTs (4/4) PASS. The verdict is robust across fixture strata (§5 acknowledges H10 ceiling caveat per cross-LLM consensus; H1 carries the discriminative signal).

---

## §4 Decision (HARD-NUMBERED — locked text)

### §4.1 D PROMOTION verdict

**D mode is PROMOTED** to Rule 4-A Step 4 Layer 1 co-equal chain-mode candidate (Phase 6 spec §9.2 row 1 outcome, branch (b) per OQ-P6-3 wording).

- **TOST equivalence D vs PC**: 90% CI [−0.0044, +0.0182] ⊂ (−0.05, +0.05); p_max = 8.09e-09 ≪ 0.05. **CONFIRMED equivalent at ε=±0.05, α=0.05.**
- **TOST equivalence D vs S**: 90% CI [−0.0034, +0.0263] ⊂ (−0.05, +0.05); p_max = 2.70e-05 ≪ 0.05. **CONFIRMED equivalent at ε=±0.05, α=0.05.**
- **Superiority D vs lower of {PC, S} = S**: Welch one-sided p = 0.10065 (NS at α=0.05; NS at Bonferroni α=0.00714). Mann-Whitney p = 0.31330 (NS). **NOT significant** — branch (a) of §2.2.1 last bullet not satisfied.
- **Branch (b) operational tie-breaker**: ACTIVATED per spec §2.2.1 last bullet + §12.3 OQ-P6-3 wording. PROMOTE under branch (b).

Layer assignment per parent ADR §4.1 / §4.2 / §4.3 horizon-layer terminology (workload-horizon Layer 1 / 2 / 3): D joins **Layer 1** as a co-equal chain-mode candidate alongside PC and S (with substitute-compact-conditional joining per Q1 sister sub-ADR `2026-05-03-substitute-compact-phase6-promote.md` §4.1). Layer 2 (mid-horizon accumulated state, parent §4.2 prior disposition) is **vacated by D's promotion** — see §4.4 record-of-change for parent ADR §4.2 amendment.

Time-box invariant (gemini D2 carry-over per Q1 sub-ADR §11.3 + Phase 6 spec §11.1): Phase 6 was the final mechanism Phase. PROMOTE outcome closes the D mode-class re-evaluation lineage; no Phase 7 D-promotion ARM is dispatched. Phase 7+ follow-ups (§10.6) are *follow-up analyses* on Q2 data and *external-validity / cross-CLI extensions* — they do not re-open the mode-class question.

### §4.2 Branch (b) transparency (cross-LLM top issue — codex M1 + M2; gemini §2 concerning)

**CRITICAL — both reviewers independently flagged this as the top issue.** The PROMOTE basis must not be conflated with statistical superiority or with Q2-validated cross-CLI evidence. This sub-ADR makes the basis explicit and verbatim:

The D PROMOTE decision rests on **two distinct components**:

1. **Statistical equivalence component (empirical, data-driven from Q2 binding)**:
   - TOST D-vs-PC at ε=±0.05, α=0.05: equivalent (p_max = 8.09e-09).
   - TOST D-vs-S at ε=±0.05, α=0.05: equivalent (p_max = 2.70e-05).
   - These are pre-registered binding statistical results from 150 Q2 trials on the immutable tag `exec-mode-v6-preregistered-20260502`.

2. **Operational-policy component (pre-registered tie-breaker, NOT statistical superiority and NOT new cross-CLI empirical evidence)**:
   - **D non-chain**: verified by Q2 runner harness inspection — D trials have `position_in_chain=null`, no D `chain_sess*.json` files exist, harness cold-starts each D trial with `setup_history.md + task_prompt.md` to a fresh `claude --print` call (codex §7.1 verbatim: *"D non-chain / no chain-state burden: verified. The Q2 runner marks D as `chain=false`, D trials have no session or position fields, the D state root has zero `chain_sess*.json` files, and the harness cold-starts with `setup_history.md + task_prompt.md`. This claim is supported by both code and raw metrics."*). Property TRUE BY DESIGN; reinforced empirically by Q2 SD=0 cells (D produced identical outputs across all 25 seeds within each fixture per analyst §3.1 — operational reproducibility under fixed inputs).
   - **No chain-state burden**: deployment and observability simpler; failure modes bounded to per-trial (no cross-trial state corruption). This is a property that follows from D being non-chain by design.
   - **Cross-CLI portable per Rule 4-A Step 5**: **POLICY CLAIM, NOT VERIFIED BY Q2.** Q2 was Claude-only (codex §7.1 verbatim: *"Cross-CLI portable: architecturally plausible but not empirically tested in Q2. Rule 4-A Step 5 treats D as the external/orchestrator default because S is not available at that layer. But Q2 itself used the Claude harness path (`claude --print`) for live Stage 1. The `metrics.json` files record CLI versions for Claude/Codex/Gemini, but they are not Codex/Gemini execution data."*). Cross-CLI parity for D is an architectural assumption inherited from Rule 4-A Step 5, not Q2 empirical evidence. Phase 7+ verification on Codex / Gemini drivers is a binding follow-up per §6.2 + §10.6 #1 + gemini condition G-1.

**Sub-ADR position** (per codex §11 BLOCKERS §11.1 dispatch top conditions M1 + M2 + gemini §2 concerning): the operational-tie-breaker basis is **transparent to architect/users** — it is not a "loophole" superiority claim, it is the **pre-registered resolution path for the equivalence-without-superiority case** that spec §2.2.1 last bullet pre-registered specifically for this anticipated outcome under per-mode N=50 power constraints (analyst §8.2 retrospective power 0.07–0.12 at Bonferroni α=0.00714 documents that the spec authors anticipated under-power for the superiority arm and pre-registered branch (b) as the expected resolution).

The ADR text **does not** state that:
- D outperformed PC or S statistically in Q2 (it did not; superiority NS).
- Q2 demonstrated cross-CLI parity for D (Q2 was Claude-only).
- The branch (b) tie-breaker was an architect "preference" (it is the spec-authorized §2.2.1 last bullet decision rule, OQ-P6-3 branch (b) wording).

The ADR text **does** state that:
- D is statistically equivalent to PC and to S within ε=±0.05 at α=0.05 on the H1+H10 task surface.
- The promotion rests on this equivalence + the spec-pre-registered operational tie-breaker.
- The cross-CLI portability claim is inherited from Rule 4-A Step 5 (non-Q2 empirical) and requires Phase 7+ verification before any cross-CLI deployment-grade claim is made.

### §4.3 Layer 1 4-way deterministic single-signal selector (OQ-P6-1 design proposal)

This sub-ADR's Q2 PROMOTE outcome combined with the Q1 sister sub-ADR's PROMOTE outcome (`2026-05-03-substitute-compact-phase6-promote.md` accepted commit `c758a49`) realizes Phase 6 spec §9.4 **state S1** (Q1 promote + Q2 promote). Layer 1 candidate set is now:

```
Layer 1 candidates = {PC, S, D, substitute-compact-conditional}
```

Both reviewers flag the resulting 4-way deterministic single-signal selector (OQ-P6-1) as **CRITICAL — must be resolved BEFORE the Phase 6 conclusion ADR lands**. Verbatim cross-LLM evidence:

- **Codex M4 + §11.1 condition 4** (`8d7c970` §12.4): *"Phase 6 conclusion MUST resolve the 4-way deterministic selector for {PC, S, D, substitute-compact-conditional} before updating Rule 4-A Step 4."*
- **Codex §9 verbatim** (`8d7c970`): *"This is a critical follow-up. A Phase 6 conclusion ADR that promotes both Q1 and Q2 without pre-registering or locking a deterministic selector would leave Rule 4-A Step 4 under-specified."*
- **Gemini condition G-2** (uncommitted gemini review §10): *"The architect MUST resolve OQ-P6-1 (4-way Layer 1 selector signal) deterministically before the Phase 6 conclusion ADR can be accepted, ensuring Constitution Rule 5 (최선 always) is maintained."*
- **Gemini §3 verbatim** (uncommitted): *"A 4-way single-signal selector explodes the design space. It creates routing ambiguity and risks violating Constitution Rule 5 (최선 always) if the selector logic is not mutually exclusive and exhaustive."*

#### §4.3.1 Architect-recommended single-signal selector (PROPOSAL — non-binding)

This sub-ADR proposes a deterministic single-signal selector design as **input to the Phase 6 conclusion ADR**. The final selector is **NOT locked here** — it is the Phase 6 conclusion ADR's scope (separate architect dispatch per spec §10.8) per Phase 6 spec §12.1 OQ-P6-1 verbatim: *"The single-signal selector for the 3-way split is NOT pre-registered in this Phase 6 spec — it is a parent-ADR follow-up decision (separate architect dispatch on Phase 6 conclusion)."*

**Proposed selector signal**: `chain_state.session_count` + `workload_type` + `chain_state.expected_position_count` (already observable per parent ADR §4.1 selector pattern + Q1 sister sub-ADR §4.3 chain-length signal).

**Proposed deterministic mapping** (illustrative, non-executable per architect §5.1 INVARIANT — coder session implements per Phase 6 conclusion ADR):

```pseudo
# illustrative, non-executable — Phase 6 conclusion ADR locks final selector;
# coder session implements per its constraints
# CONSTRAINTS (binding for Phase 6 conclusion ADR):
#   1. selector MUST return exactly one of {PC, S, D, sc-conditional} given identical inputs
#      (deterministic; no random co-equal — parent ADR §4.1 Layer 1 invariant + gemini D1)
#   2. selector signal MUST be observable on chain_state + capability + workload_type;
#      no opaque heuristic (Constitution Article 1, Article 17)
#   3. mutually exclusive AND exhaustive coverage — gemini §3 requires Rule 5 최선 satisfaction
#   4. fallback edges MUST be defined for every observable input combination
def select_layer1_chain_mode(chain_state, budget, capability, workload_type):
    # 1. capability gate (Rule 4-A Step 1 prefix — unchanged)
    if not capability.claude_only_chain_supported:
        return "D"  # Layer 1 cross-CLI fallback per Rule 4-A Step 5
    # 2. clean state — no chain history
    if chain_state.session_count == 0:
        return "S"  # parent ADR §4.1 — clean state, no preuse benefit
    # 3. explicit reuse intent on long-horizon chain
    if workload_type == "explicit_reuse" and chain_state.session_count >= 1:
        # within reuse-intent, chain-length determines sc-conditional vs PC
        if chain_state.expected_position_count == 5:
            return ("Preuse-substitute-compact-revised", {"cut": 5})  # Q1 sub-ADR §4.3
        if chain_state.expected_position_count == 10:
            return ("Preuse-substitute-compact-revised", {"cut": 30})  # Q1 sub-ADR §4.3
        return "Preuse-clear"  # parent ADR §4.3 Layer 3 default for out-of-grid lengths
    # 4. accumulated state without explicit reuse intent
    if chain_state.session_count >= 1:
        return "Preuse-clear"  # parent ADR §4.1 session_count >= 1 default
    # 5. fallback (D as override / cross-CLI / capability-fallback)
    return "D"
```

#### §4.3.2 Selector design rationale (informational, for Phase 6 conclusion ADR)

| Workload condition | Recommended mode | Rationale (cited evidence) |
|---|---|---|
| `session_count == 0` (clean state) | **S** | Parent ADR §4.1 — clean state, no preuse benefit; S subagent isolation lower-overhead default. Q2 D-vs-S TOST equivalence at ε=±0.05 confirms D is a viable alternative but adds non-chain dispatch overhead vs S subagent path. |
| `session_count >= 1`, no explicit reuse intent | **PC** | Parent ADR §4.1 — accumulated state begins to favor explicit reset over per-task subagent dispatch. Q2 D-vs-PC TOST equivalence at ε=±0.05 confirms D is viable here too but PC has lower marginal cost (Q2 D cost premium +4.4% vs PC per analyst §10.1). |
| `session_count >= 1` AND explicit reuse intent AND chain_length ∈ {5, 10} | **substitute-compact-conditional** (cut=5 if 5-pos; cut=30 if 10-pos) | Q1 sister sub-ADR §4.1 + §4.3 — chain-length-conditional cut policy on long-horizon explicit reuse. Q1 binding evidence Δq = +0.20 / +0.29 vs Pacc at p < 0.00714 (analyst `6ba4ff0` §4.1). |
| Capability gate fails (non-Claude-only chain target; cross-CLI deployment) | **D** (override / fallback) | Rule 4-A Step 5 — D is the documented cross-CLI portable mode. Q2 establishes D's Layer 1 quality-equivalence to PC and S **on the Claude-only Q2 surface**; cross-CLI parity is the §4.2 transparency claim, forwarded to Phase 7 verification. |

#### §4.3.3 Status: this is a PROPOSAL only

Per spec §12.1 OQ-P6-1, the final 4-way selector signal is **locked in the Phase 6 conclusion ADR**, not in this sub-ADR. This sub-ADR's responsibility per dispatch hard rule 3: *"propose 4-way selector design (OQ-P6-1) with explicit 'to be locked in Phase 6 conclusion ADR' note."* — satisfied here.

The Phase 6 conclusion ADR will:
1. Compose this Q2 sub-ADR + the Q1 sister sub-ADR + Q3 fixture-design rule + Q4 fail (re-pre-reg in Phase 7+) into the Phase 6 spec §9.4 row S1 outcome.
2. Lock the final 4-way deterministic single-signal selector (this sub-ADR's §4.3.1 proposal is one input; the Phase 6 conclusion ADR architect may select an alternative deterministic single-signal selector subject to the constraints above).
3. Update Rule 4-A Step 4 candidate set to {PC, S, D, substitute-compact-conditional} per parent ADR §4.4 / §10.1–§10.3 propagation pattern.

### §4.4 Parent ADR §4.2 record-of-change amendment (mirror Q1's §4.5 pattern)

`docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4.2 ("Layer 2 — accumulated / mid-horizon — D maintained") is **amended in place** by this sub-ADR. Sub-record-of-change to be inserted by orchestrator commit per §10.4 (mirror of Q1's `abda5dd` cascade):

> **§4.2 Status update 2026-05-03 (per ADR `2026-05-03-d-promotion-phase6-promote.md`)**
>
> Disposition: D Layer 2 maintained → **D PROMOTED to Layer 1 co-equal**.
>
> - Mechanism: D mode (Dispatch, non-chain) — implementation unchanged.
> - Promotion basis: Phase 6 Q2 binding TOST equivalence dual-gate (D-vs-PC PASS at p_max=8.09e-09; D-vs-S PASS at p_max=2.70e-05) + spec §2.2.1 branch (b) operational tie-breaker activation (Welch superiority p=0.10065 ≥ Bonferroni 0.00714 → equivalence-only branch promotes on D non-chain + no chain-state burden + cross-CLI portable per Rule 4-A Step 5; cross-CLI portability is policy claim, not Q2-verified — Phase 7+ verification follow-up per §10.6 #1).
> - Rule 4-A Step 4 candidate set: extended to include D as a Layer 1 co-equal candidate (alongside PC, S, and Q1-promoted substitute-compact-conditional); 4-way deterministic single-signal selector locked in Phase 6 conclusion ADR per §4.3 + spec §12.1 OQ-P6-1.
> - Phase 6 pre-registration requirements (parent ADR §11(2)) all satisfied: binding hypothesis §2.2.1 + §2.2.2; mode-pair adjudication TOST + Welch + Bonferroni; fixture set H1 + H10 (post-§3.2.1 fallback); n=50/mode (per-mode preserved).
> - External validity scoped to H1+H10 task surface per spec §3.2.1 caveat (long-form code review + strict instruction following). Domain extrapolation requires Phase 7+ re-pre-registration per §3.4.1 ceiling-avoidance procedures.
> - Time-box (gemini D2 carry-over): respected — Phase 6 was the final mode-class re-evaluation Phase; PROMOTE outcome closes the D-promotion investigation lineage.

> **Authority**: This update is inserted per Q2 sub-ADR `2026-05-03-d-promotion-phase6-promote.md` (this file) §10.4 (additive record-of-change pattern; this ADR's §11 sacred-but-amendable contract preserved). The historical D Layer 2 record (parent ADR §4.2 body) is **preserved verbatim** for audit; it is the 2026-05-01 disposition, now superseded by the 2026-05-03 PROMOTE.

Parent ADR §4.4 (Pacc sunset migration table, Layer 2 row "In-flight accumulated session with no explicit reuse intent → D (Layer 2)") is **NOT amended for migration target** — D remains the migration target for Pacc-deprecated sessions in that row, but D's layer attribute updates from Layer 2 to Layer 1 co-equal. The Pacc-sunset migration paths themselves are unchanged.

---

## §5 H10 Ceiling Caveat (cross-LLM consensus integrated; mirror Q1 §5 pattern)

**CRITICAL**: Both codex and gemini independently flag H10 ceiling-saturation as a generalizability constraint on the binding aggregate verdict. Codex M3 + §6 (`8d7c970`); gemini §4 + condition G-3 (uncommitted). This sub-ADR honors the cross-LLM consensus per Constitution Article 5 (최선) — analyst §7.4 acknowledges the caveat; this sub-ADR makes it binding at the ADR text level.

### §5.1 H10 ceiling distribution (verbatim)

| Cell | mean | SD | Distribution |
|---|---:|---:|---|
| Q2-D-H10 | 1.000 | 0.000 | Saturated — 25/25 trials at 8/8 strict-instruction constraints (analyst §3.1; codex §2.1) |
| Q2-PC-H10 | 0.995 | 0.025 | Near-saturation — 24/25 at 1.0; one C7 failure at 0.875 |
| Q2-S-H10 | 0.985 | 0.075 | Near-saturation — 24/25 at 1.0; one C1/C5/C7 failure at 0.625 |

The maximum mathematically possible Δ(D − PC) on H10 is 1.000 − 0.995 = +0.005; max Δ(D − S) on H10 is 1.000 − 0.985 = +0.015. **H10 contributes a near-zero, ceiling-bounded signal** to the aggregate Δ.

### §5.2 Codex M3 + §11.1 condition 3 (verbatim)

> "**M3 - External validity is narrowed to H1+H10.** H11-H14 were dropped and H10 is ceiling-adjacent. Any broad-domain D-promotion wording would overclaim."
> — codex review `8d7c970`, §11 MAJORS M3.

### §5.3 Gemini §4 + condition G-3 (verbatim)

> "**Condition G-3**: The Sub-ADR MUST explicitly restrict its generalizability claims to the H1+H10 task surface, acknowledging the narrowed external validity caused by the §3.2.1 fallback."
> — gemini review (uncommitted), §10 condition G-3.

### §5.4 Sub-ADR position

1. **Acknowledge cross-LLM consensus**: H10 (μq = 0.985–1.000 across all three Q2 modes) **does not contribute** to the §2.2.1 superiority arm and contributes only ceiling-bounded δ to the TOST equivalence arm. The aggregate binding signal is **structurally H1-driven** (analyst §7.2 + §7.3; codex §6).
2. **H1-only sensitivity verdict**: agrees with aggregate (§3.5) — TOST holds for both pairs on H1 alone (D-vs-PC 90% CI ⊂ ±0.05; D-vs-S 90% CI ⊂ ±0.05); superiority NS on H1 alone. Branch (b) operational tie-breaker pathway is independently satisfied on H1 alone.
3. **PROMOTE verdict robust to H10 exclusion**: the binding outcome (PROMOTE under branch (b)) holds whether the endpoint is the pre-registered aggregate H1+H10 or the H1-only sensitivity. **No claim is made** in this sub-ADR that H10 itself demonstrates D-vs-{PC,S} differentiation; H10 is documented as **ceiling-saturated, signal-attenuated**.
4. **External validity narrowed**: the PROMOTE verdict generalizes only to (a) Claude-only Layer 1 chain-mode candidate set (Rule 4-0 narrow lock; cross-CLI extension per §6 + §10.6 #1), AND (b) H1-like task profiles (long-form code review). H10-like profiles (strict instruction following) saturate; PROMOTE applies but signal is weak. **Domain extrapolation OUT OF SCOPE** for this Phase 6 binding decision and must be re-pre-registered in Phase 7+ using ceiling-avoidance procedures per spec §3.4.1.
5. **Phase 7+ binding follow-up**: cut-sweep / D-mode external validity sweep MUST include non-{H1, H10} fixtures (e.g., H11–H14 redesigned per §3.4.1 ceiling-avoidance procedures, or new high-difficulty fixtures authored under those procedures, with non-ceiling means in [0.5, 0.85] ∧ σ ≥ 0.05). Forwarded to §10.6 #2 + §11 OQ-P6-3.

---

## §6 Cross-CLI Portability + Generalizability (gemini load-bearing condition)

Gemini condition (uncommitted §3 + §5 + §10 condition G-1): "cross-CLI portability" is the **load-bearing rationale invoked in branch (b) to break the tie**, but Q2 was Claude-only — empirical verification on Codex / Gemini drivers is **no longer optional**.

### §6.1 Gemini condition G-1 (verbatim)

> "**Condition G-1**: The Final ADR MUST explicitly mandate Phase 7+ cross-CLI verification of D mode (Codex/Gemini), as 'cross-CLI portability' is the load-bearing justification for the branch (b) operational tie-breaker."
> — gemini review (uncommitted), §10 condition G-1.

### §6.2 Sub-ADR position (mirror Q1 §7 structure)

1. **Rule 4-0 scope unchanged**: D mode PROMOTE applies to **Claude-only Layer 1 chain-mode candidate set** (Rule 4-0 narrow lock; parent ADR §9 Q4 PASS-with-caveat). Cross-CLI extension is a separate ADR per parent ADR §9 Article 2 caveat + Rule 4-A Step 5 capability gate (which already routes D as the cross-CLI default *by policy*, not by Q2 evidence).
2. **Harness-level portability** (theoretical): D mode is non-chain by design. Each D trial issues a single fresh request to the host CLI with the fixture prompt; no `chain_state.json` to manage; no per-position cache invalidation. In principle, D should generalize to Codex / Gemini drivers without harness code change — but the *quality-equivalence* claim (D ≈ PC ≈ S within ε=±0.05) is **not** automatically inherited from Claude to Codex/Gemini.
3. **Model-specific quality calibration** (gemini §5): different models (Codex / Gemini) have different attention profiles, instruction-following calibrations, and reasoning trajectories. The Q2 TOST equivalence margin ε=±0.05 was calibrated against Claude's H1+H10 quality distribution; cross-CLI behavior may not transfer verbatim. Cohen d ≈ +0.20–0.41 (small effect) is consistent with ceiling-attenuated equivalence at the [0,1] upper boundary on Claude — different ceilings on Codex / Gemini would yield different effect magnitudes.
4. **Phase 7 binding follow-up**: cross-CLI verification on Codex + Gemini drivers is forwarded to §10.6 #1 as a Phase 7 binding pre-registration requirement. Until verified, the Rule 4-A Step 4 4-way Layer 1 selector (locked in Phase 6 conclusion ADR per §4.3) treats D's cross-CLI-portable property as **inherited from Rule 4-A Step 5 policy**, NOT as Q2-verified empirical claim. The selector continues to use D as the Layer 1 cross-CLI fallback (per §4.3.1 capability-gate fallback) but does not promote a "D verified equivalent on Codex/Gemini" deployment claim.
5. **Generalizability claim binding scope**: D PROMOTE applies to (a) Claude-only Layer 1 candidate set, (b) H1-like task profile (long-form code review, with H10-like ceiling caveat). Out of scope for this sub-ADR's binding promotion: cross-CLI deployment, novel domains (agentic tool use, multilingual, structured extraction), and chain regimes that do not match parent ADR §4.1 / §4.2 / §4.3 horizon definitions.

---

## §7 SD=0 Statistical Handling (codex methodology confirmation)

Codex confirmed the analyst's standard Welch–Satterthwaite TOST treatment of SD=0 cells as the binding primary method, with Mann-Whitney rank-based test as validation and exact-equivalence inspection as intuition (downgraded to inspection only per codex N1).

### §7.1 Codex N1 + N2 + condition 5 (verbatim)

> "**N1 - 'Exact-equivalence' should be downgraded to inspection.** It is useful intuition, not a third formal statistical method."
> — codex review `8d7c970`, §11 MINORS N1.

> "**N2 - Analyst §3.2 blurs cell-level and aggregate SD.** The final numbers are correct, but the prose should say aggregate D SD is nonzero while stratified D SD is zero."
> — codex review `8d7c970`, §11 MINORS N2.

> "**Condition 5**: ADR MUST preserve the SD=0 methodology caveat: aggregate D SD is nonzero; stratified SD=0 CIs use comparator variance and df=n-1; exact-equivalence is inspection only."
> — codex review `8d7c970`, §12 condition 5.

### §7.2 Sub-ADR position

The two D cells (Q2-D-H1, Q2-D-H10) exhibit cell-level SD = 0.0000 (deterministic across all 25 seeds). At the binding **aggregate** level (per-mode N=50), D's SD = 0.0220 is **nonzero** because mean(Q2-D-H1) = 0.9565 ≠ mean(Q2-D-H10) = 1.0000 contributes between-cell variance to the pooled mode aggregate. The binding aggregate TOST CIs (§3.3.1, §3.3.2) use this nonzero aggregate D SD; the SE collapses to the comparator side only at stratified per-cell level (analyst §3.2 Method 1; codex §2.2 verified).

**Methodology caveat preserved (codex condition 5)**:

1. **Aggregate D SD is nonzero**: 0.0220 per analyst §2.1 / codex §2.2 — confirmed by independent recompute on the 50 raw D-mode `metrics.json` files.
2. **Stratified SD=0 cells handled with standard Welch–Satterthwaite TOST**: when one arm has s²=0 and the comparator has nonzero variance, SE = √(0 + s²_comp / n_comp) = s_comp / √n_comp; df reduces to n_comp − 1 = 24. The CI does not degenerate (codex §2.2 example table for H1/H10 stratified TOSTs at df=24).
3. **Exact-equivalence is inspection only** (codex N1 integrated): D-H10 produced constant 1.000; PC-H10 mean = 0.995; |Δ| = 0.005 < ε = 0.05 by inspection. This intuition check is **not** a third formal statistical method co-equal to Welch TOST and Mann-Whitney; it is an inspection-grade sanity check (downgrade per N1).
4. **No method gives a different verdict** (analyst §11.2; codex §2.3): standard Welch TOST PASSES; Mann-Whitney directional agreement CONFIRMS no superiority signal; exact-equivalence inspection CONFIRMS verdict at cell level. Robust under any plausible cluster-inflation factor.
5. **D mode within-cell trials are i.i.d. samples from a degenerate point-mass distribution** (analyst §11.6): for D, effective N from a strict information-content standpoint is 1 per cell; aggregate N=50 understates D's variance contribution but leaves the test conservative (SE depends only on PC/S, both non-degenerate). PC and S use 25 distinct seeds with isolated `--state-root` per cell — no within-cell clustering inflation.
6. **Phase 7+ hierarchical re-analysis follow-up** (codex top issue precedent from Q1 sister sub-ADR §6.3 cluster-aware analysis): forwarded to §10.6 #3 as a Phase 7 binding follow-up — hierarchical / mixed-effects model re-analysis on existing Q2 data (no new fire) to address cluster-robust standard errors if claims will generalize beyond the pooled-trial endpoint.

### §7.3 Codex N3 (multiple-testing completeness, verbatim)

> "**N3 - Report D-vs-PC superiority for completeness.** Spec §7.5 includes both D-vs-PC and D-vs-S in the superiority family. D-vs-PC is harmlessly NS (`p=0.156635`), but including it improves auditability."
> — codex review `8d7c970`, §11 MINORS N3.

Sub-ADR integrates the full multiple-testing statement per codex condition 6 in the §3.3.3 superiority component table (D-vs-PC informational row: Welch p = 0.156635, NS at α=0.05 and at Bonferroni α=0.00714). Spec §7.5 family of 7: 5 Q1 substitute-compact-vs-Pacc superiority + 2 Q2 D-vs-{PC,S} superiority. Per-test α = 0.05/7 = 0.00714. Both Q2 superiority comparisons (D-vs-PC and D-vs-S) are NS at the family-wise corrected threshold.

---

## §8 Conditions Integration Matrix

Each of the **9 cross-LLM conditions** (codex 6 + gemini 3) is **quoted verbatim** and mapped to the ADR section that integrates or waives it. Coverage: **9 / 9 INTEGRATE, 0 WAIVE**. Per dispatch hard rule 1: *"MUST quote 9 conditions verbatim (codex 6 + gemini 3) before classifying integrate/waive"* — satisfied.

| # | Source | Condition (verbatim) | Disposition | Integrated in |
|---|---|---|---|---|
| 1 | codex `8d7c970` §12 #1 | "ADR MUST state the exact branch: TOST equivalence confirmed for D-vs-PC and D-vs-S; superiority NS; PROMOTE occurs only through §2.2.1 / §12.3 branch (b) operational tie-breaker." | **INTEGRATE** | §3.3.3 + §3.3.4 + §4.1 + §4.2 (branch (b) verbatim, §2.2.1 + §12.3 cited) |
| 2 | codex `8d7c970` §12 #2 | "ADR MUST label the operational tie-breaker as external policy rationale, not Q2 statistical evidence. D non-chain/no-state burden is verified here; cross-CLI portability is not." | **INTEGRATE** | §4.2 (two-component decomposition: empirical equivalence + operational policy; cross-CLI portability flagged "POLICY CLAIM, NOT VERIFIED BY Q2" with codex §7.1 verbatim quote) |
| 3 | codex `8d7c970` §12 #3 | "ADR MUST scope the result to H1+H10 task profiles and open a Phase 7 non-ceiling, non-H1/H10 external-validity sweep before broad deployment claims." | **INTEGRATE** | §5 + §6.2 #5 + §10.6 #2 (Phase 7 non-ceiling fixture extension follow-up) |
| 4 | codex `8d7c970` §12 #4 | "Phase 6 conclusion MUST resolve the 4-way deterministic selector for {PC, S, D, substitute-compact-conditional} before updating Rule 4-A Step 4." | **INTEGRATE** | §4.3 (4-way selector design proposal with explicit "to be locked in Phase 6 conclusion ADR" note per dispatch hard rule 3) + §11 OQ-P6-2 |
| 5 | codex `8d7c970` §12 #5 | "ADR MUST preserve the SD=0 methodology caveat: aggregate D SD is nonzero; stratified SD=0 CIs use comparator variance and df=n-1; exact-equivalence is inspection only." | **INTEGRATE** | §7.2 (5-point methodology caveat: aggregate vs cell-level SD distinction; Welch–Satterthwaite df=n-1; exact-equivalence downgraded to inspection per codex N1) |
| 6 | codex `8d7c970` §12 #6 | "ADR SHOULD include the full multiple-testing statement: seven-test superiority family at α=0.00714; TOST exempt at α=0.05 per spec; D-vs-PC superiority NS and D-vs-S superiority NS." | **INTEGRATE** | §3.3.3 (D-vs-PC informational row added per N3); §7.3 (full multiple-testing statement: Bonferroni family of 7, TOST exempt at α=0.05 per spec §7.5) |
| 7 | gemini (uncommitted) §10 G-1 | "Condition G-1: The Final ADR MUST explicitly mandate Phase 7+ cross-CLI verification of D mode (Codex/Gemini), as 'cross-CLI portability' is the load-bearing justification for the branch (b) operational tie-breaker." | **INTEGRATE** | §6 (full cross-CLI portability caveat) + §10.6 #1 (Phase 7+ cross-CLI verification follow-up; binding pre-registration requirement before cross-CLI deployment) |
| 8 | gemini (uncommitted) §10 G-2 | "Condition G-2: The architect MUST resolve OQ-P6-1 (4-way Layer 1 selector signal) deterministically before the Phase 6 conclusion ADR can be accepted, ensuring Constitution Rule 5 (최선 always) is maintained." | **INTEGRATE** | §4.3 (4-way selector design proposal as input to Phase 6 conclusion ADR; gemini §3 verbatim "explodes the design space" + Rule 5 reference quoted) + §11 OQ-P6-2 (forwarded as Phase 6 conclusion ADR scope per spec §12.1) |
| 9 | gemini (uncommitted) §10 G-3 | "Condition G-3: The Sub-ADR MUST explicitly restrict its generalizability claims to the H1+H10 task surface, acknowledging the narrowed external validity caused by the §3.2.1 fallback." | **INTEGRATE** | §5.3 (gemini G-3 verbatim) + §5.4 #4 (external validity narrowed to H1+H10 task surface; domain extrapolation OUT OF SCOPE) + §6.2 #5 (binding scope) |

**Coverage**: 9 / 9 INTEGRATE, 0 WAIVE. All 9 conditions are addressed in binding ADR sections; none are deferred or deemed informational.

---

## §9 위헌 심사 (Constitution Check, mandatory per architect AGENTS.md §5.5 INVARIANT)

Constitution: `~/projects/aigentry/docs/CONSTITUTION.md` (전문 + 18조 + 최종조). Per `references/constitution-check.md` §1, the 5 mandatory questions are answered first; Articles 1, 2, 5, 9, 13, 17 (per dispatch §9 itemization) follow as article-specific review.

### §9.1 Q1: AI 기술 격차 해소에 복무하는가? (Preamble + 제14조)

**PASS.** D mode promotion to Layer 1 co-equal removes a routing barrier for cross-CLI / cross-environment users who lack reliable chain primitives in their host CLI (per Rule 4-A Step 5 — D is the documented cross-CLI default *because* PC's `--print` no-resume primitive and S's subagent / Task tool may not be available outside Claude Code). Promotion to Layer 1 elevates D from a Layer-2 fallback to a quality-equivalent first-class candidate within the Q2-validated H1+H10 surface; the orchestrator selector applies D transparently when the capability gate routes to non-Claude-only chain selection. User does not need to learn the mode taxonomy.

### §9.2 Q2: 이 기능은 어느 컴포넌트의 역할인가? (제3조)

**PASS.** Rule 4-A Step 4 selector (orchestrator's routing role) gains D as a Layer 1 co-equal candidate; D mode harness (devkit role) is unchanged in this ADR. No role침범:
- **Architect (this session)**: produces sub-ADR markdown only; no code, no test execution.
- **Orchestrator**: consumes the §4.3 selector design proposal and dispatches the Phase 6 conclusion ADR architect session for final 4-way selector lock + AGENTS.md / docs/rules.md text edits per §10.2 + §10.3.
- **Coder (separate task per Phase 6 conclusion ADR §10)**: implements final selector logic per §4.3 binding constraints + Phase 6 conclusion ADR final wording.
- **Devkit**: holds the unchanged D mode harness (`bin/exec-mode-experiment.sh` D-mode path; harness `harness_stage1_live_D` cold-start with `setup_history.md + task_prompt.md` per Q2 fire report devkit `f969bf5`).

### §9.3 Q3: 이 프레임워크/라이브러리가 정말 필요한가? (제1조 + 제17조)

**PASS.** No new dependency. D mode is an existing Rule 4-A mode (parent ADR §4.2 disposition prior to this amendment); the layer-attribute change (Layer 2 → Layer 1 co-equal) is a single-field update on the orchestrator selector's mode-class table. The 4-way Layer 1 selector design (§4.3) reads existing observable signals (`chain_state.session_count`, `chain_state.expected_position_count`, `workload_type`, `capability` — all already in parent ADR §4.1 selector pattern + Q1 sister sub-ADR §4.3). No library, no framework, no plugin introduced. The "illustrative, non-executable" pseudo-code in §4.3.1 is documentation only per architect §5.1 INVARIANT.

### §9.4 Q4: 모든 크로스 환경에서 동작하는가? (제2조 + 제14조)

**PASS with caveat (Rule 4-0 narrow lock scope preserved; cross-CLI extension forwarded).** D mode is implemented as a non-chain dispatch primitive that issues a single fresh request to the host CLI with the fixture prompt — architecturally portable across Claude / Codex / Gemini. **However**, Q2 was Claude-only execution. The PROMOTE verdict's TOST equivalence claim is binding only on the Claude-only surface; cross-CLI quality-equivalence is **policy claim from Rule 4-A Step 5**, not Q2 empirical evidence (§4.2 transparency). Phase 7+ cross-CLI verification on Codex / Gemini drivers is a binding pre-registration requirement before any cross-CLI deployment claim (§10.6 #1; gemini condition G-1 integrated). **PASS**: this sub-ADR does not break cross-CLI behavior; **caveat**: the Layer 1 promotion applies under Rule 4-0 narrow lock (Claude-only) until Phase 7 verification.

### §9.5 Q5: 사용자에게 "어떻게"를 강요하지 않는가? (Preamble)

**PASS.** Routing decisions are made by the orchestrator's Rule 4-A Step 4 selector. User selects "what" (the task); the 4-way Layer 1 selector (final design locked in Phase 6 conclusion ADR per §4.3) selects D / PC / S / sc-conditional based on observable `chain_state` + `capability` + `workload_type` signals. User does not need to learn the mode taxonomy or choose a chain mode. The orchestrator's auditable selector remains the single point of "how" (per parent ADR §4.1 Layer 1 invariant — deterministic, single-signal, observable inputs).

### §9.6 Article-specific review (per dispatch §9 itemization)

| Article | Verdict | Rationale |
|---|---|---|
| **제1조 경량** | **PASS** | D mode harness already in-tree (parent ADR §4.2 disposition; Phase 5 holdout n=50 D trials with full implementation); no new code introduced by this sub-ADR. The layer-attribute change adds zero rule-surface complexity (single-field update on orchestrator's mode-class table); the 4-way selector design (§4.3) extends Q1's chain-length-conditional pattern with the existing `workload_type` + `capability` signals. Time-box invariant (gemini D2 carry-over): preserved — Phase 6 was the final mode-class re-evaluation Phase; PROMOTE outcome closes the D-promotion lineage; no Phase 7 D-promotion ARM is dispatched (only follow-up analyses on existing Q2 data + cross-CLI verification + non-ceiling fixture extension — none re-open the mode-class question). 헌법 1조 "이거 없이 직접 구현 가능한가?" — no: the binding evidence (TOST equivalence at p_max ≪ 0.05 + branch (b) operational tie-breaker) shows D is the data-evidenced Layer 1 co-equal candidate. |
| **제2조 크로스** | **PASS with caveat** | See §9.4. Rule 4-0 narrow lock (Claude-only) preserved; cross-CLI extension forwarded to Phase 7 verification per §10.6 #1 + gemini condition G-1. D mode is the documented cross-CLI default per Rule 4-A Step 5 (capability gate, unchanged); this sub-ADR's PROMOTE applies under Rule 4-0 scope only. Layer-2 D continues to default for cross-CLI / CI/CD per Rule 4-A Step 5 (capability layer), but the *layer-1-co-equal* attribute is Q2-Claude-only until cross-CLI verification. |
| **제5조 최선** | **PASS** | PROMOTE is the data-evidenced best path. Maintain alternative (parent ADR §4.2 prior disposition) was considered (§3.4 §2.2.2 NOT TRIGGERED — TOST holds for both pairs by clear margins, so maintain is not the data-evidenced path); §3.4 explicitly documents §2.2.2 not the outcome. Cross-LLM consensus on branch (b) transparency + OQ-P6-1 critical + generalizability narrow (§4.2 + §4.3 + §5 + §6) overrides any latent "branch (b) is sufficient evidence" framing — applies 헌법 5조 verbatim: where ambiguity exists, the constructive critique of two reviewers' converging perspective takes precedence. The 4-way selector design proposal (§4.3) forwards the Rule 5 최선 mandate to the Phase 6 conclusion ADR for deterministic resolution per gemini condition G-2. |
| **제9조 독립** | **PASS** | D mode runs standalone — non-chain, no inter-mode dependency, no `chain_state.json` to manage, no per-position cache invalidation. Rule 4-A Step 4 4-way selector (§4.3) binds observable `chain_state` + `workload_type` + `capability` signals only; no invocation of another mode's runtime. Each Layer 1 candidate (PC, S, D, sc-conditional) operates independently of the others; sub-components (analyst / coder / builder / tester) are not forced to depend on the new layer-attribute. |
| **제13조 비판적+건설적+객관적** | **PASS** | All 9 cross-LLM conditions integrated verbatim per §8 (codex 6 + gemini 3); branch (b) transparency caveat explicit per §4.2 (codex M1 + M2; gemini §2 concerning); H10 ceiling caveat explicit per §5 (codex M3 + gemini G-3); cross-CLI portability caveat explicit per §6 (gemini G-1); SD=0 methodology caveat explicit per §7 (codex N1 + N2 + condition 5). No condition silently waived. ADR text avoids "equivalence" wording outside TOST contexts (Phase 6 spec §7.3 codex C1 wording discipline preserved — see §12 hard-rule grep verification). The branch (b) basis is described as **statistical equivalence + operational policy**, NOT as superiority and NOT as cross-CLI evidence — this is constructive critique applied verbatim. |
| **제17조 무의존** | **PASS** | No new external dependency. D mode harness is pure Python + shell at the existing harness layer (`bin/exec-mode-experiment.sh` D-mode path, devkit `c9873ae`); 4-way Layer 1 selector amendment is shell/router-level logic on existing `chain_state` schema. No library, no framework, no plugin. |

**Verdict**: PASS overall. No FAIL on any required article. Article 2 PASS-with-caveat carried verbatim from parent ADR §9 — caveat scope (Rule 4-0 narrow lock, Claude-only) unchanged + cross-CLI extension forwarded.

---

## §10 Implementation Plan

**No code in this ADR per architect AGENTS.md §5.1 INVARIANT.** All implementation is delegated to coder / orchestrator / Phase 6 conclusion ADR architect sessions post-acceptance. Affected files listed for handoff.

### §10.1 Sub-ADR status flip (orchestrator commit, post-acceptance)

- File: `~/projects/aigentry-orchestrator/docs/adr/2026-05-03-d-promotion-phase6-promote.md` (this file).
- Diff: `status: proposed` → `status: accepted` + `accepted_date: 2026-05-XX` (date filled at signoff time) + `accepted_by: orchestrator (oikim signoff via aigentry-orchestrator-claude)`.
- Trigger: user approval of this sub-ADR.

### §10.2 AGENTS.md Rule 4-A Step 4 update (Phase 6 conclusion ADR scope)

- File: `~/projects/aigentry-orchestrator/AGENTS.md`.
- Section: "실행 모드 체크 (Rule 4-A — Narrow Lock, Phase 6 Q1 promote 기반 (substitute-compact PROMOTED 2026-05-03))" checklist (already updated per Q1 cascade `bbb6696` to reference Q1's substitute-compact line).
- Diff (illustrative; **Phase 6 conclusion ADR architect** authors final wording integrating Q1 + Q2):
  - Update header: "Phase 6 Q1 promote 기반 (substitute-compact PROMOTED 2026-05-03)" → "Phase 6 Q1+Q2 promote 기반 (substitute-compact + D PROMOTED 2026-05-03)".
  - Update "Layer 1 deterministic selector" line to reference 4-way candidate set: "Layer 1 deterministic 4-way selector (PC | S | D | sc-conditional; ADRs `2026-05-01-rule-4-a-step-4-final-lock.md` §4.1 + `2026-05-03-substitute-compact-phase6-promote.md` §4.3 + `2026-05-03-d-promotion-phase6-promote.md` §4.3 + Phase 6 conclusion ADR final selector)".
  - Update Layer 2 line: "Layer 2 D maintained" → "Layer 2 vacated by D promotion (D now Layer 1 co-equal; ADR final-lock §4.2 record-of-change 2026-05-03)".
  - Preserve existing Pacc-sunset, PC-Layer-3-default lines.

### §10.3 docs/rules.md Rule 4-A Step 4 update (Phase 6 conclusion ADR scope)

- File: `~/projects/aigentry-orchestrator/docs/rules.md`.
- Section: Rule 4-A Step 4 body (currently bound to parent ADR final-lock §4 + Q1 sub-ADR amendment per cascade `44560db`).
- Diff: append a sub-section "D mode Layer 1 co-equal promotion" with the §4.1 PROMOTE verdict + §4.2 branch (b) transparency caveat + §6.2 cross-CLI scope caveat + §4.3 4-way selector reference. Cite this sub-ADR + Q1 sister sub-ADR + parent ADR + Phase 6 conclusion ADR (when locked) as authority.

### §10.4 Parent ADR §4.2 record-of-change amendment (orchestrator commit, mirror Q1 `abda5dd` cascade)

- File: `~/projects/aigentry-orchestrator/docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md`.
- Section: §4.2 (Layer 2 — accumulated / mid-horizon — D maintained).
- Diff: insert the §4.2 status update block from §4.4 of this sub-ADR (verbatim) at the head of parent ADR §4.2. Do not delete the parent's D-Layer-2 history; the amendment is additive (record-of-change pattern per parent ADR §11 "pre-reg sacred-but-amendable-via-record-of-change"; mirror Q1 sub-ADR's parent §4.5 amendment cascade `abda5dd`). Update parent ADR `related` frontmatter to add this Q2 sub-ADR; update `amended_by` field to add this sub-ADR alongside the existing Q1 sub-ADR entry.

### §10.5 Phase 6 conclusion ADR (separate architect dispatch — NOT in this sub-ADR)

This sub-ADR is **not** the Phase 6 final integration ADR. Phase 6 conclusion ADR (per Phase 6 spec §10.8) is dispatched **after Q2 also resolves** (this sub-ADR + sister Q1 sub-ADR + Q3 fixture-design rule satisfy that condition for state S1). The Phase 6 conclusion ADR scope:

1. **Compose** Q1 sub-ADR (`2026-05-03-substitute-compact-phase6-promote.md`) + Q2 sub-ADR (this file) + Q3 ADR (`2026-05-02-output-style-fixture-design-rule.md`) + Q4 fail (re-pre-reg in Phase 7+) into the Phase 6 spec §9.4 row S1 outcome.
2. **Lock** the final 4-way deterministic single-signal Layer 1 selector for {PC, S, D, sc-conditional} per §4.3 design proposal (one input among possible alternatives; final architect determines selector per spec §12.1 OQ-P6-1).
3. **Update** Rule 4-A Step 4 candidate set + AGENTS.md + docs/rules.md per §10.2 + §10.3 propagation pattern.
4. **Forward** Phase 7+ open questions per §10.6 follow-ups (binding pre-registration requirements where applicable).

The Phase 6 conclusion ADR is forwarded to a future architect session as the binding next-step. This sub-ADR commits only to (a) PROMOTE D Layer 1 co-equal, (b) propose 4-way selector design as input, (c) integrate 9 cross-LLM conditions, (d) amend parent ADR §4.2 via record-of-change. The Phase 6 conclusion ADR itself is **not** opened here per dispatch hard rule (separate scope).

### §10.6 Phase 7+ follow-ups (architect dispatch later — NOT in this sub-ADR)

These are forwarded to a future architect session as binding Phase 7+ pre-registration candidates. None block this sub-ADR's acceptance.

| # | Follow-up | Source condition | Type |
|---|---|---|---|
| 1 | **Cross-CLI verification**: D mode TOST equivalence on Codex + Gemini drivers (mandatory before any cross-CLI deployment claim that rests on the §4.2 branch (b) tie-breaker) | gemini condition G-1 (uncommitted §10); §6.2 above | Phase 7 cross-CLI verification (Rule 4-0 scope expansion candidate) |
| 2 | **Non-{H1, H10} fixture extension**: D-mode external validity sweep on non-ceiling fixtures per §3.4.1 ceiling-avoidance procedures (replace H10 / extend H1+H10 with new high-difficulty fixtures with non-ceiling means in [0.5, 0.85] ∧ σ ≥ 0.05) | codex condition 3 (`8d7c970` §12); gemini condition G-3 (uncommitted §10); §5 + §6.2 above | Phase 7 fixture redesign (binding for any cut-sweep / D-mode external validity claim) |
| 3 | **Hierarchical / mixed-effects model re-analysis on existing Q2 data** (no new fire) — cluster-aware primary analysis per Q1 codex top issue precedent (`5ca27d8` §10 condition 1 + 5); applies to Q2 D mode SD=0 cluster-effective-n question per §7.2 #6 | codex §10 condition 5 (Q1 sister sub-ADR §6.3 precedent); §7.2 #6 above | Phase 7 statistical re-analysis (cluster-aware primary on Q2 data) |
| 4 | **Cost-overhead measurement**: D fresh dispatch overhead vs PC/S — Q2 D cost premium +4.4% vs PC, +3.6% vs S (analyst §10.1); investigate whether D mode can amortize prompt caching at session level (e.g., session-level kv-cache reuse) | analyst §12.4 #5 | Phase 7 cost-engineering follow-up |
| 5 | **4-way selector signal validation post-OQ-P6-1 resolution**: empirical validation of the Phase 6 conclusion ADR's locked 4-way selector signal via cell-level routing-correctness audit on a held-out fixture / chain-length / capability grid | codex condition 4 + gemini condition G-2; §4.3 + §11 OQ-P6-2 forwarded | Phase 7 selector-correctness audit (post-Phase-6-conclusion-ADR) |
| 6 | **OQ-P6-3 wording resolution forwarded** (analyst §12.4 #6): branch (b) operational tie-breaker outcome wording per §2.2.1 forwarded for Phase 6 conclusion ADR-level disambiguation; this sub-ADR resolves OQ-P6-3 for the Q2 case (branch (b)), but the meta-rule for future tie-breaker invocations remains open | analyst §12.4 #6; codex condition 1; spec §12.3 OQ-P6-3 | Phase 7 meta-rule (operational tie-breaker formalization) |
| 7 | **OQ-P6-4 TOST family count formalization** (analyst §12.4 #7): TOST exempt from Bonferroni assumed here per spec §7.5 + §11.4; if reviewer pushes back, formalize in Phase 6 conclusion ADR / Phase 7 statistical-protocol ADR | analyst §12.4 #7; codex condition 6 / N3 | Phase 7 methodological hygiene |

Each Phase 7+ follow-up dispatch authoring is a future architect / orchestrator session's scope. This sub-ADR commits only to forwarding them as binding pre-registration requirements; the Phase 7+ specs themselves are not opened here.

### §10.7 Backward Compatibility (architect AGENTS.md §5.8 INVARIANT)

| Existing consumer | Change required | Rationale |
|---|---|---|
| Orchestrator Rule 4-A Step 4 selector | **Additive**: D's layer attribute changes from Layer 2 (parent ADR §4.2 prior) → Layer 1 co-equal. Existing PC / S / Pacc routing paths unchanged. The 4-way Layer 1 selector signal (Phase 6 conclusion ADR locks final) extends Q1's chain-length-conditional pattern with `workload_type` + `capability` signals; no breaking change to existing Layer 1 (PC, S) or Layer 3 (PC) routing | Additive layer-attribute change; mode harness unchanged; selector augmentation per §4.3 |
| AGENTS.md Rule 4-A checklist | **Update via Phase 6 conclusion ADR**: §10.2 lists illustrative diff; final wording locked in Phase 6 conclusion ADR | parent ADR §10.1 pattern; orchestrator activation patch via Phase 6 conclusion ADR cascade |
| docs/rules.md Rule 4-A Step 4 body | **Additive**: §10.3 sub-section appended with this sub-ADR's PROMOTE verdict + §4.2 branch (b) transparency + §6.2 cross-CLI scope. Final integration in Phase 6 conclusion ADR | parent ADR §10.2 pattern + Q1 cascade `44560db` precedent |
| Parent ADR §4.2 (D maintained Layer 2) | **Additive record-of-change**: §10.4 amendment per Q1 §4.5 pattern (`abda5dd`); historical record preserved verbatim; PROMOTE update inserted at section head | parent ADR §11 sacred-but-amendable contract; Q1 sister sub-ADR §10.5 precedent |
| Parent ADR §4.4 (Pacc sunset migration table, Layer 2 row) | **Layer attribute update only**: D remains the migration target for "in-flight accumulated session with no explicit reuse intent" row, but D's layer attribute updates from Layer 2 to Layer 1 co-equal (Phase 6 conclusion ADR records the layer-attribute change in the migration table footnote) | parent ADR §4.4 migration-target-by-mode unchanged; layer-attribute is metadata |
| Q1 sister sub-ADR (`2026-05-03-substitute-compact-phase6-promote.md`) | **Layer 1 candidate-set co-extension**: substitute-compact-conditional and D both join Layer 1 simultaneously (state S1 per spec §9.4); Phase 6 conclusion ADR composes both sub-ADRs into the unified 4-way selector | spec §9.4 state S1; Q1 sub-ADR §11.2 forward gate verbatim "If Q2 also promotes D → state S1: Phase 6 final ADR locks Rule 4-A Step 4 candidate set = {PC, S, D, substitute-compact-conditional}" |
| Coder sessions implementing Rule 4-A Step 4 selector | **One-time amendment**: implement final 4-way selector per Phase 6 conclusion ADR (post-§10.5 dispatch). No existing selector code is broken; the `workload_type` + `capability` signals are added as pre-conditions per §4.3.1 | Phase 6 conclusion ADR scope; coder session task spec must reference final locked selector |
| End users (cross-CLI / cross-environment users running short-to-mid horizon workflows) | **Transparent improvement**: D applies automatically when capability gate routes to non-Claude-only chain selection or workload conditions match the §4.3 selector; users see consistent chain-mode quality across environments (Q2 D-vs-PC equivalence at ε=±0.05 establishes this on Claude-only surface; cross-CLI surface forwarded to Phase 7 verification) | gemini §7.1 operational implication; Constitution §9.1 Q1 PASS |

**No breaking change**: this is an additive promotion + additive record-of-change amendment to parent ADR §4.2. D mode harness (V3 PASS preserved per Phase 5 sub-ADR + parent ADR §3.6 hold-up criterion) and existing chain modes (PC, S, sc-conditional, Pacc-during-sunset-window) all continue to operate without modification.

---

## §11 Open Questions Forwarded

These open questions are tracked for orchestrator / Phase 6 conclusion ADR / Phase 7+ follow-up. None block this sub-ADR's acceptance.

- **OQ-P6-1** (this sub-ADR-scoped, **CRITICAL** per both reviewers): 4-way Layer 1 selector signal for {PC, S, D, sc-conditional} — **proposed in §4.3** (architect-recommended `chain_state.session_count` + `workload_type` + `chain_state.expected_position_count` + `capability` signals); **final selector locked in Phase 6 conclusion ADR** (separate architect dispatch per spec §12.1 + §10.8). This sub-ADR satisfies dispatch hard rule 3 ("propose 4-way selector design with explicit 'to be locked in Phase 6 conclusion ADR' note") + codex condition 4 + gemini condition G-2. **Forwarded to**: Phase 6 conclusion ADR (next architect dispatch).
- **OQ-P6-2** (Phase 7+, gemini condition G-1, **BLOCKING for cross-CLI deployment claim**): cross-CLI verification of D mode TOST equivalence on Codex + Gemini drivers. **Forwarded to**: Phase 7 cross-CLI verification per §10.6 #1.
- **OQ-P6-3** (Phase 7+, codex condition 3 + gemini condition G-3): generalizability extension — non-{H1, H10} fixture set with non-ceiling means in [0.5, 0.85] ∧ σ ≥ 0.05 per §3.4.1 ceiling-avoidance procedures. **Forwarded to**: Phase 7 fixture redesign per §10.6 #2.
- **OQ-P6-4** (Phase 7+, codex condition 5 + Q1 cluster-effective-n precedent): hierarchical / mixed-effects model re-analysis on existing Q2 data. **Forwarded to**: Phase 7 statistical re-analysis per §10.6 #3.
- **OQ-P6-5** (Phase 7+, analyst §12.4 #5): D fresh dispatch cost-overhead measurement vs PC/S — Q2 D cost premium quantified at +4.4%/+3.6% but session-level prompt-cache amortization unexplored. **Forwarded to**: Phase 7 cost-engineering per §10.6 #4.
- **OQ-P6-6** (Phase 7+, codex condition 4 + gemini condition G-2 follow-on): 4-way selector signal validation post-OQ-P6-1 resolution. **Forwarded to**: Phase 7 selector-correctness audit per §10.6 #5.
- **OQ-P6-7** (Phase 7+, analyst §12.4 #6 + codex condition 1): meta-rule formalization of branch (b) operational tie-breaker for future tie-breaker invocations beyond the spec §2.2.1 verbatim wording. **Forwarded to**: Phase 7 meta-rule per §10.6 #6.
- **OQ-P6-8** (Phase 7+, analyst §12.4 #7 + codex condition 6 / N3): TOST family count formalization (TOST exempt from Bonferroni assumed here per spec §7.5; if Phase 7+ reviewers push back, formalize in Phase 6 conclusion ADR or Phase 7 statistical-protocol ADR). **Forwarded to**: Phase 7 methodological hygiene per §10.6 #7.

---

## §12 Sign-off

- **Drafted by**: `aigentry-architect-phase6-q2-sub-adr` (claude opus 4.7 1M, dispatched via SAWP under aigentry-orchestrator authority).
- **Cross-LLM reviewers** (Phase 6 Q2 evidence base, integrated above):
  - codex: `aigentry-reviewer-phase6-q2-codex` — devkit commit `8d7c970` — ACCEPT_WITH_CONDITIONS (0 BLOCKERS, 5 MAJORS M1–M5, 3 MINORS N1–N3; 6 sub-ADR conditions §12.1–§12.6 integrated in §3.3 + §4.1 + §4.2 + §4.3 + §5 + §6 + §7 + §8).
  - gemini: `aigentry-reviewer-phase6-q2-gemini` — uncommitted file `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-gemini-review.md` (referenced via shared context per dispatch source-of-truth #3) — ACCEPT_WITH_CONDITIONS (0 BLOCKERS, 2 MAJORS, 1 MINOR; 3 conditions G-1 / G-2 / G-3 integrated §6 + §4.3 + §5 + §8).
- **Awaiting**: User approval (oikim @ aigentry-orchestrator-claude). Status flips to `accepted` on approval per `references/frontmatter-schema.md` §검증규칙 + architect AGENTS.md §5.6 INVARIANT.
- **Self-check (architect CLAUDE.md §6 7-item rubric)**: 7/7 PASS —
  1. §1.1 explains "why this sub-ADR now" (parent §4.2 D-maintained pending pre-registered evidence; Q2 binding satisfies; reversal justified per gemini §1).
  2. §3.4 + §4.1 cite §2.2.1 PROMOTE alternative AND §2.2.2 maintain alternative; §4.3 cites single-cell selector vs proposed 4-way selector design alternatives with full constraints; rejection of "branch (b) is sufficient evidence" framing cited per cross-LLM consensus §4.2.
  3. §3 + §4 + §5 + §6 + §7 cite analyst (`737a247`) / codex (`8d7c970`) / gemini (uncommitted) source for every quantitative or methodological claim.
  4. §10.7 (backward compat across all consumers) + §11 (8 OQs forwarded) + §10.6 (7 Phase 7+ follow-ups address cross-LLM caveats) cover Consequences including §4.2 branch (b) failure mode (cross-CLI claim must hold under Phase 7 verification).
  5. §10.7 backward compat additive across all consumers (orchestrator selector, AGENTS.md, docs/rules.md, parent ADR §4.2 record-of-change, Q1 sister sub-ADR layer-1-co-extension, coder sessions, end users).
  6. §9 Constitution Check (Q1–Q5 PASS + Articles 1, 2, 5, 9, 13, 17 PASS; Article 2 PASS-with-caveat carried verbatim from parent + cross-CLI extension forwarded).
  7. §10.6 Phase 7+ binding pre-reg requirements (cross-CLI verification, non-ceiling fixture, hierarchical re-analysis, selector validation, cost-overhead, meta-rule, TOST family count) constitute the Verification Plan with explicit success thresholds where pre-registered.
- **Hard-rule grep verification** (per dispatch hard rules):
  - **Hard rule 1**: 9 cross-LLM conditions quoted verbatim before classification (codex 6 + gemini 3) — §8 conditions matrix, §4.3 (codex M4 + gemini G-2), §5.2 / §5.3 (codex M3 + gemini G-3), §6.1 (gemini G-1), §7.1 (codex N1 + N2 + condition 5), §7.3 (codex N3) — verified.
  - **Hard rule 2**: branch (b) transparency caveat per cross-LLM consensus — §4.2 explicit two-component decomposition (empirical equivalence + operational policy; cross-CLI portability flagged "POLICY CLAIM, NOT VERIFIED BY Q2") — verified.
  - **Hard rule 3**: 4-way selector design proposed (OQ-P6-1) with explicit "to be locked in Phase 6 conclusion ADR" note — §4.3 + §11 OQ-P6-1 — verified.
  - **Hard rule 4**: mirror Q1 sub-ADR format (similar section structure) — sections §1–§12 align with Q1 sub-ADR §1–§13 structure; Q2 folds Q1's separate §11 Phase 6 Q1 Closure block into §4.1 time-box note + §10.5 (Phase 6 conclusion ADR forward gate) + §10.6 (Phase 7+ follow-ups) + §11 OQ Forwarded + §12 Sign-off; substantive mirror preserved per dispatch hard rule 4 "similar section structure" (§1 Status/Context/Amends → §2 Decision Summary → §3 Evidence Base → §4 Decision (HARD-NUMBERED) → §5 H10 Ceiling → §6 Cross-CLI → §7 SD=0 / methodology caveat → §8 Conditions Matrix → §9 위헌 심사 → §10 Implementation Plan → §11 OQ Forwarded → §12 Sign-off) — verified.
  - **Hard rule 5**: NO code in this ADR — illustrative pseudo-code only, marked `pseudo` / non-executable per architect §5.1 — §4.3.1 only — verified.
  - **Hard rule 6**: spec-document-reviewer post-fix — completed iter-1 PASS with 3 minor cross-reference corrections applied (§9.6 제5조 row §3.7→§3.4; §12 self-check item 2 §3.7→§3.4; §12 hard-rule-4 §13 numbering clarification + §12 hard-rule grep §13→§12).
  - "equivalence" wording confined to TOST contexts (Phase 6 spec §7.3 codex C1 wording discipline): grep-verified — `equivalence` appears only in TOST-result tables (§3.3.1 / §3.3.2 / §3.5 / §3.6) + §2.2.1 verbatim + §4.1 verdict + §3.3.4 branch (b) trigger + §4.2 transparency decomposition (referencing the equivalence component explicitly) + §7.2 inspection-only downgrade. No claim of statistical equivalence outside TOST context.
  - Pre-reg sacred — Q2 binding endpoints unchanged: tag `exec-mode-v6-preregistered-20260502` cited as immutable in §1, §3, §11; §3.2.1 fallback cited as pre-registered fallback path (orchestrator commit `6ec2237` post-tag, pre-fire) per spec §3.4 + §3.4.1 #6 HARD LIMIT; no post-hoc reweighting per codex C3 / Phase 6 spec §9.4 invariant.

---

*End of sub-ADR `2026-05-03-d-promotion-phase6-promote.md`. Status: proposed (2026-05-03). Amends `2026-05-01-rule-4-a-step-4-final-lock.md` §4.2 (record-of-change pattern; mirror Q1 sister sub-ADR's parent §4.5 amendment cascade `abda5dd`). Sister to `2026-05-03-substitute-compact-phase6-promote.md` (Q1 PROMOTE accepted commit `c758a49`). Together with Q1 sister sub-ADR + Q3 ADR (`2026-05-02-output-style-fixture-design-rule.md`), this sub-ADR realizes Phase 6 spec §9.4 outcome state S1 (Q1 promote + Q2 promote); Phase 6 conclusion ADR (separate architect dispatch per spec §10.8) composes the unified Step 4 candidate set + locks the final 4-way deterministic single-signal Layer 1 selector per §4.3 design proposal.*
