# Agent Execution Mode Comparison — Experiment Design Spec (v3-max.1)

**Date**: 2026-04-20 (v3-max.1)
**Task**: #329 (Track E27)
**Status**: APPROVE_WITH_FIXES from 3rd review applied. Gemini AI Pro 가입으로 3-family jury 업그레이드. Ready for pre-registration + builder.
**Prior**:
- v1 (archived) — codex REQUEST_REVISION (4 crit + 4 high + 3 med)
- v2 (archived) — codex independent REQUEST_REVISION (3 new crit + 4 new high + 4 med, 0/4 fixes sound)
- v3-max — descriptive stats 전환, 주요 structural fix 적용 → 3rd codex review APPROVE_WITH_FIXES (3 crit + 3 high + 3 med)
- **v3-max.1** — 3rd review 9 fixes 전부 반영 + Gemini 2.5 Pro 추가로 3-family jury

**Review artifacts**:
- `docs/reviews/2026-04-20-codex-experiment-spec.md`
- `docs/reviews/2026-04-20-codex-fixtures-strengthen.md`
- `docs/reviews/2026-04-20-codex-experiment-spec-v2-independent.md`
- `docs/reviews/2026-04-20-codex-experiment-spec-v3-max-independent.md`

**Pre-registration artifacts**:
- `docs/superpowers/analysis-plan/2026-04-20-exec-mode-analysis.md` (분석 계획 lock)
- `fixtures/exec-mode-experiment/canonical_briefing.md` (D/S briefing 템플릿)
- `fixtures/exec-mode-experiment/warmup_transcript.md` (P-fresh replay 템플릿)

**User constraints**:
- Claude-only 테스트 대상 (4 모드 전부 Claude CLI)
- Codex + Gemini는 review/judgment에만 사용 (2026-04-20 Gemini AI Pro 가입 확정 — 3-family jury 가능)
- CLI 전용 (직접 API 호출 금지)
- 비용 제한 없음 — 정확도 최우선

---

## 1. Goal

aigentry 에코시스템에서 **"어떤 작업을 어떤 실행 모드로 위임해야 하는가"**를 정량 데이터 기반으로 판단할 기준을 수립한다. 결과물은 AGENTS.md의 **위임 결정 트리** + ADR이다.

**중요**: 통계 유의성 검정(pass/fail)은 수행하지 않는다. **서술 통계(descriptive stats) + bootstrap 95% CI**로 측정값을 제시하고, architect 세션이 이를 해석하여 결정 트리를 도출한다.

## 2. Motivation

**실측 근거 (2026-04-20 세션)**:
- A-aterm-claude (새 세션 + byte-identical 복사) → ~20,000 tokens (96% overhead)
- Orchestrator 직접 수행 → ~800 tokens
- **25배 토큰 차이** (동일 결과)

Rule 4 (영역 경계)의 일률 적용이 거대한 비효율을 낳거나, 반대로 무시 시 domain pollution. **threshold 수식화**가 아키텍처 결정의 핵심.

사용자 요구: **"정확한 테스트 결과가 필요해 — 에이전트리 방향성 정확히 정할 수 있어"**

## 3. Scope

### In scope
- **4 실행 모드** (전부 Claude CLI)
- **10 fixtures** (aigentry 실운영 시나리오 + 학술 엄밀성)
- **30 seeds per cell** (variance 1/5.5)
- **10 planted facts per fixture** (pollution + loss 해상도 최대)
- **4 orthogonal metrics** (cost, quality, pollution, loss — HELM 원칙)
- **2-replication test-retest** (temporal stability)

### Out of scope
- Multi-LLM 모드 **as test subject** (Gemini/Codex는 judge/grader로만, 테스트 대상 X)
- Cross-platform (macOS Sonoma 25+ 고정)
- Parallel multi-agent / deliberation / hook modes
- Batch/scheduled modes
- API 직접 호출 (CLI 전용 — claude, codex, gemini CLI)

## 4. Experimental Design

### 4.1 Modes (4 — all Claude CLI)

