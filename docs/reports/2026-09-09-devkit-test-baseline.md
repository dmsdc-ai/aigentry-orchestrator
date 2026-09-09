# Devkit Test Baseline & Prerequisite Evidence (Evidence Review)

- **Task**: #1143 (devkit prerequisite test baseline evidence review)
- **Role**: ec1143-ec1143-tester
- **UTC Timestamp**: 2026-09-09T09:34:00Z
- **Report Worktree**: `/Users/duckyoungkim/.aigentry/worktrees/ec1143` (`docs/1143-test-baseline`)
- **Source Repo**: `/Users/duckyoungkim/projects/aigentry-devkit` @ `bb7876bcbe8f83c2d329b22f41751b2b07f1f61a`
- **Dirty State in WT**: 16 modified files, 33 untracked items (Task #593 dirty WIP boundary)

---

## 1. Retained Evidence Paths & Data Integrity

- **Retained Task Logs**: `<appDataDir>/brain/08367b48-6150-4c12-b10d-4d62d439cb33/.system_generated/tasks/`
  - `task-92.log` (2,733 B): Execution of 9 disk-only suites.
  - `task-107.log` (0 B): Runaway WTM invocation (canceled, log unbuffered).
  - `task-132.log` (3,824 B): Structured serial execution of all 15 suites with timing and exit codes.
  - `task-175.log` (191 B): Initial `telepty list` recording launchctl restart failure.
  - `task-184.log` (230 B): First `telepty inject` recording missing session.
  - `task-193.log` (471 B): Second `telepty inject` retry recording 3 failed daemon restarts.
- **Transcript**: `brain/.../.system_generated/logs/transcript.jsonl` (full command and stdout/stderr history).
- **Ephemeral Baseline Tree**: The temporary archive extraction directory `/var/folders/.../devkit-baseline-cwjfwp5u/` was deleted via `rm -rf` post-run at 18:21:14 UTC. Raw files in that directory are deleted; evidence below relies strictly on retained task logs and transcript history.

---

## 2. Baseline Execution Matrix (Single-Run Snapshot)

*Caveat*: Observed in a single serial execution pass on pinned HEAD `bb7876b`. CI definition in `.github/workflows/ci.yml` is static manifest only; remote GitHub Actions run history was not inspected.

| Suite Identifier | Exact Executed Command | Category | Exit | Duration | Tests (P/F/S) | Status |
|---|---|---|---|---|---|---|
| `pkg:test` | `node bin/aigentry-devkit.js --help` | package.json / CI / Release | 0 | 0.031s | N/A | PASS (help flag only) |
| `pkg:test:scaffold-project` | `node --test tests/scaffold-project/v1/*.spec.js` | package.json | 0 | 0.142s | 11 / 0 / 0 | PASS |
| `pkg:test:scaffold-install-hooks` | `node --test tests/scaffold-install-hooks/v1/*.test.js` | package.json | 1 | 2.390s | 14 / 1 / 1 | FAIL (Task #748) |
| `pkg:test:logger-emit` | `node --test tests/logger-emit/v1/*.test.js` | package.json | 0 | 0.061s | 7 / 0 / 0 | PASS |
| `pkg:test:skills-drift` | `node --test tests/skills-drift/v1/*.test.js` | package.json | 0 | 0.071s | 7 / 0 / 0 | PASS |
| `disk:orchestrator-profile` | `node --test tests/orchestrator-profile.test.js` | Disk-only | 1 | 0.931s | 6 / 1 / 0 | FAIL (rotted post-#613) |
| `disk:open-session-codex-flag` | `bash tests/open-session-codex-flag.test.sh` | Disk-only | 1 | 0.021s | 2 / 1 / 0 | FAIL (rotted gemini flag) |
| `disk:open-session.bats` | `bats tests/open-session.bats` | Disk-only | 0 | 0.465s | 3 / 0 / 0 | PASS |
| `disk:platform.bats` | `bats tests/platform.bats` | Disk-only | 0 | 3.763s | 12 / 0 / 0 | PASS |
| `disk:session-cleanup.bats` | `bats tests/session-cleanup.bats` | Disk-only | 0 | 1.047s | 3 / 0 / 0 | PASS |
| `disk:ctx-router.bats` | `bats tests/ctx-router.bats` | Disk-only | 0 | 1.103s | 23 / 0 / 0 | PASS |
| `disk:ctx-e2e.bats` | `bats tests/ctx-e2e.bats` | Disk-only | 0 | 2.960s | 5 / 0 / 0 | PASS |
| `disk:check-platform-usage` | `bash bin/check-platform-usage.sh` | Disk-only | 0 | 0.033s | N/A | PASS (Rule 26 clean) |
| `disk:wtm-test-runner-default` | `bash tools/wtm/tests/test-runner.sh` | Disk-only | 0 | 0.016s | 0 / 0 / 0 | UNMEASURED (checks `~/.wtm`) |
| `disk:wtm-test-lock-isolated` | `bash tools/wtm/tests/test-runner.sh tools/wtm/tests/test-lock.sh` | Disk-only | 1 | 0.039s | 1 / 4 / 0 | BLOCKED (non-hermetic `~/.wtm`) |

---

## 3. Retained Output Excerpts for Failed Suites

1. **`pkg:test:scaffold-install-hooks`** (14 passed, 1 failed, 1 skipped):
   - Failed file: `tests/scaffold-install-hooks/v1/claude-version-bump.test.js:37`
   - Retained output:
     ```
     not ok 2 - claude version bump replaces a valid older managed script
       code: 'ERR_ASSERTION', name: 'AssertionError', operator: 'match'
       expected: /^# devkit version: 0\.0\.21$/m
       actual: "# devkit version: 0.1.14"
     ```
   - Evidence: Hardcoded legacy version regex `0.0.21` vs bumped package version `0.1.14`. Task #748 recurrence confirmed.
2. **`disk:orchestrator-profile`** (6 passed, 1 failed):
   - Failed file: `tests/orchestrator-profile.test.js:252`
   - Retained output:
     ```
     not ok 5 - phase-8 hermetic install generates all artifacts and is idempotent
       error: "ENOENT: no such file or directory, lstat '.../aigentry-orchestrator/bin/open-session.sh'"
     ```
   - Evidence: Post-#613 removed `open-session.sh` repointing from `install.sh:820-824`, but test 5 still asserted symlink presence.
3. **`disk:open-session-codex-flag`** (2 passed, 1 failed):
   - Failed file: `tests/open-session-codex-flag.test.sh:36`
   - Retained output: `FAIL: gemini default flags regressed`
   - Evidence: `bin/open-session.sh:133` added `-m ${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash}`, breaking literal string grep.
4. **`disk:wtm-test-lock-isolated`** (1 passed, 4 failed):
   - Failed file: `tools/wtm/tests/test-lock.sh:6-7`
   - Retained output: `.../home/.wtm/lib/common.sh: No such file or directory`
   - Evidence: Scripts hardcode `source "${HOME}/.wtm/lib/common.sh"`; fails in isolated `$HOME`.

---

## 4. Environmental Controls vs Inheritance & Daemon Outages

- **Controlled by Harness**: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `npm_config_prefix`, `npm_config_cache`, `TMPDIR`, and `AIGENTRY_HOME` were explicitly bound to sandbox subdirectories.
- **Uncontrolled Inheritance Vectors**:
  - `PATH` was inherited from host `os.environ` (`/opt/homebrew/bin`, `/Users/duckyoungkim/.nvm/.../bin`), providing access to global binaries.
  - Subprocess invocation in test suites (`tests/orchestrator-profile.test.js:39, :213`, `tests/scaffold-project/v1/helper.js:31`, `tests/scaffold-install-hooks/v1/helpers.js:27`) used `{ ...process.env, ... }`, leaking parent `CMUX_*`, `TELEPTY_*`, and system variables into child processes.
  - IPC / Sockets: macOS lacks network namespaces. Telepty daemon port (3848), CMUX port (11550), and `/Users/duckyoungkim/.local/state/cmux/cmux.sock` were accessible if connected by child processes.
  - Preliminary check: One un-isolated run of `test-lock.sh` ran with parent `HOME`, sourcing live `/Users/duckyoungkim/.wtm/lib/common.sh`.
- **Daemon Outage Observations**:
  - Outage 1 (18:22:55 UTC, `task-175.log`): `launchctl kickstart -k gui/501/com.aigentry.telepty` failed; telepty daemon down.
  - Outage 2 (18:23:33 UTC, `task-193.log`): 3 automated restart attempts failed with `no-daemon-after-launchd-restart`.
  - Causation is **UNKNOWN**. No live reproduction was attempted. Blanket claims of "no global impact" are withdrawn.

---

## 5. WTM Background Recursion Incident & Process Teardown

- **Mechanism**: At 18:19:56 UTC, `task-107` ran `bash tools/wtm/tests/test-runner.sh tools/wtm/tests/test-*.sh`. The glob matched `test-runner.sh`, which executed `source "$test_file"` on itself in an unbounded recursive sourcing loop.
- **PIDs Identified**: `ps aux | grep test-` at 18:20:21 UTC showed PID 72990 (Python harness), PID 72992 (`bash test-runner.sh`), and PID 76764 (child `bash`).
- **Termination**: `task-107` canceled via `manage_task(kill)`; processes killed via `kill -9 72990 72992 76764`.
- **Verification**: `ps aux | grep test- | grep -v grep` at 18:20:34 UTC confirmed all runner and descendant processes stopped.

---

## 6. Blockers & Scope Constraints for CI Wiring (#1143 vs #748)

- **Ownership Separation**:
  - Task #748 owns the hook version mismatch fix.
  - Task #1143 owns wiring default test/CI/release to actual suites.
  - Tester does **not** propose excluding the failing hook suite from CI. Wiring requires either: (a) waiting for Task #748 resolution, (b) fixing test code under authorized coder delegation, or (c) explicit orchestrator policy waiver.
- **Additional CI Wiring Blockers**:
  - Outdated tests: `tests/orchestrator-profile.test.js` (needs #613 spec alignment) and `tests/open-session-codex-flag.test.sh`.
  - CI environment gaps: `ci.yml` lacks `bats` runner installation.
  - Cross-platform: Shell/Bats suites fail on `windows-latest` runner without MSYS/bash encapsulation.
  - Untracked WIP: `tests/exec-mode/` (pytest) and `tests/install-fallback.test.js` remain isolated under Task #593.
