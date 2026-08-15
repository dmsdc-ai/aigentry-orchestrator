#!/usr/bin/env bash
# T92 — the orchestrator report target must be MEASURED, not inferred (#835 family).
#
# The resolver returned `<sid>@<tailnet-ip>` whenever an interface carried a CGNAT
# address. That infers reachability from the presence of an address. When the
# daemon stopped listening on the tailnet the interface kept its address, so every
# dispatched worker was handed a report target that answers nothing — and since
# `telepty inject` exits 0 while printing a failure on that path (telepty #840, not
# ours), nothing downstream could notice either. Every REPORT went nowhere.
#
# Asserts:
#   1. auto-detected address that ANSWERS      → <sid>@<ip>
#   2. auto-detected address that is SILENT    → bare <sid>, and says why
#   3. explicit AIGENTRY_ORCHESTRATOR_HOST that is silent → HONOURED, but noted on
#      stderr — an operator stating a fact outranks our measurement, and the
#      override is the escape hatch for a misfiring probe; it just stops being
#      invisible
#   4. explicit host that answers              → <sid>@<ip>, nothing on stderr
#   5. cannot probe at all                     → keeps the form, notes it. "I could
#      not measure" is not "it is unreachable" — collapsing those is the same
#      defect one turn down
#   6. no candidate address                    → bare <sid>, and NO probe attempted
#   7. any HTTP answer counts, 401 included    → reachability is not authorization;
#      a credential problem hits the bare local form identically
#   8. stdout stays a single clean line in every case — dispatch.sh substitutes it
#      into a ref verbatim
#
# Hermetic: the interface scan and curl are both seams; no network, no daemon.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
RESOLVER="$REPO_ROOT/bin/orchestrator-report-target.sh"

fail() { echo "FAIL[T92]: $*" >&2; exit 1; }

TAILNET_IP="100.72.155.21"

# Interface-scan seam: emit one line shaped like real ifconfig output.
IFACE_WITH="$T_TMP/iface-with"
cat > "$IFACE_WITH" <<EOF
#!/usr/bin/env bash
echo "	inet $TAILNET_IP --> $TAILNET_IP netmask 0xffffffff"
EOF
IFACE_NONE="$T_TMP/iface-none"
printf '%s\n' '#!/usr/bin/env bash' 'echo "	inet 192.168.1.10 netmask 0xffffff00"' > "$IFACE_NONE"
chmod +x "$IFACE_WITH" "$IFACE_NONE"

# curl seam: records every call, answers $STUB_HTTP.
PROBE_LOG="$T_TMP/probe.log"; export PROBE_LOG
CURL_STUB="$T_TMP/curl-stub"
# Faithful to the real curl: with -w '%{http_code}' it prints `000` on a connect
# failure AND exits non-zero. A stub that always exited 0 would hide a caller
# whose `|| echo 000` doubles the value to `000000` and reads it as an answer —
# which is precisely the bug this file's first draft shipped and the real address
# exposed. The silent case has to fail the way curl fails.
cat > "$CURL_STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PROBE_LOG"
echo "${STUB_HTTP:-200}"
[ "${STUB_HTTP:-200}" = "000" ] && exit 7
exit 0
EOF
chmod +x "$CURL_STUB"

# run <http> <iface-cmd> [env=val ...] → "<rc>\n<stdout>\n---STDERR---\n<stderr>"
run() {
  local http="$1" iface="$2"; shift 2
  : > "$PROBE_LOG"
  local outf="$T_TMP/out" errf="$T_TMP/err" rc=0
  set +e
  env "$@" STUB_HTTP="$http" CURL="$CURL_STUB" REPORT_TARGET_IFACE_CMD="$iface" \
    bash "$RESOLVER" > "$outf" 2> "$errf"
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "resolver exited $rc — dispatch.sh fails closed on a non-zero resolve, which would block every dispatch: $(cat "$errf")"
  printf '%s' "$(cat "$outf")"
}
stderr_of() { cat "$T_TMP/err"; }
# `grep -c` prints 0 AND exits 1 on no match, so the usual `|| echo 0` would emit
# two lines and break the comparison. Capture, then default.
probes()    { local n; n=$(grep -c . "$PROBE_LOG" 2>/dev/null) || n=0; printf '%s' "$n"; }

