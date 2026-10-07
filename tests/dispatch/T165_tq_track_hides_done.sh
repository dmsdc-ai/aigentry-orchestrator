#!/usr/bin/env bash
# T165 (#1108 port) — bin/tq-track.sh must hide finished rows in the vocabulary the
#       control queue actually uses. It hid only status "completed", and the control
#       queue marks finished work "done" (782 rows, 0 "completed"), so every finished
#       task was listed as open. Ported fix: both "done" and "completed" are hidden
#       by default; `--all` still lists every row. Ids are mixed numeric/string, as in
#       the control queue, so the sort must not fail on them either.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

QUEUE="$T_TMP/task-queue.json"
cat > "$QUEUE" <<'JSON'
{
  "tracks": {"t165": {"name": "T165 track", "desc": "fixture", "status": "active", "priority": "P1"}},
  "tasks": [
    {"id": 501, "track": "t165", "status": "pending", "priority": "P1", "desc": "open numeric row"},
    {"id": "501b", "track": "t165", "status": "in_progress", "priority": "P1", "desc": "open string-id row"},
    {"id": 502, "track": "t165", "status": "done", "priority": "P2", "desc": "finished done row"},
    {"id": "502b", "track": "t165", "status": "done", "priority": "P2", "desc": "finished done string-id row"},
    {"id": 503, "track": "t165", "status": "completed", "priority": "P2", "desc": "finished completed row"},
    {"id": 504, "track": "other", "status": "pending", "priority": "P1", "desc": "other track row"}
  ]
}
JSON

ERR="$T_TMP/err.txt"
tasks_of() { sed -n '/^=== Tasks ===/,$p' "$1" | tail -n +2; }

TQ="$QUEUE" "$REPO_ROOT/bin/tq-track.sh" t165 > "$T_TMP/open.txt" 2>"$ERR" \
  || { echo "FAIL: tq-track.sh exited non-zero:" >&2; cat "$ERR" >&2; exit 1; }
want=$(printf '%s\n' \
  "  #501 pending [P1] open numeric row" \
  "  #501b in_progress [P1] open string-id row")
got=$(tasks_of "$T_TMP/open.txt")
if [ "$got" != "$want" ]; then
  echo "FAIL: default view must list only open rows (done and completed hidden):" >&2
  printf 'want:\n%s\ngot:\n%s\n' "$want" "$got" >&2; exit 1
fi

TQ="$QUEUE" "$REPO_ROOT/bin/tq-track.sh" t165 --all > "$T_TMP/all.txt" 2>"$ERR" \
  || { echo "FAIL: tq-track.sh --all exited non-zero:" >&2; cat "$ERR" >&2; exit 1; }
n=$(tasks_of "$T_TMP/all.txt" | grep -c '^  #' || true)
[ "$n" = "5" ] || { echo "FAIL: --all must list all 5 track rows, got $n:" >&2; cat "$T_TMP/all.txt" >&2; exit 1; }
for row in "#502 done" "#502b done" "#503 completed"; do
  t_assert_contains "$T_TMP/all.txt" "  $row "
done

echo "T165 PASS"
