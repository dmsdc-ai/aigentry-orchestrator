#!/usr/bin/env bash
# T162 — #1162 orphan-arm close-status contract (the G1 boundary, now closed).
#
# Ported into the repository suite from the cp1162ah validation tree's
# ORPHAN-REPRO.sh (authored cr1162ab). 43 assertions, one-to-one: the ORACLES
# are unchanged, only the harness moved. The relocation is identical in kind to
# T160's and T161's. Two things belong to this file specifically: it is the
# guard that keeps the ORPHAN arm measured, and its runner for control G is
# local because cc_run_cleanup unconditionally unsets AIGENTRY_WORKER_SESSION.
#
# WHY THIS GUARD EXISTS AT ALL. T161's header recorded G1 as a KNOWN BOUNDARY,
# reported not fixed: on the telepty-orphan arm the close status was discarded —
# exit 0, no UNCONFIRMED, registryCleaned(sid) called unconditionally. That
# boundary has since been measured and corrected, and this file is the standing
# regression that keeps the correction honest. Without it the orphan arm is
# covered by nothing in T*.sh: the original reproducer was NOT selected by
# run-all.sh's glob, so the fix would have shipped with no guard watching it.
#
# WHAT G1 CLAIMED, AND WHY IT WAS NOT YET PROOF.
# ct1162z measured, on the telepty-orphan arm with a cmux host that REFUSED EVERY
# VERB: CLI exit 0, no UNCONFIRMED on either stream, and registryCleaned(sid)
# called unconditionally (cli.ts:589). It reported this as a bounded gap, not a
# defect. That reservation is correct and this suite exists to resolve it:
#
#   wh_close_for_sid() {                       # workspace-host.sh:1105
#     host_id=$(wh_lookup "$sid" "$info")
#     [ -z "$host_id" ] && return 0            # <-- NO CLOSE WAS ATTEMPTED
#     wh_close "$host_id"                      # <-- close status propagates
#   }
#
# When every verb refuses, `cmux --json list-workspaces` also refuses, so
# _wh_cmux_lookup's orphan fallback (workspace-host.sh:98, the #523 title match)
# yields EMPTY and close_for_sid returns 0 at the guard line. Exit 0 is then the
# DOCUMENTED contract ("no host id mapped ... no close was attempted", cli.ts:352),
# not a discarded failure. The refuse-everything fixture cannot tell the two apart.
#
# WHAT THIS SUITE DOES. It drives the orphan arm with a mapping that is GENUINELY
# DISCOVERABLE — cmux answers list-workspaces with a workspace whose title IS the
# sid and whose current_directory is under the owned role-sandbox root — while the
# CLOSE itself fails and the re-probe is unanswerable (INDETERMINATE -> PRESENT).
# Now lookup succeeds, close is genuinely attempted, and wh_close_for_sid genuinely
# returns non-zero. Whatever the CLI then does is a statement about the CLI, not
# about the fixture.
#
# EVIDENCE vs CONTRACT. Assertions are split on purpose:
#   [E] EVIDENCE  — must pass, or the reproduction is not established. These prove
#                   from CAPTURED ARGV that lookup resolved and that close ran, and
#                   they measure the adapter layer's own exit independently of the
#                   CLI via `wh-cli.sh close-for-sid`.
#   [C] CONTRACT  — the desired #1162 behaviour for a CONFIRMED non-zero close:
#                   non-zero CLI exit and NO `cleaned` mark, while the existing
#                   registry DELETE still proceeds. On the PRE-FIX emission these
#                   four FAIL and that failure IS the reproduction; on the shipped
#                   emission they are the regression this guard maintains. They are
#                   NOT relabelled in either direction to make the suite green.
#
# CONTROLS (each one is a different reason for exit 0; none may be confused with A):
#   B unmapped .......... a workspace exists but no title matches -> no close attempted
#   C transport failure . every cmux verb refuses (the ct1162z G1 fixture) -> no attempt
#   D healthy close ..... close succeeds -> exit 0 AND the `cleaned` mark IS written.
#                         This is the POSITIVE COUNT SIGNAL: it proves the registry
#                         fake records, so "no cleaned mark" elsewhere is a measured
#                         absence and not the vacuous no-op of a missing script.
#   E genuine known-gone  close fails but the probe gives cmux's exact missing-handle
#                         answer -> adapter legitimately reports success
#   F protected sid ..... Rule 28 refusal, exit 1, no close attempted
#   G worker refusal .... AIGENTRY_WORKER_SESSION=1, exit 4, no close attempted
#
# SCOPE. This is the GENUINE CHECKOUT CALLER PATH: the real bin/session-cleanup.sh
# shim onto the real dist/src/cleanup/cli.js, through the real bin/wh-cli.sh and the
# real bin/lib/workspace-host.sh. It is NOT the doubled-wh-cli.sh parser seam that
# R5 / T160 group C drive, so nothing here is parser-only evidence.
#
# NO DIST IS A HARD FAILURE, NEVER A SKIP. Like T160 and T161, this guard measures
# the compiled cleanup CLI through its bin/ shim, so cleanup-close-lib.sh's build
# gate exits 2 with a single MISSING BUILD diagnostic in a fresh worktree. It does
# NOT announce a skip and MUST NOT be added to run-all.sh's EXPECTED_SKIPS_*: a
# skip here is how this guard's whole subject would silently stop being measured.
#
# Missing-mapping semantics and DELETE-status semantics remain separately OPEN and
# are NOT redesigned here. No product file is edited or copied over. Fakes only:
# cmux, telepty, curl, ps, kill (tripwire) and a logging registry fake. Synthetic
# sids only. No network, no real cmux/telepty, no process scan, no global signal.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/cleanup-close-lib.sh"

