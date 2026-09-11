# Voice Code — companion UI design contract (#1159) · r3

**Status:** r3 = reviewed r2 (`f5d788f`, not approved for implementation) plus five targeted clarifications listed in §0. Nothing was coded, built, rendered, run on a device or tested; layouts are text diagrams, not screenshots.
**Worker:** ui1159-architect · `docs/1159-voicecode-design` · base `606d4ae` · local `main` `30e99a3` (2026-09-11T20:09:54+09:00; `base..main` does not touch this file).
**Source (read-only):** `/Users/duckyoungkim/projects/voicecode` HEAD `5d98d60` (`main`); dirty before and after: ` D .omc/state/subagent-tracking.json`, `?? .claude/` (not opened).
**Core dependency:** va1157 core r1 (`326425e`, read only) is rejected and guarantees nothing; core r2 is in revision. This contract depends on the invariants in §9, not on r1 field names; every exact name, type and value binds to the final reviewed core.
**Labels:** **S** source line re-read · **D** official Android doc fetched 2026-09-11 · **U** unknown + smallest check · unlabeled = proposal.

## 0. r1 → r2 corrections
| # | r1 | r2 |
|---|---|---|
| 1 | §9 listed runtime field names | §9 lists invariants only; names and types bind to the final core |
| 2 | Error ranked below working/question for the one title | the title shows audio/connection activity only; urgent failures and the actionable question live in an attention stack nothing replaces (§6.1, §7) |
| 3 | reconnect or session switch expired a question; 말하기 counted as an answer | disconnect or revalidation only disables answers; only an authoritative close is terminal; speech is an answer only when core binds it (§6.2) |
| 4 | history = "exactly what was spoken"; kept until app close; 200 cap | per-item playback status (queued, playing, partially played, playback completed, held, dropped); retention and caps are core policy; UI shows counts (§6.4) |
| 5 | UI slice owned `SshForegroundService.kt`; fold kept only UI state | core alone owns service, manifest, MediaSession and notification wiring; UI gives content; fold must neither interrupt nor duplicate delivery (§6.5, §10, §11) |
| 6 | question card 12dp; explanatory picker footer; fixed heights | radius ≤ 8dp; footer removed; heights are minima with a 200% check (§5) |
| 7 | Unsafe switch recommended; three user decisions | no bypass control in the UI (security-contract dependency); defaults stated once; typed input and raw terminal stated as a core dependency (§12) |
| 8 | — | this map, ownership changes (§10), integration/accessibility/device tests (§11) |

**r3 clarifications of `f5d788f`:** (1) unknown prompt delivery recovers by voice or, optionally, on screen through core identity, dedupe and revalidation, with a resend only when core marks it resend-safe (§8, §9); (2) read-only `TerminalView` gets a UI-owned focus/paste/input guard, preceded by an isolated null-callback click test (§1, §10, §11); (3) processing location, billing and consent are separate verified fields (§6.3, §6.6, §9); (4) history states playback facts, never hearing, acknowledgement or authority (§6.4, §9, §11); (5) typed input stays under core authority where supported, and raw terminal passthrough is an unresolved security capability (§6.1, §12).

