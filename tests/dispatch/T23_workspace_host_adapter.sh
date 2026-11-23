#!/usr/bin/env bash
# T23 — Workspace Host adapter seam: 4 functions, cmux adapter via stub binary.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

# Stub cmux on PATH that records calls + answers list/sidebar-state/close, modelling
# the cmux CLI contract verified live in SPEC 2026-06-06-cmux-adaptor-prune-status:
#   F2 — the global `--json` flag PRECEDES the command (`cmux --json list-workspaces`).
#   F3 — the listing shape is `{"workspaces":[{ref,...}]}` (no top-level array / `id`).
#   F7/F9 — per-handle liveness is `sidebar-state`. Per #1162(c) the ONLY "gone"
#           answer is a FAILED probe (rc!=0) whose whole reply is exactly
#           `Error: ERROR: Tab not found`, emitted on STDERR by cmux 0.64.20.
#           A zero-exit reply carrying that text is NOT an answer (a state dump
#           may contain it, and a refused daemon socket wears the same shape),
#           so the stub must fail the probe to model a genuinely absent handle.
CMUX_CALLS="$T_TMP/cmux-calls.log"
cat > "$STUB_BIN/cmux" <<EOF
#!/usr/bin/env bash
echo "cmux \$*" >> "$CMUX_CALLS"
if [ "\$1" = "--json" ] && [ "\$2" = "list-workspaces" ]; then
  cat "$T_TMP/cmux-workspaces.json"; exit 0
fi
case "\$1" in
  sidebar-state)
    # \$2=--workspace \$3=<id>; known handles are alive (state on stdout, rc=0),
    # unknown => cmux 0.64.20's missing-handle answer: the exact line on stderr
    # AND a non-zero exit (F7, #1162c).
    case "\${3:-}" in
      ws-alive|ws-other) echo "tab=\${3} status_count=0"; exit 0;;
      *) echo "Error: ERROR: Tab not found" >&2; exit 1;;
    esac
    ;;
  close-workspace)
    # \$2=--workspace \$3=<id> — succeed for "ws-alive", fail for "ws-bad"
    if [ "\${3:-}" = "ws-bad" ]; then exit 1; fi
    exit 0
    ;;
  *) exit 0;;
esac
EOF
chmod +x "$STUB_BIN/cmux"
printf '{"workspaces":[{"ref":"ws-alive"},{"ref":"ws-other"}]}' > "$T_TMP/cmux-workspaces.json"

# telepty list with cmuxWorkspaceId mapping.
cat > "$STUB_LIST_FILE" <<EOF
[{"id":"sid-A","healthStatus":"CONNECTED","cmuxWorkspaceId":"ws-alive"}]
EOF

