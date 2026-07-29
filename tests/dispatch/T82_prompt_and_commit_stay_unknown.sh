#!/usr/bin/env bash
# T82 — telepty#60 Stage A §3-item-9 / §8.5.6 / §8.5.8. The two strongest legacy
# "completion" inferences — a prompt glyph on screen and an attributable new commit
# — become observations and nothing more. session-probe.py reports prompt_observed
# instead of "done"; the tracker records a nonterminal review snapshot; the outcome
# fields are untouched; and the dispatch keeps being polled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_init_v2

# (1) the probe no longer has a completion-like class at all.
cls=$(TELEPTY="$STUB_BIN/telepty" python3 "$REPO_ROOT/bin/session-probe.py" \
  --sid sid-A --screen-file "$HERE/fixtures/done.txt" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["detail"]["tracker_class"])')
[ "$cls" = "prompt_observed" ] || {
  echo "FAIL: tracker_class=$cls, want prompt_observed" >&2; exit 1; }

# (2) prompt + attributable commit + a healthy schema-v2 observation body.
cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 3 files changed, 120 insertions(+), 10 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"
mkdir -p "$T_TMP/repo/.git"

BODY="$T_TMP/observation.json"
printf '%s' '{"type":"task_completion_unknown","schema_version":2,"session_id":"sid-A","inject_id":"uuid-111","completion_fact":null,"terminal":false,"observation":{"kind":"pty_quiet","trigger":"silence_timeout","elapsed_ms":5000},"consumption":{"status":"not_established"},"capability":{"turn_boundary":"unavailable","outcome_protocol":"unavailable"}}' > "$BODY"
cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T_TMP/curl.log"
cat "$BODY"
printf '\n200'
EOF
chmod +x "$STUB_BIN/curl"
export CURL="$STUB_BIN/curl"

t_seed_dispatch sid-A cwd="$T_TMP/repo" transport.inject_id=uuid-111 \
  expected_report_by="2026-05-12T11:30:00Z"

TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null

# the daemon's observation is recorded verbatim, as an observation.
t_assert_observation sid-A pty_quiet
# git evidence is a review snapshot, never an outcome.
t_assert_observation sid-A worktree_activity_observed
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
rec = [r for r in doc["dispatches"] if r["assigned"]["sid"] == "sid-A"][0]
snap = [o for o in rec["observations"] if o["kind"] == "worktree_activity_observed"][0]
assert snap.get("review_required") is True, f"FAIL: review_required={snap.get('review_required')!r}"
assert snap.get("terminal") is False, "FAIL: evidence snapshot marked terminal"
assert snap.get("head_sha"), "FAIL: snapshot has no head_sha to review"
PY

# nothing settled, and the dispatch is still live for the next poll.
t_assert_outcome_unknown sid-A
t_assert_lifecycle sid-A delivery_attempt_started

# the terminal vocabulary is gone from the emitted artefacts too.
for f in "$DISPATCH_STATE_DIR/alerts.log" "$DISPATCH_STATE_DIR/observations.log"; do
  [ -f "$f" ] || continue
  if grep -q "AUTO_REPORT" "$f"; then
    echo "FAIL: AUTO_REPORT emitted into $f" >&2; cat "$f" >&2; exit 1
  fi
done

echo "T82 PASS"
