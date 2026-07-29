#!/usr/bin/env bash
# T10 — the git evidence snapshot is idempotent per (sid, head_sha): a re-run
# adds no second line. Idempotency must NOT come from settling the dispatch —
# it keeps being polled, and that is the point.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

cp "$HERE/fixtures/done_with_tests.txt" "$STUB_SCREEN_FILE"
printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
printf 'aaa1111\tclaude-bot@example.com\tinitial commit\n\x1e' > "$STUB_GIT_LOG_FILE"
printf ' 1 files changed, 5 insertions(+), 1 deletions(-)\n' > "$STUB_GIT_SHORTSTAT_FILE"

t_stub_v2_observations
t_seed_dispatch sid-A cwd="$T_TMP" transport.inject_id=uuid-1 \
  expected_report_by="2026-05-12T11:30:00Z"
mkdir -p "$T_TMP/.git"

t_run_tracker check >/dev/null
first=$(wc -l < "$DISPATCH_STATE_DIR/observations.log")

# Re-arm the deadline so the check loop revisits it — the dispatch is still live
# precisely because nothing settled it.
t_registry set-lifecycle --sid sid-A --expected-report-by "2026-05-12T11:30:00Z" >/dev/null

t_run_tracker check >/dev/null
second=$(wc -l < "$DISPATCH_STATE_DIR/observations.log")
if [ "$first" != "$second" ]; then
  echo "FAIL: evidence snapshot not idempotent (was $first, now $second)" >&2; exit 1
fi
t_assert_outcome_unknown sid-A
echo "T10 PASS"
