#!/usr/bin/env bash
# T112 (#899 tranche 2c) — the three env seams that must survive a process boundary.
#
# The shell reconciler reached bin/lib/workspace-host.sh by SOURCING it, so the
# adapter read `$DRY_RUN` as an ordinary variable of the same process
# (bin/lib/workspace-host.sh:209, and the shell said so inline: "DRY_RUN is visible
# to the adapter via the inherited shell var"). The TypeScript port reaches the same
# functions through bin/wh-cli.sh, one process away, where a plain variable does not
# exist. It has to be EXPORTED, and there is no test that would have noticed if it
# were not:
#
#   * `wh_prune_orphans` defaults to `${DRY_RUN:-0}`, so a lost seam does not error
#     — it reads as DRY_RUN=0 and CLOSES REAL cmux workspaces on a tick the operator
#     explicitly asked to be report-only. Silent, and the loudest possible failure.
#   * `pruned=$(wh_prune_orphans … 2>/dev/null || echo 0)` discards the adapter's
#     own "PRUNE would-close" line, so the tick log cannot be used as evidence
#     either way.
#
# Two more seams cross the same way and were equally unpinned:
#   * AIGENTRY_CMUX_ORPHAN_LEDGER — already an `export` in the shell, read by the
#     same adapter. Without it the seen-twice debounce ledger silently falls back to
#     $TMPDIR and the debounce forgets every tick.
#   * AIGENTRY_HOST_POWER_STATE — computed once per tick (pmset costs ~1.2s) and
#     handed to the dispatch-tracker CHILD so the sleep gate does not pay for a
#     second reading. It has always crossed a process boundary; nothing measured it.
#
# The seam is measured where it is consumed: bin/lib/workspace-host.sh is replaced
# by a RECORDER LIB in a copied workspace, so the assertion is implementation-blind
# — the sourced-function reconciler and the wh-cli.sh reconciler both have to make
# the same values visible to the same functions. That is also why this guard needs
# no cmux: nothing here can reach a real terminal host.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T112]: $*" >&2; exit 1; }

# ── a workspace copy of bin/, with dist/ alongside so the shim resolves ──
WS="$T_TMP/ws"
mkdir -p "$WS"
cp -R "$REPO_ROOT/bin" "$WS/bin"
[ -d "$REPO_ROOT/dist" ] && ln -s "$REPO_ROOT/dist" "$WS/dist"
RECON="$WS/bin/session-reconciler.sh"

# ── the recorder lib: every wh_* the tick calls, logging what it can SEE ──
WH_LOG="$T_TMP/wh-seams.log"; : > "$WH_LOG"
cat > "$WS/bin/lib/workspace-host.sh" <<EOF
#!/usr/bin/env bash
# Recorder standing in for bin/lib/workspace-host.sh. Each function records the
# environment it was handed, which is exactly what this guard is about.
_t112() { printf '%s DRY_RUN=%s LEDGER=%s args=%s\n' "\$1" "\${DRY_RUN:-<unset>}" "\${AIGENTRY_CMUX_ORPHAN_LEDGER:-<unset>}" "\$2" >> "$WH_LOG"; }
wh_lookup()        { _t112 lookup "\$*"; printf ''; return 0; }
wh_close()         { _t112 close "\$*"; return 0; }
wh_alive()         { _t112 alive "\$*"; return 0; }
wh_focus()         { _t112 focus "\$*"; return 0; }
wh_close_for_sid() { _t112 close-for-sid "\$*"; return 0; }
wh_list_ids()      { _t112 list-ids "\$*"; return 0; }
wh_open()          { _t112 open "\$*"; return 0; }
wh_clear_status()  { _t112 clear-status "\$*"; return 0; }
wh_set_status()    { _t112 set-status "\$*"; return 0; }
wh_prune_orphans() { _t112 prune-orphans "\$*"; echo 0; return 0; }
detect_terminal()  { _t112 detect-terminal "\$*"; printf 'headless\n'; return 0; }
EOF

