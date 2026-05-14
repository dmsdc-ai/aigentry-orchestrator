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
# Exit codes: 0 OK, 1 timeout, 2 spawn failed, 3 inject failed, 4 usage,
#             5 --verify-delivered detected delivery failure.
set -euo pipefail
if [ "${DISPATCH_SH_NO_MAIN:-0}" != "1" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
TRACKER_SH="$SCRIPT_DIR/dispatch-tracker.sh"
TELEPTY="${TELEPTY:-telepty}"

usage() { sed -n '2,18p' "$0"; }

target=""; ref_file=""; from_id=""; timeout_ms=30000
spawn=0; track=""; name=""; cwd=""; cli="claude"
verify_delivered=0

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
    --verify-delivered) verify_delivered=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "dispatch.sh: unknown arg: $1" >&2; usage >&2; exit 4;;
  esac
done

if [ "${DISPATCH_SH_NO_MAIN:-0}" != "1" ]; then
  [ -n "$ref_file" ] || { echo "dispatch.sh: --ref required" >&2; exit 4; }
  [ -f "$ref_file" ] || { echo "dispatch.sh: ref file not found: $ref_file" >&2; exit 4; }
fi

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
# Strategy: positive override — an idle-prompt signal in last3 wins over a
# banner signal in the wider tail. Hard-negatives in last3 (working spinner,
# trust-folder modal) reject regardless of prompt.
# Fallback for telepty#22 (https://github.com/dmsdc-ai/aigentry-telepty/issues/22):
# Claude 2.x's welcome banner persists in scrollback until the first input,
# so banner-in-tail alone can no longer mean not-ready. Drop this branch once
# `telepty wait-ready` lands; the function shape stays as a defensive fallback.
is_ready() {
  local sid="$1" cli_kind="$2" screen
  screen=$("$TELEPTY" read-screen "$sid" --lines 60 2>/dev/null || true)
  CLI_KIND="$cli_kind" SCREEN="$screen" python3 - <<'PY'
import os, re, sys
cli = os.environ.get("CLI_KIND", "")
text = os.environ.get("SCREEN", "")
lines = [l.rstrip() for l in text.splitlines() if l.strip()]
if not lines: sys.exit(1)
tail   = "\n".join(lines[-20:])
last3  = "\n".join(lines[-3:])

BANNERS = {
  "claude": r"Welcome back|Tips for getting started|Trust this folder|Do you want to enable|Press Enter to continue",
  "codex":  r"Welcome to .*Codex|OpenAI Codex CLI|Loading…|Initializing",
  "gemini": r"Welcome to Gemini|Loading model|Initializing|Authenticating",
}
PROMPT = {"claude": r"❯", "codex": r"›", "gemini": r"›|│ >"}
HARD_NEG = r"Working\.\.\.|Thinking|esc to interrupt|Press Enter to continue|Do you trust"
banner = BANNERS.get(cli, r"Welcome|Initializing|Loading|Tips for getting started")
prompt = PROMPT.get(cli, r"❯|›")

banner_match = re.search(banner, tail)
placeholder  = re.search(rf'(?m){prompt}\s+Try "[^"]+"', last3)
prompt_only  = re.search(prompt, last3)
hard_neg     = re.search(HARD_NEG, last3)

if hard_neg:
    sys.exit(1)
if placeholder or prompt_only:
    sys.exit(0)  # idle prompt in last3 = ready (banner in tail tolerated)
if banner_match:
    sys.exit(1)
sys.exit(1)
PY
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
ref_hash=""

# Returns 0 to proceed, 1 to skip (idempotent — same ref already dispatched).
# Records the new hash so a subsequent identical re-run will skip.
dedup_check_and_mark() {
  local sid="$1" mark
  ref_hash=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref_file")
  mark="$dedup_dir/$sid"
  if [ -f "$mark" ] && [ "$(cat "$mark" 2>/dev/null)" = "$ref_hash" ]; then
    echo "OK already dispatched to $sid (same ref hash, skip)"
    return 1
  fi
  printf '%s\n' "$ref_hash" > "$mark"
}

do_inject() {
  local sid="$1"
  local -a a=(inject --ref "$ref_file" --submit --submit-retry 2)
  [ -n "$from_id" ] && a+=(--from "$from_id")
  a+=("$sid")
  telepty "${a[@]}"
}

# Returns 0 if the inject visibly landed (placeholder cleared or payload's
# first line echoed), 1 otherwise. Called only when --verify-delivered is set.
verify_delivered() {
  local sid="$1" first_line post
  first_line=$(head -n1 "$ref_file" | tr -d '\r')
  sleep 5
  post=$("$TELEPTY" read-screen "$sid" --lines 30 2>/dev/null || true)
  FIRST="$first_line" POST="$post" python3 - <<'PY'
import os, re, sys
post = os.environ.get("POST", "")
first = os.environ.get("FIRST", "")
lines = [l.rstrip() for l in post.splitlines() if l.strip()]
tail = "\n".join(lines[-10:]) if lines else ""
placeholder = re.search(r'[❯›]\s+Try "[^"]+"', tail) is not None
echoed = bool(first) and first[:60] in post
if placeholder and not echoed:
    sys.exit(1)
sys.exit(0)
PY
}

# Best-effort tracker hook: append on-success entry. Tracker absence is fatal-free.
tracker_append() {
  local sid="$1" hash="$2"
  [ -x "$TRACKER_SH" ] || return 0
  local -a a=(append "$sid" "$ref_file" "$hash")
  [ -n "$cwd" ] && a+=(--cwd "$cwd")
  [ -n "$from_id" ] && a+=(--from "$from_id")
  "$TRACKER_SH" "${a[@]}" >/dev/null 2>&1 || true
}

# --- main ---
# Sourceable for tests: `DISPATCH_SH_NO_MAIN=1 source dispatch.sh` exposes
# is_ready / verify_delivered without running the dispatch flow.
if [ "${DISPATCH_SH_NO_MAIN:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

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

if ! do_inject "$sid"; then
  echo "dispatch.sh: telepty inject failed for $sid" >&2
  rm -f "$dedup_dir/$sid"
  exit 3
fi

if [ "$verify_delivered" -eq 1 ]; then
  if ! verify_delivered "$sid"; then
    echo "dispatch.sh: DELIVERY_FAILED for $sid (placeholder untouched)" >&2
    exit 5
  fi
fi

tracker_append "$sid" "$ref_hash"
echo "OK dispatched to $sid"
exit 0
