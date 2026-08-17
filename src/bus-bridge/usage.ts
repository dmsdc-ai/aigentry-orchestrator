// Generated from bin/telepty-bus-bridge.sh lines 9-13 by the #899 tranche-4 port.
//
// The shell `usage()` was `sed -n '9,13p' "$0"` — it printed five lines of the
// script's own comment header to STDOUT (exit 0 for -h/--help and for no args,
// exit 2 after the "unknown argument" line on stderr). bin/telepty-bus-bridge.sh
// is now an exec shim with no header to print, so the text lives here VERBATIM
// instead — same move as src/dispatch/usage.ts (tranche 1), src/tracker/usage.ts
// (1b), src/cleanup/usage.ts (2a), src/reconciler/usage.ts (2c), src/hitl/usage.ts
// (2d) and src/session/open-session/usage.ts (3a).
//
// VERBATIM INCLUDES THE LEADING BARE `#`. The shell's line 9 was the blank comment
// line separating the header prose from "# Usage:", and `sed -n '9,13p'` printed
// it, so the first line of --help output has always been a lone "#". It is kept
// because it is what the CLI prints, not because it is pretty;
// tests/dispatch/T118 pins all five lines against the original bash at e2c3a36.
export const USAGE = `#
# Usage:
#   telepty-bus-bridge.sh --ensure  # start it if it is not running (reconciler tick)
#   telepty-bus-bridge.sh --run     # the bridge itself; foreground, long-lived
#   telepty-bus-bridge.sh --help`;
