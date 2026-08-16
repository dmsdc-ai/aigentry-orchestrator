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
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked
# entrypoint still locates bin/ helpers (dispatch-registry.py, open-session.sh…).
DISPATCH_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export DISPATCH_SCRIPT_DIR
exec node "$DISPATCH_SCRIPT_DIR/../dist/src/dispatch/cli.js" "$@"
