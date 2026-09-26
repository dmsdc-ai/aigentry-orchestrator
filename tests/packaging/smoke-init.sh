#!/usr/bin/env bash
# smoke-init.sh — THE acceptance test for `aigentry-orchestrator init`
# (SPEC 2026-08-15-npm-init-environment §7.1).
#
# Hermetic: builds the REAL tarball, installs it globally into a throwaway npm prefix, and
# runs init with HOME pointed at a fresh private child under a secure parent. It never
# touches the live daemon or existing HOME contents, ~/.aigentry or ~/.telepty. Network
# use is limited to npm resolving this
# package's three declared dependencies — the tarball itself is built here, not downloaded.
#
# What a green run does NOT prove is enumerated in §7.2 and summarised at the end of this
# file. Read it before quoting this test as evidence of anything wider.
#
# Test seam: SMOKE_PLANT_TOKEN=<workspace-relative-path> plants an unsubstituted template
# token into the finished workspace and expects assertion (e) to CATCH it — the RED proof
# that the substitution assertion is load-bearing. Used by the implementation dispatch;
# never set in normal runs.
# SMOKE_TEST_ROOT optionally selects an existing canonical, owned secure parent.
# SMOKE_PLANT_OWNER_PATH=1 plants an unrelated owner path for assertion (f) to reject.
set -euo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd -P)"

pass=0
fail() { echo "FAIL: smoke-init — $*" >&2; exit 1; }
ok() { pass=$((pass + 1)); echo "  ok ($1) $2"; }

[ -n "${HOME:-}" ] || fail "HOME is unset"
REAL_HOME="$HOME"

