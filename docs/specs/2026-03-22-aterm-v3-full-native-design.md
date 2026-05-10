# aterm v3 — Full Native Architecture

**Date:** 2026-03-22
**Status:** Approved
**Previous:** 2026-03-21-aterm-messenger-ux-design.md (v2 스펙, 아키텍처 부분 대체)

---

## 1. 목표

WebView(Tauri + xterm.js)를 완전히 제거하고, GPU 네이티브 터미널로 전환.
UX는 v2와 동일 유지. 성능, 안정성, IME를 근본적으로 해결.

### 해결하는 문제
- 한글 IME 자모 분리 (WKWebView + xterm.js 근본 결함)
- 터미널 렌더링 깨짐 (fitAddon 레이스 컨디션)
- 흰 화면 (WebView 로딩 실패)
- 메모리 과다 (WebView 프로세스 150-200MB)
- 시작 속도 (WebView 초기화 2-3초)

---

## 2. 기술 스택

| 레이어 | 기술 | 역할 |
|--------|------|------|
| **GPU 렌더링** | wgpu | Metal(Mac)/Vulkan(Linux)/DX12(Win) |
| **터미널 엔진** | alacritty_terminal | VT 파싱, 셀 그리드, 스크롤백 |
| **UI 프레임워크** | iced | 사이드바, Cmd+K, 그룹 그리드, 테마 |
| **윈도우** | winit (iced 내장) | 크로스플랫폼 윈도우 관리 |
| **IME** | 플랫폼 네이티브 | Mac: NSTextInputClient, Linux: IBus/Fcitx |
| **PTY** | portable-pty | PTY 관리 (현재 코드 재사용) |
| **세션** | Rust core | 세션 저장/복원, telepty 연동 (재사용) |

### 레퍼런스
- **Cosmic Term** (System76): iced + alacritty_terminal — 프로덕션 검증
- **Rio**: wgpu + alacritty_terminal — 프로덕션 검증
- **Zed Terminal**: GPUI + alacritty_terminal — 프로덕션 검증

---

## 3. 아키텍처

```
aterm v3
├── 렌더링: iced (wgpu 기반)
│   ├── 터미널 위젯: alacritty_terminal + 커스텀 iced widget
│   ├── 사이드바: iced scrollable + button
│   ├── Cmd+K: iced modal + text_input
│   └── 그룹 그리드: iced responsive grid
│
├── IME: 플랫폼 네이티브 (objc2 브릿지)
│
├── Core (lib.rs 재사용 95%):
│   ├── portable-pty (PTY 관리)
│   ├── 세션 관리 (sessions.json)
│   ├── telepty 연동 (CLI 호출)
│   ├── 그룹/딜리버레이션
│   └── 큐 기반 inject
│
└── 빌드 산출물: 단일 네이티브 바이너리 (~10MB)
```

---

## 4. 크로스 레이어

| 크로스 | 구현 | 프로토콜 |
|--------|------|---------|
| **Cross-Session** | telepty inject/reply/broadcast + 큐 기반 안전 주입 | JSON over PTY |
| **Cross-Tool** | telepty session.backend 세션별 라우팅 | 도구별 적응 레이어 |
| **Cross-Machine** | telepty SSH 터널 + peer federation | JSON-RPC over SSH |
| **Cross-OS** | wgpu(렌더) + Rust(로직) + telepty(통신) 크로스플랫폼 | 플랫폼별 IPC만 분기 |

---

## 5. UX (v2와 동일)

### 5.1 사이드바
- 세션 목록: 이름 + 상태 dot (online/busy/offline/stale)
- TELEPTY 세션: 자동 발견 (telepty list)
- 그룹 섹션: 그룹명 + 참여 세션 수
- + 버튼: 새 세션 생성

### 5.2 1:1 뷰
- 세션 클릭 → 터미널 풀스크린 (GPU 렌더링)
- 세션 헤더: 이름 + cwd + 상태

### 5.3 그룹 그리드 뷰
- 그룹 클릭 → 참여 세션 터미널을 자동 그리드 배치
- 2개: 50/50, 3개: 2+1, 4개: 2x2, 5+: ceil(sqrt(n))
- 토픽 입력바 + Phase 표시 + 수렴 버튼
- 2단계 하이브리드: 병렬 발산 → 자동 수렴

### 5.4 Cmd+K 커맨드 팔레트
- deliberate: 멀티 LLM 딜리버레이션 시작
- group: 그룹 생성
- broadcast: 그룹 메시지 전송
- theme: 테마 변경

---

## 6. 성능 목표

| 항목 | v2 (현재) | v3 (목표) |
|------|----------|----------|
| 메모리 | 150-200MB | 30-40MB |
| 시작 속도 | 2-3초 | 0.3초 |
| 바이너리 크기 | 85MB | 10MB |
| FPS (대량출력) | 40-50fps | 60fps |
| 한글 IME | vendor patch | OS 네이티브 |

---

## 7. 코드 재사용

| 현재 코드 | 재사용율 | 비고 |
|----------|---------|------|
| lib.rs PTY 관리 | 95% | #[tauri::command] 제거만 |
| 세션 저장/복원 | 100% | sessions.json 그대로 |
| telepty 연동 | 100% | CLI 호출 그대로 |
| 그룹/딜리버레이션 로직 | 20% 비즈니스 로직 재사용 + 60% UI 재작성 | App.svelte → Rust 이전 |
| Svelte UI | 0% | iced 위젯으로 재작성 |
| xterm.js | 0% | alacritty_terminal로 교체 |
| Tauri | 0% | winit(iced 내장)로 교체 |

---

## 8. 구현 순서

```
Phase 1: 기반
  #9 스펙 문서 ✓
  #10 프로젝트 셋업 (Cargo + iced 윈도우)

Phase 2: 코어 (병렬)
  #11 Core 모듈 추출 (lib.rs → 순수 Rust)
  #12 터미널 위젯 (alacritty_terminal + wgpu)

Phase 3: 통합
  #13 IME 네이티브 브릿지 (NSTextInputClient)
  #14 사이드바 + Cmd+K (iced 위젯)

Phase 4: 기능
  #15 그룹 그리드 + 2단계 하이브리드

Phase 5: 배포
  #16 빌드 + 패키징 (.app 번들)
```

---

## 9. 삭제 대상

v3 완성 후 제거:
- `src/` (Svelte 전체)
- `src-tauri/` (Tauri 전체)
- `index.html`
- `vite.config.js`
- `package.json` (npm 의존성)
- `node_modules/`

최종 프로젝트 구조:
```
aigentry-aterm/
├── Cargo.toml
├── src/
│   ├── main.rs
│   ├── app.rs          (iced 앱)
│   ├── core/           (PTY, 세션, telepty)
│   ├── terminal/       (alacritty_terminal + wgpu 위젯)
│   ├── ui/             (사이드바, Cmd+K, 그룹 그리드)
│   └── ime/            (플랫폼 IME 브릿지)
└── assets/             (아이콘, 폰트)
```
