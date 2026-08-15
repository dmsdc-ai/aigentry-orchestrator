#!/usr/bin/env bash
# T89 — an EMPTY telepty session list may not authorize a teardown (#835).
#
# `telepty list --json` prints `[]` and exits 0 both when the daemon holds no
# sessions and when it REFUSED the caller (cli.js:605-613 is `if (res.ok) {…}` with
# no else inside a bare catch, and every banner goes to stderr to keep --json clean).
# session-cleanup.sh read that absence as "already cleaned or never registered" and
# went on to close the worker's terminal surface, DELETE its daemon registry entry
# and return 0 — while the batch paths printed "cleaned: 0 …" and exited 0 without
# ever reaching the loud 401 handler, which lives inside a loop body that an empty
# list never enters.
#
# The rule under test: an absence may authorize destruction only when the absence
# itself is trustworthy. Three conditions must stay distinguishable and only a 200
# licenses the teardown:
#     401/403 → refused     5xx → broken     no answer → unreachable     200 → ok
#
# Asserts:
#   1. single-sid + `[]` + refusal → NO surface close, NO registry DELETE, non-zero;
#   2. `--all-disconnected` and `--all-unused` reach the same loud handler instead of
#      reporting "cleaned: 0" and success — the batch paths' structural blind spot;
#   3. refused / broken / unreachable are each NAMED, not folded together;
#   4. `[]` corroborated by a 200 keeps the pre-existing telepty-orphan teardown
#      (#323/#340) working exactly as before — the guard costs nothing when the
#      daemon really is empty;
#   5. a NON-empty listing is trusted without a probe (the ambiguous answer is the
#      only one that pays), and its teardown is untouched;
#   6. the Rule 28 protected-`orchestrator` guard still fires first, refusal or not.
#
# Hermetic: temp HOME, stub telepty + curl on PATH, surface close seamed to a log.
# Throwaway sids only; no daemon is contacted and no real session is touched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T89]: $*" >&2; exit 1; }

CURL_LOG="$T_TMP/curl.log"; export CURL_LOG
ACTIONS_LOG="$T_TMP/actions.log"; export ACTIONS_LOG

# curl stub: one argv per line into CURL_LOG, answer $STUB_HTTP. Both the /api/sessions
# probe and the registry DELETE come through here, so the log is also the record of
# what the script tried to destroy.
# A faithful curl: with -w '%{http_code}' the real one prints `000` on a connect
# failure AND exits non-zero. A stub that only ever printed the code and exited 0
# cannot catch a caller whose `|| echo 000` then doubles it to `000000` — which is
# exactly how the no-answer arm stayed unreachable in production while passing
# here. The 000 case must therefore fail the way curl fails.
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$CURL_LOG"
printf 'ARGV %s\n' "$*" >> "$CURL_LOG"
echo "${STUB_HTTP:-200}"
[ "${STUB_HTTP:-200}" = "000" ] && exit 7
exit 0
EOF
chmod +x "$STUB_BIN/curl"

FAKE_HOME="$T_TMP/home"; mkdir -p "$FAKE_HOME/.telepty"
printf '%s' '{"authToken":"tok-T89"}' > "$FAKE_HOME/.telepty/config.json"
chmod 600 "$FAKE_HOME/.telepty/config.json"

# Surface-close seam (T32/T86 convention: the lib's re-source guard lets an exported
# function survive) — record, never contact a workspace host.
wh_close_for_sid() { printf 'SURFACE_CLOSE_BY_SID %s\n' "$1" >> "$ACTIONS_LOG"; return 0; }
wh_close()         { printf 'SURFACE_CLOSE %s\n' "$1" >> "$ACTIONS_LOG"; return 0; }
wh_lookup()        { printf ''; }
export -f wh_close_for_sid wh_close wh_lookup
export WORKSPACE_HOST_SH_LOADED=1
# No dispatch-registry side effects in this test.
export DISPATCH_REGISTRY_PY="$T_TMP/no-such-registry.py"

SID="t89-live-worker"

# run <http> <args…> → prints "<rc>\n<combined output>"; resets both logs first.
run() {
  local http="$1"; shift
  : > "$CURL_LOG"; : > "$ACTIONS_LOG"
  local out rc=0
  set +e
  out=$(STUB_HTTP="$http" HOME="$FAKE_HOME" "$BASH_BIN" "$CLEANUP" "$@" 2>&1)
  rc=$?
  set -e
  printf '%s\n%s' "$rc" "$out"
}
rc_of()  { printf '%s' "$1" | head -1; }
out_of() { printf '%s' "$1" | tail -n +2; }

assert_nothing_destroyed() {
  local what="$1"
  if [ -s "$ACTIONS_LOG" ]; then
    echo "--- actions ---" >&2; cat "$ACTIONS_LOG" >&2
    fail "$what: a terminal surface was closed on an untrustworthy empty list"
  fi
  if grep -qF -- '-X' "$CURL_LOG" 2>/dev/null && grep -qF -- 'DELETE' "$CURL_LOG" 2>/dev/null; then
    echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
    fail "$what: the registry DELETE was issued on an untrustworthy empty list"
  fi
}

