#!/usr/bin/env bash
# prune-status.sh — coverage for the cmux-adaptor sidebar-keeping methods
# (SPEC 2026-06-06-cmux-adaptor-prune-status §6). SAFETY: operates on THROWAWAY
# workspaces only (title prefix `zz-throwaway-`, cwd under the role-sandbox), and
# every prune call passes a live_ids set that includes EVERY real workspace title
# so no live session can ever be a candidate. Cleans up all workspaces it creates.
#
# Skips gracefully (exit 0) when cmux is unavailable (CI / headless).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

THROW_PREFIX="zz-throwaway-"
SANDBOX_DIR="${AIGENTRY_ROLE_SANDBOX_DIR:-$HOME/.aigentry/role-sandbox}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LIB="$(cd "$SCRIPT_DIR/../../bin/lib" && pwd -P)/workspace-host.sh"

# Per-run ledger (never touch the real dispatch-state ledger).
export AIGENTRY_CMUX_ORPHAN_LEDGER="$(mktemp -t cmux-orphan-ledger.XXXXXX)"
TMP_CWD="$(mktemp -d "$SANDBOX_DIR/zz-throwaway-test.XXXXXX" 2>/dev/null || mktemp -d)"
NONOWNED_CWD="$(mktemp -d -t zz-throwaway-nonowned.XXXXXX)"

