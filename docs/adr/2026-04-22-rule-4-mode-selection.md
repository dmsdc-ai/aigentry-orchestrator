# ADR 2026-04-22: Rule 4 Mode Selection — Claims-Boundary (4-0) + Execution Mode Selection (4-A)

- **Status**: Accepted (activated 2026-04-26 via commits `d9a3f81` + `0f77906`)
- **Date**: 2026-04-23 (Proposed) / 2026-04-26 (Accepted)
- **Deciders**: orchestrator (aigentry-orchestrator-claude), Codex (deliberation participant), Gemini (deliberation participant), architect (E-architect-rule4)
- **Tracking**: #329 Track E27 — exec-mode Phase 3 → rule 4 formalization
- **Scope tag**: Narrow Lock (binds only within Rule 4-0 experimental scope; Full Policy Lock pending Phase 4 replication + Phase 5 holdout)

---

## 1. Context

### 1.1 Why now

Phase 3 of the execution mode comparison experiment produced the first data set where routing decisions could be grounded in measured quality rather than intuition. The orchestrator entered Phase 3 with an implicit S-priority posture (Task-tool as default), but the data — together with the Gemini v0.38.2 `/clear` semantics discovery and Codex's capability-gap analysis — forced a rewrite.

Without a codified rule, three concrete failure modes keep recurring:

1. Orchestrator routes hard fixtures (F4 basename-hallucination class, F5 citation-heavy, F7 quality floor) as if they were routable at all, burning budget on modes that no Phase 3 mode rescued.
2. Sessions pick up Pacc (accumulated context) as a "works fine so far" default, which Phase 3 flagged as carrying hidden pollution that degrades adjacent tasks.
3. Layer 2 (cross-CLI, CI/CD, orchestrator→session) borrows Layer 1 assumptions (subagent available, Task tool reach) even though those capabilities do not exist outside Claude Code.

### 1.2 Inputs synthesized

| Input | Path | Commit |
|---|---|---|
| Phase 3 analyst report (HELM table + v1 decision tree draft + Pacc decay + F10 RCA) | `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md` | `472cc9f` |
| Phase 3 Codex cross-check | `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3-codex.md` | `9c36973` |
| H8 F10 regrade (label pattern fix) | `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-h8-f10-regrade.md` | `f5fdd3d` |
| CLI /clear & /compact comparison (3-way) | `~/projects/aigentry-orchestrator/docs/research/2026-04-21-cli-context-reset-compare.md` | `e633566` |
| User-facing pilot summary | `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-user-summary.md` | `ceb90a6` |
| Experiment spec v3-max.1 | `~/projects/aigentry-orchestrator/docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md` | — |
| Constitution (governance) | `~/projects/aigentry/docs/CONSTITUTION.md` | — |

### 1.3 Deliberation path (3 rounds)

- **Round 1** — Gemini (shared `45b3a126…`) and Codex (shared `5ad8b69a…`) challenged the S-priority proposal from different angles: Gemini on cross-everything portability, Codex on capability-gap and Pacc risk.
- **Round 2** — Codex (shared `dbe31b08…`) formalized six asks (scope gate, Pacc hard exclusion, Pfresh narrow/experimental, D portable Layer 2 default, Narrow Lock, holdout dependency). Gemini (shared `40b20c75…`) accepted §2 cross-everything via Layer 2 D and scope gate but rejected §16 Pacc preservation + soft-gate (reason: non-enforceable; D/S + context-packing cover the same surface). Codex's Round 2 frame prevailed.
- **Round 3** — Gemini APPROVE (shared `8761c8f4…`). Codex MODIFY (shared `a9cb2aab…`) requested a **Step 4.5 Hard-Fixture Escalation** node, citing F4/F5/F7 quality-floor evidence. Accepted and integrated.
- **Orchestrator** revised its S-priority original down to *Layer 1 only — S default* (Round 2 consensus).
- **User** resolved 7 ambiguous points (documented in orchestrator turn log; summary in §3 Decision).

---

## 2. Decision

Apply Rule 4-0 and Rule 4-A verbatim to the orchestrator rule set (`docs/rules.md`) with AGENTS.md cross-references. Both rules are **HARD RULE** under Constitution Article 5 (최선) and Article 9 (독립).

### 2.1 Rule 4-0: Claims-Boundary (Scope Gate)

