#!/usr/bin/env bash
# T137 — #930/#400: a reconcile tick must resolve the OPERATOR's telepty.
#
# THE DECISION THIS PINS. Every shim used to open with
#   export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# which puts homebrew AHEAD of everything the caller had, for every binary. That
# prefix is named as the cause of #400 in bin/session-cleanup.sh:34-41 — a stale
# homebrew telepty answered against a running daemon of a different version, and the
# version-mismatch banner then contaminated a jq stdin. session-cleanup.sh was fixed by
# dropping the prefix; the other shims kept it byte-identical, because each port was
# surgical and nobody was allowed to decide. #930 decided it: homebrew is a FALLBACK.
#
# Measured on the dispatching host, which is why this is not hypothetical:
#   telepty                  → ~/.nvm/versions/node/v20.20.0/bin/telepty
#   /opt/homebrew/bin/telepty → a SECOND, independent symlink
# Both point at the same source checkout TODAY. That is precisely the state in which
# this regresses unnoticed: nothing is visibly broken, and the two diverge the moment
# either side is upgraded — at which point every shim silently follows homebrew's while
# the operator, and the daemon they started, are on the other one.
#
# WHY A GUARD AND NOT A COMMENT. The prefix survived four ports as a copied line. A
# note saying "do not prepend homebrew" is exactly what was already there, in
# session-cleanup.sh, and it did not stop the next shim from carrying the prefix. This
# fails instead.
#
# WHAT IS OBSERVED. Step 0d of the reconcile tick (src/reconciler/cli.ts:1300-1301) is
# bin/orchestrator-bridge-auditor.sh, and its HOLD inject is a real `$TELEPTY` spawn —
# the cheapest place where a tick's telepty resolution becomes observable. The
# reconciler shim itself is NOT driven here: a tick writes real state and supervises
# real bridges, and this suite does not touch the live workspace. What that leaves
# unproven is stated at the bottom of this file rather than assumed.
#
# Hermetic: no daemon is contacted. The recorder telepty writes a file and exits.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T137]: $*" >&2; exit 1; }

AUDITOR="$REPO_ROOT/bin/orchestrator-bridge-auditor.sh"
[ -x "$AUDITOR" ] || fail "$AUDITOR is not executable"

# ── the operator's telepty: a recorder that names itself ──
OPBIN="$T_TMP/operator-bin"; mkdir -p "$OPBIN"
WHICH_LOG="$T_TMP/which-telepty.log"; export WHICH_LOG
cat > "$OPBIN/telepty" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$0" >> "$WHICH_LOG"
exit 0
EOF
chmod +x "$OPBIN/telepty"

# ── a ps snapshot with two REAL bridges, so the auditor reaches its inject ──
PS_TABLE="$T_TMP/ps-table.txt"
PS_STUB="$T_TMP/ps-stub.sh"
cat > "$PS_STUB" <<EOF
#!/usr/bin/env bash
cat "$PS_TABLE"
EOF
chmod +x "$PS_STUB"
# THE SID IS A FIXTURE SID, NOT `orchestrator`, and that is a safety property rather
# than a detail. This arm deliberately leaves TELEPTY unset so the shim's own resolution
# is what runs — which means a REGRESSION to the old prefix makes the auditor spawn the
# REAL telepty. If the sid were `orchestrator`, that spawn would inject a false
# duplicate-bridge HOLD into the LIVE session, which is precisely what an earlier
# version of this file did four times before it was caught. With a fixture sid the
# worst a regression can do is address a session that does not exist.
FIXTURE_SID="t137-fixture-orch"
cat > "$PS_TABLE" <<EOF
50349 2-04:11:07 node telepty allow --id $FIXTURE_SID claude --dangerously-skip-permissions
50350 00:00:31 node telepty allow --id $FIXTURE_SID claude
EOF

: > "$WHICH_LOG"
# TELEPTY is UNSET on purpose — resolving it is the behaviour under test. lib.sh:45
# exports an absolute one for every other guard, which would mask this entirely.
env -u TELEPTY \
    PATH="$OPBIN:$PATH" \
    DISPATCH_STATE_DIR="$T_TMP/state" \
    ORCHESTRATOR_SID="$FIXTURE_SID" \
    SINGLETON_PS_CMD="$PS_STUB" \
    "$AUDITOR" >"$T_TMP/out.txt" 2>"$T_TMP/err.txt" \
  || fail "the auditor exited non-zero: $(cat "$T_TMP/err.txt")"

