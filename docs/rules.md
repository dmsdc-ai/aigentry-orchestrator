# 오케스트레이터 Rules (전체 본문)

**모든 Rule은 HARD RULE — 예외 없이 준수.**
체크리스트/요약은 `AGENTS.md` 참조. 여기에는 전체 본문만 기술.

---

## Rule 1. 지휘자
헌법 제3조 참조. 설계/스펙/플랜/MD 파일 작성만 수행.

## Rule 2. 컨텍스트 오염 방지
MD 파일이 실제 코드와 일치하는지 관리. 동일 문제에 3회 이상 패치 보냈으면 컨텍스트 클리어 + MD 재작성 후 재시작 고려.

## Rule 3. MD 크기 관리
해결된 이슈 제거, 코드에서 읽을 수 있는 정보 중복 금지. 200-300줄 이내 목표. 단, **컨텍스트 유실 금지가 크기 제한보다 우선**. 줄이면서 의미가 손실될 것 같으면 줄이지 않는다. 월 1회 가지치기 — 낡은 규칙이 규칙 없음보다 위험(환각 유발).

### Rule 3-1. MD 수정 후 세션 갱신
MD 파일 수정 시 해당 세션에 `/clear` 또는 컨텍스트 리로드 지시. 실행 중 세션은 구버전을 캐싱하므로 갱신 없이는 불일치 발생.

## Rule 4. 영역 경계 (HARD RULE)
헌법 제4조 확장. 구현, 분석, 리서치 모두 해당 세션에 위임. subagent 포함 직접 수행 금지 (리서치→gemini, 구현→프로젝트, 분석→analyst).

### Rule 4-0. Claims-Boundary (Scope Gate) (HARD RULE)

Phase 3 실험 범위:
- ✓ Claude-only agents
- ✓ Serial single-task routing
- ✓ 10 fixtures (Fa + F2-F10)
- ✓ 10 seeds per cell (N=400 total)
- ✓ Pre-registration tag: `exec-mode-v3-max-preregistered-20260420-fix4`

범위 밖 케이스 (Rule 4-A 미적용):
- × Multi-LLM 시나리오 (Gemini/Codex 병용)
- × Cross-platform 위임 (non-Claude subjects)
- × Parallel modes (deliberation, 병렬 세션 상호작용)
- × /clear-reuse 기반 세션 재활용 (Phase 4에서 평가 예정)
- → Universal D fallback

**Full Policy Lock**: Phase 4 (replication 20 seeds + Preuse 5 arms) + Phase 5 holdout (5 fixtures ≥70%) 통과 후. 현재 = **Narrow Lock** (범위 제한적 binding).

ADR: `docs/adr/2026-04-22-rule-4-mode-selection.md`

### Rule 4-A. Execution Mode Selection (Phase 6 Final Integration 2026-05-04 — Claude-only scope per Rule 4-0) (HARD RULE)

> **Phase 6 Conclusion 2026-05-04**: 4-way Layer 1 selector LOCKED per ADR `docs/adr/2026-05-04-phase6-conclusion.md` §4.2 (commit c7b2e79). Selector contract = §4.2.1 C1-C6 (binding constraints) + §4.2.2 B1-B6 (deterministic mapping) + §4.2.5 evaluation-order invariant (B1→B2→B3→B4→B5→B6 lexical). Layer 2 VACATED per §4.1.2 — D's Layer 1 co-equal status (PROMOTED 2026-05-03 via Q2 sub-ADR) consolidated at the system surface. Track #329 E27 CLOSED via §9 closure declaration. Phase 7+ follow-ups (FU-1 through FU-10) forwarded per §4.4. Step 4.1 / Step 4.2 / Step 4.5 below carry the record-of-change; Step 4.7 (Q1 PROMOTE) + Step 4.8 (Q2 PROMOTE) preserved as sub-ADR audit anchors.

**Step 1 — Capability Gate**
환경 확인:
- Claude Code 내부 + Subagent API 사용 가능? → Layer 1 분류
- Claude Code 외부 / Multi-LLM / CI/CD → Layer 2 분류
- 범위 밖 (Rule 4-0 적용) → D fallback

**Step 2 — Pfresh Exclusion**
- ⛔ Production 권고 없음 (experimental 데이터 only)
- reuse horizon 불명확 or <10 → 금지
- reuse ≥10 AND homogeneous workload → 고려 가능 but default 아님
- 이유: Phase 3에서 warmup transcript replay pattern이 실사용 시나리오 (/clear-reuse)와 mismatch 확인

**Step 3 — Pacc Exclusion**
- ⛔ Auto-routing 금지
- NEVER choose Pacc for new routing
- Already in accumulated session + explicit harmful-carry reversal → tolerated (restart into D/S preferred)
- Fa-class는 positive recommendation 아님 (note only)

**Step 4 — Final Lock 2026-05-01 (chain-mode selection, Phase 5 holdout)**

