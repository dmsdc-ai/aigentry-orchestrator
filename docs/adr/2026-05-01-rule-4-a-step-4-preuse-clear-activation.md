# ADR 2026-05-01: Rule 4-A Step 4 Activation — Preuse-clear as Chain-Mode Default

- **Status**: **Accepted (2026-05-01)** — user signoff received via aigentry-orchestrator-claude session (option C-1).
- **Date**: 2026-05-01
- **Author**: architect session `aigentry-architect-rule-4-a-step-4` (claude opus 4.7 1M)
- **Co-authors (3-LLM ensemble)**:
  - Analyst (claude): `aigentry-devkit-analyst-final` — Phase 4 final analysis report
  - Reviewer (codex): `aigentry-devkit-analyst-review-codex` — ACCEPT-IF + 4 conditions
  - Reviewer (gemini): `aigentry-devkit-analyst-review-gemini` — ACCEPT-IF + 3 additional conditions
- **Tracking**: #329 Track E27 — Phase 4 α-step-11 (Rule 4-A Step 4 activation)
- **Predecessor ADRs**:
  - `docs/adr/2026-04-22-rule-4-mode-selection.md` (Rule 4-0 Narrow Lock + Rule 4-A — Accepted)
  - `docs/adr/2026-04-26-q1-prereq-redesign.md` (Phase 4c substitute-compact-v1 spec, V3 PASS)
- **Predecessor plan**: `docs/plans/2026-04-22-phase4-plan.md` (Phase 4 — Draft, §7 success criteria binding)
- **Spec authority**: `docs/superpowers/specs/2026-04-26-phase4-final-analysis-spec.md`
- **Pre-registration**: `exec-mode-v4-replication-preregistered-20260426` (devkit commit `26f8cc4`/`2351fa6`) — V3 byte-equality regression PASSED (10/10 manifests, two independent implementations).
- **Decision type**: two-way (revisable on Phase 5 holdout data per §8)
- **Scope**: ecosystem (Rule 4-A successor; binds orchestrator routing across all Claude-only chain modes)
- **Tier**: T2 (ADR + ecosystem scope) — 2 reviewer threshold satisfied by codex + gemini independent reviews completed 2026-05-01

---

## §1 Context

### 1.1 Why this ADR now

ADR `2026-04-22-rule-4-mode-selection.md` shipped Rule 4-A Step 4 as a *gated* activation: Preuse-clear and Preuse-substitute-compact-Cn (4 cuts) were declared candidate chain modes pending Phase 4 empirical evidence. The Phase 4 plan §7 (`docs/plans/2026-04-22-phase4-plan.md` lines 128–135) bound Full Policy Lock to:

1. Phase 4b ranking preservation (1-rank tolerance, S–D gap stability < 0.05 absolute).
2. Best Preuse arm beats Pacc by a pre-declared margin.
3. Phase 5 holdout grader accuracy ≥70%.

Phase 4 fired 1300 trials under the pre-registered tag (800 replication + 500 Preuse) and the analyst, codex, and gemini sessions independently re-checked the dataset. The aggregate verdict: **ACCEPT-IF + 7 conditions** — necessary edits to claim language before Rule 4-A Step 4 activation can be honored. This ADR codifies the activation decision and the 7 conditions verbatim.

### 1.2 Inputs synthesized

| Input | Path | Commit / Date |
|---|---|---|
| Phase 4 final analysis report | `~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md` | 2026-04-28 |
| Codex independent review (4 conditions) | `~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-codex.md` | 2026-05-01 |
| Gemini independent review (3 additional conditions) | `~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-gemini.md` | 2026-05-01 |
| Final analysis spec (pre-data) | `docs/superpowers/specs/2026-04-26-phase4-final-analysis-spec.md` | 2026-04-26 |
| Phase 3 baseline | `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md` | commit `472cc9f` |
| Pre-reg tag | `exec-mode-v4-replication-preregistered-20260426` (V3 PASS digest commit `26f8cc4`) | 2026-04-26 |
| Predecessor ADR | `docs/adr/2026-04-22-rule-4-mode-selection.md` | Accepted 2026-04-26 |
| Predecessor ADR (substitute-compact-v1 spec) | `docs/adr/2026-04-26-q1-prereq-redesign.md` | Accepted rev2 2026-04-26 |
| Constitution | `~/projects/aigentry/docs/CONSTITUTION.md` | Articles 1, 2, 5 govern (§7 below) |

### 1.3 Authority chain

