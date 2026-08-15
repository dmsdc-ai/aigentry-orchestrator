#!/usr/bin/env bash
# dispatch.sh — Wraps `telepty inject` with REPL-ready wait so the first
#               dispatch to a freshly-spawned session is not lost to the
#               welcome-bootstrap race. Orchestrator-side workaround for
#               telepty#18 (https://github.com/dmsdc-ai/aigentry-telepty/issues/18).
#               헌법 Rule 32 영구 fix mandate (codified 2026-05-12 after 5+ recurrences,
#               until telepty-side handshake / wait-ready / queue lands).
#
# Modes:
#   dispatch.sh --target <sid> --ref <file> [--from <orch-sid>] [--timeout-ms 30000]
#   dispatch.sh --spawn-and-dispatch --track T --name N --cwd P --cli claude \
#               --ref <file> [--from <orch-sid>] [--role coder|architect|...] [--worktree P]
#   dispatch.sh --help
#
# Rule 34 task-gate (#736): every dispatch must name the task it actuates.
#   --task <id>           id from state/task-queue.json; status must be one of
#                         pending|queued|in_progress|delegated|blocked-by-observation.
#                         A confirmed dispatch auto-ledgers it (→ delegated + note).
#   --no-task "<reason>"  audited exemption (NDJSON line to
#                         ~/.aigentry/telemetry/dispatch-notask-<UTC-date>.ndjson).
#   AIGENTRY_TASK_GATE=hard|warn|off (default hard) — warn audits+proceeds, off = legacy.
#   AIGENTRY_TASK_QUEUE=<path> overrides the queue (default <repo>/state/task-queue.json).
#
# --role (cli=claude|codex|gemini, #431 / #532): wires boot-prepare.mjs so the
#   wrapped CLI skips project context-file auto-discovery (the cwd→role
#   contamination exposed by the 2026-05-23 incident). claude uses
#   `--append-system-prompt-file`; codex/gemini use the additive path (staged cwd
#   AGENTS.md/GEMINI.md + CODEX_HOME/GEMINI_CLI_HOME shadow home). Omit --role to
#   use the legacy spawn (back-compat).
#
# Registration wait (#727): a freshly spawned worker needs tens of seconds to
#   appear in `telepty list` (workspace boot → CLI boot → bridge registration).
#   The spawn path polls every 5s up to AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS
#   (default 180000) before giving up with exit 6, so a slow spawn stays on the
#   gated path instead of being hand-recovered with a raw `telepty inject`
#   (which bypasses the task-gate ledger, delivery confirm and tracker register).
#   --target keeps the historical fail-fast; set the knob to make it wait too.
#
# Ready detection: per-CLI prompt-symbol probe of `telepty read-screen` plus
# welcome/boot banner absence (claude ❯ / codex › / gemini ›|│ >).
#
# Post-dispatch START verification (Rule 33, default ON): after a successful
#   inject, dispatch-verify.sh confirms the session actually STARTED WORKING as
#   intended (CONNECTED + ready + clean surface + activity) — not just that the
#   inject landed. A SUSPECT verdict is printed loudly but is non-fatal (the
#   inject did land); resolve the surface before treating the worker as started.
#   Opt out with --no-verify-started.
#
# Exit codes: 0 OK, 1 timeout, 2 spawn failed, 3 inject failed, 4 usage,
#             5 --verify-delivered detected delivery failure,
#             6 session never registered in telepty list (#727),
#             7 DELIVERY_UNKNOWN_RETRY_HELD (also: --verify-delivered could not
#               read the screen back, so delivery is unknown rather than failed),
#             8 DEDUPLICATED_NO_NEW_DELIVERY,
#             9 DISPATCH_NOT_RECORDED (registry failure; telepty was never called).
#
# telepty#60 Stage A: exit 0 means BOTH a new telepty transport write AND its
# durable registry commit succeeded. It is the only code that authorizes an
# automatic re-dispatch caller to advance its counter/deadline — 7 and 8 are
# "no new delivery happened", which used to be indistinguishable from success.
set -euo pipefail
if [ "${DISPATCH_SH_NO_MAIN:-0}" != "1" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DISPATCH_REGISTRY_PY="${DISPATCH_REGISTRY_PY:-$SCRIPT_DIR/dispatch-registry.py}"
VERIFY_SH="$SCRIPT_DIR/dispatch-verify.sh"
OPEN_SESSION_SH="${OPEN_SESSION_SH:-$SCRIPT_DIR/open-session.sh}"
SESSION_PROBE_PY="${SESSION_PROBE_PY:-$SCRIPT_DIR/session-probe.py}"
TELEPTY="${TELEPTY:-telepty}"
EMIT_TELEMETRY_MJS="${EMIT_TELEMETRY_MJS:-$SCRIPT_DIR/emit-telemetry.mjs}"
REPORT_TARGET_SH="${REPORT_TARGET_SH:-$SCRIPT_DIR/orchestrator-report-target.sh}"

# §9 독립: telemetry failure must NEVER block dispatch. Shim swallows
# transport errors; `|| true` guards against exec-level failures too.
emit_telemetry() {
  if [ -x "$EMIT_TELEMETRY_MJS" ]; then
    "$EMIT_TELEMETRY_MJS" "$@" >/dev/null 2>&1 || true
  fi
}

shell_quote() {
  printf '%q' "$1"
}

default_cli_flags() {
  case "$1" in
    claude) printf '%s\n' "--model \"${AIGENTRY_CLAUDE_MODEL:-claude-opus-5}\" --effort \"${AIGENTRY_CLAUDE_EFFORT:-xhigh}\" --permission-mode bypassPermissions";;
    codex)  printf '%s\n' "-c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox";;
    gemini) printf '%s\n' "-m \"${AIGENTRY_GEMINI_MODEL:-gemini-2.5-flash}\" --approval-mode yolo";;
    *)      printf '%s\n' "";;
  esac
}

