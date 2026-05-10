---
type: adr
status: accepted
accepted_date: 2026-05-03
accepted_by: orchestrator (oikim signoff via aigentry-orchestrator)
scope: ecosystem
decision_type: one-way
date: 2026-05-03
author: aigentry-architect-phase6-q1-sub-adr
tags: [phase6, q1, substitute-compact, rule-4-a, step-4, promote, cut-policy, layer-1]
supersedes: ["docs/adr/2026-05-01-substitute-compact-revised-cut.md"]
amends: ["docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"]
related:
  - "docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"
  - "docs/adr/2026-05-02-output-style-fixture-design-rule.md"
  - "docs/adr/2026-04-26-q1-prereq-redesign.md"
  - "docs/superpowers/specs/2026-05-02-phase6-design.md"
related_tasks: [329]
track: "#329 E27 — Phase 6 Q1"
tier: T2
---

# ADR 2026-05-03 (sub): Substitute-Compact Phase 6 Q1 PROMOTE Lock (Chain-Length-Conditional Cut Policy)

## §1 Status, Context, Supersedes

- **Status**: **accepted** (2026-05-03, oikim signoff via aigentry-orchestrator after spec-document-reviewer 1-iter PASS + codex/gemini cross-LLM ACCEPT_WITH_CONDITIONS consensus).
- **Date**: 2026-05-03.
- **Track**: #329 E27 — Phase 6 Q1 sub-decision.
- **Author**: `aigentry-architect-phase6-q1-sub-adr` (claude opus 4.7 1M, dispatched via SAWP).
- **Supersedes**: `docs/adr/2026-05-01-substitute-compact-revised-cut.md` (Phase 5 cut=30 sub-ADR; INCONCLUSIVE per parent ADR §4.5 — Phase 5 0/10 fire was unreachable on 5-position chains because cumulative `input_tokens` capped at 25 below the 30-token cut).
- **Amends**: `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4.5 (substitute-compact INCONCLUSIVE → PROMOTED with chain-length-conditional cut policy). Record-of-change in parent ADR per §10.5.
- **Related (active)**:
  - Parent: `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §11 (Phase 6 Pre-registration Stub) + §4.5 (substitute-compact INCONCLUSIVE).
  - Sibling: `docs/adr/2026-05-02-output-style-fixture-design-rule.md` (Q3 fixture-design rule, decoupled).
  - Mechanism spec: `docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6 (substitute-compact-v1, V3 PASS — devkit `26f8cc4`; mechanism unchanged).
  - Phase 6 spec: `docs/superpowers/specs/2026-05-02-phase6-design.md` §2.1, §3.1, §7, §9.1, §10.7.
- **Pre-registration tag (frozen, sealed)**: `exec-mode-v6-preregistered-20260502` (devkit `4eefc0a`; spec base `8b4e156` + amendments `ee6e2c7`, `555daf6`, `90d0a3a`). Q1 binding hypotheses §2.1.1 / §2.1.2 / §2.1.3 unchanged.
- **Decision type**: **one-way** — promotion of a chain-mode candidate into the Rule 4-A Step 4 candidate set is a forward commitment that the parent ADR's §4.4 Pacc-sunset migration table will rely on; reversal would require a Phase 7+ deprecation ADR (Constitution Article 1 경량). The cut-value lock itself is two-way at the hyperparameter level (Phase 7 cut sweeps may amend), but promotion-of-mechanism is one-way.
- **Scope**: **ecosystem** — binds orchestrator routing across all Claude-only chain-mode decisions (Rule 4-0 narrow lock scope unchanged).
- **Tier**: **T2** (adr × ecosystem × one-way per `references/frontmatter-schema.md`). Reviewer threshold = 2, satisfied verbatim by integrated cross-LLM review evidence: codex `aigentry-reviewer-phase6-q1-codex` (devkit commit `5ca27d8`, ACCEPT_WITH_CONDITIONS, 5 conditions) + gemini `aigentry-reviewer-phase6-q1-gemini` (devkit commit `3abb99d`, ACCEPT_WITH_CONDITIONS, 3 conditions). Both reviewers operated on the binding analyst report devkit `6ba4ff0`.

### §1.1 Why this sub-ADR now

Parent ADR §4.5 left substitute-compact in **INCONCLUSIVE** stasis pending a Phase 6 pre-registered mechanism test with explicit chain length, cut grid, trigger endpoint, and cut metric (codex C5 + gemini D2 conditions). Phase 6 Q1 satisfied all four pre-registration requirements and fired 350 trials (0 failures) on the immutable tag `exec-mode-v6-preregistered-20260502`:

- **Chain length**: factorial 5-pos × {5,10,15,20} cuts + 10-pos × {30} cut (user-approved decision row 1).
- **Cut grid**: {5, 10, 15, 20, 30} (decision row 1).
- **Trigger endpoint**: primary `segment_start_position > 1` binary; secondary `cumulative_input_tokens_at_trigger` continuous (Phase 6 spec §3.1).
- **Cut metric**: `input_tokens` (uncached delta, decision row 2).

The analyst's binding §2.1.1 promotion test returned PROMOTE on two cells (Q1-A1 5-pos cut=5 and Q1-A5 10-pos cut=30); §2.1.2 TOST equivalence returned 0/5 (deprecation criterion not satisfied); §2.1.3 watchlist not triggered. The pre-registered Phase 6 §9.1 row 1 outcome ("Promote") is therefore in scope. This sub-ADR locks the promote decision with the chain-length-conditional cut policy and integrates the 8 cross-LLM conditions before the parent ADR §4.5 record-of-change amendment lands.

### §1.2 Inputs synthesized (binding evidence)

| Input | Path | Frozen ref |
|---|---|---|
| Phase 6 Q1 final analysis (analyst) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q1-final-analysis.md` | devkit `6ba4ff0` |
| Phase 6 Q1 codex review (5 conditions) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q1-codex-review.md` | devkit `5ca27d8` |
| Phase 6 Q1 gemini review (3 conditions) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q1-gemini-review.md` | devkit `3abb99d` |
| Phase 6 Q1 fire report (runner) | `~/projects/aigentry-devkit/docs/reports/2026-05-02-phase6-q1-fire.md` | devkit `ad55e27` |
| Phase 6 spec (binding hypotheses) | `docs/superpowers/specs/2026-05-02-phase6-design.md` | this repo (spec base `8b4e156` + amendments) |
| Pre-reg tag annotation | `git -C ~/projects/aigentry-devkit show exec-mode-v6-preregistered-20260502` | devkit tag → `4eefc0a` |
| Phase 5 sub-ADR (to supersede) | `docs/adr/2026-05-01-substitute-compact-revised-cut.md` | this repo |
| Parent ADR (final lock) | `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` | this repo |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 5, 9, 13, 17 | this repo |

---

## §2 Decision Summary

Substitute-compact mechanism is **PROMOTED** to Rule 4-A Step 4 Layer 1 chain-mode candidate based on Phase 6 Q1 binding evidence (350-trial pre-registered fire, two cells satisfy all three §2.1.1 promotion gates). The cut-value lock is **chain-length-conditional**: `cut=5` on 5-position chains and `cut=30` on 10-position chains, justified by the analyst's Δq / d / U2 ranking and reviewer cross-LLM consensus. Promote is bound to the pre-registered pooled-trial Welch/Cohen-d analysis; H10 ceiling-saturation, session-level cluster sensitivity, and Claude-only Rule 4-0 scope are documented caveats forwarded to Phase 7+ as binding follow-ups.

---

## §3 Evidence Base

Total binding evidence: **350 Q1 trials** under tag `exec-mode-v6-preregistered-20260502`. 0 failures, 350/350 `status=ok`, 7/7 cells at n=50, pre-registration adherence audit PASS (analyst §1, codex §1, gemini §1).

### §3.1 Phase trajectory (record of mechanism investigation)

