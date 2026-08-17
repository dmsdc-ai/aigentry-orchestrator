#!/usr/bin/env bash
# T122 (#899 tranche 4) — the peer-lane auditor contract lines NO guard pinned.
#
# Two guards name bin/session-comms-auditor.sh and both drive it: T45 asserts that
# two out-of-policy injects are counted, that a HOLD reaching the orchestrator
# mentions both sids, that the orchestrator lane is ignored, that a well-formed
# ask-request creates a counter file, and that the peer-inject log is not consumed.
# T91 block (6) asserts that an undelivered HOLD is a non-zero exit naming
# UNDELIVERED. Both are worth keeping exactly as they are, and both together leave
# 33 of the 36 measured behaviours unpinned: the byte cursor in all four of its arms,
# every field and byte of the round-counter file, the whole out-of-policy predicate
# matrix, the excerpt's collapse-then-truncate order, the telemetry line's own bytes,
# the `telepty inject` argv, the second orchestrator sid, PEER_ROUND_CAP, and the
# fact that this script reads no argv at all.
#
# Each of those is a line a port can drop in silence. Violations still get flagged,
# a counter file still appears, and the only visible change is a round counter that
# stops capping peer traffic, a cursor that re-flags or skips, a telemetry line a
# grep no longer matches, or a HOLD that no longer names who did what. THIS IS A
# LIVE PATH — src/reconciler/cli.ts:1292-1293 runs it every 60s from launchd with
# TELEPTY in the child env and folds any non-zero into ONE log line — so this guard
# is the characterization test that makes the port's parity measurable rather than
# reviewed.
#
# PARITY IS RE-RUNNABLE, not asserted from memory. The script under test is
# $AUDITOR_UNDER_TEST, defaulting to bin/session-comms-auditor.sh. Blocks A-J passed
# against the ORIGINAL bash (`git show 31384e7:bin/session-comms-auditor.sh`) before
# the port landed:
#
#   git show 31384e7:bin/session-comms-auditor.sh > bin/.auditor-original.sh
#   chmod +x bin/.auditor-original.sh
#   AUDITOR_UNDER_TEST="$PWD/bin/.auditor-original.sh" COMMS_PARITY_ORIGINAL=1 \
#     bash tests/dispatch/T122_comms_auditor_parity.sh
#
# The commit is NOT referenced from the guard body on purpose: CI checks out at
# fetch-depth 1, so a `git show` here would fail on the runner for a reason that has
# nothing to do with the peer lane.
#
# BLOCKS K AND L ARE THE ONE DECLARED FIX (D1), so they are the two blocks that
# CANNOT pass against both implementations. COMMS_PARITY_ORIGINAL=1 makes them
# assert the ORIGINAL's behaviour instead of the port's — nothing is skipped in
# either direction, which is what keeps "the bash did X, the port does Y" a
# measurement rather than a claim:
#
#   K/L  D1 — ONE untrusted peer-inject line used to disable this guardrail
#        PERMANENTLY. A line that is valid JSON but not an object (`json.loads`
#        succeeds, so the try/except written to skip bad lines never fires, and
#        `rec.get` raises one line later), or an envelope whose `thread_id` contains
#        `/` (the state path was built from it unvalidated — a path-traversal vector
#        into state/session-comms), killed the python pass with a traceback. Under
#        `set -e` that happened BEFORE the byte cursor was written, so: every later
#        peer inject went unaudited forever, and the pre-poison violation
#        re-escalated the SAME HOLD into the orchestrator inbox on every tick. Both
#        blocks tick THREE times to measure exactly that, from both sides.
#
# BLOCK M IS A REPRODUCED DEFECT (D2), so it is green against both: an empty `from`
# or `to` makes the tab-delimited HOLD fields collapse — tab is IFS whitespace — and
# the HOLD names the excerpt as the sender. It is pinned verbatim so the port cannot
# quietly "fix" the wire text a human reads, and so the defect cannot be lost.
#
# Deliberately NOT pinned: block J's mkdir-failure message. bash printed mkdir's own
# `Not a directory`, which is LOCALE-DEPENDENT; the exit code and the FACT of a
# stderr line are the contract. T116 block B and T120 set that precedent.
#
# Hermetic: the temp state dir from lib.sh, its recording telepty stub reached
# through an ABSOLUTE $TELEPTY (lib.sh:45) — which is also what keeps the shim's
# hardened /opt/homebrew/bin prefix from finding the real telepty this host has
# installed — fixture peer-inject logs, and AUDITOR_NOW for every clock. No session
# is contacted and nothing reaches :3848.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

