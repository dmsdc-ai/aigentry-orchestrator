# aterm 5플랫폼 아키텍처 (확정)

## 구조: wgpu-in-app (네이티브 앱 쉘 + Rust 코어)

```
aterm-core (Rust, 공유)
  ├── 터미널 코어: alacritty_terminal (VTE 파서 + Term 상태)
  ├── PTY 관리: portable-pty (데스크탑) / telepty 원격 (모바일)
  ├── 렌더링: wgpu (Metal/Vulkan/DX12)
  ├── 텍스트: glyphon (셰이핑/래스터라이징)
  ├── 네트워킹: tailscale tsnet + headscale (mesh VPN)
  ├── 세션 통신: telepty 클라이언트
  └── async: tokio

aterm-shell (플랫폼별 네이티브, 얇은 쉘)
  ├── macOS: Swift/AppKit — NSWindow + CAMetalLayer + NSTextInputClient
  ├── iOS: Swift/UIKit — UIWindow + CAMetalLayer + UITextInput
  ├── Android: Kotlin/Jetpack — Activity + SurfaceView(Vulkan) + InputMethodManager
  ├── Windows: Rust/Win32 — HWND + DX12 (winit 사용 가능, IME 정상)
  └── Linux: Rust/GTK or winit — GtkWindow + Vulkan (winit 사용 가능, IME 테스트 필요)
```

## 레이어별 담당

| 레이어 | Rust 공유 코드 | 플랫폼별 코드 |
|--------|:------------:|:------------:|
| 터미널 코어 (VTE, PTY) | ✅ | — |
| 렌더링 (wgpu) | ✅ | — |
| tailscale mesh | ✅ | — |
| telepty 클라이언트 | ✅ | — |
| 앱 창 생성 | — | ✅ 각 OS별 |
| IME (한글 입력) | — | ✅ 각 OS별 (OS 자동 처리) |

## 플랫폼별 상세

### macOS (P1 — 현재 개발 중)
- 쉘: Swift/AppKit
- 창: NSWindow → NSView + CAMetalLayer
- IME: NSTextInputClient (Ghostty 패턴 참조)
- PTY: 로컬 (portable-pty)
- 렌더링: wgpu Metal 백엔드
- 참고: Ghostty가 동일 패턴으로 검증 완료

### iOS (P2)
- 쉘: Swift/UIKit
- 창: UIWindow → UIView + CAMetalLayer
- IME: UITextInput (OS 소프트 키보드)
- PTY: 원격 (tailscale + telepty) — Apple 정책상 로컬 쉘 제한
- 렌더링: wgpu Metal 백엔드
- Safe Area/노치 처리 필요

### Android (P2)
- 쉘: Kotlin/Jetpack Compose
- 창: Activity → SurfaceView
- IME: InputMethodManager (OS 소프트 키보드)
- PTY: 로컬 가능 (Termux 방식) + 원격 (tailscale + telepty)
- 렌더링: wgpu Vulkan 백엔드
- 디바이스 파편화 주의 (Vulkan 드라이버 차이)

### Windows (P2)
- 쉘: Rust (winit 사용 가능 — IME 정상 동작 확인)
- 창: HWND (winit 또는 Win32 직접)
- IME: TSF (winit으로 충분)
- PTY: 로컬 (ConPTY)
- 렌더링: wgpu DX12 백엔드

### Linux (P2)
- 쉘: Rust (winit 사용 가능 — IME 테스트 필요)
- 창: GtkWindow 또는 winit
- IME: IBus/Fcitx (winit으로 충분할 가능성, 테스트 후 결정)
- PTY: 로컬 (portable-pty)
- 렌더링: wgpu Vulkan 백엔드

## 구현 우선순위

| 순서 | 플랫폼 | 이유 |
|------|--------|------|
| 1 | macOS | 현재 사용 중, IME 문제 해결 급선무 |
| 2 | Linux | 서버 접속용, winit으로 충분할 수 있음 |
| 3 | Windows | winit IME 정상, 추가 작업 최소 |
| 4 | iOS | tailscale 내장 후 원격 접속 |
| 5 | Android | tailscale 내장 후 원격 접속 |

## 코드 구조 + 세션 할당

