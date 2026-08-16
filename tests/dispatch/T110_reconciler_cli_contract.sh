#!/usr/bin/env bash
# T110 (#899 tranche 2c) — the session-reconciler contract lines NO guard pinned.
#
# 13 guards invoke bin/session-reconciler.sh and between them they pin the tick's
# decisions well: the GC root and the sweep (T17/T22), the INV-17 surface_gone
# double-gate (T26), --shadow (T29), the tracker wiring (T31), the HITL gates and
# the destructive pause (T62/T63), the dedup/held re-dispatch arms (T74), the #835
# refusal-is-not-absence rule (T90), the bus bridge and both surface consumers
# (T95), the #905 orchestrator-stale page (T98) and the #909 sleep work (T102/T103).
#
# What none of them measured is the CLI itself and the retry machinery underneath
# it: argument handling, the usage text, the exponential backoff ledger, the
# escalation JSONL, and the exit-0-on-an-unusable-listing arm. Each is a line a port
# can drop silently — the tick still sweeps, and the only visible change is an
# operator's flag being ignored, a failing cleanup retried every 60s forever, or an
# escalation nobody records. This guard is the characterization test that makes the
# port's parity with the shell measurable rather than reviewed; every block names
# the shell behaviour it pins, and every block passed against the ORIGINAL bash
# implementation (main @ b17ac74) before the port landed.
#
# Hermetic throughout: temp state dir, stubbed telepty, every actuator replaced by a
# recorder, the workspace host forced to `headless` (a pure no-op adapter — no cmux
# is contacted and no surface is probed), and throwaway sids only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

RECON="$REPO_ROOT/bin/session-reconciler.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T110]: $*" >&2; exit 1; }

# The adapter seam: `headless` makes every wh_* call a no-op that returns 0, so the
# sweep and the step-2b prune/status push cannot reach a real terminal host.
export AIGENTRY_WORKSPACE_HOST=headless

# ── recorders for every actuator this tick can reach ────────────────────────
CLEANUP_LOG="$T_TMP/cleanup.log"; : > "$CLEANUP_LOG"
CLEANUP_STUB="$T_TMP/cleanup-stub.sh"
cat > "$CLEANUP_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CLEANUP_LOG"
exit \${STUB_CLEANUP_EXIT:-0}
EOF
NOOP="$T_TMP/noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$NOOP"
# A probe that answers nothing at all — the shell's `probe_session` then returns its
# literal fallback state, whose detail.probe_error makes policy.py escalate.
PROBE_SILENT="$T_TMP/probe-silent.py"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$PROBE_SILENT"
chmod +x "$CLEANUP_STUB" "$NOOP" "$PROBE_SILENT"

export TELEPTY="$STUB_BIN/telepty"
export CLEANUP_SH="$CLEANUP_STUB"
export SCHEDULER_SH="$NOOP"
export TRACKER_SH="$NOOP"
export COMMS_AUDITOR_SH="$NOOP"
export BRIDGE_AUDITOR_SH="$NOOP"
export BUS_BRIDGE_SH="$NOOP"
export HITL_SH="$NOOP"
export RECONCILER_AGE_FLOOR=300
export RECONCILER_DISCONNECT_FLOOR=240

BACKOFF="$DISPATCH_STATE_DIR/reconciler-backoff.json"
ESCALATIONS="$DISPATCH_STATE_DIR/verify-escalations.jsonl"
RUN_LOG="$T_TMP/run.log"

# tick <RECONCILER_NOW> [args…] — one reconciler run; fails loudly on a non-zero exit.
tick() {
  local now="$1"; shift
  RECONCILER_NOW="$now" "$BASH_BIN" "$RECON" "$@" > "$RUN_LOG" 2>&1 \
    || fail "reconciler tick exited $? ($*):
$(cat "$RUN_LOG")"
}

# ── (1) argv: --help / -h / --once / an unknown flag ───────────────────────
# `usage()` was `sed -n '2,32p' "$0"; exit "${1:-0}"` — it printed the script's own
# comment header and stopped at line 32, mid-sentence, which is what a hard-coded
# line range does when the header grows under it. A port that "tidied" that would
# quietly change what an operator reads.
set +e
help_out=$("$BASH_BIN" "$RECON" --help 2>"$T_TMP/help.err"); rc=$?
set -e
[ "$rc" = "0" ] || fail "--help exited $rc, want 0"
case "$help_out" in
  *"60s level-triggered safety net"*) ;;
  *) fail "--help lost the description header: $help_out";;
esac
case "$help_out" in
  *"RECONCILER_LOOP_INTERVAL (default 60s)."*) ;;
  *) fail "--help no longer reaches line 32 of the header: $help_out";;
