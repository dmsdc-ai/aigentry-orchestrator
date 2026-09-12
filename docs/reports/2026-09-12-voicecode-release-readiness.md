# Voice Code Installation, Distribution and Release Readiness Report (#1157)

**Document ID:** `docs/reports/2026-09-12-voicecode-release-readiness.md`  
**Task:** #1157 (Voice Code installation and distribution prerequisites)  
**Role:** `rv1157-researcher` (Speaker key: `agy`)  
**Deliberation Session:** `release-1151-1161-1157-20260912` (User-selected speakers: claude #1151, codex #1161, agy #1157)  
**Date:** 2026-09-12  
**Target Worktree:** `/Users/duckyoungkim/.aigentry/worktrees/rv1157`  
**Branch:** `docs/1157-release-readiness`  
**Base Commit:** `6b34ccb322daa13595f4a829c6f373a29680d90b` (`docs(tasks): record release objective and recover voice summary report`)  
**Main Currentness:** `70c7aa475a78b6c264564b9471f9b4f62cb1c097` (`docs(tasks): bind production review wave and advisor-on loop-opt-in defaults`)  
**Source Repository:** `/Users/duckyoungkim/projects/voicecode` (Read-Only) @ `5d98d60d8b48b7eb170115a2492ddf5e0433106c` (`main`), dirty state `.omc/state/subagent-tracking.json` (D) and `.claude/` (??) untouched and unopened  
**Preserved Specs in Scope:** `docs/specs/2026-09-11-voicecode-core-contract.md`, `voicecode-design-contract.md`, `voicecode-summary-slice.md`  
**Epistemological Labels:**
- **[S]** Source evidence: directly measured from `/Users/duckyoungkim/projects/voicecode` at commit `5d98d60`
- **[D]** Official documentation: primary sources from Android developer docs, Anthropic, Node.js, Termux wiki
- **[M]** Public registry / remote metadata: live queries to npm registry and GitHub API as of 2026-09-12 16:15 KST
- **[P]** Proposal: recommended engineering architecture, schema, or slice boundary
- **[U]** Unmeasured behavior: empirical gap requiring isolated verification fixture

---

## 1. Executive Assessment & Production Readiness Verdict

### 1.1 Release Readiness Verdict: NOT READY FOR PRODUCTION
Voice Code is **not ready for a production release**. The existing codebase (`projects/voicecode` @ `5d98d60`) represents an early-stage desktop-and-mobile prototype with severe architectural, security, lifecycle, and packaging deficiencies:
1. **Packaging & Signing Deficit [S, M]:** The Android application (`com.voicecode.app`) has `versionCode 1`, `versionName "0.1.0"` with **no release signing configuration** in `build.gradle.kts`. The host bridge is unpackaged on the public npm registry (`voicecode-bridge` is 404/unclaimed; `voicecode` is registered by an unrelated third party; `@dmsdc-ai/voicecode-bridge` is 404). There is no automated build/test/release CI workflow (`.github` is completely absent in the repository).
2. **Security Vulnerabilities (CVE-Grade) [S]:**
   - Insecure remote script execution in `TermuxLauncher.kt:93-98`: automatically copies and runs `/sdcard/voicecode-bridge-update.js` into the bridge directory. Any application on the device with shared storage write access can execute arbitrary code within Termux under the user's terminal privileges.
   - Unauthenticated WebSocket and REST API: `ws-server.ts:81-84` accepts any connecting client without authentication; `/api/tts` and `/api/stt` are unauthenticated; `ws-server.ts:304-320` allows any connected client to overwrite provider API keys via a `config` message.
   - Promiscuous SSH: `SshSessionManager.kt:188` uses `PromiscuousVerifier()` with no host key validation.
   - Plaintext credential leakage: API keys and spoken session transcripts are logged to Android logcat in `MainViewModel.kt`, `TtsManager.kt`, `BridgeClient.kt`, and `SessionStore.kt`.
3. **The "No-Required-PC" Claim is Unproved and Inoperable [S, D, M]:** The proposal that Voice Code runs purely on-phone via Termux without requiring a PC cannot be sustained today. Official Claude Code CLI (`@anthropic-ai/claude-code`) requires Node.js >= 22 and packages precompiled native binaries for GNU libc (`linux-arm64`) and musl libc (`linux-arm64-musl`). Android Termux uses Google Bionic libc (`libc.so` and `/system/bin/linker64`). Running `@anthropic-ai/claude-code` directly in standard Termux fails on binary execution. In addition, Termux `RUN_COMMAND` intent requires manual configuration (`allow-external-apps=true`), and Android 12+ Phantom Process Killer aggressively terminates background child processes exceeding 32 or high CPU/memory. A PC host running macOS/Linux/Windows over SSH is the only verified, operable platform today.
4. **Android 14+ Foreground Service & Bluetooth Audio Breakdown [S, D]:** `AndroidManifest.xml` targets SDK 35 but declares `foregroundServiceType="specialUse"` without `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, or `BLUETOOTH_CONNECT`. On Android 14+ (Galaxy Z Fold7 runs Android 14/15 One UI 6/7), starting background audio recording or playback under these permissions throws a `SecurityException`. Audio lifecycle is owned by `MainViewModel`, so activity recreation (fold/unfold) or backgrounding destroys the session. Bluetooth communication routing (`setCommunicationDevice`) to Galaxy Buds2 Pro is completely absent.
5. **Fidelity and Summary Seam Unwired [S]:** The pure Kotlin summary component specified in `docs/specs/2026-09-11-voicecode-summary-slice.md` (`SpokenSummaryComposer.kt`) is completely absent in the source tree. Today's bridge ignores `result` events and CLI exit codes; the Android app relies on regex scraping and billed `gpt-4o-mini` summarization. Spoken agent question readback with two-digit challenge response is entirely unimplemented.
6. **Task Advisor / Task Loop Alignment [P]:** Voice Code must operate strictly as a thin bidirectional voice remote. It is not an autonomous agent or scheduler. The latest binding requirement mandates **Task Advisor ON / Task Loop OFF** by default. Voice Code must enforce that Advisor recommendations or worker reports received over voice never activate the Task Loop, and casual voice confirmations ("네", "좋아") never trigger execution.

---

## 2. Source & Public Inventory Remeasurement

### 2.1 Android Application (`/Users/duckyoungkim/projects/voicecode/android`)
- **Package & Versions [S: `app/build.gradle.kts:8-17`]:**
  - `namespace`: `"com.voicecode.app"`
  - `applicationId`: `"com.voicecode.app"`
  - `compileSdk`: `35`
  - `minSdk`: `26` (Android 8.0)
  - `targetSdk`: `35` (Android 15)
  - `versionCode`: `1`
  - `versionName`: `"0.1.0"`
- **Build System & Toolchain [S: `gradle/libs.versions.toml:1-13`]:**
  - Gradle Build Tool: Wrapper `8.9` (`gradle/wrapper/gradle-wrapper.properties`)
  - Android Gradle Plugin (AGP): `8.7.3`
  - Kotlin: `2.0.21` (Compose Compiler plugin integrated)
  - Jetpack Compose BOM: `2024.12.01`
  - Core KTX: `1.15.0`, Lifecycle: `2.8.7`, Activity Compose: `1.9.3`
  - Network / Serialization: OkHttp `4.12.0`, Gson `2.11.0`
  - SSH Client: `com.hierynomus:sshj:0.38.0`
  - Target JVM: `JavaVersion.VERSION_17` / jvmTarget `"17"`
- **Release Signing Configuration [S: `app/build.gradle.kts:19-27`]:**
  ```kotlin
  buildTypes {
      release {
          isMinifyEnabled = true
          proguardFiles(
              getDefaultProguardFile("proguard-android-optimize.txt"),
              "proguard-rules.pro"
          )
      }
  }
  ```
  **Finding:** No `signingConfigs` block exists in `build.gradle.kts`. Executing `./gradlew assembleRelease` outputs an unsigned APK (`app-release-unsigned.apk`) which cannot be installed on a non-rooted Android device without manual signing.
- **Manifest & Permissions Audit [S: `app/src/main/AndroidManifest.xml:5-37`]:**
  - Declared permissions:
    - `android.permission.INTERNET`
    - `android.permission.RECORD_AUDIO`
    - `android.permission.FOREGROUND_SERVICE`
    - `android.permission.FOREGROUND_SERVICE_SPECIAL_USE`
    - `android.permission.WAKE_LOCK`
    - `com.termux.permission.RUN_COMMAND`
  - **Critical Deficiencies [D: developer.android.com/about/versions/14/changes]:**
    - Missing `android.permission.POST_NOTIFICATIONS` (API 33+): Mandatory for foreground service notification display; without runtime grant, notifications are blocked.
    - Missing `android.permission.FOREGROUND_SERVICE_MICROPHONE` (API 34+): Mandatory when accessing microphone from a foreground service.
    - Missing `android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK` (API 34+): Mandatory for audio playback in background.
    - Missing `android.permission.BLUETOOTH_CONNECT` (API 31+): Mandatory for Bluetooth device enumeration, query, and routing via `AudioManager.setCommunicationDevice` for Galaxy Buds2 Pro.
    - Service declaration: `SshForegroundService` specifies `foregroundServiceType="specialUse"`. Google Play and Android 14+ enforce that `specialUse` cannot substitute for `microphone` or `mediaPlayback`. Under targetSdk 35, recording audio without `FOREGROUND_SERVICE_MICROPHONE` throws `SecurityException`.
- **ProGuard / R8 Rules [S: `app/proguard-rules.pro:1-24`]:**
  - Preserves OkHttp, Gson, and SSHJ classes.
  - Missing keep rules for Kotlin reflection, data classes used in serialization, or future models introduced for `SummaryFacts` or event protocols.

### 2.2 Host Bridge (`/Users/duckyoungkim/projects/voicecode/bridge`)
- **Package Manifest [S: `bridge/package.json:1-40`]:**
  - `"name"`: `"voicecode-bridge"`
  - `"version"`: `"0.1.0"`
  - `"type"`: `"module"` (ESM)
  - `"bin"`: `{ "voicecode": "dist/index.js" }`
  - `"main"`: `"dist/index.js"`
  - `"engines"`: `{ "node": ">=18.0.0" }`
  - `"license"`: `"MIT"`
  - Runtime dependencies: `ws: ^8.18.0`, `chalk: ^5.4.1`, `qrcode-terminal: ^0.12.0`
  - Dev dependencies: `typescript: ^5.7.3`, `@types/ws: ^8.5.14`, `@types/node: ^22.12.0`, `tsup: ^8.3.6`
- **Build Configuration [S: `bridge/tsup.config.ts:1-11`]:**
  - Bundles `src/index.ts` to `dist/index.js` as single ESM file.
  - Adds banner: `#!/usr/bin/env node`.
- **Packaging Flaws [S, M]:**
  - Missing `"files": ["dist"]` in `package.json`. Running `npm pack` includes `src/`, config files, and tests.
  - Missing `"prepublishOnly": "npm run build"` or `"prepack": "npm run build"`. Publishing without manual build can publish stale or empty `dist/`.
  - Public name clash: `voicecode-bridge` is currently unregistered (HTTP 404 on `registry.npmjs.org/voicecode-bridge`). However, `voicecode` is taken by an unrelated package ("Shared terminal for mobile and desktop browsers", v1.0.1). Scoped name `@dmsdc-ai/voicecode-bridge` is unregistered (HTTP 404).
- **Security & Protocol Gaps [S: `bridge/src/ws-server.ts:74-250, 304-340`]:**
  - `handleHttpRequest` sets `Access-Control-Allow-Origin: *`.
  - REST endpoints `/api/tts`, `/api/stt`, and `/api/voice/status` accept unauthenticated POST requests from any local process or web page.
  - `handleConnection` accepts any WebSocket client with no authentication token, no challenge-response handshake, and no client public key verification.
  - `handleConfigMessage` allows any client to dynamically overwrite Google TTS and OpenAI Whisper API keys in memory.
  - `handleUserInput` launches Claude CLI with `--dangerously-skip-permissions` if configured, enabling unauthenticated remote command execution.

### 2.3 Scripts & Termux Integration (`/Users/duckyoungkim/projects/voicecode/scripts`)
- **`termux-setup.sh` [S: lines 1-187]:**
  - Downloads via `curl | bash` from `main` branch without hash verification or commit pinning.
  - Clones entire repo `https://github.com/dmsdc-ai/voicecode.git` to `~/.voicecode`.
  - Installs `@anthropic-ai/claude-code` via npm (`npm install -g @anthropic-ai/claude-code`).
  - Lacks setup for `allow-external-apps=true` in `~/.termux/termux.properties`.
- **`TermuxLauncher.kt` [S: lines 83-102]:**
  - Line 88 executes: `kill $(lsof -t -i:$port) 2>/dev/null` (kills whatever process is using port 8765).
  - Line 93-98 checks: `UPDATE="/sdcard/voicecode-bridge-update.js"`; if present, copies it directly to `$HOME/.voicecode/bridge/dist/index.js` and executes it. This is an insecure code injection vulnerability.
  - Line 70 logs complete command lines to logcat.

### 2.4 GitHub Repository & Pipeline Status
- **Remote Origin [S]:** `https://github.com/dmsdc-ai/voicecode.git`
- **Public Accessibility [M: `curl -I https://github.com/dmsdc-ai/voicecode`]:** Returns `HTTP/2 404 Not Found`. Repository is either private or has not been created under `dmsdc-ai`.
- **GitHub Releases [M: `api.github.com/repos/dmsdc-ai/voicecode/releases`]:** Returns `404 Not Found`. No releases, release assets, or tags exist.
- **Tracked CI/CD [S]:** `git ls-files .github` is empty. Directory `.github/` does not exist. No GitHub Actions workflows exist for linting, testing, building APKs, or publishing npm packages.

---

## 3. Concrete Installation, Distribution, Update & Rollback Flows

```
+--------------------------------------------------------------------------------------------------+
|                                    DISTRIBUTION ARCHITECTURE                                     |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   [Android Client: Galaxy Z Fold7]                     [Host Environment: PC / Mac / Linux]      |
|   +---------------------------------------+            +-------------------------------------+   |
|   |  GitHub Releases (dmsdc-ai/voicecode) |            |  npm Registry (@dmsdc-ai)           |   |
|   |  - voicecode-v0.2.0.apk (Signed)      |            |  - @dmsdc-ai/voicecode-bridge@0.2.0 |   |
|   |  - SHA-256 Checksums                  |            |  - Pre-bundled dist/index.js        |   |
|   +-------------------+-------------------+            +------------------+------------------+   |
|                       |                                                   |                      |
|                       v                                                   v                      |
|   +---------------------------------------+            +-------------------------------------+   |
|   |  Local Android OS Package Manager     |            |  Node.js Global / npx Runtime       |   |
|   |  - Keystore signature verification    |            |  - npm install -g @dmsdc-ai/...     |   |
|   |  - Monotonic versionCode upgrade      |            |  - Pinned Node >= 18 (22 for Claude)|   |
|   +-------------------+-------------------+            +------------------+------------------+   |
|                       |                                                   |                      |
|                       v                                                   v                      |
|   +---------------------------------------+  Authenticated WebSocket   +---------------------+   |
|   |  com.voicecode.app (Voice Service)    |<==========================>|  voicecode-bridge   |   |
|   |  - Android Keystore client key        |  (SSH-Forwarded or LAN)   |  - Host state file  |   |
|   |  - SshForegroundService (Owner)       |                           |  - Single writer    |   |
|   +---------------------------------------+                           +---------------------+   |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### 3.1 Android APK Release Pipeline
1. **Keystore Generation & Management [P]:**
   - A dedicated release keystore (`voicecode-release.jks`) must be generated using RSA 4096 or EC P-256.
   - Keystore secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`) must be stored in GitHub Repository Secrets, never in version control.
   - Local builds fallback to debug signing (`debug.keystore`).
