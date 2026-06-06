#!/usr/bin/env bash
# T28 — protected-branch push guard for spawned worker sessions (#509).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
REAL_GIT="$(command -v git || true)"

if [ -z "$REAL_GIT" ]; then
  echo "T28 SKIP — git not in PATH"
  exit 0
fi

TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

HOOK_SRC="$REPO_ROOT/git-hooks/pre-push"
[ -f "$HOOK_SRC" ] || { echo "FAIL: hook missing at $HOOK_SRC" >&2; exit 1; }

install_hooks() {
  local dir="$1"
  mkdir -p "$dir"
  cp "$HOOK_SRC" "$dir/pre-push"
  chmod 0755 "$dir/pre-push"
}

make_repo() {
  local name="$1"
  ORIGIN="$TMP_ROOT/$name/origin.git"
  WORK="$TMP_ROOT/$name/work"
  mkdir -p "$(dirname "$ORIGIN")"
  "$REAL_GIT" init --bare "$ORIGIN" >/dev/null
  "$REAL_GIT" init "$WORK" >/dev/null
  "$REAL_GIT" -C "$WORK" config user.email "t28@example.com"
  "$REAL_GIT" -C "$WORK" config user.name "T28"
  printf '%s\n' "$name" > "$WORK/file.txt"
  "$REAL_GIT" -C "$WORK" add file.txt
  "$REAL_GIT" -C "$WORK" commit -m "seed $name" >/dev/null
  "$REAL_GIT" -C "$WORK" remote add origin "$ORIGIN"
}

guarded_push() {
  local marker="$1" refspec="$2" out="$3" err="$4"
  AIGENTRY_WORKER_SESSION="$marker" \
  AIGENTRY_GIT_HOOKS_DIR="$HOOKS_DIR" \
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=core.hooksPath \
  GIT_CONFIG_VALUE_0="$HOOKS_DIR" \
    "$REAL_GIT" -C "$WORK" push origin "$refspec" >"$out" 2>"$err"
}

# Worker marker blocks protected main.
HOOKS_DIR="$TMP_ROOT/hooks-main"
install_hooks "$HOOKS_DIR"
make_repo "blocked-main"
if guarded_push "1" "HEAD:refs/heads/main" "$TMP_ROOT/main.out" "$TMP_ROOT/main.err"; then
  echo "FAIL: worker push to main unexpectedly succeeded" >&2
  exit 1
fi
grep -qF "blocked worker-session push" "$TMP_ROOT/main.err" || {
  echo "FAIL: blocked main push did not print guard message" >&2
  cat "$TMP_ROOT/main.err" >&2
  exit 1
}
if "$REAL_GIT" --git-dir "$ORIGIN" rev-parse --verify refs/heads/main >/dev/null 2>&1; then
  echo "FAIL: blocked main push created origin/main" >&2
  exit 1
fi

# No marker means orchestrator land path is unaffected.
make_repo "orchestrator-allowed"
if ! guarded_push "" "HEAD:refs/heads/main" "$TMP_ROOT/orch.out" "$TMP_ROOT/orch.err"; then
  echo "FAIL: no-marker push to main should be allowed" >&2
  cat "$TMP_ROOT/orch.err" >&2
  exit 1
fi
"$REAL_GIT" --git-dir "$ORIGIN" rev-parse --verify refs/heads/main >/dev/null

# Worker marker allows non-protected feature branches.
make_repo "feature-allowed"
if ! guarded_push "1" "HEAD:refs/heads/feature/t28" "$TMP_ROOT/feature.out" "$TMP_ROOT/feature.err"; then
  echo "FAIL: worker push to feature branch should be allowed" >&2
  cat "$TMP_ROOT/feature.err" >&2
  exit 1
fi
"$REAL_GIT" --git-dir "$ORIGIN" rev-parse --verify refs/heads/feature/t28 >/dev/null

# Worker marker also blocks master.
make_repo "blocked-master"
if guarded_push "1" "HEAD:refs/heads/master" "$TMP_ROOT/master.out" "$TMP_ROOT/master.err"; then
  echo "FAIL: worker push to master unexpectedly succeeded" >&2
  exit 1
fi
grep -qF "blocked worker-session push" "$TMP_ROOT/master.err" || {
  echo "FAIL: blocked master push did not print guard message" >&2
  cat "$TMP_ROOT/master.err" >&2
  exit 1
}

