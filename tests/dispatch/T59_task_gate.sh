#!/usr/bin/env bash
# T59 — #736: Rule 34 task-gate. Dispatch must be impossible without a task that
#       is registered in state/task-queue.json (or an audited --no-task exemption).
#       Covers: gate rejection paths (before any side effect), auto-ledger on
#       success, exemption telemetry, and AIGENTRY_TASK_GATE=warn|off modes.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

PROBE="$T_TMP/session-probe"
cat > "$PROBE" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"ready":true}'
SH
chmod +x "$PROBE"

QUEUE="$T_TMP/task-queue.json"
seed_queue() {
  python3 - "$QUEUE" <<'PY'
import json, sys
data = {
 "main_topics": ["t59"],
 "tasks": [
  {"id": 100, "desc": "pending one", "priority": "P1", "status": "pending", "note": "seed"},
  {"id": 101, "desc": "in flight",   "priority": "P1", "status": "in_progress", "note": "seed"},
  {"id": 102, "desc": "finished",    "priority": "P2", "status": "done", "note": "seed"},
  {"id": "q-1", "desc": "queued one", "priority": "P2", "status": "queued"},
 ],
 "schema_version": 2,
}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=1))
PY
}

# Runs dispatch.sh --target in a hermetic env; echoes exit code, stderr in $ERR.
ERR="$T_TMP/err.txt"
run_dispatch() {
  local sid="$1"; shift
  printf '%s' "[{\"id\":\"$sid\",\"command\":\"claude\",\"healthStatus\":\"CONNECTED\"}]" > "$STUB_LIST_FILE"
  local ref="$T_TMP/ref-$sid.md"
  printf 'T59 ref for %s\n' "$sid" > "$ref"
  : > "$STUB_DISPATCH_LOG"
  set +e
  HOME="$T_TMP/home" \
  AIGENTRY_TASK_QUEUE="$QUEUE" \
  SESSION_PROBE_PY="$PROBE" \
  TELEPTY="$STUB_BIN/telepty" \
    "$REPO_ROOT/bin/dispatch.sh" --target "$sid" --ref "$ref" --from t59-test \
      --timeout-ms 800 --no-verify-started "$@" \
      >/dev/null 2>"$ERR"
  local rc=$?
  set -e
  printf '%s' "$rc"
}

t_assert_no_inject() {
  if [ -s "$STUB_DISPATCH_LOG" ]; then
    echo "FAIL: $1 — inject side effect leaked:" >&2; cat "$STUB_DISPATCH_LOG" >&2; exit 1
  fi
}

t_assert_injected() {
  t_assert_contains "$STUB_DISPATCH_LOG" "telepty inject"
}

# --- (a) no --task / --no-task in hard mode → reject before any side effect ---
seed_queue
rc=$(run_dispatch t59-a)
[ "$rc" != "0" ] || { echo "FAIL(a): want non-zero exit without --task, got 0" >&2; exit 1; }
t_assert_contains "$ERR" "Rule 34"
t_assert_contains "$ERR" "--no-task"
t_assert_no_inject "(a)"

# --- (b) unknown task id → rejected distinctly ---
rc=$(run_dispatch t59-b --task 999)
[ "$rc" != "0" ] || { echo "FAIL(b): want non-zero exit for unknown id, got 0" >&2; exit 1; }
t_assert_contains "$ERR" "unknown task id"
t_assert_contains "$ERR" "Rule 34"
t_assert_no_inject "(b)"

# --- (d) done task → rejected with a distinct stale-id message ---
rc=$(run_dispatch t59-d --task 102)
[ "$rc" != "0" ] || { echo "FAIL(d): want non-zero exit for done task, got 0" >&2; exit 1; }
t_assert_contains "$ERR" "stale-id"
if grep -qF "unknown task id" "$ERR"; then
  echo "FAIL(d): done-task rejection must differ from unknown-id rejection" >&2; exit 1
fi
t_assert_no_inject "(d)"

