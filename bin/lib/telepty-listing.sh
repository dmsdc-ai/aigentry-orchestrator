#!/usr/bin/env bash
# telepty-listing.sh — an EMPTY session list is not, by itself, evidence that there
# are no sessions.
#
# `telepty list --json` prints `[]` and exits 0 in several conditions, and only one
# of them means "the daemon holds no sessions". A credential the daemon declines,
# a daemon that answers with an error, and a daemon that does not answer at all all
# produce the same well-formed, successful, empty stdout: the CLI collects sessions
# only on a successful response and has no else-branch for the rest, and it routes
# its notices to stderr to keep `--json` clean. So the failure is silent twice over.
#
# That distinction is load-bearing here because callers in this repo read an absent
# session as AUTHORIZATION TO DESTROY — close its terminal surface, delete its
# daemon registry entry, prune its workspace. Four outcomes, one trustworthy:
#
#   daemon did not answer     unreachable   not evidence of anything
#   daemon declined           refused       an answer, but not an absence
#   daemon answered badly     broken        an answer, but not an absence
#   daemon answered, empty    ok            the only absence worth acting on
#
# So an empty list is corroborated before it is believed: this reads the STATUS of
# the same session endpoint the CLI itself reads, with the same credential — same
# request, same auth, so an "ok" here is the same "ok" the CLI needed and did not
# get. The body is ignored; only whether the daemon answered matters.
#
# RESIDUAL — this covers the LOCAL daemon only. `telepty list --json` also merges
# sessions discovered on peer machines, and the cross-machine path collapses a
# declining peer into an empty result the same way, one layer further out. A listing
# this file calls trustworthy can therefore still be missing a remote peer's
# sessions, and nothing on this side can detect that. It has to be fixed where the
# merge happens, in the CLI.
#
# Article 17: shell + curl + jq only, no OS-specific primitive (Rule 26 n/a).

# Guard against double-source (platform.sh precedent).
[[ "${_TELEPTY_LISTING_SH_SOURCED:-}" == "1" ]] && return 0
_TELEPTY_LISTING_SH_SOURCED=1

# The one credential resolver (#824) — this file presents the token, it never
# reads the config itself. tests/dispatch/T87 asserts that structurally.
# shellcheck source=telepty-auth.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/telepty-auth.sh"

# telepty_listing_verdict — what the local daemon's session endpoint ANSWERED.
# Prints exactly one of: ok | unauthorized | broken | unreachable. Always exits 0;
# the verdict is the return value, so a caller can log which condition it hit.
#
# $CURL is the same test seam bin/dispatch-tracker.sh:41 uses — the reconciler and
# ask.sh both harden PATH with /usr/bin ahead of anything a test can prepend, so a
# stub on PATH cannot reach this call.
# NOT `|| echo "000"`: with -w '%{http_code}' curl prints `000` on a connect
# failure and ALSO exits non-zero, so that idiom yields `000000` — which matches
# no arm and lands in the catch-all, reporting an outage as "broken". `|| true`
# leaves curl's own code as the single source of truth.
telepty_listing_verdict() {
  local port="${TELEPTY_PORT:-3848}" http
  http=$("${CURL:-curl}" -s -o /dev/null -w '%{http_code}' --connect-timeout 2 --max-time 5 \
    -H "x-telepty-token: $(telepty_auth_token)" \
    "http://127.0.0.1:${port}/api/sessions" 2>/dev/null || true)
  case "$http" in
    200)     printf 'ok' ;;
    401|403) printf 'unauthorized' ;;
    000|'')  printf 'unreachable' ;;   # curl could not complete the exchange
    *)       printf 'broken' ;;
  esac
}

# telepty_listing_trusted <raw-json> — 0 when <raw-json> may be used as evidence
# that a session is ABSENT; 1 (with the disqualifying verdict on stdout, for the
# caller's log line) when it may not.
#
# A non-empty array is self-evidently authentic: the conditions that fail to report
# sessions report none at all, so anything in the array came from a daemon that
# answered. Only the EMPTY array is ambiguous, and only that one pays for a probe.
telepty_listing_trusted() {
  local verdict
  printf '%s' "${1:-}" | jq -e 'type == "array" and length == 0' >/dev/null 2>&1 || return 0
  verdict=$(telepty_listing_verdict)
  [ "$verdict" = "ok" ] && return 0
  printf '%s' "$verdict"
  return 1
}

# telepty_sid_live <sid> — is <sid> a session that exists right now?
#   0 — live (present in the listing)
#   1 — absent, and the listing that says so is trustworthy
#   2 — UNKNOWN: the listing could not be obtained or cannot be trusted
#
# Callers must not collapse 2 into 1. Suppressing an action because an
# untrustworthy listing said "no such session" is the same defect one layer up.
telepty_sid_live() {
  local sid="$1" raw
  [ -n "$sid" ] || return 2
  raw=$("${TELEPTY:-telepty}" list --json 2>/dev/null) || return 2
  printf '%s' "$raw" | jq -e . >/dev/null 2>&1 || return 2
  printf '%s' "$raw" | jq -e --arg s "$sid" 'any(.[]?; .id == $s)' >/dev/null 2>&1 && return 0
  telepty_listing_trusted "$raw" >/dev/null || return 2
  return 1
}
