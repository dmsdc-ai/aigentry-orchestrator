#!/usr/bin/env bash
# T160 — #1162 cleanup close-failure EVIDENCE contract.
#
# Ported into the repository suite from the cl1162o validation tree's
# M1_maintained_oracles.sh (authored ct1162w, re-measured ct1162z). 122
# assertions, one-to-one: the ORACLES are unchanged, only the harness moved.
# What moved, exhaustively:
#   * `. rlib.sh` → `. cleanup-close-lib.sh`, which reuses lib.sh's t_setup
#     posture instead of reproducing it. The five fakes, the fixture-sid
#     convention and the kill tripwire are identical.
#   * the code under test is the CURRENT CHECKOUT's bin/ + dist/ rather than a
#     mode-preserving copy of a frozen input tree.
#   * `r_expect_exit ... hold` lost its trailing kind argument: the `repro` kind
#     belonged to the reproduction suites (R1..R5), which are NOT ported, and
#     every call here passed `hold`. Same comparison, same description.
#   * group C's doubled tree copies bin/ and SYMLINKS dist/ instead of copying
#     the whole source root — a repo checkout is too large to duplicate per run.
#     bin/ must be a real copy (the shim resolves its own dir with `pwd -P`, so a
#     symlinked bin/ would resolve back to the real one and the doubled wh-cli.sh
#     would never be reached); dist/ is only ever read through a path string, so
#     a symlink is exact.
#   * the ancestor ended in `exit 0` — a suite with failing assertions still
#     reported shell exit 0. NOT preserved: this file ends in cc_exit.
#
# THE CONTRACT. A close that failed must be surfaced as a FAILURE that is
# UNCONFIRMED, with a closed-vocabulary category and NO positive state claim.
#  * OLD oracle: the raw adapter text ("workspace host close non-zero") had to
#    appear on STDOUT. NEW: the warning may live on EITHER stream and may be a
#    GENERATED bounded category, because #1162 containment forbids relaying
#    adapter stderr (pane text, credentials, control bytes) — an oracle
#    demanding the raw refused/connect wording contradicts the requirement under
#    test. What must hold: a failure IS surfaced, it is UNCONFIRMED, and its
#    category is closed-vocabulary.
#  * OLD oracles "nothing was released" (stdout) and "wh_close_status=unreleased"
#    (adapter stderr) are POSITIVE state claims and are forbidden. A failed close
#    plus a conservative alive guard proves neither retention nor the absence of
#    a partial release — the guard is an actuation guard, not an observation.
#  * N10a/N10b measure BOTH readings of "non-zero on both layers": (A) the CLI
#    SURFACES the close as non-zero on some stream; (B) the CLI PROCESS exit code
#    is non-zero. Neither is silently chosen; both are measured and reported.
#    T161 carries the controller's selected reading (B) across the batch modes.
#
# SCOPE, stated so a pass is not over-read: group C drives the SAME doubled
# wh-cli.sh seam R5 documented. It measures the CLI PARSER, not production
# reachability — in the current tree both _wh_warp_close and _wh_headless_close
# return 0, so the non-zero token branch is cmux-only.
#
# NO PRODUCT EDITS. Synthetic sids only, kill tripwire armed, no network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
. "$HERE/cleanup-close-lib.sh"

cc_setup T160
trap cc_teardown EXIT
cc_selfcheck

SECRET="SYNTHETIC_TOKEN_DO_NOT_ECHO=sk-fixture-0000"
CLOSED_LINE="workspace host closed"
CAT_RE="(host-unreachable|host-timeout|close-refused|no-output|unknown-failure)"
POS_RE="(nothing was released|nothing released|wh_close_status=unreleased|already closed\?|surface retained|still retained)"

echo "# T160 - #1162 close-failure evidence oracles (groups N/F8, doubled-seam group C)"
echo "# arm cli.js:          $(shasum -a 256 "$CC_REPO_ROOT/dist/src/cleanup/cli.js" | awk "{print \$1}")"
echo "# arm workspace-host:  $(shasum -a 256 "$CC_REPO_ROOT/bin/lib/workspace-host.sh" | awk "{print \$1}")"

