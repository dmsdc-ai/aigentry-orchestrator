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
# The FOURTH form, and the one the first pass missed. Several arms wrap the value in
# SINGLE QUOTES (`cd '$cwd'`), which makes `;`, `$( )` and backticks inert — those
# three prove nothing there. An apostrophe closes the quote and every one of them
# opens. Any guard for this defect that omits it measures only the easy half.
payload_quote="$T_TMP/target'; touch $MARK-quote; :'"
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
# The headless and fallback-daemon arms exec $cli_cmd DIRECTLY — they never wrap
# `telepty allow` — so the cli itself has to be probeable or G5 cannot see their pwd.
cat > "$PROBE_DIR/claude" <<'EOF'
#!/usr/bin/env bash
echo "claude $* pwd=$PWD" >> "${T133_TELEPTY_LOG:-/dev/null}"
EOF
chmod +x "$PROBE_DIR/claude"
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
for form in semi dollar tick quote; do
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
for form in semi dollar tick quote; do
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

for form in semi dollar tick quote; do
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
for form in semi dollar tick quote; do
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

# --- G) the four remaining spawn arms in workspace-host.sh -------------------------
# ADDED after the first pass shipped with five sites: the enumeration was short.
# _wh_fallback_spawn is the reason it mattered — it is where EVERY other adapter
# lands when its terminal CLI is missing, so a fix that stopped at cmux/warp/aterm
# was bypassable by not having cmux installed.
#
# Each arm is driven through the REAL wh_open with its terminal CLI stubbed by an
# executor — the stub runs what it is handed, exactly as tmux/wezterm/telepty do,
# because a stub that only logged would pass against the vulnerable code.
EXEC_BIN="$T_TMP/execbin"; mkdir -p "$EXEC_BIN"

