# Diagnostic Report — cmux 신규 workspace "pane not ready" 3연속 회귀 (tq#605)

- **Date**: 2026-06-13
- **Role**: analyst (runtime root-cause, READ-ONLY — no code change, no cmux restart/build/kill)
- **Target**: cmux source `/Users/duckyoungkim/projects/cmux` + orchestrator `/Users/duckyoungkim/projects/aigentry-orchestrator/bin/open-session.sh`
- **Method**: source grep/read + live process/socket/crash-log inspection (non-destructive). cmux 프로세스 비접촉.

---

## 1. 증상 재진술 (관측 사실)

- `bin/dispatch.sh --spawn-and-dispatch` 가 신규 cmux workspace 를 **3연속** 열지 못함:
  `ERR cmux workspace workspace:194/195/196 pane not ready after 10000/10000/30000ms`.
- 직전 성공: ~40분 전 vfy-063 = `workspace:193`. 그 사이 다른 spawn 없음.
- "데몬 realign" 후 회복 → 죽은 194/195/196 사라지고 신규 spawn(197) 정상.

실패 게이트의 정확한 위치: 오케스트레이터 `bin/open-session.sh` `_cmux_wait_ready()` (`open-session.sh:183-207`),
실패 echo `:231`, 실패 시 cleanup `:232`.

---

## 2. 아키텍처 / Lifecycle (텍스트 다이어그램, 증거 기반)

```
orchestrator open-session.sh:224   cmux new-workspace --command "... telepty allow ... claude ..."
        │  (Unix socket: ~/Library/Application Support/cmux/cmux.sock)   [CLI/cmux.swift:940-970]
        ▼
cmux GUI app (PID 18763)  ── V2 JSON-RPC method "workspace.create"
        │  TerminalController.v2WorkspaceCreate → tabManager.addWorkspace()   (MAIN ACTOR)
        │      → workspace 레코드 생성 + 카운터++ (싸다, 즉시 성공 → 194/195/196 ref 반환됨)
        ▼
SwiftUI 레이아웃이 새 탭의 hostedView 를 NSWindow 에 add  ── (★ 비결정적 타이밍)
        ▼
GhosttyTerminalView.attachToView(view)               [GhosttyTerminalView.swift:3497]
        ├─ surface==nil 이고 view.window==nil  →  RETURN (defer, surface 미생성)   [3540-3548]  ★게이트
        └─ view.window!=nil  →  createSurface(for:view)                            [3553]
                 └─ ghostty_surface_new(...) → PTY 할당 → 렌더러 attach
                 └─ .terminalSurfaceDidBecomeReady 통지 → 이후 send_key 수용 가능

orchestrator 폴링 (_cmux_wait_ready, 200ms 간격, 10~30s):
  (a) list-workspaces  ⟶ ref 등록됨? ........... 194/195/196 은 등록됨(레코드 생성 성공)
  (b) surface-health   ⟶ type=terminal & in_window? ... in_window = hostedView.window!=nil  [GhosttyTerminalView.swift:2961]
  (c) read-screen      ⟶ 비어있지 않음?         ... ghostty surface==nil 이면 internal_error  [TerminalController.swift:~5563]
```

**모든 V2 핸들러는 메인 스레드에서 직렬화**됨: `v2MainSync { DispatchQueue.main.sync {...} }`
(TerminalController.swift ~2916). 즉 `workspace.create`·`surface.health`·`read_text` 전부 메인 스레드 의존.

**핵심**: workspace **레코드** 생성(카운터++)과 **surface(PTY/렌더러)** 생성은 분리되어 있고,
surface 생성은 `view.window != nil` 이 될 때까지 **무기한 defer** 된다 (`GhosttyTerminalView.swift:3540-3548`).
"pane not ready" = surface 가 끝내 생성되지 않아 (b)/(c) 가 영원히 false/Error 인 상태.

---

## 3. 결정적 증거 (라이브 inspection)

