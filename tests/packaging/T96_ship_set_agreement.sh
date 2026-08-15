#!/usr/bin/env bash
# T96 — three-way ship-set agreement (SPEC 2026-08-15-npm-init-environment §3.5).
#
# package.json `files[]` is hand-maintained and so is bin/init/manifest.mjs. Three lists
# must agree or the install ships something init cannot find, or init copies something that
# is not in the tarball. This test is the only thing standing between those two lists.
#
#   A = the init manifest        — bin/init/manifest.mjs, the single literal path list
#   B = the ACTUAL tarball       — `npm pack --dry-run --json`, [0].files[].path.
#                                  The measurement, not a re-reading of the whitelist that
#                                  produced it (Rule 39).
#   C = the tree                 — `git ls-files` over each manifest root
#
# Runtime note: `npm pack` runs the `prepack` hook, so this test also proves the build hook
# added in §7.3 works — a tarball measured without it would be a different tarball.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"
cd "$REPO_ROOT"

fail() { echo "FAIL: T96 — $*" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# --- A ---------------------------------------------------------------------------------
node --input-type=module -e '
  import { MANIFEST } from "./bin/init/manifest.mjs";
  console.log(MANIFEST.join("\n"));
' > "$TMP/A"
node --input-type=module -e '
  import { GOVERNANCE_ROOTS, TARBALL_EXEMPT } from "./bin/init/manifest.mjs";
  console.log(JSON.stringify({ GOVERNANCE_ROOTS, TARBALL_EXEMPT }));
' > "$TMP/roots.json"

# --- B --- the real bytes npm would publish.
npm pack --dry-run --json 2>"$TMP/pack.err" > "$TMP/pack.json" \
  || { cat "$TMP/pack.err" >&2; fail "npm pack --dry-run failed"; }
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(j[0].files.map((f) => f.path).join("\n"));
' "$TMP/pack.json" > "$TMP/B"

# --- C --- the tree, over every root any manifest entry lives under.
awk -F/ '{ print (NF>1 ? $1 : $0) }' "$TMP/A" | sort -u > "$TMP/A.roots"
# shellcheck disable=SC2046
git ls-files -- $(tr '\n' ' ' < "$TMP/A.roots") | sort -u > "$TMP/C"

sort -u "$TMP/A" > "$TMP/A.sorted"
sort -u "$TMP/B" > "$TMP/B.sorted"

# --- assertion 1: A ⊆ B -----------------------------------------------------------------
# Failure caught: a scaffold file is added to the manifest and forgotten in files[] → init
# crashes at first run on a user's machine.
missing_from_tarball=$(comm -23 "$TMP/A.sorted" "$TMP/B.sorted")
[ -z "$missing_from_tarball" ] || fail $'assertion 1 (A ⊆ B) — in the init manifest but NOT in the tarball:\n'"$missing_from_tarball"

# --- assertion 2: (B ∩ governance roots) ⊆ A ---------------------------------------------
# Failure caught: dead weight in the tarball that no install path ever places.
node -e '
  const fs = require("fs");
  const { GOVERNANCE_ROOTS, TARBALL_EXEMPT } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const A = new Set(fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean));
  const B = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean);
  const inRoot = (p, r) => (r.endsWith("/") ? p.startsWith(r) : p === r);
  const orphans = B.filter(
    (p) => !TARBALL_EXEMPT.some((e) => inRoot(p, e)) && GOVERNANCE_ROOTS.some((r) => inRoot(p, r)) && !A.has(p),
  );
  if (orphans.length) {
    console.error("shipped into a governance root but absent from the init manifest:\n  " + orphans.join("\n  "));
    process.exit(1);
  }
' "$TMP/roots.json" "$TMP/A.sorted" "$TMP/B.sorted" || fail "assertion 2 ((B ∩ governance roots) ⊆ A) — see above"

# --- assertion 3: A ⊆ C ------------------------------------------------------------------
# Failure caught: a file deleted in a refactor while the manifest still names it.
missing_from_tree=$(comm -23 "$TMP/A.sorted" "$TMP/C")
[ -z "$missing_from_tree" ] || fail $'assertion 3 (A ⊆ C) — in the init manifest but NOT tracked in the tree:\n'"$missing_from_tree"

# --- assertion 4: the bin set is complete, not a trimmed subset ---------------------------
manifest_bin=$(grep -c '^bin/' "$TMP/A.sorted" || true)
tree_bin=$(git ls-files bin | wc -l | tr -d ' ')
[ "$manifest_bin" = "$tree_bin" ] \
  || fail "assertion 4 — manifest names $manifest_bin bin/ files, the tree has $tree_bin. init would ship an incomplete bin/."

# --- assertion 5: the role-file count has ONE SSOT ---------------------------------------
# This is the assertion that catches the "6 vs 9" drift recorded in §0 of the spec.
manifest_roles=$(grep -c '^tooling/instructions/roles/' "$TMP/A.sorted" || true)
declared_roles=$(
  sed -n 's/^ROLES=(\(.*\))$/\1/p' bin/install-instructions.sh | tr ' ' '\n' | grep -c .
)
[ "$manifest_roles" = "9" ] || fail "assertion 5 — manifest names $manifest_roles role files, expected 9"
[ "$declared_roles" = "9" ] \
  || fail "assertion 5 — bin/install-instructions.sh ROLES=() declares $declared_roles roles, expected 9"

echo "PASS: T96 — ship sets agree | manifest=$(wc -l < "$TMP/A.sorted" | tr -d ' ') tarball=$(wc -l < "$TMP/B.sorted" | tr -d ' ') bin=$tree_bin roles=$manifest_roles"
