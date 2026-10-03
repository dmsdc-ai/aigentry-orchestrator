#!/usr/bin/env bash
# cleanup-close-lib.sh — shared fixture helper for the #1162 cleanup-close guards
# (T160_cleanup_close_evidence.sh, T161_cleanup_close_exit_batch.sh).
#
# WHY A SECOND HELPER NEXT TO lib.sh. It is not a second harness. It SOURCES
# lib.sh and keeps t_setup's posture verbatim: $STUB_BIN first on PATH, an
# ABSOLUTE $TELEPTY pointing at tests/dispatch/stubs/telepty, DISPATCH_STATE_DIR
# and AIGENTRY_ROLE_SANDBOX_DIR redirected under $T_TMP, bus bridge and sleep
# guard off. What lib.sh does not provide is the seam set bin/session-cleanup.sh
# and bin/wh-cli.sh reach for — cmux, curl, CLEANUP_PS_CMD, KILL_CMD — and the
# two guards below need exactly the same five fakes, the same fixture-sid
# convention and the same kill tripwire. That is the genuine duplication this
# file removes; everything scenario-specific stays in the guard that owns it.
#
# THE RULE FROM lib.sh STILL HOLDS: A GUARD MUST NOT BE ABLE TO REACH THE LIVE
# WORKSPACE. This file only tightens it:
#   * every external command the code under test invokes is a FAKE that LOGS its
#     argv: cmux, telepty (lib.sh's stub), curl, ps (CLEANUP_PS_CMD), kill
#     (KILL_CMD). cc_selfcheck proves each one is executable and that the
#     invocation log actually records a call before anything is measured;
#   * HOME is redirected under $T_TMP on top of lib.sh's redirections;
#   * every sid is FIXTURE-ONLY (sid-m1-*, sid-v2-*, sid-repro-*), never
#     `orchestrator` and never a real worker sid, so even a resolved real binary
#     has nothing to disturb — the primary defence lib.sh names;
#   * KILL_CMD is a TRIPWIRE: cc_assert_no_kills fails the case if it was ever
#     invoked. No guard in this family may signal any process;
#   * DISPATCH_REGISTRY_PY defaults to a path that does not exist, so the
#     registry write is a no-op rather than an unstubbed reach. A guard that
#     needs the registry to ANSWER installs a logging fake of its own;
#   * no network: curl is faked, and nothing binds or connects a socket.
#
# EXIT SEMANTICS — READ THIS BEFORE COPYING THE PATTERN. The validation-tree
# ancestors of these guards ended in a literal `exit 0`, so a suite with failing
# assertions still reported shell exit 0 and a runner counted it as a pass. That
# is the false-green this repo's run-all.sh exists to catch, and it is NOT
# preserved here: cc_exit returns non-zero whenever any assertion did not hold,
# and every guard in this family must end with it.

# shellcheck source=lib.sh
CC_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$CC_LIB_DIR/lib.sh"
# lib.sh runs under `set -e`. These guards count assertions rather than aborting
# on the first one, and their probes legitimately return non-zero (grep -c on an
# empty log, a CLI under test exiting 1), so errexit is dropped for this family
# only. nounset and pipefail are kept.
set +e
set -uo pipefail

CC_REPO_ROOT="$REPO_ROOT"
CC_CLEANUP_SH="$CC_REPO_ROOT/bin/session-cleanup.sh"
CC_WH_CLI="$CC_REPO_ROOT/bin/wh-cli.sh"
CC_CLI_JS="$CC_REPO_ROOT/dist/src/cleanup/cli.js"
CC_BASH_BIN="$(command -v bash)"

