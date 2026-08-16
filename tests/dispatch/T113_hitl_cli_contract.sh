#!/usr/bin/env bash
# T113 (#899 tranche 2d) — the hitl.sh CLI contract lines NO guard pinned.
#
# Six guards drive bin/hitl.sh and between them they pin the GATE well: idempotent
# open + the notify-once rule (T61), the blocking/not-swept registry axis (T62), the
# destructive pause and the corrupt-file fail-safe (T63), approve/reject with both
# resume hooks and the first-mover-wins claim (T64), the 24h reminder cadence and the
# failed-notify retry (T65), and the held re-dispatch arm (T74).
#
# What none of them measured is the CLI ITSELF: the usage text, the argument
# validation matrix, the exit codes, the exact stderr wording, the `list` print
# formats and ordering, `show`, and the record's key set and byte layout. Each is a
# line a port can drop silently — the gate still opens and still blocks, and the only
# visible change is an operator's typo answered by a different message, a `list` that
# sorts by filename instead of age, or a record with a renamed field that the next
# reader of state/hitl/ cannot parse. This guard is the characterization test that
# makes the port's parity with the shell measurable rather than reviewed.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $HITL_SH_UNDER_TEST, defaulting to bin/hitl.sh. Every block below passed against the
# ORIGINAL bash implementation (`git show 0d19814:bin/hitl.sh`, copied into bin/ so its
# SCRIPT_DIR resolves the same) before the port landed:
#
#   git show 0d19814:bin/hitl.sh > bin/.hitl-original.sh && chmod +x bin/.hitl-original.sh
#   HITL_SH_UNDER_TEST="$PWD/bin/.hitl-original.sh" bash tests/dispatch/T113_hitl_cli_contract.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with the gate.
#
# The ONE deliberate deviation, and why it is not asserted here: `--source` was
# validated with `grep -Eq`, which matches per LINE, so a source containing a newline
# was accepted and became a filename with a newline in it. The port's regex is
# whole-string. Strictly narrower — same die() message, same exit code, and the block
# below pins the message for every input both implementations agree on.
#
# Hermetic throughout: HITL_STATE_DIR is a temp dir (the six guards' own convention),
# telepty is lib.sh's recorder stub, the registry is a recorder, the clock is frozen
# via RECONCILER_NOW, and no sid outside this file's fixtures is ever named.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

HITL="${HITL_SH_UNDER_TEST:-$REPO_ROOT/bin/hitl.sh}"
export HITL_STATE_DIR="$T_TMP/hitl"
PENDING="$HITL_STATE_DIR/pending"
DECIDED="$HITL_STATE_DIR/decided"

fail() { echo "FAIL[T113]: $*" >&2; exit 1; }

# The registry seam is a recorder: `open --subject-sid` and every decide arm reach
# bin/dispatch-registry.py, and no test may touch the real one.
REG_LOG="$T_TMP/registry.log"; : > "$REG_LOG"
REG_STUB="$T_TMP/registry-stub.sh"
cat > "$REG_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$REG_LOG"
[ "\${1:-}" = get ] && printf 'delivery_attempt_started\n'
exit 0
EOF
chmod +x "$REG_STUB"
export DISPATCH_REGISTRY_PY="$REG_STUB"

OUT="$T_TMP/out"; ERR="$T_TMP/err"
# run <RECONCILER_NOW|-> <args…> — captures stdout/stderr/rc without tripping set -e.
RC=0
run() {
  local now="$1"; shift
  set +e
  if [ "$now" = "-" ]; then "$HITL" "$@" > "$OUT" 2> "$ERR"
  else RECONCILER_NOW="$now" "$HITL" "$@" > "$OUT" 2> "$ERR"; fi
  RC=$?
  set -e
}
want_rc()  { [ "$RC" = "$1" ] || fail "$2: rc=$RC, want $1 (out=$(cat "$OUT") err=$(cat "$ERR"))"; }
want_err() { grep -qxF -- "$1" "$ERR" || fail "$2: stderr=$(cat "$ERR"), want the line: $1"; }
want_out() { grep -qxF -- "$1" "$OUT" || fail "$2: stdout=$(cat "$OUT"), want the line: $1"; }
no_out()   { [ ! -s "$OUT" ] || fail "$1: stdout should be empty, got: $(cat "$OUT")"; }
no_err()   { [ ! -s "$ERR" ] || fail "$1: stderr should be empty, got: $(cat "$ERR")"; }
pending_count() { find "$PENDING" -name '*.json' | wc -l | tr -d ' '; }

