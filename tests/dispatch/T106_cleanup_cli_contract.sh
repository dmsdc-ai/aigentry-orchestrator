#!/usr/bin/env bash
# T106 (#899 tranche 2a) — the session-cleanup contract lines NO guard pinned.
#
# session-cleanup.sh had 13 guards touching it, and between them they pinned the
# destructive machinery well: the surface close (T27/T32), the worker refusal
# (T34), the lifecycle mark (T41/T93), the credential (T86/T87), the
# refusal-is-not-absence rule (T89) and the self/ancestor kill guard (T52). What
# none of them measured is the CLI itself — argument handling, the dependency gate,
# the usage text, `--force`, `--keep`, and the two exit-3 arms that predate #835.
#
# Every one of those is a line a port can drop silently: the script still cleans
# sessions, and the only visible change is an operator's flag being ignored or a
# contaminated `telepty list` being believed. This guard is the characterization
# test that makes the port's parity with the shell measurable rather than reviewed.
# Each block names the shell line it pins.
#
# Hermetic throughout: stubbed telepty/curl/ps/kill on PATH or through the #606
# seams, throwaway sids, and ORCHESTRATOR_SID pointed at a fixture sid so even the
# `--force` path never names the real control tower. NO real process is signalled
# and no daemon is contacted.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
CLEANUP="$REPO_ROOT/bin/session-cleanup.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T106]: $*" >&2; exit 1; }

CURL_LOG="$T_TMP/curl.log"; export CURL_LOG
ACTIONS_LOG="$T_TMP/actions.log"; export ACTIONS_LOG

# curl stub: the #835 corroboration probe answers 200 (a genuinely empty daemon),
# the registry DELETE answers 404 (already gone).
cat > "$STUB_BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf 'ARGV %s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *DELETE*) echo 404;;
  *)        echo 200;;
esac
EOF
chmod +x "$STUB_BIN/curl"

# Surface-close seam (T32/T86/T89 convention: the lib's re-source guard lets an
# exported function survive) — record, never contact a workspace host.
wh_close_for_sid() { printf 'SURFACE_CLOSE_BY_SID %s\n' "$1" >> "$ACTIONS_LOG"; return 0; }
wh_close()         { printf 'SURFACE_CLOSE %s\n' "$1" >> "$ACTIONS_LOG"; return 0; }
wh_lookup()        { printf ''; }
export -f wh_close_for_sid wh_close wh_lookup
export WORKSPACE_HOST_SH_LOADED=1
# No dispatch-registry side effects in this test.
export DISPATCH_REGISTRY_PY="$T_TMP/no-such-registry.py"
export HOME="$T_TMP/home"

# run <args…> → "<rc>\n<combined output>"; resets both logs first.
run() {
  : > "$CURL_LOG"; : > "$ACTIONS_LOG"
  local out rc=0
  set +e
  out=$("$BASH_BIN" "$CLEANUP" "$@" 2>&1)
  rc=$?
  set -e
  printf '%s\n%s' "$rc" "$out"
}
rc_of()  { printf '%s' "$1" | head -1; }
out_of() { printf '%s' "$1" | tail -n +2; }

# ── (1) usage: the printed range is lines 2-20, NOT the whole header ────────
# `sed -n '2,20p' "$0"` deliberately stopped before the `Usage:` block at line 21.
# A port that pasted the whole header in would quietly change what --help means.
res=$(run --help); rc=$(rc_of "$res"); out=$(out_of "$res")
[ "$rc" = "0" ] || fail "--help exited $rc, want 0"
case "$out" in
  *"Actually remove orchestrator-spawned sessions"*) ;;
  *) fail "--help lost the description header: $out";;
esac
case "$out" in
  *"session-cleanup.sh <sid> [--force]"*)
    fail "--help printed the Usage: block — the shell printed lines 2-20 and stopped before it: $out";;
esac
res=$(run -h); [ "$(rc_of "$res")" = "0" ] || fail "-h exited $(rc_of "$res"), want 0"

# ── (2) no arguments: the same text, on stdout, exit 1 ─────────────────────
# `[ $# -eq 0 ] && usage 1` — the usage text goes to STDOUT even in the error case.
: > "$CURL_LOG"
set +e
noargs_stdout=$("$BASH_BIN" "$CLEANUP" 2>/dev/null)
rc=$?
set -e
[ "$rc" = "1" ] || fail "no-args exited $rc, want 1"
case "$noargs_stdout" in
  *"Actually remove orchestrator-spawned sessions"*) ;;
  *) fail "no-args did not print the usage text to stdout: $noargs_stdout";;
esac

