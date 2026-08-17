#!/usr/bin/env bash
# telepty-bus-bridge.sh — CLI-compatible exec shim onto the TypeScript
#           implementation (#899 tranche 4). Flags (--ensure | --run | -h/--help),
#           exit codes, every `BUS_BRIDGE …` line in reconciler.log, the
#           bus-bridge-health.json key set and byte shape, the state-dir paths
#           (bus-bridge.pid, bus-bridge-health.json, bus-bridge.err, <src>.spool)
#           and the env surface are unchanged; --help still prints lines 9-13 of
#           the old header, which now live verbatim in src/bus-bridge/usage.ts.
#
# WHAT THE BRIDGE IS — kept here, because this is the file an operator opens.
#
# The bus→file bridge the surface-event consumers wait for (#847). telepty 0.8.0
# signals, this repo actuates: the daemon broadcasts `surface_orphaned` /
# `surface_mismatched` on ws://127.0.0.1:3848/api/bus and stops there (BOUNDARY:
# telepty signals, the orchestrator acts). The reconciler's
# consume_surface_orphaned / consume_surface_mismatched read JSONL files nobody
# wrote, so both were dormant. This subscribes to the bus and writes exactly those
# two event kinds, one JSON object per line, into exactly those files.
#
# WHAT IT DOES NOT DO, deliberately:
#
# * It never starts, stops or restarts the daemon. `telepty listen` calls the CLI's
#   ensureDaemonRunning(), which STARTS a daemon it cannot reach (cli.js:4136), so
#   every connect is gated on telepty_listing_verdict() == ok first — an already-up
#   daemon makes that call a no-op. Daemon down ⇒ this backs off and stays down too.
# * It never mirrors the bus. The bus carries session_activity_observation at PTY
#   rate; a bridge that wrote all of it would build the second unbounded ledger this
#   ecosystem just spent a release removing. Two event kinds, projected down to the
#   documented consumer contract, and nothing else.
# * It never fabricates or replays. If the socket drops, events emitted during the
#   gap are LOST — telepty's `alreadySignalled` latch means a missed surface_orphaned
#   is never re-emitted (daemon.js:5959). That is honest degradation, not a defect:
#   the reconciler's always-on wh_alive sweep (step 2) covers exactly this window,
#   which is why the event path is allowed to be lossy and the sweep is not. Every
#   gap is counted and timestamped in bus-bridge-health.json and announced as one
#   line in reconciler.log, because a silent gap would be the dishonest version.
#
# THE DRAIN RACE, and why there is no lock.
#
# The consumers drain what they read. The naive bridge appends to the same file the
# consumer truncates, and any event appended between the consumer's last read and
# its truncate is lost with no trace. So the two never share a mutable file:
#
#   bridge  → appends ONLY to <src>.spool, and is the ONLY writer of it (singleton).
#   bridge  → installs the spool as <src> by rename(2), and ONLY when <src> is absent.
#   consumer→ reads <src>, then REMOVES it (rm, not truncate).
#
# <src> exists for the whole of the consumer's read (the rm comes after), so the
# bridge's "absent?" test cannot pass mid-read, so the rename cannot land under a
# reader; and the consumer never removes a file it has not fully read. Lossless in
# both directions with no lock, no lock staleness, and no blocking of a tick — which
# matters because there is no flock(1) on macOS and a shell mutex would need stale-
# holder recovery of its own.
#
# Cost of that choice: an event that arrives while an undrained batch is still
# pending waits in the spool for at most one reconcile tick. The consumers are
# tick-driven anyway (60s), so this adds no latency the actuation path can feel.
#
# Contract changes recorded here (Rule 38 — what was measured):
#
#   * NO test SOURCES this script. Measured before the port:
#     `grep -n '^\s*\(\.\|source\)\s.*telepty-bus-bridge.sh' tests/ bin/ src/` → zero
#     hits, so — as in tranches 2d and 3a, and unlike bin/dispatch.sh (1) and
#     bin/session-cleanup.sh (2a) — there is no sourced-library seam to replace and
#     no `__probe` subcommand is owed. Of the eight guards that name it, T95 drives
#     it end-to-end (parts A–D hermetic, E live-gated) and passes unedited; the other
#     seven touch only the RECONCILER's seams (`AIGENTRY_BUS_BRIDGE=0` in
#     tests/dispatch/lib.sh:27, T98, T102, T103; `BUS_BRIDGE_SH=$NOOP` in T110, T111,
#     T112) and are untouched by construction. T118 adds the CLI/contract parity
#     lines none of them covered, T119 the workspace layout.
#
#   * THE PID CORROBORATION SUBSTRING WIDENED, and it is the only contract change.
#     bridge_pid() cross-checked the pidfile against `ps -p <pid> -o command=` for
#     the literal `telepty-bus-bridge` — its own argv. A ported bridge runs as
#     `node …/dist/src/bus-bridge/cli.js --run` and carries no such literal, so an
#     unchanged check would answer "no bridge running" for a bridge that is alive,
#     and the reconciler's per-tick --ensure would start a second one every 60s —
#     the duplicate-writer scar (#539/#618) the singleton exists to prevent. TWO
#     literals are now accepted, `telepty-bus-bridge` and `bus-bridge/cli.js`, and
#     only those two: a bare `bus-bridge` would corroborate any recycled pid that
#     happened to carry those characters in its cwd or arguments, which is exactly
#     what the ps cross-check refuses. Keeping the first literal is what lets
#     tests/dispatch/T118 run against the ORIGINAL bash at e2c3a36 as well.
#
#   * THE FIFO IS GONE, and with it `$STATE_DIR/bus-bridge.fifo`. The shell needed
#     `mkfifo` + `exec 3<>` because a bash PIPELINE leaves the listener orphaned
#     holding a bus socket and hands back no pid to end deterministically, and
#     because a write-only open would block. child_process.spawn has all three
#     properties natively. Measured before removing it: `bus-bridge.fifo` is
#     referenced NOWHERE outside this script — not in T95, not in
#     src/reconciler/cli.ts, not in bin/init/manifest.mjs. The one log line that
#     went with it ("BUS_BRIDGE cannot create <fifo> — not subscribing") no longer
#     has a way to fire and is not reproduced. The read discipline it existed to
#     support is unchanged: liveness is still decided on the TIMEOUT path only,
#     never straight after a read, so a listener that emitted three events and then
#     died still has all three drained first.
#
#   * python3 IS OFF THIS PATH ENTIRELY. The two heredocs at the old :121-142 and
#     :146-154 (the bus-bridge-health.json read/merge/atomic-write and the single
#     field read) were this script's OWN logic and are TypeScript now — the same
#     removal tranche 2d did to hitl's eight heredocs. There is no shared registry
#     writer on this path to keep as a subprocess, unlike hitl. The health file's
#     BYTE SHAPE is preserved deliberately: python's `json.dump(sort_keys=True)`
#     default separators are ", " and ": " WITH the space, and
#     tests/dispatch/T95:253 greps `'"state": "connected"'` with it.
#
#   * jq IS OFF THIS SCRIPT'S OWN PATH. The one `jq -rc` filter (old :225) is
#     JSON.parse plus an ordered projection now, reproducing jq's `tostring`
#     compaction, the field ORDER written in the filter, and jq's `{sid}`-on-a-
#     missing-key answer of `null`. jq is NOT off the bridge's dependency set: it is
#     still used by bin/lib/telepty-listing.sh, which this script reaches through a
#     `bash -c '. lib; telepty_listing_verdict'` subprocess door and does not
#     reimplement — that lib and the lib/telepty-auth.sh it sources are the ONE
#     token read in this repo (T87).
#
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh,
#     hitl.sh and open-session.sh; tests/dispatch/T119 pins the workspace layout for
#     this one.
#
# PATH HARDENING AND THE HOME RECOVERY STAY HERE, IN BASH, and they are observable.
# The old :63 exported this exact PATH and the old :67 recovered HOME: this script
# can be spawned from a reconciler tick that launchd started with NO HOME, and the
# telepty token resolver in bin/lib/telepty-auth.sh builds its path from $HOME. Both
# must apply to this process AND to every child it spawns — the `bash -c` door onto
# telepty-listing.sh, the `telepty listen` subscriber, and the detached `--run`
# child that `--ensure` starts. The shim is what those inherit from.
#
# Article 17: node + the bash libs under bin/lib/ that every ported peer also keeps.
# macOS + Linux; no OS-specific primitive in this file or in the port (the shell had
# no OS arm, so the port has no `process.platform` branch — enumerated in
# src/bus-bridge/cli.ts's header).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Same launchd recovery the reconciler does: this can be spawned from a reconciler
# tick that launchd started with no HOME, and the token resolver builds its path
# from $HOME.
: "${HOME:=$(cd ~ 2>/dev/null && pwd -P)}"
export HOME

# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still locates bin/ helpers (lib/telepty-listing.sh).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim telepty-bus-bridge.sh dist/src/bus-bridge/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
