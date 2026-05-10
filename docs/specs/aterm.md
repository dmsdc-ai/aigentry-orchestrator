# aterm — AI Agent Orchestration Messenger

## Vision
aterm = aigentry dedicated messenger/terminal. "Messenger shell + CLI internals". Manage AI agent sessions like a messenger, but internally powered by telepty + PTY-based CLI execution environment. Transcend traditional terminal limitations (black screen + text) with a new interface optimized for AI orchestration.

## Core UX (Multi-LLM Consensus)

| Area | Motif | Implementation |
|------|-------|----------------|
| Left sidebar | File tree (VS Code) | Session Tree: project → session (2-level default, drill-down) |
| Center panel | Messenger timeline | Message + Event unified timeline (turn, inject, synthesis) |
| Action layer | Raycast Command Palette | Cmd+K → session search/create/inject/deliberation start |
| Right panel | IDE Inspector | Metadata, PTY state, machine connection, artifacts |
| Input | Telegram hybrid | Natural language first, /command secondary, inline action buttons |

### Design Principles
1. Progressive Disclosure: Single mode, complexity revealed gradually (No Simple/Pro split)
2. Session Tree is first-class entity — NOT channels
3. Jakob's Law: Familiar messenger mental model, novel navigation only
4. State-centric: Conversation content and execution state (PTY, daemon, machine) displayed separately

## Tech Stack
- Framework: Tauri (Rust + WebView) — lightweight, cross-platform (macOS + Linux)
- Frontend: Svelte — reactive, minimal bundle
- Communication: telepty WS native integration (daemon WebSocket + PTY)
- Styling: TailwindCSS

## MVP Scope (Phase 1)

### Must Have
1. Session Tree sidebar (2-level: project/session)
2. Message + Event timeline (text messages, system events visually separated)
3. Command Palette (Cmd+K) with session CRUD + inject
4. telepty daemon connection (WS) — session list, inject, broadcast
5. PTY integration — run Claude/Codex/Gemini CLI in embedded terminal
6. Cross-machine session display (local vs remote@host indicator)

### Nice to Have (Phase 2)
7. Deliberation Theater panel (debate visualization, speaker timeline)
8. Brain memory status sidebar widget
9. Verdict cards (drag-to-prioritize actionable_tasks)
10. Consensus heatmap (real-time agreement visualization)

### Out of Scope (Phase 3+)
11. 3D session visualization
12. Mobile app
13. Browser extension

## Architecture

```
┌─────────────────────────────────────────────┐
│                 aterm (Tauri)                │
│  ┌──────────┬──────────────┬──────────────┐ │
│  │ Session  │   Message    │  Inspector   │ │
│  │  Tree    │  Timeline    │   Panel      │ │
│  │ (Svelte) │  (Svelte)    │  (Svelte)    │ │
│  └──────────┴──────────────┴──────────────┘ │
│  ┌──────────────────────────────────────────┐│
│  │        Command Palette (Cmd+K)          ││
│  └──────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────┐│
│  │      Embedded PTY (xterm.js)            ││
│  └──────────────────────────────────────────┘│
├─────────────────────────────────────────────┤
│              Tauri Rust Backend              │
│  ┌──────────┬────────────┬─────────────────┐│
│  │ telepty  │  PTY       │  Session        ││
│  │ WS Client│  Manager   │  State Store    ││
│  └──────────┴────────────┴─────────────────┘│
└─────────────────────────────────────────────┘
         │              │              │
    telepty daemon    Claude CLI    Remote hosts
    (localhost:3848)   (PTY)      (Tailscale)
```

## Per-Project Contributions

| Project | Contribution to aterm | Priority |
|---------|----------------------|----------|
| telepty | WS client library, session discovery API, inject/broadcast protocol | P0 |
| deliberation | Theater panel (debate visualization), verdict cards, consensus heatmap | P1 |
| brain | Memory status widget, context search integration | P2 |
| dustcraw | Experiment progress indicator, signal feed widget | P2 |
| registry | Agent leaderboard widget, experiment log viewer | P2 |
| amplify | Content preview panel, publish status | P3 |
| devkit | Installation wizard, health check panel | P1 |
| ssot | Contract viewer, schema browser | P3 |

