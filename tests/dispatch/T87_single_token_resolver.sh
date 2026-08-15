#!/usr/bin/env bash
# T87 — there is exactly ONE credential resolver in this repo, it lives in a lib
# both callers source, and it degrades to "no credential" instead of failing.
#
# #824 has two daemon call sites (bin/dispatch-tracker.sh's observation poll and
# bin/session-cleanup.sh's registry DELETE). The failure mode this test exists to
# prevent is not a missing header — the per-site tests (T84, T86) cover that — it is
# TWO copies of credential resolution drifting apart, which is how the two ends stop
# agreeing about who is calling. The single-definition assertion is structural
# because nothing else can catch a second copy being pasted in later.
#
# Asserts:
#   1. the shared lib exists and defines the resolver;
#   2. it reads `authToken` from $HOME/.telepty/config.json;
#   3. absent / unreadable / malformed config → EMPTY output and exit 0, never a
#      failure (bin/session-cleanup.sh runs in teardown and must degrade);
#   4. the config file is the ONLY source — no env override, because the daemon
#      freezes its token at module load from that same file and can never see one
#      (daemon.js:33 → http-auth.js closure; its launchd plist supplies only PATH),
#      so honouring an env var would send a token the daemon does not expect;
#   5. exactly one `authToken` reader exists under bin/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T87]: $*" >&2; exit 1; }

LIB="$REPO_ROOT/bin/lib/telepty-auth.sh"

# ── (1) the lib exists and defines the resolver ─────────────────────────────
[ -f "$LIB" ] || fail "no shared credential resolver at bin/lib/telepty-auth.sh"

# resolve <home> → what the resolver prints for that HOME; asserts exit 0.
resolve() {
  local home="$1" out rc
  set +e
  out=$(HOME="$home" bash -c 'set -euo pipefail; . "$1"; telepty_auth_token' _ "$LIB" 2>/dev/null)
  rc=$?
  set -e
  [ "$rc" -eq 0 ] \
    || fail "telepty_auth_token exited $rc for HOME=$home — it must never fail a caller"
  printf '%s' "$out"
}

# ── (2) reads authToken from $HOME/.telepty/config.json ─────────────────────
GOOD="$T_TMP/home-good"
mkdir -p "$GOOD/.telepty"
printf '%s' '{"authToken":"tok-T87-112233","createdAt":"2026-07-30T00:00:00Z"}' \
  > "$GOOD/.telepty/config.json"
chmod 600 "$GOOD/.telepty/config.json"
got=$(resolve "$GOOD")
[ "$got" = "tok-T87-112233" ] || fail "resolver returned '$got', want 'tok-T87-112233'"

# ── (3) every broken-config shape degrades to empty, exit 0 ─────────────────
MISSING="$T_TMP/home-missing"; mkdir -p "$MISSING"
got=$(resolve "$MISSING")
[ -z "$got" ] || fail "a missing config yielded '$got'; want empty"

MALFORMED="$T_TMP/home-malformed"; mkdir -p "$MALFORMED/.telepty"
printf '%s' 'not json at all {{{' > "$MALFORMED/.telepty/config.json"
got=$(resolve "$MALFORMED")
[ -z "$got" ] || fail "a malformed config yielded '$got'; want empty"

NOFIELD="$T_TMP/home-nofield"; mkdir -p "$NOFIELD/.telepty"
printf '%s' '{"createdAt":"2026-07-30T00:00:00Z"}' > "$NOFIELD/.telepty/config.json"
got=$(resolve "$NOFIELD")
[ -z "$got" ] || fail "a config without authToken yielded '$got'; want empty"

UNREADABLE="$T_TMP/home-unreadable"; mkdir -p "$UNREADABLE/.telepty"
printf '%s' '{"authToken":"tok-secret"}' > "$UNREADABLE/.telepty/config.json"
chmod 000 "$UNREADABLE/.telepty/config.json"
got=$(resolve "$UNREADABLE")
chmod 600 "$UNREADABLE/.telepty/config.json"   # so teardown can remove it
[ -z "$got" ] || fail "an unreadable config yielded '$got'; want empty"

# ── (4) the file is the only source: no env override ────────────────────────
set +e
got=$(TELEPTY_AUTH_TOKEN="tok-from-env" HOME="$GOOD" \
  bash -c 'set -euo pipefail; . "$1"; telepty_auth_token' _ "$LIB" 2>/dev/null)
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "resolver exited $rc with TELEPTY_AUTH_TOKEN set"
[ "$got" = "tok-T87-112233" ] \
  || fail "TELEPTY_AUTH_TOKEN overrode the config file (got '$got') — the daemon freezes its token from that file at module load and can never see the env var, so an override sends a credential the daemon does not expect"

# ── (5) exactly ONE authToken EXTRACTION under bin/ ─────────────────────────
# Matches the field-access syntax a second copy would have to use (`"authToken"`
# for python/jq-style key lookup, `.authToken` for jq) rather than any mention of
# the word — the 401 arm in session-cleanup.sh legitimately names `authToken` in
# prose when it tells the operator which file to check, and that is documentation,
# not a second resolver.
readers=$(grep -rlE '"authToken"|\.authToken' "$REPO_ROOT/bin" 2>/dev/null | sort || true)
count=$(printf '%s\n' "$readers" | grep -c . || true)
if [ "$count" != "1" ]; then
  echo "--- files extracting authToken ---" >&2; printf '%s\n' "$readers" >&2
  fail "$count files under bin/ resolve the daemon credential; want exactly 1 (a divergent copy of a credential is how two ends stop agreeing about who is calling)"
fi
[ "$readers" = "$LIB" ] || fail "the sole authToken reader is '$readers', want '$LIB'"

# And exactly one definition of the resolver itself.
defs=$(grep -rlE '^[[:space:]]*(function[[:space:]]+)?telepty_auth_token[[:space:]]*\(\)' \
  "$REPO_ROOT/bin" 2>/dev/null | sort || true)
[ "$defs" = "$LIB" ] \
  || { echo "--- files defining telepty_auth_token ---" >&2; printf '%s\n' "$defs" >&2
       fail "telepty_auth_token must be defined once, in $LIB"; }

# ── both call sites route through the shared resolver ───────────────────────
for caller in bin/dispatch-tracker.sh bin/session-cleanup.sh; do
  grep -q 'telepty_auth_token' "$REPO_ROOT/$caller" \
    || fail "$caller does not use the shared resolver"
  grep -q 'lib/telepty-auth.sh' "$REPO_ROOT/$caller" \
    || fail "$caller does not source lib/telepty-auth.sh"
done

echo "T87 PASS"
