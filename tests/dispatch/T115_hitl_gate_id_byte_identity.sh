#!/usr/bin/env bash
# T115 (#899 tranche 2d) — the gate id is byte-identical across the two hashers.
#
# ADR 2026-07-26-hitl-gate-primitive, Amendment invariant 3:
#
#   id = <kind>-<source>-<dedupe_key>,  dedupe_key = sha256("<source>|<kind>|<question>")[0:12]
#
# This is the ONE line in the port where a mistake is silent. The id is the filename,
# and the filename is the whole idempotency mechanism: a level-triggered producer
# calling `open` every 60 seconds is a no-op only because it recomputes the same name.
# If node's hash disagreed with the python one by a single byte — a different
# encoding for the seed, a different truncation, uppercase hex — then every gate
# written before the port would stop resolving: `open` would mint a SECOND gate for a
# question a human is already looking at, `approve <id>` on the old id would answer
# "no pending gate", and the duplicate would re-notify on every tick. Nothing would
# throw. The reconciler would keep ticking. That is why this fixture exists as its own
# guard rather than as a line inside T61.
#
# Three legs, over the same fixtures:
#   (A) the ORIGINAL python3 heredoc (hitl.sh:150-154 at 0d19814, reproduced verbatim
#       below — it is the reference, so it is quoted, not imported)
#   (B) node's crypto.createHash("sha256"), the port's hasher
#   (C) the real `bin/hitl.sh open` end to end, which is what actually names the file
#
# Fixtures deliberately include what a real question carries: non-ASCII (the ADR and
# the HOLD injects are written in Korean and English), an em-dash, quotes, shell
# metacharacters, and a `|` INSIDE the question — the same byte the seed uses as its
# separator, so a hasher that "helpfully" escaped or split on it would be caught.
#
# Hermetic: HITL_STATE_DIR is a temp dir, telepty is lib.sh's recorder stub, the
# registry is never reached (no --subject-sid), and no sid is named at all.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

HITL="${HITL_SH_UNDER_TEST:-$REPO_ROOT/bin/hitl.sh}"
export HITL_STATE_DIR="$T_TMP/hitl"

fail() { echo "FAIL[T115]: $*" >&2; exit 1; }

# (A) hitl.sh:150-154 at 0d19814, verbatim. The reference implementation of the id.
py_key() {
  SOURCE="$1" KIND="$2" QUESTION="$3" python3 - <<'PY'
import hashlib, os
seed = "%s|%s|%s" % (os.environ["SOURCE"], os.environ["KIND"], os.environ["QUESTION"])
print(hashlib.sha256(seed.encode("utf-8")).hexdigest()[:12])
PY
}

# (B) the port's hasher, reached the same way the port reaches it.
node_key() {
  SOURCE="$1" KIND="$2" QUESTION="$3" node -e '
const crypto = require("node:crypto");
const seed = `${process.env.SOURCE}|${process.env.KIND}|${process.env.QUESTION}`;
console.log(crypto.createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 12));
'
}

# source|kind|question — sources are legal filename components ([A-Za-z0-9._-]+), as
# `open` requires, so every fixture is reachable through leg (C) too.
FIXTURES=(
  "reconciler|decision|re-dispatch cap reached (count=1) for sid-A"
  "operator|destructive|push feat/899-t2d-hitl-ts to origin?"
  "a740h-hitl-adr|decision|Phase A ADR complete — land as-is or amend scope?"
  "worker.sid_1|decision|스펙 갭: 인터페이스 경계가 모호합니다 — 어느 쪽?"
  "sid-A|info|quotes \"double\" and 'single' and a backslash \\ inside"
  "sid-B|decision|a pipe | inside the question, the same byte the seed separates on"
  "sid-C|destructive|meta \$HOME \`whoami\` \${X} *glob* ~tilde"
  "z|info|x"
)

for fixture in "${FIXTURES[@]}"; do
  source_="${fixture%%|*}"
  rest="${fixture#*|}"
  kind="${rest%%|*}"
  question="${rest#*|}"

  a=$(py_key "$source_" "$kind" "$question")
  b=$(node_key "$source_" "$kind" "$question")
  if [ "$a" != "$b" ]; then
    fail "dedupe_key disagrees for source='$source_' kind='$kind' question='$question': python3=$a node=$b"
  fi
  # Lowercase hex, exactly 12 characters — the ADR's own words, and what T61's
  # gate-id shape regex depends on.
  printf '%s' "$a" | grep -Eq '^[0-9a-f]{12}$' \
    || fail "dedupe_key '$a' is not 12 lowercase hex characters"

  # (C) end to end: the CLI must name the FILE with exactly that id.
  got=$(RECONCILER_NOW="2026-08-16T04:00:00Z" "$HITL" open \
    --source "$source_" --kind "$kind" --question "$question")
  want="$kind-$source_-$a"
  [ "$got" = "$want" ] || fail "open printed id '$got', want '$want'"
  [ -f "$HITL_STATE_DIR/pending/$want.json" ] \
    || fail "open did not write pending/$want.json (ls: $(ls "$HITL_STATE_DIR/pending"))"
  # …and the record carries the same key, so a reader that recomputes agrees with a
  # reader that parses.
  in_record=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["dedupe_key"])' \
    "$HITL_STATE_DIR/pending/$want.json")
  [ "$in_record" = "$a" ] || fail "record dedupe_key='$in_record', want '$a'"
done

# The seam the id protects: same seed ⇒ same file, so a second open is a no-op. (T61
# pins this for one fixture and also counts the injects; here it is asserted across
# the whole fixture set, which is what makes the hash agreement load-bearing rather
# than incidental.)
before=$(find "$HITL_STATE_DIR/pending" -name '*.json' | wc -l | tr -d ' ')
[ "$before" = "${#FIXTURES[@]}" ] \
  || fail "expected ${#FIXTURES[@]} gate files, found $before"
for fixture in "${FIXTURES[@]}"; do
  source_="${fixture%%|*}"; rest="${fixture#*|}"; kind="${rest%%|*}"; question="${rest#*|}"
  RECONCILER_NOW="2026-08-16T05:00:00Z" "$HITL" open \
    --source "$source_" --kind "$kind" --question "$question" >/dev/null
done
after=$(find "$HITL_STATE_DIR/pending" -name '*.json' | wc -l | tr -d ' ')
[ "$after" = "$before" ] || fail "re-opening every fixture created duplicates: $before → $after"

# A single-byte change anywhere in the seed must change the id — otherwise "same
# question" and "different question" would collide and a human would be shown the
# wrong gate. Guards the truncation, which is the only lossy step.
k1=$(node_key "reconciler" "decision" "re-dispatch cap reached (count=1) for sid-A")
k2=$(node_key "reconciler" "decision" "re-dispatch cap reached (count=2) for sid-A")
k3=$(node_key "reconciler" "info"     "re-dispatch cap reached (count=1) for sid-A")
k4=$(node_key "tracker"    "decision" "re-dispatch cap reached (count=1) for sid-A")
[ "$k1" != "$k2" ] && [ "$k1" != "$k3" ] && [ "$k1" != "$k4" ] \
  || fail "the dedupe_key is not sensitive to all three seed components: $k1 $k2 $k3 $k4"

echo "T115 PASS"
