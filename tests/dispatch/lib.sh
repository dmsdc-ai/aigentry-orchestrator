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
  [ -n "${T_TMP:-}" ] && rm -rf "$T_TMP"
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
