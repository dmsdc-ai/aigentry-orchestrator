#!/usr/bin/env bash
# T1304 — task 1304 ADR phase A, through the Workspace Host layer and its door
# bin/wh-cli.sh: Warp shows, tmux controls; the adapter follows the session; read_screen.
#
#   A) the tab config Warp is handed is the DOCUMENTED schema (top-level name/title, one
#      [[panes]] with id, type="terminal", directory, commands), its values TOML basic
#      strings that survive a cwd with a space, an apostrophe, a double quote, a
#      backslash and Hangul; commands[0], unescaped and run by bash exactly as Warp's
#      shell would, invokes `tmux new-session -A -s <name> -c <cwd> <wrapper>` with that
#      EXACT argv, and the wrapper starts `telepty allow` for this sid in that cwd.
#   B) forced warp with NO tmux fails at once: exit 2, one line naming tmux and
#      AIGENTRY_WORKSPACE_HOST, and nothing left behind (no tab config, no record, the
#      opener never called).
#   C) a session opened as warp is closed by `wh-cli.sh close-for-sid <sid>` with NO
#      environment override while a cmux is on PATH: the warp close ran (tmux
#      kill-session; tab config and record removed) and cmux was never touched.
#   D) read_screen: warp and tmux read through `tmux capture-pane -p`, by sid and by
#      handle; an adapter without a reader answers 20 with one labelled line.
#   E) warp alive / list / prune on tmux; headless alive is INDETERMINATE→alive.
#   F) detection: TERM_PROGRAM=WarpTerminal selects warp for spawn; the lifecycle auto
#      rule still never picks warp without a record.
#   G) the door loads platform.sh: a forced tmux open THROUGH wh-cli.sh works and returns
#      the window id, whose record makes the later verbs address that window.
#
# Hermetic: tmux, open/xdg-open, osascript and cmux are stubs on PATH; telepty is the
# suite stub (registry) plus a probe for the worker wrapper. No Warp, no tmux server, no
# terminal, no daemon. State under $T_TMP only (lib.sh sets AIGENTRY_WH_STATE_DIR).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
LIB="$REPO_ROOT/bin/lib/workspace-host.sh"
CLI="$REPO_ROOT/bin/wh-cli.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T1304]: $*" >&2; exit 1; }

export AIGENTRY_WARP_TAB_CONFIG_DIR="$T_TMP/tab_configs"
export AIGENTRY_WARP_SURFACE_DIR="$T_TMP/warp-surfaces"
export WARP_READY_TIMEOUT_MS=3000 WARP_READY_INTERVAL_MS=20
STATE="$AIGENTRY_WH_STATE_DIR"
export TMUX_STUB_STATE="$T_TMP/tmux"; mkdir -p "$TMUX_STUB_STATE/s" "$TMUX_STUB_STATE/w"
export TMUX_STUB_SCREEN="$T_TMP/screen-fixture.txt"
export OPEN_LOG="$T_TMP/open.log"; : > "$OPEN_LOG"
export WARP_KEEP="$T_TMP/kept-tab-config.toml"
CMUX_LOG="$T_TMP/cmux.log"; : > "$CMUX_LOG"
OSA_LOG="$T_TMP/osa.log"; : > "$OSA_LOG"
PROBE_DIR="$T_TMP/probe"; mkdir -p "$PROBE_DIR"
export TMUX_STUB_PROBE="$PROBE_DIR"
export PROBE_LOG="$T_TMP/probe.log"; : > "$PROBE_LOG"

# ── TOML reader for the tab config: tomllib when Python has it (3.11+); else a strict
# reader of the documented subset, whose values are JSON-compatible basic strings. ──
TOML_PY="$T_TMP/tab-config.py"
cat > "$TOML_PY" <<'EOF'
import json, re, sys
mode, path = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
if re.search(r"^\s*\[\[tabs\]\]", text, re.M):
    sys.exit("tab config still carries the [[tabs]] schema")
try:
    import tomllib
    doc, parser = tomllib.loads(text), "tomllib"