2. **Gradle Configuration Update (`android/app/build.gradle.kts`) [P]:**
   ```kotlin
   val releaseKeystoreFile = file(System.getenv("KEYSTORE_PATH") ?: "release.jks")
   signingConfigs {
       create("release") {
           if (releaseKeystoreFile.exists()) {
               storeFile = releaseKeystoreFile
               storePassword = System.getenv("KEYSTORE_PASSWORD")
               keyAlias = System.getenv("KEY_ALIAS")
               keyPassword = System.getenv("KEY_PASSWORD")
           }
       }
   }
   buildTypes {
       release {
           isMinifyEnabled = true
           signingConfig = signingConfigs.getByName(if (releaseKeystoreFile.exists()) "release" else "debug")
           proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
       }
   }
   ```
3. **Artifact Verification Gate [P]:**
   - Build step: `./gradlew assembleRelease`
   - Verification command: `apksigner verify --verbose --print-certs app/build/outputs/apk/release/app-release.apk`
   - Assert: Signed with Scheme v2/v3, certificate SHA-256 matches official release fingerprint.
4. **Distribution via GitHub Releases [P]:**
   - Tag convention: `vX.Y.Z` (e.g., `v0.2.0`).
   - Assets published: `voicecode-v0.2.0.apk`, `voicecode-v0.2.0.apk.sha256`.
   - Direct download and install via Android Package Installer. (Google Play Store listing is not assumed or required).
