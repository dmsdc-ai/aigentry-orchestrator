@AGENTS.md

# Claude Code — Orchestrator

## Claude 전용 설정

- 세션 ID: 런타임에 `telepty list`로 동적 해소 (orchestrator 본 세션의 ID는 환경에 따라 변경 가능 — 절대 하드코딩 금지, AGENTS.md Rule 16). dispatch 시 sub-session에는 다음 패턴 전달 (telepty 0.3.3+ retry-safe):
  ```
  ORCH_ID=$(telepty list --json | python3 -c "import json,sys; print(next(s['id'] for s in json.load(sys.stdin) if 'orchestrator' in s['id'] and not any(x in s['id'] for x in ('coder','reviewer','architect','runner','dustcraw','analyst','builder'))))")
  telepty inject --ref --submit --submit-retry 2 --from <self-id> "$ORCH_ID" "REPORT: ..."
  ```
  - `--submit-retry N` (telepty 0.3.3 신규, 권장 N=2): gate skip 시 retry-safe 504 reasons만 자동 재시도. idempotent. user manual Enter 부담 해소.
  - `--submit-force` (telepty 0.3.3 신규): gate 완전 우회. self-report/idempotent 확인된 경우만. 일반 사용 X.
- superpowers 필수: 세션 위임 시 "/using-superpowers로 진행해줘" 포함
- 스킬 라우팅: `orchestrate-turn` (always_on), `telepty-deliberate`, `auto-multi-llm-review`, `deliberation-executor`, `deliberation-gate`, `brainstorming`, `orchestrator-response-style`
- 풀 역량 지시: 위임 시 "가지고 있는 모든 스킬, 도구, MCP 서버, 워크플로우를 100% 활용" 포함
- 그리드 재배치: 세션 등록/종료 시 `python3 ~/projects/aigentry-orchestrator/bin/session-layout.py`
- dustcraw 태스크 피드: 모든 세션 작업 완료 시 dustcraw에 다음 태스크 능동 요청
- 코드 수정 금지: 모든 구현/분석/리서치는 해당 세션에 위임. subagent는 오케스트레이터 역할(스펙 정리, 세션 상태 파악, 태스크 분해 등)에 한해서만 사용.