```
Rule 4-0: Claims-Boundary (Scope Gate)
───────────────────────────────────────
Phase 3 실험 범위:
  ✓ Claude-only agents
  ✓ Serial single-task routing
  ✓ 10 fixtures (Fa + F2-F10)
  ✓ 10 seeds per cell (N=400 total)
  ✓ Pre-registration tag: exec-mode-v3-max-preregistered-20260420-fix4

범위 밖 케이스 (rule 4-A 미적용):
  × Multi-LLM 시나리오 (Gemini/Codex 병용)
  × Cross-platform 위임 (non-Claude subjects)
  × Parallel modes (deliberation, 병렬 세션 상호작용)
  × /clear-reuse 기반 세션 재활용 (Phase 4에서 평가 예정)
  → Universal D fallback

Full Policy Lock: Phase 4 (replication 20 seeds + Preuse 5 arms)
                  + Phase 5 holdout (5 fixtures ≥70%) 통과 후.
                  현재 = Narrow Lock (범위 제한적 binding).
```

### 2.2 Rule 4-A: Execution Mode Selection (Narrow Lock)

```
Step 1 — Capability Gate
  환경 확인:
  - Claude Code 내부 + Subagent API 사용 가능? → Layer 1 분류
  - Claude Code 외부 / Multi-LLM / CI/CD → Layer 2 분류
  - 범위 밖 (Rule 4-0 적용) → D fallback

Step 2 — Pfresh Exclusion
  ⛔ Production 권고 없음 (experimental 데이터 only)
  - reuse horizon 불명확 or <10 → 금지
  - reuse ≥10 AND homogeneous workload → 고려 가능 but default 아님
  - 이유: Phase 3에서 warmup transcript replay pattern이
         실사용 시나리오 (/clear-reuse)와 mismatch 확인

Step 3 — Pacc Exclusion
  ⛔ Auto-routing 금지
  - NEVER choose Pacc for new routing
  - Already in accumulated session + explicit harmful-carry reversal:
    → tolerated (restart into D/S preferred)
  - Fa-class는 positive recommendation 아님 (note only)

Step 4 — Preuse Selection (Phase 4 LOCK 후 활성화)
  세션 재활용이 필요한가?
  - Task 경계 reset → Preuse-clear
  - Context threshold 기반 → Preuse-compact (threshold Phase 4 데이터 기반 확정)
  - (Phase 4 이전에는 Step 4.5로 바로 진행)

Step 4.5 — Hard-Fixture Escalation ⭐
  Task가 no-mode-reliable class?
  - F4-style (basename hallucination), F5-style (citation-heavy),
    F7-style (quality floor <0.5 in Phase 3), 그 외 data-backed hard class
  - 자동 D/S 선택 금지
  - Escalation paths:
    * Human-in-loop (사용자 판단 요청)
    * Architect review (설계 재검토 요청)
    * Grader audit (채점 기준 점검)
  - "no-mode-reliable" 판정 근거: Phase 3 보고서 §3.2 / HELM table quality <0.5 floor

Step 5 — D vs S Tie-break (routable tasks only)
  Layer 1 (Claude Code 내부):
    Default = S (natural Task-tool reach, equivalent quality, pollution↓)
    Fallback to D:
      - Subagent concurrent limit 초과
      - Mid-task multi-LLM escalation 필요
  Layer 2 (외부 / Orchestrator-to-Session):
    Default = D (subagent API 없음, portable)
    S N/A at this layer

Checklist 추가 (AGENTS.md 위임 전 체크리스트):
  [ ] Mode 선택 근거 확인 (Rule 4-A)
  [ ] Rule 4-0 scope boundary 통과 확인
  [ ] Pacc 사용 회피 (tolerated note만 허용)
  [ ] Pfresh 선택 시 explicit justification (n≥10 증거)
  [ ] Preuse 선택 시 Phase 4 lock 상태 확인
  [ ] Hard-fixture (F4/F5/F7-style) escalation 경로 확보
```

### 2.3 User-resolved ambiguities (Round 2–3)

| # | Question | Resolution |
|---|---|---|
| 1 | Narrow vs Full Lock naming | Adopt "Narrow Lock" now, promote to "Full Policy Lock" after Phase 4+5 |
| 2 | Pacc tolerance window | Limit to in-flight accumulated sessions with explicit harmful-carry reversal; restart into D/S preferred |
| 3 | Pfresh language | "Production 권고 없음" + experimental-only guidance, n≥10 justification gate |
| 4 | Preuse activation | Gated on Phase 4 lock; Step 4.5 is the pre-Phase-4 bypass |
| 5 | Fa treatment | Note-only, not a positive recommendation |
| 6 | Layer 2 S availability | Explicit "N/A at this layer" in Step 5 |
| 7 | Hard-fixture evidence source | Cite Phase 3 report §3.2 and HELM table <0.5 floor |

### 2.4 Rejected deliberation positions

- **§16 Pacc preservation + soft gate (Orchestrator original)** — rejected in Round 2 (Gemini + Codex concurred). Reason: soft gate is not enforceable in practice; D/S + intentional context-packing already cover the same need without the hidden-carry risk.

---

## 3. Consequences

