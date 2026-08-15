#!/usr/bin/env bash
# smoke-init.sh — THE acceptance test for `aigentry-orchestrator init`
# (SPEC 2026-08-15-npm-init-environment §7.1).
#
# Hermetic: builds the REAL tarball, installs it globally into a throwaway npm prefix, and
# runs init with HOME pointed at a throwaway directory. It never touches the live daemon,
# the live $HOME, ~/.aigentry or ~/.telepty. Network use is limited to npm resolving this
# package's three declared dependencies — the tarball itself is built here, not downloaded.
#
# What a green run does NOT prove is enumerated in §7.2 and summarised at the end of this
# file. Read it before quoting this test as evidence of anything wider.
#
# Test seam: SMOKE_PLANT_TOKEN=<workspace-relative-path> plants an unsubstituted template
# token into the finished workspace and expects assertion (e) to CATCH it — the RED proof
# that the substitution assertion is load-bearing. Used by the implementation dispatch;
# never set in normal runs.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"

pass=0
fail() { echo "FAIL: smoke-init — $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "  ok ($1) $2"; }

[ -n "${HOME:-}" ] || fail "HOME is unset"
REAL_HOME="$HOME"

TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Guard the guard: everything below writes under $TMP, and $TMP must never be the real HOME.
case "$TMP" in "$REAL_HOME"|"$REAL_HOME"/*) fail "refusing to run: mktemp handed back a path inside the real HOME ($TMP)";; esac

echo "==> 1. build + pack the real tarball"
cd "$REPO_ROOT"
npm run build >/dev/null 2>&1 || fail "npm run build failed"
( cd "$TMP" && npm pack --json "$REPO_ROOT" 2>/dev/null > "$TMP/pack.json" ) || fail "npm pack failed"
TARBALL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0].filename)' "$TMP/pack.json")"
[ -f "$TMP/$TARBALL" ] || fail "npm pack produced no tarball"
echo "    $TARBALL ($(wc -c < "$TMP/$TARBALL" | tr -d ' ') bytes)"

echo "==> 2. throwaway HOME + npm prefix"
export HOME="$TMP/home"
mkdir -p "$HOME"
CONTROL="$TMP/control"
PREFIX="$TMP/npm"

echo "==> 3. global install from the tarball"
npm i -g --prefix "$PREFIX" --no-audit --no-fund "$TMP/$TARBALL" >"$TMP/install.log" 2>&1 \
  || { tail -30 "$TMP/install.log" >&2; fail "global install failed"; }
PKG_DIR="$PREFIX/lib/node_modules/@dmsdc-ai/aigentry-orchestrator"
[ -d "$PKG_DIR" ] || fail "installed package not found at $PKG_DIR"

echo "==> 4. init"
set +e
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/aigentry-orchestrator" init --yes --workspace "$CONTROL" \
  >"$TMP/init.log" 2>&1
INIT_RC=$?
set -e
sed 's/^/    | /' "$TMP/init.log"

echo "==> 5. assertions"

# (a) exit 0
[ "$INIT_RC" -eq 0 ] || fail "(a) init exited $INIT_RC, expected 0"
ok a "init exited 0"

# (b) every manifest path landed, and bin/** kept its executable bit
node --input-type=module -e '
  import { MANIFEST, isExecutable } from "'"$PKG_DIR"'/bin/init/manifest.mjs";
  import fs from "node:fs";
  import path from "node:path";
  const ws = process.argv[1];
  const missing = [], notExec = [];
  for (const rel of MANIFEST) {
    const p = path.join(ws, rel);
    if (!fs.existsSync(p)) { missing.push(rel); continue; }
    if (isExecutable(rel) && !(fs.statSync(p).mode & 0o111)) notExec.push(rel);
  }
  if (missing.length) { console.error("missing from workspace:\n  " + missing.join("\n  ")); process.exit(1); }
  if (notExec.length) { console.error("not executable:\n  " + notExec.join("\n  ")); process.exit(1); }
  console.log(MANIFEST.length);
' "$CONTROL" > "$TMP/manifest-count" || fail "(b) manifest did not land intact — see above"
ok b "all $(cat "$TMP/manifest-count") manifest paths present, bin/** executable"

# (c) counts. The bin/** expectation is DERIVED from the installed manifest rather than the
#     literal 35 of §7.1: the tree carried 36 at 02135be (bin/telepty-bus-bridge.sh landed in
#     9434a41, after the spec was measured) plus bin/init/{cli,manifest}.mjs = 38. T96 is what
#     pins the manifest to `git ls-files bin`, so deriving here chains tree -> manifest ->
#     workspace instead of freezing a number that was already stale when it was written.
EXPECT_BIN=$(node --input-type=module -e '
  import { MANIFEST } from "'"$PKG_DIR"'/bin/init/manifest.mjs";
  console.log(MANIFEST.filter((p) => p.startsWith("bin/")).length);
')
GOT_BIN=$(find "$CONTROL/bin" -type f | wc -l | tr -d ' ')
[ "$GOT_BIN" = "$EXPECT_BIN" ] || fail "(c) workspace has $GOT_BIN bin/ files, manifest promises $EXPECT_BIN"
GOT_ROLES=$(find "$HOME/.aigentry/instructions/roles" -name '*.md' | wc -l | tr -d ' ')
[ "$GOT_ROLES" = "9" ] || fail "(c) ~/.aigentry/instructions/roles has $GOT_ROLES files, expected 9"
ok c "bin/** = $GOT_BIN (manifest-derived), instructions/roles = 9"

# (d) the empty queue seed parses and is empty
node -e '
  const q = require(process.argv[1]);
  if (!Array.isArray(q.tasks) || q.tasks.length !== 0) { console.error("tasks is not []: " + JSON.stringify(q.tasks)); process.exit(1); }
  if (q.active_focus !== null) { console.error("active_focus is not null"); process.exit(1); }
' "$CONTROL/state/task-queue.json" || fail "(d) state/task-queue.json is not an empty seed"
ok d "state/task-queue.json parses, tasks == [], active_focus == null"

# (e) substitution completed.
#     Scoped to the four INIT template tokens of §4.2, NOT to any "{{" as §7.1 phrased it:
#     the shipping set deliberately carries runtime placeholders that must survive init
#     untouched — {{ORCHESTRATOR_REPORT_TARGET}} is substituted by bin/dispatch.sh at inject
#     time (#690) and tooling/dispatch-prelude/template.md is a dispatch template by design.
#     Measured: 9 shipped files carry such tokens. A bare '{{' grep would fail on all of them.
if [ -n "${SMOKE_PLANT_TOKEN:-}" ]; then
  echo "    (seam) planting {{CONSTITUTION_PATH}} into $SMOKE_PLANT_TOKEN — assertion (e) must catch it"
  printf '\n{{CONSTITUTION_PATH}}\n' >> "$CONTROL/$SMOKE_PLANT_TOKEN"
fi
#     Exempt, per manifest.isSubstitutionExempt: bin/init/** is the substitution engine and
#     config.template.json is the template it reads — in both, the token strings ARE the
#     content. Rewriting them corrupts the mechanism, so they are excluded here too.
TOKENS=$(node --input-type=module -e '
  import { TEMPLATE_TOKENS } from "'"$PKG_DIR"'/bin/init/manifest.mjs";
  console.log(TEMPLATE_TOKENS.join("|"));
')
SURVIVORS=$(grep -rlE "$TOKENS" "$CONTROL" "$HOME/.aigentry" 2>/dev/null \
  | grep -v "/bin/init/" | grep -v "/config.template.json$" || true)
[ -z "$SURVIVORS" ] || fail $'(e) unsubstituted init template tokens survive in:\n'"$SURVIVORS"
ok e "0 init template tokens survive in the workspace or ~/.aigentry (engine + template exempt)"

# (f) no owner-machine path escaped into the install.
OWNER_ABS=$(grep -rl "/Users/duckyoungkim" "$CONTROL" "$HOME/.aigentry" 2>/dev/null || true)
[ -z "$OWNER_ABS" ] || fail $'(f) owner absolute paths present in:\n'"$OWNER_ABS"
#     §4.2 #10/#11 accept 5 rule-provenance citation lines of the form
#     ~/.claude/projects/-Users-duckyoungkim-.../memory/*.md as inert and already public.
#     Asserted by EXACT COUNT, not absence: a 6th would be a new disclosure.
CITATION_FORM="-Users-duckyoungkim-"
CITATIONS=$(grep -c -- "$CITATION_FORM" "$CONTROL/docs/rules.md" || true)
[ "$CITATIONS" = "5" ] || fail "(f) docs/rules.md carries $CITATIONS owner citation lines, §4.2 #10 accepted exactly 5"
ELSEWHERE=$(grep -rl -- "$CITATION_FORM" "$CONTROL" "$HOME/.aigentry" 2>/dev/null | grep -v "docs/rules.md" || true)
[ -z "$ELSEWHERE" ] || fail $'(f) owner-home citations outside the accepted docs/rules.md lines:\n'"$ELSEWHERE"
#     Deliberately NOT a bare "duckyoungkim" grep. ~/.aigentry/config.json legitimately holds
#     deviceId = device-$(hostname) (§4.2 #13), which on THIS machine contains the owner's
#     name — a value computed from the user's own host at init time, not shipped bytes. A
#     bare-name grep would flag every user whose hostname contains their name.
ok f "0 owner absolute paths; exactly 5 accepted citation lines, all in docs/rules.md"

# (g) the §4.2 #1-#3 path fix: tq-status.sh must resolve the queue from its own location.
( cd "$CONTROL" && PATH="$PREFIX/bin:$PATH" bash bin/tq-status.sh >"$TMP/tq.log" 2>&1 ) \
  || { cat "$TMP/tq.log" >&2; fail "(g) bin/tq-status.sh failed against the empty queue"; }
grep -q "Active Focus" "$TMP/tq.log" || fail "(g) tq-status.sh produced no report"
ok g "bin/tq-status.sh exits 0 against the empty queue (path fix holds)"

# (h) bash + python3 wiring
( cd "$CONTROL" && PATH="$PREFIX/bin:$PATH" bash bin/dispatch.sh --help >/dev/null 2>&1 ) \
  || fail "(h) bin/dispatch.sh --help did not exit 0"
ok h "bin/dispatch.sh --help exits 0"

# (i) idempotence: a bare re-run refuses, and changes nothing.
snapshot() { find "$1" -type f -exec shasum {} + | sed "s|$1||" | sort; }
snapshot "$CONTROL" > "$TMP/before"
set +e
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/aigentry-orchestrator" init --yes --workspace "$CONTROL" \
  >"$TMP/reinit.log" 2>&1
RC=$?
set -e
[ "$RC" -eq 4 ] || { tail -5 "$TMP/reinit.log" >&2; fail "(i) bare re-init exited $RC, expected 4"; }
snapshot "$CONTROL" > "$TMP/after"
diff -q "$TMP/before" "$TMP/after" >/dev/null || { diff "$TMP/before" "$TMP/after" >&2; fail "(i) bare re-init modified the workspace"; }
ok i "bare re-init exits 4 and the workspace is byte-identical"

# (j) --upgrade succeeds and never touches state/
QUEUE="$CONTROL/state/task-queue.json"
Q_BEFORE=$(shasum "$QUEUE" | cut -d' ' -f1)
M_BEFORE=$(perl -e 'print((stat($ARGV[0]))[9])' "$QUEUE")
set +e
PATH="$PREFIX/bin:$PATH" "$PREFIX/bin/aigentry-orchestrator" init --yes --upgrade --workspace "$CONTROL" \
  >"$TMP/upgrade.log" 2>&1
RC=$?
set -e
[ "$RC" -eq 0 ] || { tail -20 "$TMP/upgrade.log" >&2; fail "(j) --upgrade exited $RC, expected 0"; }
Q_AFTER=$(shasum "$QUEUE" | cut -d' ' -f1)
M_AFTER=$(perl -e 'print((stat($ARGV[0]))[9])' "$QUEUE")
[ "$Q_BEFORE" = "$Q_AFTER" ] || fail "(j) --upgrade rewrote state/task-queue.json"
[ "$M_BEFORE" = "$M_AFTER" ] || fail "(j) --upgrade changed state/task-queue.json mtime"
grep -q "state/ skipped entirely" "$TMP/upgrade.log" || fail "(j) --upgrade did not announce that state/ was skipped"
ok j "--upgrade exits 0; state/task-queue.json untouched (content + mtime)"

echo
echo "PASS: smoke-init — $pass/10 assertions, hermetic (HOME=$HOME, prefix=$PREFIX)"
echo "NOT measured by this run (§7.2): that claude boots as an orchestrator; anything needing"
echo "the telepty daemon (dispatch, inject, session lifecycle); cmux/terminal adapters (headless"
echo "here); MCP servers; and the correctness of the governance content itself — only that it arrives."