```
aigentry-aterm/
  aterm-core/              # Rust 코어 (공유 로직)
    Cargo.toml
    src/
      lib.rs               # FFI 인터페이스 노출
      terminal/            # VTE, Term 상태
      pty/                 # PTY 관리
      net/                 # tailscale, telepty
      render/              # wgpu 렌더링 로직

  macos/                   # Swift 쉘 (Xcode 프로젝트)
    aterm.xcodeproj
    Sources/
      AppDelegate.swift
      TerminalView.swift   # NSView + CAMetalLayer + NSTextInputClient

  ios/                     # Swift 쉘 (Xcode 프로젝트)
    aterm-ios.xcodeproj
    Sources/

  android/                 # Kotlin 쉘 (Gradle 프로젝트)
    app/
    build.gradle.kts

  desktop/                 # Rust 쉘 (Windows/Linux — winit 유지)
    Cargo.toml
    src/main.rs

  AGENTS.md                # 공통 가이드
```

### 세션 할당 전략

| 모듈 | 언어 | 담당 세션 | 병렬 가능 |
|------|------|----------|:--------:|
| aterm-core/ | Rust | aterm-codex (구현) / aterm-claude (리뷰) | — |
| macos/ | Swift | 별도 세션 (aterm-macos-claude) | ✅ 코어와 병렬 |
| ios/ | Swift | 별도 세션 (macos와 공유 가능) | ✅ 코어와 병렬 |
| android/ | Kotlin | 별도 세션 (aterm-android-codex) | ✅ 코어와 병렬 |
| desktop/ | Rust | aterm-codex (코어와 동일 세션) | — |
| 리서치/문서 | — | aterm-gemini | ✅ 항상 병렬 |

### 원칙
- 동일 모듈 동시 수정 금지 (원칙 9)
- 다른 모듈은 동시 작업 OK (언어/빌드시스템 완전 분리)
- aterm-claude = 리뷰 + 통합 + 아키텍처 (코드 수정은 세션에 위임)
- 코어 API 변경 시 → 모든 쉘 세션에 브로드캐스트

## 핵심 결정 근거

1. **winit IME 한계 확인**: macOS/iOS/Android에서 한글 조합 불가 (7회+ 패치 실패)
2. **Ghostty 패턴 검증**: 네이티브 앱 쉘 + 크로스플랫폼 렌더링이 정답
3. **tailscale 내장**: 크로스머신 zero-config mesh networking (tsnet BSD-3 + headscale BSD-3)
4. **wgpu-in-app**: IME는 OS 네이티브, 렌더링만 wgpu 공유 → IME 에포트 제로

## 기술스택 5플랫폼 호환성 (검증 완료)

| 의존성 | macOS | Linux | Windows | Android | iOS |
|--------|:-----:|:-----:|:-------:|:-------:|:---:|
| Rust | ✅ | ✅ | ✅ | ✅ (JNI) | ✅ (C-FFI) |
| wgpu | ✅ Metal | ✅ Vulkan | ✅ DX12 | ✅ Vulkan/GLES | ✅ Metal |
| glyphon | ✅ | ✅ | ✅ | ✅ | ✅ |
| alacritty_terminal | ✅ | ✅ | ✅ | ✅ | ✅ |
| portable-pty | ✅ | ✅ | ✅ ConPTY | ✅ fork/exec | ❌ Sandbox |
| tsnet | ✅ | ✅ | ✅ | ✅ (+15-25MB) | ✅ (+15-25MB) |
| tokio | ✅ | ✅ | ✅ | ✅ | ✅ |

### 모바일 주의사항
- iOS: App Sandbox로 로컬 쉘 불가 → tailscale + telepty 원격 전용
- Android: Vulkan 드라이버 파편화 → GLES 폴백 필수
- 모바일 공통: UI 스레드 블로킹 금지, Safe Area 처리, 터치→VTE 매핑 직접 구현

## 참조
- Ghostty: Zig 코어 + Swift(macOS)/GTK(Linux) 쉘 — 동일 패턴
- 카카오톡: 공통 로직 공유 + 플랫폼별 네이티브 앱
- Bevy Engine: winit + wgpu 5플랫폼 사례 (게임, IME 불필요)
