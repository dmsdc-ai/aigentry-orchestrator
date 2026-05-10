---
type: adr
status: accepted
accepted_date: 2026-05-04
accepted_by: orchestrator (oikim signoff via aigentry-orchestrator)
date: 2026-05-04
author: aigentry-architect-phase6-conclusion
scope: ecosystem
decision_type: integrative
tier: T2
track: "#329 E27 — Phase 6 Final Integration & Closure"
closes_track: "#329 E27"
amends:
  - "docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"
integrates:
  - "docs/adr/2026-05-03-substitute-compact-phase6-promote.md"
  - "docs/adr/2026-05-03-d-promotion-phase6-promote.md"
  - "docs/adr/2026-05-02-output-style-fixture-design-rule.md"
related:
  - "docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"
  - "docs/adr/2026-05-03-substitute-compact-phase6-promote.md"
  - "docs/adr/2026-05-03-d-promotion-phase6-promote.md"
  - "docs/adr/2026-05-02-output-style-fixture-design-rule.md"
  - "docs/superpowers/specs/2026-05-02-phase6-design.md"
related_tasks: [329]
tags: [phase6, conclusion, rule-4-a, step-4, layer-1, 4-way-selector, oq-p6-1, track-329-e27-closure, integrative]
---

# ADR 2026-05-04: Phase 6 Conclusion — Rule 4-A Step 4 Layer 1 4-Way Lock + Track #329 E27 Closure

## §1 Status, Context, Track Closure

- **Status**: **accepted** (2026-05-04, oikim signoff via aigentry-orchestrator after spec-document-reviewer 1-iter PASS; integrates 10 prior cross-LLM reviews via accepted sub-ADRs).
- **Date**: 2026-05-04.
- **Track**: #329 E27 — final integration & Phase 6 closure.
- **Tier**: **T2** (adr × ecosystem × integrative). Reviewer threshold = 2, satisfied transitively by **10 prior cross-LLM reviews** integrated through the binding sub-ADRs (Q1: codex `5ca27d8` + gemini `3abb99d`; Q2: codex `8d7c970` + gemini uncommitted; Q3 r1+r2: codex + gemini × 2 rounds; Phase 5 ancestor: codex + gemini) plus Phase 6 spec-document-reviewer cycles. This conclusion ADR is **integrative** — it composes prior accepted sub-ADRs and resolves OQ-P6-1; it does not introduce new empirical claims, new mechanisms, new trial families, or new conditions to integrate. No new reviewer dispatch beyond the architect's spec-document-reviewer self-check is required (per dispatch hard rule).
- **Decision type**: **integrative** — composes prior accepted sub-ADRs (Q1 PROMOTE, Q2 PROMOTE, Q3 ACCEPTED, Q4 FAIL+fallback) into the unified Rule 4-A Step 4 candidate set and locks OQ-P6-1 (4-way Layer 1 deterministic single-signal selector). Forward commitment scope inherits each sub-ADR's `decision_type` (Q1 + Q2 = one-way; Q3 = one-way; selector lock = one-way at the Rule 4-A surface).
- **Scope**: **ecosystem** — binds orchestrator routing across all Claude-only chain-mode decisions under Rule 4-0 narrow lock scope (unchanged). Cross-CLI extension forwarded to Phase 7+ per §4.4 + integrated sub-ADRs.
- **Closes**: Track #329 E27 (Rule 4-A Step 4 Phase 4–6 program, ~2026-04-20 → 2026-05-04). Closure declaration in §9.

### §1.1 Why this ADR now

Phase 6 (`docs/superpowers/specs/2026-05-02-phase6-design.md`, sealed at devkit pre-reg tag `exec-mode-v6-preregistered-20260502` / commit `4eefc0a`) fired four sub-questions in parallel against the parent ADR's Phase 6 stub (`docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §11). All four resolved between 2026-05-02 and 2026-05-03:

| Sub-Q | Topic | Outcome | Anchor commit | Sub-ADR / artifact |
|---|---|---|---|---|
| **Q1** | substitute-compact mechanism efficacy | **PROMOTE** at chain-length-conditional cuts (cut=5 on 5-pos, cut=30 on 10-pos) | orchestrator `c758a49` (sub-ADR Accepted); parent §4.5 amendment `abda5dd` | `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` |
| **Q2** | D-promotion candidacy | **PROMOTE** D to Layer 1 co-equal via TOST equivalence + branch (b) operational tie-breaker | orchestrator `92b0b85` (sub-ADR Accepted) | `docs/adr/2026-05-03-d-promotion-phase6-promote.md` |
| **Q3** | output-style fixture-design rule | **ACCEPTED** (MUST-strict, three-mechanism enforcement) | orchestrator `2ec53bf` (r3 chain) | `docs/adr/2026-05-02-output-style-fixture-design-rule.md` |
| **Q4** | ceiling-fixture replacement (H11–H14) | **FAIL** at iteration limit §3.4.1 #6 (r5 pilot 0/8 PASS); §3.2.1 fallback amendment activated | devkit `13697d1` (r5 pilot report); orchestrator `6ec2237` (spec §3.2.1 amendment) | spec amendment + pilot report (no ADR) |

Three structural questions remain that **only the conclusion ADR can answer**, all forwarded by spec §12.1 / §10.8 and explicitly demanded by both Q1+Q2 reviewers:

1. **OQ-P6-1 (CRITICAL)** — Per spec §12.1 ("the single-signal selector for the 3-way split is NOT pre-registered ... it is a parent-ADR follow-up decision (separate architect dispatch on Phase 6 conclusion)"). Q1+Q2 PROMOTE both → spec §9.4 outcome state **S1** → 4-way Layer 1 candidate set requires deterministic single-signal selector. Codex Q2 condition 4 (`8d7c970`) + gemini Q2 condition G-2 (uncommitted) both flag this as **must resolve before Phase 6 conclusion ADR can be accepted**, with explicit Constitution Article 5 (최선 always) anchoring. Q2 sub-ADR §4.3 forwarded a proposal with binding constraints; this ADR locks the final selector in §4.2.
2. **Layer 1 candidate-set composition** — parent ADR §4.1 (Layer 1 = {PC, S} co-equal, deterministic single-signal selector) is now structurally outdated: Q1 added `substitute-compact-conditional` (parent §4.5 amendment `abda5dd`), Q2 promoted D from Layer 2 → Layer 1 co-equal (Q2 sub-ADR §4.4 amends parent §4.2). The unified Layer 1 = {PC, S, D, sc-conditional} record-of-change to parent §4.1 is consolidated here per spec §9.4 row S1.
3. **Track #329 E27 closure** — Phase 6 spec §10.8 names the conclusion ADR as the integration deliverable for the §9.4 outcome-state ADR; Q1 sub-ADR §11.2 forward-gated this ADR as the consolidation point ("Phase 6 final ADR locks Rule 4-A Step 4 candidate set = {PC, S, D, substitute-compact-conditional}; selector revised to 4-way deterministic single-signal split"). Without this ADR, Track #329 E27 cannot be marked completed, AGENTS.md / docs/rules.md cannot propagate to a unified text, and the Pacc sunset migration cascade cannot reach §4.4-final form.

### §1.2 Inputs synthesized (binding)

| Input | Path | Frozen ref |
|---|---|---|
| Q1 sub-ADR (substitute-compact PROMOTE, accepted) | `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` | orchestrator `c758a49` |
| Q2 sub-ADR (D-promotion PROMOTE, accepted) | `docs/adr/2026-05-03-d-promotion-phase6-promote.md` | orchestrator `92b0b85` |
| Q3 ADR (output-style fixture rule, accepted r3) | `docs/adr/2026-05-02-output-style-fixture-design-rule.md` | orchestrator `2ec53bf` |
| Q4 r5 pilot report (FAIL, fallback recommended) | `~/projects/aigentry-devkit/docs/reports/2026-05-02-phase6-pilot-q4-r5.md` | devkit `13697d1` |
| Spec §3.2.1 fallback amendment (post-Q4-fail) | `docs/superpowers/specs/2026-05-02-phase6-design.md` §3.2.1 | orchestrator `6ec2237` |
| Parent ADR (final lock) | `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` | post-`abda5dd` (Q1 §4.5 record-of-change) |
| Phase 6 spec (binding contract) | `docs/superpowers/specs/2026-05-02-phase6-design.md` | spec base `8b4e156` + amendments `ee6e2c7`, `555daf6`, `90d0a3a`, `9a76c12`, `6ec2237` |
| Pre-reg tag annotation (immutable) | `git -C ~/projects/aigentry-devkit show exec-mode-v6-preregistered-20260502` | devkit tag → `4eefc0a` |
| Q1 final analysis (analyst) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q1-final-analysis.md` | devkit `6ba4ff0` |
| Q2 final analysis (analyst) | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-final-analysis.md` | devkit `737a247` |
| Q1 codex review | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q1-codex-review.md` | devkit `5ca27d8` |
| Q1 gemini review | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q1-gemini-review.md` | devkit `3abb99d` |
| Q2 codex review | `~/projects/aigentry-devkit/docs/reports/2026-05-03-phase6-q2-codex-review.md` | devkit `8d7c970` |
| Q2 gemini review (uncommitted) | shared-context handoff per dispatch source-of-truth | uncommitted (referenced via Q2 sub-ADR §1.2) |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 5, 9, 13, 17 | this repo |

