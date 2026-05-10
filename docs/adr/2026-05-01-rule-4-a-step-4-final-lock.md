---
type: adr
status: accepted
accepted_date: 2026-05-01
accepted_by: orchestrator (oikim signoff via aigentry-orchestrator-claude)
scope: ecosystem
decision_type: two-way
date: 2026-05-01
author: aigentry-architect-rule-4-a-final
tags: [rule-4-a, step-4, exec-mode, chain-mode, preuse-clear, substitute-compact, phase5, holdout]
supersedes: ["docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md"]
related:
  - "docs/adr/2026-05-03-d-promotion-phase6-promote.md"
  - "docs/adr/2026-05-03-substitute-compact-phase6-promote.md"
  - "docs/adr/2026-05-01-substitute-compact-revised-cut.md"
  - "docs/adr/2026-04-22-rule-4-mode-selection.md"
  - "docs/adr/2026-04-26-q1-prereq-redesign.md"
  - "docs/superpowers/specs/2026-05-01-phase5-holdout-design.md"
amended_by:
  - "docs/adr/2026-05-03-substitute-compact-phase6-promote.md"
  - "docs/adr/2026-05-03-d-promotion-phase6-promote.md"
related_tasks: [329]
---

# ADR 2026-05-01: Rule 4-A Step 4 — Final Lock (Phase 4 + Phase 5 Synthesis)

## §1 Status, Context, Supersedes

- **Status**: **Accepted** (2026-05-01, oikim signoff via aigentry-orchestrator-claude).
- **Date**: 2026-05-01.
- **Track**: #329 Track E27 — α-step-14 Final Lock.
- **Supersedes**: `docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md` (Accepted 2026-05-01, r2). The superseded ADR codified Phase 4 evidence + 7 cross-LLM conditions and conditionally activated Preuse-clear; this ADR now consolidates the Phase 5 holdout (300 trials, n=50/mode) into a permanent Step 4 selector lock and supersedes the prior text in full.
- **Related (active)**: `docs/adr/2026-05-01-substitute-compact-revised-cut.md` (sub-ADR, cut=30, Phase 6 implications); `docs/adr/2026-04-22-rule-4-mode-selection.md` (Rule 4-A Narrow Lock origin); `docs/adr/2026-04-26-q1-prereq-redesign.md` (substitute-compact-v1 spec); `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md` (Phase 5 spec, pre-registered decision tree).
- **Predecessor pre-reg tags** (frozen): `exec-mode-v4-replication-preregistered-20260426` (Phase 4 scope, devkit `26f8cc4`); `exec-mode-v5-holdout-preregistered-20260501` (Phase 5 scope, devkit `c8478b4`, grader `207d968`, substitute-compact-v1 `26f8cc4`).
- **Decision type**: two-way (revisable on Phase 6 evidence per §10/§11).
- **Scope**: ecosystem (binds orchestrator routing across all Claude-only chain-mode decisions).
- **Tier**: T2 (adr × ecosystem × two-way per `references/frontmatter-schema.md`). Reviewer threshold = 2 (codex statistical + gemini decision-logic), satisfied by the two Phase 5 reviews integrated in §3 / §8.

### §1.1 Why this ADR now

The superseded ADR (2026-05-01-rule-4-a-step-4-preuse-clear-activation) was Accepted under explicit Phase 5 holdout dependency: §8 "Verification Plan" deferred PC vs S Layer 1 default to Phase 5, and §11 BS2 / BS3 followed up on hierarchical / per-fixture analyses. Phase 5 fired 300 trials on a pre-registered 5-fixture × 6-mode × 10-seed grid, an analyst report (devkit `1e740ba`) was published, and two cross-LLM reviews returned `ACCEPT_WITH_CONDITIONS` (codex C1–C5) and `ACCEPT` with 1 MAJOR + 3 MINOR (gemini D1–D3). Three mechanism findings now require ADR-text consolidation rather than another revision pass:

1. The PC vs S non-separation persisted on holdout under the pre-registered Phase 5 decision rule (Welch p = 0.9414, Cohen d = −0.015 on `quality.primary`; bootstrap CI = [−0.014, +0.013]; tie holds in all 5 leave-one-fixture-out resamples) — the deferred Layer 1 default question can be resolved.
2. The Preuse-clear vs Pacc activation argument generalized at d = +1.41 on disjoint domains (Welch p < 0.0001, CI [+0.343, +0.604]) — Pacc sunset can be confirmed.
3. Substitute-compact@30 received zero live mechanism fires (0/10 chain sessions; cumulative input ceiling = 25 tokens vs cut = 30) — the sub-ADR's hyperparameter remedy must be marked **inconclusive** rather than promoted, demoted, or silently retained.

Holding these unresolved keeps Rule 4-A Step 4 in a transitional state and blocks `docs/rules.md` + `AGENTS.md` text-update propagation. This ADR closes the Step 4 selector for the Phase 5 evidence base, marks substitute-compact INCONCLUSIVE pending Phase 6, and locks Pacc sunset on 2026-08-01.

### §1.2 Inputs synthesized

| Input | Path | Frozen ref |
|---|---|---|
| Phase 5 final analysis (analyst, claude opus 4.7 1M) | `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-final-analysis.md` | devkit `1e740ba` |
| Phase 5 codex review — 5 conditions C1–C5 | `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-codex-review.md` | devkit `8b48770` |
| Phase 5 gemini review — 3 conditions D1–D3 | `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-gemini-review.md` | devkit `1e740ba` |
| Phase 4 U2 Pareto recompute (cascade-a) | `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase4-u2-pareto-recompute.md` | — |
| Phase 5 holdout spec (pre-registered design) | `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md` | this repo |
| Phase 5 pre-reg tag annotation | `git -C ~/projects/aigentry-devkit show exec-mode-v5-holdout-preregistered-20260501 --no-patch` | tag → devkit `c8478b4` |
| Predecessor ADR (now superseded) | `docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md` | this repo |
| Substitute-compact sub-ADR (cut=30) | `docs/adr/2026-05-01-substitute-compact-revised-cut.md` | this repo |
| Rule 4-A origin | `docs/adr/2026-04-22-rule-4-mode-selection.md` | this repo |
| Rule 4-A current text | `docs/rules.md` Rule 4-A | this repo |
| Constitution (위헌 심사) | `~/projects/aigentry/docs/CONSTITUTION.md` Articles 1, 2, 3, 9, 17 | this repo |

---

## §2 Decision Summary