# tmux: `tmux new-window -c <cwd> -n <name> <cmd>` runs <cmd> through a shell.
cat > "$EXEC_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
echo "tmux $*" >> "${G_LOG:?}"
# Real tmux STARTS the command in -c's directory; so does this stub, or G5 would
# measure the harness instead of the adapter.
cmd=""; start=""
while [ $# -gt 0 ]; do case "$1" in -c) start="$2"; shift 2;; -n) shift 2;; new-window) shift;; *) cmd="$1"; shift;; esac; done
( cd "$start" 2>/dev/null || true; PATH="$T133_PROBE_DIR:$PATH"; bash -c "$cmd" >>"$G_LOG" 2>&1 || true )
exit 0
EOF
# wezterm: `wezterm cli spawn --cwd C -- prog args…` EXECS argv, no shell.
cat > "$EXEC_BIN/wezterm" <<'EOF'
#!/usr/bin/env bash
echo "wezterm $*" >> "${G_LOG:?}"
while [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; break; }; shift; done
[ $# -gt 0 ] && ( PATH="$T133_PROBE_DIR:$PATH"; "$@" >>"$G_LOG" 2>&1 || true )
exit 0
EOF
# telepty spawn --id S -- prog args… — also EXECS argv (the daemon-PTY arm).
cat > "$EXEC_BIN/telepty" <<'EOF'
#!/usr/bin/env bash
echo "telepty $*" >> "${G_LOG:?}"
if [ "${1:-}" = "spawn" ]; then
  while [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; break; }; shift; done
  [ $# -gt 0 ] && ( PATH="$T133_PROBE_DIR:$PATH"; "$@" >>"$G_LOG" 2>&1 || true )
fi
exit 0
EOF
chmod +x "$EXEC_BIN"/tmux "$EXEC_BIN"/wezterm "$EXEC_BIN"/telepty
PLATFORM="$REPO_ROOT/bin/lib/platform.sh"

# g_open <adapter> <cwd> [extra env…] — wh_open through the real lib + platform.sh.
g_open() {
  local adapter="$1" cwd="$2"; shift 2
  : > "$T_TMP/g.log"
  env HOME="$T_TMP/home-g" \
      AIGENTRY_WORKSPACE_HOST="$adapter" \
      PLATFORM_OVERRIDE=macos \
      G_LOG="$T_TMP/g.log" T133_PROBE_DIR="$PROBE_DIR" \
      PATH="$EXEC_BIN:$PROBE_DIR:/usr/bin:/bin" \
      "$@" \
      bash -c '. "$1"; . "$2"; wh_open "$3" "$4" "claude --x"' _ "$PLATFORM" "$LIB" t133-g "$cwd" \
      >/dev/null 2>&1 || true
}

for form in semi dollar tick quote; do
  eval "cwd=\$payload_$form"

  # G1 — _wh_tmux_open (Tier 1, tmux present).
  g_open tmux "$cwd" TMUX=/tmp/fake-tmux-socket
  assert_clean "G1 ($form, _wh_tmux_open)"

  # G2 — _wh_wezterm_open (Tier 1, wezterm present).
  g_open wezterm "$cwd"
  assert_clean "G2 ($form, _wh_wezterm_open)"

  # G3 — _wh_headless_open (Tier 2, the daemon-PTY arm).
  g_open headless "$cwd"
  assert_clean "G3 ($form, _wh_headless_open)"

  # G4 — _wh_fallback_spawn, BOTH branches. This is the arm every other adapter
  # falls back to, so it is reached the way a user reaches it: ask for an adapter
  # whose CLI is absent. aterm is gone from PATH here, so wh_open lands in the
  # fallback — tmux branch when TMUX is set, daemon branch when it is not.
  rm -f "$EXEC_BIN/aterm" 2>/dev/null || true
  g_open aterm "$cwd" TMUX=/tmp/fake-tmux-socket
  assert_clean "G4-tmux ($form, _wh_fallback_spawn tmux branch)"
  g_open aterm "$cwd"
  assert_clean "G4-daemon ($form, _wh_fallback_spawn daemon branch)"
done

# G6 — the tmux arms take a hostile SID, not a hostile cwd.
# Measured, not assumed: platform::spawn_tmux_window takes cwd as its OWN argument
# and hands it to `tmux new-window -c "$cwd"` — argv, never shell text — so no cwd
# payload of any form can reach a shell through _wh_tmux_open or the fallback's tmux
# branch. What DOES reach one is the sid, which those lines wrapped in single quotes
# (`--id '$sid'`); an apostrophe in it opens the same hole. sid is `<track>-<name>`
# from the same dispatch argv as --cwd, so it is exactly as caller-controlled.
HOSTILE_SID="t133'; touch $MARK-sid; :'"
for adapter_env in "tmux" "aterm"; do   # _wh_tmux_open, then the fallback's tmux branch
  [ "$adapter_env" = aterm ] && rm -f "$EXEC_BIN/aterm" 2>/dev/null
  : > "$T_TMP/g.log"
  env HOME="$T_TMP/home-g" AIGENTRY_WORKSPACE_HOST="$adapter_env" PLATFORM_OVERRIDE=macos \
      TMUX=/tmp/fake-tmux-socket \
      G_LOG="$T_TMP/g.log" T133_PROBE_DIR="$PROBE_DIR" \
      PATH="$EXEC_BIN:$PROBE_DIR:/usr/bin:/bin" \
      bash -c '. "$1"; . "$2"; wh_open "$3" "$4" "claude --x"' _ "$PLATFORM" "$LIB" \
      "$HOSTILE_SID" "$T_TMP/target" >/dev/null 2>&1 || true
  assert_clean "G6 (hostile sid, $adapter_env tmux branch)"
done

# G5 — the control: these arms really DID spawn, so G1-G4 are not passing by
# reaching nothing. A legitimate cwd with a space lands as the process's real pwd.
GCWD="$T_TMP/g plain"; mkdir -p "$GCWD"
for adapter in tmux wezterm headless; do
  extra=(); [ "$adapter" = tmux ] && extra=(TMUX=/tmp/fake-tmux-socket)
  : > "$T133_TELEPTY_LOG"
  g_open "$adapter" "$GCWD" "${extra[@]+"${extra[@]}"}"
  grep -qF "pwd=$GCWD" "$T_TMP/g.log" "$T133_TELEPTY_LOG" 2>/dev/null \
    || fail "G5/$adapter: the arm did not start in the requested cwd — G1-G4 may be
passing by spawning nothing. log:
$(cat "$T_TMP/g.log")"
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

echo "T133 PASS sites=10 forms=semi/dollar/tick/quote+hostile-sid arms=wh/legacy/warp/aterm/tmux/wezterm/headless/fallback-x2 happy=cwd-with-space"
