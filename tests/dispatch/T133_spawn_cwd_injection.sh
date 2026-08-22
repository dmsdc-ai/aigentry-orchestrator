#!/usr/bin/env bash
# T133 (#926) — a hostile --cwd must never reach a shell as CODE, on any spawn arm.
#
# THE DEFECT ([MEDIUM] G, docs/reports/2026-07-02-ecosystem-deep-analysis.md:87).
# `bin/dispatch.sh --spawn-and-dispatch --cwd P` hands P, unfiltered, to five places
# that put it into shell text. boot-prepare.mjs:443 is NOT a filter for this: it
# rejects relative paths, `..` and NUL only, so `/tmp/x; touch /tmp/pwned` passes it,
# and a boot-prepare failure is a stderr WARNING plus legacy spawn (dispatch/cli.ts
# :780-800), not a refusal. Measured RED against origin/main 1088ad7 — every part
# below created its marker file.
#
# WHAT THIS GUARD ASSERTS, and why it is not "the spawn is refused". The injection
# fix does not change what a cwd MEANS — `mkdir -p` on a nonexistent cwd is the
# shell's behaviour, reproduced deliberately (open-session/cli.ts:286), and turning
# it into a refusal is a separate ticket (silent-mkdir-on-typo). So a hostile cwd
# still spawns a session; it spawns it in a directory whose NAME is the payload.
# The contract is the payload never EXECUTES: no marker file, on any arm, for any of
# the three shell forms that can carry one.
#
# THE FIVE SITES, one part each:
#   A  src/session/open-session/cli.ts   evalCwd — was `eval cwd="$1"` in bash
#   B  bin/lib/workspace-host.sh:333     _wh_cmux_open      (the default arm)
#   C  src/session/open-session/legacy-spawn.ts  the AIGENTRY_WH_LEGACY_SPAWN=1 arm
#   D  bin/lib/workspace-host.sh:679     _wh_warp_open      (the TOML `command =`)
#   E  bin/lib/workspace-host.sh:752     _wh_aterm_open     (aterm --cmd)
# A/B/C go through the real CLI; D/E drive wh_open directly, because Warp and aterm
# have no hermetic spawn — what is executed there is the command STRING they build,
# so the guard builds it through the real function and runs it the way the terminal
# would.
#
# HERMETIC: a fake cmux/aterm that EXECUTES the command string exactly as the real
# ones do (both type it into a shell — see workspace-host.sh:328), a stub `telepty`
# that only logs, a temp HOME, and markers under $T_TMP. NO live daemon 3848, no
# real terminal, no real session. A stub that merely LOGGED the string would pass
# against the vulnerable code, which is the whole reason it executes instead.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

OPEN="$REPO_ROOT/bin/open-session.sh"
WH_CLI="$REPO_ROOT/bin/wh-cli.sh"
[ -x "$OPEN" ]   || { echo "T133 SKIP — bin/open-session.sh missing"; exit 0; }
[ -x "$WH_CLI" ] || { echo "T133 SKIP — bin/wh-cli.sh missing"; exit 0; }

fail() { echo "FAIL[T133]: $*" >&2; exit 1; }

MARK="$T_TMP/pwned"          # markers are $MARK-<form>; none may ever exist
REF="workspace:926"

# The three shell forms that carry a payload. `$( )` and backticks also prove the
# eval site specifically: they execute during EXPANSION, before any wrapper is built.
payload_semi="$T_TMP/target; touch $MARK-semi"
payload_dollar="$T_TMP/target\$(touch $MARK-dollar)"
payload_tick="$T_TMP/target\`touch $MARK-tick\`"
mkdir -p "$T_TMP/target"

# A glob loop, not `ls | tr`: lib.sh runs under `pipefail`, and a no-match `ls`
# would abort the whole guard on its FIRST clean arm — passing by dying.
markers_found() {
  local f out=""
  for f in "$MARK"-*; do [ -e "$f" ] && out="$out$f "; done
  printf '%s' "$out"
}
assert_clean() {
  local where="$1" found; found=$(markers_found)
  [ -z "$found" ] && return 0
  rm -f "$MARK"-* 2>/dev/null || true
  fail "$where — the injected command RAN. marker(s) created: $found"
}

# ── a telepty that only records, so `exec telepty allow` terminates the wrapper ──
cat > "$STUB_BIN/telepty-allow-probe" <<'EOF'
#!/usr/bin/env bash
echo "telepty $* pwd=$PWD" >> "${T133_TELEPTY_LOG:-/dev/null}"
EOF
chmod +x "$STUB_BIN/telepty-allow-probe"