## 1. Current UI, measured (S)
| File (lines) | Today | Fate |
|---|---|---|
| `MainActivity.kt` (143) | 26 flows plus a 15-argument save callback into `MainScreen` (`:37-118`); `RECORD_AUDIO` requested in `onCreate` | screen host |
| `ui/MainScreen.kt` (372) | status dot, "VoiceCode", text `>_` toggle, "busy" chip; Terminal/Chat split on `maxWidth > maxHeight` (`:222`); transcript overlay floats over content (`:277-297`) | rebuilt |
| `ui/VoiceButton.kt` (116) | one 72dp FAB; taps while Processing ignored (`:92-94`); one label "Voice control" (`:111`); infinite pulse | control bar |
| `ui/ChatView.kt` (191) | raw `message.content` bubbles (`MainViewModel.kt:1300-1306`) while TTS speaks `compressed.ttsText` (`:1308-1321`); sender hard-coded "Claude" (`:142`) | history |
| `ui/SettingsDialog.kt` (804) | one `AlertDialog` with SSH secrets, Unsafe switch, engine radios; non-builtin TTS still plays via Android TTS (`VoiceEngineManager.kt:99-109`) | settings + setup |
| `ui/TerminalView.kt` (279) | VT100 view; paste and hidden typeahead send keystrokes to SSH (`:218-276`) | read-only guard, slice T |
| `ui/theme/*` (133) | dark-only navy/pink constants; bar icons forced light (`Theme.kt:32-37`); 11sp labels | re-tokenized |
- 9 UI files, 2,082 lines. `material-icons-extended` is already a dependency (1.7.6 in the Gradle cache); nothing is added. No semantics/live regions, MediaSession, audio-route callbacks, window size classes or reduced-motion checks (grep, 0 hits).
- Fold: the activity declares no `configChanges` (`AndroidManifest.xml`), and `onPause` cancels recording and stops speech (`MainActivity.kt:129-132` → `MainViewModel.kt:1414-1418`). Whether a Fold7 fold passes through `onPause` is U (core device test).
- Terminal coupling (core-owned fix): `_terminalSize` starts null (`MainViewModel.kt:143`), so `connectSsh` sets a pending flag and returns (`:1029-1033`) until `resizeTerminal`, called from `TerminalView.kt:140-143`, resumes it (`:1240-1255`); every size change also resets the emulator and PTY.
- Focus risk (source only; no crash reproduced): the view's click handler always calls `focusRequester.requestFocus()` (`TerminalView.kt:128-131`), but the requester is attached only inside `if (onSendCommand != null)` (`:242`, `:259`), so tapping a read-only view can reference an unattached requester. What Compose does then is U until the §11 isolated test runs.
- Speech: a HIGH item stops speech and clears the queue (`TtsManager.kt:95-99`); `stop()` keeps no record of how far an utterance got (`:112-116`).

## 2. Visual thesis (direction unchanged)
Voice Code is an earpiece with a glance surface. The screen answers, in order: what is the loop doing now, what needs me, what did I hear. Neutral graphite/paper surfaces, one teal action colour, three meaning colours (amber = needs you, red = failed or destructive, green = done). The brand is the "Voice Code" wordmark at title size plus the teal; no hero, gradient, orb, card mosaic or nested card. The question is the only card, because it is the interaction; failures are rows. The waveform shows measured mic level only: evidence of audio, never of identity, auth or completion.

## 3. Information architecture
| Surface | Shows | Reached from |
|---|---|---|
| 세션 (home) | activity, attention stack, recent items, controls | launch |
| 세션 선택 | provider → connector → session/task, billing, verification | top-bar `SwapHoriz`; bottom sheet (compact) or side pane (≥600dp) |
| 최근 요약 | spoken content with delivery status | "모두 보기"; right pane at ≥600dp |
| 원문 | read-only original text or SSH terminal | a history row; `Terminal` icon in SSH mode |
| 설정 | connections, voice, headset & privacy, diagnostics | top-bar `Settings` |
| 처음 설정 | permissions, earbuds, first connection, voice check | first run; 설정 › 연결 추가 |
Navigation: a `Screen` enum in `rememberSaveable` plus `BackHandler` (already in `activity-compose`); no navigation library (Article 1/17).

## 4. Adaptive layout
Layout follows the window width class, never the device model (D: size classes come from the app window). Compact < 600dp (expected: folded outer screen); medium 600–839dp and expanded ≥ 840dp (expected: unfolded inner). Width comes from the root `BoxWithConstraints`; no adaptive library; the builder records real dp.
```text
COMPACT (<600dp)
top bar ≥64dp ....... Voice Code                          [⇄ 세션 선택] [⚙ 설정]
session ≥3 lines .... Claude · Claude Code CLI                        [작업 중 · 2분]
                      로그인 버그 수정   [구독]   [연결 확인 14:05]        작업 취소
activity ≥2 lines ... [Hearing] 듣는 중                  (audio and connection only)
waveform 48dp ....... ▁▃▅▇▅▃▁▂▄▆▄▂   (measured mic level; blank when none)
transcript ≤3 lines . "로그인 실패 원인 찾아…"
attention stack ..... [ErrorOutline] 실패 · 테스트 실행 · 로그인 버그 수정          확인
                      ┌ 질문 · 답할 수 있음 ──────────────────────────────┐
                      │ auth.ts 수정을 허용할까요?   대상: 로그인 버그 수정   │
                      │ [허용]   [거부]   [나중에]      (options from core)  │
                      └───────────────────────────────────────────────────┘
recent ≤3 rows ...... 14:02 재생 완료 · 테스트 3개 실패. 원인은 토큰 만료 처리…   모두 보기 ›
control bar ≥88dp ... [VolumeOff 재생 중지]   ( Mic 말하기 )   [MicOff 마이크 끄기]

MEDIUM / EXPANDED (≥600dp)
┌ session pane (max 560dp): top bar · session · activity · attention ┬ right pane: 최근 요약,
│ recent strip hidden (the right pane shows it)                       │ or 세션 선택 / 원문 / detail
└ control bar ≥88dp under the session pane ───────────────────────────┴──────────────────────────
```
- The control bar stays under the session pane, so the thumb position matches folded and unfolded. Fold/unfold keeps the screen, open sheet and scroll (`rememberSaveable`).
- Compact height (< 480dp, D): recent strip hidden, page scrolls, control bar stays pinned.