### 3.1 Positive

- **Bounded claims**: Rule 4-0 prevents "phase 3 says X" over-reach. Outside the declared scope, policy collapses to Universal D fallback — a safe, portable default.
- **Hard-fixture escape hatch**: Step 4.5 stops the orchestrator from auto-routing tasks that Phase 3 showed no mode rescues. Escalation paths (human, architect, grader) replace false-confidence routing.
- **Layer-aware defaults**: Layer 1 S / Layer 2 D eliminates the "Layer 1 assumption bleed" into cross-CLI contexts. Subagent API presence is the discriminator, not the habit.
- **Pacc auto-routing banned**: Clear, enforceable stance eliminates the quiet-degradation class of bugs the Pacc decay RCA (472cc9f §3.3) documented.
- **Checklist integration**: Six new AGENTS.md checklist items force rule application per delegation, not once-a-quarter memory.

### 3.2 Negative

- **Policy complexity**: Rule 4 grows from one line to two rules with six steps plus a checklist. Mitigation: summary block in AGENTS.md, full body in `docs/rules.md` (current MD-size discipline — Rule 3).
- **Pfresh chilling effect**: Production ban may under-use a mode that is strong on homogeneous workloads. Mitigation: experimental doorway (n≥10 + justification) retained.
- **Step 4.5 churn**: Hard-fixture escalation increases human-in-loop touches until graders and fixtures are rebuilt. Mitigation: Phase 4 reduces this class via grader audit + new fixtures; Phase 5 holdout validates.
- **Narrow Lock ambiguity for non-Claude code paths**: Multi-LLM/CI scenarios now explicitly fall back to D — some teams may read this as "do nothing." Mitigation: Universal D fallback is an active default, not a stub; documented in Rule 4-0.

### 3.3 Risks

- **Risk R1 — Phase 4 may invalidate Narrow Lock.** If replication (N=800) shows S/D equivalence does not hold on wider seed distribution, Layer 1 default flips. *Mitigation*: Phase 4 plan pre-registration allows planned update to this ADR without re-deliberation.
- **Risk R2 — Step 4.5 definition drift.** "no-mode-reliable class" is anchored to Phase 3 evidence; future fixtures may need a running criterion. *Mitigation*: tracker Q5-related criteria + Phase 4 holdout §2 will publish a threshold.
- **Risk R3 — Pacc tolerance loophole.** "already in accumulated session + explicit reversal" may be read as a permanent carve-out. *Mitigation*: wording emphasizes "restart into D/S preferred"; Rule 4-A Step 3 is auditable in checklist.
- **Risk R4 — Q3 (Gemini /clear) version pin drift.** Behavior is confirmed at v0.38.2. Later versions may diverge. *Mitigation*: tracker Q3 carries version pin; re-test on Gemini version bump.

---

## 4. Alternatives considered

| Alternative | Position | Why rejected |
|---|---|---|
| **A1. S-priority universal** (orchestrator Round 1) | S default across all layers | Layer 2 has no Task tool — non-portable. Rejected Round 2 by Codex capability-gap analysis. |
| **A2. D universal-strict** (Gemini Round 1 implicit) | D default everywhere, no S option | Ignores Layer 1 pollution-reduction data (Phase 3 §3.1). Over-rotates to portability at cost of measured quality. |
| **A3. Explicit Fa exception carve-out** | Named exception for Fa class promoting Pacc | Fa-class data is weak signal; elevating it to rule would invert "Pacc auto-routing forbidden". Gemini Round 2 reduced Fa to note-only — consistent with final. |
| **A4. §16 Pacc preservation + soft gate** (orchestrator Round 2 residual) | Keep Pacc with soft gate warnings | Non-enforceable. Gemini + Codex both rejected Round 2. Replaced with hard exclusion + narrow tolerance. |
| **A5. Defer until Phase 4** | No rule now, ship after replication | Phase 3 failure modes are active today. Narrow Lock blocks them immediately while leaving Full Lock open for Phase 4/5. |

---

## 5. Scope

- **Narrow Lock** — current status. Binding within Rule 4-0 experimental scope (Claude-only, serial, 10 fixtures, 10 seeds, preregistered tag `exec-mode-v3-max-preregistered-20260420-fix4`). Outside scope → Universal D fallback.
- **Full Policy Lock** — promotion criteria:
  - Phase 4 replication (D/S/Pfresh/Pacc × 20 seeds × 10 fixtures = 800 trials) confirms Phase 3 rankings.
  - Phase 4 Preuse evaluation (Preuse-clear + Preuse-compact × 4 thresholds = 500 trials) returns threshold estimate.
  - Phase 5 holdout (5 new fixtures × 6 modes × 10 seeds) reaches ≥70% accuracy.
  - Pre-registration under new tag (TBD after Phase 4).

