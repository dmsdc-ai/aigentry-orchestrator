# Rule 4 Amendment — Capability-Gated Spawn (DRAFT)

**Status:** DRAFT — text only. **Do NOT merge into `docs/rules.md` or `AGENTS.md` until #103 (Permission Manager) commits.**
**Authority:** ADR `2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.6 (L1 tree recursion + Permission Manager) + §4.6.1 (capability ↔ CLI adapter table) + §4.6.2 (default role → capability table).
**Tracking:** ADR-MF Migration §6 Task #2 (this draft) · #103 (Permission Manager impl, blocker for land) · #99 (SessionContext gates G1-G6 impl).
**Scope guard:** Article 13 — critical / constructive / objective. User lock F11 preserved: no depth / fan-out / lifetime quotas introduced.

---

## Section 1 — Proposed Rule 4 (post-amendment full prose)

> ### Rule 4. 영역 경계 + Capability-Gated Spawn (HARD RULE)
>
> 헌법 제4조 확장. 본 Rule은 **두 축**으로 작동한다:
>
> **(A) 직접 수행 금지 (preserved — Rule 4 origin).**
> 오케스트레이터 세션은 코드 수정 / 분석 / 리서치를 **직접 수행하지 않는다**. 모든 작업은 해당 역할 세션에 위임 (리서치→researcher/gemini, 구현→implementer/coder, 분석→analyst, 빌드→builder per Rule 13, 로깅→logger). `subagent` (L2 Agent tool) 포함 직접 수행 금지는 오케스트레이터 surface에 한해 유효하다.
>
> **(B) Capability-Gated Spawn (NEW — ADR-MF §4.6).**
> 세션 간 **spawn 권한**은 더 이상 "오케스트레이터인가" 여부로 결정되지 않는다. `SessionContext.permissions`에 담긴 **capability** (§4.6.1 adapter table)에 의해 게이팅된다.
>
> - **L1 child spawn (`spawn_l1`)**: 어떤 L1 세션이든 `spawn_l1` capability를 보유하면 자식 L1 세션 (= grandchild from orchestrator perspective) 을 spawn 할 수 있다. 단:
>   - (i) 자식의 role이 부모의 `spawn_l1` 권한 범위 내 role-subset에 포함되어야 한다 (§4.6.2 default role → capability table 기준; Permission Manager가 enforce).
>   - (ii) `child.permissions ⊆ parent.permissions` (SessionContext gate G5; capability monotonicity, ADR §4.6 gemini R1 finding 1 — WASI/seL4 capability-based security alignment).
>   - (iii) Cycle prevention: spawn 시점에 `parent_session_id` chain을 walk 하여 proposed child의 `session_id`가 활성 chain에 존재하면 reject (ADR §4.6 + §4.8 persistence protocol index lock 통한 strongly-consistent active-session read).
> - **`spawn_l1` capability 없는 세션**: spawn-leaf (= L1 grandchild 생성 불가). 추가 작업이 필요하면 orchestrator 또는 capability-bearing parent에 escalation.
> - **L2 spawn (`spawn_l2`)**: 세션 내부 Agent tool (Class B) 호출. 부모의 `spawn_l2` capability로 게이팅. 오케스트레이터는 자신 또는 위임 대상 세션의 role-별 default capability를 통해 `spawn_l2`를 비활성화할 수 있다 (§4.6.1 Claude adapter는 `--allowedTools`에서 `Agent` 제외로 enforce).
> - **Default role → capability (ADR §4.6.2 발췌, 권위는 ADR)**: `orchestrator` = spawn_l1 ✓ / spawn_l2 ✓; `architect` = spawn_l1 (subset) / spawn_l2 ✓; `implementer` / `coder` / `tester` / `analyst` / `researcher` = spawn_l1 ✗ / spawn_l2 ✓; `builder` / `logger` = spawn_l1 ✗ / spawn_l2 ✗. 이 표는 Permission Manager (#103) 구현의 시작점이며 Q-OPEN-2-FOLLOWUP에서 finer-grained refinement (per-MCP-server, per-domain network, per-path filesystem) 추적.
>
> **(C) Orchestrator-specific preservation.**
> Rule 4(A)의 "직접 수행 금지"는 오케스트레이터 role의 default capability 가 code-mutation capability (`write_fs`, `bash` for builder commands)를 **포함하지 않음**에 의해 자연 enforce 된다 (§4.6.2 row 1: orchestrator `bash` = "(subset; per Rule 13 builder delegation)" / `write_fs` ✓는 MD/spec 한정). Capability table이 Rule 4(A)의 mechanical enforcement layer이다 — 즉 Rule 4(B)가 Rule 4(A)를 **약화시키지 않으며**, 두 축은 직교한다.
>
> **(D) Enforcement timing (HARD).**
> 본 amendment의 **architectural intent**는 즉시 유효. 그러나 **mechanical enforcement** (boot-time capability check, spawn API gate, G5 monotonicity check)는 #103 Permission Manager land 시점까지 deferred. 그 사이에는 **dispatch prelude (§4.7 F1)** 의 role 선언 + role contract 가 인간-가독 enforcement 로 작동한다.
>
> **(E) 제한 (limits) — 명시적 deferred per F11.**
> Depth / fan-out / lifetime / quota 제한은 본 Rule 4 amendment에 포함하지 않는다 (사용자 lock F11 — ADR §4.6 ¶ "Depth: theoretically unbounded per Q2 ... limits are deferred per explicit user instruction"). Permission Manager follow-up ADR (Q-OPEN-3)에서 추가.
>
> **(F) Cross-references**: ADR §4.6 / §4.6.1 / §4.6.2 (이 Rule의 정상적 권위) · Rule 13 (빌드/실행 builder 위임 — orchestrator bash subset의 origin) · Rule 21 (오케스트레이터 직접 분석 금지 — Rule 4(A)와 동일 테마) · Rule 17 (SAWP envelope) · Rule 30 (Operational Autonomy — Rule 4(A) 보완) · ADR §4.7 (dispatch prelude / role 선언 — interim enforcement) · ADR §4.8 (persistence protocol — cycle detection 의 SSOT).
>
> *(현행 Rule 4-0 / Rule 4-A Phase 6 Conclusion 본문은 본 amendment에 의해 변경되지 않는다 — execution mode selection layer는 capability layer와 직교.)*

---

## Section 2 — AGENTS.md row update text

**Target file:** `AGENTS.md` line ~9 (위임 전 체크리스트 첫 row).

**Current row (line 9):**
```
- [ ] **직접 수행 금지** (Rule 4, 21): 리서치/구현/분석을 subagent 포함 직접 하지 않는가? → 해당 세션에 위임
```

**Proposed amended row (single line replacement):**
```
- [ ] **직접 수행 금지 + capability-gated spawn** (Rule 4 A/B, Rule 21; ADR-MF §4.6): (A) 오케스트레이터가 리서치/구현/분석을 subagent 포함 직접 수행하지 않고 해당 세션에 위임했는가? (B) L1 child spawn 시 부모 세션이 `spawn_l1` capability를 보유하며 자식 role이 §4.6.2 default table의 부모 권한 subset에 포함되고 `child.permissions ⊆ parent.permissions` (G5)을 만족하는가? Hard enforcement는 Permission Manager (#103) land 후. 그 전까지는 dispatch prelude (§4.7 F1) role 선언으로 인간-가독 enforce.
```

**Optional 보조 row (직후 삽입 — checklist 가독성 보존 시 사용):**
```
- [ ] **Spawn capability check (ADR-MF §4.6.2)**: 위임 inject 의 대상 세션 role이 `spawn_l1`을 (필요 시) 가지는가? (orchestrator / architect 만 기본 보유; implementer / coder / tester / analyst / researcher는 spawn_l2 only — 추가 L1 분기 필요 시 orchestrator escalation)
```

---

## Section 3 — Cross-references

- **ADR primary**: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.6 (L1 tree recursion + Permission Manager) · §4.6.1 (capability ↔ CLI adapter table) · §4.6.2 (default role → capability table) · §4.7 (dispatch prelude F1 — interim enforcement) · §4.8 (persistence + cycle detection SSOT).
- **Migration §6 sibling tasks**: #2 *this draft* · **#103 Permission Manager impl** (blocker for amendment land) · **#99 SessionContext gates G1-G6 impl** (G5 = capability monotonicity check, runtime peer to this rule) · #8 role→default-capability table impl (subordinate to #103) · #13 boot-adapter `--bare`/scratch-cwd / `effective_prompt_digest` self-test (Class A boot gate; Rule 4(B) L1 spawn 시 사용됨) · #14 persistence locking + atomicity (cycle detection의 strongly-consistent read 의존).
- **Existing rules touched**: Rule 4 (본 amendment) · Rule 4-0 / Rule 4-A (직교 — 변경 없음) · Rule 13 (builder 위임 — Rule 4(A) mechanical enforcement 일부) · Rule 21 (오케스트레이터 직접 분석 금지 — preserved) · Rule 17 (SAWP envelope) · Rule 24 (SPEC FIRST) · Rule 30 (Operational Autonomy).
- **Memory anchors**: `feedback_orchestrator_autonomous_ops.md` (Rule 30); `feedback_permanent_fix_only.md` (Rule 32 — amendment land 시 즉시 GitHub issue + Task tracking).

---

## Section 4 — Migration / land plan

1. **Now (DRAFT only)**: 본 파일 commit (no push). `docs/rules.md` / `AGENTS.md` 미수정.
2. **#103 Permission Manager 구현 land 후** (PR merge 확인):
   - Re-run cross-LLM review on this draft (deliberation: gemini + codex + claude) — 4-day-gap mitigation per Rule 25 추측 patch 금지 원칙.
   - User approval gate (Rule 24 SPEC FIRST + Rule 30 user-interaction "verdict 분기").
   - Land in **one PR**: `docs/rules.md` Rule 4 본문 교체 + `AGENTS.md` row 교체 + 본 draft 파일 삭제 (또는 `state/draft/archive/` 이동).
   - Commit message: `docs(rules): Rule 4 amendment — capability-gated spawn (ADR-MF #2, depends-on #103 landed at <sha>)`.
   - Rule 3-1 ecosystem broadcast 발신 — 실행 중 세션 `/clear` + 컨텍스트 리로드.
3. **Sequencing constraint**: #103 commits **before** rules.md 수정. Rule 4(D) "mechanical enforcement deferred" 문구는 #103 land 시점에 prose 조정 필요 (HARD enforcement statement 로 강화 — "is enforced by Permission Manager at boot/spawn time").
4. **Rollback plan**: amendment land 후 grill에서 capability table 결함 발견 시, ADR §4.6.2 default table만 수정하고 Rule 4 본문은 안정 — Rule 본문이 default table을 직접 인용하지 않고 ADR §4.6.2를 권위로 참조하기 때문.

---

## Section 5 — Backwards compatibility check

**Question:** 현재 코드 / 세션 / MD 자료 중 *strict Rule 4 interpretation* ("오케스트레이터 외 spawn 불가" 또는 "L1 child = spawn-leaf 무조건")에 의존하는 곳이 있는가?

| 영역 | 현행 상태 | Amendment 영향 | 호환성 결론 |
|---|---|---|---|
| `docs/rules.md` Rule 4 본문 | "subagent 포함 직접 수행 금지" — 오케스트레이터 surface 기준 | Rule 4(A)가 동일 의미 preserve | ✅ 호환 |
| `docs/rules.md` Rule 21 (orchestrator 직접 분석 금지) | preserve | 영향 없음 | ✅ 호환 |
| `docs/rules.md` Rule 13 (builder 위임) | orchestrator bash capability subset의 origin | Amendment가 명시적으로 §4.6.2 row 1 "(subset; per Rule 13 builder delegation)" 로 reference | ✅ 호환 (보강) |
| `AGENTS.md` 위임 전 체크리스트 | Rule 4 row 단일 | Section 2 row 교체로 처리 | ✅ 호환 (replacement) |
| `bin/dispatch.sh` (telepty#18 race fix) | spawn-and-dispatch helper — orchestrator 호출 가정 | Capability check 미구현 — #103 land 후 `--require-capability spawn_l1` flag 추가 follow-up | ⚠️ Follow-up task 필요 (#103 dependent) |
| `state/file-ownership.json` | 파일별 1 세션 소유 — Rule 10 | Spawn 모델 직교 — capability와 무관 | ✅ 호환 |
| SAWP envelope (Rule 17, `docs/sawp.md`) | role table 보유 | §4.6.2 default capability table과 reconciliation 필요 — 별도 task | ⚠️ Follow-up task 필요 (low priority) |
| Existing 실행 중 세션 (Phase 6 / Rule 4-A) | execution mode selection (PC/S/D/sc-conditional) | Capability layer 직교 — execution mode 영향 없음 | ✅ 호환 |
| Memory `feedback_*.md` | 자율 운영 / permanent fix | 영향 없음 | ✅ 호환 |
| Rule 30 자율 처리 영역 | sandbox prompt / cmux blank / stuck session 자율 대응 | Spawn capability와 무관 | ✅ 호환 |

**결론 (objective)**: Amendment land 시 **하드 브레이킹 케이스 없음**. 두 영역 (`bin/dispatch.sh` capability flag, SAWP role table reconciliation)이 follow-up task로 추적 필요. 둘 다 #103 land 후 비차단.

**Critical observation**: 현행 Rule 4의 strict interpretation에 *암시적으로* 의존하는 운영 패턴은 "위임 inject는 항상 orchestrator → leaf session" 단일-홉 모델이다. Amendment 후에는 architect 같은 spawn_l1 보유 role이 multi-hop spawn 을 합법적으로 수행할 수 있으므로, 보고 라인 (Rule 7) 의 "위임자에게 보고" 정의가 *직접 부모* (immediate parent) 인지 *루트 orchestrator* 인지 명시 필요 → **OQ-RULE4-AMEND-1**. **Resolution: §6 below (orchestrator answer 2026-05-12).**

---

## Section 6 — Reporting line transition (OQ-RULE4-AMEND-1 resolution)

**Transition note (binding for this amendment):**

Reporting line: current pattern = **R-A** (sub-sessions report directly to root orchestrator). Transition to **R-B** (immediate parent + aggregator propagation) is gated on ADR-MF #103 (Permission Manager) + aggregator mechanism land. Until then, R-A maintained.

**Implications for Rule 4 amendment land:**

- Rule 7 (완료 보고 강제) 본문은 본 amendment 와 함께 변경되지 **않는다** — R-A 가 현행. Multi-hop spawn 으로 architect 가 sub-session 을 생성해도, sub-session 의 MANDATORY REPORT 는 **root orchestrator** 로 직접 inject 한다 (`telepty inject ... <orchestrator-session-id>`).
- R-B (immediate-parent reporting + aggregator) 는 별도 land 단위: (i) #103 Permission Manager land → (ii) aggregator mechanism (parent session 이 child REPORT 를 collect 하고 propagate 하는 surface) 설계 + impl → (iii) Rule 7 amendment 가 R-B 를 적용.
- R-A → R-B 전환은 **본 Rule 4 amendment 의 scope 가 아니다** (Article 13 objective; user lock F11 — limits / 추가 제약은 follow-up ADR).
- Section 1 Rule 4 amendment 본문은 R-A 가정 하에서 정합 — `spawn_l1` capability 보유 세션이 sub-spawn 시 자식 REPORT 의 destination 은 root orchestrator 로 변경 없음.

**Cross-refs**: Rule 7 (현행 보고 강제) · ADR §4.6 (capability-gated spawn) · ADR §4.7 F1 (dispatch prelude — interim role 선언) · Permission Manager #103 + aggregator follow-up (R-B 전환의 두 blocker).

**OQ-RULE4-AMEND-1 closed:** R-A confirmed; R-B 전환 plan 명문화. No further user clarification 필요 for this amendment.

---

*EOF — draft file. LOC 보고는 commit 단계에서 `wc -l` 측정.*