Lock Rule 4-A Step 4 in three positions: (1) for short-horizon chain tasks, route between **Preuse-clear (PC)** and **Subagent (S)** under a **deterministic single-signal selector** (no random co-equal choice) — these two modes did not separate at α = 0.05 on Phase 5 holdout under the pre-registered rule and both strictly dominate Pacc; (2) for accumulated/mid-horizon work, **Dispatch (D)** remains the default per gemini D-promotion=no — the Phase 5 PC=S=D triple-tie that surfaced in 15-pair Bonferroni recompute is exploratory post-hoc and does not bind Layer-2 promotion; (3) for long-horizon chain extension or heavy reuse, **Preuse-clear** is the chain default — the activation argument (PC vs Pacc, Δq = +0.473 on holdout) generalized. **Pacc** is sunset on **2026-08-01** as scheduled. **Substitute-compact@30** is **INCONCLUSIVE** (no live fire) — held in stasis; Phase 6 must pre-register chain length, cut grid, trigger endpoint, and cut metric before any disposition change.

---

## §3 Evidence Base

Total: **1600 trials** = 1300 Phase 4 (800 replication + 500 Preuse) + 300 Phase 5 (6 modes × 5 fixtures × 10 seeds, holdout). Pre-registered under two tags whose annotations are quoted below.

### §3.1 Pre-registration scope (binding)

Phase 4 tag — `exec-mode-v4-replication-preregistered-20260426` (devkit `26f8cc4`, V3 byte-equality digest PASS — prior ADR §3 / `2026-04-26-q1-prereq-redesign.md` §4.6).

Phase 5 tag — `exec-mode-v5-holdout-preregistered-20260501` (devkit `c8478b4`). Verbatim from the tag annotation:

> Total: 5 fixtures × 6 modes × 10 seeds = 300 trials.
> Fixtures (5 holdout, NEW — disjoint from F2..Fa):
>   H1 long-form-code-review (hard); H2 multi-hop-reasoning (medium);
>   H3 multilingual-recall-ko-en (medium); H5 agentic-tool-use (hard);
>   H10 strict-instruction-following (easy).
> Modes (6): D, Pfresh, S, Pacc, Preuse-clear, Preuse-substitute-compact-revised (cut=30).
> Frozen SHAs: driver bin/exec-mode-experiment.sh @ c8478b4; grader bin/exec-mode-grader.py @ 207d968 (cascade-13d, NB1+NB2 fixed, NB3 known-issue per spec §5.4); substitute-compact-v1 impl @ 26f8cc4.

Pre-registration adherence audit: 300/300 metrics.json with `status="ok"`, 50 trials per mode, 60 per fixture, 10 per (mode, fixture) cell, no post-hoc fixture exclusion or mode redefinition (analyst §2 + §9.3; codex §1 confirmed).

### §3.2 Verdicts at a glance

| Source | Verdict | Conditions raised |
|---|---|---|
| Analyst report (devkit `1e740ba`) | Quadrant Q2: PC ≈ S, both hold up. Headline `Recommended Step 4 lock: PC + S co-equal Layer 1`. | 5 open questions in §10.4 (ceiling, cost calibration, F5/Fa, NB3 re-open, mixed-effects). |
| Codex review (devkit `8b48770`) | `ACCEPT_WITH_CONDITIONS`. 0 BLOCKER, 7 MAJOR, 5 MINOR. | C1 wording, C2 spec §6.4–§6.6 either-include-or-waive, C3 binding decisions only on pre-reg comparisons, C4 endpoint discipline, C5 substitute-compact = no live mechanism test. |
| Gemini review (devkit `1e740ba`) | `ACCEPT` with 1 MAJOR + 3 MINOR. All 7 prior-ADR conditions traced. | D1 deterministic Layer-1 routing required, D2 Phase 6 substitute-compact must be time-boxed, D3 output-style exemption rule for future fixtures. |

### §3.3 Pre-registered binding comparisons — endpoint = `quality.primary`

Per codex C3 (binding decisions ONLY on pre-registered PC-vs-S, PC-vs-Pacc, PSC-vs-Pacc) and codex C4 (endpoint discipline; Welch t + Cohen d for `quality.primary`, with hierarchical caveat):

| Comparison | n/n | Δq | Welch t | df | Welch p | Cohen d | Bootstrap 95% CI | Status |
|---|---|---:|---:|---:|---:|---:|---|---|
| **PC − S** | 50/50 | −0.0005 | −0.074 | 97.9 | **0.9414** | −0.015 | [−0.0140, +0.0131] | **No separation at α=0.05.** Tie at α=0.05 under pre-reg rule (Phase 5 spec §6.3). |
| **PC − Pacc** | 50/50 | +0.4729 | 15.6 (recomputed) | ~70 | **<0.0001** (5.59e-9) | +1.407 | [+0.343, +0.604] | **Strict dominance.** Activation argument holds. |
| **PSC-rev − Pacc** | 50/50 | −0.0427 | −0.45 | ~98 | **0.6532** | −0.090 | [−0.225, +0.140] | **No separation** — but PSC mechanism never fired (§3.5); comparison is uninterpretable as a mechanism test. |

Source rows (analyst + codex independently reproduced): analyst §3 / §4.1 / §5 / §6.4; codex §0 reproducibility table; codex §3 binary recompute (Cohen h, OR, Fisher).

**Hierarchical caveat (codex M3)**: trial-level Welch treats observations as IID; trials are nested in fixtures and sessions. Codex's fixture-mean one-sample t-test on PC vs Pacc gives p = 0.0719 (5 fixtures); fixture-cluster bootstrap CI remains positive at ~[+0.135, +0.811]. The PC-vs-Pacc effect direction is robust under hierarchical resampling; magnitude language is conservative below.

### §3.4 PC vs S — robustness

- **Per-fixture decomposition**: H1 Δ=+0.010, H2/H3/H5 Δ=0 (ceiling), H10 Δ=−0.012. Direction split: 1 PC-favored, 3 ties, 1 S-favored. ≥3/5 same-direction criterion (Phase 5 spec §6.3) **fails** — tie persists. (Analyst §4.2; codex §7 reproduced.)
- **Leave-one-fixture-out**: max |Δ| swing = 0.003; Welch p ∈ [0.5964, 0.9392] across 5 drops. **No fixture is load-bearing for the tie verdict.** (Analyst §4.3; codex §7 reproduced.)
- **Pass-rate**: PC 49/50, S 50/50; Δ = −0.020; Fisher exact p = 1.000; Cohen h = −0.284; Haldane OR = 0.33 [0.013, 8.22] (codex §3 binary recompute).

