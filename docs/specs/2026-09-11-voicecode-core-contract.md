# Voice Code thin voice remote — core runtime, message and audio contract (#1157)

**Status**: SPEC, phase 1/1 — design only. No implementation, test, build, install, app/daemon launch, model download or API call
was run; implementation waits for review/approval. UI, settings screens and pairing visuals belong to ui1159; this contract owns
runtime, messages and audio. **Source** `/Users/duckyoungkim/projects/voicecode` @ `5d98d60` (`main`); dirty state before = after:
` D .omc/state/subagent-tracking.json`, `?? .claude/` (not opened). **Report** branch `docs/1157-voicecode-core-contract`, base
`606d4ae`; local `main` `84a8ca1` at 2026-09-11T10:29Z → `9217a0d` at 10:50Z (3 orchestrator doc commits, none touch this file;
base is its ancestor); `origin/main` `a536cd8`.
**Labels**: S = committed source `file:line` at that SHA · D = official doc (§14) · U = unknown + smallest validation · P = proposal
(every budget is a proposal, not a measurement). Kotlin paths are under `android/app/src/main/java/com/voicecode/app/`, TS under `bridge/src/`.

## 1. Decision

Keep both existing stacks. The Node bridge becomes the one **connector host**: it runs the user's own agent CLIs, owns their
sessions and emits one versioned event protocol (§4). The phone owns microphone, STT, speech queue, TTS, and binding spoken answers
to live questions. A remote host is reached by forwarding the same WebSocket through the existing SSHJ connection instead of scraping
a PTY. Nothing is added beyond that: no cloud hub, no mandatory PC/GPU, no scheduler, no second general agent, no new runtime
dependency. The SSH-terminal mode stays as a manual legacy mode with the §10 fixes and without voice approvals.

## 2. Measured facts that drive the contract (S @ 5d98d60)

| # | Fact | Evidence |
|---|---|---|
| F-a | TTS choice ignored: `speak()` always uses Android TTS; default engine is `kokoro` | `voice/VoiceEngineManager.kt:30,95-110`; `session/SessionStore.kt:161` |
| F-b | STT choice stored, never read; only `createSpeechRecognizer` (not the on-device variant), `ko-KR` | `VoiceEngineManager.kt:65-67`; `voice/SpeechManager.kt:112,118-144` |
| F-c | Bridge drives Claude CLI only: per message `claude -p --output-format stream-json`, `--resume <id>` else `--continue`; busy → reject; kill = SIGTERM; `result` text ignored; parser reads top-level `content/message/text` (vs documented schema: U until the S2 fixture); stderr chunks become errors | `claude-cli.ts:38,89-92,96-109,138-147,185-192,269-275,300-340` |
| F-d | Wire protocol has no version, event id, sequence, session/task binding or question frame; `waiting_input` is declared but only dead code emits it; `send` drops frames when no client is attached, so nothing is replayable; `BridgeClient.send()==true` means enqueued only | `protocol.ts:13-19,35`; `output-parser.ts:229`; `ws-server.ts:290-301,375-386`; `network/BridgeClient.kt:56-60` |
| F-e | Bridge accepts the first local client without auth; CORS `*`; unauthenticated `/api/tts`, `/api/stt`; a `config` frame replaces API keys | `ws-server.ts:81-84,158-160,177-225,233-240,304-320` |
| F-f | Bridge launch kills the port owner and runs `/sdcard/voicecode-bridge-update.js` if present | `termux/TermuxLauncher.kt:88-99` |
| F-g | SSH: `PromiscuousVerifier`; writes in uncaught child coroutines; reconnect opens a bare shell and never re-runs auto-launch | `ssh/SshSessionManager.kt:128-131,143-151,188,272-279`; `viewmodel/MainViewModel.kt:1038,1063-1091` |
| F-h | Voice router: `취소/멈춰/중지/stop` (and any "취소 …" prefix) → Ctrl+C, so "stop talking" kills the task; `네/yes` → `y` + newline with no bound question | `ssh/VoiceCommandRouter.kt:16-19,26-36`; caller `MainViewModel.kt:1277-1283` |
| F-i | Speech queue: HIGH = `stop()`+`clear()` then speak, so a later error erases a pending question and queued results; queue unbounded; barge-in clears everything; no audio-focus or route API; TTS has no `AudioAttributes` (grep: only the progress drone sets them, `MainViewModel.kt:625`) | `voice/TtsManager.kt:33,95-105`; `voice/BargeInController.kt:59-62` |
| F-j | Not screen-free: the trigger is an on-screen tap; `onPause` cancels recording and stops speech; the FGS is `specialUse` and starts/stops on every SSH connect/disconnect | `ui/VoiceButton.kt:89`; `MainViewModel.kt:868-881,1210-1226,1414-1418`; `AndroidManifest.xml:8,34-37` |
| F-k | Raw text spoken: bridge error strings at HIGH; INFO speaks the first output line; SSH mode scrapes the visible screen after 1.5 s of quiet | `MainViewModel.kt:291-297,1356-1358`; `engine/ContextCompressor.kt:256-273` |
| F-l | Privacy: the transcript, raw bridge frames, spoken text and the OpenAI key prefix are logged; secrets are plaintext DataStore strings; the `gpt-4o-mini` summarizer is silently on whenever a key exists | `MainViewModel.kt:391-406,392,1218,1267,1294`; `BridgeClient.kt:109`; `TtsManager.kt:86,90`; `SessionStore.kt:23-31` |
| F-m | Tests: 3 JVM files (`AnsiStripper`, `VoiceCommandRouter`, and an injectable `BargeInController`, `BargeInController.kt:22-31`); bridge has `typecheck` only; no CI | `android/app/src/test/…`; `bridge/package.json:10-15` |

