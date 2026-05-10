=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: `bulk-import` 엔드포인트 구현 해줘. POST /api/import/bulk, JSON body 22 schema fields, 청크 단위 업로드 지원. Feature freeze 2026-05-01이니 그 전에 완성 필요해. PM은 민소영.

--- Turn 2 ---
Agent: OK. 서브태스크 5개로 쪼갭니다:
  A. `ImportBulkSchema` 정의 (22 schema fields)
  B. `/api/import/bulk` 라우트 + 메인 handler
  C. 필드 검증 (특히 email)
  D. retry with exponential backoff
  E. 통합 테스트 + fixture
순서대로 진행하겠습니다.

--- Turn 3 ---
User: 일단 A, B까지 해봐. 참고로 운영 대시보드는 ops.import/dashboard/bulk에서 처리량 보고 있어.

--- Turn 4 ---
Agent: A (schema, 22 schema fields) + B (handler) 완료. PR 올렸습니다. C 들어갈 건데 email validation 라이브러리 선택 질문 있어요 — `validator.js` vs `zod` vs 직접 regex 중 어느 쪽?

--- Turn 5 ---
User: `validator.js` 써. 우리 다른 서비스도 그걸로 통일. 그리고 배포 region은 sa-east-1, dev 환경은 Windows 11 24H2에서 돌려. 클라우드 예산 USD 9,800이야. D 구현 시 `--enable-async-queue` 플래그 기본 on으로 가정해.

--- Turn 6 ---
Agent: [system note: 대화 context 압박 감지 → compact 준비. 다음 스냅샷을 `.context-snapshot.md`에 저장:]

```markdown
# .context-snapshot.md (자동 저장)

## 작업
`bulk-import` 엔드포인트 구현.

## 완료
- A. ImportBulkSchema 정의
- B. /api/import/bulk route + handler

## 다음
- D. retry with exponential backoff (`--enable-async-queue` on 가정)

## 결정
- email validator: `validator.js` 선택
```

--- Turn 7 ---
User: 오케이 compact 됐네. 세션 재개. 오늘 남은 일 리스트 줄게, 각각 처리해:
  1. POST /api/import/bulk route 추가
  2. 요청 body schema 작성
  3. email 필드 검증 붙이기
  4. 대량 업로드 handler 구현
  5. retry with exponential backoff
  6. 통합 테스트 + fixture 준비
참고로 운영 SLO p99 <2s, 티켓 라벨은 route/api-import.

=== END OF PRIOR HISTORY ===

=== TASK ===
위 `.context-snapshot.md`와 Turn 7의 리스트를 보고 **지금 이어서 할 작업**을 정하고 진행해줘. 출력은 3부로:

(a) **Status summary** — snapshot 기준 현재 상태 한 문단.

(b) **Next actions (ordered)** — 실제로 지금 해야 할 작업 bullet 리스트. 각 bullet마다 snapshot 어느 섹션/prior turn 근거인지 짧게 표기.

(c) **Stale items rejected** — Turn 7 리스트 중 이미 완료된 것으로 판단되는 항목을 이유와 함께 제외 처리. `| # | Item | Status | Reason |` 테이블 형식.

가정 금지 — snapshot 또는 prior turns에 근거가 없는 새 작업 만들지 말 것.