safe_session_component() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_'
}

install_worker_git_guard() {
  local src_dir src hooks_dir tmp
  src_dir="${AIGENTRY_GIT_HOOK_SOURCE_DIR:-$SCRIPT_DIR/../git-hooks}"
  src="$src_dir/pre-push"
  hooks_dir="${AIGENTRY_GIT_HOOKS_DIR:-$HOME/.aigentry/git-hooks}"
  [ -f "$src" ] || { echo "dispatch.sh: worker git guard missing: $src" >&2; return 1; }
  mkdir -p "$hooks_dir"
  tmp="$hooks_dir/pre-push.$$"
  cp "$src" "$tmp"
  chmod 0755 "$tmp"
  mv "$tmp" "$hooks_dir/pre-push"
  printf '%s\n' "$hooks_dir"
}

write_worker_launcher() {
  local sid="$1" display_cli="$2" real_cli="$3" real_flags="$4" hooks_dir="$5"
  local safe_sid sessions_root launcher_dir launcher tmp
  safe_sid=$(safe_session_component "$sid")
  sessions_root="${AIGENTRY_SESSIONS_ROOT:-$HOME/.aigentry/sessions}"
  launcher_dir="$sessions_root/$safe_sid/guard"
  launcher="$launcher_dir/worker-launcher.sh"
  mkdir -p "$launcher_dir"
  tmp="$launcher.$$"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' '# Generated by dispatch.sh for worker-session push protection.'
    printf '%s\n' 'set -euo pipefail'
    printf 'export AIGENTRY_WORKER_SESSION=1\n'
    printf 'export AIGENTRY_GIT_HOOKS_DIR=%s\n' "$(shell_quote "$hooks_dir")"
    printf '%s\n' '_aigentry_git_config_count="${GIT_CONFIG_COUNT:-0}"'
    printf '%s\n' 'case "$_aigentry_git_config_count" in'
    printf '%s\n' '  (*[!0-9]*|"") _aigentry_git_config_i=0 ;;'
    printf '%s\n' '  (*) _aigentry_git_config_i="$_aigentry_git_config_count" ;;'
    printf '%s\n' 'esac'
    printf '%s\n' 'export GIT_CONFIG_COUNT="$((_aigentry_git_config_i + 1))"'
    printf '%s\n' 'export "GIT_CONFIG_KEY_${_aigentry_git_config_i}=core.hooksPath"'
    printf '%s\n' 'export "GIT_CONFIG_VALUE_${_aigentry_git_config_i}=${AIGENTRY_GIT_HOOKS_DIR}"'
    if [ -n "$real_flags" ]; then
      printf 'exec -a %s %s %s "$@"\n' "$(shell_quote "$display_cli")" "$(shell_quote "$real_cli")" "$real_flags"
    else
      printf 'exec -a %s %s "$@"\n' "$(shell_quote "$display_cli")" "$(shell_quote "$real_cli")"
    fi
  } > "$tmp"
  chmod 0755 "$tmp"
  mv "$tmp" "$launcher"
  printf '%s\n' "$launcher"
}

usage() { sed -n '2,41p' "$0"; }

target=""; ref_file=""; from_id=""; timeout_ms=30000; timeout_explicit=0
spawn=0; track=""; name=""; cwd=""; cli="claude"; worktree=""
verify_delivered=0
verify_started=1  # Rule 33: confirm session actually started working post-inject. --no-verify-started to skip.
role=""  # #431: when set + cli=claude, enables boot-adapter wiring (--bare + --system-prompt-file)
keep_alive=0  # ADR 2026-05-20 Layer A opt-out — worker won't emit CLEANUP_REQUEST.
task_id=""; no_task=0; no_task_reason=""  # Rule 34 task-gate (#736)

