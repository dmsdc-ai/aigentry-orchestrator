#!/usr/bin/env bash
# platform-unix.sh — macOS + Linux backend for platform.sh.
# Sourced by platform.sh when os_type ∈ {macos, linux}.

# ---------------------------------------------------------------------------
# Terminal spawn (Rule 26 migration of open-session.sh branches)
# ---------------------------------------------------------------------------

# platform::has_tmux_session — 0 if called from inside a tmux session (TMUX set).
platform::has_tmux_session() {
  [[ -n "${TMUX:-}" ]]
}

# platform::spawn_tmux_window <name> <cwd> <cmd>
# Wraps `tmux new-window`. Name becomes the window label, cwd the starting dir.
platform::spawn_tmux_window() {
  local name="${1:-}" cwd="${2:-}" cmd="${3:-}"
  [[ -z "$name" || -z "$cwd" || -z "$cmd" ]] && { echo "spawn_tmux_window: 3 args" >&2; return 2; }
  command -v tmux >/dev/null 2>&1 || { echo "tmux not installed" >&2; return 4; }
  tmux new-window -c "$cwd" -n "$name" "$cmd"
}

# platform::spawn_iterm_tab <cwd> <cmd>  (macOS-only, via AppleScript)
#
# #926: cwd and cmd arrive as `on run argv` and are NEVER interpolated into the script
# text. This site needed it more than any other spawn adapter, because the value here
# crosses TWO parsers: the AppleScript string literal, and then the shell that iTerm
# types the resulting text into. Quoting at the CALL SITE can only ever be correct for
# one grammar, and `printf %q` -- correct for the shell -- measures as wrong for this
# one in BOTH directions: `\ ` and `\;` are unknown AppleScript escapes that abort
# osascript with a syntax error (so an ordinary path containing a space is refused),
# while `\"` IS a valid AppleScript escape that unescapes back to a bare `"` and hands
# the payload to the shell intact. The quoted heredoc deletes the first parser;
# `quoted form of` (Standard Additions POSIX single-quote quoting) handles the second.
# Same `on run argv` idiom the three Warp AX helpers in workspace-host.sh already use.
#
# cmd stays UNQUOTED, for the same reason it does on every other spawn adapter: it is
# a command LINE (`telepty allow --id S --auto-restart claude --model ...`) that must
# word-split. Values carried inside it are the caller's to quote -- _wh_iterm_open %q's
# the sid before building it.
platform::spawn_iterm_tab() {
  local cwd="${1:-}" cmd="${2:-}"
  [[ -z "$cwd" || -z "$cmd" ]] && { echo "spawn_iterm_tab: 2 args" >&2; return 2; }
  [[ "$(platform::os_type)" == "macos" ]] || { echo "iTerm requires macOS" >&2; return 4; }
  osascript - "$cwd" "$cmd" >/dev/null 2>&1 <<'APPLESCRIPT'
on run argv
  set theCwd to item 1 of argv
  set theCmd to item 2 of argv
  tell application "iTerm"
    tell current window
      create tab with default profile
      tell current session
        write text "cd " & quoted form of theCwd & " && " & theCmd
      end tell
    end tell
  end tell
end run
APPLESCRIPT
}

# ---------------------------------------------------------------------------
# Host power: sleep prevention while a worker is live (#909)
# ---------------------------------------------------------------------------