grep -qF 'count=2' "$T_TMP/err.txt" \
  || fail "the fixture did not reach the inject — two real bridges must be a duplicate, or this guard is measuring nothing: $(cat "$T_TMP/err.txt")"

[ -s "$WHICH_LOG" ] || {
  echo "--- resolved instead: $(env PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$OPBIN:$PATH" command -v telepty) ---" >&2
  fail "the shim did NOT run the telepty that was first on the inherited PATH. A hardcoded '/opt/homebrew/bin:…:\$PATH' prefix outranks the caller's PATH for every binary, so a reconcile tick resolves whatever telepty homebrew has rather than the one the operator is running — that is #400 (bin/session-cleanup.sh:34-41), and #930 decided homebrew must be a FALLBACK, appended, never a prefix"
}

got=$(head -n1 "$WHICH_LOG")
[ "$got" = "$OPBIN/telepty" ] \
  || fail "a tick resolved '$got'; the operator's telepty is '$OPBIN/telepty'"

# ── the fallback half must survive: with NOTHING on the inherited PATH, a shim under
#    launchd still has to find node/python3, which is the only reason the homebrew
#    entry is there at all. Asserted through the shim's own resolution rather than by
#    reading its source, so a rewrite that drops the fallback fails here.
#
#    ⚠️ THIS ARM RUNS WITH TELEPTY UNSET AND MUST NEVER REACH THE INJECT PATH. Measured
#    the hard way: the first version of this block used the two-bridge table below with
#    TELEPTY unset, so the shim resolved the REAL /opt/homebrew/bin/telepty and the
#    auditor sent four genuine duplicate-bridge HOLDs to the LIVE orchestrator, naming
#    fixture pids that do not exist. The operator lost an investigation to it. Two
#    independent stops now, because one is what failed:
#      1. a ONE-bridge table — `count <= 1` exits 0 long before the inject;
#      2. a tripwire TELEPTY that fails this guard if anything invokes it.
#    Resolution is not what this arm measures; node-under-launchd is. Setting TELEPTY
#    costs nothing here and removes the only path to a real transport.
PS_ONE="$T_TMP/ps-one.txt"
cat > "$PS_ONE" <<'EOF'
50349 2-04:11:07 node telepty allow --id orchestrator claude --dangerously-skip-permissions
EOF
PS_STUB_ONE="$T_TMP/ps-stub-one.sh"
printf '#!/usr/bin/env bash\ncat "%s"\n' "$PS_ONE" > "$PS_STUB_ONE"; chmod +x "$PS_STUB_ONE"

TRIPWIRE_LOG="$T_TMP/tripwire.log"; export TRIPWIRE_LOG
TRIPWIRE="$T_TMP/telepty-tripwire"
cat > "$TRIPWIRE" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TRIPWIRE_LOG"
exit 0
EOF
chmod +x "$TRIPWIRE"
: > "$TRIPWIRE_LOG"

out=$(env PATH="/usr/bin:/bin" TELEPTY="$TRIPWIRE" \
        DISPATCH_STATE_DIR="$T_TMP/state2" \
        SINGLETON_PS_CMD="$PS_STUB_ONE" \
        "$AUDITOR" 2>&1) && rc=0 || rc=$?
[ "$rc" = "0" ] \
  || fail "with a launchd-shaped PATH (/usr/bin:/bin — no node, no homebrew) the shim failed rc=$rc. The appended homebrew entry is what makes node resolvable there; dropping it instead of demoting it breaks the daemon path: $out"
[ ! -s "$TRIPWIRE_LOG" ] \
  || { cat "$TRIPWIRE_LOG" >&2; fail "this guard reached a telepty transport. A single bridge is not a duplicate, so nothing here may inject — and a guard that can inject can reach the LIVE orchestrator, which is exactly how this file once sent four false HOLDs to a human"; }

# ── NOT PROVEN HERE, stated so the gap is visible rather than assumed covered:
#    * the reconciler shim itself is not driven (a tick mutates real state), so what is
#      pinned is step 0d's resolution, not every child a full tick spawns;
#    * this asserts ORDER, not identity — on a host with no second telepty anywhere it
#      passes trivially, because there is nothing for the prefix to have preferred.
echo "T137 PASS resolved=$got"
