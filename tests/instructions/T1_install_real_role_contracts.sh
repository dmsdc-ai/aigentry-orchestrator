#!/usr/bin/env bash
# T1 — install-instructions.sh must install REAL role contracts, not placeholders (#519).
# Asserts a fresh --force install into a throwaway AIGENTRY_HOME yields all 9 role
# contracts byte-identical to the source tree (tooling/instructions/roles/*.md),
# none of which is the generic placeholder.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"
SCRIPT="$REPO_ROOT/bin/install-instructions.sh"
SRC_ROLES="$REPO_ROOT/tooling/instructions/roles"

ROLES=(orchestrator architect coder tester builder analyst researcher reviewer logger)
PLACEHOLDER_SENTINEL="Placeholder role contract"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# Throwaway prefix ONLY — never the live ~/.aigentry.
AIGENTRY_HOME="$TMP/home" bash "$SCRIPT" --force >/dev/null

INSTALLED="$TMP/home/instructions/roles"

for r in "${ROLES[@]}"; do
  f="$INSTALLED/$r.md"
  [ -f "$f" ] || fail "$r.md not installed"

  size=$(wc -c < "$f")
  [ "$size" -gt 1000 ] || fail "$r.md too small ($size bytes) — looks like a placeholder"

  if grep -qF "$PLACEHOLDER_SENTINEL" "$f"; then
    fail "$r.md contains placeholder sentinel"
  fi

  # Byte-identical to the canonical source.
  cmp -s "$f" "$SRC_ROLES/$r.md" || fail "$r.md does not byte-match source $SRC_ROLES/$r.md"
done

echo "PASS: T1 — 9 real role contracts installed (0 placeholders)"