esac
# Line 33 onward is the shell body; the range deliberately stopped before it.
case "$help_out" in
  *"set -euo pipefail"*|*"SCRIPT_DIR="*)
    fail "--help printed past line 32 — the range was 2,32: $help_out";;
esac
[ -s "$T_TMP/help.err" ] && fail "--help wrote to stderr: $(cat "$T_TMP/help.err")"
set +e
"$BASH_BIN" "$RECON" -h >/dev/null 2>&1; rc=$?
set -e
[ "$rc" = "0" ] || fail "-h exited $rc, want 0"

# An unknown flag: the reason on STDERR, the usage text on STDOUT, exit 4.
set +e
bad_out=$("$BASH_BIN" "$RECON" --nope 2>"$T_TMP/bad.err"); rc=$?
set -e
[ "$rc" = "4" ] || fail "an unknown flag exited $rc, want 4"
grep -qx -- "unknown: --nope" "$T_TMP/bad.err" \
  || fail "the unknown flag was not named on stderr: $(cat "$T_TMP/bad.err")"
case "$bad_out" in
  *"60s level-triggered safety net"*) ;;
  *) fail "the unknown-flag path did not print the usage text to stdout: $bad_out";;
esac
[ ! -s "$CLEANUP_LOG" ] || fail "argument handling actuated something: $(cat "$CLEANUP_LOG")"

# `--once` is an ALIAS for the default, not a mode: it parses and ticks. Repeated
# and reordered flags accumulate — the shell's `while [ $# -gt 0 ]` had no
# mutual exclusion.
printf '%s' '[]' > "$STUB_LIST_FILE"
tick "2026-08-16T12:00:00Z" --once
grep -q "tick: " "$RUN_LOG" || fail "--once did not run a tick: $(cat "$RUN_LOG")"
tick "2026-08-16T12:00:00Z" --once --dry-run --once
grep -q "dry_run=1" "$RUN_LOG" \
  || fail "repeated/reordered flags lost --dry-run: $(cat "$RUN_LOG")"

# ── (2) the escalation JSONL: one line per ESCALATE, rc 6, with the reason ──
# `emit_escalation` is the audit trail behind every ESCALATE / AWAIT_USER / RESPAWN
# arm and nothing measured its shape. A silent probe makes probe_session return its
# literal fallback (detail.probe_error), which policy.py turns into ESCALATE.
: > "$ESCALATIONS"
t_seed_dispatch sid-esc
SESSION_PROBE_PY="$PROBE_SILENT" tick "2026-08-16T12:00:00Z"
[ -s "$ESCALATIONS" ] || fail "no escalation was recorded for a failed probe"
python3 - "$ESCALATIONS" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
if len(rows) != 1:
    raise SystemExit(f"FAIL[T110]: escalation rows={len(rows)}, want 1")
row = rows[0]
for key, want in (("sid", "sid-esc"), ("rc", 6)):
    if row.get(key) != want:
        raise SystemExit(f"FAIL[T110]: escalation {key}={row.get(key)!r}, want {want!r}")
if not str(row.get("ts", "")).endswith("Z"):
    raise SystemExit(f"FAIL[T110]: escalation ts is not a Z-stamped ISO time: {row.get('ts')!r}")
if "probe failed" not in str(row.get("detail", "")):
    raise SystemExit(f"FAIL[T110]: escalation lost policy's reason: {row.get('detail')!r}")
PY
# The same tick's shadow record carries the same verdict — the two are written from
# one decision and a port that split them would be invisible without this.
python3 - "$DISPATCH_STATE_DIR/reconcile-shadow.jsonl" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
row = [r for r in rows if r.get("sid") == "sid-esc"]
if not row:
    raise SystemExit("FAIL[T110]: no shadow record for sid-esc")
r = row[-1]
if r["action"].get("action") != "ESCALATE":
    raise SystemExit(f"FAIL[T110]: shadow action={r['action'].get('action')!r}, want ESCALATE")
if r["state"].get("detail", {}).get("probe_error") != "session-probe failed":
    raise SystemExit(f"FAIL[T110]: shadow state lost the probe fallback: {r['state']!r}")
PY

# ── (3) exponential backoff: record → skip inside the window → retry → reset ─
# A cleanup that keeps failing must not be retried every 60 seconds forever. The
# ledger at state/dispatch/reconciler-backoff.json is the whole mechanism (initial
# 5s, doubling, capped at 1000s) and NOTHING pinned it. Its absence is invisible
# until a permanently-unremovable session hammers session-cleanup.sh once a minute.
t_init_v2   # empty registry ⇒ sid-bo is not in the GC root
cat > "$STUB_LIST_FILE" <<'EOF'
[{"id":"sid-bo","healthStatus":"DISCONNECTED","startedAt":"2026-08-16T11:00:00Z","lastSeenAt":"2026-08-16T11:50:00Z"}]
EOF
printf '{}\n' > "$BACKOFF"
: > "$CLEANUP_LOG"

