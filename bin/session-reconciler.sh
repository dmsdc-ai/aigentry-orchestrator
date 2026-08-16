#!/usr/bin/env bash
# session-reconciler.sh — CLI-compatible exec shim onto the TypeScript implementation
#                         (#899 tranche 2c). Flags (--dry-run / --shadow / --once /
#                         --loop / -h / --help), exit codes (0 tick, 0 aborted sweep,
#                         4 unknown flag), the reconciler.log / alerts.log line
#                         formats, the shadow + escalation JSONL shapes and every
#                         subprocess argv are unchanged; `--help` still prints the
#                         script header, which now lives in src/reconciler/usage.ts.
#
# THE LAUNCHD/SYSTEMD ENTRYPOINT IS UNCHANGED. `~/Library/LaunchAgents/
# com.aigentry.reconciler.plist` runs `/bin/bash <repo>/bin/session-reconciler.sh
# --loop` with KeepAlive + RunAtLoad; that argv still resolves to this file and
# still behaves as the long-lived tick loop. bin/install-launchd.sh only bootstraps
# the label (it does not write the plist), so no installer changed either, and
# bin/init/manifest.mjs already ships this path.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * SOURCEABILITY WAS NEVER USED. Measured before the port:
#     `grep -rn '^\s*\(\.\|source\)\s.*session-reconciler'` over tests/ and bin/
#     matches nothing — no guard and no production caller ever sourced this file.
#     So unlike tranche 1 (dispatch.sh's DISPATCH_SH_NO_MAIN) and tranche 2a
#     (session-cleanup.sh's T52), this port adds NO `__probe` subcommand: there is
#     no in-process test seam to replace. All 13 invoking guards call it as a
#     subprocess and keep working through this shim untouched.
#   * The three sourced libs became subprocess calls, NOT re-implementations:
#     lib/workspace-host.sh via bin/wh-cli.sh (the door built for this in
#     pre-tranche-2) for wh_lookup / wh_close / wh_alive / wh_focus /
#     wh_prune_orphans / wh_set_status; lib/telepty-listing.sh via
#     `bash -c '. <lib>; <fn> …'` for the #835 corroborated-listing verdict AND for
#     telepty_sid_live's three-valued answer; lib/platform.sh via the same idiom for
#     platform::host_power_state / platform::lid_closed / platform::session_pid
#     (Rule 26 — the OS primitive stays in the platform lib, and #909 put
#     parent_pid_for_sid's ps/awk there on purpose).
#   * ONE SEAM CHANGED SHAPE. bin/lib/workspace-host.sh:209 reads `$DRY_RUN`. As a
#     sourced function it saw this script's plain shell variable; as a wh-cli.sh
#     subprocess it needs DRY_RUN in its ENVIRONMENT. src/reconciler/cli.ts exports
#     it into that child and no other (nothing else under bin/ reads DRY_RUN from
#     the environment — bin/orchestrator-bridge-auditor.sh:54 sets its own).
#     Silent and destructive if dropped: an operator's --dry-run would close real
#     cmux workspaces. tests/dispatch/T112 pins it, together with the two seams that
#     were already exports here — AIGENTRY_CMUX_ORPHAN_LEDGER (read by the same
#     adapter) and AIGENTRY_HOST_POWER_STATE (read by the dispatch-tracker child).
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh and session-cleanup.sh;
#     tests/dispatch/T111 pins the workspace layout for this one.
#
# PATH HARDENING AND THE HOME RECOVERY STAY HERE, IN BASH, DELIBERATELY. Both have
# to be in effect for the node process AND for every child it spawns (wh-cli.sh,
# hitl.sh, dispatch-registry.py, the platform/telepty-listing bash doors), and this
# shim is what launchd actually executes. Moving either into TypeScript would leave
# one process generation running with the wrong environment, and
# tests/workspace-host/prune-status.sh greps THIS FILE for the `HOME:=` idiom.
# tests/dispatch/T90 likewise depends on the PATH prepend shadowing a stub, which is
# why it injects its curl through $CURL instead.
#
# Article 17: the implementation is Node + the same shell/Python helpers this script
# always shelled out to. macOS (launchd) + Linux (systemd); no OS branch here.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# launchd does NOT propagate HOME to this daemon (verified: `launchctl print
# gui/<uid>/com.aigentry.reconciler` env has PATH but no HOME). With HOME empty,
# the cmux-prune ownership gate (workspace-host.sh: sandbox=$HOME/.aigentry/
# role-sandbox) resolves to "/.aigentry/role-sandbox" and matches NO real
# workspace cwd → wh_prune_orphans records 0 candidates → orphans never prune
# (regression in 2c12619). Recover HOME from the passwd db — bash `~` expansion
# works even when HOME is unset (getpwuid fallback), so this stays pure-shell (§17).
: "${HOME:=$(cd ~ 2>/dev/null && pwd -P)}"
export HOME

# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still locates bin/ helpers (dispatch-registry.py, wh-cli.sh, lib/*.sh, policy.py,
# session-probe.py, hitl.sh…).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim session-reconciler.sh dist/src/reconciler/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
