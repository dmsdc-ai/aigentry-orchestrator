# Devkit Test Baseline & Prerequisite Evidence

- **Task**: #1143 (devkit prerequisite test baseline)
- **Role**: ec1143-tester (tester)
- **UTC Timestamp**: 2026-09-09T09:21:17Z
- **Report Worktree**: `/Users/duckyoungkim/.aigentry/worktrees/ec1143` (`docs/1143-test-baseline`)
- **Source Repository**: `/Users/duckyoungkim/projects/aigentry-devkit`
- **Source HEAD SHA**: `bb7876bcbe8f83c2d329b22f41751b2b07f1f61a`
- **Source Dirty State**: 16 modified files, 33 untracked items (Task #593 dirty WIP separation)

---

## 1. Baseline Execution Matrix

Executed serially inside disposable `git archive HEAD` sandbox with isolated `HOME`/`XDG`/`cache`/`npm-prefix` child environment (no network, no live services, no global writes).

| Suite Identifier | Exact Command | Scope / Category | Exit | Duration | Tests (P/F/S) | Status |
|---|---|---|---|---|---|---|
| `pkg:test` | `node bin/aigentry-devkit.js --help` | package.json / CI / Release | 0 | 0.031s | N/A | PASS (help flag only) |
| `pkg:test:scaffold-project` | `node --test tests/scaffold-project/v1/*.spec.js` | package.json | 0 | 0.142s | 11 / 0 / 0 | PASS |
| `pkg:test:scaffold-install-hooks` | `node --test tests/scaffold-install-hooks/v1/*.test.js` | package.json | 1 | 2.390s | 14 / 1 / 1 | FAIL (Task #748) |
| `pkg:test:logger-emit` | `node --test tests/logger-emit/v1/*.test.js` | package.json | 0 | 0.061s | 7 / 0 / 0 | PASS |
| `pkg:test:skills-drift` | `node --test tests/skills-drift/v1/*.test.js` | package.json | 0 | 0.071s | 7 / 0 / 0 | PASS |
| `disk:orchestrator-profile` | `node --test tests/orchestrator-profile.test.js` | disk (omitted from pkg/CI) | 1 | 0.931s | 6 / 1 / 0 | FAIL (rotted post-#613) |
| `disk:open-session-codex-flag` | `bash tests/open-session-codex-flag.test.sh` | disk (omitted from pkg/CI) | 1 | 0.021s | 2 / 1 / 0 | FAIL (rotted gemini flag) |
| `disk:open-session.bats` | `bats tests/open-session.bats` | disk (omitted from pkg/CI) | 0 | 0.465s | 3 / 0 / 0 | PASS |
| `disk:platform.bats` | `bats tests/platform.bats` | disk (omitted from pkg/CI) | 0 | 3.763s | 12 / 0 / 0 | PASS |
| `disk:session-cleanup.bats` | `bats tests/session-cleanup.bats` | disk (omitted from pkg/CI) | 0 | 1.047s | 3 / 0 / 0 | PASS |
| `disk:ctx-router.bats` | `bats tests/ctx-router.bats` | disk (omitted from pkg/CI) | 0 | 1.103s | 23 / 0 / 0 | PASS |
| `disk:ctx-e2e.bats` | `bats tests/ctx-e2e.bats` | disk (omitted from pkg/CI) | 0 | 2.960s | 5 / 0 / 0 | PASS |
| `disk:check-platform-usage` | `bash bin/check-platform-usage.sh` | disk (omitted from pkg/CI) | 0 | 0.033s | N/A | PASS (Rule 26 clean) |
| `disk:wtm-test-runner-default` | `bash tools/wtm/tests/test-runner.sh` | disk (omitted from pkg/CI) | 0 | 0.016s | 0 / 0 / 0 | UNMEASURED (checks `~/.wtm`) |
| `disk:wtm-test-lock-isolated` | `bash tools/wtm/tests/test-runner.sh tools/wtm/tests/test-lock.sh` | disk (omitted from pkg/CI) | 1 | 0.039s | 1 / 4 / 0 | BLOCKED (non-hermetic `~/.wtm`) |

---

## 2. Safe Execution Evidence

- **Disposable Tree**: Extracted `git archive HEAD` into fresh `/var/folders/.../devkit-baseline-*`. Original repo worktree untouched.
- **Dependency Isolation**: No `node_modules` copied or installed; zero `npm install` / `npm ci`. Tests rely on Node built-ins (`node:test`, `node:assert`, `child_process`, `fs`).
- **Child Environment**: `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `npm_config_prefix`, `npm_config_cache`, `TMPDIR`, and `AIGENTRY_HOME` all bound to sandbox subdirectories.
- **No Side Effects**: Telepty/session transport environment preserved; no global filesystem writes, zero network calls, zero live daemon spawns.
- **Serial Execution**: All suites executed strictly sequentially to avoid shared resource collisions. Disposable root removed post-run.

---

## 3. Source vs Working Tree (WT) Caveats

- **Committed Baseline**: Pinned to HEAD `bb7876b` ("docs: ecosystem table — telepty 0.7.1").
- **Working Tree Drift**: The local working tree contains 16 modified files (including `bin/aigentry-devkit.js`, `install.sh`, `config/modules/*.adapter.json`) and 33 untracked files/directories.
- **Untracked Test Suites in WT**:
  - `tests/exec-mode/`: 25+ Python test files using `pytest` (python 3.14). Untracked WIP.
  - `tests/install-fallback.test.js`: Untracked Node unit test.
- **Boundary**: Per task instructions, WT dirty state is owned separately by Task #593 and was intentionally excluded from this committed baseline.

---

## 4. Task #748 Recurrence Evidence

- **Execution**: `pkg:test:scaffold-install-hooks` executed on clean HEAD resulted in 14 passed, 1 failed, 1 skipped (`gemini-deferred`).
- **Failing Test**: `claude version bump replaces a valid older managed script` at `tests/scaffold-install-hooks/v1/claude-version-bump.test.js:37:10`.
- **Error**: `AssertionError: ERR_ASSERTION` comparing actual rendered hook script against regex:
  - Expected pattern: `/^# devkit version: 0\.0\.21$/m`
  - Actual file content: `# devkit version: 0.1.14`
- **Root Cause**: `package.json` version was bumped from `0.0.21` to `0.1.14`, but the test assertion hardcoded the stale regex `0.0.21`.
- **Verdict**: Confirmed 100% reproducible recurrence of historical Task #748 failure. Left untouched per hard constraint.

---

## 5. Additional Disk Suite Rot & Non-Hermetic Blockers

1. **`tests/orchestrator-profile.test.js`** (Exit 1):
   - Subtest 5 fails: `ENOENT: no such file or directory, lstat .../projects/aigentry-orchestrator/bin/open-session.sh`.
   - Root cause: Architecture change #613 made `open-session.sh` an orchestrator-owned real file and removed it from `install.sh` self-symlink repointing (`install.sh:820-824`), but test 5 still asserts symlink presence.
2. **`tests/open-session-codex-flag.test.sh`** (Exit 1):
   - Fails on: `grep -q 'gemini) \[ -z "\$extra_flags" \] && extra_flags="--approval-mode yolo"' "$TARGET"`.
   - Root cause: `bin/open-session.sh:133` added `-m ${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash}`, breaking the literal string check.
3. **`tools/wtm/tests/`** (Runner Bug & Non-Hermetic Dependencies):
   - `test-runner.sh` has a recursive self-sourcing loop when called with `test-*.sh` (it does not exclude itself from `$@`).
   - WTM test scripts hardcode `source "${HOME}/.wtm/lib/common.sh"`. In an isolated sandbox where `${HOME}/.wtm` does not exist, tests fail with missing file and missing function errors.

---

## 6. Disk Inventory vs CI & Runner Omissions

- **`package.json` scripts**: Defines only 5 commands (`test`, `test:scaffold-project`, `test:scaffold-install-hooks`, `test:logger-emit`, `test:skills-drift`).
- **CI Workflow (`.github/workflows/ci.yml`)**: Runs only `node bin/aigentry-devkit.js --help` across OS/node matrix.
- **Release Workflow (`.github/workflows/release.yml`)**: Validates only with `node bin/aigentry-devkit.js --help`.
- **Omissions from `package.json`**:
  - `tests/orchestrator-profile.test.js`
  - `tests/open-session-codex-flag.test.sh`
  - Bats suites: `open-session.bats`, `platform.bats`, `session-cleanup.bats`, `ctx-router.bats`, `ctx-e2e.bats`
  - CI guard: `bin/check-platform-usage.sh`
  - WTM suite: `tools/wtm/tests/` (13 scripts)
- **Omissions from CI/Release**: ZERO actual test suites run in CI or Release. `npm test` does not invoke any test suites.

---

## 7. Minimal Gate Acceptance Tests Needed

1. **Unified Gate Test Script**: An aggregate test command (e.g., `npm run test:unit`) running all passing hermetic suites (`scaffold-project`, `logger-emit`, `skills-drift`).
2. **Platform & Tool Partitioning**:
   - Node hermetic unit tests (`node --test`): run across all CI matrix platforms (Ubuntu, macOS, Windows).
   - Shell & Bats suites: run in a dedicated Unix step with `bats` installed.
3. **Future Fault Injection Acceptance (Per-Suite)**:
   - For every suite wired into CI/gate, verify gate sensitivity by intentionally injecting a failure and asserting non-zero exit.
   - Prevents regressions where test runners fail-open or swallow errors (as currently happens with `--help`).

---

## 8. What Blocks SPEC / CI Wiring

1. **Unfixed Suite Failures**:
   - `test:scaffold-install-hooks` (Task #748 version mismatch: `0.0.21` vs `0.1.14`).
   - `tests/orchestrator-profile.test.js` (Post-#613 symlink assertion rot).
   - `tests/open-session-codex-flag.test.sh` (Gemini model flag addition rot).
2. **Missing CI Tooling**:
   - Bats test runner is not installed in `.github/workflows/ci.yml`.
3. **Windows Incompatibility**:
   - Bash/Bats scripts cannot run directly on Windows runner without MSYS/Git-bash encapsulation.
4. **Non-Hermetic Subsystems**:
   - `tools/wtm/tests/` requires repo-relative path refactoring and runner fix before it can run in clean sandboxes.
5. **Untracked WIP Boundary**:
   - Untracked `tests/exec-mode/` and `tests/install-fallback.test.js` remain isolated under Task #593 investigation.
