#!/usr/bin/env bash
# orchestrator-boot.sh — CLI-compatible shim onto the TypeScript implementation
#                        (#899 tranche 5). Every `[orchestrator-boot] …` stderr line,
#                        the reconcile/guard order, the DELETE arms, the SIGKILL-only
#                        rule, the self/ancestor refusal and the exec argv are
#                        unchanged. There is no `--help` and never was; argv is
#                        ignored on the boot path, exactly as `main "$@"` ignored it.
#
# ⚠️ THIS SHIM IS NOT THE USUAL `exec node …` ONE, and the difference is the point.
# The last thing this script does must be a REAL process replacement, so that the
# shell the user's terminal launched BECOMES the bridge — that is what makes
# "the user's terminal IS the bridge" true, and it is half of #539's self-protection
# (the guard runs strictly before the bridge exists). Node has no execve, so a
# `telepty allow` started from TypeScript would be a CHILD, leaving a node generation
# in the middle of the user's TTY forever.
#
# So the work and the exec are split. `node dist/src/orchestrator-boot/cli.js` does the
# registry reconcile and the singleton SIGKILL guard, logs to stderr as before, prints
# the exec argv on STDOUT one element per line and EXITS. This shell — still the
# process the terminal launched — then execs that argv. Node is gone before the bridge
# exists. tests/dispatch/T131 block Q pins the split; block R pins that stdout carries
# the argv and nothing else.
#
# `__probe` is routed straight to node instead, so a test seam can never reach the
# exec (tests/dispatch/T40).
#
# Contract changes recorded here (Rule 38 — what was measured). The reproductions are
# in docs/reports/2026-08-18-899-t5-orchestrator-boot-disposition.md §7:
#
#   * SOURCEABILITY IS GONE. The `[ "${BASH_SOURCE[0]}" = "${0}" ]` guard at the bottom
#     existed so a test could `source` this file and call
#     orchestrator_singleton_guard / orchestrator_registry_reconcile as bash functions
#     and read `ORCH_EXEC_ARGV` as a bash array. Measured before removal: ONE guard did
#     that (tests/dispatch/T40) and NO production caller ever did — a repo-wide
#     `grep -rnE '(^|[^a-z])(\.|source)[[:space:]]+[^[:space:]]*orchestrator-boot\.sh'`
#     matches documentation only, and bin/session-start.sh, bin/install-launchd.sh,
#     bin/dispatch-tracker.sh, bin/orchestrator-bridge-auditor.sh and bin/init/* all
#     merely mention it. T40 now calls the equivalent `__probe singleton-guard`,
#     `__probe registry-reconcile` and `__probe exec-argv`, so it measures the code
#     production runs instead of a second bash copy of it (the T52 shape from tranche
#     2a).
#   * ONE SOURCED LIB, ONE DOOR. bin/lib/telepty-auth.sh — the ONE sanctioned
#     credential resolver (#824) — is called as the shell function it is, via
#     `bash -c '. "$1"; telepty_auth_token'`, the idiom src/tracker/cli.ts and
#     src/cleanup/cli.ts already use. Not re-implemented: tests/dispatch/T87's
#     "exactly one authToken reader under bin/" stays literally true, and its
#     hardcoded call-site list needed no edit.
#   * jq IS GONE (4 invocations) and so are awk (2), grep and head — they were how
#     bash reached a JSON parser and a table scanner, never contracts. Dropping jq has
#     ONE measured behavioural consequence, named as D2 in src/orchestrator-boot/cli.ts:
#     on a host with no `jq` on PATH the ORIGINAL always skipped the #905 reconcile
#     (and blamed the daemon while doing it); the port performs it. T131 block T
#     measures both sides with jq off PATH.
#   * TWO PRE-EXISTING DEFECTS ARE FIXED rather than reproduced, on the orchestrator's
#     decision. Both are in the SIGKILL path, which is why they were not left for a
#     later ticket; src/orchestrator-boot/cli.ts carries the measurements and T131
#     blocks U and V assert BOTH sides (the bash's behaviour under
#     ORCH_BOOT_PARITY_ORIGINAL=1, the port's without it):
#       D3 THE SID WAS A DYNAMIC REGEX. `awk -v s="$ORCH_SID" '$0 ~ ("telepty allow
#          --id " s " ")'` sent the sid through two layers of interpretation.
#          ORIGINAL, measured on a 4-row fixture: `ORCHESTRATOR_SID=orch.tor` SIGKILLED
#          THREE pids (`orchXtor`, `orch1tor` and a process that only mentioned the
#          string), and `ORCHESTRATOR_SID='orch['` died with `awk: nonterminated
#          character class` and then announced `singleton guard done: killed=0` — the
#          duplicate-bridge outcome #539 exists to prevent, reported as a success.
#          PORT: a literal token comparison, which can only ever match narrower.
#       D4 MENTION WAS A BRIDGE. The marker was tested as a substring of the whole
#          `pid ppid command` row, so any process whose command line CONTAINED
#          `telepty allow --id <sid> ` was SIGKILLed — an operator's own
#          `pgrep -fl telepty` while diagnosing a stuck orchestrator is exactly such a
#          process. PORT: argv shape. The executable token must BE telepty (optionally
#          behind a `node` interpreter token — `node /…/bin/telepty allow --id
#          orchestrator …` is the live bridge's measured shape), its first argument
#          must be `allow`, and `--id` must be followed by the sid as a whole token.
#          SCOPE IS THIS KILL PATH ONLY: the two DETECT-ONLY sites that share the
#          marker — bin/session-reconciler.sh:415 and src/bridge-auditor/cli.ts, where
#          tests/dispatch/T127 block H pins the false positive — are unchanged and
#          belong to #931.
#   * ONE NEW REFUSAL, D1: an ORCHESTRATOR_SID containing a control character exits 2
#     instead of booting. The argv crosses back to this shim as newline-delimited text,
#     so a newline in the sid would split one argv element into two and this script
#     would exec a corrupted command line. bash exec'd its own array and had no such
#     hazard and no such check.
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh,
#     hitl.sh, open-session.sh, dispatch-cleanup-scheduler.sh, session-comms-auditor.sh,
#     orchestrator-bridge-auditor.sh and inject-handler.sh; tests/dispatch/T132 pins the
#     workspace layout for this one.
#   * ZERO platform branches: the bash had no `uname`/`OSTYPE` arm to enumerate, and
#     `ps -eo pid,ppid,command` is the same argv on BSD/macOS and GNU/Linux.
#
# PATH IS DELIBERATELY NOT OVERRIDDEN — the original never touched it, and this is the
# script whose whole purpose is to exec `telepty`. bin/session-cleanup.sh:34-41 records
# what a hardcoded `/opt/homebrew/bin` prefix cost in task #400: a stale homebrew
# telepty picked against an older daemon. The bridge this script becomes must be the
# same `telepty` the user's shell resolves.
#
# Usage:
#   bin/orchestrator-boot.sh        # reconcile stale record, guard bridges, then boot
#
# Env:
#   ORCHESTRATOR_SID   orchestrator session id (default: orchestrator) — same source
#                      as bin/dispatch-tracker.sh (Rule 16, no hardcode).
#   TELEPTY / CURL     tool seams (hermetic T40/T131); TELEPTY_PORT (default 3848).
#   KILL_CMD / SINGLETON_PS_CMD / SINGLETON_SELF_PID   guard seams (hermetic T40/T131).
#
# Boot the orchestrator via THIS script, not a bare `telepty allow`. Worker sessions
# boot via bin/session-start.sh. See AGENTS.md.
set -euo pipefail
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint still
# locates bin/lib/telepty-auth.sh (T132).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim orchestrator-boot.sh dist/src/orchestrator-boot/cli.js

# The test seam never boots.
if [ "${1:-}" = "__probe" ]; then
  exec node "$AIGENTRY_SHIM_JS" "$@"
fi

# Reconcile + guard + argv. A non-zero exit here (D1's control-character refusal, or
# node-shim's missing dist) aborts under `set -e` and NOTHING is exec'd.
ORCH_BOOT_ARGV_RAW="$(node "$AIGENTRY_SHIM_JS" "$@")"

# bash 3.2 (macOS CI) has no `mapfile`/`readarray`, and a here-string read loop runs in
# THIS shell, so the array survives to the exec below.
ORCH_EXEC_ARGV=()
while IFS= read -r _orch_boot_arg; do
  [ -n "$_orch_boot_arg" ] && ORCH_EXEC_ARGV+=("$_orch_boot_arg")
done <<< "$ORCH_BOOT_ARGV_RAW"

if [ "${#ORCH_EXEC_ARGV[@]}" -eq 0 ]; then
  echo "orchestrator-boot.sh: the implementation printed no exec argv — refusing to boot" >&2
  exit 2
fi

# Invariant 3: process replacement, in the shell the user's terminal launched.
exec "${ORCH_EXEC_ARGV[@]}"
