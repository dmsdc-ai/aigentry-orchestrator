#!/usr/bin/env bash
# T32 — session-cleanup.sh must close the terminal-adaptor surface on a
# telepty-MISS (#323/#340). Motivating incident: idle workers got deregistered
# from telepty, then `session-cleanup.sh <sid>` bailed early ("already cleaned
# or never registered") WITHOUT closing their cmux workspaces, which the
# orchestrator then had to close by hand. Step 4 of the orchestration sequence
# requires BOTH surfaces cleaned regardless of telepty state (ADR 2026-05-30:
# terminal-surface close = orchestrator adapter).
#
# Setup: telepty `list --json` does NOT contain the target sid → session_info is
# EMPTY → the telepty-miss branch fires. We stub the terminal-adaptor close
# (wh_close_for_sid) + the DELETE backup (curl) to RECORD that they were
# attempted. The lib re-source guard (WORKSPACE_HOST_SH_LOADED=1) lets our
# exported stub survive instead of being overwritten by the real adapter.
#
# Correctness trap covered: the close MUST be derived from the sid
# (wh_close_for_sid "$sid"), NOT from the absent $info (close_workspace_for
# <sid> <empty> would silent-no-op).
# Throwaway sids only — NEVER closes a live workspace.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T32]: $*" >&2; exit 1; }

# Records of attempted side-effects.
CLOSE_LOG="$T_TMP/wh-close-for-sid.log"; : > "$CLOSE_LOG"
CURL_LOG="$T_TMP/curl.log";             : > "$CURL_LOG"
export CLOSE_LOG CURL_LOG

# telepty list WITHOUT the orphan sid → session_info empty → telepty-miss branch.
ORPHAN="orphan-sid-T32"
printf '%s' '[{"id":"someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"

# curl stub: record the DELETE attempt + return 404 (already gone). Offline.
cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
echo 404
EOF
chmod +x "$STUB_BIN/curl"

# Stub the terminal-adaptor close seam. The lib's idempotent re-source guard
# (set below) makes `. lib/workspace-host.sh` a no-op, so this exported function
# survives instead of being replaced by the real cmux/warp/headless adapter.
wh_close_for_sid() { printf '%s\n' "${1:-<empty>}" >> "$CLOSE_LOG"; return 0; }
export -f wh_close_for_sid
export WORKSPACE_HOST_SH_LOADED=1

# Run cleanup on the telepty-orphan. Must succeed (idempotent) AND have invoked
# the terminal-adaptor close despite the telepty miss.
"$BASH_BIN" "$CLEANUP" "$ORPHAN" >/dev/null 2>&1 \
  || fail "session-cleanup.sh $ORPHAN exited non-zero on a telepty-miss orphan"

# Core assertion: terminal-adaptor close WAS invoked, derived from the sid.
grep -qx "$ORPHAN" "$CLOSE_LOG" \
  || fail "terminal-adaptor close NOT invoked for telepty-orphan (early return skipped it). close log:
$(cat "$CLOSE_LOG")"

# It must be called with the SID (not an empty arg from absent \$info).
grep -qx "<empty>" "$CLOSE_LOG" \
  && fail "close invoked with EMPTY arg — derived from absent \$info, not the sid"

# DELETE backup also still runs on the miss path.
grep -q "DELETE" "$CURL_LOG" \
  || fail "DELETE backup not invoked on telepty-miss. curl log:
$(cat "$CURL_LOG")"

echo "T32 PASS"