while [ $# -gt 0 ]; do
  case "$1" in
    --target) target="$2"; shift 2;;
    --ref) ref_file="$2"; shift 2;;
    --from) from_id="$2"; shift 2;;
    --timeout-ms) timeout_ms="$2"; timeout_explicit=1; shift 2;;
    --spawn-and-dispatch) spawn=1; shift;;
    --track) track="$2"; shift 2;;
    --name) name="$2"; shift 2;;
    --cwd) cwd="$2"; shift 2;;
    --worktree) worktree="$2"; shift 2;;
    --cli) cli="$2"; shift 2;;
    --role) role="$2"; shift 2;;
    --task) task_id="$2"; shift 2;;
    --no-task) no_task=1; no_task_reason="$2"; shift 2;;
    --verify-delivered) verify_delivered=1; shift;;
    --no-verify-started) verify_started=0; shift;;
    --keep-alive) keep_alive=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "dispatch.sh: unknown arg: $1" >&2; usage >&2; exit 4;;
  esac
done

if [ "${DISPATCH_SH_NO_MAIN:-0}" != "1" ]; then
  [ -n "$ref_file" ] || { echo "dispatch.sh: --ref required" >&2; exit 4; }
  [ -f "$ref_file" ] || { echo "dispatch.sh: ref file not found: $ref_file" >&2; exit 4; }
fi

now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

# Look up the wrapped CLI ("claude"/"codex"/"gemini") for a sid, "" if absent.
cli_of() {
  "$TELEPTY" list --json 2>/dev/null | python3 -c "
import json, sys
sid = sys.argv[1]
try:
    for s in json.load(sys.stdin):
        if s.get('id') == sid:
            print(s.get('command') or '')
            break
except Exception:
    pass
" "$1"
}

# Returns 0 if the wrapped CLI's REPL is past the welcome/boot screen.
# Strategy: positive override — an idle-prompt signal in last3 wins over a
# banner signal in the wider tail. Hard-negatives in last3 (working spinner,
# trust-folder modal) reject regardless of prompt.
# Fallback for telepty#22 (https://github.com/dmsdc-ai/aigentry-telepty/issues/22):
# Claude 2.x's welcome banner persists in scrollback until the first input,
# so banner-in-tail alone can no longer mean not-ready. Drop this branch once
# `telepty wait-ready` lands; the function shape stays as a defensive fallback.
is_ready() {
  local sid="$1" cli_kind="$2" state
  state=$(TELEPTY="$TELEPTY" "$SESSION_PROBE_PY" --sid "$sid" --cli "$cli_kind" 2>/dev/null || true)
  [ -n "$state" ] || return 1
  STATE_JSON="$state" python3 - <<'PY'
import json, os, sys

try:
    state = json.loads(os.environ.get("STATE_JSON", "") or "{}")
except Exception:
    state = {}
sys.exit(0 if state.get("ready") is True else 1)
PY
}

# #727: presence wait, kept separate from wait_for_ready's REPL-ready wait
# (telepty#18). Registration = "the bridge has published the session"; ready =
# "its REPL is past the boot screen". A freshly spawned worker takes tens of
# seconds to reach the first, and the old one-shot check gave up long before —
# so every spawn-and-dispatch got hand-recovered with a raw `telepty inject`,
# bypassing the #736 task-gate ledger, delivery confirm and tracker register.
# Echoes the wrapped CLI kind on success; 1 = never registered.
REGISTER_TIMEOUT_MS_DEFAULT=180000
wait_for_registration() {
  local sid="$1" timeout start deadline now kind elapsed nap notes=0
  timeout="${AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS:-}"
  if [ -z "$timeout" ]; then
    # --target names a session that is supposed to exist already, so waiting
    # minutes there would only slow a genuine failure down. Only a fresh spawn
    # is worth the patience.
    if [ "$spawn" -eq 1 ]; then timeout="$REGISTER_TIMEOUT_MS_DEFAULT"; else timeout=0; fi
  fi
  start=$(now_ms)
  deadline=$(( start + timeout ))
  while :; do
    kind=$(cli_of "$sid")
    if [ -n "$kind" ]; then printf '%s\n' "$kind"; return 0; fi
    now=$(now_ms)
    if [ "$now" -ge "$deadline" ]; then
      echo "dispatch.sh: session '$sid' never registered in telepty list after ${timeout}ms — raise AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS (default ${REGISTER_TIMEOUT_MS_DEFAULT} for --spawn-and-dispatch)" >&2
      if [ "$spawn" -eq 1 ]; then
        echo "dispatch.sh: the workspace opened for '$sid' is still running; close it manually before retrying" >&2
      fi
      return 1
    fi
    elapsed=$(( (now - start) / 1000 ))
    if [ "$elapsed" -ge $(( (notes + 1) * 30 )) ]; then
      notes=$(( elapsed / 30 ))
      echo "dispatch.sh: waiting for session registration… ${elapsed}s" >&2
    fi
    # Cap the nap at what is left so the knob's value is also the worst-case wait.
    nap=$(( deadline - now ))
    [ "$nap" -gt 5000 ] && nap=5000
    sleep "$(printf '%d.%03d' "$(( nap / 1000 ))" "$(( nap % 1000 ))")"
  done
}

