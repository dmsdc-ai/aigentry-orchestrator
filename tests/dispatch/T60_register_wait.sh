#!/usr/bin/env bash
# T60 — #727: dispatch.sh must wait patiently for a freshly spawned session to
#       register in `telepty list` instead of giving up on the first miss. The
#       one-shot check made every --spawn-and-dispatch fail with
#       "session '<sid>' not found in telepty list", and each failure was
#       hand-recovered with a raw `telepty inject` — bypassing the #736
#       task-gate ledger, delivery confirmation and tracker registration.
#       Covers: late registration still lands on the FULL gated path, final
#       timeout is a distinct exit code with no side effects (retryable), and
#       the env knob / default are honored and documented.
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

OPEN_LOG="$T_TMP/open-session.log"
FAKE_OPEN_SESSION="$T_TMP/fake-open-session.sh"
cat > "$FAKE_OPEN_SESSION" <<SH
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OPEN_LOG"
exit 0
SH
chmod +x "$FAKE_OPEN_SESSION"

# telepty wrapper: reports an EMPTY session list for the first \$T60_ABSENT_CALLS
# \`list\` calls (the spawn-boot window), then delegates to the shared stub.
export T60_COUNT="$T_TMP/list-calls"
export REAL_TELEPTY="$STUB_BIN/telepty"
LATE_TELEPTY="$T_TMP/telepty-late"
cat > "$LATE_TELEPTY" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "list" ]; then
  n=$(cat "$T60_COUNT" 2>/dev/null || true); n=${n:-0}
  printf '%s' "$((n + 1))" > "$T60_COUNT"
  if [ "$n" -lt "${T60_ABSENT_CALLS:-0}" ]; then printf '%s' '[]'; exit 0; fi
fi
exec "$REAL_TELEPTY" "$@"
SH
chmod +x "$LATE_TELEPTY"

QUEUE="$T_TMP/task-queue.json"
python3 - "$QUEUE" <<'PY'
import json, sys
data = {"tasks": [
    {"id": 200, "desc": "late registration", "priority": "P1", "status": "pending"},
    {"id": 201, "desc": "never registers",   "priority": "P1", "status": "pending"},
]}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False, indent=1))
PY

ERR="$T_TMP/err.txt"
REF="$T_TMP/ref.md"
printf 'T60 dispatch ref\n' > "$REF"

# Spawns <track>-<name>; absent_calls list misses precede registration.
run_spawn() {
  local name="$1" absent="$2" knob="$3"; shift 3
  printf '%s' "[{\"id\":\"t60-$name\",\"command\":\"claude\",\"healthStatus\":\"CONNECTED\"}]" > "$STUB_LIST_FILE"
  printf '0' > "$T60_COUNT"; : > "$STUB_DISPATCH_LOG"
  set +e
  HOME="$T_TMP/home" \
  AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions" \
  AIGENTRY_TASK_QUEUE="$QUEUE" \
  AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS="$knob" \
  T60_ABSENT_CALLS="$absent" \
  OPEN_SESSION_SH="$FAKE_OPEN_SESSION" \
  SESSION_PROBE_PY="$PROBE" \
  TELEPTY="$LATE_TELEPTY" \
    "$REPO_ROOT/bin/dispatch.sh" --spawn-and-dispatch \
      --track t60 --name "$name" --cwd "$T_TMP/cwd" --cli claude \
      --from t60-test --ref "$REF" --timeout-ms 800 --no-verify-started "$@" \
      >/dev/null 2>"$ERR"
  local rc=$?
  set -e
  printf '%s' "$rc"
}

t_task_status() {
  python3 - "$QUEUE" "$1" <<'PY'
import json, sys
t = [x for x in json.load(open(sys.argv[1], encoding="utf-8"))["tasks"] if str(x["id"]) == sys.argv[2]][0]
print(t.get("status", ""))
PY
}

# --- (a) registers late → dispatch still completes on the FULL gated path ---
rc=$(run_spawn late 1 1200 --task 200)
[ "$rc" = "0" ] || { echo "FAIL(a): want exit 0 after a late registration, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_contains "$STUB_DISPATCH_LOG" "telepty inject"
got=$(t_task_status 200)
[ "$got" = "delegated" ] || { echo "FAIL(a): task 200 status=$got, want delegated (auto-ledger skipped)" >&2; exit 1; }
if [ "$(cat "$T60_COUNT")" -lt 2 ]; then
  echo "FAIL(a): only $(cat "$T60_COUNT") telepty list call(s) — the presence check did not retry" >&2; exit 1
fi

# --- (b) never registers → distinct exit 6, no inject, no ledger write ---
start=$SECONDS
rc=$(run_spawn dead 999 1500 --task 201)
elapsed=$((SECONDS - start))
[ "$rc" = "6" ] || { echo "FAIL(b): want distinct exit 6 on registration timeout, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_contains "$ERR" "AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS"
if [ -s "$STUB_DISPATCH_LOG" ]; then
  echo "FAIL(b): inject leaked after registration timeout:" >&2; cat "$STUB_DISPATCH_LOG" >&2; exit 1
fi
got=$(t_task_status 201)
[ "$got" = "pending" ] || { echo "FAIL(b): task 201 status=$got, want untouched pending" >&2; exit 1; }
# (c) knob honored: the 180000ms default would have blocked far past this.
[ "$elapsed" -lt 30 ] || { echo "FAIL(c): waited ${elapsed}s with a 1500ms knob — knob ignored" >&2; exit 1; }

# --- (b2) the timed-out dispatch left no dedup mark: same ref retries cleanly ---
rc=$(run_spawn dead 0 1500 --task 201)
[ "$rc" = "0" ] || { echo "FAIL(b2): retry after timeout must dispatch, got $rc" >&2; cat "$ERR" >&2; exit 1; }
t_assert_contains "$STUB_DISPATCH_LOG" "telepty inject"

# --- (d) --target keeps the historical fail-fast (only a spawn earns patience) ---
start=$SECONDS
set +e
HOME="$T_TMP/home" TELEPTY="$STUB_BIN/telepty" \
  "$REPO_ROOT/bin/dispatch.sh" --target t60-ghost --ref "$REF" --from t60-test \
    --no-task "T60 --target fail-fast" --no-verify-started >/dev/null 2>"$ERR"
rc=$?
set -e
[ "$rc" = "6" ] || { echo "FAIL(d): --target on an absent session want exit 6, got $rc" >&2; cat "$ERR" >&2; exit 1; }
[ "$((SECONDS - start))" -lt 10 ] || { echo "FAIL(d): --target waited $((SECONDS - start))s — the spawn-only default leaked" >&2; exit 1; }

# --- (c2) knob + default are documented in --help ---
HELP="$T_TMP/help.txt"
"$REPO_ROOT/bin/dispatch.sh" --help > "$HELP" 2>&1
t_assert_contains "$HELP" "AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS"
t_assert_contains "$HELP" "180000"

echo "T60 PASS"