# ── a cmux that EXECUTES --command the way the real one does (text + Enter) ──────
CMUX_STUB="$T_TMP/cmux-stub"
cat > "$CMUX_STUB" <<'EOF'
#!/usr/bin/env bash
ref="${CMUX_STUB_REF:-workspace:926}"; log="${CMUX_STUB_LOG:?}"
verb="$1"; shift
echo "$verb $*" >> "$log"
case "$verb" in
  new-workspace)
    cmd=""
    while [ $# -gt 0 ]; do
      case "$1" in --command) cmd="$2"; shift 2;; *) shift;; esac
    done
    # Real cmux types this into the workspace shell. So does this stub — a stub that
    # only logged would pass against the vulnerable code.
    printf '%s\n' "COMMAND_STRING $cmd" >> "$log"
    ( PATH="$T133_PROBE_DIR:$PATH"; bash -c "$cmd" >>"$log" 2>&1 || true )
    echo "OK $ref"
    ;;
  list-workspaces)  echo "  $ref  faketitle" ;;
  surface-health)   echo "surface:9  type=terminal in_window=false" ;;
  read-screen)      echo "  claude prompt rendered" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$CMUX_STUB"

# `telepty` inside the wrapper must be the probe, not the suite's registry stub.
PROBE_DIR="$T_TMP/probe"; mkdir -p "$PROBE_DIR"
cp "$STUB_BIN/telepty-allow-probe" "$PROBE_DIR/telepty"
export T133_PROBE_DIR="$PROBE_DIR"
export T133_TELEPTY_LOG="$T_TMP/telepty.log"

# run_open <label> <cwd> [extra env…] → sets RC, ERRTXT, STUBLOG
run_open() {
  local label="$1" cwd="$2"; shift 2
  STUBLOG="$T_TMP/$label.cmux.log"; : > "$STUBLOG"
  local home="$T_TMP/home-$label"; mkdir -p "$home"
  local errf="$T_TMP/$label.err"
  set +e
  env "$@" \
    HOME="$home" \
    CTX_ROUTER_PATH=/nonexistent \
    CMUX_WORKSPACE_ID=t133 \
    CMUX="$CMUX_STUB" \
    CMUX_STUB_REF="$REF" CMUX_STUB_LOG="$STUBLOG" \
    CMUX_READY_TIMEOUT_MS=200 CMUX_READY_INTERVAL_MS=10 \
    AIGENTRY_WORKSPACE_HOST=cmux \
    AIGENTRY_CONFIG="$T_TMP/no-such-config.json" \
    T133_PROBE_DIR="$PROBE_DIR" T133_TELEPTY_LOG="$T133_TELEPTY_LOG" \
    "$OPEN" --track t133 --name "$label" --cwd "$cwd" --cli claude >/dev/null 2>"$errf"
  RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
}

# --- A + B) the default arm: evalCwd, then _wh_cmux_open ---------------------------
# RED on origin/main: form `semi` created the marker TWICE over — once in the eval
# (before a wrapper was even built) and once in the wrapper cmux typed into a shell.
for form in semi dollar tick; do
  eval "cwd=\$payload_$form"
  run_open "wh-$form" "$cwd" AIGENTRY_WH_LEGACY_SPAWN=
  assert_clean "A/B ($form, default wh_open arm, rc=$RC)"
done

# …and the payload survived AS A PATH rather than as code: the cwd cmux was asked
# for is the literal string, one argv element, unexpanded. Containment, not absence.
grep -qF -- "new-workspace --cwd $T_TMP/target; touch $MARK-semi" "$T_TMP/wh-semi.cmux.log" \
  || fail "A/B: the hostile cwd did not reach cmux as one literal argv element. log:
$(cat "$T_TMP/wh-semi.cmux.log")"

# --- C) the AIGENTRY_WH_LEGACY_SPAWN=1 rollback arm --------------------------------
# The lever exists to bypass wh_open, so it carries its OWN copy of the wrapper
# (legacy-spawn.ts) and its own copy of the hole. Fixing one arm and not the other
# leaves the vector reachable by an `export`.
for form in semi dollar tick; do
  eval "cwd=\$payload_$form"
  run_open "legacy-$form" "$cwd" AIGENTRY_WH_LEGACY_SPAWN=1
  assert_clean "C ($form, AIGENTRY_WH_LEGACY_SPAWN=1 inline arm, rc=$RC)"
done

# --- D) _wh_warp_open — the wrapper it writes into the tab_config TOML -------------
# Warp runs `command = '<wrapper>'` as a shell command line in the new surface. There
# is no hermetic Warp, so the seam is the OPENER: `_wh_warp_deeplink_open` shells out
# to open(1)/xdg-open, and a fake one does exactly what Warp does — read the TOML,
# run its command line — plus keeps a copy, because _wh_warp_open GCs the TOML the
# moment its ready-gate times out (which it always does here: no Warp is running).
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
WARP_TC="$T_TMP/warp-tc"
WARP_OPENER="$T_TMP/warpbin"; mkdir -p "$WARP_OPENER"
cat > "$WARP_OPENER/open" <<'EOF'
#!/usr/bin/env bash
# stand-in for the Warp deeplink handoff: warp://tab_config/<name> → run the config.
name="${1##*/}"
toml="$AIGENTRY_WARP_TAB_CONFIG_DIR/$name.toml"
[ -f "$toml" ] || exit 1
cp "$toml" "$T133_WARP_KEEP"
cmd=$(sed -n "s/^command = '\(.*\)'$/\1/p" "$toml")
( PATH="$T133_PROBE_DIR:$PATH"; bash -c "$cmd" >/dev/null 2>&1 || true )
exit 0
EOF
cp "$WARP_OPENER/open" "$WARP_OPENER/xdg-open"
chmod +x "$WARP_OPENER/open" "$WARP_OPENER/xdg-open"

