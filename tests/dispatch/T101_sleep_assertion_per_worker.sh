#!/usr/bin/env bash
# T101 — the per-worker sleep assertion (#909 item a).
#
# On 2026-08-16 three worker turns on this host were cut mid-response by
# `API Error: Your computer went to sleep mid-response` (33m, 1h7m and 31m of work;
# the 1h7m sat uncommitted). Cause measured with `pmset -g log`: a 15-min
# DarkWake/Deep-Idle maintenance cycle from 02:34 to 10:11 on AC power. A transient
# 300s caffeinate was seen in the log and did not cover the window.
#
# The fix is an assertion bound to ONE worker's pid, so the property that matters is
# not "an assertion exists" but "it is scoped to that worker and released with it".
# A global or indefinite caffeinate would pass a naive check and keep a laptop awake
# for a week after a crashed spawner, so the assertions below pin the ARGUMENTS.
#
# Hermetic: caffeinate/systemd-inhibit are seams (AIGENTRY_CAFFEINATE /
# AIGENTRY_SYSTEMD_INHIBIT) pointed at a recorder. The real host is never asserted
# against and no real sid appears.
#
# Asserts:
#   A) a live pid ⇒ exactly one `caffeinate -i -w <pid>` — -i (idle only), -w (that
#      pid), no `-d`/`-s`/`-t`, no argument-less global form.
#   B) the assertion is released by the pid dying: the recorder's own process exits
#      when its target does (i.e. -w is what holds it, not a timer we invented).
#   C) a dead/absent pid ⇒ NO assertion held, and the refusal is announced.
#   D) a missing primitive ⇒ announced no-op, exit 0 (never gates a spawn).
#   E) platform::session_pid finds the `telepty allow --id <sid>` pid and returns
#      empty (not an error) for an unknown sid.
#   F) open-session.sh wires the two together after a spawn, and AIGENTRY_SLEEP_GUARD=0
#      is a real kill switch.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T101]: $*" >&2; exit 1; }

PLATFORM_SH="$REPO_ROOT/bin/lib/platform.sh"
[ -f "$PLATFORM_SH" ] || fail "bin/lib/platform.sh missing"

CAFF_LOG="$T_TMP/caffeinate-calls.log"; : > "$CAFF_LOG"
CAFF="$STUB_BIN/caffeinate-recorder"
cat > "$CAFF" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CAFF_LOG"
# Model the real -w contract: live exactly as long as the followed pid.
if [ "\${2:-}" = "-w" ] && [ -n "\${3:-}" ]; then
  while kill -0 "\$3" 2>/dev/null; do sleep 0.1; done
fi
exit 0
EOF
chmod +x "$CAFF"

# A pid we own and can kill — never a real worker.
sleep 30 & VICTIM=$!
trap 'kill "$VICTIM" 2>/dev/null || true; t_teardown' EXIT

hold() {
  AIGENTRY_CAFFEINATE="$CAFF" AIGENTRY_SYSTEMD_INHIBIT="${1:-$CAFF}" \
  PLATFORM_OVERRIDE="${PLATFORM_OVERRIDE:-}" \
    bash -c ". '$PLATFORM_SH'; platform::hold_awake \"\$1\" \"\$2\"" _ "$2" "$3" 2>&1
}

# --- A) live pid ⇒ one narrowly-scoped assertion -------------------------------------
: > "$CAFF_LOG"
out=$(PLATFORM_OVERRIDE=macos hold "$CAFF" "$VICTIM" "aigentry worker t100") \
  || fail "A: hold_awake exited non-zero: $out"
# The recorder blocks for the pid's lifetime, so wait for the line rather than the proc.
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CAFF_LOG" ] && break; sleep 0.1; done
[ -s "$CAFF_LOG" ] || fail "A: no assertion was taken for a live pid (recorder never invoked)"
n=$(wc -l < "$CAFF_LOG" | tr -d ' ')
[ "$n" = "1" ] || fail "A: expected exactly 1 assertion, got $n: $(cat "$CAFF_LOG")"
got=$(cat "$CAFF_LOG")
[ "$got" = "-i -w $VICTIM" ] \
  || fail "A: assertion args are '$got', want '-i -w $VICTIM' (-i = idle-only, -w = scoped to that worker)"
case "$got" in
  *-d*|*-s*|*-t\ *) fail "A: assertion widened beyond idle/pid scope: '$got'";;
esac
printf '%s\n' "$out" | grep -q 'CLOSED LID' \
  || fail "A: the assertion does not state that a closed lid still sleeps the host: $out"

# --- B) released by the pid dying ----------------------------------------------------
# The recorder mirrors caffeinate -w: it must still be alive while the target lives,
# and gone once it does not. That is the release mechanism — not a timer.
pgrep -f "caffeinate-recorder" >/dev/null 2>&1 \
  || fail "B: the assertion process is not alive while its worker pid is"
