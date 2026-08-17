#!/usr/bin/env bash
# orchestrator-report-target.sh — CLI-compatible exec shim onto the TypeScript
#                     implementation (#899 tranche 5). It resolves the worker→
#                     orchestrator REPORT/HOLD target for #690 (Rule 16: no
#                     hardcoded session id / IP) and prints ONE line on stdout:
#
#   <sid>@<tailnet-ip>   when a Tailscale CGNAT (100.64.0.0/10) address is found
#                        AND the daemon actually answers there — resolves from
#                        both local and cross-machine workers.
#   <sid>                bare fallback (single-machine / no tailnet / nothing
#                        listening on the tailnet address) — resolves locally.
#
# Every arm, both output streams, the exit code (always 0), all five env seams
# (AIGENTRY_ORCHESTRATOR_SID, AIGENTRY_ORCHESTRATOR_HOST, TELEPTY_PORT, CURL,
# REPORT_TARGET_IFACE_CMD), the curl argv, the interface-scan argv and the CGNAT
# regex are unchanged. src/report-target/cli.ts carries the design rationale that
# used to live in this header — why the probe exists at all (#835: reachability was
# INFERRED from an interface having an address, so every worker was handed a target
# that answered nothing), why an explicit host is honoured loudly, why cannot-probe
# is not unreachable, the one-probe cost ceiling, and the cross-machine gap the bare
# fallback leaves.
#
# THERE IS NO --help AND NO ARGV HANDLING, and that is the contract, not an omission.
# Measured before the port: `orchestrator-report-target.sh --help --nonsense foo`
# resolved the target and exited 0. So there is no flag parser to reproduce, no
# `sed -n` header slice, and NO src/report-target/usage.ts — unlike the siblings in
# this tranche that did read argv. tests/dispatch/T129 block H pins it.
#
# Contract changes recorded here (Rule 38 — what was measured). The reproductions are
# in docs/reports/2026-08-18-899-t5-report-target-disposition.md §7:
#
#   * NO BEHAVIOUR CHANGED AT ALL. This is the only port in the tranche with an empty
#     deviation list, so tests/dispatch/T129 passes against BOTH the original bash at
#     b300875 and the port, and carries no `*_PARITY_ORIGINAL` flag — there is
#     nothing for one to select. Re-run it against the original with:
#       git show b300875:bin/orchestrator-report-target.sh > /tmp/rt-orig.sh
#       chmod +x /tmp/rt-orig.sh
#       REPORT_TARGET_UNDER_TEST=/tmp/rt-orig.sh bash tests/dispatch/T129_report_target_parity.sh
#   * SOURCEABILITY WAS NEVER USED, so nothing was removed for it and there is NO
#     `__probe` surface. Measured:
#     `grep -rnE '^[[:space:]]*(\.|source)[[:space:]].*orchestrator-report-target' .`
#     matches nothing repo-wide. Both guards that drive it (T67, T92) invoke it as a
#     subprocess, and so does its one production caller, src/dispatch/cli.ts:595-597.
#   * THIS SCRIPT SOURCED NO LIBS (zero `.`/`source` lines), so there is no
#     `bash -c '. lib; fn'` door and no bin/wh-cli.sh verb. Its children stay children
#     with identical argv: `$CURL` (`-s -o /dev/null -w %{http_code} --connect-timeout
#     1 --max-time 2 http://<h>:<port>/api/meta`), and the interface scan — the
#     REPORT_TARGET_IFACE_CMD seam with NO arguments, or `ifconfig` plus
#     `ip -o -4 addr show` when it is unset, both run unconditionally and in that
#     order. `grep -Eo`, `head -n1` and `command -v` are node-internal now; they were
#     how bash reached a regex and a PATH lookup, never a contract.
#   * `os.networkInterfaces()` IS NOT USED even though it is less code, because
#     REPORT_TARGET_IFACE_CMD must keep accepting an arbitrary executable whose STDOUT
#     IS PARSED. A native lister on the default path plus a text parser on the seam
#     path would be two selection algorithms, and every guard would exercise the one
#     production never runs. Named because it is the choice a reviewer would query.
#   * FOUR LATENT DEFECTS ARE REPRODUCED, NOT FIXED, on the orchestrator's GO —
#     the unanchored CGNAT regex (a scan line `inet6 fe80::9100.72.1.1234` yields the
#     nonexistent `100.72.1.123`), multi-line stdout from a newline in either
#     override (operator-only vars — nothing in the tree sets them — so not a trust
#     boundary), the interface seam's inability to carry arguments (correct by
#     construction: adding argv splitting would ADD an injection surface), and the
#     fact that the stderr notes below are DISCARDED by the only production caller
#     (src/dispatch/cli.ts:54 `capture()` pipes stderr and never reads it), so the
#     degraded-cross-machine warning reaches nobody. That last one is filed as a
#     ticket with its exact two-line diff in the report §6; the fix belongs in
#     src/dispatch/cli.ts, outside this task's Rule 29 scope.
#
# THE PATH HARDENING STAYS HERE, IN BASH, and byte-identical. It is what puts `curl`
# and the interface listers on PATH for the probe and the scan — both are launched by
# the node process, so a copy inside TS would leave one process generation running
# with the caller's PATH. NAMED TENSION, pre-existing, mentioned not changed
# (Rule 29): bin/session-cleanup.sh:34-41 records that a hardcoded `/opt/homebrew/bin`
# prefix is what made task #400 pick a stale homebrew telepty. This script never runs
# `telepty`, so that particular hazard does not apply here.
#
# ⚠️ THIS FILE MUST STAY EXECUTABLE. src/dispatch/cli.ts:595 gates the whole resolve
# on `isExecutable(REPORT_TARGET_SH)`, so a lost mode bit does not degrade the answer,
# it fails the dispatch closed — the resolver is simply skipped and dispatch refuses
# to inject a ref with an unresolved {{ORCHESTRATOR_REPORT_TARGET}}.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still resolves.
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim orchestrator-report-target.sh dist/src/report-target/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
