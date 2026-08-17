#!/usr/bin/env bash
# dispatch-cleanup-scheduler.sh — CLI-compatible exec shim onto the TypeScript
#                                 implementation (#899 tranche 4). Verbs, flags,
#                                 exit codes (0/1/4), stdout/stderr lines and
#                                 subprocess argv are unchanged; `--help` still
#                                 prints the Layer-D documentation, which now lives
#                                 in src/cleanup-scheduler/usage.ts — all 37 lines
#                                 of it, `set -euo pipefail` and the PATH line
#                                 included, because `sed -n '2,38p'` printed those
#                                 too and that is what operators have been reading.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * SOURCEABILITY WAS NEVER USED, so nothing was removed for it and there is NO
#     `__probe` surface. Measured before the port:
#     `grep -n '^\s*\(\.\|source\)\s.*dispatch-cleanup-scheduler.sh' tests/` matches
#     nothing — all six guards (T17 T19 T20 T21 T22 T76) invoke it as a subprocess,
#     as do bin/inject-handler.sh and src/reconciler/cli.ts:1318.
#   * THIS SCRIPT SOURCED NO LIBS (zero `.`/`source` lines), so unlike tranches 2a/2c
#     there is no `bash -c '. lib; fn'` door and no bin/wh-cli.sh verb here. Its two
#     children stay children with identical argv: bin/dispatch-registry.py
#     (`get --sid <sid> --pointer keep_alive`, both fail-CLOSED arms intact) and
#     bin/session-cleanup.sh (`<sid>`, behind the same `[ -x ]` gate) — the latter is
#     a TS shim itself now (tranche 2a), and calling it in-process would fork the
#     Rule 28 protected-sid refusal.
#   * TWO PRE-EXISTING DEFECTS ARE FIXED RATHER THAN REPRODUCED, on the
#     orchestrator's decision (docs/reports/2026-08-17-899-t4-scheduler-disposition.md
#     §7 has the measurements; both are Fail-Fast-over-literal-parity calls):
#       D1 A non-numeric `--grace-seconds`/`--minutes` used to truncate
#          state/dispatch/cleanup-pending.json to ZERO BYTES — the whole fleet's
#          pending Layer-D queue, silently, reachable from an unauthenticated inject
#          payload via bin/inject-handler.sh:130-134. The integer is now validated
#          before the file is touched: same exit 1, same empty stdout, one stderr
#          line naming the flag, and the queue byte-unchanged (tests/dispatch/T120
#          block I). Validating that payload at the trust boundary is
#          inject-handler's own ticket.
#       D2 `list` had never run on any CPython (a backslash inside an f-string
#          expression is a compile-time SyntaxError), so the verb was dead from
#          b7829ec onward with zero callers. It now prints the format the code
#          intended and exits 0 (T120 block J pins it).
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh,
#     hitl.sh and open-session.sh; tests/dispatch/T121 pins the workspace layout for
#     this one.
#
# THE PATH HARDENING STAYS HERE, IN BASH, and byte-identical. It is what puts
# `python3` on PATH for bin/dispatch-registry.py's shebang and `node` on PATH for the
# bin/session-cleanup.sh child — both are launched by the node process, so a copy
# inside TS would leave one process generation running with the caller's PATH. This
# script is also reached from launchd via `src/reconciler/cli.ts` every 60s, where
# the inherited PATH is minimal. (Unlike session-cleanup.sh, which must NOT harden
# PATH — see task #400 in its header — this script never runs `telepty`, so the
# stale-homebrew-CLI hazard that argument is about cannot apply here.)
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still locates bin/ helpers (dispatch-registry.py, session-cleanup.sh).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim dispatch-cleanup-scheduler.sh dist/src/cleanup-scheduler/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
