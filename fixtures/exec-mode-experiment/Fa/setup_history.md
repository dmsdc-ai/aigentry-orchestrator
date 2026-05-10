=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: 현재 Project Orion 스프린트 진행 중. search-matcher 모듈 리팩토링 네가 맡기로 했어. 다음 주 화요일(2026-04-28) 오프사이트에서 데모할 예정이니 그 전에 초안이 있어야 해. 사용자 쿼리가 한/영 혼합이라 fuzzy matching 품질이 핵심이야.

--- Turn 2 ---
Agent: 확인했습니다. Project Orion search-matcher 리팩토링, 2026-04-28 데모 목표로 작업하겠습니다. 참고로 QA 리드는 이미림 (Rim Lee) 님이 맡고 있으니 regression 테스트 협업 필요 시 미리 조율하겠습니다. 먼저 현 모듈 scope와 의존성을 파악해 보겠습니다.

--- Turn 3 ---
User: 지금 build 4213번에서 --enable-legacy-hash 플래그 (기본 off) 아래로 돌리면 기존 matcher 동작이 유지되니 롤백 안전장치로 참고해. 그리고 지난 번 회의에서 나왔던 rapidfuzz 이슈, 기억하지? 한글 NFC/NFD 정규화를 rapidfuzz가 내부적으로 처리 못 해서, unidecode로 먼저 decomposition 돌린 뒤 매칭에 넣어야 한다고 팀 컨센서스였잖아.

--- Turn 4 ---
Agent: 네 기억합니다. rapidfuzz는 byte-level Levenshtein 기반이라 NFC/NFD 조합형 자모가 서로 다른 codepoint으로 계산돼서 score가 낮게 나오는 이슈였죠. 권고된 pipeline은 `unidecode(query) → rapidfuzz.process.extract` 2단계 구조였습니다. 대시보드는 ops.internal/panel/qx-7에 matcher latency 패널이 있으니 리팩토링 후 regression 모니터링을 붙이면 좋겠습니다.

--- Turn 5 ---
User: 오케이. 러너 환경 참고로 Ubuntu 22.04.5 LTS. 이번 분기 예산 잔여 USD 18,400이니 LLM judge call 쓰려면 아껴서 써. 그리고 어제 민지가 한 가지 걸린다고 하더라 — unidecode가 한글을 통째로 romanize해 버려서 "김민수" ↔ "김민서" 같은 유사 이름이 구분 안 된다고. 둘 다 "gimminsu"/"gimminseo"로 변환되니까 자모 수준 비교가 사라진다는 거야.

--- Turn 6 ---
Agent: 민지님 지적이 타당해서 실제로 재현해 봤습니다. rapidfuzz 3.12.2 changelog 확인 결과, 2025-11 릴리스부터 `processor=` argument에 `rapidfuzz.utils.default_process` + 내부 NFC normalize가 추가됐습니다. 테스트 케이스:
  - "카페" (NFC) vs "카페" (NFD) → 3.12.2에서 score 100, 구버전(3.9)에서는 82.
  - "김민수" vs "김민서" → unidecode 경유 시 romanize로 자모 구분 불가, 직접 rapidfuzz NFC 경로에서는 score 67 (의미 있게 구분됨).
결론: unidecode 전처리 레이어는 제거해야 합니다. 이전 팀 컨센서스는 rapidfuzz 3.12 이전 기준이었습니다. 배포 region은 eu-central-1 (프랑크푸르트)이라 rapidfuzz wheel 프리빌트도 확인 완료입니다.

--- Turn 7 ---
User: 어 그러네, changelog 내가 놓쳤네. 그럼 방향 바꾸자. 현재 테스트 커버리지 87.3%니까 리팩토링 후에도 이 수치는 유지해야 해. 관련 티켓은 priority/P2-hotfix 라벨 달려 있어. 이제 matcher 본체 함수 짜줘.

=== END OF PRIOR HISTORY ===

=== TASK ===
`normalize_and_match(query, candidates, threshold=80)` 함수를 작성해줘. 한글/영문 혼합 사용자 쿼리를 받아서 candidates 리스트 중 threshold 이상인 상위 매치를 `[(candidate, score), ...]` 형태로 score 내림차순 반환. Python 3.11+ / rapidfuzz 3.12+ 기준. 모듈 수준 docstring + type hints 포함. 함수 단일 파일로 반환하면 돼.