except ModuleNotFoundError:
    doc, parser, cur = {}, "subset", None
    cur = doc
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s == "[[panes]]":
            cur = {}
            doc.setdefault("panes", []).append(cur)
            continue
        m = re.fullmatch(r'([A-Za-z_]+) = ("(?:[^"\\]|\\.)*"|\[("(?:[^"\\]|\\.)*")\])', line)
        if m is None:
            sys.exit("line outside the documented subset: " + line)
        cur[m.group(1)] = json.loads(m.group(2))
if mode == "command":
    sys.stdout.write(doc["panes"][0]["commands"][0])
else:
    print(json.dumps({"parser": parser, "doc": doc}, ensure_ascii=False))
EOF

# ── stub tmux: sessions and windows are files; answers the way tmux 3 does ──────────
cat > "$STUB_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
st="${TMUX_STUB_STATE:?}"
printf '%s\n' "tmux $*" >> "$st/log"
[ -n "${TMUX_STUB_ANSWER:-}" ] && { echo "$TMUX_STUB_ANSWER" >&2; exit 1; }
verb="${1:-}"; [ $# -gt 0 ] && shift
t=""; prev=""; for a in "$@"; do [ "$prev" = -t ] && t="$a"; prev="$a"; done
n="${t#=}"; n="${n%:}"
case "$verb" in
  new-session)
    printf '%s\0' "$verb" "$@" > "$st/new-session.argv"
    name=""; dir=""; cmd=""
    while [ $# -gt 0 ]; do case "$1" in -A) shift;; -s) name="$2"; shift 2;; -c) dir="$2"; shift 2;; *) cmd="$1"; shift;; esac; done
    : > "$st/s/$name"
    # Real tmux runs the command through a shell in -c's directory. So does this.
    ( cd "$dir" && PATH="${TMUX_STUB_PROBE:?}:$PATH" bash -c "$cmd" ) >> "$st/run.log" 2>&1 || true
    exit 0 ;;
  has-session)  [ -e "$st/s/$n" ] && exit 0; echo "can't find session: $n" >&2; exit 1 ;;
  kill-session) [ -e "$st/s/$n" ] && { rm -f "$st/s/$n"; exit 0; }; echo "can't find session: $n" >&2; exit 1 ;;
  list-sessions)
    out=$(ls "$st/s")
    [ -n "$out" ] || { echo "no server running on /tmp/tmux-stub/default" >&2; exit 1; }
    printf '%s\n' "$out" ;;
  capture-pane)
    case "$n" in
      @*) [ -e "$st/w/$n" ] || { echo "can't find window: $n" >&2; exit 1; } ;;
      *)  [ -e "$st/s/$n" ] || { echo "can't find session: $n" >&2; exit 1; } ;;
    esac
    cat "${TMUX_STUB_SCREEN:?}" ;;
  new-window)
    i=$(( $(cat "$st/wn" 2>/dev/null || echo 40) + 1 )); echo "$i" > "$st/wn"
    : > "$st/w/@$i"; echo "@$i" ;;
  list-windows) ls "$st/w" ;;
  kill-window)  [ -e "$st/w/$n" ] && { rm -f "$st/w/$n"; exit 0; }; echo "can't find window: $n" >&2; exit 1 ;;
esac
exit 0
EOF

# ── the Warp deeplink handoff: read the tab config, run commands[0] like Warp ───────
for opener in open xdg-open; do
  cat > "$STUB_BIN/$opener" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\$OPEN_LOG"
name="\${1##*/}"
toml="\$AIGENTRY_WARP_TAB_CONFIG_DIR/\$name.toml"
[ -f "\$toml" ] || exit 1
cp "\$toml" "\$WARP_KEEP"
cmd=\$(python3 "$TOML_PY" command "\$toml") || exit 1
bash -c "\$cmd" >> "$T_TMP/opener-run.log" 2>&1 || true
exit 0
EOF
done

# ── the worker wrapper's telepty (a probe), a tripwire cmux, an osascript recorder ──
cat > "$PROBE_DIR/telepty" <<'EOF'
#!/usr/bin/env bash
printf 'telepty %s pwd=%s\n' "$*" "$PWD" >> "${PROBE_LOG:?}"
EOF
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
printf 'cmux %s\n' "\$*" >> "$CMUX_LOG"
exit 0
EOF
cat > "$STUB_BIN/osascript" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$OSA_LOG"; cat >/dev/null 2>&1 || true; exit 1
EOF
chmod +x "$STUB_BIN/tmux" "$STUB_BIN/open" "$STUB_BIN/xdg-open" "$PROBE_DIR/telepty" \
  "$STUB_BIN/cmux" "$STUB_BIN/osascript"