| Mode | Setup per trial | Pre-state delivery | Teardown |
|---|---|---|---|
| **D** (Dynamic) | 매 trial `open-session.sh --track T --name mode-D-F$fix-S$seed ...` 로 새 `claude` 세션 | Canonical transcript을 **briefing artifact raw**로 prompt에 첨부 (요약 금지 — H1 리뷰 대응) | `session-cleanup.sh` |
| **P-fresh** (Persistent-fresh) | 매 seed마다 새 세션 + `[WARMUP]...[/WARMUP]` canonical transcript **replay as turns** | Warmup을 실제 turn history로 재현 | `session-cleanup.sh` |
| **P-accumulated** (Persistent-누적 — Z design) | **30 independent sessions**, 각 session이 **10 fixtures 랜덤 순서로 1회씩** 처리 (§4.4 balanced) | Natural accumulation — 이전 fixture 처리로 자연 누적 | 실험 종료 시 |
| **S** (Subagent) | 매 trial Task 도구로 `general-purpose` subagent dispatch | Canonical transcript을 briefing artifact raw로 전달 | 자동 |

**C1 해결**: D/S의 briefing artifact는 **summary 금지, 원시 turn-delimited transcript**. P-fresh의 replay도 동일 turn 구조. 구조적 차이 최소화.

**C2/Critical 2 해결 (P-acc = natural accumulation)**: 30 sessions, 각 session이 10 fixtures를 **다른 랜덤 순서**로 처리 → 각 fixture가 session 내 position 1~10에 분산 (§4.4). Same-fixture rehearsal 문제 해소.

**2-stage protocol** (v3-max.1 fix, v3-max review Crit 1/2 대응):
- Stage 1 (task execution): 모든 모드가 fixture task만 수행. Post-task probe는 이 stage에서 절대 inject 안 함
- Stage 2 (probe evaluation): Stage 1 완료 후 **별도 isolated Claude CLI 세션**에 해당 trial의 session transcript + probe questions 주입 → 답변 수집
- S 모드도 동일: Task 도구 호출 1회(task만) + 별도 CLI 호출(transcript replay + probes)
- P-accumulated 원본 세션은 probes 없이 다음 fixture로 continue → Z design natural accumulation 보존

### 4.2 Fixtures (10, 각각 **10 planted facts + 10 probes** embedded)

**공통 구조** — 각 fixture 디렉토리:
```
fixtures/exec-mode-experiment/F{X}/
├── setup_history.md       # prior turns + 10 planted facts (분산 삽입)
├── task_prompt.md          # 실제 작업 요청
├── post_probes.md           # 10 loss-측정 질문 (planted facts 순서 셔플)
├── ground_truth.json        # primary grader 기준
├── planted_facts.json       # 10 facts [{keyword, sentence, embed_variants}] — pollution Layer A+B
└── probe_answers.json       # 10 loss 정답
```

#### Cluster 1 — Fresh-context / Bounded-scope (2)

| # | 이름 | Setup | Task | Primary Grader | 예상 우위 |
|:-:|---|---|---|---|:-:|
| **F4** | 구조 매핑 + 시각화 | `fixtures/miniproj/` (코드 snapshot) + 10 planted facts in prior turns | "SW 구조 Mermaid 3+ 다이어그램 + 파일 인벤토리 + FFI 경계" | **Oracle graph score** (entity + edge matching, hallucinated node penalty, file anchor 필수) | **D/S** |
| **F10** | Compact 후 resume | 5턴 작업 + 의도적 불완전 `.context-snapshot.md` + stale-decoy tasks + 10 planted facts | "Snapshot 기반 작업 계속 (stale 거절)" | **Hidden unresolved checklist** 적용률 + stale rejection rate | **D** |

#### Cluster 2 — Independent / Research (2)

| # | 이름 | Setup | Task | Primary Grader | 예상 우위 |
|:-:|---|---|---|---|:-:|
| **F3** | 독립 블라인드 리뷰 | diff + hidden issue IDs + **plausible-but-correct distractor lines** + 10 facts | "Crit/high/med issues + file:line + verdict" | **Severity-weighted F1** (issue ID matching, false-positive penalty, distractor 감지 금지) | **S** |
| **F5** | 외부 리서치 + 인용 | 토픽 X (날짜/버전 sensitive) + 10 facts in context | "1000-1500 word + ≥5 primary source 인용" | **URL liveness** + primary source quota + **claim-citation 3 spot check** | **S** |

#### Cluster 3 — Context-heavy / Iterative (5)

