# 딥리서치 프롬프트: aterm v3 한글 IME 자모 분리 버그

## 프로젝트 개요
aterm v3는 순수 Rust 네이티브 터미널 앱.
- Tech Stack: Rust + iced 0.14 (wgpu) + alacritty_terminal + winit 0.30.13 (vendored)
- macOS에서 한글(Korean) IME 입력 시 자모가 분리되는 치명적 버그
- 기대: "한글" → 실제: "ㅎㅏㄴㄱㅡㄹ" + 로마자 "gksrmf" 혼재

## 아키텍처
```
macOS 키보드 → winit (vendored 0.30.13) → iced 0.14 → aterm widget.rs → PTY
                  ↑
       NSTextInputClient (winit의 WinitView)
       interpretKeyEvents → insertText / setMarkedText / doCommandBySelector
```

## 실패한 접근 (6회+, 전부 winit view.rs 패치)

1. **Ghostty keyTextAccumulator 패턴**: insertText에서 accumulator에 누적 → keyDown 복귀 후 한 번만 전송. 결과: 자모 분리 지속.

2. **hasMarkedText 가드**: insertText에서 marked text 있을 때만 accumulator 사용. 결과: 자모 분리 지속.

3. **input_source_changed 키 억제**: 한/영 전환 감지 시 해당 키 삼킴. 결과: 영문 첫 글자 유실.

4. **TIS 동기 비교**: interpretKeyEvents 전후로 TISCopyCurrentKeyboardInputSource 비교. 결과: 자모 분리 지속.

5. **Rio ImeState FSM 통째로 포팅**: Disabled→Ground→Preedit→Committed 4-state FSM. 결과: Enter 키 regression + 자모 분리 지속.

6. **set_ime_allowed Disabled→Ground 전이**: 앱 시작 시 ime_state를 Ground로 초기화. 결과: set_ime_allowed 자체가 호출되지 않음. 75초 후 호출되어도 자모 분리 지속.

7. **insertText in_key_event 가드 제거**: 한글 첫 키도 Commit 경로. 결과: 미확인 (3가지 동시 적용으로 개별 효과 불명).

## Logger 분석에서 확인된 사실

### Root Cause
1. **첫 키가 IME를 우회**: KeyPressed key=Character("ㅎ") composing=false — raw jamo로 PTY 전달
2. **2번째 키에서야 IME 활성**: InputMethod::Opened 이벤트 발생
3. **Preedit 순간 조합 성공 → 즉시 분해**: Preedit("아") composing=true 순간 존재했으나 유지 안 됨
4. **macOS IMK 조합 엔진은 정상**: 문제는 winit 레이어

### 이벤트 시퀀스 (실제 로그)
```
[한글 "한" 입력 시도]
KeyPressed key=Character("ㅎ") composing=false  ← IME 우회! raw jamo
InputMethod::Opened                              ← 2번째 키에서야 IME 활성
Commit("ㅏ")                                     ← 개별 커밋
Commit("ㄴ ")                                    ← 개별 커밋
```

### set_ime_allowed 호출 타이밍
- 앱 시작 후 약 75초간 set_ime_allowed(true) 미호출
- 75초 후 호출되어도 자모 분리 여전
- NativeImeHandler: 코드 존재하나 main.rs에서 wire-up 안 됨 (dead code)

## 같은 스택 터미널의 해결 방식

### Alacritty (Rust + winit + alacritty_terminal)
- winit 내장 IME 100% 의존
- 한글 자모 분리 버그 존재 (미해결) — GitHub #6942, #8079

### Rio (Rust + winit fork: rio-window)
- winit을 포크하여 ImeState 4-state FSM 직접 구현
- doCommandBySelector에 한글 명시적 가드
- input source 변경 감지로 한/영 전환 처리
- 대부분 해결되나 첫 키 갭 가능성 존재

### Ghostty (Zig + Metal)
- winit 미사용. NSTextInputClient를 Zig로 직접 구현
- keyTextAccumulator 패턴으로 이중 입력 원천 차단
- KeyboardLayout.id로 한/영 전환 동기 감지
- 완전 해결

### Warp (Rust + 독자 레이어)
- 커스텀 NSView로 IME 직접 제어
- 완전 해결

## aterm 현재 코드 구조

### vendor/winit-0.30.13/src/platform_impl/macos/view.rs
- WinitView: NSView 서브클래스, NSTextInputClient 구현
- keyDown → interpretKeyEvents → insertText/setMarkedText/doCommandBySelector
- ImeState: Disabled/Ground/Preedit/Committed
- Rio 패턴 일부 적용됨 (in_key_event, Committed forward 차단 등)

### src-v3/terminal/widget.rs
- iced Widget 구현
- InputMethod::Commit → PTY 전송
- InputMethod::Preedit → ime_composing 플래그
- ime_composing=true 시 KeyPressed 차단

### src-v3/ime/macos.rs
- NativeImeHandler: OnceLock 싱글턴
- NSEvent local monitor로 KeyDown/KeyUp/FlagsChanged 가로챔
- AtermImeView: NSView 서브클래스, NSTextInputClient 준수
- **비활성화 사유**: monitor가 active일 때 모든 키를 소비 → winit이 영문 키도 못 받음

## 리서치 요청

### 질문 1: winit 0.30+ macOS IME 한글 처리
- winit GitHub issues/PRs에서 Korean IME 관련 이슈 찾기
- 최신 winit (0.31+, main branch)에서 이 문제가 해결됐는지
- 첫 키가 raw로 빠지는 것이 알려진 버그인지

### 질문 2: iced + winit IME 통합
- iced 0.14가 winit의 IME를 어떻게 래핑하는지
- iced가 set_ime_allowed를 언제 호출하는지
- iced에서 IME를 올바르게 설정하는 방법

### 질문 3: winit 대안
- winit 외에 Rust에서 macOS 윈도우/이벤트 처리할 수 있는 라이브러리
- baseview, glazier, tao 등에서 Korean IME 지원 상태
- winit을 완전 우회하고 NSApplication/NSView를 Rust에서 직접 사용하는 방법

### 질문 4: NativeImeHandler 재활성화 가능성
- winit의 WinitView와 별도 NSView(AtermImeView)를 공존시키는 방법
- NSEvent local monitor가 모든 키를 가로채는 문제의 해결책
- monitor 대신 NSTextInputContext를 직접 사용하는 방법

### 질문 5: 근본적으로 다른 접근
- IME를 별도 텍스트 입력 필드(숨겨진 NSTextField)로 처리 → 커밋된 텍스트만 PTY로 전송
- Kitty 터미널의 접근법 (Kitty도 GPU 렌더링 + 자체 IME)
- WezTerm의 접근법 (Rust 터미널, macOS IME 지원)

## 핵심 제약
- iced 0.14 사용 필수 (UI 프레임워크)
- alacritty_terminal 사용 (터미널 에뮬레이터)
- macOS 네이티브 한글 IME 완벽 지원 필요
- 영문 입력도 정상 동작 필수
- Enter/Backspace/화살표 등 특수키 정상 동작 필수
