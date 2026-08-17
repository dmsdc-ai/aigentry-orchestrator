#!/usr/bin/env bash
# T129 (#899 tranche 5) — the report-target resolver's contract lines no guard pinned.
#
# TWO guards name bin/orchestrator-report-target.sh today and both are worth keeping
# exactly as they are. T67 asserts WHICH address is chosen (#690 / Rule 16: never the
# phantom `aigentry-orchestrator-claude`) and that dispatch.sh fails closed when the
# resolve fails. T92 asserts that reachability is MEASURED and not inferred (#835): an
# answering address gives the `<sid>@<ip>` form, a silent one falls back to the bare
# sid with a reason, an explicit host is honoured loudly, cannot-probe is not
# unreachable, no candidate means no probe, any HTTP code counts, and stdout is one
# clean line.
#
# What NEITHER pins, and a port could therefore drop in silence:
#   * the curl argv AS ARGV. T92's stub appends `"$*"` to a log and then only ever
#     COUNTS that log's lines, so every flag, both timeouts and the `/api/meta` path
#     are free to change unnoticed — and a host that word-split into two arguments
#     would still count as one probe;
#   * that exactly ONE probe is issued, never a retry. T92 asserts `>= 1` and `== 0`,
#     never `== 1`, and "one probe with a 1s connect ceiling and no retry" is the
#     resolver's stated cost contract — this runs on EVERY dispatch;
#   * the default sid `orchestrator`. Both guards override it in every single case;
#   * that TELEPTY_PORT is honoured in the probe URL AND inside both note texts;
#   * the explicit-host + cannot-probe arm. T92 case 5 covers the AUTO path only, so
#     the explicit path's third arm has never been executed by a guard;
#   * that argv is ignored ENTIRELY. There is no --help and no flag parser, which is
#     the contract and not an omission — a port that grew an argv parser (every other
#     shim in this tranche has one) would turn `--help` into usage text on stdout, and
#     dispatch.sh would substitute THAT into every worker's ref;
#   * that an EMPTY AIGENTRY_ORCHESTRATOR_HOST selects auto-detect rather than the
#     explicit branch — `${VAR:-}` vs `${VAR-}`, and in TS `||` vs `??`;
#   * the dual-lister scan: with the seam unset, `ifconfig` AND `ip -o -4 addr show`
#     both run, in that order, and one failing does not stop the other;
#   * the CGNAT bounds themselves (100.63 out, 100.64 in, 100.127 in, 100.128 out) and
#     first-match-wins across several candidates.
#
# THIS IS A LIVE PATH, and a quiet one. src/dispatch/cli.ts:595-597 runs it on every
# dispatch that carries {{ORCHESTRATOR_REPORT_TARGET}}, reads STDOUT ONLY, and
# substitutes the result into the ref that tells a worker where to REPORT. A dropped
# contract line here does not throw: it hands every dispatched worker an address, and
# the reports go wherever that address points. The resolver's own notes cannot warn
# anyone either — `capture()` at src/dispatch/cli.ts:54 pipes this process's stderr
# into a string it never reads (reproduced, not fixed; filed with its diff in
# docs/reports/2026-08-18-899-t5-report-target-report.md §6). So this guard is the
# characterization test that makes the port's parity measurable rather than reviewed.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $REPORT_TARGET_UNDER_TEST, defaulting to bin/orchestrator-report-target.sh. Every
# block below passed against the ORIGINAL bash before the port landed:
#
#   git show b300875:bin/orchestrator-report-target.sh > /tmp/rt-orig.sh
#   chmod +x /tmp/rt-orig.sh
#   REPORT_TARGET_UNDER_TEST=/tmp/rt-orig.sh bash tests/dispatch/T129_report_target_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with report targets.
#
# THERE IS NO PARITY FLAG, and that is the point. The port changed NO behaviour — no
# defect was fixed, so no block needs to assert one thing about the bash and another
# about the port. Every block below passes against both. If a later change does
# diverge, add REPORT_TARGET_PARITY_ORIGINAL the way T124/T127 did.
#
# Hermetic: curl and the interface scan are both seams; no network, no daemon. Block G
# is the one exception and it needs PATH, so it checks its own precondition and says
# so out loud rather than skipping in silence.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T129]: $*" >&2; exit 1; }

