#!/usr/bin/env bash
# T81 — the D3 safety proof. Stage A's tracker lands BEFORE the telepty half, so it
# runs for a whole maintenance window against a 0.7.1 daemon that has no
# /api/inject-observations endpoint and never surfaces a transport inject_id.
# That interim must resolve to honest absence, not to something false. Every one of
# the four legacy shapes must produce: a NAMED tracking_unavailable observation, a
# HOLD, continued polling, no lifecycle or outcome move, and no DELETE.
#
# design §8.3.2 (missing tracking is explicit) + §8.5.4 (unknown → HOLD/poll,
# never DELETE, no screen/git fallthrough).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

CURL_LOG="$T_TMP/curl.log"
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
[ "${STUB_CURL_FAIL:-0}" = "1" ] && exit 7
for a in "$@"; do [ "$a" = "DELETE" ] && exit 0; done
cat "${STUB_BODY_FILE:-/dev/null}"
printf '\n%s' "${STUB_HTTP:-200}"
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl" CURL_LOG

# A worker that would look "done" to every legacy heuristic: prompt on screen and
# a fresh authored commit. Neither may settle anything.
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"
mkdir -p "$T_TMP/repo/.git"

assert_reason() {
  local sid="$1" want="$2"
  python3 - "$DISPATCH_STATE_DIR/active.json" "$sid" "$want" <<'PY'
import json, sys
path, sid, want = sys.argv[1:4]
doc = json.load(open(path, encoding="utf-8"))
for rec in doc.get("dispatches", []):
    if rec.get("assigned", {}).get("sid") != sid:
        continue
    hits = [o for o in rec.get("observations", []) if o.get("kind") == "tracking_unavailable"]
    assert hits, f"FAIL: no tracking_unavailable observation; got {[o.get('kind') for o in rec.get('observations', [])]}"
    reasons = [o.get("reason") for o in hits]
    assert want in reasons, f"FAIL: tracking_unavailable reasons {reasons}, want {want!r}"
    for obs in rec.get("observations", []):
        assert obs.get("terminal") is not True, f"FAIL: terminal observation {obs.get('kind')!r}"
    sys.exit(0)
raise SystemExit(f"FAIL: no record for {sid}")
PY
}

run_arm() {
  local name="$1" reason="$2"; shift 2
  t_init_v2
  : > "$CURL_LOG"; : > "$DISPATCH_STATE_DIR/alerts.log"
  t_seed_dispatch sid-A cwd="$T_TMP/repo" expected_report_by="2026-05-12T11:30:00Z" "$@"

  TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null

  assert_reason sid-A "$reason"
  # nothing moved.
  t_assert_outcome_unknown sid-A
  t_assert_lifecycle sid-A delivery_attempt_started
  # a HOLD was surfaced to the file logs (the inject channel is the one that fails).
  t_assert_contains "$DISPATCH_STATE_DIR/alerts.log" "HOLD sid=sid-A"
  # no terminal inference from the prompt/commit fallthrough.
  t_refute_observation sid-A worktree_activity_observed
  # and no DELETE of anything, ever.
  if grep -q DELETE "$CURL_LOG"; then
    echo "FAIL($name): tracker issued a DELETE" >&2; cat "$CURL_LOG" >&2; exit 1
  fi

  # polling continues: a second tick polls again and still does not settle.
  local polls_before polls_after
  polls_before=$(wc -l < "$CURL_LOG" | tr -d ' ')
  TRACKER_NOW="2026-05-12T13:00:00Z" t_run_tracker check >/dev/null
  polls_after=$(wc -l < "$CURL_LOG" | tr -d ' ')
  if [ "$name" != "null_inject_id" ] && [ "$polls_after" -le "$polls_before" ]; then
    echo "FAIL($name): polling stopped after an unavailable result ($polls_before → $polls_after)" >&2; exit 1
  fi
  t_assert_outcome_unknown sid-A
  t_assert_lifecycle sid-A delivery_attempt_started
}

# (1) 0.7.1 never gives the orchestrator a transport inject_id at all.
export STUB_HTTP=200 STUB_BODY_FILE=/dev/null STUB_CURL_FAIL=0
run_arm null_inject_id no_transport_inject_id transport.inject_id=null
[ ! -s "$CURL_LOG" ] || { echo "FAIL: polled with no inject_id to poll for" >&2; exit 1; }

# (2) the endpoint does not exist on a 0.7.1 daemon.
export STUB_HTTP=404
run_arm endpoint_404 observation_endpoint_absent transport.inject_id=uuid-111

# (3) a legacy pendingReports body — accepted-looking, and 100% unusable. It must
#     NOT be read as evidence; idle_notified is exactly the false authority Stage A
#     removes.
LEGACY="$T_TMP/legacy-pending.json"
printf '%s' '{"session_id":"sid-A","source":"orchestrator","inject_id":"uuid-111","idle_notified":true,"idle_at":"2026-05-12T11:45:00Z","awaiting_report":true,"auto_summary":"looks done"}' > "$LEGACY"
export STUB_HTTP=200 STUB_BODY_FILE="$LEGACY"
run_arm legacy_body unknown_observation_schema transport.inject_id=uuid-111

# (4) daemon down / curl failure.
export STUB_CURL_FAIL=1
run_arm curl_failed observation_poll_failed transport.inject_id=uuid-111

echo "T81 PASS"