wait_for_ready() {
  local sid="$1" cli_kind deadline effective_timeout
  cli_kind=$(wait_for_registration "$sid") || return 6
  effective_timeout="$timeout_ms"
  # #557: codex reaches its interactive `›` REPL within seconds, but its 6 MCP
  # servers can take >30s to finish booting; on slow boots the prompt-ready signal
  # may not stabilize until that completes. Give codex a longer default ceiling
  # (claude/gemini unchanged). An explicit --timeout-ms always wins.
  if [ "$cli_kind" = "codex" ] && [ "$timeout_explicit" -eq 0 ]; then
    effective_timeout="${AIGENTRY_CODEX_READY_TIMEOUT_MS:-90000}"
  fi
  deadline=$(( $(now_ms) + effective_timeout ))
  while :; do
    if is_ready "$sid" "$cli_kind"; then return 0; fi
    if [ "$(now_ms)" -ge "$deadline" ]; then
      echo "dispatch.sh: timeout (${effective_timeout}ms) waiting for $sid REPL ready (cli=$cli_kind)" >&2
      return 1
    fi
    sleep 0.5
  done
}

ref_hash=""
eff_ref=""     # the bytes actually handed to telepty; prepared BEFORE begin-delivery
tmp_ref=""

# --- telepty#60 Stage A registry seam --------------------------------------
# The registry component is the single typed writer of the dispatch registry.
# Its failure is the dispatch's failure: the old best-effort hooks ran AFTER the
# inject and swallowed every error, so a delivered task could exist with nothing
# recorded — silence, which is exactly what Stage A removes.
registry() {
  if [ ! -x "$DISPATCH_REGISTRY_PY" ]; then
    echo "dispatch.sh: DISPATCH_NOT_RECORDED — registry component missing at $DISPATCH_REGISTRY_PY" >&2
    return 9
  fi
  "$DISPATCH_REGISTRY_PY" "$@"
}

