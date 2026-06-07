#!/usr/bin/env bash
# ask.sh — the sanctioned PEER→PEER info-request/-reply channel (#533 Phase 1).
#
# ADR/spec: docs/adr/2026-06-07-session-comms-guardrail.md
#           docs/superpowers/specs/2026-06-07-session-comms-guardrail.md
#
# This is the ONLY blessed worker→worker channel (exactly as bin/dispatch.sh is the
# blessed dispatch channel under Rule 32). It wraps `telepty inject` for the
# read-only info lane and stamps a structural `ask-request`/`ask-reply` envelope +
# the per-pairkey__thread round counter. Work-delegation has no sanctioned envelope
# → it fails by construction (deny-by-default whitelist, NOT NLP).
#
# Lane: sender ≠ orchestrator AND target ≠ orchestrator. An --to/--from on the
# orchestrator is REFUSED (use bin/dispatch.sh / the REPORT path instead).
#
# 3-round cap (per pairkey__thread): the 4th request is REFUSED + auto-escalated
# (deliberation on --conflict, else an orchestrator HOLD). Reset on `close`.
#
# Article 17 (무의존): pure bash + python3 stdlib + telepty. No npm runtime deps,
# no build artefact required — the stock-telepty Phase-1 fallback path. State I/O is
# atomic (tmp+os.replace under flock), matching session-reconciler.sh's convention.
#
# Usage:
#   ask.sh --from <sid> --to <sid> --thread <id> --round <n> request "<question>"
#   ask.sh --from <sid> --to <sid> --thread <id> --round <n> reply   "<answer>"
#   ask.sh --from <sid> --to <sid> --thread <id> [--round <n>] [--conflict] reply "<answer>"
#   ask.sh --from <sid> --to <sid> --thread <id> close
#   ask.sh --help
#
# Exit codes: 0 OK (sent / closed), 4 usage / lane-refusal, 7 cap tripped (refused),
#             8 conflict escalation (refused).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TELEPTY="${TELEPTY:-telepty}"
SESSION_COMMS_DIR="${SESSION_COMMS_DIR:-$REPO_DIR/state/session-comms}"
TELE="$SESSION_COMMS_DIR/telemetry.jsonl"
ROUND_CAP="${PEER_ROUND_CAP:-3}"
# Orchestrator sid(s) — the ORCH LANE is out of scope (REPORT/HOLD/dispatch keep
# flowing through src/session/inject-parser.ts). Configurable; defaults match the
# spec (§1). Space-separated.
ORCH_SIDS="${AIGENTRY_ORCHESTRATOR_SIDS:-orchestrator aigentry-orchestrator-claude}"

usage() { sed -n '20,33p' "$0"; }

now_iso() {
  if [ -n "${ASK_NOW:-}" ]; then printf '%s' "$ASK_NOW"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))'
}

is_orchestrator() {
  local sid="$1" o
  for o in $ORCH_SIDS; do [ "$sid" = "$o" ] && return 0; done
  return 1
}

# pairkey: the two sids sorted then joined with __ (so A↔B and B↔A share a counter).
pairkey_of() {
  printf '%s\n%s\n' "$1" "$2" | LC_ALL=C sort | paste -sd'_' - | sed 's/_/__/'
}

# emit_tele <reason> — append one telemetry JSON line (reuses the spawn-events
# `reason` discipline; §7). Best-effort: never blocks the primary flow.
emit_tele() {
  local reason="$1" now; now=$(now_iso)
  REASON="$reason" NOW="$now" PAIRKEY="$pairkey" THREAD="$thread" \
    FROM="$from" TO="$to" python3 - >> "$TELE" <<'PY' || true
import json, os
print(json.dumps({
    "ts": os.environ["NOW"],
    "event": "peer_comms",
    "reason": os.environ["REASON"],
    "pairkey": os.environ["PAIRKEY"],
    "thread": os.environ["THREAD"],
    "from": os.environ["FROM"],
    "to": os.environ["TO"],
}, ensure_ascii=False))
PY
}

# build_envelope <kind> <round> <text> — print the compact fenced-JSON-free
# envelope object (one line) to stdout.
build_envelope() {
  local kind="$1" rnd="$2" body="$3"
  KIND="$kind" FROM="$from" TO="$to" THREAD="$thread" RND="$rnd" BODY="$body" \
    python3 - <<'PY'
import json, os
kind = os.environ["KIND"]
env = {
    "kind": kind,
    "from": os.environ["FROM"],
    "to": os.environ["TO"],
    "thread_id": os.environ["THREAD"],
    "round": int(os.environ["RND"] or 0),
}
if kind == "ask-request":
    env["question"] = os.environ["BODY"]
    env["reply_to"] = os.environ["FROM"]
else:
    env["answer"] = os.environ["BODY"]
print(json.dumps(env, ensure_ascii=False, separators=(",", ":")))
PY
}

inject_peer() {
  local msg="$1"
  "$TELEPTY" inject --from "$from" --submit "$to" "$msg"
}

# escalate_orchestrator <excerpt> — route a HOLD upward (the escalation REPLACES the
# blocked inject; the channel never silently drops — §6).
escalate_orchestrator() {
  local excerpt="$1" orch
  orch="${ORCH_SIDS%% *}"
  "$TELEPTY" inject --from "$from" --submit "$orch" \
    "HOLD: peer-comms guardrail | from: $from | to: $to | thread: $thread | $excerpt" || true
}

