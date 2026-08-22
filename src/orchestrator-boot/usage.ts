// The `--help` text for bin/orchestrator-boot.sh (#934). NEW SURFACE, not a port:
// there was no `--help` here and never had been, which is the whole of #934.
//
// It lives in its own module for the reason every other tool in this repo does it —
// src/dispatch/usage.ts, src/tracker/usage.ts, src/cleanup/usage.ts,
// src/reconciler/usage.ts, src/hitl/usage.ts, src/session/open-session/usage.ts,
// src/bus-bridge/usage.ts and src/bridge-auditor/usage.ts — the shim is an exec
// wrapper with no comment header for a `sed -n '30,40p' "$0"` arm to slice, so a
// usage that lived in the shell would print nothing at all.
//
// TWO THINGS THIS TEXT MUST KEEP DOING, both of them the incident of 2026-08-18:
//
//   1. SAY THAT A BARE INVOCATION ACTS. The orchestrator ran
//      `bin/orchestrator-boot.sh --help | head -2` as a smoke check and got the real
//      boot — reconcile, SIGKILL guard, exec — because argv was not read at all. A
//      usage that documents the flags and stays quiet about what happens with NO
//      flag would leave that reading of the script intact.
//   2. NAME EVERY SEAM. src/bridge-auditor/usage.ts:18-21 records what the other
//      failure looks like: a hardcoded `sed` range that drifted one line short, so
//      its `--help` advertised SINGLETON_PS_CMD and hid TELEPTY. tests/dispatch/T134
//      block B reads the seam list back out of the COMPILED implementation and fails
//      if a seam is added here without a line below, so that cannot happen twice.
export const USAGE = `orchestrator-boot.sh — boot the orchestrator (control tower) bridge (#539, #905).

Usage:
  bin/orchestrator-boot.sh              BOOTS. With no flag this script ACTS: it
                                        reconciles a stale registry record for the
                                        sid, SIGKILLs stale bridges for it, and then
                                        REPLACES this shell with 'telepty allow' —
                                        a bare invocation is not an inspection.
  bin/orchestrator-boot.sh --help, -h   this text on stdout; exit 0. Nothing is
                                        listed, killed, deleted or exec'd.
  bin/orchestrator-boot.sh --dry-run    the read-only half only: resolve the sid,
                                        read the registry record, scan the process
                                        table, then report the reconcile verdict, the
                                        pids it WOULD SIGKILL (and why each other row
                                        was skipped), and the argv it WOULD exec.
                                        exit 0. No DELETE, no kill, no exec.

Booting requires an EMPTY argv. Any argument at all — a flag, a typo, anything —
takes a non-booting path, so inspecting this script cannot start a control tower.

Env:
  ORCHESTRATOR_SID          orchestrator session id (default: orchestrator) — same
                            source as bin/dispatch-tracker.sh (Rule 16, no hardcode).
                            A control character in it is refused (exit 2) on every
                            path but --help: the exec argv crosses back to the shim
                            as text and could not survive the round trip.
  TELEPTY                   telepty binary for 'list --json' (default: telepty). The
                            bridge itself is exec'd from PATH, deliberately unpinned.
  CURL                      http client for the registry DELETE (default: curl).
  TELEPTY_PORT              telepty daemon port (default: 3848).
  KILL_CMD                  killer (default: kill). SIGKILL only, never SIGTERM.
  SINGLETON_PS_CMD          process lister (default: ps).
  SINGLETON_SELF_PID        pid the self/ancestor refusal walks up from (default:
                            this process). Never kills itself or any ancestor (#539).
  AIGENTRY_SHIM_SCRIPT_DIR  bin/ directory, exported by the shim so a symlinked
                            entrypoint still locates bin/lib/telepty-auth.sh.

Boot the orchestrator via THIS script, not a bare 'telepty allow'. Worker sessions
boot via bin/session-start.sh. See AGENTS.md.`;