AUD="${AUDITOR_UNDER_TEST:-$REPO_ROOT/bin/session-comms-auditor.sh}"
ORIGINAL="${COMMS_PARITY_ORIGINAL:-0}"
NOW="2026-08-17T12:00:00Z"

fail() { echo "FAIL[T122]: $*" >&2; exit 1; }
[ -x "$AUD" ] || fail "$AUD is not executable — every caller execs it directly"

export AUDITOR_NOW="$NOW"

# fresh <name> — a private comms dir + peer-inject log for one block. Sets: TELE LOG.
fresh() {
  export SESSION_COMMS_DIR="$T_TMP/$1/session-comms"
  export AIGENTRY_PEER_INJECT_LOG="$T_TMP/$1/peer-injects.jsonl"
  mkdir -p "$T_TMP/$1"
  TELE="$SESSION_COMMS_DIR/telemetry.jsonl"
  LOG="$AIGENTRY_PEER_INJECT_LOG"
  : > "$STUB_DISPATCH_LOG"
}

# aud — one audit pass. Sets: OUT RC ERRTXT.
aud() {
  local errf="$T_TMP/aud.err"
  set +e
  OUT=$("$AUD" "$@" 2>"$errf"); RC=$?
  set -e
  ERRTXT=$(cat "$errf" 2>/dev/null || true)
}

# telepty_rc <code> — replace the stub so `inject` exits <code>. $TELEPTY is absolute.
telepty_rc() {
  cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inject) printf '%s ' "telepty inject" "\$@" >> "$STUB_DISPATCH_LOG"; printf '\n' >> "$STUB_DISPATCH_LOG"; exit $1;;
  *)      exit 0;;
esac
EOF
  chmod +x "$STUB_BIN/telepty"
}
telepty_restore() { cp "$HERE/stubs/telepty" "$STUB_BIN/telepty"; chmod +x "$STUB_BIN/telepty"; }

# `grep -c` prints 0 and exits 1 on no match, but prints NOTHING for a file that does
# not exist — which is exactly the "no telemetry at all" case several blocks assert.
count() { local n; n=$(grep -c "$1" "$2" 2>/dev/null || true); echo "${n:-0}"; }
cursor() { cat "$SESSION_COMMS_DIR/.audit-cursor" 2>/dev/null || echo ABSENT; }
logsize() { wc -c < "$LOG" | tr -d ' '; }

# Fixture bodies. OOP is the raw work-delegation T45 uses; INPOL is its well-formed
# fenced ask-request.
OOP='{"ts":"t","from":"peer-A","to":"peer-B","body":"go implement X and push"}'
INPOL='{"ts":"t","from":"peer-A","to":"peer-B","body":"```json\n{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"th1\",\"round\":1,\"question\":\"q?\"}\n```"}'

# ── A. dormant: nothing to tail ⇒ exit 0 and NOTHING is created ─────────────
# `[ -f "$PEER_INJECT_LOG" ] || exit 0` is BEFORE `mkdir -p`, so unlike the Layer-D
# scheduler this script seeds no state dir on a no-op tick. A port that hoisted the
# mkdir would create state/session-comms on every host that never ran a peer inject.
fresh A; rm -f "$LOG"
aud
[ "$RC" -eq 0 ] || fail "A: no peer-inject log must exit 0, got $RC ($ERRTXT)"
[ ! -d "$SESSION_COMMS_DIR" ] || fail "A: a dormant pass created $SESSION_COMMS_DIR"
mkdir -p "$LOG"                                   # `[ -f ]` is false for a directory
aud
[ "$RC" -eq 0 ] || fail "A: a log path that is a directory must exit 0, got $RC"
[ ! -d "$SESSION_COMMS_DIR" ] || fail "A: a directory log path created state anyway"
rmdir "$LOG"

# ── B. an empty log: dir + cursor 0, no telemetry ───────────────────────────
fresh B; : > "$LOG"
aud
[ "$RC" -eq 0 ] || fail "B: rc=$RC ($ERRTXT)"
[ "$(cursor)" = "0" ] || fail "B: cursor should be 0, got $(cursor)"
[ ! -f "$TELE" ] || fail "B: an empty log produced telemetry: $(cat "$TELE")"

