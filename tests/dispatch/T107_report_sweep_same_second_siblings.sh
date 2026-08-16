#!/usr/bin/env bash
# T107 — the sibling-drop defect (#904 §1.1), pinned.
#
# The ad-hoc recovery this replaces was a `find -newermt <marker>` watcher that
# exited on the FIRST match. Two refs written inside the same second therefore
# delivered one and lost the other, and the re-armed marker then post-dated the
# survivor forever. One sweep must copy BOTH, and classify each on its own header.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export TELEPTY_SHARED_DIR="$T_TMP/shared"
mkdir -p "$TELEPTY_SHARED_DIR"
INBOX="$DISPATCH_STATE_DIR/inbox"

# The track has to be resolvable from the registry, which is where §4.1 says
# tracks come from — a sid's own prefix, never a hard-coded list.
t_seed_dispatch sw904-sw904-report-sweep

A=aaaaaaaa1111111111111111111111111111111111111111111111111111aaaa
B=bbbbbbbb2222222222222222222222222222222222222222222222222222bbbb
printf '# REPORT — sw904 (#904): the pull side\n\nbody A\n' > "$TELEPTY_SHARED_DIR/$A.md"
printf '# HOLD — sw904: blocked on a decision\n\nbody B\n'   > "$TELEPTY_SHARED_DIR/$B.md"
# Identical mtimes, to the nanosecond: "the same second" is the whole point, and
# leaving it to whatever the filesystem happened to stamp would not test it.
python3 - "$TELEPTY_SHARED_DIR/$A.md" "$TELEPTY_SHARED_DIR/$B.md" <<'PY'
import os, sys, time
t = time.time() - 30
for p in sys.argv[1:]:
    os.utime(p, (t, t))
PY

out="$T_TMP/sweep.out"
t_run_tracker report-sweep > "$out"

n=$(grep -c '^NEW ' "$out" || true)
if [ "$n" != "2" ]; then
  echo "FAIL: expected 2 NEW lines, got $n" >&2; cat "$out" >&2; exit 1
fi
t_assert_contains "$out" "NEW sw904 REPORT "
t_assert_contains "$out" "NEW sw904 HOLD "

copies=$(find "$INBOX" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
if [ "$copies" != "2" ]; then
  echo "FAIL: expected 2 inbox copies, got $copies" >&2; find "$INBOX" >&2; exit 1
fi
# The copy is the evidence, so it must be the bytes — not a summary of them. The
# id in the name is the WHOLE basename, not a prefix of it: see T107b below.
t_assert_contains "$(find "$INBOX" -maxdepth 1 -name "*-$A.md" | head -1)" "body A"
t_assert_contains "$(find "$INBOX" -maxdepth 1 -name "*-$B.md" | head -1)" "body B"

# Never loss: the source is read-only to this sweep.
[ -f "$TELEPTY_SHARED_DIR/$A.md" ] && [ -f "$TELEPTY_SHARED_DIR/$B.md" ] || {
  echo "FAIL: sweep removed a source ref" >&2; exit 1; }

# Both shas are now in the ledger, and the cursor advanced past them.
python3 - "$DISPATCH_STATE_DIR/report-cursor.json" "$A" "$B" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
missing = [s for s in sys.argv[2:] if s not in c["seen"]]
assert not missing, f"cursor.seen is missing {missing}"
assert c["last_mtime_ms"] > 0, "cursor did not advance"
PY

# --- T107b: siblings that share an 8-char prefix ------------------------------
# The first cut of this sweep named the inbox copy after `<sha8>`, the ref's first
# 8 characters. Measured 2026-08-16 against the REAL shared dir: not every ref is
# named for a 64-hex content sha, and four are `rel-874-answer-v101-tag.md`,
# `rel-874-npm-auth-three-paths.md`, `rel-874-publish-auth-report.md`,
# `rel-874-release-workflow-report.md`. All four truncate to `rel-874-`, so all
# four landed on ONE inbox path and three reports were silently overwritten —
# 161 refs in, 160 files out. Same-prefix is the same defect as same-second: two
# distinct reports, one of them lost. The id must be injective in the basename.
printf '# REPORT — sw904: the first of four\n\nprefix body one\n' \
  > "$TELEPTY_SHARED_DIR/rel-874-answer-v101-tag.md"
printf '# REPORT — sw904: the second of four\n\nprefix body two\n' \
  > "$TELEPTY_SHARED_DIR/rel-874-npm-auth-three-paths.md"

t_run_tracker report-sweep > "$T_TMP/prefix.out"

n=$(grep -c '^NEW ' "$T_TMP/prefix.out" || true)
if [ "$n" != "2" ]; then
  echo "FAIL: expected 2 NEW lines for the prefix-sharing pair, got $n" >&2
  cat "$T_TMP/prefix.out" >&2; exit 1
fi
copies=$(find "$INBOX" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
if [ "$copies" != "4" ]; then
  echo "FAIL: prefix-sharing refs collided — expected 4 inbox copies, got $copies" >&2
  find "$INBOX" -maxdepth 1 -name '*.md' >&2; exit 1
fi
# Both bodies survive, which is the assertion the path-collision destroyed.
grep -Rql 'prefix body one' "$INBOX" || { echo "FAIL: first of the pair lost" >&2; exit 1; }
grep -Rql 'prefix body two' "$INBOX" || { echo "FAIL: second of the pair lost" >&2; exit 1; }

echo "T107 PASS"
