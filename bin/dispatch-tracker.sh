#!/usr/bin/env bash
# dispatch-tracker.sh — CLI-compatible exec shim onto the TypeScript
#               implementation (#899 tranche 1b). Subcommands (check | status |
#               prune | --help), exit codes, stdout/stderr lines, log lines and
#               subprocess argv are unchanged; `--help` still prints the header
#               documentation, which now lives in src/tracker/usage.ts.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * NONE to the CLI. Measured before the port: 19 guards under tests/dispatch/
#     invoke this script (t_run_tracker) and 0 source it, so there is no
#     sourced-library seam to replace (tranche 1's `__probe` has no counterpart
#     here). bin/session-reconciler.sh:700 is the only non-test caller
#     (`"$TRACKER_SH" check`); bin/orchestrator-boot.sh and
#     bin/orchestrator-report-target.sh only name this file in comments.
#   * The daemon credential is still resolved by bin/lib/telepty-auth.sh and
#     nowhere else — src/tracker/cli.ts invokes that shell function rather than
#     re-reading the config, so tests/dispatch/T87's "exactly one authToken
#     reader under bin/" stays literally true. T87's call-site assertion now
#     names src/tracker/cli.ts, which is where the poll lives.
#
# Article 17: the implementation is Node + the same shell/Python helpers this
# script always shelled out to (dispatch-registry.py, session-probe.py,
# policy.py, dispatch.sh, hitl.sh). macOS + Linux.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked
# entrypoint still locates bin/ helpers (dispatch-registry.py, policy.py,
# lib/telepty-auth.sh…).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim dispatch-tracker.sh dist/src/tracker/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
