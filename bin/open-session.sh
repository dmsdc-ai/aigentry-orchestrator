#!/usr/bin/env bash
# open-session.sh — CLI-compatible exec shim onto the TypeScript implementation
#           (#899 tranche 3a, under docs/specs/2026-08-16-workspace-host-port.md
#           §2 + §5 row T3a; the user's 2026-08-17 decision was T3a GO, T3b
#           DECLINED). Flags (--track --name --role --task --cli --cwd
#           --extra-flags --auto-cleanup-on-exit -h/--help), exit codes, the single
#           stdout ref line, every stderr line, the ~/.aigentry/open-session.log
#           line and the env surface are unchanged; --help still prints lines 2-30
#           of the old header, which now live verbatim in
#           src/session/open-session/usage.ts.
#
# THE ADAPTER IS NOT PORTED. bin/lib/workspace-host.sh stays bash by decision, and
# this script's three reaches into it (detect_terminal, wh_open, wh_set_status) go
# through bin/wh-cli.sh — the subprocess door built for exactly this, whose
# equivalence to the sourced functions tests/dispatch/T104 pins for all 11 verbs.
# platform::hold_awake / platform::session_pid go through the
# `bash -c '. platform.sh; fn'` door already in production at
# src/reconciler/cli.ts:340. Nothing under bin/lib/ is touched by this tranche.
#
# #751: this entrypoint now refuses AIGENTRY_WH_LEGACY_SPAWN=1. That inline
# rollback path cannot propagate the selected CLI and external daemon lifecycle.
# The historical implementation remains in src/session/open-session/legacy-spawn.ts;
# invoking compiled internals directly is not this guarded entrypoint.
# Worker bootstrap selection belongs to bin/lib/workspace-host.sh. Unsupported
# installed telepty versions fail closed; selecting a candidate does not install
# it or authorize a daemon restart. Installed/cross-OS acceptance is still required.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * NONE to the CLI. Measured before the port: no test SOURCES this script
#     (`grep -n '^\s*\(\.\|source\)\s.*open-session' tests/` → zero), so unlike
#     bin/dispatch.sh (tranche 1) and bin/session-cleanup.sh (2a) there is no
#     sourced-library seam to replace and no `__probe` subcommand is owed. Of the
#     twelve guards that name it, two drive it end-to-end (T39 readiness barrier,
#     T56 sidebar pill — both unedited and both still green), five substitute a
#     fake open-session of their own (T28 T47 T49 T51 T60 — untouched by
#     construction), four mention it in prose only (lib.sh T53 T55 T104), and one
#     grepped this file's TEXT: T101 part F, retargeted to the TS source in the
#     same commit, because the wiring it asserts moved and a grep that still
#     passed against a shim would be asserting nothing.
#   * A flag with no value (`--track` last on argv) was `"$2"` under `set -u`: a
#     LOCALE-DEPENDENT "$2: unbound variable" on stderr and exit 1. Exit 1 is
#     reproduced; the message is the implementation's own.
#   * The two `jq -r` config reads (~/.aigentry/config.json by --role,
#     ~/.claude.json for the trust warning) are JSON.parse now — the same removal
#     of an external JSON tool from the script's OWN logic that tranche 2d did to
#     hitl's python3 heredocs. jq is NOT off the spawn path: bin/lib/
#     workspace-host.sh still uses it behind wh-cli.sh.
#   * `eval cwd="$cwd"` (old :118) and the unquoted `bash -c 'cd $cwd && …'` in the
#     legacy arm (old :212) are pre-existing injection sites recorded as [MEDIUM] G
#     in docs/reports/2026-07-02-ecosystem-deep-analysis.md:87. They are
#     REPRODUCED, not fixed — a port whose bytes differ cannot be proven at parity.
#     Separate ticket.
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh
#     and hitl.sh; tests/dispatch/T117 pins the workspace layout for this one.
#
# PATH HARDENING AND THE SYMLINK-RESOLVING SCRIPT_DIR STAY HERE, IN BASH. The PATH
# export was on the old :31 and it is observable: it is how `command -v cmux`
# resolves the REAL cmux for the wh_set_status pill (tests/dispatch/T56's header
# turns on precisely that). _resolve_src was the old :37-49 and exists because the
# entrypoint has been a symlink into this file — `cd + pwd` alone does not follow
# one, and both wh-cli.sh and lib/platform.sh are resolved relative to the result.
#
# Article 17: node + the bash libs under bin/lib/ that every ported peer also keeps.
# macOS + Linux.
set -euo pipefail
# #930 — homebrew APPENDED: a fallback for `node`/`python3` under launchd, never an
# override of the caller's PATH. It was a prefix, which is #400's mechanism
# (bin/session-cleanup.sh:34-41). Identical in every shim on purpose — a policy that
# differed per shim is how the prefix survived four ports. tests/dispatch/T137 measures
# it and carries the host measurement behind the decision.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# `telepty` resolved EXPLICITLY into the seam the implementation reads, never left to a
# spawn-time PATH lookup; after the append, so the operator's wins where there is one
# and launchd still finds homebrew's. An already-set TELEPTY is never overridden.
: "${TELEPTY:=$(command -v telepty 2>/dev/null || true)}"
[ -n "$TELEPTY" ] || TELEPTY=telepty
export TELEPTY

# The legacy inline bridge re-resolves telepty and cannot carry the external
# lifecycle contract. Refuse the bypass before creating any terminal surface.
if [ "${AIGENTRY_WH_LEGACY_SPAWN:-0}" = "1" ]; then
  echo "open-session.sh: legacy spawn cannot enforce external daemon lifecycle; unset AIGENTRY_WH_LEGACY_SPAWN" >&2
  exit 2
fi

# Resolve symlinks to find the real script directory (POSIX-portable), verbatim
# from the shell implementation.
_resolve_src() {
  local src="$1"
  while [ -L "$src" ]; do
    local target
    target="$(readlink "$src")"
    case "$target" in
      /*) src="$target" ;;
      *)  src="$(cd "$(dirname "$src")" && pwd -P)/$target" ;;
    esac
  done
  printf '%s\n' "$src"
}
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "$(_resolve_src "${BASH_SOURCE[0]}")")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR
# cleanup_on_exit resolved session-cleanup.sh off `dirname "${BASH_SOURCE[0]}"` —
# the INVOKED path, symlinks unresolved, which is not always SCRIPT_DIR. Exported
# so that difference survives the port rather than being quietly normalised away.
AIGENTRY_SHIM_SCRIPT_PATH="${BASH_SOURCE[0]}"
export AIGENTRY_SHIM_SCRIPT_PATH

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim open-session.sh dist/src/session/open-session/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