5. **Update & Migration Flow [P]:**
   - `versionCode` must increment strictly monotonically (`1` -> `2` -> `3`).
   - Android OS allows in-place package update if and only if the signing certificate matches the installed package.
   - DataStore preferences (`session_store`) and Android Keystore keys survive standard updates.
6. **Rollback & Downgrade Constraints [D, P]:**
   - Android OS strictly rejects package downgrades (`INSTALL_FAILED_VERSION_DOWNGRADE`).
   - If a rollback is needed:
     - Preferred Path: Issue a forward patch release (e.g., `v0.2.1` with code reverted to `v0.1.0` but `versionCode 3`).
     - Hard Rollback: User uninstalls current APK and installs older APK via ADB or APK installer.
     - **Warning on Hard Rollback:** Uninstall wipes the app sandbox, deleting DataStore preferences and Keystore key pairs. All paired host trust, session grants, and client sequence numbers are permanently deleted, requiring fresh setup and pairing.

### 3.2 Host Bridge npm Packaging & Distribution
1. **Package Scoping & Naming [P]:**
   - Name must be scoped under the official organization: `@dmsdc-ai/voicecode-bridge`.
   - This prevents name-squatting, distinguishes from the unrelated third-party `voicecode` package, and aligns with `@dmsdc-ai/aigentry-orchestrator`.
2. **Package Hygiene & Manifest Specification (`bridge/package.json`) [P]:**
   ```json
   {
     "name": "@dmsdc-ai/voicecode-bridge",
     "version": "0.2.0",
     "type": "module",
     "bin": {
       "voicecode": "dist/index.js"
     },
     "main": "dist/index.js",
     "files": [
       "dist",
       "README.md",
       "LICENSE"
     ],
     "scripts": {
       "build": "tsup",
       "prepack": "npm run build",
       "prepublishOnly": "npm run test && npm run build",
       "test": "node --test test/"
     },
     "publishConfig": {
       "access": "public"
     }
   }
   ```
3. **Installation & Setup Flow [P]:**
   - Installation on PC / Host:
     ```bash
     npm install -g @dmsdc-ai/voicecode-bridge
     ```
   - Interactive Host Setup:
     ```bash
     voicecode setup --project /path/to/project
     ```
     - Generates loopback listener on port 8765.
     - Displays terminal QR code / connection URI (`ws://127.0.0.1:8765` or SSH tunnel instructions).
     - Prompts user to pair phone via screen-on QR scan.
   - Host profiles file: Initialized at `~/.voicecode/profiles.json` with strict permissions (`0600`).