cc_setup T162
trap cc_teardown EXIT
cc_selfcheck

SID_A="sid-repro-orphan-mapped"
SID_B="sid-repro-orphan-unmapped"
SID_C="sid-repro-orphan-transport"
SID_D="sid-repro-orphan-healthy"
SID_E="sid-repro-orphan-gone"
SID_F="sid-repro-protected-fixture"   # == ORCHESTRATOR_SID set by cc_run_cleanup
SID_G="sid-repro-orphan-worker"
HOST_A="workspace:7"
SECRET="SYNTHETIC_TOKEN_DO_NOT_ECHO=sk-fixture-0000"
CAT_RE="(host-unreachable|host-timeout|close-refused|no-output|unknown-failure)"
POS_RE="(nothing was released|nothing released|wh_close_status=unreleased|already closed\?|surface retained|still retained)"

# ── test-owned seams ─────────────────────────────────────────────────────────
# 1) The registry fake. cc_setup points DISPATCH_REGISTRY_PY at a nonexistent path,
#    which makes registryCleaned a SILENT NO-OP — "no cleaned mark" would then be
#    vacuously true for every case. On POSIX registryInvocation executes the script
#    directly (registry-command.ts:7), so an executable logger is the exact seam.
export OR_REGISTRY_CALLS="$T_TMP/registry-calls.log"
: > "$OR_REGISTRY_CALLS"
export DISPATCH_REGISTRY_PY="$T_TMP/registry-fake"
{
  printf '%s\n' '#!/usr/bin/env bash' \
    "printf '%s\\n' \"\$*\" >> \"$OR_REGISTRY_CALLS\"" 'exit 0'
} > "$DISPATCH_REGISTRY_PY"
chmod +x "$DISPATCH_REGISTRY_PY"
[ -x "$DISPATCH_REGISTRY_PY" ] || { echo "registry fake not executable" >&2; exit 2; }
"$DISPATCH_REGISTRY_PY" __selfcheck >/dev/null 2>&1
grep -q '__selfcheck' "$OR_REGISTRY_CALLS" || {
  echo "the registry fake did not record its invocation — an absence claim would be vacuous" >&2; exit 2; }
: > "$OR_REGISTRY_CALLS"
echo "# registry fake: executable, invocation logging verified"

# 2) The scenario-driven cmux fake. One fake, four verbs, behaviour selected by
#    exported variables so each scenario changes DATA, never the fake's code.
export OR_WS_JSON="$T_TMP/workspaces.json"
printf '%s' '{"workspaces":[]}' > "$OR_WS_JSON"
export OR_LIST_RC=0 OR_CLOSE_RC=0 OR_PROBE_RC=0 OR_PROBE_OUT="state: active"
cc_fake_cmux <<'ARMS'
  --json)
    # `cmux --json list-workspaces` — the orphan lookup fallback's only source.
    if [ "${OR_LIST_RC:-0}" != "0" ]; then
      printf 'Error: ERROR: connection refused\n' >&2
      exit "${OR_LIST_RC}"
    fi
    cat "$OR_WS_JSON"
    exit 0;;
  close-workspace)
    if [ "${OR_CLOSE_RC:-0}" != "0" ]; then
      printf '%s\n' "${OR_CLOSE_ERR:-cmux: close-workspace failed}" >&2
      exit "${OR_CLOSE_RC}"
    fi
    exit 0;;
  sidebar-state)
    if [ "${OR_PROBE_RC:-0}" != "0" ]; then
      printf '%s\n' "${OR_PROBE_OUT}" >&2
      exit "${OR_PROBE_RC}"
    fi
    printf '%s\n' "${OR_PROBE_OUT}"
    exit 0;;
