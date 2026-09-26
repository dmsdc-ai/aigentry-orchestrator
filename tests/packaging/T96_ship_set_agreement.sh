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

# --- generated-cache fixtures: bookkeeping ------------------------------------------------
# CI run 36267366007 shipped bin/__pycache__/current_screen.cpython-312.pyc: the guard suite
# runs bin/session-probe.py BEFORE this test, CPython writes its bytecode cache next to the
# source, and `files[]` overrides the root .gitignore (npm-packlist 8.0.2 nulls the
# .gitignore rule set whenever package.json carries a files array — lib/index.js
# filterEntries()). So the exclusion has to live in `files[]` itself, and this test has to
# prove it on a dirty workspace instead of hoping the workspace is clean.
#
# OWNERSHIP RULE. A path is this invocation's to delete only if this invocation's own
# creating call succeeded exclusively on it AND the path still carries the identity and the
# exact bytes that call produced. Nothing is inferred from a name or a tag:
#   * leaves   — fs.openSync(abs, "wx"): O_CREAT|O_EXCL|O_WRONLY, defined exclusive-create
#                semantics, EEXIST on any existing name including a dangling symlink, and it
#                never follows a link. dev/ino (fstat on the fd we created) plus size and a
#                sha256 of the bytes written are recorded at that moment.
#   * dirs     — fs.mkdirSync(abs) non-recursive, also exclusive.
#   * parents  — every component from REPO_ROOT down is verified to be a real, non-symlink
#                directory before anything is created under it.
# A failure is never read as EEXIST unless the error code IS EEXIST; any other code refuses
# with that code named. A pre-existing real __pycache__ is used but never recorded, so it is
# never removed. Cleanup unlinks a leaf only when lstat still shows a regular file with the
# recorded dev/ino/size and the content still hashes to the recorded digest; a changed
# identity, changed content, non-regular leaf, or any error leaves the path untouched.
#
# HONEST LIMIT. Verification and unlink are separate calls and are NOT atomic. A malicious
# concurrent process running as this same user can swap a parent or a leaf between them, and
# nothing here prevents that. This test is not that security boundary and claims no immunity;
# what it does claim is bounded — against ordinary pre-existing caches, stale entries and
# symlinked paths it refuses without mutating, and it never truncates. The parent-swap window
# named in r2 is unchanged and remains out of scope.
FIX_FILES="$TMP/created-files"   # one JSON record per exclusively created leaf
FIX_DIRS="$TMP/created-dirs"
: > "$FIX_FILES"
: > "$FIX_DIRS"

t96_cleanup() {
  if [ -s "$FIX_FILES" ]; then
    node -e '
      const fs = require("fs"), crypto = require("crypto"), path = require("path");
      const [root, recs] = process.argv.slice(1);
      for (const line of fs.readFileSync(recs, "utf8").split("\n").filter(Boolean)) {
        let r; try { r = JSON.parse(line); } catch { continue; }
        const abs = path.join(root, r.rel);
        try {
          const st = fs.lstatSync(abs, { bigint: true }); // lstat: a symlink is never followed, and is not a file
          if (!st.isFile() || String(st.dev) !== r.dev || String(st.ino) !== r.ino || Number(st.size) !== r.size) {
            throw new Error("identity changed since creation");
          }
          if (crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") !== r.digest) {
            throw new Error("content changed since creation");
          }
          fs.unlinkSync(abs);
        } catch (e) {
          console.error(`T96 cleanup: leaving ${r.rel} — ${e.code || e.message}; not provably the file this run created`);
        }
      }
    ' "$REPO_ROOT" "$FIX_FILES" || true
  fi
  if [ -s "$FIX_DIRS" ]; then
    # deepest first (longest path first): a child is always longer than its ancestor. Only
    # directories this run's own exclusive mkdir created are listed. rmdir — never rm -rf —
    # so one that acquired any content in the meantime is left exactly as found.
    awk '{ print length($0) "\t" $0 }' "$FIX_DIRS" | sort -rn | cut -f2- | while IFS= read -r d; do
      [ -n "$d" ] || continue
      if [ -L "$REPO_ROOT/$d" ] || [ ! -d "$REPO_ROOT/$d" ]; then
        echo "T96 cleanup: leaving $d — no longer the directory this run created" >&2
        continue
      fi
      rmdir -- "$REPO_ROOT/$d" 2>/dev/null || true
    done
  fi
  rm -rf "$TMP"
  return 0
}
trap t96_cleanup EXIT

# Per-run identity. Collision AVOIDANCE, not proof, and it carries no ownership weight: it
# exists so a stale entry does not fail an otherwise good run. The PID alone is reusable, so
# it is combined with the random component mktemp -d already allocated for $TMP. If a name is
# taken anyway, the run REFUSES rather than assuming the name is its own.
FIX_TAG="t96fixture$$x$(basename -- "$TMP" | tr -cd 'A-Za-z0-9')"

