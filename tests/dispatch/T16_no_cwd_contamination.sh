#!/usr/bin/env bash
# T16 — Integration test for #431 cwd→role contamination fix (ADR 2026-05-12 hybrid).
#
# Reproduces the 2026-05-23 dustcraw-standards incident: a worker spawned in
# /Users/duckyoungkim/projects/aigentry-orchestrator absorbed CLAUDE.md and
# self-identified as orchestrator. With the boot-adapter hybrid (b-2)+(c)
# (bin/boot-prepare.mjs emits a per-session launcher.sh that sets
# AIGENTRY_TARGET_CWD + execs `claude --append-system-prompt-file`; dispatch.sh
# spawns it in a sandbox cwd), the worker must:
#   (A) read its role contract from a staged effective_prompt.md that contains
#       no target-cwd CLAUDE.md content,
#   (B) run as claude with --append-system-prompt-file (OAuth-compatible) in
#       the sandbox cwd, with AIGENTRY_TARGET_CWD env exported,
#   (C) self-identify with its dispatch role in the first 30 lines of read-screen,
#   (D) not echo any orchestrator-self-id keyword in the first 30 lines.
#
# Live integration — actually spawns a claude session via real dispatch.sh.
# Skips gracefully when claude / telepty / node / python3 missing (CI).
# Teardown via session-cleanup.sh.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"

require_or_skip() {
  for cmd in claude telepty node python3; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "T16 SKIP — '$cmd' not in PATH"
      exit 0
    fi
  done
  if ! telepty list >/dev/null 2>&1; then
    echo "T16 SKIP — telepty daemon not reachable"
    exit 0
  fi
  if [ ! -x "$REPO_ROOT/bin/boot-prepare.mjs" ]; then
    echo "FAIL: bin/boot-prepare.mjs missing or not executable" >&2; exit 1
  fi
  if [ ! -f "$REPO_ROOT/dist/src/session/boot-adapter/index.js" ]; then
    echo "T16 SKIP — dist/ not built (run 'npm run build' first)"
    exit 0
  fi
}
require_or_skip

T_TRACK="t16"
T_NAME="contam-$$"
T_SID="${T_TRACK}-${T_NAME}"
T_REF=$(mktemp -t t16-ref.XXXXXX)
T_STAGED="$HOME/.aigentry/sessions/$T_SID/boot/effective_prompt.md"
T_LAUNCHER="$HOME/.aigentry/sessions/$T_SID/boot/launcher.sh"
T_SANDBOX="$HOME/.aigentry/role-sandbox/coder-$T_SID"

cleanup() {
  rm -f "$T_REF" 2>/dev/null || true
  "$REPO_ROOT/bin/session-cleanup.sh" "$T_SID" >/dev/null 2>&1 || true
  rm -rf "$HOME/.aigentry/sessions/$T_SID" 2>/dev/null || true
  rm -rf "$T_SANDBOX" 2>/dev/null || true
  rm -f "$HOME/.aigentry/dispatch-helper/$T_SID" 2>/dev/null || true
}
trap cleanup EXIT

# Ref intentionally avoids orchestrator-claim keywords so a positive hit in (D)
# can only come from contamination.
cat > "$T_REF" <<'EOF'
# T16-coder-probe dispatch ref

You are T16-coder-probe. Your role is coder.
Acknowledge with one line then HOLD: "T16-coder-probe online; role coder; awaiting task."
Do not spawn subagents. Do not infer any other role from your cwd.
EOF

echo "T16: spawning $T_SID with --role coder --cwd=$REPO_ROOT" >&2
if ! "$REPO_ROOT/bin/dispatch.sh" \
    --spawn-and-dispatch \
    --track "$T_TRACK" --name "$T_NAME" --cwd "$REPO_ROOT" \
    --cli claude --role coder \
    --from t16-test \
    --ref "$T_REF" \
    --timeout-ms 60000 >/tmp/t16-dispatch.log 2>&1; then
  echo "FAIL: dispatch.sh --spawn-and-dispatch exited non-zero" >&2
  echo "--- dispatch.log ---" >&2; cat /tmp/t16-dispatch.log >&2 || true
  exit 1
fi

# --- A: staged effective_prompt.md is correctly seeded ----------------------
if [ ! -f "$T_STAGED" ]; then
  echo "FAIL (A): staged effective_prompt.md missing at $T_STAGED" >&2; exit 1
fi
if ! grep -qF '# Role: coder' "$T_STAGED"; then
  echo "FAIL (A.1): staged file missing coder role layer" >&2; cat "$T_STAGED" >&2; exit 1
fi
# Orchestrator AGENTS.md unique strings — must NOT have leaked.
if grep -qF '컨트롤 타워' "$T_STAGED" || grep -qF '위임 전 체크리스트' "$T_STAGED"; then
  echo "FAIL (A.2): staged effective_prompt.md contains orchestrator AGENTS.md content" >&2
  cat "$T_STAGED" >&2; exit 1
fi
if ! grep -qF 'Session boot contract (#431' "$T_STAGED"; then
  echo "FAIL (A.3): session contract preamble missing" >&2; exit 1
fi
if ! grep -qF "AIGENTRY_TARGET_CWD" "$T_STAGED"; then
  echo "FAIL (A.4): session contract missing AIGENTRY_TARGET_CWD reference" >&2; exit 1
fi