# ── (1) the usage text and the command dispatcher ───────────────────────────
# `usage()` was `sed -n '2,23p' "$0"; exit "${1:-0}"` — 22 lines of the script's own
# header, on STDOUT, stopping deliberately before the body. A port that let the range
# drift, or moved the text to stderr, changes what every operator reads.
for verb in --help -h help; do
  run - "$verb"
  want_rc 0 "$verb"
  no_err "$verb"
  [ "$(wc -l < "$OUT" | tr -d ' ')" = "22" ] || fail "$verb printed $(wc -l < "$OUT") lines, want 22"
  want_out "# hitl.sh — HITL Gate CLI (ADR 2026-07-26-hitl-gate-primitive)." "$verb"
  want_out "#   kind   ∈ destructive | decision | info   (global pause | per-item | none)" "$verb"
  grep -q "set -euo pipefail" "$OUT" && fail "$verb printed past the header — the range was 2,23"
done
# No arguments at all is the same arm (`case "${1:-}"` … `"")`), not an error.
run - ; want_rc 0 "no-args"; no_err "no-args"
[ "$(wc -l < "$OUT" | tr -d ' ')" = "22" ] || fail "no-args printed $(wc -l < "$OUT") lines, want 22"

# An unknown command: the reason on STDERR, the usage text on STDOUT, exit 1.
run - badcmd
want_rc 1 "unknown command"
want_err "hitl: unknown command 'badcmd'" "unknown command"
want_out "# hitl.sh — HITL Gate CLI (ADR 2026-07-26-hitl-gate-primitive)." "unknown command"

# --help must not have created a gate, but it DOES create the state dirs: the shell
# ran `mkdir -p` on every invocation, ahead of the dispatcher.
[ -d "$PENDING" ] && [ -d "$DECIDED" ] || fail "the state dirs were not created on every invocation"
[ "$(pending_count)" = "0" ] || fail "the usage path created a gate"

# ── (2) open's validation matrix — exact wording, exit 1, nothing written ───
check_open_refusal() {
  local label="$1" want="$2"; shift 2
  run - open "$@"
  want_rc 1 "$label"
  want_err "$want" "$label"
  no_out "$label"
  [ "$(pending_count)" = "0" ] || fail "$label wrote a gate despite refusing"
}
check_open_refusal "no --source"  "hitl: open: --source is required"   --kind decision --question q
check_open_refusal "no --question" "hitl: open: --question is required" --source s --kind decision
check_open_refusal "bad --kind"   "hitl: open: --kind must be destructive|decision|info (got 'nope')" \
  --source s --kind nope --question q
check_open_refusal "empty --kind" "hitl: open: --kind must be destructive|decision|info (got '')" \
  --source s --question q
check_open_refusal "bad --resume" "hitl: open: --resume must be reinject|registry-clear-redispatch|none (got 'nope')" \
  --source s --kind info --question q --resume nope
check_open_refusal "bad --source" "hitl: open: --source must match [A-Za-z0-9._-]+" \
  --source 'bad source' --kind info --question q
check_open_refusal "unknown flag" "hitl: open: unknown argument '--nope'" --nope
# The order matters as much as the wording: --source is checked before --kind, so a
# call missing both is answered about --source.
check_open_refusal "source before kind" "hitl: open: --source is required" --kind nope --question q

# ── (3) the two `shift`/`set -e` artefacts the shell shipped ────────────────
# A flag in last position makes `shift 2` fail, and under `set -euo pipefail` that
# ends the script: exit 1, no message on either stream. Preserved, not "fixed" — a
# caller that suddenly got a usage error would be reading a new contract.
for dangling in "open --source" "open --kind" "list --kind" "approve someid --note"; do
  # shellcheck disable=SC2086
  run - $dangling
  want_rc 1 "dangling '$dangling'"
  no_out "dangling '$dangling'"
  no_err "dangling '$dangling'"
done
# cmd_decide's `shift 2 || true` leaves $@ holding the decision word when there is no
# id, so a bare `approve` is answered as an unknown ARGUMENT, not a missing id.
run - approve; want_rc 1 "bare approve"; want_err "hitl: approve: unknown argument 'approve'" "bare approve"
run - reject;  want_rc 1 "bare reject";  want_err "hitl: reject: unknown argument 'reject'"  "bare reject"

