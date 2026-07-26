#!/usr/bin/env bash
# T65 — hitl.sh remind: 24h re-notify cadence + immediate retry of failed notifies
# (ADR 2026-07-26 hitl-gate-primitive, failure-modes "orchestrator down"/"stale reminders").
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

export HITL_STATE_DIR="$T_TMP/hitl"
HITL="$REPO_ROOT/bin/hitl.sh"
count_injects() { grep -c 'HITL_GATE' "$STUB_DISPATCH_LOG" || true; }

id=$(RECONCILER_NOW="2026-07-26T04:00:00Z" "$HITL" open \
  --source reconciler --kind decision --question "operator classification for sid-A")
[ "$(count_injects)" = "1" ] || { echo "FAIL: open did not notify once" >&2; exit 1; }

# +1h — well inside the 24h window ⇒ zero re-notifies.
RECONCILER_NOW="2026-07-26T05:00:00Z" "$HITL" remind >/dev/null
if [ "$(count_injects)" != "1" ]; then
  echo "FAIL: remind at +1h re-notified (injects=$(count_injects), want 1)" >&2; exit 1
fi

# +25h — stale ⇒ exactly one re-notify, and last_reminded_at advances.
RECONCILER_NOW="2026-07-27T05:00:00Z" "$HITL" remind >/dev/null
if [ "$(count_injects)" != "2" ]; then
  echo "FAIL: remind at +25h injects=$(count_injects), want 2" >&2; exit 1
fi
lr=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["last_reminded_at"])' \
  "$HITL_STATE_DIR/pending/$id.json")
if [ "$lr" != "2026-07-27T05:00:00Z" ]; then
  echo "FAIL: last_reminded_at = $lr, want 2026-07-27T05:00:00Z" >&2; exit 1
fi
# ...and the same tick repeated is a no-op (one re-notify per gate per day).
RECONCILER_NOW="2026-07-27T05:00:01Z" "$HITL" remind >/dev/null
if [ "$(count_injects)" != "2" ]; then
  echo "FAIL: remind re-fired inside the window (injects=$(count_injects), want 2)" >&2; exit 1
fi

# notify failure ⇒ file still written, notified_at=null, retried on the NEXT tick
# (not after 24h). Orchestrator-down path: gate creation must still succeed.
printf '#!/bin/sh\nexit 1\n' > "$T_TMP/telepty-down"; chmod +x "$T_TMP/telepty-down"
id2=$(TELEPTY="$T_TMP/telepty-down" RECONCILER_NOW="2026-07-27T06:00:00Z" "$HITL" open \
  --source reconciler --kind destructive --question "push feat/740-hitl-cli to origin")
[ -f "$HITL_STATE_DIR/pending/$id2.json" ] || { echo "FAIL: gate not written when notify failed" >&2; exit 1; }
na=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["notified_at"])' \
  "$HITL_STATE_DIR/pending/$id2.json")
if [ "$na" != "None" ]; then
  echo "FAIL: notified_at = $na, want null after notify failure" >&2; exit 1
fi

RECONCILER_NOW="2026-07-27T06:00:30Z" "$HITL" remind >/dev/null
if [ "$(count_injects)" != "3" ]; then
  echo "FAIL: remind did not retry the null-notified gate (injects=$(count_injects), want 3)" >&2; exit 1
fi
t_assert_contains "$STUB_DISPATCH_LOG" "HITL_GATE $id2"
na=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["notified_at"])' \
  "$HITL_STATE_DIR/pending/$id2.json")
if [ "$na" != "2026-07-27T06:00:30Z" ]; then
  echo "FAIL: notified_at after retry = $na" >&2; exit 1
fi

echo "T65 PASS"