RESOLVER="${REPORT_TARGET_UNDER_TEST:-$REPO_ROOT/bin/orchestrator-report-target.sh}"
[ -x "$RESOLVER" ] \
  || fail "$RESOLVER is not executable — src/dispatch/cli.ts:595 gates the whole resolve on isExecutable(), so a lost mode bit fails every dispatch closed"

TAILNET_IP="100.72.155.21"

# ── seams ──────────────────────────────────────────────────────────────────
# The curl stub records argv ONE ELEMENT PER LINE, which is the whole point of block
# A: `"$*"` would flatten a word-split host back into something that looks correct.
ARGV_LOG="$T_TMP/curl-argv.log"; export ARGV_LOG
CALL_LOG="$T_TMP/curl-calls.log"; export CALL_LOG
CURL_STUB="$T_TMP/curl-stub"
cat > "$CURL_STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$ARGV_LOG"
echo x >> "$CALL_LOG"
echo "${STUB_HTTP:-200}"
# Faithful to real curl: with -w '%{http_code}' it prints `000` on a connect failure
# AND exits non-zero (T92's header records why that matters).
[ "${STUB_HTTP:-200}" = "000" ] && exit 7
exit 0
EOF
chmod +x "$CURL_STUB"

# mk_iface <path> <line>... — an interface-scan stub emitting the given lines.
# The lines are written into a heredoc'd data file the stub cats, rather than
# interpolated into shell source: an ifconfig line is full of quotes, tabs and `-->`,
# and bash 3.2 is the floor here (macOS CI).
mk_iface() {
  local p="$1"; shift
  printf '%s\n' "$@" > "$p.data"
  { echo '#!/usr/bin/env bash'; echo "cat \"$p.data\""; } > "$p"
  chmod +x "$p"
}
IFACE_WITH="$T_TMP/iface-with";   mk_iface "$IFACE_WITH"   "	inet $TAILNET_IP --> $TAILNET_IP netmask 0xffffffff"
IFACE_NONE="$T_TMP/iface-none";   mk_iface "$IFACE_NONE"   "	inet 192.168.1.10 netmask 0xffffff00"

# run <http> <iface-cmd> [env=val ...] → stdout; stderr in $T_TMP/err, rc asserted 0
run() {
  local http="$1" iface="$2"; shift 2
  : > "$CALL_LOG"; : > "$ARGV_LOG"
  local rc=0
  set +e
  env "$@" STUB_HTTP="$http" CURL="$CURL_STUB" REPORT_TARGET_IFACE_CMD="$iface" \
    bash "$RESOLVER" > "$T_TMP/out" 2> "$T_TMP/err"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] \
    || fail "the resolver exited $rc — dispatch.sh treats any non-zero as unresolvable and blocks the dispatch: $(cat "$T_TMP/err")"
  cat "$T_TMP/out"
}
stderr_of() { cat "$T_TMP/err"; }
calls()     { local n; n=$(grep -c . "$CALL_LOG" 2>/dev/null) || n=0; printf '%s' "$n"; }

# Every arm must produce exactly one clean line — dispatch.sh seds it into a ref
# verbatim, so a second line or an embedded space corrupts every worker's report
# target. T92 case 8 asserts this for one auto arm; here it runs on all of them.
assert_clean_line() {
  local out="$1" what="$2" n
  n=$(printf '%s\n' "$out" | grep -c .)
  [ "$n" = "1" ] || fail "$what: stdout carried $n lines, want exactly 1: [$out]"
  case "$out" in
    *" "*|*"	"*|*"orchestrator-report-target:"*)
      fail "$what: stdout is not a substitutable token: [$out]";;
  esac
}