# --- (c) valid pending id + successful dispatch → auto-ledger to delegated ---
rc=$(run_dispatch t59-c --task 100 --track tg59)
[ "$rc" = "0" ] || { echo "FAIL(c): want exit 0, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_injected
python3 - "$QUEUE" <<'PY'
import datetime, json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
t = [x for x in data["tasks"] if x["id"] == 100][0]
assert t["status"] == "delegated", f"FAIL(c): status={t['status']!r}, want 'delegated'"
today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
assert t.get("updated_at") == today, f"FAIL(c): updated_at={t.get('updated_at')!r}, want {today}"
note = t.get("note", "")
assert note.startswith("seed | dispatched "), f"FAIL(c): note not appended: {note!r}"
for needle in ("sid=t59-c", "ref=ref-t59-c.md", "track=tg59"):
    assert needle in note, f"FAIL(c): note missing {needle}: {note!r}"
# untouched rows keep their shape; queue stays parseable + key order preserved
assert list(data.keys()) == ["main_topics", "tasks", "schema_version"], f"FAIL(c): keys reordered: {list(data)}"
assert [x for x in data["tasks"] if x["id"] == 102][0]["status"] == "done", "FAIL(c): sibling task mutated"
PY

# --- (c2) in_progress must NOT be downgraded, but still gets the dispatch note ---
rc=$(run_dispatch t59-c2 --task 101)
[ "$rc" = "0" ] || { echo "FAIL(c2): want exit 0, got $rc" >&2; cat "$ERR" >&2; exit 1; }
python3 - "$QUEUE" <<'PY'
import json, sys
t = [x for x in json.load(open(sys.argv[1], encoding="utf-8"))["tasks"] if x["id"] == 101][0]
assert t["status"] == "in_progress", f"FAIL(c2): in_progress downgraded to {t['status']!r}"
assert "dispatched " in t.get("note", ""), f"FAIL(c2): note not appended: {t.get('note')!r}"
PY

# --- (c3) string ids resolve too, and queued → delegated ---
rc=$(run_dispatch t59-c3 --task q-1)
[ "$rc" = "0" ] || { echo "FAIL(c3): want exit 0, got $rc" >&2; cat "$ERR" >&2; exit 1; }
python3 - "$QUEUE" <<'PY'
import json, sys
t = [x for x in json.load(open(sys.argv[1], encoding="utf-8"))["tasks"] if x["id"] == "q-1"][0]
assert t["status"] == "delegated", f"FAIL(c3): status={t['status']!r}"
assert t.get("note", "").startswith("dispatched "), f"FAIL(c3): note={t.get('note')!r}"
PY

# --- (e) --no-task proceeds and is audited; empty reason rejected ---
rc=$(run_dispatch t59-e --no-task "tracker-redispatch t59-e")
[ "$rc" = "0" ] || { echo "FAIL(e): want exit 0 for --no-task, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_injected
python3 - "$T_TMP/home" <<'PY'
import datetime, glob, json, os, sys
day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
path = os.path.join(sys.argv[1], ".aigentry", "telemetry", f"dispatch-notask-{day}.ndjson")
lines = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
assert len(lines) == 1, f"FAIL(e): want 1 telemetry line, got {len(lines)}"
row = lines[0]
assert row["reason"] == "tracker-redispatch t59-e", f"FAIL(e): reason={row['reason']!r}"
assert row["sid_or_target"] == "t59-e", f"FAIL(e): sid_or_target={row['sid_or_target']!r}"
assert row["ref"].endswith("ref-t59-e.md"), f"FAIL(e): ref={row['ref']!r}"
for key in ("ts", "caller_env"):
    assert key in row, f"FAIL(e): telemetry missing {key}: {row!r}"
PY

rc=$(run_dispatch t59-e2 --no-task "   ")
[ "$rc" != "0" ] || { echo "FAIL(e2): empty --no-task reason must be rejected" >&2; exit 1; }
t_assert_no_inject "(e2)"

rc=$(run_dispatch t59-e3 --task 100 --no-task "both")
[ "$rc" != "0" ] || { echo "FAIL(e3): --task + --no-task must be rejected" >&2; exit 1; }
t_assert_no_inject "(e3)"

# --- (f) AIGENTRY_TASK_GATE=warn proceeds with a warning; off is silent legacy ---
rc=$(AIGENTRY_TASK_GATE=warn run_dispatch t59-f)
[ "$rc" = "0" ] || { echo "FAIL(f): warn mode must proceed, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_injected
t_assert_contains "$ERR" "Rule 34"
python3 - "$T_TMP/home" <<'PY'
import datetime, json, os, sys
day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
path = os.path.join(sys.argv[1], ".aigentry", "telemetry", f"dispatch-notask-{day}.ndjson")
rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
assert any(r["sid_or_target"] == "t59-f" for r in rows), f"FAIL(f): warn mode not audited: {rows!r}"
PY

rc=$(AIGENTRY_TASK_GATE=off run_dispatch t59-g)
[ "$rc" = "0" ] || { echo "FAIL(f-off): off mode must proceed, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_injected
if grep -qF "Rule 34" "$ERR"; then
  echo "FAIL(f-off): off mode must stay silent, got:" >&2; cat "$ERR" >&2; exit 1
fi

echo "T59 PASS"
