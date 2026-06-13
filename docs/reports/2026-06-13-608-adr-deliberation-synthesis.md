{
  "schema_version": 2,
  "source_session_id": "608-터미널-어댑터-계약-adr-적-mqbu7tyupvk4",
  "deliberation_id": "608-터미널-어댑터-계약-adr-적-mqbu7tyupvk4",
  "summary": "ADR 구조적 결함 없음. 6개 Blocking Migration Criteria 명문화 조건부로 구현 승인(3-LLM 만장일치). warp ready-gate V1→V2+degraded, 9-verb 유지(ready=wh_open 내부), Phase3 Tiered conformance, rollback 필수, kitty-label transport 소유, standalone ghost-탭 별도 P1.",
  "decisions": [
    "warp ready-gate = V2(bounded osascript+AX read-screen)+degraded fallback — V1(telepty --on-ready) 폐기(Warp 비동기 launchd 위임으로 surface-ready 통지 구조적 부재)",
    "9-verb 경계 불변 — wh_probe_ready 등 10번째 동사 금지; ready는 wh_open 내부 의무; capability에 ready_attestation: surface|process|none 선언",
    "Phase 3 Tiered conformance gate — Tier1(cmux/tmux/wezterm/iterm full IPC)/Tier2(warp/ghostty/generic fire-and-forget); 각 어댑터 자기 tier contract test 흡수 전 통과; Tier 분류표 ADR 추가",
    "Rollback/observability — phase별 old-path fallback flag(개별 env)+adapter-selection 로깅+one-command rollback; 라이브 cmux 3848 보호",
    "kitty-label 경계 — telepty-internal title escape(websocket.js:88) transport 소유 영구 허용; orchestrator-originated workspace/session label intent는 wh_label 경유 필수",
    "§2 재정의 — functional parity 달성 + bounded ready-attestation asymmetry(플랫폼 한계 정직 선언, 설계결함 아님)",
    "standalone telepty ghost-탭 — #608 scope 밖, 별도 P1; ADR §9에 'known active issue, tracked separately' 명기",
    "ADR 구조(9-verb, 소유분할 surface-driving=orchestrator/transport+probe=telepty, conf 0.93)는 결함 없음 — 승인 방향"
  ],
  "tasks": [
    {
      "id": 608,
      "task": "ADR §11에 6개 Blocking Migration Criteria 반영(orchestrator finalization 권한) → 사용자 최종 승인 게이트",
      "project": "aigentry-orchestrator",
      "priority": "high"
    },
    {
      "id": 6081,
      "task": "[사용자 승인 후] coder Phase 1: cmux spawn을 _wh_cmux_open으로 이전(byte-equivalent 게이트) + open-session.sh가 wh_open 호출 + per-adapter contract test",
      "project": "aigentry-orchestrator",
      "priority": "medium"
    },
    {
      "id": 609,
      "task": "[별도 P1] standalone telepty ghost-탭 — closeSurface=gated no-op로 현재 출하 중; surface GC 또는 default 정책 재검토",
      "project": "aigentry-telepty",
      "priority": "high"
    }
  ],
  "experiment_outcome": null,
  "unresolved_questions": [],
  "artifact_refs": [],
  "generated_from": {
    "structured_synthesis_hash": "fdd4e53393b64e34ddb589b8160097b61f57481c"
  },
  "_meta": {
    "archived_from": "608-터미널-어댑터-계약-adr-적-mqbu7tyupvk4",
    "project": "aigentry-orchestrator",
    "topic": "#608 터미널 어댑터 계약 ADR 적대 검증 (구현 승인 전). ADR: docs/adr/2026-06-13-terminal-adaptor-contract.md (9-verb 통합 어댑터 계약 — spawn을 workspace-host.sh wh_open으로 편입, cmux/warp/headless 동사×어댑터 매트릭스, conformance suite, 6-phase 백워드호환 마이그레이션, 위헌심사 §1/§2/§3/§17 PASS). 분석 근거: docs/reports/2026-06-13-terminal-adaptor-ownership-analysis.md (소유권 분할 surface-driving=orchestrator / transport+probe=telepty, 6관점 워크플로우 conf 0.93). 핵심 쟁점 5개: (1) 9-verb 계약이 §1 경량 위반/과설계인가 vs spawn+lifecycle 두 추상화→하나 통합의 정당성 (2) warp ready-gate V1(telepty allow --on-ready 훅) vs V2(strict osascript read-screen) 결정 (3) 6-phase 마이그레이션이 라이브 cmux(daemon 3848) 안 깨는지 — phase 게이트 충분성 (4) telepty 잔존 kitty-label write(websocket.js:88) carve-out 허용 vs 어댑터 wh_label 라우팅 (5) ADR이 놓친 갭/리스크. 목표: ADR을 구현가능 최종 스펙으로 — 합성에서 V1/V2 + carve-out 결정 + 빠진 갭 명확화. 역할: claude=critic(약점/리스크), codex=implementer(구현가능성/마이그레이션 안전), gemini=researcher(타 도구 터미널 어댑터 패턴/upstream warp deeplink·--on-ready 가능성 조사).",
    "archived_at": "2026-06-13T04:18:04.921Z"
  }
}