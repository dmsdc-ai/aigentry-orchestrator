#!/usr/bin/env bash
# T48 — #532 LIVE: end-to-end codex/gemini additive role-injection.
#
# Builds a REAL boot artifact via bin/boot-prepare.mjs (sentinel role prompt
# staged as the sandbox cwd AGENTS.md/GEMINI.md + a per-session shadow config
# home), then runs the CLI HEADLESS (codex exec / gemini -p) in that sandbox with
# the launcher's config-home env, asserting:
#   (1) ROLE RECEIPT  — the model echoes the staged role sentinel (cwd context
#       file was auto-discovered + read additively).
#   (2) GLOBAL ISOLATION — the model does NOT echo the global-doc canary planted
#       in the (fake) real config home (shadow home omitted it, §3.2).
#   (3) AUTH SURVIVES — the model actually answers (auth.json / oauth_creds.json
#       symlink-preserved through the shadow home).
#   (4) codex: cwd AGENTS.md loads in a NON-git sandbox; headless bypass needs no
#       folder-trust modal (§3.3 / §5.6-5.7).
# PROJECT ISOLATION is structural (sandbox cwd has no project ancestor) and is
# covered hermetically by tests/session/boot-prepare.test.ts (532-*-B).
#
# Live-integration gate (#525): real model round-trips + writes under
# $AIGENTRY_HOME. Opt in with AIGENTRY_RUN_LIVE_TESTS=1 (orchestrator-supervised).
# NOTE: the launcher's DEFAULT gemini model (gemini-3.1-pro-preview) may be
# free-tier quota-limited (HTTP 429, limit:0) on some accounts — that is a
# billing/account limit, NOT a mechanism failure (auth still reached the API). To
# keep the assertion deterministic, the gemini leg uses AIGENTRY_T48_GEMINI_MODEL
# (default gemini-2.5-flash) for the round-trip; the staging/shadow path is
# identical regardless of model.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

if [ "${AIGENTRY_RUN_LIVE_TESTS:-0}" != "1" ]; then
  echo "T48 SKIP — live-integration test (set AIGENTRY_RUN_LIVE_TESTS=1 to run)"
  exit 0
fi
for cmd in node python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "T48 SKIP — '$cmd' not in PATH"; exit 0; }
done
if [ ! -f "$REPO_ROOT/dist/src/session/boot-adapter/index.js" ]; then
  echo "T48 SKIP — dist/ not built (run 'npm run build')"; exit 0
fi

SENTINEL="T48-ROLE-SENTINEL-$$"
GLOBAL_CANARY="T48-GLOBAL-CANARY-$$"

TMP_ROOT=$(mktemp -d)
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

AIG_HOME="$TMP_ROOT/aig"
mkdir -p "$AIG_HOME/instructions/roles" "$AIG_HOME/instructions/projects"
printf '# COMMON\n' > "$AIG_HOME/instructions/common.md"
# The sentinel rides the role layer → it ends up in the staged context file.
printf '# Role: coder\nYour secret codeword is %s. Reply with it verbatim when asked.\n' \
  "$SENTINEL" > "$AIG_HOME/instructions/roles/coder.md"

PROJECT_CWD="$TMP_ROOT/project"
mkdir -p "$PROJECT_CWD"