compute_ref_hash() {
  ref_hash=$(python3 -c 'import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$ref_file")
}

# #690 (Rule 16): refs carry the {{ORCHESTRATOR_REPORT_TARGET}} placeholder so
# workers are never handed a phantom/hardcoded orchestrator sid. Resolve the real
# address (env override + tailnet auto-detect, NO hardcoded sid/IP) into a temp
# copy — $ref_file (dedup hash / verify) stays the original.
#
# Stage A moved this OUT of do_inject: no fallible preparation may run between
# the durable begin-delivery commit and the transport call, or a failure in that
# window is indistinguishable from a delivery whose bytes may have landed.
prepare_effective_ref() {
  eff_ref="$ref_file"
  grep -q '{{ORCHESTRATOR_REPORT_TARGET}}' "$ref_file" 2>/dev/null || return 0
  local target_addr=""
  # Fail CLOSED. No fallback default: guessing the target is the bug being removed.
  target_addr="$("$REPORT_TARGET_SH")" || target_addr=""
  if [ -z "$target_addr" ]; then
    echo "dispatch.sh: could not resolve the orchestrator report target via $REPORT_TARGET_SH — refusing to inject a ref with an unresolved {{ORCHESTRATOR_REPORT_TARGET}} (#690)" >&2
    return 1
  fi
  tmp_ref="$(mktemp "${TMPDIR:-/tmp}/dispatch-ref.XXXXXX")"
  sed "s|{{ORCHESTRATOR_REPORT_TARGET}}|$target_addr|g" "$ref_file" > "$tmp_ref"
  eff_ref="$tmp_ref"
}

do_inject() {
  local sid="$1"
  local -a a=(inject --ref "$eff_ref" --submit --submit-retry 2)
  [ -n "$from_id" ] && a+=(--from "$from_id")
  a+=("$sid")
  local rc=0
  "$TELEPTY" "${a[@]}" || rc=$?
  [ -n "$tmp_ref" ] && rm -f "$tmp_ref"
  return "$rc"  # preserve the inject's real exit code (callers gate on it)
}

# Returns 0 if the inject visibly landed (placeholder cleared or payload's
# first line echoed), 1 if it visibly did not, 2 if it could not be told either
# way. Called only when --verify-delivered is set.
#
# #835: the `2>/dev/null || true` used to fold a FAILED read-screen into an empty
# screen, and an empty screen matches no placeholder — so the check below fell
# through to exit 0 and the dispatch reported `verified: true` on the strength of
# having read nothing. A refused or unanswered read is not evidence of delivery;
# it is the absence of evidence, and that is exit 2 (the caller maps it onto the
# existing "delivery unknown" code rather than claiming either outcome).
verify_delivered() {
  local sid="$1" first_line post rc=0
  first_line=$(head -n1 "$ref_file" | tr -d '\r')
  sleep 5
  post=$("$TELEPTY" read-screen "$sid" --lines 30 2>/dev/null) || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$post" ]; then
    echo "dispatch.sh: read-screen for $sid returned nothing (rc=$rc) — delivery is UNVERIFIABLE, not verified" >&2
    return 2
  fi
  FIRST="$first_line" POST="$post" python3 - <<'PY'
import os, re, sys
post = os.environ.get("POST", "")
first = os.environ.get("FIRST", "")
lines = [l.rstrip() for l in post.splitlines() if l.strip()]
tail = "\n".join(lines[-10:]) if lines else ""
placeholder = re.search(r'[❯›]\s+Try "[^"]+"', tail) is not None
echoed = bool(first) and first[:60] in post
if placeholder and not echoed:
    sys.exit(1)
sys.exit(0)
PY
}

# begin_delivery <sid> — the authoritative write-before-delivery transaction.
# It re-runs the dedup check atomically and, only for a new attempt, commits the
# durable unknown record. Its `proceed` result is what authorizes do_inject.
# #718: a worker with a dedicated --worktree has its branch read there, so later
# git evidence is attributed to the worker's HEAD and not the shared cwd's.
begin_delivery() {
  local sid="$1" branch="" gitref
  gitref="${worktree:-$cwd}"
  if [ -n "$gitref" ]; then
    branch=$(git -C "$gitref" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  fi
  local -a a=(begin-delivery --sid "$sid" --ref-hash "$ref_hash" --ref-path "$ref_file"
              --cwd "$cwd" --from "$from_id" --track "$track" --role "$role" --branch "$branch")
  [ -n "$worktree" ] && a+=(--worktree "$worktree")
  [ "$keep_alive" -eq 1 ] && a+=(--keep-alive)
  registry "${a[@]}"
}

# --- Rule 34 task-gate (#736) ---
# Rule 34 requires every delegated work item to be registered in the task queue
# before dispatch. That relied on operator discipline and leaked, so the gate
# lives here — dispatch.sh is the actuation chokepoint every delegation flows
# through. It runs BEFORE any side effect (no spawn, no inject) so a violation
# can never leave a half-started worker behind.
TASK_QUEUE="${AIGENTRY_TASK_QUEUE:-$SCRIPT_DIR/../state/task-queue.json}"
TASK_GATE_MODE="${AIGENTRY_TASK_GATE:-hard}"
TASK_GATE_HINT='register the task in state/task-queue.json first (--task <id>), or use --no-task "<reason>" for exempt work.'

# Audit trail for every gate exemption (--no-task and warn-mode bypasses), so
# the escape hatch stays countable. Best-effort: never fails the dispatch.
notask_telemetry() {
  local reason="$1" day dir caller
  day=$(date -u +%Y-%m-%d)
  dir="$HOME/.aigentry/telemetry"
  mkdir -p "$dir" 2>/dev/null || return 0
  caller="${AIGENTRY_DISPATCH_CALLER:-$(ps -o comm= -p "$PPID" 2>/dev/null || true)}"
  REASON="$reason" SID_OR_TARGET="${target:-${track:+$track-$name}}" REF="$ref_file" CALLER="$caller" \
    python3 -c '
import datetime, json, os, sys
sys.stdout.write(json.dumps({
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "sid_or_target": os.environ.get("SID_OR_TARGET", ""),
    "ref": os.environ.get("REF", ""),
    "reason": os.environ.get("REASON", ""),
    "caller_env": os.environ.get("CALLER", "").strip(),
}, ensure_ascii=False) + "\n")
' >> "$dir/dispatch-notask-$day.ndjson" 2>/dev/null || true
}

# hard → refuse (exit 4); warn → print + audit, then proceed (migration aid);
# off → legacy silence.
task_gate_reject() {
  local msg="$1"
  case "$TASK_GATE_MODE" in
    off) return 0;;
    warn)
      echo "dispatch.sh: WARNING (AIGENTRY_TASK_GATE=warn) $msg" >&2
      notask_telemetry "task-gate-warn: $msg"
      return 0;;
    *) echo "dispatch.sh: $msg" >&2; exit 4;;
  esac
}

