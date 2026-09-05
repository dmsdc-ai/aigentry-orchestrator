#!/usr/bin/env bash
# ADR-MF #4 — bootstrap default instruction tree (SPEC §5.4).
# ADR-MF #6 — installs common.md + roles/*.md from tooling/instructions/ (placeholder fallback when a role file is absent).
# Idempotent: by default skip existing files. With --force overwrite.
# #1069 — substitutes the init template tokens (bin/init/manifest.mjs templateSubs) into every
# file it writes, and exits 4 naming any owned file in which a "{{" survives.
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
# The CONTROL_WORKSPACE token = the checkout that owns this bin/ — what both callers guarantee
# (init runs ws/bin/…, bin/boot-prepare.mjs runs REPO_ROOT/bin/…). Not spelled with braces
# here: this file is in the init MANIFEST and step 6 would rewrite the comment.
WS="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# substitute_tokens <file> — rewritten in place from the SAME map `init` uses
# (bin/init/manifest.mjs templateSubs). Never a bash copy of the table: two copies drift (#1069).
substitute_tokens() {
  node -e '
const fs = require("node:fs");
const [lib, ws, home, file] = process.argv.slice(1);
import(require("node:url").pathToFileURL(lib).href).then(({ templateSubs, substitute }) => {
  fs.writeFileSync(file, substitute(fs.readFileSync(file, "utf8"), templateSubs(ws, home)));
});' "$SCRIPT_DIR/init/manifest.mjs" "$WS" "$PREFIX" "$1"
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
      cp "$SRC_ROOT/${action#copy:}" "$target"
      substitute_tokens "$target" ;;
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

# For each role: copy the real contract when source provides one; otherwise
# fall back to a generic placeholder (#519 — source previously shipped only
# orchestrator.md, so the other 8 were placeholdered on every fresh/--force install).
for r in "${ROLES[@]}"; do
  if [ -f "$SRC_ROOT/roles/$r.md" ]; then
    install_file "$ROOT/roles/$r.md" "copy:roles/$r.md"
  else
    install_file "$ROOT/roles/$r.md" "placeholder:$r"
  fi
done

# #1069 post-deploy sweep — the second damaged file was found by grepping the tree for the
# token class, not by checking the edited file. Owned surface only (projects/ is user content).
# Preserved files are never rewritten, so a leftover there means: re-run with --force.
LEFTOVER="$(grep -lF -- '{{' "$ROOT/common.md" "$ROOT"/roles/*.md || true)"
if [ -n "$LEFTOVER" ]; then
  printf 'install-instructions.sh: unsubstituted template token "{{" survives in:\n%s\n(preserved files are never rewritten — re-run with --force)\n' "$LEFTOVER" >&2
  exit 4
fi

echo "install-instructions.sh: complete (prefix=$PREFIX, force=$FORCE)"
