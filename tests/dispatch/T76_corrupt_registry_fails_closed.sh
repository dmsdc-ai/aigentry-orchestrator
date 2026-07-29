#!/usr/bin/env bash
# T76 — telepty#60 Stage A §3-item-5 / §8.3.7: corruption is fail-CLOSED. A reader
# or writer that meets malformed JSON, a wrong schema version or a duplicate
# dispatch_id must preserve the bytes for diagnosis, emit a health alert OUTSIDE
# the corrupt file, and perform no delivery, mutation, pruning or cleanup.
# Today every consumer does `except Exception: entries = []`, so the first writer
# to run silently replaces the operator's damaged state with an empty registry.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

ref="$T_TMP/ref.md"; printf 'payload\n' > "$ref"
HEALTH="$DISPATCH_STATE_DIR/registry-health.log"

check_arm() {
  local name="$1" bytes="$2"
  printf '%s' "$bytes" > "$DISPATCH_STATE_DIR/active.json"
  local before after
  before=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$DISPATCH_STATE_DIR/active.json")
  : > "$STUB_DISPATCH_LOG"; : > "$HEALTH"

  set +e
  local out rc
  out=$(t_run_dispatch --target sid-A --ref "$ref" --no-verify-started \
    --no-task "test-fixture T76 $name" 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || { echo "FAIL($name): dispatch succeeded on a corrupt registry" >&2; echo "$out" >&2; exit 1; }
  case "$out" in *registry_corrupt*|*registry_unavailable*) ;;
    *) echo "FAIL($name): no named corruption result: $out" >&2; exit 1;; esac
  if grep -q inject "$STUB_DISPATCH_LOG"; then
    echo "FAIL($name): telepty was called with a corrupt registry" >&2; exit 1
  fi

  # every other consumer must also decline to touch it.
  TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker check >/dev/null 2>&1 || true
  TRACKER_NOW="2026-05-12T12:00:00Z" t_run_tracker prune >/dev/null 2>&1 || true
  "$REPO_ROOT/bin/dispatch-cleanup-scheduler.sh" tick >/dev/null 2>&1 || true

  after=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$DISPATCH_STATE_DIR/active.json")
  [ "$before" = "$after" ] || {
    echo "FAIL($name): corrupt bytes were rewritten (sha $before → $after)" >&2
    cat "$DISPATCH_STATE_DIR/active.json" >&2; exit 1; }
  [ -s "$HEALTH" ] || { echo "FAIL($name): no health alert outside the corrupt file" >&2; exit 1; }
}

check_arm malformed '{"schema_version": 2, "dispatches": [{"dispatch'
check_arm wrong_schema '{"schema_version": 1, "generation": 0, "dispatches": []}'
check_arm root_array '[{"sid": "sid-A", "status": "in_flight"}]'
check_arm duplicate_id '{"schema_version": 2, "generation": 1, "dispatches": [
  {"dispatch_id": "d1", "assigned": {"sid": "a", "session_epoch": null}, "dedup": {"key": "k1", "ref_hash": "h"},
   "outcome": {"state": "unknown", "reported_value": null, "basis": null}, "lifecycle": {"state": "delivery_attempt_started"}},
  {"dispatch_id": "d1", "assigned": {"sid": "b", "session_epoch": null}, "dedup": {"key": "k2", "ref_hash": "h"},
   "outcome": {"state": "unknown", "reported_value": null, "basis": null}, "lifecycle": {"state": "delivery_attempt_started"}}]}'

echo "T76 PASS"