3-LLM cross-LLM verdict — claude analyst report → codex review (ACCEPT-IF + 4 conditions) → gemini review (ACCEPT-IF + 3 additional conditions). Total 7 conditions. User decision (orchestrator dispatch α 2026-05-01): proceed with all 7 conditions reflected verbatim.

---

## §2 Decision

### 2.1 Chain-mode activation

**Activate Preuse-clear as the chain-mode default**, replacing Pacc in Rule 4-A Step 4. Pacc is demoted from "tolerated for in-flight sessions with explicit reversal" (Rule 4-A Step 3 carve-out) to **deprecated default** with a 1-cycle migration window (§6).

**Activation criterion (per condition 4 — codex)**: Preuse-clear vs Pacc, **Δq = +0.572, p < 0.0001 (two-sample Welch), Cohen d = 1.95**, 95% CI [+0.4972, +0.6471]. The activation argument is *chain-mode replacement* (PC vs Pacc, both chain modes), **not** cross-category dominance over D (which is non-chain and is not statistically separated from PC at n = 100/200; see §3.2).

### 2.2 Non-chain default

**Keep D as Layer 2 default. On Layer 1, treat S and D as co-equal** under a Phase 4b rank-swap caveat (Phase 3: D > S; Phase 4b: S > D; both inside Phase 3's overlapping CI). Final D vs S Layer 1 ordering is **deferred to Phase 5 holdout** (per condition 5 — gemini, see §8).

### 2.3 Substitute-compact arms

**All four Preuse-substitute-compact-Cn arms (C1 / C2 / C3 / C4) are rejected as chain-mode defaults** for the current Phase 4c truncation grid (10k / 50k / 100k / 150k). All four show Δq within ±0.020 of Pacc with p ≥ 0.56; C4 is strictly worse than Pacc on cost (p = 0.0481).

**The substitute-compact mechanism is NOT deprecated** (per condition 7 — gemini). V3 byte-equality regression (10/10 manifests, two independent implementations, devkit commit `26f8cc4`) proved implementation correctness; the failure is at the **hyperparameter level** (truncation thresholds), not the mechanism level. The mechanism is flagged for a future hyperparameter tuning sweep with revised cuts (§5.3, §8.5).

### 2.4 Updated Rule 4-A Step 4 text (proposed)

```
Step 4 — Preuse Selection (ACTIVATED 2026-05-01 by ADR 2026-05-01-rule-4-a-step-4)
  세션 재활용이 필요한가?
  - Default chain mode: Preuse-clear (replaces Pacc per ADR §2.1)
  - Pacc: deprecated default; in-flight tolerance window per Rule 4-A Step 3
    sunset 2026-08-01 (§6 migration plan)
  - Preuse-substitute-compact: NOT a Phase 4 default. Mechanism remains
    in-tree (substitute-compact-v1 per ADR 2026-04-26-q1-prereq-redesign §4.6).
    Re-evaluation gated on hyperparameter tuning sweep (separate ADR; cuts
    other than 10k/50k/100k/150k untested).
```

The full Rule 4-A body update lands in `docs/rules.md` only after this ADR is **Accepted**.

---

## §3 Evidence

### 3.1 Per-mode aggregate (analyst report §3, full n = 200 / 100)

| mode | n | quality.μ | cost.μ ($) | loss.μ | compact.detected |
|---|---:|---:|---:|---:|---:|
| **Preuse-clear** | 100 | **0.719** | **0.206** | 0.011 | 0 |
| S | 200 | 0.737 | 0.214 | 0.016 | 0 |
| D | 200 | 0.691 | 0.209 | 0.021 | 0 |
| Pfresh | 200 | 0.547 | 0.210 | 0.015 | 0 |
| Pacc | 200 | 0.146 | 0.112 | 0.012 | 0 |
| Preuse-substitute-compact-C1 | 100 | 0.155 | 0.112 | 0.006 | 0 |
| Preuse-substitute-compact-C2 | 100 | 0.167 | 0.118 | 0.019 | 0 |
| Preuse-substitute-compact-C3 | 100 | 0.155 | 0.112 | 0.011 | 0 |
| Preuse-substitute-compact-C4 | 100 | 0.139 | 0.129 | 0.014 | 0 |

Source: `docs/reports/2026-04-28-phase4-final-analysis.md:55–67` (analyst); independently reproduced by codex review §2 C1–C5 (`docs/reviews/2026-05-01-phase4-final-analysis-review-codex.md:27–31`).

### 3.2 Activation pair — Preuse-clear vs Pacc (chain-mode replacement)

- Δq = **+0.572** (95% CI [+0.4972, +0.6471])
- two-sample Welch t = 15.07, **p < 0.0001**
- **Cohen d = 1.95** (very large effect)
- Δ$ = +$0.0949, two-sample Welch p < 0.0001 (cost is *higher* — explicit cost-quality trade-off accepted under U2 weighting)

Source: analyst §5 (`…2026-04-28-phase4-final-analysis.md:107`), codex §2 C5 (`…review-codex.md:31`), codex §3 effect-size paragraph (`…review-codex.md:44` — "Preuse-clear-Pacc quality delta +0.57212, CI [+0.49717,+0.64707], d=1.952").

### 3.3 Adjacent comparison — Preuse-clear vs D (informational; NOT activation criterion per condition 4)

- Δq = +0.0277 (95% CI **[−0.0518, +0.1073]** — straddles zero)
- two-sample Welch p = **0.4925** (no statistical separation)
- Cohen d = 0.083 (negligible)
- Δ$ = −$0.00216 (95% CI [−0.0283, +0.0239]; p = 0.8705)

**Reading**: Preuse-clear's *point-estimate* Pareto-dominates D, but the dominance is **not statistically separated**. This claim cannot carry the activation argument — it is informational context only. D and Preuse-clear address different routing categories (D = non-chain dispatch; PC = chain reuse), so the comparison is cross-category by design.

Source: codex §2 C8 (`…review-codex.md:34`).

### 3.4 Adjacent comparison — Preuse-clear vs S (statistical tie under U2)

- Codex bootstrap (B = 20000): **P(PC > S) ≈ 0.5039** under U2 = 0.7·norm(q) − 0.3·norm($)
- 95% CI on bootstrap mean: **[−0.1136, +0.1101]** — symmetric around zero
- Point-estimate U2 gap: PC 0.401 vs S 0.400 (Δ = +0.00109 — smaller than resampling noise)

**Reading (per condition 3 — codex)**: Preuse-clear and S are *statistically tied* under U2. Do **not** claim a robust U2 win from a +0.001 point-estimate margin. ADR ranking language: `Preuse-clear ≈ S > D > Pfresh ≫ {C1, C3, C2, Pacc} > C4`.

Source: codex §3 normalization paragraph (`…review-codex.md:42`), codex §4 narrow-lead paragraph (`…review-codex.md:48`), gemini §3 P5 (`…review-gemini.md:39`).

### 3.5 Pareto frontier (analyst §6)

Pareto-non-dominated modes:

- **Preuse-clear** (q = 0.719, $ = 0.206) — point-estimate dominates D; statistically tied with S on U2.
- **S** (q = 0.737, $ = 0.214) — highest quality.
- **Pacc** (q = 0.146, $ = 0.112) — cheapest absolute cost; quality floor.

D is **off the Pareto front in Phase 4b on point estimate** but the PC–D comparison is not statistically separated (§3.3), so this is a soft frontier finding.

### 3.6 Phase 3 vs Phase 4b ranking (relabeled per condition 1 — codex)

| mode | Phase 3 μ | Phase 4b μ | Δ | **two-sample Welch p** (Phase 3 raw variance) | one-sample p (Phase 3 mean as fixed constant — historical-baseline) |
|---|---:|---:|---:|---:|---:|
| D | 0.684 | 0.691 | +0.007 | 0.8617 | 0.7616 |
| S | 0.637 | 0.737 | +0.100 | **0.0187** | 7.45e-06 |
| Pfresh | 0.478 | 0.547 | +0.069 | (analyst report fixed-baseline only) | 0.0073 |
| Pacc | 0.164 | 0.146 | −0.018 | (analyst report fixed-baseline only) | 0.3664 |

Source: codex §2 C2 (`…review-codex.md:28`).

**Per condition 1 — codex**: Earlier "p < 0.0001" wording for Phase 3 comparisons reflected a **one-sample test against the Phase 3 mean as a fixed constant** (historical-baseline), not a true two-sample Welch with Phase 3 raw variance. ADR adopts the codex-recomputed two-sample p-values; the **point estimates and 1-rank preservation hold**, but inferential strength is downgraded for cross-phase claims.

### 3.7 F5 / Fa anomalies (downgraded per condition 2 — codex)

| fixture | Δ (D-mode) | fixed-baseline p | **two-sample Welch p** | 10-fixture Bonferroni α = 0.005 |
|---|---:|---:|---:|---|
| F5 | −0.192 | 0.0106 | **0.1662** | FAIL on both methods |
| Fa | −0.125 | 0.0058 | **0.0748** | FAIL on both methods |

Per condition 2 — codex: F5 and Fa are downgraded to **"fixed-baseline signals"** — neither survives a true two-sample Welch at p < 0.05, neither passes 10-fixture Bonferroni. They are **follow-up candidates** (e.g., Phase 5 jury-grader regrade), **not lock-blocking confirmed anomalies**. Source: codex §2 C3 (`…review-codex.md:29`), codex §4 n=20 paragraph (`…review-codex.md:54`).

### 3.8 Cost 2.07× anomaly (analyst §8 — independent of activation argument)

Cost ratio Phase 4b / Phase 3: D 2.05×, S 1.98×, Pfresh 1.64×, Pacc 0.96×. Pattern fingerprint = per-trial fixed-cost overhead, attributed to Anthropic 2026-04-23 cache pricing change (`cache_write_5m` retired → all trials charged 1h tier). **Does not affect intra-phase mode rankings** because all Phase 4b modes paid the same calibration. Cross-phase absolute cost comparisons require the §3.6-style calibration footnote.

---

## §4 Conditions Applied (verbatim from 3-LLM reviews)

All 7 conditions are reflected in this ADR. Each is paraphrased verbatim with citation, then mapped to ADR sections that honor it.

### Codex C1 — Phase 3 comparisons relabeled

> "Relabel Phase 3 comparisons as 'one-sample versus historical Phase 3 mean' or replace p-values with true two-sample Welch tests using Phase 3 raw variance."
> — `docs/reviews/2026-05-01-phase4-final-analysis-review-codex.md:16` (§1 verdict, condition 1)

**Honored in**: §3.6 (both methods reported side-by-side, two-sample Welch promoted as primary). Earlier "p < 0.0001" claims explicitly tagged as historical-baseline.

### Codex C2 — F5 / Fa anomaly language downgraded

> "Downgrade F5/Fa anomaly language to fixed-baseline signals unless multiple-comparison policy is explicitly waived. They do not survive a simple 10-fixture Bonferroni threshold, and they are not p<0.05 under two-sample Welch."
> — `…review-codex.md:17` (§1 verdict, condition 2)

**Honored in**: §3.7 (table with both methods + Bonferroni status), §5.3 (risk row), §8.4 (Phase 5 jury-grader follow-up scope).

### Codex C3 — Preuse-clear / S U2 tie

> "Treat Preuse-clear and S as tied under U2. Do not claim a robust U2 win from a +0.001 point-estimate margin. Bootstrap B=20000 for Preuse-clear − S: mean −0.00012, 95% CI [−0.1136, +0.1101], P(Preuse-clear > S) = 0.5039."
> — `…review-codex.md:18` (§1 verdict, condition 3) + `…review-codex.md:32` (§2 C6 recompute)

**Honored in**: §3.4 (CI and bootstrap reported), §2.2 (Layer 1 default deferred), §8.1 (Phase 5 must adjudicate PC vs S directly per gemini condition 5).

### Codex C4 — Activation argument is PC vs Pacc, not PC vs D

> "In Phase 5 / ADR wording, reject substitute-compact arms by the spec decision tree, and justify Preuse-clear activation as a chain-mode replacement for Pacc. Do not rely on cross-category 'dominates D' language without the caveat that D is non-chain and the D comparison is not statistically separated."
> — `…review-codex.md:19` (§1 verdict, condition 4)

**Honored in**: §2.1 (activation pair declared as PC vs Pacc), §3.3 (PC vs D explicitly informational, not activation criterion). "Pareto-dominates D" wording removed from Decision; retained only as soft-frontier reading in §3.5.

### Gemini C5 — Phase 5 holdout MUST include both Preuse-clear AND S

> "Condition 5 (Phase 5 Scope): The Phase 5 holdout MUST include both Preuse-clear AND S. Given their statistical tie in U2, selecting only Preuse-clear as the holdout focus introduces survivorship bias."
> — `docs/reviews/2026-05-01-phase4-final-analysis-review-gemini.md:58` (§5 condition 1 / overall condition 5)

**Honored in**: §8 Verification Plan (Phase 5 mode set includes BOTH PC and S), Phase 5 spec `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md` §3.

### Gemini C6 — U2 re-calculation on Pareto-restricted normalization domain

> "Condition 6 (Utility Re-calculation): Re-calculate U2 utility scores with a normalization domain restricted to the Pareto-efficient frontier (excluding C1–C4) to confirm the Preuse-clear vs S ranking without outlier distortion."
> — `…review-gemini.md:59` (§5 condition 2 / overall condition 6)

**Rationale (gemini §3 P4, line 36)**: structurally failed arms (C1–C4) anchor cost minimum (~$0.112) and quality minimum (0.139) under min-max normalization; including these compresses the linear spacing between viable modes (S, D, Preuse-clear) and may hide a meaningful U2 separation.

**Honored in**: §8.2 Verification Plan (analyst recompute scheduled before Phase 5 fires; spec §6 lists this as a pre-Phase-5 deliverable). Result feeds Phase 5 decision tree (Phase 5 spec §7).

### Gemini C7 — Substitute-compact deferred, NOT deprecated

> "Condition 7 (Substitute-Compact Future): Do not deprecate the substitute-compact mechanism entirely. Flag it for a future hyperparameter tuning sweep (different truncation thresholds) rather than declaring the approach dead."
> — `…review-gemini.md:60` (§5 condition 3 / overall condition 7)

**Rationale (gemini §3 P6, line 41)**: V3 byte-equality regression PASSED (devkit commit `26f8cc4`) proves implementation correctness; the C1–C4 failure is likely a hyperparameter-design failure (10k/50k/100k/150k boundaries), not a mechanism failure.

**Honored in**: §2.3 (mechanism retained in-tree under substitute-compact-v1 spec; Cn arms rejected as defaults), §8.5 Verification Plan (Phase 5 may include a single revised-cut substitute-compact arm for hyperparameter sanity, flagged in Phase 5 spec §3 / §8), §11 Open Questions.

---

## §5 Risks

### 5.1 R1 — PC ≈ S tie may resolve against PC on Phase 5 holdout

**Source**: condition 3 + 5. **Trigger**: Phase 5 PC quality on holdout fixtures < S quality with statistically separated Welch p < 0.05 and Cohen d ≥ 0.3. **Impact**: Rule 4-A Step 4 must be revised — S becomes Layer 1 chain default, PC demoted or removed. **Mitigation**: Phase 5 spec §3 mandates BOTH PC and S in mode set; spec §7 decision tree pre-declares the PC < S quadrant outcome.

### 5.2 R2 — Substitute-compact mechanism delisted by misreading "deferred" as "deprecated"

**Source**: condition 7. **Trigger**: downstream coder/builder sessions remove substitute-compact-v1 code paths. **Impact**: hyperparameter tuning sweep (Phase 6+) has nothing to tune. **Mitigation**: §2.3 explicit retention language; substitute-compact-v1 spec at `docs/adr/2026-04-26-q1-prereq-redesign.md §4.6` remains canonical; Rule 4-A Step 4 wording (§2.4) names the mechanism explicitly.

### 5.3 R3 — F5 / Fa "weak signals" misread as confirmed anomalies in downstream artifacts

**Source**: condition 2. **Trigger**: AGENTS.md or downstream rule docs cite F5/Fa Δ ≥ 0.10 without the Bonferroni / Welch-p-fail caveat. **Impact**: Rule 4-A Step 4.5 hard-fixture escalation paths get falsely armed against F5/Fa-class. **Mitigation**: §3.7 explicit downgrade language; Phase 5 spec §6 schedules a jury-grader regrade as the disambiguating follow-up.

### 5.4 R4 — Pacc deprecation breaks in-flight sessions mid-cycle

**Source**: §2.1 + §6. **Trigger**: existing chain sessions (research threads, long-running orchestrator deliberations) hard-coded against Pacc behavior. **Impact**: routing regressions during 1-cycle migration window. **Mitigation**: §6 backward-compat plan keeps Pacc as a tolerated in-flight mode (no auto-routing) until 2026-08-01 sunset. New routing decisions default to Preuse-clear; existing sessions drain naturally.

### 5.5 R5 — Cross-phase cost claims propagate to ADR users without calibration footnote

**Source**: analyst §8. **Trigger**: Pacc 0.96× ratio cited as "Pacc unaffected" without the cache-pricing-change context. **Impact**: cost arguments become unfalsifiable. **Mitigation**: §3.8 calibration footnote; Phase 5 spec §6 binds Phase 5 to intra-phase cost comparisons (PC vs S vs D within Phase 5 cohort, not vs Phase 3/4 absolute prices).

---

## §6 Backward Compatibility

### 6.1 Affected consumers

| Consumer | Current binding | Post-activation behavior |
|---|---|---|
| Orchestrator routing decisions | Rule 4-A Step 4 gated (Phase 4 lock) → Step 4.5 escalation | Step 4 ACTIVATED → default to Preuse-clear; Pacc auto-routing forbidden (already enforced by Step 3 in predecessor ADR) |
| In-flight Pacc sessions | "Tolerated for accumulated sessions with explicit reversal" (Rule 4-A Step 3) | **No change during 1-cycle migration**: existing sessions drain on Pacc; no new sessions started on Pacc |
| AGENTS.md checklist | Item: "Preuse 선택 시 Phase 4 lock 상태 확인" | Update on Acceptance: replace "Phase 4 lock 상태" with "ADR 2026-05-01 chain-mode default applies" |
| `docs/rules.md` Rule 4-A Step 4 | Gated text from `2026-04-22-rule-4-mode-selection.md` §2.2 | Replace with §2.4 above; Pacc deprecation note added |
| Substitute-compact-v1 implementation (`devkit:lib/preuse-substitute-compact-v1`) | Wired into Preuse-substitute-compact-Cn arms | **Retained** — implementation stays in-tree; arms not surfaced as routing defaults |
| Pre-reg tag `exec-mode-v4-replication-preregistered-20260426` | Authoritative for Phase 4b/4c scope | Frozen; Phase 5 introduces a separate tag (Phase 5 spec §5) |

### 6.2 Migration path

1. **2026-05-01 (this ADR Proposed)** — orchestrator drafts AGENTS.md + docs/rules.md edits; user gate pending.
2. **On Accepted (TBD)** — orchestrator activates: AGENTS.md checklist item updated, `docs/rules.md` Rule 4-A Step 4 body replaced. Activation broadcast to active sessions per Rule 3-1 (analogous to predecessor ADR 2026-04-22 §8 activation pattern).
3. **2026-05-01 → 2026-08-01 (1-cycle migration window)** — Pacc remains tolerated for in-flight sessions; new routings go to Preuse-clear. Orchestrator + analyst monitor any Pacc-quality regression reports.
4. **2026-08-01 (sunset)** — Rule 4-A Step 3 Pacc tolerance carve-out removed if Phase 5 confirms PC ≈ S. If Phase 5 reverses (PC < S significantly), this ADR is **Superseded** by a new ADR before sunset.

### 6.3 Migration is additive, not breaking

- No public CLI primitive removed.
- No metrics schema change (compact.detected and chain_state.json fields stable; pre-reg tag scope verified by analyst §2).
- Substitute-compact-v1 binary equivalence (V3 PASS) preserved.
- Backward-compat surface = Rule text + AGENTS.md checklist text. Behavioral change is one-line: Pacc default → Preuse-clear default.

---

## §7 Constitution Check

Per `~/projects/aigentry/docs/CONSTITUTION.md` Article 5 (최선) governance over Rule 4-A.

### Rule 1 — 경량 (lightweight, no over-engineering)

**PASS**. The activation does not introduce a new mechanism; substitute-compact-v1 already exists from predecessor ADR. Preuse-clear is the simplest of the 5 Preuse arms (task-boundary reset, no transcript rewrite). The 4 substitute-compact-Cn arms are *removed* from the routing default set, reducing complexity. Net change: rule text edit; no new code paths; no new dependencies.

### Rule 2 — 크로스 (cross-everything portability)

**PASS with caveat**. Rule 4-0 Narrow Lock scope (Claude-only) carries through unchanged; Preuse-clear is implemented via session-boundary `--print` (no `--resume`), which is portable in principle but **untested on Codex/Gemini drivers**. Layer 2 (cross-CLI, CI/CD) continues to default to D per Rule 4-A Step 5. Promotion of PC to Layer 2 requires Q2/Q4 tracker resolution + a separate ADR.

### Rule 5 — 최선 (best-first, no workarounds)

**PASS**. The 7 conditions force the best statistical framing available from current evidence — no shortcuts. Activation argument is the largest, most defensible effect (Δq = +0.572, d = 1.95) explicitly chosen over the weaker PC vs D framing per condition 4. Where evidence is insufficient (PC vs S tie, F5/Fa weak signals), the ADR defers rather than rationalizing.

### Rule 9 — 독립 (component independence)

**PASS**. Activation binds only orchestrator routing rule; no component (analyst / coder / builder / tester / dustcraw) is forced to depend on the new default. Each session continues to operate independently per its AGENTS.md role.

### Rule 13 — 비판적 + 건설적 + 객관적

**PASS**. ADR draft was reviewed by 3 independent LLMs (claude analyst → codex review → gemini review) with cross-LLM blind-spot detection (§11). 7 conditions reflect critical issues caught only via cross-LLM verification.

### Rule 17 — 무의존 (no external plugin dependence)

**PASS**. No new external dependency introduced. Substitute-compact-v1 is a pure deterministic function (predecessor ADR §4.6); Preuse-clear is `claude --print` without `--resume`.

---

## §8 Verification Plan

Verification deferred to Phase 5 holdout. Phase 5 spec is published as a sibling deliverable in this commit: `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md`.

### 8.1 Phase 5 mode set (per condition 5)

- D, Pacc, Pfresh, S, Preuse-clear (5 carry-over from Phase 4b/4c)
- + 1 revised-cut Preuse-substitute-compact arm for hyperparameter sanity (per condition 7; cut TBD in Phase 5 spec §3 + §8 — architect-determined, single arm not 4)

Total: 6 modes × 5 fixtures × 10 seeds = **300 trials**.

### 8.2 Pre-Phase-5 deliverable — analyst U2 recompute (per condition 6)

Before Phase 5 fires, analyst recomputes U2 with normalization domain restricted to the Pareto-efficient frontier (excluding C1–C4 outliers). Result feeds Phase 5 decision tree:

- If PC vs S separates under Pareto-restricted U2 → Phase 5 priors updated; spec §7 decision tree weighted toward whichever leads.
- If PC vs S still ties under Pareto-restricted U2 → Phase 5 confirms or refutes via 50 PC vs 50 S head-to-head trials per fixture.

Owner: aigentry-devkit analyst session. Output: addendum to `docs/reports/2026-04-28-phase4-final-analysis.md` or a new short report.

### 8.3 Phase 5 success criteria (binding)

Per Phase 4 plan §7 line 132–135 (carried forward):

1. **Grader accuracy ≥70%** on 5 new holdout fixtures.
2. **PC and S both perform** (point estimate ≥0.5 grader accuracy each); if either collapses, Rule 4-A Step 4 is reopened.
3. **PC vs S adjudication** at n = 50 per mode per fixture → Welch p < 0.05 OR Cohen d ≥ 0.3 to declare a separation; otherwise tie persists and orchestrator + user choose default.

### 8.4 F5 / Fa follow-up (per condition 2 indirect)

Phase 5 spec §6 schedules a jury-grader regrade on Phase 4b F5/Fa cells if grader-version drift is implicated as the F5/Fa shift driver. Out of scope for this ADR; in scope for Phase 5 spec.

### 8.5 Substitute-compact hyperparameter sweep (per condition 7)

If Phase 5 includes a revised-cut substitute-compact arm, its result determines whether a follow-up ADR (Phase 6) opens a full hyperparameter tuning sweep at architect-determined cuts (e.g., percentile-anchored from Phase 3 transcript-size distribution per Phase 4 plan §5 P4-pre-2). If Phase 5 substitute-compact arm again clusters around Pacc, the mechanism is escalated to "low-priority follow-up" without immediate sweep.

---

## §9 Related

- **Predecessor ADR (Rule 4-A binding)**: `docs/adr/2026-04-22-rule-4-mode-selection.md` — Step 4 was gated; this ADR ungates it.
- **Predecessor ADR (substitute-compact-v1 spec)**: `docs/adr/2026-04-26-q1-prereq-redesign.md` — V3 PASS authority for condition 7 retention rationale.
- **Phase 4 plan**: `docs/plans/2026-04-22-phase4-plan.md` — §7 success criteria carried into §8.3 above.
- **Final analysis spec (pre-data)**: `docs/superpowers/specs/2026-04-26-phase4-final-analysis-spec.md` — §3.6 decision tree empirically walked in analyst report §9.
- **Final analysis report**: `~/projects/aigentry-devkit/docs/reports/2026-04-28-phase4-final-analysis.md` — primary evidence source.
- **Codex review**: `~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-codex.md` — conditions 1–4.
- **Gemini review**: `~/projects/aigentry-devkit/docs/reviews/2026-05-01-phase4-final-analysis-review-gemini.md` — conditions 5–7 + cross-LLM blind-spots.
- **Phase 5 holdout spec (sibling deliverable)**: `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md`.
- **Phase 3 reference**: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md` (commit `472cc9f`).
- **Pre-reg tag**: `exec-mode-v4-replication-preregistered-20260426` (V3 PASS digest commit `26f8cc4`).

---

## §10 Revision History

| date | rev | change | author | trigger |
|---|---|---|---|---|
| 2026-05-01 | r1 (Proposed) | Initial draft incorporating 7 conditions verbatim from 3-LLM ensemble (claude analyst → codex 4 conditions → gemini 3 conditions). Status: Proposed pending user signoff. | aigentry-architect-rule-4-a-step-4 (claude) | Orchestrator dispatch α 2026-05-01 (SAWP authority) |
| 2026-05-01 | r2 (Accepted) | User signoff received via aigentry-orchestrator-claude (option C-1). Status → Accepted. Cascade dispatch: (a) analyst U2 Pareto-restricted recompute per C6, (b) architect substitute-compact revised-cut sub-decision per C7, (c) user fixture-selection turn for Phase 5, (d) Phase 5 pre-reg tag commit. | aigentry-orchestrator-claude (orchestrator on user behalf) | User C-1 decision after (B) summary review |

Future revisions:
- r3 (Revised) — after Phase 5 holdout completes. Either confirms activation (Full Policy Lock candidate) or supersedes if PC < S separates.

---

## §11 Open Questions / Future Work — Cross-LLM Blind-Spots

Gemini review §4 identified 4 cross-LLM blind-spots affecting both claude analyst and codex reviewer. Two are resolved by conditions 6 and 7 above; two remain as follow-up work.

| # | Blind-spot | Source | Status | Disposition |
|---|---|---|---|---|
| BS1 | **Normalization distortion** (min-max U2 anchored on C1–C4 outliers compresses linear spacing between viable modes) | gemini §4 line 49, §3 P4 line 36 | **Resolved by condition 6** | Pre-Phase-5 deliverable §8.2: analyst recomputes U2 on Pareto-restricted normalization domain. |
| BS2 | **Missing mixed-effects modeling** (trials are paired by fixture; both LLMs treated data as IID — Welch's t-test ignores hierarchical structure) | gemini §4 line 50, §3 P7 line 45 | **Open follow-up** | Phase 5 spec §6 recommends a mixed-effects model with `fixture` as random intercept on the combined Phase 4 + Phase 5 dataset. Owner: analyst (post-Phase-5). Not blocking for this ADR. |
| BS3 | **Absence of per-fixture Pareto frontiers** (best mode likely varies by fixture class — S may dominate reasoning, PC may dominate retrieval — but only global aggregate Pareto reported) | gemini §4 line 51, §3 P7 line 45 | **Open follow-up** | Phase 5 spec §6 recommends a per-fixture-class Pareto breakdown on combined Phase 4 + Phase 5 data. Owner: analyst (post-Phase-5). Not blocking for this ADR. |
| BS4 | **Premature mechanism rejection** (substitute-compact-Cn failure at fixed cuts ≠ mechanism failure; V3 PASS proved implementation correctness) | gemini §4 line 52, §3 P6 line 41 | **Resolved by condition 7** | §2.3 retains substitute-compact-v1 in-tree; §8.5 schedules optional Phase 5 revised-cut arm; substantive sweep gated on a future ADR. |

### 11.1 Effect-size completeness (codex §3 + gemini §3 P3)

Standardized Cohen d is reported for the activation pair (PC vs Pacc, d = 1.95) and PC vs D (d = 0.083) per codex §3. Other Phase 4b pairs (S vs D, S vs Pfresh, etc.) lack reported d. **Open follow-up**: analyst addendum to publish Cohen d for all pairwise mode comparisons in the 5-mode replication set, before Phase 5 fires. Owner: analyst.

### 11.2 Pre-reg scope verification

The current pre-reg tag `exec-mode-v4-replication-preregistered-20260426` covers Phase 4b/4c. **Phase 5 requires a separate tag** per Phase 4 plan §4 line 95 (`exec-mode-v5-holdout-preregistered-YYYYMMDD`). Phase 5 spec §5 binds the tag-creation step before fixtures fire.

---

*End of ADR 2026-05-01-rule-4-a-step-4-preuse-clear-activation. Sibling deliverable: `docs/superpowers/specs/2026-05-01-phase5-holdout-design.md`.*
