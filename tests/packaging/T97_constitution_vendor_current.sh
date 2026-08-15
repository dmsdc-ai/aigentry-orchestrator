#!/usr/bin/env bash
# T97 — the vendored aigentry 헌법 must not drift from its source
# (SPEC 2026-08-15-npm-init-environment §4.3).
#
# tooling/instructions/common.md cites the aigentry 헌법 (제1조–제18조 + 최종조), which lives
# in a DIFFERENT repo — ~/projects/aigentry/docs/CONSTITUTION.md. This package vendors a copy
# so `init` has something to write to ~/.aigentry/CONSTITUTION.md on a machine that has no
# such repo. Vendoring across a repo boundary drifts, so it gets a guard.
#
# On a maintainer machine (source present) this asserts byte-identity and fails on drift.
# Everywhere else — CI, a contributor's clone — it SKIPS WITH A PRINTED REASON. An announced
# skip, never a silent pass: a test that quietly passes when it measured nothing is the
# defect class this release exists to remove.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"

SOURCE="${AIGENTRY_CONSTITUTION_SOURCE:-$HOME/projects/aigentry/docs/CONSTITUTION.md}"
VENDORED="$REPO_ROOT/tooling/instructions/CONSTITUTION.md"

fail() { echo "FAIL: T97 — $*" >&2; exit 1; }

[ -f "$VENDORED" ] || fail "vendored copy missing: $VENDORED (init step 5.2 would have nothing to write)"

if [ ! -f "$SOURCE" ]; then
  echo "SKIP: T97 — upstream source not present at $SOURCE, so vendor currency was NOT measured."
  echo "      This is expected on CI and on contributor clones (the aigentry repo is a separate,"
  echo "      maintainer-local checkout). Set AIGENTRY_CONSTITUTION_SOURCE to point at it."
  echo "      What still held: the vendored copy exists ($(wc -c < "$VENDORED" | tr -d ' ') bytes)."
  exit 0
fi

if ! cmp -s "$SOURCE" "$VENDORED"; then
  echo "--- diff (source -> vendored) ---" >&2
  diff -u "$SOURCE" "$VENDORED" | head -40 >&2 || true
  fail "vendored 헌법 has drifted from $SOURCE. Re-vendor with: cp '$SOURCE' '$VENDORED'"
fi

# The citation in common.md must point at the token init substitutes, not back at the
# maintainer-local repo path — otherwise the vendored copy is dead weight on a user machine.
grep -q '{{CONSTITUTION_PATH}}' "$REPO_ROOT/tooling/instructions/common.md" \
  || fail "tooling/instructions/common.md no longer carries {{CONSTITUTION_PATH}}; the vendored copy would be unreferenced"

echo "PASS: T97 — vendored 헌법 byte-identical to $SOURCE ($(wc -c < "$VENDORED" | tr -d ' ') bytes)"
