#!/usr/bin/env bash
# T41 — session-cleanup.sh must take a cleaned session out of the pollers' way on
# every SUCCESS path (#540), and NOTHING more. telepty#60 Stage A: the old call
# was `mark-reported <sid>`, i.e. a session disappearing asserted that its task
# had been reported. Cleanup now sets LIFECYCLE only; the outcome stays unknown.
#
# HERMETIC: real registry component against a temp state dir; curl/list stubbed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T41]: $*" >&2; exit 1; }

# DELETE backup curl stub (offline).
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo 404
EOF
chmod +x "$STUB_BIN/curl"

# ── A) telepty-miss orphan path → success return 0 → lifecycle cleaned ──
ORPHAN="orphan-sid-T41"
t_seed_dispatch "$ORPHAN"
printf '%s' '[{"id":"someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
"$BASH_BIN" "$CLEANUP" "$ORPHAN" >/dev/null 2>&1 \
  || fail "A: cleanup exited non-zero on telepty-miss orphan"
t_assert_lifecycle "$ORPHAN" cleaned
t_assert_observation "$ORPHAN" session_absent_observed
t_assert_outcome_unknown "$ORPHAN"

# ── B) normal path (session present in list) → success return 0 → cleaned ──
PRESENT="present-sid-T41"
t_seed_dispatch "$PRESENT"
printf '%s' "[{\"id\":\"$PRESENT\",\"command\":\"claude\",\"healthStatus\":\"CONNECTED\"}]" > "$STUB_LIST_FILE"
"$BASH_BIN" "$CLEANUP" "$PRESENT" >/dev/null 2>&1 \
  || fail "B: cleanup exited non-zero on normal path"
t_assert_lifecycle "$PRESENT" cleaned
t_assert_outcome_unknown "$PRESENT"

# ── C) protected-refusal path (orchestrator without --force) → return 1 → untouched ──
t_seed_dispatch orchestrator
set +e
"$BASH_BIN" "$CLEANUP" "orchestrator" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "C: cleanup of protected 'orchestrator' exited 0 (should refuse)"
t_assert_lifecycle orchestrator delivery_attempt_started
t_assert_outcome_unknown orchestrator

echo "T41 PASS"