# ── build gate ────────────────────────────────────────────────────────────────
# bin/session-cleanup.sh is an exec shim onto dist/src/cleanup/cli.js. Without a
# build the shim exits 2 with its own diagnostic on EVERY case, which would read
# as ~245 assertion failures rather than as one missing prerequisite. Fail once,
# clearly, and non-zero — never skip, because a skip here is how this suite's
# whole subject silently stops being measured.
cc_require_build() {
  local missing=""
  [ -f "$CC_CLEANUP_SH" ] || missing="$missing bin/session-cleanup.sh"
  [ -f "$CC_WH_CLI" ]     || missing="$missing bin/wh-cli.sh"
  [ -f "$CC_CLI_JS" ]     || missing="$missing dist/src/cleanup/cli.js"
  if [ -n "$missing" ]; then
    printf '%s\n' \
      "cleanup-close-lib: MISSING BUILD — not found under $CC_REPO_ROOT:$missing" \
      "  Run \`tsc -p .\` in the repo root first. This guard measures the compiled" \
      "  cleanup CLI through its bin/ shim; without dist/ there is nothing to measure," \
      "  and it fails rather than skipping so the gap cannot pass as green." >&2
    exit 2
  fi
}

# ── TAP ───────────────────────────────────────────────────────────────────────
CC_TESTS=0
CC_PASS=0
CC_FAIL=0

cc_plan() { printf '1..%s\n' "$1"; }

cc_ok() {
  CC_TESTS=$((CC_TESTS + 1)); CC_PASS=$((CC_PASS + 1))
  printf 'ok %s - %s\n' "$CC_TESTS" "$1"
}
cc_not_ok() {
  CC_TESTS=$((CC_TESTS + 1)); CC_FAIL=$((CC_FAIL + 1))
  printf 'not ok %s - %s\n' "$CC_TESTS" "$1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/#   /'
  return 0
}

# cc_expect_exit <got> <want> <desc> [detail]
cc_expect_exit() {
  local got="$1" want="$2" desc="$3" detail="${4:-}"
  if [ "$got" = "$want" ]; then
    cc_ok "$desc (exit=$got)"
  else
    cc_not_ok "$desc" "expected exit=$want, got exit=$got${detail:+
$detail}"
  fi
}

cc_summary() {
  printf '# %s: cases=%s pass=%s fail=%s\n' "${1:-suite}" "$CC_TESTS" "$CC_PASS" "$CC_FAIL"
  printf 'COUNTS %s cases=%s pass=%s fail=%s\n' \
    "${1:-suite}" "$CC_TESTS" "$CC_PASS" "$CC_FAIL" >&2
}

# cc_exit — the anti-false-green gate. A guard that measured nothing (zero
# assertions) is as bad as one with a failure, so both are non-zero.
cc_exit() {
  if [ "$CC_TESTS" -eq 0 ]; then
    echo "FAIL: ${1:-suite} recorded NO assertions — it measured nothing" >&2
    exit 1
  fi
  [ "$CC_FAIL" -eq 0 ] || exit 1
  exit 0
}

# ── setup ─────────────────────────────────────────────────────────────────────
# cc_setup <suite-name> — t_setup's posture plus the cleanup-close seams.
# Evidence (per-case stdout/stderr/exit and the fake call traces) lands in
# $CC_EVID, which defaults under $T_TMP so a CI run leaves nothing behind.
# CLEANUP_CLOSE_EVIDENCE_DIR retains it elsewhere for an investigation.
cc_setup() {
  local suite="$1"
  cc_require_build
  t_setup
  # t_setup redirects state and the role sandbox; HOME is the remaining root the
  # cleanup CLI writes under (legacy sidecars, telemetry).
  export HOME="$T_TMP/home"
  mkdir -p "$HOME"
  if [ -n "${CLEANUP_CLOSE_EVIDENCE_DIR:-}" ]; then
    CC_EVID="$CLEANUP_CLOSE_EVIDENCE_DIR/$suite"
  else
    CC_EVID="$T_TMP/evidence/$suite"
  fi
  export CC_EVID
  mkdir -p "$CC_EVID/calls"
  export CMUX_CALLS="$T_TMP/cmux-calls.log";       : > "$CMUX_CALLS"
  export TELEPTY_CALLS="$T_TMP/telepty-calls.log"; : > "$TELEPTY_CALLS"
  export CURL_CALLS="$T_TMP/curl-calls.log";       : > "$CURL_CALLS"
  export PS_CALLS="$T_TMP/ps-calls.log";           : > "$PS_CALLS"
  export KILL_CALLS="$T_TMP/kill-calls.log";       : > "$KILL_CALLS"
  # lib.sh's stub telepty answers `list --json` from STUB_LIST_FILE; the cleanup
  # CLI's lister reads exactly that seam, so the stub is reused rather than
  # replaced. Non-empty on purpose: telepty-listing.sh only probes an EMPTY
  # array, so a seeded row keeps the corroboration path out of the measurement.
  export FAKE_LIST_FILE="$STUB_LIST_FILE"
  printf '%s' '[]' > "$FAKE_LIST_FILE"
  cc_fake_cmux_default
  cc_fake_curl 404
  cc_fake_ps
  cc_fake_kill
  export CURL="$STUB_BIN/curl"
  export CLEANUP_PS_CMD="$STUB_BIN/ps-fake"
  export KILL_CMD="$STUB_BIN/kill-fake"
  # a path that does not exist → registryCleaned is a no-op, not an unstubbed
  # reach. A guard that needs the registry to answer installs its own fake.
  export DISPATCH_REGISTRY_PY="$T_TMP/no-such-registry.py"
}

