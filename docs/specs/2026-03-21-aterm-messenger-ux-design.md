# aterm Messenger UX 재설계 — AI 에이전트 전용 메신저

**Date:** 2026-03-21
**Status:** Approved (멀티LLM 3자 + 5개 세션 만장일치) + 사용자 추가 결정 반영
**Deliberation:** aterm-메신저-ux-재설계-ai--mn086iw1v16r + thread 1d36c257

---

## 1. Vision

aterm = AI 에이전트 전용 메신저. 카카오톡과 동일한 UI/UX. 세션을 "친구"로, 대화를 "채팅방"으로, 딜리버레이션을 "그룹채팅"으로 매핑. 퍼블릭 사용자가 별도 학습 없이 직관적으로 AI 에이전트 오케스트레이션을 수행할 수 있는 UX.

### 핵심 원칙
1. **카톡과 동일한 UI/UX** — 친구탭, 채팅탭, 채팅방
2. **채팅이 1급 시민, 터미널은 토글로만 접근**
3. **Claude CLI 네이티브 기능 100% 유지** — PTY를 통해 모든 기능 그대로 동작
4. **컨텍스트 렌더링** — PTY 출력을 분석해서 버블/카드/구분선/헤드메세지로 표현

---

## 2. UX 구조 (카카오톡 매핑)

### 2.1 친구 탭 = 세션 목록

- 프로필 아이콘 + 세션 이름 + 상태메시지
- 상태: online / busy / offline / stale
- 터미널 미리보기 없음
- 카톡의 친구 목록과 동일

### 2.2 채팅 탭 = 대화방 목록

- 1:1 채팅방 + 그룹 채팅방 목록
- 마지막 메시지 미리보기 + 타임스탬프
- 안 읽은 메시지 수 뱃지
- 카톡의 채팅 탭과 동일

### 2.3 1:1 채팅방

- 세션 클릭 → 채팅방 열림
- **에이전트 버블** (노란색/색상) + **사용자 버블** (흰색/회색)
- 타임스탬프 표시
- 하단 입력창 + 전송 버튼
- 입력창에 타이핑 → PTY stdin으로 전달 → Claude CLI가 처리
- **모든 Claude 네이티브 기능 그대로** (`/command`, skill, hook, MCP 등)
- **터미널**: 토글 버튼으로만 접근 (기본 숨김). xterm.js raw CLI 표시.

### 2.4 그룹 채팅방 = 딜리버레이션

- 2+ 세션 선택 시 그룹 생성 (Cmd+K: `group brain telepty design`)
- 사용자 = 오케스트레이터
- 참여 세션별 프로필 아이콘 + 이름 + 색상별 버블
- **2단계 하이브리드**:
  - Phase 1 (발산): 모든 참여 세션에 동시 질문 → 각자 의견 제출 (병렬)
  - Phase 2 (수렴): 의견 차이 감지 → 자동 반론 요청 → synthesis 생성
- synthesis = 특별 합의 카드
- 사용자는 주제만 던지면 자동 진행. 중간 개입 가능.

### 2.5 컨텍스트 렌더링

PTY 출력을 분석하여 채팅방에 구조화된 요소로 표현:

| Claude CLI 출력 | 채팅 렌더링 |
|----------------|-----------|
| 텍스트 응답 | 채팅 버블 (마크다운 렌더링) |
| 코드 블록 | Slack 스타일 코드 블록 (구문 강조) |
| tool use (Read, Edit, Bash 등) | 접이식 카드 ("파일 읽는 중..." → 펼치면 상세) |
| thinking/reasoning | 접이식 "생각 중..." 인디케이터 |
| 에러 | 빨간 에러 카드 |
| 시스템 이벤트 | 헤드메세지 (날짜 구분선, "brain이 참여했습니다") |
| 딜리버레이션 Phase 전환 | 헤드메세지 ("Phase 2: 수렴 시작") |
| 합의 완료 | 합의 카드 (요약 + 결정사항) |

```
──── 2026-03-21 오후 7:30 ────
🔧 Tool: Read src/main.js (3줄)
   [brain] 파일 분석 완료. 버그 원인은 line 42.
──── Phase 2: 수렴 시작 ────
   [brain] 이 방향으로 가자.
   [telepty] 동의.
──── ✅ 합의 완료 ────
```

### 2.6 컨텍스트 누적

- 모든 채팅(1:1 + 그룹) 내용이 해당 세션의 프로젝트 컨텍스트에 누적
- 예: brain이 그룹채팅에서 발언한 내용 → 이후 1:1에서 brain이 기억
- 채팅 타임라인(정제 메시지)과 세션 컨텍스트(raw + summarized)는 분리 저장

---

## 3. 아키텍처

### 3.1 핵심 구조

```
채팅 입력창 → PTY stdin → Claude CLI (네이티브 기능 100%)
                              ↓
                         PTY stdout
                              ↓
                   컨텍스트 분석 + 렌더링
                              ↓
              채팅 버블 / 코드 블록 / 카드 / 헤드메세지
```

- aterm이 별도로 구현할 것 없음 — Claude CLI의 모든 기능은 PTY를 통해 네이티브 지원
- 채팅 뷰는 PTY 출력의 렌더링 레이어일 뿐

### 3.2 ConversationEvent 스키마

