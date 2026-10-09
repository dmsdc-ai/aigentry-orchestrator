#!/usr/bin/env bash
# T135 (task 1201) — THE BOOT INJECTS THE PREVIOUS ORCHESTRATOR'S CONTEXT, AND NOTHING ELSE MOVES.
#
# Spec: SPEC §6 (boot injection) and §9.3 (this guard). The engine (src/context-handoff/**) has
# its own unit tests under tests/context-handoff/; this file pins what the BOOT does with it:
#
#   A  --dry-run, once per CLI (the owner's "boot dry-run acceptance for each CLI"): the composed
#      handoff appears under `[would-handoff]` naming the newest source, and `[would-exec]` carries
#      exactly that CLI's MEASURED delivery tokens — claude `--append-system-prompt-file
#      <ws>/state/handoff/latest.md`; codex/gemini/grok (delivery owed) none, plus the backstop
#      line. A dry run writes nothing.
#   B  a real boot through the T131 recorder stubs: stdout is still EXACTLY the argv (T131 block
#      R); latest.md / latest.json exist with modes 0600 in a 0700 dir; latest.json's
#      handoff.sha256 is latest.md's sha256; its boot_id is the boot record's; the one stderr
#      line names the source; no handoff text reaches stdout, stderr or the argv (SPEC F4). The
#      shim exec's the token-carrying argv.
#   C  failure injection — an unreadable store, a symlinked transcript, a symlinked state/, and
#      the timeout seam: the boot exits 0 with TODAY'S argv and a `handoff: skipped:*` line.
#   D  AIGENTRY_HANDOFF=off → today's argv byte for byte; =bogus → a warning and the same.
#   E  history=last → the skip line and no tokens; nothing written.
#
# NOTHING HERE TOUCHES A REAL PROCESS, DAEMON OR TRANSCRIPT STORE. HOME is a fixture holding
# synthetic transcripts (tests/fixtures/context-handoff/), every store-root override is unset,
# `ps`, `kill`, `telepty` and `curl` are recorders, the sid is a fixture sid, and the exec
# target is a recorder on a private PATH.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap 't_teardown' EXIT
REPO_ROOT="$(cd "$HERE/../.." && pwd -P)"
fail() { echo "FAIL[T135]: $*" >&2; exit 1; }

# ── the boot fixture: a private copy of the shim and the WHOLE compiled tree ─────────────
# cli.js now imports the engine, whose own imports are its business; copying all of dist/src
# keeps this guard from failing at import on a module list it would have to keep in step.
BOOT_FIXTURE="$T_TMP/boot-fixture"
mkdir -p "$BOOT_FIXTURE/bin/lib" "$BOOT_FIXTURE/dist"
cp "$REPO_ROOT/bin/orchestrator-boot.sh" "$BOOT_FIXTURE/bin/orchestrator-boot.sh"
cp "$REPO_ROOT/bin/lib/node-shim.sh" "$BOOT_FIXTURE/bin/lib/node-shim.sh"
for _d in orchestrator-boot context-handoff; do
  [ -d "$REPO_ROOT/dist/src/$_d" ] \
    || fail "the compiled module is missing — dist/src/$_d (run tsc -p .)"
done
[ -f "$REPO_ROOT/dist/tests/context-handoff/harness.js" ] \
  || fail "the compiled fixture harness is missing — dist/tests/context-handoff/harness.js (run tsc -p .)"
cp -R "$REPO_ROOT/dist/src" "$BOOT_FIXTURE/dist/src"
printf '{"type":"module"}\n' > "$BOOT_FIXTURE/package.json"
AUTH_LOG="$T_TMP/auth.log"
printf 'telepty_auth_token() { printf "auth\\n" >> "%s"; printf "fixture-token-T135"; }\n' "$AUTH_LOG" \
  > "$BOOT_FIXTURE/bin/lib/telepty-auth.sh"
BOOT="$BOOT_FIXTURE/bin/orchestrator-boot.sh"
BOOT_CLI="$BOOT_FIXTURE/dist/src/orchestrator-boot/cli.js"
chmod +x "$BOOT"