# ── (3) argument errors: each is exit 1 with its own named reason ──────────
check_usage_error() {
  local want="$1"; shift
  local res rc out
  res=$(run "$@"); rc=$(rc_of "$res"); out=$(out_of "$res")
  [ "$rc" = "1" ] || fail "[$*] exited $rc, want 1"
  case "$out" in
    *"$want"*) ;;
    *) fail "[$*] did not name '$want': $out";;
  esac
  [ ! -s "$ACTIONS_LOG" ] || fail "[$*] destroyed something while rejecting the arguments"
}
check_usage_error "unknown flag: --nope"                          --nope
check_usage_error "--keep requires <sid>"                         --all-unused --keep
check_usage_error "--all-disconnected does not take a sid"        --all-disconnected some-sid
check_usage_error "--all-unused does not take a sid"              --all-unused some-sid
check_usage_error "unexpected positional arg: second"             first second
check_usage_error "<sid> required"                                --force

# ── (4) the dependency gate is exit 2, and names the missing tool ──────────
# `require_deps` is the reason this script does NOT harden PATH (#400): the
# inherited PATH is the contract, and a missing tool has to be loud.
# A PATH built from nothing, so "absent" means absent rather than "absent from the
# directories this host happens to lay out that way". `dirname` and `node` are what
# the exec shim itself needs; each dependency is then added or withheld by name.
MINBIN="$T_TMP/minbin"; mkdir -p "$MINBIN"
ln -sf "$(command -v node)" "$MINBIN/node"
ln -sf "$(command -v dirname)" "$MINBIN/dirname"
ln -sf "$(command -v jq)" "$MINBIN/jq"
NOJQ="$T_TMP/minbin-nojq"; mkdir -p "$NOJQ"
ln -sf "$(command -v node)" "$NOJQ/node"
ln -sf "$(command -v dirname)" "$NOJQ/dirname"
ln -sf "$STUB_BIN/telepty" "$NOJQ/telepty"

missing_dep() {
  local want="$1" path="$2" out rc
  set +e
  out=$(env -i PATH="$path" HOME="$T_TMP/home" "$BASH_BIN" "$CLEANUP" some-sid 2>&1)
  rc=$?
  set -e
  [ "$rc" = "2" ] || fail "a missing $want exited $rc, want 2: $out"
  case "$out" in
    *"$want not found in PATH"*) ;;
    *) fail "a missing $want was not named: $out";;
  esac
}
missing_dep telepty "$MINBIN"   # jq present, telepty withheld
missing_dep jq      "$NOJQ"     # telepty present, jq withheld

# ── (5) an unusable listing is exit 3, and says which way it was unusable ──
# These two arms predate #835 and guard task #400: a contaminated stdout must never
# be read as "no such session", because that reading authorizes a teardown.
TELEPTY_BROKEN="$T_TMP/telepty-broken"; mkdir -p "$TELEPTY_BROKEN"
cat > "$TELEPTY_BROKEN/telepty" <<'EOF'
#!/usr/bin/env bash
case "${TELEPTY_FAULT:-}" in
  nonzero) echo "boom" >&2; exit 7;;
  *)       echo "Daemon version mismatch: CLI 0.4.0 vs daemon 0.3.5";;
esac
EOF
chmod +x "$TELEPTY_BROKEN/telepty"

set +e
out=$(PATH="$TELEPTY_BROKEN:$PATH" "$BASH_BIN" "$CLEANUP" some-sid 2>&1); rc=$?
set -e
[ "$rc" = "3" ] || fail "a non-JSON listing exited $rc, want 3: $out"
case "$out" in *"returned non-JSON output"*) ;; *) fail "the non-JSON arm lost its message: $out";; esac
# The #400 diagnostic is the point of that arm: it tells the operator WHICH binary
# answered, which is the whole root cause it was written for.
case "$out" in *"which telepty:"*) ;; *) fail "the non-JSON arm dropped the 'which telepty' diagnostic: $out";; esac
case "$out" in *"PATH="*) ;; *) fail "the non-JSON arm dropped the PATH diagnostic: $out";; esac
case "$out" in *"Daemon version mismatch"*) ;; *) fail "the non-JSON arm no longer echoes the contaminating bytes: $out";; esac

set +e
out=$(TELEPTY_FAULT=nonzero PATH="$TELEPTY_BROKEN:$PATH" "$BASH_BIN" "$CLEANUP" some-sid 2>&1); rc=$?
set -e
[ "$rc" = "3" ] || fail "a non-zero 'telepty list' exited $rc, want 3: $out"
case "$out" in *"exited non-zero"*) ;; *) fail "the non-zero-exit arm lost its message: $out";; esac

# ── (6) --force is the Rule 28 escape hatch, and it works ─────────────────
# T41/T89 pin the REFUSAL; nothing pinned that the documented override still
# opens the door. ORCHESTRATOR_SID moves the protected name onto a fixture sid, so
# this never names the live control tower.
PROT="t106-protected"
printf '%s' '[]' > "$STUB_LIST_FILE"
res=$(ORCHESTRATOR_SID="$PROT" run "$PROT")
[ "$(rc_of "$res")" = "1" ] || fail "the protected sid was not refused without --force"
res=$(ORCHESTRATOR_SID="$PROT" run "$PROT" --force)
rc=$(rc_of "$res"); out=$(out_of "$res")
[ "$rc" = "0" ] || fail "--force did not override the protected-session guard (rc=$rc): $out"
grep -qx "SURFACE_CLOSE_BY_SID $PROT" "$ACTIONS_LOG" \
  || fail "--force exited 0 without actually cleaning: $(cat "$ACTIONS_LOG")"