# _platform_session_pid_canon <abs-path> — print <abs-path> with every directory
# and symlink hop resolved (POSIX `readlink` without -f, plus `cd -P`; no realpath,
# Bash 3.2). rc 1 on a loop, more than 40 hops, or an unreadable hop.
_platform_session_pid_canon() {
  local cur="$1" dir link hops=0
  while :; do
    dir="${cur%/*}"
    [[ -n "$dir" ]] || dir=/
    dir=$(cd -P -- "$dir" 2>/dev/null && pwd -P && printf x) || return 1
    dir="${dir%x}"; dir="${dir%$'\n'}"
    [[ "$dir" == / ]] && dir=""
    cur="$dir/${cur##*/}"
    [[ -L "$cur" ]] || break
    hops=$((hops + 1))
    [[ "$hops" -gt 40 ]] && return 1
    link=$(readlink "$cur" 2>/dev/null && printf x) || return 1
    link="${link%x}"; link="${link%$'\n'}"
    [[ -n "$link" ]] || return 1
    case "$link" in
      /*) cur="$link" ;;
      *) cur="$dir/$link" ;;
    esac
  done
  printf '%s\n' "$cur"
}

# _platform_session_pid_locale — print the first of C.UTF-8, en_US.UTF-8 that a child
# actually accepts: `locale charmap` run under it must exit 0 and print exactly
# UTF-8 with nothing else (stderr included), so a warning or a silent C fallback
# (measured: an unavailable locale renders the same bytes as C) fails it. Neither
# the env assignment nor a `locale -a` listing counts as proof. rc 1 when none
# passes or the utility is absent. Child-only; this shell's locale is untouched.
_platform_session_pid_locale() {
  local l cm
  for l in C.UTF-8 en_US.UTF-8; do
    cm=$(LC_ALL="$l" locale charmap 2>&1) || continue
    [[ "$cm" == UTF-8 ]] && { printf '%s\n' "$l"; return 0; }
  done
  return 1
}

# platform::session_pid <sid> [timeout_ms] — print the pid of the `telepty allow
# --id <sid>` process fronting a session. A spawn returns its ref before that
# process is necessarily up, so timeout_ms > 0 polls at 250ms; the default 0 is a
# single shot. One copy for open-session's sleep assertion and the reconciler sweep.
#
# The status is part of the answer (#909): a failure is never an absence.
#   rc 0 + pid   exactly one owner
#   rc 0 + ""    observed absence (ps ran, the locator resolved, nothing seen)
#   rc 2 + ""    UNKNOWN   (stderr: cause=locator|ps|candidate|sid)
#   rc 3 + ""    AMBIGUOUS (stderr: pids=...; never picks one)
# An owner is a ps row whose argv is, field-exact, `E allow --id <sid>` or
# `node E allow --id <sid>`, with E the existing TELEPTY locator: ${TELEPTY:-telepty}
# as given, as `command -v` resolves it, and canonicalised. Any other row with that
# triple at those offsets (another cli.js, a nottelepty, a junk pid) is UNKNOWN, not
# absent. The sid reaches awk via ENVIRON and string equality only, never a regex.
# ps runs as `ps -ww` (measured: procps truncates default/-w rows to COLUMNS or 132)
# under a verified UTF-8 locale (measured: C escapes non-ASCII argv on macOS and
# turns each byte into `?` on Ubuntu). No verified locale fails closed exactly like
# a failed ps (cause=ps). Escaped or `?` rows are never decoded or fuzzy-matched;
# awk splits fields under LC_ALL=C, so on ASCII space/tab bytes only. A sid with a
# byte outside printable ASCII may itself be rendered inexactly, so for such a sid
# "nothing seen" is UNKNOWN cause=sid, not absence.
platform::session_pid() {
  local sid="${1:-}" timeout_ms="${2:-0}" waited=0 pid
  local safe rc why pids out res tok p c loc=""
  [[ -z "$sid" ]] && return 0
  # Diagnostic copy only (the raw sid is what awk matches). The set is spelled out,
  # not [:alnum:] or A-Z ranges: both follow the locale and let non-ASCII through.
  safe="${sid//[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:@+=-]/?}"; safe="${safe:0:128}"
  case "$sid" in
    *[[:space:][:cntrl:]]*) echo "session_pid: UNKNOWN sid=$safe cause=sid" >&2; return 2 ;;
  esac
  while :; do
    rc=0 why="" pid="" pids="" p="" c=""
    tok="${TELEPTY:-telepty}"
    case "$tok" in
      *[[:space:][:cntrl:]]*) rc=2 why=locator ;;
      /*) p="$tok" ;;
      */*) rc=2 why=locator ;;
      *) p=$(command -v -- "$tok" 2>/dev/null) || { rc=2; why=locator; } ;;
    esac
    if [[ "$rc" -eq 0 ]]; then
      case "$p" in
        /*) ;;
        *) rc=2 why=locator ;;
      esac
    fi
    if [[ "$rc" -eq 0 ]] && [[ -f "$p" && -x "$p" ]] && c=$(_platform_session_pid_canon "$p") \
        && [[ -f "$c" && -x "$c" ]]; then
      case "$p$c" in
        *[[:space:][:cntrl:]]*) rc=2 why=locator ;;
      esac
    else
      [[ "$rc" -eq 0 ]] && { rc=2; why=locator; }
    fi
    [[ "$tok" == */* ]] && tok=""
    if [[ "$rc" -eq 0 ]]; then
      [[ -n "$loc" ]] || loc=$(_platform_session_pid_locale) || { loc=""; rc=2; why=ps; }
    fi
    if [[ "$rc" -eq 0 ]]; then
      out=$(LC_ALL="$loc" ps -ww -eo pid,command 2>/dev/null) || { rc=2; why=ps; }
    fi
    if [[ "$rc" -eq 0 ]]; then
      res=$(printf '%s\n' "$out" 2>/dev/null \
        | LC_ALL=C _SP_SID="$sid" _SP_E1="$tok" _SP_E2="$p" _SP_E3="$c" awk '
          BEGIN {
            sid = ENVIRON["_SP_SID"] ""; n = 0; cand = 0
            for (i = 1; i <= 3; i++) { e = ENVIRON["_SP_E" i] ""; if (e != "") E[e] = 1 }
          }
          {
            if (!(($1 "") ~ /^[1-9][0-9]*$/ && length($1) <= 10 && $1 + 0 <= 2147483647)) {
              for (i = 1; i + 2 <= NF; i++)
                if (($i "") == "allow" && ($(i + 1) "") == "--id" && ($(i + 2) "") == sid) { cand = 1; break }
              next
            }
            s1 = (($3 "") == "allow" && ($4 "") == "--id" && ($5 "") == sid)
            s2 = (($4 "") == "allow" && ($5 "") == "--id" && ($6 "") == sid)
            if (!s1 && !s2) next
            b = $2 ""; sub(/.*\//, "", b)
            if ((s1 && (($2 "") in E)) || (s2 && b == "node" && (($3 "") in E))) {
              if (!(($1 "") in O)) { O[$1 ""] = 1; n++; if (n <= 16) L = L (n > 1 ? "," : "") $1 }
            } else cand = 1
          }
          END {
            if (n >= 2) print "3 " L (n > 16 ? ",..." : "")
            else if (cand) print "2"
            else if (n == 1) print "0 " L
            else if (sid ~ /[^!-~]/) print "2 sid"
            else print "0"
          }' 2>/dev/null) || { rc=2; why=ps; }
    fi
    if [[ "$rc" -eq 0 ]]; then
      case "$res" in
        0) ;;
        "0 "*) pid="${res#0 }" ;;
        2) rc=2 why=candidate ;;
        "2 sid") rc=2 why=sid ;;
        "3 "*) rc=3 pids="${res#3 }" ;;
        *) rc=2 why=ps ;;
      esac
      case "$pid" in
        "") ;;
        0*|*[!0-9]*) pid="" rc=2 why=candidate ;;
      esac
    fi
    [[ "$rc" -eq 3 ]] && { echo "session_pid: AMBIGUOUS sid=$safe pids=$pids" >&2; return 3; }
    [[ -n "$pid" ]] && { printf '%s\n' "$pid"; return 0; }
    if [[ "$waited" -ge "$timeout_ms" ]]; then
      [[ "$rc" -eq 2 ]] && { echo "session_pid: UNKNOWN sid=$safe cause=$why" >&2; return 2; }
      return 0
    fi
    sleep 0.25
    waited=$((waited + 250))
  done
}