# Run one CLI: build the boot artifact, then headless round-trip.
run_cli() {
  local cli="$1" home_env="$2" ctxfile="$3" shadowdir="$4" authfile="$5" real_home="$6"
  shift 6
  local -a headless_cmd=("$@")

  # Fake "real" config-home: symlink real auth (so the model authenticates) +
  # plant a GLOBAL context-doc canary that the shadow home must drop.
  local fake_real="$TMP_ROOT/real-$cli"
  mkdir -p "$fake_real"
  if [ -f "$real_home/$authfile" ]; then
    ln -s "$real_home/$authfile" "$fake_real/$authfile"
  else
    echo "T48 $cli SKIP — no live auth at $real_home/$authfile (cannot test auth survival)"; return 0
  fi
  printf '# GLOBAL %s doc\n%s\n' "$cli" "$GLOBAL_CANARY" > "$fake_real/$ctxfile"

  local sid="t48-$cli"
  local boot_json
  if ! boot_json=$(AIGENTRY_HOME="$AIG_HOME" env "$home_env=$fake_real" \
      node "$REPO_ROOT/bin/boot-prepare.mjs" --role coder --cwd "$PROJECT_CWD" --sid "$sid" --cli "$cli"); then
    echo "FAIL ($cli): boot-prepare.mjs exited non-zero" >&2; exit 1
  fi
  local sandbox shadow
  sandbox=$(BJ="$boot_json" python3 -c 'import json,os;print(json.loads(os.environ["BJ"])["spawn_cwd"])')
  shadow="$sandbox/$shadowdir"

  # Structural checks before the round-trip.
  [ -f "$sandbox/$ctxfile" ] || { echo "FAIL ($cli): staged $ctxfile missing in sandbox" >&2; exit 1; }
  grep -qF "$SENTINEL" "$sandbox/$ctxfile" || { echo "FAIL ($cli): sentinel not in staged $ctxfile" >&2; exit 1; }
  [ -e "$shadow/$authfile" ] || { echo "FAIL ($cli): auth not mirrored into shadow home" >&2; exit 1; }
  [ -e "$shadow/$ctxfile" ] && { echo "FAIL ($cli): global $ctxfile LEAKED into shadow home" >&2; exit 1; }

  echo "T48 $cli: running headless round-trip (model auth + cwd context read)…" >&2
  local out
  if ! out=$(cd "$sandbox" && env "$home_env=$shadow" "${headless_cmd[@]}" \
      "What is your secret codeword? If you see any global canary value, print it too. One line." 2>"$TMP_ROOT/$cli.err"); then
    if grep -qiE 'quota|rate.?limit|429' "$TMP_ROOT/$cli.err"; then
      echo "T48 $cli PARTIAL — staging+shadow verified; model round-trip hit a quota/rate limit (account billing, not a mechanism failure):" >&2
      grep -iE 'quota|429|rate' "$TMP_ROOT/$cli.err" | head -2 >&2
      return 0
    fi
    echo "FAIL ($cli): headless round-trip errored" >&2; cat "$TMP_ROOT/$cli.err" >&2; exit 1
  fi
  # (1) role receipt.
  printf '%s' "$out" | grep -qF "$SENTINEL" || {
    echo "FAIL ($cli): model did not echo role sentinel (cwd $ctxfile not read)" >&2
    echo "--- output ---" >&2; printf '%s\n' "$out" >&2; exit 1; }
  # (2) global isolation.
  if printf '%s' "$out" | grep -qF "$GLOBAL_CANARY"; then
    echo "FAIL ($cli): model echoed the GLOBAL canary (shadow home leak)" >&2
    echo "--- output ---" >&2; printf '%s\n' "$out" >&2; exit 1
  fi
  echo "T48 $cli OK — role receipt + global isolation + auth all verified" >&2
}

if command -v codex >/dev/null 2>&1; then
  run_cli codex CODEX_HOME AGENTS.md .codexhome auth.json "$HOME/.codex" \
    codex exec --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false
else
  echo "T48 codex SKIP — codex not installed"
fi

if command -v gemini >/dev/null 2>&1; then
  GEM_MODEL="${AIGENTRY_T48_GEMINI_MODEL:-gemini-2.5-flash}"
  run_cli gemini GEMINI_CLI_HOME GEMINI.md .geminihome oauth_creds.json "$HOME/.gemini" \
    gemini -m "$GEM_MODEL" --approval-mode yolo --skip-trust -p
else
  echo "T48 gemini SKIP — gemini not installed"
fi

echo "T48 PASS"