# Every component from REPO_ROOT (already symlink-free: `pwd -P`) down to $1 must be a real
# directory and not a symlink, so nothing is ever created or written through a link.
assert_real_dir_chain() { # $1 = repo-relative directory
  local rel="$1" cur="$REPO_ROOT" rest="$1" comp
  while [ -n "$rest" ]; do
    comp="${rest%%/*}"
    if [ "$comp" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    [ -n "$comp" ] || continue
    cur="$cur/$comp"
    if [ -L "$cur" ]; then
      fail "refusing to use $rel — component $cur is a symlink; this run will not create or write through a link"
    fi
    if [ ! -d "$cur" ]; then
      fail "refusing to use $rel — component $cur is not a directory"
    fi
  done
}

# Prints "created" (ours, recorded) or "existing" (usable, never recorded); exits non-zero
# on anything else, naming the error code rather than assuming the name is merely taken.
fixture_dir() { # $1 = repo-relative directory
  local rel="$1" state
  assert_real_dir_chain "${1%/*}"
  state=$(node -e '
    const fs = require("fs"), path = require("path");
    const [root, rel] = process.argv.slice(1);
    const abs = path.join(root, rel);
    try {
      fs.mkdirSync(abs); // non-recursive: exclusive, fails on any existing name
      console.log("created");
    } catch (e) {
      if (e.code !== "EEXIST") {
        console.error(`T96: mkdir ${rel} failed with ${e.code || e.message} — refusing; this is not evidence the name is merely taken`);
        process.exit(1);
      }
      let st = null; try { st = fs.lstatSync(abs); } catch (e2) { st = null; }
      if (!st || !st.isDirectory()) { // lstat: a symlink-to-directory is NOT a directory here
        console.error(`T96: ${rel} exists and is not a real directory — refusing to write through it`);
        process.exit(1);
      }
      console.log("existing");
    }
  ' "$REPO_ROOT" "$rel") || fail "refusing to place fixtures in $rel — see above"
  if [ "$state" = "created" ]; then
    printf '%s\n' "$rel" >> "$FIX_DIRS"   # success of OUR mkdir is what makes it ours
  fi
}

# Exclusive create via fs.openSync(…, "wx"), recording dev/ino/size/digest of the bytes it
# wrote. The record is emitted only on success and IS the proof of ownership.
fixture_file() { # $1 = repo-relative file
  local rel="$1"
  assert_real_dir_chain "${1%/*}"
  node -e '
    const fs = require("fs"), crypto = require("crypto"), path = require("path");
    const [root, rel, tag] = process.argv.slice(1);
    const abs = path.join(root, rel);
    const body = `T96 generated-bytecode fixture (${tag}) — must never reach the tarball\n`;
    let fd;
    try {
      fd = fs.openSync(abs, "wx", 0o644); // O_CREAT|O_EXCL|O_WRONLY: never follows a symlink
    } catch (e) {
      const why = e.code === "EEXIST" ? "the name is already taken" : "refusing without assuming why";
      console.error(`T96: cannot exclusively create ${rel}: ${e.code || e.message} — ${why}`);
      process.exit(1);
    }
    try {
      const buf = Buffer.from(body, "utf8");
      fs.writeSync(fd, buf);
      const st = fs.fstatSync(fd, { bigint: true }); // identity of the file THIS call created, off its own fd
      fs.closeSync(fd);
      console.log(JSON.stringify({
        rel,
        dev: String(st.dev),
        ino: String(st.ino),
        size: buf.length,
        digest: crypto.createHash("sha256").update(buf).digest("hex"),
      }));
    } catch (e) {
      try { fs.closeSync(fd); } catch (e2) { /* already closed */ }
      console.error(`T96: failed writing ${rel}: ${e.code || e.message}`);
      process.exit(1);
    }
  ' "$REPO_ROOT" "$rel" "$FIX_TAG" >> "$FIX_FILES" \
    || fail "refusing fixture $rel — see above; this run will not truncate or write through a path it does not own"
}

fixture_dir "bin/__pycache__"
fixture_dir "bin/lib/__pycache__"
fixture_dir "bin/init/__pycache__"

# Named after the real 2026-09-26 failure, plus nesting, plus .pyo, plus bytecode that is
# NOT inside a __pycache__ directory (the pre-PEP-3147 layout CPython still honours when
# invoked with a writable cwd and -B unset).
FIX_CACHE_TOP="bin/__pycache__/${FIX_TAG}_current_screen.cpython-312.pyc"
FIX_CACHE_NESTED="bin/lib/__pycache__/${FIX_TAG}_platform.cpython-312.pyc"
FIX_CACHE_NESTED_PYO="bin/init/__pycache__/${FIX_TAG}_manifest.cpython-312.pyo"
FIX_LOOSE_PYC="bin/${FIX_TAG}_legacy.pyc"
FIX_LOOSE_PYO="bin/lib/${FIX_TAG}_legacy.pyo"

for f in "$FIX_CACHE_TOP" "$FIX_CACHE_NESTED" "$FIX_CACHE_NESTED_PYO" "$FIX_LOOSE_PYC" "$FIX_LOOSE_PYO"; do
  fixture_file "$f"
done

# --- A ---------------------------------------------------------------------------------
node --input-type=module -e '
  import { MANIFEST } from "./bin/init/manifest.mjs";
  console.log(MANIFEST.join("\n"));
' > "$TMP/A"
node --input-type=module -e '
  import { GOVERNANCE_ROOTS, TARBALL_EXEMPT } from "./bin/init/manifest.mjs";
  console.log(JSON.stringify({ GOVERNANCE_ROOTS, TARBALL_EXEMPT }));
' > "$TMP/roots.json"

# The fixtures are only evidence if they are on disk at the moment npm walks the tree.
# Assert that here, immediately before the pack, and again immediately after — absence from
# the tarball then means the exclusion held, not that something deleted them first.
for f in "$FIX_CACHE_TOP" "$FIX_CACHE_NESTED" "$FIX_CACHE_NESTED_PYO" "$FIX_LOOSE_PYC" "$FIX_LOOSE_PYO"; do
  [ -f "$REPO_ROOT/$f" ] || fail "generated-cache fixture $f is not on disk before the pack — the exclusion would not be under test"
done

# --- B --- the real bytes npm would publish.
npm pack --dry-run --json 2>"$TMP/pack.err" > "$TMP/pack.json" \
  || { cat "$TMP/pack.err" >&2; fail "npm pack --dry-run failed"; }
node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  console.log(j[0].files.map((f) => f.path).join("\n"));
' "$TMP/pack.json" > "$TMP/B"

for f in "$FIX_CACHE_TOP" "$FIX_CACHE_NESTED" "$FIX_CACHE_NESTED_PYO" "$FIX_LOOSE_PYC" "$FIX_LOOSE_PYO"; do
  [ -f "$REPO_ROOT/$f" ] || fail "generated-cache fixture $f vanished during the pack — its absence from the tarball proves nothing"
done

# --- C --- the tree, over every root any manifest entry lives under.
awk -F/ '{ print (NF>1 ? $1 : $0) }' "$TMP/A" | sort -u > "$TMP/A.roots"
# shellcheck disable=SC2046
git ls-files -- $(tr '\n' ' ' < "$TMP/A.roots") | sort -u > "$TMP/C"

sort -u "$TMP/A" > "$TMP/A.sorted"
sort -u "$TMP/B" > "$TMP/B.sorted"

# --- assertion P: the packing contract for generated Python cache/bytecode ----------------
# Failure caught: a workspace that ran the Python guards before packing publishes bytecode.
# Measured against B — the actual tarball — never against a re-reading of files[] (Rule 39).
# Runs before assertion 2 so the diagnosis is "the exclusion regressed", not the generic
# orphan message that sent run 36267366007 looking at the init manifest.
shipped_fixtures=""
for f in "$FIX_CACHE_TOP" "$FIX_CACHE_NESTED" "$FIX_CACHE_NESTED_PYO" "$FIX_LOOSE_PYC" "$FIX_LOOSE_PYO"; do
  if grep -qxF -- "$f" "$TMP/B.sorted"; then
    shipped_fixtures="$shipped_fixtures  $f"$'\n'
  fi
done
[ -z "$shipped_fixtures" ] \
  || fail $'assertion P — generated Python cache/bytecode present at pack time reached the tarball:\n'"$shipped_fixtures"

# Same contract, stated over the whole tarball rather than the fixtures: no __pycache__
# segment anywhere, no .pyc/.pyo anywhere. Catches a real cache the fixtures did not model.
stray_bytecode=$(grep -E '(^|/)__pycache__(/|$)|\.py[co]$' "$TMP/B.sorted" || true)
[ -z "$stray_bytecode" ] \
  || fail $'assertion P — generated Python cache/bytecode in the tarball:\n'"$stray_bytecode"

# ...and the exclusion must not have taken the sources with it. Every .py the init manifest
# names has to still ship. Derived from A, so it cannot go vacuous silently.
py_sources=$(grep '\.py$' "$TMP/A.sorted" || true)
[ -n "$py_sources" ] || fail "assertion P — the init manifest names no .py files; the source-preservation check would be vacuous"
missing_py=$(printf '%s\n' "$py_sources" | comm -23 - "$TMP/B.sorted")
[ -z "$missing_py" ] \
  || fail $'assertion P — the bytecode exclusion also dropped Python SOURCE from the tarball:\n'"$missing_py"

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