# -- N) REQUIRED OUTCOME: failed close, nothing proven gone (INTEGRATED) -------
cc_reset_logs n-adapter
cc_list_one sid-m1-n ws-m1-n
cc_fake_cmux <<"ARMS"
  close-workspace) echo "Error: failed to connect to cmux daemon at 127.0.0.1:3848: Connection refused (os error 61)" >&2; exit 1;;
  sidebar-state)   echo "Error: failed to connect to cmux daemon at 127.0.0.1:3848: Connection refused (os error 61)" >&2; exit 1;;
  list-workspaces) echo "Error: failed to connect to cmux daemon at 127.0.0.1:3848: Connection refused (os error 61)" >&2; exit 1;;
ARMS
rc=$(cc_run_wh n-adapter close ws-m1-n)
cc_expect_exit "$rc" 1 "N1) ADAPTER: failed close without proven gone -> nonzero"
cc_has "wh_close_status=unconfirmed" "N2) ADAPTER states UNCONFIRMED (machine token)" "$CC_EVID/n-adapter.err"
cc_has_re "wh_close_category=$CAT_RE" "N3) ADAPTER states a CLOSED-vocabulary category" "$CC_EVID/n-adapter.err"
cc_none_re_i "$POS_RE" "N4) ADAPTER makes no positive retained/unreleased claim" "$CC_EVID/n-adapter.err" "$CC_EVID/n-adapter.out"
cc_assert_cmux_count "close-workspace --workspace ws-m1-n" 1 "N5) ADAPTER issued exactly one close-workspace (no retry storm)"

cc_reset_logs n-cli
rc=$(cc_run_cleanup n-cli sid-m1-n)
N_CLI_EXIT="$rc"
cc_has "UNCONFIRMED" "N6) CLI reports the release as UNCONFIRMED" "$CC_EVID/n-cli.out" "$CC_EVID/n-cli.err"
cc_has_re "\[$CAT_RE\]" "N7) CLI carries a bounded CLOSED-vocabulary category" "$CC_EVID/n-cli.out" "$CC_EVID/n-cli.err"
cc_none "$CLOSED_LINE" "N8) CLI makes no workspace-host-closed claim" "$CC_EVID/n-cli.out" "$CC_EVID/n-cli.err"
cc_none_re_i "$POS_RE" "N9) CLI makes no positive retained/present/unreleased/nothing-released claim" "$CC_EVID/n-cli.out" "$CC_EVID/n-cli.err"
cc_has_re "close (non-zero|failed)" "N10a) CLI surfaces the close failure on SOME stream (reading A of nonzero)" "$CC_EVID/n-cli.out" "$CC_EVID/n-cli.err"
cc_expect_exit "$N_CLI_EXIT" 1 "N10b) CLI PROCESS exit is nonzero (reading B of nonzero-on-both-layers)"
cc_none "$SECRET" "N11) CLI relays no adapter payload" "$CC_EVID/n-cli.out" "$CC_EVID/n-cli.err"
cc_assert_cmux_count "close-workspace --workspace ws-m1-n" 1 "N12) CLI issued exactly one close-workspace"

# -- F8) MALFORMED *SUCCESSFUL* PROBE CANNOT PROMOTE THE OUTCOME --------------
f8_case() {
  local tag="$1" label="$2"; shift 2
  cc_reset_logs "$tag"
  cc_list_one "sid-m1-$tag" "ws-m1-$tag"
  cc_fake_cmux
  local rc
  rc=$(cc_run_wh "$tag-adapter" close "ws-m1-$tag")
  cc_expect_exit "$rc" 1 "F8/$label) ADAPTER close stays nonzero (successful-but-unreadable probe is not an absence)"
  cc_none_re_i "$POS_RE" "F8/$label) ADAPTER makes no positive claim" "$CC_EVID/$tag-adapter.err" "$CC_EVID/$tag-adapter.out"
  rc=$(cc_run_cleanup "$tag-cli" "sid-m1-$tag")
  cc_none "$CLOSED_LINE" "F8/$label) CLI makes no closed claim" "$CC_EVID/$tag-cli.out" "$CC_EVID/$tag-cli.err"
  cc_has "UNCONFIRMED" "F8/$label) CLI reports UNCONFIRMED" "$CC_EVID/$tag-cli.out" "$CC_EVID/$tag-cli.err"
  cc_none_re_i "$POS_RE" "F8/$label) CLI makes no positive claim" "$CC_EVID/$tag-cli.out" "$CC_EVID/$tag-cli.err"
  return 0
}