4. **Uninstall Flow [P]:**
   - Command: `npm uninstall -g @dmsdc-ai/voicecode-bridge`
   - State purge: `rm -rf ~/.voicecode` (removes pairing state, host state, and profiles).
5. **Protocol & Version Compatibility Handshake [P]:**
   - During WebSocket handshake, server sends `welcome` frame:
     `{"type": "welcome", "host_version": "0.2.0", "v_min": 1, "v_max": 1, "caps": [...]}`
   - If mobile app cannot negotiate a compatible protocol version (`v`), it closes with code `4426` (Version Mismatch) and displays/speaks: "호스트 버전이 호환되지 않습니다. 업데이트가 필요합니다."

---

## 4. Standalone Phone (Termux) vs PC Host: Analysis of the "No-Required-PC" Claim

### 4.1 The Technical Reality of Phone-Only Execution
The premise that Voice Code operates as a self-contained mobile environment without requiring a PC relies on running both the Node bridge and the AI CLI (Claude Code) inside Android Termux. Remeasurement of official primary sources reveals five fatal blockers:

| # | Barrier | Source / Official Evidence | Technical Impact on Phone-Only |
|---|---|---|---|
| 1 | **Bionic vs GNU Libc Mismatch** | [S: `termux-setup.sh:59`] [D: `@anthropic-ai/claude-code` npm manifest] | `@anthropic-ai/claude-code` ships precompiled native binaries for `linux-arm64` (glibc) and `linux-arm64-musl`. Termux on Android uses Bionic libc (`/system/bin/linker64`). Executing glibc ELF binaries on Android results in `cannot execute: no such file or directory` or dynamic linker crash. Native Claude CLI cannot run in bare Termux. |
| 2 | **Node.js Runtime Version Requirement** | [M: npm view `@anthropic-ai/claude-code` engines] | Claude Code requires `node: ">=22.0.0"`. While Termux `pkg` currently tracks Node 22 on some mirrors, package availability fluctuates, and legacy Termux setups on older Android versions are restricted to Node 18 or 20. |
| 3 | **Android Phantom Process Killer (PPK)** | [D: AOSP Android 12+ changes] [U] | In Android 12 through 15 (Galaxy Z Fold7), Android OS limits phantom/child processes spawned by a non-root background app (such as Termux) to a maximum of 32 total processes. A single Claude CLI execution spawning subshells, git commands, and build tools quickly triggers PPK, silently killing the Termux daemon. |
| 4 | **Undocumented Manual Termux Permissions** | [S: `TermuxLauncher.kt:57-76`] [D: Termux RUN_COMMAND Wiki] | The `RUN_COMMAND` intent requires: (a) explicit toggle `allow-external-apps=true` inside `~/.termux/termux.properties`, and (b) user manually navigating to Android Settings > Apps > VoiceCode > Permissions > Additional Permissions and granting `Run commands in Termux environment`. Voice Code cannot grant this automatically; out-of-the-box launch fails silently. |
| 5 | **Thermal Throttling & Battery Drain** | [D: Samsung Fold7 Hardware Specs] [U] | Sustained compilation, git tree walks, and local model inference on mobile ARM SoC generate intense heat, triggering aggressive thermal throttling and rapid battery drain (exceeding 25%/hr). |

### 4.2 Release Decision on Host Architecture
1. **The "No-Required-PC" Claim CANNOT Be Made in Release Artifacts:** Stating that Voice Code is a "phone-only product requiring no PC" is factually unproven and technically broken for standard users today.
2. **Tiered Architecture Definition:**
   - **Tier 1 (Supported Production Baseline): Optional/Own PC Host.** The Node bridge runs on the user's workstation (macOS, Linux, Windows), executing Claude Code, Codex, or orchestrator tools natively. The Galaxy Z Fold7 connects via SSH port forwarding (`sshj` over LAN or Wi-Fi/Tailscale). This is the only stable, productionized path.
   - **Tier 2 (Experimental / Community Path): Termux with `proot-distro`.** For users demanding a phone-only setup, Claude Code must run inside a `proot-distro` glibc container (e.g., Ubuntu ARM64) with disabled Phantom Process Killer via ADB. This must be classified as an experimental developer option with clear manual setup instructions, not the default consumer release flow.

---

## 5. Galaxy Z Fold7 & Galaxy Buds2 Pro Screen-Off Voice Loop Architecture