| # | 증거 | 출처 | 함의 |
|---|------|------|------|
| F1 | cmux GUI 프로세스 PID 18763, **uptime 7일**(06-06 기동), 06-13 재시작/크래시 **없음** | `ps -o lstart,etime -p 18763`; `~/Library/Logs/DiagnosticReports/` 최신 .ips = 06-08 | **프로세스 재시작으로만 풀리는 누적 고갈 → 회복 메커니즘으로서 반증.** 재시작 없이 회복됨 |
| F2 | 현재 **live workspace = 3개** (단일 window, selectedIndex 0) | `session-com.cmuxterm.app.json` `windows[0].tabManager.workspaces` | "197 = 197개 누적 live" 는 거짓. **197 은 monotonic next-id 카운터일 뿐** |
| F3 | cmux 제어 소켓 `cmux.sock`+`last-socket-path` **mtime 06-13 09:34:35** 재생성 | `stat` | 프로세스는 그대로(F1)인데 **소켓 리스너만 09:34 에 rearm/재바인드** |
| F4 | telepty 데몬(3848, node PID 51182) **06-13 10:17:25 기동** (09:34 와 별개 이벤트) | `ps`; `lsof -iTCP:3848` | telepty 재시작은 cmux 소켓 rearm 보다 **43분 뒤** — 별개 |
| F5 | 게이트 3종(list-workspaces/surface-health/read-screen)은 cmux.sock 직결, **telepty 미경유** | `CLI/cmux.swift:940-970`, `open-session.sh:191-198` | **pane-ready 는 telepty 데몬에 직접 의존하지 않음** (Q3 답) |
| F6 | surface 생성은 `view.window != nil` 게이트, 아니면 무기한 defer | `GhosttyTerminalView.swift:3540-3548` | "pane not ready" 의 **정확한 메커니즘** = surface 영구 미생성 |
| F7 | surface lifecycle 로그(`surface.attach.defer/create`, `createSurface`, `background_start`)는 전부 `#if DEBUG` | `GhosttyTerminalView.swift:3444-3469, 3542-3556, 3570-3576` | **릴리스 빌드(/Applications/cmux.app)는 진단 흔적 0** → 사건창 unified-log 0줄 (확인됨) |
| F8 | 실패 시 orchestrator 가 직접 `close-workspace $ref` | `open-session.sh:232` | "죽은 194/195/196 사라짐" 은 realign 아니라 **이 cleanup** 으로 설명됨 |

---

## 4. 누적 고갈 가설 — 순위 (증거 기반)

### H1 (1순위) — 메인 스레드/AppKit run-loop stall 이 신규 surface attach 를 굶김
신규 workspace **레코드**는 생성되어 카운터가 194/195/196 으로 전진(메인 스레드 싼 작업).
그러나 새 탭 hostedView 를 NSWindow 에 넣는 **SwiftUI 레이아웃(= createSurface 전제조건, F6)** 이
제때 돌지 못함 — 메인 스레드 혼잡/run-loop wedge. surface 가 nil 로 남아 게이트가 영구 실패.
회복: 09:34 소켓 rearm/run-loop unblock 으로 큐가 풀려 다음 spawn(197) 은 정상 attach.
- **For**: F5(메인 직렬화) + F6/F7(defer 메커니즘 = 증상 일치) + F1·F2(재시작·live-count 누적이 아님 → 일시적 wedge 와 일관). 재시작 없이 회복(F1) 은 **하드 누수가 아님**을 강하게 시사.
- **예측**: 실패 중 `surface-health` 가 194-196 에 대해 `in_window=false` 지속; 그 순간 `sample cmux` 하면 메인 스레드 블록 스택이 보일 것.
- **약점**: 무엇이 메인 스레드를 멈췄는지 단정 불가 — 프로덕션 흔적 부재(F7) 때문.

### H2 (2순위, H1 의 표면) — cmux 제어 소켓 accept-loop / per-client 핸들러가 메인 sync 뒤에서 적체
소켓 09:34 rearm(F3) 이 리스너 wedge 정황. per-client 핸들러가 `DispatchQueue.main.sync`(F5)에서
멈춘 메인 스레드 뒤에 줄서면 신규 probe 가 hang/timeout.
- **반증**: 소켓이 완전 wedge 였다면 기존 세션의 cmux 호출과 `new-workspace`(이것도 소켓 호출) 자체가 실패했어야 함 —
  그러나 194/195/196 **ref 는 반환됨**. ⇒ 소켓은 부분 동작. H2 는 독립 원인이라기보다 **H1(메인 혼잡)의 소켓 레이어 발현**.

### H3 (3순위) — PTY/FD/렌더러 누적(7일 가동)으로 surface-init 비용/실패율 상승
7일 가동(F1) = 누적 창. agent 분석상 `runtimeSurfaceOwners` dict·per-panel git-probe `DispatchSourceTimer`
(TabManager.swift:1427)·Metal 컨텍스트가 누수 후보.
- **반증**: F2(현재 live 3개, 고수위 아님) + F1(**재시작 없이 회복** — 진짜 FD/PTY 누수면 재시작 없이 안 풀림). 강등.

### H4 (반증) — telepty 데몬 커플링
게이트가 telepty 미경유(F5), telepty 재시작(10:17)이 소켓 rearm(09:34)보다 뒤(F3/F4).
**pane-ready 는 telepty 에 직접 의존하지 않음.** 커플링은 orchestrator 프로세스/오케스트레이션 레벨뿐.

---

## 5. 데몬 커플링 분석 (Q3)