f8_case f8a "garbage-exit0" <<"ARMS"
  close-workspace) echo "Error: close failed" >&2; exit 1;;
  sidebar-state)   printf "\001\002 not-json <<<garbage>>>\n"; exit 0;;
ARMS
f8_case f8b "whitespace-exit0" <<"ARMS"
  close-workspace) echo "Error: close failed" >&2; exit 1;;
  sidebar-state)   printf "   \n\t\n"; exit 0;;
ARMS
f8_case f8c "answerline-trailing-garbage-exit0" <<"ARMS"
  close-workspace) echo "Error: close failed" >&2; exit 1;;
  sidebar-state)   echo "Error: ERROR: Tab not found EXTRA-TRAILING-GARBAGE"; exit 0;;
ARMS
f8_case f8d "answerline-prefixed-exit0" <<"ARMS"
  close-workspace) echo "Error: close failed" >&2; exit 1;;
  sidebar-state)   echo "PREFIX Error: ERROR: Tab not found"; exit 0;;
ARMS

# -- C) CATEGORY/STATUS TOKEN BOUNDARIES (DOUBLED wh-cli.sh - PARSER ONLY) -----
# bin/ is a REAL copy: bin/session-cleanup.sh resolves its own directory with
# `pwd -P`, so a symlinked bin/ would resolve back to the checkout's and the
# doubled wh-cli.sh would never be reached. dist/ is only ever read through a
# path string built from that directory, so a symlink is exact and keeps the
# per-run cost of duplicating a built checkout off the table.
DBL="$T_TMP/doubled-tree"
mkdir -p "$DBL"
cp -Rp "$CC_REPO_ROOT/bin" "$DBL/bin"
ln -s "$CC_REPO_ROOT/dist" "$DBL/dist"
DBL_SHIM="$DBL/bin/session-cleanup.sh"
DBL_WH="$DBL/bin/wh-cli.sh"
cp -p "$DBL_WH" "$DBL/bin/wh-cli.real.sh"
export M1_STDERR_FILE="$T_TMP/m1-adapter-stderr.txt"
: > "$M1_STDERR_FILE"
{
  printf "%s\n" "#!/usr/bin/env bash" \
    "if [ \"\${1:-}\" = \"close\" ]; then" \
    "  cat \"\$M1_STDERR_FILE\" >&2" \
    "  exit 1" \
    "fi" \
    "exec bash \"\$(dirname \"\${BASH_SOURCE[0]}\")/wh-cli.real.sh\" \"\$@\""
} > "$DBL_WH"
chmod +x "$DBL_WH"
echo "# C group: doubled wh-cli.sh seam; the compiled cli.js is the checkout's own, byte-identical"

m1_run() {
  local name="$1" sid="$2"
  env -u AIGENTRY_WORKER_SESSION AIGENTRY_WORKSPACE_HOST=cmux \
      PATH="$PATH" HOME="$HOME" TELEPTY="$TELEPTY" CURL="$CURL" \
      CLEANUP_PS_CMD="$CLEANUP_PS_CMD" KILL_CMD="$KILL_CMD" \
      DISPATCH_REGISTRY_PY="$DISPATCH_REGISTRY_PY" \
      M1_STDERR_FILE="$M1_STDERR_FILE" \
      ORCHESTRATOR_SID="sid-repro-protected-fixture" \
      "$CC_BASH_BIN" "$DBL_SHIM" "$sid" >"$CC_EVID/$name.out" 2>"$CC_EVID/$name.err" &
  cc_wait_child "$!" "$name"
}

