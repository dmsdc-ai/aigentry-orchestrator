#!/usr/bin/env bash
# Runner for the dispatch guard suite.
#
# #900 — before this, the runner counted pass/fail only. A guard that skipped exited 0
# and was counted as a pass, so "96 passed, 0 failed" was compatible with any number of
# those 96 having measured nothing at all. Silent skips are this ecosystem's defect
# class, so the runner now counts skips and holds the SET of skipping guards against the
# per-OS declaration below. A guard that starts skipping fails the run; so does a
# declared skip that stopped happening, because a stale declaration is how a silenced
# test stays silenced.
#
# RUN `tsc -p .` FIRST. In a fresh worktree (no dist/) this suite reports 93 passed /
# 4 failed / skip-set "T16 T47 T48 T95" and the skip assertion below fires as a
# SKIP-SET MISMATCH. None of it is a code defect: T17/T18/T24/T83 need
# dist/src/session/inject-parser.js and T47 needs dist/ to exist at all. Measured
# 2026-08-16 (#899 tranche 1) after the trap cost one worker a false baseline.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
chmod +x "$HERE"/T*.sh "$HERE"/stubs/* 2>/dev/null || true

# ── the counted manifest ────────────────────────────────────────────────────────────
# Two prose sources in this repo disagreed on the guard count (96 vs 99), which is why
# this is asserted against a count of the files rather than read from a comment. Bump it
# when you add a guard; a DROP is a deleted test, and catching that is the point.
EXPECTED_GUARDS=135

# ── the expected-skip declaration ───────────────────────────────────────────────────
# Per entry, why it is here. A skip with no recorded reason is a silent skip with extra
# steps, so an entry without a justification comment is not a legitimate entry.
#
#   T16 — live-integration. Spawns a REAL telepty/cmux session through dispatch.sh,
#         polluting the live session graph, so it is gated on AIGENTRY_RUN_LIVE_TESTS=1
#         and never runs unattended.
#   T43 — bin/install-launchd.sh is launchd, i.e. macOS-only; the script is a graceful
#         no-op elsewhere and the guard declines to assert on it. Linux-only entry.
#   T47 — its codex and gemini legs sniff for those CLIs, which a clean CI runner does
#         not have. Everything else in T47 runs; only the two per-CLI legs announce a
#         skip. Capability-conditional, not OS-conditional — see the codex/gemini probe
#         below, which drops this entry on a box that has both.
#   T48 — live-integration, same gate as T16 (a real codex/gemini auth round-trip).
#   T95 — part E boots a real telepty daemon on an ephemeral port. Gated on
#         AIGENTRY_RUN_LIVE_TESTS=1 as of #900; parts A–D always run.
#   T133 — part H drives the iTerm spawn arm, which is AppleScript, i.e. macOS-only. It
#         gates on `[ -x /usr/bin/osascript ]` and announces when absent. Linux-only
#         entry, same shape as T43. Parts A–G always run, so the other ten spawn sites
#         stay measured here; what a Linux run does NOT evidence is the iTerm arm, and
#         the announcement is there so that gap is visible rather than assumed covered.
#         NOT modelled as a capability like T47: osascript ships with macOS, so there is
#         no dev box where the OS-keyed form goes stale and mutes the signal.
EXPECTED_SKIPS_DARWIN="T16 T47 T48 T95"
EXPECTED_SKIPS_LINUX="T16 T43 T47 T48 T95 T133"

# The three live-gated entries are exactly the ones that stop skipping when a maintainer
# opts in, so the declaration follows the opt-in rather than going stale against it.
LIVE_GATED="T16 T48 T95"

case "$(uname -s)" in
  Darwin) OSKEY=darwin; expected="$EXPECTED_SKIPS_DARWIN" ;;
  *)      OSKEY=linux;  expected="$EXPECTED_SKIPS_LINUX" ;;
esac
if [ "${AIGENTRY_RUN_LIVE_TESTS:-0}" = "1" ]; then
  for g in $LIVE_GATED; do
    expected=$(printf '%s\n' $expected | { grep -vx "$g" || true; } | tr '\n' ' ')
  done
fi
# T47 is the one entry whose skip is a CAPABILITY, not an OS: its two per-CLI legs skip
# when codex/gemini are absent, which is every clean runner and no developer box that
# actually dispatches to those CLIs. Modelling that here is the difference between an
# assertion maintainers trust and one they learn to ignore — measured: on a box with both
# CLIs installed, a flat per-OS declaration reports a mismatch on every single run, which
# is precisely how a real signal gets muted. Both present => T47 runs both legs and is
# expected NOT to skip; either absent => it announces and stays declared.
# #1113: `agy` counts as the gemini capability. #1083 made it the binary the gemini
# kind actually launches (geminiBinary() prefers it when present), and T47's gemini leg
# follows the same rule — so a box with agy but no `gemini` runs the leg, and declaring
# a skip for it would be the stale declaration this block exists to avoid.
if command -v codex >/dev/null 2>&1 \
   && { command -v gemini >/dev/null 2>&1 || command -v agy >/dev/null 2>&1; }; then
  expected=$(printf '%s\n' $expected | { grep -vx T47 || true; } | tr '\n' ' ')
fi

# A guard announces a skip by printing, at the start of a line, its own id followed by
# the word SKIP: "T43 SKIP (non-Darwin)", "T95: SKIP part E — ...", "T47 codex SKIP —
# ...". Anchoring on the id is what keeps an assertion string like
# "OBSERVATION_POLL_SKIP sid=..." in a guard's own output from counting as a skip.
SKIP_RE='^T[0-9]+[: ].*SKIP'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── the production-transport tripwire ───────────────────────────────────────────────
# MEASURED, not anticipated. tests/dispatch/T137 resolved the REAL telepty and sent four
# genuine duplicate-bridge HOLDs to the LIVE orchestrator session, naming fixture pids
# that do not exist; a human spent an investigation on a phantom before it was traced
# back to a stub table. The mechanism deserves recording: the guard written to prove the
# `/opt/homebrew/bin` PATH prefix is dangerous reached production THROUGH that prefix —
# it unset TELEPTY to prove a shim can still find `node` under launchd, and the shim
# duly resolved a real `telepty` off the appended homebrew path.
#
# lib.sh's t_setup already exports a stub TELEPTY and puts $STUB_BIN first on PATH, so
# the default posture is safe. This closes the residual shape: a guard that drops
# TELEPTY but keeps the inherited PATH now finds a tripwire rather than the real CLI.
#
# WHAT THIS DOES NOT CATCH, stated so it is not mistaken for a seal: a guard that
# REPLACES PATH wholesale (`PATH=/usr/bin:/bin`) escapes it, because the shims append
# /opt/homebrew/bin themselves and nothing here can shadow that. That is exactly the
# T137 shape, and it is why T137 also drives a FIXTURE sid — a guard that cannot
# address `orchestrator` cannot disturb it even when it does resolve a real binary.
# Treat the fixture-sid convention as the primary defence and this as the backstop.
#
# Only when live tests are OFF: with AIGENTRY_RUN_LIVE_TESTS=1 the three declared
# live-integration guards (T16, T48, T95) legitimately need the real CLI.
if [ "${AIGENTRY_RUN_LIVE_TESTS:-0}" != "1" ]; then
  TRIPWIRE_BIN="$TMP/tripwire-bin"; mkdir -p "$TRIPWIRE_BIN"
  cat > "$TRIPWIRE_BIN/telepty" <<'TRIP'
#!/usr/bin/env bash
echo "SUITE TRIPWIRE: a guard resolved a REAL telepty by PATH lookup. Guards must use the stub that lib.sh's t_setup exports, or a recorder of their own — a guard that can reach the live daemon can inject into the operator's session. argv: $*" >&2
exit 97
TRIP
  chmod +x "$TRIPWIRE_BIN/telepty"
  export PATH="$TRIPWIRE_BIN:$PATH"
fi

# ── the per-guard wall clock (#1113) ────────────────────────────────────────────────
# Before this the loop ran each guard bare, so a guard that never returns stalled the
# WHOLE suite instead of failing one entry. Measured: T47 sat for six minutes (180 s x
# two legs) waiting on a session registration its own fixture can never satisfy, and an
# operator killed the run by hand rather than reading a failure. A stall is indis-
# tinguishable from slow work, which is how it survives; a limit makes it a verdict.
#
# There is no single portable timeout: `timeout` is GNU coreutils and is NOT on macOS
# (measured on this box — neither `timeout` nor homebrew's `gtimeout` was present), and
# perl's alarm is the floor that survives both, because alarm(2) is preserved across
# exec and SIGALRM's default disposition is to terminate. If a box has none of the
# three the loop runs bare, exactly as before — a missing wrapper must not fail a run.
# Ceiling, stated: all three kill the guard's own shell, not its process group, so a
# subprocess it left running is orphaned rather than reaped. That is enough to turn a
# stall into a verdict, which is what this is for; reaping needs a process group.
GUARD_TIMEOUT_S=${AIGENTRY_GUARD_TIMEOUT_S:-300}
if command -v timeout >/dev/null 2>&1; then
  guard_run() { timeout -s KILL "$GUARD_TIMEOUT_S" bash "$1"; }
elif command -v gtimeout >/dev/null 2>&1; then
  guard_run() { gtimeout -s KILL "$GUARD_TIMEOUT_S" bash "$1"; }
elif command -v perl >/dev/null 2>&1; then
  guard_run() { perl -e 'alarm shift; exec @ARGV' "$GUARD_TIMEOUT_S" bash "$1"; }
else
  guard_run() { bash "$1"; }
fi

guards=0; pass=0; fail=0; skipped_guards=0; announcements=0
failed=""; skipped=""

for t in "$HERE"/T*.sh; do
  name=$(basename "$t")
  id=${name%%_*}
  guards=$((guards + 1))
  out="$TMP/$name.out"
  if guard_run "$t" > "$out" 2>&1; then rc=0; else rc=$?; fi
  cat "$out"
  # 124 = timeout(1), 137 = its -s KILL, 142 = perl's SIGALRM. Named, because a bare
  # "failed: T47" after five silent minutes reads as a flake rather than a hang.
  case "$rc" in
    124|137|142) echo "TIMEOUT: $name exceeded ${GUARD_TIMEOUT_S}s (rc=$rc) — counted as a failure, not a stall." >&2 ;;
  esac
  if [ "$rc" = "0" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); failed="$failed $name"; fi
  n=$(grep -cE "$SKIP_RE" "$out" || true)
  if [ "$n" -gt 0 ]; then
    skipped_guards=$((skipped_guards + 1))
    announcements=$((announcements + n))
    skipped="$skipped $id"
  fi
done

echo "----"
echo "guards: $guards  passed: $pass  failed: $fail  skipped: $skipped_guards ($announcements announcement(s))"
echo "skipped guards:${skipped:- none}"

rc=0

if [ "$guards" != "$EXPECTED_GUARDS" ]; then
  echo "MANIFEST MISMATCH: found $guards guard file(s), the manifest declares $EXPECTED_GUARDS." >&2
  echo "  A drop means a guard was deleted or renamed out of the T*.sh glob. A rise means a" >&2
  echo "  new guard landed without bumping EXPECTED_GUARDS in this file." >&2
  rc=1
fi

got=$(printf '%s\n' $skipped | { grep -v '^$' || true; } | sort -u | tr '\n' ' ' | sed 's/ $//')
want=$(printf '%s\n' $expected | { grep -v '^$' || true; } | sort -u | tr '\n' ' ' | sed 's/ $//')
if [ "$got" != "$want" ]; then
  echo "SKIP-SET MISMATCH on $OSKEY:" >&2
  echo "  declared: ${want:-none}" >&2
  echo "  measured: ${got:-none}" >&2
  echo "  A guard in 'measured' but not 'declared' started skipping and is now measuring" >&2
  echo "  nothing — that is the defect this assertion exists to catch. The reverse means the" >&2
  echo "  declaration above is stale. Either way, fix the guard or fix the declaration with a" >&2
  echo "  justification; do not widen the set to make this green." >&2
  rc=1
fi

if [ "$fail" != "0" ]; then echo "failed:$failed" >&2; rc=1; fi
exit "$rc"
