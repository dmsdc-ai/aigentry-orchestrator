# Voice Code — companion UI design contract (#1159)

**Status:** design proposal for review. Nothing was coded, built, rendered, run on a device or tested; layouts are text diagrams, not screenshots.
**Worker:** ui1159-architect · `docs/1159-voicecode-design` · base `606d4ae` · local `main` `84a8ca1` (2026-09-11T19:28:39+09:00; `base..main` touches only `state/`, not this file).
**Source (read-only):** `/Users/duckyoungkim/projects/voicecode` HEAD `5d98d60` (`main`); dirty before and after: ` D .omc/state/subagent-tracking.json`, `?? .claude/` (not opened).
**Sibling:** va1157 owns the runtime/message/audio contract; its worktree had no spec when this was written (HEAD `606d4ae`, clean). Every runtime field in §9 is **provisional**: named here, guaranteed nowhere.
**Labels:** **S** source line re-read · **D** official Android doc fetched 2026-09-11 · **U** unverified · unlabeled = proposal.

## 1. Current UI, measured (S)
| File (lines) | Today | Fate |
|---|---|---|
| `MainActivity.kt` (143) | collects 26 flows into `MainScreen` plus a 15-argument save callback (`:37-118`); requests `RECORD_AUDIO` in `onCreate` | screen host |
| `ui/MainScreen.kt` (372) | top bar: 10dp status dot, "VoiceCode", text `>_` toggle, "busy" chip, settings; body splits Terminal/Chat on `maxWidth > maxHeight` (`:222`); partial transcript floats over content (`:277-297`) | rebuilt |
| `ui/VoiceButton.kt` (116) | one 72dp FAB; taps during Processing silently ignored (`:92-94`); one label "Voice control" for every state (`:111`); infinite 1.0→1.15 pulse | becomes control bar |
| `ui/ChatView.kt` (191) | bubbles show raw `message.content` (`MainViewModel.kt:1300-1306`) while TTS speaks `compressed.ttsText` (`:1308-1321`); sender hard-coded "Claude" (`:142`); 10sp time | replaced by spoken-summary history |
| `ui/SettingsDialog.kt` (804) | one `AlertDialog`: mode, SSH secrets, Unsafe switch, TTS/STT radios with prices; every non-builtin TTS choice still plays via Android TTS (`VoiceEngineManager.kt:99-109`) | full-screen settings + setup |
| `ui/TerminalView.kt` (279) | VT100 view with a hidden typeahead field | kept, moved off home |
| `ui/theme/*` (133) | dark-only navy/pink constants; no light scheme; system-bar icons forced light (`Theme.kt:32-37`); 11sp labels | re-tokenized |
- 9 UI files, 2,082 lines (`wc -l`). `material-icons-extended` is already a dependency (`gradle/libs.versions.toml`; 1.7.6 in the Gradle cache): reuse it, add nothing.
- Absent (grep, 0 hits): semantics/live regions, MediaSession/headset keys, audio-route callbacks, window size classes, reduced-motion checks. `onRmsChanged` and `onEndOfSpeech` are empty stubs (`SpeechManager.kt:44-54`).
- No callers (mention only, out of scope): `ui/CodePreview.kt`, `res/drawable/ic_mic.xml`.

## 2. Visual thesis
Voice Code is an earpiece with a glance surface. The screen answers three questions, in this order and nothing more: what is the loop doing now, what is waiting for me, what did I last hear. Neutral graphite/paper surfaces, one teal action colour, three meaning colours (amber = needs you, red = failed or destructive, green = done). The brand is the "Voice Code" wordmark at title size in the top bar plus the teal; no hero, gradient, orb, card mosaic or nested card. The only card is the pending question, because the card is the interaction. The waveform is drawn from measured mic level only: evidence of audio, never of identity, auth or completion.

## 3. Information architecture
| Surface | Shows | Reached from |
|---|---|---|
| 세션 (home) | loop state, pending question, last summaries, controls | launch |
| 세션 선택 | provider → connector → session/task, billing, verification | top-bar `SwapHoriz`; bottom sheet (compact) or side pane (≥600dp) |
| 최근 요약 | exactly what was spoken, newest first | "모두 보기"; right pane at ≥600dp |
| 원문 | raw text or SSH terminal behind a summary | summary row; `Terminal` icon in SSH mode |
| 설정 | connections, voice, headset & privacy, safety, diagnostics | top-bar `Settings` |
| 처음 설정 | permissions, earbuds, first connection, voice check | first run; 설정 › 연결 추가 |
Navigation is a `Screen` enum in `rememberSaveable` plus `BackHandler` (already in `activity-compose`); no navigation library (Article 1/17). The screen-off surface is the ongoing notification (§6.5).

