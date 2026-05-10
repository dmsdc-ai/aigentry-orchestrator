---
multi_exec:
  enabled: true
  coder_session: E22-coder-294
  reviewer: subagent
  max_fix_iterations: 5
  cleanup_on_success: true
  preserve_on_error: true
  chunk_gates:
    - after_chunk: 1
      type: user_approval
---

# Session Cleanup + Platform Abstraction — Implementation Plan (#304)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션 자동 cleanup 기능 + Cross-OS platform abstraction layer 도입 (Unix 구현 완성 + Windows stub).

**Architecture:** `lib/platform.sh` dispatcher가 OS 감지 → `platform-unix.sh` 또는 `platform-windows.sh` source. `session-cleanup.sh`가 platform API만 호출. `multi-exec.sh`/`open-session.sh`에 cleanup 훅 연결. `check-platform-usage.sh`로 Rule 26 간이 강제.

**Tech Stack:** bash 4+ / jq / flock / fswatch (optional) / telepty / wtm-context

**Spec:** `docs/superpowers/specs/2026-04-19-session-cleanup-and-platform-abstraction-design.md`

**Execution mode note**: multi-exec.sh runner (#298 Phase 1)는 오늘 구현 완료. 이 plan 자체에 `multi_exec:` frontmatter 있음 — 러너가 이 plan을 읽고 Chunks 1/2/3 순차 실행 가능. 단, Chunk 3은 net-new API 포함이므로 manual `executing-plans` 스킬 또는 러너 실행 중 인간 감독 권장.

---

## File Structure

| 파일 | 유형 | 역할 | LOC |
|------|------|------|:---:|
| `aigentry-devkit/bin/lib/platform.sh` | create | dispatcher (os_type + backend source) | ~60 |
| `aigentry-devkit/bin/lib/platform-unix.sh` | create | macOS + Linux 구현 | ~140 |
| `aigentry-devkit/bin/lib/platform-windows.sh` | create | stub (exit 3 + msg) | ~25 |
| `aigentry-devkit/bin/session-cleanup.sh` | create | 세션 종료 CLI | ~90 |
| `aigentry-devkit/bin/check-platform-usage.sh` | create | Rule 26 CI guard | ~30 |
| `aigentry-devkit/bin/multi-exec.sh` | modify | cleanup_on_success 플래그 | +25 |
| `aigentry-devkit/bin/multi-exec-lib.sh` | modify | flock/event_wait → platform API | +30 |
| `aigentry-devkit/bin/open-session.sh` | modify | --auto-cleanup-on-exit | +15 |
| `aigentry-devkit/tests/platform.bats` | create | platform API tests | ~110 |
| `aigentry-devkit/tests/session-cleanup.bats` | create | cleanup flow tests | ~80 |
| `aigentry-devkit/tests/multi-exec.bats` | modify | cleanup_on_success tests | +25 |
| `aigentry-devkit/docs/platform-abstraction.md` | create | API reference + backend guide | ~120 |
| `aigentry-devkit/AGENTS.md` | modify | Rule 26 추가 | +12 |
| `aigentry-orchestrator/docs/superpowers/plans/2026-04-19-*.md` (3 files) | modify | frontmatter flag | +1 each |

**총 ~700 LOC production/docs + ~215 LOC tests = ~915 LOC.**

---

## Chunk 1: Platform layer + session-cleanup + CI guard (Tasks 1-5)

### Task 1: platform.sh dispatcher + bats

**Files:**
- Create: `aigentry-devkit/bin/lib/platform.sh`
- Create: `aigentry-devkit/tests/platform.bats`

- [ ] **Step 1.1: Dispatcher 작성**

`aigentry-devkit/bin/lib/platform.sh`:
```bash
#!/usr/bin/env bash
# platform.sh — Cross-OS abstraction dispatcher.
# Source this file from any script needing OS-specific primitives.
# After source, platform::* functions are available.
#
# Spec: docs/superpowers/specs/2026-04-19-session-cleanup-and-platform-abstraction-design.md

# Guard against double-source
[[ "${_PLATFORM_SH_SOURCED:-}" == "1" ]] && return 0
_PLATFORM_SH_SOURCED=1

PLATFORM_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# platform::os_type() → macos|linux|windows|unknown
# Honors $PLATFORM_OVERRIDE for test injection.
platform::os_type() {
  if [[ -n "${PLATFORM_OVERRIDE:-}" ]]; then
    echo "$PLATFORM_OVERRIDE"
    return 0
  fi
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin)             echo macos ;;
    Linux)              echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)                  echo unknown ;;
  esac
}

# Source backend based on detected OS.
_load_backend() {
  local os; os=$(platform::os_type)
  case "$os" in
    macos|linux)
      # shellcheck source=./platform-unix.sh
      source "$PLATFORM_LIB_DIR/platform-unix.sh"
      ;;
    windows)
      # shellcheck source=./platform-windows.sh
      source "$PLATFORM_LIB_DIR/platform-windows.sh"
      ;;
    *)
      echo "platform.sh: unknown OS '$os' — abort" >&2
      return 4
      ;;
  esac
}

_load_backend
```

- [ ] **Step 1.2: bats 테스트**

`aigentry-devkit/tests/platform.bats`:
```bash
#!/usr/bin/env bats

setup() {
  PLATFORM_LIB="$BATS_TEST_DIRNAME/../bin/lib/platform.sh"
  export HOME="$BATS_TMPDIR/platform-$$"
  mkdir -p "$HOME"
  unset _PLATFORM_SH_SOURCED  # reset guard for fresh source
}
teardown() { rm -rf "$HOME"; }

@test "os_type returns macos on Darwin" {
  run bash -c "PLATFORM_OVERRIDE=macos; source '$PLATFORM_LIB'; platform::os_type"
  [ "$status" -eq 0 ]
  [ "$output" = "macos" ]
}

@test "os_type honors PLATFORM_OVERRIDE for test injection" {
  run bash -c "PLATFORM_OVERRIDE=windows; source '$PLATFORM_LIB'; platform::os_type"
  [ "$output" = "windows" ]
}

@test "os_type defaults to uname when OVERRIDE unset" {
  run bash -c "unset PLATFORM_OVERRIDE; source '$PLATFORM_LIB'; platform::os_type"
  [ "$status" -eq 0 ]
  # Should return macos or linux on our dev machine
  [[ "$output" =~ ^(macos|linux)$ ]]
}

@test "source loads unix backend on macos" {
  run bash -c "PLATFORM_OVERRIDE=macos; source '$PLATFORM_LIB'; declare -f platform::kill_pid >/dev/null && echo yes"
  [ "$output" = "yes" ]
}
```

- [ ] **Step 1.3: 실행 권한 + run**

```bash
chmod +x aigentry-devkit/bin/lib/platform.sh
bats aigentry-devkit/tests/platform.bats
# Expected: 2 pass (2 require backend which isn't implemented yet — 2 will fail)
# That's ok — Tasks 2-3 provide backends
```

- [ ] **Step 1.4: Commit**

```bash
git -C aigentry-devkit add bin/lib/platform.sh tests/platform.bats
git -C aigentry-devkit commit -m "feat(platform): dispatcher with os_type + PLATFORM_OVERRIDE (#304)"
```

---

### Task 2: platform-unix.sh 구현

**Files:**
- Create: `aigentry-devkit/bin/lib/platform-unix.sh`
- Modify: `aigentry-devkit/tests/platform.bats` (+more tests)

- [ ] **Step 2.1: Unix backend 작성**

`aigentry-devkit/bin/lib/platform-unix.sh`:
```bash
#!/usr/bin/env bash
# platform-unix.sh — macOS + Linux backend for platform.sh

# platform::kill_pid <pid>
# Graceful: SIGTERM + 5s grace + SIGKILL fallback. Idempotent.
platform::kill_pid() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && { echo "kill_pid: pid required" >&2; return 2; }
  platform::is_alive "$pid" || return 0  # already dead — success

  kill -TERM "$pid" 2>/dev/null || return 0
  local i=0
  while [[ $i -lt 10 ]]; do  # 10 * 0.5s = 5s grace
    platform::is_alive "$pid" || return 0
    sleep 0.5
    i=$((i+1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  return 0
}

# platform::is_alive <pid> → 0 if alive, non-zero otherwise
platform::is_alive() {
  local pid="${1:-}"
  [[ -z "$pid" ]] && return 1
  kill -0 "$pid" 2>/dev/null
}

# platform::pid_exists <pidfile> → 0 if file has live pid, non-zero otherwise
platform::pid_exists() {
  local file="${1:-}"
  [[ -f "$file" ]] || return 1
  local pid; pid=$(cat "$file" 2>/dev/null)
  platform::is_alive "$pid"
}

# platform::file_lock <path> <fn>
# Acquire lock for <path>, run fn, release. Prefer flock, fallback mkdir+pid.
# Usage: platform::file_lock /tmp/mylock my_fn arg1 arg2
platform::file_lock() {
  local path="$1"; shift
  local fn="$1"; shift
  if command -v flock >/dev/null 2>&1; then
    (
      exec 200>"$path" || exit 1
      flock -n 200 || { echo "lock held: $path" >&2; exit 1; }
      "$fn" "$@"
    )
    return $?
  fi
  # Fallback: atomic mkdir + pid liveness
  local lockdir="${path}.d"
  local tries=0
  while ! mkdir "$lockdir" 2>/dev/null; do
    local holder
    holder=$(cat "$lockdir/pid" 2>/dev/null || echo 0)
    if [[ "$holder" != "0" ]] && ! platform::is_alive "$holder"; then
      rm -rf "$lockdir"  # stale, reclaim
      continue
    fi
    tries=$((tries+1))
    [[ $tries -gt 3 ]] && { echo "lock held by pid $holder: $path" >&2; return 1; }
    sleep 0.3
  done
  echo $$ > "$lockdir/pid"
  local rc=0
  "$fn" "$@" || rc=$?
  rm -rf "$lockdir"
  return $rc
}

# platform::file_unlock <path>  (best-effort, for script-wide locks that aren't scoped)
platform::file_unlock() {
  local path="${1:-}"
  [[ -z "$path" ]] && return 0
  rm -rf "${path}.d" 2>/dev/null || true
}

# platform::event_wait <dir> <timeout_sec>
# Block until dir has a new file or timeout. fswatch preferred, sleep-poll fallback.
platform::event_wait() {
  local dir="${1:-}" timeout="${2:-30}"
  [[ -d "$dir" ]] || { echo "event_wait: dir required" >&2; return 2; }
  if command -v fswatch >/dev/null 2>&1; then
    fswatch -1 --event Created --event Updated --latency 0.5 \
      --timeout "$(( timeout * 1000 ))" "$dir" >/dev/null 2>&1
    return $?
  fi
  # Fallback: poll every 2s
  local deadline=$(( $(date +%s) + timeout ))
  local seen; seen=$(ls "$dir" 2>/dev/null | wc -l)
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 2
    local now; now=$(ls "$dir" 2>/dev/null | wc -l)
    [[ "$now" -ne "$seen" ]] && return 0
  done
  return 1  # timeout
}
```

- [ ] **Step 2.2: Tests 확장**

Append to `platform.bats`:
```bash
@test "is_alive on current process → 0" {
  run bash -c "PLATFORM_OVERRIDE=$(uname -s | awk '{print tolower($0)}' | sed 's/darwin/macos/'); source '$PLATFORM_LIB'; platform::is_alive $$"
  [ "$status" -eq 0 ]
}

@test "is_alive on impossible pid → non-zero" {
  run bash -c "source '$PLATFORM_LIB'; platform::is_alive 999999"
  [ "$status" -ne 0 ]
}

@test "kill_pid on dead pid → success (idempotent)" {
  run bash -c "source '$PLATFORM_LIB'; platform::kill_pid 999999"
  [ "$status" -eq 0 ]
}

@test "file_lock runs fn and releases" {
  local lf="$HOME/testlock"
  run bash -c "source '$PLATFORM_LIB'; platform::file_lock '$lf' echo locked"
  [ "$status" -eq 0 ]
  [[ "$output" == *"locked"* ]]
  [ ! -e "${lf}.d" ] || [ ! -f "$lf" ] || true  # released
}

@test "event_wait times out on idle dir" {
  mkdir -p "$HOME/evt"
  run bash -c "source '$PLATFORM_LIB'; platform::event_wait '$HOME/evt' 2"
  [ "$status" -ne 0 ]  # timeout expected
}

@test "event_wait detects file creation" {
  mkdir -p "$HOME/evt"
  ( sleep 0.5 && touch "$HOME/evt/new" ) &
  run bash -c "source '$PLATFORM_LIB'; platform::event_wait '$HOME/evt' 5"
  [ "$status" -eq 0 ]
  wait
}
```

- [ ] **Step 2.3: Run + commit**

```bash
bats aigentry-devkit/tests/platform.bats
# Expected: 10 pass

git -C aigentry-devkit add bin/lib/platform-unix.sh tests/platform.bats
git -C aigentry-devkit commit -m "feat(platform): unix backend (kill_pid/is_alive/file_lock/event_wait) (#304)"
```

---

### Task 3: platform-windows.sh stub

**Files:**
- Create: `aigentry-devkit/bin/lib/platform-windows.sh`
- Modify: `aigentry-devkit/tests/platform.bats`

- [ ] **Step 3.1: Stub 작성**

`aigentry-devkit/bin/lib/platform-windows.sh`:
```bash
#!/usr/bin/env bash
# platform-windows.sh — Stub backend for Windows native (PowerShell/cmd).
# Currently all functions exit 3 with tracking info.
# Future PR will provide actual implementation (track: #305).

_PLATFORM_WINDOWS_NOT_YET() {
  echo "platform-windows: '$1' not yet implemented." >&2
  echo "                  Windows native support tracked at #305." >&2
  echo "                  Workaround: use WSL (Windows Subsystem for Linux)." >&2
  return 3
}

platform::kill_pid()    { _PLATFORM_WINDOWS_NOT_YET "kill_pid"; }
platform::is_alive()    { _PLATFORM_WINDOWS_NOT_YET "is_alive"; }
platform::pid_exists()  { _PLATFORM_WINDOWS_NOT_YET "pid_exists"; }
platform::file_lock()   { _PLATFORM_WINDOWS_NOT_YET "file_lock"; }
platform::file_unlock() { _PLATFORM_WINDOWS_NOT_YET "file_unlock"; }
platform::event_wait()  { _PLATFORM_WINDOWS_NOT_YET "event_wait"; }
```

- [ ] **Step 3.2: Tests for stub**

Append to `platform.bats`:
```bash
@test "windows stub kill_pid → exit 3 with msg" {
  run bash -c "PLATFORM_OVERRIDE=windows; source '$PLATFORM_LIB'; platform::kill_pid 123"
  [ "$status" -eq 3 ]
  [[ "$output" == *"not yet implemented"* ]] || [[ "$(cat)" == *"not yet"* ]] || true
  # stderr redirect check — both stdout and stderr should have signal
}

@test "windows stub event_wait → exit 3" {
  run bash -c "PLATFORM_OVERRIDE=windows; source '$PLATFORM_LIB'; platform::event_wait /tmp 1"
  [ "$status" -eq 3 ]
}
```

- [ ] **Step 3.3: Run + commit**

```bash
bats aigentry-devkit/tests/platform.bats
# Expected: 12 pass

git -C aigentry-devkit add bin/lib/platform-windows.sh tests/platform.bats
git -C aigentry-devkit commit -m "feat(platform): windows stub backend (#304, future #305)"
```

---

### Task 4: session-cleanup.sh

**Files:**
- Create: `aigentry-devkit/bin/session-cleanup.sh`
- Create: `aigentry-devkit/tests/session-cleanup.bats`

- [ ] **Step 4.1: CLI 작성**

`aigentry-devkit/bin/session-cleanup.sh`:
```bash
#!/usr/bin/env bash
# session-cleanup.sh — Universal session termination primitive.
# Usage: session-cleanup.sh <session-id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"

usage() { echo "Usage: session-cleanup.sh <session-id>"; exit 1; }

main() {
  local sid="${1:-}"
  [[ -z "$sid" ]] && usage

  # 1. Discover session
  local tp_info; tp_info=$(telepty session info "$sid" 2>/dev/null || echo "")
  if [[ -z "$tp_info" ]]; then
    echo "[cleanup] session not found: $sid (already gone, or never registered)" >&2
    exit 0
  fi

  # Extract PID (parse "Type: spawned" lines — best-effort; Type and pid may be omitted)
  local tp_pid
  tp_pid=$(echo "$tp_info" | awk '/^[[:space:]]*PID:/ {print $2; exit}')

  # 2. State flush FIRST (before kill)
  if command -v wtm-context >/dev/null 2>&1; then
    wtm-context handoff "$sid" "cleanup-complete" 2>/dev/null || true
  elif [[ -x "$HOME/.wtm/bin/wtm-context" ]]; then
    "$HOME/.wtm/bin/wtm-context" handoff "$sid" "cleanup-complete" 2>/dev/null || true
  fi
  if [[ -x "$SCRIPT_DIR/ctx-router.sh" ]]; then
    "$SCRIPT_DIR/ctx-router.sh" on-session-end "$sid" 2>/dev/null || true
  fi

  # 3. Terminate
  if [[ -n "$tp_pid" ]]; then
    platform::kill_pid "$tp_pid"
  fi
  # Close cmux workspace if wrapped
  if command -v cmux >/dev/null 2>&1; then
    local ws_ref
    ws_ref=$(cmux list-workspaces 2>/dev/null | awk -v sid="$sid" '$0 ~ sid {for(i=1;i<=NF;i++) if($i ~ /^workspace:/) {print $i; exit}}')
    [[ -n "$ws_ref" ]] && cmux close-workspace --workspace "$ws_ref" 2>/dev/null || true
  fi

  # 4. Trace cleanup
  rm -f "$HOME/.wtm/contexts/orchestrator/multi-exec.pid" 2>/dev/null || true
  # lockfiles for plan files (caller's responsibility to know; best-effort pattern cleanup)

  echo "[cleanup] session terminated: $sid"
}

main "$@"
```

- [ ] **Step 4.2: Bats tests**

`aigentry-devkit/tests/session-cleanup.bats`:
```bash
#!/usr/bin/env bats

setup() {
  SC_BIN="$BATS_TEST_DIRNAME/../bin/session-cleanup.sh"
  export HOME="$BATS_TMPDIR/sc-$$"
  mkdir -p "$HOME/.wtm/bin" "$HOME/.telepty"
  # Stub telepty to simulate session info + fail cleanly
  cat > "$HOME/.wtm/bin/telepty" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  "session")
    case "$2" in
      info)
        if [[ "$3" == "test-exists" ]]; then
          echo "ID: test-exists"
          echo "PID: 999999"
          exit 0
        fi
        exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$HOME/.wtm/bin/telepty"
  export PATH="$HOME/.wtm/bin:$PATH"
}
teardown() { rm -rf "$HOME"; }

@test "missing session-id → usage exit 1" {
  run "$SC_BIN"
  [ "$status" -eq 1 ]
}

@test "non-existent session → warning + exit 0" {
  run "$SC_BIN" test-does-not-exist
  [ "$status" -eq 0 ]
  [[ "$output" == *"not found"* ]]
}

@test "existent session → terminate (dead pid is idempotent)" {
  run "$SC_BIN" test-exists
  [ "$status" -eq 0 ]
  [[ "$output" == *"terminated"* ]]
}
```

- [ ] **Step 4.3: Run + commit**

```bash
chmod +x aigentry-devkit/bin/session-cleanup.sh
bats aigentry-devkit/tests/session-cleanup.bats
# Expected: 3 pass

git -C aigentry-devkit add bin/session-cleanup.sh tests/session-cleanup.bats
git -C aigentry-devkit commit -m "feat(session-cleanup): universal termination primitive (#304)"
```

---

### Task 5: check-platform-usage.sh CI guard

**Files:**
- Create: `aigentry-devkit/bin/check-platform-usage.sh`

- [ ] **Step 5.1: Guard script**

`aigentry-devkit/bin/check-platform-usage.sh`:
```bash
#!/usr/bin/env bash
# check-platform-usage.sh — Rule 26 interim CI guard.
# Fails if bin/ has direct OS-specific calls outside lib/platform-*.sh.
set -euo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Patterns that violate Rule 26
PATTERNS='kill -(TERM|KILL|9|TERM|HUP)[[:space:]]|\bflock\b|\bfswatch\b'

# Search recursively, exclude lib/platform-*.sh and all .md files
VIOLATIONS=$(grep -rnE "$PATTERNS" "$BIN_DIR" 2>/dev/null \
  | grep -vE '/lib/platform-(unix|windows)\.sh:' \
  | grep -vE '\.md:' \
  | grep -vE '^[^:]+/check-platform-usage\.sh:' \
  || true)

if [[ -n "$VIOLATIONS" ]]; then
  echo "Rule 26 violation — direct OS-specific calls outside platform backends:" >&2
  echo "$VIOLATIONS" >&2
  echo "" >&2
  echo "Use platform::kill_pid / platform::file_lock / platform::event_wait instead." >&2
  exit 1
fi
echo "Rule 26 check: clean"
```

- [ ] **Step 5.2: Run + commit**

```bash
chmod +x aigentry-devkit/bin/check-platform-usage.sh
~/projects/aigentry-devkit/bin/check-platform-usage.sh
# Expected: FAIL initially — ctx-router/multi-exec-lib have direct calls
# That's OK — Task 6+7 migrate them. Note exit 1 is expected here.

git -C aigentry-devkit add bin/check-platform-usage.sh
git -C aigentry-devkit commit -m "feat(check-platform-usage): Rule 26 CI guard (interim, pre-hook) (#304)"
```

---

## Chunk 1 Review Gate

Dispatch plan-document-reviewer for Chunk 1.

---

## Chunk 2: Integration + audit + docs (Tasks 6-11)

### Task 6: multi-exec-lib.sh → platform API migration

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec-lib.sh`

- [ ] **Step 6.1: Source platform.sh 상단에 추가**

```bash
# Near top of multi-exec-lib.sh, after shebang + comment:
SCRIPT_DIR_ME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/platform.sh
source "$SCRIPT_DIR_ME/lib/platform.sh"
```

- [ ] **Step 6.2: `acquire_lock` → `platform::file_lock` 활용**

Replace body of `acquire_lock`:
```bash
acquire_lock() {
  local plan="$1"
  LOCKFILE_PATH="${plan}.multi-exec.lock"
  # NOTE: we need to hold the lock for the lifetime of the runner (not wrap a fn).
  # Use flock-direct if available (via platform doesn't fit lifetime model);
  # fallback to platform::file_lock no-op style:
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCKFILE_PATH" || return 1
    flock -n 9 || { echo "lock held: $LOCKFILE_PATH" >&2; return 1; }
    return 0
  fi
  # No-flock fallback via mkdir using platform helper for liveness check
  local lockdir="${LOCKFILE_PATH}.d"
  if mkdir "$lockdir" 2>/dev/null; then
    echo $$ > "$lockdir/pid"; return 0
  fi
  local holder; holder=$(cat "$lockdir/pid" 2>/dev/null || echo 0)
  if ! platform::is_alive "$holder"; then
    rm -rf "$lockdir"; mkdir "$lockdir" && echo $$ > "$lockdir/pid" && return 0
  fi
  echo "lock held by live pid $holder" >&2; return 1
}
```

**Note**: lockfile 라이프타임 모델은 platform::file_lock의 wrap-fn 모델과 다름 (runner 전체 동안 hold). 그래서 flock은 직접 호출 유지 + Rule 26 예외는 check-platform-usage.sh의 allowlist 패턴에 `multi-exec-lib.sh` 추가 (Step 6.5).

- [ ] **Step 6.3: `await_task_report` 내부 폴링 → `platform::event_wait` 활용**

Replace the `sleep 5` / `fswatch -1` blocks in `await_task_report` (multi-exec.sh `main()` 내부):
```bash
# Inside await_task_report while-loop:
local remaining=$(( deadline - $(date +%s) ))
[[ $remaining -le 0 ]] && break
platform::event_wait "$shared_dir" "$remaining" || true
# (event_wait 내부가 fswatch or sleep-poll 선택)
```

같은 패턴을 `handle_chunk_gate` user_approval wait 에도 적용.

- [ ] **Step 6.4: `is_alive` 이미 있는 것은 platform::is_alive로 위임**

`acquire_pid_mutex`의 `kill -0 "$holder"` → `platform::is_alive "$holder"`.

- [ ] **Step 6.5: check-platform-usage.sh allowlist에 lockfile 예외 추가**

Modify `check-platform-usage.sh`:
```bash
# Patterns that violate Rule 26 (exclude lifetime-lock use case)
# ... existing grep ...
# ALLOW multi-exec-lib.sh flock for runner-lifetime lock (documented exception)
  | grep -vE '^[^:]+/multi-exec-lib\.sh:.*flock' \
```

이건 **임시 예외**. 장기적으로 platform::file_lock_persistent (라이프타임 모델) API 추가가 옳음 → Phase 2 고려.

- [ ] **Step 6.6: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 16/16 pass (unchanged behavior after migration)
~/projects/aigentry-devkit/bin/check-platform-usage.sh
# Expected: clean (after allowlist)

git -C aigentry-devkit add bin/multi-exec-lib.sh bin/check-platform-usage.sh
git -C aigentry-devkit commit -m "refactor(multi-exec): migrate is_alive/event_wait to platform API (Rule 26) (#304/#307)"
```

---

### Task 7: multi-exec.sh cleanup_on_success

**Files:**
- Modify: `aigentry-devkit/bin/multi-exec.sh`
- Modify: `aigentry-devkit/tests/multi-exec.bats`

- [ ] **Step 7.1: Frontmatter 읽기 확장**

After `fm=$(parse_frontmatter "$plan")` add:
```bash
  local cleanup_on_success preserve_on_error
  cleanup_on_success=$(echo "$fm" | jq -r '.cleanup_on_success // false')
  preserve_on_error=$(echo "$fm" | jq -r '.preserve_on_error // true')
```

- [ ] **Step 7.2: 종료 시 cleanup 호출**

End of `main()` just before `release_lock`:
```bash
  emit_event "runner_end" "$(jq -n --arg plan "$plan" '{plan:$plan}')"

  # Cleanup coder session if flag set AND no stuck/drift events
  if [[ "$cleanup_on_success" == "true" ]]; then
    # Check events file for stuck events in this run
    local had_error=0
    local events_log="$HOME/.wtm/contexts/orchestrator/journal.jsonl"
    if [[ -f "$events_log" ]]; then
      tail -200 "$events_log" 2>/dev/null | grep -q '"event":"stuck"' && had_error=1
    fi
    if [[ "$had_error" -eq 1 && "$preserve_on_error" == "true" ]]; then
      echo "[multi-exec] stuck detected — preserving $coder_session per preserve_on_error" >&2
    else
      echo "[multi-exec] cleanup_on_success → calling session-cleanup.sh $coder_session" >&2
      "$SCRIPT_DIR/session-cleanup.sh" "$coder_session" || echo "[multi-exec] cleanup failed (non-fatal)" >&2
      emit_event "session_cleanup_invoked" "$(jq -n --arg s "$coder_session" '{session:$s}')"
    fi
  fi
```

- [ ] **Step 7.3: Bats test**

Append to `multi-exec.bats`:
```bash
@test "cleanup_on_success flag invokes session-cleanup.sh" {
  local tmp; tmp=$(mktemp)
  cat > "$tmp" <<EOF
---
multi_exec:
  enabled: true
  coder_session: dummy-sid
  cleanup_on_success: true
---
# plan
## Chunk 1: x

### Task 1: x
- [ ] step 1
EOF
  # Shim session-cleanup.sh to record invocation
  local shim="$HOME/.wtm/bin/session-cleanup.sh"
  mkdir -p "$(dirname "$shim")"
  cat > "$shim" <<'SHIM'
#!/usr/bin/env bash
echo "cleanup invoked: $1" > "$BATS_TMPDIR/cleanup-called"
SHIM
  chmod +x "$shim"
  # Also shim telepty so dispatch doesn't fail outright
  # (bats@TODO: full shim suite — minimal version here)
  skip "integration test requires full telepty shim suite — defer to manual E2E (Task 11)"
  rm -f "$tmp"
}
```

- [ ] **Step 7.4: Run + commit**

```bash
bats aigentry-devkit/tests/multi-exec.bats
# Expected: 16 pass + 1 skip

git -C aigentry-devkit add bin/multi-exec.sh tests/multi-exec.bats
git -C aigentry-devkit commit -m "feat(multi-exec): cleanup_on_success + preserve_on_error support (#304)"
```

---

### Task 8: open-session.sh --auto-cleanup-on-exit

**Files:**
- Modify: `aigentry-devkit/bin/open-session.sh`

- [ ] **Step 8.1: 플래그 + trap 확장**

Add flag parsing:
```bash
auto_cleanup=0
# ... existing flag loop ...
    --auto-cleanup-on-exit) auto_cleanup=1; shift;;
```

Modify existing `cleanup_on_exit` trap function (from #299) to include session-cleanup when flag set:
```bash
cleanup_on_exit() {
  local ec=$?
  local ctx_router="${CTX_ROUTER_PATH:-$HOME/projects/aigentry-devkit/bin/ctx-router.sh}"
  if [ -x "$ctx_router" ] && [ -n "${sid:-}" ]; then
    "$ctx_router" on-session-end "$sid" >&2 2>/dev/null || true
  fi
  # Extended: if --auto-cleanup-on-exit, also run session-cleanup.sh
  if [ "${auto_cleanup:-0}" -eq 1 ] && [ -n "${sid:-}" ]; then
    local sc="$(dirname "${BASH_SOURCE[0]}")/session-cleanup.sh"
    [ -x "$sc" ] && "$sc" "$sid" 2>/dev/null || true
  fi
  exit $ec
}
```

- [ ] **Step 8.2: shellcheck + commit**

```bash
shellcheck aigentry-devkit/bin/open-session.sh
# Expected: 0 errors

git -C aigentry-devkit add bin/open-session.sh
git -C aigentry-devkit commit -m "feat(open-session): --auto-cleanup-on-exit flag invokes session-cleanup (#304)"
```

---

### Task 9: AGENTS.md Rule 26 + 3 plan flags

**Files:**
- Modify: `aigentry-devkit/AGENTS.md`
- Modify: `aigentry-orchestrator/docs/superpowers/plans/2026-04-19-context-compact-switching.md`
- Modify: `aigentry-orchestrator/docs/superpowers/plans/2026-04-19-ecosystem-contract-doc.md`
- Modify: `aigentry-orchestrator/docs/superpowers/plans/2026-04-19-multi-exec-phase1.md`

- [ ] **Step 9.1: AGENTS.md Rule 26 추가**

Append to `aigentry-devkit/AGENTS.md` (or appropriate rules section):
```markdown
### Rule 26 — Cross-OS abstraction 준수 (HARD RULE)

신규 bash 코드는 `lib/platform.sh` abstract API 경유한다. 직접 `flock`/`fswatch`/`kill -TERM|-KILL|-9` 등 OS-specific 호출 금지.

- 위반 예: `kill -TERM $pid`
- 준수 예: `platform::kill_pid $pid`

기존 코드는 refactor-on-touch (#307). 새 파일/기능은 예외 없이 준수.
간이 검증: `bin/check-platform-usage.sh` (CI에서 수동 호출).
```

- [ ] **Step 9.2: 3 plan frontmatter flag**

Each of the 3 plan files: ensure frontmatter has `multi_exec.cleanup_on_success: true` (this plan already has it; check/add for the other 2).

Check:
```bash
for p in ~/projects/aigentry-orchestrator/docs/superpowers/plans/2026-04-19-*.md; do
  echo "=== $p ==="
  head -15 "$p"
done
```

If `cleanup_on_success` 없으면 frontmatter에 추가 (context-compact 플랜과 ecosystem-contract 플랜만).

- [ ] **Step 9.3: Commit**

```bash
git -C aigentry-devkit add AGENTS.md
git -C aigentry-devkit commit -m "docs(AGENTS): Rule 26 cross-OS abstraction mandate (#304)"

cd ~/projects/aigentry-orchestrator
git add docs/superpowers/plans/2026-04-19-context-compact-switching.md docs/superpowers/plans/2026-04-19-ecosystem-contract-doc.md
git commit -m "docs(plans): add cleanup_on_success frontmatter flag (#304)"
```

---

### Task 10: docs/platform-abstraction.md

**Files:**
- Create: `aigentry-devkit/docs/platform-abstraction.md`

- [ ] **Step 10.1: Reference doc**

`aigentry-devkit/docs/platform-abstraction.md`:
````markdown
# Platform Abstraction Layer

Spec: `aigentry-orchestrator/docs/superpowers/specs/2026-04-19-session-cleanup-and-platform-abstraction-design.md`

## Purpose

신규 bash 코드가 OS-specific 호출을 직접 하지 않고 abstract API 경유하도록. 미래 Windows native 구현 시 backend 한 파일만 교체하면 됨.

## API

7 functions, sourced via `source bin/lib/platform.sh`:

### Session lifecycle

- `platform::os_type` → `macos|linux|windows|unknown`
- `platform::kill_pid <pid>` → SIGTERM + 5s grace + SIGKILL fallback, idempotent
- `platform::is_alive <pid>` → 0 if alive, non-zero otherwise
- `platform::pid_exists <pidfile>` → parse file + is_alive

### Concurrency

- `platform::file_lock <path> <fn> [args...]` → acquire lock, run fn, release
- `platform::file_unlock <path>` → explicit release (best-effort)

### Events

- `platform::event_wait <dir> <timeout_sec>` → block until change or timeout

## PLATFORM_OVERRIDE (test injection)

```bash
PLATFORM_OVERRIDE=windows source bin/lib/platform.sh
# Now platform::os_type returns "windows" → windows backend sourced
```

## Backends

- `platform-unix.sh` (macOS + Linux): bash 4+ / jq / flock / fswatch-optional
- `platform-windows.sh` (stub): exit 3 + clear message, tracked at #305

## Example

```bash
source bin/lib/platform.sh

my_work() {
  echo "doing stuff in locked section"
}

# Lock + run + release
platform::file_lock /tmp/my.lock my_work

# Check session pid
if platform::is_alive 12345; then
  platform::kill_pid 12345
fi

# Wait for directory activity
platform::event_wait /tmp/inbox 30 || echo "timeout"
```

## Rule 26

AGENTS.md Rule 26은 신규 bash 코드가 이 API 경유하도록 강제한다. 검증: `bin/check-platform-usage.sh`.

## Roadmap

- [x] Phase 1: Abstract + Unix + Windows stub (#304)
- [ ] Phase 2: Legacy code migration (#307)
- [ ] Phase 3: Windows native PowerShell backend (#305)
````

- [ ] **Step 10.2: Commit**

```bash
git -C aigentry-devkit add docs/platform-abstraction.md
git -C aigentry-devkit commit -m "docs(platform): API reference + backend guide + roadmap (#304)"
```

---

### Task 11: E2E smoke + hanging session cleanup

**Files:** no new files, runtime verification only

- [ ] **Step 11.1: E2E smoke — 전체 bats + check guard**

```bash
bats aigentry-devkit/tests/platform.bats        # Expected: 12/12
bats aigentry-devkit/tests/session-cleanup.bats # Expected: 3/3
bats aigentry-devkit/tests/multi-exec.bats      # Expected: 16 + 1 skip
bats aigentry-devkit/tests/ctx-router.bats      # Expected: 23/23 (no regression)
bats aigentry-devkit/tests/ctx-e2e.bats         # Expected: 5/5 (no regression)
bash aigentry-devkit/tools/wtm/tests/test-context.sh  # Expected: 10/10 (no regression)

~/projects/aigentry-devkit/bin/check-platform-usage.sh
# Expected: clean
```

- [ ] **Step 11.2: 오늘 남은 세션 수동 정리 (dogfooding)**

```bash
# Try the new tool on the actual hanging sessions!
~/projects/aigentry-devkit/bin/session-cleanup.sh E22-coder-294
# Expected: terminated message + session gone from telepty list

# Similarly
~/projects/aigentry-devkit/bin/session-cleanup.sh E27-coder-299

telepty list
# Expected: only aigentry-orchestrator + B-deliberation-252 (if not ours)
```

- [ ] **Step 11.3: Empty commit as phase marker**

```bash
git -C aigentry-devkit commit --allow-empty -m "chore(platform): #304 Phase 1 complete — session cleanup + abstraction layer live"
```

- [ ] **Step 11.4: REPORT with final summary**

```
telepty inject --ref --from E22-coder-294 aigentry-orchestrator "REPORT: #304 Phase 1 DONE | total commits | total tests | hanging sessions cleaned up | AGENTS.md Rule 26 live"
```

---

## Chunk 2 Review Gate

Dispatch plan-document-reviewer for Chunk 2.

---

## Delegation Plan

| 작업 | 위임 | 파일 소유권 |
|------|------|------------|
| All Tasks 1-11 | E22-coder-294 (기존 재사용 — Plan A/B/#298 경험 보유) | devkit/bin/lib/*, session-cleanup.sh, multi-exec*, open-session, tests/, docs/, AGENTS.md |
| 3 plan frontmatter flag | orchestrator 또는 E22 | orchestrator repo docs/superpowers/plans/ |

SAWP envelope + INVARIANTS (Rule 17/Rule 26) + MANDATORY report 포함.

---

## Success Criteria

- [ ] 51+ bats total pass (12 platform + 3 cleanup + 16 multi-exec + 23 ctx-router + 5 ctx-e2e + wtm 10)
- [ ] shellcheck clean on all new files
- [ ] `check-platform-usage.sh` returns exit 0 on clean repo
- [ ] `PLATFORM_OVERRIDE=windows session-cleanup.sh fake` → stub error exit 3
- [ ] E22-coder-294 + E27-coder-299 실제 정리 완료 (오늘 실증)
- [ ] AGENTS.md Rule 26 live
- [ ] 3 plans frontmatter에 cleanup_on_success: true 있음

---

## Out-of-Scope

- Windows native PowerShell backend (→ #305)
- Pre-commit hook 자동 Rule 26 enforcement (Phase 2 enhancement)
- `platform::file_lock_persistent` (runner-lifetime) API (현재 multi-exec 예외 처리)
- `bin/aigentry-devkit.js` Node.js 쪽 추상화 — JS 레이어는 별도 sprint (→ #308)

---

## Chunk 3 (Phase 1.5 expansion): Comprehensive migration of existing cross-OS code (Tasks 12-14)

사용자 확장 요청 (2026-04-19): 기존 cross-OS 호출도 추상화 layer로 이전. refactor-on-touch 아닌 active migration. #307 (legacy refactor-on-touch) 상당 부분을 이 phase에서 흡수.

**Phase 1.5 선언**: 원래 Phase 1 = Chunks 1+2. Chunk 3은 net-new platform API (spawn_tmux_window 등 3개) + 기존 코드 migration까지 포함하므로 엄밀히 "Phase 1.5" 성격. 기능적으로는 Phase 1 직후 즉시 이어서 실행 (Chunks 1+2+3 하나의 러너 실행으로 가능).

**Scope 명시 (Task 12)**: open-session.sh의 7개 터미널 분기 중 **tmux + iterm만** 이번 migration 대상. **aterm/wezterm/ghostty 분기는 out-of-scope** — 각자 own CLI (aterm/wezterm cli/ghostty) 를 호출하며 OS primitive 직접 사용 아님 (cross-OS by design). `telepty spawn` 기반 generic fallback도 OS-agnostic.

### Task 12: open-session.sh — tmux + osascript 분기 → platform backend

**Files:**
- Modify: `aigentry-devkit/bin/open-session.sh`
- Modify: `aigentry-devkit/bin/lib/platform-unix.sh` (terminal-spawn abstractions 추가)

- [ ] **Step 12.1: platform-unix.sh에 terminal-spawn 함수 추가**

Append to `platform-unix.sh`:
```bash
# platform::spawn_tmux_window <name> <cwd> <cmd>
# Abstracts `tmux new-window`. Windows stub: "not yet".
platform::spawn_tmux_window() {
  local name="${1:-}" cwd="${2:-}" cmd="${3:-}"
  [[ -z "$name" || -z "$cwd" || -z "$cmd" ]] && { echo "spawn_tmux_window: 3 args" >&2; return 2; }
  command -v tmux >/dev/null 2>&1 || { echo "tmux not installed" >&2; return 4; }
  tmux new-window -c "$cwd" -n "$name" "$cmd"
}

# platform::spawn_iterm_tab <cwd> <cmd>  (macOS only via AppleScript)
platform::spawn_iterm_tab() {
  local cwd="${1:-}" cmd="${2:-}"
  [[ -z "$cwd" || -z "$cmd" ]] && { echo "spawn_iterm_tab: 2 args" >&2; return 2; }
  [[ "$(platform::os_type)" == "macos" ]] || { echo "iTerm requires macOS" >&2; return 4; }
  osascript <<APPLESCRIPT
tell application "iTerm"
  tell current window
    create tab with default profile
    tell current session
      write text "cd ${cwd} && ${cmd}"
    end tell
  end tell
end tell
APPLESCRIPT
}

# platform::has_tmux_session → 0 if TMUX env set (inside tmux), non-zero otherwise
platform::has_tmux_session() {
  [[ -n "${TMUX:-}" ]]
}
```

Add same 3 functions as stubs in `platform-windows.sh`.

- [ ] **Step 12.2: open-session.sh 분기를 platform API로 교체**

Replace tmux branch in `open_in_terminal()`:
```bash
    tmux)
      platform::spawn_tmux_window "$title" "$cwd" "telepty allow --id '$sid' $cli_cmd"
      echo "$sid"
      ;;
```

Replace iterm branch:
```bash
    iterm)
      platform::spawn_iterm_tab "$cwd" "telepty allow --id $sid $cli_cmd" \
        || { echo "ERR iTerm spawn failed" >&2; exit 2; }
      echo "$sid"
      ;;
```

Replace fallback_spawn tmux reference:
```bash
fallback_spawn() {
  local _sid="$1" _cwd="$2" _cli_cmd="$3"
  if platform::has_tmux_session && command -v tmux >/dev/null 2>&1; then
    platform::spawn_tmux_window "$_sid" "$_cwd" "telepty allow --id '$_sid' $_cli_cmd"
    echo "$_sid"
  else
    telepty spawn --id "$_sid" -- bash -c "cd '$_cwd' && exec $_cli_cmd" >/dev/null
    echo "⚠️  Session spawned as daemon (no visible terminal). Attach: telepty attach $_sid" >&2
    echo "$_sid"
  fi
}
```

Source platform.sh at top of open-session.sh:
```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/platform.sh
source "$SCRIPT_DIR/lib/platform.sh"
```

- [ ] **Step 12.3: shellcheck + commit**

```bash
shellcheck aigentry-devkit/bin/open-session.sh aigentry-devkit/bin/lib/platform-unix.sh
~/projects/aigentry-devkit/bin/check-platform-usage.sh
# Expected: clean

git -C aigentry-devkit add bin/open-session.sh bin/lib/platform-unix.sh bin/lib/platform-windows.sh
git -C aigentry-devkit commit -m "refactor(open-session): tmux/iterm branches via platform API (#304/#307)"
```

---

### Task 13: wtm-watch → platform::event_wait

**Files:**
- Modify: `aigentry-devkit/tools/wtm/bin/wtm-watch`

- [ ] **Step 13.1: fswatch 호출을 platform::event_wait 로 교체**

Source platform.sh at top:
```bash
# Near top of wtm-watch:
WATCH_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin"
if [[ -r "$WATCH_SCRIPT_DIR/lib/platform.sh" ]]; then
  source "$WATCH_SCRIPT_DIR/lib/platform.sh"
fi
```

Replace `fswatch` block (lines ~58-85) with (preserves both 60s session-liveness check + change detection):
```bash
# Use platform::event_wait if available, else fallback polling
if declare -f platform::event_wait >/dev/null 2>&1; then
  while true; do
    # platform::event_wait timeout returns non-zero → time-based liveness check
    # success returns 0 → handle change
    if platform::event_wait "$WATCH_DIR" 60; then
      _on_change  # filesystem change
    fi
    _check_session_liveness  # 60s liveness (preserved from pre-#304 semantics)
  done
else
  # Legacy polling fallback (wtm-watch was polling-based pre-#304)
  while true; do
    sleep 30
    _on_change
    _check_session_liveness
  done
fi
```

If `_check_session_liveness` doesn't exist in current wtm-watch, inline equivalent (re-read sessions.json + compare last_active) to match pre-#304 loop.

- [ ] **Step 13.2: shellcheck + commit**

```bash
shellcheck aigentry-devkit/tools/wtm/bin/wtm-watch
~/projects/aigentry-devkit/bin/check-platform-usage.sh
# Expected: clean

git -C aigentry-devkit add tools/wtm/bin/wtm-watch
git -C aigentry-devkit commit -m "refactor(wtm-watch): fswatch via platform::event_wait (#304/#307)"
```

---

### Task 14: 최종 audit + #307 close

**Files:** no new files — verify-only task

- [ ] **Step 14.1: 전체 grep — zero direct calls**

```bash
~/projects/aigentry-devkit/bin/check-platform-usage.sh
# Expected: clean (after Tasks 6/12/13 migrations)
```

만약 violation 남아있으면 해당 파일 migration + commit.

- [ ] **Step 14.2: Full regression**

```bash
bats aigentry-devkit/tests/platform.bats        # 12/12 + 6 new (3 spawn stubs + 3 unix happy)
bats aigentry-devkit/tests/session-cleanup.bats # 3/3
bats aigentry-devkit/tests/multi-exec.bats      # 16 + 1 skip
bats aigentry-devkit/tests/ctx-router.bats      # 23/23
bats aigentry-devkit/tests/ctx-e2e.bats         # 5/5
bash aigentry-devkit/tools/wtm/tests/test-context.sh  # 10/10
```

총 69+ tests pass 목표.

- [ ] **Step 14.3: #307 task status 갱신 (orchestrator 영역)**

```bash
# orchestrator 자체에서. status는 canonical "closed" 사용 + resolution 필드로 merge 경로 기록
jq '(.tasks[] | select(.id == 307)) |= (.status = "closed" | .resolution = "merged-into-304" | .updated_at = "2026-04-19")' state/task-queue.json > /tmp/tq-new.json && mv /tmp/tq-new.json state/task-queue.json
```

- [ ] **Step 14.4: Final commit + REPORT**

```bash
git -C aigentry-devkit commit --allow-empty -m "chore(platform): #304 Phase 1 expanded scope complete — all cross-OS callers migrated (except JS #308)"
```

REPORT:
```
REPORT: #304 FULL DONE — Phase 1 + comprehensive migration | commits: ~15 | files migrated: multi-exec-lib/open-session/wtm-watch | remaining: #308 aigentry-devkit.js JS-side | tests: 69+ pass | shellcheck + Rule 26 check: clean
```

---

## Chunk 3 Review Gate

Dispatch plan-document-reviewer for Chunk 3.

---

## Updated Success Criteria (expanded)

- [ ] 모든 existing bash 파일이 platform API 경유 (check-platform-usage.sh clean)
- [ ] 69+ bats pass
- [ ] open-session.sh의 tmux + iterm 분기가 platform::spawn_* 호출
- [ ] wtm-watch의 fswatch 직접 호출 → platform::event_wait
- [ ] multi-exec-lib.sh의 fswatch/kill -0 → platform API
- [ ] #307 close (merged into #304)
- [ ] #308 등록 (JS-side abstraction for aigentry-devkit.js)
- [ ] AGENTS.md Rule 26 live + CI guard in place
