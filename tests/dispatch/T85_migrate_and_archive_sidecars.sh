#!/usr/bin/env bash
# T85 — telepty#60 Stage A §"deployment" step 2: the cutover converts the legacy
# root-array registry into ONE schema-v2 generation under the same durable
# transaction, preserves the original bytes, and promotes nothing. Every legacy
# record — including one whose status claimed the task was reported — becomes
# outcome unknown / reported_value null. The dedup sidecars are archived, not
# imported as delivery facts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

LEGACY="$HERE/fixtures/legacy-active-v1.json"
cp "$LEGACY" "$DISPATCH_STATE_DIR/active.json"
legacy_sha=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$LEGACY")

SIDECARS="$T_TMP/dispatch-helper"
mkdir -p "$SIDECARS"
printf 'hash-live\n' > "$SIDECARS/live-worker"
printf 'hash-done\n' > "$SIDECARS/claimed-done"

t_registry migrate --now "2026-07-30T00:00:00Z" >/dev/null

# (1) one v2 generation, every record quarantined and unknown.
python3 - "$DISPATCH_STATE_DIR/active.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1], encoding="utf-8"))
assert doc["schema_version"] == 2, f"schema_version={doc['schema_version']!r}"
recs = {r["assigned"]["sid"]: r for r in doc["dispatches"]}
assert set(recs) == {"live-worker", "retried-worker", "claimed-done"}, f"sids={sorted(recs)}"
for sid, rec in recs.items():
    assert rec["outcome"]["state"] == "unknown", f"{sid}: outcome.state={rec['outcome']['state']!r}"
    assert rec["outcome"]["reported_value"] is None, f"{sid}: reported_value promoted"
    assert rec["dedup"]["ref_hash"], f"{sid}: dedup.ref_hash lost"
    assert rec["dedup"]["key"], f"{sid}: dedup.key missing"
    assert rec["dispatch_id"], f"{sid}: no dispatch_id"
    kinds = [o["kind"] for o in rec["observations"]]
    assert "legacy_status_observed" in kinds, f"{sid}: legacy status not audited ({kinds})"

# live dispatches are quarantined, not resumed.
for sid in ("live-worker", "retried-worker"):
    assert recs[sid]["lifecycle"]["state"] == "cutover_quarantine", \
        f"{sid}: lifecycle={recs[sid]['lifecycle']['state']!r}"
# a legacy terminal claim is retired, never carried across as an outcome.
assert recs["claimed-done"]["lifecycle"]["state"] == "cutover_retired", \
    f"claimed-done: lifecycle={recs['claimed-done']['lifecycle']['state']!r}"
legacy = [o for o in recs["claimed-done"]["observations"] if o["kind"] == "legacy_status_observed"][0]
assert legacy["legacy_status"] == "auto_reported", f"legacy_status={legacy.get('legacy_status')!r}"

# metadata and timestamps survive the migration.
live = recs["live-worker"]
assert live["cwd"] == "/tmp/live" and live["track"] == "L1" and live["role"] == "coder"
assert live["worktree"] == "/tmp/live-wt" and live["branch"] == "feat/live"
assert live["dispatched_at"] == "2026-07-29T10:00:00Z"
assert live["ref_path"] == "/tmp/live.md"
assert recs["retried-worker"]["re_dispatch_count"] == 1
assert recs["retried-worker"]["keep_alive"] is True
PY

# (2) the original bytes are preserved for diagnosis.
bak="$DISPATCH_STATE_DIR/active.json.legacy-v1.bak"
[ -f "$bak" ] || { echo "FAIL: legacy bytes were not preserved" >&2; exit 1; }
bak_sha=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$bak")
[ "$bak_sha" = "$legacy_sha" ] || { echo "FAIL: preserved bytes differ from the original" >&2; exit 1; }

# (3) migrating twice is fail-closed, not a silent re-quarantine.
set +e
out=$(t_registry migrate --now "2026-07-30T00:05:00Z" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "FAIL: a second migrate succeeded: $out" >&2; exit 1; }
case "$out" in *already_schema_v2*) ;; *) echo "FAIL: unnamed double-migration error: $out" >&2; exit 1;; esac

# (4) sidecars are archived, and the live directory is gone.
t_registry archive-sidecars --dir "$SIDECARS" >/dev/null
[ ! -d "$SIDECARS" ] || { echo "FAIL: sidecar directory still live after archival" >&2; exit 1; }
[ -f "$SIDECARS.archived/live-worker" ] || { echo "FAIL: sidecars were deleted instead of archived" >&2; exit 1; }

echo "T85 PASS"
