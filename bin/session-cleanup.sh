#!/usr/bin/env bash
# session-cleanup.sh — CLI-compatible exec shim onto the TypeScript implementation
#                      (#899 tranche 2a). Flags, exit codes (0/1/2/3/4),
#                      stdout/stderr lines and subprocess argv are unchanged;
#                      `--help` still prints the removal documentation, which now
#                      lives in src/cleanup/usage.ts.
#
# Contract changes recorded here (Rule 38 — what was measured):
#   * SOURCEABILITY IS GONE. The `[ "${BASH_SOURCE[0]}" = "${0}" ]` guard at the
#     bottom existed so tests could `source` this file and call
#     kill_parent_telepty_allow / pid_is_self_or_ancestor as bash functions.
#     Measured before removal: ONE guard did that (tests/dispatch/T52) and no
#     production caller ever did — bin/session-reconciler.sh:60,
#     bin/dispatch-cleanup-scheduler.sh:45 and bin/open-session.sh:259 all invoke
#     it as a subprocess. T52 now calls the equivalent `__probe` subcommands, so
#     it measures the code production runs instead of a second bash copy of it.
#   * The three sourced libs became subprocess calls, NOT re-implementations:
#     lib/workspace-host.sh via bin/wh-cli.sh (the door built for this in
#     pre-tranche-2), lib/telepty-auth.sh and lib/telepty-listing.sh via
#     `bash -c '. <lib>; <fn>'` — the idiom src/tracker/cli.ts already uses for the
#     credential resolver. tests/dispatch/T87 keeps holding: exactly one
#     `authToken` reader under bin/, and it is still bin/lib/telepty-auth.sh.
#     Its call-site assertion now names src/cleanup/cli.ts, the file that resolves
#     the credential, exactly as tranche 1b re-pointed it at src/tracker/cli.ts.
#   * The kill selector is a LITERAL substring match where the shell built an ERE
#     from the sid (`awk '$0 ~ ("telepty allow --id " s " ")'`). Identical for every
#     sid without a regex metacharacter, strictly narrower for one with a `.`; a
#     miss falls through to the existing "already exited?" arm, so the deviation
#     can only under-kill, never SIGTERM a different session.
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh and dispatch-tracker.sh; tests/dispatch/T105 pins the workspace
#     layout for this one.
#
# PATH IS DELIBERATELY NOT OVERRIDDEN. dispatch.sh's shim hardens PATH; this one
# must not. A previous hardcoded PATH="/opt/homebrew/bin:..." here made the script
# pick a stale homebrew telepty (v0.4.0) against a v0.3.5 daemon; the resulting
# "Daemon version mismatch" banner contaminated jq stdin and produced "Invalid
# numeric literal at line 1, column 2" (task #400). require_deps is the gate — it
# fails loudly (exit 2) if telepty/jq are missing from the inherited PATH — and
# tests/dispatch/T27 stubs telepty/cmux/curl on PATH precisely because this script
# does not override it.
set -euo pipefail
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still locates bin/ helpers (dispatch-registry.py, wh-cli.sh, lib/*.sh).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim session-cleanup.sh dist/src/cleanup/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
