#!/usr/bin/env bash
# T51 — #574: when --verify-delivered reports a (false-negative) failure AFTER the
#        inject has already landed, the dispatch record must still exist (so a
#        started session is never invisible) AND dispatch.sh must still exit 5
#        (DELIVERY_FAILED) for callers that depend on the signal.
#
# telepty#60 Stage A makes this structural rather than best-effort: the record is
# committed BEFORE the bytes are handed over, so no post-delivery verdict can
# decide whether it exists.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

# Screen shows the placeholder still present after inject → verify_delivered fails.
# (postinject_fail.txt also carries the `❯ Try "..."` prompt so is_ready passes.)
cp "$HERE/fixtures/postinject_fail.txt" "$STUB_SCREEN_FILE"

# Avoid verify_delivered's real 5s sleep in the full-main flow.
cat > "$STUB_BIN/sleep" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$STUB_BIN/sleep"

# Stub session-probe so wait_for_ready is satisfied immediately.
PROBE="$T_TMP/session-probe"
cat > "$PROBE" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"ready":true}'
SH
chmod +x "$PROBE"

# Fake open-session.sh: spawn succeeds without touching real sessions.
FAKE_OPEN_SESSION="$T_TMP/fake-open-session.sh"
cat > "$FAKE_OPEN_SESSION" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKE_OPEN_SESSION"

printf '%s' '[{"id":"t51-fn","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"

ref="$T_TMP/ref.md"
printf 'a unique-line that will NOT appear on screen\n' > "$ref"

set +e
HOME="$T_TMP/home" \
AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions" \
OPEN_SESSION_SH="$FAKE_OPEN_SESSION" \
SESSION_PROBE_PY="$PROBE" \
TELEPTY="$STUB_BIN/telepty" \
  "$REPO_ROOT/bin/dispatch.sh" --spawn-and-dispatch \
    --track t51 --name fn --cwd "$T_TMP/cwd" --cli claude \
    --from t51-test --ref "$ref" --timeout-ms 800 \
    --verify-delivered --no-verify-started --no-task "test-fixture T51" \
    >/dev/null 2>&1
rc=$?
set -e

# (a) exit code 5 (DELIVERY_FAILED) preserved.
[ "$rc" -eq 5 ] || { echo "FAIL: want exit 5 (DELIVERY_FAILED), got $rc" >&2; exit 1; }

# (b) the dispatch record survives the verify-FN, with its outcome still unknown.
t_assert_lifecycle t51-fn delivery_attempt_started
t_assert_outcome_unknown t51-fn
t_assert_v2 t51-fn transport.result write_observed

python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rows = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "t51-fn"]
assert len(rows) == 1, f"FAIL: want 1 t51-fn record, got {len(rows)}"
assert rows[0].get("track") == "t51", f"FAIL: track={rows[0].get('track')!r}"
PY

echo "T51 PASS"
