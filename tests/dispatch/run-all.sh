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
EXPECTED_GUARDS=118

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
EXPECTED_SKIPS_DARWIN="T16 T47 T48 T95"
EXPECTED_SKIPS_LINUX="T16 T43 T47 T48 T95"

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
if command -v codex >/dev/null 2>&1 && command -v gemini >/dev/null 2>&1; then
  expected=$(printf '%s\n' $expected | { grep -vx T47 || true; } | tr '\n' ' ')
fi

# A guard announces a skip by printing, at the start of a line, its own id followed by
# the word SKIP: "T43 SKIP (non-Darwin)", "T95: SKIP part E — ...", "T47 codex SKIP —
# ...". Anchoring on the id is what keeps an assertion string like
# "OBSERVATION_POLL_SKIP sid=..." in a guard's own output from counting as a skip.
SKIP_RE='^T[0-9]+[: ].*SKIP'

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

guards=0; pass=0; fail=0; skipped_guards=0; announcements=0
failed=""; skipped=""

for t in "$HERE"/T*.sh; do
  name=$(basename "$t")
  id=${name%%_*}
  guards=$((guards + 1))
  out="$TMP/$name.out"
  if bash "$t" > "$out" 2>&1; then rc=0; else rc=$?; fi
  cat "$out"
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
