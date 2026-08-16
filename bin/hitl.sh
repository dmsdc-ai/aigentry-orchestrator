#!/usr/bin/env bash
# hitl.sh — CLI-compatible exec shim onto the TypeScript implementation
#           (#899 tranche 2d, under ADR 2026-07-26-hitl-gate-primitive's
#           Amendment (2026-08-16, #925), which freed the implementation
#           language and left the CLI contract binding). Verbs
#           (open | list | show | approve | reject | remind | --help), flags,
#           exit codes, stdout/stderr lines, the gate record schema, the
#           gate-id derivation, the pending/→decided/ directory index and the
#           env surface are unchanged; `--help` still prints the header
#           documentation, which now lives verbatim in src/hitl/usage.ts.
#
# THIS FILE MUST REMAIN AN EXECUTABLE FILE AT THIS PATH (ADR amendment
# invariant 9). Both producers gate on it — src/reconciler/cli.ts:482
# (`executable(HITL_SH)` ⇒ HITL_GATE_UNAVAILABLE) and src/tracker/cli.ts:453 —
# and it is a literal entry in bin/init/manifest.mjs, which
# tests/packaging/T96_ship_set_agreement.sh holds against both the real tarball
# and `git ls-files`. A src/-only module would take the gate offline in every
# control workspace. The shim is not ceremony; it is the contract.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * NONE to the CLI. Measured before the port: T61/T62/T63/T64/T65/T74 drive
#     this script as a subprocess and NONE of them sources it or reaches into
#     its functions, so there is no sourced-library seam to replace — no
#     `__probe` subcommands are owed here, unlike bin/dispatch.sh (tranche 1)
#     and bin/session-cleanup.sh (2a). This is the cheapest port of the tranche.
#     All six guards pass unedited; T113 adds the CLI-parity lines none of them
#     covered, T114 the workspace layout, T115 the gate-id byte identity.
#   * python3 IS STILL ON THE GATE PATH, and the PR must not claim otherwise.
#     The registry status write still shells to bin/dispatch-registry.py with
#     identical argv, exactly as src/tracker/cli.ts:160 and
#     src/dispatch/cli.ts:243 already do — one registry writer, no second copy.
#     What the port removed is python3 from hitl's OWN logic: the eight heredocs
#     at the old hitl.sh:48,53,68,85,150,171,221,347 (timestamps, sha256, JSON
#     read/modify/write, options parsing, listing, remind arithmetic). The
#     notify path stays a `telepty inject --submit-force …` subprocess with
#     identical argv.
#   * The `--source` charset check is whole-string where the shell's
#     `grep -Eq '^[A-Za-z0-9._-]+$'` matched per LINE. Strictly narrower: it can
#     only refuse a source containing a newline, which the shell accepted and
#     turned into a filename with a newline in it. Same die() message.
#   * DISPATCH_STATE_DIR was read into DISPATCH_DIR at the old hitl.sh:32 and
#     never used anywhere in the script. The read is dead and is not reproduced
#     (Rule 29 — noted, not deleted from history); T113 pins that the variable
#     is inert on both implementations.
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh and
#     session-reconciler.sh; tests/dispatch/T114 pins the workspace layout for
#     this one.
#
# PATH IS DELIBERATELY STILL HARDENED, unlike session-cleanup.sh's shim. The old
# hitl.sh:25 exported this exact PATH on every invocation and it is observable:
# it is how `command -v telepty` and bin/dispatch-registry.py resolve for a gate
# opened by the launchd reconciler tick. Dropping it would have been a behaviour
# change dressed as a cleanup (Rule 29).
#
# Article 17: node + the shared bin/dispatch-registry.py seam every ported peer
# also keeps. macOS + Linux. Rationale — including why "shell + Python stdlib
# only" (the line --help still prints, kept verbatim as contract) no longer
# binds — is in docs/adr/2026-07-26-hitl-gate-primitive.md, section
# "Amendment (2026-08-16, #925)".
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked
# entrypoint still locates bin/ helpers (dispatch-registry.py).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim hitl.sh dist/src/hitl/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