# ── a tracker recorder that reports the environment IT was handed ──
TRACKER_LOG="$T_TMP/tracker-env.log"; : > "$TRACKER_LOG"
TRACKER="$T_TMP/tracker-recorder.sh"
cat > "$TRACKER" <<EOF
#!/usr/bin/env bash
printf '%s AIGENTRY_HOST_POWER_STATE=%s\n' "\${1:-}" "\${AIGENTRY_HOST_POWER_STATE:-<unset>}" >> "$TRACKER_LOG"
exit 0
EOF
NOOP="$T_TMP/noop.sh"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$NOOP"
chmod +x "$TRACKER" "$NOOP"

LEDGER="$T_TMP/t112-orphan-ledger.json"
NOW="2026-08-16T12:00:00Z"

# Two live sessions, both with a cmux workspace id, both held open by a dispatch so
# the sweep has no candidate and only step 2b runs against the adapter.
cat > "$STUB_LIST_FILE" <<'EOF'
[
  {"id":"sid-up","healthStatus":"CONNECTED","startedAt":"2026-08-16T11:00:00Z","cmuxWorkspaceId":"WS-UP"},
  {"id":"sid-down","healthStatus":"DISCONNECTED","startedAt":"2026-08-16T11:00:00Z","lastSeenAt":"2026-08-16T11:59:59Z","cmuxWorkspaceId":"WS-DOWN"}
]
EOF
t_seed_dispatch sid-up
t_seed_dispatch sid-down

RUN_LOG="$T_TMP/run.log"
# CMUX_WORKSPACE_ID is pinned rather than inherited: it is step 2b's protected_refs
# argument, and a developer box that exports its own would otherwise make this
# guard's recorded argv differ from a CI runner's.
export CMUX_WORKSPACE_ID=WS-PROTECTED
tick() {
  : > "$WH_LOG"; : > "$TRACKER_LOG"
  # PLATFORM_OVERRIDE=linux makes platform::host_power_state answer `unknown` on any
  # host (there is no cheap Linux equivalent), so this asserts on a value the tick
  # RESOLVED rather than one the test pre-seeded — AIGENTRY_HOST_POWER_STATE is
  # deliberately NOT set here, because setting it would short-circuit the very
  # resolution being measured (platform-unix.sh:host_power_state returns it verbatim).
  PLATFORM_OVERRIDE=linux \
  RECONCILER_NOW="$NOW" \
  AIGENTRY_CMUX_ORPHAN_LEDGER="$LEDGER" \
  TELEPTY="$STUB_BIN/telepty" \
  CLEANUP_SH="$NOOP" SCHEDULER_SH="$NOOP" TRACKER_SH="$TRACKER" \
  COMMS_AUDITOR_SH="$NOOP" BRIDGE_AUDITOR_SH="$NOOP" BUS_BRIDGE_SH="$NOOP" HITL_SH="$NOOP" \
    bash "$RECON" "$@" > "$RUN_LOG" 2>&1 \
      || fail "reconciler tick exited non-zero ($*):
$(cat "$RUN_LOG")"
}

prune_line() { grep '^prune-orphans ' "$WH_LOG" | head -1; }

# ── (1) --dry-run must reach wh_prune_orphans as DRY_RUN=1 ────────────────
# THE assertion. If the seam is dropped the adapter reads its `${DRY_RUN:-0}`
# default and closes workspaces on a report-only tick.
tick --dry-run
line=$(prune_line)
[ -n "$line" ] || fail "--dry-run never called wh_prune_orphans at all:
$(cat "$WH_LOG")
--- tick ---
$(cat "$RUN_LOG")"
case "$line" in
  *"DRY_RUN=1"*) ;;
  *) fail "the --dry-run flag did NOT reach the workspace-host adapter — it saw [$line]. Left uncorrected this closes real cmux workspaces on a report-only tick.";;
esac
case "$line" in
  *"LEDGER=$LEDGER"*) ;;
  *) fail "AIGENTRY_CMUX_ORPHAN_LEDGER did not reach the adapter — it saw [$line]; the seen-twice debounce would fall back to \$TMPDIR and forget every tick";;
esac
# …and the report-only tick pushed no sidebar status either (step 2b §B is gated on
# DRY_RUN inside the reconciler, not inside the adapter).
grep -q '^set-status ' "$WH_LOG" \
  && fail "--dry-run pushed a sidebar status: $(cat "$WH_LOG")"