# ── (A) the curl argv, as ARGV, and exactly one probe ──────────────────────
out=$(run 200 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-a)
[ "$out" = "orch-a@$TAILNET_IP" ] || fail "A: answering tailnet address = '$out'"
cat > "$T_TMP/argv.want" <<EOF
-s
-o
/dev/null
-w
%{http_code}
--connect-timeout
1
--max-time
2
http://$TAILNET_IP:3848/api/meta
EOF
diff -u "$T_TMP/argv.want" "$ARGV_LOG" >/dev/null 2>&1 || {
  echo "--- want ---" >&2; cat "$T_TMP/argv.want" >&2
  echo "--- got ----" >&2; cat "$ARGV_LOG" >&2
  fail "A: the probe argv changed. The 1s connect ceiling and the 2s cap are the stated cost contract (this runs on EVERY dispatch), /api/meta is the endpoint that proves the daemon is listening, and -o /dev/null -w %{http_code} is what makes ANY answer count. Element-per-line, so a word-split host shows up here rather than hiding inside \$*."
}
[ "$(calls)" = "1" ] \
  || fail "A: the resolver probed $(calls) time(s), want exactly 1 — 'one probe, no retry' is the cost contract, and a black-holed address pays the full connect timeout each time"

# The status is read the way `$(…)` reads it: TRAILING NEWLINES stripped and nothing
# else. `CURL` is a seam, so a wrapper that pads its output is reachable, and a port
# that trimmed all whitespace would read a padded ` 000 ` as SILENT where the bash
# reads it as ANSWERED — the #835 property flipping on an implementation detail of
# the stub rather than on what the daemon did. Mutation-checked: `.trim()` survives
# every other block.
PAD_CURL="$T_TMP/curl-pad"
printf '%s\n' '#!/usr/bin/env bash' 'printf " 000 \n"' 'exit 7' > "$PAD_CURL"
chmod +x "$PAD_CURL"
out=$(env CURL="$PAD_CURL" REPORT_TARGET_IFACE_CMD="$IFACE_WITH" \
  AIGENTRY_ORCHESTRATOR_SID=orch-a2 bash "$RESOLVER" 2>/dev/null)
[ "$out" = "orch-a2@$TAILNET_IP" ] \
  || fail "A: a padded status was not read as a substitution would read it; got '$out'"

# ── (B) the default sid is `orchestrator` ──────────────────────────────────
# Both existing guards override AIGENTRY_ORCHESTRATOR_SID in every case, so nothing
# has ever executed the default — the one value every worker inject falls back to.
out=$(env -u AIGENTRY_ORCHESTRATOR_SID STUB_HTTP=200 CURL="$CURL_STUB" \
  REPORT_TARGET_IFACE_CMD="$IFACE_WITH" bash "$RESOLVER" 2>/dev/null)
[ "$out" = "orchestrator@$TAILNET_IP" ] || fail "B: the default sid = '$out', want 'orchestrator@$TAILNET_IP'"
out=$(env -u AIGENTRY_ORCHESTRATOR_SID STUB_HTTP=200 CURL="$CURL_STUB" \
  REPORT_TARGET_IFACE_CMD="$IFACE_NONE" bash "$RESOLVER" 2>/dev/null)
[ "$out" = "orchestrator" ] || fail "B: the default sid with no candidate = '$out', want 'orchestrator'"
case "$out" in *aigentry-orchestrator-claude*) fail "B: the phantom sid is back (#690)";; esac

# ── (C) TELEPTY_PORT reaches the URL and BOTH note texts ───────────────────
out=$(run 000 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-c TELEPTY_PORT=9999)
[ "$out" = "orch-c" ] || fail "C: silent auto address = '$out'"
grep -qF "http://$TAILNET_IP:9999/api/meta" "$ARGV_LOG" \
  || { cat "$ARGV_LOG" >&2; fail "C: TELEPTY_PORT did not reach the probe URL"; }
case "$(stderr_of)" in
  *"does not answer on port 9999"*) ;;
  *) fail "C: the auto-fallback note names a different port than the one probed, so an operator reading it would check the wrong listener: $(stderr_of)";;