- cmux CLI ↔ backend = **Unix domain socket** `~/Library/Application Support/cmux/cmux.sock` (`last-socket-path` 가 경로 기록).
  backend = **cmux GUI 앱 그 자체** (별도 cmuxd 없음; `cmuxd-remote` 는 SSH 원격 전용 Go 바이너리, 본 건 무관).
- telepty 데몬(3848)은 orchestrator 의 **submit/inject 채널**이지 cmux readiness 채널이 아님.
- **방향**: 의존 없음(직접). realign 의 실제 회복 기여는 **cmux 측 소켓 rearm(09:34)** 이고 telepty 재시작(10:17)은 별개.
  → "데몬 realign 으로 회복" 서사는 *telepty* 가 아니라 *cmux 소켓 리스너 rearm* 으로 재해석됨.

---

## 6. 타임아웃 적정성 (Q4)

실패는 **느린 cold-start 가 아니라 영구 상태**(surface 가 영원히 미생성, F6). 따라서
**10s/30s 어떤 값도 무의미** — attach 되지 않을 surface 는 무한정 안 됨. 타임아웃 튜닝은 해법 아님.
30s 로 늘려도 194/195/196 이 끝내 실패한 것이 이를 뒷받침(증상: 10s,10s,30s 모두 실패).

---

## 7. 권고 fix 방향 (어느 repo / 레이어)

### 7.1 cmux repo (1차 — 근본)
1. **surface 생성을 `view.window!=nil` 게이트에서 분리** (`GhosttyTerminalView.swift:3540-3553`):
   프로그램적으로 생성된 workspace 는 윈도우 편입을 기다리지 말고 결정적으로 surface 를 띄우거나,
   `workspace.create`/첫 `send_key` 시 새 탭을 강제 front/layout 하여 hostedView 가 결정적으로 window 에 진입하게.
2. **릴리스-세이프 관측성 (최고 레버리지, F7)**: `#if DEBUG` 흔적을 `os_log`(release 포함)로 승격 —
   최소 `createSurface start/done`, `attach.defer reason`, `terminalSurfaceDidBecomeReady`,
   그리고 **메인 스레드 지연 워치독**(main-thread latency > N ms 경고). 다음 사건을 진단 가능하게.
3. 메인 스레드 포화원 조사: per-panel git-probe `DispatchSourceTimer`(TabManager.swift:1427) 및 `@Published` churn.

### 7.2 orchestrator repo (2차 — 완화/진단, 근본 아님)
- `open-session.sh` 게이트는 "죽은 ref 거부"는 옳음. 다만 **느림 vs 영구실패 구분**:
  게이트 타임아웃 시 `close-workspace`(:232) 전에 `sample <cmux-pid>` + `surface-health` 스냅샷을 diag 파일로 캡처
  → 다음 사건에 메인 스레드 스택 확보. (읽기 진단 추가; fix dispatch 거리)
- 선택: 실패 선언 전 `cmux select-workspace <ref>` 로 탭을 front 시키는 bounded retry 가 permanent-defer 를
  성공으로 전환할 수 있음 — **워크어라운드**이며 근본 수정은 cmux 측.

---

## 8. 미해결 / 추가 계측 필요 (읽기로 안 풀린 부분)

프로덕션 흔적 부재(F7) 때문에 **무엇이 메인 스레드/attach 를 멈췄는지 단정 불가**. 필요:
1. **cmux**: surface lifecycle os_log(release) + 메인 스레드 워치독 (7.1-2).
2. **orchestrator**: 게이트 실패 순간 `sample cmux` + `cmux surface-health` 덤프 (7.2).
3. 재현 시(별 dispatch, 본 세션 아님): 다수 연속 spawn 으로 메인 스레드 latency 계측.
   ⚠️ 본 analyst 세션은 자기 surface 가 cmux 위에 있어 재현 spawn/restart 금지.

---

## 부록 — 핵심 file:line 인덱스
- orchestrator 게이트: `aigentry-orchestrator/bin/open-session.sh:183-207`(_cmux_wait_ready), `:224`(new-workspace), `:231-232`(실패 echo+close)
- CLI 소켓: `cmux/CLI/cmux.swift:940-970`(connectOnce), `:1110-1152`(sendV2)
- surface attach 게이트: `cmux/Sources/GhosttyTerminalView.swift:3497`(attachToView), `:3540-3553`(defer/create), `:2961`(isViewInWindow)
- surface 로그 DEBUG-gating: `cmux/Sources/GhosttyTerminalView.swift:3444-3469`, `:3542-3556`, `:3570-3576`
- V2 메인 직렬화: `cmux/Sources/TerminalController.swift:~2916`(v2MainSync), `:3283-3312`(workspace.list), `:5036-5074`(surface.health), `:5491-5563`(read_text)
- 누수 후보: `cmux/Sources/TabManager.swift:1427`(git-probe timers), `Sources/GhosttyTerminalView.swift:2884-2927`(runtimeSurfaceOwners)
