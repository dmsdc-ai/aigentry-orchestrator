#!/usr/bin/env bash
# T135 — #933: the resolver's degraded-target NOTE must reach the operator.
#
# src/dispatch/cli.ts:596 resolved the report target through `capture()`, whose
# spawnSync defaults PIPE stderr into a string that is never read. The resolver
# writes its warnings to stderr, so every one of them was discarded by the only
# production caller. The fix is `captureOut()` (:64), which inherits stderr.
#
# This is not a hypothetical. bin/orchestrator-report-target.sh's own header
# records the defect (D4 in src/report-target/cli.ts:87-92) and files it as
# "belongs in src/dispatch/cli.ts". Measured on the dispatching host: the tailnet
# address does not answer on 3848, so the resolver takes the degraded arm, falls
# back to the bare sid, and CROSS-MACHINE WORKERS HAVE NO WORKING REPORT TARGET.
# The dispatch still exits 0 and prints nothing about it.
#
# Both cases assert the same property from opposite ends:
#   A. a stub resolver whose stderr text this guard chooses — pins the PLUMBING
#      (does dispatch pass the resolver's stderr through at all?) without
#      depending on any wording the resolver may later change.
#   B. the REAL resolver, forced into its auto-detected-degraded arm through the
#      documented CURL and REPORT_TARGET_IFACE_CMD seams — pins that the sentence
#      an operator actually needs to see is the one that arrives.
#
# Case B drives the seam rather than the PATH-based lister scan on purpose: the
# lister scan is unreachable behind the resolver's hardcoded PATH prefix on hosts
# that carry a real ifconfig/ip there (T129 block G says so out loud), and this
# guard must not inherit that host dependency.
#
# Hermetic: telepty, curl and the interface lister are all stubs. No daemon is
# contacted and nothing is injected anywhere — :3848 is never dialled.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T135]: $*" >&2; exit 1; }

# ── the transport stub: captures the ref that was injected, never dials out ──
CAP_FILE="$T_TMP/injected-ref.txt"; : > "$CAP_FILE"; export CAP_FILE
TELEPTY_STUB="$T_TMP/telepty-stub"
cat > "$TELEPTY_STUB" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "inject" ]; then
  prev=""
  for a in "$@"; do [ "$prev" = "--ref" ] && cat "$a" > "$CAP_FILE"; prev="$a"; done
  echo "stub inject OK"; exit 0
fi
echo "stub telepty $*"
STUB
chmod +x "$TELEPTY_STUB"
export TELEPTY="$TELEPTY_STUB"

REF="$T_TMP/ref.md"
printf 'task body\nreport to {{ORCHESTRATOR_REPORT_TARGET}} when done\n' > "$REF"

# The `__probe dispatch-ref` subcommand is prepare_effective_ref + do_inject, the
# exact production pair (#899); T67 drives it the same way.
ERRF="$T_TMP/dispatch.err"
dispatch_ref() {
  "$REPO_ROOT/bin/dispatch.sh" __probe dispatch-ref \
    --ref "$REF" --from orchestrator sid-A >/dev/null 2>"$ERRF"
}

# ── (A) the plumbing: a resolver note on stderr reaches dispatch's stderr ──
# rc 0 with a usable target on stdout AND a warning on stderr is precisely the
# degraded shape: the dispatch must SUCCEED and still say something.
NOTE_A='orchestrator-report-target: T135 canary — the degraded note must not be swallowed'
RES_A="$T_TMP/resolver-degraded"
cat > "$RES_A" <<EOF
#!/usr/bin/env bash
echo "$NOTE_A" >&2
echo "orchestrator"
EOF
chmod +x "$RES_A"

REPORT_TARGET_SH="$RES_A" dispatch_ref \
  || fail "A: a degraded-but-resolvable target must still dispatch (rc=$?); stderr: $(cat "$ERRF")"

grep -qF "$NOTE_A" "$ERRF" || {
  echo "--- dispatch stderr was: ---" >&2; cat "$ERRF" >&2
  fail "A: the resolver's stderr NOTE never reached the operator. src/dispatch/cli.ts resolves the report target with a helper that PIPES stderr into an unread string (capture(), :54) instead of one that inherits it (captureOut(), :64) — so every degraded-target warning is discarded (#933)"
}

# The substitution itself must be unharmed by the change of helper: stdout is
# still read, and still only stdout.
grep -qF 'report to orchestrator when done' "$CAP_FILE" \
  || { cat "$CAP_FILE" >&2; fail "A: the resolved target was not substituted into the ref"; }
grep -qF '{{ORCHESTRATOR_REPORT_TARGET}}' "$CAP_FILE" \
  && fail "A: the placeholder survived substitution"
# The note is stderr, so it must NOT have been captured as part of the target.
grep -qF 'T135 canary' "$CAP_FILE" \
  && { cat "$CAP_FILE" >&2; fail "A: the resolver's STDERR was folded into the target — captureBoth() semantics, not captureOut()"; }

# ── (B) the real resolver's real sentence ──
# CGNAT address present on the seam + a probe that answers 000 = the auto-detected
# tailnet address does not answer, which is the arm that strands cross-machine
# workers. This is the live condition on the dispatching host today.
: > "$CAP_FILE"
CURL_DEAD="$T_TMP/curl-dead"
cat > "$CURL_DEAD" <<'EOF'
#!/usr/bin/env bash
# Faithful to `curl -w '%{http_code}'` on a connect failure: prints 000, exits 7.
echo "000"; exit 7
EOF
IFACE_STUB="$T_TMP/iface-stub"
cat > "$IFACE_STUB" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "	inet 100.72.155.21 netmask 0xffffffff"
EOF
chmod +x "$CURL_DEAD" "$IFACE_STUB"

REPORT_TARGET_SH="$REPO_ROOT/bin/orchestrator-report-target.sh" \
CURL="$CURL_DEAD" \
REPORT_TARGET_IFACE_CMD="$IFACE_STUB" \
AIGENTRY_ORCHESTRATOR_SID=orch-b \
  dispatch_ref || fail "B: the bare-sid fallback is a SUCCESSFUL resolve; dispatch must not fail closed on it (rc=$?); stderr: $(cat "$ERRF")"

grep -qF 'does not answer on port' "$ERRF" || {
  echo "--- dispatch stderr was: ---" >&2; cat "$ERRF" >&2
  fail "B: the real resolver degraded to the bare sid and dispatch told the operator nothing. Cross-machine workers now have no working report target and the only warning that says so was discarded (#933)"
}
# The degraded arm resolves the BARE sid; if it ever substitutes the unreachable
# tailnet form instead, the warning above would be describing a target that was
# nonetheless used.
grep -qF 'report to orch-b when done' "$CAP_FILE" \
  || { cat "$CAP_FILE" >&2; fail "B: the degraded arm must substitute the bare sid"; }

echo "T135 PASS"