export CMUX="$STUB_BIN/cmux"

cli() { "$BASH_BIN" "$CLI" "$@"; }

# ════ A) tab config shape + commands[0] argv ════════════════════════════════════════
SID="t1304.w1"                                  # a '.' exercises the tmux name mapping
NAME="aigentry-warp-t1304%2Ew1"
MARK="telepty::$SID"
CWD="$T_TMP/it's a \"q\" \\ 한글 dir"
mkdir -p "$CWD"
set +e
OUT=$(AIGENTRY_WORKSPACE_HOST=warp cli open "$SID" "$CWD" "claude --x" 2>"$T_TMP/a.err"); RC=$?
set -e
[ "$RC" -eq 0 ] || fail "A: warp open rc=$RC want 0. stderr:
$(cat "$T_TMP/a.err")
opener run:
$(cat "$T_TMP/opener-run.log" 2>/dev/null)"
[ "$OUT" = "$MARK" ] || fail "A: stdout='$OUT' want '$MARK'"
grep -qxF "warp://tab_config/telepty-$SID" "$OPEN_LOG" || fail "A: the deeplink was not issued for this sid: $(cat "$OPEN_LOG")"

python3 - "$TOML_PY" "$WARP_KEEP" "$CWD" "$MARK" <<'PY' || fail "A: the tab config is not the documented schema (see above). TOML:
$(cat "$WARP_KEEP")"
import json, subprocess, sys
helper, path, cwd, mark = sys.argv[1:5]
out = subprocess.run([sys.executable, helper, "shape", path], capture_output=True, text=True)
if out.returncode:
    sys.exit(out.stderr or out.stdout)
doc = json.loads(out.stdout)["doc"]
problems = []
if set(doc) != {"name", "title", "panes"}:
    problems.append(f"top-level keys {sorted(doc)} != name/title/panes")
if doc.get("name") != mark or doc.get("title") != mark:
    problems.append(f"name/title {doc.get('name')!r}/{doc.get('title')!r} != {mark!r}")
panes = doc.get("panes")
if not isinstance(panes, list) or len(panes) != 1:
    problems.append(f"want exactly one [[panes]] table, got {panes!r}")
else:
    p = panes[0]
    if set(p) != {"id", "type", "directory", "commands"}:
        problems.append(f"pane keys {sorted(p)} != id/type/directory/commands")
    if not isinstance(p.get("id"), str) or not p["id"]:
        problems.append("pane id missing")
    if p.get("type") != "terminal":
        problems.append(f"pane type {p.get('type')!r}")
    if p.get("directory") != cwd:
        problems.append(f"directory {p.get('directory')!r} != cwd {cwd!r}")
    if not isinstance(p.get("commands"), list) or len(p["commands"]) != 1:
        problems.append(f"commands {p.get('commands')!r} is not one shell line")
for x in problems:
    print("  " + x, file=sys.stderr)
sys.exit(1 if problems else 0)
PY

python3 - "$TMUX_STUB_STATE/new-session.argv" "$NAME" "$CWD" "$SID" <<'PY' || fail "A: commands[0] did not invoke tmux new-session with the exact argv (see above)"
import sys
path, name, cwd, sid = sys.argv[1:5]
got = open(path, "rb").read().split(b"\0")[:-1]
got = [g.decode("utf-8") for g in got]
# task 1304 r3/r4: the worker command starts with the foreign-terminal scrub (host = tmux:
# every CMUX_* goes; TMUX/TMUX_PANE stay; TERM_PROGRAM stays only if it is tmux's own).
scrub = (r"""/bin/sh -c 'for v in $(env | sed -n "s/^\(CMUX_[A-Za-z0-9_]*\)=.*/\1/p"); do unset "$v"; done; """
         r"""unset TELEPTY_SESSION_ID ATERM_IPC_SOCKET; [ "${TERM_PROGRAM:-}" = "tmux" ] && [ -n "tmux" ] """
         r"""|| unset TERM_PROGRAM TERM_PROGRAM_VERSION; exec "$@"' sh""")