## 4. Adaptive layout
Layout follows the window width class, never the device model; size classes are determined by the app window, not the device (D). Compact < 600dp (expected: folded outer screen), medium 600–839dp and expanded ≥ 840dp (expected: unfolded inner). Width is read from the root `BoxWithConstraints`; no adaptive library. The builder records real dp; nothing here assumes pixels.
```text
COMPACT (<600dp)
top bar 64dp ........ Voice Code                        [⇄ 세션 선택] [⚙ 설정]
session (3 lines) ... Claude · Claude Code CLI
                      로그인 버그 수정   [구독]   [연결 확인 14:05]        작업 취소
state (2-line slot) . [Hearing] 듣는 중
waveform 48dp ....... ▁▃▅▇▅▃▁▂▄▆▄▂   (measured mic level only)
transcript ≤3 lines . "로그인 실패 원인 찾아…"
question card ....... 질문 · 답을 기다리는 중 · #q7f3        (only while one is active)
                      auth.ts 수정을 허용할까요?   대상: 로그인 버그 수정
                      [허용]   [거부]
recent ≤3 rows ...... 14:02 실패 · 테스트 3개 실패. 원인은 토큰 만료 처리…   모두 보기 ›
control bar 88dp .... [VolumeOff 재생 중지]   ( Mic 말하기 )   [MicOff 마이크 끄기]

MEDIUM / EXPANDED (≥600dp)
┌ session pane (max 560dp): top bar · session · state · question ┬ right pane: 최근 요약 list,
│ recent strip hidden (the right pane shows it)                   │ or 세션 선택 / 원문 / summary detail
└ control bar 88dp under the session pane ────────────────────────┴──────────────────────────────
```
- The control bar stays under the session pane, so the thumb position matches folded and unfolded. Fold/unfold keeps screen, open sheet and scroll.
- Compact height (< 480dp, landscape): recent strip hidden, page scrolls, control bar stays pinned.