| # | 이름 | Setup | Task | Primary Grader | 예상 우위 |
|:-:|---|---|---|---|:-:|
| **F2** | MD 슬림 제안 | 타깃 MD + **hidden invariants checklist** + 과거 failed attempt 1건 + 10 facts | "슬림 제안 + old→new mapping table" | **Invariants preservation rate** (regex substring per invariant) | **P-누적** |
| **F6** | Fix-loop (sequential reveal) | Build 에러 파일. **에러는 sequential 1건씩 공개** (fix 제출 후 다음 에러) + 10 facts 분산 | "Build pass까지 iterate (max 10 turns)" | Build pass (binary) + **turns-to-success** (낮을수록 좋음) | **P-누적** |
| **F7** | 결정 전파 + **semantic masking** | 8-10 turns — 여러 유사 결정 (예: `Result<T,E>` / `Either` / `Option`), **후반 turn이 전 결정 supersede** + 10 facts | "최신 승인된 패턴을 artifact X에 적용 + 결정 turn 인용 (패턴명 미명시)" | **Latest-decision correctness** + superseded rejection + citation-to-turn | **P-누적** |
| **F8** | Multi-file refactor | `fixtures/ingest/*.ts` 중복 validation + **hidden regression tests** + 10 facts | "중복 통합, public behavior 보존, 기존+hidden test 통과" | Known + hidden test pass + **duplication reduction** structural metric + test edit penalty | **P-누적** |
| **F9** | Prior turn 디버그 (multiple causes) | `parseConfig()` + **3+ plausible root causes** 본체에 (현 파일만 보면 모호) + setup history에 유일한 원인 단서 + 10 facts | "retries 안 되는 버그 디버그" | **Exact root cause match** + correct fix | **P-누적** |

#### Harmful Carry-over Probe (1)

| # | 이름 | Setup | Task | Primary Grader | 예상 우위 |
|:-:|---|---|---|---|:-:|
| **Fa** | False Prior Override | 3-4 turns에 **그럴듯하지만 틀린 prior** ("library X cannot do Y"). 후속 turn에 evidence 있는 reversal + 10 unrelated facts | "current truth 적용 — 어느 prior가 stale인지 미언급" | **Binary false-prior leak** (0=좋음) + task correctness + citation-to-reversal | **D/S** |

**F1 Drop**: byte-copy smoke test는 mode 변별력 0 — codex 리뷰 판정대로 제거.

### 4.3 Seeds

- **30 seeds per (fixture, mode)**.
- Claude temperature default 1.0. Seed = replication index (결정성 없음).
- **Pilot gate**: 첫 10 seeds 완료 후 variance 분석 → 나머지 20 seeds 진행 결정.

### 4.4 Randomization (blocked, H3 fix)

**Flat global shuffle은 P-acc sequential semantics와 모순 → blocked randomization으로 대체**.

**P-accumulated (Z design, Critical 2 fix)**:
- **30 independent sessions** (session 1~30)
- 각 session: 10 fixtures 랜덤 순서 (`random.shuffle(fixtures, seed=session_idx)`)
- **Balanced position**: fixture × position 조합 평균 3회 (30 sessions × 10 positions / 10 fixtures = 3)
- **Position as covariate**: 각 trial에 `position_in_chain` (1~10) 메타데이터 기록

**D / P-fresh / S**:
- 각 mode 10 fixtures × 30 seeds = 300 trials
- **Flat shuffle** (single-trial semantics, 순서 독립)
- RNG seed=42 고정, `run_order_D.csv` + `run_order_Pfresh.csv` + `run_order_S.csv` pre-commit

**Random seed 고정**:
- Python `random.Random(42).shuffle(...)` 결정론
- `run_order_pacc.csv` + 3 fast-order.csv 모두 pre-registration 시 commit

### 4.5 Holdout protocol (H4 strengthened + accuracy formula pre-registered)

