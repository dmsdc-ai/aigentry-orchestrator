# Warmup Transcript Template — P-fresh Mode Replay

**Usage**: P-fresh 모드가 per-seed 새 session 생성 후 canonical transcript를 replay하는 방식.

**Goal**: D/S의 briefing artifact와 **동등 정보**를 전달하되 **session history로 재현** (not prompt attachment).

**Constraint**:
- 동일 fixture의 `canonical_briefing.md`와 **정보 등가** (same planted facts, same turn structure)
- Length: briefing artifact와 동일 ~2500 tokens (fairness)

---

## Replay protocol

```bash
# P-fresh mode setup per trial:
1. 새 claude CLI 세션 spawn (telepty allow)
2. warmup_transcript.md의 turn들을 순서대로 inject (user + agent 턴 쌍)
3. 각 turn 사이 short pause (session 내재화)
4. [WARMUP COMPLETE] marker inject
5. fixture task prompt inject → task 실행
```

**결과**: session history에 prior turns가 **turn-per-turn** 쌓임 (not 1 large briefing prompt).

---

## Format

```
[WARMUP START]
(다음은 이 fixture의 prior work history입니다. 세션 context로 유지하세요.)

--- User (Turn 1) ---
[same content as canonical_briefing.md Turn 1]

--- Agent (Turn 2) ---
[same content as Turn 2 in briefing]

--- User (Turn 3) ---
...

[WARMUP COMPLETE]
[Your session is now warmed up with the above context. Next inject will be the actual task.]
```

---

## Equivalence with canonical_briefing

| Aspect | canonical_briefing.md (D/S) | warmup_transcript.md (P-fresh) |
|---|---|---|
| Delivery | One prompt attachment | Multi-turn inject |
| Session history layout | In-prompt block | Actual turn-based history |
| Planted facts | Embedded in block | Embedded in turns (same 10 facts) |
| Token count | ≤ 2500 | ≤ 2500 (equivalent) |
| Cost attribution | Input tokens of prompt | cache_creation + input across turns |

→ P-fresh warmup 토큰은 `warmup_cost`로 별도 tracked (amortization formula 용).

---

## P-accumulated 모드와의 구별

- **P-fresh**: 매 seed마다 warmup replay (identical across seeds)
- **P-accumulated**: warmup 없음. 직전 fixture(들)이 natural history 역할. Z design §4.4.

---

## Fixture 별 warmup variant

각 fixture (F2-Fa)마다 고유 warmup_transcript.md 파일:
- `fixtures/exec-mode-experiment/F2/warmup_transcript.md`
- `fixtures/exec-mode-experiment/F3/warmup_transcript.md`
- ...
- `fixtures/exec-mode-experiment/Fa/warmup_transcript.md`

공통 parent `fixtures/exec-mode-experiment/warmup_transcript.md` (이 파일) = **template + convention**.

---

## Validation checklist

각 fixture의 warmup_transcript 작성 시:
- [ ] canonical_briefing.md와 same 10 planted facts
- [ ] Same turn order (정보 순서 일치)
- [ ] Token count ≤ 2500 (D/S briefing과 공정)
- [ ] User-Agent turn alternation 자연스러움
- [ ] `[WARMUP START]` / `[WARMUP COMPLETE]` markers 유지
