#!/usr/bin/env bash
# hitl.sh — HITL Gate CLI (ADR 2026-07-26-hitl-gate-primitive).
#
# One human-in-the-loop primitive shared by the reconciler loop and worker loops.
# A gate is a file: state/hitl/pending/<id>.json, moved to state/hitl/decided/
# on decision. The directory IS the index — `ls pending/` answers "is anything
# pending?" and the loop's pause predicate is a grep over it. Level-triggered:
# no daemon, no lock, no in-memory state to recover after a restart.
#
# Commands:
#   hitl.sh open --source S --kind K --question Q [--subject-sid SID]
#                [--resume R] [--options "a=…,b=…"] [--context-ref PATH]
#   hitl.sh list [--kind K] [--json]     — pending gates, oldest first
#   hitl.sh show <id>                    — full record (pending or decided)
#   hitl.sh approve <id> [--note TEXT]   — decide + run resume hook
#   hitl.sh reject  <id> [--note TEXT]
#   hitl.sh remind                       — internal: retry failed notifies, re-notify ≥24h
#   hitl.sh --help
#
#   kind   ∈ destructive | decision | info   (global pause | per-item | none)
#   resume ∈ reinject | registry-clear-redispatch | none   (what approve DOES)
#
# Article 17: shell + Python stdlib only. macOS + Linux.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
HITL_DIR="${HITL_STATE_DIR:-$REPO_DIR/state/hitl}"
PENDING_DIR="$HITL_DIR/pending"
DECIDED_DIR="$HITL_DIR/decided"
DISPATCH_DIR="${DISPATCH_STATE_DIR:-$REPO_DIR/state/dispatch}"
DISPATCH_REGISTRY_PY="${DISPATCH_REGISTRY_PY:-$SCRIPT_DIR/dispatch-registry.py}"

TELEPTY="${TELEPTY:-telepty}"
ORCH_SID="${ORCHESTRATOR_SID:-orchestrator}"
# Same clock seam as session-reconciler.sh — the reminder cadence is testable.
NOW_OVERRIDE="${RECONCILER_NOW:-}"
REMIND_INTERVAL_SECONDS="${HITL_REMIND_INTERVAL:-86400}"

mkdir -p "$PENDING_DIR" "$DECIDED_DIR"

usage() { sed -n '2,23p' "$0"; exit "${1:-0}"; }
die() { echo "hitl: $*" >&2; exit 1; }

now_iso() {
  if [ -n "$NOW_OVERRIDE" ]; then printf '%s' "$NOW_OVERRIDE"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))'
}

# gate_field <file> <field> — one scalar field; null/missing prints empty.
gate_field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    gate = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
value = gate.get(sys.argv[2])
print("" if value is None else value)
PY
}

