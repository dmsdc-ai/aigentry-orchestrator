#!/usr/bin/env bash
# T1304R — task 1304 ADR D4: dispatch readiness reads the screen through the adapter that
# OPENED the session, not through telepty's `backend` field.
#
#   R1) a warp record → bin/session-probe.py reads the current viewport through
#       `wh-cli.sh read-screen` (tmux capture-pane), reaches ready=true on an idle Claude
#       screen, labels it warp:current-viewport, and never consumes the cmux reader — even
#       though telepty's info says backend=cmux. `__probe is-ready` agrees (exit 0).
#   R2) a record naming an adapter with no screen reader (headless, aterm) → the probe
#       says READINESS_UNATTESTABLE adapter=<name>, ready=false.
#   R3) a cmux record → the bound in-process cmux reader, exactly as for a session
#       without a record (cmux:current-viewport; the bound read-screen is consumed).
#   R4) dispatch stops AT ONCE on READINESS_UNATTESTABLE: exit 1 well inside a 20 s
#       readiness budget, one message naming the adapter, nothing injected.
#
# Hermetic: stub telepty/cmux/ps from lib.sh, a stub tmux, fixture sids only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
PROBE_PY="$REPO_ROOT/bin/session-probe.py"

fail() { echo "FAIL[T1304R]: $*" >&2; exit 1; }

SID="t1304-rd"
STATE="$AIGENTRY_WH_STATE_DIR"; mkdir -p "$STATE"
TMUX_LOG="$T_TMP/tmux.log"; : > "$TMUX_LOG"
TMUX_SCREEN="$T_TMP/tmux-screen.txt"
cp "$HERE/fixtures/claude2x_welcome_idle.txt" "$TMUX_SCREEN"

# The bound session (backend=cmux on purpose: the record, not telepty, must pick the reader).
t_current_view "$SID" claude
: > "$STUB_SCREEN_FILE"   # the cmux viewport is BLANK: reading it can never say ready

cat > "$STUB_BIN/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "tmux \$*" >> "$TMUX_LOG"
case "\$1" in
  has-session)  exit 0 ;;
  capture-pane) cat "$TMUX_SCREEN" ;;
esac
exit 0
EOF
chmod +x "$STUB_BIN/tmux"

