#!/usr/bin/env bash
# inject-handler.sh — CLI-compatible exec shim onto the TypeScript implementation
#                     (#899 tranche 5). Flags (`--body-file`, `--sid`, `-h`/`--help`),
#                     the stdin form, exit codes (0/1/2/4), every stdout and stderr
#                     line, the holds.log record shape, the test-report bytes and all
#                     three children's argv are unchanged; `--help` still prints the
#                     19 lines `sed -n '2,20p'` printed, which now live in
#                     src/inject-handler/usage.ts.
#
# Contract changes recorded here (Rule 38 — what was measured). The reproductions are
# in docs/reports/2026-08-18-899-t5-inject-handler-disposition.md §7:
#
#   * SOURCEABILITY WAS NEVER USED, so nothing was removed for it and there is NO
#     `__probe` surface. Measured before the port:
#     `grep -rnE '^[[:space:]]*(\.|source)[[:space:]].*inject-handler\.sh' .` matches
#     nothing repo-wide — all four guards that drive it (T17, T18, T24, T83) invoke it
#     as a subprocess. It has no production caller at all: nothing in bin/, src/,
#     package.json or launchd reaches it, as docs/adr/2026-07-26-hitl-gate-primitive.md
#     §Context recorded and this port re-measured.
#   * THIS SCRIPT SOURCED NO LIBS (zero `.`/`source` lines), so as in tranches 4 there
#     is no `bash -c '. lib; fn'` door and no bin/wh-cli.sh verb. Its three children
#     stay children with identical argv: bin/dispatch-registry.py (`observe …` ×2),
#     bin/dispatch-cleanup-scheduler.sh (`schedule`/`defer`/`cancel`, 4 call shapes —
#     itself a TS shim since tranche 4, so calling it in-process would fork its
#     fail-CLOSED keep_alive gate) and bin/emit-telemetry.mjs (5 emissions).
#   * THE INLINE `node -e` PARSER BRIDGE AND ALL TEN `python3 -c` FIELD READS ARE GONE,
#     absorbed in-process — they were how bash reached a JSON parser, never a contract.
#     With them goes the `INJECT_PARSER_JS` env seam and its `exit 2 — compiled parser
#     not found` arm: src/session/inject-parser is a compile-time import now, so there
#     is no path left to point at, and a runtime `import()` of an env-supplied JS file
#     would be a NEW code-execution seam. Measured first — `INJECT_PARSER_JS` appeared
#     exactly once in the whole tree, on its own defaulting line, with no override
#     anywhere. The missing-implementation exit 2 is now bin/lib/node-shim.sh's, with
#     its wording; no guard asserted the old text.
#   * TWO PRE-EXISTING DEFECTS ARE FIXED RATHER THAN REPRODUCED, on the orchestrator's
#     decision. src/inject-handler/cli.ts's header carries the full measurements, and
#     tests/dispatch/T124 blocks J-M assert BOTH sides — the bash's behaviour under
#     INJECT_PARITY_ORIGINAL=1 and the port's without it:
#       D1 (task #928) `payload.grace_seconds` and `payload.defer_minutes` reached
#          bin/dispatch-cleanup-scheduler.sh from an UNAUTHENTICATED envelope with no
#          validation, behind `>/dev/null 2>&1 || true`. A non-integer grace used to
#          truncate the fleet's cleanup-pending.json to zero bytes and now makes the
#          scheduler refuse (rc 1) — which `|| true` ate, so the envelope's cleanup was
#          never armed, the ordinary success line still printed, the exit code was
#          still 0, and NOTHING said so. A negative grace wrote a
#          scheduled_cleanup_time in the PAST (an inject that retires a live session
#          immediately); a negative defer pulled a cleanup EARLIER. Both fields are now
#          integers in range (0..86400s, 0..1440m) at the trust boundary, and a
#          scheduler call that fails for any other reason is no longer silent either.
#          Split deliberately: a REJECTED FIELD is a malformed payload — stderr line
#          naming the field, `INJECT_PAYLOAD_REJECTED` in state/dispatch/alerts.log,
#          exit 1, no scheduler call (T24 already required non-zero for a malformed
#          payload); a SCHEDULER rc≠0 on a recognized envelope keeps EXIT 0 and the
#          ordinary stdout line and adds a stderr line plus
#          `CLEANUP_SCHEDULE_FAILED`, because "exits 0 on any recognized envelope" is
#          the contract `--help` prints.
#       D2 `payload.session_id` was pasted into the test-report filename after a
#          `typeof === "string"` check and nothing else, then `mv`'d into place — so
#          `"../../../pwned"` wrote a `.json` file of ATTACKER-CHOSEN CONTENT anywhere
#          the orchestrator user can write, overwriting whatever was there
#          (state/dispatch/active.json, ~/.telepty/config.json). Reproduced end to end
#          before the fix. A session_id must now be a single safe path segment;
#          T124 block M keeps a canary outside TEST_REPORTS_DIR to prove it.
#   * `--help` TEXT IS VERBATIM, including the two lines the port makes only partly
#     true (it names `src/session/inject-parser.js`, and says a recognized envelope
#     exits 0 — which an out-of-bounds field no longer does). Rewriting operator-visible
#     bytes on top of the behaviour change would make T124 block A untestable against
#     the original bash, which is how the parity is measured at all; the deviations are
#     named here instead, which is the surface Rule 38 asks for.
#   * NAMED FOR A TICKET, not fixed (Rule 29 — out of this task's decided scope):
#     src/session/inject-parser.ts's validateTestReport still accepts any string as
#     session_id, so the segment rule benefits this consumer only; the telemetry
#     `--payload-json` is still string-interpolated, so a `"` in a reason still emits
#     invalid JSON (reproduced byte for byte); a failing dispatch-registry.py observe
#     is still swallowed.
#
# THE PATH HARDENING STAYS HERE, IN BASH, and byte-identical. It is what puts `python3`
# on PATH for bin/dispatch-registry.py's shebang and `node` on PATH for the
# bin/dispatch-cleanup-scheduler.sh child — both are launched by the node process, so a
# copy inside TS would leave one process generation running with the caller's PATH.
# NAMED TENSION, pre-existing, mentioned not changed (Rule 29): bin/session-cleanup.sh
# :34-41 records that a hardcoded `/opt/homebrew/bin` prefix is what made task #400 pick
# a stale homebrew telepty. This script never runs `telepty` itself, so that particular
# hazard does not apply here.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint still
# resolves — and so a control workspace arms ITS OWN state/dispatch and writes ITS OWN
# state/test-reports rather than the installed package's (T125).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim inject-handler.sh dist/src/inject-handler/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