# Source the seam in a subshell so we can call its functions.
out=$(AIGENTRY_WORKSPACE_HOST=cmux bash -c "
  set -e
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  echo \"lookup=\$(wh_lookup sid-A)\"
  echo \"alive=\$(wh_alive ws-alive; echo \$?)\"
  echo \"gone=\$(wh_alive ws-missing; echo \$?)\"
  echo \"list_ids=\$(wh_list_ids | tr '\n' ',')\"
  wh_close ws-alive && echo close-alive=ok || echo close-alive=fail
")

echo "$out" | grep -q "lookup=ws-alive"     || { echo "FAIL: lookup"; echo "$out"; exit 1; }
echo "$out" | grep -q "alive=0"             || { echo "FAIL: alive"; echo "$out"; exit 1; }
echo "$out" | grep -q "gone=1"              || { echo "FAIL: alive-gone"; echo "$out"; exit 1; }
echo "$out" | grep -q "list_ids=ws-alive,ws-other," || { echo "FAIL: list_ids"; echo "$out"; exit 1; }
echo "$out" | grep -q "close-alive=ok"      || { echo "FAIL: close"; echo "$out"; exit 1; }

# Headless adapter — all no-ops; alive answers INDETERMINATE→alive (0), task 1304 ADR D5:
# headless has no host to ask, and "cannot ask" is never "gone" (INV-17).
out2=$(AIGENTRY_WORKSPACE_HOST=headless bash -c "
  set -e
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  echo \"lookup=\$(wh_lookup sid-A)\"
  wh_alive any && echo alive-ok || echo alive-gone
  wh_close any && echo close-ok || echo close-fail
")
echo "$out2" | grep -q "lookup=$"     || { echo "FAIL: headless lookup not empty"; echo "$out2"; exit 1; }
echo "$out2" | grep -q "alive-ok"     || { echo "FAIL: headless alive (should be INDETERMINATE→alive, ADR D5)"; echo "$out2"; exit 1; }
echo "$out2" | grep -q "close-ok"     || { echo "FAIL: headless close"; echo "$out2"; exit 1; }

# --- #835: only a real answer may say "gone" -------------------------------
# wh_alive's "gone" verdict is a CORROBORATING signal for a teardown
# (session-reconciler.sh INV-17), so a probe that learned nothing must not supply
# it. cmux answering `Error:` is an answer (covered above: gone=1). cmux saying
# nothing, or not being reachable at all, is not — and used to read as "gone",
# which is how a crashed or missing cmux manufactured half the evidence for
# closing a live worker's surface. The warp adapter already maps "cannot probe"
# to INDETERMINATE→alive (_wh_warp_alive, INV-17 #486); cmux must match.
BASH_BIN="$(command -v bash)"
SILENT_DIR="$T_TMP/silent-bin"; mkdir -p "$SILENT_DIR"
cat > "$SILENT_DIR/cmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  sidebar-state) exit 1;;   # crashed / hung / wrong version: nothing on stdout
  *) exit 0;;
esac
EOF
chmod +x "$SILENT_DIR/cmux"

out3=$(AIGENTRY_WORKSPACE_HOST=cmux "$BASH_BIN" -c "
  export PATH='$SILENT_DIR:/usr/bin:/bin'
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  wh_alive ws-alive && echo silent=present || echo silent=gone
" 2>/dev/null)
echo "$out3" | grep -q "silent=present" \
  || { echo "FAIL: a silent cmux probe reported the surface GONE — an unanswered probe is not evidence, and this verdict corroborates a teardown"; echo "$out3"; exit 1; }

# cmux not on PATH at all — same reasoning, stronger case. Probed at the adapter
# function directly (as T25 does for _wh_warp_alive) because with cmux absent the
# public wh_alive resolves to the headless adapter, whose own answer (alive since task
# 1304 D5) is a separate contract asserted above and is unreachable from the sweep (headless
# wh_lookup returns no host_id, so the reconciler never probes).
EMPTY_DIR="$T_TMP/empty-bin"; mkdir -p "$EMPTY_DIR"
out4=$("$BASH_BIN" -c "
  export PATH='$EMPTY_DIR:/usr/bin:/bin'
  . '$REPO_ROOT/bin/lib/workspace-host.sh'
  _wh_cmux_alive ws-alive && echo nocmux=present || echo nocmux=gone
" 2>/dev/null)
echo "$out4" | grep -q "nocmux=present" \
  || { echo "FAIL: an unreachable cmux reported the surface GONE — 'I cannot probe' is not 'it is not there'"; echo "$out4"; exit 1; }

# ── background creation: an OPT-IN, and what each answer to the support probe does ──────
# A recording stub stands in for cmux: it logs the FULL argv of every call, so these
# assertions are about the argument vector the adapter really builds, not about a window.
# Nothing opens a terminal and no real cmux is contacted.
#
# AIGENTRY_* is scrubbed from every guard's environment by run-all.sh:50-53, so block A
# below measures the DEFAULT arm exactly as an ordinary installation gets it.
FOCUS_LOG="$T_TMP/focus-cmux-argv.log"
cat > "$STUB_BIN/cmux-focus" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$T_TMP/focus-cmux-argv.log"
case "$1" in
  --help)
    case "${T23_CMUX_HELP:-single-line}" in
      # The layout observed on a cmux that supports the option.
      single-line) echo '  new-workspace [--focus <true|false>] [--cwd <dir>] [--command <cmd>]';;
      # Same support, options on continuation lines: a same-line grep would refuse this.
      continuation) printf '%s\n' 'Commands:' '  new-workspace' '      --cwd <dir>' \
                      '      --focus <true|false>' '      --command <cmd>' '  close-workspace';;
      # An unrelated option that merely BEGINS with --focus: a prefix grep would accept this.
      prefix-only) echo '  new-workspace [--cwd <dir>] [--focus-follows-mouse <true|false>]';;
      # A bare SWITCH whose description text says "(bool)": no value placeholder, so passing
      # `--focus false` would leave `false` as a positional. A value rule that accepts any
      # punctuation-then-bool after --focus would read this as support.
      described-switch) printf '%s\n' 'Commands:' '  new-workspace' '      --cwd <dir>' \
                          '      --focus   (bool) focus the new workspace' '      --command <cmd>';;
      # A cmux too old to know the option at all.
      no-focus) echo '  new-workspace [--cwd <dir>] [--command <cmd>]';;
      # A probe that cannot be read: usable-looking help but a non-zero status, and silence.
      rc-nonzero) echo '  new-workspace [--focus <true|false>] [--cwd <dir>]'; exit 1;;
      silent) : ;;
    esac;;
  new-workspace) echo 'OK workspace:56';;
  list-workspaces) echo 'workspace:56 fixture';;
  surface-health) echo 'type=terminal';;
  read-screen) echo 'fixture prompt';;
  *) :;;
