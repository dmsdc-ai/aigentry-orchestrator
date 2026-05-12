#!/usr/bin/env bash
# dispatch.sh — Wraps `telepty inject` with REPL-ready wait so the first
#               dispatch to a freshly-spawned session is not lost to the
#               welcome-bootstrap race. Orchestrator-side workaround for
#               telepty#18 (https://github.com/dmsdc-ai/aigentry-telepty/issues/18).
#               헌법 Rule 32 영구 fix mandate (codified 2026-05-12 after 5+ recurrences,
#               until telepty-side handshake / wait-ready / queue lands).
#
# Modes:
#   dispatch.sh --target <sid> --ref <file> [--from <orch-sid>] [--timeout-ms 30000]
#   dispatch.sh --spawn-and-dispatch --track T --name N --cwd P --cli claude \
#               --ref <file> [--from <orch-sid>]
#   dispatch.sh --help
#
# Ready detection: per-CLI prompt-symbol probe of `telepty read-screen` plus
# welcome/boot banner absence (claude ❯ / codex › / gemini ›|│ >).
#
# Exit codes: 0 OK, 1 timeout, 2 spawn failed, 3 inject failed, 4 usage.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() { sed -n '2,18p' "$0"; }

target=""; ref_file=""; from_id=""; timeout_ms=30000
spawn=0; track=""; name=""; cwd=""; cli="claude"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2;;
    --ref) ref_file="$2"; shift 2;;
    --from) from_id="$2"; shift 2;;
    --timeout-ms) timeout_ms="$2"; shift 2;;
    --spawn-and-dispatch) spawn=1; shift;;
    --track) track="$2"; shift 2;;
    --name) name="$2"; shift 2;;
    --cwd) cwd="$2"; shift 2;;
    --cli) cli="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "dispatch.sh: unknown arg: $1" >&2; usage >&2; exit 4;;
  esac
done

[ -n "$ref_file" ] || { echo "dispatch.sh: --ref required" >&2; exit 4; }
[ -f "$ref_file" ] || { echo "dispatch.sh: ref file not found: $ref_file" >&2; exit 4; }

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# Look up the wrapped CLI ("claude"/"codex"/"gemini") for a sid, "" if absent.
cli_of() {
  telepty list --json 2>/dev/null | python3 -c "
import json, sys
sid = sys.argv[1]
try:
    for s in json.load(sys.stdin):
        if s.get('id') == sid:
            print(s.get('command') or '')
            break
except Exception:
    pass
" "$1"
}

# Returns 0 if the wrapped CLI's REPL is past the welcome/boot screen.
# Strategy: banner-absent AND prompt-symbol-present (rendered screen probe).
is_ready() {
  local sid="$1" cli_kind="$2" screen
  screen=$(telepty read-screen "$sid" --lines 80 2>/dev/null) || screen=""
  [ -n "$screen" ] || return 1
  case "$cli_kind" in
    claude)
      if printf '%s' "$screen" | grep -qE 'Welcome back|Tips for getting started|Trust this folder|Do you want to enable|Press Enter to continue'; then
        return 1
      fi
      printf '%s' "$screen" | grep -qF '❯'
      ;;
    codex)
      if printf '%s' "$screen" | grep -qE 'Welcome to .*Codex|OpenAI Codex CLI|Loading…|Initializing'; then
        return 1
      fi
      printf '%s' "$screen" | grep -qF '›'
      ;;
    gemini)
      if printf '%s' "$screen" | grep -qE 'Welcome to Gemini|Loading model|Initializing|Authenticating'; then
        return 1
      fi
      printf '%s' "$screen" | grep -qE '›|│ >'
      ;;
    *)
      if printf '%s' "$screen" | grep -qE 'Welcome|Initializing|Loading|Tips for getting started'; then
        return 1
      fi
      printf '%s' "$screen" | grep -qE '❯|›'
      ;;
  esac
}

wait_for_ready() {
  local sid="$1" cli_kind deadline
  cli_kind=$(cli_of "$sid")
  if [ -z "$cli_kind" ]; then
    echo "dispatch.sh: session '$sid' not found in telepty list" >&2
    return 1
  fi
  deadline=$(( $(now_ms) + timeout_ms ))
  while :; do
    if is_ready "$sid" "$cli_kind"; then return 0; fi
    if [ "$(now_ms)" -ge "$deadline" ]; then
      echo "dispatch.sh: timeout (${timeout_ms}ms) waiting for $sid REPL ready (cli=$cli_kind)" >&2
      return 1
    fi
    sleep 0.5
  done
}

dedup_dir="$HOME/.aigentry/dispatch-helper"
mkdir -p "$dedup_dir"

# Returns 0 to proceed, 1 to skip (idempotent — same ref already dispatched).
# Records the new hash so a subsequent identical re-run will skip.
dedup_check_and_mark() {
  local sid="$1" hash mark
  hash=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref_file")
  mark="$dedup_dir/$sid"
  if [ -f "$mark" ] && [ "$(cat "$mark" 2>/dev/null)" = "$hash" ]; then
    echo "OK already dispatched to $sid (same ref hash, skip)"
    return 1
  fi
  printf '%s\n' "$hash" > "$mark"
}

do_inject() {
  local sid="$1"
  local -a a=(inject --ref "$ref_file" --submit --submit-retry 2)
  [ -n "$from_id" ] && a+=(--from "$from_id")
  a+=("$sid")
  telepty "${a[@]}"
}

# --- main ---
sid=""
if [ "$spawn" -eq 1 ]; then
  if [ -z "$track" ] || [ -z "$name" ] || [ -z "$cwd" ]; then
    echo "dispatch.sh: --track --name --cwd required for --spawn-and-dispatch" >&2
    exit 4
  fi
  if ! "$SCRIPT_DIR/open-session.sh" --track "$track" --name "$name" --cwd "$cwd" --cli "$cli" >/dev/null; then
    echo "dispatch.sh: open-session.sh failed" >&2
    exit 2
  fi
  sid="${track}-${name}"
elif [ -n "$target" ]; then
  sid="$target"
else
  echo "dispatch.sh: --target or --spawn-and-dispatch required" >&2
  exit 4
fi

if ! dedup_check_and_mark "$sid"; then exit 0; fi

if ! wait_for_ready "$sid"; then exit 1; fi

if do_inject "$sid"; then
  echo "OK dispatched to $sid"
  exit 0
else
  echo "dispatch.sh: telepty inject failed for $sid" >&2
  rm -f "$dedup_dir/$sid"
  exit 3
fi