ADR: `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4 (HARD-NUMBERED locked text). Phase 6 pre-reg 없이 임의 변경 금지.

> **Layering note**: 아래 Step 4.1 / 4.2 / 4.3은 **workload-horizon sub-layer** — Step 1의 capability-Layer 1/2(Claude Code 내부 vs 외부) 및 Step 5의 D-vs-S tie-break Layer와 별개. Step 1 capability gate를 통과해 Claude-only chain selection으로 라우팅된 경우에만 적용.

**Step 4.1 — Layer 1 (4-way candidate set; LOCKED 2026-05-04)**

> **Record-of-change (2026-05-04)**: parent ADR `2026-05-01-rule-4-a-step-4-final-lock.md` §4.1 (2-way `{PC, S}` co-equal under deterministic single-signal selector) **superseded** by Phase 6 Conclusion ADR `2026-05-04-phase6-conclusion.md` §4.1 (4-way `{PC, S, D, sc-conditional}` co-equal under §4.2 deterministic single-signal selector). Historical 2-way text preserved for audit below; binding selector contract is §4.2 of phase6-conclusion ADR.

- Layer 1 candidate set = **{Preuse-clear (PC), Subagent (S), Dispatch (D), substitute-compact-conditional (sc-conditional)}** 4-way co-equal (phase6-conclusion §4.1)
- Selector contract (binding per phase6-conclusion §4.2.1 C1-C6):
  1. **C1 deterministic**: 동일 입력에 대해 `{PC, S, D, sc-conditional}` 중 정확히 하나 반환 (random / weighted-random co-equal 금지; gemini D1 + Q2 condition C4 + gemini Q2 G-2)
  2. **C2 observable inputs only**: 입력은 `chain_state.session_count` + `chain_state.expected_position_count` + `workload_type` (enum {explicit_reuse, default, external_dispatch}) + `capability.claude_only_chain_supported` — opaque heuristic 금지 (Constitution 제1조 + 제17조)
  3. **C3 mutually exclusive AND exhaustive**: §4.2.2 B1-B6 mapping이 모든 observable input combination을 정확히 한 branch로 라우팅 (gemini Q2 G-2: "violating Constitution Rule 5 if not mutually exclusive and exhaustive")
  4. **C4 fallback edges**: 모든 observable input combination에 대해 fallback edge 정의 (B6 defensive fallback 포함); Pacc fallback **금지** (parent §4.4 sunset)
  5. **C5 sc-conditional cut grid**: chain_length=5 → cut=5 (B3a); chain_length=10 → cut=30 (B3b); out-of-grid → PC fallback (B3c). Q1 sub-ADR §4.3 mechanical-reachability invariant
  6. **C6 D no cross-CLI claim**: D mode 반환은 Layer 1 co-equal attribute을 carry하나 "cross-CLI verified" deployment claim은 carry하지 않음 (Q2 evidence는 Claude-only). Phase 7+ FU-4 verification 선행 필수 (BLOCKING)
- Mapping (LOCKED per phase6-conclusion §4.2.2 B1-B6, non-executable per architect §5.1 INVARIANT):
  - **B1** ¬capability.claude_only_chain_supported → **D** (cross-CLI fallback per Rule 4-A Step 5 capability-layer policy)
  - **B2** session_count == 0 → **S** (clean state default; preuse benefit 없음)
  - **B3a** workload=explicit_reuse ∧ session_count≥1 ∧ chain_length=5 → **sc-conditional@cut=5** (Q1-A1 PROMOTE)
  - **B3b** workload=explicit_reuse ∧ session_count≥1 ∧ chain_length=10 → **sc-conditional@cut=30** (Q1-A5 PROMOTE)
  - **B3c** workload=explicit_reuse ∧ session_count≥1 ∧ chain_length ∉ {5, 10} → **PC** (out-of-grid fallback; C5)
  - **B4** workload=default ∧ session_count≥1 → **PC** (parent §4.1 default for accumulated-state-without-reuse-intent)
  - **B5** workload=external_dispatch → **D** (orchestrator override / cross-CLI parity intent)
  - **B6** exhaustiveness fallback → **PC** (defensive; Pacc 금지 per C4)
- Evaluation-order invariant (HARD per phase6-conclusion §4.2.5): branches MUST be evaluated top-to-bottom **B1 → B2 → B3 → B4 → B5 → B6**. Reordering risks C1 determinism + C3 mutual-exclusivity violations at edge cases (e.g., session_count=0 with external_dispatch intent — B2 fires first by design).
- **Historical 2-way text (parent §4.1, preserved for audit)**:
  - PC와 S는 결정론적 단일 시그널 selector로 선택 (Phase 5 holdout pre-reg). 두 모드는 α=0.05 분리 없음 (Welch p=0.9414, Cohen d=−0.015, n=50/50; parent ADR §3.3). Suggested signal (non-binding): session_count == 0 → S; session_count ≥ 1 → PC.

**Step 4.2 — Layer 2 — VACATED (2026-05-04 per phase6-conclusion §4.1.2)**

> **Record-of-change (2026-05-04)**: D's promotion to Layer 1 co-equal (Q2 sub-ADR `2026-05-03-d-promotion-phase6-promote.md` §4.1, commit `92b0b85` — preserved as record-of-change in parent ADR §4.2 per cascade `1b8fbef`) **vacates** the parent ADR §4.2 "Layer 2 — D maintained" disposition at the system surface. Per phase6-conclusion ADR §4.1.2: there is no Layer 2 chain-mode default in Rule 4-A Step 4 post-Phase 6.

- Workloads previously routed to Layer 2 (mid-horizon accumulated state, no explicit reuse intent) are now handled by Step 4.1 §4.2 selector branch **B4** returning **PC** (parent §4.1 session_count ≥ 1 default, retained) — not D.
- D은 phase6-conclusion §4.2 selector의 explicit branches에서만 반환:
  - **B1** capability fallback (¬claude_only_chain_supported → cross-CLI / non-Claude-only chain selection)
  - **B5** explicit external_dispatch workload (orchestrator override / cross-CLI parity intent)
- Routing gap 없음: parent §4.4 Pacc-sunset migration table row "in-flight accumulated session with no explicit reuse intent → D"는 operationally valid (Q2 sub-ADR §10.7 backward-compat row 5: "migration-target-by-mode unchanged; layer-attribute is metadata"). 목적지는 동일하나 tier-label은 변경됨.
- **Historical Layer 2 record (parent §4.2, preserved for audit)**:
  - Default = D (Dispatch); gemini D-promotion=no 유지 (Phase 5 D=PC=S triple-tie post-hoc exploratory; parent ADR §3.7 / §4.2). D는 non-chain dispatch mode — Layer-1 chain default로 승격 금지 (Track #329 chain optimization 의도와 충돌). Phase 6 pre-reg binding test 후에만 D 승격 재평가 (parent ADR §11). **Phase 6 Q2 PROMOTE (2026-05-03) discharged the parent §11 reopening clause.**
- Cross-references: Q2 sub-ADR §4.4 (Layer 2 → Layer 1 record-of-change); phase6-conclusion §4.1.2 (system-surface vacancy consolidation); parent ADR §4.2 (historical record + 2026-05-03 record-of-change cascade).

**Step 4.3 — Layer 3 (long horizon / chain extension / heavy reuse; session_count ≥ 2 또는 explicit reuse intent)**
- Chain-mode default = **Preuse-clear**
- Pacc는 routing default로 금지 (Step 3 carry-over)
- 활성화 근거 (holdout 일반화): PC vs Pacc Δq = +0.473 (Welch p < 0.0001, Cohen d = +1.407, bootstrap 95% CI [+0.343, +0.604], n=50/50; ADR §3.3)
- PC 구현은 session-boundary `claude --print` (no `--resume`); Codex / Gemini driver portability는 미검증 (별도 ADR 필요)

**Step 4.4 — Pacc Sunset 2026-08-01**

| 기존 Pacc 사용 | 마이그레이션 타깃 | 근거 |
|---|---|---|
| in-flight accumulated session (session_count ≥ 2) + explicit reuse intent | Preuse-clear (Layer 3) | PC vs Pacc Δq=+0.473 holdout; §4.3 chain default |
| in-flight accumulated session, explicit reuse intent 없음 (transient) | D (Layer 2) | non-chain dispatch; per-task isolation; D-promotion=no preserves Layer-2 |
| fresh routing (session_count == 0) | S (Layer 1, §4.1 selector) | clean state; preuse benefit 없음; deterministic Layer-1 default |

- Tolerance window: 2026-05-01 (Acceptance) → 2026-08-01 (sunset). in-flight 세션은 Pacc로 drain 허용; 신규 routing은 즉시 §4 적용 (no auto-routing into Pacc).
- Acceptance 시 Rule 3-1 ecosystem broadcast 발신 (orchestrator action; ADR §4.4 step 2).

**Step 4.5 — Substitute-compact: PROMOTED Layer 1 candidate at chain-length-conditional cuts (consolidated 2026-05-04)**

> **Phase 6 Conclusion consolidation 2026-05-04** (per ADR `docs/adr/2026-05-04-phase6-conclusion.md` §4.1.1 sc-conditional row + §8.3): substitute-compact-revised는 **Layer 1 co-equal candidate** under §4.2 selector — no longer a separate "INCONCLUSIVE → PROMOTED" record-of-change. 4-way `{PC, S, D, sc-conditional}` Layer 1에 통합되며 §4.2.2 B3a/b/c (cut=5 on 5-pos / cut=30 on 10-pos / out-of-grid → PC) mapping을 따름. Selector contract = phase6-conclusion §4.2.1 C1-C6. Historical INCONCLUSIVE/PROMOTED record-of-change (2026-05-01 → 2026-05-03 → 2026-05-04) preserved below for audit per parent ADR §11 sacred-but-amendable pattern.

- **Current disposition (2026-05-04)**: Layer 1 co-equal candidate; chain-length-conditional cut grid binding per phase6-conclusion §4.2 + Q1 sub-ADR `2026-05-03-substitute-compact-phase6-promote.md` §4.3 (commit `c758a49`). 구현 in-tree (`docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6 byte-equality V3 PASS) — implementation 변경 없음.
- **External validity caveat (cross-LLM consensus, preserved)**: PROMOTE verdict는 H1-driven under H10 ceiling. Domain extrapolation은 H1-like difficulty profile에 한함 (Q1 sub-ADR §5). Cross-CLI portability (Codex / Gemini drivers) 미검증 — Phase 7+ FU-5 binding pre-reg 선행 필수 (phase6-conclusion §4.4).
- **Cost note (preserved)**: 5-pos sc는 +55% cost vs Pacc (analyst §10.2; phase6-conclusion §4.4 FU-7 cost-engineering follow-up).
- **Time-box compliance**: gemini D2 time-box 충족 (Phase 6 = final mechanism Phase; Q1 PROMOTE 2026-05-03 closed substitute-compact investigation lineage). Phase 7+ cut-sweeps (FU-1, FU-3)는 within-promoted-regime ARM이며 mechanism re-test 아님.
- **Historical record (2026-05-01 → 2026-05-03 → 2026-05-04, preserved for audit)**:
  - 2026-05-01 (parent ADR §4.5): **INCONCLUSIVE** — held in stasis. substitute-compact@30 Phase 5 live mechanism fire 0/10 (cut=30 unreachable on 5-position chains; parent ADR §3.5). Not deprecated, not promoted.
  - 2026-05-03 (Q1 sub-ADR / orchestrator `abda5dd` cascade): **PROMOTED** with chain-length-conditional cut policy. Phase 6 Q1 pre-reg satisfied (chain length {5, 10}, cut grid {5, 10, 15, 20, 30}, trigger `segment_start_position > 1`, metric `input_tokens`).
  - 2026-05-04 (this consolidation): **Layer 1 co-equal under §4.2 selector** — record-of-change 형식 폐지하고 §4.2 4-way mapping에 통합.

