#!/usr/bin/env bash
# T114 (#899 tranche 2d) — bin/hitl.sh must work from an init-materialized
# workspace, where there is no sibling dist/.
#
# Same catch as T99 (dispatch), T100 (tracker), T105 (cleanup) and T111
# (reconciler), for the fifth shim. bin/hitl.sh is an exec shim onto
# dist/src/hitl/cli.js now. In the repo and in the installed npm package dist/ sits
# next to bin/, so "$SCRIPT_DIR/../dist" resolves. In a control workspace it does
# NOT: `init` copies bin/ out of the package via bin/init/manifest.mjs — which lists
# bin/hitl.sh literally and ships no dist entries at all — so dist/ stays behind in
# the package root.
#
# WHY THIS ONE MATTERS MORE THAN ITS SIBLINGS. This is the safety gate. Both of its
# producers gate on `-x bin/hitl.sh` and treat an unusable gate as an ALERT, not an
# abort (src/reconciler/cli.ts:482 HITL_GATE_UNAVAILABLE, src/tracker/cli.ts:453) —
# by design, because a broken gate must never wedge the tick. The cost of that
# design is that a shim which resolved only the sibling path would leave a workspace
# ticking happily with no human surface at all: every re-dispatch-cap breach and
# every surface=error would log an alert and carry on, and nothing would ever be put
# in front of a person. A green suite with a mute gate is exactly the failure this
# guard exists to make loud.
#
# Beyond --help: a real `open` is asserted too, because --help is answered by the
# compiled module alone while `open --subject-sid` also has to reach the workspace's
# OWN bin/dispatch-registry.py — the one bin/ helper hitl resolves through
# AIGENTRY_SHIM_SCRIPT_DIR, and the reason the shim exports it. A port that resolved
# it relative to dist/ instead would pass --help and then write the REPO's registry
# from inside a workspace. It is replaced with a recorder in the workspace copy, so
# "it reached the workspace's own bin/" is measured rather than assumed.
#
# Layout materialized here:
#   $WS/bin/**   — the workspace: bin/ copied, NO dist/
#   $PKG/        — the installed package: bin/init/cli.mjs + dist/ (symlinked to the
#                  repo's real build), reachable only as the `aigentry-orchestrator`
#                  bin on PATH, exactly as npm installs it
#
# Hermetic: temp HITL_STATE_DIR, lib.sh's telepty recorder stub, a recorder in place
# of the registry, a frozen clock, and a throwaway sid only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T114]: $*" >&2; exit 1; }

[ -f "$REPO_ROOT/dist/src/hitl/cli.js" ] \
  || fail "dist/src/hitl/cli.js missing — run 'tsc -p .' before this suite (see run-all.sh header)"

# ── the workspace: bin/ without dist/ ──
WS="$T_TMP/workspace"
mkdir -p "$WS"
cp -R "$REPO_ROOT/bin" "$WS/bin"
[ ! -e "$WS/dist" ] || fail "fixture is wrong: the workspace must not have a dist/"

# ── the installed package, reachable only via its bin on PATH ──
PKG="$T_TMP/pkg"
mkdir -p "$PKG/bin/init"
printf '%s\n' '#!/usr/bin/env node' > "$PKG/bin/init/cli.mjs"
chmod +x "$PKG/bin/init/cli.mjs"
ln -s "$REPO_ROOT/dist" "$PKG/dist"
PKGBIN="$T_TMP/pkgbin"
mkdir -p "$PKGBIN"
ln -s "$PKG/bin/init/cli.mjs" "$PKGBIN/aigentry-orchestrator"

HITL="$WS/bin/hitl.sh"
[ -x "$HITL" ] || fail "the workspace copy of bin/hitl.sh is not executable — both producers gate on -x"

export HITL_STATE_DIR="$T_TMP/hitl"

# ── (A) --help resolves the package's dist/ and reaches the real implementation ──
OUT="$T_TMP/help.txt"
set +e
PATH="$PKGBIN:$PATH" bash "$HITL" --help > "$OUT" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || {
  echo "--- output ---" >&2; cat "$OUT" >&2
  fail "a workspace-layout hitl.sh --help exited $rc — the shim did not resolve the package's dist/"
}
# …and it reached the REAL implementation, not merely something that exits 0.
t_assert_contains "$OUT" "hitl.sh — HITL Gate CLI (ADR 2026-07-26-hitl-gate-primitive)."
t_assert_contains "$OUT" "resume ∈ reinject | registry-clear-redispatch | none"

