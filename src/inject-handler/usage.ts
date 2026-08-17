// Generated from bin/inject-handler.sh lines 2-20 by the #899 tranche-5 port.
//
// The shell `usage()` was `sed -n '2,20p' "$0"` — it printed the script's own comment
// header, and the range stops two lines INSIDE the Usage block, so what every operator
// who ran `--help` has actually seen ends mid-list, after the stdin form and before
// `--body-file` and `--sid` are shown. That truncation is kept VERBATIM here, same as
// src/reconciler/usage.ts's mid-sentence stop and src/cleanup-scheduler/usage.ts's two
// trailing shell lines: `--help` output is a contract, and tidying it would be an
// undeclared change to what an operator reads. tests/dispatch/T124 block A pins all 19
// lines and asserts the truncation, so a later "helpful" completion of the list cannot
// land silently.
//
// The text is kept verbatim INCLUDING the two lines that the port makes only partly
// true — `src/session/inject-parser.js` is now a compile-time import rather than a
// file this script loads, and a recognized envelope carrying an out-of-bounds
// grace_seconds/defer_minutes now exits 1 rather than 0. Both are named in
// bin/inject-handler.sh's header (Rule 38), which is the surface Rule 38 asks for;
// rewriting operator-visible `--help` bytes on top of the behaviour change would make
// block A untestable against the original bash, which is how the parity is measured
// at all.
//
// bin/inject-handler.sh is now an exec shim with no header of its own to print — same
// move as src/dispatch/usage.ts (tranche 1), src/tracker/usage.ts (1b),
// src/cleanup/usage.ts (2a), src/reconciler/usage.ts (2c), src/hitl/usage.ts (2d) and
// src/cleanup-scheduler/usage.ts (4).
export const USAGE = `# inject-handler.sh — Orchestrator-side dispatcher for incoming inject envelopes.
#
# Reads an inject body from stdin (or --body-file), parses it via the compiled
# src/session/inject-parser.js, then takes the per-kind action:
#
#   report          → nonterminal observation + Layer-D cleanup schedule.
#                     telepty#60 Stage A: 0.8.0 has NO outcome protocol, so a
#                     textual REPORT is an ordinary message. It cannot settle a
#                     dispatch; it is recorded as evidence and named as such.
#   cleanup-request → dispatch-cleanup-scheduler.sh schedule <target>
#   extend-lifetime → dispatch-cleanup-scheduler.sh cancel or defer (per defer_minutes)
#   hold            → emit to state/dispatch/holds.log (audit only — orch reads this)
#   test-report     → write state/test-reports/<YYYY-MM-DD>/<session_id>.json (R5a)
#
# The handler exits 0 on any recognized envelope (action taken or logged).
# Unrecognized bodies exit 1 with the parser's error on stderr.
#
# Usage:
#   inject-handler.sh < body.txt`;