**Call chains (S).**
- **Speak:** `MainViewModel.handleIncomingMessage` (`:1293-1364`) or the SSH scrape `processTerminalScreenForTts` (`:314-423`) → `VoiceEngineManager.speak/speakError` → `TtsManager.speak`.
- **Listen:** `VoiceButton.kt:89` → `MainActivity.kt:74` → `startRecording` (`:1210`) → `SpeechManager.startListening` → `sendMessage` (`:1265`) → `BridgeClient.sendCommand` (local mode) or `VoiceCommandRouter.route` → `SshSessionManager.sendInput/sendLine` (SSH mode).
- **Bridge:** `ws-server.ts:326-345` → `ClaudeCliManager.sendInput` → `attachCliEvents` (`:349-371`) → `send`.

The earlier report's findings were re-measured and all hold at this SHA (F-a…F-g, F-l). New here: stop words kill the task (F-h), questions are lost (F-i), no audio focus or route control.

## 3. Ownership boundary and connector profiles

| Concern | Phone (Voice Code app) | Connector host (bridge) | Agent CLI / provider |
|---|---|---|---|
| Mic, STT, TTS, speech queue, barge-in, audio route | owns | — | — |
| Prompt delivery to the selected session | sends `prompt` | admits, dedupes, forwards | executes |
| Model, context, tools, permissions, execution | — | passes per-profile flags | owns |
| Authentication and billing | never sees provider tokens | reports each profile's `auth` | owns (user login or key) |
| Original question/result text | keeps a bounded copy for "자세히" | extracts verbatim | produces |
| Speech summary | fidelity guard + template fallback (§6) | extracts the agent's `SPEECH:` line | writes it |
| Outcome (success/failure) | speaks it, never infers it | machine evidence only | exit/result fields |

**Connector profiles** (P: `~/.voicecode/profiles.json` on the host, user-authored, read by `index.ts`): `{profile, provider, connector, auth: subscription/api_key, model?, project, permission_mode, protected}`.
- `auth` is declared by the user and reported in `welcome`. The host never switches it and never falls back from a subscription to a paid key; it sends `auth_required` instead.
- Provider, model, connector, auth, billing and capabilities are separate fields; none is inferred from another.

| Target | Connector the user installs and logs into | Structured output (D) | Question channel |
|---|---|---|---|
| Claude | Claude Code `claude -p` | `--output-format`/`--input-format stream-json`, `--resume <id>`, `--session-id`, `--permission-mode`, `--append-system-prompt`, `--permission-prompt-tool` (an MCP tool) | D, via the permission-prompt tool |
| ChatGPT/Codex | `codex exec --json` | JSONL `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` (messages, commands, file changes, MCP calls); `codex exec resume <id>`; ChatGPT sign-in or `CODEX_API_KEY`; read-only sandbox by default | U — none documented for exec |
| Gemini | Gemini CLI headless | `--output-format stream-json`: `init`, `message`, `tool_use`, `tool_result`, `error`, `result` | U — not documented |
| Grok and others | OpenCode `run --format json`, `--session`, `--model provider/model`, `serve` + `--attach` | raw JSON events | U |