# ── C. out-of-policy: telemetry bytes, HOLD argv, cursor = log size ─────────
fresh C; printf '%s\n' "$OOP" > "$LOG"
aud
[ "$RC" -eq 0 ] || fail "C: a delivered HOLD must exit 0, got $RC ($ERRTXT)"
[ -z "$OUT" ] || fail "C: this script has no stdout; got: $OUT"
exp_tele='{"ts": "'"$NOW"'", "event": "peer_comms_audit", "reason": "peer_inject_out_of_policy", "from": "peer-A", "to": "peer-B", "thread": "", "pairkey": "peer-A__peer-B", "excerpt": "go implement X and push"}'
[ "$(cat "$TELE")" = "$exp_tele" ] || fail "C: telemetry bytes drifted.
want: $exp_tele
got:  $(cat "$TELE")"
# The stub logs a literal `telepty inject ` prefix and then every argument, so the
# verb appears twice; the trailing space is the stub's `printf '%s '` too. What is
# pinned is the argv after it: verb, --submit, sid, and ONE text argument (so an
# attacker-controlled excerpt can never become a flag or a word split).
exp_hold='telepty inject inject --submit orchestrator HOLD: peer-lane out-of-policy inject | from: peer-A | to: peer-B | excerpt: go implement X and push '
[ "$(cat "$STUB_DISPATCH_LOG")" = "$exp_hold" ] || fail "C: inject argv drifted.
want: $exp_hold
got:  $(cat "$STUB_DISPATCH_LOG")"
[ "$(cursor)" = "$(logsize)" ] || fail "C: cursor $(cursor) != log size $(logsize)"

# ── D. in-policy: the round counter's exact bytes, and every increment rule ──
# The counter exists to make the 3-round cap hold for raw injects too, so `rounds`
# is the one number in this whole script that a silent drift would disarm.
fresh D; printf '%s\n' "$INPOL" > "$LOG"
aud
[ "$RC" -eq 0 ] || fail "D: rc=$RC ($ERRTXT)"
read -r -d '' exp_state <<EOF || true
{
  "pairkey": "peer-A__peer-B",
  "thread_id": "th1",
  "rounds": 1,
  "parties": [
    "peer-A",
    "peer-B"
  ],
  "status": "open",
  "escalated": false,
  "last_kind": "ask-request(reconciled)",
  "last_round_at": "$NOW"
}
EOF
got_state=$(cat "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json")
[ "$got_state" = "$exp_state" ] || fail "D: counter-file bytes drifted.
want:
$exp_state
got:
$got_state"
[ "$(count peer_ask_reconciled "$TELE")" = "1" ] || fail "D: expected one peer_ask_reconciled"
[ ! -s "$STUB_DISPATCH_LOG" ] || fail "D: an in-policy ask-request was escalated: $(cat "$STUB_DISPATCH_LOG")"

# two ask-requests on one thread ⇒ rounds 2 (the counter counts, it does not latch)
fresh D2; printf '%s\n%s\n' "$INPOL" "$INPOL" > "$LOG"
aud
grep -q '"rounds": 2' "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json" \
  || fail "D: two in-policy requests did not reach rounds 2: $(cat "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json")"

# PEER_ROUND_CAP is the increment CEILING as well as the validity bound
fresh D3; printf '%s\n%s\n' "$INPOL" "$INPOL" > "$LOG"
PEER_ROUND_CAP=1 aud
grep -q '"rounds": 1' "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json" \
  || fail "D: PEER_ROUND_CAP=1 did not cap rounds at 1: $(cat "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json")"

# an ask-REPLY is in policy and must NOT increment (only requests spend a round)
fresh D4
printf '%s\n' '{"from":"peer-A","to":"peer-B","body":"{\"kind\":\"ask-reply\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"tr\",\"round\":1,\"answer\":\"a\"}"}' > "$LOG"
aud
grep -q '"rounds": 0' "$SESSION_COMMS_DIR/peer-A__peer-B__tr.json" \
  || fail "D: an ask-reply spent a round: $(cat "$SESSION_COMMS_DIR/peer-A__peer-B__tr.json")"
