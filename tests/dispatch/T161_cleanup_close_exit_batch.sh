#!/usr/bin/env bash
# T161 — #1162 corrected close-failure EXIT contract, single-sid and both batch
# modes.
#
# Ported into the repository suite from the cl1162o validation tree's
# V2_exit_contract_batch.sh (authored ct1162z). 123 assertions, one-to-one: the
# ORACLES are unchanged, only the harness moved. The relocation is identical in
# kind to T160's and is described there; the two differences that belong to this
# file are that its runner threads the registry fake through as
# DISPATCH_REGISTRY_PY, and that its worker-guard cases must be able to SET
# AIGENTRY_WORKER_SESSION, which cc_run_cleanup unconditionally unsets — hence
# the local runner rather than the shared one.
#
# THE CONTRACT, and exactly what it supersedes. A KNOWN non-zero workspace close
# MUST produce a non-zero CLI PROCESS exit. That is reading B of #1162's
# "non-zero on both layers" (T160 N10b), and the controller selected it. It
# supersedes the best-effort exit-0 behaviour of fifteen older oracles, which are
# enumerated here rather than deleted, because a superseded oracle that is not
# written down is a silently dropped requirement:
#   R2 c7 B2 / c19 B5 / c22 B5b / c24 B6;
#   R4 c1 M1 / c13 M3 / c21 H1 / c28 H3a;
#   R5 c1 S1 / c5 S2 / c10 S3 / c13 S4 / c16 S5 / c20 S6 / c25 S7
#     — each asserted `session-cleanup.sh still exits 0` as a HOLD.
# Those fifteen live in the frozen reproduction suites (R1..R5), which are NOT
# part of this port; they were never relabelled green, and this file is where a
# future reader finds out why they now disagree with the shipped behaviour.
#
# UNCHANGED, re-asserted here so the supersession stays BOUNDED: a HEALTHY close
# (A15..A19), a GENUINE known-gone session (A20..A23), the protected-sid refusal
# (A24..A26), the --keep substring semantics (C7) and the worker refusal (D) all
# behave exactly as before. A15..A19 in particular is what makes A10's "no
# cleaned mark" a MEASURED absence rather than a vacuous one.
#
# KNOWN BOUNDARY, reported not fixed (G1). On the telepty-orphan arm (sid absent
# from the telepty list) the close status is still discarded: exit 0, no
# UNCONFIRMED, and registryCleaned(sid) is called unconditionally, so the sid is
# marked cleaned after a close that was never observed to succeed. That sits
# inside the separately-OPEN missing-lookup/orphan area and is NOT asserted as
# accepted here. A20..A23 measure only the GENUINE known-gone arm.
#
# NO PRODUCT EDITS. Synthetic sids only, kill tripwire armed on every case, no
# network. One addition over T160's posture: the dispatch registry gets an
# EXECUTABLE LOGGING FAKE instead of a nonexistent path, so "no cleaned mark on a
# failed sid" is a measured absence against a fake that demonstrably records the
# mark on the success path.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/cleanup-close-lib.sh"

cc_setup T161
trap cc_teardown EXIT
cc_selfcheck

SECRET="SYNTHETIC_TOKEN_DO_NOT_ECHO=sk-fixture-0000"
CLOSED_LINE="workspace host closed"
CAT_RE="(host-unreachable|host-timeout|close-refused|no-output|unknown-failure)"
POS_RE="(nothing was released|nothing released|wh_close_status=unreleased|surface retained|still retained)"
ESC="$(printf "\033")"

V2_PROTECTED="sid-v2-protected"
V2_FAIL_WS="$T_TMP/v2-failing-workspaces.txt"
V2_REG="$T_TMP/fake-dispatch-registry.py"
V2_REG_CALLS="$T_TMP/registry-calls.log"
: > "$V2_FAIL_WS"
: > "$V2_REG_CALLS"

# The registry fake logs argv and succeeds, so registryCleaned proceeds from
# observe to set-lifecycle and BOTH become visible. Never touches a real registry.
{
  printf "%s\n" "#!/usr/bin/env bash" \
    "printf \"%s\\n\" \"\$*\" >> \"$V2_REG_CALLS\"" \
    "exit 0"
} > "$V2_REG"
chmod +x "$V2_REG"
[ -x "$V2_REG" ] || { echo "T161: registry fake not executable" >&2; exit 2; }