- **Not supported:** consumer-app threads (chatgpt.com, claude.ai, grok.com, Gemini app). No connector or model API reaches them, and the host does not emulate them.
- **New targets:** one adapter file mapping CLI events to §4 events. A capability stays off until a captured fixture proves it.
- **Claude subscription terms:** support article 15036540 and the SDK overview's prior-approval wording conflict, so this is unresolved (H3). Voice Code drives only the user's own logged-in CLI and never reads OAuth files or `auth.json`.

## 4. Event protocol v1 (JSON text frames on the existing WebSocket)

- **Envelope.** Every frame is `{v:1, type, …}`. Host→phone frames also carry `epoch` (random per host process start), `seq` (strictly increasing per epoch, one writer: the bridge event loop) and `ts`.
- **Handshake, phone side.** The first frame is `hello{v_min,v_max,token,caps,resume?:{epoch,after_seq}}`. The host closes with 4401 on a bad or missing token (constant-time compare) or on any `Origin` header (OkHttp sends none: U, checked in G1), and with 4426 if no common `v` exists.
- **Handshake, host side.** The host replies `welcome{v,epoch,host_version,caps,profiles[…,auth,protected,caps],sessions[{session,profile,state,open_qids}]}`. It then replays retained events with `seq>after_seq` and re-sends every still-open `question` (same `qid`, new `seq`). A different epoch or an evicted range produces `replay_gap{from,to}`, and the phone marks every earlier qid stale.

| Direction | Frame | Rule |
|---|---|---|
| phone→host | `prompt{req, session or (profile,project), text}` | `req` is a phone UUID; the host remembers 256 `req`s per epoch and repeats the same `accepted` |
| phone→host | `answer{req, qid, decision: allow/deny/option/text, option?, text?, digest}` | forwarded only if `qid` is open in this epoch and `digest` equals that question's `action.digest` |
| phone→host | `cancel{req, session, task}` | task cancellation through the adapter's signal (Claude: SIGINT per the #1152 doc reading; confirm in S2); refused for `protected` sessions and for tasks this phone did not start |
| host→phone | `accepted{req,session,task}` / `rejected{req,code,retryable}` | admission only — not delivery to the model, not success |
| host→phone | `status{session, task, state: running/waiting_answer/idle}` | never spoken; earcon only |
| host→phone | `question{session, task, qid, kind: approval/choice/text, original, truncated, speech?, action?{tool,target,scope,digest}, options?, expires_at?}` | `qid` is unique per epoch and bound to the provider request id (Claude `tool_use_id`) |
| host→phone | `question_closed{qid, reason: answered/expired/cancelled/superseded}` | the phone drops queued speech for that qid |
| host→phone | `result{session, task, outcome: success/failure/partial/cancelled/unknown, evidence{source,…}, original, truncated, speech?, speech_src: agent/template/none, flags{failure,uncertainty,scope_change}}` | `outcome` comes only from machine fields (Claude `result` event, exit code; exact names from the S2 fixture); no evidence means `unknown` |
| host→phone | `error{code, retryable, req?, session?, task?, message}` | codes: `auth_required`, `busy`, `protected`, `unknown_session`, `stale_question`, `digest_mismatch`, `expired`, `version`, `connector_exited`, `provider_limit`, `internal` |

**Semantics.**
- **Delivery.** Host→phone frames are at-least-once within an epoch (replay), deduplicated by `(epoch,seq)`. Phone→host frames are at-most-once per `req`. If the socket drops before `accepted`, the phone resends the same `req` after reconnecting. If the epoch changed, it says "전송 여부를 확인 못 했어" and never resends automatically. Nothing is exactly-once across host restarts.
- **Retention and order.** The ring buffer keeps the last 512 events or 1 MiB (P), in memory. A gap or out-of-order `seq` → reconnect with `resume`.
- **Compatibility.** An unknown `type` or field is ignored, and only its type name is logged. The phone offers no verb whose capability is missing (`questions`, `answers`, `cancel`, `replay`, `speech_summary`, `resume`).
- **Sessions.** Voice prompts go only to sessions listed in `welcome`: sessions the host created or the user registered. The host never attaches to a live interactive terminal session (no PTY injection into e.g. an orchestrator). `session` maps to the provider's session id, and that map is persisted (P: `~/.voicecode/sessions.json`, ids only). Resume is by id only, never `--continue`, which also picks up `-p` sessions (D).
- **Busy.** A prompt to a busy session gets `busy`; there is no queue and no scheduler.

