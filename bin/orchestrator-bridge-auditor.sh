#!/usr/bin/env bash
# orchestrator-bridge-auditor.sh — CLI-compatible exec shim onto the TypeScript
#                                  implementation (#899 tranche 5). argv
#                                  (`--dry-run`, `-h`/`--help`), exit codes (0 pass,
#                                  4 unknown argument), the `--help` bytes, the
#                                  alerts.log and stderr alert lines, and the
#                                  `telepty inject` argv are unchanged.
#
# Warn-only duplicate orchestrator-bridge detector (tq#620, the belt for the #618
# recurrence), wired into the reconcile tick at step 0d
# (src/reconciler/cli.ts:1300-1301). See src/bridge-auditor/cli.ts for the whole
# header; the measurements behind every line below are in
# docs/reports/2026-08-18-899-t5-bridge-auditor-disposition.md.
#
# ⚠️ HARD CONSTRAINT — WARN, NEVER KILL (#606). Orchestrator bridge cleanup is
# USER-ONLY: a background reconcile process is neither the user nor an ancestor of
# either bridge, so it cannot apply bin/orchestrator-boot.sh's self/ancestor
# protection and could kill the LIVE bridge. The port adds NO kill path — the two
# children are `ps` and `telepty inject`, and `kill -9` appears only inside the HOLD
# text a human reads. tests/dispatch/T127 block K asserts that twice (a `kill`
# recorder stub that must stay empty, plus a static scan of the compiled JS for
# signal primitives); T57 block E is the original assertion and still passes.
#
# Usage:
#   orchestrator-bridge-auditor.sh            # one audit pass (act: HOLD on duplicate)
#   orchestrator-bridge-auditor.sh --dry-run  # detect + log only, never inject
#
# Env:
#   ORCHESTRATOR_SID  orchestrator sid (default: orchestrator)
# Test seams (hermetic T57/T127):
#   SINGLETON_PS_CMD  process lister (default: ps)
#   TELEPTY           telepty binary (default: telepty)
#   AUDITOR_NOW       clock override
#
# Contract changes recorded here (Rule 38 — what was measured):
#
#   * `--help` WAS `sed -n '30,40p' "$0"` — a slice of this file's OWN comment
#     header, which this shim no longer has, so `sed` here would print NOTHING. The
#     498 bytes moved to src/bridge-auditor/usage.ts VERBATIM, including the two
#     warts that hardcoded range carries: it opens on a dangling sentence fragment
#     ("# set of bin/orchestrator-boot.sh:48).") and ends one line early, so the
#     `TELEPTY` seam has always been advertised nowhere. Same move as
#     src/bus-bridge/usage.ts:11-15. The `Usage:`/`Env:` block above is this shim's
#     own documentation and is NOT what `--help` prints. T127 block C pins all 498
#     bytes in all four flag positions.
#   * ONE PRE-EXISTING DEFECT IS FIXED rather than reproduced, on the orchestrator's
#     GO (disposition §7 D1 has the reproduction):
#       D1 An unwritable $DISPATCH_STATE_DIR SUPPRESSED the duplicate-bridge HOLD.
#          `emit_alert` was `printf … | tee -a "$ALERTS_LOG" >&2`; the `mkdir -p`
#          was best-effort but the `tee` was not, so under `set -euo pipefail` a tee
#          that could not open alerts.log failed the pipeline and killed the script
#          FIVE LINES BEFORE the inject. Measured with the state dir under a regular
#          file: rc 1, `tee: …: Not a directory`, and no inject — the detector had
#          already succeeded and only the alarm was lost, invisibly, because
#          src/reconciler/cli.ts:1301 discards both stdio streams and folds the
#          non-zero into one `ERR bridge-auditor non-zero (continuing)` line. The
#          append is now best-effort like the mkdir already was and the pass
#          continues to the inject. T127 block J measures it from both sides.
#   * D3 IS NOW FIXED (#931), and `emit_alert` still runs its mkdir per call. D3 was:
#     the marker is tested against the whole `command` column so a process that merely
#     MENTIONS `telepty allow --id <sid> ` counts as a bridge (measured in the wild — a
#     grep for the marker returned 3 hits where a clean snapshot returned 1, the extras
#     being the measuring shell's own argv). Because likely-stale=oldest then selects
#     the oldest of that set, the HOLD named the LIVE long-lived bridge as the one to
#     kill. It is an argv-SHAPE match now, the same matcher the kill site in
#     src/orchestrator-boot/cli.ts already used. T127 block H asserts the decision,
#     with an ORIGINAL arm still recording the bash's behaviour; H2/H3 cover the
#     measured hazard and the real-duplicate case. Still warn-only (#606).
#   * ONE DEVIATION IS NAMED, NOT SILENT: D4, ORCHESTRATOR_SID is matched LITERALLY
#     here and was a DYNAMIC REGEX in bash (`awk -v s=…` then `$0 ~ ("… --id " s
#     " ")`). Measured on the original: `orch.tor` counted three unrelated sids and
#     HOLDed on all of them, and `orch[` killed the pass at rc 2 with `awk:
#     nonterminated character class` — a code that now means "dist not found". The
#     literal only ever matches NARROWER and a real bridge carries its sid
#     literally, so no duplicate can be missed. T127 block I pins both rows from
#     both sides.
#   * python3 IS GONE. The one `python3 -c` was a clock read, so this script's
#     "pure bash + telepty, no python" claim is finally true (T5's Article 17 win).
#   * ZERO platform branches: the bash had no `uname`/`OSTYPE` arm to enumerate, and
#     `ps -eo pid,etime,command` is the same argv on BSD/macOS and GNU/Linux.
#   * The two-layout dist resolution is bin/lib/node-shim.sh's, shared with
#     dispatch.sh, dispatch-tracker.sh, session-cleanup.sh, session-reconciler.sh,
#     hitl.sh, open-session.sh, dispatch-cleanup-scheduler.sh and
#     session-comms-auditor.sh; tests/dispatch/T128 pins the workspace layout for
#     this one — and it has teeth here, because DISPATCH_STATE_DIR defaults to
#     `$SCRIPT_DIR/../state/dispatch` and the reconcile tick passes it no argv and
#     no env, so a root derived from the compiled module's own location would alert
#     into the installed PACKAGE while the workspace's own alerts.log stayed empty.
#
# THE PATH HARDENING STAYS HERE, IN BASH — no longer byte-identical: #930 demoted the
# homebrew entry from a PREFIX to a FALLBACK (see the block above `set -euo pipefail`).
# It is what resolves `telepty` for the node process's child, and this script is
# reached from launchd via src/reconciler/cli.ts every 60s, where the inherited PATH
# is minimal — which is why the homebrew entry stays present, appended, rather than
# being deleted the way bin/session-cleanup.sh deleted it.
# THE NAMED TENSION IS RESOLVED, not merely mentioned: bin/session-cleanup.sh:34-41
# records that the prefix is what made #400 pick a stale homebrew telepty, and this
# is the tick's own telepty spawn, so the hazard applied here directly.
# tests/dispatch/lib.sh:45 exports an absolute `TELEPTY` for every other guard, which
# masks the resolution entirely — T137 unsets it on purpose and is the one place the
# order is actually measured.
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
# Resolved exactly as the shell script's SCRIPT_DIR was, so a symlinked entrypoint
# still resolves — and so a control workspace alerts into its OWN state/dispatch
# rather than the installed package's (T128).
AIGENTRY_SHIM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export AIGENTRY_SHIM_SCRIPT_DIR

# shellcheck source=lib/node-shim.sh
. "$AIGENTRY_SHIM_SCRIPT_DIR/lib/node-shim.sh"
aigentry_node_shim orchestrator-bridge-auditor.sh dist/src/bridge-auditor/cli.js
exec node "$AIGENTRY_SHIM_JS" "$@"
