# Queue-based PTY Injection — Idle 감지 안전 주입

**Date:** 2026-03-22
**Status:** Approved
**Project:** aigentry-aterm

---

## 1. Problem

telepty inject가 사용자 타이핑 중에 도착하면 사용자 입력과 inject 텍스트가 섞여 깨짐.

## 2. Solution

inject → aterm 큐 → CLI idle 감지 → 안전 주입

## 3. Components

### 3.1 InjectQueue (Rust 백엔드, lib.rs)

```rust
struct InjectQueue {
    messages: VecDeque<InjectMessage>,
}

struct InjectMessage {
    from: String,
    text: String,
    timestamp: u64,
}
```

- 워크스페이스별 메시지 큐
- Tauri command: `queue_inject(id, from, text)` → 큐에 push
- Tauri command: `peek_queue(id)` → 큐 상태 조회
- Tauri event: `inject-queued` → 프론트엔드에 뱃지 업데이트

### 3.2 IdleDetector (Rust 백엔드, lib.rs)

reader_loop 내에서 PTY 출력 분석:

```rust
struct IdleState {
    prompt_detected: bool,
    last_user_input: Instant,
    idle_threshold: Duration, // 2초
}
```

- PTY 출력에서 프롬프트 패턴 감지: `❯`, `>`, `$`, `%`
- 패턴은 워크스페이스별 설정 가능 (기본: `["❯", "> ", "$ ", "% "]`)
- 사용자 키 입력 시 `last_user_input` 갱신
- 프롬프트 감지 + last_user_input 후 2초 경과 = idle
- idle 시 큐에서 pop → PTY writer에 write + `\n`

### 3.3 큐 상태 UI (프론트엔드)

- 세션 헤더 또는 사이드바에 대기 메시지 수 뱃지
- Tauri event `inject-queued` / `inject-delivered` 구독
- 클릭 시 큐 내용 목록 표시 (선택적)

## 4. Flow

```
1. telepty inject → aterm Rust 백엔드 수신 (Tauri command or telepty 연동)
2. InjectQueue에 push
3. 프론트엔드에 inject-queued 이벤트 → 뱃지 업데이트
4. reader_loop에서 PTY 출력 모니터링
5. 프롬프트 패턴 감지 → idle_check 시작
6. 2초 후 사용자 입력 없음 확인 → idle
7. 큐에서 pop → PTY에 write(text + "\n")
8. 프론트엔드에 inject-delivered 이벤트 → 뱃지 감소
```

## 5. telepty 연동

현재 telepty inject는 PTY stdin에 직접 쓰는 방식. 변경:
- aterm이 telepty inject를 수신하는 경로 필요
- 방법 A: telepty가 aterm의 Tauri command를 호출 (IPC)
- 방법 B: aterm이 telepty 이벤트 버스를 구독하여 inject 이벤트 수신
- 방법 C: telepty inject가 aterm의 큐 API를 직접 호출 (HTTP/Unix socket)

가장 정석적: **방법 B** — aterm이 telepty 이벤트 버스(`/api/bus`)를 WS로 구독, `inject_written` 이벤트를 수신하여 큐에 넣음.

## 6. 범용성

| CLI | 프롬프트 패턴 |
|-----|-------------|
| Claude Code | `❯` |
| Codex CLI | `>` |
| Gemini CLI | `❯` |
| bash | `$` |
| zsh | `%` |

패턴은 워크스페이스 생성 시 설정 가능. 기본값 제공.

## 7. 구현 범위

### Phase 1 (MVP)
- InjectQueue + IdleDetector in lib.rs
- queue_inject / peek_queue Tauri commands
- reader_loop에서 프롬프트 패턴 감지 + idle 체크
- 세션 헤더에 대기 수 뱃지

### Phase 2
- telepty 이벤트 버스 연동
- 큐 내용 목록 UI
- 프롬프트 패턴 커스텀 설정