for form in semi dollar tick; do
  eval "cwd=\$payload_$form"
  rm -rf "$WARP_TC"; mkdir -p "$WARP_TC"
  KEEP="$T_TMP/warp-$form.toml"; : > "$KEEP"
  env HOME="$T_TMP/home-warp" \
      AIGENTRY_WARP_TAB_CONFIG_DIR="$WARP_TC" \
      AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surf" \
      AIGENTRY_WORKSPACE_HOST=warp \
      WARP_READY_TIMEOUT_MS=50 WARP_READY_INTERVAL_MS=10 \
      T133_PROBE_DIR="$PROBE_DIR" T133_WARP_KEEP="$KEEP" \
      PATH="$WARP_OPENER:$PROBE_DIR:/usr/bin:/bin" \
      bash -c '. "$1"; wh_open "$2" "$3" "claude --x"' _ "$LIB" t133-warp "$cwd" \
      >/dev/null 2>&1 || true
  W=$(sed -n "s/^command = '\(.*\)'$/\1/p" "$KEEP" 2>/dev/null || true)
  [ -n "$W" ] || fail "D ($form): _wh_warp_open wrote no tab_config command line — the seam did not fire"
  assert_clean "D ($form, _wh_warp_open tab_config wrapper: $W)"
done

# --- E) _wh_aterm_open — the string handed to `aterm new-session --cmd` ------------
ATERM_STUB="$T_TMP/atermbin"; mkdir -p "$ATERM_STUB"
cat > "$ATERM_STUB/aterm" <<'EOF'
#!/usr/bin/env bash
log="${ATERM_STUB_LOG:?}"
echo "aterm $*" >> "$log"
cmd=""
while [ $# -gt 0 ]; do case "$1" in --cmd) cmd="$2"; shift 2;; *) shift;; esac; done
# aterm --cmd is shell text, same as cmux --command.
( PATH="$T133_PROBE_DIR:$PATH"; bash -c "$cmd" >>"$log" 2>&1 || true )
exit 0
EOF
chmod +x "$ATERM_STUB/aterm"
for form in semi dollar tick; do
  eval "cwd=\$payload_$form"
  env HOME="$T_TMP/home-aterm" \
      AIGENTRY_WORKSPACE_HOST=aterm \
      ATERM_STUB_LOG="$T_TMP/aterm.log" \
      T133_PROBE_DIR="$PROBE_DIR" \
      PATH="$ATERM_STUB:$PROBE_DIR:/usr/bin:/bin" \
      bash -c '. "$1"; wh_open "$2" "$3" "claude --x"' _ "$LIB" t133-aterm "$cwd" \
      >/dev/null 2>&1 || true
  assert_clean "E ($form, _wh_aterm_open --cmd)"
done

# --- F) the happy path still spawns, with the cwd intact --------------------------
# Without this the whole guard would pass against an implementation that refuses
# every cwd — "nothing executed" is trivially true when nothing runs at all.
OKCWD="$T_TMP/plain cwd"      # a space, because %q-quoting is what makes it survive
mkdir -p "$OKCWD"
: > "$T133_TELEPTY_LOG"
run_open ok "$OKCWD" AIGENTRY_WH_LEGACY_SPAWN=
[ "$RC" -eq 0 ] || fail "F: a legitimate cwd exited $RC, want 0 (err: $ERRTXT)"
grep -qF "pwd=$OKCWD" "$T133_TELEPTY_LOG" \
  || fail "F: telepty allow did not start in the requested cwd. log:
$(cat "$T133_TELEPTY_LOG")"
grep -qF -- "exec telepty allow --id \"\$2\" --auto-restart claude " "$T_TMP/ok.cmux.log" \
  || fail "F: the telepty-allow wrapper argv changed. log:
$(cat "$T_TMP/ok.cmux.log")"
# The space in $OKCWD survived as ONE argv element — %q-quoted, not word-split.
grep -qF -- "_ $(printf '%q' "$OKCWD") t133-ok" "$T_TMP/ok.cmux.log" \
  || fail "F: the cwd was not %q-quoted onto argv. log:
$(cat "$T_TMP/ok.cmux.log")"

echo "T133 PASS sites=5 forms=semi/dollar/tick arms=wh/legacy/warp/aterm happy=cwd-with-space"
