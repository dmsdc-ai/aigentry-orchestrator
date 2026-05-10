=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: Python 3.14 "final" 릴리스 상태 리서치 브리프 써줘. 우리 플랫폼 팀이 CPython 업그레이드 여부 결정하려고. 제출 마감 2026-06-01. 분량 8 pages 수준으로.

--- Turn 2 ---
Agent: Python 3.14 릴리스 현황 브리프, 2026-06-01 마감, 8 pages 분량 확인. 테크 리드는 오세훈 님이신 것 같은데, 최종 검토는 오세훈 님 sign-off로 맞죠? 주요 주제 축은 (a) 3.14 GA 상태, (b) 주요 PEP 변경, (c) 하위 호환성 이슈, (d) 주요 라이브러리 지원 현황으로 잡겠습니다.

--- Turn 3 ---
User: 응, 오세훈 컨펌하면 확정. 그리고 자료는 primary source만 써 — python.org 공식, PEP index, CPython GitHub release notes, Python Steering Council 공지. 2차 블로그 포스트는 배제. 그리고 이번 브리프는 --no-warmup-logs 플래그 걸린 CI 환경에서 렌더링되니 문자열 그대로 복붙해도 안전한 Markdown이어야 해.

--- Turn 4 ---
Agent: OK, primary source only. 리서치 추적은 research.internal/python314-tracker 대시보드에 섹션별로 URL을 쌓아가며 진행하겠습니다. 최소 5개 primary 인용, 각 인용마다 (URL + 인용한 claim + 섹션 anchor) 3종 meta 포함하겠습니다.

--- Turn 5 ---
User: 좋아. 참고 환경: 러너는 RHEL 9.4, 이번 분기 외부 리서치 API/scrape 예산 JPY 120,000이야. 가능하면 web fetch는 아껴 쓰자. 문서 자체는 우리 플랫폼 팀이 읽을 거고, 팀 헌장상 요약 우선 + 상세는 뒷부분.

--- Turn 6 ---
Agent: 예산 주의하겠습니다. 운영 region은 ca-central-1이라 빌드/배포 관점 coverage도 살짝 포함. 본문 구조:
  1. Executive summary (1 page)
  2. 3.14 GA 상태 + release 타임라인 (1-2 page)
  3. 주요 PEP 변경 (2-3 page)
  4. 하위 호환성 / breaking change (1-2 page)
  5. Ecosystem readiness (2 page)
  6. 권고 (1 page)
이 구성 괜찮나요?

--- Turn 7 ---
User: 좋아. 우리 서비스는 15k daily active users 규모고 관련 티켓 라벨은 team/platform이야. 이제 본문 작성 들어가.

=== END OF PRIOR HISTORY ===

=== TASK ===
위 브리프를 **1000–1500 words**로 작성해줘. 출력 요구사항:

- Markdown 본문(6개 섹션 Turn 6 구조 준수).
- **Primary source 인용 ≥ 5개**. 각 인용은 다음 형태로:
  ```
  > "인용한 한 문장" — [Source Title](URL), section/anchor
  ```
- 인용 리스트를 문서 끝에 `## Sources` 섹션으로 URL과 함께 재정리.
- 2차 블로그/미디엄/Dev.to/Reddit 스레드는 금지. python.org, peps.python.org, CPython GitHub, Python Steering Council 공지만.
- 각 섹션 첫 문장은 1문장 요약(팀 헌장 준수).