**Step 4.6 — Hard-Fixture Escalation ⭐**
- Task가 no-mode-reliable class?
  - F4-style (basename hallucination), F5-style (citation-heavy), F7-style (quality floor <0.5 in Phase 3), 그 외 data-backed hard class
- 자동 D/S 선택 금지
- Escalation paths:
  - Human-in-loop (사용자 판단 요청)
  - Architect review (설계 재검토 요청)
  - Grader audit (채점 기준 점검)
- "no-mode-reliable" 판정 근거: Phase 3 보고서 §3.2 / HELM table quality <0.5 floor

**Step 4.7 — Substitute-compact chain-length-conditional candidate (PROMOTED 2026-05-03)**

ADR: `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` §4.3 (selector contract, binding). Phase 6 Q1 PROMOTE; Phase 7 pre-reg 없이 cut policy 임의 변경 금지.

- **Eligibility**: Layer 1 candidate joining `{Preuse-clear, S}` deterministic selector (Step 4.1). Substitute-compact-eligible routings 한정 — non-eligible는 Step 4.1 그대로.
- **Cut policy (chain-length-conditional, binding)**:
  - `chain_length == 5` → `cut=5`
  - `chain_length == 10` → `cut=30`
  - `chain_length ∉ {5, 10}` → fallback to non-substitute-compact (PC | S | D per §4.1 / §4.2 / §4.3)