want = ["new-session", "-A", "-s", name, "-c", cwd, f"{scrub} telepty allow --id '{sid}' --auto-restart claude --x"]
if got != want:
    print(f"  got:  {got!r}\n  want: {want!r}", file=sys.stderr)
    sys.exit(1)
PY
grep -qxF "telepty allow --id $SID --auto-restart claude --x pwd=$CWD" "$PROBE_LOG" \
  || fail "A: the wrapper tmux ran did not start telepty allow for this sid in the cwd. probe log:
$(cat "$PROBE_LOG")"
[ -e "$TMUX_STUB_STATE/s/$NAME" ] || fail "A: open returned a handle but the worker's tmux session does not exist"
printf 'v1\twarp\t%s\n' "$MARK" > "$T_TMP/want.rec"
cmp -s "$STATE/$SID.rec" "$T_TMP/want.rec" || fail "A: the adapter record for $SID is not 'v1<TAB>warp<TAB>$MARK': $(cat "$STATE/$SID.rec" 2>&1)"
[ -s "$OSA_LOG" ] && fail "A: an open used Accessibility: $(cat "$OSA_LOG")"

# AIGENTRY_WORKER_AUTO_RESTART is honoured as cmux honours it.
: > "$PROBE_LOG"
AIGENTRY_WORKSPACE_HOST=warp AIGENTRY_WORKER_AUTO_RESTART=0 cli open t1304-nr "$CWD" "claude --x" >/dev/null 2>"$T_TMP/a2.err" \
  || fail "A: AUTO_RESTART=0 open failed: $(cat "$T_TMP/a2.err")"
grep -qxF "telepty allow --id t1304-nr claude --x pwd=$CWD" "$PROBE_LOG" \
  || fail "A: AIGENTRY_WORKER_AUTO_RESTART=0 did not drop --auto-restart. probe log:
$(cat "$PROBE_LOG")"
set +e
AIGENTRY_WORKSPACE_HOST=warp AIGENTRY_WORKER_AUTO_RESTART=yes cli open t1304-bad "$CWD" "claude --x" >/dev/null 2>"$T_TMP/a3.err"; rc=$?
set -e
[ "$rc" -eq 2 ] || fail "A: an unreadable AIGENTRY_WORKER_AUTO_RESTART was not refused (rc=$rc)"
[ -e "$AIGENTRY_WARP_TAB_CONFIG_DIR/telepty-t1304-bad.toml" ] && fail "A: a refused AUTO_RESTART still wrote a tab config"

# ════ B) forced warp without tmux: exit 2, one line, nothing left behind ═════════════
NOTMUX="$T_TMP/notmux-bin"; mkdir -p "$NOTMUX"
cp "$STUB_BIN/open" "$NOTMUX/open"; cp "$STUB_BIN/xdg-open" "$NOTMUX/xdg-open"
ln -s "$(command -v cat)" "$NOTMUX/cat"   # the registry table is printed by cat; nothing else
BSTATE="$T_TMP/b-state"; BTC="$T_TMP/b-tab-configs"; BSURF="$T_TMP/b-surfaces"
: > "$OPEN_LOG"
set +e
OUT=$(env PATH="$NOTMUX" AIGENTRY_WORKSPACE_HOST=warp AIGENTRY_WH_STATE_DIR="$BSTATE" \
        AIGENTRY_WARP_TAB_CONFIG_DIR="$BTC" AIGENTRY_WARP_SURFACE_DIR="$BSURF" \
        "$BASH_BIN" -c '. "$1"; wh_open "$2" "$3" "claude --x"' _ "$LIB" t1304-nt "$CWD" 2>"$T_TMP/b.err"); RC=$?
set -e
[ "$RC" -eq 2 ] || fail "B: warp open without tmux rc=$RC want 2. stderr: $(cat "$T_TMP/b.err")"
[ -z "$OUT" ] || fail "B: a handle was printed without tmux: '$OUT'"
n=$(grep -c 'tmux' "$T_TMP/b.err" | tr -d ' ')
named=$(grep 'tmux' "$T_TMP/b.err" | grep -c 'AIGENTRY_WORKSPACE_HOST' | tr -d ' ')
[ "$n" = 1 ] && [ "$named" = 1 ] || fail "B: want exactly one stderr line naming tmux and AIGENTRY_WORKSPACE_HOST. stderr:
$(cat "$T_TMP/b.err")"
[ -e "$BTC" ] && [ -n "$(ls -A "$BTC")" ] && fail "B: a tab config was left behind: $(ls -A "$BTC")"
[ -e "$BSTATE" ] && fail "B: the state dir (a record) was created for a failed open: $(ls -A "$BSTATE")"
[ -e "$BSURF" ] && fail "B: the surface dir was created for a failed open"
[ -s "$OPEN_LOG" ] && fail "B: the Warp deeplink was opened although tmux is missing: $(cat "$OPEN_LOG")"

