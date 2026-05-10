# telepty tui — Session Management Dashboard

## 개요

`telepty tui` 명령으로 실행되는 인터랙티브 TUI 대시보드.
모든 telepty 세션의 상태를 실시간 모니터링하고, 시작/종료/재시작/메시지 전송을 한 화면에서 관리.

## 실행

```bash
telepty tui
```

## 화면 구성

```
┌─────────────────────────── telepty dashboard ───────────────────────────┐
│ Sessions (9)                              │ Event Bus                   │
│ ─────────────────────────────────────────  │ ──────────────────────────  │
│ [●] aigentry-orchestrator-claude  idle    │ 01:15 orch → brain: ping   │
│ [●] aigentry-amplify-claude      idle    │ 01:15 brain → orch: pong   │
│ [●] aigentry-brain-claude        busy    │ 01:16 broadcast: sync      │
│ [●] aigentry-deliberation-claude idle    │                             │
│ [●] aigentry-devkit-claude       idle    │                             │
│ [○] aigentry-dustcraw-claude     stale   │                             │
│ [●] aigentry-registry-claude     idle    │                             │
│ [●] aigentry-ssot-claude         idle    │                             │
│ [●] aigentry-telepty-claude      busy    │                             │
├───────────────────────────────────────────┤                             │
│ [S]tart  [K]ill  [R]estart  [L]ayout    │                             │
│ [I]nject [B]roadcast  [P]urge stale      │                             │
│ [Q]uit                                    │                             │
├───────────────────────────────────────────┴─────────────────────────────┤
│ > inject aigentry-brain-claude "상태보고 해줘"                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## 기능

### 1. 세션 목록 (좌측 패널)
- 실시간 세션 상태: `●` connected / `○` stale / `✕` disconnected
- 상태: idle / busy / stale / dead
- 화살표 키로 세션 선택
- 선택된 세션 하이라이트

### 2. 이벤트 버스 (우측 패널)
- `telepty listen` 스트림 실시간 표시
- inject/reply/broadcast 이벤트 시각화
- 타임스탬프 포함

### 3. 커맨드 바 (하단)
- 텍스트 입력으로 직접 명령 실행
- 자동완성: 세션 ID, 명령어

### 4. 키보드 단축키
| 키 | 동작 |
|----|------|
| `s` | 새 세션 시작 (프로젝트 선택 목록) |
| `k` | 선택된 세션 종료 |
| `r` | 선택된 세션 재시작 (kill + start) |
| `l` | 그리드 레이아웃 적용 |
| `i` | 선택된 세션에 메시지 inject |
| `b` | 전체 broadcast |
| `p` | stale 세션 purge + 재연결 |
| `Enter` | 커맨드 바 포커스 |
| `q` | 종료 |

### 5. Stale 감지
- heartbeat 기반 stale 세션 자동 감지
- stale 세션 `○` 표시 + 경고 색상
- `p` 키로 일괄 purge + 재시작

### 6. 세션 시작 기능
- `s` 키 → 프로젝트 목록 표시 (~/projects/aigentry-* 스캔)
- 선택 시 kitty 윈도우 생성 + telepty allow 실행
- 시작 후 자동으로 목록에 추가

## 기술 스택

- **Node.js** (telepty와 동일 런타임)
- **blessed** 또는 **ink** (TUI 프레임워크)
- telepty daemon HTTP API 직접 호출 (localhost:3848)
- `telepty listen` WebSocket 스트림 연동

## 데이터 소스

| 데이터 | 소스 |
|--------|------|
| 세션 목록 | `GET /api/sessions` |
| 세션 상태 | heartbeat + WebSocket events |
| 이벤트 스트림 | `telepty listen` (WebSocket) |
| 프로젝트 목록 | 파일시스템 스캔 |

## 우선순위

1. **P0**: 세션 목록 + 상태 표시 + inject
2. **P1**: 이벤트 버스 실시간 로그
3. **P1**: start/kill/restart
4. **P2**: stale 감지 + purge
5. **P2**: 레이아웃 적용
6. **P3**: 커맨드 바 자동완성