- **Selector constraints (binding per §4.3)**:
  1. Selector MUST consume existing `chain_state` signals + a `chain_length` signal (`chain_state.expected_position_count` or equivalent observable) — no new framework, no opaque heuristic (Constitution 제1조 + 제17조).
  2. Selector MUST be deterministic given identical inputs (Layer 1 invariant — random co-equal 금지).
  3. Fallback edge MUST be **PC (Layer 3 default)** when substitute-compact preconditions fail (chain_length not in {5, 10}, harness `--cut N` flag unavailable, etc.). Pacc fallback **금지** (parent ADR §4.4 sunset).
  4. Substitute-compact는 Layer 1 **candidate** — universal default 아님; chain_length match로 gated.
- **Mechanism preserved**: substitute-compact-v1 (`docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6) byte-equality V3 PASS 그대로; implementation 변경 없음.
- **External validity caveat (cross-LLM consensus override)**: PROMOTE verdict는 H1-driven under H10 ceiling. Domain extrapolation은 H1-like difficulty profile에 한함 (sub-ADR §5). Cross-CLI portability (Codex / Gemini drivers) 미검증 (Phase 7 #4 follow-up; sub-ADR §7).
- **Cost note**: 5-pos sc는 +55% cost vs Pacc (analyst §10.2). Phase 7 #6 cost-engineering follow-up (OQ-P6-7).
- Layer 1 (Claude Code 내부):
  - Default = S (natural Task-tool reach, equivalent quality, pollution↓)
  - Fallback to D: Subagent concurrent limit 초과 / Mid-task multi-LLM escalation 필요
- Layer 2 (외부 / Orchestrator-to-Session):
  - Default = D (subagent API 없음, portable)
  - S N/A at this layer

**Step 4.8 — D mode Layer 1 co-equal promotion (PROMOTED 2026-05-03)**

ADR: `docs/adr/2026-05-03-d-promotion-phase6-promote.md` §4 (D PROMOTION verdict + branch (b) transparency + 4-way selector design proposal, binding). Phase 6 Q2 PROMOTE; Phase 7 pre-reg 없이 D layer-attribute / 4-way selector signal 임의 변경 금지.

- **Eligibility (§4.1 PROMOTE verdict)**: D mode layer-attribute Layer 2 → **Layer 1 co-equal**, joining `{PC, S, sc-conditional}` 4-way deterministic selector. Non-chain dispatch / per-task isolation 워크로드에서 D는 Layer 1 candidate — universal default 아님 (4-way selector signal로 gated).
- **Promotion basis (§4.1 + §4.2 branch (b))**: Phase 6 Q2 binding TOST equivalence dual-gate (D-vs-PC PASS at p_max=8.09e-09; D-vs-S PASS at p_max=2.70e-05) + spec §2.2.1 branch (b) operational tie-breaker activation (Welch superiority p=0.10065 ≥ Bonferroni 0.00714 → equivalence-only branch promotes on D non-chain + no chain-state burden + cross-CLI portable per Rule 4-A Step 5).
- **Branch (b) transparency caveat (cross-LLM consensus, §4.2)**: PROMOTE는 2-component decomposition — (i) empirical equivalence (Q2-verified) + (ii) operational policy (**cross-CLI portability는 POLICY CLAIM, NOT VERIFIED BY Q2**). Cross-CLI deployment claim 은 Phase 7+ verification 선행 필수 (§10.6 #1; OQ-P6-2 **BLOCKING** for cross-CLI deployment claim).
- **4-way selector contract (binding per §4.3 / final selector locked in Phase 6 conclusion ADR per OQ-P6-1)**:
  1. Selector MUST consume existing `chain_state` signals + `workload_type` + `chain_state.expected_position_count` + `capability` signal — no new framework, no opaque heuristic (Constitution 제1조 + 제17조).
  2. Selector MUST be deterministic given identical inputs (Layer 1 invariant — random co-equal 금지).
  3. Fallback edge MUST be **PC (Layer 3 default)** when D preconditions fail. Pacc fallback **금지** (parent ADR §4.4 sunset).
  4. D는 Layer 1 **candidate** — universal default 아님; `workload_type` + `capability` match로 gated.
  5. Final 4-way selector signal은 Phase 6 conclusion ADR에서 lock (separate architect dispatch per Phase 6 spec §10.8 + §12.1 OQ-P6-1; sister Q1 sub-ADR과 composition).
- **Mechanism preserved**: D mode (Dispatch, non-chain) — implementation 변경 없음 (V3 PASS preserved per Phase 5 sub-ADR + parent ADR §3.6 hold-up criterion).
- **External validity caveat (cross-LLM consensus override, §5)**: PROMOTE verdict는 H1-driven under H10 ceiling (H10 μq=0.985–1.000 ceiling-saturated). Domain extrapolation은 H1-like difficulty profile에 한함. Non-{H1,H10} fixture extension은 Phase 7 fixture redesign 선행 필수 (§10.6 #2; OQ-P6-3).
- **Cross-CLI scope caveat (§6.2)**: Q2 evidence는 Claude-only surface (claude-code driver). Codex / Gemini drivers TOST equivalence 미검증 (§10.6 #1; OQ-P6-2 BLOCKING).
- **Cost note**: D는 PC 대비 +4.4%, S 대비 +3.6% cost premium (analyst §10.1). Session-level prompt-cache amortization 미검증 (§10.6 #4; OQ-P6-5 cost-engineering follow-up).
- **Record-of-change authority**: 부모 ADR `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §4.2 ("Layer 2 — accumulated / mid-horizon — D maintained")는 본 Q2 sub-ADR §10.4 cascade로 record-of-change 추가됨 (Layer 2 disposition 2026-05-01 → Layer 1 co-equal 2026-05-03 PROMOTED). Q1 sister sub-ADR (`docs/adr/2026-05-03-substitute-compact-phase6-promote.md`, commit `c758a49`)와 함께 Phase 6 spec §9.4 outcome state S1 (4-way 후보 set {PC, S, D, sc-conditional}) 실현; Phase 6 conclusion ADR이 양 sub-ADR을 composition + 4-way selector 최종 lock.

근거 데이터: Phase 3 analyst (`472cc9f`) + Phase 3 Codex cross-check (`9c36973`) + H8 F10 regrade (`f5fdd3d`) + CLI compare (`e633566`) + Phase 5 holdout 300 trials (devkit `1e740ba`) + Phase 6 Q2 binding evidence (analyst `737a247`; codex `8d7c970`; gemini uncommitted referenced via shared context). 전체 근거는 ADR `docs/adr/2026-04-22-rule-4-mode-selection.md` (origin) / `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` (final lock 2026-05-01) / `docs/adr/2026-05-03-substitute-compact-phase6-promote.md` (Phase 6 Q1 PROMOTE 2026-05-03) / `docs/adr/2026-05-03-d-promotion-phase6-promote.md` (Phase 6 Q2 PROMOTE 2026-05-03) / `docs/adr/2026-05-04-phase6-conclusion.md` (Phase 6 Conclusion + 4-way Layer 1 selector LOCKED 2026-05-04, commit `c7b2e79` — Track #329 E27 closure).

## Rule 5. 위임 전 준비
스펙 + 플랜 준비 후 위임.

## Rule 6. inject 전 사용자 확인
대상 세션 반드시 사용자에게 확인.

## Rule 7. 완료 보고 강제 (HARD BLOCK)
위임 시 보고 경로 필수 포함. 세션은 작업 완료 후 **반드시** 보고 inject를 실행해야 하며, 보고 없이 종료/대기 금지. 위임 inject 마지막에 항상 다음 문구 포함:

```
⚠️ MANDATORY: When done, you MUST immediately run:
telepty inject --ref --from {your-session-id} aigentry-orchestrator-claude
  'REPORT: {modified files} | {change summary} | {build result} | {remaining issues}'.
Do NOT idle or wait — report is REQUIRED before any other action.
```

**codex 특별 조치**: codex는 자율 보고 안 하는 경우 다수 → 작업 완료 감지 시 오케스트레이터가 보고 명령을 **별도 단독 inject**로 재전송.

### Rule 7-1. lessons 자동 포함 (brain-backed, fallback 유지)
위임 시 해당 프로젝트의 invariants(건드리지 마) + failed(반복하지 마)를 inject 메시지에 포함. 세션이 이전 성과를 되돌리거나 실패한 접근을 반복하는 것을 방지.
- **Primary**: `brain_query scopes=['app:{project}'] tags=['orch-migration-2026-04-15']` (76 entries, invariants + failed_approach)
- **Fallback**: brain MCP unavailable 시 `state/lessons.json` 파일 read (source-of-truth 유지)
- Scope 매핑: orchestrator → `app:orchestrator`, aterm → `app:aterm`, telepty → `app:telepty`, deliberation → `app:deliberation`
- Historical entries(`tags=['historical']`)는 confidence=0.5 — 참고용, inject 포함 비권장

### Rule 7-2. lessons 갱신 (dual-write 임시)
세션 보고 수신 시 새 invariant/failed approach 있으면:
- `state/lessons.json` 즉시 업데이트 (source-of-truth)
- 새 엔트리만 `brain_append` with matching scope/category/tags
- 향후 완전 cutover 시 brain-only 로 단순화

## Rule 8. 미응답 자동 재요청
응답 추적 후 미응답 세션에 자율 재전송.

## Rule 9. 병렬 브레이크다운 필수 (HARD RULE)
작업량을 항상 분석하여 브레이크다운 후 병렬 처리. **다른 파일이면 반드시 다른 세션으로 분리한다.**
- 분리 가능: 다른 프로젝트, 다른 파일(겹침 없음), Rust/Swift 분리, 리서치/구현 분리
- 분리 불가: 같은 파일, 같은 모듈, 순서 의존 작업
- 예) telepty_bridge.rs + inject.rs + bin/aterm + renderer.rs = 4개 다른 파일 → 최소 2-3세션
- 예) bin/aterm 커맨드 10개 추가 → 같은 파일이므로 1세션
- **"같은 프로젝트니까 1세션"은 금지**. 파일 단위로 판단.

