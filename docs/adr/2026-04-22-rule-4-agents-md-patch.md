# Patch Draft — AGENTS.md + docs/rules.md for Rule 4-0 / Rule 4-A

**Status**: DRAFT (not yet applied). Applies only after orchestrator + user approval of ADR `2026-04-22-rule-4-mode-selection.md`.

**Scope**: this patch touches two files:

- `AGENTS.md` — checklist expansion + ADR reference.
- `docs/rules.md` — Rule 4-0 and Rule 4-A body insertion between Rule 4 and Rule 5.

The architect does not apply these changes (Rule 10 file ownership). Orchestrator executes after approval.

---

## 1. Patch — `AGENTS.md`

### 1.1 Replace block: "위임 전 체크리스트 (매번 확인 — HARD RULE)"

**Current (lines 5–24)** — 15 checklist items. **Proposed** — 15 existing + 6 new Rule 4-A items, grouped under a subheading so callers can tell they are execution-mode specific.

#### Unified diff (conceptual)

```diff
 ## 위임 전 체크리스트 (매번 확인 — HARD RULE)

 매 위임 전 아래를 반드시 확인한다. 하나라도 위반 시 중단하고 수정.

 - [ ] **직접 수행 금지** (Rule 4, 21): 리서치/구현/분석을 subagent 포함 직접 하지 않는가? → 해당 세션에 위임
 - [ ] **사용자 확인** (Rule 6): inject 대상 세션을 사용자에게 확인했는가?
 - [ ] **파일별 세션 분리** (Rule 9, 10): 다른 파일 태스크를 하나의 세션에 묶지 않았는가?
 - [ ] **보고 MANDATORY 포함** (Rule 7): 위임 inject에 보고 문구가 있는가?
 - [ ] **lessons 포함** (Rule 7-1): invariants + failed를 inject에 포함했는가?
 - [ ] **범용/크로스 블로킹 없음** (Rule 14): 범용 사용자 + 멀티크로스 블로킹 안 되는가?
 - [ ] **증거 기반** (Rule 10-1, 22, 25): 로그/데이터 없이 추측으로 위임하지 않았는가?
 - [ ] **영어 inject** (Rule 11): 세션 inject가 영어인가?
 - [ ] **SAWP envelope 포함** (Rule 17): 위임 inject에 `[SAWP]` 워크플로우 지시가 있는가?
 - [ ] **스펙 선작성 + 사용자 승인** (Rule 24): "implement 금지, 스펙 먼저" 지시가 있는가?
 - [ ] **컨텍스트 클리어** (Rule 12, 12-1): 구현/P0 위임 전 `/clear` 실행했는가?
 - [ ] **빌드/실행 builder 위임** (Rule 13): 직접 빌드/실행/배포 하지 않는가?
 - [ ] **Cross-OS abstraction** (Rule 26): bash 신규 코드가 `lib/platform.sh` 경유하는가?
 - [ ] **워크어라운드 금지** (Rule 27): 증상 우회가 아닌 근본 원인 수정 지시인가?
 - [ ] **보고 vs 토론 구분** (Rule 15): 위임 보고 라인인가, 자유 토론인가?
 - [ ] **세션 ID 하드코딩 금지** (Rule 16): `aigentry-orchestrator-claude` 하드코딩 피하고 configurable로?
+
+### 실행 모드 체크 (Rule 4-A — Narrow Lock, Phase 3 데이터 기반)
+
+- [ ] **Mode 선택 근거** (Rule 4-A): 선택한 execution mode 근거를 기록했는가?
+- [ ] **Rule 4-0 scope 통과** (Rule 4-0): 태스크가 Phase 3 scope 밖이면 Universal D fallback 적용했는가?
+- [ ] **Pacc 회피** (Rule 4-A Step 3): Pacc auto-routing 없이, accumulated session 연속 시에도 D/S 재시작이 우선 아닌가?
+- [ ] **Pfresh justification** (Rule 4-A Step 2): Pfresh 선택 시 reuse horizon ≥10 + homogeneous workload 증거가 있는가?
+- [ ] **Preuse Phase 4 lock** (Rule 4-A Step 4): Preuse 선택 시 Phase 4 lock 상태 확인했는가? (lock 이전이면 Step 4.5로 우회)
+- [ ] **Hard-fixture escalation** (Rule 4-A Step 4.5): F4/F5/F7-style no-mode-reliable task는 human / architect / grader 경로로 escalation했는가?

 > **Rule 본문 전체**: `docs/rules.md`
 > **SAWP envelope + 역할 분리 테이블**: `docs/sawp.md`
 > **aterm 렌더링 교훈 + 세션 통신**: `../aigentry-aterm/aterm-context.md` (sibling repo)
 > **헌법 원본**: `../aigentry/docs/CONSTITUTION.md` (sibling repo)
+> **Rule 4 ADR (2026-04-22)**: `docs/adr/2026-04-22-rule-4-mode-selection.md`
```

### 1.2 No other AGENTS.md sections change