# Preserve an existing repo-local pre-push hook when the guard allows the push.
make_repo "chain-local"
CHAIN_OUT="$TMP_ROOT/chain.out"
cat > "$WORK/.git/hooks/pre-push" <<'SH'
#!/usr/bin/env bash
echo "chained-local-pre-push" >> "$CHAIN_OUT"
SH
chmod 0755 "$WORK/.git/hooks/pre-push"
CHAIN_OUT="$CHAIN_OUT" guarded_push "1" "HEAD:refs/heads/feature/chain" "$TMP_ROOT/chain-push.out" "$TMP_ROOT/chain-push.err"
grep -qF "chained-local-pre-push" "$CHAIN_OUT" || {
  echo "FAIL: repo-local pre-push hook was not chained" >&2
  exit 1
}

# Dispatch spawn path propagation: dispatch.sh must hand open-session a
# generated codex launcher that exports marker + Git env-config, so a real git
# push from the worker process is blocked.
make_repo "dispatch-propagation"
FAKE_BIN="$TMP_ROOT/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/codex" <<'SH'
#!/usr/bin/env bash
cd "$LAUNCHER_WORK"
git push origin HEAD:refs/heads/main >"$LAUNCHER_OUT" 2>"$LAUNCHER_ERR"
SH
chmod 0755 "$FAKE_BIN/codex"

FAKE_OPEN_SESSION="$TMP_ROOT/fake-open-session.sh"
FAKE_OPEN_STATUS="$TMP_ROOT/fake-open-status"
cat > "$FAKE_OPEN_SESSION" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cli=""
cwd=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cli) cli="$2"; shift 2;;
    --cwd) cwd="$2"; shift 2;;
    --track|--name|--extra-flags) shift 2;;
    *) shift;;
  esac
done
[ -n "$cli" ] || { echo "fake-open-session: --cli missing" >&2; exit 2; }
[ -n "$cwd" ] || { echo "fake-open-session: --cwd missing" >&2; exit 2; }
set +e
PATH="$FAKE_BIN:$PATH" LAUNCHER_WORK="$cwd" "$cli"
echo "$?" > "$FAKE_OPEN_STATUS"
set -e
exit 0
SH
chmod 0755 "$FAKE_OPEN_SESSION"

cat > "$FAKE_BIN/telepty" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  list) echo '[{"id":"t28-dispatch-main","command":"codex"}]' ;;
  read-screen) echo '›' ;;
  inject) exit 0 ;;
  *) exit 0 ;;
esac
SH
chmod 0755 "$FAKE_BIN/telepty"

REF_FILE="$TMP_ROOT/ref.md"
printf '%s\n' "T28 dispatch propagation ref" > "$REF_FILE"
# dispatch.sh's pre-inject wait_for_ready ALWAYS runs — it is NOT gated by
# --no-verify-started (that flag only skips the post-inject Rule-33 START check).
# The fake codex launcher attempts its push then exits, so this throwaway session
# never reaches REPL-ready and dispatch times out by design (--timeout-ms 1000).
# The push-guard assertions below depend only on the launcher's side effects
# (FAKE_OPEN_STATUS + dispatch-launcher.err), which are written during
# open-session BEFORE the wait — so the expected non-zero timeout exit is tolerated.
HOME="$TMP_ROOT/home" \
AIGENTRY_SESSIONS_ROOT="$TMP_ROOT/sessions" \
DISPATCH_STATE_DIR="$TMP_ROOT/state" \
OPEN_SESSION_SH="$FAKE_OPEN_SESSION" \
FAKE_BIN="$FAKE_BIN" \
FAKE_OPEN_STATUS="$FAKE_OPEN_STATUS" \
LAUNCHER_OUT="$TMP_ROOT/dispatch-launcher.out" \
LAUNCHER_ERR="$TMP_ROOT/dispatch-launcher.err" \
PATH="$FAKE_BIN:$PATH" \
TELEPTY="$FAKE_BIN/telepty" \
  "$REPO_ROOT/bin/dispatch.sh" --spawn-and-dispatch \
    --track t28 --name dispatch-main --cwd "$WORK" --cli codex \
    --from t28-test --ref "$REF_FILE" --timeout-ms 1000 --no-verify-started \
    >/dev/null 2>&1 || true

if [ "$(cat "$FAKE_OPEN_STATUS")" -eq 0 ]; then
  echo "FAIL: dispatch-generated worker launcher did not block protected push" >&2
  exit 1
fi
grep -qF "blocked worker-session push" "$TMP_ROOT/dispatch-launcher.err" || {
  echo "FAIL: dispatch-generated worker launcher did not propagate guard env" >&2
  cat "$TMP_ROOT/dispatch-launcher.err" >&2
  exit 1
}

echo "T28 PASS"