```
+--------------------------------------------------------------------------------------------------+
|                                SCREEN-OFF BACKGROUND VOICE LOOP                                  |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   Galaxy Buds2 Pro                        SshForegroundService (Owned)          Audio / Ledger   |
|   +---------------+                       +--------------------------+          +------------+   |
|   | Earbud Touch  | -- Media Button ----> | MediaSessionCompat       | -------> | Ledger     |   |
|   | / Voice Input |                       | (FLAG_HANDLES_MEDIA_BTNS)|          | (16 items) |   |
|   +-------+-------+                       +------------+-------------+          +-----+------+   |
|           ^                                            |                              |          |
|           | Audio Route                                v                              v          |
|           | (SCO / CommDevice)            +--------------------------+          +------------+   |
|           +------------------------------ | SpeechManager / Recognizer| <------- | Reply      |   |
|           |                               | (setCommunicationDevice) |          | Window (6s)|   |
|           v                               +------------+-------------+          +------------+   |
|   +---------------+                                    |                              ^          |
|   | Earbud Output | <---- Audio Stream --------------- v                              |          |
|   | (Spoken TTS)  |                       +--------------------------+                |          |
|   +---------------+                       | TtsManager (Focus/Attrs) | ---------------+          |
|                                           | (USAGE_ASSISTANCE_NAV)   |                           |
|                                           +--------------------------+                           |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### 5.1 Hardware Context & Requirements
- **Device:** Samsung Galaxy Z Fold7 (Dual-screen foldable: 6.3" outer compact <600dp, 7.6" inner expanded >=840dp; One UI 6/7 on Android 14/15).
- **Audio Device:** Samsung Galaxy Buds2 Pro (Bluetooth LE Audio / Classic Bluetooth Hands-Free Profile; 24-bit Hi-Fi codec; capacitive touch sensors).
- **Core Requirement:** True screen-free operation. The user must be able to conduct full coding dialogue (hearing agent question readbacks, answering two-digit challenges, approving/denying file edits, receiving concise task completions) while the phone remains folded, locked, and in pocket.

### 5.2 Required Architectural Refactoring

#### 1. Foreground Service Ownership (Fix for Fact F-h) [S, P]
- **Current Defect:** `SshForegroundService.kt` is a detached stub holding only a wake lock and returning `START_STICKY`. `MainViewModel.kt:1414-1435` destroys `BridgeClient`, `SshSessionManager`, `SpeechManager`, and `TtsManager` on `onCleared()`, and cancels listening/speaking in `onPause()`.
- **Production Refactoring:**
  - `SshForegroundService` becomes the **exclusive runtime owner** of:
    1. Network transports: `BridgeClient` (WebSocket) and `SshSessionManager` (SSH tunnel).
    2. Voice engines: `SpeechManager` (STT), `TtsManager` (TTS), and `BargeInController`.
    3. State & Ledger: `SpeechLedger` (authoritative question tracking) and session grant crypto.
  - Service lifecycle is decoupled from Activity. `MainActivity` and `MainViewModel` bind to the service via `ServiceConnection` when the UI is visible.
  - Fold/unfold activity recreation only rebinds to the running service; audio playback and microphone capture proceed uninterrupted without glitch or restart.
  - Manifest update:
    ```xml
    <service
        android:name=".service.VoiceRemoteService"
        android:foregroundServiceType="microphone|mediaPlayback"
        android:exported="false" />
    ```

#### 2. Bluetooth SCO & Communication Device Routing (Galaxy Buds2 Pro) [D, P]
- **Current Defect:** `SpeechManager.kt:112` instantiates `SpeechRecognizer.createSpeechRecognizer(context)` with default audio source. Audio route to Buds2 Pro is unmanaged; audio drops or defaults to device speakerphone.
- **Production Refactoring:**
  - Android 13+ (API 33+) Bluetooth routing API:
    ```kotlin
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val btDevice = audioManager.availableCommunicationDevices.find {
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
    }
    if (btDevice != null) {
        audioManager.setCommunicationDevice(btDevice)
    }
    ```
  - BroadcastReceiver monitors `AudioManager.ACTION_COMMUNICATION_DEVICE_CHANGED` and Bluetooth headset state. If Galaxy Buds2 Pro disconnects or is returned to case, playback is immediately paused; audio is **never** routed to the phone speaker without explicit user consent.

#### 3. Screen-Locked Activation & Touch Control (MediaSession) [D, P]
- **Current Defect:** Starting recording requires tapping the screen FAB (`VoiceButton.kt:89`). With the screen locked, the user has no way to initiate a prompt.
- **Production Refactoring:**
  - Instantiate `MediaSessionCompat` in the service with `FLAG_HANDLES_MEDIA_BUTTONS` and `FLAG_HANDLES_TRANSPORT_CONTROLS`.
  - Handle Galaxy Buds2 Pro capacitive tap events:
    - **Single Tap / Double Tap:** Triggers `SpeechManager.startListening()` while screen is off.
    - **Long Press / Tap during speech:** Triggers immediate barge-in (`TtsManager.stop()`) and opens listen window.
  - **Automatic Reply Window:** After any spoken agent question or result, the service opens a 6-second active listening window signaled by a subtle earcon. If user speaks within 6 seconds, audio is captured without touching the earbud.

#### 4. Removal of Cold-Start Terminal View Coupling (Fix for Fact F-k) [S, P]
- **Current Defect:** `MainViewModel.kt:1029-1034` halts SSH connection in `pendingSshConnect` until `TerminalView.kt:140-143` composes and calculates pixel dimensions (`resizeTerminal`). On screen-locked cold start, the terminal never composes, and Voice Code hangs permanently.
- **Production Refactoring:** Remove `pendingSshConnect`. Initialize PTY with standard default terminal geometry (80x24). Connecting the WebSocket bridge over SSH port forwarding requires no PTY at all.

---

## 6. Provider API & Subscription Capability Matrix

```
+--------------------------------------------------------------------------------------------------+
|                              PROVIDER CAPABILITY & AUTH MATRIX                                   |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   Provider        Connector             Structured Channel   Questions / Approvals  Auth Modes   |
|   --------------  --------------------  -------------------  ---------------------  -----------  |
|   Claude Code     claude -p             stream-json          Yes (--permission-     Subscription |
|                   (Anthropic)                                prompt-tool) [P]       / API Key    |
|                                                                                                  |
|   Codex           codex app-server      JSON-RPC / events    Yes (structured        Subscription |
|                   (OpenAI)                                   approval events) [P]   / API Key    |
|                                                                                                  |
|   Codex Exec      codex exec --json     JSON stdout          No (Batch exec only;   API Key      |
|                   (Fallback)                                 no question channel)                |
|                                                                                                  |
|   Gemini CLI      gemini -p             stream-json          No documented question API Key      |
|                   (Google)                                   channel (U)                         |
|                                                                                                  |
|   OpenCode        opencode run          JSON events          No documented question API Key      |
|                   (Multi-model)                              channel (U)                         |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### 6.1 Capability Matrix & Verification Status

| Provider / Product | CLI / Connector Executable | Structured Stream Channel | Interactive Question Channel | Session Resume Capability | Auth Verification [P] |
|---|---|---|---|---|---|
| **Claude Code (Anthropic)** | `claude -p --output-format stream-json` [S, D] | Fully structured stream-json (messages, tool_use, tool_result) | Supported via `--permission-prompt-tool` (MCP tool prompt) [D, U] | Supported via `--resume <id>` [D] | Verified via `claude whoami` / env scrub |
| **Codex (OpenAI App-Server)** | `codex app-server` [D, U] | Bidirectional JSON-RPC stream | Structured approval requests emitted as JSON-RPC notifications | Supported via thread/session ID resume | Verified via app-server session handshake |
| **Codex Exec (Fallback)** | `codex exec --json` [D] | JSON events output | **None** (Non-interactive batch mode; approvals not supported) | Supported via `codex exec resume <id>` | API Key only |
| **Gemini CLI (Google)** | `gemini --output-format stream-json` [D] | JSON events (`init`, `chunk`, `result`) | **None documented** (Questions not exposed via stream-json) | Unknown / unmeasured | API Key only |
| **OpenCode / Grok** | `opencode run --format json` [D] | JSON event stream | **None documented** | Supported via `--session <id>` | API Key only |

### 6.2 Binding Human Requirements on Billing & Credentials
1. **Zero Billed Fallback [P]:**
   - Profiles must strictly declare `auth_declared: "subscription"` or `auth_declared: "api_key"`.
   - When running a `subscription` profile, the bridge **must scrub all ambient API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) from the child process environment before spawn.
   - If a subscription login is invalid or expired, the turn **must be refused and spoken** as "구독 인증 실패, 세션 중단". The bridge must **never** silently fall back to a billed API key.
2. **Provider Terms of Service Gate (Blocker B1) [D]:**
   - Programmatic CLI driving under consumer subscriptions is subject to provider terms (Anthropic Support Article 15036540 vs SDK Terms).
   - Subscription profiles must remain an explicit user opt-in, disabled by default until terms are corroborated for each provider.

---

## 7. Faithful Summaries & Spoken Fidelity Integration

