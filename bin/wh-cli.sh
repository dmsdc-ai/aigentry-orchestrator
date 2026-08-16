#!/usr/bin/env bash
# wh-cli.sh — subprocess door onto bin/lib/workspace-host.sh (#899 pre-tranche-2).
#
# WHY THIS EXISTS. #899 ports the large bin/*.sh to TypeScript. Tranches 1/1b worked
# because dispatch.sh / dispatch-tracker.sh were INVOKED. Tranche 2's targets —
# session-cleanup.sh, session-reconciler.sh, open-session.sh — `source`
# lib/workspace-host.sh and call its bash functions IN-PROCESS. A TS port cannot
# source bash. This script is the only thing that changes about that: the same
# functions, reachable as a subprocess, with the SAME exit codes and the SAME stdout.
#
# It is a door, not a port. workspace-host.sh is untouched and stays bash (it is
# #899's last item by design — terminal-adapter surface, macOS-coupled). Every arm
# below is a 1:1 forward; no argument rewriting, no exit-code translation, no
# defaulting. If a verb's contract is surprising, that is the lib's contract and the
# CLI is required to reproduce it — T104 asserts CLI result == sourced-function
# result (exit code + stdout) for all 11, so the two can never drift.
#
# CONTRACT TABLE (measured from bin/lib/workspace-host.sh, not from its prose):
#
#   VERB                                     STDOUT              EXIT
#   open <sid> <cwd> <cli_cmd>               host_id (ready)     0 ok
#                                            —                   2 spawn produced no ref
#                                            —                   3 ready-gate timeout (ws closed)
#                                            —                  64 adapter has no _wh_<a>_open
#   lookup <sid> [session_json]              host_id or empty    0 always (empty == no mapping)
#   close <host_id>                          —                   0 released or already gone
#                                                                1 real failure (still alive)
#   alive <host_id>                          —                   0 alive OR cannot-probe
#                                                                    (INV-17 INDETERMINATE→alive)
#                                                                1 host answered "no such handle"
#   list-ids                                 one host_id/line    0
#   focus <host_id>                          —                   0 focused or degraded
#                                                                  (cmux forwards select-workspace's
#                                                                   status — reproduced, not smoothed)
#   prune-orphans <live_csv> <protected_csv> count closed        0 always
#   set-status <host_id> <state>             —                   0 always (unknown state = no-op)
#   clear-status <host_id>                   —                   0 always
#   close-for-sid <sid> [session_json]       —                   0 no mapping, or closed
#                                                                1 mapped but close failed
#   detect-terminal                          adapter name        0 always (headless is the catch-all)
#
# The 11th verb is not an extra. detect_terminal is prose-classed "internal" but
# open-session.sh:201 and :272 call it, and open-session.sh is a tranche-2 port
# target — so a door without it is a door tranche 2 cannot walk through. The sweep
# behind that: every one of the 69 functions the lib defines, grepped against all
# three consumers. Only these 11 are reached (_wh_adapter and _wh_fallback_spawn
# appear in open-session.sh's COMMENTS only, lines 141-144/228/236). T104 pins the
# set so a 12th cannot appear unmeasured.
#
# Env passthrough is the absence of code: same process, so AIGENTRY_WORKSPACE_HOST,
# CMUX, CMUX_READY_TIMEOUT_MS, AIGENTRY_ROLE_SANDBOX_DIR, DRY_RUN and every other
# adapter seam reach the lib exactly as they do a sourcing caller.
#
# NO `set -e`. These verbs report through their exit status — `alive` answering 1 is
# an answer, not a crash — and a sourcing consumer runs them without -e. Turning it
# on here would abort mid-function on an intermediate non-zero and hand back an exit
# code the sourced call never produces, which is precisely the drift T104 forbids.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Relative source: bin/lib/workspace-host.sh ships in the init manifest alongside
# this file, so a control workspace (bin/ copied, no repo, no dist/) resolves it the
# same way the repo tree does. T104 part E materializes that layout and proves it.
# shellcheck source=lib/workspace-host.sh
. "$SCRIPT_DIR/lib/workspace-host.sh"

usage() {
  cat <<'EOF'
usage: wh-cli.sh <verb> [args...]

Subprocess door onto bin/lib/workspace-host.sh. Each verb forwards 1:1 to the
matching shell function with the same exit code and the same stdout.

  open <sid> <cwd> <cli_cmd>              spawn a ready surface; prints host_id
                                          (2=spawn failed, 3=ready-gate timeout)
  lookup <sid> [session_json]             print host_id, or empty if unmapped
  close <host_id>                         release the surface (1=still alive)
  alive <host_id>                         0=alive or cannot-probe, 1=gone
  list-ids                                print every known host_id, one per line
  focus <host_id>                         raise the surface
  prune-orphans <live_csv> <protected_csv>  close vanished surfaces; prints count
  set-status <host_id> <state>            sidebar pill: working|idle|disconnected
  clear-status <host_id>                  remove the aigentry pill
  close-for-sid <sid> [session_json]      lookup + close in one call
  detect-terminal                         print the host terminal adapter name

Adapter selection is unchanged: AIGENTRY_WORKSPACE_HOST forces one, else auto.
EOF
}

verb="${1:-}"
[ "$#" -gt 0 ] && shift

# Explicit arms, not `"wh_$verb" "$@"` — a computed function name off argv turns an
# unknown verb into an arbitrary in-process call against a lib that has 69 of them.
case "$verb" in
  open)            wh_open "$@" ;;
  lookup)          wh_lookup "$@" ;;
  close)           wh_close "$@" ;;
  alive)           wh_alive "$@" ;;
  list-ids)        wh_list_ids "$@" ;;
  focus)           wh_focus "$@" ;;
  prune-orphans)   wh_prune_orphans "$@" ;;
  set-status)      wh_set_status "$@" ;;
  clear-status)    wh_clear_status "$@" ;;
  close-for-sid)   wh_close_for_sid "$@" ;;
  detect-terminal) detect_terminal "$@" ;;
  -h|--help|help)  usage; exit 0 ;;
  "")              usage >&2; echo "wh-cli.sh: no verb given" >&2; exit 64 ;;
  *)               usage >&2; echo "wh-cli.sh: unknown verb '$verb'" >&2; exit 64 ;;
esac
exit $?
