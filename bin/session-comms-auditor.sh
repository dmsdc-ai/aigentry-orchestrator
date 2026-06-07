#!/usr/bin/env bash
# session-comms-auditor.sh — orchestrator-side PEER-LANE auditor (#533 Phase 1).
#
# ADR/spec: docs/adr/2026-06-07-session-comms-guardrail.md
#           docs/superpowers/specs/2026-06-07-session-comms-guardrail.md §4
#
# Runs on the existing reconcile tick (wired from session-reconciler.sh — no new
# daemon, §1 경량). Tails telepty's peer-inject log and classifies each
# non-orchestrator↔non-orchestrator inject with the structural envelope predicate
# (§2.3 — whitelist, NOT NLP):
#   • orchestrator-lane injects (from/to == orchestrator) → IGNORED.
#   • in-policy ask-request/ask-reply emitted via raw inject → RECONCILE the round
#     counter (so the cap still holds) + telemetry peer_ask_reconciled.
#   • out-of-policy (no envelope / malformed / work-order shape) → telemetry
#     peer_inject_out_of_policy + a HOLD pushed to the orchestrator inbox naming
#     {from,to,excerpt} (Phase 1 is warn-only — detect/count/escalate, NEVER
#     hard-block in-band; the inject already happened. Daemon hard-block = Phase 2,
#     telepty#18).
#
# The peer-inject log is NEVER consumed/cleared (warn-mode). A byte-offset cursor
# avoids re-flagging already-audited injects on subsequent ticks.
#
# Article 17 (무의존): pure bash + python3 stdlib + telepty. No npm runtime deps.
#
# Usage: session-comms-auditor.sh   # one audit pass over new peer-inject log lines
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
TELEPTY="${TELEPTY:-telepty}"
SESSION_COMMS_DIR="${SESSION_COMMS_DIR:-$REPO_DIR/state/session-comms}"
TELE="$SESSION_COMMS_DIR/telemetry.jsonl"
CURSOR="$SESSION_COMMS_DIR/.audit-cursor"
PEER_INJECT_LOG="${AIGENTRY_PEER_INJECT_LOG:-$REPO_DIR/state/dispatch/peer-injects.jsonl}"
ROUND_CAP="${PEER_ROUND_CAP:-3}"
ORCH_SIDS="${AIGENTRY_ORCHESTRATOR_SIDS:-orchestrator aigentry-orchestrator-claude}"

now_iso() {
  if [ -n "${AUDITOR_NOW:-}" ]; then printf '%s' "$AUDITOR_NOW"; return; fi
  python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00","Z"))'
}

# Dormant when there is nothing to tail — the always-safe no-op (cf. the
# reconciler's surface_* consumers).
[ -f "$PEER_INJECT_LOG" ] || exit 0
mkdir -p "$SESSION_COMMS_DIR"

# Classify + reconcile in one python pass. Writes telemetry directly; reconciles
# in-policy round counters (flock-atomic, matching ask.sh); prints one
# "HOLD\t<from>\t<to>\t<excerpt>" line per out-of-policy inject for the shell to
# route upward. Advances the byte cursor so re-ticks don't re-flag.
holds=$(SESSION_COMMS_DIR="$SESSION_COMMS_DIR" TELE="$TELE" CURSOR="$CURSOR" \
  PEER_INJECT_LOG="$PEER_INJECT_LOG" CAP="$ROUND_CAP" ORCH_SIDS="$ORCH_SIDS" \
  NOW="$(now_iso)" python3 - <<'PY'
import fcntl, json, os, re

log_path = os.environ["PEER_INJECT_LOG"]
cursor_path = os.environ["CURSOR"]
tele_path = os.environ["TELE"]
comms_dir = os.environ["SESSION_COMMS_DIR"]
cap = int(os.environ["CAP"])
now = os.environ["NOW"]
orch = set(os.environ["ORCH_SIDS"].split())

# byte-offset cursor (reset if the log shrank/rotated)
size = os.path.getsize(log_path)
start = 0
try:
    start = int(open(cursor_path).read().strip() or "0")
except Exception:
    start = 0
if start > size:
    start = 0

FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
MD_REQ = re.compile(r"^ASK_REQUEST:\s*(?P<to>\S+)\s*\|\s*from:\s*(?P<from>\S+)\s*\|\s*thread:\s*(?P<thread>\S+)\s*\|\s*round:\s*(?P<round>\d+)\s*\|\s*q:\s*(?P<body>.*)$")
MD_REP = re.compile(r"^ASK_REPLY:\s*(?P<to>\S+)\s*\|\s*from:\s*(?P<from>\S+)\s*\|\s*thread:\s*(?P<thread>\S+)\s*\|\s*round:\s*(?P<round>\d+)\s*\|\s*a:\s*(?P<body>.*)$")


def extract_envelope(body):
    """Return a dict envelope from the inject body, or None. Fenced JSON first,
    then raw JSON, then the markdown ASK_REQUEST/ASK_REPLY fallback (§2)."""
    if not isinstance(body, str):
        return None
    m = FENCE.search(body)
    candidate = m.group(1) if m else body.strip()
    try:
        obj = json.loads(candidate)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    for line in body.splitlines():
        line = line.strip()
        mr = MD_REQ.match(line) or MD_REP.match(line)
        if mr:
            kind = "ask-request" if line.startswith("ASK_REQUEST") else "ask-reply"
            d = mr.groupdict()
            env = {"kind": kind, "from": d["from"], "to": d["to"],
                   "thread_id": d["thread"], "round": int(d["round"])}
            env["question" if kind == "ask-request" else "answer"] = d["body"]
            return env
    return None


def in_policy(env, rec_from, rec_to):
    """§2.3 validity predicate — structural whitelist, not semantic."""
    if not isinstance(env, dict):
        return False
    if env.get("kind") not in ("ask-request", "ask-reply"):
        return False
    if env.get("from") != rec_from or env.get("to") != rec_to:
        return False
    if not env.get("thread_id"):
        return False
    rnd = env.get("round")
    if not isinstance(rnd, int) or rnd < 1 or rnd > cap:
        return False
    return True


def emit_tele(reason, rec_from, rec_to, thread, pairkey, excerpt=""):
    with open(tele_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "ts": now, "event": "peer_comms_audit", "reason": reason,
            "from": rec_from, "to": rec_to, "thread": thread,
            "pairkey": pairkey, "excerpt": excerpt[:120],
        }, ensure_ascii=False) + "\n")