Full Policy Lock promotion will be a **revision** to this ADR (Status: Proposed → Accepted, then Revised) rather than a new ADR, unless the decision changes materially.

---

## 6. Open Questions

See `docs/research/open-questions-tracker.md` for the canonical list. Top four summarized here:

- **Q1 — Claude auto-compact exact threshold.** Phase 4 Preuse-compact plan needs a measured threshold; currently inferred from dustcraw CLI compare report. Resolution in Phase 4 empirical test.
- **Q2 — Codex `threshold_tokens` × `context_window` interaction.** Cross-CLI portability of Preuse-compact depends on a uniform token-accounting primitive. Resolution: follow-up experiment after Phase 4.
- **Q5 — Partial compaction (Claude-only).** Tension with Rule 4-0 §2 cross-everything: a Claude-only optimization that is not portable to Layer 2. Must decide whether Preuse-compact stays Layer 1 only.
- **Q7 — Auto-compact disablement per CLI.** Determines whether operators can hold runs at a fixed context size for reproducibility in Phase 4. Resolution: dustcraw survey + per-CLI flag audit.

Q3 (Gemini /clear semantics) is **resolved** at v0.38.2 — see tracker. Supersedes dustcraw report 2026-04-21-cli-context-reset-compare.md §gemini "display-only" claim.

---

## 7. Evidence

### 7.1 Data & reports

- Phase 3 analyst — commit `472cc9f` (aigentry-devkit) — HELM quality table, v1 decision tree draft, Pacc decay RCA, F10 RCA.
- Phase 3 Codex cross-check — commit `9c36973` (aigentry-devkit).
- H8 F10 regrade — commit `f5fdd3d` (aigentry-devkit) — `## (a)` label pattern deep-fix.
- CLI /clear + /compact 3-way compare — commit `e633566` (this repo, `docs/research/2026-04-21-cli-context-reset-compare.md`).
- User-facing pilot summary — commit `ceb90a6` (aigentry-devkit).

### 7.2 Specifications

- Experiment design v3-max.1 — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md`.
- Constitution — `~/projects/aigentry/docs/CONSTITUTION.md` (Art. 3 역할, Art. 5 최선, Art. 9 독립 governing).

### 7.3 Deliberation transcripts (shared store)

| Round | Participant | Shared hash |
|---|---|---|
| R1 | Gemini | `~/.telepty/shared/45b3a126355a9440e8baccbe62cef3259d542eacc8cbcc5432f8f607f5e6ae24.md` |
| R1 | Codex | `~/.telepty/shared/5ad8b69a145bdbd43714508689e50280babe7779d1c6eb3c909bf4611e26e17f.md` |
| R2 | Gemini | `~/.telepty/shared/40b20c75af4deac314bb6ab2d4e1d84d6f3d4f9b3669b031053bcc249b08121c.md` |
| R2 | Codex | `~/.telepty/shared/dbe31b08ac8cd33be13794d2839b9fc373345d71273bd966f0eb28e5468591f9.md` |
| R3 | Gemini (APPROVE) | `~/.telepty/shared/8761c8f4e299bf81d8043fc2600136f67fa841bd3969c2d28a762e40ce10eb48.md` |
| R3 | Codex (MODIFY — Step 4.5) | `~/.telepty/shared/a9cb2aab4eab415fd470f3d9e0abff540c648a6fb528d7eb20e7c66f9e6e051e.md` |

### 7.4 Pre-registration

- Tag: `exec-mode-v3-max-preregistered-20260420-fix4`
- Applies to Phase 3 scope only; Phase 4 re-preregistration required before Full Policy Lock.

---

## 8. Adoption

- **Proposed**: 2026-04-23 (architect session E-architect-rule4).
- **Accepted**: 2026-04-26 — orchestrator (`aigentry-orchestrator`) + user approval, activation broadcast issued.
- **Activation commits**:
  - `d9a3f81` — `AGENTS.md` checklist + ADR reference (16 → 22 items).
  - `0f77906` — `docs/rules.md` Rule 4-0 + Rule 4-A body inserted between Rule 4 and Rule 5 (252 lines, within Rule 3 size guideline).
- **Post-acceptance follow-ups**:
  1. ✅ AGENTS.md patch applied.
  2. ✅ docs/rules.md Rule 4-0 + Rule 4-A body inserted.
  3. ✅ Broadcast `/clear` advisory issued to active sessions (Rule 3-1).
  4. ☐ Phase 4 kickoff per `docs/plans/2026-04-22-phase4-plan.md` — owner TBD at runner-claim time.
- **Status transitions**: Proposed → **Accepted** (current) → (post-Phase 4/5) Revised (Full Policy Lock) *or* Superseded (if data invalidates).