## 5. Tokens
**Typography:** system sans (the user's Korean font on One UI; nothing bundled), sp only, letter spacing 0, no viewport-width scaling.
| Token | sp / line | Weight | Use |
|---|---|---|---|
| stateTitle | 28 / 36 | SemiBold | 듣는 중 …, reserved 2-line slot |
| summary | 20 / 30 | Regular | last summary, question text |
| title | 18 / 26 | Medium | session and task name |
| body | 16 / 24 | Regular | rows, settings |
| label | 14 / 20 | Medium | buttons, chips |
| meta | 13 / 18 | Regular | times, provider line; smallest size in the app |
| mono | 14 / 20 | Regular, monospace | ids (`#q7f3`), file names, 원문 |
**Spacing and shape:** 4dp grid (4 / 8 / 12 / 16 / 24 / 32); gutter 16dp compact, 24dp at ≥600dp; rows ≥ 56dp; 24dp between sections. Radius 12dp for the question card and sheets, 8dp for chips; circular talk button; no elevation except the sheet scrim.
**Palette** (fixed; no dynamic colour, because wallpaper hues would blur state meaning). Hex values are starting points: the builder measures text contrast ≥ 4.5:1 below 18sp and ≥ 3:1 otherwise (D).
| Role | Light | Dark |
|---|---|---|
| background / surface / surfaceVariant | #F6F7F8 / #FFFFFF / #ECEEF0 | #0F1113 / #171A1D / #22262A |
| outline · onSurface · onSurfaceVariant | #C3C8CD · #15181B · #4E555C | #3B4147 · #E7E9EB · #A6AEB6 |
| accent (actions, listening) · onAccent | #006A6A · #FFFFFF | #5CD5D2 · #002020 |
| attention (question, offline, headset lost) · container | #B26B00 · #FFF1DB | #FFB84D · #3A2A0A |
| danger (failure, destructive) · container | #B3261E · #F9DEDC | #F2B8B5 · #601410 |
| success (done) | #1E6A33 | #7FD892 |
Text on attention/danger containers uses onSurface; colour is never the only signal.
**Icons:** the existing Material artifact; names verified in the 1.7.6 cache: `Mic`, `MicOff`, `Hearing`, `GraphicEq`, `Sync`, `HourglassTop`, `AutoMirrored.VolumeUp`/`VolumeOff`/`Help`, `HeadsetOff`, `CloudOff`, `ErrorOutline`, `CheckCircle`, `Cancel`, `Replay`, `History`, `SwapHoriz`, `Terminal`, `Settings`, `Lock`. Outlined = idle, Filled = active/selected, so shape changes too. Every icon-only control has a Korean `contentDescription` and a long-press tooltip.
**Touch:** every control ≥ 48×48dp (D); secondary controls 56dp; talk 72dp; ≥ 8dp between targets.
**Stable dimensions:** top bar 64dp; state title keeps a 2-line slot and grows only with font scale; waveform 48dp; transcript ≤ 3 lines, trimmed from the start; control bar 88dp + navigation insets with its 3 slots always present (disabled with a reason, not hidden). Nothing floats over content.
**Motion:** state change = 180ms crossfade of icon and label, no size change; question card enters with 200ms fade and an 8dp rise; the waveform redraws only on new level samples and stops when not visible; no infinite pulse. With animations off or Battery Saver: transitions are instant and the waveform becomes a static level bar updated ≤ 4 times a second (signal: builder confirms on One UI, starting from `ValueAnimator.areAnimatorsEnabled()`; U, the official page could not be read here).
**Theme and font scale:** light/dark follow the system; system-bar icons follow the theme. Text can scale to 200%, non-linearly (D, Android 14). At 200% labels wrap, never ellipsize; control-bar labels move under their icons and the bar grows; the question card scrolls with the page.

## 6. Views
**6.1 Session (home).** Session line: `provider · connector` (meta), task title (title), chips for billing (`API 과금` / `구독` / `과금 확인 안 됨`) and verification (`연결 확인 14:05` / `연결 확인 안 됨`). Selecting shows `선택됨 · 확인 전` until verified. State region: icon + title + one meta line (`Claude가 작업 중 · 2분`); the live transcript appears only while listening or transcribing, in flow.
- **재생 중지** stops speech and drops queued audio; the text stays in history and an active question stays active.
- **말하기** starts or stops listening. **마이크 끄기** is a hard mute: no active or passive listening, barge-in included (barge-in opens passive listening while TTS plays, `BargeInController.kt:69-74`); the state line shows `마이크 꺼짐`.
- **작업 취소** is a text button on the session line, enabled only when the connector reports cancel support (otherwise disabled with meta `이 연결은 취소를 지원하지 않음`); it opens a dialog whose default focus is `계속 진행`.
**6.2 Pending question.** One active question at a time, bound to question id + session + task + action; the card shows the exact spoken text, target, action and short id. Buttons are the options the runtime supplies, equal weight, no default focus, no "모두 허용". A newer question waits as `대기 중인 질문 1개` and is not actionable. Answered → it collapses into history as `답변함: 거부 · 14:07`. On reconnect, session switch or timeout → `만료됨 · 다시 물어볼 때까지 답할 수 없음`, buttons removed. The screen is never a required step; voice answers work with the screen off.
**6.3 Session picker.** Groups in fixed order ChatGPT, Codex, Claude, Grok, Gemini; only connectors present in Settings, the rest collapsed under `설정되지 않음` with `연결 추가`. Row: connector, session/task title, billing chip, last verification. Footer: `Voice Code에 연결된 세션만 표시됩니다.` (no claim about phone-app threads). Switching never changes billing silently; an API-billed target says `API 과금` before it can be picked.
**6.4 Recent spoken summaries.** Rows = exact spoken text (not raw output), time, session short name, category icon + label (질문 / 실패 / 완료 / 알림); actions `다시 듣기`, `원문`. Resolved or expired questions render muted with their outcome, never with buttons. Memory only, as today (200 cap, `MainViewModel.kt:1368-1378`), unless D2.
**6.5 Notification (screen-off; provisional).** Ongoing: `Voice Code · 말하는 중 · 로그인 버그 수정`; actions `재생 중지`, `마이크 끄기`; no cancel or answer action. The lock-screen public version shows state only, never summary text.
**6.6 Settings and first setup.** Sections: 연결 (per connector: method, explicitly chosen billing mode, verification, `삭제`), 음성 (speech rate, summary length `짧게` / `보통`, `말 끊기 허용`), 헤드셋·개인정보, 안전 (Unsafe mode: danger style, off by default, dialog confirm, `음성으로는 켤 수 없음`), 진단 (versions, 원문 terminal).
- Engines/providers the runtime has not verified are disabled as `이 기기에서 확인 안 됨`, never offered as working; paid or off-device processing says `외부 전송 · 유료` on the row itself.
- Credentials: keyboard or paste only; the mic is force-muted while a credential field has focus; never spoken, never in history.
- First setup, separate from daily use, each step `완료` / `필요`: 마이크 권한 → 알림 권한 → 이어폰 연결 → 연결 추가 → 음성 확인. OS-enforced and marked `화면에서 진행`: permission dialogs, Bluetooth pairing, account sign-in. A microphone foreground service cannot start from the background (D); the UI never promises screen-off setup.

## 7. State/action matrix (audio cues provisional on va1157)
| State | Icon | Title | Colour | 말하기 | 재생 중지 | 마이크 끄기 | 작업 취소 |
|---|---|---|---|---|---|---|---|
| Idle | Mic (outlined) | 대기 중 | onSurface | start | disabled | toggle | if supported |
| Listening | Hearing (filled) | 듣는 중 | accent | stop & send | disabled | mute = discard utterance | if supported |
| Transcribing | GraphicEq | 받아쓰는 중 | onSurfaceVariant | disabled | disabled | toggle | if supported |
| Sending | Sync | 보내는 중 | onSurfaceVariant | disabled | disabled | toggle | disabled |
| Agent working | HourglassTop | Claude가 작업 중 | onSurfaceVariant | start | disabled | toggle | if supported |
| Speaking | VolumeUp | 말하는 중 | onSurface | start (stops speech) | enabled | toggle | if supported |
| Question pending | Help | 답을 기다리는 중 | attention | start = answer | if speaking | toggle | if supported |
| Offline | CloudOff | 오프라인 · 재연결 3회째 | attention | disabled | if speaking | toggle | disabled |
| Headset lost | HeadsetOff | 이어폰 연결 끊김 | attention | disabled | auto-stopped | forced off | if supported |
| Error | ErrorOutline | Claude 응답 없음 | danger | start | if speaking | toggle | if supported |
| Mic muted (flag) | MicOff (filled) | … · 마이크 꺼짐 | onSurface | `마이크 켜기` | per state | unmute | per state |
Title priority: Headset lost > Offline > Listening > Transcribing > Speaking > Sending > Agent working > Question pending > Error > Idle. The question card's visibility is independent of the title. TalkBack: the state region is a polite live region; a question announces once on arrival.

## 8. Failure and recovery
| Condition | Screen | Ear (provisional) | Recovery |
|---|---|---|---|
| Headset lost | 이어폰 연결 끊김 · `보류된 요약 2개` | nothing through the phone speaker; mic closed | earbuds back → `보류된 요약 2개가 있어요. 들을까요?`; or `이번만 스피커로 듣기` (per event, never remembered) |
| Offline | 오프라인, attempt n, `마지막 연결 14:03` | once: `연결이 끊겼어요.` | automatic retry, `지금 다시 연결`; the active question expires |
| Connector error / sign-in expired | 오류 + reason, `휴대폰에서 다시 로그인 필요` | `Claude 로그인이 필요해요.` | opens the setup step; never switches to API billing by itself |
| Not understood | 대기 중 + meta `잘 못 들었어요` | `다시 말씀해 주세요.` | tap, or a headset trigger if the runtime provides one |
| Mic permission missing | blocking row `마이크 권한이 필요해요` | none | `권한 설정 열기` (on screen) |
| Question expired | card muted, `만료됨` | `이전 질문은 만료됐어요.` | wait for the agent to ask again |
Headset rule basis: Android broadcasts `ACTION_AUDIO_BECOMING_NOISY` when output falls back to the built-in speaker (D). The UI requires the runtime to stop speech on it and never to resume on the speaker automatically.

## 9. Runtime data the UI needs (provisional; va1157 owns production)
- `loopPhase` (incl. end-of-speech and send-acknowledged); `inputLevel` (measured mic RMS); `outputRoute` earbuds | speaker | unknown, with change events.
- `session`: provider, connector, sessionId, title, taskTitle, `billing` api | subscription | unknown, `lastVerifiedAt`.
- `activeQuestion`: id, sessionId, taskId, action, spokenText, options, state active | answered | expired; `queuedQuestions` count.
- `spokenSummaries[]`: id, text as spoken, category, sessionId, questionId?, spokenAt, rawRef?.
- `capabilities`: cancelTask, replay, headsetTrigger; `connectivity`: state, attempt, lastOkAt.
A missing field renders its "unknown" copy. The UI never infers connectivity from selection, billing from a provider name, or completion from the waveform.

## 10. Implementation slices (one owner per file; no new dependency)
| Slice | Files | Scope | After |
|---|---|---|---|
| A tokens | `ui/theme/Color.kt`, `ui/theme/Theme.kt`, `ui/theme/Type.kt`, `res/values/themes.xml`, `res/values/colors.xml`, new `res/values-night/themes.xml` | §5, light + dark; `Space`/`Motion` objects in `Theme.kt` | — |
| B UI state | new `ui/SessionUiState.kt` | pure mapping of today's flows + §9 fields to §7 states and priority; explicit unknowns | — |
| C session parts | new `ui/StateHeader.kt`, new `ui/QuestionPanel.kt`, `ui/VoiceButton.kt` (becomes `ControlBar`) | §6.1–6.2 | A, B |
| E history | new `ui/SummaryHistory.kt` | §6.4 | B |
| F picker | new `ui/SessionPicker.kt` | §6.3 (`ModalBottomSheet` / pane) | B |
| G settings | new `ui/SettingsScreen.kt`, new `ui/SetupScreen.kt` | §6.6 | A |
| H copy | `res/values/strings.xml` | all Korean copy and content descriptions; app name `Voice Code` | — |
| D shell | `ui/MainScreen.kt`, `MainActivity.kt`; delete `ui/ChatView.kt` and `ui/SettingsDialog.kt` once unused | width classes, panes, `Screen` enum, 원문 screen hosting `TerminalView` | C, E, F, G |
| I notification | `ssh/SshForegroundService.kt` | §6.5 content and actions only | va1157 service design |
Out of UI scope: logic in `viewmodel/`, `voice/`, `network/`, `ssh/` (va1157). Manifest changes (`POST_NOTIFICATIONS`, microphone service type) are coordinated with va1157. Every coder slice runs the Snyk fix → rescan loop before DONE.

## 11. Validation (builder/tester; none run here)
- Tester (JVM, existing JUnit): `SessionUiState` title priority; expired question has no actions; selection without verification shows `확인 전`; unknown billing; mute overrides listening.
- Builder screenshots on Z Fold7: folded outer, unfolded inner portrait and landscape × light/dark for Idle, Listening, Speaking, Question pending, Offline, Headset lost; 200% font on outer for Idle, Question pending, Headset lost; animations off for Listening and Speaking. Record the measured window dp with each shot.
- Pass: no clipped or overlapping text or controls; every target ≥ 48dp (Accessibility Scanner); contrast per §5; TalkBack reads state, session, question and each control by name; fold/unfold keeps screen, sheet and scroll; control and state bounds do not move on state change.
- Audio with Buds2 Pro: disconnect mid-speech → phone speaker stays silent, mic closes, 이어폰 연결 끊김 shows at the next state update; reconnect → held count offered, nothing plays on the speaker by itself.
- Not validated by this document: rendering, real contrast, Korean line breaks in the One UI font, TalkBack order, latency, battery.

## 12. Decisions for the user
- **D1 Headset loss:** (a) pause and hold, plus a per-event `이번만 스피커로 듣기` — recommended; or (b) hold only, with no speaker option.
- **D2 History retention:** (a) memory only until the app closes — recommended, today's behaviour; or (b) on-device for N days (handier, but stores work content on the phone).
- **D3 Unsafe mode:** (a) keep it as a confirmed Settings switch — recommended; or (b) remove it from the phone.

## 13. Self-review
- S claims cite lines re-read in this pass. D claims come from five developer.android.com pages fetched 2026-09-11: window size classes, accessibility, audio output, foreground-service types, Android 14 features. U: the reduced-motion API wording (two fetches returned no method text).
- Checked against the brief: native Compose only, no new dependency, no task execution/router/scheduler, no compulsory visual approval, no claim that a provider, engine or phone-app thread works.
- Sole changed file, written with the approved absolute-path `apply_patch`. App source was read only; no app file or private setting was written; the untracked `.claude/` was not opened.
- Open unknowns, recorded rather than researched further: real window dp of the Fold7 outer and inner screens (the size class per screen is expected, not measured); Korean metrics of the One UI font; mic-level callback rate and battery cost; whether TTS output level can be measured (until it can, Speaking shows its icon, not a waveform); headset-trigger availability; every §9 field until va1157 publishes its contract.