# ── (B) a real open reaches the WORKSPACE's own bin/dispatch-registry.py ──
REG_LOG="$T_TMP/registry.log"; : > "$REG_LOG"
cat > "$WS/bin/dispatch-registry.py" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
[ "\${1:-}" = get ] && printf 'delivery_attempt_started\n'
exit 0
EOF
chmod +x "$WS/bin/dispatch-registry.py"

set +e
gid=$(PATH="$PKGBIN:$PATH" RECONCILER_NOW="2026-08-16T12:00:00Z" TELEPTY="$STUB_BIN/telepty" \
  bash "$HITL" open --source sid-T114 --subject-sid sid-T114 --kind decision \
  --resume reinject --question "phase boundary from a control workspace" 2> "$T_TMP/open.err")
rc=$?
set -e
[ "$rc" -eq 0 ] || { echo "--- stderr ---" >&2; cat "$T_TMP/open.err" >&2
  fail "a workspace-layout open exited $rc"; }
[ -f "$HITL_STATE_DIR/pending/$gid.json" ] || fail "the workspace open wrote no gate file"
grep -qxF "get --sid sid-T114 --pointer lifecycle.state" "$REG_LOG" \
  || { echo "--- registry calls ---" >&2; cat "$REG_LOG" >&2
       fail "the lifecycle read did not reach the WORKSPACE's own bin/dispatch-registry.py — AIGENTRY_SHIM_SCRIPT_DIR was not honoured"; }
grep -qxF "set-gate --sid sid-T114 --state awaiting_user --now 2026-08-16T12:00:00Z" "$REG_LOG" \
  || { echo "--- registry calls ---" >&2; cat "$REG_LOG" >&2
       fail "the blocking status write did not reach the workspace's own bin/dispatch-registry.py"; }
# The notify went out on the workspace's transport too — a gate nobody is told about
# is the same failure as a gate that was never opened.
t_assert_contains "$STUB_DISPATCH_LOG" "HITL_GATE $gid"

# …and the decide half resolves the same way (it is the operator's own command, run
# from the workspace, and it writes the registry as well).
: > "$REG_LOG"
set +e
PATH="$PKGBIN:$PATH" RECONCILER_NOW="2026-08-16T12:30:00Z" TELEPTY="$STUB_BIN/telepty" \
  bash "$HITL" approve "$gid" --note "from the workspace" > "$T_TMP/approve.out" 2>&1
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$T_TMP/approve.out" >&2; fail "a workspace-layout approve exited $rc"; }
[ -f "$HITL_STATE_DIR/decided/$gid.json" ] || fail "the workspace approve did not move the gate to decided/"
grep -qxF "set-gate --sid sid-T114 --clear --now 2026-08-16T12:30:00Z" "$REG_LOG" \
  || { cat "$REG_LOG" >&2; fail "the workspace approve did not clear the gate axis"; }

# ── (C) neither layout is a fluke: the REPO tree (sibling dist/) still works ──
REPO_REG_LOG="$T_TMP/registry-repo.log"; : > "$REPO_REG_LOG"
REG_STUB="$T_TMP/registry-stub.sh"
cat > "$REG_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REPO_REG_LOG"
exit 0
EOF
chmod +x "$REG_STUB"
set +e
rid=$(RECONCILER_NOW="2026-08-16T13:00:00Z" TELEPTY="$STUB_BIN/telepty" \
  DISPATCH_REGISTRY_PY="$REG_STUB" bash "$REPO_ROOT/bin/hitl.sh" open \
  --source repo-tree --kind info --question "sibling dist still resolves" 2> "$T_TMP/repo.err")
rc=$?
set -e
[ "$rc" -eq 0 ] || { cat "$T_TMP/repo.err" >&2; fail "the repo-tree layout (sibling dist/) stopped working"; }
[ -f "$HITL_STATE_DIR/pending/$rid.json" ] || fail "the repo-tree open wrote no gate file"

echo "T114 PASS"