## 5. Tokens
**Typography:** system sans (the user's Korean font on One UI; nothing bundled), sp only, letter spacing 0, no viewport-width scaling.
| Token | sp / line | Weight | Use |
|---|---|---|---|
| stateTitle | 28 / 36 | SemiBold | activity title |
| summary | 20 / 30 | Regular | question text, latest item |
| title | 18 / 26 | Medium | session and task name |
| body | 16 / 24 | Regular | rows, settings |
| label | 14 / 20 | Medium | buttons, chips |
| meta | 13 / 18 | Regular | times, provider line; smallest size |
| mono | 14 / 20 | Regular, monospace | ids, file names, 원문 |
**Spacing and shape:** 4dp grid (4 / 8 / 12 / 16 / 24 / 32); gutter 16dp compact, 24dp at ≥600dp; 24dp between sections. Custom containers ≤ 8dp radius (question card 8dp, chips 8dp); failure rows are full-width rows with dividers; sheets keep the Material default; the talk button is circular; no elevation except the sheet scrim.
**Palette** (fixed; no dynamic colour, which would blur state meaning). Hex values are starting points; the builder measures text contrast ≥ 4.5:1 below 18sp and ≥ 3:1 otherwise (D).
| Role | Light | Dark |
|---|---|---|
| background / surface / surfaceVariant | #F6F7F8 / #FFFFFF / #ECEEF0 | #0F1113 / #171A1D / #22262A |
| outline · onSurface · onSurfaceVariant | #C3C8CD · #15181B · #4E555C | #3B4147 · #E7E9EB · #A6AEB6 |
| accent (actions, listening) · onAccent | #006A6A · #FFFFFF | #5CD5D2 · #002020 |
| attention (question, offline, headset lost) · container | #B26B00 · #FFF1DB | #FFB84D · #3A2A0A |
| danger (failure, destructive) · container | #B3261E · #F9DEDC | #F2B8B5 · #601410 |
| success (done) | #1E6A33 | #7FD892 |
Text on attention/danger containers uses onSurface; colour is never the only signal.
**Icons:** current library only; verified in the 1.7.6 cache: `Mic`, `MicOff`, `Hearing`, `GraphicEq`, `Sync`, `HourglassTop`, `AutoMirrored.VolumeUp`/`VolumeOff`/`Help`, `HeadsetOff`, `CloudOff`, `ErrorOutline`, `CheckCircle`, `Cancel`, `Replay`, `History`, `SwapHoriz`, `Terminal`, `Settings`, `Lock`. Outlined = idle, Filled = active/selected. Every icon-only control has a Korean `contentDescription` and a long-press tooltip.
**Touch:** every control ≥ 48×48dp (D); secondary controls 56dp; talk 72dp; ≥ 8dp between targets.
**Minima, not fixed heights:** top bar ≥ 64dp, session ≥ 3 lines, activity ≥ 2 lines, rows ≥ 56dp, control bar ≥ 88dp + insets. Anything holding text grows with font scale; only the 48dp waveform band is fixed. Nothing floats over content.
**200% check (conceptual; U until screenshots):** text scales to 200% non-linearly (D, Android 14), so a 14sp label approaches 28sp. A four-syllable label such as `재생 중지` then needs roughly 110dp, so on a compact width each control label wraps to two lines under its icon and the bar grows; question options stack vertically when a row cannot hold them; session chips wrap. Nothing ellipsizes a state, question, option or control label.
**Motion:** 180ms crossfade of icon and label on activity change, no size change; attention items enter with a 200ms fade and an 8dp rise; the waveform redraws only on new level samples and stops when not visible; no infinite pulse. With animations off or Battery Saver: instant transitions and a static level bar updated ≤ 4 times a second (signal U: builder confirms on One UI, starting from `ValueAnimator.areAnimatorsEnabled()`).
**Theme:** light/dark follow the system; system-bar icons follow the theme.

## 6. Views
**6.1 Home: three layers that never replace each other.**
- **Session line:** `provider · connector` (meta), task title, billing chip (`API 과금` / `구독` / `과금 확인 안 됨`), verification chip (`연결 확인 14:05` / `연결 확인 안 됨`; a fresh selection shows `선택됨 · 확인 전`), task status chip (`작업 중 · 2분` / `결과 확인 안 됨`). Working status lives here and covers nothing.
- **Activity line:** audio and connection only (§7), plus the live transcript in flow while listening or transcribing.
- **Attention stack:** urgent failure rows first (short, so they stay in view), then the question card. A failure row names the action and target (`실패 · 테스트 실행 · 로그인 버그 수정`) and stays until core supersedes it or the user taps `확인`, which only hides it locally. At most 2 rows show, then `실패 N건 더` opens history. No activity, working status or newer item replaces the stack; speech order follows core priority.
- **Controls:** `재생 중지` stops speech only; content keeps its delivery status and questions stay open. `말하기` starts or stops listening. `마이크 끄기` is a hard mute, passive barge-in listening included (`BargeInController.kt:69-74`). `작업 취소` is a text button on the session line, enabled only when core allows cancel for this task (disabled label `취소 지원 안 됨`); its dialog focuses `계속 진행`. A keyboard field for prompts and answers appears only where core supports typed input, with the same identity, dedupe and authority as speech (§12).
**6.2 Question answerability (core decides every transition; the UI renders it).**
| UI state | When core reports | Card |
|---|---|---|
| 답할 수 있음 | live; identity (question · session · task · generation · content) matches; current readback complete | options enabled, equal weight, no default focus |
| 확인 중 | disconnected, reconnecting, switching session, or identity not yet re-matched | options disabled; `연결 확인 중 · 지금은 답할 수 없음`; the card stays |
| 종료 | an authoritative closed, expired, replaced or cancelled state only | card leaves; history shows `답변함 · 거부 14:07` / `만료됨` / `새 질문으로 대체됨` / `취소됨` |
- 확인 중 returns to 답할 수 있음 only after a matching live snapshot and a complete current readback.
- Each option submits the exact identity it was rendered with; if core refuses a mismatch, the card shows `질문이 바뀌었어요`.
- A visible question never turns speech into permission: `말하기` sends an ordinary utterance unless core binds it as an answer, and the UI shows an answer only after core reports it.
- Screen options carry no authority of their own: the options offered, and any device-credential step, are exactly what core allows. A second question shows as `대기 중인 질문 1개`, not actionable.
**6.3 Session picker.** Groups in fixed order ChatGPT, Codex, Claude, Grok, Gemini; configured connectors only, the rest under `설정되지 않음` with `연결 추가`. Row: connector, session/task title, billing chip, last verification. No footer. Billing never changes silently: an API-billed target shows `API 과금` before it can be picked, and choosing it asks for explicit consent.
**6.4 History with playback status.** Rows: source summary text, time, session short name, category icon + label (질문 / 실패 / 완료 / 알림), status: `대기` (queued or planned) · `재생 중` · `일부 재생됨` (a position such as `약 2/3` only when core reports progress, marked approximate; otherwise no position) · `재생 완료` · `보류` (headset lost or muted) · `놓침` (dropped by core policy, shown as a count, `놓친 알림 3개`). Actions: `다시 듣기`, `원문`. These are playback facts: completed playback or readback never shows as, or counts as, the user hearing, understanding, acknowledging or authorizing anything. Queued or generated text is never shown as played. Retention is memory-only under core's bounded policy, survives fold and activity recreation, and the UI sets no cap of its own.
**6.5 Notification content (core owns service, manifest, MediaSession and action wiring).** Title `Voice Code`, text `{activity} · {task title}`; if core wires actions, only `재생 중지` and `마이크 끄기`, never cancel or answer; the lock-screen public version shows the activity only.
**6.6 Settings and first setup.**
- Sections: 연결 (connector, method, explicitly chosen billing, verification, `삭제`), 음성 (speech rate, summary length `짧게` / `보통`, `말 끊기 허용`), 헤드셋·개인정보 (renders core's recognizer location, summary source and TTS engine), 진단 (versions, 원문).
- No permission-bypass or "unsafe" control: whether one exists in a public release is a security-contract decision, not a UI setting.
- Engines or providers core has not verified show disabled as `이 기기에서 확인 안 됨`. Each processing path (recognizer, summary, TTS, connector) shows three labels from separate verified core fields, none inferred from another: where it runs (`이 기기` / `내 호스트` / `외부 서비스` / `확인 안 됨`), billing (`API 과금` / `구독` / `추가 과금 없음` / `과금 확인 안 됨`) and consent (`동의함` / `동의 필요`). Off-device is not the same as paid; a user-host path may carry no metered charge. Any paid path needs an explicit consent action; no silent paid fallback.
- Credentials: keyboard or paste only; the mic is force-muted while a credential field has focus; never spoken, never in history.
- First setup is separate from daily use, each step `완료` / `필요`: 마이크 권한 → 알림 권한 → 이어폰 연결 → 연결 추가 → 음성 확인. OS-enforced steps are marked `화면에서 진행` (permission dialogs, Bluetooth pairing, sign-in). A microphone foreground service cannot start from the background (D), so screen-off setup is never promised.

## 7. State/action matrix
Activity line (the only thing competing for the title):
| Activity | Icon | Title | Colour | 말하기 | 재생 중지 | 마이크 끄기 |
|---|---|---|---|---|---|---|
| Idle | Mic (outlined) | 대기 중 | onSurface | start | disabled | toggle |
| Listening | Hearing (filled) | 듣는 중 | accent | stop | disabled | mute; utterance not sent |
| Transcribing | GraphicEq | 받아쓰는 중 | onSurfaceVariant | disabled | disabled | toggle |
| Sending | Sync | 보내는 중 | onSurfaceVariant | disabled | disabled | toggle |
| Speaking | VolumeUp | 말하는 중 | onSurface | start (interrupts speech) | enabled | toggle |
| Offline | CloudOff | 오프라인 · 재연결 3회째, then `연결 확인 중` | attention | disabled | if speaking | toggle |
| Headset lost | HeadsetOff | 이어폰 연결 끊김 | attention | disabled | auto-stopped | forced off |
| Mic muted (flag) | MicOff (filled) | … · 마이크 꺼짐 | onSurface | `마이크 켜기` | per state | unmute |
Title priority: Headset lost > Offline > Listening > Transcribing > Speaking > Sending > Idle.
Independent of the title, shown alongside any activity:
| Item | Icon | Label | Colour | Actions |
|---|---|---|---|---|
| Agent working (session line) | HourglassTop | 작업 중 · 2분 | onSurfaceVariant | 작업 취소 if core allows |
| Urgent failure (stack) | ErrorOutline | 실패 · {action} · {target} | danger | 확인, 원문 |
| Question answerable (stack) | Help (filled) | 답할 수 있음 | attention | core-supplied options |
| Question revalidating (stack) | Help (outlined) | 연결 확인 중 · 지금은 답할 수 없음 | onSurfaceVariant | none |
| Not understood (activity meta) | — | 잘 못 들었어요 | onSurfaceVariant | — |
TalkBack: the activity region is a polite live region; each attention item announces once on arrival; every control is named.

## 8. Failure and recovery
| Condition | Screen | Ear (core-owned) | Recovery |
|---|---|---|---|
| Headset lost | 이어폰 연결 끊김 · `보류 2개` | speech stops; nothing plays on the phone speaker, including already-buffered audio (device test, §11) | earbuds back → core offers held items; or `이번만 스피커로 듣기` (explicit, per event, never remembered) |
| Offline | 오프라인 · 재연결 n회째, `마지막 연결 14:03` | per core priority | automatic retry, `지금 다시 연결`; the question goes to 확인 중, not 만료됨 |
| Connector error / sign-in expired | failure row + reason, `휴대폰에서 다시 로그인 필요` | per core priority | setup step; no automatic switch to API billing |
| Prompt delivery unknown | failure row `전송 확인 안 됨`, or `실행됐을 수 있음` when core reports it may have run | spoken per core priority; asks `다시 보낼까요?` only when core marks the original resend-safe | by voice or, optionally, on screen, through the same core identity, dedupe and revalidation; unknown or unrecoverable stays a failure row with `원문` and no resend; never an automatic resend, a new request id or text sent straight to a shell |
| Not understood | activity meta `잘 못 들었어요` | per core | tap, or a headset trigger if core provides one |
| Mic permission missing | blocking row `마이크 권한이 필요해요` | none | `권한 설정 열기` |
Headset rule basis: Android broadcasts `ACTION_AUDIO_BECOMING_NOISY` when output falls back to the built-in speaker (D). The UI requires core to stop speech on route loss and never resume on the speaker by itself; whether buffered audio still leaks is a device test, not a UI guarantee.

## 9. Core dependency map (invariants; exact names and types bind to the final reviewed core)
| UI element | Invariant required from core |
|---|---|
| activity line | phase signals including end of speech; admission ≠ delivery ≠ outcome |
| prompt recovery | per request: resend-safe vs unknown vs unrecoverable, keeping the original request identity and dedupe; ambiguity is preserved, never resolved by a new request |
| waveform | a measured input level, or none (then the band stays blank) |
| session line | provider, connector, session and task identity; billing api / subscription / unknown; last verification; task status |
| failure rows | action, target and a machine-evidenced outcome; unknown is never success; a supersede signal |
| question card | identity (question · session · task · generation · content); answerable / revalidating / terminal + reason; the options the screen may offer; queued count |
| history | per item: source text, playback status, progress marked measured / approximate / unavailable; held and dropped counts; the retention policy; playback ≠ acknowledgement |
| route | output route and loss events; buffered audio handled on loss |
| controls | cancel allowed per task; stop ≠ cancel; replay; headset trigger; typed prompt/answer support; raw-terminal input capability (unresolved, §12) |
| settings | per processing path: location, billing mode and consent state as separate verified fields |
| lifetime | the voice session survives fold and activity recreation with no duplicated prompt, answer or speech |
Missing data renders its unknown copy. The UI never infers connectivity from selection, billing from a provider name or a processing location, completion from the waveform, "played" from "queued", acknowledgement from playback, or an answer from speech.

## 10. Implementation slices (one owner per file; no new dependency)
| Slice | Files | Scope | After |
|---|---|---|---|
| A tokens | `ui/theme/Color.kt`, `ui/theme/Theme.kt`, `ui/theme/Type.kt`, `res/values/themes.xml`, `res/values/colors.xml`, new `res/values-night/themes.xml` | §5 light + dark; `Space`/`Motion` objects in `Theme.kt` | — |
| B UI state | new `ui/SessionUiState.kt` | pure mapping from core state to §7 activity, stack, answerability and history status; explicit unknowns | final core types |
| C session parts | new `ui/StateHeader.kt`, new `ui/AttentionStack.kt`, `ui/VoiceButton.kt` (becomes `ControlBar`) | §6.1–6.2 | A, B |
| E history | new `ui/SummaryHistory.kt` | §6.4 | B |
| F picker | new `ui/SessionPicker.kt` | §6.3 | B |
| G settings | new `ui/SettingsScreen.kt`, new `ui/SetupScreen.kt` | §6.6 | A |
| H copy | `res/values/strings.xml` | all Korean copy and content descriptions; app name `Voice Code` | — |
| D shell | `ui/MainScreen.kt`, `MainActivity.kt` (screen host only); delete `ui/ChatView.kt`, `ui/SettingsDialog.kt` once unused | width classes, panes, `Screen` enum, read-only 원문 hosting `TerminalView` with no input callback | C, E, F, G; core PTY-size change |
| T raw view | `ui/TerminalView.kt` | read-only guard: when input is unsupported, no click-to-focus, paste button or typeahead field; copy stays | isolated test result first (§11) |
Ownership changes from r1: `QuestionPanel.kt` becomes `AttentionStack.kt` (adds failure rows). Slice I is removed: `ssh/SshForegroundService.kt`, `AndroidManifest.xml`, MediaSession and notification actions are core-only. `MainActivity.kt` stays UI, but what `onPause`/`onResume` do is core's. `ui/TerminalView.kt` becomes slice T (read-only guard only; it decides nothing about typed passthrough). Core must make SSH connect independent of `TerminalView` composition (§1) before D moves the terminal off home. Every code slice runs the Snyk fix → rescan loop before DONE.

## 11. Required tests (builder/tester; none run here)
- **Integration (JVM, existing JUnit) on `SessionUiState`:** the title covers activity only; failure rows persist while working, speaking, listening or a question is shown; disconnect → 확인 중 with options disabled; restored only on a matching identity and readback; terminal only on an authoritative close; speech never shown as an answer without core binding; queued ≠ playback completed, and completed playback never counts as acknowledgement; unknown delivery offers a resend only when core marks it resend-safe, with the original identity, by voice or screen; an interruption keeps source and progress; held/dropped counts come from core; a fresh selection shows `선택됨 · 확인 전`.
- **Isolated source-risk test (tester, before slice T's fix):** an instrumented Compose test renders `TerminalView(lines = one line, onSendCommand = null)` and clicks its root; record the result (exception or no-op) before any fix, then rerun it after the guard. The project has only JUnit and coroutines-test (`app/build.gradle.kts:74-75`), so the BOM's `ui-test-junit4` (+ `ui-test-manifest`) must first be approved as test-only dependencies. Not run here.
- **Device (Z Fold7 + Buds2 Pro):** fold/unfold during listening, speaking and an open question → no duplicated or lost prompt, answer or utterance (count core event ids), screen/sheet/scroll kept, answerability unchanged unless core changes it; SSH mode with the terminal off home still connects; headset disconnect mid-utterance and with items queued → nothing audible from the phone speaker, buffered audio included, mic closes, reconnect offers held items only; a network drop that leaves delivery unknown → recovery offered by voice with no screen step, and nothing runs twice (count core request ids).
- **Accessibility (builder screenshots):** folded outer and unfolded inner (portrait, landscape) × light/dark for Idle, Listening, Speaking, Offline, Headset lost, question + failure together, question 확인 중; 200% font on outer for Idle, question + failure, Headset lost; animations off for Listening and Speaking; record the window dp. Pass: no clipping or overlap; targets ≥ 48dp; contrast per §5; TalkBack names activity, session, attention items and controls; an activity change does not move control bounds.
- **Not measured by this document:** rendering, contrast, Korean line breaks in the One UI font, TalkBack order, latency, battery, audio leakage.

## 12. Defaults and core dependencies
- **Defaults (stated once, not re-asked):** no automatic speaker fallback, only the explicit per-event action; memory-only history under core's bounded policy; explicit consent before any paid path; no bypass control in the UI.
- **Core dependency, not decided here: typed input and raw terminal.** Existing typed interaction is not removed just to avoid binding it: where core supports it, typed prompts and answers use the same identity, dedupe and authority as speech (§6.1). Raw terminal passthrough (today `TerminalView.kt:218-276` pastes and types straight into SSH) is an unresolved security capability for the core/security contract: not a default, not a bypass, and not replaced by a desk-only rule. Until that contract decides, 원문 renders without input (slice T). Core's open human choices (host placement, voice-approvable tier, subscription use, summary cost, STT privacy, distribution) are not duplicated here.

## 13. Self-review
- S claims re-read at `5d98d60` in this pass, including the new §1 facts. D claims come from five developer.android.com pages fetched 2026-09-11 (window size classes, accessibility, audio output, foreground-service types, Android 14 features). U: reduced-motion signal, 200% fit, Fold7 window dp, One UI Korean metrics, mic-level rate and battery, TTS output level, buffered-audio leakage, headset trigger; each carries its smallest check in §5, §8 or §11.
- Checked against the brief: native Compose only, no new dependency, no task execution, router or scheduler, no compulsory visual approval, no claim that a provider, engine or phone-app thread works, no rendered-performance claim.
- Sole changed file, written with the approved absolute-path `apply_patch`. App source and core r1 were read only; `.claude/` was not opened.
- r3 changes only the five clarifications above; the rest of r2 is untouched. The `TerminalView` focus issue is a source-only risk: no test, repro or app fix was run.
