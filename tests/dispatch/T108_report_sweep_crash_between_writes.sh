#!/usr/bin/env bash
# T108 — the write-order rule (#904 §3): inbox first, cursor second.
#
# A crash between the two writes must RE-EMIT, never lose. The re-emit is only
# safe because the inbox path is a function of the ref's sha and mtime, so the
# second sweep rewrites the same path with the same bytes: exactly one copy
# survives, no matter how many times the sweep is interrupted.
#
# The crash is simulated by deleting the cursor after a successful sweep, which
# is the state a crash between step 1 and step 3 leaves behind.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export TELEPTY_SHARED_DIR="$T_TMP/shared"
mkdir -p "$TELEPTY_SHARED_DIR"
INBOX="$DISPATCH_STATE_DIR/inbox"
CURSOR="$DISPATCH_STATE_DIR/report-cursor.json"

t_seed_dispatch sw904-sw904-report-sweep
SHA=cccccccc3333333333333333333333333333333333333333333333333333cccc
printf '# REPORT — sw904: one report, delivered once\n\nthe body\n' > "$TELEPTY_SHARED_DIR/$SHA.md"
python3 -c 'import os,sys,time; t=time.time()-30; os.utime(sys.argv[1],(t,t))' \
  "$TELEPTY_SHARED_DIR/$SHA.md"

t_run_tracker report-sweep > "$T_TMP/first.out"
[ -f "$CURSOR" ] || { echo "FAIL: no cursor after the first sweep" >&2; exit 1; }
first=$(find "$INBOX" -type f -name '*.md' | wc -l | tr -d ' ')
dest=$(find "$INBOX" -type f -name '*.md' | head -1)
if [ "$first" != "1" ]; then
  echo "FAIL: expected 1 inbox copy, got $first" >&2; exit 1
fi

# --- the crash: the inbox copy landed, the cursor never did -------------------
rm -f "$CURSOR"

t_run_tracker report-sweep > "$T_TMP/second.out"

second=$(find "$INBOX" -type f -name '*.md' | wc -l | tr -d ' ')
if [ "$second" != "$first" ]; then
  echo "FAIL: re-emit duplicated the inbox (was $first, now $second)" >&2
  find "$INBOX" -type f >&2; exit 1
fi
# Same path, same bytes — the copy is idempotent by sha, not merely non-duplicated.
now=$(find "$INBOX" -type f -name '*.md' | head -1)
if [ "$now" != "$dest" ]; then
  echo "FAIL: re-emit chose a different path ($dest -> $now)" >&2; exit 1
fi
t_assert_contains "$now" "the body"
# Re-emit is the CONTRACT, not a defect: an interrupted sweep re-announces rather
# than going quiet, because a silent second sweep is how the report gets lost.
t_assert_contains "$T_TMP/second.out" "NEW sw904 REPORT "

# And the recovered cursor closes the window: a third sweep is a no-op.
t_run_tracker report-sweep > "$T_TMP/third.out"
if grep -q '^NEW ' "$T_TMP/third.out"; then
  echo "FAIL: third sweep re-emitted with a healthy cursor" >&2
  cat "$T_TMP/third.out" >&2; exit 1
fi

echo "T108 PASS"