# gate_patch <file> <key=value>... — merge-patch in place; empty value ⇒ null.
gate_patch() {
  local file="$1" tmp; shift
  tmp=$(mktemp "${file}.tmp.XXXXXX")
  python3 - "$file" "$@" > "$tmp" <<'PY'
import json, sys
gate = json.load(open(sys.argv[1]))
for kv in sys.argv[2:]:
    key, _, value = kv.partition("=")
    gate[key] = value or None
json.dump(gate, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
PY
  mv "$tmp" "$file"
}

# notify_gate <file> — one line on the existing REPORT channel. No new transport.
notify_gate() {
  local file="$1" id kind question source options msg
  id=$(gate_field "$file" id); kind=$(gate_field "$file" kind)
  question=$(gate_field "$file" question); source=$(gate_field "$file" source)
  options=$(python3 - "$file" <<'PY'
import json, sys
print(",".join(json.load(open(sys.argv[1])).get("options") or []))
PY
)
  msg="HITL_GATE $id | kind=$kind | $question"
  [ -n "$options" ] && msg="$msg | options: $options"
  msg="$msg | decide: bin/hitl.sh approve $id"
  command -v "$TELEPTY" >/dev/null 2>&1 || return 1
  "$TELEPTY" inject --submit-force --from "$source" "$ORCH_SID" "$msg" >/dev/null 2>&1
}

# telepty#60 Stage A: a gate is its OWN axis. Blocking a session on a human says
# nothing about whether its task finished, so the gate never touches outcome and
# never overwrites the lifecycle — it sets gate.state and clears it again, with
# the lifecycle preserved underneath by the registry.
registry() { "$DISPATCH_REGISTRY_PY" "$@"; }

# registry_lifecycle <sid> — current lifecycle state ("" when absent).
registry_lifecycle() {
  local out
  out=$(registry get --sid "$1" --pointer lifecycle.state 2>/dev/null) || return 0
  [ "$out" = "null" ] && out=""
  printf '%s' "$out"
}

registry_open_gate() {
  registry set-gate --sid "$1" --state awaiting_user --now "$(now_iso)" >/dev/null 2>&1 || true
}

registry_close_gate() {
  registry set-gate --sid "$1" --clear --now "$(now_iso)" >/dev/null 2>&1 || true
}

registry_set_lifecycle() {
  registry set-lifecycle --sid "$1" --state "$2" --now "$(now_iso)" >/dev/null 2>&1 || true
}

registry_clear_redispatch() {
  registry set-lifecycle --sid "$1" --re-dispatch-count 0 --now "$(now_iso)" >/dev/null 2>&1 || true
}

cmd_open() {
  local source="" kind="" subject="" resume="none" question="" options="" context_ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) source="${2:-}"; shift 2;;
      --kind) kind="${2:-}"; shift 2;;
      --subject-sid) subject="${2:-}"; shift 2;;
      --resume) resume="${2:-}"; shift 2;;
      --question) question="${2:-}"; shift 2;;
      --options) options="${2:-}"; shift 2;;
      --context-ref) context_ref="${2:-}"; shift 2;;
      -h|--help) usage 0;;
      *) die "open: unknown argument '$1'";;
    esac
  done
  [ -n "$source" ] || die "open: --source is required"
  [ -n "$question" ] || die "open: --question is required"
  case "$kind" in destructive|decision|info) ;; *) die "open: --kind must be destructive|decision|info (got '$kind')";; esac
  case "$resume" in reinject|registry-clear-redispatch|none) ;; *) die "open: --resume must be reinject|registry-clear-redispatch|none (got '$resume')";; esac
  # <source> is a filename component; keep it one.
  printf '%s' "$source" | grep -Eq '^[A-Za-z0-9._-]+$' || die "open: --source must match [A-Za-z0-9._-]+"

  local key id now file
  key=$(SOURCE="$source" KIND="$kind" QUESTION="$question" python3 - <<'PY'
import hashlib, os
seed = "%s|%s|%s" % (os.environ["SOURCE"], os.environ["KIND"], os.environ["QUESTION"])
print(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12])
PY
)
  id="$kind-$source-$key"
  file="$PENDING_DIR/$id.json"
  # Idempotent: a level-triggered producer calling open every 60s is a no-op
  # after the first — same seed, same id, same filename. No duplicate, no re-notify.
  # ponytail: a gate already in decided/ re-opens (a second occurrence must reach
  # the human); the previous decided record is then overwritten by the next decision.
  if [ -f "$file" ]; then printf '%s\n' "$id"; return 0; fi

  now=$(now_iso)
  local prev_status=""
  [ -n "$subject" ] && prev_status=$(registry_lifecycle "$subject")

  local tmp; tmp=$(mktemp "${file}.tmp.XXXXXX")
  ID="$id" KEY="$key" SOURCE="$source" SUBJECT="$subject" KIND="$kind" RESUME="$resume" \
  QUESTION="$question" OPTIONS="$options" CONTEXT_REF="$context_ref" PREV="$prev_status" \
  NOW="$now" python3 - > "$tmp" <<'PY'
import json, os, sys