echo "# T161 - corrected close-failure exit contract + batch regression"
echo "# shim: $CC_CLEANUP_SH"
echo "# compiled cli.js under test: $(shasum -a 256 "$CC_CLI_JS" | awk "{print \$1}")"

# v2_list <sid:ws:health> ... - what the stub telepty list --json reports.
v2_list() {
  local first=1 e sid rest ws h
  : > "$FAKE_LIST_FILE"
  printf "[" >> "$FAKE_LIST_FILE"
  for e in "$@"; do
    sid="${e%%:*}"; rest="${e#*:}"; ws="${rest%%:*}"; h="${rest##*:}"
    [ "$first" -eq 1 ] || printf "," >> "$FAKE_LIST_FILE"
    first=0
    printf "{\"id\":\"%s\",\"command\":\"claude\",\"healthStatus\":\"%s\",\"cmuxWorkspaceId\":\"%s\"}" \
      "$sid" "$h" "$ws" >> "$FAKE_LIST_FILE"
  done
  printf "]" >> "$FAKE_LIST_FILE"
}

# v2_fail_ws <ws> ... - exactly these workspace ids refuse the close AND the
# liveness re-probe. No argument means every close succeeds.
v2_fail_ws() { : > "$V2_FAIL_WS"; [ "$#" -eq 0 ] || printf "%s\n" "$@" > "$V2_FAIL_WS"; }

# One cmux fake for the whole guard, driven by $V2_FAIL_WS. The path is embedded
# at generation time so the fake needs no environment threaded through the CLI.
v2_install_cmux() {
  cc_fake_cmux <<ARMS
  close-workspace)
    if grep -qxF -- "\$3" "$V2_FAIL_WS" 2>/dev/null; then
      echo "Error: failed to connect to cmux daemon at 127.0.0.1:3848: Connection refused (os error 61)" >&2
      exit 1
    fi
    exit 0;;
  sidebar-state)
    if grep -qxF -- "\$3" "$V2_FAIL_WS" 2>/dev/null; then
      echo "Error: failed to connect to cmux daemon at 127.0.0.1:3848: Connection refused (os error 61)" >&2
      exit 1
    fi
    printf "state: active\n"; exit 0;;
  list-workspaces) exit 0;;
ARMS
}

v2_reset() { cc_reset_logs "$1"; : > "$V2_REG_CALLS"; v2_install_cmux; }

v2_run_env() {
  local name="$1" worker="$2"; shift 2
  local pre
  if [ "$worker" = "worker" ]; then pre="AIGENTRY_WORKER_SESSION=1"; else pre="-u AIGENTRY_WORKER_SESSION"; fi
  env $pre \
      AIGENTRY_WORKSPACE_HOST=cmux \
      PATH="$PATH" HOME="$HOME" \
      TELEPTY="$TELEPTY" CURL="$CURL" \
      CLEANUP_PS_CMD="$CLEANUP_PS_CMD" KILL_CMD="$KILL_CMD" \
      DISPATCH_REGISTRY_PY="$V2_REG" \
      ORCHESTRATOR_SID="$V2_PROTECTED" \
      "$CC_BASH_BIN" "$CC_CLEANUP_SH" "$@" >"$CC_EVID/$name.out" 2>"$CC_EVID/$name.err" &
  # Called directly, never through a nested command substitution: the child was
  # started in THIS shell, so only this shell can wait on and reap it.
  cc_wait_child "$!" "$name"
  cp "$V2_REG_CALLS" "$CC_EVID/calls/$name.registry.log" 2>/dev/null || true
}
v2_run() { local n="$1"; shift; v2_run_env "$n" normal "$@"; }
v2_run_worker() { local n="$1"; shift; v2_run_env "$n" worker "$@"; }

v2_no_cleaned_mark() { cc_none "set-lifecycle --sid $1 --state cleaned" "$2" "$V2_REG_CALLS"; }
v2_cleaned_mark()    { cc_has  "set-lifecycle --sid $1 --state cleaned" "$2" "$V2_REG_CALLS"; }
v2_delete_called()   { cc_has  "DELETE http://127.0.0.1:3848/api/sessions/$1" "$2" "$CURL_CALLS"; }

echo "# ---- A) single-sid corrected exit contract ----"