# ── hermetic stores: HOME is the fixture; no override may point anywhere real ───────────
FIX_HOME="$T_TMP/home"
mkdir -p "$FIX_HOME"
export HOME="$FIX_HOME" USERPROFILE="$FIX_HOME"
unset CLAUDE_CONFIG_DIR CODEX_HOME GEMINI_CLI_HOME CLAUDE_CODE_SESSION_ID CLAUDE_PID AIGENTRY_TASK_QUEUE AIGENTRY_HANDOFF
# The boot record must be WRITTEN here (block B compares boot_id), so ROOT and sessions exist.
export AIGENTRY_HOME="$T_TMP/aigentry-home"
mkdir -m 700 "$AIGENTRY_HOME" "$AIGENTRY_HOME/sessions"
export AIGENTRY_SHIM_SCRIPT_DIR="$BOOT_FIXTURE/bin" SINGLETON_SELF_PID=9999 TELEPTY_PORT=3848
unset _NODE_SHIM_SH_SOURCED

SID="fixture-t135"
export ORCHESTRATOR_SID="$SID" AIGENTRY_BOOT_PLAN=1 AIGENTRY_BOOT_HISTORY=new

# The control workspace: the cwd the exec inherits. Its realpath is what the engine matches.
WS="$T_TMP/ws"
mkdir -p "$WS/state"
WS="$(cd "$WS" && pwd -P)"
LATEST_MD="$WS/state/handoff/latest.md"

