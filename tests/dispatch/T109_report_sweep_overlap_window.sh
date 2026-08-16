#!/usr/bin/env bash
# T109 — the two halves of the cursor (#904 §3), which do different jobs and are
# easy to conflate:
#
#   A. `last_mtime_ms - 5min` bounds the SCAN. A ref older than that is never
#      looked at again — that is what keeps a sweep O(recent) instead of
#      O(everything ever reported).
#   B. `seen` bounds the EMIT. A ref inside the overlap window IS re-scanned every
#      sweep, and is silent only because its sha is in the ledger. The 5min slack
#      exists for clock skew and same-second arrivals; without `seen` it would
#      re-deliver every ref five minutes running.
#
# Part B ends by proving the negative: drop the sha from `seen` and the very same
# file re-emits, so the silence in the first half was the ledger's doing and not
# the file being invisible.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export TELEPTY_SHARED_DIR="$T_TMP/shared"
mkdir -p "$TELEPTY_SHARED_DIR"
CURSOR="$DISPATCH_STATE_DIR/report-cursor.json"
t_seed_dispatch sw904-sw904-report-sweep

OLD=dddddddd4444444444444444444444444444444444444444444444444444dddd
NEAR=eeeeeeee5555555555555555555555555555555555555555555555555555eeee
printf '# REPORT — sw904: settled long ago\n' > "$TELEPTY_SHARED_DIR/$OLD.md"
printf '# REPORT — sw904: just inside the window\n' > "$TELEPTY_SHARED_DIR/$NEAR.md"

# OLD sits 10min behind the cursor (outside the 5min overlap); NEAR sits 1min
# behind it (inside). The cursor is authored directly so the window is exact
# rather than inferred from whatever the clock did during a previous sweep.
python3 - "$TELEPTY_SHARED_DIR/$OLD.md" "$TELEPTY_SHARED_DIR/$NEAR.md" "$CURSOR" "$NEAR" <<'PY'
import json, os, sys, time
old_f, near_f, cursor, near_sha = sys.argv[1:5]
now = time.time()
os.utime(old_f,  (now - 600, now - 600))
os.utime(near_f, (now - 60,  now - 60))
json.dump({"last_mtime_ms": int(now * 1000),
           "seen": {near_sha: int((now - 60) * 1000)}},
          open(cursor, "w"))
PY

# --- A + B: neither emits, for two different reasons --------------------------
t_run_tracker report-sweep > "$T_TMP/a.out"
if grep -q '^NEW ' "$T_TMP/a.out"; then
  echo "FAIL: a ref outside the window or already in seen was re-emitted" >&2
  cat "$T_TMP/a.out" >&2; exit 1
fi
if [ -d "$DISPATCH_STATE_DIR/inbox" ] && [ -n "$(find "$DISPATCH_STATE_DIR/inbox" -type f -name '*.md')" ]; then
  echo "FAIL: inbox is not empty" >&2; find "$DISPATCH_STATE_DIR/inbox" -type f >&2; exit 1
fi

# The pruned ledger must still hold NEAR — dropping it would re-deliver NEAR on
# the next tick, which is the bug this half exists to prevent.
python3 - "$CURSOR" "$NEAR" "$OLD" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
assert sys.argv[2] in c["seen"], "seen dropped the in-window sha; it would re-emit"
assert sys.argv[3] not in c["seen"], "an out-of-window ref entered the ledger"
PY

# --- B, negative control: same file, same mtime, sha removed from `seen` ------
python3 - "$CURSOR" "$NEAR" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c["seen"].pop(sys.argv[2], None)
json.dump(c, open(sys.argv[1], "w"))
PY

t_run_tracker report-sweep > "$T_TMP/b.out"
t_assert_contains "$T_TMP/b.out" "NEW sw904 REPORT "
n=$(grep -c '^NEW ' "$T_TMP/b.out" || true)
if [ "$n" != "1" ]; then
  echo "FAIL: expected exactly the in-window ref to re-emit, got $n" >&2
  cat "$T_TMP/b.out" >&2; exit 1
fi
# OLD is still out of scan range, so it must NOT have come back with it.
if grep -q "${OLD:0:8}" "$T_TMP/b.out"; then
  echo "FAIL: the out-of-window ref re-emitted" >&2; cat "$T_TMP/b.out" >&2; exit 1
fi

echo "T109 PASS"
