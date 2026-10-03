#!/usr/bin/env bash
# Shared harness for tests/dispatch/*. Provides tmp-state, stub PATH, JSON helpers.
#
# ══════════════════════════════════════════════════════════════════════════════════
# THE RULE: A GUARD MUST NOT BE ABLE TO REACH THE LIVE WORKSPACE.
#
# Read this before you write a guard that needs a real binary, a lister seam, or a
# PATH of its own. It is here rather than in a report because this is the file you
# are already sourcing.
#
# The harness gives you the safe posture for free. t_setup exports an absolute
# TELEPTY pointing at a stub, puts $STUB_BIN first on PATH, redirects
# DISPATCH_STATE_DIR and AIGENTRY_ROLE_SANDBOX_DIR into $T_TMP, and switches the bus
# bridge and sleep guard off. An absolute TELEPTY beats PATH, so as long as you leave
# it alone you cannot reach the operator's daemon. THREE THINGS TAKE IT AWAY:
#
#   1. unsetting or clearing TELEPTY          (`env -u TELEPTY`)
#   2. replacing PATH wholesale               (`PATH=/usr/bin:/bin`)
#   3. not calling t_setup at all
#
# If you do ANY of them, you are responsible for the reach yourself. What to do:
#
#   * USE A FIXTURE SID. This is the rule, not the belt. A guard that drives
#     ORCHESTRATOR_SID=<something-that-is-not-`orchestrator`> cannot disturb the live
#     session even when it does resolve a real binary — it removes the REACH rather
#     than the resolution, and resolution is the thing this repo cannot prevent (the
#     shims append /opt/homebrew/bin themselves; see #930 and bin/session-cleanup.sh
#     :34-41). Every other defence is downstream of a binary being found.
#   * ADD A TRIPWIRE. Point TELEPTY at a recorder that FAILS your guard if invoked,
#     then assert its log is empty. That converts "this test does not touch
#     production" from a promise into an assertion. tests/dispatch/T137 does both.
#   * KEEP THE FIXTURE INERT. If your stub lister reports two bridges, the code under
#     test will try to act on two bridges. Prefer a fixture that stops short of the
#     acting path when the acting path is not what you are measuring.
#   * IF YOU GENUINELY NEED THE REAL CLI, gate it: `AIGENTRY_RUN_LIVE_TESTS=1`, and
#     declare the skip in run-all.sh's EXPECTED_SKIPS_* with a reason. T95 is the
#     model — real daemon, but under a temp HOME on an ephemeral port bound to
#     127.0.0.1, never :3848. T16 and T48 are the same shape.
#
# WHY THIS IS WRITTEN DOWN. On 2026-08-23 T137 — the guard added to prove that a
# hardcoded /opt/homebrew/bin PATH prefix is dangerous — reached the production daemon
# THROUGH that prefix. It unset TELEPTY to prove a shim can still find `node` under
# launchd, and the shim duly resolved a real `telepty` off the appended homebrew path.
# It sent four genuine duplicate-bridge HOLDs into the operator's live session naming
# fixture pids that do not exist, and cost a human an investigation into a phantom.
# The auditor was blameless: it faithfully reported what its stubbed lister said.
#
# AND THE PART THAT IS EASIER TO FORGET, so it is recorded next to the incident: the
# audit that followed found the class had EXACTLY ONE member, and that no guard in
# this suite can reach anything DESTRUCTIVE. `pkill` appears nowhere. Every kill site
# routes through a stubbed KILL_CMD seam (T40, T131) or targets the guard's own parent
# to simulate a crash (T79), and T127 block K and T57 block E assert a kill recorder
# stays EMPTY. The one historical near-miss — a reconcile tick that closed SEVEN REAL
# cmux workspaces — is why t_setup redirects AIGENTRY_ROLE_SANDBOX_DIR (see :17-22).
# So: the posture is sound, and it is sound because of these redirections rather than
# by luck. Do not read the incident as "the suite is unsafe"; read it as "the safety
# is in t_setup, and stepping outside t_setup is stepping outside the safety".
#
# run-all.sh installs a backstop tripwire `telepty` on PATH when AIGENTRY_RUN_LIVE_TESTS
# is not 1. It does NOT cover case 2 above, and says so where it is defined.
# ══════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

TEST_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_LIB_DIR/../.." && pwd -P)"