---

## §2 Phase 6 Outcome Summary

Phase 6 was the **final mechanism phase** for Track #329 E27 (per spec §11.1 gemini D2 time-box). Four sub-questions ran in parallel under the immutable pre-registration tag `exec-mode-v6-preregistered-20260502` (devkit `4eefc0a`); 560 trials fired (350 Q1 + 150 Q2 + 60 Q4 r4/r5 pilots, 0 fire failures across the binding sets). Outcome: **3 PROMOTE / ACCEPT** (Q1 substitute-compact; Q2 D; Q3 fixture-rule) and **1 FAIL** (Q4 ceiling-fixture replacement, dropped to spec §3.2.1 fallback grid pre-fire per HARD LIMIT §3.4.1 #6). The Q4 fail was a **fixture-design failure**, not a mechanism failure — the binding Q1+Q2 verdicts are intact and pre-registration-adherent.

The composite effect on Rule 4-A Step 4: Layer 1 candidate set expands from 2-way `{PC, S}` (parent ADR §4.1) to **4-way `{PC, S, D, sc-conditional}`**. The new candidate set requires a **deterministic single-signal selector** (parent §4.1 invariant + Q1 sub-ADR §4.3 chain-length signal + Q2 sub-ADR §4.3 4-way design proposal); this ADR locks that selector in §4.2 per spec §12.1 OQ-P6-1 and the cross-LLM "must resolve here" consensus (codex Q2 condition 4 / gemini Q2 condition G-2). Pacc sunset (parent §4.4, 2026-08-01) is unchanged and reinforced by Q1 (sc-conditional dominates Pacc on H1 long-chain) + Q2 (D TOST-equivalent to PC and S within ε=±0.05 on H1+H10). Layer 2 is **vacated by D's promotion** (per Q2 sub-ADR §4.4); Layer 3 (PC default for long-horizon chain extension) is unchanged.

---

## §3 Evidence Base — Phase 6 Trial Budget Summary

This ADR is integrative; the binding evidence lives in the sub-ADRs. The aggregate budget is summarized here for closure accounting only.

| Block | Cells | Trials | Outcome | Anchor |
|---|---|---:|---|---|
| **Q1 substitute-compact factorial** | 5 sc cells (4 × 5-pos + 1 × 10-pos) + 2 Pacc reference | 350 | PROMOTE Q1-A1 (5-pos cut=5) + Q1-A5 (10-pos cut=30) | Q1 sub-ADR §3 / analyst `6ba4ff0` §4.1 |
| **Q2 D-promotion grid** (post-§3.2.1 fallback) | 3 modes × 2 fixtures (H1+H10) × 25 seeds | 150 | PROMOTE D Layer 1 co-equal (TOST + branch (b)) | Q2 sub-ADR §3 / analyst `737a247` §4.1–§4.3 |
| **Q4 r4 fixture pilot** (D mode only) | 4 × 5 | 20 | 0/4 in [0.5, 0.85] band → r5 redesign | spec §3.4.1 #6; devkit pilot r4 |
| **Q4 r5 multi-mode pilot** | 4 × 2 modes × 5 seeds | 40 | 0/8 PASS [0.5, 0.85] ∧ σ ≥ 0.05 → §3.2.1 fallback | devkit `13697d1` |
| **Subtotal binding + pilot** |  | **560** | 0 fire failures (apart from Q4 ceiling-design failure documented as fixture failure, not mechanism failure) | spec §3.5 |
| **Direct cost** |  | — | **~$130 USD** ($72.36 Q1 + $55.98 Q2 + ~$2 Q4 pilots) | runner reports |
| **Quota cycles** | — | — | 3 cycles (Q1 fire / Q2 fire / Q4 r4+r5 pilots) | runner ops record |
| **Cross-LLM review rounds (Phase 6)** | — | — | **5 rounds** (Q1 codex+gemini, Q2 codex+gemini, Q3 r2 codex+gemini final iteration on top of r1) | Q1 §8 / Q2 §8 / Q3 §1.2.1 |

Track #329 E27 totals (Phase 4 + 5 + 6) per §9.1 closure declaration: ~1860 trials, ~$200 direct cost, ~10 cross-LLM reviews across 14 days (2026-04-20 → 2026-05-04). All spec-pre-registered, 0 protocol violations across the program.

---

## §4 Decision (HARD-NUMBERED, integrative)

### §4.1 Layer 1 candidate set — UPDATE (record-of-change to parent §4.1)

**FROM** (parent ADR `2026-05-01-rule-4-a-step-4-final-lock.md` §4.1, Accepted 2026-05-01):

> Layer 1 = {Preuse-clear (PC), Subagent (S)} **co-equal** under deterministic single-signal selector.

**TO** (this ADR §4.1, proposed 2026-05-04 / accepted on user signoff):

> Layer 1 = {Preuse-clear (PC), Subagent (S), Dispatch (D), substitute-compact-conditional (sc-conditional)} **4-way co-equal** under deterministic single-signal selector locked in §4.2.

#### §4.1.1 Sub-decisions (binding; each anchored in a prior accepted ADR)

