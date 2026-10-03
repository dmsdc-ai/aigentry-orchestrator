#!/usr/bin/env bash
# T163 (#974 / #836) — a session listing is evidence only when it is ONE well-formed
# array, and an escalation is reported only when `telepty inject` delivered it.
#
# Measured on the REAL bin/lib/telepty-listing.sh and bin/ask.sh; only `telepty` and
# `curl` are fakes. The six guards that already drive these files (T44/T45/T46/T87/
# T122/T123) pass identically before and after the fix — each feeds a well-formed
# listing with both peers live — so none of them can catch either defect:
#
#   #974  a listing that is malformed, not an array, has a bad row, holds several JSON
#         documents or is empty was read as trusted, and a sid missing from it as
#         ABSENT. It must be untrusted (`broken`, rc 1) / UNKNOWN (rc 2), decided by
#         the body alone: zero HTTP probes, although every probe here would answer 200.
#   #836  a stale escalation (a party absent, nothing sent) or an undelivered one
#         (`telepty inject` exited non-zero) still printed "refused + escalated" and
#         emitted peer_escalated_*. Neither may claim it; exit 7 (cap) / 8 (conflict)
#         stays, there is at most one inject attempt (no retry), and round 4 never
#         reaches the peer.
#
# The 74 cases are the staged shell-fake regression (lt974vt) ported one for one, ids
# unchanged. Every staged oracle column is asserted as staged; the columns appended to
# a row, and the checks after the staged ones, are values the staged harness recorded
# but did not gate on (probe/list/inject counts, argv, stderr, state, telemetry).
#   A01-A13  telepty_listing_trusted <raw>        cases_trusted.txt   (rc)
#   S01-S14  telepty_sid_live fake-a              cases_sidlive.txt   (rc)
#   B01-B06  ask.sh --conflict reply              cases_ask.txt       (exit, telemetry
#   C01-C03  ask.sh 4th request (cap 3)           cases_ask.txt        reasons, orch
#            injects, "refused + escalated" claim; C: rounds 1-3 exit 0,0,0)
#   X01-X21  bad listings, through both functions    cases_listing_extra.txt
#   V01-V09  valid listings, through both functions  (t_rc/t_out/t_curl/s_rc/s_curl)
#   E01-E08  ask.sh compound / re-entry / close / lane, run_extra.sh (exits, reasons,
#            orch, peer, claim, NOT-escalated line, state esc/rounds/status, tmp left)
# S14 is the one sanctioned oracle change from the original repro: [1,{"id":"fake-a"}]
# is not a listing, so even the present sid is UNKNOWN (2), not live (0).
#
# What a pass does NOT show. Inject rc 0 is CLI delivery — not an ACK, not receipt by
# the orchestrator. The persisted `escalated` field is the cap/conflict DECISION flag,
# set before the outcome is known and true on the stale and undelivered paths as well;
# it is asserted as that, never as delivery. Fakes prove exit codes and argv, nothing
# about a real daemon, privacy or security.
#
# HERMETIC. Each run is `env -i` with a fake HOME holding a fixture token, TELEPTY and
# CURL as ABSOLUTE paths to the fakes below (so neither the `${CURL:-curl}` nor the
# ask.sh `command -v telepty` fallback is taken), fixture sids only (fake-a, fake-b,
# fake-orch), a frozen ASK_NOW, comms state under $T_TMP and TELEPTY_PORT=1. PATH is
# the harness PATH, not replaced (lib.sh rule 2); the telepty and curl first on it are
# tripwires, asserted unused at the end.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
LIB="$REPO_ROOT/bin/lib/telepty-listing.sh"
ASK="$REPO_ROOT/bin/ask.sh"

fail() { echo "FAIL[T163]: $*" >&2; exit 1; }
[ -f "$LIB" ] && [ -f "$ASK" ] || fail "bin/lib/telepty-listing.sh or bin/ask.sh missing"

NOW="2026-10-03T00:00:00Z"
FAKES="$T_TMP/fakes"; RUN="$T_TMP/run"; TMPD="$T_TMP/tmp"
mkdir -p "$FAKES" "$RUN" "$TMPD"
LIST_RC=0; HTTP=200; CURL_RC=0; ORCH_RC=0

