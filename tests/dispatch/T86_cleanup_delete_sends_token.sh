#!/usr/bin/env bash
# T86 — the cleanup DELETE must carry the daemon credential, and a refusal must be
# named as a refusal.
#
# `session-cleanup.sh` force-removes a session from the daemon registry with
# `DELETE /api/sessions/:sid`. That call was token-less and worked only because the
# daemon trusted loopback before checking any credential (telepty #820/#823). Once
# that trust is removed the DELETE gets 401, the session is never removed from the
# registry, and the existing catch-all logs it as "unexpected; manual verify" — the
# same absence-vs-refusal conflation #824 fixes in the tracker, one file over.
#
# Cleanup runs in TEARDOWN, so the degraded paths matter as much as the happy one:
# an unreadable config must leave the script working, not abort it.
#
# Asserts:
#   1. the DELETE sends `x-telepty-token`, valued from ~/.telepty/config.json;
#   2. 401 gets its OWN loud arm naming the registry leak, not the catch-all;
#   3. a missing config degrades — DELETE still attempted, exit still 0;
#   4. the 200 / 404 arms are untouched.
#
# Hermetic: temp HOME (never reads the operator's real token), stubbed curl +
# telepty + surface close. Throwaway sid only; no live session is touched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T86]: $*" >&2; exit 1; }

CURL_LOG="$T_TMP/curl.log"
export CURL_LOG

# curl stub: record argv ONE ARGUMENT PER LINE, answer with $STUB_HTTP.
# Per-line matters: "$*" would flatten `-H` + `x-telepty-token: ` + `-X` into one
# space-joined string, in which an EMPTY header value is indistinguishable from one
# whose value follows — the exact distinction assertion (3) turns on.
# delete_session_registry uses `-o /dev/null -w '%{http_code}'`, so the stub's
# stdout IS the status code.
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$CURL_LOG"
echo "${STUB_HTTP:-200}"
EOF
chmod +x "$STUB_BIN/curl"

# Hermetic HOME with a KNOWN token, so asserting the header value also proves the
# resolver read the file rather than inventing something.
FAKE_HOME="$T_TMP/home"
mkdir -p "$FAKE_HOME/.telepty"
printf '%s' '{"authToken":"tok-T86-abcdef","createdAt":"2026-07-30T00:00:00Z"}' \
  > "$FAKE_HOME/.telepty/config.json"
chmod 600 "$FAKE_HOME/.telepty/config.json"

# Stub the terminal-surface close (T32's seam: the lib's re-source guard lets an
# exported function survive) so no workspace host is ever contacted.
wh_close_for_sid() { return 0; }
export -f wh_close_for_sid
export WORKSPACE_HOST_SH_LOADED=1

# telepty list WITHOUT the sid → telepty-miss branch → wh_close_for_sid + DELETE.
# No parent process is ever looked up or signalled on this path.
SID="orphan-sid-T86"
printf '%s' '[{"id":"someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"

# run_cleanup <http> → stdout+stderr of one cleanup run; asserts exit 0.
run_cleanup() {
  local http="$1" out rc
  : > "$CURL_LOG"
  set +e
  out=$(STUB_HTTP="$http" HOME="$FAKE_HOME" "$BASH_BIN" "$CLEANUP" "$SID" 2>&1)
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "cleanup exited $rc on http=$http (teardown paths must not abort): $out"
  printf '%s' "$out"
}

# ── (1) the DELETE presents the daemon token ────────────────────────────────
out=$(run_cleanup 200)
grep -q '^x-telepty-token:' "$CURL_LOG" \
  || { echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
       fail "the cleanup DELETE did not send x-telepty-token"; }
grep -qx 'x-telepty-token: tok-T86-abcdef' "$CURL_LOG" \
  || { echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
       fail "the token was not resolved from \$HOME/.telepty/config.json"; }
# (4a) the 200 arm still says what it said.
case "$out" in
  *"200 (removed from registry)"*) ;;
  *) fail "200 arm changed: $out";;
esac

# ── (2) 401 is a refusal, not an "unexpected" status ────────────────────────
out=$(run_cleanup 401)
case "$out" in
  *"unexpected; manual verify"*)
    fail "401 fell through to the catch-all — a refused DELETE leaks the registry entry and must say so: $out";;
esac
case "$out" in
  *"refused the credential"*) ;;
  *) fail "401 did not name the refusal: $out";;
esac
case "$out" in
  *401*) ;;
  *) fail "401 arm did not report the status code: $out";;
esac

# 403 (the daemon's origin-denied shape) takes the same arm.
out=$(run_cleanup 403)
case "$out" in
  *"refused the credential"*) ;;
  *) fail "403 did not name the refusal: $out";;
esac

# ── (3) a missing config degrades; it does not abort a teardown ─────────────
NO_TOKEN_HOME="$T_TMP/home-empty"
mkdir -p "$NO_TOKEN_HOME"
: > "$CURL_LOG"
set +e
out=$(STUB_HTTP=401 HOME="$NO_TOKEN_HOME" "$BASH_BIN" "$CLEANUP" "$SID" 2>&1)
rc=$?
set -e
[ "$rc" -eq 0 ] \
  || fail "an unreadable telepty config aborted cleanup (rc=$rc) — teardown must degrade, not fail: $out"
[ -s "$CURL_LOG" ] \
  || fail "no DELETE was attempted at all when the token could not be resolved"
# Degraded means "no credential sent", never "empty credential sent as if valid".
# curl drops a header given with no content, so the empty-valued argument is the
# correct degraded shape; what must NOT appear is a header carrying some value.
if grep -qE '^x-telepty-token: +[^ ]' "$CURL_LOG"; then
  echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
  fail "a token was fabricated when the config was absent"
fi
grep -qE '^x-telepty-token: *$' "$CURL_LOG" \
  || { echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
       fail "degraded DELETE sent neither an empty-valued header nor none at all"; }

# ── (4b) the 404 arm still says what it said ────────────────────────────────
out=$(run_cleanup 404)
case "$out" in
  *"404 (already gone"*) ;;
  *) fail "404 arm changed: $out";;
esac

echo "T86 PASS"