esac
EOF
chmod +x "$STUB_BIN/cmux-focus"
mkdir -p "$T_TMP/focus-cwd"
# Each call runs in its own subshell, so a setting never leaks into the next case.
open_focus_fixture() (
  export CMUX="$STUB_BIN/cmux-focus" CMUX_READY_TIMEOUT_MS=1 CMUX_READY_INTERVAL_MS=1
  . "$REPO_ROOT/bin/lib/workspace-host.sh"
  _wh_cmux_open 'fixture-t23-focus' "$T_TMP/focus-cwd" 'fixture-cli --fixture-only'
)
# The adapter passes the cwd twice: raw to `--cwd`, and `%q`-quoted as the wrapper's
# positional. The expectation is built the same way rather than assuming the two coincide,
# so a TMPDIR needing quotes cannot produce a spurious mismatch here.
printf -v t23_q_cwd '%q' "$T_TMP/focus-cwd"
expected_default_argv="new-workspace --cwd $T_TMP/focus-cwd --command bash -c 'cd \"\$1\" && exec telepty allow --id \"\$2\" --auto-restart fixture-cli --fixture-only' _ $t23_q_cwd fixture-t23-focus"

# A: THE DEFAULT. With the setting absent the adapter must behave exactly as the public
# adapter always has — on EVERY cmux version. The stub answers --help like a cmux that has
# never heard of --focus, and the spawn must still succeed, with the old argv and with no
# probe at all. A probe on every spawn would refuse this cmux with exit 2, so an ordinary
# install would create no workers.
: > "$FOCUS_LOG"; unset AIGENTRY_CMUX_BACKGROUND_SPAWN
[ "$(T23_CMUX_HELP=no-focus open_focus_fixture)" = workspace:56 ] \
  || { echo 'FAIL: a DEFAULT launch on a cmux without --focus must still open a workspace'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^--help' "$FOCUS_LOG" \
  && { echo 'FAIL: a default launch probed cmux --help — the default path must ask nothing'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '--focus' "$FOCUS_LOG" \
  && { echo 'FAIL: a default launch passed --focus — the default argv must not change'; cat "$FOCUS_LOG"; exit 1; }
[ "$(head -1 "$FOCUS_LOG")" = "$expected_default_argv" ] \
  || { echo "FAIL: the default new-workspace argv changed
want: $expected_default_argv
got : $(head -1 "$FOCUS_LOG")"; exit 1; }

# B: opted in, on a cmux that documents the option — background creation, probe FIRST.
: > "$FOCUS_LOG"
[ "$(AIGENTRY_CMUX_BACKGROUND_SPAWN=1 open_focus_fixture)" = workspace:56 ] \
  || { echo 'FAIL: the opted-in open did not emit its ref'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^--help$' "$FOCUS_LOG" \
  || { echo 'FAIL: the adapter did not probe cmux --help for --focus support'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^new-workspace --focus false --cwd ' "$FOCUS_LOG" \
  || { echo 'FAIL: new-workspace did not receive --focus false as its first argument pair'; cat "$FOCUS_LOG"; exit 1; }
# The support probe must come BEFORE the spawn, or the refusal would arrive too late.
[ "$(grep -n -- '^--help$' "$FOCUS_LOG" | head -1 | cut -d: -f1)" -lt \
  "$(grep -n -- '^new-workspace ' "$FOCUS_LOG" | head -1 | cut -d: -f1)" ] \
  || { echo 'FAIL: the --focus support probe ran after the spawn'; cat "$FOCUS_LOG"; exit 1; }
# Focus is never ACTUATED on spawn: no select/focus verb is issued at all (cf. T56 part C).
grep -qE 'select-workspace|^focus' "$FOCUS_LOG" \
  && { echo 'FAIL: FOCUS THEFT — the adapter actuated focus while creating a worker workspace'; cat "$FOCUS_LOG"; exit 1; }
# Apart from `--focus false`, the opted-in argv is the default one: same cwd, same child.
[ "$(grep -- '^new-workspace ' "$FOCUS_LOG" | head -1)" = "new-workspace --focus false ${expected_default_argv#new-workspace }" ] \
  || { echo "FAIL: the opted-in argv differs from the default by more than --focus false
got : $(grep -- '^new-workspace ' "$FOCUS_LOG" | head -1)"; exit 1; }

# C: opted in, support documented on CONTINUATION lines. A check requiring `new-workspace`
# and `--focus` on one line would refuse this cmux; the option IS there.
: > "$FOCUS_LOG"
[ "$(T23_CMUX_HELP=continuation AIGENTRY_CMUX_BACKGROUND_SPAWN=1 open_focus_fixture)" = workspace:56 ] \
  || { echo 'FAIL: a help layout with the option on a continuation line must count as support'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^new-workspace --focus false --cwd ' "$FOCUS_LOG" \
  || { echo 'FAIL: continuation-line support did not reach the spawn'; cat "$FOCUS_LOG"; exit 1; }

# D: opted in, and the ONLY match is a longer option that begins with --focus. A
# `new-workspace.*--focus` grep matches this and spawns with an argument this cmux never
# documented; the exact-token rule must refuse instead, and refuse before new-workspace.
: > "$FOCUS_LOG"
rc=0; out5=$(T23_CMUX_HELP=prefix-only AIGENTRY_CMUX_BACKGROUND_SPAWN=1 open_focus_fixture 2> "$T_TMP/focus.err") || rc=$?
[ "$rc" = 2 ] || { echo "FAIL: --focus-follows-mouse must not read as support (rc=$rc)"; cat "$T_TMP/focus.err"; exit 1; }
[ -z "$out5" ] || { echo "FAIL: a refused spawn must emit no ref, got '$out5'"; exit 1; }
grep -q CMUX_FOCUS_UNSUPPORTED "$T_TMP/focus.err" \
  || { echo 'FAIL: the refusal did not name CMUX_FOCUS_UNSUPPORTED'; cat "$T_TMP/focus.err"; exit 1; }
grep -q -- '^new-workspace' "$FOCUS_LOG" \
  && { echo 'FAIL: a workspace was spawned despite the refusal — there must be no fallback'; cat "$FOCUS_LOG"; exit 1; }

# E: opted in on a cmux that does not document the option at all — the same clean refusal.
: > "$FOCUS_LOG"
rc=0; T23_CMUX_HELP=no-focus AIGENTRY_CMUX_BACKGROUND_SPAWN=1 open_focus_fixture \
  > "$T_TMP/focus.out" 2> "$T_TMP/focus.err" || rc=$?
[ "$rc" = 2 ] && [ ! -s "$T_TMP/focus.out" ] && grep -q CMUX_FOCUS_UNSUPPORTED "$T_TMP/focus.err" \
  || { echo 'FAIL: an old cmux must be refused with exit 2 and no ref when opted in'; cat "$T_TMP/focus.err"; exit 1; }
grep -q -- '^new-workspace' "$FOCUS_LOG" \
  && { echo 'FAIL: the refusal reached new-workspace'; cat "$FOCUS_LOG"; exit 1; }

# F: a probe that could not be READ is reported as such, NOT as an old cmux. Telling the
# operator to upgrade in both cases is wrong: a non-zero `--help` and a silent `--help` are
# "unknown", and conflating them sends people after the wrong fault.
for layout in rc-nonzero silent; do
  : > "$FOCUS_LOG"
  rc=0; T23_CMUX_HELP=$layout AIGENTRY_CMUX_BACKGROUND_SPAWN=1 open_focus_fixture \
    > "$T_TMP/focus.out" 2> "$T_TMP/focus.err" || rc=$?
  [ "$rc" = 2 ] || { echo "FAIL: help layout '$layout' did not refuse with exit 2 (rc=$rc)"; cat "$T_TMP/focus.err"; exit 1; }
  grep -q CMUX_FOCUS_PROBE_FAILED "$T_TMP/focus.err" \
    || { echo "FAIL: help layout '$layout' must be reported as an unreadable PROBE, not as a missing feature"; cat "$T_TMP/focus.err"; exit 1; }
  grep -q CMUX_FOCUS_UNSUPPORTED "$T_TMP/focus.err" \
    && { echo "FAIL: help layout '$layout' claimed the option is unsupported when the probe only failed"; cat "$T_TMP/focus.err"; exit 1; }
  grep -q -- '^new-workspace' "$FOCUS_LOG" \
    && { echo "FAIL: help layout '$layout' spawned anyway"; cat "$FOCUS_LOG"; exit 1; }
done

# G: an unreadable SETTING refuses before anything is asked of cmux — not even the probe.
for setting in '' invalid 2 true; do
  : > "$FOCUS_LOG"
  rc=0; AIGENTRY_CMUX_BACKGROUND_SPAWN="$setting" open_focus_fixture \
    > "$T_TMP/focus.out" 2> "$T_TMP/focus.err" || rc=$?
  [ "$rc" = 2 ] || { echo "FAIL: setting '$setting' did not refuse with exit 2 (rc=$rc)"; exit 1; }
  [ ! -s "$FOCUS_LOG" ] || { echo "FAIL: setting '$setting' reached cmux before refusing"; cat "$FOCUS_LOG"; exit 1; }
  [ ! -s "$T_TMP/focus.out" ] || { echo "FAIL: setting '$setting' emitted a ref"; exit 1; }
  grep -q AIGENTRY_CMUX_BACKGROUND_SPAWN "$T_TMP/focus.err" \
    || { echo "FAIL: setting '$setting' did not name the setting on stderr"; cat "$T_TMP/focus.err"; exit 1; }
done

# H: 0 is spelled out and must be identical to absent — same argv, no probe.
: > "$FOCUS_LOG"
[ "$(T23_CMUX_HELP=no-focus AIGENTRY_CMUX_BACKGROUND_SPAWN=0 open_focus_fixture)" = workspace:56 ] \
  || { echo 'FAIL: AIGENTRY_CMUX_BACKGROUND_SPAWN=0 must behave exactly like absent'; cat "$FOCUS_LOG"; exit 1; }
[ "$(head -1 "$FOCUS_LOG")" = "$expected_default_argv" ] \
  || { echo 'FAIL: =0 changed the default argv'; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^--help' "$FOCUS_LOG" \
  && { echo 'FAIL: =0 probed --help'; cat "$FOCUS_LOG"; exit 1; }

# I: opted in, and `--focus` is documented only as a bare switch whose DESCRIPTION mentions
# bool. That is not a value syntax: refuse as UNSUPPORTED, before new-workspace.
: > "$FOCUS_LOG"
rc=0; T23_CMUX_HELP=described-switch AIGENTRY_CMUX_BACKGROUND_SPAWN=1 open_focus_fixture \
  > "$T_TMP/focus.out" 2> "$T_TMP/focus.err" || rc=$?
[ "$rc" = 2 ] && [ ! -s "$T_TMP/focus.out" ] && grep -q CMUX_FOCUS_UNSUPPORTED "$T_TMP/focus.err" \
  || { echo "FAIL: description text after a bare --focus switch must not read as support (rc=$rc)"; cat "$T_TMP/focus.err"; cat "$FOCUS_LOG"; exit 1; }
grep -q -- '^new-workspace' "$FOCUS_LOG" \
  && { echo 'FAIL: a bare --focus switch was handed --focus false'; cat "$FOCUS_LOG"; exit 1; }

# ── AIGENTRY_WORKER_AUTO_RESTART: the per-launch retry budget of the cmux adapter ──
# Executes the GENERATED child command against an argv-only telepty stub: nothing starts a
# real CLI, a daemon or a bridge. The stub records the argv `telepty allow` was handed and
# the cwd it ran in, which is the whole contract under test — the flag is present by
# default, absent at 0, and an unreadable value refuses before cmux is called at all.
cat > "$STUB_BIN/telepty" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$T_TMP/allow-argv"
printf '%s\n' "$PWD" > "$T_TMP/allow-cwd"
EOF
cat > "$STUB_BIN/cmux-open" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$1" >> "$T_TMP/open-calls"
case "$1" in
  # Serves block J only: it is the one case that opts into background creation through
  # this stub. Every other case here leaves that setting unset, so they never probe.
  --help) echo '  new-workspace [--focus <true|false>] [--cwd <dir>] [--command <cmd>]';;
  new-workspace)
    shift
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --command ]; then bash -c "$2" || exit; break; fi
      shift
    done
    echo 'OK workspace:23';;
  list-workspaces) echo 'workspace:23 fixture';;
  surface-health) echo 'type=terminal';;
  read-screen) [ "${T23_NOT_READY:-0}" = 1 ] || echo 'fixture prompt';;
  *) :;;