env = os.environ
options = [o for o in env["OPTIONS"].split(",") if o]
json.dump({
    "id": env["ID"],
    "dedupe_key": env["KEY"],
    "source": env["SOURCE"],
    "subject_sid": env["SUBJECT"] or None,
    "kind": env["KIND"],
    "resume": env["RESUME"],
    "question": env["QUESTION"],
    "options": options,
    "context_ref": env["CONTEXT_REF"] or None,
    "prev_status": env["PREV"] or None,
    "created_at": env["NOW"],
    "notified_at": None,
    "last_reminded_at": None,
    "status": "pending",
    "decision": None,
    "decided_at": None,
}, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
PY
  mv "$tmp" "$file"

  # File BEFORE notify: a gate never depends on a live transport (Art.17 pull
  # fallback). notified_at=null ⇒ `remind` retries on the next tick.
  if notify_gate "$file"; then
    gate_patch "$file" "notified_at=$now" "last_reminded_at=$now"
  else
    echo "hitl: notify failed for $id — notified_at=null, will retry on next remind" >&2
  fi

  # Blocking = registry status. The loops already filter on it.
  [ -n "$subject" ] && registry_open_gate "$subject"
  printf '%s\n' "$id"
}

cmd_list() {
  local kind="" as_json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) kind="${2:-}"; shift 2;;
      --json) as_json=1; shift;;
      -h|--help) usage 0;;
      *) die "list: unknown argument '$1'";;
    esac
  done
  PENDING_DIR="$PENDING_DIR" KIND="$kind" AS_JSON="$as_json" python3 - <<'PY'
import glob, json, os, sys

gates, corrupt = [], []
for path in sorted(glob.glob(os.path.join(os.environ["PENDING_DIR"], "*.json"))):
    try:
        gates.append(json.load(open(path)))
    except Exception:
        corrupt.append(path)
for path in corrupt:
    print("HITL_GATE_CORRUPT %s" % path, file=sys.stderr)
gates.sort(key=lambda g: g.get("created_at") or "")

paused = [g for g in gates if g.get("kind") == "destructive"]
kind = os.environ["KIND"]
shown = [g for g in gates if not kind or g.get("kind") == kind]

if os.environ["AS_JSON"] == "1":
    json.dump(shown, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(0)

for gate in paused:
    print("HITL_PAUSE gate=%s — autonomous actions paused (destructive gate pending)" % gate.get("id"))
if not shown:
    print("no pending gates")
for gate in shown:
    print("%s  %s  kind=%s  resume=%s  subject=%s  %s" % (
        gate.get("created_at"), gate.get("id"), gate.get("kind"),
        gate.get("resume"), gate.get("subject_sid") or "-", gate.get("question")))
    if gate.get("options"):
        print("    options: %s" % ",".join(gate["options"]))
    if not gate.get("notified_at"):
        print("    (not notified — orchestrator unreachable at open; `hitl.sh remind` retries)")
PY
}

cmd_show() {
  local id="${1:-}"
  [ -n "$id" ] || die "show: <id> is required"
  local file
  for file in "$PENDING_DIR/$id.json" "$DECIDED_DIR/$id.json"; do
    [ -f "$file" ] && { cat "$file"; return 0; }
  done
  die "show: no such gate: $id"
}