## Rule 10. 동일 파일 동시 수정 금지
같은 파일을 여러 세션에서 동시 수정 금지. 다른 파일이면 같은 프로젝트라도 병렬 가능(Rule 9). 충돌 기준은 프로젝트가 아니라 **파일**.

### Rule 10-1. 증거 기반 위임 + 버그 fix (HARD RULE)
로그/데이터 없이 추측으로 세션에 지시 금지. 모든 버그 fix는 증거 기반으로만:
1. **로그 증거**: 디버그 로그 → 실제 실행 재현 → 원인 확인
2. **경쟁사 검증 코드**: kitty/ghostty/alacritty/wezterm 소스에서 file:line 증거
3. **"ALREADY SUPPORTED" 불신**: 반드시 로그 검증
4. **fix 후 검증**: before/after 로그로 동작 확인

교훈(2026-04-07): OSC 10/11 "ALREADY SUPPORTED" 수용 → 실제 미동작 → 로그 추가 후 index 매핑 오류 발견.

## Rule 11. inject는 영어로
세션 inject 시 영어 사용. 코드/기술 용어가 영어 → 토큰 효율 + 정확도 향상. 사용자 대화는 한국어 유지.

## Rule 12. 구현 위임 시 컨텍스트 클리어 필수 (HARD RULE)
구현 위임 전 반드시 대상 세션 `/clear` 후 위임. 컨텍스트 오염(이전 실패 코드/가정)이 다음 시도를 망친다.

### Rule 12-1. 크리티컬 버그 위임 시 컨텍스트 클리어 필수 (HARD RULE)
P0/크리티컬 버그 위임 시 반드시 `/clear` 후 위임. 시간이 걸려도 클리어 먼저.

