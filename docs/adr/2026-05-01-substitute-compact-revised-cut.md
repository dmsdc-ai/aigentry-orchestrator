---
type: adr
status: superseded
superseded_by: ["docs/adr/2026-05-03-substitute-compact-phase6-promote.md"]
superseded_date: 2026-05-03
date: 2026-05-01
author: aigentry-architect-substitute-compact-cut
scope: cross-project
decision_type: two-way
tier: T1
tags: [substitute-compact, phase5, cut, hyperparameter, superseded]
related:
  - "docs/adr/2026-05-03-substitute-compact-phase6-promote.md"
  - "docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md"
  - "docs/adr/2026-04-26-q1-prereq-redesign.md"
related_tasks: [329]
---

# ADR 2026-05-01 (sub): Substitute-Compact Phase 5 Revised Cut

> **⚠ Record of change 2026-05-03 — SUPERSEDED**
>
> This sub-ADR is **superseded** by `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` (Phase 6 Q1 PROMOTE; commit c758a49) per its §4.4. The cut=30 single-lock framing recommended below is **subsumed** by the chain-length-conditional cut policy of the superseding ADR (cut=30 retained for 10-pos chains; cut=5 added for 5-pos chains; other chain lengths fall back to PC). Mechanism (substitute-compact-v1) is unchanged. See superseding ADR §4.2, §4.3, §4.4 for the binding successor contract. Historical content below preserved for audit (parent ADR §11 sacred-but-amendable record-of-change pattern).

- **Status**: **Superseded** by `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` (2026-05-03). Original status: Proposed (sub-decision; cascade-b of ADR 2026-05-01 §2.3 + condition 7).
- **Date**: 2026-05-01
- **Author**: architect session `aigentry-architect-substitute-compact-cut` (claude opus 4.7 1M)
- **Track**: #329 Track E27 — α-step-12b
- **Decision type**: two-way (revisable on Phase 5 holdout data) — superseded by Phase 6 Q1 promote
- **Scope**: cross-project (binds Phase 5 pre-reg tag scope; substitute-compact-v1 mechanism unchanged)
- **Tier**: T1 (sub-ADR scoped to one hyperparameter, parent ADR §8.5 already binds)
- **Authority chain**: parent ADR `2026-05-01-rule-4-a-step-4-preuse-clear-activation.md` §2.3 + §8.5 (gemini condition 7 retention) → Phase 5 spec `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md` §3.2 (architect-determined revised cut, default Option A p50 if undecided) → **Phase 6 Q1 PROMOTE sub-ADR `2026-05-03-substitute-compact-phase6-promote.md` (supersedes)**

---

## §1 Context