# ── (7) batch selection: --all-disconnected and --all-unused --keep ───────
printf '%s' '[
  {"id":"t106-a","healthStatus":"DISCONNECTED"},
  {"id":"t106-b","healthStatus":"CONNECTED"},
  {"id":"t106-keep","healthStatus":"DISCONNECTED"},
  {"id":"orchestrator","healthStatus":"DISCONNECTED"}
]' > "$STUB_LIST_FILE"

# These sids are all PRESENT in the listing, so each takes the normal
# kill+close+DELETE path — the registry DELETE is the per-sid record of what the
# selection actually reached.
deleted() { grep -qE "ARGV .*-X DELETE .*/api/sessions/$1\$" "$CURL_LOG"; }

res=$(run --all-disconnected); rc=$(rc_of "$res"); out=$(out_of "$res")
[ "$rc" = "0" ] || fail "--all-disconnected exited $rc: $out"
case "$out" in *"cleaned: 2 disconnected sessions"*) ;; *) fail "--all-disconnected miscounted: $out";; esac
deleted t106-a || fail "--all-disconnected skipped a DISCONNECTED session"
deleted t106-b && fail "--all-disconnected cleaned a CONNECTED session"
deleted orchestrator && fail "--all-disconnected cleaned the protected session"

res=$(run --all-unused --keep t106-keep); rc=$(rc_of "$res"); out=$(out_of "$res")
[ "$rc" = "0" ] || fail "--all-unused exited $rc: $out"
case "$out" in *"cleaned: 2 unused sessions"*) ;; *) fail "--all-unused miscounted: $out";; esac
deleted t106-keep && fail "--all-unused cleaned a --keep'd session"
deleted orchestrator && fail "--all-unused cleaned the protected session"
deleted t106-a || fail "--all-unused skipped a session it should have cleaned"
deleted t106-b || fail "--all-unused skipped a CONNECTED session (unused means every non-kept one)"

# Multiple --keep accumulate (the documented "multiple --keep allowed" line).
res=$(run --all-unused --keep t106-keep --keep t106-a --keep t106-b)
case "$(out_of "$res")" in *"cleaned: 0 unused sessions"*) ;; *) fail "repeated --keep did not accumulate: $(out_of "$res")";; esac

# MEASURED jq BEHAVIOUR, recorded so a change to it has to be deliberate: the
# shell's keep test was `[.id] | inside($keep)`, i.e. `$keep | contains([.id])`,
# and jq's `contains` on strings is SUBSTRING containment, not equality —
# `["foo"] | inside(["foobar"])` is true. So a keep entry that merely CONTAINS a
# sid protects it. This is not a design anyone chose; it is what the tool this
# port replaces did, and erring toward NOT killing is the safe direction for a
# cleanup. Tighten it deliberately or not at all.
res=$(run --all-unused --keep t106-keep-suffix)
case "$(out_of "$res")" in
  *"cleaned: 2 unused sessions"*) ;;
  *) fail "the keep-list match changed shape — jq's substring 'inside' protected t106-keep: $(out_of "$res")";;
esac

# ── (8) the normal (session-present) path SIGTERMs the parent and cleans up ─
# T52 pins the self/ancestor REFUSAL through the seams; nothing pinned the
# end-to-end run where the kill is supposed to fire.
KILL_LOG="$T_TMP/kill.log"; : > "$KILL_LOG"
cat > "$STUB_BIN/kill-recorder.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
exit 0
EOF
PS_SNAP="$T_TMP/ps.txt"
cat > "$STUB_BIN/ps-recorder.sh" <<EOF
#!/usr/bin/env bash
cat "$PS_SNAP"
EOF
chmod +x "$STUB_BIN/kill-recorder.sh" "$STUB_BIN/ps-recorder.sh"
cat > "$PS_SNAP" <<'EOF'
100 1 /sbin/launchd
400 100 bash session-cleanup.sh
777 100 telepty allow --id t106-live claude --continue
EOF
printf '%s' '[{"id":"t106-live","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
: > "$CURL_LOG"; : > "$ACTIONS_LOG"
CLEANUP_PS_CMD="$STUB_BIN/ps-recorder.sh" KILL_CMD="$STUB_BIN/kill-recorder.sh" \
  CLEANUP_SELF_PID=400 "$BASH_BIN" "$CLEANUP" t106-live >/dev/null 2>&1 \
  || fail "the normal present-session path exited non-zero"
grep -qx -- "-TERM 777" "$KILL_LOG" \
  || fail "the parent telepty-allow process was not SIGTERMed on the normal path: $(cat "$KILL_LOG")"
grep -q "ARGV .*-X DELETE .*/api/sessions/t106-live" "$CURL_LOG" \
  || fail "the registry DELETE did not run on the normal path: $(cat "$CURL_LOG")"

echo "T106 PASS"
