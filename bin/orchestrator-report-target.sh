#!/usr/bin/env bash
# orchestrator-report-target.sh — resolve the worker→orchestrator REPORT/HOLD
# target for #690 (Rule 16: no hardcoded session id / IP). Prints ONE line: the
# address a dispatched worker should `telepty inject` its REPORT/HOLD to.
#
#   <sid>@<tailnet-ip>   when a Tailscale CGNAT (100.64.0.0/10) address is found
#                        AND the daemon actually answers there — resolves from
#                        both local and cross-machine workers.
#   <sid>                bare fallback (single-machine / no tailnet / nothing
#                        listening on the tailnet address) — resolves locally.
#
# Consumed by bin/dispatch.sh, which substitutes {{ORCHESTRATOR_REPORT_TARGET}}
# in each dispatch ref at inject time so refs never carry a phantom sid. It reads
# STDOUT only, so the notes this script writes to stderr never reach a ref.
#
# WHY THE PROBE (#835 family, found the hard way): this used to return the
# `<sid>@<ip>` form whenever an interface *had* a CGNAT address. That infers
# REACHABILITY from the presence of an address — a fact it never measured. When
# the daemon stopped listening on the tailnet, the interface kept its address, so
# the resolver kept handing every dispatched worker an address that answers
# nothing, and each worker's REPORT went nowhere. The address existing and the
# daemon answering there are two different claims; only the second one is the one
# callers need, so only the second one may be asserted.
#
# The probe cannot lean on `telepty inject`'s exit code to notice the failure —
# that path exits 0 while printing a failure (telepty #840, not ours, sibling
# mid-change). It measures the endpoint directly instead.
#
# Reachability is NOT authorization: ANY HTTP answer, 401 included, proves the
# daemon is listening there. A credential problem would hit the bare local form
# identically, so it is not a reason to prefer one address over the other.
#
# AN EXPLICIT HOST IS HONOURED, LOUDLY. The defect is inferring an unmeasured
# fact, not overriding a measured one: `AIGENTRY_ORCHESTRATOR_HOST` is an
# operator stating the fact, and it stays the escape hatch for a misfiring
# auto-detect (a probe can be wrong too — a firewall that blocks us but not the
# worker, a listener coming back up in a minute, refs substituted now and used
# later). So an unreachable explicit host is still returned on stdout, with a
# note on stderr — the operator's choice stands, but it stops being invisible.
# Auto-detection gets no such deference, because nobody asserted it.
#
# CANNOT-PROBE IS NOT UNREACHABLE. With no curl there is no measurement, and an
# absent measurement must not be read as a negative result — that is the same
# mistake one turn down. The auto-detected form is kept and the inability to
# check is noted.
#
# Overrides (both optional; auto-detect is the default):
#   AIGENTRY_ORCHESTRATOR_SID    orchestrator session id (default: orchestrator)
#   AIGENTRY_ORCHESTRATOR_HOST   tailnet host/IP (default: auto-detected)
#
# COST: this runs on every dispatch, so it is one probe with a 1s connect ceiling
# and no retry. A closed port on a reachable host refuses instantly; only a
# black-holed address pays the full second.
#
# LIMIT: when the tailnet address does not answer, the bare form is the best
# available target, not a universal one — it resolves to the *local* daemon, so a
# genuinely cross-machine worker has no working report target in that window.
# That is a real gap, and the stderr note is where it surfaces rather than being
# hidden behind an address that silently drops reports.
#
# ponytail: tailnet IP via an ifconfig/ip interface scan for the 100.64/10 range;
# if that ever misfires (multiple tailnets, unusual iface naming), set
# AIGENTRY_ORCHESTRATOR_HOST explicitly — that's the upgrade path, no code change.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# $CURL is the seam bin/dispatch-tracker.sh:41 uses. REPORT_TARGET_IFACE_CMD is
# the interface-scan seam: it is the one input a test cannot pin through the
# public overrides, because setting AIGENTRY_ORCHESTRATOR_HOST also selects the
# explicit branch. (Precedent: session-cleanup.sh's CLEANUP_PS_CMD.)
CURL="${CURL:-curl}"
IFACE_CMD="${REPORT_TARGET_IFACE_CMD:-}"

note() { echo "orchestrator-report-target: $*" >&2; }

# probe_host <host> → answered | silent | unknown
#   answered — the daemon responded there (any HTTP status)
#   silent   — the exchange completed without a response: nothing is listening
#   unknown  — we could not measure at all; NOT a negative result
#
# NOTE the missing `|| echo 000`. With -w '%{http_code}' curl prints `000` on a
# connect failure AND exits non-zero, so the usual `$(curl … || echo 000)` idiom
# concatenates both into `000000` — which matches no arm and falls through to the
# catch-all as if the host had answered. Caught by running this against the real
# unreachable address instead of trusting the stub, which only ever emitted one
# value. `|| true` keeps curl's own code as the only source of truth.
probe_host() {
  local h="$1" port="${TELEPTY_PORT:-3848}" http
  command -v "$CURL" >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  http=$("$CURL" -s -o /dev/null -w '%{http_code}' \
    --connect-timeout 1 --max-time 2 \
    "http://${h}:${port}/api/meta" 2>/dev/null || true)
  case "$http" in
    ''|000) printf 'silent' ;;
    *)      printf 'answered' ;;
  esac
}

sid="${AIGENTRY_ORCHESTRATOR_SID:-orchestrator}"

host="${AIGENTRY_ORCHESTRATOR_HOST:-}"
explicit=1
if [ -z "$host" ]; then
  explicit=0
  # CGNAT 100.64.0.0/10 → second octet 64-127. Scan both ifconfig (macOS/BSD) and
  # `ip` (Linux); whichever exists produces output, the other is silently empty.
  scan="$( { if [ -n "$IFACE_CMD" ]; then "$IFACE_CMD" 2>/dev/null; \
             else ifconfig 2>/dev/null; ip -o -4 addr show 2>/dev/null; fi; } || true)"
  host="$(printf '%s\n' "$scan" \
    | grep -Eo '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}' \
    | head -n1 || true)"
fi

# No candidate at all — single-machine. Nothing to measure, nothing to claim.
if [ -z "$host" ]; then
  printf '%s\n' "$sid"
  exit 0
fi

case "$(probe_host "$host")" in
  answered)
    printf '%s@%s\n' "$sid" "$host"
    ;;
  silent)
    if [ "$explicit" -eq 1 ]; then
      note "AIGENTRY_ORCHESTRATOR_HOST=$host does not answer on port ${TELEPTY_PORT:-3848}; honouring it because you set it explicitly, but reports sent there will go nowhere until the daemon listens on it."
      printf '%s@%s\n' "$sid" "$host"
    else
      note "auto-detected tailnet address $host does not answer on port ${TELEPTY_PORT:-3848} — falling back to the bare '$sid', which resolves locally. Cross-machine workers have no working report target while that listener is down."
      printf '%s\n' "$sid"
    fi
    ;;
  unknown)
    note "cannot probe $host (no '$CURL' available) — keeping the tailnet form unverified; an absent measurement is not a negative one."
    printf '%s@%s\n' "$sid" "$host"
    ;;
esac