task_gate_check() {
  if [ -n "$task_id" ] && [ "$no_task" -eq 1 ]; then
    echo "dispatch.sh: --task and --no-task are mutually exclusive" >&2
    exit 4
  fi
  if [ "$no_task" -eq 1 ]; then
    # Usage errors are mode-independent: an unexplained exemption is never valid.
    case "$no_task_reason" in
      *[![:space:]]*) ;;
      *) echo "dispatch.sh: --no-task requires a non-empty reason" >&2; exit 4;;
    esac
    notask_telemetry "$no_task_reason"
    return 0
  fi
  if [ -z "$task_id" ]; then
    task_gate_reject "Rule 34 task-gate: $TASK_GATE_HINT"
    return 0
  fi
  local status rc
  status=$(TQ="$TASK_QUEUE" TASK_ID="$task_id" python3 - <<'PY'
import json, os, sys

ALLOWED = {"pending", "in_progress", "delegated", "queued", "blocked-by-observation"}
TERMINAL = {"done", "completed", "superseded", "cancelled", "closed"}
try:
    data = json.load(open(os.environ["TQ"], encoding="utf-8"))
except Exception:
    sys.exit(2)
tid = os.environ["TASK_ID"]
task = next((t for t in data.get("tasks", []) if str(t.get("id")) == tid), None)
if task is None:
    # completed[] is the archive tail — a hit there is a stale id, not an unknown one.
    if any(str(t.get("id")) == tid for t in data.get("completed", [])):
        print("completed")
        sys.exit(4)
    sys.exit(3)
status = str(task.get("status") or "")
if status in ALLOWED:
    sys.exit(0)
print(status)
sys.exit(4 if status in TERMINAL or status.startswith(("done", "completed")) else 5)
PY
  ) && rc=0 || rc=$?
  case "$rc" in
    0) return 0;;
    2) task_gate_reject "Rule 34 task-gate: task queue unreadable at $TASK_QUEUE — $TASK_GATE_HINT";;
    3) task_gate_reject "Rule 34 task-gate: unknown task id '$task_id' in $TASK_QUEUE — $TASK_GATE_HINT";;
    4) task_gate_reject "Rule 34 task-gate: task $task_id is already '$status' — stale-id reuse. Register a NEW task for this work, or use --no-task \"<reason>\".";;
    *) task_gate_reject "Rule 34 task-gate: task $task_id status '$status' is not dispatchable (need pending|queued|in_progress|delegated|blocked-by-observation) — $TASK_GATE_HINT";;
  esac
}

# Auto-ledger: a confirmed dispatch writes itself into the task row, so the queue
# reflects reality without operator discipline. Best-effort — the inject already
# landed, so a queue-write failure must warn, never fail the dispatch.
task_ledger_update() {
  local sid="$1"
  [ -n "$task_id" ] || return 0
  [ -f "$TASK_QUEUE" ] || return 0
  if ! TQ="$TASK_QUEUE" TASK_ID="$task_id" SID="$sid" REF="$(basename "$ref_file")" TRACK="$track" python3 - <<'PY'
import datetime, json, os, sys, tempfile

path, tid = os.environ["TQ"], os.environ["TASK_ID"]
data = json.load(open(path, encoding="utf-8"))
task = next((t for t in data.get("tasks", []) if str(t.get("id")) == tid), None)
if task is None:
    sys.exit(1)
now = datetime.datetime.now(datetime.timezone.utc)
# Only promote from a not-yet-started state; in_progress must never regress.
if task.get("status") in ("pending", "queued"):
    task["status"] = "delegated"
task["updated_at"] = now.strftime("%Y-%m-%d")
stamp = " | dispatched {ts} sid={sid} ref={ref} track={track}".format(
    ts=now.isoformat(timespec="seconds").replace("+00:00", "Z"),
    sid=os.environ.get("SID", ""), ref=os.environ.get("REF", ""),
    track=os.environ.get("TRACK", "") or "-")
note = task.get("note") or ""
task["note"] = note + stamp if note else stamp.lstrip(" |")
# Atomic: same-dir temp + rename, so a crash can never truncate the live queue.
tmp = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False,
                                  dir=os.path.dirname(os.path.abspath(path)))
try:
    tmp.write(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.flush()
    os.fsync(tmp.fileno())
    tmp.close()
    os.replace(tmp.name, path)
except Exception:
    os.unlink(tmp.name)
    raise
PY
  then
    echo "dispatch.sh: WARNING task-gate ledger update failed for task $task_id (dispatch already landed)" >&2
  fi
}

# --- main ---
# Sourceable for tests: `DISPATCH_SH_NO_MAIN=1 source dispatch.sh` exposes
# is_ready / verify_delivered without running the dispatch flow.
if [ "${DISPATCH_SH_NO_MAIN:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

task_gate_check

sid=""
if [ "$spawn" -eq 1 ]; then
  if [ -z "$track" ] || [ -z "$name" ] || [ -z "$cwd" ]; then
    echo "dispatch.sh: --track --name --cwd required for --spawn-and-dispatch" >&2
    exit 4
  fi
  sid="${track}-${name}"
elif [ -n "$target" ]; then
  sid="$target"
else
  echo "dispatch.sh: --target or --spawn-and-dispatch required" >&2
  exit 4
fi

# telepty#60 Stage A: the read-only dedup query runs BEFORE any side effect, so a
# duplicate never spawns a workspace or waits for readiness. It creates no record
# and no sidecar — an abort in the steps below therefore leaves nothing behind to
# swallow an identical retry (the exact failure the retired sidecar caused).
compute_ref_hash
set +e
dedup_out=$(registry check-dedup --sid "$sid" --ref-hash "$ref_hash" 2>&1)
dedup_rc=$?
set -e
case "$dedup_rc" in
  0) ;;                     # no prior delivery for this (sid, ref) — carry on
  7|8) skip_preparation=1;; # duplicate/ambiguous: go straight to the atomic recheck
  *)  # The registry's own named result is the diagnosis; do not replace it with
      # a generic one, or a corrupt registry looks like a missing helper.
      printf '%s\n' "$dedup_out" >&2
      echo "dispatch.sh: DISPATCH_NOT_RECORDED — dedup query failed (rc=$dedup_rc)" >&2
      exit 9;;