esac
out=$(run 000 "$IFACE_NONE" AIGENTRY_ORCHESTRATOR_SID=orch-c2 TELEPTY_PORT=9999 AIGENTRY_ORCHESTRATOR_HOST=100.99.1.2)
[ "$out" = "orch-c2@100.99.1.2" ] || fail "C: explicit silent host = '$out'"
case "$(stderr_of)" in
  *"does not answer on port 9999"*) ;;
  *) fail "C: the explicit-host note names a different port than the one probed: $(stderr_of)";;
esac
# An EMPTY TELEPTY_PORT falls back to 3848, exactly as an unset one does. This is the
# `${VAR:-default}` vs `${VAR-default}` distinction, and in TS `||` vs `??` — a `??`
# port passes every test above and then probes `http://<ip>:/api/meta` on the one
# host that exports the variable empty. Mutation-checked: without this line the `??`
# spelling survives the whole guard.
out=$(run 200 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-c3 TELEPTY_PORT=)
[ "$out" = "orch-c3@$TAILNET_IP" ] || fail "C: empty TELEPTY_PORT = '$out'"
grep -qF "http://$TAILNET_IP:3848/api/meta" "$ARGV_LOG" \
  || { cat "$ARGV_LOG" >&2; fail "C: an EMPTY TELEPTY_PORT must fall back to 3848 like an unset one, not produce a portless URL"; }

# ── (D) explicit host + cannot probe → keep the form, say it is unverified ─
# T92 case 5 covers the AUTO path only. Collapsing "I could not measure" into "it is
# unreachable" is the #835 defect one turn down, and on the explicit path it would
# also silently discard an operator's stated fact.
: > "$CALL_LOG"
set +e
out=$(env AIGENTRY_ORCHESTRATOR_SID=orch-d AIGENTRY_ORCHESTRATOR_HOST=100.99.1.2 \
  CURL="$T_TMP/no-such-curl" REPORT_TARGET_IFACE_CMD="$IFACE_NONE" \
  bash "$RESOLVER" 2>"$T_TMP/err")
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "D: an unprobeable explicit host made the resolver exit $rc, which blocks every dispatch"
[ "$out" = "orch-d@100.99.1.2" ] \
  || fail "D: an absent measurement downgraded an EXPLICITLY configured host; got '$out'"
case "$(stderr_of)" in
  *"cannot probe"*) ;;
  *) fail "D: the unverified explicit target was returned without saying it is unverified: $(stderr_of)";;
esac
assert_clean_line "$out" "D"

# ── (E) argv is ignored entirely — there is no --help and no flag parser ───
# dispatch.sh calls this with NO arguments, so any argv handling is unreachable in
# production and could only ever surprise a human. A port that grew a --help (every
# other shim in this tranche has one) would print usage text on stdout.
for a in "--help" "-h" "--version" "totally-bogus" "--"; do
  out=$(env STUB_HTTP=200 CURL="$CURL_STUB" REPORT_TARGET_IFACE_CMD="$IFACE_WITH" \
    AIGENTRY_ORCHESTRATOR_SID=orch-e bash "$RESOLVER" "$a" 2>/dev/null)
  [ "$out" = "orch-e@$TAILNET_IP" ] \
    || fail "E: '$a' changed the output to '$out' — argv must be ignored; anything else lands on stdout and dispatch.sh substitutes it into every worker's ref"
  assert_clean_line "$out" "E($a)"
done

# ── (F) an EMPTY explicit host selects AUTO-DETECT, not the explicit branch ─
# `${VAR:-}` and, in TS, `||` rather than `??`. The two branches are told apart by
# their note text, which is the only observable difference when both are silent.
out=$(run 000 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-f AIGENTRY_ORCHESTRATOR_HOST=)
[ "$out" = "orch-f" ] \
  || fail "F: an empty AIGENTRY_ORCHESTRATOR_HOST took the EXPLICIT branch and honoured an empty host; got '$out'"
case "$(stderr_of)" in
  *"auto-detected tailnet address"*) ;;
  *) fail "F: an empty host did not take the auto-detect branch: $(stderr_of)";;
esac
case "$(stderr_of)" in
  *"honouring it because you set it explicitly"*)
    fail "F: an empty host was treated as an operator's stated fact: $(stderr_of)";;