# ── (4) the record: key set, key ORDER, and the byte layout ────────────────
# ADR amendment invariant 2 is "same keys, same names, same types". Nothing pinned the
# key SET (T61 checks a subset of values), and a JSON writer that reorders or renames
# is invisible until something else reads state/hitl/.
id=$(RECONCILER_NOW="2026-08-16T04:00:00Z" "$HITL" open --source reconciler --kind decision \
  --resume registry-clear-redispatch --question "re-dispatch cap reached (count=1) for sid-A" \
  --options "approve=re-dispatch once more,reject=mark stuck_error" --context-ref "$T_TMP/ref.md")
python3 - "$PENDING/$id.json" <<'PY'
import collections, json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
gate = json.loads(raw, object_pairs_hook=collections.OrderedDict)
want = ["id", "dedupe_key", "source", "subject_sid", "kind", "resume", "question", "options",
        "context_ref", "prev_status", "created_at", "notified_at", "last_reminded_at",
        "status", "decision", "decided_at"]
if list(gate.keys()) != want:
    raise SystemExit(f"FAIL[T113]: record keys {list(gate.keys())}, want {want}")
# json.dump(indent=2, ensure_ascii=False) + one trailing newline — the bytes a reader
# of state/hitl/ sees, and the shape `show` cats back out verbatim.
if raw != json.dumps(gate, indent=2, ensure_ascii=False) + "\n":
    raise SystemExit("FAIL[T113]: record is not indent=2 / ensure_ascii=False / newline-terminated")
PY

# ── (5) list — print formats, the banner, the filter, ordering, corruption ──
# Three gates whose creation order is the REVERSE of their filename order, so a port
# that leaned on the glob instead of created_at fails here.
zeta_id=$(RECONCILER_NOW="2026-08-16T02:00:00Z" "$HITL" open --source zeta --kind destructive \
  --resume none --question "push feat/899-t2d to origin")
info_id=$(RECONCILER_NOW="2026-08-16T06:00:00Z" "$HITL" open --source alpha --kind info \
  --question "fyi: tranche 2d landed")

run - list
want_rc 0 "list"
# Exact-line matches: the two-space column separators and the `-` for a null subject
# are the format, and `list` is what an operator reads at 3am.
want_out "2026-08-16T02:00:00Z  $zeta_id  kind=destructive  resume=none  subject=-  push feat/899-t2d to origin" "list line"
want_out "    options: approve=re-dispatch once more,reject=mark stuck_error" "list options line"
# A destructive gate pending ⇒ the banner, printed ahead of the rows.
want_out "HITL_PAUSE gate=$zeta_id — autonomous actions paused (destructive gate pending)" "list banner"
[ "$(head -1 "$OUT" | cut -c1-10)" = "HITL_PAUSE" ] || fail "the banner is not the first line: $(head -1 "$OUT")"
# Oldest first, by created_at — not by filename (alpha/destructive/zeta all disagree).
python3 - "$OUT" <<'PY'
import re, sys
rows = [l for l in open(sys.argv[1], encoding="utf-8") if re.match(r"^\d{4}-", l)]
stamps = [l.split("  ")[0] for l in rows]
if stamps != sorted(stamps) or stamps != ["2026-08-16T02:00:00Z", "2026-08-16T04:00:00Z", "2026-08-16T06:00:00Z"]:
    raise SystemExit(f"FAIL[T113]: list order {stamps}, want oldest-first by created_at")
PY

# --kind filters the ROWS but not the banner: a destructive gate is pausing the loop
# whether or not the operator asked to see destructive gates.
run - list --kind info
want_rc 0 "list --kind"
grep -c "^HITL_PAUSE" "$OUT" | grep -qx 1 || fail "list --kind dropped the pause banner"
[ "$(grep -c "^2026-" "$OUT")" = "1" ] || fail "list --kind info showed $(grep -c '^2026-' "$OUT") rows, want 1"
grep -q "kind=info" "$OUT" || fail "list --kind info showed the wrong row: $(cat "$OUT")"

# --json is the machine surface: the filtered array, same indent, no banner at all.
run - list --json --kind destructive
want_rc 0 "list --json"
python3 - "$OUT" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8").read()
rows = json.loads(raw)
if len(rows) != 1 or rows[0]["kind"] != "destructive":
    raise SystemExit(f"FAIL[T113]: list --json --kind destructive returned {rows}")
if raw != json.dumps(rows, indent=2, ensure_ascii=False) + "\n":
    raise SystemExit("FAIL[T113]: list --json is not indent=2 / ensure_ascii=False / newline-terminated")
PY
grep -q "HITL_PAUSE" "$OUT" && fail "list --json printed the human banner into the JSON"

