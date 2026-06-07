#!/usr/bin/env bash
# T41 — session-cleanup.sh must flip the dispatch-tracker entry out of in_flight
# on every SUCCESS path (#540). Root cause: cleanup_one never touched active.json,
# so a cleaned session stayed status=in_flight; cmd_check (dispatch-tracker.sh:264)
# and the reconciler LIVE/gc_root scans both include in_flight → the reconciler
# then fired false AUTO_HOLD/AUTO_REPORT against an already-gone session.
#
# FIX under test: a TRACKER_SH env seam + `mark-reported <sid>` call before BOTH
# success return-0 paths of cleanup_one (telepty-miss orphan path AND the normal
# kill+close+DELETE path), but NOT on the protected-refusal `return 1`.
#
# HERMETIC: TRACKER_SH → a recorder stub; curl/list stubbed. NO live session.
# TDD: RED before the seam+call exist (mark-reported never invoked).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T41]: $*" >&2; exit 1; }

TRACKER_LOG="$T_TMP/tracker-calls.log"; : > "$TRACKER_LOG"

# Recorder stub for the dispatch-tracker seam: log every invocation's args.
TRACKER_STUB="$STUB_BIN/tracker-stub.sh"
cat > "$TRACKER_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TRACKER_LOG"
exit 0
EOF
chmod +x "$TRACKER_STUB"

# DELETE backup curl stub (offline; record nothing needed here).
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 404
EOF
chmod +x "$STUB_BIN/curl"

# ── A) telepty-miss orphan path → success return 0 → must mark-reported ──
ORPHAN="orphan-sid-T41"
printf '%s' '[{"id":"someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
: > "$TRACKER_LOG"
TRACKER_SH="$TRACKER_STUB" "$BASH_BIN" "$CLEANUP" "$ORPHAN" >/dev/null 2>&1 \
  || fail "A: cleanup exited non-zero on telepty-miss orphan"
grep -qx "mark-reported $ORPHAN" "$TRACKER_LOG" \
  || fail "A: mark-reported NOT invoked on telepty-miss success path. tracker log:
$(cat "$TRACKER_LOG")"

# ── B) normal path (session present in list) → success return 0 → mark-reported ──
PRESENT="present-sid-T41"
printf '%s' "[{\"id\":\"$PRESENT\",\"command\":\"claude\",\"healthStatus\":\"CONNECTED\"}]" > "$STUB_LIST_FILE"
: > "$TRACKER_LOG"
TRACKER_SH="$TRACKER_STUB" "$BASH_BIN" "$CLEANUP" "$PRESENT" >/dev/null 2>&1 \
  || fail "B: cleanup exited non-zero on normal path"
grep -qx "mark-reported $PRESENT" "$TRACKER_LOG" \
  || fail "B: mark-reported NOT invoked on normal success path. tracker log:
$(cat "$TRACKER_LOG")"

# ── C) protected-refusal path (orchestrator without --force) → return 1 → NO call ──
: > "$TRACKER_LOG"
set +e
TRACKER_SH="$TRACKER_STUB" "$BASH_BIN" "$CLEANUP" "orchestrator" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "C: cleanup of protected 'orchestrator' exited 0 (should refuse)"
grep -q "mark-reported" "$TRACKER_LOG" \
  && fail "C: mark-reported invoked on the protected-refusal path (must NOT). tracker log:
$(cat "$TRACKER_LOG")"

echo "T41 PASS"
