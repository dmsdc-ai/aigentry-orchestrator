#!/usr/bin/env bash
# T164 (6b0687d, #1108 port) — bin/tq-status.sh must survive the control queue's
#       non-integer task ids. Its Recent Activity block sorted with `sort_by(-.id)`,
#       and jq cannot negate a string, so one id like "115b" (the control queue holds
#       47 of them) made the whole report exit non-zero. Ported fix: a string id sorts
#       as 0 (`tonumber? // 0`), numeric-looking string ids sort as their number.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

QUEUE="$T_TMP/task-queue.json"
cat > "$QUEUE" <<'JSON'
{
  "active_focus": "t164",
  "tracks": {},
  "tasks": [
    {"id": 300, "track": "t164", "status": "pending", "desc": "numeric three hundred"},
    {"id": "115b", "track": "t164", "status": "done", "desc": "string id row", "updated_at": "2026-10-01"},
    {"id": 250, "track": "t164", "status": "done", "desc": "numeric two fifty"},
    {"id": "310", "track": "t164", "status": "pending", "desc": "numeric-looking string id"}
  ]
}
JSON

ERR="$T_TMP/err.txt"
if ! out=$(TQ="$QUEUE" "$REPO_ROOT/bin/tq-status.sh" 2>"$ERR"); then
  echo "FAIL: tq-status.sh exited non-zero on a queue with a string id:" >&2; cat "$ERR" >&2; exit 1
fi
recent=$(printf '%s\n' "$out" | sed -n '/^=== Top 5 Recent Activity/,$p' | tail -n +2)
want=$(printf '%s\n' \
  "  #310 [t164] pending — numeric-looking string id" \
  "  #300 [t164] pending — numeric three hundred" \
  "  #250 [t164] done — numeric two fifty" \
  "  #115b [t164] done — string id row")
if [ "$recent" != "$want" ]; then
  echo "FAIL: Recent Activity is missing rows or mis-ordered:" >&2
  printf 'want:\n%s\ngot:\n%s\n' "$want" "$recent" >&2; exit 1
fi
printf '%s\n' "$out" > "$T_TMP/out.txt"
t_assert_contains "$T_TMP/out.txt" "  done: 2"

echo "T164 PASS"
