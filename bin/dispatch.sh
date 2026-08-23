#!/usr/bin/env bash
# dispatch.sh — CLI-compatible exec shim onto the TypeScript implementation
#               (#899 tranche 1). Flags, exit codes, stdout/stderr lines and
#               subprocess argv are unchanged; `--help` still prints the mode
#               documentation, which now lives in src/dispatch/usage.ts.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * DISPATCH_SH_NO_MAIN=1 sourceable-library mode is GONE. It existed only so
#     tests could `source` this file and call is_ready / verify_delivered /
#     prepare_effective_ref / do_inject as bash functions. Measured before
#     removal: `grep -rn DISPATCH_SH_NO_MAIN` matched nothing outside this file
#     and 12 guards under tests/dispatch/. Those 12 now call the equivalent
#     `__probe` subcommands, so they measure the code production runs instead of
#     a second bash copy of it.
#   * AIGENTRY_DISPATCH_VERIFY_SLEEP_MS (default 5000) is new: it replaces the
#     hard-coded `sleep 5` in verify_delivered, which the guards used to skip by
#     redefining the `sleep` builtin — an override that cannot cross a process
#     boundary.
#   * The two-layout dist resolution moved to bin/lib/node-shim.sh when the
#     tracker shim needed the same logic (#899 tranche 1b). One copy, two shims;
#     tests/dispatch/T99 still pins the workspace layout for this one.
set -euo pipefail
# #930 — homebrew APPENDED: a fallback for `node`/`python3` under launchd, never an
# override of the caller's PATH. It was a prefix, which is #400's mechanism
# (bin/session-cleanup.sh:34-41). Identical in every shim on purpose — a policy that
# differed per shim is how the prefix survived four ports. tests/dispatch/T137 measures
# it and carries the host measurement behind the decision.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# `telepty` resolved EXPLICITLY into the seam the implementation reads, never left to a
# spawn-time PATH lookup; after the append, so the operator's wins where there is one
# and launchd still finds homebrew's. An already-set TELEPTY is never overridden.
: "${TELEPTY:=$(command -v telepty 2>/dev/null || true)}"
[ -n "$TELEPTY" ] || TELEPTY=telepty
export TELEPTY
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked
# entrypoint still locates bin/ helpers (dispatch-registry.py, open-session.sh…).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR
DISPATCH_SCRIPT_DIR="$AIGENTRY_SHIM_SCRIPT_DIR"
export DISPATCH_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim dispatch.sh dist/src/dispatch/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