def reconcile(env, pairkey, thread):
    """Reconcile a raw-inject in-policy envelope into the round counter (flock)."""
    path = os.path.join(comms_dir, "%s__%s.json" % (pairkey, thread))
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    with os.fdopen(fd, "r+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            st = json.load(fh)
        except Exception:
            st = {}
        st.setdefault("pairkey", pairkey)
        st.setdefault("thread_id", thread)
        st.setdefault("rounds", 0)
        st.setdefault("parties", sorted([env["from"], env["to"]]))
        st.setdefault("status", "open")
        st.setdefault("escalated", False)
        if env["kind"] == "ask-request" and st["rounds"] < cap:
            st["rounds"] += 1
        st["last_kind"] = env["kind"] + "(reconciled)"
        st["last_round_at"] = now
        tmp = path + ".tmp.%d" % os.getpid()
        with open(tmp, "w", encoding="utf-8") as out:
            json.dump(st, out, indent=2, ensure_ascii=False)
            out.write("\n")
        os.replace(tmp, path)


holds = []
with open(log_path, encoding="utf-8") as fh:
    fh.seek(start)
    for raw in fh:
        raw = raw.strip()
        if not raw:
            continue
        try:
            rec = json.loads(raw)
        except Exception:
            continue
        rec_from = rec.get("from", "")
        rec_to = rec.get("to", "")
        body = rec.get("body", "")
        # ORCH LANE → out of scope (untouched; never classified/logged).
        if rec_from in orch or rec_to in orch:
            continue
        env = extract_envelope(body)
        if in_policy(env, rec_from, rec_to):
            pairkey = "__".join(sorted([rec_from, rec_to]))
            thread = env["thread_id"]
            reconcile(env, pairkey, thread)
            emit_tele("peer_ask_reconciled", rec_from, rec_to, thread, pairkey)
        else:
            pairkey = "__".join(sorted([rec_from, rec_to])) if rec_from and rec_to else ""
            excerpt = " ".join(str(body).split())[:120]
            emit_tele("peer_inject_out_of_policy", rec_from, rec_to, "", pairkey, excerpt)
            holds.append("\t".join(["HOLD", rec_from, rec_to, excerpt]))

with open(cursor_path, "w") as cf:
    cf.write(str(size))

for h in holds:
    print(h)
PY
)

# Route each out-of-policy inject upward: a HOLD into the orchestrator inbox so the
# orchestrator (HITL) can correct the worker. Phase 1 cannot block in-band; it
# detects + escalates. Best-effort — telemetry already recorded the violation.
orch_sid="${ORCH_SIDS%% *}"
if [ -n "$holds" ]; then
  while IFS=$'\t' read -r _tag h_from h_to h_excerpt; do
    [ "$_tag" = "HOLD" ] || continue
    "$TELEPTY" inject --submit "$orch_sid" \
      "HOLD: peer-lane out-of-policy inject | from: $h_from | to: $h_to | excerpt: $h_excerpt" \
      >/dev/null 2>&1 || true
  done <<< "$holds"
fi

exit 0