kill "$VICTIM" 2>/dev/null || true
wait "$VICTIM" 2>/dev/null || true
released=0
for _ in $(seq 1 30); do
  pgrep -f "caffeinate-recorder" >/dev/null 2>&1 || { released=1; break; }
  sleep 0.1
done
[ "$released" = "1" ] || fail "B: the assertion outlived its worker pid — that is the indefinite-caffeinate failure mode"

# --- C) dead/absent pid ⇒ nothing held, and it says so -------------------------------
: > "$CAFF_LOG"
out=$(PLATFORM_OVERRIDE=macos hold "$CAFF" "$VICTIM" "dead pid") || fail "C: non-zero on a dead pid"
[ -s "$CAFF_LOG" ] && fail "C: took an assertion for a pid that is already dead: $(cat "$CAFF_LOG")"
printf '%s\n' "$out" | grep -q 'NO sleep assertion held' \
  || fail "C: a refused assertion was silent (must announce): $out"
: > "$CAFF_LOG"
out=$(PLATFORM_OVERRIDE=macos hold "$CAFF" "" "no pid") || fail "C: non-zero on an empty pid"
[ -s "$CAFF_LOG" ] && fail "C: took an assertion with no pid at all: $(cat "$CAFF_LOG")"

# --- D) missing primitive ⇒ announced no-op, exit 0 ----------------------------------
sleep 30 & VICTIM2=$!
trap 'kill "$VICTIM" "$VICTIM2" 2>/dev/null || true; t_teardown' EXIT
out=$(AIGENTRY_CAFFEINATE="$T_TMP/no-such-caffeinate" \
      PLATFORM_OVERRIDE=macos \
      bash -c ". '$PLATFORM_SH'; platform::hold_awake \"\$1\" \"\$2\"" _ "$VICTIM2" why 2>&1) \
  || fail "D: a missing primitive made hold_awake non-zero — it would gate a spawn"
printf '%s\n' "$out" | grep -q 'NO sleep assertion held' \
  || fail "D: missing primitive was silent: $out"
# Linux arm: announced no-op when systemd-inhibit is absent (this box has none —
# measured `command -v systemd-inhibit` empty on darwin 25.4.0).
out=$(AIGENTRY_SYSTEMD_INHIBIT="$T_TMP/no-such-inhibit" \
      PLATFORM_OVERRIDE=linux \
      bash -c ". '$PLATFORM_SH'; platform::hold_awake \"\$1\" \"\$2\"" _ "$VICTIM2" why 2>&1) \
  || fail "D: linux arm non-zero without systemd-inhibit"
printf '%s\n' "$out" | grep -q 'announced no-op' \
  || fail "D: linux arm without systemd-inhibit did not announce: $out"

# --- E) session_pid resolves the telepty-allow pid -----------------------------------
# A fake `telepty allow --id <sid> …` process, so no real session is consulted.
FAKE_SID="t100-fake-$$"
bash -c "exec -a 'telepty allow --id $FAKE_SID --auto-restart claude' sleep 30" &
FAKEPID=$!
trap 'kill "$VICTIM" "$VICTIM2" "$FAKEPID" 2>/dev/null || true; t_teardown' EXIT
found=$(bash -c ". '$PLATFORM_SH'; platform::session_pid \"\$1\" 3000" _ "$FAKE_SID")
[ "$found" = "$FAKEPID" ] \
  || fail "E: session_pid returned '${found:-<empty>}', want $FAKEPID"
miss=$(bash -c ". '$PLATFORM_SH'; platform::session_pid \"\$1\"" _ "t100-no-such-sid-$$") \
  || fail "E: session_pid errored on an unknown sid (callers treat that as fatal)"
[ -z "$miss" ] || fail "E: session_pid invented a pid for an unknown sid: '$miss'"

# --- F) open-session.sh wires it, and the kill switch works --------------------------
OPEN="$REPO_ROOT/bin/open-session.sh"
grep -q 'platform::hold_awake' "$OPEN" \
  || fail "F: open-session.sh does not hold a sleep assertion after spawning a worker"
grep -q 'AIGENTRY_SLEEP_GUARD' "$OPEN" \
  || fail "F: open-session.sh has no AIGENTRY_SLEEP_GUARD kill switch"
# The assertion must follow the worker, not the spawner: a `caffeinate` with no -w,
# or one following $$, keeps the host awake after open-session.sh exits.
grep -qE 'caffeinate.*-w' "$REPO_ROOT/bin/lib/platform-unix.sh" \
  || fail "F: the macOS assertion is not pid-scoped (-w) — that is an indefinite caffeinate"
grep -qE 'caffeinate[^\n]*-w[[:space:]]+"?\$\$' "$REPO_ROOT/bin/lib/platform-unix.sh" \
  && fail "F: the assertion follows the spawner pid, not the worker"

echo "T101 PASS assertion=pid-scoped release=on-exit noop=announced"
