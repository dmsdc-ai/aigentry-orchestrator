#!/usr/bin/env bash
# T49 - #548a: dispatch spawn aliases must stay unique per sid, not bare track.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
t_confined_setup

OPEN_LOG="$T_TMP/open-session.log"
PROBE="$T_TMP/session-probe"
cat > "$PROBE" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '{"ready":true}'
SH
chmod +x "$PROBE"

FAKE_OPEN_SESSION="$T_TMP/fake-open-session.sh"
cat > "$FAKE_OPEN_SESSION" <<SH
#!/usr/bin/env bash
set -euo pipefail
track=""; name=""; cwd=""; cli=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --track) track="\$2"; shift 2;;
    --name) name="\$2"; shift 2;;
    --cwd) cwd="\$2"; shift 2;;
    --cli) cli="\$2"; shift 2;;
    --extra-flags) shift 2;;
    *) shift;;
  esac
done
[ -n "\$track" ] && [ -n "\$name" ] || { echo "fake-open-session: missing track/name" >&2; exit 2; }
printf 'track=%s name=%s alias=%s-%s cwd=%s cli=%s\n' "\$track" "\$name" "\$track" "\$name" "\$cwd" "\$cli" >> "$OPEN_LOG"
"\$T_FIXTURE_NODE" "\$T_FIXTURE_HELPER" receipt "\$track-\$name"
exit 0
SH
chmod +x "$FAKE_OPEN_SESSION"

printf '%s' '[{"id":"t49-one","command":"codex"},{"id":"t49-two","command":"codex"}]' > "$STUB_LIST_FILE"

for name in one two; do
  t_confined_scope "t49-$name" 49 "$T_TMP/cwd-$name"
  ref="$T_TMP/ref-$name.md"
  printf 'T49 %s dispatch ref\n' "$name" > "$ref"
  HOME="$T_TMP/home" \
  AIGENTRY_SESSIONS_ROOT="$T_TMP/sessions" \
  OPEN_SESSION_SH="$FAKE_OPEN_SESSION" \
  SESSION_PROBE_PY="$PROBE" \
  TELEPTY="$STUB_BIN/telepty" \
    "$REPO_ROOT/bin/dispatch.sh" --spawn-and-dispatch \
      --track t49 --name "$name" --cwd "$T_TMP/cwd-$name" --cli codex \
      --from t49-test --ref "$ref" --timeout-ms 800 --no-verify-started \
      --task 49 --role coder \
      >/dev/null 2>"$T_TMP/dispatch-$name.err" \
    || { rc=$?; cat "$T_TMP/dispatch-$name.err" >&2; exit "$rc"; }
done

python3 - "$OPEN_LOG" <<'PY'
import sys

records = []
for line in open(sys.argv[1], encoding="utf-8"):
    row = {}
    for part in line.strip().split():
        key, value = part.split("=", 1)
        row[key] = value
    records.append(row)

aliases = [r.get("alias") for r in records]
assert aliases == ["t49-one", "t49-two"], f"FAIL: aliases={aliases!r}"
assert len(set(aliases)) == 2, f"FAIL: aliases not unique: {aliases!r}"
assert "t49" not in aliases, f"FAIL: bare track used as alias: {aliases!r}"
PY

# ── #1162 G2c: the confined cmux stub answers ONLY `cmux capabilities` ─────────────
# The fixture's own forbidden.log is the teardown tripwire; nothing below may write to
# or truncate it. Expected denials are recorded in a SEPARATE log and inspected exactly.
cmux_stub="$STUB_BIN/cmux"
main_log="$T_TMP/forbidden.log"
main_before=$({ cat "$main_log" 2>/dev/null || true; } | cksum)
caps_json='{"protocol":"cmux-socket","version":2,"methods":[]}'