### §3.5 Substitute-compact@30 — no live mechanism fire

| Audit | Value |
|---|---|
| chain_sess{1..10}.json `segment_start_position` | All 10 = 1 |
| Cut=30 trigger rate | **0 / 10 sessions** |
| input_tokens per position (μ, median, max) | 5.0, 5, 5 |
| Per-session cumulative trajectory (5 positions) | [5, 10, 15, 20, 25] |
| Maximum cumulative reached | **25** (vs cut = 30) — 5-token gap |

Source: analyst §6.1–§6.3; codex §4 raw-data confirmation. The sub-ADR's Hypothesis B (cut=30 fires mid-chain at pos 6 of 10) was calibrated against Phase 4's 10-position chains; Phase 5 uses 5-position chains, capping cumulative at 25 below the 30-token cut.

**Per codex C5**: substitute-compact@30 did not receive a live mechanism test in Phase 5; the PSC-vs-Pacc comparison is sample noise on Pacc-clones (PSC behaviorally identical to Pacc with relabeled output paths).

### §3.6 Hold-up criterion

All 5 carry-over modes pass `P5.q ≥ P4.q − 0.05` (Phase 5 spec §6.1 / parent ADR §8.3):

| mode | P4.q | P5.q | Δ | threshold | verdict |
|---|---:|---:|---:|---:|---|
| D | 0.691 | 0.978 | +0.287 | 0.641 | HOLD |
| S | 0.737 | 0.981 | +0.244 | 0.687 | HOLD |
| Pfresh | 0.547 | 0.584 | +0.037 | 0.497 | HOLD |
| Pacc | 0.146 | 0.508 | +0.362 | 0.096 | HOLD |
| Preuse-clear | 0.719 | 0.981 | +0.262 | 0.669 | HOLD |

**Caveat (codex m1, §3.2 analyst)**: the uniform +0.24..+0.36 quality lift (especially Pacc +0.362) suggests a calibration shift between Phase 4 and Phase 5 fixture sets / grader version. Cross-phase absolute-quality comparisons are calibration-sensitive; ranking topology is preserved but absolute deltas should be read as lift-vs-Pacc within the same phase, not cross-phase absolute.

### §3.7 Exploratory post-hoc — must NOT bind decisions (codex C3)

The 15-pair Bonferroni table (analyst §9.2) and the PC=S=D triple-tie (analyst §8.5; codex §5) are **post-hoc exploratory support**, not pre-registered family. The pre-reg tag declared three binding comparisons (PC-vs-S, PC-vs-Pacc, PSC-vs-Pacc); D reclassification is not a Phase 5 binding decision. Decisions in §4 cite only pre-registered comparisons. The triple-tie is documented in §3.7.1 below for completeness but is non-load-bearing.

#### §3.7.1 Triple-tie detail (post-hoc, exploratory)

| Pair | Δq | Welch p | Cohen d | Status |
|---|---:|---:|---:|---|
| D − S | −0.003 | 0.6572 | −0.089 | post-hoc; no pre-reg adjudication |
| D − PC | −0.003 | 0.7012 | −0.077 | post-hoc; no pre-reg adjudication |
| PC − S | −0.0005 | 0.9414 | −0.015 | **pre-registered** binding (§3.3) |

---

## §4 Decision (HARD-NUMBERED — locked text)

Layering note: §4.1 / §4.2 / §4.3 below are **workload-horizon Step 4 sub-layers**, distinct from the capability-based layers of Rule 4-A Step 1 (Claude Code internal vs external) and Step 5 (Layer 1 / Layer 2 D-vs-S tie-break in the original Rule 4-A text). The Step 1 capability gate continues to act as a prefix filter — these sub-layers apply only when Step 1 routes to Claude-only chain selection.

### §4.1 Layer 1 — fresh / short-horizon work — **PC and S co-equal under deterministic routing**

Selector text (final, locked):

> When Rule 4-A Step 4 routes to a chain mode for fresh or short-horizon work (chain_state.session_count ∈ {0, 1}), choose between **Preuse-clear** and **Subagent (S)** by a single deterministic signal. Random or non-deterministic co-equal selection is forbidden (per gemini D1, `2026-05-01-phase5-gemini-review.md:80`). The two modes did not separate at α = 0.05 on Phase 5 holdout under the pre-registered Phase 5 decision rule (Welch p = 0.9414, Cohen d = −0.015, n = 50/50; §3.3).

Routing rule (recommended, **non-binding** suggestion — sub-ADR or coder session may select an alternative deterministic single-signal selector subject to the constraints below):

```pseudo
# illustrative, non-executable — coder session implements per separate task
# CONSTRAINTS (binding):
#   1. selector MUST return exactly one of {"Preuse-clear", "S"} given identical inputs
#      (deterministic; no random or weighted-random co-equal selection — gemini D1)
#   2. selector input MUST be a function of observable chain_state + capability signals,
#      not opaque heuristics (auditable per Rule 4-A checklist)
#   3. fallback edge MUST be S whenever Preuse-clear's preconditions fail
#      (S is the documented hot-failover; Pacc is forbidden per §4.4)
def select_layer1_chain_mode(chain_state, budget):
    if budget.subagent_concurrent_exhausted:
        return "Preuse-clear"            # S unavailable → PC
    if budget.task_tool_unavailable:
        return "Preuse-clear"            # S unavailable → PC
    if chain_state.session_count == 0:
        return "S"                       # clean state; no preuse benefit
    return "Preuse-clear"                # session_count >= 1; preuse reset benefit applies
```

Rationale for the suggested signal: at session_count == 0 there is no prior chain to reuse, so PC's task-boundary reset has no semantic effect; S's subagent isolation is the lower-overhead default. At session_count ≥ 1, accumulated chain state begins to favor PC's explicit reset over S's per-task subagent dispatch (Phase 5 H10 Δ = −0.012 PC-disfavored is the only per-fixture deviation; H1 favors PC at +0.010; 3 fixtures tie at ceiling — the bias-by-state proposal is consistent with the per-fixture pattern but is not statistically separated, so it is a tie-breaker, not an evidence claim — see codex M6 wording discipline §5).