# cc_selfcheck — the harness proves ITSELF before it measures anything: every
# fake is executable and its invocation log actually records a call. A run that
# cannot log a call cannot support an "assert the fake was used" claim, so this
# is a hard exit rather than a case.
cc_selfcheck() {
  local b
  for b in cmux telepty curl ps-fake kill-fake; do
    [ -x "$STUB_BIN/$b" ] || { echo "cc_selfcheck: fake '$b' missing or not executable in $STUB_BIN" >&2; exit 2; }
  done
  [ "$TELEPTY" = "$STUB_BIN/telepty" ] || {
    echo "cc_selfcheck: TELEPTY is '$TELEPTY', not the absolute stub — the live-reach guarantee is gone" >&2; exit 2; }
  "$STUB_BIN/cmux" __selfcheck >/dev/null 2>&1 || true
  grep -q '__selfcheck' "$CMUX_CALLS" || {
    echo "cc_selfcheck: the cmux fake did not record its invocation in $CMUX_CALLS" >&2; exit 2; }
  "$STUB_BIN/ps-fake" -eo pid,ppid,command >/dev/null 2>&1 || true
  grep -q 'pid,ppid,command' "$PS_CALLS" || {
    echo "cc_selfcheck: the ps fake did not record its invocation in $PS_CALLS" >&2; exit 2; }
  "$STUB_BIN/kill-fake" -TERM 999999 >/dev/null 2>&1 || true
  grep -q '999999' "$KILL_CALLS" || {
    echo "cc_selfcheck: the kill TRIPWIRE did not record its invocation in $KILL_CALLS — an empty tripwire would be vacuous" >&2; exit 2; }
  cc_reset_logs
  echo "# harness self-check: 5 fakes executable, invocation logging verified, kill tripwire armed"
}

cc_teardown() {
  # Own children only: nothing is backgrounded here and no kill-by-name is ever
  # issued. Removing $T_TMP is the whole teardown; retained evidence, when it
  # was redirected out of $T_TMP, is the caller's.
  [ -n "${T_TMP:-}" ] && rm -rf "$T_TMP"
  return 0
}

# ── fakes (each logs its argv; assertions below prove they were used) ─────────
# cc_fake_cmux <<'ARMS' ... ARMS — body is the `case "$1" in` arms for cmux verbs.
# cc_fake_cmux_default — logging-only cmux fake (every verb succeeds, nothing is
# asserted against it). Exists so cc_selfcheck has a fake to exercise.
cc_fake_cmux_default() {
  {
    printf '%s\n' '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$*\" >> \"$CMUX_CALLS\"" 'exit 0'
  } > "$STUB_BIN/cmux"
  chmod +x "$STUB_BIN/cmux"
}

cc_fake_cmux() {
  {
    printf '%s\n' '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$*\" >> \"$CMUX_CALLS\"" \
      'case "$1" in'
    cat
    printf '%s\n' '  *) exit 0;;' 'esac'
  } > "$STUB_BIN/cmux"
  chmod +x "$STUB_BIN/cmux"
}

# cc_fake_curl <http-code> — answers the registry DELETE (and any probe) with a
# fixed code on stdout, as `-w '%{http_code}'` does. Never touches the network.
cc_fake_curl() {
  {
    printf '%s\n' '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$*\" >> \"$CURL_CALLS\"" \
      "printf '%s' '${1:-404}'"
  } > "$STUB_BIN/curl"
  chmod +x "$STUB_BIN/curl"
}

