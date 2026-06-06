#!/usr/bin/env bash
# T34 — session-cleanup.sh is orchestrator-only; a WORKER session must be
# refused fail-fast (#524, Defense in Depth + least privilege). A spawned worker
# carries AIGENTRY_WORKER_SESSION=1 (dispatch.sh:97). Session lifecycle
# (spawn + de-spawn) is the orchestrator's exclusive domain; a worker running
# `--all-unused` could mass-kill active peers. Current self-protection only
# guards the literal `orchestrator` sid, so this marker is the real gate
# (precedent: dispatch.sh:70 install_worker_git_guard).
#
# Assert (worker): AIGENTRY_WORKER_SESSION=1 → nonzero exit + refusal message +
#   NO cleanup (cmux close + DELETE curl NOT invoked).
# Assert (control): UNSET → guard passes, normal path runs (DELETE invoked).
# TDD: RED before the guard exists (worker run would proceed to cleanup).
# Throwaway sid only; cmux/curl are stubbed — never touches a live session.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T34]: $*" >&2; exit 1; }

SID="worker-victim-T34"
CMUX_LOG="$T_TMP/cmux.log"
CURL_LOG="$T_TMP/curl.log"

# telepty orphan (list []) so the control run reaches the DELETE backup path.
printf '%s' '[]' > "$STUB_LIST_FILE"

# Stubs that RECORD any cleanup side-effect (must NOT fire under the worker guard).
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
echo "cmux \$*" >> "$CMUX_LOG"
if [ "\$1" = "--json" ] && [ "\$2" = "list-workspaces" ]; then echo '{"workspaces":[]}'; fi
exit 0
EOF
cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
echo "curl \$*" >> "$CURL_LOG"
echo 404
EOF
chmod +x "$STUB_BIN/cmux" "$STUB_BIN/curl"

# ── worker run: must be refused, no side-effects ──
: > "$CMUX_LOG"; : > "$CURL_LOG"
set +e
err_out=$(AIGENTRY_WORKER_SESSION=1 "$BASH_BIN" "$CLEANUP" "$SID" 2>&1 >/dev/null)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "worker run exited 0 — guard did not refuse (AIGENTRY_WORKER_SESSION ignored)"
printf '%s' "$err_out" | grep -qi "orchestrator-only" \
  || fail "worker refusal message missing 'orchestrator-only'. stderr: $err_out"
[ ! -s "$CURL_LOG" ] \
  || fail "worker run performed DELETE cleanup despite guard. curl log:
$(cat "$CURL_LOG")"

# ── control run: unset → guard passes, normal orphan path runs (DELETE fires) ──
: > "$CMUX_LOG"; : > "$CURL_LOG"
env -u AIGENTRY_WORKER_SESSION "$BASH_BIN" "$CLEANUP" "$SID" >/dev/null 2>&1 \
  || fail "control run (no worker marker) exited non-zero on a telepty-orphan"
grep -q "DELETE" "$CURL_LOG" \
  || fail "control run did NOT reach normal cleanup (DELETE backup). curl log:
$(cat "$CURL_LOG")"

echo "T34 PASS"