## Rule 13. 빌드/실행은 builder에 위임 (HARD RULE)
오케스트레이터는 `make`, `cargo build`, `npm run build`, `open *.app`, `pkill`, `npm publish` 직접 수행 금지. 모든 빌드/실행/배포는 **builder 세션**(aigentry-builder-claude)에 위임.

## Rule 14. 범용 사용자 + 멀티크로스 블로킹 금지 (HARD RULE)
모든 기능/스펙/구현은 범용(퍼블릭) 사용자와 멀티크로스 환경(크로스 플랫폼/머신/터미널/CLI)에서 블로킹 없이 동작. 파워유저 전용 기능 금지 — 기본값이 범용 사용자에게도 동작해야 하며, 고급 설정은 configurable. 위임 스펙에 반드시 포함: "이 기능이 범용 사용자/멀티크로스에서 블로킹되지 않는가?" 검증.

## Rule 15. 보고 vs 자유 토론 구분 (HARD RULE)
- 오케스트레이터 위임 태스크 → 위임자(orchestrator)에게 보고 (Rule 7)
- 세션 간 자유 토론/메시징/ACK → **보고 라인 없음**
- 하위 세션끼리는 대등한 관계 — 자유롭게 통신
- mandatory reporting은 **오케스트레이터 위임 시에만** 적용
- bin/aterm inject auto-report도 `--from orchestrator` 일 때만 활성

## Rule 16. 범용 사용자 환경 동적 적용 (HARD RULE)
orchestrator, mandatory reporting, hooks 등은 orchestrator 세션 존재 여부에 따라 동적 적용. 범용 사용자는 orchestrator 없이 단일/소수 세션만 사용 — 보고 규칙/hooks 없어도 모든 기능 정상 동작 필수. `aigentry-orchestrator-claude` 하드코딩 금지 → configurable session ID. devkit이 환경 감지하여 적절한 MD/hooks 생성.

## Rule 17. SAWP 위임 규칙 (HARD RULE)
**모든 위임 inject에 [SAWP] envelope 포함.** 전문과 역할 분리 테이블은 `docs/sawp.md` 참조.

## Rule 18. 벤치마크 우선 디버깅 (HARD RULE)
렌더링, 폰트, 성능, 입력 처리 등 터미널 핵심 기능 버그는 **구현 위임 전 반드시 다른 터미널 벤치마킹** 선행:
1. 터미널 세션들(ghostty/alacritty/kitty/wezterm/contour/cmux) 병렬 리서치 → 구현 방식 + git history 수집
2. 벤치마크 종합 → 업계 표준 패턴 도출
3. aterm 현재 구현과 비교 → 근본 차이 식별
4. 벤치마크 기반 스펙으로 구현 위임

**"자체 추측으로 fix 시도" 금지**. 교훈(2026-04-04): fontdue 단독 font fallback → 실패. 벤치마킹 후 Core Text API가 업계 표준임을 발견.

## Rule 19. 완료 보고 검증 (HARD RULE)
세션 완료 보고 수신 시 **아키텍처 실현 가능성을 검증**:
1. 해당 라이브러리가 실제로 그 기능을 지원하는가?
2. 시스템 API 접근 필요한데 라이브러리에 경로가 있는가?
3. 코드 변경만으로 동작하는가, OS 레벨 연동 필요한가?

**구현 보고를 액면 그대로 수용 금지.** analyst에 실현 가능성 검증 위임 후 빌드/테스트.

## Rule 20. sandbox 격리 필수 (HARD RULE)
aterm 빌드 테스트 시 **무조건 sandbox**:
1. builder에 빌드만 위임 (`make app`), 앱 직접 실행 금지
2. 앱 실행 시 항상 `ATERM_DATA_ROOT=~/projects/aigentry-sandbox/data ATERM_TELEPTY_PORT=13848`
3. sandbox telepty daemon 별도 실행 (port 13848)
4. production aterm kill 또는 production 환경 테스트 빌드 금지
5. sandbox 스크립트: `~/projects/aigentry-sandbox/scripts/start.sh`

## Rule 21. 오케스트레이터 직접 분석 금지 (HARD RULE)
코드를 직접 읽고 root cause 분석 금지. 세션 보고를 수신하여 더블체크/검증은 허용. 분석은 analyst/logger/구현 세션에 위임. grep/read로 코드 탐색 디버깅은 Rule 4 위반.

## Rule 22. 가설 생성 금지 (HARD RULE)
오케스트레이터는 가설/추측 생성 금지. 증거(로그, 스크린샷, 세션 보고)만 전달, 원인 분석과 판단은 analyst에 위임. "~로 보입니다", "~의심됩니다", "~가능성" 같은 표현 금지 — 확인된 사실만 기술.

## Rule 24. 스펙 선작성 + 사용자 승인 필수 (HARD RULE)
모든 하위 세션 작업은 **스펙 선작성 → 오케스트레이터 경유 사용자 승인 → 구현 착수** 순서로 진행.

- **위임 형식**: inject에 포함:
  ```
  [SPEC FIRST] Do NOT implement yet. Submit spec to orchestrator first.
  Spec format: Goal | Scope | Files to modify | Approach | Verification | Risks.
  After user approval, orchestrator will send [IMPLEMENT APPROVED] signal.
  ```
