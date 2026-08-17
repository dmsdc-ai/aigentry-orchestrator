// The AIGENTRY_WH_LEGACY_SPAWN=1 arm of bin/open-session.sh, kept as SHELL
// (#899 tranche 3a; docs/specs/2026-08-16-workspace-host-port.md §2).
//
// WHY THIS IS NOT PORTED. This arm is the per-invocation revert of the cmux spawn
// path — an inline byte-for-byte copy of the devkit original that a rollback can
// reach with an `export`, needing no rebuild and no toolchain. It is the only
// rollback lever on the live spawn path with that property. Re-expressing it in
// TypeScript would put the revert and the thing it reverts in the same compiled
// artifact, which is not a revert; the spec calls preserving it verbatim a hard
// requirement of this tranche and calls deleting it as "duplicate code" exactly the
// drive-by Rule 29 forbids.
//
// So the arm stays bash and cli.ts execs it: same text, same shell options
// (`set -euo pipefail`, which is load-bearing here — `ref=$(… | grep -oE … | head`
// under pipefail decides what an unmatched ref does), same `$cwd`/`$sid`/`$cli_cmd`/
// `$title` values, same stdout (the ref), same exit codes 2 and 3.
//
// THE UNQUOTED `bash -c 'cd $cwd && …'` BELOW IS A PRE-EXISTING INJECTION SITE
// ([MEDIUM] G, docs/reports/2026-07-02-ecosystem-deep-analysis.md:87) and is
// REPRODUCED, not fixed: a port whose bytes differ cannot be proven at parity, and
// the fix is a separate ticket. See cli.ts's header for the second site.
//
// Lines 165-189 and 205-224 of the original, one array element per line so a
// reviewer can diff them against it:
//   git show 736707a:bin/open-session.sh | sed -n '165,189p;205,224p'
//
// The only text that is NOT from the original is the wrapper that reproduces the
// arm's CALLING CONTEXT: the four values the enclosing function used to have in
// scope, a function so `local` has somewhere legal to live, and — load-bearing, not
// cosmetic — the `_ref=$(_legacy_open …)` command substitution the shell called
// open_in_terminal through. MEASURED: errexit behaves differently on either side of
// that substitution. Called directly, `ref=$(… | grep -oE … | head -1)` finding no
// ref aborts the shell on pipefail with exit 1 and the `ERR cmux new-workspace
// failed:` line is never printed; called inside `$( )` — as open-session.sh:267
// always did — errexit does not fire, the `[ -z "$ref" ]` arm runs, and the exit
// code is the documented 2. Reproducing the arm's text without its calling context
// silently turns a 2 into a 1 on the spawn-failure path.
const WAIT_READY: string =
  [
    "_cmux_wait_ready() {",
    "  local ref=\"$1\" cmux_bin=\"${2:-cmux}\"",
    "  local timeout_ms=\"${CMUX_READY_TIMEOUT_MS:-10000}\"",
    "  local interval_ms=\"${CMUX_READY_INTERVAL_MS:-200}\"",
    "  local interval_s; interval_s=$(awk -v ms=\"$interval_ms\" 'BEGIN{printf \"%.3f\", ms/1000}')",
    "  local max_iters=$(( timeout_ms / interval_ms )); [ \"$max_iters\" -lt 1 ] && max_iters=1",
    "  local i=0 lw sh rs",
    "  while [ \"$i\" -lt \"$max_iters\" ]; do",
    "    lw=$(\"$cmux_bin\" list-workspaces 2>/dev/null || true)",
    "    if printf '%s\\n' \"$lw\" | grep -qE \"(^|[[:space:]])${ref}([[:space:]]|$)\"; then",
    "      sh=$(\"$cmux_bin\" surface-health --workspace \"$ref\" 2>&1 || true)",
    "      if printf '%s\\n' \"$sh\" | grep -q 'type=terminal' \\",
    "         && ! printf '%s\\n' \"$sh\" | grep -q '^Error:'; then",
    "        rs=$(\"$cmux_bin\" read-screen --workspace \"$ref\" --lines 1 2>&1 || true)",
    "        if [ -n \"$(printf '%s' \"$rs\" | tr -d '[:space:]')\" ] \\",
    "           && ! printf '%s\\n' \"$rs\" | grep -q '^Error:'; then",
    "          return 0",
    "        fi",
    "      fi",
    "    fi",
    "    i=$((i+1))",
    "    sleep \"$interval_s\"",
    "  done",
    "  return 1",
    "}",
  ].join("\n");

const ARM: string =
  [
    "    # BC4-a rollback switch: force the legacy inline cmux path (devkit original,",
    "    # byte-for-byte) instead of wh_open. CMUX seam: injectable cmux binary so the",
    "    # readiness gate is hermetically testable (BUG-A); defaults to the real `cmux`.",
    "    # cmux --command sends text+Enter; telepty allow runs as the workspace's foreground",
    "    # process. The bash -c 'cd ... && exec ...' wrapper guarantees claude inherits cwd",
    "    # (#311): cmux --cwd only affects the workspace shell, not the wrapped CLI.",
    "    local CMUX_BIN=\"${CMUX:-cmux}\"",
    "    out=$(\"$CMUX_BIN\" new-workspace --cwd \"$cwd\" --command \"bash -c 'cd $cwd && exec telepty allow --id $sid --auto-restart $cli_cmd'\" 2>&1)",
    "    ref=$(echo \"$out\" | grep -oE 'workspace:[0-9]+' | head -1)",
    "    [ -z \"$ref\" ] && { echo \"ERR cmux new-workspace failed: $out\" >&2; exit 2; }",
    "    \"$CMUX_BIN\" rename-workspace --workspace \"$ref\" \"$title\" >/dev/null 2>&1 || true",
    "    # Readiness barrier (BUG-A, Rule 27): return the ref ONLY once the pane surface can",
    "    # accept `send-key`, so the daemon submit never races a not-yet-live socket.",
    "    if ! _cmux_wait_ready \"$ref\" \"$CMUX_BIN\"; then",
    "      echo \"ERR cmux workspace $ref pane not ready after ${CMUX_READY_TIMEOUT_MS:-10000}ms — surface cannot accept send-key (daemon submit would race 'Failed to write to socket'). Not returning a ref for a dead workspace.\" >&2",
    "      \"$CMUX_BIN\" close-workspace --workspace \"$ref\" >/dev/null 2>&1 || true",
    "      exit 3",
    "    fi",
    "    echo \"$ref\"",
    "    return 0",
  ].join("\n");

export const LEGACY_CMUX_SPAWN: string = [
  "set -euo pipefail",
  WAIT_READY,
  "_legacy_open() {",
  '  local cwd="$1" sid="$2" cli_cmd="$3" title="$4" ref out',
  ARM,
  "}",
  '_ref=$(_legacy_open "$@")',
  "printf '%s\\n' \"$_ref\"",
].join("\n");
