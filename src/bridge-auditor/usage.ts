// Generated from bin/orchestrator-bridge-auditor.sh lines 30-40 by the #899
// tranche-5 port (ba899). Disposition §7 D2 has the measurement.
//
// The shell had no `usage()`: the flag arm itself was `sed -n '30,40p' "$0"` —
// eleven lines of the script's OWN comment header, printed to stdout, exit 0, for
// both -h and --help (bash :58). bin/orchestrator-bridge-auditor.sh is now an exec
// shim with no such header to slice, so `sed` there would print NOTHING at all and
// --help would silently become empty. The text lives here instead — same move as
// src/dispatch/usage.ts (tranche 1), src/tracker/usage.ts (1b), src/cleanup/usage.ts
// (2a), src/reconciler/usage.ts (2c), src/hitl/usage.ts (2d),
// src/session/open-session/usage.ts (3a) and src/bus-bridge/usage.ts (T4).
//
// VERBATIM MEANS THE TWO WARTS COME ALONG, both mechanical consequences of a
// hardcoded line range that drifted from the block it meant to print (:32-41):
//
//   * line 1 is a DANGLING SENTENCE FRAGMENT — the tail of the :29-30 cross-OS
//     comment ("# set of bin/orchestrator-boot.sh:48)."), not a heading;
//   * the range ends at :40, so :41 — `TELEPTY  telepty binary (default: telepty)`
//     — is CUT OFF. --help has always advertised one of the two test seams and
//     hidden the other.
//
// They are kept because they are what the CLI prints, not because they are right
// (src/bus-bridge/usage.ts:11-15 keeps a lone leading `#` on the same reasoning).
// Fixing either is a --help contract change Rule 29 does not license here.
// tests/dispatch/T127 pins all 498 bytes against the original bash at c95fb34, in
// four rows: -h, --help, `-h --dry-run` and `--dry-run -h`.
export const USAGE = `# set of bin/orchestrator-boot.sh:48).
#
# Usage:
#   orchestrator-bridge-auditor.sh            # one audit pass (act: HOLD on duplicate)
#   orchestrator-bridge-auditor.sh --dry-run  # detect + log only, never inject
#
# Env:
#   ORCHESTRATOR_SID  orchestrator sid (default: orchestrator) — same source as
#                     bin/orchestrator-boot.sh:36 (Rule 16, no hardcode).
# Test seams (hermetic T57, mirror orchestrator-boot.sh:40-42):
#   SINGLETON_PS_CMD  process lister (default: ps)`;