# cc_fake_ps — a FIXED process table with no `telepty allow --id <sid>` row, so
# the kill step always takes the "already exited?" arm and no pid is ever
# selected. Nothing here can name a real process.
cc_fake_ps() {
  {
    printf '%s\n' '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$*\" >> \"$PS_CALLS\"" \
      "printf '%s\\n' '  PID  PPID COMMAND' '  101     1 /sbin/launchd' '  202   101 fixture-unrelated-process'"
  } > "$STUB_BIN/ps-fake"
  chmod +x "$STUB_BIN/ps-fake"
}

# cc_fake_kill — TRIPWIRE. Logs and succeeds; cc_assert_no_kills fails any case
# in which it was invoked. No guard in this family may signal a process.
cc_fake_kill() {
  {
    printf '%s\n' '#!/usr/bin/env bash' \
      "printf '%s\\n' \"\$*\" >> \"$KILL_CALLS\"" 'exit 0'
  } > "$STUB_BIN/kill-fake"
  chmod +x "$STUB_BIN/kill-fake"
}

# ── seed ──────────────────────────────────────────────────────────────────────
# cc_list_one <sid> <host_id> [health] — what the stub `telepty list --json`
# reports.
cc_list_one() {
  printf '[{"id":"%s","command":"claude","healthStatus":"%s","cmuxWorkspaceId":"%s"}]' \
    "$1" "${3:-CONNECTED}" "$2" > "$FAKE_LIST_FILE"
}