esac

# ── (G) the dual-lister scan, with the seam unset ─────────────────────────
# The resolver hardcodes `export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH`,
# so a stub is only reachable when none of those four dirs holds a real lister. That is
# true on stock macOS (ifconfig lives in /sbin) and on most Linux images, but homebrew's
# iproute2mac installs /opt/homebrew/bin/ip. Check it and SAY SO rather than skipping in
# silence — a block that quietly stops asserting reads as coverage it no longer has.
G_OK=1
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do
  for c in ifconfig ip; do [ -x "$d/$c" ] && G_OK=0; done
done
if [ "$G_OK" = "1" ]; then
  LB="$T_TMP/listerbin"; mkdir -p "$LB"
  LIST_LOG="$T_TMP/listers.log"; export LIST_LOG
  # ifconfig FAILS. `ip` must still run: in the bash the whole scan group is the left
  # operand of `|| true`, which suppresses errexit inside it — the opposite reading is
  # the plausible one, and a port that stopped at the first failure would resolve the
  # bare sid on every Linux host.
  cat > "$LB/ifconfig" <<'EOF'
#!/usr/bin/env bash
echo ifconfig >> "$LIST_LOG"
echo "boom" >&2
exit 1
EOF
  cat > "$LB/ip" <<EOF
#!/usr/bin/env bash
printf '%s\n' "ip \$*" >> "\$LIST_LOG"
printf '%s\n' "2: tailscale0    inet $TAILNET_IP/32 scope global tailscale0"
EOF
  chmod +x "$LB/ifconfig" "$LB/ip"
  # The stub dir must beat the REAL listers, which live in /sbin (macOS) or /usr/sbin
  # (Linux) — both inherited from this shell's PATH, and appending would lose to them.
  # So the lister PATH is built from scratch: the stubs, then only what the resolver
  # itself needs (node for the shim, and the standard bin dirs the four hardcoded
  # prefix entries already cover). The precondition above is what makes this safe.
  G_NODE="$(command -v node || true)"
  [ -n "$G_NODE" ] || fail "G: no node on PATH — the shim execs it, and building a PATH without it would fail for a reason that has nothing to do with the lister scan"
  G_PATH="$LB:$(dirname "$G_NODE"):/usr/bin:/bin"
  : > "$LIST_LOG"; : > "$CALL_LOG"
  out=$(env -u REPORT_TARGET_IFACE_CMD STUB_HTTP=200 CURL="$CURL_STUB" \
    AIGENTRY_ORCHESTRATOR_SID=orch-g PATH="$G_PATH" bash "$RESOLVER" 2>/dev/null)
  [ "$out" = "orch-g@$TAILNET_IP" ] \
    || fail "G: with the seam unset the scan did not reach the listers, or a failing ifconfig aborted it before ip ran; got '$out' — calls: $(cat "$LIST_LOG")"
  grep -qx 'ifconfig' "$LIST_LOG" || { cat "$LIST_LOG" >&2; fail "G: ifconfig was never run"; }
  grep -qx 'ip -o -4 addr show' "$LIST_LOG" \
    || { cat "$LIST_LOG" >&2; fail "G: 'ip -o -4 addr show' was not run with that exact argv (or was skipped after ifconfig failed)"; }
  [ "$(head -n1 "$LIST_LOG")" = "ifconfig" ] \
    || fail "G: the listers ran out of order; ifconfig is first, so on a host with BOTH its address wins"
  # …and the seam, when SET, replaces them entirely.
  : > "$LIST_LOG"
  out=$(run 200 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-g2 PATH="$G_PATH")
  [ "$out" = "orch-g2@$TAILNET_IP" ] || fail "G: seam-set resolve = '$out'"
  [ ! -s "$LIST_LOG" ] \
    || { cat "$LIST_LOG" >&2; fail "G: REPORT_TARGET_IFACE_CMD is set, so the real listers must not run at all"; }