# A corrupt gate names itself on STDERR and does not stop the listing (the reconciler
# reads the same directory and treats it as destructive; hitl's own job is to be loud).
printf 'not json {' > "$PENDING/decision-broken-000000000000.json"
run - list
want_rc 0 "list with a corrupt gate"
want_err "HITL_GATE_CORRUPT $PENDING/decision-broken-000000000000.json" "corrupt gate"
[ "$(grep -c "^2026-" "$OUT")" = "3" ] || fail "a corrupt gate hid the readable ones: $(cat "$OUT")"
rm -f "$PENDING/decision-broken-000000000000.json"

# ── (6) show — pending, decided, absent ────────────────────────────────────
run - show "$id"
want_rc 0 "show pending"
diff <(cat "$PENDING/$id.json") "$OUT" >/dev/null || fail "show did not cat the record verbatim"
run - show ""; want_rc 1 "show empty id"; want_err "hitl: show: <id> is required" "show empty id"
run - show nosuchgate; want_rc 1 "show missing"; want_err "hitl: show: no such gate: nosuchgate" "show missing"

# ── (7) decide — the success line, the resume_error arm, the loser's answer ─
# resume=none: stdout, exit 0, and decided/ holds exactly the record — no stray
# .claim.* left behind by the two-rename claim.
run "2026-08-16T07:00:00Z" approve "$info_id"
want_rc 0 "approve resume=none"
want_out "hitl: $info_id approved (resume=none ok)" "approve resume=none"
no_err "approve resume=none"
[ "$(find "$DECIDED" -name '.*claim*' | wc -l | tr -d ' ')" = "0" ] \
  || fail "a decide left a stranded claim file: $(ls -a "$DECIDED")"

# reject prints the same shape with the other verb, and --note is recorded.
run "2026-08-16T07:01:00Z" reject "$zeta_id" --note "not now"
want_rc 0 "reject"
want_out "hitl: $zeta_id rejected (resume=none ok)" "reject"
python3 - "$DECIDED/$zeta_id.json" <<'PY'
import json, sys
g = json.load(open(sys.argv[1], encoding="utf-8"))
want = {"status": "rejected", "decision": "reject", "decided_at": "2026-08-16T07:01:00Z", "note": "not now"}
for k, v in want.items():
    if g.get(k) != v:
        raise SystemExit(f"FAIL[T113]: decided.{k} = {g.get(k)!r}, want {v!r}")
PY

# resume=reinject on a gate with no subject_sid: the hook cannot run, so the decision
# is still recorded and the FAILURE is surfaced through the exit code and stderr. This
# is the arm the ADR's "gated worker died before approval" row describes.
orphan=$(RECONCILER_NOW="2026-08-16T08:00:00Z" "$HITL" open --source loner --kind decision \
  --resume reinject --question "land as-is?")
run "2026-08-16T08:30:00Z" approve "$orphan" --note "yes"
want_rc 1 "reinject without a subject"
want_err "hitl: $orphan approved (resume=reinject FAILED: resume=reinject but gate has no subject_sid)" "reinject without a subject"
no_out "reinject without a subject"
[ -f "$DECIDED/$orphan.json" ] || fail "a failed resume hook aborted the move to decided/"
python3 - "$DECIDED/$orphan.json" <<'PY'
import json, sys
g = json.load(open(sys.argv[1], encoding="utf-8"))
want = {"status": "approved", "decision": "approve", "decided_at": "2026-08-16T08:30:00Z",
        "note": "yes", "resume_error": "resume=reinject but gate has no subject_sid"}
for k, v in want.items():
    if g.get(k) != v:
        raise SystemExit(f"FAIL[T113]: decided.{k} = {g.get(k)!r}, want {v!r}")
PY
# An empty --note is written as JSON null, not "" — `gate_patch`'s "empty ⇒ null" rule.
python3 - "$DECIDED/$info_id.json" <<'PY'
import json, sys
g = json.load(open(sys.argv[1], encoding="utf-8"))
if g.get("note") is not None or g.get("resume_error") is not None:
    raise SystemExit(f"FAIL[T113]: an absent --note/resume_error must be null, got {g.get('note')!r}/{g.get('resume_error')!r}")
PY
# The two losing paths are worded differently, and the difference is the operator's
# only clue about which one they hit.
run - approve "$info_id"; want_rc 1 "second decide"
want_err "hitl: approve: gate $info_id already decided" "second decide"
run - approve nosuchgate; want_rc 1 "decide a gate that never existed"
want_err "hitl: approve: no pending gate: nosuchgate" "decide a gate that never existed"