from=""; to=""; thread=""; conflict=0; action=""; text=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from="$2"; shift 2;;
    --to) to="$2"; shift 2;;
    --thread) thread="$2"; shift 2;;
    # --round <n> is accepted per the spec §3 CLI but ADVISORY: the authoritative
    # per-pairkey__thread counter is state-derived, so the value is consumed-and-discarded.
    --round) shift 2;;
    --conflict) conflict=1; shift;;
    -h|--help) usage; exit 0;;
    request|reply|close) action="$1"; shift; if [ $# -gt 0 ]; then text="$1"; shift; fi;;
    *) echo "ask.sh: unknown arg: $1" >&2; usage >&2; exit 4;;
  esac
done

[ -n "$from" ]   || { echo "ask.sh: --from required" >&2; exit 4; }
[ -n "$to" ]     || { echo "ask.sh: --to required" >&2; exit 4; }
[ -n "$thread" ] || { echo "ask.sh: --thread required" >&2; exit 4; }
[ -n "$action" ] || { echo "ask.sh: request|reply|close required" >&2; exit 4; }

# ── Lane check (§3.1): the orchestrator lane is out of scope. ──
if is_orchestrator "$to" || is_orchestrator "$from"; then
  echo "ask.sh: orchestrator lane is out of scope — use bin/dispatch.sh / the REPORT path" >&2
  exit 4
fi

mkdir -p "$SESSION_COMMS_DIR"
pairkey=$(pairkey_of "$from" "$to")
state_file="$SESSION_COMMS_DIR/${pairkey}__${thread}.json"

# ── Atomic state read-modify-write: decide the action under flock. Prints two
# lines: <DECISION> and <round-to-stamp>. DECISION ∈ SEND/CAP_TRIP/CONFLICT/CLOSED.
decision_out=$(STATE_FILE="$state_file" PAIRKEY="$pairkey" FROM="$from" TO="$to" \
  THREAD="$thread" ACTION="$action" CONFLICT="$conflict" CAP="$ROUND_CAP" \
  NOW="$(now_iso)" python3 - <<'PY'
import fcntl, json, os

path = os.environ["STATE_FILE"]
action = os.environ["ACTION"]
conflict = os.environ["CONFLICT"] == "1"
cap = int(os.environ["CAP"])
now = os.environ["NOW"]
parties = sorted([os.environ["FROM"], os.environ["TO"]])

# open-or-create, then exclusive-lock the read-modify-write
fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
with os.fdopen(fd, "r+") as fh:
    fcntl.flock(fh, fcntl.LOCK_EX)
    try:
        st = json.load(fh)
    except Exception:
        st = {}
    st.setdefault("pairkey", os.environ["PAIRKEY"])
    st.setdefault("thread_id", os.environ["THREAD"])
    st.setdefault("rounds", 0)
    st.setdefault("parties", parties)
    st.setdefault("status", "open")
    st.setdefault("escalated", False)

    decision = "ERR"
    if conflict:
        # --conflict fast-path: immediate deliberation escalation regardless of round.
        st["escalated"] = True
        st["last_kind"] = "conflict"
        st["last_round_at"] = now
        decision = "CONFLICT"
    elif action == "close":
        st["status"] = "closed"
        st["rounds"] = 0
        st["escalated"] = False
        st["last_kind"] = "close"
        st["last_round_at"] = now
        decision = "CLOSED"
    elif action == "request":
        if st["rounds"] >= cap:
            # the would-be (cap+1)th round → refuse + escalate; counter stays at cap.
            st["escalated"] = True
            st["last_kind"] = "cap_tripped"
            st["last_round_at"] = now
            decision = "CAP_TRIP"
        else:
            st["rounds"] += 1
            st["status"] = "open"
            st["last_kind"] = "ask-request"
            st["last_round_at"] = now
            decision = "SEND"
    elif action == "reply":
        # a reply rides the current round — it does NOT bump the counter.
        st["status"] = "open"
        st["last_kind"] = "ask-reply"
        st["last_round_at"] = now
        decision = "SEND"

    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as out:
        json.dump(st, out, indent=2, ensure_ascii=False)
        out.write("\n")
    os.replace(tmp, path)
    print(decision)
    print(st["rounds"])
PY
)
decision=$(printf '%s\n' "$decision_out" | sed -n '1p')
cur_round=$(printf '%s\n' "$decision_out" | sed -n '2p')

case "$decision" in
  SEND)
    if [ "$action" = "request" ]; then
      inject_peer "$(build_envelope ask-request "$cur_round" "$text")"
      emit_tele peer_ask_request_sent
    else
      inject_peer "$(build_envelope ask-reply "$cur_round" "$text")"
      emit_tele peer_ask_reply_sent
    fi
    exit 0
    ;;
  CLOSED)
    emit_tele peer_thread_closed
    exit 0
    ;;
  CAP_TRIP)
    emit_tele peer_cap_tripped
    escalate_orchestrator "cap=${ROUND_CAP} tripped (round $((ROUND_CAP+1)) refused) — orchestrator decides next steps (HITL)"
    emit_tele peer_escalated_orchestrator
    echo "ask.sh: ${ROUND_CAP}-round cap tripped for ${pairkey}__${thread} — refused + escalated to orchestrator" >&2
    exit 7
    ;;
  CONFLICT)
    escalate_orchestrator "CONFLICT → deliberation requested (≥3 parties) for ${pairkey}__${thread}"
    emit_tele peer_escalated_deliberation
    echo "ask.sh: --conflict on ${pairkey}__${thread} — refused + escalated to deliberation" >&2
    exit 8
    ;;
  *)
    echo "ask.sh: internal error (decision='$decision')" >&2
    exit 1
    ;;
esac
