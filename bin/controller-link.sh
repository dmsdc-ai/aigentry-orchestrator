#!/usr/bin/env bash
# controller-link.sh — exec shim onto the TypeScript implementation of controller-link v1
#                      (task 1291, SPEC §8, §9.4): ingest, bind, refuse, reply, status,
#                      probe, close. Everything (arguments, output, exit codes) lives in
#                      src/controller-link/cli.ts; `--help` prints the usage.
#
# A message from the peer controller carries no authority: this command never registers a
# task, never dispatches, never touches credentials. Its only child is telepty (inject to the
# configured peer controller, and `injects --json` on this machine's own audit log).
#
# Same shape as every other bin/ exec shim (bin/hitl.sh, bin/orchestrator-report-target.sh):
# homebrew APPENDED to PATH as a fallback (#930), `telepty` resolved explicitly into the
# TELEPTY seam (never overriding an already-set TELEPTY), and the compiled entry resolved
# by bin/lib/node-shim.sh in both the repo/package layout and a control workspace.
set -euo pipefail
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
: "${TELEPTY:=$(command -v telepty 2>/dev/null || true)}"
[ -n "$TELEPTY" ] || TELEPTY=telepty
export TELEPTY
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim controller-link.sh dist/src/controller-link/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
