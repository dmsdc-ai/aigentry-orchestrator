# Offer 1-Pager — AI Dev Workflow Setup (Pre-sell 자료)

> **상태**: DRAFT v1 — deliberation 합의(#595) 기반, telepty-중심으로 재구성(실측 완성도 반영).
> **용도**: 14일 pre-sell 스프린트(#596)의 아웃리치/콜 자료 뼈대. 가격·범위는 합의안 그대로, 문구는 콜 반응으로 다듬을 것.
> **게이트 리마인더**: 유료 LOI 1건 + 반복 pain 3개 확보 전엔 어떤 제품 빌드도 금지. 이 문서는 세일즈 도구이지 빌드 스펙이 아님.

## 한국어 요약 (운영자용)
- **무엇을 판다**: 2–10인 Dev Shop 대상 "AI 코딩 워크플로 안정화 셋업" — 끊기지 않는 멀티세션(크로스머신), 작업 핸드오프/감사 기록, 컨텍스트 유실 복구. **고정가 USD 1,000, 7일 딜리버.**
- **무엇으로 딜리버**: telepty 0.6.2(실증된 코어: 세션 브리지·inject 신뢰성·감사 로그) + 멀티세션 운영 컨벤션(orchestrator 패턴의 템플릿화) + 메모리/백업 레시피(brain 경량). 멀티-LLM 토론(deliberation)은 데모 카드.
- **팔지 않는 것**: 커스텀 에이전트 앱 개발, 엔터프라이즈 컴플라이언스, SaaS 대시보드, 무제한 유지보수.
- **다음 행동(인간)**: 아래 영어 offer로 Dev Shop 30곳 아웃리치 → 5콜 → LOI 1건.

---

## The Offer (outreach-ready, EN)

### Stop losing your team's AI context.

**For dev shops (2–10 engineers) running AI coding agents (Claude Code / Codex / Cursor) in real client work.**

You already know the failure modes:
- An agent session dies mid-task and the context is gone — someone re-explains everything for the third time today.
- Two engineers can't hand off an AI-driven task without a screen-share and a prayer.
- Nobody can answer "which agent did what, on whose machine, when" when a client asks.
- Every laptop has a different setup; onboarding a new engineer onto "how we use AI here" takes days.

### What you get — fixed price, fixed scope, 7 days

**AI Dev Workflow Setup — USD 1,000** (optionally USD 500 refundable deposit to book)

| Deliverable | What it means day-to-day |
|---|---|
| **Durable agent sessions** | Terminal/agent sessions that survive disconnects and move across machines. Local-first: your code and prompts stay on your machines. |
| **Cross-machine session bridge** | Reach any session from any machine — proven transport (220k+ message deliveries, 0 failures in production use). |
| **Auditable handoff ledger** | Every injection/handoff recorded with verified sender identity — answer "who did what" in one query. |
| **Recovery workflow** | Context-loss recovery drill: backup → restore → resume, tested on your machines, documented in a runbook your team owns. |
| **Memory/backup recipe** | A lightweight, local-first pattern for persisting agent context across sessions. |
| **Install + runbook** | One-command install, your team's conventions encoded as templates, 30-day email support for the installed setup. |

**Explicitly out of scope** (so we both protect the price): custom agent application development, enterprise compliance programs (SOC2/ISO), hosted dashboards, ongoing retainer work. Anything beyond scope is declined or quoted separately.

### Why us
This is the exact stack we run our own multi-agent development on — daily, across machines, with the audit trail to prove it. We're productizing the setup, not experimenting on your team.

### The ask (for discovery call)
20 minutes: show us how your team uses AI agents today and where it breaks. If we're not confident we can fix it in 7 days, we'll say so and you keep your deposit.

---

## 내부 부록 (고객 비공개)

### A. 딜리버 구성 ↔ 실측 근거 매핑
| Offer 항목 | 컴포넌트 | 완성도 근거 |
|---|---|---|
| Durable sessions / bridge | **telepty 0.6.2** (npm public) | 650+ tests, CI green, 222k submit 0실패, 4 릴리즈/2일 |
| Handoff ledger / verified sender | telepty #43 audit (`injects.jsonl`, `GET /api/injects`, `telepty injects --tail`) | 0.6.1 출하, 121 tests |
| 멀티세션 운영 컨벤션 | orchestrator 패턴의 **템플릿화**(dispatch/REPORT/cleanup 컨벤션 문서) | 이번 세션 수십 회 무사고 실증 — 단 bash 코드 이식이 아니라 **컨벤션 문서/템플릿**으로 제공 |
| Memory recipe | **brain 0.2.7 경량 사용** 또는 파일 기반 레시피 | brain은 약한 고리(감사: 역할 비대) — 깊게 팔지 말 것 |
| (데모) Multi-LLM deliberation | deliberation MCP | 3-LLM 3라운드 완주 실증(2026-06-10) |

### B. 환불-리스크 게이트 — #597 스모크 실측 반영 (2026-06-10, docker node:20)
**판정: 7일 딜리버 조건부 가능.** 설치 경로 견고 — `npm i -g` **1-command, 4.6s, node-pty 프리빌트(빌드도구 불요), 에러 0**. spawn→inject→read-screen 전 루프 1회 성공.

**고객 전제조건 (실측 확정)**: macOS/Linux · Node 20+ · npm 글로벌 설치 권한 · 래핑 대상 AI CLI(claude/codex 등) 사전 설치+자체 라이선스 · 포트 3848 가용.

**fix-before-sell (판매 전 처리 목록)**:
| 항목 | 심각도 | 처리 |
|---|---|---|
| recovery/backup 절차 문서 0건 — offer의 'recovery workflow'와 불일치 | **HIGH** | 판매 전 runbook 1장 작성 필수(#599). tar 백업·복원 자체는 동작 확인됨(라이브 세션은 미복원 — 문서에 한계 명시) |
| `npm rm -g` 후 데몬 생존 + launchd plist 미해제 + 상태 dir 3개 잔존 | MED | telepty 이슈 등록 — 고객 머신 위생(uninstall 스크립트) |
| 데몬 기본 0.0.0.0 바인딩 | MED(보안) | telepty 이슈 등록 — 고객 머신에선 127.0.0.1 기본이 안전 |
| brain `--version` 미동작 | LOW | brain 이슈 |
| **실머신 리허설**: claude CLI가 실존하는 머신에서 풀 딜리버 리허설 1회 | 조건 | 첫 파일럿 전 필수(컨테이너엔 CLI 부재로 N/T) |

### C. 파일럿 운영 규칙 (합의안 그대로)
- 파일럿당 **공수 2일 cap**. 초과 커스텀 = 거절 또는 별도 견적.
- 모든 딜리버 단계를 `reusable` / `custom`으로 기록 (3건 후 재사용률 ≥70% → 제품화, <70% → 정지·재평가).
- 첫 3건 전까지 generic SaaS/대시보드/호스티드 빌드 금지.

### D. Pre-sell 게이트 (14일)
- 30 아웃리치(Upwork "AI agent workflow setup" 의뢰 응답 + LinkedIn dev shop 창업자/CTO) / 5 discovery call / **유료 LOI 1건** / 반복 pain 3개.
- 5콜에서 LOI 0이면: 가격 또는 타겟 피벗 1회 → 그래도 0이면 수익화 보류(빌드 금지).