## 5. Answer and approval authority

1. **Voice is never identity.** Recognition confidence, the word "네/yes", a waveform, a valid token, or the absence of contrary evidence does not authorize anything by itself.
2. **One readback, one answer.** Only the open `qid` whose readback finished in the current listen window can be answered. A new question, a reconnect or a `replay_gap` resets the readback, so stale or mixed sources cannot authorize.
3. **Deny is easy, allow is gated.**
   - `deny` and "나중에" (leave the question open) are always allowed by voice.
   - `allow` needs all of: the `answers` capability; a final (not partial) STT result for a verb phrase ("승인해" / "allow it"); an action in the voice-approvable tier (H2); and `digest` matching exactly the `tool/target/scope` that was read back.
   - If any is missing, the phone says "데스크에서 승인해줘" and the question stays open.
4. **Readback is exact.** `target` is read verbatim: the full relative path, or the full command up to 120 characters. `ContextCompressor.optimizeForTts` path stemming is never applied to approval targets. A longer command disables voice approval for that qid.
5. **Fail closed.** At `expires_at` the permission tool returns deny. Claude's own tool-call timeout vs this expiry is U (S2 fixture). Voice-started turns never use `bypassPermissions` or `--dangerously-skip-permissions` (`claude-cli.ts:98-100`; overridable only via H2).
6. **Stop is not cancel.** `멈춰`, `그만` and `stop` stop speech only. Cancelling a task takes "작업 취소" → readback of session and task → "취소 확인" → `cancel`. Sessions this phone did not start, or that are marked `protected`, cannot be cancelled by voice.
7. **Terminal (SSH-PTY) mode** has no qid, so it gets no voice y/n/Enter mapping (F-h is removed). Ctrl+C is sent only after "작업 취소" plus confirmation.

## 6. Original vs speech summary