# cmd_decide <approve|reject> <id> [--note TEXT]
cmd_decide() {
  local decision="$1" id="${2:-}"; shift 2 || true
  local note=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --note) note="${2:-}"; shift 2;;
      -h|--help) usage 0;;
      *) die "$decision: unknown argument '$1'";;
    esac
  done
  [ -n "$id" ] || die "$decision: <id> is required"

  # Claim by rename: rename() is atomic, so exactly one decider gets the file and
  # every loser fails ENOENT. This is the whole concurrency story — no lock.
  # ponytail: a kill between the two renames strands the record as
  # decided/.<id>.claim.* (invisible to list/show); recover by hand, or add a
  # claim-sweep to `remind` if it ever actually happens.
  local claim; claim=$(mktemp "$DECIDED_DIR/.$id.claim.XXXXXX")
  if ! mv "$PENDING_DIR/$id.json" "$claim" 2>/dev/null; then
    rm -f "$claim"
    [ -f "$DECIDED_DIR/$id.json" ] && die "$decision: gate $id already decided"
    die "$decision: no pending gate: $id"
  fi

  local now status subject prev resume rc=0 resume_error=""
  now=$(now_iso)
  case "$decision" in approve) status=approved;; *) status=rejected;; esac
  subject=$(gate_field "$claim" subject_sid)
  prev=$(gate_field "$claim" prev_status)
  resume=$(gate_field "$claim" resume)

  # Clearing the gate is enough: the lifecycle was never overwritten, so there is
  # no prior status to restore and no window in which a worker that reported
  # out-of-band while gated could be resurrected.
  [ -n "$subject" ] && registry_close_gate "$subject"

  case "$resume" in
    reinject)
      local tag msg
      case "$decision" in approve) tag="[APPROVED]";; *) tag="[REJECTED]";; esac
      msg="$tag gate $id"
      [ -n "$note" ] && msg="$msg — $note"
      if [ -z "$subject" ]; then
        resume_error="resume=reinject but gate has no subject_sid"
      elif ! command -v "$TELEPTY" >/dev/null 2>&1 || \
           ! "$TELEPTY" inject --submit-force --from "$ORCH_SID" "$subject" "$msg" >/dev/null 2>&1; then
        # Gated worker died before approval: status restore still applied above,
        # so the normal sweep reclaims it. Surface the failure via exit code.
        resume_error="resume inject to $subject failed"
      fi
      ;;
    registry-clear-redispatch)
      if [ -z "$subject" ]; then
        resume_error="resume=registry-clear-redispatch but gate has no subject_sid"
      elif [ "$decision" = approve ]; then
        registry_clear_redispatch "$subject"
      else
        registry_set_lifecycle "$subject" stuck_error
      fi
      ;;
    *) ;;  # none — manual/info gate
  esac

  gate_patch "$claim" "status=$status" "decision=$decision" "decided_at=$now" \
    "note=$note" "resume_error=$resume_error"
  mv "$claim" "$DECIDED_DIR/$id.json"

  if [ -n "$resume_error" ]; then
    echo "hitl: $id $status (resume=$resume FAILED: $resume_error)" >&2
    rc=1
  else
    echo "hitl: $id $status (resume=$resume ok)"
  fi
  return "$rc"
}

cmd_remind() {
  local now due; now=$(now_iso)
  due=$(PENDING_DIR="$PENDING_DIR" NOW="$now" INTERVAL="$REMIND_INTERVAL_SECONDS" python3 - <<'PY'
import datetime, glob, json, os, sys

def parse(ts):
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))

now = parse(os.environ["NOW"])
interval = int(os.environ["INTERVAL"])
for path in sorted(glob.glob(os.path.join(os.environ["PENDING_DIR"], "*.json"))):
    try:
        gate = json.load(open(path))
    except Exception:
        print("HITL_GATE_CORRUPT %s" % path, file=sys.stderr)
        continue
    if not gate.get("notified_at"):
        print("%s\tnotify" % path)        # failed notify — retry now, not in 24h
        continue
    last = gate.get("last_reminded_at")
    try:
        stale = last is None or (now - parse(last)).total_seconds() >= interval
    except Exception:
        stale = True
    if stale:
        print("%s\tremind" % path)
PY
)
  [ -n "$due" ] || return 0
  local path what
  while IFS=$'\t' read -r path what; do
    [ -n "$path" ] || continue
    if notify_gate "$path"; then
      if [ "$what" = notify ]; then
        gate_patch "$path" "notified_at=$now" "last_reminded_at=$now"
      else
        gate_patch "$path" "last_reminded_at=$now"
      fi
    else
      echo "hitl: remind failed for $(gate_field "$path" id)" >&2
    fi
  done <<< "$due"
}

case "${1:-}" in
  open)    shift; cmd_open "$@";;
  list)    shift; cmd_list "$@";;
  show)    shift; cmd_show "$@";;
  approve) shift; cmd_decide approve "$@";;
  reject)  shift; cmd_decide reject "$@";;
  remind)  shift; cmd_remind "$@";;
  -h|--help|help|"") usage 0;;
  *) echo "hitl: unknown command '$1'" >&2; usage 1;;
esac
