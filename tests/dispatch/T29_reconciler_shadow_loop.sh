#!/usr/bin/env bash
# T29 — session-reconciler --shadow writes probe+policy decisions and does not act.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

FIX="$REPO_ROOT/tests/fixtures/session-state"
cp "$FIX/working-spinner.screen" "$STUB_SCREEN_FILE"
cp "$FIX/claude-connected.info" "$STUB_INFO_FILE"
t_seed_entry sid-A "2026-06-06T11:00:00Z" "2026-06-06T11:30:00Z" in_flight ""

CLEANUP_LOG="$T_TMP/cleanup.log"; : > "$CLEANUP_LOG"
CLEANUP_STUB="$T_TMP/cleanup-stub.sh"
cat > "$CLEANUP_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CLEANUP_LOG"
exit 0
EOF
chmod +x "$CLEANUP_STUB"

SCHED_LOG="$T_TMP/scheduler.log"; : > "$SCHED_LOG"
SCHED_STUB="$T_TMP/scheduler-stub.sh"
cat > "$SCHED_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$SCHED_LOG"
exit 0
EOF
chmod +x "$SCHED_STUB"

SHADOW_LOG="$T_TMP/reconcile-shadow.jsonl"
RECONCILE_SHADOW_LOG="$SHADOW_LOG" \
DISPATCH_STATE_DIR="$DISPATCH_STATE_DIR" \
TELEPTY="$STUB_BIN/telepty" \
CLEANUP_SH="$CLEANUP_STUB" \
SCHEDULER_SH="$SCHED_STUB" \
  "$REPO_ROOT/bin/session-reconciler.sh" --shadow >/dev/null

[ -s "$SHADOW_LOG" ] || { echo "FAIL: shadow log was not written" >&2; exit 1; }
[ ! -s "$CLEANUP_LOG" ] || { echo "FAIL: --shadow invoked cleanup" >&2; cat "$CLEANUP_LOG" >&2; exit 1; }
[ ! -s "$SCHED_LOG" ] || { echo "FAIL: --shadow invoked scheduler" >&2; cat "$SCHED_LOG" >&2; exit 1; }

python3 - "$SHADOW_LOG" <<'PY'
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
if len(rows) != 1:
    raise SystemExit(f"FAIL: shadow rows={len(rows)}, want 1")
row = rows[0]
checks = {
    "sid": "sid-A",
    "status": "in_flight",
}
for key, want in checks.items():
    got = row.get(key)
    if got != want:
        raise SystemExit(f"FAIL: {key}={got!r}, want {want!r}")
if row["state"].get("surface") != "working":
    raise SystemExit(f"FAIL: surface={row['state'].get('surface')!r}, want 'working'")
if row["action"].get("action") != "NOOP":
    raise SystemExit(f"FAIL: action={row['action'].get('action')!r}, want 'NOOP'")
PY

echo "T29 PASS"
