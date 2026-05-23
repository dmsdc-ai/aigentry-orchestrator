#!/usr/bin/env bash
# inject-handler.sh — Orchestrator-side dispatcher for incoming inject envelopes.
#
# Reads an inject body from stdin (or --body-file), parses it via the compiled
# src/session/inject-parser.js, then takes the per-kind action:
#
#   report          → dispatch-tracker.sh mark-reported <sid> (which schedules Layer D)
#   cleanup-request → dispatch-cleanup-scheduler.sh schedule <target>
#   extend-lifetime → dispatch-cleanup-scheduler.sh cancel or defer (per defer_minutes)
#   hold            → emit to state/dispatch/holds.log (audit only — orch reads this)
#   test-report     → write state/test-reports/<YYYY-MM-DD>/<session_id>.json (R5a)
#
# The handler exits 0 on any recognized envelope (action taken or logged).
# Unrecognized bodies exit 1 with the parser's error on stderr.
#
# Usage:
#   inject-handler.sh < body.txt
#   inject-handler.sh --body-file body.txt
#   inject-handler.sh --sid <override-sid> < body.txt   # for sid-less envelopes (REPORT)

set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STATE_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
TEST_REPORTS_DIR="${TEST_REPORTS_DIR:-$REPO_DIR/state/test-reports}"
HOLDS_LOG="$STATE_DIR/holds.log"
PARSER_JS="${INJECT_PARSER_JS:-$REPO_DIR/dist/src/session/inject-parser.js}"
TRACKER_SH="${TRACKER_SH:-$SCRIPT_DIR/dispatch-tracker.sh}"
SCHEDULER_SH="${SCHEDULER_SH:-$SCRIPT_DIR/dispatch-cleanup-scheduler.sh}"

mkdir -p "$STATE_DIR"

usage() { sed -n '2,20p' "$0"; exit "${1:-0}"; }

body_file=""
sid_override=""
while [ $# -gt 0 ]; do
  case "$1" in
    --body-file) body_file="$2"; shift 2;;
    --sid) sid_override="$2"; shift 2;;
    -h|--help) usage 0;;
    *) echo "inject-handler: unknown $1" >&2; exit 4;;
  esac
done

if [ -z "$body_file" ]; then
  body_file=$(mktemp)
  trap 'rm -f "$body_file"' EXIT
  cat > "$body_file"
fi

if [ ! -f "$PARSER_JS" ]; then
  echo "inject-handler: compiled parser not found at $PARSER_JS (run \`tsc -p .\`)" >&2
  exit 2
fi

# Parse via small inline node script. Outputs JSON: {ok, kind?, payload?, transport?, error?}.
parsed=$(BODY_FILE="$body_file" PARSER_JS="$PARSER_JS" node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const body = await readFile(process.env.BODY_FILE, "utf8");
const mod = await import(pathToFileURL(process.env.PARSER_JS).href);
const r = mod.parseInject(body);
if (r.ok) {
  const { kind, payload, transport } = r.envelope;
  process.stdout.write(JSON.stringify({ ok: true, kind, transport, payload }));
} else {
  process.stdout.write(JSON.stringify({ ok: false, error: r.error }));
}
')

ok=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ok"))')
if [ "$ok" != "True" ]; then
  err=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("error",""))')
  echo "inject-handler: parse failed: $err" >&2
  exit 1
fi

kind=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')
transport=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["transport"])')

case "$kind" in
  report)
    sid="${sid_override:-}"
    if [ -z "$sid" ]; then
      echo "inject-handler: --sid required for REPORT envelopes (markdown subject doesn't carry sid)" >&2
      exit 1
    fi
    if [ -x "$TRACKER_SH" ]; then
      "$TRACKER_SH" mark-reported "$sid" || true
    fi
    echo "[inject-handler] report kind=report sid=$sid transport=$transport — scheduler armed"
    ;;
  cleanup-request)
    target=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["payload"]["target"])')
    reason=$(printf '%s' "$parsed" | python3 -c 'import json,sys;p=json.load(sys.stdin)["payload"];print(p.get("reason",""))')
    grace=$(printf '%s' "$parsed" | python3 -c 'import json,sys;p=json.load(sys.stdin)["payload"];print(p.get("grace_seconds",""))')
    args=(schedule "$target" --source explicit-request)
    [ -n "$reason" ] && args+=(--reason "$reason")
    [ -n "$grace" ] && args+=(--grace-seconds "$grace")
    if [ -x "$SCHEDULER_SH" ]; then "$SCHEDULER_SH" "${args[@]}" >/dev/null 2>&1 || true; fi
    echo "[inject-handler] cleanup-request target=$target transport=$transport"
    ;;
  extend-lifetime)
    target=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["payload"]["target"])')
    defer=$(printf '%s' "$parsed" | python3 -c 'import json,sys;p=json.load(sys.stdin)["payload"];print(p.get("defer_minutes",""))')
    reason=$(printf '%s' "$parsed" | python3 -c 'import json,sys;p=json.load(sys.stdin)["payload"];print(p.get("reason",""))')
    if [ -n "$defer" ]; then
      args=(defer "$target" --minutes "$defer")
      [ -n "$reason" ] && args+=(--reason "$reason")
      if [ -x "$SCHEDULER_SH" ]; then "$SCHEDULER_SH" "${args[@]}" >/dev/null 2>&1 || true; fi
      echo "[inject-handler] extend-lifetime target=$target defer=${defer}m transport=$transport"
    else
      if [ -x "$SCHEDULER_SH" ]; then "$SCHEDULER_SH" cancel "$target" >/dev/null 2>&1 || true; fi
      echo "[inject-handler] extend-lifetime target=$target cancel-pending transport=$transport"
    fi
    ;;
  hold)
    # Audit log only — orchestrator session reads this when deciding next phase.
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$parsed" >> "$HOLDS_LOG"
    echo "[inject-handler] hold logged transport=$transport"
    ;;
  test-report)
    sid_payload=$(printf '%s' "$parsed" | python3 -c 'import json,sys;print(json.load(sys.stdin)["payload"]["session_id"])')
    sid="${sid_override:-$sid_payload}"
    date_dir=$(date -u +%Y-%m-%d)
    target_dir="$TEST_REPORTS_DIR/$date_dir"
    mkdir -p "$target_dir"
    target_file="$target_dir/${sid}.json"
    # Atomic write: tmp + mv.
    tmp=$(mktemp "${target_file}.tmp.XXXXXX")
    printf '%s' "$parsed" | python3 -c '
import json,sys
data = json.load(sys.stdin)
out = data["payload"]
out["_transport"] = data["transport"]
print(json.dumps(out, indent=2, ensure_ascii=False))
' > "$tmp"
    mv "$tmp" "$target_file"
    echo "[inject-handler] test-report written sid=$sid path=$target_file transport=$transport"
    ;;
  *)
    echo "inject-handler: unrecognized kind=$kind" >&2
    exit 1
    ;;
esac