else
  # Worded as a NOTE, not a SKIP, deliberately. run-all.sh:74 matches
  # `^T[0-9]+[: ].*SKIP` and cross-checks every announced skip against
  # EXPECTED_SKIPS_{DARWIN,LINUX} (:43-44); announcing here would turn a
  # host-dependent block into a SKIP-SET MISMATCH that fails the whole suite. The
  # guard still passes, and the line still says exactly what stopped being asserted.
  echo "T129 NOTE: block G not asserted — a real ifconfig/ip lives in the resolver's hardcoded PATH prefix on this host, so the lister stubs are unreachable. Blocks A-F,H,I still ran." >&2
fi

# ── (H) the CGNAT bounds, and first-match-wins ────────────────────────────
# 100.64.0.0/10 is second octet 64..127. Nothing pins the edges, and the regex spells
# them out in four alternations that are easy to get wrong by one.
IF_LO="$T_TMP/iface-lo";  mk_iface "$IF_LO"  "	inet 100.63.0.1" "	inet 100.64.0.2"
IF_HI="$T_TMP/iface-hi";  mk_iface "$IF_HI"  "	inet 100.128.0.1" "	inet 100.127.0.2"
IF_TWO="$T_TMP/iface-two"; mk_iface "$IF_TWO" "	inet $TAILNET_IP" "	inet 100.80.0.9"

out=$(run 200 "$IF_LO" AIGENTRY_ORCHESTRATOR_SID=orch-h)
[ "$out" = "orch-h@100.64.0.2" ] \
  || fail "H: 100.63.x is BELOW the CGNAT range and 100.64.x is the first address in it; got '$out'"
out=$(run 200 "$IF_HI" AIGENTRY_ORCHESTRATOR_SID=orch-h2)
[ "$out" = "orch-h2@100.127.0.2" ] \
  || fail "H: 100.128.x is ABOVE the CGNAT range and 100.127.x is the last address in it; got '$out'"
out=$(run 200 "$IF_TWO" AIGENTRY_ORCHESTRATOR_SID=orch-h3)
[ "$out" = "orch-h3@$TAILNET_IP" ] \
  || fail "H: with several CGNAT candidates the FIRST one wins (the documented ceiling: set AIGENTRY_ORCHESTRATOR_HOST if it misfires); got '$out'"
assert_clean_line "$out" "H"


# ── (I) the interface seam is a FILENAME, never a shell string ────────────
# The bash ran `"$IFACE_CMD"` as one quoted word: a value with a space is looked up
# as a single filename, fails, and leaves an empty scan. That is correct by
# construction, and it is the property most at risk in a port — `shell: true`, or
# splitting the value on spaces, would turn a seam that has NO injection surface into
# one that does, and every test above would still pass. Mutation-checked: a
# `shell: true` spelling survives blocks A-H untouched.
out=$(run 200 "$IFACE_WITH extra-arg" AIGENTRY_ORCHESTRATOR_SID=orch-i)
[ "$out" = "orch-i" ] \
  || fail "I: REPORT_TARGET_IFACE_CMD is invoked as ONE filename with no arguments, so a value with a space must fail to resolve and leave an empty scan; got '$out' — a port that split on spaces or used a shell has added an argument-injection surface"
CANARY="$T_TMP/seam-canary"
rm -f "$CANARY"
out=$(run 200 "$IFACE_WITH; touch $CANARY" AIGENTRY_ORCHESTRATOR_SID=orch-i2)
[ ! -e "$CANARY" ] \
  || fail "I: the interface seam was interpreted by a shell — REPORT_TARGET_IFACE_CMD now executes arbitrary commands, which the bash it replaces never did"
[ "$out" = "orch-i2" ] || fail "I: a metacharacter-bearing seam value resolved to '$out'"

# The PASS line names what actually ran, not what the file contains — a summary that
# says A-I while the NOTE two lines up says G did not assert is the kind of small lie
# that gets read instead of the note.
if [ "$G_OK" = "1" ]; then
  echo "T129 PASS resolver=$RESOLVER blocks=A-I"
else
  echo "T129 PASS resolver=$RESOLVER blocks=A-F,H,I (G not asserted on this host)"
fi