# A1..A14) KNOWN NON-ZERO CLOSE on a normal, in-list sid.
v2_reset a1
v2_list "sid-v2-a1:ws-v2-a1:DISCONNECTED"
v2_fail_ws ws-v2-a1
rc=$(v2_run a1-failed-close sid-v2-a1)
cc_expect_exit "$rc" 1 "A1) known non-zero close: CLI PROCESS exit is non-zero (supersedes R2 c7 B2)"
cc_has "UNCONFIRMED" "A2) the outcome is reported UNCONFIRMED" "$CC_EVID/a1-failed-close.out"
cc_none "$CLOSED_LINE" "A3) no false closed claim on a failed close" "$CC_EVID/a1-failed-close.out" "$CC_EVID/a1-failed-close.err"
cc_none_re "$POS_RE" "A4) no positive retention/release claim on either stream" "$CC_EVID/a1-failed-close.out" "$CC_EVID/a1-failed-close.err"
cc_none "$SECRET" "A5) no raw fixture secret reached the CLI output" "$CC_EVID/a1-failed-close.out" "$CC_EVID/a1-failed-close.err"
cc_none "$ESC" "A6) no ESC/control byte relayed from adapter output" "$CC_EVID/a1-failed-close.out" "$CC_EVID/a1-failed-close.err"
cc_has_re "$CAT_RE" "A7) the failure carries a closed-vocabulary category" "$CC_EVID/a1-failed-close.out"
cc_assert_cmux_count "close-workspace --workspace ws-v2-a1" 1 "A8) exactly ONE close attempt (no new retry)"
cc_assert_cmux_count "sidebar-state --workspace ws-v2-a1" 1 "A9) exactly ONE liveness re-probe (no new retry)"
v2_no_cleaned_mark sid-v2-a1 "A10) failed sid is NOT marked cleaned in the dispatch lifecycle"
cc_none "observe --sid sid-v2-a1" "A11) failed sid records no session_absent_observed" "$V2_REG_CALLS"
v2_delete_called sid-v2-a1 "A12) the bounded EXISTING registry DELETE still ran for the failed sid"
cc_has "no parent telepty-allow process for sid-v2-a1" "A13) the existing kill step still ran (already-exited arm)" "$CC_EVID/a1-failed-close.out"
cc_assert_no_kills "A14) kill tripwire stayed empty on the failed close"

# A15..A19) HEALTHY CLOSE still succeeds. This bounds the supersession AND makes
# A10 a measured absence rather than a vacuous one.
v2_reset a2
v2_list "sid-v2-a2:ws-v2-a2:DISCONNECTED"
v2_fail_ws
rc=$(v2_run a2-healthy-close sid-v2-a2)
cc_expect_exit "$rc" 0 "A15) healthy close still exits 0 (unchanged)"
cc_has "$CLOSED_LINE" "A16) healthy close reports the close" "$CC_EVID/a2-healthy-close.out"
v2_cleaned_mark sid-v2-a2 "A17) healthy sid IS marked cleaned (proves A10 is a measured absence)"
v2_delete_called sid-v2-a2 "A18) healthy sid still got the registry DELETE"
cc_assert_no_kills "A19) kill tripwire stayed empty on the healthy close"

# A20..A23) GENUINE whole-failed-reply KNOWN GONE (sid absent from the telepty
# list) still succeeds - the close-for-sid orphan arm.
v2_reset a3
v2_list "sid-v2-other:ws-v2-other:CONNECTED"
v2_fail_ws
rc=$(v2_run a3-known-gone sid-v2-a3)
cc_expect_exit "$rc" 0 "A20) genuine known-gone session still exits 0 (unchanged)"
cc_has "session not in telepty list: sid-v2-a3" "A21) the known-gone arm was taken" "$CC_EVID/a3-known-gone.out"
v2_cleaned_mark sid-v2-a3 "A22) known-gone sid is still marked cleaned"
cc_assert_no_kills "A23) kill tripwire stayed empty on the known-gone arm"

# A24..A26) PROTECTED sid refusal (Rule 28) unchanged and still exit 1.
v2_reset a4
v2_list "$V2_PROTECTED:ws-v2-prot:DISCONNECTED"
v2_fail_ws
rc=$(v2_run a4-protected "$V2_PROTECTED")
cc_expect_exit "$rc" 1 "A24) protected sid refusal still exits 1 (unchanged)"
cc_assert_cmux_count "close-workspace --workspace ws-v2-prot" 0 "A25) protected sid: no close was attempted"
cc_assert_no_kills "A26) kill tripwire stayed empty on the protected refusal"

