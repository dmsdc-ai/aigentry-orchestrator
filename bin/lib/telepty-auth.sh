#!/usr/bin/env bash
# telepty-auth.sh — the ONE resolver for the telepty daemon credential.
#
# Sourced by every script in this repo that calls the daemon over HTTP directly
# (bin/dispatch-tracker.sh's observation poll, bin/session-cleanup.sh's registry
# DELETE). Those calls used to carry no credential and worked only because the
# daemon trusted loopback before checking any token; telepty #820/#823 removes that
# trust, after which a token-less call gets 401. See #824.
#
# It lives here rather than in either caller because a divergent copy of a
# credential is how the two ends silently stop agreeing about who is calling.
# There must stay exactly one `authToken` reader under bin/ — tests/dispatch/T87
# asserts that structurally.
#
# SOURCE OF TRUTH: `authToken` in ~/.telepty/config.json, the same file the telepty
# CLI reads (cli.js getAuthToken → getConfig().authToken, cli.js:167-171; auth.js:6-7
# builds the path from os.homedir(), which honours $HOME exactly as expanduser does).
#
# DELIBERATELY the file and nothing else. There is no TELEPTY_AUTH_TOKEN override
# here even though one is tempting: the daemon reads its token once at module load
# and freezes it into the auth closures (daemon.js:33 → http-auth.js:138,
# websocket.js:402), and the production launchd plist supplies only PATH, so the
# daemon can never see such a variable. A client honouring it would present a token
# the daemon does not expect and get a 401 indistinguishable from a real credential
# bug — an override would make the two ends MORE likely to diverge, not less.
#
# DEGRADATION: a missing, unreadable or malformed config yields EMPTY output and
# exit 0 — never a failure. bin/session-cleanup.sh runs in teardown and has to keep
# working degraded rather than abort. With an empty value telepty_curl writes no
# header line at all, so the daemon answers a truthful 401 and each caller names
# that refusal for what it is.
# Degraded means "no credential presented", never "empty credential presented as if
# it were valid".
#
# The token is never logged, echoed, or interpolated into a message — it reaches
# curl only on its STDIN, through telepty_curl below, never in its argv.
#
# Article 17: shell + Python stdlib (+ curl, for telepty_curl) only. macOS + Linux +
# Git-Bash ($HOME on all three), so there is no OS-specific primitive for
# lib/platform.sh to abstract.

# Guard against double-source (platform.sh precedent) — session-cleanup.sh reaches
# this file both directly and via lib/workspace-host.sh's neighbours.
[[ "${_TELEPTY_AUTH_SH_SOURCED:-}" == "1" ]] && return 0
_TELEPTY_AUTH_SH_SOURCED=1

# telepty_auth_token — print the daemon token, or nothing. Always exits 0.
# Framing is exactly one LF on every OS: the bytes go to sys.stdout.buffer, so Windows
# text-mode stdout cannot turn it into CRLF. Same encoding/errors as print().
telepty_auth_token() {
  python3 - <<'PY' 2>/dev/null || true
import json, os, sys
try:
    with open(os.path.join(os.path.expanduser("~"), ".telepty", "config.json")) as fh:
        out = str(json.load(fh).get("authToken", "") or "") + "\n"
    out = out.encode(sys.stdout.encoding, sys.stdout.errors)
except Exception:
    out = b"\n"
sys.stdout.buffer.write(out)
PY
}

# telepty_curl <curl-args...> — the ONE way a script here presents the credential
# over HTTP. Runs `"${CURL:-curl}" <curl-args...> --connect-timeout 2 --max-time 5
# -H @-` with the header line `x-telepty-token: <tok>` on curl's STDIN, so the token
# is never in any argv (readable by every same-host process), exported env, tempfile,
# here-doc/here-string or log. Path: resolver stdout → local variable → builtin
# printf → pipe. An empty token writes nothing (no credential presented, see
# DEGRADATION above).
#
# The limits come AFTER the caller's arguments: curl keeps the last value of an
# option, so no call site can widen them. curl's stdout/stderr are the caller's,
# untouched; the return is curl's own exit status. The printf side ignores SIGPIPE
# and always succeeds, so a curl that never reads stdin cannot change the status
# under pipefail. A token containing CR or LF would inject header lines: it is
# refused (not echoed), nothing is sent, return 2. Caller xtrace/allexport are
# suspended while the token is in scope and restored after.
# A bare $(...) would strip EVERY trailing LF and turn "tok\n" into an accepted
# "tok", so the capture ends in a "." sentinel and then drops exactly the one LF
# the resolver adds; any other CR/LF is token data and is refused.
telepty_curl() {
  local _tc_x='' _tc_a=''
  case $- in *x*) _tc_x=1; set +x ;; esac
  case $- in *a*) _tc_a=1; set +a ;; esac
  local _tc_tok _tc_rc
  _tc_tok=$(telepty_auth_token; printf .)
  _tc_tok=${_tc_tok%.}
  case "$_tc_tok" in *$'\n') _tc_tok=${_tc_tok%?} ;; esac
  case "$_tc_tok" in
    *$'\r'*|*$'\n'*)
      printf 'telepty_curl: the configured credential contains a line break; refusing to send it\n' >&2
      _tc_rc=2 ;;
    *)
      if { trap '' PIPE; [ -z "$_tc_tok" ] || printf 'x-telepty-token: %s\n' "$_tc_tok" || :; } 2>/dev/null \
        | "${CURL:-curl}" "$@" --connect-timeout 2 --max-time 5 -H @-; then
        _tc_rc=0
      else
        _tc_rc=$?
      fi ;;
  esac
  _tc_tok=''
  [ -z "$_tc_a" ] || set -a
  [ -z "$_tc_x" ] || set -x
  return "$_tc_rc"
}