esac

if [ "${skip_preparation:-0}" != "1" ] && [ "$spawn" -eq 1 ]; then
  # #431 (ADR 2026-05-12 enforcement) — hybrid (b-2)+(c) boot wiring (claude only).
  # When --role is set and cli is claude, invoke boot-prepare.mjs to:
  #   - Compute a sandbox spawn cwd ($HOME/.aigentry/role-sandbox/<role>-<sid>/)
  #     with no CLAUDE.md → no project auto-discovery contamination
  #   - Emit `--append-system-prompt-file <staged>` for OAuth-compatible role contract
  #   - Set AIGENTRY_TARGET_CWD env so the worker can `cd $AIGENTRY_TARGET_CWD`
  #     when it needs the original project root
  # boot-prepare.mjs failure = stderr WARNING + legacy spawn (not silent fail).
  boot_spawn_cli=""
  boot_spawn_cwd=""
  # #532: boot-prepare role wiring now covers claude (flag-based) + codex/gemini
  # (additive cwd context file + config-home shadow). Pass the actual --cli so
  # boot-prepare stages the right context file (AGENTS.md/GEMINI.md) and env.
  case "$cli" in
    claude|codex|gemini) boot_eligible=1 ;;
    *) boot_eligible=0 ;;
  esac
  if [ "$boot_eligible" = "1" ] && [ -n "$role" ]; then
    if [ -x "$SCRIPT_DIR/boot-prepare.mjs" ]; then
      boot_json=$(node "$SCRIPT_DIR/boot-prepare.mjs" --role "$role" --cwd "$cwd" --sid "$sid" --cli "$cli") && bp_status=0 || bp_status=$?
      if [ "$bp_status" -eq 0 ] && [ -n "$boot_json" ]; then
        # Parse JSON via python3 (already a dispatch.sh dep — see is_ready / dedup).
        boot_spawn_cli=$(BOOT_JSON="$boot_json" python3 -c 'import json,os; print(json.loads(os.environ["BOOT_JSON"])["spawn_cli"])')
        boot_spawn_cwd=$(BOOT_JSON="$boot_json" python3 -c 'import json,os; print(json.loads(os.environ["BOOT_JSON"])["spawn_cwd"])')
      else
        echo "dispatch.sh: WARNING boot-prepare.mjs failed (exit $bp_status) for sid=$sid role=$role" >&2
        echo "dispatch.sh: WARNING falling back to legacy open-session.sh path; cwd CLAUDE.md auto-load risk active (#431)" >&2
      fi
    else
      echo "dispatch.sh: WARNING boot-prepare.mjs not executable at $SCRIPT_DIR; legacy path active (#431)" >&2
    fi
  fi
  worker_hooks_dir=$(install_worker_git_guard) || {
    echo "dispatch.sh: worker git guard install failed" >&2
    exit 2
  }
  if [ -n "$boot_spawn_cli" ] && [ -n "$boot_spawn_cwd" ]; then
    # Hybrid/additive path active: spawn the per-session boot launcher.sh in the
    # sandbox cwd. boot_spawn_cli already encodes AIGENTRY_TARGET_CWD export +
    # the role delivery (claude --append-system-prompt-file; codex/gemini staged
    # cwd context file + config-home shadow). Wrap it again at the dispatch-owned
    # layer so worker push protection is not dependent on boot-prepare (#509).
    # display_cli = "$cli" (#532) so the guard wrapper's `exec -a <cli>` and
    # telepty visibility match the actual CLI, not a hardcoded "claude".
    worker_launcher=$(write_worker_launcher "$sid" "$cli" "$boot_spawn_cli" "" "$worker_hooks_dir")
    # Pass empty --extra-flags so open-session.sh's claude-default flags do NOT
    # apply (we control the full argv via the launcher).
    if ! "$OPEN_SESSION_SH" --track "$track" --name "$name" --cwd "$boot_spawn_cwd" --cli "$worker_launcher" --extra-flags " " >/dev/null; then
      echo "dispatch.sh: open-session.sh failed" >&2
      exit 2
    fi
  else
    worker_flags=$(default_cli_flags "$cli")
    worker_launcher=$(write_worker_launcher "$sid" "$cli" "$cli" "$worker_flags" "$worker_hooks_dir")
    # Use the dispatch-owned launcher as the CLI so codex/claude/gemini all
    # receive AIGENTRY_WORKER_SESSION + Git env-config without editing
    # the orchestrator's open-session.sh (#613 A2: now an orchestrator real
    # file, no longer a symlink into devkit; resolution path is unchanged).
    if ! "$OPEN_SESSION_SH" --track "$track" --name "$name" --cwd "$cwd" --cli "$worker_launcher" --extra-flags " " >/dev/null; then
      echo "dispatch.sh: open-session.sh failed" >&2
      exit 2
    fi
  fi
