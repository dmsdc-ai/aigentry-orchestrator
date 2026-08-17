#!/usr/bin/env bash
# session-comms-auditor.sh — CLI-compatible exec shim onto the TypeScript
#                            implementation (#899 tranche 4). It takes no arguments
#                            and never did; exit codes (0 pass complete, 5 one or
#                            more HOLD escalations could not be delivered), stderr
#                            lines, telemetry bytes, state-file bytes, the byte
#                            cursor and the `telepty inject` argv are unchanged.
#
# Usage: session-comms-auditor.sh   # one audit pass over new peer-inject log lines
#
# Contract changes recorded here (Rule 38 — what was measured). The reproductions
# are in docs/reports/2026-08-17-899-t4-comms-auditor-disposition.md §7:
#
#   * SOURCEABILITY WAS NEVER USED, so nothing was removed for it and there is NO
#     `__probe` surface. Measured before the port:
#     `grep -rn '^\s*\(\.\|source\)\s.*session-comms-auditor\.sh' tests/` matches
#     nothing — both guards (T45, T91) invoke it as a subprocess, as does
#     src/reconciler/cli.ts:1292-1293 (tick step 0c, `TELEPTY` in the child env, no
#     argv). Nothing under bin/ invokes it at all.
#   * THIS SCRIPT SOURCED NO LIBS (zero `.`/`source` lines), so unlike tranches
#     2a/2c there is no `bash -c '. lib; fn'` door and no bin/wh-cli.sh verb. Its
#     one child stays a child with identical argv: `"$TELEPTY" inject --submit
#     <orch-sid> "<one text argument>"` — the HOLD text stays ONE argv element, so
#     an attacker-controlled excerpt can never become a flag or a word split.
#   * THERE IS NO usage.ts AND NO `--help`, unlike every sibling shim. Measured:
#     the shell script read no argv whatsoever
#     (`grep -nE '\$[1-9]|\$@|\$\*|\$#|getopts|case "\$'` matched nothing), and
#     `--help` and `bogus --x` each ran a full audit pass. There was no --help
#     surface to move into a usage.ts, and inventing one would be a contract change
#     Rule 29 does not license. Every sibling has a usage.ts because every sibling
#     had a `usage()`; this one did not.
#   * ONE PRE-EXISTING DEFECT IS FIXED rather than reproduced, on the
#     orchestrator's decision (disposition §7 D1 has the 3-tick reproduction):
#       D1 One untrusted peer-inject line PERMANENTLY disabled this guardrail. A
#          line that is valid JSON but not an object, or an envelope whose
#          `thread_id` contained `/`, killed the python pass with a traceback
#          BEFORE the byte cursor was written — so every later peer inject went
#          unaudited forever, the pre-poison violation re-injected the SAME HOLD
#          into the orchestrator inbox every 60s, and src/reconciler/cli.ts:1293
#          folded it into one `ERR comms-auditor non-zero (continuing)` line. One
#          inject bought an unaudited peer lane. Each record now classifies inside
#          its own try/catch (an unexpected throw emits
#          `peer_audit_record_skipped`), the cursor still advances, and a
#          `thread_id` containing `/` — a path-traversal vector into
#          state/session-comms — is refused as the malformed envelope it is and
#          escalated. tests/dispatch/T122 blocks K and L.
#   * TWO DEFECTS ARE REPRODUCED, NOT FIXED (Rule 29), both named in
#     src/comms-auditor/cli.ts's header with their measurements: D2, an empty
#     `from`/`to` collapses the tab-delimited HOLD fields so the HOLD names the
#     excerpt as the sender (T122 block M pins the garbled text); and the
#     fail-OPEN that silently replaces an unparseable `<pairkey>__<thread>.json`
#     with a fresh `rounds: 1` record.
#   * TWO DEVIATIONS ARE NAMED, NOT SILENT: D3, the bash `fcntl.flock` is not
#     reproduced because it was measured DECORATIVE (3/3 runs: it waits 1.53s and
#     still loses the update, since `os.replace` swaps the inode the lock is held
#     on — `rounds: 1`, not 2). The two-writer fix spans bin/ask.sh, which is not
#     this task's Rule 29 surface, and is the orchestrator's own ticket. D4, the
#     excerpt of a non-string body renders JSON-style rather than python's
#     `str(dict)`, because JSON.parse cannot tell `1.0` from `1`.
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh,
#     hitl.sh, open-session.sh and dispatch-cleanup-scheduler.sh;
#     tests/dispatch/T123 pins the workspace layout for this one.
#
# THE PATH HARDENING STAYS HERE, IN BASH, and byte-identical. It is what resolves
# the default literal `telepty` for the node process's child, and this script is
# reached from launchd via src/reconciler/cli.ts every 60s, where the inherited PATH
# is minimal. NAMED TENSION, pre-existing, mentioned not changed (Rule 29):
# bin/session-cleanup.sh:34-41 records that a hardcoded `/opt/homebrew/bin` prefix
# is exactly what made task #400 pick a stale homebrew telepty against an older
# daemon. This script has carried that prefix since #533 and does run `telepty`, so
# the same hazard applies to it; removing the prefix is a separate call with its own
# blast radius. Both guards are immune either way because tests/dispatch/lib.sh:45
# exports an absolute `TELEPTY`, which wins over PATH.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still resolves — and so a control workspace audits its OWN state/session-comms
# and state/dispatch rather than the installed package's (T123).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim session-comms-auditor.sh dist/src/comms-auditor/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