# ── batch helpers ────────────────────────────────────────────────────────────
# every eligible workspace was processed EXACTLY ONCE (no skip, no double sweep)
v2_each_closed_once() {
  local tag="$1"; shift
  local w
  for w in "$@"; do
    cc_assert_cmux_count "close-workspace --workspace $w" 1 "$tag) $w was closed exactly once"
  done
}

V2_B_ALL="sid-v2-b1:ws-v2-b1:DISCONNECTED sid-v2-b2:ws-v2-b2:DISCONNECTED sid-v2-b3:ws-v2-b3:DISCONNECTED $V2_PROTECTED:ws-v2-prot:DISCONNECTED"

echo "# ---- B) batch mode --all-disconnected ----"

# B1) ALL SUCCESS
v2_reset b1
v2_list $V2_B_ALL
v2_fail_ws
rc=$(v2_run b1-all-success --all-disconnected)
cc_expect_exit "$rc" 0 "B1) batch all-success exits 0"
cc_has "cleaned: 3 disconnected sessions" "B1) counts all 3 eligible sids as cleaned" "$CC_EVID/b1-all-success.out"
v2_each_closed_once B1 ws-v2-b1 ws-v2-b2 ws-v2-b3
cc_assert_cmux_count "close-workspace --workspace ws-v2-prot" 0 "B1) the PROTECTED sid was excluded from the sweep"
cc_assert_no_kills "B1) kill tripwire stayed empty"

# B2) MIXED - failure FIRST
v2_reset b2
v2_list $V2_B_ALL
v2_fail_ws ws-v2-b1
rc=$(v2_run b2-fail-first --all-disconnected)
cc_expect_exit "$rc" 1 "B2) batch with a known close failure FIRST exits non-zero"
cc_has "cleaned: 2 disconnected sessions" "B2) counts ONLY the 2 successful sids" "$CC_EVID/b2-fail-first.out"
v2_each_closed_once B2 ws-v2-b1 ws-v2-b2 ws-v2-b3
v2_no_cleaned_mark sid-v2-b1 "B2) the FAILED sid is not marked cleaned"
v2_cleaned_mark sid-v2-b2 "B2) the later sids were still swept (b2 marked cleaned)"
v2_cleaned_mark sid-v2-b3 "B2) the later sids were still swept (b3 marked cleaned)"
cc_assert_no_kills "B2) kill tripwire stayed empty"

# B3) MIXED - failure MIDDLE
v2_reset b3
v2_list $V2_B_ALL
v2_fail_ws ws-v2-b2
rc=$(v2_run b3-fail-middle --all-disconnected)
cc_expect_exit "$rc" 1 "B3) batch with a known close failure in the MIDDLE exits non-zero"
cc_has "cleaned: 2 disconnected sessions" "B3) counts ONLY the 2 successful sids" "$CC_EVID/b3-fail-middle.out"
v2_each_closed_once B3 ws-v2-b1 ws-v2-b2 ws-v2-b3
v2_no_cleaned_mark sid-v2-b2 "B3) the FAILED sid is not marked cleaned"
v2_cleaned_mark sid-v2-b3 "B3) the sweep continued past the failure (b3 marked cleaned)"
cc_assert_no_kills "B3) kill tripwire stayed empty"

# B4) MIXED - failure LAST
v2_reset b4
v2_list $V2_B_ALL
v2_fail_ws ws-v2-b3
rc=$(v2_run b4-fail-last --all-disconnected)
cc_expect_exit "$rc" 1 "B4) batch with a known close failure LAST exits non-zero"
cc_has "cleaned: 2 disconnected sessions" "B4) counts ONLY the 2 successful sids" "$CC_EVID/b4-fail-last.out"
v2_each_closed_once B4 ws-v2-b1 ws-v2-b2 ws-v2-b3
v2_no_cleaned_mark sid-v2-b3 "B4) the FAILED sid is not marked cleaned"
cc_assert_no_kills "B4) kill tripwire stayed empty"