# platform::hold_awake <pid> <why> — hold a sleep assertion for exactly as long as
# <pid> lives, and no longer. Per-worker on purpose: a global or indefinite
# assertion is how a laptop stays awake for a week after one crashed spawner, so
# there is deliberately no code path here that outlives the process it was taken
# for — the OS releases it when that pid exits, including on a kill or a crash.
#
# macOS `caffeinate -i -w <pid>`: -i asserts against IDLE sleep only. It does NOT
# override a CLOSED LID — clamshell sleep is an SMC path no userspace assertion
# beats without an external display attached. That case is covered by the
# reconciler's LID_CLOSED alert (#909 item d), never by this function.
# Linux: systemd-inhibit --what=idle --mode=block, held by a waiter that exits with
# the worker. No systemd-inhibit ⇒ ANNOUNCED no-op (Rule 26): nothing is held and
# the line says so, rather than leaving a silent false guarantee behind.
#
# Seams so no test ever caffeinates the real host: AIGENTRY_CAFFEINATE,
# AIGENTRY_SYSTEMD_INHIBIT. Always returns 0 — a missing assertion must never gate
# a spawn.
platform::hold_awake() {
  local pid="${1:-}" why="${2:-aigentry-worker}" bin
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    echo "hold_awake: no live pid for '$why' — NO sleep assertion held" >&2
    return 0
  fi
  case "$(platform::os_type)" in
    macos)
      bin="${AIGENTRY_CAFFEINATE:-caffeinate}"
      if ! command -v "$bin" >/dev/null 2>&1; then
        echo "hold_awake: '$bin' not found — NO sleep assertion held for '$why'" >&2
        return 0
      fi
      nohup "$bin" -i -w "$pid" >/dev/null 2>&1 &
      echo "hold_awake: caffeinate -i -w $pid held for '$why' — releases when that pid exits; a CLOSED LID still sleeps this host" >&2
      ;;
    linux)
      bin="${AIGENTRY_SYSTEMD_INHIBIT:-systemd-inhibit}"
      if ! command -v "$bin" >/dev/null 2>&1; then
        echo "hold_awake: systemd-inhibit not found — NO sleep assertion held for '$why' (announced no-op)" >&2
        return 0
      fi
      # ponytail: 5s poll waiter, because systemd-inhibit follows a command rather
      # than a pid. Swap in a pidfd waiter if 5s of slack past worker-exit matters.
      nohup "$bin" --what=idle --who=aigentry --why="$why" --mode=block \
        sh -c "while kill -0 $pid 2>/dev/null; do sleep 5; done" >/dev/null 2>&1 &
      echo "hold_awake: systemd-inhibit idle-block held for '$why' (pid $pid) — releases when that pid exits" >&2
      ;;
    *)
      echo "hold_awake: no sleep-assertion primitive for this OS — NO assertion held for '$why'" >&2
      ;;
  esac
  return 0
}

