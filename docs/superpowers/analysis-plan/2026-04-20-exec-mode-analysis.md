# Analysis Plan — Execution Mode Comparison Experiment (#329)

**Pre-registration date**: 2026-04-20
**Related spec**: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md` (v3-max.1)
**Lock mechanism**: git tag `exec-mode-v3-max-preregistered-YYYYMMDD`

---

## 1. Purpose

이 문서는 실험 실행 전 **확정된 분석 방법**을 pre-registration 합니다. Post-hoc p-hacking 방지 + 재현성 보장.

## 2. Primary analyses (pre-registered)

### 2.1 Cost per (fixture, mode) cell
- Metric: `cost_marginal_$` + `cost_amort_$(n=1, 10, 30)`
- Statistic: mean + bootstrap 95% CI (10,000 resamples)
- Visualization: heatmap fixture × mode (per n)
- Min-n rule: n < 5 → raw only, no CI

### 2.2 Quality per (fixture, mode) cell
- Primary: fixture-specific grader output (normalized 0-1)
- Secondary: jury mean (5-judge × 2 order-swaps = 10 scores per trial)
- Statistic: mean + bootstrap 95% CI
- `human_review_rate` per cell reported separately

### 2.3 Pollution per (fixture, mode) cell
- Primary: `pollution_self_rate` (this fixture's 10 facts leaked rate)
- Secondary (P-acc only): `pollution_chain_rate` (cross-fixture facts leaked)
- Statistic: mean + bootstrap 95% CI

### 2.4 Loss per (fixture, mode) cell
- Metric: `loss_rate = 1 - recall@10`
- Recall source: Stage 2 isolated session probe answers (frozen transcript replay)
- Statistic: mean + bootstrap 95% CI

### 2.5 Compact analysis
- `compact_rate` per mode (primary metric) — P-acc 예상 최고
- Per-stratum metrics (no-compact vs compact) separately
- Combined: weighted by stratum size

### 2.6 Position effect (P-acc only)
- Per-fixture × per-position cell: quality/pollution/loss by position 1-10
- Descriptive: position effect plot
- Line of best fit (monotonic? non-linear?) — descriptive, not inferential

### 2.7 Judge reliability
- Krippendorff α (10% subsample × 5 judges × rubric 5 dim)
- Target α ≥ 0.8
- α < 0.8 → M3 remediation (4th judge variant + full rescore)

## 3. Decision tree derivation (architect phase)

**Input**: HELM-style orthogonal metric table (fixture × mode × 4 metrics)
**Output**: Decision tree (fixture feature → recommended mode)

**Algorithm (pre-registered)**:
1. For each fixture, identify dominant mode per metric (argmin cost, argmax quality, argmin pollution, argmin loss)
2. Compute Pareto frontier (non-dominated across 4 metrics)
3. Fixture "winner" = Pareto frontier + 10% margin matches
4. Cluster fixtures by winner set → decision tree leaves
5. Extract fixture features (mechanical / research / context-heavy / harmful-carry) → tree branches

**Deliverable**: ADR `docs/adrs/YYYY-MM-DD-delegation-mode-decision-tree.md`

## 4. Holdout validation

**Formula** (pre-registered, from spec §4.5):
```
For each holdout fixture i:
  predicted = decision_tree(fixture_i.features)
  pareto = Pareto non-dominated modes across 4 metrics of fixture_i
  margin_match = mode m where |metric[m] - best[m]| / best[m] <= 0.10 for ALL 4 metrics
  match_i = predicted ∈ (pareto ∪ margin_match)

accuracy = Σ match_i / n_holdout_fixtures

Lock decision:
  accuracy >= 0.70 → full AGENTS.md Rule 4 policy lock
  accuracy < 0.70 → narrow scope lock "serial single-task routing only"
```

## 5. Exploratory analyses (explicitly labeled)

이 섹션에 포함되지 않은 분석은 post-hoc exploratory로 표시:
- Cross-metric correlation (pollution × loss? cost × quality?)
- Temporal drift (Week 1 vs Week 2 differences)
- Judge family agreement (Claude-Claude vs Claude-Codex vs Claude-Gemini)
- Unexpected fixture × mode interactions

모든 exploratory finding은 "탐색적" 섹션에 별도 명시 — decision tree에 반영 금지.

## 6. Reporting template

```
## Results per fixture
### F{X}
| mode | cost_marginal ($±CI) | cost_amort_30 | quality (±CI) | pollution_self (±CI) | pollution_chain (±CI, P-acc only) | loss (±CI) | compact_rate | n_valid |

## Aggregate by mode
| mode | avg_cost | avg_quality | avg_pollution_self | avg_loss | compact_rate | human_review_rate |

## Judge reliability
Krippendorff α = X.XX (target ≥ 0.8)

## Decision tree
[mermaid diagram]

## Holdout accuracy
accuracy = XX%, threshold = 70%, lock decision: [full / narrow]
```

## 7. Changes log

| Date | Change | Reason |
|---|---|---|
| 2026-04-20 | Initial v3-max.1 pre-registration | Post 3-round codex review, all fixes applied |

**Post-lock (git tag) 변경 금지**. 발견된 이슈는 exploratory note로만 기록.