fi

emit_telemetry --helper dispatch --subtype dispatch_start \
  --payload-json "$(printf '{"target_sid":"%s","mode":"%s","cli":"%s","role":"%s"}' "$sid" "$([ "$spawn" -eq 1 ] && echo spawn-and-dispatch || echo target)" "$cli" "$role")" \
  --correlation-id "$sid"

if [ "${skip_preparation:-0}" != "1" ]; then
  # #727: a registration/readiness timeout leaves nothing behind but the
  # workspace itself. No dedup mark is written any more, so the operator's retry
  # with the same ref reaches the delivery transaction instead of no-opping.
  wait_for_ready "$sid" || exit $?
  prepare_effective_ref || exit 3
fi

# Nothing fallible may run between this commit and do_inject: a crash in that
# window is conservatively delivery-unknown, and a wider window means more
# dispatches whose delivery nobody can answer for.
set +e
begin_out=$(begin_delivery "$sid")
begin_rc=$?
set -e
case "$begin_rc" in
  0) ;;
  8) printf '%s\n' "$begin_out"
     echo "dispatch.sh: DISPATCH_DEDUPLICATED for $sid — prior transport write observed, no new delivery" >&2
     exit 8;;
  7) printf '%s\n' "$begin_out"
     echo "dispatch.sh: DISPATCH_RETRY_HELD for $sid — a prior attempt's delivery is unknown; review before retrying" >&2
     exit 7;;
  *) printf '%s\n' "$begin_out" >&2
     echo "dispatch.sh: DISPATCH_NOT_RECORDED for $sid — no delivery attempted" >&2
     exit 9;;
esac

if ! do_inject "$sid"; then
  echo "dispatch.sh: telepty inject failed for $sid" >&2
  # A generic nonzero return is NOT proof that no bytes landed, so the record
  # says delivery-unknown rather than claiming a clean failure.
  registry set-transport-result --sid "$sid" --result unknown >/dev/null 2>&1 || true
  exit 3
fi

# Exit 0 requires the transport result to be durable too — a caller that cannot
# tell "delivered and recorded" from "delivered, bookkeeping lost" will book the
# second as a successful re-dispatch.
if ! registry set-transport-result --sid "$sid" --result write_observed >/dev/null; then
  echo "dispatch.sh: DELIVERY_UNKNOWN for $sid — bytes were handed to telepty but the transport result could not be recorded" >&2
  exit 7
fi

if [ "$verify_delivered" -eq 1 ]; then
  verify_rc=0
  verify_delivered "$sid" || verify_rc=$?
  case "$verify_rc" in
    0) ;;
    # #835 — "the screen could not be read" is not "the inject failed". Exit 7 is
    # this repo's existing name for a delivery whose result is unknown, and the
    # re-dispatch callers already hold rather than replay on it; claiming 5
    # (DELIVERY_FAILED) would assert an outcome nothing measured.
    2) echo "dispatch.sh: DELIVERY_UNKNOWN for $sid — the inject was written but the screen could not be read back, so nothing corroborates it" >&2
       exit 7;;
    *) echo "dispatch.sh: DELIVERY_FAILED for $sid (placeholder untouched; registered for pull-fallback despite verify-FN)" >&2
       exit 5;;
  esac
fi
task_ledger_update "$sid"

emit_telemetry --helper dispatch --subtype dispatch_ack \
  --payload-json "$(printf '{"target_sid":"%s","verified":%s}' "$sid" "$([ "$verify_delivered" -eq 1 ] && echo true || echo false)")" \
  --correlation-id "$sid"
echo "OK dispatched to $sid"

# Rule 33: post-dispatch START verification (default ON; non-fatal — the inject
# already landed). SUSPECT means "delivered but not started as intended"; the
# orchestrator must resolve the surface (read-screen / answer modal / respawn).
if [ "$verify_started" -eq 1 ] && [ -x "$VERIFY_SH" ]; then
  # --resubmit: auto-recover the #412 codex submit race (Enter not registered →
  # inject sits unsubmitted) by re-sending Enter once when the only fault is idle.
  if TELEPTY="$TELEPTY" "$VERIFY_SH" "$sid" --resubmit; then
    started=true
  else
    started=false
    echo "dispatch.sh: ⚠️ Rule 33 — $sid did NOT verify as started-working (see SUSPECT above). Resolve before relying on the worker." >&2
  fi
  emit_telemetry --helper dispatch --subtype dispatch_started_check \
    --payload-json "$(printf '{"target_sid":"%s","started":%s}' "$sid" "$started")" \
    --correlation-id "$sid"
fi
exit 0