### 7.1 Architecture of the Pure Summary Seam
The highest-priority feature of Voice Code is **faithful concise spoken agent questions and results**. The user must never be misled into believing an action succeeded, tests passed, or a deployment completed when it did not.

```
+--------------------------------------------------------------------------------------------------+
|                                    FAITHFUL FIDELITY PIPELINE                                    |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   Machine Events Stream (Bridge)                     SpokenSummaryComposer (Pure Kotlin)         |
|   +------------------------------------+             +--------------------------------------+    |
|   | - Turn exit code / status          |             | Inputs: SummaryFacts                 |    |
|   | - Tool use / observed tool exits   | ----------> | - Deterministic segment sorting      |    |
|   | - Project file diff / scope checks |             | - Exit 0 = "턴 완료" (never "성공")    |    |
|   | - Attributed agent claim & quote   |             | - Strict quote suppression rules     |    |
|   +------------------------------------+             +------------------+-------------------+    |
|                                                                         |                        |
|                                                                         v                        |
|   Spoken Single Utterance                            SpokenSummary (Text & Attribution)          |
|   +------------------------------------+             +--------------------------------------+    |
|   | "턴 완료. 관측된 실패: 테스트 1건. | <---------- | - Ordered SpokenSegments             |    |
|   |  에이전트 보고: 성공, 관측과 다름"  |             | - Detail notice flag (자세히)        |    |
|   +------------------------------------+             +--------------------------------------+    |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### 7.2 Current Defect vs Target Implementation
- **Current Defect [S: `MainViewModel.kt:1296-1358`]:** The bridge ignores `result` events and CLI exit codes. `MainViewModel` parses free-form terminal strings with regexes (`OutputClassifier.kt`), cuts file paths with `optimizeForTts`, and uses a paid `gpt-4o-mini` API call (`TtsSummarizer.kt`) to generate summaries.
- **Specification Source:** Preserved spec `docs/specs/2026-09-11-voicecode-summary-slice.md` defines the total pure Kotlin component:
  - Component: `com.voicecode.app.engine.SpokenSummaryComposer`
  - Input: `SummaryFacts` (machine-observable events with explicit provenance `src`).
  - Output: `SpokenSummary` (strictly ordered `SpokenSegment` list).
- **Core Fidelity Invariants [docs/specs/2026-09-11-voicecode-summary-slice.md:187-196]:**
  1. **Exit 0 is never "성공":** Process completion is rendered as `"턴 완료"`. Success is only attributed to the agent (`"에이전트 보고: 성공"`).
  2. **Contradiction Detection:** If the agent claims success but any observed tool exit failed (e.g., `npm test` exited 1), the composer forces the suffix: `"에이전트 보고: 성공, 관측과 다름."`.
  3. **No Observed Event:** If the agent claims tests passed but no test execution tool was observed in the stream, the composer renders: `"테스트 통과 보고, 관측 없음."`.
  4. **Strict Quote Suppression:** The assistant's prose quote is completely suppressed if:
     - The turn did not complete cleanly.
     - There are open pending questions.
     - Any observed check failed.
     - Files were modified outside the project.
     - Prose contains reserved composer labels (preventing spoofing).
     - Prose exceeds 160 code points.
     - User requested short summaries (`SHORT_PREFERENCE`).

### 7.3 Mandatory Integration Steps for Summary Slice
1. **Coder Step:** Implement pure Kotlin file `android/app/src/main/java/com/voicecode/app/engine/SpokenSummaryComposer.kt` exactly adhering to §3–§4 of the summary spec. Sole external import: `java.text.Normalizer`.
2. **Tester Step:** Implement unit test `android/app/src/test/java/com/voicecode/app/engine/SpokenSummaryComposerTest.kt` implementing all 15 counterexample fixtures (FX1 through FX15).
3. **Adapter Step:** Bridge `claude-cli.ts` emits structured `summary_facts` message payload parsed from stream-json tool events and exit codes.
4. **TTS Wiring Step:** `VoiceEngineManager.kt` speaks `spokenSummary.text` as a single utterance at `TtsPriority.NORMAL`.

---

## 8. Ecosystem Binding: Task Advisor (#1161) & Task Loop (#1151) Interaction

### 8.1 Binding Default Rules
The binding human requirement establishes the operational hierarchy between the three products:
- **Task Advisor (#1161):** Active by default (**Advisor ON**). Generates independent, task-bound proposals and next-step recommendations.
- **Task Loop (#1151):** Inactive by default (**Loop OFF**). Executes approved eligible tasks autonomously. Requires explicit human activation.
- **Voice Code (#1157):** A thin bidirectional voice remote. It is **neither** an agent nor a scheduler.

### 8.2 Voice Remote Boundary Invariants
1. **Advisor Proposals are Non-Authorizing [P]:** When Task Advisor generates a proposal and it is spoken over Voice Code (e.g., "새로운 리팩토링 작업을 제안합니다"), hearing this proposal or acknowledging it does **not** authorize execution, spend budget, or activate the Task Loop.
2. **Spoken Ambiguity Gate [P]:** Casual, ambiguous, or conversational voice replies ("응", "그래", "좋아", background speech, noise) must **never** activate the Task Loop.
3. **Loop Activation Authority [P]:** Activating the Task Loop via voice requires:
   - Screen-on review or explicit two-digit challenge response under an active, scoped session grant (`grant_id`).
   - The command must explicitly specify loop duration and maximum execution budget.
4. **Worker REPORT Isolation [P]:** Background worker reports (`REPORT: ...`) streamed to Voice Code are strictly informational notifications. They must never trigger autonomous follow-on execution or loop activation.

### 8.3 Lifecycle State Transition Matrix

```
+--------------------------------------------------------------------------------------------------+
|                                ECOSYSTEM LIFECYCLE MATRIX                                        |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   Event / Scenario        Advisor State   Task Loop State  Voice Remote Authority / Action       |
|   ----------------------  --------------  ---------------  ----------------------------------    |
|   1. Fresh Install        ON (Default)    OFF (Default)    Pairing key created; no loop grant    |
|                                                                                                  |
|   2. Upgrade / Update     Preserved       Preserved        Disabled modes stay disabled;         |
|                           (No reset)      (No reset)       no silent re-activation              |
|                                                                                                  |
|   3. User Disables        OFF             OFF              "어드바이저 꺼" -> spoken confirm;   |
|      Advisor                                               proposals muted                       |
|                                                                                                  |
|   4. Explicit Loop        Independent     ON (Explicit)    Signed grant + 2-digit challenge;     |
|      Activation                           (Time/task bound)explicit budget bounds                |
|                                                                                                  |
|   5. Host / Phone         Recovered       Fenced / Valid   Recover valid grants; sessions fenced |
|      Restart                              Lease Check      until reconciliation; no auto-loop    |
|                                                                                                  |
|   6. Revocation           Independent     Immediately      "권한 해제" -> instant local stop;   |
|      ("권한 해제")                        HALTED           remote revoke frame; zero execution   |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