# ════ C) close-for-sid with NO override, cmux on PATH: warp close ran, cmux untouched ═
# telepty has no row for the sid (the worker is gone from the registry): the record alone
# must carry the adapter and the handle.
printf '%s' '[{"id":"sid-A","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
: > "$CMUX_LOG"; : > "$TMUX_STUB_STATE/log"
[ -f "$AIGENTRY_WARP_TAB_CONFIG_DIR/telepty-$SID.toml" ] || fail "C: precondition — the tab config of $SID is missing"
set +e
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" close-for-sid "$SID" >/dev/null 2>"$T_TMP/c.err"; RC=$?
set -e
[ "$RC" -eq 0 ] || fail "C: close-for-sid rc=$RC want 0. stderr: $(cat "$T_TMP/c.err")"
grep -qxF "tmux kill-session -t =$NAME" "$TMUX_STUB_STATE/log" || fail "C: the warp close (tmux kill-session) did not run. tmux log:
$(cat "$TMUX_STUB_STATE/log")"
[ -e "$TMUX_STUB_STATE/s/$NAME" ] && fail "C: the worker's tmux session is still alive"
[ -e "$AIGENTRY_WARP_TAB_CONFIG_DIR/telepty-$SID.toml" ] && fail "C: the tab config was not removed"
[ -e "$STATE/$SID.rec" ] && fail "C: the record was not removed on close"
[ -s "$CMUX_LOG" ] && fail "C: cmux was touched for a warp session:
$(cat "$CMUX_LOG")"
# …and the same with telepty still listing the sid (lookup through the registry row).
printf '%s' '[{"id":"t1304-nr","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" close-for-sid t1304-nr >/dev/null 2>"$T_TMP/c2.err" \
  || fail "C: close-for-sid (registered sid) failed: $(cat "$T_TMP/c2.err")"
[ -e "$TMUX_STUB_STATE/s/aigentry-warp-t1304-nr" ] && fail "C: the registered warp session was not killed"
[ -s "$CMUX_LOG" ] && fail "C: cmux was touched for a registered warp session: $(cat "$CMUX_LOG")"

# ════ D) read_screen ═════════════════════════════════════════════════════════════════
printf 'fixture viewport line 1\n> ready\n' > "$TMUX_STUB_SCREEN"
AIGENTRY_WORKSPACE_HOST=warp cli open t1304-rs "$CWD" "claude --x" >/dev/null 2>"$T_TMP/d.err" \
  || fail "D: warp open for read_screen failed: $(cat "$T_TMP/d.err")"