esac
EOF
chmod +x "$STUB_BIN/telepty" "$STUB_BIN/cmux-open"
# A cwd containing a space: the %q quoting of --command must survive being typed in.
mkdir -p "$T_TMP/cwd with space"
open_fixture() (
  export CMUX="$STUB_BIN/cmux-open" CMUX_READY_TIMEOUT_MS=1 CMUX_READY_INTERVAL_MS=1
  . "$REPO_ROOT/bin/lib/workspace-host.sh"
  _wh_cmux_open 'fixture-t23' "$T_TMP/cwd with space" 'fixture-cli --fixture-only'
)
for setting in unset 1 0; do
  if [ "$setting" = unset ]; then unset AIGENTRY_WORKER_AUTO_RESTART;
  else export AIGENTRY_WORKER_AUTO_RESTART="$setting"; fi
  [ "$(open_fixture)" = workspace:23 ] \
    || { echo "FAIL: open result for AIGENTRY_WORKER_AUTO_RESTART=$setting"; exit 1; }
  printf '%s\n' allow --id fixture-t23 > "$T_TMP/expected-argv"
  [ "$setting" = 0 ] || printf '%s\n' --auto-restart >> "$T_TMP/expected-argv"
  printf '%s\n' fixture-cli --fixture-only >> "$T_TMP/expected-argv"
  cmp "$T_TMP/expected-argv" "$T_TMP/allow-argv" \
    || { echo "FAIL: restart argv for setting=$setting"; exit 1; }
  [ "$(cat "$T_TMP/allow-cwd")" = "$T_TMP/cwd with space" ] \
    || { echo "FAIL: the child did not inherit the quoted cwd (setting=$setting)"; exit 1; }