grep -q '"last_kind": "ask-reply(reconciled)"' "$SESSION_COMMS_DIR/peer-A__peer-B__tr.json" \
  || fail "D: last_kind drifted for an ask-reply"

# the markdown fallback (§2) — both shapes, and the +1 is 0→1, NOT to round:N
fresh D5
printf '%s\n' '{"from":"peer-A","to":"peer-B","body":"ASK_REQUEST: peer-B | from: peer-A | thread: th9 | round: 2 | q: what is the sig"}' > "$LOG"
aud
[ -f "$SESSION_COMMS_DIR/peer-A__peer-B__th9.json" ] || fail "D: the markdown ASK_REQUEST fallback did not reconcile"
grep -q '"rounds": 1' "$SESSION_COMMS_DIR/peer-A__peer-B__th9.json" \
  || fail "D: a markdown round:2 must still be a single 0→1 increment: $(cat "$SESSION_COMMS_DIR/peer-A__peer-B__th9.json")"
fresh D6
printf '%s\n' '{"from":"peer-A","to":"peer-B","body":"ASK_REPLY: peer-B | from: peer-A | thread: th9 | round: 1 | a: the sig is f(x)"}' > "$LOG"
aud
grep -q '"last_kind": "ask-reply(reconciled)"' "$SESSION_COMMS_DIR/peer-A__peer-B__th9.json" \
  || fail "D: the markdown ASK_REPLY fallback did not reconcile"

# ── E. the ignored orchestrator lane, and who the HOLD is addressed to ───────
# AIGENTRY_ORCHESTRATOR_SIDS is a 2-value default and NO guard covered the second
# value or the split. `${ORCH_SIDS%% *}` is the inject target: the FIRST word.
for who in orchestrator aigentry-orchestrator-claude; do
  fresh "E-$who"
  printf '%s\n' '{"from":"'"$who"'","to":"peer-B","body":"dispatch: go do real work"}' > "$LOG"
  aud
  [ "$RC" -eq 0 ] || fail "E: rc=$RC for the $who lane ($ERRTXT)"
  [ ! -f "$TELE" ] || fail "E: the $who lane was classified: $(cat "$TELE")"
  [ ! -s "$STUB_DISPATCH_LOG" ] || fail "E: the $who lane was escalated"
  [ "$(cursor)" = "$(logsize)" ] || fail "E: the $who lane did not advance the cursor"
done
fresh E3; printf '%s\n' '{"from":"peer-A","to":"orchestrator","body":"a report"}' > "$LOG"
aud
[ ! -f "$TELE" ] || fail "E: the orchestrator lane is both directions; TO was classified"
fresh E4; printf '%s\n' "$OOP" > "$LOG"
AIGENTRY_ORCHESTRATOR_SIDS="boss backup" aud
grep -q 'inject --submit boss ' "$STUB_DISPATCH_LOG" \
  || fail "E: the HOLD must go to the FIRST sid of AIGENTRY_ORCHESTRATOR_SIDS: $(cat "$STUB_DISPATCH_LOG")"

# ── F. the byte cursor, all four arms ────────────────────────────────────────
# The cursor is the only thing standing between warn-mode and re-paging an operator
# about the same violation once a minute, forever.
fresh F; printf '%s\n' "$OOP" > "$LOG"
aud
: > "$STUB_DISPATCH_LOG"
aud                                               # (i) re-tick: nothing re-flagged
[ "$(count peer_inject_out_of_policy "$TELE")" = "1" ] || fail "F: a re-tick re-classified an audited line"
[ ! -s "$STUB_DISPATCH_LOG" ] || fail "F: a re-tick re-escalated an audited violation"
printf '%s\n' "$OOP" > "$LOG"                     # (ii) log SHRANK ⇒ cursor resets
rm -f "$TELE"; : > "$STUB_DISPATCH_LOG"
printf '%s\n%s\n' "$OOP" "$OOP" > "$LOG"; aud; printf '%s\n' "$OOP" > "$LOG"
rm -f "$TELE"; : > "$STUB_DISPATCH_LOG"
aud
[ "$(count peer_inject_out_of_policy "$TELE")" = "1" ] || fail "F: a rotated (shrunk) log did not re-read from byte 0"
fresh F3; printf '%s\n' "$OOP" > "$LOG"           # (iii) unusable cursor bytes ⇒ 0
mkdir -p "$SESSION_COMMS_DIR"; printf 'garbage\n' > "$SESSION_COMMS_DIR/.audit-cursor"
aud
[ "$(count peer_inject_out_of_policy "$TELE")" = "1" ] || fail "F: a corrupt cursor did not read as 0"
fresh F4; printf '%s' "$OOP" > "$LOG"             # (iv) no trailing newline
aud
[ "$(count peer_inject_out_of_policy "$TELE")" = "1" ] || fail "F: a log with no trailing newline lost its last line"
[ "$(cursor)" = "$(logsize)" ] || fail "F: cursor $(cursor) != size $(logsize) with no trailing newline"

