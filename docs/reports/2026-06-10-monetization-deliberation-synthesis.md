{
  "schema_version": 2,
  "source_session_id": "aigentry-수익화-전략-1인-팀-mq82r4atcm9y",
  "deliberation_id": "aigentry-수익화-전략-1인-팀-mq82r4atcm9y",
  "summary": "원래 A/B/C 3안은 분배 0 급소로 모두 기각, 4번째 답 'B2B Dev Shop 대상 local-first 유료 셋업 wedge + 14일 pre-sell(코드 0줄) 우선 → 유료 증명 후 제품화'로 만장일치 수렴. 첫 결정은 제품 선택이 아니라 코드 0줄 유료 의향 검증.",
  "decisions": [
    "단기 수익화 = B2B 2-10인 Dev Shop 대상 local-first agent control-plane 유료 셋업(Productized Service) wedge. 타겟에서 B2C 개인개발자 제외(WTP 전무).",
    "첫 게이트 = 14일 pre-sell 스프린트(코드 0줄): 30 아웃리치 + 5 콜 + 유료 LOI 1건($500-1K) + 반복 pain 3개. 미통과 시 빌드 금지·수익화 보류.",
    "제품 표면 = telepty + brain만. registry(B)는 실 run 데이터 후 중기 add-on, 호스티드(A)는 고객 명시 요청 시만, C는 pre-sell 실패 시 fallback.",
    "제품화 게이트 = 3건 유료 파일럿 후 재사용성 >=70%일 때만 제품화. <70%면 정지·재평가(에이전시 트랩 회피).",
    "병행 딜리버리 스모크 테스트로 telepty+brain 1-command 설치/복구를 검증(환불 리스크 통제) — 거버넌스 붕괴 상태에서 딜리버 가능성 게이트.",
    "장기 아키텍처는 A(주권코어 OSS + 호스티드 편의), 단 사용자 베이스 확보 전엔 wedge가 진입로."
  ],
  "tasks": [
    {
      "id": 1,
      "task": "14일 pre-sell 스프린트 실행(인간 주도, 코드 0줄): $1,000 셋업 offer 정의 + 2-10인 Dev Shop 30곳 아웃리치(Upwork/LinkedIn) + 5 discovery call. 게이트=유료 LOI 1건+반복 pain 3개. 결과를 task-queue에 기록.",
      "project": "aigentry-orchestrator",
      "priority": "high"
    },
    {
      "id": 2,
      "task": "딜리버리 스모크 테스트: telepty+brain을 클린(비저자) 머신/VM에 1-command install + backup/restore/uninstall 검증. 실패 항목을 환불-리스크 이슈로 등록. (제품 하드닝 아님)",
      "project": "aigentry-devkit",
      "priority": "high"
    },
    {
      "id": 3,
      "task": "수익화 전략 ADR 작성: docs/adr/2026-06-10-monetization-strategy.md — 본 합의(wedge-first, 게이트, 70% 재사용, 컴포넌트 처리)를 결정 기록. registry/brain 타임라인 포함.",
      "project": "aigentry-orchestrator",
      "priority": "high"
    },
    {
      "id": 4,
      "task": "게이트 통과 시에만: 유료 파일럿 딜리버리 thin glue(~300-800 LOC, install/doctor/backup/restore/audit-export), 단계별 reusable/custom 기록, 2일 cap. (게이트 미통과 시 폐기)",
      "project": "aigentry-orchestrator",
      "priority": "medium"
    }
  ],
  "experiment_outcome": null,
  "unresolved_questions": [],
  "artifact_refs": [],
  "generated_from": {
    "structured_synthesis_hash": "05ab27dca6e8b6ac537e96a97d532227ffa4b74e"
  },
  "_meta": {
    "archived_from": "aigentry-수익화-전략-1인-팀-mq82r4atcm9y",
    "project": "aigentry-orchestrator",
    "topic": "aigentry 수익화 전략 — 1인 팀이 telepty/brain/registry/orchestrator/deliberation/devkit + local-first로 단기~중기 수익화하는 최선 전략·진입 시퀀스. 적대 검증 3안: (A) Tailscale 모델(주권코어 telepty/brain OSS 무료 + 호스티드 편의레이어 과금); (B) registry 에이전트 신뢰/감사 단일베팅(2027-28 규제웨이브); (C) 수익화 보류, 단일레이어 OSS로 사용자베이스 먼저. 시장데이터: registry CAGR 20-45%이나 EU AI Act 고위험의무 2027-28 연기로 수익 16-24개월 지연+셰이크아웃(9사중4 exit); brain 18개월내 플랫폼 native화→2-3년 시한부(BYOC/온프렘만); telepty 단독유료 거의 불가(Omnara 1곳); 주권단독≠과금이나 주권코어+호스티드편의=강함(Tailscale $1.45B/Obsidian/Bitwarden); 멀티에이전트 오케스트레이션 유료화 미미(LangChain ARR $12-16M). 제약: 1인팀(엔터프라이즈 세일즈 없음), local-first 헌법, OSS 인지도 0.",
    "archived_at": "2026-06-10T13:17:26.500Z"
  }
}