1. **Initial Install:** Fresh setup of Voice Code and bridge initializes with Advisor ON / Loop OFF.
2. **Upgrade / Migration:** Upgrading either the APK or the bridge package reads existing configuration; if the user previously disabled Advisor or left Loop OFF, updates **must not** silently turn them back on.
3. **User-Disabled Advisor:** User can speak "어드바이저 비활성화" or toggle in settings. Advisor proposals cease, but Voice Code continues serving as a remote for active agent sessions.
4. **Explicit Loop Activation:** When user explicitly commands "루프 시작, 예산 3개", Voice Code speaks the readback with challenge "작업 루프 활성화 삼십팔". Upon valid voice response, Voice Code transmits signed `loop_activate` frame.
5. **Restart Recovery:** If host or phone restarts, an active grant is recovered from `host-state.json` only if its expiration timestamp is valid. Existing sessions enter `reconciling` (fenced). No new loop execution begins until explicitly re-confirmed.
6. **Revocation:** Speaking "권한 해제" immediately halts all cryptographic signing on the phone, sends `revoke{grant_id}` to the bridge, and aborts any active Task Loop execution.

---

## 9. Security Audit & Remediation Plan (Gates G1–G8)

### 9.1 Vulnerability Catalog (Measured @ 5d98d60)

| Vulnerability ID | Severity | File & Line [S] | Description & Threat Vector |
|---|---|---|---|
| **VULN-01 (CVE-Grade)** | **CRITICAL** | `TermuxLauncher.kt:93-98` | **Remote Code Execution via Shared Storage:** Checks `/sdcard/voicecode-bridge-update.js` and blindly overwrites `dist/index.js`. Any malicious app on the phone can write to shared storage and execute code as Termux user. |
| **VULN-02** | **HIGH** | `ws-server.ts:81-84, 233-240` | **Unauthenticated WebSocket & REST Endpoints:** Accepts any incoming WS connection without auth. `/api/tts` and `/api/stt` allow unauthenticated local processes or malicious websites to invoke voice endpoints. |
| **VULN-03** | **HIGH** | `ws-server.ts:158, 304-320` | **CORS Wildcard & API Key Overwrite:** `Access-Control-Allow-Origin: *`. Any web page opened in mobile browser can connect and overwrite Google TTS / OpenAI Whisper API keys via `config` frame. |
| **VULN-04** | **HIGH** | `SshSessionManager.kt:188` | **Promiscuous SSH Verification:** `PromiscuousVerifier()` accepts any host key, exposing SSH sessions to Man-in-the-Middle (MitM) interception on untrusted networks. |
| **VULN-05** | **MEDIUM** | `VoiceCommandRouter.kt:16-36` | **Blind Command Injection / Insecure Stop:** Router sends raw `0x03` (Ctrl+C) on words like "취소", killing tasks when the user only intended to stop audio playback. Sends `y
` without checking question context. |
| **VULN-06** | **MEDIUM** | `MainViewModel.kt`, `BridgeClient.kt`, `SessionStore.kt` | **Plaintext Credential & Transcript Logging:** Sensitive API keys and full conversation transcripts are printed directly to Android logcat via `Log.d` / `Log.i`. |

### 9.2 Security Gates Implementation Specification

- **Gate G1 (Bridge Authentication & CORS Lockdown) [P]:**
  - Reject all connections with an `Origin` header (HTTP 4403).
  - Require ECDSA P-256 challenge-response signature in `hello` frame. Unauthenticated clients are rejected with code 4401.
  - Delete or restrict `/api/*` REST endpoints to localhost-authenticated tokens only.
- **Gate G2 (Elimination of Insecure Shared-Storage Update Hook) [P]:**
  - Delete lines 93–98 in `TermuxLauncher.kt`. Remove all checks for `/sdcard/voicecode-bridge-update.js`.
  - Remove `kill $(lsof -t -i:$port)`. Bridge process management must rely on PID files and graceful termination.
- **Gate G3 (Strict SSH Host Key Pinning) [P]:**
  - Replace `PromiscuousVerifier` with `OpenSSHKnownHosts` verifier or pinned public key SHA-256 fingerprint.
  - Reject host key changes with hard connection failure. Speak fingerprint confirmation on initial pairing.
- **Gate G4 (Voice Router & Stop Word Isolation) [P]:**
  - Spoken words "멈춰", "그만", "stop" **only** halt TTS playback (`TtsManager.stop()`). They must never send SIGINT (Ctrl+C) to active agent tasks.
  - Cancelling a task requires explicit readback: "작업 취소" -> "태스크 12번을 취소할까요? 칠십이" -> "취소 칠십이".
- **Gate G5 (Bare-Shell Reconnect Protection) [P]:**
  - SSH reconnection must verify agent CLI state before accepting voice input. If SSH lands in a bare bash/zsh shell, voice routing is blocked until agent CLI is confirmed.
- **Gate G6 (Zero-Secret Logcat Sanitization) [P]:**
  - Strip all credential strings, API key prefixes, and spoken transcripts from logcat statements across the codebase.
- **Gate G7 (Question Ledger Survival) [P]:**
  - Question state survives network drops, audio errors, and playback interruptions in `SpeechLedger`. Entries are only closed upon verified provider closure.
- **Gate G8 (Cryptographic Replay & Atomic Admission) [P]:**
  - Every command frame carries monotonic `client_seq`, payload hash `h`, and Android Keystore signature.
  - Host admission write (`host-state.json`) atomically commits sequence number, decision slot, and grant use before forwarding to agent CLI.

---

## 10. Discrete File-Separated Follow-Up Tasks & Acceptance Gates