# ── G. the §2.3 predicate matrix — every arm that decides HOLD vs reconcile ──
# `envelope` is a well-formed ask-request with ONE field replaced. Every row here is
# the difference between counting a round and paging a human.
g_case() { # g_case <label> <json-body> <expect: hold|reconcile>
  fresh "G-$1"
  printf '{"from":"peer-A","to":"peer-B","body":%s}\n' "$2" > "$LOG"
  aud
  [ "$RC" -eq 0 ] || fail "G[$1]: rc=$RC ($ERRTXT)"
  if [ "$3" = hold ]; then
    grep -q peer_inject_out_of_policy "$TELE" || fail "G[$1]: expected out-of-policy, telemetry: $(cat "$TELE" 2>/dev/null)"
  else
    grep -q peer_ask_reconciled "$TELE" || fail "G[$1]: expected reconciled, telemetry: $(cat "$TELE" 2>/dev/null)"
  fi
}
g_case round-over-cap '"{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":4,\"question\":\"q\"}"' hold
g_case round-zero     '"{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":0,\"question\":\"q\"}"' hold
g_case round-string   '"{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":\"1\",\"question\":\"q\"}"' hold
g_case no-thread      '"{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"round\":1,\"question\":\"q\"}"' hold
g_case wrong-kind     '"{\"kind\":\"work-order\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":1}"' hold
g_case from-mismatch  '"{\"kind\":\"ask-request\",\"from\":\"peer-Z\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":1,\"question\":\"q\"}"' hold
g_case raw-json-ok    '"{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":1,\"question\":\"q\"}"' reconcile
# python bools ARE ints, so `1 <= True <= cap` held and a boolean round reconciled.
g_case round-true     '"{\"kind\":\"ask-request\",\"from\":\"peer-A\",\"to\":\"peer-B\",\"thread_id\":\"t\",\"round\":true,\"question\":\"q\"}"' reconcile

# ── H. junk lines, and the excerpt's collapse-then-truncate order ────────────
fresh H
{ printf 'not json at all\n'; printf '\n'; printf '   \n'; printf '%s\n' "$OOP"; } > "$LOG"
aud
[ "$RC" -eq 0 ] || fail "H: junk lines must not fail the pass, got $RC ($ERRTXT)"
[ "$(count peer_comms_audit "$TELE")" = "1" ] || fail "H: junk lines were classified: $(cat "$TELE")"
fresh H2
python3 -c 'import json,sys; sys.stdout.write(json.dumps({"from":"peer-A","to":"peer-B","body":"A\tB\n\n  C "+"x"*200})+"\n")' > "$LOG"
aud
# collapse happens BEFORE the 120-char cut, so the tab/newline run is ONE space and
# the excerpt is exactly 120 chars: "A B C " + 114 x's.
exp_ex="A B C $(printf 'x%.0s' $(seq 1 114))"
grep -qF "\"excerpt\": \"$exp_ex\"}" "$TELE" \
  || fail "H: excerpt collapse/truncate drifted. want 120 chars starting 'A B C x'; got: $(cat "$TELE")"