# ── recorders (T131/T134 shapes) ────────────────────────────────────────────
PS_ARGV="$T_TMP/ps-argv.log"; KILL_LOG="$T_TMP/kill.log"; CURL_LOG="$T_TMP/curl.log"
TELEPTY_ARGV="$T_TMP/telepty-argv.log"; EXEC_LOG="$T_TMP/exec.log"
cat > "$STUB_BIN/ps-recorder135.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$PS_ARGV"
EOF
cat > "$STUB_BIN/kill-recorder135.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$KILL_LOG"
EOF
cat > "$STUB_BIN/telepty-recorder135.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TELEPTY_ARGV"
printf '[]'
EOF
cat > "$STUB_BIN/curl-recorder135.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$CURL_LOG"
printf '200'
EOF
EXEC_DIR="$T_TMP/exec-path"; mkdir -p "$EXEC_DIR"
cat > "$EXEC_DIR/telepty" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$EXEC_LOG"
EOF
chmod +x "$STUB_BIN"/*135.sh "$EXEC_DIR/telepty"
export SINGLETON_PS_CMD="$STUB_BIN/ps-recorder135.sh" KILL_CMD="$STUB_BIN/kill-recorder135.sh"
export TELEPTY="$STUB_BIN/telepty-recorder135.sh" CURL="$STUB_BIN/curl-recorder135.sh"
reset() { : > "$PS_ARGV"; : > "$KILL_LOG"; : > "$CURL_LOG"; : > "$TELEPTY_ARGV"; : > "$EXEC_LOG"; : > "$AUTH_LOG"; }
lines() { grep -c . "$1" 2>/dev/null || true; }
assert_inert() {
  [ "$(lines "$KILL_LOG")" = 0 ] || fail "$1: a kill was issued: $(cat "$KILL_LOG")"
  [ "$(lines "$CURL_LOG")" = 0 ] || fail "$1: a registry request was issued: $(cat "$CURL_LOG")"
  [ "$(lines "$EXEC_LOG")" = 0 ] || fail "$1: the exec recorder fired: $(cat "$EXEC_LOG")"
}

# ── planting synthetic transcripts through the compiled fixture harness ─────────────────
HARNESS="$REPO_ROOT/dist/tests/context-handoff/harness.js"
# plant <cli> <minutes> → prints "<session> <file>"
plant() {
  node --input-type=module -e '
    const [harness, cli, minutes, base, home, ws] = process.argv.slice(1);
    const h = await import(new URL("file://" + harness).href);
    const p = h.plant(cli, { base, home, ws }, { last: h.at(Number(minutes)) });
    process.stdout.write(`${p.session} ${p.file}\n`);
  ' "$HARNESS" "$1" "$2" "$T_TMP" "$FIX_HOME" "$WS"
}
read -r OLD_SESSION _ < <(plant claude 10)
read -r NEW_SESSION NEW_FILE < <(plant codex 20)
[ -n "$NEW_SESSION" ] && [ -f "$NEW_FILE" ] || fail "fixture planting failed"
NEW_ID8="${NEW_SESSION:0:8}"
[ -n "$OLD_SESSION" ] || fail "fixture planting failed (claude)"

perm_for() {
  case "$1" in
    claude) echo 'approval=manual' ;;
    codex)  echo 'approval=on-request;sandbox=read-only' ;;
    gemini) echo 'approval=default;sandbox=on' ;;
    grok)   echo 'approval=default;sandbox=strict' ;;
  esac
}
# today's argv for a restrictive new plan, one element per line (T134 block H)
today_argv() {
  printf '%s\n' telepty allow --id "$SID" --auto-restart
  case "$1" in
    claude) printf '%s\n' claude --permission-mode manual ;;
    codex)  printf '%s\n' codex --ask-for-approval on-request --sandbox read-only ;;
    gemini) printf '%s\n' gemini --approval-mode default --sandbox ;;
    grok)   printf '%s\n' grok --permission-mode default --sandbox strict ;;
  esac
}

# ===========================================================================
# A) --dry-run per CLI.
# ===========================================================================
for cli in claude codex gemini grok; do
  reset
  out="$T_TMP/a-$cli.out"; err="$T_TMP/a-$cli.err"
  (cd "$WS" && ORCHESTRATOR_CLI="$cli" AIGENTRY_BOOT_PERMISSION="$(perm_for "$cli")" \
     PATH="$EXEC_DIR:$PATH" bash "$BOOT" --dry-run) >"$out" 2>"$err" \
    || fail "A/$cli: --dry-run exited non-zero; stderr: $(cat "$err")"
  grep -q '^\[would-handoff\] ' "$out" || fail "A/$cli: no [would-handoff] block: $(cat "$out")"
  grep -q "^\[would-handoff\] source: codex session $NEW_SESSION " "$out" \
    || fail "A/$cli: the handoff does not name the newest source (codex $NEW_SESSION): $(grep would-handoff "$out" | head -3)"
  grep -q 'CH-CODEX-REQ-LAST' "$out" || fail "A/$cli: the newest request is not in the handoff"
  grep -q '\[dry-run\] handoff source: .*codex' "$out" || fail "A/$cli: no '[dry-run] handoff source:' line"
  today_argv "$cli" > "$T_TMP/a-expected"
  [ "$cli" = claude ] && printf '%s\n' --append-system-prompt-file "$LATEST_MD" >> "$T_TMP/a-expected"
  sed -n 's/^\[would-exec\] //p' "$out" > "$T_TMP/a-actual"
  diff -u "$T_TMP/a-expected" "$T_TMP/a-actual" || fail "A/$cli: [would-exec] is not exactly the measured delivery"
  if [ "$cli" != claude ]; then
    grep -qF "handoff: $cli delivery unmeasured — backstop only (AGENTS.md)" "$out" "$err" \
      || fail "A/$cli: the owed-delivery backstop line is missing"
  fi
  [ -z "$(ls -A "$WS/state")" ] || fail "A/$cli: a dry run wrote into state/: $(ls -A "$WS/state")"
  assert_inert "A/$cli"
done
echo "T135 A PASS (dry-run per CLI: newest source named, measured delivery only, nothing written)"

# ===========================================================================
# B) A real boot, claude, through the compiled CLI (prints the argv, never execs).
# ===========================================================================
reset
B_OUT="$T_TMP/b.out"; B_ERR="$T_TMP/b.err"
(cd "$WS" && ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual' node "$BOOT_CLI") >"$B_OUT" 2>"$B_ERR" \
  || fail "B: the boot exited non-zero; stderr: $(cat "$B_ERR")"
{ today_argv claude; printf '%s\n' --append-system-prompt-file "$LATEST_MD"; } > "$T_TMP/b.expected"
cmp "$T_TMP/b.expected" "$B_OUT" || fail "B: stdout is not EXACTLY the argv (T131 block R): $(cat "$B_OUT")"
[ -f "$LATEST_MD" ] && [ -f "$WS/state/handoff/latest.json" ] || fail "B: latest.md/latest.json were not written"
node -e '
  const fs = require("node:fs"), path = require("node:path"), { createHash } = require("node:crypto");
  const [dir, recordFile] = process.argv.slice(1);
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  const die = (m) => { console.error(m); process.exit(1); };
  if (mode(dir) !== "700") die(`state/handoff mode ${mode(dir)}, want 700`);
  for (const f of ["latest.md", "latest.json"]) if (mode(path.join(dir, f)) !== "600") die(`${f} mode ${mode(path.join(dir, f))}, want 600`);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8"));
  const sha = createHash("sha256").update(fs.readFileSync(path.join(dir, "latest.md"))).digest("hex");
  if (rec.handoff.sha256 !== sha) die(`latest.json handoff.sha256 ${rec.handoff.sha256} != sha256(latest.md) ${sha}`);
  if (rec.outcome !== "written") die(`outcome ${rec.outcome}`);
  const boot = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  if (rec.boot_id !== boot.boot_id) die(`handoff boot_id ${rec.boot_id} != boot record boot_id ${boot.boot_id}`);
' "$WS/state/handoff" "$AIGENTRY_HOME/sessions/$SID/controller/boot-record.json" || fail "B: latest.{md,json} / boot record check"
[ "$(grep -c '^\[orchestrator-boot\] handoff: ' "$B_ERR")" -ge 1 ] || fail "B: no handoff stderr line: $(cat "$B_ERR")"
grep -qE "^\[orchestrator-boot\] handoff: written source=codex:$NEW_ID8 last=[^ ]+ bytes=[0-9]+ delivery=" "$B_ERR" \
  || fail "B: the stderr line is not the fixed vocabulary (SPEC §6.4): $(grep 'handoff:' "$B_ERR")"
grep -q 'boot record: written' "$B_ERR" || fail "B: the boot record was not written, so boot_id sharing is unmeasured: $(cat "$B_ERR")"
# SPEC F4: content never reaches argv, the exec log line, or anything else ps or a log can see.
grep -q 'CH-CODEX' "$B_OUT" "$B_ERR" && fail "B: handoff content leaked to stdout/stderr"
assert_inert "B"
# Through the SHIM: the process that replaces the shell carries the pointer tokens.
reset
(cd "$WS" && ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual' PATH="$EXEC_DIR:$PATH" bash "$BOOT") >/dev/null 2>"$T_TMP/b2.err" \
  || fail "B: the shim boot failed: $(cat "$T_TMP/b2.err")"
tail -n +2 "$T_TMP/b.expected" > "$T_TMP/b2.expected"
diff -u "$T_TMP/b2.expected" "$EXEC_LOG" || fail "B: the exec'd argv is not the token-carrying argv"
echo "T135 B PASS (exact argv, private files, sha and boot_id agree, content never in argv or logs)"

# ===========================================================================
# C) FAILURE INJECTION — each boots with today's argv and a skipped:* line, exit 0.
# ===========================================================================
c_boot() { # c_boot <label> <workspace> [env assignments…]
  local label="$1" ws="$2"; shift 2
  reset
  local out="$T_TMP/c.out" err="$T_TMP/c.err"
  (cd "$ws" && env ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual' "$@" node "$BOOT_CLI") >"$out" 2>"$err" \
    || fail "C/$label: the boot exited non-zero — a handoff failure must never block the boot; stderr: $(cat "$err")"
  today_argv claude > "$T_TMP/c.expected"
  cmp "$T_TMP/c.expected" "$out" || fail "C/$label: stdout is not today's argv: $(cat "$out")"
  grep -qE '^\[orchestrator-boot\] handoff: skipped:' "$err" || fail "C/$label: no 'handoff: skipped:*' line: $(cat "$err")"
  assert_inert "C/$label"
}
rm -rf "$WS/state/handoff"
NEW_REAL="$T_TMP/codex-real.jsonl"

# C1 an unreadable store (both stores that hold a transcript). Root reads anything: not measurable.
if [ "$(id -u)" != 0 ]; then
  chmod 000 "$FIX_HOME/.codex" "$FIX_HOME/.claude"
  c_boot unreadable-store "$WS"
  chmod 700 "$FIX_HOME/.codex" "$FIX_HOME/.claude"
else
  echo "T135 C1 NOTRUN: running as root, so chmod 000 cannot make a store unreadable"
fi

# C2 the only transcripts are symlinks — never followed (O_NOFOLLOW).
CLAUDE_FILE="$(find "$FIX_HOME/.claude/projects" -name "$OLD_SESSION.jsonl")"
mv "$NEW_FILE" "$NEW_REAL"; ln -s "$NEW_REAL" "$NEW_FILE"
mv "$CLAUDE_FILE" "$T_TMP/claude-real.jsonl"; ln -s "$T_TMP/claude-real.jsonl" "$CLAUDE_FILE"
c_boot symlinked-transcript "$WS"
rm "$NEW_FILE" "$CLAUDE_FILE"; mv "$NEW_REAL" "$NEW_FILE"; mv "$T_TMP/claude-real.jsonl" "$CLAUDE_FILE"

# C3 a state/ that is a symlink — nothing may be written through it.
WS2="$T_TMP/ws-symlinked-state"; ELSEWHERE="$T_TMP/elsewhere"
mkdir -p "$WS2" "$ELSEWHERE"; ln -s "$ELSEWHERE" "$WS2/state"
c_boot symlinked-state "$WS2"
[ -z "$(ls -A "$ELSEWHERE")" ] || fail "C/symlinked-state: something was written through the symlink: $(ls -A "$ELSEWHERE")"

# C4 the timeout seam. SPEC §9.3 names "the timeout seam" but not its variable; coder B owns
# it. Set HANDOFF_TIMEOUT_SEAM to the NAME=VALUE that makes the step exceed its budget.
HANDOFF_TIMEOUT_SEAM="${HANDOFF_TIMEOUT_SEAM:-}"
if [ -n "$HANDOFF_TIMEOUT_SEAM" ]; then
  c_boot timeout "$WS" "$HANDOFF_TIMEOUT_SEAM"
  grep -qE '^\[orchestrator-boot\] handoff: skipped:timeout' "$T_TMP/c.err" || fail "C/timeout: outcome is not skipped:timeout: $(cat "$T_TMP/c.err")"
else
  echo "T135 C4 NOTRUN: the timeout seam's variable is coder B's and was not supplied (HANDOFF_TIMEOUT_SEAM)"
fi
[ ! -e "$WS/state/handoff" ] || fail "C: a failed handoff left state/handoff behind"
echo "T135 C PASS (unreadable store, symlinked transcript, symlinked state/: exit 0, today's argv, skipped:*)"

# ===========================================================================
# D) AIGENTRY_HANDOFF=off → today's argv byte for byte; =bogus → a warning and the same.
# ===========================================================================
for mode in off bogus; do
  reset
  (cd "$WS" && AIGENTRY_HANDOFF="$mode" ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual' node "$BOOT_CLI") \
    >"$T_TMP/d.out" 2>"$T_TMP/d.err" || fail "D/$mode: exited non-zero: $(cat "$T_TMP/d.err")"
  today_argv claude > "$T_TMP/d.expected"
  cmp "$T_TMP/d.expected" "$T_TMP/d.out" || fail "D/$mode: stdout is not today's argv"
  [ ! -e "$WS/state/handoff" ] || fail "D/$mode: the handoff ran anyway"
  if [ "$mode" = bogus ]; then
    grep -q 'AIGENTRY_HANDOFF' "$T_TMP/d.err" || fail "D/bogus: no warning naming AIGENTRY_HANDOFF: $(cat "$T_TMP/d.err")"
  fi
  assert_inert "D/$mode"
done
echo "T135 D PASS (off and bogus give today's argv)"

# ===========================================================================
# E) history=last → native resume; the handoff is skipped and contributes no token.
# ===========================================================================
reset
(cd "$WS" && AIGENTRY_BOOT_HISTORY=last ORCHESTRATOR_CLI=claude AIGENTRY_BOOT_PERMISSION='approval=manual' node "$BOOT_CLI") \
  >"$T_TMP/e.out" 2>"$T_TMP/e.err" || fail "E: exited non-zero: $(cat "$T_TMP/e.err")"
{ today_argv claude; printf '%s\n' --continue; } > "$T_TMP/e.expected"
cmp "$T_TMP/e.expected" "$T_TMP/e.out" || fail "E: history=last argv changed: $(cat "$T_TMP/e.out")"
grep -qF 'handoff: skipped — native resume chosen' "$T_TMP/e.err" || fail "E: no skip line: $(cat "$T_TMP/e.err")"
[ ! -e "$WS/state/handoff" ] || fail "E: a handoff was written on a resume"
assert_inert "E"
echo "T135 E PASS (history=last skips the handoff)"

echo "T135 PASS blocks=A-E"