# ── (1) auto-detected and answering → the tailnet form ─────────────────────
out=$(run 200 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-a)
[ "$out" = "orch-a@$TAILNET_IP" ] \
  || fail "an answering tailnet address must still produce the cross-machine form; got '$out'"
[ "$(probes)" -ge 1 ] || fail "no probe was made — the address was trusted without measurement"

# ── (2) auto-detected and silent → bare sid, with a reason ─────────────────
out=$(run 000 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-b)
[ "$out" = "orch-b" ] \
  || fail "a tailnet address that answers nothing was still handed to workers as their report target; got '$out'"
case "$(stderr_of)" in
  *"does not answer"*) ;;
  *) fail "the fallback was silent — an operator cannot tell cross-machine reporting is degraded: $(stderr_of)";;
esac
# The gap this leaves must be stated, not glossed.
case "$(stderr_of)" in
  *"Cross-machine workers have no working report target"*) ;;
  *) fail "the fallback did not name what it costs: $(stderr_of)";;
esac

# ── (3) explicit host, silent → honoured, but noted ────────────────────────
out=$(run 000 "$IFACE_NONE" AIGENTRY_ORCHESTRATOR_SID=orch-c AIGENTRY_ORCHESTRATOR_HOST=100.99.1.2)
[ "$out" = "orch-c@100.99.1.2" ] \
  || fail "an explicitly configured host was overridden by our own probe — that removes the only escape hatch for a misfiring auto-detect; got '$out'"
case "$(stderr_of)" in
  *"honouring it because you set it explicitly"*) ;;
  *) fail "an unreachable explicit host was honoured SILENTLY — the operator gets no signal at all: $(stderr_of)";;
esac

# ── (4) explicit host that answers → no noise ──────────────────────────────
out=$(run 200 "$IFACE_NONE" AIGENTRY_ORCHESTRATOR_SID=orch-d AIGENTRY_ORCHESTRATOR_HOST=100.99.1.2)
[ "$out" = "orch-d@100.99.1.2" ] || fail "explicit reachable host = '$out'"
[ -z "$(stderr_of)" ] || fail "a working configuration produced a warning: $(stderr_of)"

# ── (5) cannot probe → keep the form, say so ──────────────────────────────
# "I could not measure" must not be laundered into "it is not there".
: > "$PROBE_LOG"
set +e
out=$(env AIGENTRY_ORCHESTRATOR_SID=orch-e CURL="$T_TMP/no-such-curl" \
  REPORT_TARGET_IFACE_CMD="$IFACE_WITH" bash "$RESOLVER" 2>"$T_TMP/err")
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "an unprobeable host made the resolver fail (rc=$rc), which blocks every dispatch"
[ "$out" = "orch-e@$TAILNET_IP" ] \
  || fail "an absent measurement was treated as a negative one and downgraded the target; got '$out'"
case "$(stderr_of)" in
  *"cannot probe"*) ;;
  *) fail "the unverified target was returned without saying it is unverified: $(stderr_of)";;
esac

# ── (6) no candidate → bare sid, and nothing probed ───────────────────────
out=$(run 200 "$IFACE_NONE" AIGENTRY_ORCHESTRATOR_SID=orch-f)
[ "$out" = "orch-f" ] || fail "single-machine resolve = '$out', want bare 'orch-f'"
[ "$(probes)" -eq 0 ] \
  || fail "a probe was issued with no address to probe — every dispatch would pay for it: $(cat "$PROBE_LOG")"

# ── (7) reachability is not authorization ─────────────────────────────────
for code in 401 403 500; do
  out=$(run "$code" "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-g)
  [ "$out" = "orch-g@$TAILNET_IP" ] \
    || fail "HTTP $code was read as unreachable; the daemon answered, so it is listening — and a credential or server fault would hit the bare local form identically. got '$out'"
done

# ── (8) the contract is one clean line ────────────────────────────────────
# dispatch.sh seds this straight into a ref; a stray line would corrupt it.
out=$(run 000 "$IFACE_WITH" AIGENTRY_ORCHESTRATOR_SID=orch-h)
lines=$(printf '%s\n' "$out" | grep -c .)
[ "$lines" = "1" ] || fail "stdout carried $lines lines, want exactly 1: [$out]"
case "$out" in
  *" "*|*"orchestrator-report-target:"*)
    fail "a stderr note leaked into the substituted value: [$out]";;
esac

echo "T92 PASS"
