#!/usr/bin/env bash
# install-launchd.sh — (re)activate the aigentry launchd agents (#542).
#
# Root cause (analyst, 2026-06-07): the label `com.aigentry.reconciler` was in
# launchd's persistent DISABLED-override DB (disabled.501.plist). RunAtLoad fires
# ONLY at bootstrap of a NON-disabled label, so (a) writing/overwriting the plist
# file does NOT load it, and (b) a disabled-override makes bootstrap + RunAtLoad a
# no-op until `launchctl enable` clears the override. The enable was the missing,
# LOAD-BEARING step. (This differs from telepty #543, which was a plist-CONTENT
# defect — missing node PATH → exit 127; here the plist content is already correct
# and the defect is ACTIVATION/INSTALL.)
#
# This installer runs, per label, in order:
#   1. launchctl bootout   gui/<uid>/<label>     (drop any stale instance; tolerated)
#   2. launchctl enable    gui/<uid>/<label>     (LOAD-BEARING — clears disabled-override)
#   3. launchctl bootstrap gui/<uid> <plist>     (load; fires RunAtLoad)
#   4. launchctl kickstart -k gui/<uid>/<label>  (force (re)start now)
# Idempotent + safe to re-run.
#
# Article 17: shell-only, no external deps. macOS-launchd-specific — degrades to a
# logged no-op on non-Darwin (no lib/platform.sh exists; precedent
# bin/orchestrator-boot.sh uses portable primitives + env seams).
#
# Usage:
#   bin/install-launchd.sh         # activate both managed labels
#
# Env / test seams:
#   LAUNCHCTL_CMD       launchctl binary (default: launchctl) — recorder stub in tests.
#   LAUNCH_AGENTS_DIR   plist directory (default: $HOME/Library/LaunchAgents).

set -uo pipefail

# Managed labels — both need the same activation (reconciler #542; telepty #543
# fixed the plist CONTENT but still requires enable-before-bootstrap to activate).
LAUNCHD_LABELS=("com.aigentry.reconciler" "com.aigentry.telepty")

# Test seams (mirror bin/orchestrator-boot.sh KILL_CMD/PS_CMD precedent).
LAUNCHCTL_CMD="${LAUNCHCTL_CMD:-launchctl}"
LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"

log() { echo "[install-launchd] $*" >&2; }

# install_one <label> — bootout → enable → bootstrap → kickstart for one label.
install_one() {
  local label="$1" uid domain plist
  uid="$(id -u)"
  domain="gui/$uid"
  plist="$LAUNCH_AGENTS_DIR/$label.plist"

  if [ ! -f "$plist" ]; then
    log "plist not found: $plist — skipping $label"
    return 0
  fi

  # 1. Drop any existing instance (tolerated: not-loaded → non-zero, harmless).
  "$LAUNCHCTL_CMD" bootout "$domain/$label" 2>/dev/null || true
  # 2. LOAD-BEARING: clear the persistent disabled-override so bootstrap+RunAtLoad
  #    are not a no-op (the exact step #542 was missing).
  if ! "$LAUNCHCTL_CMD" enable "$domain/$label"; then
    log "WARN: launchctl enable $domain/$label non-zero (continuing)"
  fi
  # 3. Load the plist (fires RunAtLoad for a now-enabled label).
  if ! "$LAUNCHCTL_CMD" bootstrap "$domain" "$plist"; then
    log "WARN: launchctl bootstrap $domain $plist non-zero (already loaded?)"
  fi
  # 4. Force (re)start now regardless of RunAtLoad timing.
  "$LAUNCHCTL_CMD" kickstart -k "$domain/$label" 2>/dev/null || true
  log "activated $label"
}

main() {
  if [ "$(uname -s)" != "Darwin" ]; then
    log "launchd is macOS-only; nothing to do on $(uname -s) (Art.17 graceful no-op)"
    return 0
  fi
  local label
  for label in "${LAUNCHD_LABELS[@]}"; do
    install_one "$label"
  done
  log "done: ${#LAUNCHD_LABELS[@]} label(s) processed"
}

# Sourceable for hermetic tests: run main only when executed directly.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