# Use the host Node only to provision/verify the fixture; installed env-node commands
# use a byte-identical private copy. No existing directory or executable is chmodded.
# Identity checks require a quiescent owner, as do the native-capture fixtures.
HOST_NODE="$(command -v node)" || fail "node is required"
umask 077
fixture() {
  "$HOST_NODE" -e '
const fs = require("node:fs"), path = require("node:path");
const { createHash } = require("node:crypto");
const [action, realHome, repo, run, receipt] = process.argv.slice(1);
const requireSafe = (ok, why) => { if (!ok) throw new Error(why); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stat = file => fs.lstatSync(file, { bigint: true });
const id = s => ({ dev: String(s.dev), ino: String(s.ino), uid: Number(s.uid),
  gid: Number(s.gid), mode: Number(s.mode) & 0o7777 });
const imageId = s => ({ ...id(s), nlink: String(s.nlink), size: String(s.size),
  mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function ancestry(dir) {
  requireSafe(path.isAbsolute(dir) && path.normalize(dir) === dir &&
    !/[\x00-\x1f\x7f]/.test(dir) && (dir === "/" || !dir.endsWith("/")), "invalid canonical path");
  const chain = [];
  for (let p = dir; ; p = path.dirname(p)) {
    const s = stat(p);
    requireSafe(s.isDirectory() && !s.isSymbolicLink() &&
      (s.uid === 0n || s.uid === BigInt(process.getuid())) && (Number(s.mode) & 0o022) === 0,
    `unsafe fixture ancestor: ${p}`);
    let git;
    try { git = fs.lstatSync(path.join(p, ".git")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    requireSafe(!git, `fixture must be outside a project: ${p}`);
    chain.push({ path: p, ...id(s) });
    if (p === path.dirname(p)) break;
  }
  requireSafe(fs.realpathSync.native(dir) === dir, "fixture location changed");
  return chain;
}
const within = (a, b) => {
  a = a.normalize("NFC").toLowerCase(); b = b.normalize("NFC").toLowerCase();
  return a === b || a.startsWith(`${b}/`);
};
function allowed(parent, child) {
  const home = fs.realpathSync.native(realHome);
  requireSafe(parent !== "/", "filesystem root is not a private parent");
  for (const root of [repo, path.join(home, ".aigentry"), path.join(home, ".telepty")]) {
    const aliases = [root];
    try { aliases.push(fs.realpathSync.native(root)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const alias of aliases) {
      requireSafe(!within(parent, alias), `refusing project/live parent: ${alias}`);
      if (child) requireSafe(!within(child, alias) && !within(alias, child), "fixture overlaps project/live root");
    }
  }
  if (child) requireSafe(path.dirname(child) === parent && !within(home, child) &&
    /^smoke-init-[A-Za-z0-9]+$/.test(path.basename(child)), "not a fresh HOME-safe child");
}
function executable(file) {
  const s = stat(file);
  requireSafe(s.isFile() && !s.isSymbolicLink(), "Node must be a regular file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    requireSafe(equal(imageId(s), imageId(fs.fstatSync(fd, { bigint: true }))), "Node changed during open");
    const hash = sha(fs.readFileSync(fd));
    requireSafe(equal(imageId(s), imageId(fs.fstatSync(fd, { bigint: true }))) &&
      equal(imageId(s), imageId(stat(file))), "Node changed during read");
    return { path: file, ...imageId(s), hash };
  } finally { fs.closeSync(fd); }
}
let created;
try {
  requireSafe(["linux", "darwin"].includes(process.platform), "POSIX smoke supports Linux/macOS only");
  if (action === "create") {
    const parent = process.env.SMOKE_TEST_ROOT ?? fs.realpathSync.native(realHome);
    const parents = ancestry(parent);
    requireSafe(parents[0].uid === process.getuid(), "fixture parent must be owned by this user");
    allowed(parent);
    const source = executable(fs.realpathSync.native(process.execPath));
    requireSafe(equal(ancestry(parent), parents), "fixture parent changed before creation");
    created = fs.mkdtempSync(path.join(parent, "smoke-init-"));
    console.error(`Smoke fixture/evidence: ${created}`);
    allowed(parent, created);
    const root = ancestry(created);
    requireSafe(root[0].uid === process.getuid() && root[0].mode === 0o700 &&
      equal(root.slice(1), parents), "fresh fixture identity/ownership refused");
    for (const name of ["home", "npm", "npm-cache", "tmp", "runtime"])
      fs.mkdirSync(path.join(created, name), { mode: 0o700 });
    const node = path.join(created, "runtime", "node");
    requireSafe(equal(executable(source.path), source), "source Node changed before copy");
    fs.copyFileSync(source.path, node, fs.constants.COPYFILE_EXCL);
    const copied = stat(node);
    requireSafe(copied.isFile() && !copied.isSymbolicLink() && copied.nlink === 1n &&
      copied.uid === BigInt(process.getuid()) &&
      (String(copied.dev) !== source.dev || String(copied.ino) !== source.ino), "unsafe Node copy identity");
    const fd = fs.openSync(node, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      requireSafe(equal(imageId(copied), imageId(fs.fstatSync(fd, { bigint: true }))), "Node copy changed before chmod");
      fs.fchmodSync(fd, 0o700);
    } finally { fs.closeSync(fd); }
    const runtime = executable(node), runtimeParents = ancestry(path.dirname(node));
    requireSafe(runtime.hash === source.hash && runtime.mode === 0o700 && runtime.nlink === "1" &&
      runtime.uid === process.getuid() && runtime.dev === String(copied.dev) &&
      runtime.ino === String(copied.ino) && equal(executable(source.path), source), "Node copy/source verification failed");
    requireSafe(equal(ancestry(created), root), "fixture changed during provisioning");
    const baseline = { root, source, runtime, runtimeParents };
    fs.writeFileSync(path.join(created, "fixture.json"), JSON.stringify(baseline, null, 2), { flag: "wx", mode: 0o600 });
    process.stdout.write(`${created}\n${JSON.stringify(baseline)}\n`);
  } else {
    const baseline = JSON.parse(receipt);
    allowed(path.dirname(run), run);
    requireSafe(baseline.root[0].path === run && baseline.root[0].uid === process.getuid() &&
      baseline.root[0].mode === 0o700 && equal(ancestry(run), baseline.root), "fixture ownership/identity changed");
    requireSafe(equal(ancestry(path.dirname(baseline.runtime.path)), baseline.runtimeParents) &&
      equal(executable(baseline.runtime.path), baseline.runtime) &&
      equal(executable(baseline.source.path), baseline.source), "Node ownership/identity changed");
    if (action === "cleanup") fs.rmSync(run, { recursive: true });
    else requireSafe(action === "verify", "unknown fixture action");
  }
} catch (error) {
  console.error(`Fixture refused: ${error.message}`);
  if (created || run) console.error(`Evidence retained: ${created || run}`);
  process.exitCode = 1;
}
' "$1" "$REAL_HOME" "$REPO_ROOT" "${TMP:-}" "${FIXTURE_ID:-}"
}
FIXTURE="$(fixture create)" || fail "secure fixture provisioning failed (see retained location above)"
TMP="${FIXTURE%%$'\n'*}"
FIXTURE_ID="${FIXTURE#*$'\n'}"
COMPLETE=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -eq 0 ] && [ "$COMPLETE" -eq 1 ]; then
    fixture cleanup || { echo "Evidence retained: $TMP" >&2; exit 1; }
  else
    echo "Evidence retained: $TMP" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fixture verify || fail "fixture ownership verification failed"
export HOME="$TMP/home"
export AIGENTRY_HOME="$HOME/.aigentry"
export npm_config_cache="$TMP/npm-cache"
export npm_config_prefix="$TMP/npm"
export TMPDIR="$TMP/tmp"
export PATH="$TMP/runtime:$PATH"
CONTROL="$TMP/control"
PREFIX="$TMP/npm"

echo "==> 1. build + pack the real tarball"
cd "$REPO_ROOT"
npm run build >"$TMP/build.log" 2>&1 || fail "npm run build failed"
( cd "$TMP" && npm pack --json "$REPO_ROOT" 2>"$TMP/pack.log" > "$TMP/pack.json" ) || fail "npm pack failed"
TARBALL="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0].filename)' "$TMP/pack.json")"
[ -f "$TMP/$TARBALL" ] || fail "npm pack produced no tarball"
echo "    $TARBALL ($(wc -c < "$TMP/$TARBALL" | tr -d ' ') bytes)"

echo "==> 2. throwaway HOME + npm prefix"
echo "    HOME=$HOME, prefix=$PREFIX, cache=$npm_config_cache"

echo "==> 3. global install from the tarball"
npm i -g --prefix "$PREFIX" --no-audit --no-fund "$TMP/$TARBALL" >"$TMP/install.log" 2>&1 \
  || { tail -30 "$TMP/install.log" >&2; fail "global install failed"; }
PKG_DIR="$PREFIX/lib/node_modules/@dmsdc-ai/aigentry-orchestrator"
[ -d "$PKG_DIR" ] || fail "installed package not found at $PKG_DIR"

echo "==> 4. init"
set +e
PATH="$TMP/runtime:$PREFIX/bin:$PATH" "$PREFIX/bin/aigentry-orchestrator" init --yes --workspace "$CONTROL" \
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
  import { pathToFileURL } from "node:url";
  const { MANIFEST, isExecutable } = await import(pathToFileURL(process.argv[2]).href);
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
' "$CONTROL" "$PKG_DIR/bin/init/manifest.mjs" > "$TMP/manifest-count" || fail "(b) manifest did not land intact — see above"
ok b "all $(cat "$TMP/manifest-count") manifest paths present, bin/** executable"

# (c) counts. The bin/** expectation is DERIVED from the installed manifest rather than the
#     literal 35 of §7.1: the tree carried 36 at 02135be (bin/telepty-bus-bridge.sh landed in
#     9434a41, after the spec was measured) plus bin/init/{cli,manifest}.mjs = 38. T96 is what
#     pins the manifest to `git ls-files bin`, so deriving here chains tree -> manifest ->
#     workspace instead of freezing a number that was already stale when it was written.
EXPECT_BIN=$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { MANIFEST } = await import(pathToFileURL(process.argv[1]).href);
  console.log(MANIFEST.filter((p) => p.startsWith("bin/")).length);
' "$PKG_DIR/bin/init/manifest.mjs")
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
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [root, rel] = process.argv.slice(1), file = path.resolve(root, rel);
    if (path.isAbsolute(rel) || !file.startsWith(root + "/") ||
      fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error("unsafe token seam path");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND |
      fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid()) throw new Error("unsafe token seam file");
      fs.writeFileSync(fd, "\n{{CONSTITUTION_PATH}}\n");
    } finally { fs.closeSync(fd); }
  ' "$CONTROL" "$SMOKE_PLANT_TOKEN" || fail "unsafe token seam target"
fi
#     Exempt, per manifest.isSubstitutionExempt: bin/init/** is the substitution engine and
#     config.template.json is the template it reads — in both, the token strings ARE the
#     content. Rewriting them corrupts the mechanism, so they are excluded here too.
TOKENS=$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { TEMPLATE_TOKENS } = await import(pathToFileURL(process.argv[1]).href);
  console.log(TEMPLATE_TOKENS.join("|"));
' "$PKG_DIR/bin/init/manifest.mjs")
SURVIVORS=$(grep -rlE "$TOKENS" "$CONTROL" "$HOME/.aigentry" 2>/dev/null \
  | grep -v "/bin/init/" | grep -v "/config.template.json$" || true)
[ -z "$SURVIVORS" ] || fail $'(e) unsubstituted init template tokens survive in:\n'"$SURVIVORS"
ok e "0 init template tokens survive in the workspace or ~/.aigentry (engine + template exempt)"

# (f) no owner-machine path escaped into the install.
#     Init now legitimately embeds the fresh private fixture below a maintainer HOME.
#     Exempt only that verified prefix, with path boundaries and no traversal; an
#     unrelated owner path on the SAME line must still fail. Never exempt HOME itself.
fixture verify || fail "(f) fixture identity changed before owner-path assertion"
node - "$TMP" "$CONTROL" "$HOME/.aigentry" <<'NODE' || fail "(f) owner absolute paths present (see above)"
const fs = require("node:fs"), path = require("node:path");
const [fixture, ...roots] = process.argv.slice(2);
if (process.env.SMOKE_PLANT_OWNER_PATH) {
  console.error("    (seam) planting an unrelated owner path — assertion (f) must catch it");
  fs.writeFileSync(path.join(roots[0], ".smoke-owner-leak-negative"),
    `${fixture}/control /Users/duckyoungkim/smoke-owner-leak-negative/secret\n`,
    { flag: "wx", mode: 0o600 });
}
function scrubFixture(text) {
  return text.split(fixture).map((part, index, parts) => {
    if (index === 0) return part;
    const before = parts[index - 1].slice(-1);
    const after = part[0] || "";
    const boundary = c => c === "" || /[\s"'`=,:;()<>\[\]{}]/.test(c);
    const suffix = part.split(/[\s"'`<>]/, 1)[0];
    const traversal = suffix.split("/").some(segment => segment === "." || segment === "..");
    return (boundary(before) && (after === "/" || boundary(after)) && !traversal
      ? "<fresh-smoke-fixture>" : fixture) + part;
  }).join("");
}
let leaks = false;
function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), s = fs.lstatSync(file);
    if (s.isDirectory()) scan(file);
    else if (s.isFile() && scrubFixture(fs.readFileSync(file, "utf8")).includes("/Users/duckyoungkim")) {
      console.error(file); leaks = true;
    }
  }
}
for (const root of roots) scan(root);
if (leaks) process.exit(1);
NODE
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
ok f "0 owner absolute paths outside the verified fixture; exactly 5 accepted citation lines, all in docs/rules.md"

# (g) the §4.2 #1-#3 path fix: tq-status.sh must resolve the queue from its own location.
( cd "$CONTROL" && PATH="$TMP/runtime:$PREFIX/bin:$PATH" bash bin/tq-status.sh >"$TMP/tq.log" 2>&1 ) \
  || { cat "$TMP/tq.log" >&2; fail "(g) bin/tq-status.sh failed against the empty queue"; }
grep -q "Active Focus" "$TMP/tq.log" || fail "(g) tq-status.sh produced no report"
ok g "bin/tq-status.sh exits 0 against the empty queue (path fix holds)"

# (h) bash + python3 wiring
( cd "$CONTROL" && PATH="$TMP/runtime:$PREFIX/bin:$PATH" bash bin/dispatch.sh --help >/dev/null 2>&1 ) \
  || fail "(h) bin/dispatch.sh --help did not exit 0"
ok h "bin/dispatch.sh --help exits 0"

# (i) idempotence: a bare re-run refuses, and changes nothing.
snapshot() { ( cd "$1" && find . -type f -exec shasum {} + | sort ); }
snapshot "$CONTROL" > "$TMP/before"
set +e
PATH="$TMP/runtime:$PREFIX/bin:$PATH" "$PREFIX/bin/aigentry-orchestrator" init --yes --workspace "$CONTROL" \
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
PATH="$TMP/runtime:$PREFIX/bin:$PATH" "$PREFIX/bin/aigentry-orchestrator" init --yes --upgrade --workspace "$CONTROL" \
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
COMPLETE=1
