---
status: draft (pre-fire — pending 1300 trial completion)
date: 2026-04-26
topic: phase4-final-analysis-spec
track: "#329 E27 Phase 4 — α-step-10 (final analysis + Phase 5 decision)"
phase: spec only — execution gated on trials completing
related:
  - Phase 4 plan: docs/plans/2026-04-22-phase4-plan.md
  - Pre-reg tag: exec-mode-v4-replication-preregistered-20260426 (devkit commit 2351fa6)
  - Mid-run sanity (D-100): docs/reports/2026-04-26-phase4b-D100-midrun-sanity.md
constitution_rules: [Rule 1 경량, Rule 13 비판적+건설적+객관적]
---

# Phase 4 Final Analysis Spec — α-step-10

## §1 Goal

1300-trial dataset (4b 800 + 4c 500) 분석 → **Phase 5 holdout 진행 여부 결정** + **Rule 4-A Step 4 (Preuse activation) 결정** + **best-mode 권고**.

이 spec은 **trial 완료 후** 분석 절차를 사전 정의 — data 본 후 합리화 회피.

## §2 Inputs

- `state/exec-mode-experiment/phase4-replication/<run_idx>/<mode>/<fixture>/<seed*>/metrics.json` — 800 trials
- `state/exec-mode-experiment/phase4-preuse/<run_idx>/<mode>/<fixture>/<seed*>/metrics.json` — 500 trials
- Phase 3 reference: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md`
- Pre-reg tag annotation (scope lock)
- 미해결 anomaly (mid-run): F5 -0.18, F9 -0.11, cost 2.07× — full-n 검증 필요

## §3 Analysis Phases (sequential)

### §3.1 Phase A — Data integrity check

- 1300 metrics.json 모두 schema valid (state/schema/metrics.v1.json Draft202012)
- compact.detected count per mode (D/Pacc/Pfresh/S 0 expected — ADR §M5; Preuse-substitute-compact-Cn에서만 시점에 따라 1+ 가능)
- 누락 trial: 모든 (mode, fixture, seed) 조합 존재? Pre-reg tag scope과 매치?
- chain_state.json 무결성: segment_start_position 필드 존재 (Preuse-substitute-compact arms), Pacc는 default 1

PASS 기준: 1300/1300 schema valid, 0 누락, chain_state 일관.

### §3.2 Phase B — Quality + cost 분포 (per mode)

per-mode aggregate:
- mean / median / IQR `quality.primary`
- mean / median `cost.marginal_usd` (calibration 검증 — phase3 ratio 비교)
- mean / median `loss.rate`
- compact.detected count

per-(mode, fixture) breakdown — F5/F9 anomaly 검증

### §3.3 Phase C — Ranking 검증 (Phase 3 vs 4b replication)

질문: "Phase 4b 결과가 Phase 3 ranking을 1-rank 안에서 보존하는가?"
- Phase 3 quality ranking: D / S / Pfresh / Pacc 순서 비교
- Phase 4b 동일 ranking 비교 — 변동 ≥1 rank 시 anomaly investigation
- Effect size: S vs D quality gap 변화 <0.05 absolute (Phase 4 plan §7 success criterion 1)

### §3.4 Phase D — Preuse arm 효과 측정

per Preuse arm vs Pacc baseline (둘 다 chain mode):
- quality delta: Preuse-clear / C1-C4 mean - Pacc mean
- cost delta: same arms
- best Preuse cut: argmax(quality - λ × cost) where λ TBD §3.5
- Preuse-substitute-compact-best가 Pacc baseline을 pre-declared margin 이상 beat? (Phase 4 plan §7 criterion 2)

### §3.5 Utility 함수 사전 정의 (data 보기 전)

**중요**: 이 spec 작성 시점에 utility weights 합의. data 본 후 변경 금지.

후보:
- **U1 (quality-only)**: utility = mean(quality.primary)
- **U2 (quality-cost balanced)**: utility = quality - 0.3 × normalize(cost)
- **U3 (quality-cost-loss)**: utility = 0.6×quality - 0.3×normalize(cost) - 0.1×loss.rate

orchestrator + user 사전 합의 → spec lock. data 본 후 utility 변경하면 합리화 위험 (Rule 13 객관적).

### §3.6 Phase E — Phase 5 holdout 결정 트리

데이터 → 결정 트리 (사전 정의):

```
if Phase 4b ranking == Phase 3 (within 1 rank):
    if Preuse-substitute-compact-best > Pacc baseline (pre-declared margin):
        → Phase 5 holdout dispatch (5 fixtures × 6 modes × 10 seeds = 300 trials)
        → Rule 4-A Step 4 활성화 후보
    elif Preuse-clear > Pacc baseline:
        → Phase 5 holdout (Preuse-clear focus)
    else:
        → No Preuse activation. Pacc default 유지. ADR Superseded → Pacc 단일 lock.
