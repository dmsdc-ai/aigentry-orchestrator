# Voice Code Release Readiness Review (#1157) — Bounded Evidence Correction

**Document ID:** `docs/reports/2026-09-12-voicecode-release-readiness.md`  
**Task:** #1157 (Voice Code installation and distribution prerequisites)  
**Role:** `rv1157-researcher` (Speaker key: `agy`)  
**Deliberation Session:** `release-1151-1161-1157-20260912` (claude #1151, codex #1161, agy #1157)  
**Date:** 2026-09-12  
**Target Worktree:** `/Users/duckyoungkim/.aigentry/worktrees/rv1157`  
**Branch:** `docs/1157-release-readiness`  
**Base Commit:** `6b34ccb322daa13595f4a829c6f373a29680d90b` (`docs(tasks): record release objective and recover voice summary report`)  
**Main Currentness:** `70c7aa475a78b6c264564b9471f9b4f62cb1c097` (`docs(tasks): bind production review wave and advisor-on loop-opt-in defaults`)  
**Source Repository:** `/Users/duckyoungkim/projects/voicecode` (Read-Only) @ `5d98d60d8b48b7eb170115a2492ddf5e0433106c` (`main`), dirty state retained: ` D .omc/state/subagent-tracking.json`, `?? .claude/` (untouched and unopened)  
**Preserved Specs in Scope:** `docs/specs/2026-09-11-voicecode-core-contract.md`, `voicecode-design-contract.md`, `voicecode-summary-slice.md`  
**Epistemological Labels:**
- **[S]** Source evidence: directly measured from `/Users/duckyoungkim/projects/voicecode` @ `5d98d60`
- **[D]** Official documentation: primary sources from Android developer docs, Anthropic, Node.js, Termux wiki
- **[M]** Public metadata / remote lookup: HTTP queries to npm registry and GitHub API (2026-09-12 16:15 KST)
- **[P]** Proposal: candidate engineering design or slice boundary for review
- **[U]** Unmeasured behavior: empirical gap requiring isolated verification fixture

---

## 1. Executive Assessment & Production Readiness Verdict

### 1.1 Release Readiness Verdict: NOT READY
Voice Code is **not ready for production release**. The source repository represents an early-stage prototype with release-blocking gaps across packaging, security, background lifecycle, and fidelity:
1. **Packaging & Signing Deficit [S, M]:** Android app (`com.voicecode.app`, `versionCode 1`, `versionName "0.1.0"`) lacks release signing in `build.gradle.kts`. Bridge is unpackaged on public npm (`voicecode-bridge` is 404/unclaimed; `voicecode` is registered by an unrelated third party; `@dmsdc-ai/voicecode-bridge` is 404). No release CI/CD workflow exists (`.github` absent).
2. **Defensive Security Risks [S]:** Insecure `/sdcard` update script execution in `TermuxLauncher.kt:83-101`; unauthenticated WebSocket and REST endpoints (`/api/tts`, `/api/stt`, `config` key replacement) with CORS `*` in `ws-server.ts`; promiscuous SSH host key verification in `SshSessionManager.kt:188`; plaintext credentials and transcripts in logcat.
3. **Platform Compatibility Inferred, Device Runtime Unmeasured [S, D, M, U]:** Package manifests indicate `@anthropic-ai/claude-code` requires Node >= 22 and packages `linux-arm64` glibc/musl binaries, which conflict with Termux Bionic libc. Android 12+ Phantom Process Killer restricts background child processes. Phone-only vs PC host execution remains an open choice (C1); neither environment's runtime was empirically measured in this review.
4. **Android Lifecycle & Fidelity Gaps [S, D]:** `AndroidManifest.xml` targets SDK 35 with `specialUse` FGS; background audio and Bluetooth routing are unverified on device runtime. Pure summary composer (`SpokenSummaryComposer.kt`) is unwired in source; count-only question reporting is insufficient for end-to-end operation.
5. **Ecosystem Defaults [P]:** Binding requirement mandates **Task Advisor ON / Task Loop OFF**. Disabling Advisor leaves Loop independent. Voice Code is a thin voice remote; Advisor proposals and worker reports never authorize execution or activate Loop.

---

## 2. Source & Public Inventory Remeasurement

### 2.1 Android Application (`projects/voicecode/android`)
- **Manifest & Versions [S: `app/build.gradle.kts:8-17`]:** `applicationId "com.voicecode.app"`, `compileSdk 35`, `minSdk 26`, `targetSdk 35`, `versionCode 1`, `versionName "0.1.0"`.
- **Signing Configuration [S: `app/build.gradle.kts:19-27`]:** Release build type has `isMinifyEnabled = true`, but **no `signingConfigs` block**.
  - *Correction:* A release build missing signing materials must **fail**; no fallback to debug signing is permitted for release artifacts [P].
- **Permissions & Foreground Service [S: `app/src/main/AndroidManifest.xml:5-37`]:**
  - Declares `INTERNET`, `RECORD_AUDIO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK`, `com.termux.permission.RUN_COMMAND`.
  - *Correction from Docs [D]:* Denial of `POST_NOTIFICATIONS` suppresses notification visibility, but is not a categorical prohibition of FGS execution across all Android versions. Foreground service types (`microphone`, `mediaPlayback`) and background access rules are conditional under Android 14+ documentation (API 34+). Bluetooth permissions (`BLUETOOTH_CONNECT`) and APIs (`setCommunicationDevice`) are conditional per API level; runtime behavior on this user's device was not measured [U].

### 2.2 Host Bridge (`projects/voicecode/bridge`)
- **Manifest [S: `bridge/package.json:1-40`]:** `"name": "voicecode-bridge"`, `"version": "0.1.0"`, `"type": "module"`, `"bin": {"voicecode": "dist/index.js"}`, `"engines": {"node": ">=18.0.0"}`.
- **Packaging Defects [S, M]:**
  - Missing `"files": ["dist"]` in `package.json`.
  - Public npm registry check (2026-09-12 16:14 KST): `https://registry.npmjs.org/voicecode-bridge` returned 404 (unclaimed in public lookup; does not grant namespace ownership or publication rights). `https://registry.npmjs.org/voicecode` returned 200 (third-party package v1.0.1; unrelated terminal app). `@dmsdc-ai/voicecode-bridge` returned 404 (unregistered; organization rights unverified).
  - *Correction:* Scoped package name and version remain proposals for review, not unilaterally chosen [P]. Routine uninstall must preserve configuration state by default; destructive state purge requires separate authorization.
- **Security Findings [S: `bridge/src/ws-server.ts:74-250, 304-340`]:**
  - `Access-Control-Allow-Origin: *` on HTTP requests.
  - Unauthenticated WebSocket connection handling; unauthenticated `/api/tts`, `/api/stt`, and `/api/voice/status`.
  - `handleConfigMessage` permits dynamic in-memory replacement of TTS/STT API keys.

### 2.3 Scripts & Termux Integration (`projects/voicecode/scripts`)
- **`termux-setup.sh` [S: lines 1-78]:** Downloads via unpinned `curl | bash` from `main`; clones repository to `~/.voicecode`; installs `@anthropic-ai/claude-code` via npm. Does not configure `allow-external-apps=true` in `~/.termux/termux.properties`.
- **`TermuxLauncher.kt` [S: lines 83-101]:** Checks `/sdcard/voicecode-bridge-update.js`; if present, copies to `~/.voicecode/bridge/dist/index.js` and runs it. Executes `kill $(lsof -t -i:$port)` before launch.
  - *Correction:* This is a source-level defensive risk and release blocker to investigate and remediate [P]. It is not claimed to be CVE-graded, and exploitability across application boundaries was not reproduced without storage access verification [U].

### 2.4 GitHub Repository & Pipeline Status
- **Remote Origin [S]:** `https://github.com/dmsdc-ai/voicecode.git`
- **Public Query [M]:** `curl -I https://github.com/dmsdc-ai/voicecode` returned HTTP 404 (inaccessible to unauthenticated public request; does not prove repository, private branches, or tags do not exist).
- **Workflows [S]:** `git ls-files .github` is empty; no CI/CD workflows exist in repository.

---

## 3. Platform Compatibility & Execution Analysis

| Platform / Component | Manifest / Documented Fact | Inferred Technical Implication | Measured Runtime Status |
|---|---|---|---|
| **Claude Code CLI** | `engines = { node: '>=22.0.0' }` [M]; `optionalDependencies` contain `linux-arm64` (glibc) and `linux-arm64-musl` [M] | Termux on Android uses Bionic libc (`/system/bin/linker64`). Incompatibility with glibc binaries is inferred from package metadata. | **Unmeasured [U]**: No CLI execution attempted on device or Termux. |
| **Termux Environment** | `RUN_COMMAND` intent requires `allow-external-apps=true` and manual permission grant [D] | Automatic bridge launch without manual user configuration will fail to execute background command. | **Unmeasured [U]**: Termux intent delivery was not tested. |
| **Android OS Process Limits** | Android 12+ Phantom Process Killer restricts child processes spawned by apps [D] | Background multi-process workloads risk OS termination if process caps are exceeded. | **Unmeasured [U]**: Process longevity not measured on device. |
| **Hardware / OS Profile** | Target devices: Galaxy Z Fold7, Galaxy Buds2 Pro [Preserved Spec Context] | Screen dimensions, fold behavior, and earbud touch mappings must bind to official APIs, not assumed constants. | **Unmeasured [U]**: Device runtime, thermals, and battery consumption were not measured. |

**Platform Scope Conclusion:** The choice between PC host execution and phone-only execution remains an open human decision (C1). The "no-required-PC" claim is unproven and cannot be asserted without verified container/libc support (e.g., proot-distro); PC host runtime over SSH is likewise unmeasured on this user's specific setup.

---

## 4. Android Audio Lifecycle & Fidelity Seam

### 4.1 Audio Ownership & Background Lifecycle
- **Current State [S: `MainViewModel.kt:1414-1435`, `SshForegroundService.kt:35-51`]:** `SshForegroundService` holds a partial wake lock only. Audio engines, SSH manager, and bridge client are owned by `MainViewModel` and destroyed on `onCleared()`.
- **Target State [P]:** Foreground service owns transport connections, audio engines, and the question ledger. UI unbinds on pause without stopping audio. Cold-start connection is decoupled from terminal view composition (Fact F-k fix).
- **Speech Recognition Routing [D, P]:** `createSpeechRecognizer` does **not** guarantee on-device-only processing; recognizer implementation depends on OEM/Google platform configuration. Default local-only consent must be verified; if local processing is unavailable, the system must report explicit unavailable rather than asserting an unverified zero-audio claim.

### 4.2 Spoken Summary Seam
- **Specification Status [Preserved Spec: `2026-09-11-voicecode-summary-slice.md`]:** Pure Kotlin component `SpokenSummaryComposer.kt` with `SummaryFacts` input and deterministic segment sorting (exit 0 = "턴 완료", never "성공"; quote suppression rules).
- **Source State [S: `MainViewModel.kt:1296-1358`]:** Currently unwired in source. Source relies on regexes and billed `gpt-4o-mini` `TtsSummarizer.kt`.
- **Release Gate [P]:** Summary composer alone is count-only and insufficient. Actual question speech/readback, structured bridge adapter, and TTS caller are mandatory before end-to-end completion.

---

## 5. Ecosystem Binding: Task Advisor (#1161) & Task Loop (#1151)

1. **Binding Defaults:** Task Advisor ON / Task Loop OFF.
2. **Independent Controls:** Disabling Task Advisor leaves Task Loop independent under its own authorization; it does **not** force Task Loop OFF [P].
3. **Voice Remote Role:** Voice Code is a thin voice remote, not an agent or scheduler. Spoken Advisor proposals and background worker reports (`REPORT: ...`) are informational and never authorize execution or activate the Task Loop.
4. **Stop & Revocation Invariant:** "권한 해제" or loop stop fences new command admissions; it does **not** abort already-started in-flight work by default [P].
5. **Restart Recovery:** Host/session restart must recover existing valid identity and usage state from durable records without unconditional reconfirmation or inventing new authority [P].
6. **Approval Policy Separation:** Specific challenge formats (e.g., two-digit challenges), reply window lengths (e.g., 6 seconds), grant limits (e.g., 2 hours / 20 uses), and forced desk/screen approvals are unapproved review proposals from preserved specs, not established policies.

---

## 6. Corrected Implementation Slices & Dependencies

| Slice ID | Target Files Owned (Coder) | Real Dependencies & Conflicts | Builder Responsibility | Tester Responsibility & Release Gates |
|---|---|---|---|---|
| **P0: Packaging** | `android/app/build.gradle.kts`, `bridge/package.json` | None | Verify release build fails without signing keys; verify `npm pack` tarball contents | Assert release artifact signing failure without keystore; verify exact tarball before publish |
| **S0: Security** | `TermuxLauncher.kt`, `SshSessionManager.kt`, `bridge/src/ws-server.ts`, `bridge/src/index.ts` | Overlaps with S2 on `ws-server.ts` | Build Android debug APK; compile bridge ESM | Assert 4401 on unauthenticated WS; assert `/sdcard` update script removal; assert SSH host key validation |
| **S1: Lifecycle** | `SshForegroundService.kt`, `AndroidManifest.xml`, `MainViewModel.kt` | Depends on S0 file cleanup | Device install build | Verify FGS startup; verify connection without terminal view; verify fold/unfold rebind |
| **S2: Protocol** | `bridge/src/protocol.ts`, `bridge/src/ws-server.ts`, `SessionStore.kt`, `BridgeClient.kt` | Overlaps with S0 on `ws-server.ts`; depends on reviewed authority schema | Both builds | Verify pairing handshake; test replay and sequence deduplication |
| **S3: Summary** | `SpokenSummaryComposer.kt`, `SpokenSummaryComposerTest.kt` | None (pure Kotlin, unwired) | `./gradlew :app:compileDebugKotlin` | FX1–FX15 counterexample fixtures pass 100%; verify no contradictory success claims |
| **S4: Voice Remote** | `SpeechManager.kt`, `TtsManager.kt`, `BargeInController.kt` | Depends on S1 service ownership | Device install build | Bluetooth communication device routing; MediaSession button events; TTS audio focus |
| **S5: Adapters** | `bridge/src/claude-cli.ts`, `bridge/src/types/summary.ts` | Unresolved dependency choice (MCP SDK vs Agent SDK); requires question channel | `npm run build` | CLI turn replay fixtures; API key environment scrubbing; auth verification |

---

## 7. Unresolved Human Decisions & Mandatory Release Gates

### 7.1 Unresolved Human Decisions (Explicit Gates)
- **Decision C1 (Host Placement):** PC host over SSH vs phone-only execution. (Neither environment runtime is measured; independent packaging and security work is unblocked).
- **Decision C2 (Session Grant Policy):** Grant scope, duration, action limits, and challenge mechanism remain to be approved by user.
- **Decision C3 (External Cloud Audio Consent):** Local on-device audio default vs external cloud audio services.

### 7.2 Mandatory Release Gates
1. **Developer APIs + Existing Subscription Routes:** Both supported per profile; ambient API keys scrubbed for subscription turns; zero silent billed fallback.
2. **Actual Question Speech & Readback:** End-to-end question channel wired from CLI adapter to TTS caller.
3. **Defensive Security Remediation:** Complete removal of `/sdcard` update script hook; unauthenticated endpoints locked down; SSH host keys verified.
4. **Verifiable Packaging:** Hard-failing unsigned release builds; verified npm tarball bytes prior to publishing.
