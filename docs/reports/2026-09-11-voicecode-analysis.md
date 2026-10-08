# Voice Code — source analysis and use-case brainstorm (2026-09-11)

**Result:** Voice Code ships two working-looking paths, but neither is a trusted remote-control channel today.
- **SSH mode** (README's recommended mode) types transcribed speech straight into a remote terminal. It never checks the server's host key, and approvals are blind voice keywords.
- **Bridge mode** runs an unauthenticated loopback server that drives Claude CLI. Its stream-json parser does not match the documented event schema.

**Reusable for mobile loop control:** priority speech output + barge-in, the Korean summary templates, and the SSH transport once host keys are pinned.

**Recommended MVP:** a read-only spoken status line with exception alerts. Start/continue/resume/stop come in a later phase, gated on the #1151 identity/command contract.

**This report authorizes no integration.**

**Task** #1152 · **Role** architect · **Worker** `vc1152-architect` · **Branch** `docs/1152-voicecode-analysis` (base `0e04c6b`)
**Target (read-only)** `/Users/duckyoungkim/projects/voicecode` · **Written** 2026-09-11

Labels:
- **S** = confirmed in committed source (file:line).
- **D** = official vendor documentation (listed in §11).
- **H** = hypothesis: the code path is confirmed in source, but the runtime effect was not measured.
- **U** = unmeasured runtime behavior.

**Boundary kept:**
- No edits to Voice Code. No build, test, install, or app launch. No device access.
- No secret values or transcripts opened. The untracked `.claude/settings.json` in the target was not opened.
- `apply_patch` is not installed here (`which apply_patch` → not found), so this file was written with the editor's file-write tool. It is the only changed file.

---

## 1. Checkout and currentness (S)

| Item | Value |
|---|---|
| Target HEAD | `5d98d60d8b48b7eb170115a2492ddf5e0433106c` on `main`, tracking `origin/main` (`## main...origin/main` as of the last local fetch; no fetch performed) |
| Target last commit | 2026-05-12 `feat(voice): add barge-in — cancel TTS on user speech (P1-1)`; 21 commits total |
| Target dirty state (before) | ` D .omc/state/subagent-tracking.json` (tracked tooling state, deleted in the working tree), `?? .claude/settings.json` (untracked, not opened) |
| Target dirty state (after) | identical (re-checked before commit) |
| Working tree vs committed | every analyzed source file is committed and unmodified; the two dirty paths are tooling state, not source |
| Area recency | `android/` last touched 2026-05-12 (14 commits); `bridge/` 2026-03-01 (11); `scripts/` and `CLAUDE.md` 2026-03-01; `README.md` 2026-03-02 |
| Report worktree | Base `0e04c6b6a2bb07e8554780aaea2d543651daf640` = local `main` at start; `origin/main` `a536cd8` is an ancestor (local `main` 274 ahead, 0 behind). During the task, local `main` advanced to `d584034` (3 orchestrator doc commits: `9b688ef`, `74f3e03`, `d584034`); `0e04c6b` is its ancestor, none of the 3 touch this file, and `git merge-tree` reports a clean merge |

## 2. Inventory (measured, not README counts) (S)

| Area | Files / lines | Notes |
|---|---|---|
| Android main Kotlin | 32 / 7,100 | `MainViewModel.kt` alone is 1,436 lines; `SettingsDialog.kt` is 804 |
| Android JVM tests | 3 / 265 (23 `@Test`) | AnsiStripper 9, VoiceCommandRouter 8, BargeInController 6 |
| Android res + manifest | 9 / 140 | |
| Bridge TypeScript | 13 / 2,151 | no test script; `typecheck` only (`bridge/package.json:10-15`) |
| Scripts | 2 / 203 | `install-bridge.sh`, `termux-setup.sh` |
| Docs | 9 / 2,585 | 7 plans, 1 spec, 1 report |
| CI | none | no workflow files tracked |

**Read in full:**
- All Android main and test Kotlin, except `ui/CodePreview.kt` (confirmed to have no callers), the three theme files and `VoiceState.kt`.
- All bridge `src/*.ts` and `src/voice/*.ts`.
- Both scripts; the manifest; `network_security_config.xml` and `backup_rules.xml`.
- The app Gradle file and version catalog; `CLAUDE.md`; `README.md`.
- The barge-in spec, the benchmark report, and two SSH design docs.

**Not read:** five `docs/plans/*` implementation plans, other res XML, `package-lock.json` beyond the `ws` entry, and the Gradle wrapper.

**Instructions:** the target has no `AGENTS.md`; `CLAUDE.md` is its only instruction file.

## 3. Architecture as implemented

```
 Earbuds / phone mic
      │  (tap on the on-screen button only — no headset key, no wake word)
      ▼
 SpeechManager (Android SpeechRecognizer, ko-KR) ── transcript ──▶ MainViewModel.sendMessage
      │
      │   ┌──────────── mode "ssh" (README: recommended) ─────────────────────────────┐
      │   │ VoiceCommandRouter: 취소→Ctrl+C, 네→"y\n", 확인→"\n", else sendLine        │
      │   │ SSHJ terminal (PTY) xterm-256color, PromiscuousVerifier (no host-key check)│
      │   │ remote login shell → `cd <dir> && <startup cmd>` (any CLI)                 │
      │   │ terminal bytes → TerminalEmulator (visible screen only)                    │
      │   │ 1.5 s quiet → noise filter → line diff → regex classify                    │
      │   │ → Korean template, or gpt-4o-mini summary if an OpenAI key is set          │
      │   └────────────────────────────────────────────────────────────────────────────┘
      │   ┌──────────── mode "local" (Bridge) ────────────────────────────────────────┐
      │   │ ws://127.0.0.1:8765-8770, no auth, single client                           │
      │   │ Node bridge in Termux (auto-started through Termux's RUN_COMMAND)          │
      │   │ per message: claude -p --output-format stream-json                         │
      │   │              [--resume <id> | --continue] [--dangerously-skip-permissions] │
      │   │ stream-json → extractText → cli_output → ContextCompressor                 │
      │   └────────────────────────────────────────────────────────────────────────────┘
      ▼
 VoiceEngineManager → TtsManager (Android TTS only; HIGH = flush and speak, else FIFO) + BargeInController
```

### 3.1 End-to-end journey (S)

| Step | SSH mode | Bridge mode |
|---|---|---|
| Trigger | Button tap → `startRecording` (`VoiceButton.kt:88-97`, `MainViewModel.kt:1210-1226`) | same |
| Speech-to-text | Android `SpeechRecognizer`, `ko-KR`, partial results on (`SpeechManager.kt:118-144`); Whisper choices are UI-only (F9) | same |
| Command | `VoiceCommandRouter.route` for special keys, otherwise `sendLine(text)` (`MainViewModel.kt:1275-1283`) | `user_input` JSON (`BridgeClient.kt:66-68`, `Protocol.kt:160-167`) |
| Transport | SSHJ with password or PEM key, keepalive 10 s, backoff 1→30 s (`SshSessionManager.kt:182-238, 284-299`) | OkHttp WebSocket, ping 30 s, backoff 1→30 s (`BridgeClient.kt:23-26, 137-152`) |
| CLI / session | One long-lived remote shell; startup command sent once at the first prompt (`MainViewModel.kt:1063-1091`) | New `claude -p` process per message; session id kept in memory (`claude-cli.ts:80-121, 216-219`) |
| Parsing | Screen snapshot → `filterTerminalNoise` → diff → `✓ Tool` counters and `?`/error regexes (`MainViewModel.kt:270-423, 724-766`) | `handleJsonEvent` / `extractText` (`claude-cli.ts:205-340`) → `ContextCompressor` (`MainViewModel.kt:1296-1322`) |
| Summary | Questions and errors: a translated or trimmed line at HIGH priority. Otherwise gpt-4o-mini (≤1,200 chars sent) or a template (`MainViewModel.kt:367-421`, `TtsSummarizer.kt:69-123`) | Category templates (`ContextCompressor.kt:37-273`) |
| Speech | `speakError` = HIGH (flush); `speak` = FIFO (`TtsManager.kt:84-148`); barge-in stops speech when the user starts talking (`BargeInController.kt:69-97`) | Same; PROGRESS and THINKING are suppressed (`MainViewModel.kt:1317-1319`) |

### 3.2 LLMs, topology, lifecycle, permissions (S unless labeled)

| Topic | Finding |
|---|---|
| LLMs actually driven | **Bridge:** Claude Code CLI only (`claude-cli.ts:38, 96`). **SSH:** whatever the startup command runs. Presets are `claude`, `codex`, `aider`, `gemini` (`MainViewModel.kt:179-187`), but the noise filters and question translations target Claude Code's terminal UI (`MainViewModel.kt:741-757, 772-783`). Other CLIs are pass-through and unverified (U). **Auxiliary:** OpenAI `gpt-4o-mini` summaries, called directly from the phone (`TtsSummarizer.kt:110, 119`). |
| Topology | **Bridge:** everything runs on the phone (Termux); Claude API calls go out from Termux. **SSH:** phone → any reachable host (a comment mentions Tailscale, `SshSessionManager.kt:184`). The Bridge binds loopback only (`ws-server.ts:95`). |
| Session lifecycle | **Bridge:** the first message after bridge start opens a new session. Later messages use `--resume <id>`, or `--continue` if no id was captured (`claude-cli.ts:103-108`). The id is lost on bridge restart. **SSH:** one terminal session. On a network drop a new shell opens, but auto-launch is not re-run (F6). |
| Cancellation | **SSH:** voice keywords send Ctrl+C (`VoiceCommandRouter.kt:26-27`). **Bridge:** none; a second message while busy is rejected, not queued (`claude-cli.ts:89-92`). **Speech output:** barge-in or tap. |
| Permissions / approval | **Bridge:** `-p` without bypass (D) starts in default/Manual mode, and with no permission host every approval request is denied. The app's only alternative is the "Unsafe mode" switch → `--dangerously-skip-permissions` (`SettingsDialog.kt:520-541`, `TermuxLauncher.kt:87`). **SSH:** README recommends `claude --dangerously-skip-permissions` (`README.md:140`); otherwise approval is blind voice y/n (F7). |
| Android permissions | RECORD_AUDIO is requested at start (`MainActivity.kt:134-142`). `com.termux.permission.RUN_COMMAND` is declared (`AndroidManifest.xml:10`) but never requested or guided. No POST_NOTIFICATIONS request (grep: absent). |
| Authentication / authorization | **Bridge:** none — no token, no Origin check, CORS `*`. **SSH:** the server authenticates the user, but the client never authenticates the server. There is no app-level identity; nothing ties an utterance to a person. |
| Transcript privacy | Chat history is in memory only, capped at 200 messages (`MainViewModel.kt:1368-1378`; no persistence found). Data leaves the device to: the Android speech-recognition provider (U), the Claude API, and OpenAI when a key is set (up to 1,200 chars of terminal text per summary). Logcat receives: the full transcript (`MainViewModel.kt:1267`), terminal excerpts (`:326`), raw bridge messages (`BridgeClient.kt:109`), and the OpenAI key prefix (`MainViewModel.kt:392`). |

## 4. Product-intent check

Intent: screenless use; short Korean summaries; errors and questions interrupt; success queues; routine progress stays silent.

| Intent | Status | Evidence |
|---|---|---|
| Screenless input | **Not met.** Speaking requires tapping a visible on-screen button, and `onPause` cancels recording and stops speech | `VoiceButton.kt:88-97`; `MainViewModel.kt:1414-1418`; no MediaSession or headset-key handling (grep) |
| Short summaries, never raw output | **Partly.** SSH normal output gets a template or LLM summary. Raw text is still spoken for bridge errors (every stderr chunk), SSH error lines (≤100 chars) and the first line of bridge INFO output | `MainViewModel.kt:1356-1358, 383`; `claude-cli.ts:138-147`; `ContextCompressor.kt:256-264` |
| Errors and questions interrupt | **Met mechanically**, with noisy triggers: any line ending in `?`, or `not found`/`exception`/`failed to` anywhere | `TtsManager.kt:95-99`; `MainViewModel.kt:347-351` |
| Success queues | **Met** | `TtsManager.kt:100-105` |
| Progress silent | **Met.** The Bridge suppresses it; SSH plays a non-verbal drone while output flows | `MainViewModel.kt:1317-1319, 285-297` |
| Barge-in | **Partly.** Speech output stops when the user starts talking, but the utterance is discarded, so the user must tap again | `SpeechManager.kt:73-78`; barge-in spec §10 Q1 |

## 5. Findings (prioritized)

Severity reflects the impact if the path is exercised. Each finding separates confirmed source facts (S, D) from runtime hypotheses (H, U).

### F1 — Critical (S; whether other local clients can reach it: U) — Bridge runs prompts for any local client, with no authentication
- **Missing checks:** `ws-server.ts:81-84` creates the `WebSocketServer` without `verifyClient`. `:233-240` accepts whichever client connects first.
- **Prompt path:** `:290-293` and `:326-345` turn `user_input` into `claude` runs. `claude-cli.ts:98-100, 112-116` add `--dangerously-skip-permissions` when unsafe mode is on.
- **HTTP side:** `Access-Control-Allow-Origin: *` (`ws-server.ts:158-160`). The unauthenticated `/api/tts` and `/api/stt` endpoints spawn Python or call paid Google/OpenAI APIs (`:177-225`). A `config` message can replace the API keys (`:304-310`).
- **Caller evidence:** the app launches the bridge with `nohup` (`TermuxLauncher.kt:88-99` ← `ensureBridgeRunning` `:158, 173` ← `MainViewModel.autoConnect` `:954-957` ← `init` `:203`). It keeps listening after the app goes away, and once the app's socket is gone any other client can take the single slot.
- **U:** which on-device clients can actually reach loopback (other apps; browser pages under the browser's local-network protections) was not measured. The missing server-side check is confirmed (S).

### F2 — High (S) — Bridge launch runs an unverified script from shared phone storage
- **Code-execution path:** `TermuxLauncher.kt:93-98` checks for `/sdcard/voicecode-bridge-update.js`. If present, it is copied over `~/.voicecode/bridge/dist/index.js` and run by Termux's Node (`:99`). Anything that can write shared storage can plant code that runs as the Termux user, which in Bridge mode holds the Claude credentials.
- **Port kill:** the same command first kills whatever process owns the port (`:88`).
- **Setup prerequisites (D, Termux RUN_COMMAND wiki):** the caller needs `allow-external-apps=true` in `~/.termux/termux.properties`, and the user must grant the RUN_COMMAND permission in App Info. The app never requests it (`MainActivity.kt:134-142`), and `termux-setup.sh` never sets the property (grep). So automatic bridge launch works only after undocumented manual setup (U).
- **H:** RUN_COMMAND is started without a working directory, and `index.ts:58` falls back to `process.cwd()`. The Claude project root may therefore be the Termux home directory, not a project.

### F3 — High (S) — SSH never verifies the server's host key
- `SshSessionManager.kt:188` uses `PromiscuousVerifier()`, and password authentication happens at `:203`.
- An attacker on the network path can impersonate the host, collect the password, and read and inject the whole session.
- With the README's recommended `--dangerously-skip-permissions` (`README.md:140`), that becomes command execution on the dev host.

### F4 — High (S + D) — Credentials stored in plaintext app storage, eligible for device-to-device transfer, partly logged
- **Storage:** the SSH password, private-key PEM, OpenAI key and Google key are plain Preferences DataStore strings (`SessionStore.kt:23-31, 122-156`). DataStore lives under `filesDir` (the `file` backup domain).
- **Backup config:** `allowBackup="true"`, with `fullBackupContent` including only `sharedpref` (`AndroidManifest.xml:14-15`, `backup_rules.xml:3`). No `dataExtractionRules`; `targetSdk 35` (`build.gradle.kts:14`).
- **D (Android 12 behavior changes):** for apps targeting Android 12+, `fullBackupContent` include/exclude rules do not affect device-to-device transfer.
- **D (Auto Backup):** an `<include>` limits cloud backup to the included files.
- **Net (inferred from the two pages):** the DataStore file is excluded from cloud backup but eligible for device-to-device transfer. Whether a transfer actually carries it is U.
- **Logging and forwarding:** the OpenAI key prefix is logged (`MainViewModel.kt:392`). Keys also travel to the bridge in the `config` message (`MainViewModel.kt:1186-1198` → `ws-server.ts:304-310`).

### F5 — High (S + D; runtime U) — Bridge stream-json parser does not match the documented event schema
- **What the bridge expects:** text in a top-level `content`, a string `message`, `text`, or `delta.text` (`claude-cli.ts:300-340`). It handles top-level `tool_use`/`tool_result` types (`:235-255`) and ignores the text of `result` (`:269-275`).
- **What the docs say (D: Claude Code "Run programmatically" and Agent SDK "Stream responses"):**
  - An assistant message wraps a nested message object (read as `message.message.id`), and each carries one content block (text or `tool_use`).
  - Tool calls are content blocks, not top-level message types.
  - The stream ends with a `result` message holding the final text.
- **Consequence (H):** with documented output, `extractText` returns null for assistant messages and `executing` is never reported. Bridge mode would likely deliver only stderr and error events to the phone.
- **D:** the docs' streaming example passes `--verbose`; the bridge does not (`claude-cli.ts:96`). The docs do not say `--verbose` is mandatory, so whether the installed CLI rejects the combination is U.
- The repo has no captured fixture that could settle this.

### F6 — High (S) — In SSH mode speech goes to whatever holds the terminal; after auto-reconnect that is a bare shell
- **No foreground awareness:** `sendLine(text)` writes the transcript to the terminal without knowing which process is in the foreground (`MainViewModel.kt:1281`).
- **Reconnect path:** an internal reconnect opens a new shell (`SshSessionManager.kt:272-279` → `doConnect` `:211-214`). `SshOutputProcessor.reset()` is only called from `connectSsh` (`MainViewModel.kt:1038`), so `initialized` stays true (`SshOutputProcessor.kt:93-101`) and auto-launch (`MainViewModel.kt:1063-1091`) never runs again.
- **Design mismatch:** the design says reconnect should reset and re-launch (`docs/plans/2026-03-02-ssh-auto-launch-design.md:32`).
- **Consequence:** the next utterance runs as a shell command line. The old CLI presumably died with its terminal (SIGHUP, U).
- **Related:** `cd <dir> && <cmd>` is built from settings without quoting (`:1081-1085`).

### F7 — Medium-High (S) — Blind voice approvals, and the cancel keyword swallows prompts
- **Blind mapping:** exact `네/예/응/yes/허용/승인/allow` → `"y\n"`; `아니/아니오/no/거부/deny` → `"n\n"`; `확인/엔터/enter/실행` → `"\n"` (`VoiceCommandRouter.kt:16-19, 29-36`). Nothing ties the answer to a specific pending prompt.
- **What the user hears:** a fixed translation that drops the command or file being approved (`MainViewModel.kt:772-788`; "Do you want to proceed" → "계속 진행할까?").
- **Cancel prefix match:** cancel uses `normalized.startsWith("$it ")` (`VoiceCommandRouter.kt:26`). So "취소 버튼 추가해줘" or "stop the server" sends Ctrl+C instead of the prompt: the request is lost and running work is interrupted. Tests cover single words only (`VoiceCommandRouterTest.kt:10-49`).
- **Enter mismatch:** special keys are sent with `\n` via `sendInput` (`MainViewModel.kt:1279`). Normal lines deliberately send `\r` separately, for terminal-UI apps (`SshSessionManager.kt:144-150`). Whether Claude Code's approval prompt accepts `y\n` or `\n` is U.

### F8 — Medium (S + D) — Bridge lifecycle: no stop, no queue, fragile resume, dead restart logic
- **No stop:** the protocol has only `user_input` and `config` (`protocol.ts:13-19`, `ws-server.ts:290-301`).
- **No queue:** a message sent while busy is rejected, and the rejection is spoken as an error (`claude-cli.ts:89-92`).
- **Fragile resume:** the `--continue` fallback (`:103-108`) can attach to an unrelated session. D: `--continue` loads "the most recent conversation in the current directory", and `-p --continue` includes `-p`/SDK sessions.
- **Stop signal:** `kill()` sends SIGTERM (`:185-192`). D: SIGTERM leaves the turn unfinished and records no result; SIGINT ends the turn.
- **Dead restart logic:** the `restart` and `exit` handlers (`ws-server.ts:363-370`) never fire, because the only emit sites are `error`, `output` and `status` (`claude-cli.ts:85-345`). `autoRestart`, `maxRestarts`, `restartDelay`, `idleTimeout` and `tmuxSession` are unused (`claude-cli.ts:26-45`, `index.ts:171-174`).

### F9 — Medium (S) — Engine choices are UI-only, and the OpenAI key field silently turns on uploading terminal text
- **TTS:** always falls back to Android TTS (`VoiceEngineManager.kt:98-109`, a TODO).
- **STT:** the selected engine is stored (`:66`) but never read, so the Whisper options do nothing.
- **Bridge endpoints:** `/api/tts` and `/api/stt` have no Android caller (grep).
- **Kokoro:** loads model files by relative path (`kokoro-tts.ts:49`) that setup never downloads (`termux-setup.sh:130-133`).
- **Google key:** setup writes `GOOGLE_TTS_API_KEY` to `bridge/.env` (`:144`), but nothing loads `.env` (grep: no dotenv or env-file; `google-tts.ts:26` reads `process.env`).
- **OpenAI key consent mismatch:** the "OpenAI API Key" field appears under STT → "OpenAI Whisper" (`SettingsDialog.kt:745-777`). In practice it turns on sending up to 1,200 chars of terminal content per response to `gpt-4o-mini` (`MainViewModel.kt:391-406`). Users enabling Whisper are not told their code and transcript context goes to OpenAI.

### F10 — Medium (S; rates U) — The speech pipeline breaks the "never read raw output" rule in places
- **Bridge:** raw stderr and error text are spoken at HIGH priority (`claude-cli.ts:138-147` → `MainViewModel.kt:1356-1358`). INFO output reads out the first line of the answer (`ContextCompressor.kt:256-264`).
- **SSH:** speech sees only the visible screen (`TerminalEmulator.kt:85-91`; no scrollback), as of the last chunk before 1.5 s of quiet (`MainViewModel.kt:291-297`). Anything that scrolls off first is never classified.
- The error and question regexes fire on incidental text (`MainViewModel.kt:347-351`).

### F11 — Medium (H) — Writing to a dead SSH channel can crash the app
- `os.write` runs inside `scope.launch(Dispatchers.IO)` with no try/catch (`SshSessionManager.kt:128-131, 143-151`). The surrounding `try` cannot catch exceptions thrown in the child coroutine, and the scope is `viewModelScope` (`MainViewModel.kt:72`).
- An `IOException` on a half-open link would go uncaught, which Android's default handler turns into an app crash (U).
- `resizePTY` does catch inside its coroutine (`:164-170`), so the fix pattern already exists in the same file.

### F12 — Medium (H + D) — Background behavior probably fails the screen-off use case
- **Foreground-service churn:** the foreground service starts on every CONNECTED and stops on every DISCONNECTED (`MainViewModel.kt:868-881`).
- **D:** apps targeting Android 12+ get `ForegroundServiceStartNotAllowedException` when they start a foreground service from the background, unless an exemption applies. A drop while backgrounded → stop → auto-reconnect → start would hit this (H). Whether an exemption such as "battery optimization off" applies is U.
- **Microphone:** the service type is `specialUse` (`AndroidManifest.xml:34-37`). D: on Android 14+, a foreground service that needs the microphone must declare that type and be created while an activity is visible. Passive barge-in listening while backgrounded is therefore U, and probably blocked.

### F13 — Low-Medium (S; npm registry state U) — Setup, supply chain and packaging
- **npm name mismatch:** `README.md:146` says `npm install -g voicecode`, but the package is named `voicecode-bridge` (`bridge/package.json:2`). The README command would install whatever the public `voicecode` package is (not checked).
- **Unpinned setup:** `curl | bash` from mutable `main`, plus `git pull` updates (`termux-setup.sh:3, 67-72`).
- **License conflict:** "Private repository" (`README.md:152`) vs MIT (`bridge/package.json:38`).
- **Platform (D, Claude Code setup):** the documented OS list is macOS, Windows, Ubuntu, Debian and Alpine, and npm platforms are glibc/musl Linux. Android/Termux is not listed, yet setup installs Claude Code via npm (`termux-setup.sh:59`). Whether it runs is U.
- **Packaging:** the APK is `versionCode 1` with no signing config (`build.gradle.kts:15-16, 19-27`). The bridge version is displayed but never checked for compatibility (`MainViewModel.kt:1329`). Android tests run only by Gradle convention (`CLAUDE.md:36-37`); none were executed here.

### F14 — Low (S) — Maintainability debt (mention only; no cleanup authorized)
- **Oversized ViewModel:** `MainViewModel.kt` (1,436 lines) mixes SSH classification, Korean templates, PCM drone synthesis, auto-connect and settings plumbing.
- **Settings callback:** a 15-argument callback is threaded through three files (`MainActivity.kt:97-118`, `MainScreen.kt:99-104`, `SettingsDialog.kt:70-74`).
- **Wasted work:** SSH output is run through `ContextCompressor` (`SshOutputProcessor.kt:152`) and the result is discarded (`MainViewModel.kt:262-266`).
- **Dead code (grep: no callers or collectors):** `TtsPriorityQueue`, `CompressionPrompts`, `OutputParser`/`isCliNoise`, `CodePreview`, `fetchBridgeStatus`, `sendControlC`/`sendEnter`, the ViewModel's `connect`/`disconnect`/`updateEngineSettings`, and `statusMessage`.
- **Doc drift:** the benchmark report calls `TtsPriorityQueue` the live queue (`docs/reports/2026-05-12-realtimevoicechat-benchmark.md:90`); the live queue is in `TtsManager.kt:33`. `CLAUDE.md` describes Bridge mode only.
- **Tests:** none for the ViewModel pipeline, compressor/classifier, SSH session, terminal emulator or bridge. No CI.
- **H:** the progress-drone start/stop flag can let an old synthesis loop survive a quick restart (`MainViewModel.kt:591-595, 677, 714-718`).

### Keep (verified strengths)
- `BargeInController` is injectable and unit-tested with 6 cases (`BargeInControllerTest.kt`).
- `TtsManager`'s HIGH-flush/FIFO behavior.
- `TerminalEmulator`: a VT100 subset that is adequate for display.
- SSH keepalive and backoff.
- The bridge spawns `claude` with an argument array, so there is no shell interpolation (`claude-cli.ts:112`).
- Loopback-only bind.
- No transcript persistence.
- `ws` 8.19.0.

## 6. Reuse for mobile aigentry loop control, and where the trust boundary goes

No loop implementation or remote identity contract is approved. #1151's ingress validation found no stable delivery identity that binds event source, target thread and prompt bytes (`docs/reports/2026-09-11-task-loop-ingress-validation.md`, Result). This section is design input only.

| Component | Reuse? | Condition |
|---|---|---|
| `TtsManager` + `BargeInController` | Yes | as-is; route alerts by priority |
| `ContextCompressor.optimizeForTts` + Korean templates | Yes, for **fixed-schema** status events | templates beat LLM summaries for structured input; never raw text |
| `SshSessionManager` transport, keepalive, backoff | Yes | after F3 (host-key pinning) and F11; use a one-shot command channel (SSH exec), not a terminal, for verbs |
| `SshForegroundService` | Partly | fix the F12 start/stop churn |
| `SpeechManager` | Yes | add a headset-button trigger (currently absent) |
| Bridge `claude -p --resume <id>` spawn pattern | Pattern only | rewrite the parser to the documented schema (F5); resume by id, never `--continue`; stop with SIGINT (D) |
| `VoiceCommandRouter` y/n/Enter mapping | **No** | blind approvals (F7) cannot carry authority |
| Bridge WebSocket protocol / `TermuxLauncher` | **No** | unauthenticated (F1); runs code from shared storage (F2) |

**Minimum trusted boundary for any state-changing command (proposal):**
1. **Identity is the device key, not the voice.** Use a dedicated SSH key held non-exportably in Android Keystore, and require the device credential or biometrics before any write verb. Recognized speech, a session token, or a text claiming to be "human" never counts as authorization.
2. **Authorization lives on the server.**
   - D (OpenSSH `sshd(8)`, AUTHORIZED_KEYS): `command="…"` runs a fixed command and ignores the client's; the client's original command is exposed as `SSH_ORIGINAL_COMMAND`. `restrict` disables terminal allocation and forwarding.
   - A read-only key maps to a status command. A separate key maps to a verb allowlist that validates `SSH_ORIGINAL_COMMAND`.
3. **Every write carries** a request id, a target session id and a payload hash, and is audited in the #1151 contract's format.
4. **Scoped confirmation.** Speak back the exact target and payload, then require a confirmation phrase that names the verb ("멈춰 확인"). Misrecognized or ambiguous speech → ask again, never guess. Destructive or irreversible operations stay desk-only.
5. **Remote-started turns never use bypass mode.** Use plan or dontAsk modes with allowlists (D: permission modes), and only pre-registered projects. D: a `-p` session without `--bare` runs the project's hooks and MCP servers with no trust dialog.

## 7. Brainstorm — what this app could enable

Everything below is a **proposal**. Capability labels:
- **Current** = works in today's source, subject to the findings above.
- **Feasible** = an extension of existing code plus new components.
- **Speculative** = a new product surface.

### 7.1 Idea pool

| # | Idea | Label | One-line take |
|---|---|---|---|
| 1 | Spoken task-loop status on demand | Feasible | read-only; needs a host status feed |
| 2 | Exception alerts: HOLD, STUCK and failures interrupt; success is queued; progress stays silent | Feasible (the priority model is Current) | matches the product rule exactly |
| 3 | Session remote control: status/stop → ask → continue/resume/start | Feasible, gated on #1151 | user-required verbs |
| 4 | Read-only code Q&A on a trusted host | Current over SSH (unsafe defaults) → Feasible safely | low authority, high daily value |
| 5 | Voice task capture → draft intake | Feasible | never auto-dispatched |
| 6 | Approval inbox that reads back the exact command | Feasible, high risk | needs a permission host (D: `--permission-prompt-tool`) |
| 7 | Session handoff between phone and desktop | Feasible | D: `--resume <id>` finds a session in any project on the same machine |
| 8 | Spoken review, release and CI summaries | Feasible | fixed-schema input |
| 9 | Personal voice notes and TODOs (offline) | Feasible | speech-to-text is Current |
| 10 | Hands-busy pair programming over SSH | Current | today's app; carries F3, F6 and F7 |
| 11 | Accessibility: screenless coding for RSI or low-vision users | Partly Current | needs a headset trigger and a TalkBack check |
| 12 | Commute brief of overnight loop results | Feasible after ideas 1–2 | |
| 13 | Voice "run the tests" (an allowlisted command) | Feasible, medium risk | |
| 14 | Switching between sessions by spoken name | Speculative | wrong-target risk |
| 15 | Always-on wake word | Speculative | privacy, battery, background-microphone rules (D) |
| 16 | Watch companion | Speculative / new product | |
| 17 | On-call production triage by voice | Speculative | avoid production authority |

Ranking criteria:
- (a) fit with the screenless intent;
- (b) authority required: read < reversible write < irreversible;
- (c) reuse of existing code;
- (d) dependence on the unapproved #1151 contract;
- (e) blast radius of a misrecognition.

### 7.2 Ranked shortlist

**#1 — Earbud status line + exception alerts** (ideas 1+2) · Feasible · effort **M** (app S–M, host command S)
- *User and context:* the owner is away from the desk with earbuds in and the phone pocketed; the aigentry loop runs on the desktop.
- *Example interaction:*
  - Headset button, "상태" → "진행 3, 대기 2, HOLD 1: vc1152 리뷰 대기."
  - Unprompted interrupt: "HOLD. iv1151 설계 승인 필요."
  - Queued: "vc1150 완료."
  - Progress: silence.
- *Concrete benefit:* task visibility without a screen; exceptions surface quickly. No write authority, so nothing unsafe can happen through it.
- *Reusable code:* `TtsManager` priorities, `BargeInController`, the template summarizer, `SshSessionManager` transport and backoff, `SshForegroundService`.
- *Missing components:*
  - a host-side read-only status command that emits structured events (its source of truth is for the #1151/orchestrator owner to decide; not verified here);
  - host-key pinning (F3) and a Keystore-held dedicated key (F4);
  - a headset-button trigger;
  - event-to-speech templates with dedupe and rate limiting;
  - the F12 fix.
- *Risks:*
  - **Privacy:** task titles are spoken aloud; mitigate with short codes and a check that audio is routed to earbuds.
  - **Authorization:** bounded by a `command=` + `restrict` read-only key (D).
  - **Recognition:** fixed verbs only, and an unknown word → ask again; a misheard word cannot change anything.
- *Why it outranks the rest:* it is the only shortlisted idea that serves the user's visibility goal with zero command authority, so it can ship before #1151 settles identity. It also shakes out the background, headset and host-key problems that every later phase depends on.

**#2 — Session remote control** (idea 3; the user explicitly requires start/continue/resume/stop/status) · Feasible, **blocked on the #1151 contract** · effort **L**
- *Example interaction:*
  - "vc1152 이어서: 테스트 실패 원인만 찾아줘" → readback "vc1152에 '테스트 실패 원인만 찾아줘' 보낼까?" → "보내" + device unlock → later "완료. 원인 1개: 토큰 만료 처리."
  - Stop: "멈춰" → "vc1152 멈출까?" → "멈춰 확인" → SIGINT.
- *Concrete benefit:* the verbs the user explicitly asked for; work keeps moving away from the desk.
- *Reusable code:* the spawn and resume-by-id pattern (`claude-cli.ts:96-121, 216-219`) after the F5 fix; stop via SIGINT (D); the transport from #1.
- *Missing components:* the approved remote identity/command contract; request ids, idempotency and audit; a registry mapping spoken session names to ids; a permission-mode policy for remotely started turns; the confirmation UX.
- *Risks:*
  - a misheard prompt (readback reduces this but does not remove it);
  - the wrong session (never use `--continue`, D);
  - hooks from an untrusted repo running under `-p` (D) → pre-registered projects only;
  - voice is not identity → device credential for start and resume.
- *Why it ranks second:* it is required, but it needs authority. Within the phase, go status → stop → ask (#3) → continue/resume → start.

**#3 — Read-only code Q&A** (idea 4) · Current over SSH today (with unsafe defaults), Feasible safely · effort **M**
- *Example interaction:* "auth 토큰 검증 어디서 해?" → "auth 서비스 validateToken, 42번째 줄 근처."
- *Concrete benefit:* answers about the codebase without a screen, at low risk.
- *Reusable code:* `optimizeForTts` path shortening; the one-sentence summarizer pattern (`TtsSummarizer.kt`).
- *Missing components:* a host command that runs Claude in a read-only permission mode (D: `plan`, or `dontAsk` + read-only rules); a cap on answer length.
- *Risks:* low authority; code content is spoken aloud; prompt injection from repo content is limited by read-only tools.
- *Why it ranks third:* the highest everyday value at low risk, but it still needs the prompt channel from #2, where it is the first verb that cannot write.

**#4 — Voice task capture → draft intake** (idea 5) · Feasible · effort **S–M**
- *Example interaction:* "새 태스크: API 키를 Keystore로" → "초안 저장: 'API 키 Keystore 이전'. 등록은 데스크톱 승인 후."
- *Concrete benefit:* ideas captured the moment they come up, without dispatching anything.
- *Reusable code:* speech-to-text, spoken readback.
- *Missing components:* a draft inbox whose entries cannot be dispatched; dedupe; intake rules owned by the #1151 queue owner.
- *Risks:* misheard text (read back, editable at the desk); duplicates.
- *Why it ranks fourth:* safe, but less urgent than visibility and control.

**#5 — Approval inbox that reads back the exact command** (idea 6) · Feasible, **highest risk** · effort **L**
- *Example interaction:* alert "승인 요청 1건: vc1152, Bash 'npm test -- auth'." → "자세히" → the exact arguments are read out → "승인" + biometrics → the decision is sent bound to the request id; a timeout means deny.
- *Concrete benefit:* unattended runs keep moving without the owner at the desk.
- *Reusable code:* the HIGH-priority interrupt path only. The current y/n router is explicitly **not** reusable (F7).
- *Missing components:* a permission host (D: `--permission-prompt-tool` MCP or the SDK's `canUseTool`; `--permission-prompts none` for unattended runs); request-id binding; a speakable rendering of exact arguments; device credential; audit; a list of tools that can never be approved remotely.
- *Risks:* approving the wrong request; commands that cannot be spoken faithfully; social engineering through crafted command text.
- *Why it ranks fifth despite the leverage:* it has the largest authorization surface. It should come only after #2's audit trail works.

### 7.3 Recommendation
- **MVP:** #1 — a read-only status line plus exception alerts, over a verified SSH key restricted to one forced command, triggered from the headset.
- **Later phases:**
  - P2a: status, stop, and ask (read-only mode).
  - P2b: continue, resume and start, under the approved #1151 contract.
  - P3: draft intake, spoken review/release summaries, session handoff.
  - P4: approval inbox.
- **Avoid:**
  - voice "네" as approval (today's behavior);
  - speaker or voice biometrics as identity;
  - exposing the Bridge on the LAN or through tunnels;
  - destructive or irreversible operations by voice (push, force, deploy, delete, secrets);
  - reading full diffs or logs aloud;
  - production on-call authority.
- **Defer:**
  - an always-on wake word (privacy, battery, background-microphone rules — D);
  - switching sessions by spoken name (a misrecognition picks the wrong target; needs readback disambiguation);
  - Bridge-side Kokoro/Google/Whisper playback (not wired; adds keys and Python);
  - on-device Whisper or Silero voice detection (the benchmark report also defers these).
- **Preserved requirements:** phone/remote start and resume stay in scope (P2b); spoken output stays minimal; task visibility is the MVP itself.

## 8. Fix priorities (proposals; no code changed)

**Immediate (safety):**
- **F1 + F2:** disable Bridge auto-launch and the `/sdcard` update hook until a per-launch token and Origin rejection exist — or retire Bridge mode (decision needed, below).
- **F3:** pin the host key on first use (TOFU), reading back the fingerprint.
- **F7:** exact-match cancel; `\r` for Enter; no y/n unless an approval prompt is detected, and then with readback.
- **F4:** drop key and transcript logging; add `dataExtractionRules`.
- **F6:** re-initialize on internal reconnect, or block voice-to-shell until the CLI is detected.
- **F11:** catch write failures.

**Deferable:**
- F5 (only if the Bridge is kept);
- F9's missing headset trigger (a prerequisite for the MVP);
- F10 speech rules and scrollback capture;
- F12 foreground-service lifecycle;
- F13 docs, setup and license;
- F14 dead code and splitting the ViewModel.

**Unnecessary rewrites:**
- a new terminal emulator (add scrollback capture instead);
- replacing SSHJ;
- a framework migration;
- a Python voice server (the benchmark already rejects it);
- expanding the Bridge TTS engines.

**Open decision for the orchestrator:** keep Bridge (phone-local) mode, or retire it in favor of SSH? **Recommendation: retire or disable it until it is authenticated.**
- README already recommends SSH (`README.md:56`).
- Recent work landed on the Android/SSH side.
- The Bridge carries F1, F2 and F5.

## 9. Next bounded task proposals (drafts — not registered)

| # | Role | Size | Scope |
|---|---|---|---|
| N1 | coder | S | SSH host-key pinning (TOFU + fingerprint readback, hard fail on mismatch) + unit test |
| N2 | architect → coder | S | Bridge keep/retire decision; if kept: per-launch token, Origin rejection, remove CORS `*`, delete the `/sdcard` hook |
| N3 | coder | S | `VoiceCommandRouter`: exact match, `\r`, y/n bound to a detected prompt; tests including the "취소 버튼…" case |
| N4 | coder | S→M | remove secret and transcript logs; add `dataExtractionRules`; then Keystore-encrypted credentials |
| N5 | coder | S | SSH reconnect re-init or voice gating; try/catch around writes; document a `tmux new -A` startup wrapper |
| N6 | analyst (device) | M | measure the §10 items with captured fixtures; no fixes |
| N7 | architect | S | voice-client verb and confirmation contract — only after the #1151 identity contract is approved |
| N8 | coder | M | MVP: headset trigger + read-only status line over a restricted one-command key (after N1, N4 and a host status command) |
| N9 | docs | S | align README and `CLAUDE.md` (modes, engines, npm name, license) |

## 10. Unmeasured runtime (explicit)

- The actual stream-json lines from the installed Claude CLI vs `extractText`, and whether `--verbose` is required (F5).
- Whether other apps or browser pages on the phone can reach the Bridge's loopback port (F1).
- Whether Termux's RUN_COMMAND works without the manual `allow-external-apps` setting and permission grant; the launched bridge's working directory (F2).
- Whether Claude Code runs on Termux at all (F13).
- Whether Claude Code's approval prompt accepts `y\n` / `\n` from the router (F7).
- What happens to the CLI when SSH drops (SIGHUP), and what the user hears afterwards (F6).
- Foreground-service restart from the background, microphone access while backgrounded, and the effect of the missing POST_NOTIFICATIONS request (F12).
- A crash when writing to a half-open SSH channel (F11).
- The speech-recognition provider's data path (on-device vs cloud); Korean recognition accuracy; barge-in echo with the phone speaker vs earbuds.
- False-positive rates of the error/question regexes; speech latency; battery.
- Whether device-to-device transfer actually carries the DataStore file (F4).

## 11. Self-review

- Every S claim cites a committed line that was re-read.
- D claims cite official pages fetched on 2026-09-11:
  - code.claude.com: `cli-reference`, `headless`, `setup`, `agent-sdk/streaming-output`;
  - the Termux wiki page "RUN_COMMAND Intent";
  - developer.android.com: foreground-service background-start restrictions, Auto Backup, Android 12 behavior changes;
  - man.openbsd.org `sshd(8)`.
- One earlier assumption was dropped after the doc check: "`--verbose` is mandatory for stream-json" is not stated in the docs, so it is recorded as U, not as a defect.
- No finding claims an exploit, and none was attempted.
- This is a source review, not a security scan or clearance. Snyk: N/A (documentation-only output).
- Nothing here authorizes integration with the task loop.