pass=0; fail=0
ok()   { printf 'ok   - %s\n' "$1"; pass=$((pass+1)); }
nok()  { printf 'FAIL - %s\n' "$1"; fail=$((fail+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (want=$3 got=$2)"; fi; }

# --- skip-if-no-cmux ----------------------------------------------------------
if ! command -v cmux >/dev/null 2>&1; then
  echo "1..0 # SKIP cmux not on PATH (CI/headless)"; exit 0
fi

# shellcheck source=/dev/null
. "$LIB"

ref_by_title() { cmux --json list-workspaces 2>/dev/null \
  | jq -r --arg t "$1" '.workspaces[] | select(.title==$t) | .ref' 2>/dev/null | head -1; }

# all real (non-throwaway) titles, comma-joined — the protective live set.
real_live_ids() { cmux --json list-workspaces 2>/dev/null \
  | jq -r '.workspaces[].title // empty' 2>/dev/null \
  | grep -v "^${THROW_PREFIX}" | sort -u | tr '\n' ',' | sed 's/,$//'; }

# Remember the originally-focused workspace so cleanup can restore the user's view.
ORIG_SEL=$(cmux --json list-workspaces 2>/dev/null | jq -r '.workspaces[] | select(.selected==true) | .ref' 2>/dev/null | head -1)

CREATED_REFS=()
make_throwaway() { # <title> <cwd> -> echoes ref
  local title="$1" cwd="$2" before after ref
  before=$(cmux --json list-workspaces 2>/dev/null | jq -r '.workspaces[].ref' | sort)
  cmux new-workspace --cwd "$cwd" >/dev/null 2>&1
  sleep 0.4
  after=$(cmux --json list-workspaces 2>/dev/null | jq -r '.workspaces[].ref' | sort)
  ref=$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -1)
  [ -z "$ref" ] && { echo ""; return 0; }
  cmux rename-workspace --workspace "$ref" "$title" >/dev/null 2>&1
  sleep 0.2
  CREATED_REFS+=("$ref")
  echo "$ref"
}

cleanup() {
  # Prefix-based teardown: close EVERY zz-throwaway-* workspace (the prefix is
  # test-reserved). Robust against make_throwaway running in a subshell (its
  # CREATED_REFS append never reaches the parent) and self-heals interrupted runs.
  local ref title
  while IFS=$'\t' read -r ref title; do
    case "$title" in "${THROW_PREFIX}"*) cmux close-workspace --workspace "$ref" >/dev/null 2>&1 || true ;; esac
  done < <(cmux --json list-workspaces 2>/dev/null | jq -r '.workspaces[] | [.ref, (.title // "")] | @tsv' 2>/dev/null)
  rm -rf "$TMP_CWD" "$NONOWNED_CWD" 2>/dev/null || true
  rm -f "$AIGENTRY_CMUX_ORPHAN_LEDGER" 2>/dev/null || true
  [ -n "$ORIG_SEL" ] && cmux select-workspace --workspace "$ORIG_SEL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# === Test 1: prune seen-twice + ownership gate ================================
T1="${THROW_PREFIX}owned-$$"
ref1=$(make_throwaway "$T1" "$TMP_CWD")
if [ -z "$ref1" ]; then
  nok "could not create throwaway owned workspace — aborting prune tests"
else
  LIVE="$(real_live_ids)" # excludes zz-throwaway-* → T1 is a candidate
  # first call: seen-once → records ledger, does NOT close.
  c1=$(DRY_RUN=0 wh_prune_orphans "$LIVE" "")
  chk "first prune does not close (seen-once)" "$c1" "0"
  chk "workspace still present after first prune" "$(ref_by_title "$T1")" "$ref1"
  # second call: seen-twice → closes.
  c2=$(DRY_RUN=0 wh_prune_orphans "$LIVE" "")
  chk "second prune closes one (seen-twice)" "$c2" "1"
  chk "workspace gone after second prune" "$(ref_by_title "$T1")" ""
fi

# === Test 2: live_ids protects a candidate (never prune a live title) =========
T2="${THROW_PREFIX}live-$$"
ref2=$(make_throwaway "$T2" "$TMP_CWD")
if [ -n "$ref2" ]; then
  LIVE2="$(real_live_ids),$T2" # T2 declared live → must never be closed
  DRY_RUN=0 wh_prune_orphans "$LIVE2" "" >/dev/null
  DRY_RUN=0 wh_prune_orphans "$LIVE2" "" >/dev/null
  chk "live-listed title survives two prunes" "$(ref_by_title "$T2")" "$ref2"
fi

# === Test 3: ownership gate — non-sandbox cwd never pruned ====================
T3="${THROW_PREFIX}nonowned-$$"
ref3=$(make_throwaway "$T3" "$NONOWNED_CWD")
if [ -n "$ref3" ]; then
  LIVE3="$(real_live_ids)" # T3 excluded from live, but cwd NOT under sandbox
  DRY_RUN=0 wh_prune_orphans "$LIVE3" "" >/dev/null
  DRY_RUN=0 wh_prune_orphans "$LIVE3" "" >/dev/null
  chk "non-sandbox cwd survives (ownership gate)" "$(ref_by_title "$T3")" "$ref3"
fi

# === Test 4: dry-run never closes ============================================
T4="${THROW_PREFIX}dry-$$"
ref4=$(make_throwaway "$T4" "$TMP_CWD")
if [ -n "$ref4" ]; then
  LIVE4="$(real_live_ids)"
  DRY_RUN=1 wh_prune_orphans "$LIVE4" "" >/dev/null
  DRY_RUN=1 wh_prune_orphans "$LIVE4" "" >/dev/null
  DRY_RUN=1 wh_prune_orphans "$LIVE4" "" >/dev/null
  chk "dry-run survives three prunes" "$(ref_by_title "$T4")" "$ref4"
fi

# === Test 5: status push + F8 distinct-key isolation =========================
T5="${THROW_PREFIX}status-$$"
ref5=$(make_throwaway "$T5" "$TMP_CWD")
if [ -n "$ref5" ]; then
  wh_set_status "$ref5" working
  got=$(cmux list-status --workspace "$ref5" 2>/dev/null | sed -n 's/^aigentry=\([^ ]*\).*/\1/p' | head -1)
  chk "set-status working shows aigentry pill" "$got" "working"
  wh_set_status "$ref5" idle
  got=$(cmux list-status --workspace "$ref5" 2>/dev/null | sed -n 's/^aigentry=\([^ ]*\).*/\1/p' | head -1)
  chk "set-status idle updates aigentry pill" "$got" "idle"
  wh_clear_status "$ref5"
  got=$(cmux list-status --workspace "$ref5" 2>/dev/null | sed -n 's/^aigentry=/&/p' | head -1)
  chk "clear-status removes aigentry pill" "$got" ""
fi

# === Test 6: F9 alive probe (stdout-based, F7) ===============================
T6="${THROW_PREFIX}alive-$$"
ref6=$(make_throwaway "$T6" "$TMP_CWD")
if [ -n "$ref6" ]; then
  if wh_alive "$ref6"; then ok "wh_alive true for live ref"; else nok "wh_alive true for live ref"; fi
fi
if wh_alive "00000000-DEAD-BEEF-0000-000000000000"; then
  nok "wh_alive false for bogus handle"
else
  ok "wh_alive false for bogus handle"
fi

# === Test 7: headless adapter isolation (all new fns no-op, return 0) ========
hrc=0
(
  export AIGENTRY_WORKSPACE_HOST=headless
  WORKSPACE_HOST_SH_LOADED=0
  . "$LIB"
  hp=$(wh_prune_orphans "x" ""); [ "$hp" = "0" ] || exit 11
  wh_set_status "x" working || exit 12
  wh_clear_status "x" || exit 13
  exit 0
) || hrc=$?
chk "headless adapter: new fns no-op return 0" "$hrc" "0"

echo "1..$((pass+fail))"
echo "# pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