else:
    → Phase 4b ranking shifted. INVESTIGATE before any decision.
    → analyst escalation: 왜 변동? sampling vs methodological.
```

## §4 Deliverables

### §4.1 Final analysis report
`docs/reports/2026-04-26-phase4-final-analysis.md` — analyst 작성, ~150-200 lines:
1. Data integrity verdict
2. Per-mode aggregate table
3. Phase 3 vs 4b ranking comparison
4. Preuse arm 효과 표
5. utility-based best mode 선정
6. F5/F9 anomaly 분석 (n=20 full)
7. Cost 2.07× 비율 원인 (compact overhead vs base latency)
8. Phase 5 결정 트리 결과

### §4.2 Decision ADR
`docs/adr/2026-XX-rule-4-a-step-4-decision.md` — architect 작성, ~80 lines:
- Rule 4-A Step 4 활성화 / 보류 / 초안수정
- 근거 (final analysis report cite)
- Phase 5 진행 여부 + 조건
- 채택 mode + 이유

### §4.3 Track #329 종료 또는 Phase 5 dispatch
- 종료: 결정 트리 "No Preuse activation" 또는 Phase 5 결과 후
- Phase 5 dispatch: separate spec + pre-reg tag (`exec-mode-v5-holdout-preregistered-YYYYMMDD`)

## §5 Failure modes

- **Trial count 부족** (< 1300): 누락 분류 + re-fire OR scope 재정의
- **Schema corruption**: 부분 dataset만 분석 가능, scope 명시
- **Phase 3 ranking 큰 차이**: methodological bug 가능, 원인 분석 → re-run vs explained-by
- **utility weight disagreement**: spec freeze 시점에 합의. data 본 후 회의는 separate ADR
- **Cost 2.07× 미설명**: 새 driver overhead, calibration 차이, 또는 데이터 corruption — 별도 분석 필수

## §6 Owner

- analyst (aigentry-analyst-* 또는 aigentry-devkit-analyst-*) — §3 + §4.1
- architect (aigentry-architect-*) — §4.2 ADR
- orchestrator + user — §3.5 utility 합의 + §4.3 final dispatch

## §7 Estimate

- §3.1-§3.4 mechanical analysis: 1-2hr
- §3.5 utility 합의: 15min orchestrator/user
- §3.6 결정 트리 적용 + ADR: 1-2hr
- 총: ~4-6hr post-trial

## §8 Out of Scope

- Phase 5 actual trial run (separate dispatch)
- Layer 2 cross-CLI extension (Phase 6+)
- Codex/Gemini portability (tracker Q2/Q4)

## §9 Open Question (사용자/orchestrator)

**OQ-A**: utility 함수 weights — U1/U2/U3 중? 또는 custom?
- 권고: **U2** (quality 70%, cost 30%) — balanced, 사용자 비용 민감도 반영. 단순.
- 결정 시점: 1300 trial 완료 직후, data 보기 직전.

**OQ-B**: Phase 4b ranking 변동 ≥1 rank 시 처리 — re-run vs explain-by?
- 권고: **explain-by 먼저** (analyst), explain 불가 시 re-run. re-run은 cost + wall 큼.

**OQ-C**: F5/F9 anomaly 임계 — 어느 정도 차이부터 "real signal"?
- 권고: |delta| ≥ 0.10 + n=20 full 후 t-test p<0.05.