t_setup() {
  local setup_tmp tmp_root
  # An explicit TMPDIR must never fall back to the host temporary directory.
  if [ "${TMPDIR+x}" = x ]; then
    if [ -z "$TMPDIR" ]; then
      printf '%s\n' 't_setup: TMPDIR must not be empty' >&2
      return 1
    fi
    tmp_root="$TMPDIR"
    case "$tmp_root" in
      /*) ;;
      *) tmp_root="$PWD/$tmp_root" ;;
    esac
    setup_tmp=$(mktemp -d "${tmp_root%/}/tmp.XXXXXXXXXX") || return $?
  else
    setup_tmp=$(mktemp -d) || return $?
  fi
  # Env hygiene: the suite may be run FROM a worker session (which exports
  # AIGENTRY_WORKER_SESSION=1, dispatch.sh:97). The orchestrator-only guard in
  # session-cleanup.sh (#524) would then refuse on every orchestrator-path test.
  # Tests that exercise the worker guard (T28/T34) set this marker inline per
  # invocation, so clearing the inherited value here is safe and deterministic.
  unset AIGENTRY_WORKER_SESSION
  T_TMP="$setup_tmp"
  export T_TMP
  # A reconciler tick under test runs wh_prune_orphans, whose ONLY ownership gate
  # is "workspace cwd under $AIGENTRY_ROLE_SANDBOX_DIR" (workspace-host.sh:182).
  # With the real default a test that ticks twice closes live workers' cmux
  # workspaces for real (observed: 7 closed by T63's 3-tick run). Point ownership
  # at the tmpdir so no test can ever match a real workspace.
  export AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/role-sandbox"
  # #847: a reconcile tick supervises the telepty bus→file bridge (step 0e), which
  # is a long-lived background process subscribed to the daemon's bus. Hermetic
  # means no test leaves one of those behind, so the harness ticks with the bridge
  # off; T95 turns it back on explicitly for the one test that exercises it.
  export AIGENTRY_BUS_BRIDGE=0
  # #909: open-session.sh holds a per-worker `caffeinate` assertion after a spawn.
  # Hermetic means no test asserts against the real host's power state, so the
  # harness spawns with the guard off; T100 turns it back on against a recorder
  # binary, which is the only place a hold_awake call is ever observed.
  export AIGENTRY_SLEEP_GUARD=0
  export DISPATCH_STATE_DIR="$T_TMP/state"
  mkdir -p "$DISPATCH_STATE_DIR"
  # telepty#60 Stage A: the registry is a versioned envelope, not a root array.
  printf '%s\n' '{"schema_version": 2, "generation": 0, "dispatches": []}' \
    > "$DISPATCH_STATE_DIR/active.json"
  export STUB_BIN="$T_TMP/stubbin"
  mkdir -p "$STUB_BIN"
  cp "$TEST_LIB_DIR/stubs/telepty" "$STUB_BIN/telepty"
  cp "$TEST_LIB_DIR/stubs/git"     "$STUB_BIN/git"
  cp "$TEST_LIB_DIR/stubs/dispatch.sh" "$STUB_BIN/dispatch.sh"
  chmod +x "$STUB_BIN"/*
  export PATH="$STUB_BIN:$PATH"
  export TELEPTY="$STUB_BIN/telepty"
  export GIT="$STUB_BIN/git"
  export DISPATCH_SH="$STUB_BIN/dispatch.sh"
  export STUB_SCREEN_FILE="$T_TMP/screen.txt"
  export STUB_INFO_FILE="$T_TMP/info.json"
  export STUB_LIST_FILE="$T_TMP/list.json"
  export STUB_GIT_LOG_FILE="$T_TMP/git-log.txt"
  export STUB_GIT_CONFIG_FILE="$T_TMP/git-email.txt"
  export STUB_GIT_SHORTSTAT_FILE="$T_TMP/git-shortstat.txt"
  export STUB_DISPATCH_LOG="$T_TMP/dispatch.log"
  : > "$STUB_DISPATCH_LOG"
  printf '%s' '[{"id":"sid-A","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
  printf '' > "$STUB_SCREEN_FILE"
  printf '%s' '{"id":"sid-A","command":"claude","healthStatus":"CONNECTED","ready":true,"transport":{"ready":true,"bootstrap":{"ready":true}}}' > "$STUB_INFO_FILE"
  printf '' > "$STUB_GIT_LOG_FILE"
  printf 'claude-bot@example.com' > "$STUB_GIT_CONFIG_FILE"
  printf '' > "$STUB_GIT_SHORTSTAT_FILE"
}

t_teardown() {
  if [ -n "${T_FIXTURE_CHILD_PID:-}" ]; then
    local child
    for child in $(jobs -pr); do
      [ "$child" != "$T_FIXTURE_CHILD_PID" ] || kill "$child" 2>/dev/null || true
    done
    wait "$T_FIXTURE_CHILD_PID" 2>/dev/null || true
    unset T_FIXTURE_CHILD_PID
  fi
  if [ -n "${T_FIXTURE_HELPER:-}" ] && [ -s "${T_TMP:-}/forbidden.log" ]; then
    cat "$T_TMP/forbidden.log" >&2
    rm -rf "$T_TMP"
    return 1
  fi
  [ -n "${T_TMP:-}" ] && rm -rf "$T_TMP"
}

# ── Opt-in: a BOUND current-viewport fixture (#751 / #1136) ───────────────────
# WHY THIS EXISTS. t_setup above supplies the LEGACY evidence pair: a minimal
# session-info object and a `telepty read-screen` ring. bin/session-probe.py no
# longer consults that ring on its live path at all (session-probe.py:546-559) —
# a stale ring reading as live evidence was the bug — and bin/current_screen.py
# admits a viewport only through an EXACT binding:
#   * locally connected and ready: id == sid, host 127.0.0.1, healthStatus and
#     transport.health_status CONNECTED, ready and transport.ready true, and
#     transport.bootstrap.ready true when present (session_binding)
#   * process identity: int ownerPid/ptyPid > 1, whose `ps -p … -o pid=,tty=,lstart=`
#     row names a tty and a start time (process_identity)
#   * incarnation: non-empty createdAt / lastConnectedAt strings
#   * a supported `backend`, and for cmux an exact workspace/surface UUID pair whose
#     window/pane/tty resolve to EXACTLY ONE terminal, read twice unchanged, with the
#     read-screen response echoing all three ids back (cmux_terminal / cmux_screen)
# t_setup's fixture cannot establish ANY of that, so every guard on the live path
# reads probe_error "session is not locally connected and ready" and surface
# unknown. That is a transport gap in the fixture, not a relaxed product gate: the
# helper below supplies the missing evidence and RELAXES NOTHING.
#
# t_current_view <sid> [cli] installs it. The screen text still comes from
# $STUB_SCREEN_FILE, so a guard keeps writing its fixture exactly as it always did.
# Identities are FIXTURE values built here — fake uuids, fixture pids, a fake tty and
# a frozen start time — never copied from a host, a real session or a real cmux tree.
# Both stubs answer only the bound target and refuse everything else non-zero
# (stubs/cmux, stubs/ps), so a mis-bound read still fails closed.
# Call it AFTER t_setup (which resets STUB_INFO_FILE) and only from a guard that means
# to measure the live path. Unrelated guards keep the legacy contract untouched:
# nothing above this line changed.
t_current_view() {
  local sid="${1:?t_current_view: sid required}" cli="${2:-claude}"
  export STUB_CMUX_WORKSPACE="f1136001-0000-4000-8000-000000000001"
  export STUB_CMUX_SURFACE="f1136002-0000-4000-8000-000000000002"
  export STUB_CMUX_WINDOW="f1136003-0000-4000-8000-000000000003"
  export STUB_CMUX_PANE="f1136004-0000-4000-8000-000000000004"
  export STUB_CMUX_SURFACE_TYPE=terminal
  export STUB_CMUX_TTY=ttys999
  export STUB_PS_PID=411360
  export STUB_PS_LSTART="Sun Aug 16 11:00:00 2026"
  export STUB_CMUX_LOG="$T_TMP/cmux.log"
  export STUB_PS_LOG="$T_TMP/ps.log"
  # The bound viewport serves $STUB_SCREEN_FILE unless a guard decouples it with
  # t_current_screen_file below. Reset here so the binding is deterministic whatever the
  # caller's environment carried, and so EVERY other guard keeps the existing behaviour.
  export STUB_CMUX_SCREEN_FILE=""
  : > "$STUB_CMUX_LOG"
  : > "$STUB_PS_LOG"
  cp "$TEST_LIB_DIR/stubs/cmux" "$STUB_BIN/cmux"
  cp "$TEST_LIB_DIR/stubs/ps"   "$STUB_BIN/ps"
  chmod +x "$STUB_BIN/cmux" "$STUB_BIN/ps"
  # The bound session info. ownerPid is the pid stubs/ps answers for; ptyPid is a
  # DISTINCT fixture pid, because the adapter matches the bridge's terminal and not
  # its child PTY. Both are fixture numbers: no live pid is ever looked up.
  STUB_CURRENT_SID="$sid" STUB_CURRENT_CLI="$cli" python3 - "$STUB_INFO_FILE" <<'PY'
import json, os, sys

json.dump({
    "id": os.environ["STUB_CURRENT_SID"],
    "command": os.environ["STUB_CURRENT_CLI"],
    "host": "127.0.0.1",
    "backend": "cmux",
    "healthStatus": "CONNECTED",
    "ready": True,
    "transport": {"health_status": "CONNECTED", "ready": True, "bootstrap": {"ready": True}},
    "ownerPid": int(os.environ["STUB_PS_PID"]),
    "ptyPid": int(os.environ["STUB_PS_PID"]) + 1,
    "createdAt": "2026-08-16T11:00:00Z",
    "lastConnectedAt": "2026-08-16T11:00:00Z",
    "cmuxWorkspaceId": os.environ["STUB_CMUX_WORKSPACE"],
    "cmuxSurfaceId": os.environ["STUB_CMUX_SURFACE"],
}, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False)
PY
}

# t_assert_current_view_read [label] — the POSITIVE CONTROL for t_current_view. Without
# it a guard cannot tell "the bound viewport was read" from "the probe never got there
# and something else happened to agree". Asserts the bound read-screen AND the
# owner-pid identity row were both actually consumed.
t_assert_current_view_read() {
  local label="${1:-current-view}"
  if ! grep -q 'read-screen' "${STUB_CMUX_LOG:?}" 2>/dev/null; then
    echo "FAIL: $label — the bound cmux read-screen was never consumed; the probe did not reach the current viewport" >&2
    echo "--- cmux.log ---" >&2; cat "$STUB_CMUX_LOG" >&2 || true
    exit 1
  fi
  if ! grep -qF -- "-p ${STUB_PS_PID:?}" "${STUB_PS_LOG:?}" 2>/dev/null; then
    echo "FAIL: $label — the bound owner-pid identity was never consumed" >&2
    echo "--- ps.log ---" >&2; cat "$STUB_PS_LOG" >&2 || true
    exit 1
  fi
}

# t_current_view_reset_log — start a fresh window for the two controls above, so a guard
# that probes SEVERAL viewports in one run measures each probe rather than the union of
# all of them. Never changes the binding; only truncates the invocation records.
t_current_view_reset_log() {
  : > "${STUB_CMUX_LOG:?}"
  : > "${STUB_PS_LOG:?}"
  [ -z "${STUB_TELEPTY_LOG:-}" ] || : > "$STUB_TELEPTY_LOG"
}

# t_current_screen_file <path> — serve <path> as the BOUND CURRENT viewport, decoupled
# from $STUB_SCREEN_FILE (which stays the legacy `telepty read-screen` ring). Opt-in and
# unset by default, so every other guard's bound read keeps serving $STUB_SCREEN_FILE
# verbatim. It exists for the one thing a single shared file cannot express: history and
# live viewport holding DIFFERENT text at the same moment, which is exactly T5's premise.
t_current_screen_file() {
  export STUB_CMUX_SCREEN_FILE="${1:?t_current_screen_file: path required}"
}

# t_history_read_tripwire — make "the live path never consulted the historical ring" an
# ASSERTION instead of a promise (#751). Wraps the existing stubs/telepty: the copy
# t_setup installed is moved aside and still answers every verb byte-identically, so no
# stub BEHAVIOUR changes here — the wrapper only appends the argv to a log first. Call it
# after t_setup and before the probe; pairs with t_assert_no_history_screen_read.
t_history_read_tripwire() {
  export STUB_TELEPTY_LOG="$T_TMP/telepty-argv.log"
  : > "$STUB_TELEPTY_LOG"
  if [ ! -x "$STUB_BIN/telepty-inner" ]; then
    mv "$STUB_BIN/telepty" "$STUB_BIN/telepty-inner"
    cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$STUB_TELEPTY_LOG"
exec "$STUB_BIN/telepty-inner" "\$@"
EOF
    chmod +x "$STUB_BIN/telepty"
  fi
}

# t_assert_no_history_screen_read [label] — the NEGATIVE control paired with
# t_assert_current_view_read. The live readiness path reads a bound CURRENT viewport and
# has no fallback to the historical ring (session-probe.py:546-559); this asserts that,
# rather than inferring it from a verdict that happened to come out right. Only
# `read-screen` is refused — every other stub-telepty verb stays legitimate.
t_assert_no_history_screen_read() {
  local label="${1:-current-view}"
  if grep -q '^read-screen' "${STUB_TELEPTY_LOG:?}" 2>/dev/null; then
    echo "FAIL: $label — the historical telepty read-screen ring was consulted on the live path" >&2
    echo "--- telepty-argv.log ---" >&2; cat "$STUB_TELEPTY_LOG" >&2 || true
    exit 1
  fi
}

# Opt-in for the confined dispatch fixtures. Keep unrelated guards unchanged.
# Start the owned child in the test shell, never inside $(run_dispatch ...), so
# the EXIT trap can always kill AND reap it, including after a dispatch crash.
t_confined_setup() {
  local name
  while IFS= read -r name; do
    case "$name" in
      PATH|TMPDIR|LANG|LC_*|TERM|SHELL|T_TMP|STUB_*|DISPATCH_STATE_DIR|TELEPTY|GIT|DISPATCH_SH|REPO_ROOT|TEST_LIB_DIR|HERE) ;;
      *) unset "$name" 2>/dev/null || true ;;
    esac
  done < <(compgen -e)
  export AIGENTRY_DISPATCH_CALLER=confined-dispatch-fixture
  T_TMP="$(cd "$T_TMP" && pwd -P)"
  export T_TMP HOME="$T_TMP/home" USERPROFILE="$T_TMP/home"
  export XDG_CONFIG_HOME="$T_TMP/home/.config" XDG_CACHE_HOME="$T_TMP/home/.cache"
  export CODEX_HOME="$T_TMP/codex-home" CLAUDE_CONFIG_DIR="$T_TMP/home/.claude"
  export GEMINI_CLI_HOME="$T_TMP/gemini-home" PYTHONDONTWRITEBYTECODE=1
  export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
  export AIGENTRY_HOME="$T_TMP/home/.aigentry" AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions"
  export AIGENTRY_ROLE_SANDBOX_DIR="$T_TMP/role-sandbox"
  export AIGENTRY_BUS_BRIDGE=0 AIGENTRY_SLEEP_GUARD=0
  export AIGENTRY_TASK_QUEUE="$T_TMP/fixture-queue.json" AIGENTRY_TASK_GATE=hard
  export AIGENTRY_GIT_HOOKS_DIR="$T_TMP/hooks" AIGENTRY_GIT_HOOK_SOURCE_DIR="$REPO_ROOT/git-hooks"
  export AIGENTRY_WORKER_SCOPE="$T_TMP/scope.json"
  export T_FIXTURE_HELPER="$TEST_LIB_DIR/confined-fixture.mjs"
  export T_FIXTURE_NODE="$(command -v node)"
  # Canonical, private temp path also avoids the production macOS /var/folders
  # short-socket fallback to host /tmp. Never grant access to the host tmp root.
  mkdir -p "$T_TMP/tmp"
  export TMPDIR="$T_TMP/tmp" TMP="$T_TMP/tmp" TEMP="$T_TMP/tmp"
  "$T_FIXTURE_NODE" "$T_FIXTURE_HELPER" init
  export SESSION_PROBE_PY="$STUB_BIN/fixture-probe"
  export OPEN_SESSION_SH="$STUB_BIN/fixture-deny"
  export EMIT_TELEMETRY_MJS="$STUB_BIN/fixture-noop" REPORT_TARGET_SH="$STUB_BIN/fixture-report"
  "$T_FIXTURE_NODE" -e 'setTimeout(() => {}, 120000)' </dev/null >/dev/null 2>&1 &
  T_FIXTURE_CHILD_PID=$!
  export T_FIXTURE_CHILD_PID
}

t_confined_target() {
  "$T_FIXTURE_NODE" "$T_FIXTURE_HELPER" target "$1" "${2:-}"
}

t_confined_scope() {
  "$T_FIXTURE_NODE" "$T_FIXTURE_HELPER" scope "$1" "$2" "$3"
}

t_assert_contains() {
  local file="$1" needle="$2"
  # `--` ends option parsing so a needle starting with `-`/`--` (e.g. an inject's
  # `--from <sid>` flag, T44) is matched literally rather than mis-read as a grep
  # option (ugrep/BSD grep both reject leading-dash patterns otherwise).
  if ! grep -qF -- "$needle" "$file" 2>/dev/null; then
    echo "FAIL: $file does not contain: $needle" >&2
    echo "--- file content ---" >&2
    cat "$file" >&2 || true
    exit 1
  fi
}

t_run_tracker() {
  TRACKER_NOW="${TRACKER_NOW:-2026-05-12T12:00:00Z}" \
    "$REPO_ROOT/bin/dispatch-tracker.sh" "$@"
}

# --- schema-v2 registry helpers (telepty#60 Stage A) -----------------------
# The registry is a versioned envelope, not a root array, and a dispatch has
# four independent axes (outcome / lifecycle / gate / observations). There is no
# `status` string and no assertion helper for one: outcome is created "unknown"
# and 0.8.0 has no writer that can move it.

t_registry() { "$REPO_ROOT/bin/dispatch-registry.py" "$@"; }

# t_stub_v2_observations [kind] — curl shim answering the per-inject observation
# endpoint with a VALID schema-v2 body. Absence is already covered by T81; a test
# that wants to reach the screen/git evidence chain needs the daemon half to
# answer properly, because named absence deliberately blocks that fallback.
# Seed the dispatch with transport.inject_id set, or the poll never happens.
t_stub_v2_observations() {
  local kind="${1:-pty_quiet}"
  cat > "$STUB_BIN/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T_TMP/curl.log"
printf '%s' '{"type":"task_completion_unknown","schema_version":2,"completion_fact":null,"terminal":false,"observation":{"kind":"$kind","trigger":"silence_timeout","elapsed_ms":5000},"consumption":{"status":"not_established"},"capability":{"outcome_protocol":"unavailable"}}'
printf '\n200'
EOF
  chmod +x "$STUB_BIN/curl"
  export CURL="$STUB_BIN/curl"
}

# t_run_dispatch <args…> — the REAL bin/dispatch.sh, hermetic: temp HOME (so the
# legacy sidecar dir and telemetry land in $T_TMP), stub telepty, always-ready
# probe stub, no telemetry subprocess. Returns dispatch.sh's exit code.
t_run_dispatch() {
  local probe="$T_TMP/probe-ready" noop="$T_TMP/noop"
  if [ ! -x "$probe" ]; then
    cat > "$probe" <<'SH'
#!/usr/bin/env bash
echo '{"ready":true}'
SH
    chmod +x "$probe"
  fi
  if [ ! -x "$noop" ]; then
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$noop"
    chmod +x "$noop"
  fi
  HOME="$T_TMP/home" \
  AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions" \
  SESSION_PROBE_PY="$probe" \
  EMIT_TELEMETRY_MJS="$noop" \
  TELEPTY="$STUB_BIN/telepty" \
    "$REPO_ROOT/bin/dispatch.sh" "$@"
}

# t_init_v2 — empty schema-v2 envelope (t_setup also seeds this; explicit calls
# stay valid and idempotent).
t_init_v2() {
  printf '%s\n' '{"schema_version": 2, "generation": 0, "dispatches": []}' \
    > "$DISPATCH_STATE_DIR/active.json"
}

# t_seed_dispatch <sid> [dotted.path=value ...] — a complete, schema-valid v2
# record. Values are parsed as JSON when possible, else kept as a string, so
# `re_dispatch_count=2`, `keep_alive=true` and `transport.inject_id=null` all
# work. Defaults mirror what begin-delivery creates.
t_seed_dispatch() {
  local sid="$1"; shift
  SEED_SID="$sid" python3 - "$DISPATCH_STATE_DIR/active.json" "$@" <<'PY'
import json, os, sys

path, overrides = sys.argv[1], sys.argv[2:]
sid = os.environ["SEED_SID"]
now = "2026-05-12T11:00:00Z"
rec = {
    "dispatch_id": "disp-" + sid,
    "assigned": {"sid": sid, "session_epoch": None},
    "dedup": {"key": "dedup-" + sid, "ref_hash": "x"},
    "outcome": {"state": "unknown", "reported_value": None, "basis": None},
    "lifecycle": {"state": "delivery_attempt_started", "at": now},
    "transport": {"result": "unknown", "inject_id": None, "at": None},
    "gate": {"state": None, "prev_lifecycle": None},
    "last_observation": {"kind": "dispatch_tracking_started", "terminal": False, "at": now},
    "observations": [{"kind": "dispatch_tracking_started", "terminal": False, "at": now}],
    "ref_path": "/tmp/r",
    "dispatched_at": now,
    "expected_report_by": "2026-05-12T11:30:00Z",
    "last_seen_at": now,
    "cwd": "",
    "from_sid": "orchestrator",
    "re_dispatch_count": 0,
    "keep_alive": False,
}
seen = set()
for item in overrides:
    key, _, raw = item.partition("=")
    seen.add(key)
    try:
        val = json.loads(raw)
    except Exception:
        val = raw
    cur = rec
    parts = key.split(".")
    for part in parts[:-1]:
        cur = cur.setdefault(part, {})
    cur[parts[-1]] = val
# The dedup key is derived, not decorative: a seeded record must be matchable by
# the same (sid, ref_hash) key begin-delivery computes, unless a test pins it.
if "dedup.key" not in seen:
    import hashlib
    rec["dedup"]["key"] = hashlib.sha256(
        (sid + "\x00" + str(rec["dedup"]["ref_hash"])).encode("utf-8")).hexdigest()
try:
    doc = json.load(open(path, encoding="utf-8"))
except Exception:
    doc = None
if not isinstance(doc, dict) or doc.get("schema_version") != 2:
    doc = {"schema_version": 2, "generation": 0, "dispatches": []}
doc["dispatches"].append(rec)
doc["generation"] = int(doc.get("generation", 0)) + 1
json.dump(doc, open(path, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
PY
}

# t_v2 <sid> <dotted.path> — print one field of a v2 record ("null" for None).
t_v2() {
  local sid="$1" pointer="$2"
  python3 - "$DISPATCH_STATE_DIR/active.json" "$sid" "$pointer" <<'PY'
import json, sys
path, sid, pointer = sys.argv[1:4]
doc = json.load(open(path, encoding="utf-8"))
for rec in doc.get("dispatches", []):
    if rec.get("assigned", {}).get("sid") != sid:
        continue
    cur = rec
    for part in pointer.split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
    print("null" if cur is None else (cur if isinstance(cur, str) else json.dumps(cur)))
    sys.exit(0)
print("__NO_RECORD__")
sys.exit(1)
PY
}

t_assert_v2() {
  local sid="$1" pointer="$2" want="$3" got
  got=$(t_v2 "$sid" "$pointer") || true
  if [ "$got" != "$want" ]; then
    echo "FAIL: $sid $pointer = ${got:-<empty>}, want $want" >&2
    exit 1
  fi
}

# The invariant every other assertion leans on: 0.8.0 never moves outcome.
t_assert_outcome_unknown() {
  t_assert_v2 "$1" outcome.state unknown
  t_assert_v2 "$1" outcome.reported_value null
}

t_assert_lifecycle() { t_assert_v2 "$1" lifecycle.state "$2"; }
t_assert_gate()      { t_assert_v2 "$1" gate.state "$2"; }

t_assert_observation() {
  local sid="$1" kind="$2"
  python3 - "$DISPATCH_STATE_DIR/active.json" "$sid" "$kind" <<'PY'
import json, sys
path, sid, kind = sys.argv[1:4]
doc = json.load(open(path, encoding="utf-8"))
for rec in doc.get("dispatches", []):
    if rec.get("assigned", {}).get("sid") != sid:
        continue
    kinds = [o.get("kind") for o in rec.get("observations", [])]
    if kind in kinds:
        sys.exit(0)
    print(f"FAIL: {sid} has no observation {kind!r}; got {kinds}", file=sys.stderr)
    sys.exit(1)
print(f"FAIL: no dispatch record for {sid}", file=sys.stderr)
sys.exit(1)
PY
}

t_refute_observation() {
  local sid="$1" kind="$2"
  if t_assert_observation "$sid" "$kind" 2>/dev/null; then
    echo "FAIL: $sid must NOT carry observation $kind" >&2
    exit 1
  fi
}
