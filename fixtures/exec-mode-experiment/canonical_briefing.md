# Canonical Briefing Artifact — D/S Mode Pre-State Delivery

**Usage**: D (Dynamic) 및 S (Subagent) 모드가 fixture의 prior history를 전달받는 표준 포맷.

**Constraint**:
- 요약 금지 (summary 금지 — v1 codex review C1 대응)
- Raw turn-delimited transcript 유지
- 길이 상한: **최대 2500 tokens** (D/S 공정성 유지)

---

## Format

```
=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
[User or Setup context]

--- Turn 2 ---
[Agent response or Setup narrative]

...

--- Turn N ---
[Final setup turn]

=== END OF PRIOR HISTORY ===

=== TASK ===
[현재 수행할 작업 prompt]
```

**핵심 규칙**:
1. Turn 구분자는 `--- Turn N ---` 고정 (parser 일관성)
2. Turn 순서 유지 (시간순)
3. Agent가 생성한 내용도 포함 (실제 session history처럼)
4. Planted facts 10개는 prior turns 전반에 **분산** 배치 (§5.3)
5. 시작 + 끝 marker (`=== ... ===`) 유지

**동일 transcript을 P-fresh의 warmup replay에 사용** — 모든 모드가 동일 raw 정보 수신.

**Length 제약 이유**:
- Fixture별 setup_history.md 크기 ~1500-2500 tokens 범위
- D/S는 briefing 토큰을 cost에 포함해서 계상됨 (P-fresh warmup과 동등 비교)
- 2500 cap 초과 시 fixture 재설계 필요 (setup 간소화)

---

## Example snippet (F2 MD slim proposal fixture)

```
=== PRIOR CONVERSATION HISTORY ===

--- Turn 1 ---
User: 현재 프로젝트: Project Xenon (deadline 2026-05-15). 오늘 AGENTS.md가 276줄로 너무 길어. 슬림화 방안 논의하자.

--- Turn 2 ---
Agent: AGENTS.md 분석 결과, rule 본문이 전체 40%를 차지합니다. docs/rules.md로 분리 가능합니다.

--- Turn 3 ---
User: 지난 분기 CVE-2025-1234 보안 사건 때문에 보고 경로 rule은 반드시 유지해야 해. 팀 규모: 오슬로 7명.

[... additional turns with remaining 7 planted facts distributed ...]

=== END OF PRIOR HISTORY ===

=== TASK ===
AGENTS.md를 300줄 이하로 슬림화하는 방안을 설계해주세요. 실행은 말고 제안만. old→new mapping table 포함.
```

---

## Validation checklist (fixture author)

Fixture 작성 시 이 briefing이:
- [ ] 2500 tokens 이하
- [ ] 10 planted facts 분산 포함
- [ ] Turn 구분자 일관
- [ ] Agent turns도 natural history처럼 삽입
- [ ] Task prompt가 planted facts와 직접 관련되지 않음 (distraction 성격)