: > "$TMUX_STUB_STATE/log"
got=$(env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" read-screen t1304-rs 2>/dev/null) || fail "D: read-screen by sid failed"
[ "$got" = "$(cat "$TMUX_STUB_SCREEN")" ] || fail "D: read-screen by sid returned '$got'"
grep -qxF "tmux capture-pane -p -t =aigentry-warp-t1304-rs:" "$TMUX_STUB_STATE/log" \
  || fail "D: warp read-screen is not 'tmux capture-pane -p -t <session>'. log: $(cat "$TMUX_STUB_STATE/log")"
got=$(env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" read-screen "telepty::t1304-rs" 2>/dev/null) || fail "D: read-screen by handle failed"
[ "$got" = "$(cat "$TMUX_STUB_SCREEN")" ] || fail "D: read-screen by handle returned '$got'"
grep -q 'scrollback\|-S ' "$TMUX_STUB_STATE/log" && fail "D: read-screen asked tmux for scrollback: $(cat "$TMUX_STUB_STATE/log")"
set +e
out=$(AIGENTRY_WORKSPACE_HOST=headless cli read-screen anything 2>/dev/null); rc=$?
set -e
[ "$rc" -eq 20 ] || fail "D: headless read-screen rc=$rc want 20 (unsupported)"
[ "$out" = "read_screen unsupported adapter=headless" ] || fail "D: unsupported answer is not one labelled line: '$out'"

# ════ G) the door loads platform.sh: forced tmux open through wh-cli.sh ═════════════
set +e
TOUT=$(AIGENTRY_WORKSPACE_HOST=tmux TMUX=/tmp/t1304-fake cli open t1304-tm "$CWD" "claude --x" 2>"$T_TMP/g.err"); rc=$?
set -e
[ "$rc" -eq 0 ] || fail "G: a forced tmux open through wh-cli.sh failed (rc=$rc) — platform:: not loaded? $(cat "$T_TMP/g.err")"
case "$TOUT" in @[0-9]*) ;; *) fail "G: tmux open printed '$TOUT', want a window id" ;; esac
printf 'v1\ttmux\t%s\n' "$TOUT" > "$T_TMP/want-tm.rec"
cmp -s "$STATE/t1304-tm.rec" "$T_TMP/want-tm.rec" || fail "G: tmux record is not 'v1<TAB>tmux<TAB>$TOUT'"
: > "$TMUX_STUB_STATE/log"
got=$(env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" read-screen t1304-tm 2>/dev/null) || fail "G: tmux read-screen by sid failed"
[ "$got" = "$(cat "$TMUX_STUB_SCREEN")" ] || fail "G: tmux read-screen returned '$got'"
grep -qxF "tmux capture-pane -p -t $TOUT" "$TMUX_STUB_STATE/log" || fail "G: tmux read-screen did not address the window id: $(cat "$TMUX_STUB_STATE/log")"
lk=$(env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" lookup t1304-tm 2>/dev/null)
[ "$lk" = "$TOUT" ] || fail "G: tmux lookup='$lk' want '$TOUT'"
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" alive "$TOUT" 2>/dev/null || fail "G: tmux alive on a live window was not 0"
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" close-for-sid t1304-tm 2>/dev/null || fail "G: tmux close-for-sid failed"
grep -qxF "tmux kill-window -t $TOUT" "$TMUX_STUB_STATE/log" || fail "G: tmux close did not kill the window: $(cat "$TMUX_STUB_STATE/log")"
[ -e "$STATE/t1304-tm.rec" ] && fail "G: tmux record not removed on close"
set +e
AIGENTRY_WORKSPACE_HOST=tmux cli alive "$TOUT" 2>/dev/null; rc=$?
set -e
[ "$rc" -eq 1 ] || fail "G: tmux alive on a killed window rc=$rc want 1"
[ -s "$CMUX_LOG" ] && fail "G: cmux was touched for a tmux session: $(cat "$CMUX_LOG")"

# ════ E) warp alive / list / prune; headless alive ═══════════════════════════════════
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" alive "telepty::t1304-rs" 2>/dev/null || fail "E: warp alive on a live session was not 0"
set +e
TMUX_STUB_ANSWER="error connecting to /tmp/tmux-stub/default (Permission denied)" \
  env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" alive "telepty::t1304-rs" 2>/dev/null; rc=$?
set -e
[ "$rc" -eq 0 ] || fail "E: a tmux that cannot answer made warp alive say gone (rc=$rc) — INV-17"
: > "$TMUX_STUB_STATE/s/unrelated-session"
AIGENTRY_WORKSPACE_HOST=warp cli open t1304-dead "$CWD" "claude --x" >/dev/null 2>&1 || fail "E: second warp open failed"
ids=$(AIGENTRY_WORKSPACE_HOST=warp cli list-ids 2>/dev/null | sort | tr '\n' ' ')
[ "$ids" = "telepty::t1304-dead telepty::t1304-rs " ] || fail "E: warp list-ids='$ids' (want only the prefixed sessions, as markers)"
: > "$OSA_LOG"
c1=$(AIGENTRY_WORKSPACE_HOST=warp cli prune-orphans "t1304-rs,sid-A" "" 2>/dev/null)
[ "$c1" = "0" ] || fail "E: prune tick 1 closed $c1 (seen-twice debounce: want 0)"
[ -e "$TMUX_STUB_STATE/s/aigentry-warp-t1304-dead" ] || fail "E: prune tick 1 closed a first-sighting candidate"
c2=$(AIGENTRY_WORKSPACE_HOST=warp cli prune-orphans "t1304-rs,sid-A" "" 2>/dev/null)
[ "$c2" = "1" ] || fail "E: prune tick 2 closed $c2, want 1"
[ -e "$TMUX_STUB_STATE/s/aigentry-warp-t1304-dead" ] && fail "E: prune did not close the orphan's tmux session"
[ -e "$TMUX_STUB_STATE/s/aigentry-warp-t1304-rs" ] || fail "E: prune closed a LIVE session"
[ -e "$TMUX_STUB_STATE/s/unrelated-session" ] || fail "E: prune closed a session this layer does not own"
[ -e "$STATE/t1304-dead.rec" ] && fail "E: prune left the closed orphan's record"
[ -s "$OSA_LOG" ] && fail "E: prune took a GUI action: $(cat "$OSA_LOG")"
set +e
AIGENTRY_WORKSPACE_HOST=warp cli alive "telepty::t1304-dead" 2>/dev/null; rc=$?   # its record went with the close
set -e
[ "$rc" -eq 1 ] || fail "E: warp alive on a killed session rc=$rc want 1 (tmux answered: no such session)"
AIGENTRY_WORKSPACE_HOST=headless cli alive anything 2>/dev/null || fail "E: headless alive is not INDETERMINATE→alive (ADR D5)"

# ════ F) detection ═══════════════════════════════════════════════════════════════════
d=$(env -i PATH="/bin:/usr/bin" TERM_PROGRAM=WarpTerminal "$BASH_BIN" -c '. "$1"; detect_terminal' _ "$LIB" 2>/dev/null)
[ "$d" = "warp" ] || fail "F: TERM_PROGRAM=WarpTerminal detected '$d', want warp"
d=$(env -i PATH="/bin:/usr/bin" TERM_PROGRAM=WarpTerminal TMUX=/tmp/x "$BASH_BIN" -c '. "$1"; detect_terminal' _ "$LIB" 2>/dev/null)
[ "$d" = "tmux" ] || fail "F: inside tmux (in Warp) detected '$d', want tmux (registry order)"
a=$(env -i PATH="/bin:/usr/bin" TERM_PROGRAM=WarpTerminal "$BASH_BIN" -c '. "$1"; _wh_adapter' _ "$LIB" 2>/dev/null)
[ "$a" = "headless" ] || fail "F: the lifecycle auto rule picked '$a' for TERM_PROGRAM=WarpTerminal without a record"

# ════ untrusted sids/records: no traversal, no evaluation ════════════════════════════
printf 'v1\twarp\t$(touch %s)\n' "$T_TMP/pwned-record" > "$STATE/t1304-evil.rec"
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" lookup t1304-evil >/dev/null 2>&1 || true
env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" close-for-sid t1304-evil >/dev/null 2>&1 || true
[ -e "$T_TMP/pwned-record" ] && fail "U: a record's content was evaluated"
mkdir -p "$T_TMP/outside"; printf 'v1\twarp\ttelepty::x\n' > "$T_TMP/outside/escape.rec"
set +e
out=$(env -u AIGENTRY_WORKSPACE_HOST "$BASH_BIN" "$CLI" read-screen "../outside/escape" 2>"$T_TMP/u.err"); rc=$?
set -e
grep -q 'adapter unknown' "$T_TMP/u.err" || fail "U: a traversing sid resolved through a record outside the state dir. stderr: $(cat "$T_TMP/u.err")"
set +e
AIGENTRY_WORKSPACE_HOST=warp cli open "../t1304-up" "$CWD" "claude --x" >/dev/null 2>&1; rc=$?
set -e
[ "$rc" -eq 2 ] || fail "U: a traversing sid was opened as warp (rc=$rc)"
[ -z "$(find "$T_TMP" -name '*t1304-up*' 2>/dev/null)" ] || fail "U: a traversing sid left a file: $(find "$T_TMP" -name '*t1304-up*')"

echo "T1304 PASS warp=schema/argv/no-tmux/close-for-sid/read/alive/list/prune tmux=handle/read/close detect=WarpTerminal headless-alive=0"