# attempt 1 — the cleanup fails, so the sid is put into backoff.
STUB_CLEANUP_EXIT=1 tick "2026-08-16T12:00:00Z"
grep -qx "sid-bo" "$CLEANUP_LOG" || fail "the first attempt never called cleanup: $(cat "$RUN_LOG")"
python3 - "$BACKOFF" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
rec = d.get("sid-bo")
if not rec:
    raise SystemExit(f"FAIL[T110]: a failed cleanup recorded no backoff: {d!r}")
if rec.get("count") != 1 or rec.get("delay_seconds") != 5:
    raise SystemExit(f"FAIL[T110]: first backoff is {rec!r}, want count=1 delay_seconds=5")
if rec.get("next_attempt_iso") != "2026-08-16T12:00:05Z":
    raise SystemExit(f"FAIL[T110]: next_attempt_iso={rec.get('next_attempt_iso')!r}, want 2026-08-16T12:00:05Z")
PY

# inside the window — the candidate is skipped BEFORE it is even considered, so
# there is no new cleanup call and no SWEEP line naming it.
: > "$CLEANUP_LOG"
STUB_CLEANUP_EXIT=1 tick "2026-08-16T12:00:01Z"
[ ! -s "$CLEANUP_LOG" ] || fail "a sid inside its backoff window was retried: $(cat "$CLEANUP_LOG")"
grep -q "SWEEP candidate sid=sid-bo" "$RUN_LOG" \
  && fail "a sid inside its backoff window was still evaluated as a candidate: $(cat "$RUN_LOG")"

# past the window — retried, and the delay doubles.
: > "$CLEANUP_LOG"
STUB_CLEANUP_EXIT=1 tick "2026-08-16T12:00:06Z"
grep -qx "sid-bo" "$CLEANUP_LOG" || fail "the sid was not retried after its backoff expired: $(cat "$RUN_LOG")"
python3 - "$BACKOFF" <<'PY'
import json, sys
rec = json.load(open(sys.argv[1], encoding="utf-8")).get("sid-bo", {})
if rec.get("count") != 2 or rec.get("delay_seconds") != 10:
    raise SystemExit(f"FAIL[T110]: second backoff is {rec!r}, want count=2 delay_seconds=10 (init 5 doubling)")
PY

# a successful cleanup clears the entry — otherwise the ledger grows forever and a
# recovered session stays throttled.
: > "$CLEANUP_LOG"
STUB_CLEANUP_EXIT=0 tick "2026-08-16T12:00:20Z"
grep -qx "sid-bo" "$CLEANUP_LOG" || fail "the sid was not retried after the second window: $(cat "$RUN_LOG")"
python3 - "$BACKOFF" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
if "sid-bo" in d:
    raise SystemExit(f"FAIL[T110]: a successful cleanup did not reset the backoff: {d!r}")
PY

# ── (4) an unusable listing aborts the SWEEP and exits 0 ───────────────────
# T90 pins the #835 refusal arm (an empty array the daemon will not corroborate).
# The other arm — stdout that is not JSON at all, i.e. task #400's daemon-version
# banner — was unpinned. Both must end the same way: nothing swept, nothing pruned,
# and exit 0, because a tick that cannot see the session list has no evidence for
# any teardown and must not fail the launchd job either.
: > "$CLEANUP_LOG"
printf '%s\n' 'Daemon version mismatch: CLI 0.4.0 vs daemon 0.3.5' > "$STUB_LIST_FILE"
set +e
RECONCILER_NOW="2026-08-16T12:01:00Z" "$BASH_BIN" "$RECON" > "$RUN_LOG" 2>&1; rc=$?
set -e
[ "$rc" = "0" ] || fail "a non-JSON listing exited $rc, want 0: $(cat "$RUN_LOG")"
grep -q "abort sweep — bad telepty list" "$RUN_LOG" \
  || fail "the aborted sweep was not named in the log: $(cat "$RUN_LOG")"
grep -q "returned non-JSON" "$RUN_LOG" \
  || fail "the non-JSON arm lost its diagnostic: $(cat "$RUN_LOG")"
[ ! -s "$CLEANUP_LOG" ] || fail "a tick with an unusable listing still tore something down: $(cat "$CLEANUP_LOG")"
# The registry loop's own "registry tick:" line still runs (it is step 0, ahead of
# the sweep); the FINAL summary must not, because the abort exits before it.
grep -q "tick: gc_root=" "$RUN_LOG" \
  && fail "the aborted sweep still printed the final tick summary — it exits before it"

echo "T110 PASS"
