#!/usr/bin/env bash
# ADR-MF #4 — bootstrap default instruction tree (SPEC §5.4).
# Idempotent: only creates directories / files that are missing.
# Honors $AIGENTRY_HOME (default ~/.aigentry) for CI / test isolation (OQ3).
set -euo pipefail

PREFIX="${AIGENTRY_HOME:-$HOME/.aigentry}"
ROOT="$PREFIX/instructions"

# Roles per #99 enum SSOT (src/session/types.ts Role).
ROLES=(orchestrator architect coder tester builder analyst researcher reviewer logger)

ensure_dir() {
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
    echo "created dir : $1"
  else
    echo "exists dir  : $1"
  fi
}

ensure_file() {
  local target="$1"
  shift
  if [ ! -f "$target" ]; then
    printf '%s\n' "$@" > "$target"
    echo "created file: $target"
  else
    echo "exists file : $target"
  fi
}

ensure_dir "$ROOT"
ensure_dir "$ROOT/roles"
ensure_dir "$ROOT/projects"

ensure_file "$ROOT/common.md" \
  "# Common instructions (universal)" \
  "" \
  "User override — replace this placeholder with your repo-wide common-layer rules." \
  "Composed by resolveInstructions() per ADR-MF §4.4 as the first of four layers."

for r in "${ROLES[@]}"; do
  ensure_file "$ROOT/roles/$r.md" \
    "# Role: $r" \
    "" \
    "Placeholder role contract — override with $r-role behavioral rules." \
    "Composed by resolveInstructions() per ADR-MF §4.4 as the 'role' layer."
done

echo "install-instructions.sh: complete (prefix=$PREFIX)"