# ── the refusal shape: [] with exit 0, exactly what a 401 produces ──────────
printf '%s' '[]' > "$STUB_LIST_FILE"

# ── (1)+(3) single-sid, each non-ok condition named and refused ─────────────
for probe in 401:unauthorized 403:unauthorized 500:broken 000:unreachable; do
  http="${probe%%:*}"; want="${probe##*:}"
  res=$(run "$http" "$SID")
  rc=$(rc_of "$res"); out=$(out_of "$res")
  [ "$rc" != "0" ] || fail "http=$http: cleanup exited 0 on an empty list it could not corroborate — that is the success report the defect hid behind: $out"
  case "$out" in
    *"already cleaned or never registered"*)
      fail "http=$http: cleanup still described the refusal as an absence: $out";;
  esac
  case "$out" in
    *"'$want'"*) ;;
    *) fail "http=$http: the verdict was not named '$want' (refused/broken/unreachable must stay distinguishable): $out";;
  esac
  assert_nothing_destroyed "http=$http single-sid"
done

# ── (2) the batch paths reach the same handler ─────────────────────────────
for mode in --all-disconnected --all-unused; do
  res=$(run 401 "$mode")
  rc=$(rc_of "$res"); out=$(out_of "$res")
  [ "$rc" != "0" ] || fail "$mode: exited 0 under a refusal — the batch path structurally could not reach the loud handler, which is the whole finding: $out"
  case "$out" in
    *"cleaned: 0"*) fail "$mode: still reported a clean sweep on a refused listing: $out";;
  esac
  case "$out" in
    *unauthorized*) ;;
    *) fail "$mode: did not name the refusal: $out";;
  esac
  assert_nothing_destroyed "$mode"
done

# ── (4) [] + 200 = genuinely empty: the pre-existing behaviour is intact ────
res=$(run 200 "$SID")
rc=$(rc_of "$res"); out=$(out_of "$res")
[ "$rc" = "0" ] || fail "a corroborated empty list must still clean a telepty-orphan (#323/#340); rc=$rc: $out"
grep -qx "SURFACE_CLOSE_BY_SID $SID" "$ACTIONS_LOG" \
  || { echo "--- actions ---" >&2; cat "$ACTIONS_LOG" >&2
       fail "the orphan surface close was lost on the corroborated path"; }
grep -q 'ARGV .*-X DELETE .*/api/sessions/'"$SID" "$CURL_LOG" \
  || { echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
       fail "the registry DELETE was lost on the corroborated path"; }
case "$out" in
  *"already cleaned or never registered"*) ;;
  *) fail "the corroborated-empty message changed: $out";;
esac

for mode in --all-disconnected --all-unused; do
  res=$(run 200 "$mode")
  rc=$(rc_of "$res"); out=$(out_of "$res")
  [ "$rc" = "0" ] || fail "$mode on a genuinely empty daemon must stay a clean no-op; rc=$rc: $out"
  case "$out" in
    *"cleaned: 0"*) ;;
    *) fail "$mode lost its no-op report on a corroborated empty list: $out";;
  esac
done

# ── (5) a NON-empty listing is self-evidently authentic — no probe ──────────
printf '%s' '[{"id":"t89-someone-else","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
res=$(run 200 "$SID")
rc=$(rc_of "$res")
[ "$rc" = "0" ] || fail "a non-empty listing must keep working unchanged; rc=$rc"
grep -qx "SURFACE_CLOSE_BY_SID $SID" "$ACTIONS_LOG" \
  || fail "the telepty-orphan teardown broke on a non-empty listing"
if grep -q 'ARGV .*http://127.0.0.1:[0-9]*/api/sessions$' "$CURL_LOG"; then
  echo "--- curl argv ---" >&2; cat "$CURL_LOG" >&2
  fail "a non-empty listing paid for a corroboration probe — only the ambiguous answer should"
fi

# ── (5b) a DELETE that got no answer says so, instead of "unexpected" ──────
# curl's own failure reaches the status switch as the literal "000". It shares
# the refusal's consequence — the registry entry stays — but not its cause, and
# the catch-all named neither.
res=$(run 000 "$SID")
out=$(out_of "$res")
case "$out" in
  *"unexpected; manual verify"*)
    fail "an unanswered DELETE fell through to the catch-all: $out";;
esac
case "$out" in
  *"no answer from the daemon"*) ;;
  *) fail "an unanswered DELETE did not name what happened: $out";;
esac
case "$out" in
  *"STAYS in the daemon registry"*) ;;
  *) fail "an unanswered DELETE did not state the consequence: $out";;
esac

# ── (6) Rule 28: the protected session is still refused, refusal or not ────
printf '%s' '[]' > "$STUB_LIST_FILE"
for http in 200 401; do
  res=$(run "$http" orchestrator)
  rc=$(rc_of "$res"); out=$(out_of "$res")
  [ "$rc" != "0" ] || fail "http=$http: 'orchestrator' was accepted as a cleanup target"
  case "$out" in
    *"refusing to clean protected session"*) ;;
    *) fail "http=$http: the protected-session guard no longer fires first: $out";;
  esac
  assert_nothing_destroyed "protected-session http=$http"
done

echo "T89 PASS"