# (1) positive, end-to-end: each spawn's agent-meta-set read capabilities and stopped at
#     unsupported (20) — not a transport failure (30), and never an applied mutation.
for name in one two; do
  err="$T_TMP/dispatch-$name.err"
  grep -qxF 'agent-meta: set rc=20 reason=capability-missing' "$err" \
    || { echo "FAIL: t49-$name agent-meta-set did not end unsupported via capabilities" >&2; cat "$err" >&2; exit 1; }
  grep -qF "agent-meta-set rc=20 for t49-$name (spawn not gated)" "$err" \
    || { echo "FAIL: t49-$name dispatch did not log the unsupported agent-meta-set" >&2; cat "$err" >&2; exit 1; }
  if grep -q 'set=applied' "$err"; then echo "FAIL: t49-$name metadata mutation reported applied" >&2; exit 1; fi
done

# (2) positive, exact read: the one permitted argv returns the synthetic reply verbatim.
out=$(T_TMP="$T_TMP" "$cmux_stub" capabilities) || { echo "FAIL: cmux capabilities rc=$?" >&2; exit 1; }
[ "$out" = "$caps_json" ] || { echo "FAIL: cmux capabilities reply: $out" >&2; exit 1; }

# (3) adapter controls: caps/set/clear through wh-cli all end unsupported (20) without
#     any other cmux argv (which would land in the main tripwire log).
status='{"connection":"unknown","activity":"unknown","activity_source":"unknown","dispatch":"none","read_at":0}'
stage="$T_TMP/sessions/t49-one"
adapter_control() {
  local label="$1" want_line="$2"; shift 2
  local rc=0
  AIGENTRY_WORKSPACE_HOST=cmux "$REPO_ROOT/bin/wh-cli.sh" "$@" \
    >"$T_TMP/ctl-$label.out" 2>"$T_TMP/ctl-$label.err" || rc=$?
  [ "$rc" -eq 20 ] || { echo "FAIL: wh-cli $label rc=$rc want 20" >&2; cat "$T_TMP/ctl-$label.err" >&2; exit 1; }
  grep -qxF "$want_line" "$T_TMP/ctl-$label.err" \
    || { echo "FAIL: wh-cli $label diagnostic" >&2; cat "$T_TMP/ctl-$label.err" >&2; exit 1; }
  [ ! -s "$T_TMP/ctl-$label.out" ] || { echo "FAIL: wh-cli $label printed a result" >&2; cat "$T_TMP/ctl-$label.out" >&2; exit 1; }
}
adapter_control caps  'agent-meta: caps rc=20 reason=capability-missing'  agent-meta-caps
adapter_control set   'agent-meta: set rc=20 reason=capability-missing'   agent-meta-set t49-one --stage "$stage" --status-json "$status"
adapter_control clear 'agent-meta: clear rc=20 reason=capability-missing' agent-meta-clear t49-one --stage "$stage"

# (4) negative argv: zero, extra, rpc set/clear and any other verb are each refused
#     (99, no stdout) and recorded — into the separate control log, inspected exactly.
neg="$T_TMP/neg-controls"; mkdir -p "$neg"; : > "$neg/expected.log"
deny_control() {
  local rc=0 out
  out=$(T_TMP="$neg" "$cmux_stub" "$@") || rc=$?
  [ "$rc" -eq 99 ] || { echo "FAIL: cmux argv [$*] rc=$rc want 99 (denied)" >&2; exit 1; }
  [ -z "$out" ] || { echo "FAIL: cmux argv [$*] produced stdout: $out" >&2; exit 1; }
  printf 'forbidden: %s\n' "$cmux_stub $*" >> "$neg/expected.log"
}
deny_control
deny_control capabilities --json
deny_control capabilities capabilities
deny_control --json capabilities
deny_control rpc surface.agent_metadata.set '{}'
deny_control rpc surface.agent_metadata.clear '{}'
deny_control rpc system.capabilities '{}'
deny_control set-status aigentry working --workspace workspace:1
cmp -s "$neg/expected.log" "$neg/forbidden.log" \
  || { echo "FAIL: denied-argv records differ" >&2; diff "$neg/expected.log" "$neg/forbidden.log" >&2; exit 1; }

# The main tripwire log was neither written nor cleared by any control above.
[ "$({ cat "$main_log" 2>/dev/null || true; } | cksum)" = "$main_before" ] \
  || { echo "FAIL: controls changed the main forbidden.log" >&2; cat "$main_log" >&2; exit 1; }

echo "T49 PASS"