# --- A.5: launcher.sh is properly seeded ------------------------------------
if [ ! -x "$T_LAUNCHER" ]; then
  echo "FAIL (A.5): launcher.sh missing or not executable at $T_LAUNCHER" >&2; exit 1
fi
if ! grep -qF "export AIGENTRY_TARGET_CWD=" "$T_LAUNCHER"; then
  echo "FAIL (A.5.1): launcher.sh does not export AIGENTRY_TARGET_CWD" >&2; exit 1
fi
if grep -qF -- '--bare' "$T_LAUNCHER"; then
  echo "FAIL (A.5.2): launcher.sh uses --bare (auth-incompatible with OAuth)" >&2; exit 1
fi
if ! grep -qF -- "--append-system-prompt-file $T_STAGED" "$T_LAUNCHER"; then
  echo "FAIL (A.5.3): launcher.sh does not use --append-system-prompt-file=$T_STAGED" >&2; exit 1
fi

# --- B: spawned claude process has the right argv + cwd + env --------------
# Allow a moment for the launcher to exec into claude (cmux's claude wrapper may
# re-exec into the real binary, injecting --session-id / --settings — that's fine).
sleep 2
# Match by unique staged-prompt path; argv order isn't guaranteed (cmux wrapper
# may interleave its own --session-id / --settings flags before our --append-…).
claude_pid=$(pgrep -f "$T_STAGED" 2>/dev/null | head -1 || true)
if [ -z "$claude_pid" ]; then
  echo "FAIL (B): no process found referencing staged path $T_STAGED" >&2
  ps -axww -o command 2>/dev/null | grep -F "$T_SID" | grep -v grep >&2 || true
  exit 1
fi
ps_out=$(ps -axww -o command -p "$claude_pid" 2>/dev/null | tail -n +2 || true)
if printf '%s' "$ps_out" | grep -qF -- '--bare'; then
  echo "FAIL (B.1): claude launched with --bare" >&2
  echo "  argv: $ps_out" >&2; exit 1
fi
if ! printf '%s' "$ps_out" | grep -qF -- "--append-system-prompt-file"; then
  echo "FAIL (B.2a): claude missing --append-system-prompt-file flag" >&2
  echo "  argv: $ps_out" >&2; exit 1
fi
if ! printf '%s' "$ps_out" | grep -qF -- "$T_STAGED"; then
  echo "FAIL (B.2b): claude argv does not reference staged prompt $T_STAGED" >&2
  echo "  argv: $ps_out" >&2; exit 1
fi
# Process cwd — sandbox path (so cwd auto-discovery finds no project CLAUDE.md).
proc_cwd=$(lsof -a -p "$claude_pid" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//' | head -1)
if [ "$proc_cwd" != "$T_SANDBOX" ]; then
  echo "FAIL (B.3): claude cwd = '$proc_cwd', want '$T_SANDBOX'" >&2; exit 1
fi
# Env — AIGENTRY_TARGET_CWD set to the original --cwd (per launcher.sh export).
# Use `ps eww` for full env dump (BSD form on Darwin).
env_dump=$(ps eww -p "$claude_pid" 2>/dev/null || true)
if ! printf '%s' "$env_dump" | grep -qF "AIGENTRY_TARGET_CWD=$REPO_ROOT"; then
  echo "FAIL (B.4): AIGENTRY_TARGET_CWD=$REPO_ROOT not present in claude env" >&2
  echo "--- env dump head (last 400 chars) ---" >&2
  printf '%s' "$env_dump" | tail -c 400 >&2; echo "" >&2
  exit 1
fi

# Sandbox dir defense-in-depth: no CLAUDE.md present.
if [ -f "$T_SANDBOX/CLAUDE.md" ]; then
  echo "FAIL (B.5): sandbox unexpectedly contains CLAUDE.md" >&2; exit 1
fi

# --- C: read-screen positive ------------------------------------------------
# Claude (with --effort xhigh + stop hooks) takes a long time to emit text.
# Poll up to 180s for the dispatch ref keyword. Search a wide tail (the chat
# history sits above the status-bar spinner area, so the orchestrator's strict
# "first 30 lines" reading is too tight when claude is mid-thought — we widen
# to the captured tail and assert role-keyword presence anywhere in scrollback).
deadline=$(($(date +%s) + 180))
screen=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  screen=$(telepty read-screen "$T_SID" --lines 200 2>/dev/null || true)
  if printf '%s\n' "$screen" | grep -qi 'coder'; then break; fi
  sleep 5
done
if ! printf '%s\n' "$screen" | grep -qi 'coder'; then
  echo "FAIL (C): 'coder' not seen in worker screen within 180s" >&2
  echo "--- last seen tail (last 60 lines) ---" >&2
  printf '%s\n' "$screen" | tail -60 >&2
  exit 1
fi

# --- D: read-screen negative — no orchestrator self-claim -------------------
# Dispatch ref text (T_REF above) carefully omits the negative keywords, so any
# hit in the captured tail signals contamination from the cwd CLAUDE.md.
if printf '%s\n' "$screen" | grep -qiE 'orchestrator|coordinator|aigentry-orchestrator-claude'; then
  echo "FAIL (D): worker screen contains orchestrator-self-id keyword" >&2
  echo "--- offending lines ---" >&2
  printf '%s\n' "$screen" | grep -iE 'orchestrator|coordinator|aigentry-orchestrator-claude' >&2
  exit 1
fi

echo "T16 PASS"