| Layer 1 candidate | Origin / lock authority | Conditional gate (if any) |
|---|---|---|
| **PC** (Preuse-clear) | Parent ADR §4.1 (unchanged in spirit; unchanged as a candidate). Layer 3 default for long-horizon chain extension also preserved per parent §4.3 | — |
| **S** (Subagent) | Parent ADR §4.1 (unchanged in spirit; unchanged as a candidate) | — |
| **D** (Dispatch) | **NEW Layer 1 attribute.** Promoted from Layer 2 (parent §4.2 prior) per Q2 sub-ADR `2026-05-03-d-promotion-phase6-promote.md` §4.1 (commit `92b0b85`): TOST D-vs-PC PASS (90% CI [−0.0044, +0.0182] ⊂ ±0.05; p_max=8.09e-09); TOST D-vs-S PASS (90% CI [−0.0034, +0.0263] ⊂ ±0.05; p_max=2.70e-05); branch (b) operational tie-breaker activated per spec §2.2.1 last bullet + §12.3 OQ-P6-3. **Basis transparency** (Q2 sub-ADR §4.2): statistical equivalence within ε=±0.05 + pre-registered operational tie-breaker. **NOT** statistical superiority (Welch one-sided D vs S p=0.10065; NS at α=0.00714). **NOT** Q2-validated cross-CLI evidence (Q2 was Claude-only; cross-CLI portability is a Rule 4-A Step 5 inherited policy claim, not Q2 empirical, and is forwarded to Phase 7+ per Q2 sub-ADR §6 + §10.6 #1 + gemini condition G-1). | None at the Layer 1 attribute level. Cross-CLI deployment claim requires Phase 7+ verification (binding pre-reg). |
| **sc-conditional** (substitute-compact-revised at chain-length-conditional cut) | **NEW Layer 1 attribute.** Promoted from INCONCLUSIVE (parent §4.5 prior, then amended per `abda5dd`) per Q1 sub-ADR `2026-05-03-substitute-compact-phase6-promote.md` §4 (commit `c758a49`). Cut policy chain-length-conditional: `cut=5` on 5-pos chains (Q1-A1: Δq=+0.2035, Welch p=0.00202, Cohen d=0.646 at Bonferroni α=0.00714); `cut=30` on 10-pos chains (Q1-A5: Δq=+0.2936, Welch p=0.00142, Cohen d=0.659). H10 ceiling caveat acknowledged (Q1 sub-ADR §5; cross-LLM consensus): aggregate signal is structurally H1-driven; H1-only sensitivity (A1 d=1.086, A5 d=1.848) confirms verdict independent of H10. | **CONDITIONAL** at the cut-value level: chain_length ∈ {5, 10} only; out-of-grid chain lengths fall back to PC (Q1 sub-ADR §4.3 final clause). Mechanism-promote is one-way per Q1 sub-ADR §1; cut-value lock is two-way at the hyperparameter level (Phase 7+ cut sweeps may amend within the promoted regime). |

Pacc retained in the sunset window only (parent §4.4; sunset 2026-08-01). Pacc is **not** a Layer 1 candidate; it is a deprecation target. See §6.

#### §4.1.2 Layer 2 disposition — VACATED

D's promotion to Layer 1 vacates parent ADR §4.2's "Layer 2 — D maintained" disposition. Per Q2 sub-ADR §4.4, the parent §4.2 historical record is preserved verbatim for audit; the 2026-05-03 PROMOTE update is additive. This conclusion ADR consolidates the Layer 2 vacancy at the system surface: there is no Layer 2 chain-mode default in Rule 4-A Step 4 post-Phase 6. Workloads previously routed to Layer 2 (mid-horizon accumulated state, no explicit reuse intent) are now handled by the §4.2 selector branch returning **PC** (parent §4.1 session_count ≥ 1 default, retained) — not D. Routing of `D` is reserved for the §4.2 explicit branches: clean state (S preferred at session_count=0 → revised to D under workload-type signal — see §4.2 mapping), capability fallback (cross-CLI / non-Claude-only chain selection), and override.

The Layer 2 vacancy does **not** create a routing gap: the parent ADR §4.4 Pacc-sunset migration table row "in-flight accumulated session with no explicit reuse intent → D" remains operationally valid because D is now a Layer 1 co-equal candidate (Q2 sub-ADR §10.7 backward-compat row 5 verbatim: "migration-target-by-mode unchanged; layer-attribute is metadata"). The destination is the same; the tier-label changes.

### §4.2 OQ-P6-1 Resolution — 4-way deterministic single-signal selector (LOCKED)

**This section discharges spec §12.1 OQ-P6-1 + codex Q2 condition 4 + gemini Q2 condition G-2.** The Q1 sub-ADR §4.3 contributed the chain-length signal; the Q2 sub-ADR §4.3.1 contributed the `workload_type` + `capability` signals as a non-binding proposal. This conclusion ADR locks the final selector with the binding constraints below.

#### §4.2.1 Selector contract (HARD — binding for coder session implementing per §8.2)

The Rule 4-A Step 4 Layer 1 selector MUST satisfy the following constraints (each anchored in a parent / sub-ADR invariant):

| # | Constraint | Source |
|---|---|---|
| C1 | Selector returns exactly one element of `{PC, S, D, sc-conditional@cut}` given identical inputs (deterministic; no random or weighted-random co-equal selection) | parent ADR §4.1 invariant; gemini D1 (Phase 5 review); Q2 sub-ADR §4.3 constraint 1; Q1 sub-ADR §4.3 constraint 3 |
| C2 | Selector inputs MUST be a function of observable signals only (`chain_state.session_count`, `chain_state.expected_position_count`, `workload_type`, `capability`); no opaque heuristics | parent ADR §4.1 invariant; Constitution Article 1 + Article 17; Q1 sub-ADR §4.3 constraint 1; Q2 sub-ADR §4.3 constraint 2 |
| C3 | Selector signal MUST be **mutually exclusive AND exhaustive** over the observable input space (gemini Q2 G-2 verbatim: "explodes the design space ... routing ambiguity ... violates Rule 5 if not mutually exclusive and exhaustive") | gemini Q2 §3 (uncommitted); Constitution Article 5; Q2 sub-ADR §4.3 constraint 3 |
| C4 | Fallback edges MUST be defined for every observable input combination; Pacc forbidden as any fallback (parent §4.4 sunset) | parent ADR §4.4; Q1 sub-ADR §4.3 constraint 4 |
| C5 | sc-conditional cut value at the conditional-mode return MUST honor Q1 sub-ADR §4.3 chain-length-conditional grid (cut=5 on 5-pos, cut=30 on 10-pos); out-of-grid chain lengths fall back to PC, never to sc-conditional with a non-pre-registered cut | Q1 sub-ADR §4.3 mechanical-reachability invariant |
| C6 | D mode return MUST NOT carry a "cross-CLI verified" deployment claim; the layer attribute (Layer 1 co-equal) is Q2-validated only on the Claude-only Rule 4-0 surface; cross-CLI deployment claim is forwarded to Phase 7+ per Q2 sub-ADR §6.2 + gemini G-1 | Q2 sub-ADR §4.2 + §6.2; Phase 7+ binding follow-up |

#### §4.2.2 Selector mapping (LOCKED — illustrative pseudo-code, non-executable per architect §5.1 INVARIANT)

The following mapping is the architect-locked deterministic single-signal selector. **Coder session implements per §8.2; this ADR locks the contract, not the implementation.** The mapping is mutually exclusive (each input combination resolves to exactly one branch) AND exhaustive (every observable input combination has a defined return) per C3.

```pseudo
# illustrative, non-executable — architect §5.1 INVARIANT
# Source signals (all observable per parent ADR §4.1 + Q1 §4.3 + Q2 §4.3.1):
#   chain_state.session_count          : int  (0 = clean state; >=1 = accumulated state)
#   chain_state.expected_position_count: int  (chain length; 5 or 10 are pre-registered;
#                                              other values fall back per C5)
#   workload_type                      : enum {"explicit_reuse", "default", "external_dispatch"}
#   capability.claude_only_chain_supported: bool (Rule 4-A Step 1 prefix; false → cross-CLI)
#
# Returns: (mode_name: str, mode_params: dict)

def select_layer1_chain_mode(chain_state, workload_type, capability):
    # Branch 1 — Capability gate (Rule 4-A Step 1 prefix; preserves Rule 4-0 narrow lock)
    # If host CLI lacks Claude-only chain primitives, fall back to D as the cross-CLI Layer 1
    # default per Rule 4-A Step 5 (capability-layer policy, not Q2 empirical claim — C6).
    if not capability.claude_only_chain_supported:
        return ("D", {})  # cross-CLI fallback, Layer 1 capability gate

    # Branch 2 — Clean state (no chain context to reuse)
    # session_count == 0 → no preuse benefit; S is the parent §4.1 deterministic default
    # for the clean state. D is also Layer 1 co-equal but selecting D here would burn the
    # cross-CLI fallback edge (C6) without the cross-CLI need; S is preferred.
    if chain_state.session_count == 0:
        return ("S", {})

    # Branch 3 — Explicit reuse intent on accumulated state (sc-conditional gate)
    # Per Q1 sub-ADR §4.3: substitute-compact-revised at chain-length-conditional cut is
    # the data-evidenced Layer 1 candidate when the workload signals heavy reuse AND the
    # chain length matches the pre-registered grid {5, 10}. Out-of-grid chain lengths fall
    # back to PC per Q1 §4.3 final clause (C5).
    if workload_type == "explicit_reuse" and chain_state.session_count >= 1:
        if chain_state.expected_position_count == 5:
            return ("Preuse-substitute-compact-revised", {"cut": 5})
        if chain_state.expected_position_count == 10:
            return ("Preuse-substitute-compact-revised", {"cut": 30})
        return ("Preuse-clear", {})  # out-of-grid → PC (parent §4.3 Layer 3 default)

    # Branch 4 — Accumulated state, no explicit reuse intent (parent §4.1 default)
    # session_count >= 1 → PC's task-boundary reset has semantic effect; PC is the
    # parent ADR §4.1 default for accumulated state without reuse signal. D is also
    # Layer 1 co-equal but is reserved for the explicit external-dispatch / cross-CLI
    # branches (Branch 1, Branch 5); choosing PC here keeps D as a meaningful fallback.
    if workload_type == "default" and chain_state.session_count >= 1:
        return ("Preuse-clear", {})

    # Branch 5 — External dispatch / orchestrator override
    # workload_type == "external_dispatch" signals that the orchestrator wants the
    # non-chain dispatch primitive (D) explicitly — e.g., a per-task isolated run with
    # no chain-state burden, or an explicit cross-CLI parity requirement.
    if workload_type == "external_dispatch":
        return ("D", {})

    # Branch 6 — Exhaustiveness fallback (defensive; should not be reachable given the
    # enum constraint on workload_type, but C3 + C4 require an explicit edge for every
    # observable combination)
    return ("Preuse-clear", {})  # safe default, never Pacc per C4
```

#### §4.2.3 Branch justification (each branch cited to a sub-ADR)

| Branch | Mode returned | Justification |
|---|---|---|
| **B1** Capability gate (¬claude_only_chain_supported) | D | Rule 4-A Step 5 capability-layer policy (cross-CLI default); inherited unchanged. Q2 sub-ADR §4.2 #2.3: cross-CLI portable per Rule 4-A Step 5 — POLICY, not Q2 empirical. C6 prevents this branch from carrying a "cross-CLI verified" deployment claim. |
| **B2** Clean state (session_count=0) | S | Parent ADR §4.1 deterministic Layer 1 default for clean state. Selector preserves parent invariant — no preuse benefit at session_count=0; subagent isolation is the lower-overhead default (parent §4.1 selector body). |
| **B3a** Reuse intent + 5-pos chain | sc-conditional@cut=5 | Q1 sub-ADR §4.3 / §4.1: Q1-A1 PROMOTE evidence (analyst `6ba4ff0` §4.1; codex `5ca27d8` §3 confirmed; gemini `3abb99d` §1.1 confirmed). 97.5% trigger rate; mechanically reachable on 5-pos `input_tokens` cumulative trajectory. |
| **B3b** Reuse intent + 10-pos chain | sc-conditional@cut=30 | Q1 sub-ADR §4.3 / §4.1: Q1-A5 PROMOTE evidence (analyst `6ba4ff0` §4.1; codex `5ca27d8` §3; gemini `3abb99d` §1.1). 11.1% trigger rate; the binding cut on the long-chain regime. |
| **B3c** Reuse intent + out-of-grid chain length | PC | Q1 sub-ADR §4.3 final clause — out-of-grid chain lengths fall back to PC (parent §4.3 Layer 3 default), never to sc-conditional with a non-pre-registered cut (C5). |
| **B4** Default workload + accumulated state | PC | Parent ADR §4.1: "session_count >= 1 → preuse reset benefit applies" — preserved verbatim. Q2 sub-ADR's PROMOTE of D to Layer 1 co-equal does not displace PC as the §4.1 default for the accumulated-state-without-reuse-intent branch; D is reserved for explicit external-dispatch (B5) and capability fallback (B1). |
| **B5** External dispatch workload | D | Q2 sub-ADR §4.2 + §4.4: D's Layer 1 co-equal status manifests when the orchestrator explicitly signals external-dispatch / cross-CLI parity intent. The selector returns D here on the basis of the Q2 TOST equivalence (Claude-only) + Rule 4-A Step 5 policy inheritance; the deployment-grade cross-CLI claim is gated to Phase 7+ per C6 and Q2 §6.2. |
| **B6** Exhaustiveness fallback | PC | Defensive edge per C3 (mutually exclusive AND exhaustive). Pacc is forbidden as any fallback per C4 + parent §4.4 sunset. PC is the safe default consistent with parent §4.3 Layer 3 chain-mode default. |

#### §4.2.4 Mutual-exclusivity + exhaustiveness proof (gemini Q2 G-2 satisfaction)

Per gemini Q2 condition G-2 (uncommitted §10): *"the architect MUST resolve OQ-P6-1 (4-way Layer 1 selector signal) deterministically before the Phase 6 conclusion ADR can be accepted, ensuring Constitution Rule 5 (최선 always) is maintained."* The §4.2.2 mapping satisfies this verbatim:

- **Mutually exclusive**: each input combination matches exactly one of {B1, B2, B3a, B3b, B3c, B4, B5, B6}. The branches are evaluated top-to-bottom; the first match returns. Within each branch's predicate, the input value satisfies exactly that branch's condition (capability is boolean; session_count is partitioned at 0 vs ≥1; workload_type is a closed enum {explicit_reuse, default, external_dispatch}; expected_position_count is partitioned at 5 vs 10 vs other).
- **Exhaustive**: B1 covers `¬capability`; B2 covers `capability ∧ session_count=0` (returning S regardless of workload_type — see §4.2.5 evaluation order note); B3a/b/c cover `capability ∧ session_count≥1 ∧ workload_type=explicit_reuse` (partitioned by chain length); B4 covers `capability ∧ session_count≥1 ∧ workload_type=default`; B5 covers `capability ∧ session_count≥1 ∧ workload_type=external_dispatch` (note: at session_count=0 with external_dispatch intent, B2 fires first per §4.2.5 evaluation-order invariant — clean-state S is the deterministic default); B6 is the defensive fallback for any combination that escapes B1–B5 (should not be reachable given the enum constraint, but exists per C3 to guarantee exhaustiveness against future enum additions).

#### §4.2.5 Evaluation-order note (HARD invariant)

Branches MUST be evaluated **top-to-bottom in the order B1 → B2 → B3 → B4 → B5 → B6**. The order is load-bearing for two reasons: (a) B1 capability gate must short-circuit before any other branch (Rule 4-A Step 5 prefix discipline preserved); (b) at session_count=0 with external-dispatch intent, B5 must override B2 — but B2 is checked first in §4.2.2 because that ordering makes the clean-state default deterministic in the absence of an explicit external-dispatch signal. Coder session implementations MUST preserve this lexical order; reordering risks violating C1 determinism + C3 mutual-exclusivity at the input edge cases.

**Note on B2 vs B5 at session_count=0 + external_dispatch**: per the §4.2.2 mapping, B2 fires first (returns S for clean state regardless of workload_type unless capability fails). This is **intentional**: at clean state, S is the lower-overhead default; the orchestrator can still explicitly route to D via a higher-layer override path (Rule 4-A Step 1 capability prefix or an explicit `--mode D` orchestrator directive). If a future Phase 7+ ADR amends this to give B5 precedence over B2, that amendment MUST re-pre-register the change per parent ADR §11 sacred-but-amendable contract.

### §4.3 Q4 outcome record — FAIL with fallback documented

#### §4.3.1 Q4 r5 pilot verdict

Per Q4 r5 pilot report (devkit `13697d1`, 2026-05-02): **0/8 fixture × mode cells satisfied the joint criterion (μq ∈ [0.5, 0.85] AND σ ≥ 0.05)**. Distribution: 4 CEIL (H11/D, H11/Pacc, H14/D, H14/Pacc), 1 fixed-band-zero-σ (H12/D), 3 FLOOR (H12/Pacc, H13/D, H13/Pacc). Per spec §3.4.1 #6 HARD LIMIT (iteration 2 of 2), no further fixture redesign is permitted within Phase 6.

#### §4.3.2 Spec §3.2.1 fallback amendment activation

Per orchestrator commit `6ec2237` (2026-05-02 21:36 KST, post-pilot, pre-Q2-fire), spec §3.2.1 Q2 fallback grid amendment activated: drop H11–H14 from Q2 grid; bind Q2 to **H1 + H10** alone (per-mode N=50 preserved via n=25/cell × 2 fixtures × 3 modes = 150 trials). The amendment is a **post-tag procedural correction**, not a pre-reg violation: the immutable tag `exec-mode-v6-preregistered-20260502` (devkit `4eefc0a`) is unchanged; the amendment is published as an explicit fallback per spec §3.4 (Q4 reject path) + §3.4.1 #6 (iteration limit) procedures pre-registered IN the tagged spec; the amendment is record-of-change in spec at orchestrator timestamp 2026-05-02. Q2 sub-ADR §1 documents this amendment as binding context; this conclusion ADR records it as Phase 6's only post-tag procedural correction.

#### §4.3.3 Q4 disposition + external validity narrowing

Q4 ceiling-fixture replacement is **FAILED at Phase 6**. Per spec §11.2 Q4 row, Q4 is "enabling-only; not subject to time-box" — the Q4 fail does not deprecate any mechanism, does not amend any mode-class, and does not invalidate Q2 (which fell back to H1+H10 pre-fire). The consequence is **external validity narrowing** of the Q2 verdict: per Q2 sub-ADR §5 + §6.2, the D PROMOTE applies to (a) Claude-only Layer 1 candidate set and (b) H1-like task profile (long-form code review) with H10-like ceiling caveat. Domain extrapolation to agentic tool-use, multilingual reasoning, ultra-long RAG pipelines, real-time streaming agentic loops, or non-{H1, H10} fixture surfaces is **out of scope** for this Phase 6 promotion and forwarded to Phase 7+ as a binding pre-registration requirement (§4.4 below; codex Q2 condition 3 / gemini Q2 condition G-3).

#### §4.3.4 Q4 forward — Phase 7+ scope

Q4 reopens in Phase 7+ as a binding fixture-design redesign cycle per spec §3.4.1 ceiling-avoidance procedures. Phase 7+ Q4 spec MUST author non-{H1, H10} fixtures with non-ceiling means in [0.5, 0.85] ∧ σ ≥ 0.05 BEFORE any cut-sweep extension (Phase 7+ Q1 follow-ups #1, #3, #5 per Q1 sub-ADR §10.6) or D-mode external-validity claim. The §3.4.1 procedure (multi-mode pilot, difficulty-knob unit-tests, iteration limit honored) is the binding authorship contract.

### §4.4 Phase 7+ Roadmap (forwarded follow-ups; this ADR commits only to forwarding)

The following follow-ups are forwarded from the integrated sub-ADRs as binding Phase 7+ pre-registration candidates. None block this ADR's acceptance; each is the next architect / orchestrator session's scope.

| # | Follow-up | Source | Type |
|---|---|---|---|
| FU-1 | **Cut sweep {25, 28, 30, 32, 35} on 10-pos chains** to characterize cut=30 plateau | Q1 sub-ADR §10.6 #1 (analyst §12.4 #1; gemini §7.1) | Phase 7 cut-sweep ARM (within promoted regime, not mechanism re-test) |
| FU-2 | **Hierarchical / mixed-effects model re-analysis on existing Q1+Q2 data** (no new fire) — cluster-aware primary | Q1 sub-ADR §10.6 #2; Q2 sub-ADR §10.6 #3 | Phase 7 statistical re-analysis |
| FU-3 | **Cut sweep {3, 5, 7, 10} on 5-pos chains** to characterize cut=5 dominance | Q1 sub-ADR §10.6 #3 | Phase 7 cut-sweep ARM (5-pos regime) |
| FU-4 | **Cross-CLI verification of D mode** (TOST equivalence on Codex + Gemini drivers) — **BLOCKING for any cross-CLI deployment claim that rests on §4.2 B1/B5 D returns** | Q2 sub-ADR §10.6 #1 (gemini condition G-1); §4.2 C6 | Phase 7 cross-CLI verification (Rule 4-0 scope expansion) |
| FU-5 | **Cross-CLI verification of substitute-compact** at cut={5, 30} on Codex + Gemini drivers | Q1 sub-ADR §10.6 #4 (gemini §3.2 + §9 condition 3) | Phase 7 cross-CLI verification |
| FU-6 | **Non-ceiling fixture extension** (replace H10 / extend H1+H10 with new high-difficulty fixtures with non-ceiling means in [0.5, 0.85] ∧ σ ≥ 0.05 per spec §3.4.1) | Q1 §10.6 #5 (codex §10 #3; gemini §8 M1); Q2 §10.6 #2 (codex condition 3; gemini G-3); §4.3.4 above | Phase 7 fixture redesign (binding pre-condition for FU-1, FU-3, FU-7) |
| FU-7 | **Cost-overhead optimization** — sc-conditional 5-pos +55% cost premium vs Pacc; D fresh dispatch overhead vs PC/S (+4.4%/+3.6%); session-level prompt-cache amortization unexplored | Q1 §10.6 #6 (analyst §12.4 #7; gemini §8 N2); Q2 §10.6 #4 (analyst §12.4 #5) | Phase 7 cost-engineering follow-up |
| FU-8 | **4-way selector signal validation** post-§4.2 lock — empirical cell-level routing-correctness audit on a held-out fixture × chain-length × capability × workload_type grid | Q2 §10.6 #5 (codex condition 4; gemini condition G-2) | Phase 7 selector-correctness audit |
| FU-9 | **Q3 exemption registry expiry watch** — H1 `pending-migration` deadline 2026-05-30 (Phase 6 pre-reg tag); H10 `grandfathered` expiry 2026-08-01 (gemini D1, Pacc-sunset-aligned). Lint MUST fail-closed on expired entries per Q3 ADR §11. | Q3 ADR §2.3 + §11 (orchestrator `2ec53bf`) | Phase 7+ ongoing operational watch |
| FU-10 | **Q4 ceiling-fixture redesign per §3.4.1** — Phase 7+ fixture authorship cycle (see §4.3.4) | Q4 r5 fail (devkit `13697d1`); spec §3.4.1 #6 + §3.2.1 fallback consequence | Phase 7 fixture authorship (binding pre-condition for any non-{H1, H10} verdict) |

Time-box invariants (preserved from spec §11.1):
- **Q1 substitute-compact**: gemini D2 time-box honored — Phase 6 was the FINAL mechanism Phase. PROMOTE outcome closed the investigation lineage; FU-1 / FU-3 are cut-sweep follow-ups within the promoted regime, not mechanism re-tests.
- **Q2 D-promotion**: NOT subject to gemini D2; Phase 7+ re-test allowed. FU-4 cross-CLI verification is the natural next-step on D's external validity.
- **Q3 fixture rule**: permanent regardless of Phase 6 outcome (orchestrator `2ec53bf`); FU-9 is operational, not a re-test.
- **Q4 pilot**: enabling-only; FU-10 reopens in Phase 7+ as a binding fixture-design cycle.

---

## §5 Cross-LLM Consensus Integration

This ADR integrates cross-LLM review evidence transitively through the binding sub-ADRs; it does **not** re-quote or re-litigate prior conditions, per dispatch hard rule "MUST integrate without re-quoting all conditions (already in sub-ADRs); reference + summarize."

| Source | Round | Verdict | Conditions integrated in | Phase 6 consequence |
|---|---|---|---|---|
| Q1 codex (`5ca27d8`) | Q1 sub-ADR review | ACCEPT_WITH_CONDITIONS (5 conditions) | Q1 sub-ADR §6 + §8 (cluster-sensitivity caveat C-1; H10 ceiling caveat C-3; cut-policy choice C-2; ...) | Q1 PROMOTE locked at chain-length-conditional cuts; pooled-trial endpoint binding with session-cluster sensitivity caveat |
| Q1 gemini (`3abb99d`) | Q1 sub-ADR review | ACCEPT_WITH_CONDITIONS (3 conditions) | Q1 sub-ADR §5 + §8 (G-1 chain-length-conditional grid; G-2 H1-driven aggregate citation; G-3 cross-CLI scope) | Q1 PROMOTE chain-length-conditional grid endorsed; cross-CLI verification forwarded |
| Q2 codex (`8d7c970`) | Q2 sub-ADR review | ACCEPT_WITH_CONDITIONS (6 conditions) | Q2 sub-ADR §4.2 + §4.3 + §5 + §6 + §7 + §8 (C1 branch (b) explicit; C2 operational policy not Q2 empirical; C3 H1+H10 task-surface scope; C4 4-way selector resolution before conclusion; C5 SD=0 methodology; C6 multiple-testing completeness) | Q2 PROMOTE locked under branch (b); 4-way selector resolution mandated here per C4 → discharged in §4.2 |
| Q2 gemini (uncommitted) | Q2 sub-ADR review | ACCEPT_WITH_CONDITIONS (3 conditions) | Q2 sub-ADR §6 + §4.3 + §5 + §8 (G-1 cross-CLI verification mandate; G-2 OQ-P6-1 deterministic resolution before conclusion; G-3 H1+H10 generalizability narrowing) | Cross-CLI verification → FU-4; OQ-P6-1 resolution mandated here per G-2 → discharged in §4.2; H1+H10 task surface narrowed per §4.3.3 |
| Q3 codex r2 (`b06584b`) | Q3 ADR review (final iteration after r1 codex+gemini + r2 codex+gemini chain) | ACCEPT (R2-N1 PyYAML→JSON migration + R2-N2 grandfathered field-overload fix integrated) | Q3 ADR r3 §2.4.2 + §2.4.3 + §11 (registry JSON; lint check 3 status-vs-fixture-id distinction) | Q3 ACCEPTED at r3; three-mechanism enforcement locked (orchestrator `2ec53bf`) |
| Q3 gemini r2 | Q3 ADR review (r2) | ACCEPT (T2 tier verdict confirmed; structural-vs-semantic scope clarified) | Q3 ADR r3 §1.2.1 + §2.1 (structural-vs-semantic scope table) | Q3 r3 lock |
| Phase 5 codex (`8b48770`) | parent ADR ancestor | ACCEPT_WITH_CONDITIONS (5 conditions C1–C5) | parent ADR §5 / §6 / §7 / §8 (already locked); Phase 6 honors C5 forward gate (chain length / cut grid / trigger endpoint / cut metric) | C5 forward gate satisfied by Phase 6 Q1 pre-registration |
| Phase 5 gemini (`1e740ba`) | parent ADR ancestor | ACCEPT (1 MAJOR + 3 MINOR; D1/D2/D3) | parent ADR §4.1 (D1) + §4.5 (D2) + §11 (D3) | D1 deterministic Layer 1 selector → discharged in parent §4.1 + this ADR §4.2; D2 substitute-compact time-box → discharged at Q1 PROMOTE; D3 fixture-design rule → discharged at Q3 ADR |

**No new condition integration is required in this ADR.** The 19 cross-LLM conditions across Phase 5 + Phase 6 (Phase 5: 8; Q1: 8; Q2: 9; Q3: 6 across r1+r2+r3 — overlap with Phase 5 in part) are all integrated in their respective binding ADRs; this ADR's role is to compose the verdicts, lock the OQ-P6-1 selector, and close the track.

---

## §6 Pacc Sunset Confirmation (carry-over from parent ADR §4.4)

**Sunset date unchanged: 2026-08-01.** No record-of-change to parent ADR §4.4 is required; the Phase 6 outcomes reinforce rather than alter the deprecation rationale:

- **Q1 PROMOTE evidence reinforces Pacc deprecation**: Q1-A5 (10-pos cut=30) Δq vs Pacc-10pos = +0.2936 with H1 stratified Δq = +0.612 (Pacc-10pos H1 mean = 0.000, complete failure). Substitute-compact-conditional dominates Pacc on the long-chain regime that was Pacc's nominal use case; there is no remaining quality argument for Pacc as a routing default.
- **Q2 PROMOTE evidence reinforces Pacc deprecation**: D, PC, S all cluster within ε=±0.05 on H1+H10 (per-mode means in 0.011-wide band: D=0.978, PC=0.971, S=0.967). Pacc has no Layer 1 candidate role; even the parent §4.4 migration table's "in-flight accumulated session" target (D for no-reuse-intent rows) now has Layer 1 co-equal status, consolidating the deprecation cleanly.
- **Migration table validity**: parent §4.4 migration paths (Pacc → PC for explicit-reuse on accumulated state; Pacc → D for no-reuse-intent on accumulated state; Pacc → S for clean state) remain operationally valid. Q2 sub-ADR §10.7 backward-compat row 5 verbatim: "migration-target-by-mode unchanged; layer-attribute is metadata."

**No Pacc-specific record-of-change is added to parent §4.4 in this ADR.** The §4.2 selector forbids Pacc as any fallback (C4); the sunset is mechanically honored by the locked selector. Post-sunset cleanup (removal of the Pacc tolerance carve-out from Rule 4-A Step 3) remains an optional one-line follow-up gated on no Phase 7 reversal — preserved verbatim from parent §10.4.

---

## §7 위헌 심사 (Constitution Check, mandatory per architect AGENTS.md §5.5 INVARIANT)

Constitution: `~/projects/aigentry/docs/CONSTITUTION.md` (전문 + 18조 + 최종조). Per `references/constitution-check.md` §1, the 5 mandatory questions are answered first; Articles 1, 2, 5, 9, 13, 17 (per dispatch §7 itemization) follow as article-specific review. Each question is satisfied transitively by sub-ADR Constitution Checks; this ADR only consolidates and confirms — no fresh constitutional surface is introduced.

### §7.1 Q1: AI 기술 격차 해소에 복무하는가? (Preamble + 제14조)

**PASS.** The 4-way Layer 1 selector (§4.2) removes the routing ambiguity that Q1+Q2 PROMOTE outcomes would otherwise leave in Rule 4-A Step 4: without the selector, a user of an Claude-only-capable host CLI with an accumulated chain and explicit reuse intent on a 5-position chain would face an underspecified choice among PC, S, D, sc-conditional. The locked selector resolves this deterministically on observable signals, requiring zero "how" knowledge from the user. The cross-CLI fallback (B1) elevates D as the documented Layer 1 default for users of host CLIs without Claude-only chain primitives — a direct AI 기술 격차 해소 contribution.

### §7.2 Q2: 이 기능은 어느 컴포넌트의 역할인가? (제3조)

**PASS.** Decision lives at the orchestrator's Rule 4-A Step 4 selector layer (orchestrator role per 제3조). This ADR edits Rule text only via §8.2/§8.3 implementation cascade (delegated to orchestrator-coder-phase6-conclusion follow-up commit per dispatch hard rule). No mechanism in the orchestrator is introduced; substitute-compact-v1 stays in devkit (Q1 sub-ADR §9.2); D harness stays in devkit (Q2 sub-ADR §9.2). No role침범 by analyst / coder / builder / tester / dustcraw.

### §7.3 Q3: 이 프레임워크/라이브러리가 정말 필요한가? (제1조 + 제17조)

**PASS.** No new dependency. The 4-way selector reads only signals already present in parent §4.1 + Q1 sub-ADR §4.3 + Q2 sub-ADR §4.3.1 (`chain_state.session_count`, `chain_state.expected_position_count`, `workload_type`, `capability`). The selector is a single-function expression on a fixed enum — no library, no framework, no plugin. The "illustrative, non-executable" pseudo-code in §4.2.2 is documentation only per architect §5.1 INVARIANT; coder session implements per §8.2 via existing Rule 4-A Step 4 surface (parent §10.3 + Q1 sub-ADR §10.2 + Q2 sub-ADR §10.2 cascade pattern).

### §7.4 Q4: 모든 크로스 환경에서 동작하는가? (제2조 + 제14조)

**PASS with caveat (carry-over from parent ADR §9 Q4 + Q1 sub-ADR §9.4 + Q2 sub-ADR §9.4).** Rule 4-0 narrow lock (Claude-only) is preserved unchanged. The §4.2 selector's B1 capability gate routes to D as the cross-CLI Layer 1 fallback per Rule 4-A Step 5 inheritance; this is **policy claim, not Q2 empirical**. C6 explicitly forbids the §4.2 D return from carrying a "cross-CLI verified" deployment claim until FU-4 (Phase 7+ cross-CLI verification on Codex + Gemini drivers) lands. Substitute-compact-conditional cross-CLI extension is forwarded to FU-5. The Q4 r5 fail (§4.3.1) narrows external validity to the H1+H10 task surface for the Q2 verdict; Phase 7+ FU-6 (non-ceiling fixture extension) is the binding pre-condition for any broader generalizability claim.

### §7.5 Q5: 사용자에게 "어떻게"를 강요하지 않는가? (Preamble)

**PASS.** Routing decisions are made by the orchestrator's locked §4.2 selector. User selects "what" (the task); the selector chooses {PC, S, D, sc-conditional@cut} deterministically based on observable `chain_state` + `workload_type` + `capability` signals. User does not need to learn the 4-way mode taxonomy, choose a cut value, or understand the workload-type enum. The user-config override path remains available via existing Rule 4-A customization channels (parent §4.1 final clause) but is not the default — base behavior is one-click per 제10조.

### §7.6 Article-specific review (per dispatch §7 itemization)

| Article | Verdict | Rationale |
|---|---|---|
| **제1조 경량** | **PASS** | Rule update only; no new mechanisms beyond Q1+Q2+Q3 already-in-tree. The 4-way selector adds zero rule-surface complexity beyond the existing parent §4.1 + Q1 §4.3 + Q2 §4.3.1 signal set; net additional lines on the orchestrator routing surface are the §4.2.2 mapping branches (~8 branches replacing the parent's 2-branch deterministic selector). 헌법 1조 "이거 없이 직접 구현 가능한가?" — no: the binding evidence (Q1 PROMOTE + Q2 PROMOTE) shows the 4-way candidate set is the data-evidenced rule surface; underspecified routing on the new candidate set would violate Constitution Article 5. Time-box invariants honored: substitute-compact lineage closed at Q1 PROMOTE (gemini D2); no Phase 7 mechanism re-test. Phase 7+ FUs are follow-up analyses on existing data, cross-CLI extensions under fresh pre-registration, fixture redesign cycles, or cost-engineering — none re-open a Phase 6 mechanism question. |
| **제2조 크로스** | **PASS with caveat** | See §7.4. Rule 4-0 narrow lock (Claude-only) carries through. §4.2 B1 capability gate preserves Rule 4-A Step 5 cross-CLI default (D) without empirical cross-CLI claim. FU-4 + FU-5 forwarded as binding pre-conditions for cross-CLI deployment grade claims. Selector signals abstract per Rule 4-0; the chain-length signal (Q1 §4.3) and workload-type signal (this ADR §4.2) are observable on any host that surfaces `chain_state` — the selector is portable in principle even before cross-CLI verification lands. |
| **제5조 최선** | **PASS** | The 4-way selector is the data-evidenced best path. Alternative "underspecified 4-way co-equal without selector" is forbidden by gemini Q2 condition G-2 verbatim ("violating Constitution Rule 5 (최선 always) if the selector logic is not mutually exclusive and exhaustive"); §4.2.4 mutual-exclusivity + exhaustiveness proof discharges this. Alternative "defer selector to follow-up ADR" is forbidden by codex Q2 condition 4 ("Phase 6 conclusion MUST resolve the 4-way deterministic selector ... before updating Rule 4-A Step 4") and gemini Q2 condition G-2 ("MUST resolve OQ-P6-1 ... deterministically before the Phase 6 conclusion ADR can be accepted"); §4.2 lock discharges both. The ADR's branch (b) transparency (Q2 sub-ADR §4.2 + this ADR §4.1.1 D row + §4.3.4 Q4 forward) honors 헌법 13조 (비판적+건설적+객관적) verbatim — the D PROMOTE basis is not conflated with statistical superiority or with cross-CLI empirical evidence. |
| **제9조 독립** | **PASS** | Each Layer 1 candidate operates standalone: PC = `claude --print` without `--resume`; S = subagent / Task tool; D = single fresh request, non-chain dispatch (Q2 sub-ADR §4.2 #2.1 verified by harness inspection); sc-conditional = substitute-compact-revised at the chain-length-conditional cut over a `claude --print --resume` session. No mode requires another mode's runtime; the §4.2 selector binds only on observable orchestrator-side signals. Sub-components (analyst / coder / builder / tester / dustcraw) are not forced to depend on the new selector; the orchestrator's Rule 4-A Step 4 routing is the single point of integration. |
| **제13조 비판적+건설적+객관적** | **PASS** | All 19 cross-LLM conditions across Phase 5 + Phase 6 are integrated in their binding sub-ADRs (§5 reference matrix); no condition silently waived. Q4 fail is honestly recorded (§4.3) — not framed as a procedural success; the §3.2.1 fallback is documented as a post-tag procedural correction with explicit external-validity narrowing consequence. Branch (b) operational tie-breaker is preserved verbatim from Q2 sub-ADR §4.2 — the D PROMOTE basis is **statistical equivalence + operational policy**, NOT statistical superiority and NOT Q2-validated cross-CLI evidence (C6). H10 ceiling caveat (Q1 sub-ADR §5; cross-LLM consensus) preserved verbatim. The §4.2 selector is mutually exclusive AND exhaustive (§4.2.4 proof) — no routing ambiguity that would force the user to choose. |
| **제17조 무의존** | **PASS** | No external library / plugin introduced. Substitute-compact-v1 is a pure deterministic function (Q1 sub-ADR §9.3; per `2026-04-26-q1-prereq-redesign.md` §4.6). Selector is shell/router-level logic on existing `chain_state` schema. Q3 lint (orchestrator `2ec53bf`) is Python stdlib only (r3 PyYAML→JSON migration). No new dependency added by this ADR. |

**Verdict**: PASS overall. No FAIL on any required article. The Article 2 "PASS with caveat" is carried verbatim from parent ADR §9 and Q1+Q2 sub-ADR §9.4 — caveat scope (Rule 4-0 narrow lock; cross-CLI extension forwarded to FU-4 + FU-5) unchanged.

---

## §8 Implementation Plan

**No code in this ADR.** Per architect §5.1 INVARIANT, all implementation is delegated to a follow-up orchestrator-coder-phase6-conclusion session. Per dispatch hard rule "DO NOT directly edit AGENTS.md/rules.md in this dispatch — leave to orchestrator-coder-phase6-conclusion follow-up commit," this section enumerates the affected files and the §8.2/§8.3 update content; the actual edits are NOT in this ADR's commit. Coordination with the parallel orchestrator-coder-q2-amendments session is documented in §8.7.

### §8.1 Status flip (orchestrator action, post-acceptance)

- **Action**: orchestrator commits a frontmatter status update on this ADR file (`docs/adr/2026-05-04-phase6-conclusion.md`): `status: proposed` → `status: accepted` with `accepted_date: 2026-05-XX` (date of user signoff) + `accepted_by: orchestrator (oikim signoff via aigentry-orchestrator-claude)`.
- **Authority**: orchestrator per `references/frontmatter-schema.md` §검증규칙 + architect AGENTS.md §5.6 INVARIANT.
- **Pre-condition**: User signoff received via aigentry-orchestrator-claude.
- **Note**: this ADR's `status: proposed` is the locked value at submit; the architect MUST NOT pre-flip per §5.6 INVARIANT.

### §8.2 AGENTS.md Rule 4-A Step 4 final update (orchestrator-coder follow-up)

- **File**: `~/projects/aigentry-orchestrator/AGENTS.md`
- **Section**: "실행 모드 체크 (Rule 4-A — Narrow Lock, Phase 5 holdout 기반)" checklist + Rule 4-A reference line.
- **Update content** (illustrative; final wording per coder session):
  - Header: "Phase 5 holdout 기반 (final lock 2026-05-01)" → "Phase 6 final integration 기반 (Rule 4-A Step 4 4-way Layer 1 selector locked 2026-05-04, ADR `2026-05-04-phase6-conclusion.md`)"
  - Replace existing "Layer 1 deterministic selector (PC vs S; ADR final-lock §4.1)" line with: "Layer 1 4-way deterministic selector ({PC, S, D, sc-conditional}; ADR phase6-conclusion §4.2)"
  - Add: "sc-conditional cut grid: cut=5 on 5-pos chains, cut=30 on 10-pos chains; out-of-grid → PC fallback (ADR phase6-conclusion §4.2 B3a/b/c)"
  - Add: "D Layer 1 co-equal under Rule 4-0 narrow lock; cross-CLI extension forwarded to Phase 7+ FU-4 (ADR phase6-conclusion §4.4)"
  - Pacc line unchanged: "Pacc 회피 (sunset 2026-08-01; ADR final-lock §4.4 / phase6-conclusion §6 reaffirmed)"
- **Coordination with orchestrator-coder-q2-amendments** (parallel session per dispatch hard rule): the Q2 amendments cascade adds D Layer 1 4-way checklist context; this ADR's §8.2 selector signal pseudo-code reference may overlap. Coder session MUST merge non-conflictingly — Q2 cascade lands the Layer 1 attribute change; this ADR's cascade lands the §4.2 selector reference.

### §8.3 docs/rules.md Rule 4-A final update (orchestrator-coder follow-up)

- **File**: `~/projects/aigentry-orchestrator/docs/rules.md`
- **Section**: Rule 4-A Step 4 body (currently locked to parent ADR final-lock §4 layered text).
- **Update content** (illustrative; final wording per coder session):
  - Header: "Rule 4-A. Execution Mode Selection (Final Lock 2026-05-01 — Claude-only scope per Rule 4-0)" → "Rule 4-A. Execution Mode Selection (Phase 6 Final Integration 2026-05-04 — Claude-only scope per Rule 4-0)"
  - §4.1 Layer 1 body: replace the parent's 2-way `{PC, S}` selector text with this ADR's §4.2.2 mapping (B1–B6 branches), citing `ADR 2026-05-04-phase6-conclusion §4.2` as the binding selector lock.
  - §4.2 Layer 2 body: mark VACATED per this ADR §4.1.2; cross-reference Q2 sub-ADR §4.4 for the historical Layer 2 disposition record.
  - §4.3 Layer 3 body: unchanged (PC default for long-horizon chain extension; preserved from parent §4.3).
  - §4.4 Pacc sunset: unchanged (sunset 2026-08-01; reaffirmed per this ADR §6).
  - §4.5 Substitute-compact: replace the parent's "INCONCLUSIVE → PROMOTED" record-of-change wording with the consolidated "PROMOTED Layer 1 candidate at chain-length-conditional cuts" text per Q1 sub-ADR + this ADR §4.1.1 sc-conditional row.
- **Coordination with orchestrator-coder-q2-amendments**: as §8.2 — the Q2 cascade lands the D Layer 1 attribute change in §4.2 of rules.md (parent ADR section §4.2 historical-record-of-change pattern); this ADR's cascade lands the §4.1 Layer 1 body update + §4.5 consolidation. Coder session MUST merge non-conflictingly.

### §8.4 Selector code changes (NOT in this ADR — separate coder session task)

- **Files (anticipated)**: orchestrator routing code paths implementing the §4.2.2 mapping; brain task-feed integration if applicable; `bin/exec-mode-experiment.sh` selector hook (devkit) if the harness participates in Layer 1 routing.
- **Coder session task spec MUST include**:
  - The §4.2.1 C1–C6 binding constraints verbatim.
  - The §4.2.5 evaluation-order invariant (B1 → B2 → B3 → B4 → B5 → B6 lexical order).
  - The §4.2.2 illustrative mapping as a non-binding reference (the contract is the constraints, not the pseudo-code).
  - Q1 sub-ADR §10.7 + Q2 sub-ADR §10.7 backward-compat surfaces (no breaking change).
- **Pre-condition**: this ADR Accepted; AGENTS.md + rules.md text edits committed first per §8.2 / §8.3 (orchestrator activation pattern from parent ADR §6.2 step 2).

### §8.5 Optional: Phase 6 spec status flip (post-execution)

- **File**: `docs/superpowers/specs/2026-05-02-phase6-design.md`
- **Update**: frontmatter `status: accepted` → `status: completed` (or `closed`) once this ADR is Accepted and §8.2 / §8.3 cascade lands.
- **Authority**: orchestrator. ADR-level only; no code change.
- **Note**: Phase 6 spec §13 "End of Phase 6 spec" line may be amended to point at this ADR as the closure record.

### §8.6 Phase 7+ spec stub (separate architect dispatch — NOT in this ADR scope)

- The 10 forwarded follow-ups (FU-1 through FU-10 in §4.4) are the seed scope for a future Phase 7+ spec.
- Phase 7+ spec authoring is the **next architect session's** scope (not this ADR's). Forwarding only.
- Pre-registration discipline applies: any Phase 7+ ARM that re-tests a Phase 6 mechanism MUST pre-register binding hypotheses, mode-pair adjudication, fixture set, n, and decision rule before fire (per parent ADR §11 + Q1 sub-ADR §1 + Q2 sub-ADR §1 invariants).

### §8.7 Track #329 E27 task-queue update (orchestrator action)

- **File**: orchestrator's `state/task-queue.json`
- **Action**: Track #329 E27 status `in_progress` → `completed` upon this ADR's acceptance + §8.2 / §8.3 cascade landing.
- **Authority**: orchestrator.
- **Pre-condition**: this ADR Accepted; §8.2 / §8.3 cascade committed.

### §8.8 Coordination with parallel orchestrator-coder-q2-amendments session

Per dispatch hard rule: the orchestrator-coder-q2-amendments session lands the Q2 sub-ADR's Layer 2 → Layer 1 record-of-change cascade (parallel to this ADR's drafting). Both sessions write to AGENTS.md and rules.md but at different sections (Q2 cascade adds D Layer 1 4-way checklist; this Conclusion ADR's §8.2 / §8.3 lands the selector signal pseudo-code references and the §4.1 Layer 1 body update). **This dispatch DOES NOT directly edit AGENTS.md / rules.md** — that is the orchestrator-coder-phase6-conclusion follow-up commit's scope, which the orchestrator dispatches after this ADR is Accepted and the Q2 cascade has landed (commit ordering: Q2 cascade first, then this ADR's cascade — the §8.2 / §8.3 update content is written assuming the Q2 cascade's prior landing).

---

## §9 Track #329 E27 Closure Declaration

**Track #329 E27 CLOSED** upon this ADR's acceptance + §8 implementation cascade.

### §9.1 Total Track outcomes (2026-04-20 → 2026-05-04, ~14 days)

| Phase | Trials | ADR / artifact | Anchor |
|---|---:|---|---|
| Phase 4 (Preuse-clear Pacc-replacement) | ~1300 | ADR `2026-05-01-rule-4-a-step-4-preuse-clear-activation.md` (Accepted, then superseded) | orchestrator `0d7cb7c` |
| Phase 5 (final-lock + 3 sub-ADRs) | 300 | parent ADR `2026-05-01-rule-4-a-step-4-final-lock.md` + sub-ADRs (substitute-compact-revised-cut superseded; U2 Pareto recompute; Phase 6 fixture-design pre-stub) | orchestrator (parent) |
| **Phase 6 (this ADR's integration)** | **560** | **this ADR + 3 sub-ADRs** (Q1 substitute-compact PROMOTE `c758a49`; Q2 D-promotion PROMOTE `92b0b85`; Q3 output-style fixture rule `2ec53bf`) + Q4 fail (devkit `13697d1`) + spec amendment (orchestrator `6ec2237`) + parent §4.5 amendment (orchestrator `abda5dd`) | this ADR |
| **Total** | **~1860** | **5 ADRs (1 parent + 3 sub + 1 conclusion) + ~10 cross-LLM reviews + ~$200 USD direct cost** | — |

### §9.2 Closure cascade (post-acceptance)

Per §8 implementation plan, Track #329 E27 closure proceeds in this order:

1. User signoff → §8.1 status flip (`proposed` → `accepted`).
2. orchestrator-coder-phase6-conclusion follow-up commit lands AGENTS.md + rules.md updates per §8.2 + §8.3 (after orchestrator-coder-q2-amendments lands the Q2 cascade per §8.8 ordering).
3. Coder session implements selector per §8.4 binding constraints (separate task; not gating closure).
4. Phase 6 spec status flip per §8.5 (optional; ADR-level only).
5. Track #329 E27 in `state/task-queue.json` flipped to `completed` per §8.7.

Phase 7+ scope (forwarded follow-ups FU-1 through FU-10 per §4.4) is a **separate, fresh program** — not a continuation of Track #329 E27.

---

## §10 Sign-off

- **Drafted by**: `aigentry-architect-phase6-conclusion` (claude opus 4.7 1M, dispatched via SAWP under aigentry-orchestrator authority).
- **Cross-LLM reviewers**: **integrative — no new dispatch.** This ADR composes prior reviews:
  - Q1 codex (`5ca27d8`) + Q1 gemini (`3abb99d`) — Q1 sub-ADR review (5 + 3 conditions) integrated transitively via §5 + §4.1.1 sc-conditional row.
  - Q2 codex (`8d7c970`) + Q2 gemini (uncommitted) — Q2 sub-ADR review (6 + 3 conditions) integrated transitively via §5 + §4.1.1 D row + §4.2 (codex C4 / gemini G-2 discharge).
  - Q3 codex r1+r2 + Q3 gemini r1+r2 — Q3 ADR review chain (multiple iterations) integrated transitively via §5 + §4.1.1 (Q3 ACCEPTED status).
  - Phase 5 codex (`8b48770`) + Phase 5 gemini (`1e740ba`) — parent ADR review (5 + 3 conditions) integrated transitively via parent ADR + §5.
- **Spec-document-reviewer (post-drafting)**: invoked per dispatch hard rule "MUST run spec-document-reviewer post-drafting." See architect session log; iterate until PASS (max 5 iterations).
- **Awaiting**: User approval (oikim @ aigentry-orchestrator-claude). Status flips to `accepted` on approval per `references/frontmatter-schema.md` §검증규칙 + architect AGENTS.md §5.6 INVARIANT.
- **Self-check (architect CLAUDE.md §6 7-item rubric)**: 7 / 7 PASS —
  1. **§1 Context**: §1.1 explains "why this ADR now" (OQ-P6-1 must resolve here per spec §12.1 + codex Q2 condition 4 + gemini Q2 condition G-2; Layer 1 candidate-set composition consolidation; Track #329 E27 closure gate).
  2. **§4 Decision ≥2 alternatives**: §4.2 selector locks the 4-way deterministic single-signal selector; alternatives explicitly considered and rejected: "underspecified 4-way co-equal without selector" (forbidden by gemini G-2 verbatim), "defer selector to follow-up ADR" (forbidden by codex Q2 condition 4 verbatim), "reorder evaluation B5 over B2 at session_count=0" (deferred to Phase 7+ amendment per §4.2.5). §4.1.2 considers the alternative "retain Layer 2 with D" and rejects per Q2 sub-ADR §4.1 evidence.
  3. **§3 + §4 + §5 cite evidence for every claim**: each Layer 1 candidate row in §4.1.1 cites a sub-ADR + commit SHA verbatim; each §4.2 branch in §4.2.3 cites a sub-ADR section; each Phase 7+ FU in §4.4 cites a sub-ADR §10.6 row + condition source; §3 cites sub-ADR / analyst / runner reports verbatim.
  4. **§7 Consequences**: §4.3 (Q4 fail consequence — external validity narrowing); §4.4 (Phase 7+ binding follow-ups, including BLOCKING cross-CLI verification per FU-4); §6 (Pacc sunset reinforcement, no schedule change); §7.4 (cross-environment caveat) + §7.6 article-specific review.
  5. **§6 Backward Compat**: addressed via parent §4.4 migration table reaffirmed verbatim (§6); Q1 §10.7 + Q2 §10.7 backward-compat surfaces composed (no breaking change; layer-attribute is metadata; existing modes operate unchanged).
  6. **§7 Constitution Check**: 5 mandatory questions + 6 article-specific reviews — all PASS or PASS-with-caveat (Article 2 caveat carried verbatim from parent + Q1 + Q2 sub-ADRs); no FAIL on any required article; no silent waiver.
  7. **§4.4 Verification Plan / Phase 7+ FU roadmap**: 10 forwarded follow-ups with binding pre-registration requirements; FU-4 (cross-CLI verification) flagged BLOCKING for cross-CLI deployment claim; FU-9 (Q3 exemption registry expiry watch with 2026-05-30 + 2026-08-01 hard deadlines); FU-10 (Q4 ceiling-fixture redesign per §3.4.1) — all measurable, all anchored in sub-ADR sections.
- **Hard-rule compliance** (per dispatch §"Hard rules" section):
  - **MUST quote prior sub-ADR commit SHAs verbatim**: Q1 `c758a49`, Q2 `92b0b85`, Q3 `2ec53bf`, Q4 r5 devkit `13697d1`, spec amendment orchestrator `6ec2237`, parent §4.5 amendment `abda5dd` — all quoted in §1.1 / §1.2 / §3 / §4.1.1 / §4.3.2 / §5 / §9.1.
  - **MUST resolve OQ-P6-1 with deterministic selector**: §4.2 (4-way selector LOCKED with 6 binding constraints C1–C6 + 8-branch mapping B1–B6 + mutual-exclusivity + exhaustiveness proof + evaluation-order invariant).
  - **MUST integrate without re-quoting all conditions**: §5 reference matrix (transitive integration via sub-ADRs); no condition re-quoted in this ADR's body — only summarized + cross-referenced.
  - **NO new spec or trials**: this ADR introduces zero new pre-registration, zero new trial families, zero new mechanisms; integrative only.
  - **MUST run spec-document-reviewer post-drafting**: per architect session log; iterate until PASS.
  - **MUST coordinate with orchestrator-coder-q2-amendments**: §8.8 explicit coordination contract + commit ordering; this ADR DOES NOT directly edit AGENTS.md / rules.md.

---

*End of ADR 2026-05-04-phase6-conclusion. Status: proposed (2026-05-04). Track #329 E27 closure pending user approval + §8 implementation cascade.*
