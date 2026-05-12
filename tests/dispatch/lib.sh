#!/usr/bin/env bash
# Shared harness for tests/dispatch/*. Provides tmp-state, stub PATH, JSON helpers.
set -euo pipefail

TEST_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_LIB_DIR/../.." && pwd -P)"

t_setup() {
  T_TMP=$(mktemp -d)
  export T_TMP
  export DISPATCH_STATE_DIR="$T_TMP/state"
  mkdir -p "$DISPATCH_STATE_DIR"
  printf '[]\n' > "$DISPATCH_STATE_DIR/active.json"
  export STUB_BIN="$T_TMP/stubbin"
  mkdir -p "$STUB_BIN"
  cp "$TEST_LIB_DIR/stubs/telepty" "$STUB_BIN/telepty"
  cp "$TEST_LIB_DIR/stubs/git"     "$STUB_BIN/git"
  cp "$TEST_LIB_DIR/stubs/dispatch.sh" "$STUB_BIN/dispatch.sh"
  chmod +x "$STUB_BIN"/*
  export PATH="$STUB_BIN:$PATH"
  export TELEPTY="$STUB_BIN/telepty"
  export GIT="$STUB_BIN/git"
  export DISPATCH_SH="$STUB_BIN/dispatch.sh"
  export STUB_SCREEN_FILE="$T_TMP/screen.txt"
  export STUB_LIST_FILE="$T_TMP/list.json"
  export STUB_GIT_LOG_FILE="$T_TMP/git-log.txt"
  export STUB_GIT_CONFIG_FILE="$T_TMP/git-email.txt"
  export STUB_GIT_SHORTSTAT_FILE="$T_TMP/git-shortstat.txt"
  export STUB_DISPATCH_LOG="$T_TMP/dispatch.log"
  : > "$STUB_DISPATCH_LOG"
  printf '%s' '[{"id":"sid-A","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
  printf '' > "$STUB_SCREEN_FILE"
  printf '' > "$STUB_GIT_LOG_FILE"
  printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
  printf '' > "$STUB_GIT_SHORTSTAT_FILE"
}

t_teardown() {
  [ -n "${T_TMP:-}" ] && rm -rf "$T_TMP"
}

t_assert_contains() {
  local file="$1" needle="$2"
  if ! grep -qF "$needle" "$file" 2>/dev/null; then
    echo "FAIL: $file does not contain: $needle" >&2
    echo "--- file content ---" >&2
    cat "$file" >&2 || true
    exit 1
  fi
}

t_assert_status() {
  local sid="$1" want="$2"
  python3 - "$DISPATCH_STATE_DIR/active.json" "$sid" "$want" <<'PY'
import json,sys
path,sid,want=sys.argv[1:4]
data=json.load(open(path))
got=None
for e in data:
    if e.get("sid")==sid: got=e.get("status"); break
if got!=want:
    print(f"FAIL: status of {sid} = {got!r}, want {want!r}", file=sys.stderr)
    sys.exit(1)
PY
}

t_seed_entry() {
  local sid="$1" dispatched_at="$2" expected="$3" status="${4:-in_flight}" cwd="${5:-}"
  python3 - "$DISPATCH_STATE_DIR/active.json" \
    "$sid" "$dispatched_at" "$expected" "$status" "$cwd" <<'PY'
import json,sys
path,sid,da,exp,st,cwd=sys.argv[1:7]
try: data=json.load(open(path))
except Exception: data=[]
data.append({"sid":sid,"ref_path":"/tmp/r","ref_hash":"x",
             "dispatched_at":da,"expected_report_by":exp,"last_seen_at":da,
             "status":st,"classification_history":[],"cwd":cwd,"from_sid":"orchestrator",
             "re_dispatch_count":0})
json.dump(data,open(path,"w"),indent=2)
PY
}

t_field() {
  local sid="$1" field="$2"
  python3 - "$DISPATCH_STATE_DIR/active.json" "$sid" "$field" <<'PY'
import json,sys
path,sid,field=sys.argv[1:4]
data=json.load(open(path))
for e in data:
    if e.get("sid")==sid: print(e.get(field,"")); sys.exit(0)
sys.exit(1)
PY
}

t_run_tracker() {
  TRACKER_NOW="${TRACKER_NOW:-2026-05-12T12:00:00Z}" \
    "$REPO_ROOT/bin/dispatch-tracker.sh" "$@"
}
