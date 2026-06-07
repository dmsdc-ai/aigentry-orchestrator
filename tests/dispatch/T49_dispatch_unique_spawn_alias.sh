#!/usr/bin/env bash
# T49 - #548a: dispatch spawn aliases must stay unique per sid, not bare track.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

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
exit 0
SH
chmod +x "$FAKE_OPEN_SESSION"

printf '%s' '[{"id":"t49-one","command":"codex"},{"id":"t49-two","command":"codex"}]' > "$STUB_LIST_FILE"

for name in one two; do
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
      >/dev/null
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

echo "T49 PASS"