m1_case() {
  local tag="$1" expect="$2" label="$3" payload="$4" leak="${5:-}"
  cc_reset_logs "$tag"
  cc_list_one "sid-m1-$tag" "ws-m1-$tag"
  printf "%b\n" "$payload" > "$M1_STDERR_FILE"
  m1_run "$tag" "sid-m1-$tag" >/dev/null
  cc_has "UNCONFIRMED" "C/$label) reports UNCONFIRMED" "$CC_EVID/$tag.out"
  cc_has_re "\[$CAT_RE\]" "C/$label) reported category is in the CLOSED vocabulary" "$CC_EVID/$tag.out"
  cc_none_re_i "$POS_RE" "C/$label) no positive retained/unreleased claim" "$CC_EVID/$tag.out" "$CC_EVID/$tag.err"
  cc_none "$CLOSED_LINE" "C/$label) no closed claim" "$CC_EVID/$tag.out" "$CC_EVID/$tag.err"
  if [ -n "$leak" ]; then
    cc_none "$leak" "C/$label) the raw token/payload never reaches the log" "$CC_EVID/$tag.out" "$CC_EVID/$tag.err"
  fi
  if [ "$expect" = "OBSERVE" ]; then
    printf "# C/%s) OBSERVED category = %s (recorded, no assertion)\n" \
      "$label" "$(grep -oE "\[$CAT_RE\]" "$CC_EVID/$tag.out" | head -1)"
  else
    cc_has "[$expect]" "C/$label) category reads as [$expect]" "$CC_EVID/$tag.out"
  fi
  return 0
}

m1_case c01 close-refused   "exact-complete-token"       "wh_close_status=unconfirmed wh_close_category=close-refused"
m1_case c02 unknown-failure "suffix-letters"             "wh_close_category=close-refusedXYZ" "close-refusedXYZ"
m1_case c03 unknown-failure "suffix-digits"              "wh_close_category=close-refused123" "close-refused123"
m1_case c04 unknown-failure "suffix-underscore"          "wh_close_category=close-refused_x" "close-refused_x"
m1_case c05 unknown-failure "suffix-hyphen"              "wh_close_category=close-refused-x" "close-refused-x"
m1_case c06 OBSERVE         "suffix-punct-dot"           "wh_close_category=close-refused."
m1_case c07 OBSERVE         "suffix-punct-paren"         "wh_close_category=close-refused)"
m1_case c08 OBSERVE         "prefixed-key-letter"        "Xwh_close_category=close-refused"
m1_case c09 OBSERVE         "prefixed-key-underscore"    "my_wh_close_category=host-timeout"
m1_case c10 unknown-failure "empty-value"                "wh_close_category="
m1_case c11 host-timeout    "empty-plus-valid"           "wh_close_category=\nwh_close_category=host-timeout"
m1_case c12 unknown-failure "two-conflicting-categories" "wh_close_category=host-timeout\nwh_close_category=close-refused"
m1_case c13 host-timeout    "two-identical-categories"   "wh_close_category=host-timeout\nwh_close_category=host-timeout"
m1_case c14 unknown-failure "out-of-vocabulary"          "wh_close_category=totally-made-up" "totally-made-up"
m1_case c15 close-refused   "F9-status-suffixed"         "wh_close_status=unreleasedXYZ wh_close_category=close-refused" "unreleasedXYZ"
m1_case c16 close-refused   "F9-status-exact-unreleased" "wh_close_status=unreleased wh_close_category=close-refused"
m1_case c17 close-refused   "secret-control-valid-token" "\033[2J\007$SECRET pane: export API_KEY=x\nwh_close_category=close-refused" "$SECRET"

cc_assert_no_kills "T160: kill tripwire stayed empty (no process signalled by any oracle)"
cc_archive_logs
cc_summary T160
cc_exit T160