- "워크플로우", "응답 원칙", "위임 명령어", "병렬 위임 시 Deliberation 경유", "위임 inject 필수 포함 (요약)", "dustcraw 태스크 피드 (필수)", "CLI별 역할 분담", "전담 세션 역할", "에코시스템" sections are untouched by this patch.
- AGENTS.md stays slim per Rule 3 (MD 크기 관리).

---

## 2. Patch — `docs/rules.md`

### 2.1 Insert Rule 4-0 and Rule 4-A between current Rule 4 and Rule 5

**Insertion point**: after line 21 (`Rule 4` body), before line 23 (`## Rule 5. 위임 전 준비`).

#### Insert block (verbatim Rule 4-0 + Rule 4-A from ADR §2)

```markdown
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

### Rule 4-A. Execution Mode Selection (Narrow Lock) (HARD RULE)

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

**Step 4 — Preuse Selection (Phase 4 LOCK 후 활성화)**
- Task 경계 reset → Preuse-clear
- Context threshold 기반 → Preuse-compact (threshold Phase 4 데이터 기반 확정)
- Phase 4 이전에는 Step 4.5로 바로 진행

**Step 4.5 — Hard-Fixture Escalation ⭐**
- Task가 no-mode-reliable class?
  - F4-style (basename hallucination), F5-style (citation-heavy), F7-style (quality floor <0.5 in Phase 3), 그 외 data-backed hard class
- 자동 D/S 선택 금지
- Escalation paths:
  - Human-in-loop (사용자 판단 요청)
  - Architect review (설계 재검토 요청)
  - Grader audit (채점 기준 점검)
- "no-mode-reliable" 판정 근거: Phase 3 보고서 §3.2 / HELM table quality <0.5 floor

**Step 5 — D vs S Tie-break (routable tasks only)**
- Layer 1 (Claude Code 내부):
  - Default = S (natural Task-tool reach, equivalent quality, pollution↓)
  - Fallback to D: Subagent concurrent limit 초과 / Mid-task multi-LLM escalation 필요
- Layer 2 (외부 / Orchestrator-to-Session):
  - Default = D (subagent API 없음, portable)
  - S N/A at this layer

근거 데이터: Phase 3 analyst (`472cc9f`) + Phase 3 Codex cross-check (`9c36973`) + H8 F10 regrade (`f5fdd3d`) + CLI compare (`e633566`). 전체 근거는 ADR `docs/adr/2026-04-22-rule-4-mode-selection.md`.
```

### 2.2 docs/rules.md Rule 4 original text — unchanged

Rule 4 (line 20–21) remains as-is:

```
## Rule 4. 영역 경계 (HARD RULE)
헌법 제4조 확장. 구현, 분석, 리서치 모두 해당 세션에 위임. subagent 포함 직접 수행 금지 (리서치→gemini, 구현→프로젝트, 분석→analyst).
```

Rule 4-0 / 4-A are narrower technical rules under the same Article 4 umbrella. Renumbering existing Rule 5+ is **not** performed (decimal sub-numbering preserves stable references).

---

## 3. Apply procedure (for orchestrator)

Sequential, explicit-path commits (Rule 10 + feedback_git_explicit_paths):

```bash
# 1. AGENTS.md patch
git add AGENTS.md
git commit -m "docs(orchestrator): add Rule 4-A checklist items + ADR reference (#329)"

# 2. docs/rules.md patch
git add docs/rules.md
git commit -m "docs(rules): insert Rule 4-0 Claims-Boundary + Rule 4-A Mode Selection (#329)"

# 3. Broadcast /clear advisory (Rule 3-1)
telepty broadcast "Rule 4-0 + Rule 4-A activated. /clear and re-read AGENTS.md + docs/rules.md before next delegation."
```

Do **not** amend; create new commits per Claude Code convention.

---

## 4. Verification

Post-apply checklist (orchestrator):

- [ ] `grep -n "Rule 4-0" AGENTS.md docs/rules.md` returns hits in both.
- [ ] `grep -n "Rule 4-A" AGENTS.md docs/rules.md` returns hits in both.
- [ ] `grep -n "2026-04-22-rule-4-mode-selection" AGENTS.md` returns the ADR reference line.
- [ ] Checklist item count in AGENTS.md 위임 전 체크리스트 = 15 original + 6 new Rule 4-A items.
- [ ] `docs/rules.md` line count within Rule 3 MD-size guidance (≤ ~300 lines preferred; hard cap: no semantic loss).
- [ ] Broadcast acknowledged by all active sessions (optional — Rule 3-1 advisory).

---

## 5. Rollback

If Phase 4 replication (see `docs/plans/2026-04-22-phase4-plan.md`) invalidates the Layer 1 S default or the Pacc exclusion, the rollback is:

1. Revert the two commits from §3.
2. Mark ADR Status: **Superseded**.
3. Open a new ADR citing the Phase 4 data that triggered the rollback.

Partial rollback (e.g., adjusting Step 4.5 criteria) is a **revision** to the ADR, not a rollback — apply via a follow-up patch draft.