```typescript
type ConversationEvent =
  | { type: "user_message"; sessionId: string; text: string; ts: number }
  | { type: "agent_message"; sessionId: string; text: string; ts: number; final: boolean }
  | { type: "status"; sessionId: string; status: SessionStatus; ts: number }
  | { type: "tool_event"; sessionId: string; tool: string; result: string; ts: number }
  | { type: "session_lifecycle"; sessionId: string; event: "created" | "died" | "restarted"; ts: number }
  | { type: "deliberation_turn"; sessionId: string; speaker: string; content: string; round: number; ts: number }
  | { type: "deliberation_summary"; sessionId: string; summary: string; decisions: string[]; ts: number }
  | { type: "head_message"; sessionId: string; label: string; ts: number }

type SessionStatus = "online" | "busy" | "offline" | "stale"
```

### 3.3 역할 분담

| 컴포넌트 | 역할 |
|---------|------|
| **aterm** | UI 렌더링, Tauri IPC, PTY 관리 (Rust), 채팅 컴포넌트, 컨텍스트 분석+렌더링 |
| **telepty** | 세션 라우팅, 이벤트 버스, inject/reply |
| **deliberation** | 토론 엔진 (MCP 14개 도구), synthesis, 2단계 하이브리드 |
| **design** | UI/UX 패턴, 디자인 토큰, 컴포넌트 스타일 |
| **brain** | 선택적 부가 기능 (검색, 과거 토론 참조, 컨텍스트 보강). critical path에 없음. |

---

## 4. 세션 간 인터페이스 (확정)

### 4.1 telepty → aterm (직접)
- 세션 목록: `telepty list`
- PTY 스트리밍: WS `/api/sessions/:id`
- 이벤트 구독: WS `/api/bus` (session_register, inject_written, submit)
- 메시지 전송: `POST /api/sessions/:id/inject`
- 세션 상태: `GET /api/sessions?idle_gt=N`

### 4.2 deliberation → aterm (직접)
- 연동: deliberation MCP 14개 도구 직접 호출
- synthesis 포맷: structured JSON `{ summary, decisions, actionable_tasks }`
- 이벤트: telepty 버스 경유 턴 완료 알림

### 4.3 brain (선택적)
- 크로스세션 컨텍스트 검색 (필요 시)
- 과거 토론 결과 참조 (필요 시)
- critical path에 없음 — aterm이 직접 telepty/deliberation과 통신

### 4.4 telepty 추가 개발 (합의 완료)

| 항목 | 우선순위 |
|------|---------|
| session_disconnect 이벤트 | HIGH |
| PTY 출력 히스토리 API | MEDIUM |
| 세션 heartbeat (30s) | MEDIUM |
| inject_received ACK | MEDIUM |

---

## 5. UI 레이아웃 (카카오톡 스타일)

```
┌──────────────────────────────────────────┐
│  aterm                                    │
├──────────┬───────────────────────────────┤
│          │  brain                         │
│ 친구 탭   │  ┌─────────────────────┐      │
│ 🟢 brain  │  │ 사용자: fix this bug │      │
│ 🟢 telepty│  └─────────────────────┘      │
│ 🟢 design │       ┌──────────────────┐    │
│ ⚫ starter│       │ brain: Fixed ✓   │    │
│ 🟢 devkit │       │ ```js            │    │
│          │       │ const x = 42;    │    │
│ 채팅 탭   │       │ ```              │    │
│ 💬 brain  │       └──────────────────┘    │
│ 💬 그룹1  │  ── Phase 2: 수렴 시작 ──     │
│          │       ┌──────────────────┐    │
│          │       │ brain: 동의.     │    │
│          │       └──────────────────┘    │
│          │  ┌──────────────────────────┐ │
│          │  │ 메시지 입력...    [전송]   │ │
│          │  └──────────────────────────┘ │
│ [터미널 토글]                              │
├──────────┴───────────────────────────────┤
│  Cmd+K: group, deliberate, theme...      │
└──────────────────────────────────────────┘
```

---

## 6. MVP 페이즈

### Phase 1: 1:1 채팅 뷰 (HIGH)
- 세션 목록 → 카톡 스타일 친구/채팅 탭
- 채팅방 UI (버블 + 코드블록 + 카드 + 헤드메세지)
- 컨텍스트 분석 → 렌더링 엔진
- 입력창 → PTY stdin 연결
- 터미널 토글 패널
- Claude CLI 네이티브 기능 100% 유지

### Phase 2: 그룹채팅 (MEDIUM)
- 그룹채팅 UI (멀티 참여자 버블)
- deliberation MCP 연동
- 2단계 하이브리드 자동 진행 UI
- Cmd+K에 에코시스템 명령어 통합

### Phase 3: 확장 (LOW)
- Codex/Gemini CLI 지원 (PtySessionAdapter)
- 큐 기반 안전 주입
- brain 검색 연동

---

## 7. 큐 기반 주입 (범용 솔루션)

모든 CLI에 적용 가능한 inject 안전 주입:

```
inject → aterm 큐 → idle 감지 (프롬프트 표시 + 사용자 미입력) → PTY에 주입
```

- 사용자 타이핑 중이면 대기
- Claude/Codex/Gemini/bash 모두 지원 (PTY 레벨 동작)
- 프롬프트 패턴으로 idle 감지: Claude `❯`, Codex `>`, bash `$`

---

## 8. Consensus Record

- **멀티 LLM**: claude(critic) + codex(implementer) + gemini(researcher) — 3라운드 만장일치
- **세션 토론**: brain + design + telepty + deliberation + aterm — 전원 동의
- **사용자 추가 결정**: 카톡 UI/UX, brain critical path 제거, 터미널 토글만, Claude 네이티브 100%, 컨텍스트 렌더링 (버블/카드/헤드메세지)
- **날짜**: 2026-03-21
- **아카이브**: deliberation-2026-03-21T1116-aterm-메신저-UX-재설계
