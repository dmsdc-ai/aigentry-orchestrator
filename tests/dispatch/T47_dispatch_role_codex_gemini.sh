#!/usr/bin/env bash
# T47 — #532: dispatch.sh routes `--cli codex|gemini --role <r>` through the
#        boot-prepare additive path (not the legacy spawn), and parameterizes the
#        worker-launcher display_cli so `exec -a <cli>` is correct.
#
# Discriminator: on the BOOT path, open-session is called with --cwd = the
# role-sandbox dir (role-cwd decoupling); on the legacy path it would be the
# original project cwd. Pre-fix, the claude-only gate rejected codex/gemini and
# fell back to legacy (original cwd) → this test fails. Post-fix → sandbox cwd.
#
# Hermetic-ish: fake open-session + fake telepty, temp HOME/AIGENTRY_HOME with a
# minimal instructions tree, and a FAKE config-home via CODEX_HOME/GEMINI_CLI_HOME
# so no live ~/.codex / ~/.gemini is touched. Runs the REAL boot-prepare, which
# version-gates the actual CLI — skipped when the CLI binary or dist/ is absent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

for cmd in node python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "T47 SKIP — '$cmd' not in PATH"; exit 0; }
done
if [ ! -f "$REPO_ROOT/dist/src/session/boot-adapter/index.js" ]; then
  echo "T47 SKIP — dist/ not built (run 'npm run build')"; exit 0
fi

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

# Minimal instructions tree so boot-prepare's resolveInstructions has layers.
AIG_HOME="$TMP_ROOT/aig"
mkdir -p "$AIG_HOME/instructions/roles" "$AIG_HOME/instructions/projects"
printf '# COMMON\nMARKER-COMMON-T47\n' > "$AIG_HOME/instructions/common.md"
printf '# Role: coder\nMARKER-CODER-T47\n' > "$AIG_HOME/instructions/roles/coder.md"

PROJECT_CWD="$TMP_ROOT/project"
mkdir -p "$PROJECT_CWD"

FAKE_BIN="$TMP_ROOT/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/telepty" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  list) echo '[{"id":"t47-probe","command":"codex"}]' ;;
  read-screen) echo '›' ;;
  inject) exit 0 ;;
  *) exit 0 ;;
esac
SH
chmod 0755 "$FAKE_BIN/telepty"

OPEN_ARGS_FILE="$TMP_ROOT/open-args.txt"
FAKE_OPEN_SESSION="$TMP_ROOT/fake-open-session.sh"
cat > "$FAKE_OPEN_SESSION" <<SH
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$@" > "$OPEN_ARGS_FILE"
exit 0
SH
chmod 0755 "$FAKE_OPEN_SESSION"

run_one() {
  local cli="$1" home_env="$2" want_shadow="$3"
  : > "$OPEN_ARGS_FILE"
  # Fake real config-home with auth + a global doc to neutralize.
  local fake_real="$TMP_ROOT/real-$cli"
  mkdir -p "$fake_real"
  printf '{"t":1}\n' > "$fake_real/authish"

  local ref_file="$TMP_ROOT/ref-$cli.md"
  printf 'T47 %s dispatch ref\n' "$cli" > "$ref_file"

  # The config-home env name is dynamic per CLI; `env NAME=val` so it is applied
  # as an assignment (a `"$var"=val` prefix would be parsed as a command arg).
  HOME="$TMP_ROOT/home" \
  AIGENTRY_HOME="$AIG_HOME" \
  AIGENTRY_SESSIONS_ROOT="$TMP_ROOT/sessions" \
  DISPATCH_STATE_DIR="$TMP_ROOT/state" \
  OPEN_SESSION_SH="$FAKE_OPEN_SESSION" \
  PATH="$FAKE_BIN:$PATH" \
  TELEPTY="$FAKE_BIN/telepty" \
    env "$home_env=$fake_real" \
    "$REPO_ROOT/bin/dispatch.sh" --spawn-and-dispatch \
      --track t47 --name "$cli" --cwd "$PROJECT_CWD" --cli "$cli" --role coder \
      --from t47-test --ref "$ref_file" --timeout-ms 800 --no-verify-started \
      >/dev/null 2>&1 || true

  if [ ! -s "$OPEN_ARGS_FILE" ]; then
    echo "FAIL ($cli): open-session was never invoked" >&2; exit 1
  fi
  # --cwd handed to open-session must be the role-sandbox dir (BOOT path), not the
  # original project cwd (legacy path).
  local open_cwd
  open_cwd=$(awk 'p{print;exit} /^--cwd$/{p=1}' "$OPEN_ARGS_FILE")
  case "$open_cwd" in
    *"/role-sandbox/coder-t47-$cli"*) : ;;
    *) echo "FAIL ($cli): open-session --cwd='$open_cwd' is not the role-sandbox (boot path not taken)" >&2
       cat "$OPEN_ARGS_FILE" >&2; exit 1 ;;
  esac
  # The worker-launcher handed to open-session must exec -a <cli> (display_cli
  # parameterized) and chain to the boot launcher.
  local open_cli
  open_cli=$(awk 'p{print;exit} /^--cli$/{p=1}' "$OPEN_ARGS_FILE")
  [ -f "$open_cli" ] || { echo "FAIL ($cli): worker-launcher '$open_cli' missing" >&2; exit 1; }
  grep -qF "exec -a $cli" "$open_cli" || {
    echo "FAIL ($cli): worker-launcher does not exec -a $cli (display_cli not parameterized)" >&2
    cat "$open_cli" >&2; exit 1; }
  # Boot launcher exists and exports the shadow config-home env.
  local boot_launcher="$AIG_HOME/sessions/t47-$cli/boot/launcher.sh"
  [ -f "$boot_launcher" ] || { echo "FAIL ($cli): boot launcher missing at $boot_launcher" >&2; exit 1; }
  grep -qF "export $want_shadow=" "$boot_launcher" || {
    echo "FAIL ($cli): boot launcher missing shadow-home export $want_shadow" >&2
    cat "$boot_launcher" >&2; exit 1; }
  echo "T47 $cli OK"
}

if command -v codex >/dev/null 2>&1; then
  run_one codex CODEX_HOME CODEX_HOME
else
  echo "T47 codex SKIP — codex not installed"
fi
if command -v gemini >/dev/null 2>&1; then
  run_one gemini GEMINI_CLI_HOME GEMINI_CLI_HOME
else
  echo "T47 gemini SKIP — gemini not installed"
fi

echo "T47 PASS"
