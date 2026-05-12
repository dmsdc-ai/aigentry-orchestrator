#!/usr/bin/env bash
# ADR-MF #4 — bootstrap default instruction tree (SPEC §5.4).
# ADR-MF #6 — installs common.md + roles/orchestrator.md from tooling/instructions/.
# Idempotent: by default skip existing files. With --force overwrite.
# Honors $AIGENTRY_HOME (default ~/.aigentry) for CI / test isolation.
set -euo pipefail

FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help)
      printf 'Usage: install-instructions.sh [--force]\n  --force  Overwrite existing files (default: preserve)\n  AIGENTRY_HOME  Optional prefix (default: $HOME/.aigentry)\n'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_ROOT="$SCRIPT_DIR/../tooling/instructions"
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

# install_file <target> <action-when-missing>
#   action-when-missing: "copy:<src>" copies SRC_ROOT-relative file;
#                        "placeholder:<role>" writes generic role placeholder.
install_file() {
  local target="$1"; local action="$2"
  if [ -f "$target" ] && [ "$FORCE" -eq 0 ]; then
    echo "exists file : $target"
    return 0
  fi
  local verb="created file"
  [ -f "$target" ] && verb="updated file"
  case "$action" in
    copy:*)
      cp "$SRC_ROOT/${action#copy:}" "$target" ;;
    placeholder:*)
      local r="${action#placeholder:}"
      printf '# Role: %s\n\nPlaceholder role contract — override with %s-role behavioral rules.\nComposed by resolveInstructions() per ADR-MF §4.4 as the '\''role'\'' layer.\n' "$r" "$r" > "$target" ;;
    *) echo "unknown install action: $action" >&2; exit 3 ;;
  esac
  echo "$verb: $target"
}

ensure_dir "$ROOT"
ensure_dir "$ROOT/roles"
ensure_dir "$ROOT/projects"

install_file "$ROOT/common.md" "copy:common.md"
install_file "$ROOT/roles/orchestrator.md" "copy:roles/orchestrator.md"

for r in "${ROLES[@]}"; do
  [ "$r" = "orchestrator" ] && continue
  install_file "$ROOT/roles/$r.md" "placeholder:$r"
done

echo "install-instructions.sh: complete (prefix=$PREFIX, force=$FORCE)"