# B5) ALL FAILURE
v2_reset b5
v2_list $V2_B_ALL
v2_fail_ws ws-v2-b1 ws-v2-b2 ws-v2-b3
rc=$(v2_run b5-all-fail --all-disconnected)
cc_expect_exit "$rc" 1 "B5) batch all-failure exits non-zero"
cc_has "cleaned: 0 disconnected sessions" "B5) counts NO sid as cleaned" "$CC_EVID/b5-all-fail.out"
v2_each_closed_once B5 ws-v2-b1 ws-v2-b2 ws-v2-b3
v2_no_cleaned_mark sid-v2-b1 "B5) no cleaned mark for b1"
v2_no_cleaned_mark sid-v2-b2 "B5) no cleaned mark for b2"
v2_no_cleaned_mark sid-v2-b3 "B5) no cleaned mark for b3"
cc_assert_no_kills "B5) kill tripwire stayed empty"

# B6) NO ELIGIBLE sid
v2_reset b6
v2_list "sid-v2-b9:ws-v2-b9:CONNECTED"
v2_fail_ws
rc=$(v2_run b6-no-eligible --all-disconnected)
cc_expect_exit "$rc" 0 "B6) batch with no eligible sid exits 0"
cc_has "cleaned: 0 disconnected sessions" "B6) reports zero cleaned" "$CC_EVID/b6-no-eligible.out"
cc_assert_cmux_count "close-workspace" 0 "B6) no close was attempted at all"
cc_assert_no_kills "B6) kill tripwire stayed empty"

V2_C_ALL="sid-v2-c1:ws-v2-c1:CONNECTED sid-v2-c2:ws-v2-c2:DISCONNECTED sid-v2-c3:ws-v2-c3:CONNECTED $V2_PROTECTED:ws-v2-prot:CONNECTED"

echo "# ---- C) batch mode --all-unused ----"

# C1) ALL SUCCESS
v2_reset c1
v2_list $V2_C_ALL
v2_fail_ws
rc=$(v2_run c1-all-success --all-unused)
cc_expect_exit "$rc" 0 "C1) batch all-success exits 0"
cc_has "cleaned: 3 unused sessions" "C1) counts all 3 eligible sids as cleaned" "$CC_EVID/c1-all-success.out"
v2_each_closed_once C1 ws-v2-c1 ws-v2-c2 ws-v2-c3
cc_assert_cmux_count "close-workspace --workspace ws-v2-prot" 0 "C1) the PROTECTED sid was excluded from the sweep"
cc_assert_no_kills "C1) kill tripwire stayed empty"

# C2) MIXED - failure FIRST
v2_reset c2
v2_list $V2_C_ALL
v2_fail_ws ws-v2-c1
rc=$(v2_run c2-fail-first --all-unused)
cc_expect_exit "$rc" 1 "C2) batch with a known close failure FIRST exits non-zero"
cc_has "cleaned: 2 unused sessions" "C2) counts ONLY the 2 successful sids" "$CC_EVID/c2-fail-first.out"
v2_each_closed_once C2 ws-v2-c1 ws-v2-c2 ws-v2-c3
v2_no_cleaned_mark sid-v2-c1 "C2) the FAILED sid is not marked cleaned"
v2_cleaned_mark sid-v2-c3 "C2) the sweep continued past the failure (c3 marked cleaned)"
cc_assert_no_kills "C2) kill tripwire stayed empty"

# C3) MIXED - failure MIDDLE
v2_reset c3
v2_list $V2_C_ALL
v2_fail_ws ws-v2-c2
rc=$(v2_run c3-fail-middle --all-unused)
cc_expect_exit "$rc" 1 "C3) batch with a known close failure in the MIDDLE exits non-zero"
cc_has "cleaned: 2 unused sessions" "C3) counts ONLY the 2 successful sids" "$CC_EVID/c3-fail-middle.out"
v2_each_closed_once C3 ws-v2-c1 ws-v2-c2 ws-v2-c3
v2_no_cleaned_mark sid-v2-c2 "C3) the FAILED sid is not marked cleaned"
cc_assert_no_kills "C3) kill tripwire stayed empty"