# ── (2) an acting tick reaches the same function as DRY_RUN=0 ─────────────
# The negative half: a port that hard-coded DRY_RUN=1 into the child env would pass
# block (1) and never prune anything again.
tick
line=$(prune_line)
[ -n "$line" ] || fail "an acting tick never called wh_prune_orphans:
$(cat "$WH_LOG")"
case "$line" in
  *"DRY_RUN=0"*) ;;
  *) fail "an acting tick handed the adapter [$line] — pruning would never run again";;
esac
case "$line" in
  *"LEDGER=$LEDGER"*) ;;
  *) fail "AIGENTRY_CMUX_ORPHAN_LEDGER did not reach the adapter on the acting tick: [$line]";;
esac

# ── (3) the sidebar push crosses the same boundary, with the mapped state ─
# CONNECTED→idle, DISCONNECTED→disconnected (orchestrator decision 3: never emit a
# false "working"). Same door, so a broken export would show up here too.
grep -q 'set-status .*args=WS-UP idle' "$WH_LOG" \
  || fail "the CONNECTED session's pill was not pushed as idle: $(cat "$WH_LOG")"
grep -q 'set-status .*args=WS-DOWN disconnected' "$WH_LOG" \
  || fail "the DISCONNECTED session's pill was not pushed as disconnected: $(cat "$WH_LOG")"
grep -q "status_pushed=2" "$RUN_LOG" \
  || fail "the tick did not count both status pushes: $(cat "$RUN_LOG")"

# ── (4) AIGENTRY_HOST_POWER_STATE reaches the dispatch-tracker child ──────
# Resolved once per tick (pmset costs ~1.2s measured) and handed down so the
# tracker's sleep gate does not pay for a second reading. A lost export is silent:
# the tracker just re-reads it and the tick gets slower, or — on a host where the
# tracker cannot read it — forwards telemetry into a DarkWake window, which is the
# ~70 wasted orchestrator turns of 2026-08-16 that #909 exists to stop.
grep -q "^check AIGENTRY_HOST_POWER_STATE=unknown$" "$TRACKER_LOG" \
  || fail "the tracker child did not inherit this tick's host power reading: $(cat "$TRACKER_LOG")"

# ── (5) protected_refs is the operator's own workspace, passed through ────
# `protected_refs="${CMUX_WORKSPACE_ID:-}"` — the one thing that keeps the tick from
# pruning the surface it is itself running in when that id is known (it is empty
# under launchd, where the ownership gate covers it instead).
grep -q 'prune-orphans .*args=.* WS-PROTECTED$' "$WH_LOG" \
  || fail "CMUX_WORKSPACE_ID did not reach wh_prune_orphans as protected_refs: $(prune_line)"

# ── (6) the ledger DEFAULT crosses too, not just an operator-set value ───
# Blocks (1) and (2) pass a ledger path in, so they cannot tell an export apart from
# plain inheritance. With the caller silent, the reconciler's own
# $DISPATCH_STATE_DIR default has to become visible to the adapter — that default is
# the entire reason the shell marked this variable `export` (a $TMPDIR fallback
# forgets the seen-twice debounce on every reboot).
: > "$WH_LOG"; : > "$TRACKER_LOG"
env -u AIGENTRY_CMUX_ORPHAN_LEDGER \
  PLATFORM_OVERRIDE=linux RECONCILER_NOW="$NOW" \
  TELEPTY="$STUB_BIN/telepty" \
  CLEANUP_SH="$NOOP" SCHEDULER_SH="$NOOP" TRACKER_SH="$TRACKER" \
  COMMS_AUDITOR_SH="$NOOP" BRIDGE_AUDITOR_SH="$NOOP" BUS_BRIDGE_SH="$NOOP" HITL_SH="$NOOP" \
  bash "$RECON" > "$RUN_LOG" 2>&1 \
    || fail "the default-ledger tick exited non-zero:
$(cat "$RUN_LOG")"
case "$(prune_line)" in
  *"LEDGER=$DISPATCH_STATE_DIR/cmux-orphan-ledger.json"*) ;;
  *) fail "with no AIGENTRY_CMUX_ORPHAN_LEDGER set, the adapter did not receive the reconciler's state-dir default — it saw [$(prune_line)]";;
esac

echo "T112 PASS"