# ── (8) open when the notify fails — the gate still exists, exit stays 0 ────
# Art.17 pull fallback: a gate never depends on a live transport. T65 pins
# notified_at=null; the EXIT CODE and the operator-facing line were unpinned, and a
# port that propagated the failure would make every producer think open() failed.
printf '#!/bin/sh\nexit 1\n' > "$T_TMP/telepty-down"; chmod +x "$T_TMP/telepty-down"
set +e
down_id=$(TELEPTY="$T_TMP/telepty-down" RECONCILER_NOW="2026-08-16T09:00:00Z" "$HITL" open \
  --source downstream --kind info --question "transport down" 2> "$ERR")
RC=$?
set -e
want_rc 0 "open with a dead transport"
want_err "hitl: notify failed for $down_id — notified_at=null, will retry on next remind" "open with a dead transport"
[ -f "$PENDING/$down_id.json" ] || fail "open with a dead transport did not write the gate"

# ── (9) the env surface (ADR amendment invariant 8) ────────────────────────
# HITL_REMIND_INTERVAL is the cadence knob T65 exercises only at its 86400 default.
: > "$STUB_DISPATCH_LOG"
HITL_REMIND_INTERVAL=1 RECONCILER_NOW="2026-08-16T09:00:30Z" "$HITL" remind >/dev/null 2>&1
n=$(grep -c "HITL_GATE $down_id" "$STUB_DISPATCH_LOG" || true)
[ "$n" = "1" ] || fail "remind with HITL_REMIND_INTERVAL=1 re-notified $n times, want 1"
: > "$STUB_DISPATCH_LOG"
HITL_REMIND_INTERVAL=999999 RECONCILER_NOW="2026-08-16T09:01:00Z" "$HITL" remind >/dev/null 2>&1
[ ! -s "$STUB_DISPATCH_LOG" ] || fail "a huge HITL_REMIND_INTERVAL still re-notified: $(cat "$STUB_DISPATCH_LOG")"

# ORCHESTRATOR_SID is the notify target and the resume inject's --from.
: > "$STUB_DISPATCH_LOG"
elsewhere=$(ORCHESTRATOR_SID=other-orch RECONCILER_NOW="2026-08-16T10:00:00Z" "$HITL" open \
  --source router --kind info --question "who receives this?")
t_assert_contains "$STUB_DISPATCH_LOG" "--from router other-orch HITL_GATE $elsewhere"

# DISPATCH_STATE_DIR is INERT here. The shell read it into a variable it never used
# (hitl.sh:32); the port does not read it at all. Both must behave identically with
# it pointed at a path that does not exist.
run - list; before=$(cat "$OUT")
DISPATCH_STATE_DIR="$T_TMP/definitely-not-here" "$HITL" list > "$OUT" 2>"$ERR" \
  || fail "DISPATCH_STATE_DIR made hitl.sh fail — it must be inert"
diff <(printf '%s\n' "$before") "$OUT" >/dev/null || fail "DISPATCH_STATE_DIR changed hitl.sh's behaviour"

# ── (10) the registry argv, which is still a python3 subprocess by design ───
# ADR amendment "What the port does NOT fix": the status write stays a
# bin/dispatch-registry.py call with IDENTICAL argv. A port that reimplemented the
# registry write in TS would be a second writer, and this is what forbids it.
: > "$REG_LOG"
gated=$(RECONCILER_NOW="2026-08-16T11:00:00Z" "$HITL" open --source sid-G --subject-sid sid-G \
  --kind decision --resume reinject --question "phase boundary?")
grep -qxF "get --sid sid-G --pointer lifecycle.state" "$REG_LOG" \
  || fail "open did not read the lifecycle through dispatch-registry.py: $(cat "$REG_LOG")"
grep -qxF "set-gate --sid sid-G --state awaiting_user --now 2026-08-16T11:00:00Z" "$REG_LOG" \
  || fail "open did not set the gate axis through dispatch-registry.py: $(cat "$REG_LOG")"
: > "$REG_LOG"
RECONCILER_NOW="2026-08-16T11:30:00Z" "$HITL" approve "$gated" >/dev/null 2>&1 || true
grep -qxF "set-gate --sid sid-G --clear --now 2026-08-16T11:30:00Z" "$REG_LOG" \
  || fail "approve did not clear the gate axis through dispatch-registry.py: $(cat "$REG_LOG")"

echo "T113 PASS"