# ── I. an undelivered HOLD is not a clean pass (#835) ────────────────────────
# T91 asserts non-zero + UNDELIVERED for one violation. The COUNT, the second stderr
# line, and the missing-binary arm were unpinned — and the count is what an operator
# reads to know how many violations vanished.
fresh I; telepty_rc 1
printf '%s\n%s\n' "$OOP" '{"from":"peer-C","to":"peer-D","body":"do this"}' > "$LOG"
aud
[ "$RC" -eq 5 ] || fail "I: two refused HOLDs must exit 5, got $RC"
[ "$(grep -c UNDELIVERED <<< "$ERRTXT")" = "2" ] || fail "I: expected 2 UNDELIVERED lines, got: $ERRTXT"
grep -q '2 escalation(s) undelivered' <<< "$ERRTXT" || fail "I: the summary count is missing: $ERRTXT"
[ "$(cursor)" = "$(logsize)" ] || fail "I: the cursor must still advance — that is why rc 5 exists"
telepty_restore
fresh I2; printf '%s\n' "$OOP" > "$LOG"
TELEPTY="$T_TMP/no-such-telepty" aud
[ "$RC" -eq 5 ] || fail "I: a missing telepty binary must exit 5, got $RC ($ERRTXT)"
grep -q UNDELIVERED <<< "$ERRTXT" || fail "I: a missing telepty binary was not reported: $ERRTXT"

# ── J. argv, an unwritable state dir, and the fail-OPEN counter reset ────────
# This script reads NO argv — there is no --help and no usage.ts. A port that grew
# one would answer `--help` instead of auditing on a tick that passed a stray flag.
for a in --help -h bogus; do
  fresh "J-$a"; printf '%s\n' "$OOP" > "$LOG"
  aud "$a" --extra
  [ "$RC" -eq 0 ] || fail "J: '$a' must be ignored and the pass must run, got $RC ($ERRTXT)"
  grep -q peer_inject_out_of_policy "$TELE" || fail "J: '$a' short-circuited the audit pass"
done
fresh J2; printf '%s\n' "$OOP" > "$LOG"           # state dir under a regular file
printf 'x' > "$T_TMP/J2/blocker"
SESSION_COMMS_DIR="$T_TMP/J2/blocker/session-comms" aud
[ "$RC" -eq 1 ] || fail "J: an uncreatable state dir must exit 1, got $RC"
[ -n "$ERRTXT" ] || fail "J: an uncreatable state dir said nothing on stderr"
fresh J3; printf '%s\n' "$INPOL" > "$LOG"         # fail-OPEN, reproduced (D3 ticket)
mkdir -p "$SESSION_COMMS_DIR"; printf 'not json\n' > "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json"
aud
grep -q '"rounds": 1' "$SESSION_COMMS_DIR/peer-A__peer-B__th1.json" \
  || fail "J: an unparseable counter file must still read as {} and be replaced (reproduced defect)"

# ── K. D1 — a `thread_id` containing `/` (three ticks) ──────────────────────
# The fixture is a violation, then the poison, then a second violation. What is
# measured is not just "does it crash": it is whether the pre-poison violation is
# escalated EXACTLY ONCE and whether the post-poison violation is ever seen at all.
fresh K
{
  printf '%s\n' '{"from":"p-A","to":"p-B","body":"a violation BEFORE the poison"}'
  printf '%s\n' '{"from":"p-A","to":"p-B","body":"{\"kind\":\"ask-request\",\"from\":\"p-A\",\"to\":\"p-B\",\"thread_id\":\"899/t4\",\"round\":1,\"question\":\"q\"}"}'
  printf '%s\n' '{"from":"p-C","to":"p-D","body":"a violation AFTER the poison"}'
} > "$LOG"
for tick in 1 2 3; do aud; K_RC=$RC; done
if [ "$ORIGINAL" = "1" ]; then
  [ "$K_RC" -ne 0 ] || fail "K[original]: a slashed thread_id was expected to abort the pass"
  [ "$(cursor)" = "ABSENT" ] || fail "K[original]: the cursor was expected never to be written, got $(cursor)"
  [ "$(count 'BEFORE the poison' "$TELE")" = "3" ] \
    || fail "K[original]: three ticks were expected to re-flag the pre-poison violation three times"
  [ "$(count p-C "$TELE")" = "0" ] || fail "K[original]: the post-poison violation was expected to be unreachable"