Phase 4c tested four substitute-compact arms at cumulative-input cuts C1=10k, C2=50k, C3=100k, C4=150k tokens (`docs/adr/2026-04-26-q1-prereq-redesign.md` §4.1). All four clustered around Pacc with Δq within ±0.020 and p ≥ 0.56 (`~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md` §5 lines 107–112). Parent ADR §2.3 retained the mechanism (V3 byte-equality PASS — devkit `26f8cc4`) and deferred the rejection to a hyperparameter-level question. Phase 5 spec §3.2 routes that question here: pick **one** revised cut for the single-arm hyperparameter sanity check on the 5-fixture holdout. Mechanism (`substitute-compact-v1` per `docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6) is **unchanged** per dispatch invariant.

---

## §2 Q1–Q3 Analysis (empirical evidence)

### §2.1 Q2 — Did the mechanism actually fire? (read-only audit of 40 chain_state files)

Sampled **all 40** `chain_sess{1..10}.json` across `Preuse-substitute-compact-{C1,C2,C3,C4}` in `state/exec-mode-experiment/phase4-preuse/1/`. Every file reports `"segment_start_position": 1`. **The substitute-compact cut crossed in 0/40 sessions.** All four C-arms behaved as Pacc-with-relabeled-output.

### §2.2 Q1 — Why all four cuts failed (mechanism-level diagnosis)

Spec §4.6.9 (`docs/adr/2026-04-26-q1-prereq-redesign.md:328-334`) binds the cut metric to `metrics.cost.usage_buckets.input_tokens` — the **uncached delta** per turn, not transcript volume. Re-aggregating run-1 phase4-preuse trials (n=400 across 4 cuts, 10 sessions × 10 positions each):

| metric | value |
|---|---|
| input_tokens / position (μ, median, max) | **5.5, 5, 40** |
| 10-pos chain cumulative input_tokens (μ, median, max, min) | **54, 51, 94, 50** |
| sessions where cumulative crossed C1=10k | **0 / 40** |
| sessions where cumulative crossed C2=50k or higher | **0 / 40** |
| cache_read_tokens / position (μ, max — proxy for true transcript volume) | 65,649 ; 309,510 |

The cut metric is ~3 orders of magnitude smaller than the cut threshold. Hypothesis B is **empirically confirmed**: cuts were too large for the metric chosen, so the mechanism never fired. Hypothesis A (cuts too small) is refuted; C/D not testable while B holds.

### §2.3 Q3 — Per-cut cost (mechanism never fired → cost differences are sample noise)

| cut | n | q.μ | q.σ | $.μ | $.σ | (vs Pacc $.μ=0.112) |
|---|--:|--:|--:|--:|--:|---|
| C1 | 100 | 0.155 | 0.289 | **0.1120** | 0.048 | matches Pacc |
| C2 | 100 | 0.167 | 0.290 | 0.1176 | 0.058 | +5% |
| C3 | 100 | 0.155 | 0.288 | **0.1118** | 0.052 | matches Pacc |
| C4 | 100 | 0.139 | 0.276 | 0.1286 | 0.079 | +15% (cache_read order noise; not extra fires) |

Reading: parent ADR §3.1 (`docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md:97-105`) reproduced. C4's $.μ inflation is sample-variance in cache_read on later positions of seed-specific fixture orderings — **not** mechanism-driven, since `segment_start_position=1` everywhere.

---

## §3 Hypothesis Chosen — **Hypothesis B (cuts too large; mechanism never fired)**

Selected over A/C/D because §2.1 evidence is decisive (40/40 sessions, p_observed = 0). Mechanism-correctness V3 PASS (devkit `26f8cc4`) plus §2.2 metric mismatch implies the Phase 4c failure is a **hyperparameter-vs-metric mis-specification**, not a mechanism limitation. The dispatch's stated "5k–1M tokens" search range is itself a residue of the same misreading; the empirically valid range under the locked metric is **single-digit to low-tens of tokens**.

---

## §4 Recommended Cut Value

**Recommended: `cut_tokens = 30`**, with acceptance bounds **[20, 50]**.

| candidate | sessions firing (40-session sample) | expected fire position (10-pos chain median session, cum=51) |
|--:|--:|---|
| 10 | 40/40 (100%) | pos 2 (cum=11) — fires twice; confound |
| 20 | 40/40 | pos 4 (cum=21) — early; little post-fire chain |
| **30** | **40/40** | **pos 6 (cum=31) — splits chain in half (pos 1–5 Pacc-style, 6–10 post-substitute)** |
| 50 | 40/40 | pos 9–10 (cum=46–51) — fires too late to measure recovery |
| 100+ | 0/40 | never fires (replicates Phase 4c) |

`cut_tokens = 30` is the **minimum value that yields exactly one fire per session at mid-chain across all sampled seeds**. Mid-chain is the position where Pacc context-rot is established (parent ADR §3.2 Δq vs PC = +0.572 across pos 1–10 averaged) but enough post-fire positions remain (5/10) to measure recovery quality. Bounds [20, 50] preserve "single fire per session"; outside this band the test confounds (multi-fire <20, no-fire-effect-window >50).

> **Note on the dispatch's stated "5k–1M tokens" range**: that range was derived under the assumption that `cut_tokens` matches transcript volume. Spec §4.6.9 binds it to uncached `input_tokens` (~5/pos). Any cut ≥ 100 tokens is mechanically equivalent to Phase 4c (no fire). Architect autonomy invoked per Constitution Rule 5 (최선) — recommendation falls outside the dispatch range with explicit empirical justification.

---

## §5 Phase 5 Inclusion Contract

Three Phase-5-result branches map to three downstream actions, aligned with Phase 5 spec §7.7 (`docs/superpowers/specs/2026-05-01-phase5-holdout-design.md:291-297`):

| Phase 5 result (revised arm vs Pacc on holdout) | Action |
|---|---|
| Δq ≥ +0.20 (very large; p<0.01, d≥0.7) | **Reopen ADR 2026-05-01 §2.3** — substitute-compact promoted to candidate chain mode, full hyperparameter sweep ADR (Phase 6) drafted. |
| Δq ≥ +0.10 AND p<0.05 AND d≥0.5 | **Open Phase 6 hyperparameter sweep** — separate ADR exploring cuts {10, 20, 30, 50, 100k} (mixed coarse + fine grid) on the metric-corrected scale. |
| −0.05 ≤ Δq ≤ +0.10 | Mechanism stays in-tree, **watch-list priority**. No Phase 6 unless cross-CLI extension forces re-evaluation. |
| Δq < −0.05 (worse than Pacc) | **Mechanism deprecated** as a chain-mode candidate (not deleted); follow-up ADR removes it from Rule 4-A Step 4 candidate set. |

Mechanism (substitute-compact-v1, `docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6) byte-equality remains binding; cut_tokens is the only tunable. V3 PASS (10/10 manifests) re-verification on the new arm name is a Phase 5 pre-reg-tag pre-condition (Phase 5 spec §5.3 #5 smoke).

---

## §6 Risks

- **R1 — Tiny cut conceptually mis-aligned with "transcript-size" framing in spec §4.1.** The cut is a hyperparameter of the locked metric; the spec's prose framing is the lossy element, not the choice. Mitigation: §2.2 + §3 documents the metric-vs-prose gap so downstream readers don't infer the mechanism semantic from the tiny number alone.
- **R2 — Single fire at pos 6 may be too late to recover quality if Pacc-rot is irreversible by pos 5.** If Phase 5 result lands at Δq within ±0.05 of Pacc, the mid-chain hypothesis is also dead and Phase 6 must test cut=10 (fire at pos 2, full post-fire chain). Mitigation: result branch in §5 row 3 keeps the mechanism in-tree for that future test rather than deleting it.
- **R3 — Cost inflation > parent ADR §2.3 noise estimate.** Each fire is one cold `claude -p` call (~$0.17 warmup tax). Expected $.μ ≈ $0.13/trial-pos vs Pacc $0.112 (+16%). Quality must lift ≥+0.10 to remain Pareto-relevant against PC ($0.206, q=0.719). If Δq lifts but $ also lifts proportionally, U2 rank stays below PC. Mitigation: §5 explicit Δq thresholds, not Δ$ targets.
- **R4 — Pre-reg violation if downstream coder/builder modifies the v1 spec to "fix" the metric.** That would change the mechanism, not the hyperparameter, and break Phase 4c ↔ Phase 5 comparability. Mitigation: dispatch invariant restated; only cut_tokens changes; metric (`metrics.cost.usage_buckets.input_tokens`) is locked.

---

## §7 Open Questions for Phase 5 → Architect Re-analysis Pipeline

1. **Per-fixture fire-distribution audit**: Phase 5 analyst should publish `segment_start_position` distribution per (fixture, seed) for the revised arm. If distribution clusters tightly at pos 6 across 5 fixtures × 10 seeds, mid-chain hypothesis is well-controlled; if it splays (e.g., pos 3 on H3 multilingual recall, pos 8 on H1 long-form), per-fixture cut would be the next ADR.
- 2. **Metric-correction ADR (deferred, not opened here)**: a future ADR should evaluate whether the substitute-compact-v2 metric should switch from `input_tokens` (uncached delta) to a transcript-volume proxy (`cache_read_tokens` or `input + cache_read`). That is a mechanism-level change requiring a v2 spec + new V3 digest set; **out of scope** for this sub-ADR per dispatch invariant.
3. **Cost amortization at cross-CLI extension**: parent ADR §7.4 of `q1-prereq-redesign` flags Q4 as a Phase 6+ blocker for cross-CLI cut equivalence. cut=30 has no defensible cross-CLI semantic until Q4 lands; Phase 5 stays Claude-only per Rule 4-0 Narrow Lock.
4. **Phase 5 quadrant interaction**: Phase 5 spec §7 (PC vs S quadrants Q1–Q6) is orthogonal to this sub-ADR per §7.7 (`…phase5-holdout-design.md:291`). Architect re-analysis pipeline should produce two reports in parallel — PC-vs-S quadrant + revised-arm Δq — and merge into one synthesis ADR (rev3 of parent or supersession).

---

## §8 Related

- Parent ADR (Accepted): `docs/adr/2026-05-01-rule-4-a-step-4-preuse-clear-activation.md` §2.3, §8.5
- Phase 5 spec (Draft): `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md` §3.2, §7.7, §8.1
- Predecessor ADR (substitute-compact-v1 spec, V3 PASS): `docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6
- Phase 4 final analysis: `~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md` §5
- Empirical chain_state audit (this ADR §2.1): `state/exec-mode-experiment/phase4-preuse/1/Preuse-substitute-compact-{C1..C4}/chain_sess{1..10}.json`

---

*End of sub-ADR. Next: cascade-c (user fixture-selection) merges with this for the Phase 5 pre-reg tag scope per Phase 5 spec §5.3.*
