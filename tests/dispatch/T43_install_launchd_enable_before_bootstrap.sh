#!/usr/bin/env bash
# T43 — bin/install-launchd.sh must `launchctl enable` a label BEFORE `bootstrap`
# for BOTH com.aigentry.reconciler AND com.aigentry.telepty (#542). Root cause:
# the reconciler label sat in launchd's persistent DISABLED-override DB
# (disabled.501.plist); RunAtLoad fires only at bootstrap of a NON-disabled label,
# so writing the plist + bootstrap was a no-op until a manual `launchctl enable`
# cleared the override. The installer must emit `enable` (LOAD-BEARING) before
# `bootstrap` for each label. Idempotent + safe to re-run.
#
# HERMETIC: LAUNCHCTL_CMD → a recorder stub; LAUNCH_AGENTS_DIR → temp dir with
# dummy plists. NO real launchctl call. TDD: RED before the script exists.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
INSTALL="$REPO_ROOT/bin/install-launchd.sh"
BASH_BIN="$(command -v bash)"

fail() { echo "FAIL[T43]: $*" >&2; exit 1; }

# macOS-only behavior under test; on non-Darwin the script is a graceful no-op.
if [ "$(uname -s)" != "Darwin" ]; then echo "T43 SKIP (non-Darwin)"; exit 0; fi

[ -f "$INSTALL" ] || fail "bin/install-launchd.sh does not exist yet (expected for RED)"

LC_LOG="$T_TMP/launchctl-calls.log"; : > "$LC_LOG"
LC_STUB="$STUB_BIN/launchctl-stub.sh"
cat > "$LC_STUB" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$LC_LOG"
exit 0
EOF
chmod +x "$LC_STUB"

# Temp LaunchAgents dir with dummy plists for both labels.
LA_DIR="$T_TMP/LaunchAgents"; mkdir -p "$LA_DIR"
for label in com.aigentry.reconciler com.aigentry.telepty; do
  printf '<plist></plist>\n' > "$LA_DIR/$label.plist"
done

LAUNCHCTL_CMD="$LC_STUB" LAUNCH_AGENTS_DIR="$LA_DIR" "$BASH_BIN" "$INSTALL" >/dev/null 2>&1 \
  || fail "install-launchd.sh exited non-zero"

# Per-label assertion: `enable <...label>` line index < `bootstrap <...> ...label...` index.
assert_enable_before_bootstrap() {
  local label="$1"
  local en bs
  en=$(grep -nE "^enable .*${label}([^.]|$)" "$LC_LOG" | head -1 | cut -d: -f1)
  bs=$(grep -nE "^bootstrap .*${label}\.plist" "$LC_LOG" | head -1 | cut -d: -f1)
  [ -n "$en" ] || fail "$label: no 'enable' launchctl call emitted. log:
$(cat "$LC_LOG")"
  [ -n "$bs" ] || fail "$label: no 'bootstrap' launchctl call emitted. log:
$(cat "$LC_LOG")"
  [ "$en" -lt "$bs" ] \
    || fail "$label: 'enable' (line $en) not before 'bootstrap' (line $bs). log:
$(cat "$LC_LOG")"
}

assert_enable_before_bootstrap com.aigentry.reconciler
assert_enable_before_bootstrap com.aigentry.telepty

# Idempotent: a second run must also succeed.
LAUNCHCTL_CMD="$LC_STUB" LAUNCH_AGENTS_DIR="$LA_DIR" "$BASH_BIN" "$INSTALL" >/dev/null 2>&1 \
  || fail "install-launchd.sh not idempotent (second run exited non-zero)"

echo "T43 PASS"