- **Original.** The host extracts the agent's user-facing text verbatim, up to 4 KiB (P), and sets `truncated` if it cuts. The phone keeps the last 20 items in memory for "자세히". Nothing is persisted, and transcripts, audio and credentials are never logged.
- **Speech, written by the agent.** The Claude adapter appends to the system prompt (D, `--append-system-prompt`): "end every reply with one line `SPEECH:` of at most 2 Korean sentences that keeps failures, scope changes, uncertainty and any question target". The host strips that line into `speech` with `speech_src: agent`.
  - Other adapters get it only after their fixture shows it works. Fallbacks: a host `template` for structured events, else `none` (the phone uses `ContextCompressor`'s extractive path). Cost: a few output tokens on the user's quota (H4). No summarizer model runs on the phone by default; `TtsSummarizer` becomes an explicit, billed opt-in, never used for questions.
- **Fidelity guard (phone, deterministic).** Spoken text = the outcome word for `result.outcome` ("성공 / 실패 / 일부 완료 / 취소 / 결과 확인 안 됨") + `speech` + "자세한 건 '자세히'" when `truncated` or `flags.uncertainty` is set. A generated summary therefore cannot claim success. `accepted`, an idle status or a missing error plays an earcon and never becomes "완료".
- **Questions** are spoken from the `action` fields through a template: "승인 요청: {tool} {target}, 범위 {scope}. 승인, 거부, 자세히?". The agent's `speech` is used only for free-text and choice questions, and options are read verbatim.
- **Cost/privacy ledger** (runtime values; ui1159 renders them): recognizer location (on-device/cloud/unknown), summary source (agent quota, billed phone OpenAI, or free template), TTS engine.

## 7. Audio runtime seams

- **STT** (routed by `VoiceEngineManager`; P):
  - `builtin` = `SpeechRecognizer`. Prefer `createOnDeviceSpeechRecognizer` when `isOnDeviceRecognitionAvailable` (D, API 31), plus `EXTRA_PREFER_OFFLINE` and `EXTRA_BIASING_STRINGS` (session names, file names, verbs). Both extras are in AOSP (D); their API level is U, so the builder confirms.
  - Call it on the main thread only. It is not meant for continuous recognition (D), so listen in bounded windows.
  - The selected engine is honored or reported as unavailable, never silently replaced.
  - Bridge `whisper` spawns Python per request (`voice/whisper-stt.ts:52-71`) and `whisper-api` is paid cloud; both stay off in v1.
  - Research candidates (Qwen3-ASR on a server, sherpa-onnx on the device) plug in here only after passing §8 on the target device. The archived, OpenRAIL-M Supertonic is never a default.
- **TTS**: Android TTS with `AudioAttributes` (usage assistant, content speech) and a transient may-duck audio focus request held while the queue plays (P). The default becomes `builtin`: bridge TTS playback is not wired (F-a) and `kokoro` has no Korean (#1154 research, context). A later server TTS returns PCM into the same queue.
- **Screen-off lifecycle** (P; D):
  - `SshForegroundService` becomes the voice-session service, typed `microphone|mediaPlayback`, with `FOREGROUND_SERVICE_MICROPHONE`, `_MEDIA_PLAYBACK` and `POST_NOTIFICATIONS`.
  - It starts once while the activity is visible (D: a microphone FGS cannot be created from the background) and stops only on an explicit end — no churn on reconnect (F-j). `onPause` no longer cancels or stops anything.
  - A `MediaSession` with `FLAG_HANDLES_MEDIA_BUTTONS` (D) maps the headset play/pause key to push-to-talk.
  - A reply window (6 s, P) opens automatically after every spoken question, so no button is needed to answer.
  - Known ceiling (ponytail): the voice loop stays in the ViewModel. Move it into the service if V2 shows the activity being destroyed.
- **Route** (P):
  - Listen windows call `setCommunicationDevice(<BT headset>)` (D: the Android 13+ replacement for `startBluetoothSco`) and `clearCommunicationDevice()` afterwards.
  - Whether `SpeechRecognizer` follows that device is U (V3). Fallback: our own `AudioRecord(VOICE_COMMUNICATION)` fed through `EXTRA_AUDIO_SOURCE` (D).
  - If the earbuds are lost, speech pauses. It moves to the phone speaker only with consent.
- **Barge-in and echo:** keep `BargeInController`. It stops speech but keeps open questions (F-i fix). Voice barge-in stays on only on routes where V4 measures an acceptable false rate; the headset button always interrupts.
- **Speech queue** (P, `TtsManager`):
  - Priority: question > failure > result > info. Progress gets an earcon only.
  - A higher class preempts the current item, which is re-queued, never dropped. A question leaves the queue only on `question_closed`.
  - At most 8 items. Results and info older than 120 s, or beyond that cap, move to the repeat buffer and are counted ("놓친 알림 N개").
  - Each utterance is at most 2 sentences; longer text continues sentence by sentence under "자세히".
- **Fixed grammar** (ko/en, final STT results only):
  - Verbs: `다시` (repeat) · `자세히` (original) · `질문 다시` · `멈춰` (stop speech) · `상태` · `작업 취소` · `승인` / `거부`.
  - Anything else is a prompt. The phone says "보낼게: …" (entities verbatim) and waits a 2 s undo window, where "아니" or "취소" discards it (configurable down to 0).
  - "정정: …" within 10 s sends a follow-up prompt; it does not rewrite history.

## 8. Performance acceptance (proposals; nothing here was measured)

| ID | Metric and method | Proposed budget |
|---|---|---|
| A1 | Intent and entity accuracy: 60 scripted synthetic utterances (short Korean commands, Korean-English code-switch, file names, numbers, task ids) on Buds2 Pro, quiet and street | verbs ≥ 97 %; entities ≥ 90 % raw and ≥ 99 % after echo/undo; wrong approval or cancel verb dispatched = 0 (hard) |
| A2 | Silence errors: 10 min of silence + 10 min of TV/keyboard during listen windows | prompts sent = 0 (hard); false barge-ins ≤ 1 per 10 min |
| A3 | Summary fidelity: 50 synthetic question/result fixtures, 2 raters | spoken outcome = machine outcome in 100 % (hard); failure, scope, uncertainty and question target kept ≥ 95 %; p95 speech ≤ 12 s |
| A4 | Useful first audio: host emits `question`/`result` → TTS `onStart` on the phone (clock offset from handshake RTT) | p50 ≤ 0.8 s, p95 ≤ 1.5 s (built-in TTS) |
| A5 | Interruption: speech onset or button press → silence | p95 ≤ 0.4 s |
| A6 | 60 min screen-off session with 30 prompts | battery ≤ 6 %/h; thermal status below MODERATE; PSS growth ≤ 20 MB |

Logs record event ids, durations, route and API level only. Record the device build, One UI version and Buds firmware as observed; infer nothing from the device names.

## 9. Device validation matrix (tester; Galaxy Z Fold7 + Galaxy Buds2 Pro)

- **V1 fold state:** folded vs unfolded, including a fold during TTS and during listening — no crash, no duplicated or lost speech.
- **V2 locked screen:** 30 min locked — questions are spoken, the reply window opens, button push-to-talk works, the FGS survives.
- **V3 route changes:** mid-listen and mid-speech — one bud out, case closed, disconnect/reconnect, phone speaker.
- **V4 duplex/echo:** false-trigger rate of passive listening during TTS, earbuds vs speaker.
- **V5 barge-in:** interruption latency; the open question is preserved.
- **V6 network drop:** 30 s Wi-Fi drop mid-task — replay works, no duplicate speech, stale answers are refused.
- **V7 media button ownership:** after another app plays music (D: the button goes to the last app that played audio locally; U: whether our TTS counts as local playback).

## 10. Security gates (reproduce red first in isolation; then fix)

| Gate | Isolated reproduction (no real credentials, audio or personal devices) | Green |
|---|---|---|
| G1 bridge auth (F-e) | host temp dir; a stub `claude` first on `PATH` that writes a marker file; `node dist/index.js --port 18765 --project /tmp/vc`; a second process sends `user_input` → marker appears | without `hello` + token → close 4401 and no marker; any `Origin` → close; `/api/*` → 401 or removed |
| G2 shared-storage hook (F-f) | static `grep -n voicecode-bridge-update termux/TermuxLauncher.kt`; dynamic only in an emulator Termux with a benign marker script | hook and port-kill removed; the launch command (it will carry the token) is not logged (`:70,100`) |
| G3 SSH host key (F-g) | throwaway container sshd with a test user; connect, rotate the host key, reconnect → silent success | hard fail on mismatch; fingerprint spoken at first pin |
| G4 voice router (F-h) | JVM test: `멈춰` → Ctrl+C (0x03); `취소 버튼 추가해줘` → Ctrl+C; `네` → `y` + newline with no question open | stop words stop speech only; no y/n without a live qid |
| G5 bare-shell reconnect (F-g) | container sshd, startup command `cat`; kill that session's sshd child → the next utterance runs in bash | re-initialize on reconnect, or block voice until the CLI is confirmed |
| G6 logging (F-l) | emulator, fake key `sk-test-0000`, typed synthetic text → `adb logcat -d \| grep -c sk-test` > 0 | 0 matches for the key and for the text |
| G7 question loss (F-i) | JVM test on the queue policy: a question, then an error → the question is gone | the question survives until `question_closed` |

Also required before voice approvals ship: `dataExtractionRules` plus Keystore-encrypted secrets (`SessionStore.kt`); a builder-captured Claude stream-json fixture from a synthetic prompt (F-c's parser is unverified against it; `--verbose` may be required, U); a Snyk code scan on every code slice before DONE.

## 11. Implementation slices (one owner per file; order = dependency)

| Slice | Coder edits (files) | Builder | Tester |
|---|---|---|---|
| S0 security | `ws-server.ts`, `index.ts` (token, Origin, no CORS/`/api`); `termux/TermuxLauncher.kt`; `ssh/SshSessionManager.kt` (pinning, caught writes, reconnect re-init); `ssh/VoiceCommandRouter.kt`; log removals in `MainViewModel.kt`, `BridgeClient.kt`, `TtsManager.kt` | `npm run build`; `./gradlew assembleDebug` | G1–G6 red → green |
| S1 protocol | `protocol.ts`, `ws-server.ts` (epoch, seq, ring, dedupe, replay); `network/Protocol.kt`, `network/BridgeClient.kt` (hello, resume, dedupe) | both builds | parse, dedupe and gap unit tests |
| S2 Claude adapter | `claude-cli.ts` (documented schema, resume by id, SIGINT, outcome, `SPEECH:`, no bypass); new `permission-mcp.ts` (zero-dependency stdio MCP permission tool talking to the bridge over a per-run socket); `index.ts` (profiles, session map) | capture one redacted fixture per event kind (synthetic prompt, with the user's consent) | fixture replay tests |
| S3 speech runtime | `voice/TtsManager.kt`, `voice/BargeInController.kt`, `voice/SpeechManager.kt`, `voice/VoiceEngineManager.kt`, new `voice/SpeechComposer.kt` (fidelity guard + templates), `ssh/VoiceCommandRouter.kt` (grammar), `MainViewModel.kt` (event handling) | install on the Fold7 | G7; composer and grammar JVM tests; A1–A5 |
| S4 screen-free | `ssh/SshForegroundService.kt`, `AndroidManifest.xml`, `MainViewModel.kt` (`onPause`, MediaSession, reply window) | device install | V1–V7, A6 |
| S5 remote host | `ssh/SshSessionManager.kt` (local port forward; builder confirms the sshj 0.38.0 API, U), `MainViewModel.kt` (remote-bridge mode) | host bridge from a pinned tag | V6 over SSH |
| S6+ adapters | one new file each: `codex-cli.ts`, `gemini-cli.ts`, `opencode-cli.ts` | one fixture per adapter | fixture replay; the question capability stays off until proven |

**Runners:** Android `./gradlew test` (JUnit4 + coroutines-test already declared, `build.gradle.kts:74-75`); bridge adds `"test": "npm run build && node --test test/"` (Node's built-in runner, no new dependency); device matrix = CSV of event ids and timings.
**Ownership:** per slice, coder, builder and tester are three different people. S3 and S4 both edit `MainViewModel.kt`, so they run serially.

## 12. Package, install, update, rollback evidence

- **APK.** Today it is `versionCode 1` with no release signing (`build.gradle.kts:15-27`).
  - Per release: bump the versionCode, run `apksigner verify --print-certs`, record the APK's SHA-256 and the `dumpsys package` versionCode before and after.
  - Rollback: keep the previous signed APK. `adb install -r -d` may refuse a downgrade, and uninstall+install loses DataStore — say so to the user. DataStore changes must stay readable by the previous version.
- **Bridge.** Install a pinned tag with `npm ci` (lockfile) instead of `curl | bash` from `main` or `git pull` (`scripts/termux-setup.sh:3,67-72`).
  - Rollback = previous tag + `npm ci && npm run build`.
  - `welcome.host_version` and `v` reject incompatible app/bridge pairs. The `/sdcard` update path is removed (G2).
- **Evidence bundle:** app and bridge git SHAs, artifact hashes, one `welcome` frame (versions and capabilities only), the matrix CSV.

## 13. Human choices still open

- **H1 connector host placement:** Termux on the phone, a user host over SSH (which host, and is it always on?), or both. Whether Claude Code runs on Termux is U.
- **H2 voice-approvable tier:** proposed default is none (voice may only deny or defer), or read-only/project-scoped edits. Also: whether a device credential is required for allow, and whether bypass modes stay banned for voice-started turns.
- **H3 Claude subscription use:** whether Voice Code may drive `claude -p` on the subscription, given the unresolved article-vs-SDK wording.
- **H4 summary cost:** whether the agent's `SPEECH:` line may spend the user's quota, and whether the billed phone-side OpenAI summarizer stays as an opt-in.
- **H5 STT privacy:** on-device only (Korean accuracy or availability may drop) vs allowing a cloud recognizer.
- **H6 APK distribution:** signing-key custody and the distribution channel.

These are defaults, not choices: voice cancels only tasks this phone started; no speaker fallback without consent; no automatic fallback to a paid API.

## 14. Self-review and sources

- Every S row was re-read at `5d98d60`, and the dirty state did not change. Each U item carries its validation (V3, V7, the S2 fixture, the S5 sshj API, the `EXTRA_*` API levels, the Codex/Gemini/OpenCode question channels).
- Nothing here claims measured performance, exactly-once delivery, or execution success from an ACK, a summary or an idle terminal.
- Snyk: N/A (documentation only); later code slices scan before DONE.
- The earlier voicecode/STT/TTS reports were used as context only.
- D sources (retrieved 2026-09-11): code.claude.com/docs/en/cli-reference · learn.chatgpt.com/docs/non-interactive-mode (308 from developers.openai.com/codex/noninteractive) · github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md · opencode.ai/docs/cli
- developer.android.com: develop/background-work/services/fgs/service-types, reference/android/speech/SpeechRecognizer, develop/connectivity/bluetooth/ble-audio/audio-manager, media/legacy/media-buttons · android.googlesource.com: platform/frameworks/base/+/refs/heads/main/core/java/android/speech/RecognizerIntent.java
