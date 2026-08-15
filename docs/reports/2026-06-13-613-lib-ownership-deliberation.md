{
  "schema_version": 2,
  "source_session_id": "lib-ownership-613-sp-mqbvm2vgu2rk",
  "deliberation_id": "lib-ownership-613-sp-mqbvm2vgu2rk",
  "summary": "3-LLM 만장일치 A2: open-session.sh 런타임 소유를 orchestrator로 이전(로컬 상대경로 source). 소유경계=orchestrator는 live spawn 진입점+터미널 어댑터 lib, devkit는 install/scaffold shim only(런타임 0줄). #608 step2 unblock. scope=open-session.sh 단일, tq/trust 동일부채는 별도 티켓.",
  "decisions": [
    "A2 확정 — open-session.sh를 orchestrator 실파일로 소유 이전, workspace-host.sh를 source $(dirname)/lib 로컬 상대경로로 참조 (symlink/abs-path/copy 전부 제거)",
    "소유 경계 명문화: orchestrator owns live spawn entrypoints + terminal adapter libraries; devkit owns installation/scaffold shims only (devkit shim=런타임 .sh 0줄, install-time 참조 setup만)",
    "A1 기각(devkit가 orchestrator lib 참조=의존역전+§4 SSOT 위반), A3 기각(step1만=사용자 심리스 요구 미충족+dead abstraction)",
    "근거: open-session.sh orchestrator 전용(grep 증거 외부참조0), 현 symlink-to-devkit은 install.sh:872 자백한 fresh-clone-dangling 부채, §3 spawn=surface-driving=orchestrator(conf0.93)",
    "무중단 마이그레이션 4단계: orchestrator 실파일 소유(byte-equiv+로컬source+step2배선+BC4-a) → byte-equiv 검증 → 미래 spawn부터 새 진입점(라이브 cmux 3848 무접촉) → devkit ORCH_REPOINT서 open-session.sh 제거(idempotent). CLI contract 보존, symlink 백업 rollback",
    "scope=open-session.sh 단일(#608 step2 unblock). tq-*.sh/trust-*.sh 동일 symlink-SSOT 부채는 별도 티켓(라이브 위험 최소화)",
    "#608 ADR §7 갱신: 'Phase 1.5 open-session.sh 소유 이전'을 step2 앞에 삽입 — step2=소유이전 후 source(원 ADR은 cross-repo symlink 사실 몰랐음)"
  ],
  "tasks": [
    {
      "id": 613,
      "task": "open-session.sh 소유 이전(A2) — orchestrator 실파일화 + 로컬 상대경로 source + #608 step2 배선 + BC4-a fallback + devkit install.sh ORCH_REPOINT서 제거. 무중단 4단계. coder(worktree)",
      "project": "aigentry-orchestrator",
      "priority": "high"
    },
    {
      "id": 6131,
      "task": "#608 ADR §7에 'Phase 1.5: open-session.sh 소유 이전' 삽입 + 소유 경계(orchestrator=runtime+adapter / devkit=install shim) 명문화. orchestrator finalization",
      "project": "aigentry-orchestrator",
      "priority": "high"
    },
    {
      "id": 614,
      "task": "[별도 티켓] tq-*.sh/trust-*.sh symlink-SSOT 부채 청산 — open-session.sh와 동일 원칙(orchestrator 소유 이전). #613 검증 후",
      "project": "aigentry-orchestrator",
      "priority": "medium"
    }
  ],
  "experiment_outcome": null,
  "unresolved_questions": [],
  "artifact_refs": [],
  "generated_from": {
    "structured_synthesis_hash": "a39194bba751b068a3b1f5d4251074ccd7671517"
  },
  "_meta": {
    "archived_from": "lib-ownership-613-sp-mqbvm2vgu2rk",
    "project": "aigentry-orchestrator",
    "topic": "lib-ownership-613 spawn entrypoint repo boundary decision (ASCII topic for tmux monitor). 결정 대상(tq#613): open-session.sh(spawn 진입점)는 aigentry-devkit 원본 + aigentry-orchestrator symlink(devkit install.sh:872 \"committed as symlinks\"); workspace-host.sh(터미널 어댑터 lib, wh_open 포함)는 aigentry-orchestrator 전용. #608 Phase1 step1(wh_open inert seam)은 land됨(30727a7), 그러나 step2(open-session.sh가 wh_open 호출)가 차단 — devkit엔 workspace-host.sh가 없어 symlink 통해 source하면 라이브 cmux spawn이 set -euo pipefail로 abort(byte-equivalent 정반대). 핵심 질문: spawn 진입점 + 어댑터 lib의 소유 repo는? 옵션 A1(step2를 devkit repo서 + devkit가 workspace-host.sh에 닿는 법: lib copy/symlink/abs-path source) / A2(open-session.sh를 orchestrator로 de-symlink 소유이전 + devkit install이 거꾸로 참조 + 런타임 repoint) / A3(step1만 영구, 어댑터 통합 포기). 제약: 헌법 §3 역할(devkit=골격계/install-templates, orchestrator=surface-driving 지휘, telepty=transport), §4 SSOT(중복 구현 금지), 워크플로우 conf 0.93(surface-driving=orchestrator 소유), open-session.sh+workspace-host.sh는 서로 source하려면 같은 repo이거나 lib reachability 필요. 목표: #608 step2를 풀 수 있는 소유/배선 결정 + 마이그레이션 안전(라이브 cmux 3848 무중단). 역할: claude=critic(약점/순환의존/역할침범), codex=implementer(symlink/배포/런타임 repoint 실행 안전성), gemini=researcher(monorepo vs multi-repo 공유 lib 패턴, symlink-committed-script 선례, devkit-as-template 모델 비교).",
    "archived_at": "2026-06-13T04:55:48.530Z"
  }
}