else
  [ "$K_RC" -eq 0 ] || fail "K: a slashed thread_id must not fail the pass, got $K_RC ($ERRTXT)"
  [ "$(cursor)" = "$(logsize)" ] || fail "K: the cursor must advance past the poison, got $(cursor)/$(logsize)"
  [ "$(count 'BEFORE the poison' "$TELE")" = "1" ] \
    || fail "K: the pre-poison violation must be escalated EXACTLY once over three ticks, got $(count 'BEFORE the poison' "$TELE")"
  [ "$(count 'AFTER the poison' "$TELE")" = "1" ] || fail "K: the post-poison violation was never audited"
  # the slashed thread_id is itself escalated — it is a malformed envelope, and the
  # state path can no longer name a file outside SESSION_COMMS_DIR
  [ "$(count '899/t4' "$TELE")" = "1" ] || fail "K: the slashed thread_id was not escalated as out-of-policy"
  [ "$(count HOLD "$STUB_DISPATCH_LOG")" = "3" ] \
    || fail "K: expected 3 HOLDs total across three ticks, got $(count HOLD "$STUB_DISPATCH_LOG")"
  ls "$SESSION_COMMS_DIR" | grep -q 't4' && fail "K: a counter file was created from a slashed thread_id"
  # and a violation arriving LATER is still audited — the guardrail is not dead
  printf '%s\n' '{"from":"p-E","to":"p-F","body":"a brand new violation, one hour later"}' >> "$LOG"
  aud
  [ "$(count p-E "$TELE")" = "1" ] || fail "K: a violation arriving after the poison was not audited"
fi

# ── L. D1 — a line that is valid JSON but not an object (three ticks) ────────
# `json.loads` succeeds on `[…]`, so the try/except written to skip bad lines never
# fired and `rec.get` raised one line later. It is a malformed LOG LINE, in the same
# class as `not json at all`, so it is skipped the way that `continue` meant.
fresh L
{
  printf '%s\n' '{"from":"p-A","to":"p-B","body":"a violation BEFORE the poison"}'
  printf '%s\n' '["not","an","object"]'
  printf '%s\n' '{"from":"p-C","to":"p-D","body":"a violation AFTER the poison"}'
} > "$LOG"
for tick in 1 2 3; do aud; L_RC=$RC; done
if [ "$ORIGINAL" = "1" ]; then
  [ "$L_RC" -ne 0 ] || fail "L[original]: a non-object JSON line was expected to abort the pass"
  [ "$(cursor)" = "ABSENT" ] || fail "L[original]: the cursor was expected never to be written"
  [ "$(count p-C "$TELE")" = "0" ] || fail "L[original]: the post-poison violation was expected to be unreachable"
else
  [ "$L_RC" -eq 0 ] || fail "L: a non-object JSON line must not fail the pass, got $L_RC ($ERRTXT)"
  [ "$(cursor)" = "$(logsize)" ] || fail "L: the cursor must advance past the poison, got $(cursor)/$(logsize)"
  [ "$(count 'BEFORE the poison' "$TELE")" = "1" ] || fail "L: the pre-poison violation was re-escalated"
  [ "$(count 'AFTER the poison' "$TELE")" = "1" ] || fail "L: the post-poison violation was never audited"
  [ "$(count HOLD "$STUB_DISPATCH_LOG")" = "2" ] \
    || fail "L: expected 2 HOLDs total across three ticks, got $(count HOLD "$STUB_DISPATCH_LOG")"
fi

# ── M. D2 — an empty from/to garbles the HOLD's own fields (REPRODUCED) ─────
# `"\t".join(["HOLD", from, to, excerpt])` read back by `IFS=$'\t' read -r`: tab is
# IFS *whitespace*, so runs of tabs collapse, four fields arrive as two, and the
# excerpt lands in `from`. Telemetry stays correct. Pinned verbatim because the HOLD
# text is this script's contract with a human, and because a defect nobody measures
# is a defect that gets re-introduced.
fresh M; printf '%s\n' '{"ts":"t","body":"orphan body"}' > "$LOG"
aud
[ "$RC" -eq 0 ] || fail "M: rc=$RC ($ERRTXT)"
grep -qF '"from": "", "to": "", "thread": "", "pairkey": "", "excerpt": "orphan body"' "$TELE" \
  || fail "M: the telemetry line must still be CORRECT for a from-less record: $(cat "$TELE")"
grep -qF 'HOLD: peer-lane out-of-policy inject | from: orphan body | to:  | excerpt: ' "$STUB_DISPATCH_LOG" \
  || fail "M: the field collapse is a reproduced defect and must stay byte-identical: $(cat "$STUB_DISPATCH_LOG")"

echo "T122 PASS${ORIGINAL:+ (COMMS_PARITY_ORIGINAL=$ORIGINAL)}"
