#!/usr/bin/env bash
# T37 — #528: idle_notified:false (worker legitimately still working) is a NOOP
# for the AUTO_HOLD path → the entry falls through to the existing chain. Here the
# screen classifies `active` → _bump_expected fires, NO AUTO_HOLD. Hermetic.
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

PEND="$T_TMP/pending.json"
printf '%s' '{"session_id":"sid-A","source":"orchestrator","inject_id":"uuid-222","idle_notified":false,"awaiting_report":true,"submit_expected":false,"auto_summary":null}' > "$PEND"
export STUB_PENDING_FILE="$PEND"

cp "$HERE/fixtures/active.txt" "$STUB_SCREEN_FILE"
t_seed_entry sid-A "2026-05-12T11:00:00Z" "2026-05-12T11:30:00Z" in_flight "$T_TMP"

t_run_tracker check >/dev/null

# NOOP: no AUTO_HOLD anywhere.
if grep -qF 'AUTO_HOLD' "$DISPATCH_STATE_DIR/auto-reports.log" 2>/dev/null \
   || grep -qF 'AUTO_HOLD' "$DISPATCH_STATE_DIR/alerts.log" 2>/dev/null; then
  echo "FAIL: idle_notified:false must be a NOOP (no AUTO_HOLD)" >&2; exit 1
fi
# existing `active` path still observed: expected_report_by bumped, status unchanged.
t_assert_status sid-A in_flight
got=$(t_field sid-A expected_report_by)
if [ "$got" != "2026-05-12T11:45:00Z" ]; then
  echo "FAIL: expected_report_by = $got, want 2026-05-12T11:45:00Z (active bump)" >&2; exit 1
fi

echo "T37 PASS"
