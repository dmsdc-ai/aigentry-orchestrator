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
# working degraded rather than abort. With an empty value curl drops the header
# entirely (a `-H 'name:'` with no content removes rather than sends it), so the
# daemon answers a truthful 401 and each caller names that refusal for what it is.
# Degraded means "no credential presented", never "empty credential presented as if
# it were valid".
#
# The token is never logged, echoed, or interpolated into a message — only into the
# curl header argument at the call site.
#
# Article 17: shell + Python stdlib only. macOS + Linux + Git-Bash ($HOME on all
# three), so there is no OS-specific primitive for lib/platform.sh to abstract.

# Guard against double-source (platform.sh precedent) — session-cleanup.sh reaches
# this file both directly and via lib/workspace-host.sh's neighbours.
[[ "${_TELEPTY_AUTH_SH_SOURCED:-}" == "1" ]] && return 0
_TELEPTY_AUTH_SH_SOURCED=1

# telepty_auth_token — print the daemon token, or nothing. Always exits 0.
telepty_auth_token() {
  python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    with open(os.path.join(os.path.expanduser("~"), ".telepty", "config.json")) as fh:
        print(json.load(fh).get("authToken", "") or "")
except Exception:
    print("")
PY
}