**최소 기준 (pre-declared)**:
- **Minimum 5 fixtures** from independent source (not this experiment's 10)
- **Selection rule**: 다음 sprint (2 weeks)의 aigentry 실제 작업 중 각 cluster에서 최소 1개씩 (C1/C2/C3)
- **Fallback**: sprint 자연 발생이 부족하면 **historical git log**에서 유사 작업 sampling
- Holdout 실행 → dev-set-derived decision tree 적용 → **예측 정확도 ≥ 70%** 시에만 AGENTS.md Rule 4 lock
- < 70% → decision tree 보수적으로 narrow (예: "serial single-task routing only")

**예측 정확도 공식** (v3-max.1 fix, v3-max review High 2 대응):
```
For each holdout fixture i:
  predicted_best_mode_i = decision_tree.recommend(fixture_i.features)
  
  observed_per_metric = {
    cost:      argmin_m(cost_i[m]),
    quality:   argmax_m(quality_i[m]),
    pollution: argmin_m(pollution_i[m]),
    loss:      argmin_m(loss_i[m])
  }
  
  pareto_frontier_i = Pareto non-dominated modes across 4 metrics
  
  margin_match_i = mode m such that:
    |metric[m] - best_metric| / best_metric <= 0.10 for ALL 4 metrics
  
  match_i = predicted_best_mode_i ∈ (pareto_frontier_i ∪ margin_match_i)

accuracy = count(match_i == True) / n_holdout_fixtures
```

- **Tie handling**: 10% margin (within 10% of best metric) = acceptable match
- **Compacted holdout**: trial이 compact 발생 시 해당 fixture는 accuracy 계산 제외 + 별도 compact-adjusted accuracy 보고
- **Lock threshold**: accuracy ≥ 0.70 → full Rule 4 policy lock. < 0.70 → narrow scope lock (single-task serial only)

## 5. Metric Definitions

### 5.1 Cost — CLI-only parsing

**Source**: `~/.claude/projects/{proj}/{sid}.jsonl` (CLI가 생성하는 로그, API 불요)

**4-bucket × Anthropic Sonnet 4.6 pricing**:
```
Cost_marginal_$ = (3.0·I + 3.75·CW5 + 6.0·CW1h + 0.30·CR + 15.0·O) / 1M
Cost_amortized_$(n) = Cost_marginal + (Warmup_cost / n), for n ∈ {1, 10, 30}
```

**Sensitivity analysis** (Medium 1 fix): amortization을 n=1/10/30 세 포인트 모두 보고. 단일 horizon 고정 X.

**Subagent**: `subagents/agent-*.jsonl` 별도 파싱. Nested subagent spawn 감지 시 recursive roll-up (Medium 3 fix).

**Compact detection**: 연속 turn 간 `cache_read_input_tokens` > 50% drop + next message의 `input_tokens` spike → flag. Compact 발생 trial은 **primary report에 포함** + `compact_detected=true` 마킹 (Critical 3 fix).

### 5.2 Quality — 3-layer triangulation (H1 fix)

**Layer 1 (Primary — per-fixture task-specific)** — §4.2 Primary Grader 컬럼:
- F2: invariants preservation rate (regex)
- F3: severity-weighted F1 on issue IDs
- F4: oracle graph score
- F5: URL liveness + source quota + claim-citation (3 spot checks via Claude CLI)
- F6: build pass + turns-to-success
- F7: latest-decision + superseded rejection + citation
- F8: hidden test pass + duplication reduction
- F9: root cause exact match + fix correctness (LLM-judge via Claude CLI)
- F10: unresolved checklist + stale rejection
- Fa: binary leak + task correctness + citation

**Layer 2 (Secondary — 5-judge jury, 3 families — v3-max.1 upgrade after Gemini AI Pro 가입)**:
- J1-J3: `claude --print` CLI (3 different system prompts + randomized order swap)
- J4: `codex task ...` CLI (1 prompt)
- J5: `gemini` CLI (Gemini 2.5 Pro, 1 prompt)
- **3 families = Anthropic + OpenAI + Google** — Verga et al. 2024 "disjoint model families" 완전 부합
- Rubric: 0-5 × 5 criteria (correctness / completeness / efficiency / edge-case / style)
- **Order swap**: 각 judge가 "A first" + "B first" 두 번 평가 → 평균
- **Output length cap**: 2048 tokens 초과 시 truncated + `length_capped=true` flag (verbosity bias 제거)

**Layer 3 (Disagreement flag + adjudication)**:
- `|Primary_normalized - Jury_mean|` > 0.5 → `human_review=true` flag
- Primary score 유지, 별도 보고
- **Adjudication owner** (v3-max.1 fix, v3-max review High 3 대응): `aigentry-analyst` 세션이 dispute 케이스를 review하여 최종 판정. Orchestrator는 case transport + final verdict 적용만 (Rule 21 준수)

**Inter-rater reliability (judges J1-J5 only)**:
- **Krippendorff α** (post-hoc 10% subsample)
- α < 0.8 시 **4th judge variant 추가 생성 후 전 trial 재평가** (earlier scores 폐기, M3 fix)

### 5.3 Pollution — 10 facts × dual detection (β, C4 fix)

**각 fixture setup에 10 planted facts** (§4.2 `planted_facts.json`):
```json
[
  {"id": "F2_fact1", "keyword": "Xenon", "sentence": "current project: Project Xenon (deadline 2026-05-15)", "paraphrase_examples": ["the Xenon effort", "our Xenon work"]},
  ...
]
```

**Dual detection per trial (primary = Layer A, fallback = Layer B via Codex/Gemini)**:
- **Layer A (deterministic)**: Python regex substring search for each `keyword` + `paraphrase_examples` in trial output
- **Layer B (semantic via cross-family CLI — v3-max.1 fix for self-bias High 1)**:
  - Layer A가 모호 (regex miss but paraphrase 의심) 시만 발동
  - **Dual cross-family**: Codex CLI **AND** Gemini CLI 둘 다 평가 → 둘 다 "leaked" 시 positive. 1개만 positive는 "uncertain" 표시 + analyst review queue
  - Claude는 자기 output 판단 안 함 (self-bias 완전 회피)
  - Batched prompt:
    ```
    Here is the agent output: [OUTPUT]
    For each of the following 10 facts, answer 1 (leaked semantically) or 0 (not mentioned/paraphrased):
    ...
    Answer JSON: {"fact1": 0/1, ...}
    ```

**Leakage per fact = Layer A hit OR Layer B (Codex) confirms**

**Per-trial pollution** (2개 metric 분리, v3-max.1 fix for v3-max Crit 3):
- `Pollution_self` = Σ leaks on THIS fixture's 10 facts / 10 (current planning)
- `Pollution_chain` (P-acc only) = Σ leaks on all prior fixtures' facts in session / total_prior_facts (cross-fixture bleed 측정)
- Report both orthogonally — primary = `Pollution_self`, secondary = `Pollution_chain`

Paraphrased leakage 포착 + chain-level cross-contamination 명시 측정.

### 5.4 Loss — frozen transcript replay protocol (v3-max.1 fix for v3-max Crit 1/2)

**각 trial 완료 후 별도 isolated CLI 세션에서 probe evaluation**:

**Protocol (모든 모드 동일 2-stage)**:
1. **Stage 1 (task execution)**: 본 모드 세션에서 fixture task 실행 → task output + full transcript (JSONL 추출) 저장. **Probe 질문 inject 금지**.
2. **Stage 2 (probe evaluation)**: **별도 fresh `claude --print` CLI 세션** spawn:
   - Input: Stage 1의 transcript (turn-delimited) + post-probe questions (§4.2 `post_probes.md`, 10 questions)
   - Prompt: "Here is a conversation history: [TRANSCRIPT]. Based solely on information in this history, answer these questions: Q1: ... Q10: ..."
   - Output: 10 probe answers
3. 원본 모드 세션(특히 P-accumulated)은 Stage 2 결과와 무관하게 다음 fixture로 continue → Z design 보존

**S 모드**: 동일 2-stage. Task 도구 호출 1회 (task만) → 별도 Claude CLI 호출 1회 (transcript replay + probes).

**Probe ordering**: probe 10개는 trial마다 `random.shuffle(seed=trial_idx)` 랜덤화 (order effect 제거).

**Detection** (3-layer, self-bias 제거):
- **Layer A (exact)**: string exact match on probe answer keyword
- **Layer B (fuzzy)**: Levenshtein ratio > 0.8 (Python `rapidfuzz`, CLI-only)
- **Layer C (semantic fallback — dual cross-family)**: Layer A + B 실패 시 **Codex + Gemini CLI 모두** (Claude 자기 판단 회피, v3-max review High 1 대응):
  ```
  Q: ...? Expected: "Project Xenon". Got: "[agent_answer]".
  Correct? 1/0
  ```
  - Codex AND Gemini 둘 다 "correct" → recall=1
  - 한쪽만 correct → `uncertain` 플래그 + analyst review queue
  - 둘 다 incorrect → recall=0

**Loss per probe = 1 - (Layer A ∨ B ∨ C recall)**
**Loss_rate_per_trial = 1 - (Σ recalls / 10)**
**Loss_rate_per_cell = mean(30) + bootstrap 95% CI**

**중요**: probe 질문은 Stage 2 isolated 세션에만 존재. Stage 1 (production) session에는 절대 노출 안 됨. 모든 모드 동일 평가 조건.

`Recall = Layer A OR B OR C == 1`
`Loss_rate_per_trial = 1 - (Σ recalls / 10)`
`Loss_rate_per_cell = mean(30) + bootstrap 95% CI`

**중요**: pollution용 planted_fact와 loss probe의 needle은 **동일**. 1 fact → 2 metric 동시.

### 5.5 Embedding backend

**DROPPED** (API 제약). Voyage/OpenAI embedding 미사용.
Pollution Layer B는 Claude CLI semantic check로 대체 (§5.3).

### 5.6 Reporting — bootstrap CI, HELM orthogonal

모든 metric **orthogonal 보고**. 단일 composite 금지.

**Bootstrap 95% CI per cell**:
- 각 cell (fixture, mode)의 30 trials → bootstrap resampling 10,000회
- 2.5% / 97.5% percentile = 95% CI

**Primary reporting table**:

| fixture | mode | cost_marginal $ (μ [95% CI]) | cost_amort_30 $ | quality (μ [95% CI]) | pollution (μ [95% CI]) | loss (μ [95% CI]) | compact_rate | n_valid | n_compact_stratum |
|---|---|---|---|---|---|---|---|---|---|

**Derived (secondary)**:
```
efficiency = quality / cost_marginal
continuity = 1 - 0.5·pollution - 0.5·loss (weights pre-registered)
```

## 6. Statistical Output

**통계 유의성 검정 미실시** (사용자 지침). Architect 세션이 bootstrap CI + HELM table 보고 해석하여 decision tree 도출.

- **Descriptive stats only**: 평균 ± bootstrap 95% CI per cell
- **Variance monitoring**: pilot (10 seeds) 후 CV (coefficient of variation) 점검. CV > 50% cell은 seeds 확대 검토
- **Visualization**: fixture × mode heatmap per metric (4 heatmaps)
- **Sensitivity analysis** (Medium 1 fix): cost_amort n=1/10/30 모두 plot

## 7. Measurement Infrastructure (CLI-only)

### 7.1 Harness (`bin/exec-mode-experiment.sh`)

**Contract**:
```
IN:  fixture_id, mode, seed_idx, session_idx (P-acc only), position_in_chain (P-acc only), run_idx
OUT: metrics.json
```

**Per-trial steps (v3-max.1 2-stage protocol)**:
1. **Stage 1 setup**
   - D/S: fresh session spawn / Task tool ready
   - P-fresh: new session + warmup replay (inject `[WARMUP]...[/WARMUP]` turns)
   - P-acc: existing session at position k (prior k-1 fixtures already processed)
2. **Stage 1 execute**: inject task via telepty (session modes) or Task tool (S). Report-driven wait.
3. **Stage 1 capture**: save task output + full transcript (jsonl extract for this trial window)
4. **Stage 1 parse**: collect jsonl usage buckets → cost_marginal_$, cost_amort_n=1/10/30
5. **Stage 1 primary grader**: run fixture-specific Python grader on task output → quality_primary
6. **Stage 1 Layer A detection**: regex on task output for pollution (10 facts); P-acc only: also chain-level facts
7. **Stage 2 probe session (isolated)**: spawn fresh `claude --print` with `[TRANSCRIPT from Stage 1] + [10 randomized probe questions]` → collect answers
8. **Stage 2 loss detection**: Layer A exact match → Layer B fuzzy → Layer C Codex fallback for ambiguous
9. **Compact detection** (whole trial): `cache_read_input_tokens > 50% drop + next input_tokens > 2× avg` → `compact_detected=true`
10. **Queue Layer B pollution** (Codex cross-family) for ambiguous regex cases, **Jury evaluation** for ambiguous primary quality
11. Emit `metrics.json` with all fields (§5 schema)

**Retry policy (v3-max.1 fix Medium 3)**:
- Per-call timeout: **30s** (CLI subprocess)
- Max retries: **3** per call
- Rate limit detection: HTTP 429 or "rate_limit" in stderr → cool-off **60s** then retry
- Exhausted retries → mark trial as `failed`, exclude from primary analysis, log for rerun decision
- Timeout policy: individual call timeout separate from total trial timeout (total = 15min cap per trial)

### 7.2 Grader (`bin/exec-mode-grader.py`)

- Python 3.14 stdlib + `rapidfuzz` (fuzzy match, pure-Python)
- **NO anthropic SDK / openai SDK / voyage SDK** (CLI 제약)
- LLM calls via `subprocess.run(['claude', '--print', ...])` / `subprocess.run(['codex', 'task', ...])`
- Batch calls:
  - Pollution Layer B: 10 facts × 200 trials × 2 replications = 4000 trial × 10 = **40,000 fact checks** batched 10-per-call → **4,000 CLI calls** (claude)
  - Jury: 5 judges × ~60% of trials (primary unambiguous 제외) = **~7,200 CLI calls** (3 claude + 2 codex)
- Rate limit handling: `--max-budget-usd` 안 쓰고 retry loop with exponential backoff

### 7.3 Analysis (`bin/exec-mode-analyze.py`)

- Python stdlib + `pandas` + `scipy.stats` (bootstrap만, hypothesis test X)
- metrics.json × 2,400 → DataFrame
- Bootstrap CI per (fixture, mode, metric) cell
- HELM-style table + heatmap (`matplotlib`)
- Position effect analysis for P-acc (ANOVA-style descriptive, not inferential)
- Output: `report/v3-max-results-{replication}.md` + `report/heatmaps/*.png` + `report/data.csv`

### 7.4 Fixtures data

```
fixtures/exec-mode-experiment/
├── F2/ ... F10/ Fa/
│   ├── setup_history.md
│   ├── task_prompt.md
│   ├── post_probes.md
│   ├── ground_truth.json
│   ├── planted_facts.json   (10 facts)
│   └── probe_answers.json   (10 answers)
├── canonical_briefing.md     (shared boilerplate for D/S briefing artifact)
├── warmup_transcript.md      (shared boilerplate for P-fresh replay)
└── run_orders/
    ├── run_order_D.csv        (300 trials × rep)
    ├── run_order_Pfresh.csv
    ├── run_order_Pacc.csv     (30 sessions × 10 fixtures)
    └── run_order_S.csv
```

### 7.5 Pre-registration (Critical 7 preserved + signed hash)

**Before execution**:
1. v3-max spec commit finalize
2. `bin/exec-mode-generate-order.py` run → `run_orders/*.csv` all fixed
3. Analysis plan commit (`docs/superpowers/analysis-plan/2026-04-20-exec-mode-analysis.md`)
4. All fixtures commit (grading criteria locked)
5. **git tag** `exec-mode-v3-max-preregistered-$(date +%Y%m%d)` → hash recorded
6. Orchestrator repo에 공지 post (commit hash 명시)

**After execution**:
- Analysis는 pre-registered plan만 따름
- 탐색적 finding은 별도 섹션에 명시 (honest reporting)

## 8. Compact event handling (Critical 3 fix + min-n rule)

- **Pre-registered detection**: `cache_read_input_tokens > 50% drop` AND `next_input_tokens > 2x avg` → `compact_detected=true`
- **Primary report에 포함** (exclude 금지). Stratum 구분:
  - `n_valid_nocompact`: compact 없이 완료한 trial 수
  - `n_compact_stratum`: compact 발생 trial 수 + 별도 cost/quality/pollution/loss 보고
- **Mode별 compact rate** 별도 table:
  - P-acc에서 높을 것 예상 → **이게 persistent session의 실제 약점 증거** (filtering 금지)

**Min-n rule for CI validity (v3-max.1 fix Medium 2)**:
- **`n ≥ 5`** in a stratum → bootstrap 95% CI 계산 가능
- **`n < 5`** → raw values + count만 표시, CI 생략 + `low_n_warning=true` flag
- Compact stratum의 n이 0인 cell: 해당 cell "no compact observed" 명시
- Combined 분석 (no-compact + compact strata): weighted average 시 compact stratum 가중치 = n_compact / n_total

## 9. Delegation Plan

| Phase | Session | Scope |
|---|---|---|
| **P0 Spec v3-max** | orchestrator (이 세션) | 이 문서 작성 + commit + 태스크큐 #330/#331/#332 업데이트 |
| **P1 Pre-reg** | orchestrator | Analysis plan + fixture 최종 + git tag |
| **P2 Harness build** | 신규 `E-harness-builder` (builder 세션) | §7 인프라 전체. TDD. |
| **P3 Pilot (10 seeds, Week 1)** | builder 세션 | 10 × 4 × 10 = 400 trials. Variance + CV 체크 → scale 결정 |
| **P4 Full Week 1 (20 more seeds)** | builder 세션 | 20 × 4 × 10 = 800 추가 trials |
| **P5 Full Week 2 (replication)** | builder 세션 (2주 후) | 30 × 4 × 10 = 1,200 replication trials |
| **P6 Analysis** | `aigentry-analyst` 세션 | Bootstrap CI, HELM table, heatmap, compact rate, judge agreement (Krippendorff α) |
| **P7 Decision tree ADR** | `aigentry-architect` 세션 | Analyst findings → decision tree + Rule 4 refinement ADR |
| **P8 Holdout** | orchestrator coordination (sprint 2) | 5 holdout fixtures 수집 + 예측 정확도 측정 |
| **P9 AGENTS.md 편입** | orchestrator | ADR + holdout ≥ 70% 시 lock. < 70% 시 narrow scope lock |

**Rule 21 compliance**: Analyst/Architect가 판단, orchestrator는 **delegation + 최종 편입**만. Ambiguous findings 시 analyst → architect → orchestrator 순차 escalation.

## 10. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| 200K context cap → P-acc 강제 compact | §8 stratum 분리 + primary report에 포함 |
| Judge 동종 편향 (2 family) | J1-J3 Claude + J4-J5 Codex. Krippendorff α 모니터. < 0.8 시 4th judge variant |
| CLI overhead (no API) | Batch 호출 최대한 (Layer B pollution 10-fact per call, jury batch) |
| Subagent nested accounting | Recursive jsonl roll-up 구현 (smoke test in pilot) |
| Fixture convenience bias | Holdout protocol §4.5 + 5 minimum unseen fixtures |
| Claude 비결정성 | N=30 seeds로 variance 정량화 |
| Position effect in P-acc | 30 sessions balanced (position × fixture 평균 3회) + position 공변량 기록 |
| Judge panel cost (~7,200 CLI calls) | 1 family (Claude + Codex) CLI overhead 있지만 total 예산 $1,500 범위 |
| Replication 시간차 (Week 1 vs Week 2) | API/모델 업데이트는 log에 기록, differential 분석 |

## 11. Acceptance Criteria

- **2 replications × 1,200 trials = 2,400 trials** 완료 (pilot 400 + full Week 1 800 + Week 2 1,200)
- **4 metrics 모두** per (fixture, mode) cell 측정 + bootstrap 95% CI
- **Compact rate** per mode 공개 보고 (exclude 안 됨)
- **Krippendorff α ≥ 0.8** (judge reliability); α < 0.8 시 remediation 수행
- **Human review flag** < 15% of quality scores
- **Decision tree ADR** 작성 (architect)
- **Holdout** ≥ 5 fixtures, 예측 정확도 보고
- Holdout ≥ 70% accuracy → AGENTS.md Rule 4 **일반 lock**
- Holdout < 70% → **serial single-task routing only** narrow lock

## 12. References

**Aigentry**:
- Task #329 state/task-queue.json
- `docs/reviews/2026-04-20-codex-experiment-spec.md`
- `docs/reviews/2026-04-20-codex-fixtures-strengthen.md`
- `docs/reviews/2026-04-20-codex-experiment-spec-v2-independent.md`
- `docs/rules.md` Rule 4, 10-1, 14, 21, 22, 24, 27
- Dustcraw research: `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md` (33 sources)

**External**:
- HELM — arXiv 2211.09110
- LongMemEval — arXiv 2410.10813
- LoCoMo — arXiv 2402.17753
- Shi & Penn 2025 Semantic Masking — aclanthology.org/2025.wraicogs-1.2/
- Zheng 2023 LLM-as-Judge — NeurIPS 2023
- Verga 2024 Jury — arXiv 2404.18796
- Anthropic Prompt Caching — platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenReview E2RyjrBMVZ — Quantifying Variance
- Deng 2024 Contamination — arXiv 2311.09783
- GSM1k NeurIPS 2024 — data contamination precedent
- Krippendorff α — Appen docs
