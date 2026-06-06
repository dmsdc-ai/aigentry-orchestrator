#!/usr/bin/env bash
# T38 — #528: curl failure (daemon down) is best-effort — the poll is skipped and
# logged, and the tick CONTINUES through the existing chain (matches the
# reconciler's best-effort posture). No AUTO_HOLD; the check exits cleanly.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
[ "${STUB_CURL_FAIL:-0}" = "1" ] && exit 7
for a in "$@"; do [ "$a" = "DELETE" ] && exit 0; done
cat "${STUB_PENDING_FILE:-/dev/null}"
printf '\n%s' "${STUB_PENDING_HTTP:-200}"
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"
export STUB_CURL_FAIL=1            # simulate daemon down

cp "$HERE/fixtures/active.txt" "$STUB_SCREEN_FILE"
t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"

out=$(t_run_tracker check)        # must NOT crash the tick

# skip+log to disconnected.log, no AUTO_HOLD, tick completes.
t_assert_contains "$DISPATCH_STATE_DIR/disconnected.log" 'PENDING_POLL_SKIP sid=sid-A'
if grep -qF 'AUTO_HOLD' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null; then
  echo "FAIL: curl fail must not produce AUTO_HOLD" >&2; exit 1
fi
case "$out" in
  *"tracker check: 1 entries processed"*) ;;
  *) echo "FAIL: tick did not complete cleanly: $out" >&2; exit 1;;
esac
# fell through to existing `active` path.
t_assert_status sid-A in_flight

echo "T38 PASS"