# platform::host_power_state — print `awake`, `asleep` or `unknown`.
#
# "asleep" includes DarkWake, and that is the whole point: a DarkWake window is
# precisely when this host runs a cron tick, notices an idle worker, and pages the
# orchestrator about a session nobody is watching. Measured 2026-08-16 — ~70
# orchestrator turns burned across a 7.5h sleep, every one of them in one of these
# windows.
#
# macOS: the last power event in `pmset -g log`. The event name is the column
# between the timestamp and the TAB, which is why this parses on the tab rather
# than on whitespace — "Wake Requests" and "WakeDetails" are different events that
# both begin with the word Wake, and a whitespace split cannot tell them from a
# real "Wake". Costs ~1.2s (measured; pmset emits the whole log), so callers
# resolve it ONCE per tick and pass it down via AIGENTRY_HOST_POWER_STATE.
# Linux: no cheap equivalent — `unknown`, which every consumer treats as awake.
# UNKNOWN IS ALWAYS FAIL-OPEN: nothing may be suppressed on a state we do not know.
platform::host_power_state() {
  if [[ -n "${AIGENTRY_HOST_POWER_STATE:-}" ]]; then
    printf '%s\n' "$AIGENTRY_HOST_POWER_STATE"
    return 0
  fi
  local bin last
  case "$(platform::os_type)" in
    macos)
      bin="${AIGENTRY_PMSET:-pmset}"
      command -v "$bin" >/dev/null 2>&1 || { printf 'unknown\n'; return 0; }
      last=$("$bin" -g log 2>/dev/null | awk -F'\t' '
        $1 ~ /^[0-9][0-9][0-9][0-9]-/ {
          n = $1
          sub(/^[^ ]+ [^ ]+ [^ ]+ +/, "", n)
          gsub(/[ \t]+$/, "", n)
          if (n == "Sleep" || n == "DarkWake" || n == "Wake") last = n
        }
        END { print last }')
      case "$last" in
        Sleep|DarkWake) printf 'asleep\n' ;;
        Wake)           printf 'awake\n' ;;
        *)              printf 'unknown\n' ;;
      esac
      ;;
    *)
      printf 'unknown\n'
      ;;
  esac
}

# platform::lid_closed — 0 closed, 1 open, 2 unknown.
#
# A closed lid is the one sleep cause NO userspace assertion overrides: without an
# external display attached, clamshell sleep is an SMC path `caffeinate -i` loses to.
# So this is not an actuator, it is a page — the operator is the only fix.
#
# macOS: ioreg AppleClamshellState (~14ms measured, cheap enough per tick).
# Linux: /proc/acpi/button/lid/*/state where the kernel exposes it, else unknown.
# NOT MEASURED on Linux — no Linux host was available for #909; the path is the
# documented one and degrades to `unknown` (which never pages) when absent.
platform::lid_closed() {
  local bin state
  case "$(platform::os_type)" in
    macos)
      bin="${AIGENTRY_IOREG:-ioreg}"
      command -v "$bin" >/dev/null 2>&1 || return 2
      state=$("$bin" -r -k AppleClamshellState -d 4 2>/dev/null \
        | awk -F'= *' '/"AppleClamshellState"/ {print $2; exit}' | tr -d ' "')
      case "$state" in
        Yes) return 0 ;;
        No)  return 1 ;;
        *)   return 2 ;;
      esac
      ;;
    linux)
      state=$(cat /proc/acpi/button/lid/*/state 2>/dev/null | head -1)
      case "$state" in
        *closed) return 0 ;;
        *open)   return 1 ;;
        *)       return 2 ;;
      esac
      ;;
    *)
      return 2
      ;;
  esac
}