Alternatives explicitly considered and rejected for the Layer-1 selector:
- **Random co-equal**: rejected per gemini D1 (non-deterministic Layer 1 selection violates auditability and creates a single-point-of-failure on subagent budget exhaustion when the orchestrator can't predict which mode a task ran in).
- **PC primary, S secondary auto-failover**: defensible (analyst §10.1 alternative), but penalizes S into a second-class fallback that may not be tuned. The deterministic single-signal selector preserves both modes as first-class while removing routing ambiguity.
- **User-config override**: deferred — adds a "how" knob the user shouldn't need (헌법 제11조 격차 해소). Architect-determined default selector is the constitution-preferred posture; user override remains available via existing rule customization channels but is not the primary routing mechanism.

### §4.2 Layer 2 — accumulated / mid-horizon — **D maintained → D PROMOTED to Layer 1 co-equal (record-of-change 2026-05-03)**

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

> **Authority**: This update is inserted per Q2 sub-ADR `2026-05-03-d-promotion-phase6-promote.md` (commit 92b0b85) §10.4 (additive record-of-change pattern; this ADR's §11 sacred-but-amendable contract preserved). The historical D Layer 2 record (parent ADR §4.2 body) is **preserved verbatim** for audit; it is the 2026-05-01 disposition, now superseded by the 2026-05-03 PROMOTE.

---

**Historical record (2026-05-01 — D maintained Layer 2; superseded 2026-05-03):**

Selector text (historical 2026-05-01; superseded 2026-05-03):

> When Rule 4-A Step 4 routes to mid-horizon work (accumulated state where chain pollution is plausible but heavy reuse is not the goal), keep **Dispatch (D)** as the default — per gemini D-promotion=no (`2026-05-01-phase5-gemini-review.md:37`). The Phase 5 D=PC=S triple-tie (post-hoc, exploratory; §3.7) is **not** a pre-registered binding comparison and does **not** promote D out of its current Layer-2 role.

Rationale (verbatim per dispatch §4.2):
- Phase 5 D=PC=S triple-tie is exploratory post-hoc (codex C3); the binding pre-reg comparisons (PC-vs-S, PC-vs-Pacc, PSC-vs-Pacc) did not promote D.
- D is a non-chain dispatch mode; promoting D to a Layer-1 chain default conflicts with the fundamental Track #329 intent of chain optimization (gemini §3, `2026-05-01-phase5-gemini-review.md:37`).
- Layer-2 status remains conservative.

**Open question for Phase 6** (forwarded to §11/§12): should D be promoted given the Phase 5 holdout-robustness signal? Phase 6 must **pre-register** the test (binding hypothesis, mode-pair adjudication rule, fixture set, n) before re-evaluating. **Resolved 2026-05-03**: Phase 6 Q2 PROMOTE per record-of-change above.

### §4.3 Layer 3 — long horizon / chain extension / heavy reuse — **Pacc → Preuse-clear**

Selector text (final, locked):

> When Rule 4-A Step 4 routes to long-horizon chain extension or heavy session reuse (chain_state.session_count ≥ 2 or explicit reuse intent), the chain-mode default is **Preuse-clear**. Pacc is forbidden as a routing default (Rule 4-A Step 3 carry-over). The activation argument generalized on holdout: PC vs Pacc Δq = +0.473 (Welch p < 0.0001, Cohen d = +1.407, bootstrap 95% CI = [+0.343, +0.604]; n = 50/50; §3.3) — both codex (`2026-05-01-phase5-codex-review.md:257`) and gemini (`2026-05-01-phase5-gemini-review.md:14`) accepted the activation argument as holding on the disjoint holdout fixture set.

This subsumes the parent ADR §2.1 activation; no new mechanism is introduced. Layer-3 is the most explicit chain mode commitment in Rule 4-A Step 4: when the orchestrator has decided that heavy reuse is the workload pattern, PC's task-boundary reset is the documented chain default and is the only chain mode that has cleared a pre-registered binding comparison against Pacc on disjoint holdout fixtures.

### §4.4 Pacc Sunset

- **Sunset date**: **2026-08-01** — preserved verbatim from parent ADR §6.2.
- **Migration table** (consumers of Pacc routing today → post-sunset target):

| Existing Pacc usage | Migration target | Rationale |
|---|---|---|
| In-flight accumulated session (chain_state.session_count ≥ 2) with explicit reuse intent | **Preuse-clear** (Layer 3) | PC vs Pacc Δq = +0.473 on holdout; chain mode default per §4.3 |
| In-flight accumulated session with no explicit reuse intent (transient state) | **D** (Layer 2) | non-chain dispatch; per-task isolation; gemini D-promotion=no preserves Layer-2 role |
| Fresh routing decisions (chain_state.session_count == 0) | **S** (Layer 1, per §4.1 selector) | clean state; no preuse benefit; deterministic Layer-1 default |

- **Communication plan**:
  1. **AGENTS.md note** — orchestrator Rule 4-A checklist updated on Acceptance to remove the Pacc carve-out language and replace with the §4 lock text (one-line rule edit, per parent ADR §6 backward-compat surface).
  2. **Ecosystem broadcast** — orchestrator issues a Rule 3-1 broadcast on Acceptance (analogous to the 2026-04-22 Rule 4-A activation pattern in `2026-04-22-rule-4-mode-selection.md` §8) to all active sessions. Broadcast text: "Rule 4-A Step 4 final-lock effective; Pacc deprecated as routing default; sunset 2026-08-01; new chain routings → PC (Layer 3) or PC/S deterministic (Layer 1) per ADR 2026-05-01-rule-4-a-step-4-final-lock §4."
  3. **In-flight tolerance window** — Pacc tolerated for in-flight sessions (no auto-routing) until 2026-08-01 sunset. New routings default per §4 immediately on Acceptance.

### §4.5 Substitute-compact Status — INCONCLUSIVE → PROMOTED (record-of-change 2026-05-03)

> **§4.5 Status update 2026-05-03 (per ADR `2026-05-03-substitute-compact-phase6-promote.md`)**
>
> Disposition: INCONCLUSIVE → **PROMOTED** with chain-length-conditional cut policy.
>
> - Mechanism: substitute-compact-v1 (`docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6) byte-equality V3 PASS preserved; implementation unchanged.
> - Cut policy: cut=5 on 5-pos chains, cut=30 on 10-pos chains (Phase 6 Q1 binding evidence; analyst `6ba4ff0`; codex `5ca27d8`; gemini `3abb99d`).
> - Rule 4-A Step 4 candidate set: extended to include substitute-compact-revised at the conditional cuts; selector amendment per `2026-05-03-substitute-compact-phase6-promote.md` §4.3.
> - Phase 6 pre-registration requirements (parent ADR §11) all satisfied: chain length {5, 10}, cut grid {5, 10, 15, 20, 30}, trigger endpoint primary `segment_start_position > 1`, cut metric `input_tokens`.
> - Time-box (gemini D2): respected — Phase 6 was the final mechanism Phase; PROMOTE outcome closes the investigation lineage.

> **Authority**: This update is inserted per Q1 sub-ADR `2026-05-03-substitute-compact-phase6-promote.md` (commit c758a49) §10.5 (additive record-of-change pattern; this ADR's §11 sacred-but-amendable contract preserved). The historical INCONCLUSIVE record below is **preserved verbatim** for audit; it is the 2026-05-01 disposition, now superseded by the 2026-05-03 PROMOTE.

---

**Historical record (2026-05-01 — INCONCLUSIVE; superseded 2026-05-03):**

Per codex C5 (`2026-05-01-phase5-codex-review.md:250`): substitute-compact@30 did **not** receive a live mechanism test (cut=30 unreachable in 5-position Phase 5 chains; trigger rate 0/10; §3.5).

**Disposition** (historical): **INCONCLUSIVE** — held in stasis. Not deprecated, not promoted.

- **Mechanism**: substitute-compact-v1 (`docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6) byte-equality V3 PASS (devkit `26f8cc4`) preserved; implementation remains in-tree.
- **Sub-ADR text** (`docs/adr/2026-05-01-substitute-compact-revised-cut.md`): cut=30 disposition reclassified from "Phase 5 hyperparameter sanity test" to "untested at Phase 5 chain length"; sub-ADR is **not** superseded by this ADR (Phase 6 will supersede if mechanism is conclusively tested), but its §5 Phase 5 inclusion contract is now formally **non-applicable** to the Phase 5 dataset — the table mapping `Δq vs Pacc` to actions presupposes a mechanism fire that did not occur.
- **Forward gate**: any future ADR that proposes promoting, deprecating, or removing substitute-compact must first satisfy the Phase 6 pre-registration requirements in §11.
- **Phase 6 ADR (separate; not opened here)** must pre-register: (i) chain length; (ii) cut grid; (iii) trigger endpoint; (iv) cut metric (`input_tokens` vs `cache_read_tokens` vs alternative). Time-boxing per gemini D2 — see §11.

---

## §5 Wording Discipline (codex C1 compliance)

Per codex C1 (`2026-05-01-phase5-codex-review.md:242`):

- **Required phrasings** — used throughout this ADR:
  - "no separation at α = 0.05"
  - "did not differ at α = 0.05"
  - "tie at α = 0.05" (paired with explicit reference to the pre-registered Phase 5 decision rule, Phase 5 spec §6.3)
- **Forbidden phrasings** — none of the following appear anywhere in this ADR (verified by grep, see §13 sign-off): `equivalence`, `equivalent`, `indistinguishable`, `proven equal`. None of these terms is supported by the Phase 5 evidence base because no equivalence margin was pre-registered and no TOST was reported (codex M6, §3 wording rationale).
- **Post-hoc TOST result** (codex §3, informational only): for PC vs S `quality.primary`, a post-hoc TOST passes for ±0.02 (max p = 0.0030) and ±0.05 (max p = 8.9e-11) margins, but not for ±0.01 (max p = 0.0875). This ADR does **not** convert the post-hoc TOST into a lock-claim because the equivalence margin was not pre-registered (Constitution Article 13 객관적 — pre-registration sacred).

PC=S=D in §3.7 is labeled exploratory post-hoc; it is **not** described as equivalence anywhere in this ADR.

---

## §6 Endpoint Discipline (codex C4 compliance)

Per codex C4 (`2026-05-01-phase5-codex-review.md:248`): each binding comparison's primary endpoint is named explicitly, and the test family matches the endpoint type.

| Binding comparison | Primary endpoint | Test | Effect size | Cite |
|---|---|---|---|---|
| PC vs S | `quality.primary` (continuous, bounded [0,1]) | Welch's t (with hierarchical caveat per codex M3) | Cohen d, with bootstrap 95% CI on Δ | analyst §4.1; codex §0 reproducibility row 1; codex §3 binary recompute (Cohen h, Fisher) reported alongside |
| PC vs Pacc | `quality.primary` | Welch's t (with hierarchical caveat) | Cohen d; fixture-cluster bootstrap CI | analyst §5; codex §0 row 4; codex §2 fixture-mean t and cluster-bootstrap |
| PSC-rev vs Pacc | `quality.primary` (uninterpretable as mechanism test — §3.5) | Welch's t (descriptive only) | Cohen d (descriptive only) | analyst §6.4; codex §4 |

If any future revision (Phase 6 or later) switches the primary endpoint to `primary_pass` (binary), it MUST report risk difference + Cohen h or odds ratio + Fisher exact. Codex §3 binary recompute table (PC 49/50 vs S 50/50; PC 49/50 vs Pacc 22/50; PSC 19/50 vs Pacc 22/50) is included in the analyst report and may be cited; this ADR's binding decisions remain on `quality.primary`.

**Cross-section to analyst report**: tables cited by section number in §3.3 / §3.5 / §3.6. Every quantitative claim in §3 / §4 carries a cite to the analyst, codex, or gemini source.

---

## §7 Advanced Analyses (codex C2)

Per codex C2 (`2026-05-01-phase5-codex-review.md:244`): final ADR MUST either include the Phase 5 spec §6.4 mixed-effects model, §6.5 per-fixture Pareto breakdown, and §6.6 difficulty-outlier flags, or explicitly waive them as non-gating informational analyses with rationale.

**Disposition**: **explicit waiver (option b)**.

Rationale (per codex §1 M1 and Phase 5 spec §6.4–§6.6 marking these as informational, not hard gates):

1. **§6.4 mixed-effects model on combined Phase 4 + Phase 5 dataset** — informational; addresses gemini BS2 IID-violation flag from prior ADR. The PC-vs-Pacc fixture-mean one-sample t and fixture-cluster bootstrap (codex §2 M3) already test the hierarchical robustness of the activation argument and confirm direction at conservative wording. The mixed-effects model is a Phase 6 candidate that does not change the Step 4 lock direction.
2. **§6.5 per-fixture Pareto breakdown** — informational; tests gemini's prior P7 hypothesis ("S dominates reasoning, PC dominates retrieval"). Per-fixture decomposition (analyst §4.2) shows 3/5 fixtures at ceiling; the per-fixture Pareto is dominated by ceiling effects and is unlikely to surface mode-asymmetry on this dataset. Phase 6 candidate.
3. **§6.6 difficulty-outlier flags** — informational; codex §7 noted D-mode q ≥ 0.95 on H2/H3/H5/H10 meets the spec's "difficulty outlier" threshold but does not disqualify the fixtures. The ceiling-effect risk is addressed in §3.4 robustness language and §10.4 / §11 forward planning.

Forwarded as Phase 6 candidates, not gating for this ADR. Recorded in §11 / §12.

---

## §8 Conditions Integration Matrix

Each of the 8 cross-LLM conditions (codex C1–C5 + gemini D1–D3) is mapped to ADR sections that satisfy it. Verbatim citations to source line/section.

| # | Source | Condition | Verbatim quote (truncated) | Satisfied in |
|---|---|---|---|---|
| C1 | codex `2026-05-01-phase5-codex-review.md:242` | Wording discipline: "no separation" not "equivalence" without TOST + margin | "Final ADR MUST phrase PC≈S and PC=S=D as 'no separation under the pre-registered Phase 5 rule'; it MUST NOT claim statistical equivalence unless it declares an equivalence margin and reports TOST or an equivalent CI criterion." | §5 (verified by grep); §3.3 / §3.4 / §3.7 / §4.1 / §4.2 wording |
| C2 | codex `…codex-review.md:244` | Either include §6.4/§6.5/§6.6 advanced analyses OR explicit waiver with rationale | "Final ADR MUST either include the Phase 5 spec §6.4 mixed-effects model, §6.5 per-fixture Pareto breakdown, and §6.6 difficulty-outlier flags, or explicitly waive them as non-gating informational analyses with rationale." | §7 (explicit waiver, option b, rationale provided) |
| C3 | codex `…codex-review.md:246` | Bind decisions ONLY on pre-registered comparisons; treat 15-pair Bonferroni / triple-tie as exploratory | "Final ADR MUST treat the 15-pair Bonferroni table and PC=S=D triple-tie as exploratory post-hoc support; binding decisions should rely only on the pre-registered PC-vs-S, PC-vs-Pacc, and PSC-vs-Pacc decision comparisons." | §3.3 (binding table); §3.7 (post-hoc disclaimer); §4.2 rationale (D not promoted); decisions in §4 cite only pre-reg comparisons |
| C4 | codex `…codex-review.md:248` | Endpoint discipline (name the primary endpoint per binding comparison; methods match endpoint type) | "Final ADR MUST name the primary endpoint consistently. If using `quality.primary`, Cohen d/Welch may be reported with hierarchy caveats; if using `primary_pass` or 'grader accuracy', report risk difference plus Cohen h or odds ratio/Fisher exact results." | §6 (endpoint table); §3.3 (Welch + Cohen d for `quality.primary` with hierarchical caveat) |
| C5 | codex `…codex-review.md:250` | Substitute-compact@30 = no live mechanism test; Phase 6 must pre-register chain length + cut grid + trigger endpoint + cut metric | "Final ADR MUST state that substitute-compact@30 did not receive a live mechanism test because cut=30 was unreachable in the 5-position Phase 5 chains; Phase 6 must pre-register chain length, cut grid, trigger endpoint, and cut metric before drawing mechanism-efficacy conclusions." | §3.5 (no live fire); §4.5 (INCONCLUSIVE disposition); §11 (Phase 6 pre-reg stub) |
| D1 | gemini `2026-05-01-phase5-gemini-review.md:80` | Deterministic single-signal Layer-1 routing (no random co-equal) | "Rule 4-A Step 4 must explicitly codify the deterministic routing logic between PC and S (i.e., PC primary for chains, S auto-failover on budget exhaustion) to prevent non-deterministic Layer 1 selection." | §4.1 (deterministic single-signal selector with constraints + illustrative pseudo-code) |
| D2 | gemini `…gemini-review.md:81` | Phase 6 substitute-compact sweep must be time-boxed; if cut ≤ 5 / cut=30@10pos fails, deprecate | "The Phase 6 hyperparameter sweep for substitute-compact must be time-boxed as the final attempt. If cut ≤ 5 or cut=30 at 10-pos fails to show a Pareto-relevant separation, the mechanism must be deprecated to respect Constitution Article 1 (경량)." | §4.5 (Phase 6 forward gate); §11 (time-boxed Phase 6 stub) |
| D3 | gemini `…gemini-review.md:82` | Output-style formatting exemption standard for future fixture design | "Establish an 'output-style formatting exemption' standard for future fixture design to avoid the NB3-style over-correction loops encountered in Phase 5." | §11 (Phase 6 spec stub — fixture-design rule); §12 (forwarded as open question) |

All 8 conditions integrated. Coverage: 8/8.

---

## §9 위헌 심사 (Constitution Check, mandatory per AGENTS.md §5.5 INVARIANT)

Constitution: `~/projects/aigentry/docs/CONSTITUTION.md`. Per dispatch §3.9, Articles 1, 2, 3, 9, 17 are required for review. The 5 standard `references/constitution-check.md` Q1–Q5 are answered first; Articles 1/2/3/9/17 follow.

### Q1: AI 기술 격차 해소에 복무하는가? (Preamble + 제11조)

**PASS.** The deterministic Layer-1 selector (§4.1) removes a "how" decision the user shouldn't have to make ("which chain mode runs my task?"). The selector is auditable (chain_state.session_count + budget signals are observable) so the user can reason about routing without learning the mode taxonomy. The Pacc sunset (§4.4) eliminates a known-low-quality default that would otherwise leak into routing decisions made by less-experienced users.

### Q2: 이 기능은 어느 컴포넌트의 역할인가? (제3조)

**PASS.** Rule 4-A Step 4 is the orchestrator's routing rule (orchestrator role per 제3조 — 지휘/위임/세션 간 조율). This ADR edits Rule text only; it does not introduce mechanism in the orchestrator (substitute-compact-v1 stays in the devkit; PC/S/D/Pacc are existing modes). No role침범.

### Q3: 이 프레임워크/라이브러리가 정말 필요한가? (제1조 + 제17조)

**PASS.** No new dependency. PC, S, D, Pacc are all existing Rule 4-A modes. The deterministic Layer-1 selector is a single-function expression on chain_state + budget — no library, no framework. The "illustrative, non-executable" pseudo-code in §4.1 is for documentation only; coder session implements per existing Rule 4-A Step 4 surface.

### Q4: 모든 크로스 환경에서 동작하는가? (제2조 + 제14조)

**PASS with caveat (carry-over from parent ADR §7 Rule 2 caveat).** Rule 4-0 Narrow Lock scope is preserved (Claude-only). Layer-3 PC mode is implemented via session-boundary `--print` (no `--resume`) — portable in principle but **untested on Codex/Gemini drivers**. Layer-2 D continues to default for cross-CLI / CI/CD per Rule 4-A Step 5 (capability layer, unchanged). Promotion of PC to capability-Layer 2 (cross-CLI) is **out of scope** and remains a separate future ADR.

### Q5: 사용자에게 "어떻게"를 강요하지 않는가? (Preamble)

**PASS.** Routing decisions are made by the orchestrator. User selects "what" (the task) and the deterministic selector chooses the chain mode. The user-config override path is left available for power users via existing Rule 4-A customization but is not the default — base behavior is one-click per 제10조.

### §9.1 Article-specific review (per dispatch §3.9)

| Article | Verdict | Rationale |
|---|---|---|
| **제1조 경량** | **PASS** | No new mechanism; the routing add is a single observable-input function. The deterministic selector replaces an underspecified "co-equal" stance — net complexity reduction on the rule surface. The Pacc sunset (§4.4) is a one-line deletion from the default set. The substitute-compact INCONCLUSIVE disposition (§4.5) explicitly avoids re-running 400 dead-arm trials by leaving the mechanism in stasis pending Phase 6 pre-reg — Constitution-aligned with "이거 없이 직접 구현 가능한가?" before opening a sweep. |
| **제2조 크로스** | **PASS with caveat** | See Q4. Rule 4-0 scope (Claude-only) carries through unchanged; Layer-2 D continues to default outside Rule 4-0 scope. PC cross-CLI portability is untested and is a separate ADR. |
| **제3조 역할** | **PASS** | Decision lives in the orchestrator's selector (Rule 4-A Step 4). No analyst / coder / builder / tester / dustcraw role침범. Substitute-compact mechanism stays in devkit per §4.5. |
| **제9조 독립** | **PASS** | Each mode operates standalone: PC = `claude --print` without `--resume`; S = subagent / Task tool; D = per-task dispatch; Pacc = legacy chain (sunset). No mode requires another mode's runtime; the selector binds only on chain_state + budget signals available to the orchestrator. Sub-components (analyst / coder / builder) are not forced to depend on the new selector. |
| **제17조 무의존** | **PASS** | No external library / plugin introduced. Substitute-compact-v1 is a pure deterministic function (per `2026-04-26-q1-prereq-redesign.md` §4.6). Selector is shell/router-level logic. |

**Verdict**: PASS overall. No FAIL on any required article. The Article 2 "PASS with caveat" is carried verbatim from the parent ADR §7 — caveat scope unchanged.

---

## §10 Implementation Plan

**No code in this ADR.** Per architect §5.1 INVARIANT, all implementation is delegated to coder sessions / orchestrator activation broadcast. Affected files listed for handoff:

### §10.1 AGENTS.md Rule 4-A Step 4 update (orchestrator session)

- File: `~/projects/aigentry-orchestrator/AGENTS.md`
- Section: "실행 모드 체크 (Rule 4-A — Narrow Lock, Phase 3 데이터 기반)" checklist + Rule 4-A reference line.
- Diff (one-line orchestrator activation patch — illustrative):
  - "Phase 3 데이터 기반" → "Phase 5 holdout 기반 (final lock 2026-05-01)"
  - Pacc 관련 체크리스트 항목: "Pacc 회피" → "Pacc 회피 (sunset 2026-08-01; ADR final-lock §4.4)"
  - "Preuse Phase 4 lock" → "Preuse Layer 3 default (ADR final-lock §4.3)"
  - Add new line: "Layer 1 deterministic selector (PC vs S; ADR final-lock §4.1)"

### §10.2 docs/rules.md Rule 4-A update (orchestrator session)

- File: `~/projects/aigentry-orchestrator/docs/rules.md`
- Section: Rule 4-A Step 4 (currently lines ~63–66 of the Rule 4-A body).
- Diff:
  - Replace current Step 4 body (which references "Phase 4 LOCK 후 활성화") with the §4 locked text from this ADR (§4.1 selector + §4.2 D maintained + §4.3 Layer 3 PC default + §4.4 Pacc sunset table + §4.5 substitute-compact INCONCLUSIVE).
  - Update header: "Rule 4-A. Execution Mode Selection (Narrow Lock)" → "Rule 4-A. Execution Mode Selection (Final Lock 2026-05-01 — Claude-only scope per Rule 4-0)".

### §10.3 Selector code changes (NOT in this ADR — separate task to coder session)

- Files (anticipated): `bin/exec-mode-experiment.sh` selector hook, orchestrator routing code paths, brain task-feed integration if applicable.
- Coder session task spec must include: (i) the §4.1 constraints (deterministic, single-signal, observable inputs, fallback edge); (ii) the §4.4 migration table; (iii) the §4.5 substitute-compact INCONCLUSIVE handling (no auto-routing; mechanism stays in-tree but not surfaced as a default).
- Pre-condition: this ADR Accepted; AGENTS.md + rules.md text edits committed first per §10.1 / §10.2 (orchestrator activation pattern from parent ADR §6.2 step 2).

### §10.4 Pacc sunset timeline + migration doc

- Sunset date: 2026-08-01 per §4.4.
- Communication broadcast on Acceptance per §4.4 step 2 (orchestrator action).
- Pacc tolerance window: 2026-05-01 (Acceptance) → 2026-08-01 (sunset) — in-flight sessions drain on Pacc; new routings default per §4 immediately.
- Post-sunset cleanup ADR: optional one-line follow-up to remove the Pacc tolerance carve-out from Rule 4-A Step 3, gated on no Phase 6 reversal.

### §10.5 Phase 6 spec stub (separate architect session task)

- New spec: `docs/superpowers/specs/2026-XX-phase6-design.md` (date TBD).
- Scope per §11: substitute-compact mechanism investigation + D promotion test + (optional) output-style fixture rule + (optional) ceiling-fixture replacement.
- Pre-registration required before Phase 6 fires; binding hypotheses listed in §11.

---

## §11 Phase 6 Pre-registration Stub (≤ 300 words)

Phase 6 is **not opened by this ADR**. This stub records the architect-determined scope so a future Phase 6 spec session has a starting point. Time-boxed per gemini D2.

**Goal**: resolve the three carry-over questions left INCONCLUSIVE or non-binding by Phase 5: (a) substitute-compact mechanism efficacy at runtime; (b) D promotion candidacy on a binding pre-reg; (c) fixture-design rule for output-style asymmetry.

**Scope (binding pre-reg requirements)**:

1. **Substitute-compact mechanism investigation** (per codex C5 + gemini D2):
   - **Chain length**: pre-register 5-position vs 10-position chains (or both) — required because cut value × chain length × per-position input_tokens determines fire position.
   - **Cut grid**: pre-register the cut values to test (architect-recommended starting grid: {5, 10, 15, 20} on 5-position chains; or {30} on 10-position chains restoring the sub-ADR Hypothesis B context). Final grid sub-ADR-specific.
   - **Trigger endpoint**: pre-register what counts as "fired" (segment_start_position > 1 vs cumulative-token threshold crossing).
   - **Cut metric**: pre-register `input_tokens` (uncached delta, current spec) vs `cache_read_tokens` (transcript-volume proxy) vs alternative.
   - **Time-box**: this is the **final** Phase for substitute-compact per gemini D2. If no cut value at any chain length yields a Pareto-relevant separation (Δq ≥ +0.10 at p < 0.05 and d ≥ 0.5 vs Pacc), substitute-compact is deprecated (Rule 4-A Step 4 candidate set removal) per Constitution 제1조 경량.

2. **D promotion test** (per §4.2 open question):
   - Pre-register a binding D-vs-PC and D-vs-S adjudication on a fixture set chosen for non-ceiling spread (D-mode P5 q < 0.95 on at least 3/5 fixtures per analyst §10.4).
   - Decision rule pre-registered before fire.

3. **Output-style asymmetry** (per gemini D3 + analyst §10.4 NB3 re-open trigger):
   - If any future H5-class fixture is reused, NB3 grader patch must land before re-use.
   - General fixture-design rule: graders for structurally-identical data (e.g., JSON in raw text vs in markdown block) MUST implement formatting-exemption logic.

4. **Optional**: ceiling-fixture replacement (analyst §10.4 #1) — fixtures where Phase 5 modes scored q < 0.9 to maximize PC vs S separation power for the post-hoc TOST margin question.

---

## §12 Open Questions Forwarded

Open questions not addressed by this ADR (tracked for orchestrator/Phase 6 follow-up):

- **OQ1** (analyst §10.4 #1): ceiling-effect mitigation in Phase 6 fixture selection. **Forwarded to Phase 6 spec.**
- **OQ2** (analyst §10.4 #2): domain-shift cost calibration. Phase 5 absolute costs +50% over Phase 4; whether fixture-domain or pricing-tier drift remains uncertain. **Forwarded to analyst follow-up before any cross-phase $-claims.**
- **OQ3** (analyst §10.4 #3): F5/Fa Phase 4 anomaly disambiguation (jury-grader regrade). **Forwarded; not a Phase 6 dependency.**
- **OQ4** (analyst §10.4 #4): NB3 re-open trigger if any future phase shows H5 mode-asymmetry. **Forwarded as Phase 6 fixture-reuse pre-condition (D3).**
- **OQ5** (analyst §10.4 #5): mixed-effects model on combined Phase 4 + Phase 5 dataset. **Waived per §7 (option b); forwarded as Phase 6 candidate.**
- **OQ6** (gemini §7 generalizability): Rule 4-A Step 4 may not generalize to (i) ultra-long RAG pipelines (≥ 100k tokens), (ii) highly stateful REPL chains, (iii) real-time streaming agentic loops. **Forwarded; documented as known-limit; Phase 6 may include a stress-fixture if scope permits.**
- **OQ7** (Q4 cross-CLI cut parity per substitute-compact sub-ADR §7.3): substitute-compact has no defensible cross-CLI semantic until Q4 lands. **Forwarded; Phase 5+ stays Claude-only per Rule 4-0.**
- **OQ8** (Layer terminology overlap): the §4 workload-horizon Layer 1/2/3 nomenclature overlaps with Rule 4-A Step 1's capability-Layer 1/2 terminology. Rule 4-A docs/rules.md update (§10.2) should clarify with explicit "horizon-layer" vs "capability-layer" prefixes if confusion is observed in practice. **Forwarded to orchestrator on rules.md edit.**

---

## §13 Sign-off

- **Drafted by**: `aigentry-architect-rule-4-a-final` (claude opus 4.7 1M, via aigentry-orchestrator dispatch under SAWP authority).
- **Cross-LLM reviewers** (Phase 5 evidence base, integrated above):
  - codex (`aigentry-reviewer-phase5-codex`) — `ACCEPT_WITH_CONDITIONS`, 5 conditions C1–C5; integrated §5 / §6 / §7 / §3.7 / §3.5 / §4.5 / §8.
  - gemini (`aigentry-reviewer-phase5-gemini`) — `ACCEPT` with 1 MAJOR + 3 MINOR, conditions D1–D3; integrated §4.1 / §4.5 / §11 / §8.
- **Awaiting**: User approval (oikim @ aigentry-orchestrator-claude). Status flips to **Accepted** on approval per `references/frontmatter-schema.md` §검증규칙 + §5.6 INVARIANT.
- **Self-check (CLAUDE.md §6 7-item rubric)**: 7/7 PASS — §1 Context explains why now; §3 / §4 cite ≥ 2 alternatives in §4.1 (random co-equal, PC-primary auto-failover, user-config — all explicitly considered); each rejection cites evidence (gemini D1, analyst §10.1); §7 Consequences coverage embedded in §4.5 (substitute-compact failure mode), §11 (time-box), §12 (open questions); §6 Backward Compat addressed via §4.4 migration table + §10 affected files; §9 Constitution Check completed (Q1–Q5 + Articles 1/2/3/9/17 all PASS); §11 Verification Plan = Phase 6 binding pre-reg gates + sunset date + OQ tracking.
- **Hard-rule grep verification** (per §5 + §13 dispatch hard rules): no `equivalence`, `equivalent`, `indistinguishable`, `proven equal` outside the §5 forbidden-list and §8 quoted condition text — verified by post-write grep (see §13 commit message).

---

*End of ADR 2026-05-01-rule-4-a-step-4-final-lock. Status: Accepted (2026-05-01). Supersedes 2026-05-01-rule-4-a-step-4-preuse-clear-activation.*