done
# An empty or unrecognized value is refused, and refused BEFORE cmux is invoked.
for setting in '' invalid 2 true; do
  : > "$T_TMP/open-calls"
  export AIGENTRY_WORKER_AUTO_RESTART="$setting"
  rc=0; open_fixture > "$T_TMP/invalid.out" 2> "$T_TMP/invalid.err" || rc=$?
  [ "$rc" = 2 ] || { echo "FAIL: value '$setting' did not refuse with exit 2 (rc=$rc)"; exit 1; }
  [ ! -s "$T_TMP/open-calls" ] || { echo "FAIL: value '$setting' reached cmux before refusing"; exit 1; }
  [ ! -s "$T_TMP/invalid.out" ] || { echo "FAIL: value '$setting' emitted a ref"; exit 1; }
  grep -q AIGENTRY_WORKER_AUTO_RESTART "$T_TMP/invalid.err" \
    || { echo "FAIL: value '$setting' did not name the setting on stderr"; exit 1; }
done
# The readiness barrier is unchanged by the new setting: still exit 3, still no ref, still
# a closed workspace.
export AIGENTRY_WORKER_AUTO_RESTART=0 T23_NOT_READY=1
: > "$T_TMP/open-calls"
rc=0; open_fixture > "$T_TMP/not-ready.out" 2> "$T_TMP/not-ready.err" || rc=$?
[ "$rc" = 3 ] && [ ! -s "$T_TMP/not-ready.out" ] && grep -qx close-workspace "$T_TMP/open-calls" \
  || { echo 'FAIL: readiness refusal changed'; exit 1; }