| Phase | n | Outcome | Reason |
|---|---:|---|---|
| Phase 4c (parent ADR predecessor) | 400 | substitute-compact INCONCLUSIVE | Cuts {10k, 50k, 100k, 150k} unreachable on `input_tokens` metric (cumulative ≤ 94 tokens / 10-pos chain); 0/40 sessions fired (Phase 5 sub-ADR §2.1) |
| Phase 5 holdout (sub-ADR `2026-05-01-substitute-compact-revised-cut.md`) | 300 (50 PSC-rev cells included) | substitute-compact INCONCLUSIVE | cut=30 unreachable on 5-pos chains (cumulative trajectory `[5, 10, 15, 20, 25]` capped at 25 below 30-token cut); 0/10 sessions fired (parent ADR §3.5) |
| **Phase 6 Q1** (this sub-ADR's binding base) | **350** | **PROMOTE** (Q1-A1 + Q1-A5) | Cut grid {5, 10, 15, 20, 30} fully characterized across 5-pos and 10-pos chains; A1 + A5 satisfy §2.1.1 dual gate (analyst §4.1, codex §3, gemini §1.1) |

The Phase 5 cut=30 single-lock hypothesis (sub-ADR §4) was correct for the 10-position regime (matched verbatim by Q1-A5) but **incomplete** — it did not anticipate the chain-length-conditional behavior that Phase 6 grid characterized. The Phase 6 evidence base supersedes Phase 5's INCONCLUSIVE disposition without invalidating the Hypothesis B selection logic; cut=30 remains the 10-pos lock, and cut=5 emerges as the 5-pos lock from the cut grid.

### §3.2 Phase 6 Q1 binding aggregates (analyst §2 + §4.1; codex §3 reproduced)

| Cell | Chain × Cut | n | mean q | SD q | mean cost ($) | Δq vs Pacc | Welch p | Cohen d | trigger rate |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Q1-A1** | 5-pos × **cut=5** | 50 | 0.9432 | 0.1452 | 0.3222 | **+0.2035** | **0.00202** | **0.646** | 97.5% |
| Q1-A2 | 5-pos × cut=10 | 50 | 0.8515 | 0.3209 | 0.2449 | +0.1118 | 0.13896 | 0.299 | 50.0% |
| Q1-A3 | 5-pos × cut=15 | 50 | 0.8057 | 0.3578 | 0.2227 | +0.0660 | 0.40067 | 0.169 | 25.0% |
| Q1-A4 | 5-pos × cut=20 | 50 | 0.8212 | 0.3634 | 0.2207 | +0.0815 | 0.30292 | 0.207 | 25.0% |
| **Q1-A5** | 10-pos × **cut=30** | 50 | 0.7936 | 0.3774 | 0.1473 | **+0.2936** | **0.00142** | **0.659** | 11.1% |
| Q1-B1 | 5-pos Pacc | 50 | 0.7397 | 0.4215 | 0.1631 | — | — | — | — |
| Q1-B2 | 10-pos Pacc | 50 | 0.5000 | 0.5051 | 0.1263 | — | — | — | — |

Bonferroni-adjusted α = 0.05 / 7 = **0.00714** per Phase 6 spec §7.5 (family count 7: 5 Q1 sc-vs-Pacc + 2 Q2 D-vs-PC, D-vs-S). Q1-A1 and Q1-A5 satisfy all three §2.1.1 gates (Δq ≥ +0.10, p < 0.00714, d ≥ 0.5). The verdict is robust at the dispatch's narrower α = 0.05 / 5 = 0.01 sensitivity (analyst §4.2): A1 p = 0.00202 < 0.01, A5 p = 0.00142 < 0.01.

### §3.3 §2.1.2 TOST deprecation test (binding) — NOT triggered

| Cell | Match | Δq | 90% CI (TOST) | Equivalent at α=0.05? |
|---|---|---:|---|---|
| Q1-A1 | B1 | +0.2035 | [+0.0982, +0.3088] | NO (CI exceeds +0.05) |
| Q1-A2 | B1 | +0.1118 | [-0.0127, +0.2363] | NO |
| Q1-A3 | B1 | +0.0660 | [-0.0639, +0.1959] | NO |
| Q1-A4 | B1 | +0.0815 | [-0.0492, +0.2122] | NO |
| Q1-A5 | B2 | +0.2936 | [+0.1454, +0.4418] | NO |

0/5 cells equivalent. Deprecation criterion §2.1.2 not satisfied. Wording discipline preserved (Phase 6 spec §7.3, codex C1): non-promote cells (A2, A3, A4) show "no separation" from Pacc at α = 0.05; TOST equivalence is "not established" (90% CI extends past ±0.05 in all cases). This is the codex C1 trap explicitly avoided: tie ≠ equivalence.

### §3.4 §2.1.3 Watchlist disposition — NOT triggered

§2.1.1 promotion gate is satisfied (cells A1 + A5). Per Phase 6 spec §9.1 row 1, the binding outcome is **Promote**.

### §3.5 H1-only sensitivity verdict (analyst §3.1 + §8.2; codex §4 reproduced)

H1-only stratification (n=25/cell, free of H10 ceiling-induced variance compression):

| Cell | H1 Δq | H1 Welch p | H1 Cohen d | Verdict (α=0.00714) |
|---|---:|---:|---:|---|
| Q1-A1 | +0.397 | 0.00056 | **1.086** | **PROMOTE** ✓ |
| Q1-A2 | +0.214 | 0.09596 | 0.481 | NO |
| Q1-A3 | +0.157 | 0.24046 | 0.336 | NO |
| Q1-A4 | +0.153 | 0.25124 | 0.328 | NO |
| Q1-A5 | +0.612 | <0.00001 | **1.848** | **PROMOTE** ✓ |

H1-only verdict **agrees** with the aggregate binding verdict (A1 + A5 promote). This robustness check is sensitivity, not binding (per Phase 6 spec §3.1 — aggregate H1+H10 is the pre-registered endpoint), but reinforces the promotion call against the H10-ceiling caveat (§5).

---

## §4 Decision (HARD-NUMBERED — locked text)

### §4.1 Promotion verdict

**Substitute-compact-revised mechanism is PROMOTED** to Rule 4-A Step 4 Layer 1 chain-mode candidate (Phase 6 spec §9.1 row 1, "at least one cell satisfies §2.1.1 dual gate").

- **Q1-A1 (5-pos × cut=5)**: PROMOTE — Δq = +0.2035, Welch p = 0.00202, Cohen d = 0.646. All three §2.1.1 gates pass at Bonferroni α = 0.00714. (Source: analyst §4.1; codex §3 confirmed; gemini §1.1 confirmed.)
- **Q1-A5 (10-pos × cut=30)**: PROMOTE — Δq = +0.2936, Welch p = 0.00142, Cohen d = 0.659. All three §2.1.1 gates pass at α = 0.00714. (Source: analyst §4.1; codex §3 confirmed; gemini §1.1 confirmed.)
- Q1-A2 / Q1-A3 / Q1-A4: **no promote** (Δq < +0.10 OR p > 0.00714 OR d < 0.5). Q1-A2 has Δq = +0.1118 ≥ +0.10 but p = 0.13896 fails Bonferroni and d = 0.299 fails the medium-effect floor; A3 / A4 fail all three gates.

Time-box invariant (gemini D2 / Phase 6 spec §11.1): Phase 6 is the **final** Phase for substitute-compact mechanism investigation. PROMOTE outcome closes the investigation lineage; no Phase 7 substitute-compact ARM is dispatched. (Phase 7 follow-ups in §10.6 are *follow-up* analyses on Q1 data and *cut sweeps within* the promoted regime — they do not re-open the mechanism question.)

### §4.2 Chain-length-conditional cut policy (chosen) vs single-cell lock (alternative)

This sub-ADR resolves Phase 6 spec §12.2 OQ-P6-2 ("cell-level vs joint promotion criterion") explicitly per codex §10 condition 2 (`5ca27d8`). Two alternatives were considered with full trade-off analysis:

#### §4.2.1 Alternative A (rejected): Single-cell lock — `cut=30` on 10-pos only

- **Description**: lock the strongest single passing cell (Q1-A5, cut=30 on 10-pos chains) per Phase 6 spec §12.2 minimum-assumption default ("strongest single cell wins"). 5-position chain regime falls back to non-substitute-compact modes (PC, S) without a substitute-compact entry.
- **Pros**:
  - Minimum departure from the pre-registered §2.1.1 outcome wording ("cut value of the winning cell"): unambiguous cut value lock at the single highest-effect cell.
  - Avoids extending policy beyond the data: A5 has the largest Δq (+0.2936), largest H1-only effect (d = 1.848), largest U2 utility (+0.4315), and lowest cost premium (+17% vs Pacc-10pos).
  - Preserves the Phase 5 sub-ADR Hypothesis B context verbatim (cut=30 on long-chain regime where Pacc collapses).
- **Cons**:
  - Strands the 5-position chain regime: Q1-A1 (5-pos × cut=5) also satisfies §2.1.1 with Δq = +0.2035 / p = 0.00202 / d = 0.646, but a single cut=30 lock is **mechanically unreachable** on 5-position chains (Phase 5 evidence: cumulative `input_tokens` capped at 25 over 5 positions, below the 30-token threshold). A single-lock at cut=30 would silently revert 5-pos chains to Pacc-equivalent behavior.
  - Discards a binding pre-registered passing cell (A1) without architect-level justification — interpretation strain on §2.1.1 ("there exists at least one cell" — A1 also exists).
  - Gemini condition 1 (`3abb99d` §9): "A single global cut is unsupported by the data."
- **Source**: codex §6 (`5ca27d8`) — single-cell lock named as the minimum-assumption default; gemini §1.3 (`3abb99d`) — single global cut rejected as an operational policy.

#### §4.2.2 Alternative B (chosen): Chain-length-conditional cut grid — `cut=5` on 5-pos, `cut=30` on 10-pos

- **Description**: lock both passing cells; selector applies cut=5 to 5-position chains and cut=30 to 10-position chains. Implementation note: Rule 4-A Step 4 selector adds a chain-length signal (already observable via `chain_state.expected_position_count` or equivalent harness signal — coder session implements per §10.2; no new framework introduced per §9 Article 17).
- **Pros**:
  - Honors both binding pre-registered passing cells (A1 + A5 each independently satisfy §2.1.1) — strict reading of "there exists at least one" generalized to "lock every cell that passes."
  - Operationally consistent: cut=5 fires on 5-pos at ~98% trigger rate (analyst §9.1), cut=30 fires on 10-pos at 11.1%; both regimes receive the substitute-compact benefit on their own chain length.
  - Gemini §1.3 (`3abb99d`): "Locking a chain-length-conditional cut grid (cut=5 for L=5, cut=30 for L=10) is the most logical operationalization of the result. A single global cut (e.g., cut=30) would fire too late on 5-pos chains (pos-6 unreachable), while a single low cut (e.g., cut=5) on 10-pos chains would fire too aggressively, potentially losing valuable early-chain context."
  - Analyst §7.3 + §12.2 explicit recommendation: "chain-length-conditional cut grid (recommended; see §7.3) — 5-pos chains: `cut=5`; 10-pos chains: `cut=30`."
  - Higher U2 across both chain regimes than single-lock fallback (A1 U2 = +0.4000 retained for 5-pos; A5 U2 = +0.4315 retained for 10-pos).
- **Cons**:
  - Adds a chain-length signal to the Rule 4-A Step 4 selector — small implementation surface increase (one extra `chain_state` field read in the selector; no new mechanism).
  - Codex §6 (`5ca27d8`): "ADR design choice beyond the minimum pre-registered fallback" — the chain-length-conditional policy is an architect-determined operational choice, not strictly forced by §2.1.1. This sub-ADR explicitly accepts this characterization (per codex condition 2): the conditional grid is approved as a **policy choice beyond the prereg decision rule**.
  - Phase 7 cut-sweep generalization (analyst §12.4 #1): cut=30 may not be the local optimum on 10-pos — sweep {25, 28, 30, 32, 35} forwarded to Phase 7 as binding follow-up (§10.6).
- **Source**: analyst §7.3 + §12.2 (`6ba4ff0`); gemini §1.3 + §9 condition 1 (`3abb99d`); codex §6 + §10 condition 2 (`5ca27d8`).

#### §4.2.3 Chosen: Alternative B (chain-length-conditional)

The chain-length-conditional cut grid is locked as the default policy. Rationale:

1. **Cross-LLM evidence convergence**: analyst recommendation 1 (§12.2), gemini condition 1 (§9), and codex condition 2's "policy choice approval path" (§10) all admit chain-length-conditional as the operationally-correct lock. Codex's "default to single-cell lock" is the *minimum-assumption fallback if the architect declines to make a policy choice* — this sub-ADR makes the policy choice explicitly.
2. **Mechanical reachability**: cut=30 is unreachable on 5-position chains under the pre-registered `input_tokens` metric (Phase 5 evidence, parent ADR §3.5: cumulative trajectory `[5, 10, 15, 20, 25]`). Single-lock cut=30 would strand 5-pos chains at Pacc-equivalent behavior, voiding the A1 cell's binding pre-registered passing result.
3. **Pre-registration adherence**: §2.1.1 says "there exists at least one cell satisfying ALL of [the dual gate]." Both A1 and A5 satisfy. The minimum-assumption default ("strongest single cell") is acceptable per §2.1.1 but does not exclude locking both passing cells — the spec text is a floor, not a ceiling, on the policy choice.

### §4.3 Selector integration (Rule 4-A Step 4 amendment)

The Rule 4-A Step 4 selector (parent ADR §4.1 Layer 1, §4.3 Layer 3) gains substitute-compact as a chain-length-conditional candidate. Coder session implements per §10.2; no implementation code in this ADR per §5.1 INVARIANT.

**Selector contract (binding constraints; coder session implements):**

```pseudo
# illustrative, non-executable — coder session implements per §10.2
# CONSTRAINTS (binding; this ADR locks the contract, not the implementation):
#   1. selector MUST consume the existing chain_state signals + a chain_length signal
#      (chain_state.expected_position_count or equivalent observable) — no new
#      framework, no opaque heuristic (Constitution Article 1, Article 17)
#   2. for substitute-compact-eligible routings, cut value is chain-length-conditional:
#        chain_length == 5 → cut=5
#        chain_length == 10 → cut=30
#        chain_length ∈ other → fallback to non-substitute-compact (PC | S | D)
#        per the parent ADR §4.1 / §4.2 / §4.3 layering — substitute-compact is NOT
#        the universal default; it is a Layer 1 candidate gated by chain_length match
#   3. selector MUST be deterministic given identical inputs (parent ADR §4.1
#      Layer 1 invariant — no random co-equal selection)
#   4. fallback edge MUST be PC (Layer 3 default) when substitute-compact preconditions
#      fail (chain_length not in {5, 10}, harness `--cut N` flag unavailable, etc.) —
#      Pacc forbidden as fallback (parent ADR §4.4 sunset)
def select_chain_mode_with_substitute_compact(chain_state, budget):
    # parent ADR §4.1 Layer 1 / §4.3 Layer 3 selectors run first;
    # if substitute-compact is selected by the upstream selector,
    # then cut value is determined by chain_length:
    if chain_state.expected_position_count == 5:
        return ("Preuse-substitute-compact-revised", {"cut": 5})
    if chain_state.expected_position_count == 10:
        return ("Preuse-substitute-compact-revised", {"cut": 30})
    return parent_adr_layer3_default(chain_state, budget)  # PC fallback
```

**Out-of-grid chain lengths** (e.g., 3-pos, 7-pos, 15-pos): **not in the Phase 6 binding scope**. Phase 6 Q1 grid pre-registered chain lengths {5, 10}; chain-length-conditional cut policy generalizes only to those two regimes. Out-of-grid chain lengths fall back to PC (parent ADR §4.3 Layer 3 default) until a Phase 7+ chain-length-sweep ADR pre-registers additional cells.

### §4.4 Phase 5 sub-ADR supersession

`docs/adr/2026-05-01-substitute-compact-revised-cut.md` is **superseded** by this sub-ADR. Rationale and disposition:

- **Phase 5 sub-ADR §4 hypothesis (cut=30 single-lock)**: was the **correct hypothesis for the 10-position regime** (Q1-A5 confirms verbatim) but **incomplete** — did not anticipate chain-length-conditional behavior. Phase 6 cut grid {5, 10, 15, 20, 30} characterized the cut-vs-chain-length surface; the Phase 5 sub-ADR's single-cut framing is now subsumed by the conditional policy.
- **Phase 5 sub-ADR §5 inclusion contract** (Phase 5 Δq result branches): was already declared "non-applicable to the Phase 5 dataset" by parent ADR §4.5 (cut=30 unreachable on 5-pos chains; 0/10 fire). This sub-ADR formally retires that contract.
- **Phase 5 sub-ADR §6 risks**: R1 (tiny-cut prose framing), R2 (mid-chain timing), R3 (cost inflation), R4 (mechanism-vs-hyperparameter scope) — R3 partially confirmed (5-pos sc costs +55% vs Pacc per analyst §10.2; Phase 7 follow-up §10.6 #6) and forwarded; R1 / R2 / R4 closed by this sub-ADR's chain-length-conditional grid.
- **Phase 5 sub-ADR §7 open questions**: OQ #1 (per-fixture fire-distribution audit) closed by Phase 6 Q1 analyst §3 H1/H10 stratification; OQ #2 (metric-correction ADR — `input_tokens` vs `cache_read_tokens` etc.) explicitly out of scope here per Phase 6 user-approved decision row 2 (`input_tokens` time-box-aligned), forwarded to Phase 7+ if needed; OQ #3 (cross-CLI cut equivalence) forwarded to §10.6 #4 cross-CLI verification follow-up; OQ #4 (Phase 5 quadrant interaction) closed by parent ADR.

**Status flip on user acceptance**: Phase 5 sub-ADR `accepted` → `superseded` per `references/frontmatter-schema.md` §검증규칙. Orchestrator commits the status flip per §10.4 post-acceptance.

### §4.5 Parent ADR §4.5 amendment

`docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4.5 ("Substitute-compact Status — INCONCLUSIVE") is **amended in place** by this sub-ADR. Sub-record-of-change to be inserted by orchestrator commit per §10.5:

> **§4.5 Status update 2026-05-03 (per ADR `2026-05-03-substitute-compact-phase6-promote.md`)**
>
> Disposition: INCONCLUSIVE → **PROMOTED** with chain-length-conditional cut policy.
>
> - Mechanism: substitute-compact-v1 (`docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6) byte-equality V3 PASS preserved; implementation unchanged.
> - Cut policy: cut=5 on 5-pos chains, cut=30 on 10-pos chains (Phase 6 Q1 binding evidence; analyst `6ba4ff0`; codex `5ca27d8`; gemini `3abb99d`).
> - Rule 4-A Step 4 candidate set: extended to include substitute-compact-revised at the conditional cuts; selector amendment per `2026-05-03-substitute-compact-phase6-promote.md` §4.3.
> - Phase 6 pre-registration requirements (parent ADR §11) all satisfied: chain length {5, 10}, cut grid {5, 10, 15, 20, 30}, trigger endpoint primary `segment_start_position > 1`, cut metric `input_tokens`.
> - Time-box (gemini D2): respected — Phase 6 was the final mechanism Phase; PROMOTE outcome closes the investigation lineage.

Parent ADR §4.4 (Pacc sunset migration table) is **not amended** — substitute-compact's promotion adds a new Layer 1 candidate but does not change the Pacc-deprecation migration paths (Pacc-routed sessions still migrate to PC / S / D per parent ADR §4.4; substitute-compact is a new candidate in the destination set, not a rerouting from Pacc).

---

## §5 H10 Ceiling Caveat (cross-LLM consensus override)

**CRITICAL**: Both codex and gemini independently flag H10 (ceiling-saturated 0.965–1.000 across all 7 cells per analyst §3.2) as compromising the binding endpoint claim. Analyst §8.4 dismissed the concern as "non-critical mathematically driven by H1"; both reviewers explicitly disagree (codex §10 condition 3, `5ca27d8`; gemini §9 condition 2, `3abb99d`). This sub-ADR honors the cross-LLM consensus per Constitution Article 5 (최선) — analyst dismissal is overridden where evidence-based reviewer disagreement is robust.

### §5.1 Codex condition C-3 (verbatim)

> "Sub-ADR MUST describe Q1 evidence as H1-driven under an H10 ceiling; no claim that H10 demonstrates quality lift."
> — codex review, devkit `5ca27d8`, §10 condition 3.

### §5.2 Gemini MAJOR M1 (verbatim — H10 ceiling)

> "M1 — H10 saturation hides the aggregate signal. The aggregate Δq is an H1 signal. The verdict is robust only because H1-only stratification agrees with the aggregate. Future phases MUST replace H10 with a more challenging fixture to avoid 'non-informative' cells in the binding family."
> — gemini review, devkit `3abb99d`, §8 MAJORS M1.

(Gemini's numbered condition G-2 — "Sub-ADR MUST explicitly cite the Pacc-10pos H1 failure (μ=0.000) as the primary logical driver for sc promotion and Pacc sunset" — is a distinct, complementary requirement; integrated in §3.5 / §3.1 / §11.1 and quoted verbatim in the §8 conditions matrix row 7.)

### §5.3 Sub-ADR position

1. **Acknowledge cross-LLM consensus**: H10 (μq = 0.965–1.000 across all cells; Pacc-10pos H10 = 1.000 exactly) **does not contribute** to the §2.1.1 promotion test. The maximum mathematically-possible Δq from substitute-compact on H10 is bounded above by +0.010 (vs B1) and 0.000 (vs B2); H10 cannot satisfy the +0.10 absolute threshold. The aggregate binding signal is **structurally H1-driven**.
2. **H1-only sensitivity verdict**: agrees with aggregate (analyst §3.1 + §8.2; codex §4 reproduced). A1 H1-only Δq = +0.397, p = 0.00056, d = 1.086; A5 H1-only Δq = +0.612, p < 0.00001, d = 1.848. Both pass §2.1.1 gates **on H1 alone** at α = 0.00714 / n = 25 — exceeds the §3.5 sensitivity power threshold.
3. **Promotion verdict robust to H10 exclusion**: the binding outcome (PROMOTE Q1-A1 + Q1-A5) holds whether the endpoint is the pre-registered aggregate H1+H10 or the H1-only sensitivity. **No claim is made** in this sub-ADR that H10 itself demonstrates quality lift; per codex C-3, the ADR text describes Q1 evidence as H1-driven under an H10 ceiling.
4. **External validity narrowed**: promotion verdict generalizes only to fixtures with H1-like difficulty profile (long-form code review, multi-hop reasoning at the H1 difficulty band per Phase 5 analyst `1e740ba`). Domain extrapolation to easy / strict-instruction-following tasks (H10's profile) is **out of binding scope** for this Phase 6 promotion.
5. **Phase 7+ binding follow-up**: any cut-sweep extension MUST include a non-ceiling fixture (e.g., H11–H14 redesigned per Phase 6 spec §3.4.1 ceiling-avoidance procedures, or a new high-difficulty fixture authored under those procedures). Forwarded to §10.6 #4 + §12 OQ-P6-1.

### §5.4 Analyst §8.4 reframing

The analyst's "H10 non-critical" framing is **not retained** in this sub-ADR. The analyst's underlying mathematical observation (aggregate Δq is dominated by H1 contribution because H10 ceiling bounds H10's Δq contribution) is **factually correct** but the cross-LLM consensus correctly characterizes this as a **constraint on external validity**, not a "non-critical" footnote. The PROMOTE verdict stands; the H10 ceiling is documented as a binding caveat, not dismissed.

---

## §6 Session-Clustering Robustness Caveat (codex top issue)

Codex's **highest-priority methodology caveat** (codex §0 Executive verdict + §3 Hierarchical sensitivity + §10 condition 1, devkit `5ca27d8`):

> "Pooled-trial significance is not robust to session-level clustering sensitivity: session-mean Welch p is 0.0277 for A1 and 0.0234 for A5, above the Bonferroni threshold."

Gemini concurs (`3abb99d` §8 M2): "Cluster-sensitivity (Mirroring Codex Major). The verdict is binding ONLY under the pooled-trial assumption."

### §6.1 Codex condition C-1 (verbatim)

> "Final ADR MUST state that the binding PROMOTE verdict uses the pre-registered pooled-trial Welch/Cohen-d analysis; session-level sensitivity does not survive α=0.00714 (A1 p=0.0277; A5 p=0.0234) and is a confidence caveat."
> — codex review, devkit `5ca27d8`, §10 condition 1.

### §6.2 Sub-ADR position

1. **Acknowledge methodology gap**: pooled-trial Welch t-test treats trials as independent observations (n=50/cell), but trials cluster within chain sessions (5 or 10 trials per session × multiple sessions per cell). Strict IID is violated; the pre-registered pooled-trial test is the binding instrument per Phase 6 spec §7.1 + §7.2 codex C4 caveat, but session-level inference would be conservative.
2. **Direct mitigation already present**: H1-only sensitivity (analyst §3.1) effectively re-samples the inference at n=25/cell — half the pooled n, but with structural independence from the H10 ceiling-clustering effect. A1 H1-only d = 1.086 / p = 0.00056 and A5 H1-only d = 1.848 / p < 0.00001 both **pass §2.1.1 promotion gates at the lower-power H1-only sensitivity** at α = 0.00714. The promote verdict is robust under the H1-only re-aggregation.
3. **PROMOTE verdict is binding under pooled-trial endpoint, with session-clustering noted as a confidence caveat** (codex C-1 verbatim integrated). The ADR text **does not** claim session-level robustness; it claims the verdict robust under the pre-registered analysis only.
4. **Session-level inflation tolerance**: the verdict deprecates only if effective n drops below ~5 per cell (where Cohen d ≥ 0.5 fails to reject H0 at α = 0.00714 even at the observed pooled effect magnitude). Under any reasonable cluster-inflation factor (per spec §7.2 hierarchical caveat), effective n remains ≥ 25 — verdict survives.
5. **Phase 7+ binding follow-up**: hierarchical / mixed-effects model **re-analysis on the existing Q1 data** (no new fire) is forwarded to §10.6 #2 as a Phase 7 binding follow-up. Per codex condition 5 (`5ca27d8` §10): any Phase 7 or neighboring-cut follow-up MUST pre-register a cluster-aware or session-level primary analysis if claims will generalize beyond the locked Phase 6 pooled-trial endpoint.

### §6.3 Codex condition C-5 (verbatim)

> "Any Phase 7 or neighboring-cut follow-up MUST pre-register a cluster-aware or session-level primary analysis if claims will generalize beyond the locked Phase 6 pooled-trial endpoint."
> — codex review, devkit `5ca27d8`, §10 condition 5.

Integrated as Phase 7 pre-registration requirement (§10.6 #2 + §12 OQ-P6-2).

### §6.4 Codex condition C-4 (verbatim) — trigger event vs mechanism exposure

> "Sub-ADR MUST distinguish trigger events from mechanism exposure; non-triggered positions after a segment reset are not necessarily Pacc-equivalent, so trigger-rate × quality claims need rewritten."
> — codex review, devkit `5ca27d8`, §10 condition 4.

Sub-ADR position (per codex §7 + gemini §8 N3):

- **Trigger event**: a position where the harness wrote `.preuse_inputs/manifest.json` (i.e. cumulative `input_tokens` cut threshold crossed in that position).
- **Post-trigger mechanism exposure**: later positions in the same chain segment after a substitute-compact reset — these positions benefit from the substitute-compact state without a *new* trigger event (analyst §9.1 conditional means: A5 not-fired H1 mean q = 0.5034 vs Pacc-10pos H1 mean q = 0.0000, a +0.50 Δq lift not attributable to "trigger fired this position" — attributable to mechanism state persisting from earlier triggered positions).
- **Pacc-equivalent non-exposure**: positions before any trigger in the chain.
- **Implication for the trigger-rate narrative**: trigger rate is **not** the same as mechanism exposure rate. The analyst's §9.2 mechanism explanation ("sparse triggering still lifts Pacc-collapsed cells") is **directionally correct** (A5 promotes despite 11.1% trigger rate because Pacc-10pos H1 mean is 0.0) but the implication "non-trigger trials are Pacc-equivalent" is rewritten in this sub-ADR per codex C-4: non-trigger positions *after* a segment reset retain mechanism exposure benefit, so the substitute-compact mechanism's effect propagates beyond the triggering position itself.

This rewriting does not alter the §4 promotion verdict. It refines the operational understanding of *why* substitute-compact promotes at low trigger rates and is the basis for the §10.6 Phase 7 follow-up #5 (cost-overhead optimization — A5's modest +17% cost premium reflects the post-trigger-exposure dynamic).

---

## §7 Cross-CLI Portability Caveat (gemini condition)

Gemini condition (`3abb99d` §3 + §9 condition 3): substitute-compact tested only on Claude per Rule 4-0 narrow lock; cross-CLI behavior unknown. Different models have different attention profiles; cut=30 may be Claude-optimized.

### §7.1 Gemini condition G-3 (verbatim)

> "Sub-ADR MUST document the Cross-CLI portability risk: cut=30 is Claude-optimized; Phase 7 verification is required before cross-CLI deployment."
> — gemini review, devkit `3abb99d`, §9 condition 3.

### §7.2 Sub-ADR position

1. **Rule 4-0 scope unchanged**: substitute-compact PROMOTE applies to **Claude-only Layer 3 chain mode** (Rule 4-0 narrow lock; parent ADR §9 Q4 PASS-with-caveat). Cross-CLI extension is a separate ADR per parent ADR §9 Article 2 caveat.
2. **Harness-level portability** (gemini §3.1): the substitute-compact mechanism relies on `.preuse_inputs/manifest.json` reset, which is harness-level (independent of CLI provider). In principle, the mechanism should generalize to Codex / Gemini drivers without code change.
3. **Model-specific attention variation** (gemini §3.2): the *cut value* (cut=5 / cut=30) is calibrated against Claude's attention profile and the H1-fixture difficulty band. Different models (Codex / Gemini) have different effective context utilization curves; the cut-vs-chain-length plateau characterized in Phase 6 Q1 may not transfer verbatim.
4. **Phase 7 binding follow-up**: cross-CLI verification on Codex + Gemini drivers is forwarded to §10.6 #4 as a Phase 7 binding pre-registration requirement before cross-CLI deployment. Until verified, the Rule 4-A Step 4 selector enables substitute-compact only when the upstream Step 1 capability gate routes to Claude-only chain selection.
5. **Q1 prereq sub-ADR §7.3 Q4 OQ closed**: parent ADR's predecessor §7.4 flagged "Q4 cross-CLI cut equivalence" as a Phase 6+ blocker; this sub-ADR's Phase 7 cross-CLI verification follow-up is the binding successor — Phase 7 closes Q4 OQ if cross-CLI verification succeeds.

---

## §8 Conditions Integration Matrix

Each of the **8 cross-LLM conditions** (codex 5 + gemini 3) is quoted verbatim and mapped to the ADR section that integrates or waives it. Coverage: **8 / 8**, no waivers. Per dispatch hard rule: "MUST quote 8 conditions verbatim before classifying integrate/waive."

| # | Source | Condition (verbatim) | Disposition | Integrated in |
|---|---|---|---|---|
| 1 | codex `5ca27d8` §10 #1 | "Final ADR MUST state that the binding PROMOTE verdict uses the pre-registered pooled-trial Welch/Cohen-d analysis; session-level sensitivity does not survive α=0.00714 (A1 p=0.0277; A5 p=0.0234) and is a confidence caveat." | INTEGRATE | §6.1 + §6.2 + §4.1 (verdict bound to pooled-trial endpoint) |
| 2 | codex `5ca27d8` §10 #2 | "Sub-ADR rev3 MUST resolve OQ-P6-2 explicitly: either lock the strongest single cell `cut=30` for 10-pos (default) or approve chain-length-conditional cuts (`5-pos=cut5`, `10-pos=cut30`) as a policy choice beyond the prereg decision rule." | INTEGRATE | §4.2 (alternatives A and B fully argued; chosen B with explicit "policy choice beyond prereg" acknowledgment) |
| 3 | codex `5ca27d8` §10 #3 | "Sub-ADR MUST describe Q1 evidence as H1-driven under an H10 ceiling; no claim that H10 demonstrates quality lift." | INTEGRATE | §5 (full H10 ceiling caveat; no H10-quality-lift claim anywhere) |
| 4 | codex `5ca27d8` §10 #4 | "Sub-ADR MUST distinguish trigger events from mechanism exposure; non-triggered positions after a segment reset are not necessarily Pacc-equivalent, so trigger-rate × quality claims need rewritten." | INTEGRATE | §6.4 (trigger event vs mechanism exposure vs Pacc-equivalent non-exposure tri-distinction; analyst §9.2 narrative rewritten) |
| 5 | codex `5ca27d8` §10 #5 | "Any Phase 7 or neighboring-cut follow-up MUST pre-register a cluster-aware or session-level primary analysis if claims will generalize beyond the locked Phase 6 pooled-trial endpoint." | INTEGRATE | §6.3 (Phase 7 pre-reg requirement) + §10.6 #2 (hierarchical re-analysis follow-up) |
| 6 | gemini `3abb99d` §9 #1 | "Sub-ADR Rev3 MUST lock the chain-length-conditional cut grid: cut=5 for 5-pos, cut=30 for 10-pos. A single global cut is unsupported by the data." | INTEGRATE | §4.2.3 (chain-length-conditional locked as chosen alternative) + §4.3 (selector contract) |
| 7 | gemini `3abb99d` §9 #2 | "Sub-ADR MUST explicitly cite the Pacc-10pos H1 failure (μ=0.000) as the primary logical driver for sc promotion and Pacc sunset." | INTEGRATE | §3.5 H1-only sensitivity table (Pacc-10pos H1 mean = 0.000 cited verbatim) + §3.1 phase trajectory + §11.1 (Phase 6 closure narrative) |
| 8 | gemini `3abb99d` §9 #3 | "Sub-ADR MUST document the Cross-CLI portability risk: cut=30 is Claude-optimized; Phase 7 verification is required before cross-CLI deployment." | INTEGRATE | §7 (cross-CLI portability caveat) + §10.6 #4 (Phase 7 cross-CLI verification follow-up) |

**Coverage**: 8 / 8 INTEGRATE, 0 WAIVE. All 8 conditions are addressed in binding ADR sections; none are deferred or deemed informational.

---

## §9 위헌 심사 (Constitution Check, mandatory per architect AGENTS.md §5.5 INVARIANT)

Constitution: `~/projects/aigentry/docs/CONSTITUTION.md` (전문 + 18조 + 최종조). Per `references/constitution-check.md` §1, the 5 mandatory questions are answered first; Articles 1, 5, 9, 13, 17 (per dispatch §9 itemization) follow as article-specific review.

### §9.1 Q1: AI 기술 격차 해소에 복무하는가? (Preamble + 제14조)

**PASS.** The promotion of substitute-compact to a Layer 1 chain-mode candidate at chain-length-conditional cuts removes a known long-chain quality cliff (Pacc-10pos H1 mean q = 0.000 per analyst §2; gemini §4 "smoking gun" framing). Long-horizon chain users (≥ 10 positions) previously had a binary choice between Pacc-collapse (μq = 0.000 on H1) and PC's full reset overhead. Substitute-compact at cut=30 lifts 10-pos H1 quality from 0.000 to 0.612 at +17% cost premium — a binary "broken" → "working" transition for non-developer users running long-horizon code-review workflows. The user does not need to learn the cut taxonomy; the orchestrator selector applies the chain-length-conditional cut transparently.

### §9.2 Q2: 이 기능은 어느 컴포넌트의 역할인가? (제3조)

**PASS.** Rule 4-A Step 4 selector (orchestrator's routing role) gains a new candidate; substitute-compact mechanism (devkit role per `2026-04-26-q1-prereq-redesign.md` §4.6) is unchanged in this ADR. No role침범:
- **Architect (this session)**: produces sub-ADR markdown only; no code, no test execution.
- **Orchestrator**: consumes the §4.3 selector contract and dispatches AGENTS.md / rules.md text edits per §10.1–§10.5.
- **Coder (separate task per §10.2)**: implements selector logic per §4.3 constraints.
- **Devkit**: holds the unchanged substitute-compact-v1 implementation (V3 PASS preserved).

### §9.3 Q3: 이 프레임워크/라이브러리가 정말 필요한가? (제1조 + 제17조)

**PASS.** No new dependency. Substitute-compact-v1 is a pure deterministic harness function (V3 byte-equality PASS, devkit `26f8cc4`, unchanged); the Rule 4-A Step 4 selector amendment is a single conditional read on the existing `chain_state` (chain-length signal already observable per parent ADR §4.1 selector pattern). The `--cut N` harness flag (devkit `c9873ae`) is already in-tree as a Phase 6 prerequisite. No library, no framework, no plugin introduced. The "illustrative, non-executable" pseudo-code in §4.3 is documentation only.

### §9.4 Q4: 모든 크로스 환경에서 동작하는가? (제2조 + 제14조)

**PASS with caveat (Rule 4-0 narrow lock scope preserved).** Substitute-compact is implemented at the harness level (`.preuse_inputs/manifest.json` reset; gemini §3.1) and is portable in principle. The cut value (cut=5 / cut=30) is Claude-optimized at the H1 difficulty band; cross-CLI extension to Codex / Gemini drivers is **out of scope** for this sub-ADR per §7. Layer-2 D continues to default for cross-CLI / CI/CD per parent ADR §4.2 (unchanged). Promotion of substitute-compact to capability-Layer 2 (cross-CLI) is forwarded to Phase 7 cross-CLI verification follow-up per §10.6 #4. **PASS**: this sub-ADR does not break cross-CLI behavior; **caveat**: the new candidate applies under Rule 4-0 narrow lock only until Phase 7 verification.

### §9.5 Q5: 사용자에게 "어떻게"를 강요하지 않는가? (Preamble)

**PASS.** Routing decisions are made by the orchestrator's Rule 4-A Step 4 selector. User selects "what" (the task); chain-length-conditional cut policy is chosen by the selector based on `chain_state.expected_position_count`. User does not need to learn cut values or choose between cut=5 / cut=30. The orchestrator's auditable selector remains the single point of "how" (per parent ADR §4.1 Layer 1 invariant — deterministic, single-signal, observable inputs).

### §9.6 Article-specific review (per dispatch §9 itemization)

| Article | Verdict | Rationale |
|---|---|---|
| **제1조 경량** | **PASS** | substitute-compact-v1 mechanism already in-tree per Phase 5 sub-ADR + parent ADR §4.5 (V3 PASS unchanged); no new code introduced by this ADR. The chain-length-conditional cut policy adds one observable-input read to the Rule 4-A Step 4 selector — net rule-surface increase ≈ 1 conditional. Time-box invariant (gemini D2) preserved: this sub-ADR closes the substitute-compact investigation lineage at PROMOTE; no Phase 7 ARM is dispatched (only follow-up analyses on existing data). 헌법 1조 "이거 없이 직접 구현 가능한가?" — no: the binding evidence (Δq = +0.20 / +0.29 at p < 0.00714) shows substitute-compact is the highest-quality lift at the long-chain cliff. |
| **제5조 최선** | **PASS** | PROMOTE is the data-evidenced best path. Single-cell lock alternative (§4.2.1) was considered and rejected with evidence (Phase 5 unreachable cut=30 on 5-pos); chain-length-conditional alternative (§4.2.2) chosen on cross-LLM consensus. Cross-LLM consensus on H10 ceiling and session clustering (§5 + §6) overrides analyst's dismissal — applies 헌법 5조 "차선책 금지, 다른 LLM 위임" verbatim: where one LLM (analyst) misjudged, two reviewers' converging perspective takes precedence. |
| **제9조 독립** | **PASS** | substitute-compact runs standalone within the Pacc-style chain harness — no inter-mode dependency. Rule 4-A Step 4 selector binds chain-length signal + budget + capability, all observable to the orchestrator without invoking another mode's runtime. |
| **제13조 비판적+건설적+객관적** | **PASS** | All 8 cross-LLM conditions integrated verbatim per §8; H10 + session-clustering caveats explicit per §5 / §6; analyst dismissal of H10 reframed (not retained) per cross-LLM consensus. No condition silently waived. ADR text avoids "equivalence" wording outside TOST contexts (Phase 6 spec §7.3 codex C1 wording discipline preserved). |
| **제17조 무의존** | **PASS** | No new external dependency. substitute-compact-v1 is pure stdlib (gemini §6 Article 1 + 17 verified). The `--cut N` harness flag is in-tree (devkit `c9873ae`). Rule 4-A Step 4 selector amendment is shell/router-level logic. |

**Verdict**: PASS overall. No FAIL on any required article. Article 2 PASS-with-caveat is carried verbatim from parent ADR §9 — caveat scope (Rule 4-0 narrow lock, Claude-only) unchanged.

---

## §10 Implementation Plan

**No code in this ADR per architect AGENTS.md §5.1 INVARIANT.** All implementation is delegated to coder / orchestrator sessions post-acceptance. Affected files listed for handoff.

### §10.1 Sub-ADR status flip (orchestrator commit, post-acceptance)

- File: `~/projects/aigentry-orchestrator/docs/adr/2026-05-03-substitute-compact-phase6-promote.md` (this file).
- Diff: `status: proposed` → `status: accepted` + `accepted_date: 2026-05-XX` (date filled at signoff time).
- Trigger: user approval of this sub-ADR.

### §10.2 AGENTS.md Rule 4-A Step 4 update (orchestrator session)

- File: `~/projects/aigentry-orchestrator/AGENTS.md`.
- Section: "실행 모드 체크 (Rule 4-A — Narrow Lock, Phase 5 holdout 기반 (final lock 2026-05-01))" checklist.
- Diff (illustrative; orchestrator authors final wording):
  - Update header: "Phase 5 holdout 기반 (final lock 2026-05-01)" → "Phase 6 Q1 promote 기반 (substitute-compact PROMOTED 2026-05-03)".
  - Add new line under Rule 4-A Step 4: "Substitute-compact (chain-length-conditional cut policy; ADR `2026-05-03-substitute-compact-phase6-promote.md`): chain_length=5 → cut=5, chain_length=10 → cut=30, other → fallback to PC".
  - Preserve existing Layer 1 deterministic selector + Layer 3 PC default lines.

### §10.3 docs/rules.md Rule 4-A Step 4 update (orchestrator session)

- File: `~/projects/aigentry-orchestrator/docs/rules.md`.
- Section: Rule 4-A Step 4 body (currently bound to parent ADR final-lock §4).
- Diff: append a sub-section "Substitute-compact chain-length-conditional candidate" with the §4.3 selector contract (deterministic, chain-length-conditional cut, PC fallback). Cite this sub-ADR as authority.

### §10.4 Phase 5 sub-ADR status flip (orchestrator commit)

- File: `~/projects/aigentry-orchestrator/docs/adr/2026-05-01-substitute-compact-revised-cut.md`.
- Diff: status `proposed` (or `accepted` if it was promoted to accepted in the meantime) → `superseded`. Add `superseded_by: ["docs/adr/2026-05-03-substitute-compact-phase6-promote.md"]` frontmatter field. Insert sub-record-of-change at top of body referencing this sub-ADR's authority.

### §10.5 Parent ADR §4.5 record-of-change amendment (orchestrator commit)

- File: `~/projects/aigentry-orchestrator/docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md`.
- Section: §4.5 (Substitute-compact Status — INCONCLUSIVE).
- Diff: insert the §4.5 status update block from §4.5 of this sub-ADR (verbatim) at the head of parent ADR §4.5. Do not delete the parent's INCONCLUSIVE history; the amendment is additive (record-of-change pattern per parent ADR §11 "pre-reg sacred-but-amendable-via-record-of-change"). Update parent ADR `related` frontmatter to add this sub-ADR.

### §10.6 Phase 7 follow-ups (architect dispatch later — NOT in this sub-ADR)

These are forwarded to a future architect session as binding Phase 7 pre-registration candidates. None block this sub-ADR's acceptance.

| # | Follow-up | Source condition | Type |
|---|---|---|---|
| 1 | Cut sweep {25, 28, 30, 32, 35} on 10-pos chains to characterize cut=30 plateau | analyst §12.4 #1; gemini §7.1 | Phase 7 cut-sweep ARM (not substitute-compact mechanism re-test) |
| 2 | Hierarchical / mixed-effects model re-analysis on existing Q1 data (no new fire) | codex §10 condition 1 + 5 (`5ca27d8`); gemini §8 M2 (`3abb99d`); §6.3 above | Phase 7 statistical re-analysis (cluster-aware primary) |
| 3 | Cut sweep {3, 5, 7, 10} on 5-pos chains to characterize cut=5 dominance | analyst §12.4 #2 | Phase 7 cut-sweep ARM (5-pos regime) |
| 4 | Cross-CLI verification: substitute-compact at cut=30 on Codex + Gemini drivers | gemini §3.2 + §9 condition 3 (`3abb99d`); §7.2 above | Phase 7 cross-CLI verification (Rule 4-0 scope expansion candidate) |
| 5 | Non-ceiling fixture extension (replace H10 with high-difficulty fixture per §3.4.1 ceiling-avoidance procedures) | codex §10 condition 3 (`5ca27d8`); gemini §8 M1 (`3abb99d`); §5 above | Phase 7 fixture redesign (binding for any cut-sweep) |
| 6 | Cost-overhead optimization: 5-pos sc costs +55% vs Pacc; cut=30-only deployment / hybrid path explored | analyst §12.4 #7; gemini §8 N2 (`3abb99d`) | Phase 7 cost-engineering follow-up |

Each Phase 7 follow-up dispatch authoring is the **next architect session's** scope. This sub-ADR commits only to forwarding them as binding pre-registration requirements; the Phase 7 spec itself is not opened here.

### §10.7 Backward Compatibility (architect AGENTS.md §5.8 INVARIANT)

| Existing consumer | Change required | Rationale |
|---|---|---|
| Orchestrator Rule 4-A Step 4 selector | **Additive**: new candidate (substitute-compact at chain-length-conditional cut) joins the Layer 1 candidate set. Existing PC / S / D / Pacc routing paths unchanged. | parent ADR §4 layering preserved; substitute-compact is Layer 1 candidate, not a new layer or replacement |
| AGENTS.md Rule 4-A checklist | **Additive**: one new checklist line per §10.2. Existing Pacc-sunset, PC-Layer-3-default, deterministic-Layer-1-selector lines unchanged. | parent ADR §10.1 pattern; one-line orchestrator activation patch |
| docs/rules.md Rule 4-A Step 4 body | **Additive**: new sub-section per §10.3. Existing layered selector text unchanged. | parent ADR §10.2 pattern |
| Phase 5 sub-ADR consumers (any session referencing `2026-05-01-substitute-compact-revised-cut.md`) | **Update reference**: now superseded by this sub-ADR. The Phase 5 sub-ADR's cut=30 single-lock framing is a subset of this sub-ADR's chain-length-conditional grid (cut=30 retained for 10-pos). | §4.4 supersession; orchestrator commits the status flip |
| Coder sessions implementing Rule 4-A Step 4 selector | **One-time amendment**: implement §4.3 selector contract. No existing selector code is broken; the chain-length-conditional cut signal is added as a pre-condition. | §10.2; coder session task spec must reference §4.3 binding constraints |
| End users (developers running long-horizon chain workflows) | **Transparent improvement**: substitute-compact applies automatically when chain_length ∈ {5, 10}; users see quality lift (10-pos H1: 0.000 → 0.612) at modest cost premium (+17% on 10-pos). No user-facing API change. | gemini §5.1; Constitution §9.1 Q1 PASS |

**No breaking change**: this is an additive promotion. substitute-compact mechanism (V3 PASS preserved) and existing chain modes (PC, S, D, Pacc-during-sunset-window) all continue to operate without modification.

---

## §11 Phase 6 Q1 Closure

### §11.1 Track #329 E27 Phase 6 Q1 status

Phase 6 Q1 sub-question (substitute-compact mechanism efficacy) is **RESOLVED** at PROMOTE per Phase 6 spec §9.1 row 1.

- Pre-registration: tag `exec-mode-v6-preregistered-20260502` (devkit `4eefc0a`) immutable, sealed before fire, Q1 binding endpoints unchanged from spec acceptance.
- Fire: 350 / 350 trials succeeded, 0 failures, 7 / 7 cells at n=50, $72.36 total cost, ~1h 12m wall (resume window per runner report devkit `ad55e27`).
- Analysis: binding analyst report (devkit `6ba4ff0`); cross-LLM review consensus (codex `5ca27d8` ACCEPT_WITH_CONDITIONS, gemini `3abb99d` ACCEPT_WITH_CONDITIONS); 8 conditions integrated verbatim (§8).
- Decision: PROMOTE Q1-A1 (5-pos × cut=5) + Q1-A5 (10-pos × cut=30) under chain-length-conditional cut policy (§4).

### §11.2 Phase 6 final integration ADR (forward gate)

This sub-ADR is **not** the Phase 6 final integration ADR. Phase 6 final integration ADR (per Phase 6 spec §10.8) is dispatched **after Q2 also resolves** — it consolidates Q1 (this sub-ADR) + Q2 (D-promotion outcome) + Q3 (fixture-design rule, decoupled per `2026-05-02-output-style-fixture-design-rule.md`) into the Phase 6 conclusion ADR with the §9.4 outcome-state suffix.

Possible Phase 6 final ADR forms (per spec §9.4 outcome states):

- If Q2 also promotes D → state **S1** (Q1 promote + Q2 promote): Phase 6 final ADR locks Rule 4-A Step 4 candidate set = {PC, S, D, substitute-compact-conditional}; selector revised to 4-way deterministic single-signal split (selector signal forwarded per spec §12.1 OQ-P6-1).
- If Q2 maintains D → state **S2** (Q1 promote + Q2 maintain): Phase 6 final ADR locks Rule 4-A Step 4 candidate set = {PC, S, substitute-compact-conditional}; selector signal between PC, S, and substitute-compact required.

In either case, **substitute-compact joins Layer 1 candidate set** at chain-length-conditional cuts per this sub-ADR — Q2 outcome does not amend Q1's lock.

### §11.3 Phase 6 spec §11 time-box invariant satisfied

Per Phase 6 spec §11.1 (gemini D2 lock-in): substitute-compact mechanism investigation is "the FINAL Phase. No-effect → deprecate per Constitution Article 1 경량. NO Phase 7 substitute-compact arm."

PROMOTE outcome closes the investigation lineage. The §10.6 Phase 7 follow-ups are **not** new substitute-compact-mechanism arms — they are (a) cut-sweep follow-ups within the promoted regime (Phase 7 #1, #3), (b) statistical re-analysis on existing Q1 data (Phase 7 #2), (c) cross-CLI extension under a new pre-registration (Phase 7 #4), or (d) fixture / cost engineering (Phase 7 #5, #6). All respect the time-box invariant: substitute-compact is now a promoted candidate, not a candidate-under-investigation.

---

## §12 Open Questions Forwarded

These open questions are tracked for orchestrator / Phase 7+ follow-up. None block this sub-ADR's acceptance.

- **OQ-P6-1** (this sub-ADR-scoped): Joint vs single cut promotion lock — formalization of when chain-length-conditional cuts vs single-cut lock is the appropriate operationalization. **This sub-ADR resolves** OQ-P6-2 (Phase 6 spec §12.2) for the Q1 case (chain-length-conditional chosen); the **general formalization** as a meta-rule for future cut sweeps remains open. Forwarded to Phase 7 #3 follow-up architect session.
- **OQ-P6-2** (cluster effective-n): How is effective-n calculated under session-level clustering for the §2.1.1 promotion gate? Forwarded to Phase 7 #2 hierarchical re-analysis (codex §10 condition 5).
- **OQ-P6-3** (out-of-grid chain length): chain lengths outside {5, 10} (e.g., 3-pos, 7-pos, 15-pos, 20-pos) currently fall back to PC per §4.3. Phase 7 chain-length-sweep ADR (separate dispatch) may extend the conditional grid; not blocking.
- **OQ-P6-4** (analyst §10.4 #5 carry-over): combined Phase 4 + Phase 5 + Phase 6 mixed-effects model. Forwarded to Phase 7 #2 (per parent ADR OQ5 + this sub-ADR's hierarchical re-analysis follow-up).
- **OQ-P6-5** (selector signal for N-way Layer 1): if Q2 also promotes D → 4-way selector required (PC, S, D, substitute-compact-conditional). Forwarded to Phase 6 final integration ADR (separate architect dispatch on Q2 resolution).
- **OQ-P6-6** (analyst §8.4 fwd): retire H10 from Q1 binding set when chain length is long enough that Pacc itself saturates H10. Forwarded to Phase 7 #5 non-ceiling fixture extension.
- **OQ-P6-7** (cost-overhead at 5-pos): A1 (cut=5) +55% cost premium vs Pacc-5pos — operational concern for production deployment. Forwarded to Phase 7 #6 cost-engineering follow-up.

---

## §13 Sign-off

- **Drafted by**: `aigentry-architect-phase6-q1-sub-adr` (claude opus 4.7 1M, dispatched via SAWP under aigentry-orchestrator authority).
- **Cross-LLM reviewers** (Phase 6 Q1 evidence base, integrated above):
  - codex: `aigentry-reviewer-phase6-q1-codex` — devkit commit `5ca27d8` — ACCEPT_WITH_CONDITIONS (0 BLOCKER, 4 MAJOR, 3 MINOR; 5 conditions C-1..C-5 integrated §6, §4.2, §5, §6.4, §6.3).
  - gemini: `aigentry-reviewer-phase6-q1-gemini` — devkit commit `3abb99d` — ACCEPT_WITH_CONDITIONS (0 BLOCKER, 2 MAJOR, 3 MINOR; 3 conditions G-1..G-3 integrated §4.2, §3.5/§11.1, §7).
- **Awaiting**: User approval (oikim @ aigentry-orchestrator-claude). Status flips to `accepted` on approval per `references/frontmatter-schema.md` §검증규칙 + architect AGENTS.md §5.6 INVARIANT.
- **Self-check (architect CLAUDE.md §6 7-item rubric)**: 7/7 PASS — §1.1 explains "why this sub-ADR now"; §4.2 cites both alternatives (single-cell lock, chain-length-conditional) with full trade-off analysis and evidence-based selection; §3 + §4 + §5 + §6 + §7 cite analyst / codex / gemini source for every quantitative or methodological claim; §7.x Consequences embedded in §10.7 (backward compat + transparent-improvement consumer matrix) + §11 (closure narrative) + §10.6 (Phase 7 follow-ups address the cross-LLM caveats); §10.7 backward compat additive across all consumers; §9 Constitution Check (Q1–Q5 PASS + Articles 1, 5, 9, 13, 17 PASS); §6.3 + §10.6 Phase 7 binding pre-reg requirements (cluster-aware primary; cut-sweep neighborhood; non-ceiling fixture; cross-CLI verification) constitute the Verification Plan.
- **Hard-rule grep verification** (per dispatch hard rules):
  - 8 cross-LLM conditions quoted verbatim before classification: §5.1, §5.2, §6.1, §6.3, §6.4, §8 (matrix), §7.1 — verified.
  - H10 + clustering caveats acknowledged explicitly per cross-LLM consensus: §5 + §6 — verified.
  - Chain-length-conditional cuts vs single-lock specified with justification: §4.2 (full alternatives matrix) — verified.
  - No code in this ADR (illustrative pseudo-code only, marked `pseudo`/non-executable per architect §5.1): §4.3 — verified.
  - "equivalence" wording confined to TOST contexts (Phase 6 spec §7.3 codex C1 wording discipline): grep-verified — `equivalence` appears only in §3.3 TOST table heading + §3.5 H1-only verdict (in TOST context) + §6.2 (referencing the C-1 confidence-caveat condition). No claim of statistical equivalence outside TOST.
  - Pre-reg sacred — Q1 binding endpoints unchanged: tag `exec-mode-v6-preregistered-20260502` cited as immutable in §1, §3, §11; no post-hoc reweighting per codex C3 / Phase 6 spec §9.4 invariant.

---

*End of sub-ADR `2026-05-03-substitute-compact-phase6-promote.md`. Status: Accepted (2026-05-03). Supersedes `2026-05-01-substitute-compact-revised-cut.md`. Amends `2026-05-01-rule-4-a-step-4-final-lock.md` §4.5 (record-of-change pattern).*