```
+--------------------------------------------------------------------------------------------------+
|                                    IMPLEMENTATION SLICE MAP                                      |
+--------------------------------------------------------------------------------------------------+
|                                                                                                  |
|   [P0: Packaging & CI]         [S0: Security Elimination]         [S1: FGS Audio Lifecycle]      |
|   - GitHub Actions CI/CD       - Remove /sdcard update hook       - SshForegroundService owner   |
|   - build.gradle.kts signing   - ws-server auth & 4401            - Android 14+ FGS permissions  |
|   - bridge package.json        - SSH host key pinning             - Decouple terminal cold-start |
|                                                                                                  |
|   [S2: Protocol v1 & Grant]    [S3: Pure Summary Slice]           [S4: Buds2 Pro Screen-Off]     |
|   - ECDSA P-256 Keystore       - SpokenSummaryComposer.kt         - Bluetooth SCO routing        |
|   - host-state.json atomic     - SpokenSummaryComposerTest        - MediaSessionCompat buttons   |
|   - Decision slots & dedup     - FX1-FX15 counterexamples         - 6s reply window & barge-in   |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

### 10.1 File-Separated Slices

| Slice ID | Target Files Owned (Coder) | Dependency for Review | Builder Responsibility | Tester Responsibility & Gates |
|---|---|---|---|---|
| **P0: Release & Packaging Infra** | `.github/workflows/release.yml`, `android/app/build.gradle.kts`, `bridge/package.json` | None | Verify `./gradlew assembleRelease` signed with dummy keystore; verify `npm pack` in `bridge/` | Verify `apksigner verify --print-certs`; verify tarball contents contain only `dist/` |
| **S0: Security Elimination** | `android/.../termux/TermuxLauncher.kt`, `android/.../ssh/SshSessionManager.kt`, `bridge/src/ws-server.ts`, `bridge/src/index.ts` | None | Build both Android debug and bridge ESM | **Gates G1–G6:** Assert 4401 on unauth WS, assert no `/sdcard` read, assert host key verification |
| **S1: Foreground Service & Audio Lifecycle** | `android/.../ssh/SshForegroundService.kt`, `android/app/src/main/AndroidManifest.xml`, `android/.../viewmodel/MainViewModel.kt`, `android/.../MainActivity.kt` | None | Device install build | **Gate V1, V2, V9:** Fold/unfold keeps audio running; cold-start connects without terminal view; screen locked 30m |
| **S2: Protocol v1 & Keystore Grants** | `bridge/src/protocol.ts`, `bridge/src/ws-server.ts`, `android/.../network/Protocol.kt`, `android/.../session/SessionStore.kt`, `android/.../network/BridgeClient.kt` | None | Both builds | **Gate G8, CX1–CX5:** Keystore signed frames, atomic host state write, decision slot deduplication, retry bounds |
| **S3: Faithful Spoken Summary** | `android/.../engine/SpokenSummaryComposer.kt`, `android/.../test/engine/SpokenSummaryComposerTest.kt` | None | `./gradlew :app:compileDebugKotlin` | **Gate FX1–FX15:** All 15 counterexample fixtures pass 100%; zero contradicting success claims |
| **S4: Galaxy Buds2 Pro Screen-Off Audio** | `android/.../voice/SpeechManager.kt`, `android/.../voice/TtsManager.kt`, `android/.../voice/BargeInController.kt`, `android/.../service/MediaSessionManager.kt` | None | Device install build | **Gates V3, V4, V7:** Bluetooth SCO communication device routing, MediaSession earbud tap, barge-in silence |
| **S5: Structured CLI Adapters** | `bridge/src/claude-cli.ts`, `bridge/src/types/summary.ts`, `bridge/src/adapters/claude-stream-parser.ts` | `@modelcontextprotocol/sdk` or Claude Agent SDK | `npm run build` | Fixture replay of Claude stream-json turns; env scrubbing; auth reporting |

---

## 11. Unresolved Human Decisions (Explicit Human Gates)

The following three material questions require explicit user intent and must **not** be chosen autonomously:

### Decision C1: Host Placement & Platform Scope
- **Option A (Recommended): Own PC Host over SSH / LAN.** The bridge runs on macOS/Linux/Windows PC; phone acts purely as voice remote via SSH port forwarding. Operable today.
- **Option B: Standalone Phone-Only via Termux proot-distro.** Requires extensive user documentation, `proot-distro` glibc container installation, ADB phantom process killer disabling, and manual RUN_COMMAND permission grant.
- **Impact:** Independent packaging and security work (Slices P0, S0, S1, S2, S3, S4) is **not blocked** by this decision. Only Slice S5/Termux packaging depends on C1.

### Decision C2: Session Grant Scope, Duration, and Limits
- **Scope Options:**
  - Conservative (Recommended): Read-only tool inspection, project-scoped file edits, and explicit task cancellation. Arbitrary shell execution (`npm test`, build scripts) requires desk approval or verified container sandbox.
  - Broad: Allows command execution inside project root.
- **Duration & Use Bounds:** Recommended default: 2 hours expiration, max 20 authority actions per grant.
- **Impact:** Grant schema is fully specified; coder can implement the engine while the user selects the default policy.

### Decision C3: External Cloud Audio Processing Consent
- **Options:**
  - On-Device Only (Default): Android platform SpeechRecognizer (on-device package) and Android local TTS. Zero audio leaves the phone.
  - External Cloud Audio Allowed: Enables cloud recognition/TTS (e.g., Google Cloud Speech, OpenAI Whisper API, remote vLLM/Qwen3).
- **Impact:** Until user provides explicit consent, Voice Code defaults strictly to On-Device audio.

---

## 12. Traceability & Measurement Verification Matrix

| Claim / Item | Measurement / Evidence Source | Currentness & Hash |
|---|---|---|
| Target Worktree Base Commit | `git rev-parse HEAD` on `docs/1157-release-readiness` | `6b34ccb322daa13595f4a829c6f373a29680d90b` (2026-09-12) |
| Local Main Commit | `git rev-parse main` on worktree | `70c7aa475a78b6c264564b9471f9b4f62cb1c097` (2026-09-12 16:13 KST) |
| Source Repository Commit | `git rev-parse HEAD` on `projects/voicecode` | `5d98d60d8b48b7eb170115a2492ddf5e0433106c` (2026-09-12) |
| Source Dirty State | `git status --short` on `projects/voicecode` | ` D .omc/state/subagent-tracking.json`, `?? .claude/` (Preserved, unopened) |
| Android Manifest & Version | `app/build.gradle.kts:8-17` | `com.voicecode.app`, `versionCode 1`, `versionName "0.1.0"`, `targetSdk 35` |
| npm Package Registry Status | `https://registry.npmjs.org/voicecode-bridge` | HTTP 404 Not Found (Queried 2026-09-12 16:14 KST) |
| Public `voicecode` npm Package | `https://registry.npmjs.org/voicecode` | HTTP 200 (Third-party package v1.0.1; unrelated terminal app) |
| GitHub Repository Public Status | `https://github.com/dmsdc-ai/voicecode` | HTTP 404 Not Found (Queried 2026-09-12 16:15 KST) |
| GitHub Actions Workflow Status | `git ls-files .github` on `projects/voicecode` | Empty (No CI/CD workflows tracked) |
| Summary Slice Spec Blob | `docs/specs/2026-09-11-voicecode-summary-slice.md` | Preserved on `docs/1157-release-readiness` (30,899 bytes) |
| Core Contract Spec Blob | `docs/specs/2026-09-11-voicecode-core-contract.md` | Preserved on `docs/1157-release-readiness` (73,581 bytes) |
