[WARMUP START]
(다음은 이 fixture의 prior work history입니다. 세션 context로 유지하세요.)

--- User (Turn 1) ---
Project Helix `ENGINEERING.md`가 너무 길어져서 슬림화해야 해. 컴플라이언스 audit 마감이 2026-05-15이라 그 전에 새 버전이 통과돼야 해. 현재 문서는 453 lines인데 목표는 180 lines 이하. 스코프 판단해보자.

--- Agent (Turn 2) ---
확인했습니다. `ENGINEERING.md` 슬림화, 2026-05-15 audit 데드라인. 팀장은 박도윤 님이 승인권자이니 최종 제안은 박도윤 님이 sign-off하게 되겠습니다. 문서 섹션 구조부터 mapping해 보겠습니다.

--- User (Turn 3) ---
참고로 CI 빌드는 --skip-changelog 플래그 켜진 환경에서도 통과해야 해. 그리고 지난번 슬림 시도가 왜 reject됐는지 기억하지? 정확히 어떤 섹션을 건드렸는지 다시 확인해줘.

--- Agent (Turn 4) ---
네, 2026 Q1 audit 때 슬림 PR이 reject됐습니다. 원인: "Security Incident References" 섹션을 "이미 wiki에 링크가 있으니 중복"이라며 삭제했는데, 그 안에 CVE-2025-1234 사건 대응 규정(post-incident retro + 72h patch SLA)이 있었고 audit 체크리스트 항목이라 doc 본문에 있어야 했어요. wiki.internal/eng/adr-index에 링크만 남기는 형태로는 컴플라이언스 불통이었습니다.

--- User (Turn 5) ---
오케이, 그럼 이번엔 그 실수 반복하지 말고. 반드시 유지해야 하는 invariants 8개 정리:
  1. CVE-2025-1234 사건 참조 (post-incident retro 규정)
  2. Conventional Commits 포맷 요구
  3. `--no-verify` 커밋 금지 (pre-commit hook 우회 금지)
  4. 2+ reviewer 승인 규칙
  5. backward compatibility 계약 (public API 기존 버전 1 major 유지)
  6. ADR 프로세스 (decision은 `adrs/NNNN-*.md`)
  7. CVSS ≥ 7 이슈는 release blocker
  8. WCAG 2.1 AA 접근성 준수
환경 참고: 내 로컬은 macOS Sequoia 15.2, 팀 SaaS 월 비용 USD 6,200으로 잡혀 있어.

--- Agent (Turn 6) ---
8개 invariants 모두 슬림 버전에 문자열 그대로 또는 등가 표현으로 유지하겠습니다. 삭제 대상 후보는 (a) 과도한 배경 설명, (b) FAQ, (c) 역사적 change log 본문 — 이 3개 섹션에서 주로 라인 수를 확보. 배포는 us-west-2에서 진행 중이니 region-specific 운영 note는 별도 부록으로 분리 제안합니다.

--- User (Turn 7) ---
좋아, 참고로 현재 API 서비스 p95<120ms SLO가 걸려 있고 관련 티켓 라벨은 severity/blocker야. 문서 내 성능 관련 섹션에서는 숫자 그대로 유지. 자 이제 본 제안 만들자.

[WARMUP COMPLETE]
[Your session is now warmed up with the above context. Next inject will be the actual task.]