unset AIGENTRY_WORKER_AUTO_RESTART T23_NOT_READY

# J: BOTH settings at once — background creation opted in AND automatic restart off for this
# launch. They are independent: the argv gains `--focus false` and the child loses
# ` --auto-restart`, and nothing else moves. Checked through both stubs: the focus stub
# records the exact new-workspace argv, and the restart stub executes the generated child, so
# the argv `telepty allow` really receives is checked too.
: > "$FOCUS_LOG"
[ "$(AIGENTRY_CMUX_BACKGROUND_SPAWN=1 AIGENTRY_WORKER_AUTO_RESTART=0 open_focus_fixture)" = workspace:56 ] \
  || { echo 'FAIL: both settings at once did not emit the ref'; cat "$FOCUS_LOG"; exit 1; }
expected_both_argv="new-workspace --focus false --cwd $T_TMP/focus-cwd --command bash -c 'cd \"\$1\" && exec telepty allow --id \"\$2\" fixture-cli --fixture-only' _ $t23_q_cwd fixture-t23-focus"
[ "$(grep -- '^new-workspace ' "$FOCUS_LOG" | head -1)" = "$expected_both_argv" ] \
  || { echo "FAIL: the combined argv is wrong
want: $expected_both_argv
got : $(grep -- '^new-workspace ' "$FOCUS_LOG" | head -1)"; exit 1; }
[ "$(grep -n -- '^--help$' "$FOCUS_LOG" | head -1 | cut -d: -f1)" -lt \
  "$(grep -n -- '^new-workspace ' "$FOCUS_LOG" | head -1 | cut -d: -f1)" ] \
  || { echo 'FAIL: with both settings the support probe did not run before the spawn'; cat "$FOCUS_LOG"; exit 1; }
: > "$T_TMP/open-calls"; rm -f "$T_TMP/allow-argv" "$T_TMP/allow-cwd"
[ "$(AIGENTRY_CMUX_BACKGROUND_SPAWN=1 AIGENTRY_WORKER_AUTO_RESTART=0 open_fixture)" = workspace:23 ] \
  || { echo 'FAIL: both settings at once (executed child) did not emit the ref'; cat "$T_TMP/open-calls"; exit 1; }
[ "$(head -2 "$T_TMP/open-calls" | tr '\n' ' ')" = '--help new-workspace ' ] \
  || { echo 'FAIL: with both settings the stub did not see the probe and then the spawn'; cat "$T_TMP/open-calls"; exit 1; }
printf '%s\n' allow --id fixture-t23 fixture-cli --fixture-only > "$T_TMP/expected-argv"
cmp "$T_TMP/expected-argv" "$T_TMP/allow-argv" \
  || { echo 'FAIL: with both settings telepty allow still got --auto-restart (or another argv change)'; exit 1; }
[ "$(cat "$T_TMP/allow-cwd")" = "$T_TMP/cwd with space" ] \
  || { echo 'FAIL: with both settings the child did not inherit the quoted cwd'; exit 1; }

echo "T23 PASS"