# C4) MIXED - failure LAST
v2_reset c4
v2_list $V2_C_ALL
v2_fail_ws ws-v2-c3
rc=$(v2_run c4-fail-last --all-unused)
cc_expect_exit "$rc" 1 "C4) batch with a known close failure LAST exits non-zero"
cc_has "cleaned: 2 unused sessions" "C4) counts ONLY the 2 successful sids" "$CC_EVID/c4-fail-last.out"
v2_each_closed_once C4 ws-v2-c1 ws-v2-c2 ws-v2-c3
v2_no_cleaned_mark sid-v2-c3 "C4) the FAILED sid is not marked cleaned"
cc_assert_no_kills "C4) kill tripwire stayed empty"

# C5) ALL FAILURE
v2_reset c5
v2_list $V2_C_ALL
v2_fail_ws ws-v2-c1 ws-v2-c2 ws-v2-c3
rc=$(v2_run c5-all-fail --all-unused)
cc_expect_exit "$rc" 1 "C5) batch all-failure exits non-zero"
cc_has "cleaned: 0 unused sessions" "C5) counts NO sid as cleaned" "$CC_EVID/c5-all-fail.out"
v2_each_closed_once C5 ws-v2-c1 ws-v2-c2 ws-v2-c3
v2_no_cleaned_mark sid-v2-c1 "C5) no cleaned mark for c1"
v2_no_cleaned_mark sid-v2-c2 "C5) no cleaned mark for c2"
v2_no_cleaned_mark sid-v2-c3 "C5) no cleaned mark for c3"
cc_assert_no_kills "C5) kill tripwire stayed empty"

# C6) NO ELIGIBLE sid - everything is either protected or kept
v2_reset c6
v2_list "$V2_PROTECTED:ws-v2-prot:CONNECTED" "sid-v2-c7:ws-v2-c7:CONNECTED"
v2_fail_ws
rc=$(v2_run c6-no-eligible --all-unused --keep sid-v2-c7)
cc_expect_exit "$rc" 0 "C6) batch with no eligible sid exits 0"
cc_has "cleaned: 0 unused sessions" "C6) reports zero cleaned" "$CC_EVID/c6-no-eligible.out"
cc_assert_cmux_count "close-workspace" 0 "C6) no close was attempted at all"
cc_assert_no_kills "C6) kill tripwire stayed empty"

# C7) KEEP-LIST semantics, including the reproduced jq SUBSTRING containment:
# --keep sid-v2-k1-long also protects the sid sid-v2-k1. Reproduced, not tightened.
v2_reset c7
v2_list "sid-v2-k1:ws-v2-k1:CONNECTED" "sid-v2-k2:ws-v2-k2:CONNECTED"
v2_fail_ws
rc=$(v2_run c7-keep-substring --all-unused --keep sid-v2-k1-long)
cc_expect_exit "$rc" 0 "C7) keep-list sweep exits 0"
cc_assert_cmux_count "close-workspace --workspace ws-v2-k1" 0 "C7) --keep SUBSTRING containment still protects sid-v2-k1 (unchanged)"
cc_assert_cmux_count "close-workspace --workspace ws-v2-k2" 1 "C7) the non-kept sid was still swept exactly once"
cc_has "cleaned: 1 unused sessions" "C7) only the non-kept sid is counted" "$CC_EVID/c7-keep-substring.out"
cc_assert_no_kills "C7) kill tripwire stayed empty"

echo "# ---- D) worker refusal under the batch modes ----"

# D1..D6) AIGENTRY_WORKER_SESSION must refuse fail-fast with exit 4 BEFORE any
# kill or close, on both batch modes. The tripwire proves no mass-kill happened.
v2_reset d1
v2_list $V2_B_ALL
v2_fail_ws
rc=$(v2_run_worker d1-worker-disc --all-disconnected)
cc_expect_exit "$rc" 4 "D1) worker session refuses --all-disconnected with exit 4 (unchanged)"
cc_assert_cmux_count "close-workspace" 0 "D2) worker refusal: no close was attempted"
cc_assert_no_kills "D3) worker refusal: kill tripwire stayed empty (no mass-kill)"

v2_reset d2
v2_list $V2_C_ALL
v2_fail_ws
rc=$(v2_run_worker d2-worker-unused --all-unused)
cc_expect_exit "$rc" 4 "D4) worker session refuses --all-unused with exit 4 (unchanged)"
cc_assert_cmux_count "close-workspace" 0 "D5) worker refusal: no close was attempted"
cc_assert_no_kills "D6) worker refusal: kill tripwire stayed empty (no mass-kill)"

cc_summary T161
cc_exit T161