ARMS

# 3) A worker-session runner. cc_run_cleanup deliberately scrubs
#    AIGENTRY_WORKER_SESSION; control G needs it SET, so it gets its own runner
#    rather than a change to the shared lib.
or_run_cleanup_worker() {
  local name="$1"; shift
  env AIGENTRY_WORKER_SESSION=1 \
      AIGENTRY_WORKSPACE_HOST=cmux \
      PATH="$PATH" HOME="$HOME" \
      TELEPTY="$TELEPTY" CURL="$CURL" \
      CLEANUP_PS_CMD="$CLEANUP_PS_CMD" KILL_CMD="$KILL_CMD" \
      DISPATCH_REGISTRY_PY="$DISPATCH_REGISTRY_PY" \
      ORCHESTRATOR_SID="$SID_F" \
      "$CC_BASH_BIN" "$CC_CLEANUP_SH" "$@" >"$CC_EVID/$name.out" 2>"$CC_EVID/$name.err" &
  cc_wait_child "$!" "$name"
}

# ── scenario installer ───────────────────────────────────────────────────────
# or_scenario <label> <title-owned-by> <list_rc> <close_rc> <probe_rc> <probe_out>
# The telepty list is seeded with a DECOY row: it must be NON-EMPTY (an empty array
# sends the CLI down the #835 corroborated-listing refusal, which is a different
# code path and would silently replace the measurement) while never containing the
# sid under test, which is what puts cleanupOne on the orphan arm.
or_scenario() {
  local label="$1" title="$2" lrc="$3" crc="$4" prc="$5" pout="$6"
  printf '%s' '[{"id":"sid-repro-decoy","command":"claude","healthStatus":"CONNECTED","cmuxWorkspaceId":"workspace:99"}]' \
    > "$FAKE_LIST_FILE"
  if [ -n "$title" ]; then
    # current_directory under the owned role-sandbox root: a genuinely owned,
    # genuinely discoverable mapping, not a bare string match.
    printf '{"workspaces":[{"ref":"%s","title":"%s","current_directory":"%s/%s"}]}' \
      "$HOST_A" "$title" "$AIGENTRY_ROLE_SANDBOX_DIR" "$title" > "$OR_WS_JSON"
  else
    printf '%s' '{"workspaces":[]}' > "$OR_WS_JSON"
  fi
  export OR_LIST_RC="$lrc" OR_CLOSE_RC="$crc" OR_PROBE_RC="$prc" OR_PROBE_OUT="$pout"
  export OR_CLOSE_ERR="cmux: close-workspace refused by daemon ($SECRET)"
  cc_reset_logs "$label"
  : > "$OR_REGISTRY_CALLS"
}

