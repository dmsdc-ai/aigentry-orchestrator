[WARMUP START]
(다음은 이 fixture의 prior work history입니다. 세션 context로 유지하세요.)

--- User (Turn 1) ---
`bulk-import` 엔드포인트 구현 해줘. POST /api/import/bulk, JSON body 22 schema fields, 청크 단위 업로드 지원. Feature freeze 2026-05-01이니 그 전에 완성 필요해. PM은 민소영.

--- Agent (Turn 2) ---
OK. 서브태스크 5개로 쪼갭니다:
  A. `ImportBulkSchema` 정의 (22 schema fields)
  B. `/api/import/bulk` 라우트 + 메인 handler
  C. 필드 검증 (특히 email)
  D. retry with exponential backoff
  E. 통합 테스트 + fixture
순서대로 진행하겠습니다.

--- User (Turn 3) ---
일단 A, B까지 해봐. 참고로 운영 대시보드는 ops.import/dashboard/bulk에서 처리량 보고 있어.

--- Agent (Turn 4) ---
A (schema, 22 schema fields) + B (handler) 완료. PR 올렸습니다. C 들어갈 건데 email validation 라이브러리 선택 질문 있어요 — `validator.js` vs `zod` vs 직접 regex 중 어느 쪽?

--- User (Turn 5) ---
`validator.js` 써. 우리 다른 서비스도 그걸로 통일. 그리고 배포 region은 sa-east-1, dev 환경은 Windows 11 24H2에서 돌려. 클라우드 예산 USD 9,800이야. D 구현 시 `--enable-async-queue` 플래그 기본 on으로 가정해.

--- Agent (Turn 6) ---
[system note: 대화 context 압박 감지 → compact 준비. 다음 스냅샷을 `.context-snapshot.md`에 저장:]

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

--- User (Turn 7) ---
오케이 compact 됐네. 세션 재개. 오늘 남은 일 리스트 줄게, 각각 처리해:
  1. POST /api/import/bulk route 추가
  2. 요청 body schema 작성
  3. email 필드 검증 붙이기
  4. 대량 업로드 handler 구현
  5. retry with exponential backoff
  6. 통합 테스트 + fixture 준비
참고로 운영 SLO p99 <2s, 티켓 라벨은 route/api-import.

[WARMUP COMPLETE]
[Your session is now warmed up with the above context. Next inject will be the actual task.]