# fake telepty: `list --json` serves $FAKE_LIST_FILE and exits $FAKE_LIST_RC; `inject`
# records its target and exits $FAKE_ORCH_INJECT_RC for the orchestrator, else 0.
cat > "$FAKES/telepty" <<"EOF"
#!/usr/bin/env bash
printf "%s\n" "$*" >> "$FAKE_LOG_DIR/telepty.calls"
case "$1" in
  list)
    cat "$FAKE_LIST_FILE"
    exit "${FAKE_LIST_RC:-0}" ;;
  inject)
    printf "%s\n" "$5" >> "$FAKE_LOG_DIR/inject.targets"
    [ "$5" = "$FAKE_ORCH" ] && exit "${FAKE_ORCH_INJECT_RC:-0}"
    exit 0 ;;
esac
exit 99
EOF
# fake curl: records argv (with the presented header), prints the configured
# http_code as -w would, exits $FAKE_CURL_RC (real curl prints 000 and exits 7 on a
# failed connect).
cat > "$FAKES/curl" <<"EOF"
#!/usr/bin/env bash
printf "%s\n" "$*" >> "$FAKE_LOG_DIR/curl.calls"
printf "%s" "${FAKE_HTTP_CODE:-200}"
exit "${FAKE_CURL_RC:-0}"
EOF
# Tripwires first on PATH: whatever resolves telepty or curl BY NAME lands here.
TRIPWIRE_LOG="$T_TMP/tripwire.log"; : > "$TRIPWIRE_LOG"
for tool in telepty curl; do
  cat > "$STUB_BIN/$tool" <<EOF
#!/usr/bin/env bash
printf "%s\n" "$tool \$*" >> "$TRIPWIRE_LOG"
exit 97
EOF
done
chmod +x "$FAKES/telepty" "$FAKES/curl" "$STUB_BIN/telepty" "$STUB_BIN/curl"

setup_case() { # <dir> <raw listing>
  mkdir -p "$1/home/.telepty" "$1/log" "$1/comms"
  printf "%s\n" "{\"authToken\":\"FAKE-TOKEN-974\"}" > "$1/home/.telepty/config.json"
  printf "%s\n" "$2" > "$1/list.json"
  : > "$1/log/curl.calls"; : > "$1/log/telepty.calls"; : > "$1/log/inject.targets"
}

# run_env <dir> <suffix> <cmd...> — the only way this guard runs product code. The env
# token is deliberately a DIFFERENT value: only the fake HOME config may be presented.
run_env() {
  local d="$1" s="$2"; shift 2
  env -i HOME="$d/home" PATH="$PATH" TMPDIR="$TMPD" TMP="$TMPD" TEMP="$TMPD" \
    TELEPTY_AUTH_TOKEN=FAKE-ENV-TOKEN-IGNORED TELEPTY_PORT=1 \
    TELEPTY="$FAKES/telepty" CURL="$FAKES/curl" \
    FAKE_LOG_DIR="$d/log" FAKE_LIST_FILE="$d/list.json" FAKE_LIST_RC="$LIST_RC" \
    FAKE_HTTP_CODE="$HTTP" FAKE_CURL_RC="$CURL_RC" \
    FAKE_ORCH=fake-orch FAKE_ORCH_INJECT_RC="$ORCH_RC" AIGENTRY_ORCHESTRATOR_SIDS=fake-orch \
    ASK_NOW="$NOW" SESSION_COMMS_DIR="$d/comms" \
    "$@" </dev/null >"$d/stdout$s" 2>"$d/stderr$s"
}

# The staged drive_listing.sh, inline: source the REAL lib and call one function, so
# the rc and stdout are exactly those of the function.
DRIVER='. "$1"; case "$2" in trusted) raw=$(cat "$FAKE_LIST_FILE"); telepty_listing_trusted "$raw" ;; sidlive) telepty_sid_live "$3" ;; *) exit 98 ;; esac'
listing() { # <dir> <trusted|sidlive> — prints the rc
  local rc=0
  run_env "$1" "" bash -c "$DRIVER" t163-driver "$LIB" "$2" fake-a || rc=$?
  printf "%s" "$rc"
}