# ── assertions ────────────────────────────────────────────────────────────────
# cc_has / cc_none / cc_has_re read one or more evidence files. The two
# refutation-by-regex helpers differ ON PURPOSE and are NOT merged: the evidence
# guard matches case-INSENSITIVELY (a positive state claim is a claim however it
# is cased) while the exit-contract guard matches case-sensitively against its
# own emitted tokens. Merging them would silently change one oracle.
cc_has() { local n="$1" d="$2"; shift 2
  if grep -qF -- "$n" "$@" 2>/dev/null; then cc_ok "$d"
  else cc_not_ok "$d" "not found: $n
--- combined ---
$(cat "$@" 2>/dev/null)"; fi; }

cc_has_re() { local re="$1" d="$2"; shift 2
  if grep -qE -- "$re" "$@" 2>/dev/null; then cc_ok "$d"
  else cc_not_ok "$d" "ERE did not match: $re
--- combined ---
$(cat "$@" 2>/dev/null)"; fi; }

cc_none() { local n="$1" d="$2"; shift 2
  if grep -qF -- "$n" "$@" 2>/dev/null; then cc_not_ok "$d" "MUST NOT appear but does: $n
--- combined ---
$(cat "$@" 2>/dev/null)"
  else cc_ok "$d"; fi; }

# case-INSENSITIVE refutation (T160's positive-claim oracle)
cc_none_re_i() { local re="$1" d="$2"; shift 2
  if grep -qEi -- "$re" "$@" 2>/dev/null; then cc_not_ok "$d" "MUST NOT match but does: $re
--- combined ---
$(cat "$@" 2>/dev/null)"
  else cc_ok "$d"; fi; }

# case-SENSITIVE refutation (T161's token oracle)
cc_none_re() { local re="$1" d="$2"; shift 2
  if grep -qE -- "$re" "$@" 2>/dev/null; then cc_not_ok "$d" "ERE MUST NOT match but does: $re
--- combined ---
$(cat "$@" 2>/dev/null)"
  else cc_ok "$d"; fi; }

cc_assert_cmux_count() {
  local needle="$1" want="$2" desc="$3" n
  n=$(grep -cF -- "$needle" "$CMUX_CALLS" || true)
  if [ "$n" = "$want" ]; then
    cc_ok "$desc (n=$n)"
  else
    cc_not_ok "$desc" "expected $want call(s) matching '$needle', got $n
--- cmux calls ---
$(cat "$CMUX_CALLS")"
  fi
}

cc_assert_no_kills() {
  if [ ! -s "$KILL_CALLS" ]; then
    cc_ok "${1:-kill tripwire stayed empty (no process signalled)}"
  else
    cc_not_ok "${1:-kill tripwire stayed empty}" "KILL_CMD WAS INVOKED:
$(cat "$KILL_CALLS")"
  fi
}

# ── runners (every subprocess under a deadline) ───────────────────────────────
# Each child is bounded; the suite-level budget is the run-all per-guard budget.
CC_DEADLINE="${CC_DEADLINE:-25}"

# cc_wait_child <pid> <case-name> — shared deadline/reap/record tail. Prints the
# exit code, or TIMEOUT. Kills OWN CHILD ONLY, by pid, never by name.
cc_wait_child() {
  local pid="$1" name="$2" rc=0 waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$CC_DEADLINE" ]; do
    sleep 1; waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    printf 'TIMEOUT\n' > "$CC_EVID/$name.exit"
    printf 'TIMEOUT'
    return 0
  fi
  wait "$pid" || rc=$?
  printf '%s\n' "$rc" > "$CC_EVID/$name.exit"
  cc_archive_logs "$name"
  printf '%s' "$rc"
}

# cc_run_wh <case-name> <verb> <args...> — bin/wh-cli.sh under the cmux adapter.
cc_run_wh() {
  local name="$1"; shift
  env AIGENTRY_WORKSPACE_HOST=cmux PATH="$PATH" HOME="$HOME" \
      TELEPTY="$TELEPTY" CURL="$CURL" \
      AIGENTRY_ROLE_SANDBOX_DIR="$AIGENTRY_ROLE_SANDBOX_DIR" \
      "$CC_BASH_BIN" "$CC_WH_CLI" "$@" >"$CC_EVID/$name.out" 2>"$CC_EVID/$name.err" &
  cc_wait_child "$!" "$name"
}

# cc_run_cleanup <case-name> <args...> — bin/session-cleanup.sh (the real shim →
# the compiled cli.js) with every seam faked. Prints its exit code.
cc_run_cleanup() {
  local name="$1"; shift
  env -u AIGENTRY_WORKER_SESSION \
      AIGENTRY_WORKSPACE_HOST=cmux \
      PATH="$PATH" HOME="$HOME" \
      TELEPTY="$TELEPTY" CURL="$CURL" \
      CLEANUP_PS_CMD="$CLEANUP_PS_CMD" KILL_CMD="$KILL_CMD" \
      DISPATCH_REGISTRY_PY="$DISPATCH_REGISTRY_PY" \
      ORCHESTRATOR_SID="sid-repro-protected-fixture" \
      "$CC_BASH_BIN" "$CC_CLEANUP_SH" "$@" >"$CC_EVID/$name.out" 2>"$CC_EVID/$name.err" &
  cc_wait_child "$!" "$name"
}

# ── call-trace retention ──────────────────────────────────────────────────────
# The invocation logs live under $T_TMP, which teardown removes, so every runner
# archives the trace as it stands after its own case under $CC_EVID/calls/<case>.*.
# Logs are truncated per SCENARIO (cc_reset_logs), so a case's archive holds every
# call made since its scenario's fixture was installed.
CC_PREV_LABEL=""

cc_archive_logs() {
  local label="${1:-${CC_PREV_LABEL:-}}" tool src
  [ -n "$label" ] || return 0
  [ -n "${CC_EVID:-}" ] || return 0
  mkdir -p "$CC_EVID/calls"
  for tool in cmux telepty curl ps kill; do
    case "$tool" in
      cmux) src="$CMUX_CALLS";; telepty) src="$TELEPTY_CALLS";;
      curl) src="$CURL_CALLS";; ps) src="$PS_CALLS";; kill) src="$KILL_CALLS";;
    esac
    [ -f "$src" ] && cp "$src" "$CC_EVID/calls/$label.$tool.log"
  done
  return 0
}

cc_reset_logs() {
  CC_PREV_LABEL="${1:-}"
  : > "$CMUX_CALLS"; : > "$TELEPTY_CALLS"; : > "$CURL_CALLS"; : > "$PS_CALLS"; : > "$KILL_CALLS"
}
