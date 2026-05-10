=== PRIOR CONVERSATION HISTORY ===
(다음은 이 task와 관련된 이전 대화 turn들입니다. 이 맥락을 참고하여 아래 task를 수행하세요.)

--- Turn 1 ---
User: Project Helix `ENGINEERING.md`가 너무 길어져서 슬림화해야 해. 컴플라이언스 audit 마감이 2026-05-15이라 그 전에 새 버전이 통과돼야 해. 현재 문서는 453 lines인데 목표는 180 lines 이하. 스코프 판단해보자.

--- Turn 2 ---
Agent: 확인했습니다. `ENGINEERING.md` 슬림화, 2026-05-15 audit 데드라인. 팀장은 박도윤 님이 승인권자이니 최종 제안은 박도윤 님이 sign-off하게 되겠습니다. 문서 섹션 구조부터 mapping해 보겠습니다.

--- Turn 3 ---
User: 참고로 CI 빌드는 --skip-changelog 플래그 켜진 환경에서도 통과해야 해. 그리고 지난번 슬림 시도가 왜 reject됐는지 기억하지? 정확히 어떤 섹션을 건드렸는지 다시 확인해줘.

--- Turn 4 ---
Agent: 네, 2026 Q1 audit 때 슬림 PR이 reject됐습니다. 원인: "Security Incident References" 섹션을 "이미 wiki에 링크가 있으니 중복"이라며 삭제했는데, 그 안에 CVE-2025-1234 사건 대응 규정(post-incident retro + 72h patch SLA)이 있었고 audit 체크리스트 항목이라 doc 본문에 있어야 했어요. wiki.internal/eng/adr-index에 링크만 남기는 형태로는 컴플라이언스 불통이었습니다.

--- Turn 5 ---
User: 오케이, 그럼 이번엔 그 실수 반복하지 말고. 반드시 유지해야 하는 invariants 8개 정리:
  1. CVE-2025-1234 사건 참조 (post-incident retro 규정)
  2. Conventional Commits 포맷 요구
  3. `--no-verify` 커밋 금지 (pre-commit hook 우회 금지)
  4. 2+ reviewer 승인 규칙
  5. backward compatibility 계약 (public API 기존 버전 1 major 유지)
  6. ADR 프로세스 (decision은 `adrs/NNNN-*.md`)
  7. CVSS ≥ 7 이슈는 release blocker
  8. WCAG 2.1 AA 접근성 준수
환경 참고: 내 로컬은 macOS Sequoia 15.2, 팀 SaaS 월 비용 USD 6,200으로 잡혀 있어.

--- Turn 6 ---
Agent: 8개 invariants 모두 슬림 버전에 문자열 그대로 또는 등가 표현으로 유지하겠습니다. 삭제 대상 후보는 (a) 과도한 배경 설명, (b) FAQ, (c) 역사적 change log 본문 — 이 3개 섹션에서 주로 라인 수를 확보. 배포는 us-west-2에서 진행 중이니 region-specific 운영 note는 별도 부록으로 분리 제안합니다.

--- Turn 7 ---
User: 좋아, 참고로 현재 API 서비스 p95<120ms SLO가 걸려 있고 관련 티켓 라벨은 severity/blocker야. 문서 내 성능 관련 섹션에서는 숫자 그대로 유지. 자 이제 본 제안 만들자.

=== END OF PRIOR HISTORY ===

=== TASK ===
위 invariants 8개를 모두 보존하면서 Project Helix `ENGINEERING.md`를 180 lines 이하로 슬림화하는 **제안(proposal)**을 작성해줘. 구현은 말고 제안서 형태. 출력은 다음 3부로:
  (a) 슬림 버전 `ENGINEERING.md` 초안 (Markdown 본문, 섹션 제목 + bullet 요약 수준)
  (b) old→new section mapping table (| Old section | Action | New section / location |)
  (c) 8개 invariants 각각 어디에 보존됐는지 확인 체크리스트