or_registry_has() { local n="$1" d="$2"
  if grep -qF -- "$n" "$OR_REGISTRY_CALLS" 2>/dev/null; then cc_ok "$d"
  else cc_not_ok "$d" "not found in registry calls: $n
$(cat "$OR_REGISTRY_CALLS" 2>/dev/null)"; fi; }

or_registry_none() { local n="$1" d="$2"
  if grep -qF -- "$n" "$OR_REGISTRY_CALLS" 2>/dev/null; then
    cc_not_ok "$d" "PRESENT in registry calls: $n
$(cat "$OR_REGISTRY_CALLS" 2>/dev/null)"
  else cc_ok "$d"; fi; }

or_keep_registry() { cp "$OR_REGISTRY_CALLS" "$CC_EVID/calls/$1.registry.log" 2>/dev/null || true; }

echo "# ─── D: healthy close (POSITIVE CONTROL — run first, it licenses every absence claim below)"
or_scenario D "$SID_D" 0 0 0 "state: active"
d_wh=$(cc_run_wh "D-wh-close-for-sid" close-for-sid "$SID_D")
or_scenario D "$SID_D" 0 0 0 "state: active"
d_rc=$(cc_run_cleanup "D-cleanup" "$SID_D"); or_keep_registry "D-cleanup"
cc_expect_exit "$d_wh" 0 "[E] D adapter: close-for-sid exits 0 when the close succeeds"
cc_assert_cmux_count "close-workspace --workspace $HOST_A" 1 "[E] D: the mapped workspace was closed exactly once"
cc_expect_exit "$d_rc" 0 "[E] D CLI: a healthy orphan close exits 0"
or_registry_has "set-lifecycle --sid $SID_D --state cleaned" \
  "[E] D POSITIVE SIGNAL: the registry fake DOES record the cleaned mark on success"
or_registry_has "observe --sid $SID_D" "[E] D: the registry observe call was recorded too"
cc_assert_no_kills "[E] D: kill tripwire empty"

echo "# ─── A: orphan + discoverable owned mapping + NON-ZERO close + unanswerable re-probe"
# The probe output is deliberately NOT cmux's exact missing-handle answer, so
# _wh_cmux_alive stays INDETERMINATE->PRESENT and the close verdict is a real failure.
or_scenario A "$SID_A" 0 3 1 "Error: ERROR: connection refused"
a_wh=$(cc_run_wh "A-wh-close-for-sid" close-for-sid "$SID_A")
a_lookup=$(cc_run_wh "A-wh-lookup" lookup "$SID_A")
cc_expect_exit "$a_wh" 1 \
  "[E] A adapter: close-for-sid exits NON-ZERO — a close was attempted and observed to fail"
cc_has "$HOST_A" "[E] A adapter: lookup resolved the orphan sid to its owned host id" \
  "$CC_EVID/A-wh-lookup.out"

or_scenario A "$SID_A" 0 3 1 "Error: ERROR: connection refused"
a_rc=$(cc_run_cleanup "A-cleanup" "$SID_A"); or_keep_registry "A-cleanup"

# -- EVIDENCE: the reproduction is real, read off captured argv --
cc_has "list-workspaces" "[E] A: the orphan lookup fallback actually queried cmux" "$CMUX_CALLS"
cc_assert_cmux_count "close-workspace --workspace $HOST_A" 1 \
  "[E] A: close WAS invoked on the resolved host id, exactly once (NOT a skipped close)"
cc_assert_cmux_count "sidebar-state --workspace $HOST_A" 1 \
  "[E] A: the alive re-probe ran exactly once (no new retry loop)"
cc_has "session not in telepty list: $SID_A" "[E] A: cleanupOne took the telepty-orphan arm" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"
cc_assert_no_kills "[E] A: kill tripwire empty"

# -- CONTRACT: the four oracles the #1162 correction turns green. A failure here is
#    a REGRESSION of the shipped fix (and, on a pre-fix emission, the reproduction). --
cc_expect_exit "$a_rc" 1 \
  "[C] A: a CONFIRMED non-zero orphan close must reach the CLI exit status" \
  "$(printf 'adapter close-for-sid exit=%s (non-zero, close attempted+failed)\n--- cmux argv ---\n%s\n--- cli stdout ---\n%s\n--- cli stderr ---\n%s' \
      "$a_wh" "$(cat "$CMUX_CALLS")" "$(cat "$CC_EVID/A-cleanup.out")" "$(cat "$CC_EVID/A-cleanup.err")")"
or_registry_none "set-lifecycle --sid $SID_A --state cleaned" \
  "[C] A: no 'cleaned' mark may be written for a close that was never observed to succeed"
cc_has_re "UNCONFIRMED" "[C] A: the failed close is surfaced as UNCONFIRMED on some stream" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"
cc_has_re "$CAT_RE" "[C] A: a closed-vocabulary failure category is reported" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"

# -- bounding the fix: the teardown must NOT be shortened --
cc_has "DELETE" "[E] A: the existing registry DELETE still ran (no rollback, no short-circuit)" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"
cc_none "workspace host closed: $SID_A" "[E] A: no false 'workspace host closed' claim" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"
cc_none "$SECRET" "[E] A: the raw fixture secret never reaches either stream" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"
cc_none_re_i "$POS_RE" "[E] A: no positive retention/release claim on either stream" \
  "$CC_EVID/A-cleanup.out" "$CC_EVID/A-cleanup.err"

echo "# ─── B: unmapped orphan — a workspace exists, no title matches, NO close attempted"
or_scenario B "$SID_B-some-other-title" 0 3 1 "Error: ERROR: connection refused"
b_wh=$(cc_run_wh "B-wh-close-for-sid" close-for-sid "$SID_B")
or_scenario B "$SID_B-some-other-title" 0 3 1 "Error: ERROR: connection refused"
b_rc=$(cc_run_cleanup "B-cleanup" "$SID_B"); or_keep_registry "B-cleanup"
cc_expect_exit "$b_wh" 0 "[E] B adapter: close-for-sid exits 0 — the guard returned before any close"
cc_assert_cmux_count "close-workspace" 0 \
  "[E] B: NO close was attempted (this is why exit 0 here is the documented contract, not a discarded failure)"
cc_expect_exit "$b_rc" 0 "[E] B CLI: exit 0 with no close attempted is CORRECT, not the defect"
cc_assert_no_kills "[E] B: kill tripwire empty"

echo "# ─── C: lookup transport failure — the ct1162z G1 fixture. Every cmux verb refuses."
or_scenario C "$SID_C" 1 3 1 "Error: ERROR: connection refused"
c_wh=$(cc_run_wh "C-wh-close-for-sid" close-for-sid "$SID_C")
or_scenario C "$SID_C" 1 3 1 "Error: ERROR: connection refused"
c_rc=$(cc_run_cleanup "C-cleanup" "$SID_C"); or_keep_registry "C-cleanup"
cc_expect_exit "$c_wh" 0 "[E] C adapter: close-for-sid exits 0 when the LOOKUP itself could not answer"
cc_assert_cmux_count "close-workspace" 0 \
  "[E] C: NO close was attempted — the refuse-everything fixture cannot evidence a discarded close status"
cc_expect_exit "$c_rc" 0 "[E] C CLI: exit 0 here is the no-mapping contract, NOT proof of the G1 defect"
cc_assert_no_kills "[E] C: kill tripwire empty"

echo "# ─── E: genuine known-gone — close fails, but cmux gives its exact missing-handle answer"
or_scenario E "$SID_E" 0 3 1 "Error: ERROR: Tab not found"
e_wh=$(cc_run_wh "E-wh-close-for-sid" close-for-sid "$SID_E")
or_scenario E "$SID_E" 0 3 1 "Error: ERROR: Tab not found"
e_rc=$(cc_run_cleanup "E-cleanup" "$SID_E"); or_keep_registry "E-cleanup"
cc_expect_exit "$e_wh" 0 \
  "[E] E adapter: a failed close whose re-probe ANSWERS 'gone' is legitimately a success"
cc_assert_cmux_count "close-workspace --workspace $HOST_A" 1 "[E] E: the close was attempted"
cc_assert_cmux_count "sidebar-state --workspace $HOST_A" 1 "[E] E: the re-probe answered"
cc_expect_exit "$e_rc" 0 "[E] E CLI: exit 0 is correct for a genuinely-gone surface"
or_registry_has "set-lifecycle --sid $SID_E --state cleaned" \
  "[E] E: the cleaned mark IS legitimate when the surface is proven gone"
cc_assert_no_kills "[E] E: kill tripwire empty"

echo "# ─── F: Rule 28 protected sid — refusal, no close attempted"
or_scenario F "$SID_F" 0 3 1 "Error: ERROR: connection refused"
f_rc=$(cc_run_cleanup "F-cleanup" "$SID_F"); or_keep_registry "F-cleanup"
cc_expect_exit "$f_rc" 1 "[E] F: the protected sid is still refused with exit 1"
cc_assert_cmux_count "close-workspace" 0 "[E] F: no close attempted on the protected sid"
or_registry_none "set-lifecycle --sid $SID_F --state cleaned" "[E] F: no cleaned mark on a refusal"
cc_assert_no_kills "[E] F: kill tripwire empty"

echo "# ─── G: worker-session refusal — the corrected exit status must not open a cleanup path"
or_scenario G "$SID_G" 0 3 1 "Error: ERROR: connection refused"
g_rc=$(or_run_cleanup_worker "G-cleanup" "$SID_G"); or_keep_registry "G-cleanup"
cc_expect_exit "$g_rc" 4 "[E] G: a worker session is refused with exit 4"
cc_assert_cmux_count "close-workspace" 0 "[E] G: no close attempted from a worker session"
or_registry_none "set-lifecycle --sid $SID_G --state cleaned" "[E] G: no cleaned mark from a worker session"
cc_assert_no_kills "[E] G: kill tripwire empty"

cc_plan "$CC_TESTS"
cc_summary T162
cc_exit T162