count() { wc -l < "$1" | tr -d " "; }
bytes() { wc -c < "$1" | tr -d " "; }
# curl_hdr <dir> — na: no probe; yes: EVERY probe presented the fake HOME token (never
# the env one) to the pinned loopback port; NO otherwise.
curl_hdr() {
  local n m
  n=$(count "$1/log/curl.calls")
  if [ "$n" -eq 0 ]; then printf na; return 0; fi
  m=$(grep -cF "x-telepty-token: FAKE-TOKEN-974 http://127.0.0.1:1/api/sessions" "$1/log/curl.calls" || true)
  if [ "$m" -eq "$n" ]; then printf yes; else printf NO; fi
}
want_hdr() { if [ "$1" -eq 0 ]; then printf na; else printf yes; fi; }

# Every mismatch is collected, so one run names every case that moved.
FAILS=""; NFAIL=0
check() { # <id> <what> <got> <want>
  if [ "$3" != "$4" ]; then
    NFAIL=$((NFAIL + 1))
    FAILS="$FAILS
  $1 $2: got [$3] want [$4]"
  fi
}

# ── A: telepty_listing_trusted <raw> ─────────────────────────────────────────────────
# id|case|raw|http|curl rc|rc   (staged)   + |stdout|curl calls
CASES_TRUSTED='A01|ctrl empty-array http200|[]|200|0|0||1
A02|ctrl empty-array http401|[]|401|0|1|unauthorized|1
A03|ctrl empty-array http403|[]|403|0|1|unauthorized|1
A04|ctrl empty-array http000 curl-rc7|[]|000|7|1|unreachable|1
A05|ctrl empty-array http500|[]|500|0|1|broken|1
A06|ctrl nonempty-array|[{"id":"fake-x"}]|401|0|0||0
A07|nonarray {}|{}|401|0|1|broken|0
A08|nonarray error-object|{"error":"unauthorized"}|401|0|1|broken|0
A09|nonarray string|"unauthorized"|401|0|1|broken|0
A10|nonarray number|42|401|0|1|broken|0
A11|nonarray null|null|401|0|1|broken|0
A12|malformed json|{|401|0|1|broken|0
A13|empty stdout||401|0|1|broken|0'
n_a=0
while IFS="|" read -r id cs raw http crc exp eout ecurl; do
  [ -n "$id" ] || continue
  n_a=$((n_a + 1)); d="$RUN/$id"; setup_case "$d" "$raw"
  LIST_RC=0; HTTP="$http"; CURL_RC="$crc"; ORCH_RC=0
  check "$id" rc "$(listing "$d" trusted)" "$exp"
  check "$id" stdout "$(cat "$d/stdout")" "$eout"
  check "$id" curl-calls "$(count "$d/log/curl.calls")" "$ecurl"
  check "$id" token "$(curl_hdr "$d")" "$(want_hdr "$ecurl")"
  check "$id" list-calls "$(count "$d/log/telepty.calls")" 0
  check "$id" stderr-bytes "$(bytes "$d/stderr")" 0
done < <(printf "%s\n" "$CASES_TRUSTED")

# ── S: telepty_sid_live fake-a ───────────────────────────────────────────────────────
# id|case|raw|list rc|http|curl rc|rc   (staged; S14 corrected 0 -> 2)   + |curl calls
CASES_SIDLIVE='S01|ctrl empty-array http200|[]|0|200|0|1|1
S02|ctrl empty-array http401|[]|0|401|0|2|1
S03|ctrl empty-array http000 curl-rc7|[]|0|000|7|2|1
S04|ctrl present|[{"id":"fake-a"}]|0|401|0|0|0
S05|ctrl nonempty absent|[{"id":"fake-b"}]|0|401|0|1|0
S06|ctrl list exit1|[]|1|200|0|2|0
S07|nonarray {}|{}|0|401|0|2|0
S08|nonarray error-object|{"error":"unauthorized"}|0|401|0|2|0
S09|nonarray string|"unauthorized"|0|401|0|2|0
S10|nonarray number|42|0|401|0|2|0
S11|nonarray null|null|0|401|0|2|0
S12|nonarray false|false|0|401|0|2|0
S13|malformed json|{|0|401|0|2|0
S14|adjacent mixed-array present|[1,{"id":"fake-a"}]|0|401|0|2|0'
n_s=0
while IFS="|" read -r id cs raw lrc http crc exp ecurl; do
  [ -n "$id" ] || continue
  n_s=$((n_s + 1)); d="$RUN/$id"; setup_case "$d" "$raw"
  LIST_RC="$lrc"; HTTP="$http"; CURL_RC="$crc"; ORCH_RC=0
  check "$id" rc "$(listing "$d" sidlive)" "$exp"
  check "$id" stdout "$(cat "$d/stdout")" ""
  check "$id" curl-calls "$(count "$d/log/curl.calls")" "$ecurl"
  check "$id" token "$(curl_hdr "$d")" "$(want_hdr "$ecurl")"
  check "$id" list-argv "$(cat "$d/log/telepty.calls")" "list --json"
  check "$id" stderr-bytes "$(bytes "$d/stderr")" 0
done < <(printf "%s\n" "$CASES_SIDLIVE")

# ── X/V: the extra listing rows/documents, each through BOTH functions ───────────────
# HTTP is 200 on every bad case: a probe would say ok, so "not trusted + 0 curl calls"
# shows the body alone decided.
# id|case|raw|list rc|http|curl rc|t_rc|t_out|t_curl|s_rc|s_curl   (staged)
CASES_LISTING_EXTRA='X01|row null|[null]|0|200|0|1|broken|0|2|0
X02|row array|[[]]|0|200|0|1|broken|0|2|0
X03|row missing id|[{"name":"fake-a"}]|0|200|0|1|broken|0|2|0
X04|id bool|[{"id":true}]|0|200|0|1|broken|0|2|0
X05|id number|[{"id":7}]|0|200|0|1|broken|0|2|0
X06|id empty string|[{"id":""}]|0|200|0|1|broken|0|2|0
X07|id null|[{"id":null}]|0|200|0|1|broken|0|2|0
X08|id array|[{"id":["fake-a"]}]|0|200|0|1|broken|0|2|0
X09|present row then bad row (any short-circuit)|[{"id":"fake-a"},"x"]|0|200|0|1|broken|0|2|0
X10|bad row then present row|["x",{"id":"fake-a"}]|0|200|0|1|broken|0|2|0
X11|present row then numeric id|[{"id":"fake-a"},{"id":5}]|0|200|0|1|broken|0|2|0
X12|2 docs: invalid json then valid|{ [{"id":"fake-a"}]|0|200|0|1|broken|0|2|0
X13|2 docs: non-array then valid|{} [{"id":"fake-a"}]|0|200|0|1|broken|0|2|0
X14|2 docs: valid then invalid json|[{"id":"fake-a"}] {|0|200|0|1|broken|0|2|0
X15|2 docs: valid then non-array|[{"id":"fake-a"}] {}|0|200|0|1|broken|0|2|0
X16|2 docs: valid then valid|[{"id":"fake-a"}] [{"id":"fake-a"}]|0|200|0|1|broken|0|2|0
X17|2 docs: [] []|[] []|0|200|0|1|broken|0|2|0
X18|empty||0|200|0|1|broken|0|2|0
X19|whitespace only|   |0|200|0|1|broken|0|2|0
X20|truncated array|[{"id":"fake-a"}|0|200|0|1|broken|0|2|0
X21|bad literal|nul|0|200|0|1|broken|0|2|0
V01|valid extra-metadata present|[{"id":"fake-a","cwd":"/x","meta":{"k":[1,null]},"n":3}]|0|401|0|0||0|0|0
V02|valid extra-metadata absent|[{"id":"fake-b","x":null}]|0|401|0|0||0|1|0
V03|valid multi-row present|[{"id":"fake-b"},{"id":"fake-a","x":{}}]|0|401|0|0||0|0|0
V04|valid [] http200|[]|0|200|0|0||1|1|1
V05|valid [] http401|[]|0|401|0|1|unauthorized|1|2|1
V06|valid [] http000 rc7|[]|0|000|7|1|unreachable|1|2|1
V07|list exit1 valid present|[{"id":"fake-a"}]|1|200|0|0||0|2|0
V08|list exit1 valid []|[]|1|200|0|0||1|2|0
V09|valid padded whitespace|  [{"id":"fake-a"}]  |0|401|0|0||0|0|0'
n_x=0
while IFS="|" read -r id cs raw lrc http crc etr eto etcurl esr escurl; do
  [ -n "$id" ] || continue
  n_x=$((n_x + 1)); LIST_RC="$lrc"; HTTP="$http"; CURL_RC="$crc"; ORCH_RC=0
  dt="$RUN/$id-t"; setup_case "$dt" "$raw"; trc=$(listing "$dt" trusted)
  ds="$RUN/$id-s"; setup_case "$ds" "$raw"; src=$(listing "$ds" sidlive)
  check "$id" t_rc/t_out/t_curl/s_rc/s_curl \
    "$trc/$(cat "$dt/stdout")/$(count "$dt/log/curl.calls")/$src/$(count "$ds/log/curl.calls")" \
    "$etr/$eto/$etcurl/$esr/$escurl"
  check "$id" t-token "$(curl_hdr "$dt")" "$(want_hdr "$etcurl")"
  check "$id" s-token "$(curl_hdr "$ds")" "$(want_hdr "$escurl")"
  check "$id" t/s-list-calls "$(count "$dt/log/telepty.calls")/$(count "$ds/log/telepty.calls")" 0/1
  check "$id" s-stdout "$(cat "$ds/stdout")" ""
  check "$id" t/s-stderr-bytes "$(bytes "$dt/stderr")/$(bytes "$ds/stderr")" 0/0
done < <(printf "%s\n" "$CASES_LISTING_EXTRA")

# ── ask.sh: what was persisted, sent and claimed ─────────────────────────────────────
SF=fake-a__fake-b__fake-t.json
HOLD="inject --from fake-a --submit fake-orch HOLD: peer-comms guardrail | from: fake-a | to: fake-b | thread: fake-t | "
# One structured read of the comms dir: telemetry reasons in order, the state file as
# escalated/rounds/status, *.tmp.* leftovers, and telemetry lines that are not JSON or
# not stamped with the frozen clock and the fixture pair/thread.
SUMMARY_PY='
import glob, json, os, sys
comms, state_name, now = sys.argv[1:4]
reasons, bad = [], 0
tele = os.path.join(comms, "telemetry.jsonl")
if os.path.exists(tele):
    with open(tele, encoding="utf-8") as fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except ValueError:
                bad += 1
                continue
            reasons.append(str(ev.get("reason")))
            if (ev.get("ts"), ev.get("event"), ev.get("pairkey"), ev.get("thread")) != (
                    now, "peer_comms", "fake-a__fake-b", "fake-t"):
                bad += 1
path = os.path.join(comms, state_name)
state = "none"
if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as fh:
            st = json.load(fh)
        state = "%s/%s/%s" % (json.dumps(st.get("escalated")), st.get("rounds"), st.get("status"))
    except ValueError:
        state = "BADJSON"
left = len(glob.glob(os.path.join(comms, "*.tmp.*")))
print("%s|%s|%d|%d" % (",".join(reasons), state, left, bad))
'
# Words that would read as an acknowledgement or receipt; ask.sh may claim neither.
ack_words() {
  cat "$1"/stdout* "$1"/stderr* | { grep -Eiwc "ack|acked|acknowledged|acknowledgement|acknowledgment|received|receipt" || true; }
}

# outcome <id> <dir> <last stderr> <got exits> <exits> <reasons> <orch injects>
#         <peer injects> <claim> <NOT-escalated line> <state> <curl calls>
outcome() {
  local id="$1" d="$2" last="$3" reasons="" st="" tl="" bad="" claim nel wstale=0 wund=0
  IFS="|" read -r reasons st tl bad < <(python3 -c "$SUMMARY_PY" "$d/comms" "$SF" "$NOW") || true
  if grep -q "refused + escalated" "$last"; then claim=yes; else claim=no; fi
  if grep -q "refused; NOT escalated" "$last"; then nel=yes; else nel=no; fi
  case "$6" in
    *peer_escalation_stale) wstale=1 ;;
    *peer_escalation_undelivered) wund=1 ;;
  esac
  check "$id" exits "$4" "$5"
  check "$id" reasons "$reasons" "$6"
  check "$id" orch-injects "$(grep -cx fake-orch "$d/log/inject.targets" || true)" "$7"
  check "$id" peer-injects "$(grep -cx fake-b "$d/log/inject.targets" || true)" "$8"
  check "$id" escalated-claim "$claim" "$9"
  check "$id" not-escalated-line "$nel" "${10}"
  check "$id" state "$st" "${11}"
  check "$id" tmp-left "$tl" 0
  check "$id" telemetry-shape "$bad" 0
  check "$id" curl-calls "$(count "$d/log/curl.calls")" "${12}"
  check "$id" token "$(curl_hdr "$d")" "$(want_hdr "${12}")"
  check "$id" hold-argv "$(grep -cF -- "$HOLD" "$d/log/telepty.calls" || true)" "$7"
  check "$id" stale-line "$(grep -c "recorded stale" "$last" || true)" "$wstale"
  check "$id" undelivered-line "$(grep -c "ESCALATION UNDELIVERED" "$last" || true)" "$wund"
  check "$id" ack-words "$(ack_words "$d")" 0
}

# ── B/C: one conflict reply, or three requests then the 4th (cap 3) ──────────────────
# id|case|raw|http|curl rc|orch inject rc|mode|exit|reasons|orch|claim   (staged)
#   + |peer injects|curl calls
CASES_ASK='B01|ctrl both-live sent|[{"id":"fake-a"},{"id":"fake-b"}]|200|0|0|conflict|8|peer_escalated_deliberation|1|yes|0|0
B02|stale fake-b absent|[{"id":"fake-a"}]|200|0|0|conflict|8|peer_escalation_stale|0|no|0|0
B03|undelivered orch-inject rc1|[{"id":"fake-a"},{"id":"fake-b"}]|200|0|1|conflict|8|peer_escalation_undelivered|1|no|0|0
B04|ctrl empty-array http401 unknown|[]|401|0|0|conflict|8|peer_escalated_deliberation|1|yes|0|2
B05|unitA nonarray {} http200|{}|200|0|0|conflict|8|peer_escalated_deliberation|1|yes|0|0
B06|unitA nonarray null|null|200|0|0|conflict|8|peer_escalated_deliberation|1|yes|0|0
C01|ctrl cap both-live sent|[{"id":"fake-a"},{"id":"fake-b"}]|200|0|0|cap|7|peer_ask_request_sent,peer_ask_request_sent,peer_ask_request_sent,peer_cap_tripped,peer_escalated_orchestrator|1|yes|3|0
C02|cap stale fake-b absent|[{"id":"fake-a"}]|200|0|0|cap|7|peer_ask_request_sent,peer_ask_request_sent,peer_ask_request_sent,peer_cap_tripped,peer_escalation_stale|0|no|3|0
C03|cap undelivered orch-inject rc1|[{"id":"fake-a"},{"id":"fake-b"}]|200|0|1|cap|7|peer_ask_request_sent,peer_ask_request_sent,peer_ask_request_sent,peer_cap_tripped,peer_escalation_undelivered|1|no|3|0'
n_b=0
while IFS="|" read -r id cs raw http crc orc mode eexit ereasons eorch eclaim epeer ecurl; do
  [ -n "$id" ] || continue
  n_b=$((n_b + 1)); d="$RUN/$id"; setup_case "$d" "$raw"
  LIST_RC=0; HTTP="$http"; CURL_RC="$crc"; ORCH_RC="$orc"
  rc=0
  if [ "$mode" = cap ]; then
    pre=""
    for i in 1 2 3; do
      rc=0
      run_env "$d" ".$i" bash "$ASK" --from fake-a --to fake-b --thread fake-t request "fake-q$i" || rc=$?
      pre="$pre$rc"
    done
    check "$id" "rounds 1-3 exits" "$pre" 000
    rc=0
    run_env "$d" "" bash "$ASK" --from fake-a --to fake-b --thread fake-t request fake-q4 || rc=$?
    est="true/3/open"
  else
    run_env "$d" "" bash "$ASK" --from fake-a --to fake-b --thread fake-t --conflict reply fake-x || rc=$?
    est="true/0/open"
  fi
  if [ "$eclaim" = yes ]; then enel=no; else enel=yes; fi
  outcome "$id" "$d" "$d/stderr" "$rc" "$eexit" "$ereasons" "$eorch" "$epeer" "$eclaim" "$enel" "$est" "$ecurl"
done < <(printf "%s\n" "$CASES_ASK")

# ── E: compound (#974 x #836), re-entry once state exists, close, lane ──────────────
L_BOTH='[{"id":"fake-a"},{"id":"fake-b"}]'; L_A='[{"id":"fake-a"}]'
S3="peer_ask_request_sent,peer_ask_request_sent,peer_ask_request_sent"
n_e=0
begin() { n_e=$((n_e + 1)); d="$RUN/$1"; setup_case "$d" "[]"; LIST_RC=0; HTTP=200; CURL_RC=0; n=0; exits=""; TO=fake-b; }
step() { # <listing> <orch inject rc> <ask.sh action args...> — listing rewritten per run
  local rc=0
  printf "%s\n" "$1" > "$d/list.json"; ORCH_RC="$2"; shift 2; n=$((n + 1))
  run_env "$d" ".$n" bash "$ASK" --from fake-a --to "$TO" --thread fake-t "$@" || rc=$?
  exits="$exits${exits:+,}$rc"; last="$d/stderr.$n"
}
finish() { # <id> <case> <exits> <reasons> <orch> <peer> <claim> <NOT-escalated> <state>
  outcome "$1" "$d" "$last" "$exits" "$3" "$4" "$5" "$6" "$7" "$8" "$9" 0
}
begin E01; step "[null]" 0 --conflict reply x
finish E01 "compound bad-row listing (UNKNOWN), conflict, inject ok" 8 peer_escalated_deliberation 1 0 yes no "true/0/open"
begin E02; step "[null]" 1 --conflict reply x
finish E02 "compound bad-row listing (UNKNOWN), conflict, inject rc1" 8 peer_escalation_undelivered 1 0 no yes "true/0/open"
begin E03; step "$L_BOTH {}" 0 --conflict reply x
finish E03 "compound 2-doc listing (UNKNOWN), conflict" 8 peer_escalated_deliberation 1 0 yes no "true/0/open"
begin E04; step "$L_A" 0 --conflict reply x; step "$L_A" 0 --conflict reply x; step "$L_BOTH" 0 --conflict reply x
finish E04 "re-entry conflict: stale, stale, then both live" "8,8,8" \
  "peer_escalation_stale,peer_escalation_stale,peer_escalated_deliberation" 1 0 yes no "true/0/open"
begin E05; step "$L_BOTH" 0 request q1; step "$L_BOTH" 0 request q2; step "$L_BOTH" 0 request q3
step "$L_A" 0 request q4; step "$L_A" 0 request q5; step "$L_BOTH" 0 request q6
finish E05 "re-entry cap: 3 sent, stale, stale, then both live" "0,0,0,7,7,7" \
  "$S3,peer_cap_tripped,peer_escalation_stale,peer_cap_tripped,peer_escalation_stale,peer_cap_tripped,peer_escalated_orchestrator" 1 3 yes no "true/3/open"
begin E06; step "$L_BOTH" 0 request q1; step "$L_BOTH" 0 request q2; step "$L_BOTH" 0 request q3; step "{}" 1 request q4
finish E06 "compound cap: non-array listing (UNKNOWN) + inject rc1" "0,0,0,7" "$S3,peer_cap_tripped,peer_escalation_undelivered" 1 3 no yes "true/3/open"
begin E07; step "$L_A" 0 --conflict reply x; step "$L_A" 0 close
finish E07 "close after stale conflict resets the flag" "8,0" "peer_escalation_stale,peer_thread_closed" 0 0 no no "false/0/closed"
begin E08; TO=fake-orch; step "$L_BOTH" 0 --conflict reply x
finish E08 "lane check: --to orchestrator refused before state" 4 "" 0 0 no no none
check E08 telepty-calls "$(count "$d/log/telepty.calls")" 0

check all "case counts trusted/sid_live/ask/listing-extra/ask-extra" "$n_a/$n_s/$n_b/$n_x/$n_e" 13/14/9/30/8
check all tripwire-bytes "$(bytes "$TRIPWIRE_LOG")" 0
if [ "$NFAIL" -ne 0 ]; then
  printf "FAIL[T163]: %s mismatch(es):%s\n" "$NFAIL" "$FAILS" >&2
  exit 1
fi
echo "T163 PASS cases=$((n_a + n_s + n_b + n_x + n_e)) (trusted $n_a, sid_live $n_s, ask $n_b, listing-extra $n_x, ask-extra $n_e)"