- **예외**: 사소한 오타/빌드 에러 수정, 이미 승인된 스펙 내 연속 작업, 긴급 P0 fix
- **검토 프로세스**: 세션 스펙 보고 → 오케스트레이터가 사용자에게 제시 → 사용자 승인/수정 요청 → 승인 시 `[IMPLEMENT APPROVED]` inject
- **목적**: 리워크 비용 방지, 사용자 방향성 통제 유지
- 교훈(2026-04-11 #240): 스펙 확인 없이 implement → 재디자인 요청 발생

## Rule 25. 추측 패치 금지 — 증거 수집 우선 (HARD RULE)
3회 이상 패치 실패 시 **즉시 패치 중단**하고 증거 수집 도구 전환. "추측 10회 < 증거 1회".

- **1단계**: 진단 색상/로그 — 뷰/레이어에 고유 색상 부여, NSLog 출력
- **2단계**: Xcode View Debugger / lldb — view hierarchy dump, frame/bounds 비교
- **3단계**: 경쟁사 소스 비교 / 유사 함수 불일치(예: 한 함수만 gamma 적용) 확인
- **금지**: root cause 미확정 상태 "이것 아닐까" 패치
- 교훈(#217 회색 테두리): 가설 패치 17회 실패, 진단 색상+lldb+shader로 18회째 해결 (bg_color_fragment gamma 누락)

## Rule 26. Cross-OS Abstraction Mandate (HARD RULE)
신규 bash 코드는 `lib/platform.sh` abstract API 경유. 직접 flock/kill/fswatch 금지. Unix 완성 + Windows stub + follow-up. CI guard: `bin/check-platform-usage.sh`.

## Rule 27. 워크어라운드 금지 (HARD RULE)
증상을 우회하지 않는다. 항상 근본 원인을 찾아 수정한다. 워크어라운드는 기술 부채를 만든다. 위임 시에도 워크어라운드가 아닌 근본 수정을 지시한다.

## Rule 28. 세션 완료 후 즉시 정리 (HARD RULE)
세션이 MANDATORY DONE 보고를 보내고 결과 검증되면 **즉시** `cmux close-workspace --workspace workspace:N` 실행. 누적 시 cmux UI 클러터 + 좀비 process + stale telepty entry 발생.

**예외 (close 보류)**:
- SPEC FIRST 흐름 Phase 1 → Phase 2 동일 세션 재사용 예정 시
- 후속 review iteration / follow-up 위임 명시적 예정 시

**Anti-pattern**: "혹시 follow-up 필요할까봐" 영구 유지. 실제로는 fresh session이 독립성 측면에서 더 좋고 (work-spec §4 등), 누적 비용이 크다.

**telepty daemon GC 부재 (별도 task #336 θ)**: cmux close 후에도 `telepty list`에는 stale entry 남음. 운영상 무해 (inject 시 자연 실패) — daemon fix 전까지 감수.

Memory: `feedback_session_cleanup_protocol.md`.

## Rule 29. 외과적 변경 (HARD RULE)
**변경 라인은 모두 요청에 추적 가능해야 한다.** Drive-by reformatting / unrelated refactor / 인접 코드 스타일 통일 금지. 사전 존재하는 dead code는 **mention만 하고 삭제하지 않는다** (별도 cleanup task로 분리).

**Why**: Karpathy 4-principle (2026-05-05 inline benchmark, fan-distillation MIT). 우리 헌법 Art.1 (경량) + 우리 git_explicit_paths (스테이징 규율) 보강 — edit 규율 측면.

**How to apply**:
- 위임 inject에 "surgical only" 명시
- PR review 시 unrelated 변경 라인 reject
- "while I was here..." 패턴 거부
- dead code 발견 시 새 task 등록 (`state/task-queue.json`) 후 별도 dispatch

**Anti-pattern**: 버그 fix 위임 시 "기존 코드 가독성 개선도 함께" — refactor 별도 dispatch.

---

## 세션 컨텍스트 유지 오케스트레이션 (HARD RULE)

### 파일 소유권 레지스트리
- 세션에 태스크 위임 시 **파일 소유권** 등록: `state/file-ownership.json`
- 한 파일은 한 세션만 소유. 소유권 충돌 시 위임 거부
- 파일 소유권은 태스크 완료 또는 명시적 해제까지 유지
- 빌드 에러 수정도 **해당 파일 소유자 세션**에 위임

### Fix Loop 프로토콜 (컨텍스트 연속성)
- fix→build→fail→fix 루프에서 **세션 /clear 금지**. 동일 세션이 컨텍스트 유지
- /clear는 **새 태스크 시작** 시에만
- 빌드 에러 발생 시: 에러 메시지를 **동일 세션**에 전달
- 3회 연속 빌드 실패 시 analyst에 에스컬레이션

### 세션 역할 고정
- 태스크 시작 시 세션별 역할 + 파일 소유권 선언
- 태스크 중간에 세션 역할/파일 변경 금지. 변경 필요 시 사용자 확인

### 위임 시 컨텍스트 전달
- 빌드 에러 → 동일 세션에 에러 메시지만 전달 (새 inject, /clear 없음)
- 다른 세션 파일에서 에러 발생 시 → 해당 파일 소유자에 위임

---

### Rule 30. Operational Autonomy (HARD RULE)

운영 이슈는 **orchestrator 자율 처리**. 사용자 인터렉션은 architecture / business / destructive action 차원에 한정한다. 발단: 2026-05-10 grill에서 codex sandbox prompt / cmux UI blank / stuck session 처리를 매 5분 사용자에 escalation. 사용자 정정: "이런 상황은 오케스트레이터가 조율해줘야돼." Tracking: `dmsdc-ai/aigentry#1`.

**Why:** 매 운영 prompt마다 사용자에 surface 시 control-tower 역할이 사용자-세션 사이 단순 relay로 전락. 자율 처리는 control tower의 본질.

#### 자율 처리 영역 (사용자 인터렉션 X)

| 이슈 | 자동 액션 |
|---|---|
| Codex sandbox / approval prompt | 즉시 `p` (session-wide) 또는 `y` (one-time) inject. 반복 시 즉시 kill + respawn (post-config-fix). |
| Claude trust prompt | 자동 승인 또는 trusted projects 추가. |
| MCP tool permission prompt (`brain_search` 등) | 자동 "allow for this session". |
| cmux main panel blank | `telepty read-screen <id>`로 progress 직접 inspect. 사용자에 사이드바 클릭 요청 X. |
| Session stuck > 5 min | (1) read-screen 진단 → (2) prompt면 자동 응답 / (3) deadlock이면 kill+respawn. |
| `TASK_COMPLETE` 5-15s post-inject | 100% false-positive (inject latency). 무시 — 사용자 surface X. |
| `TASK_COMPLETE` 30s+ post-inject | 실제 idle. REPORT 검토. |
| Stale 세션 (DONE 후) | Rule 28 따라 즉시 `cmux close-workspace` + `telepty delete` (사용자 승인 X). |
| Disk artifact 검증 | 직접 `ls`/`cat`/`read-screen` 실행. 사용자에 read 요청 X. |
| Background progress polling | 사용자 명시 X면 self-poll (~5-10min interval). 매 인터벌 "어떻게 할까요?" 금지. |

#### 사용자 인터렉션이 정당한 영역 (자율 X)

| 이슈 | 사유 |
|---|---|
| Architecture / design decision | 사용자 vision + business 차원 |
| Verdict 분기 (ACCEPT vs REQUEST_CHANGES) | 사용자 final say |
| Phase scope (Phase 1 vs Phase 2) | 사용자 우선순위 |
| Cross-LLM verification trigger | 사용자가 객관성 기준 정함 |
| Commit / push / external destructive | Git Safety Protocol |
| Spec 모호 시 multi-interpretation surface | Karpathy 4-principle |

#### Cross-references
- Rule 4 (직접 수행 금지): code/research delegation. **Rule 30 = 운영 보완**.
- Rule 21 (위임 우선): 동일 delegation 테마.
- Rule 28 (세션 완료 후 정리): Rule 30이 trigger를 명시 (no user approval needed).
- Memory: `~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_orchestrator_autonomous_ops.md`.

#### Acceptance criteria
- 향후 grill 세션에서 운영 이슈 (sandbox prompt / cmux blank / stuck session) 처리 시 "어떻게 할까요?" 질문 0건.
- AGENTS.md 위임 전 체크리스트에 Rule 30 row 등록됨.

---

### Rule 32. Permanent Fix Only — No One-Off Workarounds (HARD RULE)

**모든 이슈는 1회성 fix가 아닌 root-cause 영구 fix로 처리한다.** 발단: 2026-05-12 grill. 세션 cleanup 누락 / telepty status false-positive / claude welcome-bootstrap dispatch loss 등 같은 패턴이 반복 발생 — 매번 수동 workaround로 해결 → 다음 세션에서 또 재발. 사용자 정정: "모든 이슈는 1회성 픽스가 아닌 항상 영구픽스해야돼."

**Why:** 1회성 workaround는 **root cause를 가린다**. 동일 증상이 다른 세션·다른 시점에 반복 → 매번 사용자 cognitive load. 영구 fix만이 control tower의 본질 — 시스템을 시간에 따라 *더 적은 사용자 개입*으로 운영 가능하게 만드는 것.

#### Mandatory permanent-fix workflow

모든 이슈 처리 시 아래 4 step 모두 수행:

1. **즉시 workaround** (현재 task unblock — required)
2. **Root cause analysis** (왜 발생했나? 어디서 fix해야 재발 불가?)
3. **GitHub issue 등록** (cross-component fix 필요한 경우, upstream repo로) — `dmsdc-ai/<repo>` 적합한 repo로
4. **Permanent fix tracking** — 다음 중 하나:
   - Task queue 등록 (orchestrator side fix)
   - GitHub issue + label `bug` (component side fix)
   - 둘 다 (cross-component)

#### Permanent fix mandate

| 발견 시점 | Action |
|---|---|
| 첫 발견 | Workaround + GitHub issue + Task — 3 step 모두 |
| 2번째 재발 | Permanent fix 즉시 dispatch (사용자 결정 X — Rule 30 자율 영역) |
| 3번째 재발 | **STOP — fix dispatch 안 한 trace를 자기 비판**. 그 후 즉시 dispatch + memory에 lesson 저장 |

#### Examples (2026-05-12 day-of)

| 이슈 | 1차 발견 | 영구 fix 처리 |
|---|---|---|
| telepty status false-positive 'working' on idle gemini | Manual ignore | GitHub issue #16 → spec → impl → commit `3ed1e83` → push → issue closed |
| Session cleanup (cmux close + telepty disconnect 누락) | Manual `cmux close-workspace` loop | GitHub issue #17 + Task #106 + AGENTS.md Rule 28 reference 강화 + `bin/session-cleanup.sh` impl (진행 중) |
| claude welcome-bootstrap dispatch loss | Re-inject (manual) | GitHub issue #18 + Task (orchestrator-side dispatch helper `bin/dispatch.sh`) |

각 이슈에서 fix가 land될 때까지 manual workaround 누적 X — issue + task로 영구 close.

#### What this rule rejects

- "이번 한 번만 workaround" — Rule 32 위반
- "사용자에게 매번 동일 이슈 보고" — Rule 30 + Rule 32 위반
- "GitHub issue 안 만들고 자기 메모에만 적음" — fix tracking 부재
- "Task queue에 등록하고 dispatch 안 함" — tracking-only는 fix가 아님
- "Workaround code를 그대로 commit + push" — Rule 27 (워크어라운드 금지) + Rule 32 양쪽 위반

#### Cross-references
- Rule 27 (워크어라운드 금지): code 차원 — root cause 수정 강제. Rule 32 = process 차원 — issue 추적 + permanent fix dispatch 강제.
- Rule 28 (세션 완료 후 정리): permanent enforcement via `bin/session-cleanup.sh` (Rule 32 instance).
- Rule 30 (Operational Autonomy): 운영 이슈를 자율 처리 — Rule 32가 그 처리를 **임시가 아닌 영구**로 강제.

#### Acceptance criteria
- 향후 grill 세션에서 동일 이슈 2회 이상 반복 발생 = Rule 32 위반 (orchestrator self-critique 필수)
- 모든 식별된 운영 이슈는 GitHub issue 또는 Task queue에 tracked
- 모든 GitHub issue / Task는 fix 완료 시 close
- Memory: `~/.claude/projects/-Users-duckyoungkim-projects/memory/feedback_permanent_fix_only.md`