probe() { python3 "$PROBE_PY" --sid "$SID" --cli claude; }
field() { python3 -c 'import json,sys; d=json.load(sys.stdin); v=d
for k in sys.argv[1].split("."): v=(v or {}).get(k)
print("" if v is None else (str(v).lower() if isinstance(v,bool) else v))' "$1"; }

# ── R1: warp record → the layer's tmux reader ─────────────────────────────────────
printf 'v1\twarp\ttelepty::%s\n' "$SID" > "$STATE/$SID.rec"
t_current_view_reset_log
out=$(probe)
[ "$(printf '%s' "$out" | field ready)" = "true" ] || fail "R1: an idle Claude screen read through the warp adapter is not ready. probe: $out"
[ "$(printf '%s' "$out" | field detail.screen_source)" = "warp:current-viewport" ] \
  || fail "R1: screen_source is not warp:current-viewport. probe: $out"
grep -qF "tmux capture-pane -p -t =aigentry-warp-$SID:" "$TMUX_LOG" || fail "R1: the layer reader (tmux capture-pane) was not used. tmux log:
$(cat "$TMUX_LOG")"
grep -q 'read-screen' "$STUB_CMUX_LOG" && fail "R1: the cmux reader was consumed for a warp session:
$(cat "$STUB_CMUX_LOG")"
rc=0; "$REPO_ROOT/bin/dispatch.sh" __probe is-ready "$SID" claude || rc=$?
[ "$rc" -eq 0 ] || fail "R1: __probe is-ready rc=$rc for a ready warp session"

# ── R2: an adapter without a reader → READINESS_UNATTESTABLE adapter=<name> ───────
for a in headless aterm; do
  printf 'v1\t%s\t%s\n' "$a" "$SID" > "$STATE/$SID.rec"
  out=$(probe)
  [ "$(printf '%s' "$out" | field detail.probe_error)" = "READINESS_UNATTESTABLE adapter=$a" ] \
    || fail "R2/$a: probe_error is not 'READINESS_UNATTESTABLE adapter=$a'. probe: $out"
  [ "$(printf '%s' "$out" | field ready)" = "false" ] || fail "R2/$a: an unattestable session was reported ready. probe: $out"
done

# ── R3: cmux record → the bound in-process cmux reader, unchanged ─────────────────
cp "$HERE/fixtures/claude2x_welcome_idle.txt" "$STUB_SCREEN_FILE"
for label in record none; do
  if [ "$label" = record ]; then printf 'v1\tcmux\tworkspace:7\n' > "$STATE/$SID.rec"; else rm -f "$STATE/$SID.rec"; fi
  t_current_view_reset_log; : > "$TMUX_LOG"
  out=$(probe)
  [ "$(printf '%s' "$out" | field ready)" = "true" ] || fail "R3/$label: cmux session not ready. probe: $out"
  [ "$(printf '%s' "$out" | field detail.screen_source)" = "cmux:current-viewport" ] || fail "R3/$label: source changed: $out"
  t_assert_current_view_read "T1304R R3/$label"
  [ -s "$TMUX_LOG" ] && fail "R3/$label: a cmux session was read through tmux: $(cat "$TMUX_LOG")"
done

# ── R4: dispatch stops at once on READINESS_UNATTESTABLE ──────────────────────────
t_confined_setup
UNATTESTABLE_PROBE="$T_TMP/unattestable-probe"
cat > "$UNATTESTABLE_PROBE" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"alive":true,"ready":false,"surface":"unknown","activity":"static","cli":"claude","detail":{"probe_error":"READINESS_UNATTESTABLE adapter=headless","tracker_class":"unknown"}}'
SH
chmod +x "$UNATTESTABLE_PROBE"
FAKE_OPEN_SESSION="$T_TMP/fake-open-session.sh"
cat > "$FAKE_OPEN_SESSION" <<'SH'
#!/usr/bin/env bash
exec "$T_FIXTURE_NODE" "$T_FIXTURE_HELPER" receipt "$T1304_SID"
SH
chmod +x "$FAKE_OPEN_SESSION"
QUEUE="$T_TMP/task-queue.json"
printf '%s' '{"tasks":[{"id":1304,"desc":"unattestable readiness","priority":"P1","status":"pending"}]}' > "$QUEUE"
REF="$T_TMP/ref.md"; printf 'T1304R dispatch ref\n' > "$REF"
t_confined_scope "t1304-un" 1304 "$T_TMP/cwd"
printf '%s' '[{"id":"t1304-un","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
: > "$STUB_DISPATCH_LOG"
ERR="$T_TMP/dispatch.err"
start=$SECONDS
set +e
HOME="$T_TMP/home" \
AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions" \
AIGENTRY_TASK_QUEUE="$QUEUE" \
T1304_SID="t1304-un" \
OPEN_SESSION_SH="$FAKE_OPEN_SESSION" \
SESSION_PROBE_PY="$UNATTESTABLE_PROBE" \
TELEPTY="$STUB_BIN/telepty" \
  "$REPO_ROOT/bin/dispatch.sh" --spawn-and-dispatch \
    --track t1304 --name un --cwd "$T_TMP/cwd" --cli claude --role coder \
    --from t1304-test --ref "$REF" --timeout-ms 20000 --no-verify-started --task 1304 \
    >/dev/null 2>"$ERR"
rc=$?
set -e
elapsed=$((SECONDS - start))
[ "$rc" -eq 1 ] || { cat "$ERR" >&2; fail "R4: dispatch rc=$rc want 1 (readiness not attestable)"; }
[ "$elapsed" -lt 15 ] || fail "R4: dispatch waited ${elapsed}s of a 20 s budget — it did not stop at once"
grep -qF 'READINESS_UNATTESTABLE adapter=headless' "$ERR" || { cat "$ERR" >&2; fail "R4: the stop does not name READINESS_UNATTESTABLE adapter=headless"; }
grep -qF 'waiting for t1304-un REPL ready' "$ERR" && fail "R4: dispatch reported a readiness TIMEOUT instead of the unattestable adapter"
[ -s "$STUB_DISPATCH_LOG" ] && fail "R4: something was injected after an unattestable readiness: $(cat "$STUB_DISPATCH_LOG")"

echo "T1304R PASS warp=layer-reader headless/aterm=READINESS_UNATTESTABLE cmux=unchanged dispatch=stops-at-once"
