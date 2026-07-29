#!/usr/bin/env bash
# orchestrator-report-target.sh — resolve the worker→orchestrator REPORT/HOLD
# target for #690 (Rule 16: no hardcoded session id / IP). Prints ONE line: the
# address a dispatched worker should `telepty inject` its REPORT/HOLD to.
#
#   <sid>@<tailnet-ip>   when a Tailscale CGNAT (100.64.0.0/10) address is found
#                        — resolves from BOTH local and cross-machine workers.
#   <sid>                bare fallback (single-machine / no tailnet) — resolves
#                        locally.
#
# Consumed by bin/dispatch.sh, which substitutes {{ORCHESTRATOR_REPORT_TARGET}}
# in each dispatch ref at inject time so refs never carry a phantom sid.
#
# Overrides (both optional; auto-detect is the default):
#   AIGENTRY_ORCHESTRATOR_SID    orchestrator session id (default: orchestrator)
#   AIGENTRY_ORCHESTRATOR_HOST   tailnet host/IP (default: auto-detected)
#
# ponytail: tailnet IP via an ifconfig/ip interface scan for the 100.64/10 range;
# if that ever misfires (multiple tailnets, unusual iface naming), set
# AIGENTRY_ORCHESTRATOR_HOST explicitly — that's the upgrade path, no code change.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

sid="${AIGENTRY_ORCHESTRATOR_SID:-orchestrator}"

host="${AIGENTRY_ORCHESTRATOR_HOST:-}"
if [ -z "$host" ]; then
  # CGNAT 100.64.0.0/10 → second octet 64-127. Scan both ifconfig (macOS/BSD) and
  # `ip` (Linux); whichever exists produces output, the other is silently empty.
  host="$({ ifconfig 2>/dev/null; ip -o -4 addr show 2>/dev/null; } \
    | grep -Eo '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}' \
    | head -n1 || true)"
fi

if [ -n "$host" ]; then
  printf '%s@%s\n' "$sid" "$host"
else
  printf '%s\n' "$sid"
fi