## Consensus Record
- Source: 2 multi-LLM deliberations (claude+codex+gemini)
  - Session 1: aigentry-packaging-strategy-and-business-mmxc7ybqe89q
  - Session 2: ai-agent-orchestration-messenger--mmxg7jbbi84w
- Cross-session discussions: 8 aigentry sessions via telepty
- Date: 2026-03-19
- All participants: AGREE

## cmux Benchmarking (AGPL 회피, 처음부터 구현)

### cmux에서 벤치마킹할 아키텍처 패턴

1. **Unix socket 통신**: 앱 내 프로세스만 접근 가능. 보안+성능.
2. **CLI 제어**: `aterm send`, `aterm send-key`, `aterm read-screen` 등
3. **PTY 직접 소유**: 터미널 에뮬레이터가 PTY를 직접 관리 → submit 100% 보장
4. **Workspace/Pane/Surface 계층**: workspace > pane > surface 3단계
5. **사이드바 메타데이터**: set-status, set-progress, log
6. **네이티브 알림**: notify 명령
7. **화면 읽기**: read-screen으로 PTY 출력 프로그래밍 접근

### aterm CLI 명령어 (cmux 벤치마킹 + aigentry 확장)

```
# cmux 대응 (처음부터 구현)
aterm send --workspace <id> "텍스트"
aterm send-key --workspace <id> return
aterm read-screen --workspace <id>
aterm notify --title "제목" --body "내용" --workspace <id>
aterm set-status <key> <value> --workspace <id>
aterm set-progress 0.7 --workspace <id>
aterm list-workspaces
aterm new-workspace --cwd <path> --command "telepty allow ..."
aterm close-workspace --workspace <id>

# aigentry 확장 (cmux에 없는 것)
aterm inject --session <session-id> "메시지"     # telepty inject 대체
aterm broadcast "메시지"                          # 전체 세션 전송
aterm deliberate --topic "주제"                   # 토론 시작
aterm status                                      # 전 세션 상태 요약
aterm layout                                      # 그리드 재배치
```

### 기술 스택 확정

- **터미널 렌더링**: libghostty (cmux와 동일) 또는 xterm.js (웹 기반)
- **앱 프레임워크**: Tauri (Rust + WebView)
- **소켓 통신**: Unix domain socket (Rust 구현)
- **CLI**: Rust clap (단일 바이너리)
- **프론트엔드**: Svelte + TailwindCSS
- **라이선스**: MIT (AGPL 회피)

## 핵심 아키텍처 변경: 앱=허브 (데몬 불필요)

cmux 벤치마킹의 가장 중요한 패턴: **앱 자체가 서버. 별도 daemon 불필요.**

```
현재 (telepty 의존):
  telepty daemon (별도 프로세스) → HTTP/WS → 세션 관리
  aterm → telepty daemon에 의존

변경 (cmux 패턴):
  aterm 앱 자체가 허브
  ├── Unix socket (~/.aterm/aterm.sock)
  ├── PTY 직접 소유 (모든 세션)
  ├── CLI (aterm send/send-key/read-screen)
  └── 앱 열면 자동 시작, 닫으면 자동 종료

  telepty → 크로스 머신 때만 활성화 (로컬에서는 불필요)
```

### 생명주기
- `open -a aterm` → 앱 시작 = socket 생성 = 허브 활성
- `aterm new-workspace --cwd ~/projects/aigentry-brain/` → PTY 생성
- `aterm send --workspace brain "message"` → CLI로 제어
- 앱 닫기 → socket 삭제 = 깔끔한 종료

### telepty와의 관계
- 로컬: aterm이 허브. telepty daemon 불필요.
- 크로스 머신: telepty daemon이 SSH 터널 관리. aterm은 원격 세션을 표시만.
- aterm은 telepty를 대체하는 것이 아니라, 로컬 허브 역할을 흡수